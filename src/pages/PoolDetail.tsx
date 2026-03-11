import { useState, useEffect, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { AnimatePresence } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, TrendingUp, ArrowUpDown, Plus, Minus, Activity } from "lucide-react";
import { getNodeApiBaseUrl, getCoreApiHeaders } from "@/lib/network";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { loadUnifiedWallet } from "@/lib/unified-wallet";
import SwapWidget from "@/components/messenger/SwapWidget";
import { formatTokenAmount } from "@/hooks/use-eth-price";
import { TokenIcon } from "@/components/ui/token-icon";
import { useTokenMetadata } from "@/hooks/use-token-metadata";

interface Pool {
  pool_id: string;
  token_a: string;
  token_b: string;
  reserve_a: number;
  reserve_b: number;
  total_lp_supply: number;
  fee_rate: number;
}

interface PriceSnapshot {
  pool_id: string;
  timestamp: number;
  block_height: number;
  reserve_a: number;
  reserve_b: number;
  price_a_in_b: number;
  price_b_in_a: number;
}

interface PoolEvent {
  id: string;
  pool_id: string;
  event_type: string;
  user_pub_key: string;
  timestamp: number;
  block_height: number;
  tx_hash: string;
  token_in?: string;
  token_out?: string;
  amount_in?: number;
  amount_out?: number;
  amount_a?: number;
  amount_b?: number;
  lp_amount?: number;
  reserve_a_after: number;
  reserve_b_after: number;
}

interface PoolStats {
  pool_id: string;
  total_swaps: number;
  total_volume_a: number;
  total_volume_b: number;
  swap_count_24h: number;
  volume_24h_a: number;
  volume_24h_b: number;
}

const formatNumber = (n: number, symbol?: string): string => {
  return formatTokenAmount(n, symbol);
};


const formatAddress = (addr: string): string => {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-8)}`;
};

const formatTime = (timestamp: number): string => {
  // Auto-detect: if < 13 digits, it's seconds; otherwise milliseconds
  const ms = timestamp < 1e12 ? timestamp * 1000 : timestamp;
  return new Date(ms).toLocaleString();
};

const formatTimeShort = (timestamp: number): string => {
  const ms = timestamp < 1e12 ? timestamp * 1000 : timestamp;
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const getEventIcon = (eventType: string) => {
  switch (eventType) {
    case "Swap":
      return <ArrowUpDown className="w-4 h-4 text-blue-400" />;
    case "AddLiquidity":
      return <Plus className="w-4 h-4 text-green-400" />;
    case "RemoveLiquidity":
      return <Minus className="w-4 h-4 text-red-400" />;
    case "CreatePool":
      return <Activity className="w-4 h-4 text-purple-400" />;
    default:
      return <Activity className="w-4 h-4" />;
  }
};

const getEventLabel = (event: PoolEvent, pool: Pool | null): string => {
  switch (event.event_type) {
    case "Swap":
      return `Swap ${formatNumber(event.amount_in || 0, event.token_in)} ${event.token_in} → ${formatNumber(event.amount_out || 0, event.token_out)} ${event.token_out}`;
    case "AddLiquidity":
      return `Add ${formatNumber(event.amount_a || 0, pool?.token_a)} ${pool?.token_a} + ${formatNumber(event.amount_b || 0, pool?.token_b)} ${pool?.token_b}`;
    case "RemoveLiquidity":
      return `Remove ${formatNumber(event.lp_amount || 0)} LP`;
    case "CreatePool":
      return `Pool Created`;
    default:
      return event.event_type;
  }
};

const PoolDetail = () => {
  const { getTokenImage } = useTokenMetadata();
  const { poolId } = useParams<{ poolId: string }>();
  const [pool, setPool] = useState<Pool | null>(null);
  const [prices, setPrices] = useState<PriceSnapshot[]>([]);
  const [events, setEvents] = useState<PoolEvent[]>([]);
  const [stats, setStats] = useState<PoolStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [chartToken, setChartToken] = useState<"a" | "b">("a");
  const [showSwapWidget, setShowSwapWidget] = useState(false);

  const wallet = loadUnifiedWallet();

  const fetchData = useCallback(async () => {
    if (!poolId) return;

    try {
      const baseUrl = getNodeApiBaseUrl();
      if (!baseUrl) return;

      // Fetch pool, prices, events, and stats in parallel
      const [poolRes, pricesRes, eventsRes, statsRes] = await Promise.all([
        fetch(`${baseUrl}/pool/${poolId}`, { headers: getCoreApiHeaders() }),
        fetch(`${baseUrl}/pool/${poolId}/prices`, { headers: getCoreApiHeaders() }),
        fetch(`${baseUrl}/pool/${poolId}/events`, { headers: getCoreApiHeaders() }),
        fetch(`${baseUrl}/pool/${poolId}/stats`, { headers: getCoreApiHeaders() }),
      ]);

      if (poolRes.ok) {
        const data = await poolRes.json();
        setPool(data.pool || null);
      }

      if (pricesRes.ok) {
        const data = await pricesRes.json();
        setPrices(data.prices || []);
      }

      if (eventsRes.ok) {
        const data = await eventsRes.json();
        setEvents(data.events || []);
      }

      if (statsRes.ok) {
        const data = await statsRes.json();
        setStats(data.stats || null);
      }
    } catch (e) {
      console.error("Failed to fetch pool data:", e);
    } finally {
      setLoading(false);
    }
  }, [poolId]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const chartData = prices.map(p => ({
    time: formatTimeShort(p.timestamp),
    timestamp: p.timestamp,
    price: chartToken === "a" ? p.price_a_in_b : p.price_b_in_a,
    reserve_a: p.reserve_a,
    reserve_b: p.reserve_b,
  }));

  const currentPrice = chartData.length > 0
    ? chartData[chartData.length - 1].price
    : pool
      ? (chartToken === "a" ? pool.reserve_b / pool.reserve_a : pool.reserve_a / pool.reserve_b)
      : 0;

  const priceChange = chartData.length > 1
    ? ((chartData[chartData.length - 1].price - chartData[0].price) / chartData[0].price) * 100
    : 0;

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!pool) {
    return (
      <div className="min-h-screen bg-background p-6">
        <div className="max-w-6xl mx-auto">
          <Link to="/pools">
            <Button variant="ghost" className="mb-4">
              <ArrowLeft className="w-4 h-4 mr-2" /> Back to Pools
            </Button>
          </Link>
          <Card>
            <CardContent className="p-12 text-center">
              <p className="text-muted-foreground">Pool not found</p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-3 sm:p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Link to="/pools">
              <Button variant="ghost" size="icon" className="shrink-0">
                <ArrowLeft className="w-4 h-4" />
              </Button>
            </Link>
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex -space-x-2 shrink-0">
                <TokenIcon symbol={pool.token_a} size={36} imageUrl={getTokenImage(pool.token_a)} />
                <TokenIcon symbol={pool.token_b} size={36} imageUrl={getTokenImage(pool.token_b)} />
              </div>
              <div className="min-w-0">
                <h1 className="text-xl sm:text-2xl font-bold truncate">{pool.token_a}/{pool.token_b}</h1>
                <p className="text-xs sm:text-sm text-muted-foreground truncate">Pool ID: {pool.pool_id}</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="default"
              size="sm"
              onClick={() => setShowSwapWidget(true)}
              disabled={!wallet?.signingPrivateKey}
            >
              <ArrowUpDown className="w-4 h-4 mr-1.5" />
              Swap
            </Button>
            <Badge variant="secondary">Fee: {(pool.fee_rate * 100).toFixed(1)}%</Badge>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">{pool.token_a} Reserve</p>
              <p className="text-2xl font-bold font-mono">{formatNumber(pool.reserve_a, pool.token_a)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">{pool.token_b} Reserve</p>
              <p className="text-2xl font-bold font-mono">{formatNumber(pool.reserve_b, pool.token_b)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">Total Swaps</p>
              <p className="text-2xl font-bold font-mono">{stats?.total_swaps || 0}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">24h Swaps</p>
              <p className="text-2xl font-bold font-mono">{stats?.swap_count_24h || 0}</p>
            </CardContent>
          </Card>
        </div>

        {/* Price Chart */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <TrendingUp className="w-5 h-5 text-primary" />
                <CardTitle>Price Chart</CardTitle>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant={chartToken === "a" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setChartToken("a")}
                >
                  {pool.token_a}/{pool.token_b}
                </Button>
                <Button
                  variant={chartToken === "b" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setChartToken("b")}
                >
                  {pool.token_b}/{pool.token_a}
                </Button>
              </div>
            </div>
            <div className="flex items-baseline gap-3 mt-2">
              <span className="text-3xl font-bold font-mono">{currentPrice.toFixed(6)}</span>
              <span className="text-sm text-muted-foreground">
                {chartToken === "a" ? pool.token_b : pool.token_a} per {chartToken === "a" ? pool.token_a : pool.token_b}
              </span>
              {priceChange !== 0 && (
                <Badge variant={priceChange >= 0 ? "default" : "destructive"}>
                  {priceChange >= 0 ? "+" : ""}{priceChange.toFixed(2)}%
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                  <XAxis
                    dataKey="time"
                    stroke="#666"
                    tick={{ fill: '#888', fontSize: 12 }}
                  />
                  <YAxis
                    stroke="#666"
                    tick={{ fill: '#888', fontSize: 12 }}
                    tickFormatter={(v) => v.toFixed(4)}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#1a1a1a',
                      border: '1px solid #333',
                      borderRadius: '8px'
                    }}
                    labelStyle={{ color: '#888' }}
                  />
                  <Line
                    type="monotone"
                    dataKey="price"
                    stroke="#22c55e"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[300px] flex items-center justify-center text-muted-foreground">
                No price history yet. Make some swaps to see the chart!
              </div>
            )}
          </CardContent>
        </Card>

        {/* Transactions */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <Activity className="w-5 h-5 text-primary" />
              <CardTitle>Transaction History</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            {events.length > 0 ? (
              <div className="space-y-2">
                {events.map((event) => (
                  <div
                    key={event.id}
                    className="flex items-center justify-between p-3 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      {getEventIcon(event.event_type)}
                      <div>
                        <p className="font-medium">{getEventLabel(event, pool)}</p>
                        <p className="text-xs text-muted-foreground">
                          by {formatAddress(event.user_pub_key)}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-muted-foreground">{formatTime(event.timestamp)}</p>
                      <p className="text-xs text-muted-foreground">Block #{event.block_height}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-12 text-center text-muted-foreground">
                No transactions yet
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Swap widget modal */}
      <AnimatePresence>
        {showSwapWidget && wallet?.signingPrivateKey && (
          <SwapWidget
            walletPublicKey={wallet.signingPublicKey}
            walletPrivateKey={wallet.signingPrivateKey}
            onClose={() => setShowSwapWidget(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
};

export default PoolDetail;
