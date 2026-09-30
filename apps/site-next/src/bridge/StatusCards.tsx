/** Bridge status for the connected wallet: in-flight withdrawals and recent bridge activity. */
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, ExternalLink } from "lucide-react";
import { EmptyState } from "@rougechain/ui";
import { getBridgeHistory, getMempoolTxUrl, getPendingWithdrawals, type PendingWithdrawal } from "@rougechain/core/bridge";
import { l1TokenDecimals } from "@rougechain/core/token-decimals";
import { formatUnits } from "./validate";
import { fmtRelative } from "../i18n/format";

/** Explorer detail page for a bridge transfer (the Explorer's /explorer/bridge/:txId). */
export function transferPath(txId: string): string {
  return `/explorer/bridge/${encodeURIComponent(txId)}`;
}

const HEX64 = /^(0x)?[0-9a-fA-F]{64}$/;

function short(s: string, head = 8, tail = 4): string {
  return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}

function statusStyle(status: PendingWithdrawal["status"]): { label: "retrying" | "refunded" | "released" | "pending"; tone: string } {
  switch (status) {
    case "failed":
      return { label: "retrying", tone: "warning" };
    case "refunded":
      return { label: "refunded", tone: "info" };
    case "fulfilled":
      return { label: "released", tone: "ok" };
    default:
      return { label: "pending", tone: "muted" };
  }
}

/** In-flight withdrawals owned by this key (GET /bridge/withdrawals + /bridge/xrge/withdrawals), polled every 15 s. */
export function PendingWithdrawalsCard({ pubkey, network, btcNetwork, refreshKey }: { pubkey: string; network: string; btcNetwork?: "mainnet" | "testnet"; refreshKey: number }) {
  const { t } = useTranslation("bridge");
  const q = useQuery({
    queryKey: ["bridge", "pending", network, pubkey, refreshKey],
    queryFn: () => getPendingWithdrawals(pubkey),
    refetchInterval: 15_000,
    retry: false,
  });
  const list = q.data ?? [];
  // Nothing pending: keep the page clean (as apps/web).
  if (q.data && list.length === 0) return null;
  return (
    <section className="surface bridge-card" aria-labelledby="bridge-pending-title">
      <h2 id="bridge-pending-title" className="bridge-card-title">
        {t("pending.title")}
      </h2>
      {!q.data ? (
        <p className="form-hint">{t("pending.loading")}</p>
      ) : (
        <ul className="bridge-rows">
          {list.map((w) => {
            const s = statusStyle(w.status);
            const amount = formatUnits(w.amount, l1TokenDecimals(w.tokenSymbol));
            return (
              <li key={w.txId}>
                <div className="bridge-row-main">
                  <Link className="bridge-row-link" to={transferPath(w.txId)}>
                    {amount} {w.tokenSymbol} → <span className="mono">{short(w.evmAddress)}</span>
                  </Link>
                  {w.status === "failed" && (
                    <span className="bridge-sub warning">
                      {t("pending.failedAttempts", { count: w.attempts })}
                      {w.lastError ? ` — ${w.lastError}` : ""}
                    </span>
                  )}
                  {w.tokenSymbol === "qBTC" && w.status === "fulfilled" && w.payoutTxid && (
                    <a className="inline-link" href={getMempoolTxUrl(w.payoutTxid, btcNetwork)} target="_blank" rel="noopener noreferrer">
                      {t("pending.viewOnMempool")} <ExternalLink size={11} aria-hidden="true" />
                    </a>
                  )}
                </div>
                <span className={`pill tone-${s.tone}`}>{t(`pending.status.${s.label}`)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Recent bridge transactions of this key (core getBridgeHistory → GET /address/:pubkey/transactions). */
export function ActivityCard({ pubkey, network, refreshKey }: { pubkey: string; network: string; refreshKey: number }) {
  const { t } = useTranslation("bridge");
  const q = useQuery({
    queryKey: ["bridge", "history", network, pubkey, refreshKey],
    queryFn: () => getBridgeHistory(pubkey),
    retry: false,
  });
  const list = q.data ?? [];
  return (
    <section className="surface bridge-card" aria-labelledby="bridge-activity-title">
      <div className="bridge-card-head">
        <h2 id="bridge-activity-title" className="bridge-card-title">
          {t("activity.title")}
        </h2>
        <Link className="inline-link" to="/explorer/bridge">
          {t("activity.all")}
        </Link>
      </div>
      {!q.data ? (
        <p className="form-hint">{t("activity.loading")}</p>
      ) : list.length === 0 ? (
        <EmptyState title={t("activity.empty")}>{t("activity.emptyHint")}</EmptyState>
      ) : (
        <ul className="bridge-rows">
          {list.map((e) => {
            const txId = e.txHash && HEX64.test(e.txHash) ? e.txHash : HEX64.test(e.id) ? e.id : null;
            const inbound = e.direction === "deposit";
            const label = (
              <>
                {inbound ? <ArrowDownLeft size={15} aria-hidden="true" /> : <ArrowUpRight size={15} aria-hidden="true" />}
                {inbound ? t("activity.bridgedIn") : t("activity.bridgedOut")}
              </>
            );
            return (
              <li key={e.id}>
                <div className="bridge-row-main">
                  {txId ? (
                    <Link className="bridge-row-link bridge-inline-icon" to={transferPath(txId)}>
                      {label}
                    </Link>
                  ) : (
                    <span className="bridge-inline-icon">{label}</span>
                  )}
                  {e.timestamp > 0 ? <span className="bridge-sub">{fmtRelative(e.timestamp)}</span> : e.timeLabel && <span className="bridge-sub">{e.timeLabel}</span>}
                </div>
                <div className="bridge-row-end">
                  <span className={`mono ${inbound ? "bridge-in" : "bridge-out"}`}>
                    {inbound ? "+" : "−"}
                    {e.amount} {e.symbol}
                  </span>
                  <span className="bridge-sub">{e.status === "pending" ? t("activity.statusPending") : t("activity.statusCompleted")}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
