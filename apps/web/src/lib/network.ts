export type NetworkType = "mainnet" | "testnet";

export const NETWORK_STORAGE_KEY = "rougechain-network";

/**
 * A deploy pinned to one network (`VITE_NETWORK_LOCK=testnet` on testnet.rougechain.io,
 * `mainnet` on rougechain.io). Pinned sites never switch in place: they link to the other site.
 * Unset = the old in-page switcher.
 */
export function getNetworkLock(): NetworkType | null {
  const v = import.meta.env.VITE_NETWORK_LOCK as string | undefined;
  return v === "mainnet" || v === "testnet" ? v : null;
}

/** Public site for each network (used by pinned deploys to link across). */
export function siteUrlFor(network: NetworkType): string {
  const env = network === "mainnet"
    ? (import.meta.env.VITE_MAINNET_SITE_URL as string | undefined)
    : (import.meta.env.VITE_TESTNET_SITE_URL as string | undefined);
  return (env || (network === "mainnet" ? "https://rougechain.io" : "https://testnet.rougechain.io")).replace(/\/+$/, "");
}

/** Switch network: on a pinned deploy go to the other network's site, otherwise switch in place. */
export function switchNetwork(next: NetworkType): void {
  const lock = getNetworkLock();
  if (lock) {
    if (next !== lock) window.location.href = siteUrlFor(next) + window.location.pathname + window.location.search;
    return;
  }
  localStorage.setItem(NETWORK_STORAGE_KEY, next);
  window.location.reload();
}

/**
 * Called once at startup: a pinned deploy writes its network into the saved setting, so every
 * page that reads NETWORK_STORAGE_KEY agrees with the pin.
 */
export function applyNetworkLock(): void {
  const lock = getNetworkLock();
  if (!lock) return;
  try { localStorage.setItem(NETWORK_STORAGE_KEY, lock); } catch { /* storage unavailable */ }
}

export function getActiveNetwork(): NetworkType {
  const lock = getNetworkLock();
  if (lock) return lock;
  const saved = localStorage.getItem(NETWORK_STORAGE_KEY) as NetworkType | null;
  if (saved === "mainnet" || saved === "testnet") {
    return saved;
  }
  return "mainnet";
}

export function getCoreApiBaseUrl(): string {
  const network = getActiveNetwork();
  const isProduction = typeof window !== "undefined" && !window.location.hostname.includes("localhost") && !window.location.hostname.includes("127.0.0.1");
  const defaultUrl =
    import.meta.env.VITE_CORE_API_URL ||
    import.meta.env.VITE_NODE_API_URL ||
    (isProduction ? "https://api.rougechain.io/api" : "http://localhost:5101/api");
  const mainnetUrl =
    (import.meta.env.VITE_CORE_API_URL_MAINNET as string | undefined) ||
    (import.meta.env.VITE_NODE_API_URL_MAINNET as string | undefined);
  const testnetUrl =
    (import.meta.env.VITE_CORE_API_URL_TESTNET as string | undefined) ||
    (import.meta.env.VITE_NODE_API_URL_TESTNET as string | undefined);

  if (network === "mainnet") {
    return normalizeApiBaseUrl(mainnetUrl || defaultUrl);
  }

  // Testnet must never fall back to the mainnet API.
  return normalizeApiBaseUrl(testnetUrl || (isProduction ? "https://testnet.rougechain.io/api" : defaultUrl));
}

export function getNodeApiBaseUrl(): string {
  return getCoreApiBaseUrl();
}

export function getCoreApiHeaders(): HeadersInit {
  const apiKey = (import.meta.env.VITE_CORE_API_KEY as string | undefined) || "";
  if (!apiKey) {
    return {};
  }
  return { "x-api-key": apiKey };
}

export function getNetworkLabel(chainId?: string): string {
  if (chainId) {
    if (chainId.includes("devnet")) return "Devnet";
    if (chainId.includes("testnet")) return "Testnet";
    return "Mainnet";
  }

  return getActiveNetwork() === "mainnet" ? "Mainnet" : "Testnet";
}

function normalizeApiBaseUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  if (trimmed.endsWith("/api")) {
    return trimmed;
  }
  return `${trimmed}/api`;
}
