// ============================================================================
// stark::prover — Generates zk-STARK proofs for balance transfers
//
// Builds a 3-column, 8-row execution trace where:
//   - Amount is applied at every step (7 transitions in 8 rows)
//   - sender_init = final_sender + 7 * amount
//   - receiver_init = final_receiver - 7 * amount
//
// The prover computes the initial values from the desired transfer, builds
// the trace by repeatedly applying the transition, and generates the proof.
// ============================================================================

use winterfell::{
    crypto::{DefaultRandomCoin, MerkleTree},
    math::{fields::f128::BaseElement, FieldElement},
    matrix::ColMatrix,
    AuxRandElements, BatchingMethod, CompositionPoly, CompositionPolyTrace,
    ConstraintCompositionCoefficients, DefaultConstraintCommitment,
    DefaultConstraintEvaluator, DefaultTraceLde, PartitionOptions, Proof,
    ProofOptions, Prover as WinterfellProver, StarkDomain, Trace, TraceInfo,
    TracePolyTable, TraceTable,
};

use winterfell::crypto::hashers::Blake3_256;

use super::air::{BalanceTransferAir, COL_SENDER, COL_RECEIVER};
use super::BalanceTransferInputs;

// ============================================================================
// HASHER TYPE
// ============================================================================

/// Blake3-256 for STARK commitments — hash-based, quantum-resistant, fast.
type StarkHasher = Blake3_256<BaseElement>;

// ============================================================================
// PROOF OPTIONS
// ============================================================================

fn default_proof_options() -> ProofOptions {
    ProofOptions::new(
        28, // num_queries: FRI query count (security parameter)
        8,  // blowup_factor: LDE domain extension
        0,  // grinding_factor: PoW bits (0 = disabled)
        winterfell::FieldExtension::None,
        8,  // fri_folding_factor
        31, // fri_remainder_max_degree
        BatchingMethod::Linear, // constraint batching method
        BatchingMethod::Linear, // DEEP poly batching method
    )
}

// ============================================================================
// PROVER
// ============================================================================

/// Number of rows in the trace (must be power of 2, >= 8 for winterfell).
const TRACE_LEN: usize = 8;

pub struct BalanceTransferProver {
    options: ProofOptions,
}

impl BalanceTransferProver {
    pub fn new() -> Self {
        Self {
            options: default_proof_options(),
        }
    }

    /// Builds an 8-row execution trace for a balance transfer.
    ///
    /// The `amount` is applied at every transition (7 total), so:
    ///   - sender_init   = final_sender   + 7 * per_step_amount
    ///   - receiver_init = final_receiver - 7 * per_step_amount
    ///
    /// For a single transfer of `amount`, we set `per_step_amount = amount`
    /// and compute initial values accordingly.
    pub fn build_trace(
        &self,
        sender_balance: u64,
        receiver_balance: u64,
        amount: u64,
    ) -> TraceTable<BaseElement> {
        let amt = BaseElement::from(amount);


        // Compute the per-step amount for exactly `amount` total transfer
        // over 7 steps. We set per_step = amount, so total = 7 * amount.
        // Initial sender = sender_balance (the actual initial balance)
        // After 7 steps: sender = sender_balance - 7 * per_step
        // We want: final_sender = sender_balance - amount
        // So: sender_balance - 7 * per_step = sender_balance - amount
        // => per_step = amount / 7
        // But we're in a finite field, so division by 7 is fine!
        let seven = BaseElement::from(7u64);
        let per_step = amt * seven.inv(); // amount / 7 in the field

        let sender_init = BaseElement::from(sender_balance);
        let receiver_init = BaseElement::from(receiver_balance);

        let mut col_sender = vec![BaseElement::ZERO; TRACE_LEN];
        let mut col_receiver = vec![BaseElement::ZERO; TRACE_LEN];
        let mut col_amount = vec![BaseElement::ZERO; TRACE_LEN];

        // Fill the trace: apply transition at each step
        col_sender[0] = sender_init;
        col_receiver[0] = receiver_init;
        col_amount[0] = per_step;

        for i in 1..TRACE_LEN {
            col_sender[i] = col_sender[i - 1] - per_step;
            col_receiver[i] = col_receiver[i - 1] + per_step;
            col_amount[i] = per_step;
        }

        // Verify: final values should match expected
        // sender[7] = sender_init - 7 * per_step = sender_init - amount
        // receiver[7] = receiver_init + 7 * per_step = receiver_init + amount
        debug_assert_eq!(
            col_sender[TRACE_LEN - 1],
            sender_init - amt,
            "final sender mismatch"
        );
        debug_assert_eq!(
            col_receiver[TRACE_LEN - 1],
            receiver_init + amt,
            "final receiver mismatch"
        );

        TraceTable::init(vec![col_sender, col_receiver, col_amount])
    }
}

impl WinterfellProver for BalanceTransferProver {
    type BaseField = BaseElement;
    type Air = BalanceTransferAir;
    type Trace = TraceTable<BaseElement>;
    type HashFn = StarkHasher;
    type VC = MerkleTree<StarkHasher>;
    type RandomCoin = DefaultRandomCoin<Self::HashFn>;
    type TraceLde<E: FieldElement<BaseField = Self::BaseField>> =
        DefaultTraceLde<E, Self::HashFn, Self::VC>;
    type ConstraintCommitment<E: FieldElement<BaseField = Self::BaseField>> =
        DefaultConstraintCommitment<E, StarkHasher, Self::VC>;
    type ConstraintEvaluator<'a, E: FieldElement<BaseField = Self::BaseField>> =
        DefaultConstraintEvaluator<'a, Self::Air, E>;

    fn get_pub_inputs(&self, trace: &Self::Trace) -> BalanceTransferInputs {
        let last = trace.length() - 1;
        let final_sender = trace.get(COL_SENDER, last);
        let final_receiver = trace.get(COL_RECEIVER, last);

        BalanceTransferInputs {
            total_value: final_sender + final_receiver,
            final_sender_balance: final_sender,
            final_receiver_balance: final_receiver,
        }
    }

    fn options(&self) -> &ProofOptions {
        &self.options
    }

    fn new_trace_lde<E: FieldElement<BaseField = Self::BaseField>>(
        &self,
        trace_info: &TraceInfo,
        main_trace: &ColMatrix<Self::BaseField>,
        domain: &StarkDomain<Self::BaseField>,
        partition_option: PartitionOptions,
    ) -> (Self::TraceLde<E>, TracePolyTable<E>) {
        DefaultTraceLde::new(trace_info, main_trace, domain, partition_option)
    }

    fn new_evaluator<'a, E: FieldElement<BaseField = Self::BaseField>>(
        &self,
        air: &'a Self::Air,
        aux_rand_elements: Option<AuxRandElements<E>>,
        composition_coefficients: ConstraintCompositionCoefficients<E>,
    ) -> Self::ConstraintEvaluator<'a, E> {
        DefaultConstraintEvaluator::new(air, aux_rand_elements, composition_coefficients)
    }

    fn build_constraint_commitment<E: FieldElement<BaseField = Self::BaseField>>(
        &self,
        composition_poly_trace: CompositionPolyTrace<E>,
        num_constraint_composition_columns: usize,
        domain: &StarkDomain<Self::BaseField>,
        partition_options: PartitionOptions,
    ) -> (Self::ConstraintCommitment<E>, CompositionPoly<E>) {
        DefaultConstraintCommitment::new(
            composition_poly_trace,
            num_constraint_composition_columns,
            domain,
            partition_options,
        )
    }
}

// ============================================================================
// PUBLIC API
// ============================================================================

/// Generate a zk-STARK proof for a balance transfer.
///
/// # Arguments
/// * `sender_balance` — The sender's initial balance (private witness)
/// * `receiver_balance` — The receiver's initial balance (private witness)
/// * `amount` — The transfer amount (private witness)
///
/// # Returns
/// A STARK `Proof` that can be verified with only the public inputs
/// (final balances), without knowing the initial balances or amount.
pub fn prove_balance_transfer(
    sender_balance: u64,
    receiver_balance: u64,
    amount: u64,
) -> Result<Proof, String> {
    if amount == 0 {
        return Err("Cannot generate STARK proof for zero-amount transfer".to_string());
    }

    let prover = BalanceTransferProver::new();
    let trace = prover.build_trace(sender_balance, receiver_balance, amount);
    prover
        .prove(trace)
        .map_err(|e| format!("STARK proof generation failed: {}", e))
}
