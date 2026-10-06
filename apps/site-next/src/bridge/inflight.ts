/**
 * Deposits sent from Base that RougeChain hasn't credited yet, kept in localStorage (per network)
 * so they stay visible across tab switches and reloads. Every storage access is guarded: when
 * storage is unavailable the list lives in memory for the session.
 */
import type { BridgeHistoryEntry } from "@rougechain/core/bridge";
import { formatTokenAmount } from "@rougechain/core/token-decimals";

export interface InflightDeposit {
  /** The Base deposit transaction (for XRGE the vault deposit, not the approval). */
  baseTxHash: string;
  asset: "ETH" | "USDC" | "XRGE";
  /** Symbol credited on RougeChain. */
  l1Symbol: string;
  /** The amount as the user saw it, e.g. "0.25". */
  amountLabel: string;
  /** Expected credit in RougeChain raw units (qETH / qUSDC: 6 dp, XRGE: whole), as a decimal string. */
  expectedL1Units: string;
  recipientPubkey: string;
  /** ms */
  startedAt: number;
  state: "sent" | "credited";
  /** ms; set when credited or dismissed. */
  finishedAt?: number;
  /** The RougeChain transaction that credited it (never matched to a second deposit). */
  creditTxId?: string;
  /** Hidden by the user; kept until it expires so its credit stays taken. */
  dismissed?: boolean;
}

const VERSION = 1;
const key = (network: string) => `rougechain.bridge.inflight.v${VERSION}.${network}`;
export const INFLIGHT_MAX = 20;
/** Finished (credited / dismissed) records are dropped after a day. */
export const INFLIGHT_KEEP_MS = 24 * 60 * 60 * 1000;
/** Without a credit for this long a deposit is shown as "taking longer than expected". */
export const INFLIGHT_SLOW_MS = 20 * 60 * 1000;
/** A credit may carry a block time slightly before the browser's clock at send time. */
export const INFLIGHT_SKEW_MS = 2 * 60 * 1000;

const memory = new Map<string, InflightDeposit[]>();
const listeners = new Set<() => void>();
let version = 0;

export function subscribeInflight(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
export const inflightVersion = (): number => version;

function valid(r: unknown): r is InflightDeposit {
  const d = r as Partial<InflightDeposit> | null;
  return !!d && typeof d.baseTxHash === "string" && typeof d.recipientPubkey === "string" && typeof d.startedAt === "number" && (d.state === "sent" || d.state === "credited");
}

const finished = (r: InflightDeposit) => r.state === "credited" || !!r.dismissed;

function read(network: string): InflightDeposit[] {
  const kept = memory.get(network);
  if (kept) return kept;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key(network)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(valid) : [];
  } catch {
    return [];
  }
}

function write(network: string, list: InflightDeposit[]): void {
  try {
    localStorage.setItem(key(network), JSON.stringify(list));
    memory.delete(network);
  } catch {
    memory.set(network, list);
  }
  version += 1;
  listeners.forEach((cb) => cb());
}

/** Every record of this network, oldest first, without finished ones older than a day. */
export function listInflight(network: string, now = Date.now()): InflightDeposit[] {
  return read(network)
    .filter((r) => !finished(r) || now - (r.finishedAt ?? r.startedAt) < INFLIGHT_KEEP_MS)
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** Track a deposit (replaces a record with the same Base transaction). Over the cap, finished records go first, then the oldest. */
export function addInflight(network: string, record: InflightDeposit): void {
  let list = [...listInflight(network).filter((r) => r.baseTxHash !== record.baseTxHash), record];
  while (list.length > INFLIGHT_MAX) {
    const drop = list.find(finished) ?? list[0];
    list = list.filter((r) => r !== drop);
  }
  write(network, list);
}

export function updateInflight(network: string, baseTxHash: string, patch: Partial<InflightDeposit>): void {
  const list = listInflight(network);
  if (!list.some((r) => r.baseTxHash === baseTxHash)) return;
  write(
    network,
    list.map((r) => (r.baseTxHash === baseTxHash ? { ...r, ...patch } : r)),
  );
}

export function markCredited(network: string, baseTxHash: string, creditTxId?: string): void {
  updateInflight(network, baseTxHash, { state: "credited", finishedAt: Date.now(), ...(creditTxId ? { creditTxId } : {}) });
}

/** Hide a record from the page. */
export function dismissInflight(network: string, baseTxHash: string): void {
  updateInflight(network, baseTxHash, { dismissed: true, finishedAt: Date.now() });
}

/** Forget a deposit whose Base transaction reverted. */
export function removeInflight(network: string, baseTxHash: string): void {
  const list = listInflight(network);
  if (list.some((r) => r.baseTxHash === baseTxHash)) {
    write(
      network,
      list.filter((r) => r.baseTxHash !== baseTxHash),
    );
  }
}

/**
 * Pair waiting deposits with credits in the wallet's bridge history: same symbol, same amount, and
 * a block time at or after the deposit was sent (minus clock skew). One credit pays one deposit —
 * oldest deposit to oldest credit — and a credit already taken by a record is never used again.
 * History amounts are display strings, so amounts are compared as the history formats them.
 */
export function matchCredits(records: InflightDeposit[], history: BridgeHistoryEntry[]): { baseTxHash: string; creditTxId: string }[] {
  const taken = new Set(records.map((r) => r.creditTxId).filter((id): id is string => !!id));
  const credits = history.filter((e) => e.direction === "deposit" && e.status === "completed").sort((a, b) => a.timestamp - b.timestamp);
  const out: { baseTxHash: string; creditTxId: string }[] = [];
  for (const r of [...records].sort((a, b) => a.startedAt - b.startedAt)) {
    if (r.state !== "sent" || r.dismissed) continue;
    const amount = formatTokenAmount(Number(r.expectedL1Units), r.l1Symbol);
    const hit = credits.find((e) => !taken.has(e.id) && e.symbol === r.l1Symbol && e.amount === amount && e.timestamp >= r.startedAt - INFLIGHT_SKEW_MS);
    if (!hit) continue;
    taken.add(hit.id);
    out.push({ baseTxHash: r.baseTxHash, creditTxId: hit.id });
  }
  return out;
}
