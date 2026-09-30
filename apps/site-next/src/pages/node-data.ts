/**
 * Live node discovery for /node — the same read-only probes as apps/web's NodeDashboard:
 * the configured network API, local daemons on ports 5100–5104, then peers those nodes report.
 * GET /api/stats + /api/health per node, /api/peers for discovery, /api/validators for the count.
 */
import { useEffect, useRef, useState } from "react";
import { getCoreApiBaseUrl, getCoreApiHeaders } from "@rougechain/core/network";

export interface NodeStats {
  connected_peers: number;
  network_height: number;
  is_mining: boolean;
  node_id: string;
  total_fees_collected: number;
  fees_in_last_block: number;
  chain_id: string;
  finalized_height: number;
}
export interface NodeInfo {
  port: number | null;
  baseUrl: string;
  stats: NodeStats;
  health: { status: string; chain_id: string; height: number };
}

export const LOCAL_PORTS = [5100, 5101, 5102, 5103, 5104];

const num = (v: unknown) => Number(v ?? 0) || 0;
export function normalizeStats(d: Record<string, unknown>): NodeStats {
  return {
    connected_peers: num(d.connected_peers ?? d.connectedPeers),
    network_height: num(d.network_height ?? d.networkHeight),
    is_mining: Boolean(d.is_mining ?? d.isMining ?? false),
    node_id: String(d.node_id ?? d.nodeId ?? ""),
    total_fees_collected: num(d.total_fees_collected ?? d.totalFeesCollected),
    fees_in_last_block: num(d.fees_in_last_block ?? d.feesInLastBlock),
    chain_id: String(d.chain_id ?? d.chainId ?? ""),
    finalized_height: num(d.finalized_height ?? d.finalizedHeight),
  };
}

async function getJson(url: string, ms: number): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { headers: getCoreApiHeaders(), signal: AbortSignal.timeout(ms) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function probe(baseUrl: string): Promise<NodeInfo | null> {
  const [s, h] = await Promise.all([getJson(`${baseUrl}/api/stats`, 3000), getJson(`${baseUrl}/api/health`, 3000)]);
  if (!s || !h) return null;
  const m = baseUrl.match(/:(\d+)\b/);
  return {
    port: m ? Number(m[1]) : null,
    baseUrl,
    stats: normalizeStats(s),
    health: { status: String(h.status ?? "unknown"), chain_id: String(h.chain_id ?? h.chainId ?? ""), height: num(h.height) },
  };
}

/** One discovery pass. `includeLocal` = also probe 127.0.0.1:5100–5104 (apps/web always does). */
export async function scanNodes(includeLocal = true): Promise<{ nodes: NodeInfo[]; validatorCount: number }> {
  const configured = getCoreApiBaseUrl().replace(/\/api$/, "");
  const bases = [configured, ...(includeLocal ? LOCAL_PORTS.map((p) => `http://127.0.0.1:${p}`) : [])].filter(Boolean);
  const first = (await Promise.all(bases.map(probe))).filter((n): n is NodeInfo => n !== null);
  const peerUrls = new Set<string>();
  for (const n of first) {
    const p = await getJson(`${n.baseUrl}/api/peers`, 3000);
    const peers = Array.isArray(p?.peers) ? (p!.peers as unknown[]) : [];
    for (const u of peers) {
      if (typeof u !== "string" || !/^https?:\/\//.test(u)) continue;
      const norm = u.replace(/\/+$/, "").replace(/\/api$/, "");
      if (!bases.includes(norm)) peerUrls.add(norm);
    }
  }
  const more = (await Promise.all([...peerUrls].map(probe))).filter((n): n is NodeInfo => n !== null);
  const seen = new Set<string>();
  const nodes = [...first, ...more].filter((n) => {
    const id = n.stats.node_id || n.baseUrl;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const v = configured ? await getJson(`${configured}/api/validators`, 5000) : null;
  const validatorCount = Array.isArray(v?.validators) ? (v!.validators as unknown[]).length : 0;
  return { nodes, validatorCount };
}

const BACKOFF = [2000, 5000, 10000, 30000, 60000];

/** Polls scanNodes: every 60 s while nodes answer, backing off 2 s → 60 s while none do. */
export function useNodeScan(network: string) {
  const [state, setState] = useState<{ nodes: NodeInfo[]; validatorCount: number; checking: boolean }>({
    nodes: [],
    validatorCount: 0,
    checking: true,
  });
  const timer = useRef<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    let step = 0;
    const run = async () => {
      setState((s) => ({ ...s, checking: true }));
      const r = await scanNodes();
      if (cancelled) return;
      setState({ ...r, checking: false });
      if (r.nodes.length > 0) step = 0;
      else step = Math.min(step + 1, BACKOFF.length - 1);
      timer.current = window.setTimeout(run, r.nodes.length > 0 ? 60_000 : BACKOFF[step]);
    };
    void run();
    return () => {
      cancelled = true;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [network]);
  return state;
}
