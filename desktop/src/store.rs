use museamo_sync_core::{
    model::{Clock, Dot, Revision},
    normalize_tag,
    wire::{self, Envelope, Header},
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, String>;
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn id() -> String {
    Uuid::new_v4().to_string()
}
pub fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .ok_or_else(|| format!("Missing or invalid {key}"))
}
fn bool_value(v: &Value, key: &str) -> Result<bool> {
    v[key]
        .as_bool()
        .ok_or_else(|| format!("Missing or invalid {key}"))
}
pub fn uuid(value: &str) -> Result<&str> {
    if Uuid::parse_str(value).map(|v| v.to_string()).as_deref() != Ok(value) {
        return Err("Invalid identifier".into());
    }
    Ok(value)
}

pub struct Store {
    pub db: Connection,
    pub root: PathBuf,
    pub device: String,
    pub identity: Option<std::sync::Arc<crate::identity::Identity>>,
}
impl Store {
    pub fn open(root: &Path) -> Result<Self> {
        std::fs::create_dir_all(root.join("media")).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(root.join("staging")).map_err(|e| e.to_string())?;
        let db = Connection::open(root.join("library.sqlite")).map_err(|e| e.to_string())?;
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
          CREATE TABLE IF NOT EXISTS objects(kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id));
          CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY,kind TEXT NOT NULL,entity_id TEXT NOT NULL,header TEXT NOT NULL,payload TEXT);
          CREATE INDEX IF NOT EXISTS revision_entity ON revisions(kind,entity_id);
          CREATE TABLE IF NOT EXISTS recovery(id TEXT PRIMARY KEY,kind TEXT NOT NULL,entity_id TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS retired(kind TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(kind,id));
          CREATE TABLE IF NOT EXISTS sync_ops(origin TEXT NOT NULL,sequence INTEGER NOT NULL,kind TEXT NOT NULL,entity_id TEXT NOT NULL,envelope TEXT NOT NULL,verified INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(origin,sequence));
          CREATE INDEX IF NOT EXISTS sync_entity ON sync_ops(kind,entity_id);
          CREATE TABLE IF NOT EXISTS purged(revision_id TEXT PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS suppression(id TEXT PRIMARY KEY,envelope TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS suppression_effects(id TEXT PRIMARY KEY,origin TEXT NOT NULL,sequence INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS tag_aliases(source_id TEXT PRIMARY KEY,canonical_id TEXT NOT NULL);
          PRAGMA user_version=2;").map_err(|e|e.to_string())?;
        let device = Self::metadata_on(&db, "device")?.unwrap_or_else(id);
        db.execute(
            "INSERT OR IGNORE INTO metadata VALUES ('device',?1)",
            [&device],
        )
        .map_err(|e| e.to_string())?;
        let mut store = Self {
            db,
            root: root.to_owned(),
            device,
            identity: None,
        };
        store.identity = Some(std::sync::Arc::new(crate::identity::Identity::load(
            &store,
        )?));
        // Scaffolding databases predate the signed journal. Preserve their current saved library.
        if store.metadata("signedJournal")?.is_none() {
            store
                .db
                .execute_batch("BEGIN IMMEDIATE")
                .map_err(|e| e.to_string())?;
            let result = (|| {
                let legacy_recovery = store.command("listRecovery", &json!({}))?["items"]
                    .as_array()
                    .ok_or("Invalid legacy Recovery")?
                    .clone();
                store
                    .db
                    .execute_batch("DELETE FROM revisions; DELETE FROM recovery;")
                    .map_err(|e| e.to_string())?;
                store.set_metadata("sequence", "0")?;
                for kind in ["tag", "thought"] {
                    for row in store.all(kind)? {
                        let entity = string(&row, "id")?.to_owned();
                        store.record(kind, &entity, row, false)?;
                    }
                }
                for item in legacy_recovery {
                    let kind = string(&item, "kind")?;
                    let entity = string(&item, "entityId")?;
                    let header_kind = match kind {
                        "thought" => "archiveThought",
                        "tag" => "archiveTag",
                        _ => return Err("Unknown legacy Recovery kind".into()),
                    };
                    store.record(header_kind,entity,json!({"kind":kind,"entityId":entity,"payload":item["payload"],"createdAt":item["createdAt"]}),false)?;
                }
                store.set_metadata("signedJournal", "1")
            })();
            if let Err(e) = result {
                let _ = store.db.execute_batch("ROLLBACK");
                return Err(e);
            }
            store
                .db
                .execute_batch("COMMIT")
                .map_err(|e| e.to_string())?;
        }
        store.checkpoint_purges()?;
        Ok(store)
    }
    fn metadata_on(db: &Connection, key: &str) -> Result<Option<String>> {
        use rusqlite::OptionalExtension;
        db.query_row("SELECT value FROM metadata WHERE key=?1", [key], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())
    }
    pub fn metadata(&self, key: &str) -> Result<Option<String>> {
        Self::metadata_on(&self.db, key)
    }
    pub fn set_metadata(&self, key: &str, value: &str) -> Result<()> {
        self.db.execute("INSERT INTO metadata VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn get(&self, kind: &str, id: &str) -> Result<Option<Value>> {
        use rusqlite::OptionalExtension;
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT payload FROM objects WHERE kind=?1 AND id=?2",
                params![kind, id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        raw.map(|v| serde_json::from_str(&v).map_err(|e| e.to_string()))
            .transpose()
    }
    pub fn all(&self, kind: &str) -> Result<Vec<Value>> {
        let mut statement = self
            .db
            .prepare("SELECT payload FROM objects WHERE kind=?1 ORDER BY id")
            .map_err(|e| e.to_string())?;
        let values = statement
            .query_map([kind], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        values
            .map(|v| {
                serde_json::from_str(&v.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
            })
            .collect()
    }
    pub fn put_local(&self, kind: &str, id: &str, value: &Value) -> Result<()> {
        self.db.execute("INSERT INTO objects VALUES (?1,?2,?3) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload",params![kind,id,value.to_string()]).map_err(|e|e.to_string())?;
        Ok(())
    }
    fn erase(&self, kind: &str, id: &str) -> Result<()> {
        self.db
            .execute(
                "DELETE FROM objects WHERE kind=?1 AND id=?2",
                params![kind, id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn record(
        &mut self,
        kind: &str,
        entity: &str,
        mut value: Value,
        deleted: bool,
    ) -> Result<String> {
        uuid(entity)?;
        if kind == "thought" && !deleted && self.is_retired(kind, entity)? {
            return Err(
                "This thought was permanently cleared. Restore it under a new identity.".into(),
            );
        }
        self.db
            .execute_batch("SAVEPOINT record_mutation")
            .map_err(|e| e.to_string())?;
        let result = (|| -> Result<String> {
            let sequence = self
                .metadata("sequence")?
                .unwrap_or_else(|| "0".into())
                .parse::<u64>()
                .map_err(|e| e.to_string())?
                .checked_add(1)
                .filter(|v| *v <= i64::MAX as u64)
                .ok_or("Device sequence exhausted")?;
            let previous = self
                .metadata("clock")?
                .map(|v| serde_json::from_str::<Clock>(&v).map_err(|e| e.to_string()))
                .transpose()?
                .unwrap_or_default();
            let clock = previous.tick(now(), None)?;
            let revision_id = format!("{}:{}", self.device, sequence);
            value
                .as_object_mut()
                .ok_or("Expected an object")?
                .remove("revision");
            let canonical_payload = wire::canonical(&value)?;
            if canonical_payload.len() > museamo_sync_core::MAX_PAYLOAD_BYTES - 128 * 1024 {
                return Err("Saved change exceeds the sync message limit.".into());
            }
            let payload_hash = wire::hash(&canonical_payload);
            let context = self.receipts()?;
            let revision = Revision {
                entity_id: entity.into(),
                dot: Dot {
                    origin: self.device.clone(),
                    sequence,
                },
                context,
                clock,
                deleted,
                payload_hash,
            };
            let previous_hash = if sequence == 1 {
                String::new()
            } else {
                self.operation(&self.device, sequence - 1)?
                    .map(|e| wire::canonical(&e.header).map(|b| wire::hash(&b)))
                    .transpose()?
                    .ok_or("Missing local chain")?
            };
            let header = Header {
                protocol: 1,
                group: self.metadata("group")?.unwrap_or_default(),
                kind: kind.into(),
                previous_hash,
                revision,
            };
            let signature = self
                .identity
                .as_ref()
                .ok_or("Identity unavailable")?
                .sign(&wire::signing_bytes(&header)?);
            let envelope = Envelope {
                header,
                signature,
                payload: Some(value),
            };
            crate::replica::validate_operation(&envelope)?;
            self.insert_operation(&envelope)?;
            self.project(kind, entity)?;
            self.set_metadata("sequence", &sequence.to_string())?;
            self.set_metadata(
                "clock",
                &serde_json::to_string(&clock).map_err(|e| e.to_string())?,
            )?;
            self.assert_erasure_receipts()?;
            Ok(revision_id)
        })();
        match result {
            Ok(value) => {
                self.db
                    .execute_batch("RELEASE record_mutation")
                    .map_err(|e| e.to_string())?;
                Ok(value)
            }
            Err(e) => {
                let _ = self
                    .db
                    .execute_batch("ROLLBACK TO record_mutation; RELEASE record_mutation");
                Err(e)
            }
        }
    }
    fn entry(&self, id: &str) -> Result<Value> {
        self.get("thought", id)?
            .ok_or_else(|| "This thought no longer exists.".into())
    }
    pub(crate) fn valid_tags(&self, values: &Value) -> Result<Vec<String>> {
        let mut result = vec![];
        for value in values.as_array().ok_or("Choose valid tags")? {
            let original = value.as_str().ok_or("Invalid tag identifier")?;
            uuid(original)?;
            let id = self.canonical_tag(original)?;
            if self.get("tag", &id)?.is_some() && !result.contains(&id) {
                result.push(id);
            }
        }
        Ok(result)
    }
    fn attachments(&self, ids: &Value) -> Result<Vec<Value>> {
        let ids = ids.as_array().ok_or("Choose valid attachments")?;
        if ids.len() > 10 {
            return Err("Choose up to 10 attachments.".into());
        }
        let mut seen = std::collections::BTreeSet::new();
        ids.iter()
            .map(|v| {
                let id = v.as_str().ok_or("Invalid attachment identifier")?;
                uuid(id)?;
                if !seen.insert(id) {
                    return Err("Choose different attachments.".into());
                }
                self.get("media", id)?
                    .ok_or_else(|| "An attachment is missing.".into())
            })
            .collect()
    }
    fn check_base(&self, entry: &Value, input: &Value) -> Result<()> {
        if let Some(base) = input["baseRevision"].as_str() {
            if entry["revision"].as_str() != Some(base) {
                return Err("This thought changed on another device. Your writing is preserved; reload the current version or save as a new thought.".into());
            }
        }
        Ok(())
    }
    pub fn command(&mut self, method: &str, input: &Value) -> Result<Value> {
        if !matches!(
            method,
            "commitDraft"
                | "updateEntry"
                | "restoreEntry"
                | "saveTag"
                | "deleteTag"
                | "setStar"
                | "setCompleted"
                | "deleteEntry"
        ) {
            return self.command_inner(method, input);
        }
        self.db
            .execute_batch("SAVEPOINT library_operation")
            .map_err(|e| e.to_string())?;
        match self.command_inner(method, input) {
            Ok(value) => {
                self.db
                    .execute_batch("RELEASE library_operation")
                    .map_err(|e| e.to_string())?;
                Ok(value)
            }
            Err(e) => {
                let _ = self
                    .db
                    .execute_batch("ROLLBACK TO library_operation; RELEASE library_operation");
                Err(e)
            }
        }
    }
    fn resolve_tags(
        &mut self,
        text: &str,
        selected: &Value,
        previous_text: &str,
    ) -> Result<Vec<String>> {
        let mut selected = self.valid_tags(selected)?;
        let old: std::collections::BTreeSet<String> = crate::hashtags::names(previous_text)
            .iter()
            .map(|n| normalize_tag(n))
            .collect();
        let mut tags = self.all("tag")?;
        for name in crate::hashtags::names(text) {
            let normalized = normalize_tag(&name);
            let matching: Vec<String> = tags
                .iter()
                .filter(|t| normalize_tag(t["name"].as_str().unwrap_or_default()) == normalized)
                .filter_map(|t| t["id"].as_str().map(str::to_owned))
                .collect();
            let tag = if matching.len() == 1 {
                matching[0].clone()
            } else if matching.is_empty() && !old.contains(&normalized) {
                let next = id();
                let value = json!({"id":next,"name":name,"type":"standard"});
                self.record("tag", &next, value.clone(), false)?;
                tags.push(value);
                next
            } else {
                continue;
            };
            if !selected.contains(&tag) {
                selected.push(tag);
            }
        }
        Ok(selected)
    }
    fn command_inner(&mut self, method: &str, input: &Value) -> Result<Value> {
        match method {
            "library" => {
                let mut entries = self.all("thought")?;
                for e in &mut entries {
                    e["tagIds"] = json!(self.valid_tags(&e["tagIds"])?);
                }
                let mut tags = self.all("tag")?;
                for tag in &mut tags {
                    let id = tag["id"].as_str().unwrap_or_default();
                    tag["count"] = json!(entries
                        .iter()
                        .filter(|e| e["tagIds"]
                            .as_array()
                            .is_some_and(|v| v.iter().any(|v| v.as_str() == Some(id))))
                        .count());
                    tag["normalizedName"] =
                        json!(normalize_tag(tag["name"].as_str().unwrap_or_default()));
                }
                tags.sort_by_key(|t| normalize_tag(t["name"].as_str().unwrap_or_default()));
                Ok(json!({"tags":tags,"profiles":[]}))
            }
            "queryEntries" => self.query(input),
            "getEntry" => {
                let mut entry = self.get("thought", string(input, "id")?)?;
                if let Some(entry) = entry.as_mut() {
                    entry["tagIds"] = json!(self.valid_tags(&entry["tagIds"])?);
                }
                Ok(json!({"entry":entry}))
            }
            "getDraft" => {
                let tag = input["tagId"].as_str();
                let key = format!("app:{}", tag.unwrap_or("general"));
                let draft=self.get("draft",&key)?.unwrap_or_else(||json!({"profileKey":key,"entryId":id(),"text":"","tagIds":tag.map(|v|vec![v]).unwrap_or_default(),"profileId":null,"attachments":[],"location":null,"locationAttempted":true}));
                self.put_local("draft", &key, &draft)?;
                Ok(json!({"draft":draft}))
            }
            "updateDraft" => {
                let key = string(input, "profileKey")?;
                let mut draft = self.get("draft", key)?.ok_or("Draft no longer exists")?;
                draft["text"] = json!(string(input, "text")?);
                draft["tagIds"] = json!(self.valid_tags(&input["tagIds"])?);
                if input.get("attachmentIds").is_some() {
                    draft["attachments"] = json!(self.attachments(&input["attachmentIds"])?);
                }
                if let Some(location) = input.get("location") {
                    draft["location"] = location.clone();
                }
                self.put_local("draft", key, &draft)?;
                Ok(json!({}))
            }
            "discardDraft" => {
                self.erase("draft", string(input, "profileKey")?)?;
                Ok(json!({}))
            }
            "commitDraft" => {
                let draft = &input["draft"];
                let entry_id = string(draft, "entryId")?;
                uuid(entry_id)?;
                if self.metadata(&format!("committed:{entry_id}"))?.is_some()
                    || self.get("thought", entry_id)?.is_some()
                {
                    return Ok(json!({"entryId":entry_id}));
                }
                let text = string(draft, "text")?;
                let attachment_ids = json!(draft["attachments"]
                    .as_array()
                    .unwrap_or(&vec![])
                    .iter()
                    .map(|a| a["id"].clone())
                    .collect::<Vec<_>>());
                let attachments = self.attachments(&attachment_ids)?;
                if text.trim().is_empty() && attachments.is_empty() {
                    return Err("Add text or an attachment.".into());
                }
                let time = now();
                let tags = self.resolve_tags(text, &draft["tagIds"], "")?;
                let entry = json!({"id":entry_id,"text":text,"tagIds":tags ,"createdAt":time,"updatedAt":time,"starred":false,"completed":false,"profileId":null,"location":draft["location"],"attachments":attachments});
                self.db
                    .execute_batch("SAVEPOINT capture_draft")
                    .map_err(|e| e.to_string())?;
                let result = (|| {
                    self.record("thought", entry_id, entry, false)?;
                    self.erase("draft", string(draft, "profileKey")?)?;
                    self.set_metadata(&format!("committed:{entry_id}"), "1")
                })();
                if let Err(e) = result {
                    let _ = self
                        .db
                        .execute_batch("ROLLBACK TO capture_draft; RELEASE capture_draft");
                    return Err(e);
                }
                self.db
                    .execute_batch("RELEASE capture_draft")
                    .map_err(|e| e.to_string())?;
                Ok(json!({"entryId":entry_id}))
            }
            "updateEntry" => {
                let entry_id = string(input, "id")?;
                let mut entry = self.entry(entry_id)?;
                self.check_base(&entry, input)?;
                let text = string(input, "text")?;
                entry["tagIds"] = json!(self.resolve_tags(
                    text,
                    &input["tagIds"],
                    entry["text"].as_str().unwrap_or_default()
                )?);
                entry["text"] = json!(text);
                if input.get("attachmentIds").is_some() {
                    entry["attachments"] = json!(self.attachments(&input["attachmentIds"])?);
                }
                if input.get("location").is_some() {
                    entry["location"] = input["location"].clone();
                }
                if entry["text"].as_str().unwrap_or_default().trim().is_empty()
                    && entry["attachments"].as_array().is_none_or(|a| a.is_empty())
                {
                    return Err("Add text or an attachment.".into());
                }
                entry["updatedAt"] = json!(now());
                self.record("thought", entry_id, entry, false)?;
                Ok(json!({}))
            }
            "setStar" | "setCompleted" => {
                let entry_id = string(input, "id")?;
                let mut entry = self.entry(entry_id)?;
                let field = if method == "setStar" {
                    "starred"
                } else {
                    "completed"
                };
                if field == "completed" && !self.checklist(&entry)? {
                    return Err("This thought no longer belongs to a Checklist category.".into());
                }
                entry[field] = json!(bool_value(input, field)?);
                self.record("thought", entry_id, entry, false)?;
                Ok(json!({}))
            }
            "deleteEntry" => {
                let entry_id = string(input, "id")?;
                if let Some(entry) = self.get("thought", entry_id)? {
                    self.check_base(&entry, input)?;
                    self.record("thought", entry_id, entry, true)?;
                }
                Ok(json!({}))
            }
            "restoreEntry" => {
                let mut entry = input["entry"].clone();
                let next = id();
                entry["id"] = json!(next);
                entry["tagIds"] = json!(self.valid_tags(&entry["tagIds"])?);
                self.record("thought", &next, entry, false)?;
                Ok(json!({"entryId":next}))
            }
            "saveTag" => {
                let name = string(input, "name")?.trim();
                if name.is_empty() || name.encode_utf16().count() > 80 {
                    return Err("Use a tag name between 1 and 80 characters.".into());
                }
                let tag_id = input["id"].as_str().map(str::to_owned).unwrap_or_else(id);
                uuid(&tag_id)?;
                if self.all("tag")?.iter().any(|t| {
                    t["id"].as_str() != Some(&tag_id)
                        && normalize_tag(t["name"].as_str().unwrap_or_default())
                            == normalize_tag(name)
                }) {
                    return Err("A tag with this name already exists.".into());
                }
                let previous = self.get("tag", &tag_id)?;
                let kind = input["type"]
                    .as_str()
                    .or_else(|| previous.as_ref().and_then(|t| t["type"].as_str()))
                    .unwrap_or("standard");
                if !["standard", "checklist"].contains(&kind) {
                    return Err("Unknown category type.".into());
                }
                self.record(
                    "tag",
                    &tag_id,
                    json!({"id":tag_id,"name":name,"type":kind}),
                    false,
                )?;
                Ok(json!({}))
            }
            "deleteTag" => {
                let tag_id = string(input, "id")?;
                if let Some(tag) = self.get("tag", tag_id)? {
                    self.record("tag", tag_id, tag, true)?;
                }
                for mut draft in self.all("draft")? {
                    let key = string(&draft, "profileKey")?.to_owned();
                    draft["tagIds"] = json!(self.valid_tags(&draft["tagIds"])?);
                    self.put_local("draft", &key, &draft)?;
                }
                Ok(json!({}))
            }
            "locationSettings" => Ok(json!({"enabled":false,"permitted":false})),
            "setLocationEnabled" => Ok(json!({"enabled":false})),
            "currentLocation" => Ok(json!({"location":null,"status":"unavailable"})),
            "releaseMedia" => {
                for id in input["ids"]
                    .as_array()
                    .ok_or("Invalid attachment identifiers")?
                {
                    let id = uuid(id.as_str().ok_or("Invalid attachment identifier")?)?;
                    self.db
                        .execute(
                            "DELETE FROM metadata WHERE key=?1",
                            [format!("mediaPin:{id}")],
                        )
                        .map_err(|e| e.to_string())?;
                }
                self.collect_media()?;
                Ok(json!({}))
            }
            "releaseDeleted" => Ok(json!({})), // durable Recovery protects originals
            "configureWidget" => Err("Widgets are available on Android.".into()),
            "compose" => Err("Use the desktop composer.".into()),
            "restoreRecovery" => self.restore_recovery(string(input, "id")?),
            "clearRecovery" => self.clear_recovery(Some(string(input, "id")?)),
            "clearAllRecovery" => self.clear_recovery(None),
            "listRecovery" => {
                let mut statement=self.db.prepare("SELECT id,kind,entity_id,payload,created_at FROM recovery ORDER BY created_at DESC,id").map_err(|e|e.to_string())?;
                let rows = statement
                    .query_map([], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, String>(3)?,
                            r.get::<_, i64>(4)?,
                        ))
                    })
                    .map_err(|e| e.to_string())?;
                let values:Result<Vec<_>>=rows.map(|r|{let(id,kind,entity,payload,time)=r.map_err(|e|e.to_string())?;Ok(json!({"id":id,"kind":kind,"entityId":entity,"payload":serde_json::from_str::<Value>(&payload).map_err(|e|e.to_string())?,"createdAt":time}))}).collect();
                Ok(json!({"items":values?}))
            }
            _ => Err(format!("Unsupported local library operation: {method}")),
        }
    }
    fn checklist(&self, entry: &Value) -> Result<bool> {
        for id in entry["tagIds"].as_array().ok_or("Invalid tag list")? {
            if let Some(tag) = self.get(
                "tag",
                &self.canonical_tag(id.as_str().ok_or("Invalid tag")?)?,
            )? {
                if tag["type"] == "checklist" {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
    fn query(&self, q: &Value) -> Result<Value> {
        let tags = self.all("tag")?;
        let checklist_ids: Vec<_> = tags
            .iter()
            .filter(|t| t["type"] == "checklist")
            .filter_map(|t| t["id"].as_str())
            .collect();
        let checklist = q["order"] == "checklist";
        if checklist && !checklist_ids.contains(&q["tagId"].as_str().unwrap_or_default()) {
            return Err("Choose a Checklist category.".into());
        }
        if checklist && q.get("beforeTime").is_some() && q["beforeCompleted"].as_bool().is_none() {
            return Err("Reload this checklist before loading more thoughts.".into());
        }
        let search = q["search"].as_str().unwrap_or_default().to_lowercase();
        let mut entries = self.all("thought")?;
        for entry in &mut entries {
            entry["tagIds"] = json!(self.valid_tags(&entry["tagIds"])?);
        }
        entries.retain(|e| {
            let ids = e["tagIds"].as_array().unwrap();
            (!q["starred"].as_bool().unwrap_or(false) || e["starred"] == true)
                && (!q["located"].as_bool().unwrap_or(false) || !e["location"].is_null())
                && (!q["checklistOnly"].as_bool().unwrap_or(false)
                    || ids
                        .iter()
                        .any(|v| checklist_ids.contains(&v.as_str().unwrap_or_default())))
                && q["tagId"]
                    .as_str()
                    .is_none_or(|tag| ids.iter().any(|id| id.as_str() == Some(tag)))
                && (search.is_empty()
                    || format!(
                        "{} {}",
                        e["text"].as_str().unwrap_or_default(),
                        e["location"]
                    )
                    .to_lowercase()
                    .contains(&search))
        });
        entries.sort_by(|a, b| {
            let completed = if checklist {
                a["completed"]
                    .as_bool()
                    .unwrap_or(false)
                    .cmp(&b["completed"].as_bool().unwrap_or(false))
            } else {
                std::cmp::Ordering::Equal
            };
            completed
                .then_with(|| b["createdAt"].as_u64().cmp(&a["createdAt"].as_u64()))
                .then_with(|| b["id"].as_str().cmp(&a["id"].as_str()))
        });
        if let Some(time) = q["beforeTime"].as_u64() {
            entries.retain(|e| {
                let group = if checklist {
                    e["completed"]
                        .as_bool()
                        .unwrap_or(false)
                        .cmp(&q["beforeCompleted"].as_bool().unwrap_or(false))
                } else {
                    std::cmp::Ordering::Equal
                };
                group.is_gt()
                    || (group.is_eq()
                        && (e["createdAt"].as_u64().unwrap_or_default() < time
                            || (e["createdAt"] == time
                                && e["id"].as_str() < q["beforeId"].as_str())))
            });
        }
        let offset = if q.get("beforeTime").is_some() {
            0
        } else {
            q["offset"].as_u64().unwrap_or_default() as usize
        };
        let limit = q["limit"].as_u64().unwrap_or(50).clamp(1, 10000) as usize;
        let has_more = entries.len() > offset.saturating_add(limit);
        Ok(
            json!({"entries":entries.into_iter().skip(offset).take(limit).collect::<Vec<_>>(),"hasMore":has_more}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Store {
        let path = std::env::temp_dir().join(format!("museamo-test-{}", id()));
        Store::open(&path).unwrap()
    }
    #[test]
    fn capture_survives_restart_and_repeated_commit() {
        let mut store = fixture();
        let root = store.root.clone();
        let entry = id();
        let input = json!({"draft":{"profileKey":"app:general","entryId":entry,"text":"offline thought","tagIds":[],"attachments":[]}});
        store.command("commitDraft", &input).unwrap();
        store.command("commitDraft", &input).unwrap();
        drop(store);
        let mut store = Store::open(&root).unwrap();
        assert_eq!(
            store.command("queryEntries", &json!({})).unwrap()["entries"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn stale_editor_cannot_silently_overwrite_and_delete_keeps_recovery() {
        let mut store = fixture();
        let entry = id();
        store.record("thought",&entry,json!({"id":entry,"text":"original","tagIds":[],"attachments":[],"completed":false,"createdAt":now(),"updatedAt":now(),"starred":false,"location":null}),false).unwrap();
        let base = store.entry(&entry).unwrap()["revision"].clone();
        store
            .command("setStar", &json!({"id":entry,"starred":true}))
            .unwrap();
        assert!(store
            .command(
                "updateEntry",
                &json!({"id":entry,"baseRevision":base,"text":"stale","tagIds":[]})
            )
            .is_err());
        store.command("deleteEntry", &json!({"id":entry})).unwrap();
        assert!(store.get("thought", &entry).unwrap().is_none());
        assert!(!store.command("listRecovery", &json!({})).unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty());
    }
    #[test]
    fn inline_categories_are_atomic_and_historical_renames_do_not_recreate_tags() {
        let mut db = fixture();
        let note = id();
        let capture = json!({"draft":{"profileKey":"app:general","entryId":note,"text":"Writing #Newtag","tagIds":[],"attachments":[],"location":null}});
        db.command("commitDraft", &capture).unwrap();
        let tag = db.all("tag").unwrap()[0]["id"].as_str().unwrap().to_owned();
        assert_eq!(db.entry(&note).unwrap()["tagIds"], json!([tag]));
        db.command("saveTag", &json!({"id":tag,"name":"Renamed"}))
            .unwrap();
        db.command(
            "updateEntry",
            &json!({"id":note,"text":"Writing #Newtag and more","tagIds":[tag]}),
        )
        .unwrap();
        assert_eq!(db.all("tag").unwrap().len(), 1);
        assert_eq!(db.entry(&note).unwrap()["tagIds"], json!([tag]));
        let before = db.receipts().unwrap();
        let bad = json!({"draft":{"profileKey":"app:general","entryId":id(),"text":"#Rollback","tagIds":[],"attachments":[],"location":{"latitude":200}}});
        assert!(db.command("commitDraft", &bad).is_err());
        assert_eq!(db.receipts().unwrap(), before);
        assert_eq!(db.all("tag").unwrap().len(), 1);
        db.command("deleteTag", &json!({"id":tag})).unwrap();
        db.command(
            "updateEntry",
            &json!({"id":note,"text":"Writing #Newtag again","tagIds":[]}),
        )
        .unwrap();
        assert!(db.all("tag").unwrap().is_empty());
        for _ in 0..2 {
            let tag = id();
            db.record(
                "tag",
                &tag,
                json!({"id":tag,"name":"Ambiguous","type":"standard"}),
                false,
            )
            .unwrap();
        }
        let ambiguous = id();
        db.command("commitDraft",&json!({"draft":{"profileKey":"app:general","entryId":ambiguous,"text":"#Ambiguous","tagIds":[],"attachments":[],"location":null}})).unwrap();
        assert_eq!(db.entry(&ambiguous).unwrap()["tagIds"], json!([]));
    }
}
