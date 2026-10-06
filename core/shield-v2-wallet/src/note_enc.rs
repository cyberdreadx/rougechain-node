//! Encrypted notes (spec §3.4): ML-KEM-768 key agreement, HKDF-SHA256, AES-256-GCM.
//!
//! For output j with the recipient's encapsulation key `ek`:
//!
//! 1. `(kem_ct_j, ss) = ML-KEM-768.Encaps(ek)`;
//! 2. `key = HKDF-SHA256(ikm = ss, salt = 32 zero bytes, info = "rouge-shield/v2/note", L = 32)`;
//! 3. `plaintext = value (u64 LE) ‖ r (32 bytes)`;
//! 4. `note_ct_j = AES-256-GCM(key, nonce = 12 zero bytes, aad = cm_out_j, plaintext)` — 40 bytes
//!    of ciphertext and the 16-byte tag.
//!
//! The key is used for exactly one message (a fresh encapsulation per output), which is what
//! makes the fixed nonce safe.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use fips203::ml_kem_768;
use fips203::traits::{Decaps, Encaps, KeyGen, SerDes};
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::{Zeroize, Zeroizing};

use crate::entropy::{self, Entropy};
use crate::error::WalletError;
use crate::keys::{KEM_CT_BYTES, KEM_EK_BYTES};

pub const NOTE_INFO: &[u8] = b"rouge-shield/v2/note";
pub const NOTE_PLAINTEXT_BYTES: usize = 40;
pub const NOTE_CT_BYTES: usize = 56;

/// The 32 bytes ML-KEM's encapsulation draws, handed to `fips203` through its generator trait.
/// One use only: a second read fails instead of repeating the bytes.
struct OneShot {
    m: [u8; 32],
    used: bool,
}

impl rand_core::RngCore for OneShot {
    fn next_u32(&mut self) -> u32 {
        0
    }
    fn next_u64(&mut self) -> u64 {
        0
    }
    fn fill_bytes(&mut self, dest: &mut [u8]) {
        let _ = self.try_fill_bytes(dest);
    }
    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), rand_core::Error> {
        if self.used || dest.len() != 32 {
            // (any error: the caller maps it to `WalletError::Entropy`)
            return Err(rand_core::Error::from(core::num::NonZeroU32::MIN));
        }
        dest.copy_from_slice(&self.m);
        self.used = true;
        Ok(())
    }
}
impl rand_core::CryptoRng for OneShot {}

impl Drop for OneShot {
    fn drop(&mut self) {
        self.m.zeroize();
    }
}

fn note_key(ss: &[u8; 32]) -> Result<Zeroizing<[u8; 32]>, WalletError> {
    let mut key = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(&[0u8; 32]), ss)
        .expand(NOTE_INFO, &mut key[..])
        .map_err(|_| WalletError::Internal("HKDF expand"))?;
    Ok(key)
}

fn seal(ss: &[u8; 32], cm: &[u8; 32], value: u64, r: &[u8; 32]) -> Result<[u8; NOTE_CT_BYTES], WalletError> {
    let key = note_key(ss)?;
    let mut pt = Zeroizing::new([0u8; NOTE_PLAINTEXT_BYTES]);
    pt[..8].copy_from_slice(&value.to_le_bytes());
    pt[8..].copy_from_slice(r);
    let ct = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key[..]))
        .encrypt(Nonce::from_slice(&[0u8; 12]), Payload { msg: &pt[..], aad: cm })
        .map_err(|_| WalletError::Internal("AES-256-GCM encryption"))?;
    ct.as_slice().try_into().map_err(|_| WalletError::Internal("note ciphertext length"))
}

/// Encrypts `(value, r)` of the output whose commitment is `cm` to `ek`. Fresh encapsulation
/// randomness is drawn from `ent` for every call.
pub(crate) fn encrypt_note(
    ek: &[u8; KEM_EK_BYTES],
    cm: &[u8; 32],
    value: u64,
    r: &[u8; 32],
    ent: &mut dyn Entropy,
) -> Result<([u8; KEM_CT_BYTES], [u8; NOTE_CT_BYTES]), WalletError> {
    let ek = ml_kem_768::EncapsKey::try_from_bytes(*ek).map_err(|_| WalletError::Address("not a valid ML-KEM-768 encapsulation key"))?;
    let mut rng = OneShot { m: entropy::bytes32(ent)?, used: false };
    let (ss, ct) = ek.try_encaps_with_rng(&mut rng).map_err(|_| WalletError::Entropy("ML-KEM encapsulation failed".into()))?;
    let mut ss = ss.into_bytes();
    let sealed = seal(&ss, cm, value, r);
    ss.zeroize();
    Ok((ct.into_bytes(), sealed?))
}

/// Spec §3.4, last rule: an output without a recipient is encrypted the same way, to a freshly
/// generated ML-KEM-768 key that is discarded, so that both slots of every transaction look alike.
pub(crate) fn encrypt_to_nobody(
    cm: &[u8; 32],
    value: u64,
    r: &[u8; 32],
    ent: &mut dyn Entropy,
) -> Result<([u8; KEM_CT_BYTES], [u8; NOTE_CT_BYTES]), WalletError> {
    let (mut d, mut z) = (entropy::bytes32(ent)?, entropy::bytes32(ent)?);
    let (ek, dk) = ml_kem_768::KG::keygen_from_seed(d, z);
    d.zeroize();
    z.zeroize();
    drop(dk); // zeroized by the library
    encrypt_note(&ek.into_bytes(), cm, value, r, ent)
}

/// Trial decryption (spec §5.4): `Some((value, r))` iff the tag verifies under the key this
/// decapsulation key yields, with `aad = cm`. ML-KEM never fails on a foreign ciphertext (it
/// returns an unrelated secret — implicit rejection), so the AES-GCM tag is what tells "mine" from
/// "not mine". The caller still has to run the recipient check of spec §2.4.1 on the result.
pub(crate) fn decrypt_note(
    dk: &ml_kem_768::DecapsKey,
    kem_ct: &[u8; KEM_CT_BYTES],
    note_ct: &[u8; NOTE_CT_BYTES],
    cm: &[u8; 32],
) -> Option<(u64, [u8; 32])> {
    let ct = ml_kem_768::CipherText::try_from_bytes(*kem_ct).ok()?;
    let mut ss = dk.try_decaps(&ct).ok()?.into_bytes();
    let key = note_key(&ss).ok();
    ss.zeroize();
    let key = key?;
    let pt = Zeroizing::new(
        Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key[..]))
            .decrypt(Nonce::from_slice(&[0u8; 12]), Payload { msg: &note_ct[..], aad: cm })
            .ok()?,
    );
    if pt.len() != NOTE_PLAINTEXT_BYTES {
        return None;
    }
    let value = u64::from_le_bytes(pt[..8].try_into().ok()?);
    let r: [u8; 32] = pt[8..].try_into().ok()?;
    Some((value, r))
}

/// TEST VECTORS ONLY (spec §8.4): note encryption with the encapsulation randomness `m` given.
#[cfg(any(test, feature = "test-vectors"))]
pub fn encrypt_note_with_kem_randomness(
    ek: &[u8; KEM_EK_BYTES],
    cm: &[u8; 32],
    value: u64,
    r: &[u8; 32],
    m: [u8; 32],
) -> Result<([u8; KEM_CT_BYTES], [u8; NOTE_CT_BYTES], [u8; 32]), WalletError> {
    struct Fixed([u8; 32]);
    impl Entropy for Fixed {
        fn fill(&mut self, b: &mut [u8]) -> Result<(), WalletError> {
            if b.len() != 32 {
                return Err(WalletError::Internal("fixed KEM randomness is 32 bytes"));
            }
            b.copy_from_slice(&self.0);
            Ok(())
        }
    }
    let (kem_ct, note_ct) = encrypt_note(ek, cm, value, r, &mut Fixed(m))?;
    // the shared secret, for the vector file: recomputed the same way
    let ekk = ml_kem_768::EncapsKey::try_from_bytes(*ek).map_err(|_| WalletError::Address("not a valid ML-KEM-768 encapsulation key"))?;
    let (ss, _) = ekk.try_encaps_with_rng(&mut OneShot { m, used: false }).map_err(|_| WalletError::Internal("encaps"))?;
    Ok((kem_ct, note_ct, ss.into_bytes()))
}

/// TEST VECTORS ONLY: the public trial decryption, for the vector checker and the tests of other
/// crates.
#[cfg(any(test, feature = "test-vectors"))]
pub fn decrypt_note_with_key(dk: &[u8], kem_ct: &[u8; KEM_CT_BYTES], note_ct: &[u8; NOTE_CT_BYTES], cm: &[u8; 32]) -> Option<(u64, [u8; 32])> {
    let arr: [u8; crate::keys::KEM_DK_BYTES] = dk.try_into().ok()?;
    decrypt_note(&ml_kem_768::DecapsKey::try_from_bytes(arr).ok()?, kem_ct, note_ct, cm)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entropy::{DeterministicEntropy, FailingEntropy, OsEntropy};
    use crate::keys::ShieldedKeys;

    fn keys(n: u8) -> ShieldedKeys {
        ShieldedKeys::from_seed(&[n; 64]).unwrap()
    }

    #[test]
    fn roundtrip_and_every_binding() {
        let (alice, bob) = (keys(1), keys(2));
        let cm = [9u8; 32];
        let r = [3u8; 32];
        let (kem, note) = encrypt_note(&alice.address().ek, &cm, 123_456_789_012, &r, &mut OsEntropy).unwrap();
        let dk = alice.scan_key().decaps_key().unwrap();
        assert_eq!(decrypt_note(&dk, &kem, &note, &cm), Some((123_456_789_012, r)));
        // another wallet's key: no decryption
        assert_eq!(decrypt_note(&bob.scan_key().decaps_key().unwrap(), &kem, &note, &cm), None);
        // bound to the commitment (aad)
        let mut cm2 = cm;
        cm2[0] ^= 1;
        assert_eq!(decrypt_note(&dk, &kem, &note, &cm2), None);
        // any bit of either ciphertext
        for i in [0usize, 500, 1087] {
            let mut k = kem;
            k[i] ^= 1;
            assert_eq!(decrypt_note(&dk, &k, &note, &cm), None);
        }
        for i in 0..NOTE_CT_BYTES {
            let mut n = note;
            n[i] ^= 0x80;
            assert_eq!(decrypt_note(&dk, &kem, &n, &cm), None);
        }
        // a fresh encapsulation every time
        let (kem2, note2) = encrypt_note(&alice.address().ek, &cm, 123_456_789_012, &r, &mut OsEntropy).unwrap();
        assert_ne!(kem.to_vec(), kem2.to_vec());
        assert_ne!(note, note2);
    }

    #[test]
    fn nobody_can_read_a_dummy_and_entropy_failure_is_an_error() {
        let alice = keys(1);
        let (kem, note) = encrypt_to_nobody(&[1u8; 32], 0, &[2u8; 32], &mut OsEntropy).unwrap();
        assert_eq!(decrypt_note(&alice.scan_key().decaps_key().unwrap(), &kem, &note, &[1u8; 32]), None);
        assert!(matches!(encrypt_note(&alice.address().ek, &[1; 32], 1, &[2; 32], &mut FailingEntropy), Err(WalletError::Entropy(_))));
        assert!(matches!(encrypt_to_nobody(&[1; 32], 0, &[2; 32], &mut FailingEntropy), Err(WalletError::Entropy(_))));
    }

    #[test]
    fn fixed_randomness_is_reproducible() {
        let alice = keys(1);
        let a = encrypt_note_with_kem_randomness(&alice.address().ek, &[4; 32], 5, &[6; 32], [7; 32]).unwrap();
        let b = encrypt_note_with_kem_randomness(&alice.address().ek, &[4; 32], 5, &[6; 32], [7; 32]).unwrap();
        assert_eq!((a.0.to_vec(), a.1, a.2), (b.0.to_vec(), b.1, b.2));
        let mut e = DeterministicEntropy::new("t");
        let c = encrypt_note(&alice.address().ek, &[4; 32], 5, &[6; 32], &mut e).unwrap();
        assert_ne!(a.0.to_vec(), c.0.to_vec());
    }
}
