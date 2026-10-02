//! Isolated shared collections. The personal journal is never an input to this protocol.
//! Only native Platform callbacks can persist/project records or read original bytes.
mod service;
pub use service::{projections, ShareService};

use crate::{
    coordinator::{Coordinator, Identity},
    model::{winner, Context, Dot, Revision},
    wire, MAX_PAYLOAD_BYTES,
};
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub const CAPABILITY: &str = "shared-tags-v1";
pub const INVITE_LIFETIME: u64 = 300_000;
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Registry {
    #[serde(default)]
    pub scopes: BTreeMap<String, Scope>,
    #[serde(default)]
    pub bindings: BTreeMap<String, Binding>,
    #[serde(default)]
    pub peers: BTreeMap<String, String>,
}
#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub tag_id: String,
    #[serde(default)]
    pub grant: String,
    #[serde(default)]
    pub entries: BTreeMap<String, String>,
    #[serde(default)]
    pub detached: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    pub id: String,
    pub controls: Vec<SignedControl>,
    pub proofs: BTreeMap<String, Value>,
    #[serde(default)]
    pub records: Vec<Record>,
    #[serde(default)]
    pub last_sync: Option<u64>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlBody {
    pub scope: String,
    pub issuer: String,
    pub participant: String,
    pub parents: Vec<String>,
    pub kind: String,
    pub data: Value,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedControl {
    pub id: String,
    pub body: ControlBody,
    pub signature: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub scope: String,
    pub participant: String,
    pub grant: String,
    pub previous_hash: String,
    pub kind: String,
    pub revision: Revision,
    pub payload: Value,
    pub signature: String,
}
#[derive(Clone, Debug)]
pub struct Grant {
    pub id: String,
    pub participant: String,
    pub root: String,
    pub name: String,
}
#[derive(Default)]
pub struct View {
    pub owner: String,
    pub stopped: bool,
    pub grants: BTreeMap<String, Grant>,
    pub revoked: BTreeSet<String>,
    pub devices: BTreeMap<String, (String, Identity)>,
}
fn surviving_witness(view: &View, issuer: &str) -> bool {
    view.devices.get(issuer).is_some_and(|(participant, _)| {
        view.grants
            .values()
            .any(|g| g.participant == *participant && !view.revoked.contains(&g.id))
    })
}

pub fn bytes(domain: &[u8], body: &impl Serialize) -> Result<Vec<u8>> {
    let mut data = domain.to_vec();
    data.extend(wire::canonical(body)?);
    Ok(data)
}
fn verify(key: &str, data: &[u8], signature: &str) -> Result<()> {
    let key = VerifyingKey::from_sec1_bytes(&hex::decode(key).map_err(|_| "Invalid sharing key")?)
        .map_err(|_| "Invalid sharing key")?;
    let sig =
        Signature::from_der(&hex::decode(signature).map_err(|_| "Invalid sharing signature")?)
            .map_err(|_| "Invalid sharing signature")?;
    key.verify(data, &sig)
        .map_err(|_| "Sharing signature verification failed".into())
}
pub fn proof_root(proof: &Value) -> Result<String> {
    let roots = proof["controls"]
        .as_array()
        .ok_or("Missing personal-library proof")?
        .iter()
        .filter(|c| c["body"]["kind"] == "genesis")
        .collect::<Vec<_>>();
    if roots.len() != 1 {
        return Err("Invalid personal-library root".into());
    }
    Ok(roots[0]["id"]
        .as_str()
        .ok_or("Invalid personal-library root")?
        .into())
}
fn string<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value[name]
        .as_str()
        .ok_or_else(|| format!("Invalid shared {name}"))
}
fn grant(control: &SignedControl) -> Result<Grant> {
    Ok(Grant {
        id: control.id.clone(),
        participant: string(&control.body.data, "participant")?.into(),
        root: string(&control.body.data, "root")?.into(),
        name: string(&control.body.data, "name")?
            .chars()
            .take(128)
            .collect(),
    })
}
fn valid_tag(payload: &Value) -> Result<()> {
    let name = string(payload, "name")?;
    if name.trim() != name
        || name.is_empty()
        || name.encode_utf16().count() > 80
        || !matches!(string(payload, "type")?, "standard" | "checklist")
    {
        return Err("Invalid shared hashtag".into());
    }
    Ok(())
}

/// Union proofs monotonically: a stale personal coordinator cannot resurrect removed devices.
pub fn merge_proof(existing: &Value, incoming: &Value) -> Result<Value> {
    if existing["group"] != incoming["group"] || proof_root(existing)? != proof_root(incoming)? {
        return Err("Sharing participant root differs".into());
    }
    let mut merged = existing.clone();
    let controls = merged["controls"]
        .as_array_mut()
        .ok_or("Invalid stored membership")?;
    for c in incoming["controls"]
        .as_array()
        .ok_or("Invalid membership proof")?
    {
        if let Some(old) = controls.iter().find(|old| old["id"] == c["id"]) {
            if old != c {
                return Err("Conflicting personal membership proof".into());
            }
        } else {
            controls.push(c.clone());
        }
    }
    Coordinator::sharing_members(&merged)?;
    Ok(merged)
}
pub fn device_active(proof: &Value, personal: &Value, device: &str) -> Result<bool> {
    let proof = if personal["groupId"] == proof["group"] && personal["controls"].is_array() {
        merge_proof(
            proof,
            &json!({"group":personal["groupId"],"controls":personal["controls"]}),
        )?
    } else {
        proof.clone()
    };
    Ok(Coordinator::sharing_members(&proof)?.contains_key(device))
}
impl Scope {
    /// Validate all public participant proofs and all controls before accepting any payload.
    pub fn view(&self, personal: &Coordinator) -> Result<View> {
        if self.controls.is_empty() || self.controls.len() > 8192 || self.proofs.len() > 128 {
            return Err("Invalid shared membership size".into());
        }
        let mut view = View::default();
        let mut identities = BTreeMap::new();
        for (participant, proof) in &self.proofs {
            if proof["group"].as_str() != Some(participant) {
                return Err("Shared participant identity differs".into());
            }
            // The home-library protocol already verifies removed-device and descendant fencing.
            for (id, identity) in personal.verify_sharing_proof(proof)? {
                if identities
                    .insert(id, (participant.clone(), identity))
                    .is_some()
                {
                    return Err("Device belongs to multiple sharing participants".into());
                }
            }
        }
        let mut accepted: BTreeMap<String, &SignedControl> = BTreeMap::new();
        let mut pending = self.controls.iter().collect::<Vec<_>>();
        while !pending.is_empty() {
            let before = pending.len();
            let mut next = vec![];
            for control in pending {
                let body = &control.body;
                if body.scope != self.id
                    || body.parents.len() > 8192
                    || control.id != wire::hash(&wire::canonical(body)?)
                {
                    return Err("Invalid shared control".into());
                }
                if let Some(old) = accepted.get(&control.id) {
                    if *old != control {
                        return Err("Conflicting shared control".into());
                    }
                    continue;
                }
                if body.parents.iter().any(|id| !accepted.contains_key(id)) {
                    next.push(control);
                    continue;
                }
                let proof = self
                    .proofs
                    .get(&body.participant)
                    .ok_or("Unknown sharing participant")?;
                // A removed personal device may verify historical signatures, but cannot gain live access.
                let key = historical_identity(proof, &body.issuer)?;
                verify(
                    &key.signing_public,
                    &bytes(b"museamo-share-control-v1\0", body)?,
                    &control.signature,
                )?;
                let ancestors = control_ancestors(&accepted, &body.parents);
                let owner = ancestors
                    .iter()
                    .find(|c| c.body.kind == "open")
                    .map(|c| c.body.participant.as_str());
                let observed_grant = ancestors.iter().any(|c| {
                    matches!(c.body.kind.as_str(), "open" | "grant")
                        && c.body.data["participant"] == body.participant
                });
                let live_ancestor_grant = ancestors.iter().any(|g| {
                    matches!(g.body.kind.as_str(), "open" | "grant")
                        && g.body.data["participant"] == body.participant
                        && !ancestors.iter().any(|r| {
                            matches!(r.body.kind.as_str(), "remove" | "leave")
                                && r.body.data["grant"] == g.id
                        })
                });
                if body.kind != "open"
                    && (!live_ancestor_grant
                        || body.kind != "checkpoint"
                            && ancestors.iter().any(|c| c.body.kind == "stop"))
                {
                    return Err("A revoked participant cannot create shared controls".into());
                }
                match body.kind.as_str() {
                    "open" => {
                        if !accepted.is_empty() || !body.parents.is_empty() || view.owner != "" {
                            return Err("Duplicate shared root".into());
                        }
                        valid_tag(&body.data["tag"])?;
                        let root = grant(control)?;
                        if root.participant != body.participant || root.root != proof_root(proof)? {
                            return Err("Invalid creator grant".into());
                        }
                        view.owner = root.participant.clone();
                        view.grants.insert(control.id.clone(), root);
                    }
                    "grant" => {
                        if owner != Some(body.participant.as_str()) {
                            return Err("Only the creator can invite people".into());
                        }
                        let g = grant(control)?;
                        if proof_root(
                            self.proofs
                                .get(&g.participant)
                                .ok_or("Missing joining participant proof")?,
                        )? != g.root
                        {
                            return Err("Joining participant root differs".into());
                        }
                        view.grants.insert(control.id.clone(), g);
                    }
                    "remove" => {
                        if owner != Some(body.participant.as_str()) {
                            return Err("Only the creator can remove people".into());
                        }
                        let id = string(&body.data, "grant")?;
                        if !ancestors
                            .iter()
                            .any(|c| c.id == id && c.body.kind == "grant")
                        {
                            return Err("Unknown member grant".into());
                        }
                        view.revoked.insert(id.into());
                    }
                    "leave" => {
                        let id = string(&body.data, "grant")?;
                        if !ancestors
                            .iter()
                            .any(|c| c.id == id && c.body.data["participant"] == body.participant)
                        {
                            return Err("Cannot revoke another person's access".into());
                        }
                        view.revoked.insert(id.into());
                    }
                    "stop" | "metadata" => {
                        if owner != Some(body.participant.as_str()) {
                            return Err("Only the creator can manage this hashtag".into());
                        }
                        if body.kind == "metadata" {
                            valid_tag(&body.data)?;
                        } else {
                            view.stopped = true;
                        }
                    }
                    "checkpoint" => {
                        if !observed_grant {
                            return Err("Unknown sharing witness".into());
                        }
                        let removal = string(&body.data, "removal")?;
                        if !removal.starts_with("personal:")
                            && !ancestors.iter().any(|c| {
                                c.id == removal
                                    && matches!(c.body.kind.as_str(), "remove" | "leave" | "stop")
                            })
                        {
                            return Err("Unknown sharing removal".into());
                        }
                        let _: Context = serde_json::from_value(body.data["receipts"].clone())
                            .map_err(|_| "Invalid sharing checkpoint")?;
                    }
                    "purge" => {
                        if body.data["headers"]
                            .as_object()
                            .is_none_or(|a| a.is_empty() || a.len() > 10000)
                            || !body.data["entityIds"].is_array()
                        {
                            return Err("Invalid shared Recovery clearance".into());
                        }
                    }
                    _ => return Err("Unsupported shared control".into()),
                }
                accepted.insert(control.id.clone(), control);
            }
            if next.len() == before {
                return Err("Cyclic or incomplete shared membership".into());
            }
            pending = next;
        }
        for g in view.grants.values() {
            if proof_root(
                self.proofs
                    .get(&g.participant)
                    .ok_or("Missing sharing participant")?,
            )? != g.root
            {
                return Err("Personal-library root changed".into());
            }
        }
        view.devices = identities;
        Ok(view)
    }
    pub fn live_grant<'a>(&self, view: &'a View, participant: &str) -> Result<&'a Grant> {
        if view.stopped {
            return Err("This hashtag is no longer shared".into());
        }
        view.grants
            .values()
            .filter(|g| g.participant == participant && !view.revoked.contains(&g.id))
            .min_by_key(|g| &g.id)
            .ok_or("You no longer belong to this shared hashtag".into())
    }
    pub fn authorize(
        &self,
        personal: &Coordinator,
        participant: &str,
        device: &Identity,
    ) -> Result<View> {
        let view = self.view(personal)?;
        self.live_grant(&view, participant)?;
        if view.devices.get(&device.device_id) != Some(&(participant.to_owned(), device.clone())) {
            return Err("This device was removed from its personal library".into());
        }
        Ok(view)
    }
    pub fn receipts(&self) -> Context {
        let mut grouped: BTreeMap<String, BTreeSet<u64>> = BTreeMap::new();
        for r in &self.records {
            grouped
                .entry(r.revision.dot.origin.clone())
                .or_default()
                .insert(r.revision.dot.sequence);
        }
        grouped
            .into_iter()
            .map(|(origin, sequences)| {
                let mut n = 0;
                while sequences.contains(&(n + 1)) {
                    n += 1;
                }
                (origin, n)
            })
            .collect()
    }
    pub fn heads(&self) -> Result<BTreeMap<String, &Record>> {
        let mut entities: BTreeMap<String, Vec<&Record>> = BTreeMap::new();
        for record in &self.records {
            entities
                .entry(format!("{}:{}", record.kind, record.revision.entity_id))
                .or_default()
                .push(record);
        }
        let mut heads = BTreeMap::new();
        for (id, records) in entities {
            let revisions = records
                .iter()
                .map(|r| r.revision.clone())
                .collect::<Vec<_>>();
            let retired = self.controls.iter().any(|c| {
                c.body.kind == "purge"
                    && c.body.data["entityIds"]
                        .as_array()
                        .is_some_and(|a| a.iter().any(|v| v == &revisions[0].entity_id))
            });
            if let Some(w) = winner(&revisions, retired)? {
                heads.insert(
                    id,
                    records
                        .iter()
                        .find(|r| r.revision.dot == w.dot)
                        .copied()
                        .ok_or("Missing shared winner")?,
                );
            }
        }
        Ok(heads)
    }
    pub fn tag(&self) -> Result<Value> {
        // Metadata controls are causally ordered; deterministic concurrent creator-device edits.
        let mut candidates = self
            .controls
            .iter()
            .filter(|c| c.body.kind == "metadata")
            .collect::<Vec<_>>();
        let all = self.controls.iter().map(|c| (c.id.clone(), c)).collect();
        candidates.retain(|c| {
            !self.controls.iter().any(|other| {
                other.body.kind == "metadata"
                    && other.id != c.id
                    && control_ancestors(&all, &other.body.parents)
                        .iter()
                        .any(|ancestor| ancestor.id == c.id)
            })
        });
        candidates.sort_by_key(|c| &c.id);
        Ok(candidates
            .last()
            .map(|c| c.body.data.clone())
            .unwrap_or_else(|| {
                self.controls
                    .iter()
                    .find(|c| c.body.kind == "open")
                    .map(|c| c.body.data["tag"].clone())
                    .unwrap_or(Value::Null)
            }))
    }
    pub fn append_control(
        &mut self,
        personal: &Coordinator,
        participant: &str,
        device: &Identity,
        kind: &str,
        data: Value,
        sign: impl FnOnce(&[u8]) -> Result<String>,
    ) -> Result<()> {
        if kind != "open" {
            self.authorize(personal, participant, device)?;
        }
        let body = ControlBody {
            scope: self.id.clone(),
            issuer: device.device_id.clone(),
            participant: participant.into(),
            parents: self.controls.iter().map(|c| c.id.clone()).collect(),
            kind: kind.into(),
            data,
        };
        let signature = sign(&bytes(b"museamo-share-control-v1\0", &body)?)?;
        self.controls.push(SignedControl {
            id: wire::hash(&wire::canonical(&body)?),
            body,
            signature,
        });
        self.view(personal)?;
        Ok(())
    }
    pub fn apply_purges(&mut self) -> Result<()> {
        for c in self.controls.iter().filter(|c| c.body.kind == "purge") {
            for (id, hash) in c.body.data["headers"]
                .as_object()
                .ok_or("Invalid Recovery clearance")?
            {
                if let Some(r) = self.records.iter_mut().find(|r| r.revision.id() == *id) {
                    if hash != &record_hash(r)? {
                        return Err("Shared Recovery header differs".into());
                    }
                    r.payload = Value::Null;
                }
            }
        }
        Ok(())
    }
    pub fn purge_recovery(
        &mut self,
        personal: &Coordinator,
        participant: &str,
        device: &Identity,
        id: &str,
        sign: impl FnOnce(&[u8]) -> Result<String>,
    ) -> Result<()> {
        let target = self
            .records
            .iter()
            .find(|r| r.revision.id() == id)
            .ok_or("Shared Recovery version no longer exists")?;
        let entity = target.revision.entity_id.clone();
        let heads = self.heads()?;
        let head = heads.get(&format!("thought:{entity}"));
        if head.is_some_and(|r| !r.revision.deleted && r.revision.id() == id) {
            return Err("Current shared content cannot be cleared as Recovery".into());
        }
        let retired = head.is_none_or(|r| r.revision.deleted);
        let mut headers = json!({});
        for r in &self.records {
            if r.revision.id() == id || retired && r.revision.entity_id == entity {
                headers[r.revision.id()] = json!(record_hash(r)?);
            }
        }
        self.append_control(
            personal,
            participant,
            device,
            "purge",
            json!({"headers":headers,"entityIds":if retired{vec![entity]}else{vec![]}}),
            sign,
        )?;
        self.apply_purges()
    }
    pub fn append_record(
        &mut self,
        personal: &Coordinator,
        participant: &str,
        device: &Identity,
        pending: &Value,
        time: u64,
        sign: impl FnOnce(&[u8]) -> Result<String>,
    ) -> Result<()> {
        let view = self.authorize(personal, participant, device)?;
        let grant = self.live_grant(&view, participant)?.id.clone();
        let mut payload = shared_payload(&pending["payload"])?;
        let entity = string(pending, "entityId")?.to_string();
        payload["id"] = json!(entity);
        let origin = device.device_id.clone();
        let receipts = self.receipts();
        let sequence = receipts.get(&origin).copied().unwrap_or(0) + 1;
        let previous = self
            .records
            .iter()
            .find(|r| r.revision.dot.origin == origin && r.revision.dot.sequence == sequence - 1);
        let clock = previous
            .map(|r| r.revision.clock)
            .unwrap_or_default()
            .tick(
                time,
                self.records
                    .iter()
                    .max_by_key(|r| r.revision.clock)
                    .map(|r| r.revision.clock),
            )?;
        let mut context: Context =
            serde_json::from_value(pending.get("context").cloned().unwrap_or(json!({})))
                .map_err(|_| "Invalid shared save context")?;
        if let Some(previous) = previous {
            for (origin, sequence) in &previous.revision.context {
                let current = context.entry(origin.clone()).or_default();
                *current = (*current).max(*sequence);
            }
        }
        context.insert(origin.clone(), sequence - 1);
        let revision = Revision {
            entity_id: entity,
            dot: Dot { origin, sequence },
            context,
            clock,
            deleted: pending["deleted"].as_bool().unwrap_or(false),
            payload_hash: wire::hash(&wire::canonical(&payload)?),
        };
        let mut record = Record {
            scope: self.id.clone(),
            participant: participant.into(),
            grant,
            previous_hash: previous.map(record_hash).transpose()?.unwrap_or_default(),
            kind: "thought".into(),
            revision,
            payload,
            signature: String::new(),
        };
        record.signature = sign(&record_bytes(&record)?)?;
        self.records.push(record);
        Ok(())
    }
    pub fn merge(&mut self, other: &Scope, personal: &Coordinator) -> Result<()> {
        if other.id != self.id {
            return Err("Wrong shared collection".into());
        }
        let mut next = self.clone();
        for (participant, proof) in &other.proofs {
            if let Some(existing) = next.proofs.get(participant) {
                next.proofs
                    .insert(participant.clone(), merge_proof(existing, proof)?);
            } else {
                personal.verify_sharing_proof(proof)?;
                next.proofs.insert(participant.clone(), proof.clone());
            }
        }
        for c in &other.controls {
            if let Some(old) = next.controls.iter().find(|old| old.id == c.id) {
                if old != c {
                    return Err("Conflicting sharing control".into());
                }
            } else {
                next.controls.push(c.clone());
            }
        }
        let view = next.view(personal)?;
        for incoming in &other.controls {
            if self.controls.iter().any(|c| c.id == incoming.id)
                || view.devices.contains_key(&incoming.body.issuer)
            {
                continue;
            }
            if !next.controls.iter().any(|c| {
                c.body.kind == "checkpoint"
                    && surviving_witness(&view, &c.body.issuer)
                    && c.body.data["controlHeaders"][&incoming.id]
                        == wire::hash(&wire::canonical(incoming).unwrap_or_default())
            }) {
                return Err(
                    "New control from a removed personal device has no surviving witness".into(),
                );
            }
        }
        for incoming in &other.records {
            if let Some(old) = next
                .records
                .iter()
                .find(|r| r.revision.dot == incoming.revision.dot)
            {
                if record_hash(old)? != record_hash(incoming)? {
                    return Err("Conflicting shared origin sequence".into());
                }
                continue;
            }
            validate_record(incoming, &next, &view)?;
            // New records from revoked grants are accepted only when a surviving witness
            // committed to this exact historical chain before observing removal.
            let inactive = view.stopped
                || view.revoked.contains(&incoming.grant)
                || !view.devices.contains_key(&incoming.revision.dot.origin);
            if inactive
                && !next
                    .controls
                    .iter()
                    .filter(|c| {
                        c.body.kind == "checkpoint" && surviving_witness(&view, &c.body.issuer)
                    })
                    .any(|c| {
                        c.body.data["headers"][&incoming.revision.dot.origin]
                            [incoming.revision.dot.sequence.to_string()]
                            == record_hash(incoming).unwrap_or_default()
                    })
            {
                continue;
            }
            next.records.push(incoming.clone());
        }
        // Receipts cannot jump gaps, and no signed prefix can change its predecessor.
        for r in &next.records {
            if r.revision.dot.sequence == 1 {
                if !r.previous_hash.is_empty() {
                    return Err("Invalid shared origin root".into());
                }
            } else {
                let previous = next
                    .records
                    .iter()
                    .find(|p| {
                        p.revision.dot.origin == r.revision.dot.origin
                            && p.revision.dot.sequence + 1 == r.revision.dot.sequence
                    })
                    .ok_or("Missing shared origin predecessor")?;
                if r.previous_hash != record_hash(previous)? {
                    return Err("Broken shared origin chain".into());
                }
                if previous
                    .revision
                    .context
                    .iter()
                    .any(|(origin, n)| r.revision.context.get(origin).copied().unwrap_or(0) < *n)
                {
                    return Err("Shared origin drops earlier causal history".into());
                }
            }
        }
        // Projection requires full causal closure; out-of-order pages are staged by service.
        let receipts = next.receipts();
        if next.records.iter().any(|r| {
            r.revision
                .context
                .iter()
                .any(|(origin, n)| receipts.get(origin).copied().unwrap_or(0) < *n)
        }) {
            return Err("Shared records need their causal predecessors".into());
        }
        next.apply_purges()?;
        next.heads()?;
        *self = next;
        Ok(())
    }
}
fn historical_identity(proof: &Value, id: &str) -> Result<Identity> {
    proof["controls"]
        .as_array()
        .ok_or("Invalid personal proof")?
        .iter()
        .find(|c| {
            matches!(c["body"]["kind"].as_str(), Some("genesis" | "admit"))
                && c["body"]["data"]["deviceId"] == id
        })
        .map(|c| {
            serde_json::from_value(c["body"]["data"].clone())
                .map_err(|_| "Invalid historical device".into())
        })
        .unwrap_or(Err("Unknown historical device".into()))
}
fn control_ancestors<'a>(
    all: &BTreeMap<String, &'a SignedControl>,
    parents: &[String],
) -> Vec<&'a SignedControl> {
    let mut seen = BTreeSet::new();
    let mut pending = parents.to_vec();
    while let Some(id) = pending.pop() {
        if seen.insert(id.clone()) {
            if let Some(c) = all.get(&id) {
                pending.extend(c.body.parents.clone());
            }
        }
    }
    seen.into_iter()
        .filter_map(|id| all.get(&id).copied())
        .collect()
}
pub fn record_bytes(record: &Record) -> Result<Vec<u8>> {
    let mut value = serde_json::to_value(record).map_err(|e| e.to_string())?;
    let object = value.as_object_mut().ok_or("Invalid shared record")?;
    object.remove("signature");
    object.remove("payload");
    bytes(b"museamo-share-record-v1\0", &value)
}
pub fn record_hash(record: &Record) -> Result<String> {
    let mut value = serde_json::to_value(record).map_err(|e| e.to_string())?;
    value
        .as_object_mut()
        .ok_or("Invalid shared record")?
        .remove("payload");
    Ok(wire::hash(&wire::canonical(&value)?))
}
fn validate_record(r: &Record, scope: &Scope, view: &View) -> Result<()> {
    if r.scope != scope.id
        || r.kind != "thought"
        || r.revision.dot.sequence == 0
        || r.revision.context.len() > 128
        || r.revision
            .context
            .get(&r.revision.dot.origin)
            .copied()
            .unwrap_or(0)
            != r.revision.dot.sequence - 1
        || r.revision.clock.wall > crate::MAX_TIMESTAMP
    {
        return Err("Invalid scoped shared revision".into());
    }
    let g = view.grants.get(&r.grant).ok_or("Unknown shared grant")?;
    if g.participant != r.participant {
        return Err("Shared record signer has the wrong grant".into());
    }
    let proof = scope
        .proofs
        .get(&r.participant)
        .ok_or("Unknown shared signer")?;
    let identity = historical_identity(proof, &r.revision.dot.origin)?;
    verify(&identity.signing_public, &record_bytes(r)?, &r.signature)?;
    if r.payload.is_null() {
        if !scope.controls.iter().any(|c| {
            c.body.kind == "purge"
                && c.body.data["headers"][r.revision.id()] == record_hash(r).unwrap_or_default()
        }) {
            return Err("Erased shared body has no signed clearance".into());
        }
    } else if shared_payload(&r.payload)? != r.payload
        || r.payload["id"] != r.revision.entity_id
        || wire::hash(&wire::canonical(&r.payload)?) != r.revision.payload_hash
    {
        return Err("Invalid shared payload digest".into());
    }
    Ok(())
}
/// Explicit allowlist: no private tag IDs, stars, provenance, profiles, drafts, or history.
pub fn shared_payload(input: &Value) -> Result<Value> {
    let mut output = json!({});
    for name in [
        "id",
        "text",
        "createdAt",
        "updatedAt",
        "completed",
        "location",
        "attachments",
    ] {
        if let Some(value) = input.get(name) {
            output[name] = value.clone();
        }
    }
    if output["id"].as_str().is_none()
        || output["text"].as_str().is_none()
        || output["completed"].as_bool().is_none()
        || output["createdAt"].as_u64().is_none()
        || output["updatedAt"].as_u64().is_none()
        || !output["attachments"].is_array()
    {
        return Err("Invalid shared thought".into());
    }
    uuid(string(&output, "id")?)?;
    for key in ["createdAt", "updatedAt"] {
        if output[key]
            .as_u64()
            .is_none_or(|n| n > crate::MAX_TIMESTAMP)
        {
            return Err("Invalid shared timestamp".into());
        }
    }
    if string(&output, "text")?.len() > 20 * 1024 * 1024 {
        return Err("Shared text is too large".into());
    }
    let mut media = vec![];
    let mut ids = BTreeSet::new();
    for incoming in output["attachments"]
        .as_array()
        .ok_or("Invalid shared originals")?
    {
        let mut item = json!({});
        for key in [
            "id", "kind", "mimeType", "filename", "byteSize", "width", "height", "duration",
            "checksum",
        ] {
            item[key] = incoming[key].clone();
        }
        uuid(string(&item, "id")?)?;
        if !ids.insert(string(&item, "id")?.to_owned()) || ids.len() > 10 {
            return Err("Invalid shared attachment identities".into());
        }
        let kind = string(&item, "kind")?;
        let mime = string(&item, "mimeType")?;
        let supported = match kind {
            "image" => [
                "image/jpeg",
                "image/png",
                "image/gif",
                "image/webp",
                "image/heic",
                "image/heif",
                "image/avif",
            ]
            .contains(&mime),
            "video" => [
                "video/mp4",
                "video/webm",
                "video/quicktime",
                "video/x-m4v",
                "video/ogg",
            ]
            .contains(&mime),
            _ => false,
        };
        if !supported
            || item["byteSize"].as_u64().is_none_or(|n| {
                n == 0 || n > (if kind == "image" { 50 } else { 500 }) * 1024 * 1024
            })
            || ["width", "height"].iter().any(|k| {
                item[k]
                    .as_u64()
                    .is_none_or(|n| n == 0 || n > i32::MAX as u64)
            })
            || string(&item, "filename")?.is_empty()
            || string(&item, "filename")?.encode_utf16().count() > 255
            || string(&item, "checksum")?.len() != 64
            || hex::decode(string(&item, "checksum")?).is_err()
            || !item["duration"].is_null()
                && item["duration"]
                    .as_u64()
                    .is_none_or(|n| n > crate::MAX_TIMESTAMP)
        {
            return Err("Invalid shared attachment metadata".into());
        }
        media.push(item);
    }
    output["attachments"] = json!(media);
    if !output["location"].is_null() {
        let input = &output["location"];
        let mut location = json!({});
        for key in [
            "latitude",
            "longitude",
            "capturedAt",
            "accuracy",
            "token",
            "name",
            "address",
            "locality",
            "userLabel",
            "city",
            "region",
            "country",
            "countryCode",
        ] {
            if let Some(value) = input.get(key) {
                location[key] = value.clone();
            }
        }
        for (key, min, max) in [("latitude", -90., 90.), ("longitude", -180., 180.)] {
            if location[key]
                .as_f64()
                .is_none_or(|n| !n.is_finite() || n < min || n > max)
            {
                return Err("Invalid shared location".into());
            }
        }
        if location["capturedAt"]
            .as_u64()
            .is_none_or(|n| n > crate::MAX_TIMESTAMP)
            || location["token"].as_str().is_none_or(str::is_empty)
            || location.get("accuracy").is_some_and(|n| {
                !n.is_null() && n.as_f64().is_none_or(|n| !n.is_finite() || n < 0.)
            })
        {
            return Err("Invalid shared location metadata".into());
        }
        for key in [
            "token",
            "name",
            "address",
            "locality",
            "userLabel",
            "city",
            "region",
            "country",
            "countryCode",
        ] {
            if location.get(key).is_some_and(|n| {
                !n.is_null() && n.as_str().is_none_or(|s| s.encode_utf16().count() > 500)
            }) {
                return Err("Invalid shared location label".into());
            }
        }
        output["location"] = location;
    }
    if wire::canonical(&output)?.len() > MAX_PAYLOAD_BYTES - 65536 {
        return Err("This thought is too large to share".into());
    }
    Ok(output)
}
fn uuid(value: &str) -> Result<()> {
    if value.len() != 36
        || value.chars().enumerate().any(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c != '-'
            } else {
                !c.is_ascii_hexdigit() || c.is_ascii_uppercase()
            }
        })
    {
        return Err("Invalid shared item identity".into());
    }
    Ok(())
}
pub fn local_id(scope: &str, participant: &str, item: &str) -> String {
    let h =
        wire::hash(format!("museamo-shared-local-v1\0{scope}\0{participant}\0{item}").as_bytes());
    format!(
        "{}-{}-5{}-a{}-{}",
        &h[..8],
        &h[8..12],
        &h[13..16],
        &h[17..20],
        &h[20..32]
    )
}
