//! Native journal transactions. No key material or generic platform methods cross the WebView.
use crate::store::{id, now, string, uuid, Result, Store};
use museamo_sync_core::{
    model::{winner, Clock, Context, Revision},
    wire::{self, Envelope},
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Read, Seek, SeekFrom, Write},
    sync::{Arc, Mutex},
};

impl Store {
    pub fn operation(&self, origin: &str, sequence: u64) -> Result<Option<Envelope>> {
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT envelope FROM sync_ops WHERE origin=?1 AND sequence=?2",
                params![origin, sequence as i64],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        raw.map(|v| serde_json::from_str(&v).map_err(|e| e.to_string()))
            .transpose()
    }
    pub fn receipts(&self) -> Result<Context> {
        self.prefixes(false)
    }
    pub fn staged_receipts(&self) -> Result<Context> {
        self.prefixes(true)
    }
    fn prefixes(&self, staged: bool) -> Result<Context> {
        let mut result = Context::new();
        let mut query = self
            .db
            .prepare(if staged {
                "SELECT origin,sequence FROM sync_ops WHERE verified>0 ORDER BY origin,sequence"
            } else {
                "SELECT origin,sequence FROM sync_ops WHERE verified=1 ORDER BY origin,sequence"
            })
            .map_err(|e| e.to_string())?;
        let rows = query
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (origin, sequence) = row.map_err(|e| e.to_string())?;
            let prefix = result.entry(origin).or_default();
            if sequence as u64 == *prefix + 1 {
                *prefix += 1;
            }
        }
        Ok(result)
    }
    fn anchor_ready(&self, origin: &str) -> Result<bool> {
        let anchors = self
            .metadata("authorizedAnchors")?
            .map(|v| serde_json::from_str::<Value>(&v).map_err(|e| e.to_string()))
            .transpose()?
            .unwrap_or(json!({}));
        let Some(anchor) = anchors.get(origin) else {
            return Ok(true);
        };
        let through = anchor["through"].as_u64().ok_or("Invalid removal anchor")?;
        if through == 0 {
            return Ok(false);
        }
        if self.staged_receipts()?.get(origin).copied().unwrap_or(0) < through {
            return Ok(false);
        }
        let e = self
            .operation(origin, through)?
            .ok_or("Missing witnessed anchor")?;
        let actual = wire::hash(&wire::canonical(&e.header)?);
        if anchor["headerHash"].as_str() != Some(&actual) {
            return Err("Removed-device history differs from the signed witness checkpoint".into());
        }
        Ok(true)
    }
    fn origin_allows(&self, origin: &str, sequence: u64) -> Result<bool> {
        let history = self
            .metadata("authorizedHistory")?
            .map(|v| serde_json::from_str::<Value>(&v).map_err(|e| e.to_string()))
            .transpose()?
            .unwrap_or(json!({}));
        Ok(history
            .get(origin)
            .is_none_or(|cap| sequence <= cap.as_u64().unwrap_or(0)))
    }
    pub fn insert_operation(&self, envelope: &Envelope) -> Result<()> {
        let r = &envelope.header.revision;
        self.db
            .execute(
                "INSERT INTO sync_ops VALUES (?1,?2,?3,?4,?5,1)",
                params![
                    r.dot.origin,
                    r.dot.sequence as i64,
                    envelope.header.kind,
                    r.entity_id,
                    serde_json::to_string(envelope).map_err(|e| e.to_string())?
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    fn is_purged(&self, revision: &str) -> Result<bool> {
        Ok(self
            .db
            .query_row(
                "SELECT COUNT(*) FROM purged WHERE revision_id=?1",
                [revision],
                |r| r.get::<_, i64>(0),
            )
            .map_err(|e| e.to_string())?
            > 0)
    }
    pub fn is_retired(&self, kind: &str, entity: &str) -> Result<bool> {
        Ok(self
            .db
            .query_row(
                "SELECT COUNT(*) FROM retired WHERE kind=?1 AND id=?2",
                params![kind, entity],
                |r| r.get::<_, i64>(0),
            )
            .map_err(|e| e.to_string())?
            > 0)
    }
    pub fn canonical_tag(&self, source: &str) -> Result<String> {
        Ok(self
            .db
            .query_row(
                "SELECT canonical_id FROM tag_aliases WHERE source_id=?1",
                [source],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| source.to_owned()))
    }
    fn rebuild_aliases(&self) -> Result<()> {
        let mut stmt=self.db.prepare("SELECT envelope FROM sync_ops WHERE verified=1 AND kind='tagAlias' ORDER BY origin,sequence").map_err(|e|e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut records = vec![];
        for row in rows {
            let e: Envelope = serde_json::from_str(&row.map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            let record: museamo_sync_core::tags::TagAlias =
                serde_json::from_value(e.payload.ok_or("Missing alias proof")?)
                    .map_err(|e| e.to_string())?;
            records.push(record);
        }
        drop(stmt);
        self.db
            .execute("DELETE FROM tag_aliases", [])
            .map_err(|e| e.to_string())?;
        for (source, canonical) in museamo_sync_core::tags::aliases(&records)? {
            self.db
                .execute(
                    "INSERT INTO tag_aliases VALUES (?1,?2)",
                    params![source, canonical],
                )
                .map_err(|e| e.to_string())?;
        }
        let mut stmt = self
            .db
            .prepare("SELECT DISTINCT entity_id FROM sync_ops WHERE verified=1 AND kind='tag'")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let entities: Result<Vec<_>> = rows.map(|r| r.map_err(|e| e.to_string())).collect();
        drop(stmt);
        self.db
            .execute("DELETE FROM objects WHERE kind='tag'", [])
            .map_err(|e| e.to_string())?;
        let canonical: BTreeSet<String> = entities?
            .iter()
            .map(|id| self.canonical_tag(id))
            .collect::<Result<_>>()?;
        for id in canonical {
            self.project("tag", &id)?;
        }
        Ok(())
    }
    pub fn coalesce_tags(&mut self, input: &Value) -> Result<Value> {
        let enrollment = string(input, "enrollmentId")?;
        if enrollment.len() > 256 {
            return Err("Invalid enrollment identity".into());
        }
        let marker = format!("tagEnrollment:{enrollment}");
        if self.metadata(&marker)?.is_some() {
            return Ok(json!({}));
        }
        let local = input["localTags"]
            .as_array()
            .ok_or("Missing local tag snapshot")?;
        let peer = input["peerTags"]
            .as_array()
            .ok_or("Missing peer tag snapshot")?;
        let mut groups: BTreeMap<(String, String), (BTreeSet<String>, BTreeSet<String>)> =
            BTreeMap::new();
        for (snapshot, is_local) in [(local, true), (peer, false)] {
            for tag in snapshot {
                let id = uuid(string(tag, "id")?)?;
                if self.sharing_metadata(id)?.is_some() || self.sharing_metadata(&self.canonical_tag(id)?)?.is_some() { continue; }
                let name = string(tag, "name")?;
                let kind = string(tag, "type")?;
                let key = (museamo_sync_core::normalize_tag(name), kind.to_owned());
                let current = self.get("tag", &self.canonical_tag(id)?)?;
                if !current.as_ref().is_some_and(|t| {
                    t["type"] == kind
                        && museamo_sync_core::normalize_tag(t["name"].as_str().unwrap_or_default())
                            == key.0
                }) {
                    continue;
                }
                let group = groups.entry(key).or_default();
                if is_local {
                    group.0.insert(id.to_owned());
                } else {
                    group.1.insert(id.to_owned());
                }
            }
        }
        self.db
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        let result = (|| -> Result<()> {
            for ((name, kind), (local, peer)) in groups {
                let ids: BTreeSet<String> = local.iter().chain(peer.iter()).cloned().collect();
                if local.len() == 1 && peer.len() == 1 && ids.len() > 1 {
                    self.record(
                        "tagAlias",
                        &id(),
                        json!({"ids":ids,"normalizedName":name,"type":kind}),
                        false,
                    )?;
                }
            }
            self.set_metadata(&marker, "1")?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                self.db.execute_batch("COMMIT").map_err(|e| e.to_string())?;
                Ok(json!({}))
            }
            Err(e) => {
                let _ = self.db.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }
    pub fn project(&self, kind: &str, entity: &str) -> Result<()> {
        if kind == "tagAlias" {
            return self.rebuild_aliases();
        }
        if kind == "purge" {
            return self.apply_purges();
        }
        if kind == "archiveThought" || kind == "archiveTag" {
            for e in self.entity_ops(kind, entity)? {
                if let Some(p) = e.payload {
                    let revision = e.header.revision.id();
                    if !self.is_purged(&revision)?
                        && !(kind == "archiveThought" && self.is_retired("thought", entity)?)
                    {
                        self.db
                            .execute(
                                "INSERT OR IGNORE INTO recovery VALUES (?1,?2,?3,?4,?5)",
                                params![
                                    revision,
                                    p["kind"].as_str().unwrap_or("thought"),
                                    p["entityId"].as_str().unwrap_or(entity),
                                    p["payload"].to_string(),
                                    p["createdAt"]
                                        .as_u64()
                                        .unwrap_or(e.header.revision.clock.wall)
                                        as i64
                                ],
                            )
                            .map_err(|e| e.to_string())?;
                    }
                }
            }
            return Ok(());
        }
        if !["thought", "tag"].contains(&kind) {
            return Err("Unsupported replicated object".into());
        }
        let canonical = if kind == "tag" {
            self.canonical_tag(entity)?
        } else {
            entity.to_owned()
        };
        let entity = canonical.as_str();
        let envelopes = self.entity_ops(kind, entity)?;
        let revisions: Vec<Revision> = envelopes
            .iter()
            .map(|e| {
                let mut r = e.header.revision.clone();
                if kind == "tag" {
                    r.entity_id = canonical.clone();
                }
                r
            })
            .collect();
        let chosen = winner(&revisions, self.is_retired(kind, entity)?)?;
        let chosen_id = chosen.filter(|r| !r.deleted).map(|r| r.id());
        let incoming=chosen_id.as_deref().and_then(|id|envelopes.iter().find(|e|e.header.revision.id()==id)).and_then(|e|e.payload.as_ref());
        if let Some(shared)=self.personal_shared_projection(kind,entity,incoming)? {
            if let Some(mut value)=shared {if let Some(head)=chosen {value["revision"]=json!(head.id());}self.put_local(kind,entity,&value)?;} else {self.db.execute("DELETE FROM objects WHERE kind=?1 AND id=?2",params![kind,entity]).map_err(|e|e.to_string())?;}return Ok(());
        }
        self.db
            .execute(
                "DELETE FROM objects WHERE kind=?1 AND id=?2",
                params![kind, entity],
            )
            .map_err(|e| e.to_string())?;
        for e in &envelopes {
            let revision = e.header.revision.id();
            if let Some(payload) = &e.payload {
                if chosen_id.as_deref() == Some(&revision) {
                    let mut payload = payload.clone();
                    if kind == "tag" {
                        payload["id"] = json!(canonical);
                    }
                    payload["revision"] = json!(revision);
                    self.put_local(kind, entity, &payload)?;
                    self.db
                        .execute("DELETE FROM recovery WHERE id=?1", [&revision])
                        .map_err(|e| e.to_string())?;
                } else if !self.is_purged(&revision)? {
                    self.db
                        .execute(
                            "INSERT OR IGNORE INTO recovery VALUES (?1,?2,?3,?4,?5)",
                            params![
                                revision,
                                kind,
                                e.header.revision.entity_id,
                                payload.to_string(),
                                e.header.revision.clock.wall as i64
                            ],
                        )
                        .map_err(|e| e.to_string())?;
                }
            } // A cleared historic version can precede its newer live winner in a paged transfer.
        }
        Ok(())
    }
    fn entity_ops(&self, kind: &str, entity: &str) -> Result<Vec<Envelope>> {
        if kind == "tag" {
            let mut stmt=self.db.prepare("SELECT envelope FROM sync_ops WHERE verified=1 AND kind='tag' ORDER BY origin,sequence").map_err(|e|e.to_string())?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            let mut result = vec![];
            for row in rows {
                let e: Envelope = serde_json::from_str(&row.map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
                if self.canonical_tag(&e.header.revision.entity_id)? == entity {
                    result.push(e);
                }
            }
            return Ok(result);
        }
        let mut stmt=self.db.prepare("SELECT envelope FROM sync_ops WHERE verified=1 AND kind=?1 AND entity_id=?2 ORDER BY origin,sequence").map_err(|e|e.to_string())?;
        let rows = stmt
            .query_map(params![kind, entity], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }
    fn apply_purges(&self) -> Result<()> {
        let mut stmt=self.db.prepare("SELECT envelope FROM sync_ops WHERE verified=1 AND kind='purge' UNION SELECT envelope FROM suppression").map_err(|e|e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let values: Result<Vec<Envelope>> = rows
            .map(|r| {
                serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
            })
            .collect();
        drop(stmt);
        let mut erased = false;
        for e in values? {
            let r = &e.header.revision;
            let chain: Option<(String, i64)> = self
                .db
                .query_row(
                    "SELECT envelope,verified FROM sync_ops WHERE origin=?1 AND sequence=?2",
                    params![r.dot.origin, r.dot.sequence as i64],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let Some((chain, verified)) = chain else {
                continue;
            };
            if verified == 0 {
                continue;
            }
            let chain: Envelope = serde_json::from_str(&chain).map_err(|e| e.to_string())?;
            if wire::canonical(&chain.header)? != wire::canonical(&e.header)? {
                return Err("Purge proof equivocates with the durable signed chain".into());
            }
            if !self.purge_eligible(&e)? {
                continue;
            }
            self.db
                .execute(
                    "INSERT OR IGNORE INTO suppression_effects VALUES (?1,?2,?3)",
                    params![r.id(), r.dot.origin, r.dot.sequence as i64],
                )
                .map_err(|e| e.to_string())?;
            let p = e.payload.ok_or("Missing purge proof")?;
            for revision in p["revisionIds"]
                .as_array()
                .ok_or("Invalid purge revisions")?
            {
                let revision = revision.as_str().ok_or("Invalid purge revision")?;
                self.db
                    .execute("INSERT OR IGNORE INTO purged VALUES (?1)", [revision])
                    .map_err(|e| e.to_string())?;
                erased |= self
                    .db
                    .execute("DELETE FROM recovery WHERE id=?1", [revision])
                    .map_err(|e| e.to_string())?
                    > 0;
                if let Some((origin, seq)) = revision.rsplit_once(':') {
                    if let Ok(seq) = seq.parse::<u64>() {
                        if let Some(mut operation) = self.operation(origin, seq)? {
                            if operation.header.kind == "purge"
                                || operation.header.kind == "tagAlias"
                            {
                                return Err("Erasure cannot remove purge or alias proofs".into());
                            }
                            if operation.payload.is_none() {
                                continue;
                            }
                            erased = true;
                            operation.payload = None;
                            self.db.execute("UPDATE sync_ops SET envelope=?3 WHERE origin=?1 AND sequence=?2",params![origin,seq as i64,serde_json::to_string(&operation).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
                        }
                    }
                }
            }
            for entity in p["entityIds"].as_array().ok_or("Invalid purge entities")? {
                let entity = uuid(entity.as_str().ok_or("Invalid retired entity")?)?;
                self.db
                    .execute(
                        "INSERT OR IGNORE INTO retired VALUES ('thought',?1)",
                        [entity],
                    )
                    .map_err(|e| e.to_string())?;
                erased |= self
                    .db
                    .execute(
                        "DELETE FROM objects WHERE kind='thought' AND id=?1",
                        [entity],
                    )
                    .map_err(|e| e.to_string())?
                    > 0;
                erased |= self
                    .db
                    .execute(
                        "DELETE FROM recovery WHERE kind='thought' AND entity_id=?1",
                        [entity],
                    )
                    .map_err(|e| e.to_string())?
                    > 0;
                let mut stmt=self.db.prepare("SELECT envelope FROM sync_ops WHERE kind IN ('thought','archiveThought') AND entity_id=?1").map_err(|e|e.to_string())?;
                let rows = stmt
                    .query_map([entity], |r| r.get::<_, String>(0))
                    .map_err(|e| e.to_string())?;
                let old: Result<Vec<Envelope>> = rows
                    .map(|r| {
                        serde_json::from_str(&r.map_err(|e| e.to_string())?)
                            .map_err(|e| e.to_string())
                    })
                    .collect();
                drop(stmt);
                for mut old in old? {
                    if old.payload.is_none() {
                        continue;
                    }
                    erased = true;
                    old.payload = None;
                    let r = &old.header.revision;
                    self.db
                        .execute(
                            "UPDATE sync_ops SET envelope=?3 WHERE origin=?1 AND sequence=?2",
                            params![
                                r.dot.origin,
                                r.dot.sequence as i64,
                                serde_json::to_string(&old).map_err(|e| e.to_string())?
                            ],
                        )
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        if erased {
            self.set_metadata("purgeCheckpoint", "1")?;
        }
        Ok(())
    }
    pub(crate) fn checkpoint_purges(&self) -> Result<()> {
        if self.metadata("purgeCheckpoint")?.as_deref() != Some("1") {
            return Ok(());
        }
        if !self.db.is_autocommit() {
            return Err("Erasure checkpoint requires committed metadata".into());
        }
        let busy: i64 = self
            .db
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if busy != 0 {
            return Err("Erasure checkpoint is waiting for storage readers".into());
        }
        self.db
            .execute("DELETE FROM metadata WHERE key='purgeCheckpoint'", [])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    fn purge_eligible(&self, proof: &Envelope) -> Result<bool> {
        let mut stmt = self
            .db
            .prepare("SELECT envelope FROM sync_ops WHERE verified>0")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut headers = Vec::new();
        let mut body_present = BTreeSet::new();
        for row in rows {
            let mut e: Envelope = serde_json::from_str(&row.map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            if e.payload.is_some() {
                body_present.insert(e.header.revision.id());
            }
            if e.header.revision.id() != proof.header.revision.id() {
                e.payload = None;
            }
            headers.push(e);
        }
        drop(stmt);
        let mut purged = BTreeSet::new();
        let mut stmt = self
            .db
            .prepare("SELECT revision_id FROM purged")
            .map_err(|e| e.to_string())?;
        for row in stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
        {
            purged.insert(row.map_err(|e| e.to_string())?);
        }
        drop(stmt);
        let mut retired = BTreeSet::new();
        let mut stmt = self
            .db
            .prepare("SELECT id FROM retired WHERE kind='thought'")
            .map_err(|e| e.to_string())?;
        for row in stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
        {
            retired.insert(row.map_err(|e| e.to_string())?);
        }
        drop(stmt);
        museamo_sync_core::purge::eligible(&museamo_sync_core::purge::Input {
            proof: proof.clone(),
            headers,
            body_present,
            applied: self.receipts()?,
            authorized_history: serde_json::from_str(
                &self.metadata("authorizedHistory")?.unwrap_or("{}".into()),
            )
            .map_err(|e| e.to_string())?,
            authorized_anchors: serde_json::from_str(
                &self.metadata("authorizedAnchors")?.unwrap_or("{}".into()),
            )
            .map_err(|e| e.to_string())?,
            purged,
            retired,
        })
    }
    pub(crate) fn assert_erasure_receipts(&self) -> Result<()> {
        let applied = self.receipts()?;
        let mut stmt = self
            .db
            .prepare("SELECT origin,sequence FROM suppression_effects")
            .map_err(|e| e.to_string())?;
        for row in stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| e.to_string())?
        {
            let (origin, sequence) = row.map_err(|e| e.to_string())?;
            if applied.get(&origin).copied().unwrap_or(0) < sequence as u64 {
                return Err("Erasure awaits its complete applied causal history".into());
            }
        }
        Ok(())
    }
    pub fn enroll(&mut self, group: &str) -> Result<()> {
        if group.len() < 16 || group.len() > 128 {
            return Err("Invalid linked library identity".into());
        }
        if let Some(existing) = self.metadata("group")? {
            if existing == group {
                return Ok(());
            }
            return Err("This device already belongs to another linked library".into());
        }
        self.db
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        let result = (|| -> Result<()> {
            let mut previous = String::new();
            let prefix = self.receipts()?.get(&self.device).copied().unwrap_or(0);
            for sequence in 1..=prefix {
                let mut e = self
                    .operation(&self.device, sequence)?
                    .ok_or("Missing local history")?;
                e.header.group = group.into();
                e.header.previous_hash = previous;
                e.signature = self
                    .identity
                    .as_ref()
                    .ok_or("Identity unavailable")?
                    .sign(&wire::signing_bytes(&e.header)?);
                previous = wire::hash(&wire::canonical(&e.header)?);
                self.db
                    .execute(
                        "UPDATE sync_ops SET envelope=?3 WHERE origin=?1 AND sequence=?2",
                        params![
                            self.device,
                            sequence as i64,
                            serde_json::to_string(&e).map_err(|e| e.to_string())?
                        ],
                    )
                    .map_err(|e| e.to_string())?;
            }
            self.set_metadata("group", group)?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                self.db.execute_batch("COMMIT").map_err(|e| e.to_string())?;
                Ok(())
            }
            Err(e) => {
                let _ = self.db.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }
    pub fn apply(&mut self, input: &Value) -> Result<Value> {
        let group = string(input, "groupId")?;
        if self.metadata("group")?.as_deref() != Some(group) {
            return Err("Wrong linked library".into());
        }
        let members = input["members"].as_array().ok_or("Missing membership")?;
        let keys: Result<BTreeMap<&str, Vec<u8>>> = members
            .iter()
            .map(|m| {
                Ok((
                    string(m, "deviceId")?,
                    hex::decode(string(m, "signingPublic")?)
                        .map_err(|_| "Invalid member signing key")?,
                ))
            })
            .collect();
        let keys = keys?;
        let history = input["authorizedHistory"].as_object();
        let envelopes: Vec<Envelope> =
            serde_json::from_value(input["envelopes"].clone()).map_err(|e| e.to_string())?;
        if envelopes.len() > 32 {
            return Err("Too many changes in one batch".into());
        }
        self.db
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        let result = (|| -> Result<Value> {
            self.set_metadata(
                "authorizedAnchors",
                &input
                    .get("authorizedAnchors")
                    .cloned()
                    .unwrap_or(json!({}))
                    .to_string(),
            )?;
            self.set_metadata(
                "authorizedHistory",
                &input
                    .get("authorizedHistory")
                    .cloned()
                    .unwrap_or(json!({}))
                    .to_string(),
            )?;
            for raw in input["purgeProofs"].as_array().into_iter().flatten() {
                let e: Envelope = serde_json::from_value(raw.clone()).map_err(|e| e.to_string())?;
                let r = &e.header.revision;
                if e.header.kind != "purge" {
                    return Err("Invalid suppression proof kind".into());
                }
                let key = keys
                    .get(r.dot.origin.as_str())
                    .ok_or("Unknown purge author")?;
                if history
                    .and_then(|v| v.get(&r.dot.origin))
                    .is_some_and(|n| r.dot.sequence > n.as_u64().unwrap_or(0))
                {
                    return Err("Unauthorized purge history".into());
                }
                wire::verify(&e, group, key, false)?;
                validate_operation(&e)?;
                if let Some(existing) = self.operation(&r.dot.origin, r.dot.sequence)? {
                    if wire::canonical(&existing.header)? != wire::canonical(&e.header)? {
                        return Err(
                            "Suppression proof conflicts with an existing signed change".into()
                        );
                    }
                }
                let revision = r.id();
                let previous: Option<String> = self
                    .db
                    .query_row(
                        "SELECT envelope FROM suppression WHERE id=?1",
                        [&revision],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                let encoded = serde_json::to_string(&e).map_err(|e| e.to_string())?;
                if previous.as_ref().is_some_and(|v| v != &encoded) {
                    return Err("Conflicting suppression proof".into());
                }
                self.db
                    .execute(
                        "INSERT OR IGNORE INTO suppression VALUES (?1,?2)",
                        params![revision, encoded],
                    )
                    .map_err(|e| e.to_string())?;
            }
            self.apply_purges()?;
            let mut suppression = self
                .db
                .prepare("SELECT envelope FROM suppression")
                .map_err(|e| e.to_string())?;
            let rows = suppression
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            let mut provisional = BTreeSet::new();
            let mut provisional_retired = BTreeSet::new();
            for row in rows {
                let proof: Envelope = serde_json::from_str(&row.map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
                let p = proof.payload.as_ref().ok_or("Missing suppression body")?;
                for revision in p["revisionIds"]
                    .as_array()
                    .ok_or("Invalid suppression body")?
                {
                    provisional.insert(
                        revision
                            .as_str()
                            .ok_or("Invalid suppression revision")?
                            .to_owned(),
                    );
                }
                for entity in p["entityIds"]
                    .as_array()
                    .ok_or("Invalid suppression entities")?
                {
                    provisional_retired.insert(
                        entity
                            .as_str()
                            .ok_or("Invalid suppression entity")?
                            .to_owned(),
                    );
                }
            }
            drop(suppression);
            for e in envelopes {
                let r = &e.header.revision;
                uuid(&r.entity_id)?;
                uuid(&r.dot.origin)?;
                if r.dot.sequence > i64::MAX as u64
                    || r.clock.wall > i64::MAX as u64
                    || r.context.len() > 256
                    || r.context.get(&r.dot.origin).copied().unwrap_or(0) >= r.dot.sequence
                {
                    return Err("Invalid causal record".into());
                }
                let key = keys
                    .get(r.dot.origin.as_str())
                    .ok_or("Unknown change author")?;
                if history
                    .and_then(|v| v.get(&r.dot.origin))
                    .is_some_and(|n| r.dot.sequence > n.as_u64().unwrap_or(0))
                {
                    return Err("Removed device change is beyond the witnessed history".into());
                }
                if r.context
                    .keys()
                    .any(|origin| !keys.contains_key(origin.as_str()))
                {
                    return Err("Causal context references an unknown identity".into());
                }
                // Provisional proof references authorize storage of signed headers only. They
                // never authorize projection, an applied receipt, or deletion of existing bytes.
                wire::verify(
                    &e,
                    group,
                    key,
                    self.is_purged(&r.id())?
                        || provisional.contains(&r.id())
                        || (matches!(e.header.kind.as_str(), "thought" | "archiveThought")
                            && (self.is_retired("thought", &r.entity_id)?
                                || provisional_retired.contains(&r.entity_id))),
                )?;
                validate_operation(&e)?;
                if let Some(existing) = self.operation(&r.dot.origin, r.dot.sequence)? {
                    if wire::canonical(&existing.header)? != wire::canonical(&e.header)? {
                        return Err(
                            "Conflicting signed history; this identity is quarantined".into()
                        );
                    }
                    if existing.payload.is_none()
                        && e.payload.is_some()
                        && !self.is_purged(&r.id())?
                        && !(matches!(e.header.kind.as_str(), "thought" | "archiveThought")
                            && self.is_retired("thought", &r.entity_id)?)
                    {
                        self.db
                            .execute(
                                "UPDATE sync_ops SET envelope=?3 WHERE origin=?1 AND sequence=?2",
                                params![
                                    r.dot.origin,
                                    r.dot.sequence as i64,
                                    serde_json::to_string(&e).map_err(|e| e.to_string())?
                                ],
                            )
                            .map_err(|e| e.to_string())?;
                    }
                    continue;
                }
                self.db
                    .execute(
                        "INSERT INTO sync_ops VALUES (?1,?2,?3,?4,?5,0)",
                        params![
                            r.dot.origin,
                            r.dot.sequence as i64,
                            e.header.kind,
                            r.entity_id,
                            serde_json::to_string(&e).map_err(|e| e.to_string())?
                        ],
                    )
                    .map_err(|e| e.to_string())?;
            }
            // A distinct durable staging cursor pages long witnessed prefixes without projecting
            // unanchored changes or counting them in a revocation checkpoint.
            loop {
                let staged = self.staged_receipts()?;
                let mut stmt = self
                    .db
                    .prepare(
                        "SELECT envelope FROM sync_ops WHERE verified=0 ORDER BY sequence,origin",
                    )
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map([], |r| r.get::<_, String>(0))
                    .map_err(|e| e.to_string())?;
                let pending: Result<Vec<Envelope>> = rows
                    .map(|r| {
                        serde_json::from_str(&r.map_err(|e| e.to_string())?)
                            .map_err(|e| e.to_string())
                    })
                    .collect();
                drop(stmt);
                let mut changed = false;
                for e in pending? {
                    let r = &e.header.revision;
                    let prefix = staged.get(&r.dot.origin).copied().unwrap_or(0);
                    if r.dot.sequence != prefix + 1 {
                        continue;
                    }
                    let previous = if prefix == 0 {
                        String::new()
                    } else {
                        wire::hash(&wire::canonical(
                            &self
                                .operation(&r.dot.origin, prefix)?
                                .ok_or("Missing durable predecessor")?
                                .header,
                        )?)
                    };
                    if e.header.previous_hash != previous {
                        return Err("Signed history chain does not match".into());
                    }
                    if prefix > 0 {
                        let prior = self
                            .operation(&r.dot.origin, prefix)?
                            .ok_or("Missing signed predecessor")?;
                        if prior
                            .header
                            .revision
                            .context
                            .iter()
                            .any(|(o, s)| r.context.get(o).copied().unwrap_or(0) < *s)
                        {
                            return Err("A signed change drops earlier causal dependencies".into());
                        }
                    }
                    self.db
                        .execute(
                            "UPDATE sync_ops SET verified=2 WHERE origin=?1 AND sequence=?2",
                            params![r.dot.origin, r.dot.sequence as i64],
                        )
                        .map_err(|e| e.to_string())?;
                    changed = true;
                }
                if !changed {
                    break;
                }
            }
            self.apply_purges()?;
            loop {
                self.apply_purges()?;
                let receipts = self.receipts()?;
                let mut stmt = self
                    .db
                    .prepare(
                        "SELECT envelope FROM sync_ops WHERE verified=2 ORDER BY sequence,origin",
                    )
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map([], |r| r.get::<_, String>(0))
                    .map_err(|e| e.to_string())?;
                let pending: Result<Vec<Envelope>> = rows
                    .map(|r| {
                        serde_json::from_str(&r.map_err(|e| e.to_string())?)
                            .map_err(|e| e.to_string())
                    })
                    .collect();
                drop(stmt);
                let mut applied = false;
                for e in pending? {
                    let r = &e.header.revision;
                    let prefix = receipts.get(&r.dot.origin).copied().unwrap_or(0);
                    if r.dot.sequence != prefix + 1
                        || r.context
                            .iter()
                            .any(|(o, s)| receipts.get(o).copied().unwrap_or(0) < *s)
                        || !self.anchor_ready(&r.dot.origin)?
                        || !self.origin_allows(&r.dot.origin, r.dot.sequence)?
                    {
                        continue;
                    }
                    if e.payload.is_none()
                        && !self.is_purged(&r.id())?
                        && !(matches!(e.header.kind.as_str(), "thought" | "archiveThought")
                            && self.is_retired("thought", &r.entity_id)?)
                    {
                        continue;
                    }
                    let previous = if prefix == 0 {
                        String::new()
                    } else {
                        wire::hash(&wire::canonical(
                            &self
                                .operation(&r.dot.origin, prefix)?
                                .ok_or("Missing durable predecessor")?
                                .header,
                        )?)
                    };
                    if e.header.previous_hash != previous {
                        return Err("Signed history chain does not match".into());
                    }
                    self.db
                        .execute(
                            "UPDATE sync_ops SET verified=1 WHERE origin=?1 AND sequence=?2",
                            params![r.dot.origin, r.dot.sequence as i64],
                        )
                        .map_err(|e| e.to_string())?;
                    self.project(&e.header.kind, &r.entity_id)?;
                    let clock = self
                        .metadata("clock")?
                        .map(|v| serde_json::from_str::<Clock>(&v).map_err(|e| e.to_string()))
                        .transpose()?
                        .unwrap_or_default()
                        .tick(now(), Some(r.clock))?;
                    self.set_metadata(
                        "clock",
                        &serde_json::to_string(&clock).map_err(|e| e.to_string())?,
                    )?;
                    applied = true;
                }
                if !applied {
                    break;
                }
            }
            // Erasure proofs may precede the erased revisions; headers remain permanently verifiable.
            self.apply_purges()?;
            self.assert_erasure_receipts()?;
            Ok(json!({"receipts":self.receipts()?,"stagedReceipts":self.staged_receipts()?}))
        })();
        match result {
            Ok(v) => {
                self.db.execute_batch("COMMIT").map_err(|e| e.to_string())?;
                self.collect_media()?;
                self.checkpoint_purges()?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.db.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }
    pub fn export_changes(&self, input: &Value) -> Result<Value> {
        if self.metadata("group")?.as_deref() != input["groupId"].as_str() {
            return Err("Wrong linked library".into());
        }
        let after: Context =
            serde_json::from_value(input.get("after").cloned().unwrap_or(json!({})))
                .map_err(|e| e.to_string())?;
        let limit = input["limit"].as_u64().unwrap_or(32).clamp(1, 32) as usize;
        let mut proofs = self
            .db
            .prepare("SELECT envelope FROM sync_ops WHERE verified=1 AND kind='purge'")
            .map_err(|e| e.to_string())?;
        let proof_rows = proofs
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut proof_values: Vec<Envelope> = proof_rows
            .map(|r| {
                serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
            })
            .collect::<Result<_>>()?;
        drop(proofs);
        proof_values.sort_by_key(|e| serde_json::to_vec(e).map(|b| b.len()).unwrap_or(usize::MAX));
        let mut included_proofs: BTreeMap<String, Envelope> = BTreeMap::new();
        let mut bytes = 64 * 1024usize;
        let mut stmt = self
            .db
            .prepare("SELECT envelope FROM sync_ops WHERE verified=1 ORDER BY sequence,origin")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut result = vec![];
        let mut more = false;
        for r in rows {
            let e: Envelope =
                serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            if e.header.revision.dot.sequence
                <= after
                    .get(&e.header.revision.dot.origin)
                    .copied()
                    .unwrap_or(0)
            {
                continue;
            }
            if result.len() == limit {
                more = true;
                break;
            }
            let required = if e.payload.is_none() {
                Some(
                    proof_values
                        .iter()
                        .find(|proof| {
                            proof.payload.as_ref().is_some_and(|p| {
                                p["revisionIds"].as_array().is_some_and(|ids| {
                                    ids.iter()
                                        .any(|id| id.as_str() == Some(&e.header.revision.id()))
                                }) || (matches!(
                                    e.header.kind.as_str(),
                                    "thought" | "archiveThought"
                                ) && p["entityIds"].as_array().is_some_and(|ids| {
                                    ids.iter()
                                        .any(|id| id.as_str() == Some(&e.header.revision.entity_id))
                                }))
                            })
                        })
                        .ok_or("Cleared history lacks an applied suppression proof")?,
                )
            } else {
                None
            };
            let proof_bytes = required
                .filter(|p| !included_proofs.contains_key(&p.header.revision.id()))
                .map(|p| {
                    serde_json::to_vec(p)
                        .map(|v| v.len() + 1)
                        .map_err(|e| e.to_string())
                })
                .transpose()?
                .unwrap_or(0);
            let next =
                bytes + serde_json::to_vec(&e).map_err(|e| e.to_string())?.len() + 1 + proof_bytes;
            if next > museamo_sync_core::MAX_PAYLOAD_BYTES {
                if result.is_empty() {
                    return Err("A saved change and its proof exceed the sync message limit".into());
                }
                more = true;
                break;
            }
            if let Some(proof) = required {
                included_proofs
                    .entry(proof.header.revision.id())
                    .or_insert_with(|| proof.clone());
            }
            bytes = next;
            result.push(e);
        }
        Ok(
            json!({"envelopes":result,"more":more,"purgeProofs":included_proofs.into_values().collect::<Vec<_>>()}),
        )
    }
    pub fn restore_recovery(&mut self, revision: &str) -> Result<Value> {
        let row: Option<(String, String)> = self
            .db
            .query_row(
                "SELECT kind,payload FROM recovery WHERE id=?1",
                [revision],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let (kind, payload) = row.ok_or("This version has already been cleared")?;
        let mut payload: Value = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
        let next = id();
        payload["id"] = json!(next);
        payload
            .as_object_mut()
            .ok_or("Invalid Recovery version")?
            .remove("revision");
        if kind == "thought" {
            payload["createdAt"] = json!(now());
            payload["updatedAt"] = json!(now());
            payload["tagIds"] = json!(self.valid_tags(&payload["tagIds"])?);
        } else if kind == "tag" {
            let original = string(&payload, "name")?.to_owned();
            let names: BTreeSet<String> = self
                .all("tag")?
                .iter()
                .filter_map(|t| t["name"].as_str())
                .map(museamo_sync_core::normalize_tag)
                .collect();
            if names.contains(&museamo_sync_core::normalize_tag(&original)) {
                let suffix = format!(" (recovered {})", &next[..8]);
                let mut units = 0;
                let prefix: String = original
                    .chars()
                    .take_while(|c| {
                        units += c.len_utf16();
                        units <= 80 - suffix.encode_utf16().count()
                    })
                    .collect();
                payload["name"] = json!(format!("{prefix}{suffix}"));
            }
        } else {
            return Err("Unknown Recovery version kind".into());
        }
        self.record(&kind, &next, payload, false)?;
        Ok(json!({"entryId":next,"kind":kind}))
    }
    pub fn clear_recovery(&mut self, only: Option<&str>) -> Result<Value> {
        let mut stmt = self
            .db
            .prepare("SELECT id,kind,entity_id FROM recovery ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let records: Result<Vec<_>> = rows.map(|r| r.map_err(|e| e.to_string())).collect();
        drop(stmt);
        let mut records: Vec<_> = records?
            .into_iter()
            .filter(|(i, _, _)| only.is_none_or(|v| i == v))
            .collect();
        let mut private=vec![];for record in records {if !self.clear_shared_recovery(&record.0)?{private.push(record);}}records=private;
        if records.is_empty() {
            return Ok(json!({}));
        }
        let mut entities = BTreeSet::new();
        for (_, kind, entity) in &records {
            if kind == "thought" && self.get("thought", entity)?.is_none() {
                entities.insert(entity.clone());
            }
        }
        let revisions: Vec<_> = records.iter().map(|(id, _, _)| id).collect();
        let entity = id();
        self.record(
            "purge",
            &entity,
            json!({"revisionIds":revisions,"entityIds":entities}),
            false,
        )?;
        self.collect_media()?;
        self.checkpoint_purges()?;
        Ok(json!({}))
    }
    /// Only call after the metadata/journal transaction has committed. Retained revision bodies,
    /// drafts and temporary editor pins protect originals, including provisional staged changes.
    pub fn collect_media(&self) -> Result<()> {
        if !self.db.is_autocommit() {
            return Err("Original collection requires committed metadata".into());
        }
        let mut referenced = referenced_media(self, true)?;
        let mut stmt = self
            .db
            .prepare("SELECT envelope FROM sync_ops")
            .map_err(|e| e.to_string())?;
        for row in stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
        {
            let e: Envelope = serde_json::from_str(&row.map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            if let Some(body) = e.payload {
                let p = if matches!(e.header.kind.as_str(), "archiveThought" | "archiveTag") {
                    &body["payload"]
                } else {
                    &body
                };
                for a in p["attachments"].as_array().into_iter().flatten() {
                    referenced
                        .entry(string(a, "id")?.to_owned())
                        .or_insert(a.clone());
                }
            }
        }
        drop(stmt);
        for m in self.all("media")? {
            let id = uuid(string(&m, "id")?)?;
            if referenced.contains_key(id)
                || self
                    .metadata(&format!("mediaPin:{id}"))?
                    .and_then(|v| v.parse::<u64>().ok())
                    .is_some_and(|until| until > now())
            {
                continue;
            }
            for path in [
                self.root.join("media").join(id),
                self.root.join("staging").join(format!("sync-{id}")),
            ] {
                if path.exists() {
                    std::fs::remove_file(path).map_err(|e| e.to_string())?;
                }
            }
            self.db
                .execute("DELETE FROM objects WHERE kind='media' AND id=?1", [id])
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

pub(crate) use museamo_sync_core::validation::{validate_operation, validate_thought, validate_media};

pub struct NativePlatform {
    pub store: Arc<Mutex<Store>>,
    pub app: Option<tauri::AppHandle>,
    pending_event: Arc<std::sync::atomic::AtomicBool>,
}
impl NativePlatform {
    pub fn new(store: Arc<Mutex<Store>>, app: Option<tauri::AppHandle>) -> Self {
        Self {
            store,
            app,
            pending_event: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }
}
impl museamo_sync_core::Platform for NativePlatform {
    fn call(&self, method: &str, input: Value) -> Result<Value> {
        let mut db = self.store.lock().map_err(|_| "Storage unavailable")?;
        let previous_changes = db.db.total_changes();
        let result = match method {
            "syncSharingRequired" => Ok(json!({"required":db.sharing_registry()?.bindings.values().any(|b|!b.detached)})),
            "shareLoad"|"sharePending"|"shareSeed"|"shareCommit" => db.sharing_call(method,&input),
            "shareMissingMedia" => {
                let allowed=db.scoped_media(string(&input,"scope")?)?;
                missing_media(&db,&json!({"limit":32,"allowed":allowed}))
            },
            "shareReadMedia" => {if !db.scoped_media(string(&input,"scope")?)?.contains(string(&input,"id")?){return Err("Original is not in this shared list".into());}read_media(&db,&input)},
            "shareWriteMedia" => {if !db.scoped_media(string(&input,"scope")?)?.contains(string(&input,"id")?){return Err("Original is not in this shared list".into());}write_media(&db,&input)},
            "syncIdentity" => db
                .identity
                .as_ref()
                .ok_or("Identity unavailable")?
                .value(&db),
            "syncSign" => {
                let bytes =
                    hex::decode(string(&input, "bytes")?).map_err(|_| "Invalid signing bytes")?;
                Ok(
                    json!({"signature":db.identity.as_ref().ok_or("Identity unavailable")?.sign(&bytes)}),
                )
            }
            "syncLoad" => Ok(
                json!({"state":db.metadata("syncState")?.map(|v|serde_json::from_str::<Value>(&v).map_err(|e|e.to_string())).transpose()?}),
            ),
            "syncSave" => {
                db.set_metadata("syncState", &input["state"].to_string())?;
                Ok(json!({}))
            }
            "syncSummary" => {
                let media = db.all("media")?;
                Ok(
                    json!({"thoughts":db.all("thought")?.len(),"tags":db.all("tag")?.len(),"attachments":media.len(),"attachmentBytes":media.iter().filter_map(|m|m["byteSize"].as_u64()).sum::<u64>()}),
                )
            }
            "syncEnroll" => {
                db.enroll(string(&input, "groupId")?)?;
                Ok(json!({}))
            }
            "syncEnrollmentTags" => Ok(json!({"tags":db.all("tag")?.into_iter().filter(|t|db.sharing_metadata(t["id"].as_str().unwrap_or("")).ok().flatten().is_none()).collect::<Vec<_>>()})),
            "syncCoalesceTags" => db.coalesce_tags(&input),
            "syncExport" => db.export_changes(&input),
            "syncApply" => db.apply(&input),
            "syncReceipts" => {
                Ok(json!({"receipts":db.receipts()?,"stagedReceipts":db.staged_receipts()?}))
            }
            "syncHeader" => {
                let origin = string(&input, "origin")?;
                let sequence = input["sequence"].as_u64().ok_or("Invalid sequence")?;
                Ok(
                    json!({"hash":db.operation(origin,sequence)?.map(|e|wire::canonical(&e.header).map(|v|wire::hash(&v))).transpose()?}),
                )
            }
            "syncMissingMedia" => missing_media(&db, &input),
            "syncReadMedia" => read_media(&db, &input),
            "syncWriteMedia" => write_media(&db, &input),
            _ => Err(format!("Unsupported native sync callback: {method}")),
        };
        let storage_changed = db.db.total_changes() != previous_changes;
        drop(db);
        if (result.is_ok() || storage_changed)
            && matches!(
                method,
                "syncApply" | "syncEnroll" | "syncWriteMedia" | "syncCoalesceTags" | "shareCommit" | "shareWriteMedia"
            )
        {
            if let Some(app) = &self.app {
                use std::sync::atomic::Ordering;
                if !self.pending_event.swap(true, Ordering::SeqCst) {
                    let app = app.clone();
                    let pending = self.pending_event.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(250));
                        pending.store(false, Ordering::SeqCst);
                        use tauri::Emitter;
                        let _ = app.emit("dataChanged", ());
                    });
                }
            }
        }
        result
    }
}

pub(crate) fn referenced_media(db: &Store, local: bool) -> Result<BTreeMap<String, Value>> {
    let mut references = BTreeMap::new();
    for kind in if local {
        vec!["thought", "draft"]
    } else {
        vec!["thought"]
    } {
        for e in db.all(kind)? {
            for a in e["attachments"].as_array().into_iter().flatten() {
                validate_media(a)?;
                let id = string(a, "id")?.to_owned();
                if let Some(previous) = references.insert(id, a.clone()) {
                    if previous["checksum"] != a["checksum"] {
                        return Err("Attachment identities conflict".into());
                    }
                }
            }
        }
    }
    let mut stmt = db
        .db
        .prepare("SELECT payload FROM recovery")
        .map_err(|e| e.to_string())?;
    for row in stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
    {
        let e: Value =
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        for a in e["attachments"].as_array().into_iter().flatten() {
            validate_media(a)?;
            references
                .entry(string(a, "id")?.to_owned())
                .or_insert(a.clone());
        }
    }
    Ok(references)
}
fn missing_media(db: &Store, input: &Value) -> Result<Value> {
    let mut items = vec![];
    let mut total = 0;
    let limit = input["limit"].as_u64().unwrap_or(32).clamp(1, 32) as usize;
    for (id, m) in referenced_media(db, false)? {
        if input["allowed"].as_array().is_some_and(|a| !a.iter().any(|v| v == &id)) { continue; }
        if !db.root.join("media").join(&id).is_file() {
            total += 1;
            if items.len() == limit {
                continue;
            }
            let offset = db
                .root
                .join("staging")
                .join(format!("sync-{id}"))
                .metadata()
                .map(|v| v.len())
                .unwrap_or(0);
            db.put_local("media", &id, &m)?;
            items.push(json!({"id":id,"checksum":m["checksum"],"size":m["byteSize"],"offset":offset,"metadata":m}));
        }
    }
    Ok(json!({"items":items,"totalCount":total}))
}
fn read_media(db: &Store, input: &Value) -> Result<Value> {
    let id = uuid(string(input, "id")?)?;
    if !referenced_media(db, false)?.contains_key(id) {
        return Err("Original is not referenced by the shared saved library".into());
    }
    let m = db.get("media", id)?.ok_or("Unknown original")?;
    let size = m["byteSize"].as_u64().ok_or("Invalid original size")?;
    let offset = input["offset"]
        .as_u64()
        .filter(|v| *v <= size)
        .ok_or("Invalid offset")?;
    let maximum = input["maxBytes"].as_u64().unwrap_or(16384).clamp(1, 16384) as usize;
    let mut file =
        std::fs::File::open(db.root.join("media").join(id)).map_err(|_| "Original is pending")?;
    if file.metadata().map_err(|e| e.to_string())?.len() != size {
        return Err("Original has incorrect length".into());
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let mut bytes = vec![0; maximum.min((size - offset) as usize)];
    file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    Ok(json!({"bytes":hex::encode(&bytes),"eof":offset+bytes.len()as u64==size}))
}
fn write_media(db: &Store, input: &Value) -> Result<Value> {
    let id = uuid(string(input, "id")?)?;
    let checksum = string(input, "checksum")?;
    let metadata = &input["metadata"];
    validate_media(metadata)?;
    if metadata["id"] != id
        || metadata["checksum"] != checksum
        || metadata["byteSize"] != input["size"]
    {
        return Err("Original metadata differs from the signed thought".into());
    }
    let expected = referenced_media(db, false)?
        .remove(id)
        .ok_or("Unrequested original")?;
    if expected["checksum"] != checksum || expected["byteSize"] != input["size"] {
        return Err("Original does not match a saved reference".into());
    }
    let bytes = hex::decode(string(input, "bytes")?).map_err(|_| "Invalid original chunk")?;
    if bytes.len() > 16384 {
        return Err("Original chunk too large".into());
    }
    let offset = input["offset"].as_u64().ok_or("Invalid original offset")?;
    let size = input["size"].as_u64().ok_or("Invalid original size")?;
    if offset
        .checked_add(bytes.len() as u64)
        .filter(|v| *v <= size)
        .is_none()
    {
        return Err("Original chunk exceeds its size".into());
    }
    let path = db.root.join("staging").join(format!("sync-{id}"));
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() != offset {
        return Err("Original resume offset changed".into());
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    file.sync_data().map_err(|e| e.to_string())?;
    let total = offset + bytes.len() as u64;
    if total == size {
        file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        use sha2::{Digest, Sha256};
        let mut digest = Sha256::new();
        let mut buffer = [0u8; 65536];
        loop {
            let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            digest.update(&buffer[..n]);
        }
        drop(file);
        if hex::encode(digest.finalize()) != checksum {
            let _ = std::fs::remove_file(&path);
            return Err("Original checksum failed; download will restart".into());
        }
        let final_path = db.root.join("media").join(id);
        if final_path.exists() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        } else {
            std::fs::rename(&path, &final_path).map_err(|e| e.to_string())?;
        }
        db.put_local("media", id, metadata)?;
    }
    Ok(json!({"offset":total,"complete":total==size}))
}
