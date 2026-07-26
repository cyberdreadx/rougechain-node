import { motion } from "framer-motion";
import {
  Bot,
  Blocks,
  Wallet,
  Coins,
  Image,
  Shield,
  FileCode,
  ArrowDownUp,
  Copy,
  Check,
  Terminal,
  Cpu,
  Zap,
  Globe,
  ExternalLink,
  ChevronRight,
  MessageCircle,
  Heart,
  Users,
  Tag,
  KeyRound,
  Landmark,
  Layers,
  Lock,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

// Tools marked `write: true` sign a real transaction with ML-DSA-65 and are only
// available when the MCP server is configured with a wallet (ROUGECHAIN_MNEMONIC).
type AgentTool = { name: string; desc: string; write?: boolean };

const toolCategories: {
  title: string;
  icon: typeof Blocks;
  color: string;
  bg: string;
  tools: AgentTool[];
}[] = [
  {
    title: "Wallet Keys",
    icon: KeyRound,
    color: "text-indigo-400",
    bg: "bg-indigo-500/10",
    tools: [
      { name: "generate_wallet", desc: "Create a fresh ML-DSA-65 wallet + mnemonic" },
      { name: "wallet_info", desc: "Configured signer, address, balance, write status" },
    ],
  },
  {
    title: "Chain",
    icon: Blocks,
    color: "text-blue-400",
    bg: "bg-blue-500/10",
    tools: [
      { name: "get_chain_stats", desc: "Block height, validators, supply, fees" },
      { name: "get_block", desc: "Fetch any block by height" },
      { name: "get_latest_blocks", desc: "Stream recent blocks" },
    ],
  },
  {
    title: "Wallet",
    icon: Wallet,
    color: "text-emerald-400",
    bg: "bg-emerald-500/10",
    tools: [
      { name: "get_balance", desc: "Check XRGE and token balances" },
      { name: "get_transaction", desc: "Look up any transaction by hash" },
      { name: "send_transaction", desc: "Send XRGE or any token to an address", write: true },
      { name: "burn_tokens", desc: "Permanently burn XRGE or a token", write: true },
    ],
  },
  {
    title: "Tokens",
    icon: Coins,
    color: "text-amber-400",
    bg: "bg-amber-500/10",
    tools: [
      { name: "list_tokens", desc: "All tokens on the network" },
      { name: "get_token", desc: "Token metadata, supply, and creator" },
      { name: "get_token_holders", desc: "Top holders and supply breakdown" },
      { name: "create_token", desc: "Issue a new custom token", write: true },
      { name: "mint_tokens", desc: "Mint more supply of a mintable token", write: true },
      { name: "update_token_metadata", desc: "Update logo, links, description", write: true },
      { name: "claim_token_metadata", desc: "Claim creator metadata authority", write: true },
    ],
  },
  {
    title: "DeFi",
    icon: ArrowDownUp,
    color: "text-violet-400",
    bg: "bg-violet-500/10",
    tools: [
      { name: "list_pools", desc: "All AMM liquidity pools" },
      { name: "get_swap_quote", desc: "Quote a token swap with slippage" },
      { name: "swap", desc: "Execute a swap on the AMM DEX", write: true },
      { name: "create_pool", desc: "Create a new liquidity pool", write: true },
      { name: "add_liquidity", desc: "Add liquidity and receive LP tokens", write: true },
      { name: "remove_liquidity", desc: "Burn LP tokens to withdraw", write: true },
    ],
  },
  {
    title: "NFTs",
    icon: Image,
    color: "text-pink-400",
    bg: "bg-pink-500/10",
    tools: [
      { name: "list_nft_collections", desc: "Browse NFT collections" },
      { name: "get_nft_collection", desc: "Collection metadata and tokens" },
      { name: "nft_create_collection", desc: "Launch a new NFT collection", write: true },
      { name: "nft_mint", desc: "Mint a single NFT", write: true },
      { name: "nft_batch_mint", desc: "Mint many NFTs in one tx", write: true },
      { name: "nft_transfer", desc: "Transfer an NFT (with optional sale price)", write: true },
      { name: "nft_burn", desc: "Permanently burn an NFT", write: true },
      { name: "nft_lock", desc: "Lock / unlock an NFT", write: true },
      { name: "nft_freeze_collection", desc: "Freeze / unfreeze a collection", write: true },
    ],
  },
  {
    title: "Staking & Faucet",
    icon: Layers,
    color: "text-green-400",
    bg: "bg-green-500/10",
    tools: [
      { name: "stake", desc: "Stake XRGE to secure the chain", write: true },
      { name: "unstake", desc: "Unstake XRGE back to your wallet", write: true },
      { name: "request_faucet", desc: "Claim testnet XRGE (testnet only)", write: true },
    ],
  },
  {
    title: "Validators",
    icon: Shield,
    color: "text-cyan-400",
    bg: "bg-cyan-500/10",
    tools: [
      { name: "list_validators", desc: "Active validators and stake" },
    ],
  },
  {
    title: "Smart Contracts",
    icon: FileCode,
    color: "text-orange-400",
    bg: "bg-orange-500/10",
    tools: [
      { name: "list_contracts", desc: "Deployed WASM contracts" },
      { name: "get_contract", desc: "Contract metadata and bytecode" },
      { name: "get_contract_state", desc: "Read contract storage" },
      { name: "get_contract_events", desc: "Contract event history" },
      { name: "deploy_contract", desc: "Deploy a new WASM contract" },
      { name: "call_contract", desc: "Execute a contract method" },
    ],
  },
  {
    title: "Social",
    icon: Heart,
    color: "text-rose-400",
    bg: "bg-rose-500/10",
    tools: [
      { name: "get_global_timeline", desc: "Global feed — all posts, newest first" },
      { name: "get_post", desc: "Single post with engagement stats" },
      { name: "get_user_posts", desc: "Posts by a specific user" },
      { name: "get_post_replies", desc: "Threaded replies to a post" },
      { name: "get_track_stats", desc: "Music track plays, likes, comments" },
      { name: "get_artist_stats", desc: "Artist followers and follow state" },
      { name: "create_post", desc: "Publish a post on-chain", write: true },
      { name: "delete_post", desc: "Delete your own post", write: true },
      { name: "repost", desc: "Repost another user's post", write: true },
      { name: "follow", desc: "Follow / unfollow an account", write: true },
      { name: "like_track", desc: "Like / unlike a track or NFT", write: true },
      { name: "comment_on_track", desc: "Comment on a track or NFT", write: true },
    ],
  },
  {
    title: "Messaging",
    icon: MessageCircle,
    color: "text-sky-400",
    bg: "bg-sky-500/10",
    tools: [
      { name: "list_messenger_wallets", desc: "Registered wallets with display names" },
    ],
  },
  {
    title: "Names & Identity",
    icon: Tag,
    color: "text-teal-400",
    bg: "bg-teal-500/10",
    tools: [
      { name: "resolve_name", desc: "Resolve rouge.quant / qwalla.mail names" },
      { name: "reverse_lookup_name", desc: "Look up name for a wallet or public key" },
      { name: "register_name", desc: "Register a name to a wallet", write: true },
      { name: "release_name", desc: "Release a name you registered", write: true },
    ],
  },
  {
    title: "Bridge",
    icon: Landmark,
    color: "text-fuchsia-400",
    bg: "bg-fuchsia-500/10",
    tools: [
      { name: "bridge_withdraw", desc: "Withdraw a bridged asset to an EVM address", write: true },
    ],
  },
  {
    title: "Governance & Fees",
    icon: Globe,
    color: "text-lime-400",
    bg: "bg-lime-500/10",
    tools: [
      { name: "list_proposals", desc: "Governance proposals" },
      { name: "get_fee_info", desc: "Current EIP-1559 dynamic fee data" },
    ],
  },
];

const TOTAL_TOOLS = toolCategories.reduce((n, c) => n + c.tools.length, 0);
const WRITE_TOOLS = toolCategories.reduce(
  (n, c) => n + c.tools.filter((t) => t.write).length,
  0,
);

const claudeConfig = `{
  "mcpServers": {
    "rougechain": {
      "command": "npx",
      "args": ["-y", "@rougechain/mcp-server"],
      "env": {
        "ROUGECHAIN_URL": "https://api.rougechain.io"
      }
    }
  }
}`;

// Same server, plus a wallet — unlocks the signed write tools.
const claudeConfigWrite = `{
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
}`;

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="absolute top-3 right-3 p-1.5 rounded-md bg-white/5 hover:bg-white/10 transition-colors"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-muted-foreground" />}
    </button>
  );
}

const Agents = () => {
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-5xl mx-auto px-6 py-12 sm:py-16">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          {/* Hero */}
          <div className="text-center mb-16">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-medium mb-4">
              <Bot className="w-3.5 h-3.5" />
              MCP Native
            </div>
            <h1 className="text-4xl sm:text-5xl font-bold text-foreground tracking-tight">
              AI Agents on RougeChain
            </h1>
            <p className="text-lg text-muted-foreground mt-4 max-w-2xl mx-auto leading-relaxed">
              RougeChain is the first blockchain with native{" "}
              <a href="https://modelcontextprotocol.io/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                Model Context Protocol
              </a>{" "}
              integration. AI agents can query chain state, interact with DeFi, deploy contracts, and manage wallets — all through a standardized protocol.
            </p>
          </div>

          {/* Architecture */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="mb-16"
          >
            <h2 className="text-xl font-semibold text-foreground mb-6 flex items-center gap-2">
              <Cpu className="w-5 h-5 text-primary" />
              How It Works
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              {[
                { label: "AI Agent", sub: "Claude, GPT, Custom", icon: Bot, color: "text-violet-400", bg: "bg-violet-500/10" },
                { label: "MCP Server", sub: `${TOTAL_TOOLS} blockchain tools`, icon: Terminal, color: "text-blue-400", bg: "bg-blue-500/10" },
                { label: "Node API", sub: "REST + JSON-RPC", icon: Globe, color: "text-emerald-400", bg: "bg-emerald-500/10" },
                { label: "RougeChain L1", sub: "ML-DSA + ML-KEM", icon: Zap, color: "text-amber-400", bg: "bg-amber-500/10" },
              ].map((step, i) => (
                <div key={step.label} className="relative">
                  <div className={cn("rounded-xl border border-border p-4 text-center", step.bg)}>
                    <step.icon className={cn("w-8 h-8 mx-auto mb-2", step.color)} />
                    <div className="font-semibold text-foreground text-sm">{step.label}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{step.sub}</div>
                  </div>
                  {i < 3 && (
                    <div className="hidden sm:flex absolute -right-3 top-1/2 -translate-y-1/2 z-10">
                      <ChevronRight className="w-5 h-5 text-muted-foreground/40" />
                    </div>
                  )}
                </div>
              ))}
            </div>
            <p className="text-sm text-muted-foreground mt-4 text-center">
              Agents communicate via stdio over the MCP protocol. All on-chain operations maintain post-quantum security guarantees (ML-DSA-65 / ML-KEM-768).
            </p>
          </motion.div>

          {/* What Agents Can Do */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            className="mb-16"
          >
            <h2 className="text-xl font-semibold text-foreground mb-2 flex items-center gap-2">
              <Zap className="w-5 h-5 text-primary" />
              What Agents Can Do
            </h2>
            <p className="text-sm text-muted-foreground mb-6">
              {TOTAL_TOOLS} tools across {toolCategories.length} categories — {TOTAL_TOOLS - WRITE_TOOLS} read-only,
              plus <span className="text-amber-400 font-medium">{WRITE_TOOLS} that sign real transactions</span>{" "}
              (<Lock className="inline w-3 h-3 -mt-0.5" /> shown below). Write tools activate when the server is
              configured with a wallet.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {toolCategories.map((cat) => {
                const isExpanded = expandedCategory === cat.title;
                return (
                  <button
                    key={cat.title}
                    onClick={() => setExpandedCategory(isExpanded ? null : cat.title)}
                    className={cn(
                      "text-left rounded-xl border border-border p-4 transition-all duration-200 hover:border-primary/30",
                      isExpanded && "border-primary/40 bg-primary/5"
                    )}
                  >
                    <div className="flex items-center gap-3 mb-1">
                      <div className={cn("p-2 rounded-lg", cat.bg)}>
                        <cat.icon className={cn("w-4 h-4", cat.color)} />
                      </div>
                      <div>
                        <div className="font-semibold text-foreground text-sm">{cat.title}</div>
                        <div className="text-xs text-muted-foreground">{cat.tools.length} tool{cat.tools.length > 1 ? "s" : ""}</div>
                      </div>
                      <ChevronRight className={cn(
                        "w-4 h-4 ml-auto text-muted-foreground/40 transition-transform duration-200",
                        isExpanded && "rotate-90"
                      )} />
                    </div>
                    {isExpanded && (
                      <div className="mt-3 space-y-1.5 pl-11">
                        {cat.tools.map((tool) => (
                          <div key={tool.name} className="text-xs">
                            <code className="text-primary font-mono">{tool.name}</code>
                            {tool.write && (
                              <span className="inline-flex items-center gap-0.5 align-middle ml-1.5 rounded px-1 py-px text-[10px] font-medium bg-amber-500/15 text-amber-400">
                                <Lock className="w-2.5 h-2.5" /> signs tx
                              </span>
                            )}
                            <span className="text-muted-foreground ml-1.5">— {tool.desc}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </motion.div>

          {/* Setup */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="mb-16"
          >
            <h2 className="text-xl font-semibold text-foreground mb-6 flex items-center gap-2">
              <Terminal className="w-5 h-5 text-primary" />
              Quick Start
            </h2>

            <div className="space-y-6">
              {/* Step 1 */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">1</span>
                  <span className="font-medium text-foreground text-sm">Install the MCP server</span>
                </div>
                <div className="relative rounded-lg bg-card border border-border overflow-hidden">
                  <CopyButton text="npm install -g @rougechain/mcp-server" />
                  <pre className="p-4 text-sm font-mono text-foreground overflow-x-auto">
                    <code>
                      <span className="text-muted-foreground">$</span> npm install -g @rougechain/mcp-server
                    </code>
                  </pre>
                </div>
                <p className="text-[11px] text-muted-foreground mt-2">Or use <code className="text-primary">npx @rougechain/mcp-server</code> directly — no global install needed.</p>
              </div>

              {/* Step 2 */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">2</span>
                  <span className="font-medium text-foreground text-sm">Add to your AI agent config</span>
                </div>
                <div className="space-y-3">
                  <div>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-xs font-medium text-muted-foreground">Claude Desktop — read-only</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400 font-medium">Recommended</span>
                    </div>
                    <div className="relative rounded-lg bg-card border border-border overflow-hidden">
                      <CopyButton text={claudeConfig} />
                      <pre className="p-4 text-xs font-mono text-foreground overflow-x-auto">
                        <code>{claudeConfig}</code>
                      </pre>
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-xs font-medium text-muted-foreground">Read + write</span>
                      <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 font-medium">
                        <Lock className="w-2.5 h-2.5" /> signs transactions
                      </span>
                    </div>
                    <div className="relative rounded-lg bg-card border border-border overflow-hidden">
                      <CopyButton text={claudeConfigWrite} />
                      <pre className="p-4 text-xs font-mono text-foreground overflow-x-auto">
                        <code>{claudeConfigWrite}</code>
                      </pre>
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-2">
                      Add <code className="text-primary">ROUGECHAIN_MNEMONIC</code> to unlock the {WRITE_TOOLS} signing
                      tools. Every transaction is signed locally with ML-DSA-65 — your seed phrase never leaves the
                      server. Use a dedicated low-balance agent wallet; generate one with the{" "}
                      <code className="text-primary">generate_wallet</code> tool.
                    </p>
                  </div>
                </div>
              </div>

              {/* Step 3 */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">3</span>
                  <span className="font-medium text-foreground text-sm">Start talking to the chain</span>
                </div>
                <div className="rounded-lg bg-card border border-border p-4">
                  <div className="space-y-3 text-sm">
                    <div className="flex gap-3">
                      <Bot className="w-5 h-5 text-violet-400 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-muted-foreground italic">"What's the current block height and how many validators are active?"</p>
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <Bot className="w-5 h-5 text-emerald-400 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-muted-foreground italic">"Check the balance of rouge1q8f3x... and list their recent transactions"</p>
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <Bot className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-muted-foreground italic">"Get a swap quote for 1000 XRGE to QSHIB with 2% slippage"</p>
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <Bot className="w-5 h-5 text-rose-400 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-muted-foreground italic">"Show me the latest posts on the social timeline and the top artists"</p>
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <Lock className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-muted-foreground italic">"Create a token called AGENT, seed a XRGE/AGENT pool, and post about the launch"</p>
                        <p className="text-[11px] text-amber-400/80 mt-0.5">requires a wallet — signs real transactions</p>
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <Bot className="w-5 h-5 text-pink-400 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-muted-foreground italic">"Deploy this WASM contract and call the init function"</p>
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <Bot className="w-5 h-5 text-teal-400 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-muted-foreground italic">"Resolve rougeboss@rouge.quant and show their token holdings"</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>

          {/* Compatible Agents */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.25 }}
            className="mb-16"
          >
            <h2 className="text-xl font-semibold text-foreground mb-6 flex items-center gap-2">
              <Bot className="w-5 h-5 text-primary" />
              Compatible Agents
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                { name: "Claude Desktop", desc: "Drop-in config with native MCP support", status: "Supported" },
                { name: "Cursor IDE", desc: "MCP tools available in agent mode", status: "Supported" },
                { name: "Custom Agents", desc: "Any MCP-compatible client via stdio", status: "Supported" },
              ].map((agent) => (
                <div key={agent.name} className="rounded-xl border border-border p-4">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold text-foreground text-sm">{agent.name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-medium">{agent.status}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{agent.desc}</p>
                </div>
              ))}
            </div>
          </motion.div>

          {/* Resources */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
          >
            <h2 className="text-xl font-semibold text-foreground mb-4">Resources</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <a
                href="https://github.com/cyberdreadx/rougechain-node/tree/main/mcp-server"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 rounded-xl border border-border p-4 hover:border-primary/30 transition-colors group"
              >
                <Terminal className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
                <div className="flex-1">
                  <div className="font-medium text-foreground text-sm">MCP Server Source</div>
                  <div className="text-xs text-muted-foreground">View on GitHub</div>
                </div>
                <ExternalLink className="w-4 h-4 text-muted-foreground/40" />
              </a>
              <a
                href="https://docs.rougechain.io/advanced/mcp-server.html"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 rounded-xl border border-border p-4 hover:border-primary/30 transition-colors group"
              >
                <FileCode className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
                <div className="flex-1">
                  <div className="font-medium text-foreground text-sm">Documentation</div>
                  <div className="text-xs text-muted-foreground">Full setup and API guide</div>
                </div>
                <ExternalLink className="w-4 h-4 text-muted-foreground/40" />
              </a>
              <a
                href="https://www.npmjs.com/package/@rougechain/sdk"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 rounded-xl border border-border p-4 hover:border-primary/30 transition-colors group"
              >
                <Coins className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
                <div className="flex-1">
                  <div className="font-medium text-foreground text-sm">@rougechain/sdk</div>
                  <div className="text-xs text-muted-foreground">TypeScript SDK on npm</div>
                </div>
                <ExternalLink className="w-4 h-4 text-muted-foreground/40" />
              </a>
              <a
                href="https://modelcontextprotocol.io/"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 rounded-xl border border-border p-4 hover:border-primary/30 transition-colors group"
              >
                <Globe className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors" />
                <div className="flex-1">
                  <div className="font-medium text-foreground text-sm">MCP Specification</div>
                  <div className="text-xs text-muted-foreground">Model Context Protocol docs</div>
                </div>
                <ExternalLink className="w-4 h-4 text-muted-foreground/40" />
              </a>
            </div>
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
};

export default Agents;
