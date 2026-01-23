import { motion } from "framer-motion";
import { TrendingUp, TrendingDown } from "lucide-react";

interface Asset {
  id: string;
  name: string;
  symbol: string;
  balance: string;
  value: string;
  change: number;
  icon: string;
}

const assets: Asset[] = [
  {
    id: "1",
    name: "Ethereum",
    symbol: "ETH",
    balance: "2.4521",
    value: "$4,892.42",
    change: 3.24,
    icon: "◈",
  },
  {
    id: "2",
    name: "Base",
    symbol: "BASE",
    balance: "15,432.50",
    value: "$1,543.25",
    change: -1.82,
    icon: "◎",
  },
  {
    id: "3",
    name: "USD Coin",
    symbol: "USDC",
    balance: "2,500.00",
    value: "$2,500.00",
    change: 0.01,
    icon: "◉",
  },
  {
    id: "4",
    name: "Wrapped BTC",
    symbol: "WBTC",
    balance: "0.0521",
    value: "$2,187.32",
    change: 2.15,
    icon: "₿",
  },
];

const AssetList = () => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.2 }}
      className="bg-card rounded-xl border border-border overflow-hidden"
    >
      <div className="px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground">Assets</h3>
      </div>
      
      <div className="divide-y divide-border">
        {assets.map((asset, index) => (
          <motion.div
            key={asset.id}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.3 + index * 0.05 }}
            className="flex items-center justify-between px-4 py-3 hover:bg-secondary/50 transition-colors cursor-pointer group"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center text-lg font-bold text-primary group-hover:bg-primary/20 transition-colors">
                {asset.icon}
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">{asset.name}</p>
                <p className="text-xs text-muted-foreground">{asset.symbol}</p>
              </div>
            </div>
            
            <div className="text-right">
              <p className="text-sm font-medium text-foreground">{asset.balance}</p>
              <div className="flex items-center justify-end gap-1">
                <span className="text-xs text-muted-foreground">{asset.value}</span>
                <span className={`flex items-center text-xs ${asset.change >= 0 ? 'text-success' : 'text-destructive'}`}>
                  {asset.change >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                  {Math.abs(asset.change)}%
                </span>
              </div>
            </div>
          </motion.div>
        ))}
      </div>
    </motion.div>
  );
};

export default AssetList;
