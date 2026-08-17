//! Pure layout engine: assigns every commit to a branch lane using
//! first-parent lineage propagation, then produces typed edges
//! (Direct / Branch / Merge) and coordinates.
//!
//! No git2 dependency — operates only on models, so it is unit-testable
//! with hand-built commit graphs.

use crate::models::*;
use std::collections::{HashMap, HashSet};

pub const MAIN_COLOR: &str = "#4A90D9";
pub const TAG_COLOR: &str = "#9C27B0";

const LANE_PALETTE: [&str; 12] = [
    "#E91E63", "#FF9800", "#9C27B0", "#009688", "#FF5722", "#3F51B5",
    "#8BC34A", "#00BCD4", "#795548", "#673AB7", "#4CAF50", "#607D8B",
];

/// Single source of truth for lane colors. Lane 0 (main) is fixed;
/// everything else rotates through the palette.
pub fn lane_color(lane_index: i32) -> String {
    if lane_index <= 0 {
        return MAIN_COLOR.to_string();
    }
    LANE_PALETTE[((lane_index - 1) as usize) % LANE_PALETTE.len()].to_string()
}

/// A branch ref that seeds one lane.
#[derive(Debug, Clone)]
pub struct LaneSeed {
    /// Display name of the lane (short branch name, no refs/ prefix).
    pub name: String,
    /// Oid of the commit the branch points to.
    pub tip: String,
}

const LANE_HEIGHT: f64 = 80.0;

/// Core entry point. `commits` may be in any order; they are sorted by
/// timestamp (oldest first) inside. Mutates commits in place (lane,
/// lane_owner, x, y, is_head, fork/merge labels) and returns the lane
/// list plus typed edges.
pub fn compute_layout(
    commits: &mut Vec<CommitNode>,
    seeds: &[LaneSeed],
    main_branch: &str,
    head_id: Option<&str>,
) -> (Vec<BranchLane>, Vec<CommitEdge>) {
    if commits.is_empty() {
        return (Vec::new(), Vec::new());
    }

    let index_of: HashMap<String, usize> = commits
        .iter()
        .enumerate()
        .map(|(i, c)| (c.id.clone(), i))
        .collect();

    // owner[i] = lane name that claimed commits[i]
    let mut owner: Vec<Option<String>> = vec![None; commits.len()];

    // Order seeds: main first; then lanes whose tip was merged into another
    // lane (the merge record proves their lineage was integrated as a unit,
    // so they get first claim on their ancestry); then the rest. Within each
    // class, newest tip first.
    let merged_tips: HashSet<&str> = commits
        .iter()
        .flat_map(|c| c.parents.iter().skip(1))
        .map(|p| p.as_str())
        .collect();
    let mut ordered_seeds: Vec<&LaneSeed> = seeds.iter().collect();
    ordered_seeds.sort_by_key(|s| {
        if s.name == main_branch {
            (0, i64::MAX)
        } else {
            let ts = index_of
                .get(&s.tip)
                .map(|&i| commits[i].timestamp)
                .unwrap_or(i64::MIN);
            let class = if merged_tips.contains(s.tip.as_str()) { 1 } else { 2 };
            (class, -ts)
        }
    });

    // Branch tips act as walls: a tip commit belongs to its own branch even
    // if a descendant branch claims its lineage first (branch-from-branch
    // case). Main is the exception — it claims straight through reservations
    // so a fast-forwarded side branch never splits the mainline.
    let tip_of: HashMap<usize, &str> = ordered_seeds
        .iter()
        .filter_map(|s| index_of.get(&s.tip).map(|&i| (i, s.name.as_str())))
        .collect();

    // lane name -> fork point commit id
    let mut fork_points: HashMap<String, String> = HashMap::new();
    // lane names in claim order (main first)
    let mut lane_names: Vec<String> = Vec::new();

    for seed in ordered_seeds {
        let Some(&tip_idx) = index_of.get(&seed.tip) else {
            continue; // tip outside the walked window
        };
        if owner[tip_idx].is_some() {
            continue; // zero-length lane: ref points at an already-claimed commit
        }

        let lane_name = seed.name.clone();
        let is_main = lane_name == main_branch;
        lane_names.push(lane_name.clone());

        // Walk first-parent chain from the tip, claiming until we hit a
        // commit already owned by another lane or reserved as another
        // lane's tip — that commit is the fork point.
        let mut cursor = Some(tip_idx);
        while let Some(i) = cursor {
            let blocked = owner[i].is_some()
                || (!is_main
                    && tip_of.get(&i).map(|t| *t != lane_name).unwrap_or(false));
            if blocked {
                fork_points.insert(lane_name.clone(), commits[i].id.clone());
                break;
            }
            owner[i] = Some(lane_name.clone());
            cursor = commits[i]
                .parents
                .first()
                .and_then(|p| index_of.get(p))
                .copied();
        }
    }

    // Fallback: commits unreachable from any seed's first-parent chain
    // (e.g. second-parent ancestry of an unmerged branch) join the lane of
    // their nearest descendant. Rare, but keeps the "every commit has a
    // lane" invariant.
    for i in 0..commits.len() {
        if owner[i].is_none() {
            owner[i] = Some(main_branch.to_string());
        }
    }

    // Vertical lane order: main on top, others by fork-point time
    // (born earlier = closer to main), ties broken by tip recency.
    let ts_of = |id: &str| -> i64 {
        index_of.get(id).map(|&i| commits[i].timestamp).unwrap_or(0)
    };
    let mut side_lanes: Vec<&String> = lane_names.iter().skip(1).collect();
    side_lanes.sort_by_key(|name| {
        let fork_ts = fork_points.get(*name).map(|id| ts_of(id)).unwrap_or(i64::MAX);
        (fork_ts, name.to_string())
    });

    let mut lane_index_of: HashMap<String, i32> = HashMap::new();
    let mut lanes: Vec<BranchLane> = Vec::new();
    if let Some(main_name) = lane_names.first() {
        lane_index_of.insert(main_name.clone(), 0);
        lanes.push(BranchLane {
            name: main_name.clone(),
            lane_index: 0,
            color: lane_color(0),
            is_tag: false,
            fork_point: None,
            merged_into: None,
            is_active: true,
        });
    }
    for (k, name) in side_lanes.into_iter().enumerate() {
        let idx = (k + 1) as i32;
        lane_index_of.insert(name.clone(), idx);
        lanes.push(BranchLane {
            name: name.clone(),
            lane_index: idx,
            color: lane_color(idx),
            is_tag: false,
            fork_point: fork_points.get(name).cloned(),
            merged_into: None,
            is_active: true,
        });
    }

    // Detect where each lane was merged: lane's tip appears as a non-first
    // parent of a merge commit on another lane.
    let tip_of: HashMap<&String, &String> = seeds
        .iter()
        .map(|s| (&s.name, &s.tip))
        .collect();
    for lane in lanes.iter_mut() {
        let Some(&tip) = tip_of.get(&lane.name) else { continue };
        for c in commits.iter() {
            if c.parents.len() > 1 && c.parents[1..].iter().any(|p| p == tip) {
                lane.merged_into = Some(c.id.clone());
                break;
            }
        }
    }

    // Assign lane numbers + ownership to commits.
    for (i, c) in commits.iter_mut().enumerate() {
        let lane_name = owner[i].clone().unwrap_or_else(|| main_branch.to_string());
        c.lane = lane_index_of.get(&lane_name).copied().unwrap_or(0);
        c.lane_owner = lane_name;
        c.is_head = head_id.map(|h| h == c.id).unwrap_or(false);
    }

    // Typed edges + fork/merge annotations.
    let mut edges = Vec::new();
    for i in 0..commits.len() {
        let child_owner = owner[i].clone().unwrap_or_default();
        for (p_pos, parent_id) in commits[i].parents.clone().iter().enumerate() {
            let Some(&pi) = index_of.get(parent_id) else { continue };
            let parent_owner = owner[pi].clone().unwrap_or_default();
            let is_merge_link = commits[i].parents.len() > 1 && p_pos > 0;
            let is_fork_edge = !is_merge_link
                && parent_owner != child_owner
                && fork_points.get(&child_owner).map(|fp| fp == parent_id).unwrap_or(false);

            let edge_type = if is_merge_link {
                if parent_owner != child_owner {
                    commits[i].merge_branch_name = Some(parent_owner.clone());
                }
                EdgeType::Merge
            } else if is_fork_edge {
                // Annotate the fork point commit (on the parent lane).
                // Multiple lanes may fork from the same commit; join names.
                let entry = commits[pi].fork_branch_name.get_or_insert_with(String::new);
                if !entry.is_empty() {
                    entry.push_str(", ");
                }
                entry.push_str(&child_owner);
                EdgeType::Branch
            } else {
                EdgeType::Direct
            };

            edges.push(CommitEdge {
                from: commits[i].id.clone(),
                to: parent_id.clone(),
                edge_type,
            });
        }
    }

    // Key-node marking (gmaster-style smart compression): a commit survives
    // compression if it is HEAD, carries refs (tips/tags), is a merge commit,
    // is a merge source, is a fork point, is its lane's first own commit,
    // or is its lane's tip within the loaded window.
    let mut is_merge_source: HashSet<usize> = HashSet::new();
    let mut has_same_lane_child: HashSet<usize> = HashSet::new();
    for (i, c) in commits.iter().enumerate() {
        for (p_pos, p) in c.parents.iter().enumerate() {
            if let Some(&pi) = index_of.get(p) {
                if p_pos > 0 {
                    is_merge_source.insert(pi);
                } else if owner[pi] == owner[i] {
                    has_same_lane_child.insert(pi);
                }
            }
        }
    }
    let fork_point_ids: HashSet<&String> = fork_points.values().collect();
    for (i, c) in commits.iter_mut().enumerate() {
        let is_lane_birth = match c.parents.first() {
            None => true,
            Some(p) => index_of
                .get(p)
                .map(|&pi| owner[pi] != owner[i])
                .unwrap_or(false),
        };
        c.is_key = c.is_head
            || !c.branch_refs.is_empty()
            || c.parents.len() > 1
            || is_merge_source.contains(&i)
            || fork_point_ids.contains(&c.id)
            || is_lane_birth
            || !has_same_lane_child.contains(&i);
    }

    // Time-proportional x with a per-lane minimum spacing so dense clusters
    // don't collapse onto one pixel.
    commits.sort_by_key(|c| c.timestamp);
    let t_min = commits.first().map(|c| c.timestamp).unwrap_or(0);
    const PX_PER_DAY: f64 = 10.0;
    const MIN_SPACING: f64 = 28.0;
    let mut last_x: HashMap<i32, f64> = HashMap::new();
    for c in commits.iter_mut() {
        let time_x = (c.timestamp - t_min) as f64 / 86400.0 * PX_PER_DAY;
        let x = match last_x.get(&c.lane) {
            Some(&l) => time_x.max(l + MIN_SPACING),
            None => time_x,
        };
        c.x = x;
        last_x.insert(c.lane, x);
        c.y = c.lane as f64 * LANE_HEIGHT;
    }

    (lanes, edges)
}
