mod backup_file;
mod database;
mod edge_hide;
mod edge_motion;
mod edge_policy;
mod edge_snap;
mod window_geometry;
#[cfg(windows)]
mod window_snap;

use database::Database;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, PhysicalPosition, PhysicalSize, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

fn fit_window(window: &tauri::WebviewWindow, dock: bool) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or(window.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or("没有可用显示器")?;
    let area = monitor.work_area();
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let scale = monitor.scale_factor();
    let fitted = window_geometry::fit(
        window_geometry::Bounds {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        },
        window_geometry::Bounds {
            x: area.position.x,
            y: area.position.y,
            width: area.size.width,
            height: area.size.height,
        },
        (16.0 * scale) as u32,
        dock,
    );
    // Keep controls reachable even when the available display is smaller than
    // the usual minimum size (for example, after a display/DPI change).
    window
        .set_min_size(Some(PhysicalSize::new(
            ((300.0 * scale) as u32).min(area.size.width),
            ((360.0 * scale) as u32).min(area.size.height),
        )))
        .map_err(|e| e.to_string())?;
    if size.width != fitted.width || size.height != fitted.height {
        window
            .set_size(PhysicalSize::new(fitted.width, fitted.height))
            .map_err(|e| e.to_string())?;
    }
    if position.x != fitted.x || position.y != fitted.y {
        window
            .set_position(PhysicalPosition::new(fitted.x, fitted.y))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn place_top_right(window: &tauri::WebviewWindow) -> Result<(), String> {
    fit_window(window, true)
}

fn ensure_visible(window: &tauri::WebviewWindow) {
    let _ = fit_window(window, false);
}

fn show_window(app: &tauri::AppHandle) {
    let _ = edge_hide::reveal(app, true);
}

#[tauri::command]
fn dock_window(window: tauri::WebviewWindow) -> Result<(), String> {
    place_top_right(&window)
}

#[tauri::command]
fn data_path(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("taskdock.sqlite3").to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_file(app: tauri::AppHandle, payload: String) -> Result<bool, String> {
    database::validate_payload(&payload)?;
    let hold = edge_hide::hold(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let _hold = hold;
        let window = app.get_webview_window("main").ok_or("主窗口不可用")?;
        let picked = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("导出 TaskDock 备份")
            .add_filter("TaskDock 备份", &["json"])
            .set_file_name("TaskDock-backup.json")
            .blocking_save_file();
        let Some(file) = picked else { return Ok(false) };
        let path = file.into_path().map_err(|e| e.to_string())?;
        backup_file::save(&path, &payload)?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn import_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let hold = edge_hide::hold(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let _hold = hold;
        let window = app.get_webview_window("main").ok_or("主窗口不可用")?;
        let picked = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("导入 TaskDock 备份")
            .add_filter("TaskDock 备份", &["json"])
            .blocking_pick_file();
        let Some(file) = picked else { return Ok(None) };
        let path = file.into_path().map_err(|e| e.to_string())?;
        if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > 50 * 1024 * 1024 {
            return Err("文件不能超过 50 MB".into());
        }
        std::fs::read_to_string(path)
            .map(Some)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_window(app)
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_filename("window-state.json")
                .with_denylist(&["edge-handle"])
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION)
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .invoke_handler(tauri::generate_handler![
            database::read_document,
            database::write_document,
            database::list_backups,
            database::read_backup,
            dock_window,
            data_path,
            export_file,
            import_file,
            edge_hide::get_window_pinned,
            edge_hide::set_window_pinned,
            edge_hide::set_edge_interaction,
            edge_hide::set_edge_motion_ready,
            edge_hide::complete_edge_motion,
            edge_hide::edge_handle_ready,
            edge_hide::reveal_edge_window,
            edge_hide::hide_to_tray
        ])
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let database = std::fs::create_dir_all(&data_dir)
                .map_err(|e| e.to_string())
                .and_then(|_| database::open(&data_dir.join("taskdock.sqlite3")));
            app.manage(Database(Mutex::new(database)));
            let window = app
                .get_webview_window("main")
                .ok_or("main window missing")?;
            if !app
                .path()
                .app_config_dir()?
                .join("window-state.json")
                .exists()
            {
                let _ = place_top_right(&window);
            }
            ensure_visible(&window);
            #[cfg(windows)]
            window_snap::install(&window)?;
            edge_hide::initialize(app.handle())?;
            let show = MenuItem::with_id(app, "show", "显示 TaskDock", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "隐藏窗口", true, None::<&str>)?;
            let dock = MenuItem::with_id(app, "dock", "停靠右上角", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &hide, &dock, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().ok_or("app icon missing")?.clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("TaskDock · 事项坞")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_window(app),
                    "hide" => {
                        let _ = edge_hide::hide(app);
                    }
                    "dock" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = place_top_right(&w);
                        }
                        show_window(app);
                    }
                    "quit" => {
                        let _ = app.save_window_state(StateFlags::SIZE | StateFlags::POSITION);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(false) {
                                let _ = edge_hide::hide(app);
                            } else {
                                show_window(app);
                            }
                        }
                    }
                })
                .build(app)?;
            window.show()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if matches!(
                event,
                WindowEvent::Moved(_)
                    | WindowEvent::Resized(_)
                    | WindowEvent::Focused(_)
                    | WindowEvent::ScaleFactorChanged { .. }
            ) {
                edge_hide::wake(window.app_handle());
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window
                    .app_handle()
                    .save_window_state(StateFlags::SIZE | StateFlags::POSITION);
                let _ = edge_hide::hide(window.app_handle());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running TaskDock");
}
