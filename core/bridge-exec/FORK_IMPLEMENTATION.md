# Option-B canonical-ledger fork — implementation (F = 49)

Decision: Option B (2026-09-19). `CANONICAL_LEDGER_FORK_HEIGHT` = `fork_tables::FORK_HEIGHT` = **49**
(compile-time constant; no env/config/admin override — changing F requires a new binary). F−1 = 48 =
the live production tip at freeze time (live state root `f5af35d8…` == committed root 48).

## Consensus rules
- `1..=17`: as before (no committed root).
- `18..=48` (checkpoint era): `import_block` accepts a block ONLY if `header.state_root == CHECKPOINT_ROOTS[h]`
  (compiled, hash-pinned; missing height ⇒ reject, mismatch ⇒ reject). Blocks are applied under canonical
  rules; no recompute of the legacy root; no runtime bypass exists.
- At `48` (F−1) the node's ledger MUST equal `CANONICAL_LEDGER_AT_F_MINUS_1` (and token/LP tables) — asserted on
  import; a persisted marker `canonical_ledger_at_f_minus_1` is then set.
- `≥ 49`: normal recompute-and-verify forever (no checkpoint exceptions).
- Startup guard (`fork_readiness_check`): a node at/after F−1 without the marker refuses to run; a legacy
  production ledger is told to run the migration.

## Tables (`core/daemon/src/fork_tables.rs`, generated from the immutable fixtures; hashes recomputed by tests)
CHECKPOINT_TABLE_SHA256 `2d979994dbe21559efb2a7ee1aa67911218fbe9bdb2fe04c1c8319aa5486ad67` ·
PRODUCTION_LEDGER_TABLE_SHA256 `bb8ea37fa0f2ad85611bfbd806405efaf9f5b5fb5340b100a18c63cc8c560b60` ·
CANONICAL_LEDGER_TABLE_SHA256 `880e5c9e488eacabd272463b8a97942016583e7f65cf87e2736a71e65e5cc9ee` ·
CANONICAL_DELTA_TABLE_SHA256 `af440c273ac81181425f2b98b20de20c45a9bacd970a1b72d6685a57ff1f59dd` ·
TOKEN_LP_TABLE_SHA256 `7c2e1dfd003ff0f869886f768cc88bd07ff89cf941ed5e9212d44c952356a9dd`.
CANONICAL_DELTA (quanta): `__treasury__` −1025507909938; `rouge168fd…qxj` −8576879295145; `rouge19emhc…er4c`
−652691861870; `rouge1qm85…c378` −32318; sum −10,255,079,099,271 (= 10,255.079099271 XRGE); 0 end-user rows.

## Migration (`--migrate-canonical-ledger`, operator-invoked, one-time, atomic)
Requires tip == 48 and ledger == PRODUCTION_LEDGER_AT_F_MINUS_1 (every account, plus token/LP hash);
already-canonical ⇒ recognized (idempotent). Applies CANONICAL_DELTA in memory, verifies == CANONICAL_LEDGER,
persists the snapshot as ONE sled batch + marker, re-verifies; ANY failure ⇒ exact in-memory restore, marker
removed, pre-migration snapshot re-persisted, abort. Never runs on restart.

## Recovery / fresh sync
Missing or corrupt snapshot ⇒ `recover_from_history`: reset every derived component (ledger maps, fee_db,
nonce_db, validator/pool/NFT/metadata/allowance/multisig/contract stores, marker), reset the chain store to
genesis, re-seed genesis validators, re-import every stored block through `import_block` (checkpoints +
canonical rules + F−1 assertion), persist the snapshot atomically. A brand-new node (random identity, empty dir,
genesis, blocks) reaches the same state by construction. Faucet/`bridge_mint` gating uses the genesis authority
set (no node-local identity). `rebuild_balances` keeps the unified fee accounting for the peer-sync path.

## Bridge coordination
`BRIDGE_PAYOUT_STORE_ACTIVATION_HEIGHT = FORK_HEIGHT`: only receipts from height ≥ 49 (R1 typed results) can
ever derive a relayer payout record; historical withdrawals stay audit history. Degraded-store behaviour retained.

## Operator diagnostics
`--print-state-digest`: read-only digests (tip, state root, balances/token/LP/burned/nonce hashes, stakes,
shielded, base fee, marker). Zero-valued map entries are not state (matches the state-root semantics).
