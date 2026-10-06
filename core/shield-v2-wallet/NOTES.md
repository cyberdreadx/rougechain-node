# Shielded pool V2 — wallet core: implementation notes

Specification: `docs/SHIELDED_POOL_V2_SPEC.md` (SPEC v1, amended 2026-10-06, W-1 … W-13). Branch
`feat/shield-v2-wallet-core`, from `main` @4aeb25b (which contains the node side).

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
| 14 | §5.5 | anchor and expiry | The caller passes the anchor **and the height it belongs to** (`TxContext::anchor_height`: the wallet's scanned height; the node's tip for a shield). The builder checks that every real input's path leads to the anchor (`AnchorMismatch` otherwise) and that `anchor_height < expiry_height ≤ anchor_height + 128` (`MAX_EXPIRY_OFFSET`, the anchor window). `TxContext::new` sets the default, **anchor height + 64** (`DEFAULT_EXPIRY_OFFSET`). The builder has no chain view, so a caller can lie about `anchor_height`; `WalletState::mark_pending` therefore checks the bound again against the state's own scanned height. Before the first block from activation the node's stats report `pool: null`; the anchor is then the empty-tree root (`WalletState::new(..).anchor()`). Spec W-11 |
| 15 | §5.4 | "kept current as leaves are appended" | `TreeTracker`: frontier + one 32-sibling path per unspent non-zero note; 32 hashes per appended leaf plus 32 comparisons per tracked note. Checked against the reference sparse tree, the stage-1 `Pool` and a real node (root and frontier) |
| 16 | §5.4 | "MUST follow reorganisations" | The tracker cannot undo an append. `scan` requires each page to continue the state exactly (`from_height`, and the leaf position of every output) and refuses otherwise, leaving the state untouched (the page is validated and trial-decrypted completely before the state is changed, in place — no copy of the state per page); recovery is a rescan from `WalletState::fresh_for_rescan()`, which keeps the pending transactions. A reorganisation that replaces already-scanned blocks is noticed at the next mismatching leaf or by `confirm_roots` (`diverged`). The pending-release rule assumes blocks at or below a transaction's expiry are not replaced afterwards; the chain has no reorganisation handling in the node today. Spec W-5, W-10 |
| 17 | §5.4 | zero-value notes addressed to the wallet (its own zero change) | **Not stored** (REVIEW_WALLET_1 I-7): the leaf is appended to the tree, no note and no path are kept. Anybody can send them; there is nothing to spend. A dust note with a non-zero value is still stored and tracked (about 2 kB of state each) — the sender pays a fee per two of them; pruning them is not done |
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

* Exports (20): `constants`, `shielded_address`, `parse_address`, `export_scan_key`,
  `new_state`, `scan`, `scan_pages`, `summary`, `plan_payment`, `plan_self_merge`, `build_shield`,
  `attach_signature`, `build_transfer`, `build_unshield`, `mark_pending`, `pending`,
  `note_rejection`, `resolve_pending`, `confirm_roots`, `rescan_state`. Each returns
  `Result<string, Error>`: JSON text, or an error whose message starts with a code (`entropy:`,
  `fee_below_minimum:`, `fee_above_maximum:`, `anchor_mismatch:`, `note_locked:`,
  `rescan_required:`, …). The JSON shapes are declared for TypeScript in a custom section.
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
| `cargo build --release --locked --target wasm32-unknown-unknown -p quantum-vault-shield-v2-wasm` (the workspace's release profile) | succeeds, no warnings | 2,432,370 bytes after the fixes of REVIEW_WALLET_1 (2,220,849 before) |
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
   balance — never synced in clear. It is versioned (`version: 2`; version 1 is read and
   migrated, §8). **Persist the state returned by `mark_pending` before submitting**: a wallet
   that loses the pending record has lost the lock.
4. **Sync and what a balance means.** Page through `/api/shield-v2/notes` from `next_height`,
   apply each page with `scan`; on a `listing:` error or a `diverged` root check, rebuild from
   `rescan_state` (it keeps the pending transactions).
   **A listing from one node cannot be authenticated.** The earlier text here said a hostile node
   "can hide notes but cannot forge them"; that was wrong (REVIEW_WALLET_1 F-1). A note is checked
   against the commitment and the nullifiers of the same listing, and nothing ties one node's
   listing to the chain — the chain has no light-client proofs yet. A node that knows the wallet's
   address can list a payment that is on no chain, and its `latest_anchor` is then the root of
   the tree it made the wallet build, so comparing with it proves nothing.
   What the core does: every note is `unverified` when found. After scanning, ask **each node of
   a set you chose** for its `/api/shield-v2/stats` and pass `(node_id, tip_height,
   pool.latest_anchor)` per node to `confirm_roots`. Notes at or below the highest height at
   which at least `quorum` distinct nodes reported the wallet's own root become `confirmed`
   (default quorum 2; one node ⇒ everything stays unverified). `summary` reports the confirmed
   and the unverified balance separately; `plan_payment` uses unverified notes only with
   `allow_unverified = true`.
   What the UI must do (spec §5.4, normative): **never present an incoming shielded payment as
   final on one node's word** — show it as unconfirmed until the quorum check passes; a
   merchant-facing integration must use its own node (and says so with quorum 1 for it).
   What this is, honestly: the word of several nodes instead of one — the same trust a wallet
   places in a node for ordinary account balances today, not a proof. The node ids are the
   caller's labels; choosing nodes that are in fact independent is the caller's job, and two
   names for one node defeat the check. Header-committed proofs of the pool root come with the
   consensus / light-client work.
5. **Privacy of the scan.** The wallet downloads everything and never asks for one position.
   The node still learns the wallet's IP address and sync cadence — and more; see §10.
6. **Anchor and expiry policy.** Use `latest_anchor` and the height it belongs to; leave the
   expiry at the default (`TxContext::new`: anchor height + 64). The builder refuses an expiry
   at or below the anchor's height or more than 128 blocks above it.
7. **Pending transactions.** `build_transfer` / `build_unshield` return a `pending` record.
   **`mark_pending` it and persist the state BEFORE the transaction is sent anywhere.** From then
   on its inputs are locked: not selected, not accepted by a builder. They are unlocked by
   exactly two observations in scanned chain data, both made by the core:
   (a) `scan` sees one of the transaction's nullifiers → mined; the inputs are spent, the change
   arrived as a note; `resolve_pending` returns the entry under `mined`;
   (b) `resolve_pending` finds the scanned height at or above `expiry_height` with no nullifier
   seen → it can never be mined (the node refuses a V2 transaction whose expiry is below the
   block's height); the entry is returned under `expired` and the inputs are spendable again.
   With the default expiry that is at most 64 blocks after the build.
   **Nothing a node answers to the submission releases anything.** The earlier text here said
   "release on expiry or rejection"; releasing on a rejection is unsafe (REVIEW_WALLET_1 F-7): a
   signer-less transaction that has left the wallet stays valid until its expiry, and a node that
   answers "rejected" while keeping it can have it mined after the wallet has paid again from
   other notes. A rejection is recorded with `note_rejection` — a flag for the UI ("the node
   refused it; it is still pending until block N"). The UI shows the payment as pending until (a)
   or (b) and offers no "try again" before then; a payment made meanwhile from other notes is a
   second payment.
   `resolve_pending(state, require_confirmed = true)` applies (b) to the height `confirm_roots`
   last confirmed instead of the height one node's listing reached: a node that lies about the
   chain's height then cannot trigger a release. Use it whenever the wallet has a quorum.
   Shields are not recorded: a shield spends no note (it is an account transaction with a nonce).
   Store `BuiltTx.outputs` as the outgoing record — the chain will not give it back — and treat
   it as secret: `value` and `r` open the note (I-3).
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

## 7. Not done

* No second review of the fixes of §8 (the review covered `abab9a8`).
* No light-client verification of anything: `confirm_roots` is a quorum of node statements, not a
  proof (spec §5.4).
* `wasm-bindgen-cli` and `wasm-pack` are not installed on this host, so the JavaScript bindings
  were not generated and nothing was run in a browser or in Node; the `.wasm` was built and its
  surface was tested natively.
* No measurement of proving inside WebAssembly, on a phone, or on a quiet host.
* No reorganisation handling beyond "refuse and rescan" (with the pending list kept).
* No replacement ("bump") of a pending transaction: its inputs wait for (a) or (b) of §6 item 7.
* The privacy mitigations of §10 are documentation: nothing in the core rounds `since`, delays a
  submission or picks a route.
* The address fingerprint is still 8 bytes (the review suggests 16); `ScanKey::from_parts` still
  cannot check that `nk` belongs to `pk` (I-5); dust notes of non-zero value are still stored
  (I-7); the shielded address is the same on every network (I-8).
* No `signed_payload` signing format for shields, no outgoing-history store, no QR encoding.
* No change to `core/wasm-prover` (V1) or to any client package.

## 8. After REVIEW_WALLET_1: what changed

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
