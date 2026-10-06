//! TEST-PROVER FEATURE. Forged traces committed by the research prover under the one built-in
//! parameter set and handed to the production `verify_spend`; every one must be refused. Ported
//! from `research/shield3/tests/review_verifier.rs` (the forced-trace tests), `tests/review2_air.rs`
//! (`review2_rho_forgeries_through_the_production_verifier`, `review2_uniqueness_rests_on_the_node`)
//! and `tests/shield3.rs` (the F-2 tests). The research tests ran every forgery with hiding ON and
//! OFF; this crate has no hiding-OFF mode, so each runs once, under the production configuration.
//!
//! `review2_uniqueness_rests_on_the_node` continues where the research test stopped: the two
//! proofs that `verify_spend` accepts are handed to the pool of spec §4, which accepts one.
//!
//! Run: `cargo test --release -p quantum-vault-shield-v2 -j 1 --features test-prover --test forgery -- --nocapture --test-threads=1`

use std::collections::BTreeSet;

use p3_air::check_all_constraints;
use p3_field::{PrimeCharacteristicRing, PrimeField32};
use p3_matrix::dense::RowMajorMatrix;
use quantum_vault_shield_v2::Felt;
use quantum_vault_shield_v2::air::*;
use quantum_vault_shield_v2::layout::*;
use quantum_vault_shield_v2::pool::{MemoryPoolStore, Pool, PoolError, PoolTx, TxKind, TxRefusal, empty_tree_root};
use quantum_vault_shield_v2::reference::*;
use quantum_vault_shield_v2::trace::*;
use quantum_vault_shield_v2::verifier::prove_spend;
use quantum_vault_shield_v2::{MAX_PROOF_BYTES, verify_spend};

type Trace = RowMajorMatrix<Felt>;

fn violations(trace: &Trace, pi: &PublicInputs) -> BTreeSet<usize> {
    let report = check_all_constraints(&JoinSplitAir::new(), trace, &pi.to_values(), None);
    report.failures.iter().map(|f| f.constraint).collect()
}

fn names(v: &BTreeSet<usize>) -> Vec<String> {
    v.iter().map(|i| tc_name(*i)).collect()
}

fn seed(tag: u64) -> [u8; 32] {
    TestRng(0x7e57_0000 ^ tag).seed32()
}

fn set(from: usize, n: usize) -> BTreeSet<usize> {
    (from..from + n).collect()
}

static RUNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Commits to `trace` with the real prover (production parameters) and requires `verify_spend`
/// to refuse. The forged trace must violate at least one constraint; with `want`, exactly those.
fn must_reject_with(name: &str, trace: &Trace, pi: &PublicInputs, want: Option<&BTreeSet<usize>>) {
    let v = violations(trace, pi);
    assert!(!v.is_empty(), "{name}: the forged trace violates nothing — that would be a break");
    if let Some(w) = want {
        assert_eq!(&v, w, "{name}: violated {:?}, expected {:?}", names(&v), names(w));
    }
    let bytes = prove_spend(trace.clone(), pi, seed(name.len() as u64)).expect("prover");
    assert!(bytes.len() <= MAX_PROOF_BYTES);
    match verify_spend(pi, &bytes) {
        Ok(()) => panic!("{name}: FORGED PROOF ACCEPTED by verify_spend"),
        Err(e) => {
            let e = format!("{e:?}");
            RUNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            println!("FORGERY|{name}|violates {:?}|verify_spend REFUSES: {}", names(&v), &e[..e.len().min(60)]);
        }
    }
}

fn must_reject(name: &str, trace: &Trace, pi: &PublicInputs) {
    must_reject_with(name, trace, pi, None);
}

fn must_accept(name: &str, trace: &Trace, pi: &PublicInputs) {
    assert!(violations(trace, pi).is_empty(), "{name}: trace violates constraints");
    let bytes = prove_spend(trace.clone(), pi, seed(100 + name.len() as u64)).expect("prover");
    verify_spend(pi, &bytes).unwrap_or_else(|e| panic!("{name}: {e:?}"));
    println!("FORGERY|control|{name}|accepted (expected)|{} bytes", bytes.len());
}

fn refused_by_production_verifier(name: &str, trace: &Trace, pi: &PublicInputs) {
    must_reject(name, trace, pi);
}

// ---- research/shield3/tests/review_verifier.rs: the forced-trace tests ------------------------------

fn witness(seed: u64, n_real: usize, slot: usize) -> JoinSplit {
    let mut rng = TestRng(seed ^ 0x5eed_0000_0000);
    let v1 = 0x1234_5678_9abc_def1u64 ^ (rng.next_u64() & 0x0f0f_0f0f_0f0f_0f0f);
    let v2 = 0x0fed_cba9_8765_4321u64 ^ (rng.next_u64() & 0x0f0f_0f0f_0f0f_0f0f);
    let fx = fixture(&mut rng, &[v1, v2]);
    let binding = rng.digest();
    let (to, ch) = (rng.digest(), rng.digest());
    let mut js = transfer(fx.tree.root(), &fx.notes[..n_real], 0x0111_2222_3333_4444, to, ch, 1000, binding, &mut rng)
        .unwrap();
    if n_real == 1 && slot == 1 {
        js.inputs.swap(0, 1);
    }
    js.check().unwrap();
    js
}

// =================================================================================================
// FINDING F-2 (SHIELD-2, design / statement level): the nullifier depends on (sk, rho) only, and
// rho was chosen by the SENDER, so a sender could give a recipient two notes with one nullifier.
// SHIELD-3 FIX: rho of output j is H_rho(nf1, nf2, j), derived in the AIR from the public
// nullifiers; the sender has no say. This is the reviewer's test turned around: the attack can no
// longer be EXPRESSED. (1) The wallet API has no place to put a chosen rho. (2) A prover who
// forces the reviewer's rho into the output commitment anyway — both outputs of one transaction
// to one pk with one rho, the reviewer's 60 + 40 — is refused by the VERIFIER, in both modes.
// (3) What the honest path gives instead: two notes to one pk, in one transaction or in two, get
// different rho and so different nullifiers. Further forced traces: `tests/shield3.rs`.
// =================================================================================================

#[test]
fn review_f2_two_notes_with_the_senders_rho_cannot_be_created() {
    let mut rng = TestRng(0xfae21e);
    let sk = rng.digest(); // the victim's key; the sender only needs pk
    let pk = derive_pk(&sk);
    let rho = rng.digest(); // what the SHIELD-2 sender would have chosen and used twice
    let fx = fixture(&mut rng, &[150]);
    let bind = rng.digest();

    // (3) honest: one transaction pays 60 and 40 to the same pk
    let js = transfer(fx.tree.root(), &fx.notes, 60, pk, pk, 50, bind, &mut rng).unwrap();
    assert_eq!((js.outputs[0].value, js.outputs[1].value), (60, 40));
    js.check().unwrap();
    let (a, b) = (js.output_note(0), js.output_note(1));
    assert_ne!(a.rho, b.rho);
    let nk = derive_nk(&sk);
    assert_ne!(nullifier(&nk, &a.rho), nullifier(&nk, &b.rho), "the recipient can spend both");
    // ... and a second transaction (other nullifiers) gives yet other rho
    let fx2 = fixture(&mut rng, &[150]);
    let js2 = transfer(fx2.tree.root(), &fx2.notes, 60, pk, pk, 50, bind, &mut rng).unwrap();
    for j in 0..2 {
        for k in 0..2 {
            assert_ne!(js.rho_out(j), js2.rho_out(k));
        }
    }

    // (2) the attack, forced: the commitments of BOTH outputs absorb the sender's rho
    let inp = TraceInputs::honest(&js);
    let mut ov = Overrides::default();
    for j in 0..2 {
        ov.init.insert(c_out(j), fresh(LEN_CM, D_CM, &pk, &rho));
    }
    let t = build_trace(&inp, &ov);
    // the forged transaction publishes exactly the two commitments of the reviewer's attack
    let pi = public_inputs_from_trace(&t, 0, &js);
    assert_eq!(pi.cm_out[0], Note { value: 60, pk, rho, r: js.outputs[0].r }.commitment());
    assert_eq!(pi.cm_out[1], Note { value: 40, pk, rho, r: js.outputs[1].r }.commitment());
    assert_eq!(pi.nf, js.public().nf);
    // only the rho slot of the two first absorptions is violated: link elements 8..16
    let want: BTreeSet<usize> = (TC_LINK + DIGEST..TC_LINK + RATE).collect();
    assert_eq!(violations(&t, &pi), want);
    must_reject("F-2: both outputs committed with one sender-chosen rho", &t, &pi);

    // the same for a single output, and for a rho equal to the rho of a note the victim already
    // holds (the "born spent" variant): any rho other than the derived one
    for j in 0..2 {
        let mut ov = Overrides::default();
        ov.init.insert(c_out(j), fresh(LEN_CM, D_CM, &pk, &fx.notes[0].rho));
        let t = build_trace(&inp, &ov);
        let pi = public_inputs_from_trace(&t, 0, &js);
        assert_eq!(violations(&t, &pi), want);
        must_reject(&format!("F-2: output {} committed with the rho of an existing note", j + 1), &t, &pi);
    }
    println!("FORGERY|F-2 shared nullifier (fixed)|the reviewer's two commitments (60 + 40, one pk, one sender-chosen rho) can only come from a trace that violates the rho link; refused by the verifier in both modes|honest notes to one pk get distinct rho and distinct nullifiers");
}

// =================================================================================================
// Attacks that must be refused.
// =================================================================================================

/// One state element of one hash input changed, everything downstream recomputed, public digests
/// re-read from the trace: exactly one link constraint is violated.
#[test]
fn review_isolated_links_authors_left_untested() {
    // (cycle, state element): capacity elements other than tag / length, the unchanged tail of a
    // second block, and the wrap-around link into cycle 0 — the authors' "NONE isolated" rows.
    let cases: [(usize, usize, &str); 10] = [
        (0, 20, "nk of input 1 (wrap-around link), capacity element 4"),
        (C_NK2, 18, "nk of input 2, capacity element 2"),
        (O_NF + C_NK2, 22, "nf of input 2, capacity element 6"),
        (O_PK, 23, "pk of input 1, capacity element 7"),
        (O_CM1, 19, "cm of input 1, first block, capacity element 3"),
        (O_CM2, 14, "cm of input 1, second block, rate element 14"),
        (C_NK2 + O_CM2, 13, "cm of input 2, second block, rate element 13"),
        (O_MK0 + 31, 23, "Merkle level 31 of input 1, capacity element 7"),
        (c_out(0) + 1, 21, "cm_out1, second block, capacity element 5"),
        (c_out(1) + 1, 15, "cm_out2, second block, rate element 15"),
    ];
    for (c, i, what) in cases {
        let real = if (C_NK2..C_OUT).contains(&c) { 1 } else { 0 };
        let js = witness(60 + c as u64, 1, real);
        let inp = TraceInputs::honest(&js);
        let base = build_trace(&inp, &Overrides::default());
        let mut st = state_at(&base, first_row(c));
        st[i] += Felt::ONE;
        let mut ov = Overrides::default();
        ov.init.insert(c, st);
        let t = build_trace(&inp, &ov);
        let pi = public_inputs_from_trace(&t, real, &js);
        assert_eq!(violations(&t, &pi), BTreeSet::from([TC_LINK + i]), "{what}");
        must_reject(&format!("isolated link: {what}"), &t, &pi);
    }
}

/// Control for the test above (the harness does not refuse everything): elements an independent
/// reading leaves free really are free — another pk' for output 1, another r for input 1, another
/// sibling for the dummy input, and arbitrary states in all 48 padding cycles (50 in SHIELD-2).
#[test]
fn review_free_elements_are_free_and_padding_is_arbitrary() {
    let js = witness(70, 1, 0);
    let inp = TraceInputs::honest(&js);
    let base = build_trace(&inp, &Overrides::default());
    let mut ov = Overrides::default();
    for (c, i) in [(c_out(0), 3usize), (O_CM2, 7), (C_NK2 + O_MK0 + 4, 9)] {
        let mut st = state_at(&base, first_row(c));
        st[i] += Felt::ONE;
        ov.init.insert(c, st);
    }
    let mut rng = TestRng(70);
    for c in USED_CYCLES..NUM_CYCLES {
        ov.init.insert(c, core::array::from_fn(|_| rng.felt()));
    }
    let t = build_trace(&inp, &ov);
    let pi = public_inputs_from_trace(&t, 0, &js);
    assert_ne!(pi, js.public());
    must_accept("free elements + arbitrary padding", &t, &pi);
}

fn u(l: Felt) -> u32 {
    l.as_canonical_u32()
}

/// A limb 2^16 too large, compensated in the next limb (integer value and balance unchanged):
/// limbs 1 and 2, which the authors' suite never isolates.
#[test]
fn review_range_limbs_1_and_2() {
    for (which, j) in [(0usize, 2usize), (1, 1), (2, 1), (3, 2)] {
        let js = if which < 2 { witness(80 + which as u64, 1, which) } else { witness(82, 2, 0) };
        let mut inp = TraceInputs::honest(&js);
        {
            let limbs = if which < 2 { &mut inp.a[which] } else { &mut inp.b[which - 2] };
            limbs[j] += Felt::from_u32(1 << 16);
            assert!(u(limbs[j + 1]) >= 1);
            limbs[j + 1] -= Felt::ONE;
        }
        (inp.ka, inp.kb) = carries(&inp.a, &inp.b, js.v_in, js.v_out, js.fee);
        let t = build_trace(&inp, &Overrides::default());
        let pi = public_inputs_from_trace(&t, if which < 2 { which } else { 0 }, &js);
        let lane = if which < 2 { TC_XLIMB } else { TC_YLIMB };
        assert_eq!(violations(&t, &pi), BTreeSet::from([lane]));
        let who = ["input 1", "input 2", "output 1", "output 2"][which];
        must_reject(&format!("{who}: limb {j} is 17 bits, value and balance unchanged"), &t, &pi);
    }
}

/// The selector first-row and booleanity constraints are the only backstop if the chain argument
/// fails; the authors exercise 1 + 1 of 10 + 10.
#[test]
fn review_selector_backstops_through_the_verifier() {
    let js = witness(90, 2, 0);
    let pi = js.public();
    let base = honest_trace(&js);
    for x in [X_OB1, X_CM2, X_NF] {
        let mut t = base.clone();
        for r in 0..CYCLE {
            t.values[r * TRACE_WIDTH + SEL + x] = Felt::ONE;
        }
        assert!(violations(&t, &pi).contains(&(TC_SEL_FIRST + x)));
        must_reject(&format!("selector {x} also set on the first cycle"), &t, &pi);
    }
    for x in [X_NK, X_MK, X_OA2] {
        let mut t = base.clone();
        for r in 0..CYCLE {
            t.values[(first_row(100) + r) * TRACE_WIDTH + SEL + x] = Felt::TWO;
        }
        assert!(violations(&t, &pi).contains(&(TC_SEL_BOOL + x)));
        must_reject(&format!("selector {x} = 2 in a padding cycle"), &t, &pi);
    }
}

/// The key registers switch to other values inside the padding (cycle 100) instead of at the
/// wrap-around. Nothing reads them there; only the register rule objects.
#[test]
fn review_key_registers_cannot_switch_in_the_padding() {
    let js = witness(95, 2, 0);
    let pi = js.public();
    let mut t = honest_trace(&js);
    for row in first_row(100)..TRACE_LEN {
        for i in 0..DIGEST {
            t.values[row * TRACE_WIDTH + SK + i] = js.inputs[0].sk[i];
            t.values[row * TRACE_WIDTH + RHO + i] = js.inputs[0].rho[i];
        }
    }
    let want: BTreeSet<usize> = (TC_SWITCH..TC_SWITCH + 16).collect();
    assert_eq!(violations(&t, &pi), want);
    must_reject("sk / rho registers switch in the padding (not at the wrap-around)", &t, &pi);
}

// ---- research/shield3/tests/review2_air.rs --------------------------------------------------------

fn permuted(mut s: [Felt; STATE_WIDTH]) -> [Felt; STATE_WIDTH] {
    permute(&mut s);
    s
}

/// Rewrites the selector columns of whole cycles.
fn set_cycle_selector(t: &mut Trace, c: usize, x: Option<usize>) {
    for r in 0..CYCLE {
        let row = first_row(c) + r;
        for y in 0..NUM_SEL {
            t.values[row * TRACE_WIDTH + SEL + y] = if Some(y) == x { Felt::ONE } else { Felt::ZERO };
        }
    }
}

#[test]
fn review2_rho_forgeries_through_the_production_verifier() {
    let js = sample(Kind::Transfer, 0xc1);
    let inp = TraceInputs::honest(&js);
    let good = js.public();
    let mut rng = TestRng(0xc1c1);

    // control: the honest trace, same path, is accepted
    let honest = build_trace(&inp, &Overrides::default());
    let bytes = prove_spend(honest.clone(), &good, seed(999)).unwrap();
    verify_spend(&good, &bytes).expect("control: honest proof");
    println!("REVIEW2|forgery|control: honest trace|accepted (expected)|{} bytes", bytes.len());

    // (1) The SHIELD-2 schedule replayed: no rho hash. Cycles 74..78 are OA1, OA2, OB1, OB2 with a
    // rho the sender chose (the same one for both outputs, to one pk: finding F-2 verbatim); the
    // selectors RA / RB are never set. The commitments published are exactly the attack's.
    {
        let rho = rng.digest();
        let pk = rng.digest();
        let mut ov = Overrides::default();
        let a1 = fresh(LEN_CM, D_CM, &pk, &rho);
        let a2 = second_block(&permuted(a1), &inp.b[0], &inp.r_out[0]);
        let b1 = fresh(LEN_CM, D_CM, &pk, &rho);
        let b2 = second_block(&permuted(b1), &inp.b[1], &inp.r_out[1]);
        for (c, s) in [(74usize, a1), (75, a2), (76, b1), (77, b2)] {
            ov.init.insert(c, s);
        }
        let mut t = build_trace(&inp, &ov);
        for (c, x) in [(74, Some(X_OA1)), (75, Some(X_OA2)), (76, Some(X_OB1)), (77, Some(X_OB2)), (78, None), (79, None)] {
            set_cycle_selector(&mut t, c, x);
        }
        let cm = |j: usize| Note { value: js.outputs[j].value, pk, rho, r: js.outputs[j].r }.commitment();
        assert_eq!(digest_at(&t, out_row(75)), cm(0));
        assert_eq!(digest_at(&t, out_row(77)), cm(1));
        let pi = PublicInputs { cm_out: [cm(0), cm(1)], ..good.clone() };
        refused_by_production_verifier("SHIELD-2 schedule replayed: no rho hash, one sender-chosen rho for both outputs", &t, &pi);
    }

    // (2) Output 2 reuses output 1's derivation through the SELECTOR: cycle 77 carries RA (index
    // 0) instead of RB, with the state RA demands. Both notes get the same rho.
    {
        let mut ov = Overrides::default();
        ov.init.insert(77, fresh_rho(&good.nf, 0));
        let mut t = build_trace(&inp, &ov);
        set_cycle_selector(&mut t, 77, Some(X_RA));
        let pi = public_inputs_from_trace(&t, 0, &js);
        assert_eq!(digest_at(&t, out_row(74)), digest_at(&t, out_row(77)), "both outputs: the same rho");
        assert_ne!(pi.cm_out[1], good.cm_out[1]);
        refused_by_production_verifier("cycle 77 typed RA instead of RB: both outputs get H_rho(nf1, nf2, 0)", &t, &pi);
    }

    // (3) The same without touching the selector: RB's capacity index written as 0.
    {
        let mut ov = Overrides::default();
        ov.init.insert(77, fresh_rho(&good.nf, 0));
        let t = build_trace(&inp, &ov);
        let pi = public_inputs_from_trace(&t, 0, &js);
        assert_eq!(violations(&t, &pi), BTreeSet::from([TC_LINK + CAP + 2]));
        refused_by_production_verifier("RB hashes with index 0: both outputs get the same rho", &t, &pi);
    }

    // (4) The rho hashes absorb the nullifiers in the other order (nf2 ‖ nf1): a different, also
    // "public", derivation that a sender could prefer if it controlled the order.
    {
        let mut ov = Overrides::default();
        ov.rho_nf = Some([good.nf[1], good.nf[0]]);
        let t = build_trace(&inp, &ov);
        let pi = public_inputs_from_trace(&t, 0, &js);
        assert_eq!(pi.nf, good.nf);
        refused_by_production_verifier("rho hashes absorb nf2 ‖ nf1", &t, &pi);
    }

    // (5) The whole output part moved one cycle later (RA in cycle 75): the rho hash could then
    // follow a free padding-like cycle. Built with the authors' schedule knob, read independently.
    {
        let sched = Schedule { nk2: Some(C_NK2), out: Some(C_OUT + 1) };
        let t = build_trace_with(&inp, &Overrides::default(), &sched, TRACE_LEN);
        let pi = PublicInputs {
            anchor: digest_at(&t, out_row(C_OUT - 1)),
            cm_out: [digest_at(&t, out_row(C_OUT + 3)), digest_at(&t, out_row(C_OUT + 6))],
            ..good.clone()
        };
        refused_by_production_verifier("output part (RA first) starts in cycle 75", &t, &pi);
    }

    // (6) A dummy-input transaction (shield) tries the sender-chosen rho on its zero-value output:
    // neither a dummy input nor a zero-value output opens an exemption.
    {
        let sh = sample(Kind::Shield, 0xc6);
        assert_eq!(sh.outputs[1].value, 0);
        let inp = TraceInputs::honest(&sh);
        let mut ov = Overrides::default();
        ov.init.insert(c_out(1), fresh(LEN_CM, D_CM, &sh.outputs[1].pk, &rng.digest()));
        let t = build_trace(&inp, &ov);
        let pi = public_inputs_from_trace(&t, 0, &sh);
        assert_eq!(violations(&t, &pi), (TC_LINK + 8..TC_LINK + 16).collect::<BTreeSet<_>>());
        refused_by_production_verifier("shield: zero-value output 2 with a sender-chosen rho", &t, &pi);
    }
}

/// A digest source that replays a fixed list (a sender re-using its dummy secrets on purpose).
struct Replay(Vec<Digest>, usize);
impl DigestSource for Replay {
    fn next_digest(&mut self) -> Digest {
        self.1 += 1;
        self.0[self.1 - 1]
    }
}

#[test]
fn review2_uniqueness_rests_on_the_node() {
    let mut rng = TestRng(0xb0b0);
    let victim_sk = rng.digest();
    let victim_pk = derive_pk(&victim_sk);
    let anchor = SparseTree::new().root();
    // `shield` draws, in this order: dummy_pk, then (sk, rho, r) of dummy 1, (sk, rho, r) of
    // dummy 2, then r of output 1, r of output 2. The sender replays the first seven and changes
    // only the outputs' r (and the amount).
    let fixed: Vec<Digest> = (0..7).map(|_| rng.digest()).collect();
    let mk = |v_in: u64, rng: &mut TestRng| {
        let mut d = fixed.clone();
        d.push(rng.digest());
        d.push(rng.digest());
        shield(anchor, v_in, 10, victim_pk, rng.digest(), &mut Replay(d, 0)).unwrap()
    };
    let (t1, t2) = (mk(70, &mut rng), mk(50, &mut rng));
    t1.check().unwrap();
    t2.check().unwrap();
    let (p1, p2) = (t1.public(), t2.public());
    assert_eq!(p1.nf, p2.nf, "same dummy secrets -> same public nullifier pair");
    assert_ne!(p1.cm_out, p2.cm_out, "two different transactions (different notes)");
    assert_ne!(p1.binding, p2.binding);
    // the two notes to the victim: different commitments, the SAME rho, hence the SAME nullifier
    let (n1, n2) = (t1.output_note(0), t2.output_note(0));
    assert_ne!(n1.commitment(), n2.commitment());
    assert_eq!(n1.rho, n2.rho);
    let nk = derive_nk(&victim_sk);
    assert_eq!(nullifier(&nk, &n1.rho), nullifier(&nk, &n2.rho));
    // the recipient's check passes for both
    assert!(receive_note(&p1, 0, &victim_pk, 60, &t1.outputs[0].r).is_some());
    assert!(receive_note(&p2, 0, &victim_pk, 40, &t2.outputs[0].r).is_some());
    // and BOTH are valid proofs for the production verifier
    for (js, pi, tag) in [(&t1, &p1, 1u64), (&t2, &p2, 2)] {
        let bytes = prove_spend(honest_trace(js), pi, seed(tag)).unwrap();
        verify_spend(pi, &bytes).expect("each transaction verifies on its own");
    }
    println!(
        "FORGERY|L-1|two different shield transactions from the same dummy secrets: equal (nf1, nf2), different commitments to one pk (60 and 40), EQUAL rho and EQUAL future nullifier|verify_spend ACCEPTS both proofs|what forbids the pair on chain is the node's nullifier rule of spec §4.2"
    );

    // Spec §4.2, the regression pair: the node accepts at most one of them. (The anchor the
    // research constructor used is the empty root, which is R(A - 1), so both are otherwise valid
    // at the activation height.) Both proofs verified above; the pool is what refuses the second.
    assert_eq!(digest_to_bytes(&anchor), empty_tree_root());
    let as_pool_tx = |pi: &PublicInputs| PoolTx {
        kind: TxKind::Shield,
        anchor: digest_to_bytes(&pi.anchor),
        nf: [digest_to_bytes(&pi.nf[0]), digest_to_bytes(&pi.nf[1])],
        cm_out: [digest_to_bytes(&pi.cm_out[0]), digest_to_bytes(&pi.cm_out[1])],
        v_in: pi.v_in,
        v_out: pi.v_out,
        fee: pi.fee,
        account: [0; 32],
    };
    let (x1, x2) = (as_pool_tx(&p1), as_pool_tx(&p2));
    const A: u64 = 500;
    // in two blocks
    let mut pool = Pool::open_or_init(MemoryPoolStore::new(), A).unwrap();
    pool.apply_block(A, &[x1.clone()]).expect("the first shield is accepted");
    let before = pool.store().clone();
    assert_eq!(pool.apply_block(A + 1, &[x2.clone()]), Err(PoolError::Tx { index: 0, reason: TxRefusal::NullifierSpent }));
    assert_eq!(pool.store(), &before);
    // in one block, either order
    for pair in [[x1.clone(), x2.clone()], [x2.clone(), x1.clone()]] {
        let mut pool = Pool::open_or_init(MemoryPoolStore::new(), A).unwrap();
        assert_eq!(pool.apply_block(A, &pair), Err(PoolError::Tx { index: 1, reason: TxRefusal::NullifierRepeatedInBlock }));
        assert_eq!(pool.state().unwrap().note_count, 0);
    }
    println!("FORGERY|L-1|the pool of spec §4 accepts exactly one of the two: the second is refused in the next block (nullifier in the set) and in the same block (nullifier earlier in the block), in either order");

    // A dummy's nullifier is the same function as a real note's: whoever knows (sk, rho) of a
    // real note can publish its nullifier from a dummy slot (value 0, no membership) — the owner
    // burning its own note (I-5 of the first review). Nobody else knows sk.
    let fx = fixture(&mut rng, &[100]);
    let real = real_input(&fx.notes[0]);
    let as_dummy = InputNote { enabled: false, value: 0, index: 0, path: [ZERO_DIGEST; TREE_DEPTH], ..real.clone() };
    assert_eq!(real.nullifier(), as_dummy.nullifier());
    println!("REVIEW2|B|a dummy input with the (sk, rho) of a real note publishes that note's nullifier (needs sk: self-inflicted only)");
}

// ---- research/shield3/tests/shield3.rs: F-2 -----------------------------------------------------

fn cm_outs(t: &Trace) -> [Digest; 2] {
    [digest_at(t, out_row(c_out(0) + 1)), digest_at(t, out_row(c_out(1) + 1))]
}

// =================================================================================================
// F-2
// =================================================================================================

#[test]
fn f2_output_rho_must_be_the_derived_one() {
    let link_rho_slot = set(TC_LINK + DIGEST, DIGEST); // rate[8..16] of OA1 / OB1
    let link_nf1 = set(TC_LINK, DIGEST); // rate[0..8] of RA / RB
    let link_nf2 = set(TC_LINK + DIGEST, DIGEST); // rate[8..16] of RA / RB
    let link_idx: BTreeSet<usize> = [TC_LINK + CAP + 2].into();

    // the three operations: rho is defined for all of them (a shield has two dummy inputs, whose
    // nullifiers are published like any other)
    for (kind, tag) in [(Kind::Transfer, 1u64), (Kind::Shield, 2), (Kind::Unshield, 3)] {
        let js = sample(kind, 0xf2_00 + tag);
        let inp = TraceInputs::honest(&js);
        let honest = build_trace(&inp, &Overrides::default());
        let good = js.public();
        let nf = good.nf;
        assert_eq!(public_inputs_from_trace(&honest, 0, &js).cm_out, good.cm_out);
        let mut rng = TestRng(0xf2f2 + tag);
        let k = format!("{kind:?}");

        if kind == Kind::Transfer {
            must_accept("honest trace (rho derived)", &honest, &good);
        }

        for j in 0..2 {
            let pk = js.outputs[j].pk;
            let o = j + 1;

            // (a) ANY other rho in the commitment: a random one
            let mut ov = Overrides::default();
            ov.init.insert(c_out(j), fresh(LEN_CM, D_CM, &pk, &rng.digest()));
            let t = build_trace(&inp, &ov);
            let pi = PublicInputs { cm_out: cm_outs(&t), ..good.clone() };
            assert_ne!(pi.cm_out[j], good.cm_out[j]);
            must_reject_with(&format!("{k}: output {o} commits to a rho chosen by the sender"), &t, &pi, Some(&link_rho_slot));

            if kind != Kind::Transfer {
                continue; // the remaining variants once per output, on the transfer
            }

            // (a2) a rho that differs from the derived one in a single element
            let mut rho1 = js.rho_out(j);
            rho1[5] += Felt::ONE;
            let mut ov = Overrides::default();
            ov.init.insert(c_out(j), fresh(LEN_CM, D_CM, &pk, &rho1));
            let t = build_trace(&inp, &ov);
            let pi = PublicInputs { cm_out: cm_outs(&t), ..good.clone() };
            must_reject_with(&format!("{k}: output {o}: derived rho with element 5 changed"), &t, &pi, Some(&[TC_LINK + DIGEST + 5].into()));

            // (b) rho derived with the WRONG INDEX: the rho hash of output j runs with the other
            // output's index, and with an index that no output has
            for (wrong, what) in [(1 - j, "the other output's index"), (2, "index 2")] {
                let mut ov = Overrides::default();
                ov.init.insert(c_rho(j), fresh_rho(&nf, wrong));
                let t = build_trace(&inp, &ov);
                let pi = PublicInputs { cm_out: cm_outs(&t), ..good.clone() };
                assert_eq!(digest_at(&t, out_row(c_rho(j))), derive_rho(&nf, wrong));
                must_reject_with(&format!("{k}: output {o}: rho hashed with {what}"), &t, &pi, Some(&link_idx));
            }

            // (c) nf1 / nf2 SWAPPED in the rho hash
            let mut ov = Overrides::default();
            ov.init.insert(c_rho(j), fresh_rho(&[nf[1], nf[0]], j));
            let t = build_trace(&inp, &ov);
            let pi = PublicInputs { cm_out: cm_outs(&t), ..good.clone() };
            must_reject_with(
                &format!("{k}: output {o}: rho = H_rho(nf2, nf1, j) (swapped)"),
                &t,
                &pi,
                Some(&link_nf1.union(&link_nf2).copied().collect()),
            );

            // (d) the OTHER output's (correctly derived) rho in this output's commitment
            let mut ov = Overrides::default();
            ov.init.insert(c_out(j), fresh(LEN_CM, D_CM, &pk, &derive_rho(&nf, 1 - j)));
            let t = build_trace(&inp, &ov);
            let pi = PublicInputs { cm_out: cm_outs(&t), ..good.clone() };
            must_reject_with(&format!("{k}: output {o} commits to the other output's rho"), &t, &pi, Some(&link_rho_slot));

            // (e) rho derived from DIFFERENT NULLIFIERS than the public ones: one, the other, both
            // (for example the nullifiers of an older transaction, to re-create an old rho)
            let other = [rng.digest(), rng.digest()];
            for (pair, what, want) in [
                ([other[0], nf[1]], "another nf1", link_nf1.clone()),
                ([nf[0], other[1]], "another nf2", link_nf2.clone()),
                (other, "two other nullifiers", link_nf1.union(&link_nf2).copied().collect()),
            ] {
                let mut ov = Overrides::default();
                ov.init.insert(c_rho(j), fresh_rho(&pair, j));
                let t = build_trace(&inp, &ov);
                let pi = PublicInputs { cm_out: cm_outs(&t), ..good.clone() };
                assert_eq!(digest_at(&t, out_row(c_rho(j))), derive_rho(&pair, j));
                must_reject_with(&format!("{k}: output {o}: rho derived from {what} than the public ones"), &t, &pi, Some(&want));
            }

            // (f) the rho hash under another domain tag (the nullifier tag: rho would be a value
            // of the nullifier hash) / with another length
            for (el, val, what) in [(CAP + 1, D_NF, "the nullifier domain tag"), (CAP, LEN_CM, "another length")] {
                let mut st = fresh_rho(&nf, j);
                st[el] = Felt::from_u32(val);
                let mut ov = Overrides::default();
                ov.init.insert(c_rho(j), st);
                let t = build_trace(&inp, &ov);
                let pi = PublicInputs { cm_out: cm_outs(&t), ..good.clone() };
                must_reject_with(&format!("{k}: output {o}: rho hashed under {what}"), &t, &pi, Some(&[TC_LINK + el].into()));
            }

            // (g) the digest row of the rho hash overwritten with a chosen rho (the commitment
            // then links correctly to that row): the last round of the rho hash objects
            let chosen = rng.digest();
            let mut ov = Overrides::default();
            for e in 0..DIGEST {
                ov.cells.push((S + e, out_row(c_rho(j)), chosen[e]));
            }
            ov.init.insert(c_out(j), fresh(LEN_CM, D_CM, &pk, &chosen));
            let t = build_trace(&inp, &ov);
            let pi = PublicInputs { cm_out: cm_outs(&t), ..good.clone() };
            let v = violations(&t, &pi);
            assert!(!v.is_empty() && v.iter().all(|c| (TC_ROUND..TC_ROUND + STATE_WIDTH).contains(c)), "{:?}", names(&v));
            must_reject_with(&format!("{k}: output {o}: digest row of the rho hash overwritten"), &t, &pi, Some(&v));
        }

        if kind != Kind::Transfer {
            continue;
        }
        // (h) the rho cycle of output 1 declared "free" (RA selector cleared), its state chosen:
        // the selector chain objects (the Merkle run would have to continue, and OA1 needs RA)
        let chosen = rng.digest();
        let mut st = [Felt::ZERO; STATE_WIDTH];
        st[..8].copy_from_slice(&chosen);
        let mut ov = Overrides::default();
        ov.init.insert(c_rho(0), st);
        for r in 0..CYCLE {
            ov.cells.push((SEL + X_RA, first_row(c_rho(0)) + r, Felt::ZERO));
        }
        let t = build_trace(&inp, &ov);
        let pi = PublicInputs { cm_out: cm_outs(&t), ..good.clone() };
        must_reject_with(
            "Transfer: RA selector cleared, free rho cycle",
            &t,
            &pi,
            Some(&[TC_SEL_STEP + X_MK, TC_SEL_STEP + X_OA1].into()),
        );
        // (i) the same for output 2 (RB follows OA2 in the chain; OB1 needs RB)
        let mut ov = Overrides::default();
        ov.init.insert(c_rho(1), st);
        for r in 0..CYCLE {
            ov.cells.push((SEL + X_RB, first_row(c_rho(1)) + r, Felt::ZERO));
        }
        let t = build_trace(&inp, &ov);
        let pi = PublicInputs { cm_out: cm_outs(&t), ..good.clone() };
        must_reject_with(
            "Transfer: RB selector cleared, free rho cycle",
            &t,
            &pi,
            Some(&[TC_SEL_STEP + X_RB, TC_SEL_STEP + X_OB1].into()),
        );
    }
    println!(
        "FORGERY|F-2|summary|forced-trace verifier runs, all refused: {}",
        RUNS.load(std::sync::atomic::Ordering::Relaxed)
    );
}

/// Why two different transactions cannot produce the same rho, checked on the reference: rho is
/// a function of (nf1, nf2, j); changing any of the three changes it; and a wallet-level view of
/// the reviewer's two attacks (same rho twice; rho of an already-spent note).
#[test]
fn f2_rho_is_unique_per_transaction_and_output() {
    let mut rng = TestRng(0xf2_0b);
    let mut seen = std::collections::HashSet::new();
    let mut n = 0;
    for tx in 0..200u64 {
        let kind = [Kind::Shield, Kind::Transfer, Kind::Transfer1, Kind::Unshield, Kind::Unshield2][(tx % 5) as usize];
        let js = sample(kind, 0x7000 + tx);
        let nf = js.nullifiers();
        for j in 0..2 {
            let rho = js.rho_out(j);
            assert_eq!(rho, derive_rho(&nf, j));
            assert!(seen.insert(rho.map(|x| format!("{x:?}"))), "rho collision between transactions");
            n += 1;
        }
        // swapping the nullifiers, or replacing one, gives other values
        assert_ne!(derive_rho(&[nf[1], nf[0]], 0), derive_rho(&nf, 0));
        assert_ne!(derive_rho(&[nf[0], rng.digest()], 0), derive_rho(&nf, 0));
        assert_ne!(derive_rho(&nf, 0), derive_rho(&nf, 1));
        // H_rho is not any other hash of the same 16 elements
        assert_ne!(derive_rho(&nf, 0), nullifier(&nf[0], &nf[1]));
        assert_ne!(derive_rho(&nf, 0), merge(&nf[0], &nf[1]));
        assert_ne!(derive_rho(&nf, 1), merge(&nf[0], &nf[1]));
    }
    println!("FORGERY|F-2|rho uniqueness|{n} output rho of 200 honest transactions (5 kinds): all distinct; index, order and each nullifier change the value; H_rho differs from the nullifier and Merkle hashes of the same input");
}

