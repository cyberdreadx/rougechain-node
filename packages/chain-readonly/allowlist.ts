/**
 * The complete list of node routes the site may read. Anything else is refused before a request
 * is made. Every path parameter and query parameter has a validator; unknown query parameters,
 * duplicates, encoded separators and dot segments are rejected.
 *
 * All routes are GET routes of core/daemon (see `.route("/api/…", get(…))` in main.rs).
 */

export const HEIGHT = /^(0|[1-9]\d{0,15})$/;
export const HASH64 = /^[0-9a-f]{64}$/;
/** ML-DSA-65 public keys are 1952 bytes; accept any plausibly sized hex key. */
export const PUBKEY_HEX = /^[0-9a-f]{64,8192}$/;
export const ROUGE1 = /^rouge1[02-9ac-hj-np-z]{6,90}$/;
export const CONTRACT_ADDR = /^[0-9a-f]{40}$/;
export const TOKEN_SYMBOL = /^[A-Za-z0-9_-]{1,32}$/;
export const POOL_ID = /^[A-Za-z0-9_]{1,32}-[A-Za-z0-9_]{1,32}$/;
export const COLLECTION_ID = /^col:[0-9a-f]{16}:[A-Za-z0-9_-]{1,32}$/;
/** Bridge activity cursor: `<height>` or `<height>-<index>` (as the node returns it). */
export const BRIDGE_CURSOR = /^(0|[1-9]\d{0,15})(-(0|[1-9]\d{0,5}))?$/;
const SMALL_INT = (max: number) => (v: string) =>
  /^(0|[1-9]\d{0,9})$/.test(v) && Number(v) <= max;
const POSITIVE_INT = (max: number) => (v: string) =>
  /^[1-9]\d{0,9}$/.test(v) && Number(v) <= max;
const ADDRESS = (v: string) => ROUGE1.test(v) || PUBKEY_HEX.test(v);

type Check = RegExp | ((value: string) => boolean);
type Segment = string | { param: string; check: Check };

export interface RouteSpec {
  id: string;
  segments: Segment[];
  query?: Record<string, Check>;
  /** Query parameters that must be present. */
  required?: string[];
}

const p = (param: string, check: Check) => ({ param, check });

export const READ_ROUTES: readonly RouteSpec[] = Object.freeze<RouteSpec[]>([
  { id: "stats", segments: ["stats"] },
  { id: "validators", segments: ["validators"] },
  {
    id: "blocks",
    segments: ["blocks"],
    query: {
      limit: POSITIVE_INT(100),
      page: POSITIVE_INT(1_000_000_000),
      per_page: POSITIVE_INT(100),
    },
  },
  { id: "block", segments: ["block", p("height", HEIGHT)] },
  {
    id: "txs",
    segments: ["txs"],
    query: { limit: POSITIVE_INT(200), offset: SMALL_INT(1_000_000) },
  },
  { id: "tx", segments: ["tx", p("hash", HASH64)] },
  { id: "resolve", segments: ["resolve", p("address", ROUGE1)] },
  { id: "balance", segments: ["balance", p("address", ADDRESS)] },
  {
    id: "addressTxs",
    segments: ["address", p("address", ADDRESS), "transactions"],
    query: { limit: POSITIVE_INT(100), offset: SMALL_INT(1_000_000) },
  },
  { id: "nftOwner", segments: ["nft", "owner", p("pubkey", PUBKEY_HEX)] },
  { id: "tokens", segments: ["tokens"] },
  {
    id: "tokenMetadata",
    segments: ["token", p("symbol", TOKEN_SYMBOL), "metadata"],
  },
  {
    id: "tokenHolders",
    segments: ["token", p("symbol", TOKEN_SYMBOL), "holders"],
  },
  {
    id: "tokenTxs",
    segments: ["token", p("symbol", TOKEN_SYMBOL), "transactions"],
    query: { limit: POSITIVE_INT(100) },
  },
  { id: "pools", segments: ["pools"] },
  { id: "poolPrices", segments: ["pool", p("poolId", POOL_ID), "prices"] },
  { id: "nftCollections", segments: ["nft", "collections"] },
  {
    id: "nftCollection",
    segments: ["nft", "collection", p("id", COLLECTION_ID)],
  },
  {
    id: "nftCollectionTokens",
    segments: ["nft", "collection", p("id", COLLECTION_ID), "tokens"],
    query: { limit: POSITIVE_INT(100), offset: SMALL_INT(1_000_000) },
  },
  { id: "contracts", segments: ["contracts"] },
  { id: "contract", segments: ["contract", p("addr", CONTRACT_ADDR)] },
  {
    id: "contractState",
    segments: ["contract", p("addr", CONTRACT_ADDR), "state"],
  },
  {
    id: "contractEvents",
    segments: ["contract", p("addr", CONTRACT_ADDR), "events"],
    query: { limit: POSITIVE_INT(100), before: HEIGHT },
  },
  // Bridge (public GETs only; every POST/DELETE bridge route stays unreachable).
  { id: "bridgeConfig", segments: ["bridge", "config"] },
  {
    id: "bridgeActivity",
    segments: ["bridge", "activity"],
    query: { limit: POSITIVE_INT(100), before: BRIDGE_CURSOR },
  },
  {
    id: "bridgeActivityItem",
    segments: ["bridge", "activity", p("txId", HASH64)],
  },
  // Fallback while a node does not serve /bridge/activity: the relayers' pending lists.
  { id: "bridgeWithdrawals", segments: ["bridge", "withdrawals"] },
  { id: "bridgeBtcWithdrawals", segments: ["bridge", "btc", "withdrawals"] },
  { id: "bridgeXrgeWithdrawals", segments: ["bridge", "xrge", "withdrawals"] },
]);

export type ReadRouteId =
  | "stats"
  | "validators"
  | "blocks"
  | "block"
  | "txs"
  | "tx"
  | "resolve"
  | "balance"
  | "addressTxs"
  | "nftOwner"
  | "tokens"
  | "tokenMetadata"
  | "tokenHolders"
  | "tokenTxs"
  | "pools"
  | "poolPrices"
  | "nftCollections"
  | "nftCollection"
  | "nftCollectionTokens"
  | "contracts"
  | "contract"
  | "contractState"
  | "contractEvents"
  | "bridgeConfig"
  | "bridgeActivity"
  | "bridgeActivityItem"
  | "bridgeWithdrawals"
  | "bridgeBtcWithdrawals"
  | "bridgeXrgeWithdrawals";

function passes(check: Check, value: string) {
  return typeof check === "function" ? check(value) : check.test(value);
}

export class NotAllowlistedError extends Error {
  constructor(reason: string) {
    super(`Only verified read-only GET endpoints are allowed (${reason})`);
    this.name = "NotAllowlistedError";
  }
}

function decodeSegment(raw: string): string {
  // Encoded separators could smuggle a different route past the matcher.
  if (/%(2f|5c|2e|3f|23)/i.test(raw))
    throw new NotAllowlistedError("encoded separator");
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new NotAllowlistedError("bad encoding");
  }
}

/**
 * Match a relative API path ("/block/12", "/txs?limit=20&offset=40") against the allowlist.
 * Returns the matched route id, or throws NotAllowlistedError.
 */
export function matchReadRoute(path: string): ReadRouteId {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//")
  )
    throw new NotAllowlistedError("not a relative path");
  if (/[\s#\\]/.test(path) || path.length > 9000)
    throw new NotAllowlistedError("invalid characters");
  const q = path.indexOf("?");
  const pathname = q === -1 ? path : path.slice(0, q);
  const search = q === -1 ? "" : path.slice(q + 1);
  const rawSegments = pathname.slice(1).split("/");
  if (rawSegments.some((s) => s === "" || s === "." || s === ".."))
    throw new NotAllowlistedError("empty or dot segment");
  const segments = rawSegments.map(decodeSegment);
  for (const route of READ_ROUTES) {
    if (route.segments.length !== segments.length) continue;
    const ok = route.segments.every((seg, i) =>
      typeof seg === "string"
        ? seg === segments[i]
        : passes(seg.check, segments[i]),
    );
    if (!ok) continue;
    checkQuery(route, search);
    return route.id as ReadRouteId;
  }
  throw new NotAllowlistedError("unknown route");
}

function checkQuery(route: RouteSpec, search: string) {
  const seen = new Set<string>();
  if (search) {
    for (const pair of search.split("&")) {
      const eq = pair.indexOf("=");
      if (eq <= 0) throw new NotAllowlistedError("malformed query");
      const key = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const check = route.query?.[key];
      if (!check) throw new NotAllowlistedError(`query parameter ${key}`);
      if (seen.has(key)) throw new NotAllowlistedError(`duplicate ${key}`);
      if (!passes(check, value)) throw new NotAllowlistedError(`bad ${key}`);
      seen.add(key);
    }
  }
  for (const key of route.required ?? [])
    if (!seen.has(key)) throw new NotAllowlistedError(`missing ${key}`);
}

/**
 * Build an allowlisted path from a route id and parameters. Parameters are validated and
 * encoded; the result is matched again so the builder can never produce a route the matcher
 * would refuse.
 */
export function buildReadPath(
  id: ReadRouteId,
  params: Record<string, string | number> = {},
  query: Record<string, string | number | undefined> = {},
): string {
  const route = READ_ROUTES.find((r) => r.id === id);
  if (!route) throw new NotAllowlistedError("unknown route");
  const parts = route.segments.map((seg) => {
    if (typeof seg === "string") return seg;
    const value = String(params[seg.param] ?? "");
    if (!passes(seg.check, value))
      throw new NotAllowlistedError(`bad ${seg.param}`);
    return encodeURIComponent(value);
  });
  const search = Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("&");
  const path = `/${parts.join("/")}${search ? `?${search}` : ""}`;
  if (matchReadRoute(path) !== id)
    throw new NotAllowlistedError("route mismatch");
  return path;
}
