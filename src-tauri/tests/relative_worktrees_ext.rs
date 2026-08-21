//! Regression test: repos whose `.git/config` carries
//! `core.repositoryformatversion = 1` + `extensions.relativeWorktrees = true`
//! (what git >= 2.48 `git worktree add --relative-paths` leaves behind)
//! must open and read like any other repo.
//!
//! libgit2 < 1.9.4 rejected the extension outright with
//! "unsupported extension name extensions.relativeWorktrees"; libgit2 1.9.4
//! (upstream PR libgit2#7254) added it to builtin_extensions[]. gtv bundles
//! libgit2 via git2/libgit2-sys, so this test guards the bundled version.

use gtv_lib::git_reader::GitReader;
use std::path::Path;
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
    assert!(status.success(), "git {:?} failed with {}", args, status);
}

#[test]
fn opens_repo_with_extensions_relative_worktrees() {
    let dir = std::env::temp_dir().join(format!(
        "gtv-relative-worktrees-ext-{}",
        std::process::id()
    ));
    // Leftovers of a crashed earlier run would break `git init`.
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create temp dir");

    git(&dir, &["init", "-b", "main"]);
    std::fs::write(dir.join("README.md"), "relative-worktrees fixture\n")
        .expect("write fixture file");
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-m", "initial commit"]);

    // Append exactly what git >= 2.48 `worktree add --relative-paths` writes
    // (verified against git 2.50: the key is `repositoryformatversion`).
    // std::fs, not `git config`, so the fixture is independent of the system
    // git's willingness to write these keys. repositoryformatversion = 1 is
    // essential: libgit2's check_extensions() returns early for version < 1,
    // so omitting it would pass on old libgit2s too — proving nothing.
    let config = dir.join(".git").join("config");
    let mut text = std::fs::read_to_string(&config).expect("read .git/config");
    text.push_str("\n[core]\n\trepositoryformatversion = 1\n[extensions]\n\trelativeWorktrees = true\n");
    std::fs::write(&config, text).expect("append extension config");

    // Before the libgit2 >= 1.9.4 fix this failed with:
    // "Failed to open repository: unsupported extension name
    //  extensions.relativeWorktrees; class=Repository (6)"
    let mut reader = GitReader::new(dir.to_str().unwrap())
        .expect("repo with extensions.relativeWorktrees must open");
    let data = reader.read_git_data(100).expect("read_git_data").data;

    assert_eq!(data.commits.len(), 1, "fixture has exactly one commit");
    assert_eq!(data.main_branch, "main");

    std::fs::remove_dir_all(&dir).expect("clean up temp dir");
}
