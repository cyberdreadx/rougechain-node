import { motion, AnimatePresence } from "framer-motion";
import { Link } from "react-router-dom";
import {
  Wallet, MessageSquareLock, Shield, Lock, Activity, ExternalLink,
  TrendingUp, ArrowDownUp, Droplets, Coins, Image as ImageIcon,
  Cable, Mail as MailIcon, Server, Github, Chrome, ChevronLeft, ChevronRight,
  Bot, Code, Smartphone, BookOpen, Terminal, FileCode, ArrowRight,
  Boxes, Wrench, Compass, AlertTriangle, Sprout,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEffect, useState, useCallback, useRef } from "react";
import { getCoreApiBaseUrl, getCoreApiHeaders, getNetworkLabel } from "@/lib/network";
import { useBlockchainWs } from "@/hooks/use-blockchain-ws";
import { useXRGEPrice } from "@/hooks/use-xrge-price";
import { EmailCaptureBanner, EmailCapturePopup } from "@/components/EmailCapture";
import { formatUsd } from "@/lib/price-service";
import xrgeLogo from "@/assets/xrge-logo.webp";
import qwallaApp from "@/assets/qwalla-app.jpg";
import ss1 from "@/assets/screenshot_1_wallet.png";
import ss2 from "@/assets/screenshot_2_chat.png";
import ss3 from "@/assets/screenshot_3_mail.png";
import ss4 from "@/assets/screenshot_4_tokens.png";
import ss5 from "@/assets/screenshot_5_create.png";

// Base-mainnet XRGE ERC-20 (for buy/trade links). Native XRGE lives on RougeChain L1.
const XRGE_BASE_ADDRESS = "0x147120faEC9277ec02d957584CFCD92B56A24317";
const AERODROME_BUY = `https://aerodrome.finance/swap?from=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913&to=${XRGE_BASE_ADDRESS}&chain0=8453&chain1=8453`;
const DEXSCREENER = `https://dexscreener.com/base/${XRGE_BASE_ADDRESS}`;
// GeckoTerminal pool (XRGE/USDC on Base) — more reliable chart embed than DexScreener.
const GECKOTERMINAL_POOL = "https://www.geckoterminal.com/base/pools/0x059e10d26c64a63d04e1814f46305210eddc447d";
const DOCS = "https://docs.rougechain.io";
const GITHUB = "https://github.com/cyberdreadx/rougechain-node";
const QWALLA_SITE = "https://qwalla.io";
const QWALLA_APPSTORE = "https://apps.apple.com/us/app/qwalla/id6794071016";

const scrollTo = (id: string) => () => {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
};

/* ─────────────────────────  Network status (honest, scoped)  ───────────────────────── */

type NetState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "live"; height: number; peers: number; validators: number | null; chainId?: string; updatedAt: number };

const NetworkStatus = () => {
  const [state, setState] = useState<NetState>({ kind: "loading" });
  const [pulseKey, setPulseKey] = useState(0);
  const [, force] = useState(0); // re-render for the "updated Ns ago" label

  const fetchStats = useCallback(async () => {
    const base = getCoreApiBaseUrl();
    if (!base) { setState({ kind: "unavailable" }); return; }
    try {
      const h = getCoreApiHeaders();
      const [statsRes, valRes] = await Promise.allSettled([
        fetch(`${base}/stats`, { headers: h, signal: AbortSignal.timeout(10000) }),
        fetch(`${base}/validators`, { headers: h, signal: AbortSignal.timeout(10000) }),
      ]);
      if (statsRes.status !== "fulfilled" || !statsRes.value.ok) { setState({ kind: "unavailable" }); return; }
      const data = await statsRes.value.json();
      let validators: number | null = null;
      if (valRes.status === "fulfilled" && valRes.value.ok) {
        const v = await valRes.value.json();
        validators = Array.isArray(v) ? v.length : (v.validators || []).length;
      }
      setState(prev => {
        const height = data.network_height || data.networkHeight || 0;
        if (prev.kind === "live" && height > prev.height) setPulseKey(k => k + 1);
        return {
          kind: "live",
          height,
          peers: data.connected_peers || data.connectedPeers || 0,
          validators,
          chainId: data.chain_id || data.chainId || (prev.kind === "live" ? prev.chainId : undefined),
          updatedAt: Date.now(),
        };
      });
    } catch {
      setState({ kind: "unavailable" });
    }
  }, []);

  const handleNewBlock = useCallback(() => { fetchStats(); setPulseKey(k => k + 1); }, [fetchStats]);
  useBlockchainWs({ onNewBlock: handleNewBlock, fallbackPollInterval: 10000 });
  useEffect(() => { fetchStats(); }, [fetchStats]);
  // tick the freshness label
  useEffect(() => { const t = setInterval(() => force(n => n + 1), 5000); return () => clearInterval(t); }, []);

  const ageLabel = state.kind === "live" ? `${Math.max(0, Math.round((Date.now() - state.updatedAt) / 1000))}s ago` : "";
  const stale = state.kind === "live" && Date.now() - state.updatedAt > 60000;
  const singleNode = state.kind === "live" && state.peers === 0;

  return (
    <section id="network" className="mb-16">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Network status</h2>
        </div>
        <Link to="/blockchain" className="text-xs text-primary hover:text-primary/80 flex items-center gap-1">
          Full explorer <ArrowRight className="w-3 h-3" />
        </Link>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        {state.kind === "loading" && (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span className="w-2.5 h-2.5 rounded-full bg-muted-foreground/40 animate-pulse" />
            Checking the network…
          </div>
        )}

        {state.kind === "unavailable" && (
          <div className="flex items-center gap-3 text-sm">
            <span className="w-2.5 h-2.5 rounded-full bg-muted-foreground/50" />
            <span className="text-muted-foreground">
              Network status is temporarily unavailable — the public node didn’t respond. This doesn’t mean the chain is down;
              try the <Link to="/blockchain" className="text-primary hover:underline">explorer</Link>.
            </span>
          </div>
        )}

        {state.kind === "live" && (
          <div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <div className="flex items-center gap-2">
                <div className="relative">
                  <motion.div
                    key={pulseKey}
                    initial={{ scale: 1, opacity: 0.7 }}
                    animate={{ scale: 2.4, opacity: 0 }}
                    transition={{ duration: 1, ease: "easeOut" }}
                    className="absolute inset-0 rounded-full bg-primary"
                  />
                  <div className={`w-2.5 h-2.5 rounded-full ${stale ? "bg-warning" : "bg-primary animate-pulse"}`} />
                </div>
                <span className="text-sm font-mono text-primary/90">
                  {getNetworkLabel(state.chainId).toUpperCase()}
                </span>
              </div>

              <Stat label="Block height" value={`#${state.height.toLocaleString()}`} />
              <Stat label="Peers" value={String(state.peers)} />
              {state.validators !== null && <Stat label="Validators" value={String(state.validators)} />}
              <span className="text-xs text-muted-foreground ml-auto">
                {stale ? "data may be stale · " : ""}updated {ageLabel}
              </span>
            </div>

            {singleNode && (
              <p className="text-xs text-muted-foreground mt-3 pt-3 border-t border-border">
                This is an early network currently served by a <strong className="text-foreground">single public node</strong>,
                so <span className="font-mono">Peers = 0</span> is expected. Figures above are read live from that node —
                see the <Link to="/blockchain" className="text-primary hover:underline">explorer</Link> for full history.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
};

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center gap-1.5 text-sm font-mono">
    <span className="text-muted-foreground text-xs uppercase tracking-wide">{label}</span>
    <span className="text-foreground font-bold">{value}</span>
  </div>
);

/* ─────────────────────────  Brand relationship  ───────────────────────── */

const BrandIntro = () => (
  <section className="mb-16">
    <div className="grid sm:grid-cols-3 gap-3">
      {[
        {
          name: "RougeChain", tag: "The network",
          body: "A Layer 1 blockchain built around post-quantum cryptography — signatures, encryption and hashing use NIST-standardized algorithms.",
          color: "text-primary", bg: "bg-primary/10", icon: Shield,
        },
        {
          name: "XRGE", tag: "The native token",
          body: "Pays transaction fees (from 0.1 XRGE) and gas, and is staked to run validators (10,000 XRGE). Also trades as an ERC-20 on Base — bridge it to use natively.",
          color: "text-accent", bg: "bg-accent/10", icon: Coins,
        },
        {
          name: "Qwalla", tag: "A wallet for the ecosystem",
          body: "A mobile wallet to hold XRGE, send encrypted chat and mail, and open on-chain apps. One of several ways into RougeChain.",
          color: "text-success", bg: "bg-success/10", icon: Smartphone,
        },
      ].map(b => (
        <div key={b.name} className="p-4 rounded-xl bg-card border border-border">
          <div className={`w-9 h-9 rounded-lg ${b.bg} flex items-center justify-center mb-3`}>
            <b.icon className={`w-4.5 h-4.5 ${b.color}`} />
          </div>
          <div className="flex items-baseline gap-2 mb-1">
            <h3 className="text-sm font-bold text-foreground">{b.name}</h3>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{b.tag}</span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">{b.body}</p>
        </div>
      ))}
    </div>
  </section>
);

/* ─────────────────────────  Ecosystem grid (grouped, featured-first)  ───────────────────────── */

type Item = { icon: typeof Wallet; title: string; desc: string; link: string; external?: boolean; sameTab?: boolean; color: string; bg: string; badge?: string };

const GROUPS: { name: string; icon: typeof Wallet; items: Item[] }[] = [
  {
    name: "Use", icon: Wallet, items: [
      { icon: Wallet, title: "Web Wallet", desc: "Post-quantum wallet in the browser", link: "/wallet", color: "text-primary", bg: "bg-primary/10" },
      { icon: Smartphone, title: "Qwalla", desc: "Mobile wallet — now on iOS", link: QWALLA_SITE, external: true, sameTab: true, color: "text-success", bg: "bg-success/10" },
      { icon: MessageSquareLock, title: "Messenger", desc: "End-to-end encrypted chat", link: "/messenger", color: "text-success", bg: "bg-success/10" },
      { icon: MailIcon, title: "Mail", desc: "On-chain encrypted mail", link: "/mail", color: "text-accent", bg: "bg-accent/10" },
    ],
  },
  {
    name: "Trade", icon: ArrowDownUp, items: [
      { icon: ArrowDownUp, title: "Swap", desc: "On-chain token swaps", link: "/swap", color: "text-primary", bg: "bg-primary/10" },
      { icon: Cable, title: "Bridge", desc: "Move assets to/from Base", link: "/bridge", color: "text-accent", bg: "bg-accent/10" },
      { icon: Droplets, title: "Pools", desc: "Provide liquidity", link: "/pools", color: "text-blue-400", bg: "bg-blue-400/10" },
    ],
  },
  {
    name: "Build", icon: Wrench, items: [
      { icon: Code, title: "Smart Contracts", desc: "Deploy WASM contracts", link: "/contracts", color: "text-cyan-400", bg: "bg-cyan-400/10" },
      { icon: Coins, title: "Tokens", desc: "Launch custom tokens", link: "/tokens", color: "text-amber-400", bg: "bg-amber-400/10" },
      { icon: ImageIcon, title: "NFTs", desc: "RC-721 collections", link: "/nfts", color: "text-pink-400", bg: "bg-pink-400/10" },
      { icon: BookOpen, title: "SDK & Docs", desc: "@rougechain/sdk", link: `${DOCS}/advanced/sdk`, external: true, color: "text-primary", bg: "bg-primary/10" },
      { icon: Bot, title: "MCP Agents", desc: "AI-native integration", link: "/agents", color: "text-violet-400", bg: "bg-violet-400/10" },
    ],
  },
  {
    name: "Explore & participate", icon: Compass, items: [
      { icon: Activity, title: "Explorer", desc: "Blocks & transactions", link: "/blockchain", color: "text-primary", bg: "bg-primary/10" },
      { icon: Shield, title: "Validators", desc: "Stake & secure the chain", link: "/validators", color: "text-amber-400", bg: "bg-amber-400/10" },
      { icon: Server, title: "Run a Node", desc: "Node setup guide", link: `${DOCS}/running-a-node/`, external: true, color: "text-green-400", bg: "bg-green-400/10" },
      { icon: Github, title: "Source", desc: "MIT-licensed on GitHub", link: GITHUB, external: true, color: "text-foreground", bg: "bg-foreground/10" },
    ],
  },
];

// Featured: one strong pick per intent, shown before the full grid.
const FEATURED: Item[] = [
  GROUPS[0].items[0], // Web Wallet
  GROUPS[0].items[1], // Qwalla
  GROUPS[0].items[2], // Messenger
  GROUPS[1].items[0], // Swap
  GROUPS[2].items[0], // Smart Contracts
  GROUPS[3].items[0], // Explorer
];

const Card = ({ f }: { f: Item }) => {
  const inner = (
    <div className="group h-full p-4 rounded-xl bg-card border border-border hover:border-primary/40 transition-all duration-200 hover:shadow-md hover:shadow-primary/5">
      <div className={`w-10 h-10 rounded-lg ${f.bg} flex items-center justify-center mb-3 group-hover:scale-110 transition-transform`}>
        <f.icon className={`w-5 h-5 ${f.color}`} />
      </div>
      <h3 className="text-sm font-semibold text-foreground mb-0.5 flex items-center gap-1">
        {f.title}
        {f.external && <ExternalLink className="w-3 h-3 opacity-40" />}
      </h3>
      <p className="text-xs text-muted-foreground leading-tight">{f.desc}</p>
    </div>
  );
  const cls = "block h-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-xl";
  if (!f.external) return <Link to={f.link} className={cls}>{inner}</Link>;
  // sameTab links navigate the current window straight to the destination (more
  // reliable than target="_blank" inside in-app browsers/webviews).
  return f.sameTab
    ? <a href={f.link} className={cls}>{inner}</a>
    : <a href={f.link} target="_blank" rel="noopener noreferrer" className={cls}>{inner}</a>;
};

const EcosystemGrid = () => {
  const [showAll, setShowAll] = useState(false);
  return (
    <section id="ecosystem" className="mb-16 scroll-mt-20">
      <div className="mb-5">
        <h2 className="text-2xl font-bold text-foreground mb-1">Explore the ecosystem</h2>
        <p className="text-sm text-muted-foreground">Everything RougeChain enables — wallets, trading, building and exploring, all post-quantum.</p>
      </div>

      {!showAll ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {FEATURED.map(f => (
              <motion.div key={f.title} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
                <Card f={f} />
              </motion.div>
            ))}
          </div>
          <div className="text-center mt-5">
            <Button variant="outline" onClick={() => setShowAll(true)} className="gap-2">
              Show all apps <Boxes className="w-4 h-4" />
            </Button>
          </div>
        </>
      ) : (
        <div className="space-y-8">
          {GROUPS.map(g => (
            <div key={g.name}>
              <div className="flex items-center gap-2 mb-3">
                <g.icon className="w-4 h-4 text-primary" />
                <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{g.name}</h3>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {g.items.map(f => <Card key={f.title} f={f} />)}
              </div>
            </div>
          ))}
          <div className="text-center">
            <Button variant="ghost" size="sm" onClick={() => setShowAll(false)} className="text-muted-foreground">Show less</Button>
          </div>
        </div>
      )}
    </section>
  );
};

/* ─────────────────────────  Qwalla card  ───────────────────────── */

const QwallaCard = () => (
  <section className="mb-16">
    <div className="rounded-2xl overflow-hidden border border-success/30 bg-gradient-to-br from-success/10 via-card to-primary/10">
      <div className="grid md:grid-cols-2 gap-6 p-6 sm:p-8 items-center">
        <div>
          <div className="flex items-center gap-3 mb-3">
            <div className="w-12 h-12 rounded-2xl bg-success/15 border border-success/30 flex items-center justify-center text-2xl" aria-hidden>🐨</div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-foreground">Qwalla</h2>
                <span className="px-2 py-0.5 rounded-full bg-success/15 text-success text-[10px] font-mono font-bold border border-success/30">MOBILE</span>
              </div>
              <p className="text-xs text-muted-foreground">Post-quantum wallet for iOS</p>
            </div>
          </div>
          <p className="text-sm text-muted-foreground mb-4 max-w-md">
            Hold XRGE, send end-to-end encrypted chat and mail, and open on-chain apps from your phone — secured by ML-DSA-65 signing.
          </p>
          <div className="flex flex-wrap gap-2 mb-5">
            {["Send / Receive", "Encrypted Chats", "Encrypted Mail", "dApp Browser"].map(t => (
              <span key={t} className="px-2 py-0.5 rounded bg-card border border-border text-xs text-muted-foreground font-mono">{t}</span>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <a href={QWALLA_SITE} target="_blank" rel="noopener noreferrer">
              <Button className="gap-2 bg-success hover:bg-success/90 text-background font-semibold">
                <Smartphone className="w-4 h-4" /> Visit qwalla.io
                <ExternalLink className="w-4 h-4 opacity-70" />
              </Button>
            </a>
            <a href={QWALLA_APPSTORE} target="_blank" rel="noopener noreferrer">
              <Button variant="outline" className="gap-2 border-success/50 text-success hover:bg-success/10">
                <Smartphone className="w-4 h-4" /> Download on the App Store
                <ExternalLink className="w-4 h-4 opacity-70" />
              </Button>
            </a>
          </div>
          <p className="text-[11px] text-muted-foreground mt-3">Now <strong className="text-foreground">live on the App Store</strong> — always back up your recovery phrase.</p>
        </div>

        {/* Qwalla app screenshot (demo wallet) */}
        <div className="mx-auto w-full max-w-[220px]">
          <div className="relative rounded-[2rem] border border-border bg-background/60 p-2 shadow-xl">
            <img
              src={qwallaApp}
              alt="Qwalla mobile wallet — balance, quick actions and encrypted apps"
              className="rounded-[1.6rem] w-full object-cover object-top aspect-[9/19]"
              loading="lazy"
            />
          </div>
        </div>
      </div>
    </div>
  </section>
);

/* ─────────────────────────  Developer section  ───────────────────────── */

const DeveloperSection = () => {
  const links = [
    { icon: Terminal, title: "Quickstart", desc: "Run a node & first tx in ~5 min", link: `${DOCS}/getting-started/quick-start` },
    { icon: FileCode, title: "Example contract", desc: "ERC-20 template (WASM)", link: `${GITHUB}/tree/main/contracts/erc20_template` },
    { icon: BookOpen, title: "SDK & API docs", desc: "@rougechain/sdk + REST/gRPC", link: `${DOCS}/advanced/sdk` },
    { icon: Server, title: "Run a node / validator", desc: "Node setup & staking", link: `${DOCS}/running-a-node/` },
    { icon: Github, title: "GitHub", desc: "cyberdreadx/rougechain-node", link: GITHUB },
    { icon: Bot, title: "MCP server", desc: "@rougechain/mcp-server", link: `${DOCS}/advanced/mcp-server` },
  ];
  return (
    <section id="build" className="mb-16 scroll-mt-20">
      <div className="mb-5">
        <h2 className="text-2xl font-bold text-foreground mb-1">Build on RougeChain</h2>
        <p className="text-sm text-muted-foreground">Post-quantum primitives, a typed SDK, WASM contracts and an MCP integration for AI agents.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
        {links.map(l => (
          <a key={l.title} href={l.link} target="_blank" rel="noopener noreferrer"
             className="group p-4 rounded-xl bg-card border border-border hover:border-primary/40 transition-colors flex items-start gap-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary">
            <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <l.icon className="w-4.5 h-4.5 text-primary" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-1">{l.title}<ExternalLink className="w-3 h-3 opacity-40" /></h3>
              <p className="text-xs text-muted-foreground">{l.desc}</p>
            </div>
          </a>
        ))}
      </div>
    </section>
  );
};

/* ─────────────────────────  XRGE role + price (secondary)  ───────────────────────── */

const XrgeSection = () => {
  const { priceUsd, priceChange24h, volume24h, liquidity } = useXRGEPrice(60_000);
  return (
    <section className="mb-16">
      <div className="mb-5">
        <h2 className="text-2xl font-bold text-foreground mb-1">XRGE & the two networks</h2>
        <p className="text-sm text-muted-foreground">The same token lives in two places. Use the right one for each action.</p>
      </div>

      <div className="grid sm:grid-cols-2 gap-3 mb-6">
        <div className="p-4 rounded-xl bg-card border border-primary/20">
          <div className="flex items-center gap-2 mb-2">
            <Shield className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-bold text-foreground">Native XRGE — on RougeChain</h3>
          </div>
          <p className="text-xs text-muted-foreground">Pays fees & gas, is staked to run validators, and powers on-chain apps: swaps, contracts, tokens, messenger and mail.</p>
        </div>
        <div className="p-4 rounded-xl bg-card border border-accent/20">
          <div className="flex items-center gap-2 mb-2">
            <Coins className="w-4 h-4 text-accent" />
            <h3 className="text-sm font-bold text-foreground">XRGE (ERC-20) — on Base</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            Where you buy or trade XRGE today (e.g. on Aerodrome). <Link to="/bridge" className="text-primary hover:underline">Bridge</Link> it to RougeChain to use it natively.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <a href={AERODROME_BUY} target="_blank" rel="noopener noreferrer">
          <Button variant="outline" size="sm" className="gap-2 border-accent/50 text-accent hover:bg-accent/10">
            <ExternalLink className="w-4 h-4" /> Buy XRGE on Base
          </Button>
        </a>
        <Link to="/bridge">
          <Button variant="outline" size="sm" className="gap-2"><Cable className="w-4 h-4" /> Bridge to RougeChain</Button>
        </Link>
      </div>

      {/* Secondary: price chart */}
      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">XRGE price <span className="text-muted-foreground font-normal">· on Base</span></h3>
          </div>
          <div className="flex items-center gap-3">
            <a href={GECKOTERMINAL_POOL} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:text-primary/80 flex items-center gap-1">
              GeckoTerminal <ExternalLink className="w-3 h-3" />
            </a>
            <a href={DEXSCREENER} target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
              DexScreener <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>
        {priceUsd !== null && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4">
            <MiniStat label="Price" value={`$${priceUsd < 0.0001 ? priceUsd.toExponential(4) : priceUsd.toFixed(6)}`} />
            <MiniStat label="24h" value={priceChange24h !== null ? `${priceChange24h >= 0 ? "+" : ""}${priceChange24h.toFixed(2)}%` : "--"}
              tone={priceChange24h === null ? undefined : priceChange24h >= 0 ? "up" : "down"} />
            <MiniStat label="24h Volume" value={volume24h !== null ? formatUsd(volume24h) : "--"} />
            <MiniStat label="Liquidity" value={liquidity !== null ? formatUsd(liquidity) : "--"} />
          </div>
        )}
        <iframe
          src={`${GECKOTERMINAL_POOL}?embed=1&info=0&swaps=0&light_chart=0`}
          title="XRGE Price Chart (Base)"
          className="w-full h-[360px] border-0"
          allow="clipboard-write"
          allowFullScreen
        />
      </div>
    </section>
  );
};

const MiniStat = ({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) => (
  <div className="p-3 rounded-xl bg-background/40 border border-border">
    <p className="text-xs text-muted-foreground mb-1">{label}</p>
    <span className={`text-lg font-bold ${tone === "up" ? "text-success" : tone === "down" ? "text-destructive" : "text-foreground"}`}>{value}</span>
  </div>
);

/* ─────────────────────────  Security (accurate)  ───────────────────────── */

const SecuritySection = () => {
  const algos = [
    { name: "ML-DSA-65", use: "Digital signatures (formerly Dilithium)", std: "FIPS 204", color: "text-primary" },
    { name: "ML-KEM-768", use: "Key encapsulation (formerly Kyber)", std: "FIPS 203", color: "text-accent" },
    { name: "SHA-256", use: "Hashing for blocks & transactions", std: "FIPS 180-4", color: "text-success" },
  ];
  return (
    <section id="security" className="mb-16 rounded-2xl bg-gradient-to-br from-primary/5 to-accent/5 border border-border p-6 sm:p-8">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center"><Shield className="w-5 h-5 text-primary" /></div>
        <h2 className="text-xl font-bold text-foreground">Security</h2>
      </div>

      <div className="grid sm:grid-cols-3 gap-4 mb-6">
        {algos.map(a => (
          <div key={a.name} className="p-4 rounded-xl bg-background/50 border border-border">
            <Lock className={`w-5 h-5 ${a.color} mb-2`} />
            <h4 className="font-semibold text-foreground text-sm">{a.name}</h4>
            <p className="text-xs text-muted-foreground mb-2">{a.use}</p>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-card border border-border text-muted-foreground">{a.std}</span>
          </div>
        ))}
      </div>

      <div className="rounded-xl bg-background/40 border border-border p-4 text-xs text-muted-foreground leading-relaxed space-y-2">
        <p>
          RougeChain builds on these <strong className="text-foreground">NIST-standardized</strong> algorithms. NIST standardizes the
          primitives — it has not reviewed or certified RougeChain itself.
        </p>
        <p className="flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
          <span>
            <strong className="text-foreground">Audit status:</strong> the protocol and apps have <strong className="text-foreground">not yet had an independent third-party security audit</strong>.
            It’s an early network (currently a single public node). Use accordingly and keep your own backups.
          </span>
        </p>
        <p>
          Found a vulnerability? Please report it privately via{" "}
          <a href={`${GITHUB}/security/advisories/new`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">GitHub Security Advisories</a>{" "}
          rather than a public issue.
        </p>
      </div>
    </section>
  );
};

/* ─────────────────────────  Extension banner (reused)  ───────────────────────── */

const EXT_SCREENSHOTS = [
  { src: ss1, label: "Wallet" }, { src: ss2, label: "Messenger" }, { src: ss3, label: "Mail" },
  { src: ss4, label: "Tokens" }, { src: ss5, label: "Create Token" },
];

const ExtensionBanner = () => {
  const [active, setActive] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => setActive(i => (i + 1) % EXT_SCREENSHOTS.length), 3500);
  }, []);
  useEffect(() => { startTimer(); return () => { if (timerRef.current) clearInterval(timerRef.current); }; }, [startTimer]);
  const prev = () => { setActive(i => (i - 1 + EXT_SCREENSHOTS.length) % EXT_SCREENSHOTS.length); startTimer(); };
  const next = () => { setActive(i => (i + 1) % EXT_SCREENSHOTS.length); startTimer(); };

  return (
    <section className="mb-16">
      <div className="relative rounded-2xl overflow-hidden border border-accent/30 bg-gradient-to-br from-accent/10 via-card to-primary/10">
        <div className="absolute top-0 right-0 w-64 h-64 bg-accent/10 rounded-full blur-3xl pointer-events-none" />
        <div className="relative z-10 p-6 sm:p-8">
          <div className="flex flex-col sm:flex-row items-center gap-6 mb-6">
            <div className="flex-shrink-0 w-14 h-14 rounded-2xl bg-accent/20 border border-accent/30 flex items-center justify-center">
              <Chrome className="w-7 h-7 text-accent" />
            </div>
            <div className="flex-1 text-center sm:text-left">
              <div className="flex items-center justify-center sm:justify-start gap-2 mb-1">
                <h2 className="text-lg font-bold text-foreground">Browser Wallet Extension</h2>
                <span className="px-2 py-0.5 rounded-full bg-accent/20 text-accent text-xs font-mono font-bold border border-accent/30">FREE</span>
              </div>
              <p className="text-sm text-muted-foreground mb-3 max-w-lg">
                A quantum-safe wallet for Chrome, Edge, Brave, Firefox, Arc and Opera — send XRGE, sign transactions, and use encrypted chat and mail.
              </p>
              <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2">
                {["ML-DSA-65 Signing", "E2E Messenger", "PQC Mail", "Auto-lock Vault"].map(f => (
                  <span key={f} className="px-2 py-0.5 rounded bg-card border border-border text-xs text-muted-foreground font-mono">{f}</span>
                ))}
              </div>
            </div>
            <div className="flex-shrink-0 text-center">
              <a href="https://chromewebstore.google.com/detail/rougechain-wallet/ilkbgjgphhaolfdjkfefdfiifipmhakj" target="_blank" rel="noopener noreferrer">
                <Button size="lg" className="gap-2 bg-accent hover:bg-accent/90 text-accent-foreground font-semibold whitespace-nowrap">
                  <Chrome className="w-5 h-5" /> Add to browser <ExternalLink className="w-4 h-4 opacity-70" />
                </Button>
              </a>
              <p className="text-xs text-muted-foreground mt-2">Manifest V3 · 6 browsers</p>
            </div>
          </div>
          <div className="relative">
            <div className="relative overflow-hidden rounded-xl border border-border bg-card/50">
              <AnimatePresence mode="wait">
                <motion.img key={active} src={EXT_SCREENSHOTS[active].src} alt={`Extension screenshot: ${EXT_SCREENSHOTS[active].label}`}
                  initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -40 }} transition={{ duration: 0.3 }}
                  className="w-full h-56 sm:h-72 object-cover object-top" />
              </AnimatePresence>
              <button onClick={prev} aria-label="Previous screenshot" className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-background/80 border border-border flex items-center justify-center hover:bg-background transition-colors">
                <ChevronLeft className="w-4 h-4 text-foreground" />
              </button>
              <button onClick={next} aria-label="Next screenshot" className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-background/80 border border-border flex items-center justify-center hover:bg-background transition-colors">
                <ChevronRight className="w-4 h-4 text-foreground" />
              </button>
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-background/80 border border-border text-xs font-medium text-foreground backdrop-blur-sm">
                {EXT_SCREENSHOTS[active].label}
              </div>
            </div>
            <div className="flex justify-center gap-1.5 mt-3">
              {EXT_SCREENSHOTS.map((_, i) => (
                <button key={i} onClick={() => { setActive(i); startTimer(); }} aria-label={`Go to screenshot ${i + 1}`}
                  className={`h-1.5 rounded-full transition-all duration-300 ${i === active ? "w-6 bg-accent" : "w-1.5 bg-border hover:bg-muted-foreground"}`} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

/* ─────────────────────────  Page  ───────────────────────── */

const Index = () => {
  return (
    <div className="min-h-screen bg-background relative">
      <div className="fixed inset-0 circuit-bg opacity-20 pointer-events-none" />
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-[800px] h-[600px] bg-primary/5 rounded-full blur-3xl pointer-events-none" />

      <main className="relative z-10 max-w-4xl mx-auto px-4 py-10">

        {/* 1 · Hero — compact, primary actions above the fold */}
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="text-center mb-10">
          <div className="flex items-center justify-center gap-2 mb-5">
            <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary/15 text-primary text-xs font-bold font-mono border border-primary/30">
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" /> MAINNET LIVE
            </span>
          </div>

          <div className="mx-auto mb-5 w-16 h-16 rounded-full overflow-hidden border-2 border-primary/20 shadow-[0_0_24px_rgba(0,200,200,0.15)]">
            <img src={xrgeLogo} alt="RougeChain" className="w-full h-full object-cover rounded-full" />
          </div>

          <h1 className="text-4xl md:text-5xl font-bold text-foreground mb-4 text-balance">
            <span className="text-gradient-quantum">Post-quantum</span> from genesis.
          </h1>

          <p className="text-base text-muted-foreground max-w-xl mx-auto mb-7">
            RougeChain is a Layer 1 blockchain built around post-quantum cryptography.
            Explore wallets, messaging and on-chain applications, or build your own.
          </p>

          {/* Two primary actions */}
          <div className="flex items-center justify-center gap-3 flex-wrap mb-4">
            <Button size="lg" className="gap-2" onClick={scrollTo("ecosystem")}>
              <Boxes className="w-5 h-5" /> Explore the ecosystem
            </Button>
            <a href={`${DOCS}/getting-started/quick-start`} target="_blank" rel="noopener noreferrer">
              <Button size="lg" variant="outline" className="gap-2 border-primary/50 text-primary hover:bg-primary/10">
                <Code className="w-5 h-5" /> Build on RougeChain
              </Button>
            </a>
          </div>

          {/* Secondary links */}
          <div className="flex items-center justify-center gap-x-5 gap-y-2 flex-wrap text-sm">
            <a href={AERODROME_BUY} target="_blank" rel="noopener noreferrer" className="text-accent hover:text-accent/80 flex items-center gap-1">Buy XRGE <ExternalLink className="w-3.5 h-3.5" /></a>
            <a href="/RougeChain-Whitepaper.pdf" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground flex items-center gap-1">Whitepaper <ExternalLink className="w-3.5 h-3.5" /></a>
            <Link to="/blockchain" className="text-muted-foreground hover:text-foreground flex items-center gap-1">Explorer <ArrowRight className="w-3.5 h-3.5" /></Link>
          </div>
        </motion.div>

        {/* 2 · Brand relationship */}
        <BrandIntro />

        {/* 3 · Ecosystem (featured-first, grouped) */}
        <EcosystemGrid />

        {/* Regenerate — a core pillar, not a footnote */}
        <motion.section
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          className="mb-16"
        >
          <div className="relative overflow-hidden rounded-3xl border border-success/25 bg-gradient-to-br from-success/10 via-card to-accent/8 p-8 sm:p-10">
            <div
              className="pointer-events-none absolute inset-0 opacity-[0.08]"
              style={{ backgroundImage: "linear-gradient(hsl(var(--success)/0.5) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--success)/0.5) 1px, transparent 1px)", backgroundSize: "40px 40px" }}
              aria-hidden="true"
            />
            <div className="relative">
              <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-[0.2em] text-success">
                <Sprout className="w-4 h-4" /> RougeChain Regenerate
              </div>
              <h2 className="mt-4 text-2xl md:text-3xl font-bold text-foreground text-balance max-w-2xl">
                Technology should improve the territory it touches.
              </h2>
              <p className="mt-3 max-w-xl text-muted-foreground">
                A regeneration program &amp; treasury on RougeChain — funding transparent, measurable local projects. First territory: Tulum.
              </p>
              <div className="mt-6 flex flex-wrap items-center gap-3">
                <Link to="/regenerate">
                  <Button className="gap-2 bg-success hover:bg-success/90 text-background font-semibold">
                    <Sprout className="w-4 h-4" /> Explore Regenerate
                  </Button>
                </Link>
                <a href="https://discord.gg/wZKsHfhXxm" target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" className="gap-2 border-success/50 text-success hover:bg-success/10">
                    Propose a Project
                  </Button>
                </a>
              </div>
            </div>
          </div>
        </motion.section>

        {/* Product visuals */}
        <QwallaCard />
        <ExtensionBanner />

        {/* 4 · Developer entry points */}
        <DeveloperSection />

        {/* 5 · XRGE role + price (secondary) */}
        <XrgeSection />

        {/* 6 · Security + network status */}
        <SecuritySection />
        <NetworkStatus />

        {/* 7 · Community / resources */}
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-center">
          <div className="inline-flex flex-col items-center gap-3 p-6 rounded-2xl bg-gradient-to-r from-primary/5 via-transparent to-accent/5 border border-primary/20">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              <span className="text-sm font-mono text-primary">MAINNET IS LIVE</span>
            </div>
            <p className="text-muted-foreground text-sm max-w-md">
              Open a wallet, bridge assets from Base, or start building on a post-quantum Layer 1.
            </p>
            <div className="flex items-center gap-2 mt-1 flex-wrap justify-center">
              <Link to="/wallet"><Button size="sm" className="gap-2"><Wallet className="w-4 h-4" /> Open Wallet</Button></Link>
              <a href={`${DOCS}/getting-started/quick-start`} target="_blank" rel="noopener noreferrer">
                <Button size="sm" variant="outline" className="gap-2"><Code className="w-4 h-4" /> Quickstart</Button>
              </a>
              <a href={GITHUB} target="_blank" rel="noopener noreferrer">
                <Button size="sm" variant="outline" className="gap-2"><Github className="w-4 h-4" /> GitHub</Button>
              </a>
            </div>
          </div>
        </motion.div>

        {/* Own the audience — email capture (Netlify Forms) */}
        <EmailCaptureBanner />
        <EmailCapturePopup />
      </main>
    </div>
  );
};

export default Index;
