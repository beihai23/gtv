//! Pure-graph tests for the lane propagation algorithm.
//! Fixtures are hand-built CommitNode graphs — no git repo involved.

use gtv_lib::layout::{compute_layout, LaneSeed};
use gtv_lib::models::{BranchLane, BranchRef, CommitNode, EdgeType};

fn commit(id: &str, ts: i64, parents: &[&str]) -> CommitNode {
    CommitNode {
        id: id.to_string(),
        short_id: id[..7.min(id.len())].to_string(),
        message: format!("commit {id}"),
        author_name: "test".to_string(),
        author_email: "t@t".to_string(),
        timestamp: ts,
        parents: parents.iter().map(|p| p.to_string()).collect(),
        branch_refs: vec![],
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
    }
}

fn seed(name: &str, tip: &str) -> LaneSeed {
    LaneSeed {
        name: name.to_string(),
        tip: tip.to_string(),
    }
}

fn lane_of(commits: &[CommitNode], id: &str) -> String {
    commits
        .iter()
        .find(|c| c.id == id)
        .unwrap_or_else(|| panic!("commit {id} not found"))
        .lane_owner
        .clone()
}

fn lane<'a>(lanes: &'a [BranchLane], name: &str) -> &'a BranchLane {
    lanes
        .iter()
        .find(|l| l.name == name)
        .unwrap_or_else(|| panic!("lane {name} not found"))
}

fn edge_types(commits: &[CommitNode], edges: &[gtv_lib::models::CommitEdge], from: &str) -> Vec<EdgeType> {
    let mut v: Vec<EdgeType> = edges
        .iter()
        .filter(|e| e.from == from)
        .map(|e| match e.edge_type {
            EdgeType::Direct => EdgeType::Direct,
            EdgeType::Branch => EdgeType::Branch,
            EdgeType::Merge => EdgeType::Merge,
        })
        .collect();
    v.sort_by_key(|e| match e {
        EdgeType::Direct => 0,
        EdgeType::Branch => 1,
        EdgeType::Merge => 2,
    });
    let _ = commits;
    v
}

#[test]
fn linear_history_single_lane() {
    let mut commits = vec![
        commit("c1", 100, &[]),
        commit("c2", 200, &["c1"]),
        commit("c3", 300, &["c2"]),
    ];
    let (lanes, edges, _) = compute_layout(&mut commits, &[seed("main", "c3")], "main", Some("c3"));

    assert_eq!(lanes.len(), 1);
    for c in &commits {
        assert_eq!(c.lane_owner, "main");
        assert_eq!(c.lane, 0);
    }
    assert!(edges.iter().all(|e| matches!(e.edge_type, EdgeType::Direct)));
    assert!(commits.iter().find(|c| c.id == "c3").unwrap().is_head);
}

#[test]
fn feature_branch_fork_and_merge() {
    // main:   c1 -- c2 ------- m1
    //                 \       /
    // feat:            f1 -- f2
    let mut commits = vec![
        commit("c1", 100, &[]),
        commit("c2", 200, &["c1"]),
        commit("f1", 300, &["c2"]),
        commit("f2", 400, &["f1"]),
        commit("m1", 500, &["c2", "f2"]),
    ];
    let seeds = [seed("main", "m1"), seed("feat", "f2")];
    let (lanes, edges, _) = compute_layout(&mut commits, &seeds, "main", Some("m1"));

    assert_eq!(lane_of(&commits, "c1"), "main");
    assert_eq!(lane_of(&commits, "c2"), "main");
    assert_eq!(lane_of(&commits, "m1"), "main");
    assert_eq!(lane_of(&commits, "f1"), "feat");
    assert_eq!(lane_of(&commits, "f2"), "feat");

    let feat = lane(&lanes, "feat");
    assert_eq!(feat.fork_point.as_deref(), Some("c2"));
    assert_eq!(feat.merged_into.as_deref(), Some("m1"));
    assert_eq!(feat.lane_index, 1);

    // fork annotation lands on the fork-point commit (parent lane)
    let c2 = commits.iter().find(|c| c.id == "c2").unwrap();
    assert_eq!(c2.fork_branch_name.as_deref(), Some("feat"));
    // merge annotation lands on the merge commit
    let m1 = commits.iter().find(|c| c.id == "m1").unwrap();
    assert_eq!(m1.merge_branch_name.as_deref(), Some("feat"));

    // edge types: f1->c2 is Branch, m1->f2 is Merge, m1->c2 Direct
    assert!(edges.iter().any(|e| e.from == "f1" && e.to == "c2" && matches!(e.edge_type, EdgeType::Branch)));
    assert!(edges.iter().any(|e| e.from == "m1" && e.to == "f2" && matches!(e.edge_type, EdgeType::Merge)));
    assert!(edges.iter().any(|e| e.from == "m1" && e.to == "c2" && matches!(e.edge_type, EdgeType::Direct)));
}

#[test]
fn unmerged_branch_reaches_tip_without_merge_edge() {
    // main:  c1 -- c2
    //          \
    // feat:     f1 (tip, never merged)
    let mut commits = vec![
        commit("c1", 100, &[]),
        commit("c2", 200, &["c1"]),
        commit("f1", 250, &["c1"]),
    ];
    let seeds = [seed("main", "c2"), seed("feat", "f1")];
    let (lanes, edges, _) = compute_layout(&mut commits, &seeds, "main", Some("c2"));

    assert_eq!(lane_of(&commits, "f1"), "feat");
    assert_eq!(lane(&lanes, "feat").merged_into, None);
    assert!(!edges.iter().any(|e| matches!(e.edge_type, EdgeType::Merge)));
}

#[test]
fn branch_forked_from_another_branch() {
    // main:  c1
    //          \
    // base:     b1
    //             \
    // sub:         s1
    let mut commits = vec![
        commit("c1", 100, &[]),
        commit("b1", 200, &["c1"]),
        commit("s1", 300, &["b1"]),
    ];
    let seeds = [seed("main", "c1"), seed("base", "b1"), seed("sub", "s1")];
    let (lanes, _edges, _) = compute_layout(&mut commits, &seeds, "main", None);

    assert_eq!(lane_of(&commits, "b1"), "base");
    assert_eq!(lane_of(&commits, "s1"), "sub");
    assert_eq!(lane(&lanes, "sub").fork_point.as_deref(), Some("b1"));
    // fork annotation for "sub" lands on b1 (on the "base" lane)
    let b1 = commits.iter().find(|c| c.id == "b1").unwrap();
    assert_eq!(b1.fork_branch_name.as_deref(), Some("sub"));
}

#[test]
fn octopus_merge_produces_one_merge_edge_per_extra_parent() {
    // main:  c1 -------- m1
    //         \  \      /  /
    // a:       a1 -----   /
    // b:        \ b1 -----
    let mut commits = vec![
        commit("c1", 100, &[]),
        commit("a1", 200, &["c1"]),
        commit("b1", 250, &["c1"]),
        commit("m1", 300, &["c1", "a1", "b1"]),
    ];
    let seeds = [seed("main", "m1"), seed("a", "a1"), seed("b", "b1")];
    let (lanes, edges, _) = compute_layout(&mut commits, &seeds, "main", None);

    let merge_edges: Vec<_> = edges
        .iter()
        .filter(|e| e.from == "m1" && matches!(e.edge_type, EdgeType::Merge))
        .collect();
    assert_eq!(merge_edges.len(), 2);
    assert_eq!(lane(&lanes, "a").merged_into.as_deref(), Some("m1"));
    assert_eq!(lane(&lanes, "b").merged_into.as_deref(), Some("m1"));
}

#[test]
fn compression_marks_only_key_commits() {
    // main:  c1 -- c2 -- c3 -- c4(tip)
    //               \
    // feat:          f1 -- f2(tip, unmerged)
    // c3 is the only "boring" commit: no refs, no merge, same-lane parent
    // and child — it must NOT survive compression. Everything else is key.
    let mut commits = vec![
        commit("c1", 100, &[]),
        commit("c2", 200, &["c1"]),
        commit("c3", 300, &["c2"]),
        commit("c4", 400, &["c3"]),
        commit("f1", 250, &["c2"]),
        commit("f2", 350, &["f1"]),
    ];
    let seeds = [seed("main", "c4"), seed("feat", "f2")];
    let _ = compute_layout(&mut commits, &seeds, "main", Some("c4"));

    let key = |id: &str| commits.iter().find(|c| c.id == id).unwrap().is_key;
    assert!(key("c1"), "root = lane birth");
    assert!(key("c2"), "fork point");
    assert!(key("c4"), "lane tip + HEAD");
    assert!(key("f1"), "lane birth");
    assert!(key("f2"), "lane tip");
    assert!(!key("c3"), "boring middle commit must be compressed");
}

#[test]
fn lanes_sorted_by_birth_time() {
    // old forks sit closer to main (lane 1), late forks further out.
    // main:  c1 -- c2 -- c3
    //          \      \
    // early:    e1     \
    // late:             l1
    let mut commits = vec![
        commit("c1", 100, &[]),
        commit("e1", 150, &["c1"]),
        commit("c2", 200, &["c1"]),
        commit("c3", 300, &["c2"]),
        commit("l1", 350, &["c3"]),
    ];
    let seeds = [seed("main", "c3"), seed("early", "e1"), seed("late", "l1")];
    let (lanes, _, _) = compute_layout(&mut commits, &seeds, "main", None);

    assert_eq!(lane(&lanes, "early").lane_index, 1);
    assert_eq!(lane(&lanes, "late").lane_index, 2);
}

#[test]
fn anomalous_time_gap_is_folded() {
    // Two clusters 400 days apart: the empty range must collapse to ~120px
    // with one TimeGap recorded, instead of stretching the scene by 4000px.
    // (Commits inside a cluster sit 10 days apart so the 10px/day time scale
    // exceeds the 28px per-lane minimum spacing. a2/b1 are tagged to make
    // them key: the min-spacing cascade runs over key commits only, and
    // non-key commits get interpolated x positions instead.)
    let day = 86400;
    let mut commits = vec![
        commit("a1", 100 * day, &[]),
        commit("a2", 110 * day, &["a1"]),
        commit("b1", 510 * day, &["a2"]),
        commit("b2", 520 * day, &["b1"]),
    ];
    for id in ["a2", "b1"] {
        let c = commits.iter_mut().find(|c| c.id == id).unwrap();
        c.branch_refs.push(BranchRef {
            name: format!("tag-{id}"),
            is_remote: false,
            is_tag: true,
            color: String::new(),
        });
    }
    let (_lanes, _edges, gaps) =
        compute_layout(&mut commits, &[seed("main", "b2")], "main", Some("b2"));

    assert_eq!(gaps.len(), 1, "one folded gap expected");
    let g = &gaps[0];
    assert!(g.t_start >= 100 * day && g.t_end <= 520 * day);
    assert!((g.x_end - g.x_start - 120.0).abs() < 1e-6, "folded width must be 120px");

    let x_of = |id: &str| commits.iter().find(|c| c.id == id).unwrap().x;
    // Commits left of the gap keep their x; commits right of it are shifted
    // so the on-screen distance across the gap is exactly the folded width.
    assert!((x_of("b1") - x_of("a2") - 120.0).abs() < 1e-6);
    // Normal spacing inside each cluster is preserved.
    assert!((x_of("a2") - x_of("a1") - 100.0).abs() < 1e-6);
    assert!((x_of("b2") - x_of("b1") - 100.0).abs() < 1e-6);
}

#[test]
fn small_time_gap_is_not_folded() {
    // 10 days apart (100px) — below the 45-day threshold, no folding.
    let day = 86400;
    let mut commits = vec![
        commit("a1", 100 * day, &[]),
        commit("a2", 110 * day, &["a1"]),
    ];
    let (_lanes, _edges, gaps) =
        compute_layout(&mut commits, &[seed("main", "a2")], "main", Some("a2"));
    assert!(gaps.is_empty());
    let x_of = |id: &str| commits.iter().find(|c| c.id == id).unwrap().x;
    assert!((x_of("a2") - x_of("a1") - 100.0).abs() < 1e-6);
}
