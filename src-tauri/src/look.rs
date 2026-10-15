//! look.rs — reads how Windows looks right now
//!
//! Focus Pot copies three things from your system settings (registry,
//! HKEY_CURRENT_USER):
//!
//!   • taskbar alignment (centered or left) → where the pill goes
//!   • taskbar light/dark ("Windows mode") → the pill's text colour
//!   • your accent palette: the exact 7 shades Windows itself uses

use serde::Serialize;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
use winreg::RegKey;

#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Look {
    pub taskbar_centered: bool,
    pub taskbar_dark: bool,
    pub accent: Accent,
}

#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct Accent {
    pub light3: String,
    pub light2: String,
    pub light1: String,
    pub base: String,
    pub dark1: String,
    pub dark2: String,
    pub dark3: String,
}

impl Default for Accent {
    /// Windows 11's default blue, used when the palette can't be read.
    fn default() -> Self {
        Accent {
            light3: "#99ebff".into(),
            light2: "#4cc2ff".into(),
            light1: "#0091f8".into(),
            base: "#0078d4".into(),
            dark1: "#0067c0".into(),
            dark2: "#003e92".into(),
            dark3: "#001a68".into(),
        }
    }
}

/// AccentPalette is 32 bytes = 8 colours of 4 bytes (R, G, B, unused),
/// from lightest to darkest; the first 7 are the accent shades.
fn parse_palette(bytes: &[u8]) -> Option<Accent> {
    if bytes.len() < 28 {
        return None;
    }
    let hex = |i: usize| format!("#{:02x}{:02x}{:02x}", bytes[i * 4], bytes[i * 4 + 1], bytes[i * 4 + 2]);
    Some(Accent {
        light3: hex(0),
        light2: hex(1),
        light1: hex(2),
        base: hex(3),
        dark1: hex(4),
        dark2: hex(5),
        dark3: hex(6),
    })
}

/// Windows 11 is build 22000 and later; Windows 10 always has the Start
/// button at the left of the taskbar.
fn windows_build() -> u32 {
    RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
        .and_then(|key| key.get_value::<String, _>("CurrentBuildNumber"))
        .ok()
        .and_then(|build| build.parse().ok())
        .unwrap_or(0)
}

pub fn read() -> Look {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let dword = |path: &str, name: &str| -> Option<u32> { hkcu.open_subkey(path).ok()?.get_value::<u32, _>(name).ok() };

    // A missing TaskbarAl value means the Windows 11 default: centered.
    let alignment = dword(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", "TaskbarAl").unwrap_or(1);
    let system_light = dword(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "SystemUsesLightTheme").unwrap_or(0);
    let accent = hkcu
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Explorer\Accent")
        .and_then(|key| key.get_raw_value("AccentPalette"))
        .ok()
        .and_then(|value| parse_palette(&value.bytes))
        .unwrap_or_default();

    Look {
        taskbar_centered: windows_build() >= 22000 && alignment != 0,
        taskbar_dark: system_light == 0,
        accent,
    }
}
