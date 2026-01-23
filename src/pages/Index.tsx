import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { Blocks, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import Header from "@/components/wallet/Header";
import WalletCard from "@/components/wallet/WalletCard";
import ActionButtons from "@/components/wallet/ActionButtons";
import AssetList from "@/components/wallet/AssetList";
import TransactionHistory from "@/components/wallet/TransactionHistory";
import SecurityStatus from "@/components/wallet/SecurityStatus";
import NetworkBadge from "@/components/wallet/NetworkBadge";

const Index = () => {
  return (
    <div className="min-h-screen bg-background relative overflow-hidden">
      {/* Background effects */}
      <div className="fixed inset-0 circuit-bg opacity-20 pointer-events-none" />
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl pointer-events-none" />
      <div className="fixed bottom-0 right-0 w-[600px] h-[600px] bg-accent/5 rounded-full blur-3xl pointer-events-none" />
      
      <Header isConnected={false} />
      
      <main className="relative z-10 max-w-6xl mx-auto px-4 py-6 pb-20">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main column */}
          <div className="lg:col-span-2 space-y-6">
            <WalletCard
              isConnected={false}
              onConnect={() => {
                // TODO: Implement wallet connection
              }}
            />
            
            <ActionButtons />
            
            <AssetList assets={[]} />
            
            <TransactionHistory transactions={[]} />
          </div>
          
          {/* Sidebar */}
          <div className="space-y-6">
            <SecurityStatus />
            
            {/* Network stats - empty state */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.5 }}
              className="bg-card rounded-xl border border-border p-4"
            >
              <h3 className="text-sm font-semibold text-foreground mb-4">Network Stats</h3>
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">Status</span>
                  <span className="text-sm font-mono text-muted-foreground">Not connected</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">Network</span>
                  <span className="text-sm font-mono text-muted-foreground">—</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">PQC Algorithm</span>
                  <span className="text-sm font-mono text-primary">Dilithium-3</span>
                </div>
              </div>
            </motion.div>

            {/* PQC Web Wallet Link */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.6 }}
              className="bg-gradient-to-br from-primary/10 to-accent/10 rounded-xl border border-primary/20 p-4"
            >
              <h3 className="text-sm font-semibold text-foreground mb-2">💰 PQC Web Wallet</h3>
              <p className="text-xs text-muted-foreground leading-relaxed mb-3">
                Create a quantum-safe wallet, claim tokens from the faucet, and send QBIT with ML-DSA signed transactions.
              </p>
              <Link to="/wallet">
                <Button className="w-full" variant="default">
                  <Wallet className="w-4 h-4 mr-2" />
                  Open Wallet
                </Button>
              </Link>
            </motion.div>

            {/* PQC Blockchain Demo Link */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.7 }}
              className="bg-gradient-to-br from-accent/10 to-primary/10 rounded-xl border border-accent/20 p-4"
            >
              <h3 className="text-sm font-semibold text-foreground mb-2">🔗 PQC Blockchain Demo</h3>
              <p className="text-xs text-muted-foreground leading-relaxed mb-3">
                Explore our post-quantum blockchain with CRYSTALS-Dilithium signatures. 
                Mine blocks and see quantum-safe cryptography in action.
              </p>
              <Link to="/blockchain">
                <Button className="w-full" variant="outline">
                  <Blocks className="w-4 h-4 mr-2" />
                  Launch Blockchain Demo
                </Button>
              </Link>
            </motion.div>

            {/* Info card */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.8 }}
              className="bg-gradient-to-br from-accent/10 to-primary/10 rounded-xl border border-accent/20 p-4"
            >
              <h3 className="text-sm font-semibold text-foreground mb-2">🛡️ Quantum-Safe</h3>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Protected by NIST-approved post-quantum cryptographic algorithms, 
                ensuring security against quantum computing threats.
              </p>
            </motion.div>
          </div>
        </div>
      </main>
      
      <NetworkBadge isConnected={false} />
    </div>
  );
};

export default Index;
