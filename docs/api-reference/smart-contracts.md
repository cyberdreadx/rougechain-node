# Smart Contracts API

## Deploy Contract

Deploy a WASM smart contract to RougeChain.

**POST** `/api/v2/contract/deploy`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `wasm` | string | ✅ | Base64-encoded WASM bytecode |
| `deployer` | string | ✅ | Deployer's public key (hex) |
| `nonce` | number | ❌ | Nonce for deterministic address (default: 0) |

**Response:**
```json
{
  "success": true,
  "address": "a1b2c3d4e5f6...",
  "wasmSize": 12345,
  "txHash": "4520936071b9..."
}
```

> Contract deploy fee: `wasmSize × 0.000001` XRGE

## Call Contract

Execute a method on a deployed contract (mutating — creates an on-chain tx).

**POST** `/api/v2/contract/call`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `contractAddr` | string | ✅ | Contract address (hex) |
| `method` | string | ✅ | Method name to call |
| `caller` | string | ❌ | Caller's public key |
| `args` | object | ❌ | JSON arguments |
| `gasLimit` | number | ❌ | Max fuel (default: 10,000,000) |

**Response:**
```json
{
  "success": true,
  "returnData": { ... },
  "gasUsed": 1500,
  "events": [],
  "txHash": "b226a36688f0...",
  "error": null
}
```

> Contract call fee: `gasUsed × 0.000001` XRGE

## Get Contract Metadata

**GET** `/api/contract/:addr`

Returns contract metadata: address, deployer, code hash, creation timestamp, WASM size.

```json
{
  "success": true,
  "contract": {
    "address": "86fe93e2...",
    "deployer": "test-deployer",
    "code_hash": "a1b2c3...",
    "wasm_size": 711,
    "created_at": 1774401569985
  }
}
```

## Read Contract Storage

### Full State Dump

**GET** `/api/contract/:addr/state`

Returns all key-value pairs in the contract's persistent storage.

```json
{
  "success": true,
  "state": {
    "count": "42",
    "owner": "alice"
  },
  "count": 2
}
```

### Single Key Lookup

**GET** `/api/contract/:addr/state?key=<hex_key>`

Reads a single key from storage.

```json
{
  "success": true,
  "key": "636f756e74",
  "value": "3432",
  "valueUtf8": "42"
}
```

## Get Contract Events

**GET** `/api/contract/:addr/events?limit=50`

Returns indexed events emitted by the contract.

```json
{
  "success": true,
  "events": [
    {
      "contract_addr": "86fe93e2...",
      "topic": "transfer",
      "data": "{\"from\":\"alice\",\"to\":\"bob\",\"amount\":100}",
      "block_height": 620,
      "tx_hash": "c3d4e5f6..."
    }
  ],
  "count": 1
}
```

## List All Contracts

**GET** `/api/contracts`

Returns all deployed contracts with their metadata.

```json
{
  "success": true,
  "contracts": [
    {
      "address": "86fe93e2...",
      "deployer": "test-deployer",
      "code_hash": "a1b2c3...",
      "wasm_size": 711,
      "created_at": 1774401569985
    }
  ],
  "count": 1
}
```
