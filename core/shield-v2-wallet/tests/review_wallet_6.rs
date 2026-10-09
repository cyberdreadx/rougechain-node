//! REVIEW_WALLET_6 — confirmation review of `fix/shield-v2-wallet-settlement-4` @ `b59088b`
//! (see `REVIEW_WALLET_6.md`). Narrow: are the ten conditions of REVIEW_WALLET_5 met, was an
//! edited test weakened, is the restated client loop correct. Nothing was fixed by the review.
//!
//! * `rw6_fN_…` — a defect; **fails on purpose** and asserts the safe behaviour, so that a fix
//!   turns it green without editing what it asserts;
//! * `rw6_sound_…` / `rw6_cN_…` — something that was attacked, or a condition that was checked,
//!   and holds (passes).
//!
//! The loop tests drive `common::client_loop::Session` (the reference of `NOTES.md` §6) through
//! [`Drive`], which is `LoopClient::round` plus the one thing `LoopClient` cannot express: a
//! listing request that is not answered.
//!
//! Needs the `test-vectors` feature, like the earlier reviews.
#![cfg(feature = "test-vectors")]

mod common;

use std::collections::BTreeMap;

use common::client_loop::{Decision, Session, Stop, FIRST_CHECK_ROUNDS, PAGE_BLOCKS, STRIKES};
use common::*;
use quantum_vault_shield_v2::reference::{derive_rho, digest_from_bytes, digest_to_bytes, nullifier, Note};
use quantum_vault_shield_v2_wallet::note_enc::encrypt_note_with_kem_randomness;
use quantum_vault_shield_v2_wallet::tx::{deterministic, UnprovenTx};
use quantum_vault_shield_v2_wallet::*;

const IDS: [&str; 5] = ["node-1", "node-2", "node-3", "node-4", "node-5"];

fn fund(chain: &mut Chain, to: &ShieldedAddress, values: &[u64]) {
    let key = fake_account_key(1);
    for (i, v) in values.iter().enumerate() {
        let req = ShieldRequest { ctx: chain.ctx(), from_pub_key: &key, nonce: 1, v_in: v + Q, fee: SHIELD_V2_MIN_FEE_QUANTA, recipient: to, max_fee: None };
        let tx = deterministic::shield(&req, &format!("rw6-fund-{}-{i}", chain.height)).unwrap();
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

fn pay_with(state: &mut WalletState, keys: &ShieldedKeys, positions: &[u64], to: &ShieldedAddress, amount: u64, label: &str) -> Result<UnprovenTx, WalletError> {
    let spend = SpendOptions { chain_id: CHAIN, inputs: positions, expiry_height: None, allow_unverified: false, max_fee: None };
    let (tx, next) = deterministic::transfer_locked(state, state.revision(), keys, &TransferParams { spend, recipient: to, amount, fee: Q }, label)?;
    *state = next;
    Ok(tx)
}

fn empty_page(from: u64, next: u64, tip: u64) -> ListingPage {
    parse(&serde_json::json!({ "active": true, "tip_height": tip, "from_height": from, "next_height": next, "txs": [] }))
}

/// 32 bytes that are a canonical digest (every 4-byte word below the modulus) and differ per
/// `(tag, k)`.
fn canon(tag: u8, k: u32) -> [u8; 32] {
    let mut b = [0u8; 32];
    b[0] = tag;
    b[4..7].copy_from_slice(&k.to_le_bytes()[..3]);
    b[8] = 0x5a;
    b
}

/// A transaction as a lying node lists it: the two nullifiers it likes, and in slot `slot` a
/// note that really opens for `to` (value, a commitment over `rho = H_rho(nf1, nf2, slot)`, an
/// honest ciphertext). Anybody who knows the address can make one. The other output is noise.
/// Returns the entry (without height, index and leaf numbers) and the note's `rho`.
fn forged_tx(to: &ShieldedAddress, nf: [[u8; 32]; 2], slot: usize, value: u64, salt: u32) -> (serde_json::Value, [u8; 32]) {
    let nfd = [digest_from_bytes(&nf[0]).unwrap(), digest_from_bytes(&nf[1]).unwrap()];
    let r = canon(7, salt);
    let rho = derive_rho(&nfd, slot);
    let cm = digest_to_bytes(&Note { value, pk: digest_from_bytes(&to.pk).unwrap(), rho, r: digest_from_bytes(&r).unwrap() }.commitment());
    let mut rnd = [0u8; 32];
    rnd[..4].copy_from_slice(&salt.to_le_bytes());
    let (kem_ct, note_ct, _) = encrypt_note_with_kem_randomness(&to.ek, &cm, value, &r, rnd).unwrap();
    let mine = serde_json::json!({ "cm_out": hex::encode(cm), "leaf": 0, "kem_ct": hex::encode(kem_ct), "note_ct": hex::encode(note_ct) });
    let noise = serde_json::json!({ "cm_out": hex::encode(canon(9, salt)), "leaf": 0, "kem_ct": "00".repeat(1088), "note_ct": "00".repeat(56) });
    let outputs = if slot == 0 { [mine, noise] } else { [noise, mine] };
    let tx = serde_json::json!({
        "height": 0, "index": 0, "tx_hash": hex::encode(canon(3, salt)), "tx_type": "shielded_transfer_v2",
        "nf1": hex::encode(nf[0]), "nf2": hex::encode(nf[1]), "outputs": outputs,
    });
    (tx, digest_to_bytes(&rho))
}

/// Puts listed transactions at `(height, index)` and numbers their leaves from `first_leaf`.
fn place(txs: Vec<(serde_json::Value, u64, u64)>, first_leaf: u64) -> Vec<serde_json::Value> {
    let mut leaf = first_leaf;
    txs.into_iter()
        .map(|(mut tx, height, index)| {
            tx["height"] = serde_json::json!(height);
            tx["index"] = serde_json::json!(index);
            for j in 0..2 {
                tx["outputs"][j]["leaf"] = serde_json::json!(leaf);
                leaf += 1;
            }
            tx
        })
        .collect()
}

fn page_of(from: u64, next: u64, tip: u64, txs: Vec<serde_json::Value>) -> ListingPage {
    parse(&serde_json::json!({ "active": true, "tip_height": tip, "from_height": from, "next_height": next, "txs": txs }))
}

// ---------------------------------------------------------------------------------------------------
// Condition 2 — no page makes `scan` answer `state_invariant`: five hostile pages of this review.
// ---------------------------------------------------------------------------------------------------

/// Five listings no chain produces, each aimed at one clause of `WalletState::validate`, each
/// run with the full key and with the viewing key, with and without a payment pending, on a
/// synced state and in the middle of a rescan — and each followed by "the next page with the
/// full key", which is where RW5-1 (a) surfaced:
///
/// 1. a nullifier listed in the SAME block as the note it spends, in front of it (the edge of
///    the new rule "a sighting BELOW the note's height is refused");
/// 2. a nullifier listed before the note it spends and again after it (one nullifier, twice);
/// 3. heights at the end of the range: a payment in block `u64::MAX − 1`;
/// 4. the nullifiers of the pending payment (or of an unspent note) under four forged
///    transactions: with a dust "change", reversed, in order with other outputs, and again;
/// 5. the transaction that created a note, listed again with its nullifiers and its outputs
///    swapped, followed by 300 forged payments.
///
/// Every answer of `scan` must be `Ok`, `listing:` or `rescan_required:` — the three the loop
/// has a rule that goes on — and a state that was returned reads back.
#[test]
fn rw6_c2_five_hostile_pages_never_make_scan_answer_state_invariant() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let nk = digest_from_bytes(&alice.scan_key().nk.unwrap()).unwrap();
    let nf_of = |rho: &[u8; 32]| digest_to_bytes(&nullifier(&nk, &digest_from_bytes(rho).unwrap()));
    let (mut cases, mut refused, mut accepted) = (0, 0, 0);
    for kind in 1..=5u32 {
        for pending in [false, true] {
            for rescan in [false, true] {
                for view in [false, true] {
                    let what = format!("page {kind}, pending {pending}, rescan {rescan}, viewing key {view}");
                    let mut chain = Chain::new();
                    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
                    let mut w = WalletState::new(alice.address().pk);
                    configure_as_sole_copy(&mut w, &IDS[..3]);
                    w.scan(&chain.page(0), &alice.scan_key()).unwrap();
                    w.confirm_state(&[chain.report(IDS[0]), chain.report(IDS[1])]).unwrap();
                    let own_nf = w.unspent().find(|n| n.value == 6 * Q).unwrap().nullifier.unwrap().0;
                    let creating = chain.page_value(0, chain.height)["txs"][0].clone();
                    let pair: [[u8; 32]; 2] = if pending {
                        let p = position_of(&w, 10 * Q);
                        let t = pay_with(&mut w, &alice, &[p], &bob.address(), 4 * Q, &format!("rw6-c2-{kind}-{rescan}-{view}")).unwrap();
                        [t.body[74..106].try_into().unwrap(), t.body[106..138].try_into().unwrap()]
                    } else {
                        [own_nf, canon(4, 9)]
                    };
                    let key = if view { alice.incoming_viewing_key() } else { alice.scan_key() };
                    let mut s = if rescan {
                        let mut s = w.fresh_for_rescan();
                        s.scan(&chain.page(0), &key).unwrap();
                        s
                    } else {
                        w.clone()
                    };
                    let (h, leaves) = (s.next_height(), s.tree().note_count());
                    let to = alice.address();
                    // a note the pages below create, and its nullifier
                    let (x_tx, x_rho) = forged_tx(&to, [canon(1, 1), canon(1, 2)], 0, 3 * Q, 11);
                    let nf_x = nf_of(&x_rho);
                    let m_tx = forged_tx(&to, [canon(1, 3), canon(1, 4)], 1, 2 * Q, 12).0; // a first note: with the viewing key it switches the log on
                    let spends_x = |salt: u32, first: bool| forged_tx(&to, if first { [nf_x, canon(1, 20 + salt)] } else { [canon(1, 20 + salt), nf_x] }, 0, Q, 13 + salt).0;
                    let pages: Vec<ListingPage> = match kind {
                        1 => vec![page_of(h, h + 2, h + 1, place(vec![(m_tx, h, 0), (spends_x(0, true), h + 1, 0), (x_tx, h + 1, 1)], leaves))],
                        2 => vec![
                            page_of(h, h + 2, h + 3, place(vec![(m_tx, h, 0), (spends_x(0, true), h + 1, 0)], leaves)),
                            page_of(h + 2, h + 4, h + 3, place(vec![(x_tx, h + 2, 0), (spends_x(1, false), h + 3, 0)], leaves + 4)),
                        ],
                        3 => vec![page_of(h, u64::MAX, u64::MAX - 1, place(vec![(m_tx, u64::MAX - 1, 0)], leaves)), empty_page(u64::MAX, u64::MAX, u64::MAX - 1)],
                        4 => vec![page_of(
                            h,
                            h + 4,
                            h + 3,
                            place(
                                vec![
                                    (forged_tx(&to, [pair[0], canon(4, 1)], 0, 1, 41).0, h, 0),
                                    (forged_tx(&to, [pair[1], pair[0]], 1, 2 * Q, 42).0, h + 1, 0),
                                    (forged_tx(&to, [pair[0], pair[1]], 0, 5 * Q, 43).0, h + 2, 0),
                                    (forged_tx(&to, [pair[0], pair[1]], 1, 5 * Q, 44).0, h + 3, 0),
                                ],
                                leaves,
                            ),
                        )],
                        _ => {
                            let mut swapped = creating.clone();
                            swapped["nf1"] = creating["nf2"].clone();
                            swapped["nf2"] = creating["nf1"].clone();
                            swapped["outputs"] = serde_json::json!([creating["outputs"][1].clone(), creating["outputs"][0].clone()]);
                            let mut txs = vec![(swapped, h, 0)];
                            txs.extend((0..300u32).map(|i| (forged_tx(&to, [canon(5, 2 * i), canon(5, 2 * i + 1)], (i % 2) as usize, Q + i as u64, 100 + i).0, h, 1 + i as u64)));
                            vec![page_of(h, h + 1, h, place(txs, leaves))]
                        }
                    };
                    let mut check = |s: &mut WalletState, page: &ListingPage, key: &ScanKey, step: &str| {
                        let before = s.clone();
                        let r = s.scan(page, key);
                        cases += 1;
                        assert!(!matches!(r, Err(WalletError::StateInvariant)), "{what}, {step}: state_invariant");
                        assert!(matches!(r, Ok(_) | Err(WalletError::Listing(_)) | Err(WalletError::RescanRequired)), "{what}, {step}: {:?} — an error the loop stops on", r.as_ref().map(|_| ()).map_err(|e| e.to_string()));
                        match r {
                            Ok(_) => {
                                accepted += 1;
                                WalletState::from_json(&s.to_json().expect("a returned state encodes")).expect("a returned state reads back");
                            }
                            Err(_) => {
                                refused += 1;
                                assert!(*s == before, "{what}, {step}: a refused page leaves the state as it was");
                            }
                        }
                    };
                    for (i, page) in pages.iter().enumerate() {
                        check(&mut s, page, &key, &format!("hostile page {}", i + 1));
                    }
                    // the next page with the FULL key (twice: RW5-1 (a) refused every later scan)
                    for i in 0..2 {
                        let n = s.next_height();
                        check(&mut s, &empty_page(n, n, n.saturating_sub(1)), &alice.scan_key(), &format!("the next page with the full key ({i})"));
                    }
                    // the state check and the settlement on whatever the pages left
                    let reports: Vec<StateReport> = IDS[..3].iter().map(|id| chain.report(id)).collect();
                    assert!(!matches!(s.confirm_state(&reports), Err(WalletError::StateInvariant)), "{what}: confirm_state");
                    s.resolve();
                    assert_eq!(s.pending().len(), pending as usize, "{what}: the lock is where it was — nothing unconfirmed settles an entry");
                    // … and the way out is open: a rescan against an honest node
                    let mut again = s.fresh_for_rescan();
                    again.scan(&chain.page(0), &alice.scan_key()).unwrap_or_else(|e| panic!("{what}: the rescan: {e}"));
                    assert_eq!(again.confirm_state(&reports).unwrap().matched_height, Some(chain.height), "{what}");
                }
            }
        }
    }
    println!("rw6-c2: {cases} calls of scan over 5 hostile pages × 8 settings: {accepted} accepted, {refused} refused as listing:/rescan_required:, state_invariant: 0");
}

// ---------------------------------------------------------------------------------------------------
// The client loop: a driver that can also leave a listing request unanswered.
// ---------------------------------------------------------------------------------------------------

/// `common::client_loop::LoopClient::round`, statement for statement, with a listing answer that
/// may be missing (`None`: no answer, or not a page — `NOTES.md` §6 step 1).
struct Drive {
    s: WalletState,
    session: Session,
    pages_per_round: usize,
    rescans: u32,
    /// (round, node, banned, why) of every `LEAVE`
    left: Vec<(u64, usize, bool, &'static str)>,
    /// rounds in which the first state check waited
    waits: u32,
}

impl Drive {
    fn new(s: WalletState, listed_from: usize) -> Self {
        let nodes = s.nodes().len();
        Self { s, session: Session::new(nodes, listed_from), pages_per_round: 4, rescans: 0, left: Vec::new(), waits: 0 }
    }

    fn apply(&mut self, d: Decision) -> bool {
        match d {
            Decision::Go => return true,
            Decision::Leave { ban, why } => {
                let plan = self.session.plan_leave(ban, &self.s);
                if plan.rescan {
                    self.s = self.s.fresh_for_rescan();
                    self.rescans += 1;
                }
                self.left.push((self.session.round, self.session.listing, ban, why));
                self.session.commit_leave(plan);
            }
            Decision::Rescan => {
                self.s = self.s.fresh_for_rescan();
                self.rescans += 1;
                self.session.after_rescan();
            }
            Decision::Wait => self.waits += 1,
            Decision::Reload => {}
            Decision::Stop(stop) => self.session.stopped = Some(stop),
        }
        false
    }

    fn round(&mut self, key: &ScanKey, page: &mut dyn FnMut(usize, u64) -> Option<ListingPage>, reports: &mut dyn FnMut() -> Vec<StateReport>) {
        if !self.session.begin_round() {
            return;
        }
        let mut at_tip = false;
        for _ in 0..self.pages_per_round {
            let Some(p) = page(self.session.listing, self.s.next_height()) else {
                let d = self.session.after_no_answer();
                if !self.apply(d) {
                    return;
                }
                break; // "otherwise go to step 2"
            };
            let mut next = self.s.clone();
            let r = next.scan(&p, key);
            if r.is_ok() {
                self.s = next;
            }
            let d = self.session.after_scan(&p, &r);
            if !self.apply(d) {
                return;
            }
            if r.is_ok_and(|r| r.at_tip) {
                at_tip = true;
                break;
            }
        }
        let fresh = reports();
        let wait = self.session.first_check_may_run(&self.s, &fresh);
        let handed_in = self.session.add_reports(fresh);
        if !self.apply(wait) {
            return;
        }
        let c = self.s.confirm_state(&handed_in).unwrap();
        let d = self.session.after_confirm(&c, at_tip, &self.s);
        if !self.apply(d) {
            return;
        }
        self.s.resolve();
    }

    fn banned(&self) -> Vec<usize> {
        self.session.bad.iter().copied().collect()
    }
}

/// What every node reported for every height the stand-in chain has had.
#[derive(Default)]
struct Hist {
    at: BTreeMap<u64, StateReport>,
}

impl Hist {
    fn record(&mut self, chain: &Chain) {
        self.at.insert(chain.height, chain.report(IDS[0]));
    }
    /// The TRUE report of node `i` for height `h`.
    fn report(&self, i: usize, h: u64) -> StateReport {
        let mut r = self.at[&h].clone();
        r.node_id = node(IDS[i]);
        r
    }
    /// A report of node `i` for height `h` that is nobody's state.
    fn lie(&self, i: usize, h: u64) -> StateReport {
        let mut r = self.report(i, h);
        r.nullifier_acc[5] ^= 1;
        r
    }
}

fn grow(chain: &mut Chain, hist: &mut Hist, to: u64) {
    while chain.height < to {
        chain.block(&[]).unwrap();
        hist.record(chain);
    }
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

/// The bound of `NOTES.md` §6: `(n − quorum + 1)·(D + K + 2) + W`.
fn bound(n: usize, d: u64) -> u64 {
    let quorum = n / 2 + 1;
    (n - quorum + 1) as u64 * (d + STRIKES as u64 + 2) + FIRST_CHECK_ROUNDS as u64
}

/// The adversaries the task names that lie THE SAME WAY in every round, for three and for five
/// nodes, a full lying minority in front of the honest nodes in the order, a new wallet and a
/// restored one: never its tip; true but short pages; the truth and then empty heights; a
/// listing that is refuted (the liars silent in the state check); a forged listing by nodes that
/// answer the state check truthfully. Within the documented bound the tip is confirmed,
/// everything scanned is confirmed, the loop lists from an honest node, has not stopped, and no
/// honest node is banned — and it stays so.
#[test]
fn rw6_sound_consistent_liars_are_left_or_banned_within_the_bound_for_three_and_five_nodes() {
    let alice = keys(PHRASE_1);
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    chain.advance_to(20);
    let t = chain.height;
    let forged = forged_tx(&alice.address(), [canon(6, 1), canon(6, 2)], 0, 50 * Q, 61).0;
    let liar = |strategy: usize, since: u64| -> ListingPage {
        let truth_with = |tip: u64, next: u64| {
            let mut p = chain.page_value(since, t);
            p["tip_height"] = serde_json::json!(tip);
            p["next_height"] = serde_json::json!(next);
            parse(&p)
        };
        match strategy {
            // never its tip: the truth, then full pages to nowhere
            0 if since > t => empty_page(since, since + PAGE_BLOCKS, 1_000_000),
            0 => truth_with(1_000_000, since.max(A) + PAGE_BLOCKS),
            // true but short: one height per page, never the tip
            1 => {
                let h = since.max(A);
                let mut p = chain.page_value(h, h.min(t));
                p["tip_height"] = serde_json::json!(1_000_000);
                p["from_height"] = serde_json::json!(h);
                p["next_height"] = serde_json::json!(h + 1);
                parse(&p)
            }
            // the truth, then empty heights above the tip, as its tip
            2 if since > t => empty_page(since, since, since - 1),
            2 => truth_with(t + PAGE_BLOCKS, t + 1 + PAGE_BLOCKS),
            // a payment that is on no chain, at the tip
            _ if since > t => empty_page(since, since, t),
            _ => {
                let mut p = chain.page_value(since, t);
                let leaves = chain.state().note_count;
                p["txs"].as_array_mut().unwrap().extend(place(vec![(forged.clone(), t, 0)], leaves));
                parse(&p)
            }
        }
    };
    let names = ["never its tip", "true but short pages", "the truth, then empty heights", "refuted, silent in the state check", "a forged listing, truthful in the state check"];
    for n in [3usize, 5] {
        let liars = n - (n / 2 + 1);
        for (strategy, name) in names.iter().enumerate() {
            for new in [true, false] {
                let mut c = Drive::new(wallet(&alice, n, new), 0);
                let limit = bound(n, 1);
                let mut settled_at = 0;
                let truthful = strategy == 4;
                for round in 1..=limit + 30 {
                    c.round(
                        &alice.scan_key(),
                        &mut |node, since| Some(if node < liars { liar(strategy.min(3), since) } else { chain.page(since) }),
                        &mut || (0..n).filter(|i| *i >= liars || truthful).map(|i| chain.report(IDS[i])).collect(),
                    );
                    let settled = c.session.listing >= liars && c.s.confirmed_height() == Some(t) && c.s.scanned_height() == Some(t);
                    if !settled {
                        settled_at = round + 1;
                    }
                    assert!(c.banned().iter().all(|b| *b < liars), "{name}, n = {n}: an honest node is banned ({:?})", c.left);
                    assert!(c.session.stopped.is_none(), "{name}, n = {n}: the loop stopped");
                }
                assert!(settled_at <= limit, "{name}, n = {n}, new wallet {new}: not settled within {limit} rounds (at {settled_at}); left: {:?}", c.left);
                assert_eq!(c.s.balances().confirmed, 16 * Q as u128);
                println!("rw6-loop {name}, n = {n}, {}: settled after {settled_at} rounds (bound {limit}); {} rescans; waited {}; left {:?}", if new { "new" } else { "restored" }, c.rescans, c.waits, c.left);
            }
        }
    }
}

/// Every honest node is unreachable for a while — no listing answer, no report — and comes
/// back. Three and five nodes; the liars answer throughout (a forged listing, or the truth) or
/// are as silent as the others. The session recovers WITHOUT a ban being cleared: no honest
/// node was banned for being unreachable, the loop did not stop, and within the bound after the
/// honest nodes are back the tip is confirmed.
#[test]
fn rw6_sound_every_honest_node_unreachable_and_back_the_session_recovers_without_clearing_bans() {
    let alice = keys(PHRASE_1);
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    chain.advance_to(20);
    let t = chain.height;
    let forged = forged_tx(&alice.address(), [canon(6, 3), canon(6, 4)], 0, 50 * Q, 62).0;
    for n in [3usize, 5] {
        let liars = n - (n / 2 + 1);
        for liar_mode in ["forged listing", "the truth", "silent"] {
            for start in 0..n {
                let mut c = Drive::new(wallet(&alice, n, true), start);
                let outage = 3 * n as u64 + 4;
                let limit = bound(n, 1);
                let mut settled_at = outage;
                for round in 1..=outage + limit + 10 {
                    let up = round > outage;
                    c.round(
                        &alice.scan_key(),
                        &mut |node, since| {
                            if node >= liars {
                                return up.then(|| chain.page(since));
                            }
                            match liar_mode {
                                "silent" => None,
                                "the truth" => Some(chain.page(since)),
                                _ if since > t => Some(empty_page(since, since, t)),
                                _ => {
                                    let mut p = chain.page_value(since, t);
                                    p["txs"].as_array_mut().unwrap().extend(place(vec![(forged.clone(), t, 0)], chain.state().note_count));
                                    Some(parse(&p))
                                }
                            }
                        },
                        &mut || (0..n).filter(|i| if *i >= liars { up } else { liar_mode != "silent" }).map(|i| chain.report(IDS[i])).collect(),
                    );
                    assert!(c.banned().iter().all(|b| *b < liars), "{liar_mode}, n = {n}, start {start}, round {round}: an honest node is banned ({:?})", c.left);
                    assert!(c.session.stopped.is_none(), "{liar_mode}, n = {n}, start {start}, round {round}: the loop stopped");
                    if !(c.s.confirmed_height() == Some(t) && c.s.scanned_height() == Some(t) && c.s.balances().confirmed == 16 * Q as u128) {
                        settled_at = round + 1;
                    }
                }
                assert!(settled_at <= outage + limit, "{liar_mode}, n = {n}, start {start}: not settled {limit} rounds after the honest nodes are back (at {settled_at}, outage {outage}); left {:?}", c.left);
            }
        }
    }
}

/// The honest nodes one to three blocks apart for a dozen rounds, on a chain that makes a block
/// per round (a pool transaction in every second one); the third node silent, or reporting
/// states that are nobody's for every height in sight. Listing starts at the leading honest node
/// and at the lagging one. No honest node is banned, the loop does not stop, and once the nodes
/// are at one height the tip is confirmed within the bound.
#[test]
fn rw6_sound_honest_nodes_a_few_blocks_apart_with_a_liar_that_only_reports_are_never_banned() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    for liar_reports in [false, true] {
        for start in [1usize, 2] {
            let mut chain = Chain::new();
            let mut hist = Hist::default();
            fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
            hist.record(&chain);
            grow(&mut chain, &mut hist, 20);
            let mut c = Drive::new(wallet(&alice, 3, true), start);
            let lags = [1u64, 2, 3, 3, 2, 1, 1, 2, 3, 3, 3, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
            let mut calm_since = 0;
            for (i, lag) in lags.iter().enumerate() {
                if *lag > 0 {
                    let traffic = if i % 2 == 0 { vec![shield_body(&chain, &bob.address(), Q + i as u64, &format!("rw6-apart-{liar_reports}-{start}-{i}"))] } else { vec![] };
                    chain.block(&traffic.iter().map(|b| b.as_slice()).collect::<Vec<_>>()).unwrap();
                    hist.record(&chain);
                    calm_since = i as u64 + 2;
                }
                let tip = chain.height;
                let at = |node: usize| if node == 2 { tip - lag } else { tip };
                c.round(
                    &alice.scan_key(),
                    &mut |node, since| (node != 0).then(|| parse(&chain.page_value(since, at(node)))),
                    &mut || {
                        let mut r = vec![hist.report(1, at(1)), hist.report(2, at(2))];
                        if liar_reports {
                            r.extend((tip.saturating_sub(4)..=tip).map(|h| hist.lie(0, h)));
                        }
                        r
                    },
                );
                assert!(c.banned().is_empty() && c.session.stopped.is_none(), "liar reports {liar_reports}, start {start}, round {}: banned {:?}, stopped {:?}; left {:?}", i + 1, c.banned(), c.session.stopped, c.left);
            }
            let settled = c.s.confirmed_height() == Some(chain.height) && c.s.scanned_height() == Some(chain.height);
            println!("rw6-loop apart (liar reports {liar_reports}, start node {}): {} rescans, left {:?}, settled {settled}", start + 1, c.rescans, c.left);
            assert!(settled && lags.len() as u64 - calm_since + 1 >= bound(3, 1) - FIRST_CHECK_ROUNDS as u64, "not at the tip {} rounds after the nodes agree", lags.len() as u64 - calm_since + 1);
        }
    }
}

/// A pool that is active and still empty (the first hours after activation): three honest
/// nodes. The loop confirms the tip and does not go round in rescans.
#[test]
fn rw6_sound_an_active_pool_without_a_transaction_is_confirmed() {
    let alice = keys(PHRASE_1);
    let mut chain = Chain::new();
    chain.advance_to(10);
    let mut c = Drive::new(wallet(&alice, 3, false), 0);
    for _ in 0..12 {
        c.round(&alice.scan_key(), &mut |_, since| Some(chain.page(since)), &mut || (0..3).map(|i| chain.report(IDS[i])).collect());
    }
    assert_eq!((c.s.confirmed_height(), c.s.scanned_height(), c.rescans, c.left.len(), c.banned().len()), (Some(10), Some(10), 0, 0, 0), "{:?}", c.left);
}

/// Condition 4, as the reference decides it (`Session::first_check_may_run`): (a) a restored
/// wallet, three honest nodes, one of them a block ahead when they are asked — no state check
/// in that round, and in the next, with all three at one height, `embargo_until` = that height
/// + 128; (b) one node silent for good — exactly W rounds of waiting, then height + 384.
#[test]
fn rw6_c4_the_first_state_check_waits_for_every_node_and_at_most_w_rounds() {
    let alice = keys(PHRASE_1);
    let mut chain = Chain::new();
    let mut hist = Hist::default();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    hist.record(&chain);
    grow(&mut chain, &mut hist, 21);
    // (a)
    let mut c = Drive::new(wallet(&alice, 3, false), 0);
    c.round(&alice.scan_key(), &mut |_, since| Some(parse(&chain.page_value(since, 20))), &mut || vec![hist.report(0, 20), hist.report(1, 20), hist.report(2, 21)]);
    assert_eq!((c.waits, c.s.confirmed_height(), c.s.spend_embargo()), (1, None, SpendEmbargo::AwaitingBase));
    c.round(&alice.scan_key(), &mut |_, since| Some(chain.page(since)), &mut || (0..3).map(|i| hist.report(i, 21)).collect());
    assert_eq!((c.waits, c.s.confirmed_height(), c.s.spend_embargo_until()), (1, Some(21), Some(21 + 128)));
    // (b)
    let mut c = Drive::new(wallet(&alice, 3, false), 0);
    for round in 1..=FIRST_CHECK_ROUNDS as u64 + 1 {
        assert_eq!((c.waits as u64, c.s.confirmed_height()), (round - 1, None));
        c.round(&alice.scan_key(), &mut |_, since| Some(chain.page(since)), &mut || vec![hist.report(0, 21), hist.report(1, 21)]);
    }
    assert_eq!((c.waits, c.s.confirmed_height(), c.s.spend_embargo_until()), (FIRST_CHECK_ROUNDS, Some(21), Some(21 + 256 + 128)));
}

/// Condition 6: the IPv6 forms that only spell an IPv4 address, in the spellings the fixer's
/// test does not use (upper case, uncompressed, mixed notation). And what is NOT recognised,
/// stated: the local-use NAT64 prefix of RFC 8215 (`64:ff9b:1::/48`) and an IPv4 loopback
/// address written in a translated or compatible form (which is then not a loopback host
/// either, so it cannot be mixed into a development set).
#[test]
fn rw6_c6_ipv4_in_ipv6_spellings_are_one_host() {
    let set = |ids: &[&str]| {
        let mut s = WalletState::new([1u8; 32]);
        s.set_nodes(ids).map(|n| n.len())
    };
    let other = "https://node-b.example";
    for id in [
        "https://[::FFFF:C000:0207]",
        "https://[0:0:0:0:0:ffff:c000:207]",
        "https://[0000:0000:0000:0000:0000:ffff:192.0.2.7]",
        "https://[0:0:0:0:ffff:0:c000:207]",
        "https://[0064:ff9b:0:0:0:0:192.0.2.7]",
        "https://[0:0:0:0:0:0:c000:207]",
        "https://[2002:C000:0207:ffff:ffff:ffff:ffff:ffff]",
        "HTTPS://[::ffff:192.0.2.7]:443/path?x#y",
    ] {
        assert!(matches!(set(&["https://192.0.2.7", id, other]), Err(WalletError::Request(_))), "{id} and 192.0.2.7 are one host");
        assert_eq!(set(&[id, "https://192.0.2.8", other]).unwrap(), 3, "{id}");
    }
    // not recognised (noted in the report, not a failure): a network-chosen or local-use prefix
    assert_eq!(set(&["https://192.0.2.7", "https://[64:ff9b:1::192.0.2.7]", other]).unwrap(), 3);
    // an IPv4 loopback address in a translated form is neither "loopback" nor mixable with one
    assert_eq!(set(&["https://[::ffff:0:127.0.0.1]", "https://node-a.example", other]).unwrap(), 3);
    assert!(set(&["http://127.0.0.1:8001", "http://[::ffff:0:127.0.0.1]:8002"]).is_err());
}

// ---------------------------------------------------------------------------------------------------
// RW6-1 — a liar that answers the state check honestly and lists falsely gets the honest
// listing node banned: `listing_refuted` is not evidence against the CURRENT listing node.
// ---------------------------------------------------------------------------------------------------

/// `NOTES.md` §6: "the state is rescanned on every change of the listing node — unless
/// everything it holds is confirmed … A state whose scanned height is confirmed is the chain's,
/// whoever listed it … so the node that is banned is the node that lied." The second sentence
/// is true of the state AT its confirmed height and false of its HISTORY: `confirm_state`
/// compares a report for any height the state still has a checkpoint for, also below the
/// confirmed height (`store.rs`, `confirm_state_inner`: `state_at(height)` for every reported
/// height), and those checkpoints are the previous listing node's word, which no quorum ever
/// looked at.
///
/// The liar lists the true transactions in the true order and moves ONE of them to the next
/// block (a pool transaction of block 21 listed in block 22). At height 22 the state is the
/// chain's — root, both hashes, both counts — and the liar says so in the state check, with an
/// honest node: confirmed, `scanned = confirmed`. The checkpoint for height 21 is wrong. The
/// liar then falls "behind" (K rounds), is LEFT, and — everything being confirmed — the state
/// goes to the honest node as it is. One honest node is two blocks behind for three rounds and
/// reports, truthfully, height 21; the liar now reports something else for 21: more dissent
/// than a lying minority can be, `listing_refuted` — and the node listed from is the honest
/// one. It is banned.
///
/// For three nodes the scenario goes on (the liar does it a second time, with the other honest
/// node): both honest nodes are in `bad`, the liar is the only node left, "every node banned →
/// stop" never fires — the end state of RW5-3. For five nodes (two liars) the first ban is
/// shown. The honest nodes answer truthfully in every round and are at most two blocks apart.
#[test]
fn rw6_f1_a_liar_that_votes_honestly_and_shifts_one_transaction_gets_the_honest_listing_node_banned() {
    let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
    let mut failures = Vec::new();
    for n in [3usize, 5] {
        let quorum = n / 2 + 1;
        let liars = n - quorum;
        let (first_honest, laggard) = (liars, n - 1);
        let mut chain = Chain::new();
        let mut hist = Hist::default();
        fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
        hist.record(&chain);
        grow(&mut chain, &mut hist, 20);
        let x = shield_body(&chain, &bob.address(), 3 * Q, &format!("rw6-f1-x-{n}"));
        chain.block(&[&x]).unwrap(); // block 21: somebody's pool transaction
        hist.record(&chain);
        grow(&mut chain, &mut hist, 22);
        // the liar's listing: the truth, with the transaction of block `was` listed in block `was + 1`
        let shifted = |chain: &Chain, since: u64, was: u64| -> ListingPage {
            if since > was + 1 {
                return empty_page(since, since, was + 1);
            }
            let mut p = chain.page_value(since, was + 1);
            for tx in p["txs"].as_array_mut().unwrap().iter_mut().filter(|tx| tx["height"] == was) {
                tx["height"] = serde_json::json!(was + 1);
            }
            parse(&p)
        };
        let honest_banned = |c: &Drive| c.banned().into_iter().filter(|b| *b >= liars).collect::<Vec<_>>();
        let mut c = Drive::new(wallet(&alice, n, true), liars - 1); // listed from the last liar
        let key = alice.scan_key();

        // round 1: the shifted listing; the liars and every honest node at the tip say "yes" for 22
        c.round(&key, &mut |node, since| Some(if node < liars { shifted(&chain, since, 21) } else { chain.page(since) }), &mut || (0..n).map(|i| hist.report(i, if i == laggard { 21 } else { 22 })).collect());
        assert_eq!((c.s.confirmed_height(), c.s.scanned_height(), c.banned()), (Some(22), Some(22), vec![]), "n = {n}: the shifted listing is confirmed at 22 (set-up)");
        // the chain moves; the liar stays at 22: behind the quorum's tip for K rounds, LEFT, no rescan
        grow(&mut chain, &mut hist, 23);
        for _ in 0..STRIKES {
            c.round(&key, &mut |node, since| Some(if node < liars { shifted(&chain, since, 21) } else { chain.page(since) }), &mut || (0..n).map(|i| hist.report(i, if i == laggard { 21 } else { 23 })).collect());
        }
        assert_eq!((c.session.listing, c.rescans, c.banned()), (first_honest, 0, vec![]), "n = {n}: the liar is left for the first honest node, without a rescan (set-up); left {:?}", c.left);
        // the honest node lists; every honest node is at the tip now; the liars report a state of
        // their own for height 21
        c.round(&key, &mut |_, since| Some(chain.page(since)), &mut || (0..n).map(|i| if i < liars { hist.lie(i, 21) } else { hist.report(i, 23) }).collect());
        println!("rw6-f1, n = {n}: after the honest node's first round: banned {:?} (honest: {:?}), L = node {}, rescans {}, left {:?}", c.banned(), honest_banned(&c), c.session.listing + 1, c.rescans, c.left);
        if !honest_banned(&c).is_empty() {
            failures.push(format!("n = {n}: honest node {} is banned ({:?})", honest_banned(&c)[0] + 1, c.left.last()));
        }
        if n != 3 {
            continue;
        }

        // ---- three nodes: the second honest node, the same way -------------------------------------
        // node 3 lists (the state was rescanned), the tip is confirmed
        c.round(&key, &mut |_, since| Some(chain.page(since)), &mut || (0..3).map(|i| hist.report(i, 23)).collect());
        let y = shield_body(&chain, &bob.address(), 2 * Q, "rw6-f1-y");
        chain.block(&[&y]).unwrap(); // block 24
        hist.record(&chain);
        grow(&mut chain, &mut hist, 25);
        // node 3 is two blocks behind for K rounds: left, for the next node not in bad — the liar
        for _ in 0..STRIKES {
            c.round(&key, &mut |_, since| Some(parse(&chain.page_value(since, 23))), &mut || vec![hist.report(0, 25), hist.report(1, 25), hist.report(2, 23)]);
        }
        // the liar: block 24's transaction in block 25; node 3 has caught up and agrees for 25;
        // node 2 (banned as a LISTING node, still asked for its report) is a block behind
        c.round(&key, &mut |node, since| Some(if node == 0 { shifted(&chain, since, 24) } else { chain.page(since) }), &mut || vec![hist.report(0, 25), hist.report(1, 24), hist.report(2, 25)]);
        grow(&mut chain, &mut hist, 26);
        for _ in 0..STRIKES {
            c.round(&key, &mut |node, since| Some(if node == 0 { shifted(&chain, since, 24) } else { chain.page(since) }), &mut || vec![hist.report(0, 26), hist.report(1, 24), hist.report(2, 26)]);
        }
        c.round(&key, &mut |_, since| Some(chain.page(since)), &mut || vec![hist.lie(0, 24), hist.report(1, 26), hist.report(2, 26)]);
        // the rest of the session: both honest nodes at the tip and answering; the liar serves the
        // true chain as it was at block 22
        for _ in 0..60 {
            c.round(&key, &mut |node, since| Some(if node == 0 { parse(&chain.page_value(since, 22)) } else { chain.page(since) }), &mut || vec![hist.report(1, 26), hist.report(2, 26)]);
        }
        println!(
            "rw6-f1, n = 3, after 60 more rounds with both honest nodes at the tip: banned nodes {:?}, L = node {}, stopped {:?}, confirmed {:?} (the tip is {}), {} rescans; left {:?}",
            c.banned().iter().map(|b| b + 1).collect::<Vec<_>>(), c.session.listing + 1, c.session.stopped, c.s.confirmed_height(), chain.height, c.rescans, c.left
        );
        if c.s.confirmed_height() != Some(chain.height) || c.session.listing < liars {
            failures.push(format!("n = 3: the session ends listing from node {} with {:?} banned, confirmed {:?} of {}, stopped {:?}", c.session.listing + 1, c.banned().iter().map(|b| b + 1).collect::<Vec<_>>(), c.s.confirmed_height(), chain.height, c.session.stopped));
        }
    }
    assert!(failures.is_empty(), "an honest node is banned for a lie of the node listed from BEFORE it:\n  {}", failures.join("\n  "));
}

// ---------------------------------------------------------------------------------------------------
// RW6-2 — one page stops the loop: `scan` answers `non_canonical` for a page, and the loop's rule
// for "anything else" is STOP(fault).
// ---------------------------------------------------------------------------------------------------

/// A page is the node's. `NOTES.md` §6 / §14 and the property test state that no page makes
/// `scan` answer anything but `listing:` or `rescan_required:`. A page whose `nf1` (or `nf2`, or
/// `cm_out`) is 64 lowercase hexadecimal characters that are not a canonical digest — `ff…ff` —
/// is answered with `WalletError::NonCanonical` (`non_canonical:` on the wasm surface;
/// `store.rs`, `scan_inner`: `field::digest(&nf_b[0], "nf1")?`). The loop's rule for it is the
/// rule for a fault: STOP, report a bug, keep the state, no retry — and `listed_from` is stored
/// with the state, so the next session starts at the same node and stops at the same page.
/// One lying node of three ends every session with its first answer; two honest nodes are never
/// asked for a listing.
#[test]
fn rw6_f2_a_page_with_a_digest_that_is_not_canonical_stops_the_loop_instead_of_banning_the_node() {
    let alice = keys(PHRASE_1);
    let mut chain = Chain::new();
    fund(&mut chain, &alice.address(), &[10 * Q, 6 * Q]);
    chain.advance_to(20);
    let poisoned = |since: u64, field: &str| -> ListingPage {
        let mut p = chain.page_value(since, chain.height);
        if let Some(tx) = p["txs"].as_array_mut().unwrap().first_mut() {
            match field {
                "cm_out" => tx["outputs"][0]["cm_out"] = serde_json::json!("ff".repeat(32)),
                f => tx[f] = serde_json::json!("ff".repeat(32)),
            }
        }
        parse(&p)
    };
    let mut answers = Vec::new();
    for field in ["nf1", "nf2", "cm_out"] {
        let mut s = wallet(&alice, 3, true);
        let r = s.scan(&poisoned(0, field), &alice.scan_key());
        answers.push((field, r.as_ref().map(|_| ()).map_err(|e| e.to_string()), matches!(r, Ok(_) | Err(WalletError::Listing(_)) | Err(WalletError::RescanRequired))));
    }
    // the loop, two sessions, the liar first in the list
    let mut c = Drive::new(wallet(&alice, 3, true), 0);
    let mut sessions = Vec::new();
    for _ in 0..2 {
        for _ in 0..8 {
            c.round(&alice.scan_key(), &mut |node, since| Some(if node == 0 { poisoned(since, "nf1") } else { chain.page(since) }), &mut || (1..3).map(|i| chain.report(IDS[i])).collect());
        }
        sessions.push((c.session.stopped.clone(), c.session.round, c.banned(), c.s.confirmed_height()));
        c = Drive::new(c.s.clone(), c.session.listing); // a new session: `listed_from` is what was stored
    }
    println!("rw6-f2: scan answers {answers:?}; two sessions of the loop: {sessions:?}");
    assert!(answers.iter().all(|a| a.2), "a page makes scan answer an error the loop has only the rule STOP for: {answers:?}");
    assert!(sessions.iter().all(|s| s.0.is_none() && s.3 == Some(20)), "one lying node stops the loop with one page, in every session: {sessions:?}");
    let _ = Stop::NoHonestListingNode;
}

// ---------------------------------------------------------------------------------------------------
// RW6-3 — a chain without an activation height: every honest node is banned for saying so.
// ---------------------------------------------------------------------------------------------------

/// A node whose chain has no activation height for the pool answers the listing request with
/// `{ "active": false, "tip_height": tip, "from_height": since, "next_height": since, "txs": [] }`
/// (`core/daemon/src/node.rs`, `shield_v2_notes_since`). `scan` accepts it and changes nothing;
/// the loop's step 1 calls a page that is "not active" a short page — evidence — and BANS the
/// node. Three honest nodes: three rounds, three bans, "no honest listing node reachable". That
/// is every node of mainnet until the pool is activated there, and any node that is upgraded
/// late afterwards: an honest node is banned for telling the truth.
#[test]
fn rw6_f3_an_honest_node_that_says_the_pool_is_not_active_is_banned() {
    let alice = keys(PHRASE_1);
    let inactive = |since: u64| parse(&serde_json::json!({ "active": false, "tip_height": 500, "from_height": since, "next_height": since, "txs": [] }));
    let mut c = Drive::new(wallet(&alice, 3, false), 0);
    for _ in 0..6 {
        c.round(&alice.scan_key(), &mut |_, since| Some(inactive(since)), &mut || Vec::new());
    }
    println!("rw6-f3: three honest nodes of a chain without the pool: banned {:?}, stopped {:?} after {} rounds; left {:?}", c.banned(), c.session.stopped, c.session.round, c.left);
    assert!(c.banned().is_empty(), "honest nodes are banned for answering that the pool is not active: {:?}; the loop: {:?}", c.banned(), c.session.stopped);
}
