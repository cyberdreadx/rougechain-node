/**
 * Explicit approval for a transaction / signature requested through the local RougeChain Base
 * provider (apps/web's BaseApprovalDialog). Nothing is signed until the user presses Approve.
 */
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatUnits } from "viem";
import { Button, Dialog } from "@rougechain/ui";
import { formatUsd } from "@rougechain/core/price-service";
import { formatBaseUnits, type BaseChainInfo } from "@rougechain/core/base-wallet";
import type { LocalBaseRequest } from "@rougechain/core/base-local-provider";

const ACTIONS: Record<string, "approve" | "transfer" | "deposit"> = {
  "0x095ea7b3": "approve",
  "0xa9059cbb": "transfer",
  "0xf1215d25": "deposit",
  "0x9b1c48e6": "deposit",
  "0x5a67cb87": "deposit",
};

export function ApprovalDialog({
  chain,
  request,
  ethPriceUsd,
  onResolve,
}: {
  chain: BaseChainInfo;
  request: LocalBaseRequest;
  ethPriceUsd: number | null;
  onResolve: (approved: boolean) => void;
}) {
  const { t } = useTranslation("bridge");
  const ethUsd = (wei: bigint) => (chain.isMainnet && ethPriceUsd != null ? formatUsd(Number(formatUnits(wei, 18)) * ethPriceUsd) : null);
  let body;
  if (request.kind === "sign") {
    body = (
      <div className="wallet-form">
        <p className="form-hint">{t("approve.message")}</p>
        <pre className="bridge-sign-message mono">{request.message}</pre>
      </div>
    );
  } else {
    const action = request.data === "0x" ? "eth" : (ACTIONS[request.data.slice(0, 10).toLowerCase()] ?? "call");
    const valueUsd = request.value > 0n ? ethUsd(request.value) : null;
    const feeUsd = ethUsd(request.fee.totalFeeWei);
    body = (
      <dl className="review-list">
        <div>
          <dt>{t("approve.action")}</dt>
          <dd>{t(`approve.actions.${action}`)}</dd>
        </div>
        <div>
          <dt>{t("approve.to")}</dt>
          <dd className="mono">{request.to}</dd>
        </div>
        <div>
          <dt>{t("approve.value")}</dt>
          <dd className="mono">
            {formatBaseUnits(request.value, 18, 8)} ETH
            {valueUsd && <span className="bridge-sub">≈ {valueUsd}</span>}
          </dd>
        </div>
        <div>
          <dt>{t("approve.fee")}</dt>
          <dd className="mono">
            ~{formatBaseUnits(request.fee.totalFeeWei, 18, 8)} ETH
            {feeUsd && <span className="bridge-sub">≈ {feeUsd}</span>}
          </dd>
        </div>
      </dl>
    );
  }
  return (
    <Dialog open onClose={() => onResolve(false)} title={request.kind === "sign" ? t("approve.signTitle") : t("approve.txTitle", { chain: chain.name })}>
      <div className="wallet-form">
        {body}
        <p className={`bridge-callout ${chain.isMainnet ? "warning" : ""}`}>
          <AlertTriangle size={15} aria-hidden="true" />
          <span>{chain.isMainnet ? t("approve.mainnetWarning") : t("approve.testnetWarning")}</span>
        </p>
        <p className="form-hint bridge-inline-icon">
          <ShieldCheck size={14} aria-hidden="true" />
          {t("approve.localSign")}
        </p>
        <div className="actions">
          <Button variant="outline" onClick={() => onResolve(false)}>
            {t("approve.reject")}
          </Button>
          <Button onClick={() => onResolve(true)}>{t("approve.approve")}</Button>
        </div>
      </div>
    </Dialog>
  );
}
