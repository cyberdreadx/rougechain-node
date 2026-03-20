# Blocks API

Endpoints for querying block data on RougeChain.

## Get Blocks

```http
GET /api/blocks?limit=50&from_height=0
```

### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 50 | Maximum blocks to return (max 100, up to 1000 for sync) |
| `from_height` | number | - | Start from this block height (used for P2P sync) |
| `offset` | number | 0 | Pagination offset |

### Response

```json
{
  "blocks": [
    {
      "version": 1,
      "header": {
        "version": 1,
        "chainId": "rougechain-devnet-1",
        "height": 42,
        "time": 1706745600000,
        "prevHash": "abc123...",
        "txHash": "def456...",
        "proposerPubKey": "ghi789..."
      },
      "txs": [...],
      "proposerSig": "...",
      "hash": "xyz..."
    }
  ],
  "total": 12345
}
```

### Block Fields

| Field | Type | Description |
|-------|------|-------------|
| `version` | number | Block format version |
| `header.height` | number | Block number |
| `header.time` | number | Timestamp (ms since epoch) |
| `header.prevHash` | string | Hash of previous block |
| `header.txHash` | string | Merkle root of transactions |
| `header.proposerPubKey` | string | Validator who proposed this block |
| `txs` | array | Transactions included in this block |
| `proposerSig` | string | ML-DSA-65 signature by the proposer |
| `hash` | string | SHA-256 hash of this block |

---

## Block Summary

```http
GET /api/blocks/summary
```

Returns a lightweight summary of recent blocks, suitable for charts and dashboards.

### Response

```json
{
  "blocks": [
    {
      "height": 42,
      "time": 1706745600000,
      "txCount": 5,
      "proposer": "abc123..."
    }
  ]
}
```

---

## Import Block (P2P)

Used by peer nodes to propagate blocks.

```http
POST /api/blocks/import
Content-Type: application/json
```

See [Peers API](peers.md#import-block-p2p) for details.

---

## Block Verification

Every block is verified by receiving nodes:

1. **Hash check** — Recompute the block hash and compare
2. **Signature check** — Verify ML-DSA-65 signature against the proposer's public key
3. **Height check** — Must extend the current chain tip by exactly 1
4. **Previous hash** — Must reference the current tip's hash
5. **Transaction validity** — All transactions must have valid signatures and sufficient balances
