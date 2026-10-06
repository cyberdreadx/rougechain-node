//! REVIEW_WALLET_2 — second independent review, of the code ADDED to answer REVIEW_WALLET_1
//! (see `REVIEW_WALLET_2.md`). Reviewed: `origin/main` @60d1e2b.
//!
//! * `rw2_fN_…` — **regression tests of confirmed defects. They FAIL on 60d1e2b on purpose** and
//!   are meant to pass once the defect is fixed. Each says what it expects.
//! * `rw2_demo_…` — a documented design limit shown to be real (passes: it asserts what happens).
//! * `rw2_sound_…` / `rw2_info_…` — an attack that was tried and does not work, or a measurement.
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

fn synced(chain: &Chain, keys: &ShieldedKeys) -> WalletState {
    let mut s = WalletState::new(keys.address().pk);
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

fn page_json(page: &ListingPage) -> serde_json::Value {
    serde_json::json!({
        "active": page.active, "tip_height": page.tip_height, "from_height": page.from_height, "next_height": page.next_height,
        "txs": page.txs.iter().map(|t| serde_json::json!({
            "height": t.height, "index": t.index, "tx_hash": t.tx_hash, "tx_type": t.tx_type, "nf1": t.nf1, "nf2": t.nf2,
            "outputs": t.outputs.iter().map(|o| serde_json::json!({ "cm_out": o.cm_out, "leaf": o.leaf, "kem_ct": o.kem_ct, "note_ct": o.note_ct })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    })
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
// RW2-1 (High) — "mined" is decided by ONE node's listing, under every release policy, and the
// rescan that the wallet is told to do afterwards starts with the inputs UNLOCKED while the
// transaction is still valid. The double payment of REVIEW_WALLET_1 F-7 is back, for the same
// attacker (the one node the wallet submits to and scans from), against an honest quorum.
// ---------------------------------------------------------------------------------------------------

/// Alice holds one 10 XRGE note and pays Bob 4 (`t1`, recorded with `mark_pending` first). The
/// node she uses keeps `t1` and LISTS it as mined — a listing costs it nothing. `scan` marks the
/// pending entry mined and the note spent on that node's word alone.
///
/// Alice's wallet then does everything `NOTES.md` §6 prescribes: it asks two honest nodes for
/// their roots (`diverged` — the listing was not the chain's), settles the pending list under the
/// STRICT policy (`ReleasePolicy::Confirmed`), and rebuilds from `fresh_for_rescan` against an
/// honest node. On the real chain `t1` was never mined: the 10 note is unspent. And it is
/// unlocked — in both orders of the two calls:
///
/// * `resolve` first: the entry is handed back under `mined` and removed, although its
///   `mined_height` was never confirmed by anybody; the rebuilt state has no pending entry;
/// * rescan first: `fresh_for_rescan` copies the entry with `status: mined`; a mined entry locks
///   nothing, and nothing ever sets it back to pending.
///
/// `t1` is valid until its expiry height (64 blocks). Alice sees the payment gone and her note
/// back, pays Bob again — coin selection takes a 5 XRGE note that arrived meanwhile — and the
/// node then releases `t1`. Both are mined: Bob holds 8.
///
/// Expected after a fix: while the scanned (or, under `Confirmed`, the confirmed) chain has not
/// passed `t1`'s expiry height and does not contain it, `t1` is still a PENDING entry of the
/// rebuilt state and its input is locked. FAILS on 60d1e2b.
#[test]
fn rw2_f1_a_listing_that_shows_the_pending_tx_mined_unlocks_its_inputs_after_the_prescribed_rescan() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let honest0 = base(&alice.address(), &[10 * Q]);
    let mut a = synced(&honest0, &alice);
    confirm(&honest0, &mut a);
    let t1 = transfer(&a, &alice, &[position_of(&a, 10 * Q)], &bob.address(), 4 * Q, "rw2-f1-t1");
    let record = t1.pending().unwrap();
    let expiry = record.expiry_height.unwrap();
    assert_eq!(expiry, honest0.height + DEFAULT_EXPIRY_OFFSET);
    a.mark_pending(record.clone()).unwrap();

    // the node Alice submits to keeps t1 and serves a listing in which it is mined
    let mut liar = base(&alice.address(), &[10 * Q]);
    liar.block(&[&t1.body]).unwrap();
    let rep = a.scan(&liar.page(a.next_height()), &alice.scan_key()).unwrap();
    assert_eq!(rep.pending_mined, 1, "one node's listing is enough to call it mined");

    // the real chain: the same height, t1 is in no block
    let mut honest = base(&alice.address(), &[10 * Q]);
    honest.advance_to(liar.height);
    let c = a.confirm_roots(&honest.root_reports(), DEFAULT_CONFIRM_QUORUM).unwrap();
    assert!(c.diverged && c.matched_height.is_none(), "two honest nodes say: this listing is not the chain");
    assert!(a.confirmed_height().unwrap() < liar.height, "nobody confirmed the height at which t1 is 'mined'");

    // the two orders in which a client can run the documented recovery
    let mut resolved_first = a.clone();
    let r = resolved_first.resolve(ReleasePolicy::Confirmed);
    let handed_back_as_mined = r.mined.len();
    let resolved_first = resolved_first.fresh_for_rescan();
    let rescan_first = a.fresh_for_rescan();

    let mut verdicts = Vec::new();
    for (name, start) in [("resolve(Confirmed) then rescan", resolved_first), ("rescan then resolve", rescan_first)] {
        // a copy of the real chain per variant
        let mut real = base(&alice.address(), &[10 * Q]);
        real.advance_to(liar.height);
        let mut w = start;
        w.scan(&real.page(0), &alice.scan_key()).unwrap();
        confirm(&real, &mut w);
        w.resolve(ReleasePolicy::Confirmed);
        let pos10 = position_of(&w, 10 * Q);
        assert!(real.height < expiry, "t1 is still valid on the real chain");
        let locked = w.is_locked(pos10) && w.pending().iter().any(|p| p.status == PendingStatus::Pending && p.nullifiers == record.nullifiers);

        // what the unlocked state lets happen: 5 XRGE arrive, Alice pays Bob again, the node
        // releases t1
        fund(&mut real, &alice.address(), &[5 * Q]);
        w.scan(&real.page(w.next_height()), &alice.scan_key()).unwrap();
        confirm(&real, &mut w);
        let mut bob_holds = 0u128;
        if let Ok(sel) = select_inputs(&w, 4 * Q, Q) {
            let t2 = transfer(&w, &alice, &sel.positions, &bob.address(), 4 * Q, "rw2-f1-t2");
            if w.mark_pending(t2.pending().unwrap()).is_ok() {
                real.block(&[&t2.body]).expect("the retry is mined");
            }
        }
        if real.block(&[&t1.body]).is_ok() {
            bob_holds = synced(&real, &bob).balance();
        }
        verdicts.push((name, locked, bob_holds / Q as u128));
    }
    let summary: Vec<String> = verdicts
        .iter()
        .map(|(name, locked, bob_xrge)| format!("[{name}: t1 still pending and its input locked = {locked}; after Alice's retry and the node's release of t1 Bob holds {bob_xrge} XRGE]"))
        .collect();
    assert!(
        handed_back_as_mined == 0 && verdicts.iter().all(|v| v.1),
        "t1 is valid until height {expiry} and is not on the chain, yet: resolve(Confirmed) handed {handed_back_as_mined} entry back as MINED at a height no quorum confirmed; {}",
        summary.join(" ")
    );
}

// ---------------------------------------------------------------------------------------------------
// RW2-2 (High) — `ReleasePolicy::Confirmed` is defeated by one lying LISTING node while the
// quorum is honest: the tree root commits the output commitments, not the nullifiers, and the
// release looks at nullifiers only.
// ---------------------------------------------------------------------------------------------------

/// `t1` (Alice pays Bob 4 from her 10 note) is really mined. The node Alice scans from serves the
/// real block with `t1`'s two nullifiers replaced by other values and leaves the commitments
/// alone. The wallet's tree is then the real tree: two honest nodes confirm its root at every
/// height. But the wallet has not seen `t1`'s nullifiers, so
///
/// * the 10 note is still "unspent" and confirmed, and the 5 XRGE change — whose `rho` is derived
///   from the nullifiers — does not pass the recipient check and is not found;
/// * at the expiry height, `resolve(Confirmed)` declares `t1` EXPIRED ("it can never be mined")
///   and releases its input — while the confirmed tree contains `t1`'s change commitment, which
///   the pending record holds (`change.cm`) and nothing ever compares.
///
/// The UI now says "expired — your funds are back, try again". Bob was paid. A retry from any
/// other note pays him twice (a retry from the 10 note is refused by the chain).
///
/// Expected after a fix: a pending transaction whose expected change commitment is among the
/// commitments the wallet appended is MINED, whatever nullifiers the listing shows; it is never
/// reported expired. FAILS on 60d1e2b.
#[test]
fn rw2_f2_confirmed_release_declares_a_mined_tx_expired_when_the_listing_node_swaps_its_nullifiers() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = base(&alice.address(), &[10 * Q]);
    let mut a = synced(&chain, &alice);
    confirm(&chain, &mut a);
    let t1 = transfer(&a, &alice, &[position_of(&a, 10 * Q)], &bob.address(), 4 * Q, "rw2-f2-t1");
    let record = t1.pending().unwrap();
    let expiry = record.expiry_height.unwrap();
    let change_cm = record.change.as_ref().unwrap().cm;
    a.mark_pending(record.clone()).unwrap();

    chain.block(&[&t1.body]).expect("t1 is mined");
    chain.advance_to(expiry);
    assert_eq!(synced(&chain, &bob).balance(), 4 * Q as u128, "Bob was paid");

    // the listing node: the real blocks, t1's nullifiers swapped for two other canonical digests
    let mut page = page_json(&chain.page(a.next_height()));
    let listed = page["txs"].as_array_mut().unwrap();
    assert_eq!(listed.len(), 1);
    assert!(listed[0]["outputs"].as_array().unwrap().iter().any(|o| o["cm_out"] == hex::encode(change_cm.0)), "the change commitment is in the listing");
    listed[0]["nf1"] = serde_json::json!(hex::encode(digest_bytes(0x51)));
    listed[0]["nf2"] = serde_json::json!(hex::encode(digest_bytes(0x52)));
    let rep = a.scan(&ListingPage::from_json(&page.to_string()).unwrap(), &alice.scan_key()).unwrap();
    assert_eq!((rep.pending_mined, rep.received.len()), (0, 0), "the wallet saw neither the spend nor its change");

    // two honest nodes agree with the wallet's root at the tip: the commitments are all there
    confirm(&chain, &mut a);
    assert_eq!(a.confirmed_height(), Some(chain.height));
    assert!(chain.height >= expiry);
    let shown = a.balances();
    let r = a.resolve(ReleasePolicy::Confirmed);
    assert!(
        r.expired.is_empty(),
        "resolve(Confirmed) declared a MINED transaction expired and released its input: the wallet shows {} XRGE confirmed ({} on chain), Bob already holds 4, and the UI is told a retry is safe",
        shown.confirmed / Q as u128,
        synced(&chain, &alice).balance() / Q as u128,
    );
    assert_eq!(r.mined.len(), 1, "its change commitment is in the confirmed tree: it was mined");
}

// ---------------------------------------------------------------------------------------------------
// RW2-3 (Medium) — a pending transaction is called mined when ANY transaction spends ONE of its
// inputs, and then every input is marked spent. Two devices on one recovery phrase (site,
// extension, Qwalla) are enough; no node has to lie.
// ---------------------------------------------------------------------------------------------------

/// Alice has a 3 and a 4 XRGE note and the same phrase on two devices. Device A builds `t1` from
/// BOTH notes (5 to Bob) and records it. Before `t1` is mined, device B — which knows nothing of
/// A's lock — pays 1 XRGE from the 3 note; that transaction is mined, and `t1` is now invalid for
/// ever (one of its nullifiers is spent).
///
/// Device A's scan sees the 3 note's nullifier, concludes "`t1` was mined" and marks BOTH inputs
/// spent — also the 4 XRGE note, whose nullifier is on no chain. A shows 1 XRGE; the chain holds
/// 5 for Alice. `t1` is reported to the UI under `mined` ("paid Bob 5"); Bob received 1. Nothing
/// tells the wallet to rescan: its root is correct.
///
/// Expected after a fix: a note is marked spent only when ITS nullifier appears (or when the
/// pending transaction is known mined by its own outputs); a pending transaction one of whose
/// inputs was spent by another transaction is reported as failed, not mined. FAILS on 60d1e2b.
#[test]
fn rw2_f3_another_transaction_spending_one_input_makes_the_pending_tx_mined_and_the_other_input_spent() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = base(&alice.address(), &[3 * Q, 4 * Q]);
    let mut device_a = synced(&chain, &alice);
    let mut device_b = synced(&chain, &alice);
    confirm(&chain, &mut device_a);
    confirm(&chain, &mut device_b);
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

    device_a.scan(&chain.page(device_a.next_height()), &alice.scan_key()).unwrap();
    confirm(&chain, &mut device_a);
    let truth = synced(&chain, &alice).balance();
    assert_eq!(truth, 5 * Q as u128, "on chain: the 4 note and 1 change");
    let note4_spent = device_a.note_at(pos4).unwrap().spent;
    let r = device_a.resolve(ReleasePolicy::Confirmed);
    assert!(
        !note4_spent && r.mined.is_empty() && device_a.balance() == truth,
        "device A calls t1 mined ({} entry under `mined`) although neither its second nullifier nor its change commitment is on the chain; the 4 XRGE note is marked spent: {}; A shows {} XRGE, the chain holds {}",
        r.mined.len(),
        note4_spent,
        device_a.balance() / Q as u128,
        truth / Q as u128,
    );
}

// ---------------------------------------------------------------------------------------------------
// RW2-4 (Low) — `confirm_roots` confirms notes in the very call that reports `diverged`
// ---------------------------------------------------------------------------------------------------

/// The forged note of REVIEW_WALLET_1 F-1 again (made from the victim's public address alone).
/// The quorum is an absolute count (default 2) whatever the number of nodes asked, and a
/// conflicting quorum does not stop the confirmation. Four nodes are asked: two — one operator
/// under two names, which the notes accept as a limit — vouch for the forged tree; two honest
/// ones report the real root. The same call returns `diverged: true` AND moves the forged
/// 1,000,000 XRGE into the confirmed, spendable balance. The same happens when the honest nodes
/// answer one block earlier than the liar (the ordinary case: nodes are not at one height).
///
/// Expected after a fix: when at least `quorum` distinct nodes report a root that is not the
/// wallet's at a height the wallet can compare, nothing is confirmed by that call (and a caller
/// can ask for a majority of the nodes it asked). FAILS on 60d1e2b.
#[test]
fn rw2_f4_confirm_roots_confirms_a_forged_note_in_the_call_that_reports_diverged() {
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
    forged.scan(&ListingPage::from_json(&page.to_string()).unwrap(), &alice.scan_key()).unwrap();
    let lying_root = forged.anchor();
    let real_root = WalletState::new(address.pk).anchor(); // the real pool is empty
    let report = |id: &str, height: u64, root: [u8; 32]| RootReport { node_id: id.to_string(), height, root };

    for (what, honest_height) in [("the honest nodes at the same height", 10u64), ("the honest nodes one block behind", 9)] {
        let mut w = forged.clone();
        let c = w
            .confirm_roots(
                &[
                    report("liar", 10, lying_root),
                    report("liar-again", 10, lying_root),
                    report("honest-1", honest_height, real_root),
                    report("honest-2", honest_height, real_root),
                ],
                DEFAULT_CONFIRM_QUORUM,
            )
            .unwrap();
        assert!(c.diverged, "{what}: the conflict is noticed");
        assert!(
            c.newly_confirmed.is_empty() && w.balances().confirmed == 0,
            "{what}: the call that reports `diverged` also confirmed the forged note: {} XRGE confirmed and spendable",
            w.balances().spendable / Q as u128
        );
    }
}

// ---------------------------------------------------------------------------------------------------
// Design limits that are documented — shown to be real, so that nobody builds on the other reading
// ---------------------------------------------------------------------------------------------------

/// `ReleasePolicy::Scanned` ("one node's listing decides") is as weak as the "release on
/// rejection" it replaced, against the same attacker: the node that answers "rejected" follows it
/// with one empty page that claims the chain is past the expiry height. The page is checked
/// against the node's own `tip_height` only. The lock is gone at once; on the real chain `t1` is
/// valid for another 64 blocks.
///
/// The same page works on a state fresh from `fresh_for_rescan` at ANY later starting height:
/// an empty tree accepts a page that begins above its `next_height` (meant for the jump to the
/// activation height).
///
/// Passes: this is what the code does and what `NOTES.md` §6 item 7 says of the policy. The wasm
/// export `resolve_pending(state, require_confirmed)` has no default: `false` is this.
#[test]
fn rw2_demo_scanned_policy_releases_on_one_empty_page_that_lies_about_the_height() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let chain = base(&alice.address(), &[10 * Q]);
    let mut a = synced(&chain, &alice);
    confirm(&chain, &mut a);
    let pos = position_of(&a, 10 * Q);
    let t1 = transfer(&a, &alice, &[pos], &bob.address(), 4 * Q, "rw2-demo-scanned");
    let record = t1.pending().unwrap();
    let expiry = record.expiry_height.unwrap();
    a.mark_pending(record.clone()).unwrap();
    a.note_rejection_hint(&record.nullifiers[0].0);

    let lie = |from: u64| {
        let p = serde_json::json!({ "active": true, "tip_height": expiry, "from_height": from, "next_height": expiry + 1, "txs": [] });
        ListingPage::from_json(&p.to_string()).unwrap()
    };
    let mut scanned = a.clone();
    scanned.scan(&lie(scanned.next_height()), &alice.scan_key()).unwrap();
    assert_eq!(scanned.resolve(ReleasePolicy::Scanned).expired.len(), 1, "released by one page");
    assert!(!scanned.is_locked(pos));
    // the strict policy is not moved by it
    let mut strict = a.clone();
    strict.scan(&lie(strict.next_height()), &alice.scan_key()).unwrap();
    assert_eq!(strict.resolve(ReleasePolicy::Confirmed).still_pending, 1);

    // after a rescan request the liar does not even have to continue the state
    let mut rescanning = a.fresh_for_rescan();
    assert!(rescanning.scan(&lie(expiry), &alice.scan_key()).is_ok(), "an empty tree accepts a page that starts anywhere above");
    assert_eq!(rescanning.resolve(ReleasePolicy::Scanned).expired.len(), 1);

    // and t1 is as valid as it was: the real chain is 64 blocks short of its expiry
    let mut real = base(&alice.address(), &[10 * Q]);
    assert!(real.height < expiry);
    real.block(&[&t1.body]).expect("t1 is mined on the real chain after the wallet released its input");
}

// ---------------------------------------------------------------------------------------------------
// Checked and found sound
// ---------------------------------------------------------------------------------------------------

/// The expiry comparison against the node's rule (`daemon/src/shield_v2.rs`: refused iff
/// `expiry_height < block height`, i.e. the last valid height is `expiry_height` itself): the
/// wallet releases when the scanned height is AT OR ABOVE the expiry, never one block early, under
/// both policies, also through a JSON round-trip and a rescan.
#[test]
fn rw2_sound_the_release_height_is_exactly_the_first_height_at_which_the_node_refuses() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = base(&alice.address(), &[10 * Q]);
    let mut a = synced(&chain, &alice);
    confirm(&chain, &mut a);
    let pos = position_of(&a, 10 * Q);
    let t1 = transfer(&a, &alice, &[pos], &bob.address(), 4 * Q, "rw2-sound-expiry");
    let record = t1.pending().unwrap();
    let expiry = record.expiry_height.unwrap();
    a.mark_pending(record.clone()).unwrap();
    assert!(a.mark_pending(record.clone()).is_err(), "not twice");

    chain.advance_to(expiry - 1);
    a.scan(&chain.page(a.next_height()), &alice.scan_key()).unwrap();
    confirm(&chain, &mut a);
    a = WalletState::from_json(&a.to_json().unwrap()).unwrap();
    for policy in [ReleasePolicy::Scanned, ReleasePolicy::Confirmed] {
        assert_eq!(a.clone().resolve(policy).still_pending, 1, "scanned to expiry - 1: block `expiry` can still hold it");
    }
    let mut rescanned = a.fresh_for_rescan();
    rescanned.scan(&chain.page(0), &alice.scan_key()).unwrap();
    assert!(rescanned.is_locked(pos) && rescanned.resolve(ReleasePolicy::Scanned).still_pending == 1);
    assert!(matches!(select_inputs_with(&a, 4 * Q, Q, true), Err(WalletError::InsufficientFunds { .. })));

    chain.advance_to(expiry);
    a.scan(&chain.page(a.next_height()), &alice.scan_key()).unwrap();
    assert_eq!(a.clone().resolve(ReleasePolicy::Scanned).expired.len(), 1);
    assert_eq!(a.clone().resolve(ReleasePolicy::Confirmed).still_pending, 1, "the quorum has not confirmed that height yet");
    confirm(&chain, &mut a);
    assert_eq!(a.resolve(ReleasePolicy::Confirmed).expired.len(), 1);
    // the four balances never count a note twice
    let b = a.balances();
    assert_eq!((b.confirmed, b.unverified, b.locked, b.spendable), (10 * Q as u128, 0, 0, 10 * Q as u128));
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

/// Dust (REVIEW_WALLET_1 I-7, still open): what one non-zero note costs the victim's state, for
/// the cost estimate in the report. A hostile sender pays one fee (1 XRGE) per transaction and
/// can address both outputs to the victim with its own builder.
#[test]
fn rw2_info_state_bytes_per_stored_dust_note() {
    let alice = keys(PHRASE_1);
    let mut chain = base(&alice.address(), &[Q]);
    let before = synced(&chain, &alice).to_json().unwrap().len();
    let n = 12usize;
    fund(&mut chain, &alice.address(), &vec![1u64; n]); // 1 quantum each
    let after_state = synced(&chain, &alice);
    assert_eq!(after_state.notes().len(), n + 1, "every non-zero dust note is stored and tracked");
    let per_note = (after_state.to_json().unwrap().len() - before) / n;
    println!("rw2: {per_note} bytes of state JSON per stored dust note");
    assert!((2_000..4_000).contains(&per_note), "{per_note}");
}
