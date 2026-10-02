use crate::store::{self, Result, Store};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Seek, SeekFrom, Write},
    sync::{Arc, Mutex},
};

fn mime(path: &std::path::Path) -> Result<(&'static str, &'static str)> {
    match path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => Ok(("image", "image/jpeg")),
        "png" => Ok(("image", "image/png")),
        "gif" => Ok(("image", "image/gif")),
        "webp" => Ok(("image", "image/webp")),
        "avif" => Ok(("image", "image/avif")),
        "heic" => Ok(("image", "image/heic")),
        "heif" => Ok(("image", "image/heif")),
        "mp4" => Ok(("video", "video/mp4")),
        "webm" => Ok(("video", "video/webm")),
        "mov" => Ok(("video", "video/quicktime")),
        "m4v" => Ok(("video", "video/x-m4v")),
        "ogv" => Ok(("video", "video/ogg")),
        _ => Err("Choose a supported photo or video.".into()),
    }
}
pub fn pick(store: &Arc<Mutex<Store>>, input: &Value) -> Result<Value> {
    let remaining = input["remaining"]
        .as_u64()
        .filter(|n| (1..=10).contains(n))
        .ok_or("Choose up to ten attachments")?;
    let Some(paths) = rfd::FileDialog::new()
        .add_filter(
            "Photos and videos",
            &[
                "jpg", "jpeg", "png", "gif", "webp", "avif", "heic", "heif", "mp4", "webm", "mov",
                "m4v", "ogv",
            ],
        )
        .pick_files()
    else {
        return Ok(json!({"attachments":[]}));
    };
    if paths.len() as u64 > remaining {
        return Err(format!("Choose up to {remaining} attachments."));
    }
    let root = store
        .lock()
        .map_err(|_| "Storage unavailable")?
        .root
        .clone();
    let mut staged = vec![];
    let result = (|| -> Result<Value> {
        for path in paths {
            let (kind, mime) = mime(&path)?;
            let maximum = if kind == "image" { 50 } else { 500 } * 1024 * 1024;
            let mut source = std::fs::File::open(&path).map_err(|e| e.to_string())?;
            let length = source.metadata().map_err(|e| e.to_string())?.len();
            if length == 0 || length > maximum {
                return Err("Use images up to 50 MiB and videos up to 500 MiB.".into());
            }
            let id = store::id();
            let target = root.join("staging").join(&id);
            staged.push((id.clone(), target.clone(), Value::Null));
            let mut output = std::fs::File::create(&target).map_err(|e| e.to_string())?;
            let mut digest = Sha256::new();
            let mut buffer = [0; 64 * 1024];
            let mut total = 0u64;
            loop {
                let count = source.read(&mut buffer).map_err(|e| e.to_string())?;
                if count == 0 {
                    break;
                }
                total += count as u64;
                if total > maximum {
                    return Err("Attachment exceeds its size limit.".into());
                }
                output
                    .write_all(&buffer[..count])
                    .map_err(|e| e.to_string())?;
                digest.update(&buffer[..count]);
            }
            output.sync_all().map_err(|e| e.to_string())?;
            staged.last_mut().unwrap().2 = json!({"id":id,"kind":kind,"mimeType":mime,"filename":path.file_name().and_then(|s|s.to_str()).unwrap_or("Attachment"),"byteSize":total,"width":1,"height":1,"duration":if kind=="video"{json!(0)}else{Value::Null},"checksum":hex::encode(digest.finalize()),"availability":"available"});
        }
        // Files are published before metadata. A crash leaves only harmless unregistered originals.
        let db = store.lock().map_err(|_| "Storage unavailable")?;
        db.db
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        let commit = (|| -> Result<()> {
            for (id, path, row) in &staged {
                std::fs::rename(path, root.join("media").join(id)).map_err(|e| e.to_string())?;
                db.put_local("media", id, row)?;
                db.set_metadata(
                    &format!("mediaPin:{id}"),
                    &(store::now() + 20 * 60 * 1000).to_string(),
                )?;
            }
            db.db.execute_batch("COMMIT").map_err(|e| e.to_string())?;
            Ok(())
        })();
        if let Err(error) = commit {
            let _ = db.db.execute_batch("ROLLBACK");
            return Err(error);
        }
        Ok(json!({"attachments":staged.iter().map(|(_,_,row)|row).collect::<Vec<_>>()}))
    })();
    if result.is_err() {
        for (id, path, _) in &staged {
            let _ = std::fs::remove_file(path);
            let _ = std::fs::remove_file(root.join("media").join(id));
        }
    }
    result
}
pub fn metadata(store: &Arc<Mutex<Store>>, input: &Value) -> Result<Value> {
    let id = store::uuid(store::string(input, "id")?)?;
    let db = store.lock().map_err(|_| "Storage unavailable")?;
    let mut row = db.get("media", id)?.ok_or("Attachment is unavailable")?;
    for field in ["width", "height"] {
        let n = input[field]
            .as_u64()
            .filter(|n| *n > 0 && *n <= i32::MAX as u64)
            .ok_or("Invalid media dimensions")?;
        row[field] = json!(n);
    }
    if row["kind"] == "video" {
        row["duration"] = json!(input["duration"]
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.)
            .ok_or("Invalid duration")?);
    }
    db.put_local("media", id, &row)?;
    Ok(row)
}
pub fn resolve(store: &Arc<Mutex<Store>>, input: &Value, base: &str) -> Result<Value> {
    let id = store::uuid(store::string(input, "id")?)?;
    let db = store.lock().map_err(|_| "Storage unavailable")?;
    let row = match db.get("media", id)? {
        Some(row) => row,
        None => {
            let references = crate::replica::referenced_media(&db, true)?;
            let row = references.get(id).ok_or("Media is unavailable")?;
            return Ok(json!({"url":"","availability":"pending","byteSize":row["byteSize"]}));
        }
    };
    if !db.root.join("media").join(id).is_file() {
        return Ok(json!({"url":"","availability":"pending","byteSize":row["byteSize"]}));
    }
    Ok(json!({"url":format!("{base}/{id}"),"availability":"available","byteSize":row["byteSize"]}))
}

/// Read-only, per-process bearer route bound exclusively to loopback. File bytes stream rather
/// than crossing IPC or being buffered into a 500 MiB HTTP response.
pub fn serve(store: Arc<Mutex<Store>>) -> Result<String> {
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let address = server
        .server_addr()
        .to_ip()
        .ok_or("Invalid local media address")?;
    let prefix = format!("/{}/{}", store::id(), store::id());
    let base = format!("http://{address}{prefix}");
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let result = (|| -> Result<_> {
                if request.method() != &tiny_http::Method::Get
                    && request.method() != &tiny_http::Method::Head
                {
                    return Err("Invalid request".into());
                }
                let requested = request
                    .url()
                    .strip_prefix(&format!("{prefix}/"))
                    .ok_or("Unknown route")?;
                store::uuid(requested)?;
                let (path, mime) = {
                    let db = store.lock().map_err(|_| "Storage unavailable")?;
                    let row = db.get("media", requested)?.ok_or("Unknown media")?;
                    (
                        db.root.join("media").join(requested),
                        row["mimeType"]
                            .as_str()
                            .unwrap_or("application/octet-stream")
                            .to_owned(),
                    )
                };
                let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
                let size = file.metadata().map_err(|e| e.to_string())?.len();
                let range = request
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("Range"))
                    .map(|h| h.value.as_str());
                let (start, end, status) = if let Some(range) = range {
                    let (start, end) = parse_range(range, size)?;
                    (start, end, 206)
                } else {
                    (0, size.saturating_sub(1), 200)
                };
                file.seek(SeekFrom::Start(start))
                    .map_err(|e| e.to_string())?;
                let length = if size == 0 { 0 } else { end - start + 1 };
                let mut headers = vec![
                    tiny_http::Header::from_bytes("Content-Type", mime).unwrap(),
                    tiny_http::Header::from_bytes("Accept-Ranges", "bytes").unwrap(),
                    tiny_http::Header::from_bytes("Cache-Control", "no-store").unwrap(),
                    tiny_http::Header::from_bytes("X-Content-Type-Options", "nosniff").unwrap(),
                ];
                if status == 206 {
                    headers.push(
                        tiny_http::Header::from_bytes(
                            "Content-Range",
                            format!("bytes {start}-{end}/{size}"),
                        )
                        .unwrap(),
                    );
                }
                Ok(tiny_http::Response::new(
                    tiny_http::StatusCode(status),
                    headers,
                    file.take(length),
                    Some(length as usize),
                    None,
                ))
            })();
            match result {
                Ok(response) => {
                    let _ = request.respond(response);
                }
                Err(_) => {
                    let _ = request.respond(tiny_http::Response::empty(404));
                }
            }
        }
    });
    Ok(base)
}
fn parse_range(range: &str, size: u64) -> Result<(u64, u64)> {
    let range = range.strip_prefix("bytes=").ok_or("Invalid byte range")?;
    if range.contains(',') || size == 0 {
        return Err("Unsupported byte range".into());
    }
    let (start, end) = range.split_once('-').ok_or("Invalid byte range")?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().map_err(|_| "Invalid byte range")?;
        if suffix == 0 {
            return Err("Invalid byte range".into());
        }
        return Ok((size.saturating_sub(suffix), size - 1));
    }
    let start = start.parse::<u64>().map_err(|_| "Invalid byte range")?;
    let end = if end.is_empty() {
        size - 1
    } else {
        end.parse::<u64>()
            .map_err(|_| "Invalid byte range")?
            .min(size - 1)
    };
    if start >= size || end < start {
        return Err("Unsatisfiable byte range".into());
    }
    Ok((start, end))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=2-5", 10).unwrap(), (2, 5));
        assert_eq!(parse_range("bytes=-3", 10).unwrap(), (7, 9));
        assert!(parse_range("bytes=10-", 10).is_err());
        assert!(parse_range("bytes=0-1,4-5", 10).is_err());
    }
}
