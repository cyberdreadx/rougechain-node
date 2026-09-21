# R1B — cross-asset routing fix (generic relayer must not pay every token as ETH)

> **Second live bridge vulnerability, independent of the payout-without-burn drain.**
> The generic withdrawal relayer ignores `token_symbol` and always releases **native ETH**,
> so qUSDC and arbitrary/custom-token withdrawals can be paid as ETH. This spec is the
> relayer/API/fulfillment side of the fix; the model-crate side (`payout_route`,
> `is_payout_eligible`) is already implemented + tested in `core/bridge-exec` (see
> `R1_REMEDIATION.md`). **Proposed diffs only — nothing compiled/deployed here.** The
> relayer + daemon compile and the integration/replay runs happen on isolated hardware at
> step 13, after this fix is on the R1 integration branch.

## 0. Containment (must hold before any daemon restart)
- BridgeVaultV2 **paused**, bridge-relayer **stopped**, `AUTO_REFUND=false`, bridge UI/API
  in **maintenance**.
- Set **`QV_BRIDGE_WITHDRAW_PAUSED=true`** before any daemon restart (env kill switch,
  `check_withdraw_guardrails`, `core/daemon/src/main.rs:7208-7220` — requires restart to
  take effect; it gates the two HTTP admission handlers).
- **Recommend pausing the on-chain `RougeBridge` via its guardian** until reconciliation +
  remediation complete: `RougeBridge.pause()` is `onlyGuardian`
  (`contracts/contracts/RougeBridge.sol:234-236`; `unpause()` is `onlyOwner:238-240`). All
  release paths carry `whenNotPaused`. The relayer's `ROUGE_BRIDGE_ABI`
  (`scripts/bridge-relayer.ts:196-199`) does **not** include `pause` — the operator/guardian
  pauses directly, not via the relayer.

## 1. Confirmed vulnerability (evidence)
1. Admission accepts an **arbitrary** `tokenSymbol` with **no allowlist** — only qBTC/XRGE
   are special-cased. `bridge_withdraw` reads `tokenSymbol` (default `"qETH"`) from the
   signed payload and forwards it verbatim (`core/daemon/src/main.rs:7793-7797, 7841-7847`);
   `submit_bridge_withdraw_tx_signed` stores it verbatim (`core/daemon/src/node.rs:1991-2032`).
2. The generic list is literally *everything that isn't XRGE or qBTC*
   (`main.rs:7926`: `.filter(|w| !is_xrge_withdrawal(w) && !is_btc_withdrawal(w))`). A
   qUSDC or misspelled symbol lands here.
3. The relayer's `EthWithdrawal` has **no token field** and drops any token during
   normalization (`scripts/bridge-relayer.ts:358-365, 376-382`); it always pays via
   `releaseETH(...)` / native `sendTransaction({value: wei})`
   (`:654-676`), with `unitsToWei = amountUnits * 10^12` (`:216-218`). `releaseERC20` is in
   the ABI but **never called**.
4. Fulfillment verifies only a **native ETH** transfer's `value`
   (`verify_native_eth_payout`, `main.rs:7963-8020`; called from
   `bridge_withdrawal_fulfill` at `:8079-8082` with `min_wei = amount_units * 1e12`) — not
   token-aware.

**Net:** a qUSDC withdrawal (or any non-XRGE/non-qBTC symbol the holder has a balance in)
is routed to the ETH relayer and paid/verified as native ETH. Independent of the
payout-without-burn bug.

## 2. Model-crate routing (DONE — `core/bridge-exec`, 11 tests green)
```
payout_route:  XRGE→Xrge · qETH→Eth · qUSDC→Usdc · qBTC→Btc · else→Unsupported
```
- **No default EVM route.** An unknown token maps to `Unsupported`, never `Eth`.
- `is_payout_eligible(exec)` = `Success` + destination present + `payout_route != Unsupported`.
  This is the relayer-facing store gate; `burned_with_destination` is the separate
  execution-level concept (item 3 of the request). An **unsupported successful burn creates
  zero relayer records** (`unsupported_token_success_creates_no_relayer_record` test).
- Consensus burn behavior is **unchanged** — only the derived payout record is gated.

## 3. Public-withdrawal admission allowlist (API hardening — proposed daemon diff)
Reject arbitrary symbols **before** `submit_bridge_withdraw_tx_signed`. `bridge_withdraw`
(`main.rs:7785-7890`) accepts only bridge-supported **EVM/BTC** assets; XRGE keeps its
dedicated `/api/bridge/xrge/withdraw`.
```diff
     let token_symbol = body.payload.as_ref().and_then(|p| p.get("tokenSymbol"))
         .and_then(|v| v.as_str()).unwrap_or("qETH").to_string();
+    // R1B: admit ONLY recognized bridge payout assets on the generic endpoint.
+    // XRGE uses /api/bridge/xrge/withdraw; anything else is rejected before admission.
+    use quantum_vault_bridge_exec::{payout_route, PayoutRoute};
+    match payout_route(&token_symbol) {
+        PayoutRoute::Eth | PayoutRoute::Usdc | PayoutRoute::Btc => {}
+        PayoutRoute::Xrge => return bad_request("Use /api/bridge/xrge/withdraw for XRGE"),
+        PayoutRoute::Unsupported =>
+            return bad_request(&format!("Unsupported bridge asset: {}", token_symbol)),
+    }
```
Use the **same** `payout_route` helper everywhere so admission, storage, listing,
payout, and fulfillment agree on the canonical asset. (This is admission hardening; it does
**not** reinterpret historical transaction execution.)

## 4. Strict API list routing (proposed daemon diff)
The generic list must expose **only explicitly supported EVM assets** (qETH, qUSDC), not
"anything that isn't XRGE or qBTC". Add positive helpers and split the list.
```diff
+fn is_eth_withdrawal(w: &PendingWithdrawal) -> bool { w.token_symbol.eq_ignore_ascii_case("qETH") }
+fn is_usdc_withdrawal(w: &PendingWithdrawal) -> bool { w.token_symbol.eq_ignore_ascii_case("qUSDC") }
```
- `/api/bridge/withdrawals` (`bridge_withdrawals`, `main.rs:7918-7940`):
  ```diff
  -    .filter(|w| !is_xrge_withdrawal(w) && !is_btc_withdrawal(w))
  +    .filter(|w| is_eth_withdrawal(w) || is_usdc_withdrawal(w))
  ```
  and **include `token_symbol` in each serialized record** so the relayer can route
  (the store already carries it — `core/storage/src/bridge_withdraw_store.rs`,
  `PendingWithdrawal.token_symbol`). Optionally split into `/api/bridge/eth/withdrawals`
  and `/api/bridge/usdc/withdrawals`; a single feed carrying `token_symbol` is sufficient
  if the relayer routes on it.
- XRGE stays `/api/bridge/xrge/withdrawals` (`is_xrge_withdrawal`), BTC stays
  `/api/bridge/btc/withdrawals` (`is_btc_withdrawal`).
- **Unsupported/custom symbols appear on NO list.** With §3 admission + the R1
  `is_payout_eligible` store gate, an unsupported symbol never gets a store record in the
  first place; this filter is defense-in-depth for any legacy record.

## 5. Split qETH / qUSDC payout in `scripts/bridge-relayer.ts` (proposed relayer diff)
Preserve `token_symbol` through the type, normalization, and routing; **fail closed** on
anything unrecognized.
```diff
 interface EthWithdrawal {
   txId?: string; tx_id?: string;
   evmAddress?: string; evm_address?: string;
   amountUnits?: number; amount_units?: number;
+  tokenSymbol?: string; token_symbol?: string;   // R1B: carry the asset
 }
```
```diff
 function normalizeEthWithdrawal(w: EthWithdrawal) {
   return {
     tx_id: w.txId || w.tx_id || "",
     evm_address: w.evmAddress || w.evm_address || "",
     amount_units: w.amountUnits || w.amount_units || 0,
+    token_symbol: (w.tokenSymbol || w.token_symbol || "").trim(),
   };
 }
```
Route explicitly in `processEthWithdrawals` (`:636-716`):
```ts
const sym = w.token_symbol.toLowerCase();
if (sym === "qeth") {
  // qETH → native ETH. 1 unit = 1e-6 ETH = 1e12 wei (existing factor, unchanged).
  const wei = unitsToWei(w.amount_units);            // amount_units * 10n**12n
  await bridge.write.releaseETH([w.evm_address, wei, l1TxId], { nonce });
} else if (sym === "qusdc") {
  // qUSDC → Base USDC ERC20. 1:1 base units (BOTH are 6-decimal). NO unitsToWei.
  const usdcAmount = BigInt(w.amount_units);         // pass through unchanged
  await bridge.write.releaseERC20([BASE_USDC_ADDRESS, w.evm_address, usdcAmount, l1TxId], { nonce });
} else {
  // Fail closed: alert, do NOT send, do NOT fulfill, do NOT auto-refund.
  logAlert(`unsupported bridge asset on ETH feed: ${w.token_symbol} (${w.tx_id})`);
  continue; // leave the record pending for manual review
}
```
- `BASE_USDC_ADDRESS` already exists per chain in the relayer config
  (`scripts/bridge-relayer.ts:71-82`; Base mainnet
  `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`). Reuse it — do not hardcode a second copy.
- `releaseERC20(address token, address to, uint256 amount, bytes32 l1TxId)` is already in
  `ROUGE_BRIDGE_ABI` (`:196-199`); the on-chain fn reverts `UnsupportedToken()` unless
  `supportedTokens[usdc]` is set (`RougeBridge.sol:160-181`) — USDC must be in the on-chain
  allowlist (`setSupportedToken`, `onlyOwner`) before qUSDC payouts.
- **Do NOT run qUSDC through `unitsToWei()`** (the ×10¹² factor is only for 18-decimal
  native ETH). Proof of the 1:1 factor: §6.

## 6. qETH / qUSDC conversion specification (proven from the deposit/mint path)
Internal representation: qETH and qUSDC are **both u64 integers at 6 decimals**
(`token_decimals` → 6, `main.rs:1693-1700`; faucet `main.rs:3823-3825`). The difference is
purely the L1 asset's decimals.

| asset | internal unit | L1 asset | L1 decimals | payout call | amount |
|---|---|---|---|---|---|
| qETH | 1 unit = 1e-6 qETH (6-dec) | native ETH | 18 | `releaseETH(to, wei, l1TxId)` | `wei = amount_units × 10¹²` |
| qUSDC | 1 unit = 1e-6 qUSDC (6-dec) | Base USDC ERC20 | 6 | `releaseERC20(USDC, to, amount, l1TxId)` | `amount = amount_units × 10⁰` (**1:1**) |

Evidence for 1:1 USDC: the deposit/mint path credits qUSDC units **equal to the raw
on-chain USDC Transfer base-unit amount, with no scaling** — `core/daemon/src/main.rs:7472-7502`
(`// USDC and qUSDC are both 6-decimal -> 1:1 units`, `let units = u64::try_from(dep.amount)…`),
where `dep.amount` is the verbatim ERC20 Transfer value (`parse_erc20_transfer_to`,
`:7106-7173`). qETH deposit divides wei by 1e12 (`:7452-7471`, `18-dec ETH -> 6-dec qETH`),
which is exactly the inverse of `unitsToWei`. Therefore a qUSDC payout of `N` internal units
= `N` Base-USDC base units. **A test must pin this** (round-trip: mint N from a USDC deposit
of N base units ⇒ withdraw N ⇒ releaseERC20 amount == N).

## 7. Token-aware fulfillment verification (proposed daemon diff)
`bridge_withdrawal_fulfill` (`main.rs:8022-8090`) currently always calls
`verify_native_eth_payout`. Split on the stored canonical token:
```diff
-    let min_wei = (record.amount_units as u128).saturating_mul(1_000_000_000_000u128);
-    verify_native_eth_payout(&client, &rpc, &payout_hash, &custody, &record.evm_address, min_wei).await
+    use quantum_vault_bridge_exec::{payout_route, PayoutRoute};
+    match payout_route(&record.token_symbol) {
+        PayoutRoute::Eth => {   // native ETH, existing check
+            let min_wei = (record.amount_units as u128).saturating_mul(1_000_000_000_000u128);
+            verify_native_eth_payout(&client, &rpc, &payout_hash, &custody, &record.evm_address, min_wei).await
+        }
+        PayoutRoute::Usdc => {  // Base USDC ERC20 Transfer(custody -> recipient), 1:1 units
+            let min_amount = record.amount_units as u128;    // NO 10^12
+            let usdc = bridge_usdc_address().ok_or("USDC not configured")?;
+            verify_erc20_payout(&client, &rpc, &payout_hash, &usdc, &custody, &record.evm_address, min_amount).await
+        }
+        _ => return reject("fulfillment asset not fulfillable on the EVM endpoint"),
+    }
```
`verify_erc20_payout` mirrors `verify_native_eth_payout` but decodes the ERC20 **Transfer**
log (reuse `parse_erc20_transfer_to`, `main.rs:7106-7173`) instead of the native `value`,
and checks: token == configured USDC, `from == custody`, `to == recipient`,
`amount >= min_amount`, receipt status `0x1`, and the same confirmation depth
(`bridge_min_confirmations`). **A qUSDC record must not be fulfillable by an ETH tx and
vice-versa** — the `match` guarantees it. (XRGE fulfill `xrge_bridge_fulfill`,
`main.rs:8649-8734`, is already token-aware via `parse_erc20_transfer_to` at 1e18; BTC
fulfill checks qBTC — both unchanged.)

## 8. Historical pending reconciliation (expanded — report only)
The read-only reconciliation report (R1 §6) now classifies **both** burn execution **and**
expected payout asset. Fields:
```
tx_id · block_height · tx_index · token_symbol_raw · token_symbol_canonical ·
burn_status · expected_payout_route · amount · destination ·
existing_store_status · existing_payout_tx_hash
```
**Flag** any record where: `burn_status != BurnConfirmed`, OR
`expected_payout_route == Unsupported`, OR an existing payout used a **different asset**
than `expected_payout_route` (e.g. a qUSDC record with an ETH `existing_payout_tx_hash` —
the actual cross-asset mispayment). **Report only; no automatic mutation/refund.** Keep
`AUTO_REFUND=false` until every flagged record is manually dispositioned.

## 9. Model tests — RESULT (`core/bridge-exec`, 11 passing)
Added/updated: `payout_route_mapping_no_default_eth` (XRGE→Xrge, qETH→Eth, qUSDC→Usdc,
qBTC→Btc, 3EYE→Unsupported, unknown→Unsupported, case-insensitive),
`routing_preserved_xrge_qeth_qusdc_qbtc`, `unsupported_token_success_creates_no_relayer_record`
(a custom-token burn succeeds at the ledger yet yields **zero** relayer records). Custom-token
success is **not** treated as a generic EVM payout.

## 10. Relayer/daemon integration tests (specs — run on isolated hardware at step 13)
Extends `R1_DAEMON_INTEGRATION_TESTS.md`:
1. **qETH** solvent burn → **ETH release only** (`releaseETH`, `wei = units × 10¹²`); no ERC20 tx.
2. **qUSDC** solvent burn → **USDC ERC20 release only** (`releaseERC20(USDC, …, units)`,
   **no** ×10¹²); no native ETH tx.
3. **qBTC** solvent burn → BTC route only.
4. **XRGE** solvent burn → XRGE vault only.
5. **arbitrary token** (3EYE): even if the L1 burn succeeds → **no payout route, no
   relayer-visible payout, no ETH tx, no USDC tx** (admission rejects it per §3; any legacy
   record is filtered off every list per §4 and gated out by `is_payout_eligible`).
6. **cross-asset fulfillment rejection:** an ETH payout cannot fulfill a qUSDC withdrawal; a
   USDC payout cannot fulfill qETH; a different ERC20 cannot fulfill qUSDC (§7 `match` +
   `verify_erc20_payout` token check).
7. **qUSDC conversion round-trip:** deposit N Base-USDC base units → mint N qUSDC units →
   withdraw N → `releaseERC20` amount == N (pins the 1:1 factor, §6).

## 11. R1 execution corrections retained
All previously-approved R1 corrections stand unchanged: fixed-length index-aligned result
vector; `Failed`/`None` fail closed; existing inline consensus arithmetic **instrumented,
not replaced**; no payout-store mutation inside speculative `apply_balance_block`; payout
records created only after an accepted/persisted block; a rejected bad-state-root block
leaves **zero** withdrawal-store side effects.

## 12. Sequencing
Only after this cross-asset fix is part of the proposed R1 integration branch: compile the
daemon on isolated hardware → run daemon integration tests → run relayer routing tests →
run the expanded historical reconciliation report → replay full chain (current vs patched)
comparing balances, token_balances, lp_balances, burned_tokens, nonce_db, block hashes,
state roots after **every** block. **Any state divergence → STOP.**

## Stop
Model crate corrected + green (11 tests). Relayer/API/daemon/fulfillment/reconciliation
changes provided as **proposed diffs** with the proven qUSDC 1:1 conversion. Nothing
compiled or deployed here; live node/relayer/vault untouched; V2 and RougeBridge remain
(recommended) paused. Stopped for review.
