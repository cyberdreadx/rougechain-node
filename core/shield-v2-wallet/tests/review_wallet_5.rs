//! REVIEW_WALLET_5 — fifth independent review, of `fix/shield-v2-wallet-settlement-3` @ `43166fb`
//! (see `REVIEW_WALLET_5.md`). Nothing was fixed by the review.
//!
//! * `rw5_fN_…` — a confirmed defect; it failed on purpose and asserts the safe behaviour, so
//!   that a fix turns it green without editing what it asserts;
//! * `rw5_demo_…` — a limit that is real (passes; the assertions STATE the limit);
//! * `rw5_sound_…` — something that was attacked and holds (passes).
//!
//! **After the Resolution** (`REVIEW_WALLET_5.md`, "Resolution"; branch
//! `fix/shield-v2-wallet-settlement-4`). What was edited here, and why:
//!
//! * `common::configure` no longer makes the user's statement (condition 3, section A.3). The
//!   NEW wallets of these tests that have to spend say so with `configure_as_sole_copy` — one
//!   line of SET-UP in `rw5_f1` and in `rw5_f1b` (the device that builds the payment), in
//!   `stale_quorum` (the lost device) and in two `rw5_sound_…` tests. No assertion of an
//!   `rw5_fN_…` test was touched.
//! * the two loop tests asserted that the loop of `NOTES.md` §6 as it was did NOT terminate.
//!   The loop was restated (condition 1) and is code now (`common::client_loop`, the one the
//!   property test's client runs): the tests assert that it ends with the tip confirmed.
//! * `rw5_demo_the_override_…` asserted the voiding rule of RW5-5, which is removed: it asserts
//!   that the statement stands.
//! * `rw5_sound_twin_notes_…`: twin notes no longer exist in a state — the page that would
//!   create one is refused (RW5-1 b); the test asserts that.
//!
//! Needs the `test-vectors` feature (proof-less deterministic assembly), like the earlier reviews.
#![cfg(feature = "test-vectors")]

mod common;

use std::collections::BTreeSet;

use common::client_loop::{LoopClient, Stop, FIRST_CHECK_ROUNDS, PAGE_BLOCKS, STRIKES};
use common::*;
use quantum_vault_shield_v2::reference::{derive_rho, digest_from_bytes, digest_to_bytes, Note};
use quantum_vault_shield_v2_wallet::note_enc::encrypt_note_with_kem_randomness;
use quantum_vault_shield_v2_wallet::store::{ListedOutput, ListedTx};
use quantum_vault_shield_v2_wallet::tx::{deterministic, UnprovenTx};
use quantum_vault_shield_v2_wallet::*;

const N1: &str = "node-1";
const N2: &str = "node-2";
const N3: &str = "node-3";

fn fund(chain: &mut Chain, to: &ShieldedAddress, values: &[u64]) {
    let key = fake_account_key(1);
    for (i, v) in values.iter().enumerate() {
        let req = ShieldRequest { ctx: chain.ctx(), from_pub_key: &key, nonce: 1, v_in: v + Q, fee: SHIELD_V2_MIN_FEE_QUANTA, recipient: to, max_fee: None };
        let tx = deterministic::shield(&req, &format!("rw5-fund-{}-{i}", chain.height)).unwrap();
        chain.block(&[&tx.body]).unwrap();
    }
}

fn shield_body(chain: &Chain, to: &ShieldedAddress, value: u64, label: &str) -> Vec<u8> {
    let req = ShieldRequest { ctx: chain.ctx(), from_pub_key: &fake_account_key(2), nonce: 1, v_in: value + Q, fee: Q, recipient: to, max_fee: None };
    deterministic::shield(&req, label).unwrap().body
}

fn parse(page: &serde_json::Value) -> ListingPage {
    ListingPage::from_json(&page.to_string()).unwrap()
}

fn position_of(s: &WalletState, value: u64) -> u64 {
    s.unspent().find(|n| n.value == value).expect("a note of that value").position
}

fn pay_with(state: &mut WalletState, keys: &ShieldedKeys, positions: &[u64], to: &ShieldedAddress, amount: u64, expiry_height: Option<u64>, allow_unverified: bool, label: &str) -> Result<UnprovenTx, WalletError> {
    let spend = SpendOptions { chain_id: CHAIN, inputs: positions, expiry_height, allow_unverified, max_fee: None };
    let (tx, next) = deterministic::transfer_locked(state, state.revision(), keys, &TransferParams { spend, recipient: to, amount, fee: Q }, label)?;
    *state = next;
    Ok(tx)
}

/// The nodes of a state WITHOUT the user's statement: what a restored device has.
fn nodes_only(state: &mut WalletState, ids: &[&str]) {
    state.set_nodes(&ids.iter().map(|id| node(id)).collect::<Vec<_>>()).unwrap();
}

fn expiry_of(body: &[u8]) -> u64 {
    u64::from_le_bytes(body[34..42].try_into().unwrap())
}

/// What the address can find on `chain` by scanning with its full key and no state.
fn balance_of(chain: &Chain, keys: &ShieldedKeys) -> u128 {
    let mut s = WalletState::with_min_note_value(keys.address().pk, 1).unwrap();
    s.scan(&chain.page(0), &keys.scan_key()).unwrap();
    s.balance()
}

/// A page without transactions: `[from, next)`, the node's tip as it claims it.
fn empty_page(from: u64, next: u64, tip: u64) -> ListingPage {
    parse(&serde_json::json!({ "active": true, "tip_height": tip, "from_height": from, "next_height": next, "txs": [] }))
}

/// What the documents let a client do with the error of a `scan`: `Ok`, or one of the two errors
/// the loop of `NOTES.md` §6 has a rule for (`listing:` and `rescan_required:` ⇒ RESCAN). The
/// documents call `state_invariant:` "an implementation fault" and give the loop no rule for it.
fn the_loop_has_a_rule_for(r: &Result<ScanReport, WalletError>) -> bool {
    matches!(r, Ok(_) | Err(WalletError::Listing(_)) | Err(WalletError::RescanRequired))
}

// ---------------------------------------------------------------------------------------------------
// RW5-1 (Medium; G4, G3) — a lying listing makes `scan` answer `state_invariant`, for which the
// client loop has no rule. Two ways in: the viewing-key worker (one page), and the full key
// (default path) with a transaction pending.
// ---------------------------------------------------------------------------------------------------

/// The background worker scans with the viewing key (`export_scan_key(seed, false)`, the
/// documented mode), and the node it lists from lies in ONE respect: it lists a transaction that
/// spends a note of the wallet BEFORE the transaction that created the note (a listing in
/// another order; the liar need not know which is which — reversing any stretch of the chain
/// does it for every note that was received and spent inside it).
///
/// Without `nk` the scan cannot see spends: it remembers every nullifier it met, with its height
/// (F-3). The note is stored afterwards, at its (listed) height. When the main client then scans
/// ANY page with the full key — an honest one, an empty one — the remembered spend is applied:
/// `spent_height` (the height the nullifier was listed at) is BELOW the note's `height`. The
/// result does not validate, and the call is refused with `state_invariant`. Every later scan
/// with the full key runs into the same thing: the state cannot be advanced by the loop any
/// more, on any node's pages. The pending list, the locks and the confirmed data are intact —
/// `rescan_state` gets out of it — but the loop of `NOTES.md` §6 has no rule that leads there
/// (the property test's client panics on this error), and the documents tell a client author
/// that `state_invariant:` is an implementation fault, not something a node can cause.
#[test]
fn rw5_f1_a_lying_listing_read_with_the_viewing_key_leaves_a_state_no_scan_with_the_full_key_can_advance() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    // the true chain: block 3 pays the wallet 6 XRGE, block 4 pays it 10 XRGE, block 5 is the
    // wallet's own payment from the 10 XRGE note (made on its main device)
    let b1 = shield_body(&chain, &alice.address(), 6 * Q, "rw5-f1-n1");
    chain.block(&[&b1]).unwrap();
    let b2 = shield_body(&chain, &alice.address(), 10 * Q, "rw5-f1-n2");
    chain.block(&[&b2]).unwrap();
    let mut main = WalletState::new(alice.address().pk);
    configure_as_sole_copy(&mut main, &[NODE_A, NODE_B]); // (set-up, added with the Resolution: the main device is a NEW wallet)
    main.scan(&chain.page(0), &alice.scan_key()).unwrap();
    confirm(&chain, &mut main);
    let p_in = position_of(&main, 10 * Q);
    let s_tx = pay(&mut main, &alice, &[p_in], &bob.address(), 4 * Q, "rw5-f1-spend");
    chain.block(&[&s_tx.body]).unwrap();
    assert_eq!(chain.height, 5);

    // the worker's listing node serves the same three transactions, the last two exchanged
    let lying = serde_json::json!({ "active": true, "tip_height": 5, "from_height": A, "next_height": 6,
        "txs": [listing_entry(&b1, 3, 0, 0), listing_entry(&s_tx.body, 4, 0, 2), listing_entry(&b2, 5, 0, 4)] });
    let mut state = WalletState::new(alice.address().pk);
    nodes_only(&mut state, &[N1, N2, N3]);
    state.scan(&parse(&lying), &alice.incoming_viewing_key()).expect("the page is well-formed: the worker's scan accepts it");
    assert!(state.view_only_since().is_some());
    let stored = state.to_json().expect("and the state is written");

    // the main client: step 1 of the loop, the next page with the FULL key — from an honest node
    let mut s = WalletState::from_json(&stored).unwrap();
    let honest_next = chain.page(s.next_height());
    let first = s.scan(&honest_next, &alice.scan_key());
    let again = s.scan(&honest_next, &alice.scan_key());
    let other_node = s.scan(&empty_page(6, 6, 5), &alice.scan_key());
    // what gets out of it — and what no rule of the loop calls on this error
    let mut fresh = s.fresh_for_rescan();
    let rescanned = fresh.scan(&chain.page(0), &alice.scan_key());
    println!(
        "rw5-f1: a listing with a spend listed before the note it spends, read with the viewing key: accepted; the next page with the full key: {:?}; again: {:?}; \
         from another node: {:?}; the worker can go on with the viewing key: {}; after rescan_state + an honest listing: {:?}",
        first.as_ref().map(|_| "ok").map_err(|e| e.to_string()),
        again.as_ref().map(|_| "ok").map_err(|e| e.to_string()),
        other_node.as_ref().map(|_| "ok").map_err(|e| e.to_string()),
        s.clone().scan(&honest_next, &alice.incoming_viewing_key()).is_ok(),
        rescanned.as_ref().map(|_| "ok").map_err(|e| e.to_string()),
    );
    assert!(rescanned.is_ok(), "a rescan recovers (the documented answer to a lying listing)");
    assert!(
        the_loop_has_a_rule_for(&first) && the_loop_has_a_rule_for(&again) && the_loop_has_a_rule_for(&other_node),
        "G4: one lying page read with the viewing key, and every scan with the full key answers `state_invariant` — the error the documents call an implementation fault, \
         for which the client loop has no rule: {:?}",
        first.err().map(|e| e.to_string())
    );
}

/// The same error on the DEFAULT path — the full key, no worker. A wallet with one payment
/// pending rescans (the documented answer to `listing_refuted`, a `listing:` error, a migration,
/// a change of the cap), and the node it lists from repeats ONE true transaction — the one that
/// created the note the pending payment spends — 16,383 times, then lists the payment itself.
/// Every copy opens (the note is the wallet's), so every copy is stored; when the nullifier
/// appears all of them are spent, and all of them are inputs of the pending entry by their
/// commitment, so `drop_old_spent` keeps every one. The state then holds more spent notes than a
/// state may (`MAX_SPENT_RETAINED + 2·(MAX_PENDING + MAX_LEGACY_LOCKS)` = 12,416) and the page
/// is refused with `state_invariant` — again and again, for as long as the client lists from
/// that node, and the loop has no rule that makes it stop.
#[test]
fn rw5_f1b_a_listing_that_repeats_the_note_of_a_pending_payment_makes_the_full_key_scan_answer_state_invariant() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    let mut w = WalletState::new(alice.address().pk);
    configure_as_sole_copy(&mut w, &[N1, N2, N3]); // (set-up, changed with the Resolution: a NEW wallet; was `configure`, which made the statement then)
    w.scan(&chain.page(0), &alice.scan_key()).unwrap();
    w.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    let p_in = position_of(&w, 10 * Q);
    let t1 = pay_with(&mut w, &alice, &[p_in], &bob.address(), 4 * Q, None, false, "rw5-f1b-t1").unwrap();

    let mut s = w.fresh_for_rescan();
    // the true transaction that created the 10 XRGE note, and the wallet's own payment
    let creating: ListedTx = chain.page(0).txs[0].clone();
    let payment: ListedTx = parse(&serde_json::json!({ "active": true, "tip_height": 9, "from_height": 9, "next_height": 10, "txs": [listing_entry(&t1.body, 9, 0, 0)] })).txs[0].clone();
    let numbered = |mut tx: ListedTx, height: u64, index: u64, first_leaf: u64| {
        tx.height = height;
        tx.index = index;
        for (j, o) in tx.outputs.iter_mut().enumerate() {
            o.leaf = Some(first_leaf + j as u64);
        }
        tx
    };
    const PER_PAGE: u64 = 4_096; // the most a page may list
    let mut results = Vec::new();
    for page_no in 0..4u64 {
        let height = A + page_no;
        let mut txs: Vec<ListedTx> = (0..PER_PAGE).map(|i| numbered(creating.clone(), height, i, 2 * (page_no * PER_PAGE + i))).collect();
        if page_no == 3 {
            txs[PER_PAGE as usize - 1] = numbered(payment.clone(), height, PER_PAGE - 1, 2 * (page_no * PER_PAGE + PER_PAGE - 1));
        }
        let page = ListingPage { active: true, tip_height: 1_000, from_height: if page_no == 0 { A } else { s.next_height() }, next_height: height + 1, txs };
        results.push(s.scan(&page, &alice.scan_key()));
        if results.last().unwrap().is_err() {
            break;
        }
    }
    let (stored, spent) = (s.notes().len(), s.notes().iter().filter(|n| n.spent).count());
    println!(
        "rw5-f1b: four pages that repeat one true transaction: {:?}; the state holds {stored} notes ({spent} spent), {} pending, and reads back: {}",
        results.iter().map(|r| r.as_ref().map(|x| x.received.len()).map_err(|e| e.to_string())).collect::<Vec<_>>(),
        s.pending().len(),
        s.to_json().is_ok()
    );
    assert_eq!(s.pending().len(), 1, "the lock is kept whatever the listing did");
    assert!(
        results.iter().all(the_loop_has_a_rule_for),
        "G4: a listing node made the full-key scan answer `state_invariant` — the error the documents call an implementation fault, for which the client loop has no rule"
    );
}

// ---------------------------------------------------------------------------------------------------
// RW5-6 (Info) — two different states with one revision identity.
// ---------------------------------------------------------------------------------------------------

/// `revision_id` is documented as the IDENTITY of a state ("two states have one identity only if
/// they came from the same state by the same change with the same result"). `rescan_state` with
/// another minimum note value or another cap changes the state AFTER the identity was computed:
/// the two results below differ (one stores dust, one does not) and carry one `revision_id`. The
/// storage-side compare-and-swap is not affected (it compares with the identity that was LOADED);
/// `expect_revision_id` on a state in hand is.
#[test]
fn rw5_f2_two_rescans_with_different_limits_are_two_states_with_one_revision_identity() {
    let (alice, _) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut w = WalletState::new(alice.address().pk);
    configure(&mut w, &[N1, N2, N3]);
    let plain = w.fresh_for_rescan();
    let dust = w.fresh_for_rescan_with(Some(1), None).unwrap();
    let wide = w.fresh_for_rescan_with(None, Some(1_000)).unwrap();
    assert!(plain != dust && plain != wide && dust != wide, "three different states");
    assert_eq!((plain.min_note_value(), dust.min_note_value(), wide.max_unspent_notes()), (Q, 1, 1_000));
    let ids: BTreeSet<[u8; 32]> = [plain.revision_id(), dust.revision_id(), wide.revision_id()].into_iter().collect();
    assert_eq!(ids.len(), 3, "RW4-10: three different states made from one state carry {} revision identity(ies); `expect_revision_id` accepts each for the others", ids.len());
}

// ---------------------------------------------------------------------------------------------------
// RW5-7 (Info; G2 by configuration) — an IPv4 address and its IPv4-mapped IPv6 form are two nodes.
// ---------------------------------------------------------------------------------------------------

/// REVIEW_WALLET_4 RW4-2 asked for "one endpoint, one node" for IP literals, and `set_nodes` now
/// allows one node per HOST. `192.0.2.7` and `[::ffff:192.0.2.7]` are one endpoint on every
/// dual-stack machine and two hosts to the core: a set of three with both of them gives one
/// machine two of three votes — a quorum. (It takes whoever configures the wallet to enter both;
/// an operator with two NAMES is outside the model in any case. Listed for completeness.)
#[test]
fn rw5_f3_an_ipv4_literal_and_its_ipv4_mapped_form_are_one_endpoint_and_two_votes() {
    let mut s = WalletState::new(keys(PHRASE_1).address().pk);
    let set = s.set_nodes(&["https://192.0.2.7", "https://[::ffff:192.0.2.7]", "https://node-b.example"]);
    let votes_of_one_machine = set.as_ref().map(|n| n.iter().filter(|id| id.contains("192.0.2.7") || id.contains("c000:207")).count()).unwrap_or(0);
    println!("rw5-f3: set_nodes with an IPv4 literal and its IPv4-mapped form: {:?}; quorum {}", set.as_ref().map_err(|e| e.to_string()), s.quorum());
    assert!(votes_of_one_machine <= 1, "one machine holds {votes_of_one_machine} of {} configured nodes (quorum {})", s.nodes().len(), s.quorum());
}

// ---------------------------------------------------------------------------------------------------
// A (1) — the embargo arithmetic: the bound is exactly 256 blocks of honest lag (n = 3, 5, 7).
// ---------------------------------------------------------------------------------------------------

/// One run of the stale-quorum attack against a restored device that does NOT make the user's
/// statement. `n` configured nodes, a full lying minority (`n − quorum`), ONE honest node `lag`
/// blocks behind the height the lost device built at, the other honest nodes at the tip and
/// either silent or answering truthfully in the call that establishes the base. Returns
/// (embargo until, expiry of the lost device's transaction, what the payee holds at the end, the
/// base). The lost device used the longest expiry the builders accept unless `expiry_offset`.
fn stale_quorum(n: usize, lag: u64, leading_answer: bool, expiry_offset: u64, tag: &str) -> (u64, u64, u128, u64) {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let ids: Vec<String> = (1..=n).map(|i| format!("node-{i}")).collect();
    let ids: Vec<&str> = ids.iter().map(String::as_str).collect();
    let quorum = n / 2 + 1;
    let liars = &ids[..n - quorum]; // a full strict minority
    let lagging = ids[n - quorum]; // one honest node
    let leading = &ids[n - quorum + 1..]; // quorum − 1 honest nodes
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    chain.advance_to(40);
    let behind = chain.height;
    let old: Vec<StateReport> = liars.iter().chain([&lagging]).map(|id| chain.report(id)).collect();
    let old_page = chain.page_value(0, behind);
    chain.advance_to(behind + lag);

    // the lost device: a new wallet (the statement is true for it), confirmed at the tip by the
    // leading honest nodes and the liars, which tell the truth here
    let mut d1 = WalletState::new(alice.address().pk);
    configure_as_sole_copy(&mut d1, &ids);
    d1.scan(&chain.page(0), &alice.scan_key()).unwrap();
    let at_tip: Vec<StateReport> = liars.iter().chain(leading).map(|id| chain.report(id)).collect();
    assert_eq!(d1.confirm_state(&at_tip).unwrap().matched_height, Some(chain.height));
    let built_at = chain.height;
    let p_in = position_of(&d1, 10 * Q);
    let t1 = pay_with(&mut d1, &alice, &[p_in], &bob.address(), 4 * Q, Some(built_at + expiry_offset), false, &format!("{tag}-t1")).unwrap();
    // … persisted, submitted to a liar, which keeps it. The device is lost.

    // the restored device: no statement. The liars list and report the true chain as it was
    // where the lagging honest node stands.
    let mut d2 = WalletState::new(alice.address().pk);
    nodes_only(&mut d2, &ids);
    d2.scan(&parse(&old_page), &alice.scan_key()).unwrap();
    let mut reports = old.clone();
    if leading_answer {
        reports.extend(leading.iter().map(|id| chain.report(id)));
    }
    let c = d2.confirm_state(&reports).unwrap();
    assert_eq!((c.matched_height, c.embargo_base_set), (Some(behind), true), "{tag}");
    assert!(c.dissenting.is_empty() && !c.listing_refuted && !c.listing_ahead, "{tag}: nothing in the call asks the client to do anything");
    let SpendEmbargo::Until { base, until, waived, .. } = d2.spend_embargo() else { panic!("{tag}: no base") };
    assert!(!waived);
    assert!(matches!(d2.spend_gate(), Err(WalletError::RestoredRecently { until: Some(u) }) if u == until));

    // the chain goes on to the end of the embargo; everybody catches up and answers
    chain.advance_to(until);
    d2.scan(&chain.page(d2.next_height()), &alice.scan_key()).unwrap();
    let all: Vec<StateReport> = ids.iter().map(|id| chain.report(id)).collect();
    assert_eq!(d2.confirm_state(&all).unwrap().matched_height, Some(until));
    assert!(d2.spend_status(Some(until)).can_spend_now, "{tag}: the embargo is over");
    // the user makes "the same" payment again, from the other note
    let sel = select_inputs(&d2, 4 * Q, Q).unwrap();
    assert_eq!(sel.positions, vec![position_of(&d2, 6 * Q)]);
    let t2 = pay_with(&mut d2, &alice, &sel.positions, &bob.address(), 4 * Q, None, false, &format!("{tag}-t2")).unwrap();
    // the liar releases t1 into the block that holds t2 — if t1 is still inside its validity
    let h = chain.height + 1;
    let both = expiry_of(&t1.body) >= h && chain.block(&[&t2.body, &t1.body]).is_ok();
    if !both {
        chain.block(&[&t2.body]).unwrap();
    }
    (until, expiry_of(&t1.body), balance_of(&chain, &bob), base)
}

/// **The answer to "is 256 blocks of honest lag the true bound": yes, exactly, for n = 3, 5 and
/// 7, with the longest expiry (128) — and one lagging honest node is enough at every n.** At a
/// lag of 256 the embargo ends in the block the earlier transaction expires in; at 257 it ends
/// one block earlier and the payee is paid twice. It makes no difference whether the honest
/// nodes at the tip answer in the establishing call (then `base = min(Tm, Tq + 256)`) or are
/// silent (`base = Tq + 256`): the quorum's tip is the lagging node's height either way, because
/// the liars sit there with it. With the default expiry (64) the same happens at 321.
///
/// This is the limit the documents state (spec §5.5 W-19, `NOTES.md` §13): it passes.
#[test]
fn rw5_demo_the_restore_embargo_holds_up_to_exactly_256_blocks_of_honest_lag_for_three_five_and_seven_nodes() {
    for n in [3usize, 5, 7] {
        for leading_answer in [false, true] {
            let tag = format!("rw5-embargo-n{n}-{}", if leading_answer { "answering" } else { "silent" });
            let (until, expiry, paid, base) = stale_quorum(n, 256, leading_answer, MAX_EXPIRY_OFFSET, &format!("{tag}-256"));
            assert!(until >= expiry && paid == 4 * Q as u128, "{tag}: at 256 blocks of lag the embargo is sufficient (until {until}, expiry {expiry}, the payee holds {paid})");
            let (until7, expiry7, paid7, base7) = stale_quorum(n, 257, leading_answer, MAX_EXPIRY_OFFSET, &format!("{tag}-257"));
            assert!(until7 + 1 == expiry7 && paid7 == 8 * Q as u128, "{tag}: at 257 the embargo ends one block before the expiry and the payee is paid twice (until {until7}, expiry {expiry7}, holds {paid7})");
            println!("{tag}: lag 256 → base {base}, embargo until {until}, t1 expires at {expiry}, payee holds {paid}; lag 257 → base {base7}, until {until7}, expiry {expiry7}, payee holds {paid7} (twice)");
        }
    }
    // the default expiry: 64 blocks more of margin
    let (until, expiry, paid, _) = stale_quorum(3, 320, false, DEFAULT_EXPIRY_OFFSET, "rw5-embargo-default-320");
    assert!(until >= expiry && paid == 4 * Q as u128);
    let (until, expiry, paid, _) = stale_quorum(3, 321, false, DEFAULT_EXPIRY_OFFSET, "rw5-embargo-default-321");
    assert!(until + 1 == expiry && paid == 8 * Q as u128, "default expiry: 321 blocks of lag (until {until}, expiry {expiry}, holds {paid})");
}

// ---------------------------------------------------------------------------------------------------
// A (2) — the override: what its "voiding" rule does and does not do.
// ---------------------------------------------------------------------------------------------------

/// **As reviewed (RW5-5)** the user's statement was honoured only if the establishing call showed
/// no configured node above the height being confirmed, and this test stated the two
/// consequences: (a) an honest user lost a TRUE statement to an ordinary one-block race, for
/// good, and was embargoed for 129 blocks; (b) the rule protected nobody from a liar, who only
/// had to wait for a call in which the leading node was silent.
///
/// **Resolved: the voiding rule is removed — the statement, once recorded before the base
/// exists, stands.** (The test was edited with the rule it asserted.)
///
/// (a) A NEW wallet (the statement is true), three honest nodes, one of them one block ahead
/// when they are asked: the statement is honoured, there is no embargo, the wallet pays.
///
/// (b) The statement is the user's word and exactly as strong as it is true. Made FALSELY on a
/// restored device — the lost device has a payment in flight — it is honoured whatever the
/// reports show (here every node answers, the honest leader included), and one block of honest
/// lag is a double payment. No rule of the core stands between a false statement and that:
/// which is why a client makes it without asking only for a phrase generated on the device
/// (`UI_CONTRACT.md`, obligation 1). The same device WITHOUT the statement is the embargo of
/// `rw5_demo_the_restore_embargo_holds_up_to_exactly_256_blocks_…`.
#[test]
fn rw5_demo_the_override_stands_through_a_one_block_race_and_is_exactly_as_strong_as_it_is_true() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    // (a)
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    chain.advance_to(40);
    let mut w = WalletState::new(alice.address().pk);
    configure_as_sole_copy(&mut w, &[N1, N2, N3]); // a new wallet on a phrase generated on this device
    w.scan(&chain.page(0), &alice.scan_key()).unwrap();
    let (r1, r2) = (chain.report(N1), chain.report(N2));
    chain.advance_to(41); // a block arrives while the three answers are collected
    let c = w.confirm_state(&[r1, r2, chain.report(N3)]).unwrap();
    assert_eq!((c.matched_height, c.embargo_base_set, c.highest_reported), (Some(40), true, Some(41)));
    assert_eq!(w.spend_embargo(), SpendEmbargo::Until { first_confirmed: 40, base: 40, until: 40, waived: true });
    assert!(w.spend_gate().is_ok() && w.spend_status(Some(41)).can_spend_now);
    let p_in = position_of(&w, 10 * Q);
    pay_with(&mut w, &alice, &[p_in], &bob.address(), 4 * Q, None, false, "rw5-override-new").expect("a new wallet with a true statement pays, whatever the race");
    println!("rw5-override (a): a new wallet with a true statement, one honest node one block ahead in the first state check: no embargo; it pays");

    // (b)
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    chain.advance_to(40);
    let (old_n2, old_n3, old_page) = (chain.report(N2), chain.report(N3), chain.page_value(0, 40));
    chain.advance_to(41); // honest node 2 is ONE block behind
    let mut d1 = WalletState::new(alice.address().pk);
    configure_as_sole_copy(&mut d1, &[N1, N2, N3]);
    d1.scan(&chain.page(0), &alice.scan_key()).unwrap();
    d1.confirm_state(&[chain.report(N1), chain.report(N3)]).unwrap();
    let p_in = position_of(&d1, 10 * Q);
    let t1 = pay_with(&mut d1, &alice, &[p_in], &bob.address(), 4 * Q, None, false, "rw5-override-t1").unwrap();
    let mut d2 = WalletState::new(alice.address().pk);
    configure_as_sole_copy(&mut d2, &[N1, N2, N3]); // the statement — FALSE here: the lost device has t1 in flight
    d2.scan(&parse(&old_page), &alice.scan_key()).unwrap();
    let c = d2.confirm_state(&[chain.report(N1), old_n2, old_n3]).unwrap(); // every node answers; the honest leader is ahead
    assert_eq!((c.matched_height, c.highest_reported), (Some(40), Some(41)));
    assert_eq!(d2.spend_embargo(), SpendEmbargo::Until { first_confirmed: 40, base: 40, until: 40, waived: true });
    let sel = select_inputs(&d2, 4 * Q, Q).unwrap();
    let t2 = pay_with(&mut d2, &alice, &sel.positions, &bob.address(), 4 * Q, None, false, "rw5-override-t2").expect("no embargo: the statement was honoured");
    chain.block(&[&t2.body, &t1.body]).unwrap();
    assert_eq!(balance_of(&chain, &bob), 8 * Q as u128, "the payee is paid twice");
    println!("rw5-override (b): the statement made FALSELY on a restored device: honoured; the payee holds {} quanta for one payment of {}", balance_of(&chain, &bob), 4 * Q);
}

// ---------------------------------------------------------------------------------------------------
// A (4) — the embargo is a number of blocks on a chain that makes blocks only for transactions.
// ---------------------------------------------------------------------------------------------------

/// A restored wallet, every node honest and answering: `base` = the tip, no spend for 128 blocks
/// of CONFIRMED height. While nobody transacts, the chain makes no block and nothing the wallet
/// can do through the state check moves the embargo — and the embargoed wallet's own spends are
/// exactly what is refused. Only blocks end it (anybody's transaction; a shield from the user's
/// public account is not gated by the embargo). With one silent node in the establishing call it
/// is 384 blocks.
#[test]
fn rw5_demo_on_an_idle_chain_the_restore_embargo_does_not_end() {
    let alice = keys(PHRASE_1);
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    chain.advance_to(40);
    let all = |chain: &Chain| vec![chain.report(N1), chain.report(N2), chain.report(N3)];
    let mut w = WalletState::new(alice.address().pk);
    nodes_only(&mut w, &[N1, N2, N3]);
    w.scan(&chain.page(0), &alice.scan_key()).unwrap();
    w.confirm_state(&all(&chain)).unwrap();
    assert_eq!(w.spend_embargo_until(), Some(40 + 128));
    for round in 0..50 {
        // rounds of the loop on a chain without a new block
        w.scan(&chain.page(w.next_height()), &alice.scan_key()).unwrap();
        w.confirm_state(&all(&chain)).unwrap();
        let st = w.spend_status(Some(chain.height));
        assert_eq!((st.can_spend_now, st.reason, st.embargo_blocks_left), (false, Some("embargo"), Some(128)), "round {round}");
    }
    chain.advance_to(40 + 127);
    w.scan(&chain.page(w.next_height()), &alice.scan_key()).unwrap();
    w.confirm_state(&all(&chain)).unwrap();
    assert_eq!(w.spend_status(Some(chain.height)).embargo_blocks_left, Some(1));
    chain.advance_to(40 + 128);
    w.scan(&chain.page(w.next_height()), &alice.scan_key()).unwrap();
    w.confirm_state(&all(&chain)).unwrap();
    assert!(w.spend_status(Some(chain.height)).can_spend_now);
    // one node silent in the establishing call: 256 blocks more
    let mut v = WalletState::new(alice.address().pk);
    nodes_only(&mut v, &[N1, N2, N3]);
    v.scan(&chain.page(0), &alice.scan_key()).unwrap();
    v.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    assert_eq!(v.spend_status(Some(chain.height)).embargo_blocks_left, Some(384));
}

// ---------------------------------------------------------------------------------------------------
// The client loop of NOTES.md §6 — as restated after this review, and as code:
// `common::client_loop` (the loop the property test's client runs, decision for decision).
// ---------------------------------------------------------------------------------------------------

/// A page of `PAGE_BLOCKS` empty heights from `from`, by a node that claims a tip far away: the
/// size of an honest answer, and never the node's tip.
fn full_empty_page(from: u64) -> ListingPage {
    empty_page(from, from + PAGE_BLOCKS, 1_000_000)
}

/// **RW5-2, resolved.** As reviewed, the loop left a listing node on three signals, and a node
/// that never let the client reach ITS tip triggered none of them: 40 rounds, 160 revisions
/// written, nothing confirmed, never left. The restated loop (`NOTES.md` §6) leaves it within a
/// bounded number of rounds, whichever way the node goes about it — and ends with the tip
/// confirmed, listing from an honest node:
///
/// (a) pages that make no progress (`next_height = from_height`, a far `tip_height`): not the
/// node's tip and not the 64 heights that were asked for — **a short page: banned at once**;
/// (a2) pages of the right size, to nowhere (the truth, then 64 empty heights at a time, never
/// the tip): what was scanned a round ago stays unconfirmed — **left after `STRIKES` rounds**;
/// (b) the truth to the tip, then one empty height per page: a short page again — banned;
/// (b2) the truth to the tip and 64 empty heights above it, claimed as its tip: `scanned` stays
/// above `confirmed` — left after `STRIKES` rounds.
///
/// Two honest nodes answer every round; the liar (node 1, the first in the list) answers no
/// report. The wallet of (a) to (b2) is a new one (it made the statement); the last case is a
/// RESTORED one, whose first state check waits `FIRST_CHECK_ROUNDS` rounds for the silent node
/// (`UI_CONTRACT.md`, obligation 2) and then goes on.
#[test]
fn rw5_demo_a_listing_node_that_never_reaches_its_tip_is_left_and_the_tip_is_confirmed() {
    let alice = keys(PHRASE_1);
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    chain.advance_to(20);
    let honest_reports = |chain: &Chain| vec![chain.report(N2), chain.report(N3)]; // node 1 is the liar; it is silent
    let wallet = |new: bool| {
        let mut s = WalletState::new(alice.address().pk);
        if new {
            configure_as_sole_copy(&mut s, &[N1, N2, N3]);
        } else {
            configure(&mut s, &[N1, N2, N3]);
        }
        s
    };
    let truth_then = |since: u64, then: &dyn Fn(u64) -> ListingPage| if since > 20 { then(since) } else { chain.page(since) };
    type Liar<'a> = (&'a str, Box<dyn Fn(u64) -> ListingPage + 'a>, bool);
    let liars: Vec<Liar> = vec![
        ("(a) no progress", Box::new(|since| empty_page(since.max(A), since.max(A), 1_000_000)), true),
        ("(a2) the truth, then full pages to nowhere", Box::new(|since| if since > 20 { full_empty_page(since) } else { parse(&{ let mut p = chain.page_value(since, 20); p["tip_height"] = serde_json::json!(1_000_000); p["next_height"] = serde_json::json!(since.max(A) + PAGE_BLOCKS); p }) }), false),
        ("(b) the truth, then one empty height per page", Box::new(|since| truth_then(since, &|s| empty_page(s, s + 1, 1_000_000))), true),
        ("(b2) the truth and 64 empty heights above it, as its tip", Box::new(|since| if since > 20 { empty_page(since, since, since - 1) } else { parse(&{ let mut p = chain.page_value(since, 20); p["tip_height"] = serde_json::json!(20 + PAGE_BLOCKS); p["next_height"] = serde_json::json!(21 + PAGE_BLOCKS); p }) }), false),
    ];
    // every tenure of a node ends within this many rounds (the chain is short: no catching up)
    let per_node = STRIKES as u64 + 2;
    for (what, liar, banned) in &liars {
        for new in [true, false] {
            let mut c = LoopClient::new(wallet(new), 0);
            let revision = c.s.revision();
            // (a liar that tells the truth up to the tip is at the tip with everybody else for
            // one round; what counts is where the loop IS after the bound, and that it stays)
            let bound = per_node + 1 + if new { 0 } else { FIRST_CHECK_ROUNDS as u64 };
            let mut rounds = 0;
            for round in 1..=bound {
                c.round(&alice.scan_key(), &mut |node, since| if node == 0 { liar(since) } else { chain.page(since) }, &mut || honest_reports(&chain));
                if c.session.listing == 0 || c.s.confirmed_height() != Some(20) || c.s.scanned_height() != Some(20) {
                    rounds = round + 1;
                }
            }
            assert!(rounds <= bound && c.s.confirmed_height() == Some(20) && c.s.scanned_height() == Some(20), "{what} (new wallet: {new}): not at the tip, listing from an honest node, after {bound} rounds — L is node {}, bad {:?}, confirmed {:?}, scanned {:?}", c.session.listing + 1, c.session.bad, c.s.confirmed_height(), c.s.scanned_height());
            println!(
                "rw5-loop {what}, {}: the tip is confirmed after {rounds} rounds (bound {bound}); the liar was {} ({:?}); L is node {}, {} rescan(s), {} state revisions written",
                if new { "a new wallet" } else { "a restored wallet" }, if *banned { "banned" } else { "left" }, c.left, c.session.listing + 1, c.rescans, c.s.revision() - revision
            );
            assert!(c.session.stopped.is_none() && c.session.listing != 0, "the loop lists from an honest node");
            assert_eq!(c.session.bad.contains(&0), *banned, "{what}: banned on evidence only — a short page is evidence, an unconfirmed tail is not");
            assert!(c.session.bad.iter().all(|n| *n == 0), "no honest node is ever banned");
            assert_eq!((c.left.len(), c.left[0].1), (1, 0), "{what}: one LEAVE, of the liar");
            assert_eq!(c.s.balances().confirmed, 16 * Q as u128);
            assert_eq!(c.s.spend_status(Some(20)).can_spend_now, new, "a restored wallet is under the embargo; a new one pays");
            // and it stays there: forty more rounds change nothing
            for _ in 0..40 {
                c.round(&alice.scan_key(), &mut |node, since| if node == 0 { liar(since) } else { chain.page(since) }, &mut || honest_reports(&chain));
            }
            assert!(c.session.listing != 0 && c.left.len() == 1 && c.s.confirmed_height() == Some(20) && c.s.scanned_height() == Some(20));
        }
    }
    // every node lies in a way that is evidence: the loop STOPS, says so, and keeps `bad`
    let mut c = LoopClient::new(wallet(true), 0);
    for _ in 0..10 {
        c.round(&alice.scan_key(), &mut |_, since| empty_page(since.max(A), since.max(A), 1_000_000), &mut || honest_reports(&chain));
    }
    assert_eq!((c.session.stopped.clone(), c.session.bad.len(), c.session.round), (Some(Stop::NoHonestListingNode), 3, 3), "three nodes, three short pages, three rounds: no honest listing node reachable — and the ban set is not cleared");
    assert!(c.s.scanned_height().is_none() && c.s.confirmed_height().is_none(), "the state holds nothing of a banned node");
}

/// **RW5-3, resolved.** As reviewed, `RESCAN(L)` blamed the node the client was listing from at
/// the moment a lie was DETECTED — after "L := next node (NO rescan)" an honest one, whose true
/// page disagreed with the liar's pages still in the state. One liar of three got both honest
/// nodes into `bad` and kept the session.
///
/// The restated loop **rescans whenever the listing node changes, unless everything the state
/// holds is confirmed** — so every unconfirmed page of a state is its current listing node's,
/// and the node that is banned is the node that lied. It bans on evidence only (a `listing:`
/// error, `leaf_mismatch`, a short page, `listing_refuted`); a node that merely does not get
/// the wallet to where the quorum is — an honest node that is behind, a liar with a true but
/// short listing — is LEFT, not banned.
///
/// The scenario is the review's, phase for phase (node 1 lies; the two honest nodes answer
/// truthfully in every round and are at most three blocks apart): no honest node is ever in
/// `bad`, the loop never stops, and every phase ends with the tip confirmed and the true
/// balance — the forged 50 XRGE payments are gone with the rescans.
#[test]
fn rw5_demo_one_lying_listing_node_gets_no_honest_node_blamed_and_the_tip_is_confirmed() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    chain.advance_to(20);
    let forged = shield_body(&chain, &alice.address(), 50 * Q, "rw5-loop-forged-1");
    let forged2 = shield_body(&chain, &alice.address(), 50 * Q, "rw5-loop-forged-2");
    let real: Vec<serde_json::Value> = chain.page_value(0, 20)["txs"].as_array().unwrap().clone();
    // the liar's listing from the start: a forged payment in front, every real leaf two further,
    // and a tip of 9 — below where the honest nodes are, so that nothing is comparable
    let short_forged = move |since: u64| -> ListingPage {
        if since > A {
            return empty_page(since, since, since - 1);
        }
        let mut txs = vec![listing_entry(&forged, A, 0, 0)];
        for t in &real {
            let mut t = t.clone();
            if t["height"].as_u64() == Some(A) {
                t["index"] = serde_json::json!(t["index"].as_u64().unwrap() + 1);
            }
            for j in 0..2 {
                t["outputs"][j]["leaf"] = serde_json::json!(t["outputs"][j]["leaf"].as_u64().unwrap() + 2);
            }
            txs.push(t);
        }
        parse(&serde_json::json!({ "active": true, "tip_height": 9, "from_height": A, "next_height": 10, "txs": txs }))
    };
    let mut s = WalletState::new(alice.address().pk);
    configure_as_sole_copy(&mut s, &[N1, N2, N3]);
    let mut c = LoopClient::new(s, 0); // node 1, the liar, is the first node of the list
    let key = alice.scan_key();
    let honest_only = |c: &LoopClient| c.session.bad.iter().all(|n| *n == 0) && c.session.stopped.is_none();
    let at_true_tip = |c: &LoopClient, chain: &Chain| c.s.confirmed_height() == Some(chain.height) && c.s.balances().confirmed == balance_of(chain, &alice) && c.s.balances().unverified == 0;

    // ---- phase 1: the liar's short forged listing. Its tip stays below the quorum's: after
    // STRIKES rounds it is left — WITH a rescan, because the state holds its unconfirmed pages.
    for _ in 0..STRIKES {
        assert_eq!(c.session.listing, 0);
        c.round(&key, &mut |_, since| short_forged(since), &mut || vec![chain.report(N2), chain.report(N3)]);
    }
    assert_eq!((c.session.listing, c.rescans, c.left.clone()), (1, 1, vec![(STRIKES as u64, 0, false, "behind the quorum's tip")]), "left, not banned: a short listing is no evidence");
    assert!(c.s.scanned_height().is_none() && c.s.balance() == 0, "nothing of the liar's listing is in the state the honest node is asked to continue");
    // node 2 (honest): one round, the tip is confirmed — its true page is applied to an EMPTY state
    c.round(&key, &mut |_, since| chain.page(since), &mut || vec![chain.report(N2), chain.report(N3)]);
    assert!(honest_only(&c) && at_true_tip(&c, &chain) && c.session.listing == 1, "phase 1 ends at the tip, listing from honest node 2; nobody is blamed");

    // ---- phase 2: the chain moves (somebody's pool transaction in block 22); honest node 2,
    // the listing node, is behind for STRIKES rounds. The liar tells the truth about the tip.
    let stale = chain.page_value(0, 20);
    let stale_n2 = chain.report(N2);
    chain.advance_to(21);
    let traffic = shield_body(&chain, &bob.address(), 3 * Q, "rw5-loop-traffic");
    chain.block(&[&traffic]).unwrap();
    chain.advance_to(23);
    for _ in 0..STRIKES {
        assert_eq!(c.session.listing, 1);
        c.round(&key, &mut |_, since| parse(&{ let mut p = stale.clone(); p["from_height"] = serde_json::json!(since); p["next_height"] = serde_json::json!(since.max(21)); p["txs"] = serde_json::json!([]); p }), &mut || vec![chain.report(N1), stale_n2.clone(), chain.report(N3)]);
    }
    assert_eq!((c.session.listing, c.rescans, c.left.len()), (2, 1, 2), "honest node 2 is LEFT (not banned), and WITHOUT a rescan: everything the state holds is confirmed");
    c.round(&key, &mut |_, since| chain.page(since), &mut || vec![chain.report(N1), chain.report(N2), chain.report(N3)]);
    assert!(honest_only(&c) && at_true_tip(&c, &chain) && c.session.bad.is_empty(), "phase 2 ends at the tip, listing from honest node 3");

    // ---- phase 3: node 3 falls behind in turn; the next node in the order is the liar, and the
    // state it is handed is confirmed to its last height. It adds a forged payment in block 24
    // and claims that as its tip: pool transactions in a block no quorum has.
    let stale_n3 = chain.report(N3);
    chain.advance_to(24);
    for _ in 0..STRIKES {
        c.round(&key, &mut |_, since| empty_page(since, since, 23), &mut || vec![chain.report(N1), chain.report(N2), stale_n3.clone()]);
    }
    assert_eq!((c.session.listing, c.rescans, c.left.len()), (0, 1, 3), "node 3 was behind: the next node is the liar; no rescan (nothing unconfirmed)");
    let leaves = c_leaves(&chain);
    let lie = move |since: u64| -> ListingPage {
        if since > 25 {
            return empty_page(since, since, since - 1);
        }
        parse(&serde_json::json!({ "active": true, "tip_height": 25, "from_height": since, "next_height": 26, "txs": [listing_entry(&forged2, 25, 0, leaves)] }))
    };
    for _ in 0..STRIKES {
        assert_eq!(c.session.listing, 0);
        c.round(&key, &mut |_, since| lie(since), &mut || vec![chain.report(N1), chain.report(N2), chain.report(N3)]);
    }
    assert_eq!((c.session.listing, c.rescans, c.left.last().copied().map(|l| (l.1, l.2, l.3))), (1, 2, Some((0, false, "listing_ahead"))), "the liar is left — with a rescan: its forged block was in the state");
    c.round(&key, &mut |_, since| chain.page(since), &mut || vec![chain.report(N1), chain.report(N2), chain.report(N3)]);
    assert!(honest_only(&c) && at_true_tip(&c, &chain), "phase 3 ends at the tip: the forged payment is gone with the rescan");

    // ---- phase 4: the chain reaches block 25 — with another transaction than the one the liar
    // listed there. Had the client still held the liar's block, the state check would now
    // REFUTE it; listing from the liar again, that is what happens, and it is the liar that is
    // banned: every unconfirmed page of the state is its own.
    let other = shield_body(&chain, &bob.address(), 2 * Q, "rw5-loop-traffic-2");
    chain.block(&[&other]).unwrap();
    let mut d = LoopClient::new(c.s.clone(), 0); // a new session that starts at the liar
    d.round(&key, &mut |_, since| lie(since), &mut || vec![chain.report(N1), chain.report(N2), chain.report(N3)]);
    assert_eq!((d.session.bad.iter().copied().collect::<Vec<_>>(), d.session.listing, d.left.clone()), (vec![0], 1, vec![(1, 0, true, "listing_refuted")]), "refuted while listing from the liar: the LIAR is banned");
    d.round(&key, &mut |_, since| chain.page(since), &mut || vec![chain.report(N1), chain.report(N2), chain.report(N3)]);
    assert!(at_true_tip(&d, &chain) && d.session.stopped.is_none());

    // ---- the rest of the session: sixty more rounds, the liar lying whenever it is asked
    for _ in 0..60 {
        c.round(&key, &mut |node, since| if node == 0 { short_forged(since) } else { chain.page(since) }, &mut || vec![chain.report(N1), chain.report(N2), chain.report(N3)]);
    }
    println!(
        "rw5-loop: one liar of three, honest nodes at most three blocks apart: bad = nodes {:?}, L = node {} (honest), stopped: {:?}, confirmed {:?} (the tip is {}), confirmed balance {} quanta (the chain holds {}), {} rescans, left: {:?}",
        c.session.bad.iter().map(|i| i + 1).collect::<Vec<_>>(), c.session.listing + 1, c.session.stopped, c.s.confirmed_height(), chain.height, c.s.balances().confirmed, balance_of(&chain, &alice), c.rescans, c.left
    );
    assert!(c.session.listing != 0 && honest_only(&c) && at_true_tip(&c, &chain), "sixty more rounds: the client lists from an honest node and the tip is confirmed");
}

/// The number of leaves of the chain's tree: where the next listed output is numbered.
fn c_leaves(chain: &Chain) -> u64 {
    chain.state().note_count
}

// ---------------------------------------------------------------------------------------------------
// Sound
// ---------------------------------------------------------------------------------------------------

/// **B — "an honest page after a lying one is accepted": nothing is planted.** A forged payment
/// in front of a listing, then the honest continuation (numbered below the wallet's tree):
/// applied and flagged. What that leaves: notes that are `unverified` and stay so; a pending
/// entry exactly as it was; no confirmed height above the last true one; a state check with
/// every honest node that REFUTES it. And a liar that serves the TRUTH under lower leaf numbers
/// is flagged, while the state it leaves is the chain's and confirms — the flag is advice to
/// rescan, not a judgement on the page.
#[test]
fn rw5_sound_an_accepted_page_after_a_lying_one_plants_nothing_that_can_be_confirmed() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    let mut w = WalletState::new(alice.address().pk);
    configure_as_sole_copy(&mut w, &[N1, N2, N3]);
    w.scan(&chain.page(0), &alice.scan_key()).unwrap();
    w.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    let confirmed_before = w.confirmed_height();
    let p_in = position_of(&w, 10 * Q);
    pay_with(&mut w, &alice, &[p_in], &bob.address(), 4 * Q, None, false, "rw5-b-t1").unwrap();
    let entry = w.pending()[0].clone();
    // the liar: a forged payment of 50 XRGE in block 5
    let forged = shield_body(&chain, &alice.address(), 50 * Q, "rw5-b-forged");
    w.scan(&parse(&serde_json::json!({ "active": true, "tip_height": 5, "from_height": 5, "next_height": 6, "txs": [listing_entry(&forged, 5, 0, 4)] })), &alice.scan_key()).unwrap();
    // the chain: a true payment of 2 XRGE in block 6, listed by an honest node at leaf 4
    chain.advance_to(5);
    fund(&mut chain, &alice.address(), &[2 * Q]);
    let r = w.scan(&chain.page(6), &alice.scan_key()).expect("the honest page is applied");
    assert!(r.leaf_mismatch, "and flagged");
    WalletState::from_json(&w.to_json().unwrap()).unwrap();
    let b = w.balances();
    assert_eq!((b.confirmed, b.unverified), (16 * Q as u128, 52 * Q as u128), "the forged 50 and the true 2 are unverified");
    assert!(w.pending().len() == 1 && (&w.pending()[0].nullifiers, &w.pending()[0].input_cms, &w.pending()[0].outputs, w.pending()[0].status) == (&entry.nullifiers, &entry.input_cms, &entry.outputs, PendingStatus::Pending));
    let c = w.confirm_state(&[chain.report(N1), chain.report(N2), chain.report(N3)]).unwrap();
    assert!(c.matched_height.is_none() && c.listing_refuted && w.confirmed_height() == confirmed_before, "no quorum confirms the mixture; the confirmed height stays");
    assert_eq!(w.resolve().still_pending, 1);
    assert!(select_inputs(&w, 40 * Q, Q).is_err(), "nothing unverified is offered");
    // the documented recovery
    let mut s = w.fresh_for_rescan();
    s.scan(&chain.page(0), &alice.scan_key()).unwrap();
    assert_eq!(s.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap().matched_height, Some(chain.height));
    assert_eq!((s.balances().confirmed, s.balances().locked), (18 * Q as u128, 10 * Q as u128));

    // the truth under lower leaf numbers
    let mut t = WalletState::new(alice.address().pk);
    configure(&mut t, &[N1, N2, N3]);
    t.scan(&parse(&chain.page_value(0, 4)), &alice.scan_key()).unwrap();
    let mut shifted = chain.page_value(5, chain.height);
    for tx in shifted["txs"].as_array_mut().unwrap() {
        for j in 0..2 {
            tx["outputs"][j]["leaf"] = serde_json::json!(tx["outputs"][j]["leaf"].as_u64().unwrap() - 2);
        }
    }
    assert!(t.scan(&parse(&shifted), &alice.scan_key()).unwrap().leaf_mismatch);
    assert_eq!(t.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap().matched_height, Some(chain.height), "the state is the chain's whatever the page called its leaves");
}

/// **Twin notes — as reviewed:** two notes with one commitment cannot be on the chain (a
/// commitment contains `rho = H_rho(nf1, nf2, j)` of the creating transaction, and no two
/// transactions share a nullifier, spec §2.4); they existed only in a LISTING that shows one
/// transaction twice, were stored, "one note to every rule" — and their one bad effect was
/// RW5-1 (b).
///
/// **Resolved: they do not exist in a state any more.** A page that lists a note of this wallet
/// with the `rho` of a note the state holds (or of one earlier in the page) is refused whole —
/// `listing:`, the state unchanged — whether it repeats the transaction as it is (a twin: one
/// commitment) or shows OTHER outputs under the same two nullifiers (another commitment, the
/// same nullifier: a hostile sender can make as many of those as it likes, and each would have
/// been "an input of the pending entry" that spends the real note). The test was edited: it
/// asserts the refusal, that the lock and the balances are what they were, and that a state
/// TEXT with two notes of one `rho` is refused on read and gives up its locks to
/// `recover_locks`.
#[test]
fn rw5_sound_twin_notes_a_listing_that_shows_a_transaction_twice_is_refused() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    let mut w = WalletState::new(alice.address().pk);
    configure_as_sole_copy(&mut w, &[N1, N2, N3]);
    w.scan(&chain.page(0), &alice.scan_key()).unwrap();
    w.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    let real = position_of(&w, 10 * Q);
    pay_with(&mut w, &alice, &[real], &bob.address(), 4 * Q, None, false, "rw5-twin-t1").unwrap();
    let before = w.clone();
    let creating = chain.page_value(0, chain.height)["txs"][0].clone();
    // (1) the liar lists the transaction that created the 10 XRGE note once more, in block 5
    let mut again = creating.clone();
    again["height"] = serde_json::json!(5);
    for j in 0..2 {
        again["outputs"][j]["leaf"] = serde_json::json!(4 + j);
    }
    // (2) … or another transaction with the SAME two nullifiers that pays the wallet 7 XRGE: a
    // different commitment, the same rho, so the same nullifier as the real note
    let nf = [hex::decode(creating["nf1"].as_str().unwrap()).unwrap(), hex::decode(creating["nf2"].as_str().unwrap()).unwrap()];
    let nfd = [digest_from_bytes(nf[0].as_slice().try_into().unwrap()).unwrap(), digest_from_bytes(nf[1].as_slice().try_into().unwrap()).unwrap()];
    let slot = (0..2).find(|j| creating["outputs"][*j]["cm_out"].as_str() == Some(hex::encode(w.note_at(real).unwrap().cm.0).as_str())).unwrap();
    let r = [7u8, 0, 0, 0].repeat(8);
    let r: [u8; 32] = r.try_into().unwrap();
    let pk = digest_from_bytes(&alice.address().pk).unwrap();
    let cm = digest_to_bytes(&Note { value: 7 * Q, pk, rho: derive_rho(&nfd, slot), r: digest_from_bytes(&r).unwrap() }.commitment());
    let (kem_ct, note_ct, _) = encrypt_note_with_kem_randomness(&alice.address().ek, &cm, 7 * Q, &r, [9u8, 0, 0, 0].repeat(8).try_into().unwrap()).unwrap();
    let mut other: ListedTx = parse(&serde_json::json!({ "active": true, "tip_height": 5, "from_height": 5, "next_height": 6, "txs": [again.clone()] })).txs[0].clone();
    other.outputs[slot] = ListedOutput { cm_out: hex::encode(cm), leaf: Some(4 + slot as u64), kem_ct: hex::encode(kem_ct), note_ct: hex::encode(note_ct) };
    let twin_page = parse(&serde_json::json!({ "active": true, "tip_height": 5, "from_height": 5, "next_height": 6, "txs": [again] }));
    let other_page = ListingPage { active: true, tip_height: 5, from_height: 5, next_height: 6, txs: vec![other] };
    for (what, page) in [("the same transaction again", &twin_page), ("other outputs under the same nullifiers", &other_page)] {
        for key in [alice.scan_key(), alice.incoming_viewing_key()] {
            let r = w.scan(page, &key);
            assert!(matches!(r, Err(WalletError::Listing(_))), "{what}: {:?}", r.map(|_| ()).map_err(|e| e.to_string()));
            assert!(w == before, "{what}: a refused page leaves the state as it was");
        }
    }
    // the lock, the balances and the stored text are what they were
    let b = w.balances();
    assert_eq!((b.confirmed, b.unverified, b.locked, b.spendable), (16 * Q as u128, 0, 10 * Q as u128, 6 * Q as u128));
    assert!(w.is_locked(real) && w.unspent().filter(|n| n.value == 10 * Q).count() == 1);
    // a state TEXT that holds two notes of one rho (written by an earlier revision of the core
    // from such a listing, or damaged) is refused on read — and gives up its locks
    let mut text: serde_json::Value = serde_json::from_str(&w.to_json().unwrap()).unwrap();
    let positions: Vec<u64> = text["notes"].as_array().unwrap().iter().map(|n| n[3].as_u64().unwrap()).collect();
    let free = (0..text["tree"]["note_count"].as_u64().unwrap()).find(|p| !positions.contains(p)).expect("four leaves, two notes");
    let mut copy = text["notes"][0].clone();
    copy[3] = serde_json::json!(free); // the same note at another position of the tree
    text["notes"].as_array_mut().unwrap().push(copy);
    assert!(matches!(WalletState::from_json(&text.to_string()), Err(WalletError::State(_))));
    let recovered = WalletState::recover_locks(&text.to_string()).unwrap();
    assert_eq!((recovered.entries_kept, recovered.entries_unreadable, recovered.state.pending().len()), (1, 0, 1));
    // the chain goes on; an honest listing confirms, the lock holds until it settles
    chain.advance_to(5);
    w.scan(&chain.page(w.next_height()), &alice.scan_key()).unwrap();
    assert_eq!(w.confirm_state(&[chain.report(N1), chain.report(N2), chain.report(N3)]).unwrap().matched_height, Some(5));
    assert_eq!((w.resolve().still_pending, w.balances().locked), (1, 10 * Q as u128));
}

/// **C — the longest expiry (128) against the embargo (128): no gap in any configuration the
/// core accepts.** With `base ≥ C_b` (no lag at all: every node at the tip) the embargo ends at
/// confirmed height `base + 128`, which is the last block a transaction built at `C_b` with the
/// longest expiry can be mined in: the restored device has READ that block when the gate opens.
/// Tried at the boundary: the gate is closed at `until − 1` (the transaction is still minable),
/// open at `until` (it is not), and a transaction mined in its very last block is seen — its
/// input is spent in the restored state — before the first spend is possible.
#[test]
fn rw5_sound_the_longest_expiry_and_the_embargo_meet_without_a_gap() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    chain.advance_to(40);
    let all = |chain: &Chain| vec![chain.report(N1), chain.report(N2), chain.report(N3)];
    let mut d1 = WalletState::new(alice.address().pk);
    configure_as_sole_copy(&mut d1, &[N1, N2, N3]);
    d1.scan(&chain.page(0), &alice.scan_key()).unwrap();
    d1.confirm_state(&all(&chain)).unwrap();
    let p_in = position_of(&d1, 10 * Q);
    let t1 = pay_with(&mut d1, &alice, &[p_in], &bob.address(), 4 * Q, Some(40 + MAX_EXPIRY_OFFSET), false, "rw5-c-t1").unwrap();
    assert!(pay_with(&mut d1.clone(), &alice, &[position_of(&d1, 6 * Q)], &bob.address(), Q, Some(40 + MAX_EXPIRY_OFFSET + 1), false, "rw5-c-far").is_err(), "129 is refused");
    // restored at once, no lag
    let mut d2 = WalletState::new(alice.address().pk);
    nodes_only(&mut d2, &[N1, N2, N3]);
    d2.scan(&chain.page(0), &alice.scan_key()).unwrap();
    d2.confirm_state(&all(&chain)).unwrap();
    assert_eq!(d2.spend_embargo_until(), Some(168));
    chain.advance_to(167);
    d2.scan(&chain.page(d2.next_height()), &alice.scan_key()).unwrap();
    d2.confirm_state(&all(&chain)).unwrap();
    assert!(d2.spend_gate().is_err() && expiry_of(&t1.body) >= chain.height + 1, "one block before the end the transaction is still minable and the gate is closed");
    chain.block(&[&t1.body]).unwrap(); // mined in its last valid block, 168
    d2.scan(&chain.page(d2.next_height()), &alice.scan_key()).unwrap();
    d2.confirm_state(&all(&chain)).unwrap();
    assert!(d2.spend_gate().is_ok(), "open at until");
    assert!(d2.unspent().all(|n| n.value != 10 * Q), "and the restored state has seen the spend");
    assert_eq!(d2.balances().spendable, (6 + 5) * Q as u128, "6, and t1's change (10 − 4 − 1)");
}
