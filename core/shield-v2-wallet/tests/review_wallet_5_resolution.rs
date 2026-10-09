//! The Resolution of REVIEW_WALLET_5 (`REVIEW_WALLET_5.md`, "Resolution"): what the fixes
//! guarantee beyond turning the review's four failing tests green, and the named tests behind
//! the mutation table of the Resolution.
//!
//! * RW5-1 — the two `listing:` refusals at their edges (a spend listed at the HEIGHT of its
//!   note is not refused; a transaction shown twice with other outputs is);
//! * RW5-7 — which IPv6 literals are an IPv4 host, and which are not;
//! * RW5-9 — a format-5 text without one of the fields format 5 added is refused, a text whose
//!   version is damaged is refused, and `recover_locks` puts both under the embargo;
//! * X14, X17 (section 5 of the review) — a lock is held by NULLIFIER where the entry has no
//!   commitments, and a pending entry's nullifier in the listing spends its input BY
//!   COMMITMENT where the note has no stored nullifier.
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
        let tx = deterministic::shield(&req, &format!("rw5r-fund-{}-{i}", chain.height)).unwrap();
        chain.block(&[&tx.body]).unwrap();
    }
}

fn parse(page: &serde_json::Value) -> ListingPage {
    ListingPage::from_json(&page.to_string()).unwrap()
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

/// A new wallet with two notes (10 and 6 XRGE), confirmed, and the chain it is on.
fn new_wallet(alice: &ShieldedKeys) -> (Chain, WalletState) {
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    let mut w = WalletState::new(alice.address().pk);
    configure_as_sole_copy(&mut w, &[N1, N2, N3]);
    w.scan(&chain.page(0), &alice.scan_key()).unwrap();
    w.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    (chain, w)
}

// ---------------------------------------------------------------------------------------------------
// RW5-1
// ---------------------------------------------------------------------------------------------------

/// RW5-1 (a), the edges. The viewing-key worker remembers every nullifier it meets with its
/// height. A sighting ABOVE the note's height is a spend and is applied by the first scan with
/// the full key; a sighting AT the note's height is applied too (a listing may show a note and
/// its spend in one block: such a state is one every call reads); only a sighting BELOW the
/// height that created the note is refused — `listing:`, the state unchanged, again and again
/// until the state is rescanned, which drops what was remembered.
#[test]
fn rw5r_f1_a_remembered_spend_is_refused_only_below_the_height_of_its_note() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let (mut chain, mut main) = new_wallet(&alice);
    let (first, second) = (chain.page_value(0, chain.height)["txs"][0].clone(), chain.page_value(0, chain.height)["txs"][1].clone());
    let p_in = position_of(&main, 6 * Q); // the note of the SECOND funding transaction
    let spend = pay_with(&mut main, &alice, &[p_in], &bob.address(), 4 * Q, "rw5r-f1-spend").unwrap();
    chain.block(&[&spend.body]).unwrap();
    let spend_entry = chain.page_value(chain.height, chain.height)["txs"][0].clone();
    // the three transactions as a listing gives them: `first` at height 3 (leaves 0, 1), then
    // the note's transaction and its spend at the heights and in the order of the case
    let listing = |note_at: (u64, u64), spend_at: (u64, u64), spend_first: bool| {
        let place = |tx: &serde_json::Value, at: (u64, u64), leaf: u64| {
            let mut tx = tx.clone();
            (tx["height"], tx["index"]) = (serde_json::json!(at.0), serde_json::json!(at.1));
            for j in 0..2 {
                tx["outputs"][j]["leaf"] = serde_json::json!(leaf + j as u64);
            }
            tx
        };
        let (a, b) = if spend_first { (place(&spend_entry, spend_at, 2), place(&second, note_at, 4)) } else { (place(&second, note_at, 2), place(&spend_entry, spend_at, 4)) };
        parse(&serde_json::json!({ "active": true, "tip_height": 6, "from_height": A, "next_height": 7, "txs": [place(&first, (3, 0), 0), a, b] }))
    };
    let empty = parse(&serde_json::json!({ "active": true, "tip_height": 6, "from_height": 7, "next_height": 7, "txs": [] }));
    let worker = |page: &ListingPage| {
        let mut s = WalletState::new(alice.address().pk);
        configure(&mut s, &[N1, N2, N3]);
        s.scan(page, &alice.incoming_viewing_key()).expect("the worker's scan accepts a well-formed page");
        s
    };
    // the chain's order: the note at 4, its spend at 5 — applied
    let mut s = worker(&listing((4, 0), (5, 0), false));
    s.scan(&empty, &alice.scan_key()).expect("a spend above its note is applied");
    assert!(s.notes().iter().any(|n| n.value == 6 * Q && n.spent_height == Some(5)) && s.view_only_since().is_none());
    // one block: the note, then its spend — applied (spent at the height it was created at)
    let mut s = worker(&listing((4, 0), (4, 1), false));
    s.scan(&empty, &alice.scan_key()).expect("a spend at the height of its note is applied");
    assert!(s.notes().iter().any(|n| n.value == 6 * Q && n.spent_height == Some(4)));
    WalletState::from_json(&s.to_json().unwrap()).unwrap();
    // the spend listed a block BEFORE the note: refused, the state unchanged, until a rescan
    let mut s = worker(&listing((5, 0), (4, 0), true));
    let before = s.clone();
    for _ in 0..3 {
        assert!(matches!(s.scan(&empty, &alice.scan_key()), Err(WalletError::Listing(_))));
        assert!(s == before);
    }
    assert!(s.scan(&empty, &alice.incoming_viewing_key()).is_ok(), "the worker can go on; the full key cannot");
    let mut fresh = before.fresh_for_rescan();
    fresh.scan(&chain.page(0), &alice.scan_key()).expect("a rescan drops what was remembered");
    assert_eq!(fresh.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap().matched_height, Some(chain.height));
}

/// RW5-1 (b), at scale and in the shape the review did not try: a hostile sender does not need
/// to repeat a transaction — it can list any number of DIFFERENT notes for the wallet under the
/// two nullifiers of the transaction that created the note a pending payment spends. Every one
/// of them has the nullifier of that note and would be "an input of the pending entry". The
/// first is refused; a state never holds two notes with one `rho`, so no entry holds more than
/// four notes and the bound on spent notes is a property of every state, not of a listing.
#[test]
fn rw5r_f1b_no_page_stores_a_second_note_under_the_nullifiers_of_a_stored_one() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let (chain, mut w) = new_wallet(&alice);
    let p_in = position_of(&w, 10 * Q);
    pay_with(&mut w, &alice, &[p_in], &bob.address(), 4 * Q, "rw5r-f1b-t1").unwrap();
    let mut s = w.fresh_for_rescan();
    // the liar's listing: the true first transaction once, then 600 more "transactions" with
    // ITS nullifiers — each the true one again (the cheapest forgery: no key is needed)
    let creating = chain.page_value(0, chain.height)["txs"][0].clone();
    let txs: Vec<serde_json::Value> = (0..601u64)
        .map(|i| {
            let mut t = creating.clone();
            t["index"] = serde_json::json!(i);
            for j in 0..2 {
                t["outputs"][j]["leaf"] = serde_json::json!(2 * i + j as u64);
            }
            t
        })
        .collect();
    let untouched = s.clone();
    let r = s.scan(&parse(&serde_json::json!({ "active": true, "tip_height": 9, "from_height": A, "next_height": 4, "txs": txs })), &alice.scan_key());
    assert!(matches!(r, Err(WalletError::Listing(_))) && s == untouched, "refused whole, before the state is touched");
    assert_eq!(s.pending().len(), 1, "the lock is kept");
    // an honest listing: one note, locked
    s.scan(&chain.page(0), &alice.scan_key()).unwrap();
    assert_eq!((s.notes().iter().filter(|n| n.value == 10 * Q).count(), s.balances().locked), (1, 10 * Q as u128));
}

// ---------------------------------------------------------------------------------------------------
// RW5-6
// ---------------------------------------------------------------------------------------------------

/// The limits are part of what the revision identity is computed over — for every pair of
/// limits, in both orders — and a rescan with the SAME limits is the same change with the same
/// result: one identity.
#[test]
fn rw5r_f6_the_limits_of_a_rescan_are_in_its_revision_identity() {
    let alice = keys(PHRASE_1);
    let (_, w) = new_wallet(&alice);
    let variants: Vec<WalletState> = vec![
        w.fresh_for_rescan(),
        w.fresh_for_rescan_with(Some(1), None).unwrap(),
        w.fresh_for_rescan_with(Some(2), None).unwrap(),
        w.fresh_for_rescan_with(None, Some(1_000)).unwrap(),
        w.fresh_for_rescan_with(Some(1), Some(1_000)).unwrap(),
        w.fresh_for_rescan_with_min_note_value(3).unwrap(),
    ];
    for (i, a) in variants.iter().enumerate() {
        for b in &variants[i + 1..] {
            assert!(a != b && a.revision_id() != b.revision_id() && a.revision() == b.revision());
            assert!(a.expect_revision_id(&b.revision_id()).is_err());
        }
        WalletState::from_json(&a.to_json().unwrap()).unwrap();
    }
    assert_eq!(w.fresh_for_rescan().revision_id(), w.fresh_for_rescan_with(Some(w.min_note_value()), Some(w.max_unspent_notes())).unwrap().revision_id());
}

// ---------------------------------------------------------------------------------------------------
// RW5-7
// ---------------------------------------------------------------------------------------------------

/// Which IPv6 literals are an IPv4 host to "one node per host": the five forms in which the
/// address IS an IPv4 endpoint in IPv6 notation — and nothing else. The canonical text of an
/// id is unchanged (an IPv6 literal stays an IPv6 literal); only the rule for a SET counts it
/// as the IPv4 host.
#[test]
fn rw5r_f7_an_ipv6_literal_that_spells_an_ipv4_address_is_that_host() {
    let set = |ids: &[&str]| {
        let mut s = WalletState::new([1u8; 32]);
        s.set_nodes(ids).map(|n| n.len())
    };
    let other = "https://node-b.example";
    // 192.0.2.7 = c000:0207
    let same_host = [
        ("IPv4-mapped", "https://[::ffff:192.0.2.7]"),
        ("IPv4-mapped, hexadecimal", "https://[::ffff:c000:207]"),
        ("IPv4-compatible", "https://[::192.0.2.7]"),
        ("IPv4-translated (SIIT)", "https://[::ffff:0:192.0.2.7]"),
        ("NAT64 well-known prefix", "https://[64:ff9b::192.0.2.7]"),
        ("NAT64 well-known prefix, hexadecimal", "https://[64:ff9b::c000:207]"),
        ("6to4", "https://[2002:c000:207::1]"),
        ("6to4, another host of the prefix", "https://[2002:c000:207:5::99]"),
    ];
    for (what, id) in same_host {
        assert!(matches!(set(&["https://192.0.2.7", id, other]), Err(WalletError::Request(_))), "{what}: {id} and 192.0.2.7 are one host");
        assert!(matches!(set(&[id, "https://192.0.2.7:8443", other]), Err(WalletError::Request(_))), "{what}: whatever the port");
        assert_eq!(set(&[id, "https://192.0.2.8", other]).unwrap(), 3, "{what}: another IPv4 address is another host");
        // … and two such literals of one IPv4 address are one host between themselves
        assert!(matches!(set(&[id, "https://[::ffff:192.0.2.7]:9000", other]), Err(WalletError::Request(_))), "{what}");
        // the text of the id is what it was
        assert!(canonical_node_id(id).unwrap().starts_with("https://["), "{what}");
    }
    assert!(matches!(set(&["https://[::ffff:192.0.2.7]", "https://[64:ff9b::192.0.2.7]", other]), Err(WalletError::Request(_))));
    // NOT an IPv4 host: Teredo, an ISATAP interface identifier, a documentation address that
    // happens to end in the same 32 bits, the unspecified address
    for id in ["https://[2001:0:c000:207::1]", "https://[2001:db8::5efe:c000:207]", "https://[2001:db8::c000:207]", "https://[::]"] {
        assert_eq!(set(&["https://192.0.2.7", id, other]).unwrap(), 3, "{id} is a host of its own");
    }
    // loopback is what it was: `[::1]` and `[::ffff:127.0.0.1]` are loopback hosts, a development
    // set tells its nodes apart by port — and the two spellings of 127.0.0.1 are one host there too
    assert_eq!(set(&["http://127.0.0.1:8001", "http://[::1]:8002"]).unwrap(), 2);
    assert!(set(&["http://127.0.0.1:8001", "http://[::ffff:127.0.0.1]:8001"]).is_err());
    assert_eq!(set(&["http://127.0.0.1:8001", "http://[::ffff:127.0.0.1]:8002"]).unwrap(), 2);
    // a stored state with both spellings (written before this rule) is refused on read, and
    // gives up its locks — without the node set, which the client configures again
    let mut s = WalletState::new([1u8; 32]);
    s.set_nodes(&["https://192.0.2.7", other]).unwrap();
    let mut text: serde_json::Value = serde_json::from_str(&s.to_json().unwrap()).unwrap();
    text["nodes"] = serde_json::json!(["https://192.0.2.7", "https://[::ffff:192.0.2.7]", other]);
    assert!(WalletState::from_json(&text.to_string()).is_err());
    assert!(!WalletState::recover_locks(&text.to_string()).unwrap().nodes_kept);
}

// ---------------------------------------------------------------------------------------------------
// RW5-9
// ---------------------------------------------------------------------------------------------------

/// A state text of the current format must SAY where it stands: none of the fields format 5
/// added is completed on read. And a text that names an older format while it carries the
/// embargo field is a format-5 text with a damaged version — not a state "without embargo".
/// `recover_locks` reads the locks of all of them, into a state that is under the embargo
/// unless the text itself says, readably, that it is not.
#[test]
fn rw5r_f9_a_state_text_that_does_not_say_where_it_stands_is_refused_not_defaulted() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    // a restored device: under the embargo, with a base, one payment out after it ended
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    let mut w = WalletState::new(alice.address().pk);
    configure(&mut w, &[N1, N2, N3]);
    w.scan(&chain.page(0), &alice.scan_key()).unwrap();
    w.confirm_state(&[chain.report(N1), chain.report(N2), chain.report(N3)]).unwrap();
    let embargo = w.spend_embargo();
    assert!(matches!(embargo, SpendEmbargo::Until { waived: false, .. }) && w.spend_gate().is_err());
    let text: serde_json::Value = serde_json::from_str(&w.to_json().unwrap()).unwrap();
    let without = |key: &str| {
        let mut t = text.clone();
        assert!(t.as_object_mut().unwrap().remove(key).is_some(), "{key} is a field of the state text");
        t.to_string()
    };
    // (1) each of the five fields format 5 added is required
    for key in ["spend_embargo", "sole_copy_asserted", "view_only_since", "revision_id", "own_shields"] {
        assert!(matches!(WalletState::from_json(&without(key)), Err(WalletError::State(_))), "a format-5 text without `{key}` is refused");
        let r = WalletState::recover_locks(&without(key)).unwrap();
        // what is missing is the embargo itself ⇒ the embargo, from the start; anything else:
        // the embargo the text names, with its base
        let expected = if key == "spend_embargo" { SpendEmbargo::AwaitingBase } else { embargo };
        assert_eq!((r.state.spend_embargo(), r.embargo), (expected, true), "without `{key}`");
        assert!(r.state.spend_gate().is_err());
    }
    // … a field that is there and unreadable is no better than one that is missing
    let mut t = text.clone();
    t["spend_embargo"] = serde_json::json!({ "kind": "none_at_all" });
    assert!(WalletState::from_json(&t.to_string()).is_err());
    assert_eq!(WalletState::recover_locks(&t.to_string()).unwrap().state.spend_embargo(), SpendEmbargo::AwaitingBase);
    t["spend_embargo"] = serde_json::json!({ "kind": "not_required" });
    // (… while a text that SAYS "not required" is a text of a state with a lock history: the
    // core wrote it, or somebody who can write the state did — outside the model)
    assert_eq!(WalletState::from_json(&t.to_string()).unwrap().spend_embargo(), SpendEmbargo::NotRequired);
    // (2) the version number damaged to an older format: refused by `from_json`, and
    // `recover_locks` goes by what the text says about the embargo, not by the number
    for version in 1..=4u32 {
        let mut t = text.clone();
        t["version"] = serde_json::json!(version);
        assert!(matches!(WalletState::from_json(&t.to_string()), Err(WalletError::State(_))), "version {version} with a spend embargo is not a format-{version} text");
        let r = WalletState::recover_locks(&t.to_string()).unwrap();
        assert_eq!((r.state.spend_embargo(), r.embargo), (embargo, true), "version damaged to {version}");
    }
    // (3) a TRUE older text has no such field and is a device's own state: no embargo —
    // given explicitly by its migration, for every older format
    let mut v4 = text.clone();
    v4["version"] = serde_json::json!(4);
    for key in ["revision_id", "spend_embargo", "sole_copy_asserted", "view_only_since", "own_shields"] {
        v4.as_object_mut().unwrap().remove(key);
    }
    let migrated = WalletState::from_json(&v4.to_string()).expect("format 4 is migrated in place");
    assert_eq!((migrated.spend_embargo(), migrated.sole_copy_asserted(), migrated.view_only_since(), migrated.own_shields().len()), (SpendEmbargo::NotRequired, false, None, 0));
    assert_eq!(WalletState::recover_locks(&v4.to_string()).unwrap().state.spend_embargo(), SpendEmbargo::NotRequired);
    // … but a format-4 text that carries ANY of the five fields is not one format 4 wrote
    for key in ["revision_id", "sole_copy_asserted", "view_only_since", "own_shields"] {
        let mut t = v4.clone();
        t[key] = text[key].clone();
        assert!(WalletState::from_json(&t.to_string()).is_err(), "format 4 with `{key}`");
    }
    // (4) formats 2 and 3 without their pending list: refused (not "no locks"), and recovered
    // under the embargo
    for version in [2u32, 3] {
        let old = serde_json::json!({ "version": version, "revision": 7, "pk": text["pk"], "min_note_value": "1000000000", "next_height": 9, "notes": [] });
        assert!(matches!(WalletState::from_json(&old.to_string()), Err(WalletError::State(_))), "format {version} without `pending`");
        let r = WalletState::recover_locks(&old.to_string()).unwrap();
        assert_eq!((r.state.spend_embargo(), r.embargo, r.entries_kept), (SpendEmbargo::AwaitingBase, true, 0));
        let mut with = old.clone();
        with["pending"] = serde_json::json!([]);
        assert_eq!(WalletState::from_json(&with.to_string()).unwrap().spend_embargo(), SpendEmbargo::NotRequired, "format {version} with its (empty) list: the device's own state");
    }
    // the embargo that was carried over still ends where it ended
    let SpendEmbargo::Until { until, .. } = embargo else { unreachable!() };
    let mut r = WalletState::recover_locks(&without("own_shields")).unwrap().state;
    chain.advance_to(until);
    r.scan(&chain.page(0), &alice.scan_key()).unwrap();
    r.confirm_state(&[chain.report(N1), chain.report(N2), chain.report(N3)]).unwrap();
    let p = position_of(&r, 10 * Q);
    pay_with(&mut r, &alice, &[p], &bob.address(), 4 * Q, "rw5r-f9-after").expect("the embargo has ended");
}

// ---------------------------------------------------------------------------------------------------
// X14, X17 (REVIEW_WALLET_5 section 5): the two halves of a lock, and of "spent"
// ---------------------------------------------------------------------------------------------------

/// **X14 — a lock is held by commitment AND by nullifier.** The nullifier half is what holds an
/// entry that has no commitments: an entry migrated from format 2 while its notes were not in
/// the state (the middle of a rescan). Format 2 held such an entry by leaf position; the rescan
/// here runs against a listing with two forged entries in front, so the note sits four leaves
/// further — the position names another leaf, and only the nullifier finds the note.
#[test]
fn rw5r_x14_an_entry_without_commitments_holds_its_note_by_nullifier_wherever_the_listing_puts_it() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let (chain, mut w) = new_wallet(&alice);
    let p_in = position_of(&w, 10 * Q);
    pay_with(&mut w, &alice, &[p_in], &bob.address(), 4 * Q, "rw5r-x14-t1").unwrap();
    let entry = w.pending()[0].clone();
    // the state as format 2 held it in the middle of a rescan: the entry, and no note
    let empty = WalletState::new(alice.address().pk);
    let v2 = serde_json::json!({
        "version": 2, "pk": hex::encode(alice.address().pk), "next_height": 0, "notes": [],
        "tree": { "note_count": 0, "frontier": empty.tree().frontier().iter().map(hex::encode).collect::<Vec<_>>(), "root": hex::encode(empty.anchor()), "witnesses": {} },
        "pending": [{
            "tx_type": entry.tx_type, "nullifiers": entry.nullifiers, "inputs": entry.inputs, "input_total": entry.input_total.to_string(),
            "change": entry.change.as_ref().map(|c| serde_json::json!({ "cm": c.cm, "value": c.value.to_string() })),
            "expiry_height": entry.expiry_height, "status": "pending", "mined_height": null, "rejected_hint": false,
        }],
        "checkpoints": [], "confirmed_height": null, "blind": { "seen": [], "overflow": false },
    });
    let mut m = WalletState::from_json(&v2.to_string()).expect("format 2 is migrated");
    assert!(m.pending().len() == 1 && m.pending()[0].input_cms.is_empty() && m.pending()[0].inputs == vec![p_in] && m.spend_embargo() == SpendEmbargo::NotRequired);
    configure(&mut m, &[N1, N2, N3]);
    // the rescan: two forged payments in front, every real leaf four further
    let forged: Vec<Vec<u8>> = (0..2)
        .map(|i| {
            let req = ShieldRequest { ctx: chain.ctx(), from_pub_key: &fake_account_key(2), nonce: 1, v_in: 51 * Q, fee: Q, recipient: &alice.address(), max_fee: None };
            deterministic::shield(&req, &format!("rw5r-x14-forged-{i}")).unwrap().body
        })
        .collect();
    let mut page = chain.page_value(0, chain.height);
    let txs = page["txs"].as_array_mut().unwrap();
    let first_height = txs[0]["height"].as_u64().unwrap();
    for t in txs.iter_mut() {
        for j in 0..2 {
            t["outputs"][j]["leaf"] = serde_json::json!(t["outputs"][j]["leaf"].as_u64().unwrap() + 4);
        }
        if t["height"].as_u64() == Some(first_height) {
            t["index"] = serde_json::json!(t["index"].as_u64().unwrap() + 2);
        }
    }
    for (i, body) in forged.iter().enumerate() {
        txs.insert(i, listing_entry(body, first_height, i as u64, 2 * i as u64));
    }
    m.scan(&parse(&page), &alice.scan_key()).unwrap();
    let moved = position_of(&m, 10 * Q);
    assert_eq!(moved, p_in + 4, "the note sits four leaves further than the entry's position says");
    assert!(m.is_locked(moved), "G1: the entry holds its note by nullifier, wherever the listing put it");
    assert!(m.balances().locked >= 10 * Q as u128);
    assert!(matches!(m.spend_input_with(moved, true), Err(WalletError::NoteLocked)));
    // (whatever sits at the OLD position now is locked too: format 2's rule, kept for such an entry)
    WalletState::from_json(&m.to_json().unwrap()).unwrap();
    // and on the true listing the same entry holds the same note
    let mut honest = m.fresh_for_rescan();
    honest.scan(&chain.page(0), &alice.scan_key()).unwrap();
    assert!(honest.is_locked(position_of(&honest, 10 * Q)));
}

/// **X17 — a pending entry's nullifier in the listing spends the entry's input by commitment.**
/// It matters for a note without a stored nullifier: a state that is rescanned with the VIEWING
/// key cannot see spends, but it knows its own pending payments — when the listing shows one of
/// their nullifiers, the input is spent, although the note's own nullifier is unknown.
#[test]
fn rw5r_x17_a_pending_payment_seen_without_the_nullifier_key_spends_its_input_by_commitment() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let (mut chain, mut w) = new_wallet(&alice);
    let p_in = position_of(&w, 10 * Q);
    let t1 = pay_with(&mut w, &alice, &[p_in], &bob.address(), 4 * Q, "rw5r-x17-t1").unwrap();
    chain.block(&[&t1.body]).unwrap();
    // the rescan — by the worker, with the viewing key
    let mut s = w.fresh_for_rescan();
    let r = s.scan(&chain.page(0), &alice.incoming_viewing_key()).unwrap();
    let input = s.notes().iter().find(|n| n.value == 10 * Q).expect("the input note is found by its ciphertext");
    assert!(input.nullifier.is_none(), "found without the nullifier key");
    assert_eq!((input.spent, input.spent_height, r.spent.len(), r.pending_seen_mined), (true, Some(chain.height), 1, 1), "and spent: the pending entry's nullifier appeared");
    let c = s.confirm_state(&[chain.report(N1), chain.report(N2), chain.report(N3)]).unwrap();
    assert_eq!(c.matched_height, Some(chain.height));
    // the spent input is in no figure — not in "received, spend unknown" either
    let b = s.balances();
    assert_eq!(b.received_spend_unknown, (6 + 5) * Q as u128, "the 6 XRGE note and the change: received for certain, spends unknown; NOT the input");
    assert_eq!((s.resolve().mined.len(), s.balances().locked), (1, 0));
    WalletState::from_json(&s.to_json().unwrap()).unwrap();
}
