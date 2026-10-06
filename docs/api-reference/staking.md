# Staking API

Endpoints for validator staking operations. All write operations use v2 signed requests.

## List Validators

```http
GET /api/validators
```

### Response

```json
{
  "success": true,
  "validators": [
    {
      "publicKey": "abc123...",
      "name": "my-node",
      "stake": 20000,
      "status": "active",
      "slashCount": 0,
      "jailedUntil": 0,
      "entropyContributions": 0,
      "blocksProposed": 142
    },
    {
      "publicKey": "def456...",
      "stake": 10000,
      "status": "active",
      "slashCount": 0,
      "jailedUntil": 0,
      "entropyContributions": 0,
      "blocksProposed": 71
    }
  ],
  "totalStake": 30000
}
```

### Validator Fields

| Field | Type | Description |
|-------|------|-------------|
| `publicKey` | string | Validator's ML-DSA-65 public key |
| `name` | string | Node name, if known (omitted otherwise) |
| `stake` | number | Amount of XRGE staked |
| `status` | string | `active`, `jailed` or `inactive` (no stake) |
| `slashCount` | number | Times this validator has been slashed (historical: no slashing is active since height 100, and the `slash` transaction is rejected since height 245) |
| `jailedUntil` | number | Block height the validator is jailed until (`0` if never) |
| `entropyContributions` | number | Entropy contributions counter |
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
  "message": "Stake transaction submitted"
}
```

No transaction id is returned; check `/api/validators` once the transaction is in a block.

### Requirements

| Requirement | Value |
|-------------|-------|
| Minimum stake | 10,000 XRGE — checked by this API (and the CLI), not by consensus; a block applying a smaller stake is valid |
| Fee | 1 XRGE (fixed for stake and unstake) |

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
  "message": "Unstake transaction submitted"
}
```

### Unbonding

After unstaking, tokens enter an unbonding period (500 blocks) before they become available in your balance.

---

## Error Responses

| Error | Cause |
|-------|-------|
| `"insufficient XRGE balance: …"` | Not enough XRGE to cover the stake plus the 1 XRGE fee |
| `"minimum stake is 10000 XRGE"` | Amount is less than 10,000 XRGE |
| `"insufficient staked balance: …"` | Unstaking more than is staked |
| `"Invalid signature"` / `"Signature verification failed: …"` | ML-DSA-65 signature verification failed |
