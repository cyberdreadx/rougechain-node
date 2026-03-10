import { useState } from "react";
import { motion } from "framer-motion";
import { ArrowUpRight, ArrowDownLeft, RefreshCw, History, Plus, Coins, ExternalLink, Copy, ArrowDownUp, Lock, Unlock, Droplets, Image, ArrowLeftRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Link } from "react-router-dom";

interface Transaction {
  id: string;
  type: "send" | "receive" | "swap" | "create_token" | "fee" | "stake" | "unstake" | "add_liquidity" | "remove_liquidity" | "create_pool" | "nft_mint" | "nft_transfer" | "bridge";
  amount: string;
  symbol: string;
  address: string;
  timeLabel: string;
  timestamp: number;
  status: "completed" | "pending";
  fee?: number;
  blockIndex?: number;
  txHash?: string;
  from?: string;
  to?: string;
  memo?: string;
}

interface TransactionHistoryProps {
  transactions?: Transaction[];
  emptyActionLabel?: string;
  onEmptyAction?: () => void;
}

const getIcon = (type: string) => {
  switch (type) {
    case "send":
      return <ArrowUpRight className="w-4 h-4 text-destructive" />;
    case "receive":
      return <ArrowDownLeft className="w-4 h-4 text-success" />;
    case "swap":
      return <ArrowDownUp className="w-4 h-4 text-accent" />;
    case "create_token":
    case "create_pool":
      return <Plus className="w-4 h-4 text-primary" />;
    case "fee":
      return <Coins className="w-4 h-4 text-muted-foreground" />;
    case "stake":
      return <Lock className="w-4 h-4 text-primary" />;
    case "unstake":
      return <Unlock className="w-4 h-4 text-accent" />;
    case "add_liquidity":
    case "remove_liquidity":
      return <Droplets className="w-4 h-4 text-blue-400" />;
    case "nft_mint":
    case "nft_transfer":
      return <Image className="w-4 h-4 text-purple-400" />;
    case "bridge":
      return <ArrowLeftRight className="w-4 h-4 text-amber-400" />;
    default:
      return null;
  }
};

const getTypeLabel = (type: string) => {
  switch (type) {
    case "send":
      return "Sent";
    case "receive":
      return "Received";
    case "swap":
      return "Swap";
    case "create_token":
      return "Token Created";
    case "fee":
      return "Fee";
    case "stake":
      return "Staked";
    case "unstake":
      return "Unstaked";
    case "add_liquidity":
      return "Liquidity";
    case "remove_liquidity":
      return "Removed LP";
    case "create_pool":
      return "Pool Created";
    case "nft_mint":
      return "NFT";
    case "nft_transfer":
      return "NFT Transfer";
    case "bridge":
      return "Bridge";
    default:
      return type;
  }
};

const INITIAL_DISPLAY_COUNT = 5;

const TransactionHistory = ({ transactions = [], emptyActionLabel, onEmptyAction }: TransactionHistoryProps) => {
  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
  const [showAll, setShowAll] = useState(false);

  const formatTimestamp = (timestamp?: number) => {
    if (!timestamp) return "—";
    return new Date(timestamp).toLocaleString();
  };

  const handleCopy = async (value?: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // ignore clipboard errors
    }
  };

  const explorerPath = (txHash?: string) => {
    if (!txHash) return "/transactions";
    return `/tx/${txHash}`;
  };

  const displayedTxs = showAll ? transactions : transactions.slice(0, INITIAL_DISPLAY_COUNT);
  const hasMore = transactions.length > INITIAL_DISPLAY_COUNT;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.3 }}
      className="bg-card rounded-xl border border-border overflow-hidden"
    >
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Recent Activity</h3>
        {hasMore && (
          <button 
            className="text-xs text-primary hover:underline"
            onClick={() => setShowAll(!showAll)}
          >
            {showAll ? "Show Less" : `View All (${transactions.length})`}
          </button>
        )}
      </div>
      
      {transactions.length === 0 ? (
        <div className="py-12 text-center">
          <History className="w-10 h-10 mx-auto mb-3 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">No transactions yet</p>
          <p className="text-xs text-muted-foreground/70 mt-1">Your activity will appear here</p>
          {emptyActionLabel && onEmptyAction && (
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={onEmptyAction}
            >
              {emptyActionLabel}
            </Button>
          )}
        </div>
      ) : (
        <div className="divide-y divide-border">
          {displayedTxs.map((tx, index) => (
            <motion.div
              key={tx.id}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.4 + index * 0.05 }}
              className="flex items-center justify-between px-4 py-3 hover:bg-secondary/50 transition-colors cursor-pointer"
              onClick={() => setSelectedTx(tx)}
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center">
                  {getIcon(tx.type)}
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">{getTypeLabel(tx.type)}</p>
                  <p className="text-xs text-muted-foreground font-mono">{tx.address}</p>
                </div>
              </div>
              
              <div className="text-right">
                <p className={`text-sm font-medium font-mono ${
                  tx.type === "receive" || tx.type === "unstake" ? "text-success" : 
                  tx.type === "send" || tx.type === "stake" ? "text-destructive" : 
                  tx.type === "create_token" ? "text-primary" : 
                  tx.type === "swap" ? "text-accent" :
                  tx.type === "nft_mint" || tx.type === "nft_transfer" ? "text-purple-400" :
                  tx.type === "bridge" ? "text-amber-400" :
                  "text-foreground"
                }`}>
                  {tx.type === "send" || tx.type === "stake" ? "-" : tx.type === "receive" || tx.type === "unstake" ? "+" : ""}{tx.memo && (tx.type === "swap" || tx.type === "add_liquidity" || tx.type === "remove_liquidity" || tx.type === "nft_mint" || tx.type === "bridge") ? "" : `${tx.amount} ${tx.symbol}`}
                </p>
                {tx.memo && (tx.type === "swap" || tx.type === "add_liquidity" || tx.type === "remove_liquidity" || tx.type === "nft_mint" || tx.type === "bridge") && (
                  <p className="text-xs text-muted-foreground truncate max-w-[160px]">{tx.memo}</p>
                )}
                <div className="flex items-center justify-end gap-1">
                  <p className="text-xs text-muted-foreground">{tx.timeLabel}</p>
                  {tx.fee && tx.fee > 0 && (
                    <span className="text-[10px] text-muted-foreground">• {tx.fee} fee</span>
                  )}
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      )}

      <Dialog open={!!selectedTx} onOpenChange={(open) => !open && setSelectedTx(null)}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Transaction Details</DialogTitle>
            <DialogDescription>
              {selectedTx ? `${getTypeLabel(selectedTx.type)} • ${selectedTx.timeLabel}` : ""}
            </DialogDescription>
          </DialogHeader>
          {selectedTx && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-muted-foreground">Amount</p>
                  <p className="font-mono text-foreground">
                    {selectedTx.type === "send" ? "-" : selectedTx.type === "receive" ? "+" : ""}{selectedTx.amount} {selectedTx.symbol}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Status</p>
                  <p className="text-foreground capitalize">{selectedTx.status}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Timestamp</p>
                  <p className="font-mono text-foreground text-xs">{formatTimestamp(selectedTx.timestamp)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Block</p>
                  <p className="font-mono text-foreground">#{selectedTx.blockIndex ?? "—"}</p>
                </div>
              </div>

              <div className="space-y-2">
                <div>
                  <p className="text-xs text-muted-foreground">From</p>
                  <p className="font-mono text-foreground text-xs break-all">{selectedTx.from ?? "—"}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">To</p>
                  <p className="font-mono text-foreground text-xs break-all">{selectedTx.to ?? "—"}</p>
                </div>
                {selectedTx.memo && (
                  <div>
                    <p className="text-xs text-muted-foreground">Memo</p>
                    <p className="text-foreground">{selectedTx.memo}</p>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                {selectedTx.txHash && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleCopy(selectedTx.txHash)}
                  >
                    <Copy className="w-4 h-4 mr-2" />
                    Copy TX Hash
                  </Button>
                )}
                {selectedTx.txHash && (
                  <Button
                    variant="outline"
                    size="sm"
                    asChild
                  >
                    <Link to={explorerPath(selectedTx.txHash)}>
                      <ExternalLink className="w-4 h-4 mr-2" />
                      View in Explorer
                    </Link>
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </motion.div>
  );
};

export default TransactionHistory;
