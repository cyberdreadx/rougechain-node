import { motion, AnimatePresence } from "framer-motion";
import { Link } from "react-router-dom";
import { Network, Wallet, MessageSquareLock, Shield, Lock, Activity, Zap, ExternalLink, TrendingUp, TrendingDown, ArrowDownUp, Droplets, Coins, Image, Cable, Mail as MailIcon, Server, Github, Chrome, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEffect, useState, useCallback, useRef } from "react";
import { getCoreApiBaseUrl, getCoreApiHeaders } from "@/lib/network";
import { useBlockchainWs } from "@/hooks/use-blockchain-ws";
import { useXRGEPrice } from "@/hooks/use-xrge-price";
import { formatUsd } from "@/lib/price-service";
import xrgeLogo from "@/assets/xrge-logo.webp";

// Live Network Status Component
const LiveNetworkStatus = () => {
  const [stats, setStats] = useState<{ height: number; peers: number; isLive: boolean } | null>(null);
  const [pulseKey, setPulseKey] = useState(0);

  const fetchStats = useCallback(async () => {
    try {
      const baseUrl = getCoreApiBaseUrl();
      if (!baseUrl) return;

      const res = await fetch(`${baseUrl}/stats`, {
        headers: getCoreApiHeaders(),
        signal: AbortSignal.timeout(3000),
      });

      if (res.ok) {
        const data = await res.json();
        const newHeight = data.network_height || data.networkHeight || 0;

        setStats(prev => {
          // Trigger pulse animation on new block
          if (prev && newHeight > prev.height && prev.height > 0) {
            setPulseKey(k => k + 1);
          }
          return {
            height: newHeight,
            peers: data.connected_peers || data.connectedPeers || 0,
            isLive: true,
          };
        });
      }
    } catch {
      setStats(prev => prev ? { ...prev, isLive: false } : null);
    }
  }, []);

  // WebSocket for real-time updates
  const handleNewBlock = useCallback(() => {
    fetchStats();
    setPulseKey(k => k + 1);
  }, [fetchStats]);

  const { connectionType } = useBlockchainWs({
    onNewBlock: handleNewBlock,
    fallbackPollInterval: 10000,
  });

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  if (!stats) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-wrap items-center justify-center gap-3 sm:gap-6 mb-8"
    >
      <div className="flex items-center gap-3 px-4 py-2 rounded-lg bg-black/40 border border-primary/30 backdrop-blur-sm">
        <div className="relative">
          <motion.div
            key={pulseKey}
            initial={{ scale: 1, opacity: 0.8 }}
            animate={{ scale: 2.5, opacity: 0 }}
            transition={{ duration: 1, ease: "easeOut" }}
            className="absolute inset-0 rounded-full bg-primary"
          />
          <div className={`w-3 h-3 rounded-full ${stats.isLive ? 'bg-primary animate-pulse' : 'bg-gray-500'}`} />
        </div>

        <div className="flex items-center gap-4 text-sm font-mono">
          <div className="flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-primary" />
            <span className="text-primary/80">TESTNET</span>
          </div>

          <div className="h-4 w-px bg-primary/30" />

          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground text-xs">BLOCK</span>
            <motion.span
              key={stats.height}
              initial={{ opacity: 0, y: -5 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-white font-bold"
            >
              #{stats.height.toLocaleString()}
            </motion.span>
          </div>

          <div className="h-4 w-px bg-primary/30" />

          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground text-xs">PEERS</span>
            <span className="text-accent font-bold">{stats.peers}</span>
          </div>
        </div>
      </div>
    </motion.div>
  );
};

const LiveFeatureGrid = () => {
  const [stats, setStats] = useState<{
    txCount: number;
    blockHeight: number;
    poolCount: number;
    tokenCount: number;
    nftCount: number;
    validatorCount: number;
  }>({ txCount: 0, blockHeight: 0, poolCount: 0, tokenCount: 0, nftCount: 0, validatorCount: 0 });

  useEffect(() => {
    const fetchAll = async () => {
      const base = getCoreApiBaseUrl();
      if (!base) return;
      const h = getCoreApiHeaders();
      const fetches = await Promise.allSettled([
        fetch(`${base}/stats`, { headers: h, signal: AbortSignal.timeout(4000) }).then(r => r.json()),
        fetch(`${base}/pools`, { headers: h, signal: AbortSignal.timeout(4000) }).then(r => r.json()),
        fetch(`${base}/tokens`, { headers: h, signal: AbortSignal.timeout(4000) }).then(r => r.json()),
        fetch(`${base}/nft/collections`, { headers: h, signal: AbortSignal.timeout(4000) }).then(r => r.json()),
        fetch(`${base}/validators`, { headers: h, signal: AbortSignal.timeout(4000) }).then(r => r.json()),
      ]);
      const s = fetches[0].status === "fulfilled" ? fetches[0].value : {};
      const p = fetches[1].status === "fulfilled" ? fetches[1].value : {};
      const t = fetches[2].status === "fulfilled" ? fetches[2].value : {};
      const n = fetches[3].status === "fulfilled" ? fetches[3].value : {};
      const v = fetches[4].status === "fulfilled" ? fetches[4].value : {};
      setStats({
        blockHeight: s.network_height || s.networkHeight || 0,
        txCount: s.total_fees_collected ? Math.round(s.total_fees_collected / 0.1) : 0,
        poolCount: (p.pools || p.success && p.pools || []).length || 0,
        tokenCount: (t.tokens || []).length || 0,
        nftCount: (n.collections || []).length || 0,
        validatorCount: Array.isArray(v) ? v.length : (v.validators || []).length,
      });
    };
    fetchAll();
  }, []);

  const features = [
    { icon: Wallet, title: "Wallet", desc: "Quantum-safe wallet", stat: null, link: "/wallet", color: "text-primary", bg: "bg-primary/10" },
    { icon: ArrowDownUp, title: "Swap", desc: "Instant token swaps", stat: null, link: "/swap", color: "text-primary", bg: "bg-primary/10" },
    { icon: Cable, title: "Bridge", desc: "ETH to XRGE bridge", stat: null, link: "/bridge", color: "text-accent", bg: "bg-accent/10" },
    { icon: Droplets, title: "Pools", desc: "Liquidity pools", stat: stats.poolCount > 0 ? `${stats.poolCount} pool${stats.poolCount !== 1 ? "s" : ""}` : null, link: "/pools", color: "text-blue-400", bg: "bg-blue-400/10" },
    { icon: Coins, title: "Tokens", desc: "Custom tokens", stat: stats.tokenCount > 0 ? `${stats.tokenCount} token${stats.tokenCount !== 1 ? "s" : ""}` : null, link: "/tokens", color: "text-amber-400", bg: "bg-amber-400/10" },
    { icon: Image, title: "NFTs", desc: "RC-721 collections", stat: stats.nftCount > 0 ? `${stats.nftCount} collection${stats.nftCount !== 1 ? "s" : ""}` : null, link: "/nfts", color: "text-pink-400", bg: "bg-pink-400/10" },
    { icon: Activity, title: "Explorer", desc: "Blocks & transactions", stat: stats.blockHeight > 0 ? `${stats.blockHeight.toLocaleString()} blocks` : null, link: "/blockchain", color: "text-primary", bg: "bg-primary/10" },
    { icon: MessageSquareLock, title: "Messenger", desc: "E2E encrypted chat", stat: null, link: "/messenger", color: "text-success", bg: "bg-success/10" },
    { icon: MailIcon, title: "Mail", desc: "On-chain encrypted mail", stat: null, link: "/mail", color: "text-accent", bg: "bg-accent/10" },
    { icon: Shield, title: "Validators", desc: "Stake & validate", stat: stats.validatorCount > 0 ? `${stats.validatorCount} active` : null, link: "/validators", color: "text-amber-400", bg: "bg-amber-400/10" },
    { icon: Server, title: "Run a Node", desc: "Strengthen the network", stat: null, link: "/validators", color: "text-green-400", bg: "bg-green-400/10" },
    { icon: Github, title: "Open Source", desc: "Apache 2.0 licensed", stat: null, link: "https://github.com/cyberdreadx/rougechain-node", color: "text-foreground", bg: "bg-foreground/10", external: true },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 mb-16">
      {features.map((f, i) => {
        const card = (
          <div className="group h-full p-4 rounded-xl bg-card border border-border hover:border-primary/40 transition-all duration-200 hover:shadow-md hover:shadow-primary/5">
            <div className={`w-10 h-10 rounded-lg ${f.bg} flex items-center justify-center mb-3 group-hover:scale-110 transition-transform`}>
              <f.icon className={`w-5 h-5 ${f.color}`} />
            </div>
            <h3 className="text-sm font-semibold text-foreground mb-0.5 flex items-center gap-1">
              {f.title}
              {"external" in f && f.external && <ExternalLink className="w-3 h-3 opacity-40" />}
            </h3>
            <p className="text-xs text-muted-foreground leading-tight">{f.desc}</p>
            {f.stat && (
              <p className="text-xs font-mono text-primary mt-2">{f.stat}</p>
            )}
          </div>
        );
        return (
          <motion.div
            key={f.title}
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 + i * 0.03 }}
          >
            {"external" in f && f.external ? (
              <a href={f.link} target="_blank" rel="noopener noreferrer">{card}</a>
            ) : (
              <Link to={f.link}>{card}</Link>
            )}
          </motion.div>
        );
      })}
    </div>
  );
};

const Index = () => {
  // Fetch live XRGE price
  const { priceUsd, priceChange24h, volume24h, liquidity, loading: priceLoading } = useXRGEPrice(60_000);

  return (
    <div className="min-h-screen bg-background relative overflow-hidden">

      {/* Background effects */}
      <div className="fixed inset-0 circuit-bg opacity-20 pointer-events-none" />
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-0 right-0 w-full max-w-[600px] h-[600px] bg-accent/5 rounded-full blur-3xl pointer-events-none" />

      <main className="relative z-10 max-w-4xl mx-auto px-4 py-12">

        {/* Testnet Banner */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex justify-center mb-6"
        >
          <div className="inline-flex items-center gap-3 px-4 py-2 rounded-full bg-gradient-to-r from-primary/10 via-accent/10 to-primary/10 border border-primary/30">
            <span className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-primary/20 text-primary text-xs font-bold font-mono">
              TESTNET LIVE
            </span>
            <span className="text-sm text-muted-foreground">
              Mainnet launch coming soon
            </span>
            <span className="text-accent animate-pulse">→</span>
          </div>
        </motion.div>

        {/* Live Network Status */}
        <LiveNetworkStatus />

        {/* Hero */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-16"
        >
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.1 }}
            className="mx-auto mb-6 w-24 h-24 rounded-full overflow-hidden border-2 border-primary/20 shadow-[0_0_30px_rgba(0,200,200,0.15)]"
          >
            <img
              src={xrgeLogo}
              alt="XRGE"
              className="w-full h-full object-cover rounded-full animate-jelly"
            />
          </motion.div>

          <h1 className="text-4xl md:text-5xl font-bold text-foreground mb-4">
            Welcome to{" "}
            <span className="text-gradient-quantum">RougeChain</span>
          </h1>

          <p className="text-lg text-muted-foreground max-w-2xl mx-auto mb-4">
            An open-source, post-quantum Layer 1 blockchain with ML-DSA signatures, Rust core, and modern UI.
          </p>

          <p className="text-sm text-primary/80 max-w-xl mx-auto mb-8 font-mono">
            Join the testnet now - create a wallet, claim XRGE, and help stress-test the network before mainnet.
          </p>

          <div className="flex items-center justify-center gap-3 flex-wrap">
            <Link to="/wallet">
              <Button size="lg" className="gap-2">
                <Wallet className="w-5 h-5" />
                Open Wallet
              </Button>
            </Link>
            <a
              href="https://chromewebstore.google.com/detail/rougechain-wallet/ilkbgjgphhaolfdjkfefdfiifipmhakj"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button size="lg" variant="outline" className="gap-2 border-accent/50 text-accent hover:bg-accent/10">
                <Chrome className="w-5 h-5" />
                Get Extension
              </Button>
            </a>
            <a
              href="https://aerodrome.finance/swap?from=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913&to=0x147120faec9277ec02d957584cfcd92b56a24317&chain0=8453&chain1=8453"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button size="lg" variant="outline" className="gap-2 border-primary/50 text-primary hover:bg-primary/10">
                <ExternalLink className="w-5 h-5" />
                Buy XRGE
              </Button>
            </a>
            <Link to="/node">
              <Button size="lg" variant="outline" className="gap-2">
                <Network className="w-5 h-5" />
                View Core Node
              </Button>
            </Link>
          </div>
        </motion.div>

        {/* Feature Cards */}
        <LiveFeatureGrid />

        {/* Browser Extension Promo Banner */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35 }}
          className="mb-16"
        >
          <div className="relative rounded-2xl overflow-hidden border border-accent/30 bg-gradient-to-br from-accent/10 via-card to-primary/10">
            {/* Glow blobs */}
            <div className="absolute top-0 right-0 w-64 h-64 bg-accent/10 rounded-full blur-3xl pointer-events-none" />
            <div className="absolute bottom-0 left-0 w-48 h-48 bg-primary/10 rounded-full blur-3xl pointer-events-none" />

            <div className="relative z-10 flex flex-col sm:flex-row items-center gap-6 p-6 sm:p-8">
              {/* Icon */}
              <div className="flex-shrink-0 w-16 h-16 rounded-2xl bg-accent/20 border border-accent/30 flex items-center justify-center shadow-lg shadow-accent/10">
                <Chrome className="w-8 h-8 text-accent" />
              </div>

              {/* Text */}
              <div className="flex-1 text-center sm:text-left">
                <div className="flex items-center justify-center sm:justify-start gap-2 mb-1">
                  <h2 className="text-lg font-bold text-foreground">RougeChain Wallet Extension</h2>
                  <span className="px-2 py-0.5 rounded-full bg-accent/20 text-accent text-xs font-mono font-bold border border-accent/30">FREE</span>
                </div>
                <p className="text-sm text-muted-foreground mb-3 max-w-lg">
                  Your quantum-safe browser wallet. Send XRGE, chat with end-to-end encryption, access encrypted mail, and sign transactions — all from Chrome, Edge, Brave, Firefox, Arc, or Opera.
                </p>
                <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2 mb-3">
                  {["ML-DSA-65 Signing", "E2E Messenger", "PQC Mail", "Auto-lock Vault"].map(f => (
                    <span key={f} className="px-2 py-0.5 rounded bg-card border border-border text-xs text-muted-foreground font-mono">
                      {f}
                    </span>
                  ))}
                </div>
                {/* Browser compatibility badges */}
                <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2">
                  {[
                    {
                      name: "Chrome",
                      icon: (
                        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
                          <path d="M12 0C8.21 0 4.831 1.757 2.632 4.501l3.953 6.848A5.454 5.454 0 0 1 12 6.545h10.691A12 12 0 0 0 12 0zM1.931 5.47A11.943 11.943 0 0 0 0 12c0 6.012 4.42 10.991 10.189 11.864l3.953-6.847a5.45 5.45 0 0 1-6.865-2.29zm13.342 2.166a5.446 5.446 0 0 1 1.45 7.09l.002.001h-.002l-5.344 9.257c.206.01.413.016.621.016 6.627 0 12-5.373 12-12 0-1.54-.29-3.011-.818-4.364zM12 10.545a1.455 1.455 0 1 0 0 2.91 1.455 1.455 0 0 0 0-2.91z"/>
                        </svg>
                      ),
                      color: "text-yellow-400",
                    },
                    {
                      name: "Edge",
                      icon: (
                        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
                          <path d="M21.86 17.86A10.29 10.29 0 0 1 12 22.29a10.25 10.25 0 0 1-7.17-2.9c-.94-.9-.21-2.3 1.03-2.16a5.98 5.98 0 0 0 5.68-1.93H6.75a.75.75 0 0 1-.68-1.07l.88-1.9a6 6 0 0 0-1.32-6.7C4.2 4.3 3.67 2.13 5.56 1.28A11.97 11.97 0 0 1 12 0c5.65 0 10.42 3.9 11.66 9.15.35 1.5.28 2.75-.14 3.9h-9.4a3 3 0 0 0 2.83 2H21a.75.75 0 0 1 .68 1.07l-.88 1.9z"/>
                        </svg>
                      ),
                      color: "text-blue-400",
                    },
                    {
                      name: "Brave",
                      icon: (
                        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
                          <path d="M20.443 8.29l.398-1.56-1.032-.93.084-.61-1.873-.437-.73 1.097-1.048.11-.26-.765-2.25-.437-.366.492-.366-.492-2.25.437-.26.765-1.048-.11-.73-1.097-1.873.437.084.61-1.032.93.398 1.56-.61.992.526 1.42-.26.798.786 1.15v1.1l-.787.593.262.83-.507.655.13.961 1.61 1.066.323.93 1.005.13.548.767h1.31l.548-.768 1.005-.13.323-.93 1.61-1.065.13-.961-.507-.655.262-.83-.787-.593v-1.1l.786-1.15-.26-.798.526-1.42-.61-.992z"/>
                        </svg>
                      ),
                      color: "text-orange-400",
                    },
                    {
                      name: "Firefox",
                      icon: (
                        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
                          <path d="M21.805 7.32c-.24-.56-.795-1.43-1.21-1.75.34.66.535 1.345.615 1.96-.895-2.22-2.41-3.115-3.63-5.06-.065-.1-.13-.2-.19-.31-.035-.06-.065-.12-.09-.18a1.56 1.56 0 0 1-.13-.49.03.03 0 0 0-.025-.03.04.04 0 0 0-.025.005c-.005 0-.005.005-.01.005l.005-.01C14.24.46 11.76-.445 9.47.21 7.62.735 6.08 1.87 5.015 3.395a9.17 9.17 0 0 1 3.455-.495c1.315.065 2.565.455 3.65 1.13-.625-.065-1.255-.055-1.87.025-2.185.27-4.2 1.45-5.465 3.235a7.84 7.84 0 0 0-1.03 2.185c-.41 1.39-.37 2.78.025 4.125C4.27 16.385 6.59 19.075 9.73 20.24c2.94 1.08 6.395.725 8.995-1.055 2.895-1.98 4.415-5.41 3.825-8.895a7.83 7.83 0 0 0-.745-2.97z"/>
                        </svg>
                      ),
                      color: "text-orange-500",
                    },
                    {
                      name: "Arc",
                      icon: (
                        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
                          <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm4.5 14.5l-9-9 1.414-1.414 9 9L16.5 16.5z"/>
                        </svg>
                      ),
                      color: "text-purple-400",
                    },
                    {
                      name: "Opera",
                      icon: (
                        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
                          <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm0 2.824c1.508 0 2.93.39 4.166 1.072C14.848 5.235 13.944 7.383 13.944 12s.904 6.765 2.222 8.104A9.158 9.158 0 0 1 12 21.176 9.176 9.176 0 0 1 2.824 12 9.176 9.176 0 0 1 12 2.824zm0 1.37C9.298 4.194 7.15 7.755 7.15 12s2.148 7.806 4.85 7.806c2.703 0 4.85-3.561 4.85-7.806S14.703 4.194 12 4.194z"/>
                        </svg>
                      ),
                      color: "text-red-400",
                    },
                  ].map(b => (
                    <span key={b.name} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-card border border-border text-xs text-muted-foreground hover:border-accent/40 transition-colors">
                      <span className={b.color}>{b.icon}</span>
                      {b.name}
                    </span>
                  ))}
                </div>
              </div>

              {/* CTA */}
              <div className="flex-shrink-0">
                <a
                  href="https://chromewebstore.google.com/detail/rougechain-wallet/ilkbgjgphhaolfdjkfefdfiifipmhakj"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Button size="lg" className="gap-2 bg-accent hover:bg-accent/90 text-accent-foreground shadow-lg shadow-accent/20 font-semibold whitespace-nowrap">
                    <Chrome className="w-5 h-5" />
                    Add to Chrome
                    <ExternalLink className="w-4 h-4 opacity-70" />
                  </Button>
                </a>
                <p className="text-xs text-muted-foreground text-center mt-2">Manifest V3 · 6 browsers</p>
              </div>
            </div>
          </div>
        </motion.div>

        {/* XRGE Chart Section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="mb-16"
        >
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                <TrendingUp className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-foreground">XRGE Price</h2>
                <p className="text-xs text-muted-foreground">Live chart from DexScreener</p>
              </div>
            </div>
            <a
              href="https://dexscreener.com/base/0x147120faec9277ec02d957584cfcd92b56a24317"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:text-primary/80 flex items-center gap-1"
            >
              View on DexScreener
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>

          {/* Live Price Stats */}
          {priceUsd !== null && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4"
            >
              <div className="p-3 rounded-xl bg-card border border-border">
                <p className="text-xs text-muted-foreground mb-1">Price (Base)</p>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold text-foreground">
                    ${priceUsd < 0.0001 ? priceUsd.toExponential(4) : priceUsd.toFixed(6)}
                  </span>
                </div>
              </div>
              <div className="p-3 rounded-xl bg-card border border-border">
                <p className="text-xs text-muted-foreground mb-1">24h Change</p>
                <div className="flex items-center gap-1">
                  {priceChange24h !== null && (
                    <>
                      {priceChange24h >= 0 ? (
                        <TrendingUp className="w-4 h-4 text-success" />
                      ) : (
                        <TrendingDown className="w-4 h-4 text-destructive" />
                      )}
                      <span className={`text-lg font-bold ${priceChange24h >= 0 ? 'text-success' : 'text-destructive'}`}>
                        {priceChange24h >= 0 ? '+' : ''}{priceChange24h.toFixed(2)}%
                      </span>
                    </>
                  )}
                </div>
              </div>
              <div className="p-3 rounded-xl bg-card border border-border">
                <p className="text-xs text-muted-foreground mb-1">24h Volume</p>
                <span className="text-lg font-bold text-foreground">
                  {volume24h !== null ? formatUsd(volume24h) : '--'}
                </span>
              </div>
              <div className="p-3 rounded-xl bg-card border border-border">
                <p className="text-xs text-muted-foreground mb-1">Liquidity</p>
                <span className="text-lg font-bold text-foreground">
                  {liquidity !== null ? formatUsd(liquidity) : '--'}
                </span>
              </div>
            </motion.div>
          )}

          <div className="rounded-2xl border border-border overflow-hidden bg-card">
            <iframe
              src="https://dexscreener.com/base/0x147120faec9277ec02d957584cfcd92b56a24317?embed=1&theme=dark&trades=0&info=0"
              title="XRGE Price Chart"
              className="w-full h-[400px] border-0"
              allow="clipboard-write"
              allowFullScreen
            />
          </div>
        </motion.div>

        {/* Security Section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
          className="rounded-2xl bg-gradient-to-br from-primary/5 to-accent/5 border border-border p-8"
        >
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <Shield className="w-5 h-5 text-primary" />
            </div>
            <h2 className="text-xl font-bold text-foreground">Quantum Security Stack</h2>
          </div>

          <div className="grid sm:grid-cols-3 gap-4">
            <div className="p-4 rounded-xl bg-background/50 border border-border">
              <Lock className="w-5 h-5 text-primary mb-2" />
              <h4 className="font-semibold text-foreground text-sm">ML-DSA-65</h4>
              <p className="text-xs text-muted-foreground">Digital signatures (Dilithium)</p>
            </div>
            <div className="p-4 rounded-xl bg-background/50 border border-border">
              <Lock className="w-5 h-5 text-accent mb-2" />
              <h4 className="font-semibold text-foreground text-sm">ML-KEM-768</h4>
              <p className="text-xs text-muted-foreground">Key encapsulation (Kyber)</p>
            </div>
            <div className="p-4 rounded-xl bg-background/50 border border-border">
              <Lock className="w-5 h-5 text-success mb-2" />
              <h4 className="font-semibold text-foreground text-sm">SHA-256</h4>
              <p className="text-xs text-muted-foreground">Hashing for blocks and transactions</p>
            </div>
          </div>

          <p className="text-xs text-muted-foreground mt-4 text-center">
            All algorithms are NIST FIPS 203/204 approved standards
          </p>
        </motion.div>

        {/* Footer CTA */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6 }}
          className="mt-16 text-center"
        >
            <div className="inline-flex flex-col items-center gap-3 p-6 rounded-2xl bg-gradient-to-r from-primary/5 via-transparent to-accent/5 border border-primary/20">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              <span className="text-sm font-mono text-primary">TESTNET IS LIVE</span>
            </div>
            <p className="text-muted-foreground text-sm max-w-md">
              RougeChain testnet is open for testing. Create a wallet, request tokens from the faucet,
              and help us battle-test the network before mainnet launch.
            </p>
            <div className="flex items-center gap-2 mt-2">
              <Link to="/wallet">
                <Button size="sm" className="gap-2">
                  <Wallet className="w-4 h-4" />
                  Get Started
                </Button>
              </Link>
              <Link to="/blockchain">
                <Button size="sm" variant="outline" className="gap-2">
                  <Activity className="w-4 h-4" />
                  Explore Blocks
                </Button>
              </Link>
            </div>
          </div>
        </motion.div>
      </main>
    </div>
  );
};

export default Index;
