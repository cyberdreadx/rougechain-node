//! Key derivation (spec §5.2) and the shielded address (spec §5.3, open issue O-11).

use fips203::ml_kem_768;
use fips203::traits::{KeyGen, SerDes};
use hkdf::Hkdf;
use quantum_vault_shield_v2::prover::wipe_digest;
use quantum_vault_shield_v2::reference::{derive_nk, derive_pk, Digest, MODULUS, ZERO_DIGEST};
use sha2::{Digest as _, Sha256, Sha512};
use zeroize::{Zeroize, Zeroizing};

use crate::bech32m;
use crate::error::WalletError;
use crate::field;

/// HKDF labels of spec §5.2.
pub const SK_INFO: &[u8] = b"rouge-shield/sk";
pub const VIEW_INFO: &[u8] = b"rouge-shield/view";
/// Bech32m prefix of a shielded address (O-11).
pub const SHIELDED_HRP: &str = "rshield";
/// Bech32m prefix of an account address.
pub const ACCOUNT_HRP: &str = "rouge";

pub const BIP39_SEED_BYTES: usize = 64;
pub const KEM_EK_BYTES: usize = 1_184;
pub const KEM_DK_BYTES: usize = 2_400;
pub const KEM_CT_BYTES: usize = 1_088;
/// `pk` (32) ‖ `ek` (1,184).
pub const ADDRESS_BYTES: usize = 32 + KEM_EK_BYTES;

/// BIP-39: recovery phrase and optional passphrase → the 64-byte seed
/// (PBKDF2-HMAC-SHA512, 2,048 rounds, salt `"mnemonic" ‖ passphrase`).
///
/// This does NOT check the phrase against a word list or its checksum — the wallet's BIP-39
/// library does that before calling — and it does not implement the NFKD normalisation BIP-39
/// prescribes, so it accepts ASCII only (every word of the English list is ASCII) and refuses
/// anything else rather than deriving a wrong seed. A wallet with a non-ASCII passphrase derives
/// the seed with its BIP-39 library and calls [`ShieldedKeys::from_seed`].
pub fn bip39_seed(phrase: &str, passphrase: &str) -> Result<Zeroizing<[u8; BIP39_SEED_BYTES]>, WalletError> {
    if !phrase.is_ascii() || !passphrase.is_ascii() {
        return Err(WalletError::Key("non-ASCII recovery phrase or passphrase: derive the BIP-39 seed externally"));
    }
    let words: Vec<&str> = phrase.split_ascii_whitespace().collect();
    if words.is_empty() {
        return Err(WalletError::Key("empty recovery phrase"));
    }
    let normalised = Zeroizing::new(words.join(" "));
    let mut salt = Zeroizing::new(Vec::with_capacity(8 + passphrase.len()));
    salt.extend_from_slice(b"mnemonic");
    salt.extend_from_slice(passphrase.as_bytes());
    let mut seed = Zeroizing::new([0u8; BIP39_SEED_BYTES]);
    pbkdf2::pbkdf2_hmac::<Sha512>(normalised.as_bytes(), &salt, 2_048, &mut seed[..]);
    Ok(seed)
}

/// Everything a wallet derives for the shielded pool. Secret (`sk`, `nk`, the viewing key);
/// wiped on drop; no `Debug`.
pub struct ShieldedKeys {
    sk: Digest,
    nk: Digest,
    pk: Digest,
    ek: [u8; KEM_EK_BYTES],
    dk: Zeroizing<Vec<u8>>,
}

impl Drop for ShieldedKeys {
    fn drop(&mut self) {
        wipe_digest(&mut self.sk);
        wipe_digest(&mut self.nk);
    }
}

impl ShieldedKeys {
    /// Spec §5.2 from the 64-byte BIP-39 seed:
    ///
    /// * `okm = HKDF-SHA256(ikm = seed, no salt, info = "rouge-shield/sk", L = 64)`;
    ///   `sk[i] = (LE u64 of okm[8i..8i+8]) mod p`;
    /// * `nk = H(1; sk)`, `pk = H(2; sk)`;
    /// * `d ‖ z = HKDF-SHA256(ikm = seed, no salt, info = "rouge-shield/view", L = 64)`;
    ///   `(ek, dk) = ML-KEM-768.KeyGen_internal(d, z)`.
    pub fn from_seed(seed: &[u8]) -> Result<Self, WalletError> {
        if seed.len() != BIP39_SEED_BYTES {
            return Err(WalletError::Key("the BIP-39 seed must be exactly 64 bytes"));
        }
        let hk = Hkdf::<Sha256>::new(None, seed);
        let mut okm = Zeroizing::new([0u8; 64]);
        hk.expand(SK_INFO, &mut okm[..]).map_err(|_| WalletError::Key("HKDF expand"))?;
        let mut sk = ZERO_DIGEST;
        for (i, e) in sk.iter_mut().enumerate() {
            let mut w = [0u8; 8];
            w.copy_from_slice(&okm[8 * i..8 * i + 8]);
            *e = field::felt((u64::from_le_bytes(w) % MODULUS as u64) as u32);
            w.zeroize();
        }
        let mut dz = Zeroizing::new([0u8; 64]);
        hk.expand(VIEW_INFO, &mut dz[..]).map_err(|_| WalletError::Key("HKDF expand"))?;
        let (mut d, mut z) = ([0u8; 32], [0u8; 32]);
        d.copy_from_slice(&dz[..32]);
        z.copy_from_slice(&dz[32..]);
        let (ek, dk) = ml_kem_768::KG::keygen_from_seed(d, z);
        d.zeroize();
        z.zeroize();
        Ok(Self {
            nk: derive_nk(&sk),
            pk: derive_pk(&sk),
            sk,
            ek: ek.into_bytes(),
            dk: Zeroizing::new(dk.into_bytes().to_vec()),
        })
    }

    /// [`bip39_seed`] then [`ShieldedKeys::from_seed`]. See the limits of [`bip39_seed`].
    pub fn from_phrase(phrase: &str, passphrase: &str) -> Result<Self, WalletError> {
        Self::from_seed(&bip39_seed(phrase, passphrase)?[..])
    }

    /// The wallet's one shielded address (spec §5.1, §5.3).
    pub fn address(&self) -> ShieldedAddress {
        ShieldedAddress { pk: field::bytes(&self.pk), ek: self.ek }
    }

    /// What scanning needs (spec §5.4): the viewing key, `pk` to authenticate a note, and `nk` to
    /// see which notes were spent. It cannot spend.
    pub fn scan_key(&self) -> ScanKey {
        ScanKey { pk: field::bytes(&self.pk), nk: Some(field::bytes(&self.nk)), dk: self.dk.clone() }
    }

    /// The viewing key alone (spec §5.2: "a user MAY give it to an auditor"): finds incoming
    /// notes and their values; cannot tell which were spent and cannot spend.
    pub fn incoming_viewing_key(&self) -> ScanKey {
        ScanKey { pk: field::bytes(&self.pk), nk: None, dk: self.dk.clone() }
    }

    pub(crate) fn sk(&self) -> &Digest {
        &self.sk
    }
    pub(crate) fn pk(&self) -> &Digest {
        &self.pk
    }

    /// Test vectors only (spec §8.4): the derived secrets as bytes.
    #[cfg(any(test, feature = "test-vectors"))]
    pub fn expose_for_vectors(&self) -> ([u8; 32], [u8; 32], [u8; 32], Vec<u8>, Vec<u8>) {
        (field::bytes(&self.sk), field::bytes(&self.nk), field::bytes(&self.pk), self.ek.to_vec(), self.dk.to_vec())
    }
}

/// The keys `scan` takes. `dk` is the ML-KEM-768 decapsulation key (the viewing key of spec
/// §5.2); `pk` authenticates each decrypted note (spec §2.4.1); `nk`, if present, lets the
/// scanner compute nullifiers and so mark notes spent.
#[derive(Clone)]
pub struct ScanKey {
    pub pk: [u8; 32],
    pub nk: Option<[u8; 32]>,
    pub(crate) dk: Zeroizing<Vec<u8>>,
}

impl ScanKey {
    /// From stored bytes. `dk` must be a valid 2,400-byte ML-KEM-768 decapsulation key.
    pub fn from_parts(pk: [u8; 32], nk: Option<[u8; 32]>, dk: &[u8]) -> Result<Self, WalletError> {
        field::check(&pk, "pk")?;
        if let Some(nk) = &nk {
            field::check(nk, "nk")?;
        }
        let key = Self { pk, nk, dk: Zeroizing::new(dk.to_vec()) };
        key.decaps_key()?;
        Ok(key)
    }

    pub fn dk_bytes(&self) -> &[u8] {
        &self.dk
    }

    pub(crate) fn decaps_key(&self) -> Result<ml_kem_768::DecapsKey, WalletError> {
        let mut arr: [u8; KEM_DK_BYTES] =
            self.dk.as_slice().try_into().map_err(|_| WalletError::Key("the viewing key must be 2,400 bytes"))?;
        let dk = ml_kem_768::DecapsKey::try_from_bytes(arr).map_err(|_| WalletError::Key("not a valid ML-KEM-768 decapsulation key"));
        arr.zeroize();
        dk
    }
}

/// A shielded address: `pk` (digest, 32 bytes) and the ML-KEM-768 encapsulation key (spec §5.3).
#[derive(Clone, PartialEq, Eq)]
pub struct ShieldedAddress {
    pub pk: [u8; 32],
    pub ek: [u8; KEM_EK_BYTES],
}

impl core::fmt::Debug for ShieldedAddress {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "ShieldedAddress({})", self.fingerprint())
    }
}

impl ShieldedAddress {
    /// The 1,216 bytes `pk ‖ ek`.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut v = Vec::with_capacity(ADDRESS_BYTES);
        v.extend_from_slice(&self.pk);
        v.extend_from_slice(&self.ek);
        v
    }

    /// Strict: exactly 1,216 bytes, `pk` a canonical digest, `ek` a valid ML-KEM-768
    /// encapsulation key (the modulus check of FIPS 203 §7.2).
    pub fn from_bytes(b: &[u8]) -> Result<Self, WalletError> {
        if b.len() != ADDRESS_BYTES {
            return Err(WalletError::Address("wrong length: a shielded address is 1,216 bytes"));
        }
        let mut pk = [0u8; 32];
        pk.copy_from_slice(&b[..32]);
        field::check(&pk, "the address's pk").map_err(|_| WalletError::Address("pk is not a canonical digest"))?;
        let mut ek = [0u8; KEM_EK_BYTES];
        ek.copy_from_slice(&b[32..]);
        ml_kem_768::EncapsKey::try_from_bytes(ek).map_err(|_| WalletError::Address("not a valid ML-KEM-768 encapsulation key"))?;
        Ok(Self { pk, ek })
    }

    /// `rshield1…` — bech32m of the 1,216 bytes (1,960 characters). O-11.
    pub fn encode(&self) -> String {
        bech32m::encode(SHIELDED_HRP, &self.to_bytes())
    }

    /// Decodes and validates an `rshield1…` string. The error says whether the checksum, the
    /// prefix, the length or the key material is wrong.
    pub fn decode(s: &str) -> Result<Self, WalletError> {
        let (hrp, bytes) = bech32m::decode(s.trim())?;
        if hrp != SHIELDED_HRP {
            return Err(WalletError::Address("wrong prefix: a shielded address starts with rshield1"));
        }
        Self::from_bytes(&bytes)
    }

    /// The first 8 bytes of SHA-256 of the 1,216 address bytes, hexadecimal: a short value two
    /// people can compare out of band (the "wallet-side integrity check on import" of O-11 — the
    /// bech32m checksum alone is weak at this length).
    pub fn fingerprint(&self) -> String {
        hex::encode(&Sha256::digest(self.to_bytes())[..8])
    }
}

/// The 32-byte payload of a `rouge1…` account address (spec §3.3: the `account` of an unshield).
pub fn account_from_address(address: &str) -> Result<[u8; 32], WalletError> {
    let (hrp, bytes) = bech32m::decode(address.trim())?;
    if hrp != ACCOUNT_HRP {
        return Err(WalletError::Address("wrong prefix: an account address starts with rouge1"));
    }
    bytes.as_slice().try_into().map_err(|_| WalletError::Address("wrong length: an account address carries 32 bytes"))
}

/// `rouge1…` of a 32-byte account payload.
pub fn address_from_account(account: &[u8; 32]) -> String {
    bech32m::encode(ACCOUNT_HRP, account)
}

/// The account payload of an ML-DSA-65 public key: SHA-256 of its 1,952 bytes (spec §3.3).
pub fn account_from_pub_key(pub_key: &[u8]) -> Result<[u8; 32], WalletError> {
    if pub_key.len() != 1_952 {
        return Err(WalletError::Request("from_pub_key must be the 1,952 bytes of an ML-DSA-65 public key".into()));
    }
    Ok(Sha256::digest(pub_key).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    /// BIP-39 reference vectors (the Trezor set): the same phrase without and with a passphrase.
    #[test]
    fn bip39_seed_known_answers() {
        assert_eq!(
            hex::encode(&bip39_seed(PHRASE, "").unwrap()[..]),
            "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4"
        );
        assert_eq!(
            hex::encode(&bip39_seed(PHRASE, "TREZOR").unwrap()[..]),
            "c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04"
        );
        // whitespace is normalised to single spaces; non-ASCII is refused, not mis-derived
        assert_eq!(bip39_seed(&PHRASE.replace(' ', "  \n"), "").unwrap()[..], bip39_seed(PHRASE, "").unwrap()[..]);
        assert!(bip39_seed(PHRASE, "pässword").is_err());
        assert!(bip39_seed("", "").is_err());
    }

    #[test]
    fn derivation_is_deterministic_and_separated() {
        let a = ShieldedKeys::from_phrase(PHRASE, "").unwrap();
        let b = ShieldedKeys::from_phrase(PHRASE, "").unwrap();
        let c = ShieldedKeys::from_phrase(PHRASE, "x").unwrap();
        assert_eq!(a.address(), b.address());
        assert_ne!(a.address(), c.address());
        assert_eq!(a.expose_for_vectors().0, b.expose_for_vectors().0);
        assert_ne!(a.expose_for_vectors().0, a.expose_for_vectors().1);
        assert_eq!(a.address().to_bytes().len(), ADDRESS_BYTES);
        assert_eq!(a.scan_key().dk_bytes().len(), KEM_DK_BYTES);
        assert!(ShieldedKeys::from_seed(&[0u8; 63]).is_err());
        assert!(ShieldedKeys::from_seed(&[0u8; 65]).is_err());
    }

    #[test]
    fn address_roundtrip_and_clear_errors() {
        let addr = ShieldedKeys::from_phrase(PHRASE, "").unwrap().address();
        let s = addr.encode();
        assert_eq!(s.len(), 7 + 1 + 1946 + 6);
        assert!(s.starts_with("rshield1"));
        assert_eq!(ShieldedAddress::decode(&s).unwrap(), addr);
        assert_eq!(ShieldedAddress::decode(&format!("  {s}\n")).unwrap(), addr);
        let err = |x: &str| match ShieldedAddress::decode(x) {
            Err(WalletError::Address(m)) => m,
            other => panic!("{:?}", other.map(|a| a.fingerprint())),
        };
        // one mistyped character
        let mut t = s.clone().into_bytes();
        t[100] = if t[100] == b'q' { b'p' } else { b'q' };
        assert!(err(core::str::from_utf8(&t).unwrap()).contains("checksum"));
        // truncated: the checksum no longer matches
        assert!(err(&s[..s.len() - 1]).contains("checksum"));
        // a valid bech32m string of the wrong length
        assert!(err(&bech32m::encode(SHIELDED_HRP, &addr.to_bytes()[..1215])).contains("length"));
        assert!(err(&bech32m::encode(SHIELDED_HRP, &[addr.to_bytes(), vec![0]].concat())).contains("length"));
        // an account address is not a shielded address, and the reverse
        let acct = address_from_account(&[7u8; 32]);
        assert!(err(&acct).contains("prefix"));
        assert!(matches!(account_from_address(&s), Err(WalletError::Address(m)) if m.contains("prefix")));
        assert_eq!(account_from_address(&acct).unwrap(), [7u8; 32]);
        // right length, non-canonical pk word
        let mut b = addr.to_bytes();
        b[..4].copy_from_slice(&MODULUS.to_le_bytes());
        assert!(err(&bech32m::encode(SHIELDED_HRP, &b)).contains("canonical"));
        // right length, an encapsulation key with a coefficient ≥ q
        let mut b = addr.to_bytes();
        b[32] = 0xff;
        b[33] = 0xff;
        assert!(err(&bech32m::encode(SHIELDED_HRP, &b)).contains("ML-KEM"));
    }
}
