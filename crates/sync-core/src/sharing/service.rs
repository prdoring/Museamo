use super::*;
use crate::{json as strict_json, transport, Platform, MAX_RECORD_BYTES};
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn random() -> Result<String> {
    let keys = snow::Builder::new(
        transport::SUITE
            .parse()
            .map_err(|e: snow::Error| e.to_string())?,
    )
    .generate_keypair()
    .map_err(|e| e.to_string())?;
    Ok(hex::encode(keys.private))
}
fn participant(proof: &Value) -> Result<String> {
    Ok(string(proof, "group")?.into())
}
#[derive(Clone)]
struct Invitation {
    scope: String,
    expires: u64,
    token_hash: String,
}
#[derive(Default)]
struct Runtime {
    address: Option<SocketAddr>,
    invites: BTreeMap<String, Invitation>,
    nearby: BTreeMap<String, String>,
    last_error: Option<String>,
    syncing: bool,
}

/// One additional listener for all shared collections. Personal-library sessions remain v1.
pub struct ShareService {
    pub(crate) platform: Arc<dyn Platform>,
    pub(crate) personal: Arc<Coordinator>,
    registry: Mutex<Registry>,
    gate: Mutex<()>,
    runtime: Mutex<Runtime>,
    stopped: AtomicBool,
    sessions: AtomicUsize,
    mdns: Mutex<Option<mdns_sd::ServiceDaemon>>,
    private: Vec<u8>,
    identity: Identity,
    wake: std::sync::Condvar,
    signal: Mutex<bool>,
}
impl ShareService {
    pub fn new(platform: Arc<dyn Platform>, personal: Arc<Coordinator>) -> Result<Arc<Self>> {
        let raw = platform.call("syncIdentity", json!({}))?;
        let loaded = platform.call("shareLoad", json!({}))?;
        let registry = if loaded["registry"].is_null() {
            Registry::default()
        } else {
            serde_json::from_value(loaded["registry"].clone())
                .map_err(|e| format!("Invalid stored sharing state: {e}"))?
        };
        let nearby = registry.peers.clone();
        let service = Arc::new(Self {
            identity: personal.sharing_identity(),
            private: hex::decode(string(&raw, "noisePrivate")?)
                .map_err(|_| "Invalid native identity")?,
            platform,
            personal,
            registry: Mutex::new(registry),
            gate: Mutex::new(()),
            runtime: Mutex::new(Runtime {
                nearby,
                ..Runtime::default()
            }),
            stopped: AtomicBool::new(false),
            sessions: AtomicUsize::new(0),
            mdns: Mutex::new(None),
            wake: std::sync::Condvar::new(),
            signal: Mutex::new(false),
        });
        {
            let stored = service.registry.lock().map_err(|_| "Sharing unavailable")?;
            for scope in stored.scopes.values() {
                scope.view(&service.personal)?;
            }
        }
        Ok(service)
    }
    fn call(&self, method: &str, input: Value) -> Result<Value> {
        if self.stopped.load(Ordering::SeqCst) {
            return Err("Sharing stopped".into());
        }
        self.platform.call(method, input)
    }
    fn sign(&self, bytes: &[u8]) -> Result<String> {
        let result = self.call("syncSign", json!({"bytes":hex::encode(bytes)}))?;
        let signature = string(&result, "signature")?.to_owned();
        verify(&self.identity.signing_public, bytes, &signature)?;
        Ok(signature)
    }
    fn proof(&self, initialize: bool) -> Result<Value> {
        self.personal.sharing_proof(initialize)
    }
    fn save(&self, registry: &mut Registry, ack: &[String]) -> Result<()> {
        self.save_seed(registry, ack, Value::Null)
    }
    fn save_seed(&self, registry: &mut Registry, ack: &[String], seed: Value) -> Result<()> {
        let result=self.call("shareCommit",json!({"registry":registry,"ack":ack,"participant":self.proof(false)?["group"],"projections":projections(registry)?,"seed":seed}))?;
        if !result["registry"].is_null() {
            *registry = serde_json::from_value(result["registry"].clone())
                .map_err(|_| "Invalid committed sharing registry")?;
        }
        Ok(())
    }
    pub fn start(self: &Arc<Self>, bind: &str) -> Result<Value> {
        let addr: SocketAddr = bind.parse().map_err(|_| "Invalid sharing listen address")?;
        let socket = socket2::Socket::new(
            if addr.is_ipv4() {
                socket2::Domain::IPV4
            } else {
                socket2::Domain::IPV6
            },
            socket2::Type::STREAM,
            Some(socket2::Protocol::TCP),
        )
        .map_err(|e| e.to_string())?;
        #[cfg(target_os = "android")]
        {
            use std::os::fd::AsRawFd;
            self.call("syncBindSocket", json!({"fd":socket.as_raw_fd()}))?;
        }
        socket
            .bind(&addr.into())
            .and_then(|_| socket.listen(16))
            .map_err(|e| e.to_string())?;
        let listener: TcpListener = socket.into();
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let address = listener.local_addr().map_err(|e| e.to_string())?;
        self.runtime
            .lock()
            .map_err(|_| "Sharing unavailable")?
            .address = Some(address);
        let owner = self.clone();
        thread::spawn(move || {
            while !owner.stopped.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        if owner.sessions.fetch_add(1, Ordering::SeqCst) >= 8 {
                            owner.sessions.fetch_sub(1, Ordering::SeqCst);
                            continue;
                        }
                        let task = owner.clone();
                        thread::spawn(move || {
                            if let Err(e) = task.serve(stream) {
                                task.error(e);
                            }
                            task.sessions.fetch_sub(1, Ordering::SeqCst);
                        });
                    }
                    Err(_) => thread::sleep(Duration::from_millis(100)),
                }
            }
        });
        // A loopback listener cannot accept connections on advertised LAN addresses.
        if !address.ip().is_loopback() {
            if let Err(error) = self.discovery(address.port()) {
                self.error(format!("Shared-list discovery unavailable: {error}"));
            }
        }
        let owner = self.clone();
        thread::spawn(move || {
            while !owner.stopped.load(Ordering::SeqCst) {
                if let Err(error) = owner.cycle() {
                    owner.error(error);
                }
                let signal = owner.signal.lock().unwrap_or_else(|e| e.into_inner());
                let (mut signal, _) = owner
                    .wake
                    .wait_timeout_while(signal, Duration::from_secs(30), |s| {
                        !*s && !owner.stopped.load(Ordering::SeqCst)
                    })
                    .unwrap_or_else(|e| e.into_inner());
                *signal = false;
            }
        });
        self.public_state()
    }
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.wake.notify_all();
        let _gate = self.gate.lock();
        if let Ok(mut d) = self.mdns.lock() {
            if let Some(d) = d.take() {
                let _ = d.shutdown();
            }
        }
        if let Ok(mut r) = self.runtime.lock() {
            r.invites.clear();
        }
    }
    pub fn local_data_changed(&self) {
        if let Ok(mut signal) = self.signal.lock() {
            *signal = true;
            self.wake.notify_one();
        }
    }
    fn error(&self, error: String) {
        #[cfg(test)]
        eprintln!("sharing {}: {}", self.identity.device_id, error);
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.last_error = Some(error);
        }
    }
    fn public_state(&self) -> Result<Value> {
        let runtime = self.runtime.lock().map_err(|_| "Sharing unavailable")?;
        Ok(
            json!({"deviceId":self.identity.device_id,"name":self.identity.name,"capability":CAPABILITY,"address":runtime.address.map(|a|a.to_string()),"phase":if runtime.syncing{"syncing"}else{"waiting"},"lastError":runtime.last_error}),
        )
    }
    pub fn command(self: &Arc<Self>, method: &str, input: Value) -> Result<Value> {
        match method {
            "getSharingState" => self.public_state(),
            "shareDiscoveryHint" => {
                self.runtime
                    .lock()
                    .map_err(|_| "Sharing unavailable")?
                    .nearby
                    .insert(
                        string(&input, "deviceId")?.into(),
                        string(&input, "address")?.into(),
                    );
                self.local_data_changed();
                Ok(json!({}))
            }
            "getTagShareState" => {
                self.flush()?;
                let registry = self.registry.lock().map_err(|_| "Sharing unavailable")?;
                let id = string(&input, "tagId")?;
                let collection = registry
                    .bindings
                    .iter()
                    .find(|(_, b)| b.tag_id == id && !b.detached);
                if let Some((id, _)) = collection {
                    let scope = &registry.scopes[id];
                    let view = scope.view(&self.personal)?;
                    let own = participant(&self.proof(false)?)?;
                    let pending = self.call("shareMissingMedia", json!({"scope":id}))?
                        ["totalCount"]
                        .as_u64()
                        .unwrap_or(0);
                    let runtime = self.runtime.lock().map_err(|_| "Sharing unavailable")?;
                    Ok(
                        json!({"collectionId":id,"role":if view.owner==own{"owner"}else{"member"},"status":if runtime.syncing{"syncing"}else if pending>0{"attachment-pending"}else{"waiting"},"attachmentsPending":pending,"lastSync":scope.last_sync,"lastError":runtime.last_error,"members":view.grants.values().filter(|g|!view.revoked.contains(&g.id)).map(|g|json!({"id":g.id,"name":g.name,"owner":g.participant==view.owner,"you":g.participant==own})).collect::<Vec<_>>() }),
                    )
                } else {
                    Ok(json!({"collectionId":null}))
                }
            }
            "startTagSharing" => {
                self.flush()?;
                let _gate = self.gate.lock().map_err(|_| "Sharing unavailable")?;
                let seed = self.call("shareSeed", input.clone())?;
                let tag = json!({"id":seed["tag"]["id"],"name":seed["tag"]["name"],"type":seed["tag"]["type"]});
                valid_tag(&tag)?;
                let proof = self.proof(true)?;
                let own = participant(&proof)?;
                let mut registry = self.registry.lock().map_err(|_| "Sharing unavailable")?;
                let tag_id = string(&tag, "id")?.to_owned();
                if registry
                    .bindings
                    .values()
                    .any(|b| b.tag_id == tag_id && !b.detached)
                {
                    return Err("This hashtag is already shared".into());
                }
                let id = random()?;
                let mut scope = Scope {
                    id: id.clone(),
                    controls: vec![],
                    proofs: BTreeMap::from([(own.clone(), proof.clone())]),
                    records: vec![],
                    last_sync: None,
                };
                scope.append_control(&self.personal,&own,&self.identity,"open",json!({"participant":own,"root":proof_root(&proof)?,"name":self.identity.name,"tag":tag}),|data|self.sign(data))?;
                let mut binding = Binding {
                    tag_id,
                    grant: scope.controls[0].id.clone(),
                    ..Binding::default()
                };
                for entry in seed["entries"].as_array().ok_or("Invalid sharing seed")? {
                    let entry_id = string(entry, "id")?;
                    if registry
                        .bindings
                        .values()
                        .any(|b| !b.detached && b.entries.values().any(|local| local == entry_id))
                    {
                        return Err("Some thoughts already belong to another shared list. Remove that shared hashtag first.".into());
                    }
                    binding.entries.insert(entry_id.into(), entry_id.into());
                    scope.append_record(
                        &self.personal,
                        &own,
                        &self.identity,
                        &json!({"entityId":entry_id,"payload":entry,"context":scope.receipts()}),
                        now(),
                        |data| self.sign(data),
                    )?;
                }
                let mut next = registry.clone();
                next.scopes.insert(id.clone(), scope);
                next.bindings.insert(id.clone(), binding);
                self.save_seed(&mut next, &[], seed)?;
                *registry = next;
                drop(registry);
                self.local_data_changed();
                Ok(json!({"collectionId":id}))
            }
            "createTagInvite" => {
                self.flush()?;
                let registry = self.registry.lock().map_err(|_| "Sharing unavailable")?;
                let scope = self.scope_for_tag(&registry, string(&input, "tagId")?)?;
                let own = participant(&self.proof(false)?)?;
                let view = scope.authorize(&self.personal, &own, &self.identity)?;
                if view.owner != own {
                    return Err("Only the creator can invite people".into());
                }
                let token = random()?;
                let invite_id = random()?;
                let expires = now() + INVITE_LIFETIME;
                let mut runtime = self.runtime.lock().map_err(|_| "Sharing unavailable")?;
                runtime
                    .invites
                    .retain(|_, i| i.expires > now() && i.scope != scope.id);
                runtime.invites.insert(
                    invite_id.clone(),
                    Invitation {
                        scope: scope.id.clone(),
                        expires,
                        token_hash: wire::hash(token.as_bytes()),
                    },
                );
                let address = runtime
                    .address
                    .ok_or("Connect to a local network to share")?;
                let addresses = local_addresses(address);
                if addresses.is_empty() {
                    return Err("Connect to a local Wi-Fi network to create an invitation".into());
                }
                let invitation = json!({"version":1,"capability":CAPABILITY,"id":invite_id,"scope":scope.id,"expiresAt":expires,"token":token,"addresses":addresses,"identity":self.identity});
                let invite = format!(
                    "museamo-share:{}",
                    hex::encode(wire::canonical(&invitation)?)
                );
                Ok(json!({"inviteId":invite_id,"expiresAt":expires,"invite":invite}))
            }
            "cancelTagInvite" => {
                self.runtime
                    .lock()
                    .map_err(|_| "Sharing unavailable")?
                    .invites
                    .remove(string(&input, "inviteId")?);
                Ok(json!({}))
            }
            "previewTagInvite" | "joinTagShare" => self.join(&input, method == "joinTagShare"),
            "leaveTagShare" | "stopTagSharing" | "removeTagShareMember" => {
                self.flush()?;
                let _gate = self.gate.lock().map_err(|_| "Sharing unavailable")?;
                let proof = self.proof(false)?;
                let own = participant(&proof)?;
                let mut registry = self.registry.lock().map_err(|_| "Sharing unavailable")?;
                let mut next = registry.clone();
                let id = self
                    .scope_for_tag(&next, string(&input, "tagId")?)?
                    .id
                    .clone();
                let scope = next
                    .scopes
                    .get_mut(&id)
                    .ok_or("Shared hashtag disappeared")?;
                let view = scope.authorize(&self.personal, &own, &self.identity)?;
                let (kind, data) = match method {
                    "leaveTagShare" => {
                        if view.owner == own {
                            return Err("The creator must stop sharing instead of leaving".into());
                        }
                        ("leave", json!({"grant":scope.live_grant(&view,&own)?.id}))
                    }
                    "removeTagShareMember" => {
                        ("remove", json!({"grant":string(&input,"memberId")?}))
                    }
                    _ => ("stop", json!({})),
                };
                scope.append_control(&self.personal, &own, &self.identity, kind, data, |data| {
                    self.sign(data)
                })?;
                self.checkpoint(scope)?;
                self.save(&mut next, &[])?;
                *registry = next;
                self.runtime
                    .lock()
                    .map_err(|_| "Sharing unavailable")?
                    .invites
                    .retain(|_, i| i.scope != id);
                drop(registry);
                self.local_data_changed();
                Ok(json!({}))
            }
            "syncTagShare" => {
                self.local_data_changed();
                self.public_state()
            }
            _ => Err("Unknown shared hashtag command".into()),
        }
    }
    fn scope_for_tag<'a>(&self, registry: &'a Registry, tag: &str) -> Result<&'a Scope> {
        let (id, _) = registry
            .bindings
            .iter()
            .find(|(_, b)| b.tag_id == tag && !b.detached)
            .ok_or("This hashtag is not shared")?;
        registry
            .scopes
            .get(id)
            .ok_or_else(|| "Missing shared collection".into())
    }
    /// Local mutations are an atomic durable outbox, not a filter on personal history.
    pub fn flush(&self) -> Result<()> {
        let _gate = self.gate.lock().map_err(|_| "Sharing unavailable")?;
        let pending = self.call("sharePending", json!({}))?;
        let values = pending["items"]
            .as_array()
            .ok_or("Invalid native sharing outbox")?;
        let proof = self.proof(false)?;
        if proof["group"].is_null() {
            return Ok(());
        }
        let own = participant(&proof)?;
        let mut registry = self.registry.lock().map_err(|_| "Sharing unavailable")?;
        let mut next = registry.clone();
        let mut ack = vec![];
        next.peers.extend(
            self.runtime
                .lock()
                .map_err(|_| "Sharing unavailable")?
                .nearby
                .clone(),
        );
        for scope in next.scopes.values_mut() {
            if scope.proofs.contains_key(&own) {
                scope
                    .proofs
                    .insert(own.clone(), merge_proof(&scope.proofs[&own], &proof)?);
            }
        }
        for item in values {
            let id = string(item, "scope")?;
            let scope = next
                .scopes
                .get_mut(id)
                .ok_or("Pending change belongs to an unknown shared list")?;
            let view = scope.view(&self.personal)?;
            if item.get("grant").is_some_and(|g| {
                scope.live_grant(&view, &own).is_err()
                    || scope
                        .live_grant(&view, &own)
                        .is_ok_and(|live| g != &live.id)
            }) {
                ack.push(string(item, "id")?.into());
                continue;
            }
            if scope
                .authorize(&self.personal, &own, &self.identity)
                .is_err()
            {
                ack.push(string(item, "id")?.into());
                continue;
            }
            if item["kind"] == "purge" {
                scope.purge_recovery(
                    &self.personal,
                    &own,
                    &self.identity,
                    string(item, "revisionId")?,
                    |data| self.sign(data),
                )?;
            } else if item["kind"] == "metadata" {
                scope.append_control(
                    &self.personal,
                    &own,
                    &self.identity,
                    "metadata",
                    item["payload"].clone(),
                    |data| self.sign(data),
                )?;
            } else {
                scope.append_record(&self.personal, &own, &self.identity, item, now(), |data| {
                    self.sign(data)
                })?;
                if let Some(binding) = next.bindings.get_mut(id) {
                    binding.entries.insert(
                        string(item, "entityId")?.into(),
                        string(item, "localId")?.into(),
                    );
                }
            }
            let _ = view;
            ack.push(string(item, "id")?.into());
        }
        for scope in next.scopes.values_mut() {
            self.checkpoint(scope)?;
        }
        if !ack.is_empty() || wire::canonical(&next)? != wire::canonical(&*registry)? {
            self.save(&mut next, &ack)?;
            *registry = next;
        }
        Ok(())
    }
    fn checkpoint(&self, scope: &mut Scope) -> Result<()> {
        let proof = self.proof(false)?;
        if proof["group"].is_null() {
            return Ok(());
        }
        let own = participant(&proof)?;
        let view = scope.view(&self.personal)?;
        if !view.devices.contains_key(&self.identity.device_id) {
            return Ok(());
        }
        if view
            .grants
            .values()
            .filter(|g| g.participant == own)
            .all(|g| view.revoked.contains(&g.id))
        {
            return Ok(());
        }
        if scope
            .controls
            .iter()
            .any(|c| !view.devices.contains_key(&c.body.issuer))
            || scope
                .records
                .iter()
                .any(|r| !view.devices.contains_key(&r.revision.dot.origin))
        {
            let id = format!("personal:{}", wire::hash(&wire::canonical(&scope.proofs)?));
            if !scope.controls.iter().any(|c| {
                c.body.kind == "checkpoint"
                    && c.body.issuer == self.identity.device_id
                    && c.body.data["removal"] == id
            }) {
                self.witness(scope, &own, &id)?;
            }
        }
        let removals = scope
            .controls
            .iter()
            .filter(|c| matches!(c.body.kind.as_str(), "remove" | "leave" | "stop"))
            .cloned()
            .collect::<Vec<_>>();
        for removal in removals {
            if scope.controls.iter().any(|c| {
                c.body.kind == "checkpoint"
                    && c.body.issuer == self.identity.device_id
                    && c.body.data["removal"] == removal.id
            }) {
                continue;
            }
            // A departing person cannot authorize their own extra history.
            if removal.body.kind == "leave" && removal.body.participant == own
                || removal.body.kind == "remove"
                    && view
                        .grants
                        .get(removal.body.data["grant"].as_str().unwrap_or(""))
                        .is_some_and(|g| g.participant == own)
            {
                continue;
            }
            self.witness(scope, &own, &removal.id)?;
        }
        Ok(())
    }
    fn witness(&self, scope: &mut Scope, own: &str, removal: &str) -> Result<()> {
        let mut headers = json!({});
        for r in &scope.records {
            headers[&r.revision.dot.origin][r.revision.dot.sequence.to_string()] =
                json!(record_hash(r)?);
        }
        let mut controls = json!({});
        for c in &scope.controls {
            controls[&c.id] = json!(wire::hash(&wire::canonical(c)?));
        }
        let body = ControlBody {
            scope: scope.id.clone(),
            issuer: self.identity.device_id.clone(),
            participant: own.into(),
            parents: scope.controls.iter().map(|c| c.id.clone()).collect(),
            kind: "checkpoint".into(),
            data: json!({"removal":removal,"receipts":scope.receipts(),"headers":headers,"controlHeaders":controls}),
        };
        let signature = self.sign(&bytes(b"museamo-share-control-v1\0", &body)?)?;
        scope.controls.push(SignedControl {
            id: wire::hash(&wire::canonical(&body)?),
            body,
            signature,
        });
        scope.view(&self.personal)?;
        Ok(())
    }
}

pub fn projections(registry: &Registry) -> Result<Value> {
    let mut items = vec![];
    for (id, binding) in &registry.bindings {
        let scope = registry.scopes.get(id).ok_or("Missing shared scope")?;
        let heads = scope.heads()?;
        items.push(json!({"collectionId":id,"binding":binding,"tag":scope.tag()?,"proofs":scope.proofs,"controls":scope.controls,"items":heads.values().map(|r|json!({"itemId":r.revision.entity_id,"revision":r.revision.id(),"payload":r.payload,"deleted":r.revision.deleted || r.payload.is_null()})).collect::<Vec<_>>(),"recovery":scope.records.iter().filter(|r|!r.payload.is_null() && (r.revision.deleted||heads.get(&format!("{}:{}",r.kind,r.revision.entity_id)).is_some_and(|head|head.revision.dot!=r.revision.dot))).map(|r|json!({"id":format!("shared:{}:{}",id,r.revision.id()),"itemId":r.revision.entity_id,"payload":r.payload,"createdAt":r.revision.clock.wall})).collect::<Vec<_>>() }));
    }
    Ok(json!(items))
}
fn changed_registry(old: &Registry, next: &Registry) -> bool {
    next.scopes.iter().any(|(id, s)| {
        old.scopes.get(id).is_none_or(|p| {
            p.records.len() != s.records.len()
                || p.controls.len() != s.controls.len()
                || wire::canonical(&p.proofs).ok() != wire::canonical(&s.proofs).ok()
        })
    }) || wire::canonical(&old.bindings).ok() != wire::canonical(&next.bindings).ok()
}
fn local_addresses(address: SocketAddr) -> Vec<String> {
    if !address.ip().is_unspecified() {
        return vec![address.to_string()];
    }
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| {
            !i.is_loopback()
                && !i.ip().is_unspecified()
                && i.ip().is_ipv4() == address.ip().is_ipv4()
        })
        .map(|i| SocketAddr::new(i.ip(), address.port()).to_string())
        .collect()
}

struct TransferFence<'a> {
    _shared: std::sync::MutexGuard<'a, ()>,
    _personal: std::sync::MutexGuard<'a, ()>,
}
struct Channel {
    stream: TcpStream,
    noise: snow::TransportState,
    peer: Identity,
}
fn frame_write(stream: &mut TcpStream, bytes: &[u8]) -> Result<()> {
    if bytes.is_empty() || bytes.len() > MAX_RECORD_BYTES + 16 {
        return Err("Invalid sharing frame".into());
    }
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .and_then(|_| stream.write_all(bytes))
        .map_err(|_| "Shared-list connection interrupted".into())
}
fn frame_read(stream: &mut TcpStream) -> Result<Vec<u8>> {
    let mut size = [0; 4];
    stream
        .read_exact(&mut size)
        .map_err(|e| format!("Shared-list connection interrupted (header: {e})"))?;
    let n = u32::from_be_bytes(size) as usize;
    if n == 0 || n > MAX_RECORD_BYTES + 16 {
        return Err("Invalid sharing frame size".into());
    }
    let mut data = vec![0; n];
    stream
        .read_exact(&mut data)
        .map_err(|e| format!("Shared-list connection interrupted (body: {e})"))?;
    Ok(data)
}
impl Channel {
    fn send<G>(&mut self, value: &Value, guard: impl Fn() -> Result<G>) -> Result<()> {
        let data = wire::canonical(value)?;
        if data.len() > 512 * 1024 * 1024 {
            return Err("Shared-list message exceeds capacity".into());
        }
        {
            let _guard = guard()?;
            let size = transport::encrypt(&mut self.noise, &(data.len() as u32).to_be_bytes())?;
            frame_write(&mut self.stream, &size)?;
        }
        for chunk in data.chunks(MAX_RECORD_BYTES) {
            let _guard = guard()?;
            let chunk = transport::encrypt(&mut self.noise, chunk)?;
            frame_write(&mut self.stream, &chunk)?;
        }
        Ok(())
    }
    /// Authenticate membership before accepting a collection-sized request body.
    fn request<G>(&mut self, value: &Value, guard: impl Fn() -> Result<G>) -> Result<()> {
        if matches!(value["mode"].as_str(), Some("home" | "sync")) {
            let header = json!({"authenticate":true,"mode":value["mode"],"scope":value["scope"],"proof":value["proof"]});
            self.send(&header, &guard)?;
            let response = self.receive_limit(MAX_PAYLOAD_BYTES)?;
            if response["authenticated"] != true {
                return Err(response["error"]
                    .as_str()
                    .unwrap_or("Shared membership authorization failed")
                    .into());
            }
        }
        self.send(value, guard)
    }
    fn receive(&mut self) -> Result<Value> {
        self.receive_limit(512 * 1024 * 1024)
    }
    fn receive_limit(&mut self, limit: usize) -> Result<Value> {
        let size = transport::decrypt(&mut self.noise, &frame_read(&mut self.stream)?)?;
        if size.len() != 4 {
            return Err("Invalid encrypted sharing size".into());
        }
        let n = u32::from_be_bytes(size.try_into().map_err(|_| "Invalid sharing size")?) as usize;
        if n == 0 || n > limit {
            return Err("Oversized sharing message".into());
        }
        let mut data = Vec::with_capacity(n.min(MAX_PAYLOAD_BYTES));
        let deadline = Instant::now() + Duration::from_secs(120);
        while data.len() < n {
            if Instant::now() > deadline {
                return Err("Sharing transfer timed out".into());
            }
            let chunk = transport::decrypt(&mut self.noise, &frame_read(&mut self.stream)?)?;
            if chunk.is_empty() || data.len() + chunk.len() > n {
                return Err("Invalid sharing fragment".into());
            }
            data.extend(chunk);
        }
        strict_json::parse(&data)
    }
}
impl ShareService {
    fn handshake(
        &self,
        mut stream: TcpStream,
        initiator: bool,
        pin: Option<&Identity>,
    ) -> Result<Channel> {
        stream.set_nonblocking(false).map_err(|e| e.to_string())?;
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .and_then(|_| stream.set_write_timeout(Some(Duration::from_secs(10))))
            .map_err(|e| e.to_string())?;
        stream.set_nodelay(true).map_err(|e| e.to_string())?;
        let mut noise = transport::handshake(initiator, &self.private, b"museamo-shared-tags-v1")?;
        let identity = wire::canonical(&self.identity)?;
        let mut buffer = vec![0; MAX_RECORD_BYTES];
        let peer;
        if initiator {
            let n = noise
                .write_message(&[], &mut buffer)
                .map_err(|e| e.to_string())?;
            frame_write(&mut stream, &buffer[..n])?;
            let n = noise
                .read_message(&frame_read(&mut stream)?, &mut buffer)
                .map_err(|e| e.to_string())?;
            peer = serde_json::from_slice::<Identity>(&buffer[..n])
                .map_err(|_| "Invalid sharing identity")?;
            let n = noise
                .write_message(&identity, &mut buffer)
                .map_err(|e| e.to_string())?;
            frame_write(&mut stream, &buffer[..n])?;
        } else {
            noise
                .read_message(&frame_read(&mut stream)?, &mut buffer)
                .map_err(|e| e.to_string())?;
            let n = noise
                .write_message(&identity, &mut buffer)
                .map_err(|e| e.to_string())?;
            frame_write(&mut stream, &buffer[..n])?;
            let n = noise
                .read_message(&frame_read(&mut stream)?, &mut buffer)
                .map_err(|e| e.to_string())?;
            peer = serde_json::from_slice::<Identity>(&buffer[..n])
                .map_err(|_| "Invalid sharing identity")?;
        }
        if peer.device_id == self.identity.device_id
            || hex::encode(
                noise
                    .get_remote_static()
                    .ok_or("Missing sharing transport identity")?,
            ) != peer.noise_public
            || pin.is_some_and(|expected| *expected != peer)
        {
            return Err("The invitation's device identity does not match".into());
        }
        let proof = if initiator {
            json!({"hash":hex::encode(noise.get_handshake_hash()),"initiator":self.identity,"responder":peer})
        } else {
            json!({"hash":hex::encode(noise.get_handshake_hash()),"initiator":peer,"responder":self.identity})
        };
        let data = bytes(b"museamo-share-session-v1\0", &proof)?;
        let mut channel = Channel {
            stream,
            noise: noise.into_transport_mode().map_err(|e| e.to_string())?,
            peer,
        };
        let local = json!({"signature":self.sign(&data)?});
        let remote = if initiator {
            channel.send(&local, || Ok(()))?;
            channel.receive()?
        } else {
            let remote = channel.receive()?;
            channel.send(&local, || Ok(()))?;
            remote
        };
        verify(
            &channel.peer.signing_public,
            &data,
            string(&remote, "signature")?,
        )?;
        Ok(channel)
    }
    fn dial(&self, address: &str, pin: Option<&Identity>) -> Result<Channel> {
        let addr = crate::coordinator::parse_address(address)?;
        let socket = socket2::Socket::new(
            if addr.is_ipv4() {
                socket2::Domain::IPV4
            } else {
                socket2::Domain::IPV6
            },
            socket2::Type::STREAM,
            Some(socket2::Protocol::TCP),
        )
        .map_err(|e| e.to_string())?;
        #[cfg(target_os = "android")]
        {
            use std::os::fd::AsRawFd;
            self.call("syncBindSocket", json!({"fd":socket.as_raw_fd()}))?;
        }
        socket.connect_timeout(&addr.into(),Duration::from_secs(3)).map_err(|_|"The sharing phone is unreachable. Open Museamo on both phones on the same local network.")?;
        self.handshake(socket.into(), true, pin)
    }
    fn parse_invite(&self, input: &Value) -> Result<Value> {
        let text = string(input, "invite")?;
        if text.len() > 8192 {
            return Err("Invalid sharing QR code".into());
        }
        let data = hex::decode(
            text.strip_prefix("museamo-share:")
                .ok_or("This is not a Museamo sharing QR code")?,
        )
        .map_err(|_| "Invalid sharing QR code")?;
        let value = strict_json::parse(&data)?;
        if value["version"] != 1
            || value["capability"] != CAPABILITY
            || value["expiresAt"]
                .as_u64()
                .is_none_or(|n| n <= now() || n > now() + INVITE_LIFETIME + 60_000)
            || value["addresses"]
                .as_array()
                .is_none_or(|a| a.is_empty() || a.len() > 16)
            || string(&value, "token")?.len() != 64
        {
            return Err("This invitation is invalid or expired. Ask for a new QR code.".into());
        }
        Ok(value)
    }
    fn join(&self, input: &Value, accept: bool) -> Result<Value> {
        let invite = self.parse_invite(input)?;
        let pin: Identity = serde_json::from_value(invite["identity"].clone())
            .map_err(|_| "Invalid QR identity")?;
        let mut last = String::from("The sharing phone is unreachable");
        let mut connected = None;
        for address in invite["addresses"]
            .as_array()
            .ok_or("Invalid QR addresses")?
        {
            match self.dial(address.as_str().ok_or("Invalid QR address")?, Some(&pin)) {
                Ok(channel) => {
                    connected = Some(channel);
                    break;
                }
                Err(error) => last = error,
            }
        }
        let mut channel = connected.ok_or(last)?;
        let connected_address = channel
            .stream
            .peer_addr()
            .map_err(|e| e.to_string())?
            .to_string();
        let proof = self.proof(accept)?;
        channel.send(&json!({"mode":"invite","id":invite["id"],"token":invite["token"],"scope":invite["scope"],"proof":proof,"accept":accept}),||Ok(()))?;
        let result = channel.receive()?;
        if let Some(error) = result["error"].as_str() {
            return Err(error.into());
        }
        if !accept {
            return Ok(result);
        }
        let _gate = self.gate.lock().map_err(|_| "Sharing unavailable")?;
        let scope: Scope = serde_json::from_value(result["scope"].clone())
            .map_err(|_| "Invalid joined collection")?;
        if scope.id != invite["scope"] {
            return Err("The joined collection differs from the QR code".into());
        }
        let own = participant(&proof)?;
        scope.authorize(&self.personal, &own, &self.identity)?;
        let mut checked = Scope {
            controls: vec![],
            records: vec![],
            ..scope.clone()
        };
        checked.merge(&scope, &self.personal)?;
        let mut registry = self.registry.lock().map_err(|_| "Sharing unavailable")?;
        if registry
            .bindings
            .get(&scope.id)
            .is_some_and(|b| !b.detached)
        {
            return Err("You already belong to this shared hashtag".into());
        }
        let mut next = registry.clone();
        let view = checked.view(&self.personal)?;
        let grant = checked.live_grant(&view, &own)?.id.clone();
        let tag_id = local_id(&scope.id, &own, &grant);
        let mut binding = Binding {
            tag_id: tag_id.clone(),
            grant,
            ..Binding::default()
        };
        for r in checked.heads()?.values() {
            binding.entries.insert(
                r.revision.entity_id.clone(),
                local_id(
                    &scope.id,
                    &own,
                    &format!("{}:{}", tag_id, r.revision.entity_id),
                ),
            );
        }
        next.bindings.insert(scope.id.clone(), binding);
        next.scopes.insert(scope.id.clone(), checked);
        self.save(&mut next, &[])?;
        *registry = next;
        drop(registry);
        self.runtime
            .lock()
            .map_err(|_| "Sharing unavailable")?
            .nearby
            .insert(pin.device_id.clone(), connected_address);
        self.local_data_changed();
        Ok(json!({"tagId":tag_id,"collectionId":scope.id}))
    }
    fn serve(self: &Arc<Self>, stream: TcpStream) -> Result<()> {
        let mut channel = self.handshake(stream, false, None)?;
        let header = channel.receive_limit(MAX_PAYLOAD_BYTES)?;
        let bulk = matches!(header["mode"].as_str(), Some("home" | "sync"));
        let request = if bulk {
            if header["authenticate"] != true {
                return Err("Authenticate shared membership before sending collection data".into());
            }
            if let Err(error) = self.authorize_request(&channel.peer, &header) {
                channel.send(&json!({"error":error}), || Ok(()))?;
                return Ok(());
            }
            let peer = channel.peer.clone();
            channel.send(&json!({"authenticated":true}), || {
                self.fence_request(&peer, &header)
            })?;
            let request = channel.receive()?;
            if request["mode"] != header["mode"]
                || request["scope"] != header["scope"]
                || request["proof"] != header["proof"]
            {
                return Err("Sharing authorization differs from its request".into());
            }
            request
        } else {
            header
        };
        let media = request["mode"] == "mediaRead";
        let scope = request["scope"].clone();
        let proof = request["proof"].clone();
        let mut request = request;
        loop {
            match self.respond(&channel.peer, &request) {
                Ok(response) => {
                    let peer = channel.peer.clone();
                    channel.send(&response, || self.fence_request(&peer, &request))?;
                }
                Err(error) => {
                    channel.send(&json!({"error":error}), || Ok(()))?;
                    return Ok(());
                }
            }
            if !media {
                return Ok(());
            }
            request = match channel.receive_limit(MAX_PAYLOAD_BYTES) {
                Ok(request) => request,
                Err(_) => return Ok(()),
            };
            if request["mode"] != "mediaRead"
                || request["scope"] != scope
                || request["proof"] != proof
            {
                return Err("Original transfer authorization changed".into());
            }
        }
    }
    fn fence_request<'a>(&'a self, peer: &Identity, request: &Value) -> Result<TransferFence<'a>> {
        let shared = self.gate.lock().map_err(|_| "Sharing unavailable")?;
        self.authorize_request(peer, request)?;
        let personal = self.personal.sharing_fence(if request["mode"] == "home" {
            Some(peer)
        } else {
            None
        })?;
        Ok(TransferFence {
            _shared: shared,
            _personal: personal,
        })
    }
    fn fence_peer<'a>(&'a self, peer: &Identity, scope: Option<&str>) -> Result<TransferFence<'a>> {
        let shared = self.gate.lock().map_err(|_| "Sharing unavailable")?;
        self.authorize_peer(peer, scope)?;
        let personal =
            self.personal
                .sharing_fence(if scope.is_none() { Some(peer) } else { None })?;
        Ok(TransferFence {
            _shared: shared,
            _personal: personal,
        })
    }
    fn authorize_request(&self, peer: &Identity, request: &Value) -> Result<()> {
        if self.stopped.load(Ordering::SeqCst) {
            return Err("Sharing stopped".into());
        }
        if request["mode"] == "invite" {
            if request["accept"] != true {
                return Ok(());
            }
            let mut access = request.clone();
            access["mode"] = json!("sync");
            return self.authorize_request(peer, &access);
        } // Preview contains no records. Grants are checked again during transfer.
        let proof = &request["proof"];
        let own = self.proof(false)?;
        let person = participant(proof)?;
        let members = self.personal.verify_sharing_proof(proof)?;
        if members.get(&peer.device_id) != Some(peer) {
            return Err("This device was removed from its personal library".into());
        }
        if request["mode"] == "home" {
            if proof_root(&own)? != proof_root(proof)?
                || own["group"] != proof["group"]
                || self
                    .personal
                    .verify_sharing_proof(&own)?
                    .get(&peer.device_id)
                    != Some(peer)
            {
                return Err("Private sharing registry is restricted to your linked devices".into());
            }
            return Ok(());
        }
        let registry = self.registry.lock().map_err(|_| "Sharing unavailable")?;
        let scope = registry
            .scopes
            .get(string(request, "scope")?)
            .ok_or("Unknown shared collection")?;
        let mut effective = scope.clone();
        if let Some(existing) = effective.proofs.get(&person) {
            if proof_root(existing)? != proof_root(proof)? {
                return Err("Sharing participant root differs".into());
            }
            let mut merged = existing.clone();
            let controls = merged["controls"]
                .as_array_mut()
                .ok_or("Invalid stored membership")?;
            for c in proof["controls"]
                .as_array()
                .ok_or("Invalid peer membership")?
            {
                if !controls.iter().any(|old| old["id"] == c["id"]) {
                    controls.push(c.clone());
                }
            }
            effective.proofs.insert(person.clone(), merged);
        }
        if request["mode"] == "controls" {
            let view = effective.view(&self.personal)?;
            if !view.grants.values().any(|g| g.participant == person)
                || view.devices.get(&peer.device_id) != Some(&(person, peer.clone()))
            {
                return Err("Unknown sharing participant".into());
            }
            return Ok(());
        }
        effective.authorize(&self.personal, &person, peer)?;
        effective.authorize(&self.personal, &participant(&own)?, &self.identity)?;
        Ok(())
    }
    fn authorize_peer(&self, peer: &Identity, scope: Option<&str>) -> Result<()> {
        let proof = self.proof(false)?;
        let members = self.personal.verify_sharing_proof(&proof)?;
        if scope.is_none() {
            if members.get(&peer.device_id) != Some(peer) {
                return Err("This linked device was removed".into());
            }
            return Ok(());
        }
        let registry = self.registry.lock().map_err(|_| "Sharing unavailable")?;
        let scope = registry
            .scopes
            .get(scope.ok_or("Missing scope")?)
            .ok_or("Missing shared list")?;
        let view = scope.view(&self.personal)?;
        let person = &view
            .devices
            .get(&peer.device_id)
            .ok_or("Unknown shared device")?
            .0;
        scope.authorize(&self.personal, person, peer)?;
        scope.authorize(&self.personal, &participant(&proof)?, &self.identity)?;
        Ok(())
    }
    fn respond(&self, peer: &Identity, request: &Value) -> Result<Value> {
        if request["mode"] == "invite" {
            return self.redeem(peer, request);
        }
        self.flush()?;
        self.authorize_request(peer, request)?;
        if request["mode"] == "home" {
            let incoming: Registry = serde_json::from_value(request["registry"].clone())
                .map_err(|_| "Invalid personal sharing registry")?;
            self.merge_home(incoming)?;
            let registry = self.registry.lock().map_err(|_| "Sharing unavailable")?;
            return Ok(json!({"registry":*registry}));
        }
        let scope_id = string(request, "scope")?;
        match string(request, "mode")? {
            "controls" => {
                let incoming: Scope = serde_json::from_value(request["state"].clone())
                    .map_err(|_| "Invalid shared membership")?;
                if incoming.id != scope_id || !incoming.records.is_empty() {
                    return Err("Invalid membership-only transfer".into());
                }
                self.merge_scope(incoming)?;
                let registry = self.registry.lock().map_err(|_| "Sharing unavailable")?;
                let mut scope = registry
                    .scopes
                    .get(scope_id)
                    .ok_or("Unknown scope")?
                    .clone();
                scope.records.clear();
                Ok(json!({"scope":scope}))
            }
            "sync" => {
                let incoming: Scope = serde_json::from_value(request["state"].clone())
                    .map_err(|_| "Invalid shared state")?;
                if incoming.id != scope_id {
                    return Err("Wrong shared scope".into());
                }
                self.merge_scope(incoming)?;
                let registry = self.registry.lock().map_err(|_| "Sharing unavailable")?;
                Ok(json!({"scope":registry.scopes.get(scope_id)}))
            }
            "mediaRead" => {
                let _fence = self.fence_request(peer, request)?;
                self.media_authority(scope_id, string(request, "id")?)?;
                self.call("shareReadMedia", request.clone())
            }
            _ => Err("Unsupported sharing request".into()),
        }
    }
    fn redeem(&self, peer: &Identity, request: &Value) -> Result<Value> {
        let _gate = self.gate.lock().map_err(|_| "Sharing unavailable")?;
        let proof = &request["proof"];
        let accept = request["accept"]
            .as_bool()
            .ok_or("Join confirmation is required")?;
        if accept
            && self
                .personal
                .verify_sharing_proof(proof)?
                .get(&peer.device_id)
                != Some(peer)
        {
            return Err("Joining device is not in its personal library".into());
        }
        let own_proof = self.proof(false)?;
        let own = participant(&own_proof)?;
        let mut registry = self.registry.lock().map_err(|_| "Sharing unavailable")?;
        let mut runtime = self.runtime.lock().map_err(|_| "Sharing unavailable")?;
        let invitation = runtime
            .invites
            .get(string(request, "id")?)
            .ok_or("This invitation was used or cancelled. Ask for a new QR code.")?
            .clone();
        if invitation.expires <= now()
            || invitation.scope != request["scope"]
            || invitation.token_hash != wire::hash(string(request, "token")?.as_bytes())
        {
            return Err("This invitation is invalid or expired. Ask for a new QR code.".into());
        }
        let scope = registry
            .scopes
            .get(&invitation.scope)
            .ok_or("This hashtag is no longer shared")?;
        let view = scope.authorize(&self.personal, &own, &self.identity)?;
        if view.owner != own {
            return Err("Only the creator can invite people".into());
        }
        if !accept {
            return Ok(
                json!({"name":scope.tag()?["name"],"type":scope.tag()?["type"],"count":scope.heads()?.values().filter(|r|!r.revision.deleted).count(),"expiresAt":invitation.expires}),
            );
        }
        let person = participant(proof)?;
        if scope.live_grant(&view, &person).is_ok() {
            return Err("Your devices already belong to this shared hashtag".into());
        }
        let mut next = registry.clone();
        let scope = next
            .scopes
            .get_mut(&invitation.scope)
            .ok_or("Unknown shared scope")?;
        scope.proofs.insert(
            person.clone(),
            if let Some(existing) = scope.proofs.get(&person) {
                merge_proof(existing, proof)?
            } else {
                proof.clone()
            },
        );
        scope.append_control(
            &self.personal,
            &own,
            &self.identity,
            "grant",
            json!({"participant":person,"root":proof_root(proof)?,"name":peer.name}),
            |data| self.sign(data),
        )?;
        // Native storage commits the grant before the one-use bearer token is consumed.
        self.save(&mut next, &[])?;
        let response = json!({"scope":next.scopes.get(&invitation.scope)});
        *registry = next;
        runtime.invites.remove(string(request, "id")?);
        drop(runtime);
        drop(registry);
        self.local_data_changed();
        Ok(response)
    }
    fn merge_scope(&self, incoming: Scope) -> Result<()> {
        let _gate = self.gate.lock().map_err(|_| "Sharing unavailable")?;
        let proof = self.proof(false)?;
        let own = participant(&proof)?;
        let mut registry = self.registry.lock().map_err(|_| "Sharing unavailable")?;
        let mut next = registry.clone();
        let scope = next
            .scopes
            .get_mut(&incoming.id)
            .ok_or("Unknown shared scope")?;
        scope.merge(&incoming, &self.personal)?;
        self.checkpoint(scope)?;
        scope.last_sync = Some(now());
        if let Some(binding) = next.bindings.get_mut(&incoming.id) {
            for r in scope.heads()?.values() {
                binding
                    .entries
                    .entry(r.revision.entity_id.clone())
                    .or_insert_with(|| {
                        local_id(
                            &scope.id,
                            &own,
                            &format!("{}:{}", binding.tag_id, r.revision.entity_id),
                        )
                    });
            }
        }
        let changed = changed_registry(&registry, &next);
        self.save(&mut next, &[])?;
        *registry = next;
        drop(registry);
        if changed {
            self.local_data_changed();
        }
        Ok(())
    }
    fn merge_home(&self, incoming: Registry) -> Result<()> {
        let _gate = self.gate.lock().map_err(|_| "Sharing unavailable")?;
        let proof = self.proof(false)?;
        let own = participant(&proof)?;
        let mut registry = self.registry.lock().map_err(|_| "Sharing unavailable")?;
        let mut next = registry.clone();
        next.peers.extend(incoming.peers);
        for (id, remote) in incoming.scopes {
            if !remote.proofs.contains_key(&own)
                || proof_root(remote.proofs.get(&own).ok_or("Missing personal grant")?)?
                    != proof_root(&proof)?
            {
                return Err("Sharing registry belongs to another person".into());
            }
            if let Some(scope) = next.scopes.get_mut(&id) {
                scope.merge(&remote, &self.personal)?;
            } else {
                let mut scope = Scope {
                    controls: vec![],
                    records: vec![],
                    ..remote.clone()
                };
                scope.merge(&remote, &self.personal)?;
                next.scopes.insert(id.clone(), scope);
            }
            if let Some(remote_binding) = incoming.bindings.get(&id) {
                if let Some(local) = next.bindings.get_mut(&id) {
                    let view = next.scopes[&id].view(&self.personal)?;
                    if remote_binding.grant != local.grant {
                        if next.scopes[&id]
                            .live_grant(&view, &own)
                            .is_ok_and(|g| g.id == remote_binding.grant)
                        {
                            *local = remote_binding.clone();
                        }
                        continue;
                    }
                    if local.tag_id != remote_binding.tag_id
                        && !local.detached
                        && !remote_binding.detached
                    {
                        return Err("Conflicting shared-list bindings".into());
                    }
                    for (item, entry) in &remote_binding.entries {
                        local.entries.entry(item.clone()).or_insert(entry.clone());
                    }
                    local.detached |= remote_binding.detached;
                } else {
                    next.bindings.insert(id.clone(), remote_binding.clone());
                }
            }
        }
        for scope in next.scopes.values_mut() {
            if scope.proofs.contains_key(&own) {
                scope
                    .proofs
                    .insert(own.clone(), merge_proof(&scope.proofs[&own], &proof)?);
            }
            self.checkpoint(scope)?;
        }
        self.runtime
            .lock()
            .map_err(|_| "Sharing unavailable")?
            .nearby
            .extend(next.peers.clone());
        let changed = changed_registry(&registry, &next);
        self.save(&mut next, &[])?;
        *registry = next;
        drop(registry);
        if changed {
            self.local_data_changed();
        }
        Ok(())
    }
    fn media_authority(&self, scope_id: &str, id: &str) -> Result<()> {
        let registry = self.registry.lock().map_err(|_| "Sharing unavailable")?;
        let scope = registry
            .scopes
            .get(scope_id)
            .ok_or("Unknown shared scope")?;
        if !scope.records.iter().any(|r| {
            r.payload["attachments"]
                .as_array()
                .is_some_and(|a| a.iter().any(|m| m["id"] == id))
        }) {
            return Err("That original is not in this shared list".into());
        }
        Ok(())
    }
    fn discovery(self: &Arc<Self>, port: u16) -> Result<()> {
        let daemon = mdns_sd::ServiceDaemon::new().map_err(|e| e.to_string())?;
        let name = format!(
            "share-{}",
            &wire::hash(self.identity.device_id.as_bytes())[..12]
        );
        let service = mdns_sd::ServiceInfo::new(
            "_museamo-share._tcp.local.",
            &name,
            &format!("{name}.local."),
            "",
            port,
            &[
                ("device", self.identity.device_id.as_str()),
                ("capability", CAPABILITY),
            ][..],
        )
        .map_err(|e| e.to_string())?
        .enable_addr_auto();
        daemon.register(service).map_err(|e| e.to_string())?;
        let receiver = daemon
            .browse("_museamo-share._tcp.local.")
            .map_err(|e| e.to_string())?;
        *self
            .mdns
            .lock()
            .map_err(|_| "Sharing discovery unavailable")? = Some(daemon);
        let owner = self.clone();
        thread::spawn(move || {
            while !owner.stopped.load(Ordering::SeqCst) {
                if let Ok(mdns_sd::ServiceEvent::ServiceResolved(info)) =
                    receiver.recv_timeout(Duration::from_secs(1))
                {
                    if info.get_property_val_str("capability") != Some(CAPABILITY) {
                        continue;
                    }
                    let id = info.get_property_val_str("device").unwrap_or("");
                    if id.is_empty() || id == owner.identity.device_id {
                        continue;
                    }
                    if let Some(ip) = info.get_addresses().iter().find(|ip| ip.is_ipv4()) {
                        if let Ok(mut r) = owner.runtime.lock() {
                            r.nearby.insert(
                                id.into(),
                                SocketAddr::new(*ip, info.get_port()).to_string(),
                            );
                        }
                        owner.local_data_changed();
                    }
                }
            }
        });
        Ok(())
    }
    fn cycle(&self) -> Result<()> {
        self.runtime
            .lock()
            .map_err(|_| "Sharing unavailable")?
            .syncing = true;
        let result = self.cycle_inner();
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.syncing = false;
            if result.is_ok() {
                runtime.last_error = None;
            }
        }
        result
    }
    fn cycle_inner(&self) -> Result<()> {
        self.flush()?;
        let proof = self.proof(false)?;
        if proof["group"].is_null() {
            return Ok(());
        }
        let own = participant(&proof)?;
        let personal = self.personal.verify_sharing_proof(&proof)?;
        let nearby = self
            .runtime
            .lock()
            .map_err(|_| "Sharing unavailable")?
            .nearby
            .clone();
        let registry = self
            .registry
            .lock()
            .map_err(|_| "Sharing unavailable")?
            .clone();
        for (device, address) in nearby {
            if self.stopped.load(Ordering::SeqCst) {
                break;
            }
            let identity = personal.get(&device).cloned().or_else(|| {
                registry.scopes.values().find_map(|s| {
                    s.view(&self.personal)
                        .ok()?
                        .devices
                        .get(&device)
                        .map(|(_, i)| i.clone())
                })
            });
            let Some(identity) = identity else {
                continue;
            };
            if personal.contains_key(&device) {
                let mut channel = match self.dial(&address, Some(&identity)) {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                let local = self
                    .registry
                    .lock()
                    .map_err(|_| "Sharing unavailable")?
                    .clone();
                let request = json!({"mode":"home","proof":proof,"registry":local});
                channel.request(&request, || self.fence_peer(&identity, None))?;
                let result = channel.receive()?;
                if result["error"].is_null() {
                    self.merge_home(
                        serde_json::from_value(result["registry"].clone())
                            .map_err(|_| "Invalid linked-device sharing state")?,
                    )?;
                }
                continue;
            }
            for (id, _binding) in &registry.bindings {
                let scope = self
                    .registry
                    .lock()
                    .map_err(|_| "Sharing unavailable")?
                    .scopes
                    .get(id)
                    .cloned()
                    .ok_or("Missing shared list")?;
                let own_active = scope
                    .authorize(&self.personal, &own, &self.identity)
                    .is_ok();
                let person = scope
                    .view(&self.personal)?
                    .devices
                    .get(&device)
                    .map(|(p, _)| p.clone());
                let Some(person) = person else {
                    continue;
                };
                let member_active = scope.authorize(&self.personal, &person, &identity).is_ok();
                if !own_active || !member_active {
                    let mut public = scope.clone();
                    public.records.clear();
                    let request =
                        json!({"mode":"controls","scope":id,"proof":proof,"state":public});
                    if let Ok(mut c) = self.dial(&address, Some(&identity)) {
                        c.send(&request, || Ok(()))?;
                        let response = c.receive()?;
                        if response["error"].is_null() {
                            self.merge_scope(
                                serde_json::from_value(response["scope"].clone())
                                    .map_err(|_| "Invalid membership response")?,
                            )?;
                        }
                    }
                    continue;
                }
                let mut channel = match self.dial(&address, Some(&identity)) {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                let request = json!({"mode":"sync","scope":id,"proof":proof,"state":scope});
                channel.request(&request, || self.fence_peer(&identity, Some(id)))?;
                let response = channel.receive()?;
                if response["error"].is_null() {
                    self.merge_scope(
                        serde_json::from_value(response["scope"].clone())
                            .map_err(|_| "Invalid shared sync response")?,
                    )?;
                    self.pull_media(id, &proof, &identity, &address)?;
                }
            }
        }
        Ok(())
    }
    fn pull_media(&self, id: &str, proof: &Value, peer: &Identity, address: &str) -> Result<()> {
        let missing = self.call("shareMissingMedia", json!({"scope":id}))?;
        for item in missing["items"]
            .as_array()
            .ok_or("Invalid shared media queue")?
            .iter()
            .take(10)
        {
            let media = string(item, "id")?;
            let size = item["size"]
                .as_u64()
                .ok_or("Invalid shared original size")?;
            let mut offset = item["offset"].as_u64().unwrap_or(0);
            let mut channel = self.dial(address, Some(peer))?;
            while offset < size {
                let request = json!({"mode":"mediaRead","scope":id,"proof":proof,"id":media,"offset":offset,"maxBytes":16384});
                self.authorize_peer(peer, Some(id))?;
                channel.send(&request, || self.fence_peer(peer, Some(id)))?;
                let response = channel.receive()?;
                if !response["error"].is_null() {
                    break;
                }
                let bytes = string(&response, "bytes")?;
                let count = hex::decode(bytes)
                    .map_err(|_| "Invalid original bytes")?
                    .len() as u64;
                if count == 0 || offset + count > size {
                    return Err("Invalid original transfer length".into());
                }
                let _fence = self.fence_peer(peer, Some(id))?;
                self.media_authority(id, media)?;
                self.call("shareWriteMedia",json!({"scope":id,"id":media,"offset":offset,"size":size,"checksum":item["checksum"],"metadata":item["metadata"],"bytes":bytes,"eof":offset+count==size}))?;
                offset += count;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::{signature::Signer, Signature, SigningKey};
    struct Memory {
        key: SigningKey,
        identity: Value,
        data: Mutex<Value>,
    }
    impl Memory {
        fn new(n: u8) -> Arc<Self> {
            let key = SigningKey::from_bytes((&[n; 32]).into()).unwrap();
            let noise = crate::api::evaluate(&json!({"action":"newNoiseKey"})).unwrap();
            Arc::new(Self {
                identity: json!({"deviceId":format!("phone-{n}"),"name":format!("Phone {n}"),"noisePrivate":noise["private"],"noisePublic":noise["public"],"signingPublic":hex::encode(key.verifying_key().to_encoded_point(false).as_bytes())}),
                key,
                data: Mutex::new(
                    json!({"state":null,"registry":null,"pending":[],"tag":{"id":"00000000-0000-4000-a000-000000000001","name":"Movies","type":"checklist"},"entries":[{"id":"00000000-0000-4000-a000-000000000002","text":"Watch Arrival","createdAt":1,"updatedAt":1,"completed":false,"location":null,"attachments":[],"starred":true,"tagIds":["PRIVATE-TAG"],"provenance":{"label":"PRIVATE-PROFILE"}}]}),
                ),
            })
        }
    }
    impl Platform for Memory {
        fn call(&self, method: &str, input: Value) -> Result<Value> {
            if method == "syncIdentity" {
                return Ok(self.identity.clone());
            }
            if method == "syncSign" {
                let sig: Signature = self
                    .key
                    .sign(&hex::decode(input["bytes"].as_str().unwrap()).unwrap());
                return Ok(json!({"signature":hex::encode(sig.to_der().as_bytes())}));
            }
            let mut data = self.data.lock().unwrap();
            match method {
                "syncLoad" => Ok(json!({"state":data["state"]})),
                "syncSave" => {
                    data["state"] = input["state"].clone();
                    Ok(json!({}))
                }
                "syncEnroll" => {
                    data["group"] = input["groupId"].clone();
                    Ok(json!({}))
                }
                "syncSummary" => {
                    Ok(json!({"thoughts":0,"tags":0,"attachments":0,"attachmentBytes":0}))
                }
                "syncEnrollmentTags" => Ok(json!({"tags":[]})),
                "syncCoalesceTags" | "syncApply" => Ok(json!({})),
                "syncReceipts" => Ok(json!({"receipts":{},"stagedReceipts":{}})),
                "syncExport" => Ok(json!({"envelopes":[],"purgeProofs":[],"more":false})),
                "syncMissingMedia" | "shareMissingMedia" => Ok(json!({"items":[],"totalCount":0})),
                "shareLoad" => Ok(json!({"registry":data["registry"]})),
                "sharePending" => Ok(json!({"items":data["pending"]})),
                "shareSeed" => Ok(json!({"tag":data["tag"],"entries":data["entries"]})),
                "shareCommit" => {
                    let mut next = input["registry"].clone();
                    let person = input["participant"].as_str().unwrap_or("");
                    let scopes = next["scopes"].clone();
                    for (id, b) in next["bindings"].as_object_mut().unwrap() {
                        if !test_active(&scopes[id], person) {
                            b["detached"] = json!(true);
                        }
                    }
                    data["registry"] = next.clone();
                    let ack = input["ack"].as_array().unwrap();
                    data["pending"]
                        .as_array_mut()
                        .unwrap()
                        .retain(|p| !ack.iter().any(|id| *id == p["id"]));
                    Ok(json!({"registry":next}))
                }
                _ => Err(format!("Unsupported test platform callback: {method}")),
            }
        }
    }
    fn test_active(scope: &Value, person: &str) -> bool {
        let controls = scope["controls"].as_array().unwrap();
        !controls.iter().any(|c| c["body"]["kind"] == "stop")
            && controls.iter().any(|g| {
                matches!(g["body"]["kind"].as_str(), Some("open" | "grant"))
                    && g["body"]["data"]["participant"] == person
                    && !controls.iter().any(|c| {
                        matches!(c["body"]["kind"].as_str(), Some("remove" | "leave"))
                            && c["body"]["data"]["grant"] == g["id"]
                    })
            })
    }
    struct Phone {
        platform: Arc<Memory>,
        personal: Arc<Coordinator>,
        service: Arc<ShareService>,
    }
    impl Phone {
        fn new(n: u8) -> Self {
            let platform = Memory::new(n);
            let personal = Coordinator::new(platform.clone()).unwrap();
            personal.start("127.0.0.1:0").unwrap();
            let service = ShareService::new(platform.clone(), personal.clone()).unwrap();
            service.start("127.0.0.1:0").unwrap();
            Self {
                platform,
                personal,
                service,
            }
        }
        fn share(&self) -> String {
            self.service
                .command(
                    "startTagSharing",
                    json!({"tagId":"00000000-0000-4000-a000-000000000001"}),
                )
                .unwrap()["collectionId"]
                .as_str()
                .unwrap()
                .into()
        }
        fn invite(&self) -> Value {
            self.service
                .command(
                    "createTagInvite",
                    json!({"tagId":"00000000-0000-4000-a000-000000000001"}),
                )
                .unwrap()
        }
        fn join(&self, invite: &Value) -> Result<Value> {
            self.service
                .command("joinTagShare", json!({"invite":invite["invite"]}))
        }
        fn state(&self) -> Registry {
            self.service.registry.lock().unwrap().clone()
        }
        fn pending(&self, scope: &str, text: &str, deleted: bool) {
            let registry = self.state();
            let item = "00000000-0000-4000-a000-000000000002";
            let pending = json!({"id":random().unwrap(),"scope":scope,"kind":"thought","entityId":item,"localId":registry.bindings[scope].entries.get(item).cloned().unwrap_or(item.into()),"payload":{"id":item,"text":text,"createdAt":1,"updatedAt":now(),"completed":true,"location":null,"attachments":[]},"deleted":deleted,"context":registry.scopes[scope].receipts()});
            self.platform.data.lock().unwrap()["pending"]
                .as_array_mut()
                .unwrap()
                .push(pending);
            self.service.flush().unwrap();
        }
    }
    impl Drop for Phone {
        fn drop(&mut self) {
            self.service.stop();
            self.personal.stop();
        }
    }
    #[test]
    fn loopback_listener_does_not_advertise_unreachable_lan_addresses() {
        let phone = Phone::new(39);
        assert!(phone.service.mdns.lock().unwrap().is_none());
    }
    #[test]
    fn an_unknown_person_cannot_send_a_collection_body_before_authorization() {
        let owner = Phone::new(40);
        let stranger = Phone::new(41);
        let scope = owner.share();
        let proof = stranger.service.proof(true).unwrap();
        let address = owner.service.public_state().unwrap()["address"]
            .as_str()
            .unwrap()
            .to_owned();
        let mut channel = stranger
            .service
            .dial(&address, Some(&owner.service.identity))
            .unwrap();
        assert!(channel.request(&json!({"mode":"sync","scope":scope,"proof":proof,"state":{"records":"unauthorized body"}}),||Ok(())).is_err());
        assert_eq!(owner.state().scopes[&scope].records.len(), 1);
    }
    #[test]
    fn invitation_is_one_use_and_private_fields_never_enter_the_journal() {
        let a = Phone::new(20);
        let b = Phone::new(21);
        let c = Phone::new(22);
        let scope = a.share();
        let invite = a.invite();
        let preview = b
            .service
            .command("previewTagInvite", json!({"invite":invite["invite"]}))
            .unwrap();
        assert_eq!(preview["name"], "Movies");
        assert!(preview.get("scope").is_none());
        b.join(&invite).unwrap();
        assert!(c.join(&invite).is_err());
        let data = serde_json::to_string(&b.state().scopes[&scope]).unwrap();
        assert!(!data.contains("PRIVATE-TAG"));
        assert!(!data.contains("PRIVATE-PROFILE"));
        assert!(!data.contains("starred"));
        assert_eq!(
            b.state().scopes[&scope]
                .heads()
                .unwrap()
                .values()
                .next()
                .unwrap()
                .payload["text"],
            "Watch Arrival"
        );
    }
    #[test]
    fn cancelled_expired_malformed_and_wrong_identity_invitations_fail() {
        let a = Phone::new(23);
        let b = Phone::new(24);
        a.share();
        let invite = a.invite();
        a.service
            .command("cancelTagInvite", json!({"inviteId":invite["inviteId"]}))
            .unwrap();
        assert!(b.join(&invite).is_err());
        assert!(b.join(&json!({"invite":"not-museamo"})).is_err());
        let invite = a.invite();
        let mut decoded = a
            .service
            .parse_invite(&json!({"invite":invite["invite"]}))
            .unwrap();
        decoded["expiresAt"] = json!(1);
        let expired = json!({"invite":format!("museamo-share:{}",hex::encode(wire::canonical(&decoded).unwrap()))});
        assert!(b.join(&expired).is_err());
        decoded["expiresAt"] = invite["expiresAt"].clone();
        decoded["identity"]["signingPublic"] = b.platform.identity["signingPublic"].clone();
        assert!(b.join(&json!({"invite":format!("museamo-share:{}",hex::encode(wire::canonical(&decoded).unwrap()))})).is_err());
    }
    #[test]
    fn shared_changes_converge_without_crossing_personal_libraries() {
        let a = Phone::new(25);
        let b = Phone::new(26);
        let scope = a.share();
        b.join(&a.invite()).unwrap();
        a.pending(&scope, "Watch Interstellar", false);
        b.pending(&scope, "Watch Dune", false);
        let mut left = a.state().scopes[&scope].clone();
        let right = b.state().scopes[&scope].clone();
        left.merge(&right, &a.personal).unwrap();
        let mut merged = right.clone();
        merged.merge(&left, &b.personal).unwrap();
        assert_eq!(
            left.heads().unwrap().values().next().unwrap().payload,
            merged.heads().unwrap().values().next().unwrap().payload
        );
        assert_ne!(
            a.personal.sharing_proof(false).unwrap()["group"],
            b.personal.sharing_proof(false).unwrap()["group"]
        );
        assert_eq!(
            a.personal.command("listDevices", json!({})).unwrap()["devices"],
            json!([])
        );
    }
    #[test]
    fn members_cannot_grant_rename_or_remove_the_creator() {
        let a = Phone::new(27);
        let b = Phone::new(28);
        let scope = a.share();
        let result = b.join(&a.invite()).unwrap();
        assert!(b
            .service
            .command("createTagInvite", json!({"tagId":result["tagId"]}))
            .is_err());
        let mut state = b.state().scopes[&scope].clone();
        let proof = b.personal.sharing_proof(false).unwrap();
        let person = participant(&proof).unwrap();
        assert!(state
            .append_control(
                &b.personal,
                &person,
                &b.service.identity,
                "metadata",
                json!({"id":"tag","name":"Stolen","type":"standard"}),
                |bytes| b.service.sign(bytes)
            )
            .is_err());
    }
    #[test]
    fn deleting_wins_concurrent_edits_and_unrelated_originals_are_denied() {
        let a = Phone::new(29);
        let b = Phone::new(30);
        let scope = a.share();
        b.join(&a.invite()).unwrap();
        a.pending(&scope, "Delete me", true);
        b.pending(&scope, "Concurrent edit", false);
        let mut state = a.state().scopes[&scope].clone();
        state.merge(&b.state().scopes[&scope], &a.personal).unwrap();
        assert!(
            state
                .heads()
                .unwrap()
                .values()
                .next()
                .unwrap()
                .revision
                .deleted
        );
        assert!(a.service.media_authority(&scope, "PRIVATE-MEDIA").is_err());
    }
    #[test]
    fn leave_preserves_a_detached_binding_and_fresh_invitation_can_rejoin() {
        let a = Phone::new(31);
        let b = Phone::new(32);
        let scope = a.share();
        let first = b.join(&a.invite()).unwrap();
        b.service
            .command("leaveTagShare", json!({"tagId":first["tagId"]}))
            .unwrap();
        assert!(b.state().bindings[&scope].detached);
        a.service
            .merge_scope(b.state().scopes[&scope].clone())
            .unwrap();
        let second = b.join(&a.invite()).unwrap();
        assert_ne!(first["tagId"], second["tagId"]);
        assert!(!b.state().bindings[&scope].detached);
    }
    #[test]
    fn concurrent_invitation_claims_have_one_winner() {
        let a = Phone::new(33);
        let b = Phone::new(34);
        let c = Phone::new(35);
        a.share();
        let invite = a.invite();
        let one = b.service.clone();
        let two = c.service.clone();
        let first = invite.clone();
        let second = invite.clone();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let gate = barrier.clone();
        let left = thread::spawn(move || {
            gate.wait();
            one.command("joinTagShare", json!({"invite":first["invite"]}))
        });
        let right = thread::spawn(move || {
            barrier.wait();
            two.command("joinTagShare", json!({"invite":second["invite"]}))
        });
        assert_ne!(left.join().unwrap().is_ok(), right.join().unwrap().is_ok());
    }
    #[test]
    fn scoped_recovery_clearance_keeps_original_signed_headers() {
        let a = Phone::new(36);
        let b = Phone::new(37);
        let id = a.share();
        b.join(&a.invite()).unwrap();
        a.pending(&id, "New title", false);
        let mut state = a.state().scopes[&id].clone();
        let original = state.records[0].clone();
        let hash = record_hash(&original).unwrap();
        let person = participant(&a.service.proof(false).unwrap()).unwrap();
        state
            .purge_recovery(
                &a.personal,
                &person,
                &a.service.identity,
                &original.revision.id(),
                |data| a.service.sign(data),
            )
            .unwrap();
        assert!(state.records[0].payload.is_null());
        assert_eq!(record_hash(&state.records[0]).unwrap(), hash);
        let mut remote = b.state().scopes[&id].clone();
        remote.merge(&state, &b.personal).unwrap();
        assert!(remote.records[0].payload.is_null());
        assert_eq!(
            remote.heads().unwrap().values().next().unwrap().payload["text"],
            "New title"
        );
    }
    #[test]
    fn revoked_participant_cannot_witness_their_own_unseen_writes() {
        let a = Phone::new(38);
        let b = Phone::new(39);
        let id = a.share();
        let joined = b.join(&a.invite()).unwrap();
        let before = b.state().scopes[&id].clone();
        b.service
            .command("leaveTagShare", json!({"tagId":joined["tagId"]}))
            .unwrap();
        a.service
            .merge_scope(b.state().scopes[&id].clone())
            .unwrap();
        let own = participant(&b.service.proof(false).unwrap()).unwrap();
        let mut forged = before;
        forged.append_record(&b.personal,&own,&b.service.identity,&json!({"entityId":"00000000-0000-4000-a000-000000000002","payload":{"id":"00000000-0000-4000-a000-000000000002","text":"Unauthorized","createdAt":1,"updatedAt":2,"completed":false,"location":null,"attachments":[]}}),now(),|data|b.service.sign(data)).unwrap();
        b.service
            .witness(&mut forged, &own, "personal:forged")
            .unwrap();
        a.service.merge_scope(forged).unwrap();
        assert_eq!(a.state().scopes[&id].records.len(), 1);
    }
}
