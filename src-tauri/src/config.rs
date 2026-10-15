//! config.rs — every fixed number and default value in one place.
//!
//! Sizes are in "logical" pixels (CSS pixels at 100% scaling); dock.rs
//! multiplies them by the display's scale factor.

use serde_json::{json, Value};

/// A little wider than Windows' 360px Quick Settings, so the timer controls fit.
pub const FLYOUT_WIDTH: f64 = 420.0;
/// Transparent margin around the flyout so its drop shadow isn't cut off.
pub const SHADOW_PAD: f64 = 24.0;
/// Wide enough for the flyout + shadow and for the taskbar pill.
pub const WINDOW_WIDTH: f64 = 540.0;
pub const WINDOW_MAX_HEIGHT: f64 = 680.0;

/// Taskbar buttons leave 4px above and below themselves; ours does too.
pub const TASKBAR_ITEM_MARGIN: f64 = 4.0;
/// Windows leaves 12px between the taskbar and its flyouts.
pub const FLYOUT_GAP: f64 = 12.0;
/// When the pill can't sit on the taskbar it floats above it.
pub const FLOATING_TRIGGER_HEIGHT: f64 = 40.0;
pub const FLOATING_GAP: f64 = 8.0;

/// How often the cursor is checked against the clickable regions, and the
/// taskbar against our window's stacking order (ms).
pub const HIT_TEST_MS: u64 = 30;
/// How often we re-read the Windows look and the display geometry (ms).
pub const WATCH_MS: u64 = 3000;

/// The app's own folders: %APPDATA%\FocusPot and Pictures\FocusPot.
pub const APP_FOLDER: &str = "FocusPot";
/// The previous name; its data is moved over once (see lib.rs → migrate).
pub const OLD_APP_FOLDER: &str = "FocusNotch";
pub const APP_NAME: &str = "Focus Pot";

/// The glass theme's backdrop is captured at 1/GLASS_SCALE of the real size:
/// it gets blurred anyway, and smaller is faster.
pub const GLASS_SCALE: u32 = 3;
/// How frosted the glass is: the blur radius in screen (CSS) pixels. Apple
/// tuned Liquid Glass in 2026 to diffuse busy content more, hence 18.
pub const GLASS_BLUR: f32 = 18.0;

pub const GALLERY_LIMIT: usize = 60;

/// Clipboard history (in memory only): how often to look for a new copy,
/// how much to keep, and the longest text worth keeping.
pub const CLIP_POLL_MS: u64 = 400;
pub const CLIP_ITEMS_MAX: usize = 30;
pub const CLIP_IMAGES_MAX: usize = 10;
pub const CLIP_TEXT_MAX: usize = 100_000;
pub const CLIP_PREVIEW_CHARS: usize = 400;
pub const THUMB_WIDTH: u32 = 200;
pub const THUMB_CACHE_MAX: usize = 300;
pub const CATEGORIES: [&str; 6] = ["Study", "Code", "Work", "Fun", "Other", "Uncategorized"];

pub const DOCK_MODES: [&str; 3] = ["auto", "taskbar", "above"];
pub const THEMES: [&str; 3] = ["windows", "material", "mac"];
pub const PILL_FACES: [&str; 2] = ["timer", "media"];

/// Windows virtual-key codes for media keys (players without a media session).
pub fn media_key(name: &str) -> Option<u16> {
    match name {
        "playpause" => Some(0xB3),
        "next" => Some(0xB0),
        "prev" => Some(0xB1),
        _ => None,
    }
}

/// The links a brand-new install starts with.
pub fn default_links() -> Value {
    json!([
        { "id": "gmail", "name": "Gmail", "url": "https://mail.google.com/" },
        { "id": "github", "name": "GitHub", "url": "https://github.com/" },
        { "id": "leetcode", "name": "LeetCode", "url": "https://leetcode.com/" },
        { "id": "youtube", "name": "YouTube", "url": "https://www.youtube.com/" },
        { "id": "claude", "name": "Claude", "url": "https://claude.ai/" }
    ])
}
