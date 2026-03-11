import { motion } from "framer-motion";
import { TrendingUp, TrendingDown, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TokenIcon } from "@/components/ui/token-icon";

interface Asset {
  id: string;
  name: string;
  symbol: string;
  balance: string;
  value: string;
  usdValue?: string | null;
  pricePerToken?: string | null;
  change: number;
  icon: string;
  imageUrl?: string | null;  // Token image from on-chain metadata
}

interface AssetListProps {
  assets?: Asset[];
  emptyActionLabel?: string;
  onEmptyAction?: () => void;
  emptyHint?: string;
  onAssetClick?: (asset: Asset) => void;
}

const AssetList = ({ assets = [], emptyActionLabel, onEmptyAction, emptyHint, onAssetClick }: AssetListProps) => {
  const renderIcon = (asset: Asset) => (
    <TokenIcon symbol={asset.symbol} size={40} imageUrl={asset.imageUrl} />
  );

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
          <p className="text-xs text-muted-foreground/70 mt-1">
            {emptyHint || "Fund your wallet to get started"}
          </p>
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
          {assets.map((asset, index) => (
            <motion.div
              key={asset.id}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.3 + index * 0.05 }}
              className="flex items-center justify-between px-4 py-3 hover:bg-secondary/50 transition-colors cursor-pointer group"
              onClick={() => onAssetClick?.(asset)}
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
                <div className="flex flex-col items-end gap-0.5">
                  {asset.usdValue ? (
                    <span className="text-xs text-foreground font-medium">{asset.usdValue}</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">{asset.value}</span>
                  )}
                  {asset.pricePerToken && (
                    <span className="text-[10px] text-muted-foreground">
                      @ {asset.pricePerToken}
                    </span>
                  )}
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
