# REVIEW_WALLET_1 — independent adversarial review of the shielded pool V2 wallet core

Reviewed: branch `feat/shield-v2-wallet-core` @ `abab9a8` — `core/shield-v2` (feature `prover`),
`core/shield-v2-wallet`, `core/shield-v2-wasm`, against `docs/SHIELDED_POOL_V2_SPEC.md` (§2.7,
§3.1–3.5, §5, §8.4, W-1 … W-8) and `core/shield-v2-wallet/NOTES.md`. The reviewer did not write
any of it. Date: 2026-10-06. Nothing was fixed: every confirmed defect has a test, and the tests
of code defects **fail on purpose** until the defect is fixed.

## Verdict

**No Critical and no High finding.** Nothing was found that lets anyone take a user's notes, learn
the spending key or a proof's blinding seed, change a built transaction in flight, or trap the
module on hostile input. The prover's randomness — the item spec O-14 wanted a second reader for —
is sound as built (section 2).

**Two Medium findings, both about what a lying node can do**, and both contradict a sentence of
`NOTES.md` that the UI layers would otherwise follow:

* **F-1** — a node that knows a wallet's address can make it show an incoming payment that is on
  no chain. "A hostile node can hide notes but cannot forge them" is not true.
* **F-7** — "release [pending inputs] on … rejection" is unsafe: a node that falsely reports a
  rejection and keeps the transaction can get the payee paid twice.

Neither is a flaw of the cryptography; each needs a rule this crate does not yet enforce or
state. Five Low findings (F-2 … F-6) and a list of Info items follow. **The wallet core should not
be wired to a UI before F-1 and F-7 have an answer in the core or in a written UI rule.**

| # | Severity | Finding | Where | Test |
|---|---|---|---|---|
| F-1 | Medium | A lying node forges an incoming note from the public address; the prescribed root comparison passes | `store.rs:432–535` (check at 503–507); `NOTES.md:193` | `rw1_demo_f1_…` (passes: design limit) |
| F-7 | Medium | Releasing pending inputs on a claimed rejection allows a double payment; the state keeps no pending transaction | `store.rs:397–416`; wasm `api.rs:338–348`; `NOTES.md:200` | `rw1_demo_f7_…` (passes: design limit) |
| F-2 | Low | bech32m at 1,960 characters accepts two changed characters 1,023 apart and returns another valid address | `bech32m.rs:27–41, 74–118`; `keys.rs:226–232` | `rw1_f2_…` **FAILS** |
| F-3 | Low | A state scanned partly with the viewing key never marks those notes spent | `store.rs:480, 518`; `keys.rs:129`; wasm `api.rs:99, 134` | `rw1_f3_…` **FAILS** |
| F-4 | Low | `tx_hash` from the listing is stored and returned unvalidated (any text, any length) | `store.rs:115, 522` | `rw1_f4_…` **FAILS** |
| F-5 | Low | A generator that repeats is hedged in the prover only: `r` and the ML-KEM randomness repeat; a self-payment encrypts both notes under one key and nonce | `tx.rs:234`; `note_enc.rs:65–71, 94`; `entropy.rs:22–30` | `rw1_demo_f5_…` ×2 (pass: shown under an injected generator) |
| F-6 | Low | Error strings quote their JSON input: a twice-encoded scan key or state puts `dk`, `nk` or note secrets into the error message | wasm `api.rs:114`, `store.rs:337` (also `api.rs:231, 251, 259, 284, 317, 340`) | `rw1_f6_…` **FAILS** |

Tests added: 19 Rust tests in three files and one Node script (section 6).

---

## 1. Findings

### F-1 (Medium) — a lying node can show a payment that does not exist

`WalletState::scan` authenticates a decrypted note against `cm_out_j` and `rho = H_rho(nf1, nf2,
j)` — all three taken from the listing. Nothing ties the listing to the chain. Whoever serves
`/api/shield-v2/notes` and knows the wallet's **address** (`pk`, `ek`: every payer has it) picks
two arbitrary nullifiers, a value and an `r`, computes the commitment, encrypts `(value, r)` to
`ek` and lists the "transaction". The wallet stores the note, adds it to the balance, selects it
and assembles a spend from it.

`NOTES.md` §6 item 4 prescribes "compare `anchor` with the node's `latest_anchor`" and says a
hostile listing "can hide notes but cannot forge them". The liar's `latest_anchor` is the root of
the tree it made the wallet build, so the comparison passes.

*Scenario.* A merchant's wallet talks to one node (its own provider's, or any node behind a
hijacked connection). The buyer controls that node, lists a 1,000 XRGE note to the merchant, the
wallet shows "received", goods leave. No chain ever held the note. The forged note cannot be
spent on the real chain (the anchor is unknown there), so the damage is the false display, not
theft from the pool.

*What the worst case should be.* The task's bar — "denial of service or stale view only" — is not
met for incoming payments. It is met for everything else: `rw1_sound_listing_manipulations_…`
shows that hiding, reordering, duplicating, renumbering, substituting ciphertexts or commitments
and inventing spends are either refused (state untouched) or change the root without ever adding
value.

*Direction (not done).* Correct the sentence in `NOTES.md`. The chain already commits the pool
(spec §4.8: `tree_root`, `frontier`, `note_count` are inside the header state root), so the fix is
a rule plus a helper: a note counts as received only when the wallet's root at that height matches
an anchor obtained from a source the wallet trusts for finality (a second independent node at
minimum; a verified header when the chain has light-client proofs). Until then every client must
label shielded balances exactly like account balances: "as reported by node X".

Test: `tests/review_wallet_1.rs::rw1_demo_f1_a_lying_node_forges_an_incoming_note_from_the_public_address`
(uses nothing but the victim's address).

### F-7 (Medium) — a false "rejected" plus a retry pays the payee twice

`mark_pending_spent` / `unmark_pending` only flip a flag. The state records neither the pending
transaction's nullifiers nor its `expiry_height`, and `NOTES.md` §6 item 7 tells the UI to release
the inputs "on expiry or rejection". A signer-less transaction that has left the wallet stays valid
until `expiry_height` or until its anchor leaves the 128-block window, whatever a node answered.
If the retry spends a *different* note, both transactions are valid together.

*Scenario (the test).* Alice holds one 10 XRGE note and pays Bob 4. The node answers "rejected"
and keeps the transaction. Bob sends Alice 5 XRGE. The UI releases the 10 note; the retry's coin
selection now picks the new 5 note (the smallest that covers 4 + fee). The node mines both: Alice
ends with 5 instead of 10, Bob holds 8. Without Bob's help the same happens whenever the retry
selects other notes — a changed amount, a note that arrived meanwhile, a merge.

*Direction (not done).* Never release on a node's word. Either (a) the state stores each pending
transaction (`nullifiers`, `expiry_height`, the anchor) and `unmark_pending` refuses until the
scan has passed `expiry_height` (the scan knows the height), or (b) a retry is forced to reuse at
least one input of the transaction it replaces, so the two conflict on a nullifier. Choose a short
`expiry_height` (the builder takes any value, `NOTES.md` #14) so the wait is short. Correct the
sentence in `NOTES.md`.

Test: `tests/review_wallet_1.rs::rw1_demo_f7_releasing_inputs_on_a_claimed_rejection_lets_both_payments_be_mined`.

### F-2 (Low) — two changed characters can turn an address into another valid address

The BIP-350 checksum is a BCH code of length 1,023. Its generator divides x^1023 + 1, so beyond
that length the same change applied to two characters exactly 1,023 places apart is invisible to
it. The test finds the first such pair at once (characters 68 and 1,091, changed by the value 1)
and `ShieldedAddress::decode` returns a different address with a canonical `pk` and a valid
ML-KEM key (fingerprint `1bf7e572da1150b1` instead of `4c872866476411c7`). A payment to it is
gone: the `ek` is no longer the recipient's, nobody can find or spend the note.

The spec and the notes say the checksum is "a 30-bit integrity check" at this length. That is the
figure for random damage; the guaranteed detection is **one** changed character, not four, and the
notes do not say so. Realistic cause: a QR code or a chat client that corrupts a repeated block,
or an attacker who may alter two characters of a pasted address. Random double errors of exactly
this shape are rare (about 1 in 60,000 double errors), which is why this is Low.

*Direction.* Put a real integrity value inside the address (for example append the first 16 bytes
of SHA-256 of the 1,216 bytes before encoding and verify on decode), or split the payload into
checksummed chunks shorter than 1,023 characters. O-11 is still open; this is input to it.

Test: `tests/review_wallet_1.rs::rw1_f2_two_changed_characters_1023_apart_must_not_decode_to_another_address`
— **fails**. `rw1_sound_single_character_errors_truncation_and_mixed_case_are_refused` records what
does hold.

*The fingerprint (Info, same area).* 8 bytes = 64 bits. A look-alike address that matches the
whole fingerprint of a chosen victim costs about 2^64 address derivations — out of reach for
most, not for everyone, and it only needs to be done once per victim. If a UI shows or a user
compares only the first and last four hex characters, the cost is 2^32: minutes. Use at least 128
bits, shown in groups, and compare all of it.

### F-3 (Low) — notes found with the viewing key alone are never seen spent

`scan` takes the key per call; the state does not record which kind of key scanned a note. A note
found with `incoming_viewing_key()` (`export_scan_key(seed, false)`, offered "for a background
worker, an auditor") is stored with `nullifier: None` and nothing fills it in later. When the
owner continues the same state with the full key and the note is spent on chain, it stays
unspent: the balance is too high and coin selection keeps choosing a spent note, which the node
refuses. No funds are lost.

*Direction.* When `nk` is present, compute the missing nullifier of every stored note before the
page is applied (the note keeps `rho`), or record the key kind in the state and refuse to mix.
Note that spends that happened in pages already scanned without `nk` are only recovered by a
rescan.

Test: `tests/review_wallet_1.rs::rw1_f3_a_note_found_with_the_viewing_key_must_be_seen_spent_by_the_full_key`
— **fails** (balance 5 XRGE, expected 0).

### F-4 (Low) — `tx_hash` is taken from the node unchecked

Every other listing field is fixed-length lowercase hexadecimal. `tx_hash` is any string of any
length; it is copied into the persistent state for each of the wallet's notes and returned by
`summary`. A hostile node can plant markup for a UI that renders it without escaping, or grow the
state by megabytes per note (the test stores a 100,028-byte value).

*Direction.* Require 64 lowercase hexadecimal characters (or empty) in `scan`.

Test: `tests/review_wallet_1.rs::rw1_f4_a_listed_tx_hash_that_is_not_a_hash_must_not_reach_the_stored_state`
— **fails**.

### F-5 (Low) — the hedge against a repeating generator stops at the prover

Spec §5.6 item 4 and W-7 hedge the blinding seed so that "a generator that repeats does not repeat
the masks". The builder draws `r`, the dummy secrets and the ML-KEM randomness from the same
generator with no hedge, and the only sanity check is "not all zero". With a generator that
repeats (the case the hedge exists for — a restored VM snapshot, a broken `crypto` polyfill):

* a payment to the wallet's **own** address (every `plan_merge`) encapsulates twice to the same
  `ek` with the same randomness: one AES-256-GCM key, the fixed zero nonce, two messages. The two
  ciphertexts XOR to `value_1 ⊕ value_2` for anybody who reads the chain (first test);
* `r` is the same for every output the wallet ever makes. `r` is what a payee is given, so any
  payee can confirm guesses of the sender's change — and of every other note the sender created —
  against the public commitments (second test confirms the change value).

The proof stays hidden in both cases; the transaction leaks around it. Dummy nullifiers repeat
too, which makes the node refuse the second such transaction — a fail-safe, but only from the
second transaction on.

*Direction.* Hedge the builder the same way: derive every random value of a transaction from
`H(OS entropy ‖ sk ‖ the input notes ‖ a label ‖ a counter)`. Independently, derive the note key
with the commitment in the HKDF `info` (a spec change, §3.4), so that a repeated encapsulation can
never give one key for two notes.

Tests: `src/review_wallet_1_tests.rs::rw1_demo_f5_…` (two; they pass, under an injected generator
that no caller of the crate can supply).

### F-6 (Low) — error messages quote secret input

The exports forward `serde_json`'s error text. For a value of the wrong type that text quotes the
value. `JSON.stringify(JSON.stringify(scanKey))` — encoding twice, a common JavaScript slip — makes
`scan` return a 5,058-byte error that contains the viewing key and `nk`; a twice-encoded state
makes `summary` return every note's value and `r`. Errors are what applications log and send to
crash reporters.

*Direction.* Return a fixed text plus line and column for parse failures of `state_json` and
`scan_key_json`; never the `serde` message.

Test: `core/shield-v2-wasm/tests/review_wallet_1.rs::rw1_f6_an_error_message_must_not_quote_secret_input`
— **fails**.

### Info

| # | Item | Where |
|---|---|---|
| I-1 | `BuiltTx.witness` and `UnprovenTx.witness` are public fields holding `sk`; nothing needs the witness after `prove()`. `SpendWitness` is `Clone`. Drop the field from `BuiltTx` | `tx.rs:80, 95`; `prover.rs:87` |
| I-2 | Wiping is best effort beyond what the notes list: moving an `InputWitness` out of a `Vec` (`tx.rs:197–199`) leaves `sk` in the freed buffer; `prove_trace_seeded` takes the seed by value and `rngs` keeps a third generator (`verifier.rs:131–136, 267`); `ScanKey.nk` and the decoded `dk` in `api.rs:122` are not wiped; `export_scan_key` returns `dk` and `nk` in an ordinary string. It matters for memory dumps and, in WebAssembly, for anything that can read the instance's memory — which could also read the seed. Proving in a worker that is terminated (already recommended) is the real mitigation | — |
| I-3 | `OutputRecord` derives `Debug` and prints `r`; it is also returned to JavaScript by every `build_*`. `r` plus the value lets its holder prove or test the note — treat the outgoing record as secret | `tx.rs:61–69`; `api.rs:209` |
| I-4 | No upper bound on `fee`: a UI error burns up to the whole input (`fee = total − amount` is accepted). A sanity ceiling in the core would cost nothing | `tx.rs:141–146` |
| I-5 | `ScanKey::from_parts` cannot check that `nk` and `dk` belong to `pk`; a wrong `nk` silently never marks spends | `keys.rs:159–167` |
| I-6 | `tip_height` defaults to 0 when the node omits it, so `at_tip` is then always true | `store.rs:102–103, 532` |
| I-7 | Cost: `scan` clones the whole state per page and the wasm `scan` parses and re-serialises it per page; every appended leaf costs 32 comparisons per tracked note. Somebody who pays 1 XRGE per two dust notes can grow a victim's state by about 2 kB per note and slow its scan | `store.rs:456`; `api.rs:135–139` |
| I-8 | The shielded address is the same on every network (no network in the prefix); a transaction is not replayable across networks (the chain tag is in the body) | `keys.rs:19` |
| I-9 | Privacy, not written down anywhere: (a) `expiry_height` is public and caller-chosen — different clients or build times are distinguishable; fix it as "anchor height + a constant"; (b) the `since` of each listing request tells the node exactly how far a client has synced, which links a client across network addresses and links its scan to the anchor of the transaction it later sends through any route; (c) a shield's note value is public (`v_in − fee`), so a later unshield of the same amount is linkable (spec §6 says this only for "few users"); (d) a self-merge followed by a payment is a visible two-step pattern | spec §6; `NOTES.md` §6 item 5 |
| I-10 | `bip39_seed` / `from_phrase` do not check the word list or checksum (documented); the wasm surface rightly exposes the seed entry only | `keys.rs:38` |

---

## 2. Prover randomness (spec O-14)

Read: `core/shield-v2/src/prover.rs` (whole), `verifier.rs` (`rngs`, `production_config`,
`prove_trace_seeded`, the test prover), `lib.rs` (module visibility per feature), both
`Cargo.toml`, the workspace manifest, and the pinned library's `MerkleTreeHidingMmcs`.

**Construction.** `seed = Blake3-keyed(key = 32 bytes of getrandom; domain ‖ counter ‖ 216
public-input bytes ‖ the whole witness)`; one `getrandom` call per proof; an error or 32 zero bytes
is `ProveError::Entropy`; no other source. The seed feeds `StdRng::from_seed`, from which two
independent generators are forked (leaf salts, PCS masks); cloning the hiding MMCS for the FRI
trees forks its generator again (`hiding_mmcs.rs:84–93`), so no two commitments share a salt
sequence.

**Is every proof's blinding unpredictable to someone who sees the proof and the public inputs?**

* *Working generator:* yes — the seed is a keyed hash under 256 fresh secret bits.
* *Stuck or low-entropy generator, attacker knows its output:* the seed is then a plain hash of
  `counter ‖ public ‖ witness`. It is unpredictable exactly as long as the witness contains
  something the attacker does not know. For a transfer or unshield that is `sk` (≈ 248 bits):
  safe. For a shield the witness holds no long-term secret; the unknown part is the recipient's
  `pk` (≈ 248 bits, not public on chain): the seed can be recomputed only by someone who already
  guesses the recipient, who then learns nothing new. **So the hedge buys this and no more: the
  blinding is never weaker than the secrecy of the witness itself.** That is the right property.
* *Same witness, same entropy, counter reset by a restart:* the seed repeats only if the public
  inputs and the whole witness repeat too, i.e. for the identical transaction — identical proof
  bytes, which reveal nothing. Any difference (another expiry, another `r`, another recipient)
  changes the hash input. Two different witnesses under one seed — the dangerous case of spec
  §5.6 — would need a Blake3 collision.
* *Does mixing the witness in leak it?* No: the seed is used only as a ChaCha key; what a proof
  shows of it (leaf salts) is ChaCha output.

What the hedge does **not** cover is everything outside the prover — F-5.

**Can a caller-chosen or fixed seed reach a production build?** No path was found.

* `prove_spend(witness, public)` has no seed parameter; `prove_trace_seeded` is `pub(crate)`;
  the seeded `verifier::prove_spend` exists only under `test` / `test-prover`; `trace` and
  `witness` are private without `test-prover`; the entropy test hook is `#[cfg(test)]` of the
  prover crate's own unit tests and is not compiled into dependents.
* Feature unification, checked with `cargo tree -e normal,build,features`: the wasm crate on
  `wasm32-unknown-unknown` resolves `quantum-vault-shield-v2` with `default` + `prover` only;
  the daemon alone resolves `default` only; `--workspace` (normal and build edges) adds `prover`
  to the daemon's copy (documented) and **not** `test-prover`. `test-prover` comes in only through
  the daemon's dev-dependency, i.e. in test builds. Even then the wallet and wasm sources never
  call a seeded function, and `test-vectors` only adds functions — `build_shield`,
  `build_transfer`, `build_unshield` use `OsEntropy` under every feature combination.
* **`getrandom` on wasm32 is Web Crypto.** `getrandom 0.2.17` with features `js`, `js-sys`,
  `wasm-bindgen`; no `custom` feature anywhere in the tree; `getrandom 0.4` is not in the wasm
  crate's dependency tree. The built `.wasm` (2,220,849 bytes, built here) imports
  `crypto.getRandomValues` (browser), `crypto.randomFillSync` (Node) and `msCrypto`; it contains
  no `__getrandom_custom` and no `Math.random`.

**Not zeroized:** see I-2. Nothing there changes the verdict.

---

## 3. Checked and found sound

Each line was attacked; the tests named are in this review unless marked *(existing)*.

**Keys**
* Domain separation from the same phrase: account key `HKDF(seed, info "rougechain-ml-dsa-65-v1")`
  (`packages/core/src/mnemonic.ts:17, 43`), shield `sk` / viewing key `HKDF(seed, info
  "rouge-shield/sk" | "rouge-shield/view")`, messaging key `SHA-512(phrase ‖ "|rougee-gram|kem-v1")`
  (`messaging-keys.ts:36`), Base key BIP-32 `m/44'/60'/0'/0/0` (`evm-wallet.ts`). Four different
  constructions or labels; none is derivable from another. `"rouge-shield"` labels are used by no
  client package and no other crate.
* Reduction of a 64-bit word mod p: bias below 2^-33 per element.
* The scan key is not the spending key: `dk` and `sk` are independent HKDF outputs, `nk = H(1; sk)`
  and `pk = H(2; sk)` are one-way, and a dummy input cannot publish a victim's nullifier (the
  statement derives `nk` from a witness `sk` for dummies too). With `nk` a scan-key holder sees
  when the wallet spends and its change, hence amounts paid; it never sees recipients. With `dk`
  alone: incoming notes only. (`rw1_sound_the_scan_key_does_not_contain_the_spending_key`.)
* **ML-KEM against `@noble/post-quantum` 0.5.4 — 53 of 53 checks pass** (section 5).

**Note encryption**
* One key per note with working entropy: a fresh 32-byte encapsulation per output, a one-shot
  generator that refuses a second read; the fixed-randomness entry is behind `test-vectors`.
* `aad = cm_out`: a ciphertext pair moved under another commitment, either part replaced, or one
  bit changed does not open *(existing `roundtrip_and_every_binding`; listing test here)*.
* A hostile sender cannot burn or inflate: a note that opens but does not recompute to the listed
  commitment under the wallet's own `pk` and the chain-derived `rho` is not credited — wrong value,
  non-canonical `r` (test). `rho` and the position come from the chain, so "a note the wallet
  accepts but cannot spend" does not exist for a note that is on the chain.
* No oracle for a node: "not mine" and "mine but invalid" are the same silent outcome; ML-KEM
  rejects implicitly; the tag comparison is constant-time. What differs is local CPU time by
  microseconds.
* What a recipient learns about the sender: the value, `r`, the transaction — nothing that
  identifies the sender, and it cannot recognise the note's later nullifier.

**Scanning and state**
* Skipped, duplicated, reordered transactions, swapped outputs, wrong leaf positions, bad
  heights: refused, state untouched. Renumbered listings and forged commitments: accepted but the
  root differs from the chain's and no value is added. Wrong nullifiers, replaced ciphertexts: the
  note is hidden. Invented spends: no effect — a node cannot name the nullifier of an unspent note.
* A tampered state blob: 4,000 mutations, each followed by every read path, selection, a transfer
  assembly and two scans — no panic. A tampered blob can show a wrong balance (there is no
  integrity value in it; the caller encrypts it, and should authenticate it); it cannot produce a
  valid spend of a note that is not in the tree (`AnchorMismatch`).
* The state blob holds note values, `r`, `rho` and nullifiers — no `sk`, `nk`, `dk` or seed (wasm
  test).

**Transaction building**
* **Every one of the 2,546 body bytes is bound by the proof** — chain tag, expiry, anchor,
  nullifiers, commitments, amounts, the unshield's recipient account, all four ciphertexts; the
  ciphertexts cannot even be swapped between slots (`rw1_sound_every_byte_of_the_body_is_bound_by_the_proof`,
  one real proof). A relay therefore cannot substitute ciphertexts, so the "recipient loses the
  note" griefing does not exist for a relay; only the sender can write an unreadable ciphertext
  (spec §3.4 says so).
* The signer-less envelope is fully pinned by the node (`daemon/src/shield_v2.rs:371–397`, read; its tests were run, section 6):
  version, empty key and signature, nonce 0, no `signed_payload`, fee bits of `0.0`, no other
  payload field.
* Value conservation from the user's side: payment + change + fee = inputs for every split tried;
  the change opens for the sender only and the payment for the recipient only; self-payment
  returns both outputs; `fee = v_in`, zero amounts, sums above 2^64, the same note twice, another
  wallet's keys and an edited note value are refused (`rw1_sound_value_conservation_…`).
* Dummy inputs, dummy output keys, `r`, encapsulations and slot order are drawn per transaction
  from the operating system *(existing `every_build_draws_fresh_randomness`; `rw1_sound_working_entropy_…`)*.
* Anchor: the builder insists that every input's path leads to the given anchor. Expiry: any
  value is accepted, but the anchor window bounds a transaction's life to 128 blocks regardless.
  *(Correction added 2026-10-06, not by the reviewer — REVIEW_WALLET_2 I-1: the last clause is
  false. The anchor window is a set of root VALUES and a block without V2 transactions repeats
  the root, so in an idle pool an anchor stays accepted indefinitely. Only `expiry_height` bounds
  a transaction's life; the builders and `mark_pending` enforce "at most 128 blocks above the
  anchor's height" for exactly that reason. Spec §4.3 item 8 and §5.5 now say so.)*

**WASM surface**
* Several hundred malformed calls return coded errors *(existing)*; nothing logs (no `console`
  import, no `println`); no returned JSON and no error of the spending calls contains `sk`, `nk`,
  `dk` or the seed (`rw1_sound_no_key_material_…`, with a real proof); a scan key of the wrong
  wallet is refused and mixed parts credit nothing.

---

## 4. Out of reach

* Nothing was run **as WebAssembly**: no `wasm-bindgen-cli` here and nothing may be installed.
  The `.wasm` was built and its imports read; the surface was tested natively. Trap behaviour on
  allocation failure, and `getRandomValues` in a real browser or worker, are untested.
* The **zero-knowledge of the hiding mode** itself (the pinned library) — outside this review, as
  spec §6 says.
* **Timing side channels** were reasoned about, not measured.
* The TypeScript clients do not use this crate yet; F-1, F-7 and I-9 are about what they must do.
* Qwalla / native targets: not built.

---

## 5. Cross-check against `@noble/post-quantum`

`core/shield-v2-wallet/tests/noble_crosscheck.mjs`, run read-only with
`NOBLE_ROOT=/home/cyberdreadx/qv-containment/node_modules` (`@noble/post-quantum` 0.5.4,
`@noble/hashes`, Node 22.12 for AES-256-GCM). **53 of 53 checks pass**, for both vector wallets:

* BIP-39 seed; `sk` HKDF output, its eight elements mod p and its 32 bytes; the viewing-key HKDF
  output, `d`, `z`;
* **`ml_kem768.keygen(d ‖ z)` gives byte-for-byte the committed `ek` and `dk`**;
* a fresh noble encapsulation opens with the Rust-derived `dk`;
* `encapsulate(ek, m)` with the vector's `m` gives the committed `kem_ct` and shared secret;
  `decapsulate(kem_ct, dk)` gives the same secret; HKDF (zero salt and no salt) gives the
  committed AES key; AES-256-GCM opens and re-seals the committed `note_ct`; a wrong `aad` and
  the other wallet's key do not open;
* in `transactions.json`, exactly the (wallet, slot) pairs the file names open, to the recorded
  value and `r`.

This closes the "not cross-checked against `@noble/post-quantum`" item of `NOTES.md` §7.

---

## 6. Tests added and commands

| File | Tests | Result on abab9a8 |
|---|---|---|
| `core/shield-v2-wallet/tests/review_wallet_1.rs` | 11 | 8 pass, **3 fail on purpose** (F-2, F-3, F-4) |
| `core/shield-v2-wallet/src/review_wallet_1_tests.rs` (included from `tx.rs` under `cfg(test)`) | 3 | 3 pass |
| `core/shield-v2-wasm/tests/review_wallet_1.rs` | 3 | 2 pass, **1 fails on purpose** (F-6) |
| `core/shield-v2-wallet/tests/noble_crosscheck.mjs` | 53 checks | 53 pass |

The only change to non-test source is six lines (a comment and the include) at the end of `core/shield-v2-wallet/src/tx.rs`
that include the in-crate test module under `#[cfg(test)]`.

**`cargo test` on these two crates now exits non-zero** because of the four regression tests.
That is intended; they are named `rw1_fN_…` and each says "FAILS on abab9a8" in its comment.

Every cargo command ran as `systemd-run --user --scope -q -p MemoryMax=2500M -p MemorySwapMax=0
-p CPUWeight=10 nice -n 19 cargo …`, one at a time, `--release --locked --offline -j 1`
(`cargo tree` has no `-j`):

| Command | Result |
|---|---|
| `cargo tree -p quantum-vault-shield-v2-wasm --target wasm32-unknown-unknown -e normal,build,features -i getrandom@0.2.17` | features `default`, `js`, `js-sys`, `wasm-bindgen`; `-i getrandom@0.4.3`: not in the tree |
| `cargo tree … -i quantum-vault-shield-v2` for the wasm crate, the daemon, `--workspace` | `default`+`prover`; `default`; `default`+`prover` |
| `cargo test -p quantum-vault-shield-v2-wallet --features test-vectors --no-fail-fast -- --test-threads=1` | 36 tests: 33 pass, 3 fail (the three above) |
| `cargo test -p quantum-vault-shield-v2-wasm --no-fail-fast -- --test-threads=1` | 5 tests: 4 pass, 1 fails (F-6) |
| `cargo test -p quantum-vault-shield-v2 --features test-prover --lib -- prover::` | 4 pass |
| `cargo test -p quantum-vault-shield-v2 --features test-prover --test prover` | 4 pass, 1 ignored (the measurement) |
| `cargo build --target wasm32-unknown-unknown -p quantum-vault-shield-v2-wasm` | builds; 2,220,849 bytes |
| `cargo test -p quantum-vault-daemon -- node::shield_v2_wallet_interop_tests --test-threads=1` | 4 pass (the node accepts the wallet's transactions, refuses every changed body field, reads the committed vectors) |
| `cargo test -p quantum-vault-daemon -- shield_v2::tests:: --test-threads=1` | 6 pass (the node's envelope and body rules, including the pinned signer-less envelope) |
| `node core/shield-v2-wallet/tests/noble_crosscheck.mjs` | 53 of 53 |

---

## Resolution (2026-10-06)

Written by the author of the fixes, not by the reviewer. Everything above is the review as it was
delivered and describes `abab9a8`; where it says a test "fails" or "passes: design limit", that is
the state it found. **The fixes below have not been reviewed by a second person.**

| Finding | Resolution | Commit | Test now |
|---|---|---|---|
| F-7 | Pending transactions are in the state (nullifiers, input notes, expected change, expiry). Inputs are locked from `mark_pending` until the scanned chain shows a nullifier (mined) or a scanned height at or above `expiry_height` without one (`resolve`). A node's "rejected" sets a hint only. The builders require `anchor_height < expiry_height ≤ anchor_height + 128`, default `+ 64`; `mark_pending` re-checks the bound against the scanned height. `ReleasePolicy::Confirmed` releases only at a height a quorum confirmed. State format 2, format 1 migrated | `b96f480` (core), `6975c2c` (wasm), `539fb55` (node interop) | `rw1_f7_a_claimed_rejection_does_not_release_the_inputs_and_funds_are_intact_either_way` (was `rw1_demo_f7_…`), `rw1_f7_a_format_1_state_is_migrated_with_its_local_marks_kept_as_locks` |
| F-1 | Not fixable in the wallet alone: one node's listing cannot be authenticated without a light client. Reduced: notes are `unverified` until `confirm_roots` matches the wallet's root against a caller-set quorum of distinct nodes (default 2; one node ⇒ unverified); confirmed and unverified balances are separate; coin selection ignores unverified notes unless asked. Spec §5.4 has the normative UI rule; `NOTES.md` no longer says "cannot forge" | `b96f480`, `6975c2c`, `539fb55`, `d2a8fa5` (spec) | `rw1_f1_a_forged_incoming_note_stays_unverified_and_is_not_spent_by_default` (was `rw1_demo_f1_…`), `rw1_f1_two_agreeing_nodes_confirm_notes_up_to_the_matched_height_only` |
| F-2 | Address text = bech32m(`rshield`, `0x02 ‖ pk ‖ ek ‖ check`), 1,974 characters; `check` = 8 bytes of domain-tagged SHA-256, verified on decode; the first form is refused by name. `keys.json` regenerated | `b5fe565` | `rw1_f2_…` passes |
| F-3 | Both directions: nullifiers seen while a note has none are remembered (≤ 1,024) and applied when `nk` arrives; if more appeared, `scan` returns `RescanRequired` and changes nothing | `b96f480` | `rw1_f3_a_note_found_…` passes; `rw1_f3_spends_seen_without_nk_are_applied_when_the_full_key_arrives_or_a_rescan_is_demanded` |
| F-4 | `tx_hash` must be 64 lowercase hex, `tx_type` a V2 type, before anything is stored; page ≤ 32 MiB / 4,096 transactions; `tip_height` required (I-6) | `b96f480` | `rw1_f4_…` passes (extended) |
| F-5 | One hedged generator per transaction (HMAC-SHA256 keyed by 32 OS bytes over tag, counter, `sk`, the transaction's inputs and outputs; HKDF-Expand per label, slot, draw number). Entropy failure is still an error. The §3.4 note-key derivation is unchanged (the review's second suggestion was not taken: it would change the format) | `b96f480` | `rw1_f5_a_repeating_generator_no_longer_reuses_the_note_key_or_r`, `rw1_f5_a_repeating_generator_no_longer_gives_the_payee_the_r_of_the_change_note` (were `rw1_demo_f5_…`) |
| F-6 | No error text quotes input: fixed sentences; JSON failures give category, line, column | `b96f480` (core), `6975c2c` (wasm) | `rw1_f6_an_error_message_must_not_quote_secret_input` passes; `rw1_f6_no_error_of_the_surface_ever_contains_a_marker_from_its_input` |
| I-1 | `BuiltTx` has no witness; `UnprovenTx.witness` is private and dropped when the prover returns. `SpendWitness` is still `Clone` (not changed) | `b96f480` | — |
| I-2 | No heap buffer holds a witness; seed passed by reference to `prove_trace_seeded`; `ScanKey` wipes `nk`; the wasm surface wipes the decoded and hex `dk`. Not wiped: the by-value seed inside `production_config`/`rngs` (shared with the node's verifier, not touched) and the library's generators | `b041a81`, `b96f480`, `6975c2c` | — |
| I-3 | Redacted `Debug` for `OutputRecord`, `OwnedNote`, `PendingTx`, `PendingChange`; the wasm result still returns `r` (documented as secret) | `b96f480` | in `rw1_sound_every_byte_…` |
| I-4 | `max_fee` on the three builders; default 10 × the minimum fee | `b96f480` | `builder_refusals` |
| I-5 | Not fixable (`nk` and `pk` are unrelated one-way images); documented on `ScanKey` | — | — |
| I-6 | `tip_height` required; `next_height` may not exceed tip + 1 | `b96f480` | `rw1_f4_…` |
| I-7 | `scan` validates, then applies in place (no clone); wasm serialises the state once and has `scan_pages`; zero-value notes are not stored. Non-zero dust is still stored | `b96f480`, `6975c2c` | — |
| I-8, I-10 | Unchanged | — | — |
| I-9 | Documented: spec §5.8, `NOTES.md` §10. Nothing enforced except the default expiry offset | `d2a8fa5` | — |
| (asked with the fixes) | Compile-time guard: the daemon does not compile with the `prover` feature unified in | `b041a81` | `cargo check -p quantum-vault-daemon -p quantum-vault-shield-v2-wallet` fails at the assertion |

**Commands run after the fixes**, each as `systemd-run --user --scope -q -p MemoryMax=2500M -p
MemorySwapMax=0 -p CPUWeight=10 nice -n 19 cargo … --release --locked --offline -j 1`:

| Command | Result |
|---|---|
| `cargo test -p quantum-vault-shield-v2-wallet --features test-vectors --no-fail-fast -- --test-threads=1` | 40 passed, 0 failed, 0 ignored (17 unit incl. 3 `rw1_*`; `review_wallet_1` 14; `vectors` 3; `wallet_flow` 6) |
| `cargo test -p quantum-vault-shield-v2-wasm --no-fail-fast -- --test-threads=1` | 6 passed, 0 failed, 0 ignored (`api` 2; `review_wallet_1` 4) |
| `cargo test -p quantum-vault-shield-v2 -- --test-threads=1` | 35 passed, 0 failed |
| `cargo test -p quantum-vault-shield-v2 --features test-prover -- --test-threads=1` | 71 passed, 0 failed, 1 ignored (the timing measurement, as before) |
| `cargo test -p quantum-vault-daemon -- node::shield_v2_wallet_interop_tests --test-threads=1` | 4 passed |
| `cargo test -p quantum-vault-daemon -- node::shield_v2_daemon_tests --test-threads=1` | 9 passed |
| `cargo test -p quantum-vault-daemon -- node::shield_v2_review_node_1_tests --test-threads=1` | 5 passed |
| `cargo test -p quantum-vault-daemon -- shield_v2::tests --test-threads=1` | 6 passed |
| `cargo build --target wasm32-unknown-unknown -p quantum-vault-shield-v2-wasm` | builds; 2,432,370 bytes |
| `cargo build -p quantum-vault-daemon` | builds |
| `cargo tree -p quantum-vault-daemon -e normal,build,features -i quantum-vault-shield-v2` | `default` only |
| `NOBLE_ROOT=… node core/shield-v2-wallet/tests/noble_crosscheck.mjs` | 53 of 53 |

The shield-v2 and daemon runs were made on the working tree just before the last edit to the
wallet crate's `Debug` output for pending records; the wallet and wasm suites were re-run after it.
