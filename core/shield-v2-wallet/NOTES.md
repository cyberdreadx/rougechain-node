# Shielded pool V2 — wallet core: implementation notes

Specification: `docs/SHIELDED_POOL_V2_SPEC.md` (SPEC v1, amended 2026-10-06, W-1 … W-19). Branch
`feat/shield-v2-wallet-core`, from `main` @4aeb25b (which contains the node side); the settlement
redesign after the second review is on `fix/shield-v2-wallet-settlement` (§11), what the third
review asked for is on `fix/shield-v2-wallet-settlement-2` (§12), and what the fourth asked for
is on `fix/shield-v2-wallet-settlement-3` (§13).

Three pieces:

| Piece | Where | What |
|---|---|---|
| the wallet prover | `core/shield-v2`, cargo feature `prover` | `prove_spend(witness, public)` — no seed parameter |
| the wallet logic | `core/shield-v2-wallet` (this crate) | keys, address, note encryption, the three builders, scanning, the note tree, coin selection |
| the WebAssembly package | `core/shield-v2-wasm` | a wasm-bindgen surface over this crate |

Nothing here is active on any network, nothing here makes a network call, and nothing here has a
user interface.

**Review status.** The code as of `abab9a8` was reviewed by a second reader
(`REVIEW_WALLET_1.md`: no Critical or High finding; two Medium, five Low, ten Info; the prover's
randomness — the review spec O-14 asks for — found sound as built). Every finding has been
answered since (the "Resolution" section of that file maps each to its commit; §8 below describes
what changed). **The fixes themselves have not been reviewed by a second person**, and they are
not small: a new state format, a new address format, a new randomness construction for the
builders. They need the same second reading before a UI is built on them.

That second reading happened (`REVIEW_WALLET_2.md`, of `60d1e2b`): **two High findings, both in
the fix of F-7**, both ending in the double payment that fix was written to prevent, plus one
Medium and five Low. The settlement of pending transactions was redesigned in answer, not
patched: state format 3, `confirm_state`, `resolve()` without a policy. §11 describes it and
supersedes what §6 items 3, 4 and 7 and §8 said about the state, the root check and pending
transactions; those items are rewritten below.

The redesign was read by a third reviewer (`REVIEW_WALLET_3.md`, of `188d0ed`): **safety holds —
no double payment, no over-stated confirmed balance — and availability did not**: one lying node
of three could freeze every confirmation, and one lying page could make a lock permanent (two
High), plus three Medium. §12 describes what was changed in answer: the quorum is a strict
majority of the nodes the wallet is CONFIGURED with, the expiry is measured from the confirmed
height, building and locking are one call, the ciphertexts are in the confirmed state. It
supersedes what §5, §6 items 3, 4, 6 and 7 and §11 said about `confirm_state`, `mark_pending`
and the builders; those items are rewritten below.

They were read by a fourth reviewer (`REVIEW_WALLET_4.md`, of `e229cde`): **the redesign is sound
in its main lines; three corner cases left a state behind that was not** — a state no call could
read again (High), a payment lost to a crafted address and an embargo after a restore that ended
too early (Medium) — and the property test failed outside its sixty seeds. §13 describes what
was changed in answer (state format 5, the restore embargo in the core, `recover_locks`, the
revision identity, the node-set rule) and **§6 now ends with the client loop as a normative
algorithm**. It supersedes what §6 items 3, 4 and 7 said about the revision, the node ids and
the restored device; those items are rewritten below. **These changes have not been reviewed by
a second person.**

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
   Since REVIEW_WALLET_1 (I-1, I-2): the witness is private to the builder module and dropped —
   wiped — the moment the prover returns (a `BuiltTx` has no witness field); the inputs are
   assembled without an intermediate heap buffer; `prove_trace_seeded` takes the seed by
   reference and holds no copy of its own; `ScanKey` wipes `nk` on drop (it already wiped `dk`);
   the wasm surface wipes the decoded and the hexadecimal viewing key it parsed; `SpendInput`
   wipes its note secrets on drop. **Still not wiped, and not wipeable from here:** the by-value
   seed inside `production_config` / `rngs` (`verifier.rs`, code the node's verifier shares and
   this work does not touch — the verifier passes a constant there) and the third generator
   `rngs` forks from; the stack copies Rust makes when it moves a witness; the JSON strings that
   cross the wasm boundary (`export_scan_key` returns `dk` and `nk` in an ordinary string — it
   has to). `SpendWitness` is still `Clone` (the node-side crate's tests rely on it).
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
   **Compile-time guard (since REVIEW_WALLET_1).** `quantum_vault_shield_v2::PROVER_COMPILED` is
   `cfg!(feature = "prover")`, and `daemon/src/shield_v2.rs` holds
   `#[cfg(not(test))] const _: () = assert!(!PROVER_COMPILED, …)`. A build that unifies the
   feature into the daemon — `cargo build --workspace`, `cargo check --workspace`, or `-p
   quantum-vault-daemon -p quantum-vault-shield-v2-wallet` together — now **fails to compile**
   instead of producing a node with a prover in it (checked: see §8). The daemon's own tests are
   not affected: their dev-dependencies enable `test-prover`, but `cargo test -p
   quantum-vault-daemon` compiles the daemon with `cfg(test)` only, because the package has no
   integration test (`daemon/tests/` holds fixtures) that would make cargo also build the plain
   binary. Two consequences to know: an integration test added to the daemon later must be built
   in its own cargo invocation; and workspace-wide tooling (`cargo check --workspace`,
   an editor's default check) reports this assertion as an error — select packages instead.

## 2. Where the specification was ambiguous, and what was done

| # | Spec | Ambiguity or gap | What this crate does |
|---|---|---|---|
| 1 | §5.2 | "the 64-byte BIP-39 seed" — the crate needs the seed, the wallet has a phrase | The primary entry is `ShieldedKeys::from_seed(&[u8; 64])`. `bip39_seed(phrase, passphrase)` is a convenience: PBKDF2-HMAC-SHA512, 2,048 rounds, checked against the BIP-39 reference vectors. It does **not** validate the word list or checksum and does **not** implement NFKD, so it refuses non-ASCII input instead of deriving a wrong seed. Wallets already have a BIP-39 library (`@scure/bip39`); they should pass the seed |
| 2 | §5.2 | "no salt" (keys) vs "salt = 32 zero bytes" (§3.4) | The same HKDF input (RFC 5869). Matches the wallet's existing `hkdf(sha256, seed, undefined, info, L)` idiom in `packages/core`. Spec W-3 |
| 3 | §5.2 | `sk[i] = (LE u64 …) mod p` — reduction of a 64-bit word | Done literally with integer arithmetic, then converted; the vector test recomputes it independently |
| 4 | §5.2, O-9 | wallets without a recovery phrase | Not supported: there is no entry point that takes an account secret key. Such a wallet has no shielded address until the owner decides O-9 |
| 5 | §5.2 | "The decapsulation key is the viewing key", but §5.4's scan needs more | `ScanKey { dk, pk, nk: Option }`. `(dk, pk)` finds incoming notes and values; with `nk` it also sees spends; neither spends. `incoming_viewing_key()` is what an auditor gets. Spec W-5 |
| 6 | §5.3, O-11 | no textual address form | `rshield1…`: bech32m without the 1,023-character limit (written out in `bech32m.rs` because the `bech32` crate enforces the limit) of `version 0x02 ‖ pk ‖ ek ‖ check`, 1,974 characters. `check` = first 8 bytes of SHA-256(`"rouge-shield/v2/address-check/v1"` ‖ version ‖ `pk` ‖ `ek`), verified on decode in addition to the bech32m checksum (REVIEW_WALLET_1 F-2: at this length the checksum alone accepts the same change made to two characters 1,023 apart). Decoding validates checksum, prefix, format (the first form — the bare 1,216 bytes — is refused by name), length, version, `check`, canonical `pk` and the ML-KEM key, each with its own error. Guarantee: every single changed character is caught by the checksum; any damage that passes the checksum is caught by `check` except with probability 2^-64. `ShieldedAddress::fingerprint()` (8 bytes of SHA-256 of `pk ‖ ek`) is still offered for out-of-band comparison — a UI must compare all 16 characters. Provisional; spec W-4, W-9 |
| 7 | §3.1 | which signing format a shield uses | `encode_tx_for_signing` (the chain's own function, used through `quantum-vault-types`, not re-implemented). The `signed_payload` format the spec also allows is not produced. Spec W-2 |
| 8 | §3.1 | "every other payload field MUST be absent" vs the chain's encoder | The chain's `TxPayload` encoder writes most absent fields as `null` and omits the newer ones; both decode to `None`, which is what the node checks. The envelope is produced by that encoder |
| 9 | §3.4 | ML-KEM `Encaps` randomness | 32 bytes per output — a labelled draw of the transaction's hedged generator (§9 below), the label carrying the output slot — passed to `fips203` through a one-shot generator that errors on a second read. The library's own `encaps_from_seed` is not used because it contains an `expect`. Spec W-12 |
| 10 | §3.4 | the "freshly generated key that it discards" of a zero-value output | `KeyGen_internal(d, z)` with fresh `d`, `z`; the decapsulation key is dropped (zeroized by the library) before encapsulating |
| 11 | §3.5, §3.6 | a shield with `fee = v_in` is valid on the node | Refused by the builder (it shields nothing). Also refused: a zero transfer amount, a zero `v_out`, a deposit above the pool cap. Spec W-6 |
| 12 | §5.5 | "SHOULD place the payment and the change in a random order" | One random bit per transaction orders the two output slots, for all three types. `BuiltTx::outputs` records which slot is which for the sender; a receiver tries both |
| 13 | §5.5 | input slot order | Not randomised (real notes in the order given, a dummy second). The proof hides which slot is real |
| 14 | §5.5 | anchor and expiry | The caller passes the anchor **and the height it belongs to** (`TxContext::anchor_height`: the wallet's scanned height; the node's tip for a shield). The builder checks that every real input's path leads to the anchor (`AnchorMismatch` otherwise) and that `anchor_height < expiry_height ≤ anchor_height + 128` (`MAX_EXPIRY_OFFSET`; the number is the anchor window's size, but the window itself does not bound a transaction's life — in an idle pool a root stays an accepted anchor indefinitely — so this bound on `expiry_height` is the ONLY one; REVIEW_WALLET_2 I-1). `TxContext::new` sets the default, **anchor height + 64** (`DEFAULT_EXPIRY_OFFSET`). The builder has no chain view, so a caller can lie about `anchor_height`; `WalletState::mark_pending` therefore checks the bound again against the state's own scanned height. Before the first block from activation the node's stats report `pool: null`; the anchor is then the empty-tree root (`WalletState::new(..).anchor()`). Spec W-11 |
| 15 | §5.4 | "kept current as leaves are appended" | `TreeTracker`: frontier + ONE map of the tree nodes on the tracked notes' paths (paths share their upper nodes: two to three nodes per note instead of 32; §11); 32 hashes and 32 map lookups per appended leaf, whatever the number of tracked notes. Checked against the reference sparse tree, the stage-1 `Pool` and a real node (root and frontier) |
| 16 | §5.4 | "MUST follow reorganisations" | The tracker cannot undo an append. `scan` requires each page to continue the state exactly (`from_height`, and the leaf position of every output) and refuses otherwise, leaving the state untouched (the page is validated and trial-decrypted completely before the state is changed, in place — no copy of the state per page); recovery is a rescan from `WalletState::fresh_for_rescan()`, which keeps the pending transactions — every one as pending and locked (§11). A reorganisation that replaces already-scanned blocks is noticed at the next mismatching leaf or by `confirm_state` (`diverged`: the root or the nullifier hash no longer matches). A settlement assumes that blocks at or below the CONFIRMED height are not replaced afterwards; the chain has no reorganisation handling in the node today. Spec W-5, W-10 |
| 17 | §5.4 | zero-value notes addressed to the wallet (its own zero change) | **Not stored** (REVIEW_WALLET_1 I-7): the leaf is appended to the tree, no note and no path are kept. Anybody can send them; there is nothing to spend. A note below the state's minimum note value (default: the minimum fee) is counted and not stored either; spent notes are pruned (§11, REVIEW_WALLET_2 RW2-7) |
| 18 | §5.4 | "its own record of what it sent" | Not persisted by this crate. `BuiltTx::outputs` (slot, role, value, `r`, `cm`) is what a UI stores; a restore does not recover it (O-10) |
| 19 | §5.4 | notes of a transaction that is submitted but not yet mined | In the state (REVIEW_WALLET_1 F-7): `BuiltTx::pending()` → `WalletState::mark_pending` records the two nullifiers, the input positions, the expected change and `expiry_height`, and locks the inputs; `scan` marks the entry mined when a nullifier appears; `resolve` releases the inputs when the scan has passed the expiry height without them. See §6 item 7 and §8. Spec W-11 |
| 20 | §2.11 | the entry-point table named `prove_spend(trace, public, seed)` | Replaced by the implemented signature. Spec W-1 |
| 21 | task | "`getrandom`; on wasm32 the `js` backend" with two `getrandom` majors in the lock file | `getrandom` 0.2 with `js` on `wasm32-unknown-unknown` (target-specific dependency in both crates). The 0.4 in the lock file belongs to other crates and is not used here |
| 22 | task | "same idiom as `core/wasm-prover`" | `core/wasm-prover` (V1) is a raw `extern "C"` module with a host-supplied random function, not wasm-bindgen. The new package uses wasm-bindgen as the task says; the V1 idiom was not copied because a host-supplied generator is exactly the kind of caller-controlled entropy §5.6 rules out |

**ML-KEM implementation.** `fips203` 0.4.3 (pure Rust, `no_std`, constant-time by `subtle`,
zeroizing). `core/crypto` contains no ML-KEM — it has `fips204` for ML-DSA-65 — so the sibling
crate by the same authors was taken; `core/crypto` itself is not a dependency (it pulls in the V1
STARK library). It exposes `KeyGen_internal(d, z)` as `keygen_from_seed`, which §5.2 needs. The
TypeScript side uses `@noble/post-quantum`; both implement final FIPS 203. Cross-checked against
`@noble/post-quantum` 0.5.4 by the review (`tests/noble_crosscheck.mjs`, 53 of 53 checks, run
again after the fixes); `keys.json` and `note_encryption.json` exist so that the TypeScript side
can check itself.

## 3. Test vectors (spec §8.4, O-15)

`core/shield-v2/vectors/wallet/{keys,note_encryption,transactions,state_root}.json`, generated by
`tests/vectors.rs` (`SHIELD_V2_WRITE_VECTORS=1` writes; otherwise the test regenerates and
compares). Determinism comes from the `test-vectors` feature only: a labelled SHA-256 stream in
place of the operating system's generator for dummy secrets, `r`, zero-output keys, encapsulation
randomness and slot order. The feature is off by default, is enabled only as a dev-dependency
feature, and does not reach the prover — the vectors contain no proof. The deterministic source
replaces the whole hedged generator (the draws are taken from the stream in the order they are
asked for, labels ignored), so the fix of F-5 changed no vector: `transactions.json`,
`note_encryption.json` and `state_root.json` are byte-for-byte what they were. `keys.json` was
regenerated for the new address form (new fields `address_version`, `address_check_tag`,
`address_check`, `address_payload_sha256`; a new `address` string; the key material and
`address_bytes_sha256` / `address_fingerprint` are unchanged).

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

* Exports (21): `constants`, `shielded_address`, `parse_address`, `export_scan_key`,
  `new_state`, `set_nodes`, `scan`, `scan_pages`, `summary`, `plan_payment`, `plan_self_merge`,
  `build_shield`, `attach_signature`, `build_transfer`, `build_unshield`, `abandon_unsubmitted`,
  `pending`, `note_rejection`, `resolve_pending`, `confirm_state`, `rescan_state`. The ten that
  change a state — `set_nodes`, `scan`, `scan_pages`, `build_transfer`, `build_unshield`,
  `abandon_unsubmitted`, `note_rejection`, `resolve_pending`, `confirm_state`, `rescan_state` —
  take `expected_revision` and return `{ state, revision, … }` (§6 item 3, §11, §12).
  **`mark_pending` and `confirm_roots` are gone** (§12): `build_transfer` / `build_unshield`
  return the transaction together with the state in which it is locked, and `confirm_state`
  takes no quorum. Each returns
  `Result<string, Error>`: JSON text, or an error whose message starts with a code (`entropy:`,
  `fee_below_minimum:`, `fee_above_maximum:`, `anchor_mismatch:`, `note_locked:`,
  `note_unverified:`, `state_unconfirmed:`, `stale_state:`, `rescan_required:`, …). The JSON
  shapes are declared for TypeScript in a custom section.
* **No error message quotes an argument** (REVIEW_WALLET_1 F-6): a message is a code, a fixed
  sentence and, for JSON that does not parse, the parser's category with line and column — never
  `serde_json`'s own text, which quotes the offending value (a twice-encoded scan key used to
  come back inside the error). The only variable parts are numbers the chain or the wallet
  computed. `tests/review_wallet_1.rs` plants a marker in every argument of every export, in a
  few thousand shapes, and checks that no error contains any part of it.
* `scan` / `summary` report `confirmed_balance`, `unverified_balance`, `locked_balance` and
  `spendable_balance` — there is no single "balance" a UI could show by mistake.
* Cost per page (I-7): the state is a JSON argument, so every call parses it and every call that
  changes it writes it back — inherent to a stateless surface. What was avoidable is gone: the
  result is spliced together with the state serialised once (it used to be serialised, parsed and
  serialised again), the core no longer copies the state per page, and `scan_pages` applies a
  JSON array of pages in one call. A client that syncs thousands of pages should use `scan_pages`
  or the native crate.
* Stateless: the 64-byte seed is an argument of the calls that spend and is wiped from the
  module's copy before returning; the state is a JSON value the caller persists.
* `tests/api.rs` runs the same functions natively: the happy path with real proofs, and several
  hundred malformed calls that must all come back as coded errors.
* `build.sh` builds the `.wasm` and, if `wasm-bindgen-cli` of the pinned version is installed,
  the JavaScript and TypeScript bindings into `pkg/` (ignored by git).

**Build result on this host** (`wasm32-unknown-unknown`, rustc 1.94, `-j 1`):

| Build | Result | `.wasm` size |
|---|---|---|
| `cargo build --release --locked --target wasm32-unknown-unknown -p quantum-vault-shield-v2-wasm` (the workspace's release profile) | succeeds, no warnings | 2,620,985 bytes after the changes of §12 (2,432,370 after the fixes of REVIEW_WALLET_1; 2,220,849 before) |
| `WASM_ONLY=1 ./build.sh` (the same with fat LTO and one codegen unit, set by environment for this build only) | succeeded on `abab9a8`; not re-run after the fixes | 1,972,513 bytes then (572,742 bytes gzip -9) |

Both are the raw compiler output: 20 exported functions (14 before the fixes), and imports that
are wasm-bindgen placeholders (among them `crypto.getRandomValues`). **The JavaScript and TypeScript bindings
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
   with the wallet's existing vault key — and authenticated: a tampered blob can show a wrong
   balance — never synced in clear. It is versioned (`version: 5`; version 4 is migrated in
   place; versions 1, 2 and 3 are read and migrated to an empty state that keeps the locks and
   has NO configured node: call `set_nodes`, then rescan — §11, §12, §13). **Store the state as
   the opaque text the core returned**: the core has read that text back before returning it
   (`state_invariant:` otherwise — §13), so it is never a state the next call refuses. **If the
   STORED text is ever refused (`state:`), call `recover_locks` — never `new_state`**: a new
   state has no locks (§13). **The one rule for a payment: persist the state that
   `build_transfer` / `build_unshield` returned, then submit** (item 7). A wallet that loses the
   pending record has lost the lock.
   **One writer at a time, enforced by the revision's IDENTITY** (§11, §13 RW4-10): every result
   carries `revision` (a counter, the `expected_revision` of the next call) and **`revision_id`**
   (a hash over the previous identity, the counter and the change). Two tabs that start from one
   revision both reach "counter + 1" — with two different identities. Keep the `revision_id`
   next to the stored state and store a result only if the stored identity is still the one the
   tab LOADED (compare-and-swap in one storage transaction, or a Web Lock around
   read–call–write); a state that could not be written is discarded, never worked on. A
   `stale_state:` error means another tab or worker wrote in between: reload and repeat. Two DEVICES on one phrase share no storage and cannot share
   locks — see item 7, "Locks are per device".
4. **Sync and what a balance means.**
   **Configure the nodes first** (`set_nodes`, §12): the list of endpoints the user or the
   application chose, as **https** origins (`https://node-a.example`, `https://node-b.example:8443`)
   — **one per host, an odd number of at least three, run by different operators** (§13 RW4-2,
   RW4-7: `http` is accepted for loopback hosts only, a loopback node is never in a set with
   other nodes, two ids with one host are refused, an IP literal has one spelling).
   The core canonicalises them (lower case, default port and path removed) and collapses
   duplicates; an id that is not an origin is refused. **The quorum is a strict majority of THIS
   set, at least 2** — it lives in the state, and nothing a call is handed can lower it. Changing
   the set is `set_nodes` again: it un-confirms nothing and applies from then on. **With one
   node, or none, nothing is ever confirmed**: such a wallet shows every note as unverified and
   cannot build a transfer or an unshield. (Two names of one operator are two nodes to the
   wallet: list operators, not aliases.)
   Then page through `/api/shield-v2/notes` of ONE of them from `next_height`, apply each page
   with `scan`, and after scanning ask **every configured node** for `/api/shield-v2/stats` and
   pass each **`report` object** (`height`, `tree_root`, `nullifier_acc`, `note_count`,
   `nullifier_count`, `ciphertext_acc` — the node's record of its last accepted block) plus
   `node_id` = the endpoint as you configured it to `confirm_state`. The highest height at which
   a strict majority of the configured nodes reported exactly the wallet's five values becomes
   the confirmed height; notes at or below it are `confirmed`.
   **A listing from one node cannot be authenticated.** A note is checked against the commitment
   and the nullifiers of the same listing, and nothing ties one node's listing to the chain —
   the chain has no light-client proofs yet. A node that knows the wallet's address can list a
   payment that is on no chain; it can list one of your transactions as mined while it holds it
   back; it can swap the nullifiers of a transaction so that a spend is hidden; it can blank or
   swap ciphertexts so that a note is hidden (REVIEW_WALLET_1 F-1, REVIEW_WALLET_2 RW2-1, RW2-2,
   REVIEW_WALLET_3 RW3-2). The core rebuilds all three hashes of the listing — the commitment
   tree, the pool's running nullifier hash and the running ciphertext hash — and none of those
   lies can be confirmed.
   **What `confirm_state` returns, and what the client does with it** — these four rules are the
   whole of the client's part in "a lying minority causes delay only":
   * `report.dissenting` — `[{ node_id, height }]`: configured nodes whose report is not the
     wallet's state. **They do not block** (a majority that agrees contains an honest node). Show
     it: "node X disagrees".
   * `report.listing_refuted` — more nodes contradict the wallet than a lying minority can be:
     **your listing is not the chain**. `rescan_state`, then scan from ANOTHER configured node.
     The same on a `listing:` error from `scan`.
   * `report.listing_ahead` (with `report.quorum_tip`, the height a quorum has reached) — your
     listing shows pool transactions in blocks above what a quorum has. One block of lead is an
     honest race: ask the nodes again. If it stays so, the listing node invented those blocks
     (a spend of one of your notes that never happened would otherwise keep that note out of
     every balance until the chain got there): the same recovery.
   * the confirmed height stays below `report.quorum_tip` after a full sync — your listing node
     is slow or withholding: list from another configured node (no rescan needed).
   Nodes are not always at one height, and only reports for the SAME height can form a quorum:
   query the nodes together, keep the reports of the last rounds, and ask again when no height
   has a majority. A malformed report is skipped and counted in `malformed`: it costs that
   node's vote, not the call. **A report that lacks only `ciphertext_acc` is an OUTDATED NODE**
   — a build before the node-local ciphertext hash, or one that has not been restarted since —
   and is returned by id in `outdated_nodes`: say "node X must be updated", not "node X
   disagrees" (§13 RW4-12).
   A page whose `report.leaf_mismatch` is true (the page numbers its outputs below where the
   wallet's tree stands: the listing the state was built on held more than this node has) is a
   fifth signal with the recovery of the second: `rescan_state`, another node.
   **How these rules are combined — how often "ask again" is, in which order nodes are tried —
   is the client loop at the end of this section, which is normative.**
   `summary` reports the confirmed and the unverified balance separately; `plan_payment` uses
   unverified notes only with `allow_unverified = true`, and `build_transfer` /
   `build_unshield` refuse an unverified input (`note_unverified:`) unless their parameters say
   `allow_unverified: true` too.
   What the UI must do (spec §5.4, normative): **never present an incoming shielded payment as
   final on one node's word** — show it as unconfirmed until its height is confirmed; a
   merchant-facing integration is configured with nodes it has reason to trust, its own among
   them.
   What a confirmed balance is: exact **as of the confirmed height**. Show that height. A spend
   above it that your listing node hides is unknown to the wallet — and cannot be confirmed.
   What this is, honestly: the word of a majority of the nodes you configured instead of one —
   the same trust a wallet places in a node for ordinary account balances today, not a proof. A
   majority of the configured nodes, lying together, is believed; two endpoints of one operator
   are two nodes to the wallet. Header-committed proofs of the pool state come with the
   consensus / light-client work.
   **Dust and the cap.** Incoming notes from others below the state's `min_note_value` (default:
   the minimum fee, 1 XRGE; set in `new_state`, changed only by `rescan_state`) are counted in
   `summary.below_minimum` and not stored: they are in no balance. Tell the user. **The wallet's
   own outputs are always stored**, whatever their size (§12). `plan_payment` avoids a change
   below the minimum where it can and returns `change_below_min_note_value` where it cannot.
   `over_capacity` counts notes that arrived while the state held its cap of UNSPENT notes
   (`max_unspent_notes`, default 65,536; spent notes do not count): `rescan_state` with a higher
   cap recovers them.
5. **Privacy of the scan.** The wallet downloads everything and never asks for one position.
   The node still learns the wallet's IP address and sync cadence — and more; see §10.
6. **Anchor and expiry policy.** For a shield: `pool.latest_anchor` and the node's tip as
   `anchor_height`; the expiry defaults to that + 64 and is at most + 128. **For a transfer or an
   unshield the client passes NO height** (§12): the anchor is the state's confirmed tree root
   and the expiry is the state's confirmed height + 64 (at most + 128 if `expiry_height` is
   given). A state without a confirmed height, or whose tree root is above it, is refused
   (`state_unconfirmed:`): scan to the tip and `confirm_state` first.
7. **Pending transactions.** **`build_transfer` / `build_unshield` build AND lock**: the result
   is `{ state, revision, envelope_json, … }`, and in that state the inputs are locked and the
   pending entry (both nullifiers, both output commitments, the inputs, the change with its `r`,
   the expiry) is recorded.

   > **Persist the returned state, then submit `envelope_json`.**

   If the state could not be persisted (a crash, a failed write, `stale_state:` from your
   storage's compare-and-swap), do NOT submit: load the stored state and build again. There is no
   call that returns a submittable transfer or unshield without that state, and no `mark_pending`
   to forget. If the user cancels before the submit and you are CERTAIN nothing was sent, you may
   call `abandon_unsubmitted` — it sets a flag for the UI and **releases nothing**: the inputs
   stay locked until the expiry is confirmed, exactly as if the transaction had been sent
   (the core cannot check the claim, and a wrong one would be a double payment).
   A lock ends in exactly one way: `resolve_pending` settles the entry **at the confirmed
   height** (item 4) and returns it under one of three names —

   | Returned under | Means | Show the user |
   |---|---|---|
   | `mined` | a confirmed transaction has both its nullifiers and both its outputs | "paid"; the change is in the confirmed balance |
   | `superseded` | another confirmed transaction spent one of its inputs (the same phrase on another device, usually): it can never be mined | "**not** paid — one of its notes was spent elsewhere"; the other input is free again |
   | `expired` | the confirmed height is at or above its expiry and none of its nullifiers appeared | "not paid — expired"; the inputs are free; a retry is safe |

   Everything else is still pending, and still locked: what `scan` reports (`pending_seen_mined`,
   `pending_seen_superseded` — one node's listing), a "rejected" answer (`note_rejection`: a flag
   for the UI, "the node refused it; it is still pending until block N"), your own
   `abandon_unsubmitted`, a scanned height one node claims.
   **How long:** the expiry is at most 128 blocks (by default 64) above the confirmed height at
   the build, and a confirmed height is one the chain has reached. So an entry is settled by the
   time the confirmed height reaches its expiry, whatever a lying minority served — it can delay
   the confirmation by the time it takes you to follow the four rules of item 4, and nothing
   else. A wallet that cannot reach a majority of its configured nodes keeps its locks: that is
   the price of not paying twice.
   **Offer "try again" only for `superseded` and `expired`.** A signer-less transaction that has
   left the wallet stays valid until its expiry, and a node that answers "rejected", or lists it
   and withholds it, can have it mined after the wallet has paid again from other notes
   (REVIEW_WALLET_1 F-7, REVIEW_WALLET_2 RW2-1). A payment made meanwhile from other notes is a
   second payment; the core cannot stop the user from making one, only refuse to call the first
   one dead.
   **Locks are per device** (RW3-10, spec §5.5). They are in the wallet state; a second device on
   the same phrase, or this device after a restore from the phrase, has none. Same notes chosen ⇒
   one of the two transactions is `superseded`, nothing lost. OTHER notes chosen for "the same"
   payment while the first is withheld ⇒ both are mined, and no core can prevent it between two
   LIVE devices. **For a state made from the phrase the core now enforces an embargo** (§13
   RW4-1): `build_*` refuses with `restored_recently:` until the confirmed height is 128 blocks
   above the state's embargo base, and `summary.spend` / `confirm_state.spend` say so
   (`reason: "embargo"`, `embargo_until`, `embargo_blocks_left`). **The UI must**: (a) say, after
   a restore and on first use of a phrase on a new device, that payments made from another copy
   of the wallet may still be in flight and are not shown here, and show the embargo in BLOCKS;
   (b) offer the override (`assert_sole_copy`) only as the user's explicit statement that no
   other copy has a payment in flight — true for a new wallet, rarely for a restore; (c) never
   offer "pay again" for a payment whose state this device does not hold.
   The expected change is not money until then: `expected_change` is reported for display and is
   in none of the balances.
   A shield to SOMEBODY ELSE is not recorded: it spends no note (it is an account transaction
   with a nonce). Store `BuiltTx.outputs` as the outgoing record — the chain will not give it
   back — and treat it as secret: `value` and `r` open the note (I-3). **A shield to the
   wallet's OWN address is built with `build_own_shield`, which records the note in the state**
   (§13 RW4-11): it is then stored whatever its value. `build_shield` refuses a note below the
   minimum note value (`note_below_minimum:`) unless `allow_below_min_note_value`.
   **Every bound is a number of BLOCKS** (§13 RW4-8): this chain makes a block when a
   transaction is pending, not on a clock. Show "expires in N blocks", never minutes; keep the
   envelope with the state so that a lost submit is answered by re-submitting the same envelope,
   not by waiting for the expiry.
8. **Fees.** `SHIELD_V2_MIN_FEE_QUANTA` (1 XRGE) is the floor; a self-merge costs one fee.
   Show the fee of every merge a payment needs before starting. The builders refuse a fee above
   `max_fee`; without one the ceiling is `DEFAULT_MAX_FEE_QUANTA` = 10 × the minimum = 10 XRGE
   (I-4: the fee is whatever the inputs exceed the outputs by, so a unit mistake used to be able
   to burn a whole note).
9. **Address handling.** 1,974 characters: QR code and copy-paste only; show the whole
   fingerprint (16 hexadecimal characters; comparing four of them is worthless). A QR code of
   that size needs a high version or a split/animated code — to be designed. Addresses of the
   first format (1,960 characters) are refused with their own error; none was ever given out.
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

### The client loop (normative)

REVIEW_WALLET_4 §2.8 found that the items above give rules and leave the algorithm open. This is
the algorithm. It is what the core was checked against, and **what the property test's client
executes, step for step** (`tests/settlement_properties.rs`, `World::round`). The names are the
WebAssembly surface's; "persist" always means: store the returned state under its `revision_id`
if the stored `revision_id` is still the one this tab loaded (compare-and-swap), and otherwise
discard the result.

```
S     the stored state, with the revision_id it was stored under
N     the configured nodes            L     the node listed from
bad   nodes whose listing was refuted or contradicted in this session (memory only)
R     the reports of the last three rounds (one per node and height, at most 1,024)
ahead, behind   counters (memory only)

round():
  1. page from L at S.next_height → scan with the FULL scan key → persist; repeat until
     report.at_tip or a page budget.
       a `listing:` error, report.leaf_mismatch, or `rescan_required:`   → RESCAN(L); end
  2. ask EVERY node of N for /api/shield-v2/stats at the same time; take `report`; drop one
     that is null or not a report; label each with the CONFIGURED origin — never with anything
     the node says about itself. A report without `ciphertext_acc` is handed in as it is: the
     core names that node in `outdated_nodes` (no vote; "node X must be updated").
     Add them to R; drop from R what is older than three rounds.
  3. confirm_state(S, R) → persist.
       report.listing_refuted            → RESCAN(L); end
       report.listing_ahead              → ahead += 1; if ahead ≥ 3 (three rounds in a row, each
                                           with fresh reports) → RESCAN(L); end either way
       otherwise                         → ahead := 0
       at_tip and (nothing confirmed, or confirmed_height < report.quorum_tip)
                                         → behind += 1; if behind ≥ 2 → L := next node not in
                                           bad (NO rescan), behind := 0
       otherwise                         → behind := 0
       no match and none of the above    → wait and repeat: NOTHING else
  4. resolve_pending → persist → tell the user: mined / superseded / expired.
  5. for every entry that is still pending and whose envelope is stored: if its submit failed
     or was not answered, submit THE SAME envelope again (to any node). Never build again for it.
     A payment is offered only if
       – this round's confirm_state matched, and confirmed_height = scanned_height;
       – `spend.can_spend_now` of that result (the core's answer: no embargo, not view-only,
         the root confirmed, a window left);
       – the payment is new, or step 4 reported its last attempt superseded or expired.
     build_*(S, revision) → persist { state, envelope } DURABLY, in one storage transaction,
     compare-and-swap on the revision_id that was LOADED → submit the envelope.
     Not written ⇒ discard the result and do not submit.

RESCAN(L):  bad += L;  S := rescan_state(S) → persist;  L := next node not in bad.
            Every node in bad → stop and tell the user: more than a minority of the configured
            nodes lies or cannot be reached. (A new session starts with bad empty.)

a `state:` error on the STORED state:
            recover_locks(text) → persist → set_nodes if nodes_kept is false → rounds.
            NEVER new_state: that state has no locks.

after new_state (a new wallet, a restore, a second device):
            nothing for the client to remember. The core refuses build_* (`restored_recently:`)
            until the embargo has ended; show `spend.reason = "embargo"`, `embargo_until`,
            `embargo_blocks_left` and "payments made from another copy of this wallet may still
            be in flight". Make the FIRST state check with every node answering (a node that is
            silent then costs 256 blocks). `assert_sole_copy` only on the user's explicit
            statement — a new wallet on a new phrase.
```

What the loop guarantees, given a strict majority of honest configured nodes: G2 and the
settlement rules always; G1 on one device with durable writes, and across a restore under the
assumption stated in §13 (RW4-1); G3 / G4 — with the honest majority reachable at the tip, the
loop ends with nothing pending and the tip confirmed within `4·nodes + 8` rounds (the property
test's bound; the most it measured is 6). Two deliberate differences from the loop as the review
wrote it: the listing node is changed when the confirmed height stays below the quorum's tip
after a full sync **whether or not this round matched** (a lying node that serves a true but
short listing never produces a match at its own height, and "wait" would then wait for ever);
and the embargo after `new_state` is the core's, not the client's.

A background worker that scans with the viewing key (`export_scan_key(seed, false)`) leaves a
state that is marked view-only: no balance of it is spendable and nothing is built from it until
step 1 has applied one page with the full key (§13 RW4-3).

## 7. Not done

* No second review of what §13 changed (the fourth review covered `e229cde`).
* No light-client verification of anything: `confirm_state` is the word of a majority of the
  configured nodes, not a proof (spec §5.4).
* **A wallet with fewer than two configured nodes is not a working wallet**: nothing is ever
  confirmed, so nothing is ever spendable by default and no transfer or unshield is built — by
  decision (REVIEW_WALLET_3), not by omission. There is no "I trust my own node, quorum 1" any
  more; an operator who wants that configures two endpoints and owns the consequence.
* The client loop of §6 item 4 (ask all nodes, rotate the listing node, rescan) is documented and
  modelled in `tests/settlement_properties.rs`; it is not code a client can call — no part of
  this crate makes a network request.
* `listing_ahead` is a signal, not a verdict: the core cannot tell an honest listing node that is
  one block ahead from one that invented a block. The client decides after asking again.
* `wasm-bindgen-cli` and `wasm-pack` are not installed on this host, so the JavaScript bindings
  were not generated and nothing was run in a browser or in Node; the `.wasm` was built and its
  surface was tested natively.
* No measurement of proving inside WebAssembly, on a phone, or on a quiet host.
* No reorganisation handling beyond "refuse and rescan" — but the rescan is now safe: every
  pending entry is carried over as pending and locked and settles again from confirmed data
  (REVIEW_WALLET_2 I-11 said the old path was not acceptable: it was RW2-1).
* No replacement ("bump") of a pending transaction: its inputs wait for a settlement of §6 item 7.
* A wallet that reaches no majority of its configured nodes settles nothing and keeps its locks;
  there is no fallback to one node (deliberately).
* The revision check is half of a compare-and-swap; the other half — storing only if the stored
  revision is unchanged — is the client's storage transaction and is not built.
* The privacy mitigations of §10 are documentation: nothing in the core rounds `since`, delays a
  submission or picks a route.
* The address fingerprint is still 8 bytes (the review suggests 16); `ScanKey::from_parts` still
  cannot check that `nk` belongs to `pk` (I-5); the shielded address is the same on every
  network (I-8). (Dust: §11.)
* No `signed_payload` signing format for shields, no outgoing-history store, no QR encoding.
* No change to `core/wasm-prover` (V1) or to any client package.

## 8. After REVIEW_WALLET_1: what changed

*(Format 2 and its migration are described here as they were at `60d1e2b`. Format 3 — §11 —
replaces them; `confirm_roots` below is `confirm_state` now.)*

**The state (format 2).** `WalletState` JSON, `"version": 2`:

| Field | Content |
|---|---|
| `pk`, `next_height`, `tree` | as in format 1 |
| `notes[]` | as in format 1, plus `confirmed: bool`; no zero-value notes; `tx_hash` is 64 lowercase hexadecimal characters (or empty in a migrated state) |
| `pending[]` | one entry per transaction handed out: `tx_type`, `nullifiers` (two), `inputs` (leaf positions), `input_total`, `change` (`cm`, `value`) or `null`, `expiry_height`, `status` (`pending` / `mined` / `expired`), `mined_height`, `rejected_hint` |
| `checkpoints[]` | `(height, root)` at each of the last 256 heights at which the tree changed — the wallet's own root at a height, which `confirm_roots` compares |
| `confirmed_height` | the highest height at which a quorum matched, or `null` |
| `blind` | the nullifiers seen while a note had no nullifier (scan with the viewing key alone), at most 1,024, and an overflow flag |

**Migration from format 1** (`from_json` does it; `to_json` always writes format 2): every note
becomes `confirmed: false`; zero-value notes are dropped; a `tx_hash` that is not a hash is
cleared; the root history starts at the scanned height (older heights cannot be confirmed — only
notes at or below a later matched height, which is all of them once the tip matches); a note that
format 1 had marked spent locally (`spent` without `spent_height`) becomes unspent and the locked
input of a pending entry with its nullifier and **no expiry** — format 1 did not record one, so
the entry is released only when that nullifier is seen, never by time, and never on a node's word;
a state that holds an unspent note without a nullifier sets the overflow flag, so the full key is
refused until a rescan (format 1 kept no record of what appeared meanwhile). Format 1 was never
used by a client.

**F-3, which way and why.** Both: while the state holds a note without a nullifier it remembers
every nullifier that appears (bounded: 1,024, about one full page of the node), and when a key
with `nk` is supplied it derives the missing nullifiers and applies the remembered spends before
the page; if more appeared than it remembers, `scan` returns `rescan_required` and leaves the
state untouched. Filling in the nullifiers alone (the review's first suggestion) is not correct —
a spend that happened in a page scanned without `nk` would be missed for ever; refusing always is
correct but makes the common case (a background worker with the viewing key ran for a while)
needlessly expensive. The combination is exact in both directions: either the state has seen every
nullifier since its first blind note, or it says that it has not.

**F-4.** `scan` validates every string of a page before the state is touched: `tx_hash` exactly
64 lowercase hexadecimal characters, `tx_type` one of the three V2 types, and as before the
nullifiers, commitments and ciphertexts. `tip_height` is required (I-6) and `next_height` may not
exceed the node's own tip + 1. A page is at most 32 MiB and 4,096 transactions (the node sends at
most 512).

**Checks made on this host after the fixes** (commands and counts in the "Resolution" section of
`REVIEW_WALLET_1.md`): the wallet and wasm crates' tests, every `rw1_*` test passing and none
ignored; the node-side crate with and without `test-prover`; the four daemon test modules; the
`wasm32` release build; the daemon release build; `cargo tree` (default feature only); the
`@noble/post-quantum` cross-check (53 of 53); and that building the daemon together with the
wallet crate fails at the compile-time guard.

## 9. Randomness of the builders (F-5)

Before the fix the builders read the operating system's generator once per value and used the
bytes as they came. A generator that repeats — a restored VM snapshot, a broken `crypto`
polyfill — then gave both notes of a self-payment one ML-KEM randomness (one AES-256-GCM key, the
fixed nonce, two messages: the ciphertexts XOR to the two values) and gave every note the wallet
ever made the same `r` (and `r` is what a payee receives).

Now each builder reads the generator **once**, 32 bytes, and keys one generator with it:

```
prk  = HMAC-SHA256(key = the 32 OS bytes;
                   "rouge-shield/v2/wallet/tx-randomness/v1" ‖ counter (u64 LE)
                   ‖ 0x20 ‖ sk   (or 0x00 for a shield)
                   ‖ kind ‖ chain tag ‖ anchor ‖ expiry ‖ fee ‖ the inputs (position, value, rho, r)
                   ‖ the recipient (pk, ek) / account ‖ the amounts)
draw = HKDF-Expand(prk, info = label ‖ slot (1 byte) ‖ draw number (u32 LE))
```

Labels: `dummy-input/sk`, `dummy-input/rho`, `dummy-input/r`, `output/r`, `output/ml-kem-m`,
`nobody/ml-kem-d`, `nobody/ml-kem-z`, `nobody/pk`, `slot-order`. The draw number increases with
every draw of the transaction, so no two draws of one transaction share an `info`, and rejection
sampling simply takes the next draw. `counter` counts the transactions assembled by the process.

What it gives: with a working generator, 256 bits of fresh entropy per transaction, expanded;
with a generator that repeats, values that still differ per use, per slot, per transaction
(counter, transcript) and per wallet (`sk`), and that are as unpredictable as the spending key —
for a shield, which has none, as the recipient's address, which is not on chain. What it does not
give: anything if the generator fails (that is still an error — the hedge never stands in for
it), and forward secrecy against somebody who holds both the OS bytes and `sk`.

Not done, on purpose: the review's second suggestion — putting the commitment into the HKDF
`info` of the note key — would change the note encryption of spec §3.4 and its vector. The
per-slot label makes the reuse impossible without touching the format.

## 10. Privacy from the node

Spec §5.8 (W-13). Documentation only — nothing below is enforced or done by the core.

| What the node sees | Why it matters | What a client should do |
|---|---|---|
| `expiry_height` of every transaction (public, chosen by the wallet) | clients that choose it differently are distinguishable on chain | use the fixed offset every client uses: anchor height + 64 (`TxContext::new`); do not derive it from wall-clock time |
| the `since` of each listing request | it says exactly how far this client has synced: the same client is recognisable across network addresses, and its `since` is the anchor of what it sends next | round `since` down to a fixed stride (e.g. a multiple of 64), then drop from the answer the blocks already applied before calling `scan` (the core refuses a page that does not start at `next_height`, so the client trims it and sets `from_height`); do not poll at an interval that identifies the client |
| the anchor of a transaction, and who had just synced to that height | a transaction that arrives with the anchor a client was just served is probably that client's, by whatever route it arrives | wait a random time between the last sync and submitting; consider submitting through another node or route than the one scanned from |
| a shield's note value (`v_in − fee`, public) | a later unshield of the same amount is linkable at any pool size | nothing a wallet can do except warn; unshield other amounts |
| a self-merge followed by a payment | a visible two-step pattern | merge ahead of need, not right before paying |
| the network address of every request | — | the user's own node, or a transport that hides it |

## 11. After REVIEW_WALLET_2: the settlement redesign

*(What follows describes state format 3 as it was built after the second review. §12 changes the
quorum — it is a strict majority of the CONFIGURED nodes, `confirm_state` takes no quorum and a
conflict does not block —, the builders, `mark_pending`'s expiry bound and the state format;
where §12 and this section differ, §12 holds.)*

`REVIEW_WALLET_2.md` found that the wallet decided a pending transaction's fate on evidence one
node controls: "mined" from a nullifier in one node's listing, "expired" from the absence of
nullifiers that the confirmed root does not commit. Its "Resolution" section maps every finding
to a commit. The principle the redesign follows:

> **The wallet believes nothing about a transaction's fate that it cannot tie to data a quorum of
> nodes vouches for.**

**1. Both halves of the listing are authenticated.** The node's pool state (spec §4.8) is the
commitment tree and the running nullifier hash `nullifier_acc`. The wallet already rebuilt the
tree; it now also feeds every `nf1`, `nf2` of the listing, in order, through the pool's own
`nullifier_acc_step` (exported from `quantum_vault_shield_v2::pool`; not re-implemented), and
keeps `(root, nullifier_acc, note_count, nullifier_count)` per height. `confirm_state` compares
all four. The daemon interop tests check the wallet's hash against the node's consensus value
after every block.

**2. Settlement rules** (`WalletState::resolve`, spec §5.5), with `C` the confirmed height:

| Outcome | Condition | Effect |
|---|---|---|
| `mined` | a transaction at a height ≤ `C` has both nullifiers AND both output commitments of the entry | inputs spent; the change is a confirmed note |
| `superseded` | a different transaction at a height ≤ `C` has one of its nullifiers | never minable; only the inputs whose own nullifier appeared are spent, the others are released |
| `expired` | `C ≥ expiry_height` and none of its nullifiers appeared up to `C` | never minable; all inputs released |
| stays pending, **locked** | anything else: seen above `C`, "rejected", a scanned height nobody confirmed, no confirmed height at all | — |

`scan` only *notes* what a listing shows (`status: seen_mined / seen_superseded`, `seen_height`).
`ReleasePolicy` is gone. `fresh_for_rescan` resets every entry to `pending`. A lock is held by
the input note's commitment (`input_cms`), so it follows the note through a rescan (I-5).

**3. State format 3.** `"version": 3`:

| Field | Content |
|---|---|
| `revision` | goes up by one with every change of the state |
| `pk`, `next_height` | as before |
| `min_note_value` | incoming notes below it are counted, not stored |
| `tree` | `note_count`, `frontier`, `root`, `tracked` (leaf positions), `nodes`: `[level, index, digest]` for exactly the tree nodes on the tracked leaves' paths — each once |
| `nullifier_acc`, `nullifier_count` | the pool's running nullifier hash as rebuilt from the listing |
| `notes[]` | one array per note: `[value, r, rho, position, cm, nullifier, height, spent_height, tx_hash, output_index]`. `spent` and `confirmed` are not stored (recomputed on read) |
| `pending[]` | `tx_type`, `nullifiers` (two), `outputs` (two), `inputs`, `input_cms`, `input_total`, `change`, `expiry_height`, `status` (`pending` / `seen_mined` / `seen_superseded`), `seen_height`, `rejected_hint`, `legacy` |
| `checkpoints[]` | `(height, root, nullifier_acc, note_count, nullifier_count)` at each of the last 256 heights at which the pool changed |
| `confirmed_height`, `blind` | as before |
| `below_minimum`, `over_capacity`, `pruned` | `{count, total}`: notes not stored (dust; beyond 65,536), and spent notes dropped |

**Migration** (`from_json` does it; `to_json` writes format 3 only). Formats 1 and 2 have no
nullifier hash and it cannot be computed afterwards, so their notes could never be confirmed:
**both migrate to an EMPTY state that keeps the locks**, to be scanned from the activation height
(the rescan finds every note again).
* *From 2:* every pending entry is kept as pending and locked — also one format 2 called `mined`.
  The lock is by the input notes' commitments (by position if the format-2 state was itself in
  the middle of a rescan and had no notes). The entry has both nullifiers and the change
  commitment but not both outputs: it is `mined` when a confirmed transaction has exactly its
  nullifier pair and its change commitment.
* *From 1:* every note format 1 had marked spent locally becomes a `legacy` lock on that note
  (its commitment, its nullifier if known). A `legacy` lock whose nullifier appears is returned
  under `superseded`, which for it means only "its input was spent on the confirmed chain".
* *A lock without an expiry* (format 1; format 2 migrated from 1) gets **`expiry_height` = the
  old state's scanned height + 128** — the builders' maximum expiry distance — and settles by
  the same confirmed rules. It is no longer permanent (I-2). Format 1 itself did not bound the
  expiry it accepted, so a transaction built by a format-1 client with a longer expiry is not
  covered; no client was ever released on format 1.

**4. Dust (RW2-7).** Measured (`rw2_f7_dust_…`, 241 notes): **598 bytes of state JSON per stored
note** with one note per transaction (3.1 shared tree nodes each; two when both outputs of a
transaction are the wallet's), against 2,718 before; a note below `min_note_value` costs the
state nothing but two counters. With the default minimum (the minimum fee, 1 XRGE) a stored note
costs its sender ≥ 1 XRGE of value — which the victim receives and can spend — plus half a fee:
**1 MB of victim state = 1,672 notes = 836 XRGE in fees + 1,672 XRGE handed to the victim**
(before: 368 notes of one quantum each, 184 XRGE in fees and nothing else). The
state stops storing at 65,536 notes (≈ 39 MB at that rate; under 206 MB in the worst case of 32
unshared nodes per note, which no chain can produce), counts the rest in `over_capacity`, and
`to_json` refuses to write more than `from_json` reads (256 MiB) — it cannot get there. Spent
notes leave the state 256 blocks after their spend is confirmed, into `pruned`.
What the default costs an honest user: a payment or a change of less than 1 XRGE is not stored.
A client that wants every note sets `min_note_value` to 1.

**5. Lost updates (I-3).** `revision`, `expected_revision`, `stale_state:` — §6 item 3.

**6. What is still trust in nodes**, plainly:
* Everything the wallet calls confirmed is the word of the nodes it asked. A strict majority of
  them lying together — or one operator behind most of the endpoints the client configured — is
  believed: forged incoming notes become "confirmed", and a transaction can be settled as
  expired while it is really minable, or as mined while it is not.
* The confirmed balance is exact as of the confirmed height only. Above it the wallet shows one
  node's listing, labelled unverified.
* Liveness: a node that withholds a transaction, lies in its listing or reports garbage can keep
  a wallet's notes locked — until an honest quorum confirms the expiry height — but can no longer
  make the wallet pay twice or show a balance it does not have.
* Privacy from the node is unchanged (§10): asking several nodes for `stats` tells several nodes
  that this address is syncing.

## 12. After REVIEW_WALLET_3: availability

`REVIEW_WALLET_3.md` found the redesign of §11 safe and not live: G1 (no double payment) and G2
(confirmed ≤ true) held, G3 (no permanent lock or loss from view) and G4 (a lying minority causes
delay only) did not. What changed, by finding; the "Resolution" section of that file maps each to
its commit.

**The quorum belongs to the state (RW3-1, RW3-8).** `WalletState::set_nodes(ids)` stores the
configured nodes as canonical http(s) origins (`canonical_node_id`: scheme and host lower-cased,
default port, path, query, fragment and one trailing dot removed; anything that is not an origin
is refused), sorted, each once, at most 64. `confirm_state(reports)` has no quorum argument:

* a report counts only under a configured id, at most once per height (two different reports
  from one node for one height make that node dissent there);
* a height is confirmed iff `⌊n/2⌋ + 1` (at least 2) of the `n` CONFIGURED nodes report exactly
  the wallet's root, nullifier hash, ciphertext hash and both counts for it;
* dissenters are returned (`dissenting: [{ node_id, height }]`) and do not block; `diverged` now
  means "nothing matched and somebody contradicts";
* `listing_refuted`: more than `n − quorum` nodes contradict the wallet at one height — an
  honest one among them — so the wallet's own listing is wrong;
* `quorum_tip` / `listing_ahead`: the quorum-th highest height the nodes claim, and whether the
  listing shows transactions above it (found by the property test's independent model, not by
  the review: a listing node can append a "block" nobody has in which a note of the wallet is
  spent; nothing can contradict it, and the note would be out of every balance until the chain
  got there).

"Drop a node", which these notes used to offer as a way out of `diverged` and which confirmed a
forgery with two liars of five, is gone: leaving a node out cannot lower the threshold.

**The expiry is measured from the confirmed height (RW3-7).** `spend_base` gives a builder its
anchor (the tree root, which must be the root at the confirmed height unless the caller passes
`allow_unverified`) and the height the expiry is measured from (the confirmed height, always).
`mark_pending` refuses an expiry above the confirmed height + 128 and a state without a confirmed
height. The scanned height — the listing node's claim — is in neither. Every entry therefore
settles by the time the confirmed height reaches its expiry (`rw3_f7c_…`; the property test
asserts `expiry ≤ TRUE height at the build + 128` and that the client's loop ends).

**Build and lock are one call (RW3-5).** `build_transfer(state, expected_revision, keys, params)`
and `build_unshield(…)` return `LockedTx { tx, state }`; the pending entry is recorded before the
proof is made. The crate exports no function that returns a proven spend without that state
(`TransferRequest` / `UnshieldRequest` are the assembly's input and are reachable only through
the `test-vectors` feature, which yields unproven bodies). `WalletState::mark_pending` is still
public — for tools and tests that assemble a record — and re-checks everything against the
confirmed height. `abandon_unsubmitted` records a hint and releases nothing.

**Ciphertexts are in the confirmed state (RW3-2).** Two independent halves:

* *Own outputs never depend on a ciphertext.* The pending record holds `(cm, value, r)` of the
  change (and of a payment to the wallet's own address). When the scan meets that commitment it
  recomputes it from the record and stores the note — also when the listing's ciphertext is
  blanked, also when the note is below `min_note_value` (RW3-3).
* *Every ciphertext is vouched for.* The node keeps a running hash over `(cm_out, kem_ct,
  note_ct)` of every accepted output, **node-locally**: beside the pool record in the same store
  write, rolled back by the same snapshot / restore, rebuilt by a re-import or once at start-up
  from the stored blocks, and absent from the record the state root reads
  (`core/daemon/src/shield_v2.rs`, `ciphertext_acc_step`; `node::shield_v2_daemon_tests::rw3_f2_…`
  shows two nodes — one with the hash, one with it destroyed — importing the same blocks with
  identical block hash, state root and pool record). It is reported as `report.ciphertext_acc`,
  the wallet computes the same from its listing (`store::ciphertext_acc_step`; the daemon's
  interop tests compare the two implementations on every sync), and `confirm_state` requires
  it. A node that cannot vouch for it reports `null` and that report counts for nothing.

**The cap counts unspent notes (RW3-4).** `max_unspent_notes` is a parameter of the state
(`with_limits`, `fresh_for_rescan_with`; default 65,536, at most 1,048,576). Spent notes do not
count; a scan keeps at most `MAX_SPENT_RETAINED` = 4,096 of them (the most recently spent) and
drops the rest into `pruned` at the end of every page, so a restore over any history ends with
every unspent note stored. `over_capacity` is recovered by a rescan with a higher cap.
*What filling the default cap costs a hostile sender:* 32,768 transactions of two 1-XRGE outputs
= 32,768 XRGE in fees + 65,536 XRGE that the victim receives and can spend; for a minimum note
value `m` and a cap `c`: `c/2` fees + `c·m` given away. (`to_json` still refuses a state above
256 MiB whatever the cap: about 420 bytes per note plus its share of tree nodes.)

**Own outputs and dust (RW3-3).** Stored regardless of `min_note_value`: an output opened by the
wallet's pending record, and — so that a restore finds it too — any output for this wallet in a
transaction that spends one of this wallet's notes (only the wallet's key can make one; not
available when scanning with the viewing key alone). Coin selection (`select_inputs`) prefers a
*clean* change (zero, or at least the minimum note value): the smallest single note with one,
else the smallest pair with one, else the plain rule with `change_below_minimum: true`.

**The report is of accepted blocks (RW3-6).** The node writes the report record after
`append_block`; `shield_v2_stats` serves that record, not the pool record a speculative apply has
just written.

**State format 4.** Adds the configured nodes, the cap, the ciphertext hash (current and per
checkpoint), `r` in the pending change record, `own_payment`, `abandoned_hint`. Formats 1, 2 and
3 migrate to an empty state that keeps every lock and has no configured node. A format-3 entry
keeps its recorded expiry — it was bounded by the scanned height, and shortening it here would
release a lock on a transaction that is still valid; an entry built by a format-3 client after a
lying page keeps its long lock (no client was released on format 3).

**The property test** (`tests/settlement_properties.rs`) was rewritten around an oracle that is
not the code under test: a reference chain with its own nullifier set, hashes, anchor window,
expiry rule and books of ownership (entered by whoever made the transaction, never by scanning),
3 to 7 nodes with a random strict minority of colluding liars, a hostile sender, a second device,
crashes, restores, migrations, and a client that follows the four rules of §6 item 4 and the
rules of item 7 and nothing else. It checks G1–G4, G3 as a bound (`2·nodes + 4` client rounds).
The review's mutation table against it is in the Resolution.

**What remains trust in nodes.**

* A majority of the configured nodes lying together — or one operator behind most of them — is
  believed in everything: forged notes confirmed, a live transaction settled as expired (and the
  retry pays twice), a mined one hidden.
* Whoever configures the wallet decides who the nodes are; the core cannot tell two names of one
  machine apart.
* A reorganisation below the confirmed height is not handled: the confirmed height never goes
  back.
* A second device or a restore has no locks (§6 item 7); the embargo of 128 confirmed blocks is
  the UI's to enforce.
* An honest node's report is trusted to be of an accepted block; a validator that equivocates
  can still make two honest nodes hold two different accepted blocks at one height — that is a
  consensus failure, not a wallet one.


## 13. After REVIEW_WALLET_4: a state that always reads back, the embargo in the core

`REVIEW_WALLET_4.md` (of `e229cde`): one High, two Medium, three Low, six Info. Branch
`fix/shield-v2-wallet-settlement-3`. State format 5. No constant, tag, encoding or parameter of
spec §2, no consensus rule and nothing of the state root is touched: the wallet crates and the
wasm surface only (and one line of test set-up in the daemon's interop tests).

**RW4-5 (High) — a state that could never be read again.** Root cause: a pending entry named
its inputs by leaf position, and a rescan rewrote those positions one at a time. Now:

* **An entry is held by the commitments of its input notes and by its nullifiers — never by a
  position.** `PendingTx.inputs` is derived: after every change, and on every read of a state,
  it is recomputed from the stored notes (for a note the state does not hold: the last position
  known, which nothing reads). A note is locked when its commitment is one of the entry's
  `input_cms` **or its own nullifier is one of the entry's `nullifiers`**.
* **Leaf numbers are the listing node's claim.** A note's position is where the wallet's own
  tree puts it. Inside a page the numbers must be consecutive; a page that starts ABOVE the
  wallet's tree skipped transactions and is refused (`listing:`), as before; a page that starts
  BELOW it is applied and reported (`report.leaf_mismatch` — rescan): the earlier listing is
  what is in doubt, and refusing every later honest page would leave the client with a state it
  cannot feed.
* (a) **Every call that changes a state validates the result with the validation `from_json`
  applies before it replaces the caller's state** (`scan`, `confirm_state`, `resolve`,
  `mark_pending`, `set_nodes`, the hints, the override, `record_own_shield`). A failure is an
  implementation fault: a debug build stops on it; a release build refuses the call
  (`state_invariant:`), state unchanged. (b) **`to_json` reads its own text back and compares**
  before returning it; if it does not read back as that state it returns the error, never the
  bytes. (c) **`recover_locks(text)`**: for a STORED state that `from_json` refuses — every
  pending entry that can be read (nullifiers, input commitments, outputs, own outputs with
  their `r`, expiry) goes into an empty state to rescan into; nodes, minimum note value, cap and
  revision are kept where valid. If an entry could not be read at all, or its expiry is
  unknown, the recovered state is under the restore embargo. **A `state:` error is never
  answered with `new_state`.**
* Format 4 states that RW4-5 had poisoned (an entry naming one position twice) are read again:
  the migration 4 → 5 is in place and does not read positions.

**RW4-1 (Medium) — the embargo after a restore, in the core.** A state made by `new_state`
has no lock history. It builds nothing (`restored_recently:`) before a confirmed height exists,
and the FIRST `confirm_state` that confirms a height fixes its **embargo base**:

```
Tq    the quorum's tip: the highest height that a strict majority of the configured nodes
      claim to have reached (a node's claim is the highest height it reported in the call)
Tm    the highest height ANY configured node claimed in the call
base  = min(Tm, Tq + 256)   if every configured node reported
      = Tq + 256            if one did not (a silent node is taken to have claimed the most)
no spend until the confirmed height ≥ base + 128
```

*Why it is sufficient.* An earlier copy that built at confirmed height `C_b` had a quorum for
`C_b`: at least one honest node had reached `C_b`, and an honest node never goes back. Its
transaction is dead after block `C_b + 128` (the builders and `mark_pending` accept no longer
expiry — the embargo and the longest expiry are one constant). If `base ≥ C_b`, then at
confirmed height `base + 128` every block that could hold it has been read and confirmed: it is
mined, and its inputs are spent in this state, or it never will be.

*What a liar can do.* It cannot lower `Tq` below what the honest nodes that answer support (it
is fewer than a quorum), and it cannot hide the tip of an honest node that answers (`Tm`). It
can claim a high tip, or stay silent: the base then goes UP, by at most 256 blocks. Delay,
bounded: at most 384 blocks of embargo instead of 128.

*What remains — stated, not solved.* The rule is sufficient **iff `C_b ≤ Tq + 256`**: the nodes
whose tips form the first quorum after the restore are not more than 256 blocks behind the
height the lost copy last built at. Where fewer nodes lie than two quorums must have in common
(`2·quorum − n`: four nodes with one liar, for instance) the two quorums share an honest node,
which reports its own tip, so the first confirmed height is already ≥ `C_b` and no assumption
on lag is needed. With three, five or seven nodes and a full lying minority they may share only
liars; an honest node more than 256 blocks behind (re-syncing after an outage) together with a
liar that replays a true old state, against a device that was lost with a payment in flight, is
then a double payment the embargo does not prevent. No rule without a light client closes that; the margin
is 256 blocks, and the property test's world (honest nodes up to 200 behind, the liars
replaying where the slowest honest node stands) runs inside it.

*The override.* `assert_sole_copy` (core: `assert_no_other_copy_has_a_pending_payment`) records
the user's statement in the state. It is accepted only before the first confirmed state check,
and honoured at that check only if no configured node reported a tip above the height being
confirmed — a quorum that forms below a known tip is the shape of the attack, and then the core
does not take the user's word. A state migrated from an older format, and a state recovered
with every lock read, is a device's own state and has no embargo.

**RW4-4 (Medium) — a payee's address with the payer's `pk`.** "To self" is the whole address:
`pk` and encryption key. For any other recipient the note is encrypted to the recipient's key
and the wallet keeps nothing of it but the outgoing record. A recipient with the wallet's own
`pk` and another encryption key is refused (`recipient_mixed_address:`) by the transfer builder
and by `build_own_shield`: it is a mistake or an attack.

**RW4-3 (Low) — a state scanned with the viewing key.** The first scan without the nullifier
key marks the state (`view_only_since`). While it is marked: `confirmed_balance` leaves out
every note whose nullifier is unknown — those are reported as `received_spend_unknown`, under
`unverified_spends: true` — `spendable_balance` is 0, coin selection offers nothing and the
builders refuse (`view_only:`). One page scanned with the full key derives every missing
nullifier, applies every remembered spend and removes the mark.

**RW4-2, RW4-7 (Low, Info) — node ids.** An IP literal has one spelling: IPv6 in its RFC 5952
form; IPv4 as four decimal parts without leading zeros — `127.1`, `2130706433`, `0x7f.0.0.1`,
`127.0.0.01` are refused. And the SET has a rule, enforced by `set_nodes` and on every read of
a state: https only; `http` for loopback hosts only (`localhost`, `*.localhost`, `127.0.0.0/8`,
`[::1]`); a loopback node is never in a set with a node that is not (a development set is
all-loopback, told apart by port); **one node per host**, whatever the scheme or the port.

**RW4-10 (Info) — the revision identifies content.** `revision_id` =
`SHA-256(tag ‖ previous identity ‖ counter ‖ name of the change ‖ digest of the changed state)`.
The counter stays (it orders, and it is the `expected_revision` of the calls); the identity is
what a client stores and compares — §6 item 3.

**RW4-11 (Info) — the wallet's own shield.** `build_own_shield(state, own_address, …)` records
the note `(cm, value, r)` in the state; the scan stores it from the record whatever its value,
by the rule that stores the wallet's own change. `build_shield` refuses a note below the
minimum note value unless `allow_below_min_note_value`. The record of an unspent note below the
minimum is kept, also across `rescan_state`; a restore from the phrase alone does not find such
a note (rescan with a minimum note value of 1) — which is what the explicit flag accepts.

**RW4-8, RW4-9, RW4-12 (Info) — what the UI is told.** `summary.spend`, `confirm_state.spend`
and `can_spend_now(state, quorum_tip)`: `can_spend_now`, the `reason` when not (`no_nodes`,
`view_only`, `no_quorum`, `embargo`, `root_unconfirmed`, `window_too_short`), `confirmed_lag`
(`quorum_tip − confirmed_height`), `usable_window_blocks` (`64 − lag`), `embargo_until`,
`embargo_blocks_left`, and the four bounds — all in blocks. `constants()` carries
`restore_embargo_blocks` (128) and `restore_lag_bound_blocks` (256). `confirm_state` returns
`outdated_nodes`: configured nodes whose report lacks only `ciphertext_acc`.

**The property test** (`tests/settlement_properties.rs`) was rebuilt around what the review
found missing in its world: 2 to 7 nodes; honest nodes up to 200 blocks behind; several
transactions per block; 280 pool-changing blocks in a row (evicted checkpoints); scans with the
viewing key; a hostile payee; restores answered by a stale quorum; pages cut anywhere during
rescans; and **value computed by the oracle from the request**, with every output's commitment
recomputed from the amount the request implies. Its client executes the loop of §6. Its false
positive (RW4-6: a lock migrated from format 1 "holding" a dead attempt) is corrected. It runs
200 seeds by default; `PROP_RUNS`, `PROP_STEPS`, `PROP_SEED_BASE` move the range, and CI adds a
randomly placed range whose base it prints. The mutation table is in the Resolution of
`REVIEW_WALLET_4.md`.

**What changed for callers.**

| Before | Now |
|---|---|
| `version: 4` | `version: 5`; 4 migrated in place, 1–3 as before |
| a state made by `new_state` spends as soon as it is confirmed | `restored_recently:` for 128 blocks above the embargo base, or `assert_sole_copy` |
| `{ state, revision }` | `{ state, revision, revision_id }`; `expect_revision_id` |
| `http://` nodes, two ports of one host | refused by `set_nodes` (loopback development sets excepted) |
| a page numbered below the wallet's tree: `listing:` | applied, `report.leaf_mismatch: true` (rescan) |
| a `state:` error: nothing to do | `recover_locks` |
| `build_shield` for one's own address, any value | `build_own_shield` (recorded); `note_below_minimum:` |
| a recipient with one's own `pk`: "payment to self" | the whole address, or `recipient_mixed_address:` |
| a report without `ciphertext_acc`: `malformed` | `outdated_nodes` |
