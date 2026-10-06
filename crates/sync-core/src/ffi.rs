//! Native C boundary. Callback context outlives every worker, not just the runtime handle.
use crate::{sharing::ShareService, Coordinator, Platform, MAX_PAYLOAD_BYTES};
use serde_json::{json, Value};
use std::{panic::{catch_unwind, AssertUnwindSafe}, sync::Arc};

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Buffer { pub data: *mut u8, pub len: usize }
impl Buffer {
    fn from_value(result: Result<Value, String>) -> Self {
        let value = match result { Ok(result) => json!({"ok":true,"result":result}), Err(error) => json!({"ok":false,"error":error}) };
        let bytes = value.to_string().into_bytes().into_boxed_slice();
        let len = bytes.len();
        Self { data: Box::into_raw(bytes) as *mut u8, len }
    }
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Callbacks {
    pub abi_version: u32,
    pub context: *mut std::ffi::c_void,
    pub call: Option<unsafe extern "C" fn(*mut std::ffi::c_void, *const u8, usize, *const u8, usize) -> Buffer>,
    pub release_response: Option<unsafe extern "C" fn(*mut std::ffi::c_void, Buffer)>,
    pub retain_context: Option<unsafe extern "C" fn(*mut std::ffi::c_void)>,
    pub release_context: Option<unsafe extern "C" fn(*mut std::ffi::c_void)>,
}
struct Host(Callbacks);
// The host contract requires callbacks safe on arbitrary worker threads; Swift dispatches
// persistence onto one serial queue. The opaque context is never dereferenced by Rust.
unsafe impl Send for Host {}
unsafe impl Sync for Host {}
impl Drop for Host {
    fn drop(&mut self) { unsafe { (self.0.release_context.unwrap())(self.0.context) } }
}
impl Platform for Host {
    fn call(&self, method: &str, input: Value) -> Result<Value, String> {
        let bytes = input.to_string().into_bytes();
        let response = unsafe { (self.0.call.unwrap())(self.0.context, method.as_ptr(), method.len(), bytes.as_ptr(), bytes.len()) };
        let result = unsafe { read_json(response.data, response.len) };
        unsafe { (self.0.release_response.unwrap())(self.0.context, response) };
        let response = result?;
        if response["ok"] == true { Ok(response["result"].clone()) }
        else { Err(response["error"].as_str().unwrap_or("Native platform failed").into()) }
    }
}
pub struct Runtime { personal: Arc<Coordinator>, sharing: Arc<ShareService> }
impl Drop for Runtime { fn drop(&mut self) { self.sharing.stop(); self.personal.stop(); } }
unsafe fn read_json(data: *const u8, len: usize) -> Result<Value, String> {
    if data.is_null() || len == 0 || len > MAX_PAYLOAD_BYTES + 128 * 1024 { return Err("Invalid native JSON buffer".into()); }
    crate::json::parse(std::slice::from_raw_parts(data, len))
}
fn guarded(action: impl FnOnce() -> Result<Value, String>) -> Buffer {
    Buffer::from_value(catch_unwind(AssertUnwindSafe(action)).unwrap_or_else(|_| Err("Native operation failed safely".into())))
}
#[no_mangle]
pub extern "C" fn museamo_sync_abi_version() -> u32 { 1 }
#[no_mangle]
pub unsafe extern "C" fn museamo_sync_create(callbacks: Callbacks, response: *mut Buffer) -> *mut Runtime {
    if response.is_null() { return std::ptr::null_mut(); }
    let mut runtime = std::ptr::null_mut();
    *response = guarded(|| {
        if callbacks.abi_version != 1 || callbacks.call.is_none() || callbacks.release_response.is_none()
            || callbacks.retain_context.is_none() || callbacks.release_context.is_none() {
            return Err("Incompatible native callback ABI".into());
        }
        (callbacks.retain_context.unwrap())(callbacks.context);
        let host = Arc::new(Host(callbacks));
        let personal = Coordinator::new(host.clone())?;
        let sharing = ShareService::new(host, personal.clone())?;
        let mut state = match personal.start("0.0.0.0:0") { Ok(state) => state, Err(error) => { personal.stop(); return Err(error); } };
        match sharing.start("0.0.0.0:0") {
            Ok(value) => state["sharing"] = value,
            Err(error) => { sharing.stop(); personal.stop(); return Err(error); }
        }
        runtime = Box::into_raw(Box::new(Runtime { personal, sharing }));
        Ok(state)
    });
    runtime
}
#[no_mangle]
pub unsafe extern "C" fn museamo_sync_command(runtime: *mut Runtime, method: *const u8, method_len: usize, input: *const u8, input_len: usize) -> Buffer {
    guarded(|| {
        let runtime = runtime.as_ref().ok_or("Sync is not running")?;
        if method.is_null() || method_len == 0 || method_len > 128 { return Err("Invalid native method".into()); }
        let method = std::str::from_utf8(std::slice::from_raw_parts(method, method_len)).map_err(|_| "Invalid method encoding")?;
        let input = read_json(input, input_len)?;
        if matches!(method, "getSharingState" | "shareDiscoveryHint" | "getTagShareState" | "startTagSharing" | "createTagInvite" | "cancelTagInvite" | "previewTagInvite" | "joinTagShare" | "leaveTagShare" | "stopTagSharing" | "removeTagShareMember" | "syncTagShare") {
            return runtime.sharing.command(method, input);
        }
        let mut result = runtime.personal.command(method, input)?;
        if matches!(method, "localDataChanged" | "syncNow" | "removeDevice" | "acceptEnrollment") { runtime.sharing.local_data_changed(); }
        if method == "getSyncState" { result["sharing"] = runtime.sharing.command("getSharingState", json!({}))?; }
        Ok(result)
    })
}
#[no_mangle]
pub unsafe extern "C" fn museamo_sync_evaluate(input: *const u8, len: usize) -> Buffer {
    guarded(|| crate::api::evaluate(&read_json(input, len)?))
}
#[no_mangle]
pub unsafe extern "C" fn museamo_sync_destroy(runtime: *mut Runtime) {
    if !runtime.is_null() { let _ = catch_unwind(AssertUnwindSafe(|| drop(Box::from_raw(runtime)))); }
}
#[no_mangle]
pub unsafe extern "C" fn museamo_sync_free(buffer: Buffer) {
    if !buffer.data.is_null() { drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(buffer.data, buffer.len))); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use p256::ecdsa::{signature::Signer, Signature, SigningKey};
    struct Fixture { identity: Value, key: SigningKey, retained: AtomicUsize, released: AtomicUsize, allocations: AtomicUsize }
    unsafe extern "C" fn fixture_retain(pointer: *mut std::ffi::c_void) { (*(pointer as *const Fixture)).retained.fetch_add(1, Ordering::SeqCst); }
    unsafe extern "C" fn fixture_release(pointer: *mut std::ffi::c_void) { (*(pointer as *const Fixture)).released.fetch_add(1, Ordering::SeqCst); }
    unsafe extern "C" fn fixture_free(pointer: *mut std::ffi::c_void, buffer: Buffer) { (*(pointer as *const Fixture)).allocations.fetch_sub(1, Ordering::SeqCst); museamo_sync_free(buffer); }
    unsafe extern "C" fn fixture_call(pointer: *mut std::ffi::c_void, method: *const u8, len: usize, input: *const u8, size: usize) -> Buffer {
        let fixture = &*(pointer as *const Fixture);
        let method = std::str::from_utf8(std::slice::from_raw_parts(method, len)).unwrap();
        let input = read_json(input, size).unwrap();
        let result = match method {
            "syncIdentity" => Ok(fixture.identity.clone()),
            "syncLoad" => Ok(json!({"state":null})),
            "shareLoad" => Ok(json!({"registry":null})),
            "syncSign" => {
                let bytes = hex::decode(input["bytes"].as_str().unwrap()).unwrap();
                let signature: Signature = fixture.key.sign(&bytes);
                Ok(json!({"signature":hex::encode(signature.to_der().as_bytes())}))
            },
            "sharePending" => Ok(json!({"items":[]})),
            other => Err(format!("Unexpected callback {other}")),
        };
        fixture.allocations.fetch_add(1, Ordering::SeqCst);
        Buffer::from_value(result)
    }
    #[test]
    fn runtime_shutdown_retains_callback_context_until_workers_finish() { unsafe {
        let noise = crate::api::evaluate(&json!({"action":"newNoiseKey"})).unwrap();
        let key = SigningKey::from_slice(&[7;32]).unwrap();
        let fixture = Box::new(Fixture { identity: json!({"deviceId":"ffi-device","name":"C host","noisePrivate":noise["private"],"noisePublic":noise["public"],"signingPublic":hex::encode(key.verifying_key().to_encoded_point(false).as_bytes())}), key, retained:AtomicUsize::new(0),released:AtomicUsize::new(0),allocations:AtomicUsize::new(0) });
        let pointer = &*fixture as *const Fixture as *mut std::ffi::c_void;
        let callbacks = Callbacks { abi_version:1,context:pointer,call:Some(fixture_call),release_response:Some(fixture_free),retain_context:Some(fixture_retain),release_context:Some(fixture_release) };
        for _ in 0..3 {
            let mut response = Buffer { data:std::ptr::null_mut(),len:0 };
            let runtime = museamo_sync_create(callbacks, &mut response);
            assert_eq!(value(response)["ok"],true); assert!(!runtime.is_null());
            museamo_sync_destroy(runtime);
        }
        for _ in 0..100 { if fixture.released.load(Ordering::SeqCst) == 3 { break; } std::thread::sleep(std::time::Duration::from_millis(30)); }
        assert_eq!(fixture.retained.load(Ordering::SeqCst),3);
        assert_eq!(fixture.released.load(Ordering::SeqCst),3);
        assert_eq!(fixture.allocations.load(Ordering::SeqCst),0);
        let mut response = Buffer { data:std::ptr::null_mut(),len:0 };
        let bad = museamo_sync_create(Callbacks { abi_version:9,..callbacks }, &mut response);
        assert!(bad.is_null()); assert_eq!(value(response)["ok"],false); assert_eq!(fixture.retained.load(Ordering::SeqCst),3);
    } }
    unsafe fn value(buffer: Buffer) -> Value {
        let result = read_json(buffer.data, buffer.len).unwrap(); museamo_sync_free(buffer); result
    }
    #[test]
    fn strict_json_bounds_and_errors_cross_the_abi() { unsafe {
        assert_eq!(museamo_sync_abi_version(), 1);
        assert_eq!(value(museamo_sync_evaluate(std::ptr::null(), 0))["ok"], false);
        let input = br#"{"action":"normalizeTag","name":" Tasks "}"#;
        assert_eq!(value(museamo_sync_evaluate(input.as_ptr(), input.len()))["result"]["name"], "tasks");
        let invalid = br#"{"action":"hash","action":"canonical"}"#;
        assert_eq!(value(museamo_sync_evaluate(invalid.as_ptr(), invalid.len()))["ok"], false);
        assert_eq!(value(museamo_sync_command(std::ptr::null_mut(), input.as_ptr(), 1, input.as_ptr(), input.len()))["ok"], false);
    } }
}
