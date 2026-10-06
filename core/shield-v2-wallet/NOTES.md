# Shielded pool V2 — wallet core: implementation notes

Specification: `docs/SHIELDED_POOL_V2_SPEC.md` (SPEC v1, amended 2026-10-06, W-1 … W-8). Branch
`feat/shield-v2-wallet-core`, from `main` @4aeb25b (which contains the node side).

Three pieces:

| Piece | Where | What |
|---|---|---|
| the wallet prover | `core/shield-v2`, cargo feature `prover` | `prove_spend(witness, public)` — no seed parameter |
| the wallet logic | `core/shield-v2-wallet` (this crate) | keys, address, note encryption, the three builders, scanning, the note tree, coin selection |
| the WebAssembly package | `core/shield-v2-wasm` | a wasm-bindgen surface over this crate |

Nothing here is active on any network, nothing here makes a network call, and nothing here has a
user interface. **None of it has been reviewed by a second person.** The prover change in
particular touches the only entropy of a proof's privacy; spec O-14 asks for a review and that
review has not happened.

---

## 1. The prover (`core/shield-v2`, feature `prover`)

1. **API.** `prove_spend(witness: &SpendWitness, public: &PublicInputs) -> Result<Vec<u8>,
   ProveError>`. There is no seed parameter and no function that returns, stores or accepts a
   seed. The research function `verifier::prove_spend(trace, public, seed)` still exists, behind
   `#[cfg(all(feature = "prover", any(test, feature = "test-prover")))]`; the wallet crate depends
   on `prover` only and so cannot name it. `tests/prover.rs` scans the crate's source and fails
   if any `pub fn` whose signature mentions a seed is outside the test configuration.
2. **Randomness (spec §5.6).** Per call: 32 bytes from `getrandom` (the operating system; Web
   Crypto on `wasm32-unknown-unknown` through the `js` backend). An error — or 32 zero bytes — is
   `ProveError::Entropy`; no other source is consulted. The seed handed to the proof library is
   `Blake3-keyed(key = those 32 bytes; "rouge-shield/v2/prover/blinding-seed/v1" ‖ counter (u64
   LE) ‖ the 216 public-input bytes ‖ the witness)`; `counter` is a process-wide count of proofs
   started. The spec's item 4 names the witness and the public inputs; the task asked for a
   per-call counter as well, so that a generator stuck on one value does not repeat the masks for
   the same statement inside one process. Recorded in the spec as W-7.
3. **What "zeroized after use" covers, and what it does not.** Wiped by this crate, on every exit
   path: the entropy buffer, the serialised witness, the Blake3 hasher (its `zeroize` feature,
   enabled by `prover` only), the seed, the trace-builder inputs, and every `SpendWitness` /
   `InputWitness` / `OutputWitness` when dropped. **Not wiped:** the copies the proof library
   makes — the seed inside its two ChaCha generators (`rand::StdRng` does not zeroize) and the
   witness inside the trace matrix and its low-degree extensions. They are freed, not
   overwritten. Changing that means patching the pinned library, which this work does not do.
   On WebAssembly the linear memory is never returned to the system at all, so "freed" means
   "still in the instance's memory until overwritten"; a wallet that wants a hard guarantee
   proves in a worker and terminates the worker afterwards.
4. **No panics on caller data.** `prove_spend` checks the complete statement of spec §2.7 in
   plain Rust first (`ProveError::Witness` names the rule that does not hold), so no proof is
   attempted for a witness the verifier would refuse. The trace builder indexes fixed-size arrays
   only. A panic inside the proof library is caught (`ProveError::Panicked`) in unwinding builds.
   `wasm32-unknown-unknown` aborts on panic — a trap — and `catch_unwind` does nothing there;
   the validation in front is the defence. Not excluded: allocation failure (a trap in
   WebAssembly, an abort natively).
5. **The output is checked.** A proof above `MAX_PROOF_BYTES` is `ProveError::ProofTooLong` (an
   implementation fault per spec §5.5, not a reason to retry), and every proof goes through
   `verify_spend` before it is returned. The builders verify once more with public inputs re-read
   from the body the way the node reads them.
6. **Feature layout.** `prover = [getrandom, zeroize, blake3/zeroize]`; `test-prover =
   ["prover"]`. A default build (the daemon's) compiles neither, no trace builder and no witness
   type. The wallet and wasm crates are workspace members but **not default members**
   (`core/Cargo.toml`): a plain `cargo build` in `core/` builds what it built before.
   **`cargo build --workspace` would unify features and compile the daemon with `prover`**; node
   builds use `-p quantum-vault-daemon` (the Dockerfile, `auto-deploy.sh` and the installer do;
   `deploy-srv421059.sh` runs a bare `cargo build --release`, which the default-member list keeps
   unchanged). Check: `cargo tree -p quantum-vault-daemon -e normal,build,features -i
   quantum-vault-shield-v2` shows the default feature only, and the same tree contains neither
   the wallet nor the wasm crate.

## 2. Where the specification was ambiguous, and what was done

| # | Spec | Ambiguity or gap | What this crate does |
|---|---|---|---|
| 1 | §5.2 | "the 64-byte BIP-39 seed" — the crate needs the seed, the wallet has a phrase | The primary entry is `ShieldedKeys::from_seed(&[u8; 64])`. `bip39_seed(phrase, passphrase)` is a convenience: PBKDF2-HMAC-SHA512, 2,048 rounds, checked against the BIP-39 reference vectors. It does **not** validate the word list or checksum and does **not** implement NFKD, so it refuses non-ASCII input instead of deriving a wrong seed. Wallets already have a BIP-39 library (`@scure/bip39`); they should pass the seed |
| 2 | §5.2 | "no salt" (keys) vs "salt = 32 zero bytes" (§3.4) | The same HKDF input (RFC 5869). Matches the wallet's existing `hkdf(sha256, seed, undefined, info, L)` idiom in `packages/core`. Spec W-3 |
| 3 | §5.2 | `sk[i] = (LE u64 …) mod p` — reduction of a 64-bit word | Done literally with integer arithmetic, then converted; the vector test recomputes it independently |
| 4 | §5.2, O-9 | wallets without a recovery phrase | Not supported: there is no entry point that takes an account secret key. Such a wallet has no shielded address until the owner decides O-9 |
| 5 | §5.2 | "The decapsulation key is the viewing key", but §5.4's scan needs more | `ScanKey { dk, pk, nk: Option }`. `(dk, pk)` finds incoming notes and values; with `nk` it also sees spends; neither spends. `incoming_viewing_key()` is what an auditor gets. Spec W-5 |
| 6 | §5.3, O-11 | no textual address form | `rshield1…`: bech32m without the 1,023-character limit, written out in `bech32m.rs` because the `bech32` crate enforces the limit. 1,960 characters. Decoding validates checksum, prefix, length, canonical `pk` and the ML-KEM key, each with its own error. The 30-bit checksum is weak at this length, so `ShieldedAddress::fingerprint()` (8 bytes of SHA-256) is offered for out-of-band comparison. Provisional; spec W-4 |
| 7 | §3.1 | which signing format a shield uses | `encode_tx_for_signing` (the chain's own function, used through `quantum-vault-types`, not re-implemented). The `signed_payload` format the spec also allows is not produced. Spec W-2 |
| 8 | §3.1 | "every other payload field MUST be absent" vs the chain's encoder | The chain's `TxPayload` encoder writes most absent fields as `null` and omits the newer ones; both decode to `None`, which is what the node checks. The envelope is produced by that encoder |
| 9 | §3.4 | ML-KEM `Encaps` randomness | 32 bytes from the wallet's entropy per output, passed to `fips203` through a one-shot generator that errors on a second read. The library's own `encaps_from_seed` is not used because it contains an `expect` |
| 10 | §3.4 | the "freshly generated key that it discards" of a zero-value output | `KeyGen_internal(d, z)` with fresh `d`, `z`; the decapsulation key is dropped (zeroized by the library) before encapsulating |
| 11 | §3.5, §3.6 | a shield with `fee = v_in` is valid on the node | Refused by the builder (it shields nothing). Also refused: a zero transfer amount, a zero `v_out`, a deposit above the pool cap. Spec W-6 |
| 12 | §5.5 | "SHOULD place the payment and the change in a random order" | One random bit per transaction orders the two output slots, for all three types. `BuiltTx::outputs` records which slot is which for the sender; a receiver tries both |
| 13 | §5.5 | input slot order | Not randomised (real notes in the order given, a dummy second). The proof hides which slot is real |
| 14 | §5.5 | anchor and expiry | Chosen by the caller and passed in. The builder checks that every real input's path leads to the anchor (`AnchorMismatch` otherwise) and does **not** check that `expiry_height` is inside the anchor's validity — it has no chain view. Before the first block from activation the node's stats report `pool: null`; the anchor is then the empty-tree root (`WalletState::new(..).anchor()`) |
| 15 | §5.4 | "kept current as leaves are appended" | `TreeTracker`: frontier + one 32-sibling path per unspent non-zero note; 32 hashes per appended leaf plus 32 comparisons per tracked note. Checked against the reference sparse tree, the stage-1 `Pool` and a real node (root and frontier) |
| 16 | §5.4 | "MUST follow reorganisations" | The tracker cannot undo an append. `scan` requires each page to continue the state exactly (`from_height`, and the leaf position of every output) and refuses otherwise, leaving the state untouched; recovery is a rescan from an empty state. A reorganisation that replaces already-scanned blocks is noticed only at the next mismatching leaf or by comparing `WalletState::anchor()` with the node's `latest_anchor` — which the UI layer must do. Spec W-5 |
| 17 | §5.4 | zero-value notes addressed to the wallet (its own zero change) | Stored as notes (they are the wallet's) but no path is tracked and they are never selected |
| 18 | §5.4 | "its own record of what it sent" | Not persisted by this crate. `BuiltTx::outputs` (slot, role, value, `r`, `cm`) is what a UI stores; a restore does not recover it (O-10) |
| 19 | §5.4 | notes of a transaction that is submitted but not yet mined | `mark_pending_spent` / `unmark_pending` on the state; the scan confirms from the chain. Expiry of a pending transaction is the UI's bookkeeping |
| 20 | §2.11 | the entry-point table named `prove_spend(trace, public, seed)` | Replaced by the implemented signature. Spec W-1 |
| 21 | task | "`getrandom`; on wasm32 the `js` backend" with two `getrandom` majors in the lock file | `getrandom` 0.2 with `js` on `wasm32-unknown-unknown` (target-specific dependency in both crates). The 0.4 in the lock file belongs to other crates and is not used here |
| 22 | task | "same idiom as `core/wasm-prover`" | `core/wasm-prover` (V1) is a raw `extern "C"` module with a host-supplied random function, not wasm-bindgen. The new package uses wasm-bindgen as the task says; the V1 idiom was not copied because a host-supplied generator is exactly the kind of caller-controlled entropy §5.6 rules out |

**ML-KEM implementation.** `fips203` 0.4.3 (pure Rust, `no_std`, constant-time by `subtle`,
zeroizing). `core/crypto` contains no ML-KEM — it has `fips204` for ML-DSA-65 — so the sibling
crate by the same authors was taken; `core/crypto` itself is not a dependency (it pulls in the V1
STARK library). It exposes `KeyGen_internal(d, z)` as `keygen_from_seed`, which §5.2 needs. The
TypeScript side uses `@noble/post-quantum`; both implement final FIPS 203. **Not cross-checked
against `@noble/post-quantum` here** (no `node_modules` on this host and nothing was installed);
`keys.json` and `note_encryption.json` exist so that the TypeScript side can check itself.

## 3. Test vectors (spec §8.4, O-15)

`core/shield-v2/vectors/wallet/{keys,note_encryption,transactions,state_root}.json`, generated by
`tests/vectors.rs` (`SHIELD_V2_WRITE_VECTORS=1` writes; otherwise the test regenerates and
compares). Determinism comes from the `test-vectors` feature only: a labelled SHA-256 stream in
place of the operating system's generator for dummy secrets, `r`, zero-output keys, encapsulation
randomness and slot order. The feature is off by default, is enabled only as a dev-dependency
feature, and does not reach the prover — the vectors contain no proof.

Cross-checks: the wallet crate's own reader; the stage-1 `Pool`; and the daemon's
`node::shield_v2_wallet_interop_tests` — the node's `parse_body`, its binding and public inputs,
`listing_fields`, and its persistent pool store for the state-root section.

## 4. Measurements

**Host: this production validator — 2 virtual cores (AMD EPYC 7543P), shared with a running node,
load average 1.1–1.3 during the runs. A loaded 2-core machine; no quiet-host figure exists.**
Native, `--release` (the workspace's release profile: `opt-level` 3, no LTO), single-threaded (the
proof library's parallel feature is off), run at `nice 19` / `CPUWeight=10` inside a 2,500 MB
memory scope. Measured with `tests/prover.rs::measure_proving_time` of `core/shield-v2`
(`--ignored`), a two-input transfer, timing the whole of `prove_spend` — statement check, seed,
trace, proof and self-verification:

| Quantity | Figure |
|---|---|
| One proof in a fresh process, wall time | 3.10 s (user CPU 2.84 s) |
| Seven proofs in one process | 2.75 – 3.08 s, median 2.85 s |
| Five proofs in one process, not niced | 2.85 – 3.15 s, median 2.97 s |
| **Peak resident memory, one proof (`/usr/bin/time -v`)** | **388,472 KiB ≈ 379 MiB** |
| Peak resident memory, seven proofs in one process | 388,980 KiB — it does not grow from proof to proof |
| Proof size in these runs | 181,579 – 189,419 bytes (cap 200,000) |
| `verify_spend` of the fresh proof | 5.5 – 8.0 ms |

These are loaded-host figures and should not be quoted as the prover's speed. The research
measurements (3 to 7 seconds, spec O-8) were of the same order. Nothing was measured in
WebAssembly, in a browser or on a phone for this package. For orientation only, the research
crate (`research/shield3/RESULTS.md`, same circuit and parameters, its own module, under Node
22 on this host) measured 6.7 s per proof in WebAssembly — a little over twice native — and
397 MB of linear memory after proving; a WebAssembly instance never gives that memory back, which
matters on low-end phones and is one more reason to prove in a worker that is then terminated.

## 5. The WebAssembly package (`core/shield-v2-wasm`)

* Exports: `constants`, `shielded_address`, `parse_address`, `export_scan_key`, `new_state`,
  `scan`, `summary`, `plan_payment`, `plan_self_merge`, `build_shield`, `attach_signature`,
  `build_transfer`, `build_unshield`, `mark_pending`. Each returns `Result<string, Error>`: JSON
  text, or an error whose message starts with a code (`entropy:`, `fee_below_minimum:`,
  `anchor_mismatch:`, …). The JSON shapes are declared for TypeScript in a custom section.
* Stateless: the 64-byte seed is an argument of the calls that spend and is wiped from the
  module's copy before returning; the state is a JSON value the caller persists.
* `tests/api.rs` runs the same functions natively: the happy path with real proofs, and several
  hundred malformed calls that must all come back as coded errors.
* `build.sh` builds the `.wasm` and, if `wasm-bindgen-cli` of the pinned version is installed,
  the JavaScript and TypeScript bindings into `pkg/` (ignored by git).

**Build result on this host** (`wasm32-unknown-unknown`, rustc 1.94, `-j 1`):

| Build | Result | `.wasm` size |
|---|---|---|
| `cargo build --release --locked --target wasm32-unknown-unknown -p quantum-vault-shield-v2-wasm` (the workspace's release profile) | succeeds, no warnings | 2,220,849 bytes |
| `WASM_ONLY=1 ./build.sh` (the same with fat LTO and one codegen unit, set by environment for this build only) | succeeds | 1,972,513 bytes (572,742 bytes gzip -9) |

Both are the raw compiler output: 14 exported functions, and 30 imports that are wasm-bindgen
placeholders (among them `crypto.getRandomValues`). **The JavaScript and TypeScript bindings
were not generated**: `wasm-bindgen-cli` (it must be exactly the version of the `wasm-bindgen`
crate in `Cargo.lock`, 0.2.128) and `wasm-pack` are not installed here, and installing a tool was
outside what this work was allowed to do. `build.sh` stops with the install command when the
tool is missing. `wasm-opt` is not installed either; the sizes above are without it. Nothing was
instantiated or run as WebAssembly.

## 6. Open for the UI layers

Nothing below was built.

**All three clients (site, extension, Qwalla)**

1. **Submission.** The node has no V2-specific submission route: `/api/shield-v2/stats` and
   `/notes` are read-only, and a V2 transaction enters through the node's generic transaction
   paths (`insert_tx_to_mempool` runs the V2 admission checks). Which public route carries the
   envelope (`envelope_json` is a complete `TxV1`), with what rate limit and error contract —
   in particular for the two signer-less types, which no account pays for — is node and proxy
   work that this crate does not decide. The interop test imports blocks directly.
2. **Proving blocks for seconds.** It must run off the UI thread (a Web Worker; a native
   background thread), with a progress state and a cancel that terminates the worker.
3. **Storing the state.** `WalletState` holds note values and `r`. It must be encrypted at rest
   with the wallet's existing vault key, never synced in clear, and versioned (`version: 1`).
4. **Sync.** Page through `/api/shield-v2/notes` from `next_height`, apply each page with `scan`,
   then compare `anchor` with the node's `latest_anchor`; on a mismatch or a `listing:` error,
   rebuild from an empty state. Decide what "confirmed" means against the chain's finality.
   A listing from a hostile node can hide notes but cannot forge them (every note is
   authenticated against its commitment) — a wallet that cares queries two nodes.
5. **Privacy of the scan.** The wallet downloads everything and never asks for one position.
   The node still learns the wallet's IP address and sync cadence.
6. **Anchor and expiry policy.** Use `latest_anchor`; pick `expiry_height` no later than the
   anchor's last valid height (anchor height + 128) and short enough that a dropped transaction
   releases its notes soon. The builder does not enforce it.
7. **Pending transactions.** Mark inputs pending on submit, release on expiry or rejection, and
   store `BuiltTx.outputs` as the outgoing record — the chain will not give it back.
8. **Fees.** `SHIELD_V2_MIN_FEE_QUANTA` (1 XRGE) is the floor; a self-merge costs one fee.
   Show the fee of every merge a payment needs before starting.
9. **Address handling.** 1,960 characters: QR code and copy-paste only; show the fingerprint.
   A QR code of that size needs a high version or a split/animated code — to be designed.
10. **Wording.** Spec §6: no client may describe the pool's privacy as audited, proven or
    guaranteed.
11. **The shield's account signature.** The client signs `signing_bytes` with ML-DSA-65 as it
    signs any transaction, then `attach_signature`. The nonce must be the account's next nonce.
12. **Wallets created from a raw key** have no shielded address (O-9, undecided).

**Site (`apps/web`, `apps/site-next`) and extension**

* Load the wasm-bindgen `web` target in a dedicated worker. The extension's service worker can
  instantiate WebAssembly but is killed after idle time; prove in an offscreen document or a
  page-owned worker, and add `wasm-unsafe-eval` to the extension's content security policy.
* The memory a proof needs (see §4) is per instance; one proof at a time.

**Qwalla (React Native / Hermes)**

Hermes has no built-in `WebAssembly`. The options, none built or measured here:

| Option | What it takes | Trade-off |
|---|---|---|
| A. Native module | Compile `quantum-vault-shield-v2-wallet` for `aarch64-apple-ios` / `aarch64-linux-android` as a static/shared library behind a thin C ABI (or UniFFI) and expose it through a JSI / TurboModule | Fastest, real threads, real operating-system entropy, can wipe memory. Needs a native build pipeline and an EAS **build**, not an over-the-air update. The recommended path |
| B. Hidden WebView | Run the wasm package inside a `react-native-webview` and message it | No native code and ships over the air, but the seed crosses a string bridge into a web context, memory is constrained by the WebView, and backgrounding kills it. Acceptable for scanning with a viewing key, poor for proving |
| C. A WebAssembly runtime for React Native (a JSI-backed interpreter or `wasm2c`-style ahead-of-time translation) | Add the runtime as a native dependency | Still a native build; interpreters are an order of magnitude slower — a proof would take minutes |
| D. Remote proving | Send the witness to a server | Not an option: the witness contains the spending key and the whole point of the pool |

Whatever the option, Qwalla's entropy must be the platform generator (`SecRandomCopyBytes`,
`getrandom(2)`), which option A gets for free through `getrandom`.

## 7. Not done

* No review by a second person (O-14 asks for one).
* No cross-check against `@noble/post-quantum`.
* `wasm-bindgen-cli` and `wasm-pack` are not installed on this host, so the JavaScript bindings
  were not generated and nothing was run in a browser or in Node; the `.wasm` was built and its
  surface was tested natively.
* No measurement of proving inside WebAssembly, on a phone, or on a quiet host.
* No reorganisation handling beyond "refuse and rescan".
* No `signed_payload` signing format for shields, no outgoing-history store, no QR encoding.
* No change to `core/wasm-prover` (V1) or to any client package.
