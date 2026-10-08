// Network binding of everything the extension signs for a RougeChain node.
//
// Every signed payload — transactions and signed requests (messenger, mail, names) — carries
// `chainId`, the exact chain id of the network the wallet has selected, inside the signed
// (sorted-key) bytes, so the signature is valid on that network only. dApp requests naming another
// network are refused. The selected network's chain id is checked once per session against what
// the node itself reports (`GET /api/health` → `chain_id`); on a difference nothing is signed.
//
// Pure module (no chrome.*, no storage) so the service worker, the popup and the tests share it.

// Same values and names as @rougechain/core/chain-id (the website's), kept here so the service
// worker does not pull in the website's network/env modules; test/chain-binding.test.ts checks
// that the two agree.

export type NetworkType = "mainnet" | "testnet";

export const MAINNET_CHAIN_ID = "rougechain-mainnet-1";
export const TESTNET_CHAIN_ID = "rougechain-devnet-1";

/** The chain id of a network the wallet can select. */
export function chainIdForNetwork(network: NetworkType): string {
    return network === "testnet" ? TESTNET_CHAIN_ID : MAINNET_CHAIN_ID;
}

/** Human name of the network a payload is signed for (approval screen). */
export function networkNameForChainId(chainId: string | undefined | null): string {
    if (!chainId) return "No network specified";
    if (chainId === MAINNET_CHAIN_ID) return "RougeChain Mainnet";
    if (chainId === TESTNET_CHAIN_ID) return "RougeChain Testnet";
    return `Unknown network (${chainId})`;
}

/** Thrown when the node reports another chain id than the selected network's. */
export class ChainIdMismatchError extends Error {
    readonly code = "CHAIN_ID_MISMATCH";
    constructor(readonly expected: string, readonly reported: string) {
        super(`Refusing to sign: this wallet is set to ${networkNameForChainId(expected)} (${expected}) but the node reports chain id "${reported}"`);
        this.name = "ChainIdMismatchError";
    }
}

/** What the approval screen shows about the network a dApp request is signed for. */
export interface NetworkReview {
    /** `chainId` named by the payload, or null when the request names none (older dApps). */
    chainId: string | null;
    /** Human name of the network the payload is for ("RougeChain Mainnet", …). */
    name: string;
    /** The wallet's selected network. */
    selectedChainId: string;
    selectedName: string;
    /** True when the request does not name a network (transitional: still signable for now). */
    missing: boolean;
}

/** Message shown for a request that names no network. */
export const MISSING_CHAIN_ID_WARNING =
    "This request does not say which network it is for. Only approve it if you trust this site and expect a transaction on the network your wallet is set to.";

function mismatchMessage(requested: string, selected: string): string {
    return `CHAIN_ID_MISMATCH: this request is for ${networkNameForChainId(requested)} (${requested}) but the wallet is set to ${networkNameForChainId(selected)} (${selected}). Switch networks in the wallet to sign it.`;
}

/** Review the `chainId` of a dApp payload against the wallet's selected chain id. */
export function reviewPayloadChainId(
    payload: Record<string, unknown>,
    selectedChainId: string,
): { error: string } | NetworkReview {
    const raw = payload.chainId;
    const selectedName = networkNameForChainId(selectedChainId);
    if (raw === undefined || raw === null) {
        return { chainId: null, name: networkNameForChainId(null), selectedChainId, selectedName, missing: true };
    }
    if (typeof raw !== "string" || raw.length === 0) {
        return { error: "CHAIN_ID_MISMATCH: payload.chainId must be a chain id string" };
    }
    if (raw !== selectedChainId) return { error: mismatchMessage(raw, selectedChainId) };
    return { chainId: raw, name: networkNameForChainId(raw), selectedChainId, selectedName, missing: false };
}

/**
 * `payload` with `chainId` set to `chainId`. A payload that already names a different chain id is
 * refused (never silently re-targeted).
 */
export function withChainId<T extends Record<string, unknown>>(payload: T, chainId: string): T & { chainId: string } {
    const existing = payload.chainId;
    if (existing !== undefined && existing !== null && existing !== chainId) {
        throw new Error(mismatchMessage(String(existing), chainId));
    }
    return { ...payload, chainId };
}

/** chain id → chain id a node reported for it, when they differ (per JS context = per session). */
const mismatches = new Map<string, string>();
/** `${baseUrl}\0${expected}` → the check done for it this session. */
const checks = new Map<string, Promise<string | null>>();

async function fetchReportedChainId(baseUrl: string, fetchFn: typeof fetch, headers?: HeadersInit): Promise<string | null> {
    for (const path of ["/health", "/stats"]) {
        try {
            const res = await fetchFn(`${baseUrl}${path}`, headers ? { headers } : undefined);
            if (!res.ok) continue;
            const data = (await res.json()) as { chain_id?: unknown };
            if (typeof data?.chain_id === "string" && data.chain_id) return data.chain_id;
        } catch { /* try the next endpoint */ }
    }
    return null;
}

/**
 * Check `expected` against the node at `baseUrl`, once per session. Throws ChainIdMismatchError
 * when the node reports another chain id (and every later `assertNoKnownMismatch(expected)`
 * throws too). An unreachable node, or one that reports no chain id, does not block signing —
 * the node itself refuses a payload signed for another network.
 */
export async function checkNodeChainId(
    baseUrl: string,
    expected: string,
    fetchFn: typeof fetch = fetch,
    headers?: HeadersInit,
): Promise<void> {
    assertNoKnownMismatch(expected);
    if (!baseUrl) return;
    const key = `${baseUrl}\u0000${expected}`;
    let check = checks.get(key);
    if (!check) {
        check = fetchReportedChainId(baseUrl, fetchFn, headers);
        checks.set(key, check);
        // Unreachable: try again next time instead of caching "unknown" for the whole session.
        check.then((r) => { if (r === null) checks.delete(key); });
    }
    const reported = await check;
    if (reported !== null && reported !== expected) {
        mismatches.set(expected, reported);
        throw new ChainIdMismatchError(expected, reported);
    }
}

/** Synchronous guard for signers that cannot await: refuse a chain id the node contradicted. */
export function assertNoKnownMismatch(chainId: string): void {
    const reported = mismatches.get(chainId);
    if (reported !== undefined) throw new ChainIdMismatchError(chainId, reported);
}

/** Test helper. */
export function resetChainIdChecks(): void {
    checks.clear();
    mismatches.clear();
}
