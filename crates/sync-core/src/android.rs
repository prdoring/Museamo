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
            if let Some(previous) = slot.take() {
                previous.stop();
            }
            let coordinator = crate::Coordinator::new(platform)?;
            let state = coordinator.start(&bind)?;
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
            coordinator.command(&method, crate::json::parse(input.as_bytes())?)
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
