//! Stake-weighted proposer rotation, design §3.3, integer arithmetic only.
//!
//! Invariants:
//! * entries are in key order and weights are positive;
//! * `total == Σ weight < 2^100` ([`crate::types::MAX_TOTAL_WEIGHT`]);
//! * with a fixed set, `Σ priority` is unchanged by [`Schedule::step`]
//!   (each step adds `W` and subtracts `W`), so after `N` steps from zero
//!   `priority_i = N·w_i − count_i·W`: the priority *is* the fairness error (P6).

use crate::mutation::{self, Mutation};
use crate::types::{floor_div, signed_mul_div_floor, Hasher, KeyId, ValidatorSet, Weight, MAX_TOTAL_WEIGHT};

/// One validator's schedule entry.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Entry {
    /// Consensus key.
    pub key: KeyId,
    /// Weight `w_i` (whole XRGE).
    pub weight: Weight,
    /// Signed priority `P_i`.
    pub priority: i128,
}

/// Why a schedule operation failed. Any of these makes the block that caused it invalid (§3.3).
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ScheduleError {
    /// No validators: there is no proposer.
    EmptySet,
    /// Checked arithmetic overflowed (cannot happen while `W < 2^100`; kept as a hard error).
    Overflow,
    /// `W ≥ 2^100`.
    TotalTooLarge,
}

/// The stored proposer priorities (consensus state).
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Schedule {
    entries: Vec<Entry>,
    total: Weight,
    /// Mutation-only round-robin cursor; unused by the real rule.
    rr_cursor: usize,
}

impl Schedule {
    /// A schedule with all priorities zero: the state at the activation height (§3.3, §8.2).
    pub fn new(set: &ValidatorSet) -> Schedule {
        Schedule {
            entries: set.members().iter().map(|(key, weight)| Entry { key: *key, weight: *weight, priority: 0 }).collect(),
            total: set.total(),
            rr_cursor: 0,
        }
    }

    /// Entries in key order.
    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    /// Total weight `W`.
    pub fn total(&self) -> Weight {
        self.total
    }

    /// One step of §3.3: add each weight, pick the greatest priority (ties to
    /// the lowest key), subtract `W` from the winner, return it.
    pub fn step(&mut self) -> Result<KeyId, ScheduleError> {
        if self.entries.is_empty() {
            return Err(ScheduleError::EmptySet);
        }
        if self.total >= MAX_TOTAL_WEIGHT {
            return Err(ScheduleError::TotalTooLarge);
        }
        if mutation::active(Mutation::ScheduleNotStakeWeighted) {
            let i = self.rr_cursor % self.entries.len();
            self.rr_cursor = i + 1;
            return Ok(self.entries[i].key);
        }
        let mut best = 0usize;
        for i in 0..self.entries.len() {
            let w = i128::try_from(self.entries[i].weight).map_err(|_| ScheduleError::Overflow)?;
            self.entries[i].priority = self.entries[i].priority.checked_add(w).ok_or(ScheduleError::Overflow)?;
            // Strict `>` keeps the earliest (lowest-key) entry on ties.
            if self.entries[i].priority > self.entries[best].priority {
                best = i;
            }
        }
        let total = i128::try_from(self.total).map_err(|_| ScheduleError::Overflow)?;
        self.entries[best].priority = self.entries[best].priority.checked_sub(total).ok_or(ScheduleError::Overflow)?;
        Ok(self.entries[best].key)
    }

    /// Apply a change of the active set or of a weight (§3.3 "on any change …
    /// before the next step"). A no-op when nothing changed, so a fixed set is
    /// never rescaled or re-centred.
    ///
    /// Made explicit here (see RESULTS.md, rules R3–R5): `W` in the entry
    /// penalty and in the `2W` bound is the *new* total; a key that leaves and
    /// later returns is treated as new; survivors keep their priority.
    pub fn reweight(&mut self, set: &ValidatorSet) -> Result<(), ScheduleError> {
        let unchanged = self.entries.len() == set.len() && self.entries.iter().zip(set.members()).all(|(e, m)| e.key == m.0 && e.weight == m.1);
        if unchanged {
            return Ok(());
        }
        if set.total() >= MAX_TOTAL_WEIGHT {
            return Err(ScheduleError::TotalTooLarge);
        }
        let w_new = i128::try_from(set.total()).map_err(|_| ScheduleError::Overflow)?;
        let entry_priority = w_new.checked_add(w_new / 8).and_then(i128::checked_neg).ok_or(ScheduleError::Overflow)?;
        let mut next = Vec::with_capacity(set.len());
        for (key, weight) in set.members() {
            let priority = match self.entries.binary_search_by_key(key, |e| e.key) {
                Ok(i) => self.entries[i].priority,
                Err(_) => entry_priority,
            };
            next.push(Entry { key: *key, weight: *weight, priority });
        }
        self.entries = next;
        self.total = set.total();
        if self.entries.is_empty() {
            return Ok(());
        }
        // Rescale when the spread exceeds 2W.
        let max = self.entries.iter().map(|e| e.priority).max().unwrap_or(0);
        let min = self.entries.iter().map(|e| e.priority).min().unwrap_or(0);
        let spread = max.checked_sub(min).ok_or(ScheduleError::Overflow)?;
        let two_w = w_new.checked_mul(2).ok_or(ScheduleError::Overflow)?;
        if spread > two_w {
            for e in &mut self.entries {
                e.priority = signed_mul_div_floor(e.priority, two_w.unsigned_abs(), spread.unsigned_abs()).ok_or(ScheduleError::Overflow)?;
            }
        }
        // Centre on the floor of the mean.
        let mut sum: i128 = 0;
        for e in &self.entries {
            sum = sum.checked_add(e.priority).ok_or(ScheduleError::Overflow)?;
        }
        let n = i128::try_from(self.entries.len()).map_err(|_| ScheduleError::Overflow)?;
        let avg = floor_div(sum, n).ok_or(ScheduleError::Overflow)?;
        for e in &mut self.entries {
            e.priority = e.priority.checked_sub(avg).ok_or(ScheduleError::Overflow)?;
        }
        Ok(())
    }

    /// Stable digest of the priorities (part of the ledger state hash).
    pub fn digest(&self) -> u64 {
        let mut h = Hasher::new("schedule");
        for e in &self.entries {
            h.u64(u64::from(e.key.0)).u128(e.weight).i128(e.priority);
        }
        h.u64(self.rr_cursor as u64);
        h.finish64()
    }
}

/// The proposers of one height, round by round.
///
/// Built from the stored priorities *before* the height's step. Round 0 is one
/// step; round `r` is `r` further steps on a scratch copy, so failed rounds do
/// not alter the stored priorities (§3.3). Rounds are computed lazily and cached.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct RoundProposers {
    scratch: Schedule,
    known: Vec<KeyId>,
}

impl RoundProposers {
    /// `stored` is the consensus state after the previous block.
    pub fn new(stored: &Schedule) -> RoundProposers {
        RoundProposers { scratch: stored.clone(), known: Vec::new() }
    }
    /// Proposer of round `round`; `None` if the set is empty or arithmetic failed.
    pub fn get(&mut self, round: u32) -> Option<KeyId> {
        let want = usize::try_from(round).ok()?;
        while self.known.len() <= want {
            let p = self.scratch.step().ok()?;
            self.known.push(p);
        }
        self.known.get(want).copied()
    }
    /// Digest of the starting point (enough to identify the whole sequence).
    pub fn digest(&self) -> u64 {
        let mut h = Hasher::new("round-proposers");
        h.u64(self.scratch.digest()).u64(self.known.len() as u64);
        h.finish64()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(ws: &[u128]) -> ValidatorSet {
        ValidatorSet::new(ws.iter().enumerate().map(|(i, w)| (KeyId(i as u32), *w)).collect()).unwrap()
    }
    fn prios(s: &Schedule) -> Vec<i128> {
        s.entries().iter().map(|e| e.priority).collect()
    }

    /// P6, second half: the worked example of §3.3, every row, exactly.
    #[test]
    fn reproduces_the_50_30_20_table() {
        let (a, b, c) = (KeyId(0), KeyId(1), KeyId(2));
        let mut s = Schedule::new(&set(&[50, 30, 20]));
        let table: [(KeyId, [i128; 3]); 10] = [
            (a, [-50, 30, 20]),
            (b, [0, -40, 40]),
            (c, [50, -10, -40]),
            (a, [0, 20, -20]),
            (a, [-50, 50, 0]),
            (b, [0, -20, 20]),
            (a, [-50, 10, 40]),
            (c, [0, 40, -40]),
            (b, [50, -30, -20]),
            (a, [0, 0, 0]),
        ];
        for (height, (proposer, after)) in table.iter().enumerate() {
            assert_eq!(s.step().unwrap(), *proposer, "height {}", height + 1);
            assert_eq!(prios(&s), after.to_vec(), "priorities after height {}", height + 1);
        }
    }

    /// §3.3 text after the table: at height 4, rounds 0/1/2 are A, A, B, and
    /// the stored priorities are untouched by looking at later rounds.
    #[test]
    fn rounds_use_a_scratch_copy() {
        let mut s = Schedule::new(&set(&[50, 30, 20]));
        for _ in 0..3 {
            s.step().unwrap();
        }
        let before = s.clone();
        let mut rp = RoundProposers::new(&s);
        assert_eq!(rp.get(0), Some(KeyId(0)));
        assert_eq!(rp.get(1), Some(KeyId(0)));
        assert_eq!(rp.get(2), Some(KeyId(1)));
        assert_eq!(s, before);
    }

    #[test]
    fn first_proposer_at_activation_is_the_greatest_stake_lowest_key() {
        assert_eq!(Schedule::new(&set(&[10_000, 100_090_000, 9_000])).step().unwrap(), KeyId(1));
        assert_eq!(Schedule::new(&set(&[7, 7, 7])).step().unwrap(), KeyId(0));
    }

    #[test]
    fn newcomer_cannot_propose_immediately_and_priorities_stay_centred() {
        let mut s = Schedule::new(&set(&[50, 30, 20]));
        for _ in 0..4 {
            s.step().unwrap();
        }
        // A fourth validator joins with by far the largest weight.
        let grown = ValidatorSet::new(vec![(KeyId(0), 50), (KeyId(1), 30), (KeyId(2), 20), (KeyId(9), 500)]).unwrap();
        s.reweight(&grown).unwrap();
        let sum: i128 = prios(&s).iter().sum();
        assert!((0..4).contains(&sum), "centred on the floor of the mean, sum={sum}");
        let spread = prios(&s).iter().max().unwrap() - prios(&s).iter().min().unwrap();
        assert!(spread <= 2 * 600, "spread {spread} within 2W");
        assert_ne!(s.step().unwrap(), KeyId(9), "a new validator does not propose on entry");
        // unchanged set: reweight is the identity
        let snap = s.clone();
        s.reweight(&grown).unwrap();
        assert_eq!(s, snap);
    }

    #[test]
    fn total_weight_bound_is_enforced_and_large_weights_do_not_overflow() {
        let big = (MAX_TOTAL_WEIGHT - 1) / 3;
        let mut s = Schedule::new(&set(&[big, big, big]));
        for _ in 0..10_000 {
            s.step().unwrap();
        }
        let shrunk = ValidatorSet::new(vec![(KeyId(0), big), (KeyId(1), 1)]).unwrap();
        s.reweight(&shrunk).unwrap();
        s.step().unwrap();
    }

    #[test]
    fn empty_set_has_no_proposer() {
        let mut s = Schedule::new(&ValidatorSet::default());
        assert_eq!(s.step(), Err(ScheduleError::EmptySet));
        assert_eq!(RoundProposers::new(&s).get(0), None);
    }
}
