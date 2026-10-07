//! REVIEW_WALLET_5 — fifth independent review, of `fix/shield-v2-wallet-settlement-3` @ `43166fb`
//! (see `REVIEW_WALLET_5.md`). Nothing was fixed by the review.
//!
//! * `rw5_fN_…` — a confirmed defect; **fails on purpose** and asserts the safe behaviour, so that
//!   a fix turns it green without editing it;
//! * `rw5_demo_…` — a limit that is real (passes; the assertions STATE the limit). The limits of
//!   the client loop of `NOTES.md` §6 are demonstrated with a literal transcription of that loop
//!   ([`LoopClient`]): the loop is prose and the property test's client is private to its file,
//!   so no test here can turn green by a change of either;
//! * `rw5_sound_…` — something that was attacked and holds (passes).
//!
//! Needs the `test-vectors` feature (proof-less deterministic assembly), like the earlier reviews.
#![cfg(feature = "test-vectors")]

mod common;

use std::collections::BTreeSet;

use common::*;
use quantum_vault_shield_v2_wallet::store::ListedTx;
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
    configure(&mut w, &[N1, N2, N3]);
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
    configure(&mut d1, &ids);
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

/// The user's statement is honoured only if the establishing call shows no configured node above
/// the height being confirmed. Two consequences, both stated here as they are:
///
/// (a) **An honest user loses it to an ordinary race, for good.** A NEW wallet (the statement is
/// true), three honest nodes, one of them one block ahead when they are asked: the statement is
/// disregarded, the state is under the embargo for 129 blocks, and the statement cannot be made
/// again ("accepted only before the first confirmed state check").
///
/// (b) **It protects nobody from a liar.** The attack of RW4-1 with the statement made (falsely:
/// the lost device has a payment in flight) and the honest node at the tip not answering in
/// that one call: nothing is "ahead", the statement is honoured, and one block of honest lag is
/// a double payment. A false statement is the user's — the point is that the conditional rule
/// buys nothing for it: the liar only has to wait for a call in which the leading node is slow.
#[test]
fn rw5_demo_the_override_is_lost_to_a_one_block_race_and_honoured_when_the_leading_node_is_silent() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    // (a)
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    chain.advance_to(40);
    let mut w = WalletState::new(alice.address().pk);
    configure(&mut w, &[N1, N2, N3]); // nodes + the statement, as a UI does for a new wallet
    w.scan(&chain.page(0), &alice.scan_key()).unwrap();
    let (r1, r2) = (chain.report(N1), chain.report(N2));
    chain.advance_to(41); // a block arrives while the three answers are collected
    let c = w.confirm_state(&[r1, r2, chain.report(N3)]).unwrap();
    assert_eq!((c.matched_height, c.embargo_base_set), (Some(40), true));
    assert_eq!(w.spend_embargo(), SpendEmbargo::Until { first_confirmed: 40, base: 41, until: 41 + 128, waived: false });
    assert!(matches!(w.spend_gate(), Err(WalletError::RestoredRecently { until: Some(169) })));
    assert!(w.assert_no_other_copy_has_a_pending_payment().is_err(), "and the statement cannot be made again");
    let left = w.spend_status(Some(41)).embargo_blocks_left;
    println!("rw5-override (a): a new wallet with a true statement, one honest node one block ahead in the first state check: embargo, {left:?} blocks of confirmed height to go; the statement is refused from now on");

    // (b)
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    chain.advance_to(40);
    let (old_n2, old_n3, old_page) = (chain.report(N2), chain.report(N3), chain.page_value(0, 40));
    chain.advance_to(41); // honest node 2 is ONE block behind
    let mut d1 = WalletState::new(alice.address().pk);
    configure(&mut d1, &[N1, N2, N3]);
    d1.scan(&chain.page(0), &alice.scan_key()).unwrap();
    d1.confirm_state(&[chain.report(N1), chain.report(N3)]).unwrap();
    let p_in = position_of(&d1, 10 * Q);
    let t1 = pay_with(&mut d1, &alice, &[p_in], &bob.address(), 4 * Q, None, false, "rw5-override-t1").unwrap();
    let mut d2 = WalletState::new(alice.address().pk);
    configure(&mut d2, &[N1, N2, N3]); // the statement — false here
    d2.scan(&parse(&old_page), &alice.scan_key()).unwrap();
    let c = d2.confirm_state(&[old_n2, old_n3]).unwrap(); // node 1 did not answer in this call
    assert_eq!(c.matched_height, Some(40));
    assert_eq!(d2.spend_embargo(), SpendEmbargo::Until { first_confirmed: 40, base: 40, until: 40, waived: true });
    let sel = select_inputs(&d2, 4 * Q, Q).unwrap();
    let t2 = pay_with(&mut d2, &alice, &sel.positions, &bob.address(), 4 * Q, None, false, "rw5-override-t2").expect("no embargo: the statement was honoured");
    chain.block(&[&t2.body, &t1.body]).unwrap();
    assert_eq!(balance_of(&chain, &bob), 8 * Q as u128, "the payee is paid twice");
    println!("rw5-override (b): the statement made on a restored device, the leading honest node silent in the first state check, the other ONE block behind: honoured; the payee holds {} quanta for one payment of {}", balance_of(&chain, &bob), 4 * Q);
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
// The client loop of NOTES.md §6, transcribed.
// ---------------------------------------------------------------------------------------------------

/// `NOTES.md` §6, "The client loop (normative)", steps 1 to 4, line for line. `page(node, since)`
/// is what the node listed from answers; `reports()` what the nodes answer to step 2.
struct LoopClient {
    s: WalletState,
    /// `L`
    l: usize,
    bad: BTreeSet<usize>,
    ahead: u32,
    behind: u32,
    /// `R`: (round, report)
    r: Vec<(u64, StateReport)>,
    round: u64,
    nodes: usize,
    /// "Every node in bad → stop and tell the user"
    stopped: bool,
    rescans: u32,
}

impl LoopClient {
    fn new(s: WalletState, l: usize) -> Self {
        let nodes = s.nodes().len();
        Self { s, l, bad: BTreeSet::new(), ahead: 0, behind: 0, r: Vec::new(), round: 0, nodes, stopped: false, rescans: 0 }
    }

    /// `L := next node not in bad`
    fn next_listing(&mut self) {
        if self.bad.len() >= self.nodes {
            self.stopped = true;
            return;
        }
        for k in 1..=self.nodes {
            let next = (self.l + k) % self.nodes;
            if !self.bad.contains(&next) {
                self.l = next;
                break;
            }
        }
    }

    /// `RESCAN(L): bad += L; S := rescan_state(S); L := next node not in bad`
    fn rescan(&mut self) {
        self.bad.insert(self.l);
        self.s = self.s.fresh_for_rescan();
        self.rescans += 1;
        self.next_listing();
        (self.ahead, self.behind) = (0, 0);
    }

    fn round(&mut self, key: &ScanKey, page: &mut dyn FnMut(usize, u64) -> ListingPage, reports: &mut dyn FnMut() -> Vec<StateReport>) {
        if self.stopped {
            return;
        }
        self.round += 1;
        // 1. pages from L until at_tip or a page budget
        let mut at_tip = false;
        for _ in 0..4 {
            match self.s.scan(&page(self.l, self.s.next_height()), key) {
                Ok(r) if r.leaf_mismatch => return self.rescan(),
                Ok(r) if r.at_tip => {
                    at_tip = true;
                    break;
                }
                Ok(_) => {}
                Err(WalletError::Listing(_)) | Err(WalletError::RescanRequired) => return self.rescan(),
                Err(e) => panic!("the loop has no rule for this error of scan: {e}"),
            }
        }
        // 2. every node is asked; the reports of the last three rounds
        let now = self.round;
        self.r.retain(|(round, _)| round + 2 >= now);
        self.r.extend(reports().into_iter().map(|r| (now, r)));
        let handed_in: Vec<StateReport> = self.r.iter().map(|(_, r)| r.clone()).collect();
        // 3. confirm_state and its rules
        let c = self.s.confirm_state(&handed_in).unwrap();
        if c.listing_refuted {
            return self.rescan();
        }
        if c.listing_ahead {
            self.ahead += 1;
            if self.ahead >= 3 {
                self.rescan();
            }
            return;
        }
        self.ahead = 0;
        if at_tip && c.quorum_tip.is_some_and(|t| self.s.confirmed_height().is_none_or(|h| h < t)) {
            self.behind += 1;
            if self.behind >= 2 {
                self.next_listing();
                self.behind = 0;
            }
        } else {
            self.behind = 0;
        }
        // 4. resolve_pending
        self.s.resolve();
    }
}

/// **RW5-2.** The loop changes the listing node on three signals: a refuted listing, a listing
/// that stays ahead, and — `at_tip` — a confirmed height that stays below the quorum's tip. A
/// listing node that never lets the client reach ITS tip triggers none of them:
///
/// (a) pages that make no progress and claim a tip far away (`next_height = from_height`,
/// `tip_height` = a million): accepted by `scan` (each one a new revision to persist), never
/// `at_tip`; nothing is ever comparable, nothing is confirmed, and "no match and none of the
/// above → wait and repeat: NOTHING else". Two honest nodes answer every round; the wallet
/// shows nothing, and settles nothing, for as long as the session lasts — and the next session
/// starts with the same first node.
///
/// (b) the TRUE listing to the tip, then empty heights above it: the state check matches at the
/// true tip, the core says a spend can be built — and the loop's own condition for a payment
/// ("confirmed_height = scanned_height") is never met. It ends when somebody else's pool
/// transaction is mined (the liar's empty heights are then refuted) — on a chain that makes a
/// block only when somebody transacts.
#[test]
fn rw5_demo_a_listing_node_that_never_reaches_its_tip_is_never_left_by_the_documented_loop() {
    let alice = keys(PHRASE_1);
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    chain.advance_to(20);
    let honest_reports = |chain: &Chain| vec![chain.report(N2), chain.report(N3)]; // node 1 is the liar; it is silent
    let new_wallet = || {
        let mut s = WalletState::new(alice.address().pk);
        configure(&mut s, &[N1, N2, N3]);
        s
    };
    // (a)
    let mut c = LoopClient::new(new_wallet(), 0);
    let revision = c.s.revision();
    for _ in 0..40 {
        c.round(&alice.scan_key(), &mut |node, since| if node == 0 { empty_page(since.max(A), since.max(A), 1_000_000) } else { chain.page(since) }, &mut || honest_reports(&chain));
    }
    println!(
        "rw5-loop (a): 40 rounds listing from a node whose pages make no progress: L is node {}, bad {:?}, confirmed {:?}, scanned {:?}, {} state revisions written, stopped: {}",
        c.l + 1, c.bad, c.s.confirmed_height(), c.s.scanned_height(), c.s.revision() - revision, c.stopped
    );
    assert!(c.l == 0 && c.bad.is_empty() && !c.stopped && c.s.confirmed_height().is_none(), "the loop never leaves the stalling node");
    assert!(c.s.revision() - revision >= 160, "and every page is a new revision to persist");
    // the same wallet, listing from an honest node: one round
    let mut h = LoopClient::new(new_wallet(), 1);
    h.round(&alice.scan_key(), &mut |_, since| chain.page(since), &mut || honest_reports(&chain));
    assert_eq!(h.s.confirmed_height(), Some(20));

    // (b)
    let mut c = LoopClient::new(new_wallet(), 0);
    for _ in 0..40 {
        let truth = |since: u64| chain.page(since);
        c.round(&alice.scan_key(), &mut |node, since| if node == 0 && since > 20 { empty_page(since, since + 1, 1_000_000) } else { truth(since) }, &mut || honest_reports(&chain));
    }
    let st = c.s.spend_status(Some(20));
    println!(
        "rw5-loop (b): 40 rounds listing from a node that serves the truth and then empty heights: L is node {}, confirmed {:?}, scanned {:?}; the core says can_spend_now = {}; \
         the loop's condition for a payment (confirmed = scanned) holds: {}",
        c.l + 1, c.s.confirmed_height(), c.s.scanned_height(), st.can_spend_now, c.s.confirmed_height() == c.s.scanned_height()
    );
    assert!(c.l == 0 && c.bad.is_empty() && c.s.confirmed_height() == Some(20) && c.s.scanned_height() > Some(100));
    assert!(st.can_spend_now && c.s.confirmed_height() != c.s.scanned_height(), "the core would build; the loop never offers the payment");
}

/// **RW5-3.** `RESCAN(L)` blames the node the client is listing from at the moment a lie is
/// DETECTED. After "L := next node (NO rescan)" that is not the node that told it: the state
/// still holds the liar's pages, the honest node's page disagrees with them (`leaf_mismatch` —
/// deviation B — or, without a pool transaction in the page, `listing_refuted`), and the HONEST
/// node goes into `bad`. The liar never does: a forged listing that claims a tip below the
/// honest nodes' is never comparable, so it is never refuted and never "ahead".
///
/// Three nodes, ONE liar, and nothing else than what the model allows (the two honest nodes one
/// or two blocks apart for two rounds): both honest nodes end in `bad`, the client lists from
/// the liar for the rest of the session, and "every node in bad → stop and tell the user" never
/// fires, because the liar is not in it. The honest nodes answered truthfully in every round.
#[test]
fn rw5_demo_one_lying_listing_node_gets_both_honest_nodes_blamed_and_keeps_the_session() {
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
    configure(&mut s, &[N1, N2, N3]);
    let mut c = LoopClient::new(s, 0); // node 1, the liar, is the first node of the list
    let key = alice.scan_key();

    // ---- phase 1: the liar's short forged listing; then the loop moves on, WITHOUT a rescan
    for _ in 0..2 {
        c.round(&key, &mut |_, since| short_forged(since), &mut || vec![chain.report(N2), chain.report(N3)]);
    }
    assert!(c.l == 1 && c.bad.is_empty() && c.rescans == 0, "two rounds behind the quorum's tip: list from the next node, no rescan");
    // node 2 (honest) is listed from; its page is true; the state it is applied to is not
    c.round(&key, &mut |_, since| chain.page(since), &mut || vec![chain.report(N2), chain.report(N3)]);
    assert_eq!((c.bad.iter().copied().collect::<Vec<_>>(), c.l, c.rescans), (vec![1], 2, 1), "the listing is refuted while the client lists from HONEST node 2: node 2 is blamed");
    c.round(&key, &mut |_, since| chain.page(since), &mut || vec![chain.report(N2), chain.report(N3)]);
    assert_eq!(c.s.confirmed_height(), Some(20), "node 3 (honest): rescanned, confirmed at the tip");

    // ---- phase 2: the chain moves (somebody's pool transaction in block 22); node 3 is behind
    // for two rounds. The liar tells the truth about the tip — it may.
    let stale_n3 = chain.report(N3);
    chain.advance_to(21);
    let traffic = shield_body(&chain, &bob.address(), 3 * Q, "rw5-loop-traffic");
    chain.block(&[&traffic]).unwrap();
    chain.advance_to(23);
    for _ in 0..2 {
        c.round(&key, &mut |_, since| parse(&chain.page_value(since, 20)), &mut || vec![chain.report(N1), chain.report(N2), stale_n3.clone()]);
    }
    assert!(c.l == 0 && c.rescans == 1, "node 3 was two rounds behind the quorum's tip: the next node NOT IN BAD is the liar");

    // ---- phase 3: the liar adds a forged payment in block 21 and stops at its "tip"; the loop
    // moves on to node 3 again — which has caught up, and whose true page (block 22 at the
    // chain's leaf numbers) is numbered below the wallet's tree
    let lie = |since: u64| -> ListingPage {
        if since > 21 {
            return empty_page(since, since, since - 1);
        }
        parse(&serde_json::json!({ "active": true, "tip_height": 21, "from_height": 21, "next_height": 22, "txs": [listing_entry(&forged2, 21, 0, 4)] }))
    };
    for _ in 0..2 {
        c.round(&key, &mut |_, since| lie(since), &mut || vec![chain.report(N1), chain.report(N2), chain.report(N3)]);
    }
    assert!(c.l == 2 && c.rescans == 1, "behind again: on to node 3");
    c.round(&key, &mut |_, since| chain.page(since), &mut || vec![chain.report(N1), chain.report(N2), chain.report(N3)]);
    assert_eq!((c.bad.iter().copied().collect::<Vec<_>>(), c.l, c.rescans, c.stopped), (vec![1, 2], 0, 2, false), "leaf_mismatch on HONEST node 3's page: node 3 is blamed; the only node not in bad is the liar");

    // ---- phase 4: the rest of the session
    for _ in 0..60 {
        c.round(&key, &mut |_, since| short_forged(since), &mut || vec![chain.report(N1), chain.report(N2), chain.report(N3)]);
    }
    println!(
        "rw5-loop: one liar of three, honest nodes at most three blocks apart: bad = nodes {:?} (both honest), L = node {} (the liar), stopped: {}, confirmed {:?}, unverified balance {} quanta (the chain holds {})",
        c.bad.iter().map(|i| i + 1).collect::<Vec<_>>(), c.l + 1, c.stopped, c.s.confirmed_height(), c.s.balances().unverified, balance_of(&chain, &alice)
    );
    assert!(c.l == 0 && !c.stopped && c.bad.len() == 2 && c.s.confirmed_height().is_none(), "sixty more rounds: the client lists from the liar and nothing is confirmed");
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
    configure(&mut w, &[N1, N2, N3]);
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

/// **Twin notes.** Two notes with one commitment cannot be on the chain: a commitment contains
/// `rho = H_rho(nf1, nf2, j)` of the creating transaction, and no two transactions share a
/// nullifier (spec §2.4). They exist only in a LISTING that shows one transaction twice. Then:
/// both are stored, the second one unverified for ever (no quorum has that tree); one nullifier,
/// so one spend marks both; a lock on one is a lock on both; coin selection offers the confirmed
/// one only; a transaction from both is refused (it would publish one nullifier twice). After
/// the rescan there is one note. Nothing is double-counted in a confirmed figure, nothing lost.
#[test]
fn rw5_sound_twin_notes_exist_only_in_a_lying_listing_and_are_one_note_to_every_rule() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    let mut w = WalletState::new(alice.address().pk);
    configure(&mut w, &[N1, N2, N3]);
    w.scan(&chain.page(0), &alice.scan_key()).unwrap();
    w.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    // the liar lists the transaction that created the 10 XRGE note once more, in block 5
    let mut again = chain.page_value(0, chain.height)["txs"][0].clone();
    again["height"] = serde_json::json!(5);
    for j in 0..2 {
        again["outputs"][j]["leaf"] = serde_json::json!(4 + j);
    }
    w.scan(&parse(&serde_json::json!({ "active": true, "tip_height": 5, "from_height": 5, "next_height": 6, "txs": [again] })), &alice.scan_key()).unwrap();
    let twins: Vec<(u64, bool)> = w.unspent().filter(|n| n.value == 10 * Q).map(|n| (n.position, n.confirmed)).collect();
    assert_eq!(twins.len(), 2);
    let (real, twin) = (twins.iter().find(|t| t.1).unwrap().0, twins.iter().find(|t| !t.1).unwrap().0);
    assert_eq!(w.note_at(real).unwrap().cm, w.note_at(twin).unwrap().cm);
    assert_eq!(w.note_at(real).unwrap().nullifier, w.note_at(twin).unwrap().nullifier);
    let b = w.balances();
    assert_eq!((b.confirmed, b.unverified, b.spendable), (16 * Q as u128, 10 * Q as u128, 16 * Q as u128), "G2: the twin is in no confirmed figure");
    assert_eq!(select_inputs(&w, 12 * Q, Q).unwrap().positions.len(), 2, "selection uses the two CONFIRMED notes (10 + 6), never the twin");
    assert!(select_inputs(&w, 17 * Q, Q).is_err());
    // a transaction from both twins: refused
    let mut both = w.clone();
    assert!(pay_with(&mut both, &alice, &[real, twin], &bob.address(), 15 * Q, None, true, "rw5-twin-both").is_err());
    // a payment from the real one (on the unconfirmed root: the caller's explicit decision)
    pay_with(&mut w, &alice, &[real], &bob.address(), 4 * Q, None, true, "rw5-twin-t1").unwrap();
    assert!(w.is_locked(real) && w.is_locked(twin), "G1: a lock on the note is a lock on its twin");
    let mut other = w.clone();
    assert!(matches!(pay_with(&mut other, &alice, &[twin], &bob.address(), 4 * Q, None, true, "rw5-twin-t2").err(), Some(WalletError::NoteLocked)));
    WalletState::from_json(&w.to_json().unwrap()).unwrap();
    // no quorum confirms the listing with the repeated transaction; the rescan has one note
    chain.advance_to(5);
    assert!(w.confirm_state(&[chain.report(N1), chain.report(N2), chain.report(N3)]).unwrap().matched_height.is_none());
    let mut s = w.fresh_for_rescan();
    s.scan(&chain.page(0), &alice.scan_key()).unwrap();
    s.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    assert_eq!((s.unspent().filter(|n| n.value == 10 * Q).count(), s.balances().confirmed, s.balances().locked), (1, 16 * Q as u128, 10 * Q as u128));
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
    configure(&mut d1, &[N1, N2, N3]);
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
