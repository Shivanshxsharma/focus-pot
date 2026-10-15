//! Focus Pot — the Rust backend (Tauri 2)
//!
//! A Tauri app has two halves:
//!
//!   • this Rust code: full access to Windows (window placement, media
//!     sessions, volume, files, the clipboard, global shortcuts);
//!   • the web page in ../src: draws the UI, and asks Rust for anything else
//!     through `invoke` (see src/js/api.js and commands.rs).
//!
//! Modules:
//!   config.rs       numbers and defaults
//!   store.rs        state.json
//!   clipboard.rs    clipboard history (in memory only, off by default)
//!   look.rs         taskbar alignment, light/dark, accent colour (registry)
//!   dock.rs         the transparent window: placement, click-through,
//!                   staying above the taskbar, the glass backdrop
//!   media.rs        media sessions, art, app icons, volume, media keys
//!   screenshots.rs  save / import / list / thumbnails / delete
//!   shortcuts.rs    global keyboard shortcuts
//!   commands.rs     everything the page may call

mod clipboard;
mod commands;
mod config;
mod dock;
mod look;
mod media;
mod screenshots;
mod shortcuts;
mod store;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use clipboard::ClipHistory;
use config::{APP_FOLDER, APP_NAME, OLD_APP_FOLDER};
use dock::{Geometry, HitState, Layout};
use look::Look;
use screenshots::Shots;
use store::Store;

/// Everything shared between commands, shortcuts and background threads.
pub struct AppState {
    pub store: Store,
    pub shots: Shots,
    pub clips: ClipHistory,
    pub look: Mutex<Look>,
    pub layout: Mutex<Layout>,
    pub geometry: Mutex<Geometry>,
    pub hit: Arc<Mutex<HitState>>,
}

/// A Windows toast. Failing to show one must never crash a timer.
pub fn notify(app: &AppHandle, title: &str, body: &str) {
    if let Err(err) = app.notification().builder().title(title).body(body).show() {
        eprintln!("[notify] failed: {err}");
    }
}

/// The app used to be called FocusNotch. On the first start after the
/// rename we copy its data over and move its screenshots folder, so nothing
/// is lost. Returns (old, new) screenshot folders if they were moved.
fn migrate(app_data: &Path, data_dir: &Path, pictures: &Path) -> Option<(PathBuf, PathBuf)> {
    let old_state = app_data.join(OLD_APP_FOLDER).join("state.json");
    let new_state = data_dir.join("state.json");
    if old_state.exists() && !new_state.exists() {
        let copied = fs::create_dir_all(data_dir).and_then(|_| fs::copy(&old_state, &new_state));
        if let Err(err) = copied {
            eprintln!("[migrate] could not copy the old state.json: {err}");
        }
    }
    let old_shots = pictures.join(OLD_APP_FOLDER);
    let new_shots = pictures.join(APP_FOLDER);
    if old_shots.is_dir() && !new_shots.exists() {
        // Fails if, say, a File Explorer window has the folder open; the
        // screenshots then simply stay where they are.
        match fs::rename(&old_shots, &new_shots) {
            Ok(()) => return Some((old_shots, new_shots)),
            Err(err) => eprintln!("[migrate] could not rename {}: {err}", old_shots.display()),
        }
    }
    None
}

/// Startup, in dependency order: folders → state → look → window → shared
/// state → background threads → shortcuts.
fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    // FOCUSPOT_DATA_DIR / FOCUSPOT_PICTURES_DIR let tests (or a portable copy)
    // use other folders without touching your real data.
    let test_data = std::env::var_os("FOCUSPOT_DATA_DIR").map(PathBuf::from);
    let test_pictures = std::env::var_os("FOCUSPOT_PICTURES_DIR").map(PathBuf::from);
    let app_data = app.path().data_dir()?; // %APPDATA%
    let data_dir = test_data.clone().unwrap_or_else(|| app_data.join(APP_FOLDER));
    let pictures = match test_pictures {
        Some(dir) => dir,
        None => app.path().picture_dir()?,
    };

    let moved_shots = if test_data.is_none() { migrate(&app_data, &data_dir, &pictures) } else { None };
    let store = Store::load(data_dir.join("state.json"));
    if let Some((old, new)) = moved_shots {
        store.rename_shot_paths(&old.to_string_lossy(), &new.to_string_lossy());
    }

    let look = look::read();
    let (geometry, layout) = dock::compute(&store.dock_settings(), &look);

    let window = app.get_webview_window("main").ok_or("the main window is missing")?;
    dock::prepare(&window, &geometry);

    let hit = Arc::new(Mutex::new(HitState {
        regions: Vec::new(),
        origin: (geometry.x, geometry.y),
        scale: geometry.scale,
        suspended: false,
    }));
    let clips = ClipHistory::new(store.clip_history());
    app.manage(AppState {
        store,
        shots: Shots::new(pictures),
        clips,
        look: Mutex::new(look),
        layout: Mutex::new(layout),
        geometry: Mutex::new(geometry),
        hit: hit.clone(),
    });

    dock::spawn_hit_test(window, hit);
    dock::spawn_watcher(handle.clone());
    clipboard::spawn_watcher(handle.clone());
    shortcuts::register(&handle);
    Ok(())
}

pub fn run() {
    let mut builder = tauri::Builder::default();
    // Must be first: a second launch just exits (the first keeps running).
    // A copy with its own data folder (FOCUSPOT_DATA_DIR: tests, a portable
    // copy) can't clash with your data, so it may run alongside.
    if std::env::var_os("FOCUSPOT_DATA_DIR").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}));
    }
    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(shortcuts::plugin())
        .setup(setup)
        .invoke_handler(tauri::generate_handler![
            commands::load_state,
            commands::save_state,
            commands::set_hit_regions,
            commands::notify,
            commands::quit,
            commands::glass_snapshot,
            commands::media_state,
            commands::media_control,
            commands::media_seek,
            commands::media_volume,
            commands::media_mute,
            commands::media_key,
            commands::open_url,
            commands::shots_capture,
            commands::shots_paste,
            commands::shots_import,
            commands::shots_open_folder,
            commands::shots_list,
            commands::shots_thumb,
            commands::shots_open,
            commands::shots_copy,
            commands::shots_delete,
            commands::shots_set_category,
            commands::clip_list,
            commands::clip_copy,
            commands::clip_save,
            commands::clip_remove,
            commands::clip_clear,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|err| eprintln!("{APP_NAME} stopped: {err}"));
}
