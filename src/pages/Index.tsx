import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { Blocks } from "lucide-react";
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
      
      <Header />
      
      <main className="relative z-10 max-w-6xl mx-auto px-4 py-6 pb-20">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main column */}
          <div className="lg:col-span-2 space-y-6">
            <WalletCard
              address="0x742d35Cc6634C0532925a3b844Bc9e7595f8234f"
              balance="2.4521"
              usdValue="4,892.42"
            />
            
            <ActionButtons />
            
            <AssetList />
            
            <TransactionHistory />
          </div>
          
          {/* Sidebar */}
          <div className="space-y-6">
            <SecurityStatus />
            
            {/* Quick stats */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.5 }}
              className="bg-card rounded-xl border border-border p-4"
            >
              <h3 className="text-sm font-semibold text-foreground mb-4">Network Stats</h3>
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">Gas Price</span>
                  <span className="text-sm font-mono text-foreground">0.001 GWEI</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">Block Time</span>
                  <span className="text-sm font-mono text-foreground">2.0s</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">TPS</span>
                  <span className="text-sm font-mono text-foreground">1,247</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">PQC Algorithm</span>
                  <span className="text-sm font-mono text-primary">Dilithium-3</span>
                </div>
              </div>
            </motion.div>

            {/* PQC Blockchain Demo Link */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.6 }}
              className="bg-gradient-to-br from-primary/10 to-accent/10 rounded-xl border border-primary/20 p-4"
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
              transition={{ delay: 0.7 }}
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
      
      <NetworkBadge />
    </div>
  );
};

export default Index;
