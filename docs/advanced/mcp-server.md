# MCP Server (AI Agent Integration)

RougeChain is the **first blockchain with native MCP (Model Context Protocol) integration**. AI agents like Claude, ChatGPT, and custom agents can interact with the blockchain using standardized MCP tools.

## What is MCP?

The [Model Context Protocol](https://modelcontextprotocol.io/) is an open standard for AI agents to interact with external services. RougeChain's MCP server exposes **61 blockchain tools** — read the chain **and**, with a wallet configured, sign and submit real transactions. Every write is signed locally with ML-DSA-65 via [`@rougechain/sdk`](sdk.md); private keys never leave the server process.

## Two modes

| Mode | How | What the agent can do |
|------|-----|-----------------------|
| **Read-only** (default) | no wallet env | All query tools. Safe to expose anywhere. |
| **Read + write** | set a wallet env (below) | Everything above **plus** signed transactions from that wallet. |

Write tools are **only registered when a wallet is configured** — with no wallet, the transaction tools don't even appear.

## Setup

No install needed — the server is published on npm as [`@rougechain/mcp-server`](https://www.npmjs.com/package/@rougechain/mcp-server) and runs via `npx`.

### Claude Desktop — read-only

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

### Claude Desktop — read + write

Add a wallet to unlock the signing tools:

```json
{
  "mcpServers": {
    "rougechain": {
      "command": "npx",
      "args": ["-y", "@rougechain/mcp-server"],
      "env": {
        "ROUGECHAIN_URL": "https://api.rougechain.io",
        "ROUGECHAIN_MNEMONIC": "your twenty four word seed phrase here ..."
      }
    }
  }
}
```

> ⚠️ The mnemonic controls real funds. Use a dedicated low-balance **agent wallet**
> — generate one with the `generate_wallet` tool — and keep it out of shared configs.
> Alternatively supply raw hex keys via `ROUGECHAIN_PRIVATE_KEY` + `ROUGECHAIN_PUBLIC_KEY`.

> **Host note:** `ROUGECHAIN_URL` must be the API host (`api.rougechain.io`), **not**
> `rougechain.io`, which serves the web app for every `/api/*` path.

## Available Tools (61)

### Wallet (always available)

| Tool | Description |
|------|-------------|
| `generate_wallet` | Create a fresh ML-DSA-65 wallet (mnemonic + address); not persisted |
| `wallet_info` | Show the configured signer, address, live balance, and whether writes are enabled |

### Read tools (always available)

| Category | Tools |
|----------|-------|
| **Chain** | `get_chain_stats`, `get_block`, `get_latest_blocks` |
| **Wallet** | `get_balance`, `get_transaction` |
| **Tokens** | `list_tokens`, `get_token`, `get_token_holders` |
| **DeFi** | `list_pools`, `get_swap_quote` |
| **NFTs** | `list_nft_collections`, `get_nft_collection` |
| **Validators** | `list_validators` |
| **Contracts** | `list_contracts`, `get_contract`, `get_contract_state`, `get_contract_events`, `deploy_contract`, `call_contract` |
| **Social** | `get_global_timeline`, `get_post`, `get_user_posts`, `get_post_replies`, `get_track_stats`, `get_artist_stats` |
| **Mail & Messaging** | `resolve_name`, `reverse_lookup_name`, `list_messenger_wallets` |
| **Governance & Fees** | `list_proposals`, `get_fee_info` |

### ✍️ Write tools (write mode only — signed with ML-DSA-65)

| Category | Tools |
|----------|-------|
| **Value** | `send_transaction`, `burn_tokens`, `stake`, `unstake`, `request_faucet` (testnet) |
| **Tokens** | `create_token`, `mint_tokens`, `update_token_metadata`, `claim_token_metadata` |
| **DeFi** | `swap`, `create_pool`, `add_liquidity`, `remove_liquidity` |
| **NFTs** | `nft_create_collection`, `nft_mint`, `nft_batch_mint`, `nft_transfer`, `nft_burn`, `nft_lock`, `nft_freeze_collection` |
| **Names** | `register_name`, `release_name` |
| **Social** | `create_post`, `delete_post`, `repost`, `follow`, `like_track`, `comment_on_track` |
| **Bridge** | `bridge_withdraw` |

## Architecture

```
AI Agent (Claude / GPT / Custom)
    ↕ stdio (MCP protocol)
RougeChain MCP Server
    ↕ HTTPS
RougeChain Node API
    ↕ PQC-signed transactions
RougeChain L1 (ML-DSA + ML-KEM)
```

All operations maintain post-quantum security guarantees.

## Resources

The MCP server also exposes a `rougechain://info` resource with static context about RougeChain's technology stack, features, and API endpoints.
