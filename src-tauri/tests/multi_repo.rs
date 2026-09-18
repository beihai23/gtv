//! Multi-repo session registry (spec 4.1/4.2): repo_id routing keeps
//! sessions independent, open_repository dedupes on the canonical path
//! (same path, symlink, already-open reactivation without touching the
//! session), worktree families enumerate identically from both ends,
//! close/active behave, and the watcher's pure fingerprint diff reports
//! exactly the moved repos.

use gtv_lib::commands::{
    close_repository_impl, filter_by_branches_impl, get_branch_list_impl, get_commit_detail_impl,
    jump_to_commit_impl, load_older_commits_impl, open_repository_impl,
    refresh_repository_impl, set_active_repository_impl, set_auto_fetch_impl,
    set_include_stale_impl, spawn_terminal_in_repo, terminal_write_impl, AppState,
};
use gtv_lib::fetcher::{fetch_tick, TickOutcome};
use gtv_lib::git_reader::GitReader;
use gtv_lib::watcher::diff_fingerprints;
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::Ordering;
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

// --- Auto-fetch (Task 3): fetch_remotes + fetcher tick over file:// remotes ---

/// Bare upstream wired as the `origin` of a working clone, built entirely
/// with the git CLI over the local file:// transport (zero network). The
/// seed worktree stays alive so tests can advance the upstream WITHOUT
/// touching the clone under test: `advance_upstream` commits in the seed
/// and pushes to the bare. Returns (seed, upstream, clone).
fn build_fetch_fixture(
    name: &str,
) -> (
    std::path::PathBuf,
    std::path::PathBuf,
    std::path::PathBuf,
) {
    let base = std::env::temp_dir().join(format!("gtv-fetch-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).expect("create temp dir");
    let seed = base.join("seed");
    let upstream = base.join("upstream.git");
    let clone = base.join("clone");
    git(&base, &["init", "-b", "main", seed.to_str().unwrap()], &day(1));
    std::fs::write(seed.join("file.txt"), "v1\n").expect("write seed file");
    git(&seed, &["add", "."], &day(1));
    commit(&seed, "seed-1", &day(1));
    git(
        &base,
        &[
            "clone",
            "--bare",
            seed.to_str().unwrap(),
            upstream.to_str().unwrap(),
        ],
        &day(1),
    );
    git(
        &base,
        &[
            "clone",
            format!("file://{}", upstream.display()).as_str(),
            clone.to_str().unwrap(),
        ],
        &day(1),
    );
    (seed, upstream, clone)
}

/// One new commit on the upstream's main, pushed from the seed worktree.
/// The clone under test is never touched. Returns the new tip oid.
fn advance_upstream(seed: &Path, upstream: &Path, msg: &str, date: &str) -> String {
    std::fs::write(seed.join("file.txt"), format!("{}\n", msg)).expect("write upstream file");
    git(seed, &["add", "."], date);
    commit(seed, msg, date);
    git(
        seed,
        &[
            "push",
            format!("file://{}", upstream.display()).as_str(),
            "main",
        ],
        date,
    );
    git_sha(seed, "HEAD")
}

#[test]
fn fetch_remotes_updates_tracking_refs_only() {
    let (seed, upstream, clone) = build_fetch_fixture("land");

    // Write-boundary baseline: HEAD, the local branch, the tracking ref,
    // and the worktree file bytes.
    let head_before = git_sha(&clone, "HEAD");
    let main_before = git_sha(&clone, "main");
    let origin_main_before = git_sha(&clone, "refs/remotes/origin/main");
    let worktree_before = std::fs::read(clone.join("file.txt")).expect("worktree file");

    let new_tip = advance_upstream(&seed, &upstream, "up-1", &day(7));
    assert_ne!(origin_main_before, new_tip);

    let summary = GitReader::new(clone.to_str().unwrap())
        .expect("open clone")
        .fetch_remotes()
        .expect("fetch_remotes");
    assert!(summary.is_none(), "clean fetch reports no summary: {:?}", summary);

    // The tracking ref landed on the upstream's new tip...
    assert_eq!(git_sha(&clone, "refs/remotes/origin/main"), new_tip);
    // ...and NOTHING else moved: HEAD, the local branch, and the worktree
    // stay byte-identical. These assertions ARE the write-whitelist
    // acceptance for fetch (spec 3, item 2).
    assert_eq!(git_sha(&clone, "HEAD"), head_before);
    assert_eq!(git_sha(&clone, "main"), main_before);
    let worktree_after = std::fs::read(clone.join("file.txt")).expect("worktree file");
    assert_eq!(worktree_after, worktree_before);
    assert_eq!(worktree_after, b"v1\n".to_vec());

    std::fs::remove_dir_all(seed.parent().unwrap()).expect("clean up temp dir");
}

#[test]
fn one_dead_remote_does_not_abort_the_live_one() {
    let (seed, upstream, clone) = build_fetch_fixture("dead");
    // A second remote whose path does not exist: file:// to nowhere.
    let dead_url = format!(
        "file://{}",
        clone.parent().unwrap().join("nope.git").display()
    );
    git(&clone, &["remote", "add", "dead", dead_url.as_str()], &day(1));

    let new_tip = advance_upstream(&seed, &upstream, "up-1", &day(7));

    let summary = GitReader::new(clone.to_str().unwrap())
        .expect("open clone")
        .fetch_remotes()
        .expect("fetch_remotes");
    // Empirically verified on git 2.x (report, Task 8): `git fetch --all
    // --quiet` with one dead remote exits 1, prints the per-remote fatal
    // on stderr ending in "error: could not fetch dead", and the LIVE
    // remote's refs still land. Assert exactly that shape: non-zero exit
    // captured in the summary, the dead remote named in the stderr tail,
    // and origin's new tip fetched anyway.
    let summary = summary.expect("one dead remote must surface a summary");
    assert!(
        summary.starts_with("git fetch exited 1"),
        "non-zero exit captured: {}",
        summary
    );
    assert!(summary.contains("dead"), "names the dead remote: {}", summary);
    assert_eq!(git_sha(&clone, "refs/remotes/origin/main"), new_tip);

    std::fs::remove_dir_all(seed.parent().unwrap()).expect("clean up temp dir");
}

#[test]
fn busy_flag_skips_the_tick_until_cleared() {
    let (seed, upstream, clone) = build_fetch_fixture("busy");
    let state = AppState::default();
    open(&state, &clone);

    let new_tip = advance_upstream(&seed, &upstream, "up-1", &day(7));

    // A previous fetch still in flight (planted): the tick must not
    // dispatch, so the upstream's new commit stays unfetched...
    state.fetching.store(true, Ordering::SeqCst);
    assert_eq!(run(fetch_tick(&state)), TickOutcome::Busy);
    assert_ne!(git_sha(&clone, "refs/remotes/origin/main"), new_tip);
    // ...and the flag stays set (still owned by the "in-flight" fetch).
    assert!(state.fetching.load(Ordering::SeqCst));

    // Cleared: the next tick fetches and resets the flag on completion.
    state.fetching.store(false, Ordering::SeqCst);
    assert_eq!(run(fetch_tick(&state)), TickOutcome::Fetched(None));
    assert_eq!(git_sha(&clone, "refs/remotes/origin/main"), new_tip);
    assert!(!state.fetching.load(Ordering::SeqCst));

    std::fs::remove_dir_all(seed.parent().unwrap()).expect("clean up temp dir");
}

#[test]
fn auto_fetch_off_idles_the_tick() {
    let (seed, upstream, clone) = build_fetch_fixture("autooff");
    let state = AppState::default();
    open(&state, &clone);

    set_auto_fetch_impl(&state, false).expect("disable auto-fetch");
    advance_upstream(&seed, &upstream, "up-1", &day(7));

    assert_eq!(run(fetch_tick(&state)), TickOutcome::AutoOff);
    // Idled before any fetch: the tracking ref did not move.
    assert_ne!(
        git_sha(&clone, "refs/remotes/origin/main"),
        git_sha(&seed, "HEAD")
    );

    // Flipping the setting back on resumes on the NEXT tick: the toggle
    // is read at tick top and has no immediate-trigger semantics.
    set_auto_fetch_impl(&state, true).expect("enable auto-fetch");
    assert_eq!(run(fetch_tick(&state)), TickOutcome::Fetched(None));
    assert_eq!(
        git_sha(&clone, "refs/remotes/origin/main"),
        git_sha(&seed, "HEAD")
    );

    std::fs::remove_dir_all(seed.parent().unwrap()).expect("clean up temp dir");
}

#[test]
fn only_the_active_repo_is_fetched() {
    let (seed_a, upstream_a, clone_a) = build_fetch_fixture("only-a");
    let (seed_b, upstream_b, clone_b) = build_fetch_fixture("only-b");
    let state = AppState::default();
    let a = open(&state, &clone_a);
    open(&state, &clone_b); // opening makes B active
    set_active_repository_impl(&state, a.repo_id).expect("activate a");

    let tip_a = advance_upstream(&seed_a, &upstream_a, "up-a", &day(7));
    let tip_b = advance_upstream(&seed_b, &upstream_b, "up-b", &day(7));

    assert_eq!(run(fetch_tick(&state)), TickOutcome::Fetched(None));
    // A (active) moved; B (background) did not: fetch targets ONLY the
    // active tab (spec 4.3).
    assert_eq!(git_sha(&clone_a, "refs/remotes/origin/main"), tip_a);
    assert_ne!(git_sha(&clone_b, "refs/remotes/origin/main"), tip_b);

    std::fs::remove_dir_all(seed_a.parent().unwrap()).expect("clean up temp dir a");
    std::fs::remove_dir_all(seed_b.parent().unwrap()).expect("clean up temp dir b");
}

#[test]
fn closed_active_id_yields_noactive_without_panic() {
    let (seed_a, upstream_a, clone_a) = build_fetch_fixture("nit5-a");
    let (seed_b, upstream_b, clone_b) = build_fetch_fixture("nit5-b");
    let state = AppState::default();
    let a = open(&state, &clone_a);
    let b = open(&state, &clone_b);

    // Nit-5: simulate the between-ticks race -- the tab closed but the
    // fetcher's cached `active` still names its id (the observable state
    // of the window where close removed the session but has not yet reset
    // `active`). close normally zeroes it; the plant reproduces the race.
    let tip_a = advance_upstream(&seed_a, &upstream_a, "up-a", &day(7));
    close_repository_impl(&state, a.repo_id).expect("close a");
    *state.active.lock().unwrap() = a.repo_id;

    let tip_b = advance_upstream(&seed_b, &upstream_b, "up-b", &day(7));

    // No panic, and no dispatch: without the re-verification this tick
    // would have fetched closed tab A (its directory still exists, so the
    // write would really have landed).
    assert_eq!(run(fetch_tick(&state)), TickOutcome::NoActive);
    assert!(!state.fetching.load(Ordering::SeqCst));
    assert_ne!(git_sha(&clone_a, "refs/remotes/origin/main"), tip_a);
    assert_ne!(git_sha(&clone_b, "refs/remotes/origin/main"), tip_b);

    // Switching active to the live tab fetches that one fine.
    set_active_repository_impl(&state, b.repo_id).expect("activate b");
    assert_eq!(run(fetch_tick(&state)), TickOutcome::Fetched(None));
    assert_eq!(git_sha(&clone_b, "refs/remotes/origin/main"), tip_b);

    std::fs::remove_dir_all(seed_a.parent().unwrap()).expect("clean up temp dir a");
    std::fs::remove_dir_all(seed_b.parent().unwrap()).expect("clean up temp dir b");
}

// --- set_include_stale (Task 5): the stale toggle's own rebuild path ---

/// Fixture whose `stale` branch tip falls outside the 2000-commit open
/// window: main carries 2100 chained commits (fast-import -- ONE git
/// process for all of them; 2100 `git commit` spawns would dominate the
/// test's runtime), each dated 60 s apart, and `stale` forks at commit 80
/// with its tip dated between commits 80 and 81. The newest-2000 window
/// therefore holds main's marks 101..2100 and NOT the stale tip -- exactly
/// what makes read_git_data report the branch stale.
fn build_stale_window_fixture(name: &str) -> std::path::PathBuf {
    let dir =
        std::env::temp_dir().join(format!("gtv-multi-stale-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create temp dir");
    git(&dir, &["init", "-b", "main"], &day(1));

    let base = 1577836800i64; // 2020-01-01T00:00:00Z
    let mut stream = String::new();
    for i in 0..2100 {
        let msg = format!("c{}", i);
        stream.push_str("commit refs/heads/main\n");
        stream.push_str(&format!("mark :{}\n", i + 1));
        stream.push_str(&format!(
            "committer gtv <gtv@gtv.local> {} +0000\n",
            base + i as i64 * 60
        ));
        // fast-import grammar: data payload first, `from` after it.
        stream.push_str(&format!("data {}\n{}\n", msg.len(), msg));
        if i > 0 {
            stream.push_str(&format!("from :{}\n", i));
        }
        stream.push('\n');
    }
    stream.push_str("commit refs/heads/stale\n");
    stream.push_str("mark :3001\n");
    stream.push_str(&format!(
        "committer gtv <gtv@gtv.local> {} +0000\n",
        base + 79 * 60 + 30
    ));
    stream.push_str("data 3\nst1\n");
    stream.push_str("from :80\n\n");
    stream.push_str("done\n");

    use std::io::Write as _;
    use std::process::Stdio;
    let mut child = Command::new("git")
        .args(["fast-import", "--quiet"])
        .current_dir(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn git fast-import");
    child
        .stdin
        .take()
        .expect("fast-import stdin")
        .write_all(stream.as_bytes())
        .expect("write fast-import stream");
    let status = child.wait().expect("wait fast-import");
    assert!(status.success(), "git fast-import failed");
    dir
}

/// The toggle flips session.include_stale, rebuilds the view + pagination
/// session (stale seed retained or dropped), returns a fresh full-window
/// read, and get_branch_list -- where include_stale is user-visible --
/// mirrors the policy. Unknown ids error like every repo-routed command.
#[test]
fn set_include_stale_rebuilds_session_and_filters_branch_list() {
    let dir = build_stale_window_fixture("toggle");
    let state = AppState::default();
    let repo = open(&state, &dir); // include_stale: true

    // Fixture sanity: the window really excludes the stale tip.
    assert_eq!(repo.data.commits.len(), 2000);
    {
        let repos = state.repos.lock().unwrap();
        let session = repos.get(&repo.repo_id).unwrap();
        assert!(session.include_stale);
        let names: Vec<&str> = session
            .session
            .as_ref()
            .unwrap()
            .seeds
            .iter()
            .map(|s| s.name.as_str())
            .collect();
        assert!(names.contains(&"stale"), "seeds with stale on: {:?}", names);
    }
    let with_stale = run(get_branch_list_impl(&state, repo.repo_id)).expect("branch list on");
    assert!(with_stale.iter().any(|b| b.name == "stale"));

    // Toggle OFF: flag flips, the pagination session drops the stale seed,
    // the branch list hides the branch, and the returned view is a fresh
    // full-window read.
    let rebuilt =
        run(set_include_stale_impl(&state, repo.repo_id, false)).expect("toggle stale off");
    assert_eq!(rebuilt.commits.len(), 2000);
    {
        let repos = state.repos.lock().unwrap();
        let session = repos.get(&repo.repo_id).unwrap();
        assert!(!session.include_stale);
        let names: Vec<&str> = session
            .session
            .as_ref()
            .unwrap()
            .seeds
            .iter()
            .map(|s| s.name.as_str())
            .collect();
        assert!(
            !names.contains(&"stale"),
            "seeds with stale off: {:?}",
            names
        );
    }
    let without_stale = run(get_branch_list_impl(&state, repo.repo_id)).expect("branch list off");
    assert!(without_stale.iter().all(|b| b.name != "stale"));

    // Toggle back ON: the stale seed and the branch-list entry return.
    run(set_include_stale_impl(&state, repo.repo_id, true)).expect("toggle stale on");
    let restored = run(get_branch_list_impl(&state, repo.repo_id)).expect("branch list on again");
    assert!(restored.iter().any(|b| b.name == "stale"));

    assert_eq!(
        run(set_include_stale_impl(&state, 9999, true)).unwrap_err(),
        "No repository opened"
    );

    std::fs::remove_dir_all(&dir).expect("clean up temp dir");
}

/// The rebuild must not disturb the tab's terminal: the session id in the
/// slot is unchanged across two toggles and the pty still accepts writes
/// (the close-time kill semantics are the only path allowed to touch it).
#[test]
fn set_include_stale_keeps_the_terminal_alive() {
    let dir = build_repo("staleterm", "x");
    let state = AppState::default();
    let repo = open(&state, &dir);

    let (out_tx, out_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let (exit_tx, _exit_rx) = std::sync::mpsc::channel::<u64>();
    let spawner = move |path: std::path::PathBuf, cols: u16, rows: u16| {
        gtv_lib::terminal::spawn_pty(
            "/bin/sh",
            &[],
            &path,
            cols,
            rows,
            move |_id, bytes| {
                let _ = out_tx.send(bytes);
            },
            move |id| {
                let _ = exit_tx.send(id);
            },
        )
    };
    let info = run(spawn_terminal_in_repo(&state, repo.repo_id, 80, 24, spawner))
        .expect("spawn terminal");

    run(set_include_stale_impl(&state, repo.repo_id, false)).expect("toggle stale off");
    run(set_include_stale_impl(&state, repo.repo_id, true)).expect("toggle stale on");

    // Same live session in the slot, and it still echoes writes.
    {
        let repos = state.repos.lock().unwrap();
        let session = repos.get(&repo.repo_id).unwrap();
        assert_eq!(
            session.terminal.as_ref().unwrap().lock().unwrap().id,
            info.id
        );
    }
    terminal_write_impl(&state, repo.repo_id, "printf stale-toggle-alive\n".to_string())
        .expect("write after toggles");
    let started = std::time::Instant::now();
    let mut seen = String::new();
    while started.elapsed() < std::time::Duration::from_secs(10) {
        match out_rx.recv_timeout(std::time::Duration::from_millis(200)) {
            Ok(chunk) => {
                seen.push_str(&String::from_utf8_lossy(&chunk));
                if seen.contains("stale-toggle-alive") {
                    break;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    assert!(
        seen.contains("stale-toggle-alive"),
        "terminal must survive the stale toggle, got: {:?}",
        seen
    );

    std::fs::remove_dir_all(&dir).expect("clean up temp dir");
}

// --- refresh_repository (Task-5 review 3c): the repo-changed refresh path ---

/// The refresh delegates to the set_include_stale rebuild under the
/// session's CURRENT include_stale value: the flag does not move (pinned
/// here in the non-default OFF direction -- a hardcoded true or the open
/// default would flip it), the returned view is the fresh full read, and
/// the tab's terminal survives with its session id intact and still
/// echoing. Unknown ids error like every repo-routed command.
#[test]
fn refresh_repository_rebuilds_view_keeps_policy_and_terminal() {
    let dir = build_repo("refresh", "x");
    let state = AppState::default();
    let repo = open(&state, &dir); // include_stale: true

    // Flip the policy OFF first: the refresh must keep it OFF, proving the
    // delegation reads the session's current value (not the default).
    run(set_include_stale_impl(&state, repo.repo_id, false)).expect("toggle stale off");

    let (out_tx, out_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let (exit_tx, _exit_rx) = std::sync::mpsc::channel::<u64>();
    let spawner = move |path: std::path::PathBuf, cols: u16, rows: u16| {
        gtv_lib::terminal::spawn_pty(
            "/bin/sh",
            &[],
            &path,
            cols,
            rows,
            move |_id, bytes| {
                let _ = out_tx.send(bytes);
            },
            move |id| {
                let _ = exit_tx.send(id);
            },
        )
    };
    let info = run(spawn_terminal_in_repo(&state, repo.repo_id, 80, 24, spawner))
        .expect("spawn terminal");

    let refreshed = run(refresh_repository_impl(&state, repo.repo_id)).expect("refresh");
    // Fresh full-window read of the 4-commit fixture.
    assert_eq!(refreshed.commits.len(), 4);

    {
        let repos = state.repos.lock().unwrap();
        let session = repos.get(&repo.repo_id).unwrap();
        assert!(!session.include_stale, "refresh must not flip the policy");
        assert_eq!(
            session.terminal.as_ref().unwrap().lock().unwrap().id,
            info.id,
            "terminal slot untouched"
        );
    }

    terminal_write_impl(&state, repo.repo_id, "printf refresh-alive\n".to_string())
        .expect("write after refresh");
    let started = std::time::Instant::now();
    let mut seen = String::new();
    while started.elapsed() < std::time::Duration::from_secs(10) {
        match out_rx.recv_timeout(std::time::Duration::from_millis(200)) {
            Ok(chunk) => {
                seen.push_str(&String::from_utf8_lossy(&chunk));
                if seen.contains("refresh-alive") {
                    break;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    assert!(
        seen.contains("refresh-alive"),
        "terminal must survive the refresh, got: {:?}",
        seen
    );

    assert_eq!(
        run(refresh_repository_impl(&state, 9999)).unwrap_err(),
        "No repository opened"
    );

    std::fs::remove_dir_all(&dir).expect("clean up temp dir");
}
