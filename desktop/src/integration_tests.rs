use crate::{
    replica::NativePlatform,
    store::{self, Store},
};
use museamo_sync_core::{
    wire::{self, Envelope},
    Coordinator, Platform,
};
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

struct Device {
    db: Arc<Mutex<Store>>,
    platform: Arc<NativePlatform>,
    sync: Arc<Coordinator>,
}
impl Device {
    fn new() -> Self {
        let db = Arc::new(Mutex::new(
            Store::open(&std::env::temp_dir().join(format!("museamo-sync-test-{}", store::id())))
                .unwrap(),
        ));
        Self::from_db(db)
    }
    fn from_db(db: Arc<Mutex<Store>>) -> Self {
        let platform = Arc::new(NativePlatform::new(db.clone(), None));
        let sync = Coordinator::new(platform.clone()).unwrap();
        sync.start("127.0.0.1:0").unwrap();
        Self { db, platform, sync }
    }
    fn state(&self) -> Value {
        self.sync.command("getSyncState", json!({})).unwrap()
    }
    fn append(&self, text: &str) -> String {
        let id = store::id();
        self.db
            .lock()
            .unwrap()
            .record("thought", &id, thought(&id, text), false)
            .unwrap();
        id
    }
    fn get(&self, id: &str) -> Option<Value> {
        self.db.lock().unwrap().get("thought", id).unwrap()
    }
    fn trigger(&self) {
        self.sync.command("syncNow", json!({})).unwrap();
    }
}
impl Drop for Device {
    fn drop(&mut self) {
        self.sync.stop();
    }
}
fn thought(id: &str, text: &str) -> Value {
    json!({"id":id,"text":text,"tagIds":[],"attachments":[],"createdAt":store::now(),"updatedAt":store::now(),"location":null,"starred":false,"completed":false,"profileId":null})
}
#[track_caller]
fn until(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !condition() {
        assert!(
            Instant::now() < deadline,
            "Timed out waiting for real SQLite sync"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}
fn quiescent(devices: &[&Device]) {
    until(|| devices.iter().all(|d| d.state()["phase"] != "syncing"));
}
fn pair(a: &Device, b: &Device) {
    a.sync
        .command("linkDevice", json!({"address":b.state()["address"]}))
        .unwrap();
    until(|| a.state()["pairing"].is_object() && b.state()["pairing"].is_object());
    let first = a.state();
    let second = b.state();
    assert_eq!(first["pairing"]["code"], second["pairing"]["code"]);
    assert!(first["pairing"]["summary"].is_null());
    let aid = first["pairing"]["sessionId"].clone();
    let bid = second["pairing"]["sessionId"].clone();
    a.sync
        .command("confirmPairing", json!({"sessionId":aid,"confirmed":true}))
        .unwrap();
    b.sync
        .command("confirmPairing", json!({"sessionId":bid,"confirmed":true}))
        .unwrap();
    until(|| {
        a.state()["pairing"]["summary"].is_object() && b.state()["pairing"]["summary"].is_object()
    });
    a.sync
        .command("acceptEnrollment", json!({"sessionId":aid,"accepted":true}))
        .unwrap();
    b.sync
        .command("acceptEnrollment", json!({"sessionId":bid,"accepted":true}))
        .unwrap();
    until(|| !a.state()["pairing"].is_object() && !b.state()["pairing"].is_object());
}

#[test]
fn real_sqlite_noise_three_devices_saved_edits_originals_recovery_and_restart() {
    let a = Device::new();
    let b = Device::new();
    let c = Device::new();
    let first = a.append("PC writing before linking");
    let second = b.append("Phone writing before linking");
    let third = c.append("Another PC before linking");
    pair(&a, &b);
    until(|| a.get(&second).is_some() && b.get(&first).is_some());
    let media = store::id();
    let original = vec![42u8; 96_000];
    let metadata = json!({"id":media,"kind":"image","mimeType":"image/heic","filename":"original.heic","byteSize":original.len(),"width":1,"height":1,"duration":null,"checksum":wire::hash(&original)});
    {
        let mut db = a.db.lock().unwrap();
        std::fs::write(db.root.join("media").join(&media), &original).unwrap();
        db.put_local("media", &media, &metadata).unwrap();
        let mut e = db.get("thought", &first).unwrap().unwrap();
        e["attachments"] = json!([metadata]);
        e["text"] = json!("Text with intact original even without a decoder");
        db.record("thought", &first, e, false).unwrap();
    }
    a.trigger();
    until(|| {
        b.get(&first)
            .is_some_and(|v| v["attachments"].as_array().unwrap().len() == 1)
            && b.db
                .lock()
                .unwrap()
                .root
                .join("media")
                .join(&media)
                .is_file()
    });
    assert_eq!(
        std::fs::read(b.db.lock().unwrap().root.join("media").join(&media)).unwrap(),
        original
    );
    pair(&c, &b);
    until(|| c.get(&first).is_some() && c.get(&second).is_some() && b.get(&third).is_some());
    a.trigger();
    until(|| a.get(&third).is_some());
    let tag = store::id();
    b.db.lock()
        .unwrap()
        .command(
            "saveTag",
            &json!({"id":tag,"name":"Offline checklist","type":"checklist"}),
        )
        .unwrap();
    let mut e = b.get(&first).unwrap();
    e["tagIds"] = json!([tag]);
    b.db.lock()
        .unwrap()
        .record("thought", &first, e, false)
        .unwrap();
    b.db.lock()
        .unwrap()
        .command("setStar", &json!({"id":first,"starred":true}))
        .unwrap();
    b.db.lock()
        .unwrap()
        .command("setCompleted", &json!({"id":first,"completed":true}))
        .unwrap();
    b.trigger();
    until(|| {
        a.get(&first)
            .is_some_and(|e| e["starred"] == true && e["completed"] == true)
            && c.get(&first).is_some_and(|e| e["starred"] == true)
    });
    quiescent(&[&a, &b, &c]);
    // Concurrent local editing and deletion share the same prior applied frontier.
    let mut edit = a.get(&second).unwrap();
    edit["text"] = json!("Concurrent edit");
    a.db.lock()
        .unwrap()
        .record("thought", &second, edit, false)
        .unwrap();
    b.db.lock()
        .unwrap()
        .command("deleteEntry", &json!({"id":second}))
        .unwrap();
    a.trigger();
    until(|| a.get(&second).is_none() && b.get(&second).is_none());
    b.trigger();
    until(|| c.get(&second).is_none());
    assert!(!a
        .db
        .lock()
        .unwrap()
        .command("listRecovery", &json!({}))
        .unwrap()["items"]
        .as_array()
        .unwrap()
        .is_empty());
    a.db.lock()
        .unwrap()
        .command("clearAllRecovery", &json!({}))
        .unwrap();
    a.trigger();
    until(|| {
        b.db.lock()
            .unwrap()
            .command("listRecovery", &json!({}))
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty()
    });
    b.trigger();
    until(|| {
        c.db.lock()
            .unwrap()
            .command("listRecovery", &json!({}))
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty()
    });
    a.sync.stop();
    let root = a.db.lock().unwrap().root.clone();
    let device_id = a.db.lock().unwrap().device.clone();
    let resumed = Device::from_db(Arc::new(Mutex::new(Store::open(&root).unwrap())));
    assert_eq!(resumed.db.lock().unwrap().device, device_id);
    assert!(resumed.state()["devices"].as_array().unwrap().len() >= 2);
    let after = resumed.append("Saved after native restart");
    // Match native saves: startup sync may have exported before this commit.
    resumed.sync.local_data_changed().unwrap();
    resumed
        .sync
        .command("linkDevice", json!({"address":b.state()["address"]}))
        .unwrap();
    until(|| b.get(&after).is_some());
    assert!(resumed.state()["pairing"].is_null());
}

fn identities(devices: &[&Device]) -> Vec<Value> {
    devices
        .iter()
        .map(|d| {
            let mut i = d.platform.call("syncIdentity", json!({})).unwrap();
            i.as_object_mut().unwrap().remove("noisePrivate");
            i
        })
        .collect()
}
fn input(group: &str, members: &[Value], envelopes: Vec<Envelope>, proofs: Vec<Envelope>) -> Value {
    json!({"groupId":group,"members":members,"envelopes":envelopes,"purgeProofs":proofs,"authorizedHistory":{},"authorizedAnchors":{}})
}
#[test]
fn durable_receipt_gap_and_original_resume_survive_restart() {
    let a = Device::new();
    let b = Device::new();
    let group = store::id();
    a.db.lock().unwrap().enroll(&group).unwrap();
    b.db.lock().unwrap().enroll(&group).unwrap();
    let entity = a.append("first");
    let mut changed = a.get(&entity).unwrap();
    changed["text"] = json!("second");
    a.db.lock()
        .unwrap()
        .record("thought", &entity, changed, false)
        .unwrap();
    let origin = a.db.lock().unwrap().device.clone();
    let one = a.db.lock().unwrap().operation(&origin, 1).unwrap().unwrap();
    let two = a.db.lock().unwrap().operation(&origin, 2).unwrap().unwrap();
    let members = identities(&[&a, &b]);
    b.platform
        .call("syncApply", input(&group, &members, vec![two], vec![]))
        .unwrap();
    assert_eq!(b.db.lock().unwrap().receipts().unwrap().get(&origin), None);
    assert!(b.get(&entity).is_none());
    b.platform
        .call("syncApply", input(&group, &members, vec![one], vec![]))
        .unwrap();
    assert_eq!(b.db.lock().unwrap().receipts().unwrap()[&origin], 2);
    assert_eq!(b.get(&entity).unwrap()["text"], "second");
    let media = store::id();
    let bytes = vec![9u8; 20000];
    let metadata = json!({"id":media,"kind":"image","mimeType":"image/png","filename":"original.png","byteSize":bytes.len(),"checksum":wire::hash(&bytes),"width":1,"height":1});
    {
        let mut db = b.db.lock().unwrap();
        let mut e = db.get("thought", &entity).unwrap().unwrap();
        e["attachments"] = json!([metadata]);
        db.record("thought", &entity, e, false).unwrap();
    }
    let part = json!({"id":media,"checksum":metadata["checksum"],"size":bytes.len(),"offset":0,"bytes":hex::encode(&bytes[..16384]),"metadata":metadata});
    b.platform.call("syncWriteMedia", part).unwrap();
    let root = b.db.lock().unwrap().root.clone();
    let reopened = Arc::new(Mutex::new(Store::open(&root).unwrap()));
    let platform = NativePlatform::new(reopened.clone(), None);
    assert_eq!(
        platform.call("syncMissingMedia", json!({})).unwrap()["items"][0]["offset"],
        16384
    );
    platform.call("syncWriteMedia",json!({"id":media,"checksum":metadata["checksum"],"size":bytes.len(),"offset":16384,"bytes":hex::encode(&bytes[16384..]),"metadata":metadata})).unwrap();
    assert_eq!(
        std::fs::read(root.join("media").join(media)).unwrap(),
        bytes
    );
}

#[test]
fn revoked_alternate_purge_cannot_erase_before_anchor_verification() {
    let a = Device::new();
    let b = Device::new();
    let group = store::id();
    a.db.lock().unwrap().enroll(&group).unwrap();
    b.db.lock().unwrap().enroll(&group).unwrap();
    let victim = b.append("Must survive a forged purge proof");
    let old = a.append("accepted history");
    let members = identities(&[&a, &b]);
    let origin = a.db.lock().unwrap().device.clone();
    let one = a.db.lock().unwrap().operation(&origin, 1).unwrap().unwrap();
    b.platform
        .call("syncApply", input(&group, &members, vec![one], vec![]))
        .unwrap();
    let mut e = a.get(&old).unwrap();
    e["text"] = json!("witnessed legitimate second header");
    a.db.lock()
        .unwrap()
        .record("thought", &old, e, false)
        .unwrap();
    let authentic = a.db.lock().unwrap().operation(&origin, 2).unwrap().unwrap();
    let anchor = wire::hash(&wire::canonical(&authentic.header).unwrap());
    let victim_revision = b.get(&victim).unwrap()["revision"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut malicious = authentic.clone();
    malicious.header.kind = "purge".into();
    malicious.header.revision.entity_id = store::id();
    malicious.payload = Some(json!({"revisionIds":[victim_revision],"entityIds":[victim]}));
    malicious.header.revision.payload_hash =
        wire::hash(&wire::canonical(malicious.payload.as_ref().unwrap()).unwrap());
    malicious.signature =
        a.db.lock()
            .unwrap()
            .identity
            .as_ref()
            .unwrap()
            .sign(&wire::signing_bytes(&malicious.header).unwrap());
    let mut request = input(&group, &members, vec![malicious.clone()], vec![malicious]);
    request["authorizedHistory"] = json!({origin.clone():2});
    request["authorizedAnchors"] = json!({origin.clone():{"through":2,"headerHash":anchor}});
    assert!(b.platform.call("syncApply", request).is_err());
    assert_eq!(
        b.get(&victim).unwrap()["text"],
        "Must survive a forged purge proof"
    );
    assert!(!b.db.lock().unwrap().is_retired("thought", &victim).unwrap());
    assert_eq!(b.db.lock().unwrap().receipts().unwrap()[&origin], 1);
}

#[test]
fn provisional_null_body_is_not_applied_and_an_honest_body_can_hydrate_it() {
    let a = Device::new();
    let b = Device::new();
    let c = Device::new();
    let group = store::id();
    for d in [&a, &b, &c] {
        d.db.lock().unwrap().enroll(&group).unwrap();
    }
    a.append("purge author predecessor");
    let victim = b.append("Full honest body must still arrive");
    let origin_b = b.db.lock().unwrap().device.clone();
    let full =
        b.db.lock()
            .unwrap()
            .operation(&origin_b, 1)
            .unwrap()
            .unwrap();
    let origin_a = a.db.lock().unwrap().device.clone();
    let mut malicious =
        a.db.lock()
            .unwrap()
            .operation(&origin_a, 1)
            .unwrap()
            .unwrap();
    malicious.header.kind = "purge".into();
    malicious.header.revision.dot.sequence = 2;
    malicious
        .header
        .revision
        .context
        .insert(origin_a.clone(), 1);
    malicious.header.previous_hash = "invalid-signed-chain".into();
    malicious.header.revision.entity_id = store::id();
    malicious.payload = Some(json!({"revisionIds":[full.header.revision.id()],"entityIds":[]}));
    malicious.header.revision.payload_hash =
        wire::hash(&wire::canonical(malicious.payload.as_ref().unwrap()).unwrap());
    malicious.signature =
        a.db.lock()
            .unwrap()
            .identity
            .as_ref()
            .unwrap()
            .sign(&wire::signing_bytes(&malicious.header).unwrap());
    let members = identities(&[&a, &b, &c]);
    let mut stripped = full.clone();
    stripped.payload = None;
    c.platform
        .call(
            "syncApply",
            input(&group, &members, vec![stripped], vec![malicious.clone()]),
        )
        .unwrap();
    assert!(c.get(&victim).is_none());
    assert_eq!(
        c.db.lock().unwrap().staged_receipts().unwrap()[&origin_b],
        1
    );
    assert_eq!(
        c.db.lock().unwrap().receipts().unwrap().get(&origin_b),
        None
    );
    c.platform
        .call("syncApply", input(&group, &members, vec![full], vec![]))
        .unwrap();
    assert_eq!(
        c.get(&victim).unwrap()["text"],
        "Full honest body must still arrive"
    );
    assert_eq!(c.db.lock().unwrap().receipts().unwrap()[&origin_b], 1);
    assert!(!c.db.lock().unwrap().is_retired("thought", &victim).unwrap());
}

#[test]
fn cleared_history_bootstraps_in_bounded_pages_without_false_applied_receipts() {
    let a = Device::new();
    let b = Device::new();
    let group = store::id();
    for d in [&a, &b] {
        d.db.lock().unwrap().enroll(&group).unwrap();
    }
    let entry = a.append("historic content to erase");
    let mut current = a.get(&entry).unwrap();
    current["text"] = json!("Current saved writing");
    a.db.lock()
        .unwrap()
        .record("thought", &entry, current, false)
        .unwrap();
    a.db.lock()
        .unwrap()
        .command("clearAllRecovery", &json!({}))
        .unwrap();
    let origin = a.db.lock().unwrap().device.clone();
    let members = identities(&[&a, &b]);
    for sequence in 1..=3 {
        let e =
            a.db.lock()
                .unwrap()
                .operation(&origin, sequence)
                .unwrap()
                .unwrap();
        let proof = a.db.lock().unwrap().operation(&origin, 3).unwrap().unwrap();
        b.platform
            .call("syncApply", input(&group, &members, vec![e], vec![proof]))
            .unwrap();
        assert_eq!(
            b.db.lock().unwrap().staged_receipts().unwrap()[&origin],
            sequence
        );
        if sequence < 3 {
            assert_eq!(b.db.lock().unwrap().receipts().unwrap().get(&origin), None);
            assert!(b.get(&entry).is_none());
        }
    }
    assert_eq!(b.db.lock().unwrap().receipts().unwrap()[&origin], 3);
    assert_eq!(b.get(&entry).unwrap()["text"], "Current saved writing");
    assert!(b
        .db
        .lock()
        .unwrap()
        .command("listRecovery", &json!({}))
        .unwrap()["items"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(b
        .db
        .lock()
        .unwrap()
        .operation(&origin, 1)
        .unwrap()
        .unwrap()
        .payload
        .is_none());
}

#[test]
fn windows_signed_golden_archive_is_portable() {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("test-fixtures/android-archive.json");
    if std::env::var_os("MUSEAMO_WRITE_GOLDEN").is_some() {
        let source = Device::new();
        let mut db = source.db.lock().unwrap();
        db.device = "11111111-1111-4111-8111-111111111111".into();
        db.set_metadata("device", &db.device).unwrap();
        db.identity = Some(Arc::new(crate::identity::Identity {
            signing: p256::ecdsa::SigningKey::from_slice(&[7u8; 32]).unwrap(),
            noise_private: hex::encode([3u8; 32]),
            noise_public: hex::encode([4u8; 32]),
        }));
        let group = "22222222-2222-4222-8222-222222222222";
        db.enroll(group).unwrap();
        let tag = "33333333-3333-4333-8333-333333333333";
        db.record(
            "tag",
            tag,
            json!({"id":tag,"name":"Golden checklist","type":"checklist"}),
            false,
        )
        .unwrap();
        let original = b"synthetic-original";
        let media = "44444444-4444-4444-8444-444444444444";
        let metadata = json!({"id":media,"kind":"image","mimeType":"image/heic","filename":"original.heic","byteSize":original.len(),"width":1,"height":1,"duration":null,"checksum":wire::hash(original)});
        let live = "55555555-5555-4555-8555-555555555555";
        let mut live_payload = thought(live, "Portable Windows writing");
        live_payload["tagIds"] = json!([tag]);
        live_payload["attachments"] = json!([metadata]);
        db.record("thought", live, live_payload, false).unwrap();
        let historical = "66666666-6666-4666-8666-666666666666";
        let mut payload = thought(historical, "Portable historical writing");
        payload["tagIds"] = json!([tag]);
        payload["attachments"] = json!([metadata]);
        db.record(
            "archiveThought",
            historical,
            json!({"kind":"thought","entityId":historical,"payload":payload,"createdAt":1000}),
            false,
        )
        .unwrap();
        let mut identity = db.identity.as_ref().unwrap().value(&db).unwrap();
        identity.as_object_mut().unwrap().remove("noisePrivate");
        identity.as_object_mut().unwrap().remove("groupId");
        identity["name"] = json!("Synthetic Windows fixture");
        let exported = db
            .export_changes(&json!({"groupId":group,"after":{}}))
            .unwrap();
        let fixture = json!({"groupId":group,"identity":identity,"envelopes":exported["envelopes"],"purgeProofs":exported["purgeProofs"],"originals":[{"id":media,"bytes":hex::encode(original)}]});
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, serde_json::to_vec_pretty(&fixture).unwrap()).unwrap();
    }
    let fixture: museamo_sync_core::wire::Envelope = {
        let value: museamo_sync_core::wire::Envelope = serde_json::from_value(
            serde_json::from_slice::<Value>(&std::fs::read(&path).unwrap()).unwrap()["envelopes"]
                [0]
            .clone(),
        )
        .unwrap();
        value
    };
    assert_eq!(fixture.header.kind, "tag");
    let fixture: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let target = Device::new();
    target
        .db
        .lock()
        .unwrap()
        .enroll(fixture["groupId"].as_str().unwrap())
        .unwrap();
    let request = json!({"groupId":fixture["groupId"],"members":[fixture["identity"]],"envelopes":fixture["envelopes"],"purgeProofs":fixture["purgeProofs"],"authorizedHistory":{},"authorizedAnchors":{}});
    target.platform.call("syncApply", request).unwrap();
    assert_eq!(
        crate::media::resolve(
            &target.db,
            &json!({"id":fixture["originals"][0]["id"]}),
            "http://127.0.0.1/test"
        )
        .unwrap()["availability"],
        "pending"
    );
    assert_eq!(target.db.lock().unwrap().all("thought").unwrap().len(), 1);
    let recovery = target
        .db
        .lock()
        .unwrap()
        .command("listRecovery", &json!({}))
        .unwrap();
    assert_eq!(recovery["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        recovery["items"][0]["payload"]["text"],
        "Portable historical writing"
    );
    assert_eq!(
        target.platform.call("syncMissingMedia", json!({})).unwrap()["totalCount"],
        1
    );
}

#[test]
fn invalid_browser_date_does_not_enter_the_signed_library() {
    let d = Device::new();
    let id = store::id();
    let mut value = thought(&id, "Timestamp validation");
    value["createdAt"] = json!(8_640_000_000_000_001u64);
    assert!(d
        .db
        .lock()
        .unwrap()
        .record("thought", &id, value, false)
        .is_err());
    assert!(d.get(&id).is_none());
    assert!(d.db.lock().unwrap().receipts().unwrap().is_empty());
}

#[test]
fn actual_android_keystore_room_export_applies_in_windows_sqlite() {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("test-fixtures/android-export.json");
    let fixture: Value = museamo_sync_core::json::parse(&std::fs::read(path).unwrap()).unwrap();
    let d = Device::new();
    d.db.lock()
        .unwrap()
        .enroll(fixture["groupId"].as_str().unwrap())
        .unwrap();
    d.platform.call("syncApply",json!({"groupId":fixture["groupId"],"members":[fixture["identity"]],"envelopes":fixture["envelopes"],"purgeProofs":fixture["purgeProofs"],"authorizedHistory":{},"authorizedAnchors":{}})).unwrap();
    let entries = d.db.lock().unwrap().all("thought").unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["completed"], true);
    let tags = d.db.lock().unwrap().command("library", &json!({})).unwrap()["tags"].clone();
    assert_eq!(tags.as_array().unwrap().len(), 1);
    assert!(tags[0]["name"].as_str().unwrap().contains('é'));
    assert_eq!(
        d.db.lock()
            .unwrap()
            .command("listRecovery", &json!({}))
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn confirmed_enrollment_coalesces_compatible_categories_and_preserves_raw_signed_ids() {
    let a = Device::new();
    let b = Device::new();
    let tag_a = store::id();
    let tag_b = store::id();
    for (d, tag) in [(&a, &tag_a), (&b, &tag_b)] {
        d.db.lock()
            .unwrap()
            .command(
                "saveTag",
                &json!({"id":tag,"name":"Shared checklist","type":"checklist"}),
            )
            .unwrap();
    }
    let note_a = a.append("First tagged writing");
    let note_b = b.append("Second tagged writing");
    for (d, note, tag) in [(&a, &note_a, &tag_a), (&b, &note_b, &tag_b)] {
        let mut value = d.get(note).unwrap();
        value["tagIds"] = json!([tag]);
        d.db.lock()
            .unwrap()
            .record("thought", note, value, false)
            .unwrap();
    }
    pair(&a, &b);
    until(|| {
        a.db.lock().unwrap().all("tag").unwrap().len() == 1
            && b.db.lock().unwrap().all("tag").unwrap().len() == 1
    });
    quiescent(&[&a, &b]);
    let canonical = tag_a.clone().min(tag_b.clone());
    assert_eq!(a.db.lock().unwrap().all("tag").unwrap()[0]["id"], canonical);
    assert_eq!(a.db.lock().unwrap().all("thought").unwrap().len(), 2);
    assert_eq!(a.get(&note_a).unwrap()["tagIds"], json!([tag_a]));
    assert_eq!(b.get(&note_b).unwrap()["tagIds"], json!([tag_b]));
    let mut db = a.db.lock().unwrap();
    let library = db.command("library", &json!({})).unwrap();
    assert_eq!(library["tags"][0]["count"], 2);
    let entries = db
        .command("queryEntries", &json!({"tagId":canonical}))
        .unwrap();
    assert_eq!(entries["entries"].as_array().unwrap().len(), 2);
    for item in db.command("listRecovery", &json!({})).unwrap()["items"]
        .as_array()
        .unwrap()
    {
        assert_eq!(item["entityId"], item["payload"]["id"]);
    }
    drop(db);
    a.db.lock()
        .unwrap()
        .command(
            "saveTag",
            &json!({"id":canonical,"name":"Renamed shared category"}),
        )
        .unwrap();
    a.trigger();
    until(|| b.db.lock().unwrap().all("tag").unwrap()[0]["name"] == "Renamed shared category");
}

#[test]
fn foreign_causal_purge_waits_for_missing_headers_and_commits_applied_receipts_atomically() {
    let a = Device::new();
    let b = Device::new();
    let c = Device::new();
    let group = store::id();
    for d in [&a, &b, &c] {
        d.db.lock().unwrap().enroll(&group).unwrap();
    }
    let note = b.append("Foreign history to clear");
    let mut value = b.get(&note).unwrap();
    value["text"] = json!("Foreign current writing");
    b.db.lock()
        .unwrap()
        .record("thought", &note, value, false)
        .unwrap();
    let ob = b.db.lock().unwrap().device.clone();
    let oa = a.db.lock().unwrap().device.clone();
    let members = identities(&[&a, &b, &c]);
    let one = b.db.lock().unwrap().operation(&ob, 1).unwrap().unwrap();
    let two = b.db.lock().unwrap().operation(&ob, 2).unwrap().unwrap();
    a.platform
        .call(
            "syncApply",
            input(&group, &members, vec![one.clone(), two.clone()], vec![]),
        )
        .unwrap();
    a.db.lock()
        .unwrap()
        .command("clearAllRecovery", &json!({}))
        .unwrap();
    let proof = a.db.lock().unwrap().operation(&oa, 1).unwrap().unwrap();
    c.platform
        .call("syncApply", input(&group, &members, vec![one], vec![]))
        .unwrap();
    c.platform
        .call(
            "syncApply",
            input(&group, &members, vec![proof.clone()], vec![proof.clone()]),
        )
        .unwrap();
    assert_eq!(c.get(&note).unwrap()["text"], "Foreign history to clear");
    assert!(c
        .db
        .lock()
        .unwrap()
        .operation(&ob, 1)
        .unwrap()
        .unwrap()
        .payload
        .is_some());
    assert_eq!(c.db.lock().unwrap().receipts().unwrap().get(&oa), None);
    c.platform
        .call("syncApply", input(&group, &members, vec![two], vec![proof]))
        .unwrap();
    let db = c.db.lock().unwrap();
    assert_eq!(db.receipts().unwrap()[&oa], 1);
    assert_eq!(db.receipts().unwrap()[&ob], 2);
    assert!(db.operation(&ob, 1).unwrap().unwrap().payload.is_none());
    assert_eq!(
        db.get("thought", &note).unwrap().unwrap()["text"],
        "Foreign current writing"
    );
    let erased = b"Foreign history to clear";
    for name in ["library.sqlite", "library.sqlite-wal"] {
        let bytes = std::fs::read(db.root.join(name)).unwrap_or_default();
        assert!(
            !bytes.windows(erased.len()).any(|w| w == erased),
            "Cleared content remains in {name}"
        );
    }
}

#[test]
fn typed_archives_retire_late_thoughts_without_erasing_same_uuid_tag_and_collect_originals() {
    let a = Device::new();
    let b = Device::new();
    let c = Device::new();
    let group = store::id();
    for d in [&a, &b, &c] {
        d.db.lock().unwrap().enroll(&group).unwrap();
    }
    let original = store::id();
    let media = store::id();
    let bytes = b"archived-only-original";
    let metadata = json!({"id":media,"kind":"image","mimeType":"image/heic","filename":"archived.heic","byteSize":bytes.len(),"width":1,"height":1,"duration":null,"checksum":wire::hash(bytes)});
    let mut payload = thought(&original, "Historical archive");
    payload["attachments"] = json!([metadata]);
    let thought_archive =
        json!({"kind":"thought","entityId":original,"payload":payload,"createdAt":1000});
    let tag_archive = json!({"kind":"tag","entityId":original,"payload":{"id":original,"name":"Same UUID tag archive","type":"standard"},"createdAt":1000});
    {
        let mut db = a.db.lock().unwrap();
        db.put_local("media", &media, &metadata).unwrap();
        std::fs::write(db.root.join("media").join(&media), bytes).unwrap();
        db.record("archiveThought", &original, thought_archive.clone(), false)
            .unwrap();
        db.record("archiveTag", &original, tag_archive, false)
            .unwrap();
        let row = db.command("listRecovery", &json!({})).unwrap()["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["kind"] == "thought")
            .unwrap()
            .clone();
        db.command("clearRecovery", &json!({"id":row["id"]}))
            .unwrap();
        assert!(!db.root.join("media").join(&media).exists());
        assert_eq!(
            db.command("listRecovery", &json!({})).unwrap()["items"][0]["kind"],
            "tag"
        );
    }
    let members = identities(&[&a, &b, &c]);
    let oa = a.db.lock().unwrap().device.clone();
    let exported =
        a.db.lock()
            .unwrap()
            .export_changes(&json!({"groupId":group,"after":{}}))
            .unwrap();
    b.platform.call("syncApply",json!({"groupId":group,"members":members,"envelopes":exported["envelopes"],"purgeProofs":exported["purgeProofs"],"authorizedHistory":{},"authorizedAnchors":{}})).unwrap();
    assert_eq!(b.db.lock().unwrap().receipts().unwrap()[&oa], 3);
    c.db.lock()
        .unwrap()
        .record("archiveThought", &original, thought_archive, false)
        .unwrap();
    let oc = c.db.lock().unwrap().device.clone();
    let late = c.db.lock().unwrap().operation(&oc, 1).unwrap().unwrap();
    let header = wire::canonical(&late.header).unwrap();
    b.platform
        .call("syncApply", input(&group, &members, vec![late], vec![]))
        .unwrap();
    let mut db = b.db.lock().unwrap();
    let retained = db.operation(&oc, 1).unwrap().unwrap();
    assert_eq!(wire::canonical(&retained.header).unwrap(), header);
    assert!(retained.payload.is_none());
    assert!(db.operation(&oa, 2).unwrap().unwrap().payload.is_some());
    assert_eq!(
        db.command("listRecovery", &json!({})).unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(db.receipts().unwrap()[&oc], 1);
}

#[test]
fn staged_origin_cannot_advance_past_removal_cap_and_contexts_cannot_drop_dependencies() {
    let a = Device::new();
    let b = Device::new();
    let c = Device::new();
    let bad = Device::new();
    let group = store::id();
    for d in [&a, &b, &c, &bad] {
        d.db.lock().unwrap().enroll(&group).unwrap();
    }
    a.append("Missing foreign dependency");
    let note = b.append("Removed staged history");
    let mut value = b.get(&note).unwrap();
    value["text"] = json!("Over-cap staged change");
    b.db.lock()
        .unwrap()
        .record("thought", &note, value, false)
        .unwrap();
    let oa = a.db.lock().unwrap().device.clone();
    let ob = b.db.lock().unwrap().device.clone();
    let members = identities(&[&a, &b, &c, &bad]);
    let mut one = b.db.lock().unwrap().operation(&ob, 1).unwrap().unwrap();
    one.header.revision.context.insert(oa.clone(), 1);
    one.signature =
        b.db.lock()
            .unwrap()
            .identity
            .as_ref()
            .unwrap()
            .sign(&wire::signing_bytes(&one.header).unwrap());
    let mut two = b.db.lock().unwrap().operation(&ob, 2).unwrap().unwrap();
    two.header.revision.context.insert(oa.clone(), 1);
    two.header.previous_hash = wire::hash(&wire::canonical(&one.header).unwrap());
    two.signature =
        b.db.lock()
            .unwrap()
            .identity
            .as_ref()
            .unwrap()
            .sign(&wire::signing_bytes(&two.header).unwrap());
    c.platform
        .call(
            "syncApply",
            input(&group, &members, vec![one.clone(), two.clone()], vec![]),
        )
        .unwrap();
    assert_eq!(c.db.lock().unwrap().staged_receipts().unwrap()[&ob], 2);
    assert!(c.db.lock().unwrap().receipts().unwrap().get(&ob).is_none());
    let foreign = a.db.lock().unwrap().operation(&oa, 1).unwrap().unwrap();
    let mut request = input(&group, &members, vec![foreign], vec![]);
    request["authorizedHistory"] = json!({ob.clone():1});
    request["authorizedAnchors"] = json!({ob.clone():{"through":1,"headerHash":wire::hash(&wire::canonical(&one.header).unwrap())}});
    c.platform.call("syncApply", request).unwrap();
    assert_eq!(c.db.lock().unwrap().receipts().unwrap()[&ob], 1);
    assert_eq!(c.get(&note).unwrap()["text"], "Removed staged history");
    two.header.revision.context.remove(&oa);
    two.signature =
        b.db.lock()
            .unwrap()
            .identity
            .as_ref()
            .unwrap()
            .sign(&wire::signing_bytes(&two.header).unwrap());
    assert!(bad
        .platform
        .call("syncApply", input(&group, &members, vec![one, two], vec![]))
        .unwrap_err()
        .contains("drops earlier causal"));
    assert!(bad.db.lock().unwrap().staged_receipts().unwrap().is_empty());
}

#[test]
fn large_signed_library_exports_in_bounded_batches_and_finishes_paging() {
    let a = Device::new();
    let b = Device::new();
    let group = store::id();
    for d in [&a, &b] {
        d.db.lock().unwrap().enroll(&group).unwrap();
    }
    let text = "x".repeat(9 * 1024 * 1024);
    for _ in 0..3 {
        a.append(&text);
    }
    let members = identities(&[&a, &b]);
    let first =
        a.db.lock()
            .unwrap()
            .export_changes(&json!({"groupId":group,"after":{}}))
            .unwrap();
    assert_eq!(first["envelopes"].as_array().unwrap().len(), 2);
    assert_eq!(first["more"], true);
    assert!(
        serde_json::to_vec(&first).unwrap().len()
            <= museamo_sync_core::MAX_PAYLOAD_BYTES - 64 * 1024
    );
    b.platform.call("syncApply",json!({"groupId":group,"members":members,"envelopes":first["envelopes"],"purgeProofs":first["purgeProofs"],"authorizedHistory":{},"authorizedAnchors":{}})).unwrap();
    let cursor = b.db.lock().unwrap().staged_receipts().unwrap();
    let second =
        a.db.lock()
            .unwrap()
            .export_changes(&json!({"groupId":group,"after":cursor}))
            .unwrap();
    assert_eq!(second["envelopes"].as_array().unwrap().len(), 1);
    assert_eq!(second["more"], false);
    b.platform.call("syncApply",json!({"groupId":group,"members":members,"envelopes":second["envelopes"],"purgeProofs":second["purgeProofs"],"authorizedHistory":{},"authorizedAnchors":{}})).unwrap();
    assert_eq!(b.db.lock().unwrap().all("thought").unwrap().len(), 3);
}

struct SharedDevice {
    device: Device,
    sharing: Arc<museamo_sync_core::sharing::ShareService>,
}
impl SharedDevice {
    fn new() -> Self {
        let device = Device::new();
        let sharing = museamo_sync_core::sharing::ShareService::new(
            device.platform.clone(),
            device.sync.clone(),
        )
        .unwrap();
        sharing.start("127.0.0.1:0").unwrap();
        Self { device, sharing }
    }
    fn tag(&self, name: &str) -> String {
        let id = store::id();
        self.device
            .db
            .lock()
            .unwrap()
            .command("saveTag", &json!({"id":id,"name":name,"type":"checklist"}))
            .unwrap();
        id
    }
    fn wake(&self) {
        self.sharing.local_data_changed();
        self.device.trigger();
    }
    fn hint(&self, other: &SharedDevice) {
        let state = other.sharing.command("getSharingState", json!({})).unwrap();
        self.sharing
            .command(
                "shareDiscoveryHint",
                json!({"deviceId":state["deviceId"],"address":state["address"]}),
            )
            .unwrap();
    }
    fn registry(&self) -> museamo_sync_core::sharing::Registry {
        self.device.db.lock().unwrap().sharing_registry().unwrap()
    }
}
impl Drop for SharedDevice {
    fn drop(&mut self) {
        self.sharing.stop();
    }
}
#[test]
fn shared_lists_use_real_sqlite_scopes_and_linked_devices_keep_private_metadata() {
    let owner = SharedDevice::new();
    let partner = SharedDevice::new();
    let desktop = SharedDevice::new();
    pair(&partner.device, &desktop.device);
    let tag = owner.tag("Movies");
    let private = owner.tag("Private");
    let item = owner.device.append("PRIVATE pre-sharing revision");
    {
        let mut db = owner.device.db.lock().unwrap();
        let mut e = db.get("thought", &item).unwrap().unwrap();
        e["text"] = json!("Arrival #Private");
        e["tagIds"] = json!([tag, private]);
        e["starred"] = json!(true);
        e["provenance"] = json!({"label":"PRIVATE widget","profileId":null});
        db.record("thought", &item, e, false).unwrap();
    }
    let scope = owner
        .sharing
        .command("startTagSharing", json!({"tagId":tag}))
        .unwrap()["collectionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let invite = owner
        .sharing
        .command("createTagInvite", json!({"tagId":tag}))
        .unwrap();
    let joined = partner
        .sharing
        .command("joinTagShare", json!({"invite":invite["invite"]}))
        .unwrap();
    let partner_tag = joined["tagId"].as_str().unwrap().to_owned();
    let partner_item = partner.registry().bindings[&scope].entries[&item].clone();
    assert_eq!(
        partner.device.get(&partner_item).unwrap()["text"],
        "Arrival #Private"
    );
    assert_eq!(
        partner.device.get(&partner_item).unwrap()["tagIds"],
        json!([partner_tag])
    );
    assert_eq!(partner.device.get(&partner_item).unwrap()["starred"], false);
    assert!(partner.device.get(&partner_item).unwrap()["provenance"].is_null());
    assert!(!serde_json::to_string(&partner.registry())
        .unwrap()
        .contains("PRIVATE pre-sharing"));
    assert!(partner
        .device
        .db
        .lock()
        .unwrap()
        .all("tag")
        .unwrap()
        .iter()
        .all(|t| t["id"] != private));
    partner.hint(&desktop);
    desktop.hint(&partner);
    partner.hint(&owner);
    owner.hint(&partner);
    partner.wake();
    until(|| {
        desktop.registry().bindings.contains_key(&scope)
            && desktop.device.get(&partner_item).is_some()
    });
    assert_eq!(desktop.registry().bindings[&scope].tag_id, partner_tag);
    let own_private = partner.tag("Movies");
    assert_ne!(own_private, partner_tag);
    {
        let mut db = partner.device.db.lock().unwrap();
        let draft = json!({"profileKey":"app:general","entryId":store::id(),"text":"Watch #Movies","tagIds":[],"attachments":[],"location":null});
        db.put_local("draft", "app:general", &draft).unwrap();
        assert!(db.command("commitDraft", &json!({"draft":draft})).is_err());
        assert_eq!(
            db.get("draft", "app:general").unwrap().unwrap()["text"],
            "Watch #Movies"
        );
        let mut selected = draft;
        selected["tagIds"] = json!([own_private]);
        db.command("commitDraft", &json!({"draft":selected}))
            .unwrap();
    }
    {
        let mut db = desktop.device.db.lock().unwrap();
        let mut e = db.get("thought", &partner_item).unwrap().unwrap();
        e["text"] = json!("Dune #Private");
        e["completed"] = json!(true);
        e["starred"] = json!(true);
        db.record("thought", &partner_item, e, false).unwrap();
    }
    desktop.wake();
    until(|| {
        owner
            .device
            .get(&item)
            .is_some_and(|e| e["text"] == "Dune #Private" && e["completed"] == true)
    });
    assert_eq!(
        owner.device.get(&item).unwrap()["tagIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect::<std::collections::BTreeSet<_>>(),
        [tag.clone(), private.clone()].into_iter().collect()
    );
    until(|| {
        partner
            .device
            .get(&partner_item)
            .is_some_and(|e| e["text"] == "Dune #Private" && e["starred"] == true)
    });
    assert_eq!(owner.device.get(&item).unwrap()["starred"], true);
    let removable = partner.device.append("Detach and re-add");
    {
        let mut db = partner.device.db.lock().unwrap();
        let mut value = db.get("thought", &removable).unwrap().unwrap();
        value["tagIds"] = json!([partner_tag]);
        db.record("thought", &removable, value, false).unwrap();
    }
    partner
        .sharing
        .command("getTagShareState", json!({"tagId":partner_tag}))
        .unwrap();
    {
        let mut db = partner.device.db.lock().unwrap();
        let mut value = db.get("thought", &removable).unwrap().unwrap();
        value["tagIds"] = json!([]);
        db.record("thought", &removable, value, false).unwrap();
        assert!(db.get("thought", &removable).unwrap().is_none());
        let mut copy = db
            .all("thought")
            .unwrap()
            .into_iter()
            .find(|e| e["text"] == "Detach and re-add")
            .unwrap();
        let copy_id = copy["id"].as_str().unwrap().to_owned();
        assert_ne!(copy_id, removable);
        copy["tagIds"] = json!([partner_tag]);
        db.record("thought", &copy_id, copy, false).unwrap();
    }
    partner
        .sharing
        .command("getTagShareState", json!({"tagId":partner_tag}))
        .unwrap();
    assert!(
        partner.registry().scopes[&scope]
            .heads()
            .unwrap()
            .get(&format!("thought:{removable}"))
            .unwrap()
            .revision
            .deleted
    );
    let other = owner.tag("Other list");
    owner
        .sharing
        .command("startTagSharing", json!({"tagId":other}))
        .unwrap();
    let mut draft = thought(&store::id(), "Two scopes");
    draft["tagIds"] = json!([tag, other]);
    let id = draft["id"].as_str().unwrap().to_owned();
    assert!(owner
        .device
        .db
        .lock()
        .unwrap()
        .record("thought", &id, draft, false)
        .is_err());
    let mut snapshot = {
        let db = partner.device.db.lock().unwrap();
        json!({"tags":db.all("tag").unwrap(),"entries":db.all("thought").unwrap(),"recovery":[]})
    };
    partner
        .device
        .db
        .lock()
        .unwrap()
        .private_sharing_snapshot(&mut snapshot)
        .unwrap();
    assert!(snapshot["tags"]
        .as_array()
        .unwrap()
        .iter()
        .all(|t| t["id"] != partner_tag));
    assert!(snapshot["entries"]
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e["id"] != partner_item));
    owner.sharing.command("removeTagShareMember",json!({"tagId":tag,"memberId":owner.sharing.command("getTagShareState",json!({"tagId":tag})).unwrap()["members"].as_array().unwrap().iter().find(|m|m["owner"]==false).unwrap()["id"]})).unwrap();
    owner.wake();
    partner.wake();
    until(|| partner.registry().bindings[&scope].detached);
    until(|| desktop.registry().bindings[&scope].detached);
    assert!(partner.device.get(&partner_item).is_none());
    assert!(partner
        .device
        .db
        .lock()
        .unwrap()
        .all("thought")
        .unwrap()
        .iter()
        .any(|e| e["text"] == "Dune #Private" && e["id"] != partner_item));
}

#[test]
fn shared_originals_restart_and_personal_device_revocation_preserve_membership_fences() {
    let owner = SharedDevice::new();
    let member = SharedDevice::new();
    let linked = SharedDevice::new();
    pair(&member.device, &linked.device);
    let tag = owner.tag("Movies");
    let item = owner.device.append("Movie poster");
    let media = store::id();
    let original = vec![17u8; 97000];
    let metadata = json!({"id":media,"kind":"image","mimeType":"image/png","filename":"poster.png","byteSize":original.len(),"width":1,"height":1,"duration":null,"checksum":wire::hash(&original)});
    {
        let mut db = owner.device.db.lock().unwrap();
        std::fs::write(db.root.join("media").join(&media), &original).unwrap();
        db.put_local("media", &media, &metadata).unwrap();
        let mut value = db.get("thought", &item).unwrap().unwrap();
        value["attachments"] = json!([metadata]);
        value["tagIds"] = json!([tag]);
        value["location"] = json!({"latitude":37.2,"longitude":-122.1,"accuracy":10,"capturedAt":1,"token":store::id(),"userLabel":"Cinema"});
        db.record("thought", &item, value, false).unwrap();
    }
    let scope = owner
        .sharing
        .command("startTagSharing", json!({"tagId":tag}))
        .unwrap()["collectionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let invitation = owner
        .sharing
        .command("createTagInvite", json!({"tagId":tag}))
        .unwrap();
    let joined = member
        .sharing
        .command("joinTagShare", json!({"invite":invitation["invite"]}))
        .unwrap();
    let local_item = member.registry().bindings[&scope].entries[&item].clone();
    until(|| {
        member
            .device
            .db
            .lock()
            .unwrap()
            .root
            .join("media")
            .join(&media)
            .is_file()
    });
    assert_eq!(
        std::fs::read(
            member
                .device
                .db
                .lock()
                .unwrap()
                .root
                .join("media")
                .join(&media)
        )
        .unwrap(),
        original
    );
    assert_eq!(
        member.device.get(&local_item).unwrap()["location"]["userLabel"],
        "Cinema"
    );
    member.hint(&linked);
    linked.hint(&member);
    member.wake();
    until(|| {
        linked.registry().bindings.contains_key(&scope) && linked.device.get(&local_item).is_some()
    });
    let stale = linked.registry().scopes[&scope]
        .proofs
        .values()
        .find(|p| p["group"] == member.device.state()["groupId"])
        .unwrap()
        .clone();
    let removed = linked.device.state()["deviceId"]
        .as_str()
        .unwrap()
        .to_owned();
    linked.sharing.stop();
    linked.device.sync.stop();
    let db = linked.device.db.clone();
    let resumed_device = Device::from_db(db);
    let resumed_sharing = museamo_sync_core::sharing::ShareService::new(
        resumed_device.platform.clone(),
        resumed_device.sync.clone(),
    )
    .unwrap();
    resumed_sharing.start("127.0.0.1:0").unwrap();
    let resumed = SharedDevice {
        device: resumed_device,
        sharing: resumed_sharing,
    };
    assert_eq!(
        resumed.registry().bindings[&scope].entries[&item],
        local_item
    );
    assert_eq!(
        resumed
            .device
            .db
            .lock()
            .unwrap()
            .all("thought")
            .unwrap()
            .iter()
            .filter(|e| e["id"] == local_item)
            .count(),
        1
    );
    member
        .device
        .sync
        .command("removeDevice", json!({"deviceId":removed}))
        .unwrap();
    member
        .sharing
        .command("getTagShareState", json!({"tagId":joined["tagId"]}))
        .unwrap();
    let person = member.device.state()["groupId"]
        .as_str()
        .unwrap()
        .to_owned();
    let revoked = member.registry().scopes[&scope].proofs[&person].clone();
    let merged = museamo_sync_core::sharing::merge_proof(&revoked, &stale).unwrap();
    assert!(!museamo_sync_core::sharing::device_active(&merged, &Value::Null, &removed).unwrap());
    resumed.sharing.stop();
    resumed.device.sync.stop();
    let mut registry = resumed.registry();
    registry
        .scopes
        .get_mut(&scope)
        .unwrap()
        .proofs
        .insert(person.clone(), merged);
    let projection = museamo_sync_core::sharing::projections(&registry).unwrap();
    resumed
        .device
        .platform
        .call(
            "shareCommit",
            json!({"registry":registry,"participant":person,"ack":[],"projections":projection}),
        )
        .unwrap();
    let mut value = resumed.device.get(&local_item).unwrap();
    value["text"] = json!("Removed device edit");
    assert!(resumed
        .device
        .db
        .lock()
        .unwrap()
        .record("thought", &local_item, value, false)
        .is_err());
    assert_eq!(
        resumed.device.get(&local_item).unwrap()["text"],
        "Movie poster"
    );
}
