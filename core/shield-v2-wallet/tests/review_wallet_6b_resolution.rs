//! The Resolution of REVIEW_WALLET_6B (`REVIEW_WALLET_6B.md`, "Resolution"): what the four fixes
//! add beyond turning `rw6b_f1`, `rw6b_f2` and `rw6b_f3` green.
//!
//! * RW6B-1 — `WalletState::scan_pages` (what the WebAssembly export runs): every element is
//!   classified as `scan` classifies it, all or nothing, the error names the page;
//! * RW6B-2 — what "a listing page" is, exactly, and that anything else is no answer;
//! * RW6B-3 — `leaf_mismatch` and the `listing:` errors are attribution-aware;
//! * the cap on blameless rescans — the review's demonstration, with the liar left.
//!
//! Needs the `test-vectors` feature, like the earlier reviews.
#![cfg(feature = "test-vectors")]

mod common;

use common::client_loop::{Decision, LoopClient, Session, Stats, BLAMELESS_IN_A_ROW, BLAMELESS_PER_TENURE, STRIKES};
use common::*;
use quantum_vault_shield_v2_wallet::tx::deterministic;
use quantum_vault_shield_v2_wallet::*;
use serde_json::{json, Value};

const IDS: [&str; 3] = ["node-1", "node-2", "node-3"];

fn fund(chain: &mut Chain, to: &ShieldedAddress, values: &[u64]) {
    let key = fake_account_key(1);
    for (i, v) in values.iter().enumerate() {
        let req = ShieldRequest { ctx: chain.ctx(), from_pub_key: &key, nonce: 1, v_in: v + Q, fee: SHIELD_V2_MIN_FEE_QUANTA, recipient: to, max_fee: None };
        let tx = deterministic::shield(&req, &format!("rw6br-fund-{}-{i}", chain.height)).unwrap();
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

fn stats(reports: Vec<StateReport>) -> Stats {
    Stats { reports, active: Vec::new() }
}

/// The liar's listing: the truth, with the transactions of block `was` listed in `was + 1`.
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

// ---------------------------------------------------------------------------------------------------
// RW6B-2 — what a listing page is.
// ---------------------------------------------------------------------------------------------------

/// **The discriminator** (`ListingPage::is_page`): a body is a listing page if and only if it is
/// JSON, its top level is an object, and that object has at least one of the five members of a
/// page — `active`, `tip_height`, `from_height`, `next_height`, `txs`.
///
/// * What is NOT a page is **no answer**: `listing:` with the mark `is_not_a_page`, for the
///   loop a strike towards LEAVE after K rounds, never a ban.
/// * What IS a page and is refused is evidence: a ban. A node cannot leave the rule by leaving
///   members out: with ONE of the five left the body is judged as a page, and the missing ones
///   are a `listing:` error like any other malformed page.
#[test]
fn rw6br_f2_a_body_is_a_page_if_it_has_one_member_of_a_page_and_no_answer_otherwise() {
    let not_pages = [
        r#"{"success":false,"error":"storage: the block could not be read"}"#,
        r#"{"error":"rate limited"}"#,
        "<html><body><h1>502 Bad Gateway</h1></body></html>",
        "",
        " ",
        "null",
        "true",
        "42",
        r#""a page""#,
        "[]",
        r#"[{"active":true,"tip_height":1,"from_height":1,"next_height":2,"txs":[]}]"#, // a page inside an array is not a page
        "{}",
        r#"{"success":true}"#,
        r#"{"success":true,"result":{"active":true,"tip_height":1,"from_height":1,"next_height":2,"txs":[]}}"#, // … nor one level down
        r#"{"Active":true,"TXS":[]}"#, // member names are exact
        "{\"active\":true,", // cut off: not JSON
        "upstream connect error or disconnect/reset before headers",
    ];
    for body in not_pages {
        assert!(!ListingPage::is_page(body), "{body:?}");
        let e = ListingPage::from_json(body).err().expect("not a page");
        assert!(matches!(e, WalletError::Listing(_)) && e.is_not_a_page(), "{body:?}: {e}");
        // the loop: a strike each round, LEAVE without a ban after K
        let mut session = Session::new(3, 1);
        for round in 1..=STRIKES {
            assert!(session.begin_round());
            let d = session.after_scan_error(&e);
            assert_eq!(d, if round < STRIKES { Decision::Go } else { Decision::Leave { ban: false, why: "no answer" } }, "{body:?}, round {round}");
            assert!(session.unanswered && session.strikes == round && session.bad.is_empty());
        }
    }
    // a page: one member is enough — and each of these is refused as a page, which is a ban
    let whole = json!({ "active": true, "tip_height": 1, "from_height": 1, "next_height": 2, "txs": [] });
    let mut pages: Vec<String> = Vec::new();
    for member in ["active", "tip_height", "from_height", "next_height", "txs"] {
        pages.push(json!({ member: whole[member].clone() }).to_string()); // that member alone
        let mut without = whole.clone();
        without.as_object_mut().unwrap().remove(member);
        pages.push(without.to_string()); // every member but that one
        let mut ill = whole.clone();
        ill[member] = json!({ "not": "this" });
        pages.push(ill.to_string()); // that member of the wrong type
    }
    pages.push(r#"{"success":false,"error":"sorry","txs":[]}"#.into()); // an "error" that carries a listing's member
    pages.push(r#"{"success":false,"active":false}"#.into());
    pages.push(r#"{"txs":null}"#.into());
    pages.push(r#"{"next_height":"soon"}"#.into());
    for body in &pages {
        assert!(ListingPage::is_page(body), "{body}");
        let e = ListingPage::from_json(body).err().expect("refused");
        assert!(matches!(e, WalletError::Listing(_)) && !e.is_not_a_page(), "{body}: {e}");
        let mut session = Session::new(3, 1);
        assert_eq!(session.after_scan_error(&e), Decision::Leave { ban: true, why: "a listing: error" }, "{body}");
    }
    // … and a page that parses is a page, whatever else the object holds
    assert!(ListingPage::is_page(&json!({ "success": true, "active": true, "tip_height": 1, "from_height": 1, "next_height": 2, "txs": [], "extra": 1 }).to_string()));
}

// ---------------------------------------------------------------------------------------------------
// RW6B-1 — the pages of a round in one call.
// ---------------------------------------------------------------------------------------------------

/// `WalletState::scan_pages` (what the WebAssembly export `scan_pages` runs): one call or page
/// by page, the same state; whatever is wrong with ONE page is that page's `listing:` — the
/// class `scan` gives it — with its index; and nothing of the call is applied, the pages before
/// the refused one included.
#[test]
fn rw6br_f1_scan_pages_is_scan_page_by_page_all_or_nothing_and_names_the_page() {
    let alice = keys(PHRASE_1);
    let key = alice.scan_key();
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    chain.advance_to(8);
    fund(&mut chain, &alice.address(), &[4 * Q]);
    chain.advance_to(12);
    let pages = [chain.page_value(0, 5).to_string(), chain.page_value(6, 9).to_string(), chain.page_value(10, 12).to_string()];
    // the same state as page by page
    let mut one_by_one = wallet(&alice);
    for p in &pages {
        one_by_one.scan(&ListingPage::from_json(p).unwrap(), &key).unwrap();
    }
    let mut batch = wallet(&alice);
    let reports = batch.scan_pages(&pages, &key).unwrap();
    assert!(batch == one_by_one && reports.len() == 3 && reports[2].at_tip && reports.iter().map(|r| r.txs).sum::<usize>() == 3);
    assert!(wallet(&alice).scan_pages::<&str>(&[], &key).unwrap().is_empty());
    // one bad page, at each place of the batch: its class is the one `scan` gives it, the
    // index is its own, and NOTHING of the call is applied
    let second = chain.page_value(6, 9);
    let bad: Vec<(&str, String, bool)> = vec![
        ("null", "null".into(), true),
        ("the node's error answer", r#"{"success":false,"error":"storage"}"#.into(), true),
        ("not JSON", "<html>".into(), true),
        ("txs missing", { let mut p = second.clone(); p.as_object_mut().unwrap().remove("txs"); p.to_string() }, false),
        ("nf1 a number", { let mut p = second.clone(); p["txs"][0]["nf1"] = json!(7); p.to_string() }, false),
        ("nf1 not canonical", { let mut p = second.clone(); p["txs"][0]["nf1"] = json!("ff".repeat(32)); p.to_string() }, false),
        ("a leaf too high", { let mut p = second.clone(); p["txs"][0]["outputs"][0]["leaf"] = json!(99); p.to_string() }, false),
        ("the wrong height", chain.page_value(7, 9).to_string(), false),
    ];
    for (what, text, no_page) in &bad {
        for index in 0..3usize {
            // (the pages before it are the true ones; a page that is bad only in its place — the
            // second page first — is bad there too)
            let mut texts: Vec<String> = pages[..index].to_vec();
            texts.push(text.clone());
            texts.extend(pages[index + 1..].iter().cloned());
            if *what == "the wrong height" && index == 0 {
                continue; // an empty state takes a listing that starts further on
            }
            let mut s = wallet(&alice);
            let before = s.clone();
            let e = s.scan_pages(&texts, &key).err().unwrap_or_else(|| panic!("{what} at {index}: applied"));
            assert_eq!(e.index, index, "{what}");
            assert!(matches!(e.error, WalletError::Listing(_)) && e.error.is_not_a_page() == *no_page, "{what} at {index}: {}", e.error);
            assert!(s == before, "{what} at {index}: all or nothing");
            // the same class as `scan` gives the page on the state the pages before it leave
            let mut single = wallet(&alice);
            single.scan_pages(&pages[..index], &key).unwrap();
            let alone = ListingPage::from_json(text).and_then(|p| single.scan(&p, &key)).err().expect("scan refuses it too");
            assert_eq!(alone.to_string(), e.error.to_string(), "{what} at {index}");
        }
    }
    // an error that is NOT the page's keeps its class in a batch too: the caller's key
    let e = wallet(&alice).scan_pages(&pages, &keys(PHRASE_2).scan_key()).err().unwrap();
    assert!(e.index == 0 && matches!(e.error, WalletError::Request(_)));
}

// ---------------------------------------------------------------------------------------------------
// RW6B-3 — a page that does not continue the state: whose is the state?
// ---------------------------------------------------------------------------------------------------

/// `leaf_mismatch` and the `listing:` errors are evidence against the listing node only when
/// the unconfirmed part of the state is that node's own (`Session::unconfirmed_tail_is_listing_nodes`):
///
/// (a) a session that starts with `listed_from` unknown (after a fault) on a state with an
///     unconfirmed tail: the FIRST such signal rescans and blames nobody — and from then on
///     every page is the node's own: the same node, lying now, is banned;
/// (b) a session that starts on the stored `listed_from`: the tail is that node's — banned at
///     once, as ever;
/// (c) a node that was handed a state with everything confirmed (no rescan): a page of its
///     own that does not continue it is banned — a confirmed state is nobody's lie.
#[test]
fn rw6br_f3_a_page_that_does_not_continue_the_state_bans_only_the_node_whose_tail_it_is() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let key = alice.scan_key();
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    chain.advance_to(20);
    let confirmed = {
        let mut s = wallet(&alice);
        s.scan(&chain.page(0), &key).unwrap();
        s.confirm_state(&[report(&chain, 1), report(&chain, 2)]).unwrap();
        s
    };
    let hidden = shield_body(&chain, &bob.address(), 2 * Q, "rw6br-f3-hidden");
    chain.block(&[&hidden]).unwrap(); // block 21, which some node listed as empty
    let with_tail = {
        let mut s = confirmed.clone();
        s.scan(&parse(&json!({ "active": true, "tip_height": 21, "from_height": 21, "next_height": 22, "txs": [] })), &key).unwrap();
        s
    };
    let traffic = shield_body(&chain, &bob.address(), 3 * Q, "rw6br-f3-traffic");
    chain.block(&[&traffic]).unwrap(); // block 22
    let mut honest_stats = || stats((0..3).map(|i| report(&chain, i)).collect());
    // (a) listed_from unknown
    let mut c = LoopClient::new(with_tail.clone(), 1);
    c.session = Session::new_unattributed(3, 1);
    assert!(!c.session.unconfirmed_tail_is_listing_nodes());
    c.round_with(&key, &mut |_, since| Some(chain.page(since)), &mut honest_stats);
    assert_eq!((c.session.bad.len(), c.rescans, c.session.listing, c.left.len(), c.session.blameless_in_a_row), (0, 1, 1, 0, 1), "the true page of node 2 does not continue the tail: rescan, nobody blamed");
    assert!(c.session.unconfirmed_tail_is_listing_nodes(), "an empty state: whatever follows is the listing node's");
    // … the same node, now serving a listing that is numbered wrong: its own pages — banned
    let mut wrong = chain.page_value(0, 22);
    wrong["txs"][2]["outputs"][0]["leaf"] = json!(9);
    c.round_with(&key, &mut |node, since| Some(if node == 1 { parse(&wrong) } else { chain.page(since) }), &mut honest_stats);
    assert_eq!((c.session.bad.iter().copied().collect::<Vec<_>>(), c.left.clone()), (vec![1], vec![(2, 1, true, "a listing: error")]));
    c.round_with(&key, &mut |_, since| Some(chain.page(since)), &mut honest_stats);
    assert_eq!((c.s.confirmed_height(), c.session.listing), (Some(22), 2));
    // (b) the stored listed_from: the tail is node 2's own
    let mut c = LoopClient::new(with_tail.clone(), 1);
    assert!(c.session.unconfirmed_tail_is_listing_nodes());
    c.round_with(&key, &mut |_, since| Some(chain.page(since)), &mut honest_stats);
    assert_eq!((c.session.bad.iter().copied().collect::<Vec<_>>(), c.left.clone()), (vec![1], vec![(1, 1, true, "a listing: error")]), "node 2 listed block 21 as empty and now lists what follows it");
    // (c) everything confirmed, handed on without a rescan; the next node numbers its page wrong
    let mut c = LoopClient::new(confirmed.clone(), 0);
    for _ in 0..STRIKES {
        c.round_with(&key, &mut |_, _| None, &mut honest_stats); // node 1 does not answer: left, no rescan
    }
    assert_eq!((c.session.listing, c.rescans, c.session.unrecorded_tail), (1, 0, false));
    let mut low = chain.page_value(21, 22);
    for tx in low["txs"].as_array_mut().unwrap() {
        for j in 0..2 {
            tx["outputs"][j]["leaf"] = json!(tx["outputs"][j]["leaf"].as_u64().unwrap() - 2);
        }
    }
    c.round_with(&key, &mut |_, _| Some(parse(&low)), &mut honest_stats);
    assert_eq!((c.session.bad.iter().copied().collect::<Vec<_>>(), c.left.last().copied()), (vec![1], Some((STRIKES as u64 + 1, 1, true, "leaf_mismatch"))), "a confirmed state is nobody's lie: the page is");
}

// ---------------------------------------------------------------------------------------------------
// The cap on blameless rescans.
// ---------------------------------------------------------------------------------------------------

/// **The review's demonstration (`rw6b_demo_a_liar_that_lists_the_truth_after_the_blameless_rescan_…`),
/// with the cap.** The liar lists a block's transaction one block late, votes for the result,
/// contradicts the confirmed height together with the honest node that stood there — a rescan
/// that blames nobody — and lists the TRUTH into the empty state: never banned, nothing left
/// to refute, and ready for the next occasion. Between two occasions the tip is confirmed, so
/// these are not rescans "in a row"; they are counted per listing node and session
/// (`BLAMELESS_PER_TENURE` = 3, after REVIEW_WALLET_6C): **at the third the liar is LEFT** — not banned: the model of
/// the loop has no evidence against it — with the rescan, and the honest node that follows
/// confirms the tip. Further occasions find an honest listing node and are none.
#[test]
fn rw6br_cap_the_liar_that_lists_the_truth_after_each_blameless_rescan_is_left_at_the_cap() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    chain.advance_to(20);
    let key = alice.scan_key();
    let lie_as_node_1 = |r: &StateReport| {
        let mut w = r.clone();
        w.nullifier_acc[5] ^= 1;
        w.node_id = node(IDS[0]);
        w
    };
    let mut c = LoopClient::new(wallet(&alice), 0); // node 1, the liar, lists
    c.round_with(&key, &mut |_, since| Some(chain.page(since)), &mut || stats((0..3).map(|i| report(&chain, i)).collect()));
    assert_eq!(c.s.confirmed_height(), Some(20));
    let cap = BLAMELESS_PER_TENURE;
    let mut rounds_as_listing_node = 1;
    for cycle in 1..=cap + 3 {
        let liar_lists = c.session.listing == 0;
        let h = chain.height + 1;
        let x = shield_body(&chain, &bob.address(), Q + cycle as u64, &format!("rw6br-cap-{cycle}"));
        chain.block(&[&x]).unwrap();
        let lagging = report(&chain, 2);
        chain.advance_to(h + 1);
        // the liar's listing when it is asked; the truth from the others
        let page = |node: usize, since: u64, late: bool| Some(if node == 0 && late { shifted(&chain, since, h) } else { chain.page(since) });
        c.round_with(&key, &mut |n, s| page(n, s, true), &mut || stats(vec![report(&chain, 0), report(&chain, 1), lagging.clone()]));
        assert_eq!((c.s.confirmed_height(), c.s.scanned_height()), (Some(h + 1), Some(h + 1)), "cycle {cycle}");
        c.round_with(&key, &mut |n, s| page(n, s, true), &mut || stats(vec![lie_as_node_1(&lagging), report(&chain, 1), report(&chain, 2)]));
        c.round_with(&key, &mut |n, s| page(n, s, false), &mut || stats((0..3).map(|i| report(&chain, i)).collect()));
        rounds_as_listing_node += 3 * liar_lists as u32;
        assert!(c.session.bad.is_empty() && c.session.stopped.is_none(), "cycle {cycle}: nobody is ever banned for it");
        assert_eq!((c.s.confirmed_height(), c.s.scanned_height()), (Some(h + 1), Some(h + 1)), "cycle {cycle}: the tip is confirmed again");
        if cycle < cap {
            assert_eq!((c.rescans, c.session.listing, c.left.len(), c.session.blameless_on_l, c.session.blameless_in_a_row), (cycle, 0, 0, cycle, 0), "cycle {cycle}: a rescan that blamed nobody; the liar lists");
        } else {
            // the cap: left at the third, with the rescan, not banned; the honest node lists
            assert_eq!((c.rescans, c.session.listing, c.left.clone()), (cap, 1, vec![(3 * cap as u64, 0, false, "rescans that blamed nobody")]), "cycle {cycle}");
            assert_eq!((c.session.blameless_on_l, c.session.blameless_in_a_row), (0, 0));
        }
    }
    // the bound: the liar's tenure ended after `cap` occasions, each of 3 rounds here
    // (confirmed late / contradicted / read again: D + 2 with D = 1)
    assert_eq!(rounds_as_listing_node, 1 + 3 * cap);
    println!("rw6br-cap: {} occasions, {} rescans that blamed nobody, banned {:?}, LEAVEs {:?}, the listing node is node {}", cap + 3, c.rescans, c.session.bad, c.left, c.session.listing + 1);
}

/// The other cap: rescans that blamed nobody IN A ROW — no round between them that ended with
/// the tip confirmed (`BLAMELESS_IN_A_ROW` = 2). That is the case in which the wallet would not
/// settle at all: the listing node is left at the second, without a ban, and the state is
/// rescanned on the way. A round that ends with the tip confirmed and no rescan ends the run.
#[test]
fn rw6br_cap_two_blameless_rescans_in_a_row_leave_the_listing_node() {
    let alice = keys(PHRASE_1);
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    chain.advance_to(20);
    let mut s = wallet(&alice);
    s.scan(&chain.page(0), &alice.scan_key()).unwrap();
    s.confirm_state(&[report(&chain, 0), report(&chain, 1)]).unwrap();
    // what `confirm_state` says when a confirmed height is contradicted, and when all is well
    let contradicted = ConfirmReport { listing_refuted: true, confirmed_refuted: true, refuted: vec![Refutation { from_height: 0, height: 10, confirmed: true, dissenting: 2, agreeing: 0 }], quorum_tip: Some(20), ..Default::default() };
    let fine = ConfirmReport { matched_height: Some(20), confirmed_height: Some(20), quorum_tip: Some(20), ..Default::default() };
    assert_eq!(BLAMELESS_IN_A_ROW, 2);
    let mut session = Session::new(3, 0);
    assert_eq!(session.after_confirm(&contradicted, true, &s), Decision::Rescan);
    assert_eq!(session.after_confirm(&contradicted, true, &s), Decision::Leave { ban: false, why: "rescans that blamed nobody" });
    // the LEAVE rescans although everything the state holds is "confirmed", and counts start again
    let plan = session.plan_leave(false, &s);
    assert!(plan.rescan && plan.next == Some(1) && !plan.ban);
    session.commit_leave(plan);
    assert_eq!((session.listing, session.blameless_in_a_row, session.blameless_on_l, session.bad.len()), (1, 0, 0, 0));
    // a round that ends with the tip confirmed in between: not in a row
    let mut session = Session::new(3, 0);
    for _ in 0..BLAMELESS_PER_TENURE - 1 {
        assert_eq!(session.after_confirm(&contradicted, true, &s), Decision::Rescan);
        assert_eq!(session.after_confirm(&fine, true, &s), Decision::Go);
        assert_eq!(session.blameless_in_a_row, 0);
    }
    assert_eq!(session.after_confirm(&contradicted, true, &s), Decision::Leave { ban: false, why: "rescans that blamed nobody" }, "… and the count per session still ends it");
    // the only node that is not banned: it stays, and the rescan is made
    let mut session = Session::new(3, 0);
    session.bad.extend([1, 2]);
    session.after_confirm(&contradicted, true, &s);
    session.after_confirm(&contradicted, true, &s);
    let plan = session.plan_leave(false, &s);
    assert!(plan.rescan && plan.next == Some(0));
}
