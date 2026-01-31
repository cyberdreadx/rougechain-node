import { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { Plus, Droplets, TrendingUp, Loader2, Info, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  
  // Wallet state
  const [wallet, setWallet] = useState<{ publicKey: string; privateKey: string } | null>(null);

  // Load wallet from localStorage
  useEffect(() => {
    const savedWallet = localStorage.getItem("quantum_vault_wallet");
    if (savedWallet) {
      try {
        const parsed = JSON.parse(savedWallet);
        if (parsed.signingPublicKey && parsed.signingPrivateKey) {
          setWallet({
            publicKey: parsed.signingPublicKey,
            privateKey: parsed.signingPrivateKey,
          });
        }
      } catch (e) {
        console.error("Failed to parse wallet:", e);
      }
    }
  }, []);

  // Fetch pools and balances
  const fetchData = useCallback(async () => {
    try {
      const baseUrl = getNodeApiBaseUrl();
      if (!baseUrl) return;
      
      // Fetch pools
      const poolsRes = await fetch(`${baseUrl}/pools`, {
        headers: getCoreApiHeaders(),
      });
      
      if (poolsRes.ok) {
        const data = await poolsRes.json();
        setPools(data.pools || []);
        
        // Extract tokens
        const tokenSet = new Set<string>(["XRGE"]);
        (data.pools || []).forEach((pool: Pool) => {
          tokenSet.add(pool.token_a);
          tokenSet.add(pool.token_b);
        });
        
        // Get balances if wallet connected
        if (wallet) {
          const balRes = await fetch(`${baseUrl}/balance/${wallet.publicKey}`, {
            headers: getCoreApiHeaders(),
          });
          
          if (balRes.ok) {
            const balData = await balRes.json();
            const tokenBalances = balData.token_balances || {};
            
            setTokens(Array.from(tokenSet).map(symbol => ({
              symbol,
              balance: symbol === "XRGE" ? (balData.balance || 0) : (tokenBalances[symbol] || 0),
            })));
            
            // TODO: Fetch LP balances when API supports it
            // For now, initialize empty
            setLpBalances({});
          }
        } else {
          setTokens(Array.from(tokenSet).map(symbol => ({ symbol, balance: 0 })));
        }
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
      const baseUrl = getNodeApiBaseUrl();
      if (!baseUrl) throw new Error("API not configured");
      
      const res = await fetch(`${baseUrl}/pool/create`, {
        method: "POST",
        headers: {
          ...getCoreApiHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from_private_key: wallet.privateKey,
          from_public_key: wallet.publicKey,
          token_a: newTokenA,
          token_b: newTokenB,
          amount_a: Math.floor(parseFloat(newAmountA)),
          amount_b: Math.floor(parseFloat(newAmountB)),
        }),
      });
      
      const data = await res.json();
      
      if (data.success) {
        toast.success(`Pool created: ${data.pool_id}`);
        setShowCreatePool(false);
        setNewAmountA("");
        setNewAmountB("");
        fetchData();
      } else {
        toast.error(data.error || "Failed to create pool");
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
      const baseUrl = getNodeApiBaseUrl();
      if (!baseUrl) throw new Error("API not configured");
      
      const res = await fetch(`${baseUrl}/pool/add-liquidity`, {
        method: "POST",
        headers: {
          ...getCoreApiHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from_private_key: wallet.privateKey,
          from_public_key: wallet.publicKey,
          pool_id: selectedPool.pool_id,
          amount_a: Math.floor(parseFloat(addAmountA)),
          amount_b: Math.floor(parseFloat(addAmountB)),
        }),
      });
      
      const data = await res.json();
      
      if (data.success) {
        toast.success("Liquidity added successfully");
        setShowAddLiquidity(false);
        setAddAmountA("");
        setAddAmountB("");
        fetchData();
      } else {
        toast.error(data.error || "Failed to add liquidity");
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
      const baseUrl = getNodeApiBaseUrl();
      if (!baseUrl) throw new Error("API not configured");
      
      const res = await fetch(`${baseUrl}/pool/remove-liquidity`, {
        method: "POST",
        headers: {
          ...getCoreApiHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from_private_key: wallet.privateKey,
          from_public_key: wallet.publicKey,
          pool_id: selectedPool.pool_id,
          lp_amount: Math.floor(parseFloat(removeAmount)),
        }),
      });
      
      const data = await res.json();
      
      if (data.success) {
        toast.success("Liquidity removed successfully");
        setShowRemoveLiquidity(false);
        setRemoveAmount("");
        fetchData();
      } else {
        toast.error(data.error || "Failed to remove liquidity");
      }
    } catch (e) {
      toast.error("Failed to remove liquidity");
      console.error(e);
    } finally {
      setActionLoading(false);
    }
  };

  // Calculate quote for proportional liquidity
  const calculateQuote = (pool: Pool, amountA: number, isTokenA: boolean) => {
    if (!pool.reserve_a || !pool.reserve_b) return 0;
    if (isTokenA) {
      return (amountA * pool.reserve_b) / pool.reserve_a;
    } else {
      return (amountA * pool.reserve_a) / pool.reserve_b;
    }
  };

  const formatNumber = (n: number) => {
    if (n >= 1000000) return (n / 1000000).toFixed(2) + "M";
    if (n >= 1000) return (n / 1000).toFixed(2) + "K";
    return n.toLocaleString();
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="container max-w-4xl mx-auto px-4 py-8 flex-grow">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-6"
        >
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold">Liquidity Pools</h1>
              <p className="text-muted-foreground">Provide liquidity and earn fees</p>
            </div>
            <Dialog open={showCreatePool} onOpenChange={setShowCreatePool}>
              <DialogTrigger asChild>
                <Button disabled={!wallet}>
                  <Plus className="w-4 h-4 mr-2" />
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
                              {t.symbol} ({formatNumber(t.balance)})
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
                              {t.symbol} ({formatNumber(t.balance)})
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

          {/* Pool List */}
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
            </div>
          ) : pools.length === 0 ? (
            <Card className="bg-muted/30">
              <CardContent className="py-12 text-center">
                <Droplets className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium mb-2">No Pools Yet</h3>
                <p className="text-muted-foreground mb-4">
                  Be the first to create a liquidity pool
                </p>
                <Button onClick={() => setShowCreatePool(true)} disabled={!wallet}>
                  <Plus className="w-4 h-4 mr-2" />
                  Create Pool
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {pools.map((pool) => (
                <Card key={pool.pool_id} className="bg-card/50 backdrop-blur border-primary/20">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="flex -space-x-2">
                          <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-xs font-bold">
                            {pool.token_a.charAt(0)}
                          </div>
                          <div className="w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center text-xs font-bold">
                            {pool.token_b.charAt(0)}
                          </div>
                        </div>
                        <div>
                          <CardTitle className="text-lg">{pool.token_a}/{pool.token_b}</CardTitle>
                          <CardDescription>Fee: {(pool.fee_rate * 100).toFixed(1)}%</CardDescription>
                        </div>
                      </div>
                      <Badge variant="secondary">
                        TVL: {formatNumber(pool.reserve_a + pool.reserve_b)}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                      <div>
                        <p className="text-muted-foreground">{pool.token_a} Reserve</p>
                        <p className="font-mono font-medium">{formatNumber(pool.reserve_a)}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">{pool.token_b} Reserve</p>
                        <p className="font-mono font-medium">{formatNumber(pool.reserve_b)}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">LP Supply</p>
                        <p className="font-mono font-medium">{formatNumber(pool.total_lp_supply)}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Your LP</p>
                        <p className="font-mono font-medium">{formatNumber(lpBalances[pool.pool_id] || 0)}</p>
                      </div>
                    </div>
                    
                    {wallet && (
                      <div className="flex gap-2 mt-4">
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
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
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
                        const quote = calculateQuote(selectedPool, parseFloat(e.target.value) || 0, true);
                        setAddAmountB(quote.toFixed(0));
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
                        const quote = calculateQuote(selectedPool, parseFloat(e.target.value) || 0, false);
                        setAddAmountA(quote.toFixed(0));
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
                              (parseFloat(removeAmount) / selectedPool.total_lp_supply) * selectedPool.reserve_a
                            )}
                          </span>{" "}
                          {selectedPool.token_a}
                        </div>
                        <div>
                          <span className="font-medium">
                            {formatNumber(
                              (parseFloat(removeAmount) / selectedPool.total_lp_supply) * selectedPool.reserve_b
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

          {/* Info Section */}
          <Card className="bg-muted/30">
            <CardContent className="pt-4">
              <div className="flex items-start gap-3">
                <TrendingUp className="w-5 h-5 text-primary mt-0.5" />
                <div className="text-sm text-muted-foreground">
                  <p className="font-medium text-foreground mb-1">Earn from every swap</p>
                  <p>
                    Liquidity providers earn 0.3% on all trades proportional to their share of the pool.
                    Fees are automatically compounded into the pool.
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

export default Pools;
