import { motion } from "framer-motion";
import { ArrowUpRight, ArrowDownLeft, RefreshCw, History } from "lucide-react";

interface Transaction {
  id: string;
  type: "send" | "receive" | "swap";
  amount: string;
  symbol: string;
  address: string;
  time: string;
  status: "completed" | "pending";
}

interface TransactionHistoryProps {
  transactions?: Transaction[];
}

const getIcon = (type: string) => {
  switch (type) {
    case "send":
      return <ArrowUpRight className="w-4 h-4 text-destructive" />;
    case "receive":
      return <ArrowDownLeft className="w-4 h-4 text-success" />;
    case "swap":
      return <RefreshCw className="w-4 h-4 text-accent" />;
    default:
      return null;
  }
};

const TransactionHistory = ({ transactions = [] }: TransactionHistoryProps) => {
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
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center">
                  {getIcon(tx.type)}
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground capitalize">{tx.type}</p>
                  <p className="text-xs text-muted-foreground font-mono">{tx.address}</p>
                </div>
              </div>
              
              <div className="text-right">
                <p className={`text-sm font-medium font-mono ${
                  tx.type === "receive" ? "text-success" : 
                  tx.type === "send" ? "text-destructive" : "text-foreground"
                }`}>
                  {tx.amount} {tx.symbol}
                </p>
                <p className="text-xs text-muted-foreground">{tx.time}</p>
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </motion.div>
  );
};

export default TransactionHistory;
