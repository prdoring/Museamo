use crate::{model::Revision, MAX_PAYLOAD_BYTES, MAX_TIMESTAMP, PROTOCOL_VERSION};
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Header {
    pub protocol: u32,
    pub group: String,
    pub kind: String,
    pub previous_hash: String,
    pub revision: Revision,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Envelope {
    pub header: Header,
    /// DER-encoded P-256 ECDSA signature over domain-separated canonical header bytes.
    pub signature: String,
    /// Omitted only with a validated replicated purge record. Never rewrite the signed header.
    pub payload: Option<Value>,
}

pub fn canonical(value: &impl Serialize) -> Result<Vec<u8>, String> {
    serde_jcs::to_vec(value).map_err(|e| e.to_string())
}
pub fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
pub fn signing_bytes(header: &Header) -> Result<Vec<u8>, String> {
    let mut bytes = b"museamo-sync-header-v1\0".to_vec();
    bytes.extend(canonical(header)?);
    Ok(bytes)
}
pub fn validate_header(header: &Header, group: &str) -> Result<(), String> {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    let revision = &header.revision;
    if header.protocol != PROTOCOL_VERSION || header.group != group || revision.dot.sequence == 0 {
        return Err("Unsupported protocol or wrong library".into());
    }
    if !matches!(
        header.kind.as_str(),
        "thought" | "tag" | "purge" | "tagAlias" | "archiveThought" | "archiveTag"
    ) {
        return Err("Unsupported operation kind".into());
    }
    if revision.clock.wall > MAX_TIMESTAMP
        || revision.clock.logical > MAX_SAFE_INTEGER
        || revision.dot.sequence > MAX_SAFE_INTEGER
        || revision.context.len() > 128
        || revision.context.values().any(|n| *n > MAX_SAFE_INTEGER)
        || revision
            .context
            .get(&revision.dot.origin)
            .copied()
            .unwrap_or(0)
            >= revision.dot.sequence
    {
        return Err("Invalid operation timestamp, causality or numeric precision".into());
    }
    Ok(())
}
pub fn verify(envelope: &Envelope, group: &str, key: &[u8], purged: bool) -> Result<(), String> {
    let header = &envelope.header;
    validate_header(header, group)?;
    let key = VerifyingKey::from_sec1_bytes(key).map_err(|_| "Invalid signing identity")?;
    let signature = hex::decode(&envelope.signature).map_err(|_| "Invalid signature encoding")?;
    let signature = Signature::from_der(&signature).map_err(|_| "Invalid signature")?;
    key.verify(&signing_bytes(header)?, &signature)
        .map_err(|_| "Signature verification failed")?;
    match &envelope.payload {
        Some(payload) => {
            let bytes = canonical(payload)?;
            if bytes.len() > MAX_PAYLOAD_BYTES || hash(&bytes) != header.revision.payload_hash {
                return Err("Invalid payload digest or size".into());
            }
        }
        None if !purged => return Err("Missing payload without purge proof".into()),
        None => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Clock, Dot};
    use p256::ecdsa::{signature::Signer, SigningKey};
    #[test]
    fn purge_preserves_signature_but_requires_proof() {
        let key = SigningKey::from_bytes((&[7u8; 32]).into()).unwrap();
        let payload = serde_json::json!({"text":"private", "location":null});
        let header = Header {
            protocol: 1,
            group: "group".into(),
            kind: "thought".into(),
            previous_hash: String::new(),
            revision: Revision {
                entity_id: "entry".into(),
                dot: Dot {
                    origin: "device".into(),
                    sequence: 1,
                },
                context: Default::default(),
                clock: Clock::default(),
                deleted: false,
                payload_hash: hash(&canonical(&payload).unwrap()),
            },
        };
        let signature: Signature = key.sign(&signing_bytes(&header).unwrap());
        let mut envelope = Envelope {
            header,
            signature: hex::encode(signature.to_der().as_bytes()),
            payload: Some(payload),
        };
        let public = key.verifying_key().to_encoded_point(false);
        verify(&envelope, "group", public.as_bytes(), false).unwrap();
        envelope.payload = None;
        assert!(verify(&envelope, "group", public.as_bytes(), false).is_err());
        verify(&envelope, "group", public.as_bytes(), true).unwrap();
        assert!(verify(&envelope, "another", public.as_bytes(), true).is_err());
        envelope.header.revision.clock.wall = MAX_TIMESTAMP + 1;
        let signature: Signature = key.sign(&signing_bytes(&envelope.header).unwrap());
        envelope.signature = hex::encode(signature.to_der().as_bytes());
        assert!(verify(&envelope, "group", public.as_bytes(), true)
            .unwrap_err()
            .contains("timestamp"));
    }
}
