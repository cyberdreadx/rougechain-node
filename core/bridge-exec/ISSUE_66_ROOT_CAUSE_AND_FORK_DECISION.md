# Issue #66 — why a fresh node cannot replay mainnet past height 18, and what the fix requires

**Status: root cause established with reproducible evidence; the remedy is a fork decision
that is NOT made in this branch.** This candidate ships the deterministic-execution fixes that
are unconditionally correct (authority-based mint gating, unified rebuild fee accounting,
atomic rejected-block rollback) and a strict historical-replay regression (ignored until the
decision). Nothing here changes any committed historical root.

## Symptom
`main@8b98ee6` (and every later binary) started from `genesis-mainnet.json` + historical blocks
1..48 fails in `L1Node::import_block` at height 18 — the first block carrying a committed
state root (V2 fork): `header=c04e251a…`, `computed=99a37ecc…`. Blocks 1..17 (no committed
root) import cleanly. The R1→R1E branch fails identically (PR #123 evidence).

## What the committed roots actually encode (evidence)
Chain facts: 48 blocks; 1..18 are only faucet transfers, `bridge_mint`s (node/genesis-validator
key) and user `bridge_withdraw`s; the first `stake` is h20, second h29; no allocations in genesis.

1. **Production ledger ≠ any canonical replay at the tip.** Production's persisted maps at 48
   vs a clean canonical replay at 48 differ only on `__treasury__` (+1025.5 XRGE), the
   proposer/validator account (+8576.9), one staked validator (+652.7) — ≈ 10,259 XRGE that no
   block ever credited — plus `fees_burned` (0.213 vs 0.114).
2. **Source of the ≈10,259 XRGE: the restart-rebuild path.** `rebuild_balances()` (run by
   `init()` whenever no valid snapshot exists) computed "fees collected" as
   `sum_before − sum_after` of ALL balances per tx, so burned `bridge_withdraw` principal
   (255 XRGE) and the h20 `stake` debit (10,001 XRGE) were distributed as fees to
   proposer/validators/treasury. The split (10 % / 83.6 % / 6.36 %) matches exactly the
   validator set that existed between h20 and h28 (100,000 + 10,000 stake). The h29 stake is
   absent from the pool because production REJECTED it (balance 10,000.87 < 10,001) — which is
   also why blocks 27, 28 and 29 carry the identical root `dfedda7e…` (the h28 unshield and
   h29 stake were no-ops there).
3. **Retired ledger keying.** Blocks 18–21 (Sep 5–9) were produced before
   `038336b` (Sep 9, "canonicalize balance keys to rouge1 address — fix split buckets");
   blocks 22–29 (Sep 13 01:10–04:07) under an intermediate build whose v3 snapshot still held
   split buckets (`38f6cdf`, Sep 13 04:09, bumped SNAPSHOT_VERSION to force a re-canon rebuild —
   the rebuild that injected item 2, between h29 and h30). The state root hashes sorted
   `key=value` pairs, so roots committed under the old key layout cannot equal roots computed
   over canonical keys, whatever the amounts.
4. **Exhaustive negative results.** With the current binary, simulating a production
   restart-rebuild after every height 1..17 (for root 18) and 19..47 (for root 48) reproduces
   NO committed root. With the actual Sep-5 fork-arming binary (`8dfe615`, pre-canonical
   keying) emulating the producer path from genesis, root 18 is `ee9ca37a…` and no restart
   height reproduces `c04e251a…` either. Production's state at 18 additionally carried
   pre-genesis-era artifacts (June 2026 corruption/restore, `mainnet-corrupted-20260615`) that
   no binary in git recomputes.
5. **Identity-dependent application (item 3).** `bridge_mint`/faucet acceptance was gated on
   `tx.from_pub_key == <this node's key>`, so a fresh node with its own key silently dropped
   every historical mint (root 18 became `39f64be3…`), and the rebuild path accepted mints from
   ANY signer. Fixed in this branch: gating uses the genesis-anchored bridge authority set
   (`apply_identity_for`); the strict-replay prefix test now asserts the identity-independent
   root `99a37ecc…` at 18 from a random key.

**Conclusion:** the committed roots 18..48 are a function of production's operational history
(retired key layouts, restart-rebuild phantom credits, rejected-under-old-state txs), not of
block contents + genesis + protocol rules. No deterministic replayer can reproduce them, and
they must not be edited.

## The decision (not taken here)
Either path is a coordinated hard fork at a height F > current tip:

**Option A — checkpoint + irregular state transition (keeps live balances).**
Pin `ROOT[18..F−1]` as consensus constants (verified by equality, not recomputed); at F apply
an explicit, audited state delta table that maps the canonical ledger onto production's actual
ledger (the ≈10,259 XRGE phantom credits and the split-bucket outcomes), so every node reaches
production's state; from F onward roots are recomputed and verified normally. Deterministic,
no snapshot pre-seeding, no bypass; but it enshrines the phantom credits.

**Option B — canonical re-execution (changes live balances).**
Declare roots 18..F−1 non-verifiable history; at F the producer adopts the canonical ledger
(full rebuild under the fixed code): treasury −≈1025 XRGE, validator accounts −≈9,230 XRGE,
and the h24/h25/h29 accept/reject outcomes change. Economically visible; requires operator/
governance sign-off.

Until F is chosen and deployed: **production must not restart into a rebuild** (any rebuild —
old or new accounting — changes the live ledger), fresh validators cannot sync past 18, and the
bridge stays paused.

## Unconditional fixes shipped in this branch
- `apply_identity_for`: authority-set gating for faucet/`bridge_mint` on import AND rebuild.
- `rebuild_balances`: fee accounting unified with `apply_balance_block`
  (`fee_to_quanta(tx.fee).min(deducted)`) — no more phantom distributions on rebuild.
- Atomic rejected-block rollback (`capture_pre_apply_snapshot` / `restore_pre_apply_snapshot`).
- Validator-state atomicity: stake/unstake effects applied ONLY from per-tx `ValidatorExecution`
  results of the ledger execution (sequential in-block shadow) — the h29 "power without debit"
  exploit shape (`validator_atomicity_tests`) is closed; the canonical validator set at F−1 is
  pinned and migrated with the ledger (FORK_DECISION_PACKAGE §11).
- Strict historical replay regression (`strict_historical_replay_tests`): prefix 1..17 must
  import and root 18 must be identity-independent; the 48/48 test is `#[ignore]`d with the
  reason above and must be un-ignored as part of the fork PR.
- No runtime root-verification bypass exists in this branch (validation harness stays on the
  `replay-harness-main` / `bridge-r1-integration-validation` branches only).
