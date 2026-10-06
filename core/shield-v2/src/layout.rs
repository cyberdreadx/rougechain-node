//! Trace layout shared by the trace builder and the AIR.
//!
//! The trace is 4,096 rows = 128 cycles of 32 rows. Each cycle is one Poseidon2 permutation
//! (KoalaBear, width 24, x^3, 8 full + 23 partial rounds, the library's constants), laid out as in
//! SHIELD-1:
//!
//! * row 0 of a cycle holds the raw sponge state (before the permutation);
//! * the transition row 0 -> 1 applies the initial external linear layer and full round 0;
//! * rows 1..=3 -> full rounds 1..=3; rows 4..=26 -> the 23 partial rounds;
//!   rows 27..=30 -> the 4 final full rounds;
//! * row 31 holds the permutation output; the transition 31 -> 0 is a "link" that initialises
//!   the next sponge state. What a link constrains depends on the type of the NEXT cycle, which
//!   is read from one-hot selector columns of the trace.
//!
//! Schedule (80 permutations carry the statement, 48 cycles are padding):
//!
//! | cycles  | content                                                             |
//! |---------|---------------------------------------------------------------------|
//! | 0..=36  | input 1: nk, nf, pk, cm (2 absorptions), 32 Merkle levels           |
//! | 37..=73 | input 2: the same                                                   |
//! | 74      | rho of output 1 = H_rho(nf1, nf2, 0), from the PUBLIC nullifiers    |
//! | 75, 76  | output 1 commitment (2 absorptions), rho taken from cycle 74        |
//! | 77      | rho of output 2 = H_rho(nf1, nf2, 1)                                |
//! | 78, 79  | output 2 commitment (2 absorptions), rho taken from cycle 77        |
//! | 80..    | padding (keeps hashing; unconstrained input)                        |
//!
//! SHIELD-3 change (review finding F-2): the output notes' `rho` is no longer a free witness. It
//! is the digest of a hash of the two public nullifiers and the output index, computed in the
//! trace, and the first absorption of each output commitment must take it from there.

pub const CYCLE: usize = 32;
pub const LOG_TRACE_LEN: usize = 12;
pub const TRACE_LEN: usize = 1 << LOG_TRACE_LEN;
pub const NUM_CYCLES: usize = TRACE_LEN / CYCLE;
pub const TREE_DEPTH: usize = 32;
pub const NUM_INPUTS: usize = 2;
pub const NUM_OUTPUTS: usize = 2;

// ---- sponge ----------------------------------------------------------------------------------
pub const STATE_WIDTH: usize = 24;
pub const RATE: usize = 16;
pub const DIGEST: usize = 8;
/// Capacity = state[16..24]; `state[CAP]` = input length, `state[CAP + 1]` = domain tag,
/// `state[CAP + 2]` = index (0 everywhere except `H_rho`, where it is the output index).
pub const CAP: usize = 16;

// ---- columns ---------------------------------------------------------------------------------
/// Hash state, columns 0..24 (rate 0..16, capacity 16..24, digest 0..8).
pub const S: usize = 0;
/// Spending key of the CURRENT input (8 elements). Constant inside an input block; may change
/// only on the link into an NK cycle.
pub const SK: usize = 24;
/// rho of the CURRENT input note (8 elements); same rule as `SK`.
pub const RHO: usize = 32;
/// Value of input 1 / input 2, four 16-bit limbs each, least significant first; constant over
/// the whole trace.
pub const A1: usize = 40;
pub const A2: usize = 44;
/// Value of output 1 / output 2, four 16-bit limbs each; constant.
pub const B1: usize = 48;
pub const B2: usize = 52;
/// Enable flags of input 1 / input 2 (1 = real note, membership enforced; 0 = dummy); constant.
pub const EN1: usize = 56;
pub const EN2: usize = 57;
/// Carries of the three lower limb equations: carry_j = KA_j + 2 KB_j - 3 with KA in {0,1,2,3}
/// and KB in {0,1}, i.e. carry in {-3,..,2}; constant.
pub const KA: usize = 58;
pub const KB: usize = 61;
/// Merkle position bit, read on row 0 of each Merkle cycle.
pub const P: usize = 64;
/// Range-check lane X (input-value limbs): bit and running accumulator.
pub const BITX: usize = 65;
pub const ACCX: usize = 66;
/// Range-check lane Y (output-value limbs).
pub const BITY: usize = 67;
pub const ACCY: usize = 68;
/// "This row belongs to a Merkle cycle of an ENABLED input": T = sel[MK] * EN(current input).
pub const T: usize = 69;
/// Cycle counter (0 on row 0, +1 at every link).
pub const CNT: usize = 70;
/// Index of the current input block: 0 until the link into the second NK cycle, 1 afterwards.
pub const IDX: usize = 71;
/// One-hot "type of this cycle" selectors.
pub const SEL: usize = 72;
pub const X_NK: usize = 0;
pub const X_NF: usize = 1;
pub const X_PK: usize = 2;
pub const X_CM1: usize = 3;
pub const X_CM2: usize = 4;
pub const X_MK: usize = 5;
/// Output 1: first / second absorption of its commitment.
pub const X_OA1: usize = 6;
pub const X_OA2: usize = 7;
/// Output 2: first / second absorption.
pub const X_OB1: usize = 8;
pub const X_OB2: usize = 9;
/// rho of output 1 / output 2: `H_rho(nf1, nf2, j)`. (Numbered after the SHIELD-2 selectors so
/// that those keep their indices; in the schedule RA precedes OA1 and RB precedes OB1.)
pub const X_RA: usize = 10;
pub const X_RB: usize = 11;
pub const NUM_SEL: usize = 12;
pub const TRACE_WIDTH: usize = SEL + NUM_SEL; // 84

/// First column of the "switching" registers (SK, RHO) and of the constant registers.
pub const SWITCH_FROM: usize = SK;
pub const CONST_FROM: usize = A1;
pub const CONST_TO: usize = P; // exclusive

// ---- cycle schedule --------------------------------------------------------------------------
/// Cycles of one input block: nk, nf, pk, cm1, cm2, 32 Merkle levels.
pub const BLOCK: usize = 5 + TREE_DEPTH; // 37
pub const O_NK: usize = 0; // nk = H(D_NK; sk)
pub const O_NF: usize = 1; // nf = H(D_NF; nk, rho)
pub const O_PK: usize = 2; // pk = H(D_PK; sk)
pub const O_CM1: usize = 3; // cm, first absorption (pk, rho)
pub const O_CM2: usize = 4; // cm, second absorption (value limbs, r)
pub const O_MK0: usize = 5; // Merkle levels 0..32 occupy offsets 5..=36
/// First cycle of input block `i` (0 or 1).
pub const fn c_in(i: usize) -> usize {
    i * BLOCK
}
/// Cycle of the second NK (start of input block 2).
pub const C_NK2: usize = BLOCK; // 37
/// First cycle of the output part (the rho hash of output 1).
pub const C_OUT: usize = 2 * BLOCK; // 74
/// Cycles of one output: rho hash, commitment first absorption, commitment second absorption.
pub const OUT_BLOCK: usize = 3;
/// Cycle of output `j`'s rho hash.
pub const fn c_rho(j: usize) -> usize {
    C_OUT + OUT_BLOCK * j
}
/// First cycle of output `j`'s commitment (two cycles; the rho hash is the cycle before).
pub const fn c_out(j: usize) -> usize {
    c_rho(j) + 1
}
pub const USED_CYCLES: usize = C_OUT + OUT_BLOCK * NUM_OUTPUTS; // 80 permutations carry the statement

/// Row on which cycle `c` starts.
pub const fn first_row(c: usize) -> usize {
    c * CYCLE
}
/// Row holding the output of cycle `c`.
pub const fn out_row(c: usize) -> usize {
    c * CYCLE + CYCLE - 1
}

// ---- range check -----------------------------------------------------------------------------
/// Each 16-bit limb is decomposed MSB-first over 16 rows. A lane checks eight limbs with period
/// 128: segments 0..4 = limbs of the first value (A1 / B1), segments 4..8 = the second (A2 / B2).
pub const LIMB_BITS: usize = 16;
pub const NUM_LIMBS: usize = 4;
pub const RANGE_PERIOD: usize = 128;

// ---- domain tags (second capacity element) ---------------------------------------------------
pub const D_NK: u32 = 1;
pub const D_PK: u32 = 2;
pub const D_NF: u32 = 3;
pub const D_CM: u32 = 4;
pub const D_MK: u32 = 5;
/// Output rho: `H_rho(nf1, nf2, j)` = sponge of the 16 elements nf1 ‖ nf2 with capacity
/// `[16, D_RHO, j, 0, 0, 0, 0, 0]` (SHIELD-3; no other use has a non-zero third element).
pub const D_RHO: u32 = 6;
/// Input lengths (first capacity element).
pub const LEN_KEY: u32 = 8;
pub const LEN_PAIR: u32 = 16;
pub const LEN_CM: u32 = 28;

// ---- periodic columns ------------------------------------------------------------------------
/// Round constants, period 32 (zero where a round adds none).
pub const PER_RC: usize = 0;
/// 1 on row 0 of a cycle (initial linear layer + full round), period 32.
pub const PER_R0: usize = 24;
/// 1 on the other full-round rows (1, 2, 3, 27, 28, 29, 30), period 32.
pub const PER_FULL: usize = 25;
/// 1 on the partial-round rows (4..=26), period 32.
pub const PER_PART: usize = 26;
/// 1 on row 31 of a cycle, period 32.
pub const PER_LINK: usize = 27;
/// 1 on the last row of each 16-row range-check segment, period 16.
pub const PER_SEG_END: usize = 28;
/// `PER_U + j` is 1 on row 16 j + 15 (mod 64): end of the segment of limb j; period 64.
pub const PER_U: usize = 29;
/// 0 on rows 0..64, 1 on rows 64..128 (first value / second value of a lane); period 128.
pub const PER_H: usize = 33;
pub const NUM_PERIODIC: usize = 34;

// ---- public values ---------------------------------------------------------------------------
pub const PV_ANCHOR: usize = 0;
pub const PV_NF1: usize = 8;
pub const PV_NF2: usize = 16;
pub const PV_CM1: usize = 24;
pub const PV_CM2: usize = 32;
/// v_in, v_out, fee: four 16-bit limbs each, produced by the verifier from u64s.
pub const PV_V_IN: usize = 40;
pub const PV_V_OUT: usize = 44;
pub const PV_FEE: usize = 48;
/// Not constrained by the AIR; bound through the transcript (public values are absorbed before
/// any challenge is drawn).
pub const PV_BINDING: usize = 52;
pub const NUM_PUBLIC_VALUES: usize = 60;
