# R1D — payout-lifecycle hardening (RougeBridge events, timelocks, processed-id, refund safety)

> **Final payout-lifecycle hardening before isolated integration/replay.** Proposed
> daemon/relayer diffs + tests; the model-crate parts (complete-intent requirement, fee
> policy, value validation, canonical RougeBridge id + frozen vector) are implemented + tested
> in `core/bridge-exec` (18 tests green). **Nothing compiled/deployed here.** Containment held:
> V2 + RougeBridge (recommended) paused, relayer stopped, `AUTO_REFUND=false`, UI maintenance,
> `QV_BRIDGE_WITHDRAW_PAUSED=true` before any restart.

Contract facts (from `contracts/contracts/RougeBridge.sol`):
- `releaseETH(to, amount, l1TxId)` `onlyOwner nonReentrant whenNotPaused` (`:137-158`): reverts
  `AlreadyProcessed` if `processedL1Txs[l1TxId]`; if `amount >= largeWithdrawalThreshold`
  **queues a timelock** (emits the timelock event) instead of paying now; else pays and emits
  `BridgeReleaseETH(to, amount, l1TxId)`.
- `releaseERC20(token, to, amount, l1TxId)` (`:160-181`): reverts `UnsupportedToken()` unless
  `supportedTokens[token]`; `safeTransfer`; emits `BridgeReleaseERC20(to, token, amount, l1TxId)`
  and the ERC20 `Transfer(RougeBridge → to, amount)` from the token contract.
- `processedL1Txs(bytes32) -> bool`; `pause()` `onlyGuardian` (`:234-236`); `setSupportedToken`
  `onlyOwner` (`:247`); large-withdrawal timelock + `executeTimelock` (`:200`, `whenNotPaused`).

## 1. Complete signed intent (DONE — model crate)
`authorize_bridge_withdraw` requires the signed payload to contain `type, amount, evmAddress,
tokenSymbol, fee, from, timestamp` (daemon checks `from`/`timestamp`; the crate requires
amount/destination/fee/token). `account_nonce` stays optional for R1. Nothing security-relevant
is invented post-verification (the XRGE server-side fee carve-out is **removed** — see
`R1C_SIGNED_INTENT_BINDING.md §4`).

## 2. Bridge fee policy (DONE — model crate)
`BRIDGE_FEE_XRGE = 0.1`. The **signed** fee must consume exactly `fee_to_quanta(0.1)` for
qETH/qUSDC/qBTC/XRGE. Rejected: missing fee (`MissingSignedField`), and non-finite / negative /
zero / any signed fee whose consumed quanta ≠ 0.1 XRGE (`InvalidFee`). The official SDK/UI signs
0.1, so supported clients are compatible. Dynamic bridge-fee design is separate work.

## 3. Authorization value validation (DONE — model crate)
`authorize_bridge_withdraw` fails before submission on `amount == 0` (`ZeroAmount`), missing
destination (`MissingSignedField`), empty/blank destination (`EmptyDestination`), invalid fee
(`InvalidFee`). Token-specific destination **format** validation stays in the daemon submission
path (`node.rs:2011-2023`: EVM for qETH/qUSDC/XRGE, Bitcoin for qBTC).

## 4. Require RougeBridge for qETH/qUSDC production payouts (proposed relayer diff)
Remove the silent fallback to a direct wallet ETH send (`bridge-relayer.ts:663-675`). qETH →
`RougeBridge.releaseETH`, qUSDC → `RougeBridge.releaseERC20`. If `ROUGE_BRIDGE_ADDRESS` is absent
or invalid: **FAIL CLOSED, NO PAYOUT.**
```diff
-  if (bridgeContract) { ...releaseETH... } else { ...direct native sendTransaction... }
+  if (!bridgeContract) {
+    logAlert("ROUGE_BRIDGE_ADDRESS missing/invalid — refusing payout (fail closed)");
+    continue; // no payout; leave pending
+  }
+  // qETH → releaseETH; qUSDC → releaseERC20 (see R1B §5)
```
A legacy direct-send mode, if kept for test environments, is **explicitly opt-in**
(`QV_BRIDGE_ALLOW_DIRECT_SEND=true`, default off) and **must not** participate in automatic
refunding.

## 5. Canonical RougeBridge withdrawal id (DONE — model crate; frozen vector)
`rouge_bridge_id(stored_tx_id) = keccak256(UTF8(stored_tx_id))` — the SINGLE `bytes32 l1TxId`
used everywhere: relayer release, event verification, `processedL1Txs` query, reconciliation,
refund guard. Matches the relayer's existing `keccak256(toBytes(w.tx_id))`
(`bridge-relayer.ts:657`). **Frozen vectors** (test `r1d_canonical_rouge_bridge_id_frozen_vector`):
- `keccak256("")` = `c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470`
- a bare qETH/qUSDC id and its `xrge:`-prefixed form hash to **different** ids (the stored string,
  prefix included, is the preimage). The daemon must compute the id from the exact stored
  `tx_id` string, and the relayer must pass that same id as `l1TxId`.

## 6. Correct qETH payout verification (proposed daemon diff)
`verify_native_eth_payout` (`main.rs:7963-8020`) checks `tx.to == recipient` — **wrong**, because
the tx is sent to the RougeBridge contract. Replace the qETH branch with event verification:
```
require: receipt.status == success
require: tx.to == configured RougeBridge contract
require: a log BridgeReleaseETH(recipient, amount, l1TxId) emitted BY the configured RougeBridge
         where recipient == withdrawal recipient
               amount    >= amount owed (amount_units × 10^12 wei)
               l1TxId    == rouge_bridge_id(stored_tx_id)
require: confirmation depth satisfied (bridge_min_confirmations)
```
Decode the `BridgeReleaseETH` topic/data from the receipt logs filtered to the RougeBridge
address (mirror `parse_erc20_transfer_to`, `main.rs:7106-7173`, for log decoding). **The
transaction destination must be the configured RougeBridge**, and the event emitter must be it.

## 7. Correct qUSDC payout verification (proposed daemon diff)
Require BOTH, in the successful receipt:
```
BridgeReleaseERC20(recipient, USDC, amount, l1TxId) emitted by the configured RougeBridge:
    recipient == expected · token == configured Base USDC · amount >= amount_units · l1TxId == canonical id
AND the Base USDC Transfer emitted by the configured USDC contract:
    from == RougeBridge contract (NOT the custody/relayer signer) · to == expected recipient · amount >= amount_units
require: receipt.status == success, tx.to == RougeBridge, confirmation depth satisfied
```
**Correction:** the ERC20 `Transfer` source is the **RougeBridge contract**, not the
custody/relayer signer. qUSDC stays **1:1** with Base USDC base units (no 10^12 scaling) — see
`R1B §6`.

## 8. RougeBridge timelocks (proposed relayer diff — persisted queued state)
A large withdrawal makes `releaseETH`/`releaseERC20` succeed **without** an immediate payout: the
initial tx emits the **timelock-queued** event instead of `BridgeReleaseETH`/`BridgeReleaseERC20`.
That is NOT a payout failure, fulfillment, or refund trigger.
```
release tx emits BridgeReleaseETH / BridgeReleaseERC20  → verify (§6/§7) → mark fulfilled
release tx emits the timelock-queued event             → record locally as QUEUED (canonical l1TxId);
                                                          do NOT retry release / report failure / auto-refund;
                                                          monitor RougeBridge events for that l1TxId
later executeTimelock tx emits the matching BridgeRelease → verify that execution tx (§6/§7)
                                                          → fulfill using THAT tx hash
```
Do not add a daemon-store enum variant if it complicates backward compatibility. A **separate
relayer-side persisted queued-withdrawal state** is acceptable for R1 and **must survive relayer
restart** (extend the existing `.bridge-processed-txs.json` persistence pattern with a
`.bridge-queued-txs.json`, keyed by canonical l1TxId). **The exact queue binding, event
signatures, processed-id classification, cancellation handling, and refund gate are specified in
`R1E_TIMELOCK_LIFECYCLE.md`** — `TimelockQueued(requestId, executeAfter)` carries no l1TxId, so a
queued withdrawal is bound via the `timelockQueue(requestId)` getter (see R1E §2/§4).

## 9. Processed-id reconciliation before treating a retry as failure (proposed relayer diff)
Before counting a qETH/qUSDC retry as failure, query `RougeBridge.processedL1Txs(canonicalId)`:
```
false → RougeBridge accepted no release/queue for this id (safe to (re)attempt per normal flow)
true  → already paid OR queued for timelock:
        DO NOT call release again · DO NOT report payout failure · DO NOT auto-refund
        → search RougeBridge events (BridgeReleaseETH / BridgeReleaseERC20 / timelock-queued)
          for the canonical l1TxId and reconcile from on-chain truth
```

## 10. Refund safety for every asset (proposed relayer/daemon diff)
The XRGE refund guard uses BridgeVaultV2 `processedL1Txs`. Add equivalent fail-closed logic for
qETH/qUSDC using `RougeBridge.processedL1Txs(canonicalId)`:
```
before re-minting qETH/qUSDC:
    processedL1Txs(canonicalId) == true   → REFUND REFUSED
    RPC/query fails                        → REFUND REFUSED (fail closed)
    only positively proven false           → an automated refund MAY be considered
qBTC:        NO automated refund until absence of a Bitcoin payout is deterministically proven
unsupported: NO refund
```
`AUTO_REFUND=false` stays throughout incident remediation and initial rollout.

## 11. RougeBridge production preflight (proposed relayer startup check)
Before eventual relayer startup, verify on-chain and **fail startup** if any is wrong:
```
configured chain id is correct
code exists at ROUGE_BRIDGE_ADDRESS
RougeBridge owner / authorized release signer matches operational config
RougeBridge paused state is known (and expected)
Base USDC address is correct (matches the daemon's bridge_usdc_address per chain)
RougeBridge.supportedTokens(USDC) == true
```
Do not discover these after burning someone's qUSDC.

## 12. qETH/qUSDC relayer tests (specs — isolated hardware at step 15)
1. **Immediate qETH** — release tx emits matching `BridgeReleaseETH` → fulfilled **exactly once**.
2. **Queued qETH** — release tx emits the timelock-queued event → **no** retry, **no** failure
   counter, **no** refund; a later matching `BridgeReleaseETH` from `executeTimelock` fulfills it.
3. **Immediate qUSDC** — matching `BridgeReleaseERC20` + USDC `Transfer(from=RougeBridge)` →
   fulfilled.
4. **Wrong recipient / wrong amount / wrong l1TxId / wrong token / wrong emitting contract** →
   each **rejected**.
5. **Processed id** — `processedL1Txs == true` → no duplicate release and no refund.
6. **RPC outage during refund check** → **fail closed, no mint**.

## 13. R1C tests tightened (DONE — model crate)
`r1d_fee_policy_and_value_validation`: missing fee → reject; fee ≠ 0.1 → reject; negative/zero/
non-finite fee → reject; zero amount → reject; empty/blank destination → reject; exactly-0.1 fee
passes for qETH/qUSDC/qBTC/XRGE. The XRGE "payload fee missing → silently use 0.1" carve-out is
removed from the handler proposal (§4 of the R1C spec).

## 14. Prior protections retained
R1 (burn-success result; failed/None → no payout record; indexed results; post-acceptance store
persistence; inline arithmetic instrumented, not replaced), R1B (no default ETH route; explicit
qETH/qUSDC/qBTC/XRGE routing; unsupported → no payout; qUSDC 1:1 Base-USDC units), R1C (signed
payload authoritative; operation binding; amount/destination/fee/token binding; mandatory
signer/from binding; cross-endpoint rejection; raw-private-key path default-off) — all unchanged.

## 15. Then isolated integration / replay (do NOT start here)
After R1D is incorporated: (1) compile daemon off production, (2) compile relayer, (3) run
R1/R1B/R1C/R1D integration tests, (4) payout-event + timelock tests, (5) historical bridge
reconciliation, (6) replay current vs patched from the same snapshot, (7) compare every block:
balances, token_balances, lp_balances, burned_tokens, nonce_db, block hashes, committed state
roots. **Any difference → STOP.** No deploy / no production restart / no relayer restart / no
unpause of BridgeVaultV2 or RougeBridge.

## Stop
Model core (complete intent, fee policy, value validation, canonical id + frozen vector)
implemented + green (18 tests). Payout-event verification, timelock handling, processed-id
reconciliation, refund safety, and preflight provided as **proposed diffs + test specs**. Nothing
compiled or deployed; live node/relayer/vault untouched; V2 + RougeBridge remain (recommended)
paused. Stopped for final pre-rollout review.
