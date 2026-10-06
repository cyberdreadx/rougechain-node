//! TEST-PROVER FEATURE. The authors' negative suite, ported from `research/shield3/tests/negative.rs`:
//! every case must be REFUSED by the production `verify_spend`.
//!
//! Wherever a statement is about the witness, the test does not stop at "the honest builder
//! produces a different root": it builds an INCONSISTENT trace, lets the prover commit to it
//! (release profile: Plonky3's debug-only constraint check inside `prove` is off), and requires
//! the VERIFIER to reject. `check_all_constraints` additionally reports which AIR constraints the
//! forged trace violates, so each test names the constraint that does the refusing; "isolated"
//! cases require that set to be exactly the expected one.
//!
//! Differences from the research file: the research suite ran every case under three
//! configurations (Q2 / Blake3 / hiding ON, Q1 / Blake3 / hiding ON, Q2 / Blake3 / hiding OFF);
//! this crate has exactly one, so `setups()` has one entry. `n11_weaker_or_different_options`
//! (valid proofs of other configurations, and the cheating prover that seeds the transcript for
//! the production parameters) cannot be expressed without the research API and is not ported: the
//! property holds by construction (there is no other configuration to produce a proof under). Of
//! `n12` only the 8,192-row trace (the height pin) remains.
//!
//! Run: `cargo test --release -p quantum-vault-shield-v2 -j 1 --features test-prover --test negative -- --nocapture --test-threads=1`
//! Lines starting with `NEG|` are the evidence.

mod common;

use std::collections::BTreeSet;

use common::{kind, library_only};
use p3_air::check_all_constraints;
use p3_field::{Field, PrimeCharacteristicRing, PrimeField32};
use p3_matrix::dense::RowMajorMatrix;
use quantum_vault_shield_v2::Felt;
use quantum_vault_shield_v2::air::*;
use quantum_vault_shield_v2::layout::*;
use quantum_vault_shield_v2::reference::*;
use quantum_vault_shield_v2::trace::*;
use quantum_vault_shield_v2::verifier::prove_spend;
use quantum_vault_shield_v2::{MAX_PROOF_BYTES, VerifyError, verify_spend};

type Trace = RowMajorMatrix<Felt>;

/// The one configuration of this crate (the research tests' `Setup`, kept so that the test bodies
/// read as in the research tree).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Setup;

fn setups() -> Vec<Setup> {
    vec![Setup]
}

/// The research prover for the one built-in set (`prove_trace(&PRODUCTION, …)` in the research tree).
fn prove_trace(_s: &Setup, trace: Trace, public: &PublicInputs, seed: [u8; 32]) -> Result<Vec<u8>, String> {
    prove_spend(trace, public, seed)
}

/// `verify_spend_with(&PRODUCTION, …)` in the research tree is `verify_spend`.
fn verify_spend_with(_s: &Setup, public: &PublicInputs, bytes: &[u8]) -> Result<(), VerifyError> {
    verify_spend(public, bytes)
}

fn label(_s: &Setup) -> String {
    "Q2/Blake3/hiding-on".to_string()
}

fn short(e: &VerifyError) -> String {
    let s = format!("{e:?}");
    if s.len() > 110 { format!("{}…", &s[..110]) } else { s }
}

fn blind(tag: u64) -> [u8; 32] {
    TestRng(0xB11D ^ tag).seed32()
}

fn violations(trace: &Trace, pi: &PublicInputs) -> BTreeSet<usize> {
    let report = check_all_constraints(&JoinSplitAir::new(), trace, &pi.to_values(), None);
    report.failures.iter().map(|f| f.constraint).collect()
}

fn range(from: usize, n: usize) -> Vec<usize> {
    (from..from + n).collect()
}

fn cat(a: &[usize], b: &[usize]) -> Vec<usize> {
    a.iter().chain(b).copied().collect()
}

/// What the forged trace is allowed to violate.
enum Expect<'a> {
    /// exactly this set (an isolated constraint group)
    Exactly(&'a [usize]),
    /// a non-empty subset of this set
    Within(&'a [usize]),
    /// at least these
    Contains(&'a [usize]),
    /// at least the first set, and nothing outside the second
    Both(&'a [usize], &'a [usize]),
}

/// Forces `build()` through the prover in every configuration and requires the verifier to reject.
fn must_reject_forced(name: &str, build: &dyn Fn() -> Trace, pi: &PublicInputs, expect: Expect) {
    let tc = violations(&build(), pi);
    assert!(!tc.is_empty(), "{name}: forged trace violates nothing");
    let within = |set: &[usize]| {
        assert!(tc.iter().all(|i| set.contains(i)), "{name}: violates outside the expected group: {tc:?}")
    };
    let contains = |set: &[usize]| {
        assert!(set.iter().all(|i| tc.contains(i)), "{name}: expected violations missing: {tc:?}")
    };
    let kind = match expect {
        Expect::Exactly(only) => {
            let want: BTreeSet<usize> = only.iter().copied().collect();
            assert_eq!(tc, want, "{name}: unexpected set of violated constraints");
            "isolated"
        }
        Expect::Within(set) => {
            within(set);
            "group"
        }
        Expect::Contains(set) => {
            contains(set);
            "contains"
        }
        Expect::Both(c, w) => {
            contains(c);
            within(w);
            "group"
        }
    };
    let names: Vec<String> = tc.iter().map(|i| tc_name(*i)).collect();
    for (n, s) in setups().iter().enumerate() {
        let how = match prove_trace(s, build(), pi, blind(n as u64)) {
            Err(e) => format!("PROVER error (no proof): {e}"),
            Ok(bytes) => match verify_spend_with(s, pi, &bytes) {
                Ok(()) => panic!("{name} [{}]: FORGED PROOF ACCEPTED", label(s)),
                Err(e) => format!("forced proof made ({} B); VERIFIER rejects: {}", bytes.len(), short(&e)),
            },
        };
        println!("NEG|{name}|{}|forced/{kind}|AIR violations {names:?}|{how}", label(s));
    }
}

/// One honest proof per configuration, presented with each altered set of public inputs.
fn must_reject_public(js: &JoinSplit, altered: &[(String, PublicInputs)]) {
    for (n, s) in setups().iter().enumerate() {
        let bytes = prove_trace(s, honest_trace(js), &js.public(), blind(100 + n as u64)).unwrap();
        verify_spend_with(s, &js.public(), &bytes).expect("control must verify");
        for (name, pi) in altered {
            assert_ne!(&js.public(), pi);
            match verify_spend_with(s, pi, &bytes) {
                Ok(()) => panic!("{name} [{}]: ACCEPTED with altered public inputs", label(s)),
                Err(e) => println!(
                    "NEG|{name}|{}|public|honest proof, altered public input|VERIFIER rejects: {}",
                    label(s),
                    short(&e)
                ),
            }
        }
    }
}

fn bump(d: &Digest, i: usize) -> Digest {
    let mut d = *d;
    d[i] += Felt::ONE;
    d
}

// ---- witnesses -----------------------------------------------------------------------------------

/// Two real inputs in one tree.
fn two_real(seed: u64) -> JoinSplit {
    sample(Kind::Transfer, seed)
}

/// One real input at position `i`, a dummy at the other.
fn one_real(i: usize, seed: u64) -> JoinSplit {
    let mut js = sample(Kind::Transfer1, seed);
    if i == 1 {
        js.inputs.swap(0, 1);
    }
    js.check().unwrap();
    js
}

/// Puts the enabled inputs (as they now are) into a fresh tree and updates paths and anchor.
fn retree(js: &mut JoinSplit) {
    let mut tree = SparseTree::new();
    let mut rng = TestRng(0x7ee);
    for _ in 0..3 {
        tree.insert(rng.next_u64() as u32, rng.digest());
    }
    for inp in js.inputs.iter().filter(|i| i.enabled) {
        tree.insert(inp.index, inp.note().commitment());
    }
    for inp in js.inputs.iter_mut().filter(|i| i.enabled) {
        inp.path = tree.path(inp.index);
    }
    js.anchor = tree.root();
}

fn build(inp: &TraceInputs, ov: &Overrides) -> Trace {
    build_trace(inp, ov)
}

/// SHIELD-3 adaptation. A forged trace that CLAIMS other public nullifiers than the ones it
/// computes must also feed the claimed pair into the two rho hashes (the AIR pins their input to
/// the public values) and publish the output commitments that follow from it; otherwise the rho
/// links fire as well and the case no longer isolates the constraint under test. Sets
/// `ov.rho_nf` to `pi.nf`, rebuilds, and re-reads `pi.cm_out` from the trace (honest schedule).
fn claim_nf(inp: &TraceInputs, ov: &mut Overrides, pi: &mut PublicInputs) {
    ov.rho_nf = Some(pi.nf);
    let t = build_trace(inp, ov);
    pi.cm_out = [digest_at(&t, out_row(c_out(0) + 1)), digest_at(&t, out_row(c_out(1) + 1))];
}

fn no_ov() -> Overrides {
    Overrides::default()
}

fn inp_of(js: &JoinSplit) -> TraceInputs {
    TraceInputs::honest(js)
}

fn recarry(inp: &mut TraceInputs, js: &JoinSplit) {
    (inp.ka, inp.kb) = carries(&inp.a, &inp.b, js.v_in, js.v_out, js.fee);
}

fn u64_of(l: &[Felt; NUM_LIMBS]) -> u64 {
    (0..NUM_LIMBS).map(|j| (l[j].as_canonical_u32() as u64) << (16 * j)).sum()
}

fn in_name(i: usize) -> String {
    format!("input {}", i + 1)
}

// ---- 1. wrong anchor ----------------------------------------------------------------------------

#[test]
fn n01_wrong_anchor() {
    let js = two_real(21);
    let mut pi = js.public();
    pi.anchor = bump(&pi.anchor, 0);
    must_reject_public(&js, &[("wrong anchor (a)".into(), pi.clone())]);
    // the prover itself claims the wrong anchor for an otherwise valid trace
    must_reject_forced("wrong anchor (b) forced claim", &|| honest_trace(&js), &pi, Expect::Exactly(&[TC_ANCHOR]));

    // a note that is NOT in the tree, proven against the real root (each input in turn)
    for i in 0..2 {
        let mut other = js.clone();
        other.inputs[i].r = bump(&other.inputs[i].r, 3);
        assert!(other.check().is_err());
        must_reject_forced(
            &format!("{}: note not in tree, real root claimed", in_name(i)),
            &|| honest_trace(&other),
            &other.public(),
            Expect::Within(&range(TC_ANCHOR, 8)),
        );
    }
}

// ---- 2. flipped sibling ---------------------------------------------------------------------------

#[test]
fn n02_flipped_sibling() {
    let js = two_real(22);
    for i in 0..2 {
        for level in [0usize, 17, 31] {
            let mut inp = inp_of(&js);
            inp.siblings[i][level][2] += Felt::ONE;
            must_reject_forced(
                &format!("{}: flipped sibling at level {level}", in_name(i)),
                &|| build(&inp, &no_ov()),
                &js.public(),
                Expect::Within(&range(TC_ANCHOR, 8)),
            );
        }
        // forge the top hash output so that the anchor check passes anyway
        let mut inp = inp_of(&js);
        inp.siblings[i][31][0] += Felt::ONE;
        let mut ov = no_ov();
        for k in 0..DIGEST {
            ov.cells.push((S + k, out_row(c_in(i) + BLOCK - 1), js.anchor[k]));
        }
        must_reject_forced(
            &format!("{}: flipped sibling + forged root row", in_name(i)),
            &|| build(&inp, &ov),
            &js.public(),
            Expect::Within(&range(TC_ROUND, 24)),
        );
    }
}

// ---- 3. wrong position bit --------------------------------------------------------------------------

#[test]
fn n03_wrong_position_bit() {
    let js = two_real(23);
    for i in 0..2 {
        // (a) one bit flipped: the trace hashes in the other order and reaches another root
        for level in [0usize, 9, 31] {
            let mut inp = inp_of(&js);
            inp.pos_bits[i][level] = Felt::ONE - inp.pos_bits[i][level];
            must_reject_forced(
                &format!("{}: position bit {level} flipped", in_name(i)),
                &|| build(&inp, &no_ov()),
                &js.public(),
                Expect::Within(&range(TC_ANCHOR, 8)),
            );
        }

        // (b) ordering: the P column says "left" but the node is hashed on the right. The other
        // input is a dummy and the claimed anchor is whatever this trace computes, so ONLY the
        // left/right link constraint is violated.
        let one = one_real(i, 23);
        let mk0 = c_in(i) + O_MK0;
        let level = (0..TREE_DEPTH).find(|l| (one.inputs[i].index >> l) & 1 == 0).unwrap();
        let base = honest_trace(&one);
        let honest_init = state_at(&base, first_row(mk0 + level));
        let mut swapped = honest_init;
        for k in 0..DIGEST {
            swapped[k] = honest_init[DIGEST + k];
            swapped[DIGEST + k] = honest_init[k];
        }
        let mut ov = no_ov();
        ov.init.insert(mk0 + level, swapped);
        let inp = inp_of(&one);
        let pi = public_inputs_from_trace(&build(&inp, &ov), i, &one);
        assert_ne!(pi.anchor, one.anchor);
        must_reject_forced(
            &format!("{}: order swapped against position bit", in_name(i)),
            &|| build(&inp, &ov),
            &pi,
            Expect::Exactly(&range(TC_LINK, 8)),
        );

        // (c) non-boolean position value: P = 2 with (left, right) chosen so the mux equation
        // holds (-(left - cur) + 2 (right - cur) = 0). Only the booleanity constraint is violated.
        let level = 5;
        let cur = digest_at(&base, out_row(mk0 + level - 1));
        let mut rng = TestRng(555);
        let left = rng.digest();
        let two_inv = Felt::TWO.inverse();
        let right: Digest = core::array::from_fn(|k| (cur[k] + left[k]) * two_inv);
        let mut inp = inp_of(&one);
        inp.pos_bits[i][level] = Felt::TWO;
        let mut ov = no_ov();
        ov.init.insert(mk0 + level, fresh(LEN_PAIR, D_MK, &left, &right));
        let pi = public_inputs_from_trace(&build(&inp, &ov), i, &one);
        must_reject_forced(
            &format!("{}: non-boolean position value (P = 2)", in_name(i)),
            &|| build(&inp, &ov),
            &pi,
            Expect::Exactly(&[TC_P_BOOL]),
        );
    }
}

// ---- 4. wrong sk (ownership) ---------------------------------------------------------------------------

#[test]
fn n04_wrong_spending_key() {
    let js = two_real(24);
    let mut rng = TestRng(4444);
    let thief_sk = rng.digest();
    for i in 0..2 {
        let blk = c_in(i);
        // (a) a different sk with everything derived honestly from it: nf and root both differ
        let mut inp = inp_of(&js);
        inp.sk[i] = thief_sk;
        // (SHIELD-3: the rho hashes absorb the CLAIMED nullifiers, so the outputs are the victim
        // transaction's and only the nf / anchor comparisons can object)
        let ov_claim = Overrides { rho_nf: Some(js.public().nf), ..no_ov() };
        must_reject_forced(
            &format!("{}: wrong sk, claims the victim's nf and anchor", in_name(i)),
            &|| build(&inp, &ov_claim),
            &js.public(),
            Expect::Within(&cat(&range(TC_NF, 8), &range(TC_ANCHOR, 8))),
        );

        // (b) ownership bypass: the thief knows the victim's note (value, pk, rho, r) and path but
        // not sk. He feeds the victim's pk straight into the commitment hash instead of
        // H(D_PK; sk'), and publishes the nullifier his own key produces. The anchor is the REAL
        // root; only the pk -> commitment link is violated.
        let victim_pk = derive_pk(&js.inputs[i].sk);
        let mut ov = no_ov();
        ov.init.insert(blk + O_CM1, fresh(LEN_CM, D_CM, &victim_pk, &js.inputs[i].rho));
        let pi = public_inputs_from_trace(&build(&inp, &ov), i, &js);
        assert_eq!(pi.anchor, js.anchor, "the forged trace must open the real tree");
        assert_ne!(pi.nf[i], js.public().nf[i]);
        must_reject_forced(
            &format!("{}: ownership bypass: victim pk injected, real root", in_name(i)),
            &|| build(&inp, &ov),
            &pi,
            Expect::Exactly(&range(TC_LINK, 8)),
        );

        // (c) two different keys: one for the nullifier-key hash, another in the register used for pk
        let mut ov = no_ov();
        ov.init.insert(blk + O_NK, fresh(LEN_KEY, D_NK, &thief_sk, &ZERO_DIGEST));
        let inp = inp_of(&js);
        let pi = public_inputs_from_trace(&build(&inp, &ov), i, &js);
        assert_eq!(pi.anchor, js.anchor);
        must_reject_forced(
            &format!("{}: nk derived from a different key than pk (hash input)", in_name(i)),
            &|| build(&inp, &ov),
            &pi,
            Expect::Exactly(&range(TC_LINK, 8)),
        );

        // (d) the same double-spend attempt through the REGISTER: the sk register holds another
        // key during the NK cycle and the real key afterwards, so every link is satisfied and the
        // note gets a second nullifier. Only "sk may change only at a block boundary" is violated.
        let mut ov = no_ov();
        ov.init.insert(blk + O_NK, fresh(LEN_KEY, D_NK, &thief_sk, &ZERO_DIGEST));
        for r in first_row(blk + O_NK)..=out_row(blk + O_NK) {
            for k in 0..DIGEST {
                ov.cells.push((SK + k, r, thief_sk[k]));
            }
        }
        let pi = public_inputs_from_trace(&build(&inp, &ov), i, &js);
        assert_eq!(pi.anchor, js.anchor);
        assert_ne!(pi.nf[i], js.public().nf[i]);
        must_reject_forced(
            &format!("{}: sk register switched after the nk hash (second nullifier)", in_name(i)),
            &|| build(&inp, &ov),
            &pi,
            Expect::Exactly(&range(TC_SWITCH, 8)),
        );
    }
}

// ---- 5. nullifier ------------------------------------------------------------------------------------------

#[test]
fn n05_nullifier() {
    let js = two_real(25);
    let good = js.public();
    let mut altered = Vec::new();
    for i in 0..2 {
        let mut pi = good.clone();
        pi.nf[i] = bump(&pi.nf[i], 1);
        altered.push((format!("public nf{} altered (a)", i + 1), pi));
    }
    let swapped = PublicInputs { nf: [good.nf[1], good.nf[0]], ..good.clone() };
    altered.push(("public nf1 / nf2 swapped (a)".into(), swapped.clone()));
    must_reject_public(&js, &altered);
    // SHIELD-3: (b0) the unchanged honest trace against the altered claim now violates the rho
    // links as well (the rho hashes absorbed the true nullifiers) ...
    must_reject_forced(
        "public nf1 / nf2 swapped (b0) forced claim, honest trace",
        &|| honest_trace(&js),
        &swapped,
        Expect::Both(&[TC_NF], &cat(&range(TC_NF, 8), &range(TC_LINK, 16))),
    );
    // ... (b) and with the rho hashes fed the claimed pair (and the outputs that follow from it),
    // only the nullifier comparison objects, as in SHIELD-2
    let (mut swapped, mut ov_sw) = (swapped, no_ov());
    claim_nf(&inp_of(&js), &mut ov_sw, &mut swapped);
    must_reject_forced(
        "public nf1 / nf2 swapped (b) forced claim",
        &|| build(&inp_of(&js), &ov_sw),
        &swapped,
        Expect::Within(&range(TC_NF, 8)),
    );

    let mut rng = TestRng(5555);
    for i in 0..2 {
        let blk = c_in(i);
        let (mut claim, mut ov_cl) = (altered[i].1.clone(), no_ov());
        claim_nf(&inp_of(&js), &mut ov_cl, &mut claim);
        must_reject_forced(
            &format!("public nf{} altered (b) forced claim", i + 1),
            &|| build(&inp_of(&js), &ov_cl),
            &claim,
            Expect::Exactly(&[TC_NF + 1]),
        );

        // (c) a second nullifier for the same note (double-spend attempt): the nullifier hash
        // absorbs another rho than the one in the commitment. Real root; only the rho link.
        let nk = derive_nk(&js.inputs[i].sk);
        let rho2 = rng.digest();
        let inp = inp_of(&js);
        let mut ov = no_ov();
        ov.init.insert(blk + O_NF, fresh(LEN_PAIR, D_NF, &nk, &rho2));
        let pi = public_inputs_from_trace(&build(&inp, &ov), i, &js);
        assert_eq!(pi.anchor, js.anchor);
        assert_ne!(pi.nf[i], good.nf[i]);
        must_reject_forced(
            &format!("{}: second nullifier from another rho (hash input), real root", in_name(i)),
            &|| build(&inp, &ov),
            &pi,
            Expect::Exactly(&range(TC_LINK + DIGEST, 8)),
        );

        // (c2) the same through the REGISTER: rho register holds rho2 during the NK and NF cycles
        // and the real rho afterwards. Only the register rule is violated.
        for r in first_row(blk + O_NK)..=out_row(blk + O_NF) {
            for k in 0..DIGEST {
                ov.cells.push((RHO + k, r, rho2[k]));
            }
        }
        let pi2 = public_inputs_from_trace(&build(&inp, &ov), i, &js);
        assert_eq!(pi2, pi);
        must_reject_forced(
            &format!("{}: rho register switched after the nf hash (second nullifier)", in_name(i)),
            &|| build(&inp, &ov),
            &pi,
            Expect::Exactly(&range(TC_SWITCH + DIGEST, 8)),
        );

        // (d) the nullifier hash absorbs another nk than H(D_NK; sk)
        let nk2 = rng.digest();
        let mut ov = no_ov();
        ov.init.insert(blk + O_NF, fresh(LEN_PAIR, D_NF, &nk2, &js.inputs[i].rho));
        let pi = public_inputs_from_trace(&build(&inp, &ov), i, &js);
        must_reject_forced(
            &format!("{}: nullifier from another nk", in_name(i)),
            &|| build(&inp, &ov),
            &pi,
            Expect::Exactly(&range(TC_LINK, 8)),
        );

        // (e) the nullifier hash uses another domain tag
        let mut ov = no_ov();
        ov.init.insert(blk + O_NF, fresh(LEN_PAIR, D_NK, &nk, &js.inputs[i].rho));
        let pi = public_inputs_from_trace(&build(&inp, &ov), i, &js);
        must_reject_forced(
            &format!("{}: nullifier with another domain tag", in_name(i)),
            &|| build(&inp, &ov),
            &pi,
            Expect::Exactly(&[TC_LINK + CAP + 1]),
        );
    }

    // a DUMMY's nullifier is checked exactly like a real one
    let sh = sample(Kind::Shield, 25);
    for i in 0..2 {
        let mut pi = sh.public();
        pi.nf[i] = bump(&pi.nf[i], 6);
        let mut ov_cl = no_ov();
        claim_nf(&inp_of(&sh), &mut ov_cl, &mut pi);
        must_reject_forced(
            &format!("dummy {}: another nullifier claimed than H(nk, rho)", in_name(i)),
            &|| build(&inp_of(&sh), &ov_cl),
            &pi,
            Expect::Exactly(&[TC_NF + 6]),
        );
    }
}

// ---- 6. commitments and the values they carry ---------------------------------------------------------------------

#[test]
fn n06_commitments() {
    let js = two_real(26);
    let good = js.public();
    let mut altered = Vec::new();
    for j in 0..2 {
        let mut pi = good.clone();
        pi.cm_out[j] = bump(&pi.cm_out[j], 7);
        altered.push((format!("public cm_out{} altered (a)", j + 1), pi));
    }
    let swapped = PublicInputs { cm_out: [good.cm_out[1], good.cm_out[0]], ..good.clone() };
    altered.push(("public cm_out1 / cm_out2 swapped (a)".into(), swapped.clone()));
    must_reject_public(&js, &altered);
    must_reject_forced(
        "public cm_out1 / cm_out2 swapped (b) forced claim",
        &|| honest_trace(&js),
        &swapped,
        Expect::Within(&range(TC_CMOUT, 8)),
    );

    let base = honest_trace(&js);
    let inp = inp_of(&js);
    for j in 0..2 {
        must_reject_forced(
            &format!("public cm_out{} altered (b) forced claim", j + 1),
            &|| honest_trace(&js),
            &altered[j].1,
            Expect::Exactly(&[TC_CMOUT + 7]),
        );

        // (c) the commitment hashes a LARGER value than the one in the balance registers
        let bigger = js.outputs[j].value + 1_000_000_000;
        let mut ov = no_ov();
        ov.init.insert(c_out(j) + 1, second_block(&state_at(&base, out_row(c_out(j))), &limbs(bigger), &js.outputs[j].r));
        let pi = public_inputs_from_trace(&build(&inp, &ov), 0, &js);
        assert_eq!(pi.cm_out[j], Note { value: bigger, ..js.output_note(j) }.commitment(), "commits to the larger value");
        must_reject_forced(
            &format!("output {}: cm_out commits to more than is balanced", j + 1),
            &|| build(&inp, &ov),
            &pi,
            Expect::Within(&range(TC_LINK, NUM_LIMBS)),
        );

        // (d) cross-wiring: output j's commitment absorbs the OTHER output's balance register
        assert_ne!(inp.b[0], inp.b[1]);
        let mut ov = no_ov();
        ov.init.insert(c_out(j) + 1, second_block(&state_at(&base, out_row(c_out(j))), &inp.b[1 - j], &js.outputs[j].r));
        let pi = public_inputs_from_trace(&build(&inp, &ov), 0, &js);
        must_reject_forced(
            &format!("output {}: commitment absorbs the other output's value register", j + 1),
            &|| build(&inp, &ov),
            &pi,
            Expect::Within(&range(TC_LINK, NUM_LIMBS)),
        );
    }

    // (e) MINT through an input: the balance register of input i holds more than the note that
    // is in the tree. The input commitment hashes the true value (so the root is the real one),
    // the outputs are enlarged to match the inflated register and the balance equations hold.
    for i in 0..2 {
        let extra = 5_000_000_000u64;
        let mut inp = inp_of(&js);
        inp.a[i] = limbs(js.inputs[i].value + extra);
        inp.b[0] = limbs(js.outputs[0].value + extra);
        recarry(&mut inp, &js);
        let mut ov = no_ov();
        ov.init.insert(c_in(i) + O_CM2, state_at(&base, first_row(c_in(i) + O_CM2)));
        let pi = public_inputs_from_trace(&build(&inp, &ov), i, &js);
        assert_eq!(pi.anchor, js.anchor, "the real tree is opened");
        must_reject_forced(
            &format!("{}: balance register larger than the committed value (mint)", in_name(i)),
            &|| build(&inp, &ov),
            &pi,
            Expect::Within(&range(TC_LINK, NUM_LIMBS)),
        );
    }
    // (f) the same with the OTHER input's value: input 2's commitment is checked against A1
    let mut inp = inp_of(&js);
    inp.a.swap(0, 1);
    let mut ov = no_ov();
    for i in 0..2 {
        ov.init.insert(c_in(i) + O_CM2, state_at(&base, first_row(c_in(i) + O_CM2)));
    }
    assert_ne!(inp.a[0], inp.a[1]);
    must_reject_forced(
        "inputs: value registers A1 / A2 exchanged against the commitments",
        &|| build(&inp, &ov),
        &js.public(),
        Expect::Within(&range(TC_LINK, NUM_LIMBS)),
    );
}

// ---- 7. balance --------------------------------------------------------------------------------------------------

#[test]
fn n07_balance() {
    let js = two_real(27);
    // every note is honest and in the tree; only the amounts do not add up
    for (which, delta) in [(0usize, 1i64), (0, -1), (1, 1), (1, -1), (2, 1), (2, -1), (3, 1), (3, -1)] {
        let mut bad = js.clone();
        let name = if which < 2 {
            bad.inputs[which].value = (bad.inputs[which].value as i64 + delta) as u64;
            retree(&mut bad);
            format!("balance: input {} value {delta:+}", which + 1)
        } else {
            bad.outputs[which - 2].value = (bad.outputs[which - 2].value as i64 + delta) as u64;
            format!("balance: output {} value {delta:+}", which - 1)
        };
        assert!(bad.check().unwrap_err().starts_with("balance"));
        must_reject_forced(
            &format!("{name} (all commitments consistent)"),
            &|| honest_trace(&bad),
            &bad.public(),
            Expect::Within(&range(TC_BAL, NUM_LIMBS)),
        );
    }

    let p = js.public();
    let un = sample(Kind::Unshield2, 27);
    let q = un.public();
    must_reject_public(
        &js,
        &[
            ("balance: public fee - 1".into(), PublicInputs { fee: p.fee - 1, ..p.clone() }),
            ("balance: public fee + 1".into(), PublicInputs { fee: p.fee + 1, ..p.clone() }),
            ("balance: public v_out + 1".into(), PublicInputs { v_out: p.v_out + 1, ..p.clone() }),
            ("balance: public v_in + 1".into(), PublicInputs { v_in: p.v_in + 1, ..p.clone() }),
            ("balance: public v_in and v_out + 1".into(), PublicInputs { v_in: 1, v_out: 1, ..p.clone() }),
            ("balance: public v_out + 2^16".into(), PublicInputs { v_out: p.v_out + (1 << 16), ..p.clone() }),
            ("balance: public v_out + 2^32".into(), PublicInputs { v_out: p.v_out + (1 << 32), ..p.clone() }),
            ("balance: public v_out + 2^48".into(), PublicInputs { v_out: p.v_out + (1 << 48), ..p.clone() }),
        ],
    );
    must_reject_public(
        &un,
        &[
            ("unshield: public v_out + 1 after proving".into(), PublicInputs { v_out: q.v_out + 1, ..q.clone() }),
            ("unshield: public v_out - 1 after proving".into(), PublicInputs { v_out: q.v_out - 1, ..q.clone() }),
            ("unshield: fee moved into v_out after proving".into(), PublicInputs { v_out: q.v_out + q.fee, fee: 0, ..q.clone() }),
        ],
    );

    // a carry outside {-3..2}
    let mut inp = inp_of(&js);
    inp.ka[0] = Felt::from_u32(7);
    must_reject_forced(
        "balance: carry out of range (KA = 7)",
        &|| build(&inp, &no_ov()),
        &js.public(),
        Expect::Exactly(&[TC_BAL, TC_BAL + 1, TC_KA]),
    );
    let mut inp = inp_of(&js);
    inp.kb[1] = Felt::from_u32(2);
    must_reject_forced(
        "balance: carry out of range (KB = 2)",
        &|| build(&inp, &no_ov()),
        &js.public(),
        Expect::Exactly(&[TC_BAL + 1, TC_BAL + 2, TC_KB + 1]),
    );
    // the right carry, encoded outside the allowed digits (KA + 2, KB - 1): the balance holds
    let mut inp = inp_of(&js);
    inp.ka[2] += Felt::TWO;
    inp.kb[2] -= Felt::ONE;
    must_reject_forced(
        "balance: carry encoded with out-of-range digits",
        &|| build(&inp, &no_ov()),
        &js.public(),
        Expect::Within(&[TC_KA + 2, TC_KB + 2]),
    );
}

// ---- 8. wrap-around / overflow --------------------------------------------------------------------------------------

#[test]
fn n08_wrap_around() {
    let js = two_real(28);
    let total = js.inputs[0].value + js.inputs[1].value;
    let lim = |v: u64, j: usize| ((v >> (16 * j)) & 0xffff) as i64;

    for j in 0..2 {
        // (a) unshield one quantum more than the inputs hold; output j has low limb -1 mod p and
        // the other output is zero. All four balance equations hold in the field. Only the 16-bit
        // range check stands in the way.
        let mut w = js.clone();
        (w.v_in, w.fee, w.v_out) = (0, 0, total + 1);
        let mut inp = inp_of(&w);
        inp.b = [[Felt::ZERO; NUM_LIMBS]; 2];
        inp.b[j][0] = -Felt::ONE;
        (inp.ka, inp.kb) = carries_from_net(core::array::from_fn(|l| {
            lim(w.inputs[0].value, l) + lim(w.inputs[1].value, l) + (l == 0) as i64 - lim(w.v_out, l)
        }));
        let pi = public_inputs_from_trace(&build(&inp, &no_ov()), 0, &w);
        assert_eq!(pi.anchor, js.anchor);
        must_reject_forced(
            &format!("output {}: field wrap, limb = -1 mod p", j + 1),
            &|| build(&inp, &no_ov()),
            &pi,
            Expect::Exactly(&[TC_YLIMB]),
        );

        // (b) same attack, range check "satisfied" with a non-boolean bit: the last bit of the
        // segment of that limb is -1. Only the bit-booleanity constraint is violated.
        let seg = NUM_LIMBS * j;
        let mut ov = no_ov();
        for rep in 0..TRACE_LEN / RANGE_PERIOD {
            ov.cells.push((BITY, rep * RANGE_PERIOD + seg * LIMB_BITS + LIMB_BITS - 1, -Felt::ONE));
        }
        must_reject_forced(
            &format!("output {}: field wrap + non-boolean range bit", j + 1),
            &|| build(&inp, &ov),
            &pi,
            Expect::Exactly(&[TC_YBIT]),
        );

        // (b2) same attack, range check "satisfied" by a jump in the accumulator: on the last row
        // of the segment ACC = -1 and BIT = 1, so 2 ACC + BIT = -1. Only the recurrence is violated.
        let mut ov = no_ov();
        for rep in 0..TRACE_LEN / RANGE_PERIOD {
            let row = rep * RANGE_PERIOD + seg * LIMB_BITS + LIMB_BITS - 1;
            ov.cells.push((BITY, row, Felt::ONE));
            ov.cells.push((ACCY, row, -Felt::ONE));
        }
        must_reject_forced(
            &format!("output {}: field wrap + accumulator jump", j + 1),
            &|| build(&inp, &ov),
            &pi,
            Expect::Exactly(&[TC_YACC]),
        );

        // (c) a 17-bit limb: limb0 + 2^16 with limb1 - 1 is the same integer, but not a canonical
        // encoding; refused by the range check
        let mut w = js.clone();
        w.outputs[j].value = 0x0003_0002_0001;
        w.outputs[1 - j].value = total - w.fee - w.outputs[j].value;
        w.check().unwrap();
        let mut inp = inp_of(&w);
        assert_ne!(inp.b[j][1], Felt::ZERO);
        inp.b[j][0] += Felt::from_u32(1 << 16);
        inp.b[j][1] -= Felt::ONE;
        recarry(&mut inp, &w);
        let pi = public_inputs_from_trace(&build(&inp, &no_ov()), 0, &w);
        must_reject_forced(
            &format!("output {}: oversized (17-bit) limb", j + 1),
            &|| build(&inp, &no_ov()),
            &pi,
            Expect::Exactly(&[TC_YLIMB]),
        );
    }

    // (d) sums that balance only modulo 2^64. Both inputs hold 2^64 - 1 (real notes in the tree);
    // the prover claims the sum mod 2^64 as output 1.
    let mut w = js.clone();
    w.inputs[0].value = u64::MAX;
    w.inputs[1].value = u64::MAX;
    retree(&mut w);
    (w.v_in, w.v_out, w.fee) = (0, 0, 0);
    w.outputs[0].value = u64::MAX.wrapping_add(u64::MAX);
    w.outputs[1].value = 0;
    assert!(w.check().is_err());
    must_reject_forced(
        "sum of the two inputs wraps modulo 2^64",
        &|| honest_trace(&w),
        &w.public(),
        Expect::Exactly(&[TC_BAL + 3]),
    );
    // the same with v_in and one real input
    let mut w = one_real(0, 28);
    w.inputs[0].value = u64::MAX;
    retree(&mut w);
    (w.v_in, w.v_out, w.fee) = (u64::MAX, 0, 0);
    w.outputs[0].value = 0;
    w.outputs[1].value = u64::MAX.wrapping_add(u64::MAX);
    must_reject_forced(
        "input + v_in wraps modulo 2^64",
        &|| honest_trace(&w),
        &w.public(),
        Expect::Exactly(&[TC_BAL + 3]),
    );
    // outputs: 2^64 created on the right side (out1 + out2 = in + 2^64)
    let mut w = one_real(0, 28);
    (w.v_in, w.v_out, w.fee) = (0, 0, 0);
    w.outputs[0].value = u64::MAX;
    w.outputs[1].value = w.inputs[0].value.wrapping_sub(u64::MAX);
    assert_eq!(w.outputs[0].value.wrapping_add(w.outputs[1].value), w.inputs[0].value);
    must_reject_forced(
        "sum of the two outputs wraps modulo 2^64",
        &|| honest_trace(&w),
        &w.public(),
        Expect::Exactly(&[TC_BAL + 3]),
    );

    for i in 0..2 {
        // (e) input-note limb out of range (limb3 + 2^16): a note whose commitment encodes a
        // 65-bit value. The other input is a dummy; the anchor is this trace's own root.
        let one = one_real(i, 28);
        let mut inp = inp_of(&one);
        inp.a[i][3] += Felt::from_u32(1 << 16);
        let pi = public_inputs_from_trace(&build(&inp, &no_ov()), i, &one);
        must_reject_forced(
            &format!("{}: value limb above 16 bits", in_name(i)),
            &|| build(&inp, &no_ov()),
            &pi,
            Expect::Contains(&[TC_XLIMB]),
        );

        // (f) an input note whose low limb is -1 mod p, balanced in the field by an output with
        // low limb 0xffff and a borrow. Only the input range check is violated.
        let v = 0x0000_0012_0007_0005u64;
        let mut w = one.clone();
        w.inputs[i].value = v;
        (w.v_in, w.v_out, w.fee) = (0, 0, 0);
        let mut inp = inp_of(&w);
        inp.a[i][0] = -Felt::ONE;
        inp.b[1] = [Felt::ZERO; NUM_LIMBS];
        inp.b[0] = limbs((v & !0xffff_ffff) | ((lim(v, 1) as u64 - 1) << 16) | 0xffff);
        (inp.ka, inp.kb) = carries_from_net(core::array::from_fn(|l| {
            (if l == 0 { -1 } else { lim(v, l) }) - (u64_of(&inp.b[0]) >> (16 * l) & 0xffff) as i64
        }));
        let pi = public_inputs_from_trace(&build(&inp, &no_ov()), i, &w);
        must_reject_forced(
            &format!("{}: field wrap, value limb = -1 mod p", in_name(i)),
            &|| build(&inp, &no_ov()),
            &pi,
            Expect::Exactly(&[TC_XLIMB]),
        );
    }
}

// ---- 9. binding ----------------------------------------------------------------------------------------------------------

#[test]
fn n09_altered_binding() {
    let js = two_real(29);
    let altered: Vec<(String, PublicInputs)> = (0..DIGEST)
        .map(|i| {
            let mut pi = js.public();
            pi.binding = bump(&pi.binding, i);
            (format!("binding element {i} altered"), pi)
        })
        .collect();
    must_reject_public(&js, &altered);
}

// ---- 10. flipped proof bits -------------------------------------------------------------------------------------------------
//
// Each mutated proof is checked in a CHILD PROCESS (this test binary re-executed) with a capped
// address space, so that a panic or an abort inside the deserialiser or the verifier is recorded
// instead of taking the test run down.

const CHILD_ENV: &str = "SHIELD_V2_FLIP_CHILD";

fn flip_setups() -> Vec<(&'static str, Setup, usize)> {
    vec![("q2-b3-on", Setup, 1100)]
}

/// Child side. Exit codes: 10 deserialisation error, 11 verifier error, 12 ACCEPTED, 13 height
/// pin, 14 nullifier check, 15 length cap, 16 non-canonical encoding (SHIELD-3), 17 unknown,
/// 18 a panic inside the library caught by `verify_spend`.
#[test]
fn n10_child() {
    let Ok(spec) = std::env::var(CHILD_ENV) else { return };
    let mut it = spec.split(',');
    let (file, pos, name) = (it.next().unwrap(), it.next().unwrap(), it.next().unwrap());
    let pos: usize = pos.parse().unwrap();
    let s = flip_setups().into_iter().find(|(n, _, _)| *n == name).unwrap().1;
    let mut b = std::fs::read(file).unwrap();
    b[pos] ^= 1 << (pos % 8);
    let pi = PublicInputs::from_bytes(&std::fs::read(format!("{file}.pub")).unwrap()).unwrap();
    let code = match verify_spend_with(&s, &pi, &b) {
        Err(e) => match kind(&e) {
            "Decode" => 10,
            "Stark" => 11,
            "DegreeBits" => 13,
            "DuplicateNullifier" => 14,
            "TooLong" => 15,
            "NonCanonicalEncoding" => 16,
            "Panicked" => 18,
            _ => 17,
        },
        Ok(()) => 12,
    };
    std::process::exit(code);
}

#[test]
fn n10_flipped_proof_bits() {
    use std::os::unix::process::ExitStatusExt;
    if std::env::var(CHILD_ENV).is_ok() {
        return;
    }
    let js = two_real(30);
    let exe = std::env::current_exe().unwrap();
    let mut total = 0;
    for (name, s, spread) in flip_setups() {
        let bytes = prove_trace(&s, honest_trace(&js), &js.public(), blind(1000)).unwrap();
        verify_spend_with(&s, &js.public(), &bytes).unwrap();
        let file = format!("{}/flip_{name}.proof", env!("CARGO_TARGET_TMPDIR"));
        std::fs::write(&file, &bytes).unwrap();
        std::fs::write(format!("{file}.pub"), js.public().to_bytes()).unwrap();

        let mut positions: BTreeSet<usize> = (0..64).collect();
        positions.extend(bytes.len() - 64..bytes.len());
        positions.extend((0..spread).map(|i| i * bytes.len() / spread));
        let (mut parse_fail, mut verify_fail, mut pin_fail, mut noncanon) = (0, 0, 0, 0);
        let (mut accepted, mut panicked, mut aborted) = (vec![], vec![], vec![]);
        for &pos in &positions {
            let status = std::process::Command::new("sh")
                .arg("-c")
                .arg("ulimit -v 1500000; exec \"$0\" --exact n10_child --test-threads=1 >/dev/null 2>&1")
                .arg(&exe)
                .env(CHILD_ENV, format!("{file},{pos},{name}"))
                .status()
                .unwrap();
            match (status.code(), status.signal()) {
                (Some(10), _) => parse_fail += 1,
                (Some(11), _) => verify_fail += 1,
                (Some(13), _) => pin_fail += 1,
                (Some(16), _) => noncanon += 1,
                (Some(12), _) => accepted.push(pos),
                (Some(101), _) | (Some(18), _) => panicked.push(pos),
                (None, Some(_)) => aborted.push(pos),
                other => panic!("unexpected child status {other:?} at byte {pos}"),
            }
        }
        std::fs::remove_file(&file).ok();
        std::fs::remove_file(format!("{file}.pub")).ok();
        total += positions.len();
        println!(
            "NEG|flipped proof bit|{}|flips|{} single-bit flips over {} bytes|clean refusals {} (deserialisation error {parse_fail}, non-canonical encoding {noncanon}, height pin {pin_fail}, verifier error {verify_fail}); PANIC {} at offsets {:?}; PROCESS ABORT {} at offsets {:?}; ACCEPTED {} {:?}",
            label(&s),
            positions.len(),
            bytes.len(),
            parse_fail + verify_fail + pin_fail + noncanon,
            panicked.len(),
            panicked,
            aborted.len(),
            aborted,
            accepted.len(),
            accepted
        );
        assert!(accepted.is_empty(), "flipped bits accepted at {accepted:?}");
        assert!(panicked.is_empty() && aborted.is_empty(), "panics at {panicked:?}, aborts at {aborted:?}");
    }
    println!("NEG|flipped proof bit|all|flips|total single-bit flips: {total}");
    assert!(total >= 1200);
}

// ---- 12. another trace height ------------------------------------------------------------------------------------------

#[test]
fn n12_other_height() {
    let js = two_real(32);
    let pi = js.public();
    // a valid proof for an 8,192-row trace (the same schedule followed by 128 more padding cycles)
    let s = Setup;
    let trace = build_trace_with(&inp_of(&js), &no_ov(), &Schedule::HONEST, 2 * TRACE_LEN);
    assert!(check_all_constraints(&JoinSplitAir::new(), &trace, &pi.to_values(), Some(1)).is_ok());
    // SHIELD-3: a proof of the larger trace can exceed the 200,000-byte cap (201,003 B seen in the
    // research for this configuration). This crate's prover refuses to hand out such a proof, and
    // `verify_spend` would refuse it as TooLong before the height pin; a proof that fits the cap
    // reaches the pin and is refused as DegreeBits. Either way the shipped verifier refuses it.
    match prove_trace(&s, trace, &pi, blind(14)) {
        Err(e) => {
            assert!(e.contains("above the verifier's cap"), "{e}");
            println!("NEG|proof for an 8192-row trace|{}|pin|the prover refuses to emit it: {e}", label(&s));
        }
        Ok(bytes) => {
            assert!(bytes.len() <= MAX_PROOF_BYTES);
            let shipped = verify_spend_with(&s, &pi, &bytes);
            assert!(matches!(&shipped, Err(e) if kind(e) == "DegreeBits"), "{shipped:?}");
            let library = library_only(&pi, &bytes);
            println!(
                "NEG|proof for an 8192-row trace|{}|pin|valid proof of another height ({} B)|verify_spend rejects: {:?}; library verifier alone: {}",
                label(&s),
                bytes.len(),
                shipped.unwrap_err(),
                match library {
                    Some(true) => "ACCEPTS (the height pin is necessary)",
                    Some(false) => "rejects",
                    None => "not available",
                }
            );
        }
    }
}

// ---- 13. forged hash state, changing registers ------------------------------------------------------------------------------------

#[test]
fn n13_forged_hash_state_and_registers() {
    let js = two_real(33);
    let inp = inp_of(&js);
    let base = honest_trace(&js);
    for (cycle, row, col) in [
        (c_in(0) + O_NK, 5usize, 0usize),
        (c_in(0) + O_MK0 + 13, 17, 9),
        (c_in(1) + O_CM2, 2, 4),
        (c_in(1) + O_MK0 + 31, 30, 1),
        (c_out(0) + 1, 29, 23),
        (c_out(1), 3, 11),
    ] {
        let r = first_row(cycle) + row;
        let mut ov = no_ov();
        ov.cells.push((S + col, r, cell(&base, S + col, r) + Felt::ONE));
        must_reject_forced(
            &format!("hash state cell altered (cycle {cycle}, row {row}, element {col})"),
            &|| build(&inp, &ov),
            &js.public(),
            Expect::Within(&range(TC_ROUND, 24)),
        );
    }

    // a register that changes in the middle of the trace (rows 1000.. and 3000.. are inside
    // input block 1 and after input block 2)
    for (name, col, from, tc) in [
        ("sk[0]", SK, 1000usize, TC_SWITCH),
        ("rho[7]", RHO + 7, 3000, TC_SWITCH + 15),
        ("input-1 value limb 0", A1, 1000, TC_CONST),
        ("input-2 value limb 3", A2 + 3, 3000, TC_CONST + A2 + 3 - A1),
        ("output-1 value limb 1", B1 + 1, 1000, TC_CONST + B1 + 1 - A1),
        ("output-2 value limb 2", B2 + 2, 3000, TC_CONST + B2 + 2 - A1),
        ("enable flag 1", EN1, 3000, TC_CONST + EN1 - A1),
        ("enable flag 2", EN2, 1000, TC_CONST + EN2 - A1),
        ("carry digit KA[2]", KA + 2, 1000, TC_CONST + KA + 2 - A1),
        ("carry digit KB[0]", KB, 3000, TC_CONST + KB - A1),
    ] {
        let mut ov = no_ov();
        for r in from..TRACE_LEN {
            ov.cells.push((col, r, cell(&base, col, r) + Felt::ONE));
        }
        must_reject_forced(
            &format!("register {name} changes at row {from}"),
            &|| build(&inp, &ov),
            &js.public(),
            Expect::Contains(&[tc]),
        );
    }
}

// ---- 14. schedule ---------------------------------------------------------------------------------------------------------------
//
// The cycle types are trace columns (not periodic columns), so the prover could try to run a
// different schedule. Each case below is a real attack if the named constraint were missing.

fn set_col(ov: &mut Overrides, cycle: usize, col: usize, v: Felt) {
    for r in 0..CYCLE {
        ov.cells.push((col, first_row(cycle) + r, v));
    }
}

fn set_sel(ov: &mut Overrides, cycle: usize, x: usize, v: Felt) {
    set_col(ov, cycle, SEL + x, v);
}

/// Public inputs read from a trace laid out with `sched`.
fn public_for(t: &Trace, sched: &Schedule, anchor_row: usize, js: &JoinSplit) -> PublicInputs {
    let nk2 = sched.nk2.unwrap_or(C_NK2);
    let out = sched.out.unwrap_or(C_OUT);
    PublicInputs {
        anchor: digest_at(t, anchor_row),
        nf: [digest_at(t, out_row(O_NF)), digest_at(t, out_row(nk2 + O_NF))],
        // output j: rho hash, first absorption, second absorption (whose digest is cm_out)
        cm_out: [digest_at(t, out_row(out + 2)), digest_at(t, out_row(out + OUT_BLOCK + 2))],
        v_in: js.v_in,
        v_out: js.v_out,
        fee: js.fee,
        binding: js.binding,
    }
}

#[test]
fn n14_schedule() {
    let js = two_real(34);
    let inp = inp_of(&js);
    let mut rng = TestRng(1414);

    // (a) membership bypass: the last Merkle cycle of an input is declared "free", so its input
    // is unconstrained and its output is not compared with the anchor. The selector step is
    // violated; the anchor comparison also fires one level early (the run is now left after
    // level 30), which the prover cannot satisfy either.
    for i in 0..2 {
        let last = c_in(i) + BLOCK - 1;
        let mut ov = no_ov();
        set_sel(&mut ov, last, X_MK, Felt::ZERO);
        set_col(&mut ov, last, P, Felt::ZERO);
        set_col(&mut ov, last, T, Felt::ZERO);
        ov.init.insert(last, core::array::from_fn(|_| rng.felt()));
        must_reject_forced(
            &format!("schedule: {}: last Merkle cycle turned into a free cycle", in_name(i)),
            &|| build(&inp, &ov),
            &js.public(),
            Expect::Both(&[TC_SEL_STEP + X_MK], &cat(&[TC_SEL_STEP + X_MK], &range(TC_ANCHOR, 8))),
        );
        // ... and with T cleared one cycle earlier too, so that the early anchor comparison is
        // skipped: now the definition of T is violated as well.
        set_col(&mut ov, last - 1, T, Felt::ZERO);
        must_reject_forced(
            &format!("schedule: {}: last Merkle cycle free + T cleared on level 30", in_name(i)),
            &|| build(&inp, &ov),
            &js.public(),
            Expect::Exactly(&[TC_T, TC_SEL_STEP + X_MK]),
        );
    }

    // (b) a 31-level path for input 1: the second input block starts one cycle early (it then has
    // 33 Merkle levels so the outputs still start in cycle 74). Input 2 is a dummy; the anchor is
    // the 31-level "root". Every hash and link is consistent with the shifted schedule; only
    // "NK sits in cycle 0 or 37" is violated.
    let one0 = one_real(0, 34);
    let inp0 = inp_of(&one0);
    let sched = Schedule { nk2: Some(C_NK2 - 1), out: Some(C_OUT) };
    let t = build_trace_with(&inp0, &no_ov(), &sched, TRACE_LEN);
    let pi = public_for(&t, &sched, out_row(C_NK2 - 2), &one0);
    assert_ne!(pi.anchor, one0.anchor);
    must_reject_forced(
        "schedule: 31-level path for input 1 (second NK one cycle early)",
        &|| build_trace_with(&inp0, &no_ov(), &sched, TRACE_LEN),
        &pi,
        Expect::Exactly(&[TC_NK_PIN]),
    );
    // ... the same with the cycle counter cheating so that the early NK is "cycle 37" (the whole
    // rest of the schedule is one cycle early as well)
    let sched = Schedule { nk2: Some(C_NK2 - 1), out: Some(C_OUT - 1) };
    // (a counter that starts at 1 also puts the first NK cycle outside {0, 37})
    for (name, cnt_from, only) in [
        ("schedule: 31-level path + cycle counter skips", first_row(C_NK2 - 1), &[TC_CNT_STEP][..]),
        ("schedule: 31-level path + cycle counter starts at 1", 0, &[TC_CNT_FIRST, TC_NK_PIN][..]),
    ] {
        let mut ov = no_ov();
        for r in cnt_from..TRACE_LEN {
            ov.cells.push((CNT, r, Felt::from_u32((r / CYCLE + 1) as u32)));
        }
        let t = build_trace_with(&inp0, &ov, &sched, TRACE_LEN);
        let pi = public_for(&t, &sched, out_row(C_NK2 - 2), &one0);
        must_reject_forced(name, &|| build_trace_with(&inp0, &ov, &sched, TRACE_LEN), &pi, Expect::Exactly(only));
    }

    // (c) a 31-level path for input 2: the outputs start one cycle early.
    let one1 = one_real(1, 34);
    let inp1 = inp_of(&one1);
    let sched = Schedule { nk2: Some(C_NK2), out: Some(C_OUT - 1) };
    let t = build_trace_with(&inp1, &no_ov(), &sched, TRACE_LEN);
    let pi = public_for(&t, &sched, out_row(C_OUT - 2), &one1);
    assert_ne!(pi.anchor, one1.anchor);
    must_reject_forced(
        "schedule: 31-level path for input 2 (outputs one cycle early)",
        &|| build_trace_with(&inp1, &no_ov(), &sched, TRACE_LEN),
        &pi,
        Expect::Exactly(&[TC_RA_PIN]),
    );

    // (d) no second input block at all: one Merkle run of 69 levels, then the outputs. The second
    // nullifier is never computed, so any nf2 can be claimed. Only "IDX = 1 on the last row".
    let sched = Schedule { nk2: None, out: Some(C_OUT) };
    let t = build_trace_with(&inp0, &no_ov(), &sched, TRACE_LEN);
    let mut pi = public_for(&t, &sched, out_row(C_OUT - 1), &one0);
    pi.nf[1] = rng.digest();
    // SHIELD-3: the rho hashes absorb the claimed pair (nf1 computed, nf2 invented) and the
    // output commitments are the ones that follow
    let ov_d = Overrides { rho_nf: Some(pi.nf), ..no_ov() };
    pi.cm_out = public_for(&build_trace_with(&inp0, &ov_d, &sched, TRACE_LEN), &sched, 0, &one0).cm_out;
    must_reject_forced(
        "schedule: second input block missing, arbitrary nf2 claimed",
        &|| build_trace_with(&inp0, &ov_d, &sched, TRACE_LEN),
        &pi,
        Expect::Exactly(&[TC_IDX_LAST]),
    );

    // (e) the outputs never start: the second Merkle run goes on to the end of the trace, the
    // output commitments are never computed and any cm_out can be claimed. Input 2 is a dummy.
    // Only "MK must be 0 on the last row" is violated.
    let sched = Schedule { nk2: Some(C_NK2), out: None };
    let t = build_trace_with(&inp0, &no_ov(), &sched, TRACE_LEN);
    let mut pi = public_for(&t, &sched, out_row(C_NK2 - 1), &one0);
    assert_eq!(pi.anchor, one0.anchor);
    pi.cm_out = [rng.digest(), rng.digest()];
    must_reject_forced(
        "schedule: Merkle selector never cleared, arbitrary cm_out claimed",
        &|| build_trace_with(&inp0, &no_ov(), &sched, TRACE_LEN),
        &pi,
        Expect::Exactly(&[TC_MK_LAST]),
    );

    // (f) the OB2 selector is cleared, so cm_out2 is never compared with the public value
    let mut ov = no_ov();
    set_sel(&mut ov, c_out(1) + 1, X_OB2, Felt::ZERO);
    let mut pi = js.public();
    pi.cm_out[1] = bump(&pi.cm_out[1], 0);
    must_reject_forced(
        "schedule: OB2 cleared, another cm_out2 claimed",
        &|| build(&inp, &ov),
        &pi,
        Expect::Exactly(&[TC_SEL_STEP + X_OB2]),
    );
    // (g) the OA2 selector is cleared: cm_out1 is not compared
    let mut ov = no_ov();
    set_sel(&mut ov, c_out(0) + 1, X_OA2, Felt::ZERO);
    let mut pi = js.public();
    pi.cm_out[0] = bump(&pi.cm_out[0], 0);
    // (SHIELD-3: the selector after OA2 in the chain is now RB, the rho hash of output 2)
    must_reject_forced(
        "schedule: OA2 cleared, another cm_out1 claimed",
        &|| build(&inp, &ov),
        &pi,
        Expect::Exactly(&[TC_SEL_STEP + X_OA2, TC_SEL_STEP + X_RB]),
    );
    // (h) the NF selector of an input block is cleared: that nullifier is not compared
    for i in 0..2 {
        let mut ov = no_ov();
        set_sel(&mut ov, c_in(i) + O_NF, X_NF, Felt::ZERO);
        let mut pi = js.public();
        pi.nf[i] = bump(&pi.nf[i], 0);
        claim_nf(&inp, &mut ov, &mut pi); // SHIELD-3: the rho hashes absorb the claimed pair
        must_reject_forced(
            &format!("schedule: NF cleared in block {}, another nf claimed", i + 1),
            &|| build(&inp, &ov),
            &pi,
            Expect::Exactly(&[TC_SEL_STEP + X_NF, TC_SEL_STEP + X_PK]),
        );
    }

    // (i) a selector with the value 2 in a padding cycle
    let mut ov = no_ov();
    set_sel(&mut ov, USED_CYCLES + 12, X_OB2, Felt::TWO);
    must_reject_forced(
        "schedule: non-boolean selector in a padding cycle",
        &|| build(&inp, &ov),
        &js.public(),
        Expect::Contains(&[TC_SEL_BOOL + X_OB2]),
    );
    // (j) a selector that is set on the first row
    let mut ov = no_ov();
    ov.cells.push((SEL + X_MK, 0, Felt::ONE));
    must_reject_forced(
        "schedule: MK selector set on the first row",
        &|| build(&inp, &ov),
        &js.public(),
        Expect::Contains(&[TC_SEL_FIRST + X_MK]),
    );
    // (k) IDX is 1 on the first row (block 1 would be checked against nf2 / A2 / EN2)
    let mut ov = no_ov();
    ov.cells.push((IDX, 0, Felt::ONE));
    must_reject_forced(
        "schedule: block index is 1 on the first row",
        &|| build(&inp, &ov),
        &js.public(),
        Expect::Contains(&[TC_IDX_FIRST]),
    );
}

// ---- 15. join-split specific -----------------------------------------------------------------------------------------------------

#[test]
fn n15_same_note_as_both_inputs() {
    // The same real note in both input slots; the outputs take twice its value. Every AIR
    // constraint holds (the AIR does not compare the two nullifiers); the public nullifiers are
    // equal, which `verify_spend` refuses before looking at the proof.
    let mut js = one_real(0, 35);
    js.inputs[1] = js.inputs[0].clone();
    js.outputs[1].value += js.inputs[0].value;
    assert_eq!(js.check().unwrap_err(), "the two nullifiers are equal");
    let pi = js.public();
    assert_eq!(pi.nf[0], pi.nf[1]);
    assert!(violations(&honest_trace(&js), &pi).is_empty(), "the AIR alone is satisfied");
    for (n, s) in setups().iter().enumerate() {
        let bytes = prove_trace(s, honest_trace(&js), &pi, blind(150 + n as u64)).unwrap();
        let refused = verify_spend_with(s, &pi, &bytes);
        assert!(matches!(&refused, Err(e) if kind(e) == "DuplicateNullifier"), "{refused:?}");
        let library = library_only(&pi, &bytes);
        assert_eq!(library, Some(true), "expected the library verifier alone to accept");
        println!(
            "NEG|same note used as both inputs (value counted twice)|{}|verifier-check|AIR satisfied; verify_spend rejects: DuplicateNullifier; library verifier alone: ACCEPTS (the nf1 != nf2 check is necessary)",
            label(s)
        );
    }

    // The same double-spend with DIFFERENT public nullifiers: block 2 re-spends note 1 while the
    // block index stays 0, so its nullifier is compared with nf1 again, its commitment with A1,
    // and nf2 is never checked. A2 is an invented value that the outputs take. Only the IDX step
    // constraint is violated.
    let base = two_real(35);
    let mut inp = inp_of(&base);
    for f in [&mut inp.sk, &mut inp.rho, &mut inp.r] {
        f[1] = f[0];
    }
    inp.siblings[1] = inp.siblings[0];
    inp.pos_bits[1] = inp.pos_bits[0];
    let invented = 9_000_000_000_000u64;
    inp.a[1] = limbs(invented);
    inp.b[0] = limbs(base.inputs[0].value + invented - base.fee - base.outputs[1].value);
    recarry(&mut inp, &base);
    let mut ov = no_ov();
    let honest = honest_trace(&base);
    ov.init.insert(c_in(1) + O_CM2, state_at(&honest, first_row(c_in(0) + O_CM2)));
    for c in C_NK2..C_OUT {
        set_col(&mut ov, c, IDX, Felt::ZERO);
    }
    let t = build(&inp, &ov);
    let mut pi = public_inputs_from_trace(&t, 0, &base);
    assert_eq!(pi.anchor, base.anchor);
    assert_eq!(pi.nf[0], pi.nf[1]);
    pi.nf[1] = TestRng(3535).digest();
    claim_nf(&inp, &mut ov, &mut pi); // SHIELD-3: the rho hashes absorb (nf1, fake nf2)
    must_reject_forced(
        "same note as both inputs with a fresh fake nf2 and an invented value (block index frozen)",
        &|| build(&inp, &ov),
        &pi,
        Expect::Exactly(&[TC_IDX_STEP]),
    );
}

#[test]
fn n16_dummy_inputs() {
    for i in 0..2 {
        // (a) a dummy with a non-zero value: free money. The dummy's commitment hashes that value
        // consistently and the outputs take it; only "dummy value = 0" is violated.
        let one = one_real(1 - i, 36);
        assert!(!one.inputs[i].enabled);
        let mut inp = inp_of(&one);
        inp.a[i] = limbs(5_000_000); // limbs [0x4b40, 0x4c, 0, 0]
        inp.b[0] = limbs(one.outputs[0].value + 5_000_000);
        recarry(&mut inp, &one);
        let pi = public_inputs_from_trace(&build(&inp, &no_ov()), 1 - i, &one);
        assert_eq!(pi.anchor, one.anchor);
        must_reject_forced(
            &format!("dummy {} with a non-zero value", in_name(i)),
            &|| build(&inp, &no_ov()),
            &pi,
            Expect::Exactly(&[TC_DUMMY + 4 * i, TC_DUMMY + 4 * i + 1]),
        );

        // (b) a REAL note marked dummy to skip membership while keeping its value in the balance
        let two = two_real(36);
        let mut inp = inp_of(&two);
        inp.en[i] = Felt::ZERO;
        let nonzero: Vec<usize> =
            (0..NUM_LIMBS).filter(|&l| inp.a[i][l] != Felt::ZERO).map(|l| TC_DUMMY + 4 * i + l).collect();
        must_reject_forced(
            &format!("{} marked dummy, value kept", in_name(i)),
            &|| build(&inp, &no_ov()),
            &two.public(),
            Expect::Exactly(&nonzero),
        );

        // (c) the opposite trick: the flag says "real" (value kept) but the membership check is
        // switched off by clearing T on that input's Merkle cycles; the note is NOT in the tree.
        let mut fake = two.clone();
        fake.inputs[i].r = bump(&fake.inputs[i].r, 0);
        let inp = inp_of(&fake);
        let mut ov = no_ov();
        for c in c_in(i) + O_MK0..c_in(i) + BLOCK {
            set_col(&mut ov, c, T, Felt::ZERO);
        }
        assert_ne!(root_at(&build(&inp, &ov), i), two.anchor);
        must_reject_forced(
            &format!("{} not in the tree, enable = 1, T cleared to skip the anchor", in_name(i)),
            &|| build(&inp, &ov),
            &fake.public(),
            Expect::Exactly(&[TC_T]),
        );

        // (d) a non-boolean flag: enable = 2 on a real zero-value note that IS in the tree
        // (everything else holds: T = 2 on its Merkle cycles, the root is the anchor)
        let mut rng = TestRng(3600 + i as u64);
        let mut vals = [777_000u64, 777_000];
        vals[i] = 0;
        let fx = fixture(&mut rng, &vals);
        let d = rng.digest();
        let zero = transfer(fx.tree.root(), &fx.notes, 700_000, d, d, 1_000, d, &mut rng).unwrap();
        zero.check().unwrap();
        let mut inp = inp_of(&zero);
        inp.en[i] = Felt::TWO;
        must_reject_forced(
            &format!("{}: enable flag = 2", in_name(i)),
            &|| build(&inp, &no_ov()),
            &zero.public(),
            Expect::Exactly(&[TC_EN_BOOL + i]),
        );

        // (e) the two inputs under different roots: input i sits in ANOTHER tree
        let mut split = two.clone();
        let mut tree2 = SparseTree::new();
        tree2.insert(split.inputs[i].index, split.inputs[i].note().commitment());
        split.inputs[i].path = tree2.path(split.inputs[i].index);
        assert_eq!(split.inputs[i].root(), tree2.root());
        assert_eq!(split.inputs[1 - i].root(), split.anchor);
        must_reject_forced(
            &format!("{} under a different root than the anchor", in_name(i)),
            &|| honest_trace(&split),
            &split.public(),
            Expect::Within(&range(TC_ANCHOR, 8)),
        );
        // ... and claiming that other root as the anchor fails for the other input
        let mut pi = split.public();
        pi.anchor = tree2.root();
        must_reject_forced(
            &format!("{} under a different root, that root claimed as anchor", in_name(i)),
            &|| honest_trace(&split),
            &pi,
            Expect::Within(&range(TC_ANCHOR, 8)),
        );
    }
}

// ---- 17. links and selectors not isolated above ------------------------------------------------------------------------------------
//
// Added after the self-review (RESULTS.md, "Where this AIR could be wrong"): one isolated forged
// trace for link and selector paths that groups 1-16 only reached together with others.

#[test]
fn n17_links_and_selectors() {
    let js = two_real(37);
    let good = js.public();
    let mut rng = TestRng(1717);
    for i in 0..2 {
        let blk = c_in(i);
        let other_sk = rng.digest();

        // (a) the mirror of 4(c): the REGISTER (and so nk and nf) holds another key, the pk hash
        // absorbs the note owner's key. Real root, another nullifier for the same note.
        let mut inp = inp_of(&js);
        inp.sk[i] = other_sk;
        let mut ov = no_ov();
        ov.init.insert(blk + O_PK, fresh(LEN_KEY, D_PK, &js.inputs[i].sk, &ZERO_DIGEST));
        let pi = public_inputs_from_trace(&build(&inp, &ov), i, &js);
        assert_eq!(pi.anchor, js.anchor);
        assert_ne!(pi.nf[i], good.nf[i]);
        must_reject_forced(
            &format!("{}: pk hashed from another key than the sk register (second nullifier)", in_name(i)),
            &|| build(&inp, &ov),
            &pi,
            Expect::Exactly(&range(TC_LINK, 8)),
        );

        // (b) the nk hash absorbs extra data next to sk (upper half of the rate): another nk and
        // so another nullifier for the same note. Real root.
        let inp = inp_of(&js);
        let mut ov = no_ov();
        ov.init.insert(blk + O_NK, fresh(LEN_KEY, D_NK, &js.inputs[i].sk, &rng.digest()));
        let pi = public_inputs_from_trace(&build(&inp, &ov), i, &js);
        assert_eq!(pi.anchor, js.anchor);
        assert_ne!(pi.nf[i], good.nf[i]);
        must_reject_forced(
            &format!("{}: nk hash absorbs extra data (second nullifier)", in_name(i)),
            &|| build(&inp, &ov),
            &pi,
            Expect::Exactly(&range(TC_LINK + DIGEST, 8)),
        );

        // (c) the mirror of 5(c): the rho REGISTER (and so nf) holds another rho, the commitment
        // absorbs the real one. Real root.
        let mut inp = inp_of(&js);
        inp.rho[i] = rng.digest();
        let mut ov = no_ov();
        ov.init.insert(blk + O_CM1, fresh(LEN_CM, D_CM, &derive_pk(&js.inputs[i].sk), &js.inputs[i].rho));
        let pi = public_inputs_from_trace(&build(&inp, &ov), i, &js);
        assert_eq!(pi.anchor, js.anchor);
        assert_ne!(pi.nf[i], good.nf[i]);
        must_reject_forced(
            &format!("{}: commitment absorbs another rho than the register (second nullifier)", in_name(i)),
            &|| build(&inp, &ov),
            &pi,
            Expect::Exactly(&range(TC_LINK + DIGEST, 8)),
        );

        // (d) a Merkle node hashed under another domain tag (the other input is a dummy; the
        // anchor is this trace's own root)
        let one = one_real(i, 37);
        let inp1 = inp_of(&one);
        let base = honest_trace(&one);
        let c = blk + O_MK0 + 7;
        let mut st = state_at(&base, first_row(c));
        st[CAP + 1] = Felt::from_u32(D_CM);
        let mut ov = no_ov();
        ov.init.insert(c, st);
        let pi = public_inputs_from_trace(&build(&inp1, &ov), i, &one);
        must_reject_forced(
            &format!("{}: Merkle node under another domain tag", in_name(i)),
            &|| build(&inp1, &ov),
            &pi,
            Expect::Exactly(&[TC_LINK + CAP + 1]),
        );

        // (e) second absorption of the input commitment: a padding position of the rate (13) and
        // a capacity element (20) are changed
        for (el, what) in [(13usize, "rate padding element 13"), (20, "capacity element 20")] {
            let c = blk + O_CM2;
            let mut st = state_at(&base, first_row(c));
            st[el] += Felt::ONE;
            let mut ov = no_ov();
            ov.init.insert(c, st);
            let pi = public_inputs_from_trace(&build(&inp1, &ov), i, &one);
            must_reject_forced(
                &format!("{}: commitment second block, {what} altered", in_name(i)),
                &|| build(&inp1, &ov),
                &pi,
                Expect::Exactly(&[TC_LINK + el]),
            );
        }

        // (k) capacity of the key and commitment hashes: nk hashed under the pk tag (nk would
        // equal pk), pk hashed with another length, the input commitment under another tag
        for (off, el, val, what) in [
            (O_NK, CAP + 1, D_PK, "nk hashed under the pk domain tag"),
            (O_PK, CAP, LEN_PAIR, "pk hashed with another length"),
            (O_CM1, CAP + 1, D_MK, "input commitment under another domain tag"),
        ] {
            let c = blk + off;
            let mut st = state_at(&base, first_row(c));
            st[el] = Felt::from_u32(val);
            let mut ov = no_ov();
            ov.init.insert(c, st);
            let pi = public_inputs_from_trace(&build(&inp1, &ov), i, &one);
            must_reject_forced(&format!("{}: {what}", in_name(i)), &|| build(&inp1, &ov), &pi, Expect::Exactly(&[TC_LINK + el]));
        }

        // (f) range lane X: an input limb of -1 mod p "range-checked" with a non-boolean bit or
        // with an accumulator jump (the lane-Y versions are in group 8)
        let lim = |v: u64, j: usize| ((v >> (16 * j)) & 0xffff) as i64;
        let v = 0x0000_0012_0007_0005u64;
        let mut w = one.clone();
        w.inputs[i].value = v;
        (w.v_in, w.v_out, w.fee) = (0, 0, 0);
        let mut inp = inp_of(&w);
        inp.a[i][0] = -Felt::ONE;
        inp.b[1] = [Felt::ZERO; NUM_LIMBS];
        inp.b[0] = limbs((v & !0xffff_ffff) | ((lim(v, 1) as u64 - 1) << 16) | 0xffff);
        (inp.ka, inp.kb) = carries_from_net(core::array::from_fn(|l| {
            (if l == 0 { -1 } else { lim(v, l) }) - (u64_of(&inp.b[0]) >> (16 * l) & 0xffff) as i64
        }));
        let pi = public_inputs_from_trace(&build(&inp, &no_ov()), i, &w);
        let seg = NUM_LIMBS * i;
        let (mut ov_bit, mut ov_acc) = (no_ov(), no_ov());
        for rep in 0..TRACE_LEN / RANGE_PERIOD {
            let row = rep * RANGE_PERIOD + seg * LIMB_BITS + LIMB_BITS - 1;
            ov_bit.cells.push((BITX, row, -Felt::ONE));
            ov_acc.cells.push((BITX, row, Felt::ONE));
            ov_acc.cells.push((ACCX, row, -Felt::ONE));
        }
        must_reject_forced(
            &format!("{}: field wrap + non-boolean range bit", in_name(i)),
            &|| build(&inp, &ov_bit),
            &pi,
            Expect::Exactly(&[TC_XBIT]),
        );
        must_reject_forced(
            &format!("{}: field wrap + accumulator jump", in_name(i)),
            &|| build(&inp, &ov_acc),
            &pi,
            Expect::Exactly(&[TC_XACC]),
        );

        // (g) the CM1 / CM2 selector of an input block is cleared, which would leave that
        // absorption (and with CM2 the value link) unconstrained
        for (x, next) in [(X_CM1, X_CM2), (X_CM2, X_MK)] {
            let mut ov = no_ov();
            set_sel(&mut ov, blk + O_CM1 + (x - X_CM1), x, Felt::ZERO);
            must_reject_forced(
                &format!("schedule: selector {x} cleared in block {}", i + 1),
                &|| build(&inp_of(&js), &ov),
                &good,
                Expect::Exactly(&[TC_SEL_STEP + x, TC_SEL_STEP + next]),
            );
        }
    }

    let inp = inp_of(&js);
    let base = honest_trace(&js);
    // (h) output commitments: first absorption under another domain tag / another length
    for (j, el, val, what) in [(0usize, CAP + 1, D_MK, "another domain tag"), (1, CAP, LEN_PAIR, "another length")] {
        let mut st = state_at(&base, first_row(c_out(j)));
        st[el] = Felt::from_u32(val);
        let mut ov = no_ov();
        ov.init.insert(c_out(j), st);
        let pi = public_inputs_from_trace(&build(&inp, &ov), 0, &js);
        must_reject_forced(
            &format!("output {}: commitment hashed with {what}", j + 1),
            &|| build(&inp, &ov),
            &pi,
            Expect::Exactly(&[TC_LINK + el]),
        );
    }
    // (i) a hash-state cell on row 1 of a cycle (the transition that applies the initial linear layer)
    let r = first_row(c_in(1) + O_PK) + 1;
    let mut ov = no_ov();
    ov.cells.push((S + 6, r, cell(&base, S + 6, r) + Felt::ONE));
    must_reject_forced(
        "hash state cell altered on row 1 of a cycle (initial-layer transition)",
        &|| build(&inp, &ov),
        &good,
        Expect::Within(&range(TC_ROUND, 24)),
    );
    // (j) NK / RA are free at a link but must be constant inside a cycle: set on half a cycle
    // (SHIELD-3: the free selector that starts the output part is RA; OA1 is now a step selector)
    for (x, cycle, pin) in [(X_NK, C_NK2, TC_NK_PIN), (X_RA, C_OUT, TC_RA_PIN)] {
        let mut ov = no_ov();
        for r in first_row(cycle + 1)..first_row(cycle + 1) + CYCLE / 2 {
            ov.cells.push((SEL + x, r, Felt::ONE));
        }
        must_reject_forced(
            &format!("schedule: selector {x} also set on half of cycle {}", cycle + 1),
            &|| build(&inp, &ov),
            &good,
            Expect::Contains(&[TC_SEL_STEP + x, pin]),
        );
    }
}
