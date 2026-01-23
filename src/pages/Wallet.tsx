import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Loader2, 
  RefreshCw, 
  Unlink,
  Droplets,
  Send,
  Download,
  Plus,
  FileKey2
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { MainNav } from "@/components/MainNav";
import WalletCard from "@/components/wallet/WalletCard";
import AssetList from "@/components/wallet/AssetList";
import TransactionHistory from "@/components/wallet/TransactionHistory";
import NetworkBadge from "@/components/wallet/NetworkBadge";
import SecurityStatus from "@/components/wallet/SecurityStatus";
import WalletBackup from "@/components/wallet/WalletBackup";
import { 
  getWalletBalance, 
  getWalletTransactions, 
  mintTokens,
  getTotalSupply,
  TOTAL_SUPPLY,
  TOKEN_NAME,
  CHAIN_ID,
  EXPLORER_URL,
  WalletBalance,
  WalletTransaction
} from "@/lib/pqc-wallet";
import { loadChain, createGenesisBlock } from "@/lib/pqc-blockchain";
import { supabase } from "@/integrations/supabase/client";
import SendTokensDialog from "@/components/wallet/SendTokensDialog";
import ReceiveDialog from "@/components/wallet/ReceiveDialog";
import CreateTokenDialog from "@/components/wallet/CreateTokenDialog";
import { 
  UnifiedWallet, 
  loadUnifiedWallet, 
  saveUnifiedWallet, 
  clearUnifiedWallet 
} from "@/lib/unified-wallet";

const Wallet = () => {
  const [wallet, setWallet] = useState<UnifiedWallet | null>(null);
  const [balances, setBalances] = useState<WalletBalance[]>([]);
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [circulatingSupply, setCirculatingSupply] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [minting, setMinting] = useState(false);
  const [showSend, setShowSend] = useState(false);
  const [showReceive, setShowReceive] = useState(false);
  const [showCreateToken, setShowCreateToken] = useState(false);
  const [showBackup, setShowBackup] = useState(false);

  // Load wallet from storage
  useEffect(() => {
    const unified = loadUnifiedWallet();
    if (unified) {
      setWallet(unified);
    }
    setLoading(false);
  }, []);

  // Load balance and transactions when wallet is set
  useEffect(() => {
    if (wallet) {
      refreshWalletData();
    }
  }, [wallet?.signingPublicKey]);

  const refreshWalletData = async () => {
    if (!wallet) return;
    setRefreshing(true);
    
    try {
      const [newBalances, newTxs, supply] = await Promise.all([
        getWalletBalance(wallet.signingPublicKey),
        getWalletTransactions(wallet.signingPublicKey),
        getTotalSupply("XRGE"),
      ]);
      
      setBalances(newBalances);
      setTransactions(newTxs);
      setCirculatingSupply(supply);
    } catch (error) {
      console.error("Failed to refresh wallet data:", error);
      toast.error("Failed to load wallet data");
    } finally {
      setRefreshing(false);
    }
  };

  const createNewWallet = async () => {
    setLoading(true);
    try {
      // Check if chain exists, if not create genesis
      const chain = await loadChain();
      if (chain.length === 0) {
        toast.info("Initializing blockchain...");
        await createGenesisBlock();
      }

      // Create unified wallet with both signing and encryption keys
      const { data, error } = await supabase.functions.invoke("pqc-crypto", {
        body: { action: "create-wallet", payload: { displayName: "My Wallet" } },
      });

      if (error) throw new Error(error.message);
      if (!data.success) throw new Error(data.error || "Failed to create wallet");

      const newWallet: UnifiedWallet = {
        id: data.wallet.id,
        displayName: data.wallet.displayName,
        createdAt: Date.now(),
        signingPublicKey: data.wallet.signingPublicKey,
        signingPrivateKey: data.privateKeys.signingPrivateKey,
        encryptionPublicKey: data.wallet.encryptionPublicKey,
        encryptionPrivateKey: data.privateKeys.encryptionPrivateKey,
        version: 2,
      };
      
      saveUnifiedWallet(newWallet);
      setWallet(newWallet);
      toast.success("Quantum-safe wallet created!", {
        description: "Your wallet works for both blockchain and messaging"
      });
    } catch (error) {
      console.error("Failed to create wallet:", error);
      toast.error("Failed to create wallet");
    } finally {
      setLoading(false);
    }
  };

  const disconnectWallet = () => {
    clearUnifiedWallet();
    setWallet(null);
    setBalances([]);
    setTransactions([]);
    toast.info("Wallet disconnected");
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
      // Check if chain exists
      const chain = await loadChain();
      if (chain.length === 0) {
        toast.info("Initializing blockchain first...");
        await createGenesisBlock();
      }

      await mintTokens(
        wallet.signingPrivateKey,
        wallet.signingPublicKey,
        wallet.signingPublicKey,
        100,
        "XRGE"
      );
      
      toast.success("🎉 Claimed 100 XRGE from faucet!");
      await refreshWalletData();
    } catch (error) {
      console.error("Faucet error:", error);
      toast.error("Failed to claim tokens");
    } finally {
      setMinting(false);
    }
  };

  // Get XRGE balance specifically for the main display (native token)
  const xrgeBalance = balances.find(b => b.symbol === "XRGE")?.balance || 0;

  // Convert balances to asset format
  const assets = balances.map(b => ({
    id: b.symbol,
    name: b.name,
    symbol: b.symbol,
    balance: b.balance.toLocaleString(),
    value: `${b.balance} ${b.symbol}`,
    change: 0,
    icon: b.icon,
  }));

  // Convert transactions to history format
  const txHistory = transactions.map(tx => ({
    id: tx.id,
    type: tx.type,
    amount: tx.amount,
    symbol: tx.symbol,
    address: tx.address,
    time: tx.time,
    status: tx.status,
  }));

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <MainNav />
      
      {/* Action Bar */}
      <div className="sticky top-[60px] z-40 bg-background/80 backdrop-blur-sm border-b border-border">
        <div className="max-w-lg mx-auto px-4 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <NetworkBadge isConnected={!!wallet} />
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
              usdValue="N/A"
              isConnected={true}
            />

            {/* Action Buttons */}
            <div className="grid grid-cols-5 gap-2">
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
                  <p className="text-[10px] text-muted-foreground">Chain ID</p>
                  <p className="text-xs font-mono text-foreground">{CHAIN_ID}</p>
                </div>
              </div>

              <div className="space-y-2">
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

            <AssetList assets={assets} />
            <TransactionHistory transactions={txHistory} />
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
          />
        )}
      </AnimatePresence>
    </div>
  );
};

export default Wallet;
