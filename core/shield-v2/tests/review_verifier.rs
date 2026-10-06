//! The verifier-only parts of the two independent reviews and of the SHIELD-3 fix tests, on the
//! committed vectors, in a DEFAULT build (no feature): `review_f1_noncanonical_proof_encoding_is_refused`
//! and `review_public_inputs_have_one_encoding` from `research/shield3/tests/review_verifier.rs`,
//! `f1_noncanonical_sweep` from `tests/shield3.rs`. The forced-trace tests of those files need the
//! prover and are in `tests/forgery.rs` (`test-prover` feature).
//!
//! Not portable: `f3_verify_spend_has_one_built_in_parameter_set` proved under five other
//! configurations with the research API. This crate has no other configuration in any build, so
//! the property it tested holds by construction; its transcript-seed assertion is a unit test of
//! `src/verifier.rs`.
//!
//! Run: `cargo test --release -p quantum-vault-shield-v2 -j 1 --test review_verifier -- --nocapture --test-threads=1`

mod common;

use std::collections::BTreeSet;

use common::{kind, library_only, vector};
use quantum_vault_shield_v2::reference::*;
use quantum_vault_shield_v2::{MAX_PROOF_BYTES, verify_spend};

// =================================================================================================
// FINDING F-1 (SHIELD-2): the proof bytes were malleable — `verify_spend` insisted on "no trailing
// bytes" only, and postcard accepts over-long (non-canonical) varints. SHIELD-3 FIX: a length cap
// before decoding and a decode / re-encode / compare-bytes check. The reviewer's seven
// re-encodings of the committed transfer vector must all be REFUSED as `NonCanonicalEncoding`.
// =================================================================================================

#[test]
fn review_f1_noncanonical_proof_encoding_is_refused() {
    let (pi, proof) = vector("transfer");
    verify_spend(&pi, &proof).expect("committed vector verifies");

    // controls (unchanged)
    let mut t = proof.clone();
    t.push(0);
    assert!(verify_spend(&pi, &t).is_err(), "trailing byte");
    let mut t = proof.clone();
    t[proof.len() / 2] ^= 1;
    assert!(verify_spend(&pi, &t).is_err(), "bit flip");
    assert!(verify_spend(&pi, &[]).is_err(), "empty");
    assert!(verify_spend(&pi, &proof[..proof.len() - 1]).is_err(), "truncated");

    // The proof ends with `degree_bits` (a varint, 13 = 0x0d) and the out-of-domain proof-of-work
    // witness (4 zero bytes).
    let n = proof.len();
    assert_eq!(&proof[n - 5..], &[0x0d, 0, 0, 0, 0]);
    let mut variants: Vec<Vec<u8>> = Vec::new();
    // (a) degree_bits = 13 written with one, two, ... redundant continuation bytes
    for extra in 1..=6usize {
        let mut v = proof[..n - 5].to_vec();
        v.push(0x8d);
        v.extend(std::iter::repeat_n(0x80, extra - 1));
        v.push(0x00);
        v.extend_from_slice(&proof[n - 4..]);
        variants.push(v);
    }
    // (b) the first byte is the length (1) of the trace commitment's cap vector
    assert_eq!(proof[0], 0x01);
    let mut v = vec![0x81, 0x00];
    v.extend_from_slice(&proof[1..]);
    variants.push(v);
    let (mut accepted, mut refused_noncanonical, mut still_valid_for_the_library) = (0, 0, 0);
    for v in &variants {
        assert_ne!(v, &proof);
        match verify_spend(&pi, v) {
            Ok(()) => accepted += 1,
            Err(e) if kind(&e) == "NonCanonicalEncoding" => refused_noncanonical += 1,
            Err(e) => panic!("refused, but not as a non-canonical encoding: {e:?}"),
        }
        // the finding still exists one layer down: without the new check these bytes verify
        if library_only(&pi, v) == Some(true) {
            still_valid_for_the_library += 1;
        }
    }
    println!(
        "REVIEW|F-1 proof malleability (fixed)|{} re-encodings of a valid proof tried (different bytes, {}..{} B vs {} B)|ACCEPTED by verify_spend: {accepted}|refused as NonCanonicalEncoding: {refused_noncanonical}|accepted by the library verifier alone (no canonical check; test-prover feature only): {still_valid_for_the_library}",
        variants.len(),
        variants.iter().map(Vec::len).min().unwrap(),
        variants.iter().map(Vec::len).max().unwrap(),
        n
    );
    assert_eq!(accepted, 0, "F-1 is back: a non-canonical encoding is accepted");
    assert_eq!(refused_noncanonical, variants.len());
    if library_only(&pi, &proof).is_some() {
        assert_eq!(still_valid_for_the_library, variants.len(), "the control lost its meaning: the re-encodings are not valid proofs any more");
    }
}

/// `verify_spend` takes the amounts as u64 and derives the limbs; the byte decoder refuses
/// non-canonical field elements everywhere. One valid proof, every single-byte change of the 216
/// public bytes (all 255 other values of 24 sampled bytes + one bit of every byte): no second
/// public-input encoding is accepted.
#[test]
fn review_public_inputs_have_one_encoding() {
    let (pi, proof) = vector("unshield");
    let public = pi.to_bytes();
    assert_eq!(public, std::fs::read(format!("{}/unshield.public.bin", common::VECTORS)).unwrap());
    verify_spend(&pi, &proof).unwrap();
    let (mut decoded, mut refused_by_decoder) = (0, 0);
    let mut try_one = |b: &[u8]| match PublicInputs::from_bytes(b) {
        None => refused_by_decoder += 1,
        Some(other) => {
            assert_ne!(other, pi, "two byte strings decode to the same public inputs");
            assert_eq!(other.to_bytes(), b, "decode / encode is not the identity");
            assert!(verify_spend(&other, &proof).is_err(), "altered public bytes accepted");
            decoded += 1;
        }
    };
    for byte in 0..PUBLIC_INPUT_BYTES {
        let mut b = public.clone();
        b[byte] ^= 0x80; // the top bit: for a field element this often makes the word >= p
        try_one(&b);
    }
    for byte in (3..PUBLIC_INPUT_BYTES).step_by(9) {
        for v in 0..=255u8 {
            if v != public[byte] {
                let mut b = public.clone();
                b[byte] = v;
                try_one(&b);
            }
        }
    }
    // other lengths are not public inputs at all
    for len in [0, 1, 215, 217, 432] {
        assert!(PublicInputs::from_bytes(&vec![0u8; len]).is_none(), "{len} bytes decoded");
    }
    println!("REVIEW|public-input encoding|{decoded} altered encodings decoded and refused by the verifier|{refused_by_decoder} refused by the strict decoder|0 accepted");
}

// =================================================================================================
// F-1 / F-5 (SHIELD-3 fix tests)
// =================================================================================================

#[test]
fn f1_noncanonical_sweep() {
    let (pi, proof) = vector("transfer");
    let n = proof.len();
    verify_spend(&pi, &proof).expect("committed vector verifies");
    let mut accepted = 0usize;

    // (1) over-long varints at many positions. Every byte < 0x80 could be the last byte of a
    // varint; rewriting it as `b | 0x80, 0x00` (and with 2 and 3 redundant bytes) is the same
    // number in a non-minimal encoding. Where the byte really is a varint, the result decodes to
    // the SAME proof — the library verifier alone accepts it — and `verify_spend` must refuse it
    // as non-canonical. Where the byte is part of a fixed-width field element or a digest, the
    // result is simply a different (invalid) byte string and must be refused as well.
    let mut positions: BTreeSet<usize> = (0..1500.min(n)).collect();
    positions.extend(n - 1500..n);
    positions.extend((0..n).step_by(61));
    let (mut tried, mut noncanonical, mut real_reencodings, mut other) = (0usize, 0usize, 0usize, 0usize);
    let mut where_noncanonical = BTreeSet::new();
    let mut where_real = BTreeSet::new();
    for &p in &positions {
        if proof[p] >= 0x80 {
            continue;
        }
        for extra in 1..=3usize {
            let mut v = proof[..p].to_vec();
            v.push(proof[p] | 0x80);
            v.extend(std::iter::repeat_n(0x80, extra - 1));
            v.push(0x00);
            v.extend_from_slice(&proof[p + 1..]);
            assert_eq!(v.len(), n + extra);
            tried += 1;
            match verify_spend(&pi, &v) {
                Ok(()) => accepted += 1,
                Err(e) if kind(&e) == "NonCanonicalEncoding" => {
                    noncanonical += 1;
                    where_noncanonical.insert(p);
                    if library_only(&pi, &v) == Some(true) {
                        real_reencodings += 1;
                        where_real.insert(p);
                    }
                }
                Err(_) => other += 1,
            }
        }
    }
    println!(
        "S3|F-1|over-long varints|{tried} rewrites at {} byte positions of a {n}-byte proof|ACCEPTED by verify_spend: {accepted}|refused as NonCanonicalEncoding: {noncanonical} at {} distinct positions, of which valid for the library verifier alone (true re-encodings of the same proof; test-prover feature only): {real_reencodings} at {} distinct positions|refused otherwise (decode / verifier error): {other}",
        positions.len(),
        where_noncanonical.len(),
        where_real.len()
    );
    assert_eq!(accepted, 0);
    assert!(where_noncanonical.len() >= 20, "the sweep must hit real varints at several positions: {where_noncanonical:?}");
    if library_only(&pi, &proof).is_some() {
        assert!(where_real.len() >= 20, "the sweep must hit real varints at several positions: {where_real:?}");
    }

    // (2) trailing bytes
    let mut trailing = 0;
    for extra in [vec![0u8], vec![0xff], vec![0; 2], vec![0x80, 0x00], vec![0; 100], proof[..64].to_vec()] {
        let mut v = proof.clone();
        v.extend_from_slice(&extra);
        let r = verify_spend(&pi, &v);
        assert!(matches!(&r, Err(e) if kind(e) == "Decode"), "trailing {:?}: {r:?}", extra.len());
        trailing += 1;
    }
    // (3) truncated input
    let mut truncated = 0;
    for keep in [0usize, 1, 2, 31, 32, 33, 100, n / 3, n / 2, n - 1000, n - 33, n - 5, n - 4, n - 2, n - 1] {
        let r = verify_spend(&pi, &proof[..keep]);
        assert!(matches!(&r, Err(e) if kind(e) == "Decode"), "truncated to {keep}: {r:?}");
        truncated += 1;
    }
    // (4) the length cap, checked before decoding: cap + 1 bytes are refused as TooLong whatever
    // they contain (a valid proof padded, zeros, 0xff, a non-canonical proof padded), also at
    // 10 MB; exactly cap bytes is NOT TooLong (it goes on to the decoder, which refuses it)
    let cap = MAX_PROOF_BYTES;
    assert!(n <= cap);
    let mut padded = proof.clone();
    padded.resize(cap + 1, 0);
    let too_long = |r: Result<(), quantum_vault_shield_v2::VerifyError>, len: usize| {
        let e = r.expect_err("must be refused");
        assert_eq!(kind(&e), "TooLong");
        assert_eq!(format!("{e:?}"), format!("TooLong {{ len: {len}, max: {cap} }}"));
    };
    too_long(verify_spend(&pi, &padded), cap + 1);
    too_long(verify_spend(&pi, &vec![0u8; cap + 1]), cap + 1);
    too_long(verify_spend(&pi, &vec![0xffu8; cap + 1]), cap + 1);
    too_long(verify_spend(&pi, &vec![0x80u8; 10_000_000]), 10_000_000);
    assert!(matches!(&verify_spend(&pi, &padded[..cap]), Err(e) if kind(e) == "Decode"));
    assert!(matches!(&verify_spend(&pi, &vec![0u8; cap]), Err(e) if ["Decode", "DegreeBits", "NonCanonicalEncoding", "Stark"].contains(&kind(e))));
    // the equal-nullifier check does not come before the cap
    let same = PublicInputs { nf: [pi.nf[0], pi.nf[0]], ..pi.clone() };
    too_long(verify_spend(&same, &padded), cap + 1);
    println!(
        "S3|F-1|framing|trailing bytes: {trailing} forms refused (Decode)|truncations: {truncated} refused (Decode)|cap = {cap} bytes: cap+1 bytes refused as TooLong for 4 contents and at 10 MB, before decoding; exactly cap bytes reaches the decoder and is refused there|0 accepted"
    );

    // (5) what "canonical" means, positively: decode -> encode is the identity on every committed
    // vector, and the prover's output is accepted unchanged
    for name in ["shield", "transfer", "unshield"] {
        let (pi, proof) = vector(name);
        verify_spend(&pi, &proof).unwrap();
    }
}
