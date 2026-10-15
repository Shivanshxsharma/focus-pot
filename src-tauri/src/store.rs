//! store.rs — loading and saving state.json
//!
//! One JSON file in %APPDATA%\FocusPot\state.json holds everything that
//! survives a restart:
//!
//!   tasks, links, settings, stats   ← owned by the UI
//!   shotMeta                        ← owned by the backend (screenshot categories)
//!
//! The UI can only replace its own keys (see `apply_from_ui`), so a bug in
//! the page can never wipe your screenshot categories.
//!
//! The state is kept as a `serde_json::Value` because tasks and links are
//! shaped by the UI; settings are rebuilt field by field with defaults.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{json, Map, Value};

use crate::config::{default_links, DOCK_MODES, PILL_FACES, THEMES};

pub struct Store {
    path: PathBuf,
    state: Mutex<Value>,
}

/// The two settings the backend itself needs (where to put the window).
pub struct DockSettings {
    pub mode: String,
    pub offset: f64,
}

/// A whole number from JSON, clamped, or the fallback if missing/invalid.
fn int(value: Option<&Value>, min: i64, max: i64, fallback: i64) -> i64 {
    value
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .map(|n| (n.round() as i64).clamp(min, max))
        .unwrap_or(fallback)
}

/// A string that must be one of `allowed`.
fn pick(value: Option<&Value>, allowed: &[&str], fallback: &str) -> String {
    value
        .and_then(Value::as_str)
        .filter(|s| allowed.contains(s))
        .unwrap_or(fallback)
        .to_string()
}

/// Rebuilds settings with known fields only. Missing or broken values fall
/// back to defaults, so a hand-edited file can't break the app.
fn sanitize_settings(raw: Option<&Value>) -> Value {
    let empty = Map::new();
    let s = raw.and_then(Value::as_object).unwrap_or(&empty);
    json!({
        "focusMin": int(s.get("focusMin"), 1, 180, 25),
        "breakMin": int(s.get("breakMin"), 1, 60, 5),
        "remindMin": int(s.get("remindMin"), 0, 240, 15),
        "dock": pick(s.get("dock"), &DOCK_MODES, "auto"),
        "dockOffset": int(s.get("dockOffset"), 0, 4000, 12),
        "theme": pick(s.get("theme"), &THEMES, "windows"),
        "miniPlayer": s.get("miniPlayer").and_then(Value::as_bool).unwrap_or(true),
        "pillFace": pick(s.get("pillFace"), &PILL_FACES, "timer"),
        "glassTint": int(s.get("glassTint"), 0, 100, 40), // macOS theme: 0 clear … 100 tinted
        "clipHistory": s.get("clipHistory").and_then(Value::as_bool).unwrap_or(false), // off until you turn it on
    })
}

fn sanitize_stats(raw: Option<&Value>) -> Value {
    let date = raw.and_then(|s| s.get("date")).and_then(Value::as_str).unwrap_or("");
    json!({ "date": date, "pomos": int(raw.and_then(|s| s.get("pomos")), 0, 1_000_000, 0) })
}

impl Store {
    /// Reads state.json. A missing file means "first run"; a corrupt one is
    /// kept as state.broken-<time>.json so data can be rescued by hand.
    pub fn load(path: PathBuf) -> Store {
        let raw = match fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(value) => value,
                Err(err) => {
                    eprintln!("[state] state.json is unreadable, starting with defaults: {err}");
                    let backup = path.with_file_name(format!("state.broken-{}.json", chrono::Local::now().timestamp()));
                    let _ = fs::copy(&path, backup);
                    Value::Null
                }
            },
            Err(_) => Value::Null,
        };

        let state = json!({
            "tasks": raw.get("tasks").filter(|v| v.is_array()).cloned().unwrap_or(json!([])),
            "links": raw.get("links").filter(|v| v.is_array()).cloned().unwrap_or_else(default_links),
            "settings": sanitize_settings(raw.get("settings")),
            "stats": sanitize_stats(raw.get("stats")),
            "shotMeta": raw.get("shotMeta").filter(|v| v.is_object()).cloned().unwrap_or(json!({})),
        });
        Store { path, state: Mutex::new(state) }
    }

    /// Writes to a .tmp file and renames it: if the PC dies mid-write you keep
    /// the previous complete file instead of a half-written one.
    fn write(&self, state: &Value) {
        let tmp = self.path.with_extension("json.tmp");
        let result = fs::create_dir_all(self.path.parent().unwrap_or(&self.path))
            .and_then(|_| fs::write(&tmp, serde_json::to_vec_pretty(state).unwrap_or_default()))
            .and_then(|_| fs::rename(&tmp, &self.path));
        if let Err(err) = result {
            eprintln!("[state] could not save state.json: {err}");
        }
    }

    pub fn save(&self) {
        let state = self.state.lock().unwrap().clone();
        self.write(&state);
    }

    /// What the UI loads at startup (everything except shotMeta).
    pub fn ui_data(&self) -> Value {
        let s = self.state.lock().unwrap();
        json!({ "tasks": s["tasks"], "links": s["links"], "settings": s["settings"], "stats": s["stats"] })
    }

    /// Copies the keys the UI owns, validates them, saves, and reports
    /// whether the dock position changed (so the window can move).
    pub fn apply_from_ui(&self, partial: &Value) -> bool {
        let Some(partial) = partial.as_object() else { return false };
        let snapshot = {
            let mut s = self.state.lock().unwrap();
            let dock_before = (s["settings"]["dock"].clone(), s["settings"]["dockOffset"].clone());

            if let Some(tasks) = partial.get("tasks").and_then(Value::as_array) {
                s["tasks"] = Value::Array(tasks.iter().take(1000).cloned().collect());
            }
            if let Some(links) = partial.get("links").and_then(Value::as_array) {
                s["links"] = Value::Array(links.iter().take(200).cloned().collect());
            }
            if let Some(settings) = partial.get("settings").filter(|v| v.is_object()) {
                let mut merged = s["settings"].clone();
                for (key, value) in settings.as_object().unwrap() {
                    merged[key] = value.clone();
                }
                s["settings"] = sanitize_settings(Some(&merged));
            }
            if partial.get("stats").is_some() {
                s["stats"] = sanitize_stats(partial.get("stats"));
            }
            let dock_after = (s["settings"]["dock"].clone(), s["settings"]["dockOffset"].clone());
            (s.clone(), dock_before != dock_after)
        };
        self.write(&snapshot.0);
        snapshot.1
    }

    pub fn dock_settings(&self) -> DockSettings {
        let s = self.state.lock().unwrap();
        DockSettings {
            mode: s["settings"]["dock"].as_str().unwrap_or("auto").to_string(),
            offset: s["settings"]["dockOffset"].as_f64().unwrap_or(12.0),
        }
    }

    /// Whether the clipboard history is on (Shots tab → Clipboard).
    pub fn clip_history(&self) -> bool {
        self.state.lock().unwrap()["settings"]["clipHistory"].as_bool().unwrap_or(false)
    }

    /// Screenshot categories: { "<full path>": "Code", … }
    pub fn shot_meta(&self) -> Map<String, Value> {
        self.state.lock().unwrap()["shotMeta"].as_object().cloned().unwrap_or_default()
    }

    pub fn set_shot_meta(&self, meta: Map<String, Value>) {
        let snapshot = {
            let mut s = self.state.lock().unwrap();
            s["shotMeta"] = Value::Object(meta);
            s.clone()
        };
        self.write(&snapshot);
    }

    /// After the screenshots folder was renamed, the categories still point
    /// at the old paths; this rewrites the start of every saved path.
    pub fn rename_shot_paths(&self, old_prefix: &str, new_prefix: &str) {
        let renamed: Map<String, Value> = self
            .shot_meta()
            .into_iter()
            .map(|(path, category)| match path.strip_prefix(old_prefix) {
                Some(rest) => (format!("{new_prefix}{rest}"), category),
                None => (path, category),
            })
            .collect();
        self.set_shot_meta(renamed);
    }
}
