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
        is_remote: false,
        ..LaneSeed::default()
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

#[test]
fn same_second_commits_order_topologically() {
    // A rebase rewrites a whole branch in one second: every commit gets
    // the SAME committer timestamp. The layout must still order the
    // chain parent→child left→right (the walk feeds newest-first, so a
    // plain stable sort would invert the tie group) and no two commits
    // may share an x (they would render as one stacked blob).
    // Input is intentionally newest-first, mimicking the revwalk order.
    let base = 1_000_000;
    let mut commits = vec![
        commit("r5", base, &["r4"]),
        commit("r4", base, &["r3"]),
        commit("r3", base, &["r2"]),
        commit("r2", base, &["r1"]),
        commit("r1", base, &["m1"]),
        commit("m1", base - 86400, &[]),
    ];
    let (lanes, _edges, _) =
        compute_layout(&mut commits, &[seed("feat", "r5"), seed("main", "m1")], "main", Some("m1"));

    let x_of = |id: &str| commits.iter().find(|c| c.id == id).unwrap().x;
    let ids = ["r1", "r2", "r3", "r4", "r5"];
    for w in ids.windows(2) {
        assert!(
            x_of(w[0]) < x_of(w[1]),
            "parent {} must sit left of child {}: {} vs {}",
            w[0],
            w[1],
            x_of(w[0]),
            x_of(w[1])
        );
    }
    // All five belong to the feat lane and sit right of the fork point.
    assert_eq!(lane(&lanes, "feat").fork_point.as_deref(), Some("m1"));
    for id in ids {
        assert_eq!(lane_of(&commits, id), "feat");
        assert!(x_of(id) > x_of("m1"));
    }
}

/// A ref-carrying commit no seed claimed (its branch is deselected in the
/// branch panel, but it entered the window through a merge from a selected
/// lane) must NOT be absorbed by the fake-main fallback — it renders
/// unattributed (""), and its unclaimed first-parent ancestry travels with
/// it instead of splitting onto the fallback lane.
#[test]
fn unselected_ref_tip_is_unattributed_not_absorbed() {
    fn with_refs(mut c: CommitNode, names: &[&str]) -> CommitNode {
        c.branch_refs = names
            .iter()
            .map(|n| BranchRef {
                name: n.to_string(),
                is_remote: true,
                is_tag: false,
                color: String::new(),
            })
            .collect();
        c
    }

    //   web:  b1 -> w1 -> w2                     (main_branch stand-in)
    //   pre:  b1 -> ph1 -> pm(merge t2) -> ptip
    //   tran:      b1 -> t1 -> t2 [ref]          (deselected branch)
    let mut commits = vec![
        commit("b1", 100, &[]),
        commit("w1", 110, &["b1"]),
        commit("w2", 120, &["w1"]),
        commit("ph1", 115, &["b1"]),
        commit("pm", 150, &["ph1", "t2"]),
        commit("ptip", 160, &["pm"]),
        with_refs(commit("t1", 130, &["b1"]), &[]),
        with_refs(commit("t2", 140, &["t1"]), &["origin/tran"]),
    ];
    // transfi is deselected: only web and pre seed the view. main_branch is
    // "web" — what detect_main_branch yields when main is not selected
    // (seeds.first()).
    let (lanes, edges, _) = compute_layout(
        &mut commits,
        &[seed("web", "w2"), seed("pre", "ptip")],
        "web",
        Some("w2"),
    );
    let _ = &lanes;

    assert_eq!(lane_of(&commits, "t2"), "", "ref tip must be unattributed");
    assert_eq!(lane_of(&commits, "t1"), "", "ancestry travels with the tip");
    assert_eq!(commits.iter().find(|c| c.id == "t2").unwrap().lane, 0);
    assert!(!commits.iter().find(|c| c.id == "t2").unwrap().is_key);
    assert_eq!(lane_of(&commits, "w2"), "web");
    assert_eq!(lane_of(&commits, "ptip"), "pre");
    // The merge stays on pre's lane and names the hidden lineage from its refs.
    assert_eq!(
        commits.iter().find(|c| c.id == "pm").unwrap().merge_branch_name,
        Some("tran".to_string())
    );
    assert_eq!(edge_types(&commits, &edges, "pm").len(), 2);
    assert!(matches!(
        edge_types(&commits, &edges, "pm")[..],
        [EdgeType::Direct, EdgeType::Merge]
    ));
}

/// Same graph with the branch selected: the tip claims its own lane and the
/// merge names it — the pre-fix full-view behaviour must be preserved.
#[test]
fn selected_ref_tip_claims_its_lane() {
    fn with_refs(mut c: CommitNode, names: &[&str]) -> CommitNode {
        c.branch_refs = names
            .iter()
            .map(|n| BranchRef {
                name: n.to_string(),
                is_remote: true,
                is_tag: false,
                color: String::new(),
            })
            .collect();
        c
    }
    let mut commits = vec![
        commit("b1", 100, &[]),
        commit("w1", 110, &["b1"]),
        commit("w2", 120, &["w1"]),
        commit("ph1", 115, &["b1"]),
        commit("pm", 150, &["ph1", "t2"]),
        commit("ptip", 160, &["pm"]),
        with_refs(commit("t1", 130, &["b1"]), &[]),
        with_refs(commit("t2", 140, &["t1"]), &["origin/tran"]),
    ];
    let (lanes, _edges, _) = compute_layout(
        &mut commits,
        &[seed("web", "w2"), seed("pre", "ptip"), seed("tran", "t2")],
        "web",
        Some("w2"),
    );
    assert_eq!(lane_of(&commits, "t2"), "tran");
    assert_eq!(lane_of(&commits, "t1"), "tran");
    assert!(lanes.iter().any(|l| l.name == "tran"));
    assert_eq!(
        commits.iter().find(|c| c.id == "pm").unwrap().merge_branch_name,
        Some("tran".to_string())
    );
}

/// Anonymous (ref-less) unclaimed lineage is foreign too: it belongs to no
/// rendered lane and is unattributed (hidden), never painted onto a lane it
/// was merely merged into.
#[test]
fn anonymous_unclaimed_lineage_is_unattributed() {
    let mut commits = vec![
        commit("b1", 100, &[]),
        commit("w1", 110, &["b1"]),
        commit("m", 130, &["w1", "s1"]),
        commit("w2", 140, &["w1"]),
        commit("s1", 120, &["b1"]),
    ];
    let (_, _edges, _) = compute_layout(&mut commits, &[seed("web", "w2")], "web", Some("w2"));
    assert_eq!(lane_of(&commits, "s1"), "");
    // No refs on the hidden parent, so the merge node names nothing.
    assert_eq!(
        commits.iter().find(|c| c.id == "m").unwrap().merge_branch_name,
        None
    );
}

/// R2 (merge destination first): feature forked out of develop mid-way and
/// its tip was merged back into develop; feature's tip is NEWER than
/// develop's. The merge record must order develop before feature, so the
/// shared segment (d1) belongs to develop and feature's fork point lands on
/// develop's lane. The old unconditional merged-source-first rule inverted
/// exactly this (feature claimed d1, develop forked off feature).
#[test]
fn merge_destination_claims_shared_history() {
    // main:     c1
    //              \
    // develop:      d1 -- d2 -- m1(tip)
    //                 \         /
    // feature:         f1 -- f2(tip, newer than m1)
    let mut commits = vec![
        commit("c1", 100, &[]),
        commit("d1", 200, &["c1"]),
        commit("f1", 300, &["d1"]),
        commit("d2", 350, &["d1"]),
        commit("m1", 360, &["d2", "f2"]),
        commit("f2", 400, &["f1"]),
    ];
    let seeds = [seed("main", "c1"), seed("develop", "m1"), seed("feature", "f2")];
    let (lanes, _edges, _) = compute_layout(&mut commits, &seeds, "main", None);

    assert_eq!(lane_of(&commits, "d1"), "develop", "shared segment belongs to the merge destination");
    assert_eq!(lane_of(&commits, "d2"), "develop");
    assert_eq!(lane_of(&commits, "m1"), "develop");
    assert_eq!(lane_of(&commits, "f1"), "feature");
    assert_eq!(lane_of(&commits, "f2"), "feature");
    assert_eq!(lane(&lanes, "feature").fork_point.as_deref(), Some("d1"));
    assert_eq!(lane(&lanes, "develop").fork_point.as_deref(), Some("c1"));
    assert_eq!(lane_of(&commits, "c1"), "main");
}

/// The merged-tip soft class still beats newest-tip-first when there is no
/// counter-evidence: Y merged into main, Z forked out of Y mid-way, Z's tip
/// is newer. Y must keep its shared history (Z must not steal y1).
#[test]
fn merged_branch_keeps_history_against_newer_unmerged_fork() {
    // main:  c1 -------- mY -- m2(tip)
    //          \        /
    // Y:        y1 -- y2(tip)
    //            \
    // Z:          z1(tip, newer than y2)
    let mut commits = vec![
        commit("c1", 100, &[]),
        commit("y1", 200, &["c1"]),
        commit("y2", 300, &["y1"]),
        commit("mY", 350, &["c1", "y2"]),
        commit("m2", 360, &["mY"]),
        commit("z1", 400, &["y1"]),
    ];
    let seeds = [seed("main", "m2"), seed("Y", "y2"), seed("Z", "z1")];
    let (lanes, _edges, _) = compute_layout(&mut commits, &seeds, "main", None);

    assert_eq!(lane_of(&commits, "y1"), "Y");
    assert_eq!(lane_of(&commits, "y2"), "Y");
    assert_eq!(lane_of(&commits, "z1"), "Z");
    assert_eq!(lane(&lanes, "Z").fork_point.as_deref(), Some("y1"));
}

/// Ancestor-tip protection: P's tip lies on C's first-parent chain. Even
/// though C's tip is newer (so C claims first under the soft key now that
/// the R1 ordering rule is removed), C's walk must stop at p1 — the tip
/// wall alone covers this: a non-main walk never claims through another
/// lane's tip, regardless of seed order. C's fork point is P's tip on P's
/// lane.
#[test]
fn ancestor_seed_claims_before_descendant() {
    // main:  c1
    //          \
    // P:        p1(tip)
    //             \
    // C:           s1 -- s2(tip)
    let mut commits = vec![
        commit("c1", 100, &[]),
        commit("p1", 200, &["c1"]),
        commit("s1", 300, &["p1"]),
        commit("s2", 400, &["s1"]),
    ];
    let seeds = [seed("main", "c1"), seed("P", "p1"), seed("C", "s2")];
    let (lanes, _edges, _) = compute_layout(&mut commits, &seeds, "main", None);

    assert_eq!(lane_of(&commits, "p1"), "P");
    assert_eq!(lane_of(&commits, "s1"), "C");
    assert_eq!(lane_of(&commits, "s2"), "C");
    assert_eq!(lane(&lanes, "C").fork_point.as_deref(), Some("p1"));
    assert_eq!(lane(&lanes, "P").fork_point.as_deref(), Some("c1"));
    let p1 = commits.iter().find(|c| c.id == "p1").unwrap();
    assert_eq!(p1.fork_branch_name.as_deref(), Some("C"));
}

/// Regression for the R1-removal bug (5b860a3): release/x points at m3, an
/// ancestor commit ON main's first-parent chain (a fast-forwarded branch).
/// Ordered before main by the old R1 edge, it walked down the mainline and
/// stole m1..m3; main's lane started mid-life at m4 with a fork point.
/// Main must claim first and own the whole chain; release/x is zero-length
/// (no lane), and feat/f forks off the main lane.
#[test]
fn ancestor_tip_branch_does_not_steal_mainline() {
    // main:       m1 -- m2 -- m3 -- m4 -- m5 -- m6(tip)
    // release/x:             ^tip
    // feat/f:                            \ f1(tip)
    let mut commits = vec![
        commit("m1", 100, &[]),
        commit("m2", 200, &["m1"]),
        commit("m3", 300, &["m2"]),
        commit("m4", 400, &["m3"]),
        commit("m5", 500, &["m4"]),
        commit("m6", 600, &["m5"]),
        commit("f1", 550, &["m5"]),
    ];
    let seeds = [
        seed("main", "m6"),
        seed("release/x", "m3"),
        seed("feat/f", "f1"),
    ];
    let (lanes, _edges, _) = compute_layout(&mut commits, &seeds, "main", Some("m6"));

    assert_eq!(lane(&lanes, "main").lane_index, 0);
    for id in ["m1", "m2", "m3", "m4", "m5", "m6"] {
        assert_eq!(lane_of(&commits, id), "main", "{id} must stay on main");
    }
    assert!(
        !lanes.iter().any(|l| l.name == "release/x"),
        "a zero-length ancestor-tip branch must not form a lane"
    );
    let feat = lane(&lanes, "feat/f");
    assert_eq!(feat.fork_point.as_deref(), Some("m5"));
    assert_eq!(lane_of(&commits, "m5"), "main", "feat/f's fork point must render on main");
    assert_eq!(lane_of(&commits, "f1"), "feat/f");
}

/// A lane seeded with an extra upstream tip (local main behind origin/main)
/// claims the upstream-only region as its own: a side branch forked out of
/// that region forks off the main lane, and the upstream merge/top commits
/// belong to main — not to whichever side branch's first-parent chain
/// passes through.
#[test]
fn extra_tip_claims_upstream_only_history() {
    // main:   m1 -- m2 (local tip)
    //                \
    // side:           s1
    //                  \
    // origin/main:     m3(merge) -- m4 (extra tip)
    //                    \
    // F:                  f1(tip)
    let mut commits = vec![
        commit("m1", 100, &[]),
        commit("m2", 200, &["m1"]),
        commit("s1", 250, &["m2"]),
        commit("m3", 300, &["m2", "s1"]),
        commit("m4", 400, &["m3"]),
        commit("f1", 350, &["m3"]),
    ];
    let main = LaneSeed {
        name: "main".to_string(),
        tip: "m2".to_string(),
        is_remote: false,
        extra_tips: vec!["m4".to_string()],
    };
    let seeds = [main, seed("F", "f1")];
    let (lanes, _edges, _) = compute_layout(&mut commits, &seeds, "main", None);

    assert_eq!(lane_of(&commits, "m3"), "main");
    assert_eq!(lane_of(&commits, "m4"), "main");
    assert_eq!(lane_of(&commits, "m2"), "main");
    assert_eq!(lane_of(&commits, "f1"), "F");
    assert_eq!(lane(&lanes, "F").fork_point.as_deref(), Some("m3"));
    // The merged-in side lineage has no seed of its own: unattributed.
    assert_eq!(lane_of(&commits, "s1"), "");
}
