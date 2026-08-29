//! Repository change watching: the embedded terminal lets the user run git
//! against the open repo, so gtv must notice and re-read the timeline.
//!
//! We watch the git DIRECTORIES (gitdir + commondir) recursively — refs/,
//! objects/, packed-refs, HEAD, index — not the work tree: work-tree edits
//! never change the commit graph and would drown the watcher in noise.
//! Events funnel through a trailing 300ms quiet-period debouncer so a burst
//! (`git commit` rewrites refs/ and logs/ in quick succession) collapses
//! into one refresh.

use notify::{RecommendedWatcher, RecursiveMode, Watcher as _};
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;

/// Quiet period that ends a burst of events. `git commit` typically fires
/// 2-4 events (HEAD, refs/heads/x, logs/HEAD, logs/refs/...); 300ms merges
/// them while still feeling instant next to the multi-second re-read.
const DEBOUNCE: Duration = Duration::from_millis(300);

/// Owns the notify watcher and its debounce thread. Dropping stops the
/// watcher (which drops the event sender) and joins the thread — the thread
/// exits once `recv()` reports disconnect, so Drop blocks for at most one
/// quiet period (~300ms).
pub struct WatcherGuard {
    watcher: Option<RecommendedWatcher>,
    handle: Option<JoinHandle<()>>,
}

impl Drop for WatcherGuard {
    fn drop(&mut self) {
        // Drop the watcher first: its closure holds the sender, so this
        // closes the channel and unblocks the debounce thread's recv().
        drop(self.watcher.take());
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// Watch the git metadata of `repo_path` (work path) and call `on_change`
/// after each burst of changes settles. Errors (vanished gitdir, inotify
/// limits...) are reported to the caller; open_repository treats them as
/// non-fatal.
pub fn watch(repo_path: &str, on_change: Box<dyn Fn() + Send + 'static>) -> Result<WatcherGuard, String> {
    let dirs = git_dirs(repo_path)?;

    let (tx, rx) = mpsc::channel::<()>();
    let tx_watcher = tx.clone();
    let mut watcher: RecommendedWatcher = notify::recommended_watcher(
        move |event: Result<notify::Event, notify::Error>| {
            // Only real events wake the debouncer; watcher-level errors are
            // ignored (a dropped watch surfaces as silence, which is safe
            // for an advisory refresh path).
            if event.is_ok() {
                let _ = tx_watcher.send(());
            }
        },
    )
    .map_err(|e| format!("watcher init failed: {:#}", anyhow::anyhow!(e)))?;

    for dir in &dirs {
        watcher
            .watch(dir, RecursiveMode::Recursive)
            .map_err(|e| format!("watch {:?} failed: {:#}", dir, anyhow::anyhow!(e)))?;
    }

    // Trailing debounce: wait for the first event, then keep extending the
    // deadline while more arrive; fire on_change only once the channel has
    // been quiet for DEBOUNCE. The clone moved into the watcher closure is
    // the only sender that outlives this function, so dropping the watcher
    // disconnects the channel and ends this loop.
    let handle = std::thread::spawn(move || {
        while rx.recv().is_ok() {
            loop {
                match rx.recv_timeout(DEBOUNCE) {
                    Ok(()) => continue,
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            on_change();
        }
    });

    Ok(WatcherGuard {
        watcher: Some(watcher),
        handle: Some(handle),
    })
}

/// The git metadata directories to watch: `repo.path()` (the gitdir — for a
/// linked worktree that is the per-worktree dir) and `commondir()` (the main
/// `.git` holding refs/objects; returned RELATIVE to the gitdir for linked
/// worktrees, so join first, then canonicalize). Deduplicated: a plain
/// repo's gitdir == commondir.
fn git_dirs(repo_path: &str) -> Result<Vec<PathBuf>, String> {
    let repo = git2::Repository::open(repo_path)
        .map_err(|e| format!("open {:?} failed: {}", repo_path, e))?;

    let gitdir = repo
        .path()
        .canonicalize()
        .map_err(|e| format!("canonicalize gitdir failed: {}", e))?;

    // commondir() is the main .git for linked worktrees, stored as a path
    // RELATIVE to the gitdir ("../..") — joining before canonicalizing is
    // what makes a main-repo commit visible to a worktree-side watch.
    let commondir_raw = repo.commondir();
    let commondir = if commondir_raw.is_absolute() {
        commondir_raw
            .canonicalize()
            .map_err(|e| format!("canonicalize commondir failed: {}", e))?
    } else {
        gitdir
            .join(&commondir_raw)
            .canonicalize()
            .map_err(|e| format!("canonicalize commondir failed: {}", e))?
    };

    let mut dirs = vec![gitdir, commondir];
    dirs.sort();
    dirs.dedup();
    Ok(dirs)
}
