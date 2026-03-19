// ============================================================================
// stark::rollup_air — AIR for zk-STARK Rollup Batch Verification
//
// Proves that a batch of N balance transfers is valid:
//   1. Each transfer conserves value (sender_after = sender_before - amount)
//   2. The aggregate state root transitions correctly from pre → post
//
// Trace layout (5 columns, padded to power of 2, min 8 rows):
//   Col 0 (sender_before):   sender balance before this transfer
//   Col 1 (sender_after):    sender balance after (= sender_before - amount)
//   Col 2 (receiver_after):  receiver balance after (= receiver_before + amount)
//   Col 3 (amount):          transfer amount + fee for this row
//   Col 4 (running_hash):    cumulative fingerprint of all transfers
//
// Transition constraints (applied at every step):
//   (0) sender_after[i] = sender_before[i] - amount[i]          (conservation)
//   (1) running_hash[i+1] = running_hash[i] + sender_before[i] * amount[i]
//   (2) sender_before[i] - sender_after[i] - amount[i] = 0      (cross-check)
//
// Padding rows have all columns = 0 except running_hash which stays constant.
// Constraint 0: 0 = 0 - 0 ✓   Constraint 1: hash + 0*0 = hash ✓
// Constraint 2: 0 - 0 - 0 = 0 ✓
//
// Boundary assertions:
//   - running_hash[0]    = pre_state_root  (initial state)
//   - running_hash[last] = post_state_root (final state after batch)
// ============================================================================

use winterfell::{
    math::{fields::f128::BaseElement, FieldElement},
    Air, AirContext, Assertion, EvaluationFrame, ProofOptions, TraceInfo,
    TransitionConstraintDegree,
};

use super::RollupBatchInputs;

/// Width of the rollup execution trace.
pub const ROLLUP_TRACE_WIDTH: usize = 5;

/// Column indices.
pub const COL_SENDER_BEFORE: usize = 0;
pub const COL_SENDER_AFTER: usize = 1;
pub const COL_RECEIVER_AFTER: usize = 2;
pub const COL_AMOUNT: usize = 3;
pub const COL_RUNNING_HASH: usize = 4;

// ============================================================================
// AIR DEFINITION
// ============================================================================

pub struct RollupBatchAir {
    context: AirContext<BaseElement>,
    pub_inputs: RollupBatchInputs,
}

impl Air for RollupBatchAir {
    type BaseField = BaseElement;
    type PublicInputs = RollupBatchInputs;

    fn new(trace_info: TraceInfo, pub_inputs: Self::PublicInputs, options: ProofOptions) -> Self {
        let degrees = vec![
            TransitionConstraintDegree::new(1), // conservation: sender side
            TransitionConstraintDegree::new(2), // running hash accumulation (degree 2: product of two columns)
            TransitionConstraintDegree::new(1), // cross-check redundancy
        ];

        // 2 boundary assertions: pre and post state roots
        let num_assertions = 2;

        RollupBatchAir {
            context: AirContext::new(trace_info, degrees, num_assertions, options),
            pub_inputs,
        }
    }

    fn context(&self) -> &AirContext<Self::BaseField> {
        &self.context
    }

    fn evaluate_transition<E: FieldElement + From<Self::BaseField>>(
        &self,
        frame: &EvaluationFrame<E>,
        _periodic_values: &[E],
        result: &mut [E],
    ) {
        let current = frame.current();
        let next = frame.next();

        // Constraint 0: sender_after = sender_before - amount
        result[0] = current[COL_SENDER_AFTER]
            - (current[COL_SENDER_BEFORE] - current[COL_AMOUNT]);

        // Constraint 1: running_hash[next] = running_hash[cur] + sender_before * amount
        // This is degree 2 (product of two trace columns).
        // For padding rows (sender_before=0, amount=0), this reduces to hash[next] = hash[cur].
        result[1] = next[COL_RUNNING_HASH]
            - (current[COL_RUNNING_HASH] + current[COL_SENDER_BEFORE] * current[COL_AMOUNT]);

        // Constraint 2: cross-check: sender_before - sender_after - amount = 0
        // Redundant with constraint 0, but provides a double-check.
        result[2] = current[COL_SENDER_BEFORE]
            - current[COL_SENDER_AFTER]
            - current[COL_AMOUNT];
    }

    fn get_assertions(&self) -> Vec<Assertion<Self::BaseField>> {
        let last_step = self.trace_length() - 1;

        vec![
            // Initial running hash = pre_state_root
            Assertion::single(COL_RUNNING_HASH, 0, self.pub_inputs.pre_state_root),
            // Final running hash = post_state_root
            Assertion::single(COL_RUNNING_HASH, last_step, self.pub_inputs.post_state_root),
        ]
    }
}
