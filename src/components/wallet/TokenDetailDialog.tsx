import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { X, TrendingUp, TrendingDown, ExternalLink, Edit2, Loader2, BarChart3, Send, Download, ArrowLeftRight, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getNodeApiBaseUrl, getCoreApiHeaders } from "@/lib/network";
import { formatUsd, formatTokenPrice } from "@/lib/price-service";
import xrgeLogo from "@/assets/xrge-logo.webp";
import qethLogo from "@/assets/qeth-logo.png";
import UpdateTokenMetadataDialog from "./UpdateTokenMetadataDialog";

interface TokenDetailDialogProps {
  symbol: string;
  name: string;
  balance: string;
  usdValue?: string | null;
  pricePerToken?: string | null;
  change?: number;
  imageUrl?: string | null;
  walletPublicKey?: string;
  walletPrivateKey?: string;
  isCreator?: boolean;
  onClose: () => void;
  onSend?: () => void;
  onReceive?: () => void;
  onSwap?: () => void;
}

interface PriceSnapshot {
  pool_id: string;
  timestamp: number;
  block_height: number;
  reserve_a: number;
  reserve_b: number;
  price_a_in_b: number;  // How many token B for 1 token A
  price_b_in_a: number;  // How many token A for 1 token B
}

interface PoolInfo {
  pool_id: string;
  token_a: string;
  token_b: string;
}

interface PricePoint {
  timestamp: number;
  price: number;
}

const TokenDetailDialog = ({
  symbol,
  name,
  balance,
  usdValue,
  pricePerToken,
  change = 0,
  imageUrl,
  walletPublicKey,
  walletPrivateKey,
  isCreator = false,
  onClose,
  onSend,
  onReceive,
  onSwap,
}: TokenDetailDialogProps) => {
  const navigate = useNavigate();
  const [priceHistory, setPriceHistory] = useState<PricePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [showEditMetadata, setShowEditMetadata] = useState(false);
  const [poolId, setPoolId] = useState<string | null>(null);

  // Fetch price history from pool events
  useEffect(() => {
    async function fetchPriceHistory() {
      setLoading(true);
      try {
        const baseUrl = getNodeApiBaseUrl();
        if (!baseUrl) return;

        // First, find the pool for this token
        const poolsRes = await fetch(`${baseUrl}/pools`, {
          headers: getCoreApiHeaders(),
        });
        const poolsData = await poolsRes.json();
        const pools: PoolInfo[] = poolsData.pools || poolsData || [];
        
        // Find pool with XRGE pair
        const pool = pools.find((p) => 
          (p.token_a === symbol && p.token_b === "XRGE") ||
          (p.token_b === symbol && p.token_a === "XRGE")
        );

        if (!pool) {
          console.log(`[TokenDetail] No XRGE pool found for ${symbol}`);
          setLoading(false);
          return;
        }

        setPoolId(pool.pool_id);
        const isTokenA = pool.token_a === symbol;

        // Fetch price snapshots for chart
        const pricesRes = await fetch(`${baseUrl}/pool/${pool.pool_id}/prices`, {
          headers: getCoreApiHeaders(),
        });
        const pricesData = await pricesRes.json();
        const prices: PriceSnapshot[] = pricesData.prices || [];

        console.log(`[TokenDetail] Found ${prices.length} price snapshots for ${symbol}`);

        // Convert price snapshots to price points
        // price_a_in_b = how many token B for 1 token A
        // If our token is token_a, use price_a_in_b (price in XRGE)
        // If our token is token_b, use price_b_in_a (price in XRGE)
        const points: PricePoint[] = prices
          .map(p => ({
            timestamp: p.timestamp,
            price: isTokenA ? p.price_a_in_b : p.price_b_in_a,
          }))
          .sort((a, b) => a.timestamp - b.timestamp);

        setPriceHistory(points);
      } catch (e) {
        console.error("Failed to fetch price history:", e);
      } finally {
        setLoading(false);
      }
    }

    if (symbol !== "XRGE") {
      fetchPriceHistory();
    } else {
      setLoading(false);
    }
  }, [symbol]);

  // Simple SVG chart rendering
  const renderChart = () => {
    if (priceHistory.length < 2) {
      return (
        <div className="h-32 flex items-center justify-center text-muted-foreground text-sm">
          <BarChart3 className="w-5 h-5 mr-2 opacity-50" />
          Not enough data for chart
        </div>
      );
    }

    const prices = priceHistory.map(p => p.price);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const range = maxPrice - minPrice || 1;

    const width = 300;
    const height = 100;
    const padding = 10;

    const points = priceHistory.map((p, i) => {
      const x = padding + (i / (priceHistory.length - 1)) * (width - padding * 2);
      const y = height - padding - ((p.price - minPrice) / range) * (height - padding * 2);
      return `${x},${y}`;
    }).join(" ");

    const isUp = priceHistory[priceHistory.length - 1].price >= priceHistory[0].price;

    return (
      <div className="relative">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-32">
          {/* Grid lines */}
          <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="currentColor" strokeOpacity="0.1" />
          <line x1={padding} y1={padding} x2={width - padding} y2={padding} stroke="currentColor" strokeOpacity="0.1" />
          
          {/* Price line */}
          <polyline
            fill="none"
            stroke={isUp ? "#22c55e" : "#ef4444"}
            strokeWidth="2"
            points={points}
          />
          
          {/* Gradient fill */}
          <defs>
            <linearGradient id={`gradient-${symbol}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={isUp ? "#22c55e" : "#ef4444"} stopOpacity="0.3" />
              <stop offset="100%" stopColor={isUp ? "#22c55e" : "#ef4444"} stopOpacity="0" />
            </linearGradient>
          </defs>
          <polygon
            fill={`url(#gradient-${symbol})`}
            points={`${padding},${height - padding} ${points} ${width - padding},${height - padding}`}
          />
        </svg>
        
        {/* Price labels */}
        <div className="flex justify-between text-[10px] text-muted-foreground px-2">
          <span>{new Date(priceHistory[0].timestamp).toLocaleDateString()}</span>
          <span>{new Date(priceHistory[priceHistory.length - 1].timestamp).toLocaleDateString()}</span>
        </div>
      </div>
    );
  };

  const renderIcon = () => {
    if (symbol === "XRGE") {
      return <img src={xrgeLogo} alt="XRGE" className="w-16 h-16 rounded-full" />;
    }
    if (symbol === "qETH") {
      return <img src={qethLogo} alt="qETH" className="w-16 h-16 rounded-full" />;
    }
    if (imageUrl) {
      return <img src={imageUrl} alt={symbol} className="w-16 h-16 rounded-full object-cover bg-secondary" />;
    }
    return (
      <div className="w-16 h-16 rounded-full bg-secondary flex items-center justify-center text-2xl font-bold text-primary">
        {symbol.charAt(0)}
      </div>
    );
  };

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-md max-h-[85vh] overflow-y-auto bg-card border border-border rounded-xl shadow-2xl"
        >
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-card z-10">
            <div className="flex items-center gap-3">
              {renderIcon()}
              <div>
                <h2 className="font-semibold text-lg">{name}</h2>
                <p className="text-sm text-muted-foreground">{symbol}</p>
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="w-4 h-4" />
            </Button>
          </div>

          {/* Body */}
          <div className="p-4 space-y-4">
            {/* Balance & Value */}
            <div className="p-4 rounded-lg bg-secondary/30">
              <p className="text-sm text-muted-foreground">Your Balance</p>
              <p className="text-2xl font-bold font-mono">{balance} {symbol}</p>
              {usdValue && (
                <p className="text-lg text-foreground">{usdValue}</p>
              )}
              {pricePerToken && (
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-sm text-muted-foreground">@ {pricePerToken}</span>
                  {change !== 0 && (
                    <span className={`flex items-center text-xs ${change >= 0 ? 'text-success' : 'text-destructive'}`}>
                      {change >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                      {Math.abs(change)}%
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Price Chart (for custom tokens with pools) */}
            {symbol !== "XRGE" && (
              <div className="p-4 rounded-lg bg-secondary/20 border border-border">
                <h3 className="text-sm font-medium mb-3">Price Chart (XRGE pair)</h3>
                {loading ? (
                  <div className="h-32 flex items-center justify-center">
                    <Loader2 className="w-5 h-5 animate-spin text-primary" />
                  </div>
                ) : (
                  renderChart()
                )}
              </div>
            )}

            {/* XRGE - Link to DexScreener */}
            {symbol === "XRGE" && (
              <div className="p-4 rounded-lg bg-secondary/20 border border-border">
                <h3 className="text-sm font-medium mb-3">Price Chart</h3>
                <a
                  href="https://dexscreener.com/base/0x147120faec9277ec02d957584cfcd92b56a24317"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-primary hover:underline text-sm"
                >
                  <ExternalLink className="w-4 h-4" />
                  View on DexScreener
                </a>
              </div>
            )}

            {/* Action Buttons */}
            <div className="grid grid-cols-3 gap-2">
              <Button
                variant="outline"
                className="flex-col h-auto py-3 gap-1.5"
                onClick={() => {
                  onClose();
                  onSend?.();
                }}
              >
                <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center">
                  <Send className="w-4 h-4 text-primary" />
                </div>
                <span className="text-xs">Send</span>
              </Button>
              
              <Button
                variant="outline"
                className="flex-col h-auto py-3 gap-1.5"
                onClick={() => {
                  onClose();
                  onReceive?.();
                }}
              >
                <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center">
                  <Download className="w-4 h-4 text-success" />
                </div>
                <span className="text-xs">Receive</span>
              </Button>
              
              <Button
                variant="outline"
                className="flex-col h-auto py-3 gap-1.5"
                onClick={() => {
                  onClose();
                  onSwap?.();
                }}
              >
                <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center">
                  <ArrowLeftRight className="w-4 h-4 text-accent" />
                </div>
                <span className="text-xs">Swap</span>
              </Button>
            </div>

            {/* View on Blockchain */}
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                onClose();
                navigate(`/token/${symbol}`);
              }}
            >
              <Search className="w-4 h-4 mr-2" />
              View on Blockchain
            </Button>

            {/* Edit Metadata (for token creators) */}
            {isCreator && walletPublicKey && walletPrivateKey && (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setShowEditMetadata(true)}
              >
                <Edit2 className="w-4 h-4 mr-2" />
                Edit Token Metadata
              </Button>
            )}
          </div>
        </motion.div>
      </motion.div>

      {/* Edit Metadata Dialog */}
      {showEditMetadata && walletPublicKey && walletPrivateKey && (
        <UpdateTokenMetadataDialog
          tokenSymbol={symbol}
          walletPublicKey={walletPublicKey}
          walletPrivateKey={walletPrivateKey}
          onClose={() => setShowEditMetadata(false)}
          onSuccess={() => setShowEditMetadata(false)}
        />
      )}
    </>
  );
};

export default TokenDetailDialog;
