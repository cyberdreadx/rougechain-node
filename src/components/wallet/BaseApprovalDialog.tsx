import { AlertTriangle, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatUnits } from "viem";
import { Button } from "@/components/ui/button";
import { formatUsd } from "@/lib/price-service";
import { formatBaseUnits, type BaseChainInfo } from "@/lib/base-wallet";
import type { LocalBaseRequest } from "@/lib/base-local-provider";
import { BaseModal } from "./BaseReceiveDialog";

const ACTIONS: Record<string, "approve" | "transfer" | "deposit"> = {
  "0x095ea7b3": "approve",
  "0xa9059cbb": "transfer",
  "0xf1215d25": "deposit",
};

/**
 * Explicit approval for a transaction / signature requested through the local
 * RougeChain Base provider (e.g. by the Bridge page). Nothing is signed until the
 * user presses Approve.
 */
const BaseApprovalDialog = ({ chain, request, ethPriceUsd, onResolve }: {
  chain: BaseChainInfo;
  request: LocalBaseRequest;
  ethPriceUsd: number | null;
  onResolve: (approved: boolean) => void;
}) => {
  const { t } = useTranslation();
  const ethUsd = (wei: bigint) => (chain.isMainnet && ethPriceUsd != null ? formatUsd(Number(formatUnits(wei, 18)) * ethPriceUsd) : null);

  const warning = (
    <div className="flex gap-2 p-3 rounded-xl border border-amber-500/40 bg-amber-500/10 text-xs text-amber-600 dark:text-amber-400">
      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
      <span>{chain.isMainnet ? t("base.sendDialog.mainnetWarning") : t("base.sendDialog.testnetWarning")}</span>
    </div>
  );

  let body;
  if (request.kind === "sign") {
    body = (
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">{t("base.approve.message")}</p>
        <pre className="text-xs font-mono whitespace-pre-wrap break-all p-3 rounded-xl bg-secondary/50 border border-border max-h-48 overflow-y-auto">{request.message}</pre>
      </div>
    );
  } else {
    const action = request.data === "0x" ? "eth" : ACTIONS[request.data.slice(0, 10).toLowerCase()] ?? "call";
    const valueUsd = request.value > 0n ? ethUsd(request.value) : null;
    const feeUsd = ethUsd(request.fee.totalFeeWei);
    body = (
      <dl className="rounded-xl border border-border divide-y divide-border/60 text-xs">
        <div className="flex justify-between gap-3 p-3">
          <dt className="text-muted-foreground shrink-0">{t("base.approve.action")}</dt>
          <dd className="text-foreground text-right">{t(`base.approve.actions.${action}`)}</dd>
        </div>
        <div className="flex justify-between gap-3 p-3">
          <dt className="text-muted-foreground shrink-0">{t("base.approve.to")}</dt>
          <dd className="font-mono text-foreground break-all text-right">{request.to}</dd>
        </div>
        <div className="flex justify-between gap-3 p-3">
          <dt className="text-muted-foreground shrink-0">{t("base.approve.value")}</dt>
          <dd className="font-mono text-foreground text-right">
            {formatBaseUnits(request.value, 18, 8)} ETH
            {valueUsd && <span className="block text-muted-foreground">≈ {valueUsd}</span>}
          </dd>
        </div>
        <div className="flex justify-between gap-3 p-3">
          <dt className="text-muted-foreground shrink-0">{t("base.approve.fee")}</dt>
          <dd className="font-mono text-foreground text-right">
            ~{formatBaseUnits(request.fee.totalFeeWei, 18, 8)} ETH
            {feeUsd && <span className="block text-muted-foreground">≈ {feeUsd}</span>}
          </dd>
        </div>
      </dl>
    );
  }

  return (
    <BaseModal
      title={request.kind === "sign" ? t("base.approve.signTitle") : t("base.approve.txTitle", { chain: chain.name })}
      onClose={() => onResolve(false)}
    >
      <div className="space-y-4">
        {body}
        {warning}
        <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-0.5 text-primary" />
          {t("base.sendDialog.localSign")}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" onClick={() => onResolve(false)}>{t("base.approve.reject")}</Button>
          <Button onClick={() => onResolve(true)}>{t("base.approve.approve")}</Button>
        </div>
      </div>
    </BaseModal>
  );
};

export default BaseApprovalDialog;
