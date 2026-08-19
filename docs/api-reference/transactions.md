# Transactions API

## Transfer Tokens (v2)

Send XRGE or custom tokens to another address using client-side ML-DSA-65 signing.

```http
POST /api/v2/transfer
Content-Type: application/json
```

### Request Body

```json
{
  "payload": {
    "to": "recipient-public-key-hex",
    "amount": 100.0,
    "token": "XRGE",
    "from": "sender-public-key-hex",
    "timestamp": 1706745600000,
    "nonce": "random-hex-string"
  },
  "signature": "ml-dsa65-signature-hex",
  "public_key": "sender-public-key-hex"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `to` | string | Yes | Recipient's public key (hex) or `rouge1` address |
| `amount` | number | Yes | Amount to send |
| `token` | string | No | Token symbol (default: "XRGE") |

> **Fee:** The transaction fee is enforced by the server; any client-supplied `fee` in
> the payload is ignored.
>
> **Security:** Private keys never leave your application. The transaction is signed client-side using ML-DSA-65 and the server verifies the signature before processing.

### Response

```json
{
  "success": true,
  "txId": "abc123..."
}
```

### Error Response

```json
{
  "success": false,
  "error": "insufficient balance: have 50.0000 XRGE, need 100.1000 XRGE"
}
```

---

## Get Transactions

Retrieve recent transactions.

```http
GET /api/txs?limit=50&offset=0
```

### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 200 | Max transactions to return (max 1000) |
| `offset` | number | 0 | Pagination offset |

### Response

Each item wraps the transaction with its block context. The wrapper fields are camelCase
(`txId`, `blockHeight`, `blockHash`, `blockTime`); the nested `tx` (a `TxV1`) is
snake_case.

```json
{
  "txs": [
    {
      "txId": "abc123...",
      "blockHeight": 42,
      "blockHash": "xyz...",
      "blockTime": 1706745600000,
      "tx": {
        "version": 1,
        "tx_type": "transfer",
        "from_pub_key": "abc...",
        "nonce": 1234567890,
        "payload": {
          "to_pub_key_hex": "def...",
          "amount": 100
        },
        "fee": 0.1,
        "sig": "ghi..."
      }
    }
  ],
  "total": 150
}
```

---

## Get Transaction by Hash

```http
GET /api/tx/:hash
```

### Response

`txId`, `blockHeight`, `blockHash`, and `blockTime` are top-level (not inside `tx`). The
nested `tx` (a `TxV1`) is snake_case, and `receipt` carries the execution receipt when
present.

```json
{
  "success": true,
  "txId": "abc123...",
  "blockHeight": 42,
  "blockHash": "xyz...",
  "blockTime": 1706745600000,
  "tx": {
    "version": 1,
    "tx_type": "transfer",
    "from_pub_key": "abc...",
    "nonce": 1234567890,
    "payload": {
      "to_pub_key_hex": "def...",
      "amount": 100
    },
    "fee": 0.1,
    "sig": "ghi..."
  },
  "receipt": null
}
```

---

## Get Transaction Receipt

```http
GET /api/tx/:hash/receipt
```

Returns execution receipt for contract calls and other complex transactions.

---

## Request Faucet (v2)

Get free testnet XRGE tokens.

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

### Rate Limit

The faucet has additional rate limiting:
- 1 request per address per hour
- Whitelisted addresses bypass rate limits

---

## Transaction Types

| Type | Description |
|------|-------------|
| `transfer` | Standard XRGE or token transfer |
| `faucet` | Faucet distribution |
| `stake` | Stake tokens to become validator |
| `unstake` | Unstake tokens |
| `create_token` | Create custom token |
| `burn` | Burn tokens permanently |
| `shield` | Shield tokens (make private) |
| `unshield` | Unshield tokens (make public) |
| `contract_deploy` | Deploy WASM smart contract |
| `contract_call` | Call smart contract method |
