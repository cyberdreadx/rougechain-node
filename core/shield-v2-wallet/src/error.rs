//! One error type for the whole crate. No variant carries key or note material.

use core::fmt;

use quantum_vault_shield_v2::ProveError;

#[derive(Debug)]
pub enum WalletError {
    /// The operating system's generator failed. Nothing was built; there is no fallback.
    Entropy(String),
    /// A key-derivation input is unusable (seed length, non-ASCII recovery phrase, …).
    Key(&'static str),
    /// A shielded or `rouge1` address does not decode. The text says which check failed.
    Address(&'static str),
    /// A request the builders refuse before doing any work.
    Request(String),
    /// The fee is below `SHIELD_V2_MIN_FEE_QUANTA`.
    FeeBelowMinimum { fee: u64, min: u64 },
    /// The selected notes do not cover amount + fee.
    InsufficientFunds { have: u128, need: u128 },
    /// The payment needs more than two input notes: merge first (`plan_merge`), `merges` times.
    NeedsMerge { merges: usize },
    /// A note's Merkle path does not lead to the anchor the caller chose: the wallet's tree is
    /// not at that root (scan to the tip, or pick the wallet's own root as the anchor).
    AnchorMismatch,
    /// A 32-byte value that must be a digest of spec §2.8 has a word ≥ p.
    NonCanonical(&'static str),
    /// The note listing is malformed, out of order, or does not continue the wallet's state.
    Listing(String),
    /// Stored wallet state does not parse or is inconsistent.
    State(String),
    /// The prover refused (see `ProveError`).
    Prove(ProveError),
    /// An internal self-check failed. An implementation fault.
    Internal(&'static str),
}

impl fmt::Display for WalletError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WalletError::Entropy(e) => write!(f, "the operating system's random generator failed: {e}"),
            WalletError::Key(e) => write!(f, "key derivation: {e}"),
            WalletError::Address(e) => write!(f, "address: {e}"),
            WalletError::Request(e) => write!(f, "request: {e}"),
            WalletError::FeeBelowMinimum { fee, min } => write!(f, "fee {fee} quanta is below the minimum of {min}"),
            WalletError::InsufficientFunds { have, need } => {
                write!(f, "insufficient shielded funds: have {have} quanta, need {need}")
            }
            WalletError::NeedsMerge { merges } => write!(
                f,
                "the payment needs more than two notes: make {merges} self-merge transaction(s) first"
            ),
            WalletError::AnchorMismatch => {
                f.write_str("a note's Merkle path does not lead to the chosen anchor (wallet tree not at that root)")
            }
            WalletError::NonCanonical(what) => write!(f, "{what} is not a canonical digest"),
            WalletError::Listing(e) => write!(f, "note listing: {e}"),
            WalletError::State(e) => write!(f, "wallet state: {e}"),
            WalletError::Prove(e) => write!(f, "prover: {e}"),
            WalletError::Internal(e) => write!(f, "internal self-check failed: {e}"),
        }
    }
}

impl std::error::Error for WalletError {}

impl From<ProveError> for WalletError {
    fn from(e: ProveError) -> Self {
        match e {
            ProveError::Entropy(m) => WalletError::Entropy(m),
            other => WalletError::Prove(other),
        }
    }
}
