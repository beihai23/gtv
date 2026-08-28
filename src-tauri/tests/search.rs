//! Full-history commit search: case-insensitive substring match on commit
//! subject or author name (plus commit-id prefix for hex queries), newest
//! first, capped at `limit`. `in_view` flags membership in the caller's
//! loaded window (pagination session).

use gtv_lib::git_reader::GitReader;
use std::collections::HashSet;
use std::path::Path;
use std::process::Command;

fn git(dir: &Path, args: &[&str], date: &str) {
    let status = Command::new("git")
        .args(["-c", "user.email=gtv@gtv.local", "-c", "commit.gpgsign=false"])
        .args(args)
        .env("GIT_AUTHOR_DATE", date)
        .env("GIT_COMMITTER_DATE", date)
        .current_dir(dir)
        .status()
        .expect("failed to spawn git");
    assert!(status.success(), "git {:?} failed", args);
}

/// Commit with an explicit author (the default helper pins gtv; tests need
/// distinct authors to exercise author matching).
fn commit_as(dir: &Path, author: &str, msg: &str, date: &str) {
    git(
        dir,
        &[
            "-c", &format!("user.name={}", author),
            "commit", "--allow-empty", "-m", msg,
        ],
        date,
    );
}

fn commit(dir: &Path, msg: &str, date: &str) {
    commit_as(dir, "gtv", msg, date);
}

fn day(day: u32) -> String {
    format!("2020-01-{:02}T00:00:00+00:00", day)
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

/// main: c1..c6 (Jan 1..6). Mixed-case subjects and authors on purpose.
fn build_fixture(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).expect("create temp dir");
    git(dir, &["init", "-b", "main"], &day(1));
    commit(dir, "c1 initial import", &day(1));
    commit_as(dir, "Alice", "Fix Login Bug", &day(2));
    commit_as(dir, "alice", "add settings page", &day(3));
    commit(dir, "c4 refactor core", &day(4));
    commit_as(dir, "Bob", "fix login timeout", &day(5));
    commit(dir, "c6 release notes", &day(6));
}

#[test]
fn search_matches_subject_and_author_case_insensitively() {
    let dir = std::env::temp_dir().join(format!("gtv-search-{}", std::process::id()));
    build_fixture(&dir);
    let reader = GitReader::new(dir.to_str().unwrap()).expect("open fixture");
    let empty = HashSet::new();

    // Subject match, mixed case both directions.
    let hits = reader.search_commits("login", 50, &empty).expect("search");
    let msgs: Vec<&str> = hits.iter().map(|h| h.message.as_str()).collect();
    assert_eq!(msgs.len(), 2, "Fix Login Bug + fix login timeout: {:?}", msgs);

    // Author match (case-insensitive): Alice and alice are distinct strings.
    let hits = reader.search_commits("alice", 50, &empty).expect("search");
    assert_eq!(hits.len(), 2);
    assert!(hits.iter().all(|h| h.author_name.to_lowercase() == "alice"));

    // No match -> empty.
    assert!(reader.search_commits("zzz-nothing", 50, &empty).unwrap().is_empty());

    std::fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn search_returns_newest_first_and_respects_limit() {
    let dir = std::env::temp_dir().join(format!("gtv-search-limit-{}", std::process::id()));
    build_fixture(&dir);
    let reader = GitReader::new(dir.to_str().unwrap()).expect("open fixture");
    let empty = HashSet::new();

    // "c" matches 3 subjects (c1, c4, c6) + 2 authors (Alice, alice) = 5 hits.
    let all = reader.search_commits("c", 50, &empty).expect("search");
    assert_eq!(all.len(), 5);
    // Walk order is TIME|TOPO newest-first, so hits are newest-first.
    let ts: Vec<i64> = all.iter().map(|h| h.timestamp).collect();
    let mut sorted = ts.clone();
    sorted.sort_by(|a, b| b.cmp(a));
    assert_eq!(ts, sorted);

    let capped = reader.search_commits("c", 2, &empty).expect("search");
    assert_eq!(capped.len(), 2);
    assert_eq!(capped[0].timestamp, all[0].timestamp, "capped keeps the newest");

    std::fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn search_hash_prefix_and_in_view_flag() {
    let dir = std::env::temp_dir().join(format!("gtv-search-hash-{}", std::process::id()));
    build_fixture(&dir);
    let mut reader = GitReader::new(dir.to_str().unwrap()).expect("open fixture");

    let c1 = git_sha(&dir, "HEAD~5");
    let prefix = &c1[..6];

    // Hash prefix (>=4 hex) finds the commit even with no text match.
    let empty = HashSet::new();
    let hits = reader.search_commits(prefix, 50, &empty).expect("search");
    assert!(hits.iter().any(|h| h.id == c1), "prefix {} must hit c1", prefix);

    // in_view: open a small window (newest 3 = c6 / timeout / c4), then
    // search "c" (5 hits) -- the window's 2 matching commits (c6, c4) are
    // in_view; c1, Alice's commit, and alice's commit are not.
    let window = reader.read_git_data(3).expect("open window");
    let loaded: HashSet<String> = window.data.commits.iter().map(|c| c.id.clone()).collect();
    let hits = reader.search_commits("c", 50, &loaded).expect("search");
    assert_eq!(hits.len(), 5);
    let in_view_count = hits.iter().filter(|h| h.in_view).count();
    assert_eq!(in_view_count, 2, "exactly the window's 2 matching commits are in_view");
    assert_eq!(hits.iter().filter(|h| !h.in_view).count(), 3);
    assert!(hits.iter().any(|h| !h.in_view && h.id == c1), "c1 must be out-of-view");

    std::fs::remove_dir_all(&dir).expect("clean up");
}

#[test]
fn search_speed_on_thousand_commits() {
    // Smoke-level speed guard for the 2s acceptance budget (backend part):
    // a full walk over 1000 commits with per-commit lowercase matching
    // should stay far below 500ms even on debug builds in CI-like noise.
    let dir = std::env::temp_dir().join(format!("gtv-search-speed-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create temp dir");
    git(&dir, &["init", "-b", "main"], &day(1));
    for i in 0..1000 {
        commit(&dir, &format!("commit number {}", i), &day(1 + i / 100));
    }
    let reader = GitReader::new(dir.to_str().unwrap()).expect("open fixture");
    let empty = HashSet::new();

    let start = std::time::Instant::now();
    let hits = reader.search_commits("commit", 50, &empty).expect("search");
    let elapsed = start.elapsed();
    assert_eq!(hits.len(), 50, "caps at limit");
    assert!(
        elapsed.as_millis() < 500,
        "search took {:?} -- over the 500ms smoke budget",
        elapsed
    );

    std::fs::remove_dir_all(&dir).expect("clean up");
}
