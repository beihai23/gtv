use crate::layout::{self, LaneSeed, TAG_COLOR};
use crate::models::*;
use git2::build::CheckoutBuilder;
use git2::{BranchType, Oid, Repository, Sort, Status, StatusOptions};
use std::collections::{HashMap, HashSet};

pub struct GitReader {
    repo: Repository,
}

/// Open-view result: the view plus the session info the caller needs for
/// pagination — the seeds that produced it and the stale branches (tips
/// outside the walked window).
#[derive(Debug)]
pub struct ViewResult {
    pub data: GitData,
    pub seeds: Vec<LaneSeed>,
    /// Seed names whose tip is not in the walked window.
    pub stale_names: Vec<String>,
}

impl GitReader {
    pub fn new(path: &str) -> Result<Self, String> {
        let repo =
            Repository::open(path).map_err(|e| format!("Failed to open repository: {}", e))?;
        Ok(Self { repo })
    }

    /// oid -> refs (branches + tags) pointing at it, for node badges.
    fn get_all_references(&self) -> Result<HashMap<String, Vec<BranchRef>>, String> {
        let mut refs_map: HashMap<String, Vec<BranchRef>> = HashMap::new();

        let references = self
            .repo
            .references()
            .map_err(|e| format!("Failed to get references: {}", e))?;

        for reference in references {
            let reference = reference.map_err(|e| format!("Failed to get reference: {}", e))?;

            let name = match reference.name() {
                Some(n) => n.to_string(),
                None => continue,
            };

            let target = match reference.target() {
                Some(t) => t,
                None => continue,
            };

            let is_tag = name.starts_with("refs/tags/");
            let is_remote = name.starts_with("refs/remotes/");

            let branch_name = name
                .strip_prefix("refs/heads/")
                .or_else(|| name.strip_prefix("refs/tags/"))
                .or_else(|| name.strip_prefix("refs/remotes/"))
                .unwrap_or(&name)
                .to_string();

            refs_map
                .entry(target.to_string())
                .or_default()
                .push(BranchRef {
                    name: branch_name,
                    is_remote,
                    is_tag,
                    color: String::new(),
                });
        }

        Ok(refs_map)
    }

    /// Lane seeds: all local branches, plus remote branches whose short name
    /// has no local counterpart (e.g. a fresh clone where features exist
    /// only as origin/X). Lane name = short branch name.
    fn collect_lane_seeds(&self) -> Result<Vec<LaneSeed>, String> {
        let mut seeds: Vec<LaneSeed> = Vec::new();
        let mut local_names: HashSet<String> = HashSet::new();

        for branch_result in self
            .repo
            .branches(Some(BranchType::Local))
            .map_err(|e| format!("Failed to get branches: {}", e))?
        {
            if let Ok((branch, _)) = branch_result {
                if let (Some(name), Some(target)) =
                    (branch.name().ok().flatten(), branch.get().target())
                {
                    local_names.insert(name.to_string());
                    seeds.push(LaneSeed {
                        name: name.to_string(),
                        tip: target.to_string(),
                    });
                }
            }
        }

        for branch_result in self
            .repo
            .branches(Some(BranchType::Remote))
            .map_err(|e| format!("Failed to get remote branches: {}", e))?
        {
            if let Ok((branch, _)) = branch_result {
                if let (Some(full), Some(target)) =
                    (branch.name().ok().flatten(), branch.get().target())
                {
                    // "origin/MoveMethod" -> "MoveMethod"; skip origin/HEAD symref.
                    let short = full
                        .split_once('/')
                        .map(|(_, s)| s)
                        .unwrap_or(full);
                    if short == "HEAD" || local_names.contains(short) {
                        continue;
                    }
                    seeds.push(LaneSeed {
                        name: short.to_string(),
                        tip: target.to_string(),
                    });
                }
            }
        }

        Ok(seeds)
    }

    fn detect_main_branch(&self, seeds: &[LaneSeed]) -> String {
        let names: HashSet<&str> = seeds.iter().map(|s| s.name.as_str()).collect();
        if names.contains("main") {
            "main".to_string()
        } else if names.contains("master") {
            "master".to_string()
        } else {
            seeds.first().map(|s| s.name.clone()).unwrap_or_default()
        }
    }

    fn head_oid(&self) -> Option<String> {
        self.repo.head().ok()?.target().map(|t| t.to_string())
    }

    /// Shorthand of the branch HEAD sits on, or None while detached (or on
    /// an unborn HEAD). head() resolves the symbolic ref to refs/heads/<b>
    /// when on a branch; detached, it returns a direct ref named HEAD, so
    /// is_branch() is the discriminator.
    fn head_branch(&self) -> Option<String> {
        let head = self.repo.head().ok()?;
        if !head.is_branch() {
            return None;
        }
        head.shorthand().map(|s| s.to_string())
    }

    /// Cheap change detector for the repo-watcher poller (watcher.rs):
    /// HEAD (symbolic name + oid) plus the sorted list of every ref
    /// (`name=oid`). Covers commit, amend, checkout (branch and detached),
    /// branch/tag create+delete, fetch, push, stash, reset. Working-tree-only
    /// changes deliberately do NOT alter it — the timeline renders committed
    /// history only, so `git add` correctly triggers nothing. libgit2 merges
    /// loose + packed refs during enumeration, so no mtime sniffing is
    /// needed.
    pub fn change_fingerprint(&self) -> Result<String, String> {
        let head = match self.repo.head() {
            Ok(reference) => format!(
                "{}={}",
                reference.name().unwrap_or("HEAD"),
                reference
                    .target()
                    .map(|t| t.to_string())
                    .unwrap_or_default()
            ),
            // Fresh `git init` before the first commit: still watchable.
            Err(_) => "unborn".to_string(),
        };
        let mut refs: Vec<String> = self
            .repo
            .references()
            .map_err(|e| format!("Failed to get references: {}", e))?
            .filter_map(|reference| reference.ok())
            .filter_map(|reference| {
                Some(format!(
                    "{}={}",
                    reference.name()?,
                    reference.target()?
                ))
            })
            .collect();
        refs.sort();
        Ok(format!("{}|{}", head, refs.join(";")))
    }

    /// Canonical (symlink-resolved) absolute form of this repository's
    /// working directory. open_repository compares these to dedupe
    /// spellings of the same directory (alias, symlink) into one session.
    /// Bare repos (never openable here in practice) fall back to the
    /// gitdir itself.
    pub fn canonical_path(&self) -> Result<String, String> {
        let dir = self.repo.workdir().unwrap_or_else(|| self.repo.path());
        std::fs::canonicalize(dir)
            .map_err(|e| format!("Failed to canonicalize repository path: {}", e))
            .map(|p| p.to_string_lossy().into_owned())
    }

    /// Canonical common directory of the worktree family (`<main>/.git`).
    /// The main repository and every linked worktree report the same
    /// value, so it is the family key the frontend groups sub-tabs by.
    pub fn commondir(&self) -> Result<String, String> {
        std::fs::canonicalize(self.repo.commondir())
            .map_err(|e| format!("Failed to canonicalize common dir: {}", e))
            .map(|p| p.to_string_lossy().into_owned())
    }

    /// The worktree family this repository belongs to: the main repository
    /// (is_main) plus every linked worktree registered under the common
    /// dir. Enumerated through the common dir, so opening any member
    /// yields the same family. Members whose path is gone or that fail
    /// libgit2's worktree validation (stale registration, removed
    /// directory) are skipped with a warning instead of failing the open.
    /// Sorted main-first, then by name, for a stable presentation.
    pub fn worktree_family(&self) -> Result<Vec<WorktreeMember>, String> {
        let mut family: Vec<WorktreeMember> = Vec::new();

        // The main member is derived from the common dir, NOT from
        // workdir(): opening a linked worktree must still report the MAIN
        // repository as the family head. The parent of a canonical path is
        // itself canonical.
        let common = std::fs::canonicalize(self.repo.commondir())
            .map_err(|e| format!("Failed to canonicalize common dir: {}", e))?;
        if let Some(main_dir) = common.parent() {
            let main_path = std::fs::canonicalize(main_dir)
                .map_err(|e| format!("Failed to canonicalize main worktree: {}", e))?;
            let name = main_path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            family.push(WorktreeMember {
                name,
                path: main_path.to_string_lossy().into_owned(),
                is_main: true,
            });
        }

        let names = self
            .repo
            .worktrees()
            .map_err(|e| format!("Failed to enumerate worktrees: {}", e))?;
        for name in names.iter().flatten() {
            let worktree = match self.repo.find_worktree(name) {
                Ok(worktree) => worktree,
                Err(e) => {
                    log::warn!("Worktree {} not found ({}); skipping", name, e);
                    continue;
                }
            };
            // validate() checks the registered path still exists with the
            // metadata libgit2 expects; a worktree removed elsewhere is a
            // skip, not an open failure.
            if let Err(e) = worktree.validate() {
                log::warn!("Worktree {} failed validation ({}); skipping", name, e);
                continue;
            }
            let path = match std::fs::canonicalize(worktree.path()) {
                Ok(path) => path,
                Err(e) => {
                    log::warn!(
                        "Worktree {} path {} failed to canonicalize ({}); skipping",
                        name,
                        worktree.path().display(),
                        e
                    );
                    continue;
                }
            };
            family.push(WorktreeMember {
                name: name.to_string(),
                path: path.to_string_lossy().into_owned(),
                is_main: false,
            });
        }

        // false sorts before true, so comparing b.is_main against a.is_main
        // puts the main repo first.
        family.sort_by(|a, b| b.is_main.cmp(&a.is_main).then_with(|| a.name.cmp(&b.name)));
        Ok(family)
    }

    /// Preflight snapshot for the checkout confirm dialog (spec 4.1):
    /// uncommitted-change counts plus whether a merge, cherry-pick, or
    /// revert is in progress. Bucketed by git-status-porcelain semantics:
    /// an entry whose only flag is WT_NEW is untracked (untracked files
    /// carry no other flag); every other entry -- staged or unstaged
    /// edits, deletions, renames, typechanges -- is a change vs HEAD and
    /// counts as modified.
    pub fn worktree_status(&self) -> Result<WorktreeStatus, String> {
        // INCLUDE_UNTRACKED is opt-in in libgit2; without it WT_NEW never
        // appears and the untracked count would always be 0. The other
        // defaults match `git status --porcelain` (index+workdir, ignored
        // files excluded, untracked dirs reported as a single entry).
        let mut options = StatusOptions::new();
        options.include_untracked(true);
        let statuses = self
            .repo
            .statuses(Some(&mut options))
            .map_err(|e| format!("Failed to read worktree status: {}", e))?;

        let mut modified = 0;
        let mut untracked = 0;
        for entry in statuses.iter() {
            // One status entry per path, so if/else counts each dirty path
            // exactly once even when it carries both INDEX_* and WT_*
            // flags (staged, then edited again).
            if entry.status() == Status::WT_NEW {
                untracked += 1;
            } else {
                modified += 1;
            }
        }

        // Unfinished merge, cherry-pick, or revert state lives in these
        // pseudo-refs; any of them means checkout must refuse, so the
        // dialog can say why up front instead of the checkout failing
        // later.
        let merge_in_progress = self.repo.find_reference("MERGE_HEAD").is_ok()
            || self.repo.find_reference("CHERRY_PICK_HEAD").is_ok()
            || self.repo.find_reference("REVERT_HEAD").is_ok();

        Ok(WorktreeStatus {
            modified,
            untracked,
            merge_in_progress,
        })
    }

    /// SAFE checkout of a local branch -- the app's ONLY write path to a
    /// repository. The order is tree-first, head-second: the target tip's
    /// tree is checked out with the SAFE strategy (compatible uncommitted
    /// changes carry over; anything a plain `git checkout` would refuse to
    /// overwrite fails the call BEFORE anything is written), and only then
    /// does HEAD move, so a refused checkout leaves HEAD untouched. There
    /// is deliberately no force option and no way around a merge,
    /// cherry-pick, or revert in progress. Tags and remote-tracking names
    /// (origin/x) do not resolve as local branches and are rejected.
    ///
    /// Returns an ack only, never GitData: rebuilding the view is the
    /// watcher repo-changed chain's job, so two rebuilds can never race.
    pub fn checkout_branch(&self, name: &str) -> Result<CheckoutAck, String> {
        if self.repo.find_reference("MERGE_HEAD").is_ok()
            || self.repo.find_reference("CHERRY_PICK_HEAD").is_ok()
            || self.repo.find_reference("REVERT_HEAD").is_ok()
        {
            return Err("merge, cherry-pick, or revert in progress".to_string());
        }

        let branch = self
            .repo
            .find_branch(name, BranchType::Local)
            .map_err(|_| format!("Branch not found: {}", name))?;
        let tip = branch
            .get()
            .target()
            .ok_or_else(|| format!("Branch has no target: {}", name))?;
        let tree = self
            .repo
            .find_commit(tip)
            .and_then(|commit| commit.tree())
            .map_err(|e| format!("Failed to resolve branch tip: {}", e))?;

        // SAFE is libgit2's default; select it explicitly because the
        // no-force guarantee is this command's whole safety contract.
        let mut checkout = CheckoutBuilder::new();
        checkout.safe();
        self.repo
            .checkout_tree(tree.as_object(), Some(&mut checkout))
            .map_err(|e| format!("Checkout failed: {}", e))?;
        self.repo
            .set_head(&format!("refs/heads/{}", name))
            .map_err(|e| {
                format!(
                    "Worktree moved to {} but HEAD could not follow: {} \
                     (run `git checkout {}` to finish)",
                    name, e, name
                )
            })?;

        log::info!("Checked out branch {}", name);
        Ok(CheckoutAck {
            branch: name.to_string(),
        })
    }

    /// Walk commits from the given seed tips (TIME|TOPO, newest first),
    /// skipping oids in `hide` (pagination continuation), capped at `limit`
    /// NEW commits.
    ///
    /// `hide` is applied by skipping, NOT via revwalk.hide(): hide marks an
    /// oid uninteresting, which propagates to all its ancestors and would
    /// suppress the entire older history we are trying to page in. Skipping
    /// costs a re-walk of the already-loaded prefix per chunk — accepted.
    fn walk_commits(
        &self,
        seeds: &[LaneSeed],
        hide: &HashSet<String>,
        limit: usize,
    ) -> Result<Vec<CommitNode>, String> {
        let refs_map = self.get_all_references()?;

        let mut revwalk = self
            .repo
            .revwalk()
            .map_err(|e| format!("Failed to create revwalk: {}", e))?;
        revwalk
            .set_sorting(Sort::TIME | Sort::TOPOLOGICAL)
            .map_err(|e| format!("Failed to set sorting: {}", e))?;

        let mut pushed = false;
        for seed in seeds {
            if let Ok(oid) = Oid::from_str(&seed.tip) {
                revwalk
                    .push(oid)
                    .map_err(|e| format!("Failed to push tip {}: {}", seed.name, e))?;
                pushed = true;
            }
        }
        if !pushed {
            revwalk
                .push_head()
                .map_err(|e| format!("Failed to push HEAD: {}", e))?;
        }

        let mut commits: Vec<CommitNode> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();

        for oid_result in revwalk {
            if commits.len() >= limit {
                break;
            }
            let oid = oid_result.map_err(|e| format!("Failed to get oid: {}", e))?;
            let oid_str = oid.to_string();
            if hide.contains(&oid_str) {
                continue;
            }
            if !seen.insert(oid_str.clone()) {
                continue;
            }

            let commit = self
                .repo
                .find_commit(oid)
                .map_err(|e| format!("Failed to find commit: {}", e))?;

            commits.push(CommitNode {
                id: oid_str.clone(),
                short_id: oid_str[..7].to_string(),
                message: commit.summary().unwrap_or("").to_string(),
                author_name: commit.author().name().unwrap_or("Unknown").to_string(),
                author_email: commit.author().email().unwrap_or("").to_string(),
                timestamp: commit.time().seconds(),
                parents: commit.parents().map(|p| p.id().to_string()).collect(),
                branch_refs: refs_map.get(&oid_str).cloned().unwrap_or_default(),
                fork_branch_name: None,
                merge_branch_name: None,
                lane_owner: String::new(),
                is_head: false,
                is_key: false,
                additions: 0,
                deletions: 0,
                x: 0.0,
                y: 0.0,
                lane: 0,
            });
        }

        Ok(commits)
    }

    /// Shared pipeline: walk from the given seed tips, then lay out.
    fn build_view(&self, seeds: &[LaneSeed], limit: usize) -> Result<GitData, String> {
        let main_branch = self.detect_main_branch(seeds);
        let head_id = self.head_oid();
        let head_branch = self.head_branch();
        let mut commits = self.walk_commits(seeds, &HashSet::new(), limit)?;
        // A full chunk means older history may still be out there.
        let has_more = commits.len() == limit;

        let (branches, edges, time_gaps) =
            layout::compute_layout(&mut commits, seeds, &main_branch, head_id.as_deref());

        // Diff volume (node sizing) is intentionally NOT computed here:
        // one tree diff per key commit is too expensive for the open path.
        // The frontend fetches it lazily via get_commit_stats.

        log::info!(
            "Built view: {} commits, {} lanes, {} edges",
            commits.len(),
            branches.len(),
            edges.len()
        );

        Ok(GitData {
            commits,
            edges,
            branches,
            main_branch,
            time_gaps,
            has_more,
            head_branch,
        })
    }

    /// Load the next older chunk for an already-open view: walk from the
    /// same seed tips while hiding everything already loaded, append the
    /// chunk, then re-lay-out the WHOLE set. The relayout is required, not
    /// cosmetic: lane ownership is global (a stale branch's tip claims its
    /// lineage once the window reaches it) and x coordinates cascade from
    /// the oldest commit, so prepending history shifts every coordinate.
    pub fn load_more(
        &self,
        seeds: &[LaneSeed],
        seen: &HashSet<String>,
        mut existing: Vec<CommitNode>,
        limit: usize,
    ) -> Result<GitData, String> {
        let chunk = self.walk_commits(seeds, seen, limit)?;
        let has_more = chunk.len() == limit;

        // fork_branch_name accumulates via push_str during layout; reset the
        // annotation fields before re-running layout on laid-out commits.
        for c in existing.iter_mut() {
            c.fork_branch_name = None;
            c.merge_branch_name = None;
        }
        existing.extend(chunk);

        let main_branch = self.detect_main_branch(seeds);
        let head_id = self.head_oid();
        let head_branch = self.head_branch();
        let mut commits = existing;
        let (branches, edges, time_gaps) =
            layout::compute_layout(&mut commits, seeds, &main_branch, head_id.as_deref());

        log::info!(
            "Loaded older chunk: {} commits total, has_more={}",
            commits.len(),
            has_more
        );

        Ok(GitData {
            commits,
            edges,
            branches,
            main_branch,
            time_gaps,
            has_more,
            head_branch,
        })
    }

    fn stale_seeds(seeds: &[LaneSeed], data: &GitData) -> Vec<String> {
        let ids: HashSet<&str> = data.commits.iter().map(|c| c.id.as_str()).collect();
        seeds
            .iter()
            .filter(|s| !ids.contains(s.tip.as_str()))
            .map(|s| s.name.clone())
            .collect()
    }

    /// Full-history commit search: case-insensitive substring on the commit
    /// subject or author name; a >=4-hex query also matches commit-id
    /// prefixes (inside the same walk, so ambiguous prefixes all surface).
    /// Hits come back newest-first (walk order) and stop at `limit`.
    /// `loaded` is the pagination session's oid set — membership becomes
    /// the `in_view` flag.
    pub fn search_commits(
        &self,
        query: &str,
        limit: usize,
        loaded: &HashSet<String>,
    ) -> Result<Vec<SearchHit>, String> {
        let q = query.trim().to_lowercase();
        // Empty (or whitespace-only) query: nothing can match, so skip the
        // full revwalk entirely. The frontend gates this today; future
        // callers should not pay for a whole-repo walk that yields nothing.
        if q.is_empty() {
            return Ok(Vec::new());
        }
        if limit == 0 {
            return Ok(Vec::new());
        }
        let is_hex = q.len() >= 4 && q.chars().all(|c| c.is_ascii_hexdigit());

        let seeds = self.collect_lane_seeds()?;
        let mut revwalk = self
            .repo
            .revwalk()
            .map_err(|e| format!("Failed to create revwalk: {}", e))?;
        revwalk
            .set_sorting(Sort::TIME | Sort::TOPOLOGICAL)
            .map_err(|e| format!("Failed to set sorting: {}", e))?;
        let mut pushed = false;
        for seed in &seeds {
            if let Ok(oid) = Oid::from_str(&seed.tip) {
                revwalk
                    .push(oid)
                    .map_err(|e| format!("Failed to push tip {}: {}", seed.name, e))?;
                pushed = true;
            }
        }
        if !pushed {
            revwalk
                .push_head()
                .map_err(|e| format!("Failed to push HEAD: {}", e))?;
        }

        let mut hits: Vec<SearchHit> = Vec::new();
        for oid_result in revwalk {
            if hits.len() >= limit {
                break;
            }
            let oid = oid_result.map_err(|e| format!("Failed to get oid: {}", e))?;
            let commit = self
                .repo
                .find_commit(oid)
                .map_err(|e| format!("Failed to find commit: {}", e))?;
            let summary = commit.summary().unwrap_or("").to_lowercase();
            let author = commit.author().name().unwrap_or("").to_lowercase();
            let id = oid.to_string();
            let text_match =
                (!q.is_empty() && (summary.contains(&q) || author.contains(&q)))
                    || (is_hex && id.starts_with(&q));
            if !text_match {
                continue;
            }
            hits.push(SearchHit {
                id: id.clone(),
                message: commit.summary().unwrap_or("").to_string(),
                author_name: commit.author().name().unwrap_or("Unknown").to_string(),
                timestamp: commit.time().seconds(),
                in_view: loaded.contains(&id),
            });
        }

        log::info!("Search {:?}: {} hits (limit {})", query, hits.len(), limit);
        Ok(hits)
    }

    pub fn read_git_data(&mut self, limit: usize) -> Result<ViewResult, String> {
        let seeds = self.collect_lane_seeds()?;
        let data = self.build_view(&seeds, limit)?;
        let stale_names = Self::stale_seeds(&seeds, &data);
        Ok(ViewResult {
            data,
            seeds,
            stale_names,
        })
    }

    /// View "from one commit": a single-seed window over the target's
    /// ancestry (search jumps land here). The seed claims the first lane
    /// under the commit's short hash -- there may be no branch ref pointing
    /// anywhere near it. Same shape as read_git_data_from_branch so the
    /// pagination session takes over seamlessly.
    pub fn read_git_data_from_commit(
        &mut self,
        commit_id: &str,
        limit: usize,
    ) -> Result<ViewResult, String> {
        let oid = Oid::from_str(commit_id)
            .map_err(|e| format!("Invalid commit id {}: {}", commit_id, e))?;
        // find_commit rejects non-commit objects (e.g. annotated tags).
        let commit = self
            .repo
            .find_commit(oid)
            .map_err(|e| format!("Commit not found: {}", e))?;
        let id = commit.id().to_string();
        let seeds = vec![LaneSeed {
            name: id[..7].to_string(),
            tip: id,
        }];
        let data = self.build_view(&seeds, limit)?;
        let stale_names = Self::stale_seeds(&seeds, &data);
        Ok(ViewResult {
            data,
            seeds,
            stale_names,
        })
    }

    pub fn read_git_data_from_branch(
        &mut self,
        branch_name: &str,
        limit: usize,
    ) -> Result<ViewResult, String> {
        let seeds = self.collect_lane_seeds()?;
        let seed = seeds
            .iter()
            .find(|s| s.name == branch_name)
            .cloned()
            .ok_or_else(|| format!("Branch not found: {}", branch_name))?;
        let seeds = vec![seed];
        let data = self.build_view(&seeds, limit)?;
        let stale_names = Self::stale_seeds(&seeds, &data);
        Ok(ViewResult {
            data,
            seeds,
            stale_names,
        })
    }

    /// Keep the complete lineage of the selected branches: walk from each
    /// selected tip and take the union, instead of keeping only commits the
    /// refs point at directly.
    pub fn filter_by_branches(&mut self, branch_names: &[String]) -> Result<ViewResult, String> {
        let all_seeds = self.collect_lane_seeds()?;
        let selected: Vec<LaneSeed> = all_seeds
            .into_iter()
            .filter(|s| branch_names.iter().any(|n| n == &s.name))
            .collect();
        let data = self.build_view(&selected, 2000)?;
        let stale_names = Self::stale_seeds(&selected, &data);
        Ok(ViewResult {
            data,
            seeds: selected,
            stale_names,
        })
    }

    /// Branch/tag list for the header filter chips. Lane colors are read
    /// from the already-built view instead of re-running the full
    /// walk+layout — chips and lanes always match because they come from
    /// the same layout run.
    pub fn get_branch_list(&self, view: &GitData) -> Result<Vec<BranchLane>, String> {
        let seeds = self.collect_lane_seeds()?;

        let lane_color_of: HashMap<String, String> = view
            .branches
            .iter()
            .map(|b| (b.name.clone(), b.color.clone()))
            .collect();

        let mut list: Vec<BranchLane> = Vec::new();
        for (i, seed) in seeds.iter().enumerate() {
            let color = lane_color_of
                .get(&seed.name)
                .cloned()
                .unwrap_or_else(|| layout::lane_color(i as i32));
            list.push(BranchLane {
                name: seed.name.clone(),
                lane_index: i as i32,
                color,
                is_tag: false,
                fork_point: None,
                merged_into: None,
                is_active: true,
            });
        }

        // Tags are filter chips, never lanes.
        let references = self
            .repo
            .references()
            .map_err(|e| format!("Failed to get references: {}", e))?;
        let mut tags: HashSet<String> = HashSet::new();
        for reference in references.flatten() {
            if let Some(name) = reference.name() {
                if let Some(tag) = name.strip_prefix("refs/tags/") {
                    tags.insert(tag.to_string());
                }
            }
        }
        let mut tags: Vec<String> = tags.into_iter().collect();
        tags.sort();
        for tag in tags {
            let idx = list.len() as i32;
            list.push(BranchLane {
                name: tag,
                lane_index: idx,
                color: TAG_COLOR.to_string(),
                is_tag: true,
                fork_point: None,
                merged_into: None,
                is_active: true,
            });
        }

        Ok(list)
    }

    /// Diff volume (additions, deletions) for the given commits, capped at
    /// 150. Runs on demand after the view has rendered, so the open path
    /// doesn't pay for one tree diff per key commit.
    pub fn get_commit_stats(&self, commit_ids: &[String]) -> Result<Vec<CommitStat>, String> {
        let mut stats = Vec::new();
        for id in commit_ids.iter().take(150) {
            if let Ok((a, d)) = self.diff_stats(id) {
                stats.push(CommitStat {
                    id: id.clone(),
                    additions: a,
                    deletions: d,
                });
            }
        }
        Ok(stats)
    }

    /// (additions, deletions) of a commit vs its first parent
    /// (or the empty tree for the root commit).
    fn diff_stats(&self, commit_id: &str) -> Result<(u32, u32), String> {
        let oid = Oid::from_str(commit_id).map_err(|e| e.to_string())?;
        let commit = self.repo.find_commit(oid).map_err(|e| e.to_string())?;
        let tree = commit.tree().map_err(|e| e.to_string())?;
        let parent_tree = match commit.parents().next() {
            Some(p) => Some(p.tree().map_err(|e| e.to_string())?),
            None => None,
        };
        let diff = self
            .repo
            .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
            .map_err(|e| e.to_string())?;
        let stats = diff.stats().map_err(|e| e.to_string())?;
        Ok((stats.insertions() as u32, stats.deletions() as u32))
    }

    /// Unified diff patch text for one file in a commit (vs first parent,
    /// or the empty tree for the root commit). Large patches are truncated.
    pub fn get_file_diff(&self, commit_id: &str, path: &str) -> Result<String, String> {
        let oid = Oid::from_str(commit_id).map_err(|e| format!("Invalid commit id: {}", e))?;
        let commit = self
            .repo
            .find_commit(oid)
            .map_err(|e| format!("Failed to find commit: {}", e))?;
        let commit_tree = commit
            .tree()
            .map_err(|e| format!("Failed to get commit tree: {}", e))?;
        let parent_tree = match commit.parents().next() {
            Some(parent) => Some(
                parent
                    .tree()
                    .map_err(|e| format!("Failed to get parent tree: {}", e))?,
            ),
            None => None,
        };

        let diff = self
            .repo
            .diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), None)
            .map_err(|e| format!("Failed to get diff: {}", e))?;

        self.render_file_patch(&diff, path)
    }

    /// Shared tail of the per-file patch channels -- get_file_diff's
    /// parent-vs-commit and pair_file_diff's two-tree form: locate the
    /// delta whose new path (or old path, so renames still resolve)
    /// equals `path`, render it, then apply the binary placeholder and
    /// the 200KB truncation.
    fn render_file_patch(&self, diff: &git2::Diff, path: &str) -> Result<String, String> {
        const MAX_PATCH_BYTES: usize = 200 * 1024;

        // Match against the new path (what the file list shows); fall back to
        // the old path so renames still resolve.
        let idx = (0..diff.deltas().len())
            .find(|&i| {
                let delta = diff.get_delta(i).unwrap();
                let new_match = delta
                    .new_file()
                    .path()
                    .and_then(|p| p.to_str())
                    .map(|p| p == path)
                    .unwrap_or(false);
                let old_match = delta
                    .old_file()
                    .path()
                    .and_then(|p| p.to_str())
                    .map(|p| p == path)
                    .unwrap_or(false);
                new_match || old_match
            })
            .ok_or_else(|| format!("File not found in commit diff: {}", path))?;

        let mut patch = git2::Patch::from_diff(diff, idx)
            .map_err(|e| format!("Failed to build patch: {}", e))?
            .ok_or_else(|| format!("No patch for file: {}", path))?;

        let buf = patch.to_buf().map_err(|e| format!("Failed to render patch: {}", e))?;
        let text = String::from_utf8_lossy(&buf).to_string();
        if text.is_empty() {
            return Ok("(binary file or no textual diff)".to_string());
        }
        if text.len() > MAX_PATCH_BYTES {
            let mut cut = MAX_PATCH_BYTES;
            while !text.is_char_boundary(cut) {
                cut -= 1;
            }
            return Ok(format!(
                "{}\n\n... (diff truncated at {} KB)",
                &text[..cut],
                MAX_PATCH_BYTES / 1024
            ));
        }
        Ok(text)
    }

    /// Resolve a revspec to the commit it names: full or short oid, branch
    /// name, or tag name -- a single-commit subset of `git rev-parse`
    /// (libgit2's revparse rejects range forms like `A..B` cleanly with an
    /// Err, never a panic). Both compare methods go through this, so a
    /// pair produced by compare_detail (oids) and one typed from the
    /// command line resolve identically.
    fn resolve_commit(&self, spec: &str) -> Result<git2::Commit<'_>, String> {
        let object = self
            .repo
            .revparse_single(spec)
            .map_err(|e| format!("Revision not found: {} ({})", spec, e))?;
        object
            .peel_to_commit()
            .map_err(|_| format!("Not a commit: {}", spec))
    }

    /// Two-commit compare (base -> target), read-only: the two-tree diff's
    /// file list with REAL per-file additions/deletions -- one
    /// Patch::from_diff per delta, the per-file pass get_commit_detail
    /// deliberately skips (its per-file numbers stay 0) -- plus the
    /// running totals (sum of the per-file numbers) and both-side
    /// summaries for the compare header. An empty diff (same oid twice)
    /// is honestly reported as zero files, zero totals.
    pub fn compare_detail(&self, base_oid: &str, target_oid: &str) -> Result<CompareDetail, String> {
        let base = self.resolve_commit(base_oid)?;
        let target = self.resolve_commit(target_oid)?;
        let base_tree = base
            .tree()
            .map_err(|e| format!("Failed to get tree of {}: {}", base_oid, e))?;
        let target_tree = target
            .tree()
            .map_err(|e| format!("Failed to get tree of {}: {}", target_oid, e))?;

        let diff = self
            .repo
            .diff_tree_to_tree(Some(&base_tree), Some(&target_tree), None)
            .map_err(|e| format!("Failed to get diff: {}", e))?;

        let side = |commit: &git2::Commit| -> CompareSide {
            let id = commit.id().to_string();
            CompareSide {
                short_id: id[..7.min(id.len())].to_string(),
                id,
                subject: commit.summary().unwrap_or("").to_string(),
                author: commit.author().name().unwrap_or("Unknown").to_string(),
            }
        };

        let mut files = Vec::new();
        let mut total_additions = 0usize;
        let mut total_deletions = 0usize;
        for (i, delta) in diff.deltas().enumerate() {
            let path = delta
                .new_file()
                .path()
                .and_then(|p| p.to_str())
                .unwrap_or("unknown")
                .to_string();

            let status = match delta.status() {
                git2::Delta::Added => "A",
                git2::Delta::Deleted => "D",
                git2::Delta::Modified => "M",
                git2::Delta::Renamed => "R",
                _ => "?",
            }
            .to_string();

            // Per-file line counts from the file's own patch. Binary files
            // render no hunks and count as 0/0; a delta with no textual
            // patch at all (e.g. a mode-only change) likewise.
            let (additions, deletions) =
                match git2::Patch::from_diff(&diff, i)
                    .map_err(|e| format!("Failed to build patch for {}: {}", path, e))?
                {
                    Some(patch) => {
                        // line_stats() -> (context, additions, deletions).
                        let (_, additions, deletions) = patch
                            .line_stats()
                            .map_err(|e| format!("Failed to count lines in {}: {}", path, e))?;
                        (additions, deletions)
                    }
                    None => (0, 0),
                };
            total_additions += additions;
            total_deletions += deletions;

            files.push(FileChange {
                path,
                additions: additions as i32,
                deletions: deletions as i32,
                status,
            });
        }

        log::info!(
            "Compare {}..{}: {} files, +{} -{}",
            base_oid,
            target_oid,
            files.len(),
            total_additions,
            total_deletions
        );

        Ok(CompareDetail {
            base: side(&base),
            target: side(&target),
            files,
            total_additions,
            total_deletions,
        })
    }

    /// Unified diff patch text for one file between ANY two commits
    /// (base -> target) -- the two-tree generalization of get_file_diff,
    /// sharing its render tail, so the 200KB truncation, binary
    /// placeholder, and rename-aware path lookup behave identically.
    pub fn pair_file_diff(
        &self,
        base_oid: &str,
        target_oid: &str,
        path: &str,
    ) -> Result<String, String> {
        let base = self.resolve_commit(base_oid)?;
        let target = self.resolve_commit(target_oid)?;
        let base_tree = base
            .tree()
            .map_err(|e| format!("Failed to get tree of {}: {}", base_oid, e))?;
        let target_tree = target
            .tree()
            .map_err(|e| format!("Failed to get tree of {}: {}", target_oid, e))?;

        let diff = self
            .repo
            .diff_tree_to_tree(Some(&base_tree), Some(&target_tree), None)
            .map_err(|e| format!("Failed to get diff: {}", e))?;

        self.render_file_patch(&diff, path)
    }

    /// Normalized patch hash for a commit vs its first parent: file paths
    /// plus added/removed line contents, ignoring line numbers and context
    /// — the same idea as `git patch-id`. Two commits with the same hash
    /// carry the same change (cherry-pick / rebase copies). Merge commits
    /// return None: their "change" is not a portable patch.
    fn patch_hash(&self, commit_id: &str) -> Option<u64> {
        let oid = Oid::from_str(commit_id).ok()?;
        let commit = self.repo.find_commit(oid).ok()?;
        if commit.parent_count() > 1 {
            return None;
        }
        let tree = commit.tree().ok()?;
        let parent_tree = match commit.parents().next() {
            Some(p) => Some(p.tree().ok()?),
            None => None,
        };
        let diff = self
            .repo
            .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
            .ok()?;

        // FNV-1a via Cell so both callbacks can share the state.
        let state = std::cell::Cell::new(0xcbf29ce484222325u64);
        let mix = |bytes: &[u8]| {
            let mut h = state.get();
            for &b in bytes {
                h = (h ^ b as u64).wrapping_mul(0x100000001b3);
            }
            state.set(h);
        };
        let mut file_cb = |delta: git2::DiffDelta, _progress: f32| {
            if let Some(p) = delta.old_file().path() {
                mix(p.to_string_lossy().as_bytes());
            }
            mix(&[0]);
            if let Some(p) = delta.new_file().path() {
                mix(p.to_string_lossy().as_bytes());
            }
            mix(&[0xff]);
            true
        };
        let mut line_cb =
            |_delta: git2::DiffDelta, _hunk: Option<git2::DiffHunk>, line: git2::DiffLine| {
                match line.origin() {
                    '+' | '-' => {
                        mix(&[line.origin() as u8]);
                        mix(line.content());
                    }
                    _ => {}
                }
                true
            };
        diff.foreach(
            &mut file_cb,
            None,
            None,
            Some(
                &mut line_cb as &mut dyn FnMut(
                    git2::DiffDelta,
                    Option<git2::DiffHunk>,
                    git2::DiffLine,
                ) -> bool,
            ),
        )
        .ok()?;
        Some(state.get())
    }

    /// Detect copied commits inside the current view by matching normalized
    /// patch hashes. A run of ≥2 consecutive matching pairs between two
    /// lanes is classified as a rebase; anything else is a cherry-pick.
    /// Capped to the newest 4000 commits: one diff per commit, and
    /// paginated views can grow unbounded.
    pub fn get_patch_links(&self, commits: &[CommitNode]) -> Result<Vec<PatchLink>, String> {
        const PATCH_LINK_WINDOW: usize = 4000;
        let commits = if commits.len() > PATCH_LINK_WINDOW {
            log::info!(
                "Patch links: capped to newest {} of {} commits",
                PATCH_LINK_WINDOW,
                commits.len()
            );
            &commits[commits.len() - PATCH_LINK_WINDOW..]
        } else {
            commits
        };
        let mut by_hash: HashMap<u64, Vec<usize>> = HashMap::new();
        for (i, c) in commits.iter().enumerate() {
            if let Some(h) = self.patch_hash(&c.id) {
                by_hash.entry(h).or_default().push(i);
            }
        }

        // Rank of each commit within its own lane, ordered by x — used to
        // test whether matching pairs form consecutive runs.
        let mut lane_order: HashMap<&str, Vec<usize>> = HashMap::new();
        for (i, c) in commits.iter().enumerate() {
            lane_order.entry(c.lane_owner.as_str()).or_default().push(i);
        }
        let mut pos = vec![0usize; commits.len()];
        for v in lane_order.values_mut() {
            v.sort_by(|&a, &b| {
                commits[a]
                    .x
                    .partial_cmp(&commits[b].x)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            for (rank, &i) in v.iter().enumerate() {
                pos[i] = rank;
            }
        }

        let mut links: Vec<PatchLink> = Vec::new();
        // lane pair -> one-commit-per-lane match pairs (rebase candidates)
        let mut pair_runs: HashMap<(String, String), Vec<(usize, usize)>> = HashMap::new();
        // groups with >2 copies or uneven lane splits: plain cherry-picks
        let mut simple_groups: Vec<Vec<usize>> = Vec::new();

        for idxs in by_hash.values() {
            if idxs.len() < 2 {
                continue;
            }
            let lanes: HashSet<&str> = idxs
                .iter()
                .map(|&i| commits[i].lane_owner.as_str())
                .collect();
            if lanes.len() < 2 {
                continue; // same-lane duplicate: not a branch relationship
            }
            if idxs.len() == 2 {
                let (a, b) = (idxs[0], idxs[1]);
                let (la, lb) = (commits[a].lane_owner.clone(), commits[b].lane_owner.clone());
                let key = if la <= lb { (la, lb) } else { (lb, la) };
                pair_runs.entry(key).or_default().push((a, b));
            } else {
                simple_groups.push(idxs.clone());
            }
        }

        for ((_la, _lb), mut pairs) in pair_runs {
            pairs.sort_by_key(|&(a, _)| pos[a]);
            let is_rebase = pairs.len() >= 2
                && pairs
                    .windows(2)
                    .all(|w| pos[w[1].0] == pos[w[0].0] + 1 && pos[w[1].1] == pos[w[0].1] + 1);
            let kind = if is_rebase { "rebase" } else { "cherry-pick" };
            for (a, b) in pairs {
                links.push(PatchLink {
                    from: commits[a].id.clone(),
                    to: commits[b].id.clone(),
                    kind: kind.to_string(),
                });
            }
        }

        for idxs in simple_groups {
            // Link every copy to the earliest one.
            let mut sorted = idxs;
            sorted.sort_by_key(|&i| commits[i].timestamp);
            let anchor = sorted[0];
            for &i in &sorted[1..] {
                links.push(PatchLink {
                    from: commits[anchor].id.clone(),
                    to: commits[i].id.clone(),
                    kind: "cherry-pick".to_string(),
                });
            }
        }

        log::info!("Patch links: {} detected", links.len());
        Ok(links)
    }

    pub fn get_commit_detail(&self, commit_id: &str) -> Result<CommitDetail, String> {
        let oid = Oid::from_str(commit_id).map_err(|e| format!("Invalid commit id: {}", e))?;

        let commit = self
            .repo
            .find_commit(oid)
            .map_err(|e| format!("Failed to find commit: {}", e))?;

        let refs = self
            .get_all_references()?
            .get(commit_id)
            .cloned()
            .unwrap_or_default();

        let parents: Vec<String> = commit.parents().map(|p| p.id().to_string()).collect();

        let author = commit.author();
        let author_name = author.name().unwrap_or("Unknown").to_string();
        let author_email = author.email().unwrap_or("").to_string();

        let message = commit.summary().unwrap_or("").to_string();
        let full_message = commit.message().unwrap_or("").to_string();

        let commit_tree = commit
            .tree()
            .map_err(|e| format!("Failed to get commit tree: {}", e))?;

        // Root commit diffs against the empty tree.
        let parent_tree = match commit.parents().next() {
            Some(parent) => Some(
                parent
                    .tree()
                    .map_err(|e| format!("Failed to get parent tree: {}", e))?,
            ),
            None => None,
        };

        let diff = self
            .repo
            .diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), None)
            .map_err(|e| format!("Failed to get diff: {}", e))?;

        let stats = diff
            .stats()
            .map_err(|e| format!("Failed to get diff stats: {}", e))?;
        let total_insertions = stats.insertions();
        let total_deletions = stats.deletions();
        let files_changed = stats.files_changed();

        let mut files = Vec::new();
        for delta in diff.deltas() {
            let path = delta
                .new_file()
                .path()
                .and_then(|p| p.to_str())
                .unwrap_or("unknown")
                .to_string();

            let status = match delta.status() {
                git2::Delta::Added => "A",
                git2::Delta::Deleted => "D",
                git2::Delta::Modified => "M",
                git2::Delta::Renamed => "R",
                _ => "?",
            }
            .to_string();

            files.push(FileChange {
                path,
                additions: 0, // per-file line stats require per-file patches; totals below
                deletions: 0,
                status,
            });
        }

        // Distribute totals onto the commit-level detail so the UI can show
        // "+X / -Y" even before per-file stats are implemented.
        if let Some(first) = files.first_mut() {
            let _ = first; // per-file split intentionally left for P1
        }
        log::info!(
            "Commit {}: {} files, +{} -{}",
            commit_id,
            files_changed,
            total_insertions,
            total_deletions
        );

        Ok(CommitDetail {
            id: commit_id.to_string(),
            short_id: commit_id[..7.min(commit_id.len())].to_string(),
            message,
            full_message,
            author_name,
            author_email,
            timestamp: commit.time().seconds(),
            parents,
            branch_refs: refs,
            files,
            total_additions: total_insertions as i32,
            total_deletions: total_deletions as i32,
        })
    }
}
