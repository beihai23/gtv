use crate::git_reader::GitReader;
use crate::models::*;
use std::sync::Mutex;
use tokio::task;

pub struct AppState {
    pub current_repo: Mutex<Option<GitReader>>,
    pub current_path: Mutex<Option<String>>,
    pub current_branch: Mutex<Option<String>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            current_repo: Mutex::new(None),
            current_path: Mutex::new(None),
            current_branch: Mutex::new(None),
        }
    }
}

#[tauri::command]
pub async fn open_repository(path: String, state: tauri::State<'_, AppState>) -> Result<GitData, String> {
    let path_clone = path.clone();
    
    let data = task::spawn_blocking(move || {
        let mut reader = GitReader::new(&path_clone)?;
        reader.read_git_data(2000)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    let mut current_repo = state.current_repo.lock().unwrap();
    *current_repo = Some(GitReader::new(&path).map_err(|e| e.to_string())?);

    let mut current_path = state.current_path.lock().unwrap();
    *current_path = Some(path);

    let mut current_branch = state.current_branch.lock().unwrap();
    *current_branch = Some(data.main_branch.clone());

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

#[tauri::command]
pub fn get_branch_list(state: tauri::State<AppState>) -> Result<Vec<BranchLane>, String> {
    let current_repo = state.current_repo.lock().unwrap();
    let reader = current_repo.as_ref().ok_or("No repository opened")?;
    reader.get_branch_list()
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
    
    let data = task::spawn_blocking(move || {
        let mut reader = GitReader::new(&path)?;
        reader.read_git_data_from_branch(&branch_name_clone, 2000)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    let mut current_branch = state.current_branch.lock().unwrap();
    *current_branch = Some(branch_name);

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
    
    let data = task::spawn_blocking(move || {
        let mut reader = GitReader::new(&path)?;
        reader.filter_by_branches(&branch_names)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))??;

    log::info!("Filtered to {} commits", data.commits.len());

    Ok(data)
}

use git2::Repository;
