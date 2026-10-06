/** Deposits sent from Base and not yet credited (see inflight.ts). Lives outside the Deposit / Withdraw tabs. */
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@rougechain/ui";
import { getBridgeHistory } from "@rougechain/core/bridge";
import { CopyText } from "../wallet/parts";
import { dismissInflight, INFLIGHT_SLOW_MS, inflightVersion, listInflight, markCredited, matchCredits, subscribeInflight } from "./inflight";

/** Test hook: how often the wallet's bridge history is re-read while a deposit is waiting. */
export const inflightTiming = { pollMs: 8_000, slowPollMs: 60_000, tickMs: 15_000 };

export function InflightDeposits({ pubkey, network, onCredited }: { pubkey: string; network: string; onCredited?: () => void }) {
  const { t } = useTranslation("bridge");
  const version = useSyncExternalStore(subscribeInflight, inflightVersion);
  const [now, setNow] = useState(() => Date.now());
  const mine = listInflight(network, now).filter((r) => r.recipientPubkey === pubkey);
  const shown = mine.filter((r) => !r.dismissed);
  const waiting = shown.filter((r) => r.state === "sent");
  const isSlow = (startedAt: number) => now - startedAt > INFLIGHT_SLOW_MS;
  const anyWaiting = waiting.length > 0;

  // The credit shows up in the wallet's own history (core getBridgeHistory); no Base RPC is needed.
  const q = useQuery({
    queryKey: ["bridge", "inflight", network, pubkey],
    queryFn: () => getBridgeHistory(pubkey),
    enabled: anyWaiting,
    refetchInterval: !anyWaiting ? false : waiting.every((r) => isSlow(r.startedAt)) ? inflightTiming.slowPollMs : inflightTiming.pollMs,
    retry: false,
  });

  useEffect(() => {
    if (!q.data || !anyWaiting) return;
    const hits = matchCredits(mine, q.data);
    for (const h of hits) markCredited(network, h.baseTxHash, h.creditTxId);
    if (hits.length > 0) onCredited?.();
    // `mine` is re-read from the store every render; `version` stands in for it.
  }, [q.data, version, anyWaiting, network]);

  useEffect(() => {
    if (!anyWaiting) return;
    const id = window.setInterval(() => setNow(Date.now()), inflightTiming.tickMs);
    return () => window.clearInterval(id);
  }, [anyWaiting]);

  if (shown.length === 0) return null;
  return (
    <section className="surface bridge-card bridge-inflight" aria-labelledby="bridge-inflight-title">
      <h2 id="bridge-inflight-title" className="bridge-card-title">
        {t("inflight.title")}
      </h2>
      <ul className="bridge-rows">
        {shown.map((r) => {
          const slow = r.state === "sent" && isSlow(r.startedAt);
          return (
            <li key={r.baseTxHash}>
              <div className="bridge-row-main">
                <span className="mono">
                  {r.amountLabel} {r.asset}
                </span>
                {r.state === "credited" ? (
                  <span className="bridge-sub bridge-in">{t("inflight.credited", { amount: r.amountLabel, symbol: r.l1Symbol })}</span>
                ) : slow ? (
                  <>
                    <span className="bridge-sub warning">{t("inflight.slow")}</span>
                    <span className="bridge-sub">{t("inflight.slowHelp")}</span>
                    <CopyText value={r.baseTxHash} label={t("inflight.txLabel")} />
                  </>
                ) : (
                  <span className="bridge-sub" role="status">
                    <span className="spin-dot" aria-hidden="true" /> {t("inflight.waiting")}
                  </span>
                )}
              </div>
              {(r.state === "credited" || slow) && (
                <Button variant="outline small" type="button" onClick={() => dismissInflight(network, r.baseTxHash)}>
                  {t("inflight.dismiss")}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {anyWaiting && <p className="form-hint">{t("inflight.leaveHint")}</p>}
    </section>
  );
}
