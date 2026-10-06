//! The wallet's own note data and note tree (spec §5.4), pending transactions, and scanning.
//!
//! [`WalletState`] is everything a wallet persists for the shielded pool besides its keys: every
//! note it owns (value, `r`, `rho`, leaf position, commitment, nullifier, spent flag, height,
//! confirmation status), the frontier of the commitment tree and one Merkle path per unspent
//! note, kept current as leaves are appended, the height the scan has reached, the tree roots of
//! the recent heights, and **the transactions the wallet has built and handed out that are
//! neither mined nor expired** ([`PendingTx`]). It serialises to JSON (`to_json` / `from_json`,
//! format version 2; version 1 is migrated). It contains note secrets (`r`, values) but no key:
//! the caller encrypts it at rest like the rest of the wallet.
//!
//! [`WalletState::scan`] consumes one page of the node's `GET /api/shield-v2/notes` listing:
//! every accepted V2 transaction in chain order with its two nullifiers, two output commitments
//! (with leaf positions) and two `(kem_ct, note_ct)` pairs. The wallet downloads everything in
//! bulk and never asks a node for one position's path (spec §5.4).
//!
//! **What a listing proves, and what it does not** (REVIEW_WALLET_1 F-1). A note the scan finds
//! is authenticated against the commitment and the nullifiers *of the same listing*. Nothing in
//! this crate can tie one node's listing to the chain: the chain has no light-client proofs yet.
//! A node that knows the wallet's address can therefore list a payment that is on no chain.
//! Every note is stored `confirmed: false` until [`WalletState::confirm_roots`] has matched the
//! wallet's own tree root at a height at or above the note's against the root reported for that
//! height by a quorum of nodes the caller chose (default: 2 distinct nodes); balances are
//! reported separately and coin selection ignores unverified notes unless told otherwise.
//!
//! **Pending transactions** (F-7). A signer-less transaction that has left the wallet stays valid
//! until its `expiry_height`, whatever a node answered when it was submitted. Its inputs are
//! locked from [`WalletState::mark_pending`] until the *scanned chain data* shows one of two
//! things: one of its nullifiers (mined: the inputs are spent), or a scanned height at or above
//! `expiry_height` without them (it can never be mined: [`WalletState::resolve`] releases the
//! inputs). A "rejected" answer is recorded as a hint for the UI and changes nothing else.
//!
//! A restored wallet is `WalletState::new(pk)` plus a scan from the activation height: it
//! recovers every note ever delivered to its address through conforming ciphertexts, which of
//! them are spent, the balance and the Merkle paths — and nothing about what it sent to others.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use quantum_vault_shield_v2::reference::{derive_rho, merge, nullifier, Digest, Note, ZERO_DIGEST};
use serde::{Deserialize, Serialize};

use crate::error::{json_error, WalletError};
use crate::field;
use crate::keys::{ScanKey, KEM_CT_BYTES};
use crate::note_enc::{decrypt_note, NOTE_CT_BYTES};
use crate::tx::MAX_EXPIRY_OFFSET;

pub const TREE_DEPTH: usize = 32;
/// The format version `to_json` writes. `from_json` also reads version 1 and migrates it.
pub const STATE_VERSION: u32 = 2;
/// [`WalletState::confirm_roots`]: how many distinct nodes must report the wallet's root.
pub const DEFAULT_CONFIRM_QUORUM: usize = 2;
/// Root reports taken by one `confirm_roots` call, and the longest node id.
pub const MAX_ROOT_REPORTS: usize = 64;
pub const MAX_NODE_ID_BYTES: usize = 128;
/// Heights at which the tree changed whose roots the state keeps (oldest dropped first).
pub const MAX_CHECKPOINTS: usize = 256;
/// Transactions the wallet can have pending at once.
pub const MAX_PENDING: usize = 64;
/// Nullifiers a state remembers while it is scanned without `nk` (F-3); beyond that it asks for
/// a rescan when the full key arrives.
pub const MAX_BLIND_NULLIFIERS: usize = 1_024;
/// Size limits on what is parsed: one listing page (the node sends at most 512 transactions,
/// about 2.4 MB) and one state blob.
pub const MAX_PAGE_TXS: usize = 4_096;
pub const MAX_LISTING_JSON_BYTES: usize = 32 << 20;
pub const MAX_STATE_JSON_BYTES: usize = 256 << 20;

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

/// The append-only commitment tree of spec §2.6 / §4.3 as a wallet keeps it: the frontier (what
/// is needed to append the next leaf) and, for every tracked leaf, its 32 siblings, updated as
/// later leaves arrive. No full tree is stored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TreeTracker {
    note_count: u64,
    /// `frontier[l]`: the root of the complete left subtree of height `l` that is waiting for its
    /// right sibling, if bit `l` of `note_count` is 1; zeros otherwise (as in spec §4.8).
    frontier: Vec<B32>,
    root: B32,
    /// leaf position → 32 siblings, leaf level first
    witnesses: BTreeMap<u64, Vec<B32>>,
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
            witnesses: BTreeMap::new(),
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
    /// The 32 siblings of a tracked leaf against the current root.
    pub fn path(&self, position: u64) -> Option<Vec<[u8; 32]>> {
        self.witnesses.get(&position).map(|p| p.iter().map(|b| b.0).collect())
    }
    pub fn forget(&mut self, position: u64) {
        self.witnesses.remove(&position);
    }
    pub fn tracked(&self) -> usize {
        self.witnesses.len()
    }

    fn check(&self) -> Result<(), WalletError> {
        if self.frontier.len() != TREE_DEPTH || self.witnesses.values().any(|p| p.len() != TREE_DEPTH) {
            return Err(WalletError::State("the tree tracker has a path of the wrong length".into()));
        }
        if self.note_count > 1u64 << TREE_DEPTH || self.witnesses.keys().any(|&p| p >= self.note_count) {
            return Err(WalletError::State("the tree tracker's counters are inconsistent".into()));
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
    /// Cost: 32 hashes, plus 32 comparisons per tracked leaf.
    pub fn append(&mut self, leaf: &[u8; 32], track: bool) -> Result<u64, WalletError> {
        let n = self.note_count;
        if n >= 1u64 << TREE_DEPTH {
            return Err(WalletError::State("the commitment tree is full".into()));
        }
        let empty = empty_roots();
        let mut node = field::digest(leaf, "a leaf")?;
        let mut own = track.then(|| vec![B32([0u8; 32]); TREE_DEPTH]);
        let mut carried = true; // still inside the complete subtree that ends at leaf n
        for l in 0..TREE_DEPTH {
            // `node` is the value of the tree node (level l, index n >> l) after this insertion
            let idx = n >> l;
            let node_b = B32(field::bytes(&node));
            for (&p, path) in self.witnesses.iter_mut() {
                if (p >> l) ^ 1 == idx {
                    path[l] = node_b;
                }
            }
            if idx & 1 == 0 {
                // a left child: its right sibling is still empty
                if let Some(o) = own.as_mut() {
                    o[l] = B32(field::bytes(&empty[l]));
                }
                if carried {
                    self.frontier[l] = node_b; // complete, waiting for its right sibling
                    carried = false;
                }
                node = merge(&node, &empty[l]);
            } else {
                // a right child: the left sibling is the frontier entry of this level
                let left = field::digest(&self.frontier[l].0, "a frontier entry")?;
                if let Some(o) = own.as_mut() {
                    o[l] = self.frontier[l];
                }
                if carried {
                    self.frontier[l] = B32([0u8; 32]); // consumed: bit l of the new count is 0
                }
                node = merge(&left, &node);
            }
        }
        self.root = B32(field::bytes(&node));
        self.note_count = n + 1;
        if let Some(o) = own {
            self.witnesses.insert(n, o);
        }
        Ok(n)
    }
}

// ---- notes -----------------------------------------------------------------------------------------

/// What the wallet keeps for every note it owns (spec §5.4). Zero-value notes are not stored.
/// Secret (`value`, `r`): `Debug` prints neither.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
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
    /// wallet's tree root at a height at or above the note's was matched against the root a
    /// quorum of nodes reported ([`WalletState::confirm_roots`]).
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

/// What one call of [`WalletState::scan`] found.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ScanReport {
    /// transactions read from the page
    pub txs: usize,
    /// positions of the notes found for this wallet (all `unverified` until `confirm_roots`)
    pub received: Vec<u64>,
    /// positions of this wallet's notes whose nullifier appeared
    pub spent: Vec<u64>,
    /// pending transactions of this wallet the page showed mined
    pub pending_mined: usize,
    /// where the next page starts
    pub next_height: u64,
    /// `true` when the page reached the node's tip
    pub at_tip: bool,
}

// ---- pending transactions --------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PendingStatus {
    /// Handed out, neither seen mined nor expired: its inputs are locked.
    Pending,
    /// One of its nullifiers appeared in the scanned listing: its inputs are spent.
    Mined,
    /// The scan passed its `expiry_height` without its nullifiers: its inputs are released.
    Expired,
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

/// A transaction the wallet built and handed out (REVIEW_WALLET_1 F-7). Made by
/// `BuiltTx::pending()`; recorded with [`WalletState::mark_pending`] BEFORE the transaction is
/// submitted anywhere. `Debug` prints no amount.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingTx {
    /// `shielded_transfer_v2` or `unshield_v2`.
    pub tx_type: String,
    /// The transaction's two nullifiers (a dummy input's included): either one in the scanned
    /// listing means the transaction was mined. (A state migrated from format 1 can hold an
    /// entry with fewer — see `expiry_height`.)
    pub nullifiers: Vec<B32>,
    /// Leaf positions of the one or two notes it spends: locked while `status` is `pending`.
    pub inputs: Vec<u64>,
    /// The total value of those notes, quanta.
    #[serde(with = "dec")]
    pub input_total: u64,
    /// The change the wallet expects back.
    pub change: Option<PendingChange>,
    /// The last height at which the node accepts the transaction. `None` only in an entry
    /// migrated from state format 1, whose expiry is not known: such an entry is never released
    /// by expiry.
    pub expiry_height: Option<u64>,
    pub status: PendingStatus,
    /// Set with `status: mined`.
    pub mined_height: Option<u64>,
    /// A node answered "rejected" when the transaction was submitted. **A hint for the UI and
    /// nothing else**: the transaction is still valid until `expiry_height`, and the inputs stay
    /// locked.
    pub rejected_hint: bool,
}

impl core::fmt::Debug for PendingTx {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(
            f,
            "PendingTx {{ tx_type: {:?}, nullifiers: {:?}, inputs: {:?}, expiry_height: {:?}, status: {:?}, mined_height: {:?}, rejected_hint: {}, input_total: <secret>, change: {:?} }}",
            self.tx_type, self.nullifiers, self.inputs, self.expiry_height, self.status, self.mined_height, self.rejected_hint, self.change
        )
    }
}

/// When [`WalletState::resolve`] may declare a pending transaction expired.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReleasePolicy {
    /// The wallet's scanned height is at or above `expiry_height`. One node's listing decides.
    Scanned,
    /// The height confirmed by [`WalletState::confirm_roots`] is at or above `expiry_height`:
    /// the tree the wallet built without the transaction's outputs is the one a quorum of nodes
    /// reports at that height. A node that lies about the chain's height cannot trigger a
    /// release under this policy.
    Confirmed,
}

/// What [`WalletState::resolve`] removed from the pending list.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Resolution {
    /// Seen mined by the scan; their inputs are spent, their change arrived as a note.
    pub mined: Vec<PendingTx>,
    /// Expired without being mined; their inputs are spendable again.
    pub expired: Vec<PendingTx>,
    /// Entries that are still pending (inputs still locked).
    pub still_pending: usize,
}

// ---- root confirmation -----------------------------------------------------------------------------

/// One node's statement "at `height` the pool's tree root is `root`" (from its
/// `/api/shield-v2/stats`: `tip_height` and `pool.latest_anchor`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RootReport {
    /// The caller's name for the node. Only its distinctness is used: two reports with one id
    /// count once. Choosing nodes that are in fact independent is the caller's job.
    pub node_id: String,
    pub height: u64,
    pub root: [u8; 32],
}

/// What [`WalletState::confirm_roots`] concluded.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ConfirmReport {
    /// The quorum that was applied.
    pub quorum: usize,
    /// The highest height at which the quorum matched in THIS call.
    pub matched_height: Option<u64>,
    /// The highest height the state has ever had confirmed.
    pub confirmed_height: Option<u64>,
    /// Positions of the notes this call moved from unverified to confirmed.
    pub newly_confirmed: Vec<u64>,
    /// Distinct nodes whose report matched the wallet's root at `matched_height` (or, without a
    /// match, the best count reached at any height).
    pub agreeing: usize,
    /// Reports for heights the wallet has not scanned yet or no longer keeps a root for.
    pub not_comparable: usize,
    /// `true`: at some height at least `quorum` distinct nodes reported one root and it is NOT
    /// the wallet's. The wallet's listing does not match the chain those nodes see — rebuild
    /// from an empty state (`fresh_for_rescan`) against another node.
    pub diverged: bool,
}

/// The tree root after the block at `height` (recorded at the heights where it changed).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Checkpoint {
    height: u64,
    root: B32,
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
    /// More than [`MAX_BLIND_NULLIFIERS`] appeared (or the state was migrated from a format that
    /// did not keep them): the log is incomplete and the full key needs a rescan.
    overflow: bool,
}

/// The four balances of a state, quanta.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Balances {
    /// Unspent notes confirmed by [`WalletState::confirm_roots`].
    pub confirmed: u128,
    /// Unspent notes known from one node's listing only. NOT money the user can rely on.
    pub unverified: u128,
    /// Of the two above: inputs of pending transactions.
    pub locked: u128,
    /// Confirmed, unlocked: what default coin selection can use.
    pub spendable: u128,
}

/// The persistent shielded-pool state of one wallet.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WalletState {
    version: u32,
    /// The wallet's `pk`: a state is scanned with one key only.
    pk: B32,
    /// The next height to ask the node for (`since`).
    next_height: u64,
    tree: TreeTracker,
    notes: Vec<OwnedNote>,
    pending: Vec<PendingTx>,
    checkpoints: Vec<Checkpoint>,
    confirmed_height: Option<u64>,
    blind: BlindLog,
}

/// State format 1 (before REVIEW_WALLET_1), read only to be migrated.
#[derive(Deserialize)]
struct WalletStateV1 {
    pk: B32,
    next_height: u64,
    tree: TreeTracker,
    notes: Vec<OwnedNoteV1>,
}

#[derive(Deserialize)]
struct OwnedNoteV1 {
    #[serde(with = "dec")]
    value: u64,
    r: B32,
    rho: B32,
    position: u64,
    cm: B32,
    nullifier: Option<B32>,
    spent: bool,
    spent_height: Option<u64>,
    height: u64,
    tx_hash: String,
    output_index: u8,
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

impl WalletState {
    /// An empty state for the wallet whose address has this `pk`. Scanning it from height 0 is
    /// the restore of spec §5.4.
    pub fn new(pk: [u8; 32]) -> Self {
        let tree = TreeTracker::new();
        Self {
            version: STATE_VERSION,
            pk: B32(pk),
            next_height: 0,
            checkpoints: vec![Checkpoint { height: 0, root: tree.root }],
            tree,
            notes: Vec::new(),
            pending: Vec::new(),
            confirmed_height: None,
            blind: BlindLog::default(),
        }
    }

    /// An empty state for the same wallet that KEEPS the pending transactions: what to rescan
    /// into after a reorganisation or a `diverged` root check. Dropping the pending list instead
    /// (`WalletState::new`) would unlock notes whose transactions may still be mined.
    pub fn fresh_for_rescan(&self) -> Self {
        let mut s = Self::new(self.pk.0);
        s.pending = self.pending.clone();
        s
    }

    pub fn to_json(&self) -> Result<String, WalletError> {
        serde_json::to_string(self).map_err(|_| WalletError::Internal("state encoding"))
    }

    /// Parses and validates a state. Format 2 is read as is. **Format 1 is migrated**: every note
    /// becomes `confirmed: false`; a zero-value note is dropped; a `tx_hash` that is not 64
    /// lowercase hexadecimal characters is cleared; a note that was marked spent locally (no
    /// `spent_height`) becomes the input of a pending entry with its nullifier (if known) and no
    /// expiry — it stays locked until that nullifier is seen or the state is rebuilt; the root
    /// history starts at the scanned height; and a state holding a note without a nullifier asks
    /// for a rescan when the full key is first supplied.
    pub fn from_json(json: &str) -> Result<Self, WalletError> {
        if json.len() > MAX_STATE_JSON_BYTES {
            return Err(WalletError::State("the state is larger than 256 MiB".into()));
        }
        let bad = |e: serde_json::Error| WalletError::State(json_error("wallet state", &e));
        let v: VersionOnly = serde_json::from_str(json).map_err(bad)?;
        let s = match v.version {
            1 => Self::migrate_v1(serde_json::from_str(json).map_err(bad)?),
            STATE_VERSION => serde_json::from_str(json).map_err(bad)?,
            _ => return Err(WalletError::State("unknown state version (this wallet reads versions 1 and 2)".into())),
        };
        s.validate()?;
        Ok(s)
    }

    fn migrate_v1(old: WalletStateV1) -> Self {
        let mut pending = Vec::new();
        let mut notes = Vec::with_capacity(old.notes.len());
        let mut blind = BlindLog::default();
        for n in old.notes {
            if n.value == 0 {
                continue;
            }
            // marked spent locally by format 1's `mark_pending_spent`: an unknown transaction may
            // still spend it. Beyond MAX_PENDING the note simply stays spent (locked for good).
            let lock = n.spent && n.spent_height.is_none() && pending.len() < MAX_PENDING;
            if lock {
                pending.push(PendingTx {
                    tx_type: String::new(),
                    nullifiers: n.nullifier.into_iter().collect(),
                    inputs: vec![n.position],
                    input_total: n.value,
                    change: None,
                    expiry_height: None,
                    status: PendingStatus::Pending,
                    mined_height: None,
                    rejected_hint: false,
                });
            }
            if n.nullifier.is_none() && !n.spent {
                blind.overflow = true;
            }
            notes.push(OwnedNote {
                value: n.value,
                r: n.r,
                rho: n.rho,
                position: n.position,
                cm: n.cm,
                nullifier: n.nullifier,
                spent: n.spent && !lock,
                spent_height: n.spent_height,
                height: n.height,
                tx_hash: if is_tx_hash(&n.tx_hash) { n.tx_hash } else { String::new() },
                output_index: n.output_index,
                confirmed: false,
            });
        }
        let checkpoints = vec![Checkpoint { height: old.next_height.saturating_sub(1), root: old.tree.root }];
        Self { version: STATE_VERSION, pk: old.pk, next_height: old.next_height, tree: old.tree, notes, pending, checkpoints, confirmed_height: None, blind }
    }

    fn validate(&self) -> Result<(), WalletError> {
        let bad = |what: &'static str| Err(WalletError::State(what.into()));
        if self.version != STATE_VERSION {
            return bad("unknown state version");
        }
        self.tree.check()?;
        let mut seen = std::collections::BTreeSet::new();
        for n in &self.notes {
            if n.position >= self.tree.note_count || !seen.insert(n.position) || n.output_index > 1 {
                return bad("a stored note is inconsistent with the tree");
            }
            if !(n.tx_hash.is_empty() || is_tx_hash(&n.tx_hash)) {
                return bad("a stored note's tx_hash is not 64 lowercase hexadecimal characters");
            }
        }
        if self.pending.len() > MAX_PENDING {
            return bad("too many pending transactions");
        }
        for p in &self.pending {
            let inputs_ok = matches!(p.inputs.len(), 1 | 2) && (p.inputs.len() == 1 || p.inputs[0] != p.inputs[1]);
            let nf_ok = p.nullifiers.len() <= 2 && (p.nullifiers.len() < 2 || p.nullifiers[0] != p.nullifiers[1]);
            let type_ok = p.tx_type.is_empty() || TX_TYPES[1..].contains(&p.tx_type.as_str());
            if !inputs_ok || !nf_ok || !type_ok || (p.status == PendingStatus::Mined) != p.mined_height.is_some() {
                return bad("a pending transaction is malformed");
            }
        }
        if self.checkpoints.is_empty() || self.checkpoints.len() > MAX_CHECKPOINTS {
            return bad("the root history is empty or too long");
        }
        let top = self.next_height.max(1);
        if self.checkpoints.windows(2).any(|w| w[0].height >= w[1].height) || self.checkpoints.iter().any(|c| c.height >= top) {
            return bad("the root history is not in order");
        }
        if self.checkpoints.last().is_some_and(|c| c.root != self.tree.root) {
            return bad("the root history does not end at the tree's root");
        }
        if self.confirmed_height.is_some_and(|h| h >= self.next_height) {
            return bad("the confirmed height is above the scanned height");
        }
        if self.blind.seen.len() > MAX_BLIND_NULLIFIERS {
            return bad("the blind-scan log is too long");
        }
        Ok(())
    }

    pub fn pk(&self) -> [u8; 32] {
        self.pk.0
    }
    /// `since` of the next listing request.
    pub fn next_height(&self) -> u64 {
        self.next_height
    }
    /// The last height the scan has covered completely; `None` before the first page.
    pub fn scanned_height(&self) -> Option<u64> {
        self.next_height.checked_sub(1)
    }
    /// The highest height at which `confirm_roots` matched a quorum.
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
    /// The wallet's own tree root after the block at `height`: `None` for a height the scan has
    /// not covered, or one older than the root history kept.
    pub fn root_at(&self, height: u64) -> Option<[u8; 32]> {
        if height >= self.next_height {
            return None;
        }
        self.checkpoints.iter().rev().find(|c| c.height <= height).map(|c| c.root.0)
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
            let locked = self.is_locked(n.position);
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
        b
    }
    pub fn unspent(&self) -> impl Iterator<Item = &OwnedNote> {
        self.notes.iter().filter(|n| !n.spent)
    }
    pub fn note_at(&self, position: u64) -> Option<&OwnedNote> {
        self.notes.iter().find(|n| n.position == position)
    }

    /// The note at `position` with its current Merkle path, ready for a builder. Refuses a spent
    /// note and a note locked by a pending transaction ([`WalletError::NoteLocked`]).
    pub fn spend_input(&self, position: u64) -> Result<SpendInput, WalletError> {
        let n = self.note_at(position).ok_or_else(|| WalletError::Request("no note at that position".into()))?;
        if n.spent {
            return Err(WalletError::Request("the note at that position is already spent".into()));
        }
        if self.is_locked(position) {
            return Err(WalletError::NoteLocked);
        }
        let path = self.tree.path(position).ok_or_else(|| WalletError::State("no Merkle path is kept for that position".into()))?;
        Ok(SpendInput { value: n.value, rho: n.rho.0, r: n.r.0, position, path })
    }

    // ---- pending transactions (F-7) -----------------------------------------------------------------

    /// The transactions that were handed out and not yet removed by [`WalletState::resolve`].
    pub fn pending(&self) -> &[PendingTx] {
        &self.pending
    }

    /// `true` while the note is an input of a transaction whose status is `pending`.
    pub fn is_locked(&self, position: u64) -> bool {
        self.pending.iter().any(|p| p.status == PendingStatus::Pending && p.inputs.contains(&position))
    }

    /// Records a built transfer or unshield (`BuiltTx::pending()`) and locks its inputs. Call it
    /// BEFORE the transaction leaves the wallet, and persist the state. From then on the inputs
    /// cannot be selected or handed to a builder until the scan shows the transaction mined, or
    /// [`WalletState::resolve`] finds that the scan has passed its `expiry_height`. No answer of
    /// a node unlocks them.
    ///
    /// Refused: a record without two distinct nullifiers or without an expiry; an expiry more
    /// than 128 blocks above the scanned height (the builders' bound — locked notes are released
    /// in bounded time); inputs that are not unspent, unlocked notes of this state whose values
    /// add up to `input_total`; an input whose stored nullifier is not one of the transaction's.
    pub fn mark_pending(&mut self, mut tx: PendingTx) -> Result<(), WalletError> {
        let bad = |what: &'static str| Err(WalletError::Request(what.into()));
        if !TX_TYPES[1..].contains(&tx.tx_type.as_str()) {
            return bad("only a shielded_transfer_v2 or an unshield_v2 is recorded as pending");
        }
        if tx.nullifiers.len() != 2 || tx.nullifiers[0] == tx.nullifiers[1] {
            return bad("a pending transaction has two distinct nullifiers");
        }
        let Some(expiry) = tx.expiry_height else { return bad("a pending transaction has an expiry height") };
        if expiry > self.next_height.saturating_sub(1).saturating_add(MAX_EXPIRY_OFFSET) {
            return bad("the expiry height is more than 128 blocks above the scanned height");
        }
        if !matches!(tx.inputs.len(), 1 | 2) || (tx.inputs.len() == 2 && tx.inputs[0] == tx.inputs[1]) {
            return bad("a pending transaction spends one or two distinct notes");
        }
        if self.pending.len() >= MAX_PENDING {
            return bad("too many pending transactions: resolve the list first");
        }
        if self.pending.iter().any(|p| p.nullifiers.iter().any(|n| tx.nullifiers.contains(n))) {
            return bad("this transaction is already recorded");
        }
        let mut total = 0u128;
        for &pos in &tx.inputs {
            let Some(n) = self.note_at(pos) else { return bad("a pending transaction's input is not a note of this state") };
            if n.spent {
                return bad("a pending transaction's input is already spent");
            }
            if self.is_locked(pos) {
                return Err(WalletError::NoteLocked);
            }
            if n.nullifier.is_some_and(|nf| !tx.nullifiers.contains(&nf)) {
                return bad("the transaction does not spend that note (nullifier mismatch)");
            }
            total += n.value as u128;
        }
        if total != tx.input_total as u128 {
            return bad("input_total is not the value of the input notes");
        }
        tx.status = PendingStatus::Pending;
        tx.mined_height = None;
        tx.rejected_hint = false;
        self.pending.push(tx);
        Ok(())
    }

    /// Records that a node answered "rejected" for the pending transaction with this nullifier.
    /// Only a flag for the UI: the transaction is still valid until its expiry height and its
    /// inputs stay locked (a node that lies about a rejection can still have it mined).
    pub fn note_rejection_hint(&mut self, nullifier: &[u8; 32]) -> bool {
        match self.pending.iter_mut().find(|p| p.nullifiers.iter().any(|n| n.0 == *nullifier)) {
            Some(p) => {
                p.rejected_hint = true;
                true
            }
            None => false,
        }
    }

    /// Settles the pending list against what the scan has seen, and removes what is settled:
    ///
    /// * an entry the scan saw mined is returned in `mined` (its inputs are already spent);
    /// * an entry whose `expiry_height` is at or below the height `policy` names, and that was
    ///   not seen mined, is returned in `expired` and its inputs are spendable again. The node
    ///   refuses a V2 transaction whose expiry is below the block's height (spec §3.6 check 7),
    ///   so beyond that height it can never be mined;
    /// * everything else stays pending.
    ///
    /// Nothing here depends on what a node answered to the submission.
    pub fn resolve(&mut self, policy: ReleasePolicy) -> Resolution {
        let horizon = match policy {
            ReleasePolicy::Scanned => self.scanned_height(),
            ReleasePolicy::Confirmed => self.confirmed_height,
        };
        let mut out = Resolution::default();
        let mut keep = Vec::with_capacity(self.pending.len());
        for mut p in core::mem::take(&mut self.pending) {
            if p.status == PendingStatus::Pending && matches!((p.expiry_height, horizon), (Some(e), Some(h)) if h >= e) {
                p.status = PendingStatus::Expired;
            }
            match p.status {
                PendingStatus::Mined => out.mined.push(p),
                PendingStatus::Expired => out.expired.push(p),
                PendingStatus::Pending => keep.push(p),
            }
        }
        out.still_pending = keep.len();
        self.pending = keep;
        out
    }

    // ---- root confirmation (F-1) --------------------------------------------------------------------

    /// Compares the wallet's own tree roots with what nodes report, and marks as `confirmed`
    /// every note created at or below the highest height at which at least `quorum` distinct
    /// nodes reported exactly the wallet's root ([`DEFAULT_CONFIRM_QUORUM`] = 2).
    ///
    /// Why this is evidence: the root at a height commits to every output of every transaction
    /// up to that height. If the nodes' root is the wallet's, the notes the wallet found are in
    /// the tree those nodes hold — a listing with an invented transaction gives another root.
    ///
    /// What it is not: proof against the chain. It is the word of `quorum` nodes instead of one.
    /// With `quorum = 1` it is the word of one node (right for a wallet that asks its own node).
    /// A node that reports two different roots for one height is ignored; reports for heights
    /// the wallet has not scanned, or whose root it no longer keeps, cannot be compared.
    pub fn confirm_roots(&mut self, reports: &[RootReport], quorum: usize) -> Result<ConfirmReport, WalletError> {
        if quorum == 0 {
            return Err(WalletError::Request("the quorum must be at least 1".into()));
        }
        if reports.len() > MAX_ROOT_REPORTS {
            return Err(WalletError::Request("more than 64 root reports".into()));
        }
        if reports.iter().any(|r| r.node_id.is_empty() || r.node_id.len() > MAX_NODE_ID_BYTES) {
            return Err(WalletError::Request("a node id must be 1 to 128 bytes".into()));
        }
        // height → node → the roots that node reported there
        let mut by_height: BTreeMap<u64, BTreeMap<&str, Vec<[u8; 32]>>> = BTreeMap::new();
        for r in reports {
            let roots = by_height.entry(r.height).or_default().entry(r.node_id.as_str()).or_default();
            if !roots.contains(&r.root) {
                roots.push(r.root);
            }
        }
        let mut out = ConfirmReport { quorum, confirmed_height: self.confirmed_height, ..Default::default() };
        for (&height, nodes) in &by_height {
            let Some(mine) = self.root_at(height) else {
                out.not_comparable += nodes.len();
                continue;
            };
            let mut agreeing = 0usize;
            let mut others: BTreeMap<[u8; 32], usize> = BTreeMap::new();
            for roots in nodes.values() {
                // a node that says two things about one height says nothing
                if let [root] = roots.as_slice() {
                    if *root == mine {
                        agreeing += 1;
                    } else {
                        *others.entry(*root).or_default() += 1;
                    }
                }
            }
            if others.values().any(|&n| n >= quorum) {
                out.diverged = true;
            }
            if agreeing >= quorum {
                out.matched_height = Some(height); // ascending: the last match is the highest
                out.agreeing = agreeing;
            } else if out.matched_height.is_none() {
                out.agreeing = out.agreeing.max(agreeing);
            }
        }
        if let Some(h) = out.matched_height {
            for n in self.notes.iter_mut().filter(|n| !n.confirmed && n.height <= h) {
                n.confirmed = true;
                out.newly_confirmed.push(n.position);
            }
            self.confirmed_height = Some(self.confirmed_height.map_or(h, |c| c.max(h)));
            out.confirmed_height = self.confirmed_height;
        }
        Ok(out)
    }

    // ---- scanning -----------------------------------------------------------------------------------

    /// Consumes one page of the node's listing (spec §5.4, "Scanning"). For every transaction, in
    /// chain order:
    ///
    /// 1. each of its two nullifiers that belongs to an unspent note of this wallet marks that
    ///    note spent; a pending transaction of this wallet with one of them is marked mined and
    ///    its inputs spent;
    /// 2. each output is appended to the wallet's tree at the position the chain gave it, and
    ///    trial-decrypted with the viewing key (`aad = cm_out_j`); if the tag verifies, the
    ///    recipient check of spec §2.4.1 is run with `rho = H_rho(nf1, nf2, j)` computed from the
    ///    transaction's own nullifiers — only a note whose recomputed commitment equals `cm_out_j`
    ///    is the wallet's; its nullifier `H(3; nk ‖ rho)` is stored when `nk` is available. The
    ///    note is stored `confirmed: false` (see the module documentation and `confirm_roots`).
    ///    A zero-value note is not stored.
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
    /// [`WalletError::RescanRequired`] rather than show notes as unspent that may be spent: that
    /// is the only provably correct answer, because the state no longer knows what it missed.
    ///
    /// The page must continue this state exactly (`from_height` and every leaf position); a page
    /// that does not is refused and the state is left untouched — after a chain reorganisation the
    /// wallet rebuilds from an empty state ([`WalletState::fresh_for_rescan`]). The page is
    /// validated and trial-decrypted completely before the state is changed, in place: the whole
    /// page is applied or nothing.
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
                // is nothing to keep (I-7)
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
                for n in self.notes.iter_mut().filter(|n| n.spent_height.is_none() && n.nullifier == Some(seen.nf)) {
                    n.spent = true;
                    n.spent_height = Some(seen.height);
                    self.tree.forget(n.position);
                    report.spent.push(n.position);
                }
            }
        }
        if nk.is_some() {
            // every note has its nullifier now: nothing is blind
            self.blind = BlindLog::default();
        }
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
            // 1. spends
            for n in self.notes.iter_mut() {
                if n.spent_height.is_none() && n.nullifier.is_some_and(|x| tx.nf.contains(&x.0)) {
                    n.spent = true;
                    n.spent_height = Some(tx.height);
                    self.tree.forget(n.position);
                    report.spent.push(n.position);
                }
            }
            // F-7: a pending transaction of this wallet was mined
            for p in self.pending.iter_mut().filter(|p| p.status == PendingStatus::Pending) {
                if p.nullifiers.iter().any(|x| tx.nf.contains(&x.0)) {
                    p.status = PendingStatus::Mined;
                    p.mined_height = Some(tx.height);
                    report.pending_mined += 1;
                    for n in self.notes.iter_mut().filter(|n| p.inputs.contains(&n.position) && n.spent_height.is_none()) {
                        n.spent = true;
                        n.spent_height = Some(tx.height);
                        self.tree.forget(n.position);
                        report.spent.push(n.position);
                    }
                }
            }
            // 2. outputs
            for (j, out) in tx.outputs.into_iter().enumerate() {
                let leaf = self.tree.append(&out.cm, out.mine.is_some()).map_err(|_| WalletError::Internal("the tree refused a checked leaf"))?;
                if let Some((value, r_b, rho)) = out.mine {
                    self.notes.push(OwnedNote {
                        value,
                        r: B32(r_b),
                        rho: B32(field::bytes(&rho)),
                        position: leaf,
                        cm: B32(out.cm),
                        nullifier: nk.as_ref().map(|nk| B32(field::bytes(&nullifier(nk, &rho)))),
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
            // the root after this height so far (F-1: what `confirm_roots` compares)
            let root = self.tree.root;
            match self.checkpoints.last_mut() {
                Some(c) if c.height >= tx.height => c.root = root,
                _ => self.checkpoints.push(Checkpoint { height: tx.height, root }),
            }
            if self.checkpoints.len() > MAX_CHECKPOINTS {
                self.checkpoints.remove(0);
            }
            report.txs += 1;
        }
        self.next_height = page.next_height;
        report.next_height = page.next_height;
        report.at_tip = page.next_height > page.tip_height;
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
    /// tracked path after every append, across several carries.
    #[test]
    fn tracker_matches_the_reference_tree() {
        let mut t = TreeTracker::new();
        let mut reference = SparseTree::new();
        assert_eq!(t.root(), field::bytes(&reference.root()));
        let tracked = [0u64, 1, 2, 5, 7, 8, 21, 40];
        for i in 0..70u64 {
            let l = leaf(i);
            assert_eq!(t.append(&l, tracked.contains(&i)).unwrap(), i);
            reference.insert(i as u32, field::digest(&l, "l").unwrap());
            assert_eq!(t.root(), field::bytes(&reference.root()), "root after leaf {i}");
            for &p in tracked.iter().filter(|&&p| p <= i) {
                let path = t.path(p).unwrap();
                let want: Vec<[u8; 32]> = reference.path(p as u32).iter().map(field::bytes).collect();
                assert_eq!(path, want, "path of {p} after leaf {i}");
                let arr: [Digest; 32] = core::array::from_fn(|k| field::digest(&path[k], "s").unwrap());
                assert_eq!(root_from_path(&field::digest(&leaf(p), "l").unwrap(), p as u32, &arr), reference.root());
            }
            // the frontier convention of spec §4.8: zero where the bit of note_count is 0
            for (lvl, f) in t.frontier().iter().enumerate() {
                assert_eq!(*f == [0u8; 32], (t.note_count() >> lvl) & 1 == 0, "frontier[{lvl}] at count {}", t.note_count());
            }
        }
        assert_eq!(t.tracked(), tracked.len());
        // serialisation round-trip
        let json = serde_json::to_string(&t).unwrap();
        assert_eq!(serde_json::from_str::<TreeTracker>(&json).unwrap(), t);
    }

    #[test]
    fn state_json_is_validated() {
        let s = WalletState::new([1u8; 32]);
        let json = s.to_json().unwrap();
        assert_eq!(WalletState::from_json(&json).unwrap(), s);
        assert!(WalletState::from_json("{}").is_err());
        assert!(WalletState::from_json(&json.replace("\"version\":2", "\"version\":3")).is_err());
        assert!(WalletState::from_json(&json.replace("\"note_count\":0", "\"note_count\":18446744073709551615")).is_err());
        // a truncated frontier is refused, not indexed out of bounds later
        let mut v: serde_json::Value = serde_json::from_str(&json).unwrap();
        v["tree"]["frontier"].as_array_mut().unwrap().pop();
        assert!(WalletState::from_json(&v.to_string()).is_err());
    }
}
