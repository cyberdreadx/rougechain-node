import { motion } from "framer-motion";
import { ArrowUpRight, ArrowDownLeft, RefreshCw } from "lucide-react";

interface Transaction {
  id: string;
  type: "send" | "receive" | "swap";
  amount: string;
  symbol: string;
  address: string;
  time: string;
  status: "completed" | "pending";
}

const transactions: Transaction[] = [
  {
    id: "1",
    type: "receive",
    amount: "+0.5",
    symbol: "ETH",
    address: "0x1a2b...3c4d",
    time: "2 hours ago",
    status: "completed",
  },
  {
    id: "2",
    type: "send",
    amount: "-1,000",
    symbol: "USDC",
    address: "0x5e6f...7g8h",
    time: "5 hours ago",
    status: "completed",
  },
  {
    id: "3",
    type: "swap",
    amount: "0.2 ETH → 320 USDC",
    symbol: "",
    address: "Uniswap",
    time: "1 day ago",
    status: "completed",
  },
  {
    id: "4",
    type: "receive",
    amount: "+2,500",
    symbol: "BASE",
    address: "0x9i0j...1k2l",
    time: "2 days ago",
    status: "completed",
  },
];

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

const TransactionHistory = () => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.3 }}
      className="bg-card rounded-xl border border-border overflow-hidden"
    >
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Recent Activity</h3>
        <button className="text-xs text-primary hover:underline">View All</button>
      </div>
      
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
    </motion.div>
  );
};

export default TransactionHistory;
