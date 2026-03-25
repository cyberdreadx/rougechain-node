# WASM Smart Contracts

RougeChain includes a built-in WASM smart contract engine powered by `wasmi` — the same pure-Rust WASM interpreter used by Parity/Substrate.

## Overview

Contracts are written in Rust (or any language that compiles to WASM), compiled to `.wasm`, and deployed on-chain. Execution is fuel-metered in a sandbox with host functions for chain interaction.

### Architecture

```
Your Contract (Rust) → cargo build --target wasm32
  → .wasm bytecode
    → Deploy via API
      → Execute in wasmi sandbox
        → Host functions bridge to chain state
```

## Host Functions

Contracts can call these host functions to interact with the chain:

| Function | Description |
|----------|-------------|
| `host_log(ptr, len)` | Debug logging |
| `host_get_caller(buf, len)` | Get caller's public key |
| `host_get_self_addr(buf, len)` | Get contract's own address |
| `host_get_block_height()` | Current block height |
| `host_get_block_time()` | Current block timestamp |
| `host_get_balance(addr, len)` | Check XRGE balance |
| `host_transfer(to, len, amount)` | Transfer XRGE from contract |
| `host_storage_read(key, klen, val, vlen)` | Read persistent storage |
| `host_storage_write(key, klen, val, vlen)` | Write persistent storage |
| `host_storage_delete(key, klen)` | Delete from storage |
| `host_emit_event(topic, tlen, data, dlen)` | Emit indexed event |
| `host_sha256(data, dlen, out)` | Compute SHA-256 hash |
| `host_set_return(data, dlen)` | Set return value |

## Gas Metering & Fees

Every WASM instruction costs 1 fuel unit. The default limit is **10,000,000 fuel per call** (≈10M instructions). If a contract runs out of fuel, execution halts and all state changes are reverted.

### Fee Schedule

| Operation | Fee Formula |
|-----------|-------------|
| Contract Deploy | `wasm_size_bytes × 0.000001` XRGE |
| Contract Call | `gas_used × 0.000001` XRGE |

Fees are automatically calculated and included in the on-chain transaction. They appear in the transaction detail view on the explorer.

## API

### Deploy a Contract

```bash
POST /api/v2/contract/deploy
{
  "wasm": "<base64-encoded WASM bytecode>",
  "deployer": "<public key hex>",
  "nonce": 0
}
```

### Call a Contract Method

```bash
POST /api/v2/contract/call
{
  "contractAddr": "<contract address>",
  "method": "my_method",
  "caller": "<public key>",
  "args": { "key": "value" },
  "gasLimit": 10000000
}
```

### Query Contract State

```bash
GET /api/contract/{addr}                # metadata
GET /api/contract/{addr}/state          # full state dump (all keys)
GET /api/contract/{addr}/state?key=x    # single key lookup
GET /api/contract/{addr}/events         # event log
GET /api/contracts                      # list all contracts
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
# Deploy the .wasm from target/wasm32-unknown-unknown/release/
```

## Explorer Integration

Deployed contracts are visible in the RougeChain explorer:

- **Contracts Explorer** (`/contracts`) — List all deployed contracts with search/sort
- **Contract Detail** (`/contract/{addr}`) — Contract info, live state viewer, interactive call UI
- **Transaction Detail** — Contract txs show: contract address, method, gas used, WASM size

## SDK

```typescript
import { RougeChain } from '@rougechain/sdk';

const rc = new RougeChain({ baseUrl: 'https://rougechain.io' });

// Deploy
const deploy = await rc.deployContract({
  wasm: base64WasmBytes,
  deployer: wallet.publicKey,
});

// Call
const result = await rc.callContract({
  contractAddr: deploy.address,
  method: 'increment',
  caller: wallet.publicKey,
});

// Query
const meta = await rc.getContract(deploy.address);
const events = await rc.getContractEvents(deploy.address);
const allState = await rc.getContractState(deploy.address);         // full dump
const single = await rc.getContractState(deploy.address, '636f756e74'); // single key
```

## MCP Server (AI Agents)

The RougeChain MCP server exposes smart contract operations as tools for AI agents:

| Tool | Description |
|------|-------------|
| `list_contracts` | List all deployed contracts |
| `get_contract` | Get contract metadata |
| `get_contract_state` | Read state (single key or full dump) |
| `get_contract_events` | Get contract event log |
| `deploy_contract` | Deploy WASM bytecode |
| `call_contract` | Execute a contract method |

## Security

WASM smart contracts maintain RougeChain's post-quantum security guarantees:
- All contract interactions are ML-DSA-65 signed transactions
- WASM execution is pure computation — no classical crypto involved
- Contract addresses are derived deterministically via SHA-256
- Execution is sandboxed with no host OS access
