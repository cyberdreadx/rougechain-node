use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainConfig {
    pub chain_id: String,
    pub genesis_time: u64,
    pub block_time_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TxPayload {
    pub to_pub_key_hex: Option<String>,
    pub amount: Option<u64>,
    pub faucet: Option<bool>,
    pub target_pub_key: Option<String>,
    pub reason: Option<String>,
    // Token creation fields
    pub token_name: Option<String>,
    pub token_symbol: Option<String>,
    pub token_decimals: Option<u8>,
    pub token_total_supply: Option<u64>,
    // Token metadata fields (for update_token_metadata tx)
    pub metadata_image: Option<String>,       // Image URL (IPFS, HTTP, or data URI)
    pub metadata_description: Option<String>, // Token description
    pub metadata_website: Option<String>,     // Project website
    pub metadata_twitter: Option<String>,     // X (formerly Twitter) handle
    pub metadata_discord: Option<String>,     // Discord server
    // AMM/DEX fields
    pub pool_id: Option<String>,           // Pool identifier (sorted token pair)
    pub token_a_symbol: Option<String>,    // First token in pair
    pub token_b_symbol: Option<String>,    // Second token in pair
    pub amount_a: Option<u64>,             // Amount of token A
    pub amount_b: Option<u64>,             // Amount of token B
    pub min_amount_out: Option<u64>,       // Minimum output (slippage protection)
    pub swap_path: Option<Vec<String>>,    // Multi-hop path [TOKENA, XRGE, TOKENB]
    pub lp_amount: Option<u64>,            // LP token amount for remove_liquidity
    // Bridge withdraw: EVM address to receive ETH when burning qETH
    pub evm_address: Option<String>,
    // NFT fields
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nft_collection_symbol: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nft_collection_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nft_collection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nft_description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nft_image: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nft_max_supply: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nft_royalty_bps: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nft_token_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nft_token_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nft_metadata_uri: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nft_attributes: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nft_locked: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nft_frozen: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nft_batch_names: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nft_batch_uris: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nft_batch_attributes: Option<Vec<serde_json::Value>>,
    // Shielded transaction fields (Phase 2)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shielded_nullifiers: Option<Vec<String>>,         // Hex nullifiers of consumed notes
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shielded_output_commitments: Option<Vec<String>>, // Hex output commitments
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shielded_proof: Option<String>,                   // Hex-encoded STARK proof
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shielded_fee: Option<u64>,                        // Fee (public)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shielded_commitment: Option<String>,              // Single commitment (for shield/unshield)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shielded_value: Option<u64>,                      // Value being shielded/unshielded
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shielded_randomness: Option<String>,              // Hex randomness (for unshield proof)
    // Token locking fields
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lock_until_height: Option<u64>,                   // Block height when tokens unlock
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lock_id: Option<String>,                          // Unique lock identifier
    // Token staking fields (custom token staking pools)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staking_pool_id: Option<String>,                  // Token staking pool identifier
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staking_reward_rate: Option<u64>,                 // Annual reward rate in basis points
    // Governance fields
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal_id: Option<String>,                      // Governance proposal ID
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal_title: Option<String>,                   // Proposal title
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal_description: Option<String>,             // Proposal description
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vote_option: Option<String>,                      // "yes" | "no" | "abstain"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal_end_height: Option<u64>,                 // Block height when voting ends
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal_type: Option<String>,                    // "text" | "param_change" | "treasury_spend"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal_action_payload: Option<serde_json::Value>, // Type-specific action data
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal_quorum: Option<u64>,                     // Min total votes required
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal_timelock_blocks: Option<u64>,            // Blocks to wait after voting ends
    // Allowance fields (approve/transferFrom pattern)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spender_pub_key: Option<String>,                  // Approved spender public key
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowance_amount: Option<u64>,                    // Approved spending amount
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_pub_key: Option<String>,                    // Token owner (for transfer_from)
    // Airdrop fields
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub airdrop_recipients: Option<Vec<String>>,          // List of recipient public keys
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub airdrop_amounts: Option<Vec<u64>>,                // Amounts for each recipient
    // WASM contract fields
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract_wasm: Option<String>,                    // Base64-encoded WASM bytecode (deploy)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract_addr: Option<String>,                    // Target contract address (call)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract_method: Option<String>,                  // Method name to call
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract_args: Option<serde_json::Value>,         // JSON arguments for the method
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract_gas_limit: Option<u64>,                  // Max fuel for execution
    // Multi-sig wallet fields
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multisig_wallet_id: Option<String>,                // Wallet identifier
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multisig_signers: Option<Vec<String>>,             // N public keys
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multisig_threshold: Option<u32>,                   // M — required signatures
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multisig_label: Option<String>,                    // optional label
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multisig_proposal_id: Option<String>,              // Proposal identifier
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multisig_proposal_tx_type: Option<String>,         // Inner tx type (transfer, etc)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multisig_proposal_payload: Option<serde_json::Value>, // Inner tx payload
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multisig_proposal_fee: Option<f64>,                // Inner tx fee
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multisig_approval_sig: Option<String>,             // Co-signer's signature for approve
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signed_payload: Option<String>,
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

/// A serializable BFT finality proof — aggregated precommit votes that prove
/// a block was finalized with ≥2/3 validator stake.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FinalityProof {
    /// Block height this proof covers
    pub height: u64,
    /// Block hash that was finalized
    pub block_hash: String,
    /// Total stake in the validator set at this height
    pub total_stake: u128,
    /// Stake that voted for this block (must be ≥ 2/3 + 1 of total)
    pub voting_stake: u128,
    /// Quorum threshold (2/3 + 1)
    pub quorum_threshold: u128,
    /// Individual precommit votes that form the proof
    pub precommit_votes: Vec<VoteMessage>,
    /// Timestamp when proof was generated
    pub created_at: u64,
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

/// Encode everything except `sig` — this is the message that gets signed/verified.
pub fn encode_tx_for_signing(tx: &TxV1) -> Vec<u8> {
    #[derive(Serialize)]
    struct Signable<'a> {
        version: u32,
        tx_type: &'a str,
        from_pub_key: &'a str,
        nonce: u64,
        payload: &'a TxPayload,
        fee: f64,
    }
    let s = Signable {
        version: tx.version,
        tx_type: &tx.tx_type,
        from_pub_key: &tx.from_pub_key,
        nonce: tx.nonce,
        payload: &tx.payload,
        fee: tx.fee,
    };
    serde_json::to_vec(&s).unwrap_or_default()
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

/// Compute a unique hash for a single transaction.
pub fn compute_single_tx_hash(tx: &TxV1) -> String {
    let bytes = encode_tx_v1(tx);
    hex::encode(Sha256::digest(&bytes))
}

// ─── Transaction Receipts ──────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TxStatus {
    Success,
    Failed(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TxLog {
    pub event_type: String,         // e.g. "transfer", "token_create", "nft_mint"
    pub data: serde_json::Value,    // Arbitrary event data
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TxReceipt {
    pub tx_hash: String,
    pub block_height: u64,
    pub block_hash: String,
    pub index: u32,                 // Position in block
    pub tx_type: String,
    pub from: String,               // Sender public key
    pub status: TxStatus,
    pub fee_paid: f64,
    pub logs: Vec<TxLog>,
    pub timestamp: u64,             // Block timestamp
}
