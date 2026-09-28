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

## Deploy and initialize

Contract transactions are signed by your wallet (the old node-signed
`/api/v2/contract/deploy` and `/api/v2/contract/call` endpoints are retired). With
`@rougechain/sdk` 1.9.0+:

```typescript
import { readFileSync } from "node:fs";
import { RougeChain, Wallet } from "@rougechain/sdk";

const rc = new RougeChain("https://testnet.rougechain.io/api");
const wallet = Wallet.fromMnemonic(process.env.MNEMONIC!);

// Publish (10 XRGE). The address is known before the block.
const wasm = readFileSync("target/wasm32-unknown-unknown/release/rougechain_erc20.wasm");
const pub = await rc.contracts.publish(wallet, wasm);
await rc.contracts.waitForReceipt(pub.txId!);

// Initialize (a signed call; the signer is the caller the contract sees)
const r = await rc.contracts.execute(wallet, pub.predictedAddress, "init", {
  name: "MyToken", symbol: "MTK", decimals: 18, total_supply: 1000000, owner: wallet.publicKey,
});
const receipt = await rc.contracts.waitForReceipt(r.txId!);   // status "Success" or { Failed }

// Read-only (free)
const bal = await rc.contracts.query(pub.predictedAddress, "balance_of", { account: wallet.publicKey });
```

The raw endpoints (`POST /api/v2/contract/publish`, `POST /api/v2/contract/execute`,
`POST /api/contract/:addr/query`) are described in `docs/api-reference/smart-contracts.md`.
