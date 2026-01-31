# Transactions API

## Submit Transaction

Send XRGE tokens to another address.

```http
POST /api/tx/submit
Content-Type: application/json
```

### Request Body

```json
{
  "fromPrivateKey": "your-private-key-hex",
  "fromPublicKey": "your-public-key-hex", 
  "toPublicKey": "recipient-public-key-hex",
  "amount": 100.0,
  "fee": 0.1
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `fromPrivateKey` | string | Yes | Sender's ML-DSA-65 private key (hex) |
| `fromPublicKey` | string | Yes | Sender's ML-DSA-65 public key (hex) |
| `toPublicKey` | string | Yes | Recipient's public key (hex) |
| `amount` | number | Yes | Amount of XRGE to send |
| `fee` | number | No | Transaction fee (default: 0.1) |

### Response

```json
{
  "success": true,
  "txId": "abc123...",
  "tx": {
    "version": 1,
    "txType": "transfer",
    "fromPubKey": "...",
    "nonce": 1234567890,
    "payload": {
      "toPubKeyHex": "...",
      "amount": 100
    },
    "fee": 0.1,
    "sig": "..."
  }
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
| `limit` | number | 50 | Max transactions to return |
| `offset` | number | 0 | Pagination offset |

### Response

```json
{
  "txs": [
    {
      "version": 1,
      "txType": "transfer",
      "fromPubKey": "abc...",
      "nonce": 1234567890,
      "payload": {
        "toPubKeyHex": "def...",
        "amount": 100
      },
      "fee": 0.1,
      "sig": "ghi...",
      "blockHeight": 42,
      "blockTime": 1706745600000
    }
  ],
  "total": 150
}
```

---

## Request Faucet (Testnet)

Get free testnet XRGE tokens.

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

### Rate Limit

The faucet has additional rate limiting:
- 1 request per address per hour
- Whitelisted addresses bypass rate limits

---

## Transaction Types

| Type | Description |
|------|-------------|
| `transfer` | Standard XRGE transfer |
| `faucet` | Faucet distribution |
| `stake` | Stake tokens to become validator |
| `unstake` | Unstake tokens |
| `create_token` | Create custom token |
