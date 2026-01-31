use fips204::ml_dsa_65::{self, PrivateKey, PublicKey};
use fips204::traits::{SerDes, Signer, Verifier};
use rand::RngCore;
use sha2::{Digest, Sha256};

use quantum_vault_types::PQKeypair;

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
