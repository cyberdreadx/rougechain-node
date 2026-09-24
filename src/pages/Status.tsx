import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Activity, Shield, Link2, Flame, Server, ExternalLink, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCoreApiBaseUrl } from "@/lib/network";

type Stats = { network_height: number; finalized_height: number; connected_peers: number; state_root: string; base_fee: number; total_fees_burned: number; chain_id: string; node_name?: string; designated_proposer_next?: string; proposer_selection_activation_height?: number | null };
type Validator = { publicKey: string; stake: number; status: string; jailedUntil: number; blocksProposed: number; name?: string };
type Releases = { updated: string; node: { version: string; tag: string; binarySha256: string; sourceCommit: string; mandatory: boolean; notes: string }; consensus: { name: string; activationHeight: number | null; state: string }[]; bridge: { name: string; state: string; auth: string; address: string | null }[]; audits: { external: string; internal: string; reportSecurity: string } };

const short = (s?: string, n = 12) => (s ? `${s.slice(0, n)}…` : "—");
const stateClass = (s: string) => (s === "live" ? "text-emerald-400" : s.startsWith("built") ? "text-amber-400" : "text-muted-foreground");

export default function Status() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<Stats | null>(null);
  const [validators, setValidators] = useState<Validator[]>([]);
  const [peers, setPeers] = useState<number>(0);
  const [releases, setReleases] = useState<Releases | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const load = async () => {
    try {
      const api = getCoreApiBaseUrl();
      const [s, v, p] = await Promise.all([fetch(`${api}/stats`).then(r => r.json()), fetch(`${api}/validators`).then(r => r.json()), fetch(`${api}/peers`).then(r => r.json()).catch(() => ({ peers: [] }))]);
      setStats(s); setValidators(v.validators ?? []); setPeers((p.peers ?? []).length); setError(null); setUpdatedAt(new Date());
    } catch (e) { setError(String(e)); }
  };
  useEffect(() => { load(); const id = setInterval(load, 15000); fetch("/status/releases.json").then(r => r.json()).then(setReleases).catch(() => null); return () => clearInterval(id); }, []);

  const totalStake = validators.reduce((a, v) => a + (v.stake || 0), 0);
  const active = validators.filter(v => v.stake > 0 && (!v.jailedUntil || (stats && v.jailedUntil <= stats.network_height)));
  const finalityLag = stats ? stats.network_height - stats.finalized_height : null;

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><Activity className="w-6 h-6 text-primary" /> {t("status.title")}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t("status.subtitle")}</p>
        </div>
        <div className="text-xs text-muted-foreground flex items-center gap-2">
          <RefreshCw className="w-3.5 h-3.5" /> {updatedAt ? updatedAt.toLocaleTimeString() : "…"} · {t("status.autoRefresh")}
        </div>
      </div>
      {error && <p className="text-sm text-red-400">{t("status.apiError")}: {error}</p>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          [t("status.height"), stats?.network_height ?? "—"],
          [t("status.finalized"), stats ? `${stats.finalized_height}${finalityLag ? ` (−${finalityLag})` : ""}` : "—"],
          [t("status.validators"), stats ? `${active.length} / ${validators.length}` : "—"],
          [t("status.peers"), stats ? Math.max(stats.connected_peers ?? 0, peers) : "—"],
          [t("status.totalStake"), stats ? `${totalStake.toLocaleString()} XRGE` : "—"],
          [t("status.baseFee"), stats ? `${stats.base_fee} XRGE` : "—"],
          [t("status.burned"), stats ? `${stats.total_fees_burned.toFixed(4)} XRGE` : "—"],
          [t("status.chainId"), stats?.chain_id ?? "—"],
        ].map(([k, v]) => (
          <Card key={String(k)}><CardContent className="p-4"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">{k}</div><div className="text-lg font-mono mt-1 break-all">{String(v)}</div></CardContent></Card>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Shield className="w-4 h-4 text-primary" /> {t("status.consensusTitle")}</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-2">
          <div className="grid md:grid-cols-2 gap-2">
            <div><span className="text-muted-foreground">{t("status.stateRoot")}:</span> <span className="font-mono">{short(stats?.state_root, 16)}</span></div>
            <div><span className="text-muted-foreground">{t("status.designatedProposer")}:</span> <span className="font-mono">{short(stats?.designated_proposer_next, 16)}</span></div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs mt-2">
              <thead><tr className="text-muted-foreground text-left"><th className="py-1 pr-3">{t("status.rule")}</th><th className="py-1 pr-3">{t("status.activation")}</th><th className="py-1">{t("status.state")}</th></tr></thead>
              <tbody>{releases?.consensus.map(c => (<tr key={c.name} className="border-t border-border/50"><td className="py-1 pr-3">{c.name}</td><td className="py-1 pr-3 font-mono">{c.activationHeight ?? "—"}</td><td className={`py-1 ${stateClass(c.state)}`}>{c.state}</td></tr>))}</tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Server className="w-4 h-4 text-primary" /> {t("status.validatorsTitle")}</CardTitle></CardHeader>
          <CardContent className="text-xs space-y-1">
            {validators.map(v => (
              <div key={v.publicKey} className="flex items-center justify-between gap-2 border-t border-border/40 py-1 first:border-t-0">
                <span className="font-mono">{short(v.publicKey, 10)}{v.name ? ` · ${v.name}` : ""}</span>
                <span>{v.stake.toLocaleString()} XRGE</span>
                <span className={v.stake > 0 && (!stats || v.jailedUntil <= stats.network_height) ? "text-emerald-400" : "text-amber-400"}>{v.stake > 0 && (!stats || v.jailedUntil <= stats.network_height) ? t("status.active") : t("status.inactive")}</span>
              </div>
            ))}
            {releases && (
              <div className="pt-3 text-muted-foreground">
                {t("status.nodeRelease")}: <a className="text-primary hover:underline" href={releases.node.tag} target="_blank" rel="noopener noreferrer">{releases.node.version} <ExternalLink className="inline w-3 h-3" /></a>
                {releases.node.mandatory && <span className="ml-1 text-amber-400">({t("status.mandatory")})</span>}
                <div className="font-mono break-all mt-1">sha256 {releases.node.binarySha256}</div>
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Link2 className="w-4 h-4 text-primary" /> {t("status.bridgeTitle")}</CardTitle></CardHeader>
          <CardContent className="text-xs space-y-2">
            {releases?.bridge.map(b => (
              <div key={b.name} className="border-t border-border/40 pt-2 first:border-t-0 first:pt-0">
                <div className="flex justify-between gap-2"><span>{b.name}</span><span className={stateClass(b.state)}>{b.state}</span></div>
                <div className="text-muted-foreground">{b.auth}{b.address ? <span className="font-mono"> · {short(b.address, 10)}</span> : null}</div>
              </div>
            ))}
            {releases && (
              <div className="pt-2 text-muted-foreground flex items-start gap-2"><Flame className="w-3.5 h-3.5 mt-0.5 text-amber-400" /><span>{t("status.audits")}: {releases.audits.external} · {releases.audits.internal}</span></div>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground">
        {t("status.footer")} <a className="text-primary hover:underline" href="https://docs.rougechain.io/status.html" target="_blank" rel="noopener noreferrer">docs.rougechain.io/status</a>
        {releases && <> · {t("status.updated")} {releases.updated}</>}
      </p>
    </div>
  );
}
