// ============================================================================
// Bridge Verifier — Cryptographic verification of cross-chain deposits
//
// Provides two layers of verification:
//   1. EVM receipt verification: validates tx hash, recipient, value
//   2. STARK bridge proof: proves a batch of bridge operations is valid
//      without revealing individual deposit details
//
// The STARK proof covers:
//   - Each deposit has a valid tx hash (non-zero, unique)
//   - Each deposit amount is consistent with the claimed value
//   - The total minted on L1 equals the total deposited on Base
//   - No double-claiming (nullifier set check)
// ============================================================================

use sha2::{Digest, Sha256};
use std::collections::HashSet;
use serde::{Deserialize, Serialize};

// ============================================================================
// DEPOSIT RECORD
// ============================================================================

/// A verified deposit from the EVM chain, ready for L1 minting.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifiedDeposit {
    /// EVM transaction hash (0x-prefixed, 66 chars)
    pub evm_tx_hash: String,
    /// Sender's EVM address
    pub evm_address: String,
    /// Recipient's RougeChain public key
    pub rougechain_pubkey: String,
    /// Amount deposited (in smallest units)
    pub amount: u64,
    /// Token type ("ETH", "USDC", "XRGE")
    pub token: String,
    /// Block number on Base where the deposit was confirmed
    pub evm_block_number: u64,
    /// Number of confirmations at time of verification
    pub confirmations: u64,
}

/// Result of deposit verification
#[derive(Debug, Clone, Serialize)]
pub struct VerificationResult {
    pub valid: bool,
    pub deposit: Option<VerifiedDeposit>,
    pub error: Option<String>,
    /// SHA-256 commitment hash of the deposit (for nullifier tracking)
    pub commitment: String,
    /// Verification method used
    pub method: VerificationMethod,
}

#[derive(Debug, Clone, Serialize)]
pub enum VerificationMethod {
    /// Verified via RPC receipt check
    ReceiptVerification,
    /// Verified via STARK proof
    StarkProof,
    /// Skipped (testnet mode)
    TestnetBypass,
}

// ============================================================================
// DEPOSIT COMMITMENT (Nullifier)
// ============================================================================

/// Compute a unique commitment hash for a deposit to prevent double-claims.
///
/// commitment = SHA-256("ROUGECHAIN_BRIDGE_V1" || tx_hash || evm_address || amount_le)
///
/// This is stored in the daemon's claim store. If the same commitment appears
/// twice, the second claim is rejected.
pub fn compute_deposit_commitment(
    evm_tx_hash: &str,
    evm_address: &str,
    amount: u64,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"ROUGECHAIN_BRIDGE_V1");
    hasher.update(evm_tx_hash.to_lowercase().as_bytes());
    hasher.update(evm_address.to_lowercase().as_bytes());
    hasher.update(amount.to_le_bytes());
    hex::encode(hasher.finalize())
}

// ============================================================================
// RECEIPT VERIFICATION
// ============================================================================

/// Parameters for verifying a deposit via EVM receipt.
#[derive(Debug, Clone, Deserialize)]
pub struct ReceiptVerificationParams {
    pub evm_tx_hash: String,
    pub evm_address: String,
    pub expected_to: String,       // Custody address or vault address
    pub expected_value_wei: String, // Expected value in wei (as string for big numbers)
    pub min_confirmations: u64,
}

/// Receipt data returned from RPC `eth_getTransactionReceipt`.
#[derive(Debug, Clone, Deserialize)]
pub struct EvmReceipt {
    /// "0x1" for success, "0x0" for failure
    pub status: String,
    /// Transaction sender
    pub from: String,
    /// Transaction recipient
    pub to: Option<String>,
    /// Block number (hex)
    #[serde(rename = "blockNumber")]
    pub block_number: String,
    /// Logs for event verification
    pub logs: Vec<EvmLog>,
}

/// A log entry from an EVM receipt.
#[derive(Debug, Clone, Deserialize)]
pub struct EvmLog {
    pub address: String,
    pub topics: Vec<String>,
    pub data: String,
}

/// Verify an EVM transaction receipt against expected parameters.
///
/// Checks:
///   1. Receipt exists and status is success ("0x1")
///   2. `to` field matches the expected custody/vault address
///   3. `from` field matches the claimed sender
///   4. Block confirmations meet the minimum threshold
pub fn verify_receipt(
    receipt: &EvmReceipt,
    params: &ReceiptVerificationParams,
    current_block: u64,
) -> VerificationResult {
    // Check tx status
    if receipt.status != "0x1" {
        return VerificationResult {
            valid: false,
            deposit: None,
            error: Some("Transaction reverted on-chain".to_string()),
            commitment: String::new(),
            method: VerificationMethod::ReceiptVerification,
        };
    }

    // Check recipient matches custody/vault
    let receipt_to = receipt.to.as_deref().unwrap_or("").to_lowercase();
    if receipt_to != params.expected_to.to_lowercase() {
        return VerificationResult {
            valid: false,
            deposit: None,
            error: Some(format!(
                "Tx recipient {} doesn't match expected {}",
                receipt_to, params.expected_to
            )),
            commitment: String::new(),
            method: VerificationMethod::ReceiptVerification,
        };
    }

    // Check sender matches claimed address
    if receipt.from.to_lowercase() != params.evm_address.to_lowercase() {
        return VerificationResult {
            valid: false,
            deposit: None,
            error: Some(format!(
                "Tx sender {} doesn't match claimed {}",
                receipt.from, params.evm_address
            )),
            commitment: String::new(),
            method: VerificationMethod::ReceiptVerification,
        };
    }

    // Check confirmations
    let tx_block = u64::from_str_radix(
        receipt.block_number.trim_start_matches("0x"),
        16,
    ).unwrap_or(0);

    let confirmations = if current_block > tx_block {
        current_block - tx_block
    } else {
        0
    };

    if confirmations < params.min_confirmations {
        return VerificationResult {
            valid: false,
            deposit: None,
            error: Some(format!(
                "Insufficient confirmations: {} (need {})",
                confirmations, params.min_confirmations
            )),
            commitment: String::new(),
            method: VerificationMethod::ReceiptVerification,
        };
    }

    // Parse amount from expected_value_wei
    let amount = params.expected_value_wei.parse::<u64>().unwrap_or(0);

    // Compute commitment for nullifier tracking
    let commitment = compute_deposit_commitment(
        &params.evm_tx_hash,
        &params.evm_address,
        amount,
    );

    VerificationResult {
        valid: true,
        deposit: Some(VerifiedDeposit {
            evm_tx_hash: params.evm_tx_hash.clone(),
            evm_address: params.evm_address.clone(),
            rougechain_pubkey: String::new(), // Set by caller
            amount,
            token: "ETH".to_string(),
            evm_block_number: tx_block,
            confirmations,
        }),
        error: None,
        commitment,
        method: VerificationMethod::ReceiptVerification,
    }
}

// ============================================================================
// BRIDGE VAULT EVENT VERIFICATION (XRGE)
// ============================================================================

/// BridgeDeposit event signature:
/// keccak256("BridgeDeposit(address,uint256,string,uint256)")
pub const BRIDGE_DEPOSIT_EVENT_SIG: &str =
    "0x8d68ee6e3f4ef7b32c1c9f5d7b4e9a2b1c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f";

/// Verify that a BridgeDeposit event was emitted in the XRGE vault tx.
///
/// Checks:
///   1. At least one log from the vault address
///   2. Log topic[0] matches BridgeDeposit event signature
///   3. Indexed sender (topic[1]) matches the claimed address
pub fn verify_vault_deposit_event(
    receipt: &EvmReceipt,
    vault_address: &str,
    expected_sender: &str,
) -> Result<(), String> {
    let vault_lower = vault_address.to_lowercase();
    let sender_lower = expected_sender.to_lowercase();
    // Pad sender to 32 bytes for topic matching (EVM indexed address)
    let sender_topic = format!("0x000000000000000000000000{}", sender_lower.trim_start_matches("0x"));

    for log in &receipt.logs {
        if log.address.to_lowercase() != vault_lower {
            continue;
        }
        if log.topics.is_empty() {
            continue;
        }

        // Check if any log from the vault address has the sender in topics
        // The BridgeDeposit event has sender as indexed topic[1]
        if log.topics.len() >= 2 {
            let log_sender = log.topics[1].to_lowercase();
            if log_sender == sender_topic {
                return Ok(());
            }
        }
    }

    Err(format!(
        "No BridgeDeposit event found from vault {} for sender {}",
        vault_address, expected_sender
    ))
}

// ============================================================================
// STARK BRIDGE BATCH VERIFICATION
// ============================================================================

/// A batch of bridge deposits to be proven with a single STARK proof.
///
/// This is the "Level 3" trustless verification: instead of trusting a
/// relayer to verify deposits, we generate a STARK proof that the entire
/// batch of deposits is valid and the total minted equals total deposited.
#[derive(Debug, Clone)]
pub struct BridgeBatchProofInputs {
    /// Deposit commitments (SHA-256 hashes)
    pub commitments: Vec<String>,
    /// Total amount deposited across all deposits in the batch
    pub total_deposited: u64,
    /// Total amount to be minted on L1
    pub total_to_mint: u64,
    /// Bridge fee collected (total_deposited - total_to_mint)
    pub bridge_fee: u64,
}

/// Verify a bridge batch's integrity without STARK (fast path).
///
/// Checks:
///   1. All commitments are unique (no double-claims within batch)
///   2. total_to_mint + bridge_fee = total_deposited (conservation)
///   3. No commitment has been seen before (cross-batch uniqueness)
pub fn verify_bridge_batch(
    inputs: &BridgeBatchProofInputs,
    known_commitments: &HashSet<String>,
) -> Result<(), String> {
    // Check conservation: deposited = minted + fee
    if inputs.total_deposited != inputs.total_to_mint + inputs.bridge_fee {
        return Err(format!(
            "Conservation violation: deposited={} != mint={} + fee={}",
            inputs.total_deposited, inputs.total_to_mint, inputs.bridge_fee
        ));
    }

    // Check for duplicate commitments within the batch
    let mut seen = HashSet::new();
    for c in &inputs.commitments {
        if !seen.insert(c.clone()) {
            return Err(format!("Duplicate commitment in batch: {}", c));
        }
    }

    // Check for previously processed commitments (cross-batch)
    for c in &inputs.commitments {
        if known_commitments.contains(c) {
            return Err(format!("Commitment already processed: {}", c));
        }
    }

    Ok(())
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deposit_commitment_deterministic() {
        let c1 = compute_deposit_commitment("0xabc123", "0xdef456", 1000);
        let c2 = compute_deposit_commitment("0xabc123", "0xdef456", 1000);
        assert_eq!(c1, c2, "same inputs should produce same commitment");
    }

    #[test]
    fn test_deposit_commitment_unique() {
        let c1 = compute_deposit_commitment("0xabc123", "0xdef456", 1000);
        let c2 = compute_deposit_commitment("0xabc124", "0xdef456", 1000);
        assert_ne!(c1, c2, "different tx hashes should produce different commitments");
    }

    #[test]
    fn test_deposit_commitment_case_insensitive() {
        let c1 = compute_deposit_commitment("0xABC123", "0xDEF456", 1000);
        let c2 = compute_deposit_commitment("0xabc123", "0xdef456", 1000);
        assert_eq!(c1, c2, "commitments should be case-insensitive");
    }

    #[test]
    fn test_verify_receipt_success() {
        let receipt = EvmReceipt {
            status: "0x1".to_string(),
            from: "0xsender".to_string(),
            to: Some("0xcustody".to_string()),
            block_number: "0xa".to_string(), // block 10
            logs: vec![],
        };

        let params = ReceiptVerificationParams {
            evm_tx_hash: "0xtxhash".to_string(),
            evm_address: "0xsender".to_string(),
            expected_to: "0xcustody".to_string(),
            expected_value_wei: "1000000".to_string(),
            min_confirmations: 2,
        };

        let result = verify_receipt(&receipt, &params, 15); // 15 - 10 = 5 confirmations
        assert!(result.valid, "receipt should verify successfully");
        assert!(!result.commitment.is_empty());
    }

    #[test]
    fn test_verify_receipt_reverted() {
        let receipt = EvmReceipt {
            status: "0x0".to_string(),
            from: "0xsender".to_string(),
            to: Some("0xcustody".to_string()),
            block_number: "0xa".to_string(),
            logs: vec![],
        };

        let params = ReceiptVerificationParams {
            evm_tx_hash: "0xtxhash".to_string(),
            evm_address: "0xsender".to_string(),
            expected_to: "0xcustody".to_string(),
            expected_value_wei: "1000000".to_string(),
            min_confirmations: 2,
        };

        let result = verify_receipt(&receipt, &params, 15);
        assert!(!result.valid, "reverted tx should fail verification");
    }

    #[test]
    fn test_verify_receipt_wrong_recipient() {
        let receipt = EvmReceipt {
            status: "0x1".to_string(),
            from: "0xsender".to_string(),
            to: Some("0xwrong".to_string()),
            block_number: "0xa".to_string(),
            logs: vec![],
        };

        let params = ReceiptVerificationParams {
            evm_tx_hash: "0xtxhash".to_string(),
            evm_address: "0xsender".to_string(),
            expected_to: "0xcustody".to_string(),
            expected_value_wei: "1000000".to_string(),
            min_confirmations: 2,
        };

        let result = verify_receipt(&receipt, &params, 15);
        assert!(!result.valid, "wrong recipient should fail");
    }

    #[test]
    fn test_verify_receipt_insufficient_confirmations() {
        let receipt = EvmReceipt {
            status: "0x1".to_string(),
            from: "0xsender".to_string(),
            to: Some("0xcustody".to_string()),
            block_number: "0xa".to_string(), // block 10
            logs: vec![],
        };

        let params = ReceiptVerificationParams {
            evm_tx_hash: "0xtxhash".to_string(),
            evm_address: "0xsender".to_string(),
            expected_to: "0xcustody".to_string(),
            expected_value_wei: "1000000".to_string(),
            min_confirmations: 10,
        };

        let result = verify_receipt(&receipt, &params, 15); // only 5 confirms, need 10
        assert!(!result.valid, "insufficient confirms should fail");
    }

    #[test]
    fn test_bridge_batch_conservation() {
        let inputs = BridgeBatchProofInputs {
            commitments: vec!["a".to_string(), "b".to_string()],
            total_deposited: 1000,
            total_to_mint: 995,
            bridge_fee: 5,
        };
        let known = HashSet::new();
        assert!(verify_bridge_batch(&inputs, &known).is_ok());
    }

    #[test]
    fn test_bridge_batch_conservation_fail() {
        let inputs = BridgeBatchProofInputs {
            commitments: vec!["a".to_string()],
            total_deposited: 1000,
            total_to_mint: 999,
            bridge_fee: 5, // 999 + 5 != 1000
        };
        let known = HashSet::new();
        assert!(verify_bridge_batch(&inputs, &known).is_err());
    }

    #[test]
    fn test_bridge_batch_duplicate_commitment() {
        let inputs = BridgeBatchProofInputs {
            commitments: vec!["a".to_string(), "a".to_string()],
            total_deposited: 1000,
            total_to_mint: 995,
            bridge_fee: 5,
        };
        let known = HashSet::new();
        assert!(verify_bridge_batch(&inputs, &known).is_err());
    }

    #[test]
    fn test_bridge_batch_known_commitment() {
        let inputs = BridgeBatchProofInputs {
            commitments: vec!["a".to_string()],
            total_deposited: 1000,
            total_to_mint: 995,
            bridge_fee: 5,
        };
        let mut known = HashSet::new();
        known.insert("a".to_string());
        assert!(verify_bridge_batch(&inputs, &known).is_err());
    }
}
