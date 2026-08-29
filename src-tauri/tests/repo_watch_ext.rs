//! Repo watching (embedded-terminal support): a commit inside the watched
//! repo must reach the callback within seconds, bursts must collapse via
//! the 300ms quiet-period debouncer, and a MAIN-repo commit must be seen by
//! a watch armed from a linked worktree (commondir coverage).

use gtv_lib::repo_watch::watch;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Run git in `dir`. Identity/gpg overrides are passed inline so the test
/// works on machines with no global git config (or with commit.gpgsign on).
/// Mirrors tests/pagination.rs.
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

fn commit(dir: &Path, msg: &str, date: &str) {
    git(dir, &["commit", "--allow-empty", "-m", msg], date);
}

fn day(day: u32) -> String {
    format!("2020-01-{:02}T00:00:00+00:00", day)
}

/// Temp repo with one base commit; returns its path.
fn temp_repo(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("gtv-watch-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create temp dir");
    git(&dir, &["init", "-b", "main"], &day(1));
    commit(&dir, "base", &day(1));
    dir
}

/// Wait until `count` exceeds `baseline`, or fail after `secs`.
fn wait_for_increase(count: &Arc<AtomicUsize>, baseline: usize, secs: u64, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if count.load(Ordering::SeqCst) > baseline {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("{}: no watch event (baseline {})", what, baseline);
}

/// Let the freshly armed watcher settle: FSEvents on macOS can replay
/// stream-bootstrap events, so the pre-commit baseline is read AFTER this.
fn settle() {
    std::thread::sleep(Duration::from_millis(700));
}

#[test]
fn commit_in_watched_repo_fires_callback() {
    let dir = temp_repo("basic");
    let count = Arc::new(AtomicUsize::new(0));
    let count2 = count.clone();
    let _guard = watch(
        dir.to_str().unwrap(),
        Box::new(move || {
            count2.fetch_add(1, Ordering::SeqCst);
        }),
    )
    .expect("watch");

    settle();
    let baseline = count.load(Ordering::SeqCst);

    commit(&dir, "c1", &day(2));
    wait_for_increase(&count, baseline, 10, "commit not observed");
}

/// Five commits issued back to back must collapse to at least 1 and at most
/// 4 callbacks (the debouncer merges a burst; the loose upper bound only
/// guards against an un-debounced event-per-commit regression — 5 would
/// mean every filesystem touch fired through).
#[test]
fn commit_burst_debounces_into_few_callbacks() {
    let dir = temp_repo("burst");
    let count = Arc::new(AtomicUsize::new(0));
    let count2 = count.clone();
    let _guard = watch(
        dir.to_str().unwrap(),
        Box::new(move || {
            count2.fetch_add(1, Ordering::SeqCst);
        }),
    )
    .expect("watch");

    settle();
    let baseline = count.load(Ordering::SeqCst);

    for i in 1..=5 {
        commit(&dir, &format!("b{}", i), &day(2 + i));
    }
    wait_for_increase(&count, baseline, 10, "burst produced no event");
    // Let the trailing quiet period (300ms) and any straggler events land.
    std::thread::sleep(Duration::from_millis(1500));

    let events = count.load(Ordering::SeqCst) - baseline;
    assert!(
        events >= 1 && events <= 4,
        "expected 1..=4 debounced callbacks for 5 commits, got {}",
        events
    );
}

/// A watch armed from a LINKED WORKTREE must also observe commits made in
/// the main repository: refs live under the common .git dir, which
/// git_dirs() must include (not just the per-worktree gitdir).
#[test]
fn main_repo_commit_seen_by_worktree_watch() {
    let main = temp_repo("wt-main");
    let wt = std::env::temp_dir().join(format!(
        "gtv-watch-wt-tree-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&wt);
    git(
        &main,
        &[
            "worktree",
            "add",
            wt.to_str().unwrap(),
            "-b",
            "side",
        ],
        &day(3),
    );

    let count = Arc::new(AtomicUsize::new(0));
    let count2 = count.clone();
    let _guard = watch(
        wt.to_str().unwrap(),
        Box::new(move || {
            count2.fetch_add(1, Ordering::SeqCst);
        }),
    )
    .expect("watch from worktree");

    settle();
    let baseline = count.load(Ordering::SeqCst);

    // Commit in the MAIN repo (branch main) — updates .git/refs/heads/main
    // in the shared common dir.
    commit(&main, "main-side-commit", &day(4));
    wait_for_increase(&count, baseline, 10, "worktree watch missed main commit");
}
