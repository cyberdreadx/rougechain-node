import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Blocks, Clock, Zap, Activity, TrendingUp } from "lucide-react";

interface NetworkStats {
  blocksPerMinute: number;
  totalTransactions: number;
  avgBlockTime: number;
  currentGasFee: number;
  totalBlocks: number;
}

const NetworkStatsBar = () => {
  const [stats, setStats] = useState<NetworkStats>({
    blocksPerMinute: 0,
    totalTransactions: 0,
    avgBlockTime: 0,
    currentGasFee: 0.001, // Base fee in XRGE
    totalBlocks: 0,
  });
  const [isLoading, setIsLoading] = useState(true);

  const fetchStats = async () => {
    try {
      // Try to fetch from any running node
      for (const apiPort of [5100, 5101, 5102, 5103, 5104]) {
        try {
          const res = await fetch(`http://127.0.0.1:${apiPort}/api/blocks`);
          if (res.ok) {
            const data = await res.json() as { blocks: Array<{ header: { height: number; time: number }; txs: unknown[] }> };
            const blocks = data.blocks;

            if (blocks && blocks.length > 0) {
              const totalBlocks = blocks.length;
              
              // Calculate time span in minutes
              const firstBlockTime = blocks[0].header.time;
              const lastBlockTime = blocks[blocks.length - 1].header.time;
              const timeSpanMinutes = Math.max((lastBlockTime - firstBlockTime) / 60000, 1);
              
              // Blocks per minute (only if more than 1 block)
              const blocksPerMinute = totalBlocks > 1 
                ? Math.round((totalBlocks / timeSpanMinutes) * 100) / 100
                : 0;

              // Average block time in seconds
              const avgBlockTime = totalBlocks > 1 
                ? Math.round((lastBlockTime - firstBlockTime) / (totalBlocks - 1) / 1000)
                : 0;

              // Count transactions across all blocks
              const totalTransactions = blocks.reduce((sum, b) => sum + b.txs.length, 0);

              // Dynamic gas fee based on network activity (simple model)
              const baseFee = 0.001;
              const activityMultiplier = Math.min(blocksPerMinute * 0.1, 0.5);
              const currentGasFee = Math.round((baseFee + activityMultiplier) * 10000) / 10000;

              setStats({
                blocksPerMinute,
                totalTransactions,
                avgBlockTime,
                currentGasFee,
                totalBlocks,
              });
              setIsLoading(false);
              return;
            }
          }
        } catch {
          // Try next port
        }
      }
      // No nodes found
      setStats({
        blocksPerMinute: 0,
        totalTransactions: 0,
        avgBlockTime: 0,
        currentGasFee: 0.001,
        totalBlocks: 0,
      });
    } catch (error) {
      console.error("Failed to fetch network stats:", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 3000); // Refresh every 3s
    return () => clearInterval(interval);
  }, []);

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
      icon: Clock,
      label: "Avg Block Time",
      value: stats.avgBlockTime > 0 ? `${stats.avgBlockTime}s` : "—",
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
