# WASM Smart Contracts

RougeChain includes a built-in WASM smart contract engine powered by `wasmi` — the same pure-Rust WASM interpreter used by Parity/Substrate.

> **v2 update:** contracts can now custody and move XRGE. `host_transfer` /
> `host_get_balance` operate in **quanta** (`1 XRGE = 10^9 quanta`), transfers
> are **single-hop** (a contract moves only its own balance), and moves are
> enforced conserving and overdraft-free. See
> [Contract XRGE Custody](contract-xrge-custody.md) for the rules and examples.

## Overview

Contracts are written in Rust (or any language that compiles to WASM), compiled to `.wasm`, and deployed on-chain. Execution is fuel-metered in a sandbox with host functions for chain interaction.

### Architecture

```
Your Contract (Rust) → cargo build --target wasm32-unknown-unknown
  → .wasm bytecode (must export its memory as "memory", max 1 MiB)
    → Publish: a transaction YOU sign (POST /api/v2/contract/publish)
      → Execute: calls YOU sign (POST /api/v2/contract/execute), run in the wasmi sandbox
        → Host functions bridge to chain state
```

Since block 150 on mainnet, every contract transaction is **player-signed**: the
wallet that signs a call is the caller the contract sees (`host_get_caller`) and pays
the fee; the wallet that signs a deployment is the deployer. The old node-signed
endpoints are retired — `POST /api/v2/contract/deploy` returns **410 Gone**, and
`POST /api/v2/contract/call` is only a dry run (it no longer submits anything).

## Host Functions

Contracts import these from the `env` module:

| Function | Description |
|----------|-------------|
| `host_log(ptr, len)` | Debug logging |
| `host_get_caller(buf, len)` | Caller's public key (the signer of the call) |
| `host_get_self_addr(buf, len)` | The contract's own address |
| `host_get_args_len() → i32` | Length in bytes of the call's JSON arguments (`{}` when none) |
| `host_read_args(buf, len) → i32` | Copy the JSON arguments into memory; bytes written, or `-1` if `buf` is too small |
| `host_get_block_height()` | Current block height |
| `host_get_block_time()` | Current block timestamp (seconds) |
| `host_get_balance(addr, len)` | XRGE balance in **quanta** (`1 XRGE = 10^9 quanta`) |
| `host_transfer(to, len, amount)` | Send XRGE (quanta) from the **contract's own** balance; single-hop |
| `host_storage_read(key, klen, val, vlen)` | Read persistent storage |
| `host_storage_write(key, klen, val, vlen)` | Write persistent storage |
| `host_storage_delete(key, klen)` | Delete from storage |
| `host_emit_event(topic, tlen, data, dlen)` | Emit an indexed event (stored, and pushed over WebSocket) |
| `host_sha256(data, dlen, out)` | Compute SHA-256 |
| `host_set_return(data, dlen)` | Set the return value |
| `host_call_contract(addr, alen, method, mlen, args, argslen, gas)` | Cross-contract call (returns call_id) |
| `host_get_call_result(call_id, buf, len)` | Read a sub-call result |
| `host_pqc_verify(pk, pklen, msg, msglen, sig, siglen)` | ML-DSA-65 signature verify |
| `host_pqc_pubkey_to_address(pk, pklen, out, outlen)` | Derive a `rouge1...` address |
| `host_pqc_hash_pubkey(pk, pklen, out)` | SHA-256 of a public key |

> **Coming:** native token, NFT and randomness host functions for games are being
> designed. They are not available yet; this page will document them when they ship.

## Gas Metering & Fees

Every WASM instruction costs 1 fuel unit. A call may use at most **10,000,000 fuel**
(≈10M instructions). If a contract runs out of fuel, execution halts and all state
changes are reverted.

### Fee Schedule

| Operation | Fee |
|-----------|-----|
| Publish (deploy) | **10 XRGE** flat |
| Call | `gasLimit × 0.000001` XRGE — the **signed gas limit**, charged up front |
| Query | Free (read-only, nothing is signed or committed) |

Because the fee is the signed `gasLimit`, not the gas used, pick a limit close to what
the call needs: query the call first and add headroom (the SDK does this for you:
`ceil(gasUsed × 1.5) + 1000`). The node dry-runs every call before accepting it and
refuses calls that would fail or that need more gas than the limit, so a failing call
costs nothing.

## API

All write endpoints take the standard signed envelope used by every `/api/v2/*`
transaction: `{ payload, signature, public_key }`, where `signature` is ML-DSA-65
over the JSON of `payload` with keys sorted. `payload.from` must be the signing key and
`payload.timestamp` (ms) must be within 5 minutes of the node's clock.

### Publish a Contract

```bash
POST /api/v2/contract/publish
{
  "payload": {
    "type": "contract_deploy",
    "from": "<your signing public key hex>",
    "wasm": "<base64 WASM bytecode>",
    "nonce": "<random string, at least 8 chars>",
    "timestamp": 1790000000000
  },
  "signature": "<ML-DSA-65 signature hex>",
  "public_key": "<your signing public key hex>"
}
→ { "success": true, "txId": "…", "address": "<40 hex chars>", "fee": 10 }
```

The contract is installed when the transaction is mined. Its address is fixed by what
you signed, so you know it before the block and nobody else can take it:

```
address = hex( sha256( "rougechain/contract/v2" ‖ from ‖ 0x00 ‖ nonce ‖ 0x00 ‖ sha256(wasm) )[0..20] )
```

Signing the same code again needs a new `nonce`.

### Call a Contract Method

```bash
POST /api/v2/contract/execute
{
  "payload": {
    "type": "contract_call",
    "from": "<your signing public key hex>",
    "contractAddr": "<contract address>",
    "method": "my_method",
    "args": { "key": "value" },
    "gasLimit": 50000,
    "timestamp": 1790000000000,
    "nonce": "<random string>"
  },
  "signature": "…",
  "public_key": "…"
}
→ { "success": true, "txId": "…", "fee": 0.05,
    "preview": { "returnData": …, "gasUsed": 31234, "events": [ … ] } }
```

`gasLimit` must be an integer from 1 to 10,000,000. The `preview` is the node's dry run;
the authoritative execution happens when the transaction is mined. A receipt
(`GET /api/tx/{txId}/receipt`) means the transaction was included. Check the contract's
events or state for the outcome, because a call can still revert in the block if the
state changed in between.

### Query (read-only, free)

```bash
POST /api/contract/{addr}/query
{ "method": "get_score", "args": { "player": "…" }, "caller": "<optional pubkey>" }
→ { "success": true, "returnData": …, "gasUsed": 812, "events": [], "error": null }
```

### Read Contract Data

```bash
GET /api/contract/{addr}                        # metadata
GET /api/contract/{addr}/state                  # full state dump (all keys)
GET /api/contract/{addr}/state?key=x            # one key (hex, or UTF-8 if not valid hex)
GET /api/contract/{addr}/events?limit=50        # event log
GET /api/contract/{addr}/events?before=12345    # older page: events below that block height
GET /api/contracts                              # list all contracts
```

### Live Events (WebSocket)

Connect to `wss://<node>/api/ws` and send:

```json
{ "subscribe": ["contract:<addr>"] }
```

After each block is accepted you receive one frame per event:

```json
{ "type": "contract_event", "contract_addr": "…", "topic": "move",
  "data": "…", "block_height": 1234, "tx_hash": "…" }
```

## ERC-20 Token Standard

RougeChain includes a reference ERC-20 token contract at `contracts/erc20_template/`. This implements the standard fungible token interface:

| Method | Args | Description |
|--------|------|-------------|
| `init` | `{name, symbol, decimals, total_supply, owner}` | Initialize token, mint supply to owner |
| `name` / `symbol` / `decimals` / `total_supply` | `{}` | Token metadata queries |
| `balance_of` | `{account}` | Get account balance |
| `transfer` | `{to, amount}` | Transfer tokens (caller → to) |
| `approve` | `{spender, amount}` | Set allowance |
| `allowance` | `{owner, spender}` | Get allowance |
| `transfer_from` | `{from, to, amount}` | Transfer using allowance |

### Storage Layout

- `meta:name` / `meta:symbol` / `meta:decimals` / `meta:total_supply` — Token metadata
- `bal:{account}` — Account balances
- `allow:{owner}:{spender}` — Allowances

### Build & Deploy

```bash
cd contracts/erc20_template
cargo build --release --target wasm32-unknown-unknown
# Publish target/wasm32-unknown-unknown/release/*.wasm with rc.contracts.publish (see SDK below)
```

## Explorer Integration

Deployed contracts are visible in the RougeChain explorer:

- **Contracts Explorer** (`/contracts`) — List all deployed contracts with search/sort
- **Contract Detail** (`/contract/{addr}`) — Contract info, live state viewer, interactive call UI
- **Transaction Detail** — Contract txs show: contract address, method, gas used, WASM size

## SDK

`@rougechain/sdk` 1.9.0+ has a `contracts` namespace that signs, submits, queries and
subscribes. The constructor takes the API base URL (note the trailing `/api`):

```typescript
import { RougeChain, Wallet } from '@rougechain/sdk';
import { readFileSync } from 'node:fs';

const rc = new RougeChain('https://api.rougechain.io/api');
const wallet = Wallet.fromMnemonic(process.env.MNEMONIC!);

// Publish (10 XRGE). The address is known before the block.
const wasm = readFileSync('target/wasm32-unknown-unknown/release/game.wasm');
const pub = await rc.contracts.publish(wallet, wasm);
console.log(pub.predictedAddress, pub.txId);
await rc.contracts.waitForReceipt(pub.txId!);

// Free read-only call
const q = await rc.contracts.query(pub.predictedAddress, 'get_score', { player: wallet.publicKey });

// Signed call. Without gasLimit the SDK queries first and signs ceil(gasUsed × 1.5) + 1000.
const r = await rc.contracts.execute(wallet, pub.predictedAddress, 'move', { x: 1, y: 2 });
if (!r.success) console.error(r.error);        // e.g. "call would fail: not your turn"

// Live events (one shared socket, reconnects automatically)
const stop = rc.contracts.subscribe(pub.predictedAddress, (e) => console.log(e.topic, e.data));

// State, events, metadata
const all = await rc.contracts.state(pub.predictedAddress);
const one = await rc.contracts.state(pub.predictedAddress, new TextEncoder().encode('score'));
const older = await rc.contracts.events(pub.predictedAddress, { limit: 50, before: 12_000 });
```

For games there is a smaller handle:

```typescript
const game = rc.contracts.game(address, wallet);
const off = game.on('move', (e) => render(JSON.parse(e.data)));   // or '*' for every topic
await game.call('move', { x: 1, y: 2 });
const board = await game.query('board');
```

In the browser, dApps can have the RougeChain extension sign `contract_call` and
`contract_deploy` payloads via `window.rougechain.signTransaction(payload)`. The
extension (v1.4.0+) shows the method, arguments, gas limit and maximum fee (or the
WASM size, predicted address and 10 XRGE fee) before signing.

## MCP Server (AI Agents)

The RougeChain MCP server exposes smart contract operations as tools for AI agents:

| Tool | Description |
|------|-------------|
| `list_contracts` | List all deployed contracts |
| `get_contract` | Get contract metadata |
| `get_contract_state` | Read state (single key or full dump) |
| `get_contract_events` | Get contract event log |
| `deploy_contract` | Deploy WASM bytecode (legacy node-signed endpoint — returns 410 on networks with player-signed contracts) |
| `call_contract` | Dry-run a contract method (legacy endpoint — preview only; it no longer submits) |

## Security

WASM smart contracts maintain RougeChain's post-quantum security guarantees:
- All contract transactions are ML-DSA-65 signed by the player: the signer is the caller and pays the fee
- WASM execution is pure computation — no classical crypto involved
- Contract addresses are derived from the signed deployment via SHA-256, so they cannot be front-run
- Execution is sandboxed with no host OS access

## Cross-Contract Calls

Contracts can call other contracts using host functions. Calls are queued during execution and processed recursively by the runtime after the primary call completes.

### Host Functions

| Function | Returns | Description |
|----------|---------|-------------|
| `host_call_contract(addr, alen, method, mlen, args, argslen, gas)` | `call_id (i32)` | Queue a call to another contract |
| `host_get_call_result(call_id, buf, len)` | `bytes written` | Read the result of a sub-call |

### Behavior

- **Max depth**: 8 nested calls (prevents infinite recursion)
- **State merging**: storage writes and events from sub-calls are merged atomically
- **XRGE moves are single-hop (v2)**: a contract moves only *its own* balance — `host_transfer` calls made by a *sub*-contract are **not** applied on-chain. See [Contract XRGE Custody](contract-xrge-custody.md)
- **Gas**: sub-calls consume gas from the parent's remaining budget
- **Failure**: if a sub-call fails, it returns `-2` from `host_get_call_result`; the parent can handle it gracefully

### Example (Rust)

```rust
extern "C" {
    fn host_call_contract(
        addr: *const u8, alen: u32,
        method: *const u8, mlen: u32,
        args: *const u8, argslen: u32,
        gas: u64,
    ) -> i32;
    fn host_get_call_result(call_id: i32, buf: *mut u8, len: u32) -> i32;
}

#[no_mangle]
pub extern "C" fn call_other() {
    let addr = b"contract_abc123...";
    let method = b"get_value";
    let args = b"{}";
    let call_id = unsafe {
        host_call_contract(
            addr.as_ptr(), addr.len() as u32,
            method.as_ptr(), method.len() as u32,
            args.as_ptr(), args.len() as u32,
            1_000_000,
        )
    };
    // Result is available after host processes the call queue
    let mut buf = [0u8; 1024];
    let n = unsafe { host_get_call_result(call_id, buf.as_mut_ptr(), buf.len() as u32) };
    // n > 0: success, n bytes of return data
    // n == -2: sub-call failed
}
```

## PQC Precompiles

Native post-quantum cryptographic operations available as host functions — no need to implement ML-DSA in WASM.

| Function | Returns | Description |
|----------|---------|-------------|
| `host_pqc_verify(pk, pklen, msg, msglen, sig, siglen)` | `1` valid, `0` invalid, `-1` error | ML-DSA-65 signature verification |
| `host_pqc_pubkey_to_address(pk, pklen, out, outlen)` | bytes written | Derive `rouge1...` bech32m address from raw pubkey |
| `host_pqc_hash_pubkey(pk, pklen, out)` | `32` on success | SHA-256 hash of public key |

### Key Sizes

- **Public Key**: 1,952 bytes (ML-DSA-65)
- **Signature**: 3,309 bytes (ML-DSA-65)
- **Address**: ~63 bytes (`rouge1...` bech32m string)
- **Pubkey Hash**: 32 bytes (SHA-256)

### Use Cases

- **On-chain auth**: Verify a user's PQC signature inside a contract
- **Address derivation**: Convert a pubkey to a `rouge1...` address for permission checks
- **Identity checks**: Compare pubkey hashes for compact storage

## EIP-1559 Dynamic Fees

RougeChain uses an EIP-1559-like fee model with base fee adjustment and fee burning:

### How It Works

1. **Base fee** adjusts ±12.5% per block based on block fullness (target: 10 txs/block)
2. **Floor**: minimum base fee of 0.001 XRGE
3. **Fee burning**: base fee portion is burned (deflationary)
4. **Priority fee (tip)**: 20% to block proposer, 70% to validators (stake-weighted), 10% to treasury

### API

```bash
GET /api/fee-info
```

```json
{
  "baseFee": 0.0377,
  "suggestedPriorityFee": 0.0038,
  "suggestedTotalFee": 0.0415,
  "totalBurned": 68.16,
  "targetTxsPerBlock": 10,
  "maxChangePercent": 12.5,
  "blockHeight": 618
}
```
