//! Multi-repo session registry (spec 4.1/4.2): repo_id routing keeps
//! sessions independent, open_repository dedupes on the canonical path
//! (same path, symlink, already-open reactivation without touching the
//! session), worktree families enumerate identically from both ends,
//! close/active behave, and the watcher's pure fingerprint diff reports
//! exactly the moved repos.

use gtv_lib::commands::{
    close_repository_impl, filter_by_branches_impl, get_commit_detail_impl, jump_to_commit_impl,
    load_older_commits_impl, open_repository_impl, set_active_repository_impl, AppState,
};
use gtv_lib::git_reader::GitReader;
use gtv_lib::watcher::diff_fingerprints;
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;

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

/// Drive an async *_impl on a throwaway runtime (the impls use
/// spawn_blocking, so they need a tokio context, never a tauri one).
fn run<F: std::future::Future>(fut: F) -> F::Output {
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(fut)
}

/// Fixture with two branches: main (m1..m3) and feat (f1, forked at m2).
/// `tag` brands the commit messages so cross-repo assertions can tell the
/// fixtures apart. One directory per test+tag (cargo runs tests in
/// parallel threads).
fn build_repo(name: &str, tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("gtv-multi-{}-{}-{}", name, tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create temp dir");
    git(&dir, &["init", "-b", "main"], &day(1));
    commit(&dir, &format!("m1-{}", tag), &day(1));
    commit(&dir, &format!("m2-{}", tag), &day(2));
    git(&dir, &["checkout", "-b", "feat"], &day(2));
    commit(&dir, &format!("f1-{}", tag), &day(3));
    git(&dir, &["checkout", "main"], &day(4));
    commit(&dir, &format!("m3-{}", tag), &day(4));
    dir
}

fn open(state: &AppState, path: &Path) -> gtv_lib::models::OpenedRepo {
    run(open_repository_impl(
        state,
        path.to_str().expect("temp dir must be valid UTF-8").to_string(),
        true,
    ))
    .expect("open repository")
}

#[test]
fn two_repos_open_independently_and_route_by_id() {
    let dir_a = build_repo("two", "a");
    let dir_b = build_repo("two", "b");
    let state = AppState::default();

    let a = open(&state, &dir_a);
    let b = open(&state, &dir_b);

    assert_ne!(a.repo_id, b.repo_id);
    assert!(!a.already_open);
    assert!(!b.already_open);
    assert_eq!(a.data.commits.len(), 4);
    assert_eq!(b.data.commits.len(), 4);

    // Each detail query routes to its own repo: A's HEAD is A's commit,
    // and B (a different repository) has no such object at all — the git
    // NotFound error, not a routing failure.
    let head_a = a
        .data
        .commits
        .iter()
        .find(|c| c.is_head)
        .expect("HEAD commit in a")
        .id
        .clone();
    let detail = run(get_commit_detail_impl(&state, a.repo_id, head_a.clone())).expect("detail in a");
    assert_eq!(detail.message, "m3-a");
    // Routing must succeed and B's object store must answer the NotFound:
    // the git-layer error, not a "No repository opened" routing failure.
    assert!(
        run(get_commit_detail_impl(&state, b.repo_id, head_a))
            .unwrap_err()
            .contains("Failed to find commit"),
        "B is a different repository: A's commit must not resolve there"
    );

    std::fs::remove_dir_all(&dir_a).expect("clean up temp dir");
    std::fs::remove_dir_all(&dir_b).expect("clean up temp dir");
}

#[test]
fn filter_and_jump_stay_scoped_to_their_repo() {
    let dir_a = build_repo("isolation", "a");
    let dir_b = build_repo("isolation", "b");
    let state = AppState::default();
    let a = open(&state, &dir_a);
    let b = open(&state, &dir_b);

    // A: view narrowed to the main branch's lineage (f1 gone).
    let filtered =
        run(filter_by_branches_impl(&state, a.repo_id, vec!["main".to_string()])).expect("filter a");
    assert_eq!(filtered.commits.len(), 3);
    assert!(filtered.commits.iter().all(|c| c.message != "f1-a"));

    // B: jump to m2 narrows B to that ancestry. A must not feel it.
    let m2_b = b
        .data
        .commits
        .iter()
        .find(|c| c.message == "m2-b")
        .expect("m2 in b")
        .id
        .clone();
    let jumped = run(jump_to_commit_impl(&state, b.repo_id, m2_b)).expect("jump b");
    assert_eq!(jumped.commits.len(), 2);

    // A's session survived B's jump: load_older on A returns A's CURRENT
    // (filtered) view, still without f1-a.
    let a_now = run(load_older_commits_impl(&state, a.repo_id)).expect("load older a");
    let mut msgs: Vec<&str> = a_now.commits.iter().map(|c| c.message.as_str()).collect();
    msgs.sort();
    assert_eq!(msgs, vec!["m1-a", "m2-a", "m3-a"]);

    // And B's view survived A's filter (still the two-commit jump view).
    let b_now = run(load_older_commits_impl(&state, b.repo_id)).expect("load older b");
    assert_eq!(b_now.commits.len(), 2);

    std::fs::remove_dir_all(&dir_a).expect("clean up temp dir");
    std::fs::remove_dir_all(&dir_b).expect("clean up temp dir");
}

#[test]
fn close_repository_invalidates_only_that_id() {
    let dir_a = build_repo("close", "a");
    let dir_b = build_repo("close", "b");
    let state = AppState::default();
    let a = open(&state, &dir_a);
    let b = open(&state, &dir_b);

    let head_b = b
        .data
        .commits
        .iter()
        .find(|c| c.is_head)
        .expect("HEAD commit in b")
        .id
        .clone();

    close_repository_impl(&state, a.repo_id).expect("close a");
    assert_eq!(
        run(get_commit_detail_impl(&state, a.repo_id, head_b.clone())).unwrap_err(),
        "No repository opened"
    );
    assert_eq!(
        close_repository_impl(&state, a.repo_id).unwrap_err(),
        "No repository opened"
    );
    run(get_commit_detail_impl(&state, b.repo_id, head_b))
        .expect("b still works after a's close");

    std::fs::remove_dir_all(&dir_a).expect("clean up temp dir");
    std::fs::remove_dir_all(&dir_b).expect("clean up temp dir");
}

#[test]
fn already_open_reuses_id_and_preserves_session() {
    let dir = build_repo("already", "x");
    let state = AppState::default();
    let path = dir.to_str().unwrap().to_string();
    let first = open(&state, &dir);

    // Mutate the session: filter to main only, and plant markers on the
    // fields a reopen must NOT reset.
    run(filter_by_branches_impl(
        &state,
        first.repo_id,
        vec!["main".to_string()],
    ))
    .expect("filter");
    {
        let mut repos = state.repos.lock().unwrap();
        let session = repos.get_mut(&first.repo_id).unwrap();
        session.include_stale = false;
        session.watch_baseline = Some("planted-baseline".to_string());
    }

    let second = run(open_repository_impl(&state, path, true)).expect("reopen");
    assert_eq!(second.repo_id, first.repo_id);
    assert!(second.already_open);
    // The view returned is the CURRENT (filtered) one, not a fresh full view.
    assert_eq!(second.data.commits.len(), 3);
    assert!(second.data.commits.iter().all(|c| c.message != "f1-x"));

    // Session fields untouched: baseline marker, include_stale, and the
    // filtered single-seed pagination session.
    let repos = state.repos.lock().unwrap();
    let session = repos.get(&first.repo_id).unwrap();
    assert_eq!(session.watch_baseline.as_deref(), Some("planted-baseline"));
    assert!(!session.include_stale);
    let seeds = &session.session.as_ref().unwrap().seeds;
    assert_eq!(seeds.len(), 1);
    assert_eq!(seeds[0].name, "main");

    std::fs::remove_dir_all(&dir).expect("clean up temp dir");
}

/// Spec 4.2 under concurrency: two opens of the same canonical path that
/// overlap (both pass the dedup lookup before either registers) must still
/// yield ONE session. The insert re-checks under the repos lock, so the
/// race loser degrades to the winner: same repo_id, already_open: true.
/// The assertions hold whichever way the interleaving lands (full race on
/// the insert re-check, or a staggered second-open dedup hit).
#[test]
fn concurrent_opens_of_the_same_path_yield_one_session() {
    let dir = build_repo("race", "x");
    let state = Arc::new(AppState::default());
    let path = dir
        .to_str()
        .expect("temp dir must be valid UTF-8")
        .to_string();

    // Two tasks over the impl function on one shared registry, driven in
    // parallel on a multi-thread runtime (join! semantics).
    let (first, second) = tokio::runtime::Runtime::new().unwrap().block_on(async {
        let a = {
            let state = Arc::clone(&state);
            let path = path.clone();
            tokio::spawn(async move { open_repository_impl(&state, path, true).await })
        };
        let b = {
            let state = Arc::clone(&state);
            let path = path.clone();
            tokio::spawn(async move { open_repository_impl(&state, path, true).await })
        };
        (a.await.expect("join first"), b.await.expect("join second"))
    });

    let first = first.expect("first open");
    let second = second.expect("second open");

    // Exactly one registered session, and both callers hold its id.
    assert_eq!(first.repo_id, second.repo_id);
    assert_eq!(state.repos.lock().unwrap().len(), 1);
    // One fresh insert, one already_open degradation (order unknown).
    assert_ne!(first.already_open, second.already_open);

    std::fs::remove_dir_all(&dir).expect("clean up temp dir");
}

#[test]
fn symlinked_path_dedups_to_the_same_session() {
    let dir = build_repo("symlink", "x");
    let state = AppState::default();
    let first = open(&state, &dir);

    let alias = std::env::temp_dir().join(format!("gtv-multi-symlink-alias-{}", std::process::id()));
    let _ = std::fs::remove_file(&alias);
    std::os::unix::fs::symlink(&dir, &alias).expect("create symlink");

    let second = open(&state, &alias);
    assert_eq!(second.repo_id, first.repo_id);
    assert!(second.already_open);

    std::fs::remove_file(&alias).expect("clean up alias");
    std::fs::remove_dir_all(&dir).expect("clean up temp dir");
}

#[test]
fn worktree_family_enumerates_identically_from_both_ends() {
    let dir = build_repo("family", "x");
    let wt = std::env::temp_dir().join(format!("gtv-multi-family-wt-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&wt);
    git(
        &dir,
        &["worktree", "add", wt.to_str().unwrap(), "-b", "topic"],
        &day(5),
    );

    let state = AppState::default();
    let main = open(&state, &dir);

    // Exactly two members: the main repo (first, flagged) and the linked
    // worktree (named after its directory basename, like git itself).
    assert_eq!(main.family.len(), 2);
    assert!(main.family[0].is_main);
    assert!(!main.family[1].is_main);
    assert_eq!(
        main.family[0].name,
        dir.file_name().unwrap().to_str().unwrap()
    );
    assert_eq!(
        main.family[1].name,
        wt.file_name().unwrap().to_str().unwrap()
    );

    // commondir is the canonical <main>/.git family key.
    assert_eq!(
        main.commondir,
        std::fs::canonicalize(dir.join(".git"))
            .unwrap()
            .to_string_lossy()
    );

    // From the worktree end: a distinct session, the same commondir, the
    // same member set (canonical paths make the sets equal).
    let from_wt = open(&state, &wt);
    assert_ne!(from_wt.repo_id, main.repo_id);
    assert!(!from_wt.already_open);
    assert_eq!(from_wt.commondir, main.commondir);
    let key = |m: &gtv_lib::models::WorktreeMember| (m.name.clone(), m.path.clone(), m.is_main);
    let from_main: Vec<_> = main.family.iter().map(key).collect();
    let from_wt_set: Vec<_> = from_wt.family.iter().map(key).collect();
    assert_eq!(from_wt_set, from_main);

    std::fs::remove_dir_all(&wt).expect("clean up worktree");
    std::fs::remove_dir_all(&dir).expect("clean up temp dir");
}

#[test]
fn family_members_get_independent_sessions() {
    let dir = build_repo("family2", "x");
    let wt = std::env::temp_dir().join(format!("gtv-multi-family2-wt-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&wt);
    git(
        &dir,
        &["worktree", "add", wt.to_str().unwrap(), "-b", "topic"],
        &day(5),
    );

    let state = AppState::default();
    let main = open(&state, &dir);
    let wt_repo = open(&state, &wt);
    assert_ne!(main.repo_id, wt_repo.repo_id);

    // Narrow the worktree's view to m1's ancestry; the main repo keeps
    // its full four-commit view (branches are shared through the common
    // dir, so both see m1..m3 + f1 before the jump).
    let m1 = wt_repo
        .data
        .commits
        .iter()
        .find(|c| c.message == "m1-x")
        .expect("m1 reachable from the worktree")
        .id
        .clone();
    let jumped = run(jump_to_commit_impl(&state, wt_repo.repo_id, m1)).expect("jump wt");
    assert_eq!(jumped.commits.len(), 1);

    let main_now = run(load_older_commits_impl(&state, main.repo_id)).expect("main view");
    assert_eq!(main_now.commits.len(), 4);

    std::fs::remove_dir_all(&wt).expect("clean up worktree");
    std::fs::remove_dir_all(&dir).expect("clean up temp dir");
}

#[test]
fn fingerprint_moves_when_a_remote_ref_moves() {
    let dir = build_repo("fp", "x");
    let before = GitReader::new(dir.to_str().unwrap())
        .expect("open fixture")
        .change_fingerprint()
        .expect("fingerprint");

    // A fetch only moves refs/remotes (T3's premise): the fingerprint must
    // be sensitive to that alone.
    let head = git_sha(&dir, "HEAD");
    git(
        &dir,
        &["update-ref", "refs/remotes/origin/x", &head],
        &day(6),
    );

    let after = GitReader::new(dir.to_str().unwrap())
        .expect("reopen fixture")
        .change_fingerprint()
        .expect("fingerprint");
    assert_ne!(before, after);

    std::fs::remove_dir_all(&dir).expect("clean up temp dir");
}

#[test]
fn diff_fingerprints_reports_only_real_changes() {
    let mut prev: HashMap<u64, String> = HashMap::new();
    let mut next: HashMap<u64, String> = HashMap::new();
    prev.insert(1, "a".to_string());
    next.insert(1, "a".to_string()); // unchanged
    prev.insert(2, "b".to_string());
    next.insert(2, "b2".to_string()); // changed
    next.insert(3, "c".to_string()); // first sight: baseline only, no emit
    prev.insert(4, "d".to_string()); // gone (closed): absent from next

    let mut changed = diff_fingerprints(&prev, &next);
    changed.sort_unstable();
    assert_eq!(changed, vec![2]);
}

#[test]
fn set_active_updates_and_rejects_unknown_ids() {
    let dir_a = build_repo("active", "a");
    let dir_b = build_repo("active", "b");
    let state = AppState::default();
    let a = open(&state, &dir_a);
    let b = open(&state, &dir_b);

    // Opening makes the repo active.
    assert_eq!(*state.active.lock().unwrap(), b.repo_id);

    set_active_repository_impl(&state, a.repo_id).expect("activate a");
    assert_eq!(*state.active.lock().unwrap(), a.repo_id);

    assert_eq!(
        set_active_repository_impl(&state, 9999).unwrap_err(),
        "No repository opened"
    );
    assert_eq!(*state.active.lock().unwrap(), a.repo_id);

    // Closing the active repo resets active to "none" (0); the other repo
    // stays open and can take over.
    close_repository_impl(&state, a.repo_id).expect("close a");
    assert_eq!(*state.active.lock().unwrap(), 0);
    set_active_repository_impl(&state, b.repo_id).expect("activate b");

    std::fs::remove_dir_all(&dir_a).expect("clean up temp dir");
    std::fs::remove_dir_all(&dir_b).expect("clean up temp dir");
}

#[test]
fn open_error_leaves_registry_untouched() {
    let state = AppState::default();
    let not_a_repo =
        std::env::temp_dir().join(format!("gtv-multi-norepo-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&not_a_repo);
    std::fs::create_dir_all(&not_a_repo).expect("create dir");

    let result = run(open_repository_impl(
        &state,
        not_a_repo.to_str().unwrap().to_string(),
        true,
    ));
    assert!(result.is_err());
    assert!(state.repos.lock().unwrap().is_empty());
    assert_eq!(*state.active.lock().unwrap(), 0);

    std::fs::remove_dir_all(&not_a_repo).expect("clean up temp dir");
}
