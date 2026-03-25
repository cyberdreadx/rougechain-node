# RougeChain ERC-20 Token Contract

Standard fungible token implementation for RougeChain's WASM VM.

## Methods

| Method | Args | Description |
|--------|------|-------------|
| `init` | `{name, symbol, decimals, total_supply, owner}` | Initialize token, mint supply to owner |
| `name` | `{}` | Get token name |
| `symbol` | `{}` | Get token symbol |
| `decimals` | `{}` | Get decimals |
| `total_supply` | `{}` | Get total supply |
| `balance_of` | `{account}` | Get account balance |
| `transfer` | `{to, amount}` | Transfer tokens (caller → to) |
| `approve` | `{spender, amount}` | Set allowance |
| `allowance` | `{owner, spender}` | Get allowance |
| `transfer_from` | `{from, to, amount}` | Transfer using allowance |

## Build

```bash
cargo build --release --target wasm32-unknown-unknown
```

Output: `target/wasm32-unknown-unknown/release/rougechain_erc20.wasm`

## Deploy

```bash
curl -X POST https://testnet.rougechain.io/api/v2/contract/deploy \
  -F "wasm=@target/wasm32-unknown-unknown/release/rougechain_erc20.wasm" \
  -F "deployer=your-pubkey"
```

## Initialize

```bash
curl -X POST https://testnet.rougechain.io/api/v2/contract/call \
  -H "Content-Type: application/json" \
  -d '{
    "contractAddr": "<addr>",
    "method": "init",
    "args": {"name": "MyToken", "symbol": "MTK", "decimals": 18, "total_supply": 1000000, "owner": "alice"},
    "caller": "alice"
  }'
```
