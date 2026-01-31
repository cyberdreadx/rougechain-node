export type NetworkType = "mainnet" | "testnet";

export const NETWORK_STORAGE_KEY = "rougechain-network";

export function getActiveNetwork(): NetworkType {
  const saved = localStorage.getItem(NETWORK_STORAGE_KEY) as NetworkType | null;
  if (saved === "mainnet" || saved === "testnet") {
    return saved;
  }
  return "testnet";
}

export function getCoreApiBaseUrl(): string {
  const network = getActiveNetwork();
  const defaultUrl =
    import.meta.env.VITE_CORE_API_URL ||
    import.meta.env.VITE_NODE_API_URL ||
    "http://localhost:5100/api";
  const mainnetUrl =
    (import.meta.env.VITE_CORE_API_URL_MAINNET as string | undefined) ||
    (import.meta.env.VITE_NODE_API_URL_MAINNET as string | undefined);
  const testnetUrl =
    (import.meta.env.VITE_CORE_API_URL_TESTNET as string | undefined) ||
    (import.meta.env.VITE_NODE_API_URL_TESTNET as string | undefined);

  if (network === "mainnet") {
    if (!mainnetUrl) {
      return "";
    }
    return normalizeApiBaseUrl(mainnetUrl);
  }

  return normalizeApiBaseUrl(testnetUrl || defaultUrl);
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
