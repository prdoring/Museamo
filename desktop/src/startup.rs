use crate::store::Result;
use serde_json::{json, Value};
#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
#[cfg(windows)]
pub fn get() -> Result<Value> {
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
pub fn set(enabled: bool) -> Result<Value> {
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
pub fn get() -> Result<Value> {
    Ok(json!({"enabled":false}))
}
#[cfg(not(windows))]
pub fn set(_: bool) -> Result<Value> {
    Err("Startup configuration requires Windows".into())
}
