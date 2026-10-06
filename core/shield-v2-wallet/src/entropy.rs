//! The wallet's randomness (spec §5.6, §5.7): commitment randomness `r`, the secrets of dummy
//! inputs, the keys of zero-value outputs, ML-KEM encapsulation randomness, the slot order.
//!
//! **One hedged generator per transaction** (REVIEW_WALLET_1 F-5, spec §5.6 item 6). A builder
//! reads 32 bytes from the operating system's generator once — a failed read, or 32 zero bytes,
//! is an error and there is no other source — and derives every random value of that transaction
//! from
//!
//! ```text
//! prk  = HMAC-SHA256(key = the 32 OS bytes;
//!                    "rouge-shield/v2/wallet/tx-randomness/v1" ‖ counter (u64 LE)
//!                    ‖ the spending key (or nothing, for a shield) ‖ the transaction's inputs and outputs)
//! draw = HKDF-Expand(prk, info = use label ‖ index (u8) ‖ draw number (u32 LE))
//! ```
//!
//! (`HKDF-Extract` with the OS bytes as the salt is exactly that keyed hash.) `counter` counts
//! the transactions assembled by the process. Every use has its own label ([`Draw`]) and every
//! output slot / input slot its own index, and no two draws of one transaction share a draw
//! number — so a generator that repeats (a restored VM snapshot, a broken polyfill) can never
//! give two notes the same `r` or the same ML-KEM randomness, neither inside one transaction nor
//! across two different ones. With a working generator the output is as unpredictable as the 256
//! OS bits; with a broken one it is as unpredictable as the spending key (for a shield, which
//! has none: as the recipient's `pk`, which is not on chain). This is a hardening, not a
//! substitute for a working generator.
//!
//! (The proof's blinding is not drawn here at all: `prove_spend` draws and hedges it itself.) The
//! deterministic sources below exist only under `cfg(test)` / the `test-vectors` feature, to make
//! the vectors of spec §8.4 reproducible.

use std::sync::atomic::{AtomicU64, Ordering};

use hkdf::Hkdf;
use quantum_vault_shield_v2::reference::{Digest, MODULUS, ZERO_DIGEST};
use sha2::Sha256;
use zeroize::{Zeroize, Zeroizing};

use crate::error::WalletError;
use crate::field::felt;

/// A source of random bytes. Not public: callers of this crate cannot supply one.
pub(crate) trait Entropy {
    fn fill(&mut self, buf: &mut [u8]) -> Result<(), WalletError>;
}

/// The operating system's generator (`getrandom`; Web Crypto in a browser).
pub(crate) struct OsEntropy;

impl Entropy for OsEntropy {
    fn fill(&mut self, buf: &mut [u8]) -> Result<(), WalletError> {
        getrandom::getrandom(buf).map_err(|e| WalletError::Entropy(e.to_string()))?;
        if buf.len() >= 16 && buf.iter().all(|&b| b == 0) {
            return Err(WalletError::Entropy("the generator returned only zero bytes".into()));
        }
        Ok(())
    }
}

/// What a random value of a transaction is used for. Each use is a separate domain of the hedged
/// generator.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Draw {
    /// `sk` / `rho` / `r` of the dummy input in slot `index` (spec §5.7).
    DummySk,
    DummyRho,
    DummyR,
    /// The commitment randomness `r` of the output in slot `index` (spec §5.6).
    OutputR,
    /// The ML-KEM-768 encapsulation randomness `m` of the output in slot `index` (spec §3.4).
    KemRandomness,
    /// `d`, `z` of the discarded ML-KEM key of a zero-value output in slot `index`.
    NobodyD,
    NobodyZ,
    /// The secret behind the random `pk` of a zero-value output.
    NobodyPk,
    /// The order of the two output slots (spec §5.5).
    SlotOrder,
}

impl Draw {
    fn label(self) -> &'static [u8] {
        match self {
            Draw::DummySk => b"dummy-input/sk",
            Draw::DummyRho => b"dummy-input/rho",
            Draw::DummyR => b"dummy-input/r",
            Draw::OutputR => b"output/r",
            Draw::KemRandomness => b"output/ml-kem-m",
            Draw::NobodyD => b"nobody/ml-kem-d",
            Draw::NobodyZ => b"nobody/ml-kem-z",
            Draw::NobodyPk => b"nobody/pk",
            Draw::SlotOrder => b"slot-order",
        }
    }
}

/// The random values of one transaction.
pub(crate) trait TxRandom {
    fn fill(&mut self, what: Draw, index: u8, buf: &mut [u8]) -> Result<(), WalletError>;
}

pub(crate) const HEDGE_TAG: &[u8] = b"rouge-shield/v2/wallet/tx-randomness/v1";

/// Transactions assembled by this process (the `counter` of the hedge).
static TX_COUNTER: AtomicU64 = AtomicU64::new(0);

/// The per-transaction hedged generator (module documentation).
pub(crate) struct Hedged {
    prk: Zeroizing<[u8; 32]>,
    draws: u32,
}

impl Hedged {
    /// `secret`: the spending key's 32 bytes (`None` for a shield). `transcript`: the
    /// transaction's inputs and outputs, in a fixed length-prefixed encoding. One read of `os`.
    pub(crate) fn new(os: &mut dyn Entropy, secret: Option<&[u8; 32]>, transcript: &[u8]) -> Result<Self, WalletError> {
        let mut key = Zeroizing::new([0u8; 32]);
        os.fill(&mut key[..])?;
        if key.iter().all(|&b| b == 0) {
            return Err(WalletError::Entropy("the generator returned only zero bytes".into()));
        }
        let counter = TX_COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut ikm = Zeroizing::new(Vec::with_capacity(HEDGE_TAG.len() + 8 + 1 + 32 + transcript.len()));
        ikm.extend_from_slice(HEDGE_TAG);
        ikm.extend_from_slice(&counter.to_le_bytes());
        match secret {
            Some(sk) => {
                ikm.push(32);
                ikm.extend_from_slice(sk);
            }
            None => ikm.push(0),
        }
        ikm.extend_from_slice(transcript);
        let (prk, _) = Hkdf::<Sha256>::extract(Some(&key[..]), &ikm);
        let mut out = Zeroizing::new([0u8; 32]);
        out.copy_from_slice(&prk);
        Ok(Self { prk: out, draws: 0 })
    }
}

impl TxRandom for Hedged {
    fn fill(&mut self, what: Draw, index: u8, buf: &mut [u8]) -> Result<(), WalletError> {
        let label = what.label();
        let mut info = [0u8; 40];
        let n = label.len();
        info[..n].copy_from_slice(label);
        info[n] = index;
        info[n + 1..n + 5].copy_from_slice(&self.draws.to_le_bytes());
        self.draws = self.draws.checked_add(1).ok_or(WalletError::Internal("too many random draws in one transaction"))?;
        Hkdf::<Sha256>::from_prk(&self.prk[..])
            .map_err(|_| WalletError::Internal("HKDF key"))?
            .expand(&info[..n + 5], buf)
            .map_err(|_| WalletError::Internal("HKDF expand"))
    }
}

/// TEST VECTORS ONLY: the draws taken from a byte stream in the order they are asked for, labels
/// ignored — what makes the bodies of spec §8.4 reproducible. Never part of a wallet build.
#[cfg(any(test, feature = "test-vectors"))]
pub(crate) struct Stream<'a>(pub(crate) &'a mut dyn Entropy);

#[cfg(any(test, feature = "test-vectors"))]
impl TxRandom for Stream<'_> {
    fn fill(&mut self, _: Draw, _: u8, buf: &mut [u8]) -> Result<(), WalletError> {
        self.0.fill(buf)
    }
}

pub(crate) fn bytes32(e: &mut dyn TxRandom, what: Draw, index: u8) -> Result<[u8; 32], WalletError> {
    let mut b = [0u8; 32];
    e.fill(what, index, &mut b)?;
    Ok(b)
}

/// 8 field elements, each uniform in [0, p), by rejection sampling of 31-bit values (spec §5.6).
/// A 31-bit value is rejected with probability 2^24 / 2^31; a source that is rejected 64 times in
/// a row for one element is broken and reported as an entropy failure.
pub(crate) fn digest(e: &mut dyn TxRandom, what: Draw, index: u8) -> Result<Digest, WalletError> {
    let mut out: Digest = ZERO_DIGEST;
    for slot in out.iter_mut() {
        let mut tries = 0;
        *slot = loop {
            let mut w = [0u8; 4];
            e.fill(what, index, &mut w)?;
            let v = u32::from_le_bytes(w) & 0x7fff_ffff;
            w.zeroize();
            if v < MODULUS {
                break felt(v);
            }
            tries += 1;
            if tries == 64 {
                return Err(WalletError::Entropy("rejection sampling did not terminate".into()));
            }
        };
    }
    Ok(out)
}

/// One uniform bit.
pub(crate) fn coin(e: &mut dyn TxRandom, what: Draw) -> Result<bool, WalletError> {
    let mut b = [0u8; 1];
    e.fill(what, 0, &mut b)?;
    Ok(b[0] & 1 == 1)
}

/// TEST VECTORS ONLY: a reproducible byte stream, `SHA-256("rouge-shield/v2/test-vector-entropy"
/// ‖ label ‖ counter)`. Never compiled into a wallet build.
#[cfg(any(test, feature = "test-vectors"))]
pub struct DeterministicEntropy {
    label: Vec<u8>,
    counter: u64,
    buf: Vec<u8>,
}

#[cfg(any(test, feature = "test-vectors"))]
impl DeterministicEntropy {
    pub fn new(label: &str) -> Self {
        Self { label: label.as_bytes().to_vec(), counter: 0, buf: Vec::new() }
    }
}

#[cfg(any(test, feature = "test-vectors"))]
impl Entropy for DeterministicEntropy {
    fn fill(&mut self, out: &mut [u8]) -> Result<(), WalletError> {
        use sha2::{Digest as _, Sha256};
        for o in out.iter_mut() {
            if self.buf.is_empty() {
                let mut h = Sha256::new();
                h.update(b"rouge-shield/v2/test-vector-entropy");
                h.update((self.label.len() as u64).to_le_bytes());
                h.update(&self.label);
                h.update(self.counter.to_le_bytes());
                self.counter += 1;
                self.buf = h.finalize().to_vec();
                self.buf.reverse(); // pop() then yields the block in order
            }
            *o = self.buf.pop().unwrap_or(0);
        }
        Ok(())
    }
}

/// TEST ONLY: a generator that always fails.
#[cfg(any(test, feature = "test-vectors"))]
pub struct FailingEntropy;

#[cfg(any(test, feature = "test-vectors"))]
impl Entropy for FailingEntropy {
    fn fill(&mut self, _: &mut [u8]) -> Result<(), WalletError> {
        Err(WalletError::Entropy("injected failure (test)".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canonical(d: &Digest) -> [u32; 8] {
        let b = quantum_vault_shield_v2::reference::digest_to_bytes(d);
        core::array::from_fn(|i| u32::from_le_bytes([b[4 * i], b[4 * i + 1], b[4 * i + 2], b[4 * i + 3]]))
    }

    #[test]
    fn os_digests_are_canonical_and_fresh() {
        let mut h = Hedged::new(&mut OsEntropy, None, b"t").unwrap();
        let a = digest(&mut h, Draw::OutputR, 0).unwrap();
        let b = digest(&mut h, Draw::OutputR, 0).unwrap();
        assert_ne!(a, b);
        assert!(canonical(&a).iter().all(|&w| w < MODULUS));
    }

    #[test]
    fn deterministic_stream_is_reproducible_and_label_separated() {
        let mut a = DeterministicEntropy::new("x");
        let mut b = DeterministicEntropy::new("x");
        let mut c = DeterministicEntropy::new("y");
        let (mut ba, mut bb, mut bc) = ([0u8; 100], [0u8; 100], [0u8; 100]);
        a.fill(&mut ba).unwrap();
        // the same stream read in pieces
        b.fill(&mut bb[..33]).unwrap();
        b.fill(&mut bb[33..]).unwrap();
        c.fill(&mut bc).unwrap();
        assert_eq!(ba, bb);
        assert_ne!(ba, bc);
    }

    /// A source whose every 31-bit draw is ≥ p (all ones) is reported, not looped on.
    #[test]
    fn broken_source_is_an_error() {
        struct Ones;
        impl Entropy for Ones {
            fn fill(&mut self, b: &mut [u8]) -> Result<(), WalletError> {
                b.fill(0xff);
                Ok(())
            }
        }
        assert!(matches!(digest(&mut Stream(&mut Ones), Draw::OutputR, 0), Err(WalletError::Entropy(_))));
        assert!(matches!(digest(&mut Stream(&mut FailingEntropy), Draw::OutputR, 0), Err(WalletError::Entropy(_))));
        // the hedged generator needs the operating system's bytes: a failure or 32 zero bytes is
        // an error, never a fallback to the spending key alone
        assert!(matches!(Hedged::new(&mut FailingEntropy, Some(&[7u8; 32]), b"t"), Err(WalletError::Entropy(_))));
        struct Zeros;
        impl Entropy for Zeros {
            fn fill(&mut self, b: &mut [u8]) -> Result<(), WalletError> {
                b.fill(0);
                Ok(())
            }
        }
        assert!(matches!(Hedged::new(&mut Zeros, Some(&[7u8; 32]), b"t"), Err(WalletError::Entropy(_))));
    }

    /// F-5: under a generator that returns the same bytes for ever, every draw still differs —
    /// by use, by index, by draw number, by transaction (counter), by key and by transcript.
    #[test]
    fn hedged_draws_never_repeat_under_a_stuck_generator() {
        struct Stuck;
        impl Entropy for Stuck {
            fn fill(&mut self, b: &mut [u8]) -> Result<(), WalletError> {
                b.fill(0x2a);
                Ok(())
            }
        }
        let mut seen = std::collections::BTreeSet::new();
        for (sk, transcript) in [(Some([1u8; 32]), "a"), (Some([1u8; 32]), "a"), (Some([2u8; 32]), "a"), (Some([1u8; 32]), "b"), (None, "a")] {
            let mut h = Hedged::new(&mut Stuck, sk.as_ref(), transcript.as_bytes()).unwrap();
            for what in [Draw::DummySk, Draw::DummyRho, Draw::DummyR, Draw::OutputR, Draw::KemRandomness, Draw::NobodyD, Draw::NobodyZ, Draw::NobodyPk, Draw::SlotOrder] {
                for index in 0..2u8 {
                    for _ in 0..2 {
                        assert!(seen.insert(bytes32(&mut h, what, index).unwrap()), "{what:?}/{index} repeated");
                    }
                }
            }
        }
        assert_eq!(seen.len(), 5 * 9 * 2 * 2);
    }
}
