//! Operating-system behavior exposed through the existing validated library bridge.
use crate::store::Result;
use serde_json::{json, Value};
use tauri::Manager;

/// Linux tray creation does not prove that a desktop shell exposes its icon.
/// Closing exits there; macOS can always reopen through the Dock.
pub struct DesktopRuntime {
    pub background: bool,
}

pub fn info(app: &tauri::AppHandle) -> Value {
    json!({
        "os": std::env::consts::OS,
        "startupSupported": crate::startup::supported(),
        "windowControls": if cfg!(target_os = "macos") { "native" } else { "custom" },
        "closeBehavior": if app.state::<DesktopRuntime>().background { "background" } else { "quit" }
    })
}

pub fn open_web_url(app: &tauri::AppHandle, url: &url::Url) -> Result<()> {
    if !["http", "https"].contains(&url.scheme()) || url.host_str().is_none() {
        return Err("Only web links can be opened.".into());
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|error| error.to_string())
}

pub fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
