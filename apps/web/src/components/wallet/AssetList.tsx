import type { CSSProperties } from "react";
import { motion } from "framer-motion";
import { TrendingUp, TrendingDown, Coins, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TokenIcon } from "@/components/ui/token-icon";
import { EmptyState } from "@/components/ui/empty-state";
import { tokenAccent } from "@/lib/token-visual";

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

/** Wallet token list, Qwalla-style: icon, name + price, balance + USD value, hover glow. */
const AssetList = ({ assets = [], emptyActionLabel, onEmptyAction, emptyHint, onAssetClick }: AssetListProps) => {
  const { t } = useTranslation();

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.15 }}
      className="bg-card glass-card rounded-2xl border border-border overflow-hidden"
    >
      <div className="px-4 py-3 border-b border-border/70 flex items-center justify-between">
        <h3 className="hud-label">{t("visual.assets.title")}</h3>
        {assets.length > 0 && (
          <span className="text-xs font-mono text-muted-foreground">{assets.length}</span>
        )}
      </div>

      {assets.length === 0 ? (
        <EmptyState
          compact
          icon={Coins}
          title={t("visual.assets.emptyTitle")}
          hint={emptyHint || t("visual.assets.emptyHint")}
          ctaLabel={emptyActionLabel}
          onCta={onEmptyAction}
        />
      ) : (
        <ul className="divide-y divide-border/60">
          {assets.map((asset, index) => (
            <motion.li
              key={asset.id}
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.2 + index * 0.04 }}
            >
              <button
                type="button"
                className="token-row row-glow group"
                style={{ "--token-accent": tokenAccent(asset.symbol) } as CSSProperties}
                onClick={() => onAssetClick?.(asset)}
              >
                <TokenIcon symbol={asset.symbol} size={40} imageUrl={asset.imageUrl} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground truncate">{asset.name || asset.symbol}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    <span className="font-mono">{asset.symbol}</span>
                    {asset.pricePerToken ? <span className="opacity-80"> · {asset.pricePerToken}</span> : null}
                  </p>
                </div>
                <div className="text-right shrink-0 pl-2 max-w-[48%]">
                  <p className="text-sm font-semibold text-foreground font-mono tabular-nums truncate">
                    {asset.usdValue ?? asset.balance}
                  </p>
                  <p className="text-xs text-muted-foreground font-mono tabular-nums truncate">
                    {asset.usdValue ? asset.value : asset.symbol}
                  </p>
                  {asset.change !== 0 && (
                    <span className={`inline-flex items-center gap-0.5 text-xs ${asset.change >= 0 ? "text-success" : "text-destructive"}`}>
                      {asset.change >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                      {Math.abs(asset.change)}%
                    </span>
                  )}
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground/50 shrink-0 transition-transform group-hover:translate-x-0.5 group-hover:text-hologram" />
              </button>
            </motion.li>
          ))}
        </ul>
      )}
    </motion.div>
  );
};

export default AssetList;
