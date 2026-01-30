use pqcrypto_dilithium::dilithium5;
use pqcrypto_traits::sign::{PublicKey, SecretKey, SignedMessage};
use rand::RngCore;
use sha2::{Digest, Sha256};

use quantum_vault_types::PQKeypair;

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
    let (pk, sk) = dilithium5::keypair();
    PQKeypair {
        algorithm: "ML-DSA-65".to_string(),
        public_key_hex: bytes_to_hex(pk.as_bytes()),
        secret_key_hex: bytes_to_hex(sk.as_bytes()),
    }
}

pub fn pqc_sign(secret_key_hex: &str, message: &[u8]) -> Result<String, String> {
    let sk_bytes = hex_to_bytes(secret_key_hex)?;
    let sk = dilithium5::SecretKey::from_bytes(&sk_bytes)
        .map_err(|_| "invalid secret key bytes")?;
    let signed = dilithium5::sign(message, &sk);
    Ok(bytes_to_hex(signed.as_bytes()))
}

pub fn pqc_verify(public_key_hex: &str, message: &[u8], signature_hex: &str) -> Result<bool, String> {
    let pk_bytes = hex_to_bytes(public_key_hex)?;
    let sig_bytes = hex_to_bytes(signature_hex)?;
    let pk = dilithium5::PublicKey::from_bytes(&pk_bytes)
        .map_err(|_| "invalid public key bytes")?;
    let signed = dilithium5::SignedMessage::from_bytes(&sig_bytes)
        .map_err(|_| "invalid signature bytes")?;
    Ok(dilithium5::open(&signed, &pk).map(|msg| msg == message).unwrap_or(false))
}

pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    bytes_to_hex(&buf)
}
