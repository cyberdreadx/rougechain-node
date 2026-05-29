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

> `chainId` is `8453` on Base mainnet (`84532` on Base Sepolia).

### Claim Bridge Deposit

```
POST /api/bridge/claim
```

Claim wrapped tokens (qETH or qUSDC) after depositing on Base. (Usually automatic — see the auto-claim note below.)

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

The `token` field can be `"ETH"` (default) or `"USDC"`. The node verifies the EVM transaction, checks the signature, and mints the corresponding wrapped token.

> **Auto-claim:** with the deposit watcher enabled (default), the relayer detects
> `BridgeDepositETH` / `BridgeDepositERC20` events on Base and claims them for you
> via [`/api/bridge/deposit/auto-claim`](#deposit-auto-claim) — no manual claim
> needed. This endpoint remains available as a manual fallback. Claims are deduped,
> so an auto-claim and a manual claim of the same deposit cannot double-mint.

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
  "amount": "1000000000000000000",
  "recipientRougechainPubkey": "abc123..."
}
```

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
