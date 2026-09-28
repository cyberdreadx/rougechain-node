# R1E — RougeBridge timelock lifecycle (queue binding, processed-id classes, cancellation, refund)

> **Final timelock-lifecycle correction before isolated integration/replay.** Model-crate
> reconciliation logic is implemented + tested in `core/bridge-exec` (21 tests green); the
> relayer/daemon wiring is proposed diffs. **Nothing compiled/deployed here.** Containment
> held (V2 + RougeBridge recommended paused, relayer stopped, `AUTO_REFUND=false`, UI
> maintenance, `QV_BRIDGE_WITHDRAW_PAUSED=true` before any restart).

Contract facts (verified in `contracts/contracts/RougeBridge.sol`):
- `event TimelockQueued(uint256 indexed requestId, uint256 executeAfter)` (`:80`) — **no
  l1TxId.** A queued withdrawal CANNOT be identified from this event alone.
- `event TimelockCancelled(uint256 indexed requestId)` (`:82`); `TimelockExecuted(requestId)`
  (`:217`).
- `struct TimelockRequest { address token; address to; uint256 amount; bytes32 l1TxId;
  uint256 executeAfter; bool executed; bool cancelled; }` (`:36-44`); public array getter
  `timelockQueue(uint256)` (`:48`).
- `mapping(bytes32 => bool) processedL1Txs` set true on **every** accepted release/queue
  (`:147, :172`); `releaseETH`/`releaseERC20` revert `AlreadyProcessed` if already true.
- `executeTimelock` rejects `req.executed || req.cancelled` (`:203`) and emits
  `BridgeReleaseETH`/`BridgeReleaseERC20` + `TimelockExecuted`; `cancelTimelock`
  (`onlyGuardian`) sets `cancelled=true` (`:224`).

## 1. Pin the exact TimelockQueued event
`TimelockQueued(uint256 indexed requestId, uint256 executeAfter)` carries only
`requestId`/`executeAfter`. Do **not** try to identify a queued withdrawal from this event
alone — decode `requestId` + `executeAfter`, then bind via the getter.

## 2. Bind requestId to the canonical withdrawal (DONE — model crate)
After a successful `releaseETH`/`releaseERC20` tx emits `TimelockQueued`:
1. decode `requestId`, `executeAfter`;
2. call `timelockQueue(requestId)`;
3. verify the full record against the expected withdrawal via `timelock_record_matches`:
   - **qETH:** `token == address(0)`, `to == recipient`, `amount == owed wei`,
     `l1TxId == rouge_bridge_id(stored_tx_id)`, `executeAfter == event.executeAfter`,
     `executed == false`, `cancelled == false`.
   - **qUSDC:** `token == configured Base USDC`, `to == recipient`,
     `amount == amount_units`, `l1TxId == canonical id`, `executeAfter == event.executeAfter`,
     `executed == false`, `cancelled == false`.
   Any mismatch → **ALERT, NO RETRY, NO REFUND, manual review** (classifies `Ambiguous`).
`timelock_record_matches(rec, exp)` compares addresses case-insensitively, everything else
exact. (`executed`/`cancelled` select the *class*, not the binding — see §4.)

## 3. Persist the exact queue binding (proposed relayer state)
A relayer-side `.bridge-queued-txs.json` (survives restart), keyed by canonical l1TxId, with:
```
stored_tx_id · canonical_l1_tx_id · request_id · asset · recipient · amount ·
execute_after · release_submission_tx_hash
```
Canonical l1TxId is the primary identity; `request_id` is the concrete RougeBridge queue
reference used to re-read `timelockQueue(requestId)`.

## 4. Correct processedL1Txs semantics (DONE — model crate)
`processedL1Txs == true` means only "RougeBridge accepted this id once" — **never** "paid".
`classify_processed(OnChainFacts{ verified_release, queue, expected })` reconciles into exactly
one class:
- **Paid** — a verified matching `BridgeReleaseETH`/`BridgeReleaseERC20` exists → mark fulfilled.
- **Queued** — matching `timelockQueue(requestId)` with `executed==false && cancelled==false`
  → wait; **no retry, no failure counter, no refund**.
- **CancelledRefundCandidate** — matching queue with `executed==false && cancelled==true` →
  payout did NOT occur through that request and can never execute; do **not** mark fulfilled.
- **Ambiguous** — processed but no verified release and no uniquely-bound queue state (includes
  a non-matching queue, or `executed==true` without a verifiable release) → **fail closed**: no
  retry, no refund, manual investigation.

## 5. Handle TimelockCancelled (proposed relayer diff)
On `TimelockCancelled(requestId)` for a persisted queue entry:
1. wait the required Base confirmations;
2. re-read `timelockQueue(requestId)`;
3. require `cancelled==true && executed==false`;
4. verify all original fields still match the stored withdrawal (`timelock_record_matches`).
Then classify as **CancelledRefundCandidate**. Do **not** auto-refund during incident rollout.

## 6. Safe refund rule for qETH/qUSDC (DONE — model crate)
`refund_decision(processed, class)` refines the earlier `processed==true → refused` rule:
```
processed == false                          → NormalAnalysis (no release accepted; may analyze)
processed == true & Paid                    → Forbidden
processed == true & Queued                  → Forbidden
processed == true & CancelledRefundCandidate → MayProceedAfterCancellationProof
processed == true & Ambiguous               → Forbidden
```
The daemon must treat an **RPC/query failure** as "cannot prove false" and refuse outright —
never call `refund_decision(processed=false)` on a failed read. `AUTO_REFUND=false` remains
mandatory for the initial rollout; a `CancelledRefundCandidate` is surfaced for manual/operator
disposition first, only after deterministic cancellation proof.

## 7. Cancellation safety argument (verified against the contract)
A queue entry with `cancelled==true && executed==false` can never later execute:
`executeTimelock` reverts on `req.executed || req.cancelled` (`RougeBridge.sol:203`). And
`processedL1Txs[l1TxId]` stays `true` (`:147/:172`), so the same canonical id can never be
re-queued via `releaseETH`/`releaseERC20` (they revert `AlreadyProcessed`, `:144/:168`).
Therefore a properly-bound cancelled request is a **deterministic** safe-refund candidate.

## 8. Timelock lifecycle tests
Model crate (`r1e_*`, green): queue-binding match; each mismatch (l1TxId / recipient / token /
amount / executeAfter) → not bound (→ Ambiguous); classify Paid / Queued /
CancelledRefundCandidate / Ambiguous (incl. `executed==true` without verified release → Ambiguous,
and non-matching queue → Ambiguous); `refund_decision` fail-closed for every class.
Relayer/daemon specs (isolated hardware, step 10):
1. **Queue binding** — `TimelockQueued(requestId)` + getter matching → Queued.
2. **Wrong queue l1TxId / recipient / token / amount** → Ambiguous / fail closed.
3. **Cancellation** — `TimelockCancelled(requestId)` + getter `cancelled=true, executed=false`
   → CancelledRefundCandidate.
4. **Active queue** — `cancelled=false, executed=false` → no refund.
5. **Executed queue** — verified `BridgeRelease*` → Paid (fulfilled once).
6. **processed=true, no explainable state** → Ambiguous, no refund.

## 9. Cross-language canonical-id vector (DONE)
`rouge_bridge_id` frozen vectors, pinned identically in Rust
(`r1d_canonical_rouge_bridge_id_frozen_vector`) and TypeScript
(`scripts/bridge-canonical-id.vector.test.ts`, using the relayer's own viem):
| input (UTF-8) | keccak256 |
|---|---|
| `""` | `0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470` |
| `00000000000000000000000000000000000000000000000000000000000000ff` | `0x337ed4d89269c740d540763c75cbe3c32781be676d35104745fa5b46fa5f377f` |
Plus the prefixed-vs-unprefixed differentiation (`xrge:` prefix changes the hash). Both
implementations reproduce the same bytes32. (The non-empty value was computed with the
authoritative Ethereum keccak; the empty-input row proves it is keccak, not NIST SHA3.)

## 10. Then isolated integration / replay (do NOT start here)
After R1E is committed: apply the actual daemon + relayer wiring; compile both; run all
R1/R1B/R1C/R1D tests, the queue/cancel lifecycle tests, signed-intent tamper tests, cross-asset
payout tests, read-only historical reconciliation, and full-history replay parity. Compare after
**every block**: balances, token_balances, lp_balances, burned_tokens, nonce_db, block hashes,
committed state roots. **Any difference → STOP.** No deploy / no production restart / no
production-relayer restart / no unpause of BridgeVaultV2 or RougeBridge.

## Stop
Timelock reconciliation core (queue binding, processed-id classes, cancellation, refund gate)
implemented + green (21 tests); canonical-id cross-language vectors pinned in Rust + TS. Relayer/
daemon timelock wiring provided as proposed diffs + specs. Nothing compiled or deployed; live
node/relayer/vault untouched; V2 + RougeBridge remain (recommended) paused. Stopped for final
pre-rollout review.
