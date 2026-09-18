//! Option-B canonical-ledger fork (issue #66).
//!
//! * Heights `18 ..= FORK_HEIGHT-1` carry committed state roots produced by retired
//!   operational state. They are accepted ONLY by equality against the compiled, hash-pinned
//!   `CHECKPOINT_ROOTS` table (an explicit historical consensus commitment) while the node
//!   applies the blocks under canonical rules. Missing or mismatching checkpoint ⇒ reject.
//!   There is no runtime bypass of any kind.
//! * At `FORK_HEIGHT-1` a fresh node's canonical ledger MUST equal
//!   `CANONICAL_LEDGER_AT_F_MINUS_1` (asserted on import; marker persisted).
//! * A legacy production node reaches the same ledger only through the explicit, operator-
//!   invoked, atomic `migrate_canonical_ledger` (never on ordinary restart).
//! * From `FORK_HEIGHT` onward: normal recompute-and-verify forever.
use std::collections::HashMap;

use quantum_vault_crypto::{bytes_to_hex, sha256};

pub use crate::fork_tables::*;

/// Persisted marker (snapshot-db, `balance_snapshot` tree) proving the node's ledger at
/// `FORK_HEIGHT-1` is the canonical one (set by fresh sync at F-1, or by the migration).
pub const CANONICAL_MARKER_KEY: &[u8] = b"canonical_ledger_at_f_minus_1";

pub fn is_checkpoint_height(height: u64) -> bool {
    (18..FORK_HEIGHT).contains(&height)
}

/// Explicit historical checkpoint verification: the block's committed root must EQUAL the
/// compiled commitment. Unknown height or mismatch ⇒ Err (reject the block).
pub fn verify_checkpoint(height: u64, header_root: Option<&str>) -> Result<(), String> {
    verify_checkpoint_against(CHECKPOINT_ROOTS, height, header_root)
}
pub fn verify_checkpoint_against(table: &[(u64, &str)], height: u64, header_root: Option<&str>) -> Result<(), String> {
    let expected = table.iter().find(|(h, _)| *h == height).map(|(_, r)| *r)
        .ok_or_else(|| format!("no historical checkpoint compiled for height {} — rejecting block", height))?;
    match header_root {
        Some(r) if r == expected => Ok(()),
        other => Err(format!("checkpoint mismatch at height {}: header={:?} expected={}", height, other, expected)),
    }
}

// ── canonical serialization + hashing (must match the generator script) ──────────────
pub fn serialize_checkpoints(t: &[(u64, &str)]) -> String { t.iter().map(|(h, r)| format!("{}={}\n", h, r)).collect() }
pub fn serialize_ledger(t: &[(&str, u128)]) -> String {
    let mut v: Vec<(&str, u128)> = t.to_vec(); v.sort();
    v.iter().map(|(k, q)| format!("{}={}\n", k, q)).collect()
}
pub fn serialize_delta(t: &[(&str, i128)]) -> String {
    let mut v: Vec<(&str, i128)> = t.to_vec(); v.sort();
    v.iter().map(|(k, d)| format!("{}={}\n", k, d)).collect()
}
pub fn serialize_token_lp(tok: &[(&str, &str, u128)], lp: &[(&str, &str, u128)]) -> String {
    let mut a: Vec<_> = tok.to_vec(); a.sort();
    let mut b: Vec<_> = lp.to_vec(); b.sort();
    a.iter().map(|(x, y, v)| format!("{}|{}={}\n", x, y, v)).collect::<String>()
        + &b.iter().map(|(x, y, v)| format!("{}|{}={}\n", x, y, v)).collect::<String>()
}
pub fn sha256_hex(s: &str) -> String { bytes_to_hex(&sha256(s.as_bytes())) }

/// Recompute every pinned table hash. Any edit to the fork data fails this.
pub fn verify_table_hashes() -> Result<(), String> {
    let checks = [
        ("CHECKPOINT_TABLE_SHA256", sha256_hex(&serialize_checkpoints(CHECKPOINT_ROOTS)), CHECKPOINT_TABLE_SHA256),
        ("PRODUCTION_LEDGER_TABLE_SHA256", sha256_hex(&serialize_ledger(PRODUCTION_LEDGER_AT_F_MINUS_1)), PRODUCTION_LEDGER_TABLE_SHA256),
        ("CANONICAL_LEDGER_TABLE_SHA256", sha256_hex(&serialize_ledger(CANONICAL_LEDGER_AT_F_MINUS_1)), CANONICAL_LEDGER_TABLE_SHA256),
        ("CANONICAL_DELTA_TABLE_SHA256", sha256_hex(&serialize_delta(CANONICAL_DELTA)), CANONICAL_DELTA_TABLE_SHA256),
        ("TOKEN_LP_TABLE_SHA256", sha256_hex(&serialize_token_lp(TOKEN_BALANCES_AT_F_MINUS_1, LP_BALANCES_AT_F_MINUS_1)), TOKEN_LP_TABLE_SHA256),
    ];
    for (name, got, want) in checks {
        if got != want { return Err(format!("{} mismatch: computed {} pinned {}", name, got, want)); }
    }
    // structural: production + delta == canonical, exactly
    let mut m: HashMap<&str, i128> = PRODUCTION_LEDGER_AT_F_MINUS_1.iter().map(|(k, v)| (*k, *v as i128)).collect();
    for (k, d) in CANONICAL_DELTA { *m.entry(k).or_insert(0) += d; }
    let mut want: HashMap<&str, i128> = CANONICAL_LEDGER_AT_F_MINUS_1.iter().map(|(k, v)| (*k, *v as i128)).collect();
    // zero-valued canonical keys absent from production are equivalent to absent
    want.retain(|_, v| *v != 0); m.retain(|_, v| *v != 0);
    if m != want { return Err("production ledger + canonical delta != canonical ledger".to_string()); }
    if CANONICAL_DELTA.iter().map(|(_, d)| *d).sum::<i128>() != CANONICAL_DELTA_SUM_QUANTA { return Err("delta sum mismatch".into()); }
    Ok(())
}

/// Exact comparison of a live native ledger against a pinned table: same accounts (zero
/// balances are treated as absent on both sides) and identical quanta. Returns the first
/// difference.
pub fn ledger_matches_table(live: &HashMap<String, u128>, table: &[(&str, u128)]) -> Result<(), String> {
    let mut want: HashMap<&str, u128> = table.iter().filter(|(_, v)| *v != 0).map(|(k, v)| (*k, *v)).collect();
    for (k, v) in live.iter().filter(|(_, v)| **v != 0) {
        match want.remove(k.as_str()) {
            Some(w) if w == *v => {}
            Some(w) => return Err(format!("account {} has {} quanta, table expects {}", k, v, w)),
            None => return Err(format!("account {} ({} quanta) is not in the table", k, v)),
        }
    }
    if let Some((k, w)) = want.into_iter().next() { return Err(format!("table account {} ({} quanta) missing from ledger", k, w)); }
    Ok(())
}
pub fn token_lp_match_tables(tok: &HashMap<(String, String), u128>, lp: &HashMap<(String, String), u128>) -> Result<(), String> {
    let live_tok: Vec<(&str, &str, u128)> = tok.iter().filter(|(_, v)| **v != 0).map(|((a, t), v)| (a.as_str(), t.as_str(), *v)).collect();
    let live_lp: Vec<(&str, &str, u128)> = lp.iter().filter(|(_, v)| **v != 0).map(|((a, t), v)| (a.as_str(), t.as_str(), *v)).collect();
    let got = sha256_hex(&serialize_token_lp(&live_tok, &live_lp));
    if got != TOKEN_LP_TABLE_SHA256 { return Err(format!("token/lp balances differ from the pinned F-1 tables (hash {} vs {})", got, TOKEN_LP_TABLE_SHA256)); }
    Ok(())
}

/// Apply the canonical delta to a ledger clone (pure). Errors if any subtraction would
/// underflow (the delta must remove only provably phantom value).
pub fn apply_delta(ledger: &HashMap<String, u128>) -> Result<HashMap<String, u128>, String> {
    let mut out = ledger.clone();
    for (k, d) in CANONICAL_DELTA {
        let cur = *out.get(*k).unwrap_or(&0) as i128;
        let new = cur + d;
        if new < 0 { return Err(format!("delta underflow on {}: {} {}", k, cur, d)); }
        if new == 0 { out.remove(*k); } else { out.insert(k.to_string(), new as u128); }
    }
    Ok(out)
}

#[cfg(test)]
mod fork_tables_tests {
    use super::*;
    #[test]
    fn all_table_hashes_recompute_and_structure_holds() { verify_table_hashes().unwrap(); }
    #[test]
    fn a_modified_table_is_rejected() {
        let mut cps: Vec<(u64, &str)> = CHECKPOINT_ROOTS.to_vec();
        cps[0].1 = "deadbeef";
        assert_ne!(sha256_hex(&serialize_checkpoints(&cps)), CHECKPOINT_TABLE_SHA256, "any edit changes the pinned hash");
        let mut d: Vec<(&str, i128)> = CANONICAL_DELTA.to_vec();
        d[0].1 += 1;
        assert_ne!(sha256_hex(&serialize_delta(&d)), CANONICAL_DELTA_TABLE_SHA256);
    }
    #[test]
    fn checkpoint_verification_rejects_missing_and_wrong() {
        assert!(verify_checkpoint(18, Some(CHECKPOINT_ROOTS[0].1)).is_ok());
        assert!(verify_checkpoint(18, Some("00")).unwrap_err().contains("checkpoint mismatch"));
        assert!(verify_checkpoint(18, None).unwrap_err().contains("checkpoint mismatch"));
        assert!(verify_checkpoint(17, Some("x")).unwrap_err().contains("no historical checkpoint"));
        assert!(verify_checkpoint(FORK_HEIGHT, Some("x")).unwrap_err().contains("no historical checkpoint"));
        assert!(verify_checkpoint_against(&[], 18, Some(CHECKPOINT_ROOTS[0].1)).is_err(), "empty table ⇒ reject");
        assert!(!is_checkpoint_height(17) && is_checkpoint_height(18) && is_checkpoint_height(FORK_HEIGHT - 1) && !is_checkpoint_height(FORK_HEIGHT));
    }
    #[test]
    fn delta_removes_exactly_the_phantom_amount_and_only_protocol_accounts() {
        let removed: i128 = -CANONICAL_DELTA.iter().map(|(_, d)| *d).sum::<i128>();
        assert_eq!(removed, 10_255_079_099_271, "10,255.079099271 XRGE");
        assert!(CANONICAL_DELTA.iter().all(|(_, d)| *d < 0), "Option B only removes value");
        // Only protocol/validator-controlled accounts: treasury + the three validator accounts.
        let allowed = ["__treasury__",
            "rouge168fd0mad4eynev767u896zx5ng2dnh7eztw9cj24tjn8f6e5t7fsgh8qxj",
            "rouge19emhc0secrj0uadfvmp5xvun5jta9kpm0laff28x04ug4szf50nq5aer4c",
            "rouge1qm85k7gmudsrz46crku2zh03j7lx4xyg4adhkhxau2vx25qe97aqvvc378"];
        for (k, _) in CANONICAL_DELTA { assert!(allowed.contains(k), "end-user account {} must not be touched", k); }
        assert_eq!(CANONICAL_DELTA.len(), 4);
        let prod: HashMap<String, u128> = PRODUCTION_LEDGER_AT_F_MINUS_1.iter().map(|(k, v)| (k.to_string(), *v)).collect();
        let after = apply_delta(&prod).unwrap();
        ledger_matches_table(&after, CANONICAL_LEDGER_AT_F_MINUS_1).unwrap();
        // one-quanta perturbation is detected
        let mut off = prod.clone(); *off.get_mut("__treasury__").unwrap() += 1;
        assert!(ledger_matches_table(&off, PRODUCTION_LEDGER_AT_F_MINUS_1).is_err());
    }
}
