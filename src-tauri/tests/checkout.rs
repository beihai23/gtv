//! SAFE branch checkout + worktree status -- the app's ONLY write path to a
//! repository. checkout_branch writes the target tree first and moves HEAD
//! second, with the SAFE strategy: compatible uncommitted changes carry
//! over to the target branch, anything a plain `git checkout` would refuse
//! to overwrite aborts the whole call (HEAD and the worktree stay
//! untouched), and a merge or cherry-pick in progress is refused outright.
//! worktree_status is the preflight for the confirm dialog:
//! modified/untracked counts plus the merge-in-progress flag.

use gtv_lib::git_reader::GitReader;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Run git in `dir`. Identity/gpg overrides are passed inline so the test
/// works on machines with no global git config (or with commit.gpgsign on).
fn git(dir: &Path, args: &[&str]) {
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
        .current_dir(dir)
        .status()
        .expect("failed to spawn git");
    assert!(status.success(), "git {:?} failed", args);
}

/// Run git in `dir` and return trimmed stdout.
fn git_out(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .expect("failed to spawn git");
    assert!(
        out.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

/// Fresh empty repo on branch `main`, one temp dir per test.
fn temp_repo(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("gtv-checkout-{}-{}", name, std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create temp dir");
    git(&dir, &["init", "-b", "main"]);
    dir
}

fn write(dir: &Path, path: &str, contents: &str) {
    fs::write(dir.join(path), contents).expect("write file");
}

fn read(dir: &Path, path: &str) -> String {
    fs::read_to_string(dir.join(path)).expect("read file")
}

fn add_and_commit(dir: &Path, msg: &str) {
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-m", msg]);
}

/// Short symbolic HEAD name, e.g. "main" or "feature" ("HEAD" when
/// detached). Read through a fresh git process so a durable write (not an
/// in-memory reader state) is what gets asserted.
fn head_branch(dir: &Path) -> String {
    git_out(dir, &["rev-parse", "--abbrev-ref", "HEAD"])
}

#[test]
fn clean_checkout_moves_head_and_worktree() {
    let dir = temp_repo("clean");
    write(&dir, "shared.txt", "base");
    add_and_commit(&dir, "base");
    git(&dir, &["checkout", "-b", "feature"]);
    write(&dir, "shared.txt", "feature-version");
    add_and_commit(&dir, "feature change");
    git(&dir, &["checkout", "main"]);

    let reader = GitReader::new(dir.to_str().unwrap()).expect("open fixture");
    let ack = reader.checkout_branch("feature").expect("clean checkout succeeds");
    assert_eq!(ack.branch, "feature");

    // Durable state: HEAD points at feature (symbolic name and oid) and
    // the worktree carries the feature version of the file.
    assert_eq!(head_branch(&dir), "feature");
    assert_eq!(
        git_out(&dir, &["rev-parse", "HEAD"]),
        git_out(&dir, &["rev-parse", "feature"])
    );
    assert_eq!(read(&dir, "shared.txt"), "feature-version");

    fs::remove_dir_all(&dir).expect("clean up temp dir");
}

#[test]
fn compatible_local_changes_carry_over() {
    let dir = temp_repo("carry");
    write(&dir, "x.txt", "one");
    add_and_commit(&dir, "c1");
    // `other` forks here and never touches x.txt or knows about y.txt.
    git(&dir, &["branch", "other"]);
    write(&dir, "y.txt", "main-only");
    add_and_commit(&dir, "c2");

    // Uncommitted edit to a file the target branch never touched.
    write(&dir, "x.txt", "one-dirty");

    let reader = GitReader::new(dir.to_str().unwrap()).expect("open fixture");
    reader
        .checkout_branch("other")
        .expect("compatible change carries, checkout succeeds");
    assert_eq!(head_branch(&dir), "other");
    assert_eq!(read(&dir, "x.txt"), "one-dirty", "local edit carried over");
    assert!(!dir.join("y.txt").exists(), "main-only file left the worktree");

    fs::remove_dir_all(&dir).expect("clean up temp dir");
}

#[test]
fn conflicting_checkout_is_refused_with_zero_side_effects() {
    let dir = temp_repo("conflict");
    write(&dir, "x.txt", "base");
    add_and_commit(&dir, "c1");
    git(&dir, &["checkout", "-b", "feature"]);
    write(&dir, "x.txt", "feature-version");
    add_and_commit(&dir, "feature change");
    git(&dir, &["checkout", "main"]);

    // Uncommitted edit to the one file the target branch also changed.
    write(&dir, "x.txt", "local-dirty");

    let reader = GitReader::new(dir.to_str().unwrap()).expect("open fixture");
    let _ = reader
        .checkout_branch("feature")
        .expect_err("conflicting local change must abort the checkout");

    // Acceptance core: a refused checkout changes NOTHING -- HEAD still on
    // main, the local edit intact, the worktree-vs-index state as it was.
    assert_eq!(head_branch(&dir), "main");
    assert_eq!(read(&dir, "x.txt"), "local-dirty");
    // Raw bytes (no trim): the leading " M" column is the whole point.
    let porcelain = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&dir)
        .output()
        .expect("failed to spawn git status");
    assert_eq!(porcelain.stdout, b" M x.txt\n");

    fs::remove_dir_all(&dir).expect("clean up temp dir");
}

#[test]
fn merge_in_progress_is_refused_until_resolved() {
    let dir = temp_repo("merge");
    write(&dir, "a.txt", "base");
    add_and_commit(&dir, "c1");
    git(&dir, &["checkout", "-b", "feature"]);
    write(&dir, "a.txt", "feature");
    add_and_commit(&dir, "feature change");
    git(&dir, &["checkout", "main"]);

    // Simulate the state an unfinished `git merge` leaves behind.
    let head = git_out(&dir, &["rev-parse", "HEAD"]);
    fs::write(dir.join(".git").join("MERGE_HEAD"), format!("{}\n", head))
        .expect("write MERGE_HEAD");

    let reader = GitReader::new(dir.to_str().unwrap()).expect("open fixture");
    let err = reader
        .checkout_branch("feature")
        .expect_err("checkout must refuse while a merge is in progress");
    assert_eq!(err, "merge or cherry-pick in progress");
    assert_eq!(head_branch(&dir), "main", "refused before any write");

    // The refusal tracks the merge state, not the branch: gone MERGE_HEAD,
    // the same checkout succeeds.
    fs::remove_file(dir.join(".git").join("MERGE_HEAD")).expect("remove MERGE_HEAD");
    reader
        .checkout_branch("feature")
        .expect("usable again once the merge state is gone");
    assert_eq!(head_branch(&dir), "feature");

    fs::remove_dir_all(&dir).expect("clean up temp dir");
}

#[test]
fn untracked_files_do_not_block_checkout() {
    let dir = temp_repo("untracked");
    write(&dir, "a.txt", "base");
    add_and_commit(&dir, "c1");
    git(&dir, &["checkout", "-b", "feature"]);
    write(&dir, "b.txt", "feature-file");
    add_and_commit(&dir, "feature change");
    git(&dir, &["checkout", "main"]);

    // Untracked file that exists in neither branch.
    write(&dir, "scratch.txt", "not tracked anywhere");

    let reader = GitReader::new(dir.to_str().unwrap()).expect("open fixture");
    reader
        .checkout_branch("feature")
        .expect("untracked file does not conflict");
    assert_eq!(head_branch(&dir), "feature");
    assert_eq!(read(&dir, "b.txt"), "feature-file");
    assert_eq!(read(&dir, "scratch.txt"), "not tracked anywhere", "untracked file kept");

    fs::remove_dir_all(&dir).expect("clean up temp dir");
}

#[test]
fn worktree_status_counts_modified_untracked_and_merge_state() {
    let dir = temp_repo("status");
    write(&dir, "a.txt", "one");
    write(&dir, "b.txt", "two");
    write(&dir, "c.txt", "three");
    add_and_commit(&dir, "c1");

    // 2 modified tracked files + 1 untracked file.
    write(&dir, "a.txt", "one-dirty");
    write(&dir, "b.txt", "two-dirty");
    write(&dir, "new.txt", "untracked");

    let reader = GitReader::new(dir.to_str().unwrap()).expect("open fixture");
    let status = reader.worktree_status().expect("status read");
    assert_eq!(status.modified, 2);
    assert_eq!(status.untracked, 1);
    assert!(!status.merge_in_progress);

    // MERGE_HEAD flips the merge flag without touching the counts.
    let head = git_out(&dir, &["rev-parse", "HEAD"]);
    fs::write(dir.join(".git").join("MERGE_HEAD"), format!("{}\n", head))
        .expect("write MERGE_HEAD");
    let status = reader.worktree_status().expect("status read");
    assert!(status.merge_in_progress);
    assert_eq!(status.modified, 2);
    assert_eq!(status.untracked, 1);

    fs::remove_dir_all(&dir).expect("clean up temp dir");
}

#[test]
fn tags_remote_and_unknown_names_are_rejected() {
    let dir = temp_repo("names");
    write(&dir, "a.txt", "base");
    add_and_commit(&dir, "c1");
    git(&dir, &["tag", "v1"]);
    // A remote-tracking ref with no local counterpart.
    let head = git_out(&dir, &["rev-parse", "HEAD"]);
    git(&dir, &["update-ref", "refs/remotes/origin/feature", &head]);

    let reader = GitReader::new(dir.to_str().unwrap()).expect("open fixture");
    for name in ["v1", "origin/feature", "does-not-exist"] {
        assert!(
            reader.checkout_branch(name).is_err(),
            "{} must be rejected as a checkout target",
            name
        );
    }
    // None of the attempts moved anything.
    assert_eq!(head_branch(&dir), "main");
    assert_eq!(read(&dir, "a.txt"), "base");

    fs::remove_dir_all(&dir).expect("clean up temp dir");
}
