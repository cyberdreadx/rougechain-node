//! Deterministic validator-set provenance (Track A Step 2.3).
//!
//! `validator_sets_v2` snapshots are derived state and are NOT committed by the block state
//! root. This module re-derives the eligible validator set applicable to any height from
//! ACCEPTED HISTORY ONLY (blocks + stake/unstake receipts), starting from a pinned base, so a
//! stored snapshot can be compared byte-for-byte with what history says it must be.
//!
//! It mirrors the node's validator state machine exactly (R1/F49 semantics):
//!   per tx, in block order:
//!     stake   + receipt Success → stake += payload.amount
//!     unstake + receipt Success → stake  = stake.saturating_sub(payload.amount)
//!     slash   (always)          → stake -= max(stake/10, 1); slash_count += 1;
//!                                 jailed_until = max(jailed_until, height + 20)
//!     after a stake/unstake/slash write: an all-zero validator record is DELETED
//!   then, per block: proposer (stake > 0) resets missed_blocks; every other non-jailed staked
//!     validator gets missed_blocks += 1 and at 50 is auto-slashed (stake/10, min 1) and jailed
//!     until height + 20.
//!   eligible for height H  ⇔  after block H-1: stake > 0 and jailed_until <= H-1.
use crate::ValidatorSetSnapshot;
use quantum_vault_types::BlockV1;
use std::collections::BTreeMap;

pub const JAIL_BLOCKS: u64 = 20;
pub const SLASH_DIVISOR: u128 = 10;
pub const MISSED_BLOCK_SLASH_THRESHOLD: u64 = 50;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct VState { pub stake: u128, pub slash_count: u32, pub jailed_until: u64, pub missed_blocks: u64 }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplayError {
    /// blocks must be applied contiguously
    NonContiguous { expected: u64, got: u64 },
    /// the authoritative outcome of a stake/unstake is not available ⇒ fail closed
    OutcomeUnavailable { height: u64, tx_index: usize },
    HistoryUnavailable(String),
    TargetBelowBase { base: u64, target: u64 },
}

/// Authoritative execution outcome of a stake/unstake tx: `Some(true)` Success, `Some(false)`
/// Failed, `None` unknown.
pub type OutcomeFn<'a> = &'a dyn Fn(u64, usize, &quantum_vault_types::TxV1) -> Option<bool>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatorReplay { height: u64, vals: BTreeMap<String, VState> }

impl ValidatorReplay {
    /// `base_height` = the height whose POST-state `entries` describe (0 = genesis).
    pub fn new(base_height: u64, entries: impl IntoIterator<Item = (String, VState)>) -> Self { Self { height: base_height, vals: entries.into_iter().collect() } }
    pub fn height(&self) -> u64 { self.height }
    pub fn state(&self) -> &BTreeMap<String, VState> { &self.vals }

    fn persist(&mut self, key: &str, st: VState, height: u64) {
        if st.stake > 0 || st.slash_count > 0 || st.jailed_until > height { self.vals.insert(key.to_string(), st); } else { self.vals.remove(key); }
    }

    pub fn apply_block(&mut self, block: &BlockV1, outcome: OutcomeFn) -> Result<(), ReplayError> {
        let h = block.header.height;
        if h != self.height + 1 { return Err(ReplayError::NonContiguous { expected: self.height + 1, got: h }); }
        for (i, tx) in block.txs.iter().enumerate() {
            match tx.tx_type.as_str() {
                "stake" | "unstake" => {
                    let ok = outcome(h, i, tx).ok_or(ReplayError::OutcomeUnavailable { height: h, tx_index: i })?;
                    if !ok { continue; }
                    let amount = tx.payload.amount.unwrap_or(0) as u128;
                    if tx.tx_type == "stake" {
                        let mut st = self.vals.get(&tx.from_pub_key).copied().unwrap_or_default();
                        st.stake += amount; self.persist(&tx.from_pub_key, st, h);
                    } else if let Some(mut st) = self.vals.get(&tx.from_pub_key).copied() {
                        st.stake = st.stake.saturating_sub(amount); self.persist(&tx.from_pub_key, st, h);
                    }
                }
                "slash" => {
                    let target = tx.payload.target_pub_key.clone().unwrap_or_default();
                    let mut st = self.vals.get(&target).copied().unwrap_or_default();
                    let cut = (st.stake / SLASH_DIVISOR).max(1);
                    st.stake = st.stake.saturating_sub(cut); st.slash_count += 1; st.jailed_until = st.jailed_until.max(h + JAIL_BLOCKS);
                    self.persist(&target, st, h);
                }
                _ => {}
            }
        }
        let proposer = &block.header.proposer_pub_key;
        for (k, st) in self.vals.iter_mut() {
            if st.stake == 0 { continue; }
            if k == proposer { st.missed_blocks = 0; }
            else if st.jailed_until <= h {
                st.missed_blocks += 1;
                if st.missed_blocks >= MISSED_BLOCK_SLASH_THRESHOLD {
                    let cut = (st.stake / SLASH_DIVISOR).max(1);
                    st.stake = st.stake.saturating_sub(cut); st.slash_count += 1; st.jailed_until = h + JAIL_BLOCKS; st.missed_blocks = 0;
                }
            }
        }
        self.height = h;
        Ok(())
    }

    /// The eligible set applicable to height `self.height + 1`.
    pub fn snapshot_for_next(&self) -> ValidatorSetSnapshot {
        ValidatorSetSnapshot::new(self.height + 1, self.vals.iter().filter(|(_, s)| s.stake > 0 && s.jailed_until <= self.height).map(|(k, s)| (k.clone(), s.stake)))
    }

    /// Advance to `target_height - 1` and return the set applicable to `target_height`.
    pub fn derive_for(&mut self, target_height: u64, block: &dyn Fn(u64) -> Result<Option<BlockV1>, String>, outcome: OutcomeFn) -> Result<ValidatorSetSnapshot, ReplayError> {
        if target_height == 0 || target_height - 1 < self.height { return Err(ReplayError::TargetBelowBase { base: self.height, target: target_height }); }
        while self.height < target_height - 1 {
            let h = self.height + 1;
            let b = block(h).map_err(ReplayError::HistoryUnavailable)?.ok_or_else(|| ReplayError::HistoryUnavailable(format!("block {h} missing")))?;
            self.apply_block(&b, outcome)?;
        }
        Ok(self.snapshot_for_next())
    }
}
