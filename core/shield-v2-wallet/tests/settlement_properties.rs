//! The settlement rules of spec §5.5 under random interleavings (REVIEW_WALLET_2, "Resolution").
//!
//! One wallet state ("device A") is driven by a random sequence of everything that can happen to
//! it — honest pages, lying pages of five kinds, state checks with honest, lying and conflicting
//! reports, payments recorded with `mark_pending` and then mined, withheld or released late by an
//! adversary, `resolve`, `fresh_for_rescan`, a JSON round-trip, a migration from state format 1
//! or 2, and payments from a second device on the same recovery phrase — while the harness keeps
//! the TRUE chain (the stage-1 `Pool` behind the stand-in chain) and knows the fate of every
//! transaction.
//!
//! Checked after every step:
//!
//! * **I1 — no note is an input of two transactions that are unsettled or mined.** No two entries
//!   of the pending list name the same note; and when the wallet hands a note to a new
//!   transaction, no transaction it built earlier from that note is mined on the true chain or
//!   could still be mined there (not past its expiry, none of its nullifiers spent).
//! * **I2 — the confirmed balance never exceeds the true balance.** `balances().confirmed` is at
//!   most what the wallet's address really holds on the true chain at the wallet's confirmed
//!   height (and is zero without one).
//! * **I3 — a settlement is the truth.** Whatever `resolve` returns as `mined` is mined on the
//!   true chain; as `expired`, is not mined and past its expiry there; as `superseded`, is not
//!   mined and has a nullifier spent there by another transaction.
//!
//! and at the end of every run, after an honest rescan and enough blocks: nothing is pending, the
//! wallet's balance IS the true balance, and the payee holds each mined payment exactly once.
//!
//! The nodes that confirm are honest whenever they form a quorum: the liar has one id (it may
//! repeat it), which is the stated trust assumption of `confirm_state`.
#![cfg(feature = "test-vectors")]

mod common;

use std::collections::BTreeMap;

use common::*;
use quantum_vault_shield_v2::reference::MODULUS;
use quantum_vault_shield_v2_wallet::store::B32;
use quantum_vault_shield_v2_wallet::tx::deterministic;
use quantum_vault_shield_v2_wallet::*;

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// A transaction device A built and handed out, and what really became of it.
struct Built {
    body: Vec<u8>,
    nullifiers: Vec<B32>,
    outputs: Vec<B32>,
    input_cms: Vec<B32>,
    amount: u64,
    expiry: u64,
    mined: bool,
}

#[derive(Default, Debug)]
struct Stats {
    lying_pages_accepted: usize,
    diverged: usize,
    confirmed: usize,
    rescans: usize,
    migrations: [usize; 2],
    payments: usize,
    withheld: usize,
    released_late: usize,
    second_device: usize,
    settled_mined: usize,
    settled_expired: usize,
    settled_superseded: usize,
}

struct World {
    seed: u64,
    rng: Rng,
    truth: Chain,
    alice: ShieldedKeys,
    bob: ShieldedKeys,
    a: WalletState,
    built: Vec<Built>,
    /// what the second device paid Bob (mined at once)
    other_paid: u128,
    true_balance_at: BTreeMap<u64, u128>,
    counter: u64,
    stats: Stats,
}

fn report_of(w: &WalletState, id: &str) -> Option<StateReport> {
    let h = w.scanned_height()?;
    let v = w.state_at(h)?;
    Some(StateReport { node_id: id.into(), height: h, tree_root: v.tree_root, nullifier_acc: v.nullifier_acc, note_count: v.note_count, nullifier_count: v.nullifier_count })
}

fn canonical(tag: u64) -> String {
    let mut b = [0u8; 32];
    for (i, w) in b.chunks_mut(4).enumerate() {
        w.copy_from_slice(&(((tag as u32).wrapping_mul(2_654_435_761).wrapping_add(i as u32 * 7919)) % MODULUS).to_le_bytes());
    }
    hex::encode(b)
}

impl World {
    fn new(seed: u64) -> Self {
        let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
        let a = WalletState::new(alice.address().pk);
        let mut w = Self {
            seed,
            rng: Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1),
            truth: Chain::new(),
            alice,
            bob,
            a,
            built: Vec::new(),
            other_paid: 0,
            true_balance_at: BTreeMap::new(),
            counter: 0,
            stats: Stats::default(),
        };
        for v in [6 * Q, 4 * Q, 9 * Q] {
            w.fund(v);
        }
        w
    }

    fn label(&mut self, what: &str) -> String {
        self.counter += 1;
        format!("prop-{}-{}-{what}", self.seed, self.counter)
    }

    fn fund(&mut self, value: u64) {
        let key = fake_account_key(5);
        let label = self.label("fund");
        let to = self.alice.address();
        let req = ShieldRequest { ctx: self.truth.ctx(), from_pub_key: &key, nonce: 1, v_in: value + Q, fee: Q, recipient: &to, max_fee: None };
        let tx = deterministic::shield(&req, &label).unwrap();
        self.truth.block(&[&tx.body]).unwrap();
    }

    /// What Alice's address really holds after the block at `height`, every note counted.
    fn true_balance(&mut self, height: u64) -> u128 {
        if let Some(b) = self.true_balance_at.get(&height) {
            return *b;
        }
        let mut reference = WalletState::with_min_note_value(self.alice.address().pk, 1).unwrap();
        let page = ListingPage::from_json(&self.truth.page_value(0, height).to_string()).unwrap();
        reference.scan(&page, &self.alice.scan_key()).unwrap();
        let b = reference.balance();
        self.true_balance_at.insert(height, b);
        b
    }

    fn could_still_be_mined(&self, b: &Built) -> bool {
        !b.mined && self.truth.height < b.expiry && !b.nullifiers.iter().any(|n| self.truth.is_spent(&n.0))
    }

    /// The node's rule for a signer-less transaction plus the pool rules.
    fn try_mine(&mut self, i: usize) -> bool {
        if self.built[i].mined || self.truth.height + 1 > self.built[i].expiry {
            return false;
        }
        let body = self.built[i].body.clone();
        let ok = self.truth.block(&[&body]).is_ok();
        self.built[i].mined = ok;
        ok
    }

    fn scan_honest(&mut self) {
        let page = self.truth.page(self.a.next_height());
        if self.a.scan(&page, &self.alice.scan_key()).is_err() {
            // "a `listing:` error: rebuild from fresh_for_rescan against another node"
            self.rescan();
        }
    }

    fn rescan(&mut self) {
        self.a = self.a.fresh_for_rescan();
        self.stats.rescans += 1;
    }

    /// One page of a node that lies, in one of five ways. `None` when this lie has nothing to
    /// work with.
    fn lying_page(&mut self) -> Option<serde_json::Value> {
        let since = self.a.next_height();
        let mut page = self.truth.page_value(since, self.truth.height);
        let from = page["from_height"].as_u64().unwrap();
        let listed = page["txs"].as_array().unwrap().len() as u64;
        let fake_height = (self.truth.height + 1).max(from);
        let next_leaf = self.a.tree().note_count() + 2 * listed;
        let kind = self.rng.below(5);
        match kind {
            // a transaction of this wallet that the node is holding back, listed as mined
            0 => {
                let withheld: Vec<usize> = (0..self.built.len()).filter(|&i| !self.built[i].mined).collect();
                let i = *withheld.get(self.rng.below(withheld.len().max(1) as u64) as usize)?;
                page["txs"].as_array_mut().unwrap().push(listing_entry(&self.built[i].body, fake_height, 0, next_leaf));
                page["tip_height"] = serde_json::json!(fake_height);
                page["next_height"] = serde_json::json!(fake_height + 1);
            }
            // the nullifiers of a real transaction replaced (a spend hidden, a mined payment
            // made to look unmined)
            1 => {
                let n = self.rng.below(listed.max(1)) as usize;
                let tag = self.rng.next();
                let tx = page["txs"].as_array_mut().unwrap().get_mut(n)?;
                tx["nf1"] = serde_json::json!(canonical(tag));
                tx["nf2"] = serde_json::json!(canonical(tag ^ 0x5555));
            }
            // "the chain is already far past your expiry height"
            2 => {
                let tip = self.truth.height.max(from) + 1 + self.rng.below(300);
                page["tip_height"] = serde_json::json!(tip);
                page["next_height"] = serde_json::json!(tip + 1);
            }
            // the last transaction left out
            3 => {
                page["txs"].as_array_mut().unwrap().pop()?;
            }
            // a payment to this wallet that is on no chain
            _ => {
                let key = fake_account_key(6);
                let label = self.label("forged");
                let to = self.alice.address();
                let req = ShieldRequest { ctx: self.truth.ctx(), from_pub_key: &key, nonce: 1, v_in: 50 * Q, fee: Q, recipient: &to, max_fee: None };
                let tx = deterministic::shield(&req, &label).unwrap();
                page["txs"].as_array_mut().unwrap().push(listing_entry(&tx.body, fake_height, 0, next_leaf));
                page["tip_height"] = serde_json::json!(fake_height);
                page["next_height"] = serde_json::json!(fake_height + 1);
            }
        }
        Some(page)
    }

    fn scan_lying(&mut self) {
        let Some(page) = self.lying_page() else { return };
        let page = ListingPage::from_json(&page.to_string()).unwrap();
        if self.a.scan(&page, &self.alice.scan_key()).is_ok() {
            self.stats.lying_pages_accepted += 1;
        }
    }

    fn confirm(&mut self, reports: &[StateReport]) {
        let c = self.a.confirm_state(reports, None).unwrap();
        self.stats.diverged += c.diverged as usize;
        self.stats.confirmed += c.matched_height.is_some() as usize;
        assert!(!(c.diverged && c.matched_height.is_some()), "seed {}: confirmed in a call that diverged", self.seed);
    }

    fn honest_reports(&self) -> Vec<StateReport> {
        vec![self.truth.report("honest-1"), self.truth.report("honest-2")]
    }

    fn pay(&mut self) {
        let Some(scanned) = self.a.scanned_height() else { return };
        let amount = [Q, 2 * Q, 3 * Q][self.rng.below(3) as usize];
        let Ok(sel) = select_inputs(&self.a, amount, Q) else { return };
        let inputs: Vec<SpendInput> = sel.positions.iter().map(|&p| self.a.spend_input(p).expect("a selected note is confirmed and unlocked")).collect();
        let label = self.label("pay");
        let to = self.bob.address();
        let req = TransferRequest { ctx: TxContext::new(CHAIN, self.a.anchor(), scanned), keys: &self.alice, inputs: &inputs, recipient: &to, amount, fee: Q, max_fee: None };
        let tx = deterministic::transfer(&req, &label).unwrap();
        let record = tx.pending().unwrap();
        let input_cms: Vec<B32> = sel.positions.iter().map(|&p| self.a.note_at(p).unwrap().cm).collect();
        // I1: nothing this wallet built earlier from one of these notes is mined or can still be
        for b in self.built.iter().filter(|b| b.input_cms.iter().any(|c| input_cms.contains(c))) {
            assert!(!b.mined, "seed {}: a note spent by a MINED transaction of this wallet is spent again", self.seed);
            assert!(!self.could_still_be_mined(b), "seed {}: a note is handed out again while an earlier transaction from it can still be mined", self.seed);
        }
        if self.a.mark_pending(record.clone()).is_err() {
            return; // the pending list is full: nothing left the wallet
        }
        self.built.push(Built { body: tx.body.clone(), nullifiers: record.nullifiers.clone(), outputs: record.outputs.clone(), input_cms, amount, expiry: record.expiry_height, mined: false });
        self.stats.payments += 1;
        // submitted: the node mines it at once, or keeps it
        if self.rng.below(2) == 0 {
            let i = self.built.len() - 1;
            self.try_mine(i);
        } else {
            self.stats.withheld += 1;
        }
    }

    fn release_late(&mut self) {
        let withheld: Vec<usize> = (0..self.built.len()).filter(|&i| !self.built[i].mined).collect();
        if let Some(&i) = withheld.get(self.rng.below(withheld.len().max(1) as u64) as usize) {
            self.stats.released_late += self.try_mine(i) as usize;
        }
    }

    /// The same recovery phrase on another device, which knows nothing of A's locks.
    fn second_device_pays(&mut self) {
        let mut b = WalletState::new(self.alice.address().pk);
        b.scan(&self.truth.page(0), &self.alice.scan_key()).unwrap();
        let amount = [Q, 2 * Q][self.rng.below(2) as usize];
        let Ok(sel) = select_inputs_with(&b, amount, Q, true) else { return };
        let inputs: Vec<SpendInput> = sel.positions.iter().map(|&p| b.spend_input_with(p, true).unwrap()).collect();
        let label = self.label("device-b");
        let to = self.bob.address();
        let req = TransferRequest { ctx: TxContext::new(CHAIN, b.anchor(), self.truth.height), keys: &self.alice, inputs: &inputs, recipient: &to, amount, fee: Q, max_fee: None };
        let tx = deterministic::transfer(&req, &label).unwrap();
        self.truth.block(&[&tx.body]).expect("device B is in sync with the true chain");
        self.other_paid += amount as u128;
        self.stats.second_device += 1;
    }

    /// The transactions this wallet built that a settled entry can stand for. An entry names
    /// exactly one — by its nullifier pair AND its outputs (two transactions from the same two
    /// notes have the same pair), or by its pair and its change commitment after a migration from
    /// format 2. A lock migrated from format 1 knows one nullifier only: every transaction built
    /// from that note.
    fn built_for(&self, p: &PendingTx) -> Vec<usize> {
        let found: Vec<usize> = (0..self.built.len())
            .filter(|&i| {
                let b = &self.built[i];
                if p.legacy {
                    p.nullifiers.iter().any(|n| b.nullifiers.contains(n))
                } else if p.outputs.is_empty() {
                    b.nullifiers == p.nullifiers && p.change.as_ref().is_some_and(|c| b.outputs.contains(&c.cm))
                } else {
                    b.nullifiers == p.nullifiers && b.outputs == p.outputs
                }
            })
            .collect();
        assert!(!found.is_empty() && (p.legacy || found.len() == 1), "seed {}: a settled entry is one transaction this wallet built", self.seed);
        found
    }

    fn resolve(&mut self) {
        let r = self.a.resolve();
        let seed = self.seed;
        // I3
        for p in &r.mined {
            let i = self.built_for(p)[0];
            assert!(self.built[i].mined, "seed {seed}: settled as mined, and it is not on the true chain");
            self.stats.settled_mined += 1;
        }
        for p in &r.expired {
            for i in self.built_for(p) {
                let b = &self.built[i];
                assert!(!b.mined, "seed {seed}: a MINED transaction was settled as expired");
                assert!(self.truth.height >= b.expiry, "seed {seed}: settled as expired while the true chain can still mine it (height {}, expiry {})", self.truth.height, b.expiry);
            }
            self.stats.settled_expired += 1;
        }
        for p in &r.superseded {
            let found = self.built_for(p);
            assert!(p.nullifiers.iter().any(|n| self.truth.is_spent(&n.0)), "seed {seed}: settled as superseded and none of its nullifiers is spent");
            // a lock migrated from format 1 does not know its transaction: "its input was spent"
            assert!(p.legacy || !self.built[found[0]].mined, "seed {seed}: a MINED transaction was settled as superseded");
            self.stats.settled_superseded += 1;
        }
    }

    /// The state written back in an older format (as that format would have held it) and read
    /// again: the migration to format 3.
    fn migrate(&mut self) {
        let a = &self.a;
        let frontier: Vec<String> = WalletState::new(a.pk()).tree().frontier().iter().map(hex::encode).collect();
        let tree = serde_json::json!({ "note_count": 0, "frontier": frontier, "root": hex::encode(WalletState::new(a.pk()).anchor()), "witnesses": {} });
        let note = |n: &OwnedNote, locally_spent: bool| {
            serde_json::json!({
                "value": n.value.to_string(), "r": n.r, "rho": n.rho, "position": n.position, "cm": n.cm, "nullifier": n.nullifier,
                "spent": n.spent || locally_spent, "spent_height": n.spent_height, "height": n.height, "tx_hash": n.tx_hash, "output_index": n.output_index,
            })
        };
        // format 1 knew a lock only as a note it had marked spent itself: it can hold this state
        // only if every pending entry is untouched and has its notes
        let as_v1 = self.rng.below(2) == 0
            && a.pending().iter().all(|p| p.status == PendingStatus::Pending && !p.input_cms.is_empty() && p.input_cms.iter().all(|c| a.unspent().any(|n| n.cm == *c)));
        let json = if as_v1 {
            let locked = |n: &OwnedNote| a.is_locked(n.position);
            serde_json::json!({ "version": 1, "pk": hex::encode(a.pk()), "next_height": a.next_height(), "tree": tree,
                "notes": a.notes().iter().map(|n| note(n, locked(n))).collect::<Vec<_>>() })
        } else {
            let pending: Vec<serde_json::Value> = a
                .pending()
                .iter()
                .filter(|p| !p.legacy)
                .map(|p| {
                    serde_json::json!({
                        "tx_type": p.tx_type, "nullifiers": p.nullifiers, "inputs": p.inputs, "input_total": p.input_total.to_string(),
                        "change": p.change.as_ref().map(|c| serde_json::json!({ "cm": c.cm, "value": c.value.to_string() })),
                        "expiry_height": p.expiry_height, "status": if p.status == PendingStatus::SeenMined { "mined" } else { "pending" },
                        "mined_height": p.seen_height.filter(|_| p.status == PendingStatus::SeenMined), "rejected_hint": p.rejected_hint,
                    })
                })
                .collect();
            if a.pending().iter().any(|p| p.legacy) {
                return; // a legacy lock has no format-2 form that this harness could write back
            }
            serde_json::json!({ "version": 2, "pk": hex::encode(a.pk()), "next_height": a.next_height(), "tree": tree,
                "notes": a.notes().iter().map(|n| note(n, false)).collect::<Vec<_>>(), "pending": pending,
                "checkpoints": [], "confirmed_height": a.confirmed_height(), "blind": { "seen": [], "overflow": false } })
        };
        let before = a.pending().to_vec();
        let held: Vec<B32> = a.notes().iter().map(|n| n.cm).collect();
        self.a = WalletState::from_json(&json.to_string()).expect("an older format is migrated");
        let after = self.a.pending();
        for p in &before {
            // every lock is kept: by the note's commitment where the old state held the note
            // (format 2 in the middle of a rescan held the entry without it: by position, as then)
            for (i, c) in p.input_cms.iter().enumerate() {
                let kept = after.iter().any(|q| q.input_cms.contains(c) || (!held.contains(c) && q.input_cms.is_empty() && q.inputs.contains(&p.inputs[i])));
                assert!(kept, "seed {}: the migration lost a lock", self.seed);
            }
        }
        // format 1 had one lock per note, the later formats one entry per transaction
        assert!(as_v1 || after.len() == before.len(), "seed {}: the migration kept every entry", self.seed);
        assert!(self.a.pending().iter().all(|p| p.status == PendingStatus::Pending));
        self.stats.migrations[as_v1 as usize] += 1;
    }

    fn check(&mut self, step: &str) {
        let seed = self.seed;
        // I1 (first half): no note is an input of two unsettled transactions
        let pending = self.a.pending();
        for (i, p) in pending.iter().enumerate() {
            for q in &pending[i + 1..] {
                assert!(!p.input_cms.iter().any(|c| q.input_cms.contains(c)), "seed {seed} after {step}: two pending entries spend one note");
            }
        }
        // every input of an unsettled entry that the state holds is locked, and not selectable
        for p in pending {
            for n in self.a.notes().iter().filter(|n| p.input_cms.contains(&n.cm)) {
                assert!(self.a.is_locked(n.position), "seed {seed} after {step}: an input of a pending entry is not locked");
            }
        }
        // I2
        let b = self.a.balances();
        assert!(b.spendable <= b.confirmed && b.locked <= b.confirmed + b.unverified);
        match self.a.confirmed_height() {
            None => assert_eq!(b.confirmed, 0, "seed {seed} after {step}: a confirmed balance without a confirmed height"),
            Some(h) => {
                assert!(h <= self.truth.height, "seed {seed} after {step}: a height was confirmed that the true chain has not reached");
                let truth = self.true_balance(h);
                assert!(b.confirmed <= truth, "seed {seed} after {step}: confirmed balance {} exceeds the true balance {truth} at height {h}", b.confirmed);
            }
        }
        // the state the wallet would persist is one it reads back
        if self.rng.below(8) == 0 {
            let back = WalletState::from_json(&self.a.to_json().unwrap()).expect("to_json writes what from_json reads");
            assert_eq!(back, self.a, "seed {seed} after {step}");
        }
    }

    fn step(&mut self) -> &'static str {
        match self.rng.below(100) {
            0..=7 => {
                let v = [Q / 2, Q, 2 * Q, 5 * Q, 9 * Q][self.rng.below(5) as usize];
                self.fund(v);
                "fund"
            }
            8..=17 => {
                let to = self.truth.height + 1 + self.rng.below(30);
                self.truth.advance_to(to);
                "advance"
            }
            18..=37 => {
                self.scan_honest();
                "scan honest page"
            }
            38..=45 => {
                self.scan_lying();
                "scan lying page"
            }
            46..=59 => {
                let r = self.honest_reports();
                self.confirm(&r);
                "confirm, honest reports"
            }
            60..=62 => {
                if let Some(lie) = report_of(&self.a, "the-liar") {
                    self.confirm(&[lie.clone(), lie]);
                }
                "confirm, lying reports"
            }
            63..=67 => {
                if let Some(lie) = report_of(&self.a, "the-liar") {
                    let mut r = self.honest_reports();
                    if self.rng.below(2) == 0 {
                        r.pop();
                    }
                    r.push(lie);
                    self.confirm(&r);
                }
                "confirm, conflicting reports"
            }
            68..=79 => {
                self.pay();
                "mark_pending"
            }
            80..=84 => {
                self.release_late();
                "the node releases a withheld transaction"
            }
            85..=92 => {
                self.resolve();
                "resolve"
            }
            93..=94 => {
                self.rescan();
                "fresh_for_rescan"
            }
            95..=96 => {
                self.migrate();
                "migrate"
            }
            _ => {
                self.second_device_pays();
                "two-device spend"
            }
        }
    }

    /// The end of a run: an honest rescan, enough blocks for every expiry, and the books closed.
    fn close(&mut self) {
        self.rescan();
        self.scan_honest();
        let last_expiry = self.built.iter().map(|b| b.expiry).chain(self.a.pending().iter().map(|p| p.expiry_height)).max().unwrap_or(0);
        self.truth.advance_to(self.truth.height.max(last_expiry) + 1);
        self.scan_honest();
        let r = self.honest_reports();
        self.confirm(&r);
        self.resolve();
        self.check("the closing rescan");
        let seed = self.seed;
        assert!(self.a.pending().is_empty(), "seed {seed}: every transaction is settled once its expiry is confirmed");
        assert_eq!(self.a.confirmed_height(), Some(self.truth.height));
        // the wallet's balance IS the true balance (the same minimum note value on both sides)
        let mut reference = WalletState::new(self.alice.address().pk);
        reference.scan(&self.truth.page(0), &self.alice.scan_key()).unwrap();
        assert_eq!((self.a.balance(), self.a.balances().confirmed, self.a.balances().locked), (reference.balance(), reference.balance(), 0), "seed {seed}");
        // every payment Bob holds is one that was made, once
        let mut bob = WalletState::new(self.bob.address().pk);
        bob.scan(&self.truth.page(0), &self.bob.scan_key()).unwrap();
        let paid: u128 = self.built.iter().filter(|b| b.mined).map(|b| b.amount as u128).sum();
        assert_eq!(bob.balance(), paid + self.other_paid, "seed {seed}: the payee holds each mined payment exactly once");
    }
}

#[test]
fn settlement_invariants_hold_over_random_interleavings() {
    let mut total = Stats::default();
    for seed in 1..=40u64 {
        let mut w = World::new(seed);
        w.scan_honest();
        let r = w.honest_reports();
        w.confirm(&r);
        for _ in 0..260 {
            let step = w.step();
            w.check(step);
        }
        w.close();
        let s = &w.stats;
        total.lying_pages_accepted += s.lying_pages_accepted;
        total.diverged += s.diverged;
        total.confirmed += s.confirmed;
        total.rescans += s.rescans;
        total.migrations[0] += s.migrations[0];
        total.migrations[1] += s.migrations[1];
        total.payments += s.payments;
        total.withheld += s.withheld;
        total.released_late += s.released_late;
        total.second_device += s.second_device;
        total.settled_mined += s.settled_mined;
        total.settled_expired += s.settled_expired;
        total.settled_superseded += s.settled_superseded;
    }
    println!("settlement properties over 40 runs of 260 steps: {total:?}");
    // the runs did exercise what the invariants are about
    assert!(total.lying_pages_accepted > 40 && total.diverged > 40 && total.confirmed > 200, "{total:?}");
    assert!(total.payments > 100 && total.withheld > 40 && total.released_late > 5 && total.second_device > 10, "{total:?}");
    assert!(total.settled_mined > 20 && total.settled_expired > 5 && total.settled_superseded > 0, "{total:?}");
    assert!(total.migrations[0] > 5 && total.migrations[1] > 5 && total.rescans > 40, "{total:?}");
}
