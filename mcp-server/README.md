# RougeChain MCP Server

> AI agents can now **read and transact on** a post-quantum blockchain.

The **first MCP-native blockchain integration** — lets AI agents (Claude, ChatGPT, custom agents) read chain state, query tokens, check balances, query WASM smart contracts, **and — with a wallet configured — sign and submit real transactions** (transfers, swaps, token/NFT minting, staking, social posts, and more) using the [Model Context Protocol](https://modelcontextprotocol.io/).

Every write is signed locally with **ML-DSA-65 (FIPS 204)** via [`@rougechain/sdk`](https://www.npmjs.com/package/@rougechain/sdk) — private keys never leave the server process.

## Two modes

| Mode | How | What the agent can do |
|------|-----|-----------------------|
| **Read-only** (default) | no wallet env | All query tools. Safe to expose anywhere. |
| **Read + write** | set a wallet env (below) | Everything above **plus** signed transactions from that wallet. |

Write tools are **only registered when a wallet is configured** — with no wallet, the server is strictly read-only and the transaction tools don't even appear.

## Quick Start

No install needed — the server is published on npm as [`@rougechain/mcp-server`](https://www.npmjs.com/package/@rougechain/mcp-server) and runs via `npx`.

### Claude Desktop Config

Add to `~/.config/claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "rougechain": {
      "command": "npx",
      "args": ["-y", "@rougechain/mcp-server"],
      "env": {
        "ROUGECHAIN_URL": "https://api.rougechain.io"
      }
    }
  }
}
```

<details>
<summary>Run from source instead</summary>

```bash
cd mcp-server
npm install
npm run build
```

Then point the config at the built file:

```json
{
  "mcpServers": {
    "rougechain": {
      "command": "node",
      "args": ["/path/to/quantum-vault/mcp-server/dist/index.js"],
      "env": { "ROUGECHAIN_URL": "https://api.rougechain.io" }
    }
  }
}
```
</details>

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ROUGECHAIN_URL` | `https://api.rougechain.io` | RougeChain API host (the `api.` subdomain — **not** the `rougechain.io` frontend, which serves the web app) |
| `ROUGECHAIN_API_KEY` | (none) | Optional API key |
| `ROUGECHAIN_MNEMONIC` | (none) | **Enables write mode.** 12/24-word BIP-39 seed of the signing wallet |
| `ROUGECHAIN_PRIVATE_KEY` + `ROUGECHAIN_PUBLIC_KEY` | (none) | Alternative to the mnemonic — raw hex keys |

> ⚠️ **The mnemonic/private key controls real funds.** Only set it for a wallet you
> intend the agent to spend from, keep it out of shared configs, and prefer a
> low-balance "agent wallet". Need a fresh one? Call the `generate_wallet` tool.

### Enabling write mode (Claude Desktop)

```json
{
  "mcpServers": {
    "rougechain": {
      "command": "npx",
      "args": ["-y", "@rougechain/mcp-server"],
      "env": {
        "ROUGECHAIN_URL": "https://api.rougechain.io",
        "ROUGECHAIN_MNEMONIC": "word1 word2 … word24"
      }
    }
  }
}
```

## Available Tools

### Wallet (always available)
- `generate_wallet` — Create a fresh ML-DSA-65 wallet (mnemonic + address); not persisted
- `wallet_info` — Show the configured signer, its address, live balance, and whether writes are enabled

### ✍️ Write / transaction tools (write mode only — signed with ML-DSA-65)
- **Value:** `send_transaction`, `burn_tokens`, `stake`, `unstake`, `request_faucet` (testnet)
- **Tokens:** `create_token`, `mint_tokens`, `update_token_metadata`, `claim_token_metadata`
- **DEX:** `swap`, `create_pool`, `add_liquidity`, `remove_liquidity`
- **NFTs:** `nft_create_collection`, `nft_mint`, `nft_batch_mint`, `nft_transfer`, `nft_burn`, `nft_lock`, `nft_freeze_collection`
- **Name service:** `register_name`, `release_name`
- **Social:** `create_post`, `delete_post`, `repost`, `follow`, `like_track`, `comment_on_track`
- **Bridge:** `bridge_withdraw`
- **Smart contracts:** `publish_contract` (10 XRGE), `execute_contract` (fee = gasLimit × 0.000001 XRGE; optional `attach` payment) — see below

---

### Read tools (always available)

### Chain Info
- `get_chain_stats` — Network stats (height, peers, validators, supply)
- `get_block` — Get block by height
- `get_latest_blocks` — Recent blocks

### Wallet & Balance
- `get_balance` — Check XRGE or token balance
- `get_transaction` — Look up a transaction

### Tokens
- `list_tokens` — All custom tokens
- `get_token` — Token metadata
- `get_token_holders` — Top holders

### DeFi / AMM
- `list_pools` — Liquidity pools
- `get_swap_quote` — AMM swap quote

### NFTs
- `list_nft_collections` — All NFT collections
- `get_nft_collection` — Collection details + tokens

### Validators
- `list_validators` — Network validators

### WASM Smart Contracts
- `list_contracts` — All deployed contracts
- `get_contract` — Contract metadata
- `get_contract_state` — Read contract storage (one key or all)
- `get_contract_events` — Stored events, newest first (`limit`, `before` block height, `tx` hash)
- `query_contract` — Free read-only call (`POST /api/contract/:addr/query`); `caller` defaults to the configured wallet.
  Optional `attach` previews a paid call (see *Payable calls* below; needs a caller)
- `get_tx_receipt` — Receipt of an included tx: `status` is `"Success"` or `{"Failed": "<error>"}`

Write mode adds two player-signed tools. The configured wallet is the deployer / the caller the
contract sees (`host_get_caller`) and pays the fee:

- `publish_contract` — `{ wasm (base64), nonce?, wait? }` → `POST /api/v2/contract/publish`.
  Costs **10 XRGE**. Returns `txId`, `address` and a locally computed `predictedAddress`
  (`sha256("rougechain/contract/v2" ‖ from ‖ 0 ‖ nonce ‖ 0 ‖ sha256(wasm))[..20]`).
- `execute_contract` — `{ address, method, args?, gasLimit?, accountNonce?, wait? }` →
  `POST /api/v2/contract/execute`. Without `gasLimit` the server queries first and signs
  `ceil(gasUsed × 1.5) + 1000` (max 10,000,000); the fee is `gasLimit × 0.000001` XRGE. The node
  dry-runs the call and refuses it if it would fail (nothing charged). With `wait: true` the
  result includes the receipt; a call that reverted in its block is still charged and reports
  `status: {"Failed": …}`. Optional `attach` pays the contract (see below).

**Payable calls (1.3.0; the node accepts them from block 190).** `execute_contract` and
`query_contract` take an optional `attach`:

| Payment | `attach` | Signed as |
|---------|----------|-----------|
| XRGE | `{ "symbol": "XRGE", "amount_xrge": "0.5" }`: a **decimal XRGE string**, at most 9 decimals | `{"symbol":"XRGE","amount":500000000}` (integer quanta, 1 XRGE = 1,000,000,000) |
| Token | `{ "symbol": "GOLD", "amount": 25 }`: an **integer in raw token units** (number or digit string) | `{"symbol":"GOLD","amount":25}` |

The conversion is exact, with no floating point. XRGE must use `amount_xrge`, and a token must use
`amount`. The tool rejects any other combination, a zero amount, or an amount above
2^53 − 1. The payment moves to the contract **only if the call succeeds**. If the call fails or
traps, the payment stays with the wallet, but the gas fee is still charged. The node refuses the
call up front if the wallet can't cover the gas fee plus an XRGE payment, or the token amount.
Gas auto-sizing previews the call with the payment. The result adds `attach`, `payment` and
`maxTotalXrge` (gas fee + XRGE payment).

The node-signed `/api/v2/contract/deploy` (410 Gone) and `/api/v2/contract/call` (preview only)
endpoints are retired, so the old `deploy_contract` / `call_contract` tools were removed.

### Social
- `get_global_timeline` — Global post timeline (newest first)
- `get_post` — Get a single post with engagement stats
- `get_user_posts` — Get posts by a specific user
- `get_post_replies` — Get threaded replies to a post
- `get_track_stats` — Get play/like/comment stats for a track
- `get_artist_stats` — Get follower/following counts for an artist

### Mail & Messaging
- `resolve_name` — Resolve a mail name to wallet info and encryption keys
- `reverse_lookup_name` — Look up the registered mail name for a wallet ID
- `list_messenger_wallets` — List registered messenger wallets with display names

### Other
- `list_proposals` — Governance proposals
- `get_fee_info` — Dynamic fee info (EIP-1559)

## Resources

- `rougechain://info` — Static context about RougeChain's tech stack, features, and API

## Architecture

```
AI Agent (Claude/GPT/GLTCH)
    ↕ stdio (MCP protocol)
RougeChain MCP Server
    ↕ HTTPS
RougeChain Node API
    ↕ PQC-signed transactions
RougeChain L1 (ML-DSA + ML-KEM)
```

All operations maintain post-quantum security. WASM contract execution runs in a fuel-metered sandbox. Transactions are ML-DSA-65 signed.
