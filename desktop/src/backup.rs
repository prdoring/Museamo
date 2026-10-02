use crate::{
    replica::{validate_media, validate_thought},
    store::{self, string, uuid, Result, Store},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Read, Write},
    path::Path,
    sync::{Arc, Mutex},
};
const MAX_MANIFEST: usize = 25 * 1024 * 1024;

pub fn export(store: &Arc<Mutex<Store>>) -> Result<Value> {
    let Some(destination) = rfd::FileDialog::new()
        .set_file_name("museamo-backup.zip")
        .add_filter("Museamo backup", &["zip"])
        .save_file()
    else {
        return Ok(json!({"cancelled":true}));
    };
    export_to(store, &destination)?;
    Ok(json!({"cancelled":false}))
}
fn export_to(store: &Arc<Mutex<Store>>, destination: &Path) -> Result<()> {
    let (root, manifest, media) = {
        let mut db = store.lock().map_err(|_| "Storage unavailable")?;
        let mut entries = db.all("thought")?;
        for entry in &mut entries {
            entry["tagIds"] = json!(db.valid_tags(&entry["tagIds"])?);
        }
        let mut recovery = db.command("listRecovery", &json!({}))?["items"].clone();
        for item in recovery.as_array_mut().ok_or("Invalid Recovery snapshot")? {
            if item["kind"] == "thought" {
                let ids = item["payload"]["tagIds"]
                    .as_array()
                    .ok_or("Invalid Recovery category references")?;
                let canonical: Result<Vec<String>> = ids
                    .iter()
                    .map(|v| db.canonical_tag(v.as_str().ok_or("Invalid category identity")?))
                    .collect();
                item["payload"]["tagIds"] = json!(canonical?);
            }
        }
        let references: BTreeSet<String> = entries
            .iter()
            .chain(
                recovery
                    .as_array()
                    .ok_or("Invalid Recovery snapshot")?
                    .iter()
                    .map(|r| &r["payload"]),
            )
            .flat_map(|e| e["attachments"].as_array().into_iter().flatten())
            .map(|a| Ok(string(a, "id")?.to_owned()))
            .collect::<Result<_>>()?;
        let media: Result<Vec<_>> = references
            .iter()
            .map(|id| {
                db.get("media", id)?
                    .ok_or_else(|| "An original is pending. Download it before exporting.".into())
            })
            .collect();
        let media = media?;
        let mut manifest = json!({"format":"museamo","version":5,"exportedAt":store::now(),"entries":entries,"tags":db.all("tag")?,"profiles":[],"recovery":recovery,"media":media});
        db.private_sharing_snapshot(&mut manifest)?;
        (db.root.clone(), manifest, media)
    };
    let bytes = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_MANIFEST {
        return Err("Backup metadata exceeds 25 MiB.".into());
    }
    let temporary = destination.with_extension(format!("{}.tmp", store::id()));
    let result = (|| -> Result<()> {
        let output = std::fs::File::create(&temporary).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipWriter::new(output);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        archive
            .start_file("manifest.json", options)
            .map_err(|e| e.to_string())?;
        archive.write_all(&bytes).map_err(|e| e.to_string())?;
        for row in media {
            let id = uuid(string(&row, "id")?)?;
            let mut file = std::fs::File::open(root.join("media").join(id))
                .map_err(|_| "An original is missing. Download it before exporting.")?;
            if file.metadata().map_err(|e| e.to_string())?.len()
                != row["byteSize"].as_u64().ok_or("Invalid media size")?
            {
                return Err(
                    "An original is incomplete. Retry its download before exporting.".into(),
                );
            }
            archive
                .start_file(format!("media/{id}"), options)
                .map_err(|e| e.to_string())?;
            let mut digest = Sha256::new();
            let mut buffer = [0; 65536];
            loop {
                let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                digest.update(&buffer[..n]);
                archive.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
            }
            if hex::encode(digest.finalize()) != string(&row, "checksum")? {
                return Err("An original is damaged. Backup was not completed.".into());
            }
        }
        archive
            .finish()
            .map_err(|e| e.to_string())?
            .sync_all()
            .map_err(|e| e.to_string())?;
        publish_backup(&temporary, destination)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}
#[cfg(windows)]
fn publish_backup(source: &Path, destination: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}
#[cfg(not(windows))]
fn publish_backup(source: &Path, destination: &Path) -> Result<()> {
    std::fs::rename(source, destination).map_err(|e| e.to_string())
}

pub fn import(store: &Arc<Mutex<Store>>) -> Result<Value> {
    let Some(source) = rfd::FileDialog::new()
        .add_filter("Museamo backups", &["zip", "json"])
        .pick_file()
    else {
        return Ok(json!({"cancelled":true}));
    };
    import_from(store, &source)?;
    Ok(json!({"cancelled":false}))
}
fn read_manifest(input: impl Read) -> Result<Value> {
    let mut bytes = vec![];
    input
        .take(MAX_MANIFEST as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_MANIFEST {
        return Err("Backup metadata exceeds 25 MiB.".into());
    }
    museamo_sync_core::json::parse(&bytes)
}
fn import_from(store: &Arc<Mutex<Store>>, source: &Path) -> Result<()> {
    let file = std::fs::File::open(source).map_err(|e| e.to_string())?;
    let mut signature = [0u8; 2];
    let mut probe = std::fs::File::open(source).map_err(|e| e.to_string())?;
    let zip = probe.read(&mut signature).map_err(|e| e.to_string())? == 2 && signature == *b"PK";
    if !zip {
        let manifest = read_manifest(file)?;
        validate(&manifest)?;
        if !manifest["media"].as_array().is_none_or(|a| a.is_empty()) {
            return Err("Import the complete ZIP archive to restore originals.".into());
        }
        let mut db = store.lock().map_err(|_| "Storage unavailable")?;
        return import_content(&mut db, &manifest, &BTreeMap::new());
    }
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let manifest = read_manifest(
        archive
            .by_name("manifest.json")
            .map_err(|_| "Backup manifest is missing")?,
    )?;
    validate(&manifest)?;
    let media = manifest["media"]
        .as_array()
        .ok_or("Backup originals list is missing")?;
    let expected: BTreeSet<String> = std::iter::once("manifest.json".to_owned())
        .chain(
            media
                .iter()
                .map(|m| format!("media/{}", m["id"].as_str().unwrap())),
        )
        .collect();
    let mut seen = BTreeSet::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|e| e.to_string())?;
        if entry.is_dir()
            || !expected.contains(entry.name())
            || !seen.insert(entry.name().to_owned())
        {
            return Err("Unexpected, duplicate, or unsafe archive path.".into());
        }
    }
    if seen != expected {
        return Err("Backup is missing an original.".into());
    }
    let root = store
        .lock()
        .map_err(|_| "Storage unavailable")?
        .root
        .clone();
    let staging = root.join("staging").join(format!("backup-{}", store::id()));
    std::fs::create_dir(&staging).map_err(|e| e.to_string())?;
    let mut installed = vec![];
    let result = (|| -> Result<()> {
        for row in media {
            let id = string(row, "id")?;
            let size = row["byteSize"].as_u64().ok_or("Invalid original size")?;
            let entry = archive
                .by_name(&format!("media/{id}"))
                .map_err(|_| "Backup is missing an original")?;
            if entry.size() != size {
                return Err("Backup original has incorrect length".into());
            }
            let mut input = entry.take(size + 1);
            let mut output = std::fs::File::create(staging.join(id)).map_err(|e| e.to_string())?;
            let mut digest = Sha256::new();
            let mut total = 0u64;
            let mut buffer = [0u8; 65536];
            loop {
                let n = input.read(&mut buffer).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                total += n as u64;
                if total > size {
                    return Err("Backup original exceeds its declared length".into());
                }
                digest.update(&buffer[..n]);
                output.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
            }
            if total != size || hex::encode(digest.finalize()) != string(row, "checksum")? {
                return Err("Backup original checksum failed".into());
            }
            output.sync_all().map_err(|e| e.to_string())?;
        }
        let mut db = store.lock().map_err(|_| "Storage unavailable")?;
        db.db
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        let mutation = (|| -> Result<()> {
            let mut mapping = BTreeMap::new();
            for original in media {
                let old = string(original, "id")?;
                let existing = db.get("media", old)?;
                let matching = existing.as_ref().is_some_and(|m| {
                    m["checksum"] == original["checksum"] && m["byteSize"] == original["byteSize"]
                });
                let next = if matching {
                    old.to_owned()
                } else if existing.is_some() || root.join("media").join(old).exists() {
                    store::id()
                } else {
                    old.to_owned()
                };
                let target = root.join("media").join(&next);
                if !matching || !target.exists() {
                    std::fs::rename(staging.join(old), &target).map_err(|e| e.to_string())?;
                    installed.push(next.clone());
                }
                let mut row = original.clone();
                row["id"] = json!(next);
                row["availability"] = json!("available");
                db.put_local("media", &next, &row)?;
                mapping.insert(old.to_owned(), row);
            }
            import_records(&mut db, &manifest, &mapping)
        })();
        match mutation {
            Ok(()) => {
                db.db.execute_batch("COMMIT").map_err(|e| e.to_string())?;
                installed.clear();
                Ok(())
            }
            Err(e) => {
                let _ = db.db.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })();
    for id in installed {
        let _ = std::fs::remove_file(root.join("media").join(id));
    }
    let _ = std::fs::remove_dir_all(staging);
    result
}
fn import_content(db: &mut Store, manifest: &Value, media: &BTreeMap<String, Value>) -> Result<()> {
    db.db
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| e.to_string())?;
    match import_records(db, manifest, media) {
        Ok(()) => {
            db.db.execute_batch("COMMIT").map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(e) => {
            let _ = db.db.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}
fn materialize(
    original: &Value,
    tags: &BTreeMap<String, String>,
    media: &BTreeMap<String, Value>,
) -> Result<Value> {
    let mut entry = original.clone();
    entry
        .as_object_mut()
        .ok_or("Invalid thought")?
        .remove("revision");
    entry["tagIds"] = json!(entry["tagIds"]
        .as_array()
        .ok_or("Invalid thought tags")?
        .iter()
        .map(|v| {
            let old = v.as_str().ok_or("Invalid thought tag")?;
            Ok(tags.get(old).cloned().unwrap_or_else(|| old.to_owned()))
        })
        .collect::<Result<Vec<_>>>()?);
    let ids: Vec<&str> = if let Some(ids) = entry["attachmentIds"].as_array() {
        ids.iter()
            .map(|v| v.as_str().ok_or("Invalid original reference"))
            .collect::<std::result::Result<_, _>>()?
    } else {
        entry["attachments"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|v| string(v, "id"))
            .collect::<Result<_>>()?
    };
    let attachments = ids
        .into_iter()
        .map(|id| {
            media
                .get(id)
                .cloned()
                .ok_or_else(|| "Backup references a missing original".into())
        })
        .collect::<Result<Vec<_>>>()?;
    entry["attachments"] = json!(attachments);
    entry.as_object_mut().unwrap().remove("attachmentIds");
    entry["starred"] = json!(entry["starred"].as_bool().unwrap_or(false));
    entry["completed"] = json!(entry["completed"].as_bool().unwrap_or(false));
    entry["profileId"] = Value::Null;
    if entry.get("location").is_none() {
        entry["location"] = Value::Null;
    }
    Ok(entry)
}
fn content_hash(mut value: Value) -> Result<String> {
    value.as_object_mut().ok_or("Invalid thought")?.remove("id");
    value.as_object_mut().unwrap().remove("revision");
    Ok(museamo_sync_core::wire::hash(
        &museamo_sync_core::wire::canonical(&value)?,
    ))
}
fn import_records(db: &mut Store, manifest: &Value, media: &BTreeMap<String, Value>) -> Result<()> {
    let mut tags = BTreeMap::new();
    for tag in manifest["tags"]
        .as_array()
        .ok_or("Missing backup categories")?
    {
        let old = string(tag, "id")?;
        let name = string(tag, "name")?;
        let kind = tag["type"].as_str().unwrap_or("standard");
        let existing = db.all("tag")?.into_iter().find(|t| {
            museamo_sync_core::normalize_tag(t["name"].as_str().unwrap_or_default())
                == museamo_sync_core::normalize_tag(name)
                && t["type"].as_str().unwrap_or("standard") == kind
                && db.sharing_metadata(t["id"].as_str().unwrap_or("")).ok().flatten().is_none()
        });
        let next = if let Some(t) = existing {
            string(&t, "id")?.to_owned()
        } else {
            let next = if db.get("tag", old)?.is_some() || db.is_retired("tag", old)? {
                store::id()
            } else {
                old.to_owned()
            };
            db.record(
                "tag",
                &next,
                json!({"id":next,"name":name,"type":kind}),
                false,
            )?;
            next
        };
        tags.insert(old.to_owned(), next);
    }
    let mut existing_hashes: BTreeSet<String> = db
        .all("thought")?
        .into_iter()
        .map(content_hash)
        .collect::<Result<_>>()?;
    for original in manifest["entries"]
        .as_array()
        .ok_or("Missing backup thoughts")?
    {
        let mut entry = materialize(original, &tags, media)?;
        let old = string(&entry, "id")?.to_owned();
        let fingerprint = content_hash(entry.clone())?;
        if existing_hashes.contains(&fingerprint) {
            continue;
        }
        let history: bool = db
            .db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sync_ops WHERE kind='thought' AND entity_id=?1)",
                [&old],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if history || db.get("thought", &old)?.is_some() || db.is_retired("thought", &old)? {
            entry["id"] = json!(store::id());
        }
        let next = string(&entry, "id")?.to_owned();
        validate_thought(&entry, &next)?;
        db.record("thought", &next, entry, false)?;
        existing_hashes.insert(fingerprint);
    }
    for item in manifest["recovery"].as_array().into_iter().flatten() {
        let kind = string(item, "kind")?;
        let mut original = if kind == "thought" {
            materialize(&item["payload"], &tags, media)?
        } else {
            item["payload"].clone()
        };
        let content = museamo_sync_core::wire::hash(&museamo_sync_core::wire::canonical(
            &json!({"kind":kind,"payload":original}),
        )?);
        let key = format!("importRecovery:{content}");
        if db.metadata(&key)?.is_some() {
            continue;
        }
        if kind == "thought" && db.is_retired("thought", string(&original, "id")?)? {
            original["id"] = json!(store::id());
        }
        let entity = string(&original, "id")?.to_owned();
        db.record(
            if kind == "thought" {
                "archiveThought"
            } else {
                "archiveTag"
            },
            &entity,
            json!({"kind":kind,"entityId":entity,"payload":original,"createdAt":item["createdAt"]}),
            false,
        )?;
        db.set_metadata(&key, "1")?;
    }
    Ok(())
}
fn validate(manifest: &Value) -> Result<()> {
    if manifest["format"] != "museamo"
        || !manifest["version"]
            .as_u64()
            .is_some_and(|v| (1..=5).contains(&v))
    {
        return Err("Unsupported Museamo backup".into());
    }
    let mut tags = BTreeSet::new();
    for t in manifest["tags"]
        .as_array()
        .ok_or("Missing backup categories")?
    {
        let id = uuid(string(t, "id")?)?;
        if !tags.insert(id) {
            return Err("Duplicate category identity".into());
        }
        let name = string(t, "name")?;
        if name.trim() != name
            || name.is_empty()
            || name.encode_utf16().count() > 80
            || !["standard", "checklist"].contains(&t["type"].as_str().unwrap_or("standard"))
        {
            return Err("Invalid backup category".into());
        }
    }
    let mut media = BTreeMap::new();
    for m in manifest["media"].as_array().into_iter().flatten() {
        validate_media(m)?;
        if media
            .insert(string(m, "id")?.to_owned(), m.clone())
            .is_some()
        {
            return Err("Duplicate original identity".into());
        }
    }
    let mut entries = BTreeSet::new();
    let identity_tags: BTreeMap<String, String> = tags
        .iter()
        .map(|v| ((*v).to_owned(), (*v).to_owned()))
        .collect();
    let mut references = BTreeSet::new();
    for e in manifest["entries"]
        .as_array()
        .ok_or("Missing backup thoughts")?
    {
        let id = uuid(string(e, "id")?)?;
        if !entries.insert(id) {
            return Err("Duplicate thought identity".into());
        }
        for t in e["tagIds"].as_array().ok_or("Invalid thought categories")? {
            if !tags.contains(t.as_str().ok_or("Invalid category reference")?) {
                return Err("Backup references a missing category".into());
            }
        }
        let normalized = materialize(e, &identity_tags, &media)?;
        validate_thought(&normalized, id)?;
        for a in normalized["attachments"].as_array().unwrap() {
            references.insert(string(a, "id")?.to_owned());
        }
    }
    let mut recovery = BTreeSet::new();
    if manifest["version"] == 5 {
        for item in manifest["recovery"]
            .as_array()
            .ok_or("Missing backup Recovery")?
        {
            let id = string(item, "id")?;
            if id.len() > 256 || id.is_empty() || !recovery.insert(id) {
                return Err("Invalid or duplicate Recovery identity".into());
            }
            let kind = string(item, "kind")?;
            let entity = uuid(string(item, "entityId")?)?;
            if item["payload"]["id"] != entity {
                return Err("Recovery identity does not match its payload".into());
            }
            item["createdAt"]
                .as_u64()
                .filter(|v| *v <= 8_640_000_000_000_000)
                .ok_or("Invalid Recovery timestamp")?;
            if kind == "thought" {
                let normalized = materialize(&item["payload"], &identity_tags, &media)?;
                validate_thought(&normalized, entity)?;
                for a in normalized["attachments"].as_array().unwrap() {
                    references.insert(string(a, "id")?.to_owned());
                }
            } else if kind == "tag" {
                let name = string(&item["payload"], "name")?;
                if name.is_empty()
                    || name.encode_utf16().count() > 80
                    || !["standard", "checklist"].contains(&string(&item["payload"], "type")?)
                {
                    return Err("Invalid Recovery category".into());
                }
            } else {
                return Err("Unknown Recovery kind".into());
            }
        }
    }
    if references != media.keys().cloned().collect() {
        return Err("Backup has missing or unreferenced originals".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Arc<Mutex<Store>> {
        Arc::new(Mutex::new(
            Store::open(&std::env::temp_dir().join(format!("museamo-backup-test-{}", store::id())))
                .unwrap(),
        ))
    }
    #[test]
    fn portable_restore_has_fresh_identity_and_preserves_recovery() {
        let source = fixture();
        let original = store::id();
        {
            let mut db = source.lock().unwrap();
            db.record("thought",&original,json!({"id":original,"text":"one","tagIds":[],"attachments":[],"createdAt":1,"updatedAt":1,"location":null,"starred":false,"completed":false}),false).unwrap();
            let mut e = db.get("thought", &original).unwrap().unwrap();
            e["text"] = json!("two");
            db.record("thought", &original, e, false).unwrap();
        }
        let path = std::env::temp_dir().join(format!("{}.zip", store::id()));
        export_to(&source, &path).unwrap();
        let target = fixture();
        import_from(&target, &path).unwrap();
        let mut db = target.lock().unwrap();
        assert_ne!(db.device, source.lock().unwrap().device);
        assert_eq!(db.all("thought").unwrap().len(), 1);
        assert_eq!(
            db.command("listRecovery", &json!({})).unwrap()["items"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        drop(db);
        import_from(&target, &path).unwrap();
        assert_eq!(target.lock().unwrap().all("thought").unwrap().len(), 1);
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn duplicate_json_keys_are_rejected() {
        assert!(
            read_manifest(br#"{"format":"museamo","version":1,"version":5}"#.as_slice()).is_err()
        );
    }
    #[test]
    fn alias_recovery_restore_and_portable_roundtrip_keep_categories_and_original_entity_ids() {
        let source = fixture();
        let mut ids = vec![store::id(), store::id()];
        ids.sort();
        let note = store::id();
        {
            let mut db = source.lock().unwrap();
            for id in ids.iter().rev() {
                db.record(
                    "tag",
                    id,
                    json!({"id":id,"name":"Equivalent checklist","type":"checklist"}),
                    false,
                )
                .unwrap();
            }
            let value = json!({"id":note,"text":"Historical tagged writing","tagIds":[ids[1]],"attachments":[],"createdAt":1,"updatedAt":1,"location":null,"starred":false,"completed":false});
            db.record("thought", &note, value.clone(), false).unwrap();
            let mut current = value;
            current["text"] = json!("Current tagged writing");
            db.record("thought", &note, current, false).unwrap();
            let alias = store::id();
            db.record(
                "tagAlias",
                &alias,
                json!({"ids":ids,"normalizedName":"equivalent checklist","type":"checklist"}),
                false,
            )
            .unwrap();
            let recovery = db.command("listRecovery", &json!({})).unwrap();
            for item in recovery["items"].as_array().unwrap() {
                assert_eq!(item["entityId"], item["payload"]["id"]);
            }
            let historic = recovery["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["kind"] == "thought")
                .unwrap();
            let restored = db
                .command("restoreRecovery", &json!({"id":historic["id"]}))
                .unwrap();
            assert_eq!(
                db.get("thought", restored["entryId"].as_str().unwrap())
                    .unwrap()
                    .unwrap()["tagIds"],
                json!([ids[0]])
            );
        }
        let path = std::env::temp_dir().join(format!("{}.zip", store::id()));
        export_to(&source, &path).unwrap();
        let target = fixture();
        import_from(&target, &path).unwrap();
        let mut db = target.lock().unwrap();
        assert_eq!(db.all("tag").unwrap().len(), 1);
        let recovered = db.command("listRecovery", &json!({})).unwrap();
        assert!(recovered["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["kind"] == "tag" && r["entityId"] == ids[1]));
        let row = recovered["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["kind"] == "thought")
            .unwrap();
        let restored = db
            .command("restoreRecovery", &json!({"id":row["id"]}))
            .unwrap();
        assert_eq!(
            db.get("thought", restored["entryId"].as_str().unwrap())
                .unwrap()
                .unwrap()["tagIds"],
            json!([ids[0]])
        );
        let _ = std::fs::remove_file(path);
    }
}
