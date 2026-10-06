//! Shielded pool V2 — the wallet side (`docs/SHIELDED_POOL_V2_SPEC.md`, SPEC v1). Pure Rust, no
//! network, no user interface; compiles natively and to `wasm32-unknown-unknown`.
//!
//! * [`keys`] — key derivation from the BIP-39 seed (spec §5.2), the shielded address and its
//!   `rshield1…` encoding (spec §5.3, O-11);
//! * [`note_enc`] — encrypted notes (spec §3.4): ML-KEM-768 + HKDF-SHA256 + AES-256-GCM;
//! * [`body`] — the 2,546-byte transaction body (spec §3.2);
//! * [`tx`] — [`build_shield`], [`build_transfer`], [`build_unshield`]: body, binding, public
//!   inputs, witness, proof and the envelope of spec §3.1;
//! * [`store`] — what a wallet persists per note, the incremental note tree, and
//!   [`WalletState::scan`] over the node's `/api/shield-v2/notes` listing (spec §5.4);
//! * [`select`] — coin selection for two inputs, and the self-merge plan when a payment needs
//!   more.
//!
//! The proof is made by `quantum_vault_shield_v2::prove_spend(witness, public)`, which has no
//! seed parameter (spec §5.6). This crate depends on that crate's `prover` feature only — it
//! cannot name the test prover that takes a seed.
//!
//! This crate never sees an account's ML-DSA secret key: a `shield_v2` comes back with the bytes
//! to sign. See `NOTES.md` for every ambiguity of the specification and what was done, and for
//! what the UI layers still have to decide.

pub mod bech32m;
pub mod body;
mod entropy;
pub mod error;
mod field;
pub mod keys;
pub mod note_enc;
pub mod select;
pub mod store;
pub mod tx;

pub use body::{Body, TxKind, BODY_BYTES};
pub use error::WalletError;
pub use keys::{account_from_address, address_from_account, bip39_seed, ScanKey, ShieldedAddress, ShieldedKeys};
pub use select::{plan_merge, select_inputs, MergePlan, Selection};
pub use store::{ListingPage, OwnedNote, ScanReport, SpendInput, TreeTracker, WalletState};
pub use tx::{
    build_shield, build_transfer, build_unshield, BuiltTx, OutputRecord, OutputRole, ShieldRequest, TransferRequest,
    TxContext, UnprovenTx, UnshieldRequest,
};

/// The chain's transaction structure: the envelope of spec §3.1.
pub use quantum_vault_types::TxV1;

/// Consensus constants a wallet needs (spec §3.5, §4.3, §4.4, §2.9).
pub use quantum_vault_shield_v2::pool::{
    SHIELD_V2_ANCHOR_WINDOW, SHIELD_V2_MIN_FEE_QUANTA, SHIELD_V2_POOL_CAP_QUANTA,
};
pub use quantum_vault_shield_v2::MAX_PROOF_BYTES;

#[cfg(any(test, feature = "test-vectors"))]
pub use entropy::DeterministicEntropy;
