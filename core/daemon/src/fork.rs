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
/// The fork (checkpoint era, F-1 assertions, readiness guard, migration) is a MAINNET
/// consensus commitment; every other chain id (testnet, dev, unit tests) runs plain
/// recompute-and-verify at every height.
pub const FORK_CHAIN_ID: &str = "rougechain-mainnet-1";

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

/// Consensus-relevant validator fields: (pubkey, stake, slash_count, jailed_until,
/// missed_blocks, total_slashed). `blocks_proposed` / `entropy_contributions` / `name` are
/// informational (never read by proposer selection, quorum or slashing) and excluded.
pub type ValidatorRow = (String, u128, u32, u64, u64, u128);
fn owned_rows(t: &[(&str, u128, u32, u64, u64, u128)]) -> Vec<ValidatorRow> {
    t.iter().map(|(k, s, sc, j, m, ts)| (k.to_string(), *s, *sc, *j, *m, *ts)).collect()
}
pub fn serialize_validators(rows: &[ValidatorRow]) -> String {
    let mut v = rows.to_vec(); v.sort();
    v.iter().map(|(k, s, sc, j, m, ts)| format!("{}|stake={}|slash_count={}|jailed_until={}|missed_blocks={}|total_slashed={}\n", k, s, sc, j, m, ts)).collect()
}
pub fn serialize_transition(t: &[(&str, &str, u128, u32, u64, u64, u128)]) -> String {
    let mut v: Vec<_> = t.iter().map(|(op, k, s, sc, j, m, ts)| (k.to_string(), op.to_string(), *s, *sc, *j, *m, *ts)).collect(); v.sort();
    v.iter().map(|(k, op, s, sc, j, m, ts)| format!("{}|{}|stake={}|slash_count={}|jailed_until={}|missed_blocks={}|total_slashed={}\n", op, k, s, sc, j, m, ts)).collect()
}
/// Pure application of `VALIDATOR_TRANSITION` to a validator row set ("set" overwrites the
/// consensus fields, "remove" deletes the entry).
pub fn apply_validator_transition(rows: &[ValidatorRow]) -> Vec<ValidatorRow> {
    let mut m: HashMap<String, ValidatorRow> = rows.iter().map(|r| (r.0.clone(), r.clone())).collect();
    for (op, k, s, sc, j, mb, ts) in VALIDATOR_TRANSITION {
        match *op {
            "set" => { m.insert(k.to_string(), (k.to_string(), *s, *sc, *j, *mb, *ts)); }
            "remove" => { m.remove(*k); }
            _ => unreachable!("VALIDATOR_TRANSITION op must be set|remove"),
        }
    }
    let mut out: Vec<ValidatorRow> = m.into_values().collect(); out.sort(); out
}
/// `(total_stake, quorum)` over a row set — quorum is exactly the finality rule `total*2/3+1`.
pub fn stake_and_quorum(rows: &[ValidatorRow]) -> (u128, u128) {
    let total: u128 = rows.iter().map(|r| r.1).sum();
    (total, if total == 0 { 0 } else { total * 2 / 3 + 1 })
}
/// Exact comparison of the live validator set (consensus fields) against a pinned table.
/// Rows with stake 0, no slash and no jail are equivalent to absent (that is exactly when the
/// store deletes them). Returns the first difference.
pub fn validators_match_table(live: &[ValidatorRow], table: &[(&str, u128, u32, u64, u64, u128)]) -> Result<(), String> {
    let mut want: HashMap<String, ValidatorRow> = owned_rows(table).into_iter().map(|r| (r.0.clone(), r)).collect();
    for r in live.iter().filter(|r| !(r.1 == 0 && r.2 == 0 && r.3 == 0)) {
        match want.remove(&r.0) {
            Some(w) if w == *r => {}
            Some(w) => return Err(format!("validator {} live {:?} table {:?}", r.0, (r.1, r.2, r.3, r.4, r.5), (w.1, w.2, w.3, w.4, w.5))),
            None => return Err(format!("validator {} (stake {}) is not in the table", r.0, r.1)),
        }
    }
    if let Some((k, w)) = want.into_iter().next() { return Err(format!("table validator {} (stake {}) missing from the live set", k, w.1)); }
    Ok(())
}

/// Recompute every pinned table hash. Any edit to the fork data fails this.
pub fn verify_table_hashes() -> Result<(), String> {
    let checks = [
        ("CHECKPOINT_TABLE_SHA256", sha256_hex(&serialize_checkpoints(CHECKPOINT_ROOTS)), CHECKPOINT_TABLE_SHA256),
        ("PRODUCTION_LEDGER_TABLE_SHA256", sha256_hex(&serialize_ledger(PRODUCTION_LEDGER_AT_F_MINUS_1)), PRODUCTION_LEDGER_TABLE_SHA256),
        ("CANONICAL_LEDGER_TABLE_SHA256", sha256_hex(&serialize_ledger(CANONICAL_LEDGER_AT_F_MINUS_1)), CANONICAL_LEDGER_TABLE_SHA256),
        ("CANONICAL_DELTA_TABLE_SHA256", sha256_hex(&serialize_delta(CANONICAL_DELTA)), CANONICAL_DELTA_TABLE_SHA256),
        ("TOKEN_LP_TABLE_SHA256", sha256_hex(&serialize_token_lp(TOKEN_BALANCES_AT_F_MINUS_1, LP_BALANCES_AT_F_MINUS_1)), TOKEN_LP_TABLE_SHA256),
        ("PRODUCTION_VALIDATOR_TABLE_SHA256", sha256_hex(&serialize_validators(&owned_rows(PRODUCTION_VALIDATOR_STATE_AT_F_MINUS_1))), PRODUCTION_VALIDATOR_TABLE_SHA256),
        ("CANONICAL_VALIDATOR_TABLE_SHA256", sha256_hex(&serialize_validators(&owned_rows(CANONICAL_VALIDATOR_STATE_AT_F_MINUS_1))), CANONICAL_VALIDATOR_TABLE_SHA256),
        ("VALIDATOR_TRANSITION_TABLE_SHA256", sha256_hex(&serialize_transition(VALIDATOR_TRANSITION)), VALIDATOR_TRANSITION_TABLE_SHA256),
    ];
    for (name, got, want) in checks {
        if got != want { return Err(format!("{} mismatch: computed {} pinned {}", name, got, want)); }
    }
    // structural: production validators + transition == canonical validators, exactly; stake sums pinned
    let after = apply_validator_transition(&owned_rows(PRODUCTION_VALIDATOR_STATE_AT_F_MINUS_1));
    validators_match_table(&after, CANONICAL_VALIDATOR_STATE_AT_F_MINUS_1).map_err(|e| format!("production validators + transition != canonical validators: {}", e))?;
    if stake_and_quorum(&owned_rows(CANONICAL_VALIDATOR_STATE_AT_F_MINUS_1)).0 != CANONICAL_TOTAL_BACKED_STAKE { return Err("canonical backed-stake sum mismatch".into()); }
    if stake_and_quorum(&owned_rows(PRODUCTION_VALIDATOR_STATE_AT_F_MINUS_1)).0 != PRODUCTION_TOTAL_VALIDATOR_STAKE { return Err("production stake sum mismatch".into()); }
    if VALIDATOR_TRANSITION.iter().any(|(op, ..)| *op != "set" && *op != "remove") { return Err("unknown transition op".into()); }
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
    #[test]
    fn validator_tables_pin_the_h29_phantom_removal_and_backed_quorum() {
        let prod = owned_rows(PRODUCTION_VALIDATOR_STATE_AT_F_MINUS_1);
        let canon = owned_rows(CANONICAL_VALIDATOR_STATE_AT_F_MINUS_1);
        assert_eq!(stake_and_quorum(&prod), (120_000, 80_001), "production: 100,000 + 10,000 (h20) + 10,000 phantom (h29)");
        assert_eq!(stake_and_quorum(&canon), (110_000, 73_334), "canonical: only ledger-backed stake; quorum = total*2/3+1");
        assert_eq!(CANONICAL_TOTAL_BACKED_STAKE, 110_000);
        // the transition removes exactly ONE validator (the h29 unbacked staker) and keeps the two backed ones
        let removed: Vec<&str> = VALIDATOR_TRANSITION.iter().filter(|(op, ..)| *op == "remove").map(|(_, k, ..)| *k).collect();
        assert_eq!(removed.len(), 1, "one removal");
        assert!(removed[0].starts_with("c97f59a2"), "the h29 staker");
        assert!(canon.iter().all(|r| r.0.starts_with("21e0ed0a") || r.0.starts_with("8ccf7878")));
        assert_eq!(apply_validator_transition(&prod), canon);
        // consensus fields are compared exactly; one unit of stake or one missed block is detected
        let mut off = canon.clone(); off[0].1 += 1;
        assert!(validators_match_table(&off, CANONICAL_VALIDATOR_STATE_AT_F_MINUS_1).is_err());
        let mut off = canon.clone(); off[0].4 += 1;
        assert!(validators_match_table(&off, CANONICAL_VALIDATOR_STATE_AT_F_MINUS_1).is_err());
        assert!(validators_match_table(&prod, CANONICAL_VALIDATOR_STATE_AT_F_MINUS_1).unwrap_err().contains("not in the table"));
        // an edited validator table breaks its pinned hash
        let mut t = canon.clone(); t[0].1 -= 1;
        assert_ne!(sha256_hex(&serialize_validators(&t)), CANONICAL_VALIDATOR_TABLE_SHA256);
    }
}
