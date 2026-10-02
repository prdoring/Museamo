use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// Authenticated removal fixes its witnesses. Unknown descendants of a removed device cannot
/// authorize their own admission or manufacture accepted-history checkpoints.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Removal {
    pub id: String,
    pub subject: String,
    pub witnesses: BTreeSet<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub removal_id: String,
    pub witness: String,
    pub through: u64,
    pub header_hash: String,
}
/// Inputs must already have valid group membership/signatures. Each witness freezes once,
/// atomically when first learning removal; the subject is never allowed to witness itself.
pub fn authorized_history(
    removal: &Removal,
    checkpoints: &[Checkpoint],
) -> Result<Option<Checkpoint>, String> {
    let mut by_witness: BTreeMap<&str, &Checkpoint> = BTreeMap::new();
    for checkpoint in checkpoints {
        if checkpoint.removal_id != removal.id
            || checkpoint.witness == removal.subject
            || !removal.witnesses.contains(&checkpoint.witness)
        {
            return Err("Invalid removal witness".into());
        }
        if let Some(old) = by_witness.insert(&checkpoint.witness, checkpoint) {
            if old.through != checkpoint.through || old.header_hash != checkpoint.header_hash {
                return Err("Conflicting frozen removal checkpoint".into());
            }
        }
    }
    // Equal sequence anchors must identify the same signed origin chain.
    let mut anchors = BTreeMap::new();
    for checkpoint in by_witness.values() {
        if let Some(old) = anchors.insert(checkpoint.through, &checkpoint.header_hash) {
            if old != &checkpoint.header_hash {
                return Err("Equivocated removed-origin history".into());
            }
        }
    }
    Ok(by_witness
        .values()
        .max_by_key(|c| c.through)
        .map(|c| (*c).clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn history_union_preserves_accepted_changes_independent_of_arrival() {
        let removal = Removal {
            id: "remove".into(),
            subject: "lost".into(),
            witnesses: ["a".into(), "b".into()].into(),
        };
        let a = Checkpoint {
            removal_id: "remove".into(),
            witness: "a".into(),
            through: 3,
            header_hash: "three".into(),
        };
        let b = Checkpoint {
            removal_id: "remove".into(),
            witness: "b".into(),
            through: 5,
            header_hash: "five".into(),
        };
        assert_eq!(
            authorized_history(&removal, &[a.clone(), b.clone()])
                .unwrap()
                .unwrap()
                .through,
            5
        );
        assert_eq!(
            authorized_history(&removal, &[b, a])
                .unwrap()
                .unwrap()
                .through,
            5
        );
    }
}
