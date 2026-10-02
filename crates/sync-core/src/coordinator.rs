//! Native-only LAN coordinator. Platform callbacks are never renderer commands.
use crate::{
    json,
    membership::{authorized_history, Checkpoint, Removal},
    model::Context,
    transport,
    wire::{self, Envelope},
    MAX_PAYLOAD_BYTES, MAX_RECORD_BYTES,
};
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Read, Write},
    net::{IpAddr, SocketAddr, SocketAddrV6, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub trait Platform: Send + Sync + 'static {
    fn call(&self, method: &str, input: Value) -> Result<Value, String>;
}
const QUARANTINE_ERROR:&str="This linked group has conflicting device-removal records. Sync is disabled and local writing remains available. Export a backup and restore it into a fresh installation to link again.";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    pub device_id: String,
    pub name: String,
    pub noise_public: String,
    pub signing_public: String,
}
impl Identity {
    fn validate(&self) -> Result<(), String> {
        if self.device_id.is_empty() || self.device_id.len() > 128 || self.name.len() > 256 {
            return Err("Invalid peer identity".into());
        }
        if decode(&self.noise_public)?.len() != 32 {
            return Err("Invalid Noise identity".into());
        }
        VerifyingKey::from_sec1_bytes(&decode(&self.signing_public)?)
            .map_err(|_| "Invalid signing identity")?;
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ControlBody {
    version: u32,
    group: String,
    issuer: String,
    parents: Vec<String>,
    kind: String,
    data: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Control {
    id: String,
    body: ControlBody,
    signature: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Enrollment {
    id: String,
    local_tags: Value,
    peer_tags: Value,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Persistent {
    group_id: Option<String>,
    controls: Vec<Control>,
    addresses: BTreeMap<String, String>,
    #[serde(default)]
    last_sync: BTreeMap<String, u64>,
    #[serde(default)]
    control_acknowledgements: BTreeMap<String, BTreeSet<String>>,
    #[serde(default)]
    enrollments: BTreeMap<String, Enrollment>,
}
#[derive(Default)]
struct Runtime {
    address: Option<String>,
    nearby: BTreeMap<String, Value>,
    pairing: Option<Pairing>,
    last_error: Option<String>,
    syncing: BTreeSet<String>,
    dialing: BTreeSet<String>,
    outbound_sessions: BTreeSet<String>,
    discovery_error: Option<String>,
    attachments_pending: usize,
    sync_again: bool,
}
struct Pairing {
    id: String,
    code: String,
    peer: Identity,
    confirmed: Option<bool>,
    peer_confirmed: Option<bool>,
    accepted: Option<bool>,
    peer_accepted: Option<bool>,
    summary: Option<Value>,
}
struct State {
    persistent: Persistent,
    runtime: Runtime,
}

pub struct Coordinator {
    platform: Arc<dyn Platform>,
    platform_gate: Mutex<()>,
    session_gate: Mutex<()>,
    identity: Identity,
    private: Vec<u8>,
    state: Mutex<State>,
    stopping: AtomicBool,
    quarantined: AtomicBool,
    started: AtomicBool,
    connections: AtomicUsize,
    sync_wake: Condvar,
    mdns: Mutex<Option<mdns_sd::ServiceDaemon>>,
}

fn decode(text: &str) -> Result<Vec<u8>, String> {
    hex::decode(text).map_err(|_| "Invalid hexadecimal encoding".into())
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key].as_str().ok_or_else(|| format!("Missing {key}"))
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
fn unique() -> Result<String, String> {
    let key = snow::Builder::new(
        transport::SUITE
            .parse()
            .map_err(|e: snow::Error| e.to_string())?,
    )
    .generate_keypair()
    .map_err(|e| e.to_string())?;
    Ok(wire::hash(&key.private))
}
fn signature_bytes(domain: &[u8], value: &impl Serialize) -> Result<Vec<u8>, String> {
    let mut bytes = domain.to_vec();
    bytes.extend(wire::canonical(value)?);
    Ok(bytes)
}
fn verify_signature(key: &str, bytes: &[u8], signature: &str) -> Result<(), String> {
    let key = VerifyingKey::from_sec1_bytes(&decode(key)?).map_err(|_| "Invalid signing key")?;
    let signature = Signature::from_der(&decode(signature)?).map_err(|_| "Invalid signature")?;
    key.verify(bytes, &signature)
        .map_err(|_| "Peer signature verification failed".into())
}

impl Coordinator {
    pub fn new(platform: Arc<dyn Platform>) -> Result<Arc<Self>, String> {
        let raw = platform.call("syncIdentity", json!({}))?;
        let identity = Identity {
            device_id: text(&raw, "deviceId")?.into(),
            name: text(&raw, "name")?.into(),
            noise_public: text(&raw, "noisePublic")?.into(),
            signing_public: text(&raw, "signingPublic")?.into(),
        };
        identity.validate()?;
        let private = decode(text(&raw, "noisePrivate")?)?;
        if private.len() != 32 {
            return Err("Invalid private Noise key".into());
        }
        let loaded = platform.call("syncLoad", json!({}))?;
        let persistent = if loaded["state"].is_null() {
            Persistent::default()
        } else {
            serde_json::from_value(loaded["state"].clone())
                .map_err(|e| format!("Invalid stored sync state: {e}"))?
        };
        let coordinator = Arc::new(Self {
            platform,
            platform_gate: Mutex::new(()),
            session_gate: Mutex::new(()),
            identity,
            private,
            state: Mutex::new(State {
                persistent,
                runtime: Runtime::default(),
            }),
            stopping: AtomicBool::new(false),
            quarantined: AtomicBool::new(false),
            started: AtomicBool::new(false),
            connections: AtomicUsize::new(0),
            sync_wake: Condvar::new(),
            mdns: Mutex::new(None),
        });
        {
            let state = coordinator
                .state
                .lock()
                .map_err(|_| "Sync state unavailable")?;
            coordinator.validate_controls(
                &state.persistent.controls,
                state.persistent.group_id.as_deref(),
            )?;
            coordinator.quarantined.store(
                membership_view(&state.persistent.controls)?.quarantined,
                Ordering::SeqCst,
            );
        }
        Ok(coordinator)
    }
    fn save(&self, state: &Persistent) -> Result<(), String> {
        self.platform_call("syncSave", json!({"state":state}))?;
        Ok(())
    }
    fn error(&self, error: String) {
        #[cfg(test)]
        eprintln!("{}: {error}", self.identity.device_id);
        if let Ok(mut state) = self.state.lock() {
            state.runtime.last_error = Some(error);
        }
    }
    pub fn start(self: &Arc<Self>, bind: &str) -> Result<Value, String> {
        if self.started.swap(true, Ordering::SeqCst) {
            return self.public_state();
        }
        self.stopping.store(false, Ordering::SeqCst);
        let listener = match bind_listener(bind, self) {
            Ok(v) => v,
            Err(e) => {
                self.started.store(false, Ordering::SeqCst);
                let error = format!("Cannot listen for local devices: {e}");
                self.error(error.clone());
                return Err(error);
            }
        };
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let address = listener.local_addr().map_err(|e| e.to_string())?;
        self.state
            .lock()
            .map_err(|_| "Sync state unavailable")?
            .runtime
            .address = Some(address.to_string());
        let owner = Arc::clone(self);
        thread::spawn(move || {
            while !owner.stopping.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, address)) => {
                        let address = normalize_address(address);
                        if parse_address(&address.to_string()).is_ok() {
                            owner.spawn_connection(stream, false, address.to_string(), None);
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(100))
                    }
                    Err(e) => {
                        owner.error(e.to_string());
                        break;
                    }
                }
            }
            owner.started.store(false, Ordering::SeqCst);
        });
        if !address.ip().is_loopback() {
            if let Err(error) = self.start_discovery(address.port()) {
                self.state
                    .lock()
                    .map_err(|_| "Sync state unavailable")?
                    .runtime
                    .discovery_error = Some(error);
            }
        }
        let owner = Arc::clone(self);
        thread::spawn(move || {
            // Reopening a known library catches up immediately. The timer remains
            // a fallback for unreachable peers and discovery, not the edit path.
            let mut next_poll = Instant::now();
            while !owner.stopping.load(Ordering::SeqCst) {
                let Ok(mut state) = owner.state.lock() else { break };
                while !owner.stopping.load(Ordering::SeqCst)
                    && Instant::now() < next_poll
                    && !(state.runtime.sync_again && state.runtime.syncing.is_empty()
                        && owner.connections.load(Ordering::SeqCst) == 0)
                {
                    let wait = next_poll.saturating_duration_since(Instant::now());
                    let Ok((next, _)) = owner.sync_wake.wait_timeout(state, wait) else { return };
                    state = next;
                }
                drop(state);
                if owner.stopping.load(Ordering::SeqCst) { break }
                let _ = owner.sync_known();
                next_poll = Instant::now() + Duration::from_secs(30);
            }
        });
        self.public_state()
    }
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        if let Ok(_state) = self.state.lock() { self.sync_wake.notify_all(); }
        // Fence every callback, including a queued JNI repository write. After this returns
        // the old coordinator cannot overwrite a newly loaded membership snapshot.
        if let Ok(gate) = self.platform_gate.lock() {
            drop(gate);
        }
        if let Ok(mut mdns) = self.mdns.lock() {
            if let Some(daemon) = mdns.take() {
                let _ = daemon.shutdown();
            }
        }
    }
    fn platform_call(&self, method: &str, input: Value) -> Result<Value, String> {
        let _gate = self
            .platform_gate
            .lock()
            .map_err(|_| "Sync platform gate unavailable")?;
        if self.stopping.load(Ordering::SeqCst) {
            return Err("Sync stopped".into());
        }
        if self.quarantined.load(Ordering::SeqCst)
            && !matches!(
                method,
                "syncIdentity" | "syncLoad" | "syncSave" | "syncSign"
            )
        {
            return Err(QUARANTINE_ERROR.into());
        }
        self.platform.call(method, input)
    }
    fn ensure_session_authority(&self, peer: &Identity, admitted: bool) -> Result<(), String> {
        if self.stopping.load(Ordering::SeqCst) {
            return Err("Sync stopped".into());
        }
        let state = self.state.lock().map_err(|_| "Sync state unavailable")?;
        let view = membership_view(&state.persistent.controls)?;
        if view.quarantined || self.quarantined.load(Ordering::SeqCst) {
            return Err(QUARANTINE_ERROR.into());
        }
        if view
            .removals
            .values()
            .any(|r| r.subject == peer.device_id || r.subject == self.identity.device_id)
            || (admitted
                && (view.active.get(&peer.device_id) != Some(peer)
                    || view.active.get(&self.identity.device_id) != Some(&self.identity)))
        {
            return Err("A device was removed during sync".into());
        }
        Ok(())
    }
    fn with_session_authority<T>(
        &self,
        peer: &Identity,
        admitted: bool,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        // Control mutations take this fence before State. Each bounded callback or encrypted
        // record is authorized atomically with revocation; network reads never hold this lock.
        let _gate = self
            .session_gate
            .lock()
            .map_err(|_| "Sync session gate unavailable")?;
        self.ensure_session_authority(peer, admitted)?;
        action()
    }
    fn session_call(
        &self,
        peer: &Identity,
        admitted: bool,
        method: &str,
        input: Value,
    ) -> Result<Value, String> {
        self.with_session_authority(peer, admitted, || self.platform_call(method, input))
    }
    fn start_discovery(self: &Arc<Self>, port: u16) -> Result<(), String> {
        let daemon = mdns_sd::ServiceDaemon::new().map_err(|e| e.to_string())?;
        let prefix = &wire::hash(self.identity.device_id.as_bytes())[..16];
        let service = mdns_sd::ServiceInfo::new(
            "_museamo._tcp.local.",
            prefix,
            &format!("museamo-{prefix}.local."),
            "",
            port,
            &[
                ("device", self.identity.device_id.as_str()),
                ("name", self.identity.name.as_str()),
                ("protocol", "1"),
            ][..],
        )
        .map_err(|e| e.to_string())?
        .enable_addr_auto();
        daemon.register(service).map_err(|e| e.to_string())?;
        let receiver = daemon
            .browse("_museamo._tcp.local.")
            .map_err(|e| e.to_string())?;
        *self.mdns.lock().map_err(|_| "Discovery unavailable")? = Some(daemon);
        let owner = Arc::clone(self);
        thread::spawn(move || {
            while !owner.stopping.load(Ordering::SeqCst) {
                if let Ok(mdns_sd::ServiceEvent::ServiceResolved(info)) =
                    receiver.recv_timeout(Duration::from_secs(1))
                {
                    let id = info
                        .get_property_val_str("device")
                        .unwrap_or("")
                        .to_string();
                    if id.is_empty() || id == owner.identity.device_id || id.len() > 128 {
                        continue;
                    }
                    let name = info
                        .get_property_val_str("name")
                        .unwrap_or("Nearby device")
                        .chars()
                        .take(128)
                        .collect::<String>();
                    let addresses =
                        discovery_endpoints(info.get_addresses().iter().copied(), info.get_port());
                    if let Some(address) = addresses.first() {
                        let _ = owner.observe_hint(&id, json!({"deviceId":id,"name":name,"address":address,"addresses":addresses,"discoveredAt":now()}));
                    }
                }
            }
        });
        Ok(())
    }
    pub fn command(self: &Arc<Self>, method: &str, input: Value) -> Result<Value, String> {
        match method {
            "getSyncState" => self.public_state(),
            "listDevices" => {
                let state = self.public_state()?;
                Ok(json!({"devices":state["devices"],"nearby":state["nearby"]}))
            }
            "linkDevice" => {
                let address = text(&input, "address")?;
                self.connect(address)?;
                self.public_state()
            }
            "confirmPairing" | "acceptEnrollment" | "cancelPairing" => {
                let id = text(&input, "sessionId")?;
                let mut state = self.state.lock().map_err(|_| "Sync state unavailable")?;
                let pairing = state
                    .runtime
                    .pairing
                    .as_mut()
                    .filter(|p| p.id == id)
                    .ok_or("Pairing expired")?;
                match method {
                    "confirmPairing" => {
                        pairing.confirmed = Some(
                            input["confirmed"]
                                .as_bool()
                                .ok_or("Confirmation is required")?,
                        )
                    }
                    "acceptEnrollment" => {
                        if pairing.summary.is_none() {
                            return Err(
                                "Confirm the matching code before accepting the merge".into()
                            );
                        }
                        pairing.accepted = Some(
                            input["accepted"]
                                .as_bool()
                                .ok_or("Merge confirmation is required")?,
                        );
                    }
                    _ => {
                        pairing.confirmed = Some(false);
                        pairing.accepted = Some(false);
                    }
                }
                drop(state);
                self.public_state()
            }
            "localDataChanged" => {
                self.local_data_changed()?;
                Ok(json!({}))
            }
            "syncNow" => {
                self.local_data_changed()?;
                self.public_state()
            }
            "removeDevice" => {
                self.remove(text(&input, "deviceId")?)?;
                self.local_data_changed()?;
                self.public_state()
            }
            // Android NSD can supply hints without changing trust.
            "discoveryHint" => {
                let id = text(&input, "deviceId")?;
                let address = text(&input, "address")?;
                parse_address(address)?;
                self.observe_hint(id, json!({"deviceId":id,"name":input["name"],"address":address,"discoveredAt":now()}))?;
                self.public_state()
            }
            _ => Err("Unsupported device operation".into()),
        }
    }
    pub fn public_state(&self) -> Result<Value, String> {
        let state = self.state.lock().map_err(|_| "Sync state unavailable")?;
        let mut members = membership_view(&state.persistent.controls)?;
        members.quarantined |= self.quarantined.load(Ordering::SeqCst);
        let last_error = if members.quarantined {
            Some(QUARANTINE_ERROR.to_string())
        } else {
            state.runtime.last_error.clone()
        };
        let devices:Vec<Value>=members.active.values().filter(|p|p.device_id!=self.identity.device_id).map(|p|json!({"deviceId":p.device_id,"name":p.name,"address":state.persistent.addresses.get(&p.device_id),"status":if state.runtime.syncing.contains(&p.device_id){"syncing"}else if state.runtime.nearby.get(&p.device_id).is_some_and(|hint|now().saturating_sub(hint["discoveredAt"].as_u64().unwrap_or(0))<120_000){"available"}else{"linked"},"lastSync":state.persistent.last_sync.get(&p.device_id)})).collect();
        let removals:Vec<_>=members.removals.values().map(|removal|{let pending:Vec<_>=members.active.keys().filter(|id|*id!=&self.identity.device_id&&!state.persistent.control_acknowledgements.get(*id).is_some_and(|records|records.contains(&removal.id))).collect();json!({"id":removal.id,"subject":removal.subject,"pendingDevices":pending,"removalPending":!pending.is_empty()})}).collect();
        let pairing=state.runtime.pairing.as_ref().map(|p|json!({"sessionId":p.id,"code":p.code,"peer":p.peer,"confirmed":p.confirmed,"localConfirmed":p.confirmed,"peerConfirmed":p.peer_confirmed,"localAccepted":p.accepted,"peerAccepted":p.peer_accepted,"summary":p.summary}));
        let addresses = state
            .runtime
            .address
            .as_ref()
            .and_then(|a| a.parse::<SocketAddr>().ok())
            .map(local_endpoints)
            .unwrap_or_default();
        Ok(
            json!({"enabled":self.started.load(Ordering::SeqCst)&&!members.quarantined,"groupId":state.persistent.group_id,"deviceId":self.identity.device_id,"name":self.identity.name,"phase":if members.quarantined{"error"}else if let Some(p)=state.runtime.pairing.as_ref(){if p.summary.is_some(){"merge"}else{"pairing"}}else if !state.runtime.syncing.is_empty(){"syncing"}else{"idle"},"address":addresses.first(),"addresses":addresses,"devices":devices,"nearby":state.runtime.nearby.values().filter(|p|now().saturating_sub(p["discoveredAt"].as_u64().unwrap_or(0))<120_000).collect::<Vec<_>>(),"pairing":pairing,"lastError":last_error,"discoveryError":state.runtime.discovery_error,"discoveryAvailable":state.runtime.discovery_error.is_none()&&self.mdns.lock().map(|m|m.is_some()).unwrap_or(false),"attachmentsPending":state.runtime.attachments_pending,"removals":removals}),
        )
    }
    fn connect(self: &Arc<Self>, address: &str) -> Result<(), String> {
        self.connect_expected(address, None)
    }
    fn connect_expected(
        self: &Arc<Self>,
        address: &str,
        expected: Option<String>,
    ) -> Result<(), String> {
        self.connect_candidates(vec![address.to_string()], expected)
    }
    fn connect_candidates(
        self: &Arc<Self>,
        addresses: Vec<String>,
        expected: Option<String>,
    ) -> Result<(), String> {
        let addresses = addresses
            .iter()
            .take(16)
            .map(|a| parse_address(a))
            .collect::<Result<Vec<_>, _>>()?;
        if let Some(id) = &expected {
            let mut state = self.state.lock().map_err(|_| "Sync state unavailable")?;
            if !state.runtime.dialing.insert(id.clone()) { return Ok(()) }
        }
        if self.connections.fetch_add(1, Ordering::SeqCst) >= 8 {
            self.connections.fetch_sub(1, Ordering::SeqCst);
            if let Some(id) = &expected {
                if let Ok(mut state) = self.state.lock() { state.runtime.dialing.remove(id); }
            }
            return Err("Too many local device connections; retry shortly".into());
        }
        let owner = Arc::clone(self);
        thread::spawn(move || {
            let mut result = Err("No local endpoint is available".to_string());
            for address in addresses {
                if owner.stopping.load(Ordering::SeqCst) {
                    break;
                }
                result = owner.connect_stream(address).and_then(|stream| {
                    if let Some(id) = &expected {
                        owner.state.lock().map_err(|_| "Sync state unavailable")?.runtime.outbound_sessions.insert(id.clone());
                    }
                    let result = owner.session(stream, true, &address.to_string(), expected.as_deref());
                    if let Some(id) = &expected {
                        if let Ok(mut state) = owner.state.lock() { state.runtime.outbound_sessions.remove(id); }
                    }
                    result
                });
                if result.is_ok() {
                    break;
                }
            }
            if let Err(error) = result {
                owner.error(error);
            }
            owner.connection_finished(expected.as_deref());
        });
        Ok(())
    }
    fn connect_stream(&self, address: SocketAddr) -> Result<TcpStream, String> {
        let socket = socket2::Socket::new(
            if address.is_ipv4() {
                socket2::Domain::IPV4
            } else {
                socket2::Domain::IPV6
            },
            socket2::Type::STREAM,
            Some(socket2::Protocol::TCP),
        )
        .map_err(|e| e.to_string())?;
        bind_network_socket(self, &socket)?;
        socket
            .connect_timeout(&address.into(), Duration::from_secs(8))
            .map_err(|e| e.to_string())?;
        Ok(socket.into())
    }
    /// Called by native writers after commit, never from a platform callback.
    pub fn local_data_changed(self: &Arc<Self>) -> Result<(), String> {
        if !self.started.load(Ordering::SeqCst) || self.stopping.load(Ordering::SeqCst) {
            return Ok(());
        }
        self.state.lock().map_err(|_| "Sync state unavailable")?.runtime.sync_again = true;
        // Start available peers now; if a transfer is active, its teardown wakes
        // the queued follow-up. No network I/O runs on the caller's thread.
        self.sync_known()?;
        self.sync_wake.notify_one();
        Ok(())
    }
    fn observe_hint(self: &Arc<Self>, id: &str, hint: Value) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|_| "Sync state unavailable")?;
        let changed = state.runtime.nearby.get(id).is_none_or(|previous| previous["address"] != hint["address"]);
        let known = membership_view(&state.persistent.controls)?.active.contains_key(id);
        if state.runtime.nearby.len() < 128 || state.runtime.nearby.contains_key(id) {
            state.runtime.nearby.insert(id.into(), hint);
        }
        drop(state);
        // Reconnect pinned peers as soon as discovery supplies their new port.
        // An announcement for an unknown identity never initiates enrollment.
        if changed && known { self.local_data_changed()?; }
        Ok(())
    }
    fn connection_finished(&self, expected: Option<&str>) {
        // Pair the connection-count predicate with the condition-variable mutex
        // so completion cannot be lost between checking it and going to sleep.
        let mut state = self.state.lock().ok();
        if let (Some(state), Some(id)) = (state.as_mut(), expected) {
            state.runtime.outbound_sessions.remove(id);
            state.runtime.dialing.remove(id);
        }
        self.connections.fetch_sub(1, Ordering::SeqCst);
        self.sync_wake.notify_one();
    }
    fn sync_known(self: &Arc<Self>) -> Result<(), String> {
        if self.stopping.load(Ordering::SeqCst) { return Ok(()) }
        let mut state = self.state.lock().map_err(|_| "Sync state unavailable")?;
        if state.runtime.syncing.is_empty() && state.runtime.dialing.is_empty() {
            state.runtime.sync_again = false;
        }
        let view = membership_view(&state.persistent.controls)?;
        if view.quarantined {
            return Err(QUARANTINE_ERROR.into());
        }
        let targets: Vec<_> = view
            .active
            .keys()
            .filter(|id| *id != &self.identity.device_id && !state.runtime.syncing.contains(*id) && !state.runtime.dialing.contains(*id))
            .filter_map(|id| {
                let mut addresses = state
                    .runtime
                    .nearby
                    .get(id)
                    .and_then(|v| v["addresses"].as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                if let Some(address) = state
                    .runtime
                    .nearby
                    .get(id)
                    .and_then(|v| v["address"].as_str())
                    .map(str::to_string)
                    .or_else(|| state.persistent.addresses.get(id).cloned())
                {
                    if !addresses.contains(&address) {
                        addresses.push(address);
                    }
                }
                (!addresses.is_empty()).then_some((id.clone(), addresses))
            })
            .collect();
        drop(state);
        for (id, targets) in targets {
            self.connect_candidates(targets, Some(id))?;
        }
        Ok(())
    }
    fn spawn_connection(
        self: &Arc<Self>,
        stream: TcpStream,
        initiator: bool,
        address: String,
        expected: Option<String>,
    ) {
        if self.connections.fetch_add(1, Ordering::SeqCst) >= 8 {
            self.connections.fetch_sub(1, Ordering::SeqCst);
            return;
        }
        let owner = Arc::clone(self);
        thread::spawn(move || {
            let result = owner.session(stream, initiator, &address, expected.as_deref());
            if let Err(error) = result {
                owner.error(error);
            }
            owner.connection_finished(None);
        });
    }
    fn sign(&self, bytes: &[u8]) -> Result<String, String> {
        let result = self.platform_call("syncSign", json!({"bytes":hex::encode(bytes)}))?;
        let signature = text(&result, "signature")?.to_string();
        verify_signature(&self.identity.signing_public, bytes, &signature)?;
        Ok(signature)
    }
    fn make_control(
        &self,
        persistent: &Persistent,
        kind: &str,
        data: Value,
    ) -> Result<Control, String> {
        if membership_view(&persistent.controls)?.quarantined {
            return Err(QUARANTINE_ERROR.into());
        }
        if kind != "genesis"
            && !membership_view(&persistent.controls)?
                .active
                .contains_key(&self.identity.device_id)
        {
            return Err("This device is no longer authorized to manage the linked library".into());
        }
        let body = ControlBody {
            version: 1,
            group: persistent.group_id.clone().ok_or("Library not enrolled")?,
            issuer: self.identity.device_id.clone(),
            parents: persistent.controls.iter().map(|c| c.id.clone()).collect(),
            kind: kind.into(),
            data,
        };
        let id = wire::hash(&wire::canonical(&body)?);
        let signature = self.sign(&signature_bytes(b"museamo-membership-v1\0", &body)?)?;
        Ok(Control {
            id,
            body,
            signature,
        })
    }
    fn remove(&self, id: &str) -> Result<(), String> {
        let gate = self
            .session_gate
            .lock()
            .map_err(|_| "Sync session gate unavailable")?;
        let mut state = self.state.lock().map_err(|_| "Sync state unavailable")?;
        let view = membership_view(&state.persistent.controls)?;
        if id == self.identity.device_id || !view.active.contains_key(id) {
            return Err("Choose a linked device to remove".into());
        }
        let witnesses: Vec<_> = view
            .active
            .keys()
            .filter(|other| other.as_str() != id)
            .cloned()
            .collect();
        let control = self.make_control(
            &state.persistent,
            "remove",
            json!({"subject":id,"witnesses":witnesses}),
        )?;
        let mut next = state.persistent.clone();
        next.controls.push(control);
        self.save(&next)?;
        state.persistent = next;
        drop(state);
        drop(gate);
        self.freeze_checkpoints()
    }
    fn freeze_checkpoints(&self) -> Result<(), String> {
        let snapshots = {
            let state = self.state.lock().map_err(|_| "Sync state unavailable")?;
            let view = membership_view(&state.persistent.controls)?;
            if view.quarantined {
                return Ok(());
            }
            if !view.active.contains_key(&self.identity.device_id) {
                return Ok(());
            }
            view.removals
                .values()
                .filter(|r| {
                    r.witnesses.contains(&self.identity.device_id)
                        && !state.persistent.controls.iter().any(|c| {
                            c.body.kind == "checkpoint"
                                && c.body.issuer == self.identity.device_id
                                && c.body.data["removalId"] == r.id
                        })
                })
                .cloned()
                .collect::<Vec<_>>()
        };
        for removal in snapshots {
            let receipt = self.platform_call("syncReceipts", json!({}))?;
            let through = receipt["receipts"][&removal.subject].as_u64().unwrap_or(0);
            let digest = if through == 0 {
                String::new()
            } else {
                text(
                    &self.platform_call(
                        "syncHeader",
                        json!({"origin":removal.subject,"sequence":through}),
                    )?,
                    "hash",
                )?
                .to_string()
            };
            let mut state = self.state.lock().map_err(|_| "Sync state unavailable")?;
            if state.persistent.controls.iter().any(|c| {
                c.body.kind == "checkpoint"
                    && c.body.issuer == self.identity.device_id
                    && c.body.data["removalId"] == removal.id
            }) {
                continue;
            }
            let control=self.make_control(&state.persistent,"checkpoint",json!({"removalId":removal.id,"witness":self.identity.device_id,"through":through,"headerHash":digest}))?;
            let mut next = state.persistent.clone();
            next.controls.push(control);
            self.save(&next)?;
            state.persistent = next;
        }
        Ok(())
    }
    fn validate_controls(&self, controls: &[Control], group: Option<&str>) -> Result<(), String> {
        if controls.len() > 8192 {
            return Err("Too many membership records".into());
        }
        if controls.is_empty() {
            return Ok(());
        }
        let group = group.ok_or("Missing library identity")?;
        let mut accepted = Vec::new();
        let mut pending = controls.to_vec();
        let mut identities: BTreeMap<String, Identity> = BTreeMap::new();
        let mut known = BTreeSet::new();
        while !pending.is_empty() {
            let before = pending.len();
            let mut remainder = Vec::new();
            for control in pending {
                if known.contains(&control.id) {
                    if accepted.iter().any(|old: &Control| {
                        old.id == control.id
                            && wire::canonical(old).ok() != wire::canonical(&control).ok()
                    }) {
                        return Err("Conflicting membership record".into());
                    }
                    continue;
                }
                if control.body.parents.iter().any(|id| !known.contains(id)) {
                    remainder.push(control);
                    continue;
                }
                if control.body.version != 1
                    || control.body.group != group
                    || control.body.parents.len() > 8192
                    || control.id != wire::hash(&wire::canonical(&control.body)?)
                {
                    return Err("Invalid membership record".into());
                }
                let context = ancestors(&accepted, &control.body.parents);
                let view = membership_view(&context)?;
                let key = if control.body.kind == "genesis" {
                    if !accepted.is_empty() || !control.body.parents.is_empty() {
                        return Err("Duplicate library root".into());
                    }
                    let identity: Identity = serde_json::from_value(control.body.data.clone())
                        .map_err(|e| e.to_string())?;
                    identity.validate()?;
                    if identity.device_id != control.body.issuer {
                        return Err("Invalid root issuer".into());
                    }
                    identities.insert(identity.device_id.clone(), identity.clone());
                    identity.signing_public
                } else {
                    view.active
                        .get(&control.body.issuer)
                        .ok_or("Membership record issuer was not admitted")?
                        .signing_public
                        .clone()
                };
                verify_signature(
                    &key,
                    &signature_bytes(b"museamo-membership-v1\0", &control.body)?,
                    &control.signature,
                )?;
                match control.body.kind.as_str() {
                    "genesis" => {}
                    "admit" => {
                        let identity: Identity = serde_json::from_value(control.body.data.clone())
                            .map_err(|e| e.to_string())?;
                        identity.validate()?;
                        if let Some(old) =
                            identities.insert(identity.device_id.clone(), identity.clone())
                        {
                            if old != identity {
                                return Err("Linked device identity changed".into());
                            }
                        }
                    }
                    "remove" => {
                        let subject = text(&control.body.data, "subject")?;
                        if subject == control.body.issuer || !view.active.contains_key(subject) {
                            return Err("Invalid device removal".into());
                        }
                        let actual: BTreeSet<String> =
                            serde_json::from_value(control.body.data["witnesses"].clone())
                                .map_err(|e| e.to_string())?;
                        let expected: BTreeSet<_> = view
                            .active
                            .keys()
                            .filter(|id| id.as_str() != subject)
                            .cloned()
                            .collect();
                        if actual != expected {
                            return Err("Invalid removal witnesses".into());
                        }
                    }
                    "checkpoint" => {
                        let checkpoint: Checkpoint =
                            serde_json::from_value(control.body.data.clone())
                                .map_err(|e| e.to_string())?;
                        let removal = view
                            .removals
                            .get(&checkpoint.removal_id)
                            .ok_or("Checkpoint without removal")?;
                        if checkpoint.witness != control.body.issuer {
                            return Err("Checkpoint witness differs from signer".into());
                        }
                        authorized_history(removal, &[checkpoint])?;
                    }
                    _ => return Err("Unsupported membership record".into()),
                }
                known.insert(control.id.clone());
                accepted.push(control);
            }
            if remainder.len() == before {
                return Err("Membership history is missing or cyclic".into());
            }
            pending = remainder;
        }
        membership_view(&accepted)?;
        Ok(())
    }
    fn merge_controls(&self, incoming: Vec<Control>, group: &str) -> Result<(), String> {
        let gate = self
            .session_gate
            .lock()
            .map_err(|_| "Sync session gate unavailable")?;
        let mut state = self.state.lock().map_err(|_| "Sync state unavailable")?;
        if state
            .persistent
            .group_id
            .as_deref()
            .is_some_and(|old| old != group)
        {
            return Err("Cannot merge two linked groups".into());
        }
        let mut next = state.persistent.clone();
        next.group_id = Some(group.into());
        for record in incoming {
            if let Some(old) = next.controls.iter().find(|old| old.id == record.id) {
                if wire::canonical(old)? != wire::canonical(&record)? {
                    return Err("Conflicting membership history".into());
                }
            } else {
                next.controls.push(record);
            }
        }
        self.validate_controls(&next.controls, Some(group))?;
        if membership_view(&next.controls)?.quarantined {
            self.quarantined.store(true, Ordering::SeqCst);
        }
        self.save(&next)?;
        state.persistent = next;
        drop(state);
        drop(gate);
        self.freeze_checkpoints()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        model::{Clock, Dot, Revision},
        wire::Header,
    };
    use p256::ecdsa::{signature::Signer, SigningKey};

    struct Fake {
        id: Identity,
        private: String,
        key: SigningKey,
        db: Mutex<FakeDb>,
        summary_calls: AtomicUsize,
    }
    #[derive(Default)]
    struct FakeDb {
        state: Option<Value>,
        group: Option<String>,
        operations: Vec<Envelope>,
        originals: BTreeMap<String, Vec<u8>>,
        wanted: BTreeMap<String, Value>,
        staging: BTreeMap<String, Vec<u8>>,
    }
    impl Fake {
        fn new(id: &str, seed: u8) -> Arc<Self> {
            let pair = snow::Builder::new(transport::SUITE.parse().unwrap())
                .generate_keypair()
                .unwrap();
            let key = SigningKey::from_bytes((&[seed; 32]).into()).unwrap();
            let identity = Identity {
                device_id: id.into(),
                name: format!("Device {id}"),
                noise_public: hex::encode(pair.public),
                signing_public: hex::encode(key.verifying_key().to_encoded_point(false).as_bytes()),
            };
            Arc::new(Self {
                id: identity,
                private: hex::encode(pair.private),
                key,
                db: Mutex::new(FakeDb::default()),
                summary_calls: AtomicUsize::new(0),
            })
        }
        fn append(&self, payload: Value) {
            let mut db = self.db.lock().unwrap();
            let group = db.group.clone().unwrap();
            let prior = db
                .operations
                .iter()
                .filter(|r| r.header.revision.dot.origin == self.id.device_id)
                .last();
            let sequence = prior
                .map(|r| r.header.revision.dot.sequence + 1)
                .unwrap_or(1);
            let previous_hash = prior
                .map(|r| wire::hash(&wire::canonical(&r.header).unwrap()))
                .unwrap_or_default();
            let context = receipts(&db.operations);
            let header = Header {
                protocol: 1,
                group,
                kind: "thought".into(),
                previous_hash,
                revision: Revision {
                    entity_id: payload["id"].as_str().unwrap().into(),
                    dot: Dot {
                        origin: self.id.device_id.clone(),
                        sequence,
                    },
                    context,
                    clock: Clock {
                        wall: now(),
                        logical: 0,
                    },
                    deleted: false,
                    payload_hash: wire::hash(&wire::canonical(&payload).unwrap()),
                },
            };
            let signature: Signature = self.key.sign(&wire::signing_bytes(&header).unwrap());
            db.operations.push(Envelope {
                header,
                signature: hex::encode(signature.to_der().as_bytes()),
                payload: Some(payload),
            });
        }
    }
    fn receipts(rows: &[Envelope]) -> Context {
        let mut context = Context::new();
        for row in rows {
            let origin = &row.header.revision.dot.origin;
            let sequence = row.header.revision.dot.sequence;
            let old = context.entry(origin.clone()).or_default();
            if sequence == *old + 1 {
                *old = sequence;
            }
        }
        context
    }
    impl Platform for Fake {
        fn call(&self, method: &str, input: Value) -> Result<Value, String> {
            match method {
                "syncIdentity" => {
                    let mut result = serde_json::to_value(&self.id).unwrap();
                    result["noisePrivate"] = json!(self.private);
                    Ok(result)
                }
                "syncSign" => {
                    let signature: Signature = self.key.sign(&decode(text(&input, "bytes")?)?);
                    Ok(json!({"signature":hex::encode(signature.to_der().as_bytes())}))
                }
                "syncLoad" => Ok(json!({"state":self.db.lock().unwrap().state})),
                "syncSave" => {
                    self.db.lock().unwrap().state = Some(input["state"].clone());
                    Ok(json!({}))
                }
                "syncSummary" => {
                    self.summary_calls.fetch_add(1, Ordering::SeqCst);
                    Ok(json!({"thoughts":1,"tags":0,"attachments":0,"attachmentBytes":0}))
                }
                "syncEnrollmentTags" => Ok(json!({"tags":[]})),
                "syncCoalesceTags" => Ok(json!({})),
                "syncEnroll" => {
                    let mut db = self.db.lock().unwrap();
                    if db
                        .group
                        .as_deref()
                        .is_some_and(|g| g != input["groupId"].as_str().unwrap())
                    {
                        return Err("Wrong library".into());
                    }
                    let first = db.group.is_none();
                    db.group = Some(text(&input, "groupId")?.into());
                    drop(db);
                    if first {
                        self.append(json!({"id":format!("thought-{}",self.id.device_id),"text":format!("Independent writing {}",self.id.device_id),"attachments":[]}));
                    }
                    Ok(json!({}))
                }
                "syncReceipts" => {
                    Ok(json!({"receipts":receipts(&self.db.lock().unwrap().operations)}))
                }
                "syncHeader" => {
                    let db = self.db.lock().unwrap();
                    let row = db
                        .operations
                        .iter()
                        .find(|r| {
                            r.header.revision.dot.origin == input["origin"]
                                && r.header.revision.dot.sequence == input["sequence"]
                        })
                        .ok_or("Missing header")?;
                    Ok(json!({"hash":wire::hash(&wire::canonical(&row.header)?)}))
                }
                "syncExport" => {
                    let after: Context = serde_json::from_value(input["after"].clone())
                        .map_err(|e| e.to_string())?;
                    let db = self.db.lock().unwrap();
                    let rows: Vec<_> = db
                        .operations
                        .iter()
                        .filter(|r| {
                            r.header.revision.dot.sequence
                                > after
                                    .get(&r.header.revision.dot.origin)
                                    .copied()
                                    .unwrap_or(0)
                        })
                        .collect();
                    Ok(
                        json!({"envelopes":rows.iter().take(32).collect::<Vec<_>>(),"more":rows.len()>32,"purgeProofs":[]}),
                    )
                }
                "syncApply" => {
                    let rows: Vec<Envelope> = serde_json::from_value(input["envelopes"].clone())
                        .map_err(|e| e.to_string())?;
                    let members: Vec<Identity> = serde_json::from_value(input["members"].clone())
                        .map_err(|e| e.to_string())?;
                    let mut db = self.db.lock().unwrap();
                    for row in rows {
                        let key = &members
                            .iter()
                            .find(|m| m.device_id == row.header.revision.dot.origin)
                            .ok_or("Unknown origin")?
                            .signing_public;
                        wire::verify(
                            &row,
                            input["groupId"].as_str().unwrap(),
                            &decode(key)?,
                            false,
                        )?;
                        if let Some(old) = db
                            .operations
                            .iter()
                            .find(|r| r.header.revision.dot == row.header.revision.dot)
                        {
                            if wire::canonical(&old.header)? != wire::canonical(&row.header)? {
                                return Err("Equivocation".into());
                            }
                            continue;
                        }
                        if let Some(payload) = &row.payload {
                            for media in payload["attachments"]
                                .as_array()
                                .cloned()
                                .unwrap_or_default()
                            {
                                let id = text(&media, "id")?;
                                if !db.originals.contains_key(id) {
                                    db.wanted.insert(id.into(), media);
                                }
                            }
                        }
                        db.operations.push(row);
                    }
                    Ok(json!({"receipts":receipts(&db.operations)}))
                }
                "syncMissingMedia" => {
                    let db = self.db.lock().unwrap();
                    let rows:Vec<_>=db.wanted.iter().take(1).map(|(id,metadata)|json!({"id":id,"checksum":metadata["checksum"],"size":metadata["size"],"offset":db.staging.get(id).map(Vec::len).unwrap_or(0),"metadata":metadata})).collect();
                    Ok(json!({"items":rows}))
                }
                "syncReadMedia" => {
                    let db = self.db.lock().unwrap();
                    let bytes = db
                        .originals
                        .get(text(&input, "id")?)
                        .ok_or("Original absent")?;
                    let offset = input["offset"].as_u64().unwrap() as usize;
                    if offset > bytes.len() {
                        return Err("Invalid offset".into());
                    }
                    let end =
                        (offset + input["maxBytes"].as_u64().unwrap() as usize).min(bytes.len());
                    Ok(json!({"bytes":hex::encode(&bytes[offset..end]),"eof":end==bytes.len()}))
                }
                "syncWriteMedia" => {
                    let mut db = self.db.lock().unwrap();
                    let id = text(&input, "id")?.to_string();
                    let bytes = decode(text(&input, "bytes")?)?;
                    let staging = db.staging.entry(id.clone()).or_default();
                    if staging.len() as u64 != input["offset"].as_u64().unwrap() {
                        return Err("Unexpected offset".into());
                    }
                    staging.extend(bytes);
                    let offset = staging.len();
                    let complete = offset as u64 == input["size"].as_u64().unwrap();
                    if complete {
                        if wire::hash(staging) != input["checksum"] {
                            return Err("Checksum mismatch".into());
                        }
                        let bytes = db.staging.remove(&id).unwrap();
                        db.originals.insert(id.clone(), bytes);
                        db.wanted.remove(&id);
                    }
                    Ok(json!({"offset":offset,"complete":complete}))
                }
                _ => Err(format!("Unknown fake platform method {method}")),
            }
        }
    }
    fn until(mut predicate: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(12);
        while !predicate() {
            assert!(
                Instant::now() < deadline,
                "Timed out waiting for coordinator"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn pair(a: &Arc<Coordinator>, b: &Arc<Coordinator>) {
        let address = b.public_state().unwrap()["address"]
            .as_str()
            .unwrap()
            .to_string();
        a.command("linkDevice", json!({"address":address})).unwrap();
        until(|| {
            a.public_state().unwrap()["pairing"].is_object()
                && b.public_state().unwrap()["pairing"].is_object()
        });
        let first = a.public_state().unwrap();
        let second = b.public_state().unwrap();
        assert_eq!(first["pairing"]["code"], second["pairing"]["code"]);
        let aid = first["pairing"]["sessionId"].clone();
        let bid = second["pairing"]["sessionId"].clone();
        a.command("confirmPairing", json!({"sessionId":aid,"confirmed":true}))
            .unwrap();
        b.command("confirmPairing", json!({"sessionId":bid,"confirmed":true}))
            .unwrap();
        until(|| {
            a.public_state().unwrap()["pairing"]["summary"].is_object()
                && b.public_state().unwrap()["pairing"]["summary"].is_object()
        });
        a.command("acceptEnrollment", json!({"sessionId":aid,"accepted":true}))
            .unwrap();
        b.command("acceptEnrollment", json!({"sessionId":bid,"accepted":true}))
            .unwrap();
        until(|| {
            !a.public_state().unwrap()["pairing"].is_object()
                && !b.public_state().unwrap()["pairing"].is_object()
        });
    }
    #[test]
    fn localhost_pairing_gates_content_then_three_peers_forward_signed_operations_and_originals() {
        let fa = Fake::new("a", 1);
        let fb = Fake::new("b", 2);
        let fc = Fake::new("c", 3);
        let a = Coordinator::new(fa.clone()).unwrap();
        let b = Coordinator::new(fb.clone()).unwrap();
        let c = Coordinator::new(fc.clone()).unwrap();
        a.start("127.0.0.1:0").unwrap();
        b.start("127.0.0.1:0").unwrap();
        c.start("127.0.0.1:0").unwrap();
        pair(&a, &b);
        until(|| {
            fa.db.lock().unwrap().operations.len() == 2
                && fb.db.lock().unwrap().operations.len() == 2
        });
        let original = vec![42; 120_000];
        let checksum = wire::hash(&original);
        fa.db
            .lock()
            .unwrap()
            .originals
            .insert("photo".into(), original.clone());
        // Text over the record bound proves encrypted logical-message fragmentation.
        fa.append(json!({"id":"large","text":"long text ".repeat(10_000),"attachments":[{"id":"photo","checksum":checksum,"size":original.len()}]}));
        a.command("syncNow", json!({})).unwrap();
        until(|| fb.db.lock().unwrap().originals.get("photo") == Some(&original));
        pair(&c, &b);
        until(|| {
            fc.db.lock().unwrap().operations.len() == 4
                && fc.db.lock().unwrap().originals.get("photo") == Some(&original)
        });
        a.command("syncNow", json!({})).unwrap();
        until(|| fa.db.lock().unwrap().operations.len() == 4);
        let ids = |fake: &Fake| {
            fake.db
                .lock()
                .unwrap()
                .operations
                .iter()
                .map(|r| r.header.revision.id())
                .collect::<BTreeSet<_>>()
        };
        assert_eq!(ids(&fa), ids(&fb));
        assert_eq!(ids(&fb), ids(&fc));
        assert_eq!(
            a.public_state().unwrap()["devices"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        a.stop();
        b.stop();
        c.stop();
    }
    #[test]
    fn local_commit_notifications_deliver_both_directions_without_the_poll_timer() {
        let fa = Fake::new("instant-a", 31);
        let fb = Fake::new("instant-b", 32);
        let a = Coordinator::new(fa.clone()).unwrap();
        let b = Coordinator::new(fb.clone()).unwrap();
        a.start("127.0.0.1:0").unwrap(); b.start("127.0.0.1:0").unwrap();
        pair(&a, &b);
        until(|| a.connections.load(Ordering::SeqCst) == 0 && b.connections.load(Ordering::SeqCst) == 0);
        for (sender, source, target, id) in [(&a, &fa, &fb, "instant-write"), (&b, &fb, &fa, "instant-edit")] {
            source.append(json!({"id":id,"text":"Committed after the initial session finished"}));
            let start = Instant::now();
            sender.command("localDataChanged", json!({})).unwrap();
            until(|| target.db.lock().unwrap().operations.iter().any(|e| e.header.revision.entity_id == id));
            assert!(start.elapsed() < Duration::from_secs(2), "A native commit waited for periodic polling: {:?}", start.elapsed());
            println!("Native commit {id} replicated in {:?}", start.elapsed());
            until(|| a.connections.load(Ordering::SeqCst) == 0 && b.connections.load(Ordering::SeqCst) == 0);
        }
        let start = Instant::now();
        for index in 0..20 {
            fa.append(json!({"id":format!("burst-{index}"),"text":"Rapid native commits coalesce"}));
            a.local_data_changed().unwrap();
            assert!(a.connections.load(Ordering::SeqCst) <= 2, "Rapid commits opened duplicate peer sessions");
        }
        until(|| fb.db.lock().unwrap().operations.iter().filter(|e| e.header.revision.entity_id.starts_with("burst-")).count() == 20);
        assert!(start.elapsed() < Duration::from_secs(2));
        until(|| a.connections.load(Ordering::SeqCst) == 0 && b.connections.load(Ordering::SeqCst) == 0);
        a.stop(); b.stop();
        fa.append(json!({"id":"after-stop","text":"Local-only after stop"}));
        a.local_data_changed().unwrap();
        assert_eq!(a.connections.load(Ordering::SeqCst), 0);
        assert!(!fb.db.lock().unwrap().operations.iter().any(|e| e.header.revision.entity_id == "after-stop"));
    }
    #[test]
    fn a_commit_during_original_transfer_wakes_a_follow_up_without_polling() {
        struct PausedOriginal {
            base: Arc<Fake>, armed: AtomicBool,
            entered: std::sync::mpsc::Sender<()>,
            release: Mutex<std::sync::mpsc::Receiver<()>>,
        }
        impl Platform for PausedOriginal {
            fn call(&self, method: &str, input: Value) -> Result<Value, String> {
                if method == "syncReadMedia" && self.armed.swap(false, Ordering::SeqCst) {
                    self.entered.send(()).unwrap();
                    self.release.lock().unwrap().recv_timeout(Duration::from_secs(3)).unwrap();
                }
                self.base.call(method, input)
            }
        }
        let fa = Fake::new("busy-a", 33); let fb = Fake::new("busy-b", 34);
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let paused = Arc::new(PausedOriginal { base: fa.clone(), armed: AtomicBool::new(false), entered: entered_tx, release: Mutex::new(release_rx) });
        let a = Coordinator::new(paused.clone()).unwrap(); let b = Coordinator::new(fb.clone()).unwrap();
        a.start("127.0.0.1:0").unwrap(); b.start("127.0.0.1:0").unwrap(); pair(&a, &b);
        until(|| a.connections.load(Ordering::SeqCst) == 0 && b.connections.load(Ordering::SeqCst) == 0);
        let original = vec![42; 120_000]; let checksum = wire::hash(&original);
        fa.db.lock().unwrap().originals.insert("busy-photo".into(), original.clone());
        fa.append(json!({"id":"photo-post","text":"Original is transferring","attachments":[{"id":"busy-photo","checksum":checksum,"size":original.len()}]}));
        paused.armed.store(true, Ordering::SeqCst); a.local_data_changed().unwrap();
        entered_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        fa.append(json!({"id":"during-transfer","text":"This edit must take priority over remaining original chunks"}));
        let start = Instant::now(); a.local_data_changed().unwrap(); release_tx.send(()).unwrap();
        until(|| fb.db.lock().unwrap().operations.iter().any(|e| e.header.revision.entity_id == "during-transfer"));
        assert!(start.elapsed() < Duration::from_secs(2), "An active original delayed a later edit: {:?}", start.elapsed());
        until(|| fb.db.lock().unwrap().originals.get("busy-photo") == Some(&original));
        a.stop(); b.stop();
    }
    #[test]
    fn discovery_reconnects_only_pinned_peers_promptly_after_their_ports_change() {
        let fa = Fake::new("reopen-a", 35); let fb = Fake::new("reopen-b", 36);
        let a = Coordinator::new(fa.clone()).unwrap(); let b = Coordinator::new(fb.clone()).unwrap();
        a.start("127.0.0.1:0").unwrap(); b.start("127.0.0.1:0").unwrap(); pair(&a, &b);
        until(|| a.connections.load(Ordering::SeqCst) == 0 && b.connections.load(Ordering::SeqCst) == 0);
        let original_address = b.public_state().unwrap()["address"].clone();
        a.command("discoveryHint", json!({"deviceId":"untrusted-hint","address":original_address,"name":"Fake nearby name"})).unwrap();
        assert_eq!(a.connections.load(Ordering::SeqCst), 0);
        a.stop(); b.stop();
        let a = Coordinator::new(fa.clone()).unwrap(); let b = Coordinator::new(fb.clone()).unwrap();
        a.start("127.0.0.1:0").unwrap(); b.start("127.0.0.1:0").unwrap();
        until(|| a.connections.load(Ordering::SeqCst) == 0 && b.connections.load(Ordering::SeqCst) == 0);
        fa.append(json!({"id":"after-reopen","text":"A cold-open edit"}));
        let address = b.public_state().unwrap()["address"].clone();
        let start = Instant::now();
        a.command("discoveryHint", json!({"deviceId":fb.id.device_id,"address":address,"name":fb.id.name})).unwrap();
        until(|| fb.db.lock().unwrap().operations.iter().any(|e| e.header.revision.entity_id == "after-reopen"));
        assert!(start.elapsed() < Duration::from_secs(2));
        a.stop(); b.stop();
    }
    #[test]
    fn simultaneous_local_writes_finish_without_waiting_for_the_poll_timer() {
        let fa = Fake::new("simultaneous-a", 37); let fb = Fake::new("simultaneous-b", 38);
        let a = Coordinator::new(fa.clone()).unwrap(); let b = Coordinator::new(fb.clone()).unwrap();
        a.start("127.0.0.1:0").unwrap(); b.start("127.0.0.1:0").unwrap(); pair(&a, &b);
        for i in 0..20 {
            until(|| a.connections.load(Ordering::SeqCst) == 0 && b.connections.load(Ordering::SeqCst) == 0);
            let aid = format!("simultaneous-a-{i}"); let bid = format!("simultaneous-b-{i}");
            fa.append(json!({"id":aid,"text":"Simultaneous A"}));
            fb.append(json!({"id":bid,"text":"Simultaneous B"}));
            let barrier = Arc::new(std::sync::Barrier::new(3));
            let first = { let owner = a.clone(); let barrier = barrier.clone(); thread::spawn(move || { barrier.wait(); owner.local_data_changed().unwrap(); }) };
            let second = { let owner = b.clone(); let barrier = barrier.clone(); thread::spawn(move || { barrier.wait(); owner.local_data_changed().unwrap(); }) };
            let start = Instant::now(); barrier.wait(); first.join().unwrap(); second.join().unwrap();
            until(|| fa.db.lock().unwrap().operations.iter().any(|e| e.header.revision.entity_id == bid)
                && fb.db.lock().unwrap().operations.iter().any(|e| e.header.revision.entity_id == aid));
            assert!(start.elapsed() < Duration::from_secs(2), "Simultaneous writes waited {:?}", start.elapsed());
        }
        a.stop(); b.stop();
    }
    #[test]
    fn quarantined_local_writes_consume_the_wake_without_a_retry_loop() {
        let (a, b, mut p) = membership_fixture();
        let first = a.make_control(&p, "remove", json!({"subject":b.identity.device_id,"witnesses":[a.identity.device_id]})).unwrap();
        let second = b.make_control(&p, "remove", json!({"subject":a.identity.device_id,"witnesses":[b.identity.device_id]})).unwrap();
        p.controls.extend([first, second]);
        assert!(membership_view(&p.controls).unwrap().quarantined);
        a.state.lock().unwrap().persistent = p;
        a.start("127.0.0.1:0").unwrap();
        assert!(a.local_data_changed().unwrap_err().contains("conflicting device-removal"));
        assert!(!a.state.lock().unwrap().runtime.sync_again);
        assert_eq!(a.connections.load(Ordering::SeqCst), 0);
        a.stop();
    }
    #[test]
    fn a_write_during_the_opposite_dial_teardown_keeps_its_follow_up() {
        let first = Fake::new("tail-first", 39); let second = Fake::new("tail-second", 40);
        let (writer, other) = if first.id.device_id > second.id.device_id { (first, second) } else { (second, first) };
        let a = Coordinator::new(writer.clone()).unwrap(); let b = Coordinator::new(other.clone()).unwrap();
        a.start("127.0.0.1:0").unwrap(); b.start("127.0.0.1:0").unwrap(); pair(&a, &b);
        until(|| a.connections.load(Ordering::SeqCst) == 0 && b.connections.load(Ordering::SeqCst) == 0);
        // The opposite outbound has completed replication but its thread has
        // not released the dialing reservation yet. There is no winning
        // opposite channel available to carry the newly committed metadata.
        b.state.lock().unwrap().runtime.dialing.insert(writer.id.device_id.clone());
        b.connections.fetch_add(1, Ordering::SeqCst);
        writer.append(json!({"id":"opposite-tail","text":"Saved during peer teardown"}));
        let start = Instant::now();
        a.local_data_changed().unwrap();
        until(|| other.db.lock().unwrap().operations.iter().any(|e| e.header.revision.entity_id == "opposite-tail"));
        assert!(start.elapsed() < Duration::from_secs(2));
        // Keep the old thread's tail held: it must neither block a new save
        // nor create repeated handshakes while the opposite library is idle.
        thread::sleep(Duration::from_secs(1));
        assert_eq!(a.connections.load(Ordering::SeqCst), 0);
        assert!(!a.state.lock().unwrap().runtime.sync_again);
        b.connection_finished(Some(&writer.id.device_id));
        until(|| a.connections.load(Ordering::SeqCst) == 0 && b.connections.load(Ordering::SeqCst) == 0);
        assert!(!a.state.lock().unwrap().runtime.sync_again);
        assert!(!b.state.lock().unwrap().runtime.sync_again);
        a.stop(); b.stop();
    }
    #[test]
    fn cancelled_matching_code_exposes_no_summary_or_library_content() {
        let fa = Fake::new("deny-a", 4);
        let fb = Fake::new("deny-b", 5);
        let a = Coordinator::new(fa.clone()).unwrap();
        let b = Coordinator::new(fb.clone()).unwrap();
        a.start("127.0.0.1:0").unwrap();
        b.start("127.0.0.1:0").unwrap();
        a.command(
            "linkDevice",
            json!({"address":b.public_state().unwrap()["address"]}),
        )
        .unwrap();
        until(|| {
            a.public_state().unwrap()["pairing"].is_object()
                && b.public_state().unwrap()["pairing"].is_object()
        });
        let id = a.public_state().unwrap()["pairing"]["sessionId"].clone();
        a.command("confirmPairing", json!({"sessionId":id,"confirmed":true}))
            .unwrap();
        thread::sleep(Duration::from_millis(300));
        assert_eq!(fa.summary_calls.load(Ordering::SeqCst), 0);
        assert_eq!(fb.summary_calls.load(Ordering::SeqCst), 0);
        let id = b.public_state().unwrap()["pairing"]["sessionId"].clone();
        b.command("confirmPairing", json!({"sessionId":id,"confirmed":false}))
            .unwrap();
        until(|| !a.public_state().unwrap()["pairing"].is_object());
        assert!(fa.db.lock().unwrap().operations.is_empty());
        assert!(fb.db.lock().unwrap().operations.is_empty());
        a.stop();
        b.stop();
    }
    #[test]
    fn only_literal_local_endpoints_are_allowed() {
        assert!(parse_address("example.com:443").is_err());
        assert!(parse_address("8.8.8.8:443").is_err());
        assert!(parse_address("192.168.1.10:45821").is_ok());
        assert!(parse_address("[::1]:45821").is_ok());
    }
    #[test]
    fn discovery_prefers_usable_ipv4_over_scoped_link_local_candidates() {
        let candidates = discovery_endpoints(
            [
                "fe80::1234".parse().unwrap(),
                "192.168.1.9".parse().unwrap(),
            ],
            45821,
        );
        assert_eq!(candidates.first().unwrap(), "192.168.1.9:45821");
        assert!(candidates
            .iter()
            .filter(|a| a.starts_with("[fe80:"))
            .all(|a| a.contains('%')));
        assert_eq!(
            normalize_address("[::ffff:192.168.1.9]:45821".parse().unwrap()).to_string(),
            "192.168.1.9:45821"
        );
    }
    #[test]
    fn stopping_fences_a_blocked_callback_before_a_new_coordinator_loads_state() {
        struct Blocking {
            fake: Arc<Fake>,
            entered: AtomicBool,
            released: AtomicBool,
            once: AtomicBool,
        }
        impl Platform for Blocking {
            fn call(&self, method: &str, input: Value) -> Result<Value, String> {
                if method == "syncSave" && self.once.swap(false, Ordering::SeqCst) {
                    self.entered.store(true, Ordering::SeqCst);
                    while !self.released.load(Ordering::SeqCst) {
                        thread::sleep(Duration::from_millis(10));
                    }
                }
                self.fake.call(method, input)
            }
        }
        let fake = Fake::new("lifecycle", 8);
        let platform = Arc::new(Blocking {
            fake: fake.clone(),
            entered: AtomicBool::new(false),
            released: AtomicBool::new(false),
            once: AtomicBool::new(true),
        });
        let old = Coordinator::new(platform.clone()).unwrap();
        let writing = old.clone();
        let callback = thread::spawn(move || {
            writing.platform_call("syncSave", json!({"state":Persistent::default()}))
        });
        until(|| platform.entered.load(Ordering::SeqCst));
        let stopping = old.clone();
        let stopped = Arc::new(AtomicBool::new(false));
        let finished = stopped.clone();
        let stop = thread::spawn(move || {
            stopping.stop();
            finished.store(true, Ordering::SeqCst);
        });
        thread::sleep(Duration::from_millis(30));
        assert!(!stopped.load(Ordering::SeqCst));
        platform.released.store(true, Ordering::SeqCst);
        callback.join().unwrap().unwrap();
        stop.join().unwrap();
        let fresh = Coordinator::new(platform.clone()).unwrap();
        let mut next = Persistent::default();
        next.addresses
            .insert("current".into(), "127.0.0.1:42".into());
        fresh
            .platform_call("syncSave", json!({"state":next}))
            .unwrap();
        assert!(old
            .platform_call("syncSave", json!({"state":Persistent::default()}))
            .is_err());
        assert_eq!(
            fake.db.lock().unwrap().state.as_ref().unwrap()["addresses"]["current"],
            "127.0.0.1:42"
        );
        fresh.stop();
    }
    #[test]
    fn missing_original_on_one_peer_does_not_desynchronize_the_session() {
        let fa = Fake::new("missing-a", 9);
        let fb = Fake::new("missing-b", 10);
        let a = Coordinator::new(fa.clone()).unwrap();
        let b = Coordinator::new(fb.clone()).unwrap();
        a.start("127.0.0.1:0").unwrap();
        b.start("127.0.0.1:0").unwrap();
        pair(&a, &b);
        until(|| {
            fa.db.lock().unwrap().operations.len() == 2
                && fb.db.lock().unwrap().operations.len() == 2
        });
        fa.append(json!({"id":"missing-original","text":"Metadata remains usable","attachments":[{"id":"absent","checksum":wire::hash(b"absent"),"size":6}]}));
        a.command("syncNow", json!({})).unwrap();
        until(|| {
            fb.db.lock().unwrap().operations.len() == 3
                && b.public_state().unwrap()["attachmentsPending"] == 1
        });
        until(|| {
            a.public_state().unwrap()["phase"] == "idle"
                && b.public_state().unwrap()["phase"] == "idle"
        });
        assert!(a.public_state().unwrap()["lastError"].is_null());
        assert!(b.public_state().unwrap()["lastError"].is_null());
        a.stop();
        b.stop();
    }
    fn membership_fixture() -> (Arc<Coordinator>, Arc<Coordinator>, Persistent) {
        let a = Coordinator::new(Fake::new("member-a", 11)).unwrap();
        let b = Coordinator::new(Fake::new("member-b", 12)).unwrap();
        let mut p = Persistent {
            group_id: Some("fixture-group".into()),
            ..Default::default()
        };
        p.controls.push(
            a.make_control(&p, "genesis", serde_json::to_value(&a.identity).unwrap())
                .unwrap(),
        );
        p.controls.push(
            a.make_control(&p, "admit", serde_json::to_value(&b.identity).unwrap())
                .unwrap(),
        );
        (a, b, p)
    }
    #[test]
    fn removal_fences_inflight_callbacks_then_denies_saved_data_and_forwarded_operations() {
        let (a, b, p) = membership_fixture();
        a.state.lock().unwrap().persistent = p;
        let peer = b.identity.clone();
        let entered = Arc::new(std::sync::Barrier::new(2));
        let release = Arc::new(std::sync::Barrier::new(2));
        let worker = {
            let owner = a.clone();
            let peer = peer.clone();
            let entered = entered.clone();
            let release = release.clone();
            thread::spawn(move || {
                owner.with_session_authority(&peer, true, || {
                    entered.wait();
                    release.wait();
                    Ok(())
                })
            })
        };
        entered.wait();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let remover = {
            let owner = a.clone();
            let id = peer.device_id.clone();
            thread::spawn(move || {
                owner.remove(&id).unwrap();
                done_tx.send(()).unwrap();
            })
        };
        assert!(done_rx.recv_timeout(Duration::from_millis(50)).is_err());
        release.wait();
        worker.join().unwrap().unwrap();
        done_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        remover.join().unwrap();
        let invoked = AtomicUsize::new(0);
        assert!(a
            .with_session_authority(&peer, true, || {
                invoked.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .is_err());
        assert_eq!(invoked.load(Ordering::SeqCst), 0);
        for method in [
            "syncExport",
            "syncReadMedia",
            "syncWriteMedia",
            "syncCoalesceTags",
        ] {
            assert!(a
                .session_call(&peer, true, method, json!({}))
                .unwrap_err()
                .contains("removed"));
        }
        // Even envelopes signed by a still-active third-party origin cannot be forwarded
        // through the revoked session; its identity is checked before origin validation.
        assert!(a
            .receive_operations(&peer, "fixture-group", &json!({"envelopes":[]}))
            .unwrap_err()
            .contains("removed"));
        assert!(a
            .session_call(&peer, false, "syncSummary", json!({}))
            .unwrap_err()
            .contains("removed"));
    }
    #[test]
    fn each_outgoing_record_rechecks_membership_after_removal() {
        let (a, b, p) = membership_fixture();
        a.state.lock().unwrap().persistent = p;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let stream = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut receiver, _) = listener.accept().unwrap();
        receiver
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        let mut first = transport::handshake(true, &[1; 32], b"record-test").unwrap();
        let mut second = transport::handshake(false, &[2; 32], b"record-test").unwrap();
        let mut bytes = [0; 1024];
        let mut output = [0; 1024];
        let n = first.write_message(&[], &mut bytes).unwrap();
        second.read_message(&bytes[..n], &mut output).unwrap();
        let n = second.write_message(&[], &mut bytes).unwrap();
        first.read_message(&bytes[..n], &mut output).unwrap();
        let n = first.write_message(&[], &mut bytes).unwrap();
        second.read_message(&bytes[..n], &mut output).unwrap();
        let mut channel = Channel {
            stream,
            noise: first.into_transport_mode().unwrap(),
            initiator: true,
            authorization: Some((a.clone(), b.identity.clone(), true)),
        };
        channel.write(b"already-authorized record").unwrap();
        assert_eq!(
            read_frame(&mut receiver).unwrap(),
            b"already-authorized record"
        );
        a.remove(&b.identity.device_id).unwrap();
        assert!(channel
            .write(b"new secret fragment")
            .unwrap_err()
            .contains("removed"));
        assert!(read_frame(&mut receiver).is_err());
    }
    #[test]
    fn concurrent_mutual_removals_are_permanent_and_quarantined_in_both_orders() {
        let (a, b, p) = membership_fixture();
        let left = a
            .make_control(
                &p,
                "remove",
                json!({"subject":b.identity.device_id,"witnesses":[a.identity.device_id]}),
            )
            .unwrap();
        let right = b
            .make_control(
                &p,
                "remove",
                json!({"subject":a.identity.device_id,"witnesses":[b.identity.device_id]}),
            )
            .unwrap();
        for suffix in [
            vec![left.clone(), right.clone()],
            vec![right.clone(), left.clone()],
        ] {
            let mut controls = p.controls.clone();
            controls.extend(suffix);
            a.validate_controls(&controls, Some("fixture-group"))
                .unwrap();
            let view = membership_view(&controls).unwrap();
            assert!(view.active.is_empty());
            assert!(view.quarantined);
            assert_eq!(view.removals.len(), 2);
            let mut persisted = p.clone();
            persisted.controls = controls;
            a.platform_call("syncSave", json!({"state":persisted}))
                .unwrap();
            let restarted = Coordinator::new(a.platform.clone()).unwrap();
            assert_eq!(restarted.public_state().unwrap()["phase"], "error");
            assert!(restarted
                .platform_call("syncApply", json!({}))
                .unwrap_err()
                .contains("conflicting device-removal"));
            restarted.stop();
        }
    }
    #[test]
    fn a_revoked_key_claiming_old_parents_cannot_admit_or_restore_any_identity() {
        let (a, b, p) = membership_fixture();
        let other = Fake::new("unadmitted", 13);
        let stale = b
            .make_control(&p, "admit", serde_json::to_value(&other.id).unwrap())
            .unwrap();
        let removal = a
            .make_control(
                &p,
                "remove",
                json!({"subject":b.identity.device_id,"witnesses":[a.identity.device_id]}),
            )
            .unwrap();
        let mut controls = p.controls.clone();
        controls.extend([stale, removal]);
        a.validate_controls(&controls, Some("fixture-group"))
            .unwrap();
        let view = membership_view(&controls).unwrap();
        assert!(!view.active.contains_key(&b.identity.device_id));
        assert!(!view.active.contains_key(&other.id.device_id));
        assert!(view.active.contains_key(&a.identity.device_id));
        let stale_removal = b
            .make_control(
                &p,
                "remove",
                json!({"subject":a.identity.device_id,"witnesses":[b.identity.device_id]}),
            )
            .unwrap();
        controls.push(stale_removal);
        let view = membership_view(&controls).unwrap();
        assert!(view.quarantined);
        assert!(!view.active.contains_key(&a.identity.device_id));
        assert!(!view.active.contains_key(&b.identity.device_id));
        assert!(!view.active.contains_key(&other.id.device_id));
        a.merge_controls(controls, "fixture-group").unwrap();
        let public = a.public_state().unwrap();
        assert_eq!(public["enabled"], false);
        assert_eq!(public["phase"], "error");
        assert!(public["lastError"].as_str().unwrap().contains("backup"));
        for method in [
            "syncExport",
            "syncApply",
            "syncReadMedia",
            "syncWriteMedia",
            "syncCoalesceTags",
        ] {
            assert!(a
                .platform_call(method, json!({}))
                .unwrap_err()
                .contains("conflicting device-removal"));
        }
    }
    #[test]
    fn control_replay_is_idempotent_but_altered_body_or_signature_is_rejected() {
        let (a, _b, p) = membership_fixture();
        let mut replay = p.controls.clone();
        replay.push(p.controls[0].clone());
        a.validate_controls(&replay, Some("fixture-group")).unwrap();
        let mut changed = p.controls.clone();
        changed[0].body.data["name"] = json!("Altered identity");
        assert!(a
            .validate_controls(&changed, Some("fixture-group"))
            .is_err());
        let mut forged = p.controls.clone();
        forged[0].signature = "00".into();
        assert!(a.validate_controls(&forged, Some("fixture-group")).is_err());
    }
}

#[derive(Default)]
struct Membership {
    active: BTreeMap<String, Identity>,
    all: BTreeMap<String, Identity>,
    removals: BTreeMap<String, Removal>,
    authorized: BTreeMap<String, u64>,
    anchors: BTreeMap<String, Checkpoint>,
    quarantined: bool,
}
fn ancestors(controls: &[Control], heads: &[String]) -> Vec<Control> {
    let mut wanted: BTreeSet<_> = heads.iter().cloned().collect();
    loop {
        let before = wanted.len();
        for control in controls {
            if wanted.contains(&control.id) {
                wanted.extend(control.body.parents.iter().cloned());
            }
        }
        if wanted.len() == before {
            break;
        }
    }
    controls
        .iter()
        .filter(|c| wanted.contains(&c.id))
        .cloned()
        .collect()
}
fn membership_view(controls: &[Control]) -> Result<Membership, String> {
    let mut view = Membership::default();
    // Membership records are immutable. Removed issuers cannot authorize unknown descendants;
    // an admission they issued is retained only if the removal explicitly observed it.
    let mut removed_by: BTreeMap<String, Vec<&Control>> = BTreeMap::new();
    for control in controls {
        if control.body.kind == "remove" {
            let subject = text(&control.body.data, "subject")?.to_string();
            removed_by.entry(subject).or_default().push(control);
        }
    }
    let eligible = |control: &Control| {
        removed_by
            .get(&control.body.issuer)
            .map(|removals| {
                removals.iter().all(|r| {
                    ancestors(controls, &r.body.parents)
                        .iter()
                        .any(|c| c.id == control.id)
                })
            })
            .unwrap_or(true)
    };
    for control in controls {
        match control.body.kind.as_str() {
            "genesis" | "admit" => {
                let identity: Identity =
                    serde_json::from_value(control.body.data.clone()).map_err(|e| e.to_string())?;
                view.all
                    .insert(identity.device_id.clone(), identity.clone());
                if control.body.kind == "genesis" || eligible(control) {
                    view.active.insert(identity.device_id.clone(), identity);
                }
            }
            // Revocation is a monotonic tombstone. A later/concurrent removal of its issuer
            // must never undo this removal and grant the subject access again.
            "remove" => {
                let subject = text(&control.body.data, "subject")?.to_string();
                let witnesses = serde_json::from_value(control.body.data["witnesses"].clone())
                    .map_err(|e| e.to_string())?;
                view.removals.insert(
                    control.id.clone(),
                    Removal {
                        id: control.id.clone(),
                        subject,
                        witnesses,
                    },
                );
                if !eligible(control) {
                    view.quarantined = true;
                }
            }
            _ => {}
        }
    }
    for removal in view.removals.values() {
        view.active.remove(&removal.subject);
    }
    for removal in view.removals.values() {
        let checkpoints: Vec<Checkpoint> = controls
            .iter()
            .filter(|c| {
                c.body.kind == "checkpoint" && eligible(c) && c.body.data["removalId"] == removal.id
            })
            .map(|c| serde_json::from_value(c.body.data.clone()).map_err(|e| e.to_string()))
            .collect::<Result<_, _>>()?;
        let anchor = authorized_history(removal, &checkpoints)?;
        let limit = anchor.as_ref().map(|c| c.through).unwrap_or(0);
        view.authorized
            .entry(removal.subject.clone())
            .and_modify(|n| *n = (*n).max(limit))
            .or_insert(limit);
        if let Some(anchor) = anchor {
            if view
                .anchors
                .get(&removal.subject)
                .is_none_or(|old| anchor.through > old.through)
            {
                view.anchors.insert(removal.subject.clone(), anchor);
            }
        }
    }
    Ok(view)
}

fn parse_address(address: &str) -> Result<SocketAddr, String> {
    // Literal IP addresses avoid DNS rebinding and arbitrary internet destinations. Discovery
    // may change hints, but cannot change the pinned identity during Noise authentication.
    let address: SocketAddr = normalize_address(
        address
            .parse()
            .map_err(|_| "Enter an IP address and port, such as 192.168.1.4:45821")?,
    );
    let local = match address.ip() {
        IpAddr::V4(ip) => ip.is_private() || ip.is_loopback() || ip.is_link_local(),
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || (ip.segments()[0] & 0xfe00) == 0xfc00
                || (ip.segments()[0] & 0xffc0) == 0xfe80
                || if_addrs::get_if_addrs()
                    .unwrap_or_default()
                    .iter()
                    .any(|interface| match interface.addr {
                        if_addrs::IfAddr::V6(ref local) => {
                            let mask = u128::from(local.netmask);
                            mask.count_ones() >= 64
                                && u128::from(ip) & mask == u128::from(local.ip) & mask
                        }
                        _ => false,
                    })
        }
    };
    if !local || address.port() == 0 {
        return Err("Only local network addresses can be linked".into());
    }
    Ok(address)
}
fn normalize_address(address: SocketAddr) -> SocketAddr {
    match address {
        SocketAddr::V6(v6) => v6
            .ip()
            .to_ipv4_mapped()
            .map(|ip| SocketAddr::new(IpAddr::V4(ip), v6.port()))
            .unwrap_or(address),
        _ => address,
    }
}

fn bind_network_socket(coordinator: &Coordinator, socket: &socket2::Socket) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        use std::os::fd::AsRawFd;
        coordinator.platform_call("syncBindSocket", json!({"fd":socket.as_raw_fd()}))?;
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (coordinator, socket);
    }
    Ok(())
}
fn bind_listener(bind: &str, coordinator: &Coordinator) -> std::io::Result<TcpListener> {
    if bind == "0.0.0.0:0" || bind == "[::]:0" {
        // Use one dual-stack port where supported; retain IPv4 fallback on restricted hosts.
        if let Ok(socket) = socket2::Socket::new(
            socket2::Domain::IPV6,
            socket2::Type::STREAM,
            Some(socket2::Protocol::TCP),
        ) {
            let address: SocketAddr = "[::]:0".parse().unwrap();
            if socket
                .set_only_v6(false)
                .and_then(|_| {
                    bind_network_socket(coordinator, &socket).map_err(std::io::Error::other)
                })
                .and_then(|_| socket.bind(&address.into()))
                .and_then(|_| socket.listen(16))
                .is_ok()
            {
                return Ok(socket.into());
            }
        }
    }
    let address: SocketAddr = bind.parse().map_err(std::io::Error::other)?;
    let socket = socket2::Socket::new(
        if address.is_ipv4() {
            socket2::Domain::IPV4
        } else {
            socket2::Domain::IPV6
        },
        socket2::Type::STREAM,
        Some(socket2::Protocol::TCP),
    )?;
    bind_network_socket(coordinator, &socket).map_err(std::io::Error::other)?;
    socket.bind(&address.into())?;
    socket.listen(16)?;
    Ok(socket.into())
}
fn local_endpoints(listener: SocketAddr) -> Vec<String> {
    if !listener.ip().is_unspecified() {
        return vec![listener.to_string()];
    }
    let mut endpoints = Vec::new();
    for interface in if_addrs::get_if_addrs().unwrap_or_default() {
        if interface.is_loopback()
            || interface.ip().is_unspecified()
            || listener.is_ipv4() && interface.ip().is_ipv6()
        {
            continue;
        }
        let address = match interface.ip() {
            IpAddr::V6(ip) if interface.is_link_local() => SocketAddr::V6(SocketAddrV6::new(
                ip,
                listener.port(),
                0,
                interface.index.unwrap_or(0),
            )),
            ip => SocketAddr::new(ip, listener.port()),
        };
        if parse_address(&address.to_string()).is_ok() {
            endpoints.push(address.to_string());
        }
    }
    endpoints.sort_by_key(|endpoint| (endpoint.starts_with('['), endpoint.clone()));
    endpoints.dedup();
    endpoints
}
fn discovery_endpoints(ips: impl IntoIterator<Item = IpAddr>, port: u16) -> Vec<String> {
    let mut endpoints = Vec::new();
    for ip in ips {
        if let IpAddr::V6(v6) = ip {
            if v6.is_unicast_link_local() {
                // Older mDNS APIs omit the receiving interface. Keep scoped candidates after
                // usable IPv4/ULA/global-subnet endpoints; never invent a scope-zero fe80 route.
                for interface in if_addrs::get_if_addrs().unwrap_or_default() {
                    if interface.ip().is_ipv6() && !interface.is_loopback() {
                        if let Some(index) = interface.index {
                            endpoints.push(
                                SocketAddr::V6(SocketAddrV6::new(v6, port, 0, index)).to_string(),
                            );
                        }
                    }
                }
                continue;
            }
        }
        let endpoint = SocketAddr::new(ip, port).to_string();
        if parse_address(&endpoint).is_ok() {
            endpoints.push(endpoint);
        }
    }
    endpoints.sort_by_key(|endpoint| {
        (
            endpoint.starts_with("[fe80:"),
            endpoint.starts_with('['),
            endpoint.clone(),
        )
    });
    endpoints.dedup();
    endpoints
}

fn write_frame(stream: &mut TcpStream, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_RECORD_BYTES + 16 {
        return Err("Invalid frame size".into());
    }
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .and_then(|_| stream.write_all(bytes))
        .map_err(|e| format!("Local device connection interrupted: {e}"))
}
fn read_frame(stream: &mut TcpStream) -> Result<Vec<u8>, String> {
    let mut size = [0; 4];
    stream
        .read_exact(&mut size)
        .map_err(|e| format!("Local device connection interrupted: {e}"))?;
    let size = u32::from_be_bytes(size) as usize;
    if size == 0 || size > MAX_RECORD_BYTES + 16 {
        return Err("Peer sent an oversized frame".into());
    }
    let mut bytes = vec![0; size];
    stream.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}
struct Channel {
    stream: TcpStream,
    noise: snow::TransportState,
    initiator: bool,
    authorization: Option<(Arc<Coordinator>, Identity, bool)>,
}
impl Channel {
    fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        if let Some((owner, peer, admitted)) = self.authorization.clone() {
            owner.with_session_authority(&peer, admitted, || write_frame(&mut self.stream, bytes))
        } else {
            write_frame(&mut self.stream, bytes)
        }
    }
    fn send(&mut self, value: &Value) -> Result<(), String> {
        let bytes = wire::canonical(value)?;
        if bytes.len() > MAX_PAYLOAD_BYTES {
            return Err("Sync message too large".into());
        }
        let size = (bytes.len() as u32).to_be_bytes();
        let encrypted = transport::encrypt(&mut self.noise, &size)?;
        self.write(&encrypted)?;
        for chunk in bytes.chunks(MAX_RECORD_BYTES) {
            let encrypted = transport::encrypt(&mut self.noise, chunk)?;
            self.write(&encrypted)?;
        }
        Ok(())
    }
    fn receive(&mut self) -> Result<Value, String> {
        let deadline = Instant::now() + Duration::from_secs(30);
        let size = transport::decrypt(&mut self.noise, &read_frame(&mut self.stream)?)?;
        if size.len() != 4 {
            return Err("Invalid message framing".into());
        }
        let size = u32::from_be_bytes(size.try_into().unwrap()) as usize;
        if size > MAX_PAYLOAD_BYTES {
            return Err("Peer sent an oversized sync message".into());
        }
        let mut bytes = Vec::with_capacity(size);
        while bytes.len() < size {
            if Instant::now() > deadline {
                return Err("Peer message transfer timed out".into());
            }
            let chunk = transport::decrypt(&mut self.noise, &read_frame(&mut self.stream)?)?;
            if chunk.is_empty() || bytes.len() + chunk.len() > size {
                return Err("Invalid encrypted message fragment".into());
            }
            bytes.extend(chunk);
        }
        json::parse(&bytes)
    }
    fn exchange(&mut self, value: &Value) -> Result<Value, String> {
        if self.initiator {
            self.send(value)?;
            self.receive()
        } else {
            let peer = self.receive()?;
            self.send(value)?;
            Ok(peer)
        }
    }
}

impl Coordinator {
    fn session(
        self: &Arc<Self>,
        mut stream: TcpStream,
        initiator: bool,
        address: &str,
        expected: Option<&str>,
    ) -> Result<(), String> {
        stream.set_nonblocking(false).map_err(|e| e.to_string())?;
        stream
            .set_read_timeout(Some(Duration::from_secs(15)))
            .map_err(|e| e.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_secs(15)))
            .map_err(|e| e.to_string())?;
        stream.set_nodelay(true).map_err(|e| e.to_string())?;
        let (local_group, port) = {
            let state = self.state.lock().map_err(|_| "Sync state unavailable")?;
            (
                state.persistent.group_id.clone(),
                state
                    .runtime
                    .address
                    .as_ref()
                    .and_then(|a| a.parse::<SocketAddr>().ok())
                    .map(|a| a.port())
                    .unwrap_or(0),
            )
        };
        // The clear preface negotiates protocol/group only. It has no library content and is
        // authenticated by the prologue and identity payload before any trust decision.
        let group = if initiator {
            let proposal = unique()?;
            write_frame(
                &mut stream,
                &wire::canonical(&json!({"protocol":1,"group":local_group,"proposal":proposal}))?,
            )?;
            let response = json::parse(&read_frame(&mut stream)?)?;
            let group = text(&response, "group")?.to_string();
            if response["protocol"] != 1 || local_group.as_ref().is_some_and(|own| own != &group) {
                return Err("The devices belong to different linked libraries".into());
            }
            group
        } else {
            let bytes = read_frame(&mut stream)?;
            if bytes.len() > 4096 {
                return Err("Oversized connection preface".into());
            }
            let request = json::parse(&bytes)?;
            if request["protocol"] != 1 {
                return Err("Unsupported peer protocol".into());
            }
            let remote_group = request["group"].as_str();
            if let (Some(local), Some(remote)) = (local_group.as_deref(), remote_group) {
                if local != remote {
                    return Err("The devices belong to different linked libraries".into());
                }
            }
            let group = local_group
                .as_deref()
                .or(remote_group)
                .unwrap_or(text(&request, "proposal")?)
                .to_string();
            write_frame(
                &mut stream,
                &wire::canonical(&json!({"protocol":1,"group":group}))?,
            )?;
            group
        };
        if group.is_empty() || group.len() > 128 {
            return Err("Invalid candidate library".into());
        }
        let mut handshake = transport::handshake(
            initiator,
            &self.private,
            format!("museamo-sync-v1\0{group}").as_bytes(),
        )?;
        let mine =
            wire::canonical(&json!({"identity":self.identity,"listenPort":port,"group":group}))?;
        let mut buffer = vec![0; 16384];
        let mut output = vec![0; 16384];
        let peer_payload = if initiator {
            let size = handshake
                .write_message(&[], &mut buffer)
                .map_err(|e| e.to_string())?;
            write_frame(&mut stream, &buffer[..size])?;
            let frame = read_frame(&mut stream)?;
            if frame.len() > 16384 {
                return Err("Oversized handshake".into());
            }
            let size = handshake
                .read_message(&frame, &mut output)
                .map_err(|e| e.to_string())?;
            let peer = output[..size].to_vec();
            let size = handshake
                .write_message(&mine, &mut buffer)
                .map_err(|e| e.to_string())?;
            write_frame(&mut stream, &buffer[..size])?;
            peer
        } else {
            let frame = read_frame(&mut stream)?;
            if frame.len() > 16384 {
                return Err("Oversized handshake".into());
            }
            let size = handshake
                .read_message(&frame, &mut output)
                .map_err(|e| e.to_string())?;
            if size != 0 {
                return Err("Unexpected handshake preface".into());
            }
            let size = handshake
                .write_message(&mine, &mut buffer)
                .map_err(|e| e.to_string())?;
            write_frame(&mut stream, &buffer[..size])?;
            let frame = read_frame(&mut stream)?;
            if frame.len() > 16384 {
                return Err("Oversized handshake".into());
            }
            let size = handshake
                .read_message(&frame, &mut output)
                .map_err(|e| e.to_string())?;
            output[..size].to_vec()
        };
        let peer_payload = json::parse(&peer_payload)?;
        let peer: Identity =
            serde_json::from_value(peer_payload["identity"].clone()).map_err(|e| e.to_string())?;
        peer.validate()?;
        if expected.is_some_and(|id| id != peer.device_id) {
            return Err("Discovered endpoint does not belong to the linked device".into());
        }
        if peer_payload["group"] != group
            || peer.device_id == self.identity.device_id
            || decode(&peer.noise_public)?
                != handshake
                    .get_remote_static()
                    .ok_or("Missing Noise identity")?
        {
            return Err("Peer identity is inconsistent".into());
        }
        let code = transport::confirmation_code(&handshake)?;
        let hash = hex::encode(handshake.get_handshake_hash());
        let proof = if initiator {
            json!({"group":group,"hash":hash,"initiator":self.identity,"responder":peer})
        } else {
            json!({"group":group,"hash":hash,"initiator":peer,"responder":self.identity})
        };
        let proof = signature_bytes(b"museamo-peer-possession-v1\0", &proof)?;
        let mut channel = Channel {
            stream,
            noise: handshake.into_transport_mode().map_err(|e| e.to_string())?,
            initiator,
            authorization: None,
        };
        let outbound_pending = expected.is_some()
            || self.state.lock().map_err(|_| "Sync state unavailable")?.runtime.outbound_sessions.contains(&peer.device_id);
        let remote = channel.exchange(&json!({"signature":self.sign(&proof)?,"outboundPending":outbound_pending}))?;
        verify_signature(&peer.signing_public, &proof, text(&remote, "signature")?)?;
        channel.authorization = Some((Arc::clone(self), peer.clone(), false));
        let known = {
            let state = self.state.lock().map_err(|_| "Sync state unavailable")?;
            let view = membership_view(&state.persistent.controls)?;
            if view.quarantined {
                return Err(QUARANTINE_ERROR.into());
            }
            if view.removals.values().any(|r| r.subject == peer.device_id) {
                return Err("This device has been removed".into());
            }
            if let Some(old) = view.all.get(&peer.device_id) {
                if old != &peer {
                    return Err(
                        "A linked device changed its identity; remove it before linking again"
                            .into(),
                    );
                }
            }
            view.active.get(&peer.device_id) == Some(&peer)
                && view.active.contains_key(&self.identity.device_id)
        };
        // When both pinned peers dial at once, both endpoints keep the channel
        // initiated by the lower device ID. Decide before reserving the replica
        // or invoking its repository, so crossed connections cannot each keep
        // a different half and strand the writes until the fallback timer.
        if known && outbound_pending && remote["outboundPending"] == true
            && initiator != (self.identity.device_id < peer.device_id)
        {
            return Ok(());
        }
        let session_id = unique()?;
        if !known {
            {
                let mut state = self.state.lock().map_err(|_| "Sync state unavailable")?;
                if state.runtime.pairing.is_some() {
                    return Err("Another device is already waiting to link".into());
                }
                state.runtime.last_error = None;
                state.runtime.pairing = Some(Pairing {
                    id: session_id.clone(),
                    code,
                    peer: peer.clone(),
                    confirmed: None,
                    peer_confirmed: None,
                    accepted: None,
                    peer_accepted: None,
                    summary: None,
                });
            }
            let result = (|| {
                self.await_decision(&mut channel, &session_id, false)?;
                let local_summary = self.session_call(&peer, false, "syncSummary", json!({}))?;
                let remote_summary = channel.exchange(&json!({"summary":local_summary}))?;
                if !remote_summary["summary"].is_object() {
                    return Err("Invalid peer library summary".into());
                }
                {
                    let mut state = self.state.lock().map_err(|_| "Sync state unavailable")?;
                    state
                        .runtime
                        .pairing
                        .as_mut()
                        .filter(|p| p.id == session_id)
                        .ok_or("Pairing cancelled")?
                        .summary = Some(remote_summary["summary"].clone());
                }
                self.await_decision(&mut channel, &session_id, true)?;
                let tags = self.session_call(&peer, false, "syncEnrollmentTags", json!({}))?;
                let remote = channel.exchange(&json!({"tags":tags["tags"]}))?;
                for tags in [&tags["tags"], &remote["tags"]] {
                    if tags
                        .as_array()
                        .ok_or("Invalid enrollment categories")?
                        .len()
                        > 10_000
                    {
                        return Err("Too many categories to combine".into());
                    }
                }
                {
                    let mut state = self.state.lock().map_err(|_| "Sync state unavailable")?;
                    let mut next = state.persistent.clone();
                    next.enrollments.insert(
                        peer.device_id.clone(),
                        Enrollment {
                            id: wire::hash(&proof),
                            local_tags: tags["tags"].clone(),
                            peer_tags: remote["tags"].clone(),
                        },
                    );
                    self.save(&next)?;
                    state.persistent = next;
                }
                self.enroll_pair(&mut channel, &peer, &group)
            })();
            {
                let mut state = self.state.lock().map_err(|_| "Sync state unavailable")?;
                if state
                    .runtime
                    .pairing
                    .as_ref()
                    .is_some_and(|p| p.id == session_id)
                {
                    state.runtime.pairing = None;
                }
            }
            result?;
        }
        // Re-enrollment is intentionally idempotent and catches a crashed baseline preparation.
        channel.authorization = Some((Arc::clone(self), peer.clone(), true));
        self.session_call(&peer, true, "syncEnroll", json!({"groupId":group}))?;
        let address = address
            .parse::<SocketAddr>()
            .map_err(|_| "Invalid peer endpoint")?;
        let peer_port = peer_payload["listenPort"]
            .as_u64()
            .filter(|p| *p > 0 && *p <= 65535)
            .ok_or("Peer does not advertise a listener")? as u16;
        {
            let mut state = self.state.lock().map_err(|_| "Sync state unavailable")?;
            if !state.runtime.syncing.insert(peer.device_id.clone()) {
                return Err("A sync with this peer is already active".into());
            }
            let mut next = state.persistent.clone();
            next.addresses.insert(
                peer.device_id.clone(),
                SocketAddr::new(address.ip(), peer_port).to_string(),
            );
            if let Err(error) = self.save(&next) {
                state.runtime.syncing.remove(&peer.device_id);
                return Err(error);
            }
            state.persistent = next;
        }
        let result = self.replicate(&mut channel, &peer, &group);
        {
            let mut state = self.state.lock().map_err(|_| "Sync state unavailable")?;
            // A connected outbound ceases competing before releasing its
            // replica reservation. Its thread may still be finishing; that
            // dialing tail must not discard a new peer-initiated save.
            if initiator && expected.is_some() { state.runtime.outbound_sessions.remove(&peer.device_id); }
            state.runtime.syncing.remove(&peer.device_id);
            if result.is_ok() {
                let mut next = state.persistent.clone();
                next.last_sync.insert(peer.device_id.clone(), now());
                self.save(&next)?;
                state.persistent = next;
                state.runtime.last_error = None;
            }
        }
        result
    }
    fn await_decision(&self, channel: &mut Channel, id: &str, merge: bool) -> Result<(), String> {
        let until = Instant::now() + Duration::from_secs(180);
        loop {
            if self.stopping.load(Ordering::SeqCst) || Instant::now() > until {
                return Err("Device linking expired; try again".into());
            }
            let local = {
                let state = self.state.lock().map_err(|_| "Sync state unavailable")?;
                let pairing = state
                    .runtime
                    .pairing
                    .as_ref()
                    .filter(|p| p.id == id)
                    .ok_or("Pairing cancelled")?;
                if merge {
                    pairing.accepted
                } else {
                    pairing.confirmed
                }
            };
            let remote = channel
                .exchange(&json!({"stage":if merge{"merge"}else{"confirm"},"accepted":local}))?;
            if remote["stage"] != if merge { "merge" } else { "confirm" } {
                return Err("Invalid pairing transition".into());
            }
            let peer = match &remote["accepted"] {
                Value::Bool(v) => Some(*v),
                Value::Null => None,
                _ => return Err("Invalid peer confirmation".into()),
            };
            {
                let mut state = self.state.lock().map_err(|_| "Sync state unavailable")?;
                if let Some(pairing) = state.runtime.pairing.as_mut().filter(|p| p.id == id) {
                    if merge {
                        pairing.peer_accepted = peer;
                    } else {
                        pairing.peer_confirmed = peer;
                    }
                }
            }
            if local == Some(false) || peer == Some(false) {
                return Err("Device linking cancelled".into());
            }
            if local == Some(true) && peer == Some(true) {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(250));
        }
    }
    fn controls(&self) -> Result<Vec<Control>, String> {
        Ok(self
            .state
            .lock()
            .map_err(|_| "Sync state unavailable")?
            .persistent
            .controls
            .clone())
    }
    fn exchange_controls(
        &self,
        channel: &mut Channel,
        group: &str,
        peer: &Identity,
    ) -> Result<(), String> {
        let remote = channel.exchange(&json!({"controls":self.controls()?}))?;
        let controls: Vec<Control> =
            serde_json::from_value(remote["controls"].clone()).map_err(|e| e.to_string())?;
        let ids = controls.iter().map(|c| c.id.clone()).collect();
        self.merge_controls(controls, group)?;
        let mut state = self.state.lock().map_err(|_| "Sync state unavailable")?;
        let mut next = state.persistent.clone();
        next.control_acknowledgements
            .insert(peer.device_id.clone(), ids);
        self.save(&next)?;
        state.persistent = next;
        Ok(())
    }
    fn enroll_pair(
        &self,
        channel: &mut Channel,
        peer: &Identity,
        group: &str,
    ) -> Result<(), String> {
        self.exchange_controls(channel, group, peer)?;
        {
            let mut state = self.state.lock().map_err(|_| "Sync state unavailable")?;
            let mut next = state.persistent.clone();
            if next.controls.is_empty() && channel.initiator {
                let genesis = self.make_control(
                    &next,
                    "genesis",
                    serde_json::to_value(&self.identity).map_err(|e| e.to_string())?,
                )?;
                next.controls.push(genesis);
                self.save(&next)?;
                state.persistent = next;
            }
        }
        self.exchange_controls(channel, group, peer)?;
        {
            let mut state = self.state.lock().map_err(|_| "Sync state unavailable")?;
            let view = membership_view(&state.persistent.controls)?;
            if let Some(found) = view.active.get(&peer.device_id) {
                if found != peer {
                    return Err("Peer identity differs from its admission".into());
                }
            }
            let mut next = state.persistent.clone();
            if view.active.contains_key(&self.identity.device_id)
                && !view.active.contains_key(&peer.device_id)
            {
                let admission = self.make_control(
                    &next,
                    "admit",
                    serde_json::to_value(peer).map_err(|e| e.to_string())?,
                )?;
                next.controls.push(admission);
                self.save(&next)?;
                state.persistent = next;
            }
        }
        self.exchange_controls(channel, group, peer)?;
        {
            let state = self.state.lock().map_err(|_| "Sync state unavailable")?;
            let view = membership_view(&state.persistent.controls)?;
            if view.active.get(&peer.device_id) != Some(peer)
                || view.active.get(&self.identity.device_id) != Some(&self.identity)
            {
                return Err("Both devices must be admitted before syncing".into());
            }
        }
        Ok(())
    }
    fn receive_operations(
        &self,
        peer: &Identity,
        group: &str,
        value: &Value,
    ) -> Result<Value, String> {
        let _gate = self
            .session_gate
            .lock()
            .map_err(|_| "Sync session gate unavailable")?;
        self.ensure_session_authority(peer, true)?;
        let envelopes: Vec<Envelope> =
            serde_json::from_value(value["envelopes"].clone()).map_err(|e| e.to_string())?;
        if envelopes.len() > 32 {
            return Err("Peer sent too many operations in one batch".into());
        }
        let view = {
            let state = self.state.lock().map_err(|_| "Sync state unavailable")?;
            membership_view(&state.persistent.controls)?
        };
        if view.quarantined {
            return Err(QUARANTINE_ERROR.into());
        }
        let proofs: Vec<Envelope> = serde_json::from_value(
            value["purgeProofs"]
                .as_array()
                .cloned()
                .map(Value::Array)
                .unwrap_or(json!([])),
        )
        .map_err(|e| e.to_string())?;
        let mut purge_ids = BTreeSet::new();
        let mut retired = BTreeSet::new();
        for envelope in proofs.iter().chain(&envelopes) {
            let revision = &envelope.header.revision;
            let origin = &revision.dot.origin;
            let identity = view
                .all
                .get(origin)
                .ok_or("Operation from unknown origin")?;
            if let Some(limit) = view.authorized.get(origin) {
                if revision.dot.sequence > *limit {
                    return Err("Operation exceeds removed-device history checkpoint".into());
                }
            }
            if !view.active.contains_key(origin) && !view.authorized.contains_key(origin) {
                return Err("Operation from unauthorized origin".into());
            }
            if revision.context.len() > 128
                || revision.context.get(origin).copied().unwrap_or(0) >= revision.dot.sequence
                || revision.dot.sequence > 9_007_199_254_740_991
                || revision.clock.wall > crate::MAX_TIMESTAMP
                || revision.clock.logical > 9_007_199_254_740_991
            {
                return Err("Invalid operation causality or numeric precision".into());
            }
            // The platform verifies durable purge proof independently before accepting a null
            // payload. The coordinator verifies original signatures even for scrubbed history.
            if envelope.payload.is_some() {
                wire::verify(envelope, group, &decode(&identity.signing_public)?, false)?;
            }
            if envelope.header.kind == "purge" {
                if let Some(payload) = &envelope.payload {
                    for id in payload["revisionIds"]
                        .as_array()
                        .ok_or("Invalid purge proof")?
                    {
                        let id = id.as_str().ok_or("Invalid purged revision")?;
                        if id.len() > 256 {
                            return Err("Invalid purged revision".into());
                        }
                        purge_ids.insert(id.to_string());
                    }
                    for id in payload["entityIds"]
                        .as_array()
                        .ok_or("Invalid retired entity proof")?
                    {
                        retired.insert(id.as_str().ok_or("Invalid retired entity")?.to_string());
                    }
                }
            }
        }
        for proof in &proofs {
            if proof.header.kind != "purge" || proof.payload.is_none() {
                return Err("Invalid suppression proof".into());
            }
        }
        for envelope in &envelopes {
            let key = &view.all[&envelope.header.revision.dot.origin].signing_public;
            wire::verify(
                envelope,
                group,
                &decode(key)?,
                envelope.payload.is_none()
                    && (purge_ids.contains(&envelope.header.revision.id())
                        || matches!(envelope.header.kind.as_str(), "thought" | "archiveThought")
                            && retired.contains(&envelope.header.revision.entity_id)),
            )?;
        }
        self.platform_call("syncApply",json!({"groupId":group,"envelopes":envelopes,"purgeProofs":proofs,"members":view.all.values().collect::<Vec<_>>(),"authorizedHistory":view.authorized,"authorizedAnchors":view.anchors,"purged":purge_ids}))
    }
    fn replicate(&self, channel: &mut Channel, peer: &Identity, group: &str) -> Result<(), String> {
        self.exchange_controls(channel, group, peer)?;
        {
            let state = self.state.lock().map_err(|_| "Sync state unavailable")?;
            let view = membership_view(&state.persistent.controls)?;
            if view.quarantined {
                return Err(QUARANTINE_ERROR.into());
            }
            if !view.active.contains_key(&self.identity.device_id)
                || view.active.get(&peer.device_id) != Some(peer)
            {
                return Err("This device has been removed from the library".into());
            }
        }
        let own = self.session_call(peer, true, "syncReceipts", json!({}))?;
        let remote = channel
            .exchange(&json!({"receipts":own.get("stagedReceipts").unwrap_or(&own["receipts"])}))?;
        let mut peer_receipts: Context =
            serde_json::from_value(remote["receipts"].clone()).map_err(|e| e.to_string())?;
        if peer_receipts.len() > 128 {
            return Err("Peer receipt vector too large".into());
        }
        // Work is bounded per session; the next periodic/on-demand session resumes from durable
        // receipt vectors rather than keeping an endless connection or unbounded queue.
        let mut metadata_complete = false;
        for phase in 0..2 {
            let mut complete = false;
            for batch in 0..256 {
                if self.stopping.load(Ordering::SeqCst) {
                    return Err("Sync stopped".into());
                }
                if batch % 64 == 0 {
                    self.exchange_controls(channel, group, peer)?;
                    let state = self.state.lock().map_err(|_| "Sync state unavailable")?;
                    let view = membership_view(&state.persistent.controls)?;
                    if view.quarantined {
                        return Err(QUARANTINE_ERROR.into());
                    }
                    if !view.active.contains_key(&self.identity.device_id)
                        || !view.active.contains_key(&peer.device_id)
                    {
                        return Err("A device was removed during original transfer".into());
                    }
                }
                if self.stopping.load(Ordering::SeqCst) {
                    return Err("Sync stopped".into());
                }
                let own = self.session_call(
                    peer,
                    true,
                    "syncExport",
                    json!({"groupId":group,"after":peer_receipts,"limit":32}),
                )?;
                let remote=channel.exchange(&json!({"envelopes":own["envelopes"],"more":own["more"].as_bool().unwrap_or(false),"purgeProofs":own["purgeProofs"].as_array().cloned().unwrap_or_default()}))?;
                let receipts = self.receive_operations(peer, group, &remote)?;
                let acknowledgements=channel.exchange(&json!({"receipts":receipts.get("stagedReceipts").unwrap_or(&receipts["receipts"])}))?;
                peer_receipts = serde_json::from_value(acknowledgements["receipts"].clone())
                    .map_err(|e| e.to_string())?;
                if peer_receipts.len() > 128 {
                    return Err("Peer receipt vector too large".into());
                }
                if !own["more"].as_bool().unwrap_or(false)
                    && !remote["more"].as_bool().unwrap_or(false)
                {
                    complete = true;
                    break;
                }
            }
            let receipts = self.session_call(peer, true, "syncReceipts", json!({}))?;
            let ready = complete
                && same_receipts(
                    &receipts["receipts"],
                    receipts
                        .get("stagedReceipts")
                        .unwrap_or(&receipts["receipts"]),
                )?;
            let remote=channel.exchange(&json!({"metadataReady":ready,"aliasPending":self.state.lock().map_err(|_|"Sync state unavailable")?.persistent.enrollments.contains_key(&peer.device_id)}))?;
            if !ready || remote["metadataReady"] != true {
                break;
            }
            metadata_complete = true;
            if phase == 0 {
                let pending = self
                    .state
                    .lock()
                    .map_err(|_| "Sync state unavailable")?
                    .persistent
                    .enrollments
                    .get(&peer.device_id)
                    .cloned();
                if pending.is_none() && remote["aliasPending"] != true {
                    break;
                }
                if let Some(enrollment) = pending {
                    self.session_call(peer, true, "syncCoalesceTags",json!({"enrollmentId":enrollment.id,"localTags":enrollment.local_tags,"peerTags":enrollment.peer_tags}))?;
                    let mut state = self.state.lock().map_err(|_| "Sync state unavailable")?;
                    let mut next = state.persistent.clone();
                    next.enrollments.remove(&peer.device_id);
                    self.save(&next)?;
                    state.persistent = next;
                }
                // A second pass sends aliases after the complete initial baseline, never before it.
                metadata_complete = false;
            }
        }
        let media_deadline = Instant::now() + Duration::from_secs(15);
        let mut unavailable = BTreeSet::new();
        for chunk in 0..4096 {
            if self.stopping.load(Ordering::SeqCst) {
                return Err("Sync stopped".into());
            }
            if chunk % 64 == 0 {
                self.exchange_controls(channel, group, peer)?;
                let state = self.state.lock().map_err(|_| "Sync state unavailable")?;
                let view = membership_view(&state.persistent.controls)?;
                if view.quarantined {
                    return Err(QUARANTINE_ERROR.into());
                }
                if !view.active.contains_key(&self.identity.device_id)
                    || !view.active.contains_key(&peer.device_id)
                {
                    return Err("A device was removed during original transfer".into());
                }
            }
            let missing = self.session_call(peer, true, "syncMissingMedia", json!({"limit":32}))?;
            self.update_pending(&missing)?;
            let request = missing["items"]
                .as_array()
                .and_then(|rows| {
                    rows.iter()
                        .find(|row| !unavailable.contains(row["id"].as_str().unwrap_or("")))
                })
                .cloned()
                .unwrap_or(Value::Null);
            let remote_request = channel.exchange(&json!({"request":request}))?;
            let response = if remote_request["request"].is_null() {
                json!({"available":false})
            } else {
                let request = &remote_request["request"];
                let id = text(request, "id")?;
                let offset = request["offset"]
                    .as_u64()
                    .ok_or("Invalid attachment offset")?;
                match self.session_call(
                    peer,
                    true,
                    "syncReadMedia",
                    json!({"id":id,"offset":offset,"maxBytes":16384}),
                ) {
                    Ok(value) => {
                        json!({"available":true,"bytes":value["bytes"],"eof":value["eof"]})
                    }
                    Err(_) => json!({"available":false}),
                }
            };
            let response = channel.exchange(&response)?;
            if !request.is_null() && response["available"] == true {
                let bytes = decode(text(&response, "bytes")?)?;
                if bytes.len() > 16384 {
                    return Err("Attachment chunk exceeds negotiated bound".into());
                }
                if bytes.is_empty() && request["offset"] != request["size"] {
                    return Err("Peer returned an empty attachment chunk".into());
                }
                let mut input = request.clone();
                input["bytes"] = json!(hex::encode(bytes));
                self.session_call(peer, true, "syncWriteMedia", input)?;
            }
            if !request.is_null() && response["available"] != true {
                unavailable.insert(text(&request, "id")?.to_string());
            }
            let keep_going = Instant::now() < media_deadline
                && chunk < 4095
                && !self.state.lock().map_err(|_| "Sync state unavailable")?.runtime.sync_again
                && (!request.is_null() || !remote_request["request"].is_null());
            let remote = channel.exchange(&json!({"continueMedia":keep_going}))?;
            if !keep_going || remote["continueMedia"] != true {
                break;
            }
        }
        let missing = self.session_call(peer, true, "syncMissingMedia", json!({"limit":32}))?;
        self.update_pending(&missing)?;
        let own = self.session_call(peer, true, "syncReceipts", json!({}))?;
        let remote=channel.exchange(&json!({"applied":own["receipts"],"staged":own.get("stagedReceipts").unwrap_or(&own["receipts"])}))?;
        let own_staged = own.get("stagedReceipts").unwrap_or(&own["receipts"]);
        if !same_receipts(&own["receipts"], own_staged)?
            || !same_receipts(&remote["applied"], &remote["staged"])?
        {
            return Err("Received changes are waiting for verified history or a valid clearing proof. Open another linked device and sync again.".into());
        }
        if !metadata_complete {
            self.state
                .lock()
                .map_err(|_| "Sync state unavailable")?
                .runtime
                .sync_again = true;
            return Err("More saved changes remain; local sync will continue.".into());
        }
        Ok(())
    }
    fn update_pending(&self, missing: &Value) -> Result<(), String> {
        let count = missing["totalCount"]
            .as_u64()
            .map(|n| n as usize)
            .unwrap_or_else(|| missing["items"].as_array().map(Vec::len).unwrap_or(0));
        self.state
            .lock()
            .map_err(|_| "Sync state unavailable")?
            .runtime
            .attachments_pending = count;
        Ok(())
    }
}

fn same_receipts(a: &Value, b: &Value) -> Result<bool, String> {
    let a: Context = serde_json::from_value(a.clone()).map_err(|e| e.to_string())?;
    let b: Context = serde_json::from_value(b.clone()).map_err(|e| e.to_string())?;
    Ok(a.iter()
        .all(|(origin, n)| *n == b.get(origin).copied().unwrap_or(0))
        && b.iter()
            .all(|(origin, n)| *n == a.get(origin).copied().unwrap_or(0)))
}
