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
  "wasmSize": 12345
}
```

## Call Contract

Execute a method on a deployed contract (mutating).

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
  "error": null
}
```

## Get Contract Metadata

**GET** `/api/contract/:addr`

Returns contract metadata: address, deployer, code hash, creation height, WASM size.

## Read Contract Storage

**GET** `/api/contract/:addr/state?key=<hex_key>`

Reads a single key from the contract's persistent storage.

## Get Contract Events

**GET** `/api/contract/:addr/events?limit=50`

Returns indexed events emitted by the contract.

## List All Contracts

**GET** `/api/contracts`

Returns all deployed contracts with their metadata.
