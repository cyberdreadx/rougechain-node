//! REVIEW_WALLET_3 — third independent review, of the settlement REDESIGN made after
//! REVIEW_WALLET_2 (see `REVIEW_WALLET_3.md`). Reviewed: `fix/shield-v2-wallet-settlement` @188d0ed.
//! Nothing was fixed.
//!
//! * `rw3_fN_…` — **regression tests of confirmed defects. They FAIL on the reviewed commit, on
//!   purpose**, and are to pass once the defect is fixed. Each prints what it found before the
//!   assertion that fails.
//! * `rw3_demo_…` — a limit that is real and that the core cannot remove by itself (it passes;
//!   the assertions state the limit so that nobody builds on the other reading).
//! * `rw3_sound_…` — an attack that was tried and does not work.
//!
//! Needs the `test-vectors` feature (proof-less deterministic assembly), like the earlier reviews.
#![cfg(feature = "test-vectors")]

mod common;

use common::*;
use quantum_vault_shield_v2::reference::{derive_rho, digest_from_bytes, digest_to_bytes, nullifier, Note, MODULUS};
use quantum_vault_shield_v2_wallet::note_enc::encrypt_note_with_kem_randomness;
use quantum_vault_shield_v2_wallet::store::{ListedOutput, ListedTx, MAX_STORED_NOTES};
use quantum_vault_shield_v2_wallet::tx::{deterministic, UnprovenTx};
use quantum_vault_shield_v2_wallet::*;
use sha2::{Digest as _, Sha256};

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

fn synced(chain: &Chain, keys: &ShieldedKeys) -> WalletState {
    let mut s = WalletState::new(keys.address().pk);
    s.scan(&chain.page(s.next_height()), &keys.scan_key()).unwrap();
    assert_eq!(s.anchor(), chain.state().tree_root);
    s
}

/// A transfer built from the wallet's own state as the wasm surface does it (default expiry, +64).
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
    StateReport { node_id: id.into(), height: h, tree_root: v.tree_root, nullifier_acc: v.nullifier_acc, note_count: v.note_count, nullifier_count: v.nullifier_count }
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

fn position_of(s: &WalletState, value: u64) -> u64 {
    s.unspent().find(|n| n.value == value).expect("a note of that value").position
}

/// What the address really holds on `chain`: every note, whatever its size.
fn true_balance(chain: &Chain, keys: &ShieldedKeys) -> u128 {
    let mut reference = WalletState::with_min_note_value(keys.address().pk, 1).unwrap();
    reference.scan(&chain.page(0), &keys.scan_key()).unwrap();
    reference.balance()
}

// ---------------------------------------------------------------------------------------------------
// RW3-1 (High, G4) — one lying node of three stops every confirmation, for as long as it likes.
// ---------------------------------------------------------------------------------------------------

/// Three configured nodes; two are honest and report exactly the wallet's state; the third
/// reports another nullifier hash for the same height. Guarantee G4: a single lying node causes
/// delay only. What happens: `confirm_state` returns `diverged` in every call, the confirmed
/// height never moves, no note becomes spendable, and a pending transaction whose expiry is long
/// past is never settled — its input stays locked for ever. The report names the HEIGHT of the
/// conflict and no node, so the caller is not told whom to leave out.
///
/// The rule that does this ("any conflict confirms nothing") adds no safety inside the stated
/// trust model: a match by a strict majority of the configured nodes contains an honest node, and
/// an honest node's report is the truth for its height. Mutation M4 of the report removes the
/// rule and every test of the crate still passes.
#[test]
fn rw3_f1_one_lying_node_of_three_freezes_confirmation_and_every_lock() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = base(&alice.address(), &[10 * Q]);
    let mut w = synced(&chain, &alice);
    let lie = |c: &Chain| {
        let mut r = c.report("https://node-3.example");
        r.nullifier_acc = canon(7);
        r
    };
    let three = |c: &Chain| vec![c.report("https://node-1.example"), c.report("https://node-2.example"), lie(c)];

    // the wallet confirms once without the liar (so that it can pay at all), then pays; the node
    // it submits to keeps the transaction
    w.confirm_state(&three(&chain)[..2], None).unwrap();
    let t1 = transfer(&w, &alice, &[position_of(&w, 10 * Q)], &bob.address(), 4 * Q, "rw3-f1-t1");
    let record = t1.pending().unwrap();
    w.mark_pending(record.clone()).unwrap();
    let confirmed_before = w.confirmed_height();

    let (rounds, mut matched, mut diverged) = (6usize, 0usize, 0usize);
    for _ in 0..rounds {
        chain.advance_to(chain.height + 40); // far past the expiry (64 blocks) by the third round
        fund(&mut chain, &alice.address(), &[Q]);
        w.scan(&chain.page(w.next_height()), &alice.scan_key()).unwrap();
        let c = w.confirm_state(&three(&chain), None).unwrap();
        matched += c.matched_height.is_some() as usize;
        diverged += c.diverged as usize;
        assert_eq!((c.nodes, c.quorum, c.agreeing), (3, 2, 2), "two of three report exactly the wallet's state: a quorum");
    }
    let r = w.resolve();
    let b = w.balances();
    println!(
        "three nodes, one liar, {rounds} state checks over {} blocks: matched {matched}, diverged {diverged}; confirmed height {:?} (was {confirmed_before:?}); \
         t1 expired at height {} and the chain is at {}: resolve settled {} and left {} pending; locked {} quanta, unverified {} quanta",
        chain.height - confirmed_before.unwrap(),
        w.confirmed_height(),
        record.expiry_height,
        chain.height,
        r.expired.len() + r.mined.len() + r.superseded.len(),
        r.still_pending,
        b.locked,
        b.unverified
    );
    // the way out exists only for a caller that guesses which node to leave out
    let mut without = w.clone();
    assert!(without.confirm_state(&three(&chain)[..2], None).unwrap().matched_height.is_some(), "the same two honest reports alone do confirm");

    assert_eq!(matched, rounds, "two honest nodes of three agree with the wallet in every call: one liar must not stop the confirmation (G4)");
    assert_eq!(r.expired.len(), 1, "t1 is long expired on the chain two honest nodes report: its input must be released");
}

/// The way out `NOTES.md` §6 item 4 names — "drop a node" — is not safe as the API stands.
/// `confirm_state` raises the quorum to a majority **of the reports it is given**, not of the
/// nodes the client is configured with. Five configured nodes, two of them one liar's; the
/// wallet's listing is the liar's and contains a payment that is on no chain. All five reports:
/// `diverged`. A client that then leaves out the nodes that "conflict" — it cannot tell the three
/// honest ones from liars, the report names no node — and calls again with the two that agree
/// gets the forged 50 XRGE confirmed and spendable. Passing the majority of the CONFIGURED set as
/// `quorum` (3) in every call is what prevents it; nothing in the core or the notes says so.
#[test]
fn rw3_demo_dropping_nodes_until_nothing_conflicts_confirms_a_forgery_with_two_liars_of_five() {
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
    w.scan(&parse(&page), &alice.scan_key()).unwrap();
    assert_eq!(w.balances().unverified, 60 * Q as u128);

    let honest: Vec<StateReport> = ["h1", "h2", "h3"].iter().map(|id| chain.report(id)).collect();
    let liars = vec![echo(&w, "liar-1"), echo(&w, "liar-2")];
    let all: Vec<StateReport> = honest.iter().chain(&liars).cloned().collect();
    let c = w.clone().confirm_state(&all, None).unwrap();
    assert!(c.diverged && c.matched_height.is_none() && (c.nodes, c.quorum) == (5, 3));

    // "drop the nodes that conflict" with the default quorum: the two liars are a "majority of the nodes asked"
    let mut dropped = w.clone();
    let c = dropped.confirm_state(&liars, None).unwrap();
    assert_eq!((c.matched_height, c.quorum, c.diverged), (Some(chain.height), 2, false));
    assert_eq!(dropped.balances().spendable, 60 * Q as u128, "LIMIT: the forged 50 XRGE are confirmed and spendable (the chain holds 10)");

    // the same call with the quorum pinned to the majority of the five CONFIGURED nodes confirms nothing
    let mut pinned = w.clone();
    let c = pinned.confirm_state(&liars, Some(3)).unwrap();
    assert_eq!((c.matched_height, pinned.balances().confirmed), (None, 0));
}

/// Quorum arithmetic for one to five nodes (default quorum), and what a node id is: a byte string.
/// The same endpoint written three ways is three nodes.
#[test]
fn rw3_demo_quorum_arithmetic_and_node_ids_are_compared_byte_for_byte() {
    let alice = keys(PHRASE_1);
    let chain = base(&alice.address(), &[10 * Q]);
    let w = synced(&chain, &alice);
    // all n nodes agree: the quorum applied, and whether it confirms
    let mut seen = Vec::new();
    for n in 1..=5usize {
        let reports: Vec<StateReport> = (0..n).map(|i| chain.report(&format!("n{i}"))).collect();
        let c = w.clone().confirm_state(&reports, None).unwrap();
        seen.push((n, c.quorum, c.matched_height.is_some()));
    }
    assert_eq!(seen, [(1, 2, false), (2, 2, true), (3, 2, true), (4, 3, true), (5, 3, true)]);
    // the same id twice is one node
    let c = w.clone().confirm_state(&[chain.report("n0"), chain.report("n0")], None).unwrap();
    assert_eq!((c.nodes, c.matched_height), (1, None));
    // LIMIT: one endpoint in three spellings is three nodes and confirms alone
    let ids = ["https://node.example", "https://node.example/", "HTTPS://NODE.EXAMPLE"];
    let c = w.clone().confirm_state(&ids.map(|id| chain.report(id)), None).unwrap();
    assert_eq!((c.nodes, c.agreeing, c.matched_height.is_some()), (3, 3, true), "LIMIT: the core does not normalise node ids; the client must");
}

// ---------------------------------------------------------------------------------------------------
// RW3-2 (Medium, G3/G4) — ciphertexts are in neither half of the confirmed state.
// ---------------------------------------------------------------------------------------------------

/// `t1` (Alice pays Bob 4 of her 10 XRGE note; 5 XRGE change) is really mined. The node the wallet
/// lists from serves the real block with the two ciphertexts of the CHANGE output zeroed. Root,
/// nullifier hash and both counts are the chain's; two honest nodes confirm; `resolve` settles
/// `t1` as `mined` — and the 5 XRGE of change are in no balance, in no tally, and nothing says so.
/// The settlement table promises "its change is a confirmed note". The wallet holds the change
/// commitment in the pending record and has just watched that commitment enter the confirmed
/// tree without a note for it: it has the proof that its listing was altered, and ignores it.
#[test]
fn rw3_f2_a_blanked_change_ciphertext_settles_as_mined_and_the_change_is_silently_gone() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = base(&alice.address(), &[10 * Q]);
    let mut w = synced(&chain, &alice);
    confirm(&chain, &mut w);
    let t1 = transfer(&w, &alice, &[position_of(&w, 10 * Q)], &bob.address(), 4 * Q, "rw3-f2-t1");
    let record = t1.pending().unwrap();
    let change = record.change.clone().unwrap();
    assert_eq!(change.value, 5 * Q);
    w.mark_pending(record.clone()).unwrap();
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
    assert_eq!((report.pending_seen_mined, report.received.len(), report.not_stored), (1, 0, 0));
    confirm(&chain, &mut w); // two honest nodes: the wallet's root AND nullifier hash are the chain's
    let r = w.resolve();
    assert_eq!((r.mined.len(), r.still_pending), (1, 0));
    let b = w.balances();
    println!(
        "t1 settled as mined on confirmed data; the chain holds {} quanta for the wallet, the wallet shows confirmed {} / unverified {} / expected change {}; \
         below_minimum {:?}, over_capacity {:?}; a note with the change commitment is stored: {}",
        true_balance(&chain, &alice),
        b.confirmed,
        b.unverified,
        b.expected_change,
        w.below_minimum(),
        w.over_capacity(),
        w.notes().iter().any(|n| n.cm == change.cm)
    );
    assert_eq!(b.confirmed, 5 * Q as u128, "a transaction settled as mined returns its change: the wallet knows the commitment and saw it confirmed");
}

/// The general case, which the core cannot detect: an incoming payment whose two ciphertexts the
/// listing node swapped. Everything the quorum vouches for matches; the wallet is "confirmed" at
/// the tip and 7 XRGE short, with nothing to tell it or its user. Only a second listing shows it.
#[test]
fn rw3_demo_swapped_ciphertexts_hide_an_incoming_payment_from_a_fully_confirmed_wallet() {
    let alice = keys(PHRASE_1);
    let mut chain = base(&alice.address(), &[10 * Q]);
    let mut w = synced(&chain, &alice);
    fund(&mut chain, &alice.address(), &[7 * Q]);
    let mut page = chain.page_value(w.next_height(), chain.height);
    let outs = page["txs"][0]["outputs"].as_array_mut().unwrap();
    let (a, b) = (outs[0].clone(), outs[1].clone());
    for k in ["kem_ct", "note_ct"] {
        outs[0][k] = b[k].clone();
        outs[1][k] = a[k].clone();
    }
    w.scan(&parse(&page), &alice.scan_key()).unwrap();
    confirm(&chain, &mut w);
    assert_eq!(w.confirmed_height(), Some(chain.height));
    assert_eq!((w.balances().confirmed, true_balance(&chain, &alice)), (10 * Q as u128, 17 * Q as u128), "LIMIT: confirmed at the tip, 7 XRGE invisible");
    // an honest listing finds it
    assert_eq!(synced(&chain, &alice).balance(), 17 * Q as u128);
}

// ---------------------------------------------------------------------------------------------------
// RW3-3 (Low, G3) — the wallet drops its own change when it is below the minimum note value.
// ---------------------------------------------------------------------------------------------------

/// No adversary. Alice pays 8.5 XRGE from a 10 XRGE note with the minimum fee: 0.5 XRGE of
/// change. The transaction is mined and settles as `mined`; the change is "counted, not stored"
/// like a stranger's dust: it is in no balance and cannot be spent from this state. The dust rule
/// exists against hostile senders; this note is the wallet's own, announced in its pending record
/// (`expected_change` shows it until the moment it is mined).
#[test]
fn rw3_f3_own_change_below_the_minimum_note_value_leaves_the_wallets_view() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = base(&alice.address(), &[10 * Q, 3 * Q]);
    let mut w = synced(&chain, &alice);
    confirm(&chain, &mut w);
    let sel = select_inputs(&w, 8 * Q + Q / 2, Q).unwrap();
    assert_eq!(sel.change, Q / 2, "coin selection plans it without a word (only the wasm `plan_payment` adds a flag)");
    let t1 = transfer(&w, &alice, &sel.positions, &bob.address(), 8 * Q + Q / 2, "rw3-f3-t1");
    w.mark_pending(t1.pending().unwrap()).unwrap();
    assert_eq!(w.balances().expected_change, (Q / 2) as u128);
    chain.block(&[&t1.body]).unwrap();
    w.scan(&chain.page(w.next_height()), &alice.scan_key()).unwrap();
    confirm(&chain, &mut w);
    assert_eq!(w.resolve().mined.len(), 1);
    let b = w.balances();
    // what it takes to get it back: a rescan from the activation height with min_note_value = 1
    let mut again = w.fresh_for_rescan_with_min_note_value(1).unwrap();
    again.scan(&chain.page(0), &alice.scan_key()).unwrap();
    println!(
        "the chain holds {} quanta for the wallet; after `mined` the wallet shows confirmed {} + unverified {}, expected change {}, below_minimum {:?}; \
         a rescan with min_note_value = 1 shows {}",
        true_balance(&chain, &alice),
        b.confirmed,
        b.unverified,
        b.expected_change,
        w.below_minimum(),
        again.balance()
    );
    assert_eq!(again.balance(), true_balance(&chain, &alice));
    assert_eq!(b.confirmed, true_balance(&chain, &alice), "the wallet's own change is the wallet's money whatever its size");
}

// ---------------------------------------------------------------------------------------------------
// RW3-4 (Medium, G3) — a restore counts SPENT notes towards the 65,536-note capacity.
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
/// `rescan_state` is the same code path). The scan stores spent notes too and drops them only in
/// `confirm_state`, which can first be called at the tip. So the capacity is used up by notes
/// that are gone, and every note after the 65,536th is "counted, not stored": here the two that
/// are the wallet's whole balance (101 XRGE). They are in no balance and cannot be spent; a
/// further rescan repeats it; "merge notes … then rescan" (`over_capacity` doc) cannot help — the
/// spent notes are what fills the state. Raising `min_note_value` helps only when the old notes
/// were smaller than the new ones.
///
/// As an attack: 32,768 transactions with two 1-XRGE outputs each to the victim — 32,768 XRGE in
/// fees plus 65,536 XRGE that the victim receives and can spend — after which every restore of
/// that wallet is blind to all later notes of 1 XRGE or more unless the user raises the minimum.
#[test]
fn rw3_f4_a_restore_counts_spent_notes_towards_the_capacity_and_drops_the_live_ones() {
    let alice = keys(PHRASE_1);
    let address = alice.address();
    let key = alice.scan_key();
    let nk = key.nk.expect("the full scan key");
    let pairs = (MAX_STORED_NOTES / 2) as u64; // transactions that fill the capacity
    let mut w = WalletState::new(address.pk);
    let mut nf = [canon(1), canon(2)];
    let (mut height, per_page) = (A, 2_048u64);
    let mut i = 0u64;
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
        w.scan(&page, &key).unwrap();
    }
    let unspent = w.unspent().count();
    let stored = w.notes().len();
    // the wallet's own node confirms the tip (quorum 1): now the spent notes are pruned — too late
    let c = w.confirm_state(&[echo(&w, "own-node")], Some(1)).unwrap();
    println!(
        "restore over {} transactions: {} notes stored during the scan ({} unspent), over_capacity {:?}; after the state check {} notes pruned, {} stored; \
         balance {} quanta, on the chain 101000000000",
        pairs + 1,
        stored,
        unspent,
        w.over_capacity(),
        c.pruned,
        w.notes().len(),
        w.balance()
    );
    assert_eq!(w.balance(), 101 * Q as u128, "the two unspent notes are the wallet's balance: a restore must find them");
}

// ---------------------------------------------------------------------------------------------------
// RW3-7 (High, G3/G4) — the expiry bound, the only thing that ends a lock, hangs on one node's word.
// ---------------------------------------------------------------------------------------------------

/// "`expiry_height` is the only bound on how long a signer-less transaction stays valid, which is
/// why the builders and `mark_pending` enforce this distance" (`tx.rs`). The distance is measured
/// from the SCANNED height, and the scanned height is whatever the listing node says its tip is.
///
/// The node the wallet lists from answers one empty page: "my tip is a million blocks further,
/// nothing happened". `scan` accepts it (a page is compared with the node's own `tip_height`
/// only). The wallet's notes stay confirmed, its root is still the chain's root. The next payment
/// is built with `anchor_height` = the scanned height and the default expiry, `mark_pending`
/// accepts it (it is within 128 blocks of the scanned height), and the node keeps it.
///
/// * The transaction is valid on the real chain far beyond the 128 blocks the design promises
///   (shown: mined 200 blocks later on a copy of the chain).
/// * On the wallet's side nothing can end the lock: not an honest rescan (the entry is carried
///   over with its expiry), not an honest quorum confirming hundreds of blocks — the confirmed
///   height would have to pass a height the chain reaches in a million blocks. The input is
///   locked for good, by one lying page, with every honest node reachable. Even after the
///   transaction has become unminable for another reason (its anchor left the window) the wallet
///   keeps the lock: expiry is the only rule it has.
///
/// The remedy is the redesign's own principle: measure the bound from the CONFIRMED height (in
/// `mark_pending`, and refuse to build on a scanned height that is not confirmed).
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
    assert_eq!((w.confirmed_height(), w.balances().spendable), (Some(s), 16 * Q as u128), "nothing looks wrong: confirmed notes, the chain's root");
    let t1 = transfer(&w, &alice, &[position_of(&w, 10 * Q)], &bob.address(), 4 * Q, "rw3-f7-t1");
    let record = t1.pending().unwrap();
    let accepted = w.mark_pending(record.clone());
    println!("true height {s}; the built transaction's expiry_height is {}; mark_pending accepted it: {}", record.expiry_height, accepted.is_ok());

    // (a) how long the transaction really lives: on a copy of the chain it is mined 200 blocks later
    let mut copy = base(&alice.address(), &[10 * Q, 6 * Q]);
    copy.advance_to(s + 200);
    let mined_late = copy.block(&[&t1.body]).is_ok();

    // (b) the wallet, from here on with honest nodes only: rescan, 300 blocks, a pool change, 300 more
    let mut honest = w.fresh_for_rescan();
    chain.advance_to(s + 300);
    fund(&mut chain, &alice.address(), &[Q]);
    chain.advance_to(chain.height + 300);
    honest.scan(&chain.page(0), &alice.scan_key()).unwrap();
    confirm(&chain, &mut honest);
    let r = honest.resolve();
    let still_minable = chain.block(&[&t1.body]).is_ok(); // its anchor left the window 128 blocks after the pool changed
    let b = honest.balances();
    println!(
        "(a) t1 mined {} blocks after it was built on a copy of the chain: {mined_late}; (b) after an honest rescan and an honest quorum at height {} ({} blocks after the build):          settled {}, still pending {}, locked {} quanta; t1 can still be mined on that chain: {still_minable}; blocks until the wallet's rule releases it: {}",
        200,
        honest.confirmed_height().unwrap(),
        honest.confirmed_height().unwrap() - s,
        r.expired.len() + r.mined.len() + r.superseded.len(),
        r.still_pending,
        b.locked,
        record.expiry_height - honest.confirmed_height().unwrap()
    );
    assert!(mined_late, "the transaction outlives the 128 blocks the builders are supposed to enforce");
    assert!(!still_minable);
    assert!(
        accepted.is_err() || b.locked == 0,
        "a lock must end in bounded time when honest nodes are reachable: the expiry bound may not rest on a height one node claimed (G3, G4)"
    );
}

// ---------------------------------------------------------------------------------------------------
// Tried, and sound
// ---------------------------------------------------------------------------------------------------

/// The listing node may give a transaction any height between two confirmed heights: heights are
/// not in the root. It cannot use that to move a mined transaction across the confirmed height,
/// in either direction. `t1` (expiry 67 here) is mined at height 44; the liar lists it at 90.
/// * honest reports for height 70 (≥ the expiry): the wallet's state at 70 lacks `t1`, the
///   nodes' has it → conflict, nothing confirmed, `t1` is NOT called expired;
/// * honest reports for height 100: match; `t1` settles as mined although listed above its expiry.
#[test]
fn rw3_sound_shifting_a_mined_transaction_to_another_height_cannot_make_it_expired() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = base(&alice.address(), &[10 * Q]);
    let mut w = synced(&chain, &alice);
    confirm(&chain, &mut w);
    let t1 = transfer(&w, &alice, &[position_of(&w, 10 * Q)], &bob.address(), 4 * Q, "rw3-shift-t1");
    let record = t1.pending().unwrap();
    w.mark_pending(record.clone()).unwrap();
    chain.advance_to(43);
    chain.block(&[&t1.body]).unwrap();
    assert!(chain.height <= record.expiry_height);
    chain.advance_to(70);
    assert!(70 >= record.expiry_height);
    let at_70 = [chain.report("h1"), chain.report("h2")];
    chain.advance_to(100);
    let mut page = chain.page_value(w.next_height(), chain.height);
    page["txs"][0]["height"] = serde_json::json!(90);
    let report = w.scan(&parse(&page), &alice.scan_key()).unwrap();
    assert_eq!(report.pending_seen_mined, 1);

    let mut early = w.clone();
    let c = early.confirm_state(&at_70, None).unwrap();
    assert!(c.diverged && c.matched_height.is_none());
    let r = early.resolve();
    assert_eq!((r.expired.len(), r.mined.len(), r.still_pending), (0, 0, 1), "not expired: the nodes' state at 70 is not the wallet's");

    let c = w.confirm_state(&[chain.report("h1"), chain.report("h2")], None).unwrap();
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
    let t1 = transfer(&w, &alice, &[position_of(&w, 10 * Q)], &bob.address(), 4 * Q, "rw3-idle-t1");
    let record = t1.pending().unwrap();
    w.mark_pending(record.clone()).unwrap();
    // "the chain is 500 blocks further and nothing happened"
    let page = serde_json::json!({ "active": true, "tip_height": s + 500, "from_height": s + 1, "next_height": s + 501, "txs": [] });
    w.scan(&parse(&page), &alice.scan_key()).unwrap();
    assert_eq!(w.scanned_height(), Some(s + 500));
    let stale = [chain.report("h1"), chain.report("h2")];
    for reports in [
        vec![stale[0].clone(), stale[1].clone(), echo(&w, "liar")],
        vec![echo(&w, "liar"), echo(&w, "liar")],
        vec![stale[0].clone(), echo(&w, "liar")],
        // an honest node's old state re-labelled with the new height by the liar, twice
        vec![StateReport { height: s + 500, node_id: "liar".into(), ..stale[0].clone() }, StateReport { height: s + 300, node_id: "liar".into(), ..stale[0].clone() }],
    ] {
        let c = w.confirm_state(&reports, None).unwrap();
        assert!(c.confirmed_height == Some(s) && !c.diverged, "{c:?}");
        let r = w.resolve();
        assert_eq!((r.expired.len(), r.still_pending), (0, 1));
        assert!(w.is_locked(position_of(&w, 10 * Q)));
    }
}

/// Outside what any wallet core can do, stated so that the UI is designed for it: a device
/// restored from the phrase knows nothing of a transaction another device (or the same device
/// before it lost its state) has pending. Its notes are unlocked. If the user pays again from
/// ANOTHER note while the first transaction is withheld, both are mined.
#[test]
fn rw3_demo_a_restored_device_has_no_locks_and_a_second_payment_from_another_note_pays_twice() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = base(&alice.address(), &[10 * Q, 6 * Q]);
    let mut a = synced(&chain, &alice);
    confirm(&chain, &mut a);
    let t1 = transfer(&a, &alice, &[position_of(&a, 10 * Q)], &bob.address(), 4 * Q, "rw3-restore-t1");
    a.mark_pending(t1.pending().unwrap()).unwrap(); // device A holds the lock; the node withholds t1
    // device B: restored from the phrase
    let mut b = synced(&chain, &alice);
    confirm(&chain, &mut b);
    assert!(b.pending().is_empty() && b.balances().spendable == 16 * Q as u128, "LIMIT: no lock on the restored device");
    let t2 = transfer(&b, &alice, &[position_of(&b, 6 * Q)], &bob.address(), 4 * Q, "rw3-restore-t2");
    b.mark_pending(t2.pending().unwrap()).unwrap();
    chain.block(&[&t2.body]).unwrap();
    chain.block(&[&t1.body]).unwrap(); // released inside its validity
    let mut bobs = WalletState::new(bob.address().pk);
    bobs.scan(&chain.page(0), &bob.scan_key()).unwrap();
    assert_eq!(bobs.balance(), 8 * Q as u128, "LIMIT: Bob is paid twice; a restored wallet must not offer payments for 128 confirmed blocks, or warn");
}
