//! The wallet's randomness (spec §5.6, §5.7): commitment randomness `r`, the secrets of dummy
//! inputs, the keys of zero-value outputs, ML-KEM encapsulation randomness, the slot order.
//!
//! Production code draws all of it from the operating system's generator through [`OsEntropy`];
//! a failed read is an error and there is no other source. (The proof's blinding is not drawn
//! here at all: `prove_spend` draws it itself.) The deterministic sources below exist only under
//! `cfg(test)` / the `test-vectors` feature, to make the vectors of spec §8.4 reproducible.

use quantum_vault_shield_v2::reference::{Digest, MODULUS, ZERO_DIGEST};

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

pub(crate) fn bytes32(e: &mut dyn Entropy) -> Result<[u8; 32], WalletError> {
    let mut b = [0u8; 32];
    e.fill(&mut b)?;
    Ok(b)
}

/// 8 field elements, each uniform in [0, p), by rejection sampling of 31-bit values (spec §5.6).
/// A 31-bit value is rejected with probability 2^24 / 2^31; a source that is rejected 64 times in
/// a row for one element is broken and reported as an entropy failure.
pub(crate) fn digest(e: &mut dyn Entropy) -> Result<Digest, WalletError> {
    let mut out: Digest = ZERO_DIGEST;
    for slot in out.iter_mut() {
        let mut tries = 0;
        *slot = loop {
            let mut w = [0u8; 4];
            e.fill(&mut w)?;
            let v = u32::from_le_bytes(w) & 0x7fff_ffff;
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
pub(crate) fn coin(e: &mut dyn Entropy) -> Result<bool, WalletError> {
    let mut b = [0u8; 1];
    e.fill(&mut b)?;
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
        let a = digest(&mut OsEntropy).unwrap();
        let b = digest(&mut OsEntropy).unwrap();
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
        assert!(matches!(digest(&mut Ones), Err(WalletError::Entropy(_))));
        assert!(matches!(digest(&mut FailingEntropy), Err(WalletError::Entropy(_))));
    }
}
