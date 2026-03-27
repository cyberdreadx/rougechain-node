# Staking API

Endpoints for validator staking operations. All write operations use v2 signed requests.

## List Validators

```http
GET /api/validators
```

### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `publicKey` | string | (Optional) Filter by specific validator |

### Response

```json
{
  "validators": [
    {
      "publicKey": "abc123...",
      "stake": 10000.0,
      "status": "active",
      "blocksProposed": 142
    },
    {
      "publicKey": "def456...",
      "stake": 5000.0,
      "status": "active",
      "blocksProposed": 71
    }
  ],
  "totalStaked": 15000.0
}
```

### Validator Fields

| Field | Type | Description |
|-------|------|-------------|
| `publicKey` | string | Validator's ML-DSA-65 public key |
| `stake` | number | Amount of XRGE staked |
| `status` | string | `active` or `unbonding` |
| `blocksProposed` | number | Total blocks produced |

---

## Stake Tokens

```http
POST /api/v2/stake
Content-Type: application/json
```

### Request Body

```json
{
  "payload": {
    "amount": 10000,
    "from": "your-public-key-hex",
    "timestamp": 1706745600000,
    "nonce": "random-hex-string"
  },
  "signature": "your-ml-dsa65-signature-hex",
  "public_key": "your-public-key-hex"
}
```

### Response

```json
{
  "success": true,
  "txId": "abc123...",
  "stake": 10000.0,
  "status": "active"
}
```

### Requirements

| Requirement | Value |
|-------------|-------|
| Minimum stake | 10,000 XRGE |
| Fee | 0.1 XRGE |

---

## Unstake Tokens

```http
POST /api/v2/unstake
Content-Type: application/json
```

### Request Body

```json
{
  "payload": {
    "amount": 5000,
    "from": "your-public-key-hex",
    "timestamp": 1706745600000,
    "nonce": "random-hex-string"
  },
  "signature": "your-ml-dsa65-signature-hex",
  "public_key": "your-public-key-hex"
}
```

### Response

```json
{
  "success": true,
  "txId": "abc123...",
  "remainingStake": 5000.0
}
```

### Unbonding

After unstaking, tokens enter an unbonding period (~7 days on testnet) before they become available in your balance.

---

## Error Responses

| Error | Cause |
|-------|-------|
| `"insufficient balance"` | Not enough XRGE to stake |
| `"below minimum stake"` | Amount is less than 10,000 XRGE |
| `"validator not found"` | Trying to unstake but not a validator |
| `"invalid signature"` | ML-DSA-65 signature verification failed |
