import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Loader2, 
  RefreshCw, 
  Unlink,
  Droplets,
  Send,
  Download,
  Plus,
  FileKey2,
  Wifi,
  WifiOff,
  TrendingUp,
  TrendingDown
} from "lucide-react";
import { useBlockchainWs } from "@/hooks/use-blockchain-ws";
import { useXRGEPrice } from "@/hooks/use-xrge-price";
import { formatUsd } from "@/lib/price-service";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import WalletCard from "@/components/wallet/WalletCard";
import AssetList from "@/components/wallet/AssetList";
import TransactionHistory from "@/components/wallet/TransactionHistory";
import NetworkBadge from "@/components/wallet/NetworkBadge";
import SecurityStatus from "@/components/wallet/SecurityStatus";
import WalletBackup from "@/components/wallet/WalletBackup";
import { 
  getWalletBalance, 
  getWalletTransactions, 
  getTotalSupply,
  TOTAL_SUPPLY,
  TOKEN_NAME,
  CHAIN_ID,
  EXPLORER_URL,
  WalletBalance,
  WalletTransaction
} from "@/lib/pqc-wallet";
import { generateKeypair } from "@/lib/pqc-blockchain";
import { createWalletViaNode } from "@/lib/node-api";
import { NETWORK_STORAGE_KEY, getCoreApiHeaders, getNetworkLabel, getNodeApiBaseUrl } from "@/lib/network";
import SendTokensDialog from "@/components/wallet/SendTokensDialog";
import ReceiveDialog from "@/components/wallet/ReceiveDialog";
import CreateTokenDialog from "@/components/wallet/CreateTokenDialog";
import { 
  UnifiedWallet,
  VaultSettings,
  autoLockWallet,
  getLockedWalletMetadata,
  getVaultSettings,
  hasEncryptedWallet,
  isWalletLocked,
  loadUnifiedWallet,
  saveUnifiedWallet,
  saveVaultSettings,
  unlockUnifiedWallet,
  clearUnifiedWallet 
} from "@/lib/unified-wallet";

const Wallet = () => {
  const [wallet, setWallet] = useState<UnifiedWallet | null>(null);
  const [balances, setBalances] = useState<WalletBalance[]>([]);
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [circulatingSupply, setCirculatingSupply] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const [showSend, setShowSend] = useState(false);
  const [showReceive, setShowReceive] = useState(false);
  const [showCreateToken, setShowCreateToken] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [isMainnet, setIsMainnet] = useState(false); // Default to false (show faucet) - safer for devnet/testnet
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [chainIdLabel, setChainIdLabel] = useState<string>(CHAIN_ID);
  const [activeNetwork, setActiveNetwork] = useState<"testnet" | "mainnet">(
    (localStorage.getItem(NETWORK_STORAGE_KEY) as "testnet" | "mainnet" | null) || "testnet"
  );
  const [isLocked, setIsLocked] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [vaultSettings, setVaultSettings] = useState<VaultSettings>(() => getVaultSettings());
  const [lastActivity, setLastActivity] = useState(Date.now());

  // Load wallet from storage
  useEffect(() => {
    const locked = isWalletLocked();
    setIsLocked(locked);
    if (locked) {
      setWallet(null);
      setLoading(false);
      return;
    }
    const unified = loadUnifiedWallet();
    if (unified) {
      setWallet(unified);
    }
    setLoading(false);
  }, [activeNetwork]);

  useEffect(() => {
    setVaultSettings(getVaultSettings());
  }, [activeNetwork]);

  // Check network selection from NetworkBadge (localStorage) - prioritize UI selection
  useEffect(() => {
    const checkNetwork = () => {
      // Check the user's explicit network selection from NetworkBadge
      const savedNetwork = localStorage.getItem(NETWORK_STORAGE_KEY) as "testnet" | "mainnet" | null;
      const nextNetwork = savedNetwork ?? "testnet";

      if (nextNetwork !== activeNetwork) {
        setActiveNetwork(nextNetwork);
        const unified = loadUnifiedWallet();
        setWallet(unified);
        setBalances([]);
        setTransactions([]);
        setCirculatingSupply(0);
        setLastUpdated(null);
        
        // Only log on actual network change
        if (savedNetwork === "mainnet") {
          console.log(`[Wallet] Network changed to mainnet`);
        } else if (savedNetwork === "testnet") {
          console.log(`[Wallet] Network changed to testnet`);
        }
      }
      
      // Prioritize UI selection: if user selected testnet, show faucet; if mainnet, hide it
      if (savedNetwork === "mainnet") {
        setIsMainnet(true);
        setChainIdLabel("rougechain-mainnet");
        return;
      }
      
      if (savedNetwork === "testnet") {
        setIsMainnet(false);
        setChainIdLabel("rougechain-testnet");
        return;
      }
      
      // No UI selection - fall back to checking node's chainId
      const checkNodeChainId = async () => {
        try {
          const NODE_API_URL = getNodeApiBaseUrl();
          if (!NODE_API_URL) {
            return;
          }
          const res = await fetch(`${NODE_API_URL}/stats`, {
            signal: AbortSignal.timeout(2000), // 2 second timeout
            headers: getCoreApiHeaders(),
          });
          if (res.ok) {
            const data = await res.json() as { chainId?: string; chain_id?: string };
            const detected = data.chainId || data.chain_id;
            if (detected) {
              // Hide faucet on mainnet (chainId doesn't contain "devnet" or "testnet")
              const isMainnetNetwork = !detected.includes("devnet") && !detected.includes("testnet");
              setIsMainnet(isMainnetNetwork);
              // Only update and log if chainId actually changed
              setChainIdLabel(prev => {
                if (prev !== detected) {
                  console.log(`[Wallet] Using node chainId: ${detected}`);
                }
                return detected;
              });
            } else {
              // No chainId in response - default to testnet (show faucet)
              setIsMainnet(false);
            }
          } else {
            // API error - default to testnet (show faucet)
            setIsMainnet(false);
          }
        } catch {
          // If can't reach node, default to testnet (show faucet)
          setIsMainnet(false);
        }
      };
      
      checkNodeChainId();
    };
    
    checkNetwork();
    // Listen for network changes from NetworkBadge (storage events work across tabs)
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === NETWORK_STORAGE_KEY) {
        checkNetwork();
      }
    };
    window.addEventListener("storage", handleStorageChange);
    // Check periodically in case localStorage changed in same tab (storage event doesn't fire in same tab)
    const interval = setInterval(checkNetwork, 5000); // Check every 5s, not 1s
    return () => {
      clearInterval(interval);
      window.removeEventListener("storage", handleStorageChange);
    };
  }, []);

  // Fetch XRGE price from GeckoTerminal
  const { priceUsd, priceChange24h, loading: priceLoading } = useXRGEPrice(60_000);

  // WebSocket for real-time updates
  const handleNewBlock = useCallback(() => {
    if (wallet) {
      refreshWalletData();
    }
  }, [wallet?.signingPublicKey]);

  const { isConnected: wsConnected, connectionType: wsConnectionType } = useBlockchainWs({
    onNewBlock: handleNewBlock,
    fallbackPollInterval: 15000,
  });

  // Load balance and transactions when wallet is set
  useEffect(() => {
    if (wallet) {
      refreshWalletData();
    }
  }, [wallet?.signingPublicKey]);

  useEffect(() => {
    const handleActivity = () => setLastActivity(Date.now());
    window.addEventListener("mousemove", handleActivity);
    window.addEventListener("keydown", handleActivity);
    window.addEventListener("touchstart", handleActivity);
    return () => {
      window.removeEventListener("mousemove", handleActivity);
      window.removeEventListener("keydown", handleActivity);
      window.removeEventListener("touchstart", handleActivity);
    };
  }, []);

  useEffect(() => {
    if (!wallet) return;
    if (!hasEncryptedWallet()) return;
    const minutes = vaultSettings.autoLockMinutes;
    if (!minutes || minutes <= 0) return;
    const timeout = window.setTimeout(() => {
      autoLockWallet();
      setWallet(null);
      setIsLocked(true);
      toast.info("Wallet locked", {
        description: "Unlock to continue",
      });
    }, minutes * 60 * 1000);
    return () => window.clearTimeout(timeout);
  }, [wallet, lastActivity, vaultSettings.autoLockMinutes]);

  const refreshWalletData = async () => {
    if (!wallet) return;
    setRefreshing(true);
    setSyncError(null);
    
    try {
      const [newBalances, newTxs, supply] = await Promise.all([
        getWalletBalance(wallet.signingPublicKey),
        getWalletTransactions(wallet.signingPublicKey),
        getTotalSupply("XRGE"),
      ]);
      
      setBalances(newBalances);
      setTransactions(newTxs);
      setCirculatingSupply(supply);
      setLastUpdated(Date.now());
    } catch (error) {
      console.error("Failed to refresh wallet data:", error);
      const message = error instanceof Error ? error.message : "Failed to load wallet data";
      setSyncError(message);
      toast.error("Failed to load wallet data");
    } finally {
      setRefreshing(false);
    }
  };

  const createNewWallet = async () => {
    setLoading(true);
    try {
      // Try to create wallet via node API first (for public deployment)
      let signingPublicKey: string;
      let signingPrivateKey: string;

      try {
        const nodeWallet = await createWalletViaNode();
        signingPublicKey = nodeWallet.publicKey;
        signingPrivateKey = nodeWallet.privateKey;
        toast.info("Wallet created via node API");
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        console.warn("[Wallet] Node API wallet creation failed, falling back to local keys:", error);
        const { keypair } = await generateKeypair();
        signingPublicKey = keypair.publicKey;
        signingPrivateKey = keypair.privateKey;
        toast.info("Node API unavailable, created local wallet", {
          description: errorMessage,
        });
      }

      // For now, create a simplified wallet (just signing keys for blockchain)
      // TODO: Add encryption keys for messaging if needed
      const newWallet: UnifiedWallet = {
        id: `wallet-${Date.now()}`,
        displayName: "My Wallet",
        createdAt: Date.now(),
        signingPublicKey,
        signingPrivateKey,
        encryptionPublicKey: "", // Can be added later
        encryptionPrivateKey: "", // Can be added later
        version: 2,
      };
      
      saveUnifiedWallet(newWallet);
      setWallet(newWallet);
      toast.success("Quantum-safe wallet created!", {
        description: "Your wallet is ready to use"
      });
    } catch (error) {
      console.error("Failed to create wallet:", error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      toast.error("Failed to create wallet", {
        description: errorMessage,
      });
    } finally {
      setLoading(false);
    }
  };

  const disconnectWallet = () => {
    clearUnifiedWallet();
    setWallet(null);
    setIsLocked(false);
    setBalances([]);
    setTransactions([]);
    toast.info("Wallet disconnected");
  };

  const handleUnlock = async () => {
    if (!unlockPassword.trim()) {
      toast.error("Enter your vault password");
      return;
    }
    setUnlocking(true);
    try {
      const unlocked = await unlockUnifiedWallet(unlockPassword.trim());
      setWallet(unlocked);
      setIsLocked(false);
      setUnlockPassword("");
      toast.success("Wallet unlocked");
    } catch (error) {
      console.error("Unlock failed:", error);
      toast.error("Unlock failed", {
        description: "Invalid password or missing vault data",
      });
    } finally {
      setUnlocking(false);
    }
  };

  const handleVaultSettings = (settings: VaultSettings) => {
    saveVaultSettings(settings);
    setVaultSettings(settings);
  };

  const handleWalletImport = (importedWallet: UnifiedWallet) => {
    saveUnifiedWallet(importedWallet);
    setWallet(importedWallet);
    refreshWalletData();
  };

  const claimFromFaucet = async () => {
    if (!wallet) return;
    
    setMinting(true);
    try {
      // Try node API faucet endpoint directly (preferred method)
          const NODE_API_URL = getNodeApiBaseUrl();
      const faucetUrl = `${NODE_API_URL}/faucet`;
      
      try {
        const res = await fetch(faucetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
          body: JSON.stringify({
            recipientPublicKey: wallet.signingPublicKey,
            amount: 10000,
          }),
        });

        const rawText = await res.text();
        let data;
        try {
          data = rawText ? JSON.parse(rawText) : null;
        } catch (jsonError) {
          console.error(`[Faucet] Failed to parse JSON response:`, rawText);
          throw new Error(`Server returned invalid JSON: ${rawText.substring(0, 100)}`);
        }

        if (!res.ok) {
          const errorMsg = data?.error || `Faucet request failed: ${res.status} ${res.statusText}`;
          console.error(`[Faucet] API error:`, errorMsg);
          throw new Error(errorMsg);
        }

        if (data.success) {
          toast.success("🎉 Claimed 10,000 XRGE from faucet!", {
            description: data.message || "Transaction will be included in the next block"
          });
          // Wait a moment for the transaction to be processed
          await new Promise(resolve => setTimeout(resolve, 2000));
          await refreshWalletData();
        } else {
          const errorMsg = data?.error || "Faucet request was not successful";
          console.error(`[Faucet] Request not successful:`, errorMsg);
          throw new Error(errorMsg);
        }
      } catch (nodeError) {
        console.warn("[Faucet] Node API faucet failed:", nodeError);
        throw nodeError;
      }
    } catch (error) {
      console.error("[Faucet] Final error:", error);
      const errorMessage = error instanceof Error ? error.message : "Failed to claim tokens";
      toast.error("Failed to claim tokens", {
        description: errorMessage
      });
    } finally {
      setMinting(false);
    }
  };

  // Get XRGE balance specifically for the main display (native token)
  const xrgeBalance = balances.find(b => b.symbol === "XRGE")?.balance || 0;
  
  // Calculate USD value for wallet display
  const walletUsdValue = priceUsd && xrgeBalance ? formatUsd(xrgeBalance * priceUsd) : null;

  const networkLabel = getNetworkLabel(chainIdLabel);

  const formatLastUpdated = (timestamp: number | null) => {
    if (!timestamp && syncError) return "Sync failed";
    if (!timestamp) return "Not synced yet";
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 5) return "Updated just now";
    if (seconds < 60) return `Updated ${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `Updated ${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `Updated ${hours}h ago`;
  };

  // Convert balances to asset format with USD values
  const assets = balances.map(b => {
    // Only XRGE has USD price (native token with market data)
    const usdValue = b.symbol === "XRGE" && priceUsd 
      ? formatUsd(b.balance * priceUsd)
      : null;
    
    return {
      id: b.symbol,
      name: b.name,
      symbol: b.symbol,
      balance: b.balance.toLocaleString(),
      value: `${b.balance} ${b.symbol}`,
      usdValue,
      change: b.symbol === "XRGE" && priceChange24h ? priceChange24h : 0,
      icon: b.icon,
    };
  });

  // Convert transactions to history format
  const txHistory = transactions.map(tx => ({
    id: tx.id,
    type: tx.type,
    amount: tx.amount,
    symbol: tx.symbol,
    address: tx.address,
    timeLabel: tx.timeLabel,
    timestamp: tx.timestamp,
    status: tx.status,
    blockIndex: tx.blockIndex,
    txHash: tx.txHash,
    fee: tx.fee,
    from: tx.from,
    to: tx.to,
    memo: tx.memo,
  }));

  const emptyAssetActionLabel = isMainnet ? "Receive tokens" : "Claim faucet";
  const handleEmptyAssetAction = () => {
    if (isMainnet) {
      setShowReceive(true);
    } else {
      claimFromFaucet();
    }
  };
  const emptyAssetHint = isMainnet
    ? "Share your address to receive tokens"
    : "Claim from faucet to get started";

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (isLocked) {
    const meta = getLockedWalletMetadata();
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-md mx-auto px-4 py-12">
          <Card className="border-border">
            <CardHeader>
              <CardTitle>Wallet Locked</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {meta?.displayName ? `${meta.displayName} is locked.` : "Your wallet is locked."}
              </p>
              {meta?.signingPublicKey && (
                <p className="text-xs font-mono text-muted-foreground break-all">
                  {meta.signingPublicKey}
                </p>
              )}
              <Input
                type="password"
                placeholder="Enter vault password"
                value={unlockPassword}
                onChange={(e) => setUnlockPassword(e.target.value)}
              />
              <Button className="w-full" onClick={handleUnlock} disabled={unlocking}>
                {unlocking ? "Unlocking..." : "Unlock Wallet"}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Action Bar */}
      <div className="sticky top-0 z-40 bg-background/80 backdrop-blur-sm border-b border-border">
        <div className="max-w-lg mx-auto px-4 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <NetworkBadge 
              isConnected={!!wallet}
              onNetworkChange={(network) => {
                // Update isMainnet when user changes network in UI
                setIsMainnet(network === "mainnet");
              }}
            />
          </div>
          
          <div className="flex items-center gap-2">
            {wallet && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setShowBackup(true)}
                  className="h-9 w-9"
                  title="Backup Wallet"
                >
                  <FileKey2 className="w-4 h-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={refreshWalletData}
                  disabled={refreshing}
                  className="h-9 w-9"
                >
                  <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
                </Button>
              </>
            )}
            {wallet && (
              <div className="flex items-center gap-2">
                {wsConnectionType === "websocket" ? (
                  <Wifi className="w-3 h-3 text-green-500" title="Live updates via WebSocket" />
                ) : wsConnectionType === "polling" ? (
                  <RefreshCw className="w-3 h-3 text-amber-500" title="Polling for updates" />
                ) : (
                  <WifiOff className="w-3 h-3 text-destructive" title="Disconnected" />
                )}
                <span className="text-[11px] text-muted-foreground hidden sm:inline">
                  {formatLastUpdated(lastUpdated)}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      <main className="max-w-lg mx-auto px-4 py-6 space-y-6">
        {!wallet ? (
          /* No wallet connected */
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-6"
          >
            <WalletCard 
              isConnected={false}
              onConnect={createNewWallet}
            />

            <SecurityStatus />
          </motion.div>
        ) : (
          /* Wallet connected */
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-6"
          >
          <WalletCard
              address={wallet.signingPublicKey}
              balance={xrgeBalance.toLocaleString()}
              usdValue={walletUsdValue}
              priceChange24h={priceChange24h}
              isConnected={true}
            />

            {/* Action Buttons */}
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">Quick actions</h3>
            </div>
            <div className={`grid gap-2 ${isMainnet ? 'grid-cols-4' : 'grid-cols-5'}`}>
              <Button
                variant="outline"
                className="flex-col h-auto py-3 gap-1.5 bg-card hover:bg-secondary border-border"
                onClick={() => setShowSend(true)}
                disabled={balances.length === 0}
              >
                <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center">
                  <Send className="w-4 h-4 text-primary" />
                </div>
                <span className="text-[10px]">Send</span>
              </Button>
              
              <Button
                variant="outline"
                className="flex-col h-auto py-3 gap-1.5 bg-card hover:bg-secondary border-border"
                onClick={() => setShowReceive(true)}
              >
                <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center">
                  <Download className="w-4 h-4 text-success" />
                </div>
                <span className="text-[10px]">Receive</span>
              </Button>
              
              {/* Only show faucet on devnet/testnet */}
              {!isMainnet && (
                <Button
                  variant="outline"
                  className="flex-col h-auto py-3 gap-1.5 bg-card hover:bg-secondary border-border"
                  onClick={claimFromFaucet}
                  disabled={minting}
                >
                  <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center">
                    {minting ? (
                      <Loader2 className="w-4 h-4 text-accent animate-spin" />
                    ) : (
                      <Droplets className="w-4 h-4 text-accent" />
                    )}
                  </div>
                  <span className="text-[10px]">Faucet</span>
                </Button>
              )}

              <Button
                variant="outline"
                className="flex-col h-auto py-3 gap-1.5 bg-card hover:bg-secondary border-border"
                onClick={() => setShowCreateToken(true)}
              >
                <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center">
                  <Plus className="w-4 h-4 text-primary" />
                </div>
                <span className="text-[10px]">Create</span>
              </Button>
              
              <Button
                variant="outline"
                className="flex-col h-auto py-3 gap-1.5 bg-card hover:bg-secondary border-border"
                onClick={disconnectWallet}
              >
                <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center">
                  <Unlink className="w-4 h-4 text-destructive" />
                </div>
                <span className="text-[10px]">Disconnect</span>
              </Button>
            </div>


            {/* Token Supply Info */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="p-4 rounded-xl bg-card border border-border"
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-foreground">XRGE Token Info</h3>
                <a 
                  href={EXPLORER_URL} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline"
                >
                  rougeelabs.com ↗
                </a>
              </div>
              
              {/* Native Token Info */}
              <div className="p-3 rounded-lg bg-secondary/50 border border-border mb-3">
                <p className="text-xs text-muted-foreground mb-1">Token Type</p>
                <p className="text-xs font-mono text-foreground">Native Chain Token</p>
                <p className="text-[10px] text-muted-foreground mt-1">XRGE is the native currency of RougeChain</p>
              </div>

                <div className="grid grid-cols-2 gap-2 mb-3">
                <div className="p-2 rounded-lg bg-secondary/30">
                  <p className="text-[10px] text-muted-foreground">Name</p>
                  <p className="text-xs font-medium text-foreground">{TOKEN_NAME}</p>
                </div>
                <div className="p-2 rounded-lg bg-secondary/30">
                    <p className="text-[10px] text-muted-foreground">Network</p>
                    <p className="text-xs font-medium text-foreground">{networkLabel}</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 mb-3">
                  <div className="p-2 rounded-lg bg-secondary/30">
                    <p className="text-[10px] text-muted-foreground">Chain ID</p>
                    <p className="text-xs font-mono text-foreground">{chainIdLabel}</p>
                  </div>
                  <div className="p-2 rounded-lg bg-secondary/30">
                    <p className="text-[10px] text-muted-foreground">Supply Model</p>
                    <p className="text-xs font-medium text-foreground">
                      {networkLabel === "Mainnet" ? "Capped" : "Devnet/Testnet"}
                    </p>
                </div>
              </div>

              <div className="space-y-2">
                {/* Live Price from GeckoTerminal */}
                {priceUsd !== null && (
                  <div className="flex justify-between items-center p-2 rounded-lg bg-primary/10 border border-primary/20">
                    <span className="text-xs font-medium text-primary">Live Price (Base)</span>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-mono font-bold text-primary">
                        ${priceUsd < 0.0001 ? priceUsd.toExponential(4) : priceUsd.toFixed(6)}
                      </span>
                      {priceChange24h !== null && (
                        <span className={`flex items-center gap-0.5 text-xs ${priceChange24h >= 0 ? 'text-success' : 'text-destructive'}`}>
                          {priceChange24h >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                          {priceChange24h >= 0 ? '+' : ''}{priceChange24h.toFixed(2)}%
                        </span>
                      )}
                    </div>
                  </div>
                )}
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">Total Supply</span>
                  <span className="text-sm font-mono text-foreground">{TOTAL_SUPPLY.toLocaleString()}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">Circulating</span>
                  <span className="text-sm font-mono text-foreground">{circulatingSupply.toLocaleString()}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">Remaining</span>
                  <span className="text-sm font-mono text-primary">{(TOTAL_SUPPLY - circulatingSupply).toLocaleString()}</span>
                </div>
                <div className="mt-3 h-2 bg-secondary rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-gradient-to-r from-primary to-accent rounded-full transition-all duration-500"
                    style={{ width: `${(circulatingSupply / TOTAL_SUPPLY) * 100}%` }}
                  />
                </div>
                <p className="text-[10px] text-muted-foreground text-center">
                  {((circulatingSupply / TOTAL_SUPPLY) * 100).toFixed(6)}% in circulation
                </p>
              </div>
            </motion.div>

            <AssetList
              assets={assets}
              emptyActionLabel={emptyAssetActionLabel}
              onEmptyAction={handleEmptyAssetAction}
              emptyHint={emptyAssetHint}
            />
            <TransactionHistory
              transactions={txHistory}
              emptyActionLabel="Receive tokens"
              onEmptyAction={() => setShowReceive(true)}
            />
            <SecurityStatus />
          </motion.div>
        )}
      </main>

      {/* Send Dialog */}
      <AnimatePresence>
        {showSend && wallet && (
          <SendTokensDialog
            wallet={wallet}
            balances={balances}
            onClose={() => setShowSend(false)}
            onSuccess={() => {
              setShowSend(false);
              refreshWalletData();
            }}
          />
        )}
      </AnimatePresence>

      {/* Receive Dialog */}
      <AnimatePresence>
        {showReceive && wallet && (
          <ReceiveDialog
            publicKey={wallet.signingPublicKey}
            onClose={() => setShowReceive(false)}
          />
        )}
      </AnimatePresence>

      {/* Create Token Dialog */}
      <AnimatePresence>
        {showCreateToken && wallet && (
          <CreateTokenDialog
            wallet={wallet}
            balances={balances}
            onClose={() => setShowCreateToken(false)}
            onSuccess={() => {
              setShowCreateToken(false);
              refreshWalletData();
            }}
          />
        )}
      </AnimatePresence>

      {/* Backup Dialog */}
      <AnimatePresence>
        {showBackup && wallet && (
          <WalletBackup
            wallet={wallet}
            onClose={() => setShowBackup(false)}
            onImport={handleWalletImport}
            onLocked={() => {
              setWallet(null);
              setIsLocked(true);
            }}
            vaultSettings={vaultSettings}
            onUpdateVaultSettings={handleVaultSettings}
          />
        )}
      </AnimatePresence>
    </div>
  );
};

export default Wallet;
