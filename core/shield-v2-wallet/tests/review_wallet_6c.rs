//! REVIEW_WALLET_6C — the final confirmation pass, on `fix/shield-v2-wallet-settlement-6` @
//! `1b61659` (see `REVIEW_WALLET_6C.md`). Nothing was fixed by the review. Every test here
//! passes (`rw6c_sound_…`: attacked, holds); the one failing test of this pass needs the
//! WebAssembly surface and is in `core/shield-v2-wasm/tests/review_wallet_6c.rs`.
//!
//! Needs the `test-vectors` feature, like the earlier reviews.
#![cfg(feature = "test-vectors")]

mod common;

use common::client_loop::{Decision, LoopClient, Session, Stats, BLAMELESS_IN_A_SESSION, STRIKES};
use common::*;
use quantum_vault_shield_v2_wallet::tx::deterministic;
use quantum_vault_shield_v2_wallet::*;
use serde_json::{json, Value};

const IDS: [&str; 3] = ["node-1", "node-2", "node-3"];

fn fund(chain: &mut Chain, to: &ShieldedAddress, values: &[u64]) {
    let key = fake_account_key(1);
    for (i, v) in values.iter().enumerate() {
        let req = ShieldRequest { ctx: chain.ctx(), from_pub_key: &key, nonce: 1, v_in: v + Q, fee: SHIELD_V2_MIN_FEE_QUANTA, recipient: to, max_fee: None };
        let tx = deterministic::shield(&req, &format!("rw6c-fund-{}-{i}", chain.height)).unwrap();
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

fn wallet(alice: &ShieldedKeys) -> WalletState {
    let mut s = WalletState::new(alice.address().pk);
    configure_as_sole_copy(&mut s, &IDS);
    s
}

fn report(chain: &Chain, i: usize) -> StateReport {
    chain.report(IDS[i])
}

/// The truth, with the transactions of block `was` listed in block `was + 1`.
fn shifted(chain: &Chain, since: u64, was: u64) -> ListingPage {
    if since > was + 1 {
        return parse(&json!({ "active": true, "tip_height": was + 1, "from_height": since, "next_height": since, "txs": [] }));
    }
    let mut p = chain.page_value(since, was + 1);
    for tx in p["txs"].as_array_mut().unwrap().iter_mut().filter(|tx| tx["height"] == was) {
        tx["height"] = json!(was + 1);
    }
    parse(&p)
}

/// Check 3 — the discriminator against what the reference node really answers on
/// `/api/shield-v2/notes` (`core/daemon/src/main.rs`, `shield_v2_notes`; `node.rs`,
/// `shield_v2_notes_since`): the page (with the handler's `success: true`), the answer of a
/// chain without an activation height, the handler's error. None is misclassified, in either
/// direction; and what carries one member of a page is a page whatever else it says.
#[test]
fn rw6c_sound_the_nodes_own_answers_are_classified_as_what_they_are() {
    let alice = keys(PHRASE_1);
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q]);
    let mut page = chain.page_value(0, chain.height);
    page["success"] = json!(true);
    let inactive = json!({ "active": false, "tip_height": 245, "from_height": 0, "next_height": 0, "txs": [], "success": true });
    let error = json!({ "success": false, "error": "task failed: the block could not be read" });
    // pages
    for (what, body) in [("a page", &page), ("not active", &inactive)] {
        assert!(ListingPage::is_page(&body.to_string()), "{what}");
        let mut s = wallet(&alice);
        let r = s.scan(&ListingPage::from_json(&body.to_string()).expect(what), &alice.scan_key()).expect(what);
        assert_eq!(r.pool_active, what == "a page");
    }
    // no answer: a strike, and on the K-th the node is left without a ban
    for body in [error.to_string(), String::new(), "<html>502</html>".into(), "Failed to deserialize query string".into(), json!([page]).to_string(), json!({ "report": null }).to_string(), "null".into()] {
        assert!(!ListingPage::is_page(&body));
        let e = ListingPage::from_json(&body).err().unwrap();
        assert!(e.is_not_a_page(), "{body}: {e}");
        let mut session = Session::new(3, 0);
        let decisions: Vec<Decision> = (0..STRIKES).map(|_| session.after_scan_error(&e)).collect();
        assert!(decisions[..STRIKES as usize - 1].iter().all(|d| *d == Decision::Go) && matches!(decisions.last(), Some(Decision::Leave { ban: false, .. })), "{body}: {decisions:?}");
    }
    // a page, whatever it says about `success`, and however little of a page it has
    for body in [json!({ "success": false, "txs": [] }), json!({ "error": "x", "tip_height": 3 }), json!({ "active": true })] {
        let e = ListingPage::from_json(&body.to_string()).err().unwrap();
        assert!(ListingPage::is_page(&body.to_string()) && !e.is_not_a_page() && matches!(e, WalletError::Listing(_)));
        assert!(matches!(Session::new(3, 0).after_scan_error(&e), Decision::Leave { ban: true, .. }));
    }
}

/// One round of the loop on the TEXT of the answers (`None`: no response): steps 1 to 4 as
/// `LoopClient::round_with` has them, with `ListingPage::from_json` in front of `scan`.
fn text_round(c: &mut LoopClient, key: &ScanKey, body: &mut dyn FnMut(usize, u64) -> Option<String>, reports: Vec<StateReport>) {
    let mut done = false;
    let mut answers = Vec::new();
    // (the reference client takes parsed pages: what is no page is handed to the session here,
    // and the round is then run by the reference with "no answer" for that request)
    c.round_with(
        key,
        &mut |node, since| {
            if done {
                return None;
            }
            let text = body(node, since)?;
            match ListingPage::from_json(&text) {
                Ok(p) => Some(p),
                Err(e) => {
                    assert!(e.is_not_a_page(), "this driver is for answers that are a true page or no page: {e}");
                    answers.push(e);
                    done = true;
                    None
                }
            }
        },
        &mut || Stats { reports: reports.clone(), active: Vec::new() },
    );
    let _ = answers;
}

/// Check 3 — a body that is no page is a strike and never a ban; is that a way to be listed
/// from for ever? A node that answers `{ "success": false }` for K − 1 rounds and delivers in
/// the K-th is never left, exactly like a node that is silent K − 1 rounds of K — and it has
/// to DELIVER in that round: the wallet at the quorum's tip and everything confirmed. The
/// wallet is at most K − 1 rounds stale, on a chain that makes a block every round. The same
/// node with a "good" round that stops one block short of the tip is left in round K.
#[test]
fn rw6c_sound_no_page_for_k_minus_one_rounds_of_k_is_silence_and_buys_no_standstill() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let key = alice.scan_key();
    for delivers in [true, false] {
        let mut chain = Chain::new();
        fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
        chain.advance_to(20);
        let mut c = LoopClient::new(wallet(&alice), 0);
        let mut stale = 0u64;
        for round in 1..=30u64 {
            if c.session.listing != 0 {
                break;
            }
            let traffic = if round % 3 == 0 { vec![shield_body(&chain, &bob.address(), Q + round, &format!("rw6c-alt-{delivers}-{round}"))] } else { vec![] };
            chain.block(&traffic.iter().map(|b| b.as_slice()).collect::<Vec<_>>()).unwrap();
            let good = round % STRIKES as u64 == 0;
            let reports = (0..3).map(|i| report(&chain, i)).collect();
            text_round(
                &mut c,
                &key,
                &mut |node, since| {
                    if node != 0 {
                        return Some(chain.page_value(since, chain.height).to_string());
                    }
                    if !good {
                        return Some(json!({ "success": false, "error": "busy" }).to_string());
                    }
                    Some(chain.page_value(since, if delivers { chain.height } else { chain.height - 1 }).to_string())
                },
                reports,
            );
            assert!(c.session.bad.is_empty() && c.session.stopped.is_none());
            if c.s.confirmed_height() == Some(chain.height) {
                stale = 0;
            } else {
                stale += 1;
            }
            if delivers {
                assert!(stale < STRIKES as u64, "round {round}: the tip was last confirmed {stale} rounds ago");
                assert_eq!(c.s.confirmed_height() == Some(chain.height), good, "round {round}");
            }
        }
        if delivers {
            assert!(c.session.listing == 0 && c.left.is_empty(), "a node that delivers every K-th round stays, as a silent one does: {:?}", c.left);
        } else {
            assert_eq!(c.left, vec![(STRIKES as u64, 0, false, "behind the quorum's tip")], "a node that never brings the wallet to the tip is left in round K");
        }
    }
}

/// Check 5 — the caps, with three nodes: the adaptive liar of REVIEW_WALLET_6B (lists late,
/// votes honestly, contradicts, lists the truth after the rescan), ONE honest node a block
/// behind in every first round of an occasion, the other at the tip. Twelve occasions, from
/// each start node.
///
/// * Listing from the liar: it is left — not banned — at its `BLAMELESS_IN_A_SESSION`-th
///   rescan; the next node is honest and at the tip, and from there on every occasion is an
///   ordinary round: no rescan, the tip confirmed.
/// * No honest node is ever left for "rescans that blamed nobody", none is banned, and the tip
///   is confirmed at the end of every occasion: the cap does not take the client off an honest
///   node, lagging or not.
#[test]
fn rw6c_sound_the_cap_leaves_the_adaptive_liar_and_never_an_honest_node() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let key = alice.scan_key();
    for start in 0..3usize {
        let mut chain = Chain::new();
        fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
        chain.advance_to(20);
        let mut c = LoopClient::new(wallet(&alice), start);
        let all = |chain: &Chain| Stats { reports: (0..3).map(|i| report(chain, i)).collect(), active: Vec::new() };
        c.round_with(&key, &mut |_, since| Some(chain.page(since)), &mut || all(&chain));
        let mut rescans_on_the_liar = 0;
        for occasion in 1..=12u32 {
            let h = chain.height + 1;
            let x = shield_body(&chain, &bob.address(), Q + occasion as u64, &format!("rw6c-cap-{start}-{occasion}"));
            chain.block(&[&x]).unwrap();
            let lagging = report(&chain, 2);
            chain.advance_to(h + 1);
            let before = c.rescans;
            let on_liar = c.session.listing == 0;
            // A: node 3 is at h; the liar lists h's transaction in h + 1 and vouches for h + 1
            c.round_with(&key, &mut |node, since| Some(match node { 0 => shifted(&chain, since, h), 2 => parse(&chain.page_value(since, h)), _ => chain.page(since) }), &mut || Stats { reports: vec![report(&chain, 0), report(&chain, 1), lagging.clone()], active: Vec::new() });
            // B: everybody at the tip; the liar contradicts height h
            let mut wrong = lagging.clone();
            wrong.nullifier_acc[5] ^= 1;
            wrong.node_id = node(IDS[0]);
            c.round_with(&key, &mut |node, since| Some(if node == 0 { shifted(&chain, since, h) } else { chain.page(since) }), &mut || Stats { reports: vec![wrong.clone(), report(&chain, 1), report(&chain, 2)], active: Vec::new() });
            // C, D: the truth from every node
            for _ in 0..2 {
                c.round_with(&key, &mut |_, since| Some(chain.page(since)), &mut || all(&chain));
            }
            if on_liar {
                rescans_on_the_liar += c.rescans - before;
            }
            assert!(c.session.bad.is_empty() && c.session.stopped.is_none(), "start {start}, occasion {occasion}: {:?}", c.left);
            assert_eq!((c.s.confirmed_height(), c.s.scanned_height()), (Some(chain.height), Some(chain.height)), "start {start}, occasion {occasion}: the tip is confirmed; left {:?}", c.left);
            assert!(c.left.iter().all(|l| l.3 != "rescans that blamed nobody" || l.1 == 0), "start {start}: an honest node is left for blameless rescans: {:?}", c.left);
        }
        println!("rw6c-cap, start node {}: {} rescans in all, {} while the liar was listed from; left {:?}; the listing node at the end: node {}", start + 1, c.rescans, rescans_on_the_liar, c.left, c.session.listing + 1);
        assert!(rescans_on_the_liar <= BLAMELESS_IN_A_SESSION, "start {start}");
        if start == 0 {
            assert_eq!((c.left.len(), c.left[0].1, c.left[0].2, c.left[0].3, c.session.listing), (1, 0, false, "rescans that blamed nobody", 1));
            assert_eq!(rescans_on_the_liar, BLAMELESS_IN_A_SESSION);
        }
    }
}

/// Check 2 — `WalletState::scan_pages`: one call is page by page; a refused page names its
/// index and leaves the state as it was, the pages before it included.
#[test]
fn rw6c_sound_scan_pages_is_all_or_nothing_and_names_the_page() {
    let alice = keys(PHRASE_1);
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q, 3 * Q]);
    let key = alice.scan_key();
    let pages: Vec<String> = (0..3u64).map(|i| chain.page_value(if i == 0 { 0 } else { A + i }, A + i).to_string()).collect();
    let mut one = wallet(&alice);
    let reports = one.scan_pages(&pages, &key).unwrap();
    let mut by_page = wallet(&alice);
    for p in &pages {
        by_page.scan(&ListingPage::from_json(p).unwrap(), &key).unwrap();
    }
    assert!(reports.len() == 3 && one == by_page && one.balance() == 19 * Q as u128);
    let mut bad: Value = serde_json::from_str(&pages[2]).unwrap();
    bad["txs"][0]["outputs"][1]["leaf"] = json!("5");
    for (batch, index, no_page) in [
        (vec![pages[0].clone(), pages[1].clone(), bad.to_string()], 2, false),
        (vec![pages[0].clone(), pages[2].clone()], 1, false),
        (vec![pages[0].clone(), json!({ "success": false }).to_string(), pages[1].clone()], 1, true),
        (vec![String::new()], 0, true),
    ] {
        let mut s = wallet(&alice);
        let before = s.clone();
        let e = s.scan_pages(&batch, &key).unwrap_err();
        assert_eq!((e.index, matches!(e.error, WalletError::Listing(_)), e.error.is_not_a_page()), (index, true, no_page));
        assert!(s == before, "a refused batch leaves the state as it was");
    }
}
