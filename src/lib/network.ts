export type NetworkType = "mainnet" | "testnet";

export const NETWORK_STORAGE_KEY = "rougechain-network";

export function getActiveNetwork(): NetworkType {
  const saved = localStorage.getItem(NETWORK_STORAGE_KEY) as NetworkType | null;
  if (saved === "mainnet" || saved === "testnet") {
    return saved;
  }
  return "testnet";
}

export function getNodeApiBaseUrl(): string {
  const network = getActiveNetwork();
  const defaultUrl = import.meta.env.VITE_NODE_API_URL || "http://localhost:5100/api";
  const mainnetUrl = import.meta.env.VITE_NODE_API_URL_MAINNET as string | undefined;
  const testnetUrl = import.meta.env.VITE_NODE_API_URL_TESTNET as string | undefined;

  if (network === "mainnet") {
    return mainnetUrl || defaultUrl;
  }

  return testnetUrl || defaultUrl;
}

export function getNetworkLabel(chainId?: string): string {
  if (chainId) {
    if (chainId.includes("devnet")) return "Devnet";
    if (chainId.includes("testnet")) return "Testnet";
    return "Mainnet";
  }

  return getActiveNetwork() === "mainnet" ? "Mainnet" : "Testnet";
}
