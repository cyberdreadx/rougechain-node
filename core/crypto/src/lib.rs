use fips204::ml_dsa_65::{self, PrivateKey, PublicKey};
use fips204::traits::{SerDes, Signer, Verifier};
use rand::RngCore;
use sha2::{Digest, Sha256};

use quantum_vault_types::PQKeypair;

pub mod stark;

// ML-DSA-65 key and signature sizes
const SK_LEN: usize = 4032;
const PK_LEN: usize = 1952;
const SIG_LEN: usize = 3309;

pub fn sha256(data: &[u8]) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().to_vec()
}

pub fn bytes_to_hex(bytes: &[u8]) -> String {
    hex::encode(bytes)
}

pub fn hex_to_bytes(input: &str) -> Result<Vec<u8>, String> {
    hex::decode(input).map_err(|e| e.to_string())
}

pub fn pqc_keygen() -> PQKeypair {
    let mut rng = rand::thread_rng();
    let (pk, sk) = ml_dsa_65::try_keygen_with_rng(&mut rng)
        .expect("keygen should not fail with valid RNG");
    PQKeypair {
        algorithm: "ML-DSA-65".to_string(),
        public_key_hex: bytes_to_hex(&pk.into_bytes()),
        secret_key_hex: bytes_to_hex(&sk.into_bytes()),
    }
}

/// Deterministic keygen from a 32-byte seed.
/// Used for mnemonic-derived wallets: BIP-39 mnemonic → HKDF → this seed → keypair.
pub fn pqc_keygen_from_seed(seed: &[u8; 32]) -> PQKeypair {
    use rand::SeedableRng;
    let mut rng = rand_chacha::ChaCha20Rng::from_seed(*seed);
    let (pk, sk) = ml_dsa_65::try_keygen_with_rng(&mut rng)
        .expect("keygen should not fail with seeded RNG");
    PQKeypair {
        algorithm: "ML-DSA-65".to_string(),
        public_key_hex: bytes_to_hex(&pk.into_bytes()),
        secret_key_hex: bytes_to_hex(&sk.into_bytes()),
    }
}

/// Derive a child seed from a parent seed + derivation index.
/// Uses HMAC-SHA256(parent_seed, "RougeChain-HD-v1" || u32_be(index)).
pub fn derive_child_seed(parent_seed: &[u8; 32], index: u32) -> [u8; 32] {
    use hmac::{Hmac, Mac};
    type HmacSha256 = Hmac<Sha256>;
    let mut mac = HmacSha256::new_from_slice(parent_seed)
        .expect("HMAC can take any key length");
    mac.update(b"RougeChain-HD-v1");
    mac.update(&index.to_be_bytes());
    let result = mac.finalize().into_bytes();
    let mut child = [0u8; 32];
    child.copy_from_slice(&result[..32]);
    child
}

/// Derive a child keypair from a master seed + index (HD wallet derivation).
/// index 0 = primary account, 1+ = additional accounts.
pub fn pqc_derive_child(master_seed: &[u8; 32], index: u32) -> PQKeypair {
    let child_seed = derive_child_seed(master_seed, index);
    pqc_keygen_from_seed(&child_seed)
}

/// Derive a keypair along a BIP-44-like path: "m/purpose'/chain'/account'"
/// Path components are u32 indices, e.g., [44, 808, 0] for the first account.
pub fn pqc_derive_path(master_seed: &[u8; 32], path: &[u32]) -> PQKeypair {
    let mut current_seed = *master_seed;
    for &index in path {
        current_seed = derive_child_seed(&current_seed, index);
    }
    pqc_keygen_from_seed(&current_seed)
}

pub fn pqc_sign(secret_key_hex: &str, message: &[u8]) -> Result<String, String> {
    let sk_bytes = hex_to_bytes(secret_key_hex)?;
    let sk_array: [u8; SK_LEN] = sk_bytes.as_slice().try_into()
        .map_err(|_| format!("invalid secret key length: expected {}, got {}", SK_LEN, sk_bytes.len()))?;
    let sk = PrivateKey::try_from_bytes(sk_array)
        .map_err(|_| "invalid secret key bytes")?;
    let sig = sk.try_sign(message, &[])
        .map_err(|_| "signing failed")?;
    Ok(bytes_to_hex(&sig))
}

pub fn pqc_verify(public_key_hex: &str, message: &[u8], signature_hex: &str) -> Result<bool, String> {
    let pk_bytes = hex_to_bytes(public_key_hex)?;
    let sig_bytes = hex_to_bytes(signature_hex)?;
    
    let pk_array: [u8; PK_LEN] = pk_bytes.as_slice().try_into()
        .map_err(|_| format!("invalid public key length: expected {}, got {}", PK_LEN, pk_bytes.len()))?;
    let sig_array: [u8; SIG_LEN] = sig_bytes.as_slice().try_into()
        .map_err(|_| format!("invalid signature length: expected {}, got {}", SIG_LEN, sig_bytes.len()))?;
    
    let pk = PublicKey::try_from_bytes(pk_array)
        .map_err(|_| "invalid public key bytes")?;
    
    Ok(pk.verify(message, &sig_array, &[]))
}

pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    bytes_to_hex(&buf)
}

/// Verify that a private key matches a public key
/// This signs a test message with the private key and verifies it with the public key
pub fn pqc_verify_keypair(public_key_hex: &str, private_key_hex: &str) -> Result<bool, String> {
    // Sign a test message with the private key
    let test_message = b"keypair_verification_test";
    let signature = pqc_sign(private_key_hex, test_message)?;
    
    // Verify with the public key
    pqc_verify(public_key_hex, test_message, &signature)
}

// ============================================================================
// BECH32M ADDRESS SYSTEM
// ============================================================================
//
// Derives compact, human-readable addresses from PQC public keys:
//   address = bech32m("rouge", SHA-256(raw_pubkey_bytes)[0..32])
//
// Result: ~63-char address like "rouge1q8f3x7k2m4n9p..."
// vs the raw 3904-char hex public key.
//
// Security: SHA-256 is quantum-resistant (128-bit security vs Grover's).
// The full PQC public key is still used for all signature verification.

/// Human-Readable Part for RougeChain addresses
const ROUGE_HRP: &str = "rouge";

/// Derive a compact Bech32m address from an ML-DSA-65 public key (hex).
///
/// address = bech32m_encode("rouge", SHA-256(pubkey_bytes))
///
/// Returns a ~63-character string like "rouge1q8f3x7k2m4n9p..."
pub fn pub_key_to_address(public_key_hex: &str) -> Result<String, String> {
    let pk_bytes = hex_to_bytes(public_key_hex)?;
    if pk_bytes.len() != PK_LEN {
        return Err(format!(
            "invalid public key length: expected {}, got {}",
            PK_LEN,
            pk_bytes.len()
        ));
    }
    let hash = sha256(&pk_bytes);
    let hrp = bech32::Hrp::parse(ROUGE_HRP).map_err(|e| format!("HRP error: {}", e))?;
    bech32::encode::<bech32::Bech32m>(hrp, &hash)
        .map_err(|e| format!("Bech32m encode error: {}", e))
}

/// Decode a Bech32m address back to its 32-byte SHA-256 hash.
///
/// Used by the daemon to look up the full public key from the address registry.
pub fn address_to_hash(address: &str) -> Result<Vec<u8>, String> {
    let (_hrp, data) =
        bech32::decode(address).map_err(|e| format!("Bech32m decode error: {}", e))?;
    if data.len() != 32 {
        return Err(format!("invalid address hash length: expected 32, got {}", data.len()));
    }
    Ok(data)
}

/// Check if a string looks like a RougeChain Bech32m address.
pub fn is_rouge_address(input: &str) -> bool {
    input.starts_with("rouge1")
        && input.len() > 10
        && bech32::decode(input).is_ok()
}

/// Format an address for compact display: "rouge1q8f3...k9m2"
pub fn format_address(address: &str) -> String {
    if address.len() <= 20 {
        return address.to_string();
    }
    format!("{}...{}", &address[..12], &address[address.len() - 4..])
}

// ============================================================================
// ADDRESS TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_address_deterministic() {
        let keys = pqc_keygen();
        let addr1 = pub_key_to_address(&keys.public_key_hex).unwrap();
        let addr2 = pub_key_to_address(&keys.public_key_hex).unwrap();
        assert_eq!(addr1, addr2, "same pubkey should produce same address");
    }

    #[test]
    fn test_address_starts_with_rouge() {
        let keys = pqc_keygen();
        let addr = pub_key_to_address(&keys.public_key_hex).unwrap();
        assert!(addr.starts_with("rouge1"), "address should start with rouge1, got: {}", addr);
    }

    #[test]
    fn test_address_roundtrip() {
        let keys = pqc_keygen();
        let addr = pub_key_to_address(&keys.public_key_hex).unwrap();
        let hash = address_to_hash(&addr).unwrap();
        let expected_hash = sha256(&hex_to_bytes(&keys.public_key_hex).unwrap());
        assert_eq!(hash, expected_hash, "roundtrip should preserve the hash");
    }

    #[test]
    fn test_is_rouge_address() {
        let keys = pqc_keygen();
        let addr = pub_key_to_address(&keys.public_key_hex).unwrap();
        assert!(is_rouge_address(&addr));
        assert!(!is_rouge_address("not_an_address"));
        assert!(!is_rouge_address(&keys.public_key_hex));
    }

    #[test]
    fn test_different_keys_different_addresses() {
        let keys1 = pqc_keygen();
        let keys2 = pqc_keygen();
        let addr1 = pub_key_to_address(&keys1.public_key_hex).unwrap();
        let addr2 = pub_key_to_address(&keys2.public_key_hex).unwrap();
        assert_ne!(addr1, addr2, "different keys should produce different addresses");
    }

    #[test]
    fn test_format_address() {
        let keys = pqc_keygen();
        let addr = pub_key_to_address(&keys.public_key_hex).unwrap();
        let formatted = format_address(&addr);
        assert!(formatted.contains("..."), "formatted address should be truncated");
        assert!(formatted.starts_with("rouge1"), "should keep prefix");
        assert!(formatted.len() < addr.len(), "should be shorter than full address");
    }

    // ── ML-DSA-65 sign / verify ──────────────────────────────────────────────

    #[test]
    fn test_sign_and_verify() {
        let keys = pqc_keygen();
        let msg = b"rougechain test message";
        let sig = pqc_sign(&keys.secret_key_hex, msg).expect("sign should succeed");
        let valid = pqc_verify(&keys.public_key_hex, msg, &sig).expect("verify should not error");
        assert!(valid, "signature should be valid");
    }

    #[test]
    fn test_verify_wrong_message_fails() {
        let keys = pqc_keygen();
        let sig = pqc_sign(&keys.secret_key_hex, b"original").expect("sign should succeed");
        let valid = pqc_verify(&keys.public_key_hex, b"tampered", &sig).expect("verify should not error");
        assert!(!valid, "signature over different message should not verify");
    }

    #[test]
    fn test_verify_wrong_key_fails() {
        let keys = pqc_keygen();
        let other_keys = pqc_keygen();
        let sig = pqc_sign(&keys.secret_key_hex, b"test").expect("sign should succeed");
        let valid = pqc_verify(&other_keys.public_key_hex, b"test", &sig)
            .expect("verify should not error");
        assert!(!valid, "signature should not verify against a different public key");
    }

    #[test]
    fn test_verify_keypair_valid() {
        let keys = pqc_keygen();
        let ok = pqc_verify_keypair(&keys.public_key_hex, &keys.secret_key_hex)
            .expect("verify_keypair should not error");
        assert!(ok, "matching keypair should pass verify_keypair");
    }

    #[test]
    fn test_verify_keypair_mismatched() {
        let keys1 = pqc_keygen();
        let keys2 = pqc_keygen();
        let ok = pqc_verify_keypair(&keys1.public_key_hex, &keys2.secret_key_hex)
            .expect("verify_keypair should not error on mismatched keys");
        assert!(!ok, "mismatched keypair should fail verify_keypair");
    }

    #[test]
    fn test_signature_length() {
        let keys = pqc_keygen();
        let sig_hex = pqc_sign(&keys.secret_key_hex, b"test").expect("sign should succeed");
        // ML-DSA-65 signatures are 3309 bytes → 6618 hex chars
        assert_eq!(sig_hex.len(), 6618, "signature should be 3309 bytes (6618 hex chars)");
    }

    // ── HD wallet key derivation ─────────────────────────────────────────────

    #[test]
    fn test_keygen_from_seed_deterministic() {
        let seed = [42u8; 32];
        let kp1 = pqc_keygen_from_seed(&seed);
        let kp2 = pqc_keygen_from_seed(&seed);
        assert_eq!(kp1.public_key_hex, kp2.public_key_hex, "same seed → same public key");
        assert_eq!(kp1.secret_key_hex, kp2.secret_key_hex, "same seed → same secret key");
    }

    #[test]
    fn test_keygen_from_seed_different_seeds_different_keys() {
        let seed1 = [1u8; 32];
        let seed2 = [2u8; 32];
        let kp1 = pqc_keygen_from_seed(&seed1);
        let kp2 = pqc_keygen_from_seed(&seed2);
        assert_ne!(kp1.public_key_hex, kp2.public_key_hex, "different seeds → different keys");
    }

    #[test]
    fn test_keygen_from_seed_key_lengths() {
        let seed = [0u8; 32];
        let kp = pqc_keygen_from_seed(&seed);
        // ML-DSA-65: pk=1952 bytes (3904 hex), sk=4032 bytes (8064 hex)
        assert_eq!(kp.public_key_hex.len(), 3904, "public key should be 1952 bytes");
        assert_eq!(kp.secret_key_hex.len(), 8064, "secret key should be 4032 bytes");
    }

    #[test]
    fn test_derive_child_seed_deterministic() {
        let parent = [99u8; 32];
        let child1 = derive_child_seed(&parent, 0);
        let child2 = derive_child_seed(&parent, 0);
        assert_eq!(child1, child2, "same parent + index → same child seed");
    }

    #[test]
    fn test_derive_child_seed_different_indices() {
        let parent = [99u8; 32];
        let child0 = derive_child_seed(&parent, 0);
        let child1 = derive_child_seed(&parent, 1);
        assert_ne!(child0, child1, "different indices → different child seeds");
    }

    #[test]
    fn test_derive_child_seed_different_from_parent() {
        let parent = [99u8; 32];
        let child = derive_child_seed(&parent, 0);
        assert_ne!(parent, child, "child seed should differ from parent seed");
    }

    #[test]
    fn test_pqc_derive_path_deterministic() {
        let seed = [7u8; 32];
        let path = [44u32, 808, 0];
        let kp1 = pqc_derive_path(&seed, &path);
        let kp2 = pqc_derive_path(&seed, &path);
        assert_eq!(kp1.public_key_hex, kp2.public_key_hex, "same path → same keypair");
    }

    #[test]
    fn test_pqc_derive_path_different_accounts() {
        let seed = [7u8; 32];
        let kp0 = pqc_derive_path(&seed, &[44, 808, 0]);
        let kp1 = pqc_derive_path(&seed, &[44, 808, 1]);
        assert_ne!(kp0.public_key_hex, kp1.public_key_hex, "different account index → different keypair");
    }

    #[test]
    fn test_pqc_derive_path_keys_are_valid_for_signing() {
        let seed = [7u8; 32];
        let kp = pqc_derive_path(&seed, &[44, 808, 0]);
        let msg = b"hd wallet signing test";
        let sig = pqc_sign(&kp.secret_key_hex, msg).expect("sign should succeed");
        let ok = pqc_verify(&kp.public_key_hex, msg, &sig).expect("verify should not error");
        assert!(ok, "HD-derived keypair should produce valid signatures");
    }

    // ── Utilities ────────────────────────────────────────────────────────────

    #[test]
    fn test_sha256_known_value() {
        // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
        let result = sha256(b"");
        let hex = bytes_to_hex(&result);
        assert_eq!(hex, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }

    #[test]
    fn test_hex_roundtrip() {
        let original = b"rougechain";
        let hex = bytes_to_hex(original);
        let decoded = hex_to_bytes(&hex).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn test_hex_to_bytes_invalid_input() {
        assert!(hex_to_bytes("zzzz").is_err(), "invalid hex should return error");
        assert!(hex_to_bytes("abc").is_err(), "odd-length hex should return error");
    }
}
