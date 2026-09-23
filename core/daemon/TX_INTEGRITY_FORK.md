# C1 — transaction-uniqueness consensus rule (scheduled hard fork)

Branch `consensus/c1-nonce-rule`, based on the deployed production commit `2c0f3c2`. Found by the 2026-09-23
adversarial review (`contracts-v3/release/ADVERSARIAL_REVIEW_2026-09-23.md`, finding C1). **Not deployed. No
activation height chosen (`TX_UNIQUENESS_ACTIVATION_HEIGHT = None`).**

## The defect

`import_block` verifies the proposer signature, the block hash and every transaction signature, then applies the
block. It never checked that a transaction had not already been included. `apply_balance_block` applies every tx and
overwrites `nonce_db[sender] = tx.nonce` unconditionally; the only nonce check (`check_nonce_valid`, "nonce > stored")
runs at mempool admission, which a proposer bypasses by building the block itself. Any validator with `stake > 0` is
an accepted proposer.

Consequences:
* A staked proposer can re-include any historical signed transaction (all are public) and debit the victim again.
* Through the public API, a replay of a tx whose nonce is still "greater than stored" (mainnet has timestamp-based
  nonces in history and the nonce store has been cleared/migrated) is admitted to the mempool and mined by an honest
  producer — no validator needed.
* For the V3 bridge: a replayed `bridge_withdraw` has the same `rougechainTxId`; the epoch pipeline refuses the
  duplicate and `EpochStore::sync` stops permanently.

`rule_is_inactive_below_the_activation_height_and_when_unscheduled` pins the legacy behaviour (the victim IS debited
twice) so the fix is demonstrably a change.

## Why not a consensus nonce rule

Mainnet history is not nonce-sequential: senders used millisecond timestamps as nonces (blocks 20, 45–48), sequences
restart at 1 after nonce-store migrations (blocks 22, 24, 49, 58), and the per-node `nonce_db` has been cleared at
different times on different nodes. Any nonce rule strict enough to stop replays either rejects existing history or
depends on node-local state, i.e. splits the chain. Nonce semantics at the mempool are left unchanged.

## The rule (from `TX_UNIQUENESS_ACTIVATION_HEIGHT`)

A block at height ≥ N is invalid if any transaction, identified by its canonical hash
`compute_single_tx_hash = sha256(encode_tx_v1(tx))` (signature included — the hash already used for receipts and
V3 `rougechainTxId`), (a) appears more than once in the block, or (b) was included in an earlier accepted block.

Deterministic: every node derives the same "already included" set from the same accepted chain. Below N nothing
changes, so the historical replay is byte-identical (daemon suite incl. `mainnet-blocks-0-48` replay: unchanged).

## Implementation (daemon only, `core/daemon/src/node.rs`)

* `tx-seen-db` sled tree: canonical tx hash → height. Written **only after** a block is durable (post-commit, both
  the import and the producer path); a rejected block never writes it. `ensure_tx_seen_index()` on every start
  rebuilds it from the stored chain when its recorded tip ≠ chain tip (fresh node, upgrade from a binary without
  the index, crash between append and record); `recover_from_history` clears it and re-derives through
  `import_block`.
* `check_block_tx_uniqueness` in `import_block`, before the pre-apply snapshot, gated by the activation height.
* Node-local hardening that is live immediately on upgrade, before N, and changes no block validity:
  the mempool refuses a tx already included (`"already included in block h"`) regardless of the nonce check; the
  producer drops such txs before assembling a block.
* Tests: `node::tx_uniqueness_tests` (7): replay rejected at/after N with the victim's balance untouched; in-block
  duplicate; legacy behaviour below N and when unscheduled; exact activation boundary; mempool guard when the nonce
  check would pass; producer filter; index rebuild/recovery.

## Activation procedure

1. Choose N with margin (≥ 1 week of blocks at current cadence is meaningless — mainnet mines only on demand; use
   a calendar deadline and a height comfortably above the tip, e.g. tip + 200).
2. Set the constant, tag a release, publish to `rougechain-node`, replay mainnet history with the release.
3. Upgrade **every** validator (primary, node #2, the external validator) before the tip reaches N; a node still on
   the old binary keeps accepting replay blocks and would fork off if one were ever produced.
4. After N: any replay attempt is a rejected block from that proposer; monitor `[peer] Rejecting` lines.

## Out of scope here (separate items)

* Proposer-selection enforcement (any staked validator may propose at any height) — the review's second half of
  C1; a larger consensus change, to be designed separately.
* Mempool nonce semantics (gap-tolerant, node-local).
