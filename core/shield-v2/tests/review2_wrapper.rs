//! Second independent review (SHIELD-3 delta) — the verifier wrapper: `verify_spend(public, bytes)`
//! with its length cap, canonical-encoding check, height pin and nullifier check. Ported from
//! `research/shield3/tests/review2_wrapper.rs`; runs in a DEFAULT build on the committed vectors.
//! With the `test-prover` feature it also uses fresh proofs and the library-only control.
//!
//! * `review2_overlong_varint_at_every_byte` — the over-long rewrite `b -> (b | 0x80, 0x00)` at
//!   EVERY byte position of a valid proof. Every rewrite that is a true re-encoding must be refused
//!   as non-canonical; the positions found are the complete list of varints of the proof, which is
//!   then used to change every length / usize by +1 and -1.
//! * `review2_typed_mutations_canonically_encoded` — the proof is decoded into the library's own
//!   `Proof` type (named here independently of `src/verifier.rs`), one field is changed, and the
//!   result is re-serialised: a CANONICAL encoding of a different proof. This goes past the
//!   canonical check into the library verifier with shapes no prover emits. Must be refused,
//!   must not panic. Includes the candidates for a second valid proof of the same statement
//!   (zero-difficulty proof-of-work witnesses, an extra zero coefficient, duplicated entries).
//! * `review2_allocation_and_time_before_refusal` — a counting global allocator measures what
//!   `verify_spend` allocates and how long it takes on hostile inputs up to the cap (huge claimed
//!   lengths, as many empty vectors as fit, long vectors in every position), and that an over-long
//!   input allocates nothing at all.
//! * `review2_byte_flip_sweep` — one bit flipped in every third byte (every 4-byte field element
//!   and every digest is hit), in-process with `catch_unwind`: 0 accepted, 0 panics.
//! * `review2_proof_length_bound` — the largest possible honest proof under the pinned parameters
//!   (spec §7, C-1: 194,893 bytes). MUST be kept (spec §7, C-1).
//!
//! Run: `cargo test --release -p quantum-vault-shield-v2 -j 1 --test review2_wrapper -- --nocapture --test-threads=1`

mod common;

use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::time::{Duration, Instant};

use common::{kind, library_only, vector};
use p3_blake3::Blake3;
use p3_challenger::{HashChallenger, SerializingChallenger32};
use p3_commit::ExtensionMmcs;
use p3_dft::Radix2DitParallel;
use p3_field::PrimeCharacteristicRing;
use p3_field::extension::BinomialExtensionField;
use p3_fri::HidingFriPcs;
use p3_merkle_tree::MerkleTreeHidingMmcs;
use p3_symmetric::{CompressionFunctionFromHasher, SerializingHasher};
use p3_uni_stark::{PreprocessedOpenedValues, Proof, StarkConfig};
use quantum_vault_shield_v2::reference::*;
use quantum_vault_shield_v2::{Felt, MAX_PROOF_BYTES, verify_spend};
use rand::rngs::StdRng;

type EF8 = BinomialExtensionField<Felt, 8>;

// ---- counting allocator ---------------------------------------------------------------------------

struct Counting;
static CUR: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static CALLS: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(l) };
        if !p.is_null() {
            let c = CUR.fetch_add(l.size(), Relaxed) + l.size();
            PEAK.fetch_max(c, Relaxed);
            CALLS.fetch_add(1, Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) };
        CUR.fetch_sub(l.size(), Relaxed);
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        let q = unsafe { System.realloc(p, l, new) };
        if !q.is_null() {
            if new >= l.size() {
                let c = CUR.fetch_add(new - l.size(), Relaxed) + (new - l.size());
                PEAK.fetch_max(c, Relaxed);
            } else {
                CUR.fetch_sub(l.size() - new, Relaxed);
            }
            CALLS.fetch_add(1, Relaxed);
        }
        q
    }
}

#[global_allocator]
static ALLOC: Counting = Counting;

/// (result, peak bytes allocated above the level at entry, allocator calls, wall time)
fn measured<T>(f: impl FnOnce() -> T) -> (T, usize, usize, Duration) {
    let base = CUR.load(Relaxed);
    PEAK.store(base, Relaxed);
    let calls = CALLS.load(Relaxed);
    let t0 = Instant::now();
    let out = f();
    let dt = t0.elapsed();
    (out, PEAK.load(Relaxed).saturating_sub(base), CALLS.load(Relaxed) - calls, dt)
}

// ---- the production proof type, named independently of src/config.rs ------------------------------

type Dft = Radix2DitParallel<Felt>;
type FieldHash = SerializingHasher<Blake3>;
type Compress = CompressionFunctionFromHasher<Blake3, 2, 32>;
type Challenger = SerializingChallenger32<Felt, HashChallenger<u8, Blake3, 32>>;
type Mmcs = MerkleTreeHidingMmcs<Felt, u8, FieldHash, Compress, StdRng, 2, 32, 5>;
type Cfg = StarkConfig<HidingFriPcs<Felt, Dft, Mmcs, ExtensionMmcs<Felt, EF8, Mmcs>, StdRng>, EF8, Challenger>;
type P = Proof<Cfg>;

fn decode(bytes: &[u8]) -> P {
    postcard::from_bytes(bytes).expect("the reviewer's type decodes a production proof")
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Outcome {
    Accepted,
    Panicked,
    Refused(&'static str),
}

type Caught = Result<Result<(), quantum_vault_shield_v2::VerifyError>, Box<dyn std::any::Any + Send>>;

fn outcome_of(r: Caught) -> (Outcome, String) {
    match r {
        Ok(Ok(())) => (Outcome::Accepted, String::new()),
        Ok(Err(e)) if kind(&e) == "Panicked" => (Outcome::Panicked, format!("{e:?}")),
        Ok(Err(e)) => (Outcome::Refused(kind(&e)), format!("{e:?}")),
        Err(p) => {
            let msg = p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
            (Outcome::Panicked, msg)
        }
    }
}

/// The production verifier, with a panic turned into an outcome.
fn run(pi: &PublicInputs, bytes: &[u8]) -> (Outcome, String) {
    outcome_of(std::panic::catch_unwind(|| verify_spend(pi, bytes)))
}

/// `run`, measured: only the verifier call is inside the measurement (the outcome's log text is
/// formatted afterwards — the research `kind()` did not allocate, this crate's reads `Debug`).
fn measured_run(pi: &PublicInputs, bytes: &[u8]) -> ((Outcome, String), usize, usize, Duration) {
    let (r, peak, calls, dt) = measured(|| std::panic::catch_unwind(|| verify_spend(pi, bytes)));
    (outcome_of(r), peak, calls, dt)
}

fn short(s: &str) -> &str {
    &s[..s.len().min(90)]
}

// =================================================================================================

#[test]
fn review2_overlong_varint_at_every_byte() {
    let (pi, proof) = vector("transfer");
    let n = proof.len();
    verify_spend(&pi, &proof).expect("committed vector verifies");
    // the reviewer's own type and the crate's agree on the encoding
    assert_eq!(postcard::to_allocvec(&decode(&proof)).unwrap(), proof);

    let mut tally: BTreeMap<Outcome, usize> = BTreeMap::new();
    let mut varints: Vec<usize> = Vec::new(); // positions of the last byte of every real varint
    let mut tried = 0usize;
    for p in 0..n {
        if proof[p] >= 0x80 {
            continue;
        }
        let mut v = Vec::with_capacity(n + 1);
        v.extend_from_slice(&proof[..p]);
        v.extend_from_slice(&[proof[p] | 0x80, 0x00]);
        v.extend_from_slice(&proof[p + 1..]);
        tried += 1;
        let (o, _) = run(&pi, &v);
        if o == Outcome::Refused("NonCanonicalEncoding") && library_only(&pi, &v) != Some(false) {
            varints.push(p);
        }
        *tally.entry(o).or_default() += 1;
    }
    println!(
        "REVIEW2|over-long varint at every byte|{tried} rewrites (every byte < 0x80 of a {n}-byte proof)|{tally:?}|true re-encodings of the same proof ({}): {} — all refused as NonCanonicalEncoding",
        if library_only(&pi, &proof).is_some() { "library verifier alone accepts" } else { "refused as NonCanonicalEncoding; the library-only control needs the test-prover feature" },
        varints.len()
    );
    assert_eq!(tally.get(&Outcome::Accepted), None, "A NON-CANONICAL ENCODING IS ACCEPTED");
    assert_eq!(tally.get(&Outcome::Panicked), None);
    assert!(varints.len() > 100, "expected every vector length of the proof: {}", varints.len());

    // two redundant bytes at each real varint, and at the same places a continuation byte with a
    // non-zero payload that overflows nothing (0x80 0x80 0x00)
    let mut tally2: BTreeMap<Outcome, usize> = BTreeMap::new();
    for &p in &varints {
        for tail in [&[0x80u8, 0x00][..], &[0x80, 0x80, 0x00], &[0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00]] {
            let mut v = proof[..p].to_vec();
            v.push(proof[p] | 0x80);
            v.extend_from_slice(tail);
            v.extend_from_slice(&proof[p + 1..]);
            *tally2.entry(run(&pi, &v).0).or_default() += 1;
        }
    }
    println!("REVIEW2|longer over-long forms at the {} real varints (2, 3 and 9 redundant bytes)|{tally2:?}", varints.len());
    assert_eq!(tally2.get(&Outcome::Accepted), None);
    assert_eq!(tally2.get(&Outcome::Panicked), None);

    // every length / usize of the proof changed by +1 and -1 (single-byte varints only: a
    // canonical encoding of a DIFFERENT shape)
    let mut tally3: BTreeMap<Outcome, usize> = BTreeMap::new();
    let mut slowest = Duration::ZERO;
    for &p in &varints {
        if p > 0 && proof[p - 1] >= 0x80 {
            continue; // last byte of a multi-byte varint
        }
        for delta in [1i16, -1] {
            let b = proof[p] as i16 + delta;
            if !(0..0x80).contains(&b) {
                continue;
            }
            let mut v = proof.clone();
            v[p] = b as u8;
            let t0 = Instant::now();
            *tally3.entry(run(&pi, &v).0).or_default() += 1;
            slowest = slowest.max(t0.elapsed());
        }
    }
    println!("REVIEW2|every single-byte length / usize of the proof +1 and -1|{tally3:?}|slowest refusal {slowest:?}");
    assert_eq!(tally3.get(&Outcome::Accepted), None);
    assert_eq!(tally3.get(&Outcome::Panicked), None);
}

// =================================================================================================

type Mutation = (&'static str, Box<dyn Fn(&mut P)>);

fn mutations() -> Vec<Mutation> {
    let one = EF8::ONE;
    let mut m: Vec<Mutation> = Vec::new();
    macro_rules! add {
        ($name:expr, $p:ident => $body:expr) => {
            m.push(($name, Box::new(move |$p: &mut P| {
                $body;
            })));
        };
    }
    // --- candidates for a SECOND VALID PROOF of the same statement (semantic malleability) ---
    add!("MALLEABILITY? ood_pow_witness = 1 (zero difficulty)", p => p.ood_pow_witness = Felt::ONE);
    add!("MALLEABILITY? batch_pow_witness = 1 (zero difficulty)", p => p.opening_proof.1.batch_pow_witness = Felt::ONE);
    add!("MALLEABILITY? commit_pow_witnesses[0] = 1 (zero difficulty)", p => p.opening_proof.1.commit_pow_witnesses[0] = Felt::ONE);
    add!("MALLEABILITY? commit_pow_witnesses[last] = 1", p => *p.opening_proof.1.commit_pow_witnesses.last_mut().unwrap() = Felt::ONE);
    add!("MALLEABILITY? final_poly: one more zero coefficient", p => p.opening_proof.1.final_poly.push(EF8::ZERO));
    add!("MALLEABILITY? commit_pow_witnesses: one more zero", p => p.opening_proof.1.commit_pow_witnesses.push(Felt::ZERO));
    add!("MALLEABILITY? query_pow_witness + 1", p => p.opening_proof.1.query_pow_witness += Felt::ONE);
    add!("MALLEABILITY? input_openings: first batch repeated at the end", p => { let x = p.opening_proof.1.input_openings[0].clone(); p.opening_proof.1.input_openings.push(x) });
    add!("input_openings: last batch repeated (commit-phase openings dropped to stay under the cap)", p => { let x = p.opening_proof.1.input_openings.last().unwrap().clone(); p.opening_proof.1.input_openings.push(x); p.opening_proof.1.commit_phase_openings.clear() });
    add!("MALLEABILITY? commit_phase_openings: last round repeated", p => { let x = p.opening_proof.1.commit_phase_openings.last().unwrap().clone(); p.opening_proof.1.commit_phase_openings.push(x) });
    add!("MALLEABILITY? commit_phase_commits: last repeated", p => { let x = p.opening_proof.1.commit_phase_commits.last().unwrap().clone(); p.opening_proof.1.commit_phase_commits.push(x) });
    add!("MALLEABILITY? salts of query 0, batch 0: one more zero salt element", p => p.opening_proof.1.input_openings[0].opening_proof.0[0][0].push(Felt::ZERO));
    add!("MALLEABILITY? salts of batch 0: one more query", p => { let x = p.opening_proof.1.input_openings[0].opening_proof.0[0].clone(); p.opening_proof.1.input_openings[0].opening_proof.0.push(x) });
    add!("MALLEABILITY? input opened values: one more query row", p => { let x = p.opening_proof.1.input_openings[0].opened_values[0].clone(); p.opening_proof.1.input_openings[0].opened_values.push(x) });
    add!("MALLEABILITY? sibling_values of round 0: one more query", p => { let x = p.opening_proof.1.commit_phase_openings[0].sibling_values[0].clone(); p.opening_proof.1.commit_phase_openings[0].sibling_values.push(x) });
    // --- degree_bits ---
    add!("degree_bits = 12", p => p.degree_bits = 12);
    add!("degree_bits = 14", p => p.degree_bits = 14);
    add!("degree_bits = 0", p => p.degree_bits = 0);
    add!("degree_bits = 64", p => p.degree_bits = 64);
    add!("degree_bits = usize::MAX", p => p.degree_bits = usize::MAX);
    // --- commitments ---
    add!("commitments.random = None", p => p.commitments.random = None);
    add!("commitments: trace <-> quotient", p => std::mem::swap(&mut p.commitments.trace, &mut p.commitments.quotient_chunks));
    // --- out-of-domain openings: shapes ---
    add!("trace_local[0] + 1", p => p.opened_values.trace_local[0] += one);
    add!("trace_local[83] + 1 (selector RB)", p => p.opened_values.trace_local[83] += one);
    add!("trace_local: one fewer", p => { p.opened_values.trace_local.pop(); });
    add!("trace_local: one more", p => p.opened_values.trace_local.push(one));
    add!("trace_local: empty", p => p.opened_values.trace_local.clear());
    add!("trace_next = None", p => p.opened_values.trace_next = None);
    add!("trace_next: empty", p => p.opened_values.trace_next = Some(vec![]));
    add!("trace_next: one fewer", p => { p.opened_values.trace_next.as_mut().unwrap().pop(); });
    add!("trace_local and trace_next: one fewer each", p => { p.opened_values.trace_local.pop(); p.opened_values.trace_next.as_mut().unwrap().pop(); });
    add!("preprocessed = Some([1])", p => p.opened_values.preprocessed = Some(PreprocessedOpenedValues { local: vec![one], next: None }));
    add!("preprocessed = Some([1], [1])", p => p.opened_values.preprocessed = Some(PreprocessedOpenedValues { local: vec![one], next: Some(vec![one]) }));
    add!("quotient_chunks: empty", p => p.opened_values.quotient_chunks.clear());
    add!("quotient_chunks: one fewer", p => { p.opened_values.quotient_chunks.pop(); });
    add!("quotient_chunks: one more", p => { let x = p.opened_values.quotient_chunks[0].clone(); p.opened_values.quotient_chunks.push(x) });
    add!("quotient_chunks[0]: empty", p => p.opened_values.quotient_chunks[0].clear());
    add!("quotient_chunks[0]: two elements", p => p.opened_values.quotient_chunks[0].push(one));
    add!("quotient_chunks: all empty", p => p.opened_values.quotient_chunks.iter_mut().for_each(Vec::clear));
    add!("random = None", p => p.opened_values.random = None);
    add!("random: empty", p => p.opened_values.random = Some(vec![]));
    add!("random: one more", p => p.opened_values.random.as_mut().unwrap().push(one));
    add!("random = None and commitments.random = None", p => { p.opened_values.random = None; p.commitments.random = None });
    // --- the hiding PCS's openings of its random codewords ---
    add!("pcs random-codeword openings: empty", p => p.opening_proof.0.clear());
    add!("pcs random-codeword openings: [[]]", p => p.opening_proof.0 = vec![vec![]]);
    add!("pcs random-codeword openings: [[[]]]", p => p.opening_proof.0 = vec![vec![vec![]]]);
    add!("pcs random-codeword openings: [[[[]]]] x 3", p => p.opening_proof.0 = vec![vec![vec![vec![]]]; 3]);
    add!("pcs random-codeword openings: last round dropped", p => { p.opening_proof.0.pop(); });
    add!("pcs random-codeword openings: one more round", p => { let x = p.opening_proof.0[0].clone(); p.opening_proof.0.push(x) });
    add!("pcs random-codeword openings: [0][0] dropped", p => { p.opening_proof.0[0].pop(); });
    add!("pcs random-codeword openings: [0][0][0] dropped", p => { p.opening_proof.0[0][0].pop(); });
    add!("pcs random-codeword openings: [0][0][0]: one fewer value", p => { p.opening_proof.0[0][0][0].pop(); });
    add!("pcs random-codeword openings: [0][0][0]: one more value", p => p.opening_proof.0[0][0][0].push(one));
    add!("pcs random-codeword openings: [0][0][0][0] + 1", p => p.opening_proof.0[0][0][0][0] += one);
    // --- FRI ---
    add!("commit_phase_commits: empty", p => p.opening_proof.1.commit_phase_commits.clear());
    add!("commit_phase_commits: one fewer", p => { p.opening_proof.1.commit_phase_commits.pop(); });
    add!("commit_phase_commits and commit_phase_openings and pow witnesses: one fewer each", p => { p.opening_proof.1.commit_phase_commits.pop(); p.opening_proof.1.commit_phase_openings.pop(); p.opening_proof.1.commit_pow_witnesses.pop(); });
    add!("commit_phase_commits: [0] <-> [1]", p => p.opening_proof.1.commit_phase_commits.swap(0, 1));
    add!("commit_pow_witnesses: empty", p => p.opening_proof.1.commit_pow_witnesses.clear());
    add!("commit_pow_witnesses: one fewer", p => { p.opening_proof.1.commit_pow_witnesses.pop(); });
    add!("final_poly: empty", p => p.opening_proof.1.final_poly.clear());
    add!("final_poly: one fewer", p => { p.opening_proof.1.final_poly.pop(); });
    add!("final_poly[0] + 1", p => p.opening_proof.1.final_poly[0] += one);
    add!("final_poly: 256 zero coefficients more", p => p.opening_proof.1.final_poly.extend(std::iter::repeat_n(EF8::ZERO, 256)));
    add!("input_openings: empty", p => p.opening_proof.1.input_openings.clear());
    add!("input_openings: one fewer", p => { p.opening_proof.1.input_openings.pop(); });
    add!("input_openings: [0] <-> [1]", p => p.opening_proof.1.input_openings.swap(0, 1));
    add!("input_openings[0].opened_values: empty", p => p.opening_proof.1.input_openings[0].opened_values.clear());
    add!("input_openings[0].opened_values: one fewer query", p => { p.opening_proof.1.input_openings[0].opened_values.pop(); });
    add!("input_openings[*].opened_values and salts: one fewer query each", p => for b in p.opening_proof.1.input_openings.iter_mut() { b.opened_values.pop(); b.opening_proof.0.pop(); });
    add!("input_openings[0].opened_values: query 0 <-> 1", p => p.opening_proof.1.input_openings[0].opened_values.swap(0, 1));
    add!("input_openings[0].opened_values[0]: empty", p => p.opening_proof.1.input_openings[0].opened_values[0].clear());
    add!("input_openings[0].opened_values[0][0]: empty", p => p.opening_proof.1.input_openings[0].opened_values[0][0].clear());
    add!("input_openings[0].opened_values[0][0]: one fewer", p => { p.opening_proof.1.input_openings[0].opened_values[0][0].pop(); });
    add!("input_openings[0].opened_values[0][0]: one more", p => p.opening_proof.1.input_openings[0].opened_values[0][0].push(Felt::ZERO));
    add!("input_openings[0].opened_values[0][0][0] + 1", p => p.opening_proof.1.input_openings[0].opened_values[0][0][0] += Felt::ONE);
    add!("input_openings[0].opened_values[44][0][last] + 1", p => *p.opening_proof.1.input_openings[0].opened_values[44][0].last_mut().unwrap() += Felt::ONE);
    add!("input_openings[0] salts: empty", p => p.opening_proof.1.input_openings[0].opening_proof.0.clear());
    add!("input_openings[0] salts[0]: empty", p => p.opening_proof.1.input_openings[0].opening_proof.0[0].clear());
    add!("input_openings[0] salts[0][0]: empty", p => p.opening_proof.1.input_openings[0].opening_proof.0[0][0].clear());
    add!("input_openings[0] salts[0][0][0] + 1", p => p.opening_proof.1.input_openings[0].opening_proof.0[0][0][0] += Felt::ONE);
    add!("input_openings[0] salts: query 0 <-> 1", p => p.opening_proof.1.input_openings[0].opening_proof.0.swap(0, 1));
    add!("commit_phase_openings: empty", p => p.opening_proof.1.commit_phase_openings.clear());
    add!("commit_phase_openings: one fewer", p => { p.opening_proof.1.commit_phase_openings.pop(); });
    add!("commit_phase_openings: [0] <-> [1]", p => p.opening_proof.1.commit_phase_openings.swap(0, 1));
    add!("commit_phase_openings[0].sibling_values: empty", p => p.opening_proof.1.commit_phase_openings[0].sibling_values.clear());
    add!("commit_phase_openings[0].sibling_values: one fewer", p => { p.opening_proof.1.commit_phase_openings[0].sibling_values.pop(); });
    add!("commit_phase_openings[0].sibling_values[0]: empty", p => p.opening_proof.1.commit_phase_openings[0].sibling_values[0].clear());
    add!("commit_phase_openings[0].sibling_values[0]: one more", p => p.opening_proof.1.commit_phase_openings[0].sibling_values[0].push(one));
    add!("commit_phase_openings[0].sibling_values[0]: one fewer", p => { p.opening_proof.1.commit_phase_openings[0].sibling_values[0].pop(); });
    add!("commit_phase_openings[*].sibling_values[*]: all empty", p => for r in p.opening_proof.1.commit_phase_openings.iter_mut() { r.sibling_values.iter_mut().for_each(Vec::clear) });
    add!("commit_phase_openings[0].sibling_values[0][0] + 1", p => p.opening_proof.1.commit_phase_openings[0].sibling_values[0][0] += one);
    add!("commit_phase_openings[last].sibling_values[44][0] + 1", p => p.opening_proof.1.commit_phase_openings.last_mut().unwrap().sibling_values[44][0] += one);
    add!("everything inside the FRI proof emptied", p => { let f = &mut p.opening_proof.1; f.commit_phase_commits.clear(); f.commit_pow_witnesses.clear(); f.input_openings.clear(); f.commit_phase_openings.clear(); f.final_poly.clear(); });
    m
}

#[test]
fn review2_typed_mutations_canonically_encoded() {
    let (pi, proof) = vector("transfer");
    let shape = decode(&proof);
    let f = &shape.opening_proof.1;
    println!(
        "REVIEW2|proof shape|trace_local {} trace_next {:?} quotient chunks {} random {:?}|pcs random openings: rounds {}|fri: commits {} pow witnesses {} input batches {} (queries {}, matrices {:?}) rounds {} final_poly {}",
        shape.opened_values.trace_local.len(),
        shape.opened_values.trace_next.as_ref().map(Vec::len),
        shape.opened_values.quotient_chunks.len(),
        shape.opened_values.random.as_ref().map(Vec::len),
        shape.opening_proof.0.len(),
        f.commit_phase_commits.len(),
        f.commit_pow_witnesses.len(),
        f.input_openings.len(),
        f.input_openings[0].opened_values.len(),
        f.input_openings.iter().map(|b| b.opened_values[0].iter().map(Vec::len).collect::<Vec<_>>()).collect::<Vec<_>>(),
        f.commit_phase_openings.len(),
        f.final_poly.len(),
    );
    // identity mutation: the harness accepts what it should
    assert_eq!(run(&pi, &postcard::to_allocvec(&decode(&proof)).unwrap()).0, Outcome::Accepted);

    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let mut tally: BTreeMap<Outcome, usize> = BTreeMap::new();
    let mut bad: Vec<String> = Vec::new();
    let mut slowest = (Duration::ZERO, "");
    let muts = mutations();
    for (name, f) in &muts {
        let mut p = decode(&proof);
        f(&mut p);
        let bytes = postcard::to_allocvec(&p).unwrap();
        assert_ne!(bytes, proof, "{name}: the mutation changed nothing");
        // it IS a canonical encoding: decode and re-encode give the same bytes
        let again: Result<P, _> = postcard::from_bytes(&bytes);
        let canonical = again.map(|q| postcard::to_allocvec(&q).unwrap() == bytes).unwrap_or(false);
        let ((o, msg), peak, _, dt) = measured_run(&pi, &bytes);
        if dt > slowest.0 {
            slowest = (dt, name);
        }
        println!("REVIEW2|typed|{name}|{} B|canonical encoding: {canonical}|{o:?} {}|{dt:?}, peak {} KiB", bytes.len(), short(&msg), peak / 1024);
        if matches!(o, Outcome::Accepted | Outcome::Panicked) {
            bad.push(format!("{name}: {o:?} {msg}"));
        }
        *tally.entry(o).or_default() += 1;
    }
    std::panic::set_hook(prev);
    println!("REVIEW2|typed mutations, each re-serialised canonically|{} cases|{tally:?}|slowest refusal {:?} ({})", muts.len(), slowest.0, slowest.1);
    assert!(bad.is_empty(), "ACCEPTED or PANICKED: {bad:#?}");
}

// =================================================================================================

#[test]
fn review2_allocation_and_time_before_refusal() {
    let (pi, proof) = vector("transfer");
    let cap = MAX_PROOF_BYTES;

    // baseline: an honest verification
    let ((o, _), peak, calls, dt) = measured_run(&pi, &proof);
    assert_eq!(o, Outcome::Accepted);
    println!("REVIEW2|alloc|honest proof, {} B|accepted|peak {} KiB, {calls} allocator calls, {dt:?}", proof.len(), peak / 1024);
    let honest_peak = peak;

    // above the cap: refused without a single allocation, whatever the size
    for len in [cap + 1, 1 << 20, 64 << 20] {
        let big = vec![0xffu8; len];
        let ((o, _), peak, calls, dt) = measured_run(&pi, &big);
        println!("REVIEW2|alloc|{len} bytes of 0xff|{o:?}|peak {peak} B, {calls} allocator calls, {dt:?}");
        assert_eq!(o, Outcome::Refused("TooLong"));
        assert!(peak < 4096 && calls <= 4, "the cap is not applied before parsing");
    }
    let mut padded = proof.clone();
    padded.resize(cap + 1, 0);
    let ((o, _), peak, calls, _) = measured_run(&pi, &padded);
    assert_eq!(o, Outcome::Refused("TooLong"));
    assert!(peak < 4096 && calls <= 4);

    // hostile inputs of at most `cap` bytes
    let mut worst = (0usize, Duration::ZERO, String::new(), String::new());
    let mut hostile: Vec<(String, Vec<u8>)> = Vec::new();
    for b in [0x00u8, 0x01, 0x7f, 0x80, 0xff] {
        hostile.push((format!("{cap} bytes of {b:#04x}"), vec![b; cap]));
    }
    // a maximal claimed length (2^64 - 1) in the first vector, then at each of the first 40 varints
    let huge = [0xffu8, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01];
    for at in [0usize, 33, 66, 67, 100, 101] {
        let mut v = proof[..at].to_vec();
        v.extend_from_slice(&huge);
        v.extend_from_slice(&proof[at + 1..]);
        hostile.push((format!("claimed length 2^64-1 at byte {at}"), v));
    }
    for claim in [1u64 << 20, 1 << 32, 1 << 40, 1 << 62] {
        // postcard varint of `claim` in place of the first length, followed by the rest of a real proof
        let mut v = Vec::new();
        let mut x = claim;
        while x >= 0x80 {
            v.push((x as u8) | 0x80);
            x >>= 7;
        }
        v.push(x as u8);
        v.extend_from_slice(&proof[1..]);
        hostile.push((format!("first vector claims {claim} entries"), v));
    }
    // canonical encodings of proofs with very many small or empty entries, built with the typed proof
    // (`n` = how many bytes the hostile part may take so that the whole stays under the cap)
    let typed: Vec<(&str, Box<dyn Fn(&mut P, usize)>)> = vec![
        ("quotient_chunks = empty vectors up to the cap", Box::new(|p, n| p.opened_values.quotient_chunks = vec![vec![]; n])),
        ("pcs random openings = 1 x 1 x (empty vectors up to the cap)", Box::new(|p, n| p.opening_proof.0 = vec![vec![vec![vec![]; n]]])),
        ("pcs random openings = empty rounds up to the cap", Box::new(|p, n| p.opening_proof.0 = vec![vec![]; n])),
        ("input_openings[0].opened_values = empty queries up to the cap", Box::new(|p, n| p.opening_proof.1.input_openings[0].opened_values = vec![vec![]; n])),
        ("input_openings[0] salts = empty queries up to the cap", Box::new(|p, n| p.opening_proof.1.input_openings[0].opening_proof.0 = vec![vec![]; n])),
        ("commit_phase_openings[0].sibling_values = empty up to the cap", Box::new(|p, n| p.opening_proof.1.commit_phase_openings[0].sibling_values = vec![vec![]; n])),
        ("final_poly = coefficients up to the cap", Box::new(|p, n| p.opening_proof.1.final_poly = vec![EF8::ONE; n / 32])),
        ("commit_pow_witnesses = zeros up to the cap", Box::new(|p, n| p.opening_proof.1.commit_pow_witnesses = vec![Felt::ZERO; n / 4])),
        ("commit_phase_commits = copies up to the cap", Box::new(|p, n| { let c = p.opening_proof.1.commit_phase_commits[0].clone(); p.opening_proof.1.commit_phase_commits = vec![c; n / 33] })),
        ("commit_phase_commits and pow witnesses: as many as fit, equal counts", Box::new(|p, n| {
            let f = &mut p.opening_proof.1;
            let c = f.commit_phase_commits[0].clone();
            f.commit_phase_commits = vec![c; n / 37];
            f.commit_pow_witnesses = vec![Felt::ZERO; n / 37];
        })),
        ("trace_local = elements up to the cap", Box::new(|p, n| p.opened_values.trace_local = vec![EF8::ONE; n / 32])),
        ("trace_local = trace_next = elements up to the cap", Box::new(|p, n| { p.opened_values.trace_local = vec![EF8::ONE; n / 64]; p.opened_values.trace_next = Some(vec![EF8::ONE; n / 64]) })),
        ("quotient_chunks = 8 x (elements up to the cap)", Box::new(|p, n| p.opened_values.quotient_chunks = vec![vec![EF8::ONE; n / 256]; 8])),
        ("random = elements up to the cap", Box::new(|p, n| p.opened_values.random = Some(vec![EF8::ONE; n / 32]))),
    ];
    let strip = |p: &mut P| {
        // a proof stripped of most of its bulk so that the hostile part fits under the cap
        for b in p.opening_proof.1.input_openings.iter_mut().skip(1) {
            b.opened_values.clear();
            b.opening_proof.0.clear();
        }
        p.opening_proof.1.input_openings[0].opened_values.truncate(1);
        p.opening_proof.1.input_openings[0].opening_proof.0.truncate(1);
        for r in p.opening_proof.1.commit_phase_openings.iter_mut() {
            r.sibling_values.truncate(1);
        }
    };
    let mut stripped = decode(&proof);
    strip(&mut stripped);
    let base = postcard::to_allocvec(&stripped).unwrap().len();
    let room = cap - base - 64;
    println!("REVIEW2|alloc|stripped proof {base} B; room for the hostile part {room} B");
    for (name, f) in &typed {
        let mut p = decode(&proof);
        strip(&mut p);
        f(&mut p, room);
        let bytes = postcard::to_allocvec(&p).unwrap();
        assert!(bytes.len() <= cap && bytes.len() > cap - 8192, "{name}: {} bytes", bytes.len());
        hostile.push((name.to_string(), bytes));
    }

    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let mut bad = Vec::new();
    for (name, bytes) in &hostile {
        let ((o, msg), peak, calls, dt) = measured_run(&pi, bytes);
        println!("REVIEW2|alloc|{name}|{} B|{o:?} {}|peak {} KiB, {calls} allocator calls, {dt:?}", bytes.len(), short(&msg), peak / 1024);
        if matches!(o, Outcome::Accepted | Outcome::Panicked) {
            bad.push(format!("{name}: {o:?} {msg}"));
        }
        if peak > worst.0 {
            worst.0 = peak;
            worst.2 = name.clone();
        }
        if dt > worst.1 {
            worst.1 = dt;
            worst.3 = name.clone();
        }
    }
    std::panic::set_hook(prev);
    println!(
        "REVIEW2|alloc|summary|{} hostile inputs <= {cap} B|largest peak allocation {} KiB ({}) = {:.1} x the honest verification's {} KiB|slowest {:?} ({})",
        hostile.len(),
        worst.0 / 1024,
        worst.2,
        worst.0 as f64 / honest_peak as f64,
        honest_peak / 1024,
        worst.1,
        worst.3
    );
    assert!(bad.is_empty(), "ACCEPTED or PANICKED: {bad:#?}");
    // the bound this review claims: memory stays within a small multiple of the input cap
    assert!(worst.0 < 64 << 20, "more than 64 MiB allocated for a <= 200,000-byte input");
    assert!(worst.1 < Duration::from_secs(2), "a <= 200,000-byte input kept the verifier busy for {:?}", worst.1);
}

// =================================================================================================

#[test]
fn review2_byte_flip_sweep() {
    let stride: usize = std::env::var("REVIEW2_STRIDE").ok().and_then(|s| s.parse().ok()).unwrap_or(3);
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let mut total: BTreeMap<Outcome, usize> = BTreeMap::new();
    let mut bad = Vec::new();
    // the committed transfer vector and a proof of another kind: with the test-prover feature a
    // fresh shield proof as in the research test, otherwise the committed shield vector
    #[cfg(feature = "test-prover")]
    let (other_name, other_pi, other_proof) = {
        let sh = sample(Kind::Shield, 0xf11b);
        let fresh = quantum_vault_shield_v2::verifier::prove_spend(quantum_vault_shield_v2::trace::honest_trace(&sh), &sh.public(), TestRng(0xf11b).seed32()).unwrap();
        ("fresh shield proof", sh.public(), fresh)
    };
    #[cfg(not(feature = "test-prover"))]
    let (other_name, other_pi, other_proof) = ("shield vector", vector("shield").0, vector("shield").1);
    for (name, pi, proof, stride) in [("transfer vector", vector("transfer").0, vector("transfer").1, stride), (other_name, other_pi, other_proof, stride * 16 + 1)] {
        assert_eq!(run(&pi, &proof).0, Outcome::Accepted);
        let n = proof.len();
        let mut tally: BTreeMap<Outcome, usize> = BTreeMap::new();
        let t0 = Instant::now();
        let mut v = proof.clone();
        for (k, p) in (0..n).step_by(stride).enumerate() {
            let bit = 1u8 << (k % 8);
            v[p] ^= bit;
            let (o, msg) = run(&pi, &v);
            v[p] ^= bit;
            if matches!(o, Outcome::Accepted | Outcome::Panicked) {
                bad.push(format!("{name}: byte {p} bit {bit:#04x}: {o:?} {msg}"));
            }
            *tally.entry(o.clone()).or_default() += 1;
            *total.entry(o).or_default() += 1;
            if k % 10_000 == 9_999 {
                println!("REVIEW2|flip sweep|{name}|{} done, {:?}", k + 1, t0.elapsed());
            }
        }
        println!("REVIEW2|flip sweep|{name}|one bit in every {stride}th byte of {n}|{tally:?}|{:?}", t0.elapsed());
    }
    std::panic::set_hook(prev);
    println!("REVIEW2|flip sweep|total|{total:?}");
    assert!(bad.is_empty(), "ACCEPTED or PANICKED: {bad:#?}");
}

// =================================================================================================
// The length cap: is 200,000 a bound for honest proofs, or only a measured margin?
//
// RESULTS.md: "the worst case (no sharing at all) was not derived; nothing here shows it to be
// below 200,000". Derived here. Under the built-in parameters everything in a proof has a fixed
// size except the nine pruned Merkle multiproofs (3 input batches over 2^18 leaves; 6 FRI rounds
// over 2^16, 2^14, 2^12, 2^10, 2^8, 2^7 rows), which hold exactly the boundary sibling digests of
// the 45 query paths. With m_l = number of distinct on-path nodes at level l (2^l nodes; l = d
// are the leaves), a level needs 2 m_(l-1) - m_l siblings, so a tree of depth d needs
//     2 + sum_{l=1}^{d-1} m_l - m_d  <=  2 + sum_{l=1}^{d-2} min(45, 2^l)  =: B(d)
// digests (m_l <= min(45, 2^l), m_(d-1) <= m_d). The test checks the model against real proofs
// (the non-digest part must be the same number of bytes in every proof; every count <= B(d) and
// near its expectation) and prints the resulting maximum.
// =================================================================================================

fn bound(d: usize) -> usize {
    2 + (1..=d - 2).map(|l| 45usize.min(1 << l)).sum::<usize>()
}

/// Expected number of sibling digests for 45 uniform queries in a tree of depth d.
fn expected(d: usize) -> f64 {
    let m = |l: usize| {
        let n = (1u64 << l) as f64;
        n * (1.0 - (1.0 - 1.0 / n).powi(45))
    };
    2.0 + (1..d).map(m).sum::<f64>() - m(d)
}

#[test]
fn review2_proof_length_bound() {
    let depths = [18usize, 18, 18, 16, 14, 12, 10, 8, 7];
    let max_digests: usize = depths.iter().map(|&d| bound(d)).sum();
    #[allow(unused_mut)]
    let mut proofs: Vec<Vec<u8>> = ["shield", "transfer", "unshield"].iter().map(|n| vector(n).1).collect();
    #[cfg(feature = "test-prover")]
    for k in 0..12u64 {
        let js = sample([Kind::Shield, Kind::Transfer, Kind::Unshield2][(k % 3) as usize], 0x51e + k);
        proofs.push(quantum_vault_shield_v2::verifier::prove_spend(quantum_vault_shield_v2::trace::honest_trace(&js), &js.public(), TestRng(0x51e0 + k).seed32()).unwrap());
    }
    let mut fixed_part = None;
    let mut sums = vec![0usize; depths.len()];
    let (mut largest, mut most_digests) = (0usize, 0usize);
    for bytes in &proofs {
        let p = decode(bytes);
        let f = &p.opening_proof.1;
        let counts: Vec<usize> = f
            .input_openings
            .iter()
            .map(|b| b.opening_proof.1.sibling_hashes.len())
            .chain(f.commit_phase_openings.iter().map(|r| r.opening_proof.1.sibling_hashes.len()))
            .collect();
        assert_eq!(counts.len(), depths.len());
        for (i, (&c, &d)) in counts.iter().zip(&depths).enumerate() {
            assert!(c <= bound(d), "tree {i}: {c} digests, more than the bound {} for depth {d}", bound(d));
            sums[i] += c;
        }
        // the three input trees are opened at the same indices
        assert!(counts[0] == counts[1] && counts[1] == counts[2]);
        let digests: usize = counts.iter().sum();
        // everything that is not a sibling digest: the same number of bytes in every proof, up to
        // the one-or-two-byte varint of each digest count (all counts but the last are >= 128)
        let varints: usize = counts.iter().map(|&c| if c < 128 { 1 } else { 2 }).sum();
        let fixed = bytes.len() - 32 * digests - varints;
        assert_eq!(*fixed_part.get_or_insert(fixed), fixed, "the non-digest part of a proof varies");
        largest = largest.max(bytes.len());
        most_digests = most_digests.max(digests);
    }
    let fixed = fixed_part.unwrap();
    let n = proofs.len() as f64;
    let means: Vec<String> = sums.iter().zip(&depths).map(|(&s, &d)| format!("depth {d}: mean {:.0} (expected {:.0}, bound {})", s as f64 / n, expected(d), bound(d))).collect();
    let worst = fixed + 32 * max_digests + 2 * depths.len();
    println!("REVIEW2|length bound|{} honest proofs|non-digest part: {fixed} B in every one|sibling digests per tree: {means:?}", proofs.len());
    println!(
        "REVIEW2|length bound|largest of these proofs {largest} B ({most_digests} digests)|maximum number of digests for ANY 45 query positions: {max_digests}|LARGEST POSSIBLE HONEST PROOF: {worst} B|cap {MAX_PROOF_BYTES}: margin {} B",
        MAX_PROOF_BYTES as i64 - worst as i64
    );
    // the depths are identified correctly: a tree one level deeper would show ~45 more digests
    let tolerance = if proofs.len() >= 12 { 12.0 } else { 24.0 }; // three vectors only without the test-prover feature
    for (i, &d) in depths.iter().enumerate() {
        let mean = sums[i] as f64 / n;
        assert!((mean - expected(d)).abs() < tolerance, "tree {i}: mean {mean:.1} digests does not fit depth {d} (expected {:.1})", expected(d));
    }
    assert!(worst <= MAX_PROOF_BYTES, "an honest proof can exceed the cap: {worst}");
    // spec §7, C-1: the largest possible honest proof is 194,893 bytes, 5,107 below the cap
    assert_eq!(worst, 194_893, "the bound of spec §7 (C-1) changed: a parameter or the AIR width moved");
    assert_eq!(MAX_PROOF_BYTES - worst, 5_107);
}
