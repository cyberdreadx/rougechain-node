//! Building the three transactions (spec §3, §5.5–5.7).
//!
//! Each builder returns the body (§3.2), its binding, the public inputs, the witness, the proof
//! and the envelope of spec §3.1 as the chain's own `TxV1`:
//!
//! * `shield_v2` — the envelope carries the funding account's public key and nonce and an empty
//!   `sig`; [`BuiltTx::signing_bytes`] are the bytes the account key must sign (the chain's
//!   `encode_tx_for_signing`, which covers body and proof). **This crate never sees the account's
//!   secret key**: the caller signs and calls [`BuiltTx::signed_envelope`].
//! * `shielded_transfer_v2`, `unshield_v2` — signer-less: `version` 1, empty `from_pub_key` and
//!   `sig`, `nonce` 0, no `signed_payload`, envelope `fee` 0.0. Ready to submit.
//!
//! Randomness (spec §5.6, §5.7), all from the operating system's generator, fresh per
//! transaction: the commitment randomness `r` of both outputs, `sk` / `rho` / `r` of every dummy
//! input, the `pk` and the ML-KEM key of a zero-value output, the ML-KEM encapsulation randomness
//! of both outputs, and the order of the two output slots. Nothing is derived from the recovery
//! phrase, a counter or stored state. The proof's blinding is drawn inside `prove_spend`.

use quantum_vault_shield_v2::pool::{SHIELD_V2_MIN_FEE_QUANTA, SHIELD_V2_POOL_CAP_QUANTA};
use quantum_vault_shield_v2::reference::{
    derive_nk, derive_pk, derive_rho, nullifier, root_from_path, Digest, Note, PublicInputs, ZERO_DIGEST,
};
use quantum_vault_shield_v2::{prove_spend, verify_spend, InputWitness, OutputWitness, SpendWitness};
use quantum_vault_types::{encode_tx_for_signing, TxPayload, TxV1};

use crate::body::{binding_bytes, chain_tag, public_inputs_of, Body, TxKind};
use crate::entropy::{self, Entropy, OsEntropy};
use crate::error::WalletError;
use crate::field;
use crate::keys::{account_from_pub_key, ShieldedAddress, ShieldedKeys};
use crate::note_enc::{encrypt_note, encrypt_to_nobody};
use crate::store::SpendInput;

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
    /// The last block height at which the transaction is valid. No later than the last height at
    /// which the anchor is accepted (spec §5.5).
    pub expiry_height: u64,
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputRecord {
    /// 0 or 1: the slot in the body (`cm_out1` / `cm_out2`).
    pub slot: usize,
    pub role: OutputRole,
    pub value: u64,
    pub r: [u8; 32],
    pub cm: [u8; 32],
}

/// Everything of a transaction except its proof.
pub struct UnprovenTx {
    pub kind: TxKind,
    /// The 2,546 bytes of spec §3.2.
    pub body: Vec<u8>,
    /// `binding_from_bytes(body)`, 32 bytes.
    pub binding: [u8; 32],
    pub public: PublicInputs,
    /// Secret: contains the spending key of every real input.
    pub witness: SpendWitness,
    pub outputs: [OutputRecord; 2],
    shield_sender: Option<(String, u64)>,
}

/// A finished transaction.
pub struct BuiltTx {
    pub kind: TxKind,
    pub body: Vec<u8>,
    pub binding: [u8; 32],
    /// The 216 public-input bytes of spec §2.8.
    pub public_inputs: Vec<u8>,
    pub proof: Vec<u8>,
    /// Secret: contains the spending key of every real input. Drop it when the transaction is
    /// submitted.
    pub witness: SpendWitness,
    pub outputs: [OutputRecord; 2],
    /// The envelope of spec §3.1. For a `shield_v2` its `sig` is still empty.
    pub envelope: TxV1,
    /// `shield_v2` only: the bytes the funding account's ML-DSA-65 key signs. `None` for the two
    /// signer-less types.
    pub signing_bytes: Option<Vec<u8>>,
}

impl BuiltTx {
    pub fn nullifiers(&self) -> [[u8; 32]; 2] {
        let mut nf = [[0u8; 32]; 2];
        nf[0].copy_from_slice(&self.body[74..106]);
        nf[1].copy_from_slice(&self.body[106..138]);
        nf
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

/// One output before the slot order is drawn.
struct OutSpec<'a> {
    role: OutputRole,
    value: u64,
    pk: Digest,
    /// `None`: nobody (a zero-value note to a random key).
    ek: Option<&'a ShieldedAddress>,
}

fn check_fee(fee: u64) -> Result<(), WalletError> {
    if fee < SHIELD_V2_MIN_FEE_QUANTA {
        return Err(WalletError::FeeBelowMinimum { fee, min: SHIELD_V2_MIN_FEE_QUANTA });
    }
    Ok(())
}

fn dummy_input(ent: &mut dyn Entropy) -> Result<InputWitness, WalletError> {
    Ok(InputWitness {
        enabled: false,
        sk: entropy::digest(ent)?,
        value: 0,
        rho: entropy::digest(ent)?,
        r: entropy::digest(ent)?,
        index: 0,
        path: [ZERO_DIGEST; 32],
    })
}

/// One or two owned notes → the two circuit inputs (a fresh dummy fills the second slot). Checks
/// that every note's path leads to `anchor`.
fn real_inputs(keys: &ShieldedKeys, notes: &[SpendInput], anchor: &Digest, ent: &mut dyn Entropy) -> Result<[InputWitness; 2], WalletError> {
    if notes.is_empty() || notes.len() > 2 {
        return Err(WalletError::Request("a transaction spends one or two notes".into()));
    }
    if notes.len() == 2 && (notes[0].position == notes[1].position || notes[0].rho == notes[1].rho) {
        return Err(WalletError::Request("the same note in both input slots".into()));
    }
    let mut out = Vec::with_capacity(2);
    for n in notes {
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
        out.push(w);
    }
    if out.len() == 1 {
        out.push(dummy_input(ent)?);
    }
    let second = out.pop().ok_or(WalletError::Internal("inputs"))?;
    let first = out.pop().ok_or(WalletError::Internal("inputs"))?;
    Ok([first, second])
}

#[allow(clippy::too_many_arguments)]
fn assemble(
    kind: TxKind,
    ctx: &TxContext,
    inputs: [InputWitness; 2],
    outs: [OutSpec<'_>; 2],
    v_in: u64,
    v_out: u64,
    fee: u64,
    account: [u8; 32],
    shield_sender: Option<(String, u64)>,
    ent: &mut dyn Entropy,
) -> Result<UnprovenTx, WalletError> {
    field::check(&ctx.anchor, "the anchor")?;
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
    let ordered = if entropy::coin(ent)? { [b, a] } else { [a, b] };

    let mut witness_out = Vec::with_capacity(2);
    let mut records = Vec::with_capacity(2);
    let mut cm_out = [[0u8; 32]; 2];
    let mut kem_ct = [[0u8; crate::keys::KEM_CT_BYTES]; 2];
    let mut note_ct = [[0u8; crate::note_enc::NOTE_CT_BYTES]; 2];
    for (j, o) in ordered.iter().enumerate() {
        let r = entropy::digest(ent)?;
        let cm = Note { value: o.value, pk: o.pk, rho: derive_rho(&nf, j), r }.commitment();
        let cm_b = field::bytes(&cm);
        if cm_b == [0u8; 32] {
            // spec §3.6 check 8; probability 2^-248
            return Err(WalletError::Internal("an output commitment is the all-zero digest"));
        }
        let r_b = field::bytes(&r);
        let (k, n) = match o.ek {
            Some(addr) => encrypt_note(&addr.ek, &cm_b, o.value, &r_b, ent)?,
            None => encrypt_to_nobody(&cm_b, o.value, &r_b, ent)?,
        };
        cm_out[j] = cm_b;
        kem_ct[j] = k;
        note_ct[j] = n;
        witness_out.push(OutputWitness { value: o.value, pk: o.pk, r });
        records.push(OutputRecord { slot: j, role: o.role, value: o.value, r: r_b, cm: cm_b });
    }
    let body = Body {
        kind,
        chain: chain_tag(&ctx.chain_id),
        expiry_height: ctx.expiry_height,
        anchor: ctx.anchor,
        nf: [field::bytes(&nf[0]), field::bytes(&nf[1])],
        cm_out,
        v_in,
        v_out,
        fee,
        account,
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
    let w1 = witness_out.pop().ok_or(WalletError::Internal("outputs"))?;
    let w0 = witness_out.pop().ok_or(WalletError::Internal("outputs"))?;
    let r1 = records.pop().ok_or(WalletError::Internal("outputs"))?;
    let r0 = records.pop().ok_or(WalletError::Internal("outputs"))?;
    Ok(UnprovenTx { kind, body, binding, public, witness: SpendWitness { inputs, outputs: [w0, w1] }, outputs: [r0, r1], shield_sender })
}

impl UnprovenTx {
    /// Proves the statement with the production prover (blinding drawn inside it, spec §5.6),
    /// which verifies its own output, and wraps body and proof in the envelope of spec §3.1.
    pub fn prove(self) -> Result<BuiltTx, WalletError> {
        let proof = prove_spend(&self.witness, &self.public)?;
        // spec §5.5: "the wallet MUST check its own transaction with verify_spend" — the prover
        // did; do it once more on the bytes that go into the envelope, with public inputs re-read
        // from the body the way the node reads them
        verify_spend(&public_inputs_of(&self.body)?, &proof).map_err(|_| WalletError::Internal("verify_spend refused the built transaction"))?;
        let (from_pub_key, nonce) = self.shield_sender.clone().unwrap_or_default();
        let envelope = TxV1 {
            version: 1,
            tx_type: self.kind.tx_type().to_string(),
            from_pub_key,
            nonce,
            payload: TxPayload {
                shield_v2_body: Some(hex::encode(&self.body)),
                shield_v2_proof: Some(hex::encode(&proof)),
                ..Default::default()
            },
            fee: 0.0,
            sig: String::new(),
            signed_payload: None,
        };
        let signing_bytes = (self.kind == TxKind::Shield).then(|| encode_tx_for_signing(&envelope));
        Ok(BuiltTx {
            kind: self.kind,
            public_inputs: self.public.to_bytes(),
            body: self.body,
            binding: self.binding,
            proof,
            witness: self.witness,
            outputs: self.outputs,
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
    pub recipient: &'a ShieldedAddress,
}

fn assemble_shield(req: &ShieldRequest<'_>, ent: &mut dyn Entropy) -> Result<UnprovenTx, WalletError> {
    check_fee(req.fee)?;
    if req.v_in <= req.fee {
        return Err(WalletError::Request("a shield must deposit more than its fee (v_in > fee)".into()));
    }
    let value = req.v_in - req.fee;
    if value as u128 > SHIELD_V2_POOL_CAP_QUANTA {
        return Err(WalletError::Request("the deposit exceeds the pool cap".into()));
    }
    let account = account_from_pub_key(req.from_pub_key)?;
    let to_pk = field::digest(&req.recipient.pk, "the recipient's pk")?;
    let outs = [
        OutSpec { role: OutputRole::Payment, value, pk: to_pk, ek: Some(req.recipient) },
        OutSpec { role: OutputRole::Dummy, value: 0, pk: derive_pk(&entropy::digest(ent)?), ek: None },
    ];
    let inputs = [dummy_input(ent)?, dummy_input(ent)?];
    assemble(TxKind::Shield, &req.ctx, inputs, outs, req.v_in, 0, req.fee, account, Some((hex::encode(req.from_pub_key), req.nonce)), ent)
}

/// Builds and proves a `shield_v2`. The result's envelope still needs the account signature over
/// [`BuiltTx::signing_bytes`].
pub fn build_shield(req: &ShieldRequest<'_>) -> Result<BuiltTx, WalletError> {
    assemble_shield(req, &mut OsEntropy)?.prove()
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
}

fn change_of(inputs: &[SpendInput], spend: u128) -> Result<u64, WalletError> {
    let have: u128 = inputs.iter().map(|n| n.value as u128).sum();
    let change = have.checked_sub(spend).ok_or(WalletError::InsufficientFunds { have, need: spend })?;
    u64::try_from(change).map_err(|_| WalletError::Request("the change does not fit in 64 bits".into()))
}

fn assemble_transfer(req: &TransferRequest<'_>, ent: &mut dyn Entropy) -> Result<UnprovenTx, WalletError> {
    check_fee(req.fee)?;
    if req.amount == 0 {
        return Err(WalletError::Request("a transfer must send a non-zero amount".into()));
    }
    let change = change_of(req.inputs, req.amount as u128 + req.fee as u128)?;
    let anchor = field::digest(&req.ctx.anchor, "the anchor")?;
    let inputs = real_inputs(req.keys, req.inputs, &anchor, ent)?;
    let own = req.keys.address();
    let outs = [
        OutSpec { role: OutputRole::Payment, value: req.amount, pk: field::digest(&req.recipient.pk, "the recipient's pk")?, ek: Some(req.recipient) },
        OutSpec { role: OutputRole::Change, value: change, pk: *req.keys.pk(), ek: Some(&own) },
    ];
    assemble(TxKind::Transfer, &req.ctx, inputs, outs, 0, 0, req.fee, [0u8; 32], None, ent)
}

/// Builds and proves a `shielded_transfer_v2`. Ready to submit.
pub fn build_transfer(req: &TransferRequest<'_>) -> Result<BuiltTx, WalletError> {
    assemble_transfer(req, &mut OsEntropy)?.prove()
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
}

fn assemble_unshield(req: &UnshieldRequest<'_>, ent: &mut dyn Entropy) -> Result<UnprovenTx, WalletError> {
    check_fee(req.fee)?;
    if req.v_out == 0 {
        return Err(WalletError::Request("an unshield must pay out a non-zero amount".into()));
    }
    let change = change_of(req.inputs, req.v_out as u128 + req.fee as u128)?;
    let anchor = field::digest(&req.ctx.anchor, "the anchor")?;
    let inputs = real_inputs(req.keys, req.inputs, &anchor, ent)?;
    let own = req.keys.address();
    let outs = [
        OutSpec { role: OutputRole::Change, value: change, pk: *req.keys.pk(), ek: Some(&own) },
        OutSpec { role: OutputRole::Dummy, value: 0, pk: derive_pk(&entropy::digest(ent)?), ek: None },
    ];
    assemble(TxKind::Unshield, &req.ctx, inputs, outs, 0, req.v_out, req.fee, req.to_account, None, ent)
}

/// Builds and proves an `unshield_v2`. Ready to submit.
pub fn build_unshield(req: &UnshieldRequest<'_>) -> Result<BuiltTx, WalletError> {
    assemble_unshield(req, &mut OsEntropy)?.prove()
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
        assemble_shield(req, &mut DeterministicEntropy::new(label))
    }
    pub fn transfer(req: &TransferRequest<'_>, label: &str) -> Result<UnprovenTx, WalletError> {
        assemble_transfer(req, &mut DeterministicEntropy::new(label))
    }
    pub fn unshield(req: &UnshieldRequest<'_>, label: &str) -> Result<UnprovenTx, WalletError> {
        assemble_unshield(req, &mut DeterministicEntropy::new(label))
    }
    /// The production assembly (operating-system entropy) without the proof — for tests that need
    /// many bodies and no proofs.
    pub fn shield_with_os_entropy(req: &ShieldRequest<'_>) -> Result<UnprovenTx, WalletError> {
        assemble_shield(req, &mut OsEntropy)
    }
    /// A generator that fails: every builder must return `WalletError::Entropy`.
    pub fn shield_with_failing_entropy(req: &ShieldRequest<'_>) -> Result<UnprovenTx, WalletError> {
        assemble_shield(req, &mut crate::entropy::FailingEntropy)
    }
}
