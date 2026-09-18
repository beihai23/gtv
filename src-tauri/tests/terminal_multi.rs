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
use std::sync::{mpsc, Arc};
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
        assert_eq!(
            repos.get(&a.repo_id).unwrap().terminal.as_ref().unwrap().lock().unwrap().id,
            info_a.id
        );
        assert_eq!(
            repos.get(&b.repo_id).unwrap().terminal.as_ref().unwrap().lock().unwrap().id,
            info_b.id
        );
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

/// L-1a: an OPEN repo whose terminal was never spawned rejects
/// write/resize/kill with the exact slot error. Error precedence pinned
/// too: the "No repository opened" routing check fires first, the
/// "No terminal session" slot check only after it passes.
#[test]
fn open_repo_without_terminal_rejects_write_resize_kill() {
    let dir = build_repo("noterm");
    let state = AppState::default();
    let repo = open(&state, &dir);
    let bogus = repo.repo_id + 999;

    // Routing first: unknown ids report the registry error for all three.
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
    // Then the slot check on the OPEN repo.
    assert_eq!(
        terminal_write_impl(&state, repo.repo_id, "x".to_string()).unwrap_err(),
        "No terminal session"
    );
    assert_eq!(
        terminal_resize_impl(&state, repo.repo_id, 80, 24).unwrap_err(),
        "No terminal session"
    );
    assert_eq!(
        terminal_kill_impl(&state, repo.repo_id).unwrap_err(),
        "No terminal session"
    );

    std::fs::remove_dir_all(&dir).expect("clean up temp dir");
}

/// L-1b (deviation 1 semantics): a spawn that straddles a close must fail
/// the routing re-check with "No repository opened" AND the session the
/// spawner produced must be dropped (child killed, exit callback fired)
/// instead of leaking behind the closed repo. The delayed spawner signals
/// when the spawn is inside its delay, so the close provably lands
/// mid-spawn rather than before it.
#[test]
fn spawn_straddling_close_errors_and_kills_new_session() {
    let dir = build_repo("straddle");
    let state = Arc::new(AppState::default());
    let a = open(&state, &dir);

    let (entered_tx, entered_rx) = mpsc::channel::<()>();
    let (exit_tx, exit_rx) = mpsc::channel::<u64>();
    let spawner = move |path: PathBuf, cols: u16, rows: u16| {
        let _ = entered_tx.send(());
        std::thread::sleep(Duration::from_millis(200));
        spawn_pty(
            "/bin/sh",
            &["-c", "sleep 30"],
            &path,
            cols,
            rows,
            |_, _| {},
            move |id| {
                let _ = exit_tx.send(id);
            },
        )
    };

    let spawn_state = Arc::clone(&state);
    let (result_tx, result_rx) = mpsc::channel::<Result<gtv_lib::models::TerminalInfo, String>>();
    let spawn_thread = std::thread::spawn(move || {
        let _ = result_tx.send(run(spawn_terminal_in_repo(
            &spawn_state,
            a.repo_id,
            80,
            24,
            spawner,
        )));
    });

    // Close while the spawner sits in its 200ms delay: the spawn has
    // passed its fast path, so only the insert re-check can catch the
    // close — exactly the straddled-window semantics under test.
    entered_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("spawner must start");
    close_repository_impl(&state, a.repo_id).expect("close a");

    let result = result_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("spawn must answer after the close");
    assert_eq!(result.unwrap_err(), "No repository opened");

    // The straddled session was dropped, not leaked: its child died and
    // the exit callback fired with the session's own id.
    let exited = exit_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("straddled spawn's session must be killed, not leaked");
    assert!(exited >= 1, "exit callback carries the session id");
    spawn_thread.join().expect("spawn thread must finish");

    std::fs::remove_dir_all(&dir).expect("clean up temp dir");
}

/// I-1 regression: a wedged pty write must hold only the per-session
/// terminal lock. The child puts its tty in raw mode and then never reads
/// stdin (`stty raw; sleep` — a paused TUI app), so an MBs-scale write
/// fills the tty input queue and blocks inside write_all until the child
/// dies. While that write is wedged, the GLOBAL registry must stay
/// responsive: opening a second repo completes within a generous bound.
/// Under the old shape (write_all while holding the repos lock) this
/// deadlocks and the bounded open times out.
///
/// Hang safety: the wedged writer runs on a detached thread the test
/// never joins. The child is `sleep 10`, so even if nothing else
/// intervened the write errors out and the thread exits within 10s; the
/// kill below drops the registry's Arc, and the writer's cloned Arc keeps
/// the session alive at most until that same 10s bound. Process exit
/// closes the master fd regardless. No code path of this test can block
/// the suite's exit.
#[test]
fn wedged_pty_write_does_not_freeze_the_registry() {
    let dir_a = build_repo("wedge-a");
    let dir_b = build_repo("wedge-b");
    let state = Arc::new(AppState::default());
    let a = open(&state, &dir_a);
    let a_id = a.repo_id;
    let b_path = dir_b
        .to_str()
        .expect("temp dir must be valid UTF-8")
        .to_string();

    // Raw-mode child that never reads: with the tty in raw mode the
    // kernel stops accepting master writes once the input queue fills
    // (verified on macOS; canonical mode instead DISCARDS the overflow
    // and the write completes — so the fixture must pin raw mode before
    // the payload starts). The child prints a marker right after stty,
    // and the test waits for it: the wedge then starts from a proven
    // raw-mode tty instead of racing the child's exec.
    let (exit_tx, exit_rx) = mpsc::channel::<u64>();
    let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
    let spawner = move |path: PathBuf, cols: u16, rows: u16| {
        spawn_pty(
            "/bin/sh",
            &["-c", "stty raw -echo; printf rawset; sleep 10"],
            &path,
            cols,
            rows,
            move |_, bytes| {
                let _ = out_tx.send(bytes);
            },
            move |id| {
                let _ = exit_tx.send(id);
            },
        )
    };
    run(spawn_terminal_in_repo(&state, a_id, 80, 24, spawner)).expect("spawn wedged session");
    let handshake = wait_for_output(&out_rx, "rawset", Duration::from_secs(5));
    assert!(
        handshake.contains("rawset"),
        "child must confirm raw mode before the wedged write starts, got: {:?}",
        handshake
    );

    // Detached wedged writer: clones the handle out of the registry under
    // the repos lock, then blocks on the full tty queue for as long as
    // the child lives.
    let writer_state = Arc::clone(&state);
    std::thread::spawn(move || {
        let payload = "x".repeat(8 * 1024 * 1024);
        let _ = terminal_write_impl(&writer_state, a_id, payload);
    });
    // Let the writer fill the tty queue and enter the blocked write.
    std::thread::sleep(Duration::from_millis(300));

    // The assertion: while the write is wedged, the registry answers.
    let opener_state = Arc::clone(&state);
    let (open_tx, open_rx) = mpsc::channel::<Result<gtv_lib::models::OpenedRepo, String>>();
    std::thread::spawn(move || {
        let _ = open_tx.send(run(open_repository_impl(&opener_state, b_path, true)));
    });
    let opened = open_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("open must complete while a pty write is wedged (registry lock stays free)")
        .expect("open repo b");
    assert_ne!(opened.repo_id, a_id);

    // Sanity: the writer is genuinely wedged — the child is still alive.
    assert!(
        matches!(exit_rx.try_recv(), Err(mpsc::TryRecvError::Empty)),
        "child must still be alive while the write is wedged"
    );

    // Kill the registry slot first; the wedged writer's cloned Arc may
    // keep the child alive until its bounded sleep expires, so the test
    // deliberately does NOT wait on the exit callback or join the writer.
    terminal_kill_impl(&state, a_id).expect("kill wedged session");
    std::fs::remove_dir_all(&dir_a).expect("clean up temp dir");
    std::fs::remove_dir_all(&dir_b).expect("clean up temp dir");
}
