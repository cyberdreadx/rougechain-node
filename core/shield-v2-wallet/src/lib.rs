//! Shielded pool V2 — the wallet side (`docs/SHIELDED_POOL_V2_SPEC.md`, SPEC v1). Pure Rust, no
//! network, no user interface; compiles natively and to `wasm32-unknown-unknown`.
//!
//! * [`keys`] — key derivation from the BIP-39 seed (spec §5.2), the shielded address and its
//!   `rshield1…` encoding (spec §5.3, O-11);
//! * [`note_enc`] — encrypted notes (spec §3.4): ML-KEM-768 + HKDF-SHA256 + AES-256-GCM;
//! * [`body`] — the 2,546-byte transaction body (spec §3.2);
//! * [`tx`] — [`build_shield`], [`build_transfer`], [`build_unshield`]: body, binding, public
//!   inputs, proof and the envelope of spec §3.1 (the witness never leaves the module);
//! * [`store`] — what a wallet persists per note, the incremental note tree,
//!   [`WalletState::scan`] over the node's `/api/shield-v2/notes` listing (spec §5.4), the check
//!   of the wallet's tree root, nullifier hash AND ciphertext hash against a strict majority of
//!   the nodes the wallet is configured with (`set_nodes`, `confirm_state`), and the pending
//!   transactions (`pending` / `resolve`), which settle on confirmed data only (spec §5.5).
//!   A transfer or an unshield is built and locked in one call ([`build_transfer`],
//!   [`build_unshield`] → [`LockedTx`]): persist the returned state, then submit;
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
pub use error::{json_error, WalletError};
pub use keys::{account_from_address, address_from_account, bip39_seed, ScanKey, ShieldedAddress, ShieldedKeys};
pub use select::{plan_merge, plan_merge_with, select_inputs, select_inputs_with, MergePlan, Selection};
pub use store::{
    canonical_node_id, ciphertext_acc_step, Balances, ConfirmReport, Dissent, ListingPage, OwnedNote, PendingChange,
    PendingStatus, PendingTx, PoolView, Resolution, ScanReport, SpendInput, StateReport, Tally, TreeTracker, WalletState,
    DEFAULT_MAX_UNSPENT_NOTES, DEFAULT_MIN_NOTE_VALUE, MAX_CONFIGURED_NODES, MAX_SPENT_RETAINED, MAX_STORED_NOTES,
    MAX_UNSPENT_NOTES_LIMIT, MIN_CONFIGURED_NODES, PRUNE_RETENTION_BLOCKS, STATE_VERSION,
};
pub use tx::{
    build_shield, build_transfer, build_unshield, BuiltTx, LockedTx, OutputRecord, OutputRole, ShieldRequest,
    SpendOptions, TransferParams, TransferRequest, TxContext, UnprovenTx, UnshieldParams, UnshieldRequest,
    DEFAULT_EXPIRY_OFFSET, DEFAULT_MAX_FEE_QUANTA, MAX_EXPIRY_OFFSET,
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
