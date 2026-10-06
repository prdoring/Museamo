//! Saved-payload validation shared by all native repositories.
use crate::wire::{self, Envelope};
use serde_json::Value;
use std::collections::BTreeSet;
type Result<T> = std::result::Result<T, String>;
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> { value[key].as_str().ok_or_else(|| format!("Invalid {key}")) }
fn uuid(value: &str) -> Result<&str> {
    if value.len() != 36 || value.bytes().enumerate().any(|(i,b)| if [8,13,18,23].contains(&i) { b != b'-' } else { !b.is_ascii_hexdigit() }) { return Err("Invalid object identity".into()); }
    Ok(value)
}
pub fn validate_operation(e: &Envelope) -> Result<()> {
    wire::validate_header(&e.header, &e.header.group)?;
    if ![
        "thought",
        "tag",
        "purge",
        "archiveThought",
        "archiveTag",
        "tagAlias",
    ]
    .contains(&e.header.kind.as_str())
    {
        return Err("Unknown replicated object kind".into());
    }
    let Some(p) = &e.payload else {
        return Ok(());
    };
    match e.header.kind.as_str() {
        "thought" => validate_thought(p, &e.header.revision.entity_id),
        "tag" => {
            if string(p, "id")? != e.header.revision.entity_id
                || string(p, "name")?.trim().is_empty()
                || string(p, "name")?.encode_utf16().count() > 80
                || !["standard", "checklist"].contains(&string(p, "type")?)
            {
                return Err("Invalid category change".into());
            }
            Ok(())
        }
        "purge" => {
            for n in ["revisionIds", "entityIds"] {
                if p[n].as_array().ok_or("Invalid purge proof")?.len() > 10000 {
                    return Err("Purge proof too large".into());
                }
            }
            for v in p["revisionIds"].as_array().unwrap() {
                let v = v.as_str().ok_or("Invalid purge revision")?;
                let (o, s) = v.rsplit_once(':').ok_or("Invalid purge revision")?;
                uuid(o)?;
                s.parse::<u64>()
                    .ok()
                    .filter(|s| *s > 0)
                    .ok_or("Invalid purge revision")?;
            }
            for v in p["entityIds"].as_array().unwrap() {
                uuid(v.as_str().ok_or("Invalid purge entity")?)?;
            }
            Ok(())
        }
        "tagAlias" => {
            let ids = p["ids"].as_array().ok_or("Invalid tag alias identities")?;
            if ids.len() < 2 || ids.len() > 10000 {
                return Err("Invalid alias size".into());
            }
            let mut previous = "";
            for v in ids {
                let id = uuid(v.as_str().ok_or("Invalid tag alias identity")?)?;
                if id <= previous {
                    return Err("Tag aliases must be sorted and unique".into());
                }
                previous = id;
            }
            let name = string(p, "normalizedName")?;
            if name.is_empty()
                || crate::normalize_tag(name) != name
                || !["standard", "checklist"].contains(&string(p, "type")?)
            {
                return Err("Invalid tag alias metadata".into());
            }
            Ok(())
        }
        "archiveThought" | "archiveTag" => {
            if p["kind"] != "thought" && p["kind"] != "tag" {
                return Err("Invalid archived version".into());
            }
            uuid(string(p, "entityId")?)?;
            if p["entityId"] != e.header.revision.entity_id
                || (e.header.kind == "archiveThought") != (p["kind"] == "thought")
            {
                return Err(
                    "Archive header differs from its original identity or namespace".into(),
                );
            }
            p["createdAt"]
                .as_u64()
                .filter(|v| *v <= 8_640_000_000_000_000)
                .ok_or("Invalid Recovery timestamp")?;
            if p["payload"]["id"] != p["entityId"] {
                return Err("Recovery identity differs from its original payload".into());
            }
            if p["kind"] == "thought" {
                validate_thought(&p["payload"], string(p, "entityId")?)?;
            } else {
                let name = string(&p["payload"], "name")?;
                if name.trim().is_empty()
                    || name.encode_utf16().count() > 80
                    || !["standard", "checklist"].contains(&string(&p["payload"], "type")?)
                {
                    return Err("Invalid Recovery category".into());
                }
            }
            Ok(())
        }
        _ => unreachable!(),
    }
}
pub fn validate_thought(p: &Value, entity: &str) -> Result<()> {
    if string(p, "id")? != entity {
        return Err("Thought identity differs from its signed header".into());
    }
    if string(p, "text")?.len() > 20 * 1024 * 1024 {
        return Err("Thought text is too large".into());
    }
    for n in ["createdAt", "updatedAt"] {
        p[n].as_u64()
            .filter(|v| *v <= 8_640_000_000_000_000)
            .ok_or("Invalid thought timestamp")?;
    }
    for n in ["starred", "completed"] {
        p[n].as_bool().ok_or("Invalid thought state")?;
    }
    for v in p["tagIds"].as_array().ok_or("Invalid thought categories")? {
        uuid(v.as_str().ok_or("Invalid category identifier")?)?;
    }
    let attachments = p["attachments"]
        .as_array()
        .ok_or("Invalid thought attachments")?;
    if attachments.len() > 10 {
        return Err("Too many thought attachments".into());
    }
    let mut ids = BTreeSet::new();
    for a in attachments {
        validate_media(a)?;
        if !ids.insert(string(a, "id")?) {
            return Err("Duplicate attachment identity".into());
        }
    }
    if !p["location"].is_null() {
        let l = &p["location"];
        l["latitude"]
            .as_f64()
            .filter(|v| v.is_finite() && (-90.0..=90.0).contains(v))
            .ok_or("Invalid latitude")?;
        l["longitude"]
            .as_f64()
            .filter(|v| v.is_finite() && (-180.0..=180.0).contains(v))
            .ok_or("Invalid longitude")?;
        if let Some(time) = l.get("capturedAt") {
            time.as_u64()
                .filter(|v| *v <= 8_640_000_000_000_000)
                .ok_or("Invalid location timestamp")?;
        }
    }
    Ok(())
}
pub fn validate_media(p: &Value) -> Result<()> {
    uuid(string(p, "id")?)?;
    let kind = string(p, "kind")?;
    if !["image", "video"].contains(&kind) {
        return Err("Invalid attachment kind".into());
    }
    p["byteSize"]
        .as_u64()
        .filter(|v| *v > 0 && *v <= if kind == "image" { 50 } else { 500 } * 1024 * 1024)
        .ok_or("Invalid attachment size")?;
    let hash = string(p, "checksum")?;
    if hash.len() != 64 || hex::decode(hash).is_err() {
        return Err("Invalid attachment checksum".into());
    }
    let mime = string(p, "mimeType")?;
    if !mime.starts_with(&format!("{kind}/")) || mime.contains(['\r', '\n']) {
        return Err("Invalid attachment type".into());
    }
    Ok(())
}
