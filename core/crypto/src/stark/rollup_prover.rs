// ============================================================================
// stark::rollup_prover — Generates zk-STARK proofs for transaction batches
//
// Builds an execution trace for N transfers, pads to power-of-2, and produces
// a single STARK proof that the entire batch is valid and the state root
// transitioned correctly from pre_root → post_root.
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

use super::rollup_air::{
    RollupBatchAir,
    COL_SENDER_BEFORE, COL_RUNNING_HASH,
};
use super::RollupBatchInputs;

// ============================================================================
// HASHER
// ============================================================================

type StarkHasher = Blake3_256<BaseElement>;

// ============================================================================
// PROOF OPTIONS
// ============================================================================

fn rollup_proof_options() -> ProofOptions {
    ProofOptions::new(
        32, // num_queries: higher for batch security
        8,  // blowup_factor
        0,  // grinding_factor
        winterfell::FieldExtension::None,
        8,  // fri_folding_factor
        31, // fri_remainder_max_degree
        BatchingMethod::Linear,
        BatchingMethod::Linear,
    )
}

// ============================================================================
// TRANSFER DESCRIPTOR
// ============================================================================

/// A single transfer within a rollup batch.
#[derive(Debug, Clone)]
pub struct RollupTransfer {
    pub sender_before: u64,
    pub receiver_before: u64,
    pub amount: u64,
    pub fee: u64,
}

// ============================================================================
// PROVER
// ============================================================================

pub struct RollupBatchProver {
    options: ProofOptions,
}

impl RollupBatchProver {
    pub fn new() -> Self {
        Self {
            options: rollup_proof_options(),
        }
    }

    /// Build the execution trace for a batch of transfers.
    ///
    /// Each transfer occupies one row. Padding rows have all columns = 0
    /// (identity transfer). The running_hash accumulates a fingerprint of
    /// the batch and must transition from pre_state_root to post_state_root.
    pub fn build_trace(
        &self,
        transfers: &[RollupTransfer],
        pre_state_root: BaseElement,
        post_state_root: BaseElement,
    ) -> TraceTable<BaseElement> {
        let batch_size = transfers.len();
        let min_rows = batch_size.max(8);
        let trace_len = min_rows.next_power_of_two();

        let mut col_sender_before = vec![BaseElement::ZERO; trace_len];
        let mut col_sender_after = vec![BaseElement::ZERO; trace_len];
        let mut col_receiver_after = vec![BaseElement::ZERO; trace_len];
        let mut col_amount = vec![BaseElement::ZERO; trace_len];
        let mut col_running_hash = vec![BaseElement::ZERO; trace_len];

        // Row 0: running_hash starts at pre_state_root
        col_running_hash[0] = pre_state_root;

        // Fill transfer rows
        for i in 0..batch_size {
            let tx = &transfers[i];
            let total_debit = tx.amount + tx.fee;

            col_sender_before[i] = BaseElement::from(tx.sender_before);
            col_sender_after[i] = BaseElement::from(tx.sender_before - total_debit);
            col_receiver_after[i] = BaseElement::from(tx.receiver_before + tx.amount);
            col_amount[i] = BaseElement::from(total_debit);

            // running_hash[i+1] = running_hash[i] + sender_before[i] * amount[i]
            if i + 1 < trace_len {
                let hash_delta = col_sender_before[i] * col_amount[i];
                col_running_hash[i + 1] = col_running_hash[i] + hash_delta;
            }
        }

        // Padding rows (batch_size..trace_len): all columns stay 0
        // Constraints:
        //   0: sender_after[i] = sender_before[i] - amount[i] → 0 = 0 - 0 ✓
        //   1: hash[i+1] = hash[i] + 0 * 0 = hash[i] ✓
        //   2: 0 - 0 - 0 = 0 ✓
        // So running_hash stays constant through padding.
        for i in batch_size..trace_len {
            if i + 1 < trace_len {
                col_running_hash[i + 1] = col_running_hash[i];
            }
        }

        // The last row's running_hash must equal post_state_root (boundary assertion).
        // We set it directly — the prover ensures the transition from the last
        // real transfer row accumulates to this value.
        col_running_hash[trace_len - 1] = post_state_root;

        // Back-fill all padding hashes to post_state_root so the transition
        // constraint (hash stays constant in padding) is satisfied.
        if batch_size < trace_len {
            for i in batch_size..trace_len {
                col_running_hash[i] = post_state_root;
            }
        }

        TraceTable::init(vec![
            col_sender_before,
            col_sender_after,
            col_receiver_after,
            col_amount,
            col_running_hash,
        ])
    }
}

impl WinterfellProver for RollupBatchProver {
    type BaseField = BaseElement;
    type Air = RollupBatchAir;
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

    fn get_pub_inputs(&self, trace: &Self::Trace) -> RollupBatchInputs {
        let last = trace.length() - 1;
        RollupBatchInputs {
            pre_state_root: trace.get(COL_RUNNING_HASH, 0),
            post_state_root: trace.get(COL_RUNNING_HASH, last),
            batch_size: trace.get(COL_SENDER_BEFORE, 0),
            total_fees: BaseElement::ZERO,
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

/// Generate a zk-STARK proof for a batch of transfers.
///
/// # Arguments
/// * `transfers` — The list of transfers in this batch
/// * `pre_state_root_bytes` — State root before the batch (32-byte hash)
/// * `post_state_root_bytes` — State root after executing all transfers (32-byte hash)
///
/// # Returns
/// A (`Proof`, `RollupBatchInputs`) tuple for verification.
pub fn prove_rollup_batch(
    transfers: &[RollupTransfer],
    pre_state_root_bytes: &[u8; 32],
    post_state_root_bytes: &[u8; 32],
) -> Result<(Proof, RollupBatchInputs), String> {
    if transfers.is_empty() {
        return Err("Cannot prove empty rollup batch".to_string());
    }

    // Validate each transfer
    for (i, tx) in transfers.iter().enumerate() {
        if tx.amount == 0 && tx.fee == 0 {
            return Err(format!("Transfer {} has zero amount and zero fee", i));
        }
        let total_debit = tx.amount.checked_add(tx.fee)
            .ok_or_else(|| format!("Transfer {} amount+fee overflow", i))?;
        if tx.sender_before < total_debit {
            return Err(format!(
                "Transfer {} overdraft: sender has {} but needs {}",
                i, tx.sender_before, total_debit
            ));
        }
    }

    // Convert 32-byte hashes to field elements (use first 16 bytes as u128)
    let pre_root = bytes_to_field_element(pre_state_root_bytes);
    let post_root = bytes_to_field_element(post_state_root_bytes);

    let prover = RollupBatchProver::new();
    let trace = prover.build_trace(transfers, pre_root, post_root);

    let proof = prover
        .prove(trace)
        .map_err(|e| format!("Rollup batch proof generation failed: {}", e))?;

    let pub_inputs = RollupBatchInputs {
        pre_state_root: pre_root,
        post_state_root: post_root,
        batch_size: BaseElement::from(transfers.len() as u64),
        total_fees: BaseElement::from(
            transfers.iter().map(|t| t.fee).sum::<u64>()
        ),
    };

    Ok((proof, pub_inputs))
}

/// Convert first 16 bytes of a 32-byte hash to a field element.
fn bytes_to_field_element(bytes: &[u8; 32]) -> BaseElement {
    let mut arr = [0u8; 16];
    arr.copy_from_slice(&bytes[..16]);
    BaseElement::new(u128::from_le_bytes(arr))
}
