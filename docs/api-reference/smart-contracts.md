# Smart Contracts API

Since mainnet block 150 every contract transaction is **signed by the player**: the signer of a
call is the caller the contract sees (`host_get_caller`) and pays the fee; the signer of a
deployment is the deployer. The old node-signed endpoints are retired:
`POST /api/v2/contract/deploy` returns **410 Gone** and `POST /api/v2/contract/call` is a dry run
only (and is not reachable on the public mainnet edge). Use the endpoints below, or
`rc.contracts` in `@rougechain/sdk` 1.9.0+.

Signed requests use the standard `/api/v2/*` envelope `{ payload, signature, public_key }`:
`signature` is ML-DSA-65 over the JSON of `payload` with keys sorted, `payload.from` must equal
`public_key`, and `payload.timestamp` (ms) must be within 5 minutes of the node clock.

## Publish (Deploy) Contract

**POST** `/api/v2/contract/publish`

| Payload field | Type | Required | Description |
|---------------|------|----------|-------------|
| `type` | string | ✅ | `"contract_deploy"` |
| `from` | string | ✅ | Deployer's signing public key (hex) |
| `wasm` | string | ✅ | Base64-encoded WASM bytecode (max 1 MiB, must export `memory`) |
| `nonce` | string | ✅ | Random string, at least 8 characters |
| `timestamp` | number | ✅ | Milliseconds since the epoch |

**Response:**
```json
{ "success": true, "txId": "…", "address": "<40 hex chars>", "fee": 10 }
```

> Publish fee: **10 XRGE** flat. The contract is installed when the tx is mined. Its address is
> fixed by the signed fields, so it is known before the block:
> `hex(sha256("rougechain/contract/v2" ‖ from ‖ 0x00 ‖ nonce ‖ 0x00 ‖ sha256(wasm))[0..20])`.

## Execute (Call) Contract

A state-changing call, included in a block.

**POST** `/api/v2/contract/execute`

| Payload field | Type | Required | Description |
|---------------|------|----------|-------------|
| `type` | string | ✅ | `"contract_call"` |
| `from` | string | ✅ | Caller's signing public key (hex) |
| `contractAddr` | string | ✅ | Contract address (hex, lower case) |
| `method` | string | ✅ | Method name |
| `args` | any JSON | ❌ | Arguments (`{}` when omitted) |
| `gasLimit` | number | ✅ | Integer 1 – 10,000,000 |
| `timestamp` | number | ✅ | Milliseconds since the epoch |
| `nonce` | string | ✅ | Random string |

**Response:**
```json
{
  "success": true,
  "txId": "…",
  "fee": 0.05,
  "preview": { "returnData": { }, "gasUsed": 31234, "events": [] }
}
```

> Call fee: `gasLimit × 0.000001` XRGE (the **signed** limit, charged up front). The node dry-runs
> the call first and refuses it (`"call would fail: …"`, nothing charged) if it would fail or needs
> more gas than the limit. The authoritative run happens in the block: if the call reverts there
> (because state changed in between), it is still included and charged, and its receipt
> (`GET /api/tx/:txId/receipt`) reports `"status": {"Failed": "<error>"}` instead of `"Success"`.

## Query Contract (read-only)

A free dry run against the live state. Nothing is signed, charged or committed.

**POST** `/api/contract/:addr/query`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `method` | string | ✅ | Method name |
| `args` | any JSON | ❌ | Arguments |
| `caller` | string | ❌ | Public key the contract sees as `host_get_caller` |

**Response:**
```json
{ "success": true, "returnData": { }, "gasUsed": 812, "events": [], "error": null }
```

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

**GET** `/api/contract/:addr/events?limit=50&before=<height>&tx=<txhash>`

Returns indexed events emitted by the contract, newest first. `limit` is 1–1000 (default 50),
`before` returns only events from blocks below that height (paging), and `tx` returns only the
events of one transaction.

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

## Live Events (WebSocket)

Connect to `wss://<node>/api/ws` and send `{ "subscribe": ["contract:<addr>"] }`. After each block
is accepted you receive one frame per event:

```json
{ "type": "contract_event", "contract_addr": "…", "topic": "move",
  "data": "…", "block_height": 1234, "tx_hash": "…" }
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
