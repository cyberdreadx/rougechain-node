//! The Resolution of REVIEW_WALLET_4 (`REVIEW_WALLET_4.md`, "Resolution"): what the fixes
//! guarantee, beyond turning the review's six failing tests green.
//!
//! * RW4-5 — no call returns a state that does not read back (a fuzz over rescans with forged
//!   entries, shifted leaves, blanked ciphertexts and pages cut anywhere); a stored state that
//!   does not validate gives up its locks to `recover_locks`; format 4 states that RW4-5 had made
//!   unreadable are read again;
//! * RW4-1 — the embargo of a state without lock history, WITHOUT the user's statement: the base
//!   and its arithmetic, case by case;
//! * RW4-3, RW4-4, RW4-10, RW4-11, RW4-8 — the view-only mark, the mixed address, the revision
//!   identity, the wallet's own shield, `spend_status`.
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
        let tx = deterministic::shield(&req, &format!("rw4r-fund-{}-{i}", chain.height)).unwrap();
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

fn pay_with(state: &mut WalletState, keys: &ShieldedKeys, positions: &[u64], to: &ShieldedAddress, amount: u64, expiry_height: Option<u64>, label: &str) -> Result<UnprovenTx, WalletError> {
    let spend = SpendOptions { chain_id: CHAIN, inputs: positions, expiry_height, allow_unverified: false, max_fee: None };
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

struct Rng(u64);
impl Rng {
    fn below(&mut self, n: u64) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0 % n
    }
}

fn reads_back(s: &WalletState, what: &str) -> WalletState {
    let json = s.to_json().unwrap_or_else(|e| panic!("{what}: to_json refused a state a call returned: {e}"));
    let back = WalletState::from_json(&json).unwrap_or_else(|e| panic!("{what}: a state a call returned does not read back: {e}"));
    assert!(back == *s, "{what}: the state reads back as itself");
    back
}

// ---------------------------------------------------------------------------------------------------
// RW4-5
// ---------------------------------------------------------------------------------------------------

/// **The fuzz the task asks for.** A wallet with one-input and two-input payments pending rescans,
/// again and again, against listings that are lied about in every way that moves or hides a
/// note: 0 to 6 forged transactions in front (every real leaf 0 to 12 further — the distances at
/// which one input lands on the position the other had), ciphertexts blanked, pages cut after
/// any block, a real transaction dropped from the end, and the next page taken from an honest
/// node (whose numbering then disagrees). After EVERY call: the state reads back; every pending
/// entry is held by exactly the commitments and nullifiers it was built with; whatever notes of
/// an entry the state holds are locked. And from every such state an honest rescan and a state
/// check bring the wallet to the truth with every lock in place.
#[test]
fn rw4r_f5_fuzz_rescans_with_forged_entries_and_random_page_cuts_never_leave_a_state_that_does_not_read_back() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut rng = Rng(0x5eed_f00d_cafe_0001);
    let (mut cases, mut cut_between, mut same_position, mut mismatches, mut refused) = (0, 0, 0, 0, 0);
    for round in 0..40u64 {
        let mut chain = Chain::new();
        let values: Vec<u64> = (0..6 + rng.below(4)).map(|i| (3 + i) * Q).collect();
        fund(&mut chain, &alice.address(), &values);
        let mut w = WalletState::new(alice.address().pk);
        configure(&mut w, &[N1, N2, N3]);
        w.scan(&chain.page(0), &alice.scan_key()).unwrap();
        w.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
        // two or three payments pending, most of them with two inputs
        let mut held: Vec<PendingTx> = Vec::new();
        for k in 0..2 + rng.below(2) {
            let free: Vec<(u64, u64)> = w.unspent().filter(|n| !w.is_locked(n.position)).map(|n| (n.position, n.value)).collect();
            if free.len() < 2 {
                break;
            }
            let a = free[rng.below(free.len() as u64) as usize];
            let b = free[rng.below(free.len() as u64) as usize];
            let (positions, total) = if a.0 == b.0 || rng.below(4) == 0 { (vec![a.0], a.1) } else { (vec![a.0, b.0], a.1 + b.1) };
            pay_with(&mut w, &alice, &positions, &bob.address(), total - 2 * Q, None, &format!("rw4r-fuzz-{round}-{k}")).unwrap();
            held.push(w.pending().last().unwrap().clone());
        }
        reads_back(&w, "the state with its locks");
        let check = |s: &WalletState, what: &str| {
            reads_back(s, what);
            assert_eq!(s.pending().len(), held.len(), "{what}: an entry was lost");
            for (p, q) in s.pending().iter().zip(&held) {
                assert!((&p.nullifiers, &p.outputs, &p.input_cms, p.expiry_height, &p.change) == (&q.nullifiers, &q.outputs, &q.input_cms, q.expiry_height, &q.change), "{what}: an entry is not held by what it was built with");
                for n in s.unspent().filter(|n| p.input_cms.contains(&n.cm)) {
                    assert!(s.is_locked(n.position), "{what}: a note of a pending entry is not locked");
                }
            }
            // … and no other note is: a lock is held by a commitment, not by the position a note
            // of the entry had on another listing
            for n in s.unspent().filter(|n| s.is_locked(n.position)) {
                assert!(s.pending().iter().any(|p| p.input_cms.contains(&n.cm)), "{what}: the note at leaf {} is locked and no pending entry spends it", n.position);
            }
        };
        for attempt in 0..12u64 {
            cases += 1;
            let what = format!("round {round}, rescan {attempt}");
            let mut s = w.fresh_for_rescan();
            check(&s, &what);
            // the lying listing
            let forged = rng.below(7);
            let shift = 2 * forged;
            let last = A + rng.below(chain.height - A + 1);
            let mut page = chain.page_value(0, last);
            let mut txs = Vec::new();
            for i in 0..forged {
                txs.push(listing_entry(&shield_body(&chain, &bob.address(), Q, &format!("rw4r-forged-{round}-{attempt}-{i}")), A, i, 2 * i));
            }
            for real in page["txs"].as_array().unwrap() {
                let mut real = real.clone();
                if real["height"].as_u64() == Some(A) {
                    real["index"] = serde_json::json!(real["index"].as_u64().unwrap() + forged);
                }
                for j in 0..2 {
                    real["outputs"][j]["leaf"] = serde_json::json!(real["outputs"][j]["leaf"].as_u64().unwrap() + shift);
                    if rng.below(9) == 0 {
                        real["outputs"][j]["kem_ct"] = serde_json::json!("00".repeat(1088));
                        real["outputs"][j]["note_ct"] = serde_json::json!("00".repeat(56));
                    }
                }
                txs.push(real);
            }
            if rng.below(6) == 0 {
                txs.pop();
            }
            page["txs"] = serde_json::json!(txs);
            match s.scan(&parse(&page), &alice.scan_key()) {
                Ok(_) => {}
                Err(WalletError::Listing(_)) => {
                    refused += 1;
                    check(&s, &what);
                    continue;
                }
                Err(e) => panic!("{what}: {e}"),
            }
            check(&s, &what);
            // did the cut fall between the two notes of an entry, and did a note land on the
            // position the entry showed for its other input? (the collision of RW4-5)
            for (p, q) in s.pending().iter().zip(&held) {
                let found = p.input_cms.iter().filter(|c| s.notes().iter().any(|n| n.cm == **c)).count();
                cut_between += (p.input_cms.len() == 2 && found == 1) as usize;
                same_position += (p.inputs.len() == 2 && p.inputs[0] == p.inputs[1]) as usize;
                assert!(q.inputs.len() == p.inputs.len());
            }
            // the client goes on: more pages from an HONEST node (numbered differently), a state
            // check, resolve — every one of them a call on the state the lying page left
            for _ in 0..2 {
                if s.next_height() > chain.height {
                    break;
                }
                let upto = s.next_height() + rng.below(chain.height - s.next_height() + 1);
                match s.scan(&parse(&chain.page_value(s.next_height(), upto)), &alice.scan_key()) {
                    Ok(r) => mismatches += r.leaf_mismatch as usize,
                    Err(WalletError::Listing(_)) => refused += 1,
                    Err(e) => panic!("{what}: an honest page after a lying one: {e}"),
                }
                check(&s, &what);
            }
            let c = s.confirm_state(&[chain.report(N1), chain.report(N2), chain.report(N3)]).unwrap();
            check(&s, &what);
            assert!(forged == 0 || c.matched_height.is_none_or(|h| h < A), "{what}: a listing with forged entries was confirmed");
            s.resolve();
            check(&s, &what);
            // … and the documented recovery works from wherever that left the wallet
            let mut honest = s.fresh_for_rescan();
            honest.scan(&chain.page(0), &alice.scan_key()).unwrap();
            assert_eq!(honest.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap().matched_height, Some(chain.height));
            check(&honest, &what);
            for (p, q) in honest.pending().iter().zip(&held) {
                assert_eq!(p.inputs, q.inputs, "{what}: on the true listing every entry shows the positions it was built at");
                assert!(p.inputs.iter().all(|&x| honest.is_locked(x)));
            }
            assert_eq!(honest.resolve().still_pending, held.len());
        }
    }
    println!("{cases} rescans on lying listings: {cut_between} entries with one of two inputs found, {same_position} entries showing one position twice, {mismatches} honest pages numbered below the wallet's tree, {refused} pages refused — every state read back");
    assert!(cut_between > 20 && same_position > 5 && mismatches > 50, "the fuzz reached the cases RW4-5 is about");
}

/// A state stored by format 4 in which an entry names one position twice — the state RW4-5 made
/// unreadable for good — is read again by format 5 (the positions are no longer what an entry is
/// held by), with its lock and everything else in place.
#[test]
fn rw4r_f5_a_format_4_state_that_rw4_5_had_poisoned_is_read_again_with_its_locks() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[3 * Q, 4 * Q, 5 * Q]);
    let mut w = WalletState::new(alice.address().pk);
    configure(&mut w, &[N1, N2, N3]);
    w.scan(&chain.page(0), &alice.scan_key()).unwrap();
    w.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    let (p3, p4) = (position_of(&w, 3 * Q), position_of(&w, 4 * Q));
    pay_with(&mut w, &alice, &[p3, p4], &bob.address(), 5 * Q, None, "rw4r-v4").unwrap();
    let mut v4: serde_json::Value = serde_json::from_str(&w.to_json().unwrap()).unwrap();
    v4["version"] = serde_json::json!(4);
    for k in ["revision_id", "spend_embargo", "sole_copy_asserted", "view_only_since", "own_shields"] {
        v4.as_object_mut().unwrap().remove(k);
    }
    v4["pending"][0]["inputs"] = serde_json::json!([p4, p4]); // what RW4-5 left behind
    let back = WalletState::from_json(&v4.to_string()).expect("format 5 reads the poisoned format-4 state");
    assert_eq!((back.pending().len(), back.pending()[0].inputs.clone(), back.notes().len(), back.confirmed_height()), (1, vec![p3, p4], 3, w.confirmed_height()));
    assert!(back.is_locked(p3) && back.is_locked(p4) && !back.is_locked(position_of(&back, 5 * Q)));
    assert_eq!((back.spend_embargo(), back.nodes().len(), back.balances()), (SpendEmbargo::NotRequired, 3, w.balances()), "a device's own state: no embargo, nothing rescanned");
    reads_back(&back, "the migrated state");
}

/// `recover_locks`: a stored state that `from_json` refuses — here in five different ways — is
/// not answered with a new state. Every pending entry is read out of it (nullifiers, input
/// commitments, outputs, the change with its `r`, the expiry) into an empty state; the rescan
/// finds the notes, the locks hold, the settlement works. An entry that cannot be read at all
/// puts the recovered state under the restore embargo.
#[test]
fn rw4r_f5_recover_locks_reads_every_lock_out_of_a_state_that_does_not_validate() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[3 * Q, 4 * Q, 5 * Q, 6 * Q]);
    let mut w = WalletState::new(alice.address().pk);
    configure(&mut w, &[N1, N2, N3]);
    w.scan(&chain.page(0), &alice.scan_key()).unwrap();
    w.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    let (p3, p4, p5) = (position_of(&w, 3 * Q), position_of(&w, 4 * Q), position_of(&w, 5 * Q));
    let t1 = pay_with(&mut w, &alice, &[p3, p4], &bob.address(), 5 * Q, None, "rw4r-rec-1").unwrap();
    pay_with(&mut w, &alice, &[p5], &bob.address(), 2 * Q, None, "rw4r-rec-2").unwrap();
    let good: serde_json::Value = serde_json::from_str(&w.to_json().unwrap()).unwrap();
    let held = w.pending().to_vec();
    let damage: [(&str, fn(&mut serde_json::Value)); 5] = [
        ("the state history is gone", |v| v["checkpoints"] = serde_json::json!([])),
        ("the tree is truncated", |v| {
            v["tree"]["frontier"].as_array_mut().unwrap().pop();
        }),
        ("a note is at a position the tree does not have", |v| v["notes"][0][3] = serde_json::json!(1_000_000)),
        ("an entry carries a status no state can have", |v| v["pending"][0]["seen_height"] = serde_json::json!(999_999)),
        ("the notes are not notes at all", |v| v["notes"] = serde_json::json!("garbage")),
    ];
    for (what, break_it) in damage {
        let mut v = good.clone();
        break_it(&mut v);
        let text = v.to_string();
        assert!(WalletState::from_json(&text).is_err(), "{what}: from_json refuses it");
        let r = WalletState::recover_locks(&text).unwrap_or_else(|e| panic!("{what}: {e}"));
        assert_eq!((r.entries_kept, r.entries_unreadable, r.expiry_unknown, r.nodes_kept), (2, 0, false, true), "{what}");
        let mut s = r.state;
        assert!(s.notes().is_empty() && s.confirmed_height().is_none() && s.revision() > w.revision(), "{what}: an empty state to rescan into, the revision continues");
        for (p, q) in s.pending().iter().zip(&held) {
            assert!((&p.nullifiers, &p.outputs, &p.input_cms, p.expiry_height, &p.change, p.legacy) == (&q.nullifiers, &q.outputs, &q.input_cms, q.expiry_height, &q.change, false), "{what}: every entry is what it was");
        }
        // every lock was read: the embargo is the old state's (here: lifted by the user's
        // statement on a base that the rescan has to earn again)
        assert!(!r.embargo || s.spend_embargo() == SpendEmbargo::AwaitingBase, "{what}");
        reads_back(&s, what);
        s.scan(&chain.page(0), &alice.scan_key()).unwrap();
        s.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
        assert!(s.is_locked(p3) && s.is_locked(p4) && s.is_locked(p5) && !s.is_locked(position_of(&s, 6 * Q)), "{what}: the locks hold on the rescanned notes");
        assert_eq!(s.balances().spendable, 6 * Q as u128, "{what}");
        let spend = SpendOptions { chain_id: CHAIN, inputs: &[p3], expiry_height: None, allow_unverified: false, max_fee: None };
        let again = deterministic::transfer_locked(&s, s.revision(), &alice, &TransferParams { spend, recipient: &bob.address(), amount: Q, fee: Q }, "rw4r-rec-again");
        assert!(matches!(again.err(), Some(WalletError::NoteLocked) | Some(WalletError::RestoredRecently { .. })), "{what}: a locked note is not handed out");
        // t1 is mined: it settles as mined, from the recovered record, change and all
        let mut mined = Chain::new();
        fund(&mut mined, &alice.address(), &[3 * Q, 4 * Q, 5 * Q, 6 * Q]);
        mined.block(&[&t1.body]).unwrap();
        let mut s2 = WalletState::recover_locks(&text).unwrap().state;
        s2.scan(&mined.page(0), &alice.scan_key()).unwrap();
        s2.confirm_state(&[mined.report(N1), mined.report(N2)]).unwrap();
        let settled = s2.resolve();
        assert_eq!((settled.mined.len(), settled.still_pending), (1, 1), "{what}");
        assert_eq!(s2.balances().confirmed, (5 + 6 + 1) * Q as u128, "{what}: 5, 6 and t1's change (3 + 4 − 5 − 1 = 1)");
    }
    // an entry that names nothing a lock can be held by: it is counted, and the state is
    // embargoed like a restored one (a transaction of this device may be out without a lock)
    let mut v = good.clone();
    v["pending"][1] = serde_json::json!({ "tx_type": "shielded_transfer_v2", "nullifiers": ["zz"], "input_cms": 7 });
    v["checkpoints"] = serde_json::json!([]);
    let r = WalletState::recover_locks(&v.to_string()).unwrap();
    assert_eq!((r.entries_kept, r.entries_unreadable, r.embargo, r.state.spend_embargo(), r.state.sole_copy_asserted()), (1, 1, true, SpendEmbargo::AwaitingBase, false));
    // an entry with its expiry unreadable is kept, never released by height, and embargoes too
    let mut v = good.clone();
    v["pending"][0].as_object_mut().unwrap().remove("expiry_height");
    v["checkpoints"] = serde_json::json!([]);
    let r = WalletState::recover_locks(&v.to_string()).unwrap();
    assert_eq!((r.entries_kept, r.entries_unreadable, r.expiry_unknown, r.embargo), (2, 0, true, true));
    assert!(r.state.pending()[0].expiry_height > chain.height + 100);
    // a valid state is read too; text that is no state of any wallet is refused
    assert_eq!(WalletState::recover_locks(&good.to_string()).unwrap().entries_kept, 2);
    for junk in ["", "[]", "{}", "{\"pk\":\"00\"}", "not json"] {
        assert!(matches!(WalletState::recover_locks(junk), Err(WalletError::State(_))), "{junk:?}");
    }
}

/// Leaf numbers are the listing node's claim. A page that starts ABOVE the wallet's tree skipped
/// transactions and is refused; one that starts BELOW it (the wallet's earlier listing held more)
/// is applied and reported, and the state it leaves is a valid one that no quorum confirms.
#[test]
fn rw4r_f5_a_page_numbered_below_the_wallets_tree_is_reported_and_one_above_it_is_refused() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[3 * Q, 4 * Q, 5 * Q]);
    let mut w = WalletState::new(alice.address().pk);
    configure(&mut w, &[N1, N2, N3]);
    // the first page from a liar: one forged transaction in front, cut after the first block
    let mut page = chain.page_value(0, A);
    let mut real = page["txs"][0].clone();
    real["index"] = serde_json::json!(1);
    for j in 0..2 {
        real["outputs"][j]["leaf"] = serde_json::json!(real["outputs"][j]["leaf"].as_u64().unwrap() + 2);
    }
    page["txs"] = serde_json::json!([listing_entry(&shield_body(&chain, &bob.address(), Q, "rw4r-leaf-forged"), A, 0, 0), real]);
    assert!(!w.scan(&parse(&page), &alice.scan_key()).unwrap().leaf_mismatch);
    // the next page from an honest node: numbered two below the wallet's tree
    let r = w.clone().scan(&chain.page(w.next_height()), &alice.scan_key()).unwrap();
    assert!(r.leaf_mismatch, "the client is told: rescan");
    let mut mixed = w.clone();
    mixed.scan(&chain.page(mixed.next_height()), &alice.scan_key()).unwrap();
    reads_back(&mixed, "a state built on two listings that disagree");
    let c = mixed.confirm_state(&[chain.report(N1), chain.report(N2), chain.report(N3)]).unwrap();
    assert!(c.matched_height.is_none() && c.listing_refuted && mixed.balances().confirmed == 0, "… and nobody confirms it");
    // a page that starts above the wallet's tree: missed transactions
    let mut fresh = WalletState::new(alice.address().pk);
    let mut gap = chain.page_value(0, chain.height);
    gap["txs"].as_array_mut().unwrap().remove(0);
    assert!(matches!(fresh.scan(&parse(&gap), &alice.scan_key()), Err(WalletError::Listing(_))));
    assert_eq!(fresh, WalletState::new(alice.address().pk), "a refused page leaves the state untouched");
}

// ---------------------------------------------------------------------------------------------------
// RW4-1 — the embargo, without the user's statement
// ---------------------------------------------------------------------------------------------------

/// The scenario of `rw4_f1` / `rw4_f1b` for a restored device that makes NO statement (the
/// review's tests configure through `common::configure`, which makes it): at every confirmed
/// height from the restore on, either the core refuses the build or the earlier transaction can
/// no longer be mined. For the default and the longest expiry, for 0 to 200 blocks of honest lag,
/// with the leading honest node answering and without it.
#[test]
fn rw4r_f1_a_restored_state_builds_nothing_while_an_earlier_transaction_can_still_be_mined() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut cases = 0;
    for lag in [0u64, 1, 63, 64, 65, 70, 128, 199, 200] {
        for offset in [None, Some(1), Some(MAX_EXPIRY_OFFSET)] {
            for leader_answers in [true, false] {
                let mut chain = Chain::new();
                fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
                chain.advance_to(40);
                let behind = chain.height;
                let (old_n2, old_n3) = (chain.report(N2), chain.report(N3));
                let old_page = chain.page_value(0, behind);
                chain.advance_to(behind + lag);
                // device 1: in sync, a NEW wallet (the statement is true for it)
                let mut d1 = WalletState::new(alice.address().pk);
                configure(&mut d1, &[N1, N2, N3]);
                d1.scan(&chain.page(0), &alice.scan_key()).unwrap();
                d1.confirm_state(&[chain.report(N1), chain.report(N3)]).unwrap();
                let built_at = chain.height;
                let p10 = position_of(&d1, 10 * Q);
                let t1 = pay_with(&mut d1, &alice, &[p10], &bob.address(), 4 * Q, offset.map(|o| built_at + o), "rw4r-f1-t1").unwrap();
                let t1_expiry = expiry_of(&t1.body);
                // device 2: restored, lists from the liar, which serves the true chain as it was
                // where honest node 2 stands; the liar reports the same
                let mut d2 = WalletState::new(alice.address().pk);
                nodes_only(&mut d2, &[N1, N2, N3]);
                assert_eq!((d2.spend_embargo(), d2.spend_embargo_until()), (SpendEmbargo::AwaitingBase, None));
                d2.scan(&parse(&old_page), &alice.scan_key()).unwrap();
                let mut reports = vec![old_n2.clone(), old_n3.clone()];
                if leader_answers {
                    reports.push(chain.report(N1));
                }
                let c = d2.confirm_state(&reports).unwrap();
                assert_eq!((c.matched_height, c.embargo_base_set, c.all_reported), (Some(behind), true, leader_answers));
                let SpendEmbargo::Until { first_confirmed, base, until, waived } = d2.spend_embargo() else { panic!() };
                // the arithmetic of `WalletState::spend_embargo`
                let expected_base = if leader_answers { (behind + lag).min(behind + RESTORE_LAG_BOUND_BLOCKS) } else { behind + RESTORE_LAG_BOUND_BLOCKS };
                assert_eq!((first_confirmed, base, until, waived), (behind, expected_base, expected_base + RESTORE_EMBARGO_BLOCKS, false), "lag {lag}, leader answers: {leader_answers}");
                assert!(base >= built_at && until >= t1_expiry, "the base is at or above the height the earlier copy built at");
                // from here on: everybody honest and at the tip, the device checks every 7 blocks
                let p6 = position_of(&d2, 6 * Q);
                let mut allowed_at = None;
                while allowed_at.is_none() {
                    chain.advance_to(chain.height + 7);
                    d2.scan(&chain.page(d2.next_height()), &alice.scan_key()).unwrap();
                    d2.confirm_state(&[chain.report(N1), chain.report(N2), chain.report(N3)]).unwrap();
                    let status = d2.spend_status(Some(chain.height));
                    match pay_with(&mut d2.clone(), &alice, &[p6], &bob.address(), 4 * Q, None, "rw4r-f1-t2") {
                        Ok(_) => {
                            assert!(status.can_spend_now && t1_expiry <= chain.height, "the core lets the restored state spend at confirmed height {} while t1 is valid until {t1_expiry} (lag {lag})", chain.height);
                            allowed_at = Some(chain.height);
                        }
                        Err(WalletError::RestoredRecently { until: Some(u) }) => {
                            assert_eq!((u, status.reason, status.embargo_blocks_left), (until, Some("embargo"), Some(until - chain.height)));
                            assert!(chain.height < until);
                        }
                        Err(e) => panic!("{e}"),
                    }
                }
                // bounded: the embargo ended within 7 blocks of `until`, at most 128 + 256 above the base height
                assert!(allowed_at.unwrap() < until + 7 && until <= behind + RESTORE_LAG_BOUND_BLOCKS + RESTORE_EMBARGO_BLOCKS);
                cases += 1;
            }
        }
    }
    println!("{cases} restores against a stale quorum: the core refused every build while the earlier transaction could still be mined");
}

/// What a lying or silent minority can do to the embargo: push its base up — by at most 256
/// blocks. And what the user's statement is worth: it is accepted before the first state check
/// only, and honoured only if that check shows no configured node ahead of the confirmed height.
#[test]
fn rw4r_f1_the_embargo_base_is_bounded_and_the_users_statement_is_recorded_and_conditional() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q]);
    chain.advance_to(50);
    let tip = chain.height;
    let restored = |statement: bool| {
        let mut s = WalletState::new(alice.address().pk);
        nodes_only(&mut s, &[N1, N2, N3]);
        if statement {
            s.assert_no_other_copy_has_a_pending_payment().unwrap();
        }
        s.scan(&chain.page(0), &alice.scan_key()).unwrap();
        s
    };
    let base_of = |s: &WalletState| match s.spend_embargo() {
        SpendEmbargo::Until { base, until, waived, .. } => (base, until, waived),
        other => panic!("{other:?}"),
    };
    // every node at the tip and answering: 128 blocks, no more
    let mut s = restored(false);
    s.confirm_state(&[chain.report(N1), chain.report(N2), chain.report(N3)]).unwrap();
    assert_eq!(base_of(&s), (tip, tip + 128, false));
    // one node silent: it is taken to have claimed the highest tip there can be
    let mut s = restored(false);
    s.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    assert_eq!(base_of(&s), (tip + 256, tip + 256 + 128, false));
    // one node claims a height far above the chain: the same ceiling, not its claim
    for claim in [tip + 1, tip + 300, u64::MAX] {
        let mut s = restored(false);
        let mut liar = chain.report(N3);
        liar.height = claim;
        s.confirm_state(&[chain.report(N1), chain.report(N2), liar]).unwrap();
        assert_eq!(base_of(&s), (claim.min(tip + 256), claim.min(tip + 256) + 128, false), "a claim of {claim}");
    }
    // the statement: recorded, honoured at a clean first check, and then there is no embargo
    let mut s = restored(true);
    assert!(s.sole_copy_asserted() && s.spend_embargo() == SpendEmbargo::AwaitingBase);
    s.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    assert_eq!(base_of(&s), (tip, tip, true));
    assert!(pay_with(&mut s.clone(), &alice, &[position_of(&s, 10 * Q)], &bob.address(), 4 * Q, None, "rw4r-statement").is_ok());
    assert!(WalletState::from_json(&s.to_json().unwrap()).unwrap().sole_copy_asserted(), "the statement is part of the stored state");
    // … NOT honoured when a configured node is ahead of the height being confirmed
    let mut s = restored(true);
    let mut ahead = chain.report(N3);
    ahead.height = tip + 1;
    s.confirm_state(&[chain.report(N1), chain.report(N2), ahead]).unwrap();
    assert_eq!(base_of(&s), (tip + 1, tip + 129, false));
    assert!(matches!(pay_with(&mut s.clone(), &alice, &[position_of(&s, 10 * Q)], &bob.address(), 4 * Q, None, "rw4r-void"), Err(WalletError::RestoredRecently { until: Some(_) })));
    // … and not accepted once the base exists
    assert!(matches!(s.assert_no_other_copy_has_a_pending_payment(), Err(WalletError::Request(_))));
    // a rescan keeps the embargo and its base: it is the device's history, not the listing's
    let again = s.fresh_for_rescan();
    assert_eq!(again.spend_embargo(), s.spend_embargo());
    // the embargo and the longest expiry are one number
    assert_eq!(RESTORE_EMBARGO_BLOCKS, MAX_EXPIRY_OFFSET);
}

// ---------------------------------------------------------------------------------------------------
// RW4-3, RW4-4, RW4-10, RW4-11, RW4-8
// ---------------------------------------------------------------------------------------------------

/// A state scanned with the viewing key is marked, reports no confirmed balance for notes whose
/// spends it cannot see, offers nothing and builds nothing — until one page with the full key.
#[test]
fn rw4r_f3_a_view_only_state_is_marked_offers_nothing_and_builds_nothing_until_the_full_key_scans() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    let mut watch = WalletState::new(alice.address().pk);
    configure(&mut watch, &[N1, N2, N3]);
    watch.scan(&chain.page(0), &alice.incoming_viewing_key()).unwrap();
    watch.confirm_state(&[chain.report(N1), chain.report(N2), chain.report(N3)]).unwrap();
    let b = watch.balances();
    assert_eq!(watch.view_only_since(), Some(0));
    assert_eq!((b.confirmed, b.spendable, b.received_spend_unknown, b.unverified_spends), (0, 0, 16 * Q as u128, true));
    assert!(select_inputs(&watch, Q, Q).is_err());
    assert_eq!(watch.spend_status(None).reason, Some("view_only"));
    let p = position_of(&watch, 10 * Q);
    let spend = SpendOptions { chain_id: CHAIN, inputs: &[p], expiry_height: None, allow_unverified: true, max_fee: None };
    let r = deterministic::transfer_locked(&watch, watch.revision(), &alice, &TransferParams { spend, recipient: &bob.address(), amount: Q, fee: Q }, "rw4r-view");
    assert!(matches!(r.err(), Some(WalletError::ViewOnly)));
    reads_back(&watch, "a view-only state");
    // one page with the full key — an empty one
    chain.advance_to(chain.height + 1);
    watch.scan(&chain.page(watch.next_height()), &alice.scan_key()).unwrap();
    watch.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    let b = watch.balances();
    assert_eq!((watch.view_only_since(), b.confirmed, b.spendable, b.received_spend_unknown, b.unverified_spends), (None, 16 * Q as u128, 16 * Q as u128, 0, false));
    assert!(pay_with(&mut watch, &alice, &[p], &bob.address(), 4 * Q, None, "rw4r-view-full").is_ok());
    // the mark comes back with the next page that is scanned without the nullifier key
    chain.advance_to(chain.height + 1);
    watch.scan(&chain.page(watch.next_height()), &alice.incoming_viewing_key()).unwrap();
    assert!(watch.view_only_since().is_some() && watch.balances().spendable == 0);
}

/// "To self" is the whole address. A payment to the wallet's own address is credited from the
/// record AND found again by any rescan; an address with the wallet's `pk` and another
/// encryption key is refused; a payee's `pk` under the wallet's own encryption key is the
/// payee's affair — the wallet keeps no claim on that output.
#[test]
fn rw4r_f4_payment_to_self_is_the_whole_address() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 7 * Q, 5 * Q]);
    let mut w = WalletState::new(alice.address().pk);
    configure(&mut w, &[N1, N2, N3]);
    w.scan(&chain.page(0), &alice.scan_key()).unwrap();
    w.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    let crafted = ShieldedAddress { pk: alice.address().pk, ek: bob.address().ek };
    let before = w.clone();
    let (p10, p7) = (position_of(&w, 10 * Q), position_of(&w, 7 * Q));
    assert!(matches!(pay_with(&mut w, &alice, &[p10], &crafted, 4 * Q, None, "rw4r-f4-crafted"), Err(WalletError::MixedOwnAddress)));
    assert_eq!(w, before, "nothing was locked");
    // the whole own address
    let t = pay_with(&mut w, &alice, &[p10], &alice.address(), 4 * Q, None, "rw4r-f4-self").unwrap();
    assert!(w.pending()[0].own_payment.is_some() && w.pending()[0].change.is_some());
    // the payee's pk under the wallet's own encryption key
    let odd = ShieldedAddress { pk: bob.address().pk, ek: alice.address().ek };
    let t2 = pay_with(&mut w, &alice, &[p7], &odd, 2 * Q, None, "rw4r-f4-odd").unwrap();
    assert!(w.pending()[1].own_payment.is_none());
    chain.block(&[&t.body, &t2.body]).unwrap();
    w.scan(&chain.page(w.next_height()), &alice.scan_key()).unwrap();
    w.confirm_state(&[chain.report(N1), chain.report(N2), chain.report(N3)]).unwrap();
    assert_eq!(w.resolve().mined.len(), 2);
    let owned = w.balances().confirmed;
    assert_eq!(owned, (4 + 5 + 4 + 5) * Q as u128, "4 to self + its change 5; the change 4 of the 7; the 5");
    let mut again = w.fresh_for_rescan();
    again.scan(&chain.page(0), &alice.scan_key()).unwrap();
    again.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    assert_eq!(again.balances().confirmed, owned, "a rescan finds every note the wallet was credited");
}

/// The revision's identity: two tabs that build from one revision hold the same counter and two
/// identities; the identity check refuses the other tab's state where the counter accepts it.
#[test]
fn rw4r_i10_two_states_with_one_counter_have_two_revision_identities() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    let mut stored = WalletState::new(alice.address().pk);
    let empty_id = stored.revision_id();
    configure(&mut stored, &[N1, N2, N3]);
    assert_ne!(stored.revision_id(), empty_id);
    stored.scan(&chain.page(0), &alice.scan_key()).unwrap();
    stored.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    let (mut tab_a, mut tab_b, mut tab_c) = (stored.clone(), stored.clone(), stored.clone());
    pay_with(&mut tab_a, &alice, &[position_of(&stored, 10 * Q)], &bob.address(), 4 * Q, None, "rw4r-tab-a").unwrap();
    pay_with(&mut tab_b, &alice, &[position_of(&stored, 6 * Q)], &bob.address(), 4 * Q, None, "rw4r-tab-b").unwrap();
    tab_c.resolve(); // changes nothing: the same revision
    assert_eq!((tab_a.revision(), tab_b.revision()), (stored.revision() + 1, stored.revision() + 1));
    assert_ne!(tab_a.revision_id(), tab_b.revision_id());
    assert!(tab_b.expect_revision(tab_a.revision()).is_ok(), "the counter cannot tell them apart");
    assert!(matches!(tab_b.expect_revision_id(&tab_a.revision_id()), Err(WalletError::StaleState)), "the identity can");
    assert!(tab_a.expect_revision_id(&tab_a.revision_id()).is_ok() && tab_c.revision_id() == stored.revision_id());
    // the identity is part of the state and chains: the same change on the same state gives the same identity
    let mut again = stored.clone();
    pay_with(&mut again, &alice, &[position_of(&stored, 10 * Q)], &bob.address(), 4 * Q, None, "rw4r-tab-a").unwrap();
    assert_eq!(again.revision_id(), tab_a.revision_id());
    assert_eq!(WalletState::from_json(&tab_a.to_json().unwrap()).unwrap().revision_id(), tab_a.revision_id());
    assert!(tab_a.content_eq(&again) && !tab_a.content_eq(&tab_b));
}

/// The wallet's own shield: built with the state, its note is stored from the record whatever
/// its value — also when the listing blanks its ciphertext, also across a rescan while it is
/// unspent — and a note below the minimum is refused unless the caller allows it.
#[test]
fn rw4r_i11_the_wallets_own_shield_is_recorded_and_stored_whatever_its_value() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q]);
    let mut w = WalletState::new(alice.address().pk);
    configure(&mut w, &[N1, N2, N3]);
    w.scan(&chain.page(0), &alice.scan_key()).unwrap();
    w.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    let key = fake_account_key(3);
    let own = alice.address();
    let small = ShieldRequest { ctx: chain.ctx(), from_pub_key: &key, nonce: 1, v_in: Q + Q / 2, fee: Q, recipient: &own, max_fee: None };
    assert!(matches!(deterministic::own_shield_recorded(&w, w.revision(), &own, &small, false, "rw4r-shield").err(), Some(WalletError::NoteBelowMinimum { value, min }) if value == Q / 2 && min == Q));
    assert!(matches!(build_shield(&small).err(), Some(WalletError::NoteBelowMinimum { .. })), "the plain builder refuses dust for anybody");
    let mixed = ShieldedAddress { pk: own.pk, ek: bob.address().ek };
    let to_mixed = ShieldRequest { recipient: &mixed, ..small.clone() };
    assert!(matches!(deterministic::own_shield_recorded(&w, w.revision(), &own, &to_mixed, true, "rw4r-shield").err(), Some(WalletError::MixedOwnAddress)));
    let other = bob.address();
    let to_other = ShieldRequest { recipient: &other, ..small.clone() };
    assert!(matches!(deterministic::own_shield_recorded(&w, w.revision(), &own, &to_other, true, "rw4r-shield").err(), Some(WalletError::Request(_))));
    // explicitly allowed: recorded
    let (tx, next) = deterministic::own_shield_recorded(&w, w.revision(), &own, &small, true, "rw4r-shield").unwrap();
    assert_eq!((next.own_shields().len(), next.revision()), (1, w.revision() + 1));
    w = next;
    chain.block(&[&tx.body]).unwrap();
    // the listing blanks its ciphertext: the record opens it all the same
    let mut page = chain.page_value(w.next_height(), chain.height);
    for j in 0..2 {
        page["txs"][0]["outputs"][j]["kem_ct"] = serde_json::json!("00".repeat(1088));
        page["txs"][0]["outputs"][j]["note_ct"] = serde_json::json!("00".repeat(56));
    }
    let mut blanked = w.clone();
    assert_eq!(blanked.scan(&parse(&page), &alice.scan_key()).unwrap().own_outputs_from_record, 1);
    // the true listing, confirmed: stored, below the minimum, confirmed, spendable
    w.scan(&chain.page(w.next_height()), &alice.scan_key()).unwrap();
    w.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    assert_eq!((w.balances().confirmed, w.below_minimum().count, w.own_shields().len()), (10 * Q as u128 + Q as u128 / 2, 0, 1), "the record of an unspent note below the minimum is kept");
    // … across a rescan
    let mut again = w.fresh_for_rescan();
    again.scan(&chain.page(0), &alice.scan_key()).unwrap();
    again.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    assert_eq!((again.balances().confirmed, again.below_minimum().count), (10 * Q as u128 + Q as u128 / 2, 0));
    // an ordinary own shield: recorded, stored, and the record dropped once it is confirmed
    let big = ShieldRequest { ctx: chain.ctx(), from_pub_key: &key, nonce: 2, v_in: 4 * Q, fee: Q, recipient: &own, max_fee: None };
    let (tx, next) = deterministic::own_shield_recorded(&w, w.revision(), &own, &big, false, "rw4r-shield-big").unwrap();
    w = next;
    assert_eq!(w.own_shields().len(), 2);
    chain.block(&[&tx.body]).unwrap();
    w.scan(&chain.page(w.next_height()), &alice.scan_key()).unwrap();
    w.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    assert_eq!((w.own_shields().len(), w.balances().confirmed), (1, 13 * Q as u128 + Q as u128 / 2));
    // a shield that never arrives: its record goes when the confirmed height passes its expiry
    let lost = ShieldRequest { ctx: chain.ctx(), from_pub_key: &key, nonce: 3, v_in: 4 * Q, fee: Q, recipient: &own, max_fee: None };
    let (_, next) = deterministic::own_shield_recorded(&w, w.revision(), &own, &lost, false, "rw4r-shield-lost").unwrap();
    w = next;
    chain.advance_to(lost.ctx.expiry_height);
    w.scan(&chain.page(w.next_height()), &alice.scan_key()).unwrap();
    w.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    assert_eq!(w.own_shields().len(), 1);
    reads_back(&w, "a state with an own-shield record");
}

/// `spend_status`: can a spend be built now, and why not — every bound in blocks.
#[test]
fn rw4r_i8_spend_status_names_the_reason_and_gives_every_bound_in_blocks() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q]);
    let mut w = WalletState::new(alice.address().pk);
    assert_eq!(w.spend_status(None).reason, Some("no_nodes"));
    nodes_only(&mut w, &[N1, N2, N3]);
    let s = w.spend_status(None);
    assert_eq!((s.reason, s.embargo_until, s.default_expiry_blocks, s.max_expiry_blocks, s.restore_embargo_blocks, s.restore_lag_bound_blocks), (Some("no_quorum"), None, 64, 128, 128, 256));
    w.scan(&chain.page(0), &alice.scan_key()).unwrap();
    let c = w.confirm_state(&[chain.report(N1), chain.report(N2), chain.report(N3)]).unwrap();
    let tip = chain.height;
    assert_eq!((c.confirmed_lag, c.quorum_tip, c.highest_reported, c.all_reported), (Some(0), Some(tip), Some(tip), true));
    let s = w.spend_status(c.quorum_tip);
    assert_eq!((s.can_spend_now, s.reason, s.embargo_until, s.embargo_blocks_left, s.confirmed_lag, s.usable_window_blocks), (false, Some("embargo"), Some(tip + 128), Some(128), Some(0), Some(64)));
    // the embargo over; the listing a block ahead of what is confirmed
    chain.advance_to(tip + 128);
    w.scan(&chain.page(w.next_height()), &alice.scan_key()).unwrap();
    w.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    assert!(w.spend_status(Some(chain.height)).can_spend_now);
    fund(&mut chain, &bob.address(), &[Q]);
    w.scan(&chain.page(w.next_height()), &alice.scan_key()).unwrap();
    assert_eq!(w.spend_status(Some(chain.height)).reason, Some("root_unconfirmed"));
    // the quorum 64 blocks ahead of the confirmed height: a default spend could not be mined
    let mut stale = w.clone();
    stale.confirm_state(&[chain.report(N1), chain.report(N2)]).unwrap();
    let c0 = stale.confirmed_height().unwrap();
    let s = stale.spend_status(Some(c0 + 63));
    assert_eq!((s.can_spend_now, s.confirmed_lag, s.usable_window_blocks), (true, Some(63), Some(1)));
    let s = stale.spend_status(Some(c0 + 64));
    assert_eq!((s.can_spend_now, s.reason, s.usable_window_blocks), (false, Some("window_too_short"), Some(0)));
}
