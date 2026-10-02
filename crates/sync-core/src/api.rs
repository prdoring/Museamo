use serde_json::{json, Value};
use snow::{HandshakeState, TransportState};
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicU64, Ordering},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

enum State {
    Handshake(HandshakeState),
    Transport(TransportState),
}
struct Session {
    state: State,
    touched: Instant,
}
static SESSIONS: OnceLock<Mutex<BTreeMap<u64, Session>>> = OnceLock::new();
static NEXT: AtomicU64 = AtomicU64::new(1);
fn session_id(request: &Value) -> Result<u64, String> {
    request["session"].as_u64().ok_or("Invalid session".into())
}
fn bytes(request: &Value, key: &str) -> Result<Vec<u8>, String> {
    hex::decode(
        request[key]
            .as_str()
            .ok_or_else(|| format!("Invalid {key}"))?,
    )
    .map_err(|_| format!("Invalid {key} encoding"))
}

/// Internal native/JNI request interface. Never register this general API as a WebView command.
pub fn evaluate(request: &Value) -> Result<Value, String> {
    let action = request["action"].as_str().ok_or("Missing core action")?;
    match action {
        "purgeEligible" => {
            let input: crate::purge::Input =
                serde_json::from_value(request.clone()).map_err(|e| e.to_string())?;
            return Ok(json!({"eligible":crate::purge::eligible(&input)?}));
        }
        "tagAliases" => {
            let records: Vec<crate::tags::TagAlias> =
                serde_json::from_value(request["records"].clone()).map_err(|e| e.to_string())?;
            return Ok(json!({"aliases":crate::tags::aliases(&records)?}));
        }
        "parseJson" => {
            return Ok(crate::json::parse(
                request["text"]
                    .as_str()
                    .ok_or("Missing JSON text")?
                    .as_bytes(),
            )?)
        }
        "normalizeTag" => {
            return Ok(
                json!({"name":crate::normalize_tag(request["name"].as_str().ok_or("Invalid tag")?)}),
            )
        }
        "canonical" => {
            return Ok(json!({"bytes":hex::encode(crate::wire::canonical(&request["value"])?)}))
        }
        "hash" => {
            return Ok(
                json!({"hash":crate::wire::hash(&crate::wire::canonical(&request["value"])?)}),
            )
        }
        "headerBytes" => {
            let header =
                serde_json::from_value(request["header"].clone()).map_err(|e| e.to_string())?;
            return Ok(json!({"bytes":hex::encode(crate::wire::signing_bytes(&header)?)}));
        }
        "verifyEnvelope" => {
            let envelope =
                serde_json::from_value(request["envelope"].clone()).map_err(|e| e.to_string())?;
            crate::wire::verify(
                &envelope,
                request["group"].as_str().ok_or("Invalid group")?,
                &bytes(request, "key")?,
                request["purged"].as_bool().unwrap_or(false),
            )?;
            return Ok(json!({"valid":true}));
        }
        "winner" => {
            let revisions: Vec<crate::model::Revision> =
                serde_json::from_value(request["revisions"].clone()).map_err(|e| e.to_string())?;
            return Ok(
                json!({"revision":crate::model::winner(&revisions,request["retired"].as_bool().unwrap_or(false))?}),
            );
        }
        "newNoiseKey" => {
            let key = snow::Builder::new(
                crate::transport::SUITE
                    .parse()
                    .map_err(|e: snow::Error| e.to_string())?,
            )
            .generate_keypair()
            .map_err(|e| e.to_string())?;
            return Ok(
                json!({"private":hex::encode(key.private),"public":hex::encode(key.public)}),
            );
        }
        _ => {}
    }
    let mut sessions = SESSIONS
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .map_err(|_| "Session registry unavailable")?;
    sessions.retain(|_, s| s.touched.elapsed() < Duration::from_secs(300));
    if action == "createSession" {
        if sessions.len() >= 16 {
            return Err("Too many simultaneous sync sessions".into());
        }
        let private = bytes(request, "private")?;
        let prologue = request["prologue"]
            .as_str()
            .ok_or("Invalid session context")?;
        let state = crate::transport::handshake(
            request["initiator"]
                .as_bool()
                .ok_or("Invalid session role")?,
            &private,
            prologue.as_bytes(),
        )?;
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        sessions.insert(
            id,
            Session {
                state: State::Handshake(state),
                touched: Instant::now(),
            },
        );
        return Ok(json!({"session":id}));
    }
    let id = session_id(request)?;
    if action == "sessionClose" {
        sessions.remove(&id);
        return Ok(json!({}));
    }
    if action == "sessionTransport" {
        let session = sessions.remove(&id).ok_or("Session expired")?;
        match session.state {
            State::Handshake(state) if state.is_handshake_finished() => {
                sessions.insert(
                    id,
                    Session {
                        state: State::Transport(
                            state.into_transport_mode().map_err(|e| e.to_string())?,
                        ),
                        touched: Instant::now(),
                    },
                );
                return Ok(json!({}));
            }
            _ => return Err("Handshake is not complete".into()),
        }
    }
    let session = sessions.get_mut(&id).ok_or("Session expired")?;
    session.touched = Instant::now();
    match (&mut session.state, action) {
        (State::Handshake(state), "sessionWrite") => {
            let payload = bytes(request, "payload")?;
            if payload.len() > 8192 {
                return Err("Pairing payload is too large".into());
            }
            let mut output = vec![0; 16384];
            let size = state
                .write_message(&payload, &mut output)
                .map_err(|e| e.to_string())?;
            Ok(json!({"message":hex::encode(&output[..size])}))
        }
        (State::Handshake(state), "sessionRead") => {
            let message = bytes(request, "message")?;
            if message.len() > 16384 {
                return Err("Handshake is too large".into());
            }
            let mut output = vec![0; 16384];
            let size = state
                .read_message(&message, &mut output)
                .map_err(|e| e.to_string())?;
            Ok(json!({"payload":hex::encode(&output[..size])}))
        }
        (State::Handshake(state), "sessionInfo") => {
            if !state.is_handshake_finished() {
                return Ok(json!({"complete":false}));
            }
            Ok(
                json!({"complete":true,"code":crate::transport::confirmation_code(state)?,"hash":hex::encode(state.get_handshake_hash()),"peerKey":hex::encode(state.get_remote_static().ok_or("Peer identity is missing")?)}),
            )
        }
        (State::Transport(state), "sessionEncrypt") => Ok(
            json!({"message":hex::encode(crate::transport::encrypt(state,&bytes(request,"payload")?)?)}),
        ),
        (State::Transport(state), "sessionDecrypt") => Ok(
            json!({"payload":hex::encode(crate::transport::decrypt(state,&bytes(request,"message")?)?)}),
        ),
        _ => Err("Invalid session transition".into()),
    }
}
