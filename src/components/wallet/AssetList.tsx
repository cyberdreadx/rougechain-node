import { motion } from "framer-motion";
import { TrendingUp, TrendingDown, Wallet } from "lucide-react";
import xrgeLogo from "@/assets/xrge-logo.webp";

interface Asset {
  id: string;
  name: string;
  symbol: string;
  balance: string;
  value: string;
  change: number;
  icon: string;
}

interface AssetListProps {
  assets?: Asset[];
}

const AssetList = ({ assets = [] }: AssetListProps) => {
  const renderIcon = (asset: Asset) => {
    if (asset.symbol === "XRGE") {
      return (
        <img 
          src={xrgeLogo} 
          alt="XRGE" 
          className="w-10 h-10 rounded-full object-cover"
        />
      );
    }
    return (
      <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center text-lg font-bold text-primary group-hover:bg-primary/20 transition-colors">
        {asset.icon}
      </div>
    );
  };

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
      
      {assets.length === 0 ? (
        <div className="py-12 text-center">
          <Wallet className="w-10 h-10 mx-auto mb-3 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">No assets yet</p>
          <p className="text-xs text-muted-foreground/70 mt-1">Claim from faucet to get started</p>
        </div>
      ) : (
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
                {renderIcon(asset)}
                <div>
                  <p className="text-sm font-medium text-foreground">{asset.name}</p>
                  <p className="text-xs text-muted-foreground">{asset.symbol}</p>
                </div>
              </div>
              
              <div className="text-right">
                <p className="text-sm font-medium text-foreground">{asset.balance}</p>
                <div className="flex items-center justify-end gap-1">
                  <span className="text-xs text-muted-foreground">{asset.value}</span>
                  {asset.change !== 0 && (
                    <span className={`flex items-center text-xs ${asset.change >= 0 ? 'text-success' : 'text-destructive'}`}>
                      {asset.change >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                      {Math.abs(asset.change)}%
                    </span>
                  )}
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </motion.div>
  );
};

export default AssetList;
