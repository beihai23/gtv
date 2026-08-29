//! Repo-change poller for the "gtv senses external changes" feature.
//!
//! A plain std thread (started from the builder's `.setup` hook) wakes every
//! 1.5 s, computes `GitReader::change_fingerprint` for the currently open
//! repository in a short-lived reader (it never touches the AppState repo
//! handle, so it cannot contend with command-side git work), and emits
//! "repo-changed" when the fingerprint moved. Deliberately no filesystem
//! watcher: `notify` would add a dependency and fire on transient index
//! lock files, while the timeline only depends on refs + HEAD anyway.
//!
//! Panic safety: the release profile uses `panic = "abort"`, so this
//! forever-thread must never panic — every fallible step is Result-mapped
//! or `continue`d, and the lock `unwrap`s cannot poison (no unwinding).

use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::commands::AppState;
use crate::git_reader::GitReader;

const POLL_INTERVAL: Duration = Duration::from_millis(1500);

pub fn spawn_poller(app: AppHandle) {
    thread::Builder::new()
        .name("repo-watcher".into())
        .spawn(move || poll_loop(app))
        .expect("failed to spawn repo-watcher thread"); // startup-only, no locks held
}

fn poll_loop(app: AppHandle) {
    loop {
        thread::sleep(POLL_INTERVAL);
        let state = app.state::<AppState>();
        let path = state.current_path.lock().unwrap().clone();
        let Some(path) = path else {
            *state.watch_baseline.lock().unwrap() = None;
            continue;
        };

        // A momentary failure (e.g. the directory being replaced mid-poll)
        // stays quiet — the next tick retries.
        let fingerprint = match GitReader::new(&path).and_then(|r| r.change_fingerprint()) {
            Ok(fingerprint) => fingerprint,
            Err(_) => continue,
        };

        let mut baseline = state.watch_baseline.lock().unwrap();
        match baseline.take() {
            // Same repo as last tick: compare, emit on a real change.
            Some((prev_path, prev_fp)) if prev_path == path => {
                if prev_fp != fingerprint {
                    log::info!("Repository changed externally: {}", path);
                    if let Err(e) = app.emit("repo-changed", path.clone()) {
                        log::warn!("repo-changed emit failed: {}", e);
                    }
                    *baseline = Some((path, fingerprint));
                } else {
                    *baseline = Some((prev_path, prev_fp));
                }
            }
            // First sight or a freshly opened repo: baseline only, no emit.
            _ => *baseline = Some((path, fingerprint)),
        }
    }
}
