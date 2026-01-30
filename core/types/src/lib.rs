use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainConfig {
    pub chain_id: String,
    pub genesis_time: u64,
    pub block_time_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TxPayload {
    pub to_pub_key_hex: Option<String>,
    pub amount: Option<u64>,
    pub faucet: Option<bool>,
    pub target_pub_key: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TxV1 {
    pub version: u32,
    pub tx_type: String,
    pub from_pub_key: String,
    pub nonce: u64,
    pub payload: TxPayload,
    pub fee: f64,
    pub sig: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockHeaderV1 {
    pub version: u32,
    pub chain_id: String,
    pub height: u64,
    pub time: u64,
    pub prev_hash: String,
    pub tx_hash: String,
    pub proposer_pub_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockV1 {
    pub version: u32,
    pub header: BlockHeaderV1,
    pub txs: Vec<TxV1>,
    pub proposer_sig: String,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoteMessage {
    pub vote_type: String,
    pub height: u64,
    pub round: u32,
    pub block_hash: String,
    pub voter_pub_key: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlashPayload {
    pub target_pub_key: String,
    pub amount: u64,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PQKeypair {
    pub algorithm: String,
    pub public_key_hex: String,
    pub secret_key_hex: String,
}

pub fn encode_tx_v1(tx: &TxV1) -> Vec<u8> {
    serde_json::to_vec(tx).unwrap_or_default()
}

pub fn encode_header_v1(header: &BlockHeaderV1) -> Vec<u8> {
    serde_json::to_vec(header).unwrap_or_default()
}

pub fn compute_tx_hash(txs: &[TxV1]) -> String {
    let mut hasher = Sha256::new();
    for tx in txs {
        hasher.update(encode_tx_v1(tx));
    }
    hex::encode(hasher.finalize())
}

pub fn compute_block_hash(header_bytes: &[u8], proposer_sig: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(header_bytes);
    hasher.update(proposer_sig.as_bytes());
    hex::encode(hasher.finalize())
}
