# REVIEW_NODE_1 — adversarial review of the shielded pool V2 node implementation (stage 2)

Reviewed: branch `feat/shield-v2-node` @ `38aa788` (stage 2 = `98750be..38aa788`), against
`docs/SHIELDED_POOL_V2_SPEC.md` §3, §4, §9, `core/shield-v2/NOTES.md` items 1–40 and REVIEW2 L-1 /
L-4. The reviewer did not write the code. Method: reading every stage-2 hunk of `core/daemon`,
`core/storage`, `core/types`, `core/crypto` and the stage-1 `pool.rs` / `verifier.rs`, following each
call into the pre-existing daemon paths it touches (import, mempool, producer, snapshot/restore,
init, state root, receipts, indexer, HTTP), then writing tests for every candidate defect that
could be demonstrated without a prover. Nothing was run against any network; builds and tests ran
only in this worktree under the required resource wrapper.

## Verdict

**No way was found for a block or transaction to steal, create or lock value, to double-spend, or
to make two honest stage-2 nodes disagree.** The consensus core — the L-1 nullifier rules, the
append-only tree, the all-or-nothing block apply, the O(1) snapshot/restore of the pool store, the
state-root section, the pre-activation identity of the state root — is sound as far as reading and
the tests here can tell. The findings are: one **Medium** operational consensus hazard inherent in
the spec's own pre-activation rule (R1-1), one **Medium** resource issue in mempool admission
(R1-2), and Low / Info items (producer liveness, envelope malleability, mempool bytes, a
defence-in-depth arithmetic, endpoint cost). None of them is a reason to withhold the branch from
further work; R1-1 must be settled in the activation runbook before any validator runs the build on
mainnet, and R1-2 / R1-3 should be fixed before testnet activation.

Nothing is deployed and activation is `None` everywhere; **pre-activation, the only behavioural
differences from `origin/main` found are the intended refusals of R1-1 and the Info items in §4.**

## 1. Findings

Severity: Critical / High / Medium / Low / Info. "Test" names the test added by this review;
`FAILS` means the test asserts the behaviour the finding asks for and fails on `38aa788`.

### R1-1 — Medium — Pre-activation refusal of the bare V2 *type names* splits upgraded from non-upgraded nodes

* Where: `core/daemon/src/shield_v2.rs:285-297` (`shield_v2_tx_rule`, check 1 → `NOT_ACTIVE_ERROR`
  for any tx whose `tx_type` is a V2 name, with or without the payload fields), called at import
  from `core/daemon/src/node.rs:1591-1597`.
* What: the spec (§3, first paragraph) requires a block carrying a V2-typed transaction before A to
  be invalid, and the implementation does exactly that. But a pre-stage-2 node has **no rule that
  refuses an unknown type name**: `fee_and_type_sanity` (node.rs:439) refuses only `slash`,
  `SUSPENDED_TX_TYPES` (node.rs:428) does not list the V2 names, and `apply_balance_tx_inner`
  has a `_ => {}` arm (node.rs:7746, 7933, 8401). A validly signed transaction of type `shield_v2`
  with an empty payload is therefore admitted to an old node's mempool, included by an old-build
  producer, and applied by every old node as a no-op (the block is valid, the state root
  matches). A stage-2 node refuses that block as a whole. Anyone with access to a broadcast
  endpoint (every node operator; the public route is nginx-blocked) or any validator still on the
  old build can create this block, and once it exists upgraded and non-upgraded validators are on
  different chains below A.
* Why this is broader than the TOKEN_MINTING precedent: the payload *fields* need a CLI-envelope
  `signed_payload` to survive an old node's deserialisation with a valid signature (the old node
  drops the unknown fields), whereas a bare type name needs nothing.
* Test: `node::shield_v2_review_node_1_tests::review_r1_1_bare_v2_type_names_pass_every_pre_stage_2_rule`
  (documenting, passes): the three bare types pass signature, fee/type sanity,
  MONETARY_INTEGRITY, GAME_READY, TOKEN_MINTING, royalty cap and binding, and only
  `shield_v2_tx_rule` refuses them.
* Recommendation: the spec itself defers this to the activation runbook (§3) and NOTES item 39
  records that the runbook text does not exist yet. Either (a) gate the *type-name* refusal on a
  separate rollout height R ≤ A that every validator has passed before the build is installed (the
  chain's convention for rules old nodes would not apply), or (b) write the runbook rule now: all
  validators install stage 2 in one window, and until then no node operator broadcasts a `*_v2`
  type. Decide before any mainnet validator runs this build; not a code defect per spec.

### R1-2 — Medium — Mempool admission verifies the proof before every cheap refusal; no negative cache

* Where: `core/daemon/src/node.rs:2572-2575` (`insert_tx_to_mempool` runs
  `shield_v2_admission_checks` — whose last step is `verify_proof`, node.rs:5715-5740 — before the
  replay check at 2576, the mined-hash check at 2582, the mempool dedup at 2590 and the
  mempool-full / fee-priority check at 2595); `core/daemon/src/shield_v2.rs:535-543`
  (`verify_proof`: only accepts are cached).
* What: after activation, an unauthenticated peer (P2P relay or `/api/tx/broadcast`) can make the
  node run a ≤ 14 ms / ≤ 4.5 MiB proof verification per message with nothing but a well-formed
  body: checks 1–18 need no funds for a transfer (anchor from `/api/shield-v2/stats`, random
  nullifiers, any `fee ≥ 1 XRGE`, `expiry = u64::MAX`), and the refusal is never cached, so the
  same garbage transaction re-sent costs the same again. A V2 transaction has envelope fee `0.0`
  and can **never** enter a full mempool (`tx.fee <= min_fee`), yet with a full mempool every such
  message is still verified first. Cost per byte is about 2–3× an ML-DSA-65 signature flood
  (≈ 70 µs/KB against ≈ 30 µs/KB), plus the allocation; on the 2-core production host this is
  about one core per ~15 MB/s of hostile input. Bounded by bandwidth only.
* Test: `node::shield_v2_review_node_1_tests::review_r1_2_mempool_full_is_judged_only_after_the_proof_was_verified`
  — **FAILS**: with `MAX_MEMPOOL` ordinary transactions queued, a funded, well-formed shield with
  a garbage proof is refused with `shield_v2: proof refused (…)` (verification ran) instead of
  `Mempool full`.
* Recommendation: in `insert_tx_to_mempool`, move the replay / mined-hash / dedup / mempool-full
  checks (or a cheap pre-check of them) ahead of `shield_v2_admission_checks`; add a small bounded
  negative cache keyed by `compute_single_tx_hash` for refused proofs (node-local, consensus is
  unaffected: a refusal is deterministic for the same bytes). Consider a per-peer budget for V2
  verifications.

### R1-3 — Low — The producer silently drops valid, admitted V2 transactions beyond the eighth

* Where: `core/daemon/src/node.rs:5742-5790` (`shield_v2_select_for_block`; 5767-5768: `kept.len() >= 8 →
  Err("per-block limit reached")`, the entry is left out of `out`), node.rs:3734 (`mine_pending`
  drains the whole mempool), 3775 (`requeue` is the post-selection list; on success nothing is requeued).
* What: the ninth and later valid V2 transactions of a production round are neither sealed nor
  returned to the mempool. Each cost its wallet 3–7 s of proving; the wallet must notice and
  rebroadcast. Also the pre-selection filters drop invalid ones — fine — but the limit is not an
  invalidity. Node-local liveness only; no consensus effect.
* Test: `node::shield_v2_review_node_1_tests::review_r1_3_producer_drops_valid_v2_transactions_beyond_the_block_limit`
  — **FAILS**: nine admitted shields (proofs primed in the verify cache), one block of 8 produced,
  mempool left with 0 instead of 1.
* Recommendation: return the "limit reached" entries (and only those) from
  `shield_v2_select_for_block` for requeueing.

### R1-4 — Low — `version` is a free, identity-changing field of the signer-less envelope

* Where: `core/daemon/src/shield_v2.rs:314-318` (check 2 pins `from_pub_key`, `sig`, `nonce`,
  `signed_payload`; `tx.version` is not examined for the signer-less types);
  `core/types/src/lib.rs:353-369` (`tx_identity` covers `version`), `:371` (`compute_single_tx_hash`).
* What: a relay can change `version` on a `shielded_transfer_v2` / `unshield_v2` in flight. The
  body and proof are untouched, so every consensus rule still accepts it and the chain applies
  exactly the sender's intent — but under a different `tx_identity` (uniqueness index), mempool
  key, receipt key and verify-cache key. Consequences: the wallet cannot find its transaction by
  the hash it computed; the front-run copy wins the nullifier race in the mempool and the original
  is refused as "already spends"; the proof is verified twice. No value effect (nullifiers, not
  identities, prevent double spends — spec §3.1 last paragraph is respected). The spec's envelope
  rule does not mention `version`; the owner may want to add "`version` MUST be 1" to §3.1.
* Test: `shield_v2::tests::review_r1_4_signerless_envelope_version_is_not_pinned` — **FAILS**: a
  signer-less transfer with `version = 2` passes `shield_v2_tx_rule` with the same decoded body and
  proof and a different identity and hash.
* Recommendation: refuse `version != 1` in check 2 for the signer-less types (and arguably for
  `shield_v2`, where it is at least signed).

### R1-5 — Low — Mempool bytes: no shadow of queued shields against the funding balance; entries are ~400 KB

* Where: `core/daemon/src/node.rs:5719-5724` (admission check 19 against the tip balance only),
  node.rs:54 (`MAX_MEMPOOL = 2000`, a count, not bytes).
* What: an account holding 10 XRGE gets any number of 10-XRGE shields admitted (distinct dummy
  nullifiers, increasing nonces, valid proofs — proving is the attacker's only cost, ≈ 5 s each);
  each is ~405 KB in this node's mempool and is relayed to every peer. 2,000 entries ≈ 800 MB per
  node. The producer's shadow (node.rs:5768-5775) and block apply are correct, so this is memory
  and relay bandwidth, not value. The same count-only cap exists for ordinary transactions, but
  those are ~5 KB.
* Test: `node::shield_v2_review_node_1_tests::review_r1_5_mempool_admits_shields_beyond_the_funding_balance`
  (documenting, passes): three 10-XRGE shields admitted against a 10-XRGE balance.
* Recommendation: a byte budget for V2 entries (or for the mempool), and a per-account shadow of
  queued shields at admission like the nullifier scan already done there.

### R1-6 — Low (defence in depth) — Unchecked `u128` addition in the shield cap check

* Where: `core/shield-v2/src/pool.rs:623` — `let t = pool_total + (tx.v_in - tx.fee) as u128;`.
* What: unreachable through the rules (`pool_total ≤ 10^15` is an invariant, every other
  arithmetic in `validate_block` is checked), but spec §4.4 wants the no-overpayment property to
  hold "even if … an implementation were broken". On a corrupt stored `pool_total` the addition
  panics in a debug build and wraps in a release build; the wrapped total passes the cap check and
  the shield is accepted with a tiny `pool_total`.
* Test: `tests/review_node_1.rs::review_r1_6_shield_cap_check_uses_an_unchecked_u128_addition` —
  **FAILS** (release: accepted with wrapped total; debug: panic).
* Recommendation: `checked_add(...).ok_or(PoolError::CorruptState(..))`.

### R1-7 — Low — `GET /api/shield-v2/notes` decodes every proof it lists

* Where: `core/daemon/src/node.rs:5674-5708` (`shield_v2_notes_since` calls `shield_v2_tx_rule`,
  which `hex::decode`s the proof string, for every V2 transaction of up to 256 blocks; the whole
  block JSON is read from sled for each height).
* What: after activation an unauthenticated GET costs up to 256 block reads (≤ 3.3 MB each) and up
  to 2,048 × 200 KB of proof decoding (~400 MB of transient allocation) per call, on a
  `spawn_blocking` thread; concurrent calls multiply it. Pre-activation the handler returns
  immediately (`active: false`). Whether nginx exposes the route is outside this review.
* Recommendation: a body-only parser for the listing (the proof is never needed there), a lower
  `blocks` clamp, and the per-height V2 index that NOTES item 39 already mentions.

### R1-8 — Info — Order of checks at import differs from §3.6 in cost only

* Where: `core/daemon/src/node.rs:1526-1562` (the signature loop, check 14, runs before checks
  1–13 at 1591-1601; `check_block_tx_uniqueness` with the binding at 1580 too). NOTES item 21
  documents 15–18-before-19–20 across transactions.
* What: accept/refuse is identical for every order (all-or-nothing block). Resource: a block from a
  staked validator with a `shield_v2` carrying a 400 KB proof costs one ML-DSA-65 verification
  before the cheap refusals; the 16 MiB HTTP body limit bounds a block to ≤ 39 V2 transactions,
  so ≤ 16 MB of hex decoding before `check_block_limit` refuses. Only a staked validator can make
  the node parse a block at all (proposer signature and validator set are checked first).

### R1-9 — Info — Pre-activation footprint changes that are not behaviour changes

* `ShieldV2Store::new` opens one more sled database (`<data_dir>/shield-v2-db`) at every start —
  a new way for start-up to fail on a read-only or full disk (same pattern as every other store).
* `capture_pre_apply_snapshot` / `restore_pre_apply_snapshot` read / write-nothing-and-fsync the
  pool tree on every block / rejected block (an `apply_batch` of removes of absent keys plus
  `flush()`); a sled I/O error there now fails an import that would have succeeded before.
* `indexer.rs:73-77` no longer indexes an event under an empty `from`. No historical transaction
  has an empty sender (the signature loop refuses one), so the explorer index is unchanged; the
  unshield recipient is not indexed by address either (only `get_address_transactions` finds it).
* `/api/stats` now shows `shield_v2: null`; two new GET routes answer `active: false` / `pool: null`.

### R1-10 — Info — Concurrency note on `shield_v2_pool()`

`shield_v2_pool()` (node.rs:5797) is `open_or_init`: a read that becomes a write of the genesis
record when the store is empty. It is reached from mempool admission concurrently with block
import at the activation height. All interleavings were walked: the genesis record is idempotent,
`restore` removes it when the snapshot predates it, and `Pool::commit`'s `StalePreparation` guard
cannot fire from it (the record is written before `validate_block` loads the base). A mempool
admission that reads the store while a speculative block is committed-but-not-yet-rolled-back
sees `next_height = tip + 2` and refuses the transaction with `HeightOutOfOrder` — node-local,
the sender retries. Not a defect; recorded so nobody "fixes" the ordering.

## 2. What was checked and found sound

Pre-activation identity (activation `None`):
* `shield_v2_tx_rule` returns `Ok(None)` for every transaction without the two fields and not of a
  V2 type (shield_v2.rs:287-293); `check_block_limit` counts zero; `compute_state_root_for_height`
  is byte-identical (author's mainnet-fixture test `state_root_is_byte_identical_before_activation`
  re-read, and the restructured token-mint branch checked by hand); `skips_account_signature` is
  false for every existing type; `shield_v2_select_for_block` returns its input untouched when no
  V2 type is present.
* The store is never written before activation: `snapshot()` reads, `restore()` on an empty
  snapshot only removes absent keys, `shield_v2_stats` / `shield_v2_notes_since` read, and
  `shield_v2_pool()` (the only initialiser) is reached only from active heights or from mempool /
  producer paths that already saw an active-height V2 transaction. Hence
  `shield_v2_store_in_sync` → `is_empty()` is true and **`recover_from_history` is never triggered
  by the pool on a node that never activated** (node.rs:4524-4536). After activation the check
  `next_height == (tip + 1).max(a)` was walked for: clean restart, crash after pool commit before
  chain append (rebuild, deterministic), crash after append before the balance snapshot (rebuild
  by the existing rule), genesis record written early by a mempool admission at `tip = A − 1`.
* No expensive work before activation: check 1 precedes everything at import and at admission; a
  V2-typed or field-carrying transaction is refused before any decoding.

Signer-less envelope (`from_pub_key`, `sig` empty):
* Every sender-keyed path was followed: signature loops (import 1533, P2P 2524, producer 3742),
  `check_nonce_valid` (2552), nonce/address writes (`apply_shield_v2_tx` writes them only for
  `shield_v2`), pre-apply snapshot (4811), receipts (`from = ""`, `status = Success` always),
  indexer, explorer (`is_sender` requires a non-empty key), `tx_identity` (sha256 over the signable
  encoding incl. the payload, so body and proof are in it), `compute_single_tx_hash` (full
  struct), `verified_tx_ids` / `mined_tx_hashes`, `v2_binding` (trivially `Ok` without
  `signed_payload`, which check 2 forbids), fee accounting (`actual_fees_collected += body.fee`;
  the envelope `0.0` is never read; `distribute_fees` burns `min(base/2, collected)` so it can
  never create value), proposer / finality / entropy paths (header key only),
  `apply_identity_for` (empty key never matches). Replay of the same transaction: identity index
  and nullifier set both refuse. Mutation in flight: only `version` is free (R1-4); everything else
  is pinned by check 2 or covered by the proof's `binding`. Eviction: a V2 transaction is the
  first evicted and is refused when the mempool is full — it cannot evict a paying transaction
  (NOTES item 23.8; R1-2 is about the cost before that refusal).
* `shield_v2` with `signed_payload`: the uniqueness rule's binding (node.rs:3958-3977) requires
  the CLI-envelope form whose `payload` must equal `tx.payload` exactly, so body and proof are
  inside the signed bytes; a non-envelope `signed_payload` fails `derive` (no `shield_v2` arm) and
  invalidates the block. The substring coverage check in `shield_v2_tx_rule` is redundant but
  harmless.

Double-spend / value:
* Nullifier rules 2a/2b/2c in `validate_block` (pool.rs:589-615) against the set after the
  preceding transactions of the block; both nullifiers inserted for all three types; never pruned
  except by `restore` to a pre-block snapshot (storage `restore`, index-range based, exact:
  storage tests + author's daemon test `rollback_restores_the_pool_store_exactly`); insertion
  atomic with the leaves and the metadata (one `apply_batch`); the balance side is in the same
  pre-apply snapshot. The only writer of leaves is `Pool::commit` from `validate_block`
  (`ShieldV2Store::commit` has no other call site); `recover_from_history` clears and replays.
* Conservation per type (shield: −v_in / +(v_in − fee) / fee; transfer: −fee / fee; unshield:
  −(v_out + fee) / +v_out / fee) checked by reading and by the author's supply test; `pool_total`
  cannot exceed the cap (only shields add, each refused if it would); `pool_total` never below
  zero (`checked_sub`); u64 extremes probed (`extreme_u64_amounts_are_refused_by_the_right_rule_and_never_panic`).
* Unshield credit: `address_from_hash(account)` is the `rouge1` bech32m of the 32 bytes, the same
  function `canon_addr` → `pub_key_to_address` uses for balance keys, so it lands on exactly the
  account whose pubkey hashes to `account` and can never be `__treasury__`, `__staking_rewards__`
  or `BURN_ADDRESS` (none is a `rouge1` string). The recipient is inside the body, hence inside
  `binding`, hence inside the proof.
* Shield funding: `bal ≥ v_in` against the balances after the preceding transactions of the block
  (ordinary and V2), fee inside `v_in` (§3.5); the account signature covers the payload in both
  signing formats.

Consensus divergence:
* No floats in any V2 rule (`fee.to_bits()` compare only); no `HashMap` iteration in consensus
  paths (producer only); error kinds never enter blocks, receipts or roots (`drop_v2` string match
  is producer-local); the verify cache is keyed by the full-struct hash (body + proof + type +
  version), only accepts are cached, the verifier is deterministic, so a cache hit equals a
  verification; `PublicInputs::from_bytes(..).expect(..)` in `public_inputs()` cannot panic
  (the five digests were checked canonical, `binding` is reduced mod p); `quick_nullifiers`
  slices a `&str` at byte offsets but only ever on queued transactions that passed `is_lower_hex`
  (ASCII), so no char-boundary panic is reachable.
* Anchor window: membership by value with repeats (NOTES 12), `R(H)` appended for every block
  from A including empty ones (`apply_balance_block` is the only path to `append_block` for both
  import and production; there is no separate heartbeat path), initial `[E_32]`, window of H =
  roots after H−128..H−1 exactly (`window_len ≤ 128` after removal of the oldest).
* State-root section: tag (33 bytes), `field(root_before)`, u128/u64 BE, 32 frontier slots with
  the §4.8 zero rule (`Tree::append` clears carried slots), running `nullifier_acc` with its tag,
  `window_len` then the window oldest first — matches §4.8 byte for byte (pool.rs:165-190). Read
  from the committed state after the block, applied last after the mint-ledger extension.
* Store behind/ahead: `HeightOutOfOrder` refuses the block → the node stalls rather than diverges;
  recovered at restart by `shield_v2_store_in_sync` → full rebuild.

Resource:
* Largest hostile block: 8 proofs × ≤ 14 ms and ≤ 4.5 MiB each after the limit; the limit is
  checked after hex-decoding every V2 transaction of the block but the 16 MiB body cap bounds that
  (R1-8). Proof length is checked on the string before decoding (check 3), body length before
  hex (check 4).
* Unbounded growth: the nullifier set and leaves grow by design; `VerifyCache` is bounded
  (4,096, cleared); `mined_tx_hashes` bounded (existing); mempool bounded by count only (R1-5).

Spec §3.6 compliance: checks 1–12 in `shield_v2_tx_rule` in spec order on the strings before any
decoding (lengths of 3 and 4, lowercase of 5), 13 at block level, 14 by the existing signature
paths plus coverage, 15–18 in `Pool::validate_block`, 19–20 in `apply_shield_v2_tx`; 8–10 repeated
in the pool. NOTES deviations 9, 20, 21, 24 do not change accept/refuse. `-0.0` refused (24).

## 3. Tests added and results

| Test | Where | Kind | Result on 38aa788 |
|---|---|---|---|
| `extreme_u64_amounts_are_refused_by_the_right_rule_and_never_panic` | `core/shield-v2/tests/review_node_1.rs` | coverage | ok |
| `review_r1_6_shield_cap_check_uses_an_unchecked_u128_addition` | `core/shield-v2/tests/review_node_1.rs` | regression (R1-6) | **FAILED** — `accepted with a wrapped pool_total of 4 (release build)` |
| `identical_output_commitments_are_two_leaves` | `core/shield-v2/tests/review_node_1.rs` | documenting | ok |
| `review_r1_4_signerless_envelope_version_is_not_pinned` | `core/daemon/src/shield_v2.rs` (tests) | regression (R1-4) | **FAILED** — `version = 2` accepted by `shield_v2_tx_rule`, identity and hash differ |
| `review_r1_1_bare_v2_type_names_pass_every_pre_stage_2_rule` | `core/daemon/src/node.rs` (`shield_v2_review_node_1_tests`) | documenting (R1-1) | ok (documents the divergence surface) |
| `review_r1_2_mempool_full_is_judged_only_after_the_proof_was_verified` | same | regression (R1-2) | **FAILED** — node reported `shield_v2: proof refused (… Decode("DeserializeBadVarint"))`, not `Mempool full` |
| `review_r1_3_producer_drops_valid_v2_transactions_beyond_the_block_limit` | same | regression (R1-3) | **FAILED** — mempool left with 0 entries, expected 1 |
| `review_r1_5_mempool_admits_shields_beyond_the_funding_balance` | same | documenting (R1-5) | ok (3 of 3 admitted against a 10-XRGE balance) |

Commands (each under `systemd-run --user --scope -q -p MemoryMax=2500M -p MemorySwapMax=0
-p CPUWeight=10 nice -n 19 … -j 1`, one at a time):

```
# daemon test binary (debug), built twice: before and after the review tests were added
cargo test --manifest-path core/Cargo.toml --locked -j 1 -p quantum-vault-daemon --no-run
#   → core/target/debug/deps/quantum_vault_daemon-fbb3b34f5aaeaeb3 (5 m 51 s cold, 12.6 s incremental)

# author's stage-2 daemon tests, one module per process
<bin> node::shield_v2_daemon_tests:: --test-threads=1      → 9 passed, 0 failed (358.5 s; debug proving)
<bin> shield_v2::tests:: --test-threads=1                  → 4 passed, 1 failed (the failure is review_r1_4, by design)
<bin> upgrades:: --test-threads=1                          → 4 passed, 0 failed
# this review's daemon module
<bin> node::shield_v2_review_node_1_tests:: --test-threads=1 → 2 passed, 2 failed (r1_2, r1_3 by design; 2.1 s)

# shield-v2 crate, release, one test binary at a time
cargo test --manifest-path core/Cargo.toml --locked --release -j 1 -p quantum-vault-shield-v2 --test review_node_1 -- --test-threads=1
#   → 2 passed, 1 failed (r1_6 by design); release build 1 m 17 s
cargo test --manifest-path core/Cargo.toml --locked --release -j 1 -p quantum-vault-shield-v2 --test pool -- --test-threads=1
#   → 17 passed, 0 failed (author's pool tests, unchanged)
```

Totals: 42 tests run on the branch after this review's additions, 38 passed, 4 failed — the four
`review_r1_*` regression tests (R1-2, R1-3, R1-4, R1-6), each failing with the message quoted in §1.
Everything else the author wrote and this review ran still passes. The `core/target/` directory
created for these runs was deleted afterwards.

## 4. Out of reach

* Old-build behaviour for R1-1 is shown by the pre-existing rules and the `_ => {}` arms, not by
  running an `origin/main` binary against the same block (no second build was made on the
  production host).
* R1-2's cost figures are the spec's measured figures, not re-measured here.
* The HTTP exposure of the two new routes (nginx) and P2P rate limits are outside the worktree.
* No test of the full tree (2^32 leaves) beyond the author's fabricated-state test; no 32-bit build.
* Reorg beyond the single-block rollback: the daemon has none; `recover_from_history` was read, not
  run on a large chain.

## 5. Resolution (2026-10-06, branch `feat/shield-v2-node`)

Every finding was fixed on the branch; the four `review_r1_*` regression tests that failed on
`38aa788` pass, and the two documenting tests (R1-1, R1-5) were turned into regression tests of the
new behaviour. Details per item are in `NOTES.md` items 41–48; the spec amendments are in
`docs/SHIELDED_POOL_V2_SPEC.md` (§1 amendment note, §3 first paragraph + runbook note, §3.1, §3.6
checks 1–2, §4.6).

| Finding | Fix | Commit |
|---|---|---|
| R1-1 (Medium) | Below activation, consensus is the previous release's exactly: `import_block` strips the two payload fields (what an old `TxPayload` deserialisation does), `shield_v2_tx_rule` is `Ok(None)` for every transaction (no rule — a bare V2 type is an unknown type, applied as a no-op), `skips_account_signature` has a height and is false (no exemption; a signer-less envelope fails the signature rule as on an old node), `check_block_limit` runs from activation only, and the CLI-envelope binding compares the envelope payload with the fields dropped. The pre-activation refusal is now `shield_v2_local_rule`, called only by mempool admission and the producer. Tests: `review_r1_1_before_activation_import_equals_the_previous_release_verdict_and_root` (ten probe blocks vs a model of the old rule set, verdict + header root + state root + stored block, with activation `None` and above the tip), the rewritten `before_activation_a_block_with_a_v2_transaction_is_judged_by_the_previous_release_rules`, the unit test in `shield_v2.rs`; `state_root_is_byte_identical_before_activation` unchanged. Spec §3 (pre-activation paragraph, runbook note), §3.6 check 1, §4.6. | `8560097` (code), `c6fb49b` (spec) |
| R1-2 (Medium) | `insert_tx_to_mempool`: nonce, binding, stateless rules, replay, mined, duplicate and mempool-full judgement all before `shield_v2_admission_checks`, whose own cheap checks precede the proof; `VerifyCache` gained a bounded (4,096) negative set read by `verify_proof_admission` (mempool, producer) and never by block apply. Test `review_r1_2_*` extended; `a_refused_proof_is_cached_for_admission_only`. | `8560097` |
| R1-3 (Low) | `shield_v2_select_for_block` returns the entries beyond the limit separately; `mine_pending` puts them (with their verified marks) back into the mempool before producing. Test `review_r1_3_*`. | `8560097` |
| R1-4 (Low) | `shield_v2_tx_rule` check 2 refuses `version != 1` for the two signer-less types. Spec §3.1, §3.6 check 2. Test `review_r1_4_*` + boundary. | `8560097` (code), `c6fb49b` (spec) |
| R1-5 (Low) | Admission subtracts the `v_in` of the shields already queued from the same account (`quick_shield_v_in`) and caps queued V2 transactions at `MAX_MEMPOOL_SHIELD_V2 = 64` (≈ 26 MB). Test `review_r1_5_*` rewritten. | `8560097` |
| R1-6 (Low) | `pool.rs` check 18: `checked_add` → `PoolError::CorruptState("pool_total overflow")`. Test `review_r1_6_*` asserts the exact error. | `ad78c62` |
| R1-7 (Low) | `shield_v2_notes_since` reads the listing's fields from the body hex only (`shield_v2::listing_fields`), never touches the proof string, lists at most `SHIELD_V2_NOTES_MAX_TXS = 512` transactions per call (ending at a block boundary), and documents the remaining cost (block reads, `compute_single_tx_hash`). | `8560097` |
| R1-8, R1-9, R1-10 (Info) | Accepted as stated; no code. NOTES item 48. | the commit that adds this section |

Not done: a per-peer budget for V2 verifications (R1-2's last suggestion); the per-height V2
index for the listing (NOTES 39). The TOKEN_MINTING precedent (refusing its fields before
activation) has the same split in principle and was not changed — it is mainnet history (235).

The daemon fixes share one commit (`8560097`): R1-1, R1-2 and R1-5 all rewrite the same lines of
`insert_tx_to_mempool` and `shield_v2_admission_checks`, so a per-finding split would have produced
intermediate commits that were never built or tested.

Verification on the final source (resource wrapper, `-j 1`, one cargo at a time):

```
cargo build --release --locked -p quantum-vault-daemon -j 1        -> ok, 16 warnings, none in code touched here
cargo test --locked -j 1 -p quantum-vault-daemon --no-run, then one process per module (43 modules):
  TOTAL_PASSED=291 MODULE_FAILURES=0
  node::shield_v2_review_node_1_tests 5/5, node::shield_v2_daemon_tests 9/9, shield_v2::tests 6/6,
  upgrades::tests 4/4, node::strict_historical_replay_tests 3/3, node::xrge_supply_tests 9/9,
  node::producer_and_unbonding_tests 4/4; storage crate 19/19
cargo test --release --locked -p quantum-vault-shield-v2 -j 1 -- --test-threads=1
  -> 35 passed, 0 failed (lib 2, pool 17, review2_wrapper 5, review_node_1 3, review_verifier 3, vectors 5)
cargo tree -p quantum-vault-daemon -e normal,build,features -i quantum-vault-shield-v2
  -> only `feature "default"`
```

Limits of the R1-1 evidence: the previous release's behaviour is established by reading
`origin/main` (`0274e8e`) and modelled in the test; no `origin/main` binary was built and run
against the same blocks on this host. The 16 release warnings were not compared with a baseline
build of `46c9fbb`; each is in code this pass did not add.
