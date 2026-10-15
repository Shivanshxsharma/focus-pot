//! clipboard.rs — clipboard history, for the Shots tab's Clipboard view
//!
//! While "Remember what I copy" is on, a background thread notices every
//! change to the Windows clipboard and keeps the last few things you copied
//! (text and images), newest first, so they're one click away again.
//!
//! Privacy comes first:
//!   • it's off until you turn it on, and turning it off forgets everything;
//!   • the history lives in memory only: nothing is written to disk, and
//!     quitting Focus Pot forgets it too;
//!   • password managers mark what they copy so clipboard tools leave it
//!     alone ("ExcludeClipboardContentFromMonitorProcessing",
//!     "CanIncludeInClipboardHistory", "Clipboard Viewer Ignore"). Such
//!     copies are never recorded, the same rule Windows' own history follows.
//!
//! Noticing changes: Windows bumps a counter (GetClipboardSequenceNumber) on
//! every change, so checking it a few times a second costs next to nothing.

use std::collections::hash_map::DefaultHasher;
use std::collections::VecDeque;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder};
use image::{DynamicImage, ExtendedColorType, ImageEncoder, RgbaImage};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use windows::core::{w, PCWSTR};
use windows::Win32::System::DataExchange::{GetClipboardSequenceNumber, IsClipboardFormatAvailable, RegisterClipboardFormatW};

use crate::config::{CLIP_IMAGES_MAX, CLIP_ITEMS_MAX, CLIP_POLL_MS, CLIP_PREVIEW_CHARS, CLIP_TEXT_MAX, THUMB_WIDTH};
use crate::AppState;

/// One thing you copied. Images are kept as PNG (a fraction of the raw
/// pixels' size) plus a small thumbnail for the page.
enum Content {
    Text(String),
    Image { width: u32, height: u32, png: Vec<u8>, thumb: String, hash: u64 },
}

impl Content {
    /// Copying the same thing again should move it to the top, not add a twin.
    fn same_as(&self, other: &Content) -> bool {
        match (self, other) {
            (Content::Text(a), Content::Text(b)) => a == b,
            (Content::Image { hash: a, .. }, Content::Image { hash: b, .. }) => a == b,
            _ => false,
        }
    }

    fn is_image(&self) -> bool {
        matches!(self, Content::Image { .. })
    }
}

struct Clip {
    id: u64,
    at_ms: f64,
    content: Content,
}

/// What the page gets: a preview, never the full text or image.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipEntry {
    pub id: u64,
    pub kind: &'static str,
    pub at_ms: f64,
    pub text: Option<String>,
    pub chars: Option<usize>,
    pub thumb: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Serialize)]
pub struct ClipList {
    pub enabled: bool,
    pub items: Vec<ClipEntry>,
}

pub struct ClipHistory {
    enabled: AtomicBool,
    next_id: AtomicU64,
    items: Mutex<VecDeque<Clip>>,
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

impl ClipHistory {
    pub fn new(enabled: bool) -> ClipHistory {
        ClipHistory { enabled: AtomicBool::new(enabled), next_id: AtomicU64::new(1), items: Mutex::new(VecDeque::new()) }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    /// Turning the history off forgets everything right away.
    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
        if !enabled {
            self.items.lock().unwrap().clear();
        }
    }

    /// Adds a copy at the top. Returns whether the list changed.
    fn push(&self, content: Content) -> bool {
        let mut items = self.items.lock().unwrap();
        if let Some(pos) = items.iter().position(|clip| clip.content.same_as(&content)) {
            if pos == 0 {
                return false; // the newest item, copied again
            }
            let mut clip = items.remove(pos).expect("position came from the same list");
            clip.at_ms = now_ms();
            items.push_front(clip);
            return true;
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        items.push_front(Clip { id, at_ms: now_ms(), content });

        // Keep the newest CLIP_ITEMS_MAX items, and of those only the newest
        // CLIP_IMAGES_MAX images (they're the big ones).
        let mut images = 0;
        let mut kept = 0;
        items.retain(|clip| {
            if kept >= CLIP_ITEMS_MAX {
                return false;
            }
            if clip.content.is_image() {
                images += 1;
                if images > CLIP_IMAGES_MAX {
                    return false;
                }
            }
            kept += 1;
            true
        });
        true
    }

    pub fn list(&self) -> ClipList {
        let items = self
            .items
            .lock()
            .unwrap()
            .iter()
            .map(|clip| match &clip.content {
                Content::Text(text) => ClipEntry {
                    id: clip.id,
                    kind: "text",
                    at_ms: clip.at_ms,
                    text: Some(text.chars().take(CLIP_PREVIEW_CHARS).collect()),
                    chars: Some(text.chars().count()),
                    thumb: None,
                    width: None,
                    height: None,
                },
                Content::Image { width, height, thumb, .. } => ClipEntry {
                    id: clip.id,
                    kind: "image",
                    at_ms: clip.at_ms,
                    text: None,
                    chars: None,
                    thumb: Some(thumb.clone()),
                    width: Some(*width),
                    height: Some(*height),
                },
            })
            .collect();
        ClipList { enabled: self.is_enabled(), items }
    }

    pub fn remove(&self, id: u64) {
        self.items.lock().unwrap().retain(|clip| clip.id != id);
    }

    pub fn clear(&self) {
        self.items.lock().unwrap().clear();
    }

    /// Puts an item back on the clipboard. (The watcher then sees that copy
    /// and moves the item to the top, like any other copy.)
    pub fn copy(&self, id: u64) -> Result<String, String> {
        // Take what we need and let go of the list before touching the
        // clipboard, so the watcher is never kept waiting.
        let wanted = {
            let items = self.items.lock().unwrap();
            let clip = items.iter().find(|clip| clip.id == id).ok_or("That item is no longer in the history.")?;
            match &clip.content {
                Content::Text(text) => Ok(text.clone()),
                Content::Image { png, .. } => Err(png.clone()),
            }
        };
        let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        match wanted {
            Ok(text) => clipboard.set_text(text).map_err(|e| e.to_string())?,
            Err(png) => {
                let image = image::load_from_memory(&png).map_err(|e| e.to_string())?.to_rgba8();
                let (width, height) = image.dimensions();
                clipboard
                    .set_image(arboard::ImageData { width: width as usize, height: height as usize, bytes: image.into_raw().into() })
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok("Copied again".into())
    }

    /// An image from the history as pixels (to save it into Shots).
    pub fn image(&self, id: u64) -> Result<RgbaImage, String> {
        let png = {
            let items = self.items.lock().unwrap();
            match items.iter().find(|clip| clip.id == id).map(|clip| &clip.content) {
                Some(Content::Image { png, .. }) => png.clone(),
                Some(Content::Text(_)) => return Err("That item is text, not an image.".into()),
                None => return Err("That item is no longer in the history.".into()),
            }
        };
        Ok(image::load_from_memory(&png).map_err(|e| e.to_string())?.to_rgba8())
    }
}

/// True when the app that copied asked clipboard tools to look away
/// (password managers do this for passwords).
fn is_private() -> bool {
    let flags: [PCWSTR; 3] = [
        w!("ExcludeClipboardContentFromMonitorProcessing"),
        w!("CanIncludeInClipboardHistory"),
        w!("Clipboard Viewer Ignore"),
    ];
    flags.iter().any(|name| unsafe {
        let format = RegisterClipboardFormatW(*name);
        format != 0 && IsClipboardFormatAvailable(format).is_ok()
    })
}

/// Reads the clipboard: text if there is some, otherwise an image.
/// Returns None for anything else (files, empty clipboard, huge text).
fn read() -> Option<Content> {
    let mut clipboard = arboard::Clipboard::new().ok()?;
    if let Ok(text) = clipboard.get_text() {
        if !text.trim().is_empty() {
            // A whole book on the clipboard isn't a "clip"; leave it be.
            return (text.chars().count() <= CLIP_TEXT_MAX).then_some(Content::Text(text));
        }
    }
    let data = clipboard.get_image().ok()?;
    let (width, height) = (data.width as u32, data.height as u32);
    let pixels = RgbaImage::from_raw(width, height, data.bytes.into_owned())?;

    let mut hasher = DefaultHasher::new();
    (width, height).hash(&mut hasher);
    pixels.as_raw().hash(&mut hasher);
    let hash = hasher.finish();

    let mut png = Vec::new();
    PngEncoder::new_with_quality(&mut png, CompressionType::Fast, PngFilter::Adaptive)
        .write_image(pixels.as_raw(), width, height, ExtendedColorType::Rgba8)
        .ok()?;

    let small = DynamicImage::ImageRgba8(pixels).thumbnail(THUMB_WIDTH, THUMB_WIDTH * 2).to_rgb8();
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, 80).encode_image(&small).ok()?;
    let thumb = format!("data:image/jpeg;base64,{}", STANDARD.encode(&jpeg));
    Some(Content::Image { width, height, png, thumb, hash })
}

/// The watcher thread: notices clipboard changes (and the moment the
/// history is switched on), records them, and tells the page.
pub fn spawn_watcher(app: AppHandle) {
    thread::spawn(move || {
        let mut seen = unsafe { GetClipboardSequenceNumber() };
        let mut was_enabled = app.state::<AppState>().clips.is_enabled();
        loop {
            thread::sleep(Duration::from_millis(CLIP_POLL_MS));
            let state = app.state::<AppState>();
            let enabled = state.clips.is_enabled();
            let sequence = unsafe { GetClipboardSequenceNumber() };
            // Switching the history on records what's on the clipboard now.
            let changed = sequence != seen || (enabled && !was_enabled);
            seen = sequence;
            was_enabled = enabled;
            if !changed || !enabled || is_private() {
                continue;
            }
            // The app that copied may still be adding formats; give it a moment.
            thread::sleep(Duration::from_millis(60));
            if let Some(content) = read() {
                if state.clips.push(content) {
                    let _ = app.emit("clipboard-changed", ());
                }
            }
        }
    });
}
