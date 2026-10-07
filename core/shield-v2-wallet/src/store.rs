//! The wallet's own note data and note tree (spec §5.4), pending transactions and their
//! settlement (spec §5.5), and scanning.
//!
//! [`WalletState`] is everything a wallet persists for the shielded pool besides its keys: the
//! notes it owns, the frontier of the commitment tree and the tree nodes its unspent notes' Merkle
//! paths need, **the running nullifier hash of the pool** (the node's `nullifier_acc`, rebuilt
//! from the listing), the height the scan has reached, the pool state of the recent heights
//! (tree root, nullifier hash, both counts), and the transactions the wallet has built and
//! handed out that are not settled ([`PendingTx`]), **the nodes the wallet is configured with**
//! and the running hash over every listed ciphertext. It serialises to JSON (`to_json` /
//! `from_json`, format version 5; versions 1 to 4 are migrated, every lock kept). It contains note secrets
//! (`r`, values) but no key: the caller encrypts it at rest like the rest of the wallet.
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
//! wallet is CONFIGURED with report for that height ([`WalletState::set_nodes`]). A listing that
//! invents, hides, reorders or alters any commitment, any nullifier or any ciphertext up to that
//! height gives another root or another hash. Up to the **confirmed height**, and only up to it,
//! the wallet's data is what a strict majority of its configured nodes holds — and nothing about
//! a transaction's expiry or its lock is measured from any other height (REVIEW_WALLET_3).
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
use sha2::{Digest as _, Sha256};
use quantum_vault_shield_v2::reference::{derive_rho, merge, nullifier, Digest, Note, ZERO_DIGEST};
use serde::{Deserialize, Serialize};

use crate::error::{json_error, WalletError};
use crate::field;
use crate::keys::{ScanKey, KEM_CT_BYTES};
use crate::note_enc::{decrypt_note, NOTE_CT_BYTES};
use crate::tx::{DEFAULT_EXPIRY_OFFSET as DEFAULT_SPEND_WINDOW, MAX_EXPIRY_OFFSET};

pub const TREE_DEPTH: usize = 32;
/// The format version `to_json` writes. `from_json` also reads versions 1 to 4 and migrates
/// them (see [`WalletState::from_json`]).
pub const STATE_VERSION: u32 = 5;
/// **The embargo after a restore** (REVIEW_WALLET_4 RW4-1). A state made by
/// [`WalletState::new`] has no lock history: an earlier copy of the wallet (the lost device, a
/// second device) may have a transaction in flight that this state knows nothing of. Such a
/// state builds no spend until its confirmed height is at least this many blocks above its
/// **embargo base** — see [`WalletState::spend_embargo`]. The number is the builders' maximum
/// expiry distance: a transaction built at confirmed height `C_b` is dead after block
/// `C_b + 128`, so `base ≥ C_b` is what makes the embargo sufficient.
pub const RESTORE_EMBARGO_BLOCKS: u64 = MAX_EXPIRY_OFFSET;
/// How far above the quorum's tip the embargo base may be put by the tip ONE configured node
/// claims — and how far it IS put when a configured node did not answer in the call that
/// establishes the base. It is the honest lag the embargo covers (the first quorum after a
/// restore may consist of a lying node and honest nodes that are behind), and at the same time
/// the most a lying or silent minority can add to the embargo: bounded delay, never more.
pub const RESTORE_LAG_BOUND_BLOCKS: u64 = 256;
/// Shields to the wallet's own address a state remembers at once
/// ([`WalletState::record_own_shield`]).
pub const MAX_OWN_SHIELDS: usize = 64;
/// Domain tag of the revision identity ([`WalletState::revision_id`]).
pub const REVISION_ID_TAG: &[u8] = b"rougechain.shield_v2.wallet_state.revision_id.v1";
/// [`WalletState::confirm_state`] confirms nothing for a wallet configured with fewer nodes than
/// this: one node's word is never "confirmed" (a single-node wallet shows everything as
/// unverified).
pub const MIN_CONFIGURED_NODES: usize = 2;
/// Nodes a wallet can be configured with ([`WalletState::set_nodes`]).
pub const MAX_CONFIGURED_NODES: usize = 64;
/// Reports taken by one `confirm_state` call, and the longest node id.
pub const MAX_STATE_REPORTS: usize = 1_024;
pub const MAX_NODE_ID_BYTES: usize = 128;
/// Domain tag of the running hash over the listed ciphertexts — the node's node-local
/// `ciphertext_acc` (`core/daemon/src/shield_v2.rs`). Not a constant of spec §2 and not
/// consensus: it is what lets a quorum vouch for the ciphertexts a listing served.
pub const CIPHERTEXT_ACC_TAG: &[u8] = b"rougechain.shield_v2.ciphertext_acc.node_local.v1";
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
/// The default of a state's cap on **unspent** notes received from others
/// ([`WalletState::max_unspent_notes`]). Further incoming notes are counted
/// ([`WalletState::over_capacity`]) and not stored; a rescan with a higher cap recovers them.
/// Spent notes never count (REVIEW_WALLET_3 RW3-4), and the wallet's own outputs are stored
/// whatever the count.
pub const DEFAULT_MAX_UNSPENT_NOTES: usize = 65_536;
/// The former name of [`DEFAULT_MAX_UNSPENT_NOTES`].
pub const MAX_STORED_NOTES: usize = DEFAULT_MAX_UNSPENT_NOTES;
/// The highest cap a state accepts. (`to_json` refuses a state above [`MAX_STATE_JSON_BYTES`]
/// whatever the cap: about 420 bytes per note plus its share of the tree nodes.)
pub const MAX_UNSPENT_NOTES_LIMIT: usize = 1 << 20;
/// Room above the cap for the wallet's own outputs (change, payments to itself), which are
/// stored regardless of the cap.
const OWN_OUTPUT_SLACK: usize = 65_536;
/// Spent notes a state keeps for display (the most recently spent). Older ones are dropped into
/// [`WalletState::pruned`] as the scan goes: a spent note has no path and is in no balance.
pub const MAX_SPENT_RETAINED: usize = 4_096;
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

/// An `Option` field that must be PRESENT in the text (`null` or a value): serde reads a missing
/// `Option` field as `None`, which for a safety mark is a default like any other (RW5-9).
fn required_option<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(d)
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
    /// Required (REVIEW_WALLET_6 RW6-2): the node always sends it, and a page without it is not
    /// "a page without transactions".
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
        let page: Self = serde_json::from_str(json).map_err(|e| {
            let what = json_error("notes listing", &e);
            // REVIEW_WALLET_6B RW6B-2: is the body a listing page at all?
            WalletError::Listing(if Self::is_page(json) { what } else { format!("{NOT_A_LISTING_PAGE}: {what}") })
        })?;
        if page.txs.len() > MAX_PAGE_TXS {
            return Err(WalletError::Listing("the page lists more than 4,096 transactions".into()));
        }
        Ok(page)
    }

    /// **Is this body a listing page at all?** (REVIEW_WALLET_6B RW6B-2.) The discriminator, and
    /// the only one: the body is JSON, its top level is an OBJECT, and that object has at least
    /// one of the five members that make a page — [`PAGE_MEMBERS`]: `active`, `tip_height`,
    /// `from_height`, `next_height`, `txs`.
    ///
    /// A body that is not — nothing, text that is not JSON (a proxy's error page), a JSON value
    /// that is not an object, an object without any of the five (the node's own error answer,
    /// `{ "success": false, "error": … }`) — says nothing about a chain: it is **no answer**,
    /// for the client loop a strike and never a ban (`NOTES.md` §6). A body that IS a page and
    /// is then refused by [`ListingPage::from_json`] or [`WalletState::scan`] is evidence: the
    /// node served a listing that is not a chain's.
    ///
    /// Why "at least one" and not "all": a node cannot stay out of the rule by leaving a member
    /// out. To be "no answer" a body must carry NONE of the listing's content — no heights, no
    /// tip, no transactions, no word about the pool being active — and a node that serves
    /// nothing is left after K rounds like one that is silent. Anything that carries a part of
    /// a listing is judged as a listing, and a missing or malformed part is a `listing:` error.
    pub fn is_page(json: &str) -> bool {
        json.len() <= MAX_LISTING_JSON_BYTES
            && serde_json::from_str::<serde_json::Value>(json).ok().and_then(|v| v.as_object().map(|o| PAGE_MEMBERS.iter().any(|m| o.contains_key(*m)))).unwrap_or(false)
    }
}

/// The members of a listing page's JSON object ([`ListingPage::is_page`]).
pub const PAGE_MEMBERS: [&str; 5] = ["active", "tip_height", "from_height", "next_height", "txs"];
/// How the text of a [`WalletError::Listing`] starts when the body was not a listing page at
/// all ([`ListingPage::is_page`]; [`WalletError::is_not_a_page`]).
pub const NOT_A_LISTING_PAGE: &str = "not a listing page";

/// [`WalletState::scan_pages`] refused the page at `index` (0-based, in the order handed in).
#[derive(Debug)]
pub struct PageError {
    pub index: usize,
    pub error: WalletError,
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

// ---- the ciphertext hash (REVIEW_WALLET_3 RW3-2) -----------------------------------------------------

/// One step of the running hash over the listed ciphertexts:
/// `SHA-256(tag ‖ acc ‖ cm_out ‖ kem_ct ‖ note_ct)`, starting from 32 zero bytes, one step per
/// output in tree order. The node keeps the same value beside its pool record (node-local, not
/// in the state root) and reports it as `ciphertext_acc`; the daemon's interop tests compare the
/// two implementations.
pub fn ciphertext_acc_step(acc: &[u8; 32], cm_out: &[u8; 32], kem_ct: &[u8; KEM_CT_BYTES], note_ct: &[u8; NOTE_CT_BYTES]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(CIPHERTEXT_ACC_TAG);
    h.update(acc);
    h.update(cm_out);
    h.update(kem_ct);
    h.update(note_ct);
    h.finalize().into()
}

// ---- node ids (REVIEW_WALLET_3 RW3-8, REVIEW_WALLET_4 RW4-2, RW4-7) ------------------------------------

/// The canonical form of a node id: an http(s) ORIGIN, `scheme://host[:port]`.
///
/// * the scheme (`http` or `https`) and the host are lower-cased;
/// * the default port (80, 443) is removed, any other port is kept without leading zeros;
/// * a path, a query and a fragment are dropped — one origin is one node however many of its
///   routes the client was given — and so is one trailing dot of the host;
/// * **an IP literal has exactly one spelling** (RW4-2). A bracketed IPv6 literal is parsed and
///   written in its RFC 5952 form (`[0:0:0:0:0:0:0:1]`, `[::0001]` → `[::1]`). A host whose last
///   label is a number (decimal, or `0x…`) is an IPv4 literal to every URL parser: it must be
///   four decimal parts of 0–255 without leading zeros (`127.0.0.1`); the forms a URL parser
///   would also read as an address — `127.1`, `2130706433`, `0x7f.0.0.1`, `127.0.0.01` — are
///   refused;
/// * refused: anything else — no scheme, another scheme, user information (`user@`), an empty
///   host, a host with characters outside `a–z 0–9 . -` (write an internationalised name in its
///   `xn--` form), an IPv6 literal that does not parse or carries a zone, a port that is not
///   1–65535, and an id longer than [`MAX_NODE_ID_BYTES`].
///
/// Two spellings of one endpoint are one id. This function only spells; **which ids may be
/// configured TOGETHER is [`WalletState::set_nodes`]' rule** (https only outside a loopback
/// development set, one node per host). Two NAMES of one machine are two nodes: the core cannot
/// know who operates what, and whoever configures the wallet must list operators, not aliases.
pub fn canonical_node_id(id: &str) -> Result<String, WalletError> {
    parse_node_id(id).map(|n| n.id)
}

/// A node id taken apart: its canonical text, scheme, the host it counts as and effective port.
struct NodeId {
    id: String,
    https: bool,
    /// What "one node per host" counts (REVIEW_WALLET_5 RW5-7): the canonical host — and for an
    /// IPv6 literal that only spells an IPv4 address ([`embedded_ipv4`]), that IPv4 address in
    /// its dotted form, so that both spellings of one endpoint are one host.
    machine: String,
    port: u32,
    loopback: bool,
}

/// The IPv4 address an IPv6 literal embeds, for the forms in which the IPv6 address **is** an
/// IPv4 endpoint written in IPv6 notation (REVIEW_WALLET_5 RW5-7). A set of configured nodes
/// counts such a literal as the IPv4 host itself:
///
/// | Form | Prefix | Defined in |
/// |---|---|---|
/// | IPv4-mapped | `::ffff:a.b.c.d` (`::ffff:0:0/96`) | RFC 4291 §2.5.5.2 |
/// | IPv4-compatible (deprecated) | `::a.b.c.d` (`::/96`, not `::` and `::1`) | RFC 4291 §2.5.5.1 |
/// | IPv4-translated (SIIT) | `::ffff:0:a.b.c.d` (`::ffff:0:0:0/96`) | RFC 7915 |
/// | NAT64, well-known prefix | `64:ff9b::a.b.c.d` (`64:ff9b::/96`) | RFC 6052 |
/// | 6to4 | `2002:AABB:CCDD::/48` — the IPv4 address of the 6to4 router every address of that prefix is reached through | RFC 3056 |
///
/// NOT treated as an IPv4 host: Teredo (`2001::/32` — it embeds the address of a third-party
/// server and an obfuscated NAT address), ISATAP interface identifiers, a NAT64 prefix chosen
/// by a network (RFC 6052 §2.2: it cannot be recognised without that network's configuration)
/// — **the local-use prefix `64:ff9b:1::/48` of RFC 8215 included**: each network carves its
/// own translation prefixes out of it, of any of the six lengths of RFC 6052, and the length
/// decides where in the address the IPv4 bytes are — and every other IPv6 address. Two NAMES
/// of one machine are two nodes, as ever.
///
/// An IPv4 LOOPBACK address in one of these forms (`::ffff:0:127.0.0.1`, `64:ff9b::127.0.0.1`,
/// `::127.0.0.1`) is the IPv4 host `127.0.0.1` for this rule and is **not a loopback host**
/// ([`parse_node_id`]: only `127.0.0.0/8`, `::1`, `localhost` and the IPv4-MAPPED form are —
/// the addresses the operating system itself keeps on the machine; a translated address goes
/// to a translator). Both decisions, with their reasons: `UI_CONTRACT.md`, obligation 4
/// (REVIEW_WALLET_6, condition 6).
fn embedded_ipv4(addr: &std::net::Ipv6Addr) -> Option<std::net::Ipv4Addr> {
    let v4 = |hi: u16, lo: u16| std::net::Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8);
    match addr.segments() {
        [0, 0, 0, 0, 0, 0xffff, hi, lo] => Some(v4(hi, lo)),
        [0, 0, 0, 0, 0xffff, 0, hi, lo] => Some(v4(hi, lo)),
        [0x64, 0xff9b, 0, 0, 0, 0, hi, lo] => Some(v4(hi, lo)),
        [0x2002, hi, lo, ..] => Some(v4(hi, lo)),
        // `::` and `::1` are the unspecified and the loopback address, not IPv4-compatible ones
        [0, 0, 0, 0, 0, 0, hi, lo] if (hi, lo) != (0, 0) && (hi, lo) != (0, 1) => Some(v4(hi, lo)),
        _ => None,
    }
}

fn parse_node_id(id: &str) -> Result<NodeId, WalletError> {
    let bad = |what: &'static str| WalletError::Request(what.into());
    if id.is_empty() || id.len() > MAX_NODE_ID_BYTES || !id.is_ascii() {
        return Err(bad("a node id must be 1 to 128 ASCII bytes"));
    }
    let (scheme, rest) = id.split_once("://").ok_or_else(|| bad("a node id must be an http(s) origin: scheme://host[:port]"))?;
    let scheme = scheme.to_ascii_lowercase();
    let default_port = match scheme.as_str() {
        "http" => 80u32,
        "https" => 443,
        _ => return Err(bad("a node id must be an http(s) origin: scheme://host[:port]")),
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') {
        return Err(bad("a node id must not carry user information"));
    }
    let (host, machine, port, loopback) = if let Some(v6) = authority.strip_prefix('[') {
        let (inner, after) = v6.split_once(']').ok_or_else(|| bad("a node id's IPv6 host is not closed"))?;
        if inner.is_empty() || !inner.bytes().all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.') || !inner.contains(':') {
            return Err(bad("a node id's IPv6 host is malformed"));
        }
        let addr: std::net::Ipv6Addr = inner.parse().map_err(|_| bad("a node id's IPv6 host is malformed"))?;
        let port = match after.strip_prefix(':') {
            Some(p) => Some(p),
            None if after.is_empty() => None,
            None => return Err(bad("a node id's port is malformed")),
        };
        let loopback = addr.is_loopback() || addr.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback());
        let host = format!("[{addr}]");
        let machine = embedded_ipv4(&addr).map_or_else(|| host.clone(), |v4| v4.to_string());
        (host, machine, port, loopback)
    } else {
        let (h, port) = match authority.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        };
        let h = h.strip_suffix('.').unwrap_or(h).to_ascii_lowercase();
        let label_ok = |l: &str| !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-') && l.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        if h.is_empty() || h.len() > 253 || !h.split('.').all(label_ok) {
            return Err(bad("a node id's host is empty or malformed"));
        }
        // a host that ENDS in a number is an IPv4 literal to a URL parser, in every spelling
        let last = h.rsplit('.').next().unwrap_or("");
        let numeric = last.bytes().all(|b| b.is_ascii_digit()) || (last.starts_with("0x") && last[2..].bytes().all(|b| b.is_ascii_hexdigit()));
        if numeric {
            let parts: Vec<&str> = h.split('.').collect();
            let octet = |p: &&str| p.len() <= 3 && p.bytes().all(|b| b.is_ascii_digit()) && (p.len() == 1 || !p.starts_with('0')) && p.parse::<u32>().is_ok_and(|n| n <= 255);
            if parts.len() != 4 || !parts.iter().all(octet) {
                return Err(bad("a node id's IPv4 host must be four decimal parts of 0 to 255 without leading zeros"));
            }
            let loopback = parts[0] == "127";
            (h.clone(), h, port, loopback)
        } else {
            let loopback = h == "localhost" || h.ends_with(".localhost");
            (h.clone(), h, port, loopback)
        }
    };
    let port = match port {
        None => None,
        Some(p) => {
            if p.is_empty() || p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit()) {
                return Err(bad("a node id's port is not a number from 1 to 65535"));
            }
            let n: u32 = p.parse().map_err(|_| bad("a node id's port is not a number from 1 to 65535"))?;
            if n == 0 || n > 65_535 {
                return Err(bad("a node id's port is not a number from 1 to 65535"));
            }
            (n != default_port).then_some(n)
        }
    };
    let id = match port {
        Some(p) => format!("{scheme}://{host}:{p}"),
        None => format!("{scheme}://{host}"),
    };
    Ok(NodeId { id, https: scheme == "https", machine, port: port.unwrap_or(default_port), loopback })
}

/// The rule for a SET of configured nodes (REVIEW_WALLET_4 RW4-2, RW4-7). `ids`: canonical,
/// sorted, distinct.
///
/// * **A production set**: every node is `https` — whoever sits on the network path answers for
///   every `http` node at once, a majority by construction — no host is a loopback host, and
///   **each host appears once**, whatever the scheme or the port (`https://h` and
///   `https://h:8443` are one machine with two votes). **An IPv6 literal that only spells an
///   IPv4 address is that IPv4 host** (REVIEW_WALLET_5 RW5-7; [`embedded_ipv4`]):
///   `https://192.0.2.7` and `https://[::ffff:192.0.2.7]` are one host and cannot be configured
///   together.
/// * **A development set**: every host is a loopback host (`localhost`, `*.localhost`,
///   `127.0.0.0/8`, `[::1]`). `http` is accepted here and only here, and nodes are told apart by
///   their port (each `host:port` once). A loopback node is never counted in a quorum together
///   with a node that is not loopback: a set that mixes the two is refused.
fn check_node_set(ids: &[String]) -> Result<(), WalletError> {
    let bad = |what: &'static str| Err(WalletError::Request(what.into()));
    if ids.len() > MAX_CONFIGURED_NODES {
        return bad("more than 64 configured nodes");
    }
    let parsed: Vec<NodeId> = ids.iter().map(|id| parse_node_id(id)).collect::<Result<_, _>>()?;
    let development = parsed.iter().any(|n| n.loopback);
    if development && !parsed.iter().all(|n| n.loopback) {
        return bad("loopback nodes (development) and other nodes cannot be configured together");
    }
    let mut seen = BTreeSet::new();
    for n in &parsed {
        if !development && !n.https {
            return bad("a configured node must be an https origin (http is accepted for loopback hosts only)");
        }
        let key = if development { format!("{}:{}", n.machine, n.port) } else { n.machine.clone() };
        if !seen.insert(key) {
            return bad("two configured nodes are one host: one node per host, whatever the scheme or the port");
        }
    }
    Ok(())
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
        if self.tracked.len() > MAX_UNSPENT_NOTES_LIMIT + OWN_OUTPUT_SLACK || self.nodes.len() > TREE_DEPTH * self.tracked.len() {
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
    /// beyond the state's cap on unspent notes)
    pub not_stored: usize,
    /// notes stored from the wallet's own pending record, not from a ciphertext (its change, a
    /// payment to itself): the listing's ciphertext for it did not decrypt, or the note is below
    /// the minimum note value
    pub own_outputs_from_record: usize,
    /// spent notes this call dropped from the state (more than [`MAX_SPENT_RETAINED`] were held)
    pub spent_dropped: usize,
    /// where the next page starts
    pub next_height: u64,
    /// `true` when the page reached the node's tip
    pub at_tip: bool,
    /// What the page said about the pool (REVIEW_WALLET_6 RW6-3): `false` — the node answered
    /// `"active": false`, **the shielded pool is not active on that node** (its chain has no
    /// activation height, or the node runs a build without the pool). Nothing was read and the
    /// state is unchanged. That is not an empty pool (an active pool without a transaction is
    /// scanned like any other: `pool_active` is `true`, `scanned_height` moves), not a short
    /// page and not evidence against the node: `NOTES.md` §6, "the pool is not active".
    pub pool_active: bool,
    /// `true`: the page numbers its first output BELOW where the wallet's own tree stands — the
    /// listing the state was built on held more leaves than this node has. The page was applied
    /// (positions are the wallet's own), but a state built on two listings that disagree will
    /// not be confirmed: **rescan** (`fresh_for_rescan`) against another node, as after a
    /// `listing:` error. (A page that starts ABOVE the wallet's count is a `listing:` error.)
    pub leaf_mismatch: bool,
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

/// A note a pending transaction creates FOR THIS WALLET — its change, or its payment when the
/// wallet pays itself. `Debug` prints neither the value nor `r`.
///
/// With `r` the record opens the commitment by itself: when the scan meets `cm` in the tree it
/// stores the note from this record (after recomputing the commitment), whatever the listing
/// served as its ciphertext and whatever the note's size (REVIEW_WALLET_3 RW3-2, RW3-3). `r` is
/// `None` only in an entry migrated from an older state format, whose note is then found through
/// its ciphertext like anyone else's.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingChange {
    pub cm: B32,
    #[serde(with = "dec")]
    pub value: u64,
    /// Secret: the commitment randomness of the note.
    #[serde(default)]
    pub r: Option<B32>,
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
    /// **Derived, for display** (REVIEW_WALLET_4 RW4-5): where the state holds the notes this
    /// entry spends — `inputs[i]` is the leaf position of the stored note with the commitment
    /// `input_cms[i]`, recomputed by the core after every change and on every read of the state.
    /// For a note the state does not hold (in the middle of a rescan) it is the last position
    /// known, which may be stale or equal to another slot's: **nothing is identified by it**.
    /// Only an entry migrated from format 2 without its notes (`input_cms` empty) is still held
    /// by position, as format 2 held it.
    #[serde(default)]
    pub inputs: Vec<u64>,
    /// The commitments of the notes it spends, filled in by `mark_pending`. **The lock is held
    /// by commitment — and by nullifier**: a stored note is locked when its commitment is one of
    /// these or its own nullifier is one of the entry's `nullifiers`. It follows the note
    /// through a rescan, also onto a listing in which the note sits at another position.
    #[serde(default)]
    pub input_cms: Vec<B32>,
    /// The total value of those notes, quanta.
    #[serde(with = "dec")]
    pub input_total: u64,
    /// The change the wallet expects back. Stored from this record when the scan meets its
    /// commitment, and confirmed with its height — which is when the transaction settles as mined.
    pub change: Option<PendingChange>,
    /// The payment output, when the recipient is this wallet's own address (a self-merge).
    #[serde(default)]
    pub own_payment: Option<PendingChange>,
    /// The last height at which the node accepts the transaction (the node accepts it while
    /// `expiry_height ≥ H`). `mark_pending` refuses one above the CONFIRMED height + 128. For a
    /// lock migrated from format 1, whose expiry was not recorded: the migrated state's scanned
    /// height + 128.
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
    /// The client said it never submitted this transaction
    /// ([`WalletState::abandon_unsubmitted`]). **A hint for the UI and nothing else**: the inputs
    /// stay locked until the entry settles as expired on confirmed data, exactly as if it had
    /// been submitted — the core cannot check the claim, and a wrong one would be a double
    /// payment.
    #[serde(default)]
    pub abandoned_hint: bool,
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
    /// The notes this entry creates for the wallet itself.
    fn own_outputs(&self) -> impl Iterator<Item = &PendingChange> {
        self.change.iter().chain(self.own_payment.iter())
    }

    fn locks(&self, note: &OwnedNote) -> bool {
        // by nullifier: a note whose own nullifier this transaction publishes is its input,
        // whatever else the entry records (a dummy input's nullifier is no note's)
        if note.nullifier.is_some_and(|nf| self.nullifiers.contains(&nf)) {
            return true;
        }
        if self.input_cms.is_empty() {
            self.inputs.contains(&note.position) // an entry migrated from format 2 without its notes
        } else {
            self.input_cms.contains(&note.cm)
        }
    }
}

/// A `shield_v2` the wallet made to its OWN address (REVIEW_WALLET_4 RW4-11), recorded by
/// [`WalletState::record_own_shield`]: with `(value, r)` the record opens the commitment, so the
/// scan stores the note from the record — whatever its size, whatever the cap, whatever the
/// listing served as its ciphertext — exactly like the wallet's own change. `Debug` prints
/// neither the value nor `r`.
///
/// The record is dropped once the note is confirmed and is either at least the state's minimum
/// note value (any rescan finds it again through its ciphertext) or spent; a note below the
/// minimum keeps its record for as long as it is unspent, also across `fresh_for_rescan`. It is
/// dropped too when the confirmed height has passed `expiry_height` and the shield is not there.
/// A record is no lock: a shield spends no note.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnShield {
    pub cm: B32,
    #[serde(with = "dec")]
    pub value: u64,
    /// Secret: the commitment randomness of the note.
    pub r: B32,
    /// The shield's `expiry_height` — the caller's figure (a shield is measured from a tip one
    /// node reported); it only says when the record of a shield that never arrived is dropped.
    pub expiry_height: u64,
}

impl core::fmt::Debug for OwnShield {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "OwnShield {{ cm: {:?}, expiry_height: {}, value: <secret> }}", self.cm, self.expiry_height)
    }
}

/// Whether a state may build a spend at all, as far as other COPIES of the wallet are concerned
/// (REVIEW_WALLET_4 RW4-1). Locks are per device: a state made from the phrase knows nothing of
/// a transaction an earlier copy built, and a signer-less transaction stays valid until its
/// expiry whatever anybody answers.
///
/// There is no default (REVIEW_WALLET_5 RW5-9): a state text of the current format that does not
/// say where it stands is refused, never read as "no embargo".
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SpendEmbargo {
    /// The state has a lock history: it was migrated from a state that held the device's
    /// pending list, or recovered from one with every entry read. No embargo.
    NotRequired,
    /// Made by [`WalletState::new`] (a new wallet, a restore, a second device) and nothing
    /// confirmed yet: no base, **no spend** (`spend_embargo_until` is `None`).
    AwaitingBase,
    /// The base is established: no spend while the confirmed height is below `until`.
    Until {
        /// The first height this state had confirmed.
        first_confirmed: u64,
        /// The embargo base (see [`WalletState::spend_embargo`]).
        base: u64,
        /// `base + 128`; with `waived`: `first_confirmed`.
        until: u64,
        /// The user's recorded statement that no other copy has a payment in flight
        /// ([`WalletState::assert_no_other_copy_has_a_pending_payment`]) was honoured.
        waived: bool,
    },
}

/// Why a state can or cannot build a spend right now — for the user interface
/// ([`WalletState::spend_status`]). Every figure is a number of BLOCKS: this chain has no block
/// time (REVIEW_WALLET_4 RW4-8).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SpendStatus {
    pub can_spend_now: bool,
    /// `None` when `can_spend_now`; otherwise the FIRST of: `no_nodes` (fewer than two nodes
    /// configured), `view_only` (the state was scanned without the nullifier key),
    /// `no_quorum` (nothing confirmed yet), `embargo` (see `embargo_until`),
    /// `root_unconfirmed` (the listing is above the confirmed height: confirm the state),
    /// `window_too_short` (the quorum's tip is so far above the confirmed height that a spend
    /// with the default expiry could not be mined any more: scan and confirm first).
    pub reason: Option<&'static str>,
    pub confirmed_height: Option<u64>,
    /// `quorum_tip − confirmed height`, when the caller supplied the quorum's tip.
    pub confirmed_lag: Option<u64>,
    /// Blocks left in which a spend built now with the default expiry can be mined:
    /// `64 − confirmed_lag` (0 when the lag is 64 or more).
    pub usable_window_blocks: Option<u64>,
    /// The confirmed height from which a spend is allowed; `None` while there is no base.
    pub embargo_until: Option<u64>,
    /// Blocks of confirmed height still missing to `embargo_until`.
    pub embargo_blocks_left: Option<u64>,
    pub view_only_since: Option<u64>,
    pub default_expiry_blocks: u64,
    pub max_expiry_blocks: u64,
    pub restore_embargo_blocks: u64,
    pub restore_lag_bound_blocks: u64,
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
/// listing: both halves of spec §4.8, and the node-local hash over the ciphertexts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PoolView {
    pub tree_root: [u8; 32],
    pub nullifier_acc: [u8; 32],
    pub note_count: u64,
    pub nullifier_count: u64,
    pub ciphertext_acc: [u8; 32],
}

/// One node's statement "after the block at `height` the pool is in this state" — the `report`
/// object of its `/api/shield-v2/stats`, which the node takes from ONE record written when it
/// accepted that block.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StateReport {
    /// The caller's name for the node: **the endpoint the wallet is configured with**
    /// ([`WalletState::set_nodes`]) — never a string the node returned about itself. It is
    /// canonicalised ([`canonical_node_id`]) and looked up in the configured set; a report under
    /// any other id is not counted.
    pub node_id: String,
    pub height: u64,
    pub tree_root: [u8; 32],
    pub nullifier_acc: [u8; 32],
    pub note_count: u64,
    pub nullifier_count: u64,
    /// The node's running hash over every accepted output's `(cm_out, kem_ct, note_ct)`.
    pub ciphertext_acc: [u8; 32],
}

impl StateReport {
    fn view(&self) -> PoolView {
        PoolView {
            tree_root: self.tree_root,
            nullifier_acc: self.nullifier_acc,
            note_count: self.note_count,
            nullifier_count: self.nullifier_count,
            ciphertext_acc: self.ciphertext_acc,
        }
    }
}

/// A configured node whose report for a height is not the wallet's state there (or that made two
/// different reports for it). For the user interface: "node X disagrees".
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Dissent {
    pub node_id: String,
    pub height: u64,
}

/// One height at which more configured nodes contradict the wallet's state than a lying minority
/// can be, **with what is needed to say whose listing is in doubt** (REVIEW_WALLET_6 RW6-1).
///
/// A report for `height` is compared with the wallet's state after the block at `height`, which
/// is everything the listing showed up to there. So a contradiction at `height` says "the
/// listing is not the chain's somewhere at or below `height`" — and how far down depends on what
/// a quorum has vouched for before:
///
/// * `confirmed: false` — `height` is ABOVE the height the state had confirmed when the call was
///   made. The state at that confirmed height was a quorum's, so the fault is in the listing of
///   the heights `from_height ..= height` (`from_height`: the confirmed height + 1, or 0 when
///   nothing was confirmed). Whoever served those heights served a listing that is not a
///   chain's.
/// * `confirmed: true` — `height` is AT OR BELOW that confirmed height: a state a quorum
///   vouched for earlier (at the confirmed height, not at this one) is contradicted now. The
///   pages below a confirmed height may have come from any node the state was ever listed
///   from, and the confirmation says nothing about the heights in between (a transaction listed
///   one block late leaves the state at the confirmed height exact). **This implicates
///   nobody**: rebuild from `fresh_for_rescan` and blame no node. `from_height` is 0.
///
/// Fewer dissenters than that (`dissenting ≤ configured − quorum`) are never listed here: a
/// strict minority contradicting the wallet is noise or a lie, at any height.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Refutation {
    /// The first height of the listing that is in doubt.
    pub from_height: u64,
    /// The reported height at which the state is contradicted (the last height in doubt).
    pub height: u64,
    /// See above: the contradicted state is at or below the confirmed height.
    pub confirmed: bool,
    /// Configured nodes whose report for `height` is not the wallet's state.
    pub dissenting: usize,
    /// Configured nodes whose report for `height` is the wallet's state.
    pub agreeing: usize,
}

/// What [`WalletState::recover_locks`] read out of a state that does not validate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Recovery {
    /// An empty state for the same wallet with every lock that could be read: rescan into it.
    pub state: WalletState,
    pub entries_kept: usize,
    /// Entries of the pending list that named neither a nullifier nor an input commitment.
    pub entries_unreadable: usize,
    /// An entry was kept whose expiry could not be read: it is never released by height.
    pub expiry_unknown: bool,
    pub nodes_kept: bool,
    /// The recovered state is under the restore embargo (not every lock could be read, or the
    /// old state was under it).
    pub embargo: bool,
}

/// What [`WalletState::confirm_state`] concluded.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ConfirmReport {
    /// Nodes the wallet is configured with.
    pub configured: usize,
    /// The quorum that was applied: a strict majority of the CONFIGURED nodes
    /// (`configured / 2 + 1`), and never below 2. It does not depend on the reports supplied.
    pub quorum: usize,
    /// Distinct configured nodes among the reports supplied.
    pub nodes: usize,
    /// The highest height at which the quorum matched in THIS call.
    pub matched_height: Option<u64>,
    /// The highest height the state has ever had confirmed.
    pub confirmed_height: Option<u64>,
    /// Positions of the notes this call moved from unverified to confirmed.
    pub newly_confirmed: Vec<u64>,
    /// Configured nodes whose report is the wallet's state at `matched_height` (or, without a
    /// match, the best count reached at any height).
    pub agreeing: usize,
    /// Reports for heights the wallet has not scanned yet or no longer keeps the state of.
    pub not_comparable: usize,
    /// Reports under an id that is not a configured node (or not an http(s) origin): not counted.
    pub not_configured: usize,
    /// Every configured node whose report at a comparable height is NOT the wallet's state, with
    /// the height. **A dissenting minority does not block**: within the trust model (a strict
    /// minority of the configured nodes lies) a match by a strict majority contains an honest
    /// node, and that node's report is the chain's state at its height.
    pub dissenting: Vec<Dissent>,
    /// The heights of `dissenting`, ascending, each once.
    pub conflicts: Vec<u64>,
    /// `true`: nothing matched in this call and at least one configured node contradicts the
    /// wallet. Ask again; if it stays, see `listing_refuted`.
    pub diverged: bool,
    /// `true`: at some height more configured nodes contradict the wallet than a lying minority
    /// can be (`> configured − quorum`: never a strict minority of the configured nodes, however
    /// many heights or reports it uses). At least one of them is honest, so **the wallet's own
    /// listing is not the chain's**: rebuild from `fresh_for_rescan`. **Which node is to blame
    /// — if any — is in `refuted`**: only a height above the confirmed height implicates the
    /// node that listed it (`listing_refuted_above_confirmed`). (What was confirmed stays
    /// confirmed until the rescanned state replaces this one.)
    pub listing_refuted: bool,
    /// `true`: one of the heights of `refuted` is ABOVE the height the state had confirmed
    /// before this call — the part of the state that is one listing's word is contradicted, and
    /// the heights `from_height ..= height` of that entry were listed falsely (REVIEW_WALLET_6
    /// RW6-1). The listing node is to blame **if it is the node that served those heights**
    /// (`NOTES.md` §6: the loop keeps which node served which heights).
    pub listing_refuted_above_confirmed: bool,
    /// `true`: one of the heights of `refuted` is AT OR BELOW the height the state had confirmed
    /// before this call: what an earlier quorum vouched for is contradicted by more nodes than
    /// can be lying. Nobody is to blame for that (see [`Refutation`]): rescan, ban no node.
    pub confirmed_refuted: bool,
    /// Every height that made `listing_refuted` true, ascending, with the range of the listing
    /// that is in doubt. Empty when `listing_refuted` is false.
    pub refuted: Vec<Refutation>,
    /// The height a quorum of the configured nodes says the chain has reached: the quorum-th
    /// highest height among the nodes' reports. At least one honest node has reached it, and no
    /// lying minority can push it above the highest honest claim. `None` without that many
    /// reporting nodes.
    pub quorum_tip: Option<u64>,
    /// `true`: the wallet's listing shows pool transactions in blocks ABOVE `quorum_tip` —
    /// blocks a quorum of the configured nodes does not have (yet). For a moment that is normal
    /// (the listing node is a block ahead: ask again). If it stays, the listing node invented
    /// those blocks — a payment that is on no chain, or a spend of one of the wallet's notes
    /// that never happened, which would keep that note out of every balance for as long as
    /// nobody reports that height: rebuild from `fresh_for_rescan` against ANOTHER node. Nothing
    /// above the confirmed height is confirmed either way.
    pub listing_ahead: bool,
    /// Spent notes this call dropped from the state (see [`PRUNE_RETENTION_BLOCKS`]).
    pub pruned: usize,
    /// The highest height ANY configured node reported in this call (one node's word: a lying
    /// node can say anything here; it is used for the embargo base only, capped).
    pub highest_reported: Option<u64>,
    /// Distinct configured nodes that reported in this call, as `nodes`; `true` when that is
    /// every configured node.
    pub all_reported: bool,
    /// `quorum_tip − confirmed_height`: how many blocks the quorum is ahead of what this state
    /// has confirmed. A spend is measured from the confirmed height, so this many blocks of its
    /// life are already gone (REVIEW_WALLET_4 RW4-8).
    pub confirmed_lag: Option<u64>,
    /// `true`: this call established the embargo base of a state without lock history
    /// (see [`WalletState::spend_embargo`]).
    pub embargo_base_set: bool,
}

/// The pool state after the block at `height` (recorded at the heights where it changed).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Checkpoint {
    height: u64,
    root: B32,
    nullifier_acc: B32,
    note_count: u64,
    nullifier_count: u64,
    ciphertext_acc: B32,
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
    /// `true` (REVIEW_WALLET_4 RW4-3): the state was scanned without the nullifier key and
    /// cannot tell which of its notes were spent since ([`WalletState::view_only_since`]).
    /// `spendable` is then 0, and `confirmed` leaves out every note whose nullifier is unknown.
    pub unverified_spends: bool,
    /// In NONE of the figures above: notes at or below the confirmed height whose nullifier the
    /// state does not know — received for certain, **spent or not unknown**. Not a balance.
    pub received_spend_unknown: u128,
}

/// The persistent shielded-pool state of one wallet.
///
/// **Every field of the current format is required when a state is read** (REVIEW_WALLET_5
/// RW5-9): none has a serde default. A format-5 text that lacks `spend_embargo`,
/// `sole_copy_asserted`, `view_only_since`, `revision_id` or `own_shields` — the fields format 5
/// added — is refused (`state:`), not completed with a value that would read as "no embargo" or
/// "sees every spend"; `recover_locks` then reads its locks into a state that IS under the
/// embargo. The older formats, which never had these fields, are given them explicitly by their
/// migrations ([`WalletState::from_json`]).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WalletState {
    version: u32,
    /// Goes up by one with every change of the state (REVIEW_WALLET_2 I-3).
    revision: u64,
    /// What identifies this revision (REVIEW_WALLET_4 RW4-10): a hash over the previous
    /// revision's identity, the counter and the change. See [`WalletState::revision_id`].
    revision_id: B32,
    /// See [`SpendEmbargo`].
    spend_embargo: SpendEmbargo,
    /// The user's recorded statement that no other copy of the wallet has a payment in flight.
    sole_copy_asserted: bool,
    /// `Some(h)`: the state has been scanned without the nullifier key from height `h` on and
    /// no scan with the full key has repaired it yet (REVIEW_WALLET_4 RW4-3). Required in the
    /// text, as `null` or a height (serde would read a missing `Option` as `None`).
    #[serde(deserialize_with = "required_option")]
    view_only_since: Option<u64>,
    /// Shields the wallet made to its own address, not yet settled (RW4-11).
    own_shields: Vec<OwnShield>,
    /// The wallet's `pk`: a state is scanned with one key only.
    pk: B32,
    /// The next height to ask the node for (`since`).
    next_height: u64,
    /// Incoming notes below this value are counted in `below_minimum` and not stored.
    #[serde(with = "dec")]
    min_note_value: u64,
    tree: TreeTracker,
    /// Received notes beyond this many UNSPENT ones are counted in `over_capacity`, not stored.
    max_unspent_notes: u64,
    /// The nodes this wallet is configured with: canonical ids, sorted, each once.
    nodes: Vec<String>,
    /// The pool's running nullifier hash and nullifier count after the last scanned block.
    nullifier_acc: B32,
    nullifier_count: u64,
    /// The running hash over every listed output's ciphertexts after the last scanned block.
    ciphertext_acc: B32,
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
    /// Required (REVIEW_WALLET_5 RW5-9): a format-2 text without its pending list is not read
    /// as "no locks" — it is refused, and `recover_locks` puts what is left under the embargo.
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

/// State format 3 (REVIEW_WALLET_2), read only to be migrated.
#[derive(Deserialize)]
struct WalletStateV3 {
    revision: u64,
    pk: B32,
    #[serde(with = "dec")]
    min_note_value: u64,
    /// Required, as in format 2 (REVIEW_WALLET_5 RW5-9).
    pending: Vec<PendingTx>,
}

/// The fields format 5 added to the state text. A text of an OLDER format that carries
/// `spend_embargo` is not a text that format wrote (REVIEW_WALLET_5 RW5-9).
const FORMAT_5_FIELDS: [&str; 5] = ["revision_id", "spend_embargo", "sole_copy_asserted", "view_only_since", "own_shields"];

#[derive(Deserialize)]
struct VersionOnly {
    version: u32,
    /// Present or not — never its value. (The one serde default of the state reader that
    /// concerns the embargo, and it reads "absent" as absent.)
    #[serde(default)]
    spend_embargo: Option<serde::de::IgnoredAny>,
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
    kem_ct: Box<[u8; KEM_CT_BYTES]>,
    note_ct: [u8; NOTE_CT_BYTES],
    /// `(value, r, rho)` of a non-zero note that is this wallet's.
    mine: Option<(u64, [u8; 32], Digest)>,
    /// `mine` was opened by the wallet's own pending record (its change, a payment to itself).
    own: bool,
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
    /// value ([`DEFAULT_MIN_NOTE_VALUE`]) and the default cap on unspent notes
    /// ([`DEFAULT_MAX_UNSPENT_NOTES`]). Scanning it from height 0 is the restore of spec §5.4.
    /// It is configured with NO node: nothing can be confirmed before [`WalletState::set_nodes`].
    ///
    /// **A state made here has no lock history and is under the restore embargo**
    /// ([`WalletState::spend_embargo`], REVIEW_WALLET_4 RW4-1): it builds no spend until its
    /// confirmed height is 128 blocks above its embargo base — unless the user states that no
    /// other copy of the wallet has a payment in flight
    /// ([`WalletState::assert_no_other_copy_has_a_pending_payment`]).
    pub fn new(pk: [u8; 32]) -> Self {
        Self::empty(pk, DEFAULT_MIN_NOTE_VALUE, DEFAULT_MAX_UNSPENT_NOTES as u64)
    }

    /// [`WalletState::new`] with the caller's minimum note value, in quanta (at least 1). An
    /// incoming note below it is counted and not stored: it is not in any balance and cannot be
    /// spent from this state. `1` stores every non-zero note. The value holds for the life of
    /// the state; to change it, rescan ([`WalletState::fresh_for_rescan_with`]). The wallet's OWN
    /// outputs are stored whatever their size.
    pub fn with_min_note_value(pk: [u8; 32], min_note_value: u64) -> Result<Self, WalletError> {
        Self::with_limits(pk, min_note_value, DEFAULT_MAX_UNSPENT_NOTES)
    }

    /// [`WalletState::new`] with the caller's minimum note value and cap on unspent notes
    /// (1 to [`MAX_UNSPENT_NOTES_LIMIT`]).
    pub fn with_limits(pk: [u8; 32], min_note_value: u64, max_unspent_notes: usize) -> Result<Self, WalletError> {
        Self::check_limits(min_note_value, max_unspent_notes)?;
        Ok(Self::empty(pk, min_note_value, max_unspent_notes as u64))
    }

    fn check_limits(min_note_value: u64, max_unspent_notes: usize) -> Result<(), WalletError> {
        if min_note_value == 0 {
            return Err(WalletError::Request("the minimum note value must be at least 1 quantum".into()));
        }
        if max_unspent_notes == 0 || max_unspent_notes > MAX_UNSPENT_NOTES_LIMIT {
            return Err(WalletError::Request("the cap on unspent notes must be 1 to 1,048,576".into()));
        }
        Ok(())
    }

    fn empty(pk: [u8; 32], min_note_value: u64, max_unspent_notes: u64) -> Self {
        let tree = TreeTracker::new();
        Self {
            version: STATE_VERSION,
            revision: 0,
            revision_id: B32([0u8; 32]),
            spend_embargo: SpendEmbargo::AwaitingBase,
            sole_copy_asserted: false,
            view_only_since: None,
            own_shields: Vec::new(),
            pk: B32(pk),
            next_height: 0,
            min_note_value,
            max_unspent_notes,
            nodes: Vec::new(),
            checkpoints: vec![Checkpoint {
                height: 0,
                root: tree.root,
                nullifier_acc: B32([0u8; 32]),
                note_count: 0,
                nullifier_count: 0,
                ciphertext_acc: B32([0u8; 32]),
            }],
            tree,
            nullifier_acc: B32([0u8; 32]),
            nullifier_count: 0,
            ciphertext_acc: B32([0u8; 32]),
            notes: Vec::new(),
            pending: Vec::new(),
            confirmed_height: None,
            blind: BlindLog::default(),
            below_minimum: Tally::default(),
            over_capacity: Tally::default(),
            pruned: Tally::default(),
        }
    }

    /// An empty state for the same wallet that KEEPS the pending transactions and the configured
    /// nodes: what to rescan into after a reorganisation or a state check that refuted the
    /// listing (`ConfirmReport::listing_refuted`).
    ///
    /// **Every entry is carried over as pending and locked — never as mined or superseded.** What
    /// the old state had seen of it came from the listing that is being thrown away; the status
    /// is found again from the rescanned data, and nothing settles before `confirm_state` has
    /// confirmed that data. The locks are held by note commitment, so they apply as soon as the
    /// rescan finds the notes again. The revision continues. The confirmed height starts again
    /// at nothing: a new listing has to earn it.
    pub fn fresh_for_rescan(&self) -> Self {
        self.fresh_for_rescan_inner(self.min_note_value, self.max_unspent_notes)
    }

    /// The limits are set BEFORE the revision identity is computed (REVIEW_WALLET_5 RW5-6): two
    /// rescans of one state with different limits are two states with two identities.
    fn fresh_for_rescan_inner(&self, min_note_value: u64, max_unspent_notes: u64) -> Self {
        let mut s = Self::empty(self.pk.0, min_note_value, max_unspent_notes);
        s.revision = self.revision;
        s.revision_id = self.revision_id;
        s.nodes = self.nodes.clone();
        // the embargo is a property of the device's history, not of a listing: it is kept, and
        // an embargo that has a base keeps its base
        s.spend_embargo = self.spend_embargo;
        s.sole_copy_asserted = self.sole_copy_asserted;
        s.own_shields = self.own_shields.clone();
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
        s.bump("fresh_for_rescan");
        if s.returnable().is_err() {
            // cannot happen for a state that validated; if it does, no lock may be lost: every
            // entry is reduced to what a lock needs (see `recover_locks`)
            s.pending = self.pending.iter().filter_map(|p| serde_json::to_value(p).ok()).filter_map(|v| Self::lenient_entry(&v, None).map(|x| x.0)).collect();
            s.nodes.clear();
            s.own_shields.clear();
            s.bump("fresh_for_rescan");
        }
        s
    }

    /// [`WalletState::fresh_for_rescan`] with another minimum note value.
    pub fn fresh_for_rescan_with_min_note_value(&self, min_note_value: u64) -> Result<Self, WalletError> {
        self.fresh_for_rescan_with(Some(min_note_value), None)
    }

    /// [`WalletState::fresh_for_rescan`] with another minimum note value and / or another cap on
    /// unspent notes (`None`: keep the state's). **Raising the cap and rescanning is how the
    /// notes counted in [`WalletState::over_capacity`] are recovered**; lowering the minimum note
    /// value recovers those counted in [`WalletState::below_minimum`]. The limits are part of
    /// what the revision identity is computed over: a rescan with other limits has its own
    /// `revision_id` (REVIEW_WALLET_5 RW5-6).
    pub fn fresh_for_rescan_with(&self, min_note_value: Option<u64>, max_unspent_notes: Option<usize>) -> Result<Self, WalletError> {
        let min = min_note_value.unwrap_or(self.min_note_value);
        let cap = max_unspent_notes.unwrap_or(self.max_unspent_notes as usize);
        Self::check_limits(min, cap)?;
        Ok(self.fresh_for_rescan_inner(min, cap as u64))
    }

    /// Every change of the state ends here: the derived positions are recomputed, the counter
    /// goes up, and the revision's identity becomes
    /// `SHA-256(tag ‖ previous identity ‖ counter ‖ what ‖ digest of the changed state)`.
    fn bump(&mut self, what: &'static str) {
        self.rederive_inputs();
        self.revision = (self.revision + 1).min(MAX_REVISION);
        let mut h = Sha256::new();
        h.update(REVISION_ID_TAG);
        h.update(self.revision_id.0);
        h.update(self.revision.to_le_bytes());
        h.update((what.len() as u64).to_le_bytes());
        h.update(what.as_bytes());
        h.update(self.content_digest());
        self.revision_id = B32(h.finalize().into());
    }

    /// A digest of everything a change can touch: the scan position and the three running
    /// values, the confirmed height, the configured nodes, every stored note (commitment,
    /// nullifier known or not, spent height), the serialised pending list (the locks), the own
    /// shields, the embargo, the view-only mark and the tallies.
    fn content_digest(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        let opt = |v: Option<u64>| v.map_or([0xffu8; 9], |x| {
            let mut b = [0u8; 9];
            b[1..].copy_from_slice(&x.to_le_bytes());
            b
        });
        h.update(self.pk.0);
        for v in [self.next_height, self.min_note_value, self.max_unspent_notes, self.tree.note_count, self.nullifier_count, self.notes.len() as u64, self.nodes.len() as u64] {
            h.update(v.to_le_bytes());
        }
        for b in [&self.tree.root, &self.nullifier_acc, &self.ciphertext_acc] {
            h.update(b.0);
        }
        h.update(opt(self.confirmed_height));
        h.update(opt(self.view_only_since));
        for id in &self.nodes {
            h.update((id.len() as u64).to_le_bytes());
            h.update(id.as_bytes());
        }
        for n in &self.notes {
            h.update(n.cm.0);
            h.update([n.nullifier.is_some() as u8]);
            h.update(opt(n.spent_height));
        }
        let rest = (&self.pending, &self.own_shields, &self.spend_embargo, self.sole_copy_asserted, &self.blind, &self.below_minimum, &self.over_capacity, &self.pruned);
        h.update(serde_json::to_vec(&rest).unwrap_or_default());
        h.finalize().into()
    }

    /// `inputs` of every entry that holds its notes by commitment: the position of the stored
    /// note with that commitment (an unspent one first, the lowest position), else what the
    /// entry recorded last (REVIEW_WALLET_4 RW4-5). Nothing reads these positions to decide
    /// anything.
    fn rederive_inputs(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        let mut at: BTreeMap<B32, (bool, u64)> = BTreeMap::new();
        for n in &self.notes {
            let key = (n.spent, n.position);
            at.entry(n.cm).and_modify(|k| *k = (*k).min(key)).or_insert(key);
        }
        for p in self.pending.iter_mut().filter(|p| !p.input_cms.is_empty()) {
            p.inputs.resize(p.input_cms.len(), 0);
            for (slot, cm) in p.inputs.iter_mut().zip(&p.input_cms) {
                if let Some(&(_, position)) = at.get(cm) {
                    *slot = position;
                }
            }
        }
    }

    /// **No call hands out a state that `from_json` refuses** (REVIEW_WALLET_4 RW4-5): every
    /// call that changes a state checks the result with the validation `from_json` applies
    /// before it replaces the caller's state. A failure is an implementation fault — a debug
    /// build stops on it — and in a release build the call is refused with
    /// [`WalletError::StateInvariant`], the caller's state untouched.
    fn returnable(&self) -> Result<(), WalletError> {
        let v = self.validate();
        debug_assert!(v.is_ok(), "a call was about to return a state that does not read back: {v:?}");
        v.map_err(|_| WalletError::StateInvariant)
    }

    /// Runs a change on a copy and replaces `self` only if the result is returnable.
    fn guarded<T>(&mut self, change: impl FnOnce(&mut Self) -> Result<T, WalletError>) -> Result<T, WalletError> {
        let mut next = self.clone();
        let out = change(&mut next)?;
        next.returnable()?;
        *self = next;
        Ok(out)
    }

    /// The state as JSON. Never larger than `from_json` accepts: the number of stored notes is
    /// capped ([`MAX_STORED_NOTES`]), every other list is bounded, and the size is checked.
    ///
    /// **Never bytes that `from_json` refuses** (REVIEW_WALLET_4 RW4-5): the text is read back
    /// and compared with the state before it is returned, in every build. If it does not read
    /// back as this state the call fails with [`WalletError::StateInvariant`] and returns
    /// nothing — the caller keeps the state it has stored.
    pub fn to_json(&self) -> Result<String, WalletError> {
        let json = serde_json::to_string(self).map_err(|_| WalletError::Internal("state encoding"))?;
        if json.len() > MAX_STATE_JSON_BYTES {
            return Err(WalletError::State("the state would be larger than 256 MiB".into()));
        }
        match Self::from_json(&json) {
            Ok(back) if back == *self => Ok(json),
            _ => Err(WalletError::StateInvariant),
        }
    }

    /// Parses and validates a state. Format 5 is read as is.
    ///
    /// **Format 4 is migrated in place**: the notes, the tree, the history, the confirmed height
    /// and EVERY pending entry are kept as they are. The positions its entries recorded are no
    /// longer read (a format-4 state that RW4-5 had made unreadable — an entry naming one
    /// position twice — is read again, with its locks). It is a device's own state, so it is
    /// under no embargo. Its configured nodes are kept if they satisfy the rule for a node set
    /// ([`WalletState::set_nodes`]) and dropped otherwise (configure again); a state that held
    /// notes without a nullifier is marked view-only.
    ///
    /// **Formats 1, 2 and 3 are migrated to an EMPTY state that keeps the locks**, to be scanned
    /// from the activation height. Formats 1 and 2 did not record the pool's nullifier hash and
    /// format 3 did not record the ciphertext hash; neither can be computed afterwards (each
    /// runs over everything since activation), so an old state's notes can never be confirmed
    /// under the current rules; a rescan finds every one of them again. A migrated state is
    /// configured with no node: call [`WalletState::set_nodes`].
    ///
    /// * Format 3: every pending entry is carried over as pending and locked, with its two
    ///   nullifiers, two outputs and expiry; the minimum note value and the revision are kept.
    ///   Its change record has no `r`, so the change is found through its ciphertext — which the
    ///   confirmed ciphertext hash now covers. **A format-3 expiry was bounded by the SCANNED
    ///   height (REVIEW_WALLET_3 RW3-7) and is kept as recorded**: the transaction really is
    ///   valid until then, so shortening it here would release a lock on a live transaction. A
    ///   format-3 entry built after a lying page keeps its long lock; no client was released on
    ///   format 3.
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
    ///
    /// **A state that does not validate is not the end** (RW4-5): [`WalletState::recover_locks`]
    /// reads every pending entry it can out of the same text into an empty state to rescan
    /// into. Never answer a `state:` error with [`WalletState::new`]: that state has no locks.
    pub fn from_json(json: &str) -> Result<Self, WalletError> {
        if json.len() > MAX_STATE_JSON_BYTES {
            return Err(WalletError::State("the state is larger than 256 MiB".into()));
        }
        let bad = |e: serde_json::Error| WalletError::State(json_error("wallet state", &e));
        let v: VersionOnly = serde_json::from_str(json).map_err(bad)?;
        if (1..STATE_VERSION).contains(&v.version) && v.spend_embargo.is_some() {
            // RW5-9: no older format wrote this field. A format-5 text whose version number is
            // damaged must not be read as an older format — which would end its embargo.
            return Err(WalletError::State("the state names an older format and carries a spend embargo: its version is damaged (recover_locks reads its locks)".into()));
        }
        let s = match v.version {
            1 => Self::migrate_v1(serde_json::from_str(json).map_err(bad)?)?,
            2 => Self::migrate_v2(serde_json::from_str(json).map_err(bad)?)?,
            3 => Self::migrate_v3(serde_json::from_str(json).map_err(bad)?)?,
            4 => {
                // format 4 is format 5 without the five fields format 5 added: they are given
                // their migration values EXPLICITLY here — nothing is left to a default
                let mut text: serde_json::Value = serde_json::from_str(json).map_err(bad)?;
                let Some(fields) = text.as_object_mut() else { return Err(WalletError::State("the state is not a JSON object".into())) };
                if FORMAT_5_FIELDS.iter().any(|k| fields.contains_key(*k)) {
                    return Err(WalletError::State("the state names format 4 and carries fields of format 5: its version is damaged (recover_locks reads its locks)".into()));
                }
                fields.insert("revision_id".into(), serde_json::json!(B32([0u8; 32])));
                // a device's own stored state: its lock history continues, no embargo
                fields.insert("spend_embargo".into(), serde_json::json!(SpendEmbargo::NotRequired));
                fields.insert("sole_copy_asserted".into(), serde_json::json!(false));
                fields.insert("view_only_since".into(), serde_json::Value::Null);
                fields.insert("own_shields".into(), serde_json::json!([]));
                Self::migrate_v4(serde_json::from_value(text).map_err(bad)?)
            }
            STATE_VERSION => {
                let mut s: Self = serde_json::from_str(json).map_err(bad)?;
                s.set_confirmed_flags();
                s.rederive_inputs();
                s
            }
            _ => return Err(WalletError::State("unknown state version (this wallet reads versions 1 to 5)".into())),
        };
        s.validate()?;
        Ok(s)
    }

    fn set_confirmed_flags(&mut self) {
        let confirmed = self.confirmed_height;
        for n in self.notes.iter_mut() {
            n.confirmed = confirmed.is_some_and(|c| n.height <= c);
        }
    }

    fn synthetic_expiry(old_next_height: u64) -> u64 {
        old_next_height.saturating_sub(1).saturating_add(MAX_EXPIRY_OFFSET)
    }

    /// An empty state for a migration from formats 1 to 3: the device's own history continues,
    /// so there is no embargo.
    fn migrated(pk: [u8; 32], min_note_value: u64) -> Self {
        let mut s = Self::empty(pk, min_note_value, DEFAULT_MAX_UNSPENT_NOTES as u64);
        s.spend_embargo = SpendEmbargo::NotRequired;
        s
    }

    fn migrate_v1(old: WalletStateV1) -> Result<Self, WalletError> {
        let mut s = Self::migrated(old.pk.0, DEFAULT_MIN_NOTE_VALUE);
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
                own_payment: None,
                expiry_height: expiry,
                status: PendingStatus::Pending,
                seen_height: None,
                rejected_hint: false,
                abandoned_hint: false,
                legacy: true,
            });
        }
        Ok(s)
    }

    fn migrate_v2(old: WalletStateV2) -> Result<Self, WalletError> {
        let mut s = Self::migrated(old.pk.0, DEFAULT_MIN_NOTE_VALUE);
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
                // lock then stays on the position, as format 2 held it (and on the nullifier)
                input_cms: cms.unwrap_or_default(),
                input_total: p.input_total,
                change: p.change,
                own_payment: None,
                expiry_height: p.expiry_height.unwrap_or(synthetic),
                status: PendingStatus::Pending,
                seen_height: None,
                rejected_hint: p.rejected_hint,
                abandoned_hint: false,
                legacy,
            });
        }
        Ok(s)
    }

    fn migrate_v3(old: WalletStateV3) -> Result<Self, WalletError> {
        if old.min_note_value == 0 || old.revision > MAX_REVISION {
            return Err(WalletError::State("the revision or the minimum note value is out of range".into()));
        }
        let mut s = Self::migrated(old.pk.0, old.min_note_value);
        s.revision = old.revision;
        s.pending = old
            .pending
            .into_iter()
            .map(|mut p| {
                // what format 3 had seen came from a listing whose ciphertexts nobody vouched for
                p.status = PendingStatus::Pending;
                p.seen_height = None;
                p.own_payment = None;
                p.abandoned_hint = false;
                p
            })
            .collect();
        s.bump("migrate_v3");
        Ok(s)
    }

    /// Format 4 → 5, in place: see [`WalletState::from_json`].
    fn migrate_v4(mut s: Self) -> Self {
        s.version = STATE_VERSION;
        s.revision_id = B32([0u8; 32]);
        s.spend_embargo = SpendEmbargo::NotRequired;
        s.sole_copy_asserted = false;
        s.own_shields.clear();
        s.set_confirmed_flags();
        let canonical: Option<Vec<String>> = s.nodes.iter().map(|id| canonical_node_id(id).ok().filter(|c| c == id)).collect();
        if canonical.is_none() || check_node_set(&s.nodes).is_err() {
            s.nodes.clear();
        }
        let blind = s.notes.iter().any(|n| n.nullifier.is_none()) || !s.blind.seen.is_empty() || s.blind.overflow;
        s.view_only_since = blind.then_some(0);
        s.revision = s.revision.min(MAX_REVISION);
        s.bump("migrate_v4");
        s
    }

    // ---- recovery of the locks of a state that does not validate (REVIEW_WALLET_4 RW4-5) ----------

    /// What a pending entry must satisfy in a stored state.
    fn entry_ok(p: &PendingTx, next_height: u64) -> bool {
        let distinct = |v: &[B32]| v.len() < 2 || v[0] != v[1];
        // an entry that holds its notes by commitment names no position that matters; one that
        // does not (migrated from format 2 without its notes) is held by position, as it was
        let inputs_ok = if p.input_cms.is_empty() {
            p.inputs.len() <= 2 && (p.inputs.len() < 2 || p.inputs[0] != p.inputs[1]) && !(p.inputs.is_empty() && p.nullifiers.is_empty())
        } else {
            p.inputs.len() == p.input_cms.len()
        };
        let cms_ok = p.input_cms.len() <= 2 && distinct(&p.input_cms);
        let nf_ok = p.nullifiers.len() <= 2 && distinct(&p.nullifiers) && (p.legacy || p.nullifiers.len() == 2);
        let out_ok = matches!(p.outputs.len(), 0 | 2)
            && distinct(&p.outputs)
            && (p.legacy || p.outputs.len() == 2 || p.change.is_some())
            && !(p.change.is_some() && p.change.as_ref().map(|c| c.cm) == p.own_payment.as_ref().map(|c| c.cm));
        let type_ok = p.tx_type.is_empty() || TX_TYPES[1..].contains(&p.tx_type.as_str());
        let seen_ok = (p.status == PendingStatus::Pending) == p.seen_height.is_none() && p.seen_height.is_none_or(|h| h < next_height);
        inputs_ok && cms_ok && nf_ok && out_ok && type_ok && seen_ok
    }

    /// Reads what a LOCK needs out of one pending entry, however damaged the rest of it is:
    /// the nullifiers, the input commitments, the outputs, the own outputs and the expiry.
    /// `None`: the value names neither a nullifier nor an input commitment — there is nothing a
    /// lock could be held by. The flag: the expiry was not readable and was replaced.
    fn lenient_entry(v: &serde_json::Value, fallback_expiry: Option<u64>) -> Option<(PendingTx, bool)> {
        let hexes = |key: &str| -> Vec<B32> {
            let mut out: Vec<B32> = Vec::new();
            for x in v.get(key).and_then(|a| a.as_array()).into_iter().flatten().filter_map(|x| x.as_str()).filter_map(hex32).map(B32) {
                if !out.contains(&x) && out.len() < 2 {
                    out.push(x);
                }
            }
            out
        };
        let nullifiers = hexes("nullifiers");
        let input_cms = hexes("input_cms");
        let positions: Vec<u64> = v.get("inputs").and_then(|a| a.as_array()).into_iter().flatten().filter_map(|x| x.as_u64()).take(2).collect();
        if nullifiers.is_empty() && input_cms.is_empty() {
            return None;
        }
        let mut outputs = hexes("outputs");
        if outputs.len() != 2 {
            outputs.clear();
        }
        let own = |key: &str| v.get(key).and_then(|c| serde_json::from_value::<PendingChange>(c.clone()).ok());
        let change = own("change");
        let own_payment = own("own_payment").filter(|c| change.as_ref().map(|x| x.cm) != Some(c.cm));
        let tx_type = v.get("tx_type").and_then(|t| t.as_str()).filter(|t| TX_TYPES[1..].contains(t)).unwrap_or("").to_string();
        let (expiry_height, guessed) = match v.get("expiry_height").and_then(|e| e.as_u64()) {
            Some(e) => (e, false),
            // never released by height: it settles when one of its nullifiers is confirmed
            None => (fallback_expiry.unwrap_or(MAX_REVISION), true),
        };
        let inputs = if input_cms.is_empty() {
            if positions.len() == 2 && positions[0] == positions[1] { positions[..1].to_vec() } else { positions }
        } else {
            (0..input_cms.len()).map(|i| positions.get(i).copied().unwrap_or(0)).collect()
        };
        let complete = nullifiers.len() == 2 && outputs.len() == 2 && !tx_type.is_empty();
        let legacy = !complete || v.get("legacy").and_then(|l| l.as_bool()).unwrap_or(false);
        let input_total = v.get("input_total").and_then(|t| t.as_str().and_then(|s| s.parse().ok()).or(t.as_u64())).unwrap_or(0);
        let p = PendingTx {
            tx_type,
            nullifiers,
            outputs,
            inputs,
            input_cms,
            input_total,
            change,
            own_payment,
            expiry_height,
            status: PendingStatus::Pending,
            seen_height: None,
            rejected_hint: v.get("rejected_hint").and_then(|x| x.as_bool()).unwrap_or(false),
            abandoned_hint: v.get("abandoned_hint").and_then(|x| x.as_bool()).unwrap_or(false),
            legacy,
        };
        Self::entry_ok(&p, 0).then_some((p, guessed))
    }

    /// **The answer to a `state:` error** (REVIEW_WALLET_4 RW4-5 (c)): reads every pending entry
    /// it can out of a stored state that [`WalletState::from_json`] refuses — nullifiers, input
    /// commitments, outputs, own outputs with their `r`, expiry — into an EMPTY state for the
    /// same wallet, to be scanned from the activation height like [`WalletState::fresh_for_rescan`].
    /// Every lock that can be read is kept; the configured nodes, the minimum note value, the
    /// cap and the revision are kept where they are readable and valid. It also reads a state
    /// that does validate (the result is then `fresh_for_rescan`'s, entry for entry).
    ///
    /// **The embargo.** If every entry of the list was read, the device's lock history is
    /// complete and the old state's embargo is carried over as it was — a format-5 text that
    /// does not say where it stood (no readable `spend_embargo`) is under the embargo. If an entry could not be
    /// read at all, or the list itself is missing, a transaction of this device may be in flight
    /// without a lock: the recovered state is then under the restore embargo like a state made
    /// by [`WalletState::new`] ([`Recovery::embargo`]). An entry whose expiry could not be read
    /// is kept and never released by height.
    ///
    /// Refused: text that is not a JSON object with the wallet's `pk`, or larger than a state
    /// can be. What the text does not hold cannot be recovered; with no stored state at all,
    /// [`WalletState::new`] and its embargo are what is left.
    pub fn recover_locks(json: &str) -> Result<Recovery, WalletError> {
        if json.len() > MAX_STATE_JSON_BYTES {
            return Err(WalletError::State("the state is larger than 256 MiB".into()));
        }
        let v: serde_json::Value = serde_json::from_str(json).map_err(|e| WalletError::State(json_error("wallet state", &e)))?;
        let pk = v.get("pk").and_then(|p| p.as_str()).and_then(hex32).ok_or_else(|| WalletError::State("the state does not name the wallet (pk)".into()))?;
        let number = |key: &str| v.get(key).and_then(|x| x.as_u64().or_else(|| x.as_str().and_then(|s| s.parse().ok())));
        let min = number("min_note_value").filter(|m| *m > 0).unwrap_or(DEFAULT_MIN_NOTE_VALUE);
        let cap = number("max_unspent_notes").filter(|c| *c > 0 && *c <= MAX_UNSPENT_NOTES_LIMIT as u64).unwrap_or(DEFAULT_MAX_UNSPENT_NOTES as u64);
        let mut s = Self::empty(pk, min, cap);
        s.revision = number("revision").unwrap_or(0).min(MAX_REVISION);
        s.revision_id = v.get("revision_id").and_then(|r| r.as_str()).and_then(hex32).map(B32).unwrap_or_default();
        let ids: Option<Vec<String>> = v.get("nodes").and_then(|n| n.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).filter_map(|x| canonical_node_id(x).ok()).collect());
        let mut nodes: Vec<String> = ids.unwrap_or_default().into_iter().collect::<BTreeSet<_>>().into_iter().collect();
        if check_node_set(&nodes).is_err() {
            nodes.clear();
        }
        let nodes_kept = !nodes.is_empty();
        s.nodes = nodes;
        // the height an unreadable expiry is replaced from, as the migrations do
        let fallback = number("next_height").map(Self::synthetic_expiry);
        let list = v.get("pending").and_then(|p| p.as_array());
        let (mut kept, mut unreadable, mut guessed_any) = (0usize, 0usize, false);
        let (mut own, mut legacy) = (0usize, 0usize);
        for entry in list.into_iter().flatten() {
            let Some((mut p, guessed)) = Self::lenient_entry(entry, fallback) else {
                unreadable += 1;
                continue;
            };
            if !p.legacy && own >= MAX_PENDING {
                p.legacy = true; // more than a state takes as its own: still a lock
            }
            if p.legacy && legacy >= MAX_LEGACY_LOCKS {
                unreadable += 1;
                continue;
            }
            own += !p.legacy as usize;
            legacy += p.legacy as usize;
            guessed_any |= guessed;
            kept += 1;
            s.pending.push(p);
        }
        s.own_shields = v.get("own_shields").and_then(|o| serde_json::from_value::<Vec<OwnShield>>(o.clone()).ok()).filter(|o| Self::own_shields_ok(o)).unwrap_or_default();
        let complete = list.is_some() && unreadable == 0 && !guessed_any;
        let version = number("version").unwrap_or(0);
        let old_embargo = v.get("spend_embargo").and_then(|e| serde_json::from_value::<SpendEmbargo>(e.clone()).ok());
        // an older format had no embargo and wrote no such field; a text that names an older
        // format AND carries the field is a format-5 text with a damaged version, and is
        // treated by what the field says (REVIEW_WALLET_5 RW5-9)
        let older_format = (1..=4).contains(&version) && v.get("spend_embargo").is_none();
        s.spend_embargo = match (complete, older_format, old_embargo) {
            (true, true, _) => SpendEmbargo::NotRequired,
            (true, false, Some(e)) if Self::embargo_ok(&e) => e,
            _ => SpendEmbargo::AwaitingBase,
        };
        s.sole_copy_asserted = complete && s.spend_embargo != SpendEmbargo::NotRequired && v.get("sole_copy_asserted").and_then(|x| x.as_bool()).unwrap_or(false);
        if let SpendEmbargo::Until { waived: true, .. } = s.spend_embargo {
            // a waiver belongs to the base it was honoured on; the rescan earns a new one
            s.spend_embargo = SpendEmbargo::AwaitingBase;
        }
        s.bump("recover_locks");
        s.validate().map_err(|_| WalletError::StateInvariant)?;
        let embargo = s.spend_embargo != SpendEmbargo::NotRequired;
        Ok(Recovery { state: s, entries_kept: kept, entries_unreadable: unreadable, expiry_unknown: guessed_any, nodes_kept, embargo })
    }

    fn own_shields_ok(list: &[OwnShield]) -> bool {
        let mut seen = BTreeSet::new();
        list.len() <= MAX_OWN_SHIELDS && list.iter().all(|s| s.value > 0 && seen.insert(s.cm))
    }

    fn embargo_ok(e: &SpendEmbargo) -> bool {
        match *e {
            SpendEmbargo::NotRequired | SpendEmbargo::AwaitingBase => true,
            SpendEmbargo::Until { first_confirmed, base, until, waived: true } => base == first_confirmed && until == first_confirmed,
            SpendEmbargo::Until { first_confirmed, base, until, waived: false } => {
                base >= first_confirmed && until == base.saturating_add(RESTORE_EMBARGO_BLOCKS)
            }
        }
    }

    fn validate(&self) -> Result<(), WalletError> {
        let bad = |what: &'static str| Err(WalletError::State(what.into()));
        if self.version != STATE_VERSION {
            return bad("unknown state version");
        }
        if self.revision > MAX_REVISION || self.min_note_value == 0 {
            return bad("the revision or the minimum note value is out of range");
        }
        if self.max_unspent_notes == 0 || self.max_unspent_notes > MAX_UNSPENT_NOTES_LIMIT as u64 {
            return bad("the cap on unspent notes is out of range");
        }
        if self.nodes.len() > MAX_CONFIGURED_NODES
            || self.nodes.windows(2).any(|w| w[0] >= w[1])
            || self.nodes.iter().any(|id| canonical_node_id(id).ok().as_deref() != Some(id.as_str()))
        {
            return bad("the configured nodes are not canonical, sorted and distinct");
        }
        if check_node_set(&self.nodes).is_err() {
            return bad("the configured nodes are not a valid set (https only outside a loopback development set, one node per host)");
        }
        if !Self::embargo_ok(&self.spend_embargo) || (self.spend_embargo == SpendEmbargo::NotRequired && self.sole_copy_asserted) {
            return bad("the spend embargo is inconsistent");
        }
        if !Self::own_shields_ok(&self.own_shields) {
            return bad("the record of own shields is malformed");
        }
        self.tree.check()?;
        let unspent = self.notes.iter().filter(|n| !n.spent).count();
        // a pending entry holds at most four stored notes: two by its nullifiers (a nullifier
        // belongs to one `rho`, and no two stored notes share one — checked below) and two by
        // its input commitments or, for an entry migrated without them, its positions
        let spent_bound = MAX_SPENT_RETAINED + 4 * (MAX_PENDING + MAX_LEGACY_LOCKS);
        if unspent > MAX_UNSPENT_NOTES_LIMIT + OWN_OUTPUT_SLACK || self.notes.len() - unspent > spent_bound || self.tree.tracked.len() > self.notes.len() {
            return bad("the state stores more notes than it can hold");
        }
        let mut seen = BTreeSet::new();
        let mut rhos = BTreeSet::new();
        for n in &self.notes {
            if n.position >= self.tree.note_count || !seen.insert(n.position) || n.output_index > 1 || n.value == 0 {
                return bad("a stored note is inconsistent with the tree");
            }
            // REVIEW_WALLET_5 RW5-1 (b): one `rho`, one note. `scan` refuses the page that
            // would store a second one, so this holds for every state a call returns.
            if !rhos.insert(n.rho) {
                return bad("two stored notes have one rho (a transaction listed twice)");
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
            if !Self::entry_ok(p, self.next_height) {
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
            c.root != self.tree.root
                || c.nullifier_acc != self.nullifier_acc
                || c.note_count != self.tree.note_count
                || c.nullifier_count != self.nullifier_count
                || c.ciphertext_acc != self.ciphertext_acc
        }) {
            return bad("the state history does not end at the current tree root, nullifier hash and ciphertext hash");
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
        match self.view_only_since {
            // a state that is not view-only knows every note's nullifier and remembers nothing
            None if self.notes.iter().any(|n| n.nullifier.is_none()) || !self.blind.seen.is_empty() || self.blind.overflow => {
                return bad("a note without a nullifier in a state that is not marked view-only");
            }
            Some(h) if h > self.next_height => return bad("the view-only mark is above the scanned height"),
            _ => {}
        }
        Ok(())
    }

    pub fn pk(&self) -> [u8; 32] {
        self.pk.0
    }
    /// The revision COUNTER: goes up with every change. It orders the revisions of one lineage
    /// and identifies nothing — two writers that start from revision `r` both arrive at `r + 1`
    /// with different states (REVIEW_WALLET_4 RW4-10). What identifies a state is
    /// [`WalletState::revision_id`].
    pub fn revision(&self) -> u64 {
        self.revision
    }
    /// **The identity of this revision** (REVIEW_WALLET_4 RW4-10):
    /// `SHA-256(tag ‖ identity of the previous revision ‖ counter ‖ name of the change ‖ digest
    /// of the changed state)`. Two states have one identity only if they came from the same
    /// state by the same change with the same result, so two tabs that both build from revision
    /// `r` hold two different "r + 1". A caller with more than one writer stores the identity
    /// next to the state, persists a state only if the stored identity is still the one it
    /// LOADED (compare-and-swap in its storage transaction), and checks the state in hand with
    /// [`WalletState::expect_revision_id`] before it changes anything.
    pub fn revision_id(&self) -> [u8; 32] {
        self.revision_id.0
    }
    /// Refuses with [`WalletError::StaleState`] unless this state IS the revision the caller
    /// read from its storage — the same identity, not merely the same counter.
    pub fn expect_revision_id(&self, expected: &[u8; 32]) -> Result<(), WalletError> {
        if self.revision_id.0 == *expected {
            Ok(())
        } else {
            Err(WalletError::StaleState)
        }
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
    /// `true` when the two states hold the same data, whatever their revisions and their embargo
    /// (two states that reached the same chain by different sequences of calls).
    pub fn content_eq(&self, other: &Self) -> bool {
        let mut o = other.clone();
        o.revision = self.revision;
        o.revision_id = self.revision_id;
        // the embargo is the device's history, like the revision: not data about the chain
        o.spend_embargo = self.spend_embargo;
        o.sole_copy_asserted = self.sole_copy_asserted;
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
    /// The cap on unspent notes received from others (see [`DEFAULT_MAX_UNSPENT_NOTES`]).
    pub fn max_unspent_notes(&self) -> usize {
        self.max_unspent_notes as usize
    }
    /// Incoming notes that arrived while the state already held `max_unspent_notes` UNSPENT
    /// notes: counted, not stored. **Recovered by a rescan with a higher cap**
    /// ([`WalletState::fresh_for_rescan_with`]), or with a minimum note value above the notes
    /// that fill the state, or after spending or merging notes. A running total of what
    /// arrived, not a balance.
    pub fn over_capacity(&self) -> Tally {
        self.over_capacity
    }
    /// The nodes this wallet is configured with: canonical ids, sorted.
    pub fn nodes(&self) -> &[String] {
        &self.nodes
    }
    /// The quorum [`WalletState::confirm_state`] applies: a strict majority of the configured
    /// nodes, never below 2.
    pub fn quorum(&self) -> usize {
        (self.nodes.len() / 2 + 1).max(MIN_CONFIGURED_NODES)
    }

    /// Configures the nodes this wallet asks for the pool state — **the set the quorum is a
    /// strict majority OF** (REVIEW_WALLET_3 RW3-1). Every id is canonicalised
    /// ([`canonical_node_id`]: an http(s) origin, lower-cased, default port and path removed, an
    /// IP literal in its one canonical spelling) and two spellings of one id are collapsed.
    /// Returns the canonical set.
    ///
    /// **The rule for the set** (REVIEW_WALLET_4 RW4-2, RW4-7), which refuses the whole call:
    ///
    /// * every node is an `https` origin — `http` is accepted for loopback hosts only
    ///   (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`), for development;
    /// * a loopback node is never counted in a quorum with a node that is not loopback: a set
    ///   is either all loopback (a development set, its nodes told apart by port) or has none;
    /// * **one node per host**, whatever the scheme or the port: `https://h` and
    ///   `https://h:8443` are one operator and may hold one vote, so configuring both is refused.
    ///
    /// This is an explicit decision of the user or the application, and the ONLY way the
    /// threshold changes: `confirm_state` never derives it from the reports it is handed, so
    /// asking fewer nodes — or leaving out a node that disagrees — can only make a confirmation
    /// harder, never easier. Changing the set does not un-confirm what was confirmed; it applies
    /// to every later confirmation. With fewer than two nodes nothing can be confirmed: a
    /// single-node wallet shows everything as unverified. Choose an odd number of at least
    /// three, run by different operators.
    pub fn set_nodes<S: AsRef<str>>(&mut self, ids: &[S]) -> Result<Vec<String>, WalletError> {
        let mut set = BTreeSet::new();
        for id in ids {
            set.insert(canonical_node_id(id.as_ref())?);
        }
        let nodes: Vec<String> = set.into_iter().collect();
        check_node_set(&nodes)?;
        if nodes != self.nodes {
            self.guarded(|s| {
                s.nodes = nodes;
                s.bump("set_nodes");
                Ok(())
            })?;
        }
        Ok(self.nodes.clone())
    }

    // ---- the embargo after a restore (REVIEW_WALLET_4 RW4-1) ------------------------------------------

    /// Where this state stands with the restore embargo.
    ///
    /// **The rule.** A state made by [`WalletState::new`] has no lock history. It builds no
    /// spend before a confirmed height exists, and the FIRST call of
    /// [`WalletState::confirm_state`] that confirms a height `C0` fixes the **embargo base**:
    ///
    /// * `Tq`: the quorum's tip — the highest height that a strict majority of the configured
    ///   nodes claim to have reached (each node's claim is the highest height it reported);
    /// * `Tm`: the highest height ANY configured node claimed in that call;
    /// * `base = min(Tm, Tq + 256)` when every configured node reported, and `Tq + 256` when
    ///   one did not (a node that is silent is treated as if it had claimed the highest tip);
    /// * no spend until the confirmed height is at least `base + 128`.
    ///
    /// **Why.** An earlier copy that built at confirmed height `C_b` had a quorum for `C_b`, so
    /// at least one HONEST node had reached `C_b`; its transaction is dead after block
    /// `C_b + 128`. If `base ≥ C_b`, then at confirmed height `base + 128` every block that
    /// could hold it has been read: it is mined, and its inputs are spent in this state, or it
    /// never will be. A lying minority cannot lower `Tq` below what the honest nodes that
    /// answer support, and it cannot hide the tip of an honest node that answers (`Tm`); by
    /// claiming a high tip, or by not answering, it can only push the base UP — by at most 256
    /// blocks.
    ///
    /// **What remains** (it is a margin, not a proof): the rule is sufficient iff
    /// `C_b ≤ Tq + 256` — the nodes whose tips made the first quorum after the restore are not
    /// more than 256 blocks behind the height the lost copy last built at. Where fewer nodes
    /// lie than two quorums must share (`2·quorum − n`; four nodes and one liar, for instance)
    /// the quorums have an honest node in common and no assumption on lag is needed; with
    /// three, five or seven nodes and a full lying minority they may share only liars, and then
    /// this bound is all there is.
    pub fn spend_embargo(&self) -> SpendEmbargo {
        self.spend_embargo
    }

    /// The confirmed height from which this state may build a spend: `None` while it has no
    /// embargo base (nothing confirmed since it was made — no spend at all), `Some(0)` for a
    /// state with a lock history ([`SpendEmbargo::NotRequired`]), `Some(until)` otherwise.
    pub fn spend_embargo_until(&self) -> Option<u64> {
        match self.spend_embargo {
            SpendEmbargo::NotRequired => Some(0),
            SpendEmbargo::AwaitingBase => None,
            SpendEmbargo::Until { until, .. } => Some(until),
        }
    }

    /// `true` once the user's statement was recorded
    /// ([`WalletState::assert_no_other_copy_has_a_pending_payment`]).
    pub fn sole_copy_asserted(&self) -> bool {
        self.sole_copy_asserted
    }

    /// **The override of the restore embargo — the user's statement, recorded in the state**:
    /// "no other copy of this wallet (another device, a lost device, an old backup) has a
    /// payment that is still in flight". A new wallet on a new phrase can say so truthfully; a
    /// restore after a lost device usually cannot. The core cannot check it, and if it is false
    /// the wallet can pay twice.
    ///
    /// Accepted only before the state has its embargo base (before the first confirmed state
    /// check) — afterwards the call is refused. **Once recorded, it stands**: the first
    /// confirmed state check establishes the state without an embargo, whatever the reports of
    /// that call show (REVIEW_WALLET_5 RW5-5 — the rule of the previous revision, which
    /// disregarded the statement when a configured node reported a tip above the height being
    /// confirmed, cost an honest user 129 blocks for a one-block race between three answers and
    /// stopped no liar, who only had to wait for a call in which the leading node was slow).
    /// The statement is therefore exactly as strong as it is true: **a client calls this without
    /// asking only for a phrase that was generated on this device in this installation, and for
    /// an imported or restored phrase only after the user confirmed it explicitly**
    /// (`UI_CONTRACT.md`, obligation 1).
    pub fn assert_no_other_copy_has_a_pending_payment(&mut self) -> Result<(), WalletError> {
        if self.spend_embargo != SpendEmbargo::AwaitingBase {
            return Err(WalletError::Request("the statement that no other copy has a pending payment is accepted only before the first confirmed state check".into()));
        }
        if !self.sole_copy_asserted {
            self.guarded(|s| {
                s.sole_copy_asserted = true;
                s.bump("assert_sole_copy");
                Ok(())
            })?;
        }
        Ok(())
    }

    /// The gate every spend passes (builders and [`WalletState::mark_pending`]), after the
    /// confirmed-height check: a view-only state builds nothing ([`WalletError::ViewOnly`]); a
    /// state under the restore embargo builds nothing ([`WalletError::RestoredRecently`]).
    pub fn spend_gate(&self) -> Result<(), WalletError> {
        if self.view_only_since.is_some() {
            return Err(WalletError::ViewOnly);
        }
        match self.spend_embargo {
            SpendEmbargo::NotRequired => Ok(()),
            SpendEmbargo::AwaitingBase => Err(WalletError::RestoredRecently { until: None }),
            SpendEmbargo::Until { until, .. } if self.confirmed_height.is_some_and(|c| c >= until) => Ok(()),
            SpendEmbargo::Until { until, .. } => Err(WalletError::RestoredRecently { until: Some(until) }),
        }
    }

    /// `Some(h)`: the state has been scanned WITHOUT the nullifier key from height `h` on
    /// (REVIEW_WALLET_4 RW4-3). Such a state cannot see spends: its `confirmed` balance leaves
    /// out every note whose nullifier it does not know, `spendable` is 0, coin selection offers
    /// nothing and the builders refuse it — until one page (an empty one will do) has been
    /// scanned with the full key, which derives every missing nullifier and applies every spend
    /// that was remembered.
    pub fn view_only_since(&self) -> Option<u64> {
        self.view_only_since
    }

    /// Can a spend be built now, and if not, why — with every bound in blocks (REVIEW_WALLET_4
    /// RW4-8). `quorum_tip`: the `quorum_tip` of the latest [`ConfirmReport`], if the caller has
    /// one; it gives the confirmed lag and the window that is left for a spend.
    pub fn spend_status(&self, quorum_tip: Option<u64>) -> SpendStatus {
        let confirmed = self.confirmed_height;
        let lag = quorum_tip.zip(confirmed).map(|(t, c)| t.saturating_sub(c));
        let window = lag.map(|l| DEFAULT_SPEND_WINDOW.saturating_sub(l));
        let embargo_until = match self.spend_embargo {
            SpendEmbargo::NotRequired => Some(0),
            SpendEmbargo::AwaitingBase => None,
            SpendEmbargo::Until { until, .. } => Some(until),
        };
        let root_confirmed = confirmed.is_some_and(|c| self.state_at(c).is_some_and(|v| v.tree_root == self.tree.root.0 && v.note_count == self.tree.note_count));
        let reason = if self.nodes.len() < MIN_CONFIGURED_NODES {
            Some("no_nodes")
        } else if self.view_only_since.is_some() {
            Some("view_only")
        } else if confirmed.is_none() {
            Some("no_quorum")
        } else if self.spend_gate().is_err() {
            Some("embargo")
        } else if !root_confirmed {
            Some("root_unconfirmed")
        } else if window == Some(0) {
            Some("window_too_short")
        } else {
            None
        };
        SpendStatus {
            can_spend_now: reason.is_none(),
            reason,
            confirmed_height: confirmed,
            confirmed_lag: lag,
            usable_window_blocks: window,
            embargo_until,
            embargo_blocks_left: embargo_until.map(|u| u.saturating_sub(confirmed.unwrap_or(0))).filter(|_| confirmed.is_some()),
            view_only_since: self.view_only_since,
            default_expiry_blocks: DEFAULT_SPEND_WINDOW,
            max_expiry_blocks: MAX_EXPIRY_OFFSET,
            restore_embargo_blocks: RESTORE_EMBARGO_BLOCKS,
            restore_lag_bound_blocks: RESTORE_LAG_BOUND_BLOCKS,
        }
    }

    // ---- shields to the wallet's own address (REVIEW_WALLET_4 RW4-11) -----------------------------------

    /// The shields to this wallet's own address that are recorded and not settled.
    pub fn own_shields(&self) -> &[OwnShield] {
        &self.own_shields
    }

    /// Records a `shield_v2` the wallet made to its OWN address, so that its note is stored from
    /// the record — whatever its value — when the scan meets the commitment ([`OwnShield`]).
    /// **Clients do not call this**: [`crate::build_own_shield`] does, and returns the state
    /// with the transaction. Refused: a zero value, a commitment already recorded, more than
    /// [`MAX_OWN_SHIELDS`] records.
    pub fn record_own_shield(&mut self, shield: OwnShield) -> Result<(), WalletError> {
        if shield.value == 0 || shield.cm.0 == [0u8; 32] {
            return Err(WalletError::Request("an own shield has a non-zero value and commitment".into()));
        }
        if self.own_shields.iter().any(|s| s.cm == shield.cm) {
            return Err(WalletError::Request("this shield is already recorded".into()));
        }
        if self.own_shields.len() >= MAX_OWN_SHIELDS {
            return Err(WalletError::Request("too many unsettled shields to the wallet's own address: confirm the state first".into()));
        }
        self.guarded(|s| {
            s.own_shields.push(shield);
            s.bump("record_own_shield");
            Ok(())
        })
    }

    /// Drops the own-shield records that are settled at the confirmed height (see [`OwnShield`]).
    fn settle_own_shields(&mut self) {
        let Some(confirmed) = self.confirmed_height else { return };
        let (notes, min) = (&self.notes, self.min_note_value);
        self.own_shields.retain(|s| match notes.iter().find(|n| n.cm == s.cm && n.height <= confirmed) {
            Some(n) => n.value < min && !n.spent, // only unspent dust still needs its record
            None => confirmed < s.expiry_height,
        });
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
    /// The running hash over the ciphertexts of every output this state has read.
    pub fn ciphertext_acc(&self) -> [u8; 32] {
        self.ciphertext_acc.0
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
            ciphertext_acc: c.ciphertext_acc.0,
        })
    }

    /// What a spend is built on (REVIEW_WALLET_3 RW3-7): `(anchor, base height)`.
    ///
    /// The base height is the **confirmed height** — the only height a strict majority of the
    /// configured nodes vouched for. The builders measure `expiry_height` from it and from
    /// nothing else. Without a confirmed height there is nothing to measure from and nothing is
    /// built ([`WalletError::StateUnconfirmed`]), whatever `allow_unverified` says.
    ///
    /// The anchor is the wallet's tree root, which the input paths lead to. It must be the root
    /// the quorum confirmed: if the listing has shown outputs above the confirmed height, the
    /// root is one node's word and the call refuses with [`WalletError::StateUnconfirmed`] —
    /// confirm the state first — unless `allow_unverified`, the caller's explicit decision to
    /// build on an unconfirmed root (the expiry is still measured from the confirmed height).
    pub fn spend_base(&self, allow_unverified: bool) -> Result<([u8; 32], u64), WalletError> {
        let confirmed = self.confirmed_height.ok_or(WalletError::StateUnconfirmed)?;
        let root_confirmed = self.state_at(confirmed).is_some_and(|v| v.tree_root == self.tree.root.0 && v.note_count == self.tree.note_count);
        if !root_confirmed && !allow_unverified {
            return Err(WalletError::StateUnconfirmed);
        }
        // a view-only state and a state under the restore embargo build nothing (RW4-1, RW4-3)
        self.spend_gate()?;
        Ok((self.tree.root.0, confirmed))
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
        let view_only = self.view_only_since.is_some();
        let mut b = Balances { unverified_spends: view_only, ..Default::default() };
        for n in self.notes.iter().filter(|n| !n.spent) {
            let v = n.value as u128;
            let locked = self.pending.iter().any(|p| p.locks(n));
            if n.confirmed && n.nullifier.is_none() {
                // received for certain; whether it was spent since, this state cannot see (RW4-3)
                b.received_spend_unknown += v;
            } else if n.confirmed {
                b.confirmed += v;
                if !locked && !view_only {
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
            self.pending.iter().filter(|p| p.status == PendingStatus::Pending).flat_map(|p| p.own_outputs()).map(|c| c.value as u128).sum();
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

    /// Records a transfer or unshield and locks its inputs. **Clients do not call this**: the
    /// builders ([`crate::build_transfer`], [`crate::build_unshield`]) call it and hand back the
    /// transaction TOGETHER with the state in which it is recorded (REVIEW_WALLET_3 RW3-5). It
    /// is public for tools and tests that assemble a record themselves. From then on the inputs
    /// cannot be selected or handed to a builder until [`WalletState::resolve`] settles the
    /// entry on confirmed data. No answer of a node unlocks them.
    ///
    /// Refused: a state without a confirmed height ([`WalletError::StateUnconfirmed`]); **an
    /// expiry more than 128 blocks above the CONFIRMED height** (RW3-7: the bound that ends a
    /// lock is measured from a height a quorum vouched for — never from the scanned height,
    /// which is one node's claim); a record without two distinct nullifiers or two distinct
    /// non-zero output commitments; an own output (change, payment to self) whose commitment is
    /// not one of the outputs; inputs that are not unspent, unlocked notes of this state whose
    /// values add up to `input_total`; an input whose stored nullifier is not the transaction's
    /// nullifier for that input slot.
    pub fn mark_pending(&mut self, tx: PendingTx) -> Result<(), WalletError> {
        self.guarded(|s| s.mark_pending_inner(tx))
    }

    fn mark_pending_inner(&mut self, mut tx: PendingTx) -> Result<(), WalletError> {
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
        if tx.own_outputs().any(|c| !tx.outputs.contains(&c.cm)) {
            return bad("the expected change is not one of the transaction's outputs");
        }
        if tx.change.is_some() && tx.change.as_ref().map(|c| c.cm) == tx.own_payment.as_ref().map(|c| c.cm) {
            return bad("the change and the payment to self are the same output");
        }
        let confirmed = self.confirmed_height.ok_or(WalletError::StateUnconfirmed)?;
        self.spend_gate()?;
        if tx.expiry_height > confirmed.saturating_add(MAX_EXPIRY_OFFSET) {
            return bad("the expiry height is more than 128 blocks above the confirmed height");
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
        tx.abandoned_hint = false;
        tx.legacy = false;
        self.pending.push(tx);
        self.bump("mark_pending");
        Ok(())
    }

    /// For a client that built a transaction and is CERTAIN it never handed it to any node (the
    /// user cancelled before the submit, the submit call was never made). Records that on the
    /// pending entry with this nullifier (`abandoned_hint`) and returns whether it was found.
    ///
    /// **It releases nothing.** The inputs stay locked until [`WalletState::resolve`] settles the
    /// entry as expired — that is, until the confirmed height has reached its `expiry_height`,
    /// at most 128 blocks above the confirmed height it was built at. The core cannot check that
    /// the transaction never left the device (a retry path, a second tab, a crashed submit that
    /// did go out), and if the claim is wrong, releasing the inputs is a double payment. So even
    /// a wrong call here is safe: it is a note for the user interface ("cancelled — funds free
    /// again in about N blocks").
    pub fn abandon_unsubmitted(&mut self, nullifier: &[u8; 32]) -> bool {
        self.guarded(|s| match s.pending.iter_mut().find(|p| p.nullifiers.iter().any(|n| n.0 == *nullifier)) {
            Some(p) => {
                p.abandoned_hint = true;
                s.bump("abandon_unsubmitted");
                Ok(true)
            }
            None => Ok(false),
        })
        .unwrap_or(false)
    }

    /// Records that a node answered "rejected" for the pending transaction with this nullifier.
    /// Only a flag for the UI: the transaction is still valid until its expiry height and its
    /// inputs stay locked (a node that lies about a rejection can still have it mined).
    pub fn note_rejection_hint(&mut self, nullifier: &[u8; 32]) -> bool {
        self.guarded(|s| match s.pending.iter_mut().find(|p| p.nullifiers.iter().any(|n| n.0 == *nullifier)) {
            Some(p) => {
                p.rejected_hint = true;
                s.bump("note_rejection_hint");
                Ok(true)
            }
            None => Ok(false),
        })
        .unwrap_or(false)
    }

    /// Settles the pending list **against the confirmed height** and removes what is settled —
    /// the three outcomes of [`Resolution`]. An entry the scan has seen mined or superseded at a
    /// height ABOVE the confirmed height is not settled and not dropped: one node listed it,
    /// nobody vouched for it. Without a confirmed height nothing settles.
    ///
    /// Nothing here depends on what a node answered to the submission, on the scanned height, or
    /// on any other single node's word. There is no other way to release a lock.
    pub fn resolve(&mut self) -> Resolution {
        let held = self.pending.len();
        // a result that would not read back settles nothing and releases nothing
        self.guarded(|s| Ok(s.resolve_inner())).unwrap_or(Resolution { still_pending: held, ..Default::default() })
    }

    fn resolve_inner(&mut self) -> Resolution {
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
            self.bump("resolve");
        }
        out
    }

    // ---- state confirmation -------------------------------------------------------------------------

    /// Compares the wallet's own pool state with what its configured nodes report, and moves the
    /// confirmed height to the highest height `h` at which **a strict majority of the CONFIGURED
    /// nodes** ([`WalletState::set_nodes`]) reported **exactly the wallet's tree root, nullifier
    /// hash, ciphertext hash, note count and nullifier count at `h`**. Notes created at or below
    /// it become `confirmed`; pending transactions settle against it ([`WalletState::resolve`]).
    ///
    /// Why this is evidence. The root commits every output commitment up to that height in
    /// order; the nullifier hash commits every nullifier up to that height in order; the
    /// ciphertext hash commits the two ciphertexts of every output; a listed transaction is two
    /// consecutive entries of each. If all are the nodes', every transaction the wallet read up
    /// to that height — which nullifiers with which outputs and which ciphertexts — is one those
    /// nodes hold, and no other.
    ///
    /// **The quorum** (REVIEW_WALLET_3 RW3-1) is `configured / 2 + 1`, at least 2, of the
    /// configured set — a property of the STATE, not of this call:
    ///
    /// * a report under an id that is not configured is not counted (`not_configured`);
    /// * a node counts at most once per height: two different reports from one node for one
    ///   height make that node dissent there;
    /// * handing in fewer reports cannot lower the threshold. There is no quorum argument;
    /// * with fewer than two configured nodes nothing is confirmed, ever.
    ///
    /// **A dissenting minority does not block.** Within the trust model — a strict minority of
    /// the configured nodes lies arbitrarily — a strict majority contains an honest node, and an
    /// honest node's report is the chain's state at its height: the wallet's state there is the
    /// chain's whatever the others say. Every dissenting node is returned by id and height
    /// (`dissenting`), so that a user interface can say "node X disagrees". When more nodes
    /// contradict the wallet at one height than a lying minority can be, the wallet's own
    /// listing is what is wrong (`listing_refuted`): rescan against another node. The same when
    /// the listing shows transactions in blocks above the height a quorum has reached and keeps
    /// doing so (`listing_ahead`, `quorum_tip`): nobody can contradict a block nobody has, so
    /// that is the one lie about the wallet's own notes a state comparison cannot catch.
    ///
    /// What it is not: proof against the chain. It is the word of a majority of the nodes the
    /// wallet was configured with; if most of them lie, or are one operator, everything
    /// "confirmed" is theirs. Reports for heights the wallet has not scanned, or whose state it
    /// no longer keeps, cannot be compared.
    pub fn confirm_state(&mut self, reports: &[StateReport]) -> Result<ConfirmReport, WalletError> {
        self.guarded(|s| s.confirm_state_inner(reports))
    }

    fn confirm_state_inner(&mut self, reports: &[StateReport]) -> Result<ConfirmReport, WalletError> {
        if reports.len() > MAX_STATE_REPORTS {
            return Err(WalletError::Request("more than 1,024 state reports".into()));
        }
        let configured = self.nodes.len();
        let quorum = self.quorum();
        let mut out = ConfirmReport { configured, quorum, confirmed_height: self.confirmed_height, ..Default::default() };
        // (height, configured node) → what that node reported there; `None`: two different reports
        let mut said: BTreeMap<(u64, usize), Option<PoolView>> = BTreeMap::new();
        let mut asked = BTreeSet::new();
        for r in reports {
            let Some(node) = canonical_node_id(&r.node_id).ok().and_then(|id| self.nodes.binary_search(&id).ok()) else {
                out.not_configured += 1;
                continue;
            };
            asked.insert(node);
            match said.get_mut(&(r.height, node)) {
                None => {
                    said.insert((r.height, node), Some(r.view()));
                }
                Some(v) if *v != Some(r.view()) => *v = None,
                Some(_) => {}
            }
        }
        out.nodes = asked.len();
        // the quorum-th highest height the configured nodes claim
        let mut tops: BTreeMap<usize, u64> = BTreeMap::new();
        for &(height, node) in said.keys() {
            let top = tops.entry(node).or_insert(height);
            *top = (*top).max(height);
        }
        let mut tops: Vec<u64> = tops.into_values().collect();
        tops.sort_unstable_by(|a, b| b.cmp(a));
        if configured >= MIN_CONFIGURED_NODES {
            out.quorum_tip = tops.get(quorum - 1).copied();
        }
        out.highest_reported = tops.first().copied();
        out.all_reported = configured > 0 && tops.len() == configured;
        out.listing_ahead = out.quorum_tip.is_some_and(|tip| self.checkpoints.last().is_some_and(|c| c.height > tip));
        let mut matched: Option<(u64, usize)> = None;
        // what a quorum had vouched for BEFORE this call (RW6-1): a contradiction at or below it
        // is not a statement about the pages above it
        let confirmed_before = self.confirmed_height;
        let heights: BTreeSet<u64> = said.keys().map(|&(h, _)| h).collect();
        for height in heights {
            let at = said.range((height, 0)..=(height, usize::MAX));
            let Some(mine) = self.state_at(height) else {
                out.not_comparable += at.count();
                continue;
            };
            let (mut agreeing, mut dissenting) = (0usize, 0usize);
            for (&(_, node), view) in at {
                if *view == Some(mine) {
                    agreeing += 1;
                } else {
                    dissenting += 1;
                    out.dissenting.push(Dissent { node_id: self.nodes[node].clone(), height });
                }
            }
            if dissenting > 0 {
                out.conflicts.push(height);
            }
            // more dissent than a lying minority can be (`configured − quorum` is the largest
            // strict minority that leaves a quorum: `dissenting` is then at least half of the
            // configured nodes, never a strict minority): an honest node says that the state at
            // this height is not the chain's. WHERE the listing went wrong — and so whose
            // pages are in doubt — depends on what was confirmed before (RW6-1, `Refutation`).
            if configured >= MIN_CONFIGURED_NODES && dissenting > configured - quorum {
                out.listing_refuted = true;
                let below = confirmed_before.is_some_and(|c| height <= c);
                if below {
                    out.confirmed_refuted = true;
                } else {
                    out.listing_refuted_above_confirmed = true;
                }
                let from_height = if below { 0 } else { confirmed_before.map_or(0, |c| c + 1) };
                out.refuted.push(Refutation { from_height, height, confirmed: below, dissenting, agreeing });
            }
            if configured >= MIN_CONFIGURED_NODES && agreeing >= quorum {
                matched = Some((height, agreeing)); // ascending: the last match is the highest
            }
            if matched.is_none() {
                out.agreeing = out.agreeing.max(agreeing);
            }
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
            // the first confirmation of a state without lock history fixes its embargo base
            // (REVIEW_WALLET_4 RW4-1; the rule and its arithmetic: `spend_embargo`)
            if self.spend_embargo == SpendEmbargo::AwaitingBase {
                let quorum_tip = out.quorum_tip.unwrap_or(h).max(h);
                let highest = out.highest_reported.unwrap_or(h).max(quorum_tip);
                let ceiling = quorum_tip.saturating_add(RESTORE_LAG_BOUND_BLOCKS);
                // the user's statement, recorded before the base existed, stands (REVIEW_WALLET_5
                // RW5-5: the earlier rule voided it when a configured node reported above `h` —
                // an honest user lost a true statement to a one-block race, and a liar only had
                // to wait for a call in which the leading node was slow)
                let waived = self.sole_copy_asserted;
                let base = if waived {
                    h
                } else if out.all_reported {
                    highest.min(ceiling)
                } else {
                    ceiling // a node that did not answer is taken to have claimed the highest tip
                };
                let until = if waived { h } else { base.saturating_add(RESTORE_EMBARGO_BLOCKS) };
                self.spend_embargo = SpendEmbargo::Until { first_confirmed: h, base, until, waived };
                out.embargo_base_set = true;
            }
            self.settle_own_shields();
            out.pruned = self.prune();
            self.bump("confirm_state");
        }
        out.confirmed_lag = out.quorum_tip.zip(self.confirmed_height).map(|(t, c)| t.saturating_sub(c));
        out.diverged = matched.is_none() && !out.dissenting.is_empty();
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

    /// Keeps at most [`MAX_SPENT_RETAINED`] spent notes (the most recently spent; an input of a
    /// pending entry is always kept) and drops the rest into the `pruned` tally. Called at the
    /// end of every page, so that a scan over a long history never holds more than that plus one
    /// page of spent notes: spent notes cannot fill a state (REVIEW_WALLET_3 RW3-4). A spent
    /// note is in no balance and has no path; what a rescan needs of it, the rescan reads again.
    fn drop_old_spent(&mut self) -> usize {
        let spent = self.notes.iter().filter(|n| n.spent).count();
        if spent <= MAX_SPENT_RETAINED {
            return 0;
        }
        let mut by_age: Vec<(u64, u64)> = self.notes.iter().filter(|n| n.spent).map(|n| (n.spent_height.unwrap_or(0), n.position)).collect();
        by_age.sort_unstable();
        let cut = by_age[spent - MAX_SPENT_RETAINED]; // everything strictly older goes
        let before = self.notes.len();
        let (pending, pruned) = (&self.pending, &mut self.pruned);
        self.notes.retain(|n| {
            let drop = n.spent && (n.spent_height.unwrap_or(0), n.position) < cut && !pending.iter().any(|p| p.locks(n));
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
    ///    note below the state's minimum note value and a note that arrives while the state holds
    ///    its cap of UNSPENT notes are counted and not stored. **An output the wallet created
    ///    itself** — its commitment is the change or the payment-to-self of a pending entry, and
    ///    the entry's `(value, r)` open it — **is stored from the record**: whatever the listing
    ///    served as its ciphertext, whatever its size, whatever the count. So is a note for this
    ///    wallet in a transaction that spends one of this wallet's notes (only the wallet's key
    ///    makes such a transaction): the wallet's own change is recognised on a restore too,
    ///    where no pending record exists (not when scanning with the viewing key alone, which
    ///    cannot see spends);
    /// 5. both ciphertexts of each output enter the wallet's running ciphertext hash
    ///    ([`ciphertext_acc_step`]), which `confirm_state` compares with the nodes'.
    ///
    /// **Every string of the page is validated before anything is stored**: nullifiers,
    /// commitments, ciphertexts and `tx_hash` are fixed-length lowercase hexadecimal, `tx_type`
    /// is one of the three V2 types, and a nullifier or a commitment is a canonical digest of
    /// spec §2.8.
    ///
    /// **Every error has one cause** (REVIEW_WALLET_6 RW6-2; the table is in `NOTES.md` §6):
    ///
    /// * the PAGE — anything about its content that is invalid, whatever it is — is
    ///   [`WalletError::Listing`], and nothing else is. The state is unchanged;
    /// * the caller's KEY: [`WalletError::Request`] (another wallet's key),
    ///   [`WalletError::NonCanonical`] (`pk` or `nk` is not a digest), [`WalletError::Key`];
    /// * the caller's STATE: [`WalletError::RescanRequired`] (below), [`WalletError::State`]
    ///   (a stored note's `rho` is not a digest: no page stores such a note);
    /// * an implementation fault: [`WalletError::StateInvariant`].
    ///
    /// **A page that says `active: false`** (the node's chain has no activation height for
    /// the pool) is not read: the state is unchanged and the report says `pool_active: false`
    /// (RW6-3). That is neither an error nor an empty pool.
    ///
    /// **Viewing key first, full key later** (F-3). While the state holds a note without a
    /// nullifier (it was found with `nk = None`), every nullifier that appears is remembered, up
    /// to [`MAX_BLIND_NULLIFIERS`]. When a key with `nk` is supplied, every missing nullifier is
    /// derived and every remembered spend is applied before the page. If more nullifiers
    /// appeared than the state could remember, the scan refuses with
    /// [`WalletError::RescanRequired`].
    ///
    /// The page must continue this state's heights exactly (`from_height`) and number its
    /// outputs consecutively; a page that does not is refused and the state is left untouched.
    /// A page whose numbering starts ABOVE the wallet's tree skipped something and is refused;
    /// one whose numbering starts BELOW it is applied and reported (`ScanReport::leaf_mismatch`):
    /// leaf numbers are a node's claim, not the wallet's data. An EMPTY state accepts a page
    /// that starts above its next height (the jump to the activation height); what such a page
    /// skipped is found out by `confirm_state`, whose nullifier hash and root then differ from
    /// the nodes'. The page is validated and trial-decrypted completely before the state is
    /// changed, in place: the whole page is applied or nothing.
    ///
    /// **A page that cannot be applied consistently is a `listing:` error** (REVIEW_WALLET_5
    /// RW5-1), found before the state is touched: a page that lists a note of this wallet with
    /// the `rho` of a note the state already holds (a transaction shown twice — twins, or
    /// several notes under one nullifier), and any page for a state whose blind log (above)
    /// holds a nullifier listed BELOW the height of the note it would spend. Neither is the
    /// listing of a chain; the answer is the one to every `listing:` error — the node lies:
    /// rescan against another one.
    ///
    /// **The state this call leaves is one `from_json` reads** (REVIEW_WALLET_4 RW4-5): the
    /// result is validated before it replaces the caller's state. That validation failing is
    /// an implementation fault and nothing a page can cause: [`WalletError::StateInvariant`],
    /// the state unchanged — stop and report it (`NOTES.md` §6).
    /// Whatever a listing does to leaf positions, the pending entries are untouched by it: they
    /// hold their notes by commitment and nullifier.
    pub fn scan(&mut self, page: &ListingPage, key: &ScanKey) -> Result<ScanReport, WalletError> {
        self.guarded(|s| s.scan_inner(page, key))
    }

    /// [`WalletState::scan`] for several pages of ONE node, in order, each as the text the node
    /// answered with (REVIEW_WALLET_6B RW6B-1) — what the WebAssembly export `scan_pages` runs.
    ///
    /// * **Every page is classified exactly as `ListingPage::from_json` + `scan` classify it**:
    ///   whatever is wrong with a page — a body that is not a page, a missing or ill-typed
    ///   member, a value `scan` refuses — is that page's [`WalletError::Listing`];
    /// * **all or nothing**: on any error the state is unchanged — the pages before the refused
    ///   one are NOT applied — and the error says which page it was ([`PageError::index`]), so
    ///   that a client that mixed nothing knows which answer it was;
    /// * on success: one report per page.
    ///
    /// All-or-nothing because a batch is one node's word for one round: a client that keeps the
    /// first pages of a node it is about to ban has to rescan them away anyway, and one that is
    /// about to count a strike keeps the state it has stored.
    pub fn scan_pages<S: AsRef<str>>(&mut self, pages: &[S], key: &ScanKey) -> Result<Vec<ScanReport>, PageError> {
        let mut next = self.clone();
        let mut reports = Vec::with_capacity(pages.len());
        for (index, text) in pages.iter().enumerate() {
            let report = ListingPage::from_json(text.as_ref()).and_then(|page| next.scan(&page, key)).map_err(|error| PageError { index, error })?;
            reports.push(report);
        }
        *self = next;
        Ok(reports)
    }

    fn scan_inner(&mut self, page: &ListingPage, key: &ScanKey) -> Result<ScanReport, WalletError> {
        let listing = |what: &'static str| WalletError::Listing(what.into());
        if key.pk != self.pk.0 {
            return Err(WalletError::Request("this state belongs to another wallet (pk differs)".into()));
        }
        if !page.active {
            // "the pool is not active on this node": nothing to read, nothing changed, and
            // nothing else of the page is looked at (RW6-3: `pool_active` is false)
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
        // a state that a call returned or `from_json` read validates: anything else is a fault
        self.validate().map_err(|_| WalletError::StateInvariant)?;
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
                // (no page stores such a note — `rho` is computed, `derive_rho` — so this is a state
                // text that was edited: the caller's state, `state:`)
                let rho = field::digest(&n.rho.0, "rho").map_err(|_| WalletError::State("a stored note's rho is not a canonical digest".into()))?;
                fill.push((i, field::bytes(&nullifier(nk, &rho))));
            }
            if !fill.is_empty() && self.blind.overflow {
                return Err(WalletError::RescanRequired);
            }
            // REVIEW_WALLET_5 RW5-1 (a). The pages this state was read from WITHOUT `nk` showed
            // a nullifier at a height BELOW the block that created the note it belongs to. On a
            // chain a note is spent in a later block than the one that created it (the spend
            // proves against an anchor that already holds the note), so those pages were not a
            // chain's listing — an order of transactions no quorum will confirm. Applying the
            // sighting would write a note spent before it existed; the scan refuses instead,
            // as for any page that does not continue a consistent listing: `listing:`, the
            // state unchanged, and the answer is the one to every `listing:` error — rescan
            // against another node (`fresh_for_rescan` drops what was remembered).
            for &(i, nf) in &fill {
                let n = &self.notes[i];
                if n.spent_height.is_none() && self.blind.seen.iter().any(|seen| seen.nf.0 == nf && seen.height < n.height) {
                    return Err(listing("the listing this state was read from shows a nullifier before the note it spends: rescan against another node"));
                }
            }
        }
        let room = (1u64 << TREE_DEPTH) - self.tree.note_count;
        if 2 * page.txs.len() as u64 > room {
            return Err(listing("the page has more outputs than the commitment tree has room for"));
        }
        // the outputs the wallet created itself: commitment → (value, r) of the pending record
        let own_outputs: BTreeMap<[u8; 32], (u64, [u8; 32])> = self
            .pending
            .iter()
            .flat_map(|p| p.own_outputs())
            .filter_map(|c| c.r.map(|r| (c.cm.0, (c.value, r.0))))
            // … and the notes of the wallet's own shields (RW4-11)
            .chain(self.own_shields.iter().map(|s| (s.cm.0, (s.value, s.r.0))))
            .collect();
        // REVIEW_WALLET_5 RW5-1 (b): the `rho` of every note this state holds, and of the notes
        // of this wallet met so far in this page. `rho = H_rho(nf1, nf2, j)` names the output
        // slot `j` of the ONE transaction with the nullifiers `(nf1, nf2)`, and no two
        // transactions of a chain share a nullifier (spec §2.4): two notes with one `rho` exist
        // in no chain's listing — only in one that shows a transaction twice (the same outputs:
        // twins with one commitment; or other outputs under the same nullifiers: different
        // notes with ONE nullifier, since a note's nullifier is `H(nk, rho)`).
        let mut seen_rho: BTreeSet<[u8; 32]> = self.notes.iter().map(|n| n.rho.0).collect();
        let mut prepared: Vec<PreparedTx> = Vec::with_capacity(page.txs.len());
        let mut last: Option<(u64, u64)> = None;
        // The leaf numbers of a listing are the LISTING NODE's count; a note's position is where
        // the wallet's own tree puts it (REVIEW_WALLET_4 RW4-5: positions are derived). Inside
        // a page the numbers must be consecutive — anything else is a malformed page. A page
        // that starts ABOVE the wallet's count skips leaves the wallet never read (missed
        // transactions): refused, as ever. A page that starts BELOW it is NOT refused: the
        // listing this state was built on held more than this node has (forged entries, or a
        // reorganisation), so it is the wallet's earlier listing that is in doubt, not this
        // page — the page is applied at the wallet's own positions, the state stays one every
        // call reads, the state check decides, and the report says so (`leaf_mismatch`): rescan.
        let mut expected_leaf = self.tree.note_count;
        let mut leaf_offset: Option<u64> = None;
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
            // REVIEW_WALLET_6 RW6-2: 32 bytes that are not a digest of spec §2.8 (a word ≥ p) are
            // a malformed string of the page like any other — `listing:`, never `non_canonical:`,
            // which the loop has no rule for but "stop"
            let nf = [
                field::digest(&nf_b[0], "nf1").map_err(|_| listing("nf1 is not a canonical digest"))?,
                field::digest(&nf_b[1], "nf2").map_err(|_| listing("nf2 is not a canonical digest"))?,
            ];
            if nf_b[0] == nf_b[1] {
                return Err(listing("a listed transaction has nf1 = nf2"));
            }
            let mut outs: [Option<PreparedOutput>; 2] = [None, None];
            for (j, out) in tx.outputs.iter().enumerate() {
                let cm_b = hex32(&out.cm_out).ok_or_else(|| listing("cm_out is not 32 bytes of lowercase hex"))?;
                let cm = field::digest(&cm_b, "cm_out").map_err(|_| listing("cm_out is not a canonical digest"))?;
                let kem: [u8; KEM_CT_BYTES] = hex_exact(&out.kem_ct).ok_or_else(|| listing("kem_ct is not 1,088 bytes of lowercase hex"))?;
                let note_ct: [u8; NOTE_CT_BYTES] = hex_exact(&out.note_ct).ok_or_else(|| listing("note_ct is not 56 bytes of lowercase hex"))?;
                let leaf = out.leaf.ok_or_else(|| listing("an output has no leaf position"))?;
                let offset = *leaf_offset.get_or_insert(leaf.wrapping_sub(expected_leaf));
                if leaf.wrapping_sub(expected_leaf) != offset || (offset != 0 && leaf >= expected_leaf) {
                    return Err(listing(
                        "the outputs of the page are not at consecutive leaf positions (missed transactions or a reorganisation)",
                    ));
                }
                expected_leaf += 1;
                // trial decryption, then the recipient check of spec §2.4.1; a zero-value note
                // is nothing to keep
                let opens = |value: u64, r_b: [u8; 32]| {
                    let r = field::digest(&r_b, "r").ok()?;
                    let rho = derive_rho(&nf, j);
                    (value > 0 && Note { value, pk, rho, r }.commitment() == cm).then_some((value, r_b, rho))
                };
                // an output of the wallet's own pending transaction is opened by the record: no
                // ciphertext is needed for it and none is believed (RW3-2)
                let own = own_outputs.get(&cm_b).and_then(|&(value, r_b)| opens(value, r_b));
                let mine = match own {
                    Some(note) => Some(note),
                    None => decrypt_note(&dk, &kem, &note_ct, &cm_b).and_then(|(value, r_b)| opens(value, r_b)),
                };
                // RW5-1 (b): a note of this wallet with the `rho` of a note the state already
                // holds, or of one this page already listed. Such a page is refused whole,
                // before the state is touched: the second note could never be confirmed, it
                // shares its nullifier — and so its lock and its spend — with the first, and,
                // repeated often enough, it is how a listing made this call leave a state with
                // more spent notes than a state may hold (every note with the nullifier of a
                // pending entry's input is "an input of a pending entry", and none is dropped).
                if mine.as_ref().is_some_and(|(_, _, rho)| !seen_rho.insert(field::bytes(rho))) {
                    return Err(listing("the listing shows a transaction that pays this wallet a second time (two notes with one rho): it is not a chain's listing; rescan against another node"));
                }
                outs[j] = Some(PreparedOutput { cm: cm_b, kem_ct: Box::new(kem), note_ct, mine, own: own.is_some() });
            }
            let [Some(o0), Some(o1)] = outs else { return Err(WalletError::StateInvariant) };
            prepared.push(PreparedTx { height: tx.height, nf: nf_b, tx_hash: tx.tx_hash.clone(), outputs: [o0, o1] });
        }

        // ---- pass 2: apply. Nothing below can fail (the tree was checked, its room measured) -------
        let mut report = ScanReport { leaf_mismatch: leaf_offset.is_some_and(|o| o != 0), pool_active: true, ..Default::default() };
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
            self.view_only_since = None;
        } else if self.view_only_since.is_none() {
            // from here on this state does not see spends (RW4-3)
            self.view_only_since = Some(self.next_height);
        }
        // the nullifiers that would spend a note of this wallet (most listed ones spend none)
        let mut own_nf: BTreeSet<[u8; 32]> = self.notes.iter().filter(|n| n.spent_height.is_none()).filter_map(|n| n.nullifier.map(|x| x.0)).collect();
        // the cap counts UNSPENT notes: kept current as notes are spent and stored below
        let mut unspent = self.notes.iter().filter(|n| !n.spent).count();
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
            let spent_before = report.spent.len();
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
                let held_by_position = p.input_cms.is_empty();
                for i in 0..p.nullifiers.len() {
                    if tx.nf.contains(&p.nullifiers[i].0) {
                        let (cm, pos) = (p.input_cms.get(i).copied(), p.inputs.get(i).copied().filter(|_| held_by_position));
                        mark_spent(&mut self.notes, &mut self.tree, &mut report, tx.height, |n| match (cm, pos) {
                            (Some(cm), _) => n.cm == cm,
                            (None, Some(pos)) => n.position == pos,
                            (None, None) => false,
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
            // notes this transaction spent leave the count the cap is measured against
            let spent_here = report.spent.len() - spent_before;
            unspent = unspent.saturating_sub(spent_here);
            // a transaction that spends a note of this wallet was made with this wallet's key:
            // whatever it pays to this wallet is the wallet's OWN output (its change, a merge),
            // also on a restore, where no pending record says so (RW3-3)
            let spends_own = spent_here > 0;
            // 4. outputs
            for (j, out) in tx.outputs.into_iter().enumerate() {
                // 5. the running hash over the ciphertexts, as the node keeps it
                self.ciphertext_acc = B32(ciphertext_acc_step(&self.ciphertext_acc.0, &out.cm, &out.kem_ct, &out.note_ct));
                let store = match &out.mine {
                    // the wallet's own output: always stored (RW3-2, RW3-3)
                    Some(_) if (out.own || spends_own) && unspent < MAX_UNSPENT_NOTES_LIMIT + OWN_OUTPUT_SLACK => {
                        report.own_outputs_from_record += out.own as usize;
                        true
                    }
                    Some((value, _, _)) if *value < self.min_note_value => {
                        self.below_minimum.add(*value);
                        report.not_stored += 1;
                        false
                    }
                    Some((value, _, _)) if unspent >= self.max_unspent_notes as usize => {
                        self.over_capacity.add(*value);
                        report.not_stored += 1;
                        false
                    }
                    Some(_) => true,
                    None => false,
                };
                unspent += store as usize;
                let leaf = self.tree.append(&out.cm, store).map_err(|_| WalletError::StateInvariant)?;
                if let (true, Some((value, r_b, rho))) = (store, out.mine) {
                    let nf = nk.as_ref().map(|nk| B32(field::bytes(&nullifier(nk, &rho))));
                    if let Some(nf) = nf {
                        own_nf.insert(nf.0);
                    }
                    // (a lock follows its note by commitment; the position an entry shows for
                    // it is recomputed when the page has been applied — RW4-5)
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
                ciphertext_acc: self.ciphertext_acc,
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
        report.spent_dropped = self.drop_old_spent();
        self.next_height = page.next_height;
        report.next_height = page.next_height;
        report.at_tip = page.next_height > page.tip_height;
        self.bump("scan");
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

    /// REVIEW_WALLET_4 RW4-5 (a), (b): a state that would not read back is never handed out.
    /// The fault is simulated (no call produces such a state): a debug build stops on it, a
    /// release build refuses the call and leaves the caller's state as it was.
    #[test]
    #[cfg_attr(debug_assertions, should_panic(expected = "does not read back"))]
    fn a_state_that_does_not_read_back_is_refused_and_never_returned() {
        let mut s = WalletState::new([1u8; 32]);
        s.set_nodes(&["https://a.example", "https://b.example"]).unwrap();
        s.nullifier_acc = B32([0x11; 32]); // the history no longer ends at the state's values
        assert!(matches!(s.to_json(), Err(WalletError::StateInvariant)), "to_json returns no bytes that from_json refuses");
        assert!(matches!(s.returnable(), Err(WalletError::StateInvariant)));
        let before = s.clone();
        assert!(matches!(s.set_nodes(&["https://a.example", "https://c.example"]), Err(WalletError::StateInvariant)));
        assert!(matches!(s.confirm_state(&[]), Err(WalletError::StateInvariant)));
        assert!(matches!(s.assert_no_other_copy_has_a_pending_payment(), Err(WalletError::StateInvariant)));
        let page = ListingPage { active: true, tip_height: 5, from_height: 0, next_height: 6, txs: Vec::new() };
        let key = crate::keys::ShieldedKeys::from_seed(&[7u8; 64]).unwrap().scan_key();
        let mut other = WalletState::new(key.pk);
        other.nullifier_acc = B32([0x11; 32]);
        let other_before = other.clone();
        assert!(other.scan(&page, &key).is_err());
        assert!(!s.abandon_unsubmitted(&[0u8; 32]) && s.resolve().still_pending == 0);
        assert!(s == before && other == other_before, "a refused call leaves the state untouched");
        // the stored text of such a state is not lost either: its locks can be read out
        let json = serde_json::to_string(&s).unwrap();
        assert!(WalletState::from_json(&json).is_err());
        let r = WalletState::recover_locks(&json).unwrap();
        assert!(r.nodes_kept && r.entries_unreadable == 0 && r.state.nodes() == s.nodes());
    }

    #[test]
    fn state_json_is_validated() {
        let s = WalletState::new([1u8; 32]);
        let json = s.to_json().unwrap();
        assert_eq!(WalletState::from_json(&json).unwrap(), s);
        assert!(json.contains("\"version\":5") && json.contains("\"revision\":0"));
        assert!(WalletState::from_json("{}").is_err());
        assert!(WalletState::from_json(&json.replace("\"version\":5", "\"version\":6")).is_err());
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
