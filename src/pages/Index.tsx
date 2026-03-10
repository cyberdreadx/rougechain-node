import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { Network, Wallet, MessageSquareLock, Shield, Lock, Activity, Zap, ExternalLink, TrendingUp, TrendingDown, ArrowDownUp, Droplets, Coins, Image, Cable, Mail as MailIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEffect, useState, useCallback } from "react";
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
      className="flex items-center justify-center gap-6 mb-8"
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
    { icon: Network, title: "Core Node", desc: "Node dashboard", stat: null, link: "/node", color: "text-primary", bg: "bg-primary/10" },
    { icon: Activity, title: "Tx Feed", desc: "Live transactions", stat: null, link: "/transactions", color: "text-accent", bg: "bg-accent/10" },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 mb-16">
      {features.map((f, i) => (
        <motion.div
          key={f.title}
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 + i * 0.03 }}
        >
          <Link to={f.link}>
            <div className="group h-full p-4 rounded-xl bg-card border border-border hover:border-primary/40 transition-all duration-200 hover:shadow-md hover:shadow-primary/5">
              <div className={`w-10 h-10 rounded-lg ${f.bg} flex items-center justify-center mb-3 group-hover:scale-110 transition-transform`}>
                <f.icon className={`w-5 h-5 ${f.color}`} />
              </div>
              <h3 className="text-sm font-semibold text-foreground mb-0.5">{f.title}</h3>
              <p className="text-xs text-muted-foreground leading-tight">{f.desc}</p>
              {f.stat && (
                <p className="text-xs font-mono text-primary mt-2">{f.stat}</p>
              )}
            </div>
          </Link>
        </motion.div>
      ))}
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
            A post-quantum Layer 1 blockchain with ML-DSA signatures, Rust core, and modern UI.
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
