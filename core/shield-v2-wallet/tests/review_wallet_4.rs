//! REVIEW_WALLET_4 — fourth independent review, of `fix/shield-v2-wallet-settlement-2` @ `e229cde`
//! (see `REVIEW_WALLET_4.md`). Nothing was fixed by the review.
//!
//! * `rw4_fN_…` — a confirmed defect; **fails on purpose** and asserts the safe behaviour;
//! * `rw4_demo_…` — a limit that is real and stated (passes; the assertions state the limit);
//! * `rw4_sound_…` — something that was attacked and holds (passes).
//!
//! Needs the `test-vectors` feature (proof-less deterministic assembly), like the earlier reviews.
#![cfg(feature = "test-vectors")]

mod common;

use common::*;
use quantum_vault_shield_v2_wallet::tx::{deterministic, UnprovenTx};
use quantum_vault_shield_v2_wallet::*;

const N1: &str = "node-1";
const N2: &str = "node-2";
const N3: &str = "node-3";

fn fund(chain: &mut Chain, to: &ShieldedAddress, values: &[u64]) {
    let key = fake_account_key(1);
    for (i, v) in values.iter().enumerate() {
        let req = ShieldRequest { ctx: chain.ctx(), from_pub_key: &key, nonce: 1, v_in: v + Q, fee: SHIELD_V2_MIN_FEE_QUANTA, recipient: to, max_fee: None };
        let tx = deterministic::shield(&req, &format!("rw4-fund-{}-{i}", chain.height)).unwrap();
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

/// The report of the node `id` for the tip of `chain`, as it is NOW (kept for later: what an
/// honest node that stopped at this height, or a liar replaying it, says).
fn report_now(chain: &Chain, id: &str) -> StateReport {
    chain.report(id)
}

fn position_of(s: &WalletState, value: u64) -> u64 {
    s.unspent().find(|n| n.value == value).expect("a note of that value").position
}

fn pay_with(state: &mut WalletState, keys: &ShieldedKeys, positions: &[u64], to: &ShieldedAddress, amount: u64, expiry_height: Option<u64>, label: &str) -> Result<UnprovenTx, WalletError> {
    let spend = SpendOptions { chain_id: CHAIN, inputs: positions, expiry_height, allow_unverified: false, max_fee: None };
    let (tx, next) = deterministic::transfer_locked(state, state.revision(), keys, &TransferParams { spend, recipient: to, amount, fee: Q }, label)?;
    *state = next;
    Ok(tx)
}

/// The node's rule for a V2 transaction in the next block, as far as the stand-in chain does not
/// apply it itself: spec §3.6 check 7, `expiry_height ≥ H` (bytes 34..42 of the body, little
/// endian). The pool rules (anchor window, nullifiers) are `Chain::block`'s.
fn mine(chain: &mut Chain, body: &[u8]) -> bool {
    let expiry = u64::from_le_bytes(body[34..42].try_into().unwrap());
    expiry >= chain.height + 1 && chain.block(&[body]).is_ok()
}

/// What the address can find on `chain` by scanning with its full key and no state: every note
/// delivered through a ciphertext that decrypts for it, whatever its size.
fn balance_of(chain: &Chain, keys: &ShieldedKeys) -> u128 {
    let mut s = WalletState::with_min_note_value(keys.address().pk, 1).unwrap();
    s.scan(&chain.page(0), &keys.scan_key()).unwrap();
    s.balance()
}

// ---------------------------------------------------------------------------------------------------
// RW4-5 (High; G4, G3 — and G1 through the restore it forces) — one listing page destroys the state.
// ---------------------------------------------------------------------------------------------------

/// A lock follows its note through a rescan: when the scan stores a note whose commitment is an
/// input of a pending entry, it writes the note's new leaf position into `entry.inputs[i]`
/// (`store.rs`, "a lock follows its note"). The OTHER input still holds the position it had in
/// the old listing. If the listing being scanned puts the first note at exactly that position —
/// and the scan call ends before the second note is found — the entry names one position twice.
/// `scan` returns `Ok`, `to_json` writes the state, and **`from_json` refuses it for ever**
/// ("a pending transaction is malformed"), as does every later `scan` of the in-memory state,
/// also after `fresh_for_rescan`. In the wasm surface every call that takes the state fails,
/// `rescan_state` and `summary` included: the client is left with `new_state` — a restore from
/// the phrase, which has no locks (RW3-10) — while the transaction that entry stood for is still
/// out there.
///
/// Honest listings never shift a leaf, so this needs a listing node that lies — ONE node, once:
/// forged transactions in front of a listing read from the start (the property test's own lie
/// no. 12) and a page that ends between the two notes. The rescan itself is what the documents
/// prescribe after `listing_refuted`, a `listing:` error, a migration or a change of the cap.
/// Found by running the shipped property test on more seeds (seed 203); this is the scenario
/// with nothing random in it.
#[test]
fn rw4_f5_one_shifted_listing_page_makes_a_state_with_a_two_input_payment_pending_unloadable_for_good() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[3 * Q, 4 * Q, 5 * Q, 6 * Q]);
    let mut w = WalletState::new(alice.address().pk);
    configure(&mut w, &[N1, N2, N3]);
    w.scan(&chain.page(0), &alice.scan_key()).unwrap();
    w.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    // two of the wallet's notes an even number of leaves apart (a transaction is two leaves)
    let notes: Vec<(u64, u64, u64)> = w.unspent().map(|n| (n.position, n.value, n.height)).collect();
    let (lo, hi) = notes
        .iter()
        .flat_map(|a| notes.iter().map(move |b| (*a, *b)))
        .find(|(a, b)| a.0 < b.0 && (b.0 - a.0) % 2 == 0)
        .expect("of four notes two are an even distance apart");
    let shift = hi.0 - lo.0;
    // an ordinary two-input payment, confirmed inputs, default expiry; submitted, and withheld
    let t1 = pay_with(&mut w, &alice, &[hi.0, lo.0], &bob.address(), lo.1 + hi.1 - 2 * Q, None, "rw4-f5-t1").unwrap();
    assert_eq!(w.pending()[0].inputs, vec![hi.0, lo.0]);
    WalletState::from_json(&w.to_json().unwrap()).expect("the state with the lock is a valid state");

    // the client rescans, as documented, and the node it lists from lies: `shift / 2` forged
    // transactions in front, every real leaf `shift` further, the page cut after the block of
    // the lower note
    let mut s = w.fresh_for_rescan();
    let mut page = chain.page_value(0, lo.2);
    let forged = shift / 2;
    let mut txs = Vec::new();
    for i in 0..forged {
        txs.push(listing_entry(&shield_body(&chain, &bob.address(), Q, &format!("rw4-f5-forged-{i}")), A, i, 2 * i));
    }
    for real in page["txs"].as_array().unwrap() {
        let mut real = real.clone();
        if real["height"].as_u64() == Some(A) {
            real["index"] = serde_json::json!(real["index"].as_u64().unwrap() + forged);
        }
        for j in 0..2 {
            real["outputs"][j]["leaf"] = serde_json::json!(real["outputs"][j]["leaf"].as_u64().unwrap() + shift);
        }
        txs.push(real);
    }
    page["txs"] = serde_json::json!(txs);
    let scanned = s.scan(&parse(&page), &alice.scan_key());
    assert!(scanned.is_ok(), "the page is accepted: nothing in it is malformed");
    let entry_inputs = s.pending()[0].inputs.clone();
    let json = s.to_json().expect("and the state is written");
    let loaded = WalletState::from_json(&json);
    // what the client can still do with what it has
    let next_page = s.clone().scan(&chain.page(s.next_height()), &alice.scan_key()).map(|_| ());
    let rescan_again = {
        let mut again = s.fresh_for_rescan();
        again.scan(&chain.page(0), &alice.scan_key()).map(|_| ())
    };
    println!(
        "two-input payment pending (inputs at leaves {:?}); one page from a lying node with every leaf shifted by {shift} and cut after block {}: scan ok; the entry now names leaves {entry_inputs:?}; \
         from_json of the state scan returned: {:?}; the next honest page: {:?}; fresh_for_rescan + an honest listing from the start: {:?}; the transaction is still valid until block {}",
        [hi.0, lo.0],
        lo.2,
        loaded.as_ref().map(|_| ()).map_err(|e| e.to_string()),
        next_page.as_ref().map_err(|e| e.to_string()),
        rescan_again.as_ref().map_err(|e| e.to_string()),
        t1.pending().unwrap().expiry_height,
    );
    assert!(loaded.is_ok(), "G4: a state that `scan` returned and `to_json` wrote cannot be read back — one lying page cost the wallet its state and the lock in it");
    assert!(next_page.is_ok() && rescan_again.is_ok(), "G3: and no call of the core recovers it");
}

// ---------------------------------------------------------------------------------------------------
// RW4-1 (Medium, G1) — the embargo after a restore, as documented, ends too early.
// ---------------------------------------------------------------------------------------------------

/// Spec §5.5 (W-17) and `NOTES.md` §6 item 7 (b): a restored device must "not offer a payment
/// until a height at least 128 blocks above the FIRST HEIGHT IT CONFIRMED after the restore is
/// confirmed — every transaction any earlier copy built has then been mined or can never be".
///
/// That sentence is true only if the first height confirmed after the restore is at or above the
/// confirmed height the earlier copy built at. With an odd number of configured nodes the two
/// quorums can overlap in a single node, and that node can be the liar: device 1 confirmed its
/// build height with {honest node 1, liar}; the restored device confirms its first height with
/// {honest node 2 — which is behind —, liar replaying a TRUE old state}. Nothing in that call
/// looks wrong (`quorum_tip` is the lagging height, no dissent, nothing ahead).
///
/// `lag`: how far honest node 2 is behind when the restored device first confirms.
/// `expiry_offset`: what device 1 passed as the expiry distance (`None`: the default, 64).
/// Returns (the payee's balance, what one payment is, whether the core refused the second build).
fn restore_embargo_scenario(lag: u64, expiry_offset: Option<u64>, tag: &str) -> (u128, u128, bool) {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    chain.advance_to(40);
    let behind = chain.height; // where honest node 2 will be standing later
    let old_n2 = report_now(&chain, N2);
    let old_n3 = report_now(&chain, N3); // the liar replays a TRUE state of this height
    let old_page = chain.page_value(0, behind);
    chain.advance_to(behind + lag);

    // ---- device 1: in sync, confirmed by honest node 1 and the liar (which tells the truth here)
    let mut d1 = WalletState::new(alice.address().pk);
    configure(&mut d1, &[N1, N2, N3]);
    d1.scan(&chain.page(0), &alice.scan_key()).unwrap();
    let c = d1.confirm_state(&[chain.report(N1), chain.report(N3)]).unwrap();
    assert_eq!(c.matched_height, Some(chain.height));
    let built_at = chain.height;
    let p10 = position_of(&d1, 10 * Q);
    let t1 = pay_with(&mut d1, &alice, &[p10], &bob.address(), 4 * Q, expiry_offset.map(|o| built_at + o), &format!("{tag}-t1")).unwrap();
    let t1_expiry = t1.pending().unwrap().expiry_height;
    assert_eq!(t1_expiry, built_at + expiry_offset.unwrap_or(DEFAULT_EXPIRY_OFFSET));
    // device 1 persists its state and submits t1 to the liar, which keeps it. Device 1 is lost.

    // ---- device 2: restored from the phrase. It lists from the liar, which serves the TRUE chain
    // up to the height honest node 2 has reached, and asks all three nodes.
    let mut d2 = WalletState::new(alice.address().pk);
    configure(&mut d2, &[N1, N2, N3]);
    d2.scan(&parse(&old_page), &alice.scan_key()).unwrap();
    let c = d2.confirm_state(&[chain.report(N1), old_n2.clone(), old_n3.clone()]).unwrap();
    assert_eq!(c.matched_height, Some(behind), "honest node 2 and the liar report the same true state for the height node 2 has reached");
    assert!(c.dissenting.is_empty() && !c.listing_refuted && !c.listing_ahead && !c.diverged, "nothing in the call asks the client to do anything");
    assert_eq!(c.quorum_tip, Some(behind), "and the documented fourth rule (confirmed height below quorum_tip ⇒ list elsewhere) does not apply");
    let first_confirmed = d2.confirmed_height().unwrap();
    let embargo_until = first_confirmed + MAX_EXPIRY_OFFSET; // the documented rule, to the letter

    // ---- the chain goes on; everybody catches up; device 2 follows the rules, with honest nodes only
    chain.advance_to(embargo_until);
    d2.scan(&chain.page(d2.next_height()), &alice.scan_key()).unwrap();
    let c = d2.confirm_state(&[chain.report(N1), chain.report(N2), chain.report(N3)]).unwrap();
    assert_eq!(c.matched_height, Some(embargo_until));
    assert!(d2.confirmed_height().unwrap() >= first_confirmed + MAX_EXPIRY_OFFSET, "the documented embargo is over");
    let t1_alive = t1_expiry > chain.height;

    // the user makes "the same" payment again; coin selection picks the 6 XRGE note (the smallest
    // that covers it) — not the note t1 spends, so nothing supersedes anything
    let sel = select_inputs(&d2, 4 * Q, Q).unwrap();
    assert_eq!(sel.positions, vec![position_of(&d2, 6 * Q)]);
    let t2 = match pay_with(&mut d2, &alice, &sel.positions, &bob.address(), 4 * Q, None, &format!("{tag}-t2")) {
        Ok(t) => t,
        Err(_) => return (balance_of(&chain, &bob), 4 * Q as u128, true), // a core that enforces a sufficient embargo
    };
    // the second payment goes to an honest node and is mined in the next block; the liar releases
    // t1 into the SAME block — if t1 is still inside its validity (spec §3.6 check 7)
    let h = chain.height + 1;
    let expiry_of = |body: &[u8]| u64::from_le_bytes(body[34..42].try_into().unwrap());
    assert!(expiry_of(&t2.body) >= h);
    let released = expiry_of(&t1.body) >= h && chain.block(&[&t2.body, &t1.body]).is_ok();
    if !released {
        assert!(mine(&mut chain, &t2.body));
    }
    println!(
        "{tag}: device 1 built at confirmed height {built_at}, expiry {t1_expiry}; the restored device first confirmed height {first_confirmed} (honest node 2 was {lag} blocks behind), \
         so its documented embargo ended at confirmed height {embargo_until}; t1 still minable then: {t1_alive}; t1 mined in the same block as the second payment: {released}; the payee holds {} quanta",
        balance_of(&chain, &bob)
    );
    (balance_of(&chain, &bob), 4 * Q as u128, false)
}

/// The default expiry (64 blocks) leaves the documented embargo a margin of 64 blocks of honest
/// lag. An honest node that is 70 blocks behind — restarted, re-syncing — is enough.
#[test]
fn rw4_f1_the_documented_restore_embargo_ends_while_an_earlier_default_expiry_transaction_is_still_minable() {
    let (paid, once, refused) = restore_embargo_scenario(70, None, "rw4-f1");
    assert!(refused || paid == once, "G1: the restored device followed spec §5.5 (b) to the letter and the payee holds {paid} quanta for one payment of {once}");
}

/// With the longest expiry the builders accept (128 blocks; `SpendOptions::expiry_height`) the
/// embargo has no margin at all: ONE block of honest lag is enough.
#[test]
fn rw4_f1b_with_the_maximum_expiry_one_block_of_honest_lag_defeats_the_documented_embargo() {
    let (paid, once, refused) = restore_embargo_scenario(1, Some(MAX_EXPIRY_OFFSET), "rw4-f1b");
    assert!(refused || paid == once, "G1: the restored device followed spec §5.5 (b) to the letter and the payee holds {paid} quanta for one payment of {once}");
}

/// The control: no lag between the two confirmations ⇒ the documented embargo is sufficient, also
/// for the maximum expiry (the earlier transaction's last valid block is confirmed when it ends).
#[test]
fn rw4_sound_without_lag_the_documented_embargo_is_sufficient() {
    for (i, offset) in [None, Some(MAX_EXPIRY_OFFSET)].into_iter().enumerate() {
        let (paid, once, refused) = restore_embargo_scenario(0, offset, &format!("rw4-sound-embargo-{i}"));
        assert!(!refused && paid == once);
    }
}

/// The embargo is not enforced by the core either: a state made by `WalletState::new` builds a
/// spend the moment it has a confirmed height. (Stated in the documents; here so that nobody
/// reads "the property test asserts it is sufficient" as "the core enforces it".)
#[test]
fn rw4_demo_the_restore_embargo_is_documentation_only() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q]);
    let mut restored = WalletState::new(alice.address().pk);
    configure(&mut restored, &[N1, N2, N3]);
    restored.scan(&chain.page(0), &alice.scan_key()).unwrap();
    restored.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    let p = position_of(&restored, 10 * Q);
    assert!(pay_with(&mut restored, &alice, &[p], &bob.address(), 4 * Q, None, "rw4-demo-embargo").is_ok(), "LIMIT: nothing in the core knows that this state was just restored");
}

// ---------------------------------------------------------------------------------------------------
// RW4-2 (Low, G2 by configuration) — IP literals: several spellings of one endpoint are several nodes.
// ---------------------------------------------------------------------------------------------------

/// `canonical_node_id` promises "two spellings of one endpoint are one node" (RW3-8). For host
/// NAMES it holds. For IP literals it does not: IPv6 zero compression and leading zeros, and the
/// IPv4 forms every URL parser accepts (`127.1`, `2130706433`, `0x7f.0.0.1`, `127.0.0.01`), are
/// distinct ids. Either one canonical id per address, or a refusal, would keep the promise.
#[test]
fn rw4_f2_ip_literal_spellings_of_one_endpoint_are_counted_as_several_nodes() {
    let count = |ids: &[&str]| -> Option<usize> {
        let mut s = WalletState::new([1u8; 32]);
        s.set_nodes(ids).ok().map(|n| n.len())
    };
    let v6 = count(&["https://[::1]:8443", "https://[0:0:0:0:0:0:0:1]:8443", "https://[::0001]:8443", "https://[0::1]:8443"]);
    let v4 = count(&["https://127.0.0.1", "https://127.1", "https://2130706433", "https://0x7f.0.0.1", "https://127.0.0.01"]);
    let mapped = count(&["https://[::ffff:127.0.0.1]", "https://[::ffff:7f00:1]"]);
    println!("one IPv6 endpoint in four spellings: {v6:?} node(s); one IPv4 endpoint in five spellings: {v4:?} node(s); one IPv4-mapped endpoint in two spellings: {mapped:?} node(s) (None: refused)");

    // what it is worth: two honest nodes and ONE liar, entered three times ⇒ the liar is a
    // majority of five and confirms its own forgery
    let alice = keys(PHRASE_1);
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q]);
    chain.advance_to(chain.height + 1);
    let mut page = chain.page_value(0, chain.height);
    let forged = shield_body(&chain, &alice.address(), 50 * Q, "rw4-f2-forged");
    page["txs"].as_array_mut().unwrap().push(listing_entry(&forged, chain.height, 0, chain.state().note_count));
    let liar = ["https://[2001:db8::1]:8443", "https://[2001:db8:0:0:0:0:0:1]:8443", "https://[2001:0db8::0001]:8443"];
    let mut w = WalletState::new(alice.address().pk);
    let configured = w.set_nodes(&["https://honest-1.example", "https://honest-2.example", liar[0], liar[1], liar[2]]);
    let forged_confirmed = match configured {
        Err(_) => 0, // refused: safe
        Ok(_) => {
            w.scan(&parse(&page), &alice.scan_key()).unwrap();
            let h = w.scanned_height().unwrap();
            let v = w.state_at(h).unwrap();
            let echo = |id: &str| StateReport { node_id: id.into(), height: h, tree_root: v.tree_root, nullifier_acc: v.nullifier_acc, note_count: v.note_count, nullifier_count: v.nullifier_count, ciphertext_acc: v.ciphertext_acc };
            let mut reports = vec![chain.report("https://honest-1.example"), chain.report("https://honest-2.example")];
            reports.extend(liar.iter().map(|id| echo(id)));
            let c = w.confirm_state(&reports).unwrap();
            println!("five ids = two honest nodes + one liar in three spellings: configured {}, quorum {}, agreeing {}, confirmed balance {} (the chain holds {})", c.configured, c.quorum, c.agreeing, w.balances().confirmed, 10 * Q);
            w.balances().confirmed
        }
    };
    assert!(v6.is_none_or(|n| n == 1) && v4.is_none_or(|n| n == 1) && mapped.is_none_or(|n| n == 1), "one endpoint is one node, or the spelling is refused: IPv6 {v6:?}, IPv4 {v4:?}, IPv4-mapped {mapped:?}");
    assert!(forged_confirmed <= 10 * Q as u128, "G2: one endpoint entered in three spellings confirmed a note that is on no chain");
}

/// What `canonical_node_id` does get right — host NAMES: every spelling of one origin is one id,
/// and everything a URL parser would read differently from the text is refused (user
/// information, a backslash before `@`, percent-encoding in either case, non-ASCII, an empty
/// label, an empty or impossible port, white space, an unclosed or zoned IPv6 literal). `http`
/// and `https` of one host, and two ports of one host, are different origins and therefore
/// different NODES — one operator with three votes if a client lists them (RW4-7).
#[test]
fn rw4_sound_canonical_node_id_for_host_names_and_what_it_refuses() {
    let id = |s: &str| canonical_node_id(s).ok();
    for s in ["https://Node.Example", "HTTPS://NODE.EXAMPLE./", "https://node.example:443/a/b?x=1#f", "https://node.example:0443", "https://node.example.?q", "https://node.example#@evil.example"] {
        assert_eq!(id(s).as_deref(), Some("https://node.example"), "{s}");
    }
    assert_eq!(id("http://node.example:80").as_deref(), Some("http://node.example"));
    assert_eq!(id("https://node.example:80").as_deref(), Some("https://node.example:80"), "port 80 on https is another origin");
    assert_eq!(id("https://xn--bcher-kva.example").as_deref(), Some("https://xn--bcher-kva.example"));
    for s in [
        "https://user@node.example", "https://user:pw@node.example", "https://node.example\\@evil.example", "https://evil.example%2f@node.example",
        "https://node%2eexample", "https://node%2Eexample", "https://b\u{fc}cher.example", "https://node.example..", "https://node.example:", "https://node.example:0",
        "https://node.example:65536", "https://node.example:+443", "https://.example", "https://-a.example", "https://node_1.example", "ftp://node.example",
        "node.example", "//node.example", "https:///x", "https://", " https://node.example", "https://node.example ", "https://node.example\t", "https://[::1",
        "https://[]", "https://[::1]x", "https://[fe80::1%25eth0]",
    ] {
        assert!(id(s).is_none(), "must be refused: {s:?} gave {:?}", id(s));
    }
    let mut w = WalletState::new([1u8; 32]);
    assert_eq!(w.set_nodes(&["http://node.example", "https://node.example", "https://node.example:8443"]).unwrap().len(), 3, "LIMIT: one host, three nodes");
    assert_eq!(w.quorum(), 2);
}

// ---------------------------------------------------------------------------------------------------
// RW4-3 (Low, G2) — a state scanned with the viewing key alone shows spent notes as confirmed money.
// ---------------------------------------------------------------------------------------------------

/// A background worker scans with the viewing key (`export_scan_key(seed, false)` — "the common
/// case", `NOTES.md` §8). It cannot see spends; it remembers every nullifier for later. Until a
/// page is applied with the full key, `balances()` — `confirmed` and `spendable`, the figures a
/// client shows and selects from — still contain a note another device has spent, at a height the
/// quorum has CONFIRMED. Nothing in `balances()`, `summary` or `select_inputs` says so.
#[test]
fn rw4_f3_a_viewing_key_state_reports_a_spent_note_as_confirmed_and_spendable() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    // the worker's state: viewing key only
    let mut watch = WalletState::new(alice.address().pk);
    configure(&mut watch, &[N1, N2, N3]);
    watch.scan(&chain.page(0), &alice.incoming_viewing_key()).unwrap();
    // the same phrase on another device spends the 10 XRGE note; mined
    let mut other = WalletState::new(alice.address().pk);
    other.scan(&chain.page(0), &alice.scan_key()).unwrap();
    confirm(&chain, &mut other);
    let p10 = position_of(&other, 10 * Q);
    let t = pay(&mut other, &alice, &[p10], &bob.address(), 9 * Q, "rw4-f3-other-device");
    chain.block(&[&t.body]).unwrap();
    // the worker follows, and all three nodes confirm its state at the tip
    watch.scan(&chain.page(watch.next_height()), &alice.incoming_viewing_key()).unwrap();
    let c = watch.confirm_state(&[chain.report(N1), chain.report(N2), chain.report(N3)]).unwrap();
    assert_eq!(c.matched_height, Some(chain.height));
    let truth = balance_of(&chain, &alice); // 6 XRGE: the 10 was spent with no change
    let b = watch.balances();
    let selectable = select_inputs(&watch, 8 * Q, Q).is_ok();
    println!(
        "viewing-key state, confirmed at the tip {}: confirmed {} / spendable {} quanta; the chain holds {truth}; a payment of 8 XRGE is planned from the spent note: {selectable}",
        chain.height, b.confirmed, b.spendable
    );
    // the full key repairs it — but only once a page is applied with it
    let mut full = watch.clone();
    full.scan(&chain.page(full.next_height()), &alice.scan_key()).unwrap();
    assert_eq!(full.balance(), truth, "an (empty) page with the full key applies the remembered spends");
    assert!(b.confirmed <= truth, "G2: confirmed balance {} exceeds the true balance {truth} at the confirmed height", b.confirmed);
}

// ---------------------------------------------------------------------------------------------------
// Sound: expiry from a stale confirmed height
// ---------------------------------------------------------------------------------------------------

/// The confirmed height lags the real tip by more than the expiry distance (the client did not
/// sync before the build; the pool was idle, so the root is still the confirmed one and the
/// build is allowed). The transaction is dead on arrival. The lock does not leak: the next state
/// check at the tip settles it as expired, and the retry is a single payment.
#[test]
fn rw4_sound_a_spend_built_on_a_stale_confirmed_height_is_dead_on_arrival_and_expires_cleanly() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q]);
    let mut w = WalletState::new(alice.address().pk);
    configure(&mut w, &[N1, N2, N3]);
    w.scan(&chain.page(0), &alice.scan_key()).unwrap();
    w.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    let c0 = w.confirmed_height().unwrap();
    chain.advance_to(c0 + 200); // the wallet does not look
    let p = position_of(&w, 10 * Q);
    let t1 = pay_with(&mut w, &alice, &[p], &bob.address(), 4 * Q, None, "rw4-stale-t1").unwrap();
    assert_eq!(t1.pending().unwrap().expiry_height, c0 + DEFAULT_EXPIRY_OFFSET);
    // anchor: still in the window (the pool was idle), but the expiry is 136 blocks in the past
    assert!(!mine(&mut chain, &t1.body), "the node refuses it: expired");
    assert!(w.is_locked(p) && w.resolve().still_pending == 1, "locked on the stale state");
    w.scan(&chain.page(w.next_height()), &alice.scan_key()).unwrap();
    assert_eq!(w.resolve().still_pending, 1, "a scanned height unlocks nothing");
    w.confirm_state(&[chain.report(N1), chain.report(N3)]).unwrap();
    let r = w.resolve();
    assert_eq!((r.expired.len(), r.still_pending), (1, 0));
    assert_eq!((w.balances().locked, w.balances().spendable), (0, 10 * Q as u128));
    let t2 = pay_with(&mut w, &alice, &[p], &bob.address(), 4 * Q, None, "rw4-stale-t2").unwrap();
    assert!(mine(&mut chain, &t2.body));
    assert!(!mine(&mut chain, &t1.body));
    assert_eq!(balance_of(&chain, &bob), 4 * Q as u128);
}

/// How long a spend stays usable when the confirmed height lags the tip, in a BUSY pool: with the
/// default expiry the next block must be at most the confirmed height + 64, and the anchor (the
/// root at the confirmed height) is accepted through the confirmed height + 128.
#[test]
fn rw4_sound_usable_window_of_a_spend_when_the_confirmed_height_lags_the_tip() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut results = Vec::new();
    for (lag, offset) in [(63u64, None), (64, None), (127, Some(MAX_EXPIRY_OFFSET)), (128, Some(MAX_EXPIRY_OFFSET))] {
        let mut chain = Chain::new();
        fund(&mut chain, &alice.address(), &[10 * Q]);
        let mut w = WalletState::new(alice.address().pk);
        configure(&mut w, &[N1, N2, N3]);
        w.scan(&chain.page(0), &alice.scan_key()).unwrap();
        w.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
        let c = w.confirmed_height().unwrap();
        // the pool is busy above the confirmed height: every block changes the root
        fund(&mut chain, &bob.address(), &vec![Q; lag as usize]);
        assert_eq!(chain.height, c + lag);
        let p = position_of(&w, 10 * Q);
        let t = pay_with(&mut w, &alice, &[p], &bob.address(), 4 * Q, offset.map(|o| c + o), &format!("rw4-window-{lag}")).unwrap();
        results.push((lag, offset.unwrap_or(DEFAULT_EXPIRY_OFFSET), mine(&mut chain, &t.body)));
    }
    println!("(blocks the tip is ahead of the confirmed height, expiry distance, accepted in the next block): {results:?}");
    assert_eq!(results, vec![(63, 64, true), (64, 64, false), (127, 128, true), (128, 128, false)]);
}

// ---------------------------------------------------------------------------------------------------
// The quorum: availability with small and even sets; what a minority can and cannot trigger
// ---------------------------------------------------------------------------------------------------

/// n = 2: quorum 2 — one unreachable node means no confirmation at all, and one contradicting
/// node "refutes" the listing (2 tolerates NO faulty node). n = 4: quorum 3 — it tolerates one
/// faulty node of any kind, exactly like n = 3: one liar AND one unreachable node stop everything.
#[test]
fn rw4_demo_availability_of_two_and_four_configured_nodes() {
    let alice = keys(PHRASE_1);
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q]);
    let synced = |ids: &[&str]| {
        let mut s = WalletState::new(alice.address().pk);
        configure(&mut s, ids);
        s.scan(&chain.page(0), &alice.scan_key()).unwrap();
        s
    };
    let lie = |id: &str| {
        let mut r = chain.report(id);
        r.note_count += 2;
        r
    };
    // n = 2
    let two = synced(&["a", "b"]);
    assert_eq!(two.quorum(), 2);
    let c = two.clone().confirm_state(&[chain.report("a")]).unwrap();
    assert!(c.matched_height.is_none() && c.quorum_tip.is_none(), "LIMIT: two nodes, one unreachable: nothing is confirmed, nothing can be built");
    let c = two.clone().confirm_state(&[chain.report("a"), lie("b")]).unwrap();
    assert!(c.matched_height.is_none() && c.listing_refuted, "LIMIT: with two nodes ONE contradiction says 'rescan elsewhere' although the listing is the chain's");
    assert_eq!(two.clone().confirm_state(&[chain.report("a"), chain.report("b")]).unwrap().matched_height, Some(chain.height));
    // n = 4
    let four = synced(&["a", "b", "c", "d"]);
    assert_eq!(four.quorum(), 3);
    let c = four.clone().confirm_state(&[chain.report("a"), chain.report("b"), lie("d")]).unwrap();
    assert!(c.matched_height.is_none() && !c.listing_refuted && c.diverged, "LIMIT: four nodes, one liar, one unreachable: two honest answers are not a quorum");
    let c = four.clone().confirm_state(&[chain.report("a"), chain.report("b"), chain.report("c"), lie("d")]).unwrap();
    assert!(c.matched_height == Some(chain.height) && !c.listing_refuted && c.dissenting.len() == 1);
    // n = 3 tolerates the same single fault with one node fewer
    let three = synced(&["a", "b", "c"]);
    assert_eq!(three.clone().confirm_state(&[chain.report("a"), chain.report("b")]).unwrap().matched_height, Some(chain.height));
}

/// For every size 2 … 9 and the largest strict minority of liars: whatever the liars report
/// (contradictions, equivocation, far heights, low heights, unconfigured aliases), with every
/// honest node answering for the tip the call (a) confirms the tip, (b) never says
/// `listing_refuted`, (c) puts `quorum_tip` at the tip and (d) never says `listing_ahead`.
#[test]
fn rw4_sound_a_strict_minority_cannot_trigger_refuted_or_ahead_or_move_the_quorum_tip() {
    let alice = keys(PHRASE_1);
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 3 * Q]);
    chain.advance_to(chain.height + 5);
    fund(&mut chain, &alice.address(), &[2 * Q]); // the last block changes the pool: `listing_ahead` has something to look at
    let tip = chain.height;
    let mut calls = 0;
    for n in 2..=9usize {
        let ids: Vec<String> = (0..n).map(|i| format!("https://n{i}.example")).collect();
        let mut base = WalletState::new(alice.address().pk);
        base.set_nodes(&ids).unwrap();
        base.scan(&chain.page(0), &alice.scan_key()).unwrap();
        let liars = n - base.quorum();
        assert!(2 * liars < n, "a strict minority");
        for behaviour in 0..8u8 {
            let mut reports: Vec<StateReport> = ids[liars..].iter().map(|id| chain.report(id)).collect();
            for id in &ids[..liars] {
                let mut r = chain.report(id);
                match behaviour {
                    0 => r.tree_root[0] ^= 1,
                    1 => r.ciphertext_acc[0] ^= 1,
                    2 => r.height = u64::MAX,
                    3 => r.height = 0,
                    4 => {
                        reports.push(r.clone()); // says two things about the tip
                        r.nullifier_acc[0] ^= 1;
                    }
                    5 => r.height = tip + 1,
                    6 => r.node_id = format!("{}/x?y#z", id.to_uppercase()), // the truth, under another spelling: still one vote
                    _ => {
                        r.height = tip - 1; // a true state under a wrong height
                    }
                }
                reports.push(r);
            }
            let mut s = base.clone();
            let c = s.confirm_state(&reports).unwrap();
            calls += 1;
            assert_eq!(c.matched_height, Some(tip), "n {n}, {liars} liars, behaviour {behaviour}");
            assert!(!c.listing_refuted && !c.listing_ahead && !c.diverged, "n {n}, {liars} liars, behaviour {behaviour}: {c:?}");
            assert_eq!(c.quorum_tip, Some(tip), "n {n}, {liars} liars, behaviour {behaviour}");
            assert!(c.dissenting.len() <= liars);
        }
    }
    println!("{calls} calls: a strict minority never refuted a true listing, never moved quorum_tip, never made it 'ahead'");
}

// ---------------------------------------------------------------------------------------------------
// Sound: checkpoints — several transactions in one block, and heights whose state was evicted
// ---------------------------------------------------------------------------------------------------

/// The property test mines one transaction per block. Here: three in one block, two in the next.
/// One checkpoint per height, the state reads back, the quorum confirms it.
#[test]
fn rw4_sound_several_transactions_in_one_block_are_one_checkpoint() {
    let alice = keys(PHRASE_1);
    let mut chain = Chain::new();
    let bodies: Vec<Vec<u8>> = (0..5).map(|i| shield_body(&chain, &alice.address(), (i + 2) * Q, &format!("rw4-multi-{i}"))).collect();
    chain.block(&[&bodies[0], &bodies[1], &bodies[2]]).unwrap();
    chain.advance_to(chain.height + 3);
    chain.block(&[&bodies[3], &bodies[4]]).unwrap();
    let mut w = WalletState::new(alice.address().pk);
    configure(&mut w, &[N1, N2, N3]);
    w.scan(&chain.page(0), &alice.scan_key()).unwrap();
    let back = WalletState::from_json(&w.to_json().unwrap()).expect("a state with several transactions per block reads back");
    assert_eq!(back, w);
    assert_eq!(w.confirm_state(&[chain.report(N1), chain.report(N3)]).unwrap().matched_height, Some(chain.height));
    assert_eq!(w.balances().confirmed, (2 + 3 + 4 + 5 + 6) * Q as u128);
    // the state inside the first block's height is the state after ALL three of its transactions
    assert_eq!(w.state_at(A).unwrap().note_count, 6);
    assert_eq!(w.state_at(A + 3).unwrap().note_count, 6);
}

/// 300 pool-changing heights are scanned without a state check: the state of the first 44 is
/// gone (256 kept). A report for one of those heights — true or forged — is "not comparable",
/// never a match and never a dissent; the confirmed height that was evicted refuses a build
/// (`state_unconfirmed`) until the tip is confirmed; nothing is stuck.
#[test]
fn rw4_sound_reports_for_heights_whose_state_was_evicted_confirm_nothing_and_refute_nothing() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q]);
    let mut w = WalletState::new(alice.address().pk);
    configure(&mut w, &[N1, N2, N3]);
    w.scan(&chain.page(0), &alice.scan_key()).unwrap();
    w.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    let c0 = w.confirmed_height().unwrap();
    let mut early = Vec::new();
    for i in 0..300u64 {
        fund(&mut chain, &bob.address(), &[Q]);
        if i == 10 {
            early = vec![chain.report(N1), chain.report(N2), chain.report(N3)]; // TRUE reports of an early height
        }
    }
    w.scan(&chain.page(w.next_height()), &alice.scan_key()).unwrap();
    assert!(w.state_at(c0).is_none() && w.state_at(early[0].height).is_none(), "evicted");
    let c = w.clone().confirm_state(&early).unwrap();
    assert!(c.matched_height.is_none() && c.not_comparable == 3 && c.dissenting.is_empty() && !c.listing_refuted && !c.diverged);
    // forged reports for an evicted height: the same
    let mut forged = early.clone();
    forged.iter_mut().for_each(|r| r.note_count += 2);
    let c = w.clone().confirm_state(&forged).unwrap();
    assert!(c.matched_height.is_none() && c.not_comparable == 3 && !c.listing_refuted);
    // the confirmed height is still c0, its state is evicted: no build on it
    assert_eq!(w.confirmed_height(), Some(c0));
    let p = position_of(&w, 10 * Q);
    assert!(matches!(pay_with(&mut w.clone(), &alice, &[p], &bob.address(), 4 * Q, None, "rw4-evicted-a"), Err(WalletError::StateUnconfirmed)));
    // the tip is confirmed: everything works again
    w.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    let t = pay_with(&mut w, &alice, &[p], &bob.address(), 4 * Q, None, "rw4-evicted-b").unwrap();
    assert!(mine(&mut chain, &t.body));
}

// ---------------------------------------------------------------------------------------------------
// RW4-4 (Medium, G3) — a hostile payee; and the pending record
// ---------------------------------------------------------------------------------------------------

/// **RW4-4 (Medium, G3).** A payee hands over an address made of the PAYER's own `pk` and the
/// payee's encryption key (the payer's `pk` is in every address the payer ever gave out). The
/// builder treats it as a payment to self (`recipient.pk == own.pk`), records the output with its
/// `r` and credits it from the record. So far nothing is wrong: the note is on the chain and it
/// is the wallet's (G2 holds; the "payee" can read it and cannot spend it).
///
/// But the note's ciphertext is encrypted to the PAYEE's key. Once the entry has settled, the
/// record is gone, and the only copy of `(value, r)` is the stored note. The next rescan — the
/// documented answer to `listing_refuted`, to a `listing:` error, to a migration — or a restore
/// from the phrase cannot find it again: the amount of the payment is gone from the wallet for
/// good, and no `below_minimum` / `over_capacity` counter says so. The safe behaviour: refuse a
/// recipient whose `pk` is the wallet's own and whose encryption key is not.
#[test]
fn rw4_f4_a_payee_address_with_the_payers_pk_strands_the_payment_at_the_next_rescan() {
    let (alice, mallory) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q]);
    let mut w = WalletState::new(alice.address().pk);
    configure(&mut w, &[N1, N2, N3]);
    w.scan(&chain.page(0), &alice.scan_key()).unwrap();
    w.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    let crafted = ShieldedAddress { pk: alice.address().pk, ek: mallory.address().ek };
    let p = position_of(&w, 10 * Q);
    let t = match pay_with(&mut w, &alice, &[p], &crafted, 4 * Q, None, "rw4-f4-crafted-payee") {
        Ok(t) => t,
        Err(e) => {
            println!("the builder refuses the crafted address: {e}");
            return; // the safe behaviour
        }
    };
    assert!(w.pending()[0].own_payment.is_some() && w.pending()[0].change.is_some());
    assert!(mine(&mut chain, &t.body));
    w.scan(&chain.page(w.next_height()), &alice.scan_key()).unwrap();
    w.confirm_state(&[chain.report(N1), chain.report(N2), chain.report(N3)]).unwrap();
    assert_eq!(w.resolve().mined.len(), 1);
    let before = w.balances().confirmed;
    assert_eq!((before, w.unspent().count()), (9 * Q as u128, 2), "credited once, from the record: 10 less the fee");
    assert_eq!(balance_of(&chain, &mallory), 0, "the payee holds nothing");
    // any later rescan (here: the documented recovery, against honest nodes only)
    let mut again = w.fresh_for_rescan();
    again.scan(&chain.page(0), &alice.scan_key()).unwrap();
    again.confirm_state(&[chain.report(N1), chain.report(N2), chain.report(N3)]).unwrap();
    let after = again.balances();
    println!(
        "paid 4 XRGE to an address with the payer's own pk and the payee's encryption key: settled as mined, confirmed {before} quanta; after a rescan against honest nodes: confirmed {} + unverified {} quanta,          below_minimum {:?}, over_capacity {:?}; the payee holds {}",
        after.confirmed, after.unverified, again.below_minimum(), again.over_capacity(), balance_of(&chain, &mallory)
    );
    assert_eq!(after.confirmed, before, "G3: a rescan against honest nodes lost {} quanta from view that the wallet owned a moment ago", before - after.confirmed);
}

/// The record credits an own output ONCE and only where the quorum has the transaction: a listing
/// that blanks its ciphertexts, or lists the transaction twice, is not confirmed.
#[test]
fn rw4_sound_own_outputs_from_the_record_are_credited_once_and_only_on_confirmed_data() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q]);
    let mut w = WalletState::new(alice.address().pk);
    configure(&mut w, &[N1, N2, N3]);
    w.scan(&chain.page(0), &alice.scan_key()).unwrap();
    w.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    let p = position_of(&w, 10 * Q);
    let t = pay_with(&mut w, &alice, &[p], &bob.address(), 4 * Q, None, "rw4-own-once").unwrap();
    assert!(mine(&mut chain, &t.body));
    // (a) the listing node blanks every ciphertext of the transaction: the record alone opens the change
    let mut page = chain.page_value(w.next_height(), chain.height);
    for j in 0..2 {
        page["txs"][0]["outputs"][j]["kem_ct"] = serde_json::json!("00".repeat(1088));
        page["txs"][0]["outputs"][j]["note_ct"] = serde_json::json!("00".repeat(56));
    }
    let mut blanked = w.clone();
    let r = blanked.scan(&parse(&page), &alice.scan_key()).unwrap();
    assert_eq!((r.own_outputs_from_record, blanked.balances().unverified), (1, 5 * Q as u128));
    let c = blanked.confirm_state(&[chain.report(N1), chain.report(N2), chain.report(N3)]).unwrap();
    assert!(c.matched_height.is_none() && c.listing_refuted && blanked.balances().confirmed == 0, "… and no quorum confirms that listing");
    // (b) the transaction listed twice: two unverified notes, nothing confirmed
    let mut twice = chain.page_value(0, chain.height);
    let dup = twice["txs"].as_array().unwrap().last().unwrap().clone();
    let mut dup2 = dup.clone();
    dup2["index"] = serde_json::json!(1);
    for j in 0..2 {
        dup2["outputs"][j]["leaf"] = serde_json::json!(dup["outputs"][j]["leaf"].as_u64().unwrap() + 2);
    }
    twice["txs"].as_array_mut().unwrap().push(dup2);
    let mut doubled = w.fresh_for_rescan();
    doubled.scan(&parse(&twice), &alice.scan_key()).unwrap();
    let c = doubled.confirm_state(&[chain.report(N1), chain.report(N2), chain.report(N3)]).unwrap();
    assert!(c.matched_height.is_none() && doubled.balances().confirmed == 0);
    // (c) the true listing: once, at its value
    let mut honest = w.fresh_for_rescan();
    honest.scan(&chain.page(0), &alice.scan_key()).unwrap();
    honest.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    assert_eq!(honest.resolve().mined.len(), 1);
    assert_eq!((honest.balances().confirmed, honest.unspent().count()), (5 * Q as u128, 1));
    assert_eq!(honest.balances().confirmed, balance_of(&chain, &alice));
}

/// A hostile sender cannot use the "own output" rule (stored whatever its size, whatever the
/// cap): that rule needs the transaction to spend a note of THIS wallet, or a pending record of
/// this wallet that opens the commitment. Dust from a stranger stays out, also when the stranger
/// sends it in the same block as a transaction of the wallet, and also on a restore.
#[test]
fn rw4_sound_a_hostile_sender_cannot_ride_the_own_output_rule_past_the_dust_minimum_or_the_cap() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 5 * Q]);
    let mut w = WalletState::with_limits(alice.address().pk, Q, 3).unwrap();
    configure(&mut w, &[N1, N2, N3]);
    w.scan(&chain.page(0), &alice.scan_key()).unwrap();
    w.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    // the wallet pays 8.5 of 10: its own change is 0.5 XRGE (below the minimum)
    let p = position_of(&w, 10 * Q);
    let t = pay_with(&mut w, &alice, &[p], &bob.address(), 8 * Q + Q / 2, None, "rw4-dust-own").unwrap();
    // the stranger's dust and cap-filling notes, in the SAME block, before and after it
    let dust_a = shield_body(&chain, &alice.address(), Q / 4, "rw4-dust-a");
    let dust_b = shield_body(&chain, &alice.address(), Q / 3, "rw4-dust-b");
    let fill: Vec<Vec<u8>> = (0..4).map(|i| shield_body(&chain, &alice.address(), Q, &format!("rw4-fill-{i}"))).collect();
    chain.block(&[&dust_a, &t.body, &dust_b, &fill[0], &fill[1], &fill[2], &fill[3]]).unwrap();
    for restore in [false, true] {
        let mut s = if restore { WalletState::with_limits(alice.address().pk, Q, 3).unwrap() } else { w.clone() };
        if restore {
            configure(&mut s, &[N1, N2, N3]);
        }
        s.scan(&chain.page(s.next_height()), &alice.scan_key()).unwrap();
        s.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
        s.resolve();
        let values: Vec<u64> = {
            let mut v: Vec<u64> = s.unspent().map(|n| n.value).collect();
            v.sort();
            v
        };
        // own change 0.5 stored; the 5; the cap of 3 unspent notes from others lets one or two of the four 1-XRGE notes in
        assert!(values.contains(&(Q / 2)) && values.contains(&(5 * Q)), "restore {restore}: {values:?}");
        assert!(!values.contains(&(Q / 4)) && !values.contains(&(Q / 3)), "restore {restore}: a stranger's dust is not stored: {values:?}");
        assert_eq!(s.below_minimum().count, 2, "restore {restore}");
        assert!(s.over_capacity().count >= 2 && values.iter().filter(|v| **v == Q).count() <= 2, "restore {restore}: the cap holds for a stranger: {values:?}, {:?}", s.over_capacity());
        assert!(s.balances().confirmed <= balance_of(&chain, &alice));
    }
}

// ---------------------------------------------------------------------------------------------------
// Demo: the wallet's own SHIELD below the minimum note value is a stranger's dust to it
// ---------------------------------------------------------------------------------------------------

/// "Own outputs are stored whatever their size" covers the change and the payment-to-self of a
/// transfer or unshield (the pending record, or a transaction that spends a note of the wallet).
/// A `shield_v2` to the wallet's own address has neither: `build_shield` accepts any note value
/// above zero, and a note below the state's minimum is counted in `below_minimum` and is in no
/// balance. The client must not offer a shield whose note (`v_in − fee`) is below the minimum.
#[test]
fn rw4_demo_a_shield_to_ones_own_address_below_the_minimum_note_value_is_not_stored() {
    let alice = keys(PHRASE_1);
    let mut chain = Chain::new();
    let own_shield = shield_body(&chain, &alice.address(), Q / 2, "rw4-own-small-shield");
    chain.block(&[&own_shield]).unwrap();
    let mut w = WalletState::new(alice.address().pk);
    configure(&mut w, &[N1, N2, N3]);
    w.scan(&chain.page(0), &alice.scan_key()).unwrap();
    w.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    assert_eq!((w.balances().confirmed, w.below_minimum().count, balance_of(&chain, &alice)), (0, 1, Q as u128 / 2), "LIMIT: the user shielded 0.5 XRGE and the wallet shows nothing");
}

// ---------------------------------------------------------------------------------------------------
// Demo: the revision is a counter, not an identity
// ---------------------------------------------------------------------------------------------------

/// Two tabs load revision r. Each builds a payment from a DIFFERENT note: both results are
/// "revision r + 1" and hold different locks. `expect_revision` cannot tell them apart — the
/// stored revision (tab A's r + 1) matches tab B's un-persisted state. What protects the lock is
/// only the storage-side compare-and-swap against the revision the tab LOADED (r), and a client
/// that never keeps working on a state it failed to persist.
#[test]
fn rw4_demo_two_different_states_carry_the_same_revision() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    let mut stored = WalletState::new(alice.address().pk);
    configure(&mut stored, &[N1, N2, N3]);
    stored.scan(&chain.page(0), &alice.scan_key()).unwrap();
    stored.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    let loaded = stored.revision();
    let (mut tab_a, mut tab_b) = (stored.clone(), stored.clone());
    let (p10, p6) = (position_of(&stored, 10 * Q), position_of(&stored, 6 * Q));
    pay_with(&mut tab_a, &alice, &[p10], &bob.address(), 4 * Q, None, "rw4-tab-a").unwrap();
    pay_with(&mut tab_b, &alice, &[p6], &bob.address(), 4 * Q, None, "rw4-tab-b").unwrap();
    assert_eq!((tab_a.revision(), tab_b.revision()), (loaded + 1, loaded + 1));
    assert!(!tab_a.content_eq(&tab_b));
    // tab A persisted first. Tab B, with its un-persisted state in hand, "reads the stored revision
    // and passes it as expected_revision" (NOTES §6 item 3): the check passes
    let stored_revision = tab_a.revision();
    assert!(tab_b.expect_revision(stored_revision).is_ok(), "LIMIT: the revision check alone accepts tab B's divergent state");
    assert!(!tab_b.is_locked(p10), "LIMIT: and that state does not hold tab A's lock");
    // the rule that does protect it: compare-and-swap against the revision the tab LOADED
    assert_ne!(stored_revision, loaded, "tab B's write is refused by a storage CAS on the revision it loaded");
}
