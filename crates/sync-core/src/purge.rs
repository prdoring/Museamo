//! Authorization of irreversible suppression from an already authenticated header journal.
//! This is a transaction precondition, not signature verification or an applied receipt.
use crate::{
    model::{Context, Dot},
    wire::{self, Envelope},
    MAX_PAYLOAD_BYTES,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub through: u64,
    pub header_hash: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    pub proof: Envelope,
    /// Only headers whose origin signature and contiguous predecessor chain the native journal
    /// has already verified. Include accepted and provisionally staged rows; never unverified rows.
    pub headers: Vec<Envelope>,
    /// Optional native evidence that these verified rows retain real stored bodies. Allows JNI
    /// callers to pass headers without copying every library payload into a bounded request.
    /// Never derive this set from provisional proof references or pending retirement markers.
    #[serde(default)]
    pub body_present: BTreeSet<String>,
    pub applied: Context,
    #[serde(default)]
    pub authorized_history: Context,
    #[serde(default)]
    pub authorized_anchors: BTreeMap<String, Anchor>,
    /// Markers from previously applied proofs, never markers from this pending candidate.
    #[serde(default)]
    pub purged: BTreeSet<String>,
    #[serde(default)]
    pub retired: BTreeSet<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Targets {
    revision_ids: BTreeSet<String>,
    entity_ids: BTreeSet<String>,
}

fn body_valid(envelope: &Envelope) -> Result<(), String> {
    if let Some(payload) = &envelope.payload {
        let bytes = wire::canonical(payload)?;
        if bytes.len() > MAX_PAYLOAD_BYTES
            || wire::hash(&bytes) != envelope.header.revision.payload_hash
        {
            return Err("Invalid stored payload digest or size".into());
        }
    }
    Ok(())
}

fn retired_body(envelope: &Envelope, entities: &BTreeSet<String>) -> bool {
    matches!(envelope.header.kind.as_str(), "thought" | "archiveThought")
        && entities.contains(&envelope.header.revision.entity_id)
}

/// A true result permits a native transaction to suppress covered bodies and advance causal
/// dependencies. Before COMMIT that same transaction MUST prove the candidate author's APPLIED
/// contiguous receipt reaches this proof. Otherwise roll back all erasure/retirement effects.
/// False means missing authorization/history/body; an error means malformed or conflicting history.
/// Native callers remain responsible for identity signatures, payload schemas and atomic projection.
pub fn eligible(input: &Input) -> Result<bool, String> {
    let proof = &input.proof;
    let group = &proof.header.group;
    wire::validate_header(&proof.header, group)?;
    if proof.header.kind != "purge" {
        return Err("Suppression candidate is not a purge operation".into());
    }
    body_valid(proof)?;
    let targets: Targets =
        serde_json::from_value(proof.payload.clone().ok_or("Missing purge body")?)
            .map_err(|e| format!("Invalid purge targets: {e}"))?;
    let mut rows: BTreeMap<Dot, &Envelope> = BTreeMap::new();
    let mut hashes: BTreeMap<Dot, String> = BTreeMap::new();
    for row in &input.headers {
        wire::validate_header(&row.header, group)?;
        body_valid(row)?;
        let dot = &row.header.revision.dot;
        let hash = wire::hash(&wire::canonical(&row.header)?);
        if let Some(previous) = hashes.get(dot) {
            if previous != &hash {
                return Err("Conflicting origin sequence in purge history".into());
            }
        }
        hashes.insert(dot.clone(), hash);
        let old = rows.get(dot);
        if old.is_none() || old.is_some_and(|old| old.payload.is_none() && row.payload.is_some()) {
            rows.insert(dot.clone(), row);
        }
    }
    let proof_dot = &proof.header.revision.dot;
    let Some(stored) = rows.get(proof_dot) else {
        return Ok(false);
    };
    if wire::canonical(&stored.header)? != wire::canonical(&proof.header)? {
        return Err("Purge proof differs from its durable origin header".into());
    }
    // A suppression proof itself cannot be erased: its body is required for further forwarding.
    if stored.payload.is_none() && !input.body_present.contains(&stored.header.revision.id()) {
        return Ok(false);
    }

    // Every removed origin appearing in the causal closure must have its entire signed prefix
    // linked to the exact witnessed terminal header. Merely being below the cap is insufficient.
    let mut anchored = BTreeSet::new();
    let mut graph: BTreeMap<Dot, BTreeSet<Dot>> = BTreeMap::new();
    let mut pending = vec![proof_dot.clone()];
    while let Some(dot) = pending.pop() {
        if graph.contains_key(&dot) {
            continue;
        }
        if let Some(cap) = input.authorized_history.get(&dot.origin) {
            if dot.sequence > *cap {
                return Ok(false);
            }
            if !anchored.contains(&dot.origin) {
                let Some(anchor) = input.authorized_anchors.get(&dot.origin) else {
                    return Ok(false);
                };
                if anchor.through == 0 || anchor.through != *cap {
                    return Ok(false);
                }
                let mut previous_hash = String::new();
                for sequence in 1..=anchor.through {
                    let required = Dot {
                        origin: dot.origin.clone(),
                        sequence,
                    };
                    let Some(row) = rows.get(&required) else {
                        return Ok(false);
                    };
                    if row.header.previous_hash != previous_hash {
                        return Err("Removed-origin prefix differs from its witnessed chain".into());
                    }
                    previous_hash = hashes[&required].clone();
                }
                if previous_hash != anchor.header_hash {
                    return Err(
                        "Removed-origin history differs from the signed witness checkpoint".into(),
                    );
                }
                anchored.insert(dot.origin.clone());
            }
        }
        // An already applied dependency was checked by the native atomic journal. Keep cap/anchor
        // checks above even for this fast path, so staged or post-removal data cannot masquerade as it.
        if dot != *proof_dot && input.applied.get(&dot.origin).copied().unwrap_or(0) >= dot.sequence
        {
            graph.insert(dot, BTreeSet::new());
            continue;
        }
        let Some(row) = rows.get(&dot) else {
            return Ok(false);
        };
        let revision = &row.header.revision;
        if row.payload.is_none() && !input.body_present.contains(&revision.id()) {
            // Purge and alias proofs always retain bodies even if a malicious candidate names them.
            let suppressible = matches!(
                row.header.kind.as_str(),
                "thought" | "tag" | "archiveThought" | "archiveTag"
            );
            if !suppressible
                || !(targets.revision_ids.contains(&revision.id())
                    || input.purged.contains(&revision.id())
                    || retired_body(row, &targets.entity_ids)
                    || retired_body(row, &input.retired))
            {
                return Ok(false);
            }
        }
        let mut dependencies = BTreeSet::new();
        if revision.context.get(&dot.origin).copied().unwrap_or(0) != dot.sequence - 1 {
            return Err("Origin context does not describe its contiguous predecessor".into());
        }
        if dot.sequence == 1 {
            if !row.header.previous_hash.is_empty() {
                return Err("Invalid first origin header".into());
            }
        } else {
            let previous = Dot {
                origin: dot.origin.clone(),
                sequence: dot.sequence - 1,
            };
            let Some(predecessor) = rows.get(&previous) else {
                return Ok(false);
            };
            if row.header.previous_hash != hashes[&previous] {
                return Err("Purge dependency has an invalid predecessor hash".into());
            }
            if predecessor
                .header
                .revision
                .context
                .iter()
                .any(|(origin, sequence)| {
                    revision.context.get(origin).copied().unwrap_or(0) < *sequence
                })
            {
                return Err("Origin context drops an observed causal dependency".into());
            }
            dependencies.insert(previous);
        }
        for (origin, sequence) in &revision.context {
            if *sequence > 0 {
                dependencies.insert(Dot {
                    origin: origin.clone(),
                    sequence: *sequence,
                });
            }
        }
        pending.extend(dependencies.iter().cloned());
        graph.insert(dot, dependencies);
    }
    // Kahn traversal rejects cycles of any length without recursive calls or stack exhaustion.
    let mut dependents: BTreeMap<Dot, Vec<Dot>> = BTreeMap::new();
    let mut incoming: BTreeMap<Dot, usize> = BTreeMap::new();
    let mut ready = Vec::new();
    for (dot, dependencies) in &graph {
        incoming.insert(dot.clone(), dependencies.len());
        if dependencies.is_empty() {
            ready.push(dot.clone())
        }
        for dependency in dependencies {
            dependents
                .entry(dependency.clone())
                .or_default()
                .push(dot.clone());
        }
    }
    let mut visited = 0;
    while let Some(dot) = ready.pop() {
        visited += 1;
        for dependent in dependents.get(&dot).into_iter().flatten() {
            let n = incoming
                .get_mut(dependent)
                .ok_or("Missing causal closure")?;
            *n -= 1;
            if *n == 0 {
                ready.push(dependent.clone())
            }
        }
    }
    if visited != graph.len() {
        return Err("Cyclic purge causal history".into());
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        model::{Clock, Revision},
        wire::Header,
    };
    use serde_json::json;

    fn row(
        origin: &str,
        sequence: u64,
        previous: Option<&Envelope>,
        kind: &str,
        entity: &str,
        context: &[(&str, u64)],
        payload: serde_json::Value,
    ) -> Envelope {
        Envelope {
            header: Header {
                protocol: 1,
                group: "group".into(),
                kind: kind.into(),
                previous_hash: previous
                    .map(|r| wire::hash(&wire::canonical(&r.header).unwrap()))
                    .unwrap_or_default(),
                revision: Revision {
                    entity_id: entity.into(),
                    dot: Dot {
                        origin: origin.into(),
                        sequence,
                    },
                    context: context.iter().map(|(o, n)| (o.to_string(), *n)).collect(),
                    clock: Clock::default(),
                    deleted: false,
                    payload_hash: wire::hash(&wire::canonical(&payload).unwrap()),
                },
            },
            signature: "native-verified".into(),
            payload: Some(payload),
        }
    }
    fn fixture() -> Input {
        let a = row(
            "a",
            1,
            None,
            "thought",
            "a-thought",
            &[],
            json!({"text":"first"}),
        );
        let b = row(
            "b",
            1,
            None,
            "thought",
            "b-thought",
            &[],
            json!({"text":"private"}),
        );
        let proof = row(
            "a",
            2,
            Some(&a),
            "purge",
            "proof",
            &[("a", 1), ("b", 1)],
            json!({"revisionIds":["b:1"],"entityIds":[]}),
        );
        let mut erased = b;
        erased.payload = None;
        Input {
            proof: proof.clone(),
            headers: vec![a, erased, proof],
            body_present: BTreeSet::new(),
            applied: Context::new(),
            authorized_history: Context::new(),
            authorized_anchors: BTreeMap::new(),
            purged: BTreeSet::new(),
            retired: BTreeSet::new(),
        }
    }
    #[test]
    fn erased_cross_origin_dependency_bootstraps_from_signed_header_dag() {
        let input = fixture();
        assert!(eligible(&input).unwrap());
        let request = serde_json::json!({"action":"purgeEligible","proof":input.proof,"headers":input.headers,"applied":{}});
        assert_eq!(
            crate::api::evaluate(&request).unwrap(),
            json!({"eligible":true})
        );
    }
    #[test]
    fn native_body_presence_allows_bounded_header_only_jni_requests() {
        let mut input = fixture();
        for row in &mut input.headers {
            if row.payload.is_some() {
                input.body_present.insert(row.header.revision.id());
                row.payload = None;
            }
        }
        assert!(eligible(&input).unwrap());
        input.body_present.remove("a:2");
        assert!(!eligible(&input).unwrap());
    }
    #[test]
    fn unproved_body_or_missing_causal_header_never_authorizes_erase() {
        let mut input = fixture();
        input.headers[1].header.revision.entity_id = "other".into();
        input.proof.payload = Some(json!({"revisionIds":[],"entityIds":["b-thought"]}));
        input.proof.header.revision.payload_hash =
            wire::hash(&wire::canonical(input.proof.payload.as_ref().unwrap()).unwrap());
        input.headers[2] = input.proof.clone();
        assert!(!eligible(&input).unwrap());
        input = fixture();
        input.headers.remove(1);
        assert!(!eligible(&input).unwrap());
    }
    #[test]
    fn retired_namespace_committed_in_signed_header() {
        let mut input = fixture();
        input.proof.payload = Some(json!({"revisionIds":[],"entityIds":["b-thought"]}));
        input.proof.header.revision.payload_hash =
            wire::hash(&wire::canonical(input.proof.payload.as_ref().unwrap()).unwrap());
        input.headers[2] = input.proof.clone();
        input.headers[1].header.kind = "archiveThought".into();
        assert!(eligible(&input).unwrap());
        input.headers[1].header.kind = "archiveTag".into();
        assert!(!eligible(&input).unwrap());
    }
    #[test]
    fn removed_alternate_purge_below_cap_cannot_bypass_witness_anchor() {
        let mut input = fixture();
        input.authorized_history.insert("a".into(), 2);
        input.authorized_anchors.insert(
            "a".into(),
            Anchor {
                through: 2,
                header_hash: wire::hash(&wire::canonical(&input.proof.header).unwrap()),
            },
        );
        assert!(eligible(&input).unwrap());
        input.proof.header.revision.clock.wall = 1;
        input.headers[2] = input.proof.clone();
        assert!(eligible(&input).unwrap_err().contains("witness checkpoint"));
        input.authorized_history.insert("b".into(), 1);
        assert!(!eligible(&input).unwrap_or(false));
    }
    #[test]
    fn causal_cycles_and_dropped_foreign_contexts_are_errors() {
        let mut input = fixture();
        input.headers[1]
            .header
            .revision
            .context
            .insert("a".into(), 2);
        assert!(eligible(&input).unwrap_err().contains("Cyclic"));
        input = fixture();
        input.headers[0]
            .header
            .revision
            .context
            .insert("b".into(), 1);
        input.proof.header.previous_hash =
            wire::hash(&wire::canonical(&input.headers[0].header).unwrap());
        input.proof.header.revision.context.remove("b");
        input.headers[2] = input.proof.clone();
        assert!(eligible(&input).unwrap_err().contains("drops"));
    }
    #[test]
    fn alternate_durable_header_and_erased_proof_are_rejected() {
        let mut input = fixture();
        input.proof.header.revision.clock.wall = 1;
        assert!(eligible(&input).unwrap_err().contains("durable origin"));
        input = fixture();
        input.headers[2].payload = None;
        assert!(!eligible(&input).unwrap());
    }
}
