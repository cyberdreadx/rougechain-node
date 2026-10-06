//! Building the three transactions (spec §3, §5.5–5.7).
//!
//! Each builder returns the body (§3.2), its binding, the public inputs, the proof and the
//! envelope of spec §3.1 as the chain's own `TxV1`:
//!
//! * `shield_v2` — the envelope carries the funding account's public key and nonce and an empty
//!   `sig`; [`BuiltTx::signing_bytes`] are the bytes the account key must sign (the chain's
//!   `encode_tx_for_signing`, which covers body and proof). **This crate never sees the account's
//!   secret key**: the caller signs and calls [`BuiltTx::signed_envelope`].
//! * `shielded_transfer_v2`, `unshield_v2` — signer-less: `version` 1, empty `from_pub_key` and
//!   `sig`, `nonce` 0, no `signed_payload`, envelope `fee` 0.0. Ready to submit — and, once it
//!   has left the wallet, valid until `expiry_height` whatever any node answers: record it with
//!   [`crate::WalletState::mark_pending`] ([`BuiltTx::pending`]) before submitting.
//!
//! Randomness (spec §5.6, §5.7): the commitment randomness `r` of both outputs, `sk` / `rho` /
//! `r` of every dummy input, the `pk` and the ML-KEM key of a zero-value output, the ML-KEM
//! encapsulation randomness of both outputs, and the order of the two output slots all come from
//! ONE hedged generator per transaction (`entropy.rs`): a keyed hash of 32 fresh bytes of the
//! operating system's generator over a counter, the spending key and the transaction's inputs
//! and outputs, with a label per use and per slot. Nothing is derived from the recovery phrase
//! or stored state alone; a failed read of the operating system's generator is an error. The
//! proof's blinding is drawn (and hedged) inside `prove_spend`.
//!
//! The witness (it contains the spending key) is private to this module and is dropped — wiped —
//! as soon as the proof exists; a [`BuiltTx`] does not carry it.

use quantum_vault_shield_v2::pool::{SHIELD_V2_ANCHOR_WINDOW, SHIELD_V2_MIN_FEE_QUANTA, SHIELD_V2_POOL_CAP_QUANTA};
use quantum_vault_shield_v2::reference::{
    derive_nk, derive_pk, derive_rho, nullifier, root_from_path, Digest, Note, PublicInputs, ZERO_DIGEST,
};
use quantum_vault_shield_v2::{prove_spend, verify_spend, InputWitness, OutputWitness, SpendWitness};
use quantum_vault_types::{encode_tx_for_signing, TxPayload, TxV1};
use zeroize::{Zeroize, Zeroizing};

use crate::body::{binding_bytes, chain_tag, public_inputs_of, Body, TxKind};
use crate::entropy::{self, Draw, Entropy, Hedged, OsEntropy, TxRandom};
use crate::error::WalletError;
use crate::field;
use crate::keys::{account_from_pub_key, ShieldedAddress, ShieldedKeys};
use crate::note_enc::{encrypt_note, encrypt_to_nobody};
use crate::store::{PendingChange, PendingStatus, PendingTx, SpendInput, B32};

/// The default distance between the anchor's height and `expiry_height`
/// ([`TxContext::new`]): 64 blocks. Every client SHOULD use exactly this offset (a fixed offset
/// makes clients indistinguishable by their expiry — spec §5.8).
pub const DEFAULT_EXPIRY_OFFSET: u64 = 64;
/// The largest distance the builders accept: 128 blocks (the number is the anchor window's, and
/// nothing else is: the anchor window does NOT bound a transaction's life — it is a list of root
/// values, and in a pool without V2 transactions a root stays in it indefinitely; REVIEW_WALLET_2
/// I-1). **`expiry_height` is the only bound on how long a signer-less transaction stays valid**,
/// which is why the builders and `mark_pending` enforce this distance: the notes a pending
/// transaction locks are released in bounded time (REVIEW_WALLET_1 F-7).
pub const MAX_EXPIRY_OFFSET: u64 = SHIELD_V2_ANCHOR_WINDOW as u64;
/// The fee ceiling a builder applies when the caller sets none: 10 × the consensus minimum fee
/// (10 XRGE). A fee above the ceiling is refused, so that a unit mistake in a caller cannot burn
/// a note (REVIEW_WALLET_1 I-4).
pub const DEFAULT_MAX_FEE_FACTOR: u64 = 10;
pub const DEFAULT_MAX_FEE_QUANTA: u64 = SHIELD_V2_MIN_FEE_QUANTA * DEFAULT_MAX_FEE_FACTOR;

/// What every transaction needs from the chain, as plain values the caller read from
/// `/api/shield-v2/stats` (this crate makes no network call).
#[derive(Clone, Debug)]
pub struct TxContext {
    /// The chain id string, e.g. `rougechain-mainnet-1`.
    pub chain_id: String,
    /// A root in the anchor window (spec §4.3). For a transfer or unshield it must be the root
    /// the input notes' paths lead to — the wallet's own tree root once it has scanned to the tip
    /// (`WalletState::anchor`), which is the node's `latest_anchor`.
    pub anchor: [u8; 32],
    /// The height of the block whose pool state has that root: the height the wallet has scanned
    /// through (`WalletState::scanned_height`), the node's tip for a shield.
    pub anchor_height: u64,
    /// The last block height at which the transaction is valid. Must be above `anchor_height`
    /// and at most [`MAX_EXPIRY_OFFSET`] blocks after it; [`TxContext::new`] sets
    /// `anchor_height + DEFAULT_EXPIRY_OFFSET`.
    pub expiry_height: u64,
}

impl TxContext {
    /// The context with the default expiry, `anchor_height + 64`.
    pub fn new(chain_id: &str, anchor: [u8; 32], anchor_height: u64) -> Self {
        Self { chain_id: chain_id.to_string(), anchor, anchor_height, expiry_height: anchor_height.saturating_add(DEFAULT_EXPIRY_OFFSET) }
    }

    fn check(&self) -> Result<(), WalletError> {
        field::check(&self.anchor, "the anchor")?;
        if self.expiry_height <= self.anchor_height || self.expiry_height - self.anchor_height > MAX_EXPIRY_OFFSET {
            return Err(WalletError::Request(
                "expiry_height must be above the anchor's height and at most 128 blocks after it (default: anchor height + 64)".into(),
            ));
        }
        Ok(())
    }
}

/// What an output of a built transaction is, for the sender's own record (spec §5.4: the chain
/// does not keep the sender's history).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputRole {
    /// The note for the recipient (a shield's note, a transfer's payment).
    Payment,
    /// The sender's change (possibly zero).
    Change,
    /// The zero-value note to a random key (shield, unshield).
    Dummy,
}

/// The sender's record of one output. **Secret**: `value` and `r` open the note's commitment —
/// whoever holds them can prove or test what the note is. `Debug` prints neither.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct OutputRecord {
    /// 0 or 1: the slot in the body (`cm_out1` / `cm_out2`).
    pub slot: usize,
    pub role: OutputRole,
    pub value: u64,
    pub r: [u8; 32],
    pub cm: [u8; 32],
}

impl core::fmt::Debug for OutputRecord {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "OutputRecord {{ slot: {}, role: {:?}, value: <secret>, r: <secret>, cm: {} }}", self.slot, self.role, hex::encode(self.cm))
    }
}

/// Everything of a transaction except its proof.
pub struct UnprovenTx {
    pub kind: TxKind,
    /// The 2,546 bytes of spec §3.2.
    pub body: Vec<u8>,
    /// `binding_from_bytes(body)`, 32 bytes.
    pub binding: [u8; 32],
    pub public: PublicInputs,
    /// Secret: contains the spending key of every real input. Private; wiped on drop.
    witness: SpendWitness,
    pub outputs: [OutputRecord; 2],
    /// Leaf positions of the wallet's notes this transaction spends (empty for a shield).
    pub input_positions: Vec<u64>,
    pub input_total: u64,
    pub expiry_height: u64,
    shield_sender: Option<(String, u64)>,
}

/// A finished transaction. It does not contain the witness.
pub struct BuiltTx {
    pub kind: TxKind,
    pub body: Vec<u8>,
    pub binding: [u8; 32],
    /// The 216 public-input bytes of spec §2.8.
    pub public_inputs: Vec<u8>,
    pub proof: Vec<u8>,
    /// Secret (see [`OutputRecord`]): the sender's record of the two outputs.
    pub outputs: [OutputRecord; 2],
    /// Leaf positions of the wallet's notes this transaction spends (empty for a shield).
    pub input_positions: Vec<u64>,
    pub input_total: u64,
    pub expiry_height: u64,
    /// The envelope of spec §3.1. For a `shield_v2` its `sig` is still empty.
    pub envelope: TxV1,
    /// `shield_v2` only: the bytes the funding account's ML-DSA-65 key signs. `None` for the two
    /// signer-less types.
    pub signing_bytes: Option<Vec<u8>>,
}

fn nullifiers_of(body: &[u8]) -> [[u8; 32]; 2] {
    let mut nf = [[0u8; 32]; 2];
    nf[0].copy_from_slice(&body[74..106]);
    nf[1].copy_from_slice(&body[106..138]);
    nf
}

/// `cm_out1`, `cm_out2` of a body (spec §3.2: bytes 138..202).
fn output_commitments_of(body: &[u8]) -> [[u8; 32]; 2] {
    let mut cm = [[0u8; 32]; 2];
    cm[0].copy_from_slice(&body[138..170]);
    cm[1].copy_from_slice(&body[170..202]);
    cm
}

/// The record [`crate::WalletState::mark_pending`] takes: the two nullifiers and the two output
/// commitments (together they identify the transaction in a listing), the input notes, the change
/// the wallet expects and the expiry height. `None` for a shield (it spends no note).
fn pending_of(kind: TxKind, body: &[u8], outputs: &[OutputRecord; 2], inputs: &[u64], input_total: u64, expiry_height: u64) -> Option<PendingTx> {
    if kind == TxKind::Shield || inputs.is_empty() {
        return None;
    }
    let nf = nullifiers_of(body);
    let cm = output_commitments_of(body);
    let change = outputs.iter().find(|o| o.role == OutputRole::Change).map(|o| PendingChange { cm: B32(o.cm), value: o.value });
    Some(PendingTx {
        tx_type: kind.tx_type().to_string(),
        nullifiers: vec![B32(nf[0]), B32(nf[1])],
        outputs: vec![B32(cm[0]), B32(cm[1])],
        inputs: inputs.to_vec(),
        // filled in by `mark_pending` from the notes of the state
        input_cms: Vec::new(),
        input_total,
        change,
        expiry_height,
        status: PendingStatus::Pending,
        seen_height: None,
        rejected_hint: false,
        legacy: false,
    })
}

impl BuiltTx {
    pub fn nullifiers(&self) -> [[u8; 32]; 2] {
        nullifiers_of(&self.body)
    }

    /// `cm_out1`, `cm_out2`.
    pub fn output_commitments(&self) -> [[u8; 32]; 2] {
        output_commitments_of(&self.body)
    }

    /// What to hand to [`crate::WalletState::mark_pending`] BEFORE submitting a transfer or an
    /// unshield. `None` for a shield.
    pub fn pending(&self) -> Option<PendingTx> {
        pending_of(self.kind, &self.body, &self.outputs, &self.input_positions, self.input_total, self.expiry_height)
    }

    /// The envelope as the JSON the node's transaction routes take.
    pub fn envelope_json(&self) -> Result<String, WalletError> {
        serde_json::to_string(&self.envelope).map_err(|_| WalletError::Internal("envelope encoding"))
    }

    /// `shield_v2`: the envelope with the account signature (lowercase hexadecimal of the
    /// ML-DSA-65 signature over [`BuiltTx::signing_bytes`]) filled in.
    pub fn signed_envelope(&self, sig_hex: &str) -> Result<TxV1, WalletError> {
        if self.kind != TxKind::Shield {
            return Err(WalletError::Request("only a shield_v2 carries an account signature".into()));
        }
        if sig_hex.is_empty() || sig_hex.len() % 2 != 0 || !sig_hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            return Err(WalletError::Request("the signature must be non-empty lowercase hexadecimal".into()));
        }
        let mut tx = self.envelope.clone();
        tx.sig = sig_hex.to_string();
        Ok(tx)
    }
}

/// Where a transaction's randomness comes from.
pub(crate) enum Source<'a> {
    /// Production: the hedged generator, keyed by one read of this source (the operating
    /// system's generator; a test may inject a broken one to check the hedge).
    Hedged(&'a mut dyn Entropy),
    /// TEST VECTORS ONLY: the draws taken from this stream in order.
    #[cfg(any(test, feature = "test-vectors"))]
    Stream(&'a mut dyn Entropy),
}

fn generator<'a>(src: Source<'a>, secret: Option<&[u8; 32]>, transcript: &[u8]) -> Result<Box<dyn TxRandom + 'a>, WalletError> {
    Ok(match src {
        Source::Hedged(os) => Box::new(Hedged::new(os, secret, transcript)?),
        #[cfg(any(test, feature = "test-vectors"))]
        Source::Stream(e) => Box::new(entropy::Stream(e)),
    })
}

/// The transaction's inputs and outputs as the hedge's transcript: fixed-width fields in a fixed
/// order, the kind first. Holds note secrets; wiped on drop.
struct Transcript(Zeroizing<Vec<u8>>);

impl Transcript {
    fn new(kind: TxKind, ctx: &TxContext, fee: u64) -> Self {
        let mut t = Self(Zeroizing::new(Vec::with_capacity(1_536)));
        t.0.push(kind.byte());
        t.bytes(&chain_tag(&ctx.chain_id));
        t.bytes(&ctx.anchor);
        t.u64(ctx.expiry_height);
        t.u64(fee);
        t
    }
    fn bytes(&mut self, b: &[u8]) {
        self.0.extend_from_slice(&(b.len() as u64).to_le_bytes());
        self.0.extend_from_slice(b);
    }
    fn u64(&mut self, v: u64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn inputs(&mut self, notes: &[SpendInput]) {
        self.u64(notes.len() as u64);
        for n in notes {
            self.u64(n.position);
            self.u64(n.value);
            self.bytes(&n.rho);
            self.bytes(&n.r);
        }
    }
    fn address(&mut self, a: &ShieldedAddress) {
        self.bytes(&a.pk);
        self.bytes(&a.ek);
    }
}

/// One output before the slot order is drawn.
struct OutSpec<'a> {
    role: OutputRole,
    value: u64,
    pk: Digest,
    /// `None`: nobody (a zero-value note to a random key).
    ek: Option<&'a ShieldedAddress>,
}

fn check_fee(fee: u64, max_fee: Option<u64>) -> Result<(), WalletError> {
    if fee < SHIELD_V2_MIN_FEE_QUANTA {
        return Err(WalletError::FeeBelowMinimum { fee, min: SHIELD_V2_MIN_FEE_QUANTA });
    }
    let max = max_fee.unwrap_or(DEFAULT_MAX_FEE_QUANTA);
    if fee > max {
        return Err(WalletError::FeeAboveMaximum { fee, max });
    }
    Ok(())
}

fn dummy_input(rnd: &mut dyn TxRandom, slot: u8) -> Result<InputWitness, WalletError> {
    Ok(InputWitness {
        enabled: false,
        sk: entropy::digest(rnd, Draw::DummySk, slot)?,
        value: 0,
        rho: entropy::digest(rnd, Draw::DummyRho, slot)?,
        r: entropy::digest(rnd, Draw::DummyR, slot)?,
        index: 0,
        path: [ZERO_DIGEST; 32],
    })
}

fn real_input(keys: &ShieldedKeys, n: &SpendInput, anchor: &Digest) -> Result<InputWitness, WalletError> {
    let index = u32::try_from(n.position).map_err(|_| WalletError::State("a leaf position above 2^32".into()))?;
    if n.path.len() != 32 {
        return Err(WalletError::State("a Merkle path must have 32 siblings".into()));
    }
    let mut path = [ZERO_DIGEST; 32];
    for (slot, sib) in path.iter_mut().zip(&n.path) {
        *slot = field::digest(sib, "a Merkle sibling")?;
    }
    let w = InputWitness {
        enabled: true,
        sk: *keys.sk(),
        value: n.value,
        rho: field::digest(&n.rho, "a note's rho")?,
        r: field::digest(&n.r, "a note's r")?,
        index,
        path,
    };
    let cm = Note { value: w.value, pk: *keys.pk(), rho: w.rho, r: w.r }.commitment();
    if root_from_path(&cm, index, &w.path) != *anchor {
        return Err(WalletError::AnchorMismatch);
    }
    Ok(w)
}

fn check_notes(notes: &[SpendInput]) -> Result<(), WalletError> {
    if notes.is_empty() || notes.len() > 2 {
        return Err(WalletError::Request("a transaction spends one or two notes".into()));
    }
    if notes.len() == 2 && (notes[0].position == notes[1].position || notes[0].rho == notes[1].rho) {
        return Err(WalletError::Request("the same note in both input slots".into()));
    }
    Ok(())
}

/// One or two owned notes → the two circuit inputs (a fresh dummy fills the second slot). Checks
/// that every note's path leads to `anchor`. No intermediate heap buffer holds a witness (a freed
/// `Vec` would keep the spending key — REVIEW_WALLET_1 I-2).
fn real_inputs(keys: &ShieldedKeys, notes: &[SpendInput], anchor: &Digest, rnd: &mut dyn TxRandom) -> Result<[InputWitness; 2], WalletError> {
    check_notes(notes)?;
    let first = real_input(keys, &notes[0], anchor)?;
    let second = match notes.get(1) {
        Some(n) => real_input(keys, n, anchor)?,
        None => dummy_input(rnd, 1)?,
    };
    Ok([first, second])
}

struct Amounts {
    v_in: u64,
    v_out: u64,
    fee: u64,
    account: [u8; 32],
}

#[allow(clippy::too_many_arguments)]
fn assemble(
    kind: TxKind,
    ctx: &TxContext,
    inputs: [InputWitness; 2],
    outs: [OutSpec<'_>; 2],
    amounts: Amounts,
    spent: (&[SpendInput], u64),
    shield_sender: Option<(String, u64)>,
    rnd: &mut dyn TxRandom,
) -> Result<UnprovenTx, WalletError> {
    // the nullifiers first: each output's rho is H_rho(nf1, nf2, j) (spec §5.5)
    let nf = [
        nullifier(&derive_nk(&inputs[0].sk), &inputs[0].rho),
        nullifier(&derive_nk(&inputs[1].sk), &inputs[1].rho),
    ];
    if nf[0] == nf[1] {
        return Err(WalletError::Request("the two nullifiers are equal".into()));
    }
    // the slot order has no consensus meaning; a wallet SHOULD draw it (spec §5.5)
    let [a, b] = outs;
    let ordered = if entropy::coin(rnd, Draw::SlotOrder)? { [b, a] } else { [a, b] };

    let mut witness_out: [Option<OutputWitness>; 2] = [None, None];
    let mut records = [OutputRecord { slot: 0, role: OutputRole::Dummy, value: 0, r: [0u8; 32], cm: [0u8; 32] }; 2];
    let mut cm_out = [[0u8; 32]; 2];
    let mut kem_ct = [[0u8; crate::keys::KEM_CT_BYTES]; 2];
    let mut note_ct = [[0u8; crate::note_enc::NOTE_CT_BYTES]; 2];
    for (j, o) in ordered.iter().enumerate() {
        let slot = j as u8;
        let r = entropy::digest(rnd, Draw::OutputR, slot)?;
        let cm = Note { value: o.value, pk: o.pk, rho: derive_rho(&nf, j), r }.commitment();
        let cm_b = field::bytes(&cm);
        if cm_b == [0u8; 32] {
            // spec §3.6 check 8; probability 2^-248
            return Err(WalletError::Internal("an output commitment is the all-zero digest"));
        }
        let r_b = field::bytes(&r);
        let (k, n) = match o.ek {
            Some(addr) => encrypt_note(&addr.ek, &cm_b, o.value, &r_b, entropy::bytes32(rnd, Draw::KemRandomness, slot)?)?,
            None => {
                let d = entropy::bytes32(rnd, Draw::NobodyD, slot)?;
                let z = entropy::bytes32(rnd, Draw::NobodyZ, slot)?;
                encrypt_to_nobody(&cm_b, o.value, &r_b, d, z, entropy::bytes32(rnd, Draw::KemRandomness, slot)?)?
            }
        };
        cm_out[j] = cm_b;
        kem_ct[j] = k;
        note_ct[j] = n;
        witness_out[j] = Some(OutputWitness { value: o.value, pk: o.pk, r });
        records[j] = OutputRecord { slot: j, role: o.role, value: o.value, r: r_b, cm: cm_b };
    }
    let body = Body {
        kind,
        chain: chain_tag(&ctx.chain_id),
        expiry_height: ctx.expiry_height,
        anchor: ctx.anchor,
        nf: [field::bytes(&nf[0]), field::bytes(&nf[1])],
        cm_out,
        v_in: amounts.v_in,
        v_out: amounts.v_out,
        fee: amounts.fee,
        account: amounts.account,
        kem_ct,
        note_ct,
    }
    .encode();
    // the wallet's own reading of the body it wrote (the stateless rules of spec §3.6)
    if Body::decode(&body)?.encode() != body {
        return Err(WalletError::Internal("the body does not round-trip"));
    }
    let public = public_inputs_of(&body)?;
    let binding = binding_bytes(&body);
    let [w0, w1] = witness_out;
    let (w0, w1) = (w0.ok_or(WalletError::Internal("outputs"))?, w1.ok_or(WalletError::Internal("outputs"))?);
    Ok(UnprovenTx {
        kind,
        body,
        binding,
        public,
        witness: SpendWitness { inputs, outputs: [w0, w1] },
        outputs: records,
        input_positions: spent.0.iter().map(|n| n.position).collect(),
        input_total: spent.1,
        expiry_height: ctx.expiry_height,
        shield_sender,
    })
}

impl UnprovenTx {
    /// See [`BuiltTx::pending`].
    pub fn pending(&self) -> Option<PendingTx> {
        pending_of(self.kind, &self.body, &self.outputs, &self.input_positions, self.input_total, self.expiry_height)
    }

    /// TEST VECTORS ONLY (spec §8.4): the witness, for the vector file and its checker.
    #[cfg(any(test, feature = "test-vectors"))]
    pub fn witness_for_vectors(&self) -> &SpendWitness {
        &self.witness
    }

    /// Proves the statement with the production prover (blinding drawn inside it, spec §5.6),
    /// which verifies its own output, and wraps body and proof in the envelope of spec §3.1. The
    /// witness is dropped (wiped) as soon as the prover returns.
    pub fn prove(self) -> Result<BuiltTx, WalletError> {
        let UnprovenTx { kind, body, binding, public, witness, outputs, input_positions, input_total, expiry_height, shield_sender } = self;
        let proof = prove_spend(&witness, &public);
        drop(witness); // wiped: nothing needs it after the proof
        let proof = proof?;
        // spec §5.5: "the wallet MUST check its own transaction with verify_spend" — the prover
        // did; do it once more on the bytes that go into the envelope, with public inputs re-read
        // from the body the way the node reads them
        verify_spend(&public_inputs_of(&body)?, &proof).map_err(|_| WalletError::Internal("verify_spend refused the built transaction"))?;
        let (from_pub_key, nonce) = shield_sender.unwrap_or_default();
        let envelope = TxV1 {
            version: 1,
            tx_type: kind.tx_type().to_string(),
            from_pub_key,
            nonce,
            payload: TxPayload {
                shield_v2_body: Some(hex::encode(&body)),
                shield_v2_proof: Some(hex::encode(&proof)),
                ..Default::default()
            },
            fee: 0.0,
            sig: String::new(),
            signed_payload: None,
        };
        let signing_bytes = (kind == TxKind::Shield).then(|| encode_tx_for_signing(&envelope));
        Ok(BuiltTx {
            kind,
            public_inputs: public.to_bytes(),
            body,
            binding,
            proof,
            outputs,
            input_positions,
            input_total,
            expiry_height,
            envelope,
            signing_bytes,
        })
    }
}

// ---- shield ----------------------------------------------------------------------------------------

/// `shield_v2`: `v_in` quanta leave the funding account; `fee` of them is the fee and
/// `v_in − fee` becomes one note for `recipient` (spec §3.5).
#[derive(Clone, Debug)]
pub struct ShieldRequest<'a> {
    pub ctx: TxContext,
    /// The funding account's ML-DSA-65 public key, 1,952 bytes.
    pub from_pub_key: &'a [u8],
    /// The funding account's next nonce.
    pub nonce: u64,
    pub v_in: u64,
    pub fee: u64,
    /// The highest fee the caller accepts; `None`: [`DEFAULT_MAX_FEE_QUANTA`].
    pub max_fee: Option<u64>,
    pub recipient: &'a ShieldedAddress,
}

fn assemble_shield(req: &ShieldRequest<'_>, src: Source<'_>) -> Result<UnprovenTx, WalletError> {
    check_fee(req.fee, req.max_fee)?;
    req.ctx.check()?;
    if req.v_in <= req.fee {
        return Err(WalletError::Request("a shield must deposit more than its fee (v_in > fee)".into()));
    }
    let value = req.v_in - req.fee;
    if value as u128 > SHIELD_V2_POOL_CAP_QUANTA {
        return Err(WalletError::Request("the deposit exceeds the pool cap".into()));
    }
    let account = account_from_pub_key(req.from_pub_key)?;
    let to_pk = field::digest(&req.recipient.pk, "the recipient's pk")?;
    let mut t = Transcript::new(TxKind::Shield, &req.ctx, req.fee);
    t.bytes(&account);
    t.u64(req.nonce);
    t.u64(req.v_in);
    t.address(req.recipient);
    let mut rnd = generator(src, None, &t.0)?;
    let rnd = rnd.as_mut();
    let outs = [
        OutSpec { role: OutputRole::Payment, value, pk: to_pk, ek: Some(req.recipient) },
        OutSpec { role: OutputRole::Dummy, value: 0, pk: derive_pk(&entropy::digest(rnd, Draw::NobodyPk, 0)?), ek: None },
    ];
    let inputs = [dummy_input(rnd, 0)?, dummy_input(rnd, 1)?];
    let amounts = Amounts { v_in: req.v_in, v_out: 0, fee: req.fee, account };
    assemble(TxKind::Shield, &req.ctx, inputs, outs, amounts, (&[], 0), Some((hex::encode(req.from_pub_key), req.nonce)), rnd)
}

/// Builds and proves a `shield_v2`. The result's envelope still needs the account signature over
/// [`BuiltTx::signing_bytes`].
pub fn build_shield(req: &ShieldRequest<'_>) -> Result<BuiltTx, WalletError> {
    assemble_shield(req, Source::Hedged(&mut OsEntropy))?.prove()
}

// ---- transfer --------------------------------------------------------------------------------------

/// `shielded_transfer_v2`: `amount` to `recipient`, the rest minus `fee` back to the sender.
pub struct TransferRequest<'a> {
    pub ctx: TxContext,
    pub keys: &'a ShieldedKeys,
    /// One or two unspent notes of this wallet with their Merkle paths (`WalletState::spend_input`).
    pub inputs: &'a [SpendInput],
    pub recipient: &'a ShieldedAddress,
    pub amount: u64,
    pub fee: u64,
    /// The highest fee the caller accepts; `None`: [`DEFAULT_MAX_FEE_QUANTA`].
    pub max_fee: Option<u64>,
}

/// (change, total of the inputs)
fn change_of(inputs: &[SpendInput], spend: u128) -> Result<(u64, u64), WalletError> {
    let have: u128 = inputs.iter().map(|n| n.value as u128).sum();
    let change = have.checked_sub(spend).ok_or(WalletError::InsufficientFunds { have, need: spend })?;
    let total = u64::try_from(have).map_err(|_| WalletError::Request("the inputs do not fit in 64 bits".into()))?;
    Ok((u64::try_from(change).map_err(|_| WalletError::Request("the change does not fit in 64 bits".into()))?, total))
}

fn sk_bytes(keys: &ShieldedKeys) -> Zeroizing<[u8; 32]> {
    let mut b = field::bytes(keys.sk());
    let z = Zeroizing::new(b);
    b.zeroize();
    z
}

fn assemble_transfer(req: &TransferRequest<'_>, src: Source<'_>) -> Result<UnprovenTx, WalletError> {
    check_fee(req.fee, req.max_fee)?;
    req.ctx.check()?;
    if req.amount == 0 {
        return Err(WalletError::Request("a transfer must send a non-zero amount".into()));
    }
    let (change, total) = change_of(req.inputs, req.amount as u128 + req.fee as u128)?;
    let anchor = field::digest(&req.ctx.anchor, "the anchor")?;
    let mut t = Transcript::new(TxKind::Transfer, &req.ctx, req.fee);
    t.inputs(req.inputs);
    t.address(req.recipient);
    t.u64(req.amount);
    let sk = sk_bytes(req.keys);
    let mut rnd = generator(src, Some(&*sk), &t.0)?;
    let rnd = rnd.as_mut();
    let inputs = real_inputs(req.keys, req.inputs, &anchor, rnd)?;
    let own = req.keys.address();
    let outs = [
        OutSpec { role: OutputRole::Payment, value: req.amount, pk: field::digest(&req.recipient.pk, "the recipient's pk")?, ek: Some(req.recipient) },
        OutSpec { role: OutputRole::Change, value: change, pk: *req.keys.pk(), ek: Some(&own) },
    ];
    let amounts = Amounts { v_in: 0, v_out: 0, fee: req.fee, account: [0u8; 32] };
    assemble(TxKind::Transfer, &req.ctx, inputs, outs, amounts, (req.inputs, total), None, rnd)
}

/// Builds and proves a `shielded_transfer_v2`. Ready to submit — after
/// [`crate::WalletState::mark_pending`].
pub fn build_transfer(req: &TransferRequest<'_>) -> Result<BuiltTx, WalletError> {
    assemble_transfer(req, Source::Hedged(&mut OsEntropy))?.prove()
}

// ---- unshield --------------------------------------------------------------------------------------

/// `unshield_v2`: `v_out` quanta to the public account `to_account`, the rest minus `fee` back to
/// the sender as a note.
pub struct UnshieldRequest<'a> {
    pub ctx: TxContext,
    pub keys: &'a ShieldedKeys,
    pub inputs: &'a [SpendInput],
    /// The 32-byte payload of the `rouge1` address that receives `v_out`
    /// (`keys::account_from_address`).
    pub to_account: [u8; 32],
    pub v_out: u64,
    pub fee: u64,
    /// The highest fee the caller accepts; `None`: [`DEFAULT_MAX_FEE_QUANTA`].
    pub max_fee: Option<u64>,
}

fn assemble_unshield(req: &UnshieldRequest<'_>, src: Source<'_>) -> Result<UnprovenTx, WalletError> {
    check_fee(req.fee, req.max_fee)?;
    req.ctx.check()?;
    if req.v_out == 0 {
        return Err(WalletError::Request("an unshield must pay out a non-zero amount".into()));
    }
    let (change, total) = change_of(req.inputs, req.v_out as u128 + req.fee as u128)?;
    let anchor = field::digest(&req.ctx.anchor, "the anchor")?;
    let mut t = Transcript::new(TxKind::Unshield, &req.ctx, req.fee);
    t.inputs(req.inputs);
    t.bytes(&req.to_account);
    t.u64(req.v_out);
    let sk = sk_bytes(req.keys);
    let mut rnd = generator(src, Some(&*sk), &t.0)?;
    let rnd = rnd.as_mut();
    let inputs = real_inputs(req.keys, req.inputs, &anchor, rnd)?;
    let own = req.keys.address();
    let outs = [
        OutSpec { role: OutputRole::Change, value: change, pk: *req.keys.pk(), ek: Some(&own) },
        OutSpec { role: OutputRole::Dummy, value: 0, pk: derive_pk(&entropy::digest(rnd, Draw::NobodyPk, 0)?), ek: None },
    ];
    let amounts = Amounts { v_in: 0, v_out: req.v_out, fee: req.fee, account: req.to_account };
    assemble(TxKind::Unshield, &req.ctx, inputs, outs, amounts, (req.inputs, total), None, rnd)
}

/// Builds and proves an `unshield_v2`. Ready to submit — after
/// [`crate::WalletState::mark_pending`].
pub fn build_unshield(req: &UnshieldRequest<'_>) -> Result<BuiltTx, WalletError> {
    assemble_unshield(req, Source::Hedged(&mut OsEntropy))?.prove()
}

// ---- test vectors only -----------------------------------------------------------------------------

/// TEST VECTORS ONLY (spec §8.4). The same assembly with every random choice EXCEPT the proof's
/// blinding taken from a labelled deterministic stream, so that bodies and bindings are
/// reproducible. Never part of a wallet build. `UnprovenTx::prove` on the result still blinds the
/// proof from the operating system's generator — there is no way to fix that seed from here.
#[cfg(any(test, feature = "test-vectors"))]
pub mod deterministic {
    use super::*;
    use crate::entropy::DeterministicEntropy;

    pub fn shield(req: &ShieldRequest<'_>, label: &str) -> Result<UnprovenTx, WalletError> {
        assemble_shield(req, Source::Stream(&mut DeterministicEntropy::new(label)))
    }
    pub fn transfer(req: &TransferRequest<'_>, label: &str) -> Result<UnprovenTx, WalletError> {
        assemble_transfer(req, Source::Stream(&mut DeterministicEntropy::new(label)))
    }
    pub fn unshield(req: &UnshieldRequest<'_>, label: &str) -> Result<UnprovenTx, WalletError> {
        assemble_unshield(req, Source::Stream(&mut DeterministicEntropy::new(label)))
    }
    /// The production assembly (operating-system entropy, hedged) without the proof — for tests
    /// that need many bodies and no proofs.
    pub fn shield_with_os_entropy(req: &ShieldRequest<'_>) -> Result<UnprovenTx, WalletError> {
        assemble_shield(req, Source::Hedged(&mut OsEntropy))
    }
    pub fn transfer_with_os_entropy(req: &TransferRequest<'_>) -> Result<UnprovenTx, WalletError> {
        assemble_transfer(req, Source::Hedged(&mut OsEntropy))
    }
    /// A generator that fails: every builder must return `WalletError::Entropy`.
    pub fn shield_with_failing_entropy(req: &ShieldRequest<'_>) -> Result<UnprovenTx, WalletError> {
        assemble_shield(req, Source::Hedged(&mut crate::entropy::FailingEntropy))
    }
    pub fn transfer_with_failing_entropy(req: &TransferRequest<'_>) -> Result<UnprovenTx, WalletError> {
        assemble_transfer(req, Source::Hedged(&mut crate::entropy::FailingEntropy))
    }
}

// REVIEW_WALLET_1: tests that need this module's private assembly functions and the crate-private
// entropy trait (a generator that repeats). Test builds only.
#[cfg(test)]
#[path = "review_wallet_1_tests.rs"]
mod review_wallet_1_tests;

// REVIEW_WALLET_2: tests of the hedged generator across a process restart; they need this module's
// private assembly functions and the crate-private entropy trait. Test builds only.
#[cfg(test)]
#[path = "review_wallet_2_tests.rs"]
mod review_wallet_2_tests;
