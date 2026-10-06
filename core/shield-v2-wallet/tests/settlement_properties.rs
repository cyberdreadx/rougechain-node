//! The guarantees of spec §5.4 / §5.5 under random interleavings, against an INDEPENDENT model
//! (REVIEW_WALLET_3, "the property test shares the code's blind spots").
//!
//! **The oracle is not the code under test.** [`RefChain`] is a small reference chain written
//! here: its own nullifier set, its own running hashes (SHA-256 with the tags written out in this
//! file), its own anchor window and expiry rule, its own tree (the stage-1 crate's `SparseTree`,
//! not the wallet's tracker), read from the transaction body at the byte offsets of spec §3.2 —
//! and **its own books of who owns what**: every note is entered by the party that MADE the
//! transaction (value and owner), never found by scanning or decrypting. The true balance of a
//! wallet at a height is a sum over those books. The stage-1 `Pool` (the consensus rules) runs
//! beside it as a cross-check of the model, block by block.
//!
//! **The world.** 3 to 7 configured nodes; a random strict minority of them is one adversary that
//! also controls a hostile sender and every transaction submitted to it. It can:
//! contradict correct values, vouch for whatever the wallet has been made to believe, replay
//! stale reports (under their own or a newer height), inflate tips, equivocate, stay silent;
//! serve listings with forged payments, hidden transactions, replaced or regrouped nullifiers,
//! shifted heights, shifted leaf positions, blanked or swapped ciphertexts, truncated pages;
//! withhold submitted transactions and release them at any later time — after very long delays,
//! or in the very last block that can hold them; send dust,
//! cap-filling notes and notes whose ciphertext does not open their commitment. Besides: a second
//! device on the same recovery phrase, crashes between any two calls (the client loses the state
//! a call returned), restores from the phrase, migrations from state formats 1, 2 and 3.
//!
//! Honest nodes may be unreachable — any number of them, outside the settlement windows: safety
//! does not depend on anybody answering.
//!
//! **The client** follows the documented rules and nothing else — and where the rules leave it a
//! choice it sometimes makes the careless one: it hands `confirm_state` only the reports that
//! agree with it ("drop the nodes that conflict"), and one payment in five it explicitly allows
//! unverified inputs. Otherwise: persist the returned state,
//! then submit; retry a payment only after `resolve` said it expired or was superseded; on
//! `listing_refuted` (or a `listing:` error) rescan against the next node; if the state check
//! does not reach the height a quorum reports, list from the next node; after a restore make no
//! payment until 128 blocks above the first confirmed height are confirmed (spec §5.5).
//!
//! **Checked**, after every step and at the end of every run:
//!
//! * **G1 — no double payment by the wallet's own behaviour.** Every payment the user asked for
//!   is mined at most once, although it is retried whenever the wallet says the last attempt is
//!   dead; no note is handed to a new transaction while an earlier one of this device from that
//!   note is mined or can still be mined; whatever `resolve` returns is the truth (`mined` is on
//!   the chain, `expired` and `superseded` are not and never can be).
//! * **G2 — the confirmed balance never exceeds the true balance** at the confirmed height, and
//!   the confirmed height is one the chain has reached.
//! * **G3 — bounded-time settlement.** Every transaction this version builds has
//!   `expiry_height ≤ (the TRUE height at the build) + 128`. And whenever the honest majority is
//!   reachable, the client's documented loop ends — within `2·nodes + 4` rounds, the liars lying
//!   throughout — with nothing pending, nothing locked, the confirmed height at the tip and the
//!   confirmed balance EQUAL to the true balance (less only what the documented policies leave
//!   out: strangers' dust, and notes beyond the cap in a cap-filling run, which a rescan with a
//!   higher cap then recovers).
//! * **G4 — a lying or unreachable minority causes delay only**: the same loop, the same bound.
#![cfg(feature = "test-vectors")]

mod common;

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use common::{fake_account_key, keys, A, CHAIN, PHRASE_1, PHRASE_2, Q};
use quantum_vault_shield_v2::pool::{MemoryPoolStore, Pool, PoolTx, TxKind as PoolKind};
use quantum_vault_shield_v2::reference::{derive_rho, digest_from_bytes, digest_to_bytes, nullifier, Digest, SparseTree, MODULUS};
use quantum_vault_shield_v2_wallet::note_enc::encrypt_note_with_kem_randomness;
use quantum_vault_shield_v2_wallet::store::B32;
use quantum_vault_shield_v2_wallet::tx::{deterministic, UnprovenTx};
use quantum_vault_shield_v2_wallet::*;
use sha2::{Digest as _, Sha256};

// ---- spec §3.2 as byte offsets, and the two running hashes, written out independently ---------------

const OFF_KIND: usize = 1;
const OFF_EXPIRY: usize = 34;
const OFF_ANCHOR: usize = 42;
const OFF_NF: usize = 74;
const OFF_CM: usize = 138;
const OFF_V_IN: usize = 202;
const OFF_ACCOUNT: usize = 226;
const OFF_KEM: [usize; 2] = [258, 1_402];
const OFF_NOTE: [usize; 2] = [1_346, 2_490];
const KEM: usize = 1_088;
const NOTE: usize = 56;
const ANCHOR_WINDOW: usize = 128;
/// The bound of spec §5.5: `expiry_height ≤ confirmed height + 128`.
const EXPIRY_BOUND: u64 = 128;
/// How far an honest node can be behind the tip in this world.
const HONEST_LAG: u64 = 2;

fn b32(b: &[u8]) -> [u8; 32] {
    b.try_into().unwrap()
}
fn le64(b: &[u8]) -> u64 {
    u64::from_le_bytes(b.try_into().unwrap())
}
fn sha(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Who {
    Alice,
    Bob,
}

/// A transaction and what its MAKER knows of its two outputs: owner, value, and whether the maker
/// is somebody else than the owner (`stranger`). This is where the oracle's books come from.
#[derive(Clone)]
struct Tx {
    body: Vec<u8>,
    outs: [Option<(Who, u64, bool)>; 2],
}

impl Tx {
    fn id(&self) -> [u8; 32] {
        sha(&[&self.body])
    }
    fn nf(&self, i: usize) -> [u8; 32] {
        b32(&self.body[OFF_NF + 32 * i..OFF_NF + 32 * i + 32])
    }
    fn cm(&self, j: usize) -> [u8; 32] {
        b32(&self.body[OFF_CM + 32 * j..OFF_CM + 32 * j + 32])
    }
    fn expiry(&self) -> u64 {
        le64(&self.body[OFF_EXPIRY..OFF_EXPIRY + 8])
    }
    fn anchor(&self) -> [u8; 32] {
        b32(&self.body[OFF_ANCHOR..OFF_ANCHOR + 32])
    }
    /// From what the wallet's assembly recorded about the outputs it made.
    fn of(tx: &UnprovenTx, payee: Who, sender: Option<Who>) -> Self {
        let mut outs = [None, None];
        for o in &tx.outputs {
            outs[o.slot] = match o.role {
                OutputRole::Payment => Some((payee, o.value, sender != Some(payee))),
                OutputRole::Change => sender.map(|s| (s, o.value, false)),
                OutputRole::Dummy => None,
            };
        }
        Self { body: tx.body.clone(), outs }
    }
}

/// The pool state after a block: what an honest node reports.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Snap {
    root: [u8; 32],
    nf_acc: [u8; 32],
    ct_acc: [u8; 32],
    notes: u64,
    nfs: u64,
}

struct TrueNote {
    owner: Who,
    cm: [u8; 32],
    value: u64,
    stranger: bool,
    created: u64,
    spent: Option<u64>,
}

/// The reference chain. Its rules for a V2 transaction in block `h`: `expiry_height ≥ h`; the
/// anchor is the root after one of the last 128 blocks; neither nullifier was seen before.
struct RefChain {
    height: u64,
    tree: SparseTree,
    snap: Snap,
    spent: BTreeSet<[u8; 32]>,
    window: VecDeque<[u8; 32]>,
    /// the state after height `h`, recorded at the heights where it changed
    history: BTreeMap<u64, Snap>,
    /// (height, index in block, first leaf, body)
    listed: Vec<(u64, u64, u64, Vec<u8>)>,
    mined: BTreeSet<[u8; 32]>,
    notes: Vec<TrueNote>,
    note_by_nf: BTreeMap<[u8; 32], usize>,
    nk: [Digest; 2],
    alice_unspent_peak: usize,
    /// the stage-1 consensus rules, as a cross-check of this model
    pool: Pool<MemoryPoolStore>,
}

impl RefChain {
    fn new(nk_alice: [u8; 32], nk_bob: [u8; 32]) -> Self {
        let tree = SparseTree::new();
        let snap = Snap { root: digest_to_bytes(&tree.root()), nf_acc: [0u8; 32], ct_acc: [0u8; 32], notes: 0, nfs: 0 };
        Self {
            height: A - 1,
            tree,
            snap,
            spent: BTreeSet::new(),
            window: VecDeque::from([snap.root]),
            history: BTreeMap::from([(A - 1, snap)]),
            listed: Vec::new(),
            mined: BTreeSet::new(),
            notes: Vec::new(),
            note_by_nf: BTreeMap::new(),
            nk: [digest_from_bytes(&nk_alice).unwrap(), digest_from_bytes(&nk_bob).unwrap()],
            alice_unspent_peak: 0,
            pool: Pool::open_or_init(MemoryPoolStore::new(), A).unwrap(),
        }
    }

    fn pool_tx(tx: &Tx) -> PoolTx {
        let b = &tx.body;
        PoolTx {
            kind: match b[OFF_KIND] {
                1 => PoolKind::Shield,
                2 => PoolKind::Transfer,
                _ => PoolKind::Unshield,
            },
            anchor: tx.anchor(),
            nf: [tx.nf(0), tx.nf(1)],
            cm_out: [tx.cm(0), tx.cm(1)],
            v_in: le64(&b[OFF_V_IN..OFF_V_IN + 8]),
            v_out: le64(&b[OFF_V_IN + 8..OFF_V_IN + 16]),
            fee: le64(&b[OFF_V_IN + 16..OFF_V_IN + 24]),
            account: b32(&b[OFF_ACCOUNT..OFF_ACCOUNT + 32]),
        }
    }

    /// Would the block at the next height accept this transaction?
    fn acceptable(&self, tx: &Tx) -> bool {
        tx.expiry() >= self.height + 1 && self.window.contains(&tx.anchor()) && !self.spent.contains(&tx.nf(0)) && !self.spent.contains(&tx.nf(1)) && tx.nf(0) != tx.nf(1)
    }

    /// Could it be accepted by SOME later block? (Not mined, not past its expiry, no nullifier
    /// spent. The anchor window is ignored: this errs on the side of "still alive".)
    fn can_still_be_mined(&self, tx: &Tx) -> bool {
        !self.mined.contains(&tx.id()) && tx.expiry() > self.height && !self.spent.contains(&tx.nf(0)) && !self.spent.contains(&tx.nf(1))
    }

    fn is_mined(&self, tx: &Tx) -> bool {
        self.mined.contains(&tx.id())
    }

    /// The commitment of the note this nullifier spends, from the books (`None`: a dummy input,
    /// or a note that is on no chain).
    fn note_spent_by(&self, nf: &[u8; 32]) -> Option<[u8; 32]> {
        self.note_by_nf.get(nf).map(|&i| self.notes[i].cm)
    }

    /// One block with at most one V2 transaction. `false`: the transaction was refused and the
    /// block is empty.
    fn block(&mut self, tx: Option<&Tx>) -> bool {
        let h = self.height + 1;
        let accepted = tx.filter(|t| self.acceptable(t));
        let pool_txs: Vec<PoolTx> = accepted.iter().map(|t| Self::pool_tx(t)).collect();
        if let (Some(t), None) = (tx, accepted) {
            if t.expiry() >= h {
                assert!(self.pool.validate_block(h, &[Self::pool_tx(t)]).is_err(), "the model refuses what the consensus rules accept");
            }
        }
        self.pool.apply_block(h, &pool_txs).expect("the consensus rules accept what the model accepts");
        if let Some(t) = accepted {
            let first_leaf = self.snap.notes;
            let nfd = [digest_from_bytes(&t.nf(0)).unwrap(), digest_from_bytes(&t.nf(1)).unwrap()];
            for i in 0..2 {
                let nf = t.nf(i);
                self.spent.insert(nf);
                self.snap.nf_acc = sha(&[b"rougechain.shield_v2.nullifier_acc.v1", &self.snap.nf_acc, &nf]);
                self.snap.nfs += 1;
                if let Some(&n) = self.note_by_nf.get(&nf) {
                    assert!(self.notes[n].spent.is_none());
                    self.notes[n].spent = Some(h);
                }
            }
            for j in 0..2 {
                let cm = t.cm(j);
                self.tree.insert(self.snap.notes as u32, digest_from_bytes(&cm).unwrap());
                self.snap.notes += 1;
                self.snap.ct_acc = sha(&[
                    b"rougechain.shield_v2.ciphertext_acc.node_local.v1",
                    &self.snap.ct_acc,
                    &cm,
                    &t.body[OFF_KEM[j]..OFF_KEM[j] + KEM],
                    &t.body[OFF_NOTE[j]..OFF_NOTE[j] + NOTE],
                ]);
                if let Some((owner, value, stranger)) = t.outs[j].filter(|o| o.1 > 0) {
                    let own_nf = digest_to_bytes(&nullifier(&self.nk[owner as usize], &derive_rho(&nfd, j)));
                    self.note_by_nf.insert(own_nf, self.notes.len());
                    self.notes.push(TrueNote { owner, cm, value, stranger, created: h, spent: None });
                }
            }
            self.snap.root = digest_to_bytes(&self.tree.root());
            self.listed.push((h, 0, first_leaf, t.body.clone()));
            self.mined.insert(t.id());
            self.history.insert(h, self.snap);
            let p = self.pool.state().unwrap();
            assert_eq!((p.tree_root, p.nullifier_acc, p.note_count, p.nullifier_count), (self.snap.root, self.snap.nf_acc, self.snap.notes, self.snap.nfs), "the model's state is the consensus state");
            self.alice_unspent_peak = self.alice_unspent_peak.max(self.notes.iter().filter(|n| n.owner == Who::Alice && n.spent.is_none()).count());
        }
        self.window.push_back(self.snap.root);
        if self.window.len() > ANCHOR_WINDOW {
            self.window.pop_front();
        }
        self.height = h;
        accepted.is_some()
    }

    fn advance_to(&mut self, height: u64) {
        while self.height < height {
            self.block(None);
        }
    }

    fn state_at(&self, height: u64) -> Snap {
        *self.history.range(..=height.max(A - 1)).next_back().unwrap().1
    }

    /// What `who` really holds after the block at `height`: from the books, not from any scan.
    fn balance(&self, who: Who, height: u64) -> u128 {
        self.unspent_at(who, height).map(|n| n.value as u128).sum()
    }

    fn unspent_at(&self, who: Who, height: u64) -> impl Iterator<Item = &TrueNote> {
        self.notes.iter().filter(move |n| n.owner == who && n.created <= height && n.spent.is_none_or(|s| s > height))
    }

    fn entry(body: &[u8], height: u64, index: u64, first_leaf: u64) -> serde_json::Value {
        let out = |j: usize| {
            serde_json::json!({
                "cm_out": hex::encode(&body[OFF_CM + 32 * j..OFF_CM + 32 * j + 32]), "leaf": first_leaf + j as u64,
                "kem_ct": hex::encode(&body[OFF_KEM[j]..OFF_KEM[j] + KEM]), "note_ct": hex::encode(&body[OFF_NOTE[j]..OFF_NOTE[j] + NOTE]),
            })
        };
        let tx_type = ["", "shield_v2", "shielded_transfer_v2", "unshield_v2"][body[OFF_KIND] as usize];
        serde_json::json!({
            "height": height, "index": index, "tx_hash": hex::encode(sha(&[body])), "tx_type": tx_type,
            "nf1": hex::encode(&body[OFF_NF..OFF_NF + 32]), "nf2": hex::encode(&body[OFF_NF + 32..OFF_NF + 64]), "outputs": [out(0), out(1)],
        })
    }

    /// The listing an honest node whose tip is `until` answers for `since`.
    fn page(&self, since: u64, until: u64) -> serde_json::Value {
        let start = since.max(A);
        let until = until.min(self.height);
        let txs: Vec<serde_json::Value> = self.listed.iter().filter(|t| (start..=until).contains(&t.0)).map(|t| Self::entry(&t.3, t.0, t.1, t.2)).collect();
        serde_json::json!({ "active": true, "tip_height": until, "from_height": start, "next_height": (until + 1).max(start), "txs": txs })
    }

    fn report(&self, node_id: &str, height: u64) -> StateReport {
        report_of(node_id, height, self.state_at(height))
    }
}

fn report_of(node_id: &str, height: u64, s: Snap) -> StateReport {
    StateReport { node_id: node_id.into(), height, tree_root: s.root, nullifier_acc: s.nf_acc, note_count: s.notes, nullifier_count: s.nfs, ciphertext_acc: s.ct_acc }
}

fn echo_of(w: &WalletState, node_id: &str, height: u64) -> Option<StateReport> {
    let v = w.state_at(height)?;
    Some(StateReport { node_id: node_id.into(), height, tree_root: v.tree_root, nullifier_acc: v.nullifier_acc, note_count: v.note_count, nullifier_count: v.nullifier_count, ciphertext_acc: v.ciphertext_acc })
}

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
    fn pick<T: Copy>(&mut self, v: &[T]) -> Option<T> {
        (!v.is_empty()).then(|| v[self.below(v.len() as u64) as usize])
    }
}

fn canonical(tag: u64) -> [u8; 32] {
    let h = sha(&[&tag.to_le_bytes()]);
    let mut b = [0u8; 32];
    for (w, s) in b.chunks_mut(4).zip(h.chunks(4)) {
        w.copy_from_slice(&(u32::from_le_bytes(s.try_into().unwrap()) % MODULUS).to_le_bytes());
    }
    b
}

// ---- the user, the device, the adversary ---------------------------------------------------------------

/// One transaction device A built for a payment.
struct Attempt {
    tx: Tx,
    nullifiers: Vec<B32>,
    outputs: Vec<B32>,
    input_cms: Vec<B32>,
    intent: usize,
    /// this device's state lineage still holds the entry (false after a restore from the phrase)
    known: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum IntentState {
    /// an attempt is out and the wallet has not said what became of it
    Open,
    /// the wallet said: mined
    Paid,
    /// the wallet said: the last attempt is dead (or it never left the device) — retry
    Failed,
    /// the device was restored while an attempt was out: nothing is retried before the embargo ends
    Unknown,
}

struct Intent {
    amount: u64,
    state: IntentState,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Embargo {
    None,
    /// restored: waiting for the first confirmed height
    AwaitConfirm,
    /// no payment before this height is confirmed
    Until(u64),
}

#[derive(Default, Debug)]
struct Stats {
    lying_pages: usize,
    lying_pages_accepted: usize,
    confirm_calls: usize,
    matched: usize,
    matched_with_dissent: usize,
    refuted: usize,
    ahead: usize,
    rotations: usize,
    rescans: usize,
    states_lost: usize,
    migrations: [usize; 3],
    restores: usize,
    embargo_ended: usize,
    payments: usize,
    retries: usize,
    two_input_payments: usize,
    withheld: usize,
    unsubmitted: usize,
    released_late: usize,
    released_last_block: usize,
    release_refused: usize,
    unverified_payments: usize,
    reports_dropped: usize,
    honest_silent: usize,
    own_outputs_blanked: usize,
    leaves_shifted: usize,
    second_device: usize,
    second_device_same_inputs: usize,
    hostile_notes: usize,
    settled_mined: usize,
    settled_expired: usize,
    settled_superseded: usize,
    drives: usize,
    drive_rounds_max: usize,
    cap_checked: usize,
    cap_recovered: usize,
    liars: usize,
    nodes: usize,
}

struct World {
    seed: u64,
    rng: Rng,
    chain: RefChain,
    alice: ShieldedKeys,
    bob: ShieldedKeys,
    nodes: Vec<String>,
    liar: Vec<bool>,
    min_note: u64,
    cap: usize,
    cap_attack: bool,
    /// what device A has in its storage
    stored: WalletState,
    /// the node it lists from
    listing: usize,
    embargo: Embargo,
    intents: Vec<Intent>,
    attempts: Vec<Attempt>,
    /// submitted to a lying node and not mined (yet)
    withheld: Vec<usize>,
    /// what the second device paid Bob
    other_paid: u128,
    /// the client does not crash while the settlement bound is being measured (a crash is the
    /// client's own delay, not the adversary's)
    no_crash: bool,
    counter: u64,
    stats: Stats,
}

impl World {
    fn new(seed: u64) -> Self {
        let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
        let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
        let n = 3 + rng.below(5) as usize;
        let nodes: Vec<String> = (0..n).map(|i| format!("https://node-{i}.example")).collect();
        // a strict minority lies: at most n − (n/2 + 1), and most runs use all of it
        let max_liars = n - (n / 2 + 1);
        let liars = if rng.below(4) == 0 { rng.below(max_liars as u64 + 1) as usize } else { max_liars };
        let mut liar = vec![false; n];
        while liar.iter().filter(|l| **l).count() < liars {
            liar[rng.below(n as u64) as usize] = true;
        }
        let cap_attack = seed % 5 == 0;
        let (min_note, cap) = (Q, if cap_attack { 5 } else { 14 });
        let chain = RefChain::new(alice.scan_key().nk.unwrap(), bob.scan_key().nk.unwrap());
        let mut w = Self {
            seed,
            rng,
            chain,
            stored: WalletState::new(alice.address().pk),
            alice,
            bob,
            nodes,
            liar,
            min_note,
            cap,
            cap_attack,
            listing: 0,
            embargo: Embargo::None,
            intents: Vec::new(),
            attempts: Vec::new(),
            withheld: Vec::new(),
            other_paid: 0,
            no_crash: false,
            counter: 0,
            stats: Stats::default(),
        };
        w.stats.nodes = n;
        w.stats.liars = liars;
        w.stored = w.new_state();
        for v in [6 * Q, 4 * Q, 9 * Q] {
            w.fund(v, 5);
        }
        w
    }

    fn new_state(&self) -> WalletState {
        let mut s = WalletState::with_limits(self.alice.address().pk, self.min_note, self.cap).unwrap();
        s.set_nodes(&self.nodes).unwrap();
        s
    }

    fn label(&mut self, what: &str) -> String {
        self.counter += 1;
        format!("prop-{}-{}-{what}", self.seed, self.counter)
    }

    fn quorum(&self) -> usize {
        self.nodes.len() / 2 + 1
    }

    /// The client stores the state a call returned — unless it crashes first, and then it still
    /// has the state it had. `true`: stored.
    fn persist(&mut self, s: WalletState) -> bool {
        if !self.no_crash && self.rng.below(16) == 0 {
            self.stats.states_lost += 1;
            false
        } else {
            self.stored = s;
            true
        }
    }

    // ---- other parties ---------------------------------------------------------------------------------

    /// A shield of `value` to Alice from account `tag` (anybody: a friend, or the hostile sender).
    fn shield_to_alice(&mut self, value: u64, tag: u8) -> (UnprovenTx, Tx) {
        let key = fake_account_key(tag);
        let label = self.label("shield");
        let to = self.alice.address();
        let ctx = TxContext { chain_id: CHAIN.to_string(), anchor: self.chain.snap.root, anchor_height: self.chain.height, expiry_height: self.chain.height + 100 };
        let req = ShieldRequest { ctx, from_pub_key: &key, nonce: 1, v_in: value + Q, fee: Q, recipient: &to, max_fee: None };
        let tx = deterministic::shield(&req, &label).unwrap();
        let t = Tx::of(&tx, Who::Alice, None);
        (tx, t)
    }

    fn fund(&mut self, value: u64, tag: u8) {
        let (_, t) = self.shield_to_alice(value, tag);
        assert!(self.chain.block(Some(&t)));
    }

    /// The hostile sender: dust, a burst of minimum-value notes (to fill the cap), or a note whose
    /// ciphertext decrypts for Alice to a value its commitment does not open to.
    fn hostile_send(&mut self) {
        match self.rng.below(3) {
            0 => {
                let v = 1 + self.rng.below(Q - 1);
                self.fund(v, 7);
            }
            1 => {
                let burst = if self.cap_attack { 2 + self.rng.below(5) } else { 1 };
                for _ in 0..burst {
                    self.fund(Q, 7);
                }
            }
            _ => {
                let (u, mut t) = self.shield_to_alice(2 * Q, 7);
                let o = u.outputs.iter().find(|o| o.role == OutputRole::Payment).unwrap();
                let (kem, note, _) = encrypt_note_with_kem_randomness(&self.alice.address().ek, &o.cm, 1_000 * Q, &o.r, canonical(self.counter)).unwrap();
                t.body[OFF_KEM[o.slot]..OFF_KEM[o.slot] + KEM].copy_from_slice(&kem);
                t.body[OFF_NOTE[o.slot]..OFF_NOTE[o.slot] + NOTE].copy_from_slice(&note);
                // nobody can find or spend this note: it is nobody's
                t.outs = [None, None];
                assert!(self.chain.block(Some(&t)));
            }
        }
        self.stats.hostile_notes += 1;
    }

    /// The same recovery phrase on another device, in sync with the chain, which knows nothing of
    /// A's locks. Half the time it picks exactly the notes one of A's unmined transactions spends.
    fn second_device_pays(&mut self) {
        let mut b = self.new_state();
        let page = ListingPage::from_json(&self.chain.page(0, self.chain.height).to_string()).unwrap();
        b.scan(&page, &self.alice.scan_key()).unwrap();
        let reports: Vec<StateReport> = self.nodes.iter().map(|id| self.chain.report(id, self.chain.height)).collect();
        assert_eq!(b.confirm_state(&reports).unwrap().matched_height, Some(self.chain.height));
        let amount = [Q, 2 * Q][self.rng.below(2) as usize];
        let rivals: Vec<usize> = (0..self.attempts.len()).filter(|&i| !self.chain.is_mined(&self.attempts[i].tx)).collect();
        let mut positions: Option<Vec<u64>> = None;
        if let (0, Some(i)) = (self.rng.below(2), self.rng.pick(&rivals)) {
            let same: Option<Vec<u64>> = self.attempts[i].input_cms.iter().map(|c| b.unspent().find(|n| n.cm == *c).map(|n| n.position)).collect();
            if let Some(p) = same.filter(|p| p.iter().map(|&x| b.note_at(x).unwrap().value as u128).sum::<u128>() >= (amount + Q) as u128) {
                positions = Some(p);
                self.stats.second_device_same_inputs += 1;
            }
        }
        let positions = match positions {
            Some(p) => p,
            None => match select_inputs(&b, amount, Q) {
                Ok(sel) => sel.positions,
                Err(_) => return,
            },
        };
        let label = self.label("device-b");
        let to = self.bob.address();
        let spend = SpendOptions { chain_id: CHAIN, inputs: &positions, expiry_height: None, allow_unverified: false, max_fee: None };
        let (tx, _) = deterministic::transfer_locked(&b, b.revision(), &self.alice, &TransferParams { spend, recipient: &to, amount, fee: Q }, &label).unwrap();
        assert!(self.chain.block(Some(&Tx::of(&tx, Who::Bob, Some(Who::Alice)))), "device B is in sync with the true chain");
        self.other_paid += amount as u128;
        self.stats.second_device += 1;
    }

    // ---- the nodes -------------------------------------------------------------------------------------

    /// One page of a node that lies. `None` when this lie has nothing to work with.
    fn lying_page(&mut self) -> Option<serde_json::Value> {
        let since = self.stored.next_height();
        let mut page = self.chain.page(since, self.chain.height);
        let from = page["from_height"].as_u64().unwrap();
        let listed = page["txs"].as_array().unwrap().len();
        let fake_height = (self.chain.height + 1).max(from);
        let next_leaf = self.stored.tree().note_count() + 2 * listed as u64;
        let append = |page: &mut serde_json::Value, body: &[u8]| {
            page["txs"].as_array_mut().unwrap().push(RefChain::entry(body, fake_height, 0, next_leaf));
            page["tip_height"] = serde_json::json!(fake_height);
            page["next_height"] = serde_json::json!(fake_height + 1);
        };
        // (a wallet that rescans with transactions pending is where shifted leaves matter)
        let shift = self.stored.tree().note_count() == 0 && listed > 0 && !self.stored.pending().is_empty() && self.rng.below(2) == 0;
        match if shift { 12 } else { self.rng.below(13) } {
            // a transaction of this wallet that the node is holding back, listed as mined
            0 => {
                let held: Vec<usize> = (0..self.attempts.len()).filter(|&i| !self.chain.is_mined(&self.attempts[i].tx)).collect();
                let i = self.rng.pick(&held)?;
                append(&mut page, &self.attempts[i].tx.body.clone());
            }
            // the nullifiers of a real transaction replaced (a spend hidden)
            1 => {
                let n = self.rng.below(listed.max(1) as u64) as usize;
                let tag = self.rng.next();
                let tx = page["txs"].as_array_mut().unwrap().get_mut(n)?;
                tx["nf1"] = serde_json::json!(hex::encode(canonical(tag)));
                tx["nf2"] = serde_json::json!(hex::encode(canonical(tag ^ 0x5555)));
            }
            // "the chain is already far past your expiry height" — a few hundred blocks, or a million
            2 => {
                let far = if self.rng.below(3) == 0 { 1_000_000 } else { 1 + self.rng.below(300) };
                let tip = self.chain.height.max(from) + far;
                page["tip_height"] = serde_json::json!(tip);
                page["next_height"] = serde_json::json!(tip + 1);
            }
            // the last transaction left out
            3 => {
                page["txs"].as_array_mut().unwrap().pop()?;
            }
            // a payment to this wallet that is on no chain
            4 => {
                let (u, _) = self.shield_to_alice(50 * Q, 6);
                append(&mut page, &u.body);
            }
            // ciphertexts blanked: of one output somewhere …
            5 => {
                let n = self.rng.below(listed.max(1) as u64) as usize;
                let j = self.rng.below(2) as usize;
                let tx = page["txs"].as_array_mut().unwrap().get_mut(n)?;
                tx["outputs"][j]["kem_ct"] = serde_json::json!("00".repeat(KEM));
                tx["outputs"][j]["note_ct"] = serde_json::json!("00".repeat(NOTE));
            }
            // … or of every output of the wallet's own transactions (its change)
            11 => {
                let own: BTreeSet<String> = self.attempts.iter().map(|a| hex::encode(a.tx.nf(0))).collect();
                let mut hit = 0;
                for tx in page["txs"].as_array_mut().unwrap().iter_mut().filter(|t| own.contains(t["nf1"].as_str().unwrap())) {
                    for j in 0..2 {
                        tx["outputs"][j]["kem_ct"] = serde_json::json!("00".repeat(KEM));
                        tx["outputs"][j]["note_ct"] = serde_json::json!("00".repeat(NOTE));
                    }
                    hit += 1;
                }
                if hit == 0 {
                    return None;
                }
                self.stats.own_outputs_blanked += hit;
            }
            // a forged transaction at the FRONT of a listing read from the start: every real
            // note then sits two leaves further than on the chain
            12 => {
                if self.stored.tree().note_count() != 0 || listed == 0 {
                    return None;
                }
                let (u, _) = self.shield_to_alice(50 * Q, 6);
                let txs = page["txs"].as_array_mut().unwrap();
                let first_height = txs[0]["height"].as_u64().unwrap();
                for t in txs.iter_mut() {
                    for j in 0..2 {
                        t["outputs"][j]["leaf"] = serde_json::json!(t["outputs"][j]["leaf"].as_u64().unwrap() + 2);
                    }
                }
                txs[0]["index"] = serde_json::json!(1);
                txs.insert(0, RefChain::entry(&u.body, first_height, 0, 0));
                self.stats.leaves_shifted += 1;
            }
            // ciphertexts swapped between the two outputs
            6 => {
                let n = self.rng.below(listed.max(1) as u64) as usize;
                let tx = page["txs"].as_array_mut().unwrap().get_mut(n)?;
                let (a, b) = (tx["outputs"][0].clone(), tx["outputs"][1].clone());
                for k in ["kem_ct", "note_ct"] {
                    tx["outputs"][0][k] = b[k].clone();
                    tx["outputs"][1][k] = a[k].clone();
                }
            }
            // regrouped: the nullifier pairs of two transactions exchanged
            7 => {
                if listed < 2 {
                    return None;
                }
                let txs = page["txs"].as_array_mut().unwrap();
                let (x, y) = (txs[listed - 2].clone(), txs[listed - 1].clone());
                for k in ["nf1", "nf2"] {
                    txs[listed - 2][k] = y[k].clone();
                    txs[listed - 1][k] = x[k].clone();
                }
            }
            // a transaction moved to another height (heights are not in any hash)
            8 => {
                let last = page["txs"].as_array().unwrap().last()?["height"].as_u64().unwrap();
                let up = 1 + self.rng.below(80);
                let n = listed - 1;
                page["txs"][n]["height"] = serde_json::json!(last + up);
                let tip = page["tip_height"].as_u64().unwrap().max(last + up);
                page["tip_height"] = serde_json::json!(tip);
                page["next_height"] = serde_json::json!(tip + 1);
            }
            // a truncated page: true, and one block long
            9 => {
                page = self.chain.page(since, from);
                page["tip_height"] = serde_json::json!(self.chain.height.max(from));
            }
            // the truth (a liar need not lie every time)
            _ => {}
        }
        Some(page)
    }

    /// One page from the node the client lists from. `false`: the node answered nothing usable.
    fn sync_once(&mut self) -> Result<bool, ()> {
        let page = if self.liar[self.listing] {
            self.stats.lying_pages += 1;
            match self.lying_page() {
                Some(p) => p,
                None => return Ok(false),
            }
        } else {
            let lag = if self.rng.below(5) == 0 { self.rng.below(HONEST_LAG + 1) } else { 0 };
            self.chain.page(self.stored.next_height(), self.chain.height.saturating_sub(lag))
        };
        let page = ListingPage::from_json(&page.to_string()).unwrap();
        let mut s = self.stored.clone();
        match s.scan(&page, &self.alice.scan_key()) {
            Ok(r) => {
                // the wallet's own change does not depend on what the listing served as its
                // ciphertext: when the listing shows the transaction, the change note is there
                for p in s.pending().iter().filter(|p| p.status == PendingStatus::SeenMined && p.seen_height.is_some_and(|h| h >= page.from_height)) {
                    if let Some(c) = p.change.as_ref().filter(|c| c.r.is_some() && c.value > 0) {
                        assert!(s.notes().iter().any(|n| n.cm == c.cm && n.value == c.value), "seed {}: the listing showed the wallet's own transaction and its change is not stored", self.seed);
                    }
                }
                self.stats.lying_pages_accepted += self.liar[self.listing] as usize;
                self.persist(s);
                Ok(r.at_tip)
            }
            // "a `listing:` error: rebuild from rescan_state against another node"
            Err(WalletError::Listing(_)) => Err(()),
            Err(e) => panic!("seed {}: scan failed with {e}", self.seed),
        }
    }

    fn rotate(&mut self) {
        self.listing = (self.listing + 1) % self.nodes.len();
        self.stats.rotations += 1;
    }

    fn rescan(&mut self) {
        let s = self.stored.fresh_for_rescan();
        if self.persist(s) {
            self.stats.rescans += 1;
        }
    }

    fn sync(&mut self, pages: usize) {
        for _ in 0..pages {
            match self.sync_once() {
                Ok(true) => break,
                Ok(false) => {}
                Err(()) => {
                    self.rescan();
                    self.rotate();
                    break;
                }
            }
        }
    }

    /// What the nodes answer to "what is the pool state". Honest nodes: the truth at their tip
    /// (`settled`: all of them at the chain's tip; otherwise now and then a block or two behind).
    /// Liars: anything.
    fn reports(&mut self, settled: bool) -> Vec<StateReport> {
        let tip = self.chain.height;
        let scanned = self.stored.scanned_height();
        let mut out = Vec::new();
        let all_honest_silent = !settled && self.rng.below(10) == 0;
        for i in 0..self.nodes.len() {
            let id = self.nodes[i].clone();
            if !self.liar[i] {
                // outside a settlement window an honest node may not answer at all
                if !settled && (all_honest_silent || self.rng.below(5) == 0) {
                    self.stats.honest_silent += 1;
                    continue;
                }
                let lag = if !settled && self.rng.below(5) == 0 { self.rng.below(HONEST_LAG + 1) } else { 0 };
                out.push(self.chain.report(&id, tip.saturating_sub(lag).max(A - 1)));
                continue;
            }
            match self.rng.below(9) {
                // vouches for whatever the wallet has been made to believe, at its scanned height
                0 | 1 => out.extend(scanned.and_then(|h| echo_of(&self.stored, &id, h))),
                // … and says it twice, and under another spelling of its own id
                2 => {
                    if let Some(r) = scanned.and_then(|h| echo_of(&self.stored, &id, h)) {
                        out.push(r.clone());
                        out.push(StateReport { node_id: format!("{}/", id.to_uppercase()), ..r.clone() });
                        out.push(r);
                    }
                }
                // contradicts the truth at the tip in one value
                3 | 4 => {
                    let mut r = self.chain.report(&id, tip);
                    match self.rng.below(5) {
                        0 => r.tree_root = canonical(self.rng.next()),
                        1 => r.nullifier_acc = canonical(self.rng.next()),
                        2 => r.ciphertext_acc = canonical(self.rng.next()),
                        3 => r.note_count += 2,
                        _ => r.nullifier_count += 2,
                    }
                    out.push(r);
                }
                // replays an old true state — under its own height, or relabelled as the tip's
                5 => {
                    let old = (A - 1) + self.rng.below(tip - (A - 1) + 1);
                    let relabel = self.rng.below(2) == 0;
                    out.push(report_of(&id, if relabel { tip } else { old }, self.chain.state_at(old)));
                }
                // claims a height far above the chain, with the wallet's state or the chain's
                6 => {
                    let h = scanned.unwrap_or(tip).max(tip) + 1 + self.rng.below(2_000);
                    out.push(echo_of(&self.stored, &id, h).unwrap_or_else(|| report_of(&id, h, self.chain.snap)));
                }
                // says two things about one height
                7 => {
                    out.push(self.chain.report(&id, tip));
                    let mut r = self.chain.report(&id, tip);
                    r.nullifier_acc = canonical(self.rng.next());
                    out.push(r);
                }
                // is silent
                _ => {}
            }
        }
        // somebody the wallet was never configured with has an opinion too
        if self.rng.below(4) == 0 {
            if let Some(r) = scanned.and_then(|h| echo_of(&self.stored, "https://not-configured.example", h)) {
                out.push(r.clone());
                out.push(StateReport { node_id: "https://also-not-configured.example".into(), ..r });
            }
        }
        out
    }

    /// The client's state check and the documented rules that follow it. `true`: the check left
    /// nothing to do (the listing is neither refuted nor ahead of the quorum).
    fn confirm(&mut self, settled: bool) -> bool {
        let mut reports = self.reports(settled);
        let mut s = self.stored.clone();
        // the careless client of REVIEW_WALLET_3: "drop the nodes that conflict" — it hands in
        // only the reports that say what it already believes
        let all_reported = reports.len();
        if !settled && self.rng.below(4) == 0 {
            reports.retain(|r| s.state_at(r.height).is_some_and(|v| (v.tree_root, v.nullifier_acc, v.ciphertext_acc, v.note_count, v.nullifier_count) == (r.tree_root, r.nullifier_acc, r.ciphertext_acc, r.note_count, r.nullifier_count)));
            self.stats.reports_dropped += all_reported - reports.len();
        }
        let c = s.confirm_state(&reports).unwrap();
        let seed = self.seed;
        self.stats.confirm_calls += 1;
        assert_eq!((c.configured, c.quorum), (self.nodes.len(), self.quorum()), "seed {seed}: the quorum is a strict majority of the configured nodes");
        if let Some(h) = c.matched_height {
            // G2, at the moment of the match: an honest node holds exactly this state at this height
            assert!(h <= self.chain.height, "seed {seed}: a height was confirmed that the true chain has not reached");
            let mine = s.state_at(h).unwrap();
            let truth = self.chain.state_at(h);
            assert_eq!(
                (mine.tree_root, mine.nullifier_acc, mine.ciphertext_acc, mine.note_count, mine.nullifier_count),
                (truth.root, truth.nf_acc, truth.ct_acc, truth.notes, truth.nfs),
                "seed {seed}: the state confirmed at height {h} is not the chain's"
            );
            self.stats.matched += 1;
            self.stats.matched_with_dissent += !c.dissenting.is_empty() as usize;
        }
        // the quorum's tip is a height the chain has reached, and at least the lowest honest claim
        // (a lower bound holds only when the honest nodes answer: in a settlement window)
        if let Some(t) = c.quorum_tip {
            assert!(t <= self.chain.height && (!settled || t == self.chain.height), "seed {seed}: the quorum's tip {t} is not where the honest nodes are ({})", self.chain.height);
        }
        // a listing that shows transactions in blocks the quorum does not have: a block or two of
        // lead is an honest race; more, or any once the nodes have settled, is an invention
        let ahead = c.listing_ahead && (settled || c.quorum_tip.is_some_and(|t| self.changed_above(&s, t + HONEST_LAG)));
        let persisted = self.persist(s);
        if c.listing_refuted || ahead {
            self.stats.refuted += c.listing_refuted as usize;
            self.stats.ahead += ahead as usize;
            self.rescan();
            self.rotate();
            return false;
        }
        if let Some(quorum_tip) = c.quorum_tip {
            if self.stored.confirmed_height().is_none_or(|c| c < quorum_tip) {
                self.rotate(); // the listing does not get the wallet where the quorum is
            }
        }
        if persisted {
            if let (Embargo::AwaitConfirm, Some(h)) = (self.embargo, c.matched_height) {
                self.embargo = Embargo::Until(h + EXPIRY_BOUND + HONEST_LAG);
            }
        }
        self.end_embargo();
        true
    }

    /// Does the wallet's pool state change above `height`? (Its state at the scanned height is
    /// then not its state at `height`.)
    fn changed_above(&self, s: &WalletState, height: u64) -> bool {
        match (s.scanned_height(), s.state_at(height)) {
            (Some(top), Some(at)) if top > height => s.state_at(top) != Some(at),
            _ => false,
        }
    }

    /// Spec §5.5, restored device: once 128 blocks above the first confirmed height are
    /// confirmed, every transaction an earlier device built is mined or dead for good.
    fn end_embargo(&mut self) {
        let Embargo::Until(h) = self.embargo else { return };
        if self.stored.confirmed_height().is_none_or(|c| c < h) {
            return;
        }
        let seed = self.seed;
        for a in self.attempts.iter().filter(|a| !a.known) {
            assert!(self.chain.is_mined(&a.tx) || !self.chain.can_still_be_mined(&a.tx), "seed {seed}: the embargo after a restore ended while an earlier transaction can still be mined");
        }
        for (i, intent) in self.intents.iter_mut().enumerate().filter(|(_, x)| x.state == IntentState::Unknown) {
            let paid = self.attempts.iter().any(|a| a.intent == i && self.chain.is_mined(&a.tx));
            intent.state = if paid { IntentState::Paid } else { IntentState::Failed };
        }
        self.embargo = Embargo::None;
        self.stats.embargo_ended += 1;
    }

    // ---- the device ------------------------------------------------------------------------------------

    /// The user pays Bob: a payment the wallet reported dead is retried first; otherwise a new one.
    fn pay(&mut self) {
        if self.embargo != Embargo::None {
            return;
        }
        let retry = (0..self.intents.len()).find(|&i| self.intents[i].state == IntentState::Failed);
        let amount = match retry {
            Some(i) => self.intents[i].amount,
            None => [Q, 2 * Q, 3 * Q, 3 * Q + Q / 2, 7 * Q, 11 * Q][self.rng.below(6) as usize],
        };
        let st = self.stored.clone();
        // one payment in five the user explicitly allows inputs (and a root) nobody confirmed
        let unverified = self.rng.below(5) == 0;
        let Ok(sel) = select_inputs_with(&st, amount, Q, unverified) else { return };
        let (label, to, seed) = (self.label("pay"), self.bob.address(), self.seed);
        let expiry = if self.rng.below(4) == 0 { st.confirmed_height().map(|c| c + 1 + self.rng.below(EXPIRY_BOUND)) } else { None };
        let spend = SpendOptions { chain_id: CHAIN, inputs: &sel.positions, expiry_height: expiry, allow_unverified: unverified, max_fee: None };
        let built = deterministic::transfer_locked(&st, st.revision(), &self.alice, &TransferParams { spend, recipient: &to, amount, fee: Q }, &label);
        let (tx, locked) = match built {
            Ok(x) => x,
            // the wallet's root is above the confirmed height, or the pending list is full
            Err(WalletError::StateUnconfirmed) | Err(WalletError::Request(_)) => return,
            Err(e) => panic!("seed {seed}: a selected payment could not be built: {e}"),
        };
        let t = Tx::of(&tx, Who::Bob, Some(Who::Alice));
        // G3, first half: the expiry is bounded by the TRUE height, whatever any node claimed
        assert!(t.expiry() <= self.chain.height + EXPIRY_BOUND, "seed {seed}: expiry {} is more than 128 blocks above the true height {}", t.expiry(), self.chain.height);
        if !unverified {
            assert_eq!(t.anchor(), self.chain.state_at(st.confirmed_height().unwrap()).root, "seed {seed}: the anchor is the chain's root at the confirmed height");
        }
        // G1: nothing this device built earlier from one of these notes can still be mined — the
        // lock holds on every listing, also for a caller that allows unverified inputs — and
        // without that flag it is not mined either (with it, a listing that hides the spend can
        // make the wallet build a transaction that is dead on arrival: the caller's risk)
        let nfs = [t.nf(0), t.nf(1)];
        for a in self.attempts.iter().filter(|a| a.known && (nfs.contains(&a.tx.nf(0)) || nfs.contains(&a.tx.nf(1)))) {
            assert!(unverified || !self.chain.is_mined(&a.tx), "seed {seed}: a note spent by a MINED transaction of this wallet is spent again");
            assert!(!self.chain.can_still_be_mined(&a.tx), "seed {seed}: a note is handed out again while an earlier transaction from it can still be mined");
        }
        self.stats.unverified_payments += unverified as usize;
        // the returned state holds the lock; the caller's is untouched
        assert!(sel.positions.iter().all(|&p| locked.is_locked(p) && !st.is_locked(p)) && locked.pending().len() == st.pending().len() + 1);
        let record = locked.pending().last().unwrap().clone();
        assert_eq!(record.expiry_height, t.expiry());
        // THE RULE: persist the returned state, then submit. Not persisted ⇒ not submitted.
        if !self.persist(locked) {
            return;
        }
        let intent = match retry {
            Some(i) => {
                self.stats.retries += 1;
                i
            }
            None => {
                self.intents.push(Intent { amount, state: IntentState::Open });
                self.intents.len() - 1
            }
        };
        self.intents[intent].state = IntentState::Open;
        self.attempts.push(Attempt { tx: t.clone(), nullifiers: record.nullifiers.clone(), outputs: record.outputs.clone(), input_cms: record.input_cms.clone(), intent, known: true });
        let i = self.attempts.len() - 1;
        self.stats.payments += 1;
        self.stats.two_input_payments += (sel.positions.len() == 2) as usize;
        match self.rng.below(10) {
            // a crash between the persist and the submit: it never leaves the device. The client
            // may say so (`abandon_unsubmitted`) — which releases nothing
            0 => {
                self.stats.unsubmitted += 1;
                if self.rng.below(2) == 0 {
                    let mut s = self.stored.clone();
                    assert!(s.abandon_unsubmitted(&record.nullifiers[0].0) && s.is_locked(sel.positions[0]));
                    self.persist(s);
                }
            }
            // submitted to a node
            _ => {
                // the node it lists from, as a client would; or any other
                let node = if self.rng.below(2) == 0 { self.listing } else { self.rng.below(self.nodes.len() as u64) as usize };
                if self.liar[node] && self.rng.below(4) != 0 {
                    self.withheld.push(i);
                    self.stats.withheld += 1;
                } else {
                    self.chain.block(Some(&t));
                }
            }
        }
    }

    /// The adversary releases a transaction it kept — whenever it likes.
    fn release(&mut self) {
        let Some(i) = self.rng.pick(&self.withheld) else { return };
        if self.chain.is_mined(&self.attempts[i].tx) {
            return;
        }
        let tx = self.attempts[i].tx.clone();
        if self.chain.block(Some(&tx)) {
            self.stats.released_late += 1;
        } else {
            self.stats.release_refused += 1;
        }
    }

    /// The adversary's best timing against "expired": it lets the chain reach the block BEFORE the
    /// transaction's last valid block, lets the wallet look, and then mines the transaction in
    /// that last block (`expiry_height` itself).
    fn release_in_the_last_block(&mut self) {
        let alive: Vec<usize> = self.withheld.iter().copied().filter(|&i| self.chain.can_still_be_mined(&self.attempts[i].tx)).collect();
        let Some(i) = self.rng.pick(&alive) else { return };
        let tx = self.attempts[i].tx.clone();
        self.chain.advance_to(tx.expiry() - 1);
        for _ in 0..3 {
            self.sync(4);
            self.confirm(true);
            self.resolve();
        }
        if self.chain.height == tx.expiry() - 1 && self.chain.block(Some(&tx)) {
            self.stats.released_last_block += 1;
        }
    }

    /// The attempts a settled entry can stand for. An entry names exactly one — by its nullifier
    /// pair AND its outputs, or by its pair and its change commitment after a migration from
    /// format 2. A lock migrated from format 1 knows one nullifier only: every attempt from that note.
    fn attempts_for(&self, p: &PendingTx) -> Vec<usize> {
        let found: Vec<usize> = (0..self.attempts.len())
            .filter(|&i| {
                let a = &self.attempts[i];
                if p.legacy {
                    p.nullifiers.iter().any(|n| a.nullifiers.contains(n))
                } else if p.outputs.is_empty() {
                    a.nullifiers == p.nullifiers && p.change.as_ref().is_some_and(|c| a.outputs.contains(&c.cm))
                } else {
                    a.nullifiers == p.nullifiers && a.outputs == p.outputs
                }
            })
            .collect();
        assert!(!found.is_empty() && (p.legacy || found.len() == 1), "seed {}: a settled entry is one transaction this wallet built", self.seed);
        found
    }

    fn resolve(&mut self) {
        let mut s = self.stored.clone();
        let r = s.resolve();
        let seed = self.seed;
        let confirmed = s.confirmed_height();
        // G3, second half: what is left is not yet due
        assert!(s.pending().iter().all(|p| confirmed.is_none_or(|c| p.expiry_height > c)), "seed {seed}: an entry is still pending although the confirmed height has reached its expiry");
        // G1 / "a settlement is the truth"
        let mut verdicts: Vec<(usize, bool)> = Vec::new();
        for p in &r.mined {
            let i = self.attempts_for(p)[0];
            assert!(self.chain.is_mined(&self.attempts[i].tx), "seed {seed}: settled as mined, and it is not on the true chain");
            verdicts.push((i, true));
            self.stats.settled_mined += 1;
        }
        for p in &r.expired {
            for i in self.attempts_for(p) {
                let a = &self.attempts[i];
                assert!(!self.chain.is_mined(&a.tx), "seed {seed}: a MINED transaction was settled as expired");
                assert!(self.chain.height >= a.tx.expiry(), "seed {seed}: settled as expired while the true chain can still mine it (height {}, expiry {})", self.chain.height, a.tx.expiry());
                verdicts.push((i, false));
            }
            self.stats.settled_expired += 1;
        }
        for p in &r.superseded {
            let found = self.attempts_for(p);
            assert!(p.nullifiers.iter().any(|n| self.chain.spent.contains(&n.0)), "seed {seed}: settled as superseded and none of its nullifiers is spent");
            if p.legacy {
                // a lock migrated from format 1 does not know its transaction: "its input was spent"
                for i in found {
                    verdicts.push((i, self.chain.is_mined(&self.attempts[i].tx)));
                }
            } else {
                assert!(!self.chain.is_mined(&self.attempts[found[0]].tx), "seed {seed}: a MINED transaction was settled as superseded");
                verdicts.push((found[0], false));
            }
            self.stats.settled_superseded += 1;
        }
        let changed = !verdicts.is_empty();
        if !changed || self.persist(s) {
            // only what the client has stored is what the user was told. (One lock migrated from
            // format 1 can stand for several attempts from one note: "paid" if any of them was.)
            let mut told: BTreeMap<usize, bool> = BTreeMap::new();
            for (i, paid) in verdicts {
                *told.entry(self.attempts[i].intent).or_insert(false) |= paid;
            }
            for (intent, paid) in told {
                if paid {
                    self.intents[intent].state = IntentState::Paid;
                } else if self.intents[intent].state == IntentState::Open {
                    self.intents[intent].state = IntentState::Failed;
                }
            }
        }
    }

    /// The device is lost and the wallet restored from the phrase: an empty state, no lock.
    fn restore(&mut self) {
        self.stored = self.new_state();
        for a in self.attempts.iter_mut() {
            a.known = false;
        }
        for x in self.intents.iter_mut().filter(|x| x.state == IntentState::Open) {
            x.state = IntentState::Unknown;
        }
        self.embargo = Embargo::AwaitConfirm;
        self.listing = self.rng.below(self.nodes.len() as u64) as usize;
        self.stats.restores += 1;
    }

    /// The state written back in an older format (as that format would have held it) and read
    /// again: the migration to the current format.
    fn migrate(&mut self) {
        let a = &self.stored;
        let frontier: Vec<String> = WalletState::new(a.pk()).tree().frontier().iter().map(hex::encode).collect();
        let tree = serde_json::json!({ "note_count": 0, "frontier": frontier, "root": hex::encode(WalletState::new(a.pk()).anchor()), "witnesses": {} });
        let note = |n: &OwnedNote, locally_spent: bool| {
            serde_json::json!({
                "value": n.value.to_string(), "r": n.r, "rho": n.rho, "position": n.position, "cm": n.cm, "nullifier": n.nullifier,
                "spent": n.spent || locally_spent, "spent_height": n.spent_height, "height": n.height, "tx_hash": n.tx_hash, "output_index": n.output_index,
            })
        };
        let v2_pending = |a: &WalletState| -> Vec<serde_json::Value> {
            a.pending()
                .iter()
                .map(|p| {
                    serde_json::json!({
                        "tx_type": p.tx_type, "nullifiers": p.nullifiers, "inputs": p.inputs, "input_total": p.input_total.to_string(),
                        "change": p.change.as_ref().map(|c| serde_json::json!({ "cm": c.cm, "value": c.value.to_string() })),
                        "expiry_height": p.expiry_height, "status": if p.status == PendingStatus::SeenMined { "mined" } else { "pending" },
                        "mined_height": p.seen_height.filter(|_| p.status == PendingStatus::SeenMined), "rejected_hint": p.rejected_hint,
                    })
                })
                .collect()
        };
        let any_legacy = a.pending().iter().any(|p| p.legacy);
        // format 1 knew a lock only as a note it had marked spent itself: it can hold this state
        // only if every pending entry is untouched and has its notes. (The scanned height a
        // format-1 state recorded is the true one here: format 1 never met this adversary.)
        let v1_possible = a.pending().iter().all(|p| p.status == PendingStatus::Pending && !p.input_cms.is_empty() && p.input_cms.iter().all(|c| a.unspent().any(|n| n.cm == *c)));
        // (a format-2 state in the middle of a rescan held an entry without its notes and locked
        // by POSITION; that documented limit of format 2 is not what this test is about)
        let has_its_notes = a.pending().iter().all(|p| !p.input_cms.is_empty() && p.input_cms.iter().all(|c| a.notes().iter().any(|n| n.cm == *c)));
        let format = match self.rng.below(3) {
            0 if v1_possible => 1,
            1 if !any_legacy && has_its_notes && a.pending().iter().all(|p| p.change.is_some()) => 2,
            _ => 3,
        };
        let json = match format {
            1 => {
                let locked = |n: &OwnedNote| a.is_locked(n.position);
                serde_json::json!({ "version": 1, "pk": hex::encode(a.pk()), "next_height": a.next_height().min(self.chain.height + 1), "tree": tree,
                    "notes": a.notes().iter().map(|n| note(n, locked(n))).collect::<Vec<_>>() })
            }
            2 => serde_json::json!({ "version": 2, "pk": hex::encode(a.pk()), "next_height": a.next_height(), "tree": tree,
                "notes": a.notes().iter().map(|n| note(n, false)).collect::<Vec<_>>(), "pending": v2_pending(a),
                "checkpoints": [], "confirmed_height": a.confirmed_height(), "blind": { "seen": [], "overflow": false } }),
            _ => {
                // format 3: the current shape without what format 4 added
                let mut v: serde_json::Value = serde_json::from_str(&a.to_json().unwrap()).unwrap();
                v["version"] = serde_json::json!(3);
                for k in ["nodes", "max_unspent_notes", "ciphertext_acc"] {
                    v.as_object_mut().unwrap().remove(k);
                }
                for p in v["pending"].as_array_mut().unwrap() {
                    for k in ["own_payment", "abandoned_hint"] {
                        p.as_object_mut().unwrap().remove(k);
                    }
                    if let Some(c) = p["change"].as_object_mut() {
                        c.remove("r");
                    }
                }
                v
            }
        };
        let before = a.pending().to_vec();
        let held: Vec<B32> = a.notes().iter().map(|n| n.cm).collect();
        let mut migrated = WalletState::from_json(&json.to_string()).expect("an older format is migrated");
        for p in &before {
            // every lock is kept: by the note's commitment where the old state held the note
            // (a state in the middle of a rescan held the entry without it: by position, as then)
            for (i, c) in p.input_cms.iter().enumerate() {
                let kept = migrated.pending().iter().any(|q| q.input_cms.contains(c) || (!held.contains(c) && q.input_cms.is_empty() && q.inputs.contains(&p.inputs[i])));
                assert!(kept, "seed {}: the migration to format 4 from {format} lost a lock", self.seed);
            }
        }
        assert!(format == 1 || migrated.pending().len() == before.len(), "seed {}: the migration kept every entry", self.seed);
        assert!(migrated.pending().iter().all(|p| p.status == PendingStatus::Pending) && migrated.nodes().is_empty() && migrated.confirmed_height().is_none());
        // the client configures its nodes again (a migrated state has none) — this step is not optional
        migrated.set_nodes(&self.nodes).unwrap();
        self.stored = migrated;
        self.stats.migrations[format - 1] += 1;
    }

    // ---- the invariants --------------------------------------------------------------------------------

    fn check(&mut self, step: &str) {
        let seed = self.seed;
        let st = &self.stored;
        // G1 (structure): no note is an input of two unsettled transactions, and every input of an
        // unsettled entry that the state holds is locked
        let pending = st.pending();
        for (i, p) in pending.iter().enumerate() {
            for q in &pending[i + 1..] {
                assert!(!p.input_cms.iter().any(|c| q.input_cms.contains(c)), "seed {seed} after {step}: two pending entries spend one note");
            }
            for n in st.notes().iter().filter(|n| p.input_cms.contains(&n.cm)) {
                assert!(st.is_locked(n.position), "seed {seed} after {step}: an input of a pending entry is not locked");
            }
            // G3 (first half), for every entry whatever its origin
            assert!(p.expiry_height <= self.chain.height + EXPIRY_BOUND, "seed {seed} after {step}: a lock reaches more than 128 blocks beyond the true height");
        }
        // … and by the books, not by what the entry says of itself: while the state holds the entry
        // of a transaction, every note that transaction spends is locked wherever the listing
        // put it (a lock belongs to the commitment, not to a leaf position)
        for a in self.attempts.iter().filter(|a| a.known) {
            let held = pending.iter().any(|p| if p.legacy { p.nullifiers.iter().any(|n| a.nullifiers.contains(n)) } else { p.nullifiers == a.nullifiers });
            if !held {
                continue;
            }
            for cm in (0..2).filter_map(|i| self.chain.note_spent_by(&a.tx.nf(i))) {
                for n in st.unspent().filter(|n| n.cm.0 == cm) {
                    assert!(st.is_locked(n.position), "seed {seed} after {step}: a note a pending transaction spends is not locked (at leaf {})", n.position);
                }
            }
        }
        // G1 (payments): nothing the user asked for is mined twice
        let mut mined_per_intent = vec![0usize; self.intents.len()];
        for a in self.attempts.iter().filter(|a| self.chain.is_mined(&a.tx)) {
            mined_per_intent[a.intent] += 1;
        }
        assert!(mined_per_intent.iter().all(|&n| n <= 1), "seed {seed} after {step}: a payment was made twice");
        // G2
        let b = st.balances();
        assert!(b.spendable <= b.confirmed && b.locked <= b.confirmed + b.unverified);
        match st.confirmed_height() {
            None => assert_eq!(b.confirmed, 0, "seed {seed} after {step}: a confirmed balance without a confirmed height"),
            Some(h) => {
                assert!(h <= self.chain.height, "seed {seed} after {step}: a height was confirmed that the true chain has not reached");
                let truth = self.chain.balance(Who::Alice, h);
                assert!(b.confirmed <= truth, "seed {seed} after {step}: confirmed balance {} exceeds the true balance {truth} at height {h}", b.confirmed);
            }
        }
        // the state the wallet would persist is one it reads back
        if self.rng.below(10) == 0 {
            let back = WalletState::from_json(&st.to_json().unwrap()).expect("to_json writes what from_json reads");
            assert_eq!(&back, st, "seed {seed} after {step}");
        }
    }

    /// **G3 / G4 as a bound.** The chain moves past every expiry (at most 128 blocks: checked
    /// above), the honest majority answers, the liars keep lying — and the client's documented
    /// loop must END, within `2·nodes + 4` rounds, with nothing pending, nothing locked, the tip
    /// confirmed and the confirmed balance equal to the true balance.
    fn drive_to_settlement(&mut self, what: &str) {
        let seed = self.seed;
        let last_expiry = self.stored.pending().iter().map(|p| p.expiry_height).max().unwrap_or(0);
        self.chain.advance_to(self.chain.height.max(last_expiry));
        let tip = self.chain.height;
        let bound = 2 * self.nodes.len() + 4;
        let mut rounds = 0;
        self.no_crash = true;
        let mut clean = false;
        loop {
            let done = clean && self.stored.pending().is_empty() && self.stored.confirmed_height() == Some(tip);
            if done {
                break;
            }
            assert!(rounds < bound, "seed {seed}, {what}: not settled after {rounds} rounds with an honest majority reachable (pending {}, confirmed {:?}, tip {tip}, listing from a {} node)",
                self.stored.pending().len(), self.stored.confirmed_height(), if self.liar[self.listing] { "lying" } else { "honest" });
            rounds += 1;
            self.sync(6);
            clean = self.confirm(true);
            self.resolve();
            self.check(what);
        }
        self.no_crash = false;
        self.stats.drives += 1;
        self.stats.drive_rounds_max = self.stats.drive_rounds_max.max(rounds);
        let b = self.stored.balances();
        assert_eq!(b.locked, 0, "seed {seed}, {what}: nothing is pending and something is locked");
        // everything the wallet's policies do not leave out is there, confirmed and spendable
        let visible: u128 = self.chain.unspent_at(Who::Alice, tip).filter(|n| !(n.stranger && n.value < self.min_note)).map(|n| n.value as u128).sum();
        let over = self.stored.over_capacity();
        if self.chain.alice_unspent_peak < self.cap {
            assert_eq!(over.count, 0, "seed {seed}, {what}: notes counted as over capacity although the wallet never held {} unspent notes (peak {})", self.cap, self.chain.alice_unspent_peak);
            self.stats.cap_checked += 1;
        }
        if over.count == 0 {
            assert_eq!((b.confirmed, b.spendable), (visible, visible), "seed {seed}, {what}: the confirmed balance is not the true balance at the tip\n{}", self.books());
        } else {
            assert!(b.confirmed <= visible);
        }
    }

    /// Both sides of the books, for a failure message: (value, height created) of every unspent note.
    fn books(&self) -> String {
        let mut mine: Vec<(u64, u64, bool)> = self.stored.unspent().map(|n| (n.value, n.height, n.confirmed)).collect();
        let mut truth: Vec<(u64, u64, bool)> = self.chain.unspent_at(Who::Alice, self.chain.height).map(|n| (n.value, n.created, n.stranger)).collect();
        mine.sort();
        truth.sort();
        format!(
            "wallet (value, height, confirmed): {mine:?}\nchain (value, height, from a stranger): {truth:?}\nbelow_minimum {:?}, over_capacity {:?}, pruned {:?}, cap {}, peak {}, tip {}",
            self.stored.below_minimum(), self.stored.over_capacity(), self.stored.pruned(), self.cap, self.chain.alice_unspent_peak, self.chain.height
        )
    }

    /// The end of a run: everything settled; then the books are closed with a rescan that leaves
    /// nothing out (minimum note value 1, the highest cap) — the documented recovery of what
    /// `below_minimum` and `over_capacity` count.
    fn close(&mut self) {
        let seed = self.seed;
        self.drive_to_settlement("closing");
        self.end_embargo();
        let recovered = self.stored.over_capacity().count > 0;
        let wide = self.stored.fresh_for_rescan_with(Some(1), Some(MAX_UNSPENT_NOTES_LIMIT)).unwrap();
        self.stored = wide;
        let (min, cap) = (self.min_note, self.cap);
        (self.min_note, self.cap) = (1, MAX_UNSPENT_NOTES_LIMIT);
        self.drive_to_settlement("closing, everything stored");
        (self.min_note, self.cap) = (min, cap);
        self.stats.cap_recovered += recovered as usize;
        let tip = self.chain.height;
        let truth = self.chain.balance(Who::Alice, tip);
        let st = &self.stored;
        assert_eq!((st.balance(), st.balances().confirmed, st.balances().spendable, st.below_minimum().count, st.over_capacity().count), (truth, truth, truth, 0, 0), "seed {seed}: the wallet's balance IS the true balance\n{}", self.books());
        assert_eq!(st.unspent().count(), self.chain.unspent_at(Who::Alice, tip).count(), "seed {seed}: every unspent note is stored");
        assert!(st.unspent().all(|n| n.confirmed && st.tree().path(n.position).is_some()), "seed {seed}: confirmed, with its Merkle path");
        // the payee: each payment once. From the books …
        let paid: u128 = (0..self.intents.len()).filter(|&i| self.attempts.iter().any(|a| a.intent == i && self.chain.is_mined(&a.tx))).map(|i| self.intents[i].amount as u128).sum();
        assert_eq!(self.chain.balance(Who::Bob, tip), paid + self.other_paid, "seed {seed}: the payee holds each mined payment exactly once");
        // … and as Bob's own wallet sees it on an honest listing (the books against the code)
        let mut bob = WalletState::with_limits(self.bob.address().pk, 1, MAX_UNSPENT_NOTES_LIMIT).unwrap();
        bob.scan(&ListingPage::from_json(&self.chain.page(0, tip).to_string()).unwrap(), &self.bob.scan_key()).unwrap();
        assert_eq!(bob.balance(), paid + self.other_paid, "seed {seed}");
        // every payment the wallet reported is what happened
        for (i, x) in self.intents.iter().enumerate() {
            let mined = self.attempts.iter().any(|a| a.intent == i && self.chain.is_mined(&a.tx));
            match x.state {
                IntentState::Paid => assert!(mined, "seed {seed}: the user was told a payment was made that was not"),
                IntentState::Failed => assert!(!mined, "seed {seed}: the user was told a payment failed that was made"),
                IntentState::Open | IntentState::Unknown => {}
            }
        }
    }

    fn step(&mut self) -> &'static str {
        match self.rng.below(120) {
            0..=7 => {
                let v = [Q / 2, Q, 2 * Q, 5 * Q, 9 * Q][self.rng.below(5) as usize];
                self.fund(v, 5);
                "a payment to the wallet"
            }
            8..=17 => {
                let to = self.chain.height + 1 + self.rng.below(30);
                self.chain.advance_to(to);
                "blocks"
            }
            18..=19 => {
                // a very long delay
                let to = self.chain.height + 150 + self.rng.below(450);
                self.chain.advance_to(to);
                "many blocks"
            }
            20..=43 => {
                self.sync(3);
                "sync"
            }
            44..=65 => {
                self.confirm(false);
                "state check"
            }
            66..=79 => {
                self.pay();
                "build and submit"
            }
            80..=84 => {
                self.release();
                "the adversary releases a withheld transaction"
            }
            85..=86 => {
                self.release_in_the_last_block();
                "the adversary mines a withheld transaction in its last valid block"
            }
            87..=96 => {
                self.resolve();
                "resolve"
            }
            97..=98 => {
                self.rescan();
                "rescan"
            }
            99..=101 => {
                self.migrate();
                "migration"
            }
            102 => {
                if self.rng.below(2) == 0 {
                    self.restore();
                }
                "restore from the phrase"
            }
            103..=106 => {
                self.second_device_pays();
                "the second device pays"
            }
            107..=111 => {
                self.hostile_send();
                "the hostile sender"
            }
            112..=114 => {
                self.rotate();
                "another listing node"
            }
            _ => {
                self.drive_to_settlement("mid-run");
                "settlement"
            }
        }
    }
}

const RUNS: u64 = 60;
const STEPS: usize = 280;

#[test]
fn settlement_guarantees_hold_against_an_independent_model() {
    let mut total = Stats::default();
    let mut nodes_seen = BTreeSet::new();
    for seed in 1..=RUNS {
        let mut w = World::new(seed);
        w.sync(4);
        w.confirm(true);
        for _ in 0..STEPS {
            let step = w.step();
            w.check(step);
        }
        w.close();
        nodes_seen.insert((w.stats.nodes, w.stats.liars));
        let s = &w.stats;
        macro_rules! add {
            ($($f:ident),*) => { $( total.$f += s.$f; )* };
        }
        add!(lying_pages, lying_pages_accepted, confirm_calls, matched, matched_with_dissent, refuted, ahead, rotations, rescans, states_lost, restores, embargo_ended, payments, retries,
            two_input_payments, withheld, unsubmitted, released_late, released_last_block, release_refused, unverified_payments, reports_dropped, honest_silent,
            own_outputs_blanked, leaves_shifted, second_device, second_device_same_inputs, hostile_notes, settled_mined, settled_expired,
            settled_superseded, drives, cap_checked, cap_recovered, liars, nodes);
        for i in 0..3 {
            total.migrations[i] += s.migrations[i];
        }
        total.drive_rounds_max = total.drive_rounds_max.max(s.drive_rounds_max);
    }
    println!("settlement guarantees over {RUNS} runs of {STEPS} steps; (nodes, liars) seen: {nodes_seen:?}\n{total:#?}");
    // the runs did exercise what the guarantees are about
    assert!(total.lying_pages_accepted > 400 && total.refuted > 100 && total.ahead > 30 && total.matched > 800 && total.matched_with_dissent > 300, "{total:?}");
    assert!(total.payments > 300 && total.retries > 40 && total.two_input_payments > 30 && total.withheld > 60 && total.released_late > 10 && total.release_refused > 50, "{total:?}");
    assert!(total.released_last_block > 5 && total.unverified_payments > 30 && total.reports_dropped > 300 && total.honest_silent > 300 && total.own_outputs_blanked > 5 && total.leaves_shifted > 30, "{total:?}");
    assert!(total.settled_mined > 150 && total.settled_expired > 50 && total.settled_superseded > 15, "{total:?}");
    assert!(total.second_device > 200 && total.second_device_same_inputs > 15 && total.hostile_notes > 300 && total.states_lost > 300, "{total:?}");
    assert!(total.migrations.iter().all(|&m| m > 40) && total.restores > 30 && total.embargo_ended > 10 && total.rescans > 300, "{total:?}");
    assert!(total.drives > 5 * RUNS as usize && total.cap_checked > 3 * RUNS as usize && total.cap_recovered > 2 && total.drive_rounds_max >= 4, "{total:?}");
    assert!(nodes_seen.iter().any(|&(n, l)| n >= 5 && l >= 2) && nodes_seen.iter().any(|&(n, _)| n == 3), "{nodes_seen:?}");
}
