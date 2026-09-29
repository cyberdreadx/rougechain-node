import snapshot from "./snapshot.json";
export const API_BASE = "https://api.rougechain.io/api";
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
export const demoSnapshot: Network = snapshot;
// Fixed host, allowlisted endpoints, literal GET, omitted credentials. No write transport exists.
export async function readOnlyGet(
  endpoint: Endpoint,
  method: "GET" = "GET",
): Promise<unknown> {
  if (method !== "GET" || !ENDPOINTS.includes(endpoint))
    throw new Error("Only verified read-only GET endpoints are allowed");
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: "GET",
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(8000),
    headers: { Accept: "application/json" },
  });
  if (!response.ok)
    throw new Error(`Network data unavailable (${response.status})`);
  return response.json();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Unexpected API object");
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Unexpected API number");
  return value;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value)
    throw new Error("Unexpected API string");
  return value;
}
export function normalizeNetwork(
  stats: unknown,
  validators: unknown,
  blocks: unknown,
): Network {
  const s = object(stats),
    v = object(validators),
    b = object(blocks);
  if (
    v.success !== true ||
    !Array.isArray(v.validators) ||
    !Array.isArray(b.blocks) ||
    s.chain_id !== "rougechain-mainnet-1"
  )
    throw new Error("Unexpected mainnet response");
  return {
    height: integer(s.network_height),
    peers: integer(s.connected_peers),
    validators: v.validators.length,
    chainId: string(s.chain_id),
    capturedAt: new Date().toISOString(),
    blocks: b.blocks
      .map((raw) => {
        const block = object(raw),
          header = object(block.header);
        if (!Array.isArray(block.txs) || header.chain_id !== s.chain_id)
          throw new Error("Unexpected block");
        return {
          height: integer(header.height),
          hash: string(block.hash),
          transactions: block.txs.length,
          timestamp: integer(header.time),
        };
      })
      .sort((a, b) => b.height - a.height)
      .slice(0, 8),
  };
}
export async function getNetwork(): Promise<Network> {
  const [s, v, b] = await Promise.all(ENDPOINTS.map((e) => readOnlyGet(e)));
  return normalizeNetwork(s, v, b);
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
