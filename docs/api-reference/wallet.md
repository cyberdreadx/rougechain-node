# Wallet API

Endpoints for wallet creation, balance queries, and token management.

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

## Create Wallet

```http
POST /api/wallet/create
```

Creates a new wallet on the server. In practice, wallets are created client-side and only need to interact with the chain when transacting.

### Response

```json
{
  "success": true,
  "publicKey": "abc123...",
  "privateKey": "def456..."
}
```

> **Note:** The v2 API uses client-side key generation. Private keys never leave the browser. This endpoint exists for legacy compatibility.

---

## Request Faucet

```http
POST /api/faucet
Content-Type: application/json
```

### Request Body

```json
{
  "publicKey": "your-public-key-hex"
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

## Submit Transaction (Legacy)

```http
POST /api/tx/submit
Content-Type: application/json
```

See [Transactions API](transactions.md) for full details.

---

## v2 Transfer (Client-Side Signing)

```http
POST /api/v2/transfer
Content-Type: application/json
```

### Request Body

```json
{
  "publicKey": "sender-public-key-hex",
  "payload": {
    "toPubKeyHex": "recipient-public-key-hex",
    "amount": 100,
    "fee": 0.1,
    "token": "XRGE"
  },
  "nonce": 1706745600000,
  "signature": "ml-dsa65-signature-hex"
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

## v2 Faucet

```http
POST /api/v2/faucet
Content-Type: application/json
```

### Request Body

```json
{
  "publicKey": "your-public-key-hex",
  "nonce": 1706745600000,
  "signature": "your-signature-hex"
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
