use crate::git_reader::{GitReader, ViewResult};
use crate::layout::LaneSeed;
use crate::models::*;
use crate::terminal::PtySession;
use std::collections::HashSet;
use std::sync::Mutex;
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

pub struct AppState {
    pub current_repo: Mutex<Option<GitReader>>,
    pub current_path: Mutex<Option<String>>,
    pub current_branch: Mutex<Option<String>>,
    /// Last built view; patch-link detection runs against these commits.
    pub current_view: Mutex<Option<GitData>>,
    pub session: Mutex<Option<ViewSession>>,
    /// Settings toggle: whether stale branches are processed and shown.
    pub include_stale: Mutex<bool>,
    /// Live integrated-terminal session (None when never spawned / killed).
    pub terminal: Mutex<Option<PtySession>>,
    /// Repo-watcher baseline: (path, last change_fingerprint). Reset by
    /// open_repository so the poller never reports the freshly-opened state
    /// as a change, and cleared when no repo is open.
    pub watch_baseline: Mutex<Option<(String, String)>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            current_repo: Mutex::new(None),
            current_path: Mutex::new(None),
            current_branch: Mutex::new(None),
            current_view: Mutex::new(None),
            session: Mutex::new(None),
            include_stale: Mutex::new(true),
            terminal: Mutex::new(None),
            watch_baseline: Mutex::new(None),
        }
    }
}

/// Record the pagination session for a freshly built view.
fn store_session(state: &AppState, result: &ViewResult, include_stale: bool) {
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
    *state.session.lock().unwrap() = Some(ViewSession {
        seeds,
        stale_names: result.stale_names.clone(),
        seen,
    });
}

#[tauri::command]
pub async fn open_repository(
    path: String,
    include_stale: bool,
    state: tauri::State<'_, AppState>,
) -> Result<GitData, String> {
    let path_clone = path.clone();

    // Build the view and the watcher baseline from the same snapshot, so a
    // poll racing the open never sees a "change" for the state it produced.
    let (result, fingerprint) = task::spawn_blocking(move || -> Result<(ViewResult, String), String> {
        let mut reader = GitReader::new(&path_clone)?;
        let result = reader.read_git_data(2000)?;
        let fingerprint = reader.change_fingerprint()?;
        Ok((result, fingerprint))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    *state.include_stale.lock().unwrap() = include_stale;
    store_session(&state, &result, include_stale);
    *state.watch_baseline.lock().unwrap() = Some((path.clone(), fingerprint));

    let data = result.data;
    let mut current_repo = state.current_repo.lock().unwrap();
    *current_repo = Some(GitReader::new(&path).map_err(|e| e.to_string())?);

    let mut current_path = state.current_path.lock().unwrap();
    *current_path = Some(path);

    let mut current_branch = state.current_branch.lock().unwrap();
    *current_branch = Some(data.main_branch.clone());

    let mut current_view = state.current_view.lock().unwrap();
    *current_view = Some(data.clone());

    log::info!("Opened repository with {} commits", data.commits.len());

    Ok(data)
}

#[tauri::command]
pub fn get_commit_detail(
    commit_id: String,
    state: tauri::State<AppState>,
) -> Result<CommitDetail, String> {
    let current_repo = state.current_repo.lock().unwrap();
    let reader = current_repo.as_ref().ok_or("No repository opened")?;
    reader.get_commit_detail(&commit_id)
}

#[tauri::command]
pub fn get_file_diff(
    commit_id: String,
    path: String,
    state: tauri::State<AppState>,
) -> Result<String, String> {
    let current_repo = state.current_repo.lock().unwrap();
    let reader = current_repo.as_ref().ok_or("No repository opened")?;
    reader.get_file_diff(&commit_id, &path)
}

#[tauri::command]
pub fn get_current_path(state: tauri::State<AppState>) -> Option<String> {
    let current_path = state.current_path.lock().unwrap();
    current_path.clone()
}

#[tauri::command]
pub fn get_current_branch(state: tauri::State<AppState>) -> Option<String> {
    let current_branch = state.current_branch.lock().unwrap();
    current_branch.clone()
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
/// longer "from a branch", so current_branch is cleared.
#[tauri::command]
pub async fn jump_to_commit(
    commit_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<GitData, String> {
    let path = {
        let current_path = state.current_path.lock().unwrap();
        current_path.clone().ok_or("No repository opened")?
    };

    let result = task::spawn_blocking(move || {
        let mut reader = GitReader::new(&path)?;
        reader.read_git_data_from_commit(&commit_id, 2000)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    store_session(&state, &result, true);
    let data = result.data;

    {
        let mut current_branch = state.current_branch.lock().unwrap();
        *current_branch = None;
        let mut current_view = state.current_view.lock().unwrap();
        *current_view = Some(data.clone());
    }

    log::info!("Jumped to commit with {} commits", data.commits.len());

    Ok(data)
}

/// Recent formatted backend log lines (oldest first) for the issue-report
/// dialog; see `log_buffer`.
#[tauri::command]
pub fn get_recent_logs() -> Vec<String> {
    crate::log_buffer::global().snapshot()
}

#[tauri::command]
pub fn get_branch_list(state: tauri::State<AppState>) -> Result<Vec<BranchLane>, String> {
    let current_repo = state.current_repo.lock().unwrap();
    let reader = current_repo.as_ref().ok_or("No repository opened")?;
    // Reuse the view built by open_repository / switch_branch / filter so
    // this stays cheap (no second revwalk + layout on every repo open).
    let view = state.current_view.lock().unwrap().clone();
    let view = view.as_ref().ok_or("No repository opened")?;
    let mut list = reader.get_branch_list(view)?;

    let include_stale = *state.include_stale.lock().unwrap();
    if !include_stale {
        let stale: HashSet<String> = state
            .session
            .lock()
            .unwrap()
            .as_ref()
            .map(|s| s.stale_names.iter().cloned().collect())
            .unwrap_or_default();
        list.retain(|b| b.is_tag || !stale.contains(&b.name));
    }
    Ok(list)
}

#[tauri::command]
pub async fn switch_branch(
    branch_name: String,
    state: tauri::State<'_, AppState>,
) -> Result<GitData, String> {
    let branch_name_clone = branch_name.clone();
    let path = {
        let current_path = state.current_path.lock().unwrap();
        current_path.clone().ok_or("No repository opened")?
    };

    // "View from this branch" is an explicit user action: the stale-branch
    // setting does not apply, but the session still tracks the view so
    // pagination works here too.
    let result = task::spawn_blocking(move || {
        let mut reader = GitReader::new(&path)?;
        reader.read_git_data_from_branch(&branch_name_clone, 2000)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    store_session(&state, &result, true);
    let data = result.data;

    let mut current_branch = state.current_branch.lock().unwrap();
    *current_branch = Some(branch_name);

    let mut current_view = state.current_view.lock().unwrap();
    *current_view = Some(data.clone());

    log::info!("Switched to branch with {} commits", data.commits.len());

    Ok(data)
}

#[tauri::command]
pub async fn filter_by_branches(
    branch_names: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<GitData, String> {
    // Get repo path first (must do on main thread)
    let path = {
        let current_path = state.current_path.lock().unwrap();
        current_path.clone().ok_or("No repository opened")?
    };

    let result = task::spawn_blocking(move || {
        let mut reader = GitReader::new(&path)?;
        reader.filter_by_branches(&branch_names)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    store_session(&state, &result, true);
    let data = result.data;

    let mut current_view = state.current_view.lock().unwrap();
    *current_view = Some(data.clone());

    log::info!("Filtered to {} commits", data.commits.len());

    Ok(data)
}

/// Page in the next chunk of older history for the current view. The whole
/// loaded set is re-laid out (lane ownership and x coordinates are global),
/// and the returned GitData replaces the current view.
#[tauri::command]
pub async fn load_older_commits(state: tauri::State<'_, AppState>) -> Result<GitData, String> {
    let (path, seeds, seen, existing, has_more) = {
        let path = state.current_path.lock().unwrap().clone();
        let session = state.session.lock().unwrap();
        let view = state.current_view.lock().unwrap();
        match (path, session.as_ref(), view.as_ref()) {
            (Some(p), Some(s), Some(v)) => (
                p,
                s.seeds.clone(),
                s.seen.clone(),
                v.commits.clone(),
                v.has_more,
            ),
            _ => return Err("No repository opened".to_string()),
        }
    };

    if !has_more {
        let view = state.current_view.lock().unwrap();
        return Ok(view.as_ref().expect("checked above").clone());
    }

    let data = task::spawn_blocking(move || {
        let reader = GitReader::new(&path)?;
        reader.load_more(&seeds, &seen, existing, 2000)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    {
        let mut session = state.session.lock().unwrap();
        if let Some(s) = session.as_mut() {
            s.seen = data.commits.iter().map(|c| c.id.clone()).collect();
            // A chunk may have reached a previously stale branch tip. Only
            // recompute when stale seeds are still in play (include_stale on)
            // — otherwise they are never walked toward and stay stale.
            if *state.include_stale.lock().unwrap() {
                let ids: HashSet<&str> = data.commits.iter().map(|c| c.id.as_str()).collect();
                s.stale_names = s
                    .seeds
                    .iter()
                    .filter(|sd| !ids.contains(sd.tip.as_str()))
                    .map(|sd| sd.name.clone())
                    .collect();
            }
        }
    }

    let mut current_view = state.current_view.lock().unwrap();
    *current_view = Some(data.clone());

    log::info!(
        "Loaded older history: {} commits total, has_more={}",
        data.commits.len(),
        data.has_more
    );

    Ok(data)
}

/// Diff volume for node sizing. One tree diff per commit, so it runs on
/// demand after the view has rendered, not on the open path.
#[tauri::command]
pub async fn get_commit_stats(
    commit_ids: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<CommitStat>, String> {
    let path = {
        let current_path = state.current_path.lock().unwrap();
        current_path.clone().ok_or("No repository opened")?
    };

    task::spawn_blocking(move || {
        let reader = GitReader::new(&path)?;
        reader.get_commit_stats(&commit_ids)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Full-history commit search (Cmd+F). Read-only: walks every commit from
/// the branch tips and matches subject/author substrings. `in_view` marks
/// commits inside the current pagination window.
#[tauri::command]
pub async fn search_commits(
    query: String,
    limit: usize,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<SearchHit>, String> {
    let path = {
        let current_path = state.current_path.lock().unwrap();
        current_path.clone().ok_or("No repository opened")?
    };
    let loaded: HashSet<String> = {
        let session = state.session.lock().unwrap();
        session
            .as_ref()
            .map(|s| s.seen.clone())
            .unwrap_or_default()
    };

    task::spawn_blocking(move || {
        let reader = GitReader::new(&path)?;
        reader.search_commits(&query, limit, &loaded)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Cherry-pick / rebase detection across the current view's commits.
/// Expensive (one diff per commit), so it runs on demand via the Copies
/// toggle, inside spawn_blocking.
#[tauri::command]
pub async fn get_patch_links(state: tauri::State<'_, AppState>) -> Result<Vec<PatchLink>, String> {
    let (path, commits) = {
        let path = state.current_path.lock().unwrap().clone();
        let view = state.current_view.lock().unwrap().clone();
        match (path, view) {
            (Some(p), Some(v)) => (p, v.commits),
            _ => return Err("No repository opened".to_string()),
        }
    };

    task::spawn_blocking(move || {
        let reader = GitReader::new(&path)?;
        reader.get_patch_links(&commits)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

// --- Integrated terminal (bottom panel) ---

/// Spawn (or return the existing) shell session in the currently open
/// repository. Idempotent: a live session is returned as-is, so the
/// frontend can call this on every panel mount/remount (React StrictMode
/// double-mounts, HMR) without leaking shells.
#[tauri::command]
pub async fn terminal_spawn(
    cols: u16,
    rows: u16,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<TerminalInfo, String> {
    // Fast path under a short lock; the guard must be dropped before the
    // await below, or the future stops being Send.
    {
        let terminal = state.terminal.lock().unwrap();
        if let Some(session) = terminal.as_ref() {
            return Ok(session.info());
        }
    }
    let path = {
        let current_path = state.current_path.lock().unwrap();
        current_path.clone().ok_or("No repository opened")?
    };
    // openpty + fork is millisecond-scale, but it still has no business on
    // the main thread — same reasoning as the git commands above.
    let session =
        task::spawn_blocking(move || crate::terminal::spawn_for_app(&app, std::path::Path::new(&path), cols, rows))
            .await
            .map_err(|e| format!("Task join error: {}", e))??;
    let mut terminal = state.terminal.lock().unwrap();
    // A racing second spawn can't come from the single frontend caller, but
    // if it ever does: first session wins, the loser is dropped (killed).
    if let Some(existing) = terminal.as_ref() {
        return Ok(existing.info());
    }
    let info = session.info();
    *terminal = Some(session);
    Ok(info)
}

/// Forward keystrokes/paste from xterm.js to the PTY.
#[tauri::command]
pub fn terminal_write(data: String, state: tauri::State<AppState>) -> Result<(), String> {
    let terminal = state.terminal.lock().unwrap();
    terminal
        .as_ref()
        .ok_or("No terminal session")?
        .write_all(&data)
}

/// Sync the PTY size after a frontend fit().
#[tauri::command]
pub fn terminal_resize(
    cols: u16,
    rows: u16,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let terminal = state.terminal.lock().unwrap();
    terminal
        .as_ref()
        .ok_or("No terminal session")?
        .resize(cols, rows)
}

/// Kill the session (restart button). Dropping the PtySession closes the
/// master fd → SIGHUP → the reader thread EOFs, reaps and emits
/// "terminal-exit".
#[tauri::command]
pub fn terminal_kill(state: tauri::State<AppState>) -> Result<(), String> {
    *state.terminal.lock().unwrap() = None;
    Ok(())
}

use git2::Repository;
