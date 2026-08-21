// Minimal Tauri shell (7.2/9 + 12): wraps the @mimir/web static export in a
// native window with tray + native notifications. The web app's own service
// worker drives push; this plugin surfaces OS notifications when the window is
// hidden. Notification permission is requested by the web app's Settings toggle
// — never auto-enabled at launch.
//
// Tray behavior (12.2): close = hide to tray, never quit; Quit lives only on
// the tray menu and calls app.exit(), which terminates the process directly —
// it does NOT emit CloseRequested, so hide-on-close can't swallow a real quit.

use tauri::Manager;
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(),
        )
        .on_window_event(|window, event| {
            // Close → hide to tray (12.2.1). A real quit goes through the tray
            // menu's app.exit(), which never reaches this handler.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
            use tauri::tray::TrayIconBuilder;

            let show = MenuItem::with_id(app, "show", "Show Mimir", true, None::<&str>)?;
            let autostart = CheckMenuItem::with_id(app, "autostart", "Launch at login", true, false, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &autostart, &PredefinedMenuItem::separator(app)?, &quit])?;

            // Mirror the OS state into the checkbox — the tray reflects reality,
            // not what the app assumes on launch.
            let _ = autostart.set_checked(app.autolaunch().is_enabled().unwrap_or(false));
            let autostart_item = autostart.clone();

            TrayIconBuilder::with_id("main")
                // ponytail: 32x32 png bytes directly — default_window_icon() is a
                // 1024x1024 RGBA buffer that the GTK tray backend rejects ("wrong
                // data size"); tray wants a small square. Upgrade to a HiDPI icon
                // set if the tray looks blurry on hidpi screens.
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?)
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "autostart" => {
                        let autolaunch = app.autolaunch();
                        let enabled = !autolaunch.is_enabled().unwrap_or(false);
                        let ok = if enabled { autolaunch.enable() } else { autolaunch.disable() };
                        let _ = autostart_item.set_checked(ok.is_ok() && enabled);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            app.global_shortcut()
                .register("CmdOrCtrl+Shift+M")
                .inspect_err(|e| eprintln!("failed to register global shortcut: {e}"))
                .ok();

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}