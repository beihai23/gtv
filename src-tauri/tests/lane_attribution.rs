//! Lane-attribution integration tests on real repositories built with the
//! git CLI: branch-from-branch ownership with merge evidence (R2), and the
//! two-pass filter_by_branches ancestor-lane closure.

use gtv_lib::git_reader::GitReader;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Run git in `dir` with both commit dates pinned. Identity/gpg overrides
/// are inline so the test works with no global git config.
fn git_at(dir: &Path, date: &str, args: &[&str]) {
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
        .env("GIT_AUTHOR_DATE", date)
        .env("GIT_COMMITTER_DATE", date)
        .status()
        .expect("failed to spawn git");
    assert!(status.success(), "git {:?} failed", args);
}

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

fn temp_repo(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("gtv-lane-{}-{}", name, std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create temp dir");
    git_at(&dir, "2025-09-01T09:00:00", &["init", "-b", "main"]);
    dir
}

/// One file, one commit, at a pinned date. Returns the commit oid.
fn commit_at(dir: &Path, file: &str, contents: &str, msg: &str, date: &str) -> String {
    fs::write(dir.join(file), contents).expect("write file");
    git_at(dir, date, &["add", "-A"]);
    git_at(dir, date, &["commit", "-m", msg]);
    git_out(dir, &["rev-parse", "HEAD"])
}

/// The repro3 structure plus merge evidence: feat/A forks from main, feat/B
/// forks from feat/A mid-way, then feat/B is merged back into feat/A. The
/// merge makes feat/A the proven destination: A's internal commits (A1, A2)
/// must belong to feat/A and B's fork point must sit on feat/A's lane —
/// before the fix the newer-tipped feat/B claimed A1 and the parent/child
/// relation inverted.
#[test]
fn branch_from_branch_with_merge_evidence_attributes_parent_lane() {
    let dir = temp_repo("repro3-merge");
    let m1 = commit_at(&dir, "f.txt", "m1\n", "M1", "2025-09-01T09:00:00");
    git_at(&dir, "2025-09-02T09:00:00", &["checkout", "-b", "feat/A"]);
    let a1 = commit_at(&dir, "f.txt", "a1\n", "A1", "2025-09-02T09:00:00");
    let a2 = commit_at(&dir, "f.txt", "a2\n", "A2", "2025-09-04T09:00:00");
    git_at(&dir, "2025-09-03T09:00:00", &["checkout", "-b", "feat/B", &a1]);
    let b1 = commit_at(&dir, "b.txt", "b1\n", "B1", "2025-09-03T09:00:00");
    let b2 = commit_at(&dir, "b.txt", "b2\n", "B2", "2025-09-06T09:00:00");
    git_at(&dir, "2025-09-07T09:00:00", &["checkout", "feat/A"]);
    git_at(
        &dir,
        "2025-09-07T09:00:00",
        &["merge", "--no-ff", "feat/B", "-m", "merge B into A"],
    );
    let merge = git_out(&dir, &["rev-parse", "HEAD"]);

    let mut reader = GitReader::new(dir.to_str().unwrap()).expect("open fixture");
    let view = reader.read_git_data(2000).expect("read view");
    let owner = |id: &str| {
        view.data
            .commits
            .iter()
            .find(|c| c.id == id)
            .unwrap_or_else(|| panic!("commit {id} not in view"))
            .lane_owner
            .clone()
    };

    assert_eq!(owner(&m1), "main");
    assert_eq!(owner(&a1), "feat/A", "A's internal commit must stay on A");
    assert_eq!(owner(&a2), "feat/A");
    assert_eq!(owner(&merge), "feat/A");
    assert_eq!(owner(&b1), "feat/B");
    assert_eq!(owner(&b2), "feat/B");

    let lane_b = view
        .data
        .branches
        .iter()
        .find(|l| l.name == "feat/B")
        .expect("feat/B lane");
    assert_eq!(lane_b.fork_point.as_deref(), Some(a1.as_str()));
    assert_eq!(
        owner(&a1),
        "feat/A",
        "B's fork point must render on feat/A's lane"
    );
    let lane_a = view
        .data
        .branches
        .iter()
        .find(|l| l.name == "feat/A")
        .expect("feat/A lane");
    assert_eq!(lane_a.fork_point.as_deref(), Some(m1.as_str()));

    fs::remove_dir_all(&dir).expect("clean up temp dir");
}

/// Filtered view without main selected: pass 1 (full view) must supply the
/// ancestor-lane closure so A's and B's fork edges still anchor on the real
/// main lane instead of on whichever selected branch walked main's commits
/// first.
#[test]
fn filtered_view_anchors_forks_on_unselected_main() {
    let dir = temp_repo("filter-closure");
    let m1 = commit_at(&dir, "f.txt", "m1\n", "M1", "2025-09-01T09:00:00");
    git_at(&dir, "2025-09-02T09:00:00", &["checkout", "-b", "feat/A"]);
    let a1 = commit_at(&dir, "a.txt", "a1\n", "A1", "2025-09-02T09:00:00");
    git_at(&dir, "2025-09-03T09:00:00", &["checkout", "-b", "feat/B", &m1]);
    let b1 = commit_at(&dir, "b.txt", "b1\n", "B1", "2025-09-03T09:00:00");
    git_at(&dir, "2025-09-05T09:00:00", &["checkout", "main"]);
    let m2 = commit_at(&dir, "f.txt", "m2\n", "M2", "2025-09-05T09:00:00");

    let mut reader = GitReader::new(dir.to_str().unwrap()).expect("open fixture");
    let view = reader
        .filter_by_branches(&["feat/A".to_string(), "feat/B".to_string()])
        .expect("filtered view");
    let owner = |id: &str| {
        view.data
            .commits
            .iter()
            .find(|c| c.id == id)
            .unwrap_or_else(|| panic!("commit {id} not in view"))
            .lane_owner
            .clone()
    };

    // main is render context: its lane is present and owns its commits.
    assert!(
        view.data.branches.iter().any(|l| l.name == "main"),
        "main lane must be present as context"
    );
    assert_eq!(owner(&m1), "main");
    assert_eq!(owner(&m2), "main");
    assert_eq!(owner(&a1), "feat/A");
    assert_eq!(owner(&b1), "feat/B");

    for name in ["feat/A", "feat/B"] {
        let lane = view
            .data
            .branches
            .iter()
            .find(|l| l.name == name)
            .unwrap_or_else(|| panic!("lane {name}"));
        let fp = lane.fork_point.as_deref().expect("fork point");
        assert_eq!(fp, m1, "{name} forks from M1");
        assert_eq!(owner(fp), "main", "{name}'s fork edge must anchor on main");
    }

    fs::remove_dir_all(&dir).expect("clean up temp dir");
}
