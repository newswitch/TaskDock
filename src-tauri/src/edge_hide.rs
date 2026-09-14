use crate::{
    edge_motion::{Motions, Phase},
    edge_policy::{self, CollapseDelay, Edge},
    window_geometry::Bounds,
};
use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    path::Path,
    sync::{mpsc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

#[derive(Clone, Copy)]
struct Collapsed {
    area: Bounds,
    handle: Bounds,
    edge: Edge,
    scale: f64,
}

struct State {
    pinned: bool,
    blocked: bool,
    editing_input: bool,
    native_holds: usize,
    handle_ready: bool,
    handle_loading: bool,
    motion_ready: bool,
    motions: Motions,
    collapsed: Option<Collapsed>,
    delay: CollapseDelay,
}

pub struct EdgeController {
    state: Mutex<State>,
    wake: mpsc::SyncSender<()>,
}

const ACTIVE_POLL: Duration = Duration::from_millis(120);
const IDLE_POLL: Duration = Duration::from_secs(1);

// Coalesce movement/focus notifications. A sleeping worker uses no periodic
// timer when the window is pinned, blocked, minimized or deliberately hidden.
pub fn wake(app: &tauri::AppHandle) {
    if let Some(controller) = app.try_state::<EdgeController>() {
        let _ = controller.wake.try_send(());
    }
}

fn check_loop(
    wake_rx: mpsc::Receiver<()>,
    mut check: impl FnMut() -> Result<Option<Duration>, ()>,
) {
    let mut delay = Some(Duration::ZERO);
    loop {
        match delay {
            Some(delay) => {
                if let Err(mpsc::RecvTimeoutError::Disconnected) = wake_rx.recv_timeout(delay) {
                    break;
                }
            }
            None => {
                if wake_rx.recv().is_err() {
                    break;
                }
            }
        }
        while wake_rx.try_recv().is_ok() {}
        match check() {
            Ok(next) => delay = next,
            Err(()) => break,
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Preferences {
    version: u8,
    pinned: bool,
}

fn load_pinned(path: &Path) -> bool {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<Preferences>(&bytes)
            .map(|p| if p.version == 1 { p.pinned } else { true })
            .unwrap_or(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => true, // If preferences cannot be read, keep the main window accessible.
    }
}

fn save_pinned(path: &Path, pinned: bool) -> Result<(), String> {
    let directory = path.parent().ok_or("窗口设置路径无效")?;
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    let bytes =
        serde_json::to_vec(&Preferences { version: 1, pinned }).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

fn with_state<T>(
    app: &tauri::AppHandle,
    action: impl FnOnce(&mut State) -> T,
) -> Result<T, String> {
    let controller = app
        .try_state::<EdgeController>()
        .ok_or("靠边收起尚未就绪")?;
    let mut state = controller.state.lock().map_err(|e| e.to_string())?;
    Ok(action(&mut state))
}

pub fn initialize(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let path = app.path().app_config_dir()?.join("edge-hide.json");
    let (wake_tx, wake_rx) = mpsc::sync_channel(1);
    app.manage(EdgeController {
        state: Mutex::new(State {
            pinned: load_pinned(&path),
            blocked: true,
            editing_input: false,
            native_holds: 0,
            handle_ready: false,
            handle_loading: false,
            motion_ready: false,
            motions: Motions::default(),
            collapsed: None,
            delay: CollapseDelay::default(),
        }),
        wake: wake_tx,
    });

    // Wait for either an actual state change or the next useful check. Only
    // one check can be in flight; notifications received during it are retained.
    let app = app.clone();
    std::thread::spawn(move || {
        check_loop(wake_rx, || {
            let (done_tx, done_rx) = mpsc::sync_channel(1);
            let tick_app = app.clone();
            if app
                .run_on_main_thread(move || {
                    let next = tick(&tick_app).unwrap_or(Some(IDLE_POLL));
                    let _ = done_tx.send(next);
                })
                .is_err()
            {
                return Err(());
            }
            done_rx.recv().map_err(|_| ())
        });
    });
    Ok(())
}

fn build_handle(app: &tauri::AppHandle) -> Result<(), tauri::Error> {
    WebviewWindowBuilder::new(
        app,
        "edge-handle",
        WebviewUrl::App("edge-handle.html".into()),
    )
    .title("TaskDock · 边缘箭头")
    .inner_size(24.0, 64.0)
    // Override Windows' default minimum tracking size: otherwise a 24 px
    // arrow can be widened to a normal window and clipped by the screen edge.
    .min_inner_size(1.0, 1.0)
    .decorations(false)
    .transparent(true)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .focused(false)
    .focusable(false)
    .visible(false)
    .build()?;
    Ok(())
}

#[tauri::command]
pub fn get_window_pinned(app: tauri::AppHandle) -> Result<bool, String> {
    with_state(&app, |s| s.pinned)
}

#[tauri::command]
pub fn set_window_pinned(app: tauri::AppHandle, pinned: bool) -> Result<bool, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("edge-hide.json");
    save_pinned(&path, pinned)?;
    let was_collapsed = with_state(&app, |s| {
        s.pinned = pinned;
        s.delay.reset();
        s.collapsed.is_some()
    })?;
    if pinned && was_collapsed {
        reveal(&app, false)?;
    }
    wake(&app);
    Ok(pinned)
}

#[tauri::command]
pub fn set_edge_interaction(
    app: tauri::AppHandle,
    blocked: bool,
    editing_input: bool,
) -> Result<(), String> {
    with_state(&app, |s| {
        s.blocked = blocked;
        s.editing_input = editing_input;
        s.delay.reset();
    })?;
    wake(&app);
    Ok(())
}

#[tauri::command]
pub fn set_edge_motion_ready(window: tauri::WebviewWindow, ready: bool) -> Result<(), String> {
    if window.label() != "main" {
        return Err("动效只能由主窗口控制".into());
    }
    with_state(window.app_handle(), |s| s.motion_ready = ready)?;
    wake(window.app_handle());
    Ok(())
}

#[tauri::command]
pub fn complete_edge_motion(window: tauri::WebviewWindow, id: u64) -> Result<(), String> {
    if window.label() != "main" {
        return Err("动效只能由主窗口完成".into());
    }
    finish_motion(window.app_handle(), id)
}

fn finish_motion(app: &tauri::AppHandle, id: u64) -> Result<(), String> {
    let (motion, blocked) = with_state(app, |s| {
        (
            s.motions.complete(id),
            s.pinned || s.blocked || s.native_holds > 0,
        )
    })?;
    let Some(motion) = motion else {
        return Ok(());
    };
    if motion.phase == Phase::Hide && blocked {
        return reveal(app, false);
    }
    let main = app.get_webview_window("main").ok_or("主窗口不可用")?;
    if motion.phase == Phase::Hide {
        if let Err(error) = main.hide() {
            let _ = restore_immediately(app, false);
            return Err(error.to_string());
        }
    } else if let Some(handle) = app.get_webview_window("edge-handle") {
        let _ = handle.hide();
    }
    with_state(app, |s| s.delay.reset())?;
    wake(app);
    Ok(())
}

#[tauri::command]
pub fn edge_handle_ready(app: tauri::AppHandle) -> Result<Edge, String> {
    let edge = with_state(&app, |s| {
        s.handle_ready = true;
        s.collapsed.map(|c| c.edge).unwrap_or(Edge::Right)
    })?;
    wake(&app);
    Ok(edge)
}

#[tauri::command]
pub fn reveal_edge_window(app: tauri::AppHandle) -> Result<(), String> {
    reveal(&app, false)
}

#[tauri::command]
pub fn hide_to_tray(app: tauri::AppHandle) -> Result<(), String> {
    hide(&app)
}

pub fn hide(app: &tauri::AppHandle) -> Result<(), String> {
    // A deliberate tray hide must remove the arrow too and stay hidden.
    if let Some(handle) = app.get_webview_window("edge-handle") {
        handle.hide().map_err(|e| e.to_string())?;
    }
    if let Some(main) = app.get_webview_window("main") {
        main.hide().map_err(|e| e.to_string())?;
    }
    let _ = with_state(app, |s| {
        s.collapsed = None;
        s.delay.reset();
    });
    reset_motion(app);
    wake(app);
    Ok(())
}

fn reset_motion(app: &tauri::AppHandle) {
    let request = with_state(app, |s| {
        s.motions.start(Phase::Reset, Edge::Right, Instant::now())
    });
    if let (Ok(request), Some(main)) = (request, app.get_webview_window("main")) {
        let _ = main.emit("edge-motion", request);
    }
}

fn restore_immediately(app: &tauri::AppHandle, focus: bool) -> Result<(), String> {
    reset_motion(app);
    let main = app.get_webview_window("main").ok_or("主窗口不可用")?;
    crate::ensure_visible(&main);
    if main.is_minimized().map_err(|e| e.to_string())? {
        main.unminimize().map_err(|e| e.to_string())?;
    }
    main.show().map_err(|e| e.to_string())?;
    if let Some(handle) = app.get_webview_window("edge-handle") {
        let _ = handle.hide();
    }
    let _ = with_state(app, |s| {
        s.collapsed = None;
        s.delay.reset();
    });
    if focus {
        main.set_focus().map_err(|e| e.to_string())?;
    }
    wake(app);
    Ok(())
}

pub fn reveal(app: &tauri::AppHandle, focus: bool) -> Result<(), String> {
    let (collapsed, pending, ready) =
        with_state(app, |s| (s.collapsed, s.motions.pending(), s.motion_ready))?;
    if pending.is_some_and(|motion| motion.phase == Phase::Show) {
        if focus {
            app.get_webview_window("main")
                .ok_or("主窗口不可用")?
                .set_focus()
                .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let Some(collapsed) = collapsed.filter(|_| ready) else {
        return restore_immediately(app, focus);
    };
    let main = app.get_webview_window("main").ok_or("主窗口不可用")?;
    crate::ensure_visible(&main);
    if main.is_minimized().map_err(|e| e.to_string())? {
        main.unminimize().map_err(|e| e.to_string())?;
    }
    // The frontend remains parked after a hide. Showing the native host cannot
    // flash content before its animation starts; no native frame-by-frame moves.
    main.show().map_err(|e| e.to_string())?;
    let request = with_state(app, |s| {
        s.collapsed = None;
        s.delay.reset();
        s.motions.start(Phase::Show, collapsed.edge, Instant::now())
    })?;
    if main.emit("edge-motion", request).is_err() {
        return restore_immediately(app, focus);
    }
    if focus {
        main.set_focus().map_err(|e| e.to_string())?;
    }
    // Leave the arrow as an anchor until the panel has arrived.
    wake(app);
    Ok(())
}

pub struct NativeHold(tauri::AppHandle);

pub fn hold(app: &tauri::AppHandle) -> NativeHold {
    let _ = with_state(app, |s| {
        s.native_holds += 1;
        s.delay.reset();
    });
    wake(app);
    NativeHold(app.clone())
}

impl Drop for NativeHold {
    fn drop(&mut self) {
        let _ = with_state(&self.0, |s| {
            s.native_holds = s.native_holds.saturating_sub(1);
            s.delay.reset();
        });
        wake(&self.0);
    }
}

fn monitor_area(monitor: &tauri::Monitor) -> Bounds {
    let area = monitor.work_area();
    Bounds {
        x: area.position.x,
        y: area.position.y,
        width: area.size.width,
        height: area.size.height,
    }
}

#[cfg(windows)]
fn pointer_button_down() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON,
    };
    // Query button state only; do not install a hook or intercept input.
    [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON]
        .into_iter()
        .any(|key| unsafe { GetAsyncKeyState(i32::from(key)) < 0 })
}

#[cfg(not(windows))]
fn pointer_button_down() -> bool {
    false
}

fn tick(app: &tauri::AppHandle) -> Result<Option<Duration>, String> {
    let main = app.get_webview_window("main").ok_or("主窗口不可用")?;
    let (pinned, blocked, editing_input, handle_ready, collapsed, pending, motion_ready) =
        with_state(app, |s| {
            (
                s.pinned,
                s.blocked || s.native_holds > 0,
                s.editing_input,
                s.handle_ready,
                s.collapsed,
                s.motions.pending(),
                s.motion_ready,
            )
        })?;
    if let Some(motion) = pending {
        if motion.phase == Phase::Hide {
            let cursor = app.cursor_position().map_err(|e| e.to_string())?;
            let position = main.outer_position().map_err(|e| e.to_string())?;
            let size = main.outer_size().map_err(|e| e.to_string())?;
            let bounds = Bounds {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            };
            if pinned
                || blocked
                || pointer_button_down()
                || edge_policy::contains(bounds, cursor.x, cursor.y, 0.0)
                || collapsed
                    .is_some_and(|c| edge_policy::contains(c.handle, cursor.x, cursor.y, 0.0))
            {
                reveal(app, false)?;
                return Ok(Some(ACTIVE_POLL));
            }
        }
        if motion.expired(Instant::now()) || !motion_ready {
            // Settle both halves if a suspended renderer missed its completion.
            let mut settled = motion;
            settled.phase = if motion.phase == Phase::Hide {
                Phase::Park
            } else {
                Phase::Reset
            };
            let _ = main.emit("edge-motion", settled);
            finish_motion(app, motion.id)?;
        }
        return Ok(Some(ACTIVE_POLL));
    }
    if let Some(collapsed) = collapsed {
        let monitors = main.available_monitors().map_err(|e| e.to_string())?;
        let monitor_still_present = monitors.iter().any(|m| {
            monitor_area(m) == collapsed.area && (m.scale_factor() - collapsed.scale).abs() < 0.01
        });
        let cursor = app.cursor_position().map_err(|e| e.to_string())?;
        if pinned
            || blocked
            || !monitor_still_present
            || edge_policy::contains(collapsed.handle, cursor.x, cursor.y, 0.0)
        {
            reveal(app, false)?;
        }
        // Pointer entry is handled immediately by the arrow's pointer event.
        // This slow check only covers display changes and provides a fallback.
        return Ok(Some(IDLE_POLL));
    }
    if pinned
        || blocked
        || !main.is_visible().map_err(|e| e.to_string())?
        || main.is_minimized().map_err(|e| e.to_string())?
    {
        with_state(app, |s| s.delay.reset())?;
        return Ok(None);
    }
    let position = main.outer_position().map_err(|e| e.to_string())?;
    let size = main.outer_size().map_err(|e| e.to_string())?;
    let bounds = Bounds {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    let monitor = match main.current_monitor().map_err(|e| e.to_string())? {
        Some(monitor) => Some(monitor),
        None => main.primary_monitor().map_err(|e| e.to_string())?,
    }
    .ok_or("没有可用显示器")?;
    let area = monitor_area(&monitor);
    let scale = monitor.scale_factor();
    let edge = edge_policy::nearest_edge(bounds, area, (28.0 * scale).round() as u32);
    if edge.is_none() {
        with_state(app, |s| s.delay.reset())?;
        return Ok(Some(IDLE_POLL));
    }
    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
    let handle = edge.map(|side| edge_policy::handle_bounds(bounds, area, side, scale));
    // Include the future arrow so hovering there won't cause a collapse/reveal loop
    // when the original window has a small gap from the edge.
    let pointer_inside = edge_policy::contains(bounds, cursor.x, cursor.y, 6.0 * scale)
        || handle.is_some_and(|h| edge_policy::contains(h, cursor.x, cursor.y, 0.0));
    let typing = editing_input && main.is_focused().map_err(|e| e.to_string())?;
    let eligible = edge.is_some() && !pointer_inside && !typing && !pointer_button_down();
    if !with_state(app, |s| s.delay.ready(bounds, eligible, Instant::now()))? {
        return Ok(Some(ACTIVE_POLL));
    }
    let (Some(edge), Some(handle_bounds)) = (edge, handle) else {
        return Ok(Some(ACTIVE_POLL));
    };
    if !handle_ready {
        let should_build = with_state(app, |s| {
            if s.handle_loading {
                return false;
            }
            s.handle_loading = true;
            true
        })?;
        if should_build && app.get_webview_window("edge-handle").is_none() {
            // WebView2 creation can wait on the event loop: create off-thread,
            // then wait for the arrow's listener before hiding the main window.
            let app = app.clone();
            std::thread::spawn(move || {
                if build_handle(&app).is_err() {
                    let _ = with_state(&app, |s| {
                        s.handle_loading = false;
                        s.delay.reset();
                    });
                    // Keep the main window visible and let the normal delay
                    // retry; do not create a tight wake/rebuild loop on failure.
                    return;
                }
                wake(&app);
            });
        }
        return Ok(Some(IDLE_POLL));
    }
    let handle = app
        .get_webview_window("edge-handle")
        .ok_or("边缘箭头不可用")?;
    handle
        .set_size(PhysicalSize::new(handle_bounds.width, handle_bounds.height))
        .map_err(|e| e.to_string())?;
    handle
        .set_position(PhysicalPosition::new(handle_bounds.x, handle_bounds.y))
        .map_err(|e| e.to_string())?;
    handle
        .emit("edge-handle-side", edge)
        .map_err(|e| e.to_string())?;
    // Keep the full-size main window in place while hidden: persistence never
    // records arrow dimensions or an off-screen main-window position.
    handle.show().map_err(|e| e.to_string())?;
    let request = with_state(app, |s| {
        s.collapsed = Some(Collapsed {
            area,
            handle: handle_bounds,
            edge,
            scale,
        });
        s.delay.reset();
        motion_ready.then(|| s.motions.start(Phase::Hide, edge, Instant::now()))
    })?;
    if let Some(request) = request {
        if main.emit("edge-motion", request).is_ok() {
            return Ok(Some(ACTIVE_POLL));
        }
        // The arrow is already available, so an event-delivery failure can
        // safely fall back to the ordinary native hide.
        return finish_motion(app, request.id).map(|_| Some(IDLE_POLL));
    }
    if let Err(error) = main.hide() {
        let _ = handle.hide();
        let _ = with_state(app, |s| s.collapsed = None);
        return Err(error.to_string());
    }
    with_state(app, |s| {
        s.delay.reset();
    })?;
    Ok(Some(IDLE_POLL))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suspended_checks_sleep_until_an_event_arrives() {
        let (wake_tx, wake_rx) = mpsc::sync_channel(1);
        let (checked_tx, checked_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            check_loop(wake_rx, || {
                checked_tx.send(()).unwrap();
                Ok(None)
            })
        });
        checked_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(
            checked_rx.recv_timeout(Duration::from_millis(260)),
            Err(mpsc::RecvTimeoutError::Timeout)
        );
        wake_tx.send(()).unwrap();
        checked_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        drop(wake_tx);
        worker.join().unwrap();
    }

    #[test]
    fn events_during_a_check_are_retained_and_coalesced() {
        let (wake_tx, wake_rx) = mpsc::sync_channel(1);
        let (checked_tx, checked_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            check_loop(wake_rx, || {
                checked_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(None)
            })
        });
        checked_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        for _ in 0..100 {
            let _ = wake_tx.try_send(());
        }
        release_tx.send(()).unwrap();
        checked_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        release_tx.send(()).unwrap();
        assert_eq!(
            checked_rx.recv_timeout(Duration::from_millis(40)),
            Err(mpsc::RecvTimeoutError::Timeout)
        );
        drop(wake_tx);
        worker.join().unwrap();
    }

    #[test]
    fn active_checks_resume_on_a_timeout_and_can_suspend_again() {
        let (wake_tx, wake_rx) = mpsc::sync_channel(1);
        let (checked_tx, checked_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let mut count = 0;
            check_loop(wake_rx, || {
                count += 1;
                checked_tx.send(count).unwrap();
                Ok((count == 1).then_some(Duration::from_millis(20)))
            });
        });
        assert_eq!(checked_rx.recv_timeout(Duration::from_secs(2)).unwrap(), 1);
        assert_eq!(checked_rx.recv_timeout(Duration::from_secs(2)).unwrap(), 2);
        assert_eq!(
            checked_rx.recv_timeout(Duration::from_millis(40)),
            Err(mpsc::RecvTimeoutError::Timeout)
        );
        drop(wake_tx);
        worker.join().unwrap();
    }

    #[test]
    fn pin_preference_survives_reopening_and_can_be_disabled() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("edge-hide.json");
        assert!(!load_pinned(&path));
        save_pinned(&path, true).unwrap();
        assert!(load_pinned(&path));
        save_pinned(&path, false).unwrap();
        assert!(!load_pinned(&path));
    }

    #[test]
    fn unreadable_or_future_preferences_keep_the_window_pinned() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("edge-hide.json");
        std::fs::write(&path, "broken").unwrap();
        assert!(load_pinned(&path));
        std::fs::write(&path, r#"{"version":99,"pinned":false}"#).unwrap();
        assert!(load_pinned(&path));
    }
}
