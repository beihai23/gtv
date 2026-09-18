use crate::git_reader::{GitReader, ViewResult};
use crate::layout::LaneSeed;
use crate::models::*;
use crate::terminal::PtySession;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::task;

/// Pagination state of the current view: which seeds to continue walking
/// from, which branches are stale, and which commits are already loaded.
pub struct ViewSession {
    /// Seeds the continuation walk pushes (stale ones removed when the
    /// include_stale setting is off).
    pub seeds: Vec<LaneSeed>,
    /// Every stale branch name (tip outside the loaded window), tracked for
    /// the branch-list filter even when stale seeds are excluded.
    pub stale_names: Vec<String>,
    /// All loaded commit oids — hidden from the continuation walk.
    pub seen: HashSet<String>,
}

/// One open repository: its reader, its last built view, its pagination
/// session, its terminal, and the watcher baseline. Every command routes
/// through a repo_id into exactly one of these; sessions never share state.
pub struct RepoSession {
    pub reader: GitReader,
    /// Canonical (realpath-resolved) path — the dedup key open_repository
    /// matches already-open sessions on.
    pub path: String,
    /// Last built view; patch-link detection runs against these commits.
    pub view: Option<GitData>,
    pub session: Option<ViewSession>,
    /// Settings toggle: whether stale branches are processed and shown.
    pub include_stale: bool,
    /// Watcher baseline: last change_fingerprint. Reset by open_repository
    /// so the poller never reports the freshly-opened state as a change.
    pub watch_baseline: Option<String>,
    /// Worktree-family snapshot (git_reader::worktree_family): metadata for
    /// the frontend's second-level tabs, refreshed on repo-changed.
    pub family: Vec<WorktreeMember>,
    /// This tab's integrated terminal (spec 4.2); None until the panel
    /// first spawns a shell. Arc-shared so every terminal command can
    /// clone the handle under a short repos lock and then talk to the
    /// session through this inner mutex alone. A pty write CAN block for
    /// seconds (child not reading stdin, e.g. a paused TUI app in raw
    /// mode -> the tty input queue fills -> the write hangs until the
    /// child drains), so the blocking must sit on this per-session lock,
    /// never on the global repos lock: one tab's wedged paste may stall
    /// that session's writers, not every repo command and the watcher.
    /// The inner mutex keeps the writer serialization the pre-multi-repo
    /// global terminal mutex gave the single session, minus the
    /// cross-session coupling. Dropping the LAST Arc drops the
    /// PtySession, which kills the child (master fd closes -> SIGHUP ->
    /// the reader reaps and emits "terminal-exit").
    pub terminal: Option<Arc<Mutex<PtySession>>>,
}

pub struct AppState {
    /// One RepoSession per open repository tab, keyed by the id the
    /// frontend holds. The lock is the only entry point to a session:
    /// hold it just long enough to clone fields out (or insert/remove),
    /// never across git work.
    pub repos: Mutex<HashMap<u64, RepoSession>>,
    pub next_repo_id: AtomicU64,
    /// The active tab (auto-fetch target, Task 3); 0 = none. Opening a
    /// repo makes it active.
    pub active: Mutex<u64>,
    /// Settings toggle consumed by the fetcher thread (Task 3); default on.
    pub auto_fetch: Mutex<bool>,
    /// Fetcher-thread busy flag (Task 3): true while one tick's fetch is
    /// in flight, so a network-hung fetch never stacks behind itself
    /// (busy-skip). Owned by the fetcher alone and deliberately NOT
    /// per-session: the fetch target follows `active`, so a repo close
    /// has nothing of its own to clean up here.
    pub fetching: AtomicBool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            repos: Mutex::new(HashMap::new()),
            next_repo_id: AtomicU64::new(1),
            active: Mutex::new(0),
            auto_fetch: Mutex::new(true),
            fetching: AtomicBool::new(false),
        }
    }
}

/// Build the pagination session for a freshly built view.
fn build_session(result: &ViewResult, include_stale: bool) -> ViewSession {
    let seeds = if include_stale {
        result.seeds.clone()
    } else {
        result
            .seeds
            .iter()
            .filter(|s| !result.stale_names.contains(&s.name))
            .cloned()
            .collect()
    };
    let seen = result.data.commits.iter().map(|c| c.id.clone()).collect();
    ViewSession {
        seeds,
        stale_names: result.stale_names.clone(),
        seen,
    }
}

/// Short-lock helper: the canonical path of one registered repo.
fn session_path(state: &AppState, repo_id: u64) -> Result<String, String> {
    let repos = state.repos.lock().unwrap();
    repos
        .get(&repo_id)
        .map(|s| s.path.clone())
        .ok_or("No repository opened".to_string())
}

/// Store a freshly built ViewResult as the repo's view + pagination
/// session (short lock; the git work is already done).
fn update_view_session(
    state: &AppState,
    repo_id: u64,
    result: &ViewResult,
    include_stale: bool,
) -> Result<GitData, String> {
    let data = result.data.clone();
    let mut repos = state.repos.lock().unwrap();
    let session = repos.get_mut(&repo_id).ok_or("No repository opened")?;
    session.session = Some(build_session(result, include_stale));
    session.view = Some(data.clone());
    Ok(data)
}

/// Open (or re-activate) a repository and register it in the session
/// registry (spec 4.2):
/// - The path is canonicalized first. An already-open canonical path is a
///   dedup hit: the existing repo_id and its CURRENT view are returned
///   (`already_open: true`); the session's ViewSession / include_stale /
///   watch_baseline are never touched. Only the family snapshot is
///   re-enumerated and the repo becomes active.
/// - A fresh path builds the view, the watcher baseline, and the family
///   snapshot from ONE blocking snapshot (so a poll racing the open never
///   sees a "change" for the state it produced), inserts a new
///   RepoSession, and returns `already_open: false`. The final
///   check+insert is atomic under the repos lock: when two opens of the
///   same path race, the one that registers first wins and the loser
///   discards its own snapshot and answers with the winner's id and view
///   (`already_open: true`) -- exactly one session per canonical path.
/// - Any error (not a repo, IO) leaves the registry untouched.
pub async fn open_repository_impl(
    state: &AppState,
    path: String,
    include_stale: bool,
) -> Result<OpenedRepo, String> {
    let canonical = {
        let p = path.clone();
        task::spawn_blocking(move || GitReader::new(&p).and_then(|r| r.canonical_path()))
            .await
            .map_err(|e| format!("Task join error: {}", e))??
    };

    // Dedup: an open session with the same canonical path is reactivated,
    // never rebuilt (spec 4.2).
    let existing: Option<(u64, Option<GitData>)> = {
        let repos = state.repos.lock().unwrap();
        repos
            .iter()
            .find(|(_, s)| s.path == canonical)
            .map(|(id, s)| (*id, s.view.clone()))
    };

    if let Some((repo_id, view)) = existing {
        // view None cannot happen (open always stores one); if it ever
        // did, re-read the data but still leave the session itself alone.
        let data = match view {
            Some(data) => data,
            None => {
                let p = canonical.clone();
                task::spawn_blocking(move || {
                    let mut reader = GitReader::new(&p)?;
                    reader.read_git_data(2000).map(|r| r.data)
                })
                .await
                .map_err(|e| format!("Task join error: {}", e))??
            }
        };

        // Fresh family snapshot: worktree add/remove since the first open
        // should surface without a reopen (cheap metadata, no view work).
        let (commondir, family) = {
            let p = canonical.clone();
            task::spawn_blocking(
                move || -> Result<(String, Vec<WorktreeMember>), String> {
                    let reader = GitReader::new(&p)?;
                    Ok((reader.commondir()?, reader.worktree_family()?))
                },
            )
            .await
            .map_err(|e| format!("Task join error: {}", e))??
        };

        let still_open = {
            let mut repos = state.repos.lock().unwrap();
            match repos.get_mut(&repo_id) {
                Some(session) => {
                    session.family = family.clone();
                    true
                }
                // Closed while we were re-enumerating: fall through to a
                // fresh open below.
                None => false,
            }
        };
        if still_open {
            *state.active.lock().unwrap() = repo_id;
            log::info!("Repository already open as tab {}; reactivated", repo_id);
            return Ok(OpenedRepo {
                repo_id,
                already_open: true,
                commondir,
                family,
                data,
            });
        }
    }

    // Build the view and the watcher baseline from the same snapshot, so a
    // poll racing the open never sees a "change" for the state it produced.
    let (reader, result, fingerprint, commondir, family) = {
        let p = canonical.clone();
        task::spawn_blocking(
            move || -> Result<(GitReader, ViewResult, String, String, Vec<WorktreeMember>), String>
            {
                let mut reader = GitReader::new(&p)?;
                let result = reader.read_git_data(2000)?;
                let fingerprint = reader.change_fingerprint()?;
                let commondir = reader.commondir()?;
                let family = reader.worktree_family()?;
                Ok((reader, result, fingerprint, commondir, family))
            },
        )
        .await
        .map_err(|e| format!("Task join error: {}", e))??
    };

    let session = build_session(&result, include_stale);
    let data = result.data;
    let repo_id = state.next_repo_id.fetch_add(1, Ordering::Relaxed);
    // Atomic check+insert: the dedup lookup above and this insert straddle a
    // seconds-scale await, so a concurrent open of the same canonical path
    // may have registered in between. Re-check under the same lock the
    // insert takes; the loser drops its freshly built session and degrades
    // to the winner with already_open semantics (spec 4.2) instead of
    // registering a duplicate path under a second id.
    let lost_race: Option<(u64, Option<GitData>)> = {
        let mut repos = state.repos.lock().unwrap();
        let winner = repos
            .iter_mut()
            .find(|(_, s)| s.path == canonical)
            .map(|(id, s)| {
                let won = (*id, s.view.clone());
                // Refresh the family snapshot like the dedup path does;
                // never touch the winner's view/session/settings/baseline.
                s.family = family.clone();
                won
            });
        if winner.is_none() {
            repos.insert(
                repo_id,
                RepoSession {
                    reader,
                    path: canonical,
                    view: Some(data.clone()),
                    session: Some(session),
                    include_stale,
                    watch_baseline: Some(fingerprint),
                    family: family.clone(),
                    terminal: None,
                },
            );
        }
        winner
    };
    if let Some((winner_id, view)) = lost_race {
        // The winner's CURRENT view is authoritative; our own fresh read of
        // the same path is the fallback for the impossible view-None case.
        let data = view.unwrap_or(data);
        *state.active.lock().unwrap() = winner_id;
        log::info!(
            "Concurrent open lost the race; repository already open as tab {}",
            winner_id
        );
        return Ok(OpenedRepo {
            repo_id: winner_id,
            already_open: true,
            commondir,
            family,
            data,
        });
    }
    *state.active.lock().unwrap() = repo_id;

    log::info!("Opened repository with {} commits", data.commits.len());

    Ok(OpenedRepo {
        repo_id,
        already_open: false,
        commondir,
        family,
        data,
    })
}

#[tauri::command]
pub async fn open_repository(
    path: String,
    include_stale: bool,
    state: tauri::State<'_, AppState>,
) -> Result<OpenedRepo, String> {
    open_repository_impl(&state, path, include_stale).await
}

/// Remove a repository's session (tab close). Unknown ids error like every
/// other repo-routed command. The removed RepoSession is bound (NOT
/// discarded at the remove statement) so its drop — including the tab's
/// terminal handle, whose last-Arc PtySession::Drop kills the child
/// (master fd closes -> SIGHUP -> the reader EOFs, reaps and emits
/// "terminal-exit") — runs after the repos lock is released; the explicit
/// drop keeps that lock discipline a code fact, not a comment promise.
/// If the closed repo was the active one, active goes back to "none" (0)
/// — the frontend names the new active explicitly.
pub fn close_repository_impl(state: &AppState, repo_id: u64) -> Result<(), String> {
    let removed = {
        let mut repos = state.repos.lock().unwrap();
        repos.remove(&repo_id).ok_or("No repository opened")?
    };
    // Explicit drop: detaches the closed tab's terminal (and kills the
    // child when this was the last Arc); never blocks (Drop only
    // try_locks the child and closes fds — the reap happens on the
    // reader thread).
    drop(removed);
    let mut active = state.active.lock().unwrap();
    if *active == repo_id {
        *active = 0;
    }
    Ok(())
}

#[tauri::command]
pub fn close_repository(repo_id: u64, state: tauri::State<AppState>) -> Result<(), String> {
    close_repository_impl(&state, repo_id)
}

/// Mark a repo as the active tab (the auto-fetch target once Task 3 lands).
pub fn set_active_repository_impl(state: &AppState, repo_id: u64) -> Result<(), String> {
    {
        let repos = state.repos.lock().unwrap();
        repos.get(&repo_id).ok_or("No repository opened")?;
    }
    *state.active.lock().unwrap() = repo_id;
    Ok(())
}

#[tauri::command]
pub fn set_active_repository(repo_id: u64, state: tauri::State<AppState>) -> Result<(), String> {
    set_active_repository_impl(&state, repo_id)
}

/// Settings toggle for the auto-fetch thread (spec 4.2): writes the flag
/// the fetcher reads at the top of every tick. There is deliberately NO
/// immediate-trigger semantics -- enabling mid-cycle takes effect on the
/// next tick (<= 60 s later), and disabling likewise stops future ticks
/// without cancelling one already in flight.
pub fn set_auto_fetch_impl(state: &AppState, enabled: bool) -> Result<(), String> {
    *state.auto_fetch.lock().unwrap() = enabled;
    Ok(())
}

#[tauri::command]
pub fn set_auto_fetch(enabled: bool, state: tauri::State<AppState>) -> Result<(), String> {
    set_auto_fetch_impl(&state, enabled)
}

pub async fn get_commit_detail_impl(
    state: &AppState,
    repo_id: u64,
    commit_id: String,
) -> Result<CommitDetail, String> {
    let path = session_path(state, repo_id)?;

    task::spawn_blocking(move || {
        let reader = GitReader::new(&path)?;
        reader.get_commit_detail(&commit_id)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn get_commit_detail(
    repo_id: u64,
    commit_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<CommitDetail, String> {
    get_commit_detail_impl(&state, repo_id, commit_id).await
}

pub async fn get_file_diff_impl(
    state: &AppState,
    repo_id: u64,
    commit_id: String,
    path: String,
) -> Result<String, String> {
    let repo_path = session_path(state, repo_id)?;

    task::spawn_blocking(move || {
        let reader = GitReader::new(&repo_path)?;
        reader.get_file_diff(&commit_id, &path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn get_file_diff(
    repo_id: u64,
    commit_id: String,
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    get_file_diff_impl(&state, repo_id, commit_id, path).await
}

/// Two-commit compare (base -> target): file list with real per-file
/// +/- numbers, running totals, and both-side commit summaries. Read-only.
pub async fn get_compare_detail_impl(
    state: &AppState,
    repo_id: u64,
    base: String,
    target: String,
) -> Result<CompareDetail, String> {
    let path = session_path(state, repo_id)?;

    task::spawn_blocking(move || {
        let reader = GitReader::new(&path)?;
        reader.compare_detail(&base, &target)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn get_compare_detail(
    repo_id: u64,
    base: String,
    target: String,
    state: tauri::State<'_, AppState>,
) -> Result<CompareDetail, String> {
    get_compare_detail_impl(&state, repo_id, base, target).await
}

/// Unified diff patch text for one file between two commits (base ->
/// target). Read-only; same truncation and binary handling as
/// get_file_diff.
pub async fn get_pair_file_diff_impl(
    state: &AppState,
    repo_id: u64,
    base: String,
    target: String,
    path: String,
) -> Result<String, String> {
    let repo_path = session_path(state, repo_id)?;

    task::spawn_blocking(move || {
        let reader = GitReader::new(&repo_path)?;
        reader.pair_file_diff(&base, &target, &path)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn get_pair_file_diff(
    repo_id: u64,
    base: String,
    target: String,
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    get_pair_file_diff_impl(&state, repo_id, base, target, path).await
}

#[tauri::command]
pub fn is_valid_git_repo(path: String) -> bool {
    match Repository::open(&path) {
        Ok(repo) => !repo.is_bare(),
        Err(_) => false,
    }
}

/// Jump the view to a single commit's ancestry (Cmd+F hit outside the
/// loaded window). Same session semantics as switch_branch; the view is no
/// longer "from a branch".
pub async fn jump_to_commit_impl(
    state: &AppState,
    repo_id: u64,
    commit_id: String,
) -> Result<GitData, String> {
    let path = session_path(state, repo_id)?;

    let result = task::spawn_blocking(move || {
        let mut reader = GitReader::new(&path)?;
        reader.read_git_data_from_commit(&commit_id, 2000)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    let data = update_view_session(state, repo_id, &result, true)?;
    log::info!("Jumped to commit with {} commits", data.commits.len());
    Ok(data)
}

#[tauri::command]
pub async fn jump_to_commit(
    repo_id: u64,
    commit_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<GitData, String> {
    jump_to_commit_impl(&state, repo_id, commit_id).await
}

/// Recent formatted backend log lines (oldest first) for the issue-report
/// dialog; see `log_buffer`.
#[tauri::command]
pub fn get_recent_logs() -> Vec<String> {
    crate::log_buffer::global().snapshot()
}

pub async fn get_branch_list_impl(
    state: &AppState,
    repo_id: u64,
) -> Result<Vec<BranchLane>, String> {
    // Short lock: clone the inputs (path, the view the lanes are laid out
    // against, the stale-filter settings), then enumerate on a fresh reader
    // outside the lock.
    let (path, view, include_stale, stale) = {
        let repos = state.repos.lock().unwrap();
        let session = repos.get(&repo_id).ok_or("No repository opened")?;
        // Reuse the view built by open_repository / switch_branch / filter so
        // this stays cheap (no second revwalk + layout on every repo open).
        let view = session.view.as_ref().ok_or("No repository opened")?.clone();
        let stale: HashSet<String> = session
            .session
            .as_ref()
            .map(|s| s.stale_names.iter().cloned().collect())
            .unwrap_or_default();
        (session.path.clone(), view, session.include_stale, stale)
    };

    let mut list = task::spawn_blocking(move || {
        let reader = GitReader::new(&path)?;
        reader.get_branch_list(&view)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    if !include_stale {
        list.retain(|b| b.is_tag || !stale.contains(&b.name));
    }
    Ok(list)
}

#[tauri::command]
pub async fn get_branch_list(
    repo_id: u64,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<BranchLane>, String> {
    get_branch_list_impl(&state, repo_id).await
}

pub async fn switch_branch_impl(
    state: &AppState,
    repo_id: u64,
    branch_name: String,
) -> Result<GitData, String> {
    let path = session_path(state, repo_id)?;

    // "View from this branch" is an explicit user action: the stale-branch
    // setting does not apply, but the session still tracks the view so
    // pagination works here too.
    let result = task::spawn_blocking(move || {
        let mut reader = GitReader::new(&path)?;
        reader.read_git_data_from_branch(&branch_name, 2000)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    let data = update_view_session(state, repo_id, &result, true)?;
    log::info!("Switched to branch with {} commits", data.commits.len());
    Ok(data)
}

#[tauri::command]
pub async fn switch_branch(
    repo_id: u64,
    branch_name: String,
    state: tauri::State<'_, AppState>,
) -> Result<GitData, String> {
    switch_branch_impl(&state, repo_id, branch_name).await
}

/// Worktree preflight for the checkout confirm dialog: modified/untracked
/// counts plus the merge-in-progress flag. Read-only.
pub async fn get_worktree_status_impl(
    state: &AppState,
    repo_id: u64,
) -> Result<WorktreeStatus, String> {
    let path = session_path(state, repo_id)?;

    task::spawn_blocking(move || {
        let reader = GitReader::new(&path)?;
        reader.worktree_status()
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn get_worktree_status(
    repo_id: u64,
    state: tauri::State<'_, AppState>,
) -> Result<WorktreeStatus, String> {
    get_worktree_status_impl(&state, repo_id).await
}

/// SAFE checkout of a local branch -- the app's only write path. Returns an
/// ack only and never touches the session's view: the watcher's
/// repo-changed event is the sole refresh path, so a checkout can never
/// race a second view rebuild. Refuses while a merge, cherry-pick, or
/// revert is in progress and never discards conflicting changes (no force
/// option).
pub async fn checkout_branch_impl(
    state: &AppState,
    repo_id: u64,
    branch: String,
) -> Result<CheckoutAck, String> {
    let path = session_path(state, repo_id)?;

    task::spawn_blocking(move || {
        let reader = GitReader::new(&path)?;
        reader.checkout_branch(&branch)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn checkout_branch(
    repo_id: u64,
    branch: String,
    state: tauri::State<'_, AppState>,
) -> Result<CheckoutAck, String> {
    checkout_branch_impl(&state, repo_id, branch).await
}

pub async fn filter_by_branches_impl(
    state: &AppState,
    repo_id: u64,
    branch_names: Vec<String>,
) -> Result<GitData, String> {
    let path = session_path(state, repo_id)?;

    let result = task::spawn_blocking(move || {
        let mut reader = GitReader::new(&path)?;
        reader.filter_by_branches(&branch_names)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    let data = update_view_session(state, repo_id, &result, true)?;
    log::info!("Filtered to {} commits", data.commits.len());
    Ok(data)
}

#[tauri::command]
pub async fn filter_by_branches(
    repo_id: u64,
    branch_names: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<GitData, String> {
    filter_by_branches_impl(&state, repo_id, branch_names).await
}

/// Page in the next chunk of older history for the current view. The whole
/// loaded set is re-laid out (lane ownership and x coordinates are global),
/// and the returned GitData replaces the current view.
pub async fn load_older_commits_impl(state: &AppState, repo_id: u64) -> Result<GitData, String> {
    let (path, seeds, seen, existing, has_more) = {
        let repos = state.repos.lock().unwrap();
        let session = repos.get(&repo_id).ok_or("No repository opened")?;
        match (session.session.as_ref(), session.view.as_ref()) {
            (Some(s), Some(v)) => (
                session.path.clone(),
                s.seeds.clone(),
                s.seen.clone(),
                v.commits.clone(),
                v.has_more,
            ),
            _ => return Err("No repository opened".to_string()),
        }
    };

    if !has_more {
        let repos = state.repos.lock().unwrap();
        let session = repos.get(&repo_id).ok_or("No repository opened")?;
        return Ok(session.view.as_ref().expect("checked above").clone());
    }

    let data = task::spawn_blocking(move || {
        let reader = GitReader::new(&path)?;
        reader.load_more(&seeds, &seen, existing, 2000)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    {
        let mut repos = state.repos.lock().unwrap();
        let session = repos.get_mut(&repo_id).ok_or("No repository opened")?;
        if let Some(s) = session.session.as_mut() {
            s.seen = data.commits.iter().map(|c| c.id.clone()).collect();
            // A chunk may have reached a previously stale branch tip. Only
            // recompute when stale seeds are still in play (include_stale on)
            // — otherwise they are never walked toward and stay stale.
            if session.include_stale {
                let ids: HashSet<&str> = data.commits.iter().map(|c| c.id.as_str()).collect();
                s.stale_names = s
                    .seeds
                    .iter()
                    .filter(|sd| !ids.contains(sd.tip.as_str()))
                    .map(|sd| sd.name.clone())
                    .collect();
            }
        }
        session.view = Some(data.clone());
    }

    log::info!(
        "Loaded older history: {} commits total, has_more={}",
        data.commits.len(),
        data.has_more
    );

    Ok(data)
}

#[tauri::command]
pub async fn load_older_commits(
    repo_id: u64,
    state: tauri::State<'_, AppState>,
) -> Result<GitData, String> {
    load_older_commits_impl(&state, repo_id).await
}

/// Diff volume for node sizing. One tree diff per commit, so it runs on
/// demand after the view has rendered, not on the open path.
pub async fn get_commit_stats_impl(
    state: &AppState,
    repo_id: u64,
    commit_ids: Vec<String>,
) -> Result<Vec<CommitStat>, String> {
    let path = session_path(state, repo_id)?;

    task::spawn_blocking(move || {
        let reader = GitReader::new(&path)?;
        reader.get_commit_stats(&commit_ids)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn get_commit_stats(
    repo_id: u64,
    commit_ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<CommitStat>, String> {
    get_commit_stats_impl(&state, repo_id, commit_ids).await
}

/// Full-history commit search (Cmd+F). Read-only: walks every commit from
/// the branch tips and matches subject/author substrings. `in_view` marks
/// commits inside the current pagination window.
pub async fn search_commits_impl(
    state: &AppState,
    repo_id: u64,
    query: String,
    limit: usize,
) -> Result<Vec<SearchHit>, String> {
    let (path, loaded) = {
        let repos = state.repos.lock().unwrap();
        let session = repos.get(&repo_id).ok_or("No repository opened")?;
        (
            session.path.clone(),
            session
                .session
                .as_ref()
                .map(|s| s.seen.clone())
                .unwrap_or_default(),
        )
    };

    task::spawn_blocking(move || {
        let reader = GitReader::new(&path)?;
        reader.search_commits(&query, limit, &loaded)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn search_commits(
    repo_id: u64,
    query: String,
    limit: usize,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<SearchHit>, String> {
    search_commits_impl(&state, repo_id, query, limit).await
}

/// Cherry-pick / rebase detection across the current view's commits.
/// Expensive (one diff per commit), so it runs on demand via the Copies
/// toggle, inside spawn_blocking.
pub async fn get_patch_links_impl(
    state: &AppState,
    repo_id: u64,
) -> Result<Vec<PatchLink>, String> {
    let (path, commits) = {
        let repos = state.repos.lock().unwrap();
        let session = repos.get(&repo_id).ok_or("No repository opened")?;
        let view = session.view.as_ref().ok_or("No repository opened")?;
        (session.path.clone(), view.commits.clone())
    };

    task::spawn_blocking(move || {
        let reader = GitReader::new(&path)?;
        reader.get_patch_links(&commits)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[tauri::command]
pub async fn get_patch_links(
    repo_id: u64,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<PatchLink>, String> {
    get_patch_links_impl(&state, repo_id).await
}

// --- Integrated terminal (bottom panel) ---
// One session per open repository (spec 4.2): every command routes through
// repo_id into that repo's RepoSession.terminal. The repos lock is held
// only long enough to clone (or take) the shared session handle; the pty
// interaction itself runs under the session's own inner lock, so a
// blocking write wedges one tab, not the registry.

/// Spawn (or return the existing) shell session in the given open
/// repository. Idempotent: a live session is returned as-is, so the
/// frontend can call this on every panel mount/remount (React StrictMode
/// double-mounts, HMR) without leaking shells.
pub async fn terminal_spawn_impl(
    state: &AppState,
    repo_id: u64,
    cols: u16,
    rows: u16,
    app: &tauri::AppHandle,
) -> Result<TerminalInfo, String> {
    let app = app.clone();
    spawn_terminal_in_repo(state, repo_id, cols, rows, move |path, cols, rows| {
        crate::terminal::spawn_for_app(&app, &path, cols, rows)
    })
    .await
}

/// Per-repo spawn routing shared by the command above and the tests: the
/// session lands in RepoSession.terminal under the repos lock. `spawner`
/// builds the PtySession so tests can drive this with plain callbacks
/// (terminal_pty.rs pattern) instead of a Tauri app handle.
pub async fn spawn_terminal_in_repo<S>(
    state: &AppState,
    repo_id: u64,
    cols: u16,
    rows: u16,
    spawner: S,
) -> Result<TerminalInfo, String>
where
    S: FnOnce(std::path::PathBuf, u16, u16) -> Result<PtySession, String> + Send + 'static,
{
    // Fast path under a short lock; the guard must be dropped before the
    // await below, or the future stops being Send. The handle is cloned
    // out and the session itself is only touched under the inner terminal
    // lock, outside the repos lock.
    let live = {
        let repos = state.repos.lock().unwrap();
        let session = repos.get(&repo_id).ok_or("No repository opened")?;
        session.terminal.clone()
    };
    if let Some(terminal) = live {
        return Ok(terminal.lock().unwrap().info());
    }
    let path = std::path::PathBuf::from(session_path(state, repo_id)?);
    // openpty + fork is millisecond-scale, but it still has no business on
    // the main thread — same reasoning as the git commands above.
    let session = task::spawn_blocking(move || spawner(path, cols, rows))
        .await
        .map_err(|e| format!("Task join error: {}", e))??;
    let mut repos = state.repos.lock().unwrap();
    // Repo closed while we were spawning: the fresh session drops with this
    // early return (Drop kills the child) and the caller hears the same
    // unknown-id error as everywhere else.
    let repo = repos.get_mut(&repo_id).ok_or("No repository opened")?;
    // A racing second spawn for the SAME repo can't come from the single
    // frontend caller, but if it ever does: first session wins, the loser
    // is dropped (killed). The winner's info is read under its inner lock
    // after the repos guard is gone.
    if let Some(existing) = repo.terminal.clone() {
        drop(repos);
        return Ok(existing.lock().unwrap().info());
    }
    // The fresh session is still exclusively ours here, so its info needs
    // no lock; the insert only swaps the handle into the slot.
    let info = session.info();
    repo.terminal = Some(Arc::new(Mutex::new(session)));
    drop(repos);
    Ok(info)
}

#[tauri::command]
pub async fn terminal_spawn(
    repo_id: u64,
    cols: u16,
    rows: u16,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<TerminalInfo, String> {
    terminal_spawn_impl(&state, repo_id, cols, rows, &app).await
}

/// Forward keystrokes/paste from xterm.js to the repo's PTY. Lock
/// discipline: the repos lock is held only to clone the session handle
/// (plus the routing/slot error checks); the write itself runs under the
/// session's inner lock, outside the repos lock. A pty write CAN block
/// for seconds (child not reading stdin -> tty input queue full -> large
/// paste hangs until the child drains), so the blocking must sit on the
/// per-session lock only: a wedged paste in one tab must not freeze
/// every repo command and the watcher app-wide.
pub fn terminal_write_impl(state: &AppState, repo_id: u64, data: String) -> Result<(), String> {
    let terminal = {
        let repos = state.repos.lock().unwrap();
        let session = repos.get(&repo_id).ok_or("No repository opened")?;
        session
            .terminal
            .as_ref()
            .ok_or("No terminal session")?
            .clone()
    };
    // Bind before returning: the guard must drop at the statement end,
    // strictly before `terminal` (the cloned Arc) — the registry slot is
    // never the one to drop a locked session mutex.
    let result = terminal.lock().unwrap().write_all(&data);
    result
}

#[tauri::command]
pub fn terminal_write(
    repo_id: u64,
    data: String,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    terminal_write_impl(&state, repo_id, data)
}

/// Sync the repo's PTY size after a frontend fit(). Same lock discipline
/// as write: clone the handle under the repos lock, resize under the
/// session's inner lock (an ioctl can stall behind a wedged writer on
/// the same session; it must never stall the registry).
pub fn terminal_resize_impl(state: &AppState, repo_id: u64, cols: u16, rows: u16) -> Result<(), String> {
    let terminal = {
        let repos = state.repos.lock().unwrap();
        let session = repos.get(&repo_id).ok_or("No repository opened")?;
        session
            .terminal
            .as_ref()
            .ok_or("No terminal session")?
            .clone()
    };
    // Same guard-before-Arc drop order as write above.
    let result = terminal.lock().unwrap().resize(cols, rows);
    result
}

#[tauri::command]
pub fn terminal_resize(
    repo_id: u64,
    cols: u16,
    rows: u16,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    terminal_resize_impl(&state, repo_id, cols, rows)
}

/// Kill the repo's session (restart button). Taking the slot detaches the
/// registry's handle; the taken Arc is dropped OUTSIDE the repos lock, so
/// even the last-Arc PtySession::Drop (best-effort child kill + master fd
/// close -> SIGHUP -> the reader thread EOFs, reaps and emits
/// "terminal-exit") can never run under the global registry lock — the
/// Drop non-blocking invariant (try_lock child, close fds, no joins) now
/// only protects this caller, not the whole app. A wedged writer may
/// still hold a cloned Arc; then the child lives until that write unblocks
/// (child exit -> pty error), which is that writer alone — the registry
/// and every other tab moved on.
pub fn terminal_kill_impl(state: &AppState, repo_id: u64) -> Result<(), String> {
    let taken = {
        let mut repos = state.repos.lock().unwrap();
        let session = repos.get_mut(&repo_id).ok_or("No repository opened")?;
        session.terminal.take().ok_or("No terminal session")?
    };
    drop(taken);
    Ok(())
}

#[tauri::command]
pub fn terminal_kill(repo_id: u64, state: tauri::State<AppState>) -> Result<(), String> {
    terminal_kill_impl(&state, repo_id)
}

use git2::Repository;
