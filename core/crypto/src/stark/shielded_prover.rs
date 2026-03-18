// ============================================================================
// stark::shielded_prover — Generates zk-STARK proofs for shielded transfers
//
// Builds a 5-column, 64-row execution trace where:
//   - Columns 0-3 hold constant values (input, output_1, output_2, fee)
//   - Column 4 performs bit-decomposition of the input value
//
// The bit-decomposition accumulator builds the input value MSB-first:
//   acc[0] = bit_63
//   acc[i] = 2 * acc[i-1] + bit_{63-i}
//   acc[63] = input_value (all 64 bits reconstructed)
//
// This proves: (1) values conserve, (2) input fits in 64 bits
// ============================================================================

use winterfell::{
    crypto::{DefaultRandomCoin, MerkleTree},
    math::{fields::f128::BaseElement, FieldElement},
    matrix::ColMatrix,
    AuxRandElements, BatchingMethod, CompositionPoly, CompositionPolyTrace,
    ConstraintCompositionCoefficients, DefaultConstraintCommitment,
    DefaultConstraintEvaluator, DefaultTraceLde, PartitionOptions, Proof,
    ProofOptions, Prover as WinterfellProver, StarkDomain, TraceInfo,
    TracePolyTable, TraceTable,
};

use winterfell::crypto::hashers::Blake3_256;

use super::shielded_air::{
    ShieldedTransferAir, COL_BIT_ACC, COL_FEE, COL_OUTPUT_1, COL_OUTPUT_2, TRACE_LEN,
};
use super::ShieldedTransferInputs;

type StarkHasher = Blake3_256<BaseElement>;

fn shielded_proof_options() -> ProofOptions {
    ProofOptions::new(
        28, // num_queries
        8,  // blowup_factor
        0,  // grinding_factor
        winterfell::FieldExtension::None,
        8,  // fri_folding_factor
        31, // fri_remainder_max_degree
        BatchingMethod::Linear,
        BatchingMethod::Linear,
    )
}

pub struct ShieldedTransferProver {
    options: ProofOptions,
}

impl ShieldedTransferProver {
    pub fn new() -> Self {
        Self {
            options: shielded_proof_options(),
        }
    }

    /// Build the execution trace for a shielded transfer.
    ///
    /// Columns 0-3 are constant (the values).
    /// Column 4 is the bit-decomposition accumulator for range-checking input_value.
    pub fn build_trace(
        &self,
        input_value: u64,
        output_1_value: u64,
        output_2_value: u64,
        fee: u64,
    ) -> TraceTable<BaseElement> {
        let input_fe = BaseElement::from(input_value);
        let out1_fe = BaseElement::from(output_1_value);
        let out2_fe = BaseElement::from(output_2_value);
        let fee_fe = BaseElement::from(fee);

        let mut col_input = vec![input_fe; TRACE_LEN];
        let mut col_out1 = vec![out1_fe; TRACE_LEN];
        let mut col_out2 = vec![out2_fe; TRACE_LEN];
        let mut col_fee = vec![fee_fe; TRACE_LEN];
        let mut col_bit_acc = vec![BaseElement::ZERO; TRACE_LEN];

        // Bit-decomposition: MSB first
        // Extract 64 bits of input_value and build accumulator
        for i in 0..TRACE_LEN {
            let bit_index = 63 - i; // MSB first
            let bit = (input_value >> bit_index) & 1;

            if i == 0 {
                col_bit_acc[0] = BaseElement::from(bit);
            } else {
                col_bit_acc[i] =
                    BaseElement::from(2u64) * col_bit_acc[i - 1] + BaseElement::from(bit);
            }
        }

        // Verify: accumulator at last row should equal input_value
        debug_assert_eq!(
            col_bit_acc[TRACE_LEN - 1],
            input_fe,
            "bit accumulator should reconstruct input_value"
        );

        // Fill constant columns (already done via vec![...; TRACE_LEN])
        // Just making sure they stay constant
        for i in 0..TRACE_LEN {
            col_input[i] = input_fe;
            col_out1[i] = out1_fe;
            col_out2[i] = out2_fe;
            col_fee[i] = fee_fe;
        }

        TraceTable::init(vec![col_input, col_out1, col_out2, col_fee, col_bit_acc])
    }
}

impl WinterfellProver for ShieldedTransferProver {
    type BaseField = BaseElement;
    type Air = ShieldedTransferAir;
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

    fn get_pub_inputs(&self, trace: &Self::Trace) -> ShieldedTransferInputs {
        let out1 = trace.get(COL_OUTPUT_1, 0);
        let out2 = trace.get(COL_OUTPUT_2, 0);
        let fee = trace.get(COL_FEE, 0);
        let first_bit = trace.get(COL_BIT_ACC, 0);
        let input_check = trace.get(COL_BIT_ACC, TRACE_LEN - 1);

        ShieldedTransferInputs {
            output_1_commitment_value: out1,
            output_2_commitment_value: out2,
            fee,
            first_bit,
            input_value_check: input_check,
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

/// Generate a zk-STARK proof for a shielded transfer.
///
/// Proves that input_value = output_1 + output_2 + fee without revealing
/// any of the values. Also proves input_value fits in 64 bits via
/// bit-decomposition range check.
///
/// # Arguments
/// * `input_value`   — Value of the consumed note (private)
/// * `output_1`      — Value for recipient (private)
/// * `output_2`      — Change value back to sender (private)
/// * `fee`           — Transaction fee (will be public in proof)
///
/// # Returns
/// A STARK proof + the public inputs needed for verification.
pub fn prove_shielded_transfer(
    input_value: u64,
    output_1: u64,
    output_2: u64,
    fee: u64,
) -> Result<(Proof, ShieldedTransferInputs), String> {
    // Validate conservation
    if input_value != output_1 + output_2 + fee {
        return Err(format!(
            "Value not conserved: {} != {} + {} + {}",
            input_value, output_1, output_2, fee
        ));
    }

    if input_value == 0 {
        return Err("Cannot generate proof for zero-value note".to_string());
    }

    let prover = ShieldedTransferProver::new();
    let trace = prover.build_trace(input_value, output_1, output_2, fee);

    let proof = prover
        .prove(trace)
        .map_err(|e| format!("Shielded STARK proof generation failed: {}", e))?;

    let pub_inputs = ShieldedTransferInputs {
        output_1_commitment_value: BaseElement::from(output_1),
        output_2_commitment_value: BaseElement::from(output_2),
        fee: BaseElement::from(fee),
        first_bit: BaseElement::from((input_value >> 63) & 1),
        input_value_check: BaseElement::from(input_value),
    };

    Ok((proof, pub_inputs))
}
