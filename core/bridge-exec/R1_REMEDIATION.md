# R1 — close the payout-without-burn path (bridge_withdraw)

> **Intended state-preserving / non-consensus bridge safety patch — pending replay-parity
> proof.** Gate receipts + the withdrawal payout store on ACTUAL burn success. The intent
> is that ledger, nonce, block hash, block acceptance, and state-root behavior are
> **unchanged**; that intent is only *established* once the §4 replay parity is byte-identical.
> Until then this is described as *intended* non-consensus, not proven non-consensus.
> Nothing deployed; live node/relayer/vault untouched. The tested core
> (`core/bridge-exec`) is compiled + green (9 tests); the daemon wiring below is proposed
> for compile + replay on **isolated** (non-prod) hardware only.

## 0. Operational containment (unchanged, still mandatory)
BridgeVaultV2 release paused (prefer `maxPerTx = 0`), bridge-relayer stopped,
`AUTO_REFUND` disabled, XRGE bridge UI/API in maintenance, existing withdrawal/relayer
state preserved. **Do not auto-fulfill or auto-refund any pending withdrawal.**

## 1. Proposed code diff

### 1a. `core/bridge-exec` (DONE, compiled + tested — 9 tests green)
Typed result + derived-data helpers. **This crate is a REFERENCE MODEL / test oracle /
typed-result definition — NOT a second production implementation of consensus money
arithmetic.** `apply_bridge_withdraw` mirrors the daemon arithmetic for tests only; the
daemon keeps its own inline arithmetic (§1c-ii instruments it, does not call this fn).
The crate exports the types the daemon threads (`BridgeWithdrawExecution`,
`BridgeWithdrawEffect`, `BridgeWithdrawFailure`) plus the derived-data helpers
`is_store_eligible`, `payout_route`, `bridge_receipt_status`, and
`persist_bridge_withdraw_results`.

- `is_payout_eligible(exec)` (the relayer-facing store gate; `is_store_eligible` is a
  back-compat alias) = `Success(e)` **and** `e.destination.is_some()` **and**
  `payout_route(canonical_token) != Unsupported`. **No EVM format check** — the store is
  shared by XRGE, qETH/qUSDC (EVM), **and qBTC (a Bitcoin address lives in the
  `evm_address`/`destination` field)**; a universal `0x…` requirement would wrongly reject
  every qBTC withdrawal. **The recognized-asset requirement is the cross-asset routing fix:
  a successful burn of an unsupported/custom token (e.g. 3EYE) is deliberately excluded so
  it can never reach a relayer payout list and be mispaid as ETH.** Execution success
  (`burned_with_destination`) and relayer-facing payout eligibility are DISTINCT concepts —
  R1 never changes the consensus burn; it only gates the derived payout record. Token
  routing itself lives in `payout_route`: `XRGE→Xrge · qETH→Eth · qUSDC→Usdc · qBTC→Btc ·
  else→Unsupported` (no default EVM route). See `R1B_CROSS_ASSET_ROUTING.md` for the
  relayer/API/fulfillment side of this fix.
- `bridge_receipt_status(None)` = `Failed("missing bridge execution result")` — **fail
  closed** (§1c-v). Absent result never defaults to Success.
- `persist_bridge_withdraw_results(txs_len, results, senders)` requires
  `results.len() == senders.len() == txs_len`, indexes by position, and emits a record
  **only** for `Success` + present destination.

### 1b. `core/daemon/Cargo.toml`
```toml
quantum-vault-bridge-exec = { path = "../bridge-exec" }
```
(Used for the result **types** and the derived-data gate helpers only — not for arithmetic.)

### 1c. `core/daemon/src/node.rs` — instrument, collect, gate (no arithmetic change)

**(i) `apply_balance_tx_inner` signature (4760-4770):** add an out-parameter.
```diff
     fn apply_balance_tx_inner(
         balances: &mut HashMap<String, u128>,
         token_balances: &mut HashMap<TokenBalanceKey, u128>,
         burned_tokens: &mut HashMap<String, f64>,
         tx: &TxV1,
         validator_store: Option<&quantum_vault_storage::validator_store::ValidatorStore>,
         node_pub_key: &str,
         unbonding_queue: &Arc<Mutex<Vec<UnbondingEntry>>>,
         block_height: u64,
         shielded_supply: &Arc<Mutex<f64>>,
+        bridge_out: &mut Option<quantum_vault_bridge_exec::BridgeWithdrawExecution>,
     ) {
```

**(ii) INSTRUMENT the existing `"bridge_withdraw"` arm (4959-4993) — do NOT rewrite it.**
Leave every line of the existing arithmetic exactly in place (fee→quanta conversion, XRGE
principal conversion, subtraction, token-balance arithmetic, RAW-case burn key at 4990,
nonce behavior). Only *record* what the existing code already decided, by setting
`*bridge_out` at the points where the arm already `return;`s or completes:
```diff
 "bridge_withdraw" => {
+    use quantum_vault_bridge_exec::{BridgeWithdrawExecution as BX, BridgeWithdrawFailure as BF, BridgeWithdrawEffect};
+    // canonical values captured from the SAME inputs the existing arithmetic reads
+    let rougechain_tx_id = { let d = sha256(&encode_tx_v1(tx)); let mut r=[0u8;32]; r.copy_from_slice(&d); r };
     // ... existing token/amount extraction ...
-    let token = match tx.payload.token_symbol { Some(t) => t, None => return };
+    let token = match tx.payload.token_symbol.as_deref() { Some(t) => t, None => { *bridge_out = Some(BX::Failed(BF::MissingToken)); return } };
-    let amount = match tx.payload.amount { Some(a) => a, None => return };
+    let amount = match tx.payload.amount { Some(a) => a, None => { *bridge_out = Some(BX::Failed(BF::MissingAmount)); return } };
+    if amount == 0 { *bridge_out = Some(BX::Failed(BF::ZeroAmount)); return }
     // ... existing fee-insolvency check ...
-        return; // insufficient fee
+        { *bridge_out = Some(BX::Failed(BF::InsufficientFee)); return }
     // ... existing XRGE / token insolvency checks ...
-        return; // insufficient xrge / token
+        { *bridge_out = Some(BX::Failed(BF::InsufficientXrge)); return }   // (resp. InsufficientToken)
     // ... existing subtraction + burn (line 4990, RAW-case key) UNCHANGED ...
+    *bridge_out = Some(BX::Success(BridgeWithdrawEffect {
+        canonical_token: canonicalize_token(token),   // "XRGE" for xrge/XrGe/…; else token as-is
+        amount,
+        destination: tx.payload.evm_address.clone(),  // Some(EVM) | Some(BTC) | None — NOT validated here
+        rougechain_tx_id,
+    }));
 }
```
The exact failure-variant at each existing `return;` follows that branch's meaning
(fee / XRGE-principal / token-balance). **No arithmetic, no ordering, no key casing, and
no nonce behavior is altered — only assignments to `*bridge_out` are added.** §4 replay
parity is the proof this is behavior-preserving.

**(iii) The 6 call sites of `apply_balance_tx_inner`** (741, 2894, 3808, 3847, 6165,
6675): add a local `&mut` argument. Five that don't need the result pass a throwaway:
```diff
+            let mut _bwo = None;
             Self::apply_balance_tx_inner(&mut balances, ..., &self.shielded_supply,
+                &mut _bwo);
```
`apply_balance_block`'s call (2894) captures it into the position-indexed vec (next hunk).

**(iv) `apply_balance_block` (2841): position-indexed results; return them. NO store
mutation here.** `apply_balance_block` is *speculative* state application that runs BEFORE
state-root verification; a block may apply side effects and then FAIL the state-root check,
at which point balances are rolled back and the block is rejected — but any side-effect
store writes would NOT be rolled back. Therefore the payout store is **not** written here.
```diff
-    fn apply_balance_block(&self, block: &BlockV1) -> Result<(), String> {
+    fn apply_balance_block(&self, block: &BlockV1)
+        -> Result<Vec<Option<quantum_vault_bridge_exec::BridgeWithdrawExecution>>, String> {
         ...
+        // Indexed by tx position. apply_balance_block has early `continue` paths, so a
+        // push-based vec would misalign every result after the first skip. Pre-fill None.
+        let mut bridge_results: Vec<Option<quantum_vault_bridge_exec::BridgeWithdrawExecution>>
+            = vec![None; block.txs.len()];
-        for tx in &block.txs {
+        for (tx_index, tx) in block.txs.iter().enumerate() {
             ...consensus guards, including existing `continue` paths (leave result None)...
-            Self::apply_balance_tx_inner(&mut balances, ..., &self.shielded_supply);
+            let mut bwo = None;
+            Self::apply_balance_tx_inner(&mut balances, ..., &self.shielded_supply, &mut bwo);
+            bridge_results[tx_index] = bwo;   // index, never push
             let _ = self.nonce_db.insert(tx.from_pub_key.as_bytes(), &tx.nonce.to_be_bytes()); // UNCHANGED
         }
```
**Delete** the old independent store scan (3314-3337) entirely — it is replaced by the
post-acceptance helper (§1c-vii), NOT by an in-place gate here.
```diff
-        if let Some(ref store) = self.opts.bridge_withdraw_store {
-            for tx in &block.txs { /* insert by presence — the drain. REMOVED */ }
-        }
         ...
-        Ok(())
+        Ok(bridge_results)
```

**(v) `generate_receipts` (987) — honest bridge status, fail closed.**
```diff
-    fn generate_receipts(&self, block: &BlockV1) -> Vec<TxReceipt> {
+    fn generate_receipts(&self, block: &BlockV1,
+        bridge_results: &[Option<quantum_vault_bridge_exec::BridgeWithdrawExecution>]) -> Vec<TxReceipt> {
         ...
-            status: TxStatus::Success,
+            status: if tx.tx_type == "bridge_withdraw" {
+                use quantum_vault_bridge_exec::{bridge_receipt_status, BridgeReceipt};
+                match bridge_receipt_status(bridge_results.get(index).and_then(|o| o.as_ref())) {
+                    BridgeReceipt::Success    => TxStatus::Success,
+                    BridgeReceipt::Failed(m)  => TxStatus::Failed(m), // Failed(reason) AND None ⇒ Failed
+                }
+            } else { TxStatus::Success }, // all other tx types unchanged (out of R1 scope)
```
`None` ⇒ `Failed("missing bridge execution result")` — never silent Success.

**(vi) The 2 callers of `apply_balance_block` (920, 2519) + `generate_receipts` (947,
2558):** thread the vec.
```diff
-        if let Err(e) = self.apply_balance_block(&block) { ... }
+        let bridge_results = match self.apply_balance_block(&block) { Ok(v) => v, Err(e) => { ...existing error... } };
         ...
-        let receipts = self.generate_receipts(&block);
+        let receipts = self.generate_receipts(&block, &bridge_results);
```

**(vii) NEW: persist the payout store AFTER block acceptance + state-root verify.**
Add `persist_bridge_withdraw_results(&self, block, results)` and call it **only on the
accepted-block path**, after the state root has been verified and the block committed —
never inside `apply_balance_block`. Minimum R1 guarantee: *only a successfully
accepted/persisted block may create a payout record.*
```rust
fn persist_bridge_withdraw_results(
    &self, block: &BlockV1,
    results: &[Option<quantum_vault_bridge_exec::BridgeWithdrawExecution>],
) -> Result<(), String> {
    use quantum_vault_bridge_exec::{BridgeWithdrawExecution::Success, is_payout_eligible};
    if results.len() != block.txs.len() {
        return Err("bridge results not aligned to block txs".into()); // fail closed
    }
    let store = match &self.opts.bridge_withdraw_store { Some(s) => s, None => return Ok(()) };
    for (i, r) in results.iter().enumerate() {
        // None / Failed / no-dest / UNSUPPORTED token ⇒ skip (no relayer-facing record)
        let exec = match r { Some(e) if is_payout_eligible(e) => e, _ => continue };
        if let Success(e) = exec {
            let dest = match &e.destination { Some(d) => d.clone(), None => continue };
            let prefix = if e.canonical_token == "XRGE" { "xrge:" } else { "" };
            let tx_id = format!("{}{}", prefix, bytes_to_hex(&e.rougechain_tx_id));
            // owner = ORIGINAL sender of tx[i]; token/amount/tx_id/dest = the effect's canonical values
            let _ = store.add(tx_id, dest, e.amount, block.txs[i].from_pub_key.clone(), e.canonical_token.clone());
        }
    }
    Ok(())
}
```
Wire it at the accepted-block site(s) *after* commit:
```diff
     // ... state root verified, block committed to chain DB ...
+    self.persist_bridge_withdraw_results(&block, &bridge_results)?;
```

**Scope discipline:** only added `*bridge_out` assignments, the position-indexed result
vec, the deleted in-apply store scan, the post-acceptance persist helper, receipt status,
and the mechanical param threading. No other tx-type semantics touched; no other arm's
`return;` changed; nonce/balance/burn arithmetic byte-identical.

## 2. Execution-result type
`BridgeWithdrawExecution::{ Success(BridgeWithdrawEffect), Failed(BridgeWithdrawFailure) }`
— `Effect { canonical_token, amount, destination: Option<String>, rougechain_tx_id: [u8;32] }`,
`Failure ∈ { MissingToken, MissingAmount, ZeroAmount, InsufficientFee, InsufficientXrge,
InsufficientToken }`. Defined + tested in `core/bridge-exec`. `destination` holds an EVM
address (XRGE/qETH/qUSDC) **or a Bitcoin address (qBTC)** — never format-validated in R1.

## 3. Model-level tests — RESULT (compiled + passing)
`cargo test -p quantum-vault-bridge-exec` → **9 passed**.

| test | proves |
|---|---|
| `units_conformance` | quanta arithmetic matches `units.rs` |
| `ordinary_user_double_withdraw` | 1st `Success` (burns 100), 2nd `Failed(InsufficientFee)`; `burned["XRGE"]==100`, debited once, **exactly 1 store-eligible** |
| `insolvent_single_withdrawal` | no burn, no store record |
| `missing_and_malformed_fields` | missing dest ⇒ not eligible; **present (even non-EVM) dest ⇒ eligible** (endpoint validates) |
| `casing_all_canonicalize_to_xrge` | `XRGE`/`xrge`/`XrGe`/` xrge ` → canonical `"XRGE"` |
| `successful_xrge_and_token` | XRGE + generic token success paths |
| `routing_preserved_xrge_qeth_qbtc` | XRGE→`Xrge`, qETH→`GenericEvm`, **qBTC (BTC address)→`Btc` & eligible**, failed burn→not eligible |
| `receipt_and_store_fail_closed_on_missing_result` | `None`→`Failed("missing bridge execution result")`, `Failed`→`Failed`, `Success`→`Success` |
| `persist_is_index_aligned_and_success_only` | tx[0]=None(skipped), tx[1]=Success, tx[2]=Failed ⇒ 1 record, **owner == tx[1] sender**; length mismatch ⇒ `Err` |

## 4. Historical replay / state-root comparison (RUNBOOK — REQUIRED before any "non-consensus" claim)
The store/receipt change is *intended* to be derived data only; ledger/burn/nonce
arithmetic is left byte-for-byte in place. To PROVE that before calling R1 non-consensus,
on **isolated non-prod hardware** and an **isolated branch**:
1. Take a **read-only** snapshot of the mainnet chain DB onto non-prod hardware.
2. Build the **current** binary and the **R1-patched** binary against the *same* snapshot.
3. Replay full history with both; after **every block** compare **balances,
   token_balances, lp_balances, burned_tokens, nonce_db, block hash, and the committed
   state root**.
4. **Expected: IDENTICAL at every height. Any divergence ⇒ STOP** — R1 changed consensus
   state ⇒ reclassify, do not deploy. Only after byte-identical parity may R1 be *described*
   as non-consensus.

## 5. Receipt/store behavior comparison
- **Store (before → after):** before, any `bridge_withdraw` with `amount>0` + `evm_address`
  is inserted regardless of burn, from the *speculative* apply (drain). After, a record is
  written **only** from the post-acceptance helper (§1c-vii), **iff** the block was accepted
  (state root verified), the burn succeeded (`Success`), and a destination is present. The
  missing-`token_symbol`→`qETH` default insertion and the insolvent-withdrawal insertion
  both vanish, and a rejected (bad-state-root) block writes **nothing**.
- **Receipts (before → after):** before, `TxStatus::Success` for every `bridge_withdraw`;
  after, `Failed(reason)` for a failed burn and `Failed("missing bridge execution result")`
  for an absent result. Other tx types unchanged.

## 6. Reconciliation of existing PENDING withdrawals (READ-ONLY tool — runbook)
Build a **`reconcile-withdrawals` read-only mode** of the R1 daemon (reuses the exact
instrumented apply path): replay-from-genesis on a snapshot and, for every historical
`bridge_withdraw`, record its `BridgeWithdrawExecution`. Emit a **report only**:
```
BurnConfirmed   → Success(effect)     (safe to settle)
BurnNotExecuted → Failed(_) / None    (must NOT be paid/refunded)
Ambiguous       → data missing        (manual review)
```
Do **not** trust receipt `Success`, store presence, or relayer status. Do **not** mutate
any bridge record. Keep `AUTO_REFUND` disabled until every existing pending XRGE record is
classified and manually dispositioned. **Do not** auto-label old records verified.

## 7. Failed / rejected withdrawal can never reach the relayer store — PROOF
New records are created only by `persist_bridge_withdraw_results`, called **only after a
block is accepted and its state root verified**, and only for `is_store_eligible(result)`
= `Success` + present destination. Therefore:
- a `Failed(_)` or `None` result → no `store.add` (fail closed);
- a block that **fails state-root verification is rejected**, its speculative balances are
  rolled back, and — because the persist helper never runs on that path — it leaves **zero
  bridge store side effects** (this is the attack regression: valid-looking withdraw inside
  a block with a deliberately invalid state root ⇒ no store record, no relayer-visible
  withdrawal);
- the relayer reads only the store, so it can never see a payout the chain didn't accept.
(Historical pre-R1 records are handled by §6, not by R1's gate.)

## 8. Optional provenance (only if compatible)
On newly-created records, if the store schema can carry it without breaking compatibility:
`execution_verified = true`, `execution_semantics_version = 1`. Do NOT migrate/relabel old
records. (If the schema can't be extended cleanly, skip — §6 is the source of truth for
historical records.)

## 9. Rollout classification
Provisionally an **urgent, intended state-preserving / non-consensus bridge safety patch —
pending §4 replay-parity proof.** It must NOT be called consensus-neutral in the PR or
anywhere until §4 shows state roots + all balance maps + nonce progression are
byte-identical to the current binary over full history. Coordinate a network-wide daemon
upgrade for relayer-data consistency (finalized-only payout semantics are Track A /
Bridge-V3, not R1).

## 10. Rollout runbook (proposal — do NOT execute here)
1. On isolated hardware / isolated branch: apply §1c, `cargo build`, run the full suite +
   §4 replay parity + the rejected-bad-state-root side-effect test.
2. If §4 is byte-identical → classify as intended non-consensus; run §6 reconciliation;
   disposition historical pending records manually.
3. Keep V2 release paused (`maxPerTx=0`), relayer stopped, `AUTO_REFUND` off, UI in
   maintenance throughout.
4. Coordinated node upgrade (operator + validators) to the R1 binary. **Do not auto-restart
   the live node or relayer** — operator performs the restart in a maintenance window.
5. Post-upgrade, verify new insolvent/double-withdraw attempts and a rejected block produce
   NO store record (dry-run replay of the regressions against the live-patched node).
6. Only after reconciliation + external review: consider re-enabling relayer/UI and
   unpausing V2 — a separate decision, not part of R1.

## Bridge-V3 boundary (unchanged)
R1 does not add `BRIDGE_V3_ACTIVATION_HEIGHT`, Option-D extraction, or finalized-only
payout semantics. Those, and any consensus-level block-invalid semantics, remain a separate
future fork decision. Track A Step 2 will consume only explicitly-successful post-activation
results — **not started here**.

## Stop
Tested core committed (9 tests green); daemon diff proposed for isolated compile + replay;
runbooks provided. Daemon NOT wired/compiled on the live box. **No production rollout. Live
node/relayer/vault untouched.** Stopped for review.
