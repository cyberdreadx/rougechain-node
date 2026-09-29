import { useState, useEffect, useCallback, useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/ui/empty-state";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, Droplets, TrendingUp, Loader2, Info, Minus, BarChart3, ArrowDownUp, Shield, Search, Coins } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TokenIcon } from "@/components/ui/token-icon";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { getNodeApiBaseUrl, getCoreApiHeaders } from "@/lib/network";
import { loadUnifiedWallet } from "@/lib/unified-wallet";
import { secureCreatePool, secureAddLiquidity, secureRemoveLiquidity } from "@/lib/secure-api";
import { CyberpunkLoader } from "@/components/ui/cyberpunk-loader";
import SwapWidget from "@/components/messenger/SwapWidget";
import { formatTokenAmount, humanToRaw, rawToHuman } from "@/hooks/use-eth-price";
import { useTokenMetadata } from "@/hooks/use-token-metadata";
import { canCollect, computeLpEarnings, type LpEarnings, type LpPoolEvent } from "@/lib/lp-earnings";

interface Pool {
  pool_id: string;
  token_a: string;
  token_b: string;
  reserve_a: number;
  reserve_b: number;
  total_lp_supply: number;
  fee_rate: number;
  created_at: number;
  creator_pub_key: string;
}

interface Token {
  symbol: string;
  balance: number;
}

const Pools = () => {
  const { t } = useTranslation();
  const { getTokenImage } = useTokenMetadata();
  const [pools, setPools] = useState<Pool[]>([]);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [lpBalances, setLpBalances] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  
  // Create pool dialog
  const [showCreatePool, setShowCreatePool] = useState(false);
  const [newTokenA, setNewTokenA] = useState("XRGE");
  const [newTokenB, setNewTokenB] = useState("");
  const [newAmountA, setNewAmountA] = useState("");
  const [newAmountB, setNewAmountB] = useState("");
  
  // Add liquidity dialog
  const [showAddLiquidity, setShowAddLiquidity] = useState(false);
  const [selectedPool, setSelectedPool] = useState<Pool | null>(null);
  const [addAmountA, setAddAmountA] = useState("");
  const [addAmountB, setAddAmountB] = useState("");
  
  // Remove liquidity dialog
  const [showRemoveLiquidity, setShowRemoveLiquidity] = useState(false);
  const [removeAmount, setRemoveAmount] = useState("");

  // Uncollected swap fees per pool (null = history can't explain the position)
  const [earnings, setEarnings] = useState<Record<string, LpEarnings | null>>({});
  const [collectPool, setCollectPool] = useState<Pool | null>(null);
  
  // Swap widget
  const [showSwapWidget, setShowSwapWidget] = useState(false);

  // Search & display
  const [poolSearch, setPoolSearch] = useState("");
  const [showAllPools, setShowAllPools] = useState(false);
  const POOL_DISPLAY_LIMIT = 20;
  
  // Wallet state
  const [wallet, setWallet] = useState<{ publicKey: string; privateKey: string } | null>(null);

  // Load wallet — retry after brief delay to catch app-level extension auto-connect
  useEffect(() => {
    const tryLoad = () => {
      const savedWallet = loadUnifiedWallet();
      if (savedWallet?.signingPublicKey) {
        setWallet({
          publicKey: savedWallet.signingPublicKey,
          privateKey: savedWallet.signingPrivateKey || "",
        });
        return true;
      }
      return false;
    };
    if (!tryLoad()) {
      const retry = setTimeout(tryLoad, 1000);
      return () => clearTimeout(retry);
    }
  }, []);

  // Fetch pools and balances
  const fetchData = useCallback(async () => {
    try {
      const baseUrl = getNodeApiBaseUrl();
      if (!baseUrl) return;
      
      const tokenSet = new Set<string>(["XRGE"]);
      let xrgeBalance = 0;
      let tokenBalances: Record<string, number> = {};
      
      // Get user balances first (if wallet connected)
      let userLpBalances: Record<string, number> = {};
      if (wallet) {
        const balRes = await fetch(`${baseUrl}/balance/${wallet.publicKey}`, {
          headers: getCoreApiHeaders(),
        });
        
        if (balRes.ok) {
          const balData = await balRes.json();
          xrgeBalance = balData.balance || 0;
          tokenBalances = balData.token_balances || {};
          userLpBalances = balData.lp_balances || {};
          
          // Add all tokens the user owns
          Object.keys(tokenBalances).forEach(symbol => {
            if (tokenBalances[symbol] > 0) {
              tokenSet.add(symbol);
            }
          });
        }
      }
      
      // Fetch pools
      let fetchedPools: Pool[] = [];
      try {
        const poolsRes = await fetch(`${baseUrl}/pools`, {
          headers: getCoreApiHeaders(),
        });
        
        if (poolsRes.ok) {
          const data = await poolsRes.json();
          fetchedPools = data.pools || [];
          setPools(fetchedPools);
          
          // Also add tokens from pools
          (data.pools || []).forEach((pool: Pool) => {
            tokenSet.add(pool.token_a);
            tokenSet.add(pool.token_b);
          });
        }
      } catch {
        // Pools endpoint may not exist, continue
        setPools([]);
      }
      
      setTokens(Array.from(tokenSet).map(symbol => ({
        symbol,
        balance: symbol === "XRGE" ? xrgeBalance : (tokenBalances[symbol] || 0),
      })));
      
      // Set LP balances from API
      setLpBalances(userLpBalances);

      // Work out uncollected fees for every pool the wallet provides liquidity to
      if (wallet) {
        const held = fetchedPools.filter((p) => (userLpBalances[p.pool_id] || 0) > 0);
        const entries = await Promise.all(held.map(async (p) => {
          try {
            // Nodes keep a fee ledger per position; ask it first.
            const direct = await fetch(
              `${baseUrl}/pool/${encodeURIComponent(p.pool_id)}/earnings/${encodeURIComponent(wallet.publicKey)}`,
              { headers: getCoreApiHeaders() },
            );
            if (direct.ok) {
              const e = (await direct.json()).earnings;
              return [p.pool_id, e?.tracked
                ? { lpToCollect: e.lpToCollect, earnedA: e.earnedA, earnedB: e.earnedB, growth: e.growth }
                : null] as const;
            }
            // Older nodes: replay the pool's recent events in the browser.
            const res = await fetch(`${baseUrl}/pool/${encodeURIComponent(p.pool_id)}/events?limit=5000`, {
              headers: getCoreApiHeaders(),
            });
            if (!res.ok) return [p.pool_id, null] as const;
            const data = await res.json();
            return [p.pool_id, computeLpEarnings(
              (data.events || []) as LpPoolEvent[], p, [wallet.publicKey], userLpBalances[p.pool_id],
            )] as const;
          } catch {
            return [p.pool_id, null] as const;
          }
        }));
        setEarnings(Object.fromEntries(entries));
      } else {
        setEarnings({});
      }
    } catch (e) {
      console.error("Failed to fetch pools:", e);
    } finally {
      setLoading(false);
    }
  }, [wallet]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Create pool
  const handleCreatePool = async () => {
    if (!wallet || !newTokenA || !newTokenB || !newAmountA || !newAmountB) {
      toast.error("Please fill all fields");
      return;
    }
    
    if (newTokenA === newTokenB) {
      toast.error("Tokens must be different");
      return;
    }
    
    setActionLoading(true);
    try {
      // Use secure client-side signing
      const result = await secureCreatePool(
        wallet.publicKey,
        wallet.privateKey,
        newTokenA,
        newTokenB,
        humanToRaw(parseFloat(newAmountA), newTokenA),
        humanToRaw(parseFloat(newAmountB), newTokenB)
      );
      
      if (result.success) {
        toast.success(`Pool created: ${result.data?.pool_id}`, {
          description: "Signed securely on your device",
        });
        setShowCreatePool(false);
        setNewAmountA("");
        setNewAmountB("");
        fetchData();
      } else {
        toast.error(result.error || "Failed to create pool");
      }
    } catch (e) {
      toast.error("Failed to create pool");
      console.error(e);
    } finally {
      setActionLoading(false);
    }
  };

  // Add liquidity
  const handleAddLiquidity = async () => {
    if (!wallet || !selectedPool || !addAmountA || !addAmountB) {
      toast.error("Please fill all fields");
      return;
    }
    
    setActionLoading(true);
    try {
      // Use secure client-side signing
      const result = await secureAddLiquidity(
        wallet.publicKey,
        wallet.privateKey,
        selectedPool.pool_id,
        humanToRaw(parseFloat(addAmountA), selectedPool.token_a),
        humanToRaw(parseFloat(addAmountB), selectedPool.token_b)
      );
      
      if (result.success) {
        toast.success("Liquidity added successfully", {
          description: "Signed securely on your device",
        });
        setShowAddLiquidity(false);
        setAddAmountA("");
        setAddAmountB("");
        fetchData();
      } else {
        toast.error(result.error || "Failed to add liquidity");
      }
    } catch (e) {
      toast.error("Failed to add liquidity");
      console.error(e);
    } finally {
      setActionLoading(false);
    }
  };

  // Remove liquidity
  const handleRemoveLiquidity = async () => {
    if (!wallet || !selectedPool || !removeAmount) {
      toast.error("Please enter an amount");
      return;
    }
    
    setActionLoading(true);
    try {
      // Use secure client-side signing
      const result = await secureRemoveLiquidity(
        wallet.publicKey,
        wallet.privateKey,
        selectedPool.pool_id,
        Math.floor(parseFloat(removeAmount))
      );
      
      if (result.success) {
        toast.success("Liquidity removed successfully", {
          description: "Signed securely on your device",
        });
        setShowRemoveLiquidity(false);
        setRemoveAmount("");
        fetchData();
      } else {
        toast.error(result.error || "Failed to remove liquidity");
      }
    } catch (e) {
      toast.error("Failed to remove liquidity");
      console.error(e);
    } finally {
      setActionLoading(false);
    }
  };

  // Collect fees: remove exactly the LP tokens that fees have added, leaving the deposit in place
  const handleCollectFees = async () => {
    const pool = collectPool;
    const earned = pool ? earnings[pool.pool_id] : null;
    if (!wallet || !pool || !canCollect(earned)) return;
    setActionLoading(true);
    try {
      const result = await secureRemoveLiquidity(wallet.publicKey, wallet.privateKey, pool.pool_id, earned.lpToCollect);
      if (result.success) {
        toast.success("Fees collected", {
          description: `${formatNumber(earned.earnedA, pool.token_a)} ${pool.token_a} + ${formatNumber(earned.earnedB, pool.token_b)} ${pool.token_b} sent to your wallet`,
        });
        setCollectPool(null);
        fetchData();
      } else {
        toast.error(result.error || "Couldn't collect fees");
      }
    } catch (e) {
      toast.error("Couldn't collect fees");
      console.error(e);
    } finally {
      setActionLoading(false);
    }
  };

  // Calculate quote for proportional liquidity
  // Quote the paired human amount to keep an existing pool's ratio. Reserves are raw, so convert
  // them to human first — otherwise a mixed-decimal pair (e.g. XRGE 0-dec / qUSDC 6-dec) quotes
  // off by the decimals gap. Returns 0 for an empty pool (first liquidity sets the ratio freely).
  const calculateQuote = (pool: Pool, amountA: number, isTokenA: boolean) => {
    if (!pool.reserve_a || !pool.reserve_b) return 0;
    const ra = rawToHuman(pool.reserve_a, pool.token_a);
    const rb = rawToHuman(pool.reserve_b, pool.token_b);
    if (!ra || !rb) return 0;
    return isTokenA ? (amountA * rb) / ra : (amountA * ra) / rb;
  };

  const formatNumber = (n: number, symbol?: string) => {
    return formatTokenAmount(n, symbol);
  };

  const sortedPools = useMemo(() => {
    const sorted = [...pools].sort((a, b) => (b.reserve_a + b.reserve_b) - (a.reserve_a + a.reserve_b));
    if (poolSearch.trim()) {
      const q = poolSearch.trim().toUpperCase();
      return sorted.filter(p => p.token_a.toUpperCase().includes(q) || p.token_b.toUpperCase().includes(q) || p.pool_id.toUpperCase().includes(q));
    }
    if (!showAllPools) return sorted.slice(0, POOL_DISPLAY_LIMIT);
    return sorted;
  }, [pools, poolSearch, showAllPools]);


  // Show cyberpunk loader during pool operations
  if (actionLoading) {
    return (
      <CyberpunkLoader
        message="Processing Pool Transaction"
      />
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <div className="container max-w-4xl mx-auto px-4 py-8 flex-grow">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-6"
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="hud-label mb-1.5">{t("visual.eyebrow.pools")}</p>
              <div className="flex items-center gap-2">
                <h1 className="page-title">Liquidity Pools</h1>
                <div className="flex items-center gap-1 text-xs text-green-500 bg-green-500/10 px-2 py-0.5 rounded-full whitespace-nowrap">
                  <Shield className="w-3 h-3" />
                  <span>Secure</span>
                </div>
              </div>
              <p className="text-muted-foreground text-sm">Provide liquidity and earn fees</p>
            </div>
            <div className="flex gap-2 shrink-0">
              <Button
                variant="default"
                size="sm"
                onClick={() => setShowSwapWidget(true)}
                disabled={!wallet}
              >
                <ArrowDownUp className="w-4 h-4 mr-1.5" />
                Swap
              </Button>
              <Dialog open={showCreatePool} onOpenChange={setShowCreatePool}>
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm" disabled={!wallet}>
                    <Plus className="w-4 h-4 mr-1.5" />
                    New Pool
                  </Button>
                </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create New Pool</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Token A</Label>
                      <Select value={newTokenA} onValueChange={setNewTokenA}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {tokens.map(t => (
                            <SelectItem key={t.symbol} value={t.symbol} disabled={t.symbol === newTokenB}>
                              {t.symbol} ({formatNumber(t.balance, t.symbol)})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        type="number"
                        placeholder="Amount"
                        value={newAmountA}
                        onChange={(e) => setNewAmountA(e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Token B</Label>
                      <Select value={newTokenB} onValueChange={setNewTokenB}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select" />
                        </SelectTrigger>
                        <SelectContent>
                          {tokens.map(t => (
                            <SelectItem key={t.symbol} value={t.symbol} disabled={t.symbol === newTokenA}>
                              {t.symbol} ({formatNumber(t.balance, t.symbol)})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        type="number"
                        placeholder="Amount"
                        value={newAmountB}
                        onChange={(e) => setNewAmountB(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="bg-muted/50 rounded-lg p-3 text-sm text-muted-foreground">
                    <Info className="w-4 h-4 inline mr-2" />
                    Pool creation fee: 10 XRGE. You will receive LP tokens representing your share.
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setShowCreatePool(false)}>
                    Cancel
                  </Button>
                  <Button onClick={handleCreatePool} disabled={actionLoading}>
                    {actionLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                    Create Pool
                  </Button>
                </DialogFooter>
              </DialogContent>
              </Dialog>
            </div>
          </div>

          {/* Pool Search */}
          {pools.length > 0 && (
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search pools by token symbol..."
                value={poolSearch}
                onChange={e => { setPoolSearch(e.target.value); setShowAllPools(true); }}
                className="pl-9"
              />
            </div>
          )}

          {/* Pool List */}
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
            </div>
          ) : pools.length === 0 ? (
            <Card className="glass-card">
              <EmptyState
                icon={Droplets}
                title={t("visual.empty.pools.title")}
                hint={t("visual.empty.pools.hint")}
                action={
                  <Button onClick={() => setShowCreatePool(true)} disabled={!wallet} className="btn-neon">
                    <Plus className="w-4 h-4 mr-2" />
                    {t("visual.empty.pools.cta")}
                  </Button>
                }
              />
            </Card>
          ) : (
            <div className="space-y-4">
              {sortedPools.map((pool) => (
                <Card key={pool.pool_id} className="bg-card/50 backdrop-blur border-primary/20 glass-card hover-lift">
                  <CardHeader className="pb-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="flex -space-x-2 shrink-0">
                          <TokenIcon symbol={pool.token_a} size={32} imageUrl={getTokenImage(pool.token_a)} />
                          <TokenIcon symbol={pool.token_b} size={32} imageUrl={getTokenImage(pool.token_b)} />
                        </div>
                        <div className="min-w-0">
                          <CardTitle className="text-lg truncate">{pool.token_a}/{pool.token_b}</CardTitle>
                          <CardDescription>Fee: {(pool.fee_rate * 100).toFixed(1)}%</CardDescription>
                        </div>
                      </div>
                      <Badge variant="secondary" className="text-xs shrink-0">
                        TVL: {formatNumber(pool.reserve_a, pool.token_a)} + {formatNumber(pool.reserve_b, pool.token_b)}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                      <div>
                        <p className="text-muted-foreground">{pool.token_a} Reserve</p>
                        <p className="font-mono font-medium break-all">{formatNumber(pool.reserve_a, pool.token_a)}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">{pool.token_b} Reserve</p>
                        <p className="font-mono font-medium break-all">{formatNumber(pool.reserve_b, pool.token_b)}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">LP Supply</p>
                        <p className="font-mono font-medium break-all">{formatNumber(pool.total_lp_supply)}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Your LP</p>
                        <p className="font-mono font-medium break-all">{formatNumber(lpBalances[pool.pool_id] || 0)}</p>
                      </div>
                    </div>

                    {wallet && (lpBalances[pool.pool_id] || 0) > 0 && (() => {
                      const earned = earnings[pool.pool_id];
                      return (
                        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm">
                          <div className="min-w-0">
                            <p className="text-muted-foreground text-xs">Uncollected fees</p>
                            {earned === undefined ? (
                              <p className="text-muted-foreground">Calculating…</p>
                            ) : earned === null ? (
                              <p className="text-muted-foreground">Unavailable for this position</p>
                            ) : (
                              <p className="font-mono font-medium break-all">
                                {formatNumber(earned.earnedA, pool.token_a)} {pool.token_a} + {formatNumber(earned.earnedB, pool.token_b)} {pool.token_b}
                              </p>
                            )}
                          </div>
                          <Button
                            size="sm"
                            onClick={() => setCollectPool(pool)}
                            disabled={!canCollect(earned)}
                          >
                            <Coins className="w-3 h-3 mr-1" />
                            Collect fees
                          </Button>
                        </div>
                      );
                    })()}
                    
                    <div className="flex flex-wrap gap-2 mt-4">
                      <Link to={`/pool/${pool.pool_id}`}>
                        <Button size="sm" variant="secondary">
                          <BarChart3 className="w-3 h-3 mr-1" />
                          Chart
                        </Button>
                      </Link>
                      {wallet && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setSelectedPool(pool);
                              setShowAddLiquidity(true);
                            }}
                          >
                            <Plus className="w-3 h-3 mr-1" />
                            Add
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setSelectedPool(pool);
                              setShowRemoveLiquidity(true);
                            }}
                            disabled={!lpBalances[pool.pool_id]}
                          >
                            <Minus className="w-3 h-3 mr-1" />
                            Remove
                          </Button>
                        </>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
              {!showAllPools && !poolSearch && pools.length > POOL_DISPLAY_LIMIT && (
                <div className="text-center pt-2">
                  <Button variant="ghost" size="sm" onClick={() => setShowAllPools(true)}>
                    Show all {pools.length} pools
                  </Button>
                </div>
              )}
              {poolSearch && sortedPools.length === 0 && (
                <EmptyState compact icon={Search} title={t("visual.empty.poolSearch.title")} hint={t("visual.empty.poolSearch.hint", { query: poolSearch })} />
              )}
            </div>
          )}

          {/* Add Liquidity Dialog */}
          <Dialog open={showAddLiquidity} onOpenChange={setShowAddLiquidity}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add Liquidity to {selectedPool?.pool_id}</DialogTitle>
              </DialogHeader>
              {selectedPool && (
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label>{selectedPool.token_a} Amount</Label>
                    <Input
                      type="number"
                      placeholder="0"
                      value={addAmountA}
                      onChange={(e) => {
                        setAddAmountA(e.target.value);
                        // Only auto-fill the other side when the pool already has a ratio.
                        // For an empty (first-seed) pool, leave the other field alone.
                        if (selectedPool.reserve_a > 0 && selectedPool.reserve_b > 0) {
                          const quote = calculateQuote(selectedPool, parseFloat(e.target.value) || 0, true);
                          setAddAmountB(quote > 0 ? String(Number(quote.toFixed(8))) : "");
                        }
                      }}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{selectedPool.token_b} Amount</Label>
                    <Input
                      type="number"
                      placeholder="0"
                      value={addAmountB}
                      onChange={(e) => {
                        setAddAmountB(e.target.value);
                        if (selectedPool.reserve_a > 0 && selectedPool.reserve_b > 0) {
                          const quote = calculateQuote(selectedPool, parseFloat(e.target.value) || 0, false);
                          setAddAmountA(quote > 0 ? String(Number(quote.toFixed(8))) : "");
                        }
                      }}
                    />
                  </div>
                  <div className="bg-muted/50 rounded-lg p-3 text-sm text-muted-foreground">
                    <Info className="w-4 h-4 inline mr-2" />
                    Add liquidity in the current pool ratio to minimize price impact.
                  </div>
                </div>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => setShowAddLiquidity(false)}>
                  Cancel
                </Button>
                <Button onClick={handleAddLiquidity} disabled={actionLoading}>
                  {actionLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  Add Liquidity
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Remove Liquidity Dialog */}
          <Dialog open={showRemoveLiquidity} onOpenChange={setShowRemoveLiquidity}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Remove Liquidity from {selectedPool?.pool_id}</DialogTitle>
              </DialogHeader>
              {selectedPool && (
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label>LP Token Amount</Label>
                    <Input
                      type="number"
                      placeholder="0"
                      value={removeAmount}
                      onChange={(e) => setRemoveAmount(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Your balance: {formatNumber(lpBalances[selectedPool.pool_id] || 0)} LP
                    </p>
                  </div>
                  {removeAmount && parseFloat(removeAmount) > 0 && (
                    <div className="bg-muted/50 rounded-lg p-3 text-sm">
                      <p className="text-muted-foreground mb-2">You will receive approximately:</p>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <span className="font-medium">
                            {formatNumber(
                              (parseFloat(removeAmount) / selectedPool.total_lp_supply) * selectedPool.reserve_a,
                              selectedPool.token_a
                            )}
                          </span>{" "}
                          {selectedPool.token_a}
                        </div>
                        <div>
                          <span className="font-medium">
                            {formatNumber(
                              (parseFloat(removeAmount) / selectedPool.total_lp_supply) * selectedPool.reserve_b,
                              selectedPool.token_b
                            )}
                          </span>{" "}
                          {selectedPool.token_b}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => setShowRemoveLiquidity(false)}>
                  Cancel
                </Button>
                <Button onClick={handleRemoveLiquidity} disabled={actionLoading}>
                  {actionLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  Remove Liquidity
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Collect Fees Dialog */}
          <Dialog open={!!collectPool} onOpenChange={(open) => { if (!open) setCollectPool(null); }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Collect fees from {collectPool?.pool_id}</DialogTitle>
              </DialogHeader>
              {collectPool && canCollect(earnings[collectPool.pool_id]) && (() => {
                const earned = earnings[collectPool.pool_id]!;
                return (
                  <div className="space-y-4 py-4 text-sm">
                    <div className="bg-muted/50 rounded-lg p-3">
                      <p className="text-muted-foreground mb-2">You will receive:</p>
                      <div className="grid grid-cols-2 gap-2">
                        <div><span className="font-medium">{formatNumber(earned.earnedA, collectPool.token_a)}</span> {collectPool.token_a}</div>
                        <div><span className="font-medium">{formatNumber(earned.earnedB, collectPool.token_b)}</span> {collectPool.token_b}</div>
                      </div>
                    </div>
                    <p className="text-muted-foreground">
                      Swap fees have grown your position by {(earned.growth * 100).toFixed(4)}% since you deposited.
                      Collecting withdraws {formatNumber(earned.lpToCollect)} LP — just that growth — and your deposit
                      stays in the pool earning. If the price has moved, the token mix you get back follows the pool's
                      current ratio.
                    </p>
                  </div>
                );
              })()}
              <DialogFooter>
                <Button variant="outline" onClick={() => setCollectPool(null)}>
                  Cancel
                </Button>
                <Button onClick={handleCollectFees} disabled={actionLoading}>
                  {actionLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  Collect fees
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Info Section */}
          <Card className="bg-muted/30">
            <CardContent className="pt-4">
              <div className="flex items-start gap-3">
                <TrendingUp className="w-5 h-5 text-primary mt-0.5" />
                <div className="text-sm text-muted-foreground">
                  <p className="font-medium text-foreground mb-1">Earn from every swap</p>
                  <p>
                    Liquidity providers earn 0.3% on all trades proportional to their share of the pool.
                    Fees are automatically compounded into the pool — use Collect fees to withdraw just your
                    earnings and keep your deposit in place.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* Swap widget modal */}
      <AnimatePresence>
        {showSwapWidget && wallet && (
          <SwapWidget
            walletPublicKey={wallet.publicKey}
            walletPrivateKey={wallet.privateKey}
            onClose={() => setShowSwapWidget(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
};

export default Pools;
