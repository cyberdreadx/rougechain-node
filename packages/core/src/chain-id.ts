/**
 * Network binding of signatures.
 *
 * Every payload a RougeChain wallet signs — transactions AND signed requests (messenger, mail,
 * names, votes) — carries `chainId`: the exact chain id string of the network it is meant for.
 * Because payloads are serialized with sorted keys, the field is inside the signed bytes, so a
 * signature commits to one network. Nodes refuse a payload whose `chainId` is not theirs (and,
 * once operators turn on `REQUIRE_SIGNED_CHAIN_ID`, one without it).
 *
 * The chain id comes from the network configuration (`getActiveNetwork()`), and is cross-checked
 * once per session against what the node itself reports (`/api/health` → `chain_id`). If the
 * two disagree, signing is refused for that network until the page is reloaded.
 */
import { getActiveNetwork, getCoreApiBaseUrl, getCoreApiHeaders, type NetworkType } from "./network";
import { envChainIdMainnet, envChainIdTestnet } from "./env";

export const MAINNET_CHAIN_ID = "rougechain-mainnet-1";
export const TESTNET_CHAIN_ID = "rougechain-devnet-1";

/** The chain id of a configured network. */
export function chainIdForNetwork(network: NetworkType): string {
  const override = network === "mainnet" ? safeEnv(envChainIdMainnet) : safeEnv(envChainIdTestnet);
  return override || (network === "mainnet" ? MAINNET_CHAIN_ID : TESTNET_CHAIN_ID);
}

/** The configured network a chain id belongs to, or `null` for an unknown id. */
export function networkForChainId(chainId: string | undefined | null): NetworkType | null {
  if (!chainId) return null;
  if (chainId === chainIdForNetwork("mainnet")) return "mainnet";
  if (chainId === chainIdForNetwork("testnet")) return "testnet";
  return null;
}

/** Human name of the network a payload is signed for (approval screens). */
export function networkNameForChainId(chainId: string | undefined | null): string {
  if (!chainId) return "No network specified";
  const n = networkForChainId(chainId);
  if (n === "mainnet") return "RougeChain Mainnet";
  if (n === "testnet") return "RougeChain Testnet";
  return `Unknown network (${chainId})`;
}

/** The chain id this client signs for: the selected network's. */
export function getSigningChainId(): string {
  let network: NetworkType = "mainnet";
  try { network = getActiveNetwork(); } catch { /* no Web Storage (tests, workers): mainnet */ }
  const chainId = chainIdForNetwork(network);
  const reported = mismatches.get(chainId);
  if (reported !== undefined) {
    throw new ChainIdMismatchError(chainId, reported);
  }
  return chainId;
}

/**
 * Thrown when the node reports another chain id than the network configuration expects
 * (`source: "node"`), or when a payload names another network than the selected one
 * (`source: "payload"`).
 */
export class ChainIdMismatchError extends Error {
  readonly code = "CHAIN_ID_MISMATCH";
  constructor(readonly expected: string, readonly reported: string, readonly source: "node" | "payload" = "node") {
    super(source === "node"
      ? `Refusing to sign: this wallet is set to ${networkNameForChainId(expected)} (${expected}) but the node reports chain id "${reported}"`
      : `Refusing to sign: the request is for ${networkNameForChainId(reported)} (${reported}) but this wallet is set to ${networkNameForChainId(expected)} (${expected})`);
    this.name = "ChainIdMismatchError";
  }
}

/** Configured chain id → chain id a node reported for it, when they disagree. */
const mismatches = new Map<string, string>();
/** apiBase → the check in flight / done for it this session. */
const checks = new Map<string, Promise<string | null>>();

async function fetchReportedChainId(apiBase: string): Promise<string | null> {
  for (const path of ["/health", "/stats"]) {
    try {
      const res = await fetch(`${apiBase}${path}`, { headers: getCoreApiHeaders() });
      if (!res.ok) continue;
      const data = (await res.json()) as { chain_id?: unknown; chainId?: unknown };
      const id = typeof data?.chain_id === "string" ? data.chain_id : typeof data?.chainId === "string" ? data.chainId : null;
      if (id) return id;
    } catch { /* try the next endpoint */ }
  }
  return null;
}

/**
 * Cross-check the configured chain id against the node, once per session per node URL. Resolves
 * with the chain id to sign for. Rejects with `ChainIdMismatchError` when the node reports a
 * different chain id (and every later signature for that network is refused). A node that cannot
 * be reached, or that does not report a chain id, does not block signing — the node itself still
 * refuses a payload signed for another network.
 */
export async function verifyNodeChainId(apiBase?: string, expected?: string): Promise<string> {
  const want = expected ?? getSigningChainId();
  let base = apiBase;
  if (base === undefined) {
    try { base = getCoreApiBaseUrl(); } catch { base = ""; }
  }
  if (!base) return want;
  const key = `${base}\u0000${want}`;
  let check = checks.get(key);
  if (!check) {
    check = fetchReportedChainId(base);
    checks.set(key, check);
  }
  const reported = await check;
  if (reported !== null && reported !== want) {
    mismatches.set(want, reported);
    throw new ChainIdMismatchError(want, reported);
  }
  return want;
}

/**
 * Return `payload` with `chainId` set to the signing chain id. A payload that already names a
 * different chain id is refused (never silently re-targeted).
 */
export function withChainId<T extends object>(payload: T, chainId: string = getSigningChainId()): T & { chainId: string } {
  const existing = (payload as { chainId?: unknown }).chainId;
  if (existing !== undefined && existing !== chainId) {
    throw new ChainIdMismatchError(chainId, String(existing), "payload");
  }
  return { ...payload, chainId };
}

/** Test helper: forget the per-session checks and recorded mismatches. */
export function resetChainIdChecks(): void {
  checks.clear();
  mismatches.clear();
}

function safeEnv(get: () => string | undefined): string | undefined {
  try { return get(); } catch { return undefined; }
}
