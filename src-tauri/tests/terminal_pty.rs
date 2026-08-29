//! PTY engine smoke tests (`terminal::spawn_pty`): a `/bin/sh` one-liner
//! must stream its output through the reader→flusher pipeline, every spawn
//! gets a fresh session id, and dropping a session tears everything down
//! without hanging. This is why `spawn_pty` takes plain callbacks instead
//! of a Tauri app handle.

#![cfg(unix)]

use gtv_lib::terminal::spawn_pty;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("gtv-pty-{}-{}", name, std::process::id()));
    std::fs::create_dir_all(&dir).expect("failed to create temp dir");
    dir
}

/// Collect everything the session outputs, up to `deadline`.
fn drain_output(rx: &mpsc::Receiver<Vec<u8>>, deadline: Duration) -> Vec<u8> {
    let start = Instant::now();
    let mut out = Vec::new();
    while start.elapsed() < deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(chunk) => out.extend_from_slice(&chunk),
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    out
}

#[test]
fn spawn_pty_streams_output_and_reports_exit() {
    let cwd = temp_dir("stream");
    let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
    let (exit_tx, exit_rx) = mpsc::channel::<u64>();

    let session = spawn_pty(
        "/bin/sh",
        &["-c", "printf hello-from-pty"],
        &cwd,
        80,
        24,
        move |_id, bytes| {
            let _ = out_tx.send(bytes);
        },
        move |id| {
            let _ = exit_tx.send(id);
        },
    )
    .expect("spawn failed");

    let id = session.id;
    let output = drain_output(&out_rx, Duration::from_secs(5));
    assert!(
        String::from_utf8_lossy(&output).contains("hello-from-pty"),
        "expected marker in output, got: {:?}",
        String::from_utf8_lossy(&output)
    );

    // The shell exits on its own: the exit callback fires with the session
    // id the frontend uses to attribute "terminal-exit".
    let exited_id = exit_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("no exit callback within 5s");
    assert_eq!(exited_id, id);

    // Dropping a dead session must not hang (Drop kill is best-effort).
    drop(session);
}

#[test]
fn spawn_pty_sessions_get_increasing_ids() {
    let cwd = temp_dir("ids");
    let noop = |_: u64, _: Vec<u8>| {};
    let noop_exit = |_: u64| {};
    let first = spawn_pty("/bin/sh", &["-c", "true"], &cwd, 80, 24, noop, noop_exit)
        .expect("first spawn failed");
    let second = spawn_pty("/bin/sh", &["-c", "true"], &cwd, 80, 24, noop, noop_exit)
        .expect("second spawn failed");
    assert!(second.id > first.id, "ids must increase");
    drop((first, second));
}

#[test]
fn dropping_a_live_session_shuts_the_child_down() {
    let cwd = temp_dir("kill");
    let (exit_tx, exit_rx) = mpsc::channel::<u64>();
    let session = spawn_pty(
        "/bin/sh",
        &["-c", "sleep 30"],
        &cwd,
        80,
        24,
        |_, _| {},
        move |id| {
            let _ = exit_tx.send(id);
        },
    )
    .expect("spawn failed");

    // The child is alive and would run for 30s; Drop must cut that short.
    drop(session);
    exit_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("drop did not terminate the session within 5s");
}

#[test]
fn spawn_pty_runs_in_the_given_cwd() {
    let cwd = temp_dir("cwd");
    let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
    let session = spawn_pty(
        "/bin/sh",
        &["-c", "pwd"],
        &cwd,
        80,
        24,
        move |_id, bytes| {
            let _ = out_tx.send(bytes);
        },
        |_: u64| {},
    )
    .expect("spawn failed");

    let output = drain_output(&out_rx, Duration::from_secs(5));
    let text = String::from_utf8_lossy(&output);
    // /tmp may be a symlink (macOS /private/tmp); compare canonically.
    let printed = PathBuf::from(text.trim());
    let canonical_cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.clone());
    let canonical_printed = printed.canonicalize().unwrap_or(printed);
    assert_eq!(canonical_printed, canonical_cwd, "pwd printed {}", text.trim());
    drop(session);
}
