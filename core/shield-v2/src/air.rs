//! The SHIELD-3 AIR (SHIELD-2's AIR plus the in-circuit derivation of the output notes' `rho`,
//! review finding F-2): the full join-split of the shielded-pool design (2 inputs, 2 outputs,
//! depth-32 paths under one anchor, dummy inputs) over KoalaBear with Poseidon2 (width 24) as the
//! in-circuit hash, for Plonky3 uni-stark.
//!
//! Every constraint holds on EVERY row, cyclically (the last row's "next" is row 0), except the
//! ones guarded by `when_first_row` / `when_transition` / `when_last_row`. Maximum degree 4
//! (4 quotient chunks without hiding, 8 with).
//!
//! # Schedule (a deterministic state machine in trace columns, as in SHIELD-1)
//!
//! * `CNT` is 0 on the first row and increases by one at every link row: the cycle index.
//! * `sel[NK]` is 1 on the first row and every other selector 0; selectors are constant inside a
//!   cycle. At a link: `NF' = NK`, `PK' = NF`, `CM1' = PK`, `CM2' = CM1`,
//!   `MK' = MK (1 - NK' - RA') + CM2`, `OA1' = RA`, `OA2' = OA1`, `RB' = OA2`, `OB1' = RB`,
//!   `OB2' = OB1`.
//!   `NK'` and `RA'` are free at a link but pinned: `NK CNT (CNT - 37) = 0` and
//!   `RA (CNT - 74) = 0`.
//! * `IDX` is 0 on the first row, `IDX' = IDX + [link] NK'`, and `IDX = 1` on the last row: the
//!   second NK cycle (37) MUST happen. `MK = 0` on the last row: the second Merkle run MUST be
//!   left, which only `RA` (cycle 74) can do. Hence every cycle's type is forced:
//!   74 RA, 75 OA1, 76 OA2, 77 RB, 78 OB1, 79 OB2.
//! * The first-row values of ALL selectors (`NK = 1`, every other 0) are load-bearing, not a
//!   backstop: the step constraints are `when_transition` only, so without them a prover could
//!   set further selectors on cycle 0 and have two selectors add their equations on one link.
//!
//! # Output rho (SHIELD-3)
//!
//! The link into `RA` / `RB` fixes the WHOLE sponge state from public values: rate = nf1 ‖ nf2
//! (the public nullifiers, which section (3) forces to be the ones the trace computed), capacity
//! = `[16, D_RHO, j, 0, ...]` with j = 0 for `RA` and 1 for `RB`. The link into `OA1` / `OB1`
//! forces rate[8..16] (the `rho` slot of the commitment) to equal the digest of the cycle before,
//! i.e. that rho. `pk'` (rate[0..8]) and `r'` stay free. A sender can therefore no longer choose
//! the `rho` of a note it creates.
//!
//! # Dummy inputs
//!
//! `EN1`, `EN2` are boolean constants. `T = sel[MK] * EN(current input)` is a column; the anchor
//! is compared on the link that leaves a Merkle run, multiplied by `T`. `(1 - EN_i) * A_i[j] = 0`
//! forces a dummy's value to zero. Everything else (keys, nullifier, commitment, 32 Merkle
//! hashes) is enforced for a dummy exactly as for a real input.

use std::borrow::Cow;

use p3_air::{Air, AirBuilder, BaseAir, WindowAccess};
use p3_field::PrimeCharacteristicRing;
use p3_koala_bear::{
    GenericPoseidon2LinearLayersKoalaBear, KOALABEAR_POSEIDON2_RC_24_EXTERNAL_FINAL,
    KOALABEAR_POSEIDON2_RC_24_EXTERNAL_INITIAL, KOALABEAR_POSEIDON2_RC_24_INTERNAL,
};
use p3_poseidon2::GenericPoseidon2LinearLayers;

use crate::Felt;
use crate::layout::*;

type Layers = GenericPoseidon2LinearLayersKoalaBear;

pub const FULL_HALF: usize = 4;
pub const PARTIAL: usize = 23;
/// Rows of a cycle whose transition is a full round other than the first.
pub const fn is_full_row(r: usize) -> bool {
    (r >= 1 && r < FULL_HALF) || (r >= FULL_HALF + PARTIAL && r < 2 * FULL_HALF + PARTIAL)
}
pub const fn is_partial_row(r: usize) -> bool {
    r >= FULL_HALF && r < FULL_HALF + PARTIAL
}

/// Round constants added on the transition out of row `r` of a cycle (zero where none).
pub fn round_constants(r: usize) -> [Felt; STATE_WIDTH] {
    let mut out = [Felt::ZERO; STATE_WIDTH];
    if r < FULL_HALF {
        out = KOALABEAR_POSEIDON2_RC_24_EXTERNAL_INITIAL[r];
    } else if r < FULL_HALF + PARTIAL {
        out[0] = KOALABEAR_POSEIDON2_RC_24_INTERNAL[r - FULL_HALF];
    } else if r < 2 * FULL_HALF + PARTIAL {
        out = KOALABEAR_POSEIDON2_RC_24_EXTERNAL_FINAL[r - FULL_HALF - PARTIAL];
    }
    out
}

/// The transition out of row `r` (0..=30) of a cycle, on concrete values. The trace builder uses
/// this; a test checks that 31 applications equal the library permutation.
pub fn apply_row(state: &mut [Felt; STATE_WIDTH], r: usize) {
    let rc = round_constants(r);
    if r == 0 {
        Layers::external_linear_layer(state);
    }
    if is_partial_row(r) {
        state[0] = (state[0] + rc[0]).cube();
        Layers::internal_linear_layer(state);
    } else {
        for (s, c) in state.iter_mut().zip(rc) {
            *s = (*s + c).cube();
        }
        Layers::external_linear_layer(state);
    }
}

/// The periodic columns, in `PER_*` order.
pub fn periodic_table() -> Vec<Vec<Felt>> {
    let bit = |b: bool| if b { Felt::ONE } else { Felt::ZERO };
    let mut cols = Vec::with_capacity(NUM_PERIODIC);
    for i in 0..STATE_WIDTH {
        cols.push((0..CYCLE).map(|r| round_constants(r)[i]).collect());
    }
    cols.push((0..CYCLE).map(|r| bit(r == 0)).collect());
    cols.push((0..CYCLE).map(|r| bit(is_full_row(r))).collect());
    cols.push((0..CYCLE).map(|r| bit(is_partial_row(r))).collect());
    cols.push((0..CYCLE).map(|r| bit(r == CYCLE - 1)).collect());
    cols.push((0..LIMB_BITS).map(|r| bit(r == LIMB_BITS - 1)).collect());
    for j in 0..NUM_LIMBS {
        cols.push((0..NUM_LIMBS * LIMB_BITS).map(|r| bit(r == LIMB_BITS * j + LIMB_BITS - 1)).collect());
    }
    cols.push((0..RANGE_PERIOD).map(|r| bit(r >= RANGE_PERIOD / 2)).collect());
    assert_eq!(cols.len(), NUM_PERIODIC);
    cols
}

#[derive(Clone, Debug)]
pub struct JoinSplitAir {
    periodic: Vec<Vec<Felt>>,
}

impl Default for JoinSplitAir {
    fn default() -> Self {
        Self::new()
    }
}

impl JoinSplitAir {
    pub fn new() -> Self {
        Self { periodic: periodic_table() }
    }
}

impl BaseAir<Felt> for JoinSplitAir {
    fn width(&self) -> usize {
        TRACE_WIDTH
    }
    fn num_public_values(&self) -> usize {
        NUM_PUBLIC_VALUES
    }
    fn num_periodic_columns(&self) -> usize {
        NUM_PERIODIC
    }
    fn periodic_columns(&self) -> Cow<'_, [Vec<Felt>]> {
        Cow::Borrowed(&self.periodic)
    }
}

// Index of each constraint group in the order `eval` emits them (what `check_all_constraints`
// reports); used by the negative tests to name the constraint that a forged trace violates.
pub const TC_ROUND: usize = 0; // 24
pub const TC_LINK: usize = 24; // 24, sponge-state element i
pub const TC_NF: usize = 48; // 8
pub const TC_ANCHOR: usize = 56; // 8
pub const TC_CMOUT: usize = 64; // 8
pub const TC_SWITCH: usize = 72; // 16, column SK + i
pub const TC_CONST: usize = 88; // 24, column A1 + i
pub const TC_BAL: usize = 112; // 4
pub const TC_KA: usize = 116; // 3
pub const TC_KB: usize = 119; // 3
pub const TC_EN_BOOL: usize = 122; // 2
pub const TC_DUMMY: usize = 124; // 8: input 1 limbs 0..4, input 2 limbs 0..4
pub const TC_P_BOOL: usize = 132;
pub const TC_XBIT: usize = 133;
pub const TC_XACC: usize = 134;
pub const TC_XLIMB: usize = 135;
pub const TC_YBIT: usize = 136;
pub const TC_YACC: usize = 137;
pub const TC_YLIMB: usize = 138;
pub const TC_T: usize = 139;
pub const TC_CNT_FIRST: usize = 140;
pub const TC_CNT_STEP: usize = 141;
pub const TC_IDX_FIRST: usize = 142;
pub const TC_IDX_STEP: usize = 143;
pub const TC_IDX_LAST: usize = 144;
pub const TC_SEL_BOOL: usize = 145; // 12, selector X_*
pub const TC_SEL_FIRST: usize = 157; // 12
pub const TC_SEL_STEP: usize = 169; // 12
pub const TC_NK_PIN: usize = 181;
pub const TC_RA_PIN: usize = 182;
pub const TC_MK_LAST: usize = 183;

/// Number of constraints `eval` emits (checked by a test against the symbolic count).
pub const NUM_CONSTRAINTS: usize = 184;

pub fn tc_name(i: usize) -> String {
    match i {
        0..=23 => format!("round[{i}]"),
        24..=47 => format!("link[{}]", i - TC_LINK),
        48..=55 => format!("public_nf[{}]", i - TC_NF),
        56..=63 => format!("public_anchor[{}]", i - TC_ANCHOR),
        64..=71 => format!("public_cm_out[{}]", i - TC_CMOUT),
        72..=87 => format!("switch_reg[col {}]", SK + i - TC_SWITCH),
        88..=111 => format!("const_reg[col {}]", A1 + i - TC_CONST),
        112..=115 => format!("balance[{}]", i - TC_BAL),
        116..=118 => format!("carry_ka_range[{}]", i - TC_KA),
        119..=121 => format!("carry_kb_boolean[{}]", i - TC_KB),
        122..=123 => format!("enable_boolean[input {}]", i - TC_EN_BOOL + 1),
        124..=131 => format!("dummy_value_zero[input {} limb {}]", (i - TC_DUMMY) / 4 + 1, (i - TC_DUMMY) % 4),
        TC_P_BOOL => "pos_bit_boolean".into(),
        TC_XBIT => "range_x_bit_boolean".into(),
        TC_XACC => "range_x_accumulator".into(),
        TC_XLIMB => "range_x_limb".into(),
        TC_YBIT => "range_y_bit_boolean".into(),
        TC_YACC => "range_y_accumulator".into(),
        TC_YLIMB => "range_y_limb".into(),
        TC_T => "t_definition".into(),
        TC_CNT_FIRST => "cnt_first".into(),
        TC_CNT_STEP => "cnt_step".into(),
        TC_IDX_FIRST => "idx_first".into(),
        TC_IDX_STEP => "idx_step".into(),
        TC_IDX_LAST => "idx_is_1_on_last_row".into(),
        145..=156 => format!("sel_boolean[{}]", i - TC_SEL_BOOL),
        157..=168 => format!("sel_first[{}]", i - TC_SEL_FIRST),
        169..=180 => format!("sel_step[{}]", i - TC_SEL_STEP),
        TC_NK_PIN => "nk_only_in_cycles_0_and_37".into(),
        TC_RA_PIN => "ra_only_in_cycle_74".into(),
        TC_MK_LAST => "mk_cleared_by_last_row".into(),
        _ => format!("?{i}"),
    }
}

impl<AB: AirBuilder<F = Felt>> Air<AB> for JoinSplitAir {
    fn eval(&self, builder: &mut AB) {
        let k = |v: u32| -> AB::Expr { AB::Expr::from(Felt::from_u32(v)) };
        let one = || -> AB::Expr { AB::Expr::ONE };

        let pv: Vec<AB::Expr> = builder.public_values().iter().map(|&v| v.into()).collect();
        let per: Vec<AB::Expr> = builder.periodic_values().iter().map(|&v| v.into()).collect();
        let main = builder.main();
        let cur: Vec<AB::Expr> = main.current_slice().iter().map(|v| v.clone().into()).collect();
        let nxt: Vec<AB::Expr> = main.next_slice().iter().map(|v| v.clone().into()).collect();

        let is_r0 = per[PER_R0].clone();
        let is_full = per[PER_FULL].clone();
        let is_part = per[PER_PART].clone();
        let is_link = per[PER_LINK].clone();

        // ---- (1) Poseidon2 rounds: 24 constraints, degree 4 ------------------------------------
        {
            let st: [AB::Expr; STATE_WIDTH] = core::array::from_fn(|i| cur[S + i].clone());
            let rc = |i: usize| per[PER_RC + i].clone();

            // row 0: initial external layer, then a full round
            let mut a = st.clone();
            Layers::external_linear_layer(&mut a);
            for (i, x) in a.iter_mut().enumerate() {
                *x = (x.clone() + rc(i)).cube();
            }
            Layers::external_linear_layer(&mut a);

            // other full rounds
            let mut f = st.clone();
            for (i, x) in f.iter_mut().enumerate() {
                *x = (x.clone() + rc(i)).cube();
            }
            Layers::external_linear_layer(&mut f);

            // partial rounds
            let mut p = st;
            p[0] = (p[0].clone() + rc(0)).cube();
            Layers::internal_linear_layer(&mut p);

            for i in 0..STATE_WIDTH {
                let n = nxt[S + i].clone();
                builder.assert_zero(
                    is_r0.clone() * (n.clone() - a[i].clone())
                        + is_full.clone() * (n.clone() - f[i].clone())
                        + is_part.clone() * (n - p[i].clone()),
                );
            }
        }

        let sel = |x: usize| cur[SEL + x].clone();
        // `seln(X)` is read from the NEXT row: the type of the cycle being initialised.
        let seln = |x: usize| nxt[SEL + x].clone();
        let d = |j: usize| cur[S + j].clone(); // digest of the finished cycle (j < 8)
        let n = |i: usize| nxt[S + i].clone();
        let idx = cur[IDX].clone();

        // ---- (2) links: 24 constraints, degree <= 4 --------------------------------------------
        // The registers SK / RHO are read from the NEXT row, so the link into the second NK cycle
        // (where they may change) uses the new input's values.
        let pos = nxt[P].clone();
        for i in 0..STATE_WIDTH {
            let mut e = AB::Expr::ZERO;
            if i < DIGEST {
                // rate[0..8]: sk | previous digest | (second absorption: previous state + limb)
                e += (seln(X_NK) + seln(X_PK)) * (n(i) - nxt[SK + i].clone());
                e += (seln(X_NF) + seln(X_CM1)) * (n(i) - d(i));
                // Merkle: the running node is the left half if the bit is 0, the right half if 1
                e += seln(X_MK)
                    * ((one() - pos.clone()) * (n(i) - d(i)) + pos.clone() * (n(DIGEST + i) - d(i)));
                if i < NUM_LIMBS {
                    // value limb of the CURRENT input: A1 in block 0, A2 in block 1
                    let a = cur[A1 + i].clone() + idx.clone() * (cur[A2 + i].clone() - cur[A1 + i].clone());
                    e += seln(X_CM2) * (n(i) - cur[S + i].clone() - a);
                    e += seln(X_OA2) * (n(i) - cur[S + i].clone() - cur[B1 + i].clone());
                    e += seln(X_OB2) * (n(i) - cur[S + i].clone() - cur[B2 + i].clone());
                }
                // output rho: rate[0..8] = the public nf1
                e += (seln(X_RA) + seln(X_RB)) * (n(i) - pv[PV_NF1 + i].clone());
                // OA1 / OB1: pk' is free. Second absorptions, positions 4..12: r is free.
            } else if i < RATE {
                // rate[8..16]: zero | rho | (second absorption: 8..12 free, 12..16 unchanged)
                e += (seln(X_NK) + seln(X_PK)) * n(i);
                e += (seln(X_NF) + seln(X_CM1)) * (n(i) - nxt[RHO + i - DIGEST].clone());
                // output rho: rate[8..16] = the public nf2
                e += (seln(X_RA) + seln(X_RB)) * (n(i) - pv[PV_NF2 + i - DIGEST].clone());
                // output commitment, first absorption: the rho slot is the digest of the cycle
                // before (the RA / RB cycle), not a free value
                e += (seln(X_OA1) + seln(X_OB1)) * (n(i) - d(i - DIGEST));
                if i >= 12 {
                    e += (seln(X_CM2) + seln(X_OA2) + seln(X_OB2)) * (n(i) - cur[S + i].clone());
                }
                // MK: the sibling half is free (covered by the mux above).
            } else {
                // capacity: [len, domain, 0, ...] for a fresh sponge, unchanged for a 2nd block
                let cap = |len: u32, dom: u32| -> AB::Expr {
                    match i - CAP {
                        0 => k(len),
                        1 => k(dom),
                        _ => AB::Expr::ZERO,
                    }
                };
                e += seln(X_NK) * (n(i) - cap(LEN_KEY, D_NK));
                e += seln(X_PK) * (n(i) - cap(LEN_KEY, D_PK));
                e += seln(X_NF) * (n(i) - cap(LEN_PAIR, D_NF));
                e += seln(X_MK) * (n(i) - cap(LEN_PAIR, D_MK));
                e += (seln(X_CM1) + seln(X_OA1) + seln(X_OB1)) * (n(i) - cap(LEN_CM, D_CM));
                // H_rho: [16, D_RHO, j, 0, ...], j = 0 for output 1 (RA), 1 for output 2 (RB)
                e += seln(X_RA) * (n(i) - cap(LEN_PAIR, D_RHO));
                e += seln(X_RB) * (n(i) - cap(LEN_PAIR, D_RHO) - if i - CAP == 2 { one() } else { AB::Expr::ZERO });
                e += (seln(X_CM2) + seln(X_OA2) + seln(X_OB2)) * (n(i) - cur[S + i].clone());
            }
            builder.assert_zero(is_link.clone() * e);
        }

        // ---- (3) public digests: 8 + 8 + 8 constraints, degree <= 4 ----------------------------
        // Each is asserted on the output row of the cycle that produced the digest.
        // nf: the current cycle is NF; which public nullifier is chosen by the block index.
        for j in 0..DIGEST {
            let want = pv[PV_NF1 + j].clone() + idx.clone() * (pv[PV_NF2 + j].clone() - pv[PV_NF1 + j].clone());
            builder.assert_zero(is_link.clone() * sel(X_NF) * (d(j) - want));
        }
        // anchor: the current cycle is a Merkle cycle of an enabled input (T) and the next one is
        // not a Merkle cycle, i.e. this is the root of that input's path.
        for j in 0..DIGEST {
            builder.assert_zero(
                is_link.clone() * (one() - seln(X_MK)) * cur[T].clone() * (d(j) - pv[PV_ANCHOR + j].clone()),
            );
        }
        // output commitments: the current cycle is the second absorption of output 1 / 2.
        for j in 0..DIGEST {
            builder.assert_zero(
                is_link.clone()
                    * (sel(X_OA2) * (d(j) - pv[PV_CM1 + j].clone()) + sel(X_OB2) * (d(j) - pv[PV_CM2 + j].clone())),
            );
        }

        // ---- (4) registers --------------------------------------------------------------------
        // SK, RHO: may change only on the link into an NK cycle (16 constraints, degree 3).
        for c in SWITCH_FROM..CONST_FROM {
            builder.assert_zero((nxt[c].clone() - cur[c].clone()) * (one() - is_link.clone() * seln(X_NK)));
        }
        // values, enable flags, carries: constant over the whole trace (24 constraints).
        for c in CONST_FROM..CONST_TO {
            builder.assert_zero(nxt[c].clone() - cur[c].clone());
        }

        // ---- (5) balance over the integers: 4 + 3 + 3 constraints -------------------------------
        // a1_j + a2_j + v_in_j + c_{j-1} = b1_j + b2_j + v_out_j + fee_j + 2^16 c_j,
        // c_{-1} = c_3 = 0, c_j = KA_j + 2 KB_j - 3 in {-3,..,2}. All limbs are < 2^16 (private ones
        // by (8), public ones by construction in the verifier), so every term is below 2^20 in
        // absolute value: an equation that holds in the field holds over the integers. Weighting
        // equation j by 2^(16 j) and adding gives the 64-bit statement with no wrap-around.
        let carry = |j: usize| cur[KA + j].clone() + cur[KB + j].clone() * k(2) - k(3);
        for j in 0..NUM_LIMBS {
            let carry_in = if j == 0 { AB::Expr::ZERO } else { carry(j - 1) };
            let carry_out = if j == NUM_LIMBS - 1 { AB::Expr::ZERO } else { carry(j) };
            builder.assert_zero(
                cur[A1 + j].clone() + cur[A2 + j].clone() + pv[PV_V_IN + j].clone() + carry_in
                    - cur[B1 + j].clone()
                    - cur[B2 + j].clone()
                    - pv[PV_V_OUT + j].clone()
                    - pv[PV_FEE + j].clone()
                    - carry_out * k(1 << 16),
            );
        }
        for j in 0..NUM_LIMBS - 1 {
            let c = cur[KA + j].clone();
            builder.assert_zero(c.clone() * (c.clone() - k(1)) * (c.clone() - k(2)) * (c - k(3)));
        }
        for j in 0..NUM_LIMBS - 1 {
            let c = cur[KB + j].clone();
            builder.assert_zero(c.clone() * (c - one()));
        }

        // ---- (6) dummy inputs: 2 + 8 constraints -----------------------------------------------
        for en in [EN1, EN2] {
            builder.assert_zero(cur[en].clone() * (cur[en].clone() - one()));
        }
        for (en, a) in [(EN1, A1), (EN2, A2)] {
            for j in 0..NUM_LIMBS {
                builder.assert_zero((one() - cur[en].clone()) * cur[a + j].clone());
            }
        }

        // ---- (7) position bit is boolean: 1 constraint -----------------------------------------
        builder.assert_zero(cur[P].clone() * (cur[P].clone() - one()));

        // ---- (8) 16-bit range check of the 16 private limbs: 2 x 3 constraints ------------------
        for (bit_c, acc_c, first, second) in [(BITX, ACCX, A1, A2), (BITY, ACCY, B1, B2)] {
            let bit = cur[bit_c].clone();
            let v = cur[acc_c].clone() * k(2) + bit.clone();
            builder.assert_zero(bit.clone() * (bit - one()));
            builder.assert_zero(nxt[acc_c].clone() - (one() - per[PER_SEG_END].clone()) * v.clone());
            let h = per[PER_H].clone();
            let mut e = AB::Expr::ZERO;
            for j in 0..NUM_LIMBS {
                e += per[PER_U + j].clone()
                    * ((one() - h.clone()) * (v.clone() - cur[first + j].clone())
                        + h.clone() * (v.clone() - cur[second + j].clone()));
            }
            builder.assert_zero(e);
        }

        // ---- (9) T = sel[MK] * EN(current input): 1 constraint, degree 3 ------------------------
        builder.assert_zero(
            cur[T].clone() - sel(X_MK) * (cur[EN1].clone() + idx.clone() * (cur[EN2].clone() - cur[EN1].clone())),
        );

        // ---- (10) schedule: 2 + 3 + 12 + 12 + 12 + 1 + 1 + 1 constraints -------------------------
        builder.when_first_row().assert_zero(cur[CNT].clone());
        builder.when_transition().assert_zero(nxt[CNT].clone() - cur[CNT].clone() - is_link.clone());
        builder.when_first_row().assert_zero(idx.clone());
        builder
            .when_transition()
            .assert_zero(nxt[IDX].clone() - idx.clone() - is_link.clone() * seln(X_NK));
        builder.when_last_row().assert_zero(idx.clone() - one());
        for x in 0..NUM_SEL {
            builder.assert_zero(sel(x) * (sel(x) - one()));
        }
        for x in 0..NUM_SEL {
            let want = if x == X_NK { one() } else { AB::Expr::ZERO };
            builder.when_first_row().assert_zero(sel(x) - want);
        }
        {
            let stay = one() - is_link.clone();
            let step = |x: usize, pred: AB::Expr| -> AB::Expr {
                seln(x) - stay.clone() * sel(x) - is_link.clone() * pred
            };
            let mut t = builder.when_transition();
            // NK and RA are only constant inside a cycle; where they may be set is fixed below.
            // (Emitted in selector order X_NK .. X_RB, so constraint TC_SEL_STEP + x is selector x.)
            t.assert_zero(stay.clone() * (seln(X_NK) - sel(X_NK)));
            t.assert_zero(step(X_NF, sel(X_NK)));
            t.assert_zero(step(X_PK, sel(X_NF)));
            t.assert_zero(step(X_CM1, sel(X_PK)));
            t.assert_zero(step(X_CM2, sel(X_CM1)));
            t.assert_zero(step(X_MK, sel(X_MK) * (one() - seln(X_NK) - seln(X_RA)) + sel(X_CM2)));
            t.assert_zero(step(X_OA1, sel(X_RA)));
            t.assert_zero(step(X_OA2, sel(X_OA1)));
            t.assert_zero(step(X_OB1, sel(X_RB)));
            t.assert_zero(step(X_OB2, sel(X_OB1)));
            t.assert_zero(stay.clone() * (seln(X_RA) - sel(X_RA)));
            t.assert_zero(step(X_RB, sel(X_OA2)));
        }
        builder.assert_zero(sel(X_NK) * cur[CNT].clone() * (cur[CNT].clone() - k(C_NK2 as u32)));
        builder.assert_zero(sel(X_RA) * (cur[CNT].clone() - k(C_OUT as u32)));
        builder.when_last_row().assert_zero(sel(X_MK));
    }
}
