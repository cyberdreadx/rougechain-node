//! The trace builder.
//!
//! The builder does NOT validate anything: it writes whatever it is given. `TraceInputs` lists
//! every linked value separately, `Schedule` can move the block boundaries, and `Overrides` can
//! replace the initial state of any hash or any single cell, so the negative tests can force
//! inconsistent traces through the prover and show that the VERIFIER refuses them. Soundness
//! never depends on this file.

use std::collections::HashMap;

use p3_field::{PrimeCharacteristicRing, PrimeField32};
use p3_matrix::dense::RowMajorMatrix;

use crate::Felt;
use crate::air::apply_row;
use crate::layout::*;
use crate::reference::{Digest, JoinSplit, PublicInputs, ZERO_DIGEST, limbs};

/// Low-level trace inputs; every value the AIR links appears once here.
#[derive(Clone, Debug)]
pub struct TraceInputs {
    pub sk: [Digest; 2],
    pub rho: [Digest; 2],
    pub r: [Digest; 2],
    /// input values, four limbs each
    pub a: [[Felt; NUM_LIMBS]; 2],
    /// enable flags
    pub en: [Felt; 2],
    pub siblings: [[Digest; TREE_DEPTH]; 2],
    pub pos_bits: [[Felt; TREE_DEPTH]; 2],
    /// output values
    pub b: [[Felt; NUM_LIMBS]; 2],
    pub pk_out: [Digest; 2],
    /// (no `rho_out`: the trace derives it in the RA / RB cycles; tests that want another rho in
    /// a commitment override the initial state of the OA1 / OB1 cycle)
    pub r_out: [Digest; 2],
    /// carry_j = ka_j + 2 kb_j - 3 for limbs 0, 1, 2
    pub ka: [Felt; NUM_LIMBS - 1],
    pub kb: [Felt; NUM_LIMBS - 1],
}

#[derive(Clone, Debug, Default)]
pub struct Overrides {
    /// cycle index -> sponge state written on row 0 of that cycle instead of the linked one
    pub init: HashMap<usize, [Felt; STATE_WIDTH]>,
    /// (column, row, value) written after everything else
    pub cells: Vec<(usize, usize, Felt)>,
    /// The two nullifiers the RA / RB cycles absorb. `None` (honest): the digests the trace itself
    /// computed in its two NF cycles. Tests that claim OTHER public nullifiers than the computed
    /// ones set this to the claimed pair so that the rho links stay satisfied and the case stays
    /// isolated on the constraint under test.
    pub rho_nf: Option<[Digest; 2]>,
}

/// Where the block boundaries are. Honest: the second input block starts in cycle 37 and the
/// outputs in cycle 74. Tests move or remove them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Schedule {
    /// cycle of the second NK; `None`: there is no second input block
    pub nk2: Option<usize>,
    /// first cycle of the output part (RA); `None`: the outputs never start (the Merkle run goes
    /// on to the end)
    pub out: Option<usize>,
}

impl Schedule {
    pub const HONEST: Schedule = Schedule { nk2: Some(C_NK2), out: Some(C_OUT) };

    /// (selector set in cycle `c`, input block, Merkle level or output index)
    pub fn cycle(&self, c: usize) -> (Option<usize>, usize, usize) {
        if let Some(o) = self.out {
            if c >= o {
                let off = c - o;
                let x = [X_RA, X_OA1, X_OA2, X_RB, X_OB1, X_OB2].get(off).copied();
                // the registers keep the last input block's values; `sub` = output index
                return (x, self.nk2.is_some() as usize, off / OUT_BLOCK);
            }
        }
        let (block, start) = match self.nk2 {
            Some(n2) if c >= n2 => (1, n2),
            _ => (0, 0),
        };
        let off = c - start;
        match off {
            O_NK => (Some(X_NK), block, 0),
            O_NF => (Some(X_NF), block, 0),
            O_PK => (Some(X_PK), block, 0),
            O_CM1 => (Some(X_CM1), block, 0),
            O_CM2 => (Some(X_CM2), block, 0),
            _ => (Some(X_MK), block, off - O_MK0),
        }
    }
}

fn felt_i64(v: i64) -> Felt {
    if v >= 0 { Felt::from_u64(v as u64) } else { -Felt::from_u64((-v) as u64) }
}

/// (KA, KB) for the three lower limb equations from the net value of each limb equation
/// (left side minus right side, before carries). Floor division; no validation: an out-of-range
/// carry ends up in KA.
pub fn carries_from_net(net: [i64; NUM_LIMBS]) -> ([Felt; NUM_LIMBS - 1], [Felt; NUM_LIMBS - 1]) {
    let mut ka = [Felt::ZERO; NUM_LIMBS - 1];
    let mut kb = [Felt::ZERO; NUM_LIMBS - 1];
    let mut carry = 0i64;
    for j in 0..NUM_LIMBS - 1 {
        carry = (net[j] + carry).div_euclid(1 << 16);
        let t = carry + 3;
        let hi = (t >= 4) as i64;
        kb[j] = felt_i64(hi);
        ka[j] = felt_i64(t - 2 * hi);
    }
    (ka, kb)
}

/// (KA, KB) for the given limbs and public amounts.
pub fn carries(
    a: &[[Felt; NUM_LIMBS]; 2],
    b: &[[Felt; NUM_LIMBS]; 2],
    v_in: u64,
    v_out: u64,
    fee: u64,
) -> ([Felt; NUM_LIMBS - 1], [Felt; NUM_LIMBS - 1]) {
    let lim = |v: u64, j: usize| ((v >> (16 * j)) & 0xffff) as i64;
    let f = |x: Felt| x.as_canonical_u32() as i64;
    carries_from_net(core::array::from_fn(|j| {
        f(a[0][j]) + f(a[1][j]) + lim(v_in, j) - f(b[0][j]) - f(b[1][j]) - lim(v_out, j) - lim(fee, j)
    }))
}

impl TraceInputs {
    pub fn honest(js: &JoinSplit) -> Self {
        let a = [limbs(js.inputs[0].value), limbs(js.inputs[1].value)];
        let b = [limbs(js.outputs[0].value), limbs(js.outputs[1].value)];
        let (ka, kb) = carries(&a, &b, js.v_in, js.v_out, js.fee);
        let i = |n: usize| &js.inputs[n];
        let o = |n: usize| &js.outputs[n];
        let bits = |n: usize| core::array::from_fn(|l| Felt::from_u32((i(n).index >> l) & 1));
        Self {
            sk: [i(0).sk, i(1).sk],
            rho: [i(0).rho, i(1).rho],
            r: [i(0).r, i(1).r],
            a,
            en: [Felt::from_bool(i(0).enabled), Felt::from_bool(i(1).enabled)],
            siblings: [i(0).path, i(1).path],
            pos_bits: [bits(0), bits(1)],
            b,
            pk_out: [o(0).pk, o(1).pk],
            r_out: [o(0).r, o(1).r],
            ka,
            kb,
        }
    }
}

/// A fresh sponge state: rate = lo ‖ hi, capacity = [len, domain, 0, ...].
/// The initial state of `H_rho(nf1, nf2, j)`: rate = nf1 ‖ nf2, capacity = [16, D_RHO, j, 0, ...].
pub fn fresh_rho(nf: &[Digest; 2], j: usize) -> [Felt; STATE_WIDTH] {
    let mut s = fresh(LEN_PAIR, D_RHO, &nf[0], &nf[1]);
    s[CAP + 2] = Felt::from_u32(j as u32);
    s
}

pub fn fresh(len: u32, domain: u32, lo: &Digest, hi: &Digest) -> [Felt; STATE_WIDTH] {
    let mut s = [Felt::ZERO; STATE_WIDTH];
    s[..DIGEST].copy_from_slice(lo);
    s[DIGEST..RATE].copy_from_slice(hi);
    s[CAP] = Felt::from_u32(len);
    s[CAP + 1] = Felt::from_u32(domain);
    s
}

/// Second absorption of a commitment: value limbs into rate 0..4, r into rate 4..12.
pub fn second_block(out: &[Felt; STATE_WIDTH], limbs: &[Felt; NUM_LIMBS], r: &Digest) -> [Felt; STATE_WIDTH] {
    let mut s = *out;
    for j in 0..NUM_LIMBS {
        s[j] += limbs[j];
    }
    for j in 0..DIGEST {
        s[NUM_LIMBS + j] += r[j];
    }
    s
}

pub fn build_trace(inp: &TraceInputs, ov: &Overrides) -> RowMajorMatrix<Felt> {
    build_trace_with(inp, ov, &Schedule::HONEST, TRACE_LEN)
}

/// The trace for an arbitrary schedule and height (`n_rows` >= 4,096; extra cycles are padding).
pub fn build_trace_with(inp: &TraceInputs, ov: &Overrides, sched: &Schedule, n_rows: usize) -> RowMajorMatrix<Felt> {
    assert!(n_rows.is_power_of_two() && n_rows >= TRACE_LEN);
    let mut t = vec![Felt::ZERO; n_rows * TRACE_WIDTH];
    let at = |row: usize, col: usize| row * TRACE_WIDTH + col;

    let mut state = [Felt::ZERO; STATE_WIDTH];
    // digests of the NF cycles seen so far (what the honest RA / RB cycles absorb)
    let mut nf_seen = [ZERO_DIGEST; 2];
    let mut prev_ty = None;
    for c in 0..n_rows / CYCLE {
        let out = state; // output of the previous cycle
        let dig: Digest = core::array::from_fn(|i| out[i]);
        let (ty, blk, sub) = sched.cycle(c);
        if prev_ty == Some(X_NF) {
            nf_seen[blk] = dig;
        }
        prev_ty = ty;
        let init = match ty {
            Some(X_NK) => fresh(LEN_KEY, D_NK, &inp.sk[blk], &ZERO_DIGEST),
            Some(X_PK) => fresh(LEN_KEY, D_PK, &inp.sk[blk], &ZERO_DIGEST),
            Some(X_NF) => fresh(LEN_PAIR, D_NF, &dig, &inp.rho[blk]),
            Some(X_CM1) => fresh(LEN_CM, D_CM, &dig, &inp.rho[blk]),
            Some(X_CM2) => second_block(&out, &inp.a[blk], &inp.r[blk]),
            Some(X_MK) => {
                let (sib, bit) = if sub < TREE_DEPTH {
                    (inp.siblings[blk][sub], inp.pos_bits[blk][sub])
                } else {
                    (ZERO_DIGEST, Felt::ZERO)
                };
                // anything other than 0 is laid out as "current node on the right"
                if bit == Felt::ZERO { fresh(LEN_PAIR, D_MK, &dig, &sib) } else { fresh(LEN_PAIR, D_MK, &sib, &dig) }
            }
            Some(X_RA) | Some(X_RB) => fresh_rho(&ov.rho_nf.unwrap_or(nf_seen), sub),
            // rho = the digest of the RA / RB cycle just finished
            Some(X_OA1) | Some(X_OB1) => fresh(LEN_CM, D_CM, &inp.pk_out[sub], &dig),
            Some(X_OA2) | Some(X_OB2) => second_block(&out, &inp.b[sub], &inp.r_out[sub]),
            _ => out, // padding: keep hashing
        };
        state = *ov.init.get(&c).unwrap_or(&init);

        let row0 = first_row(c);
        let idx = Felt::from_u32(blk as u32);
        for r in 0..CYCLE {
            let row = row0 + r;
            t[at(row, S)..at(row, S) + STATE_WIDTH].copy_from_slice(&state);
            if r < CYCLE - 1 {
                apply_row(&mut state, r);
            }
            t[at(row, SK)..at(row, SK) + DIGEST].copy_from_slice(&inp.sk[blk]);
            t[at(row, RHO)..at(row, RHO) + DIGEST].copy_from_slice(&inp.rho[blk]);
            if ty == Some(X_MK) {
                if sub < TREE_DEPTH {
                    t[at(row, P)] = inp.pos_bits[blk][sub];
                }
                t[at(row, T)] = inp.en[blk];
            }
            t[at(row, CNT)] = Felt::from_u32(c as u32);
            t[at(row, IDX)] = idx;
            if let Some(x) = ty {
                t[at(row, SEL + x)] = Felt::ONE;
            }
        }
    }

    // constant registers
    for row in 0..n_rows {
        for i in 0..2 {
            t[at(row, A1 + 4 * i)..at(row, A1 + 4 * i) + NUM_LIMBS].copy_from_slice(&inp.a[i]);
            t[at(row, B1 + 4 * i)..at(row, B1 + 4 * i) + NUM_LIMBS].copy_from_slice(&inp.b[i]);
            t[at(row, EN1 + i)] = inp.en[i];
        }
        t[at(row, KA)..at(row, KA) + NUM_LIMBS - 1].copy_from_slice(&inp.ka);
        t[at(row, KB)..at(row, KB) + NUM_LIMBS - 1].copy_from_slice(&inp.kb);
    }

    // range-check lanes: low 16 bits of each limb, MSB first
    for (bit_c, acc_c, vals) in [(BITX, ACCX, &inp.a), (BITY, ACCY, &inp.b)] {
        let limb_vals: Vec<u32> = vals.iter().flatten().map(|l| l.as_canonical_u32()).collect();
        for row in 0..n_rows {
            let seg = (row % RANGE_PERIOD) / LIMB_BITS;
            let i = row % LIMB_BITS;
            let v = limb_vals[seg] & 0xffff;
            t[at(row, bit_c)] = Felt::from_u32((v >> (LIMB_BITS - 1 - i)) & 1);
            t[at(row, acc_c)] = if i == 0 { Felt::ZERO } else { Felt::from_u32(v >> (LIMB_BITS - i)) };
        }
    }

    for &(col, row, val) in &ov.cells {
        t[at(row, col)] = val;
    }

    RowMajorMatrix::new(t, TRACE_WIDTH)
}

/// The honest trace of a join-split.
pub fn honest_trace(js: &JoinSplit) -> RowMajorMatrix<Felt> {
    build_trace(&TraceInputs::honest(js), &Overrides::default())
}

pub fn cell(trace: &RowMajorMatrix<Felt>, col: usize, row: usize) -> Felt {
    trace.values[row * TRACE_WIDTH + col]
}

/// Digest held in the hash state on `row`.
pub fn digest_at(trace: &RowMajorMatrix<Felt>, row: usize) -> Digest {
    core::array::from_fn(|i| cell(trace, S + i, row))
}

/// Full hash state on `row`.
pub fn state_at(trace: &RowMajorMatrix<Felt>, row: usize) -> [Felt; STATE_WIDTH] {
    core::array::from_fn(|i| cell(trace, S + i, row))
}

/// The Merkle root input block `i` computes in an honest-schedule trace.
pub fn root_at(trace: &RowMajorMatrix<Felt>, i: usize) -> Digest {
    digest_at(trace, out_row(c_in(i) + BLOCK - 1))
}

/// Public inputs that make the nullifier and output-commitment assertions hold for THIS
/// (honest-schedule) trace, whatever it contains; the anchor is the root input block
/// `anchor_from` computes. Used by negative tests to isolate a single violated constraint.
pub fn public_inputs_from_trace(trace: &RowMajorMatrix<Felt>, anchor_from: usize, js: &JoinSplit) -> PublicInputs {
    PublicInputs {
        anchor: root_at(trace, anchor_from),
        nf: [digest_at(trace, out_row(c_in(0) + O_NF)), digest_at(trace, out_row(c_in(1) + O_NF))],
        cm_out: [digest_at(trace, out_row(c_out(0) + 1)), digest_at(trace, out_row(c_out(1) + 1))],
        v_in: js.v_in,
        v_out: js.v_out,
        fee: js.fee,
        binding: js.binding,
    }
}
