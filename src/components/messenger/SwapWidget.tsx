import { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { ArrowDownUp, X, Loader2, AlertTriangle, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { getNodeApiBaseUrl, getCoreApiHeaders } from "@/lib/network";
import { secureSwap } from "@/lib/secure-api";
import { CyberpunkLoader } from "@/components/ui/cyberpunk-loader";
import xrgeLogo from "@/assets/xrge-logo.webp";

interface Token {
  symbol: string;
  balance: number;
}

interface SwapQuote {
  success: boolean;
  amount_out: number;
  price_impact: number;
  path: string[];
}

interface SwapWidgetProps {
  walletPublicKey: string;
  walletPrivateKey: string;
  onClose: () => void;
}

const TokenIcon = ({ symbol, size = 16 }: { symbol: string; size?: number }) => {
  if (symbol === "XRGE") {
    return <img src={xrgeLogo} alt="XRGE" className="rounded-full" style={{ width: size, height: size }} />;
  }
  return (
    <div 
      className="rounded-full bg-primary/20 flex items-center justify-center text-xs font-bold"
      style={{ width: size, height: size }}
    >
      {symbol.charAt(0)}
    </div>
  );
};

const SwapWidget = ({ walletPublicKey, walletPrivateKey, onClose }: SwapWidgetProps) => {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [tokenIn, setTokenIn] = useState<string>("XRGE");
  const [tokenOut, setTokenOut] = useState<string>("");
  const [amountIn, setAmountIn] = useState<string>("");
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [slippage, setSlippage] = useState(0.5);

  // Fetch tokens
  const fetchTokens = useCallback(async () => {
    try {
      const baseUrl = getNodeApiBaseUrl();
      if (!baseUrl) return;

      const tokenSet = new Set<string>(["XRGE"]);
      let tokenBalances: Record<string, number> = {};
      let xrgeBalance = 0;

      // Get balances
      const balanceRes = await fetch(`${baseUrl}/balance/${walletPublicKey}`, {
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

      // Get pool tokens
      try {
        const poolsRes = await fetch(`${baseUrl}/pools`, { headers: getCoreApiHeaders() });
        if (poolsRes.ok) {
          const data = await poolsRes.json();
          (data.pools || []).forEach((pool: { token_a: string; token_b: string }) => {
            tokenSet.add(pool.token_a);
            tokenSet.add(pool.token_b);
          });
        }
      } catch {}

      const tokenList = Array.from(tokenSet).map(symbol => ({
        symbol,
        balance: symbol === "XRGE" ? xrgeBalance : (tokenBalances[symbol] || 0),
      }));

      setTokens(tokenList);

      if (!tokenOut && tokenList.length > 1) {
        const other = tokenList.find(t => t.symbol !== "XRGE");
        if (other) setTokenOut(other.symbol);
      }
    } catch (e) {
      console.error("Failed to fetch tokens:", e);
    }
  }, [walletPublicKey, tokenOut]);

  useEffect(() => {
    fetchTokens();
  }, [fetchTokens]);

  // Get quote
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
          amount_in: Math.floor(amount),
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          setQuote({
            success: true,
            amount_out: data.amount_out,
            price_impact: data.price_impact || 0,
            path: data.path || [],
          });
        } else {
          setQuote(null);
        }
      }
    } catch (e) {
      console.error("Quote failed:", e);
      setQuote(null);
    } finally {
      setQuoteLoading(false);
    }
  }, [amountIn, tokenIn, tokenOut]);

  useEffect(() => {
    const timer = setTimeout(getQuote, 500);
    return () => clearTimeout(timer);
  }, [getQuote]);

  const handleSwap = async () => {
    if (!quote || !amountIn) return;

    setLoading(true);
    try {
      const amount = parseFloat(amountIn);
      const minOut = Math.floor(quote.amount_out * (1 - slippage / 100));

      // Use secure client-side signing - private key never leaves the browser
      const result = await secureSwap(
        walletPublicKey,
        walletPrivateKey,
        tokenIn,
        tokenOut,
        Math.floor(amount),
        minOut
      );

      if (result.success) {
        toast.success(`Swapped ${amount} ${tokenIn} → ~${quote.amount_out.toFixed(4)} ${tokenOut}`, {
          description: "Signed securely on your device",
        });
        setAmountIn("");
        setQuote(null);
        fetchTokens();
      } else {
        toast.error(result.error || "Swap failed");
      }
    } catch (e) {
      toast.error("Swap failed");
    } finally {
      setLoading(false);
    }
  };

  const swapTokens = () => {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setAmountIn("");
    setQuote(null);
  };

  const tokenInData = tokens.find(t => t.symbol === tokenIn);
  const insufficientBalance = tokenInData && parseFloat(amountIn || "0") > tokenInData.balance;

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
        className="w-full max-w-sm bg-card border border-border rounded-xl shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <ArrowDownUp className="w-5 h-5 text-primary" />
            <span className="font-semibold">Quick Swap</span>
            <div className="flex items-center gap-1 text-xs text-green-500 bg-green-500/10 px-2 py-0.5 rounded-full">
              <Shield className="w-3 h-3" />
              <span>Secure</span>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          {/* From */}
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <Label>From</Label>
              {tokenInData && (
                <span className="text-muted-foreground text-xs">
                  Balance: {tokenInData.balance.toFixed(2)}
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <Input
                type="number"
                placeholder="0.00"
                value={amountIn}
                onChange={(e) => setAmountIn(e.target.value)}
                className="flex-1"
              />
              <Select value={tokenIn} onValueChange={setTokenIn}>
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {tokens.map(t => (
                    <SelectItem key={t.symbol} value={t.symbol} disabled={t.symbol === tokenOut}>
                      <div className="flex items-center gap-2">
                        <TokenIcon symbol={t.symbol} />
                        <span>{t.symbol}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {insufficientBalance && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> Insufficient balance
              </p>
            )}
          </div>

          {/* Swap direction */}
          <div className="flex justify-center">
            <Button variant="ghost" size="icon" onClick={swapTokens} className="rounded-full">
              <ArrowDownUp className="w-4 h-4" />
            </Button>
          </div>

          {/* To */}
          <div className="space-y-2">
            <Label>To</Label>
            <div className="flex gap-2">
              <div className="flex-1 bg-muted/30 rounded-md px-3 py-2 flex items-center">
                {quoteLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                ) : quote ? (
                  <span className="font-mono">{quote.amount_out.toFixed(4)}</span>
                ) : (
                  <span className="text-muted-foreground">0.00</span>
                )}
              </div>
              <Select value={tokenOut} onValueChange={setTokenOut}>
                <SelectTrigger className="w-28">
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  {tokens.map(t => (
                    <SelectItem key={t.symbol} value={t.symbol} disabled={t.symbol === tokenIn}>
                      <div className="flex items-center gap-2">
                        <TokenIcon symbol={t.symbol} />
                        <span>{t.symbol}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Quote info */}
          {quote && (
            <div className="text-xs text-muted-foreground space-y-1 p-2 bg-muted/20 rounded-lg">
              <div className="flex justify-between">
                <span>Price Impact</span>
                <span className={quote.price_impact > 5 ? "text-destructive" : ""}>
                  {quote.price_impact.toFixed(2)}%
                </span>
              </div>
              <div className="flex justify-between">
                <span>Slippage</span>
                <span>{slippage}%</span>
              </div>
            </div>
          )}

          {/* Swap button */}
          <Button
            className="w-full"
            onClick={handleSwap}
            disabled={!quote || loading || insufficientBalance || !amountIn}
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
            ) : null}
            {loading ? "Swapping..." : "Swap"}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
};

export default SwapWidget;
