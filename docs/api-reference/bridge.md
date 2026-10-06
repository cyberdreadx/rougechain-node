# API Reference — Bridge

## ETH/USDC Bridge

### Get Bridge Config

```
GET /api/bridge/config
```

Returns bridge status, custody address, chain ID, and supported tokens.

**Response:**
```json
{
  "enabled": true,
  "custodyAddress": "0x...",
  "chainId": 8453,
  "supportedTokens": ["ETH", "USDC"]
}
```

> `enabled` is `false` when the custody address is unset. `chainId` is `8453` on Base
> mainnet (`84532` on Base Sepolia).
>
> **ETH** (→ qETH) and **USDC** (→ qUSDC) are claimable through this endpoint. `"BTC"` also
> appears in `supportedTokens` when the separate Bitcoin bridge is configured. These endpoints are
> the R1 production bridge; no V3 endpoint is live.
>
> When the Bitcoin bridge is configured the response also carries `btcCustodyAddress`,
> `btcNetwork`, `btcMinWithdrawSats` (minimum qBTC withdrawal, default 2000) and
> `btcMaxNetworkFeeSats` (largest Bitcoin network fee deducted from a payout, default 10000).
> See [Bitcoin Bridge → Fees](../bridge/btc-bridge.md#fees-and-minimum).

### Claim Bridge Deposit

```
POST /api/bridge/claim
```

Claim wrapped **qETH** or **qUSDC** after depositing ETH or USDC on Base. **Closed at the public mainnet endpoint** (`api.rougechain.io` refuses it at the reverse proxy): deposits made through the contract's `depositETH` / `depositERC20` are claimed automatically — see the auto-claim note below. Documented for operators running their own node.

**Body:**
```json
{
  "evmTxHash": "0x...",
  "evmAddress": "0x...",
  "evmSignature": "0x...",
  "recipientRougechainPubkey": "abc123...",
  "token": "ETH"
}
```

The `token` field is `"ETH"` (default, mints qETH) or `"USDC"` (mints qUSDC).
The node verifies the on-chain deposit (the `Transfer` to custody, not a caller-supplied
amount), checks the EVM signature, requires the configured confirmation depth
(`QV_BRIDGE_MIN_CONFIRMATIONS`, default 6), and then mints qETH.

> **Auto-claim:** with the deposit watcher enabled (default), the relayer detects
> `BridgeDepositETH` / `BridgeDepositERC20` events on Base and claims them for you
> via [`/api/bridge/deposit/auto-claim`](#deposit-auto-claim) — no manual claim
> needed. This endpoint remains in the node as an operator fallback but is not open to the
> public. Claims are deduped, so an auto-claim and a manual claim of the same deposit cannot
> double-mint.

### Bridge Withdraw

```
POST /api/bridge/withdraw
```

Burn wrapped tokens and create a pending withdrawal for the relayer.

**Body (signed):**
```json
{
  "fromPublicKey": "abc123...",
  "amountUnits": 10000,
  "evmAddress": "0x...",
  "signature": "...",
  "payload": { "type": "bridge_withdraw", "..." }
}
```

### List Pending Withdrawals

```
GET /api/bridge/withdrawals
```

Returns pending ETH/USDC withdrawals waiting for the relayer. XRGE withdrawals are
**excluded** here — they are served by [`/api/bridge/xrge/withdrawals`](#list-xrge-withdrawals).

**Response:**
```json
{
  "withdrawals": [
    {
      "txId": "0x...",
      "evmAddress": "0x...",
      "amountUnits": 10000,
      "createdAt": 1717000000000,
      "ownerPubkey": "abc123...",
      "tokenSymbol": "qETH",
      "status": "pending",
      "attempts": 0,
      "lastError": null
    }
  ]
}
```

| Field | Meaning |
|-------|---------|
| `ownerPubkey` | RougeChain L1 key of the withdrawer — the refund recipient |
| `tokenSymbol` | `qETH` / `qUSDC` / `XRGE`; authoritative type discriminator (replaces the legacy `xrge:` tx-id prefix) |
| `status` | `pending` · `failed` (relayer retrying) · `fulfilled` · `refunded` |
| `attempts` | Failed relayer release attempts so far |
| `lastError` | Last release error, when `status` is `failed` |

### Fulfill Withdrawal

```
DELETE /api/bridge/withdrawals/:txId
```

Mark a withdrawal as fulfilled (relayer calls this after releasing on Base). Requires
`x-bridge-relayer-secret` header or a PQC-signed operator body.

### Report Withdrawal Failure

```
POST /api/bridge/withdrawals/:txId/failure
```

Relayer reports a failed release attempt. Increments `attempts`, records `lastError`,
and sets `status: failed`. Auth: relayer secret or operator signature.

**Body:** `{ "error": "release tx reverted: 0x..." }`

**Response:** `{ "success": true, "attempts": 3, "shouldRefund": false, "threshold": 5 }`

When `attempts` reaches the threshold (5), `shouldRefund` becomes `true` and the
daemon logs an alert.

### Refund Withdrawal

```
POST /api/bridge/withdrawals/:txId/refund
```

Refund a withdrawal that could not be released: re-mints the burned `amountUnits` of
`tokenSymbol` back to `ownerPubkey` via a `bridge_mint`, then clears the pending entry.
Deduped with a `refund:<txId>` claim-store key so it can never refund twice. Auth:
relayer secret or operator signature.

**Response:** `{ "success": true, "txId": "<l1-mint-tx>", "amount": 10000, "token": "qETH", "recipient": "abc123..." }`

### Deposit Auto-claim

```
POST /api/bridge/deposit/auto-claim
```

Used by the relayer's deposit watcher to mint a deposit discovered on Base without a
browser claim. Re-verifies the EVM tx on-chain and dedupes against manual claims
(idempotent). Auth: relayer secret or operator signature.

**Body:**
```json
{
  "evmTxHash": "0x...",
  "recipientRougechainPubkey": "abc123...",
  "token": "ETH"
}
```

`token` is `ETH` / `USDC` / `XRGE`, taken from the on-chain deposit event.

### Admin Reclaim

```
POST /api/bridge/admin/reclaim
```

Manually process a missed deposit. Same verified mint path as auto-claim, but
authenticated with `adminKey` (requires `QV_ADMIN_KEY` set on the daemon).

**Body:** `{ "evmTxHash": "0x...", "recipientRougechainPubkey": "abc123...", "token": "ETH", "adminKey": "..." }`

---

## XRGE Bridge

### Get XRGE Bridge Config

```
GET /api/bridge/xrge/config
```

**Response:**
```json
{
  "enabled": true,
  "vaultAddress": "0x...",
  "tokenAddress": "0x147120faEC9277ec02d957584CFCD92B56A24317",
  "chainId": 8453
}
```

### Claim XRGE Deposit

```
POST /api/bridge/xrge/claim
```

**Body:**
```json
{
  "evmTxHash": "0x...",
  "evmAddress": "0x...",
  "evmSignature": "0x...",
  "recipientRougechainPubkey": "abc123..."
}
```

`evmSignature` is **required** — sign the claim message with the wallet that sent the
XRGE. The mint amount and depositor are **derived from the on-chain
`Transfer(from → vault)` log** emitted by the XRGE token; any caller-supplied `amount`
is ignored. The deposit must reach the required confirmation depth
(`QV_BRIDGE_MIN_CONFIRMATIONS`, default 6) before it mints.

### XRGE Withdraw

```
POST /api/bridge/xrge/withdraw
```

**Body (signed):**
```json
{
  "fromPublicKey": "abc123...",
  "amount": 100,
  "evmAddress": "0x...",
  "signature": "...",
  "payload": { "..." }
}
```

### List XRGE Withdrawals

```
GET /api/bridge/xrge/withdrawals
```

Returns pending XRGE withdrawals (filtered by `tokenSymbol == "XRGE"`). Each item
carries the same `status` / `attempts` / `ownerPubkey` / `tokenSymbol` fields as
[the ETH listing](#list-pending-withdrawals).

### Fulfill XRGE Withdrawal

```
DELETE /api/bridge/xrge/withdrawals/:txId
```

### Failure / Refund

XRGE withdrawals reuse the shared withdrawal endpoints by `txId`:
`POST /api/bridge/withdrawals/:txId/failure` and `.../refund` (see above). The relayer
reports failures and the refund re-mints XRGE to `ownerPubkey`.

## Bitcoin Bridge

### Get BTC Deposit Address

```
POST /api/bridge/btc/deposit-address
```

Returns a Bitcoin deposit address bound to a RougeChain recipient. The address is stable per
recipient: asking again for the same recipient returns the same address. BTC sent to it is
credited as qBTC to that recipient. The node only stores addresses (watch-only); they are
derived and swept by the relayer.

**Request:**
```json
{ "recipient": "rouge1..." }
```

**Response:**
```json
{ "success": true, "address": "bc1q...", "error": null }
```

On failure `success` is `false`, `address` is `null` and `error` explains why (bridge not
enabled, missing recipient, or no address available yet while the relayer refills its pool —
retry shortly). The custody address with an `OP_RETURN` memo (see
[Bitcoin Bridge](../bridge/btc-bridge.md)) remains a fallback.

`POST /api/bridge/btc/deposit-pool` and `GET /api/bridge/btc/deposit-addresses` are
relayer-only (relayer secret required).

## Bridge Activity (public, read-only)

Every cross-chain bridge transfer (deposits into RougeChain and withdrawals out of it) with its
status and the transaction on both chains. Built only from accepted blocks, the mempool and
the node's existing bridge stores; nothing is written. No signature or relayer secret
is involved, and no relayer internals are returned.

### List Bridge Activity

```
GET /api/bridge/activity?limit=25&before=202-0
```

| Query | Meaning |
|-------|---------|
| `limit` | 1–100, default 25. |
| `before` | Pagination cursor: `<height>-<index>` (from `cursor` / `nextCursor`) or a bare `<height>` (everything below that block). Omit for the newest page. |

Newest first. Transactions still in the mempool lead the first page (with `blockHeight`,
`timestamp` and `cursor` = `null`); pages read with `before` contain only transactions in blocks.

```json
{
  "items": [
    {
      "kind": "withdrawal",
      "asset": "qBTC",
      "externalAsset": "BTC",
      "amountUnits": 5000,
      "decimals": 8,
      "fromChain": "rougechain",
      "toChain": "bitcoin",
      "rougechainTxId": "d7df36b845ad0d147af6d717c2a8860026bbdb442c5375990a32e0efe6eb4c2c",
      "rougechainAddress": "rouge1…",
      "blockHeight": 202,
      "externalChainId": "bitcoin",
      "externalNetwork": "mainnet",
      "externalAddress": "bc1qvt4r5dazmystwspgp62vh9ve5tutw5av4atjcz",
      "externalTxHash": "91d306fcedfc15ce8cb8f1c547c5c2d403a20d138a74cc66fbb4a5e104259b84",
      "status": "paid",
      "statusReason": "payout_verified",
      "timestamp": 1790716492488,
      "statusUpdatedAt": 1790717000000,
      "cursor": "202-0"
    }
  ],
  "nextCursor": "198-1",
  "limit": 25
}
```

| Field | Meaning |
|-------|---------|
| `kind` | `deposit` (a `bridge_mint`) or `withdrawal` (a `bridge_withdraw`). |
| `asset` / `externalAsset` | Token on RougeChain (`qETH`, `qUSDC`, `qBTC`, `XRGE`) and on the external chain (`ETH`, `USDC`, `BTC`, `XRGE`; `null` for a non-bridge token). |
| `amountUnits` / `decimals` | Raw on-chain amount and its decimals: qBTC 8 (1 unit = 1 sat), qETH / qUSDC 6, XRGE 0. |
| `fromChain` / `toChain` | `rougechain`, `base`, `base-sepolia`, `bitcoin`, `bitcoin-testnet`, or `unknown`. |
| `rougechainTxId` / `blockHeight` / `timestamp` | The RougeChain transaction, its block and block time (ms). |
| `rougechainAddress` | rouge1 address of the withdrawal sender or the deposit recipient. |
| `externalChainId` | `"8453"` (Base), `"84532"` (Base Sepolia), `"bitcoin"`, or `null` when the node has no Base chain configured. |
| `externalNetwork` | `base`, `base-sepolia`, or for Bitcoin `mainnet` / `testnet`. |
| `externalAddress` | Withdrawals: the destination signed in the transaction (0x… or a Bitcoin address). Deposits: `null`. |
| `externalTxHash` | Withdrawals: the payout transaction, only once the payout was verified (`paid`). Deposits: `null`. |
| `status` / `statusReason` | See below. |
| `statusUpdatedAt` | When the node's payout record last changed (withdrawals), else `null`. |
| `cursor` | This item's pagination position (`null` in the mempool). |

**Status**

| `status` | `statusReason` | Meaning |
|----------|----------------|---------|
| `pending` | `in_mempool` | Submitted, not in a block yet. |
| `queued` | `awaiting_payout` | Withdrawal accepted on-chain, waiting for the relayer to pay out. |
| `paid` | `payout_verified` | Withdrawal paid; the payout was verified on the external chain. |
| `paid` | `minted` | Deposit minted on RougeChain. |
| `failed` | `rejected_on_chain` | The transaction's receipt is failed (nothing was burned or minted). |
| `failed` | `payout_retrying` | Payout attempts have failed so far; the relayer keeps retrying (or refunds). |
| `refunded` | `refunded_on_rougechain` | The payout could not complete and the tokens were minted back to the sender. |
| `unknown` | `no_payout_record` | The node holds no payout record for this withdrawal (e.g. before the payout store existed). |

**Always `null` (not recorded by the node, never guessed):** the external source transaction
and sender of a deposit. The daemon's claim store keeps source hashes only as a replay-protection
set without a link to the mint transaction. Every `bridge_mint` is listed as a deposit, which
includes refund mints and testnet test mints.

**Not exposed:** relayer error strings, attempt counters, owner public keys, secrets. A payout
hash or address that is not in the expected format for its chain is returned as `null`.

**Errors:** `400` for a bad `limit` / `before`; `503` `{"error":"bridge state degraded","degraded":true}`
while the derived bridge payout state is degraded (the same fail-closed rule as
`/api/bridge/health`); `503` `{"error":"bridge activity unavailable"}` on an internal read failure.

### Get One Bridge Transfer

```
GET /api/bridge/activity/:txId
```

`txId` is the 64-character lowercase hex RougeChain transaction id (an `xrge:` prefix is
accepted). Returns a single item (same fields as above), `404` when the transaction is not a
bridge transaction or is unknown, `400` for a malformed id, `503` as above.
