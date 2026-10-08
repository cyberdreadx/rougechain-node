use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainConfig {
    pub chain_id: String,
    pub genesis_time: u64,
    pub block_time_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
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
    pub nft_royalty_recipient: Option<String>,
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
    #[serde(default)]
    pub nft_public_mint: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nft_mint_price: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nft_token_gate_symbol: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nft_token_gate_amount: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nft_discount_pct: Option<u32>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delegate_to: Option<String>,                      // Delegate voting power to pubkey
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract_attach_symbol: Option<String>,           // Payable call: token paid with the call ("XRGE" or a token)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract_attach_amount: Option<u64>,              // Payable call: quanta (XRGE) or raw token units
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
    // Limit order fields
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_order_id: Option<String>,                    // Order ID (for cancel)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_order_expires: Option<u64>,                  // Expiry block height (0 = never)
    // TOKEN_MINTING (create_token only, from the upgrade's activation height). `None` is omitted
    // from the encoding, so every transaction without them — all of history — encodes, hashes and
    // identifies byte-identically to before these fields existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_mintable: Option<bool>,                      // Some(true): the creator may mint more later
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_max_supply: Option<u64>,                     // Cap on total issuance (initial + minted)
    // SHIELD_V2 (docs/SHIELDED_POOL_V2_SPEC.md §3.1 [P]): the envelope of the three `*_v2` shielded
    // transaction types, from that upgrade's activation height (`None` on every network). `None` is
    // omitted from the encoding, so every transaction without them — all of history — encodes,
    // hashes and identifies byte-identically to before these fields existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shield_v2_body: Option<String>,                    // the 2,546-byte body, lowercase hex (5,092 chars)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shield_v2_proof: Option<String>,                   // the proof bytes, lowercase hex (≤ 400,000 chars)
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
    /// Phase 2 state-root commitment (hex SHA-256 of the balance ledger).
    ///
    /// `None` on every header before the state-root fork. `skip_serializing_if`
    /// omits the field entirely when `None`, so a pre-fork header serializes to
    /// the EXACT bytes it did before this field existed — its signature and
    /// block hash are unchanged, and replaying history does not fork. `default`
    /// lets old stored/received headers (which lack the field) deserialize to
    /// `None`. Populated and verified only at/after the activation height.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_root: Option<String>,
    /// Proposer selection Release 2a: the FINALITY_V2 commit certificate of the PARENT block
    /// (≥ ⅔ of eligible stake precommitted `prev_hash`). Same backward-compatibility contract as
    /// `state_root`: `None` is omitted from the serialized header, so every header without it
    /// hashes and verifies exactly as before. Required (and only allowed) from the Release 2a
    /// activation; a block may then only extend a FINAL parent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_commit: Option<FinalityProof>,
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

/// Domain tag of the network-bound V1 signing format (CHAIN_ID_BINDING).
pub const CHAIN_BOUND_V1_DOMAIN: &[u8] = b"rougechain/tx-v1/chain";

/// CHAIN_ID_BINDING (from that upgrade's activation height): the bytes a V1-format transaction
/// (one without `signed_payload`) is signed over, committing the signature to the network:
/// `CHAIN_BOUND_V1_DOMAIN ‖ 0x00 ‖ u64_be(len(chain_id)) ‖ chain_id ‖ encode_tx_for_signing(tx)`.
/// [`encode_tx_for_signing`] itself is unchanged, so every historical signature, `tx_identity`
/// and pinned hash stays byte-identical; this is a separate, length-prefixed, domain-separated
/// encoding that can never equal a legacy one (a legacy encoding starts with `{`).
pub fn encode_tx_for_signing_chain(tx: &TxV1, chain_id: &str) -> Vec<u8> {
    let body = encode_tx_for_signing(tx);
    let mut out = Vec::with_capacity(CHAIN_BOUND_V1_DOMAIN.len() + 9 + chain_id.len() + body.len());
    out.extend_from_slice(CHAIN_BOUND_V1_DOMAIN);
    out.push(0);
    out.extend_from_slice(&(chain_id.len() as u64).to_be_bytes());
    out.extend_from_slice(chain_id.as_bytes());
    out.extend_from_slice(&body);
    out
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
/// KEY-BOUND transaction identity (used by the transaction-uniqueness consensus rule, the
/// mempool replay guard and the tx-seen index). It covers exactly the bytes the sender's
/// signature commits to and NOTHING an outsider can vary:
///
/// * V2 (`signed_payload` present): `sha256(0x02 || pubkey_bytes || signed_payload_bytes)`.
///   The signature is over `signed_payload`; every other struct field (nonce, payload, fee)
///   is server-derived and MUST be bound to the payload by `verify_v2_binding`.
/// * V1 (no `signed_payload`): `sha256(0x01 || encode_tx_for_signing(tx))` — the signed
///   fields (version, tx_type, from_pub_key, nonce, payload, fee); the signature itself and
///   any attached payload are excluded, so signature re-encoding (hex case, a fresh
///   randomized signature by the owner, a bogus attachment) cannot change the identity.
///
/// Distinct from `compute_single_tx_hash` (the storage/receipt hash over the full struct,
/// which an outsider CAN vary and which therefore must never be used for uniqueness).
pub fn tx_identity(tx: &TxV1) -> String {
    let mut h = Sha256::new();
    match tx.signed_payload.as_deref() {
        Some(sp) => {
            h.update([0x02u8]);
            let pk = hex::decode(&tx.from_pub_key).unwrap_or_else(|_| tx.from_pub_key.as_bytes().to_vec());
            h.update((pk.len() as u64).to_be_bytes());
            h.update(&pk);
            h.update(sp.as_bytes());
        }
        None => {
            h.update([0x01u8]);
            h.update(encode_tx_for_signing(tx));
        }
    }
    hex::encode(h.finalize())
}

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

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_header() -> BlockHeaderV1 {
        BlockHeaderV1 {
            version: 1,
            chain_id: "rougechain-mainnet-1".to_string(),
            height: 42,
            time: 1_700_000_000_000,
            prev_hash: "abc123".to_string(),
            tx_hash: "def456".to_string(),
            proposer_pub_key: "prop789".to_string(),
            state_root: None, parent_commit: None,
        }
    }

    /// The critical backward-compat proof: a header whose `state_root` is `None`
    /// must serialize to EXACTLY the bytes it did before the field existed —
    /// otherwise every historical header's hash/signature would change and
    /// replaying the chain would fork.
    #[test]
    fn none_state_root_serializes_without_the_field() {
        let bytes = encode_header_v1(&sample_header());
        let json = String::from_utf8(bytes).unwrap();
        assert!(!json.contains("state_root"), "None field must be omitted entirely");
        // This is the exact pre-field serialization (fields in declaration order).
        let expected = r#"{"version":1,"chain_id":"rougechain-mainnet-1","height":42,"time":1700000000000,"prev_hash":"abc123","tx_hash":"def456","proposer_pub_key":"prop789"}"#;
        assert_eq!(json, expected, "byte-identical to a pre-state-root header");
    }

    /// An old stored/received header (no `state_root` key) must deserialize
    /// cleanly to `None`.
    #[test]
    fn legacy_header_without_field_deserializes_to_none() {
        let legacy = r#"{"version":1,"chain_id":"rougechain-mainnet-1","height":42,"time":1700000000000,"prev_hash":"abc123","tx_hash":"def456","proposer_pub_key":"prop789"}"#;
        let header: BlockHeaderV1 = serde_json::from_str(legacy).unwrap();
        assert_eq!(header.state_root, None);
        // ...and re-encoding it round-trips to the same bytes.
        assert_eq!(String::from_utf8(encode_header_v1(&header)).unwrap(), legacy);
    }

    /// TOKEN_MINTING compatibility proof. A create_token / mint_tokens transaction as it exists
    /// in history (no `token_mintable` / `token_max_supply`) must encode, hash and identify to
    /// EXACTLY the bytes it did before those fields existed. The pinned values below were
    /// produced by this test on the commit BEFORE the fields were added (88d7270).
    fn legacy_token_txs() -> Vec<TxV1> {
        let create = TxV1 {
            version: 1, tx_type: "create_token".into(), from_pub_key: "ab12".into(), nonce: 7,
            payload: TxPayload { token_name: Some("Qwalla".into()), token_symbol: Some("QWALLA".into()),
                token_decimals: Some(18), token_total_supply: Some(1_000_000_000),
                metadata_image: Some("https://x/y.png".into()), ..Default::default() },
            fee: 100.0, sig: "5151".into(),
            signed_payload: Some(r#"{"type":"create_token","token_name":"Qwalla","token_symbol":"QWALLA","initial_supply":1000000000,"mintable":true,"max_supply":2000000000}"#.into()),
        };
        let mint = TxV1 {
            version: 1, tx_type: "mint_tokens".into(), from_pub_key: "ab12".into(), nonce: 8,
            payload: TxPayload { token_symbol: Some("QWALLA".into()), token_total_supply: Some(5), ..Default::default() },
            fee: 1.0, sig: "5252".into(), signed_payload: None,
        };
        vec![create, mint]
    }

    #[test]
    fn legacy_token_txs_encode_hash_and_identify_unchanged() {
        let txs = legacy_token_txs();
        let enc0 = String::from_utf8(encode_tx_v1(&txs[0])).unwrap();
        let got = (
            sha256_hex(enc0.as_bytes()),
            compute_single_tx_hash(&txs[0]), compute_single_tx_hash(&txs[1]),
            tx_identity(&txs[0]), tx_identity(&txs[1]),
            sha256_hex(&encode_tx_for_signing(&txs[1])),
            compute_tx_hash(&txs),
        );
        assert!(!enc0.contains("token_mintable") && !enc0.contains("token_max_supply"));
        assert_eq!(got, (
            "d7dfab067fc8e02e7e0f87fe9904fb91e08253dd29b872938d4567388c9ecf20".to_string(), "d7dfab067fc8e02e7e0f87fe9904fb91e08253dd29b872938d4567388c9ecf20".to_string(), "1ceeac3215854e08c87fed7125fde70026775fd2f46520e418375828150662e6".to_string(), "c7cb4ec7529db3dd1dacc6e823c0e0a40c380f66011be84d3b140718c8570b9a".to_string(),
            "2a4b1fb733bee8978faff79d4e550bb696fa2206d0d1bc32653cf5e8ae729792".to_string(), "02e482d9e25bad6223b10dc8cac310b4ba6f874572cc2f76b3de58050114b5bb".to_string(), "fb9fa4669e8840a65c0ca03722ab7d22614f8f29becd05e76540229d62db2b62".to_string(),
        ));
        // A stored historical tx re-decodes and re-encodes to the same bytes.
        let back: TxV1 = serde_json::from_str(&enc0).unwrap();
        assert_eq!(String::from_utf8(encode_tx_v1(&back)).unwrap(), enc0);
    }

    fn sha256_hex(b: &[u8]) -> String { hex::encode(Sha256::digest(b)) }

    #[test]
    fn token_mint_fields_serialize_only_when_set_and_roundtrip() {
        let mut tx = legacy_token_txs().remove(0);
        tx.payload.token_mintable = Some(true);
        tx.payload.token_max_supply = Some(9_007_199_254_740_991);
        let enc = String::from_utf8(encode_tx_v1(&tx)).unwrap();
        assert!(enc.contains(r#""token_mintable":true,"token_max_supply":9007199254740991"#), "{enc}");
        let back: TxV1 = serde_json::from_str(&enc).unwrap();
        assert_eq!(back.payload, tx.payload);
        assert_ne!(compute_single_tx_hash(&back), "d7dfab067fc8e02e7e0f87fe9904fb91e08253dd29b872938d4567388c9ecf20");
        // a legacy JSON (no keys) decodes to None/None
        let legacy: TxPayload = serde_json::from_str(r#"{"token_symbol":"A"}"#).unwrap();
        assert_eq!((legacy.token_mintable, legacy.token_max_supply), (None, None));
    }

    /// SHIELD_V2 envelope fields (spec §3.1): omitted when `None` (the pinned legacy hashes above
    /// already prove history is untouched), emitted and round-tripped when set.
    #[test]
    fn shield_v2_fields_serialize_only_when_set_and_roundtrip() {
        let enc0 = String::from_utf8(encode_tx_v1(&legacy_token_txs()[0])).unwrap();
        assert!(!enc0.contains("shield_v2_body") && !enc0.contains("shield_v2_proof"));
        let mut tx = TxV1 {
            version: 1, tx_type: "shielded_transfer_v2".into(), from_pub_key: String::new(), nonce: 0,
            payload: TxPayload { shield_v2_body: Some("00".repeat(2546)), shield_v2_proof: Some("ab".into()), ..Default::default() },
            fee: 0.0, sig: String::new(), signed_payload: None,
        };
        let enc = String::from_utf8(encode_tx_v1(&tx)).unwrap();
        assert!(enc.contains(&format!(r#""shield_v2_body":"{}","shield_v2_proof":"ab""#, "00".repeat(2546))), "{}", &enc[..80]);
        let back: TxV1 = serde_json::from_str(&enc).unwrap();
        assert_eq!(back.payload, tx.payload);
        // the identity covers the payload, hence the proof bytes (spec §3.1, last paragraph)
        let id = tx_identity(&tx);
        tx.payload.shield_v2_proof = Some("ac".into());
        assert_ne!(tx_identity(&tx), id);
        let legacy: TxPayload = serde_json::from_str(r#"{"token_symbol":"A"}"#).unwrap();
        assert_eq!((legacy.shield_v2_body, legacy.shield_v2_proof), (None, None));
    }

    /// CHAIN_ID_BINDING: the network-bound V1 encoding is the legacy encoding behind a
    /// domain-separated, length-prefixed chain id; the legacy encoding (and with it every pinned
    /// hash above) is untouched, and two chain ids never give the same bytes.
    #[test]
    fn chain_bound_v1_encoding_wraps_the_legacy_bytes() {
        let tx = legacy_token_txs().remove(1);
        let legacy = encode_tx_for_signing(&tx);
        let main = encode_tx_for_signing_chain(&tx, "rougechain-mainnet-1");
        let test = encode_tx_for_signing_chain(&tx, "rougechain-devnet-1");
        assert!(main.ends_with(&legacy) && test.ends_with(&legacy));
        assert_ne!(main, test);
        assert_ne!(main, legacy);
        assert_eq!(legacy.first(), Some(&b'{'));
        let mut want = b"rougechain/tx-v1/chain\0".to_vec();
        want.extend_from_slice(&20u64.to_be_bytes());
        want.extend_from_slice(b"rougechain-mainnet-1");
        want.extend_from_slice(&legacy);
        assert_eq!(main, want);
        // the legacy signing bytes of the pinned mint tx are unchanged (same pin as above)
        assert_eq!(sha256_hex(&legacy), "02e482d9e25bad6223b10dc8cac310b4ba6f874572cc2f76b3de58050114b5bb");
    }

    /// A post-fork header carries the field and it survives a round-trip.
    #[test]
    fn some_state_root_is_serialized_and_roundtrips() {
        let mut h = sample_header();
        h.state_root = Some("deadbeef".to_string());
        let json = String::from_utf8(encode_header_v1(&h)).unwrap();
        assert!(json.contains(r#""state_root":"deadbeef""#), "populated field is emitted");
        let back: BlockHeaderV1 = serde_json::from_slice(&encode_header_v1(&h)).unwrap();
        assert_eq!(back.state_root, Some("deadbeef".to_string()));
    }
}
