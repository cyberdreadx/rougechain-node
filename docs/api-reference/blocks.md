# Blocks API

Endpoints for querying block data on RougeChain.

## Get Blocks

```http
GET /api/blocks?limit=50
```

### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | number | - | Page number (1-based); enables paginated mode |
| `per_page` | number | 10 | Blocks per page (used with `page`) |
| `limit` | number | 100 (1000 with `from_height`) | Maximum blocks to return (max 100, up to 1000 with `from_height`) |
| `from_height` | number | - | Start from this block height (used for P2P sync) |

### Response

```json
{
  "blocks": [
    {
      "version": 1,
      "header": {
        "version": 1,
        "chain_id": "rougechain-devnet-1",
        "height": 42,
        "time": 1706745600000,
        "prev_hash": "abc123...",
        "tx_hash": "def456...",
        "proposer_pub_key": "ghi789...",
        "state_root": "...",
        "parent_commit": { "...": "..." }
      },
      "txs": [...],
      "proposer_sig": "...",
      "hash": "xyz..."
    }
  ],
  "total_height": 12345,
  "page": 1,
  "total_pages": 1235
}
```

> `total_height`, `page` and `total_pages` are only returned in paginated mode (when `page`
> is supplied); with `limit` or `from_height` the response contains only `blocks`.

### Block Fields

| Field | Type | Description |
|-------|------|-------------|
| `version` | number | Block format version |
| `header.chain_id` | string | Chain identifier |
| `header.height` | number | Block number |
| `header.time` | number | Timestamp (ms since epoch) |
| `header.prev_hash` | string | Hash of previous block |
| `header.tx_hash` | string | SHA-256 over the concatenated encoded transactions, in block order (not a Merkle root) |
| `header.proposer_pub_key` | string | Validator who proposed this block |
| `header.state_root` | string | Post-state root of the balance ledger (omitted before its activation height) |
| `header.parent_commit` | object | Finality certificate for the parent block (omitted before FINALITY_V2 activation) |
| `txs` | array | Transactions included in this block |
| `proposer_sig` | string | ML-DSA-65 signature by the proposer |
| `hash` | string | SHA-256 of the JSON-encoded header followed by `proposer_sig` |

---

## Block Summary

```http
GET /api/blocks/summary
```

Returns time-bucketed block/transaction counts, suitable for charts and dashboards.

### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `range` | string | `24h` | Time range: `1h`, `24h`, or `7d` |

### Response

```json
{
  "success": true,
  "range": "24h",
  "intervalMs": 3600000,
  "startTime": 1706659200000,
  "endTime": 1706745600000,
  "points": [
    {
      "timestamp": 1706742000000,
      "blocks": 42,
      "transactions": 137
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
5. **Designated proposer** — The proposer must be the designated proposer for that height (largest eligible stake; ties → lowest public key)
6. **Parent commit** — The parent must carry a ⅔-stake finality certificate (`parent_commit`)
7. **Transaction validity** — All transactions must have valid signatures and sufficient balances
8. **State root** — The post-state must match `state_root`
