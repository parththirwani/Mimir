// Minimal Tauri shell (7.2/9): wraps the @mimir/web static export in a native
// window and registers the notification plugin. The web app's own service worker
// drives push; this plugin surfaces OS notifications when the window is closed.
// Notification permission is requested by the web app's Settings toggle — never
// auto-enabled at launch.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}