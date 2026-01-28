import { useState } from "react";
import { motion } from "framer-motion";
import { ArrowUpRight, ArrowDownLeft, RefreshCw, History, Plus, Coins, ExternalLink, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EXPLORER_URL } from "@/lib/pqc-wallet";

interface Transaction {
  id: string;
  type: "send" | "receive" | "swap" | "create_token" | "fee";
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
      return <RefreshCw className="w-4 h-4 text-accent" />;
    case "create_token":
      return <Plus className="w-4 h-4 text-primary" />;
    case "fee":
      return <Coins className="w-4 h-4 text-muted-foreground" />;
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
    default:
      return type;
  }
};

const TransactionHistory = ({ transactions = [], emptyActionLabel, onEmptyAction }: TransactionHistoryProps) => {
  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);

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

  const explorerUrl = (txHash?: string) => {
    if (!txHash) return "";
    return `${EXPLORER_URL.replace(/\/+$/, "")}/tx/${txHash}`;
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.3 }}
      className="bg-card rounded-xl border border-border overflow-hidden"
    >
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Recent Activity</h3>
        {transactions.length > 0 && (
          <button className="text-xs text-primary hover:underline">View All</button>
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
          {transactions.map((tx, index) => (
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
                  tx.type === "receive" ? "text-success" : 
                  tx.type === "send" ? "text-destructive" : 
                  tx.type === "create_token" ? "text-primary" : "text-foreground"
                }`}>
                  {tx.type === "send" ? "-" : tx.type === "receive" ? "+" : ""}{tx.amount} {tx.symbol}
                </p>
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
        <DialogContent>
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
                  <p className="font-mono text-foreground">{formatTimestamp(selectedTx.timestamp)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Block</p>
                  <p className="font-mono text-foreground">#{selectedTx.blockIndex ?? "—"}</p>
                </div>
              </div>

              <div className="space-y-2">
                <div>
                  <p className="text-xs text-muted-foreground">From</p>
                  <p className="font-mono text-foreground break-all">{selectedTx.from ?? "—"}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">To</p>
                  <p className="font-mono text-foreground break-all">{selectedTx.to ?? "—"}</p>
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
                    <a href={explorerUrl(selectedTx.txHash)} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="w-4 h-4 mr-2" />
                      View in Explorer
                    </a>
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
