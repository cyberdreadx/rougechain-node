import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  Copy,
  ExternalLink,
  Users,
  Coins,
  BarChart3,
  Clock,
  TrendingUp,
  TrendingDown,
  Loader2,
  Globe,
  Twitter,
  Edit2,
  Droplets
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { getNodeApiBaseUrl, getCoreApiHeaders } from "@/lib/network";
import { formatUsd, formatTokenPrice } from "@/lib/price-service";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { loadUnifiedWallet } from "@/lib/unified-wallet";
import { claimTokenMetadata } from "@/lib/secure-api";
import UpdateTokenMetadataDialog from "@/components/wallet/UpdateTokenMetadataDialog";
import { TokenIcon } from "@/components/ui/token-icon";
import { formatTokenAmount } from "@/hooks/use-eth-price";

// Discord logo component
const DiscordLogo = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor">
    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
  </svg>
);

// X logo component
const XLogo = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

interface TokenMetadata {
  symbol: string;
  name: string;
  creator: string;
  image?: string;
  description?: string;
  website?: string;
  twitter?: string;
  discord?: string;
  created_at: number;
  updated_at: number;
}

interface TokenHolder {
  address: string;
  balance: number;
  percentage: number;
}

interface PoolInfo {
  pool_id: string;
  token_a: string;
  token_b: string;
  reserve_a: number;
  reserve_b: number;
  total_lp_supply: number;
}

interface PriceSnapshot {
  timestamp: number;
  price_a_in_b: number;
  price_b_in_a: number;
}

interface TokenTransaction {
  tx_hash: string;
  tx_type: string;
  from: string;
  to?: string;
  amount: number;
  timestamp: number;
  block_height: number;
}

const TokenExplorer = () => {
  const { symbol } = useParams<{ symbol: string }>();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [metadata, setMetadata] = useState<TokenMetadata | null>(null);
  const [holders, setHolders] = useState<TokenHolder[]>([]);
  const [totalSupply, setTotalSupply] = useState<number>(0);
  const [circulatingSupply, setCirculatingSupply] = useState<number>(0);
  const [pool, setPool] = useState<PoolInfo | null>(null);
  const [priceHistory, setPriceHistory] = useState<PriceSnapshot[]>([]);
  const [transactionCount, setTransactionCount] = useState<number>(0);
  const [transactionList, setTransactionList] = useState<TokenTransaction[]>([]);
  const [showEditMetadata, setShowEditMetadata] = useState(false);
  const [claiming, setClaiming] = useState(false);

  const { tokenPrices, xrgeUsdPrice } = useTokenPrices(60000);
  const tokenPrice = symbol ? tokenPrices[symbol] : null;

  // Check if current user is the token creator
  const wallet = loadUnifiedWallet();
  const isCreator = wallet && metadata?.creator === wallet.signingPublicKey;
  const hasNoMetadata = !metadata?.creator;

  const handleClaimOwnership = async () => {
    if (!wallet || !symbol) return;

    setClaiming(true);
    try {
      const result = await claimTokenMetadata(
        wallet.signingPublicKey,
        wallet.signingPrivateKey,
        symbol
      );

      if (result.success) {
        toast.success("Ownership claimed!", {
          description: "You can now edit this token's metadata",
        });
        fetchTokenData(); // Refresh to show metadata
      } else {
        toast.error("Failed to claim ownership", {
          description: result.error || "You may not be the original creator",
        });
      }
    } catch (e) {
      toast.error("Failed to claim ownership");
      console.error(e);
    } finally {
      setClaiming(false);
    }
  };

  const fetchTokenData = useCallback(async () => {
    if (!symbol) return;

    setLoading(true);
    try {
      const baseUrl = getNodeApiBaseUrl();
      if (!baseUrl) return;

      // Fetch metadata
      const metaRes = await fetch(`${baseUrl}/token/${symbol}/metadata`, {
        headers: getCoreApiHeaders(),
      });
      if (metaRes.ok) {
        const metaData = await metaRes.json();
        if (metaData.success) {
          setMetadata(metaData);
        }
      }

      // Fetch token holders (from balances)
      const holdersRes = await fetch(`${baseUrl}/token/${symbol}/holders`, {
        headers: getCoreApiHeaders(),
      });
      if (holdersRes.ok) {
        const holdersData = await holdersRes.json();
        if (holdersData.success) {
          setHolders(holdersData.holders || []);
          setTotalSupply(holdersData.total_supply || 0);
          setCirculatingSupply(holdersData.circulating_supply || 0);
        }
      }

      // Find XRGE pool for this token
      const poolsRes = await fetch(`${baseUrl}/pools`, {
        headers: getCoreApiHeaders(),
      });
      if (poolsRes.ok) {
        const poolsData = await poolsRes.json();
        const pools = poolsData.pools || [];
        const tokenPool = pools.find((p: PoolInfo) =>
          (p.token_a === symbol && p.token_b === "XRGE") ||
          (p.token_b === symbol && p.token_a === "XRGE")
        );
        if (tokenPool) {
          setPool(tokenPool);

          // Fetch price history
          const pricesRes = await fetch(`${baseUrl}/pool/${tokenPool.pool_id}/prices`, {
            headers: getCoreApiHeaders(),
          });
          if (pricesRes.ok) {
            const pricesData = await pricesRes.json();
            setPriceHistory(pricesData.prices || []);
          }

        }
      }

      // Fetch token transactions (all tx types involving this token)
      const txRes = await fetch(`${baseUrl}/token/${symbol}/transactions?limit=50`, {
        headers: getCoreApiHeaders(),
      });
      if (txRes.ok) {
        const txData = await txRes.json();
        if (txData.success) {
          setTransactionList(txData.transactions || []);
          setTransactionCount(txData.total_count || 0);
        }
      }
    } catch (e) {
      console.error("Failed to fetch token data:", e);
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    fetchTokenData();
  }, [fetchTokenData]);

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Failed to copy");
    }
  };

  const renderIcon = () => (
    <TokenIcon symbol={symbol} size={64} imageUrl={metadata?.image} />
  );

  // Simple SVG chart
  const renderChart = () => {
    if (priceHistory.length < 2) {
      return (
        <div className="h-40 flex items-center justify-center text-muted-foreground">
          <BarChart3 className="w-6 h-6 mr-2 opacity-50" />
          Not enough data for chart
        </div>
      );
    }

    const isTokenA = pool?.token_a === symbol;
    const prices = priceHistory.map(p => isTokenA ? p.price_a_in_b : p.price_b_in_a);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const range = maxPrice - minPrice || 1;

    const width = 400;
    const height = 150;
    const padding = 20;

    const points = priceHistory.map((p, i) => {
      const price = isTokenA ? p.price_a_in_b : p.price_b_in_a;
      const x = padding + (i / (priceHistory.length - 1)) * (width - padding * 2);
      const y = height - padding - ((price - minPrice) / range) * (height - padding * 2);
      return `${x},${y}`;
    }).join(" ");

    const isUp = prices[prices.length - 1] >= prices[0];

    return (
      <div className="relative">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-40">
          <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="currentColor" strokeOpacity="0.1" />
          <line x1={padding} y1={padding} x2={width - padding} y2={padding} stroke="currentColor" strokeOpacity="0.1" />

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

          <polyline
            fill="none"
            stroke={isUp ? "#22c55e" : "#ef4444"}
            strokeWidth="2"
            points={points}
          />
        </svg>

        <div className="flex justify-between text-xs text-muted-foreground px-4">
          <span>{new Date(priceHistory[0].timestamp < 1e12 ? priceHistory[0].timestamp * 1000 : priceHistory[0].timestamp).toLocaleDateString()}</span>
          <span>{new Date(priceHistory[priceHistory.length - 1].timestamp < 1e12 ? priceHistory[priceHistory.length - 1].timestamp * 1000 : priceHistory[priceHistory.length - 1].timestamp).toLocaleDateString()}</span>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="sticky top-0 z-40 bg-background/80 backdrop-blur-sm border-b border-border">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <h1 className="font-semibold">Token Explorer</h1>
        </div>
      </div>

      <main className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        {/* Token Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col sm:flex-row items-start gap-4"
        >
          <div className="flex items-center gap-4 w-full sm:w-auto">
            {renderIcon()}
            <div className="flex-1 sm:hidden">
              <h2 className="text-xl font-bold">{metadata?.name || symbol}</h2>
              <span className="text-sm text-muted-foreground">({symbol})</span>
            </div>
          </div>
          <div className="flex-1 w-full">
            <div className="hidden sm:flex items-center gap-2">
              <h2 className="text-2xl font-bold">{metadata?.name || symbol}</h2>
              <span className="text-lg text-muted-foreground">({symbol})</span>
            </div>
            {metadata?.description && (
              <p className="text-sm text-muted-foreground mt-1">{metadata.description}</p>
            )}

            {/* Social Links */}
            <div className="flex flex-wrap items-center gap-2 sm:gap-3 mt-2">
              {metadata?.website && (
                <a
                  href={metadata.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-primary transition-colors"
                  title="Website"
                >
                  <Globe className="w-4 h-4" />
                </a>
              )}
              {metadata?.twitter && (
                <a
                  href={`https://x.com/${metadata.twitter.replace('@', '')}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-primary transition-colors"
                  title="X"
                >
                  <XLogo className="w-4 h-4" />
                </a>
              )}
              {metadata?.discord && (
                <a
                  href={metadata.discord.startsWith('http') ? metadata.discord : `https://discord.gg/${metadata.discord}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-primary transition-colors"
                  title="Discord"
                >
                  <DiscordLogo className="w-4 h-4" />
                </a>
              )}

              {/* Edit button for creator */}
              {isCreator && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowEditMetadata(true)}
                  className="ml-2"
                >
                  <Edit2 className="w-3 h-3 mr-1" />
                  Edit
                </Button>
              )}

              {/* Claim ownership button for tokens without metadata */}
              {hasNoMetadata && wallet && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleClaimOwnership}
                  disabled={claiming}
                  className="ml-2"
                >
                  {claiming ? (
                    <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  ) : (
                    <Edit2 className="w-3 h-3 mr-1" />
                  )}
                  {claiming ? "Claiming..." : "Claim Ownership"}
                </Button>
              )}
            </div>
          </div>

          {/* Price Badge */}
          {tokenPrice && (
            <div className="text-left sm:text-right mt-3 sm:mt-0 w-full sm:w-auto">
              <p className="text-xl sm:text-2xl font-bold font-mono">{formatTokenPrice(tokenPrice.priceUsd)}</p>
              {tokenPrice.priceUsd && xrgeUsdPrice && (
                <p className="text-sm text-muted-foreground">
                  {(tokenPrice.priceUsd / xrgeUsdPrice).toFixed(4)} XRGE
                </p>
              )}
            </div>
          )}
        </motion.div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <Coins className="w-4 h-4" />
                <span className="text-xs">Total Supply</span>
              </div>
              <p className="text-lg font-mono font-semibold">
                {formatTokenAmount(totalSupply, symbol)}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <Users className="w-4 h-4" />
                <span className="text-xs">Holders</span>
              </div>
              <p className="text-lg font-mono font-semibold">
                {holders.length}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <BarChart3 className="w-4 h-4" />
                <span className="text-xs">Transactions</span>
              </div>
              <p className="text-lg font-mono font-semibold">
                {transactionCount}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <Droplets className="w-4 h-4" />
                <span className="text-xs">Liquidity</span>
              </div>
              <p className="text-lg font-mono font-semibold">
                {pool ? (
                  pool.token_a === symbol
                    ? `${formatTokenAmount(pool.reserve_a, pool.token_a)} ${symbol}`
                    : `${formatTokenAmount(pool.reserve_b, pool.token_b)} ${symbol}`
                ) : "No pool"}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Price Chart */}
        {pool && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <BarChart3 className="w-4 h-4" />
                Price Chart (XRGE pair)
              </CardTitle>
            </CardHeader>
            <CardContent>
              {renderChart()}
            </CardContent>
          </Card>
        )}

        {/* Pool Info */}
        {pool && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Droplets className="w-4 h-4" />
                Liquidity Pool
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-muted-foreground">Pool ID</p>
                  <div className="flex items-center gap-2">
                    <p className="font-mono text-sm truncate">{pool.pool_id}</p>
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => handleCopy(pool.pool_id)}>
                      <Copy className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">LP Supply</p>
                  <p className="font-mono text-sm">{pool.total_lp_supply.toLocaleString()}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 p-3 rounded-lg bg-secondary/30">
                <div>
                  <p className="text-xs text-muted-foreground">{pool.token_a} Reserve</p>
                  <p className="font-mono font-semibold">{formatTokenAmount(pool.reserve_a, pool.token_a)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{pool.token_b} Reserve</p>
                  <p className="font-mono font-semibold">{formatTokenAmount(pool.reserve_b, pool.token_b)}</p>
                </div>
              </div>

              <Link to={`/swap?pool=${pool.pool_id}`}>
                <Button variant="outline" className="w-full">
                  Trade on this Pool
                </Button>
              </Link>
            </CardContent>
          </Card>
        )}

        {/* Token Holders */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <Users className="w-4 h-4" />
              Top Holders
            </CardTitle>
          </CardHeader>
          <CardContent>
            {holders.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No holders found</p>
            ) : (
              <div className="space-y-2">
                {holders.slice(0, 10).map((holder, index) => (
                  <div
                    key={holder.address}
                    className="flex flex-col sm:flex-row sm:items-center justify-between p-2 rounded-lg hover:bg-secondary/50 transition-colors gap-1 sm:gap-3"
                  >
                    <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                      <span className="text-xs text-muted-foreground w-5 flex-shrink-0">#{index + 1}</span>
                      <p className="font-mono text-xs truncate">
                        {holder.address.startsWith("Liquidity")
                          ? holder.address
                          : `${holder.address.substring(0, 20)}...`}
                      </p>
                    </div>
                    <div className="flex items-center justify-between sm:justify-end gap-2 sm:gap-4 pl-7 sm:pl-0">
                      <p className="font-mono text-sm">{formatTokenAmount(holder.balance, symbol)}</p>
                      <p className="text-xs text-muted-foreground">{holder.percentage.toFixed(2)}%</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Token Transactions */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <BarChart3 className="w-4 h-4" />
              Recent Transactions
              {transactionCount > 0 && (
                <span className="text-xs text-muted-foreground font-normal">({transactionCount} total)</span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {transactionList.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No transactions found</p>
            ) : (
              <div className="space-y-2">
                {transactionList.slice(0, 20).map((tx) => (
                  <div
                    key={tx.tx_hash}
                    className="flex flex-col sm:flex-row sm:items-center justify-between p-2 rounded-lg hover:bg-secondary/50 transition-colors gap-2"
                  >
                    <div className="flex items-start sm:items-center gap-2 sm:gap-3">
                      <span className={`text-xs px-2 py-0.5 rounded font-medium whitespace-nowrap flex-shrink-0 ${tx.tx_type === 'create_token' ? 'bg-purple-500/20 text-purple-400' :
                          tx.tx_type === 'transfer' ? 'bg-blue-500/20 text-blue-400' :
                            tx.tx_type === 'swap' ? 'bg-green-500/20 text-green-400' :
                              tx.tx_type === 'create_pool' ? 'bg-yellow-500/20 text-yellow-400' :
                                tx.tx_type === 'add_liquidity' ? 'bg-cyan-500/20 text-cyan-400' :
                                  tx.tx_type === 'remove_liquidity' ? 'bg-red-500/20 text-red-400' :
                                    'bg-gray-500/20 text-gray-400'
                        }`}>
                        {tx.tx_type.replace(/_/g, ' ')}
                      </span>
                      <div className="min-w-0">
                        <p className="font-mono text-xs truncate">
                          {tx.from.substring(0, 16)}...
                        </p>
                        <p className="text-xs text-muted-foreground">
                          #{tx.block_height} • {new Date(tx.timestamp < 1e12 ? tx.timestamp * 1000 : tx.timestamp).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center justify-between sm:justify-end gap-2 pl-0 sm:pl-4">
                      <p className="font-mono text-sm font-semibold">{formatTokenAmount(tx.amount, symbol)}</p>
                      <p className="text-xs text-muted-foreground">{symbol}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Creator Info */}
        {metadata?.creator && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Edit2 className="w-4 h-4" />
                Token Creator
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <p className="font-mono text-xs truncate flex-1">{metadata.creator}</p>
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => handleCopy(metadata.creator)}>
                  <Copy className="w-3 h-3" />
                </Button>
              </div>
              <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                <span>Created: {new Date(metadata.created_at).toLocaleDateString()}</span>
                {metadata.updated_at !== metadata.created_at && (
                  <span>Updated: {new Date(metadata.updated_at).toLocaleDateString()}</span>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </main>

      {/* Edit Metadata Dialog */}
      {showEditMetadata && wallet && symbol && (
        <UpdateTokenMetadataDialog
          tokenSymbol={symbol}
          walletPublicKey={wallet.signingPublicKey}
          walletPrivateKey={wallet.signingPrivateKey}
          onClose={() => setShowEditMetadata(false)}
          onSuccess={() => {
            setShowEditMetadata(false);
            fetchTokenData(); // Refresh to show updated metadata
          }}
        />
      )}
    </div>
  );
};

export default TokenExplorer;
