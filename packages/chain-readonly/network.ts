/**
 * Networks the read client may talk to. Each entry pins the API origin and the chain id the
 * node must report, so a misrouted or misconfigured endpoint is rejected instead of rendered.
 *
 * Selection mirrors apps/web/src/lib/network.ts: a deploy pinned with VITE_NETWORK_LOCK only
 * ever reads that network; otherwise the saved choice is honoured and the default is mainnet.
 * Testnet never falls back to the mainnet API.
 */
export type NetworkId = "mainnet" | "testnet";

export interface ChainNetwork {
  id: NetworkId;
  label: string;
  apiBase: string;
  /** chain_id reported by /api/stats and every block header on this network. */
  chainId: string;
}

export const NETWORKS: Readonly<Record<NetworkId, ChainNetwork>> = Object.freeze({
  mainnet: Object.freeze({
    id: "mainnet",
    label: "Mainnet",
    apiBase: "https://api.rougechain.io/api",
    chainId: "rougechain-mainnet-1",
  }),
  testnet: Object.freeze({
    id: "testnet",
    label: "Testnet",
    apiBase: "https://testnet.rougechain.io/api",
    // The public testnet node reports the devnet chain id (see apps/web/src/test/testnet.test.ts).
    chainId: "rougechain-devnet-1",
  }),
});

/** Same storage key as apps/web, so a visitor's saved choice carries over. */
export const NETWORK_STORAGE_KEY = "rougechain-network";

export function isNetworkId(value: unknown): value is NetworkId {
  return value === "mainnet" || value === "testnet";
}

/** Parse VITE_NETWORK_LOCK: only an exact "mainnet" / "testnet" pins the deploy. */
export function parseNetworkLock(value: unknown): NetworkId | null {
  return isNetworkId(value) ? value : null;
}

export function resolveNetwork({
  lock,
  saved,
}: {
  lock: NetworkId | null;
  saved?: unknown;
}): NetworkId {
  if (lock) return lock;
  if (isNetworkId(saved)) return saved;
  return "mainnet";
}

export function networkConfig(id: NetworkId): ChainNetwork {
  const config = NETWORKS[id];
  if (!config) throw new Error("Unknown network");
  return config;
}
