//! The wallet's own note data and note tree (spec §5.4), and scanning.
//!
//! [`WalletState`] is everything a wallet persists for the shielded pool besides its keys: every
//! note it owns (value, `r`, `rho`, leaf position, commitment, nullifier, spent flag, height),
//! the frontier of the commitment tree and one Merkle path per unspent note, kept current as
//! leaves are appended, and the height the scan has reached. It serialises to JSON
//! (`to_json` / `from_json`). It contains note secrets (`r`, values) but no key: the caller
//! encrypts it at rest like the rest of the wallet.
//!
//! [`WalletState::scan`] consumes one page of the node's `GET /api/shield-v2/notes` listing:
//! every accepted V2 transaction in chain order with its two nullifiers, two output commitments
//! (with leaf positions) and two `(kem_ct, note_ct)` pairs. The wallet downloads everything in
//! bulk and never asks a node for one position's path (spec §5.4).
//!
//! A restored wallet is `WalletState::new(pk)` plus a scan from the activation height: it
//! recovers every note ever delivered to its address through conforming ciphertexts, which of
//! them are spent, the balance and the Merkle paths — and nothing about what it sent to others.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use quantum_vault_shield_v2::reference::{derive_rho, merge, nullifier, Digest, Note, ZERO_DIGEST};
use serde::{Deserialize, Serialize};

use crate::error::WalletError;
use crate::field;
use crate::keys::{ScanKey, KEM_CT_BYTES};
use crate::note_enc::{decrypt_note, NOTE_CT_BYTES};

pub const TREE_DEPTH: usize = 32;
const STATE_VERSION: u32 = 1;

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
    #[serde(default)]
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
    pub fn from_json(json: &str) -> Result<Self, WalletError> {
        serde_json::from_str(json).map_err(|e| WalletError::Listing(format!("not a notes listing: {e}")))
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

/// What the wallet keeps for every note it owns (spec §5.4).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
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
    /// `H(3; nk ‖ rho)`; `None` if the scan ran with the viewing key alone.
    pub nullifier: Option<B32>,
    pub spent: bool,
    /// Height of the block in which the nullifier appeared.
    pub spent_height: Option<u64>,
    /// Height of the block that created the note.
    pub height: u64,
    /// The creating transaction (the node's hash of it) and the output slot, 0 or 1.
    pub tx_hash: String,
    pub output_index: u8,
}

/// A note ready to be spent: the note's secrets and its Merkle path against the wallet's
/// current root.
#[derive(Clone, PartialEq, Eq)]
pub struct SpendInput {
    pub value: u64,
    pub rho: [u8; 32],
    pub r: [u8; 32],
    pub position: u64,
    pub path: Vec<[u8; 32]>,
}

/// What one call of [`WalletState::scan`] found.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ScanReport {
    /// transactions read from the page
    pub txs: usize,
    /// positions of the notes found for this wallet
    pub received: Vec<u64>,
    /// positions of this wallet's notes whose nullifier appeared
    pub spent: Vec<u64>,
    /// where the next page starts
    pub next_height: u64,
    /// `true` when the page reached the node's tip
    pub at_tip: bool,
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
}

impl WalletState {
    /// An empty state for the wallet whose address has this `pk`. Scanning it from height 0 is
    /// the restore of spec §5.4.
    pub fn new(pk: [u8; 32]) -> Self {
        Self { version: STATE_VERSION, pk: B32(pk), next_height: 0, tree: TreeTracker::new(), notes: Vec::new() }
    }

    pub fn to_json(&self) -> Result<String, WalletError> {
        serde_json::to_string(self).map_err(|e| WalletError::State(e.to_string()))
    }

    pub fn from_json(json: &str) -> Result<Self, WalletError> {
        let s: Self = serde_json::from_str(json).map_err(|e| WalletError::State(e.to_string()))?;
        if s.version != STATE_VERSION {
            return Err(WalletError::State(format!("unknown state version {}", s.version)));
        }
        s.tree.check()?;
        let mut seen = std::collections::BTreeSet::new();
        for n in &s.notes {
            if n.position >= s.tree.note_count || !seen.insert(n.position) || n.output_index > 1 {
                return Err(WalletError::State("a stored note is inconsistent with the tree".into()));
            }
        }
        Ok(s)
    }

    pub fn pk(&self) -> [u8; 32] {
        self.pk.0
    }
    /// `since` of the next listing request.
    pub fn next_height(&self) -> u64 {
        self.next_height
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
    /// The sum of the unspent notes, in quanta.
    pub fn balance(&self) -> u128 {
        self.notes.iter().filter(|n| !n.spent).map(|n| n.value as u128).sum()
    }
    pub fn unspent(&self) -> impl Iterator<Item = &OwnedNote> {
        self.notes.iter().filter(|n| !n.spent)
    }
    pub fn note_at(&self, position: u64) -> Option<&OwnedNote> {
        self.notes.iter().find(|n| n.position == position)
    }

    /// The note at `position` with its current Merkle path, ready for a builder.
    pub fn spend_input(&self, position: u64) -> Result<SpendInput, WalletError> {
        let n = self.note_at(position).ok_or_else(|| WalletError::Request(format!("no note at position {position}")))?;
        if n.spent {
            return Err(WalletError::Request(format!("the note at position {position} is already spent")));
        }
        let path = self
            .tree
            .path(position)
            .ok_or_else(|| WalletError::State(format!("no Merkle path is kept for position {position}")))?;
        Ok(SpendInput { value: n.value, rho: n.rho.0, r: n.r.0, position, path })
    }

    /// Mark a note spent locally right after submitting a transaction that spends it, so that it
    /// is not selected again while the transaction is pending. The scan confirms it from the
    /// chain (`spent_height` is then set); [`WalletState::unmark_pending`] undoes it if the
    /// transaction is dropped or expires.
    pub fn mark_pending_spent(&mut self, position: u64) -> bool {
        match self.notes.iter_mut().find(|n| n.position == position && !n.spent) {
            Some(n) => {
                n.spent = true;
                true
            }
            None => false,
        }
    }

    /// Undo [`WalletState::mark_pending_spent`] for a note the chain has not seen spent.
    pub fn unmark_pending(&mut self, position: u64) -> bool {
        match self.notes.iter_mut().find(|n| n.position == position && n.spent && n.spent_height.is_none()) {
            Some(n) => {
                n.spent = false;
                true
            }
            None => false,
        }
    }

    /// Consumes one page of the node's listing (spec §5.4, "Scanning"). For every transaction, in
    /// chain order:
    ///
    /// 1. each of its two nullifiers that belongs to an unspent note of this wallet marks that
    ///    note spent;
    /// 2. each output is appended to the wallet's tree at the position the chain gave it, and
    ///    trial-decrypted with the viewing key (`aad = cm_out_j`); if the tag verifies, the
    ///    recipient check of spec §2.4.1 is run with `rho = H_rho(nf1, nf2, j)` computed from the
    ///    transaction's own nullifiers — only a note whose recomputed commitment equals `cm_out_j`
    ///    is the wallet's; its nullifier `H(3; nk ‖ rho)` is stored when `nk` is available.
    ///
    /// The page must continue this state exactly (`from_height` and every leaf position); a page
    /// that does not is refused and the state is left untouched — after a chain reorganisation the
    /// wallet rebuilds from an empty state (see `NOTES.md`). The whole page is applied or nothing.
    pub fn scan(&mut self, page: &ListingPage, key: &ScanKey) -> Result<ScanReport, WalletError> {
        if key.pk != self.pk.0 {
            return Err(WalletError::Request("this state belongs to another wallet (pk differs)".into()));
        }
        if !page.active {
            return Ok(ScanReport { next_height: self.next_height, ..Default::default() });
        }
        let fresh = self.tree.note_count == 0;
        if page.from_height != self.next_height && !(fresh && page.from_height > self.next_height) {
            return Err(WalletError::Listing(format!(
                "the page starts at height {} but the wallet is at {}",
                page.from_height, self.next_height
            )));
        }
        if page.next_height < page.from_height {
            return Err(WalletError::Listing("next_height is below from_height".into()));
        }
        let pk = field::digest(&key.pk, "pk")?;
        let nk = match &key.nk {
            Some(nk) => Some(field::digest(nk, "nk")?),
            None => None,
        };
        let dk = key.decaps_key()?;

        let mut next = self.clone();
        let mut report = ScanReport::default();
        let mut last: Option<(u64, u64)> = None;
        for tx in &page.txs {
            if tx.height < page.from_height || tx.height >= page.next_height {
                return Err(WalletError::Listing(format!("a transaction at height {} is outside the page", tx.height)));
            }
            if last.is_some_and(|l| (tx.height, tx.index) <= l) {
                return Err(WalletError::Listing("the transactions are not in chain order".into()));
            }
            last = Some((tx.height, tx.index));
            if tx.outputs.len() != 2 {
                return Err(WalletError::Listing("a transaction must list exactly two outputs".into()));
            }
            let nf_b = [
                hex32(&tx.nf1).ok_or_else(|| WalletError::Listing("nf1 is not 32 bytes of lowercase hex".into()))?,
                hex32(&tx.nf2).ok_or_else(|| WalletError::Listing("nf2 is not 32 bytes of lowercase hex".into()))?,
            ];
            let nf = [field::digest(&nf_b[0], "nf1")?, field::digest(&nf_b[1], "nf2")?];
            if nf_b[0] == nf_b[1] {
                return Err(WalletError::Listing("a listed transaction has nf1 = nf2".into()));
            }
            // 1. spends
            for n in next.notes.iter_mut() {
                if n.spent_height.is_none() && n.nullifier.is_some_and(|x| x.0 == nf_b[0] || x.0 == nf_b[1]) {
                    n.spent = true;
                    n.spent_height = Some(tx.height);
                    next.tree.forget(n.position);
                    report.spent.push(n.position);
                }
            }
            // 2. outputs
            for (j, out) in tx.outputs.iter().enumerate() {
                let cm_b = hex32(&out.cm_out).ok_or_else(|| WalletError::Listing("cm_out is not 32 bytes of lowercase hex".into()))?;
                let cm = field::digest(&cm_b, "cm_out")?;
                let kem: [u8; KEM_CT_BYTES] =
                    hex_exact(&out.kem_ct).ok_or_else(|| WalletError::Listing("kem_ct is not 1,088 bytes of lowercase hex".into()))?;
                let note_ct: [u8; NOTE_CT_BYTES] =
                    hex_exact(&out.note_ct).ok_or_else(|| WalletError::Listing("note_ct is not 56 bytes of lowercase hex".into()))?;
                let leaf = out.leaf.ok_or_else(|| WalletError::Listing("an output has no leaf position".into()))?;
                if leaf != next.tree.note_count {
                    return Err(WalletError::Listing(format!(
                        "an output is at leaf {leaf} but the wallet's tree has {} leaves (missed transactions or a reorganisation)",
                        next.tree.note_count
                    )));
                }
                // trial decryption, then the recipient check of spec §2.4.1
                let mine = decrypt_note(&dk, &kem, &note_ct, &cm_b).and_then(|(value, r_b)| {
                    let r = field::digest(&r_b, "r").ok()?;
                    let rho = derive_rho(&nf, j);
                    (Note { value, pk, rho, r }.commitment() == cm).then_some((value, r_b, rho))
                });
                // a zero-value note is recorded but needs no path: there is nothing to spend
                let track = mine.as_ref().is_some_and(|m| m.0 > 0);
                next.tree.append(&cm_b, track)?;
                if let Some((value, r_b, rho)) = mine {
                    next.notes.push(OwnedNote {
                        value,
                        r: B32(r_b),
                        rho: B32(field::bytes(&rho)),
                        position: leaf,
                        cm: B32(cm_b),
                        nullifier: nk.as_ref().map(|nk| B32(field::bytes(&nullifier(nk, &rho)))),
                        spent: false,
                        spent_height: None,
                        height: tx.height,
                        tx_hash: tx.tx_hash.clone(),
                        output_index: j as u8,
                    });
                    report.received.push(leaf);
                }
            }
            report.txs += 1;
        }
        next.next_height = page.next_height;
        report.next_height = page.next_height;
        report.at_tip = page.next_height > page.tip_height;
        *self = next;
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
        assert!(WalletState::from_json(&json.replace("\"version\":1", "\"version\":2")).is_err());
        assert!(WalletState::from_json(&json.replace("\"note_count\":0", "\"note_count\":18446744073709551615")).is_err());
        // a truncated frontier is refused, not indexed out of bounds later
        let mut v: serde_json::Value = serde_json::from_str(&json).unwrap();
        v["tree"]["frontier"].as_array_mut().unwrap().pop();
        assert!(WalletState::from_json(&v.to_string()).is_err());
    }
}
