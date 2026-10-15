//! commands.rs — the complete list of things the page may ask the backend to do
//!
//! Every `#[tauri::command]` here is callable from the page with
//! `invoke('name', { args })` (see src/js/api.js) and is registered in
//! lib.rs → generate_handler!. If it isn't listed here, the page can't do it.
//!
//! Slow work (WinRT media calls, image decoding, disk scans) runs on a
//! background thread via `blocking`, so the window never freezes.

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::config::{self, CATEGORIES};
use crate::dock::{self, Region};
use crate::media::{self, MediaState};
use crate::screenshots::{short_name, ShotItem};
use crate::{notify as toast, AppState};

/// The common answer for actions: worked or not, plus a short message.
#[derive(Serialize, Clone)]
pub struct Outcome {
    pub ok: bool,
    pub message: String,
}

impl Outcome {
    fn from(result: Result<String, String>) -> Outcome {
        match result {
            Ok(message) => Outcome { ok: true, message },
            Err(message) => Outcome { ok: false, message },
        }
    }
}

/// Runs blocking work on Tauri's thread pool and waits for it without
/// blocking the window.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    tauri::async_runtime::spawn_blocking(work).await.expect("background task failed")
}

// ── Window & app ────────────────────────────────────────────────────────────

/// Everything the page needs at startup.
#[tauri::command]
pub fn load_state(app: AppHandle) -> Value {
    let state = app.state::<AppState>();
    let layout = state.layout.lock().unwrap().clone();
    let look = state.look.lock().unwrap().clone();
    json!({ "data": state.store.ui_data(), "categories": CATEGORIES, "layout": layout, "look": look })
}

/// The page saves the keys it owns; moving the dock moves the window.
#[tauri::command]
pub fn save_state(app: AppHandle, partial: Value) {
    if app.state::<AppState>().store.apply_from_ui(&partial) {
        dock::relayout(&app);
    }
}

/// Which rectangles of the page are clickable (the rest is click-through).
#[tauri::command]
pub fn set_hit_regions(app: AppHandle, regions: Vec<Region>) {
    app.state::<AppState>().hit.lock().unwrap().regions = regions;
}

#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String) {
    toast(&app, &title, &body);
}

#[tauri::command]
pub fn quit(app: AppHandle) {
    app.exit(0);
}

/// The glass theme's backdrop: a small, blurred-later picture of what's
/// behind the window (see dock::snapshot_behind). None if capture failed.
#[tauri::command]
pub async fn glass_snapshot(app: AppHandle) -> Option<String> {
    blocking(move || dock::snapshot_behind(&app)).await
}

// ── Media ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn media_state() -> MediaState {
    blocking(media::state).await
}

#[tauri::command]
pub async fn media_control(session_id: String, action: String) -> Outcome {
    blocking(move || Outcome::from(media::control(&session_id, &action).map(|_| String::new()))).await
}

#[tauri::command]
pub async fn media_seek(session_id: String, seconds: f64) -> Outcome {
    blocking(move || Outcome::from(media::seek(&session_id, seconds).map(|_| String::new()))).await
}

#[tauri::command]
pub async fn media_volume(value: f64) -> Outcome {
    blocking(move || Outcome::from(media::set_volume(value).map(|_| String::new()))).await
}

#[tauri::command]
pub async fn media_mute(muted: bool) -> Outcome {
    blocking(move || Outcome::from(media::set_mute(muted).map(|_| String::new()))).await
}

/// The page sends a key NAME; only known names map to a key code.
#[tauri::command]
pub fn media_key(name: String) -> Outcome {
    match config::media_key(&name) {
        Some(code) => {
            media::tap_key(code);
            Outcome { ok: true, message: String::new() }
        }
        None => Outcome { ok: false, message: "Unknown media key.".into() },
    }
}

// ── Links ───────────────────────────────────────────────────────────────────

/// Only plain web pages: a file:// or custom-protocol link could run things.
#[tauri::command]
pub fn open_url(url: String) -> Outcome {
    let url = url.trim().to_string();
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) || url.contains(char::is_whitespace) {
        return Outcome { ok: false, message: "Only http:// and https:// links can be opened.".into() };
    }
    Outcome::from(tauri_plugin_opener::open_url(&url, None::<&str>).map(|_| String::new()).map_err(|e| e.to_string()))
}

// ── Screenshots ─────────────────────────────────────────────────────────────

/// Hides Focus Pot, waits for Windows to repaint, grabs the primary screen
/// at full resolution, saves it, and shows the window again without
/// stealing focus. Shared with the Ctrl+Alt+S shortcut.
pub fn capture(app: &AppHandle) -> Outcome {
    let state = app.state::<AppState>();
    let window = app.get_webview_window("main");
    let raw = window.as_ref().map(dock::raw_hwnd).unwrap_or(0);

    state.hit.lock().unwrap().suspended = true;
    dock::set_paused(true);
    dock::hide(raw);
    std::thread::sleep(std::time::Duration::from_millis(250));

    let result = (|| -> Result<String, String> {
        let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
        let primary = monitors
            .into_iter()
            .find(|m| m.is_primary().unwrap_or(false))
            .ok_or("No primary display found")?;
        let image = primary.capture_image().map_err(|e| e.to_string())?;
        if image.width() == 0 || image.height() == 0 {
            return Err("Windows returned an empty image".into());
        }
        let path = state.shots.save_png(&image).map_err(|e| e.to_string())?;
        Ok(short_name(&path))
    })();

    dock::show(raw);
    dock::set_paused(false);
    state.hit.lock().unwrap().suspended = false;

    match result {
        Ok(name) => {
            toast(app, "Screenshot saved", &name);
            Outcome { ok: true, message: format!("Saved {name}") }
        }
        Err(err) => Outcome { ok: false, message: format!("Capture failed: {err}") },
    }
}

#[tauri::command]
pub async fn shots_capture(app: AppHandle) -> Outcome {
    blocking(move || capture(&app)).await
}

#[tauri::command]
pub async fn shots_paste(app: AppHandle) -> Outcome {
    blocking(move || Outcome::from(app.state::<AppState>().shots.paste_clipboard())).await
}

#[tauri::command]
pub async fn shots_import(app: AppHandle) -> Outcome {
    blocking(move || {
        let (ok, message) = app.state::<AppState>().shots.import_windows();
        Outcome { ok, message }
    })
    .await
}

/// mkdir first: on the first run the folder doesn't exist yet.
#[tauri::command]
pub fn shots_open_folder(app: AppHandle) -> Outcome {
    let root = app.state::<AppState>().shots.root().to_path_buf();
    let _ = std::fs::create_dir_all(&root);
    Outcome::from(
        tauri_plugin_opener::open_path(&root, None::<&str>)
            .map(|_| "Opened in File Explorer".to_string())
            .map_err(|e| e.to_string()),
    )
}

#[tauri::command]
pub async fn shots_list(app: AppHandle, category: String) -> Vec<ShotItem> {
    blocking(move || {
        let state = app.state::<AppState>();
        state.shots.list(&category, &state.store)
    })
    .await
}

#[tauri::command]
pub async fn shots_thumb(app: AppHandle, file: String) -> Option<String> {
    blocking(move || app.state::<AppState>().shots.thumbnail(&file)).await
}

#[tauri::command]
pub fn shots_open(app: AppHandle, file: String) -> Outcome {
    if !app.state::<AppState>().shots.is_inside(&file) {
        return Outcome { ok: false, message: "Not a Focus Pot screenshot.".into() };
    }
    Outcome::from(tauri_plugin_opener::open_path(&file, None::<&str>).map(|_| String::new()).map_err(|e| e.to_string()))
}

#[tauri::command]
pub async fn shots_copy(app: AppHandle, file: String) -> Outcome {
    blocking(move || Outcome::from(app.state::<AppState>().shots.copy(&file))).await
}

#[tauri::command]
pub async fn shots_delete(app: AppHandle, file: String) -> Outcome {
    blocking(move || {
        let state = app.state::<AppState>();
        Outcome::from(state.shots.remove(&file, &state.store))
    })
    .await
}

#[tauri::command]
pub fn shots_set_category(app: AppHandle, file: String, category: String) -> Outcome {
    let state = app.state::<AppState>();
    Outcome::from(state.shots.set_category(&file, &category, &state.store).map(|_| String::new()))
}
