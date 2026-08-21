//! Benchmark test against the official gmaster "tour" repository
//! (archived fork in docs/reference/gmaster-tour). This is the exact repo
//! gmaster's own Branch Explorer demo video renders, so it is the only
//! fixture with a known-good answer.
//!
//! Structure (short ids):
//!   master:               4a83ed3 → 9693351(merge ImageDiff) → 5f36bee(merge MoveMethod) → 2ae6485 (tip, HEAD)
//!   ImageDiff:            6d3b429 → e3d7642     fork@4a83ed3, merged@9693351
//!   Xdiff:                0b9acdc → 914dbf0     fork@4a83ed3, never merged
//!   MoveMethod:           5a91a10 → acf2461     fork@914dbf0 (branch-from-branch!), merged@5f36bee
//!   MoveToDifferentFile:  dbefb6e               fork@5f36bee, never merged
//!   ChangeGetTimeBetween: 3c6330a → bc3d3b4     fork@5f36bee, never merged
//!   ChangeImagenDst:      98a31d9               fork@6d3b429 (forks from ImageDiff's lane), never merged

use gtv_lib::git_reader::GitReader;
use gtv_lib::models::EdgeType;
use std::path::PathBuf;

fn tour_repo_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../docs/reference/gmaster-tour")
}

fn short(id: &str) -> &str {
    &id[..7]
}

#[test]
fn tour_repo_lane_ownership_matches_gmaster_ground_truth() {
    let mut reader = GitReader::new(tour_repo_path().to_str().unwrap()).expect("open tour repo");
    let data = reader.read_git_data(2000).expect("read git data").data;

    assert_eq!(data.commits.len(), 14, "tour repo has exactly 14 commits");
    assert_eq!(data.main_branch, "master");

    let owner = |short_id: &str| -> String {
        data.commits
            .iter()
            .find(|c| c.short_id == short_id)
            .unwrap_or_else(|| panic!("commit {short_id} missing"))
            .lane_owner
            .clone()
    };

    // master keeps its first-parent line — note 6d3b429 is NOT on it,
    // because merge 9693351's first parent is the root 4a83ed3.
    for id in ["4a83ed3", "9693351", "5f36bee", "2ae6485"] {
        assert_eq!(owner(id), "master", "commit {id}");
    }
    for id in ["6d3b429", "e3d7642"] {
        assert_eq!(owner(id), "ImageDiff", "commit {id}");
    }
    for id in ["0b9acdc", "914dbf0"] {
        assert_eq!(owner(id), "Xdiff", "commit {id}");
    }
    for id in ["5a91a10", "acf2461"] {
        assert_eq!(owner(id), "MoveMethod", "commit {id}");
    }
    assert_eq!(owner("dbefb6e"), "MoveToDifferentFile");
    assert_eq!(owner("3c6330a"), "ChangeGetTimeBetween");
    assert_eq!(owner("bc3d3b4"), "ChangeGetTimeBetween");
    assert_eq!(owner("98a31d9"), "ChangeImagenDst");

    // 7 lanes, no tag lanes (repo has no tags anyway), master on top.
    assert_eq!(data.branches.len(), 7);
    assert_eq!(data.branches[0].name, "master");
    assert!(data.branches.iter().all(|b| !b.is_tag));

    let lane = |name: &str| {
        data.branches
            .iter()
            .find(|b| b.name == name)
            .unwrap_or_else(|| panic!("lane {name} missing"))
    };

    // fork points
    assert_eq!(short(lane("ImageDiff").fork_point.clone().unwrap().as_str()), "4a83ed3");
    assert_eq!(short(lane("Xdiff").fork_point.clone().unwrap().as_str()), "4a83ed3");
    assert_eq!(short(lane("MoveMethod").fork_point.clone().unwrap().as_str()), "914dbf0");
    assert_eq!(short(lane("ChangeImagenDst").fork_point.clone().unwrap().as_str()), "6d3b429");
    assert_eq!(short(lane("MoveToDifferentFile").fork_point.clone().unwrap().as_str()), "5f36bee");
    assert_eq!(short(lane("ChangeGetTimeBetween").fork_point.clone().unwrap().as_str()), "5f36bee");
    assert_eq!(lane("master").fork_point, None);

    // merge targets
    assert_eq!(short(lane("ImageDiff").merged_into.clone().unwrap().as_str()), "9693351");
    assert_eq!(short(lane("MoveMethod").merged_into.clone().unwrap().as_str()), "5f36bee");
    assert_eq!(lane("Xdiff").merged_into, None);

    // merge annotations on merge commits
    let merge_label = |id: &str| {
        data.commits
            .iter()
            .find(|c| c.short_id == id)
            .and_then(|c| c.merge_branch_name.clone())
    };
    assert_eq!(merge_label("9693351").as_deref(), Some("ImageDiff"));
    assert_eq!(merge_label("5f36bee").as_deref(), Some("MoveMethod"));

    // fork annotation on the root mentions both lanes born there
    let root = data.commits.iter().find(|c| c.short_id == "4a83ed3").unwrap();
    let forks = root.fork_branch_name.clone().unwrap_or_default();
    assert!(forks.contains("ImageDiff"), "root forks: {forks}");
    assert!(forks.contains("Xdiff"), "root forks: {forks}");

    // edge typing
    let edge = |from: &str, to: &str| {
        data.edges
            .iter()
            .find(|e| short(&e.from) == from && short(&e.to) == to)
            .unwrap_or_else(|| panic!("edge {from}->{to} missing"))
    };
    assert!(matches!(edge("e3d7642", "6d3b429").edge_type, EdgeType::Direct));
    assert!(matches!(edge("0b9acdc", "4a83ed3").edge_type, EdgeType::Branch));
    assert!(matches!(edge("9693351", "e3d7642").edge_type, EdgeType::Merge));
    assert!(matches!(edge("9693351", "4a83ed3").edge_type, EdgeType::Direct));
    assert!(matches!(edge("5a91a10", "914dbf0").edge_type, EdgeType::Branch));
    assert!(matches!(edge("5f36bee", "acf2461").edge_type, EdgeType::Merge));

    // HEAD marker
    let heads: Vec<_> = data.commits.iter().filter(|c| c.is_head).collect();
    assert_eq!(heads.len(), 1);
    assert_eq!(heads[0].short_id, "2ae6485");
}

#[test]
fn tour_repo_filter_keeps_full_lineage() {
    let mut reader = GitReader::new(tour_repo_path().to_str().unwrap()).expect("open tour repo");
    let data = reader
        .filter_by_branches(&["MoveMethod".to_string()])
        .expect("filter")
        .data;

    // Walking from MoveMethod's tip reaches: its own 2 commits, Xdiff's 2,
    // and the root — 5 commits, not just the 1 commit the ref points at.
    assert_eq!(data.commits.len(), 5);
    assert!(data
        .commits
        .iter()
        .any(|c| c.lane_owner == "MoveMethod" && c.short_id == "acf2461"));
}
