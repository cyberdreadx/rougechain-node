import { useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, Shield, Blocks } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import BlockchainVisualizer from "@/components/blockchain/BlockchainVisualizer";
import MiningPanel from "@/components/blockchain/MiningPanel";
import PQCInfo from "@/components/blockchain/PQCInfo";
import type { Block, Keypair } from "@/lib/pqc-blockchain";

const Blockchain = () => {
  const [chain, setChain] = useState<Block[]>([]);
  const [keypair, setKeypair] = useState<Keypair | null>(null);
  const [isValidating, setIsValidating] = useState(false);

  const handleGenesisCreated = (block: Block, kp: Keypair) => {
    setChain([block]);
    setKeypair(kp);
  };

  const handleBlockMined = (block: Block) => {
    setChain((prev) => [...prev, block]);
  };

  return (
    <div className="min-h-screen bg-background relative overflow-hidden">
      {/* Background effects */}
      <div className="fixed inset-0 circuit-bg opacity-20 pointer-events-none" />
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl pointer-events-none" />
      <div className="fixed bottom-0 right-0 w-[600px] h-[600px] bg-accent/5 rounded-full blur-3xl pointer-events-none" />

      {/* Header */}
      <motion.header
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="sticky top-0 z-50 flex items-center justify-between px-4 py-4 border-b border-border bg-card/50 backdrop-blur-xl"
      >
        <div className="flex items-center gap-3">
          <Link to="/">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="w-5 h-5" />
            </Button>
          </Link>
          <div className="flex items-center gap-2">
            <motion.div
              animate={{ rotate: [0, 360] }}
              transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
              className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center"
            >
              <Blocks className="w-4 h-4 text-primary-foreground" />
            </motion.div>
            <div>
              <h1 className="text-lg font-bold text-foreground">PQC Blockchain</h1>
              <p className="text-xs text-muted-foreground">Post-Quantum Demo</p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-secondary border border-border">
            <Shield className="w-4 h-4 text-primary" />
            <span className="text-xs text-muted-foreground">CRYSTALS-Dilithium</span>
          </div>
        </div>
      </motion.header>

      {/* Main content */}
      <main className="relative z-10 max-w-7xl mx-auto px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Chain visualization - spans 3 columns */}
          <div className="lg:col-span-3">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-card rounded-xl border border-border p-4"
            >
              <BlockchainVisualizer chain={chain} isValidating={isValidating} />
            </motion.div>

            {/* Stats */}
            {chain.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
                className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4"
              >
                <div className="bg-card rounded-lg border border-border p-3">
                  <p className="text-xs text-muted-foreground">Total Blocks</p>
                  <p className="text-2xl font-bold text-foreground">{chain.length}</p>
                </div>
                <div className="bg-card rounded-lg border border-border p-3">
                  <p className="text-xs text-muted-foreground">Chain Valid</p>
                  <p className="text-2xl font-bold text-success">✓</p>
                </div>
                <div className="bg-card rounded-lg border border-border p-3">
                  <p className="text-xs text-muted-foreground">Signature Algo</p>
                  <p className="text-sm font-medium text-primary">Dilithium-3</p>
                </div>
                <div className="bg-card rounded-lg border border-border p-3">
                  <p className="text-xs text-muted-foreground">Security Level</p>
                  <p className="text-sm font-medium text-foreground">NIST L3</p>
                </div>
              </motion.div>
            )}
          </div>

          {/* Sidebar */}
          <div className="space-y-4">
            <MiningPanel
              chain={chain}
              keypair={keypair}
              onBlockMined={handleBlockMined}
              onKeypairGenerated={setKeypair}
              onGenesisCreated={handleGenesisCreated}
            />
            <PQCInfo />
          </div>
        </div>
      </main>
    </div>
  );
};

export default Blockchain;
