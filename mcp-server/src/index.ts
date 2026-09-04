#!/usr/bin/env node
/**
 * RougeChain MCP Server
 *
 * Exposes RougeChain blockchain operations as MCP tools for AI agents.
 * The first post-quantum, AI-agent-native programmable blockchain.
 *
 * READ tools work with no configuration.
 * WRITE tools (transfer, swap, mint, post, …) sign transactions with ML-DSA-65
 * and are only registered when a wallet is provided via env:
 *
 *   ROUGECHAIN_MNEMONIC="word1 word2 … word24"      (preferred — BIP-39 seed)
 *     …or…
 *   ROUGECHAIN_PRIVATE_KEY=<hex>  ROUGECHAIN_PUBLIC_KEY=<hex>
 *
 * Usage:
 *   ROUGECHAIN_URL=https://api.rougechain.io npx @rougechain/mcp-server            # read-only
 *   ROUGECHAIN_MNEMONIC="…" npx @rougechain/mcp-server                              # read + write
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { RougeChain, Wallet } from "@rougechain/sdk";
import type { WalletKeys } from "@rougechain/sdk";

// ─── Configuration ────────────────────────────────────────────────────────────

// NOTE: this must be the API host (api.rougechain.io), NOT the frontend host
// (rougechain.io), which serves the SPA index.html for every /api/* path.
const BASE_URL = process.env.ROUGECHAIN_URL || "https://api.rougechain.io";
const API = `${BASE_URL}/api`;
const API_KEY = process.env.ROUGECHAIN_API_KEY || "";

// ─── HTTP helpers (read side) ──────────────────────────────────────────────────

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

// ─── SDK client (write side) ────────────────────────────────────────────────────
// The SDK owns all ML-DSA-65 signing + transaction serialization; the MCP server
// never re-implements crypto. `rc` points at the same API base as the read helpers.

const rc = new RougeChain(API, API_KEY ? { apiKey: API_KEY } : {});

/**
 * Load a signing wallet from the environment, if one was provided.
 * Returns null when the server should run read-only.
 */
function loadWallet(): Wallet | null {
  const mnemonic = process.env.ROUGECHAIN_MNEMONIC?.trim();
  const priv = process.env.ROUGECHAIN_PRIVATE_KEY?.trim();
  const pub = process.env.ROUGECHAIN_PUBLIC_KEY?.trim();
  try {
    if (mnemonic) return Wallet.fromMnemonic(mnemonic);
    if (priv && pub) return Wallet.fromKeys(pub, priv);
  } catch (e) {
    console.error(
      "[rougechain-mcp] Failed to load wallet from env — write tools disabled:",
      e instanceof Error ? e.message : e
    );
    return null;
  }
  return null;
}

const wallet = loadWallet();
const signer: WalletKeys | null = wallet;

// Uniform JSON text result + error envelope so a failed tx never crashes the tool.
function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: message }, null, 2) }],
  };
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "rougechain",
  version: "1.1.0",
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
    const data = await apiGet(`/block/${height}`);
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
      ? `/balance/${address}/${token}`
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
    const data = await apiGet(`/token/${symbol}/metadata`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "get_token_holders",
  "Get the top holders of a specific token",
  { symbol: z.string().describe("Token symbol") },
  async ({ symbol }) => {
    const data = await apiGet(`/token/${symbol}/holders`);
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
    const data = await apiPost("/swap/quote", {
      token_in: from,
      token_out: to,
      amount_in: amount,
    });
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
// WALLET TOOLS — always available (no signer required)
// ══════════════════════════════════════════════════════════════════════════════

server.tool(
  "generate_wallet",
  "Generate a brand-new post-quantum (ML-DSA-65) wallet: 24-word BIP-39 mnemonic, " +
    "public key, and rouge1… address. The keys are NOT saved anywhere — copy the " +
    "mnemonic somewhere safe, then set ROUGECHAIN_MNEMONIC to enable transacting.",
  {},
  async () => {
    const w = Wallet.generate();
    return ok({
      mnemonic: w.mnemonic,
      publicKey: w.publicKey,
      address: await w.address(),
      warning:
        "Store the mnemonic securely and never share it. Anyone with it controls this wallet. " +
        "This server did not persist it.",
    });
  }
);

server.tool(
  "wallet_info",
  "Report the signing wallet this server is configured with (public key, address, " +
    "live balance) and whether write/transaction tools are enabled.",
  {},
  async () => {
    if (!signer) {
      return ok({
        signer_configured: false,
        write_tools_enabled: false,
        hint:
          "Set ROUGECHAIN_MNEMONIC (or ROUGECHAIN_PRIVATE_KEY + ROUGECHAIN_PUBLIC_KEY) " +
          "in the server env to enable transacting.",
      });
    }
    const address = await wallet!.address();
    let balance: unknown = undefined;
    try {
      balance = await rc.getBalance(signer.publicKey);
    } catch {
      /* balance is best-effort */
    }
    return ok({
      signer_configured: true,
      write_tools_enabled: true,
      publicKey: signer.publicKey,
      address,
      balance,
    });
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// WRITE / TRANSACTION TOOLS — registered only when a signing wallet is configured.
// Every transaction is signed locally with ML-DSA-65 via @rougechain/sdk.
// ══════════════════════════════════════════════════════════════════════════════

async function tx(fn: () => Promise<unknown>) {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

if (signer) {
  const w = signer;

  // ── Core transfers, staking, faucet ─────────────────────────────────────────

  server.tool(
    "send_transaction",
    "Send XRGE or a custom token from the configured wallet to another address.",
    {
      to: z.string().describe("Recipient address (rouge1…) or public key hex"),
      amount: z.number().positive().describe("Amount to send"),
      token: z.string().optional().describe("Token symbol (omit for native XRGE)"),
      fee: z.number().optional().describe("Network fee (default 1)"),
    },
    async ({ to, amount, token, fee }) =>
      tx(() => rc.transfer(w, { to, amount, token, fee })),
  );

  server.tool(
    "burn_tokens",
    "Permanently burn XRGE or a token from the configured wallet (sends to the burn address).",
    {
      amount: z.number().positive().describe("Amount to burn"),
      token: z.string().optional().describe("Token symbol (default XRGE)"),
      fee: z.number().optional().describe("Network fee (default 1)"),
    },
    async ({ amount, token, fee }) =>
      tx(() => rc.burn(w, amount, fee ?? 1, token ?? "XRGE")),
  );

  server.tool(
    "stake",
    "Stake XRGE from the configured wallet to become a validator / earn rewards. Minimum 10,000 XRGE, enforced on every stake call (tiers: 10k standard, 100k operator, 1M genesis). The staking wallet's own key becomes the validator identity.",
    {
      amount: z.number().positive().describe("Amount of XRGE to stake"),
      fee: z.number().optional().describe("Network fee (default 1)"),
    },
    async ({ amount, fee }) => tx(() => rc.stake(w, { amount, fee })),
  );

  server.tool(
    "unstake",
    "Unstake previously-staked XRGE back to the configured wallet.",
    {
      amount: z.number().positive().describe("Amount of XRGE to unstake"),
      fee: z.number().optional().describe("Network fee (default 1)"),
    },
    async ({ amount, fee }) => tx(() => rc.unstake(w, { amount, fee })),
  );

  server.tool(
    "request_faucet",
    "Request testnet XRGE from the faucet for the configured wallet (testnet only).",
    {},
    async () => tx(() => rc.faucet(w)),
  );

  // ── Token issuance & administration ──────────────────────────────────────────

  server.tool(
    "create_token",
    "Create a new custom token on RougeChain (the configured wallet becomes the creator).",
    {
      name: z.string().describe("Human-readable token name"),
      symbol: z.string().describe("Ticker symbol, e.g. MYTOKEN"),
      totalSupply: z.number().positive().describe("Initial total supply"),
      image: z.string().optional().describe("Logo URL or data URI"),
      fee: z.number().optional().describe("Creation fee (default 10)"),
    },
    async ({ name, symbol, totalSupply, image, fee }) =>
      tx(() => rc.createToken(w, { name, symbol, totalSupply, image, fee })),
  );

  server.tool(
    "mint_tokens",
    "Mint additional supply of a mintable token (configured wallet must be the creator).",
    {
      symbol: z.string().describe("Token symbol to mint"),
      amount: z.number().positive().describe("Amount to mint"),
      fee: z.number().optional().describe("Network fee (default 1)"),
    },
    async ({ symbol, amount, fee }) =>
      tx(() => rc.mintTokens(w, { symbol, amount, fee })),
  );

  server.tool(
    "update_token_metadata",
    "Update the metadata (logo, description, links) of a token you created.",
    {
      symbol: z.string().describe("Token symbol"),
      image: z.string().optional().describe("Logo URL or data URI"),
      description: z.string().optional(),
      website: z.string().optional(),
      twitter: z.string().optional(),
      discord: z.string().optional(),
    },
    async ({ symbol, image, description, website, twitter, discord }) =>
      tx(() =>
        rc.updateTokenMetadata(w, { symbol, image, description, website, twitter, discord }),
      ),
  );

  server.tool(
    "claim_token_metadata",
    "Claim metadata authority for a token (creator verification).",
    { symbol: z.string().describe("Token symbol") },
    async ({ symbol }) => tx(() => rc.claimTokenMetadata(w, symbol)),
  );

  // ── DEX / AMM ────────────────────────────────────────────────────────────────

  server.tool(
    "swap",
    "Execute a token swap on the AMM DEX from the configured wallet. " +
      "Use get_swap_quote first to size min_amount_out for slippage protection.",
    {
      tokenIn: z.string().describe("Symbol of token to sell"),
      tokenOut: z.string().describe("Symbol of token to buy"),
      amountIn: z.number().positive().describe("Amount of tokenIn to sell"),
      minAmountOut: z.number().nonnegative().describe("Minimum acceptable tokenOut (slippage guard)"),
    },
    async ({ tokenIn, tokenOut, amountIn, minAmountOut }) =>
      tx(() => rc.dex.swap(w, { tokenIn, tokenOut, amountIn, minAmountOut })),
  );

  server.tool(
    "create_pool",
    "Create a new liquidity pool for a token pair with an initial deposit.",
    {
      tokenA: z.string().describe("First token symbol"),
      tokenB: z.string().describe("Second token symbol"),
      amountA: z.number().positive().describe("Initial amount of tokenA"),
      amountB: z.number().positive().describe("Initial amount of tokenB"),
    },
    async ({ tokenA, tokenB, amountA, amountB }) =>
      tx(() => rc.dex.createPool(w, { tokenA, tokenB, amountA, amountB })),
  );

  server.tool(
    "add_liquidity",
    "Add liquidity to an existing pool and receive LP tokens.",
    {
      poolId: z.string().describe("Pool ID"),
      amountA: z.number().positive().describe("Amount of tokenA to add"),
      amountB: z.number().positive().describe("Amount of tokenB to add"),
    },
    async ({ poolId, amountA, amountB }) =>
      tx(() => rc.dex.addLiquidity(w, { poolId, amountA, amountB })),
  );

  server.tool(
    "remove_liquidity",
    "Withdraw liquidity from a pool by burning LP tokens.",
    {
      poolId: z.string().describe("Pool ID"),
      lpAmount: z.number().positive().describe("Amount of LP tokens to burn"),
    },
    async ({ poolId, lpAmount }) =>
      tx(() => rc.dex.removeLiquidity(w, { poolId, lpAmount })),
  );

  // ── NFTs ──────────────────────────────────────────────────────────────────────

  server.tool(
    "nft_create_collection",
    "Create a new NFT collection (configured wallet becomes the owner/creator).",
    {
      symbol: z.string().describe("Collection symbol"),
      name: z.string().describe("Collection name"),
      maxSupply: z.number().optional().describe("Max mintable supply"),
      royaltyBps: z.number().optional().describe("Creator royalty in basis points (100 = 1%)"),
      image: z.string().optional().describe("Cover image URL or data URI"),
      description: z.string().optional(),
      publicMint: z.boolean().optional().describe("Allow anyone to mint"),
      mintPrice: z.number().optional().describe("Price per mint if publicMint"),
    },
    async (a) => tx(() => rc.nft.createCollection(w, a)),
  );

  server.tool(
    "nft_mint",
    "Mint a single NFT into a collection.",
    {
      collectionId: z.string().describe("Collection ID"),
      name: z.string().describe("NFT name"),
      metadataUri: z.string().optional().describe("Metadata URI (ipfs/https/data)"),
      attributes: z.record(z.unknown()).optional().describe("Trait attributes"),
    },
    async ({ collectionId, name, metadataUri, attributes }) =>
      tx(() => rc.nft.mint(w, { collectionId, name, metadataUri, attributes })),
  );

  server.tool(
    "nft_batch_mint",
    "Mint many NFTs into a collection in one transaction.",
    {
      collectionId: z.string().describe("Collection ID"),
      names: z.array(z.string()).describe("Names for each NFT (defines batch size)"),
      uris: z.array(z.string()).optional().describe("Metadata URI per NFT (parallel to names)"),
    },
    async ({ collectionId, names, uris }) =>
      tx(() => rc.nft.batchMint(w, { collectionId, names, uris })),
  );

  server.tool(
    "nft_transfer",
    "Transfer an NFT to another wallet, optionally recording a sale price.",
    {
      collectionId: z.string().describe("Collection ID"),
      tokenId: z.number().int().describe("Token ID within the collection"),
      to: z.string().describe("Recipient address or public key"),
      salePrice: z.number().optional().describe("Sale price to record (for royalties)"),
    },
    async ({ collectionId, tokenId, to, salePrice }) =>
      tx(() => rc.nft.transfer(w, { collectionId, tokenId, to, salePrice })),
  );

  server.tool(
    "nft_burn",
    "Permanently burn an NFT you own.",
    {
      collectionId: z.string().describe("Collection ID"),
      tokenId: z.number().int().describe("Token ID"),
    },
    async ({ collectionId, tokenId }) =>
      tx(() => rc.nft.burn(w, { collectionId, tokenId })),
  );

  server.tool(
    "nft_lock",
    "Lock or unlock an NFT (locked NFTs cannot be transferred).",
    {
      collectionId: z.string().describe("Collection ID"),
      tokenId: z.number().int().describe("Token ID"),
      locked: z.boolean().describe("true to lock, false to unlock"),
    },
    async ({ collectionId, tokenId, locked }) =>
      tx(() => rc.nft.lock(w, { collectionId, tokenId, locked })),
  );

  server.tool(
    "nft_freeze_collection",
    "Freeze or unfreeze an entire collection (frozen collections cannot mint).",
    {
      collectionId: z.string().describe("Collection ID"),
      frozen: z.boolean().describe("true to freeze, false to unfreeze"),
    },
    async ({ collectionId, frozen }) =>
      tx(() => rc.nft.freezeCollection(w, { collectionId, frozen })),
  );

  // ── Name service ─────────────────────────────────────────────────────────────

  server.tool(
    "register_name",
    "Register a human-readable name (e.g. 'alice') to a wallet on the RougeChain name service.",
    {
      name: z.string().describe("Name to register, without @domain"),
      walletId: z.string().describe("Wallet ID / public key to bind the name to"),
    },
    async ({ name, walletId }) => tx(() => rc.mail.registerName(w, name, walletId)),
  );

  server.tool(
    "release_name",
    "Release a name previously registered by the configured wallet.",
    { name: z.string().describe("Name to release") },
    async ({ name }) => tx(() => rc.mail.releaseName(w, name)),
  );

  // ── On-chain social ──────────────────────────────────────────────────────────

  server.tool(
    "create_post",
    "Publish a post to the on-chain social timeline from the configured wallet.",
    {
      body: z.string().describe("Post text"),
      replyToId: z.string().optional().describe("Parent post ID to reply to (omit for a top-level post)"),
    },
    async ({ body, replyToId }) => tx(() => rc.social.createPost(w, body, replyToId)),
  );

  server.tool(
    "delete_post",
    "Delete a post the configured wallet authored.",
    { postId: z.string().describe("Post ID") },
    async ({ postId }) => tx(() => rc.social.deletePost(w, postId)),
  );

  server.tool(
    "repost",
    "Toggle a repost of another user's post.",
    { postId: z.string().describe("Post ID to repost") },
    async ({ postId }) => tx(() => rc.social.toggleRepost(w, postId)),
  );

  server.tool(
    "follow",
    "Toggle following an artist/user by public key.",
    { pubkey: z.string().describe("Public key of the account to follow/unfollow") },
    async ({ pubkey }) => tx(() => rc.social.toggleFollow(w, pubkey)),
  );

  server.tool(
    "like_track",
    "Toggle a like on a music track / NFT.",
    { trackId: z.string().describe("Track or NFT token ID") },
    async ({ trackId }) => tx(() => rc.social.toggleLike(w, trackId)),
  );

  server.tool(
    "comment_on_track",
    "Post a comment on a music track / NFT.",
    {
      trackId: z.string().describe("Track or NFT token ID"),
      body: z.string().describe("Comment text"),
    },
    async ({ trackId, body }) => tx(() => rc.social.postComment(w, trackId, body)),
  );

  // ── Bridge ───────────────────────────────────────────────────────────────────

  server.tool(
    "bridge_withdraw",
    "Withdraw a bridged asset from RougeChain to an EVM address (e.g. Base Sepolia).",
    {
      amount: z.number().positive().describe("Amount to withdraw"),
      evmAddress: z.string().describe("Destination EVM address (0x…)"),
      tokenSymbol: z.string().optional().describe("Bridged token symbol (default qETH)"),
      fee: z.number().optional().describe("Bridge fee (default 0.1)"),
    },
    async ({ amount, evmAddress, tokenSymbol, fee }) =>
      tx(() => rc.bridge.withdraw(w, { amount, evmAddress, tokenSymbol, fee })),
  );
}

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
  if (signer) {
    console.error(`[rougechain-mcp] Signer loaded — write tools ENABLED (${signer.publicKey.slice(0, 16)}…)`);
  } else {
    console.error("[rougechain-mcp] No signer — running READ-ONLY. Set ROUGECHAIN_MNEMONIC to enable transacting.");
  }
}

main().catch((err) => {
  console.error("[rougechain-mcp] Fatal error:", err);
  process.exit(1);
});
