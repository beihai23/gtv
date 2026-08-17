use crate::models::*;
use git2::{BranchType, Oid, Repository, Sort};
use std::collections::{HashMap, HashSet};

pub struct GitReader {
    repo: Repository,
    branch_colors: HashMap<String, String>,
    color_index: usize,
}

impl GitReader {
    pub fn new(path: &str) -> Result<Self, String> {
        let repo =
            Repository::open(path).map_err(|e| format!("Failed to open repository: {}", e))?;

        let mut colors = HashMap::new();
        colors.insert("main".to_string(), "#4A90D9".to_string());
        colors.insert("master".to_string(), "#4A90D9".to_string());

        Ok(Self {
            repo,
            branch_colors: colors,
            color_index: 2,
        })
    }

    fn get_branch_color(&mut self, branch_name: &str) -> String {
        let clean_name = branch_name
            .strip_prefix("refs/heads/")
            .or_else(|| branch_name.strip_prefix("refs/remotes/"))
            .unwrap_or(branch_name)
            .to_string();

        if let Some(color) = self.branch_colors.get(&clean_name) {
            return color.clone();
        }

        let colors = [
            "#E91E63", "#9C27B0", "#673AB7", "#3F51B5", "#2196F3", "#00BCD4", "#009688", "#4CAF50",
            "#8BC34A", "#FFEB3B", "#FF9800", "#FF5722", "#795548", "#607D8B", "#F44336",
        ];

        let color = colors[self.color_index % colors.len()].to_string();
        self.branch_colors.insert(clean_name, color.clone());
        self.color_index += 1;
        color
    }

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

            let ref_entry = BranchRef {
                name: branch_name,
                is_remote,
                is_tag,
                color: String::new(),
            };

            let key = target.to_string();
            refs_map.entry(key).or_insert_with(Vec::new).push(ref_entry);
        }

        Ok(refs_map)
    }

    pub fn read_git_data(&mut self, limit: usize) -> Result<GitData, String> {
        log::info!("Starting read_git_data with limit {}", limit);

        log::info!("Getting all references...");
        let refs_map = self.get_all_references()?;
        log::info!("Got {} refs", refs_map.len());

        log::info!("Creating revwalk...");
        let mut revwalk = self
            .repo
            .revwalk()
            .map_err(|e| format!("Failed to create revwalk: {}", e))?;

        revwalk
            .set_sorting(Sort::TIME | Sort::TOPOLOGICAL)
            .map_err(|e| format!("Failed to set sorting: {}", e))?;

        revwalk
            .push_head()
            .map_err(|e| format!("Failed to push HEAD: {}", e))?;

        log::info!("Getting branches...");
        let mut all_branches: HashSet<String> = HashSet::new();

        for branch_result in self
            .repo
            .branches(Some(BranchType::Local))
            .map_err(|e| format!("Failed to get branches: {}", e))?
        {
            if let Ok((branch, _)) = branch_result {
                if let Some(name) = branch.name().ok().flatten() {
                    all_branches.insert(name.to_string());
                }
            }
        }

        let main_branch = if all_branches.contains("main") {
            "main".to_string()
        } else if all_branches.contains("master") {
            "master".to_string()
        } else {
            all_branches.iter().next().cloned().unwrap_or_default()
        };

        log::info!(
            "Found {} branches, main: {}",
            all_branches.len(),
            main_branch
        );

        log::info!("Iterating commits...");
        let mut commits: Vec<CommitNode> = Vec::new();
        let mut commit_oid_set: HashSet<String> = HashSet::new();

        for (i, oid_result) in revwalk.enumerate() {
            if i >= limit {
                break;
            }

            let oid = oid_result.map_err(|e| format!("Failed to get oid: {}", e))?;

            let oid_str = oid.to_string();
            if commit_oid_set.contains(&oid_str) {
                continue;
            }
            commit_oid_set.insert(oid_str.clone());

            let commit = self
                .repo
                .find_commit(oid)
                .map_err(|e| format!("Failed to find commit: {}", e))?;

            let refs = refs_map.get(&oid_str).cloned().unwrap_or_default();

            let parents: Vec<String> = commit.parents().map(|p| p.id().to_string()).collect();

            let message = commit.summary().unwrap_or("").to_string();

            let author = commit.author();
            let author_name = author.name().unwrap_or("Unknown").to_string();
            let author_email = author.email().unwrap_or("").to_string();

            commits.push(CommitNode {
                id: oid_str,
                short_id: oid.to_string()[..7].to_string(),
                message,
                author_name,
                author_email,
                timestamp: commit.time().seconds(),
                parents,
                branch_refs: refs,
                fork_branch_name: None,
                merge_branch_name: None,
                x: 0.0,
                y: 0.0,
                lane: 0,
            });

            if i % 100 == 0 {
                log::info!("Processed {} commits", i);
            }
        }

        log::info!("Got {} commits, building edges and lanes", commits.len());

        let edges = self.build_edges(&commits);
        log::info!("Built {} edges", edges.len());

        let branches = self.assign_lanes(&commits, &main_branch);
        log::info!(
            "Assigned {} lanes: {:?}",
            branches.len(),
            branches.iter().map(|b| &b.name).collect::<Vec<_>>()
        );

        log::info!("Calculating layout...");
        let commits = self.calculate_layout(commits, &branches, &main_branch);

        // Debug: log first few commits
        for (i, c) in commits.iter().take(5).enumerate() {
            log::info!("Commit {}: x={}, y={}, lane={}", i, c.x, c.y, c.lane);
        }
        log::info!("Layout calculated");

        Ok(GitData {
            commits,
            edges,
            branches,
            main_branch,
        })
    }

    fn build_edges(&self, commits: &[CommitNode]) -> Vec<CommitEdge> {
        let mut edges = Vec::new();
        let commit_ids: HashSet<&String> = commits.iter().map(|c| &c.id).collect();

        for commit in commits {
            for parent_id in &commit.parents {
                if commit_ids.contains(parent_id) {
                    let edge_type = if commit.parents.len() > 1 {
                        EdgeType::Merge
                    } else {
                        EdgeType::Direct
                    };

                    edges.push(CommitEdge {
                        from: commit.id.clone(),
                        to: parent_id.clone(),
                        edge_type,
                    });
                }
            }
        }

        edges
    }

    fn assign_lanes(&mut self, commits: &[CommitNode], main_branch: &str) -> Vec<BranchLane> {
        let mut lanes: Vec<BranchLane> = Vec::new();

        lanes.push(BranchLane {
            name: main_branch.to_string(),
            lane_index: 0,
            color: "#4A90D9".to_string(),
            is_tag: false,
        });

        let colors = [
            "#E91E63", "#9C27B0", "#673AB7", "#3F51B5", "#00BCD4", "#009688", "#4CAF50", "#8BC34A",
            "#FF9800", "#FF5722",
        ];

        let mut branch_to_lane: HashMap<String, i32> = HashMap::new();
        branch_to_lane.insert(main_branch.to_string(), 0);

        // Get all branches from repository directly
        let mut all_branches: Vec<String> = Vec::new();
        if let Ok(branches) = self.repo.branches(Some(BranchType::Local)) {
            for branch_result in branches {
                if let Ok((branch, _)) = branch_result {
                    if let Some(name) = branch.name().ok().flatten() {
                        if name != main_branch {
                            all_branches.push(name.to_string());
                        }
                    }
                }
            }
        }

        // Also get tags
        if let Ok(references) = self.repo.references() {
            for reference in references.flatten() {
                if let Some(name) = reference.name() {
                    if name.starts_with("refs/tags/") {
                        let tag_name = name.strip_prefix("refs/tags/").unwrap_or(name).to_string();
                        all_branches.push(tag_name);
                    }
                }
            }
        }

        let mut lane_idx = 1;
        for branch_name in all_branches {
            if !branch_to_lane.contains_key(&branch_name) {
                branch_to_lane.insert(branch_name.clone(), lane_idx);
                lanes.push(BranchLane {
                    name: branch_name,
                    lane_index: lane_idx,
                    color: colors[lane_idx as usize % colors.len()].to_string(),
                    is_tag: false,
                });
                lane_idx += 1;
            }
        }

        log::info!(
            "Created {} lanes: {:?}",
            lanes.len(),
            lanes.iter().map(|b| &b.name).collect::<Vec<_>>()
        );
        lanes
    }

    fn calculate_layout(
        &self,
        mut commits: Vec<CommitNode>,
        branches: &[BranchLane],
        main_branch: &str,
    ) -> Vec<CommitNode> {
        log::trace!(
            "calculate_layout called with {} commits, {} branches",
            commits.len(),
            branches.len()
        );

        if commits.is_empty() {
            return commits;
        }

        let branch_to_lane: HashMap<String, i32> = branches
            .iter()
            .map(|b| (b.name.clone(), b.lane_index))
            .collect();

        let main_lane = branch_to_lane.get(main_branch).copied().unwrap_or(0);
        log::trace!("main_lane: {}", main_lane);

        let num_lanes = branches.len().max(1) as i32;

        // Lane assignment: use branch ref if present, otherwise distribute across lanes
        for (i, commit) in commits.iter_mut().enumerate() {
            if !commit.branch_refs.is_empty() {
                // If commit has branch refs, use the first one's lane
                for branch_ref in &commit.branch_refs {
                    if let Some(&lane) = branch_to_lane.get(&branch_ref.name) {
                        commit.lane = lane;
                        break;
                    }
                }
            } else {
                // No branch refs - distribute across lanes to avoid overlap
                // Use commit index to spread them across available lanes
                commit.lane = (i as i32) % num_lanes;
            }
        }

        // Sort commits by timestamp (oldest first for x position)
        commits.sort_by_key(|c| c.timestamp);

        // Calculate x positions (time-based, oldest on left)
        let node_spacing = 80.0;
        for (i, commit) in commits.iter_mut().enumerate() {
            commit.x = (i as f64) * node_spacing;
        }

        // Calculate y positions (lane-based)
        for commit in &mut commits {
            let y_offset = (commit.lane - main_lane) as f64;
            commit.y = y_offset * 80.0;
        }

        commits
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

        let mut files = Vec::new();

        if let Some(parent) = commit.parents().next() {
            let parent_tree = parent
                .tree()
                .map_err(|e| format!("Failed to get parent tree: {}", e))?;
            let commit_tree = commit
                .tree()
                .map_err(|e| format!("Failed to get commit tree: {}", e))?;

            let diff = self
                .repo
                .diff_tree_to_tree(Some(&parent_tree), Some(&commit_tree), None)
                .map_err(|e| format!("Failed to get diff: {}", e))?;

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
                    additions: 0,
                    deletions: 0,
                    status,
                });
            }
        }

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
        })
    }

    pub fn get_branch_list(&self) -> Result<Vec<BranchLane>, String> {
        let mut all_branches: HashSet<String> = HashSet::new();

        for branch_result in self
            .repo
            .branches(Some(BranchType::Local))
            .map_err(|e| format!("Failed to get branches: {}", e))?
        {
            if let Ok((branch, _)) = branch_result {
                if let Some(name) = branch.name().ok().flatten() {
                    all_branches.insert(name.to_string());
                }
            }
        }

        for branch_result in self
            .repo
            .branches(Some(BranchType::Remote))
            .map_err(|e| format!("Failed to get remote branches: {}", e))?
        {
            if let Ok((branch, _)) = branch_result {
                if let Some(name) = branch.name().ok().flatten() {
                    all_branches.insert(name.to_string());
                }
            }
        }

        let references = self
            .repo
            .references()
            .map_err(|e| format!("Failed to get references: {}", e))?;

        let mut tags: Vec<String> = Vec::new();
        for reference in references {
            if let Ok(ref_obj) = reference {
                if let Some(name) = ref_obj.name() {
                    if name.starts_with("refs/tags/") {
                        let tag_name = name.strip_prefix("refs/tags/").unwrap_or(name).to_string();
                        if !tags.contains(&tag_name) {
                            tags.push(tag_name);
                        }
                    }
                }
            }
        }

        let colors = [
            "#4A90D9", "#E91E63", "#9C27B0", "#673AB7", "#3F51B5", "#00BCD4", "#009688", "#4CAF50",
            "#8BC34A", "#FF9800", "#FF5722", "#795548", "#607D8B", "#F44336", "#3F51B5",
        ];

        let main_branch = if all_branches.contains("main") {
            "main".to_string()
        } else if all_branches.contains("master") {
            "master".to_string()
        } else {
            all_branches.iter().next().cloned().unwrap_or_default()
        };

        let mut lanes: Vec<BranchLane> = Vec::new();
        lanes.push(BranchLane {
            name: main_branch.clone(),
            lane_index: 0,
            color: colors[0].to_string(),
            is_tag: false,
        });

        let mut idx = 1;
        for branch in &all_branches {
            if *branch != main_branch {
                lanes.push(BranchLane {
                    name: branch.clone(),
                    lane_index: idx,
                    color: colors[idx as usize % colors.len()].to_string(),
                    is_tag: false,
                });
                idx += 1;
            }
        }

        for tag in &tags {
            lanes.push(BranchLane {
                name: tag.clone(),
                lane_index: idx,
                color: "#9C27B0".to_string(),
                is_tag: true,
            });
            idx += 1;
        }

        Ok(lanes)
    }

    pub fn read_git_data_from_branch(
        &mut self,
        branch_name: &str,
        limit: usize,
    ) -> Result<GitData, String> {
        let refs_map = self.get_all_references()?;

        let branch_oid = {
            let branch_ref = self
                .repo
                .find_branch(branch_name, BranchType::Local)
                .or_else(|_| self.repo.find_branch(branch_name, BranchType::Remote))
                .map_err(|e| format!("Branch not found: {}", e))?;

            branch_ref
                .get()
                .target()
                .ok_or("Branch has no target commit")?
        };

        let mut revwalk = self
            .repo
            .revwalk()
            .map_err(|e| format!("Failed to create revwalk: {}", e))?;

        revwalk
            .set_sorting(Sort::TIME | Sort::TOPOLOGICAL)
            .map_err(|e| format!("Failed to set sorting: {}", e))?;

        revwalk
            .push(branch_oid)
            .map_err(|e| format!("Failed to push branch head: {}", e))?;

        let mut all_branches: HashSet<String> = HashSet::new();
        for branch_result in self
            .repo
            .branches(Some(BranchType::Local))
            .map_err(|e| format!("Failed to get branches: {}", e))?
        {
            if let Ok((branch, _)) = branch_result {
                if let Some(name) = branch.name().ok().flatten() {
                    all_branches.insert(name.to_string());
                }
            }
        }

        let mut commits: Vec<CommitNode> = Vec::new();
        let mut commit_oid_set: HashSet<String> = HashSet::new();

        for (i, oid_result) in revwalk.enumerate() {
            if i >= limit {
                break;
            }

            let oid = oid_result.map_err(|e| format!("Failed to get oid: {}", e))?;

            let oid_str = oid.to_string();
            if commit_oid_set.contains(&oid_str) {
                continue;
            }
            commit_oid_set.insert(oid_str.clone());

            let commit = self
                .repo
                .find_commit(oid)
                .map_err(|e| format!("Failed to find commit: {}", e))?;

            let refs = refs_map.get(&oid_str).cloned().unwrap_or_default();
            let parents: Vec<String> = commit.parents().map(|p| p.id().to_string()).collect();
            let message = commit.summary().unwrap_or("").to_string();
            let author = commit.author();
            let author_name = author.name().unwrap_or("Unknown").to_string();
            let author_email = author.email().unwrap_or("").to_string();

            commits.push(CommitNode {
                id: oid_str,
                short_id: oid.to_string()[..7].to_string(),
                message,
                author_name,
                author_email,
                timestamp: commit.time().seconds(),
                parents,
                branch_refs: refs,
                fork_branch_name: None,
                merge_branch_name: None,
                x: 0.0,
                y: 0.0,
                lane: 0,
            });
        }

        let branches = self.assign_lanes(&commits, branch_name);
        let edges = self.build_edges(&commits);
        let commits = self.calculate_layout(commits, &branches, branch_name);

        Ok(GitData {
            commits,
            edges,
            branches,
            main_branch: branch_name.to_string(),
        })
    }

    pub fn filter_by_branches(&mut self, branch_names: &[String]) -> Result<GitData, String> {
        let refs_map = self.get_all_references()?;

        let mut revwalk = self
            .repo
            .revwalk()
            .map_err(|e| format!("Failed to create revwalk: {}", e))?;

        revwalk
            .set_sorting(Sort::TIME | Sort::TOPOLOGICAL)
            .map_err(|e| format!("Failed to set sorting: {}", e))?;

        revwalk
            .push_head()
            .map_err(|e| format!("Failed to push HEAD: {}", e))?;

        let mut commits: Vec<CommitNode> = Vec::new();
        let mut commit_oid_set: HashSet<String> = HashSet::new();

        for (i, oid_result) in revwalk.enumerate() {
            if i >= 2000 {
                break;
            }

            let oid = oid_result.map_err(|e| format!("Failed to get oid: {}", e))?;

            let oid_str = oid.to_string();
            if commit_oid_set.contains(&oid_str) {
                continue;
            }

            let refs = refs_map.get(&oid_str).cloned().unwrap_or_default();

            let branch_names_set: HashSet<&str> = branch_names.iter().map(|s| s.as_str()).collect();
            let has_matching_branch = refs
                .iter()
                .any(|r| branch_names_set.contains(r.name.as_str()));

            if !has_matching_branch && !branch_names.is_empty() {
                continue;
            }

            commit_oid_set.insert(oid_str.clone());

            let commit = self
                .repo
                .find_commit(oid)
                .map_err(|e| format!("Failed to find commit: {}", e))?;

            let parents: Vec<String> = commit.parents().map(|p| p.id().to_string()).collect();
            let message = commit.summary().unwrap_or("").to_string();
            let author = commit.author();
            let author_name = author.name().unwrap_or("Unknown").to_string();
            let author_email = author.email().unwrap_or("").to_string();

            commits.push(CommitNode {
                id: oid_str,
                short_id: oid.to_string()[..7].to_string(),
                message,
                author_name,
                author_email,
                timestamp: commit.time().seconds(),
                parents,
                branch_refs: refs,
                fork_branch_name: None,
                merge_branch_name: None,
                x: 0.0,
                y: 0.0,
                lane: 0,
            });
        }

        let main_branch = branch_names
            .first()
            .cloned()
            .unwrap_or_else(|| "main".to_string());
        let branches = self.assign_lanes(&commits, &main_branch);
        let edges = self.build_edges(&commits);
        let commits = self.calculate_layout(commits, &branches, &main_branch);

        Ok(GitData {
            commits,
            edges,
            branches,
            main_branch,
        })
    }
}
