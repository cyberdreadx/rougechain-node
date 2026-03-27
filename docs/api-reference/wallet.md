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
| `publicKey` | string | The wallet's ML-DSA-65 public key (hex) |

### Response

```json
{
  "balance": 1500.5,
  "publicKey": "abc123...",
  "tokens": {
    "XRGE": 1500.5,
    "qETH": 0.5
  }
}
```

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
    "toPubKeyHex": "recipient-public-key-hex",
    "amount": 100,
    "fee": 0.1,
    "token": "XRGE",
    "from": "sender-public-key-hex",
    "timestamp": 1706745600000,
    "nonce": "random-hex-string"
  },
  "signature": "ml-dsa65-signature-hex",
  "public_key": "sender-public-key-hex"
}
```

The transaction is signed client-side using ML-DSA-65. The server verifies the signature before processing.

### Response

```json
{
  "success": true,
  "txId": "abc123..."
}
```

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
  "amount": 1000,
  "txId": "abc123..."
}
```

See [Get Test Tokens](../getting-started/faucet.md) for details on rate limits.

---

## Burn Address

```http
GET /api/burn-address
```

### Response

```json
{
  "burnAddress": "XRGE_BURN_0x000000000000000000000000000000000000000000000000000000000000DEAD"
}
```

Send tokens to this address to permanently burn them. Burned amounts are tracked on-chain.

---

## Address Resolution

Resolve between compact `rouge1…` bech32 addresses and full hex public keys.

```http
GET /api/resolve/:input
```

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

Get the current and next sequential nonce for a wallet. Used for replay protection in v2 signed transactions.

```http
GET /api/account/:publicKey/nonce
```

### Response

```json
{
  "success": true,
  "publicKey": "a1b2c3d4...",
  "nonce": 5,
  "next_nonce": 6
}
```
