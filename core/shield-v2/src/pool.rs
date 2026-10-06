//! The pool's consensus state and rules — spec §4 — as pure logic. No daemon types, no I/O, no
//! floating point; storage is behind [`PoolStore`]. **Not wired into block processing.**
//!
//! # What this module is given, and what it checks
//!
//! A [`PoolTx`] is a V2 transaction that has ALREADY passed the checks of spec §3.6 that need
//! neither the pool's state nor this module: envelope, lengths, hexadecimal, body version, kind,
//! chain id, expiry, minimum fee, `account`, the account signature, the funding balance
//! (checks 1–7, 11, 12, 14, 19) and the proof (check 20, [`crate::verify_spend`]). This module
//! does not and cannot make those checks.
//!
//! It makes every check that concerns the pool, in the order of spec §3.6, against the state as
//! it is after the preceding transactions of the same block:
//!
//! | §3.6 | Rule | Refusal |
//! |---|---|---|
//! | 8 | the five digests are canonical; `cm_out1`, `cm_out2` are not the all-zero digest | [`TxRefusal::NonCanonicalDigest`], [`TxRefusal::ZeroCommitment`] |
//! | 9 | `nf1 ≠ nf2` (§4.2 rule 2a) | [`TxRefusal::EqualNullifiers`] |
//! | 10 | the amount pattern of the type | [`TxRefusal::AmountPattern`] |
//! | 13 | at most [`SHIELD_V2_MAX_TX_PER_BLOCK`] per block (§4.7) | [`PoolError::TooManyTransactions`] |
//! | 15 | `anchor` is in the anchor window of the block (§4.3) | [`TxRefusal::AnchorNotInWindow`] |
//! | 16 | neither nullifier is in the set or earlier in the block (§4.2 rules 2b, 2c) | [`TxRefusal::NullifierSpent`], [`TxRefusal::NullifierRepeatedInBlock`] |
//! | 17 | `note_count + 2 ≤ 2^32` | [`TxRefusal::TreeFull`] |
//! | 18 | pool accounting and the cap (§4.4) | [`TxRefusal::PoolCapExceeded`], [`TxRefusal::PoolUnderflow`] |
//!
//! Checks 8–10 are repeated here on purpose although a caller will have made them: the pool's
//! invariants (no leaf equal to the empty leaf, two distinct nullifiers per transaction, a pool
//! total that matches the type) must not depend on the caller.
//!
//! # All or nothing (spec §4.2 rule 4, §4.5, §4.6)
//!
//! [`Pool::validate_block`] evaluates a block's V2 transactions in order on a private copy of the
//! state and touches nothing. If any transaction is refused the whole block is refused and there
//! is nothing to undo. Only a fully valid block yields a [`PreparedBlock`], which
//! [`Pool::commit`] hands to the store as ONE [`PoolUpdate`] — nullifiers, leaves and the new
//! state together. [`Pool::apply_block`] is the two in sequence.
//!
//! The block MUST be offered for every height from the activation height on, in order, including
//! blocks with no V2 transaction (an empty slice): the anchor window advances with every block
//! (§4.5, last paragraph).
//!
//! # Refusal kinds are not consensus
//!
//! As for the verifier (spec §4.6): consensus is "the block is valid" / "the block is invalid".
//! [`PoolError`] and [`TxRefusal`] say why, for logs and tests. Do not put them in consensus data.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use sha2::{Digest as _, Sha256};

use crate::layout::TREE_DEPTH;
use crate::reference::{Digest, ZERO_DIGEST, digest_from_bytes, digest_to_bytes, merge};

/// 32 bytes of public data: a digest in the encoding of spec §2.8, or a SHA-256 output.
pub type Bytes32 = [u8; 32];

/// 1 XRGE = 10^9 quanta (spec §1.5).
pub const QUANTA_PER_XRGE: u128 = 1_000_000_000;

/// Spec §4.4: 1,000,000 XRGE = 10^15 quanta. A compiled consensus constant; changing it is a fork.
pub const SHIELD_V2_POOL_CAP_QUANTA: u128 = 1_000_000 * QUANTA_PER_XRGE;

/// Spec §4.3 rule 5 **[P]**: the number of roots a transaction may name.
pub const SHIELD_V2_ANCHOR_WINDOW: usize = 128;

/// Spec §4.7 **[P]**: V2 transactions per block, the three types counted together.
pub const SHIELD_V2_MAX_TX_PER_BLOCK: usize = 8;

/// Spec §3.5 / §9.1 O-6 **[P]**, recommended value. Declared here so that the constant has one
/// home; it is NOT enforced by this module (check 11 of §3.6 is a stateless check).
pub const SHIELD_V2_MIN_FEE_QUANTA: u64 = 1_000_000_000;

/// Leaves of the commitment tree: 2^32 (spec §2.6).
pub const SHIELD_V2_MAX_NOTES: u64 = 1 << TREE_DEPTH;

/// Spec §4.5 step 1.
const NULLIFIER_ACC_TAG: &[u8] = b"rougechain.shield_v2.nullifier_acc.v1";

/// Spec §4.8.
const STATE_ROOT_TAG: &[u8] = b"rougechain.stateroot.shield_v2.v1";

// ---- transactions ---------------------------------------------------------------------------------

/// The three V2 transaction types (spec §3; the `kind` byte of the body is 1, 2, 3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TxKind {
    Shield,
    Transfer,
    Unshield,
}

/// The fields of a V2 transaction body (spec §3.2) that the pool's rules read, as the bytes of
/// the body. See the module documentation for what must have been checked before.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolTx {
    pub kind: TxKind,
    pub anchor: Bytes32,
    /// `nf1`, `nf2`.
    pub nf: [Bytes32; 2],
    /// `cm_out1`, `cm_out2`.
    pub cm_out: [Bytes32; 2],
    pub v_in: u64,
    pub v_out: u64,
    pub fee: u64,
    /// Spec §3.3. Not interpreted here; copied into the transaction's [`TxEffect`].
    pub account: Bytes32,
}

/// What the rest of the block state transition must do for one accepted transaction (spec §4.4,
/// §4.5 steps 3 and 4). The pool holds no public balances; the caller applies these in the same
/// atomic step as the pool update.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TxEffect {
    pub kind: TxKind,
    /// The `account` field of the body.
    pub account: Bytes32,
    /// `shield_v2`: `v_in`, debited from the funding account. Otherwise 0.
    pub account_debit: u64,
    /// `unshield_v2`: `v_out`, credited to the `account` address. Otherwise 0.
    pub account_credit: u64,
    /// Added to the block's fee collection, for all three types.
    pub fee: u64,
}

// ---- state (spec §4.1) -----------------------------------------------------------------------------

/// The pool's consensus state other than the nullifier set and the leaves themselves: exactly
/// what the state-root section of spec §4.8 commits. Digests are in the byte encoding of §2.8.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolState {
    /// Quanta held by the pool.
    pub pool_total: u128,
    /// Number of leaves.
    pub note_count: u64,
    pub tree_root: Bytes32,
    /// `frontier[l]`: if bit `l` of `note_count` is 1, the root of the complete height-`l`
    /// subtree waiting for its right sibling; otherwise 32 zero bytes (spec §4.8).
    pub frontier: [Bytes32; TREE_DEPTH],
    pub nullifier_count: u64,
    /// Running hash over every inserted nullifier in insertion order (spec §4.5 step 1).
    pub nullifier_acc: Bytes32,
    /// The anchor window, oldest first; at most [`SHIELD_V2_ANCHOR_WINDOW`] entries.
    pub window: Vec<Bytes32>,
}

impl PoolState {
    /// The state at the activation height, before its block is applied (spec §4.1).
    pub fn genesis() -> Self {
        let e32 = empty_tree_root();
        Self {
            pool_total: 0,
            note_count: 0,
            tree_root: e32,
            frontier: [[0u8; 32]; TREE_DEPTH],
            nullifier_count: 0,
            nullifier_acc: [0u8; 32],
            window: vec![e32],
        }
    }

    /// The state-root section of spec §4.8: `root_after` from `root_before` (the root after every
    /// extension the node already applies at that height) and this state, which must be the
    /// state AFTER the block. `root_before` must be 64 lowercase hexadecimal characters.
    pub fn state_root_section(&self, root_before: &str) -> Result<String, PoolError> {
        let rb = root_before.as_bytes();
        if rb.len() != 64 || !rb.iter().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            return Err(PoolError::BadPreviousRoot);
        }
        if self.window.len() > SHIELD_V2_ANCHOR_WINDOW {
            return Err(PoolError::CorruptState("anchor window longer than 128"));
        }
        let mut h = Sha256::new();
        h.update(STATE_ROOT_TAG);
        h.update((rb.len() as u64).to_be_bytes());
        h.update(rb);
        h.update(self.pool_total.to_be_bytes());
        h.update(self.note_count.to_be_bytes());
        h.update(self.tree_root);
        for f in &self.frontier {
            h.update(f);
        }
        h.update(self.nullifier_count.to_be_bytes());
        h.update(self.nullifier_acc);
        h.update((self.window.len() as u64).to_be_bytes());
        for w in &self.window {
            h.update(w);
        }
        Ok(to_hex(&h.finalize()))
    }
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 15) as usize] as char);
    }
    s
}

/// Spec §4.5 step 1: `SHA-256(tag ‖ acc ‖ nf)`.
fn nullifier_acc_step(acc: &Bytes32, nf: &Bytes32) -> Bytes32 {
    let mut h = Sha256::new();
    h.update(NULLIFIER_ACC_TAG);
    h.update(acc);
    h.update(nf);
    h.finalize().into()
}

// ---- the commitment tree (spec §2.6, §4.3) ----------------------------------------------------------

/// `E_0 … E_32`: the roots of the empty subtrees.
fn empty_subtrees() -> &'static [Digest; TREE_DEPTH + 1] {
    static E: OnceLock<[Digest; TREE_DEPTH + 1]> = OnceLock::new();
    E.get_or_init(|| {
        let mut e = [ZERO_DIGEST; TREE_DEPTH + 1];
        for l in 0..TREE_DEPTH {
            e[l + 1] = merge(&e[l], &e[l]);
        }
        e
    })
}

/// `E_32`, the root of the empty tree (spec §8.2), in the byte encoding of §2.8.
pub fn empty_tree_root() -> Bytes32 {
    digest_to_bytes(&empty_subtrees()[TREE_DEPTH])
}

/// The append-only tree as a frontier, in field form.
struct Tree {
    frontier: [Digest; TREE_DEPTH],
    count: u64,
    root: Digest,
}

impl Tree {
    fn load(state: &PoolState) -> Result<Self, PoolError> {
        if state.note_count > SHIELD_V2_MAX_NOTES {
            return Err(PoolError::CorruptState("note_count above 2^32"));
        }
        let mut frontier = [ZERO_DIGEST; TREE_DEPTH];
        for (slot, bytes) in frontier.iter_mut().zip(&state.frontier) {
            *slot = digest_from_bytes(bytes).ok_or(PoolError::CorruptState("frontier entry is not a canonical digest"))?;
        }
        let root = digest_from_bytes(&state.tree_root).ok_or(PoolError::CorruptState("tree_root is not a canonical digest"))?;
        Ok(Self { frontier, count: state.note_count, root })
    }

    /// Writes `leaf` at position `count`. The caller has checked that there is room.
    fn append(&mut self, leaf: Digest) {
        let mut node = leaf;
        let mut carried_out = true;
        for l in 0..TREE_DEPTH {
            if (self.count >> l) & 1 == 0 {
                // `node` is a complete left subtree of height l, now waiting for its right sibling
                self.frontier[l] = node;
                carried_out = false;
                break;
            }
            // the left sibling was waiting: join, clear its slot (bit l becomes 0), carry upward
            node = merge(&self.frontier[l], &node);
            self.frontier[l] = ZERO_DIGEST;
        }
        self.count += 1;
        // `carried_out` only for the very last leaf (count is now 2^32): `node` is the root
        self.root = if carried_out { node } else { self.root_from_frontier() };
    }

    /// The root for `count < 2^32`: the path from the first empty leaf upward. At level l the
    /// running node is the subtree that contains that leaf; if bit l of `count` is 1 its left
    /// sibling is the waiting subtree `frontier[l]`, otherwise its right sibling is empty.
    fn root_from_frontier(&self) -> Digest {
        let e = empty_subtrees();
        let mut cur = e[0];
        for l in 0..TREE_DEPTH {
            cur = if (self.count >> l) & 1 == 1 { merge(&self.frontier[l], &cur) } else { merge(&cur, &e[l]) };
        }
        cur
    }
}

// ---- storage --------------------------------------------------------------------------------------

/// What a store holds besides the nullifier set and the leaves.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredPool {
    /// `A`, the height the pool was initialised for. Node-local bookkeeping (not in the state root).
    pub activation_height: u64,
    /// The height of the next block to apply. Node-local bookkeeping (not in the state root).
    pub next_height: u64,
    pub state: PoolState,
}

/// Everything one block changes, to be written atomically.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolUpdate {
    pub activation_height: u64,
    /// The height after the applied block (`applied height + 1`).
    pub next_height: u64,
    /// The state after the block.
    pub state: PoolState,
    /// The nullifiers the block inserts, in insertion order (transaction order, `nf1` then `nf2`).
    /// The order is consensus data: `nullifier_acc` commits to it (spec §4.8, open issue O-12).
    pub nullifiers: Vec<Bytes32>,
    /// Position of the first new leaf (= `note_count` before the block).
    pub first_leaf: u64,
    /// The leaves the block appends, in order (`cm_out1` then `cm_out2` per transaction).
    pub leaves: Vec<Bytes32>,
}

/// A storage failure. Text for logs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoreError(pub String);

/// The storage the pool needs. Deliberately small. The persistent backend is not written yet.
///
/// Requirements on an implementation:
/// * [`PoolStore::commit`] is atomic: after it returns `Ok` everything in the update is stored;
///   after it returns `Err` nothing of it is;
/// * a nullifier, once stored, is never removed (spec §4.2 rule 3) — except by restoring the
///   whole store to a state before the block that inserted it (a rolled-back block, rule 5);
/// * nullifiers are kept in insertion order as well as for lookup, and leaves by position.
pub trait PoolStore {
    /// `None` until the pool has been initialised.
    fn load(&self) -> Result<Option<StoredPool>, StoreError>;
    fn contains_nullifier(&self, nf: &Bytes32) -> Result<bool, StoreError>;
    fn commit(&mut self, update: &PoolUpdate) -> Result<(), StoreError>;
}

/// The in-memory store, for tests. `Clone` gives a snapshot; `==` compares everything.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MemoryPoolStore {
    stored: Option<StoredPool>,
    nullifier_set: HashSet<Bytes32>,
    nullifier_log: Vec<Bytes32>,
    leaves: HashMap<u64, Bytes32>,
}

impl MemoryPoolStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// A store that claims `stored` without holding the nullifiers and leaves behind it. For
    /// tests that need a state no test can reach by applying blocks (a nearly full tree).
    pub fn with_state(stored: StoredPool) -> Self {
        Self { stored: Some(stored), ..Self::default() }
    }

    /// Every nullifier, in insertion order.
    pub fn nullifiers(&self) -> &[Bytes32] {
        &self.nullifier_log
    }

    pub fn leaf(&self, position: u64) -> Option<Bytes32> {
        self.leaves.get(&position).copied()
    }

    pub fn leaf_count(&self) -> usize {
        self.leaves.len()
    }
}

impl PoolStore for MemoryPoolStore {
    fn load(&self) -> Result<Option<StoredPool>, StoreError> {
        Ok(self.stored.clone())
    }

    fn contains_nullifier(&self, nf: &Bytes32) -> Result<bool, StoreError> {
        Ok(self.nullifier_set.contains(nf))
    }

    fn commit(&mut self, update: &PoolUpdate) -> Result<(), StoreError> {
        // every check first, every write after: an `Err` leaves the store untouched
        let mut seen = HashSet::new();
        for nf in &update.nullifiers {
            if self.nullifier_set.contains(nf) || !seen.insert(*nf) {
                return Err(StoreError("nullifier already stored".into()));
            }
        }
        for i in 0..update.leaves.len() as u64 {
            let pos = update.first_leaf.checked_add(i).ok_or_else(|| StoreError("leaf position overflow".into()))?;
            if self.leaves.contains_key(&pos) {
                return Err(StoreError("leaf position already written".into()));
            }
        }
        for nf in &update.nullifiers {
            self.nullifier_set.insert(*nf);
            self.nullifier_log.push(*nf);
        }
        for (i, leaf) in update.leaves.iter().enumerate() {
            self.leaves.insert(update.first_leaf + i as u64, *leaf);
        }
        self.stored = Some(StoredPool {
            activation_height: update.activation_height,
            next_height: update.next_height,
            state: update.state.clone(),
        });
        Ok(())
    }
}

// ---- errors ---------------------------------------------------------------------------------------

/// Why one transaction was refused. For logs and tests; not consensus data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TxRefusal {
    /// `anchor`, `nf1`, `nf2`, `cm_out1` or `cm_out2` has a 4-byte word ≥ p (§3.6 check 8).
    NonCanonicalDigest(&'static str),
    /// `cm_out1` or `cm_out2` is the all-zero digest, i.e. the empty leaf (§3.6 check 8).
    ZeroCommitment,
    /// `nf1 = nf2` (§4.2 rule 2a).
    EqualNullifiers,
    /// The public amounts do not fit the type (§3.6 check 10).
    AmountPattern,
    /// `anchor` is not a root after one of the last 128 blocks before this one (§4.3 rule 5).
    AnchorNotInWindow,
    /// A nullifier is already in the nullifier set (§4.2 rule 2b).
    NullifierSpent,
    /// A nullifier equals one of an earlier transaction of the same block (§4.2 rule 2c).
    NullifierRepeatedInBlock,
    /// `note_count + 2 > 2^32` (§3.6 check 17).
    TreeFull,
    /// A shield would take the pool total above the cap (§4.4).
    PoolCapExceeded,
    /// A transfer or unshield would take the pool total below zero (§4.4).
    PoolUnderflow,
}

/// Why a block was refused, or why the pool could not be used. For logs and tests; the only
/// consensus-relevant fact about a block is whether it yields `Ok`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PoolError {
    /// The store holds no pool; [`Pool::open_or_init`] has not run.
    NotInitialised,
    /// The store was initialised for another activation height.
    ActivationMismatch { stored: u64, requested: u64 },
    /// Blocks must be applied in order, every height from the activation height on.
    HeightOutOfOrder { expected: u64, got: u64 },
    /// More than [`SHIELD_V2_MAX_TX_PER_BLOCK`] V2 transactions (§4.7).
    TooManyTransactions { count: usize, max: usize },
    /// Transaction `index` (0-based, among the block's V2 transactions) was refused.
    Tx { index: usize, reason: TxRefusal },
    /// A [`PreparedBlock`] was made against a state that is no longer the stored one.
    StalePreparation,
    /// `root_before` is not 64 lowercase hexadecimal characters.
    BadPreviousRoot,
    /// The stored state violates an invariant (not reachable through this module).
    CorruptState(&'static str),
    Store(StoreError),
}

impl From<StoreError> for PoolError {
    fn from(e: StoreError) -> Self {
        PoolError::Store(e)
    }
}

// ---- the pool -------------------------------------------------------------------------------------

/// What one valid block does. Returned by [`PreparedBlock::effects`] and by [`Pool::commit`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockEffects {
    pub height: u64,
    /// One entry per transaction, in block order.
    pub txs: Vec<TxEffect>,
    /// Sum of the fees, to add to the block's fee collection.
    pub fee_total: u128,
}

/// A block that passed every rule of this module, not yet stored. Nothing has been changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedBlock {
    base: StoredPool,
    update: PoolUpdate,
    effects: BlockEffects,
}

impl PreparedBlock {
    /// The pool state after the block.
    pub fn state_after(&self) -> &PoolState {
        &self.update.state
    }

    pub fn effects(&self) -> &BlockEffects {
        &self.effects
    }

    /// The header state-root section this block must carry (spec §4.8), so that a caller can
    /// compare it with the header BEFORE committing.
    pub fn state_root_section(&self, root_before: &str) -> Result<String, PoolError> {
        self.update.state.state_root_section(root_before)
    }
}

/// The pool over a store.
pub struct Pool<S: PoolStore> {
    store: S,
}

impl<S: PoolStore> Pool<S> {
    /// Opens the pool; if the store is empty, writes the initial state of spec §4.1 for
    /// activation height `activation_height` (the first block to apply is that height).
    pub fn open_or_init(mut store: S, activation_height: u64) -> Result<Self, PoolError> {
        match store.load()? {
            Some(s) if s.activation_height != activation_height => {
                Err(PoolError::ActivationMismatch { stored: s.activation_height, requested: activation_height })
            }
            Some(_) => Ok(Self { store }),
            None => {
                store.commit(&PoolUpdate {
                    activation_height,
                    next_height: activation_height,
                    state: PoolState::genesis(),
                    nullifiers: Vec::new(),
                    first_leaf: 0,
                    leaves: Vec::new(),
                })?;
                Ok(Self { store })
            }
        }
    }

    pub fn store(&self) -> &S {
        &self.store
    }

    pub fn into_store(self) -> S {
        self.store
    }

    fn stored(&self) -> Result<StoredPool, PoolError> {
        self.store.load()?.ok_or(PoolError::NotInitialised)
    }

    /// The current consensus state (after the last applied block).
    pub fn state(&self) -> Result<PoolState, PoolError> {
        Ok(self.stored()?.state)
    }

    /// The height of the next block to apply.
    pub fn next_height(&self) -> Result<u64, PoolError> {
        Ok(self.stored()?.next_height)
    }

    /// Spec §4.2: is `nf` in the nullifier set?
    pub fn is_spent(&self, nf: &Bytes32) -> Result<bool, PoolError> {
        Ok(self.store.contains_nullifier(nf)?)
    }

    /// Evaluates the V2 transactions of block `height`, in order, against the stored state.
    /// Changes nothing. `Err` means the block is invalid as a whole (spec §4.6).
    pub fn validate_block(&self, height: u64, txs: &[PoolTx]) -> Result<PreparedBlock, PoolError> {
        let base = self.stored()?;
        if height != base.next_height {
            return Err(PoolError::HeightOutOfOrder { expected: base.next_height, got: height });
        }
        // §4.7 (§3.6 check 13)
        if txs.len() > SHIELD_V2_MAX_TX_PER_BLOCK {
            return Err(PoolError::TooManyTransactions { count: txs.len(), max: SHIELD_V2_MAX_TX_PER_BLOCK });
        }
        let s = &base.state;
        if s.window.is_empty() || s.window.len() > SHIELD_V2_ANCHOR_WINDOW {
            return Err(PoolError::CorruptState("anchor window is empty or longer than 128"));
        }
        let mut tree = Tree::load(s)?;
        let mut pool_total = s.pool_total;
        let mut nullifier_count = s.nullifier_count;
        let mut nullifier_acc = s.nullifier_acc;
        let mut nullifiers: Vec<Bytes32> = Vec::with_capacity(2 * txs.len());
        let mut leaves: Vec<Bytes32> = Vec::with_capacity(2 * txs.len());
        let mut effects = Vec::with_capacity(txs.len());
        let mut fee_total: u128 = 0;

        for (index, tx) in txs.iter().enumerate() {
            let refuse = |reason| PoolError::Tx { index, reason };

            // check 8: canonical digests; the output commitments are not the empty leaf
            let canon = |b: &Bytes32, name| digest_from_bytes(b).ok_or(refuse(TxRefusal::NonCanonicalDigest(name)));
            let _ = canon(&tx.anchor, "anchor")?;
            let _ = canon(&tx.nf[0], "nf1")?;
            let _ = canon(&tx.nf[1], "nf2")?;
            let cm = [canon(&tx.cm_out[0], "cm_out1")?, canon(&tx.cm_out[1], "cm_out2")?];
            if cm[0] == ZERO_DIGEST || cm[1] == ZERO_DIGEST {
                return Err(refuse(TxRefusal::ZeroCommitment));
            }
            // check 9
            if tx.nf[0] == tx.nf[1] {
                return Err(refuse(TxRefusal::EqualNullifiers));
            }
            // check 10
            let pattern_ok = match tx.kind {
                TxKind::Shield => tx.v_in > 0 && tx.v_out == 0 && tx.fee <= tx.v_in,
                TxKind::Transfer => tx.v_in == 0 && tx.v_out == 0,
                TxKind::Unshield => tx.v_in == 0 && tx.v_out > 0,
            };
            if !pattern_ok {
                return Err(refuse(TxRefusal::AmountPattern));
            }
            // check 15: the window of this block is the window as it was when the block started —
            // never a root from inside the block (§4.3 rule 6)
            if !s.window.contains(&tx.anchor) {
                return Err(refuse(TxRefusal::AnchorNotInWindow));
            }
            // check 16: the set as it is after the preceding transactions of the block
            for nf in &tx.nf {
                if nullifiers.contains(nf) {
                    return Err(refuse(TxRefusal::NullifierRepeatedInBlock));
                }
                if self.store.contains_nullifier(nf)? {
                    return Err(refuse(TxRefusal::NullifierSpent));
                }
            }
            // check 17
            if tree.count > SHIELD_V2_MAX_NOTES - 2 {
                return Err(refuse(TxRefusal::TreeFull));
            }
            // check 18
            let new_total = match tx.kind {
                TxKind::Shield => {
                    // REVIEW_NODE_1 R1-6: checked, so a corrupt stored `pool_total` can neither
                    // panic (debug) nor wrap past the cap (release); `fee ≤ v_in` by check 10.
                    let t = pool_total
                        .checked_add((tx.v_in - tx.fee) as u128)
                        .ok_or(PoolError::CorruptState("pool_total overflow"))?;
                    if t > SHIELD_V2_POOL_CAP_QUANTA {
                        return Err(refuse(TxRefusal::PoolCapExceeded));
                    }
                    t
                }
                TxKind::Transfer => pool_total.checked_sub(tx.fee as u128).ok_or(refuse(TxRefusal::PoolUnderflow))?,
                TxKind::Unshield => pool_total
                    .checked_sub(tx.v_out as u128 + tx.fee as u128)
                    .ok_or(refuse(TxRefusal::PoolUnderflow))?,
            };

            // §4.5 — on the private copy
            // 1. nf1, then nf2
            for nf in &tx.nf {
                nullifier_acc = nullifier_acc_step(&nullifier_acc, nf);
                nullifier_count =
                    nullifier_count.checked_add(1).ok_or(PoolError::CorruptState("nullifier_count overflow"))?;
                nullifiers.push(*nf);
            }
            // 2. cm_out1 at note_count, cm_out2 at note_count + 1
            for (c, bytes) in cm.iter().zip(&tx.cm_out) {
                tree.append(*c);
                leaves.push(*bytes);
            }
            // 3. the pool total; the public balance change is the caller's
            pool_total = new_total;
            // 4. the fee
            fee_total += tx.fee as u128;
            effects.push(TxEffect {
                kind: tx.kind,
                account: tx.account,
                account_debit: if tx.kind == TxKind::Shield { tx.v_in } else { 0 },
                account_credit: if tx.kind == TxKind::Unshield { tx.v_out } else { 0 },
                fee: tx.fee,
            });
        }

        // After the last transaction of the block: R(height) joins the window — for every block,
        // including one with no V2 transaction.
        let tree_root = digest_to_bytes(&tree.root);
        let mut window = s.window.clone();
        window.push(tree_root);
        if window.len() > SHIELD_V2_ANCHOR_WINDOW {
            window.remove(0);
        }
        let mut frontier = [[0u8; 32]; TREE_DEPTH];
        for (out, d) in frontier.iter_mut().zip(&tree.frontier) {
            *out = digest_to_bytes(d);
        }
        let next_height = height.checked_add(1).ok_or(PoolError::CorruptState("height overflow"))?;
        let update = PoolUpdate {
            activation_height: base.activation_height,
            next_height,
            state: PoolState {
                pool_total,
                note_count: tree.count,
                tree_root,
                frontier,
                nullifier_count,
                nullifier_acc,
                window,
            },
            nullifiers,
            first_leaf: s.note_count,
            leaves,
        };
        Ok(PreparedBlock { base, update, effects: BlockEffects { height, txs: effects, fee_total } })
    }

    /// Stores a prepared block: nullifiers, leaves and the new state in one atomic write. Refused
    /// if the stored state is no longer the one the block was prepared against.
    pub fn commit(&mut self, prepared: PreparedBlock) -> Result<BlockEffects, PoolError> {
        if self.stored()? != prepared.base {
            return Err(PoolError::StalePreparation);
        }
        self.store.commit(&prepared.update)?;
        Ok(prepared.effects)
    }

    /// [`Pool::validate_block`] then [`Pool::commit`]: applies the block entirely or not at all.
    pub fn apply_block(&mut self, height: u64, txs: &[PoolTx]) -> Result<BlockEffects, PoolError> {
        let prepared = self.validate_block(height, txs)?;
        self.commit(prepared)
    }
}
