# API Reference — DEX / AMM

## Read Endpoints

### List Pools

```
GET /api/pools
```

Returns all liquidity pools with reserves, LP supply, and token info.

**Response:**
```json
{
  "success": true,
  "pools": [
    {
      "pool_id": "XRGE-MTK",
      "token_a": "MTK",
      "token_b": "XRGE",
      "reserve_a": 50000,
      "reserve_b": 100000,
      "total_lp_supply": 70710,
      "fee_rate": 0.003
    }
  ]
}
```

### Get Pool

```
GET /api/pool/:pool_id
```

Pool ID format: `TOKEN_A-TOKEN_B` (alphabetically sorted).

**Response:**
```json
{
  "success": true,
  "pool": {
    "pool_id": "XRGE-MTK",
    "token_a": "MTK",
    "token_b": "XRGE",
    "reserve_a": 50000,
    "reserve_b": 100000,
    "total_lp_supply": 70710,
    "fee_rate": 0.003
  }
}
```

### Get Pool Events

```
GET /api/pool/:pool_id/events
```

Returns swap, add_liquidity, and remove_liquidity events for a pool.

**Response:**
```json
{
  "success": true,
  "events": [
    {
      "id": "evt_abc123",
      "pool_id": "XRGE-MTK",
      "event_type": "Swap",
      "user_pub_key": "abc123...",
      "timestamp": 1710000000,
      "block_height": 12345,
      "tx_hash": "tx_abc...",
      "token_in": "XRGE",
      "token_out": "MTK",
      "amount_in": 1000,
      "amount_out": 490,
      "reserve_a_after": 50490,
      "reserve_b_after": 99000
    }
  ]
}
```

### Get Pool Price History

```
GET /api/pool/:pool_id/prices
```

Returns up to 500 price snapshots in chronological order. A snapshot is recorded after every swap, pool creation, and liquidity change.

**Response:**
```json
{
  "success": true,
  "prices": [
    {
      "pool_id": "XRGE-MTK",
      "timestamp": 1710000000,
      "block_height": 12345,
      "reserve_a": 50000,
      "reserve_b": 100000,
      "price_a_in_b": 2.0,
      "price_b_in_a": 0.5
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `price_a_in_b` | How many `token_b` for 1 `token_a` |
| `price_b_in_a` | How many `token_a` for 1 `token_b` |

### Get Pool Stats

```
GET /api/pool/:pool_id/stats
```

**Response:**
```json
{
  "success": true,
  "stats": {
    "pool_id": "XRGE-MTK",
    "total_swaps": 142,
    "total_volume_a": 500000,
    "total_volume_b": 1000000,
    "swap_count_24h": 12,
    "volume_24h_a": 25000,
    "volume_24h_b": 50000
  }
}
```

### Get Swap Quote

```
POST /api/swap/quote
```

**Body:**
```json
{
  "token_in": "XRGE",
  "token_out": "qETH",
  "amount_in": 1000
}
```

**Response:**
```json
{
  "success": true,
  "amount_out": 95,
  "price_impact": 0.5,
  "path": ["XRGE", "qETH"],
  "pools": ["XRGE-qETH"]
}
```

### Get All Events

```
GET /api/events
```

Returns all DEX events across all pools.

## Write Endpoints (v2 Signed)

### Create Pool

```
POST /api/v2/pool/create
```

**Payload fields:** `token_a`, `token_b`, `amount_a`, `amount_b`
**Fee:** 100 XRGE

### Add Liquidity

```
POST /api/v2/pool/add-liquidity
```

**Payload fields:** `pool_id`, `amount_a`, `amount_b`
**Fee:** 1 XRGE

### Remove Liquidity

```
POST /api/v2/pool/remove-liquidity
```

**Payload fields:** `pool_id`, `lp_amount`
**Fee:** 1 XRGE

### Execute Swap

```
POST /api/v2/swap/execute
```

**Payload fields:** `token_in`, `token_out`, `amount_in`, `min_amount_out`
**Fee:** 0.3% of input + 1 XRGE

## SDK Usage

```typescript
import { RougeChain, Wallet } from '@rougechain/sdk';
import type { PriceSnapshot, PoolEvent, PoolStats } from '@rougechain/sdk';

const rc = new RougeChain('https://testnet.rougechain.io/api');

// Read
const pools = await rc.dex.getPools();
const pool = await rc.dex.getPool('XRGE-MTK');
const prices: PriceSnapshot[] = await rc.dex.getPriceHistory('XRGE-MTK');
const stats: PoolStats = await rc.dex.getPoolStats('XRGE-MTK');
const events: PoolEvent[] = await rc.dex.getPoolEvents('XRGE-MTK');

// Quote & swap
const quote = await rc.dex.quote({ poolId: 'XRGE-MTK', tokenIn: 'XRGE', tokenOut: 'MTK', amountIn: 100 });
await rc.dex.swap(wallet, { tokenIn: 'XRGE', tokenOut: 'MTK', amountIn: 100, minAmountOut: 95 });
```
