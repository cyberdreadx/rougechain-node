//! Canonical state root over the balance ledger (Phase 2, P2-1).
//!
//! Commits the entire balance set — native XRGE, token, and LP balances — to a
//! single SHA-256 digest. The encoding is **order-independent** (keys are sorted,
//! so nondeterministic `HashMap` iteration can't affect the result) and
//! **float-free** (values are fixed 16-byte big-endian `u128`), so any two honest
//! nodes holding the same balances compute the *same* root.
//!
//! This is the thing that makes a ledger divergence **detectable**: the root will
//! go into the block header and be re-checked on import (later P2 tasks). This
//! module is the pure function only — it is wired into nothing yet.
//!
//! ## Encoding (fixed and explicit — deliberately not serde/JSON)
//! serde_json map output has no guaranteed key order or byte-stability across
//! versions, which would be a fork hazard for a consensus commitment. Instead we
//! hash an explicit stream:
//! - three sections in a fixed order (native, token, LP), each opened with a
//!   distinct domain tag so bytes can't be reinterpreted across sections;
//! - within a section, entries are emitted in **sorted key order**;
//! - every variable-length field is **length-prefixed** (u64 big-endian length
//!   then bytes), so no key content — even one containing a separator byte — can
//!   ever be confused with a field boundary;
//! - each value is a fixed 16-byte big-endian `u128`;
//! - **zero-value entries are skipped**, so a drained-to-zero account and a
//!   removed account yield the same root.

use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};

/// Domain-separation tags: one per section, so a native entry and a token entry
/// with coincidentally-equal bytes can never collide.
const TAG_NATIVE: &[u8] = b"rougechain.stateroot.v1.native";
const TAG_TOKEN: &[u8] = b"rougechain.stateroot.v1.token";
const TAG_LP: &[u8] = b"rougechain.stateroot.v1.lp";

/// Hash one length-prefixed byte field.
#[inline]
fn field(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update((bytes.len() as u64).to_be_bytes());
    hasher.update(bytes);
}

/// Compute the canonical state root over the three balance maps.
///
/// `native`: pubkey → quanta. `token` / `lp`: (user, symbol-or-pool) → base units.
/// Returns a lowercase hex SHA-256 digest.
#[allow(dead_code)] // wired into consensus in later P2 tasks
pub fn compute_state_root(
    native: &HashMap<String, u128>,
    token: &HashMap<(String, String), u128>,
    lp: &HashMap<(String, String), u128>,
) -> String {
    let mut hasher = Sha256::new();

    // Section 1 — native XRGE balances, keyed by pubkey. Sorted, zero-skipped.
    hasher.update(TAG_NATIVE);
    let native_sorted: BTreeMap<&String, u128> =
        native.iter().filter(|(_, &v)| v != 0).map(|(k, &v)| (k, v)).collect();
    for (k, v) in native_sorted {
        field(&mut hasher, k.as_bytes());
        hasher.update(v.to_be_bytes());
    }

    // Section 2 — token balances, keyed by (user, token symbol).
    hasher.update(TAG_TOKEN);
    for ((a, b), v) in sorted_pairs(token) {
        field(&mut hasher, a.as_bytes());
        field(&mut hasher, b.as_bytes());
        hasher.update(v.to_be_bytes());
    }

    // Section 3 — LP balances, keyed by (user, pool id).
    hasher.update(TAG_LP);
    for ((a, b), v) in sorted_pairs(lp) {
        field(&mut hasher, a.as_bytes());
        field(&mut hasher, b.as_bytes());
        hasher.update(v.to_be_bytes());
    }

    hex::encode(hasher.finalize())
}

/// Sort a `(String, String)`-keyed map by its tuple key, dropping zero values.
/// `BTreeMap` orders by `(a, b)` lexicographically — fully deterministic.
fn sorted_pairs(m: &HashMap<(String, String), u128>) -> BTreeMap<(&String, &String), u128> {
    m.iter()
        .filter(|(_, &v)| v != 0)
        .map(|((a, b), &v)| ((a, b), v))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn native(pairs: &[(&str, u128)]) -> HashMap<String, u128> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }
    fn pairs(items: &[(&str, &str, u128)]) -> HashMap<(String, String), u128> {
        items.iter().map(|(a, b, v)| ((a.to_string(), b.to_string()), *v)).collect()
    }

    #[test]
    fn empty_state_is_stable() {
        let e = HashMap::new();
        let p = HashMap::new();
        let r1 = compute_state_root(&e, &p, &p);
        let r2 = compute_state_root(&e, &p, &p);
        assert_eq!(r1, r2, "empty state root is deterministic");
        assert_eq!(r1.len(), 64, "sha-256 hex");
    }

    #[test]
    fn root_is_independent_of_insertion_order() {
        // Same logical balances, opposite insertion order → identical root.
        let mut a = HashMap::new();
        a.insert("alice".to_string(), 100u128);
        a.insert("bob".to_string(), 200u128);
        a.insert("carol".to_string(), 300u128);

        let mut b = HashMap::new();
        b.insert("carol".to_string(), 300u128);
        b.insert("bob".to_string(), 200u128);
        b.insert("alice".to_string(), 100u128);

        let empty = HashMap::new();
        assert_eq!(
            compute_state_root(&a, &empty, &empty),
            compute_state_root(&b, &empty, &empty),
            "sorting must make iteration order irrelevant"
        );
    }

    #[test]
    fn zero_balances_do_not_affect_the_root() {
        let empty = HashMap::new();
        let with_zero = native(&[("alice", 100), ("ghost", 0)]);
        let without = native(&[("alice", 100)]);
        assert_eq!(
            compute_state_root(&with_zero, &empty, &empty),
            compute_state_root(&without, &empty, &empty),
            "a zero-balance account is indistinguishable from an absent one"
        );
    }

    #[test]
    fn changing_any_balance_changes_the_root() {
        let empty = HashMap::new();
        let base = native(&[("alice", 100), ("bob", 200)]);
        let bumped = native(&[("alice", 101), ("bob", 200)]); // +1 quanta
        assert_ne!(
            compute_state_root(&base, &empty, &empty),
            compute_state_root(&bumped, &empty, &empty),
            "a one-quanta difference must change the root"
        );
    }

    #[test]
    fn sections_are_domain_separated() {
        // The same (key, value) as a native balance vs a token balance must not
        // produce the same root — otherwise money could be forged across ledgers.
        let empty_native = HashMap::new();
        let empty_pair = HashMap::new();
        let as_native = native(&[("alice", 500)]);
        let as_token = pairs(&[("alice", "XRGE", 500)]);
        assert_ne!(
            compute_state_root(&as_native, &empty_pair, &empty_pair),
            compute_state_root(&empty_native, &as_token, &empty_pair),
            "native and token sections must not collide"
        );
    }

    #[test]
    fn length_prefix_prevents_key_boundary_ambiguity() {
        // Without length-prefixing, ("ab","c") and ("a","bc") could hash equal.
        // They must not.
        let empty_native: HashMap<String, u128> = HashMap::new();
        let empty_pair: HashMap<(String, String), u128> = HashMap::new();
        let l = pairs(&[("ab", "c", 1)]);
        let r = pairs(&[("a", "bc", 1)]);
        assert_ne!(
            compute_state_root(&empty_native, &l, &empty_pair),
            compute_state_root(&empty_native, &r, &empty_pair),
            "field boundaries must be unambiguous"
        );
    }

    #[test]
    fn full_ledger_known_vector() {
        // Regression guard: pins the exact root for a fixed small ledger. If this
        // changes, the on-chain commitment format changed — a consensus break.
        let n = native(&[("alice", 69_900_000_000), ("bob", 30_000_000_000)]);
        let t = pairs(&[("alice", "QUSDC", 1_000_000)]);
        let l = pairs(&[("alice", "QTOK-XRGE", 141_421)]);
        let root = compute_state_root(&n, &t, &l);
        assert_eq!(root, KNOWN_VECTOR, "canonical root format must not drift");
    }

    // Filled in from the first green run of the relational tests above.
    const KNOWN_VECTOR: &str =
        "fcec1f34d515c7bd2b64b1757c511b60b2212b418a0b16e26d6247f3e7ed4ea5";
}
