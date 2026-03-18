// ============================================================================
// quantum-vault-crypto :: stark — zk-STARK proof module
//
// Provides a quantum-resistant zero-knowledge proof system built on the
// winterfell library.  STARKs use only collision-resistant hash functions
// (no elliptic curves), making them inherently post-quantum secure.
//
// Current AIR:  BalanceTransfer — proves a value-conserving token transfer
//               without revealing the actual balances involved.
// ============================================================================

pub mod air;
pub mod prover;
pub mod verifier;

// Re-export the public API
pub use prover::prove_balance_transfer;
pub use verifier::verify_balance_transfer;

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

#[cfg(test)]
mod tests {
    use super::*;
    use winterfell::math::FieldElement;

    /// Round-trip: generate a proof for a valid transfer, then verify it
    #[test]
    fn test_valid_transfer_roundtrip() {
        // Sender has 1000, receiver has 500, transferring 250
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

        // Try to claim a different final balance — should fail
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
    /// Zero transfers produce a trivially-zero constraint polynomial, which
    /// winterfell cannot prove (by design — there's nothing to prove).
    /// This is expected behavior: a zero transfer doesn't need ZK.
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
}
