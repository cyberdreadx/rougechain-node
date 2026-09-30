import { useQuery } from "@tanstack/react-query";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Button, Status as StatusDot } from "@rougechain/ui";
import { getCoreApiBaseUrl, getCoreApiHeaders } from "@rougechain/core/network";
import { useChain } from "../explorer/chain";
import { PageFrame, short, StatTile, useRouteSeo } from "./common";
import { common, seo, status as t } from "./strings";

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
  useRouteSeo(seo.status);
  const { network, config } = useChain();
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

  const tiles: [string, string][] = [
    [t.height, s ? s.network_height.toLocaleString("en-US") : "—"],
    [t.finalized, s ? `${s.finalized_height.toLocaleString("en-US")}${lag ? ` (−${lag})` : ""}` : "—"],
    [t.validators, s ? `${active.length} / ${validators.length}` : "—"],
    [t.peers, s ? String(Math.max(s.connected_peers ?? 0, q.data?.peers ?? 0)) : "—"],
    [t.totalStake, s ? `${totalStake.toLocaleString("en-US")} XRGE` : "—"],
    [t.baseFee, s ? `${s.base_fee} XRGE` : "—"],
    [t.burned, s ? `${Number(s.total_fees_burned ?? 0).toFixed(4)} XRGE` : "—"],
    [t.chainId, s?.chain_id ?? "—"],
  ];

  return (
    <PageFrame
      eyebrow={t.eyebrow}
      title={t.title}
      lead={t.lead(config.label.toLowerCase())}
    >
      <div className="data-note" role="status">
        <StatusDot state={q.isError ? (s ? "stale" : "unavailable") : s ? "live" : "loading"}>
          {q.isError ? t.apiError : s ? config.label : common.loading}
        </StatusDot>
        <span>
          {q.dataUpdatedAt ? new Date(q.dataUpdatedAt).toLocaleTimeString() : "…"} · {t.autoRefresh}
          {q.isError && q.error ? ` · ${String((q.error as Error).message)}` : ""}
        </span>
        <Button variant="ghost icon" aria-label="Refresh" disabled={q.isFetching} onClick={() => void q.refetch()}>
          <RefreshCw size={14} className={q.isFetching ? "spin" : ""} />
        </Button>
      </div>

      <div className="rc-stats four">
        {tiles.map(([k, v]) => (
          <StatTile key={k} label={k} value={<span className="mono rc-break">{v}</span>} />
        ))}
      </div>

      {network !== "mainnet" && <p className="notice">{t.factsMainnet}</p>}

      <section className="surface rc-panel" aria-labelledby="consensus">
        <h2 id="consensus">{t.consensusTitle}</h2>
        <dl className="review-list">
          <div>
            <dt>{t.stateRoot}</dt>
            <dd className="mono">{short(s?.state_root, 16)}</dd>
          </div>
          <div>
            <dt>{t.designatedProposer}</dt>
            <dd className="mono">{short(s?.designated_proposer_next, 16)}</dd>
          </div>
        </dl>
        {r ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t.rule}</th>
                  <th>{t.activation}</th>
                  <th>{t.state}</th>
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
          <p className="form-hint">{t.factsUnavailable}</p>
        ) : null}
      </section>

      <div className="rc-grid even">
        <section className="surface rc-panel" aria-labelledby="vals">
          <h2 id="vals">{t.validatorsTitle}</h2>
          {validators.length === 0 ? (
            <p className="muted">{s ? t.noValidators : common.loading}</p>
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
                    <span className={`status ${on ? "live" : "warning"}`}>{on ? t.active : t.inactive}</span>
                  </li>
                );
              })}
            </ul>
          )}
          {r && (
            <p className="form-hint">
              {t.nodeRelease}:{" "}
              <a className="text-link inline" href={r.node.tag} target="_blank" rel="noopener noreferrer">
                {r.node.version} <ExternalLink size={11} />
              </a>
              {r.node.mandatory && <span className="rc-warn"> ({t.mandatory})</span>}
              <br />
              <span className="mono rc-break">sha256 {r.node.binarySha256}</span>
            </p>
          )}
        </section>
        <section className="surface rc-panel" aria-labelledby="bridges">
          <h2 id="bridges">{t.bridgeTitle}</h2>
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
            <p className="muted">{releases.isError ? t.factsUnavailable : common.loading}</p>
          )}
          {r && (
            <p className="form-hint">
              {t.audits}: {r.audits.external} · {r.audits.internal}
            </p>
          )}
        </section>
      </div>

      <p className="form-hint">
        {t.footer}{" "}
        <a className="text-link inline" href="https://docs.rougechain.io/status.html" target="_blank" rel="noopener noreferrer">
          docs.rougechain.io/status
        </a>
        {r && (
          <>
            {" "}
            · {t.updated} {r.updated}
          </>
        )}
      </p>
    </PageFrame>
  );
}
