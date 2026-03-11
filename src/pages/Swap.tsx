import { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { ArrowDownUp, Settings, Info, Loader2, RefreshCw, ChevronDown, AlertTriangle, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TokenIcon } from "@/components/ui/token-icon";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { useXRGEPrice } from "@/hooks/use-xrge-price";
import { formatUsd } from "@/lib/price-service";
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
} from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { getNodeApiBaseUrl, getCoreApiHeaders } from "@/lib/network";
import { loadUnifiedWallet } from "@/lib/unified-wallet";
import { secureSwap } from "@/lib/secure-api";
import { formatTokenAmount, isQeth, humanToQeth, qethToHuman } from "@/hooks/use-eth-price";
import { CyberpunkLoader } from "@/components/ui/cyberpunk-loader";
import { useTokenMetadata } from "@/hooks/use-token-metadata";

interface Token {
  symbol: string;
  name: string;
  balance: number;
}

interface SwapQuote {
  success: boolean;
  amount_out: number;
  price_impact: number;
  path: string[];
  pools: string[];
}

interface Pool {
  pool_id: string;
  token_a: string;
  token_b: string;
  reserve_a: number;
  reserve_b: number;
  total_lp_supply: number;
  fee_rate: number;
}


const Swap = () => {
  const { getTokenImage } = useTokenMetadata();
  const [tokens, setTokens] = useState<Token[]>([]);
  const [tokenIn, setTokenIn] = useState<string>("XRGE");
  const [tokenOut, setTokenOut] = useState<string>("");
  const [amountIn, setAmountIn] = useState<string>("");
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [slippage, setSlippage] = useState(0.5); // 0.5%
  const [showSettings, setShowSettings] = useState(false);
  
  // Wallet state (simplified - would come from wallet context)
  const [wallet, setWallet] = useState<{ publicKey: string; privateKey: string } | null>(null);
  
  // Fetch XRGE price for USD display
  const { priceUsd: xrgePrice } = useXRGEPrice(60_000);

  // Load wallet from localStorage
  useEffect(() => {
    const savedWallet = loadUnifiedWallet();
    if (savedWallet && savedWallet.signingPublicKey && savedWallet.signingPrivateKey) {
      setWallet({
        publicKey: savedWallet.signingPublicKey,
        privateKey: savedWallet.signingPrivateKey,
      });
    }
  }, []);

  // Fetch available tokens
  const fetchTokens = useCallback(async () => {
    if (!wallet) return;
    
    try {
      const baseUrl = getNodeApiBaseUrl();
      if (!baseUrl) return;
      
      // Start with tokens the user owns
      const tokenSet = new Set<string>(["XRGE"]);
      let xrgeBalance = 0;
      let tokenBalances: Record<string, number> = {};
      
      // Get user balances first
      const balanceRes = await fetch(`${baseUrl}/balance/${wallet.publicKey}`, {
        headers: getCoreApiHeaders(),
      });
      
      if (balanceRes.ok) {
        const balData = await balanceRes.json();
        xrgeBalance = balData.balance || 0;
        tokenBalances = balData.token_balances || {};
        
        // Add all tokens the user owns
        Object.keys(tokenBalances).forEach(symbol => {
          if (tokenBalances[symbol] > 0) {
            tokenSet.add(symbol);
          }
        });
      }
      
      // Also get tokens from pools
      try {
        const poolsRes = await fetch(`${baseUrl}/pools`, {
          headers: getCoreApiHeaders(),
        });
        
        if (poolsRes.ok) {
          const data = await poolsRes.json();
          const pools: Pool[] = data.pools || [];
          
          pools.forEach(pool => {
            tokenSet.add(pool.token_a);
            tokenSet.add(pool.token_b);
          });
        }
      } catch {
        // Pools endpoint may not exist yet, continue
      }
      
      const tokenList: Token[] = Array.from(tokenSet).map(symbol => ({
        symbol,
        name: symbol,
        balance: symbol === "XRGE" ? xrgeBalance : (tokenBalances[symbol] || 0),
      }));
      
      setTokens(tokenList);
      
      // Set default tokenOut if not set
      if (!tokenOut && tokenList.length > 1) {
        const other = tokenList.find(t => t.symbol !== "XRGE");
        if (other) setTokenOut(other.symbol);
      }
    } catch (e) {
      console.error("Failed to fetch tokens:", e);
    }
  }, [wallet, tokenOut]);

  useEffect(() => {
    fetchTokens();
    const interval = setInterval(fetchTokens, 30000);
    return () => clearInterval(interval);
  }, [fetchTokens]);

  // Get swap quote
  const getQuote = useCallback(async () => {
    if (!amountIn || !tokenIn || !tokenOut || tokenIn === tokenOut) {
      setQuote(null);
      return;
    }
    
    const amount = parseFloat(amountIn);
    if (isNaN(amount) || amount <= 0) {
      setQuote(null);
      return;
    }
    
    setQuoteLoading(true);
    try {
      const baseUrl = getNodeApiBaseUrl();
      if (!baseUrl) return;
      
      const res = await fetch(`${baseUrl}/swap/quote`, {
        method: "POST",
        headers: {
          ...getCoreApiHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          token_in: tokenIn,
          token_out: tokenOut,
          amount_in: Math.floor(isQeth(tokenIn) ? humanToQeth(amount) : amount),
        }),
      });
      
      if (res.ok) {
        const data = await res.json();
        setQuote(data);
      } else {
        setQuote(null);
      }
    } catch (e) {
      console.error("Failed to get quote:", e);
      setQuote(null);
    } finally {
      setQuoteLoading(false);
    }
  }, [amountIn, tokenIn, tokenOut]);

  useEffect(() => {
    const debounce = setTimeout(getQuote, 300);
    return () => clearTimeout(debounce);
  }, [getQuote]);

  // Swap tokens direction
  const flipTokens = () => {
    const temp = tokenIn;
    setTokenIn(tokenOut);
    setTokenOut(temp);
    setAmountIn("");
    setQuote(null);
  };

  // Execute swap
  const executeSwap = async () => {
    if (!wallet || !quote || !amountIn) {
      toast.error("Please connect wallet and get a quote first");
      return;
    }
    
    const amount = parseFloat(amountIn);
    const rawAmountIn = Math.floor(isQeth(tokenIn) ? humanToQeth(amount) : amount);
    const minOut = Math.floor(quote.amount_out * (1 - slippage / 100));
    
    setLoading(true);
    try {
      const result = await secureSwap(
        wallet.publicKey,
        wallet.privateKey,
        tokenIn,
        tokenOut,
        rawAmountIn,
        minOut
      );
      
      if (result.success) {
        toast.success(`Swap submitted: ${amount} ${tokenIn} → ~${formatTokenAmount(quote.amount_out, tokenOut)} ${tokenOut}`, {
          description: "Signed securely on your device",
        });
        setAmountIn("");
        setQuote(null);
        fetchTokens();
      } else {
        toast.error(result.error || "Swap failed");
      }
    } catch (e) {
      toast.error("Failed to execute swap");
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const tokenInData = tokens.find(t => t.symbol === tokenIn);
  const tokenOutData = tokens.find(t => t.symbol === tokenOut);

  // Show cyberpunk loader when swapping
  if (loading) {
    return (
      <CyberpunkLoader
        message="Executing Quantum Swap"
        tokenIn={tokenIn}
        tokenOut={tokenOut}
      />
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="container max-w-lg mx-auto px-4 py-8 flex-grow">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-6"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold">Swap</h1>
              <div className="flex items-center gap-1 text-xs text-green-500 bg-green-500/10 px-2 py-0.5 rounded-full">
                <Shield className="w-3 h-3" />
                <span>Secure</span>
              </div>
            </div>
            <Dialog open={showSettings} onOpenChange={setShowSettings}>
              <DialogTrigger asChild>
                <Button variant="ghost" size="icon">
                  <Settings className="w-5 h-5" />
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Swap Settings</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div>
                    <Label>Slippage Tolerance: {slippage}%</Label>
                    <Slider
                      value={[slippage]}
                      onValueChange={([v]) => setSlippage(v)}
                      min={0.1}
                      max={5}
                      step={0.1}
                      className="mt-2"
                    />
                    <div className="flex gap-2 mt-2">
                      {[0.5, 1, 2, 3].map(v => (
                        <Button
                          key={v}
                          variant={slippage === v ? "default" : "outline"}
                          size="sm"
                          onClick={() => setSlippage(v)}
                        >
                          {v}%
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </div>

          <Card className="bg-card/50 backdrop-blur border-primary/20">
            <CardContent className="pt-6 space-y-4">
              {/* Token In */}
              <div className="space-y-2">
                <div className="flex justify-between text-sm text-muted-foreground">
                  <span>You pay</span>
                  <span>Balance: {tokenInData ? formatTokenAmount(tokenInData.balance, tokenIn) : 0}</span>
                </div>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    placeholder="0"
                    value={amountIn}
                    onChange={(e) => setAmountIn(e.target.value)}
                    className="text-2xl font-mono flex-grow"
                  />
                  <Select value={tokenIn} onValueChange={setTokenIn}>
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {tokens.map(t => (
                        <SelectItem key={t.symbol} value={t.symbol} disabled={t.symbol === tokenOut}>
                          <div className="flex items-center gap-2">
                            <TokenIcon symbol={t.symbol} size={16} imageUrl={getTokenImage(t.symbol)} />
                            <span>{t.symbol}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex justify-between items-center">
                  {tokenIn === "XRGE" && xrgePrice && amountIn && parseFloat(amountIn) > 0 ? (
                    <span className="text-xs text-muted-foreground">
                      ≈ {formatUsd(parseFloat(amountIn) * xrgePrice)}
                    </span>
                  ) : (
                    <span />
                  )}
                  {tokenInData && parseFloat(amountIn) > (isQeth(tokenIn) ? qethToHuman(tokenInData.balance) : tokenInData.balance) && (
                    <p className="text-xs text-destructive">Insufficient balance</p>
                  )}
                </div>
              </div>

              {/* Swap Button */}
              <div className="flex justify-center">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={flipTokens}
                  className="rounded-full bg-secondary hover:bg-secondary/80"
                >
                  <ArrowDownUp className="w-4 h-4" />
                </Button>
              </div>

              {/* Token Out */}
              <div className="space-y-2">
                <div className="flex justify-between text-sm text-muted-foreground">
                  <span>You receive</span>
                  <span>Balance: {tokenOutData ? formatTokenAmount(tokenOutData.balance, tokenOut) : 0}</span>
                </div>
                <div className="flex gap-2">
                  <Input
                    type="text"
                    placeholder="0"
                    value={quote ? formatTokenAmount(quote.amount_out, tokenOut) : ""}
                    readOnly
                    className="text-2xl font-mono flex-grow bg-muted/50"
                  />
                  <Select value={tokenOut} onValueChange={setTokenOut}>
                    <SelectTrigger className="w-32">
                      <SelectValue placeholder="Select" />
                    </SelectTrigger>
                    <SelectContent>
                      {tokens.map(t => (
                        <SelectItem key={t.symbol} value={t.symbol} disabled={t.symbol === tokenIn}>
                          <div className="flex items-center gap-2">
                            <TokenIcon symbol={t.symbol} size={16} imageUrl={getTokenImage(t.symbol)} />
                            <span>{t.symbol}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {tokenOut === "XRGE" && xrgePrice && quote && quote.amount_out > 0 && (
                  <span className="text-xs text-muted-foreground">
                    ≈ {formatUsd(quote.amount_out * xrgePrice)}
                  </span>
                )}
              </div>

              {/* Quote Info */}
              {quoteLoading && (
                <div className="flex items-center justify-center py-2">
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  <span className="text-sm text-muted-foreground">Getting quote...</span>
                </div>
              )}

              {quote && !quoteLoading && (
                <div className="bg-secondary/50 rounded-lg p-3 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Rate</span>
                    <span>1 {tokenIn} ≈ {(() => {
                      const rawIn = isQeth(tokenIn) ? humanToQeth(parseFloat(amountIn)) : parseFloat(amountIn);
                      const humanOut = isQeth(tokenOut) ? qethToHuman(quote.amount_out) : quote.amount_out;
                      const humanIn = isQeth(tokenIn) ? parseFloat(amountIn) : rawIn;
                      return (humanOut / humanIn).toFixed(4);
                    })()} {tokenOut}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Price Impact</span>
                    <span className={quote.price_impact > 3 ? "text-destructive" : ""}>
                      {quote.price_impact.toFixed(2)}%
                      {quote.price_impact > 3 && <AlertTriangle className="w-3 h-3 inline ml-1" />}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Minimum received</span>
                    <span>{formatTokenAmount(Math.floor(quote.amount_out * (1 - slippage / 100)), tokenOut)} {tokenOut}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Route</span>
                    <span className="text-xs truncate max-w-[200px] sm:max-w-none">{quote.path.join(" → ")}</span>
                  </div>
                </div>
              )}

              {/* Swap Button */}
              <Button
                onClick={executeSwap}
                disabled={!wallet || !quote || loading || parseFloat(amountIn) > (tokenInData ? (isQeth(tokenIn) ? qethToHuman(tokenInData.balance) : tokenInData.balance) : 0)}
                className="w-full h-12 text-lg"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    Swapping...
                  </>
                ) : !wallet ? (
                  "Connect Wallet"
                ) : !amountIn ? (
                  "Enter Amount"
                ) : !quote ? (
                  "No Route Found"
                ) : parseFloat(amountIn) > (tokenInData ? (isQeth(tokenIn) ? qethToHuman(tokenInData.balance) : tokenInData.balance) : 0) ? (
                  "Insufficient Balance"
                ) : (
                  "Swap"
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Info Card */}
          <Card className="bg-muted/30">
            <CardContent className="pt-4">
              <div className="flex items-start gap-3">
                <Info className="w-5 h-5 text-primary mt-0.5" />
                <div className="text-sm text-muted-foreground">
                  <p>
                    Swaps use an automated market maker (AMM) with a 0.3% fee.
                    Fees go to liquidity providers.
                  </p>
                  <p className="mt-2">
                    Multi-hop swaps are supported for better rates through multiple pools.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
};

export default Swap;
