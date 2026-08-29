//! Embedded terminal backend: user-driven shell sessions over real PTYs.
//!
//! The frontend hosts xterm.js; this module owns the other end of the wire —
//! spawning the user's login shell inside a portable-pty, streaming output
//! back as "pty-output" events, and forwarding keystrokes/resize as writes.
//! gtv itself stays read-only: the shell is the user's escape hatch, exactly
//! like running Terminal.app next to the window (issue decision).

use crate::models::{PtyExitEvent, PtyOutputEvent};
use portable_pty::{native_pty_system, ChildKiller, MasterPty};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

/// One live PTY: the master handles, plus the child killer so the session
/// can be torn down without racing the wait thread (which owns `child`).
pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

impl PtySession {
    /// Forward keystrokes from xterm.js into the shell.
    pub fn write(&mut self, data: &str) -> Result<(), String> {
        self.writer
            .write_all(data.as_bytes())
            .map(|_| ())
            .map_err(|e| format!("pty write failed: {}", e))
    }

    /// Window resized: re-fit the kernel-side rows/cols.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .resize(portable_pty::PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("pty resize failed: {:#}", anyhow::anyhow!(e)))
    }

    /// Terminate the child (SIGHUP-side of the pair); dropping the session
    /// afterwards closes the master fd for good.
    pub fn kill(&mut self) {
        if let Err(e) = self.killer.kill() {
            log::warn!("pty kill failed: {:#}", e);
        }
    }
}

/// All live sessions, keyed by the id handed to the frontend.
#[derive(Default)]
pub struct PtyRegistry {
    sessions: Mutex<HashMap<u32, PtySession>>,
    next_id: AtomicU32,
}

impl PtyRegistry {
    /// Register a session; returns its id.
    pub fn insert(&self, session: PtySession) -> u32 {
        let id = self.reserve_id();
        self.sessions.lock().unwrap().insert(id, session);
        id
    }

    /// Allocate an id before the session object exists — `pty_spawn` needs
    /// it inside the output/exit callbacks that `spawn_process` receives.
    pub fn reserve_id(&self) -> u32 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// Run `f` on the session behind `id`; None when it is gone.
    pub fn with<T>(&self, id: u32, f: impl FnOnce(&mut PtySession) -> T) -> Option<T> {
        let mut sessions = self.sessions.lock().unwrap();
        sessions.get_mut(&id).map(f)
    }

    /// Take a session out of the map (caller drops/kills it).
    pub fn remove(&self, id: u32) -> Option<PtySession> {
        self.sessions.lock().unwrap().remove(&id)
    }

    /// Kill every child and drop every master (app exit / test teardown —
    /// no orphan shells outlive the window).
    pub fn kill_all(&self) {
        let mut sessions = self.sessions.lock().unwrap();
        for (_, mut session) in sessions.drain() {
            session.kill();
        }
    }
}

/// Drain the longest complete UTF-8 prefix of `buf` as a String, keeping any
/// incomplete multi-byte tail buffered. PTY reads split at byte boundaries,
/// so a 3-byte CJK/emoji codepoint can straddle two `read()` calls; without
/// this the frontend would receive replacement chars. Returns None when the
/// buffer holds no complete character yet.
pub fn drain_utf8(buf: &mut Vec<u8>) -> Option<String> {
    if buf.is_empty() {
        return None;
    }
    match std::str::from_utf8(buf) {
        Ok(s) => {
            let out = s.to_string();
            buf.clear();
            Some(out)
        }
        Err(e) => {
            let n = e.valid_up_to();
            if n == 0 {
                return None;
            }
            let head: Vec<u8> = buf.drain(..n).collect();
            // `n` bytes of valid UTF-8 by construction; `.ok()` not unwrap.
            String::from_utf8(head).ok()
        }
    }
}

/// The shell the terminal runs: $SHELL first, then /bin/zsh, /bin/sh.
/// A non-/bin/sh shell gets `-l` — GUI-launched apps inherit a minimal PATH
/// without /usr/local/bin etc., and a login shell re-sources the user's
/// profile so `git` and friends resolve. Windows uses %COMSPEC%.
pub fn default_shell() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        let prog = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        (prog, Vec::new())
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                if Path::new("/bin/zsh").exists() {
                    "/bin/zsh".to_string()
                } else {
                    "/bin/sh".to_string()
                }
            });
        let args = if shell == "/bin/sh" {
            Vec::new()
        } else {
            vec!["-l".to_string()]
        };
        (shell, args)
    }
}

/// Open a PTY, spawn `program` inside it, and stream its output. Two threads
/// are spawned: a reader that funnels bytes through `on_output` (UTF-8-safe)
/// until EOF, and a waiter that owns `child.wait()` and fires `on_exit`.
/// Threads never unwrap — release builds abort on panic, which would take
/// the whole app down over one dead terminal.
pub fn spawn_process(
    program: &str,
    args: &[String],
    cwd: &Path,
    cols: u16,
    rows: u16,
    on_output: Box<dyn FnMut(String) + Send>,
    on_exit: Box<dyn FnOnce() + Send>,
) -> Result<PtySession, String> {
    let pair = native_pty_system()
        .openpty(portable_pty::PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {:#}", anyhow::anyhow!(e)))?;

    let mut cmd = portable_pty::CommandBuilder::new(program);
    cmd.args(args);
    cmd.cwd(cwd);
    // xterm.js speaks a full ANSI terminal; without TERM the shell drops
    // colors and the frontend renders a washed-out prompt.
    cmd.env("TERM", "xterm-256color");

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn {} failed: {:#}", program, anyhow::anyhow!(e)))?;
    // The slave must be dropped in the parent so closing the master later
    // actually signals EOF to the child instead of keeping a second fd open.
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer failed: {:#}", anyhow::anyhow!(e)))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("try_clone_reader failed: {:#}", anyhow::anyhow!(e)))?;
    let killer = child.clone_killer();

    // Reader loop: 16 KiB chunks, incomplete UTF-8 tails carried across
    // reads by `drain_utf8`, final lossy flush on EOF.
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut on_output = on_output;
        let mut pending: Vec<u8> = Vec::new();
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    if let Some(s) = drain_utf8(&mut pending) {
                        on_output(s);
                    }
                }
                Err(_) => break,
            }
        }
        if !pending.is_empty() {
            on_output(String::from_utf8_lossy(&pending).into_owned());
        }
    });

    // Wait loop: sole owner of child.wait(); fires the exit event exactly once.
    std::thread::spawn(move || {
        if let Err(e) = child.wait() {
            log::warn!("pty child wait failed: {:#}", e);
        }
        on_exit();
    });

    Ok(PtySession {
        master: pair.master,
        writer,
        killer,
    })
}

#[tauri::command]
pub fn pty_spawn(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::commands::AppState>,
    registry: tauri::State<'_, PtyRegistry>,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    use tauri::Emitter;

    let cwd = {
        let current_path = state.current_path.lock().unwrap();
        current_path.clone().ok_or("No repository opened")?
    };

    let (program, args) = default_shell();
    let id = registry.reserve_id();

    let app_output = app.clone();
    let on_output = Box::new(move |data: String| {
        let _ = app_output.emit("pty-output", PtyOutputEvent { id, data });
    });
    let app_exit = app.clone();
    let on_exit = Box::new(move || {
        let _ = app_exit.emit("pty-exit", PtyExitEvent { id });
    });

    let session = spawn_process(
        &program,
        &args,
        Path::new(&cwd),
        cols,
        rows,
        on_output,
        on_exit,
    )?;
    registry.insert(session);
    log::info!("Spawned terminal session {} ({})", id, program);
    Ok(id)
}

#[tauri::command]
pub fn pty_write(
    registry: tauri::State<'_, PtyRegistry>,
    id: u32,
    data: String,
) -> Result<(), String> {
    registry
        .with(id, |s| s.write(&data))
        .unwrap_or_else(|| Err("No such terminal session".to_string()))
}

#[tauri::command]
pub fn pty_resize(
    registry: tauri::State<'_, PtyRegistry>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    registry
        .with(id, |s| s.resize(cols, rows))
        .unwrap_or_else(|| Err("No such terminal session".to_string()))
}

#[tauri::command]
pub fn pty_close(registry: tauri::State<'_, PtyRegistry>, id: u32) -> Result<(), String> {
    if let Some(mut session) = registry.remove(id) {
        session.kill();
    }
    Ok(())
}
