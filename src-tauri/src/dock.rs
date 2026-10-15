//! dock.rs — the transparent window: where it sits, click-through, stacking
//!
//! Focus Pot is ONE frameless, transparent, always-on-top window anchored to
//! the bottom-left of the screen. Inside it the page draws:
//!
//!   • the pill on the taskbar (timer or music)
//!   • the panel above it, when you tap the pill
//!
//! Everything else must let clicks fall through to the apps underneath.
//! The page tells us which rectangles are "solid" (`set_hit_regions`); a
//! small background thread watches the cursor and switches the window
//! between click-through and clickable as the cursor enters/leaves them.
//! The same thread notices clicks outside those rectangles (so a tap
//! elsewhere can close the panel) and keeps us above the taskbar.
//!
//! All window maths happens in PHYSICAL pixels (real screen pixels), so the
//! window's bottom edge lands exactly on the screen's bottom edge at any
//! scaling. The page gets LOGICAL (CSS) pixels.

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HMODULE, HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTOPRIMARY};
use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowW, GetCursorPos, GetMessageW, GetWindow, GetWindowLongPtrW, SetWindowDisplayAffinity, SetWindowLongPtrW,
    SetWindowPos, ShowWindow, EVENT_OBJECT_REORDER, EVENT_SYSTEM_FOREGROUND, GWL_EXSTYLE, GW_HWNDPREV, HWND_TOPMOST, MSG, SWP_FRAMECHANGED,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_SHOWNOACTIVATE, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
    WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WS_EX_APPWINDOW, WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};

use crate::config::*;
use crate::look::Look;
use crate::store::DockSettings;
use crate::AppState;

/// What the page needs to position the pill and panel (logical px).
#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub mode: String,
    pub left: f64,
    pub trigger_height: f64,
    pub trigger_bottom: f64,
    pub flyout_bottom: f64,
}

/// Where the window itself goes (physical px) and the display scale.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Geometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

/// A clickable rectangle, in logical px relative to the window.
#[derive(Deserialize, Clone, Copy, Debug)]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Shared between commands (which update it) and the hit-test thread.
pub struct HitState {
    pub regions: Vec<Region>,
    pub origin: (i32, i32),
    pub scale: f64,
    /// True while the window is hidden for a screenshot.
    pub suspended: bool,
}

// The WinEvent callback below is a plain function (Windows calls it, it
// can't capture variables), so the values it needs live in statics.
static OUR_WINDOW: AtomicIsize = AtomicIsize::new(0);
static PAUSED: AtomicBool = AtomicBool::new(false);

struct Monitor {
    bounds: RECT,
    work: RECT,
    scale: f64,
}

/// The primary display: full bounds, the work area (screen minus taskbar)
/// and its scale factor (1.25 at 125%, …).
fn primary_monitor() -> Monitor {
    unsafe {
        let handle = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        let _ = GetMonitorInfoW(handle, &mut info);
        let (mut dpi_x, mut dpi_y) = (96u32, 96u32);
        let _ = GetDpiForMonitor(handle, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
        Monitor { bounds: info.rcMonitor, work: info.rcWork, scale: (dpi_x as f64 / 96.0).max(0.5) }
    }
}

/// Works the layout out from the screen geometry, so it adapts to any
/// resolution, scaling, taskbar size or taskbar position. If the work area
/// stops above the bottom of the screen, the gap IS the taskbar.
pub fn compute(dock: &DockSettings, look: &Look) -> (Geometry, Layout) {
    let m = primary_monitor();
    let s = m.scale;
    let logical = |px: i32| px as f64 / s;

    let screen_left = logical(m.bounds.left);
    let screen_width = logical(m.bounds.right - m.bounds.left);
    let screen_height = logical(m.bounds.bottom - m.bounds.top);
    let taskbar_height = logical((m.bounds.bottom - m.work.bottom).max(0));

    // Sit ON the taskbar only when it's at the bottom, tall enough and (in
    // auto mode) its icons are centered so the left end is free.
    let fits = taskbar_height >= 32.0;
    let on_taskbar = fits && (dock.mode == "taskbar" || (dock.mode == "auto" && look.taskbar_centered));
    let (trigger_height, trigger_bottom, flyout_bottom) = if on_taskbar {
        (taskbar_height - TASKBAR_ITEM_MARGIN * 2.0, TASKBAR_ITEM_MARGIN, taskbar_height + FLYOUT_GAP)
    } else {
        let bottom = taskbar_height + FLOATING_GAP;
        (FLOATING_TRIGGER_HEIGHT, bottom, bottom + FLOATING_TRIGGER_HEIGHT + FLOATING_GAP)
    };

    // Where the pill's left edge lands, kept far enough from the right edge
    // that the panel always fits; the window starts SHADOW_PAD further left.
    let max_anchor = (screen_left + screen_width - FLYOUT_WIDTH - FLYOUT_GAP).max(screen_left);
    let anchor = (logical(m.work.left) + dock.offset).clamp(screen_left, max_anchor);
    let x = (anchor - SHADOW_PAD).max(screen_left);
    let height = WINDOW_MAX_HEIGHT.min(screen_height);

    let width_px = (WINDOW_WIDTH * s).round() as u32;
    let height_px = (height * s).round() as u32;
    let geometry = Geometry {
        x: (x * s).round() as i32,
        y: m.bounds.bottom - height_px as i32, // bottom edge = screen bottom, exactly
        width: width_px,
        height: height_px,
        scale: s,
    };
    let layout = Layout {
        mode: if on_taskbar { "taskbar" } else { "above" }.to_string(),
        left: anchor - x,
        trigger_height,
        trigger_bottom,
        flyout_bottom,
    };
    (geometry, layout)
}

/// The native window handle (HWND). Stored as an integer because raw
/// pointers can't be sent between threads.
pub fn raw_hwnd(window: &WebviewWindow) -> isize {
    window.hwnd().map(|h| h.0 as isize).unwrap_or(0)
}

fn hwnd(raw: isize) -> HWND {
    HWND(raw as *mut _)
}

/// Sets the extended window style we want: a tool window (hidden from
/// Alt+Tab and the taskbar) that is click-through when `ignore` is true.
///
/// The window stays LAYERED all the time and only TRANSPARENT is switched:
/// adding or removing LAYERED makes Windows redraw the whole window, which
/// showed up as a blink every time the cursor touched the pill.
/// Returns early if nothing changes, so it's cheap to call often.
fn apply_style(raw: isize, ignore: bool) {
    unsafe {
        let h = hwnd(raw);
        let current = GetWindowLongPtrW(h, GWL_EXSTYLE);
        let mut wanted = (current | WS_EX_TOOLWINDOW.0 as isize | WS_EX_LAYERED.0 as isize) & !(WS_EX_APPWINDOW.0 as isize);
        if ignore {
            wanted |= WS_EX_TRANSPARENT.0 as isize;
        } else {
            wanted &= !(WS_EX_TRANSPARENT.0 as isize);
        }
        if wanted != current {
            SetWindowLongPtrW(h, GWL_EXSTYLE, wanted);
        }
    }
}

/// Asks Windows to recalculate the window frame. Tauri removes the frame
/// (title bar and borders) of an undecorated window at that moment; without
/// it, an invisible frame would eat ~8px on each side and 30px at the top.
fn refresh_frame(raw: isize) {
    unsafe {
        let _ = SetWindowPos(
            hwnd(raw),
            None,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
    }
}

/// Moves us to the top of the "topmost" group without stealing focus.
pub fn bring_to_top(raw: isize) {
    unsafe {
        let _ = SetWindowPos(hwnd(raw), HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
}

/// The taskbar is "always on top" too: when you click it, Windows lifts it
/// above us and the pill would vanish behind it. This checks whether the
/// taskbar is above our window and, only then, lifts us back. (We don't
/// blindly re-raise, so the Start menu, previews and other pop-ups keep
/// working normally.)
fn ensure_above_taskbar(raw: isize) {
    unsafe {
        let me = hwnd(raw);
        let Ok(taskbar) = FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null()) else { return };
        // Walk the windows ABOVE ours in the stacking order.
        let mut above = GetWindow(me, GW_HWNDPREV);
        let mut steps = 0;
        while let Ok(window) = above {
            if window.is_invalid() || steps > 256 {
                break;
            }
            if window == taskbar {
                bring_to_top(raw);
                return;
            }
            steps += 1;
            above = GetWindow(window, GW_HWNDPREV);
        }
    }
}

/// Called by Windows the moment any window comes to the front or the
/// stacking order changes, e.g. when you click the taskbar, so we can get
/// back on top before the screen even repaints (no visible blink).
unsafe extern "system" fn on_stacking_change(
    _hook: HWINEVENTHOOK,
    _event: u32,
    _window: HWND,
    _object: i32,
    _child: i32,
    _thread: u32,
    _time: u32,
) {
    let raw = OUR_WINDOW.load(Ordering::Relaxed);
    if raw != 0 && !PAUSED.load(Ordering::Relaxed) {
        ensure_above_taskbar(raw);
    }
}

/// A WinEvent hook needs a thread with a message loop to be called on.
/// FOREGROUND covers "you clicked something"; REORDER covers windows that
/// rise without taking focus. Events from our own process are skipped, so
/// lifting ourselves can't trigger another lift.
fn spawn_stacking_hook(raw: isize) {
    OUR_WINDOW.store(raw, Ordering::Relaxed);
    thread::spawn(|| unsafe {
        let hook = |event| {
            SetWinEventHook(event, event, HMODULE::default(), Some(on_stacking_change), 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS)
        };
        let _foreground = hook(EVENT_SYSTEM_FOREGROUND);
        let _reorder = hook(EVENT_OBJECT_REORDER);
        let mut message = MSG::default();
        while GetMessageW(&mut message, HWND::default(), 0, 0).as_bool() {}
    });
}

/// Shows the window without activating it (your current app keeps focus).
pub fn show(raw: isize) {
    unsafe {
        let _ = ShowWindow(hwnd(raw), SW_SHOWNOACTIVATE);
    }
    bring_to_top(raw);
}

/// Hides the window (used so screenshots don't contain Focus Pot).
pub fn hide(raw: isize) {
    unsafe {
        let _ = ShowWindow(hwnd(raw), SW_HIDE);
    }
}

/// While hidden for a screenshot, the stacking checks must not fight it.
pub fn set_paused(paused: bool) {
    PAUSED.store(paused, Ordering::Relaxed);
}

pub fn apply_geometry(window: &WebviewWindow, geometry: &Geometry) {
    let _ = window.set_size(PhysicalSize::new(geometry.width, geometry.height));
    let _ = window.set_position(PhysicalPosition::new(geometry.x, geometry.y));
}

/// First-time setup: styles, frame, size, position, then show without focus.
pub fn prepare(window: &WebviewWindow, geometry: &Geometry) {
    let raw = raw_hwnd(window);
    apply_style(raw, true);
    refresh_frame(raw);
    apply_geometry(window, geometry);
    show(raw);
    spawn_stacking_hook(raw);
}

/// The watcher thread, every 30ms:
///   • is the cursor over a solid region? → switch click-through
///   • was a mouse button pressed OUTSIDE them? → tell the page
///     ('outside-click'), so a tap elsewhere can close the panel
///   • is the taskbar above us? → get back on top (backup for the hooks)
pub fn spawn_hit_test(window: WebviewWindow, hit: Arc<Mutex<HitState>>) {
    let raw = raw_hwnd(&window);
    thread::spawn(move || {
        let mut was_pressed = false;
        loop {
            thread::sleep(Duration::from_millis(HIT_TEST_MS));
            let inside = {
                let state = hit.lock().unwrap();
                if state.suspended {
                    continue;
                }
                let mut point = POINT::default();
                if unsafe { GetCursorPos(&mut point) }.is_err() {
                    continue;
                }
                let x = (point.x - state.origin.0) as f64 / state.scale;
                let y = (point.y - state.origin.1) as f64 / state.scale;
                state.regions.iter().any(|r| x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
            };
            apply_style(raw, !inside);

            // GetAsyncKeyState's high bit = "is the button down right now".
            let pressed = unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0 || GetAsyncKeyState(VK_RBUTTON.0 as i32) < 0 };
            if pressed && !was_pressed && !inside {
                let _ = window.emit("outside-click", ());
            }
            was_pressed = pressed;

            ensure_above_taskbar(raw);
        }
    });
}

/// Re-reads the Windows look and the display geometry and, if anything
/// changed, moves the window and tells the page. Called by the watcher and
/// whenever the dock settings change.
pub fn relayout(app: &AppHandle) {
    let state = app.state::<AppState>();
    let look = crate::look::read();
    let (geometry, layout) = compute(&state.store.dock_settings(), &look);

    if let Some(window) = app.get_webview_window("main") {
        let geometry_changed = *state.geometry.lock().unwrap() != geometry;
        if geometry_changed {
            apply_geometry(&window, &geometry);
            let mut hit = state.hit.lock().unwrap();
            hit.origin = (geometry.x, geometry.y);
            hit.scale = geometry.scale;
            *state.geometry.lock().unwrap() = geometry;
        }
        let layout_changed = *state.layout.lock().unwrap() != layout;
        if layout_changed || geometry_changed {
            *state.layout.lock().unwrap() = layout.clone();
            let _ = window.emit("layout", &layout);
        }
        if *state.look.lock().unwrap() != look {
            *state.look.lock().unwrap() = look.clone();
            let _ = window.emit("look", &look);
        }
    }
}

/// Every 3s: notice theme, accent, taskbar or resolution changes.
pub fn spawn_watcher(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(WATCH_MS));
        relayout(&app);
    });
}

/// For the glass (macOS) theme: a small, blurred picture of whatever is
/// BEHIND our window, which the page tints and bends to look like glass.
///
/// A web page can only blur its own content, not the desktop behind it, so
/// we take the picture ourselves. SetWindowDisplayAffinity briefly hides our
/// own window from screen captures (it stays visible on screen), so the
/// picture shows only what's underneath.
pub fn snapshot_behind(app: &AppHandle) -> Option<String> {
    let geometry = *app.state::<AppState>().geometry.lock().unwrap();
    let raw = raw_hwnd(&app.get_webview_window("main")?);
    unsafe {
        let _ = SetWindowDisplayAffinity(hwnd(raw), WDA_EXCLUDEFROMCAPTURE);
    }
    thread::sleep(Duration::from_millis(40)); // let Windows apply it to the next frame
    let captured = (|| {
        let monitor = xcap::Monitor::all().ok()?.into_iter().find(|m| m.is_primary().unwrap_or(false))?;
        let (mx, my) = (monitor.x().ok()?, monitor.y().ok()?);
        let x = (geometry.x - mx).max(0) as u32;
        let y = (geometry.y - my).max(0) as u32;
        monitor.capture_region(x, y, geometry.width, geometry.height).ok()
    })();
    unsafe {
        let _ = SetWindowDisplayAffinity(hwnd(raw), WDA_NONE);
    }

    // Blurring here, on a picture a third of the size, is far cheaper than
    // a CSS blur on the full-size panel, and the page just stretches it.
    let image = captured?;
    let small = image::imageops::resize(
        &image,
        (image.width() / GLASS_SCALE).max(1),
        (image.height() / GLASS_SCALE).max(1),
        FilterType::Triangle,
    );
    let rgb = image::DynamicImage::ImageRgba8(small).to_rgb8();
    let sigma = GLASS_BLUR * geometry.scale as f32 / GLASS_SCALE as f32;
    let frosted = image::imageops::blur(&rgb, sigma);
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, 82).encode_image(&frosted).ok()?;
    Some(format!("data:image/jpeg;base64,{}", STANDARD.encode(&jpeg)))
}
