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
//! **The world** (extended after REVIEW_WALLET_4). 2 to 7 configured nodes; a random strict
//! minority of them is one adversary that also controls a hostile sender, a hostile PAYEE and
//! every transaction submitted to it. It can: contradict correct values, vouch for whatever the
//! wallet has been made to believe, replay stale reports (under their own or a newer height),
//! inflate tips, equivocate, stay silent; serve listings with forged payments, hidden
//! transactions, replaced or regrouped nullifiers, shifted heights, leaf positions shifted by
//! two, four or six, blanked or swapped ciphertexts, pages cut at any height; withhold submitted
//! transactions and release them at any later time — after very long delays, or in the very
//! last block that can hold them; send dust, cap-filling notes and notes whose ciphertext does
//! not open their commitment; hand the payer an address made of the payer's own `pk` and the
//! payee's encryption key; and, when the device is restored from the phrase, **answer it with a
//! stale quorum**: the true chain as it was where a lagging honest node stands, listed and
//! reported by the liars (RW4-1). Besides: a second device on the same recovery phrase, crashes
//! between any two calls (the client loses the state a call returned, and its session),
//! restores from the phrase, migrations from state formats 1, 2, 3 and 4, a background worker
//! that scans with the viewing key alone, blocks with several transactions, and — in one run of
//! eight — 280 pool-changing blocks in a row, which evict the wallet's oldest checkpoints.
//!
//! **Honest nodes** stand anywhere up to 200 blocks behind the tip, never go back, and may be
//! unreachable — any number of them, outside the settlement windows: safety does not depend on
//! anybody answering. (200 is inside the 256 blocks of lag the restore embargo covers; the
//! assumption that remains is stated in `WalletState::spend_embargo`.)
//!
//! **The client follows the loop of `NOTES.md` §6 exactly** (`World::round`): pages from the
//! listing node with the full key; every node asked, the reports of the last rounds kept;
//! `confirm_state`; `listing_refuted`, a `listing:` error or a page with `leaf_mismatch` ⇒
//! rescan against a node not yet found lying; `listing_ahead` three rounds in a row ⇒ the same;
//! the confirmed height below the quorum's tip two rounds in a row ⇒ list from the next node;
//! `resolve_pending`; the SAME envelope again for what is still out; a payment only when this
//! round matched at the scanned tip and `spend_status` says a spend can be built — persist the
//! returned state, then submit; retry only what `resolve` reported expired or superseded.
//! Nothing about a restore is the client's to remember: the core enforces the embargo. A round
//! can end after any step (the user closes the application).
//!
//! **Value is the oracle's own** (`Tx::checked`): what each transaction must move is computed
//! from the request and the books; the body's public amounts are read at their offsets and the
//! commitment of every output is recomputed from the amount the request implies.
//!
//! **Checked**, after every step and at the end of every run:
//!
//! * **G1 — no double payment by the wallet's own behaviour.** Every payment the user asked for
//!   is mined at most once, although it is retried whenever the wallet says the last attempt is
//!   dead; no note is handed to a new transaction while an earlier one of this device from that
//!   note is mined or can still be mined; whatever `resolve` returns is the truth; **and the
//!   core lets a restored state spend only when nothing an earlier copy built can still be
//!   mined** — against the stale-quorum adversary, with the longest expiry the builders accept.
//! * **G2 — the confirmed balance never exceeds the true balance** at the confirmed height,
//!   note by note; the confirmed height is one the chain has reached; a state scanned with the
//!   viewing key offers nothing to spend.
//! * **G3 — bounded-time settlement.** Every transaction this version builds has
//!   `expiry_height ≤ (the TRUE height at the build) + 128`; a transaction mined at or below
//!   the confirmed height is settled by the next `resolve`; and whenever the honest majority is
//!   reachable at the tip, the client's loop ends — within `4·nodes + 8` rounds, the liars
//!   lying throughout — with nothing pending, nothing locked, the confirmed height at the tip
//!   and the confirmed balance EQUAL to the true balance (less only what the documented
//!   policies leave out).
//! * **G4 — a lying or unreachable minority causes delay only**: the same loop, the same
//!   bound; a true listing is never refuted, a truthful node never named as dissenting, the
//!   embargo base never more than 256 blocks above the true height; **and no call ever returns
//!   a state that does not read back** (RW4-5), whatever the pages did to leaf positions.
#![cfg(feature = "test-vectors")]

mod common;

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use common::{fake_account_key, keys, A, CHAIN, PHRASE_1, PHRASE_2, Q};
use quantum_vault_shield_v2::pool::{MemoryPoolStore, Pool, PoolTx, TxKind as PoolKind};
use quantum_vault_shield_v2::reference::{derive_rho, digest_from_bytes, digest_to_bytes, nullifier, Digest, Note, SparseTree, MODULUS};
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
/// How far an honest node can be behind the tip in this world (REVIEW_WALLET_4: "honest lag up
/// to 200 blocks"). The embargo after a restore covers 256 (`RESTORE_LAG_BOUND_BLOCKS`): the
/// world stays inside the stated assumption, with the adversary using all of it.
const HONEST_LAG_MAX: u64 = 200;

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
    /// **The oracle's own account of a transaction, from the REQUEST** (REVIEW_WALLET_4, "value
    /// conservation is outside the oracle"): `expect` says, per role, who must own the output and
    /// what it must be worth — computed by the caller from the amounts that were ASKED for and
    /// from the books, never from the value the builder recorded. The builder's record is used
    /// for one thing only: which slot holds which role, and the randomness `r` — and with them
    /// the commitment is RECOMPUTED here (the stage-1 crate's commitment, `rho` from the body's
    /// own nullifiers, the owner's `pk`) and compared with the body's. The public amounts are
    /// read from the body at their byte offsets. A builder that moves another amount than the
    /// request implies fails here, before anything is mined.
    fn checked(tx: &UnprovenTx, expect: &[(OutputRole, Who, u64, bool)], public: (u64, u64, u64), pk: &[Digest; 2], what: &str) -> Self {
        let body = &tx.body;
        let got = (le64(&body[OFF_V_IN..OFF_V_IN + 8]), le64(&body[OFF_V_IN + 8..OFF_V_IN + 16]), le64(&body[OFF_V_IN + 16..OFF_V_IN + 24]));
        assert_eq!(got, public, "{what}: the body's public amounts (v_in, v_out, fee) are not what was asked for");
        let nfd = [digest_from_bytes(&b32(&body[OFF_NF..OFF_NF + 32])).unwrap(), digest_from_bytes(&b32(&body[OFF_NF + 32..OFF_NF + 64])).unwrap()];
        let mut outs = [None, None];
        let mut roles = Vec::new();
        for o in &tx.outputs {
            roles.push(o.role);
            let cm = b32(&body[OFF_CM + 32 * o.slot..OFF_CM + 32 * o.slot + 32]);
            assert_eq!(cm, o.cm, "{what}: the builder's record of slot {} is not the body's commitment", o.slot);
            let Some(&(_, owner, value, stranger)) = expect.iter().find(|e| e.0 == o.role) else {
                assert_eq!(o.role, OutputRole::Dummy, "{what}: an output the request does not account for");
                continue;
            };
            let note = Note { value, pk: pk[owner as usize], rho: derive_rho(&nfd, o.slot), r: digest_from_bytes(&o.r).unwrap() };
            assert_eq!(digest_to_bytes(&note.commitment()), cm, "{what}: the {:?} output does not commit to the {value} quanta the request implies", o.role);
            if value > 0 {
                outs[o.slot] = Some((owner, value, stranger));
            }
        }
        assert!(expect.iter().all(|e| roles.contains(&e.0)), "{what}: an output the request implies is missing");
        Self { body: body.clone(), outs }
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
    /// the height each transaction was mined at
    mined_at: BTreeMap<[u8; 32], u64>,
    blocks_with_several: usize,
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
            mined_at: BTreeMap::new(),
            blocks_with_several: 0,
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
        let txs: Vec<&Tx> = tx.into_iter().collect();
        self.block_of(&txs).first().copied().unwrap_or(false)
    }

    /// One block with these transactions, in this order; each is accepted or refused by the
    /// model's own rules (against the block's predecessors: a nullifier an earlier transaction
    /// of the SAME block spent is spent). Returns which were accepted.
    fn block_of(&mut self, txs: &[&Tx]) -> Vec<bool> {
        let h = self.height + 1;
        let mut accepted: Vec<&Tx> = Vec::new();
        let mut verdict = Vec::with_capacity(txs.len());
        let mut in_block: BTreeSet<[u8; 32]> = BTreeSet::new();
        for t in txs {
            let ok = self.acceptable(t) && !in_block.contains(&t.nf(0)) && !in_block.contains(&t.nf(1));
            if ok {
                in_block.insert(t.nf(0));
                in_block.insert(t.nf(1));
                accepted.push(t);
            } else if txs.len() == 1 && t.expiry() >= h {
                assert!(self.pool.validate_block(h, &[Self::pool_tx(t)]).is_err(), "the model refuses what the consensus rules accept");
            }
            verdict.push(ok);
        }
        let pool_txs: Vec<PoolTx> = accepted.iter().map(|t| Self::pool_tx(t)).collect();
        self.pool.apply_block(h, &pool_txs).expect("the consensus rules accept what the model accepts");
        for (index, t) in accepted.iter().enumerate() {
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
            self.listed.push((h, index as u64, first_leaf, t.body.clone()));
            self.mined.insert(t.id());
            self.mined_at.insert(t.id(), h);
        }
        if !accepted.is_empty() {
            self.snap.root = digest_to_bytes(&self.tree.root());
            self.history.insert(h, self.snap);
            let p = self.pool.state().unwrap();
            assert_eq!((p.tree_root, p.nullifier_acc, p.note_count, p.nullifier_count), (self.snap.root, self.snap.nf_acc, self.snap.notes, self.snap.nfs), "the model's state is the consensus state");
            self.alice_unspent_peak = self.alice_unspent_peak.max(self.notes.iter().filter(|n| n.owner == Who::Alice && n.spent.is_none()).count());
            self.blocks_with_several += (accepted.len() > 1) as usize;
        }
        self.window.push_back(self.snap.root);
        if self.window.len() > ANCHOR_WINDOW {
            self.window.pop_front();
        }
        self.height = h;
        verdict
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
    /// the device was restored while an attempt was out: nothing is retried before the core's
    /// embargo has ended
    Unknown,
}

/// Whom the user pays, as the PAYEE spelled the address.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Payee {
    Bob,
    /// the wallet's own address, whole: a payment to self
    Own,
    /// Bob's `pk` with ALICE's encryption key: the note is Bob's and Bob cannot read it — a
    /// payee that harms nobody but itself
    BobUnreadable,
}

struct Intent {
    amount: u64,
    payee: Payee,
    state: IntentState,
}

#[derive(Default, Debug)]
struct Stats {
    lying_pages: usize,
    lying_pages_accepted: usize,
    pages_cut: usize,
    leaf_mismatches: usize,
    confirm_calls: usize,
    matched: usize,
    matched_with_dissent: usize,
    refuted: usize,
    ahead: usize,
    rotations: usize,
    rescans: usize,
    all_bad: usize,
    states_lost: usize,
    migrations: [usize; 4],
    restores: usize,
    embargo_bases: usize,
    stale_bases: usize,
    embargo_refusals: usize,
    embargo_ended: usize,
    payments: usize,
    retries: usize,
    two_input_payments: usize,
    max_expiry_payments: usize,
    self_payments: usize,
    unreadable_payments: usize,
    mixed_refused: usize,
    locked_refused: usize,
    long_expiry_refused: usize,
    two_tabs: usize,
    withheld: usize,
    unanswered: usize,
    resubmitted: usize,
    released_late: usize,
    released_last_block: usize,
    release_refused: usize,
    honest_silent: usize,
    honest_stalls: usize,
    lag_max: u64,
    own_outputs_blanked: usize,
    leaves_shifted: usize,
    second_device: usize,
    second_device_same_inputs: usize,
    hostile_notes: usize,
    view_only_scans: usize,
    view_only_refusals: usize,
    bursts: usize,
    evicted_reports: usize,
    blocks_with_several: usize,
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
    pk: [Digest; 2],
    nodes: Vec<String>,
    liar: Vec<bool>,
    /// where each HONEST node stands: never above the chain, never going back, never more than
    /// `HONEST_LAG_MAX` behind
    node_height: Vec<u64>,
    stalled: Vec<bool>,
    min_note: u64,
    cap: usize,
    cap_attack: bool,
    /// what device A has in its storage: the state, and the envelopes stored with it
    stored: WalletState,
    envelopes: Vec<usize>,
    // ---- the client's session (NOTES §6: `L`, `bad`, the reports of the last rounds); lost in a crash
    listing: usize,
    bad: BTreeSet<usize>,
    ahead: usize,
    behind: usize,
    cache: Vec<(u64, StateReport)>,
    round_no: u64,
    /// the stale-quorum adversary of RW4-1: the liars serve and report the TRUE chain as it was
    /// at this height (where an honest node is standing)
    stale: Option<u64>,
    /// a page since the state was last empty was scanned with the viewing key alone
    viewed: bool,
    burst_at: Option<usize>,
    intents: Vec<Intent>,
    attempts: Vec<Attempt>,
    /// submitted to a lying node and not mined (yet)
    withheld: Vec<usize>,
    /// what the second device paid Bob, and what others shielded to Bob
    other_paid: u128,
    /// the client does not crash while the settlement bound is being measured (a crash is the
    /// client's own delay, not the adversary's)
    no_crash: bool,
    counter: u64,
    stats: Stats,
}

impl World {
    fn new(seed: u64, steps: usize) -> Self {
        let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1);
        let (alice, bob) = (keys(PHRASE_1), keys(PHRASE_2));
        // 2 to 7 configured nodes (two tolerate no fault at all: no liar among them)
        let n = 2 + rng.below(6) as usize;
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
        let pk = [digest_from_bytes(&alice.address().pk).unwrap(), digest_from_bytes(&bob.address().pk).unwrap()];
        let burst_at = (seed % 8 == 3).then(|| rng.below(steps.max(1) as u64) as usize);
        let mut w = Self {
            seed,
            rng,
            chain,
            stored: WalletState::new(alice.address().pk),
            alice,
            bob,
            pk,
            node_height: vec![A - 1; n],
            stalled: vec![false; n],
            nodes,
            liar,
            min_note,
            cap,
            cap_attack,
            envelopes: Vec::new(),
            listing: 0,
            bad: BTreeSet::new(),
            ahead: 0,
            behind: 0,
            cache: Vec::new(),
            round_no: 0,
            stale: None,
            viewed: false,
            burst_at,
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
        // a NEW wallet on a new phrase: the user can truthfully say that no other copy has a
        // payment in flight. (Every later `new_state` — a restore — cannot, and does not.)
        w.stored = w.new_state(true);
        for v in [6 * Q, 4 * Q, 9 * Q] {
            w.fund(v, 5);
        }
        w
    }

    fn new_state(&self, sole_copy: bool) -> WalletState {
        let mut s = WalletState::with_limits(self.alice.address().pk, self.min_note, self.cap).unwrap();
        s.set_nodes(&self.nodes).unwrap();
        if sole_copy {
            s.assert_no_other_copy_has_a_pending_payment().unwrap();
        }
        s
    }

    fn label(&mut self, what: &str) -> String {
        self.counter += 1;
        format!("prop-{}-{}-{what}", self.seed, self.counter)
    }

    fn quorum(&self) -> usize {
        (self.nodes.len() / 2 + 1).max(2)
    }

    /// The client stores the state a call returned — unless it crashes first, and then it still
    /// has the state it had, and has lost its session. `true`: stored.
    ///
    /// Every state a call returned is one the core reads back (REVIEW_WALLET_4 RW4-5), and a
    /// changed state is another revision, by counter AND by identity (RW4-10).
    fn persist(&mut self, s: WalletState) -> bool {
        let seed = self.seed;
        let json = s.to_json().unwrap_or_else(|e| panic!("seed {seed}: to_json refused a state that a call returned: {e}"));
        let back = WalletState::from_json(&json).unwrap_or_else(|e| panic!("seed {seed}: a state that a call returned does not read back: {e}"));
        assert!(back == s, "seed {seed}: to_json writes what from_json reads");
        if s != self.stored {
            assert!(s.revision() > self.stored.revision(), "seed {seed}: a changed state has the revision it had");
            assert_ne!(s.revision_id(), self.stored.revision_id(), "seed {seed}: a changed state has the revision identity it had");
        }
        if !self.no_crash && self.rng.below(16) == 0 {
            self.stats.states_lost += 1;
            self.new_session();
            false
        } else {
            self.stored = s;
            true
        }
    }

    /// The application starts again: what it held in memory is gone.
    fn new_session(&mut self) {
        self.bad.clear();
        self.cache.clear();
        (self.ahead, self.behind) = (0, 0);
    }

    // ---- other parties ---------------------------------------------------------------------------------

    fn shield_ctx(&self) -> TxContext {
        TxContext { chain_id: CHAIN.to_string(), anchor: self.chain.snap.root, anchor_height: self.chain.height, expiry_height: self.chain.height + 100 }
    }

    /// A shield of `value` to Alice from account `tag` (anybody: a friend, or the hostile sender).
    fn shield_to_alice(&mut self, value: u64, tag: u8) -> (UnprovenTx, Tx) {
        let key = fake_account_key(tag);
        let label = self.label("shield");
        let to = self.alice.address();
        let req = ShieldRequest { ctx: self.shield_ctx(), from_pub_key: &key, nonce: 1, v_in: value + Q, fee: Q, recipient: &to, max_fee: None };
        let tx = deterministic::shield(&req, &label).unwrap();
        let t = Tx::checked(&tx, &[(OutputRole::Payment, Who::Alice, value, true)], (value + Q, 0, Q), &self.pk, "a shield to the wallet");
        (tx, t)
    }

    /// Somebody else's traffic: a shield to Bob.
    fn traffic(&mut self) -> Tx {
        let key = fake_account_key(9);
        let label = self.label("traffic");
        let to = self.bob.address();
        let value = Q + self.rng.below(3) * Q;
        let req = ShieldRequest { ctx: self.shield_ctx(), from_pub_key: &key, nonce: 1, v_in: value + Q, fee: Q, recipient: &to, max_fee: None };
        let tx = deterministic::shield(&req, &label).unwrap();
        Tx::checked(&tx, &[(OutputRole::Payment, Who::Bob, value, true)], (value + Q, 0, Q), &self.pk, "traffic")
    }

    /// Mines `t` in the next block — one time in three together with other people's
    /// transactions, before and after it (an honest block holds several). `true`: accepted.
    fn mine(&mut self, t: &Tx) -> bool {
        let (before, after) = if self.rng.below(3) == 0 { (self.rng.below(3), self.rng.below(3)) } else { (0, 0) };
        let mut txs: Vec<Tx> = (0..before).map(|_| self.traffic()).collect();
        let at = txs.len();
        txs.push(t.clone());
        txs.extend((0..after).map(|_| self.traffic()));
        let refs: Vec<&Tx> = txs.iter().collect();
        let verdict = self.chain.block_of(&refs);
        for (i, x) in txs.iter().enumerate().filter(|(i, _)| *i != at) {
            assert!(verdict[i]);
            self.other_paid += x.outs.iter().flatten().map(|o| o.1 as u128).sum::<u128>();
        }
        verdict[at]
    }

    fn fund(&mut self, value: u64, tag: u8) {
        let (_, t) = self.shield_to_alice(value, tag);
        assert!(self.mine(&t));
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

    /// More than 256 pool-changing heights in a row: the wallet's history of pool states (256
    /// checkpoints) loses its oldest entries, the confirmed one among them if the wallet did
    /// not look in between.
    fn burst(&mut self) {
        for _ in 0..280 {
            let t = self.traffic();
            assert!(self.chain.block(Some(&t)));
            self.other_paid += t.outs.iter().flatten().map(|o| o.1 as u128).sum::<u128>();
        }
        self.stats.bursts += 1;
    }

    /// The value the books hold for the notes at these positions of `st`: `None` if one of them
    /// is not a note of Alice that is unspent on the true chain AT THE STATE'S CONFIRMED HEIGHT
    /// (what happened above it, the wallet cannot know yet: such a spend is dead on arrival).
    fn book_value(&self, st: &WalletState, positions: &[u64]) -> Option<u64> {
        let at = st.confirmed_height()?;
        positions
            .iter()
            .map(|&p| {
                let cm = st.note_at(p)?.cm.0;
                self.chain.unspent_at(Who::Alice, at).find(|n| n.cm == cm).map(|n| n.value)
            })
            .sum()
    }

    /// The same recovery phrase on another device, in sync with the chain, which knows nothing of
    /// A's locks — and whose user says, wrongly or not, that no other copy has a payment in
    /// flight (the inherent limit: locks are per device). Half the time it picks exactly the
    /// notes one of A's unmined transactions spends.
    fn second_device_pays(&mut self) {
        let mut b = self.new_state(true);
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
        let total = self.book_value(&b, &positions).expect("a device in sync with the true chain selects true notes");
        let label = self.label("device-b");
        let to = self.bob.address();
        let spend = SpendOptions { chain_id: CHAIN, inputs: &positions, expiry_height: None, allow_unverified: false, max_fee: None };
        let (tx, _) = deterministic::transfer_locked(&b, b.revision(), &self.alice, &TransferParams { spend, recipient: &to, amount, fee: Q }, &label).unwrap();
        let t = Tx::checked(&tx, &[(OutputRole::Payment, Who::Bob, amount, true), (OutputRole::Change, Who::Alice, total - amount - Q, false)], (0, 0, Q), &self.pk, "device B's payment");
        assert!(self.chain.block(Some(&t)), "device B is in sync with the true chain");
        self.other_paid += amount as u128;
        self.stats.second_device += 1;
    }

    // ---- the nodes -------------------------------------------------------------------------------------

    /// Where the honest nodes stand now: a node that is not stalled is at the tip; a stalled
    /// one stays where it is until it is `HONEST_LAG_MAX` behind, and is then dragged along.
    fn follow(&mut self) {
        let tip = self.chain.height;
        for i in 0..self.nodes.len() {
            if !self.stalled[i] {
                self.node_height[i] = tip;
            } else if tip - self.node_height[i] > HONEST_LAG_MAX {
                self.node_height[i] = tip - HONEST_LAG_MAX;
            }
            self.stats.lag_max = self.stats.lag_max.max(tip - self.node_height[i]);
        }
    }

    /// Every honest node catches up and answers (a settlement window).
    fn settle_nodes(&mut self) {
        self.stalled.iter_mut().for_each(|s| *s = false);
        self.stale = None;
        self.follow();
    }

    /// The page ends after block `cut` (a page budget, a truncated answer): everything listed
    /// above it is left for the next page.
    fn cut_page(page: &mut serde_json::Value, cut: u64) {
        let from = page["from_height"].as_u64().unwrap();
        let next = page["next_height"].as_u64().unwrap();
        if cut < from || cut + 1 >= next {
            return;
        }
        page["txs"].as_array_mut().unwrap().retain(|t| t["height"].as_u64().unwrap() <= cut);
        page["next_height"] = serde_json::json!(cut + 1);
    }

    /// One page of a node that lies. `None` when this lie has nothing to work with.
    fn lying_page(&mut self) -> Option<serde_json::Value> {
        let since = self.stored.next_height();
        // the stale-quorum adversary serves the TRUE chain as it was at the stale height
        if let Some(x) = self.stale {
            return Some(self.chain.page(since, x));
        }
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
            // one to three forged transactions at the FRONT of a listing read from the start:
            // every real note then sits 2, 4 or 6 leaves further than on the chain — the
            // distances at which a note lands on the position another one had (RW4-5)
            12 => {
                if self.stored.tree().note_count() != 0 || listed == 0 {
                    return None;
                }
                let forged = 1 + self.rng.below(3);
                let bodies: Vec<Vec<u8>> = (0..forged).map(|_| self.shield_to_alice(50 * Q, 6).0.body.clone()).collect();
                let txs = page["txs"].as_array_mut().unwrap();
                let first_height = txs[0]["height"].as_u64().unwrap();
                for t in txs.iter_mut() {
                    for j in 0..2 {
                        t["outputs"][j]["leaf"] = serde_json::json!(t["outputs"][j]["leaf"].as_u64().unwrap() + 2 * forged);
                    }
                    if t["height"].as_u64() == Some(first_height) {
                        t["index"] = serde_json::json!(t["index"].as_u64().unwrap() + forged);
                    }
                }
                for (i, body) in bodies.iter().enumerate() {
                    txs.insert(i, RefChain::entry(body, first_height, i as u64, 2 * i as u64));
                }
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
        // … and whatever it is, cut anywhere: between two notes of one pending transaction, too
        if self.rng.below(3) == 0 {
            let heights: Vec<u64> = page["txs"].as_array().unwrap().iter().map(|t| t["height"].as_u64().unwrap()).collect();
            if let Some(cut) = self.rng.pick(&heights) {
                Self::cut_page(&mut page, cut);
                self.stats.pages_cut += 1;
            }
        }
        Some(page)
    }

    /// One page from the node the client lists from, scanned with the full key — or, for the
    /// background worker, with the viewing key alone. `Ok(at_tip)`; `Err`: rescan (a `listing:`
    /// error, a page that numbers its leaves differently from the wallet's tree, or a state the
    /// viewing key left unable to tell its spends).
    fn sync_once(&mut self, settled: bool, view_only: bool) -> Result<bool, ()> {
        let seed = self.seed;
        self.follow();
        let page = if self.liar[self.listing] {
            self.stats.lying_pages += 1;
            match self.lying_page() {
                Some(p) => p,
                None => return Ok(false),
            }
        } else {
            let mut page = self.chain.page(self.stored.next_height(), self.node_height[self.listing]);
            if !settled && self.rng.below(3) == 0 {
                // an honest node's page has a budget too
                let (from, next) = (page["from_height"].as_u64().unwrap(), page["next_height"].as_u64().unwrap());
                if next > from + 1 {
                    Self::cut_page(&mut page, from + self.rng.below(next - from - 1));
                    self.stats.pages_cut += 1;
                }
            }
            page
        };
        let page = ListingPage::from_json(&page.to_string()).unwrap();
        let mut s = self.stored.clone();
        let key = if view_only { self.alice.incoming_viewing_key() } else { self.alice.scan_key() };
        match s.scan(&page, &key) {
            Ok(r) => {
                // the wallet's own change does not depend on what the listing served as its
                // ciphertext: when the listing shows the transaction, the change note is there
                for p in s.pending().iter().filter(|p| p.status == PendingStatus::SeenMined && p.seen_height.is_some_and(|h| h >= page.from_height)) {
                    if let Some(c) = p.change.as_ref().filter(|c| c.r.is_some() && c.value > 0) {
                        assert!(s.notes().iter().any(|n| n.cm == c.cm && n.value == c.value), "seed {seed}: the listing showed the wallet's own transaction and its change is not stored");
                    }
                }
                // every note the scan stored OPENS its commitment, whatever it was taken from
                // (a ciphertext, or the wallet's own record): value, this wallet's pk, its rho, r
                for n in r.received.iter().filter_map(|&p| s.note_at(p)) {
                    let note = Note { value: n.value, pk: self.pk[0], rho: digest_from_bytes(&n.rho.0).unwrap(), r: digest_from_bytes(&n.r.0).unwrap() };
                    assert_eq!(digest_to_bytes(&note.commitment()), n.cm.0, "seed {seed}: a stored note does not open its commitment");
                }
                // the pending entries are untouched by whatever the listing does to positions
                assert_eq!(s.pending().len(), self.stored.pending().len(), "seed {seed}: a scan changed the number of pending entries");
                for (a, b) in s.pending().iter().zip(self.stored.pending()) {
                    assert!((&a.nullifiers, &a.outputs, &a.input_cms, a.expiry_height) == (&b.nullifiers, &b.outputs, &b.input_cms, b.expiry_height), "seed {seed}: a scan changed what a pending entry is held by");
                }
                assert_eq!(s.view_only_since().is_some(), view_only, "seed {seed}: the view-only mark follows the key of the last scan");
                self.stats.lying_pages_accepted += self.liar[self.listing] as usize;
                self.stats.view_only_scans += view_only as usize;
                if self.persist(s) {
                    self.viewed |= view_only;
                }
                if r.leaf_mismatch {
                    self.stats.leaf_mismatches += 1;
                    return Err(());
                }
                Ok(r.at_tip)
            }
            // "a `listing:` error: rebuild from rescan_state against another node"
            Err(WalletError::Listing(_)) | Err(WalletError::RescanRequired) => Err(()),
            Err(e) => panic!("seed {seed}: scan failed with {e}"),
        }
    }

    /// NOTES §6, `L := next node not in bad`.
    fn next_listing(&mut self) {
        let n = self.nodes.len();
        if self.bad.len() >= n {
            // "stop and tell the user": more than a minority lies, or every node was listed
            // from while another was lying. The user starts again.
            self.bad.clear();
            self.stats.all_bad += 1;
        }
        for k in 1..=n {
            let next = (self.listing + k) % n;
            if !self.bad.contains(&next) {
                self.listing = next;
                break;
            }
        }
        self.stats.rotations += 1;
        (self.ahead, self.behind) = (0, 0);
    }

    /// NOTES §6, `RESCAN(L)`.
    fn rescan(&mut self) {
        self.bad.insert(self.listing);
        let s = self.stored.fresh_for_rescan();
        // every lock is carried over, held by what it was held by
        assert_eq!(s.pending().len(), self.stored.pending().len());
        if self.persist(s) {
            self.stats.rescans += 1;
            self.viewed = false;
        }
        self.next_listing();
    }

    /// What the nodes answer to "what is the pool state". Honest nodes: the truth at THEIR tip
    /// (`settled`: all of them at the chain's tip; otherwise wherever they stand, up to 200
    /// blocks behind, and now and then no answer at all). Liars: anything.
    fn reports(&mut self, settled: bool) -> Vec<StateReport> {
        self.follow();
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
                out.push(self.chain.report(&id, self.node_height[i]));
                continue;
            }
            // the stale-quorum adversary: the TRUE state of the height an honest node stands at
            if let Some(x) = self.stale.filter(|_| self.rng.below(4) != 0) {
                out.push(self.chain.report(&id, x));
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

    /// NOTES §6 steps 2 and 3: every node is asked, the reports of the last rounds are kept and
    /// handed in with the new ones, and the documented rules follow the result.
    /// `Some(report)`: the check left nothing to do (the listing is neither refuted nor ahead).
    fn confirm(&mut self, settled: bool, at_tip: bool) -> Option<ConfirmReport> {
        let seed = self.seed;
        self.round_no += 1;
        let fresh = self.reports(settled);
        let now = self.round_no;
        self.cache.retain(|(round, _)| round + 2 >= now);
        self.cache.extend(fresh.into_iter().map(|r| (now, r)));
        let excess = self.cache.len().saturating_sub(1_024);
        self.cache.drain(..excess);
        let reports: Vec<StateReport> = self.cache.iter().map(|(_, r)| r.clone()).collect();
        let before = self.stored.clone();
        let mut s = self.stored.clone();
        let c = s.confirm_state(&reports).unwrap();
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
        // the quorum's tip is a height the chain has reached; with every honest node at the tip
        // and answering it IS the tip, whatever the liars claim
        if let Some(t) = c.quorum_tip {
            assert!(t <= self.chain.height && (!settled || t == self.chain.height), "seed {seed}: the quorum's tip {t} is not where the honest nodes are ({})", self.chain.height);
            assert_eq!(c.confirmed_lag, s.confirmed_height().map(|h| t.saturating_sub(h)), "seed {seed}: the confirmed lag is quorum_tip − confirmed height");
        }
        // what each configured node said, per height: (anything false, anything at all)
        let truth_at = |h: u64| (h <= self.chain.height).then(|| self.chain.state_at(h));
        let mut said: BTreeMap<(u64, String), bool> = BTreeMap::new();
        for r in &reports {
            let Some(id) = canonical_node_id(&r.node_id).ok().filter(|id| self.nodes.contains(id)) else { continue };
            let is_true = truth_at(r.height).is_some_and(|t| (r.tree_root, r.nullifier_acc, r.ciphertext_acc, r.note_count, r.nullifier_count) == (t.root, t.nf_acc, t.ct_acc, t.notes, t.nfs));
            *said.entry((r.height, id)).or_insert(true) &= is_true;
        }
        // a report for a height the wallet cannot compare (not scanned, or its state dropped
        // from the 256 kept) is counted as that and as nothing else
        let incomparable = said.keys().filter(|(h, _)| before.state_at(*h).is_none()).count();
        assert_eq!(c.not_comparable, incomparable, "seed {seed}: reports for heights the wallet holds no state of are 'not comparable' — never a match, never a dissent");
        self.stats.evicted_reports += said.keys().filter(|(h, _)| before.state_at(*h).is_none() && before.scanned_height().is_some_and(|top| *h <= top)).count();
        // a node that told the truth about a height at which the wallet's state IS the chain's
        // is never named as dissenting
        for d in &c.dissenting {
            let wallet_true = before.state_at(d.height).zip(truth_at(d.height)).is_some_and(|(m, t)| (m.tree_root, m.nullifier_acc, m.ciphertext_acc, m.note_count, m.nullifier_count) == (t.root, t.nf_acc, t.ct_acc, t.notes, t.nfs));
            let node_true = said.get(&(d.height, d.node_id.clone())).copied().unwrap_or(false);
            assert!(!(wallet_true && node_true), "seed {seed}: node {} told the truth about height {} and is named as dissenting", d.node_id, d.height);
        }
        // a listing the chain's is never "refuted" while only liars can contradict it
        if c.listing_refuted {
            let wallet_true = before.scanned_height().is_some_and(|top| top <= self.chain.height && c.conflicts.iter().all(|h| before.state_at(*h).zip(truth_at(*h)).is_some_and(|(m, t)| (m.tree_root, m.nullifier_acc, m.note_count, m.nullifier_count, m.ciphertext_acc) == (t.root, t.nf_acc, t.notes, t.nfs, t.ct_acc))));
            assert!(!wallet_true, "seed {seed}: a true listing was refuted by a lying minority");
        }
        // RW4-1: the embargo base of a state without lock history
        if c.embargo_base_set {
            let SpendEmbargo::Until { first_confirmed, base, until, waived } = s.spend_embargo() else { panic!("seed {seed}: a base was set and the state has none") };
            assert_eq!(Some(first_confirmed), c.matched_height);
            self.stats.embargo_bases += 1;
            if waived {
                assert!(s.sole_copy_asserted() && c.highest_reported.is_none_or(|t| t <= first_confirmed), "seed {seed}: the user's statement was honoured although a configured node is ahead");
            } else {
                // G4: a lying or silent minority adds at most the lag bound
                assert!(base >= first_confirmed && until == base + EXPIRY_BOUND && base <= self.chain.height + RESTORE_LAG_BOUND_BLOCKS, "seed {seed}: the embargo base {base} is out of bounds (true height {})", self.chain.height);
                // G1: nothing an earlier copy built can be mined above `until` — in a world whose
                // honest nodes are at most 200 blocks behind, against liars that replay a true
                // old state to a quorum
                for a in self.attempts.iter().filter(|a| !a.known && self.chain.can_still_be_mined(&a.tx)) {
                    assert!(a.tx.expiry() <= until, "seed {seed}: the embargo ends at confirmed height {until} while an earlier transaction is valid until {} (first confirmed {first_confirmed}, true height {})", a.tx.expiry(), self.chain.height);
                }
                self.stats.stale_bases += (first_confirmed + 64 < self.chain.height) as usize;
            }
            self.stale = None;
        }
        if !self.persist(s) {
            return None;
        }
        // ---- the documented rules (NOTES §6 step 3) -----------------------------------------------------
        if c.listing_refuted {
            self.stats.refuted += 1;
            self.rescan();
            return None;
        }
        if c.listing_ahead {
            // not on the first sighting: an honest listing is ahead of a quorum that is behind
            self.ahead += 1;
            if self.ahead >= 3 {
                self.stats.ahead += 1;
                self.rescan();
            }
            return None;
        }
        self.ahead = 0;
        // the listing does not get the wallet where the quorum is: list from the next node
        // (no rescan — what was read may well be true)
        if at_tip && c.quorum_tip.is_some_and(|t| self.stored.confirmed_height().is_none_or(|h| h < t)) {
            self.behind += 1;
            if self.behind >= 2 {
                self.next_listing();
            }
        } else {
            self.behind = 0;
        }
        Some(c)
    }

    // ---- the device ------------------------------------------------------------------------------------

    /// NOTES §6 step 5: a payment is offered only if this round's state check matched at the
    /// scanned tip and the core says a spend can be built now.
    fn pay(&mut self, c: &ConfirmReport) {
        let seed = self.seed;
        let st = self.stored.clone();
        if c.matched_height.is_none() || st.confirmed_height() != st.scanned_height() {
            return;
        }
        let status = st.spend_status(c.quorum_tip);
        if !status.can_spend_now {
            // whatever the reason, the builder refuses too — the user interface is not what
            // keeps the embargo or a view-only state from spending
            if matches!(status.reason, Some("embargo") | Some("view_only")) {
                if let Some(p) = st.unspent().find(|n| n.confirmed && !st.is_locked(n.position)).map(|n| n.position) {
                    let (label, to) = (self.label("refused"), self.bob.address());
                    let spend = SpendOptions { chain_id: CHAIN, inputs: &[p], expiry_height: None, allow_unverified: true, max_fee: None };
                    let r = deterministic::transfer_locked(&st, st.revision(), &self.alice, &TransferParams { spend, recipient: &to, amount: 1, fee: Q }, &label);
                    match (status.reason, r.err()) {
                        (Some("embargo"), Some(WalletError::RestoredRecently { .. })) => self.stats.embargo_refusals += 1,
                        (Some("view_only"), Some(WalletError::ViewOnly)) => self.stats.view_only_refusals += 1,
                        (reason, e) => panic!("seed {seed}: the state cannot spend ({reason:?}) and the builder answered {e:?}"),
                    }
                }
            }
            return;
        }
        // G1 across a restore: the core lets this state spend ⇒ nothing an earlier copy built
        // can still be mined. (Then the user learns what became of the payments that were out.)
        for a in self.attempts.iter().filter(|a| !a.known) {
            assert!(self.chain.is_mined(&a.tx) || !self.chain.can_still_be_mined(&a.tx), "seed {seed}: the core lets a restored state spend while an earlier transaction can still be mined (expiry {}, true height {})", a.tx.expiry(), self.chain.height);
        }
        let mut ended = false;
        for (i, intent) in self.intents.iter_mut().enumerate().filter(|(_, x)| x.state == IntentState::Unknown) {
            let paid = self.attempts.iter().any(|a| a.intent == i && self.chain.is_mined(&a.tx));
            intent.state = if paid { IntentState::Paid } else { IntentState::Failed };
            ended = true;
        }
        self.stats.embargo_ended += ended as usize;
        self.probes(&st);

        let retry = (0..self.intents.len()).find(|&i| self.intents[i].state == IntentState::Failed);
        let (amount, payee) = match retry {
            Some(i) => (self.intents[i].amount, self.intents[i].payee),
            None => {
                let amount = [Q, 2 * Q, 3 * Q, 3 * Q + Q / 2, 7 * Q, 11 * Q][self.rng.below(6) as usize];
                let payee = match self.rng.below(10) {
                    0 => Payee::Own,
                    1 => Payee::BobUnreadable,
                    _ => Payee::Bob,
                };
                (amount, payee)
            }
        };
        let Ok(sel) = select_inputs(&st, amount, Q) else { return };
        assert!(sel.positions.iter().all(|&p| !st.is_locked(p)), "seed {seed}: coin selection offered a locked note");
        // what the transaction must move: from the BOOKS and the request
        let total = self.book_value(&st, &sel.positions).unwrap_or_else(|| panic!("seed {seed}: coin selection offered a note that is not an unspent note of the wallet on the true chain at the confirmed height"));
        assert_eq!(total, sel.total, "seed {seed}: the selection's total is not the value of the notes");
        let to = match payee {
            Payee::Bob => self.bob.address(),
            Payee::Own => self.alice.address(),
            Payee::BobUnreadable => ShieldedAddress { pk: self.bob.address().pk, ek: self.alice.address().ek },
        };
        let label = self.label("pay");
        let confirmed = st.confirmed_height().unwrap();
        let expiry = match self.rng.below(8) {
            0 => Some(confirmed + EXPIRY_BOUND), // the longest the builders accept
            1 => Some(confirmed + 1 + self.rng.below(EXPIRY_BOUND)),
            _ => None,
        };
        let spend = SpendOptions { chain_id: CHAIN, inputs: &sel.positions, expiry_height: expiry, allow_unverified: false, max_fee: None };
        let built = deterministic::transfer_locked(&st, st.revision(), &self.alice, &TransferParams { spend, recipient: &to, amount, fee: Q }, &label);
        let (tx, locked) = match built {
            Ok(x) => x,
            // the pending list is full
            Err(WalletError::Request(_)) => return,
            Err(e) => panic!("seed {seed}: the core said a spend can be built and a selected payment could not be: {e}"),
        };
        let owner = if payee == Payee::Own { Who::Alice } else { Who::Bob };
        let t = Tx::checked(
            &tx,
            &[(OutputRole::Payment, owner, amount, owner != Who::Alice), (OutputRole::Change, Who::Alice, total - amount - Q, false)],
            (0, 0, Q),
            &self.pk,
            "a payment of the wallet",
        );
        // G3, first half: the expiry is bounded by the TRUE height, whatever any node claimed
        assert!(t.expiry() <= self.chain.height + EXPIRY_BOUND, "seed {seed}: expiry {} is more than 128 blocks above the true height {}", t.expiry(), self.chain.height);
        assert_eq!(t.expiry(), expiry.unwrap_or(confirmed + 64), "seed {seed}: the expiry is the one asked for, or the confirmed height + 64");
        assert_eq!(t.anchor(), self.chain.state_at(confirmed).root, "seed {seed}: the anchor is the chain's root at the confirmed height");
        // G1: nothing this device built earlier from one of these notes is mined or can still be
        let nfs = [t.nf(0), t.nf(1)];
        for a in self.attempts.iter().filter(|a| a.known && (nfs.contains(&a.tx.nf(0)) || nfs.contains(&a.tx.nf(1)))) {
            // (mined ABOVE the confirmed height the wallet cannot know yet — a state rescanned
            // from a node that is behind: the new transaction is then dead on arrival, its
            // nullifier is spent)
            assert!(self.chain.mined_at.get(&a.tx.id()).is_none_or(|h| *h > confirmed), "seed {seed}: a note spent by a transaction of this wallet mined at or below the confirmed height is spent again");
            assert!(!self.chain.can_still_be_mined(&a.tx), "seed {seed}: a note is handed out again while an earlier transaction from it can still be mined");
        }
        // the returned state holds the lock; the caller's is untouched
        assert!(sel.positions.iter().all(|&p| locked.is_locked(p) && !st.is_locked(p)) && locked.pending().len() == st.pending().len() + 1);
        let record = locked.pending().last().unwrap().clone();
        assert_eq!(record.expiry_height, t.expiry());
        // a payment is "to self" only for the wallet's whole address; for anybody else the
        // wallet keeps no claim on the payment output
        assert_eq!(record.own_payment.is_some(), payee == Payee::Own, "seed {seed}: the pending record's own payment does not follow the recipient");
        // THE RULE: persist the returned state (with the envelope), then submit. Not persisted ⇒ not submitted.
        if !self.persist(locked) {
            return;
        }
        let intent = match retry {
            Some(i) => {
                self.stats.retries += 1;
                i
            }
            None => {
                self.intents.push(Intent { amount, payee, state: IntentState::Open });
                self.intents.len() - 1
            }
        };
        self.intents[intent].state = IntentState::Open;
        self.attempts.push(Attempt { tx: t, nullifiers: record.nullifiers.clone(), outputs: record.outputs.clone(), input_cms: record.input_cms.clone(), intent, known: true });
        let i = self.attempts.len() - 1;
        self.envelopes.push(i);
        self.stats.payments += 1;
        self.stats.two_input_payments += (sel.positions.len() == 2) as usize;
        self.stats.max_expiry_payments += (expiry == Some(confirmed + EXPIRY_BOUND)) as usize;
        self.stats.self_payments += (payee == Payee::Own) as usize;
        self.stats.unreadable_payments += (payee == Payee::BobUnreadable) as usize;
        match self.rng.below(10) {
            // a crash between the persist and the submit: it never leaves the device. The client
            // may say so (`abandon_unsubmitted`) — which releases nothing
            0 => {
                self.stats.unanswered += 1;
                if self.rng.below(2) == 0 {
                    let mut s = self.stored.clone();
                    assert!(s.abandon_unsubmitted(&record.nullifiers[0].0) && s.is_locked(sel.positions[0]));
                    self.persist(s);
                }
            }
            _ => self.submit(i),
        }
    }

    /// The envelope goes to a node: the one the client lists from, or any other. A lying node
    /// keeps it (three times in four); an honest one has it mined in the next block.
    fn submit(&mut self, i: usize) {
        let node = if self.rng.below(2) == 0 { self.listing } else { self.rng.below(self.nodes.len() as u64) as usize };
        if self.liar[node] && self.rng.below(4) != 0 {
            if !self.withheld.contains(&i) {
                self.withheld.push(i);
                self.stats.withheld += 1;
            }
        } else {
            let t = self.attempts[i].tx.clone();
            self.mine(&t);
        }
    }

    /// NOTES §6 step 5, "a failed or unanswered submit": THE SAME envelope again, for every
    /// entry that is still pending — never a new transaction.
    fn resubmit(&mut self) {
        let pending: Vec<Vec<B32>> = self.stored.pending().iter().map(|p| p.nullifiers.clone()).collect();
        self.envelopes.retain(|&i| pending.contains(&self.attempts[i].nullifiers));
        for i in self.envelopes.clone() {
            if !self.chain.is_mined(&self.attempts[i].tx) && self.rng.below(4) == 0 {
                self.stats.resubmitted += 1;
                self.submit(i);
            }
        }
    }

    /// What a client must never get away with, tried on the state in hand: each call must be
    /// refused and leave the state as it was.
    fn probes(&mut self, st: &WalletState) {
        let seed = self.seed;
        let (alice, bob) = (self.alice.address(), self.bob.address());
        let confirmed = st.confirmed_height().unwrap();
        let which = self.rng.below(8);
        let label = self.label("probe");
        let free = st.unspent().filter(|n| n.confirmed && !st.is_locked(n.position) && n.value > 2 * Q).map(|n| n.position).next();
        let build = |positions: &[u64], to: &ShieldedAddress, expiry: Option<u64>, label: &str| {
            let spend = SpendOptions { chain_id: CHAIN, inputs: positions, expiry_height: expiry, allow_unverified: true, max_fee: None };
            deterministic::transfer_locked(st, st.revision(), &self.alice, &TransferParams { spend, recipient: to, amount: Q, fee: Q }, label)
        };
        match which {
            // a note that a pending transaction of this device spends: asked for directly, not
            // through coin selection
            0 => {
                let locked = st.unspent().find(|n| st.is_locked(n.position) && n.value >= 2 * Q).map(|n| n.position);
                if let Some(p) = locked {
                    assert!(matches!(build(&[p], &bob, None, &label).err(), Some(WalletError::NoteLocked)), "seed {seed}: the builder handed out a locked note");
                    self.stats.locked_refused += 1;
                }
            }
            // an expiry beyond the bound
            1 => {
                if let Some(p) = free {
                    let far = confirmed + EXPIRY_BOUND + 1 + self.rng.below(1_000);
                    assert!(build(&[p], &bob, Some(far), &label).is_err(), "seed {seed}: an expiry {} blocks above the confirmed height was accepted", far - confirmed);
                    assert!(build(&[p], &bob, Some(confirmed), &label).is_err(), "seed {seed}: an expiry at the confirmed height was accepted");
                    self.stats.long_expiry_refused += 1;
                }
            }
            // the hostile payee's address: this wallet's pk, the payee's encryption key
            2 => {
                if let Some(p) = free {
                    let crafted = ShieldedAddress { pk: alice.pk, ek: bob.ek };
                    assert!(matches!(build(&[p], &crafted, None, &label).err(), Some(WalletError::MixedOwnAddress)), "seed {seed}: a payment to the wallet's own pk under another encryption key was built");
                    self.stats.mixed_refused += 1;
                }
            }
            // two tabs: two different transactions from one revision are two different revisions
            3 => {
                if let Some(p) = free {
                    if let (Ok((_, a)), Ok((_, b))) = (build(&[p], &bob, None, &label), build(&[p], &bob, None, &format!("{label}-tab-b"))) {
                        assert_eq!(a.revision(), b.revision());
                        assert!(a.revision_id() != b.revision_id() && b.expect_revision_id(&a.revision_id()).is_err() && a.expect_revision_id(&a.revision_id()).is_ok(), "seed {seed}: two different states are one revision");
                        self.stats.two_tabs += 1;
                    }
                }
            }
            _ => {}
        }
    }

    /// The adversary releases a transaction it kept — whenever it likes.
    fn release(&mut self) {
        let Some(i) = self.rng.pick(&self.withheld) else { return };
        if self.chain.is_mined(&self.attempts[i].tx) {
            return;
        }
        let tx = self.attempts[i].tx.clone();
        if self.mine(&tx) {
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
        self.settle_nodes();
        for _ in 0..3 {
            if self.chain.height != tx.expiry() - 1 {
                break;
            }
            self.round(4, true);
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

    /// NOTES §6 step 4.
    fn resolve(&mut self) {
        let mut s = self.stored.clone();
        let r = s.resolve();
        let seed = self.seed;
        let confirmed = s.confirmed_height();
        // G3, second half: what is left is not yet due …
        assert!(s.pending().iter().all(|p| confirmed.is_none_or(|c| p.expiry_height > c)), "seed {seed}: an entry is still pending although the confirmed height has reached its expiry");
        // … and is not on the confirmed chain: a transaction mined AT or below the confirmed
        // height is settled by this call, not by a later one
        if let Some(c) = confirmed {
            for p in s.pending().iter().filter(|p| !p.legacy && p.outputs.len() == 2) {
                let a = &self.attempts[self.attempts_for(p)[0]];
                assert!(self.chain.mined_at.get(&a.tx.id()).is_none_or(|h| *h > c), "seed {seed}: a transaction mined at height {:?} is still pending at confirmed height {c}", self.chain.mined_at.get(&a.tx.id()));
            }
        }
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
                // (a lock migrated from format 1 stands for every attempt from its note, also
                // one that was mined long ago and settled then)
                if p.legacy && self.chain.is_mined(&a.tx) {
                    continue;
                }
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

    /// **The client loop of `NOTES.md` §6, as written there** — steps 1 to 5; `upto` cuts the
    /// round after that step (the user closes the application). `true`: a whole state check
    /// was made and left nothing to do.
    fn round(&mut self, upto: u8, settled: bool) -> bool {
        // 1. pages from L, with the FULL key, until the tip or a page budget
        let mut at_tip = false;
        for _ in 0..6 {
            match self.sync_once(settled, false) {
                Ok(true) => {
                    at_tip = true;
                    break;
                }
                Ok(false) => {}
                Err(()) => {
                    self.rescan();
                    return false;
                }
            }
        }
        if upto < 3 {
            return false;
        }
        // 2 + 3. every node is asked; confirm_state; the rules
        let Some(c) = self.confirm(settled, at_tip) else { return false };
        if upto < 4 {
            return true;
        }
        // 4. resolve_pending
        self.resolve();
        if upto < 5 {
            return true;
        }
        // 5. the same envelope again for what is still out; a payment if the rules allow one
        self.resubmit();
        if at_tip && !settled {
            self.pay(&c);
        }
        true
    }

    /// The device is lost and the wallet restored from the phrase: an empty state, no lock — and
    /// NO statement that no other copy has a payment in flight. Two times in three the
    /// adversary answers the restored device with a stale quorum: it lists and reports the true
    /// chain as it was where the most lagging honest node stands.
    fn restore(&mut self) {
        self.stored = self.new_state(false);
        for a in self.attempts.iter_mut() {
            a.known = false;
        }
        for x in self.intents.iter_mut().filter(|x| x.state == IntentState::Open) {
            x.state = IntentState::Unknown;
        }
        self.envelopes.clear();
        self.new_session();
        self.viewed = false;
        self.listing = self.rng.below(self.nodes.len() as u64) as usize;
        self.follow();
        let lagging = (0..self.nodes.len()).filter(|&i| !self.liar[i]).min_by_key(|&i| self.node_height[i]);
        let liars: Vec<usize> = (0..self.nodes.len()).filter(|&i| self.liar[i]).collect();
        if let (Some(j), Some(l), true) = (lagging, self.rng.pick(&liars), self.rng.below(3) != 0) {
            // the node stopped following a while ago: the chain has moved on since (never
            // more than the world's bound on honest lag)
            self.stalled[j] = true;
            let on = self.chain.height + self.rng.below(HONEST_LAG_MAX);
            self.chain.advance_to(on);
            self.follow();
            self.stale = Some(self.node_height[j]);
            self.listing = l;
        }
        self.stats.restores += 1;
    }

    /// The state written back in an older format (as that format would have held it) and read
    /// again: the migration to the current format. Not while a transaction of an EARLIER copy
    /// can still be mined: an older format had no embargo, so a migrated state has none — the
    /// state of a restored device was never in an older format.
    fn migrate(&mut self) {
        if self.attempts.iter().any(|a| !a.known && self.chain.can_still_be_mined(&a.tx)) {
            return;
        }
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
        let format = match self.rng.below(4) {
            0 if v1_possible => 1,
            1 if !any_legacy && has_its_notes && a.pending().iter().all(|p| p.change.is_some()) => 2,
            2 => 3,
            _ => 4,
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
                // formats 3 and 4: the current shape without what the later formats added
                let mut v: serde_json::Value = serde_json::from_str(&a.to_json().unwrap()).unwrap();
                v["version"] = serde_json::json!(format);
                let dropped: &[&str] = if format == 3 { &["nodes", "max_unspent_notes", "ciphertext_acc", "revision_id", "spend_embargo", "sole_copy_asserted", "view_only_since", "own_shields"] } else { &["revision_id", "spend_embargo", "sole_copy_asserted", "view_only_since", "own_shields"] };
                for k in dropped {
                    v.as_object_mut().unwrap().remove(*k);
                }
                for p in v["pending"].as_array_mut().unwrap() {
                    if format == 3 {
                        for k in ["own_payment", "abandoned_hint"] {
                            p.as_object_mut().unwrap().remove(k);
                        }
                        if let Some(c) = p["change"].as_object_mut() {
                            c.remove("r");
                        }
                    }
                    // format 4 could hold an entry that names one position twice (RW4-5): such
                    // a state is read again, with its locks
                    if format == 4 && p["inputs"].as_array().is_some_and(|i| i.len() == 2) && self.seed % 2 == 0 {
                        p["inputs"][1] = p["inputs"][0].clone();
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
                assert!(kept, "seed {}: the migration to format 5 from {format} lost a lock", self.seed);
            }
        }
        assert!(format == 1 || migrated.pending().len() == before.len(), "seed {}: the migration kept every entry", self.seed);
        assert_eq!(migrated.spend_embargo(), SpendEmbargo::NotRequired, "a migrated state is a device's own state");
        if format == 4 {
            // in place: nothing is rescanned, what was confirmed stays confirmed, and every
            // entry is what it was (but for the positions it shows, which are derived)
            let plain = |p: &PendingTx| {
                let mut p = p.clone();
                p.inputs.clear();
                p
            };
            assert!(migrated.pending().iter().map(plain).eq(before.iter().map(plain)), "seed {}: the migration from format 4 changed a pending entry", self.seed);
            assert_eq!(migrated.notes(), a.notes(), "seed {}: the migration from format 4 changed the notes", self.seed);
            // (format 4 had no view-only mark: it is set again iff a note lacks its nullifier)
            assert_eq!(migrated.view_only_since().is_some(), a.notes().iter().any(|n| n.nullifier.is_none()) || a.balances().received_spend_unknown > 0);
            if a.view_only_since().is_none() {
                assert_eq!(migrated.balances(), a.balances(), "seed {}: the migration from format 4 changed a balance", self.seed);
            }
            assert_eq!((migrated.nodes(), migrated.confirmed_height(), migrated.notes().len()), (a.nodes(), a.confirmed_height(), a.notes().len()));
        } else {
            assert!(migrated.pending().iter().all(|p| p.status == PendingStatus::Pending) && migrated.nodes().is_empty() && migrated.confirmed_height().is_none());
            // the client configures its nodes again (a migrated state has none) — this step is not optional
            migrated.set_nodes(&self.nodes).unwrap();
            self.viewed = false;
        }
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
        // put it (a lock belongs to the commitment, not to a leaf position). A lock migrated
        // from format 1 knows one note, not the transaction: it holds an attempt only while that
        // attempt can still be mined (REVIEW_WALLET_4 RW4-6 — an attempt that is dead for good
        // and shared a note with a live one is not "held" by the live one's lock).
        for a in self.attempts.iter().filter(|a| a.known) {
            let held = pending.iter().any(|p| if p.legacy { self.chain.can_still_be_mined(&a.tx) && a.nullifiers.iter().all(|n| self.chain.note_spent_by(&n.0).is_none() || pending.iter().any(|q| q.legacy && q.nullifiers.contains(n))) } else { p.nullifiers == a.nullifiers });
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
        assert!(b.spendable <= b.confirmed && b.locked <= b.confirmed + b.unverified + b.received_spend_unknown);
        assert_eq!(b.unverified_spends, st.view_only_since().is_some());
        if b.unverified_spends {
            // a state that cannot see spends offers nothing to spend
            assert!(b.spendable == 0 && select_inputs(st, 1, Q).is_err(), "seed {seed} after {step}: a view-only state offers a note");
        } else {
            assert!(b.received_spend_unknown == 0 && st.notes().iter().all(|n| n.nullifier.is_some()), "seed {seed} after {step}: a note without a nullifier in a state that is not view-only");
        }
        match st.confirmed_height() {
            None => assert_eq!(b.confirmed + b.received_spend_unknown, 0, "seed {seed} after {step}: a confirmed balance without a confirmed height"),
            Some(h) => {
                assert!(h <= self.chain.height, "seed {seed} after {step}: a height was confirmed that the true chain has not reached");
                let truth = self.chain.balance(Who::Alice, h);
                assert!(b.confirmed <= truth, "seed {seed} after {step}: confirmed balance {} exceeds the true balance {truth} at height {h}", b.confirmed);
                // … note by note: a confirmed note is in the books, Alice's, with that value, and
                // on the chain by the confirmed height (the height a LISTING gives a transaction
                // is in no hash: a lying listing can move it up, never above what is confirmed)
                for n in st.notes().iter().filter(|n| n.confirmed) {
                    assert!(self.chain.notes.iter().any(|t| t.owner == Who::Alice && t.cm == n.cm.0 && t.value == n.value && t.created <= h), "seed {seed} after {step}: a confirmed note is not a note of the wallet on the true chain");
                }
            }
        }
        // the cap is exact: never more unspent notes FROM OTHERS than the cap (the wallet's own
        // outputs are stored whatever the count). On confirmed data — an unconfirmed listing can
        // dress a stranger's note up as the wallet's own output by regrouping nullifiers.
        let from_others = st.unspent().filter(|n| n.confirmed && self.chain.notes.iter().find(|t| t.cm == n.cm.0).is_none_or(|t| t.stranger)).count();
        // (the state's own cap: a state migrated from formats 1 to 3 has the default one)
        assert!(from_others <= st.max_unspent_notes(), "seed {seed} after {step}: {from_others} unspent notes from others are stored under a cap of {}", st.max_unspent_notes());
        // an embargo that has a base ends 128 blocks above it; a state without a base builds nothing
        if st.spend_embargo() == SpendEmbargo::AwaitingBase {
            assert!(st.confirmed_height().is_none() && st.spend_embargo_until().is_none() && !st.spend_status(None).can_spend_now, "seed {seed} after {step}: a state without an embargo base");
        }
    }

    /// **G3 / G4 as a bound.** The chain moves past every expiry (at most 128 blocks: checked
    /// above), the honest majority answers from the tip, the liars keep lying — and the client's
    /// documented loop must END, within `4·nodes + 8` rounds, with nothing pending, nothing
    /// locked, the tip confirmed and the confirmed balance equal to the true balance.
    fn drive_to_settlement(&mut self, what: &str) {
        let seed = self.seed;
        let last_expiry = self.stored.pending().iter().map(|p| p.expiry_height).max().unwrap_or(0);
        self.chain.advance_to(self.chain.height.max(last_expiry));
        self.settle_nodes();
        let tip = self.chain.height;
        let bound = 4 * self.nodes.len() + 8;
        let mut rounds = 0;
        self.no_crash = true;
        let mut clean = false;
        loop {
            let done = clean && self.stored.pending().is_empty() && self.stored.confirmed_height() == Some(tip);
            if done {
                break;
            }
            assert!(rounds < bound, "seed {seed}, {what}: not settled after {rounds} rounds with an honest majority reachable (pending {}, confirmed {:?}, scanned {:?}, tip {tip}, listing from a {} node)",
                self.stored.pending().len(), self.stored.confirmed_height(), self.stored.scanned_height(), if self.liar[self.listing] { "lying" } else { "honest" });
            rounds += 1;
            clean = self.round(4, true);
            self.check(what);
        }
        self.no_crash = false;
        self.stats.drives += 1;
        self.stats.drive_rounds_max = self.stats.drive_rounds_max.max(rounds);
        let b = self.stored.balances();
        assert_eq!(b.locked, 0, "seed {seed}, {what}: nothing is pending and something is locked");
        assert!(!b.unverified_spends, "seed {seed}, {what}: a round with the full key leaves no view-only state");
        // everything the wallet's policies do not leave out is there, confirmed and spendable
        let visible: u128 = self.chain.unspent_at(Who::Alice, tip).filter(|n| !(n.stranger && n.value < self.min_note)).map(|n| n.value as u128).sum();
        let over = self.stored.over_capacity();
        // (a state scanned with the viewing key did not see spends and counted spent notes
        // against the cap, as documented)
        if self.chain.alice_unspent_peak < self.cap && !self.viewed {
            assert_eq!(over.count, 0, "seed {seed}, {what}: notes counted as over capacity although the wallet never held {} unspent notes (peak {})", self.cap, self.chain.alice_unspent_peak);
            self.stats.cap_checked += 1;
        }
        // (pages scanned with the viewing key alone cannot tell the wallet's own small change
        // from a stranger's dust, as documented: such a state may show less until it is rescanned)
        if over.count == 0 && !self.viewed {
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
        let recovered = self.stored.over_capacity().count > 0;
        let wide = self.stored.fresh_for_rescan_with(Some(1), Some(MAX_UNSPENT_NOTES_LIMIT)).unwrap();
        self.stored = wide;
        self.viewed = false;
        let (min, cap) = (self.min_note, self.cap);
        (self.min_note, self.cap) = (1, MAX_UNSPENT_NOTES_LIMIT);
        self.drive_to_settlement("closing, everything stored");
        (self.min_note, self.cap) = (min, cap);
        self.stats.cap_recovered += recovered as usize;
        let tip = self.chain.height;
        let truth = self.chain.balance(Who::Alice, tip);
        let st = &self.stored;
        assert_eq!((st.balance(), st.balances().confirmed, st.below_minimum().count, st.over_capacity().count), (truth, truth, 0, 0), "seed {seed}: the wallet's balance IS the true balance\n{}", self.books());
        assert_eq!(st.unspent().count(), self.chain.unspent_at(Who::Alice, tip).count(), "seed {seed}: every unspent note is stored");
        assert!(st.unspent().all(|n| n.confirmed && st.tree().path(n.position).is_some()), "seed {seed}: confirmed, with its Merkle path");
        // the payee: each payment once. From the books …
        let mined = |i: usize| self.attempts.iter().any(|a| a.intent == i && self.chain.is_mined(&a.tx));
        let paid = |which: Payee| -> u128 { (0..self.intents.len()).filter(|&i| self.intents[i].payee == which && mined(i)).map(|i| self.intents[i].amount as u128).sum() };
        assert_eq!(self.chain.balance(Who::Bob, tip), paid(Payee::Bob) + paid(Payee::BobUnreadable) + self.other_paid, "seed {seed}: the payee holds each mined payment exactly once");
        // … and as Bob's own wallet sees it on an honest listing (the books against the code):
        // everything but what Bob asked to have encrypted to somebody else's key
        let mut bob = WalletState::with_limits(self.bob.address().pk, 1, MAX_UNSPENT_NOTES_LIMIT).unwrap();
        bob.scan(&ListingPage::from_json(&self.chain.page(0, tip).to_string()).unwrap(), &self.bob.scan_key()).unwrap();
        assert_eq!(bob.balance(), paid(Payee::Bob) + self.other_paid, "seed {seed}");
        // every payment the wallet reported is what happened
        for (i, x) in self.intents.iter().enumerate() {
            match x.state {
                IntentState::Paid => assert!(mined(i), "seed {seed}: the user was told a payment was made that was not"),
                IntentState::Failed => assert!(!mined(i), "seed {seed}: the user was told a payment failed that was made"),
                IntentState::Open | IntentState::Unknown => {}
            }
        }
        self.stats.blocks_with_several = self.chain.blocks_with_several;
    }

    fn step(&mut self, index: usize) -> &'static str {
        if self.burst_at == Some(index) {
            self.burst();
            return "280 pool-changing blocks";
        }
        match self.rng.below(128) {
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
            // the client's loop, cut after a random step …
            20..=35 => {
                self.round(1, false);
                "a round: pages only"
            }
            36..=47 => {
                self.round(3, false);
                "a round: pages and the state check"
            }
            48..=55 => {
                self.round(4, false);
                "a round: pages, the state check, resolve"
            }
            // … or whole
            56..=85 => {
                self.round(5, false);
                "a whole round"
            }
            86..=90 => {
                self.release();
                "the adversary releases a withheld transaction"
            }
            91..=92 => {
                self.release_in_the_last_block();
                "the adversary mines a withheld transaction in its last valid block"
            }
            93..=94 => {
                self.rescan();
                "rescan"
            }
            95..=98 => {
                self.migrate();
                "migration"
            }
            99..=100 => {
                if self.rng.below(2) == 0 {
                    self.restore();
                }
                "restore from the phrase"
            }
            101..=104 => {
                self.second_device_pays();
                "the second device pays"
            }
            105..=109 => {
                self.hostile_send();
                "the hostile sender"
            }
            110..=111 => {
                self.next_listing();
                "another listing node"
            }
            // an honest node stops following the chain (and stays up to 200 blocks behind) …
            112..=116 => {
                let honest: Vec<usize> = (0..self.nodes.len()).filter(|&i| !self.liar[i]).collect();
                if let Some(i) = self.rng.pick(&honest) {
                    self.follow();
                    self.stalled[i] = true;
                    self.stats.honest_stalls += 1;
                }
                "an honest node stalls"
            }
            // … or catches up
            117..=118 => {
                let i = self.rng.below(self.nodes.len() as u64) as usize;
                self.stalled[i] = false;
                "an honest node catches up"
            }
            // the background worker: pages with the viewing key alone
            119..=121 => {
                for _ in 0..2 {
                    if self.sync_once(false, true).is_err() {
                        self.rescan();
                        break;
                    }
                }
                "the worker scans with the viewing key"
            }
            122 => {
                self.new_session();
                "the application restarts"
            }
            _ => {
                self.drive_to_settlement("mid-run");
                "settlement"
            }
        }
    }
}

/// The seeds and the length of a run. Defaults: seeds 1 to 200, 280 steps each. `PROP_RUNS`,
/// `PROP_STEPS` and `PROP_SEED_BASE` (the first seed is base + 1) widen or move the range — CI
/// runs the default range and a second, randomly placed one, and the base is printed.
fn env(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

const RUNS: u64 = 200;
const STEPS: usize = 280;

#[test]
fn settlement_guarantees_hold_against_an_independent_model() {
    let (runs, steps, base) = (env("PROP_RUNS", RUNS), env("PROP_STEPS", STEPS as u64) as usize, env("PROP_SEED_BASE", 0));
    println!("settlement properties: seeds {} to {} (PROP_SEED_BASE={base}), {steps} steps each", base + 1, base + runs);
    let started = std::time::Instant::now();
    let mut total = Stats::default();
    let mut nodes_seen = BTreeSet::new();
    for seed in base + 1..=base + runs {
        let mut w = World::new(seed, steps);
        w.round(4, true);
        for i in 0..steps {
            let step = w.step(i);
            w.check(step);
        }
        w.close();
        nodes_seen.insert((w.stats.nodes, w.stats.liars));
        let s = &w.stats;
        macro_rules! add {
            ($($f:ident),*) => { $( total.$f += s.$f; )* };
        }
        add!(lying_pages, lying_pages_accepted, pages_cut, leaf_mismatches, confirm_calls, matched, matched_with_dissent, refuted, ahead, rotations, rescans, all_bad, states_lost, restores,
            embargo_bases, stale_bases, embargo_refusals, embargo_ended, payments, retries, two_input_payments, max_expiry_payments, self_payments, unreadable_payments, mixed_refused,
            locked_refused, long_expiry_refused, two_tabs, withheld, unanswered, resubmitted, released_late, released_last_block, release_refused, honest_silent, honest_stalls,
            own_outputs_blanked, leaves_shifted, second_device, second_device_same_inputs, hostile_notes, view_only_scans, view_only_refusals, bursts, evicted_reports,
            blocks_with_several, settled_mined, settled_expired, settled_superseded, drives, cap_checked, cap_recovered, liars, nodes);
        for i in 0..4 {
            total.migrations[i] += s.migrations[i];
        }
        total.drive_rounds_max = total.drive_rounds_max.max(s.drive_rounds_max);
        total.lag_max = total.lag_max.max(s.lag_max);
    }
    println!("settlement guarantees over {runs} runs of {steps} steps in {:.0?}; (nodes, liars) seen: {nodes_seen:?}\n{total:#?}", started.elapsed());
    // the runs did exercise what the guarantees are about (the thresholds are for the default range)
    if (runs, steps, base) != (RUNS, STEPS, 0) {
        return;
    }
    assert!(total.lying_pages_accepted > 1_000 && total.refuted > 200 && total.ahead > 20 && total.matched > 2_000 && total.matched_with_dissent > 500, "{total:?}");
    assert!(total.payments > 300 && total.retries > 30 && total.two_input_payments > 30 && total.withheld > 60 && total.released_late > 10 && total.release_refused > 20, "{total:?}");
    assert!(total.released_last_block > 5 && total.honest_silent > 1_000 && total.own_outputs_blanked > 5 && total.leaves_shifted > 60 && total.pages_cut > 500 && total.leaf_mismatches > 10, "{total:?}");
    assert!(total.settled_mined > 150 && total.settled_expired > 30 && total.settled_superseded > 15, "{total:?}");
    assert!(total.second_device > 300 && total.second_device_same_inputs > 10 && total.hostile_notes > 500 && total.states_lost > 500, "{total:?}");
    assert!(total.migrations.iter().all(|&m| m > 30) && total.restores > 100 && total.embargo_bases > 100 && total.stale_bases > 20 && total.embargo_refusals > 50 && total.embargo_ended > 10 && total.rescans > 500, "{total:?}");
    assert!(total.lag_max == HONEST_LAG_MAX && total.honest_stalls > 500 && total.view_only_scans > 300 && total.view_only_refusals > 5 && total.bursts > 15 && total.evicted_reports > 20 && total.blocks_with_several > 500, "{total:?}");
    assert!(total.max_expiry_payments > 20 && total.self_payments > 10 && total.unreadable_payments > 10 && total.mixed_refused > 20 && total.locked_refused > 10 && total.long_expiry_refused > 20 && total.two_tabs > 20, "{total:?}");
    assert!(total.drives > 3 * runs as usize && total.cap_checked > 2 * runs as usize && total.cap_recovered > 2 && total.drive_rounds_max >= 4, "{total:?}");
    assert!(nodes_seen.iter().any(|&(n, l)| n >= 5 && l >= 2) && nodes_seen.iter().any(|&(n, _)| n == 3) && nodes_seen.iter().any(|&(n, _)| n == 2) && nodes_seen.iter().any(|&(n, l)| n == 7 && l == 3), "{nodes_seen:?}");
}
