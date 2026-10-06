//! Coin selection for the 2-input / 2-output statement.
//!
//! A transaction spends one or two notes (a dummy fills the second slot) and creates the payment
//! and the change. A payment that needs more than two notes cannot be made in one transaction:
//! [`select_inputs`] then returns [`WalletError::NeedsMerge`], and [`plan_merge`] plans the
//! self-transfer that turns the two largest notes into one (it costs one fee).

use serde::Serialize;

use crate::error::WalletError;
use crate::store::{dec, OwnedNote, WalletState};

/// The notes to spend for one payment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Selection {
    /// Leaf positions of the one or two notes to spend.
    pub positions: Vec<u64>,
    /// Their total value, quanta.
    #[serde(with = "dec")]
    pub total: u64,
    /// `total − amount − fee`: comes back to the wallet as the change note.
    #[serde(with = "dec")]
    pub change: u64,
}

/// A self-merge: spend `positions` and send `amount` (their total minus the fee) to the wallet's
/// own address with `build_transfer`; the change is zero.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MergePlan {
    pub positions: Vec<u64>,
    #[serde(with = "dec")]
    pub amount: u64,
    #[serde(with = "dec")]
    pub fee: u64,
}

fn spendable(state: &WalletState) -> Vec<&OwnedNote> {
    let mut v: Vec<&OwnedNote> = state.unspent().filter(|n| n.value > 0 && state.tree().path(n.position).is_some()).collect();
    // ascending by value, then by position: deterministic
    v.sort_by_key(|n| (n.value, n.position));
    v
}

/// Chooses the notes for a payment of `amount` (the shielded payment of a transfer, or the
/// `v_out` of an unshield) with `fee`:
///
/// 1. the smallest single note that covers `amount + fee`;
/// 2. otherwise the pair with the smallest total that covers it;
/// 3. otherwise, if the wallet could cover it by merging notes first (each merge costs `fee`):
///    `Err(NeedsMerge { merges })`; if not even then: `Err(InsufficientFunds)`.
pub fn select_inputs(state: &WalletState, amount: u64, fee: u64) -> Result<Selection, WalletError> {
    let need = amount as u128 + fee as u128;
    let notes = spendable(state);
    let have: u128 = notes.iter().map(|n| n.value as u128).sum();
    let done = |picked: &[&OwnedNote]| -> Result<Selection, WalletError> {
        let total: u128 = picked.iter().map(|n| n.value as u128).sum();
        let total64 = u64::try_from(total).map_err(|_| WalletError::Request("the selected notes exceed 64 bits".into()))?;
        Ok(Selection { positions: picked.iter().map(|n| n.position).collect(), total: total64, change: (total - need) as u64 })
    };
    // 1
    if let Some(n) = notes.iter().find(|n| n.value as u128 >= need) {
        return done(&[n]);
    }
    // 2: two pointers over the ascending list
    let mut best: Option<(u128, usize, usize)> = None;
    if notes.len() >= 2 {
        let (mut lo, mut hi) = (0usize, notes.len() - 1);
        while lo < hi {
            let sum = notes[lo].value as u128 + notes[hi].value as u128;
            if sum >= need {
                if best.is_none_or(|b| sum < b.0) {
                    best = Some((sum, lo, hi));
                }
                hi -= 1;
            } else {
                lo += 1;
            }
        }
    }
    if let Some((sum, lo, hi)) = best {
        if sum <= u64::MAX as u128 {
            return done(&[notes[lo], notes[hi]]);
        }
    }
    // 3: the k largest notes, merged with k − 2 self-transfers, must cover need + (k − 2)·fee
    let mut sum = 0u128;
    for (k, n) in notes.iter().rev().enumerate() {
        sum += n.value as u128;
        let k = k + 1;
        if k >= 3 && sum >= need + (k as u128 - 2) * fee as u128 {
            return Err(WalletError::NeedsMerge { merges: k - 2 });
        }
    }
    Err(WalletError::InsufficientFunds { have, need })
}

/// Plans one self-merge of the two largest spendable notes. Needs two notes whose total exceeds
/// the fee.
pub fn plan_merge(state: &WalletState, fee: u64) -> Result<MergePlan, WalletError> {
    let notes = spendable(state);
    if notes.len() < 2 {
        return Err(WalletError::Request("a merge needs at least two unspent notes".into()));
    }
    let (a, b) = (notes[notes.len() - 1], notes[notes.len() - 2]);
    let total = a.value as u128 + b.value as u128;
    if total <= fee as u128 {
        return Err(WalletError::InsufficientFunds { have: total, need: fee as u128 + 1 });
    }
    let amount = u64::try_from(total - fee as u128).map_err(|_| WalletError::Request("the merged note exceeds 64 bits".into()))?;
    Ok(MergePlan { positions: vec![a.position, b.position], amount, fee })
}
