//! The pool-state rules of spec §4. Every rule has a positive and a negative test. No proof is
//! made or verified here: the pool is given transactions that are assumed to have passed
//! `verify_spend` (the L-1 pair with real proofs is in `tests/forgery.rs`, `test-prover` feature).
//!
//! The first test is the regression pair of spec §4.2 (REVIEW2 finding L-1), as the
//! specification requires.
//!
//! Run: `cargo test --release -p quantum-vault-shield-v2 -j 1 --test pool -- --test-threads=1`

use std::cell::Cell;

use p3_field::PrimeCharacteristicRing;
use quantum_vault_shield_v2::Felt;
use quantum_vault_shield_v2::pool::*;
use quantum_vault_shield_v2::reference::{
    Digest, Note, SparseTree, ZERO_DIGEST, derive_nk, derive_pk, derive_rho, digest_from_bytes, digest_to_bytes,
    hash_dom, merge, nullifier,
};
use sha2::{Digest as _, Sha256};

/// The activation height used by these tests.
const A: u64 = 1000;

// ---- helpers ---------------------------------------------------------------------------------------

/// A canonical, pseudo-random digest (never all-zero in practice).
fn fd(tag: u64) -> Digest {
    hash_dom(99, &[Felt::from_u64(tag)])
}

fn d(tag: u64) -> Bytes32 {
    digest_to_bytes(&fd(tag))
}

fn tx(kind: TxKind, seed: u64, anchor: Bytes32, v_in: u64, v_out: u64, fee: u64) -> PoolTx {
    PoolTx {
        kind,
        anchor,
        nf: [d(4 * seed), d(4 * seed + 1)],
        cm_out: [d(4 * seed + 2), d(4 * seed + 3)],
        v_in,
        v_out,
        fee,
        account: [seed as u8; 32],
    }
}

fn shield(seed: u64, anchor: Bytes32, v_in: u64, fee: u64) -> PoolTx {
    tx(TxKind::Shield, seed, anchor, v_in, 0, fee)
}

fn transfer(seed: u64, anchor: Bytes32, fee: u64) -> PoolTx {
    tx(TxKind::Transfer, seed, anchor, 0, 0, fee)
}

fn unshield(seed: u64, anchor: Bytes32, v_out: u64, fee: u64) -> PoolTx {
    tx(TxKind::Unshield, seed, anchor, 0, v_out, fee)
}

fn new_pool() -> Pool<MemoryPoolStore> {
    Pool::open_or_init(MemoryPoolStore::new(), A).unwrap()
}

/// The current root: an anchor every transaction of the NEXT block may use.
fn root(pool: &Pool<MemoryPoolStore>) -> Bytes32 {
    pool.state().unwrap().tree_root
}

fn refused(r: Result<impl std::fmt::Debug, PoolError>, index: usize, reason: TxRefusal) {
    match r {
        Err(PoolError::Tx { index: i, reason: got }) if i == index && got == reason => {}
        other => panic!("expected transaction {index} refused as {reason:?}, got {other:?}"),
    }
}

/// Asserts that `f` fails and leaves the store exactly as it was.
fn unchanged_by<T: std::fmt::Debug>(
    pool: &mut Pool<MemoryPoolStore>,
    f: impl FnOnce(&mut Pool<MemoryPoolStore>) -> Result<T, PoolError>,
) -> PoolError {
    let before = pool.store().clone();
    let err = f(pool).expect_err("must be refused");
    assert_eq!(pool.store(), &before, "a refused block changed the state");
    err
}

// =================================================================================================
// §4.2 — THE FIRST TEST: the regression pair of REVIEW2 finding L-1.
//
// Two different shield transactions built from the same dummy secrets publish the same
// (nf1, nf2). Their output notes therefore get the SAME rho (it is H_rho(nf1, nf2, j)), and two
// notes to one recipient with one rho have ONE nullifier: the recipient could spend only one of
// them. `verify_spend` accepts both proofs by design (`tests/forgery.rs` shows that with real
// proofs). The node MUST accept at most one — in the same block, in different blocks, in either
// order.
// =================================================================================================

/// The pair, with the real hash functions: (transaction 1, transaction 2).
fn l1_pair(anchor: Bytes32) -> (PoolTx, PoolTx) {
    // the sender's dummy secrets, used twice
    let (sk1, rho1, sk2, rho2) = (fd(1), fd(2), fd(3), fd(4));
    let nf = [nullifier(&derive_nk(&sk1), &rho1), nullifier(&derive_nk(&sk2), &rho2)];
    assert_ne!(nf[0], nf[1]);
    let victim_sk = fd(5);
    let victim_pk = derive_pk(&victim_sk);
    let mk = |value: u64, fee: u64, r_tag: u64| {
        // output 1: the note to the victim; output 2: a zero-value note to a random key
        let n1 = Note { value, pk: victim_pk, rho: derive_rho(&nf, 0), r: fd(r_tag) };
        let n2 = Note { value: 0, pk: fd(r_tag + 1), rho: derive_rho(&nf, 1), r: fd(r_tag + 2) };
        let t = PoolTx {
            kind: TxKind::Shield,
            anchor,
            nf: [digest_to_bytes(&nf[0]), digest_to_bytes(&nf[1])],
            cm_out: [digest_to_bytes(&n1.commitment()), digest_to_bytes(&n2.commitment())],
            v_in: value + fee,
            v_out: 0,
            fee,
            account: [7; 32],
        };
        (t, n1)
    };
    let ((t1, n1), (t2, n2)) = (mk(60, 10, 100), mk(40, 10, 200));
    // what makes the pair dangerous: different transactions, different notes ...
    assert_ne!(t1, t2);
    assert_ne!(n1.commitment(), n2.commitment());
    assert_ne!(t1.cm_out, t2.cm_out);
    // ... the same nullifier pair, hence the same rho, hence the same future nullifier
    assert_eq!(t1.nf, t2.nf);
    assert_eq!(n1.rho, n2.rho);
    let nk = derive_nk(&victim_sk);
    assert_eq!(nullifier(&nk, &n1.rho), nullifier(&nk, &n2.rho));
    (t1, t2)
}

#[test]
fn l1_regression_pair_at_most_one_is_accepted() {
    let anchor = empty_tree_root();
    let (t1, t2) = l1_pair(anchor);

    // (a) in two blocks: the first is accepted, the second refused — the nullifiers are in the set
    for (first, second) in [(&t1, &t2), (&t2, &t1)] {
        let mut pool = new_pool();
        pool.apply_block(A, std::slice::from_ref(first)).expect("the first of the pair is an ordinary shield");
        assert!(pool.is_spent(&first.nf[0]).unwrap() && pool.is_spent(&first.nf[1]).unwrap(), "dummy nullifiers are inserted");
        let err = unchanged_by(&mut pool, |p| p.apply_block(A + 1, std::slice::from_ref(second)));
        assert_eq!(err, PoolError::Tx { index: 0, reason: TxRefusal::NullifierSpent });
        // ... and for ever: 300 blocks later the set still refuses it (never pruned)
        for h in A + 1..A + 301 {
            pool.apply_block(h, &[]).unwrap();
        }
        // (with an anchor that is in the window, so that the nullifier rule is what refuses)
        let later = PoolTx { anchor: root(&pool), ..second.clone() };
        let err = unchanged_by(&mut pool, |p| p.apply_block(A + 301, &[later]));
        assert_eq!(err, PoolError::Tx { index: 0, reason: TxRefusal::NullifierSpent });
        assert_eq!(pool.state().unwrap().note_count, 2, "exactly one of the pair created notes");
    }

    // (b) in one block: the block is invalid as a whole, in either order, and nothing is applied
    for both in [[t1.clone(), t2.clone()], [t2.clone(), t1.clone()]] {
        let mut pool = new_pool();
        let err = unchanged_by(&mut pool, |p| p.apply_block(A, &both));
        assert_eq!(err, PoolError::Tx { index: 1, reason: TxRefusal::NullifierRepeatedInBlock });
        assert_eq!(pool.state().unwrap(), PoolState::genesis());
        assert!(!pool.is_spent(&t1.nf[0]).unwrap());
    }

    // (c) the same transaction twice (a plain replay) is the same case
    let mut pool = new_pool();
    unchanged_by(&mut pool, |p| p.apply_block(A, &[t1.clone(), t1.clone()]));
    pool.apply_block(A, &[t1.clone()]).unwrap();
    unchanged_by(&mut pool, |p| p.apply_block(A + 1, &[t1.clone()]));
    println!("POOL|L-1|two shields with the same dummy secrets (equal nullifier pair, equal rho, equal future nullifier): at most one accepted — next block, same block, either order, and 300 blocks later");
}

// =================================================================================================
// §4.2 — nullifier set
// =================================================================================================

/// Spec §4.5 step 1, written again from the specification's text.
fn acc_step(acc: Bytes32, nf: &Bytes32) -> Bytes32 {
    let mut h = Sha256::new();
    h.update(b"rougechain.shield_v2.nullifier_acc.v1");
    h.update(acc);
    h.update(nf);
    h.finalize().into()
}

#[test]
fn nullifiers_both_inserted_for_all_three_types_in_order() {
    let mut pool = new_pool();
    let e = empty_tree_root();
    assert_eq!(pool.state().unwrap().nullifier_count, 0);
    assert_eq!(pool.state().unwrap().nullifier_acc, [0u8; 32]);
    // a shield has two dummy inputs: both nullifiers are inserted all the same (rule 1)
    let s = shield(1, e, 1_000, 10);
    pool.apply_block(A, &[s.clone()]).unwrap();
    let t = transfer(2, root(&pool), 5);
    let u = unshield(3, root(&pool), 100, 5);
    pool.apply_block(A + 1, &[t.clone(), u.clone()]).unwrap();
    let st = pool.state().unwrap();
    assert_eq!(st.nullifier_count, 6);
    let order = [s.nf[0], s.nf[1], t.nf[0], t.nf[1], u.nf[0], u.nf[1]];
    assert_eq!(pool.store().nullifiers(), &order, "insertion order: block, transaction, nf1 then nf2");
    for nf in &order {
        assert!(pool.is_spent(nf).unwrap());
    }
    assert!(!pool.is_spent(&d(999_999)).unwrap());
    // the running hash, recomputed from the specification
    assert_eq!(st.nullifier_acc, order.iter().fold([0u8; 32], acc_step));
    // the order matters: nf2 before nf1 gives another accumulator
    let mut swapped = new_pool();
    swapped.apply_block(A, &[PoolTx { nf: [s.nf[1], s.nf[0]], ..s.clone() }]).unwrap();
    let mut straight = new_pool();
    straight.apply_block(A, &[s.clone()]).unwrap();
    assert_ne!(swapped.state().unwrap().nullifier_acc, straight.state().unwrap().nullifier_acc);
    assert_eq!(swapped.state().unwrap().tree_root, straight.state().unwrap().tree_root);
}

#[test]
fn nullifier_rules_equal_pair_in_set_in_block_any_slot() {
    let e = empty_tree_root();
    // (a) nf1 = nf2
    let mut pool = new_pool();
    let mut t = shield(1, e, 100, 1);
    t.nf[1] = t.nf[0];
    refused(unchanged_by_r(&mut pool, &[t]), 0, TxRefusal::EqualNullifiers);

    // (b) in the set, in either slot of the new transaction, from either slot of the old one
    let first = shield(1, e, 100, 1);
    for old_slot in 0..2 {
        for new_slot in 0..2 {
            let mut pool = new_pool();
            pool.apply_block(A, &[first.clone()]).unwrap();
            let mut t = shield(2, root(&pool), 100, 1);
            t.nf[new_slot] = first.nf[old_slot];
            let before = pool.store().clone();
            refused(pool.apply_block(A + 1, &[t.clone()]), 0, TxRefusal::NullifierSpent);
            assert_eq!(pool.store(), &before);
            // control: with its own nullifiers the same transaction is accepted
            pool.apply_block(A + 1, &[shield(2, root(&pool), 100, 1)]).unwrap();
        }
    }

    // (c) equal to a nullifier of an EARLIER transaction of the same block (the lookup is against
    // the set as it is after the preceding transactions, not as it was when the block started)
    for old_slot in 0..2 {
        for new_slot in 0..2 {
            let mut pool = new_pool();
            let mut t = shield(2, e, 100, 1);
            t.nf[new_slot] = first.nf[old_slot];
            refused(unchanged_by_r(&mut pool, &[first.clone(), t.clone()]), 1, TxRefusal::NullifierRepeatedInBlock);
            // also with an unrelated transaction between them
            refused(
                unchanged_by_r(&mut pool, &[first.clone(), shield(3, e, 100, 1), t]),
                2,
                TxRefusal::NullifierRepeatedInBlock,
            );
        }
    }

    // positive: distinct nullifiers throughout a full block
    let mut pool = new_pool();
    let block: Vec<PoolTx> = (1..=8).map(|i| shield(i, e, 100, 1)).collect();
    pool.apply_block(A, &block).unwrap();
    assert_eq!(pool.state().unwrap().nullifier_count, 16);
}

/// `apply_block(next height, txs)` that must fail and change nothing; returns the result.
fn unchanged_by_r(pool: &mut Pool<MemoryPoolStore>, txs: &[PoolTx]) -> Result<BlockEffects, PoolError> {
    let before = pool.store().clone();
    let h = pool.next_height().unwrap();
    let r = pool.apply_block(h, txs);
    assert!(r.is_err(), "must be refused");
    assert_eq!(pool.store(), &before, "a refused block changed the state");
    r
}

#[test]
fn nullifier_set_is_never_pruned() {
    let mut pool = new_pool();
    let first = shield(1, empty_tree_root(), 1_000_000, 1);
    pool.apply_block(A, &[first.clone()]).unwrap();
    // far beyond the anchor window, with other transactions in between
    for h in A + 1..A + 400 {
        let txs = if h % 50 == 0 { vec![transfer(h, root(&pool), 1)] } else { vec![] };
        pool.apply_block(h, &txs).unwrap();
    }
    assert!(pool.is_spent(&first.nf[0]).unwrap() && pool.is_spent(&first.nf[1]).unwrap());
    assert_eq!(pool.store().nullifiers()[..2], first.nf);
    let again = PoolTx { anchor: root(&pool), ..first };
    refused(unchanged_by_r(&mut pool, &[again]), 0, TxRefusal::NullifierSpent);
}

// =================================================================================================
// §4.3 — commitment tree and anchors
// =================================================================================================

/// The root of the complete subtree over `leaves` (a power of two of them), by brute force.
fn subtree(leaves: &[Digest]) -> Digest {
    if leaves.len() == 1 {
        return leaves[0];
    }
    let (l, r) = leaves.split_at(leaves.len() / 2);
    merge(&subtree(l), &subtree(r))
}

#[test]
fn tree_is_append_only_in_order_with_the_specified_frontier() {
    let mut pool = new_pool();
    let mut reference = SparseTree::new();
    let mut all: Vec<Bytes32> = Vec::new();
    assert_eq!(root(&pool), digest_to_bytes(&reference.root()), "R(A - 1) = E_32");
    assert_eq!(pool.state().unwrap().frontier, [[0u8; 32]; 32]);
    let mut seed = 0;
    // 1, 2, 3, … transactions per block: every note count from 0 to 72 in steps of 2
    for (h, n) in (A..).zip([1usize, 2, 3, 1, 8, 5, 7, 2, 4, 3]) {
        let anchor = root(&pool);
        let block: Vec<PoolTx> = (0..n)
            .map(|_| {
                seed += 1;
                shield(seed, anchor, 10, 1)
            })
            .collect();
        let first_leaf = pool.state().unwrap().note_count;
        pool.apply_block(h, &block).unwrap();
        // rule 3: block order, transaction order, cm_out1 before cm_out2; the k-th transaction
        // writes leaves 2k and 2k + 1
        for (i, t) in block.iter().enumerate() {
            for j in 0..2 {
                let pos = first_leaf + 2 * i as u64 + j as u64;
                assert_eq!(pool.store().leaf(pos), Some(t.cm_out[j]));
                reference.insert(pos as u32, digest_from_bytes(&t.cm_out[j]).unwrap());
                all.push(t.cm_out[j]);
            }
        }
        let st = pool.state().unwrap();
        assert_eq!(st.note_count, all.len() as u64);
        assert_eq!(st.note_count, 2 * seed);
        assert_eq!(pool.store().leaf_count(), all.len());
        // the root is the root of the reference tree of spec §2.6
        assert_eq!(st.tree_root, digest_to_bytes(&reference.root()), "after {} leaves", all.len());
        // spec §4.8: frontier[l] is the complete height-l subtree over [m, m + 2^l) if bit l of
        // note_count is set, and 32 zero bytes otherwise
        let leaves: Vec<Digest> = all.iter().map(|b| digest_from_bytes(b).unwrap()).collect();
        for l in 0..32 {
            let want = if (st.note_count >> l) & 1 == 1 {
                let m = ((st.note_count >> (l + 1)) << (l + 1)) as usize;
                digest_to_bytes(&subtree(&leaves[m..m + (1 << l)]))
            } else {
                [0u8; 32]
            };
            assert_eq!(st.frontier[l], want, "frontier[{l}] at note_count {}", st.note_count);
        }
    }
    // rule 1: earlier leaves are never changed
    for (pos, leaf) in all.iter().enumerate() {
        assert_eq!(pool.store().leaf(pos as u64), Some(*leaf));
    }
    assert_eq!(all.len(), 72);
}

#[test]
fn a_block_without_v2_transactions_keeps_the_root_and_advances_the_window() {
    let mut pool = new_pool();
    let e = empty_tree_root();
    assert_eq!(pool.state().unwrap().window, vec![e], "window at A: [R(A - 1)]");
    pool.apply_block(A, &[]).unwrap();
    assert_eq!(root(&pool), e, "R(h) = R(h - 1)");
    assert_eq!(pool.state().unwrap().window, vec![e, e], "the window grows for every block from A on");
    pool.apply_block(A + 1, &[shield(1, e, 10, 1)]).unwrap();
    let x = root(&pool);
    assert_ne!(x, e);
    pool.apply_block(A + 2, &[]).unwrap();
    assert_eq!(pool.state().unwrap().window, vec![e, e, x, x]);
    let st = pool.state().unwrap();
    assert_eq!((st.note_count, st.nullifier_count, st.pool_total), (2, 2, 9));
}

#[test]
fn anchor_window_boundaries() {
    let mut pool = new_pool();
    let e = empty_tree_root(); // R(A - 1)
    let ok = |pool: &Pool<MemoryPoolStore>, seed: u64, anchor: Bytes32| {
        pool.validate_block(pool.next_height().unwrap(), &[transfer(seed, anchor, 0)])
    };
    // block A: R(A) = x0; block A + 1: R(A + 1) = x1; then empty blocks
    pool.apply_block(A, &[shield(1, e, 1_000, 0)]).unwrap();
    let x0 = root(&pool);
    pool.apply_block(A + 1, &[shield(2, x0, 1_000, 0)]).unwrap();
    let x1 = root(&pool);
    assert!(e != x0 && x0 != x1 && e != x1);
    assert_eq!(pool.state().unwrap().window, vec![e, x0, x1], "fewer than 128 just after activation");
    for h in A + 2..=A + 126 {
        pool.apply_block(h, &[]).unwrap();
    }
    // after block A + 126 the window holds R(A - 1) … R(A + 126): exactly 128 entries
    assert_eq!(pool.state().unwrap().window.len(), SHIELD_V2_ANCHOR_WINDOW);
    assert_eq!(pool.state().unwrap().window[0], e);

    // H = A + 127: h ranges over max(A - 1, H - 128) = A - 1 … H - 1 — R(A - 1) is still accepted
    assert_eq!(pool.next_height().unwrap(), A + 127);
    ok(&pool, 10, e).expect("R(A - 1) is accepted up to and including block A - 1 + 128");
    ok(&pool, 10, x0).unwrap();
    ok(&pool, 10, x1).unwrap();
    pool.apply_block(A + 127, &[]).unwrap();
    assert_eq!(pool.state().unwrap().window.len(), 128, "never more than 128");
    assert_eq!(pool.state().unwrap().window[0], x0, "the oldest was removed");

    // H = A + 128: R(A - 1) has left the window; R(A) is in its last block (h + 128)
    refused(ok(&pool, 10, e), 0, TxRefusal::AnchorNotInWindow);
    ok(&pool, 10, x0).expect("R(A) is accepted up to and including block A + 128");
    pool.apply_block(A + 128, &[]).unwrap();

    // H = A + 129: R(A) is refused; R(A + 1) is in its last block as a root of block A + 1 …
    refused(ok(&pool, 10, x0), 0, TxRefusal::AnchorNotInWindow);
    ok(&pool, 10, x1).unwrap();
    pool.apply_block(A + 129, &[]).unwrap();
    // … but stays accepted, because every empty block since has had the same root (rule 4)
    ok(&pool, 10, x1).expect("R(A + 2) = … = R(A + 129) = x1");
    // the refusals above are real refusals of a block, and leave the state alone
    refused(unchanged_by_r(&mut pool, &[transfer(10, x0, 0)]), 0, TxRefusal::AnchorNotInWindow);
    refused(unchanged_by_r(&mut pool, &[transfer(10, e, 0)]), 0, TxRefusal::AnchorNotInWindow);
    // a digest that never was a root
    refused(unchanged_by_r(&mut pool, &[transfer(10, d(123_456), 0)]), 0, TxRefusal::AnchorNotInWindow);

    // once the root changes, x1 ages out exactly 128 blocks after the last block whose root it was
    let last_x1 = pool.next_height().unwrap(); // this block changes the root; R(last_x1 - 1) = x1
    pool.apply_block(last_x1, &[transfer(11, x1, 0)]).unwrap();
    for h in last_x1 + 1..last_x1 + 127 {
        pool.apply_block(h, &[]).unwrap();
    }
    assert_eq!(pool.next_height().unwrap(), last_x1 - 1 + 128);
    ok(&pool, 12, x1).expect("h + 128, the last block");
    pool.apply_block(last_x1 + 127, &[]).unwrap();
    refused(ok(&pool, 12, x1), 0, TxRefusal::AnchorNotInWindow);
}

#[test]
fn an_anchor_is_never_a_root_from_inside_the_block_and_all_types_need_one() {
    let e = empty_tree_root();
    // the root after the first transaction of a block is not an anchor for the second (rule 6)
    let mut probe = new_pool();
    let first = shield(1, e, 1_000, 0);
    probe.apply_block(A, &[first.clone()]).unwrap();
    let inside = root(&probe);
    let mut pool = new_pool();
    refused(unchanged_by_r(&mut pool, &[first.clone(), transfer(2, inside, 0)]), 1, TxRefusal::AnchorNotInWindow);
    // … it is one block later: a note created in block H can be spent in block H + 1
    pool.apply_block(A, &[first]).unwrap();
    assert_eq!(root(&pool), inside);
    pool.apply_block(A + 1, &[transfer(2, inside, 0)]).unwrap();

    // rule 7: the rule applies to all three types, the shield included
    let bad = d(777);
    let good = root(&pool);
    for (k, t) in [shield(10, bad, 100, 1), transfer(11, bad, 1), unshield(12, bad, 100, 1)].into_iter().enumerate() {
        refused(unchanged_by_r(&mut pool, &[t.clone()]), 0, TxRefusal::AnchorNotInWindow);
        let h = pool.next_height().unwrap();
        pool.apply_block(h, &[PoolTx { anchor: good, ..t }]).unwrap_or_else(|e| panic!("type {k}: {e:?}"));
    }
}

#[test]
fn tree_room_boundary() {
    // a state no test can reach by appending: 2^32 - 4 leaves, with some frontier
    let mut state = PoolState::genesis();
    state.note_count = SHIELD_V2_MAX_NOTES - 4;
    for l in 0..32 {
        state.frontier[l] = if (state.note_count >> l) & 1 == 1 { d(5_000 + l as u64) } else { [0u8; 32] };
    }
    state.tree_root = d(6_000);
    state.window = vec![state.tree_root];
    state.pool_total = 1_000;
    let store = MemoryPoolStore::with_state(StoredPool { activation_height: A, next_height: A + 5, state });
    let mut pool = Pool::open_or_init(store, A).unwrap();
    // three transactions do not fit (2^32 - 4 + 6 > 2^32): the block is refused at the third
    let anchor = root(&pool);
    let three = [transfer(1, anchor, 0), transfer(2, anchor, 0), transfer(3, anchor, 0)];
    refused(unchanged_by_r(&mut pool, &three), 2, TxRefusal::TreeFull);
    // two fit exactly: note_count + 2 <= 2^32 holds for both
    pool.apply_block(A + 5, &three[..2]).unwrap();
    let st = pool.state().unwrap();
    assert_eq!(st.note_count, SHIELD_V2_MAX_NOTES);
    assert_eq!(st.frontier, [[0u8; 32]; 32], "a full tree has nothing waiting");
    // the root of the full tree: the two top-level halves joined
    let left = digest_from_bytes(&d(5_031)).unwrap();
    let mut right = merge(&digest_from_bytes(&three[1].cm_out[0]).unwrap(), &digest_from_bytes(&three[1].cm_out[1]).unwrap());
    right = merge(&merge(&digest_from_bytes(&three[0].cm_out[0]).unwrap(), &digest_from_bytes(&three[0].cm_out[1]).unwrap()), &right);
    for l in 2..31 {
        right = merge(&digest_from_bytes(&d(5_000 + l as u64)).unwrap(), &right);
    }
    assert_eq!(st.tree_root, digest_to_bytes(&merge(&left, &right)));
    // and now nothing fits, of any type
    let anchor = root(&pool);
    for t in [shield(4, anchor, 10, 0), transfer(5, anchor, 0), unshield(6, anchor, 1, 0)] {
        refused(unchanged_by_r(&mut pool, &[t]), 0, TxRefusal::TreeFull);
    }
    pool.apply_block(A + 6, &[]).expect("a block without V2 transactions is still fine");
}

// =================================================================================================
// §4.4 — pool accounting, the no-negative rule and the cap
// =================================================================================================

#[test]
fn pool_total_per_type_and_never_below_zero() {
    let mut pool = new_pool();
    let e = empty_tree_root();
    // shield: + (v_in - fee)
    let fx = pool.apply_block(A, &[shield(1, e, 110, 10)]).unwrap();
    assert_eq!(pool.state().unwrap().pool_total, 100);
    assert_eq!(fx.txs[0], TxEffect { kind: TxKind::Shield, account: [1; 32], account_debit: 110, account_credit: 0, fee: 10 });
    let r = root(&pool);
    // transfer: - fee. One quantum too much is refused; exactly the total is accepted
    refused(unchanged_by_r(&mut pool, &[transfer(2, r, 101)]), 0, TxRefusal::PoolUnderflow);
    // unshield: - (v_out + fee)
    refused(unchanged_by_r(&mut pool, &[unshield(2, r, 61, 40)]), 0, TxRefusal::PoolUnderflow);
    refused(unchanged_by_r(&mut pool, &[unshield(2, r, 100, 1)]), 0, TxRefusal::PoolUnderflow);
    // the largest amounts a body can carry: refused, no overflow
    refused(unchanged_by_r(&mut pool, &[unshield(2, r, u64::MAX, u64::MAX)]), 0, TxRefusal::PoolUnderflow);
    refused(unchanged_by_r(&mut pool, &[transfer(2, r, u64::MAX)]), 0, TxRefusal::PoolUnderflow);
    // the check is against the state after the preceding transactions of the block: 60 + 60 > 100
    refused(unchanged_by_r(&mut pool, &[unshield(2, r, 55, 5), unshield(3, r, 55, 5)]), 1, TxRefusal::PoolUnderflow);
    // … and a shield earlier in the block makes room for a later unshield
    let fx = pool.apply_block(A + 1, &[unshield(2, r, 55, 5), shield(3, r, 30, 10), unshield(4, r, 55, 5)]).unwrap();
    assert_eq!(pool.state().unwrap().pool_total, 100 - 60 + 20 - 60);
    assert_eq!(fx.fee_total, 20);
    assert_eq!(fx.txs[0], TxEffect { kind: TxKind::Unshield, account: [2; 32], account_debit: 0, account_credit: 55, fee: 5 });
    // down to exactly zero with a transfer's fee
    let mut pool = new_pool();
    pool.apply_block(A, &[shield(1, e, 110, 10)]).unwrap();
    let r = root(&pool);
    let fx = pool.apply_block(A + 1, &[transfer(2, r, 40), unshield(3, r, 50, 10)]).unwrap();
    assert_eq!(pool.state().unwrap().pool_total, 0);
    assert_eq!(fx.txs[0], TxEffect { kind: TxKind::Transfer, account: [2; 32], account_debit: 0, account_credit: 0, fee: 40 });
    assert_eq!(fx.fee_total, 50);
    // an empty pool pays nothing out — whatever a proof says
    let r = root(&pool);
    refused(unchanged_by_r(&mut pool, &[transfer(4, r, 1)]), 0, TxRefusal::PoolUnderflow);
    refused(unchanged_by_r(&mut pool, &[unshield(4, r, 1, 0)]), 0, TxRefusal::PoolUnderflow);
    // a zero-fee transfer changes nothing in the total (the minimum fee is not this module's rule)
    pool.apply_block(A + 2, &[transfer(4, r, 0)]).unwrap();
    assert_eq!(pool.state().unwrap().pool_total, 0);
}

#[test]
fn pool_cap_boundaries() {
    assert_eq!(SHIELD_V2_POOL_CAP_QUANTA, 1_000_000_000_000_000, "1,000,000 XRGE = 10^15 quanta");
    let cap = SHIELD_V2_POOL_CAP_QUANTA as u64;
    let e = empty_tree_root();
    // exactly the cap in one shield: accepted (the fee does not count towards the pool)
    let mut pool = new_pool();
    pool.apply_block(A, &[shield(1, e, cap + 7, 7)]).unwrap();
    assert_eq!(pool.state().unwrap().pool_total, SHIELD_V2_POOL_CAP_QUANTA);
    let r = root(&pool);
    // one quantum more: refused
    refused(unchanged_by_r(&mut pool, &[shield(2, r, 1, 0)]), 0, TxRefusal::PoolCapExceeded);
    refused(unchanged_by_r(&mut pool, &[shield(2, r, 8, 7)]), 0, TxRefusal::PoolCapExceeded);
    refused(unchanged_by_r(&mut pool, &[shield(2, r, u64::MAX, 0)]), 0, TxRefusal::PoolCapExceeded);
    // transfers and unshields are never refused because of the cap; nor is a shield that adds 0
    pool.apply_block(A + 1, &[shield(2, r, 5, 5), transfer(3, r, 1), unshield(4, r, 10, 1)]).unwrap();
    assert_eq!(pool.state().unwrap().pool_total, SHIELD_V2_POOL_CAP_QUANTA - 12);
    // room for 12 again: 12 accepted, 13 refused
    let r = root(&pool);
    refused(unchanged_by_r(&mut pool, &[shield(5, r, 13, 0)]), 0, TxRefusal::PoolCapExceeded);
    pool.apply_block(A + 2, &[shield(5, r, 12, 0)]).unwrap();
    assert_eq!(pool.state().unwrap().pool_total, SHIELD_V2_POOL_CAP_QUANTA);

    // one quantum above the cap in one shield of an empty pool
    let mut pool = new_pool();
    refused(unchanged_by_r(&mut pool, &[shield(1, e, cap + 1, 0)]), 0, TxRefusal::PoolCapExceeded);
    refused(unchanged_by_r(&mut pool, &[shield(1, e, cap + 8, 7)]), 0, TxRefusal::PoolCapExceeded);
    // the cap is checked against the evolving state of the block
    refused(unchanged_by_r(&mut pool, &[shield(1, e, cap - 1, 0), shield(2, e, 2, 0)]), 1, TxRefusal::PoolCapExceeded);
    pool.apply_block(A, &[shield(1, e, cap - 1, 0), shield(2, e, 1, 0)]).unwrap();
    assert_eq!(pool.state().unwrap().pool_total, SHIELD_V2_POOL_CAP_QUANTA);
    // an unshield earlier in the block makes room for a later shield
    let r = root(&pool);
    pool.apply_block(A + 1, &[unshield(3, r, 4, 1), shield(4, r, 5, 0)]).unwrap();
    assert_eq!(pool.state().unwrap().pool_total, SHIELD_V2_POOL_CAP_QUANTA);
}

// =================================================================================================
// §3.6 checks 8 and 10 as the pool repeats them: zero commitment, canonical digests, amounts
// =================================================================================================

#[test]
fn zero_commitment_and_non_canonical_digests() {
    let e = empty_tree_root();
    let mut pool = new_pool();
    let good = shield(1, e, 100, 1);
    // the all-zero digest is the empty leaf: neither output may be it, for any type
    for kind in [TxKind::Shield, TxKind::Transfer, TxKind::Unshield] {
        for j in 0..2 {
            let mut t = match kind {
                TxKind::Shield => good.clone(),
                TxKind::Transfer => transfer(1, e, 0),
                TxKind::Unshield => unshield(1, e, 1, 0),
            };
            t.cm_out[j] = digest_to_bytes(&ZERO_DIGEST);
            assert_eq!(t.cm_out[j], [0u8; 32]);
            refused(unchanged_by_r(&mut pool, &[t]), 0, TxRefusal::ZeroCommitment);
        }
    }
    // both at once; and a single non-zero word is enough to be a commitment
    refused(unchanged_by_r(&mut pool, &[PoolTx { cm_out: [[0; 32]; 2], ..good.clone() }]), 0, TxRefusal::ZeroCommitment);
    let mut one = [0u8; 32];
    one[28] = 1;
    // a word >= p in any of the five digests: p = 0x7f000001, little-endian
    let p = 0x7f00_0001u32.to_le_bytes();
    for (field, name) in ["anchor", "nf1", "nf2", "cm_out1", "cm_out2"].into_iter().enumerate() {
        for word in [0usize, 7] {
            for bad_word in [p, 0xffff_ffffu32.to_le_bytes()] {
                let mut t = good.clone();
                let target = match field {
                    0 => &mut t.anchor,
                    1 => &mut t.nf[0],
                    2 => &mut t.nf[1],
                    3 => &mut t.cm_out[0],
                    _ => &mut t.cm_out[1],
                };
                target[4 * word..4 * word + 4].copy_from_slice(&bad_word);
                refused(unchanged_by_r(&mut pool, &[t]), 0, TxRefusal::NonCanonicalDigest(name));
            }
        }
    }
    // p - 1 is canonical: accepted (anchor aside, which must be a root)
    let mut t = good.clone();
    t.nf[0][..4].copy_from_slice(&0x7f00_0000u32.to_le_bytes());
    t.cm_out[1] = one;
    pool.apply_block(A, &[t]).unwrap();
    assert_eq!(pool.store().leaf(1), Some(one));
}

#[test]
fn amount_pattern_of_each_type() {
    let e = empty_tree_root();
    let mut pool = new_pool();
    pool.apply_block(A, &[shield(100, e, 1_000_000, 0)]).unwrap();
    let r = root(&pool);
    let t = |kind, v_in, v_out, fee| tx(kind, 1, r, v_in, v_out, fee);
    let bad = [
        // shield: v_in > 0, v_out = 0, fee <= v_in
        t(TxKind::Shield, 0, 0, 0),
        t(TxKind::Shield, 100, 1, 0),
        t(TxKind::Shield, 100, 0, 101),
        t(TxKind::Shield, 0, 100, 0),
        // transfer: v_in = v_out = 0
        t(TxKind::Transfer, 1, 0, 0),
        t(TxKind::Transfer, 0, 1, 0),
        t(TxKind::Transfer, 5, 5, 0),
        // unshield: v_in = 0, v_out > 0
        t(TxKind::Unshield, 0, 0, 0),
        t(TxKind::Unshield, 1, 1, 0),
        t(TxKind::Unshield, 1, 0, 0),
    ];
    for b in bad {
        refused(unchanged_by_r(&mut pool, &[b]), 0, TxRefusal::AmountPattern);
    }
    let good = [
        t(TxKind::Shield, 1, 0, 0),
        t(TxKind::Shield, 100, 0, 100), // fee = v_in: nothing enters the pool
        t(TxKind::Transfer, 0, 0, 7),
        t(TxKind::Unshield, 0, 1, 0),
    ];
    for (i, g) in good.into_iter().enumerate() {
        pool.validate_block(A + 1, &[g]).unwrap_or_else(|e| panic!("good pattern {i}: {e:?}"));
    }
}

// =================================================================================================
// §4.7 — per-block limit
// =================================================================================================

#[test]
fn per_block_limit() {
    assert_eq!(SHIELD_V2_MAX_TX_PER_BLOCK, 8);
    let e = empty_tree_root();
    let mut pool = new_pool();
    pool.apply_block(A, &[shield(100, e, 1_000_000, 0)]).unwrap();
    let r = root(&pool);
    // the three types are counted together
    let mk = |i: u64| match i % 3 {
        0 => shield(i, r, 10, 1),
        1 => transfer(i, r, 1),
        _ => unshield(i, r, 3, 1),
    };
    let nine: Vec<PoolTx> = (1..=9).map(mk).collect();
    let err = unchanged_by(&mut pool, |p| p.apply_block(A + 1, &nine));
    assert_eq!(err, PoolError::TooManyTransactions { count: 9, max: 8 });
    let many: Vec<PoolTx> = (1..=100).map(mk).collect();
    let err = unchanged_by(&mut pool, |p| p.apply_block(A + 1, &many));
    assert_eq!(err, PoolError::TooManyTransactions { count: 100, max: 8 });
    // exactly 8: accepted; the limit is per block, so 8 more in the next
    pool.apply_block(A + 1, &nine[..8]).unwrap();
    let r = root(&pool);
    let next: Vec<PoolTx> = (11..=18).map(|i| transfer(i, r, 1)).collect();
    pool.apply_block(A + 2, &next).unwrap();
    assert_eq!(pool.state().unwrap().note_count, 2 * 17);
}

// =================================================================================================
// §4.8 — the state-root section
// =================================================================================================

/// The section of spec §4.8, assembled byte by byte from the specification's text.
fn section_from_spec(root_before: &str, s: &PoolState) -> String {
    let mut bytes: Vec<u8> = Vec::new();
    bytes.extend_from_slice(b"rougechain.stateroot.shield_v2.v1");
    assert_eq!(bytes.len(), 33);
    bytes.extend_from_slice(&64u64.to_be_bytes());
    bytes.extend_from_slice(root_before.as_bytes());
    assert_eq!(bytes.len(), 33 + 8 + 64);
    bytes.extend_from_slice(&s.pool_total.to_be_bytes()); // u128 BE, 16 bytes
    bytes.extend_from_slice(&s.note_count.to_be_bytes());
    bytes.extend_from_slice(&s.tree_root);
    for f in &s.frontier {
        bytes.extend_from_slice(f);
    }
    bytes.extend_from_slice(&s.nullifier_count.to_be_bytes());
    bytes.extend_from_slice(&s.nullifier_acc);
    bytes.extend_from_slice(&(s.window.len() as u64).to_be_bytes());
    for w in &s.window {
        bytes.extend_from_slice(w);
    }
    assert_eq!(bytes.len(), 33 + 72 + 16 + 8 + 32 + 32 * 32 + 8 + 32 + 8 + 32 * s.window.len());
    Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn busy_pool() -> Pool<MemoryPoolStore> {
    let mut pool = new_pool();
    let e = empty_tree_root();
    pool.apply_block(A, &[shield(1, e, 5_000, 10), shield(2, e, 7_000, 10)]).unwrap();
    pool.apply_block(A + 1, &[]).unwrap();
    let r = root(&pool);
    pool.apply_block(A + 2, &[transfer(3, r, 3), unshield(4, r, 1_000, 5), shield(5, e, 99, 9)]).unwrap();
    pool
}

#[test]
fn state_root_section_layout_and_determinism() {
    let before = "ab".repeat(32);
    // from A on unconditionally, including while the pool is empty
    let genesis = PoolState::genesis();
    let g = genesis.state_root_section(&before).unwrap();
    assert_eq!(g, section_from_spec(&before, &genesis));
    assert_eq!(g.len(), 64);
    assert!(g.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')), "lowercase hexadecimal");
    assert_ne!(g, before);
    // regression values of THIS implementation (not normative: spec §8.1 has no vector for the
    // section yet, open issue O-15). `root_before` = "ab" x 32.
    assert_eq!(g, REGRESSION_GENESIS, "the genesis section changed");

    let pool = busy_pool();
    let s = pool.state().unwrap();
    assert_eq!((s.note_count, s.nullifier_count, s.window.len()), (10, 10, 4));
    assert_eq!(s.pool_total, 4_990 + 6_990 - 3 - 1_005 + 90);
    let r = s.state_root_section(&before).unwrap();
    assert_eq!(r, section_from_spec(&before, &s));
    assert_eq!(r, REGRESSION_BUSY, "the section of the busy pool changed");
    // deterministic: the same blocks give the same section, on a fresh pool and when recomputed
    assert_eq!(busy_pool().state().unwrap().state_root_section(&before).unwrap(), r);
    assert_eq!(s.state_root_section(&before).unwrap(), r);
    // a prepared block predicts the section before anything is stored
    let mut p2 = busy_pool();
    let txs = [transfer(9, root(&p2), 1)];
    let prepared = p2.validate_block(A + 3, &txs).unwrap();
    let predicted = prepared.state_root_section(&before).unwrap();
    assert_eq!(p2.state().unwrap().state_root_section(&before).unwrap(), r, "validation stored nothing");
    p2.commit(prepared).unwrap();
    assert_eq!(p2.state().unwrap().state_root_section(&before).unwrap(), predicted);
    assert_ne!(predicted, r);

    // every committed quantity moves the section
    let mut seen = std::collections::BTreeSet::from([r.clone()]);
    let mut differs = |name: &str, s: &PoolState, rb: &str| {
        let x = s.state_root_section(rb).unwrap();
        assert_eq!(x, section_from_spec(rb, s), "{name}");
        assert!(seen.insert(x), "{name}: the section did not change");
    };
    differs("root_before", &s, &"ac".repeat(32));
    differs("pool_total", &PoolState { pool_total: s.pool_total + 1, ..s.clone() }, &before);
    differs("pool_total high half", &PoolState { pool_total: s.pool_total + (1 << 64), ..s.clone() }, &before);
    differs("note_count", &PoolState { note_count: s.note_count + 1, ..s.clone() }, &before);
    differs("tree_root", &PoolState { tree_root: d(1), ..s.clone() }, &before);
    for l in [0usize, 1, 3, 31] {
        let mut f = s.frontier;
        f[l][0] ^= 1;
        differs("frontier", &PoolState { frontier: f, ..s.clone() }, &before);
    }
    differs("nullifier_count", &PoolState { nullifier_count: s.nullifier_count + 1, ..s.clone() }, &before);
    differs("nullifier_acc", &PoolState { nullifier_acc: d(2), ..s.clone() }, &before);
    let mut w = s.window.clone();
    w.swap(0, 3);
    differs("window order", &PoolState { window: w, ..s.clone() }, &before);
    let mut w = s.window.clone();
    w.push(s.tree_root);
    differs("window length", &PoolState { window: w, ..s.clone() }, &before);
    let mut w = s.window.clone();
    w.remove(0);
    differs("window: oldest removed", &PoolState { window: w, ..s.clone() }, &before);

    // the order of the transactions is committed (nullifier order and leaf order)
    let e = empty_tree_root();
    let (mut ab, mut ba) = (new_pool(), new_pool());
    ab.apply_block(A, &[shield(1, e, 50, 1), shield(2, e, 50, 1)]).unwrap();
    ba.apply_block(A, &[shield(2, e, 50, 1), shield(1, e, 50, 1)]).unwrap();
    assert_ne!(
        ab.state().unwrap().state_root_section(&before).unwrap(),
        ba.state().unwrap().state_root_section(&before).unwrap()
    );
    // an empty block still moves the section (the window grew)
    let mut p = busy_pool();
    p.apply_block(A + 3, &[]).unwrap();
    assert_ne!(p.state().unwrap().state_root_section(&before).unwrap(), r);

    // root_before: exactly 64 lowercase hexadecimal characters
    for bad in ["", &"ab".repeat(31), &"ab".repeat(33), &"AB".repeat(32), &"0x".repeat(32), &format!("{}g", "a".repeat(63))] {
        assert_eq!(s.state_root_section(bad), Err(PoolError::BadPreviousRoot), "{bad:?}");
    }
    println!("POOL|state root|genesis section {g}|busy pool section {r}");
}

const REGRESSION_GENESIS: &str = "af2b0f4f7ae3d609739e85a44e69c85f3f01fe350276b8ae743a4181cd9849cf";
const REGRESSION_BUSY: &str = "faff3cd4c70abe4b99dcf7cc7c46a3e99a4f58c59d0f5725392ae608afc15ce3";

// =================================================================================================
// §4.2 rule 4, §4.5, §4.6 — all or nothing
// =================================================================================================

/// A store whose next commit can be made to fail.
struct Flaky {
    inner: MemoryPoolStore,
    fail: Cell<bool>,
}

impl PoolStore for Flaky {
    fn load(&self) -> Result<Option<StoredPool>, StoreError> {
        self.inner.load()
    }
    fn contains_nullifier(&self, nf: &Bytes32) -> Result<bool, StoreError> {
        self.inner.contains_nullifier(nf)
    }
    fn commit(&mut self, update: &PoolUpdate) -> Result<(), StoreError> {
        if self.fail.get() {
            return Err(StoreError("disk full".into()));
        }
        self.inner.commit(update)
    }
}

#[test]
fn a_block_is_applied_entirely_or_not_at_all() {
    let e = empty_tree_root();
    let mut pool = new_pool();
    pool.apply_block(A, &[shield(1, e, 10_000, 10)]).unwrap();
    let r = root(&pool);
    let good = |i: u64| transfer(i, r, 1);
    // one failing transaction in each position of a block of valid ones, one failure per rule
    let mut eq_nf = good(50);
    eq_nf.nf[1] = eq_nf.nf[0];
    let failing: Vec<(PoolTx, TxRefusal)> = vec![
        (PoolTx { cm_out: [d(1), [0; 32]], ..good(50) }, TxRefusal::ZeroCommitment),
        (eq_nf, TxRefusal::EqualNullifiers),
        (tx(TxKind::Transfer, 50, r, 1, 0, 1), TxRefusal::AmountPattern),
        (transfer(50, d(31337), 1), TxRefusal::AnchorNotInWindow),
        (PoolTx { nf: shield(1, e, 0, 0).nf, ..good(50) }, TxRefusal::NullifierSpent),
        (PoolTx { nf: good(2).nf, ..good(50) }, TxRefusal::NullifierRepeatedInBlock),
        (unshield(50, r, 1_000_000, 1), TxRefusal::PoolUnderflow),
        (shield(50, r, u64::MAX, 0), TxRefusal::PoolCapExceeded),
    ];
    for (bad, reason) in &failing {
        for pos in 0..4 {
            if *reason == TxRefusal::NullifierRepeatedInBlock && pos < 1 {
                continue; // needs transaction 2 before it
            }
            let mut block: Vec<PoolTx> = (2..5).map(good).collect();
            block.insert(pos, bad.clone());
            refused(unchanged_by_r(&mut pool, &block), pos, *reason);
        }
    }
    // the same block without the failing transaction is accepted in one piece
    let block: Vec<PoolTx> = (2..5).map(good).collect();
    let before = pool.store().clone();
    let fx = pool.apply_block(A + 1, &block).unwrap();
    assert_eq!((fx.height, fx.txs.len(), fx.fee_total), (A + 1, 3, 3));
    let st = pool.state().unwrap();
    assert_eq!(st.nullifier_count, before.load().unwrap().unwrap().state.nullifier_count + 6);
    assert_eq!(st.note_count, 8);
    assert_eq!(pool.store().nullifiers().len(), 8);
    assert_eq!(pool.store().leaf_count(), 8);
    // nullifiers and commitments entered together: count for count
    assert_eq!(st.nullifier_count, st.note_count);

    // a store that fails to commit: the error is reported and nothing was applied
    let flaky = Flaky { inner: pool.into_store(), fail: Cell::new(true) };
    let snapshot = flaky.inner.clone();
    let mut pool = Pool::open_or_init(flaky, A).unwrap();
    let block = [transfer(60, root_of(&pool), 1)];
    assert_eq!(pool.apply_block(A + 2, &block), Err(PoolError::Store(StoreError("disk full".into()))));
    assert_eq!(pool.store().inner, snapshot);
    assert_eq!(pool.next_height().unwrap(), A + 2);
    pool.store().fail.set(false);
    pool.apply_block(A + 2, &block).expect("the same block applies once the store works");

    // a block prepared against a state that has moved on is not stored
    let mut pool = Pool::open_or_init(pool.into_store().inner, A).unwrap();
    let r = root(&pool);
    let stale = pool.validate_block(A + 3, &[transfer(70, r, 1)]).unwrap();
    let other = pool.validate_block(A + 3, &[transfer(71, r, 1)]).unwrap();
    pool.commit(other).unwrap();
    let err = unchanged_by(&mut pool, |p| p.commit(stale));
    assert_eq!(err, PoolError::StalePreparation);
    // validation alone never stores anything
    let before = pool.store().clone();
    let _ = pool.validate_block(A + 4, &[transfer(80, root(&pool), 1)]).unwrap();
    assert_eq!(pool.store(), &before);
}

fn root_of<S: PoolStore>(pool: &Pool<S>) -> Bytes32 {
    pool.state().unwrap().tree_root
}

#[test]
fn heights_are_applied_in_order_from_the_activation_height() {
    let mut pool = new_pool();
    assert_eq!(pool.next_height().unwrap(), A);
    assert_eq!(pool.state().unwrap(), PoolState::genesis());
    for bad in [0, A - 1, A + 1, u64::MAX] {
        let err = unchanged_by(&mut pool, |p| p.apply_block(bad, &[]));
        assert_eq!(err, PoolError::HeightOutOfOrder { expected: A, got: bad });
    }
    pool.apply_block(A, &[]).unwrap();
    let err = unchanged_by(&mut pool, |p| p.apply_block(A, &[]));
    assert_eq!(err, PoolError::HeightOutOfOrder { expected: A + 1, got: A });
    // reopening keeps the state; another activation height is refused
    let store = pool.into_store();
    assert_eq!(
        Pool::open_or_init(store.clone(), A + 1).err(),
        Some(PoolError::ActivationMismatch { stored: A, requested: A + 1 })
    );
    let pool = Pool::open_or_init(store, A).unwrap();
    assert_eq!(pool.next_height().unwrap(), A + 1);
    // the initial state of spec §4.1
    let g = PoolState::genesis();
    assert_eq!((g.pool_total, g.note_count, g.nullifier_count), (0, 0, 0));
    assert_eq!(g.nullifier_acc, [0u8; 32]);
    assert_eq!(g.tree_root, empty_tree_root());
    assert_eq!(g.window, vec![empty_tree_root()]);
    assert!(MemoryPoolStore::new().nullifiers().is_empty());
}
