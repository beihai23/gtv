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
            // macOS owns Cmd+W via a rebuilt menu (Task-5 review Fix-1,
            // Critical). Fact chain, verified against vendored sources:
            // tauri 2.10.3 menu/menu.rs:171 and :217 -- the default menu's
            // Window and File submenus each carry a PredefinedMenuItem::
            // close_window; muda 0.17.1 items/predefined.rs:336-338 -- on
            // macOS that item's default accelerator is CMD_OR_CTRL+KeyW
            // (Alt+F4 elsewhere, so Windows/Linux are unaffected and the
            // page's keydown handler stays sufficient there). macOS NSMenu
            // key equivalents fire BEFORE the responder chain reaches the
            // WKWebView, so the page never sees the keydown and the JS
            // preventDefault is dead code -- Cmd+W ran performClose: on
            // the single window (= quit, every PTY dead). gtv configured
            // no menu, so the default menu was installed. Fix: rebuild the
            // default menu's makeup WITHOUT any close_window predefined
            // item and hand Cmd+W to a custom item that emits to the
            // webview instead. The Edit submenu must survive (undo/redo/
            // cut/copy/paste/select_all) or macOS has no clipboard key
            // equivalents inside the webview at all.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{AboutMetadata, Menu, MenuItem, SubmenuBuilder};
                use tauri::{Emitter, Manager};

                let handle = app.handle();
                let pkg_info = handle.package_info();
                let about_metadata = AboutMetadata {
                    name: Some(pkg_info.name.clone()),
                    version: Some(pkg_info.version.to_string()),
                    ..Default::default()
                };

                let app_submenu = SubmenuBuilder::new(handle, pkg_info.name.clone())
                    .about(Some(about_metadata))
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()?;

                let close_tab =
                    MenuItem::with_id(handle, "gtv-close-tab", "Close Tab", true, Some("CmdOrCtrl+W"))?;
                let file_submenu = SubmenuBuilder::new(handle, "File")
                    .item(&close_tab)
                    .build()?;

                let edit_submenu = SubmenuBuilder::new(handle, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;

                let view_submenu = SubmenuBuilder::new(handle, "View")
                    .fullscreen()
                    .build()?;

                let window_submenu = SubmenuBuilder::new(handle, "Window")
                    .minimize()
                    .maximize()
                    .build()?;

                let menu = Menu::with_items(handle, &[
                    &app_submenu,
                    &file_submenu,
                    &edit_submenu,
                    &view_submenu,
                    &window_submenu,
                ])?;
                app.set_menu(menu)?;

                // Main window label: tauri.conf.json declares no label, so
                // it defaults to "main" (tauri-utils config.rs
                // default_window_label).
                app.on_menu_event(|app, event| {
                    if event.id().0 == "gtv-close-tab" {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.emit("close-active-tab", ());
                        }
                    }
                });
            }

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
            commands::refresh_repository,
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
