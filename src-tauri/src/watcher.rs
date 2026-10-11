//! Repo-change poller for the "gtv senses external changes" feature.
//!
//! A plain std thread (started from the builder's `.setup` hook) wakes every
//! 1.5 s, computes `GitReader::change_fingerprint` for every open repository
//! in a short-lived reader (it never touches a session's own reader, so it
//! cannot contend with command-side git work), and emits "repo-changed"
//! with a RepoChanged payload when a fingerprint moved. A session whose
//! fingerprint fails AND whose directory is gone from disk is reported
//! once per tick through "repo-missing" (same payload) instead of being
//! retried silently forever. Deliberately no
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

use crate::commands::{AppState, RepoSession};
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

/// The events one apply_fingerprints pass wants emitted: `changed` carries
/// the repo-changed payloads, `missing` the repo-missing ones (sessions
/// whose fingerprint failed AND whose directory no longer exists).
pub struct ApplyOutcome {
    pub changed: Vec<RepoChanged>,
    pub missing: Vec<RepoChanged>,
}

/// One poll's compare-and-set write-back (final-review FR-L6 test seam,
/// extracted from poll_loop): for each session still registered, write
/// the freshly computed fingerprint -- and report a RepoChanged event --
/// ONLY when the session's baseline still equals the baseline the
/// snapshot carried. That CAS keeps a poll racing open_repository honest:
/// open resets the baseline precisely so the freshly-opened state is
/// never reported as a change, and a stale snapshot (taken before the
/// reset) must neither resurrect its old baseline over the reset value
/// nor emit. Sessions closed mid-poll (id gone from the map) and repos
/// whose fingerprint could not be computed (absent from `next`) are
/// skipped -- with one exception: a session whose fingerprint failed AND
/// whose directory is gone from disk is reported in `missing` (and its
/// cached attribution dropped, same invalidation as a change), so the
/// frontend can react to an externally deleted worktree instead of
/// silently retrying forever. A failure with the directory still present
/// (the repo being replaced mid-poll) stays quiet. Pure over its
/// arguments so the race is unit-testable without a Tauri app.
pub fn apply_fingerprints(
    repos: &mut HashMap<u64, RepoSession>,
    snapshot: &[(u64, String, Option<String>)],
    next: &HashMap<u64, String>,
    changed: &[u64],
) -> ApplyOutcome {
    let mut outcome = ApplyOutcome {
        changed: Vec::new(),
        missing: Vec::new(),
    };
    for (id, path, snapshot_baseline) in snapshot {
        let Some(fingerprint) = next.get(id) else {
            if !std::path::Path::new(path).exists() {
                if let Some(session) = repos.get_mut(id) {
                    session.attribution = None;
                    outcome.missing.push(RepoChanged {
                        repo_id: *id,
                        path: path.clone(),
                    });
                }
            }
            continue;
        };
        let Some(session) = repos.get_mut(id) else {
            continue;
        };
        if session.watch_baseline == *snapshot_baseline {
            if changed.contains(id) {
                // The cached fork-ancestry attribution is a function of
                // refs+DAG, so any detected change invalidates it: filters
                // fall back to the cold pass until the refresh rebuilds it.
                session.attribution = None;
                outcome.changed.push(RepoChanged {
                    repo_id: *id,
                    path: path.clone(),
                });
            }
            session.watch_baseline = Some(fingerprint.clone());
        }
    }
    outcome
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

        // Write the baselines back through the CAS seam (see
        // apply_fingerprints); emits happen after the lock is dropped.
        let outcome = {
            let mut repos = state.repos.lock().unwrap();
            apply_fingerprints(&mut repos, &snapshot, &next, &changed)
        };

        for event in outcome.missing {
            log::info!("Repository directory disappeared: {}", event.path);
            if let Err(e) = app.emit("repo-missing", event) {
                log::warn!("repo-missing emit failed: {}", e);
            }
        }
        for event in outcome.changed {
            log::info!("Repository changed externally: {}", event.path);
            if let Err(e) = app.emit("repo-changed", event) {
                log::warn!("repo-changed emit failed: {}", e);
            }
        }
    }
}
