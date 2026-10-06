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
//! constants and the trace builder are private in a default build.
//!
//! # Features (both off by default; the daemon enables neither)
//!
//! * `prover` — the wallet prover of spec §5.6: `prover::prove_spend(witness, public)`. It has
//!   **no seed parameter**: the blinding seed is drawn inside it from the operating system's
//!   generator, once per proof, and hedged with the witness, the public inputs and a per-call
//!   counter. See `prover.rs`.
//! * `test-prover` — the research prover with a caller-supplied seed, the unvalidated trace
//!   builder and the research witness constructors, for forgery tests and the vectors of spec
//!   §8.3. Never part of a wallet build.
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
// The wallet prover lays out its (validated) witness with the same builder; in a `prover` build
// without `test-prover` the builder and its test knobs are private.
#[cfg(all(feature = "prover", not(feature = "test-prover")))]
#[allow(dead_code)]
mod trace;
#[cfg(feature = "test-prover")]
pub mod witness;

#[cfg(feature = "prover")]
pub mod prover;

/// `true` iff this build of the crate contains the wallet prover (the `prover` feature, which
/// `test-prover` implies). The node must never be built with it: the daemon asserts at compile
/// time that this is `false` in every non-test build (`daemon/src/shield_v2.rs`), so a build that
/// unifies the feature into the daemon — `cargo build --workspace` — fails instead of producing a
/// node binary with a prover in it. Not a protocol constant.
pub const PROVER_COMPILED: bool = cfg!(feature = "prover");

/// Base field: KoalaBear, p = 2^31 - 2^24 + 1.
pub type Felt = p3_koala_bear::KoalaBear;

#[cfg(feature = "prover")]
pub use prover::{InputWitness, OutputWitness, ProveError, SpendWitness, prove_spend};
pub use verifier::{MAX_PROOF_BYTES, VerifyError, verify_spend};
