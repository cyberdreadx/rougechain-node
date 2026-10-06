# shield-v2 — implementation notes (stage 1 and stage 2)

Specification: `docs/SHIELDED_POOL_V2_SPEC.md` (SPEC v1, @9523076). Research source:
`research/shield3/src` on branch `spec/shielded-pool-v1` (tree `8a435868…`). This file lists every
place where the specification was ambiguous, where it differs from the research code, or where a
choice had to be made that the specification does not fix. Stage 1 (items 1–18) is this crate;
stage 2 (items 19–40) wires it into the daemon behind an activation height that is `None` on every
network.

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
   **RESOLVED in stage 2:** the caller is `core/daemon/src/shield_v2.rs::shield_v2_tx_rule`
   (checks 1–12 incl. the minimum fee, plus the signed-payload coverage half of 14), the daemon's
   existing signature verification (14), `L1Node::apply_shield_v2_tx` (19, 20). See item 21.

9. **Per-block limit** (§4.7 / §3.6 check 13) is checked once for the whole slice before the first
   transaction, not when the 9th transaction is reached. Same accept/refuse outcome for the block;
   only the error kind differs, and kinds are not consensus.

10. **Node-local bookkeeping in the store.** `StoredPool` carries `activation_height` and
    `next_height` so that blocks are applied in order from A and a store cannot be opened for the
    wrong network. Neither is consensus state and neither enters the state-root section.
    **RESOLVED in stage 2:** the persistent backend is `core/storage/src/shield_v2_store.rs`
    (`ShieldV2Store`, sled, one tree with key prefixes, every write one `apply_batch`), and
    `core/daemon/src/shield_v2.rs::DaemonPoolStore` implements this crate's `PoolStore` over it
    with a versioned binary encoding of `StoredPool` (`encode_stored_pool` / `decode_stored_pool`,
    round-trip tested). The storage crate holds bytes only, so the proof library does not enter
    any other dependant of the storage crate. `next_height` is additionally used at node start
    (`L1Node::shield_v2_store_in_sync`): a store that is not at `tip + 1` (crash between the pool
    commit and the balance snapshot) triggers the deterministic re-import from genesis
    (`recover_from_history`, which clears the store), like a missing balance snapshot.

11. **Two-phase apply.** `validate_block` (pure) → `PreparedBlock` → `commit` (one atomic store
    write). `PreparedBlock::state_root_section` lets the caller compare the header before anything
    is stored, so a rejected block needs no undo. Undoing a block that WAS committed (a reorg, or
    the daemon's own rollback path after a later mismatch) is left to the storage backend's
    snapshot/restore and to stage 2; the in-memory store is `Clone` for that. Spec §4.2 rule 5 and
    §4.1 ("same pre-apply snapshot and the same rollback") are therefore only half-covered here.
    **RESOLVED in stage 2:** the daemon applies the pool inside `apply_balance_block` (the block's
    speculative apply) and commits there; the state-root section is then computed from the
    committed state, exactly as for balances. `PreApplySnapshot` (the daemon's pre-apply snapshot
    of every component a block can touch) now carries `ShieldV2Store::snapshot()` — O(1): the two
    counters, the metadata record and the newest per-block record — and
    `restore_pre_apply_snapshot` calls `ShieldV2Store::restore`, which removes exactly the
    nullifiers (set and log), leaves and per-block records appended since the snapshot and puts the
    metadata back, in one atomic batch. The store is append-only, which is what makes the undo
    exact without dumping the ever-growing set (the daemon's other side stores are dumped whole,
    which would not scale here). A block rejected for ANY reason — a V2 refusal, an ordinary apply
    error, a state-root mismatch, a validator-apply error, a persist failure — therefore leaves the
    pool byte-identical (tested: `rollback_restores_the_pool_store_exactly`). The daemon has no
    reorg path other than this rollback; a deep rebuild is `recover_from_history`.

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

## Stage 2 — daemon integration (branch `feat/shield-v2-node`)

Files: `core/daemon/src/shield_v2.rs` (rules, store adapter, cache, views),
`core/storage/src/shield_v2_store.rs` (persistent store), hooks in `core/daemon/src/node.rs`
(`import_block`, `apply_balance_block` + `apply_shield_v2_tx` / `shield_v2_prepare_block`,
`compute_state_root_for_height`, `capture_pre_apply_snapshot` / `restore_pre_apply_snapshot`,
`insert_tx_to_mempool` / `add_tx_to_mempool` / `shield_v2_admission_checks`, `mine_pending` /
`shield_v2_select_for_block`, `generate_receipts`, `init_inner` / `shield_v2_store_in_sync`,
`recover_from_history`, `shield_v2_stats`, `shield_v2_notes_since`), `core/daemon/src/upgrades.rs`
(`shield_v2: None` on both networks), `core/daemon/src/main.rs` (two GET routes, startup log,
address-history recipient match), `core/daemon/src/indexer.rs`, `core/types/src/lib.rs` (the two
payload fields), `core/crypto/src/lib.rs` (`address_from_hash`).

19. **Activation is `None` everywhere.** `shield_v2::SHIELD_V2_ACTIVATION_HEIGHT = None` (mainnet)
    and `upgrades::TESTNET.shield_v2 = None`, read through `upgrades::current().shield_v2` like
    every other upgrade, with the usual `#[cfg(test)]` thread-local override. Before activation —
    and while it is `None` — a block carrying a `*_v2` transaction, or ANY transaction with a
    `shield_v2_body` / `shield_v2_proof` field, is invalid at import (`shield_v2_tx_rule`, error
    `NOT_ACTIVE_ERROR` / `FOREIGN_FIELDS_ERROR`), exactly the MONETARY_INTEGRITY behaviour (block
    rejection, state restored). The V1 types `shield`, `shielded_transfer`, `unshield` are
    untouched in `SUSPENDED_TX_TYPES` (asserted). The two payload fields are `Option<String>` with
    `skip_serializing_if = "Option::is_none"`, so every historical transaction encodes, hashes and
    identifies byte-identically (the pinned legacy hashes in `types` still pass; new test
    `shield_v2_fields_serialize_only_when_set_and_roundtrip`).

20. **Foreign types with the V2 fields — refused at every height.** Spec §3 says a transaction
    with either field is invalid BEFORE A; after A it only says the three types "MUST" have both and
    nothing else. A non-V2 type carrying either field after A is refused as well (an old node would
    drop the fields and compute a different hash; the TOKEN_MINTING rule treats its fields the same
    way). Ambiguity resolved towards refusal; not a [P] value.

21. **Where each check of §3.6 is made, and in what order.** Checks 1–12 (`shield_v2_tx_rule`,
    stateless, in spec order; the lengths of check 3 and 4 and the lowercase-hex test of 5 are made
    on the strings before anything is decoded), 13 (`check_block_limit` at import; repeated by
    `Pool::validate_block`), 14 (the daemon's existing ML-DSA-65 verification at import / mempool /
    producer — which already includes the payload in every signed format — plus the coverage half in
    `shield_v2_tx_rule`: a `signed_payload`, when present on a `shield_v2`, must contain both
    hexadecimal strings), 15–18 (`Pool::validate_block` in `apply_balance_block`, for the whole
    block in order, BEFORE the per-transaction loop), 19 and 20 (`apply_shield_v2_tx`, at the
    transaction's position in the block, against the balances as they are after the preceding
    transactions — ordinary and V2). So 15–18 of a later V2 transaction run before 19–20 of an
    earlier one. Accept/refuse of the block is the same for every order (all or nothing); only the
    error text differs, and error kinds are not consensus (§4.6). The expensive check 20 is still
    never reached by a block that fails any cheaper check of ITS transaction except 15–18 → 19 → 20
    per transaction, as the spec asks.

22. **Account effects and fees.** A shield debits exactly `v_in` from `canon_addr(from_pub_key)`
    (the fee is inside it, §3.5); an unshield credits `v_out` to
    `address_from_hash(account)` (a new `quantum_vault_crypto` helper — the `rouge1` bech32m
    encoding of the 32-byte payload, the inverse of `address_to_hash`); a transfer moves no public
    balance. Every V2 fee is added, as quanta, to `actual_fees_collected` and from there goes
    through `distribute_fees` unchanged (base-fee burn, 20/70/10). A V2 transaction counts as one
    transaction in `block.txs.len()` for the base-fee and burn arithmetic, as §3.5 requires. The
    envelope fee `0.0` is never read by any V2 rule (`apply_balance_tx_inner` and the AMM / NFT /
    allowance / multisig arms are skipped for V2 types by an early `continue`). The supply
    invariant helper of the daemon's tests (`xrge_supply_tests::total_xrge_q`) now adds
    `pool_total`; the daemon-level flow test asserts balances + pool_total + burned fees is
    conserved across the three V2 blocks.

23. **Signer-less envelope — every place that assumed a sender (spec O-5), and what was done.**
    `shield_v2::skips_account_signature(tx)` is true only for `shielded_transfer_v2` /
    `unshield_v2` with empty `from_pub_key` AND empty `sig` (anything else of those types goes
    through the ordinary verification and then fails check 2):
    1. `import_block` signature loop — skipped for signer-less V2;
    2. `add_tx_to_mempool` (P2P path) signature check — skipped;
    3. `mine_pending` re-verification of drained transactions — skipped;
    4. `insert_tx_to_mempool` → `check_nonce_valid` — skipped (nonce 0 would otherwise be refused
       as `≤ current`);
    5. `apply_balance_block` → `nonce_db.insert(from_pub_key, nonce)` — not written for signer-less
       (a `shield_v2` is an ordinary account transaction: nonce written, address indexed);
    6. `apply_balance_block` → `index_address(from_pub_key)` — not called for signer-less;
    7. `capture_pre_apply_snapshot` nonce/address per-key snapshots — skipped for signer-less;
    8. mempool ordering/eviction by the floating-point `fee` (`insert_tx_to_mempool`, `MAX_MEMPOOL`
       eviction) — unchanged: a V2 transaction has envelope fee 0.0 and is therefore the FIRST
       evicted when the mempool is full and refused when it is full (`tx.fee <= min_fee`). Noted,
       not changed: node-local, and the integer body fee is not comparable with the float fees of
       other types without a policy decision (open; see O-6);
    9. `generate_receipts` — `from` stays the envelope's sender (empty for signer-less),
       `fee_paid` is the body's integer fee in display XRGE, the log carries the public body fields
       (`shield_v2::receipt_data`: kind, amounts in quanta, anchor, nullifiers, commitments, expiry,
       unshield recipient);
    10. explorer `get_address_transactions` (main.rs) — an empty sender never matches; an
        `unshield_v2` is listed as incoming for its body's recipient address;
    11. `indexer.rs` by-address index — no entry under the empty address;
    12. `tx_identity` / `compute_single_tx_hash` — unchanged and sender-independent for a tx without
        `signed_payload` (sha256 of the signable encoding incl. the payload, hence the proof), so the
        uniqueness index and the mined-hash set work for signer-less transactions; the spec's
        warning that this identity must not be relied on for double-spend detection is respected
        (the nullifier set is);
    13. `v2_binding::verify_v2_binding_at` — trivially `Ok` without `signed_payload` (check 2 forbids
        one on signer-less types); a `shield_v2` WITH a non-envelope `signed_payload` is refused by
        the binding at mempool/producer time because `derive` knows no `shield_v2` (only the CLI
        envelope form, which embeds the payload, is bindable) — at import the coverage rule of
        item 21 applies;
    14. proposer-stats / entropy / finality code paths read `header.proposer_pub_key`, never a tx
        sender — nothing to do;
    15. `apply_identity_for` (faucet / bridge_mint authorization) compares `from_pub_key` with the
        authority set — an empty key never matches, and V2 types never reach that arm.

24. **Envelope `fee` "exactly 0.0"** is compared by bit pattern: `-0.0` is refused (it is also
    refused by `fee_and_type_sanity`). Not a [P] value.

25. **Chain id.** `chain` of the body is compared with `SHA-256(self.opts.chain.chain_id)` of the
    node; the daemon's test nodes use chain id `test`. The V2 rule is the only consumer of
    `chain_tag`.

26. **Proof verification once per transaction per node.** `shield_v2::VerifyCache` (bounded,
    4,096 entries, cleared when full) remembers the `compute_single_tx_hash` of every transaction
    whose proof THIS node accepted — at mempool admission, in the producer's selection, or at block
    apply — so mempool → block costs one verification, and a block re-offered after a rollback costs
    none. A refusal is never cached. The key covers body and proof, so a different proof of the
    same statement is verified on its own. Per-block limit 8 bounds the cost of a hostile block
    (§4.7). The cache is `Arc`-shared across the node's clones.

27. **Mempool (node-local SHOULDs of §4.6).** Admission runs the stateless rule, the pool's
    checks for a one-transaction block at `tip + 1` (`Pool::validate_block`), the funding balance
    for a shield, a nullifier-conflict scan over the queued V2 transactions (`quick_nullifiers`
    reads the two nullifiers straight from the body hex), and the proof. Expired transactions and
    transactions whose anchor left the window are not dropped eagerly: the producer leaves them
    out when it drains the mempool (the daemon's producer drains everything and drops what its
    filters refuse — existing behaviour).

28. **Producer (§4.6 "MUST leave out any transaction that fails").** `shield_v2_select_for_block`
    evaluates the drained V2 transactions in order against the evolving pool state (a growing
    `Vec<PoolTx>` re-validated with `validate_block`), a balance shadow for shields from the same
    account, the proof (cached), and the limit of 8; whatever fails is left out with a log line.
    The shadow does not see ordinary transactions of the same block that could drain a shield's
    account; if that happens `apply_balance_block` refuses the attempt, the producer rolls back as
    for any failure and — new — drops the V2 transactions from the requeue when the error came from
    a `shield_v2` rule, so it cannot loop on the same refused transaction.

29. **State root (§4.8).** `compute_state_root_for_height` appends the section
    (`PoolState::state_root_section`, this crate) after the balance root, the NFT/contract
    extension and the mint-ledger extension, from activation on unconditionally. The function was
    restructured (the token-mint branch no longer returns early) without changing its result:
    `state_root_is_byte_identical_before_activation` replays the mainnet fixture `blocks 0–137`
    with activation `None` and with activation 138 and asserts identical roots and block hashes,
    then shows that at 138 the root is exactly `state_root_section(today's root)` of the genesis
    pool state. The pool state read for the root is the COMMITTED state after the block (item 11).

30. **Pre-activation footprint.** The store is not written before activation: `shield_v2_pool()`
    (which initialises the genesis record) is called only from active heights, from mempool /
    producer paths that saw a V2 transaction at an active height, and from nothing else. The stats
    endpoint reads the raw metadata record and reports `pool: null` when none exists. The
    pre-apply snapshot/restore does touch the store on every block (an O(1) read and, on a rollback,
    a batch that removes nothing); asserted empty after rejected pre-activation blocks.

31. **Store layout** (node-local, not consensus): one sled tree `shield-v2-db/pool` with prefixes
    `m` metadata, `c` counters (`nullifier_count ‖ leaf_count`), `n‖nf → index` (the set),
    `l‖index → nf` (the insertion log — the order `nullifier_acc` commits to, and the order a
    snapshot consumer needs, O-12), `t‖pos → leaf`, `h‖height → first_leaf ‖ leaf_count_after`
    (per applied block, for the wallet listing). `commit` refuses (nothing written) a repeated
    nullifier or leaves that do not continue the tree. Tests in the storage crate.

32. **HTTP (read-only; nothing else).** `GET /api/shield-v2/stats` (activation, active flag,
    constants, and when the pool exists: next height, pool total, note and nullifier counts, tree
    root, nullifier accumulator, the anchor window) and `GET /api/shield-v2/notes?since=N&blocks=K`
    (K clamped to 1..=256): every accepted V2 transaction of those blocks in chain order with
    height, index, hash, type, `nf1`, `nf2`, and per output `cm_out`, leaf position, `kem_ct`,
    `note_ct` — what a wallet scans by (§5.4) without ever asking for a path. `next_height` is the
    cursor. The `UpgradeSchedule` already serialises into `/api/stats`, so `shield_v2: null`
    appears there. Transactions enter only through the existing `/api/broadcast` → mempool path
    (nginx-blocked publicly; untouched). No relay changes.

33. **Receipts and explorer** — see item 23 (9–11). The receipt's `status` is always `Success` for
    a V2 transaction: there is no "included but failed" V2 transaction (§4.6).

34. **Ordinary transactions after a V2 refusal.** Because the whole block is refused, the
    daemon-level atomicity test checks that an ordinary transfer placed BEFORE a failing V2
    transaction in the same block is not applied either.

35. **Regression pair of §4.2 at daemon level** (`l1_pair_at_most_one_of_two_shields_with_equal_nullifiers_is_accepted`):
    two shields from the same dummy secrets — `TestRng` replayed from the same state — with
    different outputs; both proofs verify; the node refuses the block that carries both
    (`NullifierRepeatedInBlock`), accepts the first alone, refuses the second later
    (`NullifierSpent`), balances and pool untouched each time.

36. **Test proofs.** The daemon's tests build four proofs with this crate's `test-prover` feature
    (a `[dev-dependencies]` entry only; the normal `[dependencies]` entry has no feature) and cache
    them in a `OnceLock` per test process; the bodies are real §3.2 bodies and the bindings are
    theirs. The normative vectors of §8.3 cannot drive a block (their `binding` is not a body's,
    §8.1); they stay the verifier's vectors in this crate. Feature isolation asserted with
    `cargo tree -p quantum-vault-daemon -e normal,build,features -i quantum-vault-shield-v2`: only
    the `default` feature of this crate is reachable from a normal daemon build.

37. **Where garbage proofs suffice.** The min-fee and pool-cap boundary tests use bodies with a
    64-byte garbage proof: the boundary values are judged before check 20 (`below the minimum`,
    `PoolCapExceeded`, `PoolUnderflow`) and the value exactly at the boundary passes them and is
    refused only by the proof (`proof refused`). The expiry boundary (`expiry_height ≥ H`, valid at
    H = expiry) and every string-length boundary are unit tests in `shield_v2.rs`.

38. **`Pool::validate_block` is run twice per imported block** when the block came through this
    node's mempool (admission, then apply) and once more per transaction in the producer's
    selection; the body hex is decoded three times per accepted transaction (rules loop, apply,
    receipts). Both are cheap next to one proof verification and keep each stage self-contained.

39. **Not done / left open.** No wallet-side code (prover without a seed parameter, O-14; key
    derivation; note encryption) — out of scope for the node. No eager mempool expiry sweep (item
    27). No activation runbook text for the payload-field rollout (spec §3, first paragraph) — the
    rule is in place, the operator document is not. The §4.8 state-root vectors and the body /
    binding vectors of O-15 are still produced by tests here, not by a cross-checked second
    implementation. `shield_v2_notes_since` reads whole blocks from the chain store; an index of
    V2 transactions per height would make a cold wallet scan cheaper (not needed before activation).

40. **`cargo tree` was again run without `-j 1`** (it takes none); every other cargo invocation
    used the required resource wrapper and `-j 1`, one at a time, and the daemon tests were run per
    module in separate processes.
