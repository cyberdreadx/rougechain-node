# RougeChain MCP Server

> AI agents can now **read and transact on** a post-quantum blockchain.

The **first MCP-native blockchain integration** — lets AI agents (Claude, ChatGPT, custom agents) read chain state, query tokens, check balances, deploy WASM smart contracts, **and — with a wallet configured — sign and submit real transactions** (transfers, swaps, token/NFT minting, staking, social posts, and more) using the [Model Context Protocol](https://modelcontextprotocol.io/).

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
- `get_contract_state` — Read contract storage
- `get_contract_events` — Contract event log
- `deploy_contract` — Deploy WASM bytecode
- `call_contract` — Execute contract method

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
