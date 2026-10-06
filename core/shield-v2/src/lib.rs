//! Shielded pool V2 — node side, stage 1. Specification: `docs/SHIELDED_POOL_V2_SPEC.md`
//! (SPEC v1). **Nothing in this crate is wired into block processing, and the daemon does not
//! depend on it.**
//!
//! Two parts:
//!
//! * the cryptographic layer of spec §2 — [`verify_spend`], the fixed-parameter production
//!   verifier (the only function whose result is consensus, and only as accept / refuse), with
//!   the encodings and primitives of [`reference`]. Ported from `research/shield3/src` without
//!   changing any constant, tag, encoding, parameter or check order;
//! * [`pool`] — the pool's consensus state and rules of spec §4 as pure logic behind a small
//!   storage trait: nullifier set, append-only commitment tree with its frontier, anchor window,
//!   pool total with the cap, the state-root section, and an all-or-nothing block apply.
//!
//! # Public API of a default build
//!
//! The production entry points of spec §2.11 and the pool module, nothing else:
//! [`verify_spend`] / [`VerifyError`] / [`MAX_PROOF_BYTES`]; [`reference::PublicInputs`]
//! (`from_bytes` / `to_bytes`), [`reference::digest_from_bytes`] / [`reference::digest_to_bytes`],
//! [`reference::binding_from_bytes`], [`reference::derive_rho`], [`reference::receive_note`] and
//! the commitment and nullifier functions; [`pool`].
//!
//! There is no `research` cargo feature (spec §7, L-3): no other parameter set, no hiding-OFF
//! mode and no second verifier exist in this crate in any build. The AIR ([`air`]), the layout
//! constants and the trace builder are private in a default build. The one feature,
//! `test-prover`, is off by default and must never be enabled by the daemon; it adds the research
//! prover and witness constructors for this crate's own forgery tests (see `Cargo.toml`).
//!
//! See `NOTES.md` for every place where the specification was ambiguous or differs from the
//! research code, and what was done.

#[cfg(feature = "test-prover")]
pub mod air;
#[cfg(not(feature = "test-prover"))]
#[allow(dead_code)]
mod air;

#[cfg(feature = "test-prover")]
pub mod layout;
#[cfg(not(feature = "test-prover"))]
#[allow(dead_code)]
mod layout;

pub mod pool;
pub mod reference;
pub mod verifier;

#[cfg(feature = "test-prover")]
pub mod trace;
#[cfg(feature = "test-prover")]
pub mod witness;

/// Base field: KoalaBear, p = 2^31 - 2^24 + 1.
pub type Felt = p3_koala_bear::KoalaBear;

pub use verifier::{MAX_PROOF_BYTES, VerifyError, verify_spend};
