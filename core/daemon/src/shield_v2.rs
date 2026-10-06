//! SHIELD_V2 — the node side of the shielded pool V2 (`docs/SHIELDED_POOL_V2_SPEC.md`, SPEC v1),
//! stage 2: the envelope and body rules of spec §3, the persistent pool store behind the stage-1
//! crate's `PoolStore` trait, the proof-verification cache, and the helpers block apply, the
//! mempool, the producer, receipts and the read-only API use. The consensus rules themselves
//! (spec §4) are `quantum_vault_shield_v2::pool`; the verifier (spec §2) is
//! `quantum_vault_shield_v2::verify_spend`.
//!
//! **Activation: `None` on every network** ([`SHIELD_V2_ACTIVATION_HEIGHT`] for mainnet, the
//! `shield_v2` field of `upgrades.rs` per network).
//!
//! **Before activation — and while it is `None` — consensus is exactly the previous release's**
//! (REVIEW_NODE_1 finding R1-1). The previous release has no V2 rule at all: a transaction whose
//! `tx_type` is one of the three V2 names is an *unknown type* to it — it passes the ordinary
//! signature / fee / type checks and is applied as a no-op (`apply_balance_tx_inner`'s `_ => {}`
//! arm; nonce written, sender indexed, no fee) — and the two payload fields do not exist in its
//! `TxPayload`, so its deserialisation drops them silently (no `deny_unknown_fields`), after which
//! the signature, the identity, the hash and the stored block are those of the field-less
//! transaction. An upgraded node mirrors both: at import [`strip_fields_before_activation`] removes
//! the two fields from every transaction of a pre-activation block (what the old schema does on
//! arrival) and [`shield_v2_tx_rule`] is `Ok(None)` for every transaction before activation (no
//! rule, like the old node; [`skips_account_signature`] is false too, so a signer-less envelope
//! fails the ordinary signature check exactly as it does on an old node). The refusal of V2 types
//! and fields before activation lives only in the node-local places — mempool admission and the
//! producer ([`shield_v2_local_rule`]) — so an upgraded node never relays or produces one. The V1
//! types stay in `SUSPENDED_TX_TYPES`.
//!
//! From activation the rules of spec §3 and §4 are consensus: a block carrying a V2 transaction
//! that fails any check, or a non-V2 transaction carrying either field, is invalid as a whole
//! (block rejection like MONETARY_INTEGRITY, never "included and skipped").
//!
//! # Where the checks of spec §3.6 are made
//!
//! | §3.6 | Where |
//! |---|---|
//! | 1 (H ≥ A) | [`shield_v2_tx_rule`] returns `Ok(None)` before activation (consensus = previous release); [`shield_v2_local_rule`] refuses before activation (mempool, producer only) |
//! | 2 (envelope, incl. `version = 1` for the signer-less types), 3–5 (lengths, lowercase hex), 6 (version, kind), 7 (chain id, expiry), 8–10 (digests, `nf1 ≠ nf2`, amount pattern), 11 (min fee), 12 (`account`) | [`shield_v2_tx_rule`] — stateless; at import (consensus), mempool admission and block production |
//! | 13 (per-block limit) | [`check_block_limit`] at import from activation, repeated by `Pool::validate_block` |
//! | 14 (account signature of a `shield_v2`) | the daemon's existing signature verification (import, mempool, producer); [`shield_v2_tx_rule`] additionally requires a `signed_payload`, when present, to contain both hexadecimal strings (spec §3.1) |
//! | 15–18 (anchor, nullifiers, room, pool accounting) | `Pool::validate_block` in `L1Node::apply_balance_block` |
//! | 19 (funding balance) | `apply_balance_block`, at the transaction's position in the block |
//! | 20 (proof) | [`verify_proof`] from `apply_balance_block`, once per transaction per node ([`VerifyCache`]) |
//!
//! Any failure of 15–20 inside block apply is an `Err` of `apply_balance_block`, which the import
//! and production paths answer by restoring the pre-apply snapshot — the pool store included
//! (`ShieldV2Store::snapshot` / `restore`). Spec §4.6: the block is invalid as a whole.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use quantum_vault_crypto::{address_from_hash, sha256};
use quantum_vault_shield_v2::pool::{
    Bytes32, PoolStore, PoolTx, PoolUpdate, StoreError, StoredPool, PoolState, TxKind, SHIELD_V2_MAX_TX_PER_BLOCK,
    SHIELD_V2_MIN_FEE_QUANTA,
};
use quantum_vault_shield_v2::reference::{binding_from_bytes, digest_from_bytes, digest_to_bytes, PublicInputs};
use quantum_vault_shield_v2::MAX_PROOF_BYTES;
use quantum_vault_storage::shield_v2_store::ShieldV2Store;
use quantum_vault_types::{TxPayload, TxV1};

/// Mainnet activation height of SHIELD_V2 (spec §1.3): **not scheduled**. Testnet's is in
/// `upgrades.rs` (also `None`). The node reads `crate::upgrades::current().shield_v2`.
pub const SHIELD_V2_ACTIVATION_HEIGHT: Option<u64> = None;

#[cfg(test)]
thread_local! {
    static TEST_SHIELD_V2_OVERRIDE: std::cell::Cell<Option<Option<u64>>> = const { std::cell::Cell::new(None) };
}
#[cfg(test)]
pub(crate) fn set_test_shield_v2(h: Option<u64>) {
    TEST_SHIELD_V2_OVERRIDE.with(|c| c.set(Some(h)));
}

/// `A` of the network this process runs on (`None` = not scheduled).
#[inline]
pub fn shield_v2_activation_height() -> Option<u64> {
    #[cfg(test)]
    {
        if let Some(h) = TEST_SHIELD_V2_OVERRIDE.with(|c| c.get()) {
            return h;
        }
    }
    crate::upgrades::current().shield_v2
}

/// Spec §3.6 check 1: `H ≥ A` and `A` is set.
#[inline]
pub fn shield_v2_active(height: u64) -> bool {
    matches!(shield_v2_activation_height(), Some(a) if height >= a)
}

pub const SHIELD_TX_TYPE: &str = "shield_v2";
pub const TRANSFER_TX_TYPE: &str = "shielded_transfer_v2";
pub const UNSHIELD_TX_TYPE: &str = "unshield_v2";
/// The three V2 transaction types (spec §3).
pub const SHIELD_V2_TX_TYPES: &[&str] = &[SHIELD_TX_TYPE, TRANSFER_TX_TYPE, UNSHIELD_TX_TYPE];

/// Spec §3.2: the body is exactly 2,546 bytes = 5,092 hexadecimal characters.
pub const SHIELD_V2_BODY_BYTES: usize = 2_546;
pub const SHIELD_V2_BODY_HEX_CHARS: usize = 2 * SHIELD_V2_BODY_BYTES;
/// Spec §3.1 / §3.6 check 3: the proof field is at most 400,000 characters (200,000 bytes).
pub const SHIELD_V2_MAX_PROOF_HEX_CHARS: usize = 2 * MAX_PROOF_BYTES;
/// ML-DSA-65 public key length (the funding account of a `shield_v2`).
pub const ML_DSA_65_PUBLIC_KEY_BYTES: usize = 1_952;
/// Offsets of spec §3.2.
const OFF_PUBLIC: usize = 42;
const END_PUBLIC: usize = 226;
const OFF_KEM1: usize = 258;
const OFF_NOTE1: usize = 1_346;
const OFF_KEM2: usize = 1_402;
const OFF_NOTE2: usize = 2_490;
const KEM_CT_BYTES: usize = 1_088;
const NOTE_CT_BYTES: usize = 56;

pub const NOT_ACTIVE_ERROR: &str = "shield_v2: the shielded pool V2 is not active at this height";
pub const FOREIGN_FIELDS_ERROR: &str = "shield_v2: only the shielded pool V2 transaction types may carry shield_v2_body / shield_v2_proof";

/// Is `ty` one of the three V2 types?
#[inline]
pub fn is_shield_v2_type(ty: &str) -> bool {
    SHIELD_V2_TX_TYPES.contains(&ty)
}

/// Spec §3.1: the two types without a public sender. **This is the only exemption from the
/// daemon's account-signature, nonce and address-index handling, and it applies to these two
/// types and to no other.** A transaction of one of these types whose envelope is not the
/// signer-less shape fails [`shield_v2_tx_rule`] (check 2) and so invalidates its block.
#[inline]
pub fn is_signerless_type(ty: &str) -> bool {
    ty == TRANSFER_TX_TYPE || ty == UNSHIELD_TX_TYPE
}

/// A transaction the daemon must not run account-signature verification for, judged at block
/// `height`: a signer-less V2 type with the empty sender and signature spec §3.1 requires, **from
/// activation only**. Before activation (R1-1) the previous release knows no exemption, so the
/// envelope goes through the ordinary verification there — and fails it, as it does on an old
/// node. Anything else — including a signer-less type that carries a sender — goes through the
/// ordinary verification (and fails it or the envelope rule).
#[inline]
pub fn skips_account_signature(tx: &TxV1, height: u64) -> bool {
    shield_v2_active(height) && is_signerless_envelope(tx)
}

/// The signer-less shape alone (no height): a signer-less V2 type with empty `from_pub_key` and
/// empty `sig`. For the parallel signature loops, which evaluate [`shield_v2_active`] once outside
/// the worker threads (the test override of the activation height is thread-local).
#[inline]
pub fn is_signerless_envelope(tx: &TxV1) -> bool {
    is_signerless_type(&tx.tx_type) && tx.from_pub_key.is_empty() && tx.sig.is_empty()
}

/// Does `tx` carry either SHIELD_V2 payload field?
#[inline]
pub fn has_shield_v2_fields(p: &TxPayload) -> bool {
    p.shield_v2_body.is_some() || p.shield_v2_proof.is_some()
}

/// R1-1, consensus mirror of the previous release's deserialisation: before activation the two
/// payload fields do not exist for an old node (`TxPayload` has no `deny_unknown_fields`, so
/// serde drops them on arrival), and everything downstream — the three signature formats, the
/// signed-payload binding, `tx_identity`, `compute_single_tx_hash`, the stored block — sees the
/// field-less transaction. An upgraded node does the same to every transaction of a block it
/// imports below activation, so that it accepts, refuses, applies and stores exactly what an old
/// node does. From activation the fields are consensus and nothing is touched. Returns how many
/// transactions were stripped (for the log).
pub fn strip_fields_before_activation(block: &mut quantum_vault_types::BlockV1) -> usize {
    if shield_v2_active(block.header.height) {
        return 0;
    }
    let mut n = 0;
    for tx in &mut block.txs {
        if has_shield_v2_fields(&tx.payload) {
            tx.payload.shield_v2_body = None;
            tx.payload.shield_v2_proof = None;
            n += 1;
        }
    }
    n
}

/// Node-local admission rule (mempool and producer only — NOT consensus): before activation an
/// upgraded node admits, relays and produces no V2 type and no transaction carrying either field,
/// although a block that contains one is valid for it exactly as for an old node (R1-1). From
/// activation this is `Ok(())` and [`shield_v2_tx_rule`] judges the transaction.
pub fn shield_v2_local_rule(tx: &TxV1, height: u64) -> Result<(), String> {
    if shield_v2_active(height) {
        return Ok(());
    }
    if is_shield_v2_type(&tx.tx_type) || has_shield_v2_fields(&tx.payload) {
        return Err(NOT_ACTIVE_ERROR.to_string());
    }
    Ok(())
}

/// SHA-256 of the chain id string (spec §3.2, `chain`).
pub fn chain_tag(chain_id: &str) -> Bytes32 {
    sha256(chain_id.as_bytes()).try_into().expect("sha256 is 32 bytes")
}

// ---- the body (spec §3.2) ------------------------------------------------------------------------

/// The decoded body of a V2 transaction (spec §3.2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShieldV2Body {
    pub kind: TxKind,
    pub chain: Bytes32,
    pub expiry_height: u64,
    pub anchor: Bytes32,
    pub nf: [Bytes32; 2],
    pub cm_out: [Bytes32; 2],
    pub v_in: u64,
    pub v_out: u64,
    pub fee: u64,
    pub account: Bytes32,
}

/// A V2 transaction that passed every stateless check of [`shield_v2_tx_rule`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShieldV2Tx {
    pub body: ShieldV2Body,
    /// The 2,546 body bytes.
    pub body_bytes: Vec<u8>,
    /// The proof bytes (≤ 200,000).
    pub proof: Vec<u8>,
}

impl ShieldV2Tx {
    /// Spec §3.6 check 20: `public` = bytes 42..226 of the body ‖ `binding_from_bytes(body)`.
    pub fn public_inputs(&self) -> PublicInputs {
        let mut bytes = Vec::with_capacity(216);
        bytes.extend_from_slice(&self.body_bytes[OFF_PUBLIC..END_PUBLIC]);
        bytes.extend_from_slice(&digest_to_bytes(&binding_from_bytes(&self.body_bytes)));
        PublicInputs::from_bytes(&bytes).expect("canonical digests were checked by the stateless rule")
    }

    /// What the pool's rules read (spec §4).
    pub fn pool_tx(&self) -> PoolTx {
        let b = &self.body;
        PoolTx {
            kind: b.kind,
            anchor: b.anchor,
            nf: b.nf,
            cm_out: b.cm_out,
            v_in: b.v_in,
            v_out: b.v_out,
            fee: b.fee,
            account: b.account,
        }
    }

    /// `kem_ct_j`, j ∈ {0, 1} (spec §3.4). Test-only since R1-7: the wallet listing reads the
    /// ciphertexts through [`listing_fields`], without decoding the proof.
    #[cfg(test)]
    pub fn kem_ct(&self, j: usize) -> &[u8] {
        let off = if j == 0 { OFF_KEM1 } else { OFF_KEM2 };
        &self.body_bytes[off..off + KEM_CT_BYTES]
    }

    /// `note_ct_j`, j ∈ {0, 1} (spec §3.4). Test-only, like [`ShieldV2Tx::kem_ct`].
    #[cfg(test)]
    pub fn note_ct(&self, j: usize) -> &[u8] {
        let off = if j == 0 { OFF_NOTE1 } else { OFF_NOTE2 };
        &self.body_bytes[off..off + NOTE_CT_BYTES]
    }

    /// The `rouge1` address credited with `v_out` by an `unshield_v2` (spec §3.3); `None` for the
    /// other two types.
    pub fn unshield_recipient(&self) -> Option<String> {
        (self.body.kind == TxKind::Unshield).then(|| address_from_hash(&self.body.account).ok()).flatten()
    }
}

fn is_lower_hex(s: &str) -> bool {
    s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn le_u64(b: &[u8]) -> u64 {
    u64::from_le_bytes(b.try_into().expect("8 bytes"))
}

fn b32(b: &[u8]) -> Bytes32 {
    b.try_into().expect("32 bytes")
}

/// Spec §3.6 checks 6–12 on decoded bytes. `body` must be exactly 2,546 bytes (check 4 before).
/// `expected_chain` = SHA-256 of this node's chain id.
pub fn parse_body(body: &[u8], ty: &str, height: u64, expected_chain: &Bytes32) -> Result<ShieldV2Body, String> {
    if body.len() != SHIELD_V2_BODY_BYTES {
        return Err(format!("shield_v2: body is {} bytes, expected {}", body.len(), SHIELD_V2_BODY_BYTES));
    }
    // 6
    if body[0] != 0x01 {
        return Err(format!("shield_v2: body_version {} is not 1", body[0]));
    }
    let kind = match (body[1], ty) {
        (1, SHIELD_TX_TYPE) => TxKind::Shield,
        (2, TRANSFER_TX_TYPE) => TxKind::Transfer,
        (3, UNSHIELD_TX_TYPE) => TxKind::Unshield,
        (k, _) => return Err(format!("shield_v2: body kind {} does not match tx_type {}", k, ty)),
    };
    // 7
    let chain = b32(&body[2..34]);
    if &chain != expected_chain {
        return Err("shield_v2: body chain id is not this chain".to_string());
    }
    let expiry_height = le_u64(&body[34..42]);
    if expiry_height < height {
        return Err(format!("shield_v2: expired at height {} (block {})", expiry_height, height));
    }
    // 8
    let anchor = b32(&body[42..74]);
    let nf = [b32(&body[74..106]), b32(&body[106..138])];
    let cm_out = [b32(&body[138..170]), b32(&body[170..202])];
    for (name, d) in [("anchor", &anchor), ("nf1", &nf[0]), ("nf2", &nf[1]), ("cm_out1", &cm_out[0]), ("cm_out2", &cm_out[1])] {
        if digest_from_bytes(d).is_none() {
            return Err(format!("shield_v2: {} is not a canonical digest", name));
        }
    }
    if cm_out[0] == [0u8; 32] || cm_out[1] == [0u8; 32] {
        return Err("shield_v2: an output commitment is the all-zero digest".to_string());
    }
    // 9
    if nf[0] == nf[1] {
        return Err("shield_v2: nf1 equals nf2".to_string());
    }
    // 10
    let v_in = le_u64(&body[202..210]);
    let v_out = le_u64(&body[210..218]);
    let fee = le_u64(&body[218..226]);
    let pattern_ok = match kind {
        TxKind::Shield => v_in > 0 && v_out == 0 && fee <= v_in,
        TxKind::Transfer => v_in == 0 && v_out == 0,
        TxKind::Unshield => v_in == 0 && v_out > 0,
    };
    if !pattern_ok {
        return Err(format!("shield_v2: public amounts (v_in {}, v_out {}, fee {}) do not fit {}", v_in, v_out, fee, ty));
    }
    // 11
    if fee < SHIELD_V2_MIN_FEE_QUANTA {
        return Err(format!("shield_v2: fee {} quanta is below the minimum of {}", fee, SHIELD_V2_MIN_FEE_QUANTA));
    }
    let account = b32(&body[226..258]);
    Ok(ShieldV2Body { kind, chain, expiry_height, anchor, nf, cm_out, v_in, v_out, fee, account })
}

/// The stateless SHIELD_V2 rule for a transaction judged at block `height` — checks 1–12 of spec
/// §3.6 in that order, plus the signed-payload coverage half of check 14 — consensus at import and
/// applied by the mempool and the producer. Returns the decoded transaction for a V2 type (so
/// that nothing is decoded twice), `Ok(None)` for any other type without the two fields.
///
/// **Before activation (or while activation is `None`) this is `Ok(None)` for every transaction**
/// (check 1, R1-1): the previous release has no V2 rule, treats a V2 type name as an unknown type
/// (valid, applied as a no-op) and never sees the payload fields (dropped by its deserialisation;
/// [`strip_fields_before_activation`] mirrors that at import). The node-local refusal of V2 types
/// and fields before activation is [`shield_v2_local_rule`] (mempool, producer).
///
/// From activation, block level: a V2 transaction failing any check invalidates its block; a non-V2
/// type carrying either field is an error too.
pub fn shield_v2_tx_rule(tx: &TxV1, height: u64, chain_id: &str) -> Result<Option<ShieldV2Tx>, String> {
    // 1 — before activation consensus is the previous release's: no rule
    if !shield_v2_active(height) {
        return Ok(None);
    }
    let p = &tx.payload;
    let v2 = is_shield_v2_type(&tx.tx_type);
    if !v2 {
        if has_shield_v2_fields(p) {
            return Err(FOREIGN_FIELDS_ERROR.to_string());
        }
        return Ok(None);
    }
    // 2 — envelope shape
    let (body_hex, proof_hex) = match (p.shield_v2_body.as_deref(), p.shield_v2_proof.as_deref()) {
        (Some(b), Some(pr)) => (b, pr),
        _ => return Err("shield_v2: shield_v2_body and shield_v2_proof are both required".to_string()),
    };
    {
        let mut rest = p.clone();
        rest.shield_v2_body = None;
        rest.shield_v2_proof = None;
        if rest != TxPayload::default() {
            return Err("shield_v2: no other payload field may be set".to_string());
        }
    }
    if tx.fee.to_bits() != 0.0f64.to_bits() {
        return Err("shield_v2: the envelope fee must be exactly 0.0 (the fee is the body's integer fee)".to_string());
    }
    if is_signerless_type(&tx.tx_type) {
        if !tx.from_pub_key.is_empty() || !tx.sig.is_empty() || tx.nonce != 0 || tx.signed_payload.is_some() {
            return Err(format!("shield_v2: {} has no public sender: from_pub_key and sig must be empty, nonce 0, no signed_payload", tx.tx_type));
        }
        // R1-4: `version` is inside `tx_identity` / `compute_single_tx_hash` and nothing else pins
        // it for an envelope nobody signs — a relay could change it in flight and the chain would
        // apply the sender's intent under another identity. Pinned (spec §3.1, §3.6 check 2).
        if tx.version != 1 {
            return Err(format!("shield_v2: {} must have version 1 (got {})", tx.tx_type, tx.version));
        }
    }
    // 3 — on the string length, before any decoding
    let pl = proof_hex.len();
    if pl < 2 || pl % 2 != 0 || pl > SHIELD_V2_MAX_PROOF_HEX_CHARS {
        return Err(format!("shield_v2: shield_v2_proof has {} characters; it must be even, at least 2 and at most {}", pl, SHIELD_V2_MAX_PROOF_HEX_CHARS));
    }
    // 4
    if body_hex.len() != SHIELD_V2_BODY_HEX_CHARS {
        return Err(format!("shield_v2: shield_v2_body has {} characters, expected {}", body_hex.len(), SHIELD_V2_BODY_HEX_CHARS));
    }
    // 5
    if !is_lower_hex(body_hex) || !is_lower_hex(proof_hex) {
        return Err("shield_v2: shield_v2_body and shield_v2_proof must be lowercase hexadecimal".to_string());
    }
    let body_bytes = hex::decode(body_hex).map_err(|e| format!("shield_v2: body hex: {}", e))?;
    let proof = hex::decode(proof_hex).map_err(|e| format!("shield_v2: proof hex: {}", e))?;
    debug_assert!(proof.len() <= MAX_PROOF_BYTES);
    // 6–11
    let body = parse_body(&body_bytes, &tx.tx_type, height, &chain_tag(chain_id))?;
    // 12
    match body.kind {
        TxKind::Shield => {
            let pk = hex::decode(&tx.from_pub_key).map_err(|_| "shield_v2: from_pub_key is not hexadecimal".to_string())?;
            if pk.len() != ML_DSA_65_PUBLIC_KEY_BYTES {
                return Err(format!("shield_v2: from_pub_key is {} bytes, expected {}", pk.len(), ML_DSA_65_PUBLIC_KEY_BYTES));
            }
            if sha256(&pk).as_slice() != body.account {
                return Err("shield_v2: account is not SHA-256 of from_pub_key".to_string());
            }
            // 14, the coverage half (spec §3.1 "What is signed"): a signed_payload must contain both
            // hexadecimal strings; `encode_tx_for_signing` and the legacy format always include the
            // payload. The signature itself is verified by the daemon's existing path.
            if let Some(sp) = tx.signed_payload.as_deref() {
                if !sp.contains(body_hex) || !sp.contains(proof_hex) {
                    return Err("shield_v2: the signed_payload does not cover the body and the proof".to_string());
                }
            }
        }
        TxKind::Transfer => {
            if body.account != [0u8; 32] {
                return Err("shield_v2: a shielded_transfer_v2 must have an all-zero account".to_string());
            }
        }
        TxKind::Unshield => {}
    }
    Ok(Some(ShieldV2Tx { body, body_bytes, proof }))
}

/// Spec §3.6 check 13 / §4.7 at block level: at most [`SHIELD_V2_MAX_TX_PER_BLOCK`] V2
/// transactions, the three types counted together.
pub fn check_block_limit(txs: &[TxV1]) -> Result<(), String> {
    let n = txs.iter().filter(|t| is_shield_v2_type(&t.tx_type)).count();
    if n > SHIELD_V2_MAX_TX_PER_BLOCK {
        return Err(format!("shield_v2: {} V2 transactions in one block, the limit is {}", n, SHIELD_V2_MAX_TX_PER_BLOCK));
    }
    Ok(())
}

/// The nullifiers of a V2 transaction read straight from its body hex, without the full rule —
/// for the mempool's "shares a nullifier with a queued transaction" check (node-local). `None` if
/// the body is not even the right shape.
pub fn quick_nullifiers(tx: &TxV1) -> Option<[Bytes32; 2]> {
    if !is_shield_v2_type(&tx.tx_type) {
        return None;
    }
    let body = tx.payload.shield_v2_body.as_deref()?;
    if body.len() != SHIELD_V2_BODY_HEX_CHARS || !body.is_ascii() {
        return None;
    }
    let nf = hex::decode(&body[2 * 74..2 * 138]).ok()?;
    Some([b32(&nf[..32]), b32(&nf[32..])])
}

/// `v_in` of a queued `shield_v2`, read straight from its body hex — for the mempool's shadow of
/// queued shields against the funding balance (R1-5, node-local). `None` for any other type or a
/// body that is not even the right shape.
pub fn quick_shield_v_in(tx: &TxV1) -> Option<u64> {
    if tx.tx_type != SHIELD_TX_TYPE {
        return None;
    }
    let body = tx.payload.shield_v2_body.as_deref()?;
    if body.len() != SHIELD_V2_BODY_HEX_CHARS || !body.is_ascii() {
        return None;
    }
    let v = hex::decode(&body[2 * 202..2 * 210]).ok()?;
    Some(le_u64(&v))
}

/// What the wallet listing (`/api/shield-v2/notes`) shows of an accepted V2 transaction: the two
/// nullifiers, the two output commitments and the two `(kem_ct, note_ct)` pairs (spec §5.4).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListingFields {
    pub nf: [Bytes32; 2],
    pub cm_out: [Bytes32; 2],
    pub kem_ct: [Vec<u8>; 2],
    pub note_ct: [Vec<u8>; 2],
}

/// R1-7: the listing's fields from the body hex alone — the proof string is never touched, nothing
/// is validated beyond the body's length (the transaction was accepted by consensus when its block
/// was). Cost: one 5,092-character hex decode (2,546 bytes) per listed transaction, instead of the
/// up-to-400,000-character proof decode `shield_v2_tx_rule` makes. `None` if the body is not the
/// right shape (cannot happen for an accepted transaction).
pub fn listing_fields(tx: &TxV1) -> Option<ListingFields> {
    if !is_shield_v2_type(&tx.tx_type) {
        return None;
    }
    let body_hex = tx.payload.shield_v2_body.as_deref()?;
    if body_hex.len() != SHIELD_V2_BODY_HEX_CHARS {
        return None;
    }
    let body = hex::decode(body_hex).ok()?;
    if body.len() != SHIELD_V2_BODY_BYTES {
        return None;
    }
    Some(ListingFields {
        nf: [b32(&body[74..106]), b32(&body[106..138])],
        cm_out: [b32(&body[138..170]), b32(&body[170..202])],
        kem_ct: [body[OFF_KEM1..OFF_KEM1 + KEM_CT_BYTES].to_vec(), body[OFF_KEM2..OFF_KEM2 + KEM_CT_BYTES].to_vec()],
        note_ct: [body[OFF_NOTE1..OFF_NOTE1 + NOTE_CT_BYTES].to_vec(), body[OFF_NOTE2..OFF_NOTE2 + NOTE_CT_BYTES].to_vec()],
    })
}

// ---- the persistent store behind the stage-1 crate's `PoolStore` -----------------------------

const META_VERSION: u8 = 1;

/// The daemon's encoding of the stage-1 crate's `StoredPool` — the metadata record of
/// `ShieldV2Store` (node-local bytes; the consensus commitment is the state-root section).
pub fn encode_stored_pool(s: &StoredPool) -> Vec<u8> {
    let st = &s.state;
    let mut v = Vec::with_capacity(1 + 8 + 8 + 16 + 8 + 32 + 32 * 32 + 8 + 32 + 8 + 32 * st.window.len());
    v.push(META_VERSION);
    v.extend_from_slice(&s.activation_height.to_be_bytes());
    v.extend_from_slice(&s.next_height.to_be_bytes());
    v.extend_from_slice(&st.pool_total.to_be_bytes());
    v.extend_from_slice(&st.note_count.to_be_bytes());
    v.extend_from_slice(&st.tree_root);
    for f in &st.frontier {
        v.extend_from_slice(f);
    }
    v.extend_from_slice(&st.nullifier_count.to_be_bytes());
    v.extend_from_slice(&st.nullifier_acc);
    v.extend_from_slice(&(st.window.len() as u64).to_be_bytes());
    for w in &st.window {
        v.extend_from_slice(w);
    }
    v
}

pub fn decode_stored_pool(v: &[u8]) -> Result<StoredPool, String> {
    let mut at = 0usize;
    let mut take = |n: usize| -> Result<&[u8], String> {
        let s = v.get(at..at + n).ok_or("shield_v2 store: metadata record is truncated")?;
        at += n;
        Ok(s)
    };
    if take(1)?[0] != META_VERSION {
        return Err("shield_v2 store: unknown metadata version".to_string());
    }
    let be64 = |b: &[u8]| u64::from_be_bytes(b.try_into().expect("8"));
    let activation_height = be64(take(8)?);
    let next_height = be64(take(8)?);
    let pool_total = u128::from_be_bytes(take(16)?.try_into().expect("16"));
    let note_count = be64(take(8)?);
    let tree_root = b32(take(32)?);
    let mut frontier = [[0u8; 32]; 32];
    for f in frontier.iter_mut() {
        *f = b32(take(32)?);
    }
    let nullifier_count = be64(take(8)?);
    let nullifier_acc = b32(take(32)?);
    let n = be64(take(8)?);
    if n > 128 {
        return Err("shield_v2 store: anchor window longer than 128".to_string());
    }
    let mut window = Vec::with_capacity(n as usize);
    for _ in 0..n {
        window.push(b32(take(32)?));
    }
    if at != v.len() {
        return Err("shield_v2 store: trailing bytes in the metadata record".to_string());
    }
    Ok(StoredPool {
        activation_height,
        next_height,
        state: PoolState { pool_total, note_count, tree_root, frontier, nullifier_count, nullifier_acc, window },
    })
}

/// `quantum_vault_shield_v2::pool::PoolStore` over the persistent `ShieldV2Store`. A genesis
/// initialisation (`next_height == activation_height`) records no per-block leaf range; every
/// applied block records its range under its height for the wallet-facing listing.
#[derive(Clone)]
pub struct DaemonPoolStore {
    inner: ShieldV2Store,
}

impl DaemonPoolStore {
    pub fn new(inner: ShieldV2Store) -> Self {
        Self { inner }
    }
}

impl PoolStore for DaemonPoolStore {
    fn load(&self) -> Result<Option<StoredPool>, StoreError> {
        match self.inner.meta().map_err(StoreError)? {
            Some(m) => Ok(Some(decode_stored_pool(&m).map_err(StoreError)?)),
            None => Ok(None),
        }
    }

    fn contains_nullifier(&self, nf: &Bytes32) -> Result<bool, StoreError> {
        self.inner.contains_nullifier(nf).map_err(StoreError)
    }

    fn commit(&mut self, update: &PoolUpdate) -> Result<(), StoreError> {
        let applied_height = (update.next_height > update.activation_height).then(|| update.next_height - 1);
        let meta = encode_stored_pool(&StoredPool {
            activation_height: update.activation_height,
            next_height: update.next_height,
            state: update.state.clone(),
        });
        self.inner.commit(applied_height, &meta, &update.nullifiers, update.first_leaf, &update.leaves).map_err(StoreError)
    }
}

// ---- proof verification, once per transaction per node --------------------------------------

/// Transaction hashes (`compute_single_tx_hash`, which covers body and proof) whose proof THIS
/// node has verified — the **accepted** set, so a proof verified at mempool admission is not
/// verified again when its block is applied, and a block re-offered after a rollback is not
/// re-verified either; and (R1-2) the **refused** set, so the same garbage re-sent by a peer costs
/// no second verification. The refused set is consulted only by the node-local paths (mempool
/// admission, producer selection — [`verify_proof_admission`]), never by block apply
/// ([`verify_proof`]): a refusal is deterministic for the same bytes, but keeping consensus
/// independent of a negative cache costs nothing and removes a class of "this node refuses a valid
/// block because of a stale cache entry" bugs. Both sets are bounded and cleared when full. Clones
/// share one cache (the node is cloned across its server tasks).
#[derive(Clone)]
pub struct VerifyCache {
    accepted: Arc<Mutex<HashSet<String>>>,
    refused: Arc<Mutex<HashSet<String>>>,
}

const VERIFY_CACHE_MAX: usize = 4_096;
/// R1-2: bound of the negative cache.
pub const REFUSED_PROOF_CACHE_MAX: usize = 4_096;

impl Default for VerifyCache {
    fn default() -> Self {
        Self { accepted: Arc::new(Mutex::new(HashSet::new())), refused: Arc::new(Mutex::new(HashSet::new())) }
    }
}

fn insert_bounded(set: &Mutex<HashSet<String>>, max: usize, tx_hash: String) {
    if let Ok(mut s) = set.lock() {
        if s.len() >= max {
            s.clear();
        }
        s.insert(tx_hash);
    }
}

impl VerifyCache {
    pub fn is_accepted(&self, tx_hash: &str) -> bool {
        self.accepted.lock().map(|s| s.contains(tx_hash)).unwrap_or(false)
    }
    pub fn insert(&self, tx_hash: String) {
        insert_bounded(&self.accepted, VERIFY_CACHE_MAX, tx_hash);
    }
    pub fn len(&self) -> usize {
        self.accepted.lock().map(|s| s.len()).unwrap_or(0)
    }
    /// R1-2: was this transaction's proof refused by this node earlier?
    pub fn is_refused(&self, tx_hash: &str) -> bool {
        self.refused.lock().map(|s| s.contains(tx_hash)).unwrap_or(false)
    }
    pub fn insert_refused(&self, tx_hash: String) {
        insert_bounded(&self.refused, REFUSED_PROOF_CACHE_MAX, tx_hash);
    }
    pub fn refused_len(&self) -> usize {
        self.refused.lock().map(|s| s.len()).unwrap_or(0)
    }
}

/// Spec §3.6 check 20 for a decoded transaction: `verify_spend(public, proof)`. Consensus is the
/// `Ok` / `Err` only; the error text is for the local log (spec §4.6, L-4). `tx_hash` keys the
/// cache; a cached accept skips the verifier. A refusal is recorded in the negative cache (read
/// only by [`verify_proof_admission`]) and never changes the outcome here.
pub fn verify_proof(cache: &VerifyCache, tx_hash: &str, parsed: &ShieldV2Tx) -> Result<(), String> {
    if cache.is_accepted(tx_hash) {
        return Ok(());
    }
    match quantum_vault_shield_v2::verify_spend(&parsed.public_inputs(), &parsed.proof) {
        Ok(()) => {
            cache.insert(tx_hash.to_string());
            Ok(())
        }
        Err(e) => {
            cache.insert_refused(tx_hash.to_string());
            Err(format!("shield_v2: proof refused ({})", e))
        }
    }
}

/// [`verify_proof`] for the node-local paths (mempool admission, producer selection): a proof this
/// node already refused is refused again without running the verifier (R1-2). Never used by block
/// apply.
pub fn verify_proof_admission(cache: &VerifyCache, tx_hash: &str, parsed: &ShieldV2Tx) -> Result<(), String> {
    if cache.is_refused(tx_hash) {
        return Err("shield_v2: proof refused (cached refusal of the same transaction)".to_string());
    }
    verify_proof(cache, tx_hash, parsed)
}

/// Receipt / explorer view of a V2 transaction (node-local, not consensus): the public fields of
/// its body. Amounts in quanta as integers.
pub fn receipt_data(parsed: &ShieldV2Tx) -> serde_json::Value {
    let b = &parsed.body;
    serde_json::json!({
        "kind": match b.kind { TxKind::Shield => "shield", TxKind::Transfer => "transfer", TxKind::Unshield => "unshield" },
        "v_in_quanta": b.v_in,
        "v_out_quanta": b.v_out,
        "fee_quanta": b.fee,
        "anchor": hex::encode(b.anchor),
        "nf1": hex::encode(b.nf[0]),
        "nf2": hex::encode(b.nf[1]),
        "cm_out1": hex::encode(b.cm_out[0]),
        "cm_out2": hex::encode(b.cm_out[1]),
        "expiry_height": b.expiry_height,
        "recipient": parsed.unshield_recipient(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use quantum_vault_shield_v2::pool::{PoolState, SHIELD_V2_ANCHOR_WINDOW};

    const CHAIN: &str = "test";

    /// A body with canonical digests (value 1 in every word), the given amounts and account.
    pub(crate) fn body_bytes(kind: u8, chain: &str, expiry: u64, v_in: u64, v_out: u64, fee: u64, account: [u8; 32]) -> Vec<u8> {
        let mut b = vec![0u8; SHIELD_V2_BODY_BYTES];
        b[0] = 1;
        b[1] = kind;
        b[2..34].copy_from_slice(&chain_tag(chain));
        b[34..42].copy_from_slice(&expiry.to_le_bytes());
        let word = |x: u32| x.to_le_bytes();
        for (i, off) in [42usize, 74, 106, 138, 170].into_iter().enumerate() {
            for w in 0..8 {
                b[off + 4 * w..off + 4 * w + 4].copy_from_slice(&word(1 + i as u32 + w as u32 * 16));
            }
        }
        b[202..210].copy_from_slice(&v_in.to_le_bytes());
        b[210..218].copy_from_slice(&v_out.to_le_bytes());
        b[218..226].copy_from_slice(&fee.to_le_bytes());
        b[226..258].copy_from_slice(&account);
        for i in 258..SHIELD_V2_BODY_BYTES {
            b[i] = (i % 251) as u8;
        }
        b
    }

    fn tx(ty: &str, body: &[u8], proof_hex: &str) -> TxV1 {
        TxV1 {
            version: 1,
            tx_type: ty.into(),
            from_pub_key: String::new(),
            nonce: 0,
            payload: TxPayload { shield_v2_body: Some(hex::encode(body)), shield_v2_proof: Some(proof_hex.into()), ..Default::default() },
            fee: 0.0,
            sig: String::new(),
            signed_payload: None,
        }
    }

    fn transfer_body() -> Vec<u8> {
        body_bytes(2, CHAIN, 100, 0, 0, SHIELD_V2_MIN_FEE_QUANTA, [0u8; 32])
    }

    /// R1-1: before activation (and with activation `None`) the consensus rule is the previous
    /// release's — none: `Ok(None)` for a V2 type, with or without fields, and for a foreign type
    /// carrying a field; the signer-less exemption is off; the import-side strip removes the fields
    /// an old node never sees. Only the node-local rule refuses them (mempool, producer).
    #[test]
    fn before_activation_consensus_is_the_previous_release_and_only_the_local_rule_refuses() {
        assert_eq!(SHIELD_V2_ACTIVATION_HEIGHT, None);
        assert_eq!(crate::upgrades::current().shield_v2, None);
        let t = tx(TRANSFER_TX_TYPE, &transfer_body(), "ab");
        let mut bare = tx(SHIELD_TX_TYPE, &[], "");
        bare.payload = TxPayload::default();
        bare.from_pub_key = "aa".into(); bare.sig = "bb".into(); bare.nonce = 1; bare.fee = 0.1;
        let mut foreign = tx("transfer", &[], "");
        foreign.payload = TxPayload { to_pub_key_hex: Some("aa".into()), amount: Some(1), shield_v2_proof: Some("00".into()), ..Default::default() };
        for h in [0, 1, 245, 1_000_000, u64::MAX] {
            assert!(!shield_v2_active(h));
            for x in [&t, &bare, &foreign] {
                assert_eq!(shield_v2_tx_rule(x, h, CHAIN).unwrap(), None, "{h}: no consensus rule before activation");
                assert_eq!(shield_v2_local_rule(x, h).unwrap_err(), NOT_ACTIVE_ERROR, "{h}: node-local refusal");
                assert!(!skips_account_signature(x, h), "{h}: no signer-less exemption before activation");
            }
        }
        // the same with activation scheduled above the height
        set_test_shield_v2(Some(10));
        for h in [0, 9] {
            for x in [&t, &bare, &foreign] {
                assert_eq!(shield_v2_tx_rule(x, h, CHAIN).unwrap(), None, "{h}");
                assert_eq!(shield_v2_local_rule(x, h).unwrap_err(), NOT_ACTIVE_ERROR, "{h}");
                assert!(!skips_account_signature(x, h), "{h}");
            }
        }
        // from activation: the local rule is silent, consensus judges — a foreign type carrying
        // either field is invalid, a bare V2 type fails the envelope, the exemption is on
        for h in [10, 50, u64::MAX] {
            for x in [&t, &bare, &foreign] { assert!(shield_v2_local_rule(x, h).is_ok(), "{h}"); }
            for (b, p) in [(Some("00".into()), None), (None, Some("00".into())), (Some("00".into()), Some("00".into()))] {
                let mut f = foreign.clone();
                f.payload.shield_v2_body = b; f.payload.shield_v2_proof = p;
                assert_eq!(shield_v2_tx_rule(&f, h, CHAIN).unwrap_err(), FOREIGN_FIELDS_ERROR, "{h}");
            }
            assert!(shield_v2_tx_rule(&bare, h, CHAIN).unwrap_err().contains("both required"), "{h}");
            if h <= 100 { assert!(shield_v2_tx_rule(&t, h, CHAIN).is_ok(), "{h}"); } else { assert!(shield_v2_tx_rule(&t, h, CHAIN).unwrap_err().contains("expired"), "{h}"); }
            assert!(skips_account_signature(&t, h) && !skips_account_signature(&bare, h), "{h}");
        }
        set_test_shield_v2(None);
        // the import-side strip: fields removed from every transaction below activation, nothing
        // else touched; nothing touched from activation
        let mk_block = |h: u64| quantum_vault_types::BlockV1 {
            version: 1,
            header: quantum_vault_types::BlockHeaderV1 { version: 1, chain_id: CHAIN.into(), height: h, time: 0, prev_hash: String::new(), tx_hash: String::new(), proposer_pub_key: String::new(), state_root: None, parent_commit: None },
            txs: vec![t.clone(), foreign.clone(), bare.clone()], proposer_sig: String::new(), hash: String::new(),
        };
        let mut b = mk_block(5);
        assert_eq!(strip_fields_before_activation(&mut b), 2);
        assert!(b.txs.iter().all(|x| !has_shield_v2_fields(&x.payload)));
        assert_eq!((b.txs[0].tx_type.as_str(), b.txs[1].payload.amount, b.txs[2].from_pub_key.as_str()), (TRANSFER_TX_TYPE, Some(1), "aa"));
        assert_eq!(strip_fields_before_activation(&mut b), 0);
        set_test_shield_v2(Some(5));
        let mut b = mk_block(5);
        assert_eq!(strip_fields_before_activation(&mut b), 0);
        assert!(has_shield_v2_fields(&b.txs[0].payload) && has_shield_v2_fields(&b.txs[1].payload));
        let mut b = mk_block(4);
        assert_eq!(strip_fields_before_activation(&mut b), 2);
        set_test_shield_v2(None);
        // ordinary transactions are untouched
        let plain = TxV1 { version: 1, tx_type: "transfer".into(), from_pub_key: "k".into(), nonce: 1,
            payload: TxPayload { to_pub_key_hex: Some("aa".into()), amount: Some(1), ..Default::default() }, fee: 0.1, sig: String::new(), signed_payload: None };
        assert_eq!(shield_v2_tx_rule(&plain, 0, CHAIN).unwrap(), None);
        assert_eq!(shield_v2_tx_rule(&plain, u64::MAX, CHAIN).unwrap(), None);
        assert!(shield_v2_local_rule(&plain, 0).is_ok() && shield_v2_local_rule(&plain, u64::MAX).is_ok());
        // the V1 types are still suspended and are not V2 types
        for v1 in ["shield", "shielded_transfer", "unshield"] {
            assert!(crate::node::SUSPENDED_TX_TYPES.contains(&v1));
            assert!(!is_shield_v2_type(v1));
        }
        assert!(!is_signerless_type(SHIELD_TX_TYPE) && is_signerless_type(TRANSFER_TX_TYPE) && is_signerless_type(UNSHIELD_TX_TYPE));
    }

    #[test]
    fn stateless_checks_in_spec_order_with_the_boundaries() {
        set_test_shield_v2(Some(10));
        let body = transfer_body();
        let ok = tx(TRANSFER_TX_TYPE, &body, "ab");
        let parsed = shield_v2_tx_rule(&ok, 10, CHAIN).unwrap().expect("a V2 transaction");
        assert_eq!(parsed.body.kind, TxKind::Transfer);
        assert_eq!(parsed.body.fee, SHIELD_V2_MIN_FEE_QUANTA);
        assert_eq!(parsed.proof, vec![0xab]);
        assert_eq!(parsed.body_bytes, body);
        assert_eq!(parsed.kem_ct(0).len(), 1088);
        assert_eq!(parsed.note_ct(1).len(), 56);
        assert_eq!(parsed.unshield_recipient(), None);
        // the public inputs are bytes 42..226 ‖ binding(body)
        let pi = parsed.public_inputs();
        assert_eq!(&pi.to_bytes()[..184], &body[42..226]);
        assert_eq!(pi.binding, binding_from_bytes(&body));
        // check 1 at the boundary: below activation there is no consensus rule (R1-1) and the
        // node-local rule refuses; at and above it the rule judges
        assert_eq!(shield_v2_tx_rule(&ok, 9, CHAIN).unwrap(), None);
        assert_eq!(shield_v2_local_rule(&ok, 9).unwrap_err(), NOT_ACTIVE_ERROR);
        assert!(shield_v2_local_rule(&ok, 10).is_ok() && shield_v2_tx_rule(&ok, 11, CHAIN).unwrap().is_some());
        // check 2: missing field, foreign field, envelope fee, signer-less shape, version
        let mut t = ok.clone(); t.payload.shield_v2_proof = None;
        assert!(shield_v2_tx_rule(&t, 10, CHAIN).unwrap_err().contains("both required"));
        let mut t = ok.clone(); t.payload.amount = Some(1);
        assert!(shield_v2_tx_rule(&t, 10, CHAIN).unwrap_err().contains("no other payload field"));
        for f in [0.1, -0.0, f64::MIN_POSITIVE, 1e-300] {
            let mut t = ok.clone(); t.fee = f;
            assert!(shield_v2_tx_rule(&t, 10, CHAIN).unwrap_err().contains("exactly 0.0"), "{f}");
        }
        let mut t = ok.clone(); t.from_pub_key = "aa".into();
        assert!(shield_v2_tx_rule(&t, 10, CHAIN).unwrap_err().contains("no public sender"));
        let mut t = ok.clone(); t.sig = "aa".into();
        assert!(shield_v2_tx_rule(&t, 10, CHAIN).is_err());
        let mut t = ok.clone(); t.nonce = 1;
        assert!(shield_v2_tx_rule(&t, 10, CHAIN).is_err());
        let mut t = ok.clone(); t.signed_payload = Some("{}".into());
        assert!(shield_v2_tx_rule(&t, 10, CHAIN).is_err());
        for v in [0, 2, u32::MAX] {
            let mut t = ok.clone(); t.version = v;
            assert!(shield_v2_tx_rule(&t, 10, CHAIN).unwrap_err().contains("must have version 1"), "{v}");
        }
        // check 3: proof string length — even, ≥ 2, ≤ 400,000; judged BEFORE the body (a body of the
        // wrong length together with an over-long proof reports the proof)
        for (p, good) in [("", false), ("a", false), ("ab", true), ("abc", false), ("ab".repeat(200_000).as_str(), true), ("ab".repeat(200_001).as_str(), false)] {
            let mut t = ok.clone(); t.payload.shield_v2_proof = Some(p.to_string());
            let r = shield_v2_tx_rule(&t, 10, CHAIN);
            // at the cap the hex decodes (0xab… is not a proof, but that is check 20's business)
            assert_eq!(r.is_ok(), good, "proof of {} chars", p.len());
            if !good { assert!(r.unwrap_err().contains("shield_v2_proof has")); }
        }
        let mut t = ok.clone(); t.payload.shield_v2_body = Some("00".into()); t.payload.shield_v2_proof = Some("ab".repeat(200_001));
        assert!(shield_v2_tx_rule(&t, 10, CHAIN).unwrap_err().contains("shield_v2_proof has"), "proof length first");
        // check 4: body length
        for n in [0, 5_090, 5_091, 5_093, 5_094] {
            let mut t = ok.clone(); t.payload.shield_v2_body = Some("0".repeat(n));
            assert!(shield_v2_tx_rule(&t, 10, CHAIN).unwrap_err().contains("shield_v2_body has"), "{n}");
        }
        // check 5: lowercase only
        let mut t = ok.clone(); t.payload.shield_v2_proof = Some("AB".into());
        assert!(shield_v2_tx_rule(&t, 10, CHAIN).unwrap_err().contains("lowercase"));
        let mut t = ok.clone(); let mut h = hex::encode(&body); h.replace_range(0..2, "0G"); t.payload.shield_v2_body = Some(h);
        assert!(shield_v2_tx_rule(&t, 10, CHAIN).unwrap_err().contains("lowercase"));
        let mut t = ok.clone(); t.payload.shield_v2_body = Some(hex::encode(&body).to_uppercase());
        assert!(shield_v2_tx_rule(&t, 10, CHAIN).unwrap_err().contains("lowercase"));
        // check 6: version, kind/type agreement
        let mut b = body.clone(); b[0] = 2;
        assert!(shield_v2_tx_rule(&tx(TRANSFER_TX_TYPE, &b, "ab"), 10, CHAIN).unwrap_err().contains("body_version"));
        assert!(shield_v2_tx_rule(&tx(UNSHIELD_TX_TYPE, &body, "ab"), 10, CHAIN).unwrap_err().contains("does not match tx_type"));
        assert!(shield_v2_tx_rule(&tx(SHIELD_TX_TYPE, &body, "ab"), 10, CHAIN).unwrap_err().contains("does not match tx_type"));
        let mut b = body.clone(); b[1] = 4;
        assert!(shield_v2_tx_rule(&tx(TRANSFER_TX_TYPE, &b, "ab"), 10, CHAIN).unwrap_err().contains("does not match tx_type"));
        // check 7: chain id and expiry (expiry_height ≥ H)
        assert!(shield_v2_tx_rule(&ok, 10, "rougechain-mainnet-1").unwrap_err().contains("chain id"));
        assert!(shield_v2_tx_rule(&ok, 100, CHAIN).is_ok(), "valid at the expiry height itself");
        assert!(shield_v2_tx_rule(&ok, 101, CHAIN).unwrap_err().contains("expired"));
        // check 8: a non-canonical word (p itself), the all-zero commitment
        let mut b = body.clone(); b[42..46].copy_from_slice(&0x7f00_0001u32.to_le_bytes());
        assert!(shield_v2_tx_rule(&tx(TRANSFER_TX_TYPE, &b, "ab"), 10, CHAIN).unwrap_err().contains("anchor is not a canonical"));
        let mut b = body.clone(); b[170..174].copy_from_slice(&0xffff_ffffu32.to_le_bytes());
        assert!(shield_v2_tx_rule(&tx(TRANSFER_TX_TYPE, &b, "ab"), 10, CHAIN).unwrap_err().contains("cm_out2 is not a canonical"));
        let mut b = body.clone(); b[138..170].fill(0);
        assert!(shield_v2_tx_rule(&tx(TRANSFER_TX_TYPE, &b, "ab"), 10, CHAIN).unwrap_err().contains("all-zero"));
        // check 9
        let mut b = body.clone(); let nf1 = b[74..106].to_vec(); b[106..138].copy_from_slice(&nf1);
        assert!(shield_v2_tx_rule(&tx(TRANSFER_TX_TYPE, &b, "ab"), 10, CHAIN).unwrap_err().contains("nf1 equals nf2"));
        // check 10: the amount pattern of each type
        let mut b = body.clone(); b[202..210].copy_from_slice(&1u64.to_le_bytes());
        assert!(shield_v2_tx_rule(&tx(TRANSFER_TX_TYPE, &b, "ab"), 10, CHAIN).unwrap_err().contains("do not fit"));
        let acct = [7u8; 32];
        let un = body_bytes(3, CHAIN, 100, 0, 5, SHIELD_V2_MIN_FEE_QUANTA, acct);
        let p = shield_v2_tx_rule(&tx(UNSHIELD_TX_TYPE, &un, "ab"), 10, CHAIN).unwrap().unwrap();
        assert_eq!(p.unshield_recipient(), Some(address_from_hash(&acct).unwrap()));
        assert!(p.unshield_recipient().unwrap().starts_with("rouge1"));
        let un0 = body_bytes(3, CHAIN, 100, 0, 0, SHIELD_V2_MIN_FEE_QUANTA, acct);
        assert!(shield_v2_tx_rule(&tx(UNSHIELD_TX_TYPE, &un0, "ab"), 10, CHAIN).unwrap_err().contains("do not fit"));
        let sh_fee_gt_vin = body_bytes(1, CHAIN, 100, SHIELD_V2_MIN_FEE_QUANTA - 1, 0, SHIELD_V2_MIN_FEE_QUANTA, acct);
        let mut s = tx(SHIELD_TX_TYPE, &sh_fee_gt_vin, "ab"); s.from_pub_key = "00".repeat(1952);
        assert!(shield_v2_tx_rule(&s, 10, CHAIN).unwrap_err().contains("do not fit"), "fee > v_in");
        // check 11: the minimum fee, at the boundary
        let low = body_bytes(2, CHAIN, 100, 0, 0, SHIELD_V2_MIN_FEE_QUANTA - 1, [0u8; 32]);
        assert!(shield_v2_tx_rule(&tx(TRANSFER_TX_TYPE, &low, "ab"), 10, CHAIN).unwrap_err().contains("below the minimum"));
        assert_eq!(SHIELD_V2_MIN_FEE_QUANTA, 1_000_000_000, "1 XRGE, spec §9.2 [P]");
        // check 12: transfer needs the zero account; shield needs SHA-256 of the key
        let bad_acct = body_bytes(2, CHAIN, 100, 0, 0, SHIELD_V2_MIN_FEE_QUANTA, [1u8; 32]);
        assert!(shield_v2_tx_rule(&tx(TRANSFER_TX_TYPE, &bad_acct, "ab"), 10, CHAIN).unwrap_err().contains("all-zero account"));
        let pk = vec![0x5au8; 1952];
        let acct: [u8; 32] = sha256(&pk).try_into().unwrap();
        let sh = body_bytes(1, CHAIN, 100, 5 * SHIELD_V2_MIN_FEE_QUANTA, 0, SHIELD_V2_MIN_FEE_QUANTA, acct);
        let mut s = tx(SHIELD_TX_TYPE, &sh, "ab"); s.from_pub_key = hex::encode(&pk); s.nonce = 3; s.sig = "cc".into();
        let p = shield_v2_tx_rule(&s, 10, CHAIN).unwrap().unwrap();
        assert_eq!(p.body.kind, TxKind::Shield);
        assert_eq!((p.pool_tx().kind, p.pool_tx().v_in, p.pool_tx().account), (TxKind::Shield, 5 * SHIELD_V2_MIN_FEE_QUANTA, acct));
        let mut s2 = s.clone(); s2.from_pub_key = hex::encode(vec![0x5bu8; 1952]);
        assert!(shield_v2_tx_rule(&s2, 10, CHAIN).unwrap_err().contains("SHA-256 of from_pub_key"));
        let mut s2 = s.clone(); s2.from_pub_key = "zz".into();
        assert!(shield_v2_tx_rule(&s2, 10, CHAIN).unwrap_err().contains("not hexadecimal"));
        let mut s2 = s.clone(); s2.from_pub_key = String::new();
        assert!(shield_v2_tx_rule(&s2, 10, CHAIN).unwrap_err().contains("expected 1952"));
        // 14 (coverage): a signed_payload must contain both hex strings
        let mut s2 = s.clone(); s2.signed_payload = Some(format!(r#"{{"tx_type":"shield_v2","payload":{{"shield_v2_body":"{}","shield_v2_proof":"ab"}}}}"#, hex::encode(&sh)));
        assert!(shield_v2_tx_rule(&s2, 10, CHAIN).is_ok());
        let mut s2 = s.clone(); s2.signed_payload = Some(r#"{"tx_type":"shield_v2"}"#.into());
        assert!(shield_v2_tx_rule(&s2, 10, CHAIN).unwrap_err().contains("does not cover"));
        // 13: the per-block limit, counted over the three types together
        let eight: Vec<TxV1> = (0..8).map(|_| ok.clone()).collect();
        assert!(check_block_limit(&eight).is_ok());
        let mut nine = eight.clone(); nine.push(s.clone());
        assert!(check_block_limit(&nine).unwrap_err().contains("the limit is 8"));
        assert_eq!(SHIELD_V2_MAX_TX_PER_BLOCK, 8);
        // quick nullifiers / v_in and the listing's fields agree with the parsed body, and the
        // listing never needs the proof (R1-7)
        assert_eq!(quick_nullifiers(&ok), Some(parsed.body.nf));
        assert_eq!(quick_shield_v_in(&ok), None, "not a shield");
        assert_eq!(quick_shield_v_in(&s), Some(5 * SHIELD_V2_MIN_FEE_QUANTA));
        let mut no_proof = ok.clone(); no_proof.payload.shield_v2_proof = Some("zz".into());
        let lf = listing_fields(&no_proof).expect("listing fields from the body alone");
        assert_eq!((lf.nf, lf.cm_out), (parsed.body.nf, parsed.body.cm_out));
        assert_eq!((&lf.kem_ct[0][..], &lf.kem_ct[1][..], &lf.note_ct[0][..], &lf.note_ct[1][..]), (parsed.kem_ct(0), parsed.kem_ct(1), parsed.note_ct(0), parsed.note_ct(1)));
        let mut short = ok.clone(); short.payload.shield_v2_body = Some("00".into());
        assert_eq!(listing_fields(&short), None);
        assert_eq!(quick_nullifiers(&short), None);
        assert_eq!(listing_fields(&plain_tx()), None);
        set_test_shield_v2(None);
    }

    fn plain_tx() -> TxV1 {
        TxV1 { version: 1, tx_type: "transfer".into(), from_pub_key: "k".into(), nonce: 1,
            payload: TxPayload { to_pub_key_hex: Some("aa".into()), amount: Some(1), ..Default::default() }, fee: 0.1, sig: String::new(), signed_payload: None }
    }

    /// REVIEW_NODE_1 finding R1-4 (Low), FIXED: the signer-less envelope fixes `from_pub_key`,
    /// `sig`, `nonce`, `fee`, `signed_payload` and the payload — and now `version` (MUST be 1),
    /// so a relay can no longer bump `version` on a `shielded_transfer_v2` / `unshield_v2` in
    /// flight and have the chain apply the sender's intent under another `tx_identity` /
    /// `compute_single_tx_hash` (uniqueness index, mempool key, receipt key, verify-cache key).
    #[test]
    fn review_r1_4_signerless_envelope_version_is_not_pinned() {
        set_test_shield_v2(Some(10));
        let ok = tx(TRANSFER_TX_TYPE, &transfer_body(), "ab");
        let parsed = shield_v2_tx_rule(&ok, 10, CHAIN).unwrap().unwrap();
        let mut relayed = ok.clone();
        relayed.version = 2;
        // same body, same proof, same nullifiers: the chain would apply exactly the same effects ...
        let parsed2 = shield_v2_tx_rule(&relayed, 10, CHAIN).map(|p| p.unwrap());
        if let Ok(p2) = &parsed2 {
            assert_eq!(p2.body, parsed.body);
            assert_eq!(p2.proof, parsed.proof);
            // ... under a different identity and hash
            assert_ne!(quantum_vault_types::tx_identity(&relayed), quantum_vault_types::tx_identity(&ok));
            assert_ne!(quantum_vault_types::compute_single_tx_hash(&relayed), quantum_vault_types::compute_single_tx_hash(&ok));
        }
        set_test_shield_v2(None);
        assert!(parsed2.is_err(), "R1-4: a signer-less envelope with version != 1 must be refused (version is otherwise a free, identity-changing field)");
    }

    #[test]
    fn stored_pool_encoding_round_trips() {
        let mut st = PoolState::genesis();
        st.pool_total = u128::MAX - 7;
        st.note_count = 0x0123_4567_89ab_cdef;
        st.frontier[3] = [9u8; 32];
        st.nullifier_count = 42;
        st.nullifier_acc = [0xee; 32];
        st.window = (0..SHIELD_V2_ANCHOR_WINDOW as u8).map(|i| [i; 32]).collect();
        let s = StoredPool { activation_height: 1000, next_height: 1234, state: st };
        let enc = encode_stored_pool(&s);
        assert_eq!(enc.len(), 1 + 8 + 8 + 16 + 8 + 32 + 1024 + 8 + 32 + 8 + 32 * 128);
        assert_eq!(decode_stored_pool(&enc).unwrap(), s);
        assert!(decode_stored_pool(&enc[..enc.len() - 1]).is_err());
        let mut longer = enc.clone(); longer.push(0);
        assert!(decode_stored_pool(&longer).is_err());
        let mut v = enc.clone(); v[0] = 2;
        assert!(decode_stored_pool(&v).is_err());
        let g = StoredPool { activation_height: 5, next_height: 5, state: PoolState::genesis() };
        assert_eq!(decode_stored_pool(&encode_stored_pool(&g)).unwrap(), g);
    }

    #[test]
    fn verify_cache_is_bounded_and_keyed_by_hash() {
        let c = VerifyCache::default();
        assert!(!c.is_accepted("a"));
        c.insert("a".into());
        assert!(c.is_accepted("a") && !c.is_accepted("b"));
        for i in 0..VERIFY_CACHE_MAX { c.insert(format!("x{i}")); }
        assert!(c.len() <= VERIFY_CACHE_MAX);
        // R1-2: the negative cache is separate, bounded, and read only by the admission variant
        assert!(!c.is_refused("a"));
        c.insert_refused("r".into());
        assert!(c.is_refused("r") && !c.is_accepted("r"));
        for i in 0..REFUSED_PROOF_CACHE_MAX { c.insert_refused(format!("y{i}")); }
        assert!(c.refused_len() <= REFUSED_PROOF_CACHE_MAX);
    }

    /// R1-2: a garbage proof is verified once; the same transaction offered again to the
    /// admission path is refused from the negative cache without the verifier; block apply
    /// (`verify_proof`) ignores the negative cache and runs the verifier again.
    #[test]
    fn a_refused_proof_is_cached_for_admission_only() {
        set_test_shield_v2(Some(10));
        let t = tx(TRANSFER_TX_TYPE, &transfer_body(), "ab");
        let parsed = shield_v2_tx_rule(&t, 10, CHAIN).unwrap().unwrap();
        let h = quantum_vault_types::compute_single_tx_hash(&t);
        let c = VerifyCache::default();
        let e = verify_proof_admission(&c, &h, &parsed).unwrap_err();
        assert!(e.contains("proof refused") && !e.contains("cached"), "{e}");
        assert!(c.is_refused(&h) && !c.is_accepted(&h));
        let e = verify_proof_admission(&c, &h, &parsed).unwrap_err();
        assert!(e.contains("cached refusal"), "{e}");
        let e = verify_proof(&c, &h, &parsed).unwrap_err();
        assert!(e.contains("proof refused") && !e.contains("cached"), "block apply never reads the negative cache: {e}");
        // an accept primed for the same hash wins at admission too (the positive set is consulted
        // by `verify_proof`; the negative set only short-circuits)
        let c2 = VerifyCache::default();
        c2.insert(h.clone());
        assert!(verify_proof_admission(&c2, &h, &parsed).is_ok());
        set_test_shield_v2(None);
    }
}
