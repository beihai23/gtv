use crate::layout::{self, LaneSeed, TAG_COLOR};
use crate::models::*;
use git2::{BranchType, Oid, Repository, Sort};
use std::collections::{HashMap, HashSet};

pub struct GitReader {
    repo: Repository,
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

    /// Shared pipeline: walk from the given seed tips, then lay out.
    fn build_view(&self, seeds: &[LaneSeed], limit: usize) -> Result<GitData, String> {
        let refs_map = self.get_all_references()?;
        let main_branch = self.detect_main_branch(seeds);
        let head_id = self.head_oid();

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

        for (i, oid_result) in revwalk.enumerate() {
            if i >= limit {
                break;
            }
            let oid = oid_result.map_err(|e| format!("Failed to get oid: {}", e))?;
            let oid_str = oid.to_string();
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

        let (branches, edges, time_gaps) =
            layout::compute_layout(&mut commits, seeds, &main_branch, head_id.as_deref());

        // Diff volume for key commits only (bounded): feeds node sizing.
        let mut stats_done = 0usize;
        for c in commits.iter_mut() {
            if !c.is_key || stats_done >= 150 {
                continue;
            }
            if let Ok((a, d)) = self.diff_stats(&c.id) {
                c.additions = a;
                c.deletions = d;
                stats_done += 1;
            }
        }

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
        })
    }

    pub fn read_git_data(&mut self, limit: usize) -> Result<GitData, String> {
        let seeds = self.collect_lane_seeds()?;
        self.build_view(&seeds, limit)
    }

    pub fn read_git_data_from_branch(
        &mut self,
        branch_name: &str,
        limit: usize,
    ) -> Result<GitData, String> {
        let seeds = self.collect_lane_seeds()?;
        let seed = seeds
            .iter()
            .find(|s| s.name == branch_name)
            .cloned()
            .ok_or_else(|| format!("Branch not found: {}", branch_name))?;
        self.build_view(&[seed], limit)
    }

    /// Keep the complete lineage of the selected branches: walk from each
    /// selected tip and take the union, instead of keeping only commits the
    /// refs point at directly.
    pub fn filter_by_branches(&mut self, branch_names: &[String]) -> Result<GitData, String> {
        let all_seeds = self.collect_lane_seeds()?;
        let selected: Vec<LaneSeed> = all_seeds
            .into_iter()
            .filter(|s| branch_names.iter().any(|n| n == &s.name))
            .collect();
        self.build_view(&selected, 2000)
    }

    /// Branch/tag list for the header filter chips. Colors come from the
    /// same layout run as the timeline so chips and lanes always match.
    pub fn get_branch_list(&self) -> Result<Vec<BranchLane>, String> {
        let seeds = self.collect_lane_seeds()?;
        let data = self.build_view(&seeds, 2000)?;

        let lane_color_of: HashMap<String, String> = data
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
