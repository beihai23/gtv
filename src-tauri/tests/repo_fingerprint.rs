//! `GitReader::change_fingerprint` — the repo-watcher's change signal.
//! It must move exactly when the committed repo state moves (commit,
//! branch/tag create, checkout incl. detached) and stay put otherwise
//! (re-reading, working-tree noise like untracked files — the timeline
//! only renders committed history).

use gtv_lib::git_reader::GitReader;
use std::path::Path;
use std::process::Command;

/// Same fixture style as tests/pagination.rs: inline identity overrides so
/// the test works without global git config, pinned dates for determinism.
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

fn fingerprint(dir: &Path) -> String {
    GitReader::new(dir.to_str().expect("temp dir must be valid UTF-8"))
        .expect("repo open failed")
        .change_fingerprint()
        .expect("fingerprint failed")
}

/// One fixture directory per test (cargo runs them in parallel threads).
fn build_fixture(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("gtv-fp-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("failed to create temp dir");
    git(&dir, &["init", "--initial-branch=main"], "2020-01-01T00:00:00+00:00");
    git(&dir, &["commit", "--allow-empty", "-m", "c1"], "2020-01-01T00:00:00+00:00");
    git(&dir, &["commit", "--allow-empty", "-m", "c2"], "2020-01-02T00:00:00+00:00");
    dir
}

const DAY: &str = "2020-01-03T00:00:00+00:00";

#[test]
fn fingerprint_is_stable_across_reads() {
    let dir = build_fixture("stable");
    assert_eq!(fingerprint(&dir), fingerprint(&dir));
}

#[test]
fn fingerprint_moves_on_commit() {
    let dir = build_fixture("commit");
    let before = fingerprint(&dir);
    git(&dir, &["commit", "--allow-empty", "-m", "c3"], DAY);
    assert_ne!(before, fingerprint(&dir));
}

#[test]
fn fingerprint_moves_on_branch_and_tag_creation() {
    let dir = build_fixture("branch_tag");
    let before = fingerprint(&dir);
    git(&dir, &["branch", "feature"], DAY);
    let after_branch = fingerprint(&dir);
    assert_ne!(before, after_branch);
    git(&dir, &["tag", "v1"], DAY);
    assert_ne!(after_branch, fingerprint(&dir));
}

#[test]
fn fingerprint_moves_on_checkout_between_branch_names() {
    // Same oid, different symbolic HEAD — the fingerprint includes the HEAD
    // name precisely so branch switches are caught even when they move HEAD
    // to an oid some branch already points at.
    let dir = build_fixture("checkout_names");
    git(&dir, &["branch", "twin-at-main"], DAY);
    let before = fingerprint(&dir);
    git(&dir, &["checkout", "twin-at-main"], DAY);
    assert_ne!(before, fingerprint(&dir));
}

#[test]
fn fingerprint_moves_on_detached_checkout() {
    let dir = build_fixture("detached");
    let before = fingerprint(&dir);
    git(&dir, &["checkout", "--detach", "HEAD~1"], DAY);
    assert_ne!(before, fingerprint(&dir));
}

#[test]
fn fingerprint_ignores_working_tree_noise() {
    let dir = build_fixture("noise");
    let before = fingerprint(&dir);
    std::fs::write(dir.join("untracked.txt"), "noise").expect("write failed");
    git(&dir, &["status", "--porcelain"], DAY); // touches nothing committed
    std::fs::write(dir.join("untracked-2.txt"), "more noise").expect("write failed");
    assert_eq!(before, fingerprint(&dir));
}
