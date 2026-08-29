mod commands;
pub mod git_reader;
pub mod layout;
pub mod log_buffer;
pub mod models;
pub mod repo_watch;
pub mod terminal;

use commands::AppState;
use log::LevelFilter;
use tauri::Manager;

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

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .manage(terminal::PtyRegistry::default())
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
            commands::search_commits,
            commands::jump_to_commit,
 commands::get_commit_stats,
            commands::get_recent_logs,
            terminal::pty_spawn,
            terminal::pty_write,
            terminal::pty_resize,
            terminal::pty_close,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // Kill every PTY child on app exit so no shell processes outlive
        // the window (the webview dying alone would leave them orphaned).
        if let tauri::RunEvent::Exit = event {
            if let Some(registry) = app_handle.try_state::<terminal::PtyRegistry>() {
                registry.kill_all();
            }
        }
    });
}
