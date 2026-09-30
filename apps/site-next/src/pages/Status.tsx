import { useQuery } from "@tanstack/react-query";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Button, Status as StatusDot } from "@rougechain/ui";
import { getCoreApiBaseUrl, getCoreApiHeaders } from "@rougechain/core/network";
import { useChain } from "../explorer/chain";
import { PageFrame, short, StatTile, useRouteSeo } from "./common";
import { useTranslation } from "react-i18next";
import { fmtInt, fmtTime } from "../i18n/format";

type Stats = {
  network_height: number;
  finalized_height: number;
  connected_peers: number;
  state_root: string;
  base_fee: number;
  total_fees_burned: number;
  chain_id: string;
  designated_proposer_next?: string;
};
type NodeValidator = { publicKey: string; stake: number; status?: string; jailedUntil?: number; name?: string };
export type Releases = {
  updated: string;
  node: { version: string; tag: string; binarySha256: string; sourceCommit: string; mandatory: boolean; notes: string };
  consensus: { name: string; activationHeight: number | null; state: string }[];
  bridge: { name: string; state: string; auth: string; address: string | null }[];
  audits: { external: string; internal: string; reportSecurity: string };
};

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Same reads as apps/web's Status page: /stats, /validators, /peers (+ /status/releases.json). */
async function loadStatus() {
  const api = getCoreApiBaseUrl();
  const init = { headers: getCoreApiHeaders(), signal: AbortSignal.timeout(10_000) };
  const [stats, v, p] = await Promise.all([
    getJson<Stats>(`${api}/stats`, init),
    getJson<{ validators?: NodeValidator[] }>(`${api}/validators`, init),
    getJson<{ peers?: unknown[] }>(`${api}/peers`, init).catch(() => ({ peers: [] })),
  ]);
  return { stats, validators: v.validators ?? [], peers: (p.peers ?? []).length };
}

const stateClass = (s: string) => (s === "live" ? "live" : s.startsWith("built") ? "warning" : "loading");
const isActive = (v: NodeValidator, height: number) => v.stake > 0 && (!v.jailedUntil || v.jailedUntil <= height);

export default function StatusPage() {
  const { t } = useTranslation("pages");
  useRouteSeo({ title: t("seo.status.title"), description: t("seo.status.description") });
  const { network } = useChain();
  const q = useQuery({
    queryKey: ["pages", "status", network],
    queryFn: loadStatus,
    refetchInterval: 15_000,
    retry: 1,
  });
  const releases = useQuery({
    queryKey: ["pages", "releases"],
    queryFn: () => getJson<Releases>("/status/releases.json"),
    staleTime: 300_000,
    retry: 1,
  });
  const s = q.data?.stats;
  const validators = q.data?.validators ?? [];
  const active = s ? validators.filter((v) => isActive(v, s.network_height)) : [];
  const totalStake = validators.reduce((a, v) => a + (v.stake || 0), 0);
  const lag = s ? s.network_height - s.finalized_height : 0;
  const r = releases.data;
  const networkLabel = t(network === "mainnet" ? "common.mainnet" : "common.testnet");
  const networkLower = t(network === "mainnet" ? "common.mainnetLower" : "common.testnetLower");

  const tiles: [string, string][] = [
    [t("status.height"), s ? fmtInt(s.network_height) : "—"],
    [t("status.finalized"), s ? `${fmtInt(s.finalized_height)}${lag ? ` (−${fmtInt(lag)})` : ""}` : "—"],
    [t("status.validators"), s ? `${fmtInt(active.length)} / ${fmtInt(validators.length)}` : "—"],
    [t("status.peers"), s ? fmtInt(Math.max(s.connected_peers ?? 0, q.data?.peers ?? 0)) : "—"],
    // XRGE amounts keep exact en-US formatting (token amounts are not localised).
    [t("status.totalStake"), s ? `${totalStake.toLocaleString("en-US")} XRGE` : "—"],
    [t("status.baseFee"), s ? `${s.base_fee} XRGE` : "—"],
    [t("status.burned"), s ? `${Number(s.total_fees_burned ?? 0).toFixed(4)} XRGE` : "—"],
    [t("status.chainId"), s?.chain_id ?? "—"],
  ];

  return (
    <PageFrame
      eyebrow={t("status.eyebrow")}
      title={t("status.title")}
      lead={t("status.lead", { network: networkLower })}
    >
      <div className="data-note" role="status">
        <StatusDot state={q.isError ? (s ? "stale" : "unavailable") : s ? "live" : "loading"}>
          {q.isError ? t("status.apiError") : s ? networkLabel : t("common.loading")}
        </StatusDot>
        <span>
          {q.dataUpdatedAt ? fmtTime(q.dataUpdatedAt, { timeStyle: "medium" }) : "…"} · {t("status.autoRefresh")}
          {q.isError && q.error ? ` · ${String((q.error as Error).message)}` : ""}
        </span>
        <Button variant="ghost icon" aria-label={t("common.refresh")} disabled={q.isFetching} onClick={() => void q.refetch()}>
          <RefreshCw size={14} className={q.isFetching ? "spin" : ""} />
        </Button>
      </div>

      <div className="rc-stats four">
        {tiles.map(([k, v]) => (
          <StatTile key={k} label={k} value={<span className="mono rc-break">{v}</span>} />
        ))}
      </div>

      {network !== "mainnet" && <p className="notice">{t("status.factsMainnet")}</p>}

      <section className="surface rc-panel" aria-labelledby="consensus">
        <h2 id="consensus">{t("status.consensusTitle")}</h2>
        <dl className="review-list">
          <div>
            <dt>{t("status.stateRoot")}</dt>
            <dd className="mono">{short(s?.state_root, 16)}</dd>
          </div>
          <div>
            <dt>{t("status.designatedProposer")}</dt>
            <dd className="mono">{short(s?.designated_proposer_next, 16)}</dd>
          </div>
        </dl>
        {r ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("status.rule")}</th>
                  <th>{t("status.activation")}</th>
                  <th>{t("status.state")}</th>
                </tr>
              </thead>
              <tbody>
                {r.consensus.map((c) => (
                  <tr key={c.name}>
                    <td>{c.name}</td>
                    <td className="mono">{c.activationHeight ?? "—"}</td>
                    <td>
                      <span className={`status ${stateClass(c.state)}`}>{c.state}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : releases.isError ? (
          <p className="form-hint">{t("status.factsUnavailable")}</p>
        ) : null}
      </section>

      <div className="rc-grid even">
        <section className="surface rc-panel" aria-labelledby="vals">
          <h2 id="vals">{t("status.validatorsTitle")}</h2>
          {validators.length === 0 ? (
            <p className="muted">{s ? t("status.noValidators") : t("common.loading")}</p>
          ) : (
            <ul className="rc-rows">
              {validators.map((v) => {
                const on = s ? isActive(v, s.network_height) : v.stake > 0;
                return (
                  <li key={v.publicKey}>
                    <span className="mono">
                      {short(v.publicKey, 10)}
                      {v.name ? ` · ${v.name}` : ""}
                    </span>
                    <span className="mono">{v.stake.toLocaleString("en-US")} XRGE</span>
                    <span className={`status ${on ? "live" : "warning"}`}>{on ? t("status.active") : t("status.inactive")}</span>
                  </li>
                );
              })}
            </ul>
          )}
          {r && (
            <p className="form-hint">
              {t("status.nodeRelease")}:{" "}
              <a className="text-link inline" href={r.node.tag} target="_blank" rel="noopener noreferrer">
                {r.node.version} <ExternalLink size={11} />
              </a>
              {r.node.mandatory && <span className="rc-warn"> ({t("status.mandatory")})</span>}
              <br />
              <span className="mono rc-break">sha256 {r.node.binarySha256}</span>
            </p>
          )}
        </section>
        <section className="surface rc-panel" aria-labelledby="bridges">
          <h2 id="bridges">{t("status.bridgeTitle")}</h2>
          {r ? (
            <ul className="rc-rows stacked">
              {r.bridge.map((b) => (
                <li key={b.name}>
                  <span className="field-row">
                    <span>{b.name}</span>
                    <span className={`status ${stateClass(b.state)}`}>{b.state}</span>
                  </span>
                  <small className="muted">
                    {b.auth}
                    {b.address ? <span className="mono"> · {short(b.address, 10)}</span> : null}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{releases.isError ? t("status.factsUnavailable") : t("common.loading")}</p>
          )}
          {r && (
            <p className="form-hint">
              {t("status.audits")}: {r.audits.external} · {r.audits.internal}
            </p>
          )}
        </section>
      </div>

      <p className="form-hint">
        {t("status.footer")}{" "}
        <a className="text-link inline" href="https://docs.rougechain.io/status.html" target="_blank" rel="noopener noreferrer">
          docs.rougechain.io/status
        </a>
        {r && (
          <>
            {" "}
            · {t("status.updated")} {r.updated}
          </>
        )}
      </p>
    </PageFrame>
  );
}
