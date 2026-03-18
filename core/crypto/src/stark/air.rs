// ============================================================================
// stark::air — Algebraic Intermediate Representation for balance transfers
//
// Models a value-conserving token transfer using a 3-column execution trace.
// The transfer amount is applied at every step, so over `n` steps the sender
// decreases by `n * amount` and the receiver increases by `n * amount`.
// The prover sets initial values so the final row matches the desired outcome.
//
// Trace layout (3 columns, 8 rows):
//   Col 0 (sender):   decreases by `amount` each step
//   Col 1 (receiver): increases by `amount` each step
//   Col 2 (amount):   constant across all rows
//
// Transition constraints (all degree 1):
//   (0) sender[next]   = sender[cur]   - amount[cur]
//   (1) receiver[next] = receiver[cur] + amount[cur]
//   (2) amount[next]   = amount[cur]
//
// Boundary assertions:
//   - sender[last]   = final_sender_balance   (public)
//   - receiver[last] = final_receiver_balance (public)
//
// Conservation is guaranteed: at every step,
//   sender[i] + receiver[i] = sender[0] + receiver[0] (constant)
// because the amount that leaves sender goes to receiver.
// ============================================================================

use winterfell::{
    math::{fields::f128::BaseElement, FieldElement},
    Air, AirContext, Assertion, EvaluationFrame, ProofOptions, TraceInfo,
    TransitionConstraintDegree,
};

use super::BalanceTransferInputs;

/// Width of the execution trace (number of columns).
pub const TRACE_WIDTH: usize = 3;

/// Column indices.
pub const COL_SENDER: usize = 0;
pub const COL_RECEIVER: usize = 1;
pub const COL_AMOUNT: usize = 2;

// ============================================================================
// AIR
// ============================================================================

pub struct BalanceTransferAir {
    context: AirContext<BaseElement>,
    pub_inputs: BalanceTransferInputs,
}

impl Air for BalanceTransferAir {
    type BaseField = BaseElement;
    type PublicInputs = BalanceTransferInputs;

    fn new(trace_info: TraceInfo, pub_inputs: Self::PublicInputs, options: ProofOptions) -> Self {
        // 3 transition constraints, all degree 1 (linear)
        let degrees = vec![
            TransitionConstraintDegree::new(1), // sender transition
            TransitionConstraintDegree::new(1), // receiver transition
            TransitionConstraintDegree::new(1), // amount constancy
        ];

        // 2 boundary assertions: final sender and final receiver
        let num_assertions = 2;

        BalanceTransferAir {
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

        debug_assert_eq!(TRACE_WIDTH, current.len());
        debug_assert_eq!(TRACE_WIDTH, next.len());

        // Constraint 0: sender[next] = sender[cur] - amount[cur]
        result[0] = next[COL_SENDER] - (current[COL_SENDER] - current[COL_AMOUNT]);

        // Constraint 1: receiver[next] = receiver[cur] + amount[cur]
        result[1] = next[COL_RECEIVER] - (current[COL_RECEIVER] + current[COL_AMOUNT]);

        // Constraint 2: amount stays constant
        result[2] = next[COL_AMOUNT] - current[COL_AMOUNT];
    }

    fn get_assertions(&self) -> Vec<Assertion<Self::BaseField>> {
        let last_step = self.trace_length() - 1;

        vec![
            // Final sender balance matches public claim
            Assertion::single(COL_SENDER, last_step, self.pub_inputs.final_sender_balance),
            // Final receiver balance matches public claim
            Assertion::single(
                COL_RECEIVER,
                last_step,
                self.pub_inputs.final_receiver_balance,
            ),
        ]
    }
}
