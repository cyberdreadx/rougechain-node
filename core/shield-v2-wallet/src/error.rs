//! One error type for the whole crate. No variant carries key or note material, and **no error
//! text quotes caller input** (REVIEW_WALLET_1 F-6): the texts are fixed strings; where a JSON
//! argument does not parse, the text is a fixed sentence plus the parser's category and the line
//! and column of the failure ([`json_error`]) — never the parser's own message, which quotes the
//! offending value. The only variable parts of any text are numbers the chain or the wallet
//! computed (heights, counts, consensus limits).

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
    /// The fee is above the caller's ceiling (`max_fee`; default 10 × the minimum fee).
    FeeAboveMaximum { fee: u64, max: u64 },
    /// The note is an input of a transaction that is still pending: it stays locked until
    /// `resolve` settles that transaction on confirmed data (mined, superseded or expired).
    NoteLocked,
    /// The note is known from one node's listing only (`confirm_state` has not confirmed its
    /// height): it is handed to a builder only on the caller's explicit `allow_unverified`.
    NoteUnverified,
    /// The state in hand does not have the revision the caller expects: another writer has
    /// changed the stored state since this copy was loaded. Reload and repeat.
    StaleState,
    /// The state holds notes found without `nk` and cannot tell which of them were spent since:
    /// rebuild it by scanning from an empty state with the full scan key.
    RescanRequired,
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
            WalletError::FeeBelowMinimum { min, .. } => write!(f, "the fee is below the minimum of {min} quanta"),
            WalletError::FeeAboveMaximum { .. } => f.write_str("the fee is above the caller's ceiling (max_fee; default 10 x the minimum fee)"),
            WalletError::NoteLocked => f.write_str("the note is an input of a pending transaction (locked until it is settled on confirmed data)"),
            WalletError::NoteUnverified => f.write_str("the note is unverified (known from one node's listing only): confirm the state first, or allow unverified inputs explicitly"),
            WalletError::StaleState => f.write_str("the state is not at the expected revision: another writer changed it; reload the stored state and repeat"),
            WalletError::RescanRequired => f.write_str(
                "the state was scanned without nk and spends may have been missed: rescan from an empty state with the full scan key",
            ),
            WalletError::InsufficientFunds { .. } => f.write_str("insufficient shielded funds"),
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

/// The text for a JSON argument that does not parse: what it was meant to be (a fixed word of
/// this crate), the parser's error category and the position. The parser's message is dropped on
/// purpose — for a value of the wrong type it quotes the value, and the value may be a key or a
/// whole wallet state.
pub fn json_error(what: &'static str, e: &serde_json::Error) -> String {
    let category = match e.classify() {
        serde_json::error::Category::Io => "io",
        serde_json::error::Category::Syntax => "syntax",
        serde_json::error::Category::Data => "data",
        serde_json::error::Category::Eof => "eof",
    };
    format!("{what}: malformed JSON ({category} error at line {}, column {})", e.line(), e.column())
}

impl From<ProveError> for WalletError {
    fn from(e: ProveError) -> Self {
        match e {
            ProveError::Entropy(m) => WalletError::Entropy(m),
            other => WalletError::Prove(other),
        }
    }
}
