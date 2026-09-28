# Option-B canonical-ledger fork — implementation (F = 49)

Decision: Option B (2026-09-19). `CANONICAL_LEDGER_FORK_HEIGHT` = `fork_tables::FORK_HEIGHT` = **49**
(compile-time constant; no env/config/admin override — changing F requires a new binary). F−1 = 48 =
the live production tip at freeze time (live state root `f5af35d8…` == committed root 48; re-verified
2026-09-18 after the validator-state regeneration: `network_height 48`, `finalized_height 48`, block 49 → 404).

## Consensus rules
- `1..=17`: as before (no committed root).
- `18..=48` (checkpoint era): `import_block` accepts a block ONLY if `header.state_root == CHECKPOINT_ROOTS[h]`
  (compiled, hash-pinned; missing height ⇒ reject, mismatch ⇒ reject). Blocks are applied under canonical
  rules; no recompute of the legacy root; no runtime bypass exists.
- At `48` (F−1) the node's state MUST equal the pinned canonical commitment — asserted on import, in two steps
  of the same atomic block application: the native ledger + token/LP tables after `apply_balance_block`, and
  the validator set (consensus fields) + empty unbonding queue after `apply_validator_block`. Either failure
  rolls the block back (`PreApplySnapshot`, validator trees included). The marker
  `canonical_ledger_at_f_minus_1` is set only after the block is persisted.
- `≥ 49`: normal recompute-and-verify forever (no checkpoint exceptions).
- Startup guard (`fork_readiness_check`): a node at/after F−1 without the marker refuses to run; a legacy
  production ledger is told to run the migration.

## Stake / unstake atomicity (consensus-critical fix, part of this fork)
Before: `apply_validator_block` re-derived stake/unstake from tx types independently of ledger execution, so a
`stake` whose debit failed (h29: 10,000.87 < 10,001) still created 10,000 XRGE of validator power, in-block
double stakes/unstakes were unchecked, and a failed-fee unstake still mutated the store. Now:
- `apply_balance_tx_inner` returns a position-aligned `ValidatorExecution` (`StakeApplied` /
  `UnstakeApplied{release_height}` / `Failed(reason)`) per tx, computed against a per-block sequential validator
  shadow seeded from the store (so the second stake/unstake in a block sees the first).
- Stake: zero amount ⇒ Failed; insufficient balance ⇒ Failed with NO debit; success ⇒ debit amount+fee.
  Unstake: `amount > staked (shadow)` ⇒ Failed; fee unpayable ⇒ Failed; success ⇒ debit fee, one unbonding entry.
- `apply_validator_block` applies stake/unstake ONLY from these results (never from tx types); slashing and the
  proposer/missed-block bookkeeping are unchanged. Fee distribution keeps its pre-block validator set (timing
  unchanged). Rebuild/recovery use the same shadow. Receipts mark failed stake/unstake as failures.
- Regressions (`validator_atomicity_tests`): insolvent stake ⇒ no power; failed fee ⇒ no store change; rejected
  block ⇒ no validator/unbonding mutation; same-block double stake locks only what was paid; same-block double
  unstake cannot release more than staked.

## Runtime-path corrections (final review, 2026-09-18) — no historical block or F−1 table changes
1. **Producer atomicity (`mine_pending`).** Same contract as `import_block`: full `PreApplySnapshot`
   (ledger maps, burned, raw fee_db, fees_burned, shielded, unbonding queue, nonce/address entries,
   validator + every speculative side-effect tree) → `apply_balance_block` → post-state root → sign →
   `apply_validator_block` → `append_block` = **commit point** → only then mined-tx bookkeeping, finality,
   receipts, payout records, stats, snapshot. Any failure before the commit point restores the snapshot
   exactly and requeues the drained (already verified) transactions. Fault-injection tests
   (`producer_and_unbonding_tests`): root computation / validator persistence (after the store was
   mutated) / append failures leave tip, ledger, validators, unbonding, base fee and bridge store
   unchanged; a retry equals a clean node that never saw the failure.
2. **Matured unbonding is pre-root.** `release_matured_unbonding` runs inside `apply_balance_block`
   (after tx effects, before fee distribution) for producer, importer and recovery alike, credits each
   matured entry exactly once and removes it; `apply_validator_block` no longer touches balances /
   token / LP maps (regression `post_root_validator_apply_cannot_mutate_balance_maps`). The pending
   queue is **persisted in the snapshot** (`unbonding_queue`; it was previously lost on every restart);
   on the fork chain a post-fork snapshot without it is rejected ⇒ deterministic recovery. Regression
   `matured_unbonding_is_credited_before_root_and_reproduced_by_peer_restart_and_recovery`: no release
   at release_height−1, credit committed in the header root at release_height via the LOCAL MINER, peer
   importer recomputes the same root, snapshot restart and no-snapshot recovery reproduce it.
   Note: the `validator_store.unbonding` sled tree is dead (never written); digests/assertions now read
   the in-memory queue, which IS the consensus queue.
3. **Peer sync = verified import only.** `L1Node::reset_chain` and `rebuild_balances` (a second
   transaction-application implementation) are REMOVED; `peer::apply_peer_blocks` applies every peer
   block through `import_block` and FAILS CLOSED on the first rejection (no chain wipe, no raw replay,
   no longest-chain replacement; the local genesis is always seeded from the genesis config, a peer
   genesis that differs is refused). Regressions (`peer_sync_tests`): fresh random node 0→49 via verified
   import only; bad historical checkpoint rejected without reset and sync resumes with honest blocks; bad
   block after F rejected without wipe; incompatible genesis / foreign chain id refused; an equal or
   LONGER divergent peer chain cannot replace the established chain.
4. **Chain-id gate.** The fork rules (checkpoint era, F−1 assertions/marker, readiness guard,
   migration) apply only to `FORK_CHAIN_ID = rougechain-mainnet-1`; the testnet (`rougechain-devnet-1`,
   same binary) and test chains run plain recompute-and-verify at every height. Without this the fork
   binary would have refused to start the testnet (tip ≥ 48, no marker).
5. **Genesis seed applied once.** `init()` → `recover_from_history` applies the genesis allocations /
   validators; the second application in `main.rs` on first boot (a double credit on any chain with
   allocations — mainnet has none) is removed.

## Tables (`core/daemon/src/fork_tables.rs`, generated by `gen_fork_tables.py` from the immutable fixtures +
production maps/validators at 48 + `fork-decision/canonical_state_48.json`; every hash recomputed by tests)
CHECKPOINT_TABLE_SHA256 `2d979994dbe21559efb2a7ee1aa67911218fbe9bdb2fe04c1c8319aa5486ad67` ·
PRODUCTION_LEDGER_TABLE_SHA256 `bb8ea37fa0f2ad85611bfbd806405efaf9f5b5fb5340b100a18c63cc8c560b60` ·
CANONICAL_LEDGER_TABLE_SHA256 `898c284e12f4f5ba5a5cb261bc39df4d81cacd5557e4362dfebc1ddeafccbed8` ·
CANONICAL_DELTA_TABLE_SHA256 `893daa55ff4f99e035e618cad9623b1c79ef7b26c2507b7e9b2e39c562376b6a` ·
TOKEN_LP_TABLE_SHA256 `7c2e1dfd003ff0f869886f768cc88bd07ff89cf941ed5e9212d44c952356a9dd` ·
PRODUCTION_VALIDATOR_TABLE_SHA256 `7d18ef13a7437a4527e4eabee7471ae3a40acd3e5254edb8a2639cb35f394744` ·
CANONICAL_VALIDATOR_TABLE_SHA256 `817e4fe136444a5078feee93016b8e4145eb394d42d9ddc7ea338fab09ca702d` ·
VALIDATOR_TRANSITION_TABLE_SHA256 `3f920d775a94e61b3998f7f34dd32ab34d18c475a76dda1a0efa4a82a805bb56`.

CANONICAL_DELTA (quanta): `__treasury__` −1025507909942; `rouge168fd…qxj` −8576084154794; `rouge19emhc…er4c`
−652612347834; `rouge1qm85…c378` −874686701; sum −10,255,079,099,271 (= 10,255.079099271 XRGE, unchanged total —
the phantom pool only re-splits once `c97f59a2…` earns no fee share); 0 end-user rows. Canonical root at 48:
`35136edda4607c09…`.

Validator tables carry the CONSENSUS-RELEVANT fields `(pubkey, stake, slash_count, jailed_until, missed_blocks,
total_slashed)`. `blocks_proposed`, `entropy_contributions`, `name` are informational (never read by proposer
selection, quorum or slashing), are excluded from the tables/parity digests and are left untouched by the
migration. (Finding: `blocks_proposed` is incremented twice per imported block — informational only.)

| validator | production @48 | canonical @48 | transition |
|---|---|---|---|
| `8ccf7878…` (genesis, `rouge168fd…`) | stake 100,000, missed 0 | stake 100,000, missed 0 | set (unchanged) |
| `21e0ed0a…` (h20 stake, `rouge19emhc…`) | stake 10,000, missed 29 | stake 10,000, missed 29 | set (unchanged) |
| `c97f59a2…` (h29 stake, `rouge1qm85…`) | stake 10,000, missed 20 — **never debited** | absent | **remove** |
| total / quorum (`total*2/3+1`) | 120,000 / 80,001 | **110,000 / 73,334** | |

`total_fees_burned` (persisted accumulator, not in the state root, never read by execution) is pinned too:
PRODUCTION_FEES_BURNED_BITS_AT_F_MINUS_1 = 0.21323826751842256 (phantom-era) →
CANONICAL_FEES_BURNED_BITS_AT_F_MINUS_1 = 0.11401217199999998 (exact f64 bits; fresh sync reproduces it —
asserted at F−1 on import).

## Migration (`--migrate-canonical-ledger`, operator-invoked, one-time, atomic — ledger, validators, fees_burned)
Requires tip == 48, ledger == PRODUCTION_LEDGER_AT_F_MINUS_1 (every account + token/LP hash), validator set ==
PRODUCTION_VALIDATOR_STATE_AT_F_MINUS_1 (all consensus fields), empty unbonding queue, fees_burned ==
PRODUCTION_FEES_BURNED_BITS; already-canonical (all three) ⇒ recognized (idempotent); any one component
canonical without the others ⇒ `INCONSISTENT` abort. Applies CANONICAL_DELTA in memory, VALIDATOR_TRANSITION to
the store (full pre-image of the validator trees taken first) and the canonical fees_burned value, verifies all
against the canonical tables, persists the snapshot as ONE sled batch, flushes the validator trees, sets the
marker, re-verifies all; ANY failure ⇒ exact in-memory ledger restore, byte-exact validator-tree restore,
fees_burned (memory + `fee_db["total_burned"]`) restored, marker removed, pre-migration snapshot re-persisted,
abort. Never runs on restart.

### Not consensus state (finding, unchanged): `nonce_db`
Block import records `tx.nonce` per sender without validating it (`validate_and_increment_nonce` is mempool
admission only), and the pre-existing startup heuristic `migrate_nonce_db` wipes the whole tree whenever any
stored nonce > 10⁹ (timestamp-style). Its contents therefore depend on operational history (fresh sync ≠ restart ≠
recovery) but never on block validity; it is excluded from the parity digests. Diverging mempool admission
between nodes is a pre-existing operational quirk, not a fork concern.

## Recovery / fresh sync
Missing or corrupt snapshot ⇒ `recover_from_history`: reset every derived component (ledger maps, fee_db,
nonce_db, validator store incl. unbonding + meta trees, pool/NFT/metadata/allowance/multisig/contract stores,
marker), reset the chain store to genesis, re-seed genesis validators, re-import every stored block through
`import_block` (checkpoints + canonical rules + F−1 ledger AND validator assertions), persist the snapshot
atomically. A brand-new node (random identity, empty dir, genesis, blocks) reaches the same state by
construction (`strict_replay_full_history_verifies_every_root` asserts ledger == canonical table, validators ==
canonical table, 110,000/73,334, h29 receipt = failure). Faucet/`bridge_mint` gating uses the genesis authority
set (no node-local identity). `rebuild_balances` keeps the unified fee accounting for the peer-sync path.

## Bridge coordination
`BRIDGE_PAYOUT_STORE_ACTIVATION_HEIGHT = FORK_HEIGHT`: only receipts from height ≥ 49 (R1 typed results) can
ever derive a relayer payout record; historical withdrawals stay audit history. Degraded-store behaviour retained.

## Operator diagnostics
`--print-state-digest`: read-only digests (tip, state root, balances/token/LP/burned/nonce hashes, validators
(consensus fields), `total_stake`, `quorum`, `unbonding`, stakes, shielded, base fee, fees burned, marker;
`validators_informational` reported separately). Zero-valued map entries are not state.
