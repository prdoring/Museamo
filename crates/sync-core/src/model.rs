use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub type Context = BTreeMap<String, u64>;

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Dot {
    pub origin: String,
    pub sequence: u64,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
pub struct Clock {
    pub wall: u64,
    pub logical: u64,
}

impl Clock {
    pub fn tick(self, physical: u64, observed: Option<Self>) -> Result<Self, String> {
        let remote = observed.unwrap_or_default();
        let wall = physical.max(self.wall).max(remote.wall);
        let logical = if wall == self.wall && wall == remote.wall {
            self.logical.max(remote.logical).checked_add(1)
        } else if wall == self.wall {
            self.logical.checked_add(1)
        } else if wall == remote.wall {
            remote.logical.checked_add(1)
        } else {
            Some(0)
        }
        .ok_or("Logical clock exhausted")?;
        Ok(Self { wall, logical })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Revision {
    pub entity_id: String,
    pub dot: Dot,
    pub context: Context,
    pub clock: Clock,
    pub deleted: bool,
    pub payload_hash: String,
}

impl Revision {
    pub fn observes(&self, other: &Self) -> bool {
        self.dot.origin == other.dot.origin && self.dot.sequence > other.dot.sequence
            || self.context.get(&other.dot.origin).copied().unwrap_or(0) >= other.dot.sequence
    }
    pub fn id(&self) -> String {
        format!("{}:{}", self.dot.origin, self.dot.sequence)
    }
}

/// Selection considers the entire maximal frontier, never a pairwise current-winner comparator.
pub fn frontier<'a>(revisions: &'a [Revision]) -> Result<Vec<&'a Revision>, String> {
    let mut dots = BTreeMap::new();
    let entity = revisions.first().map(|r| r.entity_id.as_str());
    for revision in revisions {
        if Some(revision.entity_id.as_str()) != entity || revision.dot.sequence == 0 {
            return Err("Invalid entity revision".into());
        }
        if revision
            .context
            .get(&revision.dot.origin)
            .copied()
            .unwrap_or(0)
            >= revision.dot.sequence
        {
            return Err("Revision observes its own future".into());
        }
        if let Some(old) = dots.insert(&revision.dot, revision) {
            if old != revision {
                return Err("Conflicting origin sequence: quarantine this identity".into());
            }
        }
    }
    let unique: Vec<_> = dots.values().copied().collect();
    // Reject every causal cycle, including a cycle hidden behind an unrelated valid frontier.
    // Pairwise checks cannot find a three-origin cycle, so traverse the complete DAG.
    let mut incoming = vec![0usize; unique.len()];
    for (index, candidate) in unique.iter().enumerate() {
        for other in &unique {
            if other.dot != candidate.dot && other.observes(candidate) {
                incoming[index] += 1;
            }
        }
    }
    let mut ready: Vec<usize> = incoming
        .iter()
        .enumerate()
        .filter_map(|(i, n)| (*n == 0).then_some(i))
        .collect();
    let mut visited = 0;
    while let Some(index) = ready.pop() {
        visited += 1;
        for (other, candidate) in unique.iter().enumerate() {
            if candidate.dot != unique[index].dot && unique[index].observes(candidate) {
                incoming[other] -= 1;
                if incoming[other] == 0 {
                    ready.push(other);
                }
            }
        }
    }
    if visited != unique.len() {
        return Err("Cyclic causal history".into());
    }
    let result: Vec<_> = unique
        .iter()
        .copied()
        .filter(|candidate| {
            !unique
                .iter()
                .any(|other| other.dot != candidate.dot && other.observes(candidate))
        })
        .collect();
    if !unique.is_empty() && result.is_empty() {
        return Err("Cyclic causal history".into());
    }
    Ok(result)
}

pub fn winner<'a>(
    revisions: &'a [Revision],
    retired: bool,
) -> Result<Option<&'a Revision>, String> {
    if retired {
        return Ok(None);
    }
    Ok(frontier(revisions)?
        .into_iter()
        .max_by_key(|r| (r.deleted, r.clock, &r.dot.origin, r.dot.sequence)))
}

#[derive(Default, Debug, Serialize, Deserialize)]
pub struct Receipt {
    pub contiguous: u64,
    pub gaps: BTreeSet<u64>,
}

impl Receipt {
    /// Invoke only after the header, verified body or purge proof is durably committed.
    pub fn accept(&mut self, sequence: u64) -> Result<(), String> {
        if sequence == 0 {
            return Err("Sequence zero is invalid".into());
        }
        if sequence <= self.contiguous {
            return Ok(());
        }
        self.gaps.insert(sequence);
        while let Some(next) = self.contiguous.checked_add(1) {
            if !self.gaps.remove(&next) {
                break;
            }
            self.contiguous = next;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn r(
        origin: &str,
        sequence: u64,
        time: u64,
        deleted: bool,
        context: &[(&str, u64)],
    ) -> Revision {
        Revision {
            entity_id: "thought".into(),
            dot: Dot {
                origin: origin.into(),
                sequence,
            },
            context: context.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
            clock: Clock {
                wall: time,
                logical: 0,
            },
            deleted,
            payload_hash: format!("{origin}-{sequence}"),
        }
    }
    #[test]
    fn three_device_frontier_is_order_independent() {
        // A observes C; B is concurrent. Pairwise LWW/causal comparators are not transitive here.
        let a = r("a", 1, 1, false, &[("c", 1)]);
        let b = r("b", 1, 2, false, &[]);
        let c = r("c", 1, 3, false, &[]);
        for permutation in [
            [a.clone(), b.clone(), c.clone()],
            [c.clone(), a.clone(), b.clone()],
            [b.clone(), c.clone(), a.clone()],
            [a.clone(), c.clone(), b.clone()],
            [b.clone(), a.clone(), c.clone()],
            [c.clone(), b.clone(), a.clone()],
        ] {
            assert_eq!(
                winner(&permutation, false).unwrap().unwrap().dot.origin,
                "b"
            );
        }
    }
    #[test]
    fn deletion_beats_concurrent_newer_edit() {
        let revisions = [r("a", 1, 1, true, &[]), r("b", 1, 999, false, &[])];
        assert!(winner(&revisions, false).unwrap().unwrap().deleted);
        assert!(winner(&revisions, true).unwrap().is_none());
    }
    #[test]
    fn causal_successor_beats_concurrent_timestamp_and_duplicate_is_idempotent() {
        let first = r("a", 1, 999, false, &[]);
        let next = r("b", 1, 1, false, &[("a", 1)]);
        let revisions = [first.clone(), next, first];
        assert_eq!(winner(&revisions, false).unwrap().unwrap().dot.origin, "b");
    }
    #[test]
    fn equivocation_is_not_first_arrival_wins() {
        assert!(winner(&[r("a", 1, 1, false, &[]), r("a", 1, 2, false, &[])], false).is_err());
    }
    #[test]
    fn cycles_are_rejected_even_with_an_unrelated_valid_frontier() {
        let revisions = [
            r("a", 1, 1, false, &[("b", 1)]),
            r("b", 1, 2, false, &[("c", 1)]),
            r("c", 1, 3, false, &[("a", 1)]),
            r("d", 1, 4, false, &[]),
        ];
        assert!(winner(&revisions, false).unwrap_err().contains("Cyclic"));
    }
    #[test]
    fn receipts_do_not_skip_gaps() {
        let mut receipt = Receipt::default();
        receipt.accept(3).unwrap();
        assert_eq!(receipt.contiguous, 0);
        receipt.accept(1).unwrap();
        assert_eq!(receipt.contiguous, 1);
        receipt.accept(2).unwrap();
        assert_eq!(receipt.contiguous, 3);
        receipt.accept(2).unwrap();
        assert_eq!(receipt.contiguous, 3);
    }
    #[test]
    fn clock_survives_backward_wall_time() {
        let clock = Clock {
            wall: 100,
            logical: 5,
        };
        assert_eq!(
            clock.tick(1, None).unwrap(),
            Clock {
                wall: 100,
                logical: 6
            }
        );
    }
}
