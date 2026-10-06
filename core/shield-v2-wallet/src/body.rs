//! The transaction body of spec §3.2: exactly 2,546 bytes, all integers little-endian.
//!
//! | Offset | Size | Field |
//! |---|---|---|
//! | 0 | 1 | `body_version` = 1 |
//! | 1 | 1 | `kind`: 1 shield, 2 transfer, 3 unshield |
//! | 2 | 32 | `chain` = SHA-256(chain id) |
//! | 34 | 8 | `expiry_height` |
//! | 42 | 32 × 5 | `anchor`, `nf1`, `nf2`, `cm_out1`, `cm_out2` |
//! | 202 | 8 × 3 | `v_in`, `v_out`, `fee` |
//! | 226 | 32 | `account` |
//! | 258 | 1,088 + 56 | `kem_ct1`, `note_ct1` |
//! | 1,402 | 1,088 + 56 | `kem_ct2`, `note_ct2` |

use quantum_vault_shield_v2::pool::SHIELD_V2_MIN_FEE_QUANTA;
use quantum_vault_shield_v2::reference::{binding_from_bytes, digest_from_bytes, digest_to_bytes, PublicInputs};
use sha2::{Digest as _, Sha256};

use crate::error::WalletError;
use crate::keys::KEM_CT_BYTES;
use crate::note_enc::NOTE_CT_BYTES;

pub const BODY_BYTES: usize = 2_546;
pub const BODY_VERSION: u8 = 1;
pub const OFF_PUBLIC: usize = 42;
pub const END_PUBLIC: usize = 226;
pub const OFF_ACCOUNT: usize = 226;
pub const OFF_KEM: [usize; 2] = [258, 1_402];
pub const OFF_NOTE: [usize; 2] = [1_346, 2_490];

/// The three transaction types (spec §3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TxKind {
    Shield,
    Transfer,
    Unshield,
}

impl TxKind {
    pub fn byte(self) -> u8 {
        match self {
            TxKind::Shield => 1,
            TxKind::Transfer => 2,
            TxKind::Unshield => 3,
        }
    }
    pub fn tx_type(self) -> &'static str {
        match self {
            TxKind::Shield => "shield_v2",
            TxKind::Transfer => "shielded_transfer_v2",
            TxKind::Unshield => "unshield_v2",
        }
    }
}

/// SHA-256 of the chain id string (spec §3.2, `chain`).
pub fn chain_tag(chain_id: &str) -> [u8; 32] {
    Sha256::digest(chain_id.as_bytes()).into()
}

/// A decoded body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Body {
    pub kind: TxKind,
    pub chain: [u8; 32],
    pub expiry_height: u64,
    pub anchor: [u8; 32],
    pub nf: [[u8; 32]; 2],
    pub cm_out: [[u8; 32]; 2],
    pub v_in: u64,
    pub v_out: u64,
    pub fee: u64,
    pub account: [u8; 32],
    pub kem_ct: [[u8; KEM_CT_BYTES]; 2],
    pub note_ct: [[u8; NOTE_CT_BYTES]; 2],
}

impl Body {
    pub fn encode(&self) -> Vec<u8> {
        let mut b = Vec::with_capacity(BODY_BYTES);
        b.push(BODY_VERSION);
        b.push(self.kind.byte());
        b.extend_from_slice(&self.chain);
        b.extend_from_slice(&self.expiry_height.to_le_bytes());
        for d in [&self.anchor, &self.nf[0], &self.nf[1], &self.cm_out[0], &self.cm_out[1]] {
            b.extend_from_slice(d);
        }
        for a in [self.v_in, self.v_out, self.fee] {
            b.extend_from_slice(&a.to_le_bytes());
        }
        b.extend_from_slice(&self.account);
        for j in 0..2 {
            b.extend_from_slice(&self.kem_ct[j]);
            b.extend_from_slice(&self.note_ct[j]);
        }
        debug_assert_eq!(b.len(), BODY_BYTES);
        b
    }

    /// Decodes and applies the stateless body rules of spec §3.6 that need no height, no sender
    /// and no chain state: length, version, kind, canonical digests, non-zero output commitments,
    /// `nf1 ≠ nf2`, the amount pattern of the kind, the minimum fee, and the all-zero `account`
    /// of a transfer. (The node's own parser is the authority; this is the wallet's self-check and
    /// the reader of the test vectors.)
    pub fn decode(b: &[u8]) -> Result<Self, WalletError> {
        let bad = |m: &str| WalletError::Request(format!("body: {m}"));
        if b.len() != BODY_BYTES {
            return Err(bad("wrong length"));
        }
        if b[0] != BODY_VERSION {
            return Err(bad("body_version is not 1"));
        }
        let kind = match b[1] {
            1 => TxKind::Shield,
            2 => TxKind::Transfer,
            3 => TxKind::Unshield,
            _ => return Err(bad("unknown kind")),
        };
        let b32 = |off: usize| -> [u8; 32] {
            let mut a = [0u8; 32];
            a.copy_from_slice(&b[off..off + 32]);
            a
        };
        let le = |off: usize| -> u64 {
            let mut a = [0u8; 8];
            a.copy_from_slice(&b[off..off + 8]);
            u64::from_le_bytes(a)
        };
        let anchor = b32(42);
        let nf = [b32(74), b32(106)];
        let cm_out = [b32(138), b32(170)];
        for d in [&anchor, &nf[0], &nf[1], &cm_out[0], &cm_out[1]] {
            if digest_from_bytes(d).is_none() {
                return Err(bad("a digest is not canonical"));
            }
        }
        if cm_out[0] == [0u8; 32] || cm_out[1] == [0u8; 32] {
            return Err(bad("an output commitment is the all-zero digest"));
        }
        if nf[0] == nf[1] {
            return Err(bad("nf1 equals nf2"));
        }
        let (v_in, v_out, fee) = (le(202), le(210), le(218));
        let ok = match kind {
            TxKind::Shield => v_in > 0 && v_out == 0 && fee <= v_in,
            TxKind::Transfer => v_in == 0 && v_out == 0,
            TxKind::Unshield => v_in == 0 && v_out > 0,
        };
        if !ok {
            return Err(bad("the public amounts do not fit the kind"));
        }
        if fee < SHIELD_V2_MIN_FEE_QUANTA {
            return Err(bad("the fee is below the minimum"));
        }
        let account = b32(OFF_ACCOUNT);
        if kind == TxKind::Transfer && account != [0u8; 32] {
            return Err(bad("a transfer must have an all-zero account"));
        }
        let kem = |j: usize| -> [u8; KEM_CT_BYTES] {
            let mut a = [0u8; KEM_CT_BYTES];
            a.copy_from_slice(&b[OFF_KEM[j]..OFF_KEM[j] + KEM_CT_BYTES]);
            a
        };
        let note = |j: usize| -> [u8; NOTE_CT_BYTES] {
            let mut a = [0u8; NOTE_CT_BYTES];
            a.copy_from_slice(&b[OFF_NOTE[j]..OFF_NOTE[j] + NOTE_CT_BYTES]);
            a
        };
        Ok(Self {
            kind,
            chain: b32(2),
            expiry_height: le(34),
            anchor,
            nf,
            cm_out,
            v_in,
            v_out,
            fee,
            account,
            kem_ct: [kem(0), kem(1)],
            note_ct: [note(0), note(1)],
        })
    }
}

/// `binding_from_bytes(body)` as 32 bytes (spec §2.8).
pub fn binding_bytes(body: &[u8]) -> [u8; 32] {
    digest_to_bytes(&binding_from_bytes(body))
}

/// Spec §3.6 check 20: the 216 public-input bytes are bytes 42..226 of the body ‖ the binding.
pub fn public_inputs_of(body: &[u8]) -> Result<PublicInputs, WalletError> {
    if body.len() != BODY_BYTES {
        return Err(WalletError::Request("body: wrong length".into()));
    }
    let mut bytes = Vec::with_capacity(216);
    bytes.extend_from_slice(&body[OFF_PUBLIC..END_PUBLIC]);
    bytes.extend_from_slice(&binding_bytes(body));
    PublicInputs::from_bytes(&bytes).ok_or(WalletError::NonCanonical("a public input of the body"))
}
