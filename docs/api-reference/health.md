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
  "blockHeight": 12345,
  "totalTransactions": 98765,
  "totalWallets": 432,
  "totalValidators": 15,
  "totalStaked": 150000.0,
  "totalBurned": 5000.0,
  "totalPools": 8,
  "chainId": "rougechain-devnet-1"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `blockHeight` | number | Current block height |
| `totalTransactions` | number | Total transactions processed |
| `totalWallets` | number | Unique wallets on the network |
| `totalValidators` | number | Active validators |
| `totalStaked` | number | Total XRGE staked |
| `totalBurned` | number | Total XRGE burned |
| `totalPools` | number | Number of AMM liquidity pools |
| `chainId` | string | Chain identifier |

---

## Burn Stats

```http
GET /api/burned
```

Get burned token statistics.

### Response

```json
{
  "totalBurned": 5000.0,
  "burnAddress": "XRGE_BURN_0x000000000000000000000000000000000000000000000000000000000000DEAD"
}
```

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
