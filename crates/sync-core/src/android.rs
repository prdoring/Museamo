use jni::{
    objects::{GlobalRef, JClass, JObject, JString, JValue},
    sys::jstring,
    JNIEnv, JavaVM,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, OnceLock};

struct AndroidPlatform {
    vm: JavaVM,
    callback: GlobalRef,
}
impl crate::Platform for AndroidPlatform {
    fn call(&self, method: &str, input: Value) -> Result<Value, String> {
        // Every socket/discovery worker attaches itself. JNIEnv is thread-confined and never
        // captured by the coordinator or used after this guard detaches the thread.
        let mut env = self.vm.attach_current_thread().map_err(|e| e.to_string())?;
        let method = env.new_string(method).map_err(|e| e.to_string())?;
        let input = env
            .new_string(input.to_string())
            .map_err(|e| e.to_string())?;
        let result = env.call_method(
            self.callback.as_obj(),
            "platformCall",
            "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
            &[
                JValue::Object(method.as_ref()),
                JValue::Object(input.as_ref()),
            ],
        );
        let object = match result {
            Ok(v) => v.l().map_err(|e| e.to_string())?,
            Err(e) => {
                let _ = env.exception_clear();
                return Err(format!("Android sync callback failed: {e}"));
            }
        };
        let result = JString::from(object);
        let raw: String = env.get_string(&result).map_err(|e| e.to_string())?.into();
        let value = crate::json::parse(raw.as_bytes())?;
        if value["ok"] == true {
            Ok(value["result"].clone())
        } else {
            Err(value["error"]
                .as_str()
                .unwrap_or("Android platform operation failed")
                .into())
        }
    }
}
static COORDINATOR: OnceLock<Mutex<Option<Arc<crate::Coordinator>>>> = OnceLock::new();
static SHARING: OnceLock<Mutex<Option<Arc<crate::sharing::ShareService>>>> = OnceLock::new();
fn response(env: &mut JNIEnv, result: Result<Value, String>) -> jstring {
    let output = match result {
        Ok(value) => json!({"ok":true,"result":value}),
        Err(error) => json!({"ok":false,"error":error}),
    };
    env.new_string(output.to_string())
        .map(|s| s.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

#[no_mangle]
pub extern "system" fn Java_com_prdoring_museamo_SyncCore_startCoordinator(
    mut env: JNIEnv,
    _class: JClass,
    callback: JObject,
    bind: JString,
) -> jstring {
    let result =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<Value, String> {
            let bind: String = env.get_string(&bind).map_err(|e| e.to_string())?.into();
            let platform = Arc::new(AndroidPlatform {
                vm: env.get_java_vm().map_err(|e| e.to_string())?,
                callback: env.new_global_ref(callback).map_err(|e| e.to_string())?,
            });
            let mut slot = COORDINATOR
                .get_or_init(|| Mutex::new(None))
                .lock()
                .map_err(|_| "Coordinator unavailable")?;
            if let Some(previous) = SHARING.get_or_init(||Mutex::new(None)).lock().map_err(|_|"Sharing unavailable")?.take() { previous.stop(); }
            if let Some(previous) = slot.take() { previous.stop(); }
            let coordinator = crate::Coordinator::new(platform.clone())?;
            let mut state = coordinator.start(&bind)?;
            let sharing = match crate::sharing::ShareService::new(platform,coordinator.clone()) { Ok(sharing)=>sharing,Err(error)=>{coordinator.stop();return Err(error);} };
            state["sharing"] = match sharing.start(&bind) {Ok(state)=>state,Err(error)=>{sharing.stop();coordinator.stop();return Err(error);}};
            *SHARING.get_or_init(||Mutex::new(None)).lock().map_err(|_|"Sharing unavailable")? = Some(sharing);
            *slot = Some(coordinator);
            Ok(state)
        }))
        .unwrap_or_else(|_| Err("Native coordinator failed safely".into()));
    response(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_prdoring_museamo_SyncCore_coordinatorCommand(
    mut env: JNIEnv,
    _class: JClass,
    method: JString,
    input: JString,
) -> jstring {
    let result =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<Value, String> {
            let method: String = env.get_string(&method).map_err(|e| e.to_string())?.into();
            let input: String = env.get_string(&input).map_err(|e| e.to_string())?.into();
            let coordinator = COORDINATOR
                .get_or_init(|| Mutex::new(None))
                .lock()
                .map_err(|_| "Coordinator unavailable")?
                .as_ref()
                .cloned()
                .ok_or("Sync is not running")?;
            let sharing=SHARING.get_or_init(||Mutex::new(None)).lock().map_err(|_|"Sharing unavailable")?.as_ref().cloned();
            let input=crate::json::parse(input.as_bytes())?;
            if matches!(method.as_str(),"getSharingState"|"shareDiscoveryHint"|"getTagShareState"|"startTagSharing"|"createTagInvite"|"cancelTagInvite"|"previewTagInvite"|"joinTagShare"|"leaveTagShare"|"stopTagSharing"|"removeTagShareMember"|"syncTagShare") { return sharing.ok_or("Sharing is not running")?.command(&method,input); }
            let mut result=coordinator.command(&method,input)?;
            if let Some(sharing)=sharing {
                if matches!(method.as_str(),"localDataChanged"|"syncNow"|"removeDevice"|"acceptEnrollment"){sharing.local_data_changed();}
                if method=="getSyncState"{result["sharing"]=sharing.command("getSharingState",json!({}))?;}
            }
            Ok(result)
        }))
        .unwrap_or_else(|_| Err("Native coordinator failed safely".into()));
    response(&mut env, result)
}

#[no_mangle]
pub extern "system" fn Java_com_prdoring_museamo_SyncCore_stopCoordinator(
    mut env: JNIEnv,
    _class: JClass,
) -> jstring {
    let result = (|| -> Result<Value, String> {
        if let Some(sharing)=SHARING.get_or_init(||Mutex::new(None)).lock().map_err(|_|"Sharing unavailable")?.take(){sharing.stop();}
        if let Some(coordinator) = COORDINATOR
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|_| "Coordinator unavailable")?
            .take()
        {
            coordinator.stop();
        }
        Ok(json!({}))
    })();
    response(&mut env, result)
}

/// Kotlin's internal JNI boundary. No renderer-visible native signing or general file primitives.
#[no_mangle]
pub extern "system" fn Java_com_prdoring_museamo_SyncCore_evaluate(
    mut env: JNIEnv,
    _class: JClass,
    input: JString,
) -> jstring {
    let result =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<Value, String> {
            let raw: String = env.get_string(&input).map_err(|e| e.to_string())?.into();
            if raw.len() > crate::MAX_PAYLOAD_BYTES {
                return Err("Core request is too large".into());
            }
            let request: Value = crate::json::parse(raw.as_bytes())?;
            crate::api::evaluate(&request)
        }));
    let output = match result {
        Ok(Ok(value)) => json!({"ok":true,"result":value}),
        Ok(Err(message)) => json!({"ok":false,"error":message}),
        Err(_) => json!({"ok":false,"error":"Native core failed safely"}),
    };
    env.new_string(output.to_string())
        .map(|s| s.into_raw())
        .unwrap_or(std::ptr::null_mut())
}
