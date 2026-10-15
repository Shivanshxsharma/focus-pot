//! shortcuts.rs — global keyboard shortcuts (they work while any app is focused)
//!
//!   Ctrl+Alt+S  capture the screen        Ctrl+Alt+P  start / pause the timer
//!   Ctrl+Alt+V  save the clipboard image  Ctrl+Alt+Q  quit
//!   Ctrl+Alt+F  open / close the panel
//!
//! S and V run here; F and P act on UI state, so they are sent to the page.

use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::commands::{self, Outcome};
use crate::config::APP_NAME;
use crate::{notify, AppState};

const KEYS: [Code; 5] = [Code::KeyS, Code::KeyV, Code::KeyF, Code::KeyP, Code::KeyQ];

fn modifiers() -> Modifiers {
    Modifiers::CONTROL | Modifiers::ALT
}

/// The plugin with our handler. Screenshots run on a separate thread so the
/// shortcut never blocks the app.
pub fn plugin() -> TauriPlugin<Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let app = app.clone();
            if shortcut.matches(modifiers(), Code::KeyS) {
                std::thread::spawn(move || {
                    let outcome = commands::capture(&app);
                    let _ = app.emit("shots-changed", outcome);
                });
            } else if shortcut.matches(modifiers(), Code::KeyV) {
                std::thread::spawn(move || {
                    let outcome = match app.state::<AppState>().shots.paste_clipboard() {
                        Ok(message) => Outcome { ok: true, message },
                        Err(message) => Outcome { ok: false, message },
                    };
                    notify(&app, APP_NAME, &outcome.message); // the panel is probably closed
                    let _ = app.emit("shots-changed", outcome);
                });
            } else if shortcut.matches(modifiers(), Code::KeyF) {
                let _ = app.emit("toggle-pin", ());
            } else if shortcut.matches(modifiers(), Code::KeyP) {
                let _ = app.emit("toggle-timer", ());
            } else if shortcut.matches(modifiers(), Code::KeyQ) {
                app.exit(0);
            }
        })
        .build()
}

/// A combination owned by another app makes register() fail; we log it and
/// carry on instead of crashing.
pub fn register(app: &AppHandle) {
    for code in KEYS {
        let shortcut = Shortcut::new(Some(modifiers()), code);
        if let Err(err) = app.global_shortcut().register(shortcut) {
            eprintln!("[shortcut] Ctrl+Alt+{code:?} could not be registered: {err}");
        }
    }
}
