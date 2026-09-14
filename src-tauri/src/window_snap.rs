use crate::{edge_snap::Drag, window_geometry::Bounds};
use std::cell::Cell;
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
    Graphics::Gdi::{GetMonitorInfoW, MonitorFromRect, MONITORINFO, MONITOR_DEFAULTTONEAREST},
    UI::{
        HiDpi::GetDpiForWindow,
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            GetCursorPos, GetWindowRect, WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_MOVING, WM_NCDESTROY,
        },
    },
};

const SUBCLASS_ID: usize = 0x5444534e; // TDSN
type State = Cell<Option<Drag>>;

/// Called once from Tauri setup, on the HWND's owning event-loop thread.
pub fn install(window: &tauri::WebviewWindow) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as HWND;
    let state = Box::into_raw(Box::new(State::new(None)));
    // The callback owns this allocation until WM_NCDESTROY; no worker, global
    // mouse hook, JS round trip, or periodic timer is needed for snapping.
    if unsafe { SetWindowSubclass(hwnd, Some(subclass), SUBCLASS_ID, state as usize) } == 0 {
        unsafe {
            drop(Box::from_raw(state));
        }
        return Err("无法初始化窗口边缘吸附".into());
    }
    Ok(())
}

fn bounds(rect: RECT) -> Bounds {
    Bounds {
        x: rect.left,
        y: rect.top,
        width: rect.right.saturating_sub(rect.left).max(0) as u32,
        height: rect.bottom.saturating_sub(rect.top).max(0) as u32,
    }
}

fn rect(bounds: Bounds) -> RECT {
    RECT {
        left: bounds.x,
        top: bounds.y,
        right: (i64::from(bounds.x) + i64::from(bounds.width)) as i32,
        bottom: (i64::from(bounds.y) + i64::from(bounds.height)) as i32,
    }
}

unsafe extern "system" fn subclass(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    id: usize,
    data: usize,
) -> LRESULT {
    // Windows owns the message pointers. State is accessed only on this HWND's
    // thread, copied before Win32 calls, and never borrowed across reentrancy.
    match message {
        WM_ENTERSIZEMOVE => {
            let mut cursor = POINT::default();
            let mut current = RECT::default();
            let drag = if GetCursorPos(&mut cursor) != 0 && GetWindowRect(hwnd, &mut current) != 0 {
                Some(Drag::begin(bounds(current), (cursor.x, cursor.y)))
            } else {
                None
            };
            (*(data as *const State)).set(drag);
        }
        WM_MOVING if lparam != 0 => {
            if let Some(mut drag) = (*(data as *const State)).get() {
                let mut cursor = POINT::default();
                if GetCursorPos(&mut cursor) != 0 {
                    let proposed = bounds(*(lparam as *const RECT));
                    let raw = drag.proposed((cursor.x, cursor.y), proposed.width, proposed.height);
                    let monitor = MonitorFromRect(&rect(raw), MONITOR_DEFAULTTONEAREST);
                    let mut info = MONITORINFO {
                        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                        ..Default::default()
                    };
                    if GetMonitorInfoW(monitor, &mut info) != 0 {
                        let dpi = GetDpiForWindow(hwnd);
                        let fitted = drag.snap(raw, bounds(info.rcWork), f64::from(dpi) / 96.0);
                        (*(data as *const State)).set(Some(drag));
                        *(lparam as *mut RECT) = rect(fitted);
                        return 1;
                    }
                }
            }
        }
        WM_EXITSIZEMOVE => (*(data as *const State)).set(None),
        WM_NCDESTROY => {
            RemoveWindowSubclass(hwnd, Some(subclass), id);
            drop(Box::from_raw(data as *mut State));
        }
        _ => {}
    }
    // In particular, let Tao see enter/exit/resize/DPI/destroy notifications.
    DefSubclassProc(hwnd, message, wparam, lparam)
}
