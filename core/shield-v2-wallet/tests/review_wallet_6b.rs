//! REVIEW_WALLET_6B — the confirmation checks of REVIEW_WALLET_6 run again on the fix
//! (`fix/shield-v2-wallet-settlement-5` @ `dc35299`; see `REVIEW_WALLET_6B.md`). Nothing was
//! fixed by the review.
//!
//! * `rw6b_fN_…` — a defect; **fails on purpose** and asserts the safe behaviour;
//! * `rw6b_demo_…` — a limit that is real (passes; the assertions STATE the limit);
//! * `rw6b_sound_…` — something that was attacked and holds (passes).
//!
//! The loop is driven through the reference client of the fix (`LoopClient::round_with`).
//! (One more failing test is in `core/shield-v2-wasm/tests/review_wallet_6b.rs`: it needs the
//! WebAssembly surface.)
//!
//! Needs the `test-vectors` feature, like the earlier reviews.
#![cfg(feature = "test-vectors")]

mod common;

use common::client_loop::{Decision, LoopClient, Session, Stats, Stop, FIRST_CHECK_ROUNDS, STRIKES};
use common::*;
use quantum_vault_shield_v2::reference::{derive_rho, digest_from_bytes, digest_to_bytes, Note};
use quantum_vault_shield_v2_wallet::note_enc::encrypt_note_with_kem_randomness;
use quantum_vault_shield_v2_wallet::tx::{deterministic, UnprovenTx};
use quantum_vault_shield_v2_wallet::*;
use serde_json::{json, Value};

const IDS: [&str; 5] = ["node-1", "node-2", "node-3", "node-4", "node-5"];

fn fund(chain: &mut Chain, to: &ShieldedAddress, values: &[u64]) {
    let key = fake_account_key(1);
    for (i, v) in values.iter().enumerate() {
        let req = ShieldRequest { ctx: chain.ctx(), from_pub_key: &key, nonce: 1, v_in: v + Q, fee: SHIELD_V2_MIN_FEE_QUANTA, recipient: to, max_fee: None };
        let tx = deterministic::shield(&req, &format!("rw6b-fund-{}-{i}", chain.height)).unwrap();
        chain.block(&[&tx.body]).unwrap();
    }
}

fn shield_body(chain: &Chain, to: &ShieldedAddress, value: u64, label: &str) -> Vec<u8> {
    let req = ShieldRequest { ctx: chain.ctx(), from_pub_key: &fake_account_key(2), nonce: 1, v_in: value + Q, fee: Q, recipient: to, max_fee: None };
    deterministic::shield(&req, label).unwrap().body
}

fn parse(page: &Value) -> ListingPage {
    ListingPage::from_json(&page.to_string()).unwrap()
}

fn empty_page(from: u64, next: u64, tip: u64) -> ListingPage {
    parse(&json!({ "active": true, "tip_height": tip, "from_height": from, "next_height": next, "txs": [] }))
}

fn inactive_page(since: u64, tip: u64) -> ListingPage {
    parse(&json!({ "active": false, "tip_height": tip, "from_height": since, "next_height": since, "txs": [] }))
}

fn position_of(s: &WalletState, value: u64) -> u64 {
    s.unspent().find(|n| n.value == value).expect("a note of that value").position
}

fn pay_with(state: &mut WalletState, keys: &ShieldedKeys, positions: &[u64], to: &ShieldedAddress, amount: u64, label: &str) -> Result<UnprovenTx, WalletError> {
    let spend = SpendOptions { chain_id: CHAIN, inputs: positions, expiry_height: None, allow_unverified: false, max_fee: None };
    let (tx, next) = deterministic::transfer_locked(state, state.revision(), keys, &TransferParams { spend, recipient: to, amount, fee: Q }, label)?;
    *state = next;
    Ok(tx)
}

fn wallet(alice: &ShieldedKeys, n: usize, new: bool) -> WalletState {
    let mut s = WalletState::new(alice.address().pk);
    if new {
        configure_as_sole_copy(&mut s, &IDS[..n]);
    } else {
        configure(&mut s, &IDS[..n]);
    }
    s
}

fn report(chain: &Chain, i: usize) -> StateReport {
    chain.report(IDS[i])
}

fn lie(mut r: StateReport) -> StateReport {
    r.nullifier_acc[5] ^= 1;
    r
}

fn canon(tag: u8, k: u32) -> [u8; 32] {
    let mut b = [0u8; 32];
    b[0] = tag;
    b[4..7].copy_from_slice(&k.to_le_bytes()[..3]);
    b[8] = 0x5a;
    b
}

/// A listed transaction that pays `to` a note that opens (anybody who knows the address can make
/// one), at `height`, leaves `leaf` and `leaf + 1`.
fn forged_tx(to: &ShieldedAddress, value: u64, salt: u32, height: u64, leaf: u64) -> Value {
    let nf = [canon(1, 2 * salt), canon(1, 2 * salt + 1)];
    let nfd = [digest_from_bytes(&nf[0]).unwrap(), digest_from_bytes(&nf[1]).unwrap()];
    let r = canon(7, salt);
    let cm = digest_to_bytes(&Note { value, pk: digest_from_bytes(&to.pk).unwrap(), rho: derive_rho(&nfd, 0), r: digest_from_bytes(&r).unwrap() }.commitment());
    let mut rnd = [0u8; 32];
    rnd[..4].copy_from_slice(&salt.to_le_bytes());
    let (kem_ct, note_ct, _) = encrypt_note_with_kem_randomness(&to.ek, &cm, value, &r, rnd).unwrap();
    json!({
        "height": height, "index": 0, "tx_hash": hex::encode(canon(3, salt)), "tx_type": "shielded_transfer_v2",
        "nf1": hex::encode(nf[0]), "nf2": hex::encode(nf[1]),
        "outputs": [
            { "cm_out": hex::encode(cm), "leaf": leaf, "kem_ct": hex::encode(kem_ct), "note_ct": hex::encode(note_ct) },
            { "cm_out": hex::encode(canon(9, salt)), "leaf": leaf + 1, "kem_ct": "00".repeat(1088), "note_ct": "00".repeat(56) },
        ],
    })
}

/// The truth, with the transactions of block `was` listed in block `was + 1`.
fn shifted(chain: &Chain, since: u64, was: u64) -> ListingPage {
    if since > was + 1 {
        return empty_page(since, since, was + 1);
    }
    let mut p = chain.page_value(since, was + 1);
    for tx in p["txs"].as_array_mut().unwrap().iter_mut().filter(|tx| tx["height"] == was) {
        tx["height"] = json!(was + 1);
    }
    parse(&p)
}

fn stats(reports: Vec<StateReport>) -> Stats {
    Stats { reports, active: Vec::new() }
}

// ---------------------------------------------------------------------------------------------------
// Check 2 — RW6-1, the attribution rule.
// ---------------------------------------------------------------------------------------------------

/// `ConfirmReport::refuted` against a lying minority, n = 3 and n = 5, on a TRUE state: whatever
/// the liars report — a wrong state for every height the wallet has, twice, contradicting
/// themselves, under ids that are not configured, with every honest node silent or with the
/// honest nodes answering — nothing is refuted, above or below the confirmed height. "A majority
/// of the reports" is not a majority of the configured nodes.
#[test]
fn rw6b_sound_a_minority_of_the_configured_nodes_never_refutes_however_many_reports_it_sends() {
    let alice = keys(PHRASE_1);
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    let mut at = vec![(chain.height, report(&chain, 0))];
    for h in 5..=20 {
        if h % 3 == 0 {
            let b = shield_body(&chain, &alice.address(), Q + h, &format!("rw6b-minority-{h}"));
            chain.block(&[&b]).unwrap();
        } else {
            chain.advance_to(h);
        }
        at.push((chain.height, report(&chain, 0)));
    }
    for n in [3usize, 5] {
        let liars = n - (n / 2 + 1);
        for honest_answer in [false, true] {
            let mut s = wallet(&alice, n, true);
            s.scan(&chain.page(0), &alice.scan_key()).unwrap();
            // confirmed in the middle first, so that there are heights on both sides
            let mid: Vec<StateReport> = (0..n).map(|i| StateReport { node_id: node(IDS[i]), ..at[8].1.clone() }).collect();
            assert_eq!(s.confirm_state(&mid).unwrap().matched_height, Some(at[8].0));
            let mut reports = Vec::new();
            for i in 0..liars {
                for (_, r) in &at {
                    let mut wrong = lie(StateReport { node_id: node(IDS[i]), ..r.clone() });
                    reports.push(wrong.clone());
                    wrong.note_count += 1; // … and a second, different one for the same height
                    reports.push(wrong.clone());
                    wrong.node_id = "https://not-configured.example".into();
                    reports.push(wrong);
                }
            }
            if honest_answer {
                reports.extend((liars..n).map(|i| report(&chain, i)));
            }
            let c = s.confirm_state(&reports).unwrap();
            assert!(!c.listing_refuted && !c.confirmed_refuted && !c.listing_refuted_above_confirmed && c.refuted.is_empty(), "n = {n}, honest answering {honest_answer}: {:?}", c.refuted);
            assert_eq!(c.dissenting.len(), liars * at.len(), "every lie is shown as dissent, and that is all it is");
            assert_eq!(s.confirmed_height(), Some(if honest_answer { chain.height } else { at[8].0 }));
        }
    }
}

/// **The consequence the Resolution of REVIEW_WALLET_6 stated, measured — restated after
/// REVIEW_WALLET_6C** (section 5: "that test demonstrates a limit that no longer exists in that
/// form; restate it (assert 'left, not banned, at the cap')"). The scenario is the review's,
/// unchanged; the asserted outcome is the new one.
///
/// After the rescan that blamed nobody the liar lists the TRUTH into the empty state: nothing is
/// left to refute, and it is never banned for it. One opportunity is: a block with a pool
/// transaction and one more block between two rounds (anybody can make both, at one fee each),
/// and ONE honest node one block behind in one round. Per opportunity the client throws its
/// state away and reads the chain again (`D + 1` rounds); between two of them the tip IS
/// confirmed.
///
/// As first written this asserted the limit: five opportunities, five rescans, no ban, no
/// LEAVE, the liar the listing node throughout. With the cap per tenure (`K` = 3 rescans that
/// blamed nobody on one listing node) the liar is **left, not banned, at its third** — in round
/// 9 — and the next node lists. (The scenario's listing does not depend on who is asked, so
/// the opportunities that follow fall on the next node and are counted for it, from zero.)
#[test]
fn rw6b_demo_a_liar_that_lists_the_truth_after_the_blameless_rescan_is_left_not_banned_at_the_cap() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    chain.advance_to(20);
    let key = alice.scan_key();
    let mut c = LoopClient::new(wallet(&alice, 3, true), 0); // node 1, the liar, lists
    c.round_with(&key, &mut |_, since| Some(chain.page(since)), &mut || stats((0..3).map(|i| report(&chain, i)).collect()));
    assert_eq!(c.s.confirmed_height(), Some(20));
    for cycle in 1..=5u32 {
        let h = chain.height + 1;
        let x = shield_body(&chain, &bob.address(), Q + cycle as u64, &format!("rw6b-again-{cycle}"));
        chain.block(&[&x]).unwrap(); // block h: somebody's pool transaction
        let lagging = report(&chain, 2); // honest node 3 is here for one more round
        chain.advance_to(h + 1);
        // round A: block h's transaction listed in h + 1; the liar and honest node 2 vouch for h + 1
        c.round_with(&key, &mut |_, since| Some(shifted(&chain, since, h)), &mut || stats(vec![report(&chain, 0), report(&chain, 1), lagging.clone()]));
        assert_eq!((c.s.confirmed_height(), c.s.scanned_height()), (Some(h + 1), Some(h + 1)), "cycle {cycle}: the late listing is confirmed");
        // round B: every honest node at the tip; the liar contradicts height h
        let mut wrong = lie(lagging.clone());
        wrong.node_id = node(IDS[0]);
        c.round_with(&key, &mut |_, since| Some(shifted(&chain, since, h)), &mut || stats(vec![wrong.clone(), report(&chain, 1), report(&chain, 2)]));
        assert_eq!((c.rescans, c.s.scanned_height()), (cycle, None), "cycle {cycle}: a confirmed height is contradicted — rescan, nobody blamed");
        // round C: the liar lists the truth
        c.round_with(&key, &mut |_, since| Some(chain.page(since)), &mut || stats((0..3).map(|i| report(&chain, i)).collect()));
        assert_eq!((c.s.confirmed_height(), c.s.scanned_height()), (Some(h + 1), Some(h + 1)), "cycle {cycle}: the tip is confirmed again");
        assert!(c.session.bad.is_empty() && c.session.stopped.is_none(), "cycle {cycle}: nobody is banned for it: {:?}", c.left);
        if cycle < STRIKES {
            assert!(c.left.is_empty() && c.session.listing == 0, "cycle {cycle}: below the cap the liar is not left, and lists: {:?}", c.left);
        } else {
            // the cap: left — not banned — at the K-th rescan that blamed nobody, in round 3·K
            assert_eq!((c.left.clone(), c.session.listing), (vec![(3 * STRIKES as u64, 0, false, "rescans that blamed nobody")], 1), "cycle {cycle}: left, not banned, at the cap");
        }
    }
    println!("rw6b-again: 5 opportunities, {} rescans that blamed nobody, banned {:?}, LEAVEs {:?}, the listing node is node {}", c.rescans, c.session.bad, c.left, c.session.listing + 1);
}

// ---------------------------------------------------------------------------------------------------
// Check 3 — RW6-2: more corruptions of a page; what a fault leaves behind.
// ---------------------------------------------------------------------------------------------------

/// Thirty-odd corruptions the table-driven test of the Resolution does not contain — of the
/// TEXT of a page (duplicate keys, nesting, tokens that are not JSON, escapes, numbers at the
/// edge of `u64`), of its shape, and of the range it claims — on a synced state with a payment
/// pending and on an empty one, with both keys. `ListingPage::from_json` + `scan` answer `Ok` (a
/// well-formed lie, or no lie) or `listing:`, nothing else, never a panic, and a refused page
/// leaves the state as it was.
#[test]
fn rw6b_sound_thirty_more_corruptions_of_a_page_are_listing_errors_or_well_formed() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    let mut synced = wallet(&alice, 3, true);
    synced.scan(&chain.page(0), &alice.scan_key()).unwrap();
    synced.confirm_state(&[report(&chain, 0), report(&chain, 1)]).unwrap();
    let p10 = position_of(&synced, 10 * Q);
    pay_with(&mut synced, &alice, &[p10], &bob.address(), 4 * Q, "rw6b-corrupt").unwrap();
    let x = shield_body(&chain, &alice.address(), 3 * Q, "rw6b-corrupt-x");
    chain.block(&[&x]).unwrap();
    chain.advance_to(chain.height + 2);
    let tip = chain.height;
    type Edit = Box<dyn Fn(&Value) -> String>;
    let set = |path: &'static [&'static str], v: Value| -> Edit {
        Box::new(move |p: &Value| {
            let mut p = p.clone();
            let mut at = &mut p;
            for k in path {
                at = if let Ok(i) = k.parse::<usize>() { &mut at[i] } else { &mut at[*k] };
            }
            *at = v.clone();
            p.to_string()
        })
    };
    // a raw token where a value stands: the value is set to a sentinel and the sentinel replaced
    let raw = |path: &'static [&'static str], token: &'static str| -> Edit {
        let inner = set(path, json!("@@SENTINEL@@"));
        Box::new(move |p: &Value| inner(p).replace("\"@@SENTINEL@@\"", token))
    };
    let text = |f: fn(String) -> String| -> Edit { Box::new(move |p: &Value| f(p.to_string())) };
    let edits: Vec<(&str, Edit)> = vec![
        ("a duplicate key (active)", text(|s| s.replacen('{', "{\"active\":true,", 1))),
        ("a duplicate key (txs)", text(|s| s.replacen('{', "{\"txs\":[],", 1))),
        ("txs nested 300 deep", raw(&["txs"], Box::leak(format!("{}{}", "[".repeat(300), "]".repeat(300)).into_boxed_str()))),
        ("a megabyte of text as nf1", Box::new(|p: &Value| { let mut p = p.clone(); p["txs"][0]["nf1"] = json!("a".repeat(1 << 20)); p.to_string() })),
        ("NaN as tip_height", raw(&["tip_height"], "NaN")),
        ("Infinity as next_height", raw(&["next_height"], "Infinity")),
        ("-0 as from_height", raw(&["from_height"], "-0")),
        ("1e3 as tip_height", raw(&["tip_height"], "1e3")),
        ("2^64 as tip_height", raw(&["tip_height"], "18446744073709551616")),
        ("a number of a thousand digits as a height", raw(&["txs", "0", "height"], Box::leak("9".repeat(1000).into_boxed_str()))),
        ("nf1 with an escape that spells an upper-case digit", raw(&["txs", "0", "nf1"], Box::leak(format!("\"\\u0041{}\"", "a".repeat(63)).into_boxed_str()))),
        ("nf1 with an escaped NUL", raw(&["txs", "0", "nf1"], Box::leak(format!("\"\\u0000{}\"", "a".repeat(63)).into_boxed_str()))),
        ("a lone surrogate in tx_hash", raw(&["txs", "0", "tx_hash"], "\"\\ud800\"")),
        ("text after the page", text(|s| s + "xyz")),
        ("a second page after the page", text(|s| s.clone() + &s)),
        ("a byte-order mark in front", text(|s| format!("\u{feff}{s}"))),
        ("the page in an array", text(|s| format!("[{s}]"))),
        ("null", text(|_| "null".into())),
        ("nothing", text(|_| String::new())),
        ("a comment in the page", text(|s| s.replacen('{', "{/* a comment */", 1))),
        ("single quotes", text(|s| s.replace('"', "'"))),
        ("txs an object", set(&["txs"], json!({}))),
        ("txs null", set(&["txs"], Value::Null)),
        ("active as text", set(&["active"], json!("true"))),
        ("active as a number", set(&["active"], json!(1))),
        ("three outputs", Box::new(|p: &Value| { let mut p = p.clone(); let o = p["txs"][0]["outputs"][0].clone(); p["txs"][0]["outputs"].as_array_mut().unwrap().push(o); p.to_string() })),
        ("one output", Box::new(|p: &Value| { let mut p = p.clone(); p["txs"][0]["outputs"].as_array_mut().unwrap().pop(); p.to_string() })),
        ("a leaf at the end of u64", set(&["txs", "0", "outputs", "0", "leaf"], json!(u64::MAX))),
        ("an index at the end of u64, then the same again", Box::new(|p: &Value| { let mut p = p.clone(); p["txs"][0]["index"] = json!(u64::MAX); let t = p["txs"][0].clone(); p["txs"].as_array_mut().unwrap().push(t); p.to_string() })),
        ("a transaction at height u64::MAX", set(&["txs", "0", "height"], json!(u64::MAX))),
        ("the tip and next_height at the end of u64", Box::new(|p: &Value| { let mut p = p.clone(); p["tip_height"] = json!(u64::MAX); p["next_height"] = json!(u64::MAX); p.to_string() })),
        ("a page for the height after the one asked for", Box::new(|p: &Value| { let mut p = p.clone(); p["from_height"] = json!(p["from_height"].as_u64().unwrap() + 1); p.to_string() })),
        ("a page for the height before the one asked for", Box::new(|p: &Value| { let mut p = p.clone(); p["from_height"] = json!(p["from_height"].as_u64().unwrap() - 1); p.to_string() })),
        ("kem_ct of an odd length", Box::new(|p: &Value| { let mut p = p.clone(); let k = p["txs"][0]["outputs"][0]["kem_ct"].as_str().unwrap().to_string(); p["txs"][0]["outputs"][0]["kem_ct"] = json!(&k[1..]); p.to_string() })),
        ("note_ct with a space", Box::new(|p: &Value| { let mut p = p.clone(); let k = p["txs"][0]["outputs"][0]["note_ct"].as_str().unwrap().to_string(); p["txs"][0]["outputs"][0]["note_ct"] = json!(format!(" {}", &k[1..])); p.to_string() })),
        ("tx_type in another alphabet", set(&["txs", "0", "tx_type"], json!("shield_v2\u{0430}"))),
        ("unknown fields at every level", Box::new(|p: &Value| { let mut p = p.clone(); p["success"] = json!(true); p["txs"][0]["extra"] = json!([1, 2]); p["txs"][0]["outputs"][0]["more"] = json!({}); p.to_string() })),
    ];
    let (mut refused, mut applied) = (0, 0);
    for (state_name, state) in [("synced, a payment pending", synced.clone()), ("empty", wallet(&alice, 3, true))] {
        let page = chain.page_value(state.next_height(), tip);
        assert!(!page["txs"].as_array().unwrap().is_empty());
        for key in [alice.scan_key(), alice.incoming_viewing_key()] {
            for (what, edit) in &edits {
                let body = edit(&page);
                let mut s = state.clone();
                let r = ListingPage::from_json(&body).and_then(|p| s.scan(&p, &key));
                match &r {
                    Ok(_) => {
                        applied += 1;
                        WalletState::from_json(&s.to_json().unwrap()).unwrap();
                    }
                    Err(WalletError::Listing(_)) => {
                        refused += 1;
                        assert!(s == state, "{what} ({state_name}): a refused page changed the state");
                    }
                    Err(e) => panic!("{what} ({state_name}): {e} — an error that is not the page's class"),
                }
            }
        }
    }
    println!("rw6b-corrupt: {} corruptions × 2 states × 2 keys: {refused} refused as listing:, {applied} applied (well-formed), any other error 0", edits.len());
    assert!(refused > applied);
}

/// **RW6B-2.** Step 1 of the loop has two rules for one answer: "no answer, or not a page →
/// a strike" and "`listing:` → LEAVE(ban) … also a body that is not the JSON of a page". The
/// reference takes the second (`Session::after_scan_error`; the property test hands every body
/// to `ListingPage::from_json`). An honest node has such a body: when its store cannot be read
/// the handler answers `{ "success": false, "error": "…" }` — with HTTP 200
/// (`core/daemon/src/main.rs`, `shield_v2_notes`). A proxy's error page is another. Neither is
/// a listing that is not a chain's: the node is not to be banned for it.
#[test]
fn rw6b_f2_an_honest_nodes_error_answer_is_not_a_page_and_not_evidence() {
    let mut banned = Vec::new();
    for body in [r#"{"success":false,"error":"storage: the block could not be read"}"#, "<html><body><h1>502 Bad Gateway</h1></body></html>", r#"{"error":"rate limited"}"#, ""] {
        let e = ListingPage::from_json(body).err().expect("not a page");
        let mut session = Session::new(3, 1);
        let d = session.after_scan_error(&e);
        if matches!(d, Decision::Leave { ban: true, .. }) {
            banned.push((body, e.to_string()));
        }
    }
    println!("rw6b-f2: answers that are not a page and for which the reference bans the node: {banned:?}");
    assert!(banned.is_empty(), "an honest node is banned for an error answer: {banned:?}");
}

/// **RW6B-3.** After `STOP(fault)` the next session starts at the NEXT node with the stored
/// state as it is and `listed_from` unknown (`Session::new_unattributed`): "what it holds above
/// its confirmed height is nobody's: if it is refuted, the state is rescanned and no node is
/// banned". That holds for `listing_refuted`. It does not hold for the two rules of step 1 that
/// are also about the pages ALREADY in the state: the new node's true page continues a tail it
/// did not serve, and
///
/// (a) the tail held a forged payment: the true page numbers its outputs below the wallet's
///     tree — `leaf_mismatch` → LEAVE(ban);
/// (b) the tail hid a transaction: the true page numbers its outputs above the wallet's tree —
///     `listing:` → LEAVE(ban).
///
/// The honest node is banned for the pages of the node before it. (A fault is not something a
/// page causes any more through `scan`; through `scan_pages` one still does — the test in the
/// wasm crate — and the client's own faults remain.)
#[test]
fn rw6b_f3_after_a_fault_the_next_node_is_banned_for_the_tail_the_node_before_it_left() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let key = alice.scan_key();
    let mut banned = Vec::new();
    for what in ["a forged payment in the tail", "a hidden transaction in the tail"] {
        let mut chain = Chain::new();
        fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
        chain.advance_to(20);
        // the session that ended in a fault: listing from node 1, the tip confirmed, then one
        // more page of node 1 that no state check has seen
        let mut s = wallet(&alice, 3, true);
        s.scan(&chain.page(0), &key).unwrap();
        s.confirm_state(&[report(&chain, 1), report(&chain, 2)]).unwrap();
        let leaves = chain.state().note_count;
        if what.starts_with("a forged") {
            chain.advance_to(21);
            s.scan(&parse(&json!({ "active": true, "tip_height": 21, "from_height": 21, "next_height": 22, "txs": [forged_tx(&alice.address(), 50 * Q, 1, 21, leaves)] })), &key).unwrap();
        } else {
            let hidden = shield_body(&chain, &bob.address(), 2 * Q, "rw6b-f3-hidden");
            chain.block(&[&hidden]).unwrap(); // block 21, which node 1 lists as empty
            s.scan(&empty_page(21, 22, 21), &key).unwrap();
        }
        assert_eq!((s.confirmed_height(), s.scanned_height()), (Some(20), Some(21)));
        // the chain goes on: a pool transaction in block 22
        let traffic = shield_body(&chain, &bob.address(), 3 * Q, &format!("rw6b-f3-{}", what.len()));
        chain.block(&[&traffic]).unwrap();
        // the next session: "start at the next node, listed_from unknown"; every node honest now
        let mut c = LoopClient::new(s, 1);
        c.session = Session::new_unattributed(3, 1);
        for _ in 0..4 {
            c.round_with(&key, &mut |_, since| Some(chain.page(since)), &mut || stats((0..3).map(|i| report(&chain, i)).collect()));
        }
        println!("rw6b-f3 ({what}): banned {:?}, left {:?}, confirmed {:?} of {}", c.session.bad, c.left, c.s.confirmed_height(), chain.height);
        assert_eq!(c.s.confirmed_height(), Some(chain.height), "{what}: the session does recover");
        if !c.session.bad.is_empty() {
            banned.push(format!("{what}: {:?}", c.left));
        }
    }
    assert!(banned.is_empty(), "an honest node is banned for a tail it did not serve:\n  {}", banned.join("\n  "));
}

// ---------------------------------------------------------------------------------------------------
// Check 4 — RW6-3: "the pool is not active".
// ---------------------------------------------------------------------------------------------------

/// A lying minority that says "not active" — in its listing and in its stats answer — on a
/// network where the pool is active, n = 3 and n = 5, every start node:
///
/// (a) with every honest node unreachable for a dozen rounds: the client does NOT idle as "the
///     pool is not active" (the liars are a majority of the ANSWERS and a minority of the
///     configured nodes), nobody is banned, and when the honest nodes are back the tip is
///     confirmed inside the bound;
/// (b) with the honest nodes answering: one round per liar, then the tip.
#[test]
fn rw6b_sound_a_minority_that_says_not_active_neither_idles_nor_stops_an_active_wallet() {
    let alice = keys(PHRASE_1);
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    chain.advance_to(20);
    let key = alice.scan_key();
    for n in [3usize, 5] {
        let liars = n - (n / 2 + 1);
        let limit = (liars as u64 + 1) * (1 + STRIKES as u64 + 2) + FIRST_CHECK_ROUNDS as u64;
        for outage in [12u64, 0] {
            for start in 0..n {
                let mut c = LoopClient::new(wallet(&alice, n, true), start);
                let mut settled_at = outage;
                for round in 1..=outage + limit {
                    let up = round > outage;
                    c.round_with(
                        &key,
                        &mut |node, since| if node < liars { Some(inactive_page(since, 20)) } else { up.then(|| chain.page(since)) },
                        &mut || Stats {
                            reports: (liars..n).filter(|_| up).map(|i| report(&chain, i)).collect(),
                            active: (0..n).filter(|i| *i < liars || up).map(|i| (i, i >= liars)).collect(),
                        },
                    );
                    assert!(c.session.stopped.is_none(), "n = {n}, outage {outage}, start {start}, round {round}: stopped {:?}", c.session.stopped);
                    assert!(c.session.bad.is_empty(), "n = {n}, outage {outage}, start {start}, round {round}: banned {:?} ({:?})", c.session.bad, c.left);
                    if c.s.confirmed_height() != Some(20) || c.s.scanned_height() != Some(20) {
                        settled_at = round + 1;
                    }
                }
                assert!(settled_at <= outage + limit, "n = {n}, outage {outage}, start {start}: not settled (at {settled_at}); left {:?}", c.left);
            }
        }
    }
}

/// A MAJORITY of the configured nodes says "not active" to a wallet that holds funds, a lock
/// and a pending payment (the documented limit: a majority is believed). What that does, and
/// all it does: the loop idles — the stored state is not written, the lock is where it was, the
/// pending entry is neither settled nor dropped, the embargo of a restored state is what it
/// was, nobody is banned. When the nodes answer truthfully again and the client asks again
/// (`recheck_pool`) the loop goes on from the same state and confirms the tip; the payment that
/// was mined meanwhile settles as mined.
#[test]
fn rw6b_sound_a_majority_that_says_not_active_idles_the_loop_and_touches_nothing() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let key = alice.scan_key();
    for restored in [false, true] {
        let mut chain = Chain::new();
        fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
        chain.advance_to(20);
        let mut c = LoopClient::new(wallet(&alice, 3, !restored), 0);
        c.round_with(&key, &mut |_, since| Some(chain.page(since)), &mut || stats((0..3).map(|i| report(&chain, i)).collect()));
        assert_eq!(c.s.confirmed_height(), Some(20));
        let p10 = position_of(&c.s, 10 * Q);
        let t = if restored { None } else { Some(pay_with(&mut c.s, &alice, &[p10], &bob.address(), 4 * Q, "rw6b-idle").unwrap()) };
        let before = c.s.clone();
        if let Some(t) = &t {
            chain.block(&[&t.body]).unwrap(); // the payment is mined while the client is told there is no pool
        }
        // nodes 1 and 2 say "not active" (listing and stats); node 3, honest, is at the tip; the
        // client lists from node 1
        for _ in 0..10 {
            c.round_with(
                &key,
                &mut |node, since| Some(if node < 2 { inactive_page(since, chain.height) } else { chain.page(since) }),
                &mut || Stats { reports: vec![report(&chain, 2)], active: vec![(0, false), (1, false), (2, true)] },
            );
        }
        assert_eq!(c.session.stopped, Some(Stop::PoolInactive));
        assert!(c.session.bad.is_empty() && c.rescans == 0);
        // (the node listed from is one of the two: nothing is read, nothing is written)
        assert!(c.s == before, "the state is what it was: the lock, the pending entry, the embargo, the confirmed height");
        assert_eq!((c.s.pending().len(), c.s.balances().locked), (before.pending().len(), before.balances().locked));
        if restored {
            assert!(matches!(c.s.spend_gate(), Err(WalletError::RestoredRecently { .. })), "the embargo is not lifted by an idle loop");
        }
        // the nodes answer truthfully again
        c.session.recheck_pool();
        for _ in 0..3 {
            c.round_with(&key, &mut |_, since| Some(chain.page(since)), &mut || Stats { reports: (0..3).map(|i| report(&chain, i)).collect(), active: (0..3).map(|i| (i, true)).collect() });
        }
        assert_eq!((c.s.confirmed_height(), c.session.stopped.clone(), c.s.pending().len()), (Some(chain.height), None, 0), "restored {restored}: the loop goes on; a mined payment is settled");
        assert!(c.session.bad.is_empty());
    }
}
