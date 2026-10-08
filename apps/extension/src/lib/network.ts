import * as storage from "./storage";
import { chainIdForNetwork, checkNodeChainId, assertNoKnownMismatch, withChainId } from "./chain-binding";

export type NetworkType = "mainnet" | "testnet";

export const NETWORK_STORAGE_KEY = "rougechain-network";

// Default node URLs — browser extension uses the remote public node
const DEFAULT_TESTNET_URL = "https://testnet.rougechain.io/api";
const DEFAULT_MAINNET_URL = "https://api.rougechain.io/api";

export function getActiveNetwork(): NetworkType {
    const saved = storage.getItem(NETWORK_STORAGE_KEY) as NetworkType | null;
    if (saved === "mainnet" || saved === "testnet") return saved;
    return "mainnet";
}

export function setActiveNetwork(network: NetworkType): void {
    storage.setItem(NETWORK_STORAGE_KEY, network);
}

export function getCoreApiBaseUrl(): string {
    const network = getActiveNetwork();
    const customUrl = storage.getItem("rougechain-custom-node-url");

    if (customUrl) return normalizeApiBaseUrl(customUrl);
    if (network === "mainnet") return DEFAULT_MAINNET_URL;
    return DEFAULT_TESTNET_URL;
}

export function getNodeApiBaseUrl(): string {
    return getCoreApiBaseUrl();
}

export function getCoreApiHeaders(): HeadersInit {
    const apiKey = storage.getItem("rougechain-api-key");
    if (!apiKey) return {};
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

export function setCustomNodeUrl(url: string): void {
    storage.setItem("rougechain-custom-node-url", url);
}

export function getCustomNodeUrl(): string {
    return storage.getItem("rougechain-custom-node-url") || "";
}

function normalizeApiBaseUrl(url: string): string {
    const trimmed = url.replace(/\/+$/, "");
    if (trimmed.endsWith("/api")) return trimmed;
    return `${trimmed}/api`;
}

/**
 * Chain id of the selected network — signed into every payload (see chain-binding.ts). Throws if
 * the node of this network was found to report a different chain id this session.
 */
export function getSigningChainId(): string {
    const chainId = chainIdForNetwork(getActiveNetwork());
    assertNoKnownMismatch(chainId);
    return chainId;
}

/** Check the selected network's chain id against its node, once per session (popup context). */
export async function ensureNodeChainId(baseUrl: string = getCoreApiBaseUrl()): Promise<string> {
    const chainId = chainIdForNetwork(getActiveNetwork());
    await checkNodeChainId(baseUrl, chainId, fetch, getCoreApiHeaders());
    return chainId;
}

/** `payload` bound to the selected network (`chainId` inside the signed bytes). */
export function bindToSelectedNetwork<T extends Record<string, unknown>>(payload: T): T & { chainId: string } {
    return withChainId(payload, getSigningChainId());
}
