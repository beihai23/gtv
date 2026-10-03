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

// Reserved semantic colors must never appear here: the UI paints the
// checked-out lane's ring/band/arrow in #4CAF50 ("you are here" green)
// and every tag ref in TAG_COLOR, so a lane painted the same hex would
// fake that meaning. MAIN_COLOR stays out for the same reason (lane 0
// is fixed to it separately). Ten hues means faster palette recycling
// than the old twelve -- a lesser evil than stealing a semantic color.
const LANE_PALETTE: [&str; 10] = [
    "#E91E63", "#FF9800", "#009688", "#FF5722", "#3F51B5",
    "#8BC34A", "#00BCD4", "#795548", "#673AB7", "#607D8B",
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
#[derive(Debug, Clone, Default)]
pub struct LaneSeed {
    /// Display name of the lane (short branch name, no refs/ prefix;
    /// `origin/x` for remote-only branches).
    pub name: String,
    /// Oid of the commit the branch points to.
    pub tip: String,
    /// True when the seed comes from a remote-tracking ref with no local
    /// counterpart.
    pub is_remote: bool,
    /// Upstream tips of the same branch folded into this lane's walk starts
    /// (a local branch shadows the remote lane, but the remote tip still
    /// claims for it so upstream-only history stays attributable).
    pub extra_tips: Vec<String>,
}

const LANE_HEIGHT: f64 = 80.0;

/// Longest-path depth of each commit above its oldest loaded ancestor
/// (0 = no parent in the loaded set). Used only as the within-second
/// sort tiebreak so equal-timestamp commits order parents before
/// children. Iterative post-order walk — recursion would overflow the
/// stack on a 10k-commit window. A parent still on the DFS stack would
/// mean a cycle (corrupt repo); it is ignored rather than looping.
fn topo_depth(commits: &[CommitNode], index_of: &HashMap<String, usize>) -> Vec<u32> {
    const ON_STACK: u8 = 1;
    const DONE: u8 = 2;
    let n = commits.len();
    let mut state = vec![0u8; n];
    let mut depth = vec![0u32; n];
    for start in 0..n {
        if state[start] != 0 {
            continue;
        }
        state[start] = ON_STACK;
        let mut stack = vec![start];
        while let Some(&i) = stack.last() {
            let mut all_done = true;
            let mut max_parent: Option<u32> = None;
            for p in &commits[i].parents {
                let Some(&pi) = index_of.get(p) else { continue };
                match state[pi] {
                    DONE => {
                        max_parent = Some(max_parent.map_or(depth[pi], |m| m.max(depth[pi])))
                    }
                    ON_STACK => {} // defensive: cycle in corrupt data
                    _ => {
                        state[pi] = ON_STACK;
                        stack.push(pi);
                        all_done = false;
                    }
                }
            }
            if all_done {
                depth[i] = max_parent.map_or(0, |m| m + 1);
                state[i] = DONE;
                stack.pop();
            }
        }
    }
    depth
}

/// Core entry point. `commits` may be in any order; they are sorted by
/// timestamp (oldest first) inside. Mutates commits in place (lane,
/// lane_owner, x, y, is_head, fork/merge labels) and returns the lane
/// list, typed edges, and folded time gaps (axis breaks).
pub fn compute_layout(
    commits: &mut Vec<CommitNode>,
    seeds: &[LaneSeed],
    main_branch: &str,
    head_id: Option<&str>,
) -> (Vec<BranchLane>, Vec<CommitEdge>, Vec<TimeGap>) {
    if commits.is_empty() {
        return (Vec::new(), Vec::new(), Vec::new());
    }

    let index_of: HashMap<String, usize> = commits
        .iter()
        .enumerate()
        .map(|(i, c)| (c.id.clone(), i))
        .collect();

    // owner[i] = lane name that claimed commits[i]
    let mut owner: Vec<Option<String>> = vec![None; commits.len()];

    // Seed order decides who claims shared ancestry first. Main claims
    // first unconditionally: no precedence edge may ever demote the trunk
    // behind a side branch. (The removed R1 rule — "a seed whose tip lies
    // on another's first-parent chain claims first" — did exactly that:
    // an ancestor-tip branch like release/x, ordered before main, walked
    // straight down the mainline and stole its whole history, because from
    // its own tip it never hits main's tip wall.)
    //   R2 (merge destination): seed S's tip is a non-first parent of a
    //      merge commit m, and m lies on seed T's first-parent chain
    //      -> T claims before S, EXCEPT when S is main: merging main into
    //      your branch (a sync merge) must not demote main. (The old rule
    //      gave merged SOURCES unconditional priority, which handed the
    //      destination branch's own history to the merged branch whenever
    //      the destination was not main.)
    // R2 edges are resolved with Kahn's algorithm; among the ready
    // (in-degree 0) seeds a soft key picks: main first, then lanes whose
    // tip was merged into another lane (the merge record proves their
    // lineage was integrated as a unit — covers "Y merged into main, Z
    // forked mid-Y"), newest tip first, name as the final tiebreak. A cycle
    // (mutual merges) is broken by the same soft key so the sort always
    // terminates. Ordering alone does not protect branch tips — the tip
    // wall in the claiming loop below does (a walk stops at another lane's
    // tip commit regardless of who walks first). When the DAG offers no
    // evidence at all — two branches forked out of each other's mid-region
    // with no merge and no ancestry relation — the direction is genuinely
    // ambiguous and newest-tip-first decides; that residual misattribution
    // is the documented heuristic limit.
    let merged_tips: HashSet<&str> = commits
        .iter()
        .flat_map(|c| c.parents.iter().skip(1))
        .map(|p| p.as_str())
        .collect();

    // First-parent chain (commit ids) of each seed, stopping at the window
    // edge: the union of the chains walked from the tip and every extra tip.
    // The insert-check also guards against a corrupt cycle.
    let chains: Vec<HashSet<&str>> = seeds
        .iter()
        .map(|s| {
            let mut set = HashSet::new();
            for start in std::iter::once(&s.tip).chain(s.extra_tips.iter()) {
                let mut cursor = index_of.get(start).copied();
                while let Some(i) = cursor {
                    if !set.insert(commits[i].id.as_str()) {
                        break;
                    }
                    cursor = commits[i]
                        .parents
                        .first()
                        .and_then(|p| index_of.get(p))
                        .copied();
                }
            }
            set
        })
        .collect();

    // Precedence edges (before, after) as seed indices, deduped.
    let mut precedence: HashSet<(usize, usize)> = HashSet::new();
    // R2: S's tip merged at m, m on T's chain -> T before S. Main is
    // exempt as the source: a sync merge (main merged into a side branch)
    // must not order that branch before the trunk.
    for m in commits.iter() {
        if m.parents.len() < 2 {
            continue;
        }
        for parent in &m.parents[1..] {
            for (s, seed_s) in seeds.iter().enumerate() {
                if &seed_s.tip != parent || seed_s.name == main_branch {
                    continue;
                }
                for (t, _) in seeds.iter().enumerate() {
                    if t != s && chains[t].contains(m.id.as_str()) {
                        precedence.insert((t, s));
                    }
                }
            }
        }
    }

    // Soft priority key (lower wins): main class, merged-tip class, the
    // rest; newest tip first within a class (Reverse instead of negation:
    // -i64::MIN overflows for tips outside the walked window); name as a
    // stable tiebreak.
    let soft_key = |s: &LaneSeed| -> (u8, std::cmp::Reverse<i64>) {
        let class = if s.name == main_branch {
            0
        } else if merged_tips.contains(s.tip.as_str()) {
            1
        } else {
            2
        };
        let ts = index_of
            .get(&s.tip)
            .map(|&i| commits[i].timestamp)
            .unwrap_or(i64::MIN);
        (class, std::cmp::Reverse(ts))
    };
    let soft_cmp = |a: &LaneSeed, b: &LaneSeed| {
        soft_key(a).cmp(&soft_key(b)).then_with(|| a.name.cmp(&b.name))
    };

    // Kahn's algorithm over the precedence edges; each round takes the
    // soft-key-smallest ready seed. No ready seed means a cycle — take the
    // soft-key-smallest remaining seed outright to guarantee termination.
    let mut successors: Vec<Vec<usize>> = vec![Vec::new(); seeds.len()];
    let mut indegree = vec![0usize; seeds.len()];
    for &(before, after) in &precedence {
        successors[before].push(after);
        indegree[after] += 1;
    }
    let mut done = vec![false; seeds.len()];
    let mut ordered_seeds: Vec<&LaneSeed> = Vec::with_capacity(seeds.len());
    loop {
        let pick = (0..seeds.len())
            .filter(|&i| !done[i] && indegree[i] == 0)
            .min_by(|&a, &b| soft_cmp(&seeds[a], &seeds[b]))
            .or_else(|| {
                (0..seeds.len())
                    .filter(|&i| !done[i])
                    .min_by(|&a, &b| soft_cmp(&seeds[a], &seeds[b]))
            });
        let Some(i) = pick else { break };
        done[i] = true;
        ordered_seeds.push(&seeds[i]);
        for &next in &successors[i] {
            indegree[next] -= 1;
        }
    }

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
        let lane_name = seed.name.clone();
        let is_main = lane_name == main_branch;
        let mut lane_pushed = false;

        // One lane, one claim per start: the branch tip plus every folded
        // upstream tip. A start whose tip is already claimed (or outside
        // the window) is skipped on its own; the lane name is registered
        // at the first start that actually claims.
        for start in std::iter::once(&seed.tip).chain(seed.extra_tips.iter()) {
            let Some(&start_idx) = index_of.get(start) else {
                continue; // tip outside the walked window
            };
            if owner[start_idx].is_some() {
                continue; // zero-length start: points at an already-claimed commit
            }
            if !lane_pushed {
                lane_names.push(lane_name.clone());
                lane_pushed = true;
            }

            // Walk first-parent chain from the start, claiming until we hit
            // a commit already owned by another lane or reserved as another
            // lane's tip — that commit is the fork point.
            let mut cursor = Some(start_idx);
            while let Some(i) = cursor {
                let blocked = owner[i].is_some()
                    || (!is_main
                        && tip_of.get(&i).map(|t| *t != lane_name).unwrap_or(false));
                if blocked {
                    if owner[i].as_deref() == Some(lane_name.as_str()) {
                        break; // two starts of the same lane converge — not a fork
                    }
                    // First-wins: two diverged starts may hit different
                    // lanes; keep the fork point recorded first.
                    fork_points
                        .entry(lane_name.clone())
                        .or_insert_with(|| commits[i].id.clone());
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
    }

    // Fallback: lane purity. A lane renders exactly the first-parent lineage
    // of its own branch — merged-in content from other branches is that
    // other branch's history, never this lane's (git common sense; the user
    // rule stated 2026-09-20: "每个分支的泳道上只能出现自己分支上的
    // commit"). Commits no seed claimed therefore belong to NO rendered
    // lane: mark them unattributed ("") and the frontend hides them and
    // their edges outright. Ref-carrying strays (a branch deselected in the
    // branch panel whose commits still enter the window through merges from
    // selected lanes) and anonymous strays (stale merged lineage whose tip
    // fell outside the window) are handled identically — absorbing either
    // into a lane would misattribute foreign lineage.
    for owner_slot in owner.iter_mut().filter(|o| o.is_none()) {
        *owner_slot = Some(String::new());
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
    let remote_of: HashMap<&str, bool> = seeds
        .iter()
        .map(|s| (s.name.as_str(), s.is_remote))
        .collect();
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
            is_remote: remote_of.get(main_name.as_str()).copied().unwrap_or(false),
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
            is_remote: remote_of.get(name.as_str()).copied().unwrap_or(false),
        });
    }

    // Detect where each lane was merged: any of the lane's tips (branch tip
    // plus folded upstream tips) appears as a non-first parent of a merge
    // commit on another lane.
    let tips_of: HashMap<&String, Vec<&String>> = seeds
        .iter()
        .map(|s| {
            let mut tips = vec![&s.tip];
            tips.extend(s.extra_tips.iter());
            (&s.name, tips)
        })
        .collect();
    for lane in lanes.iter_mut() {
        let Some(tips) = tips_of.get(&lane.name) else { continue };
        for c in commits.iter() {
            if c.parents.len() > 1
                && c.parents[1..].iter().any(|p| tips.iter().any(|t| *t == p))
            {
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
                if !parent_owner.is_empty() && parent_owner != child_owner {
                    commits[i].merge_branch_name = Some(parent_owner.clone());
                } else if parent_owner.is_empty() {
                    // The merged-in lineage is unattributed (hidden). The
                    // merge node stays on the lane — label it from the
                    // hidden parent's own branch refs so "what came in here"
                    // remains readable on the first-parent lane.
                    commits[i].merge_branch_name = commits[pi]
                        .branch_refs
                        .iter()
                        .find(|r| !r.is_tag)
                        .map(|r| {
                            r.name
                                .strip_prefix("origin/")
                                .unwrap_or(&r.name)
                                .to_string()
                        });
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
        // Unattributed lineage never renders as a key node — the frontend
        // hides it outright, and keeping it out of the key set also keeps it
        // out of the x-cascade and the minimap.
        if c.lane_owner.is_empty() {
            c.is_key = false;
        }
    }

    // Time-proportional x with ONE global min-spacing cascade over the key
    // commits of all lanes, in time order. (An earlier version cascaded per
    // lane: a dense lane like main stretched its own x while sparse lanes
    // kept honest time-x, so the same timestamp sat at different x on
    // different lanes and no time ruler could track the nodes — the ruler
    // read days away from the hovered commit's real time.) With a single
    // cascade, x is a monotone function of time shared by every lane, and
    // the ruler's piecewise map is exact at every commit.
    // Sort by timestamp, breaking ties topologically (parents first).
    // Same-second committer timestamps are common — a rebase rewrites a
    // whole branch in one second — and the walk feeds us newest-first,
    // so a plain stable sort would order a tied group child-before-
    // parent and the cascade below would place branch tips LEFT of
    // their own ancestors.
    let depth = topo_depth(commits, &index_of);
    let mut order: Vec<usize> = (0..commits.len()).collect();
    order.sort_by_key(|&i| (commits[i].timestamp, depth[i]));
    let mut taken: Vec<Option<CommitNode>> =
        std::mem::take(commits).into_iter().map(Some).collect();
    for &idx in &order {
        commits.push(taken[idx].take().expect("each index used once"));
    }
    let t_min = commits.first().map(|c| c.timestamp).unwrap_or(0);
    const PX_PER_DAY: f64 = 10.0;
    const MIN_SPACING: f64 = 28.0;
    let time_x = |ts: i64| (ts - t_min) as f64 / 86400.0 * PX_PER_DAY;

    // Pass 1: cascade the key commits (the nodes visible in the default
    // compressed view — they decide the scene's extent).
    let mut last_key_x: Option<f64> = None;
    for c in commits.iter_mut() {
        if !c.is_key {
            continue;
        }
        let tx = time_x(c.timestamp);
        let x = match last_key_x {
            Some(l) => tx.max(l + MIN_SPACING),
            None => tx,
        };
        c.x = x;
        last_key_x = Some(x);
    }

    // Pass 2: each non-key commit sits ON the piecewise line between the
    // key commits bracketing it in the sorted order, so it too obeys the
    // shared time→x map. (Non-key nodes only appear when a lane is
    // expanded.) Inside a bracket the fraction is the timestamp fraction
    // raised to at least the even-spread rank fraction, so commits
    // sharing one second (rebase artifacts) fan out in topological
    // order instead of stacking on one x; a small monotone cascade
    // keeps the run strictly increasing even when several commits clamp
    // to the same fraction.
    let mut i = 0;
    let mut prev_key: Option<(i64, f64)> = None;
    while i < commits.len() {
        if commits[i].is_key {
            prev_key = Some((commits[i].timestamp, commits[i].x));
            i += 1;
            continue;
        }
        let mut j = i;
        while j < commits.len() && !commits[j].is_key {
            j += 1;
        }
        let next_key = if j < commits.len() {
            Some((commits[j].timestamp, commits[j].x))
        } else {
            None
        };
        let m = (j - i) as f64;
        let mut last_f = 0.0f64;
        for (k, c) in commits[i..j].iter_mut().enumerate() {
            c.x = match (prev_key, next_key) {
                // Before the first key commit (oldest window commits of a
                // lane can be non-key): honest time-x, still monotone.
                (None, _) => time_x(c.timestamp),
                // After the last key: march right in fixed steps.
                (Some((_, xa)), None) => xa + (k as f64 + 1.0) * MIN_SPACING * 0.4,
                (Some((ta, xa)), Some((tb, xb))) => {
                    let ft = if tb > ta {
                        ((c.timestamp - ta) as f64 / (tb - ta) as f64).clamp(0.05, 0.95)
                    } else {
                        0.0
                    };
                    let fr = (k + 1) as f64 / (m + 1.0);
                    let f = ft.max(fr).max(last_f + 0.5 / (m + 1.0)).min(0.98);
                    last_f = f;
                    xa + (xb - xa) * f
                }
            };
        }
        i = j;
    }
    for c in commits.iter_mut() {
        c.y = c.lane as f64 * LANE_HEIGHT;
    }

    // Fold anomalous empty time gaps (axis breaks). Any x-range wider than
    // ~45 days of emptiness holds no commits at all; collapse it to a fixed
    // width and record it so the renderer can draw a break marker and the
    // ruler can skip it. One bogus future-dated commit would otherwise
    // stretch the whole scene by tens of thousands of pixels.
    const GAP_MIN_PX: f64 = 45.0 * PX_PER_DAY;
    const GAP_PX: f64 = 120.0;
    let mut xs: Vec<f64> = commits.iter().map(|c| c.x).collect();
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    xs.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
    // (orig_start, orig_end, t_start, t_end) in pre-fold coordinates
    let mut raw_gaps: Vec<(f64, f64, i64, i64)> = Vec::new();
    for w in xs.windows(2) {
        if w[1] - w[0] > GAP_MIN_PX {
            let t_start = commits
                .iter()
                .filter(|c| c.x <= w[0] + 0.5)
                .map(|c| c.timestamp)
                .max()
                .unwrap_or(0);
            let t_end = commits
                .iter()
                .filter(|c| c.x >= w[1] - 0.5)
                .map(|c| c.timestamp)
                .min()
                .unwrap_or(0);
            raw_gaps.push((w[0], w[1], t_start, t_end));
        }
    }
    let mut time_gaps: Vec<TimeGap> = Vec::new();
    if !raw_gaps.is_empty() {
        let mut shift = 0.0;
        for &(gs, ge, ts, te) in &raw_gaps {
            time_gaps.push(TimeGap {
                t_start: ts,
                t_end: te,
                x_start: gs - shift,
                x_end: gs - shift + GAP_PX,
            });
            shift += ge - gs - GAP_PX;
        }
        for c in commits.iter_mut() {
            let s: f64 = raw_gaps
                .iter()
                .filter(|g| c.x >= g.1 - 0.5)
                .map(|g| g.1 - g.0 - GAP_PX)
                .sum();
            c.x -= s;
        }
    }

    (lanes, edges, time_gaps)
}
