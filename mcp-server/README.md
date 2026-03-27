# RougeChain MCP Server

> AI agents can now interact with a post-quantum blockchain.

The **first MCP-native blockchain integration** — lets AI agents (Claude, ChatGPT, custom agents) read chain state, query tokens, check balances, deploy WASM smart contracts, and more using the [Model Context Protocol](https://modelcontextprotocol.io/).

## Quick Start

```bash
cd mcp-server
npm install
npm run build
```

### Claude Desktop Config

Add to `~/.config/claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "rougechain": {
      "command": "node",
      "args": ["/path/to/quantum-vault/mcp-server/dist/index.js"],
      "env": {
        "ROUGECHAIN_URL": "https://rougechain.io"
      }
    }
  }
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ROUGECHAIN_URL` | `https://rougechain.io` | RougeChain node URL |
| `ROUGECHAIN_API_KEY` | (none) | Optional API key |

## Available Tools (29)

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
