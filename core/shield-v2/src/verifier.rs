//! The fixed-parameter production verifier of a shielded-pool V2 spend (spec §2.9).
//!
//! Ported from `research/shield3/src/config.rs` (the normal-build path only), with every constant,
//! transcript element, type and check order unchanged. What is NOT here, by construction and not
//! by a cargo feature: other parameter sets, the hiding-OFF mode, the Poseidon2 proof hasher, the
//! library-only verifier, the cheating-prover transcript hook and proof inspection (spec §7, L-3).
//! There is exactly one configuration in this crate and no function takes another.
//!
//! # The consensus result is one bit (spec §4.6, REVIEW2 L-4)
//!
//! [`verify_spend`] returns `Ok(())` (accept) or `Err(VerifyError)` (refuse). **Only that
//! distinction may enter consensus.** Which check refused, and the text of the refusal, can differ
//! between platforms and library versions for one and the same invalid proof. [`VerifyError`] is
//! therefore opaque: it can be formatted for a local log (`Debug` / `Display`) and nothing else —
//! it has no public variants, no accessors and no `PartialEq`. A node MUST NOT put its text into a
//! block, a receipt, the state root or any other consensus-relevant data, and MUST NOT branch on
//! it.

use core::fmt;
use std::panic::{AssertUnwindSafe, catch_unwind};

use p3_blake3::Blake3;
use p3_challenger::{CanObserve, HashChallenger, SerializingChallenger32};
use p3_commit::ExtensionMmcs;
use p3_dft::Radix2DitParallel;
use p3_field::PrimeCharacteristicRing;
use p3_field::extension::BinomialExtensionField;
use p3_fri::{FriParameters, HidingFriPcs};
use p3_merkle_tree::MerkleTreeHidingMmcs;
use p3_symmetric::{CompressionFunctionFromHasher, SerializingHasher};
use p3_uni_stark::{Proof, StarkConfig, verify};
use rand::SeedableRng;
use rand::rngs::StdRng;

use crate::Felt;
use crate::air::JoinSplitAir;
use crate::layout::*;
use crate::reference::PublicInputs;

// ---- the one parameter set: "Q2 · Blake3 · hiding ON" (spec §2.9) ---------------------------------
// Verifier constants. Never read from a proof, never supplied by a caller.

/// Degree of the challenge field over KoalaBear (≈ 248 bits).
const EXT_DEGREE: usize = 8;
const LOG_BLOWUP: usize = 5;
const NUM_QUERIES: usize = 45;
const QUERY_POW_BITS: usize = 16;
const COMMIT_POW_BITS: usize = 0;
const BATCH_POW_BITS: usize = 0;
const OOD_POW_BITS: usize = 0;
const LOG_FINAL_POLY_LEN: usize = 2;
const MAX_LOG_ARITY: usize = 2;
const CAP_HEIGHT: usize = 0;
/// `HidingFriPcs` needs at least `EXT_DEGREE` random codewords; exactly that many are used.
const NUM_RANDOM_CODEWORDS: usize = EXT_DEGREE;
/// Salt elements per Merkle leaf in hiding mode.
const SALT_ELEMS: usize = 5;
/// Transcript id of the proof hasher: 2 = Blake3.
const HASHER_ID: u32 = 2;
/// Hiding is ON; the committed trace is one bit taller than the AIR's trace.
const HIDING: bool = true;

const AIR_VERSION: u32 = 2;

/// The `degree_bits` every accepted proof carries: 2^12 trace rows, doubled by the hiding mode.
const DEGREE_BITS: usize = LOG_TRACE_LEN + HIDING as usize;

/// Longest proof [`verify_spend`] looks at; anything longer is refused BEFORE anything is decoded
/// (spec §2.9 step 1, §3.6 check 3).
///
/// It is a bound, not a measured margin (spec §7, C-1): under the pinned parameters the largest
/// possible honest proof is 194,893 bytes. The bound depends on the pinned parameters;
/// `tests/review2_wrapper.rs::review2_proof_length_bound` recomputes it and MUST be kept.
pub const MAX_PROOF_BYTES: usize = 200_000;

type EF8 = BinomialExtensionField<Felt, EXT_DEGREE>;

/// Elements absorbed by the transcript before anything else (spec §2.9, "Transcript
/// initialisation"): a tag, the AIR shape and every parameter.
fn transcript_seed() -> [Felt; 21] {
    let words: [u32; 21] = [
        0x5348_4c44 % 0x7f00_0001, // "SHLD"
        3,                         // SHIELD-3
        AIR_VERSION,
        TRACE_WIDTH as u32,
        LOG_TRACE_LEN as u32,
        NUM_PUBLIC_VALUES as u32,
        NUM_PERIODIC as u32,
        EXT_DEGREE as u32,
        LOG_BLOWUP as u32,
        NUM_QUERIES as u32,
        QUERY_POW_BITS as u32,
        COMMIT_POW_BITS as u32,
        BATCH_POW_BITS as u32,
        OOD_POW_BITS as u32,
        LOG_FINAL_POLY_LEN as u32,
        MAX_LOG_ARITY as u32,
        CAP_HEIGHT as u32,
        HIDING as u32,
        NUM_RANDOM_CODEWORDS as u32,
        SALT_ELEMS as u32,
        HASHER_ID,
    ];
    words.map(Felt::from_u32)
}

// ---- the concrete configuration -------------------------------------------------------------------

type Dft = Radix2DitParallel<Felt>;

// Blake3 for the Merkle trees and the transcript; 32-byte digests.
type B3FieldHash = SerializingHasher<Blake3>;
type B3Compress = CompressionFunctionFromHasher<Blake3, 2, 32>;
type B3Challenger = SerializingChallenger32<Felt, HashChallenger<u8, Blake3, 32>>;
type B3HidingMmcs = MerkleTreeHidingMmcs<Felt, u8, B3FieldHash, B3Compress, StdRng, 2, 32, SALT_ELEMS>;

type ProductionConfig =
    StarkConfig<HidingFriPcs<Felt, Dft, B3HidingMmcs, ExtensionMmcs<Felt, EF8, B3HidingMmcs>, StdRng>, EF8, B3Challenger>;

fn b3_challenger() -> B3Challenger {
    let mut ch = B3Challenger::new(HashChallenger::new(b"SHIELD-3".to_vec(), Blake3));
    for e in transcript_seed() {
        ch.observe(e);
    }
    ch
}

/// Two independent ChaCha streams from one 32-byte seed: the leaf salts (the MMCS clone forks its
/// stream for the FRI trees) and the PCS's masks. Prover-side entropy only; the verifier never
/// draws from them and passes a constant.
fn rngs(seed: [u8; 32]) -> (StdRng, StdRng) {
    let mut master = StdRng::from_seed(seed);
    let a = StdRng::from_rng(&mut master);
    let b = StdRng::from_rng(&mut master);
    (a, b)
}

/// The one configuration of this crate.
fn production_config(seed: [u8; 32]) -> ProductionConfig {
    let (mmcs_rng, pcs_rng) = rngs(seed);
    let mmcs = B3HidingMmcs::new(B3FieldHash::new(Blake3), B3Compress::new(Blake3), CAP_HEIGHT, mmcs_rng);
    let fri = FriParameters {
        log_blowup: LOG_BLOWUP,
        log_final_poly_len: LOG_FINAL_POLY_LEN,
        max_log_arity: MAX_LOG_ARITY,
        num_queries: NUM_QUERIES,
        batch_proof_of_work_bits: BATCH_POW_BITS,
        commit_proof_of_work_bits: COMMIT_POW_BITS,
        query_proof_of_work_bits: QUERY_POW_BITS,
        mmcs: ExtensionMmcs::new(mmcs.clone()),
    };
    let pcs = HidingFriPcs::new(Dft::default(), mmcs, fri, NUM_RANDOM_CODEWORDS, pcs_rng);
    StarkConfig::new(pcs, b3_challenger()).with_ood_proof_of_work_bits(OOD_POW_BITS)
}

// ---- verifier ----------------------------------------------------------------------------------

/// Why a proof was refused — FOR LOCAL LOGS ONLY (see the module documentation). Private.
/// (The fields are read through `Debug` only.)
#[allow(dead_code)]
#[derive(Clone, Debug)]
enum Refusal {
    /// The proof is longer than `MAX_PROOF_BYTES`; it was not decoded.
    TooLong { len: usize, max: usize },
    /// The two public nullifiers are equal.
    DuplicateNullifier,
    /// The bytes do not decode to a proof of the configuration's type, or bytes are left over.
    Decode(String),
    /// The bytes decode to a proof, but they are not THE encoding of that proof: re-encoding the
    /// decoded proof gives different bytes (for example an over-long varint).
    NonCanonicalEncoding,
    /// The proof claims a trace height other than the fixed one.
    DegreeBits { got: usize, want: usize },
    /// The proof library rejected the proof.
    Stark(String),
    /// The proof library panicked on this input. Treated as a refusal (the research reviews found
    /// no input that panics; this is a second line of defence, effective in unwinding builds).
    Panicked,
}

/// A refusal of [`verify_spend`]. Opaque on purpose: the only consensus-relevant fact is that it
/// is an `Err`. Format it with `{}` or `{:?}` for a local log; do nothing else with it.
pub struct VerifyError(Refusal);

impl fmt::Debug for VerifyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.0, f)
    }
}

impl fmt::Display for VerifyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "shielded spend refused (log only, not consensus): {:?}", self.0)
    }
}

impl std::error::Error for VerifyError {}

/// Steps 3–7 of spec §2.9, after the two checks that need nothing decoded.
fn verify_decoded(public: &PublicInputs, bytes: &[u8]) -> Result<(), Refusal> {
    // 3. the 60 public values; the twelve limbs are derived here from the three u64 amounts
    let pis = public.to_values();
    let config = production_config([0u8; 32]);
    // 4. decode; nothing may be left over
    let (proof, rest): (Proof<ProductionConfig>, &[u8]) =
        postcard::take_from_bytes(bytes).map_err(|e| Refusal::Decode(format!("{e:?}")))?;
    if !rest.is_empty() {
        return Err(Refusal::Decode(format!("{} trailing bytes", rest.len())));
    }
    // 5. ONE accepted encoding per proof: the decoder in use (postcard 1.1.3) accepts over-long
    //    varints, so "decodes with nothing left over" is not enough. Re-encode with the same
    //    serialiser and require the input, byte for byte.
    let canonical = postcard::to_allocvec(&proof).map_err(|e| Refusal::Decode(format!("re-encode: {e:?}")))?;
    if canonical.as_slice() != bytes {
        return Err(Refusal::NonCanonicalEncoding);
    }
    // 6. the fixed trace height
    if proof.degree_bits != DEGREE_BITS {
        return Err(Refusal::DegreeBits { got: proof.degree_bits, want: DEGREE_BITS });
    }
    // 7. the library verifier, every parameter from the built-in constants
    verify(&config, &JoinSplitAir::new(), &proof, &pis).map_err(|e| Refusal::Stark(format!("{e:?}")))
}

/// The verifier of spec §2.9 — the only function of this crate whose result is consensus, and
/// then only as accept (`Ok`) / refuse (`Err`). In order:
///
/// 1. `proof_bytes.len() <= MAX_PROOF_BYTES`, checked before anything is decoded;
/// 2. the two public nullifiers must be distinct (the AIR does not compare them);
/// 3. the 60 public values are built from `public`, the limbs derived from the u64 amounts;
/// 4. the bytes must decode as a proof with nothing left over;
/// 5. re-encoding the decoded proof must reproduce the bytes exactly;
/// 6. the proof's `degree_bits` must be 13;
/// 7. the library verifier, with every parameter taken from built-in constants and nothing from
///    the proof or the caller.
///
/// Never panics on any input: a panic inside the proof library is caught and reported as a
/// refusal (in a build with `panic = "abort"` the process would abort instead; the reviews of the
/// research code found no such input).
pub fn verify_spend(public: &PublicInputs, proof_bytes: &[u8]) -> Result<(), VerifyError> {
    // 1
    if proof_bytes.len() > MAX_PROOF_BYTES {
        return Err(VerifyError(Refusal::TooLong { len: proof_bytes.len(), max: MAX_PROOF_BYTES }));
    }
    // 2
    if public.nf[0] == public.nf[1] {
        return Err(VerifyError(Refusal::DuplicateNullifier));
    }
    // 3–7
    match catch_unwind(AssertUnwindSafe(|| verify_decoded(public, proof_bytes))) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(r)) => Err(VerifyError(r)),
        Err(_) => Err(VerifyError(Refusal::Panicked)),
    }
}

// ---- prover ------------------------------------------------------------------------------------

/// The proving step itself, for the one built-in parameter set: proves whatever trace it is given
/// and returns the canonical postcard bytes of the proof. The proof is a deterministic function
/// of (trace, public inputs, `seed`) — the seed is the ONLY entropy of the blinding (spec §5.6).
///
/// Crate-private on purpose: the two callers are [`crate::prover::prove_spend`], which draws the
/// seed itself and has no seed parameter, and the test-only [`prove_spend`] below. No length check
/// here; both callers make it.
#[cfg(feature = "prover")]
pub(crate) fn prove_trace_seeded(
    trace: p3_matrix::dense::RowMajorMatrix<Felt>,
    public: &PublicInputs,
    seed: [u8; 32],
) -> Result<Vec<u8>, String> {
    let pis = public.to_values();
    let proof: Proof<ProductionConfig> = p3_uni_stark::prove(&production_config(seed), &JoinSplitAir::new(), trace, &pis)
        .map_err(|e| format!("{e:?}"))?;
    postcard::to_allocvec(&proof).map_err(|e| format!("serialize: {e:?}"))
}

/// TEST ONLY (`test-prover` feature). The research prover for the one built-in parameter set,
/// ported verbatim: proves whatever trace it is given (no validation of the witness; an
/// inconsistent trace yields a proof the verifier refuses) and returns the canonical postcard
/// bytes of the proof.
///
/// This is NOT the wallet prover of spec §5.6: it takes the blinding seed from its caller, which
/// production code MUST NOT do. The wallet prover is [`crate::prover::prove_spend`] (`prover`
/// feature), which has no seed parameter. This one exists so that this crate's tests can push
/// forged traces through the production verifier and reproduce the test vectors of spec §8.3.
///
/// Fails if the proof is longer than [`MAX_PROOF_BYTES`].
#[cfg(all(feature = "prover", any(test, feature = "test-prover")))]
pub fn prove_spend(
    trace: p3_matrix::dense::RowMajorMatrix<Felt>,
    public: &PublicInputs,
    seed: [u8; 32],
) -> Result<Vec<u8>, String> {
    let bytes = prove_trace_seeded(trace, public, seed)?;
    if bytes.len() > MAX_PROOF_BYTES {
        return Err(format!("proof is {} bytes, above the verifier's cap of {MAX_PROOF_BYTES}", bytes.len()));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use p3_field::PrimeField32;

    use super::*;

    fn vector(name: &str) -> (PublicInputs, Vec<u8>) {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/vectors");
        let proof = std::fs::read(format!("{dir}/{name}.proof.bin")).unwrap();
        let pi = PublicInputs::from_bytes(&std::fs::read(format!("{dir}/{name}.public.bin")).unwrap()).unwrap();
        (pi, proof)
    }

    /// Spec §2.9, "Transcript initialisation": the 21 elements, copied from the specification's
    /// text and not from the constants above.
    #[test]
    fn transcript_seed_is_the_specified_one() {
        let spec: [u32; 21] = [1397247044, 3, 2, 84, 12, 60, 34, 8, 5, 45, 16, 0, 0, 0, 2, 2, 0, 1, 8, 5, 2];
        assert_eq!(transcript_seed().map(|f| f.as_canonical_u32()), spec);
        assert_eq!(DEGREE_BITS, 13);
        assert_eq!(MAX_PROOF_BYTES, 200_000);
        assert_eq!((TRACE_WIDTH, NUM_PUBLIC_VALUES, NUM_PERIODIC, TRACE_LEN), (84, 60, 34, 4096));
    }

    /// The port of `research/shield3/tests/api.rs` on a stored vector: each refusal comes from the
    /// check the specification orders first. (The kind is asserted here, inside the crate, because
    /// it is not part of the public API.)
    #[test]
    fn check_order_and_refusal_kinds() {
        let (pi, proof) = vector("transfer");
        assert!(proof.len() <= MAX_PROOF_BYTES);
        verify_spend(&pi, &proof).expect("committed vector");

        // statement binding
        let mut bad = pi.clone();
        bad.fee += 1;
        assert!(matches!(verify_spend(&bad, &proof), Err(VerifyError(Refusal::Stark(_)))));
        // nf1 != nf2
        let same = PublicInputs { nf: [pi.nf[0], pi.nf[0]], ..pi.clone() };
        assert!(matches!(verify_spend(&same, &proof), Err(VerifyError(Refusal::DuplicateNullifier))));
        // one encoding: the trailing `degree_bits` varint (0x0d) written as 0x8d 0x00
        let n = proof.len();
        assert_eq!(&proof[n - 5..], &[0x0d, 0, 0, 0, 0]);
        let mut v = proof[..n - 5].to_vec();
        v.extend_from_slice(&[0x8d, 0x00]);
        v.extend_from_slice(&proof[n - 4..]);
        assert!(matches!(verify_spend(&pi, &v), Err(VerifyError(Refusal::NonCanonicalEncoding))));
        // a canonically encoded proof with another height
        let mut v = proof.clone();
        v[n - 5] = 0x0c;
        assert!(matches!(verify_spend(&pi, &v), Err(VerifyError(Refusal::DegreeBits { got: 12, want: 13 }))));
        // trailing byte, truncation
        let mut t = proof.clone();
        t.push(0);
        assert!(matches!(verify_spend(&pi, &t), Err(VerifyError(Refusal::Decode(_)))));
        assert!(matches!(verify_spend(&pi, &proof[..n - 1]), Err(VerifyError(Refusal::Decode(_)))));
        assert!(matches!(verify_spend(&pi, &[]), Err(VerifyError(Refusal::Decode(_)))));
        // the length cap is checked before anything else: before the nullifier check ...
        let mut long = proof.clone();
        long.resize(MAX_PROOF_BYTES + 1, 0);
        assert!(matches!(
            verify_spend(&pi, &long),
            Err(VerifyError(Refusal::TooLong { len, max })) if len == MAX_PROOF_BYTES + 1 && max == MAX_PROOF_BYTES
        ));
        assert!(matches!(
            verify_spend(&same, &vec![0xff; MAX_PROOF_BYTES + 1]),
            Err(VerifyError(Refusal::TooLong { .. }))
        ));
        // ... and the nullifier check before any decoding (garbage bytes, equal nullifiers)
        assert!(matches!(verify_spend(&same, &[0xff; 64]), Err(VerifyError(Refusal::DuplicateNullifier))));
        // exactly at the cap the bytes ARE looked at
        let mut at_cap = proof.clone();
        at_cap.resize(MAX_PROOF_BYTES, 0);
        assert!(matches!(verify_spend(&pi, &at_cap), Err(VerifyError(Refusal::Decode(_)))));
    }
}
