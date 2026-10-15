//! media.rs — media sessions, album art, app icons, system volume, media keys
//!
//! Windows keeps a list of every app that plays media (Spotify, each browser
//! tab, Media Player…) in `GlobalSystemMediaTransportControlsSessionManager`,
//! the same API behind the Quick Settings media card. We call it directly
//! through the `windows` crate (WinRT), so there is no helper process.
//!
//! Album art is cropped square and shrunk once per track; its average colour
//! tints the Material media card. App icons and names come from the app's
//! .exe and are looked up once per app.
//!
//! WinRT calls block while Windows answers, so commands.rs runs everything
//! here on a background thread, never on the UI thread.

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::{Mutex, OnceLock};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{codecs::jpeg::JpegEncoder, codecs::png::PngEncoder, imageops::FilterType, ExtendedColorType, ImageEncoder};
use serde::Serialize;
use windows::core::{w, Result as WinResult, HSTRING, PWSTR};
use windows::Foundation::TimeSpan;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session, GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionMediaProperties as Properties,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Storage::Streams::{DataReader, IRandomAccessStreamReference};
use windows::Win32::Foundation::{CloseHandle, HWND};
use windows::Win32::Graphics::Gdi::{
    DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eMultimedia, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, FILE_FLAGS_AND_ATTRIBUTES,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP,
    VIRTUAL_KEY,
};
use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

/// One media session as the UI sees it.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub app_name: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub status: String,
    pub can_toggle: bool,
    pub can_prev: bool,
    pub can_next: bool,
    pub can_seek: bool,
    pub position: f64,
    pub duration: f64,
    pub updated_at: f64,
    pub is_current: bool,
    pub art: Option<String>,
    pub art_color: Option<String>,
    pub icon: Option<String>,
}

/// Everything the Media tab and the pill draw, in one answer.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaState {
    pub ok: bool,
    pub message: Option<String>,
    pub sessions: Vec<SessionInfo>,
    pub volume: Option<u32>,
    pub muted: bool,
}

#[derive(Clone)]
struct Art {
    url: String,
    color: String,
}

#[derive(Clone)]
struct AppInfo {
    name: String,
    icon: Option<String>,
}

fn art_cache() -> &'static Mutex<HashMap<String, Art>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Art>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn app_cache() -> &'static Mutex<HashMap<String, AppInfo>> {
    static CACHE: OnceLock<Mutex<HashMap<String, AppInfo>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// WinRT/COM must be initialised on every thread that uses it. Calling it
/// again on the same thread is harmless.
fn init_com() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

fn manager() -> WinResult<Manager> {
    Manager::RequestAsync()?.get()
}

/// Windows durations are counted in 100-nanosecond "ticks".
fn seconds(span: TimeSpan) -> f64 {
    span.Duration as f64 / 10_000_000.0
}

fn text(value: WinResult<HSTRING>) -> String {
    value.map(|h| h.to_string()).unwrap_or_default()
}

// ── Sessions ────────────────────────────────────────────────────────────────

pub fn state() -> MediaState {
    init_com();
    let (sessions, message) = match collect_sessions() {
        Ok(list) => (list, None),
        Err(err) => (Vec::new(), Some(err.message().to_string())),
    };
    let (volume, muted) = match get_volume() {
        Ok((level, muted)) => (Some(level), muted),
        Err(_) => (None, false),
    };
    MediaState { ok: message.is_none(), message, sessions, volume, muted }
}

fn collect_sessions() -> WinResult<Vec<SessionInfo>> {
    let manager = manager()?;
    let current = manager.GetCurrentSession().ok().map(|s| text(s.SourceAppUserModelId()));
    let list = manager.GetSessions()?;
    let mut out = Vec::new();
    for index in 0..list.Size()? {
        let session = list.GetAt(index)?;
        if let Ok(info) = describe(&session, index, current.as_deref()) {
            out.push(info);
        }
    }
    Ok(out)
}

fn describe(session: &Session, index: u32, current: Option<&str>) -> WinResult<SessionInfo> {
    let app = text(session.SourceAppUserModelId());
    let props: Option<Properties> = session.TryGetMediaPropertiesAsync().and_then(|op| op.get()).ok();
    let (title, artist, album) = match &props {
        Some(p) => (text(p.Title()), text(p.Artist()), text(p.AlbumTitle())),
        None => Default::default(),
    };

    let playback = session.GetPlaybackInfo()?;
    let controls = playback.Controls()?;
    let status = match playback.PlaybackStatus()? {
        Status::Playing => "Playing",
        Status::Paused => "Paused",
        Status::Stopped => "Stopped",
        Status::Opened => "Opened",
        Status::Changing => "Changing",
        _ => "Closed",
    };

    // Windows reports the position as of LastUpdatedTime; the UI adds the
    // time since then while playing. 116444736000000000 ticks = 1601→1970.
    let timeline = session.GetTimelineProperties()?;
    let start = seconds(timeline.StartTime()?);
    let end = seconds(timeline.EndTime()?);
    let updated_ticks = timeline.LastUpdatedTime()?.UniversalTime;
    let updated_at = ((updated_ticks - 116_444_736_000_000_000) / 10_000) as f64;

    let art = art_for(&format!("{app}|{title}|{artist}|{album}"), props.as_ref());
    let info = app_info(&app);

    Ok(SessionInfo {
        id: format!("{index}|{app}"),
        app_name: info.name,
        title,
        artist,
        album,
        status: status.to_string(),
        can_toggle: controls.IsPlayPauseToggleEnabled().unwrap_or(false),
        can_prev: controls.IsPreviousEnabled().unwrap_or(false),
        can_next: controls.IsNextEnabled().unwrap_or(false),
        can_seek: controls.IsPlaybackPositionEnabled().unwrap_or(false),
        position: (seconds(timeline.Position()?) - start).max(0.0),
        duration: (end - start).max(0.0),
        updated_at,
        is_current: current == Some(app.as_str()),
        art_color: art.as_ref().map(|a| a.color.clone()),
        art: art.map(|a| a.url),
        icon: info.icon,
    })
}

/// Session ids look like "2|Spotify.exe": prefer the same position in the
/// list, fall back to the first session of that app.
fn find_session(manager: &Manager, id: &str) -> WinResult<Option<Session>> {
    let (index, app) = id.split_once('|').unwrap_or(("", id));
    let index: u32 = index.parse().unwrap_or(u32::MAX);
    let list = manager.GetSessions()?;
    let count = list.Size()?;
    if index < count {
        let session = list.GetAt(index)?;
        if text(session.SourceAppUserModelId()) == app {
            return Ok(Some(session));
        }
    }
    for i in 0..count {
        let session = list.GetAt(i)?;
        if text(session.SourceAppUserModelId()) == app {
            return Ok(Some(session));
        }
    }
    Ok(None)
}

/// Per-session play/pause, next and previous.
pub fn control(id: &str, action: &str) -> Result<(), String> {
    init_com();
    let run = || -> WinResult<Option<bool>> {
        let Some(session) = find_session(&manager()?, id)? else { return Ok(None) };
        let accepted = match action {
            "toggle" => session.TryTogglePlayPauseAsync()?.get()?,
            "next" => session.TrySkipNextAsync()?.get()?,
            "prev" => session.TrySkipPreviousAsync()?.get()?,
            _ => false,
        };
        Ok(Some(accepted))
    };
    match run() {
        Ok(Some(true)) => Ok(()),
        Ok(Some(false)) => Err("The player didn't accept that.".into()),
        Ok(None) => Err("That media session has ended.".into()),
        Err(err) => Err(err.message().to_string()),
    }
}

/// Jumps to `secs` into the track (dragging the progress bar).
pub fn seek(id: &str, secs: f64) -> Result<(), String> {
    init_com();
    let run = || -> WinResult<Option<bool>> {
        let Some(session) = find_session(&manager()?, id)? else { return Ok(None) };
        let start = session.GetTimelineProperties()?.StartTime()?.Duration;
        let ticks = start + (secs.max(0.0) * 10_000_000.0) as i64;
        Ok(Some(session.TryChangePlaybackPositionAsync(ticks)?.get()?))
    };
    match run() {
        Ok(Some(true)) => Ok(()),
        Ok(Some(false)) => Err("This player doesn't allow seeking.".into()),
        Ok(None) => Err("That media session has ended.".into()),
        Err(err) => Err(err.message().to_string()),
    }
}

// ── Album art ───────────────────────────────────────────────────────────────

/// Looks the art up in the cache, or reads and processes it once.
fn art_for(key: &str, props: Option<&Properties>) -> Option<Art> {
    if let Some(art) = art_cache().lock().unwrap().get(key) {
        return Some(art.clone());
    }
    let reference = props?.Thumbnail().ok()?;
    let art = process_art(&read_stream(&reference).ok()?)?;
    let mut cache = art_cache().lock().unwrap();
    if cache.len() > 100 {
        cache.clear();
    }
    cache.insert(key.to_string(), art.clone());
    Some(art)
}

/// Album art arrives as a WinRT stream; copy it into a byte vector.
fn read_stream(reference: &IRandomAccessStreamReference) -> WinResult<Vec<u8>> {
    let stream = reference.OpenReadAsync()?.get()?;
    let size = stream.Size()? as u32;
    let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0)?)?;
    reader.LoadAsync(size)?.get()?;
    let mut bytes = vec![0u8; size as usize];
    reader.ReadBytes(&mut bytes)?;
    Ok(bytes)
}

/// Crops the middle square (YouTube art is 16:9, Spotify's is square), shrinks
/// it to 256px (sharp at 200% scaling) and finds its average colour by
/// shrinking it to a single pixel.
fn process_art(bytes: &[u8]) -> Option<Art> {
    let image = image::load_from_memory(bytes).ok()?;
    let (w, h) = (image.width(), image.height());
    let side = w.min(h);
    if side == 0 {
        return None;
    }
    let square = image.crop_imm((w - side) / 2, (h - side) / 2, side, side);
    let small = square.resize_exact(256, 256, FilterType::Triangle).to_rgb8();
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, 85).encode_image(&small).ok()?;
    let pixel = square.resize_exact(1, 1, FilterType::Triangle).to_rgb8();
    let [r, g, b] = pixel.get_pixel(0, 0).0;
    Some(Art {
        url: format!("data:image/jpeg;base64,{}", STANDARD.encode(&jpeg)),
        color: format!("rgb({r}, {g}, {b})"),
    })
}

// ── App names and icons ─────────────────────────────────────────────────────

/// App ids look like "Spotify.exe", "Chrome", "MSEdge", a Firefox install
/// hash, or "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic".
fn app_info(app_id: &str) -> AppInfo {
    if let Some(info) = app_cache().lock().unwrap().get(app_id) {
        return info.clone();
    }
    let info = build_app_info(app_id);
    app_cache().lock().unwrap().insert(app_id.to_string(), info.clone());
    info
}

fn build_app_info(app_id: &str) -> AppInfo {
    if let Some((_, app)) = app_id.split_once('!') {
        let name = app.trim_start_matches("Microsoft.").replace("ZuneMusic", "Media Player").replace("ZuneVideo", "Movies & TV");
        return AppInfo { name, icon: None };
    }
    let stem = app_id.trim_end_matches(".exe");
    // Firefox registers with a 16-character install hash instead of a name.
    let is_hash = stem.len() == 16 && stem.chars().all(|c| c.is_ascii_hexdigit());
    let exe = if is_hash { "firefox.exe".to_string() } else { format!("{stem}.exe") };
    let path = find_process_path(&exe);
    let fallback = if is_hash { "Firefox".to_string() } else { stem.to_string() };
    AppInfo {
        name: path.as_deref().and_then(file_description).unwrap_or(fallback),
        icon: path.as_deref().and_then(icon_data_url),
    }
}

/// Finds the full path of a running process by its .exe name.
fn find_process_path(exe_name: &str) -> Option<String> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut found = None;
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                if String::from_utf16_lossy(&entry.szExeFile[..len]).eq_ignore_ascii_case(exe_name) {
                    if let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, entry.th32ProcessID) {
                        let mut buffer = [0u16; 1024];
                        let mut size = buffer.len() as u32;
                        if QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut size).is_ok() {
                            found = Some(String::from_utf16_lossy(&buffer[..size as usize]));
                        }
                        let _ = CloseHandle(process);
                    }
                    if found.is_some() {
                        break;
                    }
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
        found
    }
}

/// The "File description" from the .exe's version info, e.g. "Brave Browser".
fn file_description(path: &str) -> Option<String> {
    unsafe {
        let file = HSTRING::from(path);
        let size = GetFileVersionInfoSizeW(&file, None);
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(&file, 0, size, data.as_mut_ptr() as *mut c_void).ok()?;

        let mut pointer: *mut c_void = std::ptr::null_mut();
        let mut len = 0u32;
        if !VerQueryValueW(data.as_ptr() as *const c_void, w!("\\VarFileInfo\\Translation"), &mut pointer, &mut len).as_bool() || len < 4 {
            return None;
        }
        let language = *(pointer as *const u16);
        let codepage = *(pointer as *const u16).add(1);
        let key = HSTRING::from(format!("\\StringFileInfo\\{language:04x}{codepage:04x}\\FileDescription"));
        if !VerQueryValueW(data.as_ptr() as *const c_void, &key, &mut pointer, &mut len).as_bool() || len == 0 {
            return None;
        }
        let chars = std::slice::from_raw_parts(pointer as *const u16, len as usize);
        let name = String::from_utf16_lossy(chars).trim_end_matches('\0').trim().to_string();
        (!name.is_empty()).then_some(name)
    }
}

/// The app's icon (as Explorer shows it) as a PNG data URL.
fn icon_data_url(path: &str) -> Option<String> {
    unsafe {
        let mut info = SHFILEINFOW::default();
        let result = SHGetFileInfoW(
            &HSTRING::from(path),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut info as *mut SHFILEINFOW),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        );
        if result == 0 || info.hIcon.is_invalid() {
            return None;
        }
        let pixels = icon_pixels(info.hIcon);
        let _ = DestroyIcon(info.hIcon);
        let (width, height, rgba) = pixels?;
        let mut png = Vec::new();
        PngEncoder::new(&mut png).write_image(&rgba, width, height, ExtendedColorType::Rgba8).ok()?;
        Some(format!("data:image/png;base64,{}", STANDARD.encode(&png)))
    }
}

/// Copies an icon's pixels out of Windows' bitmap into RGBA bytes.
unsafe fn icon_pixels(icon: HICON) -> Option<(u32, u32, Vec<u8>)> {
    let mut parts = ICONINFO::default();
    GetIconInfo(icon, &mut parts).ok()?;
    let mut bitmap = BITMAP::default();
    GetObjectW(parts.hbmColor, std::mem::size_of::<BITMAP>() as i32, Some(&mut bitmap as *mut BITMAP as *mut c_void));
    let (w, h) = (bitmap.bmWidth, bitmap.bmHeight);

    let mut result = None;
    if w > 0 && h > 0 {
        let mut header = BITMAPINFO::default();
        header.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // negative = rows top-to-bottom
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };
        let mut pixels = vec![0u8; (w * h * 4) as usize];
        let screen = GetDC(HWND::default());
        let lines = GetDIBits(screen, parts.hbmColor, 0, h as u32, Some(pixels.as_mut_ptr() as *mut c_void), &mut header, DIB_RGB_COLORS);
        ReleaseDC(HWND::default(), screen);
        if lines > 0 {
            for px in pixels.chunks_exact_mut(4) {
                px.swap(0, 2); // BGRA → RGBA
            }
            // Very old icons have no alpha channel at all; make them opaque.
            if pixels.chunks_exact(4).all(|px| px[3] == 0) {
                pixels.chunks_exact_mut(4).for_each(|px| px[3] = 255);
            }
            result = Some((w as u32, h as u32, pixels));
        }
    }
    let _ = DeleteObject(parts.hbmColor);
    let _ = DeleteObject(parts.hbmMask);
    result
}

// ── Volume (Core Audio) ─────────────────────────────────────────────────────

fn endpoint() -> WinResult<IAudioEndpointVolume> {
    unsafe {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia)?;
        device.Activate(CLSCTX_ALL, None)
    }
}

/// The real system volume (0–100) and mute state.
fn get_volume() -> WinResult<(u32, bool)> {
    let volume = endpoint()?;
    unsafe { Ok(((volume.GetMasterVolumeLevelScalar()? * 100.0).round() as u32, volume.GetMute()?.as_bool())) }
}

pub fn set_volume(level: f64) -> Result<(), String> {
    init_com();
    let level = (level.clamp(0.0, 100.0) / 100.0) as f32;
    endpoint()
        .and_then(|v| unsafe { v.SetMasterVolumeLevelScalar(level, std::ptr::null()) })
        .map_err(|e| e.message().to_string())
}

pub fn set_mute(muted: bool) -> Result<(), String> {
    init_com();
    endpoint()
        .and_then(|v| unsafe { v.SetMute(muted, std::ptr::null()) })
        .map_err(|e| e.message().to_string())
}

// ── Media keys ──────────────────────────────────────────────────────────────

/// Presses and releases a media key, for players without a media session.
pub fn tap_key(code: u16) {
    let key = |flags: KEYBD_EVENT_FLAGS| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(code), wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    };
    let inputs = [key(KEYEVENTF_EXTENDEDKEY), key(KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP)];
    unsafe {
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}
