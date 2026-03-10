# Staking API

Endpoints for validator staking operations.

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

### Legacy API

```http
POST /api/stake/submit
Content-Type: application/json
```

```json
{
  "fromPrivateKey": "your-private-key-hex",
  "fromPublicKey": "your-public-key-hex",
  "amount": 1000
}
```

### v2 API (Client-Side Signing)

```http
POST /api/v2/stake
Content-Type: application/json
```

```json
{
  "publicKey": "your-public-key-hex",
  "payload": {
    "amount": 1000
  },
  "nonce": 1706745600000,
  "signature": "your-ml-dsa65-signature-hex"
}
```

### Response

```json
{
  "success": true,
  "txId": "abc123...",
  "stake": 1000.0,
  "status": "active"
}
```

### Requirements

| Requirement | Value |
|-------------|-------|
| Minimum stake | 1,000 XRGE |
| Fee | 0.1 XRGE |

---

## Unstake Tokens

### Legacy API

```http
POST /api/unstake/submit
Content-Type: application/json
```

```json
{
  "fromPrivateKey": "your-private-key-hex",
  "fromPublicKey": "your-public-key-hex",
  "amount": 500
}
```

### v2 API (Client-Side Signing)

```http
POST /api/v2/unstake
Content-Type: application/json
```

```json
{
  "publicKey": "your-public-key-hex",
  "payload": {
    "amount": 500
  },
  "nonce": 1706745600000,
  "signature": "your-ml-dsa65-signature-hex"
}
```

### Response

```json
{
  "success": true,
  "txId": "abc123...",
  "remainingStake": 500.0
}
```

### Unbonding

After unstaking, tokens enter an unbonding period (~7 days on testnet) before they become available in your balance.

---

## Error Responses

| Error | Cause |
|-------|-------|
| `"insufficient balance"` | Not enough XRGE to stake |
| `"below minimum stake"` | Amount is less than 1,000 XRGE |
| `"validator not found"` | Trying to unstake but not a validator |
| `"invalid signature"` | ML-DSA-65 signature verification failed |
