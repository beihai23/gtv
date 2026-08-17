mod commands;
mod git_reader;
mod models;

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    log::info!("Starting Git Timeline Viewer");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_repository,
            commands::get_commit_detail,
            commands::get_current_path,
            commands::get_current_branch,
            commands::is_valid_git_repo,
            commands::get_branch_list,
            commands::switch_branch,
            commands::filter_by_branches,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
