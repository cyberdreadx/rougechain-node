# shield-v2 — implementation notes (stage 1)

Specification: `docs/SHIELDED_POOL_V2_SPEC.md` (SPEC v1, @9523076). Research source:
`research/shield3/src` on branch `spec/shielded-pool-v1` (tree `8a435868…`). This file lists every
place where the specification was ambiguous, where it differs from the research code, or where a
choice had to be made that the specification does not fix. Nothing here is wired into the daemon.

## Provenance of the port

| File | Origin | Change |
|---|---|---|
| `src/air.rs` | `research/shield3/src/air.rs` | byte-identical (sha256 `8804f16a…`) |
| `src/layout.rs` | `research/shield3/src/layout.rs` | byte-identical (`fa43060a…`) |
| `src/trace.rs` | `research/shield3/src/trace.rs` | byte-identical (`2a1ef41a…`); `test-prover` feature only |
| `src/reference.rs` | `research/shield3/src/reference.rs` lines 1–171, 205–207, 280–388 | module header and two doc comments reworded; code unchanged |
| `src/witness.rs` | `research/shield3/src/reference.rs` lines 173–199, 208–279, 390–633 | header + `use` lines added; code unchanged; `test-prover` feature only |
| `src/verifier.rs` | `research/shield3/src/config.rs`, normal-build path only | rewritten without the generic `Setup`/`Params`/`Visitor` machinery; constants, types, transcript and check order unchanged (see below) |
| `src/pool.rs` | new | spec §4 |
| `vectors/*` | `research/shield3/vectors/*` | byte-identical; SHA-256 checked against spec §8.1 in `tests/vectors.rs` |

## Decisions and deviations

1. **Plonky3 pin.** Git dependency on `https://github.com/Plonky3/Plonky3.git`, `rev =
   a21e3ed42905040ad49c519e402f018381c12d0c` (v0.8.0, spec §2.1/§2.9), 13 crates named directly,
   20 reached. The fetched checkout was diffed against the vendored copy the research crate used
   (`~/qv-trustless/research/stark0/track-p/vendor/Plonky3`, itself at that commit): all 20 crate
   directories and the workspace `Cargo.toml` are identical (the only difference in the whole tree
   is cargo's `.cargo-ok` marker). The daemon's dependency tree (`cargo tree -p
   quantum-vault-daemon -e normal,build`) is unchanged by the new workspace member.
   `postcard` is pinned `~1.1.3` (spec §2.9.1: "postcard 1.1.x"); the lock resolves to 1.1.3, the
   version the research crate used. `rand` 0.10.3, `blake3` 1.8.7: as in the research lock.

2. **Edition 2024**, unlike the sibling crates (2021): the ported sources are edition-2024 code and
   the proof library is too; keeping the edition avoids any semantic drift in the byte-identical
   files.

3. **The prover is behind the `test-prover` feature** (off by default; the daemon never enables
   it). It contains `verifier::prove_spend(trace, public, seed)` — the research prover, verbatim
   semantics, for the ONE built-in parameter set — plus `trace.rs` and `witness.rs`. It is not the
   wallet prover of spec §5.6 (it takes a caller-supplied seed; open issue O-14 stands). There is no
   `research` feature and no other parameter set, hiding-OFF mode, Poseidon2 proof hasher,
   library-only verifier or transcript hook in any build (spec §7, L-3). Default-build tests use the
   stored vectors only; `tests/forgery.rs` and `tests/negative.rs` require the feature.

4. **`VerifyError` is opaque.** Spec §2.11 names the signature `verify_spend(public, proof_bytes)
   -> Result<(), VerifyError>`; spec §4.6 (L-4) says only accept / refuse is consensus. The research
   enum had public variants. Here `VerifyError` is a struct around a private enum with `Debug`,
   `Display` and `std::error::Error` only — no variants, no accessors, no `PartialEq` — so node code
   cannot pattern-match or compare it. Tests that need the kind read the `Debug` text (the ported
   review tests' `kind()` helper does the same); the one test that asserts the kind of every check
   is a unit test inside `src/verifier.rs`.

5. **A panic inside the proof library is caught** (`catch_unwind`) and reported as a refusal of
   kind `Panicked`. The research verifier would have propagated the panic. The reviews found no
   input that panics (review2's typed-mutation, hostile-allocation and bit-flip sweeps are ported
   and still count panics: zero). This is defence in depth for an unwinding build; with
   `panic = "abort"` it does nothing. Accept/refuse is unaffected (a panic was never an accept).

6. **Research doc comment corrected.** The research `MAX_PROOF_BYTES` comment said the cap "is NOT
   a proven upper bound … prove again with a fresh seed". Spec §7 C-1 corrects this: it is a bound
   (largest honest proof 194,893 B). The port's comment says so; the test that derives the bound
   (`review2_proof_length_bound`) is ported and additionally asserts the 194,893 / 5,107 figures.

7. **Public surface of a default build.** `air` and `layout` are private modules in a default
   build (`pub` only with `test-prover`): the AIR is normative text, not an entry point. `reference`
   is public in full — besides the §2.11 entry points it exposes the sponge (`hash_dom`,
   `hash_dom_idx`, `permute`, `merge`), `Note`, `SparseTree` and `root_from_path`, which the
   primitive vectors of §8.2 and a wallet need. They are pure functions over field elements and
   create no second verifier.

8. **Pool input (`PoolTx`).** The pool takes the body fields it reads as 32-byte digests and u64
   amounts, plus `account` (copied into the effects, not interpreted). It assumes checks 1–7, 11,
   12, 14, 19 and 20 of §3.6 were made by the caller and REPEATS checks 8 (canonical digests, no
   all-zero output commitment), 9 (`nf1 ≠ nf2`) and 10 (amount pattern), because the pool's own
   invariants depend on them. It does not enforce `SHIELD_V2_MIN_FEE_QUANTA` (check 11, a stateless
   check with a provisional value, O-6); the constant is declared in `pool.rs` for a single home.

9. **Per-block limit** (§4.7 / §3.6 check 13) is checked once for the whole slice before the first
   transaction, not when the 9th transaction is reached. Same accept/refuse outcome for the block;
   only the error kind differs, and kinds are not consensus.

10. **Node-local bookkeeping in the store.** `StoredPool` carries `activation_height` and
    `next_height` so that blocks are applied in order from A and a store cannot be opened for the
    wrong network. Neither is consensus state and neither enters the state-root section.

11. **Two-phase apply.** `validate_block` (pure) → `PreparedBlock` → `commit` (one atomic store
    write). `PreparedBlock::state_root_section` lets the caller compare the header before anything
    is stored, so a rejected block needs no undo. Undoing a block that WAS committed (a reorg, or
    the daemon's own rollback path after a later mismatch) is left to the storage backend's
    snapshot/restore and to stage 2; the in-memory store is `Clone` for that. Spec §4.2 rule 5 and
    §4.1 ("same pre-apply snapshot and the same rollback") are therefore only half-covered here.

12. **Anchor window as a list with repeats.** §4.3 rule 4 says a block without V2 transactions
    leaves the root unchanged and §4.5 appends `R(H)` for every block, so the window can hold the
    same digest many times. Membership is what rule 5 asks for. Consequence, tested: a root stays
    accepted as long as empty blocks keep repeating it, and ages out 128 blocks after the LAST block
    whose root it was. The initial window `[E_32]` is `R(A − 1)`.

13. **`state_root_section(root_before)`** requires exactly 64 lowercase hexadecimal characters
    (§4.8: "the previous root entered as its 64-character lowercase hexadecimal string") and returns
    `PoolError::BadPreviousRoot` otherwise; the daemon's existing roots are `hex::encode(sha256)`.
    `window_len > 128` is a `CorruptState` error, not a panic.

14. **Full tree.** §3.6 check 17 (`note_count + 2 ≤ 2^32`) is enforced; the root of a completely
    full tree (2^32 leaves, nothing waiting in the frontier) is the carried-out node of the last
    append, which the frontier formula cannot express — handled explicitly and tested with a
    fabricated near-full state.

15. **Regression constants.** `tests/pool.rs` pins two state-root-section values produced by this
    implementation (`REGRESSION_GENESIS`, `REGRESSION_BUSY`). They are regression guards, not
    normative vectors: spec §8.1 / O-15 says no vector for §4.8 exists yet. Each is also
    recomputed in the test byte by byte from the specification's layout.

16. **Tests not portable.** `f3_verify_spend_has_one_built_in_parameter_set` and
    `n11_weaker_or_different_options` proved under other configurations with the research API;
    this crate has none, so the property holds by construction. The hiding-OFF half of every
    forgery test is likewise absent. `n12` keeps only the 8,192-row-trace case. The privacy tests
    (`tests/privacy.rs`) and the AIR-only inventories (`review_inventory.rs`, `review2_link_inventory`,
    `review2_new_selectors_every_row_every_cycle`) exercise the prover and the constraint checker,
    not the verifier, and were not ported.

17. **No spec/research contradiction found** in what was ported: the verifier's check order (§2.9
    steps 1–7), the 21 transcript elements, the parameter set, the 60-value public layout, the
    encodings and the primitive vectors all agree between spec text, research code and this crate
    (asserted by `tests/vectors.rs` and the unit tests).

18. **`cargo tree` was run without `-j 1`**: `cargo tree` does not accept a jobs flag. Every other
    cargo invocation used the required resource wrapper and `-j 1`.
