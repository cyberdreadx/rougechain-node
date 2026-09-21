# R1C — signed-intent binding (executed withdrawal must equal the signed one)

> **Authorization correction before isolated integration/replay.** The ML-DSA signature
> covers the payload `{type, amount, fee, tokenSymbol, evmAddress, from, timestamp, nonce}`,
> but both bridge handlers verify that payload and then execute using **unsigned top-level
> request fields** (`body.amount_units`/`body.amount`, `body.evm_address`, `body.fee`) —
> only `tokenSymbol` is read from the payload. So the executed withdrawal is not
> cryptographically bound to the signed intent. **Proposed daemon diffs only — nothing
> compiled/deployed here.** Model core (`authorize_bridge_withdraw`) is implemented + tested
> in `core/bridge-exec` (16 tests green).

## 1. Confirmed gap (evidence)
- `BridgeWithdrawRequest` (`core/daemon/src/main.rs:7764-7775`): top-level `amount_units: u64`,
  `evm_address: String`, `fee: Option<f64>`, plus `signature`, `payload: Option<Value>`,
  `from_public_key`, `from_private_key`.
- `bridge_withdraw` (`main.rs:7826-7847`): after `verify_signed_tx`, submits with
  `body.amount_units`, `body.evm_address`, `body.fee` (top-level). Only `token_symbol` comes
  from `payload.tokenSymbol` (`:7793-7797`). The verified payload string returned by
  `verify_signed_tx` is **discarded**.
- `verify_signed_tx` (`main.rs:4596-4650`): verifies the ML-DSA sig over the payload; enforces
  a ±5-min `timestamp`; checks `payload.from == public_key` **only if `from` is present**;
  calls the persistent `replay_guard` (`sha256(signature)` + expiry, `:4561-4578`). It does
  **not** compare `payload.amount`/`evmAddress`/`fee` to what is submitted — those are
  top-level and out of its scope.
- `xrge_bridge_withdraw` (`main.rs:8570-8628`): same pattern; `body.amount`/`body.evm_address`
  top-level, fee hard-coded `Some(0.1)`, token hard-coded `"XRGE"`.
- `check_signed_nonce` (`main.rs:4586-4594`) exists (keyed on `payload.account_nonce`) but is
  **not** called by either bridge handler; bridge payloads don't currently carry
  `account_nonce`.
- Raw `submit_bridge_withdraw_tx` (`node.rs:1920-1971`) hard-codes token `"qETH"`; called at
  `main.rs:7849` (generic) and `:8602` (xrge).

## 2. Model core (DONE — `core/bridge-exec`, 16 tests green)
`authorize_bridge_withdraw(endpoint, signed: SignedWithdrawIntent, compat: TopLevelCompat)
-> Result<AuthorizedWithdraw, BridgeAuthError>`:
- **op-type gate:** `payload.type == "bridge_withdraw"` (a `transfer` signature can't
  authorize a withdrawal) → else `WrongOperation`.
- **asset + endpoint routing from the SIGNED token only:** Generic accepts qETH/qUSDC/qBTC,
  rejects XRGE (`XrgeOnGenericEndpoint`) and unsupported (`UnsupportedAsset`); Xrge accepts
  only XRGE (`NonXrgeOnXrgeEndpoint`).
- **required signed values:** amount, destination, fee (`MissingSignedField` if absent).
- **compat binding:** any present top-level `amount`/`destination`/`fee` MUST equal its
  signed counterpart (`AmountMismatch`/`DestinationMismatch`/`FeeMismatch`); never overrides.
  Fee compared in the consumed quanta domain (`fee_to_quanta`) to avoid f64 noise.
- **deterministic canonicalization** (`qeth`→`qETH`, `QUSDC`→`qUSDC`, `qBtc`→`qBTC`).
- returns `AuthorizedWithdraw { amount, destination, fee, canonical_token, route }` — the ONLY
  values the daemon feeds to `submit_bridge_withdraw_tx_signed`.

## 3. Proposed daemon diff — generic `/api/bridge/withdraw` (`main.rs:7826-7847`)
```diff
     if let (Some(signature), Some(payload)) = (&body.signature, &body.payload) {
         let signed_req = SignedTransactionRequest { payload: payload.clone(),
             signature: signature.clone(), public_key: body.from_public_key.clone(),
             payload_bytes_hex: None };
         if let Err(e) = verify_signed_tx(&signed_req).await { return sig_err(e); }
+        // R1C-(6): the signer binding is MANDATORY for bridge withdrawals (not optional).
+        if payload.get("from").and_then(|v| v.as_str()) != Some(body.from_public_key.as_str()) {
+            return bad_request("signed payload 'from' must equal the authenticated public key");
+        }
+        // R1C-(7): durable account-nonce IF the client signed one (backward-compatible;
+        // the persistent signature replay_guard already applies via verify_signed_tx).
+        if let Err(e) = check_signed_nonce(&state.node, &body.from_public_key, payload) {
+            return bad_request(&e);
+        }
+        // R1C-(2,3,4): authorize SOLELY from the verified payload; top-level fields, if
+        // present, must EQUAL the signed values (never override).
+        use quantum_vault_bridge_exec::{authorize_bridge_withdraw, Endpoint,
+            SignedWithdrawIntent, TopLevelCompat};
+        let intent = SignedWithdrawIntent {
+            op_type: payload.get("type").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
+            amount: payload.get("amount").and_then(|v| v.as_u64()),
+            destination: payload.get("evmAddress").and_then(|v| v.as_str()).map(str::to_string),
+            fee: payload.get("fee").and_then(|v| v.as_f64()),
+            token_symbol: payload.get("tokenSymbol").and_then(|v| v.as_str()).map(str::to_string),
+        };
+        // Existing clients always send these top-level; require equality (preferred option).
+        let compat = TopLevelCompat {
+            amount: Some(body.amount_units),
+            destination: Some(body.evm_address.clone()),
+            fee: body.fee,
+        };
+        let auth = match authorize_bridge_withdraw(Endpoint::Generic, &intent, &compat) {
+            Ok(a) => a,
+            Err(e) => return bad_request(&format!("signed-intent rejected: {:?}", e)),
+        };
         state.node.submit_bridge_withdraw_tx_signed(
             &body.from_public_key,
-            body.amount_units,     // TOP-LEVEL (unbound) — REMOVED
-            &body.evm_address,     // TOP-LEVEL (unbound) — REMOVED
-            body.fee,              // TOP-LEVEL (unbound) — REMOVED
-            &token_symbol,
+            auth.amount,               // signed
+            &auth.destination,         // signed
+            Some(auth.fee),            // signed
+            &auth.canonical_token,     // canonical signed asset (qETH/qUSDC/qBTC)
         )
     }
```
The resulting node-cosigned `TxV1` is now derived entirely from the authenticated user's
signed intent + protocol canonicalization. The old payload-derived `token_symbol` variable
(`:7793-7797`) is superseded by `auth.canonical_token`.

## 4. Proposed daemon diff — `/api/bridge/xrge/withdraw` (`main.rs:8584-8600`)
```diff
     if let (Some(signature), Some(payload)) = (&body.signature, &body.payload) {
         let signed_req = SignedTransactionRequest { payload: payload.clone(),
             signature: signature.clone(), public_key: body.from_public_key.clone(),
             payload_bytes_hex: None };
         if let Err(e) = verify_signed_tx(&signed_req).await { return sig_err(e); }
+        if payload.get("from").and_then(|v| v.as_str()) != Some(body.from_public_key.as_str()) {
+            return xrge_err("signed payload 'from' must equal the authenticated public key");
+        }
+        if let Err(e) = check_signed_nonce(&state.node, &body.from_public_key, payload) {
+            return xrge_err(&e);
+        }
+        use quantum_vault_bridge_exec::{authorize_bridge_withdraw, Endpoint,
+            SignedWithdrawIntent, TopLevelCompat};
+        let intent = SignedWithdrawIntent {
+            op_type: payload.get("type").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
+            amount: payload.get("amount").and_then(|v| v.as_u64()),
+            destination: payload.get("evmAddress").and_then(|v| v.as_str()).map(str::to_string),
+            // R1D: the signed fee MUST exist (no server-side carve-out). authorize_bridge_withdraw
+            // then enforces the protocol fee policy (consumes exactly 0.1 XRGE). A payload that
+            // omits `fee` is rejected (MissingSignedField), NOT silently defaulted.
+            fee: payload.get("fee").and_then(|v| v.as_f64()),
+            token_symbol: payload.get("tokenSymbol").and_then(|v| v.as_str()).map(str::to_string),
+        };
+        // XrgeBridgeWithdrawRequest has no top-level fee field; amount/evm are top-level.
+        let compat = TopLevelCompat { amount: Some(body.amount), destination: Some(body.evm_address.clone()), fee: None };
+        // authorize enforces: op-type, XRGE-only routing, complete intent, value validation,
+        // AND the 0.1-XRGE fee policy (R1D). No separate post-check needed.
+        let auth = match authorize_bridge_withdraw(Endpoint::Xrge, &intent, &compat) {
+            Ok(a) => a,
+            Err(e) => return xrge_err(&format!("signed-intent rejected: {:?}", e)),
+        };
         state.node.submit_bridge_withdraw_tx_signed(
             &body.from_public_key,
-            body.amount,          // TOP-LEVEL (unbound) — REMOVED
-            &body.evm_address,    // TOP-LEVEL (unbound) — REMOVED
-            Some(0.1),
-            "XRGE",
+            auth.amount,               // signed
+            &auth.destination,         // signed
+            Some(auth.fee),            // signed fee (already policy-checked == 0.1 XRGE)
+            &auth.canonical_token,     // "XRGE"
         )
     }
```
`authorize_bridge_withdraw` rejects any non-XRGE signed token here (`NonXrgeOnXrgeEndpoint`),
and the generic endpoint rejects a signed XRGE token (`XrgeOnGenericEndpoint`) — the
cross-endpoint guards.

## 5. Compatibility fields (item 3)
Existing clients send redundant top-level `amountUnits`/`evmAddress`/`fee`. **Preferred
option, adopted above:** keep them temporarily but **require equality** with the signed
values (mismatch ⇒ explicit `signed-intent rejected: AmountMismatch/DestinationMismatch/
FeeMismatch`). The top-level copy can never override the signed payload. A future client
release may drop them entirely; the handler then reads intent purely from the payload (the
`compat` becomes all-`None` and binding still holds). Note: clients MUST sign a full payload
(`amount`, `evmAddress`, `fee`, `tokenSymbol`, `type`, `from`) — a payload missing a
security-relevant field now fails closed (`MissingSignedField`) instead of silently using the
top-level copy. This is a deliberate, documented client-compat requirement of R1C.

## 6. From / public-key binding (item 6)
- Retain `verify_signed_tx`'s `payload.from == public_key` check, and additionally make it
  **mandatory** on the bridge path (the diffs reject a missing/mismatched `from`), because
  `verify_signed_tx` skips it when `from` is absent.
- The public key passed to `submit_bridge_withdraw_tx_signed` is exactly
  `body.from_public_key` (the authenticated request key) — never a separate unbound identifier.

## 7. Account nonce (item 7)
- Bridge payloads do **not** currently carry `account_nonce`; `check_signed_nonce` is a no-op
  when it's absent (`main.rs:4586-4594`), so adding the call (diffs above) is
  backward-compatible and enforces the durable nonce as soon as clients sign one.
- **Legacy replay model documented:** until clients sign `account_nonce`, the only replay
  protection on the bridge path is the persistent signature guard (`replay_guard`,
  `sha256(signature)` + a 5-minute timestamp window, `main.rs:4561-4578`) — which **remains
  required**. A signature can't be replayed within its 5-minute validity window, and expires
  from acceptance exactly when the timestamp check would reject it. Durable cross-window
  replay protection needs the signed account nonce; that client change is tracked separately.

## 8. Legacy private-key path (item 8)
- Do **not** expand or rely on `fromPrivateKey`. Preferred posture: signed ML-DSA path is
  canonical; raw-private-key bridge submission is **deprecated**; consider removing it in a
  separate compatibility cleanup.
- **For R1, minimum:** the raw path must not bypass the new routing. `submit_bridge_withdraw_tx`
  (`node.rs:1920-1971`) hard-codes token `"qETH"`, so it can only ever produce a qETH
  withdrawal — it cannot reach qUSDC/qBTC/XRGE. Gate it further behind an explicit,
  default-off flag (e.g. `QV_BRIDGE_ALLOW_RAW_KEY=true`) or reject it outright on the bridge
  endpoints; either way it stays qETH-only and is subject to the same admission allowlist and
  the R1/R1B store gate (`is_payout_eligible`). It never routes an unsupported asset and never
  produces a relayer record for one.
```diff
     } else if let Some(ref private_key) = body.from_private_key {
+        // R1C-(8): deprecated raw-key path — default OFF; cannot reach qUSDC/qBTC/XRGE
+        // (submit_bridge_withdraw_tx is hard-coded qETH). Kept only for legacy compatibility.
+        if std::env::var("QV_BRIDGE_ALLOW_RAW_KEY").map(|v| v == "true").unwrap_or(false) == false {
+            return bad_request("raw-private-key bridge withdrawal is disabled; use the signed path");
+        }
         state.node.submit_bridge_withdraw_tx(private_key, &body.from_public_key,
             body.amount_units, &body.evm_address, body.fee)
     }
```

## 9. Daemon/API tests (specs — run on isolated hardware at step 11)
Mirror the 5 model-crate tests (`r1c_*`, all green) at the HTTP layer:
1. **Exact binding:** sign `{amount:10, evmAddress:A, tokenSymbol:qETH, fee:0.1}` + matching
   top-level → **PASS**; then individually tamper top-level amount→11, destination→B, fee→other
   → each **REJECTED** (`AmountMismatch`/`DestinationMismatch`/`FeeMismatch`).
2. **Wrong operation:** a valid signature over `type=transfer` must **not** authorize
   `/bridge/withdraw` (`WrongOperation`).
3. **Wrong token:** a valid signed `tokenSymbol=3EYE` → rejected (`UnsupportedAsset`).
4. **Cross-endpoint:** signed `XRGE` rejected by generic `/bridge/withdraw`
   (`XrgeOnGenericEndpoint`); signed `qETH` rejected by `/bridge/xrge/withdraw`
   (`NonXrgeOnXrgeEndpoint`).
5. **Canonicalization:** signed case variant of a supported token canonicalizes
   deterministically (`qeth`→`qETH`) — chosen behavior, tested.
6. **Constructed TxV1:** after a successful submission the resulting `TxV1` contains exactly
   the signed amount, signed destination, canonical signed asset, authorized fee, and the
   authenticated sender (`from_public_key`) — nothing top-level and unbound.
7. **from binding:** a payload with missing/mismatched `from` is rejected on the bridge path.
8. **Raw-key path:** with `QV_BRIDGE_ALLOW_RAW_KEY` unset, a `fromPrivateKey` bridge request is
   rejected; when enabled it can only produce a qETH withdrawal (never qUSDC/qBTC/XRGE).

## 10. R1/R1B protections retained (item 10)
Unchanged: explicit payout route (no default ETH); supported-asset admission allowlist; qETH→
native ETH; qUSDC→Base USDC 1:1 base units; qBTC→BTC; XRGE→BridgeVault; unsupported assets →
no relayer payout record; token-aware fulfillment; failed burn → no payout record;
post-acceptance store persistence; fixed transaction-index alignment; consensus arithmetic
instrumented, not replaced.

## 11. Sequencing (item 11 — do NOT start here)
Once R1C is on the proposed integration branch: (1) compile daemon off production, (2) compile
relayer, (3) run R1/R1B/R1C integration tests, (4) cross-asset tests, (5) signed-intent
tampering tests, (6) historical pending reconciliation, (7) full historical replay parity,
(8) compare state roots + all consensus state at every height. **Any consensus-state
divergence → STOP.** Do NOT deploy / restart production / restart relayer / unpause
BridgeVaultV2 or RougeBridge.

## Stop
Model authorization core implemented + green (16 tests). Daemon handler binding, compat,
from/nonce, and raw-key changes provided as **proposed diffs**. Nothing compiled or deployed;
live node/relayer/vault untouched; V2 and RougeBridge remain (recommended) paused. Stopped for
final pre-rollout review.
