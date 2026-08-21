use crate::layout::{self, LaneSeed, TAG_COLOR};
use crate::models::*;
use git2::{BranchType, Oid, Repository, Sort};
use std::collections::{HashMap, HashSet};

pub struct GitReader {
    repo: Repository,
}

/// Open-view result: the view plus the session info the caller needs for
/// pagination — the seeds that produced it and the stale branches (tips
/// outside the walked window).
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
        const MAX_PATCH_BYTES: usize = 200 * 1024;

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

        let mut patch = git2::Patch::from_diff(&diff, idx)
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
