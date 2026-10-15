// Tauri's build step: embeds tauri.conf.json, the icon and the Windows
// application manifest into the executable.
fn main() {
    tauri_build::build()
}
