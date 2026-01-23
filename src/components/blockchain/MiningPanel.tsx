import { useState } from "react";
import { motion } from "framer-motion";
import { Pickaxe, Zap, Shield, Key, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import type { Block, Keypair, CryptoInfo } from "@/lib/pqc-blockchain";
import { createGenesisBlock, mineBlock } from "@/lib/pqc-blockchain";

interface MiningPanelProps {
  chain: Block[];
  keypair: Keypair | null;
  onBlockMined: (block: Block) => void;
  onKeypairGenerated: (keypair: Keypair) => void;
  onGenesisCreated: (block: Block, keypair: Keypair, crypto?: CryptoInfo) => void;
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
  const [miningStage, setMiningStage] = useState("");

  const handleCreateGenesis = async () => {
    setIsMining(true);
    setMiningProgress(0);
    setMiningStage("Generating ML-DSA-65 keypair...");

    const progressInterval = setInterval(() => {
      setMiningProgress((prev) => Math.min(prev + 5, 90));
    }, 300);

    try {
      setMiningStage("Mining genesis block...");
      const { block, keypair, crypto } = await createGenesisBlock();
      
      clearInterval(progressInterval);
      setMiningProgress(100);
      setMiningStage("Signing with ML-DSA-65...");

      onGenesisCreated(block, keypair, crypto);
      toast.success("Genesis block created!", {
        description: `Real ML-DSA-65 signature: ${crypto.signatureSize}`,
        icon: <Sparkles className="w-4 h-4" />,
      });
    } catch (error) {
      toast.error("Failed to create genesis block", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
      console.error(error);
    } finally {
      setIsMining(false);
      setMiningStage("");
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
    setMiningStage("Mining block...");

    const progressInterval = setInterval(() => {
      setMiningProgress((prev) => Math.min(prev + 4, 85));
    }, 200);

    try {
      const lastBlock = chain[chain.length - 1];
      
      setMiningStage("Finding valid nonce...");
      const newBlock = await mineBlock(
        chain.length,
        blockData,
        lastBlock.hash,
        keypair.privateKey,
        keypair.publicKey
      );

      clearInterval(progressInterval);
      setMiningProgress(100);
      setMiningStage("Block signed & saved!");

      onBlockMined(newBlock);
      setBlockData("");
      toast.success(`Block #${newBlock.index} mined!`, {
        description: `Nonce: ${newBlock.nonce} | ML-DSA-65 signed | Saved to DB`,
        icon: <Sparkles className="w-4 h-4" />,
      });
    } catch (error) {
      toast.error("Mining failed", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
      console.error(error);
    } finally {
      setIsMining(false);
      setMiningStage("");
      setTimeout(() => setMiningProgress(0), 1000);
    }
  };

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Pickaxe className="w-5 h-5 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">Mining Console</h3>
        <span className="ml-auto px-2 py-0.5 text-[10px] rounded bg-success/20 text-success border border-success/30">
          REAL PQC
        </span>
      </div>

      {chain.length === 0 ? (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Create a genesis block with <span className="text-primary">real ML-DSA-65</span> (FIPS 204) 
            post-quantum signatures. Keys and blocks are persisted to the database.
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
            <span>{miningStage || "Mining progress"}</span>
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
            <span className="ml-auto px-1.5 py-0.5 text-[10px] rounded bg-primary/20 text-primary">
              FIPS 204
            </span>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              Public: <span className="font-mono">{keypair.publicKey.slice(0, 16)}...</span>
            </p>
            <p className="text-xs text-muted-foreground">
              Algorithm: <span className="text-primary font-medium">ML-DSA-65</span>
            </p>
            <p className="text-[10px] text-muted-foreground">
              (1952 byte public key, ~3300 byte signatures)
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default MiningPanel;
