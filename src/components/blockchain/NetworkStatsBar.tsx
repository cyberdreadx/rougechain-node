import { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";
import { Blocks, Clock, Zap, Activity, TrendingUp } from "lucide-react";
import { getCoreApiBaseUrl, getCoreApiHeaders, getNodeApiBaseUrl } from "@/lib/network";
import { useBlockchainWs } from "@/hooks/use-blockchain-ws";

interface NetworkStats {
  blocksPerMinute: number;
  totalTransactions: number;
  avgBlockTime: number;
  currentGasFee: number;
  totalBlocks: number;
  txsPerSecond: number;
  lastBlockAge: number;
}

const NetworkStatsBar = () => {
  const [stats, setStats] = useState<NetworkStats>({
    blocksPerMinute: 0,
    totalTransactions: 0,
    avgBlockTime: 0,
    currentGasFee: 0.001, // Base fee in XRGE
    totalBlocks: 0,
    txsPerSecond: 0,
    lastBlockAge: 0,
  });
  const [isLoading, setIsLoading] = useState(true);

  const fetchStats = async () => {
    try {
      const NODE_API_URL = getNodeApiBaseUrl();
      if (!NODE_API_URL) {
        setStats({
          blocksPerMinute: 0,
          totalTransactions: 0,
          avgBlockTime: 0,
          currentGasFee: 0.001,
          totalBlocks: 0,
          txsPerSecond: 0,
          lastBlockAge: 0,
        });
        setIsLoading(false);
        return;
      }
      const isLocal = NODE_API_URL.includes("localhost") || NODE_API_URL.includes("127.0.0.1");
      const fetchBlocks = async (url: string) => {
        const res = await fetch(`${url}/blocks`, {
          headers: getCoreApiHeaders(),
        });
        if (!res.ok) return null;
        const data = await res.json() as { blocks: Array<{ header: { height: number; time: number }; txs: unknown[] }> };
        return data.blocks;
      };

      let blocks = await fetchBlocks(NODE_API_URL);

      if (blocks && blocks.length > 0) {
        const totalBlocks = blocks.length;
        
        // Get timestamps and handle both ascending and descending order
        const timestamps = blocks.map(b => b.header.time).sort((a, b) => a - b);
        const oldestBlockTime = timestamps[0];
        const newestBlockTime = timestamps[timestamps.length - 1];
        const timeSpanMs = Math.max(newestBlockTime - oldestBlockTime, 1000);
        const timeSpanMinutes = timeSpanMs / 60000;
        const timeSpanSeconds = timeSpanMs / 1000;
        
        // Blocks per minute (only if more than 1 block)
        const blocksPerMinute = totalBlocks > 1 
          ? Math.round((totalBlocks / timeSpanMinutes) * 100) / 100
          : 0;

        // Average block time in seconds
        const avgBlockTime = totalBlocks > 1 
          ? Math.round(timeSpanMs / (totalBlocks - 1) / 1000)
          : 0;

        // Count transactions across all blocks
        const totalTransactions = blocks.reduce((sum, b) => sum + (b.txs ?? []).length, 0);
        
        // TPS: Calculate based on recent blocks (last 60 seconds) for more accurate real-time TPS
        const now = Date.now();
        const recentWindow = 60000; // 60 seconds
        const recentBlocks = blocks.filter(b => (now - b.header.time) <= recentWindow);
        const recentTxs = recentBlocks.reduce((sum, b) => sum + (b.txs ?? []).length, 0);
        
        let txsPerSecond = 0;
        if (recentBlocks.length > 0 && recentTxs > 0) {
          // Calculate TPS over the actual time span of recent blocks
          const recentTimestamps = recentBlocks.map(b => b.header.time).sort((a, b) => a - b);
          const recentSpan = Math.max(now - recentTimestamps[0], 1000) / 1000;
          txsPerSecond = Math.round((recentTxs / recentSpan) * 100) / 100;
        } else if (totalTransactions > 0 && timeSpanSeconds > 0) {
          // Fallback to overall TPS if no recent activity
          txsPerSecond = Math.round((totalTransactions / timeSpanSeconds) * 100) / 100;
        }
        
        const lastBlockAge = Math.max(Math.round((Date.now() - newestBlockTime) / 1000), 0);

        // Fetch live fee info from EIP-1559 endpoint
        let currentGasFee = 0.001;
        try {
          const apiBase = getCoreApiBaseUrl();
          if (apiBase) {
            const feeRes = await fetch(`${apiBase}/fee-info`, { headers: getCoreApiHeaders() });
            if (feeRes.ok) {
              const feeData = await feeRes.json();
              if (feeData.success && feeData.baseFee != null) {
                currentGasFee = Math.round(feeData.baseFee * 10000) / 10000;
              }
            }
          }
        } catch { /* fallback to 0.001 */ }

        setStats({
          blocksPerMinute,
          totalTransactions,
          avgBlockTime,
          currentGasFee,
          totalBlocks,
          txsPerSecond,
          lastBlockAge,
        });
        setIsLoading(false);
        return;
      }
      // No nodes found
      setStats({
        blocksPerMinute: 0,
        totalTransactions: 0,
        avgBlockTime: 0,
        currentGasFee: 0.001,
        totalBlocks: 0,
        txsPerSecond: 0,
        lastBlockAge: 0,
      });
    } catch (error) {
      console.error("Failed to fetch network stats:", error);
    } finally {
      setIsLoading(false);
    }
  };

  // WebSocket for real-time updates
  const handleNewBlock = useCallback(() => {
    fetchStats();
  }, []);

  useBlockchainWs({
    onNewBlock: handleNewBlock,
    fallbackPollInterval: 10000,
  });

  useEffect(() => {
    fetchStats();
  }, []);

  const formatAge = (seconds: number) => {
    if (!seconds || seconds <= 0) return "—";
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h`;
  };

  const statItems = [
    {
      icon: TrendingUp,
      label: "Blocks/min",
      value: stats.blocksPerMinute.toFixed(2),
      color: "text-primary",
    },
    {
      icon: Blocks,
      label: "Total Blocks",
      value: stats.totalBlocks.toString(),
      color: "text-foreground",
    },
    {
      icon: Activity,
      label: "Transactions",
      value: stats.totalTransactions.toString(),
      color: "text-success",
    },
    {
      icon: Activity,
      label: "TPS",
      value: stats.txsPerSecond > 0 ? stats.txsPerSecond.toFixed(2) : "0.00",
      color: "text-success",
    },
    {
      icon: Clock,
      label: "Avg Block Time",
      value: stats.avgBlockTime > 0
        ? stats.avgBlockTime < 60 ? `${stats.avgBlockTime}s`
          : stats.avgBlockTime < 3600 ? `${Math.round(stats.avgBlockTime / 60)}m`
            : `${(stats.avgBlockTime / 3600).toFixed(1)}h`
        : "—",
      color: "text-muted-foreground",
    },
    {
      icon: Clock,
      label: "Last Block",
      value: formatAge(stats.lastBlockAge),
      color: "text-muted-foreground",
    },
    {
      icon: Zap,
      label: "Gas Fee",
      value: `${stats.currentGasFee} XRGE`,
      color: "text-warning",
      highlight: true,
    },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-card/80 backdrop-blur-sm border border-border rounded-xl p-3"
    >
      <div className="flex items-center justify-between flex-wrap gap-4">
        {statItems.map((item, index) => (
          <motion.div
            key={item.label}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.05 }}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg ${
              item.highlight ? "bg-warning/10 border border-warning/20" : ""
            }`}
          >
            <item.icon className={`w-4 h-4 ${item.color}`} />
            <div className="flex flex-col">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                {item.label}
              </span>
              <span className={`text-sm font-semibold ${item.color}`}>
                {isLoading ? "..." : item.value}
              </span>
            </div>
          </motion.div>
        ))}

        {/* Live indicator */}
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-success/10 border border-success/20">
          <div className="w-2 h-2 rounded-full bg-success animate-pulse" />
          <span className="text-[10px] text-success font-medium uppercase">Live</span>
        </div>
      </div>
    </motion.div>
  );
};

export default NetworkStatsBar;
