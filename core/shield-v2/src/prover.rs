//! The wallet prover of a shielded-pool V2 spend (spec §2.11, §5.5, §5.6; closes open issue O-14).
//! `prover` cargo feature — off by default, never enabled by the daemon.
//!
//! One entry point: [`prove_spend`]`(witness, public) -> Result<Vec<u8>, ProveError>`.
//!
//! # Randomness (spec §5.6)
//!
//! In hiding mode a 32-byte blinding seed is the only entropy of a proof's blinding. Here:
//!
//! 1. **Drawn inside the proving function, once per proof** — 32 bytes from the operating
//!    system's generator (`getrandom`; in a browser, Web Crypto). There is **no seed parameter**,
//!    no way to supply, read back, store or reuse a seed, and nothing is derived from a recovery
//!    phrase, a timestamp or the transaction alone.
//! 2. **A failed read is an error** ([`ProveError::Entropy`]). There is no fallback source. An
//!    all-zero result is treated as a failed read as well.
//! 3. **Hedged** (item 4): the seed handed to the proof library is
//!    `Blake3-keyed(key = OS entropy; "rouge-shield/v2/prover/blinding-seed/v1" ‖ counter ‖
//!    public inputs ‖ witness)`, where `counter` is a per-process call counter. With a working
//!    generator this is as uniform as the generator's output; with a generator that repeats, two
//!    different statements, two different witnesses or two calls in one process still get
//!    unrelated masks. It is a hardening on top of 1 and 2, not a substitute for them: a generator
//!    that repeats across processes for the very same statement and witness yields the same proof
//!    bytes, which reveals nothing.
//! 4. **Wiped after use**: the entropy, the serialised witness, the hasher and the seed this
//!    module owns are zeroized, on every exit path. What the proof library copies — the seed
//!    inside its ChaCha generators, the witness inside the trace matrix — is consumed and freed
//!    by the library and is NOT wiped; that is outside this crate (see `NOTES.md`).
//!
//! # No panics on caller data
//!
//! [`prove_spend`] first checks the whole statement in plain Rust ([`ProveError::Witness`] names
//! what does not hold), so no proof is ever attempted for a witness the verifier would refuse. The
//! trace builder indexes only fixed-size arrays. A panic inside the proof library is caught and
//! reported ([`ProveError::Panicked`]) in an unwinding build; `wasm32-unknown-unknown` aborts on
//! panic, which is why the validation in front matters there.
//!
//! # The output is checked
//!
//! A proof longer than [`MAX_PROOF_BYTES`] is never returned ([`ProveError::ProofTooLong`]; under
//! the pinned parameters it cannot happen — spec §7, C-1 — so it is an implementation fault, not a
//! condition to retry), and every proof is run through [`verify_spend`] before it is returned
//! (spec §5.5).

use core::fmt;
use core::sync::atomic::{AtomicU64, Ordering};
use std::panic::{AssertUnwindSafe, catch_unwind};

use p3_field::{PrimeCharacteristicRing, PrimeField32};
use zeroize::{Zeroize, Zeroizing};

use crate::Felt;
use crate::layout::{NUM_INPUTS, NUM_OUTPUTS, TREE_DEPTH};
use crate::reference::{
    Digest, Note, PublicInputs, derive_nk, derive_pk, derive_rho, limbs, nullifier, root_from_path,
};
use crate::trace::{Overrides, TraceInputs, build_trace, carries};
use crate::verifier::{MAX_PROOF_BYTES, prove_trace_seeded, verify_spend};

/// One input of the statement (spec §2.7) as the wallet holds it.
#[derive(Clone)]
pub struct InputWitness {
    /// `true`: a real note, its membership under the anchor is proven. `false`: a dummy — its
    /// value must be 0, its path is not compared with the anchor, and its `sk`, `rho`, `r` must be
    /// fresh randomness of this transaction (spec §5.7; the caller's duty).
    pub enabled: bool,
    pub sk: Digest,
    pub value: u64,
    pub rho: Digest,
    pub r: Digest,
    /// Leaf position (bit `l` = side at level `l`, spec §2.6).
    pub index: u32,
    /// The 32 siblings, leaf level first.
    pub path: [Digest; TREE_DEPTH],
}

/// One output: what the sender chooses. `rho` is not here — the statement derives it from the
/// public nullifiers (spec §2.4).
#[derive(Clone)]
pub struct OutputWitness {
    pub value: u64,
    pub pk: Digest,
    pub r: Digest,
}

/// The private witness of one spend. Secret: it contains the spending key. Wiped on drop; has no
/// `Debug` output.
#[derive(Clone)]
pub struct SpendWitness {
    pub inputs: [InputWitness; NUM_INPUTS],
    pub outputs: [OutputWitness; NUM_OUTPUTS],
}

fn wipe_felts(xs: &mut [Felt]) {
    for x in xs.iter_mut() {
        // SAFETY: `x` is a valid, aligned, exclusive reference to an initialised `Felt`; a
        // volatile write of a valid value through it is always sound. Volatile so that the
        // compiler does not drop the store as dead.
        unsafe { core::ptr::write_volatile(x, Felt::ZERO) };
    }
    core::sync::atomic::compiler_fence(Ordering::SeqCst);
}

/// Overwrites a digest with zeros in a way the compiler may not remove — for callers that hold
/// secret digests (`sk`, `nk`, `r`) of their own.
pub fn wipe_digest(d: &mut Digest) {
    wipe_felts(d);
}

impl Drop for InputWitness {
    fn drop(&mut self) {
        wipe_felts(&mut self.sk);
        wipe_felts(&mut self.rho);
        wipe_felts(&mut self.r);
        for p in self.path.iter_mut() {
            wipe_felts(p);
        }
        self.value.zeroize();
        self.index.zeroize();
    }
}

impl Drop for OutputWitness {
    fn drop(&mut self) {
        wipe_felts(&mut self.pk);
        wipe_felts(&mut self.r);
        self.value.zeroize();
    }
}

impl fmt::Debug for SpendWitness {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SpendWitness(<secret>)")
    }
}

/// Why no proof was produced. Not consensus data; for the wallet and its logs. No variant carries
/// witness material.
#[derive(Debug)]
pub enum ProveError {
    /// The operating system's generator failed (or returned all zeros). Proving MUST fail; there
    /// is no fallback (spec §5.6 item 3).
    Entropy(String),
    /// The witness does not satisfy the statement for these public inputs; names the first rule
    /// that does not hold. No proof was attempted.
    Witness(&'static str),
    /// The proof library reported an error.
    Prover(String),
    /// The proof library panicked (unwinding builds only).
    Panicked,
    /// The proof is longer than the verifier's cap. Under the pinned parameters this cannot
    /// happen; it is an implementation fault, not a reason to prove again (spec §5.5, §7 C-1).
    ProofTooLong { len: usize, max: usize },
    /// The verifier refused the prover's own output. An implementation fault.
    SelfVerify(String),
}

impl fmt::Display for ProveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProveError::Entropy(e) => write!(f, "the operating system's random generator failed: {e}"),
            ProveError::Witness(w) => write!(f, "the witness does not satisfy the statement: {w}"),
            ProveError::Prover(e) => write!(f, "the proof library failed: {e}"),
            ProveError::Panicked => f.write_str("the proof library panicked"),
            ProveError::ProofTooLong { len, max } => {
                write!(f, "the proof is {len} bytes, above the verifier's cap of {max} (implementation fault)")
            }
            ProveError::SelfVerify(e) => write!(f, "the verifier refused the prover's own proof: {e}"),
        }
    }
}

impl std::error::Error for ProveError {}

// ---- the statement in plain Rust ------------------------------------------------------------------

/// Spec §2.7 items 1–5 for `witness` against `public`. What the AIR plus `verify_spend` accept.
pub fn check_statement(witness: &SpendWitness, public: &PublicInputs) -> Result<(), ProveError> {
    const NF: [&str; 2] =
        ["input 1: the nullifier is not the public nf1", "input 2: the nullifier is not the public nf2"];
    const ROOT: [&str; 2] = ["input 1: the note is not under the anchor", "input 2: the note is not under the anchor"];
    const DUMMY: [&str; 2] = ["input 1: a dummy input must have value 0", "input 2: a dummy input must have value 0"];
    const CM: [&str; 2] =
        ["output 1: the commitment is not the public cm_out1", "output 2: the commitment is not the public cm_out2"];

    if public.nf[0] == public.nf[1] {
        return Err(ProveError::Witness("the two nullifiers are equal (one note in both input slots)"));
    }
    for (i, inp) in witness.inputs.iter().enumerate() {
        if nullifier(&derive_nk(&inp.sk), &inp.rho) != public.nf[i] {
            return Err(ProveError::Witness(NF[i]));
        }
        if inp.enabled {
            let cm = Note { value: inp.value, pk: derive_pk(&inp.sk), rho: inp.rho, r: inp.r }.commitment();
            if root_from_path(&cm, inp.index, &inp.path) != public.anchor {
                return Err(ProveError::Witness(ROOT[i]));
            }
        } else if inp.value != 0 {
            return Err(ProveError::Witness(DUMMY[i]));
        }
    }
    for (j, out) in witness.outputs.iter().enumerate() {
        let cm = Note { value: out.value, pk: out.pk, rho: derive_rho(&public.nf, j), r: out.r }.commitment();
        if cm != public.cm_out[j] {
            return Err(ProveError::Witness(CM[j]));
        }
    }
    let lhs = witness.inputs[0].value as u128 + witness.inputs[1].value as u128 + public.v_in as u128;
    let rhs =
        witness.outputs[0].value as u128 + witness.outputs[1].value as u128 + public.v_out as u128 + public.fee as u128;
    if lhs != rhs {
        return Err(ProveError::Witness("the values do not balance"));
    }
    Ok(())
}

/// The trace builder's inputs for a witness that passed [`check_statement`].
fn trace_inputs(w: &SpendWitness, public: &PublicInputs) -> TraceInputs {
    let a = [limbs(w.inputs[0].value), limbs(w.inputs[1].value)];
    let b = [limbs(w.outputs[0].value), limbs(w.outputs[1].value)];
    let (ka, kb) = carries(&a, &b, public.v_in, public.v_out, public.fee);
    let bits = |n: usize| core::array::from_fn(|l| Felt::from_u32((w.inputs[n].index >> l) & 1));
    TraceInputs {
        sk: [w.inputs[0].sk, w.inputs[1].sk],
        rho: [w.inputs[0].rho, w.inputs[1].rho],
        r: [w.inputs[0].r, w.inputs[1].r],
        a,
        en: [Felt::from_bool(w.inputs[0].enabled), Felt::from_bool(w.inputs[1].enabled)],
        siblings: [w.inputs[0].path, w.inputs[1].path],
        pos_bits: [bits(0), bits(1)],
        b,
        pk_out: [w.outputs[0].pk, w.outputs[1].pk],
        r_out: [w.outputs[0].r, w.outputs[1].r],
        ka,
        kb,
    }
}

fn wipe_trace_inputs(t: &mut TraceInputs) {
    for d in t.sk.iter_mut().chain(t.rho.iter_mut()).chain(t.r.iter_mut()).chain(t.pk_out.iter_mut()).chain(t.r_out.iter_mut())
    {
        wipe_felts(d);
    }
    for l in t.a.iter_mut().chain(t.b.iter_mut()) {
        wipe_felts(l);
    }
    for s in t.siblings.iter_mut().flatten() {
        wipe_felts(s);
    }
    for p in t.pos_bits.iter_mut() {
        wipe_felts(p);
    }
    wipe_felts(&mut t.en);
    wipe_felts(&mut t.ka);
    wipe_felts(&mut t.kb);
}

// ---- the blinding seed (spec §5.6) ----------------------------------------------------------------

/// Domain tag of the hedged seed derivation. Not a protocol constant: nothing outside the prover
/// can observe it.
const SEED_DOMAIN: &[u8] = b"rouge-shield/v2/prover/blinding-seed/v1";

/// Proofs started by this process. Mixed into every seed so that a generator that returns the
/// same bytes twice within one process still gives two different seeds.
static PROOF_COUNTER: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
pub(crate) mod test_hook {
    //! Test-only control of the entropy read, per thread. Not compiled into any non-test build.
    use std::cell::Cell;

    #[derive(Clone, Copy)]
    pub(crate) enum Entropy {
        /// The operating system's generator (the default).
        Os,
        /// The read fails.
        Fail,
        /// The read "succeeds" with these bytes every time — a generator that repeats.
        Stuck([u8; 32]),
    }

    thread_local! {
        static MODE: Cell<Entropy> = const { Cell::new(Entropy::Os) };
        static LAST_SEED: Cell<Option<[u8; 32]>> = const { Cell::new(None) };
    }
    pub(crate) fn set(mode: Entropy) {
        MODE.with(|m| m.set(mode));
    }
    pub(crate) fn get() -> Entropy {
        MODE.with(|m| m.get())
    }
    pub(crate) fn record_seed(seed: &[u8; 32]) {
        LAST_SEED.with(|s| s.set(Some(*seed)));
    }
    pub(crate) fn last_seed() -> Option<[u8; 32]> {
        LAST_SEED.with(|s| s.get())
    }
}

/// 32 bytes from the operating system's generator. An error, or 32 zero bytes, is a failure; no
/// other source is ever consulted.
fn os_entropy() -> Result<Zeroizing<[u8; 32]>, ProveError> {
    let mut buf = Zeroizing::new([0u8; 32]);
    #[cfg(test)]
    match test_hook::get() {
        test_hook::Entropy::Os => {}
        test_hook::Entropy::Fail => return Err(ProveError::Entropy("injected failure (test)".into())),
        test_hook::Entropy::Stuck(b) => {
            *buf = b;
            return Ok(buf);
        }
    }
    getrandom::getrandom(&mut buf[..]).map_err(|e| ProveError::Entropy(e.to_string()))?;
    if buf.iter().all(|&b| b == 0) {
        return Err(ProveError::Entropy("the generator returned 32 zero bytes".into()));
    }
    Ok(buf)
}

/// A canonical byte string of the whole witness, for the hedge only (never leaves this module).
fn witness_bytes(w: &SpendWitness) -> Zeroizing<Vec<u8>> {
    let mut v = Zeroizing::new(Vec::with_capacity(2 * (1 + 8 + 4 + 35 * 32) + 2 * (8 + 64)));
    let felts = |v: &mut Vec<u8>, d: &Digest| {
        for e in d {
            v.extend_from_slice(&e.as_canonical_u32().to_le_bytes());
        }
    };
    for i in &w.inputs {
        v.push(i.enabled as u8);
        v.extend_from_slice(&i.value.to_le_bytes());
        v.extend_from_slice(&i.index.to_le_bytes());
        felts(&mut v, &i.sk);
        felts(&mut v, &i.rho);
        felts(&mut v, &i.r);
        for s in &i.path {
            felts(&mut v, s);
        }
    }
    for o in &w.outputs {
        v.extend_from_slice(&o.value.to_le_bytes());
        felts(&mut v, &o.pk);
        felts(&mut v, &o.r);
    }
    v
}

/// The hedge of spec §5.6 item 4: `Blake3-keyed(entropy; domain ‖ counter ‖ public ‖ witness)`.
fn hedge(entropy: &[u8; 32], counter: u64, witness: &SpendWitness, public: &PublicInputs) -> Zeroizing<[u8; 32]> {
    let wb = witness_bytes(witness);
    let mut hasher = blake3::Hasher::new_keyed(entropy);
    hasher.update(SEED_DOMAIN);
    hasher.update(&counter.to_le_bytes());
    hasher.update(&public.to_bytes());
    hasher.update(&wb);
    let mut seed = Zeroizing::new([0u8; 32]);
    seed.copy_from_slice(hasher.finalize().as_bytes());
    hasher.zeroize();
    seed
}

/// The blinding seed of ONE proof: fresh OS entropy, hedged (module documentation, items 1–3).
fn blinding_seed(witness: &SpendWitness, public: &PublicInputs) -> Result<Zeroizing<[u8; 32]>, ProveError> {
    let entropy = os_entropy()?;
    let counter = PROOF_COUNTER.fetch_add(1, Ordering::SeqCst);
    let seed = hedge(&entropy, counter, witness, public);
    #[cfg(test)]
    test_hook::record_seed(&seed);
    Ok(seed)
}

// ---- the prover ------------------------------------------------------------------------------------

/// The wallet prover (spec §2.11, §5.6): a proof that `witness` satisfies the statement of spec
/// §2.7 for `public`, under the one built-in parameter set, as the canonical proof bytes of spec
/// §2.9.1.
///
/// * No seed parameter. The blinding is drawn here, fresh for this call (module documentation).
/// * `Err` and no proof if the witness does not satisfy the statement, if the operating system's
///   generator fails, if the proof would exceed [`MAX_PROOF_BYTES`], or if [`verify_spend`] does
///   not accept the result.
/// * Two calls with the same arguments return different bytes; both verify (spec §2.9.1: a
///   statement does not have one proof).
///
/// `public.binding` must already be `binding_from_bytes(body)` of the transaction body: a proof
/// verifies only with the binding it was made for.
pub fn prove_spend(witness: &SpendWitness, public: &PublicInputs) -> Result<Vec<u8>, ProveError> {
    check_statement(witness, public)?;
    let seed = blinding_seed(witness, public)?;
    let mut inputs = trace_inputs(witness, public);
    let result = catch_unwind(AssertUnwindSafe(|| {
        prove_trace_seeded(build_trace(&inputs, &Overrides::default()), public, &seed)
    }));
    wipe_trace_inputs(&mut inputs);
    drop(seed); // zeroized
    let bytes = match result {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(e)) => return Err(ProveError::Prover(e)),
        Err(_) => return Err(ProveError::Panicked),
    };
    if bytes.len() > MAX_PROOF_BYTES {
        return Err(ProveError::ProofTooLong { len: bytes.len(), max: MAX_PROOF_BYTES });
    }
    verify_spend(public, &bytes).map_err(|e| ProveError::SelfVerify(e.to_string()))?;
    Ok(bytes)
}

#[cfg(all(test, feature = "test-prover"))]
mod tests {
    use super::test_hook::{self, Entropy};
    use super::*;
    use crate::witness::{Kind, sample};

    fn statement(kind: Kind, seed: u64) -> (SpendWitness, PublicInputs) {
        let js = sample(kind, seed);
        (SpendWitness::from(&js), js.public())
    }

    /// Spec §5.6 item 3: a failed read of the operating system's generator is an error — no proof,
    /// no fallback — and it does not disturb the next call.
    #[test]
    fn entropy_failure_is_an_error_never_a_fallback() {
        let (w, p) = statement(Kind::Shield, 1);
        test_hook::set(Entropy::Fail);
        match prove_spend(&w, &p) {
            Err(ProveError::Entropy(_)) => {}
            other => panic!("expected an entropy error, got {:?}", other.map(|b| b.len())),
        }
        assert!(test_hook::last_seed().is_none(), "the failure happened before any seed existed");
        test_hook::set(Entropy::Os);
        let proof = prove_spend(&w, &p).expect("the generator works again");
        verify_spend(&p, &proof).expect("verifies");
    }

    /// Spec §5.6 item 4, the hedge: with a generator that returns the SAME 32 bytes every time,
    /// (a) two proofs of the same witness in one process still differ (the counter) and both
    /// verify, and (b) different statements get unrelated seeds (the witness and public inputs).
    #[test]
    fn a_stuck_generator_does_not_repeat_the_blinding() {
        test_hook::set(Entropy::Stuck([0x5a; 32]));
        let (w, p) = statement(Kind::Transfer, 2);
        let a = prove_spend(&w, &p).expect("prove");
        let seed_a = test_hook::last_seed().unwrap();
        let b = prove_spend(&w, &p).expect("prove");
        let seed_b = test_hook::last_seed().unwrap();
        assert_ne!(seed_a, seed_b, "the per-call counter separates two calls");
        assert_ne!(a, b);
        verify_spend(&p, &a).expect("first verifies");
        verify_spend(&p, &b).expect("second verifies");
        assert_ne!(seed_a, [0x5a; 32], "the seed is never the raw entropy");

        // same entropy, same counter value, another statement: another seed
        let e = [0x5a; 32];
        let (w2, p2) = statement(Kind::Unshield, 3);
        let s1 = hedge(&e, 7, &w, &p);
        assert_eq!(*s1, *hedge(&e, 7, &w, &p), "the hedge is a function of its four inputs");
        assert_ne!(*s1, *hedge(&e, 7, &w2, &p2), "witness and public inputs are in the hedge");
        assert_ne!(*s1, *hedge(&e, 8, &w, &p), "the counter is in the hedge");
        assert_ne!(*s1, *hedge(&[0x5b; 32], 7, &w, &p), "the entropy is the key");
        // one changed witness element under the same public inputs, and the reverse
        let mut w3 = w.clone();
        w3.outputs[0].r[0] += Felt::ONE;
        assert_ne!(*s1, *hedge(&e, 7, &w3, &p));
        let mut p3 = p.clone();
        p3.binding[0] += Felt::ONE;
        assert_ne!(*s1, *hedge(&e, 7, &w, &p3));
        test_hook::set(Entropy::Os);
    }

    /// With the real generator the seed differs from call to call for identical arguments.
    #[test]
    fn os_seeds_are_fresh_per_call() {
        test_hook::set(Entropy::Os);
        let (w, p) = statement(Kind::Shield, 4);
        drop(blinding_seed(&w, &p).unwrap());
        let a = test_hook::last_seed().unwrap();
        drop(blinding_seed(&w, &p).unwrap());
        let b = test_hook::last_seed().unwrap();
        assert_ne!(a, b);
        assert_ne!(a, [0u8; 32]);
    }

    /// The statement check names the broken rule and no proof is attempted (the entropy hook is
    /// set to fail: reaching it would give `Entropy`, not `Witness`).
    #[test]
    fn a_false_witness_is_refused_before_proving() {
        test_hook::set(Entropy::Fail);
        let bad = |w: &SpendWitness, p: &PublicInputs, needle: &str| match prove_spend(w, p) {
            Err(ProveError::Witness(m)) => assert!(m.contains(needle), "{m}"),
            other => panic!("expected a witness error with {needle:?}, got {:?}", other.map(|b| b.len())),
        };
        let (w, p) = statement(Kind::Transfer, 5);
        let mut x = w.clone();
        x.inputs[0].value += 1;
        bad(&x, &p, "anchor");
        let mut x = w.clone();
        x.inputs[1].sk[0] += Felt::ONE;
        bad(&x, &p, "nf2");
        let mut x = w.clone();
        x.outputs[1].value += 1;
        bad(&x, &p, "cm_out2");
        let mut x = w.clone();
        x.inputs[0].path[31][7] += Felt::ONE;
        bad(&x, &p, "anchor");
        let mut q = p.clone();
        q.fee += 1;
        bad(&w, &q, "balance");
        let mut q = p.clone();
        q.nf[1] = q.nf[0];
        bad(&w, &q, "equal");
        let (w, p) = statement(Kind::Shield, 6);
        let mut x = w.clone();
        x.inputs[0].value = 1;
        bad(&x, &p, "dummy");
        // a changed binding is NOT a witness error (the circuit does not constrain it): the proof
        // is made for the binding it is given
        test_hook::set(Entropy::Os);
    }
}
