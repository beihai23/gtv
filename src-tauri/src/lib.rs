mod commands;
pub mod git_reader;
pub mod layout;
pub mod log_buffer;
pub mod models;

use commands::AppState;
use log::LevelFilter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // BufferedLogger mirrors every record into the in-memory ring buffer
    // (issue-report context) before delegating to env_logger on stderr.
    let env_logger =
        env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
            .build();
    log::set_boxed_logger(Box::new(log_buffer::BufferedLogger::new(env_logger)))
        .expect("failed to install buffered logger");
    log::set_max_level(LevelFilter::Info);

    log::info!("Starting Git Timeline Viewer");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_repository,
            commands::get_commit_detail,
            commands::get_file_diff,
            commands::get_current_path,
            commands::get_current_branch,
            commands::is_valid_git_repo,
            commands::get_branch_list,
            commands::switch_branch,
            commands::filter_by_branches,
            commands::load_older_commits,
            commands::get_patch_links,
            commands::get_commit_stats,
            commands::get_recent_logs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
