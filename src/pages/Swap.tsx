import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowDownUp, Settings, Info, Loader2, RefreshCw, ChevronDown, AlertTriangle, Shield, Search, X, Star, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TokenIcon } from "@/components/ui/token-icon";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { useXRGEPrice } from "@/hooks/use-xrge-price";
import { formatUsd } from "@/lib/price-service";
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

/** Tokens shown by default without searching — XRGE + major bridged assets */
const MAJOR_TOKENS = new Set(["XRGE", "qETH", "qUSDC"]);

// ─── Token Picker ──────────────────────────────────────────────
interface TokenPickerProps {
  selected: string;
  otherSelected: string;
  tokens: Token[];
  allPoolTokens: string[];
  onSelect: (symbol: string) => void;
  getTokenImage: (symbol: string) => string | undefined;
}

const TokenPicker = ({
  selected,
  otherSelected,
  tokens,
  allPoolTokens,
  onSelect,
  getTokenImage,
}: TokenPickerProps) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setSearch("");
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  const tokensBySymbol = useMemo(() => {
    const map = new Map<string, Token>();
    tokens.forEach((t) => map.set(t.symbol, t));
    return map;
  }, [tokens]);

  // Build the visible list:
  // - No search → show major tokens + tokens with balance
  // - With search → filter ALL pool tokens by search query
  const filteredList = useMemo(() => {
    const query = search.trim().toUpperCase();

    if (!query) {
      // Default: major tokens + tokens user holds
      const visible = new Set<string>();
      MAJOR_TOKENS.forEach((t) => visible.add(t));
      tokens.forEach((t) => {
        if (t.balance > 0) visible.add(t.symbol);
      });
      // Also include selected tokens so they're always visible
      if (selected) visible.add(selected);

      return Array.from(visible)
        .filter((s) => s !== otherSelected)
        .sort((a, b) => {
          // XRGE first, then by balance descending
          if (a === "XRGE") return -1;
          if (b === "XRGE") return 1;
          const balA = tokensBySymbol.get(a)?.balance ?? 0;
          const balB = tokensBySymbol.get(b)?.balance ?? 0;
          return balB - balA;
        });
    }

    // Search mode — search all known pool tokens
    const allSymbols = new Set([...allPoolTokens, ...tokens.map((t) => t.symbol)]);
    return Array.from(allSymbols)
      .filter((s) => s !== otherSelected && s.toUpperCase().includes(query))
      .sort((a, b) => {
        // Exact match first
        if (a.toUpperCase() === query) return -1;
        if (b.toUpperCase() === query) return 1;
        // Then starts-with
        const startsA = a.toUpperCase().startsWith(query);
        const startsB = b.toUpperCase().startsWith(query);
        if (startsA && !startsB) return -1;
        if (!startsA && startsB) return 1;
        // Then by balance
        const balA = tokensBySymbol.get(a)?.balance ?? 0;
        const balB = tokensBySymbol.get(b)?.balance ?? 0;
        return balB - balA;
      });
  }, [search, tokens, allPoolTokens, otherSelected, selected, tokensBySymbol]);

  const selectedToken = tokensBySymbol.get(selected);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 min-w-[120px] max-w-[140px] h-10 px-3 rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors"
      >
        {selected ? (
          <>
            <TokenIcon symbol={selected} size={20} imageUrl={getTokenImage(selected)} />
            <span className="font-medium text-sm truncate">{selected}</span>
          </>
        ) : (
          <span className="text-sm text-muted-foreground">Select</span>
        )}
        <ChevronDown className="w-3.5 h-3.5 ml-auto text-muted-foreground flex-shrink-0" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={() => setOpen(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-sm bg-card rounded-xl border border-border shadow-xl overflow-hidden"
            >
              {/* Header */}
              <div className="flex items-center justify-between p-4 border-b border-border">
                <h3 className="font-semibold text-foreground">Select Token</h3>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setOpen(false)}>
                  <X className="w-4 h-4" />
                </Button>
              </div>

              {/* Search */}
              <div className="p-3 border-b border-border">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    ref={inputRef}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search by name or paste symbol..."
                    className="pl-9 font-mono text-sm"
                  />
                </div>
              </div>

              {/* Quick select — major tokens */}
              {!search && (
                <div className="flex gap-2 px-3 py-2 border-b border-border">
                  {Array.from(MAJOR_TOKENS)
                    .filter((s) => s !== otherSelected)
                    .map((symbol) => (
                      <button
                        key={symbol}
                        onClick={() => {
                          onSelect(symbol);
                          setOpen(false);
                        }}
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                          selected === symbol
                            ? "bg-primary/20 border-primary/50 text-primary"
                            : "bg-muted/50 border-border hover:bg-muted"
                        }`}
                      >
                        <TokenIcon symbol={symbol} size={14} imageUrl={getTokenImage(symbol)} />
                        {symbol}
                      </button>
                    ))}
                </div>
              )}

              {/* Token list */}
              <div className="max-h-[300px] overflow-y-auto">
                {filteredList.length === 0 ? (
                  <div className="p-6 text-center text-muted-foreground text-sm">
                    {search ? `No tokens matching "${search}"` : "No tokens available"}
                  </div>
                ) : (
                  filteredList.map((symbol) => {
                    const token = tokensBySymbol.get(symbol);
                    const bal = token?.balance ?? 0;
                    const isMajor = MAJOR_TOKENS.has(symbol);
                    const hasBalance = bal > 0;

                    return (
                      <button
                        key={symbol}
                        onClick={() => {
                          onSelect(symbol);
                          setOpen(false);
                        }}
                        className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors text-left ${
                          selected === symbol ? "bg-primary/5" : ""
                        }`}
                      >
                        <TokenIcon symbol={symbol} size={32} imageUrl={getTokenImage(symbol)} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium text-sm">{symbol}</span>
                            {isMajor && <Star className="w-3 h-3 text-amber-500" />}
                          </div>
                          {hasBalance && (
                            <p className="text-xs text-muted-foreground flex items-center gap-1">
                              <Wallet className="w-3 h-3" />
                              {formatTokenAmount(bal, symbol)}
                            </p>
                          )}
                        </div>
                        {selected === symbol && (
                          <div className="w-2 h-2 rounded-full bg-primary" />
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};


// ─── Swap Page ──────────────────────────────────────────────────
const Swap = () => {
  const [searchParams] = useSearchParams();
  const urlToken = searchParams.get("token");
  const { getTokenImage } = useTokenMetadata();
  const [tokens, setTokens] = useState<Token[]>([]);
  const [allPoolTokens, setAllPoolTokens] = useState<string[]>([]);
  const [tokenIn, setTokenIn] = useState<string>("XRGE");
  const [tokenOut, setTokenOut] = useState<string>("");
  const [amountIn, setAmountIn] = useState<string>("");
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [slippage, setSlippage] = useState(0.5);
  const [showSettings, setShowSettings] = useState(false);
  const urlTokenApplied = useRef(false);
  
  const [wallet, setWallet] = useState<{ publicKey: string; privateKey: string } | null>(null);
  const { priceUsd: xrgePrice } = useXRGEPrice(60_000);

  // Load wallet
  useEffect(() => {
    const savedWallet = loadUnifiedWallet();
    if (savedWallet?.signingPublicKey && savedWallet?.signingPrivateKey) {
      setWallet({
        publicKey: savedWallet.signingPublicKey,
        privateKey: savedWallet.signingPrivateKey,
      });
    }
  }, []);

  // Fetch tokens
  const fetchTokens = useCallback(async () => {
    if (!wallet) return;
    
    try {
      const baseUrl = getNodeApiBaseUrl();
      if (!baseUrl) return;
      
      const tokenSet = new Set<string>(["XRGE"]);
      let xrgeBalance = 0;
      let tokenBalances: Record<string, number> = {};
      
      const balanceRes = await fetch(`${baseUrl}/balance/${wallet.publicKey}`, {
        headers: getCoreApiHeaders(),
      });
      
      if (balanceRes.ok) {
        const balData = await balanceRes.json();
        xrgeBalance = balData.balance || 0;
        tokenBalances = balData.token_balances || {};
        
        Object.keys(tokenBalances).forEach(symbol => {
          if (tokenBalances[symbol] > 0) tokenSet.add(symbol);
        });
      }
      
      // Fetch all pool tokens
      const poolTokenSet = new Set<string>();
      try {
        const poolsRes = await fetch(`${baseUrl}/pools`, { headers: getCoreApiHeaders() });
        if (poolsRes.ok) {
          const data = await poolsRes.json();
          const pools: Pool[] = data.pools || [];
          pools.forEach(pool => {
            tokenSet.add(pool.token_a);
            tokenSet.add(pool.token_b);
            poolTokenSet.add(pool.token_a);
            poolTokenSet.add(pool.token_b);
          });
        }
      } catch {}
      
      const tokenList: Token[] = Array.from(tokenSet).map(symbol => ({
        symbol,
        name: symbol,
        balance: symbol === "XRGE" ? xrgeBalance : (tokenBalances[symbol] || 0),
      }));
      
      setTokens(tokenList);
      setAllPoolTokens(Array.from(poolTokenSet));
      
      // Apply URL ?token= param on first load
      if (!urlTokenApplied.current && urlToken) {
        urlTokenApplied.current = true;
        const normalizedUrlToken = urlToken.toUpperCase();
        // Pre-select the token from URL
        if (normalizedUrlToken === "XRGE") {
          // If navigating from XRGE, set it as tokenIn and pick first other as tokenOut
          setTokenIn("XRGE");
          const other = tokenList.find(t => t.symbol !== "XRGE");
          if (other) setTokenOut(other.symbol);
        } else {
          // Navigating from a custom token → set it as tokenOut, swap from XRGE into it
          setTokenIn("XRGE");
          setTokenOut(normalizedUrlToken);
        }
      } else if (!tokenOut && tokenList.length > 1) {
        const other = tokenList.find(t => t.symbol !== "XRGE");
        if (other) setTokenOut(other.symbol);
      }
    } catch (e) {
      console.error("Failed to fetch tokens:", e);
    }
  }, [wallet, tokenOut, urlToken]);

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
        headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
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

  const flipTokens = () => {
    const temp = tokenIn;
    setTokenIn(tokenOut);
    setTokenOut(temp);
    setAmountIn("");
    setQuote(null);
  };

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
                  <TokenPicker
                    selected={tokenIn}
                    otherSelected={tokenOut}
                    tokens={tokens}
                    allPoolTokens={allPoolTokens}
                    onSelect={setTokenIn}
                    getTokenImage={getTokenImage}
                  />
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

              {/* Swap direction */}
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
                  <TokenPicker
                    selected={tokenOut}
                    otherSelected={tokenIn}
                    tokens={tokens}
                    allPoolTokens={allPoolTokens}
                    onSelect={setTokenOut}
                    getTokenImage={getTokenImage}
                  />
                </div>
                {tokenOut === "XRGE" && xrgePrice && quote && quote.amount_out > 0 && (
                  <span className="text-xs text-muted-foreground">
                    ≈ {formatUsd(quote.amount_out * xrgePrice)}
                  </span>
                )}
              </div>

              {/* Quote */}
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

          {/* Info */}
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
