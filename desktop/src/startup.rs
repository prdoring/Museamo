use crate::store::Result;
use serde_json::{json, Value};
#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
#[cfg(windows)]
pub fn get(_: &tauri::AppHandle) -> Result<Value> {
    #[cfg(debug_assertions)]
    if std::env::var_os("MUSEAMO_TEST_DATA_DIR").is_some() {
        return Ok(json!({"enabled":false}));
    }
    use windows_sys::Win32::System::Registry::*;
    let path = wide("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
    let mut key = std::ptr::null_mut();
    let opened = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, path.as_ptr(), 0, KEY_READ, &mut key) };
    if opened == 2 {
        return Ok(json!({"enabled":false}));
    }
    if opened != 0 {
        return Err("Windows could not read the startup preference".into());
    }
    let name = wide("Museamo");
    let mut size = 0;
    let status = unsafe {
        RegQueryValueExW(
            key,
            name.as_ptr(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut size,
        )
    };
    unsafe {
        RegCloseKey(key);
    }
    if status != 0 && status != 2 {
        return Err("Windows could not read the startup preference".into());
    }
    Ok(json!({"enabled":status==0}))
}
#[cfg(windows)]
pub fn set(_: &tauri::AppHandle, enabled: bool) -> Result<Value> {
    #[cfg(debug_assertions)]
    if std::env::var_os("MUSEAMO_TEST_DATA_DIR").is_some() {
        return Err("Startup changes are disabled in an isolated test profile".into());
    }
    use windows_sys::Win32::System::Registry::*;
    let path = wide("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
    let mut key = std::ptr::null_mut();
    let opened = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            path.as_ptr(),
            0,
            std::ptr::null(),
            0,
            KEY_SET_VALUE,
            std::ptr::null(),
            &mut key,
            std::ptr::null_mut(),
        )
    };
    if opened != 0 {
        return Err("Windows could not change the startup preference".into());
    }
    let name = wide("Museamo");
    let status = if enabled {
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        let command = wide(&format!("\"{}\" --background", executable.display()));
        unsafe {
            RegSetValueExW(
                key,
                name.as_ptr(),
                0,
                REG_SZ,
                command.as_ptr() as *const u8,
                (command.len() * 2) as u32,
            )
        }
    } else {
        unsafe { RegDeleteValueW(key, name.as_ptr()) }
    };
    unsafe {
        RegCloseKey(key);
    }
    if status != 0 && status != 2 {
        return Err("Windows could not change the startup preference".into());
    }
    Ok(json!({"enabled":enabled}))
}
#[cfg(not(windows))]
pub fn get(app: &tauri::AppHandle) -> Result<Value> {
    if !supported() {
        return Ok(json!({"enabled":false}));
    }
    use tauri_plugin_autostart::ManagerExt;
    let enabled = app
        .autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())?;
    Ok(json!({"enabled":enabled}))
}
#[cfg(not(windows))]
pub fn set(app: &tauri::AppHandle, enabled: bool) -> Result<Value> {
    if !supported() {
        return Err("Startup changes are disabled in an isolated test profile.".into());
    }
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enabled {
        // auto-launch 0.6 writes unescaped Exec/plist values. Do not report
        // successful registration for paths its format cannot represent.
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        #[cfg(target_os = "linux")]
        let executable = std::env::var_os("APPIMAGE")
            .map(std::path::PathBuf::from)
            .unwrap_or(executable);
        validate_startup_path(&executable)?;
        manager.enable()
    } else {
        manager.disable()
    }
    .map_err(|error| error.to_string())?;
    get(app)
}

#[cfg(not(windows))]
fn validate_startup_path(path: &std::path::Path) -> Result<()> {
    let path = path
        .to_str()
        .ok_or("Startup requires an application path with valid Unicode.")?;
    let unsupported = if cfg!(target_os = "linux") {
        path.chars().any(|character| {
            character.is_whitespace()
                || character.is_control()
                || "\"'\\><~|&;$*?#()`%".contains(character)
        })
    } else {
        path.chars()
            .any(|character| character.is_control() || "&<>".contains(character))
    };
    if unsupported {
        return Err("Startup cannot register this application path. Move Museamo to Applications on macOS, or a Linux path without spaces or special characters, then enable startup again.".into());
    }
    Ok(())
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::validate_startup_path;
    use std::path::Path;

    #[test]
    fn startup_rejects_paths_that_break_native_registration() {
        assert!(validate_startup_path(Path::new("/opt/Museamo/museamo-desktop")).is_ok());
        for path in ["/opt/A&B/Museamo", "/opt/A<B/Museamo", "/opt/app\nOther"] {
            assert!(validate_startup_path(Path::new(path)).is_err());
        }
        #[cfg(target_os = "linux")]
        for path in [
            "/home/user/My Apps/Museamo.AppImage",
            "/opt/app%F",
            "/opt/`app`",
            "/opt/app\\name",
        ] {
            assert!(validate_startup_path(Path::new(path)).is_err());
        }
        #[cfg(target_os = "macos")]
        assert!(validate_startup_path(Path::new(
            "/Applications/My Apps/Museamo.app/Contents/MacOS/museamo-desktop"
        ))
        .is_ok());
    }
}

pub fn supported() -> bool {
    !(cfg!(debug_assertions) && std::env::var_os("MUSEAMO_TEST_DATA_DIR").is_some())
}
