use rand::RngCore;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub struct ProposerSelectionResult {
    pub proposer_pub_key: String,
    pub total_stake: u128,
    pub selection_weight: u128,
    pub entropy_source: String,
    pub entropy_hex: String,
}

pub fn compute_selection_seed(entropy_hex: &str, prev_hash: &str, height: u64) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(entropy_hex.as_bytes());
    hasher.update(prev_hash.as_bytes());
    hasher.update(height.to_string().as_bytes());
    hasher.finalize().to_vec()
}

pub fn select_proposer(
    stakes: &BTreeMap<String, u128>,
    seed: &[u8],
    entropy_hex: &str,
    source: &str,
) -> Option<ProposerSelectionResult> {
    if stakes.is_empty() {
        return None;
    }

    let total: u128 = stakes.values().sum();
    if total == 0 {
        return None;
    }

    let mut hash = Sha256::new();
    hash.update(seed);
    let digest = hash.finalize();
    let mut selection_bytes = [0u8; 16];
    selection_bytes.copy_from_slice(&digest[..16]);
    let selection_weight = u128::from_be_bytes(selection_bytes) % total;

    let mut cursor = 0u128;
    for (pub_key, stake) in stakes.iter() {
        cursor += *stake;
        if selection_weight < cursor {
            return Some(ProposerSelectionResult {
                proposer_pub_key: pub_key.clone(),
                total_stake: total,
                selection_weight,
                entropy_source: source.to_string(),
                entropy_hex: entropy_hex.to_string(),
            });
        }
    }
    None
}

pub fn fetch_entropy() -> (String, String) {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    (hex::encode(buf), "local".to_string())
}
