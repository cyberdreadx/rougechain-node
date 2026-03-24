# MCP Server (AI Agent Integration)

RougeChain is the **first blockchain with native MCP (Model Context Protocol) integration**. AI agents like Claude, ChatGPT, and custom agents can interact with the blockchain using standardized MCP tools.

## What is MCP?

The [Model Context Protocol](https://modelcontextprotocol.io/) is an open standard for AI agents to interact with external services. RougeChain's MCP server exposes 21 blockchain tools that any MCP-compatible agent can use.

## Setup

```bash
cd mcp-server
npm install
npm run build
```

### Claude Desktop

Add to `~/.config/claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "rougechain": {
      "command": "node",
      "args": ["/path/to/mcp-server/dist/index.js"],
      "env": {
        "ROUGECHAIN_URL": "https://rougechain.io"
      }
    }
  }
}
```

## Available Tools (21)

| Category | Tools |
|----------|-------|
| **Chain** | `get_chain_stats`, `get_block`, `get_latest_blocks` |
| **Wallet** | `get_balance`, `get_transaction` |
| **Tokens** | `list_tokens`, `get_token`, `get_token_holders` |
| **DeFi** | `list_pools`, `get_swap_quote` |
| **NFTs** | `list_nft_collections`, `get_nft_collection` |
| **Validators** | `list_validators` |
| **Contracts** | `list_contracts`, `get_contract`, `get_contract_state`, `get_contract_events`, `deploy_contract`, `call_contract` |
| **Other** | `list_proposals`, `get_fee_info`, `resolve_name` |

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
