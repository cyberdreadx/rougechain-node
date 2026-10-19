/**
 * Shielded pool V2 on the site: the feature flag, the configured node set, and the client's own
 * constants (none of them consensus).
 *
 * The node set (UI_CONTRACT obligation 4, limit 7): an odd number of at least three nodes, each an
 * https origin on its own host. Owner decision 2026-10-18: on mainnet the three are the project's
 * own machines (the primary, node #2, node #3), each named as run by the project, so the settings
 * show plainly that one operator stands behind all three; anyone can replace them with their own.
 * Testnet runs one public node today, so its two other slots stay placeholders. Placeholders are
 * never handed to the core.
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
    { origin: "https://api.rougechain.io", operator: "RougeChain (project): primary" },
    { origin: "https://api2.rougechain.io", operator: "RougeChain (project): node 2" },
    { origin: "https://api3.rougechain.io", operator: "RougeChain (project): node 3" },
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
 * Where an envelope is submitted: the node's V2-only submit route. It admits `shield_v2`,
 * `shielded_transfer_v2` and `unshield_v2` and nothing else, refuses them before the activation
 * height, and forwards an accepted one to the node's peers, so any configured node can take it.
 * The generic `/api/tx/broadcast` stays closed at the public proxy.
 */
export const SUBMIT_PATH = "/api/shield-v2/submit";

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
 * Whether a configured origin is acceptable in the settings: https (http only for a loopback node
 * in a development build), no path, no IPv6 literal or trailing-dot name, and not the local-use NAT64 prefix `64:ff9b:1::/48`, which the core
 * cannot map to a host (UI_CONTRACT obligation 4: "a client SHOULD refuse it").
 */
export function originProblem(raw: string, dev = import.meta.env.DEV): "not_an_origin" | "not_https" | "local_nat64" | "ip6_literal" | "trailing_dot" | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return "not_an_origin";
  }
  if (u.pathname !== "/" || u.search || u.hash || u.username || u.password) return "not_an_origin";
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (/^64:ff9b:1:/.test(host)) return "local_nat64";
  // The browser and the wallet core spell an IPv6 literal (IPv4-mapped forms) and a trailing-dot
  // name differently; either would make the site and the core disagree on the configured set.
  if (u.hostname.startsWith("[") && host !== "::1") return "ip6_literal";
  if (host.endsWith(".")) return "trailing_dot";
  const loopback = host === "localhost" || host === "::1" || /^127\./.test(host);
  // plain http only for a loopback node, and only in a development build
  if (u.protocol === "http:" && !(loopback && dev)) return "not_https";
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

/** A whole configured list: no origin twice, and an odd number of nodes (a strict majority is then never a tie). */
export function listProblem(origins: string[]): "duplicate" | "even" | null {
  const seen = new Set(origins.map((o) => new URL(o).origin));
  if (seen.size !== origins.length) return "duplicate";
  if (origins.length > 0 && origins.length % 2 === 0) return "even";
  return null;
}

