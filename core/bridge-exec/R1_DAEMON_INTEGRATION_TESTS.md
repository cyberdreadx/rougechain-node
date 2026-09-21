# R1 — daemon-integration test specs + replay-parity runbook

These run **only on the isolated branch / non-prod hardware** once §1c of
`R1_REMEDIATION.md` is applied and the daemon compiles there. They are NOT run on the live
box. The 9 model-level tests already pass in `core/bridge-exec` (`cargo test -p
quantum-vault-bridge-exec`); the specs below are the daemon-side coverage that the model
crate cannot exercise (real block application, state-root verification, the sled store, and
receipt generation).

## A. Integration tests (against a throwaway in-memory / temp-dir node)

1. **`double_withdraw_produces_one_payout`** — fund an account for exactly one 100-XRGE
   withdrawal (+fee). Submit two `bridge_withdraw` txs in a block. After acceptance:
   `burned["XRGE"] == 100`, balance debited once, and the payout store holds **exactly one**
   record.
2. **`result_index_alignment_after_skipped_tx`** — build a block whose `tx[0]` hits an early
   `continue` in `apply_balance_block` (e.g. an invalid/guard-skipped tx) and whose `tx[1]`
   is a successful `bridge_withdraw`. Assert `bridge_results[0] == None`,
   `bridge_results[1] == Some(Success(..))`, and that the one store record's owner is
   `tx[1]`'s sender (not `tx[0]`'s).
3. **`successful_xrge_payout_record`** — one solvent XRGE withdrawal → exactly one store
   record, `xrge:`-prefixed `tx_id`, `token == "XRGE"`, destination == the tx's `evm_address`.
4. **`failed_xrge_burn_no_store`** — an insolvent XRGE withdrawal → burn not applied, **no**
   store record, receipt `TxStatus::Failed`.
5. **`qbtc_success_btc_record`** — a solvent qBTC withdrawal whose destination is a **Bitcoin**
   address → one store record with `token == "qBTC"` and the BTC address preserved verbatim
   (proves R1 does **not** EVM-format the destination).
6. **`qeth_success_generic_record`** — a solvent qETH withdrawal → one store record with
   `token == "qETH"`, no `xrge:` prefix.
7. **`mixed_case_xrge_routes_to_xrge`** — a withdrawal with `token_symbol` `"xrge"`/`"XrGe"`
   canonicalizes to `"XRGE"`, gets the `xrge:` prefix, and is treated as an XRGE payout
   (matches `is_xrge_withdrawal` in `main.rs`).
8. **`missing_result_fails_closed`** — force `bridge_results[i] == None` for a
   `bridge_withdraw` position (e.g. a guard path) → receipt is
   `Failed("missing bridge execution result")` and **no** store record.
9. **`rejected_bad_state_root_block_leaves_zero_store_side_effects`** *(the attack
   regression)* — construct a block containing a valid-looking solvent `bridge_withdraw` but
   with a **deliberately invalid committed state root**. Apply it: `apply_balance_block`
   returns its results, state-root verification **fails**, the block is **rejected**,
   speculative balances are rolled back. Assert: the payout store is **unchanged** (zero new
   records), because `persist_bridge_withdraw_results` runs **only** on the accepted path.
   This is the core R1 guarantee — a payout record can exist only for an accepted, persisted
   block.
10. **`failed_burn_per_token_reaches_no_payout_list`** — for XRGE, qETH, and qBTC, an
    insolvent burn produces **no** store record on any of the three payout lists.

Routing assertions (tests 3/5/6/7) confirm: successful XRGE → the XRGE payout list
(`is_xrge_withdrawal` true), qETH → the generic EVM list, qBTC → the BTC list
(`is_btc_withdrawal` true), and a failed burn for each token → **no** list.

## B. Historical replay-parity runbook (REQUIRED — gates the "non-consensus" claim)

On **isolated non-prod hardware**, from an **isolated branch**, against a **read-only**
mainnet chain-DB snapshot:

1. Copy the chain DB snapshot to non-prod hardware; mark it read-only.
2. Build two binaries from the same snapshot checkout: **current** (`main`) and
   **R1-patched** (this branch with §1c applied).
3. Replay full history from genesis with each binary into separate output DBs.
4. After **every block height**, diff the two:
   - `balances`
   - `token_balances`
   - `lp_balances`
   - `burned_tokens`
   - `nonce_db`
   - block hash
   - **committed state root**
5. **Pass = byte-identical at every height.** Any divergence at any height ⇒ **STOP**: R1
   altered consensus state; reclassify and do not deploy.
6. Record the highest replayed height and a hash-of-hashes of the per-block state roots for
   both binaries in the PR once parity is achieved.

Only after B passes byte-identical may the PR drop "pending replay-parity proof" and
describe R1 as an established state-preserving / non-consensus patch.

## C. Relayer routing + cross-asset tests
See `R1B_CROSS_ASSET_ROUTING.md §10` — qETH→ETH-only, qUSDC→USDC-ERC20-only (1:1, no
×10¹²), qBTC→BTC-only, XRGE→vault-only, arbitrary token→no payout on any path, cross-asset
fulfillment rejection, and the qUSDC deposit→mint→withdraw 1:1 conversion round-trip. These
run alongside A/B on isolated hardware at step 13.

## Not run here
None of A or B is executed in this worktree or on the live box. The daemon is not wired or
compiled here; `/srv/rougechain` is untouched; no deploy, no restart, no relayer change, V2
remains paused.
