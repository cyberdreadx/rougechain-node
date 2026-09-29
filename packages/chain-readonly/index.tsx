import snapshot from "./snapshot.json";
import { readOnlyGet } from "./client";
import { networkConfig, type NetworkId } from "./network";
import { ChainMismatchError, obj, text, uint } from "./normalize";

export * from "./network";
export * from "./allowlist";
export * from "./client";
export * from "./normalize";
export * from "./format";

/** Mainnet API base (kept for the POC surfaces; use networkConfig(id).apiBase instead). */
export const API_BASE = networkConfig("mainnet").apiBase;
/** The three reads behind the network summary (stats, validators, recent blocks). */
export const ENDPOINTS = ["/stats", "/validators", "/blocks?limit=8"] as const;
export type Endpoint = (typeof ENDPOINTS)[number];
export type Block = {
  height: number;
  hash: string;
  transactions: number;
  timestamp: number;
};
export type Network = {
  height: number;
  peers: number;
  validators: number;
  chainId: string;
  capturedAt: string;
  blocks: Block[];
};
/** A saved MAINNET capture. Only ever shown labelled as a snapshot, never as live data. */
export const demoSnapshot: Network = snapshot;

export function normalizeNetwork(
  stats: unknown,
  validators: unknown,
  blocks: unknown,
  expectedChainId: string = networkConfig("mainnet").chainId,
): Network {
  const s = obj(stats),
    v = obj(validators),
    b = obj(blocks);
  if (
    v.success !== true ||
    !Array.isArray(v.validators) ||
    !Array.isArray(b.blocks)
  )
    throw new Error("Unexpected network response");
  if (s.chain_id !== expectedChainId)
    throw new ChainMismatchError(expectedChainId, s.chain_id);
  return {
    height: uint(s.network_height),
    peers: uint(s.connected_peers),
    validators: v.validators.length,
    chainId: text(s.chain_id),
    capturedAt: new Date().toISOString(),
    blocks: b.blocks
      .map((raw) => {
        const block = obj(raw),
          header = obj(block.header);
        if (!Array.isArray(block.txs) || header.chain_id !== s.chain_id)
          throw new Error("Unexpected block");
        return {
          height: uint(header.height),
          hash: text(block.hash),
          transactions: block.txs.length,
          timestamp: uint(header.time),
        };
      })
      .sort((a, b) => b.height - a.height)
      .slice(0, 8),
  };
}

export async function getNetwork(
  network: NetworkId = "mainnet",
): Promise<Network> {
  const [s, v, b] = await Promise.all(
    ENDPOINTS.map((e) => readOnlyGet(e, "GET", network)),
  );
  return normalizeNetwork(s, v, b, networkConfig(network).chainId);
}

export function deriveNetworkState({
  mode,
  loading,
  error,
  hasData,
  expired = false,
}: {
  mode: "LIVE" | "DEMO";
  loading: boolean;
  error: boolean;
  hasData: boolean;
  expired?: boolean;
}): "demo" | "loading" | "stale" | "live" {
  if (mode === "DEMO") return "demo";
  if (loading && !hasData) return "loading";
  if (error && !hasData) return "demo";
  if (error || expired) return "stale";
  return "live";
}

/**
 * Provenance of one query's data, for the truthful live / stale / unavailable labels.
 * `staleAfterMs` is how old a successful read may get before it is no longer called live.
 */
export type ReadState =
  "loading" | "live" | "stale" | "unavailable" | "not-found";
export function deriveReadState({
  pending,
  error,
  notFound = false,
  hasData,
  updatedAt,
  now,
  staleAfterMs,
}: {
  pending: boolean;
  error: boolean;
  notFound?: boolean;
  hasData: boolean;
  updatedAt: number;
  now: number;
  staleAfterMs: number;
}): ReadState {
  if (notFound && !hasData) return "not-found";
  if (pending && !hasData) return "loading";
  if (!hasData) return "unavailable";
  if (error || now - updatedAt > staleAfterMs) return "stale";
  return "live";
}
