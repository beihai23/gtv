//! Pagination: `read_git_data` returns the newest `limit` commits and
//! `load_more` pages in older history chunk by chunk (hiding everything
//! already loaded). The paged end state must equal a single full walk,
//! the loaded set must stay downward-closed at every step (a loaded
//! commit's children are all loaded, so lane chains never dangle), and
//! stale branches (tips outside the window) must stay excluded when their
//! seeds are removed from the continuation walk.

use gtv_lib::git_reader::GitReader;
use gtv_lib::models::GitData;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Command;

/// Run git in `dir`. Identity/gpg overrides are passed inline so the test
/// works on machines with no global git config (or with commit.gpgsign on).
/// `date` pins author+committer dates so commit order is deterministic.
fn git(dir: &Path, args: &[&str], date: &str) {
    let status = Command::new("git")
        .args([
            "-c",
            "user.name=gtv",
            "-c",
            "user.email=gtv@gtv.local",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .env("GIT_AUTHOR_DATE", date)
        .env("GIT_COMMITTER_DATE", date)
        .current_dir(dir)
        .status()
        .expect("failed to spawn git");
    assert!(status.success(), "git {:?} failed", args);
}

fn git_sha(dir: &Path, rev: &str) -> String {
    let out = Command::new("git")
        .args(["rev-parse", rev])
        .current_dir(dir)
        .output()
        .expect("failed to spawn git rev-parse");
    assert!(out.status.success());
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

fn commit(dir: &Path, msg: &str, date: &str) {
    git(dir, &["commit", "--allow-empty", "-m", msg], date);
}

fn day(day: u32) -> String {
    format!("2020-01-{:02}T00:00:00+00:00", day)
}

/// Fixture (30 commits, all timestamps distinct):
///   main:  c1..c20 (Jan 1..20) -> c21..c25 (Jan 21..25) -> m1 (Mar 1)
///   side:  forked at c20, s1..s3 (Feb 1..3), merged into main as m1
///   stale: forked at c2, one commit st1 (Jan 5) — tip far outside any
///          small window, and unreachable from main/side.
fn build_fixture(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).expect("create temp dir");

    git(dir, &["init", "-b", "main"], &day(1));
    for i in 1..=20 {
        commit(dir, &format!("c{}", i), &day(i));
    }
    let c2 = git_sha(dir, "HEAD~18");
    let c20 = git_sha(dir, "HEAD");

    git(dir, &["checkout", "-b", "stale", &c2], &day(3));
    commit(dir, "st1", "2020-01-05T00:00:00+00:00");

    git(dir, &["checkout", "main"], &day(4));
    git(dir, &["checkout", "-b", "side", &c20], &day(4));
    for (i, d) in ["2020-02-01", "2020-02-02", "2020-02-03"].iter().enumerate() {
        commit(dir, &format!("s{}", i + 1), &format!("{}T00:00:00+00:00", d));
    }

    git(dir, &["checkout", "main"], &day(20));
    for i in 21..=25 {
        commit(dir, &format!("c{}", i), &day(i));
    }
    git(
        dir,
        &["merge", "--no-ff", "side", "-m", "m1"],
        "2020-03-01T00:00:00+00:00",
    );
}

/// Page through the whole history in chunks of `limit`, starting from
/// `first`, following the given seeds. Asserts no duplicates and
/// downward-closure after every chunk.
fn paginate(reader: &mut GitReader, first: GitData, seeds: &[gtv_lib::layout::LaneSeed], limit: usize) -> GitData {
    // Reference universe = everything reachable from the SAME seeds (an
    // unrestricted load_more). It must not contain commits the paginating
    // seeds can never reach (e.g. an excluded stale branch's tip), or the
    // closure assertion below would fire on intentionally-unloaded commits.
    let full = reader
        .load_more(seeds, &HashSet::new(), Vec::new(), 1000)
        .expect("reference walk");

    let mut data = first;
    let mut guard = 0;
    while data.has_more {
        guard += 1;
        assert!(guard < 20, "pagination must terminate");

        let seen: HashSet<String> = data.commits.iter().map(|c| c.id.clone()).collect();
        data = reader
            .load_more(seeds, &seen, data.commits, limit)
            .expect("load_more");

        // No duplicates across chunk boundaries.
        let mut ids: HashSet<&str> = HashSet::new();
        for c in &data.commits {
            assert!(ids.insert(c.id.as_str()), "duplicate commit {}", c.short_id);
        }

        // Downward closure: a loaded commit's children are all loaded.
        // (Equivalently: every loaded parent link's child is present.)
        for o in &full.commits {
            for p in &o.parents {
                if ids.contains(p.as_str()) {
                    assert!(
                        ids.contains(o.id.as_str()),
                        "loaded commit {} has unloaded child {}",
                        p,
                        o.short_id
                    );
                }
            }
        }
    }
    data
}

fn owners(data: &GitData) -> HashMap<&str, &str> {
    data.commits
        .iter()
        .map(|c| (c.id.as_str(), c.lane_owner.as_str()))
        .collect()
}

#[test]
fn paged_result_equals_full_walk() {
    let dir = std::env::temp_dir().join(format!("gtv-pagination-{}", std::process::id()));
    build_fixture(&dir);

    let mut reader = GitReader::new(dir.to_str().unwrap()).expect("open fixture");

    let first = reader.read_git_data(10).expect("first chunk");
    assert_eq!(first.data.commits.len(), 10);
    assert!(first.data.has_more, "29 more commits are still out there");
    assert_eq!(
        first.stale_names,
        vec!["stale".to_string()],
        "only the stale branch's tip is outside the first window"
    );

    let paged = paginate(&mut reader, first.data, &first.seeds, 10);
    assert_eq!(paged.commits.len(), 30);
    assert!(!paged.has_more);

    let full = reader.read_git_data(1000).expect("full walk").data;
    assert_eq!(full.commits.len(), 30);

    // Core correctness claim: paging in chunks produces the same lane
    // ownership and the same lane list as walking everything at once.
    assert_eq!(owners(&paged), owners(&full));
    let paged_lanes: Vec<&str> = paged.branches.iter().map(|b| b.name.as_str()).collect();
    let full_lanes: Vec<&str> = full.branches.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(paged_lanes, full_lanes);

    // The stale branch was reached while paging and got its own lane.
    let st1 = paged
        .commits
        .iter()
        .find(|c| c.message == "st1")
        .expect("st1 loaded");
    assert_eq!(st1.lane_owner, "stale");

    std::fs::remove_dir_all(&dir).expect("clean up temp dir");
}

#[test]
fn excluded_stale_seed_is_never_loaded() {
    let dir = std::env::temp_dir().join(format!("gtv-pagination-stale-{}", std::process::id()));
    build_fixture(&dir);

    let mut reader = GitReader::new(dir.to_str().unwrap()).expect("open fixture");

    let first = reader.read_git_data(10).expect("first chunk");
    // Simulate include_stale=false: drop stale seeds from the session.
    let kept: Vec<_> = first
        .seeds
        .iter()
        .filter(|s| !first.stale_names.contains(&s.name))
        .cloned()
        .collect();
    assert_eq!(kept.len(), first.seeds.len() - 1);

    let paged = paginate(&mut reader, first.data, &kept, 10);

    // st1 is reachable only through the stale tip: without that seed it
    // never enters the walk, and no "stale" lane is ever created.
    assert_eq!(paged.commits.len(), 29);
    assert!(paged.commits.iter().all(|c| c.message != "st1"));
    assert!(paged.branches.iter().all(|b| b.name != "stale"));
    assert!(!paged.has_more);

    std::fs::remove_dir_all(&dir).expect("clean up temp dir");
}
