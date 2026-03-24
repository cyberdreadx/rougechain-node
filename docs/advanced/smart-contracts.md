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

## Gas Metering

Every WASM instruction costs 1 fuel unit. The default limit is **10,000,000 fuel per call** (≈10M instructions). If a contract runs out of fuel, execution halts and all state changes are reverted.

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
GET /api/contract/{addr}          # metadata
GET /api/contract/{addr}/state?key=x  # storage read
GET /api/contract/{addr}/events   # event log
GET /api/contracts                # list all
```

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
const state = await rc.getContractState(deploy.address, '636f756e74');
```

## Security

WASM smart contracts maintain RougeChain's post-quantum security guarantees:
- All contract interactions are ML-DSA-65 signed transactions
- WASM execution is pure computation — no classical crypto involved
- Contract addresses are derived deterministically via SHA-256
- Execution is sandboxed with no host OS access
