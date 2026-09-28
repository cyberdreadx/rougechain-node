import { useState, type CSSProperties } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Copy, Check, ExternalLink, RefreshCw, Send, Download, KeyRound, AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { TokenIcon } from "@/components/ui/token-icon";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { tokenAccent } from "@/lib/token-visual";
import { formatUsd } from "@/lib/price-service";
import { MASKED_AMOUNT } from "@/hooks/use-hide-balances";
import { useBaseAddress, useBaseBalances } from "@/hooks/use-base-wallet";
import { baseAddressUrl, basePriceUsd, formatBaseUnits } from "@/lib/base-wallet";
import { formatUnits } from "viem";
import BaseSendDialog from "./BaseSendDialog";
import BaseReceiveDialog from "./BaseReceiveDialog";

interface BaseWalletCardProps {
  mnemonic?: string | null;
  ethPriceUsd: number | null;
  xrgePriceUsd: number | null;
  balancesHidden?: boolean;
}

/**
 * The wallet's Base (Ethereum L2) account: same recovery phrase as the RougeChain
 * wallet, standard Ethereum path — the same address Qwalla shows.
 */
const BaseWalletCard = ({ mnemonic, ethPriceUsd, xrgePriceUsd, balancesHidden = false }: BaseWalletCardProps) => {
  const { t } = useTranslation();
  const { address, ready, hasAccount } = useBaseAddress(mnemonic);
  const { chain, balances, loading, error, refresh } = useBaseBalances(address);
  const [copied, setCopied] = useState(false);
  const [showSend, setShowSend] = useState(false);
  const [showReceive, setShowReceive] = useState(false);

  const copy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      toast.success(t("base.copied"));
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  };

  const rows = (balances ?? []).map((b) => {
    const price = basePriceUsd(chain, b.asset.symbol, ethPriceUsd, xrgePriceUsd);
    const human = b.raw == null ? null : Number(formatUnits(b.raw, b.asset.decimals));
    return {
      ...b,
      amount: b.raw == null ? "—" : formatBaseUnits(b.raw, b.asset.decimals, b.asset.decimals === 6 ? 2 : 6),
      usd: human != null && price != null ? human * price : null,
      price,
    };
  });
  const totalUsd = chain.isMainnet && rows.length > 0 ? rows.reduce((s, r) => s + (r.usd ?? 0), 0) : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.18 }}
      className="bg-card glass-card rounded-2xl border border-border overflow-hidden"
    >
      <div className="px-4 py-3 border-b border-border/70 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="hud-label">{t("base.title")}</h3>
          <span
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${chain.isMainnet ? "border-primary/40 text-primary" : "border-amber-500/50 text-amber-500 bg-amber-500/10"}`}
          >
            {chain.isMainnet ? chain.name : `${chain.name} · ${t("base.testnetBadge")}`}
          </span>
        </div>
        {address && (
          <div className="flex items-center gap-1 shrink-0">
            {totalUsd != null && !balancesHidden && (
              <span className="text-xs font-mono text-muted-foreground mr-1">{formatUsd(totalUsd)}</span>
            )}
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={refresh} disabled={loading} title={t("base.refresh")} aria-label={t("base.refresh")}>
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        )}
      </div>

      {!hasAccount ? (
        <EmptyState compact icon={KeyRound} title={t("base.noMnemonic.title")} hint={t("base.noMnemonic.hint")} />
      ) : !ready || !address ? (
        <div className="p-6 flex justify-center"><div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary" /></div>
      ) : (
        <>
          {/* Address */}
          <div className="px-4 pt-3">
            <div className="gradient-ring rounded-xl p-[1px]">
              <div className="rounded-xl bg-card/90 px-3 py-2 flex items-center gap-2">
                <code className="font-mono text-xs text-foreground break-all flex-1 min-w-0">{address}</code>
                <button type="button" onClick={copy} className="p-1.5 rounded hover:bg-secondary shrink-0" title={t("base.copyAddress")} aria-label={t("base.copyAddress")}>
                  {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5 text-muted-foreground" />}
                </button>
                <a href={baseAddressUrl(chain, address)} target="_blank" rel="noopener noreferrer" className="p-1.5 rounded hover:bg-secondary shrink-0" title={t("base.viewOnExplorer")} aria-label={t("base.viewOnExplorer")}>
                  <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                </a>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1.5">{t("base.sameAddressHint")}</p>
          </div>

          {error && (
            <div className="mx-4 mt-2 flex items-center gap-1.5 text-xs text-amber-500">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>{t("base.rpcError", { chain: chain.name })}</span>
            </div>
          )}

          {/* Balances */}
          {balances == null ? (
            <div className="p-6 flex justify-center">
              {error ? null : <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary" />}
            </div>
          ) : (
            <ul className="divide-y divide-border/60 mt-2">
              {rows.map((r) => (
                <li key={r.asset.symbol}>
                  <div className="token-row" style={{ "--token-accent": tokenAccent(r.asset.symbol) } as CSSProperties}>
                    <TokenIcon symbol={r.asset.symbol} size={36} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-foreground truncate">{t(`base.assets.${r.asset.symbol}`)}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        <span className="font-mono">{r.asset.symbol}</span>
                        {r.price != null && <span className="opacity-80"> · {formatUsd(r.price)}</span>}
                      </p>
                    </div>
                    <div className="text-right shrink-0 pl-2 max-w-[50%]">
                      <p className="text-sm font-semibold text-foreground font-mono tabular-nums truncate">
                        {balancesHidden ? MASKED_AMOUNT : r.amount}
                      </p>
                      <p className="text-xs text-muted-foreground font-mono tabular-nums truncate">
                        {balancesHidden ? MASKED_AMOUNT : r.usd != null ? formatUsd(r.usd) : r.asset.symbol}
                      </p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="grid grid-cols-2 gap-2 p-4 pt-3">
            <Button variant="outline" className="gap-2" onClick={() => setShowSend(true)} disabled={balances == null}>
              <Send className="w-4 h-4" /> {t("base.send")}
            </Button>
            <Button variant="outline" className="gap-2" onClick={() => setShowReceive(true)}>
              <Download className="w-4 h-4" /> {t("base.receive")}
            </Button>
          </div>
        </>
      )}

      <AnimatePresence>
        {showSend && address && mnemonic && balances && (
          <BaseSendDialog
            chain={chain}
            address={address}
            mnemonic={mnemonic}
            balances={balances}
            ethPriceUsd={ethPriceUsd}
            xrgePriceUsd={xrgePriceUsd}
            onClose={() => setShowSend(false)}
            onSent={() => { setTimeout(refresh, 4000); }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showReceive && address && (
          <BaseReceiveDialog chain={chain} address={address} onClose={() => setShowReceive(false)} />
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export default BaseWalletCard;
