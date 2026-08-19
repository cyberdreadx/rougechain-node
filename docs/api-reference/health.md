# Health & Stats API

System endpoints for monitoring node status and network statistics.

## Health Check

```http
GET /api/health
```

Returns the node's current status.

### Response

```json
{
  "status": "ok",
  "chain_id": "rougechain-devnet-1",
  "height": 12345
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | string | `"ok"` if the node is healthy |
| `chain_id` | string | The chain identifier |
| `height` | number | Current block height |

### Use Cases

- Monitoring node uptime
- Checking sync status (compare height with peers)
- Load balancer health checks

---

## Network Statistics

```http
GET /api/stats
```

Returns network-wide statistics.

### Response

```json
{
  "connected_peers": 3,
  "network_height": 12345,
  "is_mining": true,
  "node_id": "abc123...",
  "total_fees_collected": 1234.5,
  "fees_in_last_block": 0.6,
  "chain_id": "rougechain-devnet-1",
  "finalized_height": 12300,
  "ws_clients": 12,
  "node_name": "node-1",
  "base_fee": 0.001,
  "total_fees_burned": 5000.0
}
```

| Field | Type | Description |
|-------|------|-------------|
| `connected_peers` | number | Currently connected peers |
| `network_height` | number | Current block height |
| `is_mining` | boolean | Whether this node is mining |
| `node_id` | string | This node's ID |
| `total_fees_collected` | number | Total fees collected |
| `fees_in_last_block` | number | Fees collected in the last block |
| `chain_id` | string | Chain identifier |
| `finalized_height` | number | Last finalized block height |
| `ws_clients` | number | Active WebSocket clients |
| `node_name` | string \| null | Human-readable node name (optional) |
| `base_fee` | number | Current EIP-1559 base fee |
| `total_fees_burned` | number | Total fees (base fee) burned |

---

## Burn Stats

```http
GET /api/burned
```

Get burned token statistics.

### Response

```json
{
  "burned": {
    "XRGE": 5000.0,
    "qETH": 1.5
  },
  "total_xrge_burned": 5000.0
}
```

| Field | Type | Description |
|-------|------|-------------|
| `burned` | object | Per-token burned totals, keyed by token symbol |
| `total_xrge_burned` | number | Total XRGE burned |

---

## Examples

### Monitoring Script

```bash
#!/bin/bash
while true; do
  HEIGHT=$(curl -s http://127.0.0.1:5100/api/health | jq '.height')
  echo "$(date): Block height = $HEIGHT"
  sleep 10
done
```

### Compare with Testnet

```bash
LOCAL=$(curl -s http://127.0.0.1:5100/api/health | jq '.height')
TESTNET=$(curl -s https://testnet.rougechain.io/api/health | jq '.height')
echo "Local: $LOCAL, Testnet: $TESTNET, Behind: $((TESTNET - LOCAL))"
```
