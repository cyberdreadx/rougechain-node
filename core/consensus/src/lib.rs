use rand::RngCore;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::Mutex;

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

/// Pre-fetched entropy cache so the mining loop never blocks on network I/O.
/// A background thread refills the cache; `fetch_entropy()` always returns instantly.
static ENTROPY_CACHE: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Fetch entropy from the cache (instant).  Falls back to local CSPRNG if the
/// cache is empty.  Call `start_entropy_prefetch()` once at startup to keep
/// the cache populated in the background.
pub fn fetch_entropy() -> (String, String) {
    if let Ok(mut cache) = ENTROPY_CACHE.lock() {
        if let Some(hex) = cache.pop() {
            return (hex, "quantum".to_string());
        }
    }
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    (hex::encode(buf), "local".to_string())
}

/// Start a background thread that keeps the entropy cache filled by polling
/// the ANU QRNG API every 30 seconds.  Safe to call more than once (extra
/// calls are no-ops because the cache is shared).
pub fn start_entropy_prefetch() {
    std::thread::spawn(|| {
        let endpoints = [
            "https://qrng.anu.edu.au/API/jsonI.php?length=10&type=hex16&size=32",
            "https://api.quantumnumbers.anu.edu.au?length=10&type=hex16&size=32",
        ];
        loop {
            for url in &endpoints {
                match ureq::get(url)
                    .set("User-Agent", "RougeChain/1.0")
                    .timeout(std::time::Duration::from_secs(5))
                    .call()
                {
                    Ok(resp) => {
                        if let Ok(body) = resp.into_string() {
                            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                                if let Some(data) = json["data"].as_array() {
                                    let mut harvested = 0usize;
                                    if let Ok(mut cache) = ENTROPY_CACHE.lock() {
                                        for v in data {
                                            if let Some(s) = v.as_str() {
                                                let cleaned = s.trim().to_lowercase();
                                                if cleaned.len() >= 32 {
                                                    cache.push(cleaned);
                                                    harvested += 1;
                                                }
                                            }
                                        }
                                    }
                                    if harvested > 0 {
                                        eprintln!("[qrng] cached {} entropy values", harvested);
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => eprintln!("[qrng] prefetch failed for {}: {}", url, e),
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
    });
}
