# Wallet API

Endpoints for balance queries, transfers, and token management.

> **Note:** Wallets are created client-side using ML-DSA-65 + ML-KEM-768 key generation. Private keys never leave your application. See [Create a Wallet](../getting-started/create-wallet.md) for details.

## Get Balance

```http
GET /api/balance/:publicKey
```

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `publicKey` | string | The wallet's ML-DSA-65 public key (hex) or its `rouge1…` address |

### Response

```json
{
  "success": true,
  "balance": 1500.5,
  "token_balances": {
    "qETH": 0.5
  },
  "lp_balances": {}
}
```

`balance` is the XRGE balance; `token_balances` maps token symbol → balance; `lp_balances` maps pool id → LP-token balance.

---

## Transfer Tokens (v2)

```http
POST /api/v2/transfer
Content-Type: application/json
```

### Request Body

```json
{
  "payload": {
    "to": "recipient-public-key-hex",
    "amount": 100,
    "token": "XRGE",
    "from": "sender-public-key-hex",
    "timestamp": 1706745600000,
    "nonce": "random-hex-string"
  },
  "signature": "ml-dsa65-signature-hex",
  "public_key": "sender-public-key-hex"
}
```

The transaction is signed client-side using ML-DSA-65. The server verifies the signature before processing. The fee is fixed at **1 XRGE**.

### Response

```json
{
  "success": true,
  "message": "Transfer transaction submitted"
}
```

The response does not include a transaction id; watch the sender's history (`/api/address/:pubkey/transactions`) or the WebSocket feed to see the transaction land in a block.

---

## Request Faucet (v2)

```http
POST /api/v2/faucet
Content-Type: application/json
```

### Request Body

```json
{
  "payload": {
    "from": "your-public-key-hex",
    "timestamp": 1706745600000,
    "nonce": "random-hex-string"
  },
  "signature": "your-signature-hex",
  "public_key": "your-public-key-hex"
}
```

### Response

```json
{
  "success": true,
  "message": "Faucet: 10000 XRGE sent"
}
```

The faucet is only enabled on test networks; elsewhere it returns `403`. See [Get Test Tokens](../getting-started/faucet.md) for details.

---

## Burn Address

```http
GET /api/burn-address
```

### Response

```json
{
  "burn_address": "XRGE_BURN_0x000000000000000000000000000000000000000000000000000000000000DEAD",
  "description": "Official burn address. Tokens sent here are permanently destroyed and tracked on-chain."
}
```

Send tokens to this address to permanently burn them. Burned amounts are tracked on-chain.

---

## Address Resolution

Resolve between compact `rouge1…` bech32 addresses and full hex public keys.

```http
GET /api/resolve/:input
```

<a id="resolve-address--public-key"></a>

Input can be either a `rouge1…` address or a hex public key. The endpoint auto-detects the format.

### Response

```json
{
  "success": true,
  "address": "rouge1q8f3x7k2m4...",
  "publicKey": "a1b2c3d4e5f6...",
  "balance": 1000.5
}
```

---

## Account Nonce

Get the current and next sequential nonce for a wallet. A v2 signed payload may include an optional `account_nonce`; when present it must equal `next_nonce`.

The path parameter must be the **hex public key** (a `rouge1…` address always returns `0`).

```http
GET /api/account/:publicKey/nonce
```

### Response

```json
{
  "success": true,
  "nonce": 5,
  "next_nonce": 6
}
```
