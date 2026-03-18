// ============================================================================
// stark::commitment — Cryptographic commitment and nullifier utilities
//
// Provides the core primitives for shielded transactions:
//   - Commitments: SHA-256(value || owner_pubkey || randomness)
//   - Nullifiers:  SHA-256(randomness || commitment_bytes)
//   - Randomness:  32-byte cryptographically secure random values
//
// All outputs are 32-byte hashes, suitable for storage and comparison.
// ============================================================================

use sha2::{Digest, Sha256};

/// Compute a Pedersen-style commitment for a shielded note.
///
/// commitment = SHA-256(value_bytes || owner_pubkey_bytes || randomness)
///
/// This hides the value and owner behind a collision-resistant hash.
/// The randomness ensures indistinguishability between notes of the same value.
pub fn compute_commitment(value: u64, owner_pubkey: &[u8], randomness: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"ROUGECHAIN_COMMITMENT_V1"); // domain separator
    hasher.update(value.to_le_bytes());
    hasher.update(owner_pubkey);
    hasher.update(randomness);
    let result = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&result);
    out
}

/// Compute the nullifier for a shielded note.
///
/// nullifier = SHA-256(randomness || commitment)
///
/// The nullifier is unique per note and deterministic — the same note always
/// produces the same nullifier. Publishing the nullifier reveals that a
/// specific note was consumed, but does not reveal which commitment it
/// corresponds to (because randomness is secret).
pub fn compute_nullifier(randomness: &[u8; 32], commitment: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"ROUGECHAIN_NULLIFIER_V1"); // domain separator
    hasher.update(randomness);
    hasher.update(commitment);
    let result = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&result);
    out
}

/// Generate 32 bytes of cryptographically secure randomness for note blinding.
pub fn generate_randomness() -> [u8; 32] {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).expect("system RNG should be available");
    buf
}

/// Verify that a commitment matches the given preimage.
pub fn verify_commitment(
    commitment: &[u8; 32],
    value: u64,
    owner_pubkey: &[u8],
    randomness: &[u8; 32],
) -> bool {
    let expected = compute_commitment(value, owner_pubkey, randomness);
    // Constant-time comparison to prevent timing attacks
    constant_time_eq(commitment, &expected)
}

/// Constant-time byte comparison (prevents timing side-channels).
fn constant_time_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut diff = 0u8;
    for i in 0..32 {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_commitment_deterministic() {
        let value = 1000u64;
        let owner = b"test_pubkey_hex_string_here_1234";
        let randomness = [42u8; 32];

        let c1 = compute_commitment(value, owner, &randomness);
        let c2 = compute_commitment(value, owner, &randomness);
        assert_eq!(c1, c2, "same inputs should produce same commitment");
    }

    #[test]
    fn test_commitment_different_values() {
        let owner = b"test_pubkey_hex_string_here_1234";
        let randomness = [42u8; 32];

        let c1 = compute_commitment(100, owner, &randomness);
        let c2 = compute_commitment(200, owner, &randomness);
        assert_ne!(c1, c2, "different values should produce different commitments");
    }

    #[test]
    fn test_commitment_different_randomness() {
        let value = 1000u64;
        let owner = b"test_pubkey_hex_string_here_1234";

        let c1 = compute_commitment(value, owner, &[1u8; 32]);
        let c2 = compute_commitment(value, owner, &[2u8; 32]);
        assert_ne!(c1, c2, "different randomness should produce different commitments");
    }

    #[test]
    fn test_nullifier_deterministic() {
        let randomness = [42u8; 32];
        let commitment = [7u8; 32];

        let n1 = compute_nullifier(&randomness, &commitment);
        let n2 = compute_nullifier(&randomness, &commitment);
        assert_eq!(n1, n2, "same inputs should produce same nullifier");
    }

    #[test]
    fn test_nullifier_unique_per_commitment() {
        let randomness = [42u8; 32];
        let c1 = [1u8; 32];
        let c2 = [2u8; 32];

        let n1 = compute_nullifier(&randomness, &c1);
        let n2 = compute_nullifier(&randomness, &c2);
        assert_ne!(n1, n2, "different commitments should produce different nullifiers");
    }

    #[test]
    fn test_verify_commitment_valid() {
        let value = 500u64;
        let owner = b"owner_pubkey_abc123";
        let randomness = [99u8; 32];

        let commitment = compute_commitment(value, owner, &randomness);
        assert!(verify_commitment(&commitment, value, owner, &randomness));
    }

    #[test]
    fn test_verify_commitment_wrong_value() {
        let owner = b"owner_pubkey_abc123";
        let randomness = [99u8; 32];

        let commitment = compute_commitment(500, owner, &randomness);
        assert!(!verify_commitment(&commitment, 501, owner, &randomness));
    }

    #[test]
    fn test_generate_randomness_unique() {
        let r1 = generate_randomness();
        let r2 = generate_randomness();
        assert_ne!(r1, r2, "two random values should differ");
    }
}
