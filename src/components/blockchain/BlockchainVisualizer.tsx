import { motion, AnimatePresence } from "framer-motion";
import { Shield, Link, Hash, Clock } from "lucide-react";
import type { Block } from "@/lib/pqc-blockchain";

interface BlockchainVisualizerProps {
  chain: Block[];
  isValidating?: boolean;
}

const BlockCard = ({ block, index, isFirst }: { block: Block; index: number; isFirst: boolean }) => {
  const truncate = (str: string, len: number) =>
    str.length > len ? `${str.slice(0, len)}...` : str;
  const getTxCount = () => {
    try {
      const parsed = JSON.parse(block.data);
      if (Array.isArray(parsed)) return parsed.length;
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.txs)) {
        return parsed.txs.length;
      }
      return parsed ? 1 : 0;
    } catch {
      return 0;
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: 50, scale: 0.9 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      transition={{ delay: index * 0.1, duration: 0.4 }}
      className="relative"
    >
      {/* Chain link connector */}
      {!isFirst && (
        <div className="absolute -left-6 top-1/2 -translate-y-1/2 flex items-center">
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: 24 }}
            transition={{ delay: index * 0.1 + 0.2 }}
            className="h-0.5 bg-gradient-to-r from-primary/50 to-primary"
          />
          <Link className="w-4 h-4 text-primary animate-pulse" />
        </div>
      )}

      <div className="bg-card border border-border rounded-xl p-3 min-w-[220px] hover:border-primary/50 transition-colors group">
        {/* Block header */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-primary/20 flex items-center justify-center">
              <span className="text-primary font-bold text-xs">#{block.index}</span>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">Block</p>
              <p className="text-xs font-medium text-foreground">
                {block.index === 0 ? "Genesis" : `Block ${block.index}`}
              </p>
            </div>
          </div>
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
          >
            <Shield className="w-5 h-5 text-primary" />
          </motion.div>
        </div>

        {/* Block data */}
        <div className="space-y-2 text-[11px]">
          <div className="flex items-start gap-2 p-2 rounded-lg bg-muted/50">
            <Hash className="w-3 h-3 text-muted-foreground mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-muted-foreground">Hash</p>
              <p className="font-mono text-foreground break-all">{truncate(block.hash, 18)}</p>
            </div>
          </div>

          <div className="flex items-start gap-2 p-2 rounded-lg bg-muted/50">
            <Link className="w-3 h-3 text-muted-foreground mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-muted-foreground">Prev Hash</p>
              <p className="font-mono text-foreground break-all">{truncate(block.previousHash, 14)}</p>
            </div>
          </div>

          <div className="flex items-start gap-2 p-2 rounded-lg bg-muted/50">
            <Clock className="w-3 h-3 text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <p className="text-muted-foreground">Timestamp</p>
              <p className="font-mono text-foreground">
                {new Date(block.timestamp).toLocaleTimeString()}
              </p>
            </div>
          </div>
        </div>

        {/* Compact footer */}
        <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{getTxCount()} tx</span>
          <span className="text-success flex items-center gap-1">
            <div className="w-1.5 h-1.5 rounded-full bg-success" />
            Verified
          </span>
        </div>
      </div>
    </motion.div>
  );
};

const BlockchainVisualizer = ({ chain, isValidating }: BlockchainVisualizerProps) => {
  return (
    <div className="relative">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">Blockchain</h3>
          <span className="px-2 py-0.5 text-xs rounded-full bg-primary/20 text-primary">
            {chain.length} blocks
          </span>
        </div>
        {isValidating && (
          <motion.div
            animate={{ opacity: [0.5, 1, 0.5] }}
            transition={{ duration: 1.5, repeat: Infinity }}
            className="text-xs text-primary"
          >
            Validating chain...
          </motion.div>
        )}
      </div>

      {/* Chain visualization */}
      <div className="overflow-x-auto pb-4">
        <div className="flex gap-6 pl-2">
          <AnimatePresence>
            {chain.map((block, index) => (
              <BlockCard
                key={block.hash}
                block={block}
                index={index}
                isFirst={index === 0}
              />
            ))}
          </AnimatePresence>
        </div>
      </div>

      {chain.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <Shield className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p>No blocks yet. Create a genesis block to start.</p>
        </div>
      )}
    </div>
  );
};

export default BlockchainVisualizer;
