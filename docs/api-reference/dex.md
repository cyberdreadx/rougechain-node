# API Reference — DEX / AMM

## Read Endpoints

### List Pools

```
GET /api/pools
```

Returns all liquidity pools with reserves, LP supply, and token info.

### Get Pool

```
GET /api/pool/:pool_id
```

Pool ID format: `TOKEN_A-TOKEN_B` (alphabetically sorted).

### Get Pool Events

```
GET /api/pool/:pool_id/events
```

Returns swap, add_liquidity, and remove_liquidity events for a pool.

### Get Pool Price History

```
GET /api/pool/:pool_id/prices
```

### Get Pool Stats

```
GET /api/pool/:pool_id/stats
```

### Get Swap Quote

```
POST /api/swap/quote
```

**Body:**
```json
{
  "tokenIn": "XRGE",
  "tokenOut": "qETH",
  "amountIn": 1000
}
```

**Response:**
```json
{
  "amountOut": 95,
  "priceImpact": 0.5,
  "fee": 3,
  "route": ["XRGE", "qETH"]
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
