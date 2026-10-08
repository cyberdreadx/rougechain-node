/**
 * Shielded pool V2 on the site: the feature flag, the configured node set, and the client's own
 * constants (none of them consensus).
 *
 * The node set (UI_CONTRACT obligation 4, limit 7): an odd number of at least three nodes RUN BY
 * DIFFERENT OPERATORS, each an https origin. Until three exist the page is read-only and says so.
 * Today RougeChain has ONE public API origin per network, run by the project; a second node run by
 * the same operator would not be independent, so it is not listed. The two other slots are
 * placeholders, and stay so until an independent operator runs a node (then fill in `origin` and
 * `operator`). Placeholders are never handed to the core.
 */
import type { NetworkType } from "@rougechain/core/network";

/** `VITE_SHIELD_V2_ENABLED=true` turns the /shield page on. Off by default; not set in netlify.toml. */
export function shieldV2Enabled(): boolean {
  return import.meta.env.VITE_SHIELD_V2_ENABLED === "true";
}

export interface ConfiguredNode {
  /** An https origin (`https://host[:port]`), or null for a slot nobody fills yet. */
  origin: string | null;
  /** Who runs it — shown in the node settings (UI_CONTRACT limit 7). */
  operator: string;
}

export const DEFAULT_NODES: Record<NetworkType, ConfiguredNode[]> = {
  mainnet: [
    { origin: "https://api.rougechain.io", operator: "RougeChain (project)" },
    // PLACEHOLDER: a node run by an independent operator. Not configured yet.
    { origin: null, operator: "independent operator 2 (not yet)" },
    // PLACEHOLDER: a node run by a third, independent operator. Not configured yet.
    { origin: null, operator: "independent operator 3 (not yet)" },
  ],
  testnet: [
    { origin: "https://testnet.rougechain.io", operator: "RougeChain (project)" },
    // PLACEHOLDER: a node run by an independent operator. Not configured yet.
    { origin: null, operator: "independent operator 2 (not yet)" },
    // PLACEHOLDER: a node run by a third, independent operator. Not configured yet.
    { origin: null, operator: "independent operator 3 (not yet)" },
  ],
};

/** The minimum the page needs before it offers anything that writes (the core's own minimum is 3 too). */
export const MIN_NODES = 3;

/**
 * Where an envelope is submitted. The node has no V2-specific submission route
 * (`core/shield-v2-wallet/NOTES.md` §6 item 1): a `TxV1` enters through the generic transaction
 * path. Which PUBLIC route carries it, with what rate limit, is node and proxy work that is not
 * decided yet — `/api/tx/broadcast` is the node's route that takes a `TxV1`, and it is closed at
 * the public proxy today. Shielded payments therefore cannot reach mainnet from this page yet,
 * whatever the flag says.
 */
export const SUBMIT_PATH = "/api/tx/broadcast";

/** Seconds between rounds of the client loop while the page is open (the sync cadence). */
export const ROUND_INTERVAL_MS = 20_000;
/** After every node was left once without a round that confirmed the tip: rounds slow down (NOTES §6). */
export const SLOW_ROUND_INTERVAL_MS = 120_000;
/** "The pool is not active": ask again after a long interval, never every round (obligation 8). */
export const INACTIVE_RECHECK_MS = 60 * 60_000;
/** The observation period of the block rate shown next to a block count (obligation 3). */
export const RATE_WINDOW_DAYS = 7;
/** A state report answer larger than this is not handed to the core as it is (obligation 9). */
export const MAX_REPORT_BYTES = 4 * 1024;

const STORAGE_KEY = "rougechain-shield-v2-nodes";

/**
 * Whether a configured origin is acceptable in the settings: https (http only for loopback
 * development sets), no path, and not the local-use NAT64 prefix `64:ff9b:1::/48`, which the core
 * cannot map to a host (UI_CONTRACT obligation 4: "a client SHOULD refuse it").
 */
export function originProblem(raw: string): "not_an_origin" | "not_https" | "local_nat64" | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return "not_an_origin";
  }
  if (u.pathname !== "/" || u.search || u.hash || u.username || u.password) return "not_an_origin";
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (/^64:ff9b:1:/.test(host)) return "local_nat64";
  const loopback = host === "localhost" || host === "::1" || /^127\./.test(host);
  if (u.protocol === "http:" && !loopback) return "not_https";
  if (u.protocol !== "https:" && u.protocol !== "http:") return "not_an_origin";
  return null;
}

/** The node set for a network: the user's own list if they set one, otherwise the defaults. */
export function loadNodes(network: NetworkType): ConfiguredNode[] {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY}:${network}`);
    if (raw) {
      const list = JSON.parse(raw) as ConfiguredNode[];
      if (Array.isArray(list) && list.every((n) => typeof n?.operator === "string" && (n.origin === null || typeof n.origin === "string"))) return list;
    }
  } catch {
    /* storage unavailable or not ours: defaults */
  }
  return DEFAULT_NODES[network];
}

export function saveNodes(network: NetworkType, nodes: ConfiguredNode[] | null): void {
  try {
    if (nodes === null) localStorage.removeItem(`${STORAGE_KEY}:${network}`);
    else localStorage.setItem(`${STORAGE_KEY}:${network}`, JSON.stringify(nodes));
  } catch {
    /* storage unavailable: the defaults stay */
  }
}

/** The origins that can be handed to the core (placeholders and refused origins are not). */
export function usableOrigins(nodes: ConfiguredNode[]): string[] {
  return nodes.flatMap((n) => (n.origin && originProblem(n.origin) === null ? [new URL(n.origin).origin] : []));
}
