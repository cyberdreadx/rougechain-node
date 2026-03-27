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
| `host_call_contract(addr, alen, method, mlen, args, argslen, gas)` | Cross-contract call (returns call_id) |
| `host_get_call_result(call_id, buf, len)` | Read sub-call result |
| `host_pqc_verify(pk, pklen, msg, msglen, sig, siglen)` | ML-DSA-65 signature verify |
| `host_pqc_pubkey_to_address(pk, pklen, out, outlen)` | Derive `rouge1...` address |
| `host_pqc_hash_pubkey(pk, pklen, out)` | SHA-256 of public key |

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

## Cross-Contract Calls

Contracts can call other contracts using host functions. Calls are queued during execution and processed recursively by the runtime after the primary call completes.

### Host Functions

| Function | Returns | Description |
|----------|---------|-------------|
| `host_call_contract(addr, alen, method, mlen, args, argslen, gas)` | `call_id (i32)` | Queue a call to another contract |
| `host_get_call_result(call_id, buf, len)` | `bytes written` | Read the result of a sub-call |

### Behavior

- **Max depth**: 8 nested calls (prevents infinite recursion)
- **State merging**: storage writes, events, and balance deltas from sub-calls are merged atomically
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
