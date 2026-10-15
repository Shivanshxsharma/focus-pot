//! screenshots.rs — save, import and browse screenshots
//!
//! Files live in:   <Pictures>\FocusPot\<yyyy-mm-dd>\<hh-mm-ss>.png
//! Categories live in state.json → shotMeta  { "<full path>": "Code", … }
//!
//! Every path that comes FROM the page is checked with `is_inside`, so the
//! page can never make us read, open or delete a file outside that folder.
//! (Hiding the window and grabbing the screen is in commands.rs, because it
//! needs the window.)

use std::borrow::Cow;
use std::collections::HashMap;
use std::fs;
use std::io::{self, BufWriter};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, Local};
use image::{codecs::jpeg::JpegEncoder, codecs::png::PngEncoder, imageops::FilterType, ExtendedColorType, ImageEncoder, RgbaImage};
use serde::Serialize;
use serde_json::Value;

use crate::config::{APP_FOLDER, CATEGORIES, GALLERY_LIMIT, THUMB_CACHE_MAX, THUMB_WIDTH};
use crate::store::Store;

pub struct Shots {
    root: PathBuf,
    windows_folder: PathBuf,
    thumbs: Mutex<HashMap<String, String>>, // "path|mtime" → data URL
}

/// One gallery card.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotItem {
    pub path: String,
    pub name: String,
    pub folder: String,
    pub mtime_ms: f64,
    pub category: String,
}

fn is_image(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(),
        Some("png" | "jpg" | "jpeg")
    )
}

fn millis(time: SystemTime) -> f64 {
    time.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// Two shots in the same second must never overwrite each other: add -1, -2…
fn unique_path(dir: &Path, base: &str, ext: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{base}.{ext}"));
    let mut i = 1;
    while candidate.exists() {
        candidate = dir.join(format!("{base}-{i}.{ext}"));
        i += 1;
    }
    candidate
}

impl Shots {
    pub fn new(pictures: PathBuf) -> Shots {
        Shots { root: pictures.join(APP_FOLDER), windows_folder: pictures.join("Screenshots"), thumbs: Mutex::new(HashMap::new()) }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The page only ever gets to touch image files inside our own folder.
    pub fn is_inside(&self, file: &str) -> bool {
        let path = Path::new(file);
        path.is_absolute()
            && !path.components().any(|c| matches!(c, Component::ParentDir))
            && path.starts_with(&self.root)
            && path != self.root
            && is_image(path)
    }

    /// yyyy-mm-dd sorts correctly as text; hh-mm-ss because ":" isn't
    /// allowed in Windows file names.
    fn target(&self, when: DateTime<Local>, ext: &str) -> io::Result<PathBuf> {
        let dir = self.root.join(when.format("%Y-%m-%d").to_string());
        fs::create_dir_all(&dir)?;
        Ok(unique_path(&dir, &when.format("%H-%M-%S").to_string(), ext))
    }

    /// Saves RGBA pixels as today's next PNG. `create_new` = never overwrite.
    pub fn save_png(&self, image: &RgbaImage) -> io::Result<PathBuf> {
        let path = self.target(Local::now(), "png")?;
        let file = fs::OpenOptions::new().write(true).create_new(true).open(&path)?;
        PngEncoder::new(BufWriter::new(file))
            .write_image(image.as_raw(), image.width(), image.height(), ExtendedColorType::Rgba8)
            .map_err(io::Error::other)?;
        Ok(path)
    }

    /// Win+Shift+S snips only go to the clipboard; this turns them into files.
    pub fn paste_clipboard(&self) -> Result<String, String> {
        let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        let data = clipboard
            .get_image()
            .map_err(|_| "The clipboard has no image. Snip one with Win+Shift+S.".to_string())?;
        let image = RgbaImage::from_raw(data.width as u32, data.height as u32, data.bytes.into_owned())
            .ok_or("The clipboard image is damaged.")?;
        let path = self.save_png(&image).map_err(|e| format!("Could not save the clipboard: {e}"))?;
        Ok(format!("Saved {} from the clipboard", file_name(&path)))
    }

    /// Tidies Pictures\Screenshots into our dated folders, using each file's
    /// "modified" time as the moment it was taken. Rename is instant but
    /// fails across drives (OneDrive), so copy + delete is the fallback.
    pub fn import_windows(&self) -> (bool, String) {
        let Ok(entries) = fs::read_dir(&self.windows_folder) else {
            return (false, format!("No Windows Screenshots folder at {}", self.windows_folder.display()));
        };
        let (mut moved, mut failed) = (0, 0);
        for entry in entries.flatten() {
            let from = entry.path();
            if !from.is_file() || !is_image(&from) {
                continue;
            }
            let result = (|| -> io::Result<()> {
                let modified = fs::metadata(&from)?.modified()?;
                let ext = from.extension().and_then(|e| e.to_str()).unwrap_or("png").to_ascii_lowercase();
                let to = self.target(DateTime::<Local>::from(modified), &ext)?;
                if fs::rename(&from, &to).is_err() {
                    fs::copy(&from, &to)?;
                    fs::File::options().write(true).open(&to)?.set_modified(modified)?;
                    fs::remove_file(&from)?;
                }
                Ok(())
            })();
            match result {
                Ok(()) => moved += 1,
                Err(err) => {
                    failed += 1;
                    eprintln!("[shots] import failed for {}: {err}", from.display());
                }
            }
        }
        let noun = if moved == 1 { "screenshot" } else { "screenshots" };
        let message = if moved + failed == 0 {
            "Nothing to import: the Windows Screenshots folder is empty".to_string()
        } else if failed > 0 {
            format!("Imported {moved} {noun}, {failed} failed")
        } else {
            format!("Imported {moved} {noun}")
        };
        (failed == 0, message)
    }

    /// Every image in every dated folder; None if the folder can't be read
    /// (so "empty" and "unavailable" stay different).
    fn scan_all(&self) -> Option<Vec<(PathBuf, String, f64)>> {
        let days = fs::read_dir(&self.root).ok()?;
        let mut found = Vec::new();
        for day in days.flatten() {
            if !day.path().is_dir() {
                continue;
            }
            let folder = day.file_name().to_string_lossy().to_string();
            for file in fs::read_dir(day.path()).into_iter().flatten().flatten() {
                let path = file.path();
                if !is_image(&path) {
                    continue;
                }
                if let Ok(modified) = file.metadata().and_then(|m| m.modified()) {
                    found.push((path, folder.clone(), millis(modified)));
                }
            }
        }
        Some(found)
    }

    /// Filters BEFORE taking the newest 60, so "Study" shows your latest
    /// Study shots, not only the Study ones among the latest 60 overall.
    pub fn list(&self, category: &str, store: &Store) -> Vec<ShotItem> {
        let Some(all) = self.scan_all() else { return Vec::new() };
        let mut meta = store.shot_meta();

        // Forget categories of files deleted outside the app.
        let before = meta.len();
        meta.retain(|key, _| all.iter().any(|(p, _, _)| p.to_string_lossy() == key.as_str()));
        if meta.len() != before {
            store.set_shot_meta(meta.clone());
        }

        let mut items: Vec<ShotItem> = all
            .into_iter()
            .map(|(path, folder, mtime_ms)| {
                let key = path.to_string_lossy().to_string();
                let category = meta
                    .get(&key)
                    .and_then(Value::as_str)
                    .filter(|c| CATEGORIES.contains(c))
                    .unwrap_or("Uncategorized")
                    .to_string();
                ShotItem { name: file_name(&path), path: key, folder, mtime_ms, category }
            })
            .filter(|item| category == "All" || item.category == category)
            .collect();
        items.sort_by(|a, b| b.mtime_ms.total_cmp(&a.mtime_ms));
        items.truncate(GALLERY_LIMIT);
        items
    }

    /// Full screenshots are megabytes; a 200px JPEG is a few KB. Cached by
    /// path + modified time, so an edited file gets a fresh thumbnail.
    pub fn thumbnail(&self, file: &str) -> Option<String> {
        if !self.is_inside(file) {
            return None;
        }
        let modified = fs::metadata(file).and_then(|m| m.modified()).ok()?;
        let key = format!("{file}|{}", millis(modified));
        if let Some(url) = self.thumbs.lock().unwrap().get(&key) {
            return Some(url.clone());
        }
        let image = image::open(file).ok()?;
        let small = image.resize(THUMB_WIDTH, THUMB_WIDTH * 8, FilterType::Triangle).to_rgb8();
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, 80).encode_image(&small).ok()?;
        let url = format!("data:image/jpeg;base64,{}", STANDARD.encode(&jpeg));
        let mut thumbs = self.thumbs.lock().unwrap();
        if thumbs.len() >= THUMB_CACHE_MAX {
            thumbs.clear();
        }
        thumbs.insert(key, url.clone());
        Some(url)
    }

    /// Paste a saved shot straight into a chat or document.
    pub fn copy(&self, file: &str) -> Result<String, String> {
        if !self.is_inside(file) {
            return Err("Not a Focus Pot screenshot.".into());
        }
        let image = image::open(file).map_err(|_| "Could not read that image.".to_string())?.to_rgba8();
        let (width, height) = image.dimensions();
        arboard::Clipboard::new()
            .and_then(|mut c| {
                c.set_image(arboard::ImageData { width: width as usize, height: height as usize, bytes: Cow::Owned(image.into_raw()) })
            })
            .map_err(|e| e.to_string())?;
        Ok("Copied to the clipboard".into())
    }

    /// The Recycle Bin, not a hard delete: a misclick stays recoverable.
    pub fn remove(&self, file: &str, store: &Store) -> Result<String, String> {
        if !self.is_inside(file) {
            return Err("Not a Focus Pot screenshot.".into());
        }
        trash::delete(file).map_err(|e| format!("Delete failed: {e}"))?;
        let mut meta = store.shot_meta();
        if meta.remove(file).is_some() {
            store.set_shot_meta(meta);
        }
        self.thumbs.lock().unwrap().retain(|key, _| !key.starts_with(&format!("{file}|")));
        Ok("Moved to the Recycle Bin".into())
    }

    /// "Uncategorized" is the default, so it's stored as "no entry".
    pub fn set_category(&self, file: &str, category: &str, store: &Store) -> Result<(), String> {
        if !self.is_inside(file) || !CATEGORIES.contains(&category) {
            return Err("Invalid category.".into());
        }
        let mut meta = store.shot_meta();
        if category == "Uncategorized" {
            meta.remove(file);
        } else {
            meta.insert(file.to_string(), Value::String(category.to_string()));
        }
        store.set_shot_meta(meta);
        Ok(())
    }
}

pub fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

/// "2026-10-15\14-03-22.png", the short name shown in messages.
pub fn short_name(path: &Path) -> String {
    let folder = path.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    format!("{folder}\\{}", file_name(path))
}
