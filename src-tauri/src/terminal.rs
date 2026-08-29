//! PTY engine for the bottom-docked integrated terminal.
//!
//! One `PtySession` = one login shell spawned via `portable-pty` in the
//! currently open repository. Two detached threads keep it streaming:
//! a *reader* (blocking PTY reads → mpsc) and a *flusher* (coalesces chunks
//! for ~8 ms, then hands one blob to the `on_output` callback). The flusher
//! exists because Tauri events are delivered as one webview eval each —
//! merging bursts keeps `cat bigfile` at ≤ ~125 events/s instead of
//! thousands.
//!
//! The session owns the PTY master and the writer half; dropping it closes
//! the master fd, which SIGHUPs the child, EOFs the reader and lets its
//! `wait()` reap the process. Nothing here joins a thread, so `Drop` can
//! never hang.

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use crate::models::{TerminalExit, TerminalInfo, TerminalOutput};

/// PTY reads chunk at this size; the flusher then merges bursts.
const READ_BUF: usize = 8192;
/// Upper bound for one coalesced output blob (~0.25 s of full-rate output).
const MAX_BLOB: usize = 512 * 1024;
/// How long the flusher waits for follow-up chunks before emitting.
const FLUSH_WINDOW: Duration = Duration::from_millis(8);

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

pub struct PtySession {
    pub id: u64,
    pub cwd: String,
    pub shell: String,
    master: Box<dyn MasterPty + Send>,
    /// Mutex: `terminal_write` may be called while a flusher emit is in
    /// flight on another thread. Safe to `unwrap`: the release profile uses
    /// `panic = "abort"`, so a lock can never be poisoned.
    writer: Mutex<Box<dyn Write + Send>>,
    /// Shared with the reader thread (its `wait()` reaps the child).
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
}

impl PtySession {
    pub fn write_all(&self, data: &str) -> Result<(), String> {
        let mut writer = self.writer.lock().unwrap();
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|e| format!("Terminal write failed: {}", e))
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Terminal resize failed: {}", e))
    }

    pub fn info(&self) -> TerminalInfo {
        let (cols, rows) = self
            .master
            .get_size()
            .map(|s| (s.cols, s.rows))
            .unwrap_or((80, 24));
        TerminalInfo {
            id: self.id,
            cwd: self.cwd.clone(),
            shell: self.shell.clone(),
            cols,
            rows,
        }
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // Best-effort SIGKILL. try_lock, never block: the reader thread may
        // sit inside `wait()` holding this lock for the child's whole life.
        // The guaranteed shutdown path is the master fd closing right after
        // (SIGHUP → child dies → reader EOFs and reaps).
        if let Ok(mut child) = self.child.try_lock() {
            let _ = child.kill();
        }
    }
}

/// Spawn a program on a fresh PTY.
///
/// `on_output`/`on_exit` are plain callbacks so tests can drive this without
/// a Tauri app handle (`spawn_for_app` wires them to `emit`). The ordering
/// below is load-bearing:
/// 1. drop our slave fd right after spawning — otherwise the master read
///    never sees EOF when the child dies (we would hold the PTY open);
/// 2. the reader must be cloned before the writer is taken.
pub fn spawn_pty(
    program: &str,
    args: &[&str],
    cwd: &Path,
    cols: u16,
    rows: u16,
    on_output: impl Fn(u64, Vec<u8>) + Send + Sync + 'static,
    on_exit: impl Fn(u64) + Send + Sync + 'static,
) -> Result<PtySession, String> {
    let id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);

    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| format!("Failed to open PTY: {}", e))?;
    let (master, slave) = (pair.master, pair.slave);

    let mut cmd = CommandBuilder::new(program);
    cmd.args(args);
    cmd.cwd(cwd);
    // CommandBuilder inherits our environment; just pin the terminal type
    // so shell prompts and git colors render as xterm.js expects.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child = slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell `{}`: {}", program, e))?;
    // EOF trap: our copy of the slave fd must not outlive the spawn.
    drop(slave);

    let reader = master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;
    let writer = master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {}", e))?;

    let child = Arc::new(Mutex::new(child));

    // Reader: blocking PTY reads into the channel. Ok(0)/Err = child side
    // closed → reap via wait(), then notify. No fallible call may panic
    // (the release profile aborts the whole process on panic).
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let reader_child = Arc::clone(&child);
    let on_exit = Arc::new(on_exit);
    let exit_cb = Arc::clone(&on_exit);
    std::thread::Builder::new()
        .name(format!("pty-reader-{}", id))
        .spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; READ_BUF];
            loop {
                match reader.read(&mut buf[..]) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break; // flusher gone; nobody listening
                        }
                    }
                }
            }
            drop(tx);
            if let Ok(mut child) = reader_child.lock() {
                let _ = child.wait(); // reap the zombie
            }
            exit_cb(id);
        })
        .map_err(|e| format!("Failed to spawn PTY reader thread: {}", e))?;

    // Flusher: wait out the coalescing window, then drain everything that
    // arrived into one blob (bounded) before invoking on_output.
    let on_output = Arc::new(on_output);
    let output_cb = Arc::clone(&on_output);
    std::thread::Builder::new()
        .name(format!("pty-flusher-{}", id))
        .spawn(move || {
            loop {
                match rx.recv_timeout(FLUSH_WINDOW) {
                    Ok(first) => {
                        let mut blob = first;
                        while blob.len() < MAX_BLOB {
                            match rx.try_recv() {
                                Ok(chunk) => blob.extend_from_slice(&chunk),
                                Err(_) => break,
                            }
                        }
                        output_cb(id, blob);
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        })
        .map_err(|e| format!("Failed to spawn PTY flusher thread: {}", e))?;

    Ok(PtySession {
        id,
        cwd: cwd.to_string_lossy().into_owned(),
        shell: program.to_string(),
        master,
        writer: Mutex::new(writer),
        child,
    })
}

/// $SHELL when it points at an existing file, else the first existing
/// fallback. Pure apart from the existence checks; unit-tested below.
fn pick_shell(shell_env: Option<&str>, fallbacks: &[&str]) -> String {
    if let Some(shell) = shell_env.map(str::trim).filter(|s| !s.is_empty()) {
        if Path::new(shell).exists() {
            return shell.to_string();
        }
    }
    for fallback in fallbacks {
        if Path::new(fallback).exists() {
            return fallback.to_string();
        }
    }
    "/bin/sh".to_string()
}

/// The shell program + args for the integrated terminal. `-l` (login) makes
/// the shell read the user's profile, so PATH is correct even when gtv was
/// launched from Finder/Dock with launchd's sparse environment.
pub fn resolve_login_shell() -> (String, Vec<String>) {
    let program = pick_shell(
        std::env::var("SHELL").ok().as_deref(),
        &["/bin/zsh", "/bin/bash", "/bin/sh"],
    );
    (program, vec!["-l".to_string()])
}

/// Production entry point: spawn the user's login shell on a PTY, streaming
/// output/exit as Tauri events (see models.rs for the event names).
pub fn spawn_for_app(
    app: &tauri::AppHandle,
    cwd: &Path,
    cols: u16,
    rows: u16,
) -> Result<PtySession, String> {
    use tauri::Emitter;

    let (program, args) = resolve_login_shell();
    let emit_output = {
        let app = app.clone();
        move |id: u64, bytes: Vec<u8>| {
            use base64::Engine as _;
            let payload = TerminalOutput {
                id,
                data: base64::engine::general_purpose::STANDARD.encode(&bytes),
            };
            if let Err(e) = app.emit("terminal-output", payload) {
                log::warn!("terminal-output emit failed: {}", e);
            }
        }
    };
    let emit_exit = {
        let app = app.clone();
        move |id: u64| {
            if let Err(e) = app.emit("terminal-exit", TerminalExit { id }) {
                log::warn!("terminal-exit emit failed: {}", e);
            }
        }
    };

    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    spawn_pty(&program, &arg_refs, cwd, cols, rows, emit_output, emit_exit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_shell_prefers_existing_shell_env() {
        assert_eq!(pick_shell(Some("/bin/sh     "), &["/bin/zsh"]), "/bin/sh");
    }

    #[test]
    fn pick_shell_falls_through_missing_shell_env() {
        assert_eq!(pick_shell(Some("/no/such/shell"), &["/bin/zsh", "/bin/bash"]), "/bin/zsh");
        // Blank value counts as unset.
        assert_eq!(pick_shell(Some("   "), &["/bin/bash"]), "/bin/bash");
        assert_eq!(pick_shell(None, &["/bin/bash"]), "/bin/bash");
    }

    #[test]
    fn pick_shell_final_default_is_bin_sh() {
        assert_eq!(pick_shell(None, &[]), "/bin/sh");
    }
}
