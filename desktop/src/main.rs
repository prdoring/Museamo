#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod backup;
mod hashtags;
mod identity;
#[cfg(test)]
mod integration_tests;
mod media;
mod replica;
mod startup;
mod store;

use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use store::Store;
use tauri::{Emitter, Manager};

struct AppState {
    store: Arc<Mutex<Store>>,
    media_base: String,
    sync: Arc<museamo_sync_core::Coordinator>,
}

#[tauri::command]
async fn library_command(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    method: String,
    input: Value,
) -> Result<Value, Value> {
    let store = state.store.clone();
    let base = state.media_base.clone();
    let sync = state.sync.clone();
    let notify_sync = sync.clone();
    let changed = matches!(
        method.as_str(),
        "commitDraft"
            | "updateEntry"
            | "setStar"
            | "setCompleted"
            | "deleteEntry"
            | "restoreEntry"
            | "saveTag"
            | "deleteTag"
            | "importBackup"
            | "restoreRecovery"
            | "clearRecovery"
            | "clearAllRecovery"
            | "setMediaMetadata"
    );
    let result = tauri::async_runtime::spawn_blocking(move || -> store::Result<Value> {
        match method.as_str() {
            "getSyncState" | "listDevices" | "linkDevice" | "confirmPairing"
            | "acceptEnrollment" | "syncNow" | "removeDevice" | "cancelPairing" => {
                sync.command(&method, input)
            }
            "getStartupSettings" => startup::get(),
            "setStartupEnabled" => startup::set(
                input["enabled"]
                    .as_bool()
                    .ok_or("Invalid startup preference")?,
            ),
            "pickMedia" => media::pick(&store, &input),
            "resolveMedia" => media::resolve(&store, &input, &base),
            "setMediaMetadata" => media::metadata(&store, &input),
            "exportBackup" => backup::export(&store),
            "importBackup" => backup::import(&store),
            "openExternal" | "openLocation" => {
                let raw = if method == "openLocation" {
                    let lat = input["latitude"]
                        .as_f64()
                        .filter(|v| v.is_finite() && (-90.0..=90.0).contains(v))
                        .ok_or("Invalid latitude")?;
                    let lng = input["longitude"]
                        .as_f64()
                        .filter(|v| v.is_finite() && (-180.0..=180.0).contains(v))
                        .ok_or("Invalid longitude")?;
                    format!("https://www.google.com/maps/search/?api=1&query={lat},{lng}")
                } else {
                    store::string(&input, "url")?.to_owned()
                };
                let url = url::Url::parse(&raw).map_err(|_| "Invalid web link")?;
                if !["http", "https"].contains(&url.scheme()) || url.host_str().is_none() {
                    return Err("Only web links can be opened.".into());
                }
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    std::process::Command::new("rundll32.exe")
                        .args(["url.dll,FileProtocolHandler", url.as_str()])
                        .creation_flags(0x08000000)
                        .spawn()
                        .map_err(|e| e.to_string())?;
                }
                Ok(json!({}))
            }
            "copyFormatted" => {
                let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
                if let Some(html) = input["html"].as_str() {
                    clipboard
                        .set_html(html, Some(store::string(&input, "text")?))
                        .map_err(|e| e.to_string())?;
                } else {
                    clipboard
                        .set_text(store::string(&input, "text")?)
                        .map_err(|e| e.to_string())?;
                }
                Ok(json!({}))
            }
            _ => store
                .lock()
                .map_err(|_| "Storage unavailable")?
                .command(&method, &input),
        }
    })
    .await
    .map_err(|e| json!({"code":"BACKEND_FAILURE","message":e.to_string()}))?;
    match result {
        Ok(result) => {
            if changed {
                let _ = app.emit("dataChanged", ());
                let _ = notify_sync.local_data_changed();
            }
            Ok(result)
        }
        Err(message) => Err(
            json!({"code":if message.contains("changed on another device"){"STALE_REVISION"}else{"LIBRARY_ERROR"},"message":message}),
        ),
    }
}

fn main() {
    let mut context = tauri::generate_context!();
    #[cfg(debug_assertions)]
    if let Some(root) = std::env::var_os("MUSEAMO_TEST_DATA_DIR") {
        context.config_mut().identifier = format!(
            "com.prdoring.museamo.fixture.{}",
            &museamo_sync_core::wire::hash(root.to_string_lossy().as_bytes())[..16]
        );
    }
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let root = app.path().app_local_data_dir()?;
            #[cfg(debug_assertions)]
            let root = std::env::var_os("MUSEAMO_TEST_DATA_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or(root);
            let store = Arc::new(Mutex::new(
                Store::open(&root).map_err(std::io::Error::other)?,
            ));
            let media_base = media::serve(store.clone()).map_err(std::io::Error::other)?;
            let platform = Arc::new(replica::NativePlatform::new(
                store.clone(),
                Some(app.handle().clone()),
            ));
            let sync =
                museamo_sync_core::Coordinator::new(platform).map_err(std::io::Error::other)?;
            let _ = sync.start("0.0.0.0:0"); // LAN failures surface in Devices; offline capture remains usable.
            app.manage(AppState {
                store,
                media_base,
                sync,
            });
            use tauri::{
                menu::{Menu, MenuItem},
                tray::TrayIconBuilder,
            };
            let open = MenuItem::with_id(app, "open", "Open Museamo", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .tooltip("Museamo")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            if std::env::args().any(|arg| arg == "--background") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![library_command])
        .run(context);
    if let Err(error) = result {
        rfd::MessageDialog::new().set_title("Museamo could not open").set_description(format!("Native storage could not initialize. Your library has not been replaced.\n\n{error}")).set_level(rfd::MessageLevel::Error).show();
        std::process::exit(1);
    }
}
