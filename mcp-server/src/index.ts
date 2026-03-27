#!/usr/bin/env node
/**
 * RougeChain MCP Server
 *
 * Exposes RougeChain blockchain operations as MCP tools for AI agents.
 * The first post-quantum, AI-agent-native programmable blockchain.
 *
 * Usage:
 *   ROUGECHAIN_URL=https://rougechain.io npx rougechain-mcp
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ─── Configuration ────────────────────────────────────────────────────────────

const BASE_URL = process.env.ROUGECHAIN_URL || "https://rougechain.io";
const API = `${BASE_URL}/api`;
const API_KEY = process.env.ROUGECHAIN_API_KEY || "";

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

const headers: Record<string, string> = {
  "Content-Type": "application/json",
  ...(API_KEY ? { "X-API-Key": API_KEY } : {}),
};

async function apiGet(path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, { headers });
  return res.json();
}

async function apiPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return res.json();
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "rougechain",
  version: "1.0.0",
});

// ══════════════════════════════════════════════════════════════════════════════
// TOOLS — actions that AI agents can perform on RougeChain
// ══════════════════════════════════════════════════════════════════════════════

// ── Chain Info ────────────────────────────────────────────────────────────────

server.tool(
  "get_chain_stats",
  "Get RougeChain network statistics: block height, peer count, validator count, total supply",
  {},
  async () => {
    const data = await apiGet("/stats");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_block",
  "Get a block by height from the RougeChain blockchain",
  { height: z.number().describe("Block height to retrieve") },
  async ({ height }) => {
    const data = await apiGet(`/blocks/${height}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_latest_blocks",
  "Get the most recent blocks from the chain",
  { limit: z.number().optional().default(10).describe("Number of blocks to return (max 100)") },
  async ({ limit }) => {
    const data = await apiGet(`/blocks?limit=${limit}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Wallet & Balance ─────────────────────────────────────────────────────────

server.tool(
  "get_balance",
  "Check XRGE or token balance for a wallet address or public key",
  {
    address: z.string().describe("Wallet address (rouge1...) or public key hex"),
    token: z.string().optional().describe("Token symbol (omit for XRGE native balance)"),
  },
  async ({ address, token }) => {
    const path = token
      ? `/balance/${address}?token=${token}`
      : `/balance/${address}`;
    const data = await apiGet(path);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_transaction",
  "Look up a specific transaction by hash",
  { hash: z.string().describe("Transaction hash") },
  async ({ hash }) => {
    const data = await apiGet(`/tx/${hash}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Token Operations ─────────────────────────────────────────────────────────

server.tool(
  "list_tokens",
  "List all custom tokens on RougeChain with their metadata",
  {},
  async () => {
    const data = await apiGet("/tokens");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_token",
  "Get detailed metadata for a specific token by symbol",
  { symbol: z.string().describe("Token symbol (e.g. ROUGE)") },
  async ({ symbol }) => {
    const data = await apiGet(`/tokens/${symbol}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_token_holders",
  "Get the top holders of a specific token",
  { symbol: z.string().describe("Token symbol") },
  async ({ symbol }) => {
    const data = await apiGet(`/tokens/${symbol}/holders`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── DeFi / AMM ───────────────────────────────────────────────────────────────

server.tool(
  "list_pools",
  "List all liquidity pools on RougeChain DEX",
  {},
  async () => {
    const data = await apiGet("/pools");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_swap_quote",
  "Get a swap quote from the AMM (price, slippage, route)",
  {
    from: z.string().describe("Source token symbol"),
    to: z.string().describe("Destination token symbol"),
    amount: z.number().describe("Amount of source token to swap"),
  },
  async ({ from, to, amount }) => {
    const data = await apiGet(`/swap/quote?from=${from}&to=${to}&amount=${amount}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── NFTs ──────────────────────────────────────────────────────────────────────

server.tool(
  "list_nft_collections",
  "List all NFT collections on RougeChain",
  {},
  async () => {
    const data = await apiGet("/nft/collections");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_nft_collection",
  "Get details and tokens for an NFT collection",
  { symbol: z.string().describe("Collection symbol") },
  async ({ symbol }) => {
    const data = await apiGet(`/nft/collection/${symbol}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Validators & Staking ─────────────────────────────────────────────────────

server.tool(
  "list_validators",
  "List all validators on the RougeChain network with their stake and status",
  {},
  async () => {
    const data = await apiGet("/validators");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── WASM Smart Contracts ─────────────────────────────────────────────────────

server.tool(
  "list_contracts",
  "List all deployed WASM smart contracts on RougeChain",
  {},
  async () => {
    const data = await apiGet("/contracts");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_contract",
  "Get metadata for a deployed smart contract",
  { address: z.string().describe("Contract address (hex)") },
  async ({ address }) => {
    const data = await apiGet(`/contract/${address}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_contract_state",
  "Read contract storage. Omit key to dump all state; provide key for single-value lookup.",
  {
    address: z.string().describe("Contract address"),
    key: z.string().optional().describe("Storage key (hex or string). Omit to dump all state."),
  },
  async ({ address, key }) => {
    const path = key
      ? `/contract/${address}/state?key=${encodeURIComponent(key)}`
      : `/contract/${address}/state`;
    const data = await apiGet(path);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_contract_events",
  "Get the event log for a smart contract",
  {
    address: z.string().describe("Contract address"),
    limit: z.number().optional().default(50).describe("Max events to return"),
  },
  async ({ address, limit }) => {
    const data = await apiGet(`/contract/${address}/events?limit=${limit}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "deploy_contract",
  "Deploy a WASM smart contract to RougeChain. Requires base64-encoded WASM bytecode.",
  {
    wasm: z.string().describe("Base64-encoded WASM bytecode"),
    deployer: z.string().describe("Deployer's public key hex"),
    nonce: z.number().optional().default(0).describe("Nonce for deterministic address"),
  },
  async ({ wasm, deployer, nonce }) => {
    const data = await apiPost("/v2/contract/deploy", { wasm, deployer, nonce });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "call_contract",
  "Call a method on a deployed WASM smart contract",
  {
    contractAddr: z.string().describe("Contract address (hex)"),
    method: z.string().describe("Method name to call"),
    caller: z.string().optional().describe("Caller's public key"),
    args: z.record(z.unknown()).optional().describe("JSON arguments for the method"),
    gasLimit: z.number().optional().describe("Gas limit (default 10M)"),
  },
  async ({ contractAddr, method, caller, args, gasLimit }) => {
    const data = await apiPost("/v2/contract/call", {
      contractAddr,
      method,
      caller,
      args: args || {},
      gasLimit,
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Governance ───────────────────────────────────────────────────────────────

server.tool(
  "list_proposals",
  "List governance proposals on RougeChain",
  {},
  async () => {
    const data = await apiGet("/governance/proposals");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Fee Info ──────────────────────────────────────────────────────────────────

server.tool(
  "get_fee_info",
  "Get current EIP-1559 dynamic fee information (base fee, priority fee, burned fees)",
  {},
  async () => {
    const data = await apiGet("/fee-info");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Name Service ─────────────────────────────────────────────────────────────

server.tool(
  "resolve_name",
  "Resolve a mail name (e.g. 'alice') to the wallet's public keys and encryption key. Names are registered as alice@rouge.quant or alice@qwalla.mail",
  { name: z.string().describe("Name to resolve (e.g. 'alice', without the @domain)") },
  async ({ name }) => {
    const data = await apiGet(`/names/resolve/${encodeURIComponent(name.toLowerCase())}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "reverse_lookup_name",
  "Look up the registered mail name for a wallet ID or public key",
  { walletId: z.string().describe("Wallet ID or public key hex") },
  async ({ walletId }) => {
    const data = await apiGet(`/names/reverse/${encodeURIComponent(walletId)}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "list_messenger_wallets",
  "List all registered messenger wallets with their display names and encryption keys",
  {},
  async () => {
    const data = await apiGet("/messenger/wallets");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Social ───────────────────────────────────────────────────────────────────

server.tool(
  "get_global_timeline",
  "Get the global social timeline — all posts, newest first",
  {
    limit: z.number().optional().default(50).describe("Max posts to return"),
    offset: z.number().optional().default(0).describe("Offset for pagination"),
  },
  async ({ limit, offset }) => {
    const data = await apiGet(`/social/timeline?limit=${limit}&offset=${offset}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_post",
  "Get a single social post by ID with engagement stats",
  {
    postId: z.string().describe("Post ID (UUID)"),
    viewer: z.string().optional().describe("Viewer public key to check liked/reposted state"),
  },
  async ({ postId, viewer }) => {
    const q = viewer ? `?viewer=${encodeURIComponent(viewer)}` : "";
    const data = await apiGet(`/social/post/${encodeURIComponent(postId)}${q}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_user_posts",
  "Get posts by a specific user",
  {
    pubkey: z.string().describe("User's public key"),
    limit: z.number().optional().default(50).describe("Max posts to return"),
  },
  async ({ pubkey, limit }) => {
    const data = await apiGet(`/social/user/${encodeURIComponent(pubkey)}/posts?limit=${limit}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_post_replies",
  "Get threaded replies to a post",
  {
    postId: z.string().describe("Parent post ID"),
    limit: z.number().optional().default(50).describe("Max replies to return"),
  },
  async ({ postId, limit }) => {
    const data = await apiGet(`/social/post/${encodeURIComponent(postId)}/replies?limit=${limit}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_track_stats",
  "Get social stats for a music track (plays, likes, comments)",
  {
    trackId: z.string().describe("Track/NFT token ID"),
    viewer: z.string().optional().describe("Viewer public key to check liked state"),
  },
  async ({ trackId, viewer }) => {
    const q = viewer ? `?viewer=${encodeURIComponent(viewer)}` : "";
    const data = await apiGet(`/social/track/${encodeURIComponent(trackId)}/stats${q}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_artist_stats",
  "Get social stats for an artist (followers, following count)",
  {
    pubkey: z.string().describe("Artist's public key"),
    viewer: z.string().optional().describe("Viewer public key to check follow state"),
  },
  async ({ pubkey, viewer }) => {
    const q = viewer ? `?viewer=${encodeURIComponent(viewer)}` : "";
    const data = await apiGet(`/social/artist/${encodeURIComponent(pubkey)}/stats${q}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// RESOURCES — static context about RougeChain for AI agents
// ══════════════════════════════════════════════════════════════════════════════

server.resource(
  "chain-info",
  "rougechain://info",
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "text/plain",
        text: `RougeChain — The First Post-Quantum Programmable Blockchain

Core Technology:
- ML-DSA-65 (FIPS 204) digital signatures
- ML-KEM-768 (FIPS 203) key encapsulation
- Bech32m addresses (rouge1...)
- ZK-STARK proofs (winterfell) for shielded transactions
- WASM smart contracts (wasmi runtime)
- EIP-1559 dynamic fees with fee burning

Native Token: XRGE
Address Format: rouge1... (Bech32m)
Consensus: Proof of Stake with BFT finality
API Base: ${API}

Features:
- Custom tokens with mint authority
- NFT collections with royalties
- AMM DEX with multi-hop routing
- End-to-end encrypted messaging (ML-KEM-768 + AES-GCM)
- Encrypted mail with @rouge.quant / @qwalla.mail addresses (CEK multi-recipient encryption)
- Social layer: posts, timeline, threaded replies, reposts, likes, follows, comments, tips
- Real-time notifications: unread badges, native browser notifications, push notifications
- EVM bridge (Base Sepolia)
- Name service (mail + wallet name registry)
- Governance proposals
- WASM smart contracts with fuel-metered execution
- WebSocket real-time event streaming

SDK: @rougechain/sdk (npm)
Docs: ${BASE_URL}/docs`,
      },
    ],
  })
);

// ══════════════════════════════════════════════════════════════════════════════
// Start the server
// ══════════════════════════════════════════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[rougechain-mcp] Server started — connected via stdio");
  console.error(`[rougechain-mcp] API endpoint: ${API}`);
}

main().catch((err) => {
  console.error("[rougechain-mcp] Fatal error:", err);
  process.exit(1);
});
