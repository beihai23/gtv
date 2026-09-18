//! Repo-change poller for the "gtv senses external changes" feature.
//!
//! A plain std thread (started from the builder's `.setup` hook) wakes every
//! 1.5 s, computes `GitReader::change_fingerprint` for every open repository
//! in a short-lived reader (it never touches a session's own reader, so it
//! cannot contend with command-side git work), and emits "repo-changed"
//! with a RepoChanged payload when a fingerprint moved. Deliberately no
//! filesystem watcher: `notify` would add a dependency and fire on
//! transient index lock files, while the timeline only depends on refs +
//! HEAD anyway.
//!
//! Panic safety: the release profile uses `panic = "abort"`, so this
//! forever-thread must never panic — every fallible step is Result-mapped
//! or `continue`d, and the lock `unwrap`s cannot poison (no unwinding).

use std::collections::HashMap;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::commands::AppState;
use crate::git_reader::GitReader;
use crate::models::RepoChanged;

const POLL_INTERVAL: Duration = Duration::from_millis(1500);

pub fn spawn_poller(app: AppHandle) {
    thread::Builder::new()
        .name("repo-watcher".into())
        .spawn(move || poll_loop(app))
        .expect("failed to spawn repo-watcher thread"); // startup-only, no locks held
}

/// Pure diff of two fingerprint snapshots: the repo ids whose fingerprint
/// moved between them. Ids only in `next` are first sights (the caller
/// records their baseline without emitting — a freshly opened repo must
/// never be reported as a change); ids only in `prev` were closed and are
/// simply gone.
pub fn diff_fingerprints(prev: &HashMap<u64, String>, next: &HashMap<u64, String>) -> Vec<u64> {
    next.iter()
        .filter(|(id, fp)| prev.get(id).map_or(false, |p| p != *fp))
        .map(|(id, _)| *id)
        .collect()
}

fn poll_loop(app: AppHandle) {
    loop {
        thread::sleep(POLL_INTERVAL);
        let state = app.state::<AppState>();

        // Snapshot under a short lock: id -> (canonical path, baseline).
        // All git work happens outside the lock in short-lived readers, so
        // commands never wait on the poller.
        let snapshot: Vec<(u64, String, Option<String>)> = {
            let repos = state.repos.lock().unwrap();
            repos
                .iter()
                .map(|(id, s)| (*id, s.path.clone(), s.watch_baseline.clone()))
                .collect()
        };

        // A momentary failure (e.g. the directory being replaced mid-poll)
        // stays quiet — the next tick retries.
        let mut next: HashMap<u64, String> = HashMap::new();
        for (id, path, _) in &snapshot {
            if let Ok(fingerprint) = GitReader::new(path).and_then(|r| r.change_fingerprint()) {
                next.insert(*id, fingerprint);
            }
        }

        let prev: HashMap<u64, String> = snapshot
            .iter()
            .filter_map(|(id, _, baseline)| baseline.clone().map(|fp| (*id, fp)))
            .collect();
        let changed = diff_fingerprints(&prev, &next);

        // Write the baselines back compare-and-set: open_repository resets
        // a session's baseline precisely so a poll racing the open never
        // reports the freshly-opened state, and this write-back must not
        // resurrect the pre-open fingerprint over that reset. Sessions
        // closed mid-poll are skipped (the id is gone). Emits happen after
        // the lock is dropped; first sights only record their baseline.
        let mut emits: Vec<RepoChanged> = Vec::new();
        {
            let mut repos = state.repos.lock().unwrap();
            for (id, path, snapshot_baseline) in &snapshot {
                let Some(fingerprint) = next.get(id) else {
                    continue;
                };
                let Some(session) = repos.get_mut(id) else {
                    continue;
                };
                if session.watch_baseline == *snapshot_baseline {
                    if changed.contains(id) {
                        emits.push(RepoChanged {
                            repo_id: *id,
                            path: path.clone(),
                        });
                    }
                    session.watch_baseline = Some(fingerprint.clone());
                }
            }
        }

        for event in emits {
            log::info!("Repository changed externally: {}", event.path);
            if let Err(e) = app.emit("repo-changed", event) {
                log::warn!("repo-changed emit failed: {}", e);
            }
        }
    }
}
