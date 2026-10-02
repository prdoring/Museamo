//! Enrollment aliases preserve signed identities while projecting one deterministic tag.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TagAlias {
    pub ids: Vec<String>,
    pub normalized_name: String,
    #[serde(rename = "type")]
    pub kind: String,
}
pub fn aliases(records: &[TagAlias]) -> Result<BTreeMap<String, String>, String> {
    let mut parents: BTreeMap<String, String> = BTreeMap::new();
    for record in records {
        if record.ids.len() < 2
            || record.ids.len() > 10_000
            || record.normalized_name.is_empty()
            || crate::normalize_tag(&record.normalized_name) != record.normalized_name
            || !["standard", "checklist"].contains(&record.kind.as_str())
        {
            return Err("Invalid enrollment category alias".into());
        }
        let unique: BTreeSet<_> = record.ids.iter().collect();
        if unique.len() != record.ids.len()
            || record.ids.iter().any(|id| id.is_empty() || id.len() > 128)
        {
            return Err("Invalid aliased identities".into());
        }
        let roots = record
            .ids
            .iter()
            .map(|id| {
                let mut root = id.as_str();
                while let Some(parent) = parents.get(root) {
                    if parent == root {
                        break;
                    }
                    root = parent;
                }
                root.to_string()
            })
            .collect::<Vec<_>>();
        let root = roots.iter().min().unwrap().clone();
        for id in &record.ids {
            parents.entry(id.clone()).or_insert_with(|| id.clone());
        }
        for old in roots {
            parents.insert(old, root.clone());
        }
    }
    let mut result = BTreeMap::new();
    for id in parents.keys() {
        let mut root = id.as_str();
        while let Some(parent) = parents.get(root) {
            if parent == root {
                break;
            }
            root = parent;
        }
        result.insert(id.clone(), root.to_string());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(ids: &[&str]) -> TagAlias {
        TagAlias {
            ids: ids.iter().map(|id| id.to_string()).collect(),
            normalized_name: "groceries".into(),
            kind: "checklist".into(),
        }
    }
    #[test]
    fn enrollment_aliases_are_transitive_and_order_independent() {
        let first = record(&["b", "c"]);
        let second = record(&["a", "b"]);
        let expected = BTreeMap::from([
            ("a".into(), "a".into()),
            ("b".into(), "a".into()),
            ("c".into(), "a".into()),
        ]);
        assert_eq!(aliases(&[first.clone(), second.clone()]).unwrap(), expected);
        assert_eq!(aliases(&[second, first]).unwrap(), expected);
    }
    #[test]
    fn names_do_not_create_aliases_without_an_explicit_signed_enrollment_record() {
        assert!(aliases(&[]).unwrap().is_empty());
        let mut bad = record(&["a", "b"]);
        bad.normalized_name = " Groceries ".into();
        assert!(aliases(&[bad]).is_err());
    }
}
