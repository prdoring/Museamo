//! Native sharing persistence and projection. Never exposed as renderer platform primitives.
use crate::store::{id, now, string, Result, Store};
use museamo_sync_core::sharing::{local_id, shared_payload, Registry};
use rusqlite::params;
use serde_json::{json, Value};

pub fn active(scope: &Value, person: &str) -> bool {
    let controls = scope["controls"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if controls.iter().any(|c| c["body"]["kind"] == "stop") {
        return false;
    }
    controls
        .iter()
        .filter(|c| {
            matches!(c["body"]["kind"].as_str(), Some("open" | "grant"))
                && c["body"]["data"]["participant"] == person
        })
        .any(|g| {
            !controls.iter().any(|c| {
                matches!(c["body"]["kind"].as_str(), Some("remove" | "leave"))
                    && c["body"]["data"]["grant"] == g["id"]
            })
        })
}
impl Store {
    pub fn private_sharing_snapshot(&self, root: &mut Value) -> Result<()> {
        let registry = self.sharing_registry()?;
        let mut mapping = std::collections::BTreeMap::new();
        for binding in registry.bindings.values() {
            mapping.entry(binding.tag_id.clone()).or_insert_with(id);
            for entry in binding.entries.values() {
                mapping.entry(entry.clone()).or_insert_with(id);
            }
        }
        fn remap(value: &mut Value, mapping: &std::collections::BTreeMap<String, String>) {
            if let Some(object) = value.as_object_mut() {
                object.remove("revision");
                object.remove("sharing");
            }
            if let Some(next) = value["id"].as_str().and_then(|id| mapping.get(id)) {
                value["id"] = json!(next);
            }
            if let Some(tags) = value["tagIds"].as_array_mut() {
                for t in tags {
                    if let Some(next) = t.as_str().and_then(|id| mapping.get(id)) {
                        *t = json!(next);
                    }
                }
            }
        }
        for key in ["tags", "entries"] {
            if let Some(items) = root[key].as_array_mut() {
                for value in items {
                    remap(value, &mapping);
                }
            }
        }
        if let Some(items) = root["recovery"].as_array_mut() {
            for value in items {
                remap(&mut value["payload"], &mapping);
                if let Some(next) = value["entityId"].as_str().and_then(|id| mapping.get(id)) {
                    value["entityId"] = json!(next);
                }
                if value["id"]
                    .as_str()
                    .is_some_and(|id| id.starts_with("shared:"))
                {
                    value["id"] = json!(id());
                }
            }
        }
        Ok(())
    }
    pub fn personal_shared_projection(
        &self,
        kind: &str,
        entity: &str,
        incoming: Option<&Value>,
    ) -> Result<Option<Option<Value>>> {
        if self.shared_projection {
            return Ok(None);
        }
        let registry = self.sharing_registry()?;
        let Some((scope_id, binding)) = registry.bindings.iter().find(|(_, b)| {
            !b.detached
                && if kind == "tag" {
                    b.tag_id == entity
                } else {
                    kind == "thought" && b.entries.values().any(|id| id == entity)
                }
        }) else {
            return Ok(None);
        };
        let scope = &registry.scopes[scope_id];
        if kind == "tag" {
            let mut tag = scope.tag()?;
            tag["id"] = json!(entity);
            return Ok(Some(Some(tag)));
        }
        let item = binding
            .entries
            .iter()
            .find(|(_, id)| id.as_str() == entity)
            .ok_or("Missing sharing item")?
            .0;
        let heads = scope.heads()?;
        let Some(head) = heads.get(&format!("thought:{item}")) else {
            return Ok(Some(None));
        };
        let old = self.get("thought", entity)?;
        let mut stmt=self.db.prepare("SELECT payload FROM sharing_pending WHERE json_extract(payload,'$.localId')=?1 ORDER BY created_at DESC,rowid DESC LIMIT 1").map_err(|e|e.to_string())?;
        let pending = stmt
            .query_map([entity], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .next()
            .transpose()
            .map_err(|e| e.to_string())?
            .map(|v| serde_json::from_str::<Value>(&v).map_err(|e| e.to_string()))
            .transpose()?;
        if pending.as_ref().is_some_and(|p| p["deleted"] == true)
            || pending.is_none() && (head.revision.deleted || head.payload.is_null())
        {
            return Ok(Some(None));
        }
        let mut entry = pending
            .as_ref()
            .map(|p| p["payload"].clone())
            .unwrap_or(head.payload.clone());
        entry["id"] = json!(entity);
        let personal = incoming.or(old.as_ref());
        entry["starred"] = personal
            .map(|p| p["starred"].clone())
            .unwrap_or(json!(false));
        entry["profileId"] = old
            .as_ref()
            .map(|p| p["profileId"].clone())
            .unwrap_or(Value::Null);
        let mut tags = personal
            .and_then(|p| p["tagIds"].as_array())
            .cloned()
            .unwrap_or_default();
        tags.retain(|t| {
            registry
                .bindings
                .values()
                .all(|b| b.detached || t.as_str() != Some(&b.tag_id))
        });
        tags.push(json!(binding.tag_id));
        entry["tagIds"] = json!(tags);
        Ok(Some(Some(entry)))
    }
    pub fn clear_shared_recovery(&mut self, recovery: &str) -> Result<bool> {
        let Some(value) = recovery.strip_prefix("shared:") else {
            return Ok(false);
        };
        let (scope_id, revision) = value
            .split_once(':')
            .ok_or("Invalid shared Recovery identity")?;
        let registry = self.sharing_registry()?;
        let binding = registry
            .bindings
            .get(scope_id)
            .ok_or("Unknown shared Recovery scope")?;
        if binding.detached
            || self.sharing_metadata(&binding.tag_id)?.is_none()
            || !self.sharing_device_active(&registry.scopes[scope_id])?
        {
            return Err("You no longer belong to this shared hashtag".into());
        }
        let pending_id = id();
        let pending = json!({"id":pending_id,"scope":scope_id,"grant":binding.grant,"kind":"purge","revisionId":revision});
        self.db
            .execute(
                "INSERT INTO sharing_pending VALUES (?1,?2,?3)",
                params![pending_id, pending.to_string(), now() as i64],
            )
            .map_err(|e| e.to_string())?;
        self.db
            .execute("DELETE FROM recovery WHERE id=?1", [recovery])
            .map_err(|e| e.to_string())?;
        Ok(true)
    }
    pub fn sharing_registry(&self) -> Result<Registry> {
        Ok(self
            .metadata("shareRegistry")?
            .map(|v| serde_json::from_str(&v).map_err(|e| e.to_string()))
            .transpose()?
            .unwrap_or_default())
    }
    pub fn sharing_metadata(&self, tag: &str) -> Result<Option<Value>> {
        let registry = self.sharing_registry()?;
        let person = self.metadata("group")?.unwrap_or_default();
        for (id, binding) in &registry.bindings {
            if binding.tag_id != tag || binding.detached {
                continue;
            }
            let scope = registry.scopes.get(id).ok_or("Missing shared list")?;
            let value = serde_json::to_value(scope).map_err(|e| e.to_string())?;
            if !active(&value, &person) {
                continue;
            }
            let owner = scope
                .controls
                .iter()
                .find(|c| c.body.kind == "open")
                .ok_or("Missing share root")?
                .body
                .participant
                .clone();
            return Ok(Some(
                json!({"collectionId":id,"role":if owner==person{"owner"}else{"member"},"status":"waiting","lastSync":scope.last_sync}),
            ));
        }
        Ok(None)
    }
    fn sharing_device_active(&self, scope: &museamo_sync_core::sharing::Scope) -> Result<bool> {
        let person = self.metadata("group")?.unwrap_or_default();
        let proof = scope
            .proofs
            .get(&person)
            .ok_or("Missing personal sharing proof")?;
        let personal = self
            .metadata("syncState")?
            .map(|v| serde_json::from_str::<Value>(&v).map_err(|e| e.to_string()))
            .transpose()?
            .unwrap_or(Value::Null);
        museamo_sync_core::sharing::device_active(proof, &personal, &self.device)
    }
    pub fn validate_shared_tags(&self, tags: &Value) -> Result<()> {
        let mut count = 0;
        for tag in tags.as_array().ok_or("Invalid thought tags")? {
            if self
                .sharing_metadata(tag.as_str().ok_or("Invalid tag")?)?
                .is_some()
            {
                count += 1;
            }
        }
        if count > 1 {
            return Err(
                "A thought can belong to only one shared hashtag. Your draft is kept.".into(),
            );
        }
        Ok(())
    }
    pub fn record_sharing(
        &mut self,
        kind: &str,
        entity: &str,
        value: &Value,
        deleted: bool,
    ) -> Result<()> {
        if self.shared_projection {
            return Ok(());
        }
        if kind == "tag" {
            if self.sharing_metadata(entity)?.is_some() {
                return Err("Manage this shared hashtag on your phone.".into());
            }
            return Ok(());
        }
        if kind != "thought" {
            return Ok(());
        }
        self.validate_shared_tags(&value["tagIds"])?;
        let registry = self.sharing_registry()?;
        let person = self.metadata("group")?.unwrap_or_default();
        let prior = registry
            .bindings
            .iter()
            .find(|(_, b)| !b.detached && b.entries.values().any(|v| v == entity));
        let selected = registry.bindings.iter().find(|(_, b)| {
            !b.detached
                && value["tagIds"]
                    .as_array()
                    .is_some_and(|tags| tags.iter().any(|t| t.as_str() == Some(&b.tag_id)))
        });
        if prior.is_some()
            && selected.is_some()
            && prior.map(|(id, _)| id) != selected.map(|(id, _)| id)
        {
            return Err("Remove the current shared hashtag and save its private copy before adding another shared hashtag. Your draft is kept.".into());
        }
        let Some((scope_id, binding)) = prior.or(selected) else {
            return Ok(());
        };
        let scope = registry.scopes.get(scope_id).ok_or("Unknown shared list")?;
        if !active(
            &serde_json::to_value(scope).map_err(|e| e.to_string())?,
            &person,
        ) || !self.sharing_device_active(scope)?
        {
            return Err("You no longer belong to this shared hashtag. Reload the list.".into());
        }
        let item = binding
            .entries
            .iter()
            .find(|(_, local)| *local == entity)
            .map(|(item, _)| item.as_str())
            .unwrap_or(entity);
        let mut payload = shared_payload(value)?;
        payload["id"] = json!(item);
        let old = self.get("thought", entity)?;
        let removing = deleted || prior.is_some() && selected.map(|(id, _)| id) != Some(scope_id);
        if !removing
            && prior.is_some()
            && old
                .as_ref()
                .map(shared_payload)
                .transpose()?
                .is_some_and(|mut old| {
                    old["id"] = json!(item);
                    old == payload
                })
        {
            return Ok(());
        }
        let pending_id = id();
        let pending = json!({"id":pending_id,"scope":scope_id,"grant":binding.grant,"kind":"thought","entityId":item,"localId":entity,"payload":payload,"deleted":removing,"context":scope.receipts()});
        self.db
            .execute(
                "INSERT INTO sharing_pending VALUES (?1,?2,?3)",
                params![pending_id, pending.to_string(), now() as i64],
            )
            .map_err(|e| e.to_string())?;
        if removing && !deleted {
            let mut copy = value.clone();
            let next = local_id(scope_id, &person, &format!("{item}:detached:{pending_id}"));
            copy["id"] = json!(next);
            copy["tagIds"] = json!(value["tagIds"]
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .filter(|t| registry
                    .bindings
                    .values()
                    .all(|b| b.detached || t.as_str() != Some(&b.tag_id)))
                .cloned()
                .collect::<Vec<_>>());
            self.shared_projection = true;
            let result = self.record("thought", &next, copy, false);
            self.shared_projection = false;
            result?;
        }
        Ok(())
    }
    pub fn sharing_call(&mut self, method: &str, input: &Value) -> Result<Value> {
        match method {
            "shareLoad" => Ok(
                json!({"registry":self.metadata("shareRegistry")?.map(|v|serde_json::from_str::<Value>(&v).map_err(|e|e.to_string())).transpose()?}),
            ),
            "sharePending" => {
                let mut statement = self
                    .db
                    .prepare("SELECT payload FROM sharing_pending ORDER BY created_at,id")
                    .map_err(|e| e.to_string())?;
                let items = statement
                    .query_map([], |r| r.get::<_, String>(0))
                    .map_err(|e| e.to_string())?
                    .map(|r| {
                        serde_json::from_str::<Value>(&r.map_err(|e| e.to_string())?)
                            .map_err(|e| e.to_string())
                    })
                    .collect::<Result<Vec<_>>>()?;
                Ok(json!({"items":items}))
            }
            "shareSeed" => {
                let tag = string(input, "tagId")?;
                let value = self.get("tag", tag)?.ok_or("Hashtag no longer exists")?;
                let value = json!({"id":tag,"name":value["name"],"type":value["type"]});
                let entries = self
                    .all("thought")?
                    .into_iter()
                    .filter(|e| {
                        e["tagIds"]
                            .as_array()
                            .is_some_and(|a| a.iter().any(|t| t == tag))
                    })
                    .map(|e| {
                        if e["tagIds"].as_array().is_some_and(|a| {
                            a.iter().any(|t| {
                                self.sharing_metadata(t.as_str().unwrap_or(""))
                                    .ok()
                                    .flatten()
                                    .is_some()
                            })
                        }) {
                            return Err(
                                "Some thoughts already belong to another shared list".into()
                            );
                        }
                        shared_payload(&e)
                    })
                    .collect::<Result<Vec<_>>>()?;
                Ok(json!({"tag":value,"entries":entries}))
            }
            "shareCommit" => {
                self.db
                    .execute_batch("SAVEPOINT sharing_commit")
                    .map_err(|e| e.to_string())?;
                self.shared_projection = true;
                let result = self.commit_sharing(input);
                self.shared_projection = false;
                match result {
                    Ok(registry) => {
                        self.db
                            .execute_batch("RELEASE sharing_commit")
                            .map_err(|e| e.to_string())?;
                        Ok(json!({"registry":registry}))
                    }
                    Err(error) => {
                        let _ = self
                            .db
                            .execute_batch("ROLLBACK TO sharing_commit; RELEASE sharing_commit");
                        Err(error)
                    }
                }
            }
            _ => Err("Unknown native sharing callback".into()),
        }
    }
    fn commit_sharing(&mut self, input: &Value) -> Result<Registry> {
        if !input["seed"].is_null() {
            let current =
                self.sharing_call("shareSeed", &json!({"tagId":input["seed"]["tag"]["id"]}))?;
            if museamo_sync_core::wire::canonical(&current)?
                != museamo_sync_core::wire::canonical(&input["seed"])?
            {
                return Err("This hashtag changed while sharing was starting. Retry.".into());
            }
        }
        let previous = self.sharing_registry()?;
        let mut next: Registry = serde_json::from_value(input["registry"].clone())
            .map_err(|_| "Invalid sharing registry")?;
        let person = string(input, "participant")?;
        for id in input["ack"].as_array().ok_or("Invalid outbox receipt")? {
            self.db
                .execute(
                    "DELETE FROM sharing_pending WHERE id=?1",
                    [id.as_str().ok_or("Invalid outbox ID")?],
                )
                .map_err(|e| e.to_string())?;
        }
        let pending = self.sharing_call("sharePending", &json!({}))?["items"]
            .as_array()
            .ok_or("Invalid outbox")?
            .iter()
            .filter_map(|p| p["localId"].as_str().map(str::to_owned))
            .collect::<std::collections::BTreeSet<_>>();
        for projection in input["projections"]
            .as_array()
            .ok_or("Invalid sharing projection")?
        {
            let scope_id = string(projection, "collectionId")?;
            let binding = next
                .bindings
                .get_mut(scope_id)
                .ok_or("Missing sharing binding")?;
            let scope = next.scopes.get(scope_id).ok_or("Missing sharing scope")?;
            if !active(
                &serde_json::to_value(scope).map_err(|e| e.to_string())?,
                person,
            ) {
                binding.detached = true;
            }
            if binding.detached {
                if let Some(old) = previous.bindings.get(scope_id).filter(|b| !b.detached) {
                    self.detach_sharing(scope_id, person, old)?;
                }
                continue;
            }
            let mut tag = projection["tag"].clone();
            tag["id"] = json!(binding.tag_id);
            if self.get("tag", &binding.tag_id)?.as_ref() != Some(&tag) {
                self.record("tag", &binding.tag_id, tag, false)?;
            }
            for item in projection["items"]
                .as_array()
                .ok_or("Invalid shared items")?
            {
                let item_id = string(item, "itemId")?;
                let entry_id = binding
                    .entries
                    .entry(item_id.into())
                    .or_insert_with(|| {
                        local_id(scope_id, person, &format!("{}:{item_id}", binding.tag_id))
                    })
                    .clone();
                if pending.contains(&entry_id) {
                    continue;
                }
                let old = self.get("thought", &entry_id)?;
                if item["deleted"] == true {
                    if let Some(old) = old {
                        self.record("thought", &entry_id, old, true)?;
                    }
                    continue;
                }
                let mut entry = item["payload"].clone();
                entry["id"] = json!(entry_id);
                entry["starred"] = old
                    .as_ref()
                    .map(|e| e["starred"].clone())
                    .unwrap_or(json!(false));
                entry["profileId"] = old
                    .as_ref()
                    .map(|e| e["profileId"].clone())
                    .unwrap_or(Value::Null);
                let mut tags = old
                    .as_ref()
                    .and_then(|e| e["tagIds"].as_array())
                    .cloned()
                    .unwrap_or_default();
                tags.retain(|t| {
                    t.as_str() != Some(&binding.tag_id)
                        && previous
                            .bindings
                            .values()
                            .all(|b| b.detached || t.as_str() != Some(&b.tag_id))
                });
                tags.push(json!(binding.tag_id));
                entry["tagIds"] = json!(tags);
                for media in entry["attachments"]
                    .as_array()
                    .ok_or("Invalid shared attachments")?
                {
                    crate::replica::validate_media(media)?;
                    let id = string(media, "id")?;
                    if let Some(stored) = self.get("media", id)? {
                        if stored != *media {
                            return Err("Shared attachment identity conflicts".into());
                        }
                    }
                    self.put_local("media", id, media)?;
                }
                let mut compare = old.clone();
                if let Some(ref mut compare) = compare {
                    compare
                        .as_object_mut()
                        .ok_or("Invalid thought")?
                        .remove("revision");
                }
                if compare.as_ref() != Some(&entry) {
                    self.record("thought", &entry_id, entry, false)?;
                }
                self.set_metadata(
                    &format!("shareRevision:{entry_id}"),
                    string(item, "revision")?,
                )?;
            }
            self.db
                .execute(
                    "DELETE FROM recovery WHERE id LIKE ?1",
                    [format!("shared:{scope_id}:%")],
                )
                .map_err(|e| e.to_string())?;
            for history in projection["recovery"]
                .as_array()
                .ok_or("Invalid shared Recovery")?
            {
                let Some(entry_id) = binding.entries.get(string(history, "itemId")?) else {
                    continue;
                };
                let mut payload = history["payload"].clone();
                payload["id"] = json!(entry_id);
                payload["starred"] = json!(false);
                payload["profileId"] = Value::Null;
                payload["tagIds"] = json!([binding.tag_id]);
                self.db
                    .execute(
                        "INSERT OR IGNORE INTO recovery VALUES (?1,'thought',?2,?3,?4)",
                        params![
                            string(history, "id")?,
                            entry_id,
                            payload.to_string(),
                            history["createdAt"]
                                .as_u64()
                                .ok_or("Invalid recovery time")? as i64
                        ],
                    )
                    .map_err(|e| e.to_string())?;
            }
        }
        self.set_metadata(
            "shareRegistry",
            &serde_json::to_string(&next).map_err(|e| e.to_string())?,
        )?;
        Ok(next)
    }
    fn detach_sharing(
        &mut self,
        scope: &str,
        person: &str,
        binding: &museamo_sync_core::sharing::Binding,
    ) -> Result<()> {
        self.db
            .execute(
                "DELETE FROM recovery WHERE id LIKE ?1",
                [format!("shared:{scope}:%")],
            )
            .map_err(|e| e.to_string())?;
        let Some(mut tag) = self.get("tag", &binding.tag_id)? else {
            return Ok(());
        };
        let private_tag = local_id(scope, person, &format!("{}:private", binding.tag_id));
        tag["id"] = json!(private_tag);
        self.record("tag", &private_tag, tag, false)?;
        for entry_id in binding.entries.values() {
            if let Some(mut entry) = self.get("thought", entry_id)? {
                let next = local_id(
                    scope,
                    person,
                    &format!("{entry_id}:private:{}", binding.tag_id),
                );
                let original = entry.clone();
                entry["id"] = json!(next);
                let mut tags = entry["tagIds"].as_array().cloned().unwrap_or_default();
                tags.retain(|t| t != &binding.tag_id);
                tags.push(json!(private_tag));
                entry["tagIds"] = json!(tags);
                self.record("thought", &next, entry, false)?;
                self.record("thought", entry_id, original, true)?;
            }
        }
        if let Some(tag) = self.get("tag", &binding.tag_id)? {
            self.record("tag", &binding.tag_id, tag, true)?;
        }
        Ok(())
    }
    pub fn scoped_media(&self, scope: &str) -> Result<std::collections::BTreeSet<String>> {
        let registry = self.sharing_registry()?;
        let scope = registry.scopes.get(scope).ok_or("Unknown shared scope")?;
        if !active(
            &serde_json::to_value(scope).map_err(|e| e.to_string())?,
            &self.metadata("group")?.unwrap_or_default(),
        ) {
            return Err("You no longer belong to this shared list".into());
        }
        Ok(scope
            .records
            .iter()
            .flat_map(|r| {
                r.payload["attachments"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
            })
            .filter_map(|m| m["id"].as_str().map(str::to_owned))
            .collect())
    }
}
