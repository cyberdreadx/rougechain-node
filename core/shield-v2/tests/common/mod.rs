//! Shared helpers of the ported review tests.
#![allow(dead_code)]

use quantum_vault_shield_v2::VerifyError;
use quantum_vault_shield_v2::reference::PublicInputs;

pub const VECTORS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/vectors");

/// A committed vector of spec §8.3: (public inputs, proof bytes).
pub fn vector(name: &str) -> (PublicInputs, Vec<u8>) {
    let proof = std::fs::read(format!("{VECTORS}/{name}.proof.bin")).unwrap();
    let pi = PublicInputs::from_bytes(&std::fs::read(format!("{VECTORS}/{name}.public.bin")).unwrap()).unwrap();
    (pi, proof)
}

/// The refusal kind, read from the log form of the error (it is not part of the API: spec §4.6).
pub fn kind(e: &VerifyError) -> &'static str {
    let s = format!("{e:?}");
    for k in ["TooLong", "DuplicateNullifier", "Decode", "NonCanonicalEncoding", "DegreeBits", "Stark", "Panicked"] {
        if s.starts_with(k) {
            return k;
        }
    }
    panic!("unknown refusal kind: {s}");
}

/// The library verifier ALONE (no length cap, no nullifier check, no canonical-encoding check, no
/// height pin), under a configuration built here from the numbers of spec §2.9 and not from the
/// crate's constants. A control for the review tests: it shows which refused byte strings are
/// true re-encodings of a valid proof. It needs the AIR, which a default build keeps private, so
/// it exists only with the `test-prover` feature; without it, `None`.
#[cfg(feature = "test-prover")]
pub fn library_only(pi: &PublicInputs, bytes: &[u8]) -> Option<bool> {
    Some(lib::verify(pi, bytes))
}

#[cfg(not(feature = "test-prover"))]
pub fn library_only(_pi: &PublicInputs, _bytes: &[u8]) -> Option<bool> {
    None
}

#[cfg(feature = "test-prover")]
mod lib {
    use p3_blake3::Blake3;
    use p3_challenger::{CanObserve, HashChallenger, SerializingChallenger32};
    use p3_commit::ExtensionMmcs;
    use p3_dft::Radix2DitParallel;
    use p3_field::PrimeCharacteristicRing;
    use p3_field::extension::BinomialExtensionField;
    use p3_fri::{FriParameters, HidingFriPcs};
    use p3_merkle_tree::MerkleTreeHidingMmcs;
    use p3_symmetric::{CompressionFunctionFromHasher, SerializingHasher};
    use p3_uni_stark::{Proof, StarkConfig};
    use quantum_vault_shield_v2::Felt;
    use quantum_vault_shield_v2::air::JoinSplitAir;
    use quantum_vault_shield_v2::reference::PublicInputs;
    use rand::SeedableRng;
    use rand::rngs::StdRng;

    type EF8 = BinomialExtensionField<Felt, 8>;
    type Dft = Radix2DitParallel<Felt>;
    type FieldHash = SerializingHasher<Blake3>;
    type Compress = CompressionFunctionFromHasher<Blake3, 2, 32>;
    type Challenger = SerializingChallenger32<Felt, HashChallenger<u8, Blake3, 32>>;
    type Mmcs = MerkleTreeHidingMmcs<Felt, u8, FieldHash, Compress, StdRng, 2, 32, 5>;
    type Cfg = StarkConfig<HidingFriPcs<Felt, Dft, Mmcs, ExtensionMmcs<Felt, EF8, Mmcs>, StdRng>, EF8, Challenger>;

    fn config() -> Cfg {
        // spec §2.9, "Transcript initialisation": "SHIELD-3", then the 21 elements as printed
        let mut ch = Challenger::new(HashChallenger::new(b"SHIELD-3".to_vec(), Blake3));
        for w in [1397247044u32, 3, 2, 84, 12, 60, 34, 8, 5, 45, 16, 0, 0, 0, 2, 2, 0, 1, 8, 5, 2] {
            ch.observe(Felt::from_u32(w));
        }
        let mut master = StdRng::from_seed([0u8; 32]);
        let a = StdRng::from_rng(&mut master);
        let b = StdRng::from_rng(&mut master);
        let mmcs = Mmcs::new(FieldHash::new(Blake3), Compress::new(Blake3), 0, a);
        let fri = FriParameters {
            log_blowup: 5,
            log_final_poly_len: 2,
            max_log_arity: 2,
            num_queries: 45,
            batch_proof_of_work_bits: 0,
            commit_proof_of_work_bits: 0,
            query_proof_of_work_bits: 16,
            mmcs: ExtensionMmcs::new(mmcs.clone()),
        };
        let pcs = HidingFriPcs::new(Dft::default(), mmcs, fri, 8, b);
        StarkConfig::new(pcs, ch).with_ood_proof_of_work_bits(0)
    }

    pub fn verify(pi: &PublicInputs, bytes: &[u8]) -> bool {
        let Ok((proof, rest)) = postcard::take_from_bytes::<Proof<Cfg>>(bytes) else { return false };
        if !rest.is_empty() {
            return false;
        }
        p3_uni_stark::verify(&config(), &JoinSplitAir::new(), &proof, &pi.to_values()).is_ok()
    }
}
