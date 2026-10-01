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

> **Fee:** The transaction fee is fixed at **1 XRGE** and enforced by the server; any
> client-supplied `fee` in the payload is ignored.
>
> **Security:** Private keys never leave your application. The transaction is signed client-side using ML-DSA-65 and the server verifies the signature before processing.

### Response

```json
{
  "success": true,
  "message": "Transfer transaction submitted"
}
```

The response does not include a transaction id.

### Error Response

```json
{
  "success": false,
  "error": "insufficient XRGE balance: have 50.0000, need 101.0000"
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
        "fee": 1.0,
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

`txId`, `blockHeight`, `blockHash` and `blockTime` are top-level (not inside `tx`). The nested
`tx` is the stored `TxV1` exactly as it was signed and accepted, in **snake_case**; `receipt` is
the execution receipt (present once the block is applied; `null` only for a transaction that is
known but not yet executed). The example below is a real mainnet transfer
(`3c1b71bc…`, block 110); unused `payload` fields are returned as `null` and omitted here.

```json
{
  "success": true,
  "txId": "3c1b71bc59557f9b4d1191bc299e1bd2d8b6ad4058147efebe70d0f6c07daae1",
  "blockHeight": 110,
  "blockHash": "7ee2afd4eaebdcd4…",
  "blockTime": 1790297628272,
  "tx": {
    "version": 1,
    "tx_type": "transfer",
    "from_pub_key": "df255dbd…",
    "nonce": 4,
    "payload": {
      "to_pub_key_hex": "rouge1cd3mkuu6p89nm6uakpcchfmkvhj8x2z0xfx33gag9t5kma2s8fcs4m9mda",
      "amount": 50,
      "token_name": "XRGE"
    },
    "fee": 1.0,
    "sig": "…",
    "signed_payload": "{…}"
  },
  "receipt": {
    "tx_hash": "3c1b71bc…",
    "block_height": 110,
    "block_hash": "7ee2afd4eaebdcd4…",
    "index": 0,
    "tx_type": "transfer",
    "from": "df255dbd…",
    "status": "Success",
    "fee_paid": 1.0,
    "timestamp": 1790297628272,
    "logs": [
      { "event_type": "transfer", "data": { "amount": 50, "to": "rouge1cd3mkuu…", "token": "XRGE" } }
    ]
  }
}
```

### Field notes

- **`tx.payload.to_pub_key_hex` holds the recipient exactly as it was submitted** — either a
  `rouge1…` address (as in the example) or a hex public key. The name is historical; treat it as
  "recipient", not as a guarantee of a hex key. To convert either form to the other, call
  [`GET /api/resolve/:input`](wallet.md#resolve-address--public-key) (auto-detects the format
  and returns `address`, `publicKey` and `balance`).
- `receipt.logs[].data.to` carries the same recipient value; `receipt.status` is `"Success"` or
  `{"Failed": "<reason>"}`.
- `signed_payload` is the exact JSON the sender signed (V2 transactions); consensus binds the
  executed fields to it, so `tx.*` never differs from what was signed.
- **Stability:** the `tx` and `receipt` field names are the serialized `TxV1` / `TxReceipt`
  types and are stable; any change would ship as a new versioned endpoint, not as a rename.

---

## Get Transaction Receipt

```http
GET /api/tx/:hash/receipt
```

Returns execution receipt for contract calls and other complex transactions.

---

## Request Faucet (v2)

Get free testnet XRGE tokens. The faucet is only enabled on test networks; elsewhere it returns `403`.

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

### Limits

The faucet refuses a request (`429`) while you already have a faucet transfer pending, or if your balance is already above the faucet threshold.

---

## Transaction Types

| Type | Description |
|------|-------------|
| `transfer` | Standard XRGE or token transfer (faucet payouts are `transfer`s with `payload.faucet = true`) |
| `stake` | Stake tokens to become validator |
| `unstake` | Unstake tokens |
| `create_token` | Create custom token |
| `burn` | Burn tokens permanently |
| `shield` | Shield tokens (make private) |
| `unshield` | Unshield tokens (make public) |
| `contract_deploy` | Deploy WASM smart contract |
| `contract_call` | Call smart contract method |
