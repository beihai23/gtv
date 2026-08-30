//! Two-commit compare backend (M3.2), all read-only: compare_detail
//! generalizes get_commit_detail's parent-vs-commit delta walk to ANY two
//! trees and fills in REAL per-file +/- numbers (get_commit_detail
//! deliberately leaves them at 0), pair_file_diff generalizes get_file_diff
//! to any two trees with the same 200KB truncation and binary placeholder,
//! and GitData.head_branch names the branch HEAD sits on (None while
//! detached) for the current-lane marker.

use gtv_lib::git_reader::GitReader;
use std::collections::HashMap;
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
    let dir = std::env::temp_dir().join(format!("gtv-compare-{}-{}", name, std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create temp dir");
    git(&dir, &["init", "-b", "main"]);
    dir
}

fn write(dir: &Path, path: &str, contents: &str) {
    fs::write(dir.join(path), contents).expect("write file");
}

fn add_and_commit(dir: &Path, msg: &str) {
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-m", msg]);
}

fn rev(dir: &Path, revspec: &str) -> String {
    git_out(dir, &["rev-parse", revspec])
}

/// base commit c1 ("base") carries:
///   added.txt  l1/l2/l3   (3 lines, untouched later)
///   gone.txt   g1/g2      (2 lines, deleted in target)
///   mod.txt    one/two    (2 lines, "two" -> "TWO" in target)
/// target commit c2 ("target") additionally creates new.txt (n1/n2).
/// Hand-counted base->target diff:
///   gone.txt  D  +0/-2, mod.txt M +1/-1, new.txt A +2/-0
///   totals +3/-3
fn build_three_state_fixture(dir: &Path) -> (String, String) {
    write(dir, "added.txt", "l1\nl2\nl3\n");
    write(dir, "gone.txt", "g1\ng2\n");
    write(dir, "mod.txt", "one\ntwo\n");
    add_and_commit(dir, "base");
    let base = rev(dir, "HEAD");

    fs::remove_file(dir.join("gone.txt")).expect("remove gone.txt");
    write(dir, "mod.txt", "one\nTWO\n");
    write(dir, "new.txt", "n1\nn2\n");
    add_and_commit(dir, "target");
    let target = rev(dir, "HEAD");

    (base, target)
}

#[test]
fn three_state_file_list_has_exact_per_file_numbers_and_totals() {
    let dir = temp_repo("three-state");
    let (base, target) = build_three_state_fixture(&dir);

    let reader = GitReader::new(dir.to_str().unwrap()).expect("open fixture");
    let detail = reader
        .compare_detail(&base, &target)
        .expect("compare_detail succeeds");

    // Both-side summaries: full id, 7-char short id, subject, author.
    assert_eq!(detail.base.id, base);
    assert_eq!(detail.base.short_id, base[..7]);
    assert_eq!(detail.base.subject, "base");
    assert_eq!(detail.base.author, "gtv");
    assert_eq!(detail.target.id, target);
    assert_eq!(detail.target.short_id, target[..7]);
    assert_eq!(detail.target.subject, "target");

    // Exactly the three states; real per-file numbers, hand-counted above.
    assert_eq!(detail.files.len(), 3, "added + deleted + modified only");
    let by_path: HashMap<&str, (&str, i32, i32)> = detail
        .files
        .iter()
        .map(|f| (f.path.as_str(), (f.status.as_str(), f.additions, f.deletions)))
        .collect();
    assert_eq!(by_path["new.txt"], ("A", 2, 0), "new.txt added, +2/-0");
    assert_eq!(by_path["gone.txt"], ("D", 0, 2), "gone.txt deleted, +0/-2");
    assert_eq!(by_path["mod.txt"], ("M", 1, 1), "mod.txt modified, +1/-1");

    // Totals are the sum of the per-file numbers.
    assert_eq!(detail.total_additions, 3);
    assert_eq!(detail.total_deletions, 3);

    fs::remove_dir_all(&dir).expect("clean up temp dir");
}

#[test]
fn pair_file_diff_returns_the_line_level_patch() {
    let dir = temp_repo("pair-diff");
    let (base, target) = build_three_state_fixture(&dir);

    let reader = GitReader::new(dir.to_str().unwrap()).expect("open fixture");
    let patch = reader
        .pair_file_diff(&base, &target, "mod.txt")
        .expect("pair_file_diff succeeds");
    assert!(patch.contains("--- a/mod.txt"), "patch header missing: {}", patch);
    assert!(patch.contains("+++ b/mod.txt"), "patch header missing: {}", patch);
    assert!(patch.contains("+TWO"), "added line missing: {}", patch);
    assert!(patch.contains("-two"), "removed line missing: {}", patch);

    // A file that did not change between the two trees has no diff entry.
    let err = reader
        .pair_file_diff(&base, &target, "added.txt")
        .expect_err("unchanged file must not resolve to a delta");
    assert!(err.contains("File not found"), "{}", err);

    fs::remove_dir_all(&dir).expect("clean up temp dir");
}

#[test]
fn identical_oids_yield_an_empty_compare() {
    let dir = temp_repo("empty-diff");
    let (base, target) = build_three_state_fixture(&dir);
    let reader = GitReader::new(dir.to_str().unwrap()).expect("open fixture");

    let detail = reader
        .compare_detail(&target, &target)
        .expect("same-oid compare succeeds");
    assert!(detail.files.is_empty(), "no delta between a tree and itself");
    assert_eq!(detail.total_additions, 0);
    assert_eq!(detail.total_deletions, 0);
    assert_eq!(detail.base.id, detail.target.id);

    // Direction matters: base->target lists the change, target->base lists
    // the same file with the additions/deletions mirror-swapped.
    let forward = reader.compare_detail(&base, &target).expect("forward");
    let backward = reader.compare_detail(&target, &base).expect("backward");
    let fwd: HashMap<&str, (i32, i32)> = forward
        .files
        .iter()
        .map(|f| (f.path.as_str(), (f.additions, f.deletions)))
        .collect();
    let bwd: HashMap<&str, (i32, i32)> = backward
        .files
        .iter()
        .map(|f| (f.path.as_str(), (f.additions, f.deletions)))
        .collect();
    assert_eq!(fwd["new.txt"], (2, 0), "base->target: new.txt is added");
    assert_eq!(bwd["new.txt"], (0, 2), "target->base: new.txt is deleted");
    assert_eq!(forward.total_additions, backward.total_deletions);

    fs::remove_dir_all(&dir).expect("clean up temp dir");
}

#[test]
fn unknown_oid_is_an_error() {
    let dir = temp_repo("unknown-oid");
    let (_, target) = build_three_state_fixture(&dir);
    let reader = GitReader::new(dir.to_str().unwrap()).expect("open fixture");
    let ghost = "0123456789012345678901234567890123456789";

    let err = reader
        .compare_detail(ghost, &target)
        .expect_err("unknown base must fail");
    assert!(err.contains("not found"), "{}", err);
    let err = reader
        .compare_detail(&target, ghost)
        .expect_err("unknown target must fail");
    assert!(err.contains("not found"), "{}", err);
    assert!(reader.pair_file_diff(ghost, &target, "mod.txt").is_err());
    assert!(reader.pair_file_diff(&target, ghost, "mod.txt").is_err());

    fs::remove_dir_all(&dir).expect("clean up temp dir");
}

#[test]
fn head_branch_follows_symbolic_and_detached_head() {
    let dir = temp_repo("head-branch");
    write(&dir, "a.txt", "one");
    add_and_commit(&dir, "c1");
    git(&dir, &["branch", "feature"]);

    // On main: shorthand of the branch HEAD points at.
    let mut reader = GitReader::new(dir.to_str().unwrap()).expect("open fixture");
    let data = reader.read_git_data(2000).expect("read view").data;
    assert_eq!(data.head_branch.as_deref(), Some("main"));

    git(&dir, &["checkout", "feature"]);
    let mut reader = GitReader::new(dir.to_str().unwrap()).expect("reopen fixture");
    let data = reader.read_git_data(2000).expect("read view").data;
    assert_eq!(data.head_branch.as_deref(), Some("feature"));

    // Detached: no branch name, but HEAD's commit is still in the view.
    git(&dir, &["checkout", "--detach"]);
    let mut reader = GitReader::new(dir.to_str().unwrap()).expect("reopen fixture");
    let data = reader.read_git_data(2000).expect("read view").data;
    assert_eq!(data.head_branch, None, "detached HEAD has no branch name");
    assert!(
        data.commits.iter().any(|c| c.is_head),
        "is_head marking is untouched by head_branch"
    );

    fs::remove_dir_all(&dir).expect("clean up temp dir");
}

#[test]
fn get_commit_detail_still_leaves_per_file_stats_at_zero() {
    // Regression pin: the parent-vs-commit channel keeps its public shape.
    // Per-file numbers stay 0 there; only the compare channel fills them.
    let dir = temp_repo("regression");
    let (base, target) = build_three_state_fixture(&dir);

    let reader = GitReader::new(dir.to_str().unwrap()).expect("open fixture");
    let detail = reader.get_commit_detail(&target).expect("detail");
    assert_eq!(detail.total_additions, 3, "same diff, same totals");
    assert_eq!(detail.total_deletions, 3);
    assert_eq!(detail.files.len(), 3);
    for f in &detail.files {
        assert_eq!(f.additions, 0, "{} must keep additions 0", f.path);
        assert_eq!(f.deletions, 0, "{} must keep deletions 0", f.path);
    }

    // ...and the parent-vs-commit patch channel still works verbatim.
    let patch = reader.get_file_diff(&target, "mod.txt").expect("file diff");
    assert!(patch.contains("+TWO"), "get_file_diff unchanged: {}", patch);
    assert!(patch.contains("-two"), "get_file_diff unchanged: {}", patch);
    // base commit id resolves as before (used by the same channel).
    let base_patch = reader.get_file_diff(&base, "mod.txt").expect("base file diff");
    assert!(base_patch.contains("new file mode"), "root-commit diff: {}", base_patch);

    fs::remove_dir_all(&dir).expect("clean up temp dir");
}
