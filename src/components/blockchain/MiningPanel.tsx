import { useState } from "react";
import { motion } from "framer-motion";
import { Pickaxe, Zap, Shield, Key } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import type { Block, Keypair } from "@/lib/pqc-blockchain";
import { createGenesisBlock, mineBlock } from "@/lib/pqc-blockchain";

interface MiningPanelProps {
  chain: Block[];
  keypair: Keypair | null;
  onBlockMined: (block: Block) => void;
  onKeypairGenerated: (keypair: Keypair) => void;
  onGenesisCreated: (block: Block, keypair: Keypair) => void;
}

const MiningPanel = ({
  chain,
  keypair,
  onBlockMined,
  onKeypairGenerated,
  onGenesisCreated,
}: MiningPanelProps) => {
  const [blockData, setBlockData] = useState("");
  const [isMining, setIsMining] = useState(false);
  const [miningProgress, setMiningProgress] = useState(0);

  const handleCreateGenesis = async () => {
    setIsMining(true);
    setMiningProgress(0);

    // Simulate mining progress
    const progressInterval = setInterval(() => {
      setMiningProgress((prev) => Math.min(prev + 10, 90));
    }, 200);

    try {
      const { block, keypair } = await createGenesisBlock();
      clearInterval(progressInterval);
      setMiningProgress(100);
      
      onGenesisCreated(block, keypair);
      toast.success("Genesis block created with PQC signature!", {
        description: "CRYSTALS-Dilithium key pair generated",
      });
    } catch (error) {
      toast.error("Failed to create genesis block");
      console.error(error);
    } finally {
      setIsMining(false);
      setTimeout(() => setMiningProgress(0), 1000);
    }
  };

  const handleMineBlock = async () => {
    if (!blockData.trim()) {
      toast.error("Please enter block data");
      return;
    }

    if (!keypair) {
      toast.error("No keypair available");
      return;
    }

    setIsMining(true);
    setMiningProgress(0);

    const progressInterval = setInterval(() => {
      setMiningProgress((prev) => Math.min(prev + 8, 85));
    }, 150);

    try {
      const lastBlock = chain[chain.length - 1];
      const newBlock = await mineBlock(
        chain.length,
        blockData,
        lastBlock.hash,
        keypair.privateKey,
        keypair.publicKey
      );

      clearInterval(progressInterval);
      setMiningProgress(100);

      onBlockMined(newBlock);
      setBlockData("");
      toast.success(`Block #${newBlock.index} mined!`, {
        description: `Nonce: ${newBlock.nonce} | Dilithium signed`,
      });
    } catch (error) {
      toast.error("Mining failed");
      console.error(error);
    } finally {
      setIsMining(false);
      setTimeout(() => setMiningProgress(0), 1000);
    }
  };

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Pickaxe className="w-5 h-5 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">Mining Console</h3>
      </div>

      {chain.length === 0 ? (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Start by creating a genesis block. This will generate a new CRYSTALS-Dilithium
            keypair and sign the first block.
          </p>
          <Button
            onClick={handleCreateGenesis}
            disabled={isMining}
            className="w-full bg-primary hover:bg-primary/90"
          >
            {isMining ? (
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
              >
                <Zap className="w-4 h-4 mr-2" />
              </motion.div>
            ) : (
              <Shield className="w-4 h-4 mr-2" />
            )}
            {isMining ? "Creating Genesis..." : "Create Genesis Block"}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Block Data</label>
            <Input
              value={blockData}
              onChange={(e) => setBlockData(e.target.value)}
              placeholder="Enter transaction data..."
              className="bg-muted border-border"
              disabled={isMining}
            />
          </div>

          <Button
            onClick={handleMineBlock}
            disabled={isMining || !blockData.trim()}
            className="w-full bg-primary hover:bg-primary/90"
          >
            {isMining ? (
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
              >
                <Pickaxe className="w-4 h-4 mr-2" />
              </motion.div>
            ) : (
              <Pickaxe className="w-4 h-4 mr-2" />
            )}
            {isMining ? "Mining..." : "Mine Block"}
          </Button>
        </div>
      )}

      {/* Mining progress */}
      {miningProgress > 0 && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Mining progress</span>
            <span>{miningProgress}%</span>
          </div>
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${miningProgress}%` }}
              className="h-full bg-gradient-to-r from-primary to-accent"
            />
          </div>
        </div>
      )}

      {/* Keypair info */}
      {keypair && (
        <div className="p-3 rounded-lg bg-muted/50 border border-border space-y-2">
          <div className="flex items-center gap-2">
            <Key className="w-4 h-4 text-primary" />
            <span className="text-xs font-medium text-foreground">Active Keypair</span>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              Public: <span className="font-mono">{keypair.publicKey.slice(0, 16)}...</span>
            </p>
            <p className="text-xs text-muted-foreground">
              Algorithm: <span className="text-primary">CRYSTALS-Dilithium-3</span>
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default MiningPanel;
