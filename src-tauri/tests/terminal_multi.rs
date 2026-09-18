//! Per-repo terminal sessions (spec 4.2 / 3): every terminal command routes
//! through repo_id into that repo's RepoSession.terminal, so each tab owns
//! an independent PTY. These tests drive `spawn_terminal_in_repo` with
//! plain-callback `spawn_pty` spawners (the terminal_pty.rs pattern) — the
//! production command only differs by wiring those callbacks to Tauri
//! events. Killing via kill or tab close must drop the session (the child
//! dies with it) without touching the other tab's session.

#![cfg(unix)]

use gtv_lib::commands::{
    close_repository_impl, open_repository_impl, spawn_terminal_in_repo, terminal_kill_impl,
    terminal_resize_impl, terminal_write_impl, AppState,
};
use gtv_lib::terminal::{spawn_pty, PtySession};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Run git in `dir` with inline identity overrides so the fixture works on
/// machines with no global git config (or commit.gpgsign on).
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

/// Minimal openable fixture: one commit on main. The terminal only needs
/// the repo to be registered; the view content is irrelevant here. One
/// directory per test (cargo runs tests in parallel threads).
fn build_repo(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("gtv-termulti-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create temp dir");
    git(&dir, &["init", "-b", "main"]);
    git(&dir, &["commit", "--allow-empty", "-m", "seed"]);
    dir
}

/// Drive an async *_impl on a throwaway runtime (the impls use
/// spawn_blocking, so they need a tokio context, never a tauri one).
fn run<F: std::future::Future>(fut: F) -> F::Output {
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(fut)
}

fn open(state: &AppState, path: &Path) -> gtv_lib::models::OpenedRepo {
    run(open_repository_impl(
        state,
        path.to_str().expect("temp dir must be valid UTF-8").to_string(),
        true,
    ))
    .expect("open repository")
}

/// Spawner that runs a persistent `/bin/sh` (no -c: it keeps reading
/// commands from the PTY) and streams output/exit into channels.
fn interactive_sh()
-> (
    impl FnOnce(PathBuf, u16, u16) -> Result<PtySession, String>,
    mpsc::Receiver<Vec<u8>>,
    mpsc::Receiver<u64>,
) {
    let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
    let (exit_tx, exit_rx) = mpsc::channel::<u64>();
    (
        move |path: PathBuf, cols: u16, rows: u16| {
            spawn_pty(
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
        },
        out_rx,
        exit_rx,
    )
}

/// Collect output until `needle` appears or the deadline passes; returns
/// everything seen (terminal_pty.rs collection pattern).
fn wait_for_output(rx: &mpsc::Receiver<Vec<u8>>, needle: &str, timeout: Duration) -> String {
    let start = Instant::now();
    let mut out = String::new();
    while start.elapsed() < timeout {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(chunk) => {
                out.push_str(&String::from_utf8_lossy(&chunk));
                if out.contains(needle) {
                    return out;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    out
}

/// Collect whatever arrives within a fixed window (negative assertions:
/// give a cross-talk marker time to show up before declaring it absent).
fn drain_window(rx: &mpsc::Receiver<Vec<u8>>, window: Duration) -> String {
    let start = Instant::now();
    let mut out = String::new();
    while start.elapsed() < window {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(chunk) => out.push_str(&String::from_utf8_lossy(&chunk)),
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    out
}

#[test]
fn two_repos_spawn_independent_terminal_ids() {
    let dir_a = build_repo("ids-a");
    let dir_b = build_repo("ids-b");
    let state = AppState::default();
    let a = open(&state, &dir_a);
    let b = open(&state, &dir_b);

    let (spawner_a, _out_a, _exit_a) = interactive_sh();
    let (spawner_b, _out_b, _exit_b) = interactive_sh();
    let info_a = run(spawn_terminal_in_repo(&state, a.repo_id, 80, 24, spawner_a))
        .expect("spawn terminal for a");
    let info_b = run(spawn_terminal_in_repo(&state, b.repo_id, 80, 24, spawner_b))
        .expect("spawn terminal for b");

    // Distinct, increasing session ids (global counter, sequential spawns).
    assert_ne!(info_a.id, info_b.id);
    assert!(info_b.id > info_a.id, "ids must increase across spawns");

    // Both sessions are stored under their OWN repo slot, not one global.
    {
        let repos = state.repos.lock().unwrap();
        assert_eq!(repos.get(&a.repo_id).unwrap().terminal.as_ref().unwrap().id, info_a.id);
        assert_eq!(repos.get(&b.repo_id).unwrap().terminal.as_ref().unwrap().id, info_b.id);
    }

    std::fs::remove_dir_all(&dir_a).expect("clean up temp dir");
    std::fs::remove_dir_all(&dir_b).expect("clean up temp dir");
}

#[test]
fn terminal_output_stays_scoped_to_its_repo() {
    let dir_a = build_repo("iso-a");
    let dir_b = build_repo("iso-b");
    let state = AppState::default();
    let a = open(&state, &dir_a);
    let b = open(&state, &dir_b);

    let (spawner_a, out_a, _exit_a) = interactive_sh();
    let (spawner_b, out_b, _exit_b) = interactive_sh();
    run(spawn_terminal_in_repo(&state, a.repo_id, 80, 24, spawner_a)).expect("spawn a");
    run(spawn_terminal_in_repo(&state, b.repo_id, 80, 24, spawner_b)).expect("spawn b");

    // Each tab's marker goes through its own repo route and comes back on
    // that session's callback only.
    terminal_write_impl(&state, a.repo_id, "printf marker-a-4f7\n".to_string())
        .expect("write a");
    let a_out = wait_for_output(&out_a, "marker-a-4f7", Duration::from_secs(10));
    assert!(
        a_out.contains("marker-a-4f7"),
        "a's session must echo a's marker, got: {:?}",
        a_out
    );

    terminal_write_impl(&state, b.repo_id, "printf marker-b-9c2\n".to_string())
        .expect("write b");
    let b_out = wait_for_output(&out_b, "marker-b-9c2", Duration::from_secs(10));
    assert!(
        b_out.contains("marker-b-9c2"),
        "b's session must echo b's marker, got: {:?}",
        b_out
    );

    // No cross-talk: neither output stream carries the OTHER repo's marker.
    let b_quiet = drain_window(&out_b, Duration::from_millis(1500));
    let a_quiet = drain_window(&out_a, Duration::from_millis(1500));
    let b_all = format!("{}{}", b_out, b_quiet);
    let a_all = format!("{}{}", a_out, a_quiet);
    assert!(
        !b_all.contains("marker-a-4f7"),
        "b must not see a's marker, got: {:?}",
        b_all
    );
    assert!(
        !a_all.contains("marker-b-9c2"),
        "a must not see b's marker, got: {:?}",
        a_all
    );

    std::fs::remove_dir_all(&dir_a).expect("clean up temp dir");
    std::fs::remove_dir_all(&dir_b).expect("clean up temp dir");
}

#[test]
fn close_repository_kills_only_that_terminal() {
    let dir_a = build_repo("close-a");
    let dir_b = build_repo("close-b");
    let state = AppState::default();
    let a = open(&state, &dir_a);
    let b = open(&state, &dir_b);

    // A's shell would run for 30s; closing the tab must cut that short
    // (drop-kill, terminal_pty.rs assertion style).
    let (exit_a_tx, exit_a_rx) = mpsc::channel::<u64>();
    let spawner_a = move |path: PathBuf, cols: u16, rows: u16| {
        spawn_pty(
            "/bin/sh",
            &["-c", "sleep 30"],
            &path,
            cols,
            rows,
            |_, _| {},
            move |id| {
                let _ = exit_a_tx.send(id);
            },
        )
    };
    let (spawner_b, _out_b, exit_b_rx) = interactive_sh();
    let info_a = run(spawn_terminal_in_repo(&state, a.repo_id, 80, 24, spawner_a))
        .expect("spawn terminal for a");
    run(spawn_terminal_in_repo(&state, b.repo_id, 80, 24, spawner_b)).expect("spawn terminal for b");

    close_repository_impl(&state, a.repo_id).expect("close a");

    // The closed tab's child died with the removed session.
    let exited = exit_a_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("close must terminate a's terminal within 5s");
    assert_eq!(exited, info_a.id);

    // A's route is gone entirely: repo-level error, not a PTY error.
    assert_eq!(
        terminal_write_impl(&state, a.repo_id, "x".to_string()).unwrap_err(),
        "No repository opened"
    );
    assert_eq!(
        terminal_resize_impl(&state, a.repo_id, 80, 24).unwrap_err(),
        "No repository opened"
    );

    // B's session survived the close untouched: still writable, still alive.
    terminal_write_impl(&state, b.repo_id, "printf still-here\n".to_string())
        .expect("write b after a's close");
    assert!(
        matches!(exit_b_rx.try_recv(), Err(mpsc::TryRecvError::Empty)),
        "b's terminal must still be alive"
    );

    std::fs::remove_dir_all(&dir_a).expect("clean up temp dir");
    std::fs::remove_dir_all(&dir_b).expect("clean up temp dir");
}

#[test]
fn spawn_is_idempotent_per_repo_until_kill() {
    let dir_a = build_repo("idem-a");
    let state = AppState::default();
    let a = open(&state, &dir_a);

    let (spawner_a, _out_a, _exit_a) = interactive_sh();
    let first = run(spawn_terminal_in_repo(&state, a.repo_id, 80, 24, spawner_a))
        .expect("first spawn for a");

    // Remount (StrictMode double-mount): the live session is returned
    // as-is. The spawner here must never run — its error fails the test.
    let second = run(spawn_terminal_in_repo(&state, a.repo_id, 80, 24, |_p, _c, _r| {
        Err("idempotent spawn must not create a second session".to_string())
    }))
    .expect("second spawn for a returns the live session");
    assert_eq!(second.id, first.id, "second spawn must reuse the session id");

    // Kill clears the slot; the next spawn is a NEW session (restart).
    terminal_kill_impl(&state, a.repo_id).expect("kill a");
    let (spawner_again, _out_again, _exit_again) = interactive_sh();
    let third = run(spawn_terminal_in_repo(&state, a.repo_id, 80, 24, spawner_again))
        .expect("respawn a after kill");
    assert!(
        third.id > first.id,
        "respawn after kill must be a fresh session ({} > {})",
        third.id,
        first.id
    );

    std::fs::remove_dir_all(&dir_a).expect("clean up temp dir");
}

#[test]
fn unknown_repo_id_rejected_by_all_terminal_commands() {
    let dir = build_repo("unknown");
    let state = AppState::default();
    let repo = open(&state, &dir);
    let bogus = repo.repo_id + 999;

    // Spawn: rejected before any PTY is created (the spawner errors if run).
    assert_eq!(
        run(spawn_terminal_in_repo(&state, bogus, 80, 24, |_p, _c, _r| {
            Err("spawner must not run for an unknown repo".to_string())
        }))
        .unwrap_err(),
        "No repository opened"
    );
    assert_eq!(
        terminal_write_impl(&state, bogus, "x".to_string()).unwrap_err(),
        "No repository opened"
    );
    assert_eq!(
        terminal_resize_impl(&state, bogus, 80, 24).unwrap_err(),
        "No repository opened"
    );
    assert_eq!(
        terminal_kill_impl(&state, bogus).unwrap_err(),
        "No repository opened"
    );

    std::fs::remove_dir_all(&dir).expect("clean up temp dir");
}
