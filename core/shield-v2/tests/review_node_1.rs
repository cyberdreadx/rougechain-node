//! REVIEW_NODE_1 (`core/shield-v2/REVIEW_NODE_1.md`) — adversarial probes of the pool rules that
//! `tests/pool.rs` does not cover: extreme `u64` amounts, the arithmetic on a corrupt state, and
//! identical output commitments. No proof is made or verified here.
//!
//! Run: `cargo test --release -p quantum-vault-shield-v2 -j 1 --test review_node_1 -- --test-threads=1`

use p3_field::PrimeCharacteristicRing;
use quantum_vault_shield_v2::Felt;
use quantum_vault_shield_v2::pool::*;
use quantum_vault_shield_v2::reference::{digest_to_bytes, hash_dom};

const A: u64 = 1000;

fn d(tag: u64) -> Bytes32 {
    digest_to_bytes(&hash_dom(99, &[Felt::from_u64(tag)]))
}

fn tx(kind: TxKind, seed: u64, anchor: Bytes32, v_in: u64, v_out: u64, fee: u64) -> PoolTx {
    PoolTx { kind, anchor, nf: [d(4 * seed), d(4 * seed + 1)], cm_out: [d(4 * seed + 2), d(4 * seed + 3)], v_in, v_out, fee, account: [seed as u8; 32] }
}

fn new_pool() -> Pool<MemoryPoolStore> {
    Pool::open_or_init(MemoryPoolStore::new(), A).unwrap()
}

fn refusal(r: &Result<PreparedBlock, PoolError>) -> Option<TxRefusal> {
    match r {
        Err(PoolError::Tx { reason, .. }) => Some(*reason),
        _ => None,
    }
}

/// Every amount field is a `u64` an attacker fills freely. The pool's arithmetic is `u128` /
/// checked, so the extremes are refused by the rule that applies and never panic or wrap.
#[test]
fn extreme_u64_amounts_are_refused_by_the_right_rule_and_never_panic() {
    let pool = new_pool();
    let anchor = pool.state().unwrap().tree_root;
    let m = u64::MAX;
    // an unshield of 2^64 − 1 plus a fee of 2^64 − 1 from an empty pool: v_out + fee is 2^65 − 2
    assert_eq!(refusal(&pool.validate_block(A, &[tx(TxKind::Unshield, 1, anchor, 0, m, m)])), Some(TxRefusal::PoolUnderflow));
    // a transfer whose fee alone is 2^64 − 1
    assert_eq!(refusal(&pool.validate_block(A, &[tx(TxKind::Transfer, 2, anchor, 0, 0, m)])), Some(TxRefusal::PoolUnderflow));
    // a shield of 2^64 − 1 with no fee: above the cap, no overflow in `pool_total + (v_in − fee)`
    assert_eq!(refusal(&pool.validate_block(A, &[tx(TxKind::Shield, 3, anchor, m, 0, 0)])), Some(TxRefusal::PoolCapExceeded));
    // a shield with fee > v_in by one: the amount pattern, before any arithmetic
    assert_eq!(refusal(&pool.validate_block(A, &[tx(TxKind::Shield, 4, anchor, m - 1, 0, m)])), Some(TxRefusal::AmountPattern));
    // a shield with v_in = fee = 2^64 − 1 adds nothing to the pool and is accepted by the POOL
    // rules (the daemon's check 19 — the account must hold v_in — is what refuses it in practice);
    // the fee total is u128 and does not overflow
    let prepared = pool.validate_block(A, &[tx(TxKind::Shield, 5, anchor, m, 0, m), tx(TxKind::Shield, 6, anchor, m, 0, m)]).expect("pool rules");
    assert_eq!(prepared.state_after().pool_total, 0);
    assert_eq!(prepared.effects().fee_total, 2 * m as u128);
    assert_eq!(prepared.effects().txs[0].account_debit, m);
}

/// REVIEW_NODE_1 finding R1-6 (Low, defence in depth): check 18 for a shield is
/// `pool_total + (v_in − fee) as u128` with an UNCHECKED `u128` addition (`pool.rs`,
/// `validate_block`). The invariant `pool_total ≤ 10^15` makes it unreachable through the rules,
/// but spec §4.4 says the no-overpayment property must hold "even if ... an implementation were
/// broken": on a corrupt state the addition panics in a debug build and WRAPS in a release build,
/// where the wrapped total passes the cap check and the shield is accepted. Expected: a checked
/// addition that refuses. This test FAILS until the addition is checked.
#[test]
fn review_r1_6_shield_cap_check_uses_an_unchecked_u128_addition() {
    let mut state = PoolState::genesis();
    state.pool_total = u128::MAX - 5;
    let anchor = state.tree_root;
    let store = MemoryPoolStore::with_state(StoredPool { activation_height: A, next_height: A, state });
    let pool = Pool::open_or_init(store, A).unwrap();
    let shield = tx(TxKind::Shield, 1, anchor, 10, 0, 0);
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| pool.validate_block(A, &[shield])));
    match outcome {
        Ok(Err(e)) => eprintln!("refused as {e:?} (expected)"),
        Ok(Ok(p)) => panic!("R1-6: accepted with a wrapped pool_total of {} (release build)", p.state_after().pool_total),
        Err(_) => panic!("R1-6: the addition panicked (debug build) instead of refusing"),
    }
}

/// Two equal output commitments in one transaction are not forbidden by any rule (spec §3.6 check
/// 8 forbids only the all-zero digest). The tree takes them as two leaves, as the spec's order rule
/// says; this documents the behaviour so a later change is deliberate.
#[test]
fn identical_output_commitments_are_two_leaves() {
    let mut pool = new_pool();
    let anchor = pool.state().unwrap().tree_root;
    let mut t = tx(TxKind::Transfer, 1, anchor, 0, 0, 0);
    t.cm_out[1] = t.cm_out[0];
    pool.apply_block(A, &[t.clone()]).expect("accepted");
    assert_eq!(pool.store().leaf(0), Some(t.cm_out[0]));
    assert_eq!(pool.store().leaf(1), Some(t.cm_out[0]));
    assert_eq!(pool.state().unwrap().note_count, 2);
}
