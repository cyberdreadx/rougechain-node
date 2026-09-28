import { useEffect, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { X, Copy, Check, ExternalLink, AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { toDataURL } from "qrcode";
import { Button } from "@/components/ui/button";
import { baseAddressUrl, type BaseChainInfo } from "@/lib/base-wallet";

/** Modal shell shared by the Base dialogs (matches the wallet's other dialogs). */
export function BaseModal({ title, onClose, children, dismissable = true }: { title: ReactNode; onClose: () => void; children: ReactNode; dismissable?: boolean }) {
  const { t } = useTranslation();
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={dismissable ? onClose : undefined}
    >
      <motion.div
        initial={{ y: 24, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 24, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        className="w-full sm:max-w-md max-h-[92vh] overflow-y-auto bg-card rounded-t-2xl sm:rounded-2xl border border-border p-5 sm:p-6 shadow-xl"
      >
        <div className="flex items-center justify-between mb-5 gap-2">
          <h2 className="text-lg sm:text-xl font-bold text-foreground">{title}</h2>
          {dismissable && (
            <Button variant="ghost" size="icon" onClick={onClose} aria-label={t("common.close")}>
              <X className="w-5 h-5" />
            </Button>
          )}
        </div>
        {children}
      </motion.div>
    </motion.div>
  );
}

const BaseReceiveDialog = ({ chain, address, onClose }: { chain: BaseChainInfo; address: string; onClose: () => void }) => {
  const { t } = useTranslation();
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    toDataURL(address, { width: 220, margin: 2, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } })
      .then((url) => { if (!cancelled) setQr(url); })
      .catch(() => { if (!cancelled) setQr(null); });
    return () => { cancelled = true; };
  }, [address]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      toast.success(t("base.copied"));
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  };

  return (
    <BaseModal title={t("base.receiveDialog.title", { chain: chain.name })} onClose={onClose}>
      <div className="space-y-4">
        {qr ? (
          <div className="bg-white rounded-xl p-3 mx-auto max-w-[220px]">
            <img src={qr} alt={t("base.receiveDialog.qrAlt")} className="w-full h-auto rounded-lg" />
          </div>
        ) : (
          <div className="flex items-center justify-center h-[220px]">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
          </div>
        )}

        <div className="p-3 rounded-xl bg-secondary/50 border border-border">
          <p className="text-xs text-muted-foreground mb-1">{t("base.receiveDialog.addressLabel", { chain: chain.name })}</p>
          <p className="font-mono text-sm text-primary break-all leading-relaxed select-all">{address}</p>
        </div>

        <div className="flex gap-2 p-3 rounded-xl border border-amber-500/40 bg-amber-500/10 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{chain.isMainnet ? t("base.receiveDialog.hint", { chain: chain.name }) : t("base.receiveDialog.testnetHint", { chain: chain.name })}</span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" className="gap-2" onClick={copy}>
            {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />} {t("base.copyAddress")}
          </Button>
          <Button variant="outline" className="gap-2" asChild>
            <a href={baseAddressUrl(chain, address)} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="w-4 h-4" /> BaseScan
            </a>
          </Button>
        </div>
      </div>
    </BaseModal>
  );
};

export default BaseReceiveDialog;
