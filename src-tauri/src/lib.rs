use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, LogicalPosition, LogicalSize, RunEvent, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;

const WINDOW_WIDTH: f64 = 360.0;
const WINDOW_HEIGHT: f64 = 560.0;
const MARGIN: f64 = 16.0;

fn place_top_right(window: &tauri::WebviewWindow) {
    if let Ok(Some(monitor)) = window.current_monitor() {
        let size = monitor.size();
        let scale = monitor.scale_factor();
        let screen_w = size.width as f64 / scale;
        let x = (screen_w - WINDOW_WIDTH - MARGIN).max(MARGIN);
        let y = MARGIN;
        let _ = window.set_size(LogicalSize::new(WINDOW_WIDTH, WINDOW_HEIGHT));
        let _ = window.set_position(LogicalPosition::new(x, y));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ));

    builder = builder.setup(|app| {
        let window = app
            .get_webview_window("main")
            .expect("main window missing");

        let _ = window.set_always_on_top(true);
        place_top_right(&window);

        let show_i = MenuItem::with_id(app, "show", "显示 TaskDock", true, None::<&str>)?;
        let hide_i = MenuItem::with_id(app, "hide", "隐藏窗口", true, None::<&str>)?;
        let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&show_i, &hide_i, &quit_i])?;

        let _tray = TrayIconBuilder::new()
            .icon(app.default_window_icon().unwrap().clone())
            .menu(&menu)
            .tooltip("TaskDock · 事项坞")
            .on_menu_event(|app, event| match event.id.as_ref() {
                "show" => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                        place_top_right(&w);
                    }
                }
                "hide" => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.hide();
                    }
                }
                "quit" => {
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
                            let _ = w.hide();
                        } else {
                            let _ = w.show();
                            let _ = w.set_focus();
                            place_top_right(&w);
                        }
                    }
                }
            })
            .build(app)?;

        Ok(())
    });

    let app = builder
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 点关闭时隐藏到托盘，而不是退出
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building TaskDock");

    app.run(|_app_handle, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            // 允许正常退出（托盘菜单退出）
            let _ = api;
        }
    });
}
