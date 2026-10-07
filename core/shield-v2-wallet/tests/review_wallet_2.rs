//! REVIEW_WALLET_2 — second independent review, of the code ADDED to answer REVIEW_WALLET_1
//! (see `REVIEW_WALLET_2.md`). Reviewed: `origin/main` @60d1e2b.
//!
//! * `rw2_fN_…` — **regression tests of the confirmed defects.** They failed on the reviewed
//!   commit (60d1e2b) and pass since the fixes (see "Resolution" in the report). Each replays the
//!   review's attack to its end and asserts the outcome the fix guarantees.
//! * `rw2_sound_…` — an attack that was tried and does not work.
//!
//! Needs the `test-vectors` feature (proof-less deterministic assembly), like `review_wallet_1.rs`.
#![cfg(feature = "test-vectors")]

mod common;

use common::*;
use quantum_vault_shield_v2::reference::{derive_rho, digest_from_bytes, digest_to_bytes, Note, MODULUS};
use quantum_vault_shield_v2_wallet::keys::{ADDRESS_TEXT_BYTES, ADDRESS_TEXT_CHARS};
use quantum_vault_shield_v2_wallet::note_enc::encrypt_note_with_kem_randomness;
use quantum_vault_shield_v2_wallet::tx::{deterministic, UnprovenTx};
use quantum_vault_shield_v2_wallet::*;

fn fund(chain: &mut Chain, to: &ShieldedAddress, values: &[u64]) {
    let key = fake_account_key(1);
    for (i, v) in values.iter().enumerate() {
        let req = ShieldRequest { ctx: chain.ctx(), from_pub_key: &key, nonce: 1, v_in: v + Q, fee: SHIELD_V2_MIN_FEE_QUANTA, recipient: to, max_fee: None };
        let tx = deterministic::shield(&req, &format!("rw2-fund-{}-{i}", chain.height)).unwrap();
        chain.block(&[&tx.body]).unwrap();
    }
}

/// The same deterministic chain every time it is called: the "real" chain and a lying node's copy
/// of it start from the same blocks.
fn base(to: &ShieldedAddress, values: &[u64]) -> Chain {
    let mut c = Chain::new();
    fund(&mut c, to, values);
    c
}

/// A wallet scanned to the tip and configured with three nodes: the two that
/// `Chain::state_reports` answers for, and `the-node` — the one that lies in these tests. The
/// quorum is two of the three (REVIEW_WALLET_3 RW3-1).
fn synced(chain: &Chain, keys: &ShieldedKeys) -> WalletState {
    let mut s = WalletState::new(keys.address().pk);
    configure(&mut s, &[NODE_A, NODE_B, "the-node"]);
    s.scan(&chain.page(s.next_height()), &keys.scan_key()).unwrap();
    assert_eq!(s.anchor(), chain.state().tree_root);
    s
}

/// A transfer built from the wallet's own state exactly as the wasm surface does it: the anchor
/// is the state's root, the anchor height its scanned height, the expiry the default (+64).
fn transfer(state: &WalletState, keys: &ShieldedKeys, positions: &[u64], to: &ShieldedAddress, amount: u64, label: &str) -> UnprovenTx {
    let inputs: Vec<SpendInput> = positions.iter().map(|&p| state.spend_input(p).unwrap()).collect();
    let ctx = TxContext::new(CHAIN, state.anchor(), state.scanned_height().unwrap());
    deterministic::transfer(&TransferRequest { ctx, keys, inputs: &inputs, recipient: to, amount, fee: Q, max_fee: None }, label).unwrap()
}

fn parse(page: &serde_json::Value) -> ListingPage {
    ListingPage::from_json(&page.to_string()).unwrap()
}

/// The report of a node that vouches for whatever this wallet has been made to believe.
fn echo(w: &WalletState, id: &str) -> StateReport {
    let h = w.scanned_height().unwrap();
    let v = w.state_at(h).unwrap();
    StateReport {
        node_id: node(id),
        height: h,
        tree_root: v.tree_root,
        nullifier_acc: v.nullifier_acc,
        note_count: v.note_count,
        nullifier_count: v.nullifier_count,
        ciphertext_acc: v.ciphertext_acc,
    }
}

/// The pending entry of this transaction, if the state still holds it.
fn entry<'a>(w: &'a WalletState, record: &PendingTx) -> Option<&'a PendingTx> {
    w.pending().iter().find(|p| p.nullifiers == record.nullifiers)
}

/// The rule a user interface follows (spec §5.5): "pay again" is offered for a payment only when
/// the wallet has SETTLED it as dead — expired or superseded. While the entry is in the pending
/// list, or after it settled as mined, there is no retry.
fn retry_offered(resolutions: &[Resolution], record: &PendingTx) -> bool {
    resolutions.iter().any(|r| r.expired.iter().chain(&r.superseded).any(|p| p.nullifiers == record.nullifiers))
}

/// A canonical digest from a tag (every 4-byte word < p).
fn digest_bytes(tag: u8) -> [u8; 32] {
    let mut b = [0u8; 32];
    for (i, w) in b.chunks_mut(4).enumerate() {
        w.copy_from_slice(&((tag as u32 * 0x0101_0101 + i as u32 * 7919) % MODULUS).to_le_bytes());
    }
    b
}

fn position_of(s: &WalletState, value: u64) -> u64 {
    s.unspent().find(|n| n.value == value).expect("a note of that value").position
}

// ---------------------------------------------------------------------------------------------------
// RW2-1 (High) — "mined" was decided by ONE node's listing, and the rescan that followed started
// with the inputs unlocked while the transaction was still valid.
// ---------------------------------------------------------------------------------------------------

/// The scenario of the review, to both of its ends. Alice holds one 10 XRGE note and pays Bob 4
/// (`t1`, recorded with `mark_pending` first). The node she uses KEEPS `t1` and serves a listing
/// in which it is mined.
///
/// 1. The wallet notes what the listing shows and settles nothing: `t1` is still in the pending
///    list and its input is locked — before and after the state check against two honest nodes
///    (`diverged`), after `resolve`, after `fresh_for_rescan`, in both orders, through JSON.
/// 2. A retry is refused: the note cannot be selected or handed to a builder, and the wallet
///    never reports the payment as dead, so no interface offers "pay again".
/// 3. End A — the node never releases `t1`: once two honest nodes confirm a height at or above
///    its expiry, `t1` settles as `expired`, the 10 XRGE are intact and free, and the retry that
///    is now offered pays Bob once.
/// 4. End B — the node releases `t1` late, at its last valid height: the wallet settles it as
///    `mined`; no retry was ever offered; Bob holds exactly 4.
#[test]
fn rw2_f1_a_listing_that_shows_the_pending_tx_mined_never_unlocks_and_bob_is_paid_exactly_once() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let honest0 = base(&alice.address(), &[10 * Q]);
    let mut a = synced(&honest0, &alice);
    configure_as_sole_copy(&mut a, &[NODE_A, NODE_B, "the-node"]); // a NEW wallet: the user says so, and it spends at once
    confirm(&honest0, &mut a);
    let t1 = transfer(&a, &alice, &[position_of(&a, 10 * Q)], &bob.address(), 4 * Q, "rw2-f1-t1");
    let record = t1.pending().unwrap();
    let expiry = record.expiry_height;
    assert_eq!(expiry, honest0.height + DEFAULT_EXPIRY_OFFSET);
    a.mark_pending(record.clone()).unwrap();

    // the node Alice submits to keeps t1 and serves a listing in which it is mined
    let mut liar = base(&alice.address(), &[10 * Q]);
    liar.block(&[&t1.body]).unwrap();
    let rep = a.scan(&liar.page(a.next_height()), &alice.scan_key()).unwrap();
    assert_eq!(rep.pending_seen_mined, 1, "the wallet notes what the listing shows");
    let mut seen: Vec<Resolution> = vec![a.resolve()];
    assert_eq!(seen[0].still_pending, 1, "one node's listing settles nothing");
    assert!(entry(&a, &record).is_some());
    assert_eq!(a.balances().confirmed, 0, "and the change it lists is not credited");
    // the liar vouching for its own listing is one node: no quorum
    assert!(a.confirm_state(&[echo(&a, "the-node")]).unwrap().matched_height.is_none());

    // the real chain: the same height, t1 is in no block
    let mut honest = base(&alice.address(), &[10 * Q]);
    honest.advance_to(liar.height);
    let c = a.confirm_state(&honest.state_reports()).unwrap();
    assert!(c.diverged && c.matched_height.is_none(), "two honest nodes say: this listing is not the chain");
    assert!(a.confirmed_height().unwrap() < liar.height, "nobody confirmed the height at which t1 is 'mined'");
    // … and the liar among them changes nothing
    let mut three = honest.state_reports();
    three.push(echo(&a, "the-node"));
    assert!(a.clone().confirm_state(&three).unwrap().diverged);
    a = WalletState::from_json(&a.to_json().unwrap()).unwrap();

    // the two orders in which a client can run the documented recovery
    let mut resolved_first = a.clone();
    seen.push(resolved_first.resolve());
    assert_eq!(seen[1].still_pending, 1, "not handed back as mined at a height nobody confirmed");
    let resolved_first = resolved_first.fresh_for_rescan();
    let rescan_first = a.fresh_for_rescan();
    assert!(!retry_offered(&seen, &record));

    for release_late in [false, true] {
        for (name, start) in [("resolve then rescan", resolved_first.clone()), ("rescan then resolve", rescan_first.clone())] {
            let what = format!("{name}, the node {}", if release_late { "releases t1 at its last valid height" } else { "never releases t1" });
            let mut offered: Vec<Resolution> = Vec::new();
            let mut real = base(&alice.address(), &[10 * Q]);
            real.advance_to(liar.height);
            let mut w = start;
            assert_eq!(entry(&w, &record).map(|p| p.status), Some(PendingStatus::Pending), "{what}: carried over as pending, never as mined");
            w.scan(&real.page(0), &alice.scan_key()).unwrap();
            confirm(&real, &mut w);
            offered.push(w.resolve());
            let pos10 = position_of(&w, 10 * Q);
            assert!(real.height < expiry, "t1 is still valid on the real chain");
            assert!(w.is_locked(pos10) && entry(&w, &record).is_some(), "{what}: t1 is pending and its input locked");
            // 5 XRGE arrive. The 10 note stays locked; the wallet has not called t1 dead
            fund(&mut real, &alice.address(), &[5 * Q]);
            w.scan(&real.page(w.next_height()), &alice.scan_key()).unwrap();
            confirm(&real, &mut w);
            offered.push(w.resolve());
            assert!(matches!(w.spend_input(pos10), Err(WalletError::NoteLocked)), "{what}: the retry from the same note is refused");
            assert!(select_inputs(&w, 4 * Q, Q).unwrap().positions.iter().all(|&p| p != pos10));
            assert!(!retry_offered(&offered, &record), "{what}: no retry is offered while t1 can still be mined");
            assert_eq!((w.balances().locked, w.balances().spendable), (10 * Q as u128, 5 * Q as u128));

            if release_late {
                real.advance_to(expiry - 1);
                real.block(&[&t1.body]).expect("valid at its expiry height");
            } else {
                real.advance_to(expiry);
            }
            w.scan(&real.page(w.next_height()), &alice.scan_key()).unwrap();
            assert_eq!(w.resolve().still_pending, 1, "{what}: scanned, not confirmed — nothing settles");
            confirm(&real, &mut w);
            let r = w.resolve();
            offered.push(r.clone());
            if release_late {
                assert_eq!((r.mined.len(), r.expired.len(), r.superseded.len()), (1, 0, 0), "{what}");
                assert!(!retry_offered(&offered, &record), "{what}: mined — nothing to retry");
                assert_eq!((w.balance(), w.balances().confirmed), (10 * Q as u128, 10 * Q as u128), "{what}: 10 + 5 - 4 - fee");
            } else {
                assert_eq!((r.mined.len(), r.expired.len(), r.superseded.len()), (0, 1, 0), "{what}");
                assert!(Body::decode(&t1.body).unwrap().expiry_height < real.height + 1, "the node refuses t1 from here on");
                assert_eq!((w.balance(), w.balances().spendable), (15 * Q as u128, 15 * Q as u128), "{what}: the funds are intact and free");
                // the retry the wallet now allows
                assert!(retry_offered(&offered, &record));
                let sel = select_inputs(&w, 4 * Q, Q).unwrap();
                let t2 = transfer(&w, &alice, &sel.positions, &bob.address(), 4 * Q, "rw2-f1-t2");
                w.mark_pending(t2.pending().unwrap()).unwrap();
                real.block(&[&t2.body]).expect("the retry is mined");
            }
            assert_eq!(synced(&real, &bob).balance(), 4 * Q as u128, "{what}: Bob holds exactly one payment");
        }
    }
}

// ---------------------------------------------------------------------------------------------------
// RW2-2 (High) — the tree root commits the output commitments, not the nullifiers; a listing node
// that swapped the nullifiers of a mined transaction made the strict policy call it expired.
// ---------------------------------------------------------------------------------------------------

/// `t1` (Alice pays Bob 4 from her 10 note) is really mined. The node Alice scans from serves the
/// real blocks with `t1`'s two nullifiers replaced and leaves the commitments alone, so the
/// wallet's TREE is the real tree.
///
/// Since the fix the wallet rebuilds the pool's nullifier hash from the same listing, and the
/// state check compares it too: two honest nodes do NOT confirm the listing — at no height at or
/// above `t1`'s. Nothing is confirmed, `t1` is never called expired, its input stays locked, also
/// far beyond the expiry height. The confirmed balance stays what it was at the last confirmed
/// height (10 XRGE, which is what Alice had then). After a rescan against an honest node `t1`
/// settles as mined: Alice 5, Bob 4.
#[test]
fn rw2_f2_swapped_nullifiers_are_not_confirmed_and_a_mined_tx_is_never_called_expired() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = base(&alice.address(), &[10 * Q]);
    let mut a = synced(&chain, &alice);
    configure_as_sole_copy(&mut a, &[NODE_A, NODE_B, "the-node"]); // a NEW wallet: the user says so, and it spends at once
    confirm(&chain, &mut a);
    let confirmed_before = a.confirmed_height();
    let t1 = transfer(&a, &alice, &[position_of(&a, 10 * Q)], &bob.address(), 4 * Q, "rw2-f2-t1");
    let record = t1.pending().unwrap();
    let expiry = record.expiry_height;
    let change_cm = record.change.as_ref().unwrap().cm;
    a.mark_pending(record.clone()).unwrap();

    chain.block(&[&t1.body]).expect("t1 is mined");
    chain.advance_to(expiry + 10);
    assert_eq!(synced(&chain, &bob).balance(), 4 * Q as u128, "Bob was paid");

    // the listing node: the real blocks, t1's nullifiers swapped for two other canonical digests
    let mut page = chain.page_value(a.next_height(), chain.height);
    let listed = page["txs"].as_array_mut().unwrap();
    assert_eq!(listed.len(), 1);
    assert!(listed[0]["outputs"].as_array().unwrap().iter().any(|o| o["cm_out"] == hex::encode(change_cm.0)), "the change commitment is in the listing");
    listed[0]["nf1"] = serde_json::json!(hex::encode(digest_bytes(0x51)));
    listed[0]["nf2"] = serde_json::json!(hex::encode(digest_bytes(0x52)));
    let rep = a.scan(&parse(&page), &alice.scan_key()).unwrap();
    assert_eq!((rep.pending_seen_mined, rep.pending_seen_superseded, rep.received.len()), (0, 0, 0), "the wallet saw neither the spend nor its change");
    assert_eq!(a.anchor(), chain.state().tree_root, "its tree IS the real tree");
    assert_ne!(a.nullifier_acc(), chain.state().nullifier_acc, "its nullifier hash is not the pool's");

    // two honest nodes at the tip — past the expiry height: the root matches, the state does not
    assert!(chain.height >= expiry);
    let c = a.confirm_state(&chain.state_reports()).unwrap();
    assert!(c.diverged && c.matched_height.is_none() && c.newly_confirmed.is_empty(), "a matching root is not a matching state");
    assert_eq!(a.confirmed_height(), confirmed_before);
    let r = a.resolve();
    assert_eq!((r.expired.len(), r.mined.len(), r.superseded.len(), r.still_pending), (0, 0, 0, 1), "a mined transaction is never called expired");
    assert!(a.is_locked(position_of(&a, 10 * Q)), "and its input stays locked");
    assert_eq!(a.balances().spendable, 0);
    // the confirmed figure is the one of the last confirmed height, where Alice did hold 10
    assert_eq!(a.balances().confirmed, 10 * Q as u128);
    // the same lie, vouched for by the liar itself: one node
    assert!(a.confirm_state(&[echo(&a, "the-node")]).unwrap().matched_height.is_none());

    // the documented way out: rebuild against a node that does not lie
    let mut w = a.fresh_for_rescan();
    w.scan(&chain.page(0), &alice.scan_key()).unwrap();
    assert_eq!(w.resolve().still_pending, 1);
    confirm(&chain, &mut w);
    let r = w.resolve();
    assert_eq!((r.mined.len(), r.expired.len(), r.still_pending), (1, 0, 0), "both nullifiers and both outputs are in the confirmed data: mined");
    assert_eq!((w.balance(), w.balances().confirmed), (5 * Q as u128, 5 * Q as u128));
    assert!(w.unspent().any(|n| n.cm == change_cm), "the change was credited with the settlement");
}

/// The same lie without any pending transaction: a listing node hides the spend of a wallet's
/// note (made on another device) by swapping its nullifiers. The note stays in the wallet's
/// listing — but no height at or above the hidden spend can be confirmed, so the wallet never
/// calls that state confirmed, and `diverged` tells it to look elsewhere.
#[test]
fn rw2_f2_a_hidden_spend_cannot_be_confirmed() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = base(&alice.address(), &[10 * Q]);
    let mut here = synced(&chain, &alice);
    configure_as_sole_copy(&mut here, &[NODE_A, NODE_B, "the-node"]); // a NEW wallet: the user says so, and it spends at once
    confirm(&chain, &mut here);
    let mut elsewhere = here.clone();
    let t = transfer(&elsewhere, &alice, &[position_of(&elsewhere, 10 * Q)], &bob.address(), 9 * Q, "rw2-f2-hidden");
    elsewhere.mark_pending(t.pending().unwrap()).unwrap();
    chain.block(&[&t.body]).unwrap();
    chain.block(&[]).unwrap();

    let mut page = chain.page_value(here.next_height(), chain.height);
    page["txs"][0]["nf1"] = serde_json::json!(hex::encode(digest_bytes(0x61)));
    page["txs"][0]["nf2"] = serde_json::json!(hex::encode(digest_bytes(0x62)));
    here.scan(&parse(&page), &alice.scan_key()).unwrap();
    assert_eq!(here.balance(), 10 * Q as u128, "the listing hides the spend");
    let c = here.confirm_state(&chain.state_reports()).unwrap();
    assert!(c.diverged && here.confirmed_height().unwrap() < chain.height - 1, "and cannot be confirmed at or above it");
    let mut w = here.fresh_for_rescan();
    w.scan(&chain.page(0), &alice.scan_key()).unwrap();
    confirm(&chain, &mut w);
    assert_eq!(w.balance(), 0, "the truth: 9 to Bob, the fee, no change");
}

// ---------------------------------------------------------------------------------------------------
// RW2-3 (Medium) — a pending transaction was called mined when ANY transaction spent ONE of its
// inputs, and then every input was marked spent. Two devices on one recovery phrase are enough.
// ---------------------------------------------------------------------------------------------------

/// Alice has a 3 and a 4 XRGE note and the same phrase on two devices. Device A builds `t1` from
/// BOTH notes (5 to Bob) and records it. Before `t1` is mined, device B — which cannot know A's
/// lock: two devices share no storage — pays 1 XRGE from the 3 note; that is mined, and `t1` is
/// invalid for ever.
///
/// Since the fix device A marks spent the 3 note only (its own nullifier appeared), reports `t1`
/// as `superseded` once the height is confirmed — not mined: Bob did not get those 5 — and
/// releases the 4 note. A's balance is the chain's. Nothing is lost and the 4 XRGE can be spent.
#[test]
fn rw2_f3_another_transaction_spending_one_input_supersedes_the_pending_tx_and_frees_the_other_input() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = base(&alice.address(), &[3 * Q, 4 * Q]);
    // device B is a SECOND device on the phrase: it makes no statement, and its restore
    // embargo has run out before the story begins (REVIEW_WALLET_5: a second device is under
    // the embargo like a restore; two LIVE devices still share no lock — the limit this test
    // is about)
    let mut device_b = synced(&chain, &alice);
    confirm(&chain, &mut device_b);
    chain.advance_to(device_b.spend_embargo_until().expect("the first state check fixed the base"));
    device_b.scan(&chain.page(device_b.next_height()), &alice.scan_key()).unwrap();
    confirm(&chain, &mut device_b);
    assert!(device_b.spend_gate().is_ok());
    let mut device_a = synced(&chain, &alice);
    configure_as_sole_copy(&mut device_a, &[NODE_A, NODE_B, "the-node"]); // the first device: a new wallet then
    confirm(&chain, &mut device_a);
    let (pos3, pos4) = (position_of(&device_a, 3 * Q), position_of(&device_a, 4 * Q));

    let t1 = transfer(&device_a, &alice, &[pos3, pos4], &bob.address(), 5 * Q, "rw2-f3-a");
    let record = t1.pending().unwrap();
    device_a.mark_pending(record.clone()).unwrap();

    let sel = select_inputs(&device_b, Q, Q).unwrap();
    assert_eq!(sel.positions, vec![pos3], "device B takes the smallest note that covers it");
    let tb = transfer(&device_b, &alice, &sel.positions, &bob.address(), Q, "rw2-f3-b");
    device_b.mark_pending(tb.pending().unwrap()).unwrap();
    chain.block(&[&tb.body]).expect("device B's payment is mined");
    assert!(chain.block(&[&t1.body]).is_err(), "t1 can never be mined now");
    chain.block(&[]).unwrap();

    let rep = device_a.scan(&chain.page(device_a.next_height()), &alice.scan_key()).unwrap();
    assert_eq!((rep.pending_seen_mined, rep.pending_seen_superseded, rep.spent.clone()), (0, 1, vec![pos3]), "only the note whose nullifier appeared is spent");
    let truth = synced(&chain, &alice).balance();
    assert_eq!(truth, 5 * Q as u128, "on chain: the 4 note and 1 change");
    assert!(!device_a.note_at(pos4).unwrap().spent && device_a.is_locked(pos4), "the 4 note: unspent, and locked until the height is confirmed");
    assert_eq!(device_a.resolve().still_pending, 1);
    confirm(&chain, &mut device_a);
    let r = device_a.resolve();
    assert_eq!((r.mined.len(), r.superseded.len(), r.expired.len(), r.still_pending), (0, 1, 0, 0), "t1 was not mined: it was superseded");
    assert!(!device_a.is_locked(pos4) && !device_a.note_at(pos4).unwrap().spent);
    assert_eq!((device_a.balance(), device_a.balances().spendable), (truth, truth), "A shows what the chain holds");
    // and the 4 XRGE are usable: the payment to Bob can be made from them
    let sel = select_inputs(&device_a, 2 * Q, Q).unwrap();
    assert_eq!(sel.positions, vec![pos4]);
    let t2 = transfer(&device_a, &alice, &sel.positions, &bob.address(), 2 * Q, "rw2-f3-a2");
    device_a.mark_pending(t2.pending().unwrap()).unwrap();
    chain.block(&[&t2.body]).expect("mined");
    assert_eq!(synced(&chain, &bob).balance(), 3 * Q as u128, "Bob: 1 from device B, 2 from device A");

    // device B's own entry, on the same chain, is the ordinary case: mined
    device_b.scan(&chain.page(device_b.next_height()), &alice.scan_key()).unwrap();
    confirm(&chain, &mut device_b);
    assert_eq!(device_b.resolve().mined.len(), 1);
}

/// The other half of "by its own outputs": two devices build DIFFERENT transactions from the same
/// two notes. Both have the same two nullifiers — the nullifier pair alone does not say which was
/// mined. The one whose outputs are in the listing is mined; the other is superseded.
#[test]
fn rw2_f3_the_same_two_inputs_on_two_devices_are_told_apart_by_the_outputs() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = base(&alice.address(), &[3 * Q, 4 * Q]);
    let mut device_a = synced(&chain, &alice);
    configure_as_sole_copy(&mut device_a, &[NODE_A, NODE_B, "the-node"]); // a NEW wallet: the user says so, and it spends at once
    confirm(&chain, &mut device_a);
    let mut device_b = device_a.clone();
    let (pos3, pos4) = (position_of(&device_a, 3 * Q), position_of(&device_a, 4 * Q));
    let ta = transfer(&device_a, &alice, &[pos3, pos4], &bob.address(), 5 * Q, "rw2-f3-same-a");
    let tb = transfer(&device_b, &alice, &[pos3, pos4], &bob.address(), 2 * Q, "rw2-f3-same-b");
    assert_eq!(ta.pending().unwrap().nullifiers, tb.pending().unwrap().nullifiers, "the same nullifier pair");
    assert_ne!(ta.pending().unwrap().outputs, tb.pending().unwrap().outputs);
    device_a.mark_pending(ta.pending().unwrap()).unwrap();
    device_b.mark_pending(tb.pending().unwrap()).unwrap();
    chain.block(&[&tb.body]).expect("device B's is mined");
    for (device, mined, superseded) in [(&mut device_a, 0, 1), (&mut device_b, 1, 0)] {
        device.scan(&chain.page(device.next_height()), &alice.scan_key()).unwrap();
        confirm(&chain, device);
        let r = device.resolve();
        assert_eq!((r.mined.len(), r.superseded.len()), (mined, superseded));
        assert_eq!(device.balance(), 4 * Q as u128, "7 - 2 - fee, on both devices");
    }
    assert_eq!(synced(&chain, &bob).balance(), 2 * Q as u128);
}

// ---------------------------------------------------------------------------------------------------
// RW2-4 (Low) — `confirm_roots` confirmed notes in the very call that reported `diverged`
// ---------------------------------------------------------------------------------------------------

/// The forged note of REVIEW_WALLET_1 F-1 again (made from the victim's public address alone).
/// Four nodes are asked: two — one operator under two names — vouch for the forged state; two
/// honest ones report the real one. Since the fix a conflicting report at a comparable height
/// means that NOTHING is confirmed by that call, also when the honest nodes answer one block
/// earlier than the liar; and without any conflict the quorum is a strict majority of the nodes
/// asked — two of four are not enough.
#[test]
fn rw2_f4_a_conflict_confirms_nothing_and_the_quorum_is_a_majority_of_the_nodes_asked() {
    let alice = keys(PHRASE_1);
    let address = alice.address();
    let pk = digest_from_bytes(&address.pk).unwrap();
    let (nf1, nf2) = (digest_bytes(1), digest_bytes(2));
    let nf = [digest_from_bytes(&nf1).unwrap(), digest_from_bytes(&nf2).unwrap()];
    let value = 1_000_000 * Q;
    let r = digest_bytes(3);
    let cm = digest_to_bytes(&Note { value, pk, rho: derive_rho(&nf, 0), r: digest_from_bytes(&r).unwrap() }.commitment());
    let (kem_ct, note_ct, _) = encrypt_note_with_kem_randomness(&address.ek, &cm, value, &r, [9u8; 32]).unwrap();
    let page = serde_json::json!({ "active": true, "tip_height": 10, "from_height": 3, "next_height": 11, "txs": [{
        "height": 5, "index": 0, "tx_hash": "00".repeat(32), "tx_type": "shielded_transfer_v2",
        "nf1": hex::encode(nf1), "nf2": hex::encode(nf2),
        "outputs": [
            { "cm_out": hex::encode(cm), "leaf": 0, "kem_ct": hex::encode(kem_ct), "note_ct": hex::encode(note_ct) },
            { "cm_out": hex::encode(digest_bytes(4)), "leaf": 1, "kem_ct": "00".repeat(1088), "note_ct": "00".repeat(56) },
        ],
    }] });
    let mut forged = WalletState::new(address.pk);
    // four CONFIGURED nodes: the quorum is three of them, whoever is asked (REVIEW_WALLET_3 RW3-1)
    configure(&mut forged, &["liar", "liar-again", "honest-1", "honest-2"]);
    forged.scan(&parse(&page), &alice.scan_key()).unwrap();
    let lying = forged.state_at(10).unwrap();
    // the real pool is empty
    let real = PoolView { tree_root: WalletState::new(address.pk).anchor(), nullifier_acc: [0u8; 32], note_count: 0, nullifier_count: 0, ciphertext_acc: [0u8; 32] };
    let report = |id: &str, height: u64, v: PoolView| StateReport {
        node_id: node(id),
        height,
        tree_root: v.tree_root,
        nullifier_acc: v.nullifier_acc,
        note_count: v.note_count,
        nullifier_count: v.nullifier_count,
        ciphertext_acc: v.ciphertext_acc,
    };

    for (what, honest_height) in [("the honest nodes at the same height", 10u64), ("the honest nodes one block behind", 9)] {
        let mut w = forged.clone();
        let c = w
            .confirm_state(&[report("liar", 10, lying), report("liar-again", 10, lying), report("honest-1", honest_height, real), report("honest-2", honest_height, real)])
            .unwrap();
        assert!(c.diverged && c.conflicts == vec![honest_height], "{what}: the conflict is reported");
        assert_eq!(c.dissenting.iter().map(|d| d.node_id.clone()).collect::<Vec<_>>(), vec![node("honest-1"), node("honest-2")], "{what}: by node");
        assert!(
            c.newly_confirmed.is_empty() && c.matched_height.is_none() && w.balances().confirmed == 0 && w.confirmed_height().is_none(),
            "{what}: two of four are not a majority, so nothing is confirmed"
        );
        assert!(w.content_eq(&forged), "{what}: the state is as it was");
    }
    // no conflict the wallet can see (the honest nodes are ahead of what it scanned): three of the
    // four configured nodes must agree — the two names of one operator are not a majority
    let mut w = forged.clone();
    let c = w.confirm_state(&[report("liar", 10, lying), report("liar-again", 10, lying), report("honest-1", 11, real), report("honest-2", 11, real)]).unwrap();
    assert_eq!((c.diverged, c.nodes, c.quorum, c.agreeing, c.not_comparable, c.matched_height), (false, 4, 3, 2, 2, None));
    assert_eq!(w.balances().confirmed, 0);
    // asking fewer nodes does not lower the quorum: it is a majority of the CONFIGURED four
    let c = w.clone().confirm_state(&[report("liar", 10, lying), report("honest-1", 11, real), report("honest-2", 11, real)]).unwrap();
    assert_eq!((c.quorum, c.configured, c.nodes), (3, 4, 3));
    // … so the two liars ALONE confirm nothing (REVIEW_WALLET_3: "drop the nodes that conflict"
    // used to confirm the forgery here)
    let c = w.confirm_state(&[report("liar", 10, lying), report("liar-again", 10, lying)]).unwrap();
    assert_eq!((c.matched_height, c.quorum, w.balances().confirmed), (None, 3, 0));
    // (a wallet CONFIGURED with those two names only does confirm: whom the wallet is configured
    // with is the user's trust decision, made explicitly with `set_nodes`)
    configure(&mut w, &["liar", "liar-again"]);
    assert!(w.confirm_state(&[report("liar", 10, lying), report("liar-again", 10, lying)]).unwrap().matched_height.is_some());
}

// ---------------------------------------------------------------------------------------------------
// RW2-5 (Low) — `ReleasePolicy::Scanned` released on one empty page that lied about the height.
// The policy is gone: there is no release on one node's word.
// ---------------------------------------------------------------------------------------------------

/// The node that answers "rejected" follows it with one empty page that claims the chain is past
/// the expiry height. The page passes every check a page can be given (it is compared with the
/// node's own `tip_height` only) — and releases nothing: `resolve` looks at the confirmed height,
/// the liar's own report is one node, and honest nodes do not report that height at all. The same
/// on a state fresh from `fresh_for_rescan`, which accepts a page that starts anywhere above.
/// On the real chain `t1` is then mined, and the wallet settles it as mined.
#[test]
fn rw2_f5_one_empty_page_that_lies_about_the_height_releases_nothing() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let chain = base(&alice.address(), &[10 * Q]);
    let mut a = synced(&chain, &alice);
    configure_as_sole_copy(&mut a, &[NODE_A, NODE_B, "the-node"]); // a NEW wallet: the user says so, and it spends at once
    confirm(&chain, &mut a);
    let pos = position_of(&a, 10 * Q);
    let t1 = transfer(&a, &alice, &[pos], &bob.address(), 4 * Q, "rw2-demo-scanned");
    let record = t1.pending().unwrap();
    let expiry = record.expiry_height;
    a.mark_pending(record.clone()).unwrap();
    assert!(a.note_rejection_hint(&record.nullifiers[0].0));

    let lie = |from: u64| parse(&serde_json::json!({ "active": true, "tip_height": expiry, "from_height": from, "next_height": expiry + 1, "txs": [] }));
    let mut lied_to = a.clone();
    lied_to.scan(&lie(lied_to.next_height()), &alice.scan_key()).unwrap();
    assert_eq!(lied_to.scanned_height(), Some(expiry), "the wallet has 'scanned' past the expiry");
    let mut rescanning = a.fresh_for_rescan();
    assert!(rescanning.scan(&lie(expiry), &alice.scan_key()).is_ok(), "an empty tree accepts a page that starts anywhere above");
    for (what, mut w) in [("continuing state", lied_to), ("state from fresh_for_rescan", rescanning)] {
        assert_eq!(w.resolve().still_pending, 1, "{what}: not released by one page");
        let echoed = echo(&w, "the-node");
        assert!(w.confirm_state(&[echoed.clone(), echoed]).unwrap().matched_height.is_none(), "{what}: one node, twice, is one node");
        // honest nodes are at the real height
        let c = w.confirm_state(&chain.state_reports()).unwrap();
        assert!(c.confirmed_height.unwrap_or(0) < expiry, "{what}");
        let r = w.resolve();
        assert_eq!((r.expired.len(), r.still_pending), (0, 1), "{what}: still pending");
        assert!(w.pending()[0].rejected_hint, "{what}: the 'rejected' answer is a hint and nothing else");
    }

    // t1 is as valid as it was, and the node has it mined
    let mut real = base(&alice.address(), &[10 * Q]);
    assert!(real.height < expiry);
    real.block(&[&t1.body]).expect("t1 is mined on the real chain");
    a.scan(&real.page(a.next_height()), &alice.scan_key()).unwrap();
    confirm(&real, &mut a);
    assert_eq!(a.resolve().mined.len(), 1);
    assert_eq!((a.balance(), synced(&real, &bob).balance()), (5 * Q as u128, 4 * Q as u128));
}

// ---------------------------------------------------------------------------------------------------
// Checked and found sound
// ---------------------------------------------------------------------------------------------------

/// The expiry comparison against the node's rule (`daemon/src/shield_v2.rs`: refused iff
/// `expiry_height < block height`, i.e. the last valid height is `expiry_height` itself): the
/// wallet releases when the CONFIRMED height is at or above the expiry, never one block early,
/// also through a JSON round-trip and a rescan — and never on the scanned height alone.
#[test]
fn rw2_sound_the_release_height_is_exactly_the_first_height_at_which_the_node_refuses() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = base(&alice.address(), &[10 * Q]);
    let mut a = synced(&chain, &alice);
    configure_as_sole_copy(&mut a, &[NODE_A, NODE_B, "the-node"]); // a NEW wallet: the user says so, and it spends at once
    confirm(&chain, &mut a);
    let pos = position_of(&a, 10 * Q);
    let t1 = transfer(&a, &alice, &[pos], &bob.address(), 4 * Q, "rw2-sound-expiry");
    let record = t1.pending().unwrap();
    let expiry = record.expiry_height;
    a.mark_pending(record.clone()).unwrap();
    assert!(a.mark_pending(record.clone()).is_err(), "not twice");

    chain.advance_to(expiry - 1);
    a.scan(&chain.page(a.next_height()), &alice.scan_key()).unwrap();
    confirm(&chain, &mut a);
    a = WalletState::from_json(&a.to_json().unwrap()).unwrap();
    assert_eq!(a.clone().resolve().still_pending, 1, "confirmed to expiry - 1: block `expiry` can still hold it");
    let mut rescanned = a.fresh_for_rescan();
    rescanned.scan(&chain.page(0), &alice.scan_key()).unwrap();
    confirm(&chain, &mut rescanned);
    assert!(rescanned.is_locked(pos) && rescanned.resolve().still_pending == 1);
    assert!(matches!(select_inputs_with(&a, 4 * Q, Q, true), Err(WalletError::InsufficientFunds { .. })));

    chain.advance_to(expiry);
    a.scan(&chain.page(a.next_height()), &alice.scan_key()).unwrap();
    assert_eq!(a.clone().resolve().still_pending, 1, "the quorum has not confirmed that height yet");
    confirm(&chain, &mut a);
    assert_eq!(a.resolve().expired.len(), 1);
    // the balances never count a note twice
    let b = a.balances();
    assert_eq!((b.confirmed, b.unverified, b.locked, b.spendable, b.expected_change), (10 * Q as u128, 0, 0, 10 * Q as u128, 0));
}

/// The address text (F-2): 1,225 bytes are exactly 1,960 five-bit characters, so there are no
/// padding bits to vary; the only strings that decode without being the encoder's output are the
/// all-upper-case form and surrounding white space (both BIP-350 practice), and both re-encode to
/// the canonical string. Mixed case, inner white space and a line break in the middle are refused.
#[test]
fn rw2_sound_the_address_decoder_accepts_the_canonical_string_its_upper_case_and_nothing_else() {
    assert_eq!((ADDRESS_TEXT_BYTES * 8) % 5, 0, "no padding bits");
    assert_eq!(ADDRESS_TEXT_CHARS, 8 + ADDRESS_TEXT_BYTES * 8 / 5 + 6);
    let addr = keys(PHRASE_1).address();
    let s = addr.encode();
    assert_eq!(s.len(), ADDRESS_TEXT_CHARS);
    for variant in [s.clone(), s.to_ascii_uppercase(), format!(" \t{s}\r\n")] {
        let d = ShieldedAddress::decode(&variant).unwrap();
        assert_eq!(d.encode(), s);
    }
    let mut mixed = s.clone().into_bytes();
    let i = mixed.iter().rposition(|b| b.is_ascii_lowercase()).unwrap();
    mixed[i] = mixed[i].to_ascii_uppercase();
    assert!(ShieldedAddress::decode(core::str::from_utf8(&mixed).unwrap()).is_err());
    for cut in [8usize, 700, 1_900] {
        assert!(ShieldedAddress::decode(&format!("{}\n{}", &s[..cut], &s[cut..])).is_err(), "a wrapped address is refused, not repaired");
        assert!(ShieldedAddress::decode(&format!("{} {}", &s[..cut], &s[cut..])).is_err());
    }
    // every single-character change in a sample of positions, to every other character
    let alphabet = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    for i in (8..s.len()).step_by(37) {
        for &c in alphabet {
            if s.as_bytes()[i] != c {
                let mut t = s.clone().into_bytes();
                t[i] = c;
                assert!(ShieldedAddress::decode(core::str::from_utf8(&t).unwrap()).is_err());
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------
// RW2-7 (Low) — dust flooding
// ---------------------------------------------------------------------------------------------------

/// Notes below the state's minimum note value (default: the minimum fee) are counted and not
/// stored: a flood of them does not grow the state at all. Notes at or above it are stored
/// compactly — one record and two to three shared tree nodes each instead of 32 path digests — and
/// whatever a state holds, `from_json` reads what `to_json` wrote. The figures of the report
/// (bytes per stored note, the sender's cost per megabyte) are printed and bounded here.
#[test]
fn rw2_f7_dust_is_counted_not_stored_and_a_stored_note_costs_a_quarter_of_what_it_did() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let n = 40usize;
    // the same number of blocks and transactions, the dust sent to somebody else
    let mut quiet = base(&alice.address(), &[Q]);
    fund(&mut quiet, &bob.address(), &vec![1u64; n]);
    let before = synced(&quiet, &alice);
    let mut chain = base(&alice.address(), &[Q]);
    fund(&mut chain, &alice.address(), &vec![1u64; n]); // 1 quantum each, to Alice
    let mut flooded = synced(&chain, &alice);
    assert_eq!((flooded.notes().len(), flooded.below_minimum().count, flooded.below_minimum().total), (1, n as u64, n as u128));
    assert_eq!(flooded.tree().tracked(), 1, "no path is tracked for them either");
    let grown = flooded.to_json().unwrap().len() as i64 - before.to_json().unwrap().len() as i64;
    assert!((0..16).contains(&grown), "{n} dust notes grew the state by {grown} bytes: two counters");
    confirm(&chain, &mut flooded);
    assert_eq!((flooded.balance(), flooded.balances().confirmed), (Q as u128, Q as u128), "dust is in no balance");
    // a state that asks for every note (`min_note_value = 1`) has them
    let mut all = WalletState::with_min_note_value(alice.address().pk, 1).unwrap();
    all.scan(&chain.page(0), &alice.scan_key()).unwrap();
    assert_eq!((all.notes().len(), all.below_minimum().count, all.balance()), (n + 1, 0, Q as u128 + n as u128));

    // what a note that IS stored costs: n notes of exactly the minimum note value, against a
    // state of the same chain that stores none of them
    let n = 240usize;
    let mut worth = base(&alice.address(), &[Q]);
    fund(&mut worth, &alice.address(), &vec![Q; n]);
    let stored = synced(&worth, &alice);
    let mut skipping = WalletState::with_min_note_value(alice.address().pk, 2 * Q).unwrap();
    skipping.scan(&worth.page(0), &alice.scan_key()).unwrap();
    assert_eq!((stored.notes().len(), skipping.notes().len()), (n + 1, 0));
    let per_note = (stored.to_json().unwrap().len() - skipping.to_json().unwrap().len()) / (n + 1);
    let nodes_per_note = stored.tree().stored_nodes() as f64 / (n + 1) as f64;
    // its sender pays at least the minimum note value, which the victim RECEIVES, plus half a
    // fee (two outputs per transaction)
    let notes_per_mb = 1_000_000 / per_note;
    println!(
        "rw2: {per_note} bytes of state JSON per stored note ({nodes_per_note:.2} tree nodes each; was 2,718 bytes); with the default minimum note value \
         1 MB of victim state = {notes_per_mb} notes = {} XRGE in fees + {notes_per_mb} XRGE handed to the victim",
        notes_per_mb / 2
    );
    assert!(per_note < 640, "{per_note}");
    // one note per transaction (every other leaf): n nodes at each of the two lowest levels, then
    // n/2, n/4, …: three per note; two when both outputs of a transaction are the wallet's
    assert!(stored.tree().stored_nodes() <= 3 * (n + 1) + 32, "{nodes_per_note}");
    // what to_json writes, from_json reads — and every path still leads to the chain's root
    let back = WalletState::from_json(&stored.to_json().unwrap()).unwrap();
    assert_eq!(back, stored);
    let root = digest_from_bytes(&worth.state().tree_root).unwrap();
    for note in back.unspent() {
        let path = back.tree().path(note.position).unwrap();
        let path: [_; 32] = core::array::from_fn(|i| digest_from_bytes(&path[i]).unwrap());
        assert_eq!(quantum_vault_shield_v2::reference::root_from_path(&digest_from_bytes(&note.cm.0).unwrap(), note.position as u32, &path), root);
    }
    // the threshold is the state's for life, and a rescan can change it
    assert_eq!(flooded.fresh_for_rescan().min_note_value(), DEFAULT_MIN_NOTE_VALUE);
    assert_eq!(flooded.fresh_for_rescan_with_min_note_value(1).unwrap().min_note_value(), 1);
}

/// Spent notes are dropped from the state once their spend is confirmed and more than the
/// retention window below the confirmed height — into a running total. Every balance is exactly
/// what it was, the state is smaller, it survives JSON, and a rescan gives the same balances.
#[test]
fn rw2_f7_pruning_spent_notes_keeps_every_balance_exact() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = base(&alice.address(), &[2 * Q, 3 * Q, 4 * Q, 5 * Q, 6 * Q, 7 * Q]);
    let mut a = synced(&chain, &alice);
    configure_as_sole_copy(&mut a, &[NODE_A, NODE_B, "the-node"]); // a NEW wallet: the user says so, and it spends at once
    confirm(&chain, &mut a);
    // two payments: 2+3 (change 0, not stored) and 4 (change 1)
    for (i, (positions, amount)) in [(vec![position_of(&a, 2 * Q), position_of(&a, 3 * Q)], 4 * Q), (vec![position_of(&a, 4 * Q)], 2 * Q)].into_iter().enumerate() {
        let t = transfer(&a, &alice, &positions, &bob.address(), amount, &format!("rw2-f7-prune-{i}"));
        a.mark_pending(t.pending().unwrap()).unwrap();
        chain.block(&[&t.body]).unwrap();
        a.scan(&chain.page(a.next_height()), &alice.scan_key()).unwrap();
        confirm(&chain, &mut a);
        assert_eq!(a.resolve().mined.len(), 1);
    }
    let (first_spent_at, spent_at) = (chain.height - 1, chain.height);
    let expected = (5 + 6 + 7 + 1) * Q as u128;
    assert_eq!((a.notes().len(), a.balance(), a.pruned().count), (7, expected, 0));
    let size_before = a.to_json().unwrap().len();
    let balances_before = a.balances();

    // not yet: the spends are inside the retention window
    chain.advance_to(first_spent_at + PRUNE_RETENTION_BLOCKS - 1);
    a.scan(&chain.page(a.next_height()), &alice.scan_key()).unwrap();
    assert_eq!(a.confirm_state(&chain.state_reports()).unwrap().pruned, 0);
    // scanned beyond the window is not enough: pruning follows the CONFIRMED height
    chain.advance_to(spent_at + PRUNE_RETENTION_BLOCKS);
    a.scan(&chain.page(a.next_height()), &alice.scan_key()).unwrap();
    assert_eq!(a.notes().len(), 7);
    let c = a.confirm_state(&chain.state_reports()).unwrap();
    assert_eq!((c.pruned, a.notes().len()), (3, 4));
    assert_eq!((a.pruned().count, a.pruned().total), (3, 9 * Q as u128), "2 + 3 + 4 XRGE of spent notes, as a total");
    assert_eq!(a.balances(), balances_before, "every balance is exactly what it was");
    assert_eq!(a.balance(), expected);
    assert!(a.to_json().unwrap().len() < size_before);
    let back = WalletState::from_json(&a.to_json().unwrap()).unwrap();
    assert_eq!(back, a);
    // the remaining notes are spendable against the chain's root
    let sel = select_inputs(&a, 11 * Q, Q).unwrap();
    assert_eq!((sel.positions.len(), sel.total), (2, 12 * Q));
    let t = transfer(&a, &alice, &sel.positions, &bob.address(), 11 * Q, "rw2-f7-after-prune");
    chain.block(&[&t.body]).expect("paths of the kept notes are intact");
    // a rescan finds the spent notes again, prunes them again, and agrees on every balance
    let mut again = a.fresh_for_rescan();
    again.scan(&parse(&chain.page_value(0, a.scanned_height().unwrap())), &alice.scan_key()).unwrap();
    assert_eq!(again.notes().len(), 7);
    configure(&mut again, &["x", "y"]);
    assert_eq!(again.confirm_state(&[echo(&again, "x"), echo(&again, "y")]).unwrap().pruned, 3);
    assert_eq!(again.balances(), a.balances());
    assert_eq!(again.pruned(), a.pruned());
}

// ---------------------------------------------------------------------------------------------------
// State format 3: the revision (I-3), unverified inputs (I-4), locks by commitment (I-5), and the
// migration from format 2
// ---------------------------------------------------------------------------------------------------

/// I-3: every change of a state raises its revision; a writer that holds an older copy than the
/// stored one is refused before it changes anything. (Two tabs that each load revision N and
/// each record a pending transaction: the second one's `expect_revision(N + 1)` — the revision
/// it reads from storage — fails, instead of its write dropping the first one's lock.)
#[test]
fn rw2_i3_a_stale_copy_is_refused_by_its_revision() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let chain = base(&alice.address(), &[3 * Q, 4 * Q]);
    let mut stored = synced(&chain, &alice);
    configure_as_sole_copy(&mut stored, &[NODE_A, NODE_B, "the-node"]); // a NEW wallet: the user says so, and it spends at once
    let r0 = stored.revision();
    confirm(&chain, &mut stored);
    assert_eq!(stored.revision(), r0 + 1);
    // two tabs load the same stored state
    let (mut tab_1, mut tab_2) = (stored.clone(), stored.clone());
    let t1 = transfer(&tab_1, &alice, &[position_of(&tab_1, 3 * Q)], &bob.address(), Q, "rw2-i3-1");
    tab_1.expect_revision(stored.revision()).unwrap();
    tab_1.mark_pending(t1.pending().unwrap()).unwrap();
    assert_eq!(tab_1.revision(), stored.revision() + 1);
    stored = tab_1.clone(); // tab 1 persists
    // tab 2 still holds the old copy; the stored revision is not its own
    let t2 = transfer(&tab_2, &alice, &[position_of(&tab_2, 3 * Q)], &bob.address(), Q, "rw2-i3-2");
    assert!(matches!(tab_2.expect_revision(stored.revision()), Err(WalletError::StaleState)), "the second writer is refused");
    // had it not asked, its own state would have taken the same note a second time
    assert!(tab_2.mark_pending(t2.pending().unwrap()).is_ok());
    // after a reload the lock of tab 1 is there
    let mut tab_2 = stored.clone();
    tab_2.expect_revision(stored.revision()).unwrap();
    assert!(matches!(tab_2.spend_input(position_of(&tab_2, 3 * Q)), Err(WalletError::NoteLocked)));
    assert!(tab_2.mark_pending(t2.pending().unwrap()).is_err());
    // every changing call raises it; a call that changes nothing does not
    let r = tab_2.revision();
    assert!(!tab_2.note_rejection_hint(&[7u8; 32]));
    assert_eq!((tab_2.resolve().still_pending, tab_2.revision()), (1, r));
    assert!(tab_2.note_rejection_hint(&t1.pending().unwrap().nullifiers[0].0));
    assert_eq!(tab_2.revision(), r + 1);
    assert_eq!(tab_2.fresh_for_rescan().revision(), r + 2, "a rescan continues the count");
    assert_eq!(WalletState::from_json(&tab_2.to_json().unwrap()).unwrap().revision(), r + 1);
}

/// I-4 and I-5: a note that is not confirmed is not handed to a builder without the caller's
/// explicit flag; and a lock is held by the note's commitment, so it sits on the same NOTE after a
/// rescan onto a listing in which the note has another position.
#[test]
fn rw2_i4_i5_unverified_inputs_need_the_flag_and_locks_follow_the_note() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let chain = base(&alice.address(), &[3 * Q, 4 * Q]);
    let mut a = synced(&chain, &alice);
    configure_as_sole_copy(&mut a, &[NODE_A, NODE_B, "the-node"]); // a NEW wallet: the user says so, and it spends at once
    let pos3 = position_of(&a, 3 * Q);
    assert!(matches!(a.spend_input(pos3), Err(WalletError::NoteUnverified)));
    assert!(a.spend_input_with(pos3, true).is_ok(), "the caller's explicit decision");
    confirm(&chain, &mut a);
    assert!(a.spend_input(pos3).is_ok());
    let t = transfer(&a, &alice, &[pos3], &bob.address(), Q, "rw2-i5");
    a.mark_pending(t.pending().unwrap()).unwrap();
    assert_eq!(a.pending()[0].input_cms, vec![a.note_at(pos3).unwrap().cm]);

    // a listing with one more transaction in front: every position is two higher
    let key = fake_account_key(3);
    let extra = deterministic::shield(
        &ShieldRequest { ctx: chain.ctx(), from_pub_key: &key, nonce: 1, v_in: 2 * Q, fee: Q, recipient: &bob.address(), max_fee: None },
        "rw2-i5-extra",
    )
    .unwrap();
    let mut page = chain.page_value(0, chain.height);
    let txs = page["txs"].as_array_mut().unwrap();
    for t in txs.iter_mut() {
        for o in t["outputs"].as_array_mut().unwrap() {
            o["leaf"] = serde_json::json!(o["leaf"].as_u64().unwrap() + 2);
        }
    }
    let first_height = txs[0]["height"].as_u64().unwrap();
    txs.insert(0, listing_entry(&extra.body, first_height, 0, 0));
    txs[1]["index"] = serde_json::json!(1);
    let mut moved = a.fresh_for_rescan();
    moved.scan(&parse(&page), &alice.scan_key()).unwrap();
    let (new3, new4) = (position_of(&moved, 3 * Q), position_of(&moved, 4 * Q));
    assert_eq!((new3, new4), (pos3 + 2, position_of(&a, 4 * Q) + 2));
    assert!(moved.is_locked(new3), "the lock is on the 3 XRGE note, wherever it sits");
    assert!(!moved.is_locked(new4), "and not on whatever note has the old position");
    assert_eq!(moved.pending()[0].inputs, vec![new3]);
}

/// A state in format 2 (60d1e2b) is migrated to format 3: an empty state to rescan that keeps
/// every pending entry as pending and LOCKED — also the one format 2 had called `mined` on one
/// node's word (RW2-1). The entries have both nullifiers and the change commitment: on the
/// rescanned, confirmed chain one settles as mined (it really was), the other as expired.
#[test]
fn rw2_a_format_2_state_is_migrated_with_every_pending_entry_locked() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = base(&alice.address(), &[3 * Q, 4 * Q]);
    let mut now = synced(&chain, &alice);
    confirm(&chain, &mut now);
    let (pos3, pos4) = (position_of(&now, 3 * Q), position_of(&now, 4 * Q));
    let ta = transfer(&now, &alice, &[pos3], &bob.address(), Q, "rw2-v2-a");
    let tb = transfer(&now, &alice, &[pos4], &bob.address(), Q, "rw2-v2-b");
    let v2_entry = |t: &UnprovenTx, status: &str| {
        let p = t.pending().unwrap();
        serde_json::json!({
            "tx_type": p.tx_type, "nullifiers": p.nullifiers, "inputs": p.inputs, "input_total": p.input_total.to_string(),
            "change": p.change.as_ref().map(|c| serde_json::json!({ "cm": c.cm, "value": c.value.to_string() })),
            "expiry_height": p.expiry_height, "status": status, "mined_height": if status == "mined" { serde_json::json!(now.next_height()) } else { serde_json::Value::Null },
            "rejected_hint": false,
        })
    };
    let empty = WalletState::new(alice.address().pk);
    let v2 = serde_json::json!({
        "version": 2, "pk": hex::encode(alice.address().pk), "next_height": now.next_height() + 1,
        "tree": { "note_count": 4, "frontier": empty.tree().frontier().iter().map(hex::encode).collect::<Vec<_>>(), "root": hex::encode(now.anchor()), "witnesses": {} },
        "notes": now.notes().iter().map(|n| serde_json::json!({
            "value": n.value.to_string(), "r": n.r, "rho": n.rho, "position": n.position, "cm": n.cm, "nullifier": n.nullifier,
            // format 2 marked the inputs of a "mined" entry spent
            "spent": n.position == pos3, "spent_height": if n.position == pos3 { serde_json::json!(now.next_height()) } else { serde_json::Value::Null },
            "height": n.height, "tx_hash": n.tx_hash, "output_index": n.output_index, "confirmed": true,
        })).collect::<Vec<_>>(),
        "pending": [v2_entry(&ta, "mined"), v2_entry(&tb, "pending")],
        "checkpoints": [{ "height": now.next_height(), "root": hex::encode(now.anchor()) }],
        "confirmed_height": now.next_height(), "blind": { "seen": [], "overflow": false },
    });
    let mut m = WalletState::from_json(&v2.to_string()).unwrap();
    assert_eq!((m.next_height(), m.notes().len(), m.confirmed_height(), m.pending().len()), (0, 0, None, 2));
    assert!(m.pending().iter().all(|p| p.status == PendingStatus::Pending && p.seen_height.is_none() && !p.legacy && p.outputs.is_empty()));
    assert_eq!(m.pending()[0].input_cms, vec![now.note_at(pos3).unwrap().cm]);
    assert!(m.to_json().unwrap().contains("\"version\":5"));

    // the truth: ta was mined after all, tb never
    chain.block(&[&ta.body]).unwrap();
    m.scan(&chain.page(0), &alice.scan_key()).unwrap();
    assert!(m.is_locked(pos4) && m.note_at(pos3).unwrap().spent);
    confirm(&chain, &mut m);
    let r = m.resolve();
    assert_eq!((r.mined.len(), r.still_pending), (1, 1), "its nullifier pair with its change commitment, confirmed");
    assert_eq!(r.mined[0].nullifiers, ta.pending().unwrap().nullifiers);
    chain.advance_to(tb.pending().unwrap().expiry_height);
    m.scan(&chain.page(m.next_height()), &alice.scan_key()).unwrap();
    confirm(&chain, &mut m);
    assert_eq!(m.resolve().expired.len(), 1);
    assert_eq!((m.balance(), m.balances().spendable), (5 * Q as u128, 5 * Q as u128), "4 + the change of 1");
}
