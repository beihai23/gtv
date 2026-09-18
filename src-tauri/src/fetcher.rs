//! Auto-fetch thread for the active tab (spec 4.3).
//!
//! A plain std thread (started from the builder's `.setup` hook, next to
//! the repo-watcher) wakes every 60 s and fetches the ACTIVE repository's
//! remotes -- and nothing else. A fetch only updates remote-tracking refs
//! and objects inside .git (the second and last item of the write
//! whitelist); the worktree, local branches, HEAD, and the stash are never
//! touched. The fetcher deliberately does NOT emit events and does NOT
//! touch fingerprints: the watcher's next poll sees the refs/remotes
//! movement in its fingerprint and emits repo-changed on its own -- the
//! single refresh path.
//!
//! Panic safety: the release profile uses `panic = "abort"`, so this
//! forever-thread must never panic -- every fallible step is Result-mapped
//! or skipped, and the lock `unwrap`s cannot poison (no unwinding).

use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tokio::task;

use crate::commands::AppState;
use crate::git_reader::GitReader;

const FETCH_INTERVAL: Duration = Duration::from_secs(60);

/// Outcome of one fetcher tick. An enum (not a bool) so tests can assert
/// exactly which early-exit fired.
#[derive(Debug, PartialEq, Eq)]
pub enum TickOutcome {
    /// The tick dispatched but the target repo could not even be opened
    /// (e.g. its directory was deleted while the tab stayed open), or the
    /// blocking task itself died. Nothing was fetched; the failure was
    /// logged.
    Skip,
    /// auto_fetch is off: the tick idled before looking at the registry.
    AutoOff,
    /// No fetch target: no active tab, or the active id is no longer
    /// registered (Nit-5: the tab may have closed between ticks -- an
    /// unverified id must never be fetched).
    NoActive,
    /// A previous tick's fetch is still in flight (network-hung remote);
    /// this tick was skipped so fetches never stack.
    Busy,
    /// The active repo's remotes were fetched. Some(summary) = the fetch
    /// (or its spawn) failed; the string is git's exit status plus its
    /// stderr tail collapsed to one line -- silent-log material, never
    /// fatal. None = every remote updated its tracking refs cleanly.
    Fetched(Option<String>),
}

pub fn spawn(app: AppHandle) {
    thread::Builder::new()
        .name("repo-fetcher".into())
        .spawn(move || fetch_loop(app))
        .expect("failed to spawn repo-fetcher thread"); // startup-only, no locks held
}

fn fetch_loop(app: AppHandle) {
    // One tiny runtime for the thread's whole life: each tick's fetch runs
    // in tokio::task::spawn_blocking, which needs an async driver, and the
    // current-thread flavor is enough (the blocking pool does all the
    // work). Built before the loop so a tick never constructs anything.
    let rt = tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("failed to build fetcher runtime"); // startup-only, before any tick
    loop {
        thread::sleep(FETCH_INTERVAL);
        let state = app.state::<AppState>();
        // Outcome (and any failure logging) is produced inside fetch_tick;
        // the loop stays a dumb metronome.
        rt.block_on(fetch_tick(&state));
    }
}

/// One fetcher tick, directly testable (tests drive this and never sleep
/// the 60 s interval). Checks run in order and any failure idles the tick:
/// 1. auto_fetch off -> AutoOff (before even looking at the registry);
/// 2. read `active`, then -- immediately adjacent, under the repos lock --
///    re-verify that id is still registered (Nit-5: the tab may have
///    closed or switched between ticks) and clone the session's canonical
///    path, releasing the lock before any git work;
/// 3. busy swap -> a previous network-hung fetch still in flight -> Busy;
/// 4. fetch on a short-lived reader inside spawn_blocking, NEVER holding
///    the repos lock (spec 4.1 lock discipline). The busy flag is cleared
///    on every path once the fetch returns, success or failure.
pub async fn fetch_tick(state: &AppState) -> TickOutcome {
    // 1. Settings gate.
    if !*state.auto_fetch.lock().unwrap() {
        return TickOutcome::AutoOff;
    }

    // 2. Target resolution. `active` is read under its own lock first, and
    // the repos lock is taken immediately after (never nested -- the rest
    // of the codebase never holds both at once either); the gap between
    // them can only cost this tick one target, never fetch a stale one:
    // the re-verification below is what makes a closed tab unfetchable.
    let active = *state.active.lock().unwrap();
    let path = {
        let repos = state.repos.lock().unwrap();
        match repos.get(&active) {
            Some(session) => session.path.clone(),
            None => return TickOutcome::NoActive,
        }
    };

    // 3. Busy gate: swap-then-maybe-return means the flag is ours to clear
    // from here on, whichever way the fetch lands.
    if state.fetching.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return TickOutcome::Busy;
    }

    // 4. The fetch itself, outside every lock.
    let result = task::spawn_blocking(move || {
        let reader = GitReader::new(&path)?;
        reader.fetch_remotes()
    })
    .await
    .map_err(|e| format!("Task join error: {}", e));

    // Cleared on every post-swap path: the fetch finished (or died), so
    // the next tick may dispatch again.
    state
        .fetching
        .store(false, std::sync::atomic::Ordering::SeqCst);

    match result {
        // One silent summary line for the whole failure set (offline must
        // not spam: no per-remote warnings, no dialogs, success is quiet).
        Ok(Ok(summary)) => {
            if let Some(line) = &summary {
                log::info!("auto-fetch: {}", line);
            }
            TickOutcome::Fetched(summary)
        }
        Ok(Err(e)) => {
            log::info!("auto-fetch skipped: {}", e);
            TickOutcome::Skip
        }
        Err(e) => {
            log::info!("auto-fetch task failed: {}", e);
            TickOutcome::Skip
        }
    }
}
