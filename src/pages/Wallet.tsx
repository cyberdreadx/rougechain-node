import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Link } from "react-router-dom";
import { 
  ArrowLeft, 
  Loader2, 
  RefreshCw, 
  Link2, 
  Unlink,
  Droplets,
  Send,
  Download,
  Wallet as WalletIcon
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import WalletCard from "@/components/wallet/WalletCard";
import AssetList from "@/components/wallet/AssetList";
import TransactionHistory from "@/components/wallet/TransactionHistory";
import NetworkBadge from "@/components/wallet/NetworkBadge";
import SecurityStatus from "@/components/wallet/SecurityStatus";
import { 
  getWalletBalance, 
  getWalletTransactions, 
  mintTokens,
  getTotalSupply,
  TOTAL_SUPPLY,
  WalletBalance,
  WalletTransaction
} from "@/lib/pqc-wallet";
import { generateKeypair, loadChain, createGenesisBlock } from "@/lib/pqc-blockchain";
import SendTokensDialog from "@/components/wallet/SendTokensDialog";
import ReceiveDialog from "@/components/wallet/ReceiveDialog";
import xrgeLogo from "@/assets/xrge-logo.webp";

const WALLET_STORAGE_KEY = "pqc-blockchain-wallet";
const MESSENGER_WALLET_KEY = "pqc-messenger-wallet";

interface StoredWallet {
  publicKey: string;
  privateKey: string;
  createdAt: number;
  linkedToMessenger?: boolean;
}

const Wallet = () => {
  const [wallet, setWallet] = useState<StoredWallet | null>(null);
  const [balances, setBalances] = useState<WalletBalance[]>([]);
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [circulatingSupply, setCirculatingSupply] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [minting, setMinting] = useState(false);
  const [showSend, setShowSend] = useState(false);
  const [showReceive, setShowReceive] = useState(false);
  const [messengerWalletAvailable, setMessengerWalletAvailable] = useState(false);

  // Load wallet from storage
  useEffect(() => {
    const stored = localStorage.getItem(WALLET_STORAGE_KEY);
    if (stored) {
      try {
        setWallet(JSON.parse(stored));
      } catch (e) {
        console.error("Failed to parse stored wallet:", e);
      }
    }
    
    // Check if messenger wallet exists
    const messengerWallet = localStorage.getItem(MESSENGER_WALLET_KEY);
    setMessengerWalletAvailable(!!messengerWallet);
    
    setLoading(false);
  }, []);

  // Load balance and transactions when wallet is set
  useEffect(() => {
    if (wallet) {
      refreshWalletData();
    }
  }, [wallet?.publicKey]);

  const refreshWalletData = async () => {
    if (!wallet) return;
    setRefreshing(true);
    
    try {
      const [newBalances, newTxs, supply] = await Promise.all([
        getWalletBalance(wallet.publicKey),
        getWalletTransactions(wallet.publicKey),
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

      const { keypair } = await generateKeypair();
      const newWallet: StoredWallet = {
        publicKey: keypair.publicKey,
        privateKey: keypair.privateKey,
        createdAt: Date.now(),
      };
      
      localStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify(newWallet));
      setWallet(newWallet);
      toast.success("Quantum-safe wallet created!");
    } catch (error) {
      console.error("Failed to create wallet:", error);
      toast.error("Failed to create wallet");
    } finally {
      setLoading(false);
    }
  };

  const linkMessengerWallet = () => {
    const messengerData = localStorage.getItem(MESSENGER_WALLET_KEY);
    if (!messengerData) {
      toast.error("No messenger wallet found");
      return;
    }

    try {
      const parsed = JSON.parse(messengerData);
      const linkedWallet: StoredWallet = {
        publicKey: parsed.signingPublicKey || parsed.publicKey,
        privateKey: parsed.signingPrivateKey || parsed.privateKey,
        createdAt: Date.now(),
        linkedToMessenger: true,
      };
      
      localStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify(linkedWallet));
      setWallet(linkedWallet);
      toast.success("Messenger wallet linked!");
    } catch (error) {
      console.error("Failed to link messenger wallet:", error);
      toast.error("Failed to link wallet");
    }
  };

  const disconnectWallet = () => {
    localStorage.removeItem(WALLET_STORAGE_KEY);
    setWallet(null);
    setBalances([]);
    setTransactions([]);
    toast.info("Wallet disconnected");
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
        wallet.privateKey,
        wallet.publicKey,
        wallet.publicKey,
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

  const totalBalance = balances.reduce((sum, b) => sum + b.balance, 0);

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
      {/* Header */}
      <header className="sticky top-0 z-50 bg-background/80 backdrop-blur-xl border-b border-border">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link to="/">
              <Button variant="ghost" size="icon" className="h-9 w-9">
                <ArrowLeft className="w-5 h-5" />
              </Button>
            </Link>
            <img src={xrgeLogo} alt="XRGE" className="w-9 h-9 rounded-full" />
            <div>
              <h1 className="text-lg font-bold text-foreground">XRGE Wallet</h1>
              <p className="text-xs text-muted-foreground">RougeChain</p>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            {wallet && (
              <Button
                variant="ghost"
                size="icon"
                onClick={refreshWalletData}
                disabled={refreshing}
                className="h-9 w-9"
              >
                <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
              </Button>
            )}
            <NetworkBadge isConnected={!!wallet} />
          </div>
        </div>
      </header>

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

            {messengerWalletAvailable && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.2 }}
                className="p-4 rounded-xl bg-card border border-border"
              >
                <div className="flex items-center gap-3 mb-3">
                  <Link2 className="w-5 h-5 text-primary" />
                  <h3 className="font-semibold text-foreground">Link Existing Wallet</h3>
                </div>
                <p className="text-sm text-muted-foreground mb-4">
                  You have a messenger wallet. Link it to use the same keys for blockchain transactions.
                </p>
                <Button onClick={linkMessengerWallet} variant="outline" className="w-full">
                  <Link2 className="w-4 h-4 mr-2" />
                  Link Messenger Wallet
                </Button>
              </motion.div>
            )}

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
              address={wallet.publicKey}
              balance={totalBalance.toString()}
              usdValue="N/A"
              isConnected={true}
            />

            {/* Action Buttons */}
            <div className="grid grid-cols-4 gap-3">
              <Button
                variant="outline"
                className="flex-col h-auto py-4 gap-2 bg-card hover:bg-secondary border-border"
                onClick={() => setShowSend(true)}
                disabled={totalBalance === 0}
              >
                <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center">
                  <Send className="w-5 h-5 text-primary" />
                </div>
                <span className="text-xs">Send</span>
              </Button>
              
              <Button
                variant="outline"
                className="flex-col h-auto py-4 gap-2 bg-card hover:bg-secondary border-border"
                onClick={() => setShowReceive(true)}
              >
                <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center">
                  <Download className="w-5 h-5 text-success" />
                </div>
                <span className="text-xs">Receive</span>
              </Button>
              
              <Button
                variant="outline"
                className="flex-col h-auto py-4 gap-2 bg-card hover:bg-secondary border-border"
                onClick={claimFromFaucet}
                disabled={minting}
              >
                <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center">
                  {minting ? (
                    <Loader2 className="w-5 h-5 text-accent animate-spin" />
                  ) : (
                    <Droplets className="w-5 h-5 text-accent" />
                  )}
                </div>
                <span className="text-xs">Faucet</span>
              </Button>
              
              <Button
                variant="outline"
                className="flex-col h-auto py-4 gap-2 bg-card hover:bg-secondary border-border"
                onClick={disconnectWallet}
              >
                <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center">
                  <Unlink className="w-5 h-5 text-destructive" />
                </div>
                <span className="text-xs">Disconnect</span>
              </Button>
            </div>

            {wallet.linkedToMessenger && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/10 border border-primary/30">
                <Link2 className="w-4 h-4 text-primary" />
                <span className="text-xs text-primary">Linked to Messenger Wallet</span>
              </div>
            )}

            {/* Token Supply Info */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="p-4 rounded-xl bg-card border border-border"
            >
              <h3 className="text-sm font-semibold text-foreground mb-3">XRGE Tokenomics</h3>
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
            publicKey={wallet.publicKey}
            onClose={() => setShowReceive(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
};

export default Wallet;
