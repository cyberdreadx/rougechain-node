//! Conversions between the 32-byte digest encoding of spec §2.8 and field elements, without
//! naming the proof library's traits outside this file.

use quantum_vault_shield_v2::reference::{digest_from_bytes, digest_to_bytes, Digest, MODULUS};
use quantum_vault_shield_v2::Felt;

use crate::error::WalletError;

/// A canonical value (`v < p`) as a field element.
pub(crate) fn felt(v: u32) -> Felt {
    debug_assert!(v < MODULUS);
    let mut b = [0u8; 32];
    b[..4].copy_from_slice(&(v % MODULUS).to_le_bytes());
    // `digest_from_bytes` is the crate's strict decoder; the value is canonical by construction.
    digest_from_bytes(&b).map(|d| d[0]).unwrap_or_default()
}

/// Strict: every 4-byte word must be < p.
pub(crate) fn digest(b: &[u8; 32], what: &'static str) -> Result<Digest, WalletError> {
    digest_from_bytes(b).ok_or(WalletError::NonCanonical(what))
}

pub(crate) fn bytes(d: &Digest) -> [u8; 32] {
    digest_to_bytes(d)
}

/// [`digest`] for its check alone.
pub(crate) fn check(b: &[u8; 32], what: &'static str) -> Result<(), WalletError> {
    digest(b, what).map(|_| ())
}
