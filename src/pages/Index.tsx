import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { Network, Wallet, MessageSquareLock, Shield, Lock, Activity, Zap, ExternalLink, TrendingUp, TrendingDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEffect, useState, useCallback } from "react";
import { getCoreApiBaseUrl, getCoreApiHeaders } from "@/lib/network";
import { useBlockchainWs } from "@/hooks/use-blockchain-ws";
import { useXRGEPrice } from "@/hooks/use-xrge-price";
import { formatUsd } from "@/lib/price-service";
import xrgeLogo from "@/assets/xrge-logo.webp";

const features = [
  {
    icon: Wallet,
    title: "XRGE Wallet",
    description: "Create a quantum-safe wallet, claim XRGE tokens, and send transactions on RougeChain.",
    link: "/wallet",
    color: "primary",
  },
  {
    icon: Activity,
    title: "Transaction Feed",
    description: "Track live transactions and block inclusion in real time.",
    link: "/transactions",
    color: "accent",
  },
  {
    icon: Network,
    title: "Core Node",
    description: "Monitor the Rust core daemon, health checks, and live chain stats.",
    link: "/node",
    color: "accent",
  },
  {
    icon: MessageSquareLock,
    title: "Secure Messenger",
    description: "End-to-end encrypted messaging with ML-KEM key exchange and quantum-safe signatures.",
    link: "/messenger",
    color: "success",
  },
];

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
      <div className="flex items-center gap-3 px-4 py-2 rounded-lg bg-black/40 border border-red-500/30 backdrop-blur-sm">
        {/* Animated pulse ring */}
        <div className="relative">
          <motion.div
            key={pulseKey}
            initial={{ scale: 1, opacity: 0.8 }}
            animate={{ scale: 2.5, opacity: 0 }}
            transition={{ duration: 1, ease: "easeOut" }}
            className="absolute inset-0 rounded-full bg-red-500"
          />
          <div className={`w-3 h-3 rounded-full ${stats.isLive ? 'bg-red-500 animate-pulse' : 'bg-gray-500'}`} />
        </div>
        
        <div className="flex items-center gap-4 text-sm font-mono">
          <div className="flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-red-400" />
            <span className="text-red-400/80">TESTNET</span>
          </div>
          
          <div className="h-4 w-px bg-red-500/30" />
          
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
          
          <div className="h-4 w-px bg-red-500/30" />
          
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground text-xs">PEERS</span>
            <span className="text-fuchsia-400 font-bold">{stats.peers}</span>
          </div>
        </div>
      </div>
    </motion.div>
  );
};

const Index = () => {
  // Fetch live XRGE price
  const { priceUsd, priceChange24h, volume24h, liquidity, loading: priceLoading } = useXRGEPrice(60_000);

  return (
    <div className="min-h-screen bg-background relative overflow-hidden">
      
      {/* Background effects */}
      <div className="fixed inset-0 circuit-bg opacity-20 pointer-events-none" />
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[800px] h-[800px] bg-red-500/5 rounded-full blur-3xl pointer-events-none" />
      <div className="fixed bottom-0 right-0 w-[600px] h-[600px] bg-fuchsia-500/5 rounded-full blur-3xl pointer-events-none" />

      <main className="relative z-10 max-w-4xl mx-auto px-4 py-12">
        
        {/* Testnet Banner */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex justify-center mb-6"
        >
          <div className="inline-flex items-center gap-3 px-4 py-2 rounded-full bg-gradient-to-r from-red-500/10 via-fuchsia-500/10 to-red-500/10 border border-red-500/30">
            <span className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-red-500/20 text-red-400 text-xs font-bold font-mono">
              TESTNET LIVE
            </span>
            <span className="text-sm text-muted-foreground">
              Mainnet launch coming soon
            </span>
            <span className="text-fuchsia-400 animate-pulse">→</span>
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
          <motion.img
            src={xrgeLogo}
            alt="XRGE"
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.1 }}
            className="w-24 h-24 mx-auto mb-6 rounded-full shadow-lg shadow-red-500/20 ring-2 ring-red-500/20"
          />

          <h1 className="text-4xl md:text-5xl font-bold text-foreground mb-4">
            Welcome to{" "}
            <span className="text-gradient-quantum">RougeChain</span>
          </h1>
          
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto mb-4">
            A post-quantum Layer 1 blockchain with ML-DSA signatures, Rust core, and modern UI.
          </p>
          
          <p className="text-sm text-red-400/80 max-w-xl mx-auto mb-8 font-mono">
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
              <Button size="lg" variant="outline" className="gap-2 border-red-500/50 text-red-400 hover:bg-red-500/10 hover:text-red-300">
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
        <div className="grid md:grid-cols-3 gap-6 mb-16">
          {features.map((feature, index) => (
            <motion.div
              key={feature.title}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 + index * 0.1 }}
            >
              <Link to={feature.link}>
                <div className="group h-full p-6 rounded-2xl bg-card border border-border hover:border-primary/50 transition-all duration-300 hover:shadow-lg hover:shadow-primary/5">
                  <div className={`w-12 h-12 rounded-xl bg-${feature.color}/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform`}>
                    <feature.icon className={`w-6 h-6 text-${feature.color}`} />
                  </div>
                  <h3 className="text-lg font-semibold text-foreground mb-2">{feature.title}</h3>
                  <p className="text-sm text-muted-foreground">{feature.description}</p>
                </div>
              </Link>
            </motion.div>
          ))}
        </div>

        {/* XRGE Chart Section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="mb-16"
        >
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-500/10 flex items-center justify-center">
                <TrendingUp className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-foreground">XRGE Price</h2>
                <p className="text-xs text-muted-foreground">Live chart from GeckoTerminal</p>
              </div>
            </div>
            <a 
              href="https://www.geckoterminal.com/base/pools/0x059e10d26c64a63d04e1814f46305210eddc447d" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-xs text-red-400 hover:text-red-300 flex items-center gap-1"
            >
              View on GeckoTerminal
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
              <div className="p-3 rounded-xl bg-black/40 border border-red-500/20">
                <p className="text-xs text-muted-foreground mb-1">Price (Base)</p>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold text-foreground">
                    ${priceUsd < 0.0001 ? priceUsd.toExponential(4) : priceUsd.toFixed(6)}
                  </span>
                </div>
              </div>
              <div className="p-3 rounded-xl bg-black/40 border border-red-500/20">
                <p className="text-xs text-muted-foreground mb-1">24h Change</p>
                <div className="flex items-center gap-1">
                  {priceChange24h !== null && (
                    <>
                      {priceChange24h >= 0 ? (
                        <TrendingUp className="w-4 h-4 text-green-500" />
                      ) : (
                        <TrendingDown className="w-4 h-4 text-red-500" />
                      )}
                      <span className={`text-lg font-bold ${priceChange24h >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                        {priceChange24h >= 0 ? '+' : ''}{priceChange24h.toFixed(2)}%
                      </span>
                    </>
                  )}
                </div>
              </div>
              <div className="p-3 rounded-xl bg-black/40 border border-red-500/20">
                <p className="text-xs text-muted-foreground mb-1">24h Volume</p>
                <span className="text-lg font-bold text-foreground">
                  {volume24h !== null ? formatUsd(volume24h) : '--'}
                </span>
              </div>
              <div className="p-3 rounded-xl bg-black/40 border border-red-500/20">
                <p className="text-xs text-muted-foreground mb-1">Liquidity</p>
                <span className="text-lg font-bold text-foreground">
                  {liquidity !== null ? formatUsd(liquidity) : '--'}
                </span>
              </div>
            </motion.div>
          )}
          
          <div className="rounded-2xl border border-red-500/20 overflow-hidden bg-black/40">
            <iframe
              src="https://www.geckoterminal.com/base/pools/0x059e10d26c64a63d04e1814f46305210eddc447d?embed=1&info=0&swaps=0&grayscale=0&light_chart=0"
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
          <div className="inline-flex flex-col items-center gap-3 p-6 rounded-2xl bg-gradient-to-r from-red-500/5 via-transparent to-fuchsia-500/5 border border-red-500/20">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span className="text-sm font-mono text-red-400">TESTNET IS LIVE</span>
            </div>
            <p className="text-muted-foreground text-sm max-w-md">
              RougeChain testnet is open for testing. Create a wallet, request tokens from the faucet, 
              and help us battle-test the network before mainnet launch.
            </p>
            <div className="flex items-center gap-2 mt-2">
              <Link to="/wallet">
                <Button size="sm" className="gap-2 bg-red-500 hover:bg-red-600">
                  <Wallet className="w-4 h-4" />
                  Get Started
                </Button>
              </Link>
              <Link to="/blockchain">
                <Button size="sm" variant="outline" className="gap-2 border-red-500/30 text-red-400 hover:bg-red-500/10">
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
