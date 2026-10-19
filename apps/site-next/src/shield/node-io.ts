/**
 * What the client asks the configured nodes, and what it does with an answer BEFORE the core
 * sees it (UI_CONTRACT obligation 9).
 *
 * * A listing answer is a LISTING PAGE iff: status 200, a body that is JSON, an object at its top
 *   level, with at least one of `active`, `tip_height`, `from_height`, `next_height`, `txs`
 *   (`ListingPage::is_page`). Anything else is NO ANSWER (a strike; never a ban) and is not handed
 *   to `scan`. The core is handed the RAW body text.
 * * A stats answer is labelled with the CONFIGURED origin (never anything the node says) and
 *   handed in as `{ node_id, stats: <raw body> }`. A body larger than 4 KiB is not handed in as
 *   it is (a real stats body carries the pool's anchor window, 128 roots, about 9 KiB): its
 *   `report` member is handed in as the labelled report object if THAT is at most 4 KiB, and the
 *   answer is dropped otherwise. Whatever is wrong inside an answer is the core's to count.
 */
import { MAX_REPORT_BYTES, SUBMIT_PATH } from "./config";
import { canonicalOrigin, type ReportView } from "./loop";

export interface NetAnswer {
  status: number;
  text: string;
}

/** Transport: `null` when nothing came back (offline, timeout, refused, CORS). */
export interface Net {
  request(url: string, init?: RequestInit): Promise<NetAnswer | null>;
}

export const fetchNet: Net = {
  async request(url, init) {
    try {
      const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(20_000) : undefined;
      const res = await fetch(url, { cache: "no-store", ...init, signal });
      return { status: res.status, text: await res.text() };
    } catch {
      return null;
    }
  },
};

const PAGE_MEMBERS = ["active", "tip_height", "from_height", "next_height", "txs"];

export interface ListingPageAnswer {
  kind: "page";
  /** The raw body: what the core is handed. */
  text: string;
  /** What the loop reads of it (the core decides whether the page is valid). */
  view: { active: boolean; from_height: number; next_height: number };
}

export type ListingAnswer = ListingPageAnswer | { kind: "none" };

/** `ListingPage::is_page`, and the members the loop reads. */
export function classifyListing(a: NetAnswer | null): ListingAnswer {
  if (!a || a.status !== 200 || !a.text) return { kind: "none" };
  let v: unknown;
  try {
    v = JSON.parse(a.text);
  } catch {
    return { kind: "none" };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { kind: "none" };
  const o = v as Record<string, unknown>;
  if (!PAGE_MEMBERS.some((m) => m in o)) return { kind: "none" };
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  return { kind: "page", text: a.text, view: { active: o.active === true, from_height: num(o.from_height), next_height: num(o.next_height) } };
}

export function listingUrl(origin: string, since: number, blocks: number): string {
  return `${origin}/api/shield-v2/notes?since=${since}&blocks=${blocks}`;
}

export function statsUrl(origin: string): string {
  return `${origin}/api/shield-v2/stats`;
}

/** One configured node's stats answer, prepared for the round. */
export interface StatsAnswer {
  node: number;
  origin: string;
  /** What is handed to `confirm_state` (null: nothing — no answer, or dropped). */
  element: unknown | null;
  /** The `active` field, when the body has one. */
  active: boolean | null;
  /** The report as the loop reads it, when it is a complete report (with `ciphertext_acc`). */
  report: ReportView | null;
  /** From the body's `pool` member: what a shield is anchored to. */
  pool: { latest_anchor: string | null; tip_height: number | null; pool_total_quanta: string | null } | null;
}

const HEX32 = /^[0-9a-f]{64}$/;
const isU64 = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;

function completeReport(r: unknown): r is { height: number; tree_root: string; nullifier_acc: string; note_count: number; nullifier_count: number; ciphertext_acc: string } {
  if (!r || typeof r !== "object" || Array.isArray(r)) return false;
  const o = r as Record<string, unknown>;
  return (
    isU64(o.height) &&
    isU64(o.note_count) &&
    isU64(o.nullifier_count) &&
    typeof o.tree_root === "string" &&
    HEX32.test(o.tree_root) &&
    typeof o.nullifier_acc === "string" &&
    HEX32.test(o.nullifier_acc) &&
    typeof o.ciphertext_acc === "string" &&
    HEX32.test(o.ciphertext_acc)
  );
}

export function prepareStats(node: number, origin: string, a: NetAnswer | null): StatsAnswer {
  const out: StatsAnswer = { node, origin, element: null, active: null, report: null, pool: null };
  if (!a || a.status !== 200 || !a.text) return out;
  let body: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(a.text);
    if (v && typeof v === "object" && !Array.isArray(v)) body = v as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (a.text.length <= MAX_REPORT_BYTES) {
    out.element = { node_id: origin, stats: a.text };
  } else if (body && body.report && typeof body.report === "object" && !Array.isArray(body.report)) {
    const labelled = { ...(body.report as Record<string, unknown>), node_id: origin };
    if (JSON.stringify(labelled).length <= MAX_REPORT_BYTES) out.element = labelled;
  }
  if (!body) return out;
  if (typeof body.active === "boolean") out.active = body.active;
  if (completeReport(body.report)) {
    const r = body.report;
    out.report = { node_id: origin, height: r.height, note_count: r.note_count, nullifier_count: r.nullifier_count };
  }
  const pool = body.pool as Record<string, unknown> | null | undefined;
  if (pool && typeof pool === "object") {
    out.pool = {
      latest_anchor: typeof pool.latest_anchor === "string" && HEX32.test(pool.latest_anchor) ? pool.latest_anchor : null,
      tip_height: isU64(body.tip_height) ? body.tip_height : null,
      pool_total_quanta: typeof pool.pool_total_quanta === "string" && /^\d+$/.test(pool.pool_total_quanta) ? pool.pool_total_quanta : null,
    };
  }
  return out;
}

/** The value a strict majority of the configured nodes agree on, or null. */
export function quorumValue<T>(values: (T | null)[], configured: number, key: (v: T) => string = (v) => JSON.stringify(v)): T | null {
  const quorum = Math.max(Math.floor(configured / 2) + 1, 2);
  const counts = new Map<string, { v: T; n: number }>();
  for (const v of values) {
    if (v === null) continue;
    const k = key(v);
    const c = counts.get(k) ?? { v, n: 0 };
    c.n += 1;
    counts.set(k, c);
  }
  for (const c of counts.values()) if (c.n >= quorum) return c.v;
  return null;
}

/** `GET /api/health` → `chain_id`. */
export function chainIdOf(a: NetAnswer | null): string | null {
  if (!a || a.status !== 200) return null;
  try {
    const v = JSON.parse(a.text) as { chain_id?: unknown };
    return typeof v.chain_id === "string" && v.chain_id ? v.chain_id : null;
  } catch {
    return null;
  }
}

/** `GET /api/account/:pubkey/nonce` → `next_nonce`. */
export function nextNonceOf(a: NetAnswer | null): number | null {
  if (!a || a.status !== 200) return null;
  try {
    const v = JSON.parse(a.text) as { next_nonce?: unknown };
    return isU64(v.next_nonce) ? v.next_nonce : null;
  } catch {
    return null;
  }
}

/** Submits the stored envelope text as it is. "accepted" / "failed" (the node said no) / "unanswered". */
export async function submitEnvelope(net: Net, origin: string, envelope: string): Promise<"accepted" | "failed" | "unanswered"> {
  const a = await net.request(`${origin}${SUBMIT_PATH}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: envelope });
  if (!a) return "unanswered";
  if (a.status !== 200) return a.status >= 500 ? "unanswered" : "failed";
  try {
    const v = JSON.parse(a.text) as { success?: unknown };
    return v.success === true ? "accepted" : "failed";
  } catch {
    return "unanswered";
  }
}

export { canonicalOrigin };
