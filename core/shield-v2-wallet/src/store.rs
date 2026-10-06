//! The wallet's own note data and note tree (spec §5.4), pending transactions and their
//! settlement (spec §5.5), and scanning.
//!
//! [`WalletState`] is everything a wallet persists for the shielded pool besides its keys: the
//! notes it owns, the frontier of the commitment tree and the tree nodes its unspent notes' Merkle
//! paths need, **the running nullifier hash of the pool** (the node's `nullifier_acc`, rebuilt
//! from the listing), the height the scan has reached, the pool state of the recent heights
//! (tree root, nullifier hash, both counts), and the transactions the wallet has built and
//! handed out that are not settled ([`PendingTx`]). It serialises to JSON (`to_json` /
//! `from_json`, format version 3; versions 1 and 2 are migrated). It contains note secrets (`r`,
//! values) but no key: the caller encrypts it at rest like the rest of the wallet.
//!
//! **The principle** (REVIEW_WALLET_2): *the wallet believes nothing about a transaction's fate
//! that it cannot tie to data a quorum of nodes vouches for.*
//!
//! [`WalletState::scan`] consumes one page of the node's `GET /api/shield-v2/notes` listing:
//! every accepted V2 transaction in chain order with its two nullifiers, two output commitments
//! (with leaf positions) and two `(kem_ct, note_ct)` pairs. From it the wallet rebuilds BOTH
//! halves of the pool state of spec §4.8: the commitment tree (every `cm_out`, in order) and the
//! nullifier hash (every `nf1`, `nf2`, in order — the pool's own `nullifier_acc_step`).
//!
//! **What a listing proves, and what it does not.** One node's listing proves nothing: the chain
//! has no light-client proofs yet. A node can list a payment that is on no chain, list a
//! transaction as mined that it is holding back, or replace the nullifiers of a transaction so
//! that a spend is hidden. [`WalletState::confirm_state`] compares the wallet's own
//! `(tree_root, nullifier_acc, note_count, nullifier_count)` at a height with what the nodes the
//! caller chose report for that height. A listing that invents, hides, reorders or alters any
//! commitment or any nullifier up to that height gives another root or another hash. Up to the
//! **confirmed height**, and only up to it, the wallet's data is what those nodes hold.
//!
//! **Pending transactions.** A signer-less transaction that has left the wallet stays valid until
//! its `expiry_height`, whatever a node answered when it was submitted. Its inputs are locked
//! from [`WalletState::mark_pending`] until [`WalletState::resolve`] settles it, and `resolve`
//! settles on confirmed data only — see [`Resolution`] for the three outcomes. Seen in an
//! unconfirmed listing, a "rejected" answer, a height one node claims: none of them unlocks
//! anything. There is no other way to release a lock.
//!
//! A restored wallet is `WalletState::new(pk)` plus a scan from the activation height: it
//! recovers every note delivered to its address through conforming ciphertexts (at or above the
//! state's minimum note value), which of them are spent, the balance and the Merkle paths — and
//! nothing about what it sent to others.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use quantum_vault_shield_v2::pool::{nullifier_acc_step, SHIELD_V2_MIN_FEE_QUANTA};
use quantum_vault_shield_v2::reference::{derive_rho, merge, nullifier, Digest, Note, ZERO_DIGEST};
use serde::{Deserialize, Serialize};

use crate::error::{json_error, WalletError};
use crate::field;
use crate::keys::{ScanKey, KEM_CT_BYTES};
use crate::note_enc::{decrypt_note, NOTE_CT_BYTES};
use crate::tx::MAX_EXPIRY_OFFSET;

pub const TREE_DEPTH: usize = 32;
/// The format version `to_json` writes. `from_json` also reads versions 1 and 2 and migrates
/// them (see [`WalletState::from_json`]).
pub const STATE_VERSION: u32 = 3;
/// [`WalletState::confirm_state`]: how many distinct nodes must report the wallet's state when
/// the caller names no quorum. The quorum applied is never below a strict majority of the
/// distinct nodes whose reports were supplied.
pub const DEFAULT_CONFIRM_QUORUM: usize = 2;
/// Reports taken by one `confirm_state` call, and the longest node id.
pub const MAX_STATE_REPORTS: usize = 64;
pub const MAX_NODE_ID_BYTES: usize = 128;
/// Heights at which the pool state changed whose state the wallet keeps (oldest dropped first).
pub const MAX_CHECKPOINTS: usize = 256;
/// Transactions the wallet can have pending at once (locks migrated from format 1 are counted
/// separately, up to [`MAX_LEGACY_LOCKS`]).
pub const MAX_PENDING: usize = 64;
pub const MAX_LEGACY_LOCKS: usize = 4_096;
/// Nullifiers a state remembers while it is scanned without `nk` (F-3); beyond that it asks for
/// a rescan when the full key arrives.
pub const MAX_BLIND_NULLIFIERS: usize = 1_024;
/// Size limits on what is parsed: one listing page (the node sends at most 512 transactions,
/// about 2.4 MB) and one state blob.
pub const MAX_PAGE_TXS: usize = 4_096;
pub const MAX_LISTING_JSON_BYTES: usize = 32 << 20;
pub const MAX_STATE_JSON_BYTES: usize = 256 << 20;
/// The default of a state's minimum note value: the consensus minimum fee (1 XRGE). An incoming
/// note worth less than the fee to spend it cannot be spent alone; it is counted
/// ([`WalletState::below_minimum`]) and not stored (REVIEW_WALLET_2 RW2-7).
pub const DEFAULT_MIN_NOTE_VALUE: u64 = SHIELD_V2_MIN_FEE_QUANTA;
/// Notes a state stores. Further incoming notes are counted ([`WalletState::over_capacity`]) and
/// not stored. With at most 32 tree nodes and one record per note this bounds a state far below
/// [`MAX_STATE_JSON_BYTES`]: `to_json` cannot write what `from_json` refuses.
pub const MAX_STORED_NOTES: usize = 65_536;
/// A spent note is dropped from the state (into [`WalletState::pruned`]) once its spend is this
/// many blocks below the confirmed height.
pub const PRUNE_RETENTION_BLOCKS: u64 = 256;
/// The highest revision a state takes (2^53 − 1: exact in a JavaScript number).
pub const MAX_REVISION: u64 = (1 << 53) - 1;

// ---- serde helpers ---------------------------------------------------------------------------------

/// 32 bytes as lowercase hexadecimal in JSON.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct B32(pub [u8; 32]);

impl core::fmt::Debug for B32 {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(&hex::encode(self.0))
    }
}

impl Serialize for B32 {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(self.0))
    }
}

impl<'de> Deserialize<'de> for B32 {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        hex32(&s).map(B32).ok_or_else(|| serde::de::Error::custom("expected 64 lowercase hexadecimal characters"))
    }
}

fn is_lower_hex(s: &str) -> bool {
    s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn hex32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 || !is_lower_hex(s) {
        return None;
    }
    hex::decode(s).ok()?.try_into().ok()
}

fn hex_exact<const N: usize>(s: &str) -> Option<[u8; N]> {
    if s.len() != 2 * N || !is_lower_hex(s) {
        return None;
    }
    hex::decode(s).ok()?.try_into().ok()
}

/// A u64 amount as a decimal string in JSON (JavaScript numbers lose integers above 2^53).
pub(crate) mod dec {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &u64, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Either {
            S(String),
            N(u64),
        }
        match Either::deserialize(d)? {
            Either::S(s) => s.parse().map_err(|_| serde::de::Error::custom("expected a decimal u64")),
            Either::N(n) => Ok(n),
        }
    }
}

// ---- the listing (the node's JSON shape) -----------------------------------------------------------

/// One page of `GET /api/shield-v2/notes?since=…&blocks=…`.
#[derive(Clone, Debug, Deserialize)]
pub struct ListingPage {
    pub active: bool,
    /// Required (REVIEW_WALLET_1 I-6): a page that does not say where the node's tip is cannot
    /// say that the wallet reached it.
    pub tip_height: u64,
    pub from_height: u64,
    pub next_height: u64,
    #[serde(default)]
    pub txs: Vec<ListedTx>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ListedTx {
    pub height: u64,
    pub index: u64,
    #[serde(default)]
    pub tx_hash: String,
    #[serde(default)]
    pub tx_type: String,
    pub nf1: String,
    pub nf2: String,
    pub outputs: Vec<ListedOutput>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ListedOutput {
    pub cm_out: String,
    pub leaf: Option<u64>,
    pub kem_ct: String,
    pub note_ct: String,
}

impl ListingPage {
    /// Parses a page. Every string of it is validated by [`WalletState::scan`] before anything
    /// is stored (fixed-length lowercase hexadecimal, a known `tx_type`); the error of a page
    /// that does not parse carries a position, never a quotation of the page.
    pub fn from_json(json: &str) -> Result<Self, WalletError> {
        if json.len() > MAX_LISTING_JSON_BYTES {
            return Err(WalletError::Listing("the page is larger than 32 MiB".into()));
        }
        let page: Self = serde_json::from_str(json).map_err(|e| WalletError::Listing(json_error("notes listing", &e)))?;
        if page.txs.len() > MAX_PAGE_TXS {
            return Err(WalletError::Listing("the page lists more than 4,096 transactions".into()));
        }
        Ok(page)
    }
}

const TX_TYPES: [&str; 3] = ["shield_v2", "shielded_transfer_v2", "unshield_v2"];

fn is_tx_hash(s: &str) -> bool {
    s.len() == 64 && is_lower_hex(s)
}

/// A u128 amount as a decimal string in JSON.
mod dec128 {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &u128, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u128, D::Error> {
        String::deserialize(d)?.parse().map_err(|_| serde::de::Error::custom("expected a decimal u128"))
    }
}

// ---- the note tree ---------------------------------------------------------------------------------

fn empty_roots() -> &'static [Digest; TREE_DEPTH + 1] {
    static E: OnceLock<[Digest; TREE_DEPTH + 1]> = OnceLock::new();
    E.get_or_init(|| {
        let mut e = [ZERO_DIGEST; TREE_DEPTH + 1];
        for l in 0..TREE_DEPTH {
            e[l + 1] = merge(&e[l], &e[l]);
        }
        e
    })
}

/// `(level, index) → node` as a JSON array of `[level, index, "hex"]`.
mod node_map {
    use super::B32;
    use serde::{Deserialize, Deserializer, Serializer};
    use std::collections::BTreeMap;
    pub fn serialize<S: Serializer>(m: &BTreeMap<(u8, u64), B32>, s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq(m.iter().map(|(&(l, i), v)| (l, i, v)))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<BTreeMap<(u8, u64), B32>, D::Error> {
        Ok(Vec::<(u8, u64, B32)>::deserialize(d)?.into_iter().map(|(l, i, v)| ((l, i), v)).collect())
    }
}

/// The append-only commitment tree of spec §2.6 / §4.3 as a wallet keeps it: the frontier (what
/// is needed to append the next leaf) and the tree nodes that the Merkle paths of the tracked
/// leaves consist of, updated as later leaves arrive. No full tree is stored.
///
/// **One copy of every node** (REVIEW_WALLET_2 RW2-7). The path of leaf `p` is the 32 nodes
/// `(l, (p >> l) ^ 1)`. Two tracked leaves in the same subtree of height `l` share every node
/// above level `l`, so the nodes are kept in one map keyed by `(level, index)` instead of 32
/// digests per leaf: `n` leaves next to each other need about `2n + 32` nodes, not `32n`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TreeTracker {
    note_count: u64,
    /// `frontier[l]`: the root of the complete left subtree of height `l` that is waiting for its
    /// right sibling, if bit `l` of `note_count` is 1; zeros otherwise (as in spec §4.8).
    frontier: Vec<B32>,
    root: B32,
    /// The leaf positions whose paths are kept.
    tracked: BTreeSet<u64>,
    /// Exactly the nodes on the paths of the tracked leaves.
    #[serde(with = "node_map")]
    nodes: BTreeMap<(u8, u64), B32>,
}

impl Default for TreeTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl TreeTracker {
    pub fn new() -> Self {
        Self {
            note_count: 0,
            frontier: vec![B32([0u8; 32]); TREE_DEPTH],
            root: B32(field::bytes(&empty_roots()[TREE_DEPTH])),
            tracked: BTreeSet::new(),
            nodes: BTreeMap::new(),
        }
    }

    pub fn note_count(&self) -> u64 {
        self.note_count
    }
    pub fn root(&self) -> [u8; 32] {
        self.root.0
    }
    pub fn frontier(&self) -> Vec<[u8; 32]> {
        self.frontier.iter().map(|b| b.0).collect()
    }
    /// The 32 siblings of a tracked leaf against the current root, leaf level first.
    pub fn path(&self, position: u64) -> Option<Vec<[u8; 32]>> {
        if !self.tracked.contains(&position) {
            return None;
        }
        (0..TREE_DEPTH).map(|l| self.nodes.get(&(l as u8, (position >> l) ^ 1)).map(|b| b.0)).collect()
    }
    /// Stops tracking a leaf and drops the nodes no other tracked leaf needs.
    pub fn forget(&mut self, position: u64) {
        if !self.tracked.remove(&position) {
            return;
        }
        for l in 0..TREE_DEPTH {
            // node (l, (p >> l) ^ 1) is on the path of every tracked leaf in p's subtree of
            // height l — and once one is found there, it is in every higher subtree too
            let lo = (position >> l) << l;
            if self.tracked.range(lo..lo + (1u64 << l)).next().is_some() {
                break;
            }
            self.nodes.remove(&(l as u8, (position >> l) ^ 1));
        }
    }
    pub fn tracked(&self) -> usize {
        self.tracked.len()
    }
    /// How many tree nodes the tracked paths take together.
    pub fn stored_nodes(&self) -> usize {
        self.nodes.len()
    }

    fn check(&self) -> Result<(), WalletError> {
        let bad = |what: &'static str| Err(WalletError::State(what.into()));
        if self.frontier.len() != TREE_DEPTH {
            return bad("the tree tracker's frontier has the wrong length");
        }
        if self.note_count > 1u64 << TREE_DEPTH || self.tracked.iter().next_back().is_some_and(|&p| p >= self.note_count) {
            return bad("the tree tracker's counters are inconsistent");
        }
        if self.tracked.len() > MAX_STORED_NOTES || self.nodes.len() > TREE_DEPTH * self.tracked.len() {
            return bad("the tree tracker holds more nodes than its tracked leaves need");
        }
        if self.nodes.keys().any(|&(l, i)| l as usize >= TREE_DEPTH || i >> (TREE_DEPTH - l as usize) != 0) {
            return bad("the tree tracker holds a node outside the tree");
        }
        // what `append` reads back as field elements: after this check an append cannot fail
        // for anything but a full tree, which `scan` rules out before it changes the state
        for f in &self.frontier {
            field::check(&f.0, "a frontier entry").map_err(|_| WalletError::State("the tree tracker's frontier is not canonical".into()))?;
        }
        field::check(&self.root.0, "the root").map_err(|_| WalletError::State("the tree tracker's root is not canonical".into()))?;
        Ok(())
    }

    /// Appends the next leaf (position `note_count`). With `track`, its path is kept from now on.
    /// Cost: 32 hashes and 32 map lookups, whatever the number of tracked leaves.
    pub fn append(&mut self, leaf: &[u8; 32], track: bool) -> Result<u64, WalletError> {
        let n = self.note_count;
        if n >= 1u64 << TREE_DEPTH {
            return Err(WalletError::State("the commitment tree is full".into()));
        }
        let empty = empty_roots();
        let mut node = field::digest(leaf, "a leaf")?;
        let mut carried = true; // still inside the complete subtree that ends at leaf n
        for l in 0..TREE_DEPTH {
            // `node` is the value of the tree node (level l, index n >> l) after this insertion
            let idx = n >> l;
            let node_b = B32(field::bytes(&node));
            if let Some(v) = self.nodes.get_mut(&(l as u8, idx)) {
                *v = node_b; // it is on a tracked leaf's path
            }
            if idx & 1 == 0 {
                // a left child: its right sibling is still empty
                if track {
                    self.nodes.entry((l as u8, idx | 1)).or_insert(B32(field::bytes(&empty[l])));
                }
                if carried {
                    self.frontier[l] = node_b; // complete, waiting for its right sibling
                    carried = false;
                }
                node = merge(&node, &empty[l]);
            } else {
                // a right child: the left sibling is the frontier entry of this level
                let left = field::digest(&self.frontier[l].0, "a frontier entry")?;
                if track {
                    self.nodes.insert((l as u8, idx ^ 1), self.frontier[l]);
                }
                if carried {
                    self.frontier[l] = B32([0u8; 32]); // consumed: bit l of the new count is 0
                }
                node = merge(&left, &node);
            }
        }
        self.root = B32(field::bytes(&node));
        self.note_count = n + 1;
        if track {
            self.tracked.insert(n);
        }
        Ok(n)
    }
}

// ---- notes -----------------------------------------------------------------------------------------

/// What the wallet keeps for every note it owns (spec §5.4). Zero-value notes, and notes below
/// the state's minimum note value, are not stored. Secret (`value`, `r`): `Debug` prints neither.
///
/// This is the in-memory and API shape. **The state file stores a note as one array of ten
/// values** without `spent` and `confirmed`, which are recomputed when the state is read
/// (`spent` is `spent_height.is_some()`; `confirmed` is `height <= confirmed height`). `cm` could
/// be recomputed too, at the price of one commitment hash per note on every read of the state;
/// it is kept.
#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct OwnedNote {
    /// quanta
    #[serde(with = "dec")]
    pub value: u64,
    pub r: B32,
    /// Derived from the creating transaction's nullifiers, never taken from the sender.
    pub rho: B32,
    /// Leaf position in the commitment tree.
    pub position: u64,
    pub cm: B32,
    /// `H(3; nk ‖ rho)`; `None` while the state has only been scanned with the viewing key.
    pub nullifier: Option<B32>,
    /// The note's own nullifier appeared in the listing (see `spent_height`).
    pub spent: bool,
    /// Height of the block in which the nullifier appeared.
    pub spent_height: Option<u64>,
    /// Height of the block that created the note.
    pub height: u64,
    /// The creating transaction (the node's hash of it: 64 lowercase hexadecimal characters) and
    /// the output slot, 0 or 1.
    pub tx_hash: String,
    pub output_index: u8,
    /// `false` ("unverified"): the note is known from one node's listing only. `true`: the
    /// note's height is at or below the height [`WalletState::confirm_state`] confirmed.
    pub confirmed: bool,
}

impl core::fmt::Debug for OwnedNote {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(
            f,
            "OwnedNote {{ position: {}, height: {}, cm: {:?}, spent: {}, confirmed: {}, value: <secret>, r: <secret> }}",
            self.position, self.height, self.cm, self.spent, self.confirmed
        )
    }
}

/// The stored form of the notes: `[value, r, rho, position, cm, nullifier, height, spent_height,
/// tx_hash, output_index]` per note.
mod stored_notes {
    use super::{OwnedNote, B32};
    use serde::{Deserialize, Deserializer, Serializer};

    type Row = (String, B32, B32, u64, B32, Option<B32>, u64, Option<u64>, String, u8);

    pub fn serialize<S: Serializer>(notes: &[OwnedNote], s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq(notes.iter().map(|n| {
            (n.value.to_string(), &n.r, &n.rho, n.position, &n.cm, &n.nullifier, n.height, n.spent_height, &n.tx_hash, n.output_index)
        }))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<OwnedNote>, D::Error> {
        Vec::<Row>::deserialize(d)?
            .into_iter()
            .map(|(value, r, rho, position, cm, nullifier, height, spent_height, tx_hash, output_index)| {
                Ok(OwnedNote {
                    value: value.parse().map_err(|_| serde::de::Error::custom("expected a decimal u64"))?,
                    r,
                    rho,
                    position,
                    cm,
                    nullifier,
                    spent: spent_height.is_some(),
                    spent_height,
                    height,
                    tx_hash,
                    output_index,
                    confirmed: false, // set from the confirmed height by `from_json`
                })
            })
            .collect()
    }
}

/// A note ready to be spent: the note's secrets and its Merkle path against the wallet's
/// current root. Secret; no `Debug`.
#[derive(Clone, PartialEq, Eq)]
pub struct SpendInput {
    pub value: u64,
    pub rho: [u8; 32],
    pub r: [u8; 32],
    pub position: u64,
    pub path: Vec<[u8; 32]>,
}

impl Drop for SpendInput {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.value.zeroize();
        self.r.zeroize();
    }
}

/// A count of notes and the sum of their values, quanta.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tally {
    pub count: u64,
    #[serde(with = "dec128")]
    pub total: u128,
}

impl Tally {
    fn add(&mut self, value: u64) {
        self.count = self.count.saturating_add(1);
        self.total = self.total.saturating_add(value as u128);
    }
}

/// What one call of [`WalletState::scan`] found. **Everything in it is what ONE node's listing
/// says**: nothing here settles a pending transaction or confirms a note.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ScanReport {
    /// transactions read from the page
    pub txs: usize,
    /// positions of the notes found for this wallet (all `unverified` until `confirm_state`)
    pub received: Vec<u64>,
    /// positions of this wallet's notes whose own nullifier appeared
    pub spent: Vec<u64>,
    /// pending transactions of this wallet the page listed (both nullifiers with both outputs)
    pub pending_seen_mined: usize,
    /// pending transactions one of whose nullifiers the page listed in ANOTHER transaction
    pub pending_seen_superseded: usize,
    /// notes for this wallet that were counted and not stored (below the minimum note value, or
    /// beyond the state's capacity)
    pub not_stored: usize,
    /// where the next page starts
    pub next_height: u64,
    /// `true` when the page reached the node's tip
    pub at_tip: bool,
}

// ---- pending transactions --------------------------------------------------------------------------

/// What the SCAN has seen of a pending transaction — one node's listing, not a settlement. The
/// inputs stay locked in every status; only [`WalletState::resolve`] removes an entry.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PendingStatus {
    /// Handed out; the listing has shown none of its nullifiers.
    #[default]
    Pending,
    /// The listing showed a transaction with both its nullifiers and both its output commitments.
    SeenMined,
    /// The listing showed one of its nullifiers in a transaction that is not this one.
    SeenSuperseded,
}

/// The change note a pending transaction will return to the wallet when it is mined. `Debug`
/// does not print the value.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingChange {
    pub cm: B32,
    #[serde(with = "dec")]
    pub value: u64,
}

impl core::fmt::Debug for PendingChange {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "PendingChange {{ cm: {:?}, value: <secret> }}", self.cm)
    }
}

/// A transaction the wallet built and handed out. Made by `BuiltTx::pending()`; recorded with
/// [`WalletState::mark_pending`] BEFORE the transaction is submitted anywhere. `Debug` prints no
/// amount.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingTx {
    /// `shielded_transfer_v2` or `unshield_v2` (empty for a lock migrated from format 1).
    pub tx_type: String,
    /// The transaction's two nullifiers in body order (a dummy input's included);
    /// `nullifiers[i]` is the nullifier of `inputs[i]`. (A migrated lock can hold fewer.)
    pub nullifiers: Vec<B32>,
    /// The transaction's two output commitments, `cm_out1` then `cm_out2`. With the nullifiers
    /// they identify the transaction in a listing: the settlement compares all four. (Empty in an
    /// entry migrated from format 1 or 2.)
    #[serde(default)]
    pub outputs: Vec<B32>,
    /// Leaf positions of the one or two notes it spends.
    pub inputs: Vec<u64>,
    /// The commitments of those notes, filled in by `mark_pending`. **The lock is held by
    /// commitment**: it follows the note through a rescan, also onto a listing in which the note
    /// sits at another position.
    #[serde(default)]
    pub input_cms: Vec<B32>,
    /// The total value of those notes, quanta.
    #[serde(with = "dec")]
    pub input_total: u64,
    /// The change the wallet expects back. Credited like any other note: when the scan finds it
    /// and `confirm_state` confirms its height — which is when the transaction settles as mined.
    pub change: Option<PendingChange>,
    /// The last height at which the node accepts the transaction. For a lock migrated from
    /// format 1, whose expiry was not recorded: the migrated state's scanned height + 128.
    pub expiry_height: u64,
    #[serde(default)]
    pub status: PendingStatus,
    /// The height of the listed transaction that set `status` (`None` while `pending`).
    #[serde(default)]
    pub seen_height: Option<u64>,
    /// A node answered "rejected" when the transaction was submitted. **A hint for the UI and
    /// nothing else**: the transaction is still valid until `expiry_height`, and the inputs stay
    /// locked.
    #[serde(default)]
    pub rejected_hint: bool,
    /// A lock migrated from an older state format: the transaction itself is not known.
    #[serde(default)]
    pub legacy: bool,
}

impl core::fmt::Debug for PendingTx {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(
            f,
            "PendingTx {{ tx_type: {:?}, nullifiers: {:?}, outputs: {:?}, inputs: {:?}, expiry_height: {}, status: {:?}, seen_height: {:?}, rejected_hint: {}, legacy: {}, input_total: <secret>, change: {:?} }}",
            self.tx_type, self.nullifiers, self.outputs, self.inputs, self.expiry_height, self.status, self.seen_height, self.rejected_hint, self.legacy, self.change
        )
    }
}

impl PendingTx {
    fn locks(&self, note: &OwnedNote) -> bool {
        if self.input_cms.is_empty() {
            self.inputs.contains(&note.position) // an entry migrated without its notes
        } else {
            self.input_cms.contains(&note.cm)
        }
    }
}

/// What [`WalletState::resolve`] settled and removed from the pending list. Every outcome is
/// decided at the **confirmed height** `C` (the highest height at which
/// [`WalletState::confirm_state`] matched a quorum), from data that is the quorum's up to `C`:
///
/// | Outcome | Condition | Effect |
/// |---|---|---|
/// | `mined` | a transaction at a height ≤ `C` has BOTH nullifiers of the entry and BOTH its output commitments | its inputs are spent; its change is a confirmed note |
/// | `superseded` | a DIFFERENT transaction at a height ≤ `C` has one of its nullifiers | it can never be mined; the inputs whose own nullifier appeared are spent, the others are free |
/// | `expired` | `C ≥ expiry_height` and none of its nullifiers appeared up to `C` | it can never be mined; all inputs are free |
/// | *(stays pending)* | anything else | inputs locked |
///
/// The node refuses a transaction whose `expiry_height` is below the block's height, so the last
/// block that can hold it is block `expiry_height`; `C ≥ expiry_height` means that block was read
/// and confirmed.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Resolution {
    pub mined: Vec<PendingTx>,
    /// For an entry with `legacy: true` this means only: its input was spent on the confirmed
    /// chain, by the unknown transaction or by another.
    pub superseded: Vec<PendingTx>,
    pub expired: Vec<PendingTx>,
    /// Entries that are still pending (inputs still locked).
    pub still_pending: usize,
}

// ---- state confirmation ----------------------------------------------------------------------------

/// The pool state after the block at one height, as far as a wallet can rebuild it from a
/// listing: both halves of spec §4.8.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PoolView {
    pub tree_root: [u8; 32],
    pub nullifier_acc: [u8; 32],
    pub note_count: u64,
    pub nullifier_count: u64,
}

/// One node's statement "after the block at `height` the pool is in this state" — the `report`
/// object of its `/api/shield-v2/stats`, which the node takes from ONE read of its pool state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StateReport {
    /// The caller's name for the node. Only its distinctness is used: two reports with one id
    /// count once. It MUST be the endpoint the user or the application configured — never a
    /// string the node returned about itself, or one node is as many nodes as it likes.
    pub node_id: String,
    pub height: u64,
    pub tree_root: [u8; 32],
    pub nullifier_acc: [u8; 32],
    pub note_count: u64,
    pub nullifier_count: u64,
}

impl StateReport {
    fn view(&self) -> PoolView {
        PoolView { tree_root: self.tree_root, nullifier_acc: self.nullifier_acc, note_count: self.note_count, nullifier_count: self.nullifier_count }
    }
}

/// What [`WalletState::confirm_state`] concluded.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ConfirmReport {
    /// The quorum that was applied: the larger of the one asked for and a strict majority of
    /// `nodes`.
    pub quorum: usize,
    /// Distinct node ids among the reports supplied.
    pub nodes: usize,
    /// The highest height at which the quorum matched in THIS call (`None` when `diverged`).
    pub matched_height: Option<u64>,
    /// The highest height the state has ever had confirmed.
    pub confirmed_height: Option<u64>,
    /// Positions of the notes this call moved from unverified to confirmed.
    pub newly_confirmed: Vec<u64>,
    /// Distinct nodes whose report is the wallet's state at `matched_height` (or, without a
    /// match, the best count reached at any height).
    pub agreeing: usize,
    /// Reports for heights the wallet has not scanned yet or no longer keeps the state of.
    pub not_comparable: usize,
    /// `true`: at a height the wallet can compare, a report differs from the wallet's state (or
    /// one node made two different reports). **Nothing was confirmed by this call.** Either the
    /// wallet's listing is not the chain those nodes see, or one of them lies: the caller decides
    /// which nodes to ask again, and rebuilds from `fresh_for_rescan` against another node if the
    /// disagreement is with its listing.
    pub diverged: bool,
    /// The heights at which a report conflicted.
    pub conflicts: Vec<u64>,
    /// Spent notes this call dropped from the state (see [`PRUNE_RETENTION_BLOCKS`]).
    pub pruned: usize,
}

/// The pool state after the block at `height` (recorded at the heights where it changed).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Checkpoint {
    height: u64,
    root: B32,
    nullifier_acc: B32,
    note_count: u64,
    nullifier_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct SeenNullifier {
    nf: B32,
    height: u64,
}

/// Every nullifier that appeared while the state held a note without a nullifier (scanned with
/// the viewing key alone), so that the full key can apply those spends later (F-3).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
struct BlindLog {
    seen: Vec<SeenNullifier>,
    /// More than [`MAX_BLIND_NULLIFIERS`] appeared: the log is incomplete and the full key needs
    /// a rescan.
    overflow: bool,
}

/// The balances of a state, quanta.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Balances {
    /// Unspent notes at or below the confirmed height. Exact as of that height; a spend above
    /// it that the wallet's listing does not show is not known to the wallet.
    pub confirmed: u128,
    /// Unspent notes known from one node's listing only. NOT money the user can rely on.
    pub unverified: u128,
    /// Of the two above: inputs of unsettled pending transactions.
    pub locked: u128,
    /// Confirmed, unlocked: what default coin selection can use.
    pub spendable: u128,
    /// For display only, in NONE of the figures above: the change of pending transactions that
    /// the listing has not shown yet. It becomes money when the transaction settles as mined.
    pub expected_change: u128,
}

/// The persistent shielded-pool state of one wallet.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WalletState {
    version: u32,
    /// Goes up by one with every change of the state (REVIEW_WALLET_2 I-3).
    revision: u64,
    /// The wallet's `pk`: a state is scanned with one key only.
    pk: B32,
    /// The next height to ask the node for (`since`).
    next_height: u64,
    /// Incoming notes below this value are counted in `below_minimum` and not stored.
    #[serde(with = "dec")]
    min_note_value: u64,
    tree: TreeTracker,
    /// The pool's running nullifier hash and nullifier count after the last scanned block.
    nullifier_acc: B32,
    nullifier_count: u64,
    #[serde(with = "stored_notes")]
    notes: Vec<OwnedNote>,
    pending: Vec<PendingTx>,
    checkpoints: Vec<Checkpoint>,
    confirmed_height: Option<u64>,
    blind: BlindLog,
    below_minimum: Tally,
    over_capacity: Tally,
    pruned: Tally,
}

/// State format 1 (before REVIEW_WALLET_1), read only to be migrated.
#[derive(Deserialize)]
struct WalletStateV1 {
    pk: B32,
    next_height: u64,
    notes: Vec<OldNote>,
}

/// State format 2 (REVIEW_WALLET_1), read only to be migrated.
#[derive(Deserialize)]
struct WalletStateV2 {
    pk: B32,
    next_height: u64,
    notes: Vec<OldNote>,
    #[serde(default)]
    pending: Vec<PendingTxV2>,
}

/// What the migrations read of a format-1 or format-2 note.
#[derive(Deserialize)]
struct OldNote {
    #[serde(with = "dec")]
    value: u64,
    position: u64,
    cm: B32,
    nullifier: Option<B32>,
    spent: bool,
    spent_height: Option<u64>,
}

#[derive(Deserialize)]
struct PendingTxV2 {
    tx_type: String,
    nullifiers: Vec<B32>,
    inputs: Vec<u64>,
    #[serde(with = "dec")]
    input_total: u64,
    change: Option<PendingChange>,
    expiry_height: Option<u64>,
    status: String,
    #[serde(default)]
    rejected_hint: bool,
}

#[derive(Deserialize)]
struct VersionOnly {
    version: u32,
}

/// One transaction of a page, validated and trial-decrypted, before the state is touched.
struct PreparedTx {
    height: u64,
    nf: [[u8; 32]; 2],
    tx_hash: String,
    outputs: [PreparedOutput; 2],
}

struct PreparedOutput {
    cm: [u8; 32],
    /// `(value, r, rho)` of a non-zero note that is this wallet's.
    mine: Option<(u64, [u8; 32], Digest)>,
}

fn mark_spent(notes: &mut [OwnedNote], tree: &mut TreeTracker, report: &mut ScanReport, height: u64, is_it: impl Fn(&OwnedNote) -> bool) {
    for n in notes.iter_mut().filter(|n| n.spent_height.is_none() && is_it(n)) {
        n.spent = true;
        n.spent_height = Some(height);
        tree.forget(n.position);
        report.spent.push(n.position);
    }
}

impl WalletState {
    /// An empty state for the wallet whose address has this `pk`, with the default minimum note
    /// value ([`DEFAULT_MIN_NOTE_VALUE`]). Scanning it from height 0 is the restore of spec §5.4.
    pub fn new(pk: [u8; 32]) -> Self {
        Self::empty(pk, DEFAULT_MIN_NOTE_VALUE)
    }

    /// [`WalletState::new`] with the caller's minimum note value, in quanta (at least 1). An
    /// incoming note below it is counted and not stored: it is not in any balance and cannot be
    /// spent from this state. `1` stores every non-zero note. The value holds for the life of
    /// the state; to change it, rescan ([`WalletState::fresh_for_rescan_with_min_note_value`]).
    pub fn with_min_note_value(pk: [u8; 32], min_note_value: u64) -> Result<Self, WalletError> {
        if min_note_value == 0 {
            return Err(WalletError::Request("the minimum note value must be at least 1 quantum".into()));
        }
        Ok(Self::empty(pk, min_note_value))
    }

    fn empty(pk: [u8; 32], min_note_value: u64) -> Self {
        let tree = TreeTracker::new();
        Self {
            version: STATE_VERSION,
            revision: 0,
            pk: B32(pk),
            next_height: 0,
            min_note_value,
            checkpoints: vec![Checkpoint { height: 0, root: tree.root, nullifier_acc: B32([0u8; 32]), note_count: 0, nullifier_count: 0 }],
            tree,
            nullifier_acc: B32([0u8; 32]),
            nullifier_count: 0,
            notes: Vec::new(),
            pending: Vec::new(),
            confirmed_height: None,
            blind: BlindLog::default(),
            below_minimum: Tally::default(),
            over_capacity: Tally::default(),
            pruned: Tally::default(),
        }
    }

    /// An empty state for the same wallet that KEEPS the pending transactions: what to rescan
    /// into after a reorganisation or a `diverged` state check.
    ///
    /// **Every entry is carried over as pending and locked — never as mined or superseded.** What
    /// the old state had seen of it came from the listing that is being thrown away; the status
    /// is found again from the rescanned data, and nothing settles before `confirm_state` has
    /// confirmed that data. The locks are held by note commitment, so they apply as soon as the
    /// rescan finds the notes again. The revision continues.
    pub fn fresh_for_rescan(&self) -> Self {
        let mut s = Self::empty(self.pk.0, self.min_note_value);
        s.revision = self.revision;
        s.pending = self
            .pending
            .iter()
            .cloned()
            .map(|mut p| {
                p.status = PendingStatus::Pending;
                p.seen_height = None;
                p
            })
            .collect();
        s.bump();
        s
    }

    /// [`WalletState::fresh_for_rescan`] with another minimum note value.
    pub fn fresh_for_rescan_with_min_note_value(&self, min_note_value: u64) -> Result<Self, WalletError> {
        if min_note_value == 0 {
            return Err(WalletError::Request("the minimum note value must be at least 1 quantum".into()));
        }
        let mut s = self.fresh_for_rescan();
        s.min_note_value = min_note_value;
        Ok(s)
    }

    fn bump(&mut self) {
        self.revision = (self.revision + 1).min(MAX_REVISION);
    }

    /// The state as JSON. Never larger than `from_json` accepts: the number of stored notes is
    /// capped ([`MAX_STORED_NOTES`]), every other list is bounded, and the size is checked.
    pub fn to_json(&self) -> Result<String, WalletError> {
        let json = serde_json::to_string(self).map_err(|_| WalletError::Internal("state encoding"))?;
        if json.len() > MAX_STATE_JSON_BYTES {
            return Err(WalletError::State("the state would be larger than 256 MiB".into()));
        }
        Ok(json)
    }

    /// Parses and validates a state. Format 3 is read as is.
    ///
    /// **Formats 1 and 2 are migrated to an EMPTY state that keeps the locks**, to be scanned
    /// from the activation height. They did not record the pool's nullifier hash, and it cannot
    /// be computed afterwards (it runs over every nullifier since activation), so an old state's
    /// notes can never be confirmed; a rescan finds every one of them again.
    ///
    /// * Format 2: every pending entry is carried over as pending and locked — also one the old
    ///   state called `mined` on one node's word. Its lock is held by the commitments of its
    ///   input notes. It has both nullifiers and the change commitment but not both outputs: it
    ///   settles as mined when a confirmed transaction has exactly its nullifier pair and its
    ///   change commitment.
    /// * Format 1: every note that was marked spent locally (no `spent_height`) becomes a
    ///   `legacy` lock on that note with its nullifier, if known.
    /// * A lock without an expiry (format 1, or format 2 migrated from 1) gets
    ///   **`expiry_height` = the old state's scanned height + 128** (the builders' maximum expiry
    ///   distance) and settles by the same confirmed rules as every other entry. Format 1 did
    ///   not bound the expiry it accepted: a transaction built by a format-1 client with a
    ///   longer expiry is not covered by this. No client was ever released on format 1.
    pub fn from_json(json: &str) -> Result<Self, WalletError> {
        if json.len() > MAX_STATE_JSON_BYTES {
            return Err(WalletError::State("the state is larger than 256 MiB".into()));
        }
        let bad = |e: serde_json::Error| WalletError::State(json_error("wallet state", &e));
        let v: VersionOnly = serde_json::from_str(json).map_err(bad)?;
        let s = match v.version {
            1 => Self::migrate_v1(serde_json::from_str(json).map_err(bad)?)?,
            2 => Self::migrate_v2(serde_json::from_str(json).map_err(bad)?)?,
            STATE_VERSION => {
                let mut s: Self = serde_json::from_str(json).map_err(bad)?;
                let confirmed = s.confirmed_height;
                for n in s.notes.iter_mut() {
                    n.confirmed = confirmed.is_some_and(|c| n.height <= c);
                }
                s
            }
            _ => return Err(WalletError::State("unknown state version (this wallet reads versions 1, 2 and 3)".into())),
        };
        s.validate()?;
        Ok(s)
    }

    fn synthetic_expiry(old_next_height: u64) -> u64 {
        old_next_height.saturating_sub(1).saturating_add(MAX_EXPIRY_OFFSET)
    }

    fn migrate_v1(old: WalletStateV1) -> Result<Self, WalletError> {
        let mut s = Self::new(old.pk.0);
        let expiry = Self::synthetic_expiry(old.next_height);
        // marked spent locally by format 1's `mark_pending_spent`: an unknown transaction may
        // still spend it
        for n in old.notes.iter().filter(|n| n.value > 0 && n.spent && n.spent_height.is_none()) {
            s.pending.push(PendingTx {
                tx_type: String::new(),
                nullifiers: n.nullifier.into_iter().collect(),
                outputs: Vec::new(),
                inputs: vec![n.position],
                input_cms: vec![n.cm],
                input_total: n.value,
                change: None,
                expiry_height: expiry,
                status: PendingStatus::Pending,
                seen_height: None,
                rejected_hint: false,
                legacy: true,
            });
        }
        Ok(s)
    }

    fn migrate_v2(old: WalletStateV2) -> Result<Self, WalletError> {
        let mut s = Self::new(old.pk.0);
        let synthetic = Self::synthetic_expiry(old.next_height);
        for p in old.pending {
            if p.status == "expired" {
                continue; // format 2 never stored one; it would have been released already
            }
            let cms: Option<Vec<B32>> = p.inputs.iter().map(|pos| old.notes.iter().find(|n| n.position == *pos).map(|n| n.cm)).collect();
            let legacy = p.expiry_height.is_none() || p.nullifiers.len() != 2 || p.change.is_none();
            s.pending.push(PendingTx {
                tx_type: p.tx_type,
                nullifiers: p.nullifiers,
                outputs: Vec::new(),
                inputs: p.inputs,
                // a format-2 state in the middle of a rescan has the entry and not the note: the
                // lock then stays on the position, as format 2 held it
                input_cms: cms.unwrap_or_default(),
                input_total: p.input_total,
                change: p.change,
                expiry_height: p.expiry_height.unwrap_or(synthetic),
                status: PendingStatus::Pending,
                seen_height: None,
                rejected_hint: p.rejected_hint,
                legacy,
            });
        }
        Ok(s)
    }

    fn validate(&self) -> Result<(), WalletError> {
        let bad = |what: &'static str| Err(WalletError::State(what.into()));
        if self.version != STATE_VERSION {
            return bad("unknown state version");
        }
        if self.revision > MAX_REVISION || self.min_note_value == 0 {
            return bad("the revision or the minimum note value is out of range");
        }
        self.tree.check()?;
        if self.notes.len() > MAX_STORED_NOTES || self.tree.tracked.len() > self.notes.len() {
            return bad("the state stores more notes than it can hold");
        }
        let mut seen = BTreeSet::new();
        for n in &self.notes {
            if n.position >= self.tree.note_count || !seen.insert(n.position) || n.output_index > 1 || n.value == 0 {
                return bad("a stored note is inconsistent with the tree");
            }
            if n.height >= self.next_height || n.spent != n.spent_height.is_some() || n.spent_height.is_some_and(|h| h >= self.next_height || h < n.height) {
                return bad("a stored note's heights are inconsistent");
            }
            if !(n.tx_hash.is_empty() || is_tx_hash(&n.tx_hash)) {
                return bad("a stored note's tx_hash is not 64 lowercase hexadecimal characters");
            }
        }
        if self.tree.tracked.iter().any(|p| !seen.contains(p)) {
            return bad("the tree tracks a leaf that is not a stored note");
        }
        let (mut own, mut legacy) = (0usize, 0usize);
        for p in &self.pending {
            let distinct = |v: &[B32]| v.len() < 2 || v[0] != v[1];
            let inputs_ok = matches!(p.inputs.len(), 1 | 2) && (p.inputs.len() == 1 || p.inputs[0] != p.inputs[1]);
            let cms_ok = (p.input_cms.is_empty() || p.input_cms.len() == p.inputs.len()) && distinct(&p.input_cms);
            let nf_ok = p.nullifiers.len() <= 2 && distinct(&p.nullifiers) && (p.legacy || p.nullifiers.len() == 2);
            let out_ok = matches!(p.outputs.len(), 0 | 2) && distinct(&p.outputs) && (p.legacy || p.outputs.len() == 2 || p.change.is_some());
            let type_ok = p.tx_type.is_empty() || TX_TYPES[1..].contains(&p.tx_type.as_str());
            let seen_ok = (p.status == PendingStatus::Pending) == p.seen_height.is_none() && p.seen_height.is_none_or(|h| h < self.next_height);
            if !inputs_ok || !cms_ok || !nf_ok || !out_ok || !type_ok || !seen_ok {
                return bad("a pending transaction is malformed");
            }
            if p.legacy {
                legacy += 1;
            } else {
                own += 1;
            }
        }
        if own > MAX_PENDING || legacy > MAX_LEGACY_LOCKS {
            return bad("too many pending transactions");
        }
        if self.checkpoints.is_empty() || self.checkpoints.len() > MAX_CHECKPOINTS {
            return bad("the state history is empty or too long");
        }
        let top = self.next_height.max(1);
        if self.checkpoints.windows(2).any(|w| w[0].height >= w[1].height) || self.checkpoints.iter().any(|c| c.height >= top) {
            return bad("the state history is not in order");
        }
        if self.checkpoints.last().is_some_and(|c| {
            c.root != self.tree.root || c.nullifier_acc != self.nullifier_acc || c.note_count != self.tree.note_count || c.nullifier_count != self.nullifier_count
        }) {
            return bad("the state history does not end at the current tree root and nullifier hash");
        }
        if self.confirmed_height.is_some_and(|h| h >= self.next_height) {
            return bad("the confirmed height is above the scanned height");
        }
        if self.notes.iter().any(|n| n.confirmed != self.confirmed_height.is_some_and(|c| n.height <= c)) {
            return bad("a note's confirmation does not follow from the confirmed height");
        }
        if self.blind.seen.len() > MAX_BLIND_NULLIFIERS {
            return bad("the blind-scan log is too long");
        }
        Ok(())
    }

    pub fn pk(&self) -> [u8; 32] {
        self.pk.0
    }
    /// Goes up with every change. A caller with more than one writer (two tabs, a worker and a
    /// page) persists a state only if the stored revision is still the one it loaded, and passes
    /// the stored revision to [`WalletState::expect_revision`] before it changes anything.
    pub fn revision(&self) -> u64 {
        self.revision
    }
    /// Refuses with [`WalletError::StaleState`] unless this state has the revision the caller
    /// read from its storage: the state in hand is then an old copy, and writing a change of it
    /// would silently drop what another writer recorded — a `mark_pending`, that is, a lock.
    pub fn expect_revision(&self, expected: u64) -> Result<(), WalletError> {
        if self.revision == expected {
            Ok(())
        } else {
            Err(WalletError::StaleState)
        }
    }
    /// `true` when the two states hold the same data, whatever their revisions (two states that
    /// reached the same chain by different sequences of calls).
    pub fn content_eq(&self, other: &Self) -> bool {
        let mut o = other.clone();
        o.revision = self.revision;
        *self == o
    }
    pub fn min_note_value(&self) -> u64 {
        self.min_note_value
    }
    /// Incoming notes that were below the minimum note value: counted, never stored. A running
    /// total of what arrived, not a balance (whether they were spent since is not tracked).
    pub fn below_minimum(&self) -> Tally {
        self.below_minimum
    }
    /// Incoming notes that arrived while the state already held [`MAX_STORED_NOTES`]. Merge
    /// notes or raise the minimum note value, then rescan, to recover them.
    pub fn over_capacity(&self) -> Tally {
        self.over_capacity
    }
    /// Spent notes dropped from the state: their spend is confirmed and more than
    /// [`PRUNE_RETENTION_BLOCKS`] below the confirmed height.
    pub fn pruned(&self) -> Tally {
        self.pruned
    }
    /// `since` of the next listing request.
    pub fn next_height(&self) -> u64 {
        self.next_height
    }
    /// The last height the scan has covered completely; `None` before the first page.
    pub fn scanned_height(&self) -> Option<u64> {
        self.next_height.checked_sub(1)
    }
    /// The highest height at which `confirm_state` matched a quorum.
    pub fn confirmed_height(&self) -> Option<u64> {
        self.confirmed_height
    }
    pub fn notes(&self) -> &[OwnedNote] {
        &self.notes
    }
    pub fn tree(&self) -> &TreeTracker {
        &self.tree
    }
    /// The wallet's tree root: the anchor its paths prove against. Once the wallet has scanned to
    /// the tip this is the node's `latest_anchor` (`R(tip)`), which is in the anchor window.
    pub fn anchor(&self) -> [u8; 32] {
        self.tree.root()
    }
    /// The pool's running nullifier hash as this state has rebuilt it from the listing.
    pub fn nullifier_acc(&self) -> [u8; 32] {
        self.nullifier_acc.0
    }
    pub fn nullifier_count(&self) -> u64 {
        self.nullifier_count
    }
    /// The wallet's own view of the pool after the block at `height`: `None` for a height the
    /// scan has not covered, or one older than the history kept.
    pub fn state_at(&self, height: u64) -> Option<PoolView> {
        if height >= self.next_height {
            return None;
        }
        self.checkpoints.iter().rev().find(|c| c.height <= height).map(|c| PoolView {
            tree_root: c.root.0,
            nullifier_acc: c.nullifier_acc.0,
            note_count: c.note_count,
            nullifier_count: c.nullifier_count,
        })
    }
    /// The wallet's own tree root after the block at `height` (see [`WalletState::state_at`]).
    pub fn root_at(&self, height: u64) -> Option<[u8; 32]> {
        self.state_at(height).map(|v| v.tree_root)
    }
    /// The sum of ALL unspent notes, confirmed and unverified, in quanta. Not a figure to show a
    /// user as "received": use [`WalletState::balances`].
    pub fn balance(&self) -> u128 {
        self.notes.iter().filter(|n| !n.spent).map(|n| n.value as u128).sum()
    }
    /// Unspent notes whose existence a quorum of nodes confirmed.
    pub fn confirmed_balance(&self) -> u128 {
        self.balances().confirmed
    }
    /// Unspent notes known from one node's listing only.
    pub fn unverified_balance(&self) -> u128 {
        self.balances().unverified
    }
    pub fn balances(&self) -> Balances {
        let mut b = Balances::default();
        for n in self.notes.iter().filter(|n| !n.spent) {
            let v = n.value as u128;
            let locked = self.pending.iter().any(|p| p.locks(n));
            if n.confirmed {
                b.confirmed += v;
                if !locked {
                    b.spendable += v;
                }
            } else {
                b.unverified += v;
            }
            if locked {
                b.locked += v;
            }
        }
        b.expected_change =
            self.pending.iter().filter(|p| p.status == PendingStatus::Pending).filter_map(|p| p.change.as_ref()).map(|c| c.value as u128).sum();
        b
    }
    pub fn unspent(&self) -> impl Iterator<Item = &OwnedNote> {
        self.notes.iter().filter(|n| !n.spent)
    }
    pub fn note_at(&self, position: u64) -> Option<&OwnedNote> {
        self.notes.iter().find(|n| n.position == position)
    }

    /// The note at `position` with its current Merkle path, ready for a builder. Refuses a spent
    /// note, a note locked by a pending transaction ([`WalletError::NoteLocked`]) and a note that
    /// `confirm_state` has not confirmed ([`WalletError::NoteUnverified`]).
    pub fn spend_input(&self, position: u64) -> Result<SpendInput, WalletError> {
        self.spend_input_with(position, false)
    }

    /// [`WalletState::spend_input`]; with `allow_unverified` it also hands out a note known from
    /// one node's listing only — the caller's explicit decision, the same flag as in coin
    /// selection ([`crate::select_inputs_with`]). A locked note is never handed out.
    pub fn spend_input_with(&self, position: u64, allow_unverified: bool) -> Result<SpendInput, WalletError> {
        let n = self.note_at(position).ok_or_else(|| WalletError::Request("no note at that position".into()))?;
        if n.spent {
            return Err(WalletError::Request("the note at that position is already spent".into()));
        }
        if self.is_locked(position) {
            return Err(WalletError::NoteLocked);
        }
        if !n.confirmed && !allow_unverified {
            return Err(WalletError::NoteUnverified);
        }
        let path = self.tree.path(position).ok_or_else(|| WalletError::State("no Merkle path is kept for that position".into()))?;
        Ok(SpendInput { value: n.value, rho: n.rho.0, r: n.r.0, position, path })
    }

    // ---- pending transactions -----------------------------------------------------------------------

    /// The transactions that were handed out and not yet settled by [`WalletState::resolve`].
    pub fn pending(&self) -> &[PendingTx] {
        &self.pending
    }

    /// `true` while the note is an input of an entry of the pending list — whatever the scan has
    /// seen of that entry. Only [`WalletState::resolve`] ends a lock.
    pub fn is_locked(&self, position: u64) -> bool {
        self.note_at(position).is_some_and(|n| self.pending.iter().any(|p| p.locks(n)))
    }

    /// Records a built transfer or unshield (`BuiltTx::pending()`) and locks its inputs. Call it
    /// BEFORE the transaction leaves the wallet, and persist the state. From then on the inputs
    /// cannot be selected or handed to a builder until [`WalletState::resolve`] settles the
    /// entry on confirmed data. No answer of a node unlocks them.
    ///
    /// Refused: a record without two distinct nullifiers or two distinct non-zero output
    /// commitments; a change commitment that is not one of the outputs; an expiry more than 128
    /// blocks above the scanned height (the builders' bound — locked notes are released in
    /// bounded time); inputs that are not unspent, unlocked notes of this state whose values add
    /// up to `input_total`; an input whose stored nullifier is not the transaction's nullifier
    /// for that input slot.
    pub fn mark_pending(&mut self, mut tx: PendingTx) -> Result<(), WalletError> {
        let bad = |what: &'static str| Err(WalletError::Request(what.into()));
        if !TX_TYPES[1..].contains(&tx.tx_type.as_str()) {
            return bad("only a shielded_transfer_v2 or an unshield_v2 is recorded as pending");
        }
        if tx.nullifiers.len() != 2 || tx.nullifiers[0] == tx.nullifiers[1] {
            return bad("a pending transaction has two distinct nullifiers");
        }
        if tx.outputs.len() != 2 || tx.outputs[0] == tx.outputs[1] || tx.outputs.iter().any(|c| c.0 == [0u8; 32]) {
            return bad("a pending transaction has two distinct output commitments");
        }
        if tx.change.as_ref().is_some_and(|c| !tx.outputs.contains(&c.cm)) {
            return bad("the expected change is not one of the transaction's outputs");
        }
        if tx.expiry_height > self.next_height.saturating_sub(1).saturating_add(MAX_EXPIRY_OFFSET) {
            return bad("the expiry height is more than 128 blocks above the scanned height");
        }
        if !matches!(tx.inputs.len(), 1 | 2) || (tx.inputs.len() == 2 && tx.inputs[0] == tx.inputs[1]) {
            return bad("a pending transaction spends one or two distinct notes");
        }
        if self.pending.iter().filter(|p| !p.legacy).count() >= MAX_PENDING {
            return bad("too many pending transactions: resolve the list first");
        }
        if self.pending.iter().any(|p| p.nullifiers.iter().any(|n| tx.nullifiers.contains(n))) {
            return bad("this transaction is already recorded");
        }
        let mut total = 0u128;
        let mut cms = Vec::with_capacity(2);
        for (i, &pos) in tx.inputs.iter().enumerate() {
            let Some(n) = self.note_at(pos) else { return bad("a pending transaction's input is not a note of this state") };
            if n.spent {
                return bad("a pending transaction's input is already spent");
            }
            if self.is_locked(pos) {
                return Err(WalletError::NoteLocked);
            }
            if n.nullifier.is_some_and(|nf| nf != tx.nullifiers[i]) {
                return bad("the transaction does not spend that note (nullifier mismatch)");
            }
            total += n.value as u128;
            cms.push(n.cm);
        }
        if total != tx.input_total as u128 {
            return bad("input_total is not the value of the input notes");
        }
        tx.input_cms = cms;
        tx.status = PendingStatus::Pending;
        tx.seen_height = None;
        tx.rejected_hint = false;
        tx.legacy = false;
        self.pending.push(tx);
        self.bump();
        Ok(())
    }

    /// Records that a node answered "rejected" for the pending transaction with this nullifier.
    /// Only a flag for the UI: the transaction is still valid until its expiry height and its
    /// inputs stay locked (a node that lies about a rejection can still have it mined).
    pub fn note_rejection_hint(&mut self, nullifier: &[u8; 32]) -> bool {
        match self.pending.iter_mut().find(|p| p.nullifiers.iter().any(|n| n.0 == *nullifier)) {
            Some(p) => {
                p.rejected_hint = true;
                self.bump();
                true
            }
            None => false,
        }
    }

    /// Settles the pending list **against the confirmed height** and removes what is settled —
    /// the three outcomes of [`Resolution`]. An entry the scan has seen mined or superseded at a
    /// height ABOVE the confirmed height is not settled and not dropped: one node listed it,
    /// nobody vouched for it. Without a confirmed height nothing settles.
    ///
    /// Nothing here depends on what a node answered to the submission, on the scanned height, or
    /// on any other single node's word. There is no other way to release a lock.
    pub fn resolve(&mut self) -> Resolution {
        let mut out = Resolution::default();
        let Some(confirmed) = self.confirmed_height else {
            out.still_pending = self.pending.len();
            return out;
        };
        let mut keep = Vec::with_capacity(self.pending.len());
        for p in core::mem::take(&mut self.pending) {
            let seen_confirmed = p.seen_height.is_some_and(|h| h <= confirmed);
            match p.status {
                PendingStatus::SeenMined if seen_confirmed => out.mined.push(p),
                PendingStatus::SeenSuperseded if seen_confirmed => out.superseded.push(p),
                // not seen up to the confirmed height (a sighting above it is one node's word
                // about a block that cannot hold the transaction any more)
                _ if confirmed >= p.expiry_height => out.expired.push(p),
                _ => keep.push(p),
            }
        }
        out.still_pending = keep.len();
        self.pending = keep;
        if !(out.mined.is_empty() && out.superseded.is_empty() && out.expired.is_empty()) {
            self.bump();
        }
        out
    }

    // ---- state confirmation -------------------------------------------------------------------------

    /// Compares the wallet's own pool state with what nodes report, and moves the confirmed
    /// height to the highest height at which a quorum of distinct nodes reported **exactly the
    /// wallet's tree root, nullifier hash, note count and nullifier count**. Notes created at or
    /// below it become `confirmed`; pending transactions settle against it
    /// ([`WalletState::resolve`]).
    ///
    /// Why this is evidence. The root commits every output commitment up to that height in
    /// order; the nullifier hash commits every nullifier up to that height in order; a listed
    /// transaction is two consecutive entries of each. If both are the nodes', every transaction
    /// the wallet read up to that height — which nullifiers with which outputs — is one those
    /// nodes hold, and no other.
    ///
    /// **The quorum.** `quorum` (`None`: [`DEFAULT_CONFIRM_QUORUM`] = 2) is raised to a strict
    /// majority of the distinct node ids among the reports supplied: with four nodes asked,
    /// three must agree. A caller that asks one node — its own — passes `Some(1)`.
    ///
    /// **A conflict confirms nothing.** If, at any height the wallet can compare, a report is not
    /// the wallet's state, or one node made two different reports, the call confirms nothing at
    /// all and returns `diverged` with the heights. The caller resolves the conflict: it chooses
    /// which nodes it asks. Distinctness is by the caller-supplied id — see [`StateReport`].
    ///
    /// What it is not: proof against the chain. It is the word of the nodes asked. Reports for
    /// heights the wallet has not scanned, or whose state it no longer keeps, cannot be compared.
    pub fn confirm_state(&mut self, reports: &[StateReport], quorum: Option<usize>) -> Result<ConfirmReport, WalletError> {
        let asked = quorum.unwrap_or(DEFAULT_CONFIRM_QUORUM);
        if asked == 0 {
            return Err(WalletError::Request("the quorum must be at least 1".into()));
        }
        if reports.len() > MAX_STATE_REPORTS {
            return Err(WalletError::Request("more than 64 state reports".into()));
        }
        if reports.iter().any(|r| r.node_id.is_empty() || r.node_id.len() > MAX_NODE_ID_BYTES) {
            return Err(WalletError::Request("a node id must be 1 to 128 bytes".into()));
        }
        // height → node → what that node reported there
        let mut by_height: BTreeMap<u64, BTreeMap<&str, Vec<PoolView>>> = BTreeMap::new();
        let mut ids = BTreeSet::new();
        for r in reports {
            ids.insert(r.node_id.as_str());
            let views = by_height.entry(r.height).or_default().entry(r.node_id.as_str()).or_default();
            if !views.contains(&r.view()) {
                views.push(r.view());
            }
        }
        let quorum = asked.max(ids.len() / 2 + 1);
        let mut out = ConfirmReport { quorum, nodes: ids.len(), confirmed_height: self.confirmed_height, ..Default::default() };
        let mut matched: Option<(u64, usize)> = None;
        for (&height, nodes) in &by_height {
            let Some(mine) = self.state_at(height) else {
                out.not_comparable += nodes.len();
                continue;
            };
            let agreeing = nodes.values().filter(|views| views.as_slice() == [mine]).count();
            if agreeing != nodes.len() {
                out.conflicts.push(height);
            }
            if agreeing >= quorum {
                matched = Some((height, agreeing)); // ascending: the last match is the highest
            }
            out.agreeing = out.agreeing.max(agreeing);
        }
        if !out.conflicts.is_empty() {
            out.diverged = true;
            return Ok(out);
        }
        if let Some((h, agreeing)) = matched {
            out.matched_height = Some(h);
            out.agreeing = agreeing;
            let confirmed = self.confirmed_height.map_or(h, |c| c.max(h));
            for n in self.notes.iter_mut().filter(|n| !n.confirmed && n.height <= confirmed) {
                n.confirmed = true;
                out.newly_confirmed.push(n.position);
            }
            self.confirmed_height = Some(confirmed);
            out.confirmed_height = self.confirmed_height;
            out.pruned = self.prune();
            self.bump();
        }
        Ok(out)
    }

    /// Drops every spent note whose spend is more than [`PRUNE_RETENTION_BLOCKS`] below the
    /// confirmed height (and that no pending entry names) into the `pruned` tally. Balances are
    /// sums over unspent notes and do not change.
    fn prune(&mut self) -> usize {
        let Some(cutoff) = self.confirmed_height.and_then(|c| c.checked_sub(PRUNE_RETENTION_BLOCKS)) else { return 0 };
        let before = self.notes.len();
        let (pending, pruned) = (&self.pending, &mut self.pruned);
        self.notes.retain(|n| {
            let drop = n.spent_height.is_some_and(|h| h <= cutoff) && !pending.iter().any(|p| p.locks(n));
            if drop {
                pruned.add(n.value);
            }
            !drop
        });
        before - self.notes.len()
    }

    // ---- scanning -----------------------------------------------------------------------------------

    /// Consumes one page of the node's listing (spec §5.4, "Scanning"). For every transaction, in
    /// chain order:
    ///
    /// 1. both nullifiers enter the wallet's running nullifier hash (the pool's
    ///    `nullifier_acc_step`, in listing order);
    /// 2. a note of this wallet is marked spent **when its own nullifier appears, and only
    ///    then**. For an input of a pending transaction the note's nullifier is the entry's
    ///    nullifier of that input slot;
    /// 3. a pending transaction is marked `seen_mined` when the listed transaction has both its
    ///    nullifiers and both its output commitments, `seen_superseded` when the listed
    ///    transaction has one of its nullifiers and is not that. Neither settles it;
    /// 4. each output is appended to the wallet's tree at the position the chain gave it, and
    ///    trial-decrypted with the viewing key (`aad = cm_out_j`); if the tag verifies, the
    ///    recipient check of spec §2.4.1 is run with `rho = H_rho(nf1, nf2, j)` computed from the
    ///    transaction's own nullifiers — only a note whose recomputed commitment equals `cm_out_j`
    ///    is the wallet's. It is stored unverified (see `confirm_state`). A zero-value note, a
    ///    note below the state's minimum note value and a note beyond the state's capacity are
    ///    counted and not stored.
    ///
    /// **Every string of the page is validated before anything is stored**: nullifiers,
    /// commitments, ciphertexts and `tx_hash` are fixed-length lowercase hexadecimal, `tx_type`
    /// is one of the three V2 types.
    ///
    /// **Viewing key first, full key later** (F-3). While the state holds a note without a
    /// nullifier (it was found with `nk = None`), every nullifier that appears is remembered, up
    /// to [`MAX_BLIND_NULLIFIERS`]. When a key with `nk` is supplied, every missing nullifier is
    /// derived and every remembered spend is applied before the page. If more nullifiers
    /// appeared than the state could remember, the scan refuses with
    /// [`WalletError::RescanRequired`].
    ///
    /// The page must continue this state exactly (`from_height` and every leaf position); a page
    /// that does not is refused and the state is left untouched. An EMPTY state accepts a page
    /// that starts above its next height (the jump to the activation height); what such a page
    /// skipped is found out by `confirm_state`, whose nullifier hash and root then differ from
    /// the nodes'. The page is validated and trial-decrypted completely before the state is
    /// changed, in place: the whole page is applied or nothing.
    pub fn scan(&mut self, page: &ListingPage, key: &ScanKey) -> Result<ScanReport, WalletError> {
        let listing = |what: &'static str| WalletError::Listing(what.into());
        if key.pk != self.pk.0 {
            return Err(WalletError::Request("this state belongs to another wallet (pk differs)".into()));
        }
        if !page.active {
            return Ok(ScanReport { next_height: self.next_height, ..Default::default() });
        }
        let fresh = self.tree.note_count == 0;
        if page.from_height != self.next_height && !(fresh && page.from_height > self.next_height) {
            return Err(listing("the page does not start at the wallet's next height"));
        }
        if page.next_height < page.from_height {
            return Err(listing("next_height is below from_height"));
        }
        if page.next_height > page.from_height.max(page.tip_height.saturating_add(1)) {
            return Err(listing("next_height is above the node's own tip"));
        }
        if page.txs.len() > MAX_PAGE_TXS {
            return Err(listing("the page lists more than 4,096 transactions"));
        }
        self.validate()?;
        let pk = field::digest(&key.pk, "pk")?;
        let nk = match &key.nk {
            Some(nk) => Some(field::digest(nk, "nk")?),
            None => None,
        };
        let dk = key.decaps_key()?;

        // ---- pass 1: validate and trial-decrypt; the state is not touched --------------------------
        // F-3: the nullifiers the full key can now derive
        let mut fill: Vec<(usize, [u8; 32])> = Vec::new();
        if let Some(nk) = &nk {
            for (i, n) in self.notes.iter().enumerate().filter(|(_, n)| n.nullifier.is_none()) {
                fill.push((i, field::bytes(&nullifier(nk, &field::digest(&n.rho.0, "a stored note's rho")?))));
            }
            if !fill.is_empty() && self.blind.overflow {
                return Err(WalletError::RescanRequired);
            }
        }
        let room = (1u64 << TREE_DEPTH) - self.tree.note_count;
        if 2 * page.txs.len() as u64 > room {
            return Err(listing("the page has more outputs than the commitment tree has room for"));
        }
        let mut prepared: Vec<PreparedTx> = Vec::with_capacity(page.txs.len());
        let mut last: Option<(u64, u64)> = None;
        let mut expected_leaf = self.tree.note_count;
        for tx in &page.txs {
            if tx.height < page.from_height || tx.height >= page.next_height {
                return Err(listing("a transaction is outside the page's heights"));
            }
            if last.is_some_and(|l| (tx.height, tx.index) <= l) {
                return Err(listing("the transactions are not in chain order"));
            }
            last = Some((tx.height, tx.index));
            if !is_tx_hash(&tx.tx_hash) {
                return Err(listing("tx_hash is not 64 lowercase hexadecimal characters"));
            }
            if !TX_TYPES.contains(&tx.tx_type.as_str()) {
                return Err(listing("tx_type is not a shielded pool V2 type"));
            }
            if tx.outputs.len() != 2 {
                return Err(listing("a transaction must list exactly two outputs"));
            }
            let nf_b = [
                hex32(&tx.nf1).ok_or_else(|| listing("nf1 is not 32 bytes of lowercase hex"))?,
                hex32(&tx.nf2).ok_or_else(|| listing("nf2 is not 32 bytes of lowercase hex"))?,
            ];
            let nf = [field::digest(&nf_b[0], "nf1")?, field::digest(&nf_b[1], "nf2")?];
            if nf_b[0] == nf_b[1] {
                return Err(listing("a listed transaction has nf1 = nf2"));
            }
            let mut outs: [Option<PreparedOutput>; 2] = [None, None];
            for (j, out) in tx.outputs.iter().enumerate() {
                let cm_b = hex32(&out.cm_out).ok_or_else(|| listing("cm_out is not 32 bytes of lowercase hex"))?;
                let cm = field::digest(&cm_b, "cm_out")?;
                let kem: [u8; KEM_CT_BYTES] = hex_exact(&out.kem_ct).ok_or_else(|| listing("kem_ct is not 1,088 bytes of lowercase hex"))?;
                let note_ct: [u8; NOTE_CT_BYTES] = hex_exact(&out.note_ct).ok_or_else(|| listing("note_ct is not 56 bytes of lowercase hex"))?;
                let leaf = out.leaf.ok_or_else(|| listing("an output has no leaf position"))?;
                if leaf != expected_leaf {
                    return Err(listing(
                        "an output is not at the leaf position the wallet's tree expects next (missed transactions or a reorganisation)",
                    ));
                }
                expected_leaf += 1;
                // trial decryption, then the recipient check of spec §2.4.1; a zero-value note
                // is nothing to keep
                let mine = decrypt_note(&dk, &kem, &note_ct, &cm_b).and_then(|(value, r_b)| {
                    let r = field::digest(&r_b, "r").ok()?;
                    let rho = derive_rho(&nf, j);
                    (value > 0 && Note { value, pk, rho, r }.commitment() == cm).then_some((value, r_b, rho))
                });
                outs[j] = Some(PreparedOutput { cm: cm_b, mine });
            }
            let [Some(o0), Some(o1)] = outs else { return Err(WalletError::Internal("outputs")) };
            prepared.push(PreparedTx { height: tx.height, nf: nf_b, tx_hash: tx.tx_hash.clone(), outputs: [o0, o1] });
        }

        // ---- pass 2: apply. Nothing below can fail (the tree was checked, its room measured) -------
        let mut report = ScanReport::default();
        if !fill.is_empty() {
            for (i, nf) in fill {
                self.notes[i].nullifier = Some(B32(nf));
            }
            for seen in core::mem::take(&mut self.blind.seen) {
                mark_spent(&mut self.notes, &mut self.tree, &mut report, seen.height, |n| n.nullifier == Some(seen.nf));
            }
        }
        if nk.is_some() {
            // every note has its nullifier now: nothing is blind
            self.blind = BlindLog::default();
        }
        // the nullifiers that would spend a note of this wallet (most listed ones spend none)
        let mut own_nf: BTreeSet<[u8; 32]> = self.notes.iter().filter(|n| n.spent_height.is_none()).filter_map(|n| n.nullifier.map(|x| x.0)).collect();
        for tx in prepared {
            // F-3: without nk, remember what appears while a note has no nullifier
            if nk.is_none() && self.notes.iter().any(|n| n.nullifier.is_none() && n.spent_height.is_none()) {
                for nf in tx.nf {
                    if self.blind.seen.len() < MAX_BLIND_NULLIFIERS {
                        self.blind.seen.push(SeenNullifier { nf: B32(nf), height: tx.height });
                    } else {
                        self.blind.overflow = true;
                    }
                }
            }
            let cms = [tx.outputs[0].cm, tx.outputs[1].cm];
            for nf in tx.nf {
                // 1. the pool's running nullifier hash
                self.nullifier_acc = B32(nullifier_acc_step(&self.nullifier_acc.0, &nf));
                self.nullifier_count += 1;
                // 2. a note is spent when its own nullifier appears
                if own_nf.remove(&nf) {
                    mark_spent(&mut self.notes, &mut self.tree, &mut report, tx.height, |n| n.nullifier == Some(B32(nf)));
                }
            }
            for p in self.pending.iter_mut().filter(|p| p.nullifiers.iter().any(|x| tx.nf.contains(&x.0))) {
                // 2. … also when the note has no stored nullifier (found with the viewing key):
                // the entry's nullifier of slot i is the nullifier of its input i
                for i in 0..p.inputs.len().min(p.nullifiers.len()) {
                    if tx.nf.contains(&p.nullifiers[i].0) {
                        let (cm, pos) = (p.input_cms.get(i).copied(), p.inputs[i]);
                        mark_spent(&mut self.notes, &mut self.tree, &mut report, tx.height, |n| match cm {
                            Some(cm) => n.cm == cm,
                            None => n.position == pos,
                        });
                    }
                }
                // 3. what the listing shows of the entry: its own transaction, or another one
                if p.status == PendingStatus::Pending {
                    let same_nullifiers = p.nullifiers.len() == 2 && p.nullifiers[0].0 == tx.nf[0] && p.nullifiers[1].0 == tx.nf[1];
                    let same_outputs = match p.outputs.as_slice() {
                        [a, b] => a.0 == cms[0] && b.0 == cms[1],
                        // migrated from format 2: the change commitment is the output it knows
                        _ => !p.legacy && p.change.as_ref().is_some_and(|c| cms.contains(&c.cm.0)),
                    };
                    if same_nullifiers && same_outputs {
                        p.status = PendingStatus::SeenMined;
                        report.pending_seen_mined += 1;
                    } else {
                        p.status = PendingStatus::SeenSuperseded;
                        report.pending_seen_superseded += 1;
                    }
                    p.seen_height = Some(tx.height);
                }
            }
            // 4. outputs
            for (j, out) in tx.outputs.into_iter().enumerate() {
                let store = match &out.mine {
                    Some((value, _, _)) if *value < self.min_note_value => {
                        self.below_minimum.add(*value);
                        report.not_stored += 1;
                        false
                    }
                    Some((value, _, _)) if self.notes.len() >= MAX_STORED_NOTES => {
                        self.over_capacity.add(*value);
                        report.not_stored += 1;
                        false
                    }
                    Some(_) => true,
                    None => false,
                };
                let leaf = self.tree.append(&out.cm, store).map_err(|_| WalletError::Internal("the tree refused a checked leaf"))?;
                if let (true, Some((value, r_b, rho))) = (store, out.mine) {
                    let nf = nk.as_ref().map(|nk| B32(field::bytes(&nullifier(nk, &rho))));
                    if let Some(nf) = nf {
                        own_nf.insert(nf.0);
                    }
                    // a lock follows its note: the entry names the position the note has here
                    for p in self.pending.iter_mut() {
                        if let Some(i) = p.input_cms.iter().position(|c| c.0 == out.cm) {
                            p.inputs[i] = leaf;
                        }
                    }
                    self.notes.push(OwnedNote {
                        value,
                        r: B32(r_b),
                        rho: B32(field::bytes(&rho)),
                        position: leaf,
                        cm: B32(out.cm),
                        nullifier: nf,
                        spent: false,
                        spent_height: None,
                        height: tx.height,
                        tx_hash: tx.tx_hash.clone(),
                        output_index: j as u8,
                        confirmed: false,
                    });
                    report.received.push(leaf);
                }
            }
            // the pool state after this height so far (what `confirm_state` compares)
            let c = Checkpoint {
                height: tx.height,
                root: self.tree.root,
                nullifier_acc: self.nullifier_acc,
                note_count: self.tree.note_count,
                nullifier_count: self.nullifier_count,
            };
            match self.checkpoints.last_mut() {
                Some(last) if last.height >= tx.height => *last = c,
                _ => self.checkpoints.push(c),
            }
            if self.checkpoints.len() > MAX_CHECKPOINTS {
                self.checkpoints.remove(0);
            }
            report.txs += 1;
        }
        self.next_height = page.next_height;
        report.next_height = page.next_height;
        report.at_tip = page.next_height > page.tip_height;
        self.bump();
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use quantum_vault_shield_v2::reference::{root_from_path, SparseTree};

    fn leaf(i: u64) -> [u8; 32] {
        let mut b = [0u8; 32];
        b[..8].copy_from_slice(&(i * 7919 + 1).to_le_bytes()[..8]);
        b[3] &= 0x7e; // keep the first word below p
        b[7] &= 0x7e;
        b
    }

    /// The tracker against the reference sparse tree: root, frontier-driven appends and every
    /// tracked path after every append, across several carries — while leaves are forgotten in
    /// between, which must drop exactly the nodes no remaining path needs.
    #[test]
    fn tracker_matches_the_reference_tree() {
        let mut t = TreeTracker::new();
        let mut reference = SparseTree::new();
        assert_eq!(t.root(), field::bytes(&reference.root()));
        let tracked = [0u64, 1, 2, 5, 7, 8, 21, 22, 23, 40, 41, 64, 69];
        // (after which append, which leaf is forgotten)
        let forgotten = [(9u64, 1u64), (30, 22), (45, 0), (50, 40), (66, 64)];
        let mut live: Vec<u64> = Vec::new();
        for i in 0..70u64 {
            let l = leaf(i);
            assert_eq!(t.append(&l, tracked.contains(&i)).unwrap(), i);
            if tracked.contains(&i) {
                live.push(i);
            }
            reference.insert(i as u32, field::digest(&l, "l").unwrap());
            for &(_, gone) in forgotten.iter().filter(|(at, _)| *at == i) {
                t.forget(gone);
                live.retain(|&p| p != gone);
                assert!(t.path(gone).is_none());
            }
            assert_eq!(t.root(), field::bytes(&reference.root()), "root after leaf {i}");
            for &p in &live {
                let path = t.path(p).unwrap();
                let want: Vec<[u8; 32]> = reference.path(p as u32).iter().map(field::bytes).collect();
                assert_eq!(path, want, "path of {p} after leaf {i}");
                let arr: [Digest; 32] = core::array::from_fn(|k| field::digest(&path[k], "s").unwrap());
                assert_eq!(root_from_path(&field::digest(&leaf(p), "l").unwrap(), p as u32, &arr), reference.root());
            }
            // exactly the nodes of the live paths, each once
            let needed: BTreeSet<(u8, u64)> = live.iter().flat_map(|&p| (0..TREE_DEPTH).map(move |l| (l as u8, (p >> l) ^ 1))).collect();
            assert_eq!(t.nodes.keys().copied().collect::<BTreeSet<_>>(), needed, "stored nodes after leaf {i}");
            // the frontier convention of spec §4.8: zero where the bit of note_count is 0
            for (lvl, f) in t.frontier().iter().enumerate() {
                assert_eq!(*f == [0u8; 32], (t.note_count() >> lvl) & 1 == 0, "frontier[{lvl}] at count {}", t.note_count());
            }
            t.check().unwrap();
        }
        assert_eq!(t.tracked(), live.len());
        assert!(t.stored_nodes() < TREE_DEPTH * live.len(), "paths share their upper nodes");
        // serialisation round-trip
        let json = serde_json::to_string(&t).unwrap();
        assert_eq!(serde_json::from_str::<TreeTracker>(&json).unwrap(), t);
        // forgetting everything leaves nothing
        for p in live {
            t.forget(p);
        }
        assert_eq!((t.tracked(), t.stored_nodes()), (0, 0));
    }

    /// Neighbouring leaves share their paths: about two nodes per leaf, not 32.
    #[test]
    fn tracker_stores_about_two_nodes_per_neighbouring_leaf() {
        let mut t = TreeTracker::new();
        for i in 0..1_000u64 {
            t.append(&leaf(i), true).unwrap();
        }
        assert!(t.stored_nodes() <= 2 * 1_000 + TREE_DEPTH, "{}", t.stored_nodes());
    }

    #[test]
    fn state_json_is_validated() {
        let s = WalletState::new([1u8; 32]);
        let json = s.to_json().unwrap();
        assert_eq!(WalletState::from_json(&json).unwrap(), s);
        assert!(json.contains("\"version\":3") && json.contains("\"revision\":0"));
        assert!(WalletState::from_json("{}").is_err());
        assert!(WalletState::from_json(&json.replace("\"version\":3", "\"version\":4")).is_err());
        assert!(WalletState::from_json(&json.replace("\"note_count\":0", "\"note_count\":18446744073709551615")).is_err());
        assert!(WalletState::from_json(&json.replace("\"min_note_value\":\"1000000000\"", "\"min_note_value\":\"0\"")).is_err());
        // a truncated frontier is refused, not indexed out of bounds later
        let mut v: serde_json::Value = serde_json::from_str(&json).unwrap();
        v["tree"]["frontier"].as_array_mut().unwrap().pop();
        assert!(WalletState::from_json(&v.to_string()).is_err());
        // a nullifier hash that is not the history's last entry is refused
        let mut v: serde_json::Value = serde_json::from_str(&json).unwrap();
        v["nullifier_acc"] = serde_json::json!("11".repeat(32));
        assert!(WalletState::from_json(&v.to_string()).is_err());
        assert!(WalletState::with_min_note_value([1u8; 32], 0).is_err());
        assert!(s.expect_revision(0).is_ok() && matches!(s.expect_revision(1), Err(WalletError::StaleState)));
    }
}
