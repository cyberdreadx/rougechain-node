import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { BarChart3, TrendingUp } from "lucide-react";
import { getCoreApiHeaders, getNodeApiBaseUrl } from "@/lib/network";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

interface ChartDataPoint {
  time: string;
  blocks: number;
  transactions: number;
  timestamp: number;
}

interface SummaryPoint {
  timestamp: number;
  blocks: number;
  transactions: number;
}

const NetworkHistoryChart = () => {
  const [chartData, setChartData] = useState<ChartDataPoint[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [timeRange, setTimeRange] = useState<"1h" | "24h" | "7d">("24h");

  const fetchChartData = async () => {
    try {
      // Use network-aware API base URL, fallback to local ports if localhost
      const NODE_API_URL = getNodeApiBaseUrl();
      if (!NODE_API_URL) {
        setChartData([]);
        return;
      }
      const isLocal = NODE_API_URL.includes("localhost") || NODE_API_URL.includes("127.0.0.1");
      const timeoutMs = isLocal ? 2000 : 8000;
      let summaryPoints: SummaryPoint[] = [];
      let blocks: Array<{ header: { time: number; height: number }; txs: unknown[] }> = [];
      
      try {
        const res = await fetch(`${NODE_API_URL}/blocks/summary?range=${timeRange}`, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: getCoreApiHeaders(),
        });
        if (res.ok) {
          const data = await res.json() as { success: boolean; points: SummaryPoint[] };
          if (data.success && Array.isArray(data.points)) {
            summaryPoints = data.points;
          }
        }
      } catch (error) {
        if (isLocal) {
          // Fallback: Try to fetch from any running local node
          for (const apiPort of [5100, 5101, 5102, 5103, 5104]) {
            try {
              const res = await fetch(`http://127.0.0.1:${apiPort}/api/blocks/summary?range=${timeRange}`, {
                signal: AbortSignal.timeout(2000),
                headers: getCoreApiHeaders(),
              });
              if (res.ok) {
                const data = await res.json() as { success: boolean; points: SummaryPoint[] };
                if (data.success && Array.isArray(data.points)) {
                  summaryPoints = data.points;
                }
                break;
              }
            } catch {
              // Try next port
            }
          }
        } else {
          console.warn(`Failed to fetch from ${NODE_API_URL}:`, error);
        }
      }

      if (summaryPoints.length > 0) {
        const data: ChartDataPoint[] = summaryPoints.map((point) => {
          const date = new Date(point.timestamp);
          const timeLabel = timeRange === "1h"
            ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
            : timeRange === "24h"
            ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
            : date.toLocaleDateString([], { month: "short", day: "numeric" });
          return {
            time: timeLabel,
            blocks: point.blocks,
            transactions: point.transactions,
            timestamp: point.timestamp,
          };
        });
        setChartData(data);
        return;
      }

      try {
        const res = await fetch(`${NODE_API_URL}/blocks`, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: getCoreApiHeaders(),
        });
        if (res.ok) {
          const data = await res.json() as { blocks: Array<{ header: { time: number; height: number }; txs: unknown[] }> };
          blocks = data.blocks;
        }
      } catch (error) {
        if (isLocal) {
          // Fallback: Try to fetch from any running local node
          for (const apiPort of [5100, 5101, 5102, 5103, 5104]) {
            try {
              const res = await fetch(`http://127.0.0.1:${apiPort}/api/blocks`, {
                signal: AbortSignal.timeout(2000),
                headers: getCoreApiHeaders(),
              });
              if (res.ok) {
                const data = await res.json() as { blocks: Array<{ header: { time: number; height: number }; txs: unknown[] }> };
                blocks = data.blocks;
                break;
              }
            } catch {
              // Try next port
            }
          }
        } else {
          console.warn(`Failed to fetch from ${NODE_API_URL}:`, error);
        }
      }

      if (blocks && blocks.length > 0) {
        // Group blocks by time intervals based on range
        const intervalMs = timeRange === "1h" ? 5 * 60 * 1000 : // 5 min intervals
                          timeRange === "24h" ? 60 * 60 * 1000 : // 1 hour intervals
                          24 * 60 * 60 * 1000; // 1 day intervals

        const now = Date.now();
        const rangeMs = timeRange === "1h" ? 60 * 60 * 1000 :
                       timeRange === "24h" ? 24 * 60 * 60 * 1000 :
                       7 * 24 * 60 * 60 * 1000;

        const startTime = now - rangeMs;

        // Create time buckets
        const buckets: Map<number, { blocks: number; transactions: number }> = new Map();
        
        // Initialize buckets
        for (let t = startTime; t <= now; t += intervalMs) {
          buckets.set(Math.floor(t / intervalMs) * intervalMs, { blocks: 0, transactions: 0 });
        }

        // Fill buckets with data
        blocks.forEach((block) => {
          const blockTime = block.header.time;
          if (blockTime >= startTime) {
            const bucketKey = Math.floor(blockTime / intervalMs) * intervalMs;
            const bucket = buckets.get(bucketKey);
            if (bucket) {
              bucket.blocks += 1;
              // Count transactions in block
              bucket.transactions += block.txs.length;
            }
          }
        });

        // Convert to chart data
        const data: ChartDataPoint[] = Array.from(buckets.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([timestamp, values]) => {
            const date = new Date(timestamp);
            const timeLabel = timeRange === "1h" 
              ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
              : timeRange === "24h"
              ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
              : date.toLocaleDateString([], { month: "short", day: "numeric" });

            return {
              time: timeLabel,
              blocks: values.blocks,
              transactions: values.transactions,
              timestamp,
            };
          });

        // If no data in range, show the actual blocks we have
        if (data.every(d => d.blocks === 0) && blocks.length > 0) {
          // Create cumulative data from actual blocks
          const cumulativeData: ChartDataPoint[] = blocks.map((block, index) => ({
            time: new Date(block.header.time).toLocaleTimeString([], { 
              hour: "2-digit", 
              minute: "2-digit" 
            }),
            blocks: index + 1,
            transactions: blocks.slice(0, index + 1).reduce((sum, b) => sum + b.txs.length, 0),
            timestamp: block.header.time,
          }));
          setChartData(cumulativeData);
        } else {
          setChartData(data);
        }
      } else {
        setChartData([]);
      }
    } catch (error) {
      console.error("Failed to fetch chart data:", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchChartData();
    const interval = setInterval(fetchChartData, 10000); // Refresh every 10s
    return () => clearInterval(interval);
  }, [timeRange]);

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-card border border-border rounded-lg p-3 shadow-lg">
          <p className="text-sm font-medium text-foreground mb-1">{label}</p>
          {payload.map((entry: any, index: number) => (
            <p key={index} className="text-xs" style={{ color: entry.color }}>
              {entry.name}: {entry.value}
            </p>
          ))}
        </div>
      );
    }
    return null;
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-card border border-border rounded-xl p-4"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Network Activity</h3>
        </div>
        
        {/* Time range selector */}
        <div className="flex items-center gap-1 p-1 rounded-lg bg-secondary/50">
          {(["1h", "24h", "7d"] as const).map((range) => (
            <button
              key={range}
              onClick={() => setTimeRange(range)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                timeRange === range
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {range}
            </button>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div className="h-[250px] w-full">
        {isLoading ? (
          <div className="h-full flex items-center justify-center">
            <TrendingUp className="w-8 h-8 text-muted-foreground animate-pulse" />
          </div>
        ) : chartData.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
            <BarChart3 className="w-12 h-12 mb-2 opacity-50" />
            <p className="text-sm">No activity data yet</p>
            <p className="text-xs">Mine some blocks to see the chart</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={chartData}
              margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient id="colorBlocks" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="colorTransactions" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--success))" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="hsl(var(--success))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid 
                strokeDasharray="3 3" 
                stroke="hsl(var(--border))" 
                opacity={0.5} 
              />
              <XAxis
                dataKey="time"
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                interval="preserveStartEnd"
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                width={30}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend 
                wrapperStyle={{ fontSize: "12px" }}
                iconType="circle"
                iconSize={8}
              />
              <Area
                type="monotone"
                dataKey="blocks"
                name="Blocks"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#colorBlocks)"
              />
              <Area
                type="monotone"
                dataKey="transactions"
                name="Transactions"
                stroke="hsl(var(--success))"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#colorTransactions)"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Summary */}
      {chartData.length > 0 && (
        <div className="mt-4 pt-3 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Total in period: {chartData.reduce((sum, d) => sum + d.blocks, 0)} blocks
          </span>
          <span>
            {chartData.reduce((sum, d) => sum + d.transactions, 0)} transactions
          </span>
        </div>
      )}
    </motion.div>
  );
};

export default NetworkHistoryChart;
