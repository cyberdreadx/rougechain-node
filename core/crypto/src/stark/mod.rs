// ============================================================================
// quantum-vault-crypto :: stark — zk-STARK proof module
//
// Provides a quantum-resistant zero-knowledge proof system built on the
// winterfell library.  STARKs use only collision-resistant hash functions
// (no elliptic curves), making them inherently post-quantum secure.
//
// Current AIRs:
//   BalanceTransfer   — proves a value-conserving token transfer
//                       without revealing the actual balances involved.
//   ShieldedTransfer  — proves a private note-to-note transfer with
//                       bit-decomposition range checks (Phase 2).
// ============================================================================

pub mod air;
pub mod commitment;
pub mod prover;
pub mod rollup_air;
pub mod rollup_prover;
pub mod shielded_air;
pub mod shielded_prover;
pub mod verifier;

// Re-export the public API — Phase 1 (balance transfers)
pub use prover::prove_balance_transfer;
pub use verifier::verify_balance_transfer;

// Re-export the public API — Phase 2 (shielded transfers)
pub use commitment::{compute_commitment, compute_nullifier, generate_randomness, verify_commitment};
pub use shielded_prover::prove_shielded_transfer;

// Re-export the public API — Phase 3 (rollup batches)
pub use rollup_prover::{prove_rollup_batch, RollupTransfer};

use winterfell::math::{fields::f128::BaseElement, ToElements};

/// Public inputs for a balance-transfer STARK proof.
///
/// The verifier only sees these values — never the actual sender/receiver
/// balances.  The proof guarantees that:
///   1. sender_before >= amount  (no overdraft)
///   2. sender_after  = sender_before - amount
///   3. receiver_after = receiver_before + amount
///   4. total value is conserved
#[derive(Debug, Clone)]
pub struct BalanceTransferInputs {
    /// Total value across both accounts (remains constant)
    pub total_value: BaseElement,
    /// The final sender balance
    pub final_sender_balance: BaseElement,
    /// The final receiver balance
    pub final_receiver_balance: BaseElement,
}

impl ToElements<BaseElement> for BalanceTransferInputs {
    fn to_elements(&self) -> Vec<BaseElement> {
        vec![
            self.total_value,
            self.final_sender_balance,
            self.final_receiver_balance,
        ]
    }
}

/// Public inputs for a shielded-transfer STARK proof.
///
/// The verifier sees only these values. The actual input value, note
/// contents, and balances remain hidden. The proof guarantees:
///   1. input_value = output_1 + output_2 + fee (conservation)
///   2. input_value fits in 64 bits (range check via bit decomposition)
#[derive(Debug, Clone)]
pub struct ShieldedTransferInputs {
    /// Output 1 value (hidden in commitment on-chain, revealed to verifier in proof)
    pub output_1_commitment_value: BaseElement,
    /// Output 2 value (change, hidden in commitment on-chain)
    pub output_2_commitment_value: BaseElement,
    /// Transaction fee (always public)
    pub fee: BaseElement,
    /// First bit of input value (MSB, for boundary assertion)
    pub first_bit: BaseElement,
    /// Full input value reconstructed from bits (must equal input, range check)
    pub input_value_check: BaseElement,
}

impl ToElements<BaseElement> for ShieldedTransferInputs {
    fn to_elements(&self) -> Vec<BaseElement> {
        vec![
            self.output_1_commitment_value,
            self.output_2_commitment_value,
            self.fee,
            self.first_bit,
            self.input_value_check,
        ]
    }
}

/// Verify a shielded transfer STARK proof.
pub fn verify_shielded_transfer(
    proof: winterfell::Proof,
    pub_inputs: ShieldedTransferInputs,
) -> Result<(), String> {
    use winterfell::{AcceptableOptions, crypto::{DefaultRandomCoin, MerkleTree}};

    let acceptable_options =
        AcceptableOptions::OptionSet(vec![proof.options().clone()]);

    winterfell::verify::<
        shielded_air::ShieldedTransferAir,
        Blake3Hasher,
        DefaultRandomCoin<Blake3Hasher>,
        MerkleTree<Blake3Hasher>,
    >(proof, pub_inputs, &acceptable_options)
        .map_err(|e| format!("Shielded proof verification failed: {}", e))
}

/// Convenience: verify a shielded transfer from raw proof bytes + u64 values.
///
/// This function handles winterfell deserialization internally so the caller
/// doesn't need a direct `winterfell` dependency.
///
/// # Arguments
/// * `proof_bytes` — Serialized winterfell Proof (from `Proof::to_bytes()`)
/// * `output_1` — Value of first output note (recipient)
/// * `output_2` — Value of second output note (change)
/// * `fee` — Transaction fee (public)
pub fn verify_shielded_transfer_bytes(
    proof_bytes: &[u8],
    output_1: u64,
    output_2: u64,
    fee: u64,
) -> Result<(), String> {
    let proof = winterfell::Proof::from_bytes(proof_bytes)
        .map_err(|e| format!("Invalid STARK proof bytes: {}", e))?;

    // Reconstruct public inputs from the provided values
    let input_value = output_1 + output_2 + fee;
    let first_bit = (input_value >> 63) & 1;

    let pub_inputs = ShieldedTransferInputs {
        output_1_commitment_value: BaseElement::from(output_1),
        output_2_commitment_value: BaseElement::from(output_2),
        fee: BaseElement::from(fee),
        first_bit: BaseElement::from(first_bit),
        input_value_check: BaseElement::from(input_value),
    };

    verify_shielded_transfer(proof, pub_inputs)
}

type Blake3Hasher = winterfell::crypto::hashers::Blake3_256<BaseElement>;

/// Public inputs for a rollup batch STARK proof.
///
/// The verifier only sees these values — never the individual transfer
/// details. The proof guarantees:
///   1. Every transfer in the batch conserves value
///   2. No sender overdrafts
///   3. The state root transitions from pre → post correctly
#[derive(Debug, Clone)]
pub struct RollupBatchInputs {
    /// State root before the batch
    pub pre_state_root: BaseElement,
    /// State root after the batch
    pub post_state_root: BaseElement,
    /// Number of transfers in the batch
    pub batch_size: BaseElement,
    /// Total fees collected from all transfers
    pub total_fees: BaseElement,
}

impl ToElements<BaseElement> for RollupBatchInputs {
    fn to_elements(&self) -> Vec<BaseElement> {
        vec![
            self.pre_state_root,
            self.post_state_root,
            self.batch_size,
            self.total_fees,
        ]
    }
}

/// Verify a rollup batch STARK proof.
pub fn verify_rollup_batch(
    proof: winterfell::Proof,
    pub_inputs: RollupBatchInputs,
) -> Result<(), String> {
    use winterfell::{AcceptableOptions, crypto::{DefaultRandomCoin, MerkleTree}};

    let acceptable_options =
        AcceptableOptions::OptionSet(vec![proof.options().clone()]);

    winterfell::verify::< 
        rollup_air::RollupBatchAir,
        Blake3Hasher,
        DefaultRandomCoin<Blake3Hasher>,
        MerkleTree<Blake3Hasher>,
    >(proof, pub_inputs, &acceptable_options)
        .map_err(|e| format!("Rollup batch proof verification failed: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use winterfell::math::FieldElement;

    // ========================================================================
    // Phase 1: Balance Transfer Tests
    // ========================================================================

    /// Round-trip: generate a proof for a valid transfer, then verify it
    #[test]
    fn test_valid_transfer_roundtrip() {
        let sender_balance: u64 = 1000;
        let receiver_balance: u64 = 500;
        let amount: u64 = 250;

        let proof = prove_balance_transfer(sender_balance, receiver_balance, amount)
            .expect("proof generation should succeed");

        let public_inputs = BalanceTransferInputs {
            total_value: BaseElement::from(sender_balance + receiver_balance),
            final_sender_balance: BaseElement::from(sender_balance - amount),
            final_receiver_balance: BaseElement::from(receiver_balance + amount),
        };

        verify_balance_transfer(proof, public_inputs)
            .expect("verification should succeed for valid transfer");
    }

    /// Verify that wrong public inputs cause verification to fail
    #[test]
    fn test_wrong_public_inputs_rejected() {
        let sender_balance: u64 = 1000;
        let receiver_balance: u64 = 500;
        let amount: u64 = 250;

        let proof = prove_balance_transfer(sender_balance, receiver_balance, amount)
            .expect("proof generation should succeed");

        let bad_inputs = BalanceTransferInputs {
            total_value: BaseElement::from(sender_balance + receiver_balance),
            final_sender_balance: BaseElement::from(999u64), // wrong!
            final_receiver_balance: BaseElement::from(receiver_balance + amount),
        };

        assert!(
            verify_balance_transfer(proof, bad_inputs).is_err(),
            "verification should fail with wrong public inputs"
        );
    }

    /// Test edge case: transferring zero tokens.
    #[test]
    fn test_zero_transfer_returns_error() {
        let sender_balance: u64 = 100;
        let receiver_balance: u64 = 200;
        let amount: u64 = 0;

        let result = prove_balance_transfer(sender_balance, receiver_balance, amount);
        assert!(
            result.is_err(),
            "zero transfer should return an error (trivial proof)"
        );
    }

    /// Test with large balances
    #[test]
    fn test_large_balances() {
        let sender_balance: u64 = u64::MAX / 2;
        let receiver_balance: u64 = 1_000_000;
        let amount: u64 = 500_000;

        let proof = prove_balance_transfer(sender_balance, receiver_balance, amount)
            .expect("proof generation should succeed with large balances");

        let public_inputs = BalanceTransferInputs {
            total_value: BaseElement::from(sender_balance + receiver_balance),
            final_sender_balance: BaseElement::from(sender_balance - amount),
            final_receiver_balance: BaseElement::from(receiver_balance + amount),
        };

        verify_balance_transfer(proof, public_inputs)
            .expect("verification should succeed with large balances");
    }

    /// Test transferring entire balance
    #[test]
    fn test_full_balance_transfer() {
        let sender_balance: u64 = 1000;
        let receiver_balance: u64 = 0;
        let amount: u64 = 1000;

        let proof = prove_balance_transfer(sender_balance, receiver_balance, amount)
            .expect("proof generation should succeed for full balance transfer");

        let public_inputs = BalanceTransferInputs {
            total_value: BaseElement::from(1000u64),
            final_sender_balance: BaseElement::ZERO,
            final_receiver_balance: BaseElement::from(1000u64),
        };

        verify_balance_transfer(proof, public_inputs)
            .expect("verification should succeed for full balance transfer");
    }

    // ========================================================================
    // Phase 2: Shielded Transfer Tests
    // ========================================================================

    /// Shielded round-trip: prove a private transfer and verify it
    #[test]
    fn test_shielded_transfer_roundtrip() {
        // Input note: 1000, send 700 to recipient, 200 change, 100 fee
        let input_value = 1000u64;
        let output_1 = 700u64;
        let output_2 = 200u64;
        let fee = 100u64;

        let (proof, pub_inputs) = prove_shielded_transfer(input_value, output_1, output_2, fee)
            .expect("shielded proof generation should succeed");

        verify_shielded_transfer(proof, pub_inputs)
            .expect("shielded verification should succeed");
    }

    /// Conservation violation should be caught before proving
    #[test]
    fn test_shielded_conservation_violation() {
        let result = prove_shielded_transfer(1000, 600, 300, 200);
        assert!(
            result.is_err(),
            "non-conserving transfer should be rejected"
        );
    }

    /// Zero-value input should be rejected
    #[test]
    fn test_shielded_zero_value_rejected() {
        let result = prove_shielded_transfer(0, 0, 0, 0);
        assert!(result.is_err(), "zero-value note should be rejected");
    }

    /// Test with two outputs (send + change)
    #[test]
    fn test_shielded_two_outputs() {
        let (proof, pub_inputs) = prove_shielded_transfer(500, 300, 190, 10)
            .expect("proof should succeed");
        verify_shielded_transfer(proof, pub_inputs)
            .expect("verification should succeed with two outputs");
    }

    /// Test full value as fee (no outputs)
    #[test]
    fn test_shielded_full_fee() {
        let (proof, pub_inputs) = prove_shielded_transfer(100, 0, 0, 100)
            .expect("full-fee proof should succeed");
        verify_shielded_transfer(proof, pub_inputs)
            .expect("full-fee verification should succeed");
    }

    /// Test commitment and nullifier integration with shielded proofs
    #[test]
    fn test_commitment_nullifier_flow() {
        let value = 1000u64;
        let owner = b"test_owner_pubkey_hex_1234567890";
        let randomness = generate_randomness();

        // Create commitment
        let commitment = compute_commitment(value, owner, &randomness);
        assert!(verify_commitment(&commitment, value, owner, &randomness));

        // Derive nullifier
        let nullifier = compute_nullifier(&randomness, &commitment);
        assert_ne!(nullifier, [0u8; 32], "nullifier shouldn't be all zeros");

        // Prove the shielded transfer: 1000 → 800 + 150 + 50 fee
        let (proof, pub_inputs) = prove_shielded_transfer(1000, 800, 150, 50)
            .expect("proof should succeed");
        verify_shielded_transfer(proof, pub_inputs)
            .expect("verification should succeed");
    }

    // ========================================================================
    // Phase 3: Rollup Batch Tests
    // ========================================================================

    /// Rollup round-trip: prove a batch of transfers and verify
    #[test]
    fn test_rollup_batch_roundtrip() {
        let transfers = vec![
            RollupTransfer {
                sender_before: 1000,
                receiver_before: 500,
                amount: 200,
                fee: 10,
            },
            RollupTransfer {
                sender_before: 800,
                receiver_before: 300,
                amount: 100,
                fee: 5,
            },
            RollupTransfer {
                sender_before: 2000,
                receiver_before: 0,
                amount: 500,
                fee: 20,
            },
        ];

        let pre_root = [1u8; 32];
        let post_root = [2u8; 32];

        let (proof, pub_inputs) = prove_rollup_batch(&transfers, &pre_root, &post_root)
            .expect("rollup proof generation should succeed");

        verify_rollup_batch(proof, pub_inputs)
            .expect("rollup verification should succeed");
    }

    /// Empty batch should be rejected
    #[test]
    fn test_rollup_empty_batch_rejected() {
        let pre_root = [1u8; 32];
        let post_root = [2u8; 32];
        let result = prove_rollup_batch(&[], &pre_root, &post_root);
        assert!(result.is_err(), "empty batch should be rejected");
    }

    /// Overdraft should be rejected before proving
    #[test]
    fn test_rollup_overdraft_rejected() {
        let transfers = vec![
            RollupTransfer {
                sender_before: 100,
                receiver_before: 0,
                amount: 200,  // More than sender has
                fee: 0,
            },
        ];
        let result = prove_rollup_batch(&transfers, &[1u8; 32], &[2u8; 32]);
        assert!(result.is_err(), "overdraft should be rejected");
    }

    /// Single transfer batch should work
    #[test]
    fn test_rollup_single_transfer() {
        let transfers = vec![
            RollupTransfer {
                sender_before: 500,
                receiver_before: 100,
                amount: 50,
                fee: 1,
            },
        ];

        let (proof, pub_inputs) = prove_rollup_batch(&transfers, &[10u8; 32], &[20u8; 32])
            .expect("single transfer rollup should succeed");

        verify_rollup_batch(proof, pub_inputs)
            .expect("single transfer rollup verification should succeed");
    }

    /// Large batch (16 transfers) should work
    #[test]
    fn test_rollup_large_batch() {
        let transfers: Vec<RollupTransfer> = (0..16).map(|i| {
            RollupTransfer {
                sender_before: 10000 + i * 100,
                receiver_before: 500 + i * 50,
                amount: 50 + i * 10,
                fee: 1,
            }
        }).collect();

        let (proof, pub_inputs) = prove_rollup_batch(&transfers, &[42u8; 32], &[99u8; 32])
            .expect("large batch rollup should succeed");

        verify_rollup_batch(proof, pub_inputs)
            .expect("large batch rollup verification should succeed");
    }

    // ========================================================================
    // Phase 2b: verify_shielded_transfer_bytes (Security Fix Tests)
    // ========================================================================

    /// Round-trip: prove a shielded transfer, convert to bytes, verify via bytes API
    #[test]
    fn test_verify_shielded_bytes_roundtrip() {
        let (proof, _pub_inputs) = prove_shielded_transfer(1000, 700, 250, 50)
            .expect("proof should succeed");
        let proof_bytes = proof.to_bytes();

        verify_shielded_transfer_bytes(&proof_bytes, 700, 250, 50)
            .expect("byte-level verification should succeed");
    }

    /// Wrong output values should fail verification
    #[test]
    fn test_verify_shielded_bytes_wrong_values() {
        let (proof, _) = prove_shielded_transfer(1000, 700, 250, 50)
            .expect("proof should succeed");
        let proof_bytes = proof.to_bytes();

        // Try to verify with different amounts — should fail
        let result = verify_shielded_transfer_bytes(&proof_bytes, 800, 150, 50);
        assert!(result.is_err(), "wrong output values should fail verification");
    }

    /// Invalid proof bytes should be rejected
    #[test]
    fn test_verify_shielded_bytes_garbage() {
        let garbage = vec![0u8; 100];
        let result = verify_shielded_transfer_bytes(&garbage, 700, 250, 50);
        assert!(result.is_err(), "garbage proof bytes should be rejected");
    }

    /// Empty proof bytes should be rejected
    #[test]
    fn test_verify_shielded_bytes_empty() {
        let result = verify_shielded_transfer_bytes(&[], 700, 250, 50);
        assert!(result.is_err(), "empty proof bytes should be rejected");
    }

    /// Full-fee unshield scenario (output_1 = amount, output_2 = 0)
    #[test]
    fn test_verify_shielded_bytes_unshield_pattern() {
        let amount = 500u64;
        let fee = 10u64;
        let (proof, _) = prove_shielded_transfer(amount + fee, amount, 0, fee)
            .expect("unshield proof should succeed");
        let proof_bytes = proof.to_bytes();

        verify_shielded_transfer_bytes(&proof_bytes, amount, 0, fee)
            .expect("unshield byte-level verification should succeed");
    }
}

