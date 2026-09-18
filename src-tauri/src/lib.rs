pub mod commands;
pub mod fetcher;
pub mod git_reader;
pub mod layout;
pub mod log_buffer;
pub mod models;
pub mod terminal;
pub mod watcher;

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
        .setup(|app| {
            // Repo-change poller (watcher.rs): plain std thread, no
            // filesystem watcher, so no extra deps and no events on
            // transient index files.
            watcher::spawn_poller(app.handle().clone());
            // Auto-fetcher (fetcher.rs): plain std thread fetching the
            // ACTIVE repository's remotes every 60 s. Writes refs/remotes
            // and objects only, and never emits: the watcher's poll is
            // the single refresh path.
            fetcher::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_repository,
            commands::close_repository,
            commands::set_active_repository,
            commands::set_auto_fetch,
            commands::set_include_stale,
            commands::get_commit_detail,
            commands::get_file_diff,
            commands::get_compare_detail,
            commands::get_pair_file_diff,
            commands::is_valid_git_repo,
            commands::get_branch_list,
            commands::switch_branch,
            commands::get_worktree_status,
            commands::checkout_branch,
            commands::filter_by_branches,
            commands::load_older_commits,
            commands::get_patch_links,
            commands::search_commits,
            commands::jump_to_commit,
            commands::get_commit_stats,
            commands::get_recent_logs,
            commands::terminal_spawn,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
