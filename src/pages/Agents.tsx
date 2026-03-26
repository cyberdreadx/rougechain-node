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
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

const toolCategories = [
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
    ],
  },
  {
    title: "Tokens",
    icon: Coins,
    color: "text-amber-400",
    bg: "bg-amber-500/10",
    tools: [
      { name: "list_tokens", desc: "All tokens on the network" },
      { name: "get_token", desc: "Token metadata and supply" },
      { name: "get_token_holders", desc: "Top holders for any token" },
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
    title: "Other",
    icon: Globe,
    color: "text-teal-400",
    bg: "bg-teal-500/10",
    tools: [
      { name: "list_proposals", desc: "Governance proposals" },
      { name: "get_fee_info", desc: "Current EIP-1559 fee data" },
      { name: "resolve_name", desc: "Resolve rouge.quant names" },
    ],
  },
];

const claudeConfig = `{
  "mcpServers": {
    "rougechain": {
      "command": "node",
      "args": ["/path/to/mcp-server/dist/index.js"],
      "env": {
        "ROUGECHAIN_URL": "https://rougechain.io"
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
                { label: "MCP Server", sub: "22 blockchain tools", icon: Terminal, color: "text-blue-400", bg: "bg-blue-500/10" },
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
            <p className="text-sm text-muted-foreground mb-6">22 tools across 8 categories — everything an agent needs to interact with the chain.</p>

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
                  <CopyButton text="cd mcp-server && npm install && npm run build" />
                  <pre className="p-4 text-sm font-mono text-foreground overflow-x-auto">
                    <code>
                      <span className="text-muted-foreground">$</span> cd mcp-server{"\n"}
                      <span className="text-muted-foreground">$</span> npm install{"\n"}
                      <span className="text-muted-foreground">$</span> npm run build
                    </code>
                  </pre>
                </div>
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
                      <span className="text-xs font-medium text-muted-foreground">Claude Desktop</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400 font-medium">Recommended</span>
                    </div>
                    <div className="relative rounded-lg bg-card border border-border overflow-hidden">
                      <CopyButton text={claudeConfig} />
                      <pre className="p-4 text-xs font-mono text-foreground overflow-x-auto">
                        <code>{claudeConfig}</code>
                      </pre>
                    </div>
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
                        <p className="text-muted-foreground italic">"Get a swap quote for 1000 XRGE to MTK with 2% slippage"</p>
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <Bot className="w-5 h-5 text-pink-400 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-muted-foreground italic">"Deploy this WASM contract and call the init function"</p>
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
