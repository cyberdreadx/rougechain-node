import type { WalletTransaction } from "./pqc-wallet";

/**
 * Detection of incoming transfers for the web wallet's "Received X from Y" toast.
 *
 * A transfer's `to` is the recipient AS SUBMITTED — the rouge1 address or the signing public key
 * hex — so "mine" is a set of ids (both forms), compared case-insensitively.
 */

/** Lower-cased id set for matching `to` / `from`. */
export function idSet(ids: Array<string | null | undefined>): Set<string> {
  return new Set(ids.filter((x): x is string => !!x).map((x) => x.toLowerCase()));
}

/**
 * Stable identity of a history entry. The history's `txHash` is the block hash (shared by all txs
 * in a block), so the transfer's own fields are part of the key.
 */
export function txKey(tx: Pick<WalletTransaction, "txHash" | "from" | "to" | "symbol" | "amount" | "timestamp">): string {
  return [tx.txHash, tx.from ?? "", tx.to ?? "", tx.symbol, tx.amount, tx.timestamp].join("|");
}

/**
 * Transfers in `txs` not yet in `seen` that were sent TO me by someone else, no older than
 * `sinceMs`. Every entry is added to `seen` (so each is reported at most once).
 */
export function findNewIncoming(
  txs: WalletTransaction[],
  seen: Set<string>,
  mine: Set<string>,
  sinceMs: number,
): WalletTransaction[] {
  const out: WalletTransaction[] = [];
  for (const tx of txs) {
    const key = txKey(tx);
    if (seen.has(key)) continue;
    seen.add(key);
    if (tx.type !== "receive") continue; // sends, swaps, stakes, LP, NFTs, bridge ops…
    if (!tx.to || !mine.has(tx.to.toLowerCase())) continue; // e.g. validator fee credits
    if (tx.from && mine.has(tx.from.toLowerCase())) continue; // my own send to myself
    if (tx.timestamp < sinceMs) continue;
    out.push(tx);
  }
  return out;
}

/** Whether a websocket NewTransaction frame is a transfer to me from someone else. */
export function isIncomingFrame(frame: { from: string; to: string | null }, mine: Set<string>): boolean {
  if (!frame.to || !mine.has(frame.to.toLowerCase())) return false;
  return !mine.has((frame.from || "").toLowerCase());
}
