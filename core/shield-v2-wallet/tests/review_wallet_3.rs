//! REVIEW_WALLET_3 — third independent review, of the settlement REDESIGN made after
//! REVIEW_WALLET_2 (see `REVIEW_WALLET_3.md`, and its "Resolution" section for what was done).
//!
//! The review left these tests failing on purpose. **Every one passes since
//! `fix/shield-v2-wallet-settlement-2`**, asserting the safe behaviour:
//!
//! * `rw3_fN_…` — regression tests of the confirmed defects (RW3-1 … RW3-8), each still printing
//!   what it found;
//! * `rw3_demo_…` — a limit that is real and that no wallet core can remove (it passes; the
//!   assertions state the limit so that nobody builds on the other reading). One is left:
//!   RW3-10, devices without shared state. The other three demos of the review showed behaviour
//!   that is now fixed and are regression tests (`rw3_f1b`, `rw3_f2b`, `rw3_f8`);
//! * `rw3_sound_…` — an attack that was tried and does not work.
//!
//! Needs the `test-vectors` feature (proof-less deterministic assembly), like the earlier reviews.
#![cfg(feature = "test-vectors")]

mod common;

use common::*;
use quantum_vault_shield_v2::reference::{derive_rho, digest_from_bytes, digest_to_bytes, nullifier, Note, MODULUS};
use quantum_vault_shield_v2_wallet::note_enc::encrypt_note_with_kem_randomness;
use quantum_vault_shield_v2_wallet::store::{ListedOutput, ListedTx, MAX_STORED_NOTES};
use quantum_vault_shield_v2_wallet::tx::deterministic;
use quantum_vault_shield_v2_wallet::*;
use sha2::{Digest as _, Sha256};

const N1: &str = "node-1";
const N2: &str = "node-2";
const N3: &str = "node-3";

fn fund(chain: &mut Chain, to: &ShieldedAddress, values: &[u64]) {
    let key = fake_account_key(1);
    for (i, v) in values.iter().enumerate() {
        let req = ShieldRequest { ctx: chain.ctx(), from_pub_key: &key, nonce: 1, v_in: v + Q, fee: SHIELD_V2_MIN_FEE_QUANTA, recipient: to, max_fee: None };
        let tx = deterministic::shield(&req, &format!("rw3-fund-{}-{i}", chain.height)).unwrap();
        chain.block(&[&tx.body]).unwrap();
    }
}

fn base(to: &ShieldedAddress, values: &[u64]) -> Chain {
    let mut c = Chain::new();
    fund(&mut c, to, values);
    c
}

/// A wallet scanned to the tip of `chain` and configured with three nodes.
fn synced(chain: &Chain, keys: &ShieldedKeys) -> WalletState {
    let mut s = WalletState::new(keys.address().pk);
    configure(&mut s, &[N1, N2, N3]);
    s.scan(&chain.page(s.next_height()), &keys.scan_key()).unwrap();
    assert_eq!(s.anchor(), chain.state().tree_root);
    s
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

/// A canonical digest (every 4-byte word below the field modulus) from a tag.
fn canon(tag: u64) -> [u8; 32] {
    let h = Sha256::digest(tag.to_le_bytes());
    let mut b = [0u8; 32];
    for (w, s) in b.chunks_mut(4).zip(h.chunks(4)) {
        w.copy_from_slice(&(u32::from_le_bytes(s.try_into().unwrap()) % MODULUS).to_le_bytes());
    }
    b
}

/// [`pay`] from the one unspent note of this value.
fn pay_note(state: &mut WalletState, keys: &ShieldedKeys, note_value: u64, to: &ShieldedAddress, amount: u64, label: &str) -> quantum_vault_shield_v2_wallet::tx::UnprovenTx {
    let position = position_of(state, note_value);
    pay(state, keys, &[position], to, amount, label)
}

fn position_of(s: &WalletState, value: u64) -> u64 {
    s.unspent().find(|n| n.value == value).expect("a note of that value").position
}

/// What the address really holds on `chain`: every note, whatever its size.
fn true_balance(chain: &Chain, keys: &ShieldedKeys) -> u128 {
    let mut reference = WalletState::with_min_note_value(keys.address().pk, 1).unwrap();
    reference.scan(&chain.page(0), &keys.scan_key()).unwrap();
    reference.balance()
}

/// A node that reports the chain's state with another nullifier hash.
fn lying_report(chain: &Chain, id: &str) -> StateReport {
    let mut r = chain.report(id);
    r.nullifier_acc = canon(7);
    r
}

// ---------------------------------------------------------------------------------------------------
// RW3-1 (High, G4) — one lying node of three used to stop every confirmation, for as long as it liked.
// ---------------------------------------------------------------------------------------------------

/// Three configured nodes; two are honest and report exactly the wallet's state; the third
/// reports another nullifier hash for the same height, in every call. Guarantee G4: a lying
/// minority causes delay only — here not even that. Every call confirms the tip, the report
/// names the dissenting NODE (so a user interface can say "node 3 disagrees"), and the pending
/// transaction that was withheld is released when the confirmed height reaches its expiry.
#[test]
fn rw3_f1_one_lying_node_of_three_freezes_confirmation_and_every_lock() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = base(&alice.address(), &[10 * Q]);
    let mut w = synced(&chain, &alice);
    let three = |c: &Chain| vec![c.report(N1), c.report(N2), lying_report(c, N3)];

    assert_eq!(w.confirm_state(&three(&chain)).unwrap().matched_height, Some(chain.height));
    let t1 = pay_note(&mut w, &alice, 10 * Q, &bob.address(), 4 * Q, "rw3-f1-t1");
    let record = t1.pending().unwrap();
    let confirmed_before = w.confirmed_height().unwrap();
    assert_eq!(record.expiry_height, confirmed_before + DEFAULT_EXPIRY_OFFSET);

    let (rounds, mut matched, mut diverged) = (6usize, 0usize, 0usize);
    for _ in 0..rounds {
        chain.advance_to(chain.height + 40); // far past the expiry (64 blocks) by the third round
        fund(&mut chain, &alice.address(), &[Q]);
        w.scan(&chain.page(w.next_height()), &alice.scan_key()).unwrap();
        let c = w.confirm_state(&three(&chain)).unwrap();
        matched += c.matched_height.is_some() as usize;
        diverged += c.diverged as usize;
        assert_eq!((c.configured, c.nodes, c.quorum, c.agreeing), (3, 3, 2, 2), "two of three report exactly the wallet's state: a quorum");
        assert_eq!(c.dissenting, vec![Dissent { node_id: node(N3), height: chain.height }], "the dissenting node is named");
        assert!(!c.listing_refuted, "one dissenter of three is what a lying minority can be: the listing is not in doubt");
    }
    let r = w.resolve();
    let b = w.balances();
    println!(
        "three nodes, one liar, {rounds} state checks over {} blocks: matched {matched}, diverged {diverged}; confirmed height {:?} (was {confirmed_before}); \
         t1 expired at height {} and the chain is at {}: resolve settled {} and left {} pending; locked {} quanta, unverified {} quanta",
        chain.height - confirmed_before,
        w.confirmed_height(),
        record.expiry_height,
        chain.height,
        r.expired.len() + r.mined.len() + r.superseded.len(),
        r.still_pending,
        b.locked,
        b.unverified
    );
    assert_eq!((matched, diverged), (rounds, 0), "two honest nodes of three agree with the wallet in every call: one liar must not stop the confirmation (G4)");
    assert_eq!((r.expired.len(), r.still_pending), (1, 0), "t1 is long expired on the chain two honest nodes report: its input must be released");
    assert_eq!((b.locked, b.unverified, b.spendable), (0, 0, 16 * Q as u128));
}

/// The way out `NOTES.md` used to name — "drop a node" — confirmed a forgery, because the quorum
/// was a majority of the reports HANDED IN. It is now a strict majority of the nodes the wallet
/// is CONFIGURED with, a property of the state: five configured nodes, two of them one liar's;
/// the wallet's listing is the liar's and contains a payment that is on no chain.
///
/// * all five reports: three honest nodes contradict the wallet — more than a lying minority of
///   five can be — so the call says that the wallet's LISTING is refuted;
/// * the two liars alone: two is not three. Leaving nodes out can only make it harder;
/// * mutations M4 (a conflict no longer blocks) and M9 (the quorum is not raised to a majority)
///   of the review were invisible to every test; this test and `rw3_f8` fail under their
///   successors (the quorum computed from the reports supplied; `quorum − 1` accepted).
#[test]
fn rw3_f1b_leaving_nodes_out_cannot_lower_the_quorum_and_two_liars_of_five_confirm_nothing() {
    let alice = keys(PHRASE_1);
    let mut chain = base(&alice.address(), &[10 * Q]);
    chain.advance_to(chain.height + 1);
    // the liar's listing: the real blocks plus a shield of 50 XRGE at the tip that no chain holds
    let mut page = chain.page_value(0, chain.height);
    let forged = deterministic::shield(
        &ShieldRequest { ctx: chain.ctx(), from_pub_key: &fake_account_key(6), nonce: 1, v_in: 51 * Q, fee: Q, recipient: &alice.address(), max_fee: None },
        "rw3-forged",
    )
    .unwrap();
    page["txs"].as_array_mut().unwrap().push(listing_entry(&forged.body, chain.height, 0, chain.state().note_count));
    let mut w = WalletState::new(alice.address().pk);
    configure(&mut w, &["h1", "h2", "h3", "liar-1", "liar-2"]);
    w.scan(&parse(&page), &alice.scan_key()).unwrap();
    assert_eq!(w.balances().unverified, 60 * Q as u128);

    let honest: Vec<StateReport> = ["h1", "h2", "h3"].iter().map(|id| chain.report(id)).collect();
    let liars = vec![echo(&w, "liar-1"), echo(&w, "liar-2")];
    let all: Vec<StateReport> = honest.iter().chain(&liars).cloned().collect();
    let c = w.clone().confirm_state(&all).unwrap();
    assert!(c.diverged && c.matched_height.is_none() && (c.configured, c.nodes, c.quorum, c.agreeing) == (5, 5, 3, 2));
    assert!(c.listing_refuted, "three of five contradict the wallet: its own listing is not the chain — rescan elsewhere");
    assert_eq!(c.dissenting.iter().map(|d| d.node_id.as_str()).collect::<Vec<_>>(), [node("h1"), node("h2"), node("h3")]);

    // "drop the nodes that conflict": the two that agree, alone — the threshold has not moved
    let mut dropped = w.clone();
    let c = dropped.confirm_state(&liars).unwrap();
    assert_eq!((c.matched_height, c.configured, c.nodes, c.quorum, c.agreeing, c.diverged), (None, 5, 2, 3, 2, false));
    assert_eq!((dropped.balances().confirmed, dropped.balances().spendable), (0, 0), "the forged 50 XRGE are not confirmed (the chain holds 10)");
    assert!(dropped.content_eq(&w), "nothing changed");
    // any four with the two liars among them: still two agreeing
    for leave_out in 0..3 {
        let four: Vec<StateReport> = all.iter().enumerate().filter(|(i, _)| *i != leave_out).map(|(_, r)| r.clone()).collect();
        assert!(w.clone().confirm_state(&four).unwrap().matched_height.is_none());
    }
    // the only way to change the threshold is the explicit call, which is the user's trust decision
    let mut reconfigured = w.clone();
    configure(&mut reconfigured, &["liar-1", "liar-2"]);
    assert_eq!(reconfigured.confirm_state(&liars).unwrap().matched_height, Some(chain.height), "LIMIT: a wallet configured with liars only believes them");
    // an honest rescan confirms the truth with the three honest nodes, the liars dissenting
    let mut honest_scan = w.fresh_for_rescan();
    honest_scan.scan(&chain.page(0), &alice.scan_key()).unwrap();
    let c = honest_scan.confirm_state(&all).unwrap();
    assert_eq!((c.matched_height, c.agreeing, c.dissenting.len(), honest_scan.balances().confirmed), (Some(chain.height), 3, 2, 10 * Q as u128));
}

/// RW3-8 and the quorum arithmetic: the quorum for one to seven CONFIGURED nodes, what a node id
/// is (an http(s) origin in canonical form — one endpoint in any spelling is one node), and that
/// changing the configured set is explicit, keeps what was confirmed and binds what follows.
#[test]
fn rw3_f8_the_quorum_is_a_strict_majority_of_the_configured_nodes_and_node_ids_are_canonical() {
    let alice = keys(PHRASE_1);
    let mut chain = base(&alice.address(), &[10 * Q]);
    let ids: Vec<String> = (0..7).map(|i| format!("n{i}")).collect();
    let mut seen = Vec::new();
    for n in 1..=7usize {
        let mut w = WalletState::new(alice.address().pk);
        let configured: Vec<&str> = ids[..n].iter().map(String::as_str).collect();
        configure(&mut w, &configured);
        w.scan(&chain.page(0), &alice.scan_key()).unwrap();
        let q = w.quorum();
        let reports = |agree: usize| -> Vec<StateReport> {
            configured.iter().enumerate().map(|(i, id)| if i < agree { chain.report(id) } else { lying_report(&chain, id) }).collect()
        };
        // all agree; exactly the quorum agrees and everyone else contradicts; one fewer
        let all = w.clone().confirm_state(&reports(n)).unwrap().matched_height.is_some();
        let exact = if q <= n { w.clone().confirm_state(&reports(q)).unwrap() } else { ConfirmReport::default() };
        let short = w.clone().confirm_state(&reports(q - 1)).unwrap();
        assert!(short.matched_height.is_none(), "{n} nodes: {} agreeing are not a quorum of {q}", q - 1);
        // the same with the dissenters simply not asked: the threshold does not follow the reports
        assert!(w.clone().confirm_state(&reports(n)[..q - 1]).unwrap().matched_height.is_none(), "{n} nodes: {} reports alone", q - 1);
        if q <= n {
            assert_eq!((exact.matched_height, exact.agreeing, exact.dissenting.len(), exact.diverged), (Some(chain.height), q, n - q, false), "{n} nodes");
            assert!(!exact.listing_refuted, "{n} nodes: n − quorum dissenters are what a strict minority can be");
        }
        seen.push((n, q, all));
    }
    assert_eq!(seen, [(1, 2, false), (2, 2, true), (3, 2, true), (4, 3, true), (5, 3, true), (6, 4, true), (7, 4, true)]);

    // one node counts once per height, however often it reports and under whatever spelling
    let mut w = WalletState::new(alice.address().pk);
    configure(&mut w, &["n0", "n1", "n2"]);
    w.scan(&chain.page(0), &alice.scan_key()).unwrap();
    let spelled = |id: &str| StateReport { node_id: id.into(), ..chain.report("n0") };
    let c = w.clone().confirm_state(&[spelled("https://n0.example"), spelled("https://n0.example/"), spelled("HTTPS://N0.EXAMPLE"), spelled("https://n0.example:443/api/shield-v2/stats?x=1")]).unwrap();
    assert_eq!((c.nodes, c.agreeing, c.matched_height), (1, 1, None), "one endpoint in four spellings is one node");

    // the canonical form
    for (given, canonical) in [
        ("https://node.example", "https://node.example"),
        ("https://node.example/", "https://node.example"),
        ("HTTPS://NODE.EXAMPLE", "https://node.example"),
        ("https://Node.Example:443", "https://node.example"),
        ("https://node.example.:443/api/shield-v2/stats?since=3#x", "https://node.example"),
        ("http://node.example:80/", "http://node.example"),
        ("http://node.example:080", "http://node.example"),
        ("http://node.example:443", "http://node.example:443"),
        ("https://node.example:08443/x", "https://node.example:8443"),
        ("http://127.0.0.1:5100", "http://127.0.0.1:5100"),
        ("https://[2001:DB8::1]:5100/", "https://[2001:db8::1]:5100"),
        ("https://[::1]", "https://[::1]"),
    ] {
        assert_eq!(canonical_node_id(given).unwrap(), canonical, "{given}");
    }
    for refused in [
        "", "node.example", "node-a", "ftp://node.example", "https://", "https:///path", "https://user@node.example", "https://user:pw@node.example",
        "https://node.example:0", "https://node.example:65536", "https://node.example:port", "https://node.example:", "https://no de.example",
        "https://node_a.example", "https://-node.example", "https://node..example", "https://[::1", "https://[zz::1]", "https://[::1]x", "https://nöde.example",
    ] {
        assert!(matches!(canonical_node_id(refused), Err(WalletError::Request(_))), "{refused:?} is not an http(s) origin");
    }
    assert!(canonical_node_id(&format!("https://{}.example", "a".repeat(63))).is_ok());
    assert!(canonical_node_id(&format!("https://{}.example", "a".repeat(64))).is_err());
    // set_nodes: canonicalised, duplicates collapsed, sorted; one bad id refuses the whole call
    let mut s = WalletState::new(alice.address().pk);
    let rev = s.revision();
    assert_eq!(
        s.set_nodes(&["https://node.example", "https://node.example/", "HTTPS://NODE.EXAMPLE", "https://b.example:443", "http://node.example"]).unwrap(),
        vec!["http://node.example", "https://b.example", "https://node.example"]
    );
    assert_eq!((s.nodes().len(), s.quorum(), s.revision()), (3, 2, rev + 1));
    assert!(s.set_nodes(&["https://c.example", "c"]).is_err() && s.nodes().len() == 3 && s.revision() == rev + 1, "refused as a whole");
    assert!(s.set_nodes(&(0..65).map(|i| format!("https://n{i}.example")).collect::<Vec<_>>()).is_err(), "at most 64 nodes");
    assert_eq!(WalletState::from_json(&s.to_json().unwrap()).unwrap(), s, "the configured set is part of the state");
    let mut tampered: serde_json::Value = serde_json::from_str(&s.to_json().unwrap()).unwrap();
    tampered["nodes"] = serde_json::json!(["https://b.example", "HTTPS://B.EXAMPLE/"]);
    assert!(WalletState::from_json(&tampered.to_string()).is_err(), "a stored set that is not canonical is refused");

    // changing the set: nothing is un-confirmed, and every later confirmation needs the NEW majority
    let mut w = WalletState::new(alice.address().pk);
    configure(&mut w, &["a", "b"]);
    w.scan(&chain.page(0), &alice.scan_key()).unwrap();
    assert!(w.confirm_state(&[chain.report("a"), chain.report("b")]).unwrap().matched_height.is_some());
    let confirmed = (w.confirmed_height(), w.balances().confirmed);
    configure(&mut w, &["c", "d", "e"]);
    assert_eq!((w.confirmed_height(), w.balances().confirmed), confirmed, "what was confirmed stays confirmed");
    fund(&mut chain, &alice.address(), &[5 * Q]);
    w.scan(&chain.page(w.next_height()), &alice.scan_key()).unwrap();
    let c = w.confirm_state(&[chain.report("a"), chain.report("b")]).unwrap();
    assert_eq!((c.matched_height, c.not_configured, c.nodes), (None, 2, 0), "the old nodes are nobody now");
    assert!(w.confirm_state(&[chain.report("c")]).unwrap().matched_height.is_none());
    assert_eq!(w.confirm_state(&[chain.report("c"), chain.report("e")]).unwrap().matched_height, Some(chain.height));
    // no nodes, one node: nothing, ever
    for few in [vec![], vec!["a"]] {
        let mut single = WalletState::new(alice.address().pk);
        configure(&mut single, &few);
        single.scan(&chain.page(0), &alice.scan_key()).unwrap();
        let c = single.confirm_state(&[chain.report("a"), chain.report("a"), chain.report("b")]).unwrap();
        assert_eq!((c.matched_height, c.quorum, single.balances().confirmed, single.balances().unverified), (None, 2, 0, 15 * Q as u128), "a single-node wallet shows everything as unverified");
        assert!(matches!(single.spend_base(true), Err(WalletError::StateUnconfirmed)), "and builds nothing");
    }
}

// ---------------------------------------------------------------------------------------------------
// RW3-2 (Medium, G3/G4) — ciphertexts were in neither half of the confirmed state.
// ---------------------------------------------------------------------------------------------------

/// `t1` (Alice pays Bob 4 of her 10 XRGE note; 5 XRGE change) is really mined. The node the wallet
/// lists from serves the real block with the two ciphertexts of the CHANGE output zeroed.
///
/// (a) The wallet's own change does not depend on a ciphertext: the pending record holds the
///     commitment, the value and `r`, and when the scan meets that commitment in the tree it
///     stores the note from the record.
/// (b) The altered listing cannot be confirmed: the ciphertexts are in the running hash the
///     quorum vouches for. Two honest nodes refute the listing; a rescan against an honest node
///     confirms, `t1` settles as `mined`, and the 5 XRGE are a confirmed note.
#[test]
fn rw3_f2_a_blanked_change_ciphertext_settles_as_mined_and_the_change_is_silently_gone() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = base(&alice.address(), &[10 * Q]);
    let mut w = synced(&chain, &alice);
    confirm(&chain, &mut w);
    let t1 = pay_note(&mut w, &alice, 10 * Q, &bob.address(), 4 * Q, "rw3-f2-t1");
    let record = t1.pending().unwrap();
    let change = record.change.clone().unwrap();
    assert_eq!((change.value, change.r.is_some()), (5 * Q, true));
    chain.block(&[&t1.body]).unwrap();
    assert_eq!(true_balance(&chain, &alice), 5 * Q as u128);

    let mut page = chain.page_value(w.next_height(), chain.height);
    let change_hex = hex::encode(change.cm.0);
    let mut blanked = 0;
    for tx in page["txs"].as_array_mut().unwrap() {
        for out in tx["outputs"].as_array_mut().unwrap() {
            if out["cm_out"] == change_hex.as_str() {
                out["kem_ct"] = serde_json::json!("00".repeat(1088));
                out["note_ct"] = serde_json::json!("00".repeat(56));
                blanked += 1;
            }
        }
    }
    assert_eq!(blanked, 1);
    let report = w.scan(&parse(&page), &alice.scan_key()).unwrap();
    // (a) found without its ciphertext
    assert_eq!((report.pending_seen_mined, report.received.len(), report.own_outputs_from_record, report.not_stored), (1, 1, 1, 0));
    let stored = w.notes().iter().find(|n| n.cm == change.cm).expect("the change is stored from the pending record");
    assert_eq!((stored.value, stored.r, stored.spent, stored.confirmed), (5 * Q, change.r.unwrap(), false, false));
    assert!(stored.nullifier.is_some() && w.tree().path(stored.position).is_some(), "with its nullifier and its Merkle path");
    // (b) the altered listing is not the nodes' state
    assert_ne!(w.ciphertext_acc(), chain.ciphertext_acc);
    assert_eq!((w.anchor(), w.nullifier_acc()), (chain.state().tree_root, chain.state().nullifier_acc), "root and nullifier hash ARE the chain's");
    let c = w.confirm_state(&[chain.report(N1), chain.report(N2), echo(&w, N3)]).unwrap();
    assert!(c.matched_height.is_none() && c.diverged && c.listing_refuted, "a listing with a blanked ciphertext cannot be confirmed: {c:?}");
    assert_eq!(w.resolve().still_pending, 1, "and nothing settles on it");
    // the recovery the report asks for
    let mut honest = w.fresh_for_rescan();
    honest.scan(&chain.page(0), &alice.scan_key()).unwrap();
    confirm(&chain, &mut honest);
    let r = honest.resolve();
    assert_eq!((r.mined.len(), r.still_pending), (1, 0));
    let b = honest.balances();
    println!(
        "t1 settled as mined on confirmed data; the chain holds {} quanta for the wallet, the wallet shows confirmed {} / unverified {} / expected change {}; \
         below_minimum {:?}, over_capacity {:?}; a note with the change commitment is stored: {}",
        true_balance(&chain, &alice),
        b.confirmed,
        b.unverified,
        b.expected_change,
        honest.below_minimum(),
        honest.over_capacity(),
        honest.notes().iter().any(|n| n.cm == change.cm)
    );
    assert_eq!(b.confirmed, 5 * Q as u128, "a transaction settled as mined returns its change: the wallet knows the commitment and saw it confirmed");
    // a record that does not open the commitment (another value) is not believed: the ciphertext decides
    let mut wrong = w.fresh_for_rescan();
    let mut forged: serde_json::Value = serde_json::from_str(&wrong.to_json().unwrap()).unwrap();
    forged["pending"][0]["change"]["value"] = serde_json::json!((6 * Q).to_string());
    wrong = WalletState::from_json(&forged.to_string()).unwrap();
    wrong.scan(&chain.page(0), &alice.scan_key()).unwrap();
    assert_eq!(wrong.balance(), 5 * Q as u128, "the note is what its commitment says");
}

/// The general case — an incoming payment whose two ciphertexts the listing node swapped — was
/// undetectable: the wallet was "confirmed" at the tip and 7 XRGE short. The node now keeps a
/// running hash over every accepted output's `(cm_out, kem_ct, note_ct)` (node-local, outside the
/// state root) and reports it; the wallet rebuilds it from the listing; `confirm_state` requires
/// it. A listing with swapped or blanked ciphertexts cannot be confirmed.
#[test]
fn rw3_f2b_swapped_ciphertexts_cannot_be_confirmed() {
    let alice = keys(PHRASE_1);
    let mut chain = base(&alice.address(), &[10 * Q]);
    let mut w = synced(&chain, &alice);
    confirm(&chain, &mut w);
    let before = w.confirmed_height();
    fund(&mut chain, &alice.address(), &[7 * Q]);
    let honest_page = chain.page_value(w.next_height(), chain.height);
    for alteration in ["swapped", "blanked", "one byte"] {
        let mut page = honest_page.clone();
        let outs = page["txs"][0]["outputs"].as_array_mut().unwrap();
        let (a, b) = (outs[0].clone(), outs[1].clone());
        match alteration {
            "swapped" => {
                for k in ["kem_ct", "note_ct"] {
                    outs[0][k] = b[k].clone();
                    outs[1][k] = a[k].clone();
                }
            }
            "blanked" => {
                for o in outs.iter_mut() {
                    o["kem_ct"] = serde_json::json!("00".repeat(1088));
                }
            }
            _ => {
                // the last byte of the note ciphertext of the output that is NOT Alice's
                for o in outs.iter_mut() {
                    let ct = o["note_ct"].as_str().unwrap().to_string();
                    let flipped = if ct.ends_with('0') { "1" } else { "0" };
                    o["note_ct"] = serde_json::json!(format!("{}{flipped}", &ct[..ct.len() - 1]));
                }
            }
        }
        let mut lied_to = w.clone();
        lied_to.scan(&parse(&page), &alice.scan_key()).unwrap();
        assert_eq!((lied_to.anchor(), lied_to.nullifier_acc()), (chain.state().tree_root, chain.state().nullifier_acc), "{alteration}: both halves of the consensus state match");
        let c = lied_to.confirm_state(&[chain.report(N1), chain.report(N2), chain.report(N3)]).unwrap();
        assert!(c.matched_height.is_none() && c.listing_refuted, "{alteration}: not confirmed");
        assert_eq!((lied_to.confirmed_height(), lied_to.balances().confirmed), (before, 10 * Q as u128), "{alteration}: the confirmed height does not pass the altered block");
    }
    // the honest listing
    w.scan(&parse(&honest_page), &alice.scan_key()).unwrap();
    confirm(&chain, &mut w);
    assert_eq!((w.balances().confirmed, true_balance(&chain, &alice)), (17 * Q as u128, 17 * Q as u128));
}

// ---------------------------------------------------------------------------------------------------
// RW3-3 (Low, G3) — the wallet dropped its own change when it was below the minimum note value.
// ---------------------------------------------------------------------------------------------------

/// No adversary. Alice pays 8.5 XRGE with the minimum fee.
///
/// * Coin selection avoids a change below the minimum note value where it can: with a 10 and a
///   3 XRGE note it takes BOTH (change 3.5) instead of the 10 alone (change 0.5).
/// * Where it cannot (a single note), it says so (`change_below_minimum`) and the payment can
///   still be made: the wallet's own change is stored whatever its size — from the pending
///   record while the entry exists, and on a later restore because the transaction that created
///   it spends a note of this wallet.
#[test]
fn rw3_f3_own_change_below_the_minimum_note_value_leaves_the_wallets_view() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = base(&alice.address(), &[10 * Q, 3 * Q]);
    let mut w = synced(&chain, &alice);
    confirm(&chain, &mut w);
    let sel = select_inputs(&w, 8 * Q + Q / 2, Q).unwrap();
    assert_eq!((sel.positions.len(), sel.total, sel.change, sel.change_below_minimum), (2, 13 * Q, 3 * Q + Q / 2, false), "a clean change is preferred");
    // exact payments and payments with a full note of change are single-note selections as before
    assert_eq!(select_inputs(&w, 9 * Q, Q).unwrap().positions, vec![position_of(&w, 10 * Q)], "change 0");
    assert_eq!(select_inputs(&w, 2 * Q, Q).unwrap().positions, vec![position_of(&w, 3 * Q)], "change 0");
    assert_eq!(select_inputs(&w, Q, Q).unwrap().positions, vec![position_of(&w, 3 * Q)], "change 1 XRGE = the minimum");
    // 11.5 + 1 of 13: no selection with a clean change exists — it is made, and flagged
    let dusty = select_inputs(&w, 11 * Q + Q / 2, Q).unwrap();
    assert_eq!((dusty.positions.len(), dusty.change, dusty.change_below_minimum), (2, Q / 2, true));

    // the user insists on the 10 XRGE note alone: 0.5 XRGE of change
    let t1 = pay_note(&mut w, &alice, 10 * Q, &bob.address(), 8 * Q + Q / 2, "rw3-f3-t1");
    assert_eq!(t1.pending().unwrap().change.unwrap().value, Q / 2);
    assert_eq!(w.balances().expected_change, (Q / 2) as u128);
    chain.block(&[&t1.body]).unwrap();
    let report = w.scan(&chain.page(w.next_height()), &alice.scan_key()).unwrap();
    assert_eq!((report.received.len(), report.not_stored, report.own_outputs_from_record), (1, 0, 1));
    confirm(&chain, &mut w);
    assert_eq!(w.resolve().mined.len(), 1);
    let b = w.balances();
    // a restore from the phrase, default minimum note value: the pending record is gone, the
    // change is still recognised as the wallet's own
    let mut restored = WalletState::new(alice.address().pk);
    restored.scan(&chain.page(0), &alice.scan_key()).unwrap();
    println!(
        "the chain holds {} quanta for the wallet; after `mined` the wallet shows confirmed {} + unverified {}, expected change {}, below_minimum {:?}; \
         a restore with the default minimum note value shows {}",
        true_balance(&chain, &alice),
        b.confirmed,
        b.unverified,
        b.expected_change,
        w.below_minimum(),
        restored.balance()
    );
    assert_eq!(b.confirmed, true_balance(&chain, &alice), "the wallet's own change is the wallet's money whatever its size");
    assert_eq!((w.below_minimum().count, b.expected_change), (0, 0));
    assert_eq!((restored.balance(), restored.below_minimum().count), (true_balance(&chain, &alice), 0), "also after a restore");
    // and it is spendable: 3 + 0.5 as two inputs
    let sel = select_inputs(&w, 2 * Q, Q).unwrap();
    assert!(sel.change == 0 || sel.change >= Q, "{sel:?}");
    // a STRANGER's dust is still counted and not stored
    let dust = deterministic::shield(
        &ShieldRequest { ctx: chain.ctx(), from_pub_key: &fake_account_key(9), nonce: 1, v_in: Q + Q / 2, fee: Q, recipient: &alice.address(), max_fee: None },
        "rw3-f3-dust",
    )
    .unwrap();
    chain.block(&[&dust.body]).unwrap();
    let report = w.scan(&chain.page(w.next_height()), &alice.scan_key()).unwrap();
    assert_eq!((report.received.len(), report.not_stored, w.below_minimum().total), (0, 1, (Q / 2) as u128));
}

// ---------------------------------------------------------------------------------------------------
// RW3-4 (Medium, G3) — a restore counted SPENT notes towards the 65,536-note capacity.
// ---------------------------------------------------------------------------------------------------

/// One crafted transaction of a listing: both outputs are notes of `values` for `address`, the
/// nullifiers are `nf`. Returns the entry and the nullifiers of the two notes it creates.
fn crafted(address: &ShieldedAddress, nk: &[u8; 32], nf: [[u8; 32]; 2], values: [u64; 2], height: u64, first_leaf: u64, tag: u64) -> (ListedTx, [[u8; 32]; 2]) {
    let pk = digest_from_bytes(&address.pk).unwrap();
    let nk = digest_from_bytes(nk).unwrap();
    let nfd = [digest_from_bytes(&nf[0]).unwrap(), digest_from_bytes(&nf[1]).unwrap()];
    let mut outputs = Vec::with_capacity(2);
    let mut next = [[0u8; 32]; 2];
    for j in 0..2 {
        let r = canon(tag * 4 + j as u64 + 1_000_000_000);
        let rho = derive_rho(&nfd, j);
        let cm = digest_to_bytes(&Note { value: values[j], pk, rho, r: digest_from_bytes(&r).unwrap() }.commitment());
        let (kem_ct, note_ct, _) = encrypt_note_with_kem_randomness(&address.ek, &cm, values[j], &r, canon(tag * 4 + j as u64 + 2_000_000_000)).unwrap();
        next[j] = digest_to_bytes(&nullifier(&nk, &rho));
        outputs.push(ListedOutput { cm_out: hex::encode(cm), leaf: Some(first_leaf + j as u64), kem_ct: hex::encode(kem_ct), note_ct: hex::encode(note_ct) });
    }
    let tx = ListedTx { height, index: 0, tx_hash: hex::encode(canon(tag)), tx_type: "shielded_transfer_v2".into(), nf1: hex::encode(nf[0]), nf2: hex::encode(nf[1]), outputs };
    (tx, next)
}

/// A wallet whose address has received 65,536 notes in its life — every one of them spent long
/// ago — is restored from its phrase (`WalletState::new` + a scan from the activation height;
/// `rescan_state` is the same code path). The cap applies to UNSPENT notes only, and the scan
/// keeps at most `MAX_SPENT_RETAINED` spent notes as it goes: the restore ends with every
/// unspent note stored — here the two that are the wallet's whole balance (101 XRGE) — and
/// nothing counted as over capacity.
#[test]
fn rw3_f4_a_restore_counts_spent_notes_towards_the_capacity_and_drops_the_live_ones() {
    let alice = keys(PHRASE_1);
    let address = alice.address();
    let key = alice.scan_key();
    let nk = key.nk.expect("the full scan key");
    let pairs = (MAX_STORED_NOTES / 2) as u64; // transactions that used to fill the capacity
    let mut w = WalletState::new(address.pk);
    configure(&mut w, &["x", "y"]);
    let mut nf = [canon(1), canon(2)];
    let (mut height, per_page) = (A, 2_048u64);
    let (mut i, mut most_stored, mut dropped) = (0u64, 0usize, 0usize);
    while i <= pairs {
        let mut txs = Vec::new();
        let from = height;
        while i <= pairs && (txs.len() as u64) < per_page {
            // every transaction spends the two notes of the one before it; the last one creates
            // the wallet's live balance
            let values = if i == pairs { [100 * Q, Q] } else { [Q, Q] };
            let (tx, next) = crafted(&address, &nk, nf, values, height, 2 * i, i + 10);
            txs.push(tx);
            nf = next;
            height += 1;
            i += 1;
        }
        let page = ListingPage { active: true, tip_height: height - 1, from_height: from, next_height: height, txs };
        dropped += w.scan(&page, &key).unwrap().spent_dropped;
        most_stored = most_stored.max(w.notes().len());
    }
    let unspent = w.unspent().count();
    let stored = w.notes().len();
    let c = w.confirm_state(&[echo(&w, "x"), echo(&w, "y")]).unwrap();
    println!(
        "restore over {} transactions: at most {most_stored} notes stored during the scan, {stored} at its end ({unspent} unspent), {dropped} spent notes dropped on the way, \
         over_capacity {:?}; after the state check {} more pruned, {} stored; balance {} quanta, on the chain 101000000000",
        pairs + 1,
        w.over_capacity(),
        c.pruned,
        w.notes().len(),
        w.balance()
    );
    assert_eq!((w.balance(), w.balances().confirmed, unspent), (101 * Q as u128, 101 * Q as u128, 2), "the two unspent notes are the wallet's balance: a restore must find them");
    assert_eq!(w.over_capacity().count, 0, "spent notes do not count towards the cap");
    assert!(most_stored <= MAX_SPENT_RETAINED + 2 * per_page as usize + 2, "{most_stored}: a scan never holds more than the retained spent notes plus one page");
    assert_eq!(w.pruned().count as usize + w.notes().len(), 2 * (pairs as usize + 1), "every note is either stored or in the pruned tally");
    assert_eq!(w.pruned().total, 65_536 * Q as u128 - w.notes().iter().filter(|n| n.spent).map(|n| n.value as u128).sum::<u128>());
    assert_eq!(WalletState::from_json(&w.to_json().unwrap()).unwrap(), w);
    // both live notes have their paths
    assert!(w.unspent().all(|n| w.tree().path(n.position).is_some()));
}

/// The cap itself: a parameter of the state, counted over UNSPENT notes from others, and what is
/// counted as over capacity is recovered by a rescan with a higher cap.
///
/// **What it costs a hostile sender to fill the default cap** with notes of at least the default
/// minimum value (1 XRGE; anything smaller is not stored at all): 32,768 transactions of two
/// 1-XRGE outputs each = 32,768 XRGE in fees (burned) + 65,536 XRGE that the victim RECEIVES and
/// can spend — an outlay of 98,304 XRGE, a third of it lost. In general, for a minimum note value
/// `m` and a cap `c`: `c/2` fees + `c·m` given away. While the cap is full, later incoming
/// payments are counted, not stored; the victim recovers them with a rescan under a higher cap
/// (no cost), or under a minimum note value above the attacker's note size, or frees room by
/// spending. The wallet's own outputs are stored regardless.
#[test]
fn rw3_f4b_the_cap_counts_unspent_notes_only_and_a_rescan_with_a_higher_cap_recovers_the_rest() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = base(&alice.address(), &[2 * Q, 3 * Q, 4 * Q, 5 * Q, 6 * Q]);
    let mut w = WalletState::with_limits(alice.address().pk, Q, 3).unwrap();
    assert_eq!(w.max_unspent_notes(), 3);
    w.scan(&chain.page(0), &alice.scan_key()).unwrap();
    assert_eq!((w.unspent().count(), w.balance(), w.over_capacity()), (3, 9 * Q as u128, Tally { count: 2, total: 11 * Q as u128 }));
    confirm(&chain, &mut w);
    // spending frees room; the wallet's own change is stored even when the state is at its cap
    let t = pay_note(&mut w, &alice, 3 * Q, &bob.address(), Q, "rw3-f4b-pay");
    chain.block(&[&t.body]).unwrap();
    fund(&mut chain, &alice.address(), &[7 * Q, 8 * Q]);
    w.scan(&chain.page(w.next_height()), &alice.scan_key()).unwrap();
    // 2, 4 kept; 3 spent, which frees one place; the change of 1 is the wallet's own and is stored
    // (it takes that place); 7 and 8 arrive at a full state and are counted
    let mut held: Vec<u64> = w.unspent().map(|n| n.value / Q).collect();
    held.sort();
    assert_eq!((held, w.over_capacity().count, w.notes().len()), (vec![1, 2, 4], 4, 4), "the spent note is kept for display and does not count");
    // the recovery: a rescan with a higher cap ends with every unspent note stored
    assert!(w.fresh_for_rescan_with(None, Some(0)).is_err() && w.fresh_for_rescan_with(None, Some((1 << 20) + 1)).is_err() && WalletState::with_limits(alice.address().pk, Q, 0).is_err());
    let mut wide = w.fresh_for_rescan_with(None, Some(64)).unwrap();
    assert_eq!((wide.max_unspent_notes(), wide.min_note_value(), wide.nodes(), wide.pending().len()), (64, Q, w.nodes(), 1));
    wide.scan(&chain.page(0), &alice.scan_key()).unwrap();
    assert_eq!((wide.balance(), wide.over_capacity().count), (true_balance(&chain, &alice), 0));
    assert_eq!(wide.balance(), (1 + 2 + 4 + 5 + 6 + 7 + 8) * Q as u128);
    assert_eq!(WalletState::from_json(&wide.to_json().unwrap()).unwrap(), wide);
}

// ---------------------------------------------------------------------------------------------------
// RW3-7 (High, G3/G4) — the expiry bound, the only thing that ends a lock, hung on one node's word.
// ---------------------------------------------------------------------------------------------------

/// The node the wallet lists from answers one empty page: "my tip is a million blocks further,
/// nothing happened". `scan` accepts it (a page can only be compared with the node's own tip).
/// It no longer matters: the builders take the anchor from the CONFIRMED checkpoint and measure
/// the expiry from the CONFIRMED height, and `mark_pending` refuses an expiry more than 128
/// blocks above it. The payment built after the lying page expires 64 blocks above the confirmed
/// height; withheld, it is released when an honest quorum confirms that height.
#[test]
fn rw3_f7_one_lying_page_inflates_the_expiry_and_the_lock_never_ends() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = base(&alice.address(), &[10 * Q, 6 * Q]);
    let mut w = synced(&chain, &alice);
    confirm(&chain, &mut w);
    let s = chain.height;
    // the lie: one empty page
    let page = serde_json::json!({ "active": true, "tip_height": s + 1_000_000, "from_height": s + 1, "next_height": s + 1_000_001, "txs": [] });
    w.scan(&parse(&page), &alice.scan_key()).unwrap();
    assert_eq!((w.confirmed_height(), w.scanned_height(), w.balances().spendable), (Some(s), Some(s + 1_000_000), 16 * Q as u128), "nothing looks wrong: confirmed notes, the chain's root");
    // a record with the expiry the old builders would have chosen (scanned height + 64) is refused
    let low = TransferRequest {
        ctx: TxContext::new(CHAIN, w.anchor(), w.scanned_height().unwrap()),
        keys: &alice,
        inputs: &[w.spend_input(position_of(&w, 10 * Q)).unwrap()],
        recipient: &bob.address(),
        amount: 4 * Q,
        fee: Q,
        max_fee: None,
    };
    let inflated = deterministic::transfer(&low, "rw3-f7-inflated").unwrap().pending().unwrap();
    assert_eq!(inflated.expiry_height, s + 1_000_064);
    assert!(matches!(w.clone().mark_pending(inflated), Err(WalletError::Request(_))), "mark_pending measures the bound from the confirmed height");
    // the builder does not take a height from the caller or from the scan at all
    let t1 = pay_note(&mut w, &alice, 10 * Q, &bob.address(), 4 * Q, "rw3-f7-t1");
    let record = t1.pending().unwrap();
    println!("true height {s}; scanned height {}; the built transaction's expiry_height is {}", w.scanned_height().unwrap(), record.expiry_height);
    assert_eq!(record.expiry_height, s + DEFAULT_EXPIRY_OFFSET, "the expiry is the confirmed height + 64");
    assert_eq!(Body::decode(&t1.body).unwrap().expiry_height, record.expiry_height, "and it is what the body says: the node refuses the transaction above it");

    // the wallet, from here on with honest nodes only: rescan, 300 blocks, a pool change, 300 more
    let mut honest = w.fresh_for_rescan();
    chain.advance_to(s + 300);
    fund(&mut chain, &alice.address(), &[Q]);
    chain.advance_to(chain.height + 300);
    honest.scan(&chain.page(0), &alice.scan_key()).unwrap();
    assert!(honest.is_locked(position_of(&honest, 10 * Q)), "the rescan keeps the lock until the data is confirmed");
    confirm(&chain, &mut honest);
    let r = honest.resolve();
    let b = honest.balances();
    println!(
        "after an honest rescan and an honest quorum at height {} ({} blocks after the build): settled {}, still pending {}, locked {} quanta",
        honest.confirmed_height().unwrap(),
        honest.confirmed_height().unwrap() - s,
        r.expired.len() + r.mined.len() + r.superseded.len(),
        r.still_pending,
        b.locked
    );
    assert_eq!((r.expired.len(), r.still_pending, b.locked, b.spendable), (1, 0, 0, 17 * Q as u128), "a lock ends in bounded time when honest nodes are reachable (G3, G4)");
}

/// What a spend is built on, case by case: no confirmed height — nothing; a tree root above the
/// confirmed height — only on the caller's explicit `allow_unverified`, and then the expiry is
/// STILL measured from the confirmed height; an expiry at most 128 blocks above it; the state at
/// the expected revision; the caller's state untouched.
#[test]
fn rw3_f7b_a_spend_is_built_on_the_confirmed_checkpoint_and_nothing_else() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = base(&alice.address(), &[10 * Q, 6 * Q]);
    let mut w = synced(&chain, &alice);
    let build = |w: &WalletState, inputs: &[u64], expiry: Option<u64>, allow_unverified: bool, label: &str| {
        let spend = SpendOptions { chain_id: CHAIN, inputs, expiry_height: expiry, allow_unverified, max_fee: None };
        deterministic::transfer_locked(w, w.revision(), &alice, &TransferParams { spend, recipient: &bob.address(), amount: 4 * Q, fee: Q }, label)
    };
    let ten = position_of(&w, 10 * Q);
    // scanned, never confirmed: not even with allow_unverified
    for allow in [false, true] {
        assert!(matches!(build(&w, &[ten], None, allow, "x").map(|_| ()), Err(WalletError::StateUnconfirmed)), "no confirmed height: nothing to measure an expiry from");
    }
    assert!(matches!(w.clone().mark_pending(pay_record(&w, &alice, &bob, ten)), Err(WalletError::StateUnconfirmed)));
    confirm(&chain, &mut w);
    let c = chain.height;
    assert_eq!(w.spend_base(false).unwrap(), (chain.state().tree_root, c));
    // the expiry: above the confirmed height, at most 128 above it, default + 64
    for (expiry, ok) in [(Some(c), false), (Some(c + 1), true), (None, true), (Some(c + 128), true), (Some(c + 129), false), (Some(u64::MAX), false)] {
        let r = build(&w, &[ten], expiry, false, "expiry");
        assert_eq!(r.is_ok(), ok, "expiry {expiry:?}");
        if let Ok((tx, next)) = r {
            assert_eq!(tx.expiry_height, expiry.unwrap_or(c + 64));
            assert!(next.pending()[0].expiry_height <= c + 128 && next.is_locked(ten) && !w.is_locked(ten));
        }
    }
    // the revision
    let spend = SpendOptions { chain_id: CHAIN, inputs: &[ten], expiry_height: None, allow_unverified: false, max_fee: None };
    let params = TransferParams { spend, recipient: &bob.address(), amount: 4 * Q, fee: Q };
    assert!(matches!(deterministic::transfer_locked(&w, w.revision() + 1, &alice, &params, "stale").map(|_| ()), Err(WalletError::StaleState)));
    assert!(matches!(deterministic::transfer_locked(&w, w.revision(), &bob, &params, "other").map(|_| ()), Err(WalletError::Request(_))), "another wallet's keys");
    // one node lists a payment above the confirmed height: the wallet's root is that node's word
    fund(&mut chain, &alice.address(), &[2 * Q]);
    w.scan(&chain.page(w.next_height()), &alice.scan_key()).unwrap();
    assert!(matches!(w.spend_base(false), Err(WalletError::StateUnconfirmed)));
    assert!(matches!(build(&w, &[ten], None, false, "above").map(|_| ()), Err(WalletError::StateUnconfirmed)), "an anchor above the confirmed height is refused");
    let (tx, next) = build(&w, &[ten], None, true, "explicit").expect("the caller's explicit decision");
    assert_eq!((tx.expiry_height, next.pending()[0].expiry_height), (c + 64, c + 64), "and even then the expiry is measured from the CONFIRMED height");
    assert!(build(&w, &[ten], Some(chain.height + 128), true, "x").is_err(), "c + 129");
    // an unconfirmed note needs the same flag
    let two = position_of(&w, 2 * Q);
    assert!(matches!(build(&w, &[two], None, false, "x").map(|_| ()), Err(WalletError::StateUnconfirmed)));
    confirm(&chain, &mut w);
    assert!(build(&w, &[two], None, false, "x").is_err(), "2 XRGE do not cover 4 + 1");
    assert!(build(&w, &[two, ten], None, false, "pair").is_ok());
}

/// The low-level record of a payment from `pos` (for the `mark_pending` checks).
fn pay_record(w: &WalletState, alice: &ShieldedKeys, bob: &ShieldedKeys, pos: u64) -> PendingTx {
    let req = TransferRequest {
        ctx: TxContext::new(CHAIN, w.anchor(), w.scanned_height().unwrap()),
        keys: alice,
        inputs: &[w.spend_input_with(pos, true).unwrap()],
        recipient: &bob.address(),
        amount: 4 * Q,
        fee: Q,
        max_fee: None,
    };
    deterministic::transfer(&req, "rw3-record").unwrap().pending().unwrap()
}

/// **G3 as a bound.** With an honest majority of the configured nodes, every pending transaction
/// is settled — mined, superseded or expired — by the time the confirmed height reaches its
/// `expiry_height`, and `expiry_height ≤ (the confirmed height at the build) + 128`, WHATEVER the
/// lying minority served before the build, as the listing, or as its reports.
///
/// Four fates of the transaction (withheld for ever; mined at once; mined at its very last valid
/// height; superseded by a second device) × four behaviours of the minority node (honest
/// listing; a lying page that inflates the tip before the build; a listing that shows the
/// transaction mined when it is not / not mined when it is; a listing with a forged payment), and
/// in every case the liar's report contradicts the honest ones. The client follows the documented
/// rule: on `listing_refuted`, rescan against another node.
#[test]
fn rw3_f7c_every_pending_transaction_settles_by_the_time_the_confirmed_height_reaches_its_expiry() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut seen = std::collections::BTreeMap::new();
    for fate in ["withheld", "mined at once", "mined at the expiry", "superseded"] {
        for lie in ["honest listing", "inflated tip before the build", "false fate in the listing", "forged payment in the listing"] {
            let mut chain = base(&alice.address(), &[10 * Q, 6 * Q]);
            let mut w = synced(&chain, &alice);
            confirm(&chain, &mut w);
            let built_at = chain.height;
            if lie == "inflated tip before the build" {
                let page = serde_json::json!({ "active": true, "tip_height": built_at + 5_000, "from_height": built_at + 1, "next_height": built_at + 5_001, "txs": [] });
                w.scan(&parse(&page), &alice.scan_key()).unwrap();
            }
            // device B, the same phrase, in sync with the chain and unaware of A
            let mut device_b = synced(&chain, &alice);
            confirm(&chain, &mut device_b);
            let ten = position_of(&w, 10 * Q);
            let t1 = pay(&mut w, &alice, &[ten], &bob.address(), 4 * Q, &format!("rw3-f7c-{fate}-{lie}"));
            let record = t1.pending().unwrap();
            let expiry = record.expiry_height;
            assert!(expiry <= built_at + MAX_EXPIRY_OFFSET, "{fate} / {lie}: the expiry is bounded by the confirmed height at the build");

            // the true chain
            let mut mined = false;
            match fate {
                "mined at once" => {
                    chain.block(&[&t1.body]).unwrap();
                    mined = true;
                }
                "mined at the expiry" => {
                    chain.advance_to(expiry - 1);
                    chain.block(&[&t1.body]).unwrap();
                    assert_eq!(chain.height, expiry);
                    mined = true;
                }
                "superseded" => {
                    let t2 = pay(&mut device_b, &alice, &[ten], &bob.address(), 2 * Q, &format!("rw3-f7c-b-{lie}"));
                    chain.block(&[&t2.body]).unwrap();
                    assert!(chain.block(&[&t1.body]).is_err(), "the pool refuses the second spend of the note");
                }
                _ => {}
            }
            chain.advance_to(expiry);
            assert_eq!(chain.height, expiry, "the last block that can hold t1 exists");

            // what the minority node serves as the listing
            let mut liar_page = chain.page_value(0, chain.height);
            match lie {
                "false fate in the listing" => {
                    let txs = liar_page["txs"].as_array_mut().unwrap();
                    if mined || fate == "superseded" {
                        txs.retain(|t| t["nf1"] != hex::encode(record.nullifiers[0].0) && t["nf2"] != hex::encode(record.nullifiers[0].0));
                        // (leaf positions of what follows are then wrong, or the tx was the last)
                    } else {
                        txs.push(listing_entry(&t1.body, chain.height, 0, chain.state().note_count));
                    }
                }
                "forged payment in the listing" => {
                    let forged = deterministic::shield(
                        &ShieldRequest { ctx: chain.ctx(), from_pub_key: &fake_account_key(6), nonce: 1, v_in: 51 * Q, fee: Q, recipient: &alice.address(), max_fee: None },
                        "rw3-f7c-forged",
                    )
                    .unwrap();
                    liar_page["txs"].as_array_mut().unwrap().push(listing_entry(&forged.body, chain.height, 0, chain.state().note_count));
                }
                _ => {}
            }
            // the client: its listing node is the liar (node 3); the reports are two honest and the liar's
            let mut client = w.fresh_for_rescan();
            let lying_listing = lie != "honest listing" && lie != "inflated tip before the build";
            let scanned = client.scan(&parse(&liar_page), &alice.scan_key());
            let reports = |c: &WalletState| vec![chain.report(N1), chain.report(N2), if lying_listing { echo(c, N3) } else { lying_report(&chain, N3) }];
            let mut rescans = 0;
            let confirmed = match scanned {
                Ok(_) => client.confirm_state(&reports(&client)).unwrap(),
                Err(_) => ConfirmReport { listing_refuted: true, ..Default::default() }, // a `listing:` error: the same recovery
            };
            if confirmed.matched_height != Some(expiry) {
                assert!(confirmed.listing_refuted, "{fate} / {lie}: the client is told that its listing is wrong: {confirmed:?}");
                assert!(client.pending().iter().all(|p| client.notes().iter().filter(|n| p.input_cms.contains(&n.cm)).all(|n| client.is_locked(n.position))), "still locked");
                // the documented recovery: rescan against another node (an honest one)
                client = client.fresh_for_rescan();
                client.scan(&chain.page(0), &alice.scan_key()).unwrap();
                let c = client.confirm_state(&reports(&client)).unwrap();
                assert_eq!(c.matched_height, Some(expiry), "{fate} / {lie}: {c:?}");
                rescans = 1;
            }
            assert_eq!(lying_listing, rescans == 1, "{fate} / {lie}: a lying listing costs one rescan — delay — and nothing else (G4)");
            // THE BOUND: the confirmed height has reached the expiry ⇒ nothing is pending
            assert_eq!(client.confirmed_height(), Some(expiry));
            let r = client.resolve();
            assert_eq!(r.still_pending, 0, "{fate} / {lie}: settled once the confirmed height reaches the expiry");
            let outcome = (r.mined.len(), r.superseded.len(), r.expired.len());
            let expected = match fate {
                "mined at once" | "mined at the expiry" => (1, 0, 0),
                "superseded" => (0, 1, 0),
                _ => (0, 0, 1),
            };
            assert_eq!(outcome, expected, "{fate} / {lie}: and the settlement is the truth");
            assert_eq!(client.balances().locked, 0);
            assert_eq!(client.balances().confirmed, true_balance(&chain, &alice), "{fate} / {lie}: the confirmed balance is the true balance at the confirmed height");
            *seen.entry(outcome).or_insert(0) += 1;
        }
    }
    assert_eq!(seen.values().sum::<i32>(), 16);
}

/// A lie that comparing states cannot catch by itself, found by the independent model of
/// `tests/settlement_properties.rs`: the listing node appends a "block" ABOVE every honest tip in
/// which one of the wallet's notes is spent (here: the wallet's own withheld transaction, listed
/// as mined 400 blocks in the future). No honest node reports that height, so nothing contradicts
/// it; everything up to the real tip still matches — and the note would be out of every balance
/// until the chain got there. The state check therefore says where the quorum IS (`quorum_tip`)
/// and that the listing runs ahead of it (`listing_ahead`): ask again, and if it stays, rescan
/// against another node.
#[test]
fn rw3_f7d_a_listing_that_runs_ahead_of_the_quorum_is_reported() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = base(&alice.address(), &[10 * Q, 6 * Q]);
    let mut w = synced(&chain, &alice);
    confirm(&chain, &mut w);
    let s = chain.height;
    let t1 = pay_note(&mut w, &alice, 10 * Q, &bob.address(), 4 * Q, "rw3-f7d-t1"); // withheld
    let mut page = chain.page_value(w.next_height(), chain.height);
    page["txs"].as_array_mut().unwrap().push(listing_entry(&t1.body, s + 400, 0, chain.state().note_count));
    page["tip_height"] = serde_json::json!(s + 400);
    page["next_height"] = serde_json::json!(s + 401);
    let mut lied_to = w.clone();
    assert_eq!(lied_to.scan(&parse(&page), &alice.scan_key()).unwrap().pending_seen_mined, 1);
    // two honest nodes at the real tip, the liar vouching for its invention
    let c = lied_to.confirm_state(&[chain.report(N1), chain.report(N2), echo(&lied_to, N3)]).unwrap();
    assert_eq!((c.matched_height, c.quorum_tip, c.listing_refuted, c.dissenting.len()), (Some(s), Some(s), false, 0), "nothing contradicts a block nobody has");
    assert!(c.listing_ahead, "but the listing shows a transaction 400 blocks above the height a quorum has reached");
    let b = lied_to.balances();
    assert_eq!((b.confirmed, b.locked, lied_to.resolve().still_pending), (6 * Q as u128, 0, 1), "the 10 XRGE note looks spent; nothing settles on it");
    // the recovery: another node's listing
    let mut honest = lied_to.fresh_for_rescan();
    honest.scan(&chain.page(0), &alice.scan_key()).unwrap();
    let c = honest.confirm_state(&[chain.report(N1), chain.report(N2), lying_report(&chain, N3)]).unwrap();
    assert_eq!((c.matched_height, c.quorum_tip, c.listing_ahead, honest.balances().confirmed, honest.balances().locked), (Some(s), Some(s), false, 16 * Q as u128, 10 * Q as u128));
    // an HONEST listing node that is one block ahead of the others looks the same for a moment …
    fund(&mut chain, &alice.address(), &[2 * Q]);
    let behind = [chain_report_at(&w, N1, s), chain_report_at(&w, N2, s)];
    w.scan(&chain.page(w.next_height()), &alice.scan_key()).unwrap();
    let c = w.confirm_state(&behind).unwrap();
    assert_eq!((c.matched_height, c.quorum_tip, c.listing_ahead), (Some(s), Some(s), true));
    // … and not any more once they have the block
    let c = w.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    assert_eq!((c.matched_height, c.quorum_tip, c.listing_ahead), (Some(s + 1), Some(s + 1), false));
    // the quorum's tip is the quorum-th highest claim: a lying minority cannot raise it
    let far = StateReport { height: s + 1_000_000, ..echo(&w, N3) };
    let c = w.confirm_state(&[chain.report(N1), far.clone()]).unwrap();
    assert_eq!((c.quorum_tip, c.listing_ahead), (Some(s + 1), false));
    assert_eq!(w.confirm_state(&[far]).unwrap().quorum_tip, None, "one node is no quorum");
}

/// What an honest node reported for `height` when the wallet's state there was the chain's.
fn chain_report_at(w: &WalletState, id: &str, height: u64) -> StateReport {
    let v = w.state_at(height).unwrap();
    StateReport { node_id: node(id), height, tree_root: v.tree_root, nullifier_acc: v.nullifier_acc, note_count: v.note_count, nullifier_count: v.nullifier_count, ciphertext_acc: v.ciphertext_acc }
}

// ---------------------------------------------------------------------------------------------------
// RW3-5 (Medium) — build and lock were two calls.
// ---------------------------------------------------------------------------------------------------

/// Building and locking are one operation: the transaction comes back WITH the state in which its
/// inputs are locked and its pending entry recorded. There is nothing to forget and no order to
/// get wrong; the caller's own state is not changed (so that a failed persist loses nothing).
/// A client that loses the returned state never submitted, and builds again. `abandon_unsubmitted`
/// is for the client that is sure it never submitted — and releases nothing: only a confirmed
/// expiry does.
#[test]
fn rw3_f5_building_locks_the_inputs_in_the_same_operation_and_abandoning_releases_nothing() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = base(&alice.address(), &[10 * Q, 6 * Q]);
    let mut stored = synced(&chain, &alice); // what the client has in its storage
    confirm(&chain, &mut stored);
    let ten = position_of(&stored, 10 * Q);
    let spend = SpendOptions { chain_id: CHAIN, inputs: &[ten], expiry_height: None, allow_unverified: false, max_fee: None };
    let params = TransferParams { spend, recipient: &bob.address(), amount: 4 * Q, fee: Q };
    let (t1, locked) = deterministic::transfer_locked(&stored, stored.revision(), &alice, &params, "rw3-f5-t1").unwrap();
    let record = t1.pending().unwrap();
    // the returned state has everything: the lock, the nullifiers, the outputs, the change with r, the expiry
    assert_eq!(locked.revision(), stored.revision() + 1);
    let p = &locked.pending()[0];
    assert_eq!((&p.nullifiers, &p.outputs, &p.change, p.expiry_height, p.inputs.as_slice()), (&record.nullifiers, &record.outputs, &record.change, record.expiry_height, &[ten][..]));
    assert_eq!(p.input_cms, vec![stored.note_at(ten).unwrap().cm]);
    assert!(locked.is_locked(ten) && matches!(locked.spend_input(ten), Err(WalletError::NoteLocked)));
    assert_eq!((locked.balances().locked, locked.balances().spendable, locked.balances().expected_change), (10 * Q as u128, 6 * Q as u128, 5 * Q as u128));
    // from the locked state the same note cannot be built on again; another note can
    assert!(matches!(deterministic::transfer_locked(&locked, locked.revision(), &alice, &params, "again").map(|_| ()), Err(WalletError::NoteLocked)));
    assert!(matches!(select_inputs(&locked, 6 * Q, Q), Err(WalletError::InsufficientFunds { .. })));
    // a crash before the returned state was persisted: the client still has `stored`, the
    // transaction never left, and the same call again is a fresh, equally safe start
    assert!(stored.pending().is_empty() && !stored.is_locked(ten));
    assert!(deterministic::transfer_locked(&stored, stored.revision(), &alice, &params, "rw3-f5-after-crash").is_ok());
    // a second writer that still holds the OLD revision is refused once the locked state is stored
    assert!(matches!(deterministic::transfer_locked(&locked, stored.revision(), &alice, &params, "stale").map(|_| ()), Err(WalletError::StaleState)));

    // the client persisted `locked` and then the user cancelled before the submit
    let mut w = locked;
    assert!(!w.abandon_unsubmitted(&canon(99)), "an unknown nullifier");
    assert!(w.abandon_unsubmitted(&record.nullifiers[1].0));
    assert!(w.pending()[0].abandoned_hint && w.is_locked(ten), "a hint: the lock stays");
    assert_eq!(w.resolve().still_pending, 1);
    assert!(matches!(select_inputs(&w, 6 * Q, Q), Err(WalletError::InsufficientFunds { .. })), "the note is not offered again");
    // … which is what makes a WRONG claim harmless: suppose the transaction did go out
    let mut released = base(&alice.address(), &[10 * Q, 6 * Q]);
    released.block(&[&t1.body]).unwrap();
    let mut wrong_claim = w.clone();
    wrong_claim.scan(&released.page(wrong_claim.next_height()), &alice.scan_key()).unwrap();
    confirm(&released, &mut wrong_claim);
    let r = wrong_claim.resolve();
    assert_eq!((r.mined.len(), r.mined[0].abandoned_hint, wrong_claim.balances().confirmed), (1, true, 11 * Q as u128), "it settles as mined: nothing was paid twice");
    // the honest claim: released when the confirmed height reaches the expiry, not a block earlier
    chain.advance_to(record.expiry_height - 1);
    w.scan(&chain.page(w.next_height()), &alice.scan_key()).unwrap();
    confirm(&chain, &mut w);
    assert_eq!(w.resolve().still_pending, 1);
    chain.advance_to(record.expiry_height);
    w.scan(&chain.page(w.next_height()), &alice.scan_key()).unwrap();
    confirm(&chain, &mut w);
    let r = w.resolve();
    assert_eq!((r.expired.len(), r.expired[0].abandoned_hint, w.balances().spendable), (1, true, 16 * Q as u128));
    // a payment to the wallet's own address records the payment output too (a self-merge)
    let own = alice.address();
    let (a, b) = (position_of(&w, 10 * Q), position_of(&w, 6 * Q));
    let spend = SpendOptions { chain_id: CHAIN, inputs: &[a, b], expiry_height: None, allow_unverified: false, max_fee: None };
    let (merge, merged) = deterministic::transfer_locked(&w, w.revision(), &alice, &TransferParams { spend, recipient: &own, amount: 15 * Q, fee: Q }, "rw3-f5-merge").unwrap();
    let p = &merged.pending()[0];
    assert_eq!((p.own_payment.as_ref().map(|c| c.value), p.change.as_ref().map(|c| c.value)), (Some(15 * Q), Some(0)));
    assert_eq!(merged.balances().expected_change, 15 * Q as u128);
    chain.block(&[&merge.body]).unwrap();
    let mut m = merged;
    let report = m.scan(&chain.page(m.next_height()), &alice.scan_key()).unwrap();
    assert_eq!((report.received.len(), report.own_outputs_from_record, m.balance()), (1, 1, 15 * Q as u128));
}

// ---------------------------------------------------------------------------------------------------
// State format 4: the migration from format 3
// ---------------------------------------------------------------------------------------------------

/// A state in format 3 (188d0ed) is migrated to format 4: an empty state to rescan that keeps
/// every pending entry as pending and LOCKED, the minimum note value and the revision — and is
/// configured with no node. Format 3 did not record the ciphertext hash, which cannot be computed
/// afterwards, so nothing of it can be confirmed under the current rules; the rescan finds every
/// note again. Its change record has no `r`: the change is found through its ciphertext, which
/// the confirmed ciphertext hash now covers.
#[test]
fn rw3_a_format_3_state_is_migrated_with_every_pending_entry_locked() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = base(&alice.address(), &[3 * Q, 4 * Q]);
    let mut now = WalletState::with_min_note_value(alice.address().pk, Q / 4).unwrap();
    now.scan(&chain.page(0), &alice.scan_key()).unwrap();
    confirm(&chain, &mut now);
    let (pos3, pos4) = (position_of(&now, 3 * Q), position_of(&now, 4 * Q));
    let ta = pay(&mut now, &alice, &[pos3], &bob.address(), Q, "rw3-v3-a");
    let tb = pay(&mut now, &alice, &[pos4], &bob.address(), Q, "rw3-v3-b");
    // the same state as format 3 wrote it: no nodes, no cap, no ciphertext hash, no `r`
    let mut v3: serde_json::Value = serde_json::from_str(&now.to_json().unwrap()).unwrap();
    v3["version"] = serde_json::json!(3);
    for k in ["nodes", "max_unspent_notes", "ciphertext_acc"] {
        v3.as_object_mut().unwrap().remove(k);
    }
    for c in v3["checkpoints"].as_array_mut().unwrap() {
        c.as_object_mut().unwrap().remove("ciphertext_acc");
    }
    for p in v3["pending"].as_array_mut().unwrap() {
        p.as_object_mut().unwrap().remove("own_payment");
        p.as_object_mut().unwrap().remove("abandoned_hint");
        p["change"].as_object_mut().unwrap().remove("r");
        p["status"] = serde_json::json!("seen_mined"); // what format 3 had seen: one node's word
        p["seen_height"] = serde_json::json!(now.scanned_height());
    }
    let mut m = WalletState::from_json(&v3.to_string()).unwrap();
    assert_eq!((m.next_height(), m.notes().len(), m.confirmed_height(), m.pending().len()), (0, 0, None, 2));
    assert_eq!((m.min_note_value(), m.revision(), m.nodes().len(), m.max_unspent_notes()), (Q / 4, now.revision() + 1, 0, MAX_STORED_NOTES));
    assert!(m.pending().iter().all(|p| p.status == PendingStatus::Pending && p.seen_height.is_none() && !p.legacy && p.outputs.len() == 2 && p.change.as_ref().is_some_and(|c| c.r.is_none())));
    assert_eq!(m.pending()[0].input_cms, vec![now.note_at(pos3).unwrap().cm]);
    assert!(m.to_json().unwrap().contains("\"version\":4"));
    assert!(WalletState::from_json(&v3.to_string().replace("\"version\":3", "\"version\":5")).is_err());

    // the truth: ta was mined, tb never
    chain.block(&[&ta.body]).unwrap();
    m.scan(&chain.page(0), &alice.scan_key()).unwrap();
    assert!(m.is_locked(pos4) && m.note_at(pos3).unwrap().spent);
    assert!(m.confirm_state(&chain.state_reports()).unwrap().matched_height.is_none(), "a migrated state is configured with no node");
    confirm(&chain, &mut m);
    let r = m.resolve();
    assert_eq!((r.mined.len(), r.still_pending), (1, 1));
    chain.advance_to(tb.pending().unwrap().expiry_height);
    m.scan(&chain.page(m.next_height()), &alice.scan_key()).unwrap();
    confirm(&chain, &mut m);
    assert_eq!(m.resolve().expired.len(), 1);
    assert_eq!((m.balance(), m.balances().spendable), (5 * Q as u128, 5 * Q as u128), "4 + the change of 1, found through its ciphertext");
}

// ---------------------------------------------------------------------------------------------------
// Tried, and sound
// ---------------------------------------------------------------------------------------------------

/// The listing node may give a transaction any height between two confirmed heights: heights are
/// not in the root. It cannot use that to move a mined transaction across the confirmed height,
/// in either direction. `t1` (expiry 67 here) is mined at height 44; the liar lists it at 90.
/// * honest reports for height 70 (≥ the expiry): the wallet's state at 70 lacks `t1`, the
///   nodes' has it → no match, nothing confirmed, `t1` is NOT called expired;
/// * honest reports for height 100: match; `t1` settles as mined although listed above its expiry.
#[test]
fn rw3_sound_shifting_a_mined_transaction_to_another_height_cannot_make_it_expired() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = base(&alice.address(), &[10 * Q]);
    let mut w = synced(&chain, &alice);
    confirm(&chain, &mut w);
    let t1 = pay_note(&mut w, &alice, 10 * Q, &bob.address(), 4 * Q, "rw3-shift-t1");
    let record = t1.pending().unwrap();
    chain.advance_to(43);
    chain.block(&[&t1.body]).unwrap();
    assert!(chain.height <= record.expiry_height);
    chain.advance_to(70);
    assert!(70 >= record.expiry_height);
    let at_70 = [chain.report(N1), chain.report(N2)];
    chain.advance_to(100);
    let mut page = chain.page_value(w.next_height(), chain.height);
    page["txs"][0]["height"] = serde_json::json!(90);
    let report = w.scan(&parse(&page), &alice.scan_key()).unwrap();
    assert_eq!(report.pending_seen_mined, 1);

    let mut early = w.clone();
    let c = early.confirm_state(&at_70).unwrap();
    assert!(c.diverged && c.matched_height.is_none() && c.listing_refuted);
    let r = early.resolve();
    assert_eq!((r.expired.len(), r.mined.len(), r.still_pending), (0, 0, 1), "not expired: the nodes' state at 70 is not the wallet's");

    let c = w.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    assert_eq!(c.matched_height, Some(100));
    let r = w.resolve();
    assert_eq!((r.mined.len(), r.expired.len()), (1, 0));
    assert_eq!(w.balances().confirmed, 5 * Q as u128);
}

/// Root and nullifier hash repeat over idle heights, and a report is `(height, state)`. A liar
/// that inflates the scanned height with an empty page and then echoes the wallet's (idle) state
/// for that height cannot move the confirmed height past what honest nodes reported: stale
/// honest reports confirm their own height and nothing above; one liar at the inflated height is
/// one node. The pending transaction, whose expiry lies inside the invented range, stays locked.
#[test]
fn rw3_sound_idle_heights_and_stale_reports_do_not_raise_the_confirmed_height() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let chain = base(&alice.address(), &[10 * Q]);
    let mut w = synced(&chain, &alice);
    confirm(&chain, &mut w);
    let s = chain.height;
    let _t1 = pay_note(&mut w, &alice, 10 * Q, &bob.address(), 4 * Q, "rw3-idle-t1");
    // "the chain is 500 blocks further and nothing happened"
    let page = serde_json::json!({ "active": true, "tip_height": s + 500, "from_height": s + 1, "next_height": s + 501, "txs": [] });
    w.scan(&parse(&page), &alice.scan_key()).unwrap();
    assert_eq!(w.scanned_height(), Some(s + 500));
    let stale = [chain.report(N1), chain.report(N2)];
    for reports in [
        vec![stale[0].clone(), stale[1].clone(), echo(&w, N3)],
        vec![echo(&w, N3), echo(&w, N3)],
        vec![stale[0].clone(), echo(&w, N3)],
        // an honest node's old state re-labelled with the new height by the liar, twice
        vec![StateReport { height: s + 500, node_id: node(N3), ..stale[0].clone() }, StateReport { height: s + 300, node_id: node(N3), ..stale[0].clone() }],
    ] {
        let c = w.confirm_state(&reports).unwrap();
        assert!(c.confirmed_height == Some(s) && !c.diverged, "{c:?}");
        let r = w.resolve();
        assert_eq!((r.expired.len(), r.still_pending), (0, 1));
        assert!(w.is_locked(position_of(&w, 10 * Q)));
    }
}

/// RW3-10 (Info) — outside what any wallet core can do, stated so that the UI is designed for it:
/// a device restored from the phrase knows nothing of a transaction another device (or the same
/// device before it lost its state) has pending. **Locks are per device.** Its notes are
/// unlocked. If the user pays again from ANOTHER note while the first transaction is withheld,
/// both are mined. What the user interface must do is in spec §5.5 and `NOTES.md`.
#[test]
fn rw3_demo_a_restored_device_has_no_locks_and_a_second_payment_from_another_note_pays_twice() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = base(&alice.address(), &[10 * Q, 6 * Q]);
    let mut a = synced(&chain, &alice);
    confirm(&chain, &mut a);
    let t1 = pay_note(&mut a, &alice, 10 * Q, &bob.address(), 4 * Q, "rw3-restore-t1"); // device A holds the lock; the node withholds t1
    // device B: restored from the phrase
    let mut b = synced(&chain, &alice);
    confirm(&chain, &mut b);
    assert!(b.pending().is_empty() && b.balances().spendable == 16 * Q as u128, "LIMIT: no lock on the restored device");
    let t2 = pay_note(&mut b, &alice, 6 * Q, &bob.address(), 4 * Q, "rw3-restore-t2");
    chain.block(&[&t2.body]).unwrap();
    chain.block(&[&t1.body]).unwrap(); // released inside its validity
    let mut bobs = WalletState::new(bob.address().pk);
    bobs.scan(&chain.page(0), &bob.scan_key()).unwrap();
    assert_eq!(bobs.balance(), 8 * Q as u128, "LIMIT: Bob is paid twice; a restored wallet must not offer payments for 128 confirmed blocks, or warn");
    // had B chosen the SAME note, one of the two would have been superseded: safe
}
