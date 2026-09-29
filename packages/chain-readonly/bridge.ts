/**
 * Bridge activity: strict normalizers for the node's public bridge reads, external-explorer links
 * (BaseScan / Base Sepolia / mempool.space), and the fallback that rebuilds the list from on-chain
 * bridge transactions while a node does not serve /bridge/activity yet.
 *
 * Nothing here invents data: a hash, address or status the node did not report stays null (or
 * "unknown"), and every external URL is built only from a value that passed its format check.
 */
import { BRIDGE_CURSOR, HASH64, ROUGE1, TOKEN_SYMBOL } from "./allowlist";
import { toRougeAddress } from "./format";
import type { NetworkId } from "./network";
import {
  NotFoundError,
  obj,
  ShapeError,
  text,
  uint,
  type TxView,
} from "./normalize";

// ─── Model ───────────────────────────────────────────────────────────────────

export type BridgeKind = "deposit" | "withdrawal";
/** Node statuses, plus "completed" which only the on-chain fallback uses. */
export type BridgeStatus =
  | "pending"
  | "queued"
  | "paid"
  | "failed"
  | "refunded"
  | "unknown"
  | "completed";
export type BridgeChain =
  | "rougechain"
  | "base"
  | "base-sepolia"
  | "bitcoin"
  | "bitcoin-testnet"
  | "unknown";
export type BridgeStatusReason =
  | "in_mempool"
  | "rejected_on_chain"
  | "awaiting_payout"
  | "payout_retrying"
  | "payout_verified"
  | "refunded_on_rougechain"
  | "no_payout_record"
  | "minted"
  // fallback only
  | "not_in_payout_queue"
  | "in_block"
  | "payout_lists_unavailable";

export interface BridgeTransfer {
  kind: BridgeKind;
  /** Token on RougeChain (qETH, qUSDC, qBTC, XRGE). */
  asset: string;
  /** Asset on the external chain (ETH, USDC, BTC, XRGE), or null. */
  externalAsset: string | null;
  /** Raw on-chain units. */
  amountUnits: number;
  decimals: number | null;
  fromChain: BridgeChain;
  toChain: BridgeChain;
  rougechainTxId: string;
  /** rouge1 address of the withdrawal sender / deposit recipient. */
  rougechainAddress: string | null;
  blockHeight: number | null;
  /** "8453" | "84532" | "bitcoin" | null */
  externalChainId: string | null;
  /** "base" | "base-sepolia" | "mainnet" | "testnet" | "signet" | null */
  externalNetwork: string | null;
  externalAddress: string | null;
  externalTxHash: string | null;
  status: BridgeStatus;
  statusReason: BridgeStatusReason;
  timestamp: number | null;
  statusUpdatedAt: number | null;
  cursor: string | null;
  /** "node": /bridge/activity. "chain": rebuilt from on-chain txs (fallback). */
  source: "node" | "chain";
}

const KINDS = ["deposit", "withdrawal"] as const;
const NODE_STATUSES = [
  "pending",
  "queued",
  "paid",
  "failed",
  "refunded",
  "unknown",
] as const;
const CHAINS = [
  "rougechain",
  "base",
  "base-sepolia",
  "bitcoin",
  "bitcoin-testnet",
  "unknown",
] as const;
const NODE_REASONS = [
  "in_mempool",
  "rejected_on_chain",
  "awaiting_payout",
  "payout_retrying",
  "payout_verified",
  "refunded_on_rougechain",
  "no_payout_record",
  "minted",
] as const;
const EXTERNAL_ASSETS = ["ETH", "USDC", "BTC", "XRGE"] as const;
const EXTERNAL_CHAIN_IDS = ["8453", "84532", "bitcoin"] as const;
const EXTERNAL_NETWORKS = [
  "base",
  "base-sepolia",
  "mainnet",
  "testnet",
  "signet",
] as const;

export const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const EVM_TX_HASH = /^0x[0-9a-fA-F]{64}$/;
export const BTC_TXID = /^[0-9a-f]{64}$/;
/** Bech32 (bc1/tb1/bcrt1) or base58 (1…/3…/m…/n…/2…) Bitcoin address. */
export const BTC_ADDRESS =
  /^((bc|tb|bcrt)1[02-9ac-hj-np-z]{8,87}|[13mn2][1-9A-HJ-NP-Za-km-z]{25,39})$/;

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  what: string,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value))
    throw new ShapeError(what);
  return value as T;
}
function nullable<T>(value: unknown, read: (v: unknown) => T): T | null {
  return value === null || value === undefined ? null : read(value);
}
function matching(value: unknown, re: RegExp, what: string): string {
  const s = text(value, what);
  if (!re.test(s)) throw new ShapeError(what);
  return s;
}

// ─── Node: /bridge/activity and /bridge/activity/:txId ───────────────────────

export function normalizeBridgeActivityItem(
  raw: unknown,
  what = "bridge activity item",
): BridgeTransfer {
  const r = obj(raw, what);
  const f = (k: string) => `${what}.${k}`;
  const btc = r.externalChainId === "bitcoin";
  const decimals = nullable(r.decimals, (v) => uint(v, f("decimals")));
  if (decimals !== null && decimals > 18) throw new ShapeError(f("decimals"));
  return {
    kind: oneOf(r.kind, KINDS, f("kind")),
    asset: matching(r.asset, TOKEN_SYMBOL, f("asset")),
    externalAsset: nullable(r.externalAsset, (v) =>
      oneOf(v, EXTERNAL_ASSETS, f("externalAsset")),
    ),
    amountUnits: uint(r.amountUnits, f("amountUnits")),
    decimals,
    fromChain: oneOf(r.fromChain, CHAINS, f("fromChain")),
    toChain: oneOf(r.toChain, CHAINS, f("toChain")),
    rougechainTxId: matching(r.rougechainTxId, HASH64, f("rougechainTxId")),
    rougechainAddress: nullable(r.rougechainAddress, (v) =>
      matching(v, ROUGE1, f("rougechainAddress")),
    ),
    blockHeight: nullable(r.blockHeight, (v) => uint(v, f("blockHeight"))),
    externalChainId: nullable(r.externalChainId, (v) =>
      oneOf(v, EXTERNAL_CHAIN_IDS, f("externalChainId")),
    ),
    externalNetwork: nullable(r.externalNetwork, (v) =>
      oneOf(v, EXTERNAL_NETWORKS, f("externalNetwork")),
    ),
    externalAddress: nullable(r.externalAddress, (v) =>
      matching(v, btc ? BTC_ADDRESS : EVM_ADDRESS, f("externalAddress")),
    ),
    externalTxHash: nullable(r.externalTxHash, (v) =>
      matching(v, btc ? BTC_TXID : EVM_TX_HASH, f("externalTxHash")),
    ),
    status: oneOf(r.status, NODE_STATUSES, f("status")),
    statusReason: oneOf(r.statusReason, NODE_REASONS, f("statusReason")),
    timestamp: nullable(r.timestamp, (v) => uint(v, f("timestamp"))),
    statusUpdatedAt: nullable(r.statusUpdatedAt, (v) =>
      uint(v, f("statusUpdatedAt")),
    ),
    cursor: nullable(r.cursor, (v) => matching(v, BRIDGE_CURSOR, f("cursor"))),
    source: "node",
  };
}

export interface BridgeActivityNodePage {
  items: BridgeTransfer[];
  nextCursor: string | null;
}

export function normalizeBridgeActivityPage(
  raw: unknown,
): BridgeActivityNodePage {
  const r = obj(raw, "bridge activity");
  if (!Array.isArray(r.items)) throw new ShapeError("bridge activity.items");
  return {
    items: r.items.map((it, i) =>
      normalizeBridgeActivityItem(it, `bridge activity.items[${i}]`),
    ),
    nextCursor: nullable(r.nextCursor, (v) =>
      matching(v, BRIDGE_CURSOR, "bridge activity.nextCursor"),
    ),
  };
}

// ─── /bridge/config ──────────────────────────────────────────────────────────

export interface BridgeConfig {
  enabled: boolean;
  /** 8453 (Base) / 84532 (Base Sepolia), or null when the node has none configured. */
  chainId: 8453 | 84532 | null;
  btcNetwork: "mainnet" | "testnet" | "signet" | null;
  supportedTokens: string[];
}

export function normalizeBridgeConfig(raw: unknown): BridgeConfig {
  const r = obj(raw, "bridge config");
  if (typeof r.enabled !== "boolean") throw new ShapeError("bridge config.enabled");
  const chainId = nullable(r.chainId, (v) => {
    if (v !== 8453 && v !== 84532) throw new ShapeError("bridge config.chainId");
    return v as 8453 | 84532;
  });
  if (!Array.isArray(r.supportedTokens))
    throw new ShapeError("bridge config.supportedTokens");
  return {
    enabled: r.enabled,
    chainId,
    btcNetwork: nullable(r.btcNetwork, (v) =>
      oneOf(v, ["mainnet", "testnet", "signet"] as const, "bridge config.btcNetwork"),
    ),
    supportedTokens: r.supportedTokens.map((t) =>
      matching(t, TOKEN_SYMBOL, "bridge config.supportedTokens"),
    ),
  };
}

// ─── Pending payout lists (fallback) ─────────────────────────────────────────

export interface PendingPayout {
  txId: string;
  status: "pending" | "failed";
}
export interface PendingPayoutList {
  items: PendingPayout[];
  /** The node refused the list (derived bridge state degraded): statuses are unknown. */
  degraded: boolean;
}

/**
 * /bridge/withdrawals and /bridge/btc/withdrawals (camelCase) and /bridge/xrge/withdrawals
 * (snake_case, "xrge:"-prefixed ids). Only the id and the coarse status are kept.
 */
export function normalizeBridgeWithdrawals(
  raw: unknown,
  what = "bridge withdrawals",
): PendingPayoutList {
  const r = obj(raw, what);
  if (!Array.isArray(r.withdrawals)) throw new ShapeError(`${what}.withdrawals`);
  const degraded = r.degraded === true;
  return {
    degraded,
    items: r.withdrawals.map((w, i) => {
      const o = obj(w, `${what}[${i}]`);
      const rawId = text(o.txId ?? o.tx_id, `${what}[${i}].txId`);
      const txId = rawId.startsWith("xrge:") ? rawId.slice(5) : rawId;
      if (!HASH64.test(txId)) throw new ShapeError(`${what}[${i}].txId`);
      return {
        txId,
        status: oneOf(o.status, ["pending", "failed"] as const, `${what}[${i}].status`),
      };
    }),
  };
}

// ─── Assets and chains ───────────────────────────────────────────────────────

interface AssetInfo {
  externalAsset: string;
  decimals: number;
  family: "base" | "bitcoin";
}
const BRIDGE_ASSETS: Readonly<Record<string, AssetInfo>> = Object.freeze({
  QETH: { externalAsset: "ETH", decimals: 6, family: "base" },
  QUSDC: { externalAsset: "USDC", decimals: 6, family: "base" },
  XRGE: { externalAsset: "XRGE", decimals: 0, family: "base" },
  QBTC: { externalAsset: "BTC", decimals: 8, family: "bitcoin" },
});

export function bridgeAsset(symbol: string): AssetInfo | null {
  return BRIDGE_ASSETS[symbol.toUpperCase()] ?? null;
}

/** Which external chain family an item belongs to. */
export function chainFamily(t: BridgeTransfer): "base" | "bitcoin" | null {
  if (t.externalChainId === "bitcoin") return "bitcoin";
  if (t.externalChainId === "8453" || t.externalChainId === "84532")
    return "base";
  return bridgeAsset(t.asset)?.family ?? null;
}

export const CHAIN_LABELS: Readonly<Record<BridgeChain, string>> =
  Object.freeze({
    rougechain: "RougeChain",
    base: "Base",
    "base-sepolia": "Base Sepolia",
    bitcoin: "Bitcoin",
    "bitcoin-testnet": "Bitcoin testnet",
    unknown: "Unknown chain",
  });

export function directionLabel(t: BridgeTransfer): string {
  return `${CHAIN_LABELS[t.fromChain]} → ${CHAIN_LABELS[t.toChain]}`;
}

// ─── Status labels ───────────────────────────────────────────────────────────

export const STATUS_LABELS: Readonly<Record<BridgeStatus, string>> =
  Object.freeze({
    pending: "Pending",
    queued: "Queued",
    paid: "Paid",
    failed: "Failed",
    refunded: "Refunded",
    unknown: "Unknown",
    completed: "Completed",
  });

/** Pill tone for the design system's status colours. */
export function statusTone(
  status: BridgeStatus,
): "good" | "wait" | "bad" | "neutral" {
  switch (status) {
    case "paid":
    case "completed":
      return "good";
    case "pending":
    case "queued":
      return "wait";
    case "failed":
      return "bad";
    default:
      return "neutral";
  }
}

export function statusLabel(t: Pick<BridgeTransfer, "status" | "kind">) {
  if (t.status === "paid" && t.kind === "deposit") return "Minted";
  return STATUS_LABELS[t.status];
}

export const STATUS_EXPLANATIONS: Readonly<Record<BridgeStatusReason, string>> =
  Object.freeze({
    in_mempool: "Submitted to RougeChain, not in a block yet.",
    rejected_on_chain:
      "RougeChain rejected this transaction; nothing was burned or minted.",
    awaiting_payout:
      "Accepted on RougeChain and waiting in the relayer's payout queue.",
    payout_retrying:
      "Payout attempts have failed so far; the relayer retries or refunds.",
    payout_verified: "Paid out; the payout was verified on the external chain.",
    refunded_on_rougechain:
      "The payout could not complete; the tokens were minted back on RougeChain.",
    no_payout_record:
      "The node holds no payout record for this withdrawal (for example, from before the payout store existed).",
    minted: "Minted on RougeChain.",
    not_in_payout_queue:
      "No longer in the node's pending-payout list (paid or refunded). Details need the node update.",
    in_block: "Included in a RougeChain block.",
    payout_lists_unavailable:
      "The node's pending-payout lists could not be read, so the payout status is unknown.",
  });

// ─── External explorer links ─────────────────────────────────────────────────

export interface LinkContext {
  /** RougeChain network being viewed: the default when the node reports no external chain. */
  network: NetworkId;
  /** From /bridge/config. */
  baseChainId?: 8453 | 84532 | null;
  btcNetwork?: "mainnet" | "testnet" | "signet" | null;
}

export interface ExternalExplorer {
  name: string;
  base: string;
}

function baseChainFor(t: BridgeTransfer, ctx: LinkContext): 8453 | 84532 {
  if (t.externalChainId === "8453") return 8453;
  if (t.externalChainId === "84532") return 84532;
  if (t.externalNetwork === "base") return 8453;
  if (t.externalNetwork === "base-sepolia") return 84532;
  if (ctx.baseChainId) return ctx.baseChainId;
  // RougeChain mainnet bridges Base mainnet; testnet bridges Base Sepolia.
  return ctx.network === "mainnet" ? 8453 : 84532;
}

function btcNetworkFor(
  t: BridgeTransfer,
  ctx: LinkContext,
): "mainnet" | "testnet" | "signet" {
  if (
    t.externalNetwork === "mainnet" ||
    t.externalNetwork === "testnet" ||
    t.externalNetwork === "signet"
  )
    return t.externalNetwork;
  if (ctx.btcNetwork) return ctx.btcNetwork;
  return ctx.network === "mainnet" ? "mainnet" : "testnet";
}

export function baseScan(chainId: 8453 | 84532): ExternalExplorer {
  return chainId === 8453
    ? { name: "BaseScan", base: "https://basescan.org" }
    : { name: "BaseScan (Sepolia)", base: "https://sepolia.basescan.org" };
}

export function mempoolSpace(
  network: "mainnet" | "testnet" | "signet",
): ExternalExplorer {
  if (network === "mainnet")
    return { name: "mempool.space", base: "https://mempool.space" };
  return {
    name: `mempool.space (${network})`,
    base: `https://mempool.space/${network}`,
  };
}

export function externalExplorer(
  t: BridgeTransfer,
  ctx: LinkContext,
): ExternalExplorer | null {
  const family = chainFamily(t);
  if (family === "base") return baseScan(baseChainFor(t, ctx));
  if (family === "bitcoin") return mempoolSpace(btcNetworkFor(t, ctx));
  return null;
}

/** Explorer URL for the external tx, only for a hash in its chain's exact format. */
export function externalTxUrl(t: BridgeTransfer, ctx: LinkContext): string | null {
  const hash = t.externalTxHash;
  const ex = externalExplorer(t, ctx);
  if (!hash || !ex) return null;
  const ok = chainFamily(t) === "bitcoin" ? BTC_TXID.test(hash) : EVM_TX_HASH.test(hash);
  return ok ? `${ex.base}/tx/${hash}` : null;
}

export function externalAddressUrl(
  t: BridgeTransfer,
  ctx: LinkContext,
): string | null {
  const addr = t.externalAddress;
  const ex = externalExplorer(t, ctx);
  if (!addr || !ex) return null;
  const ok =
    chainFamily(t) === "bitcoin" ? BTC_ADDRESS.test(addr) : EVM_ADDRESS.test(addr);
  return ok ? `${ex.base}/address/${addr}` : null;
}

/** Why an item has no external tx link — always a true statement. */
export function missingExternalTxReason(t: BridgeTransfer): string {
  if (t.kind === "deposit")
    return "Source transaction not recorded by the node";
  if (t.source === "chain") return "External tx link available after node update";
  if (t.status === "refunded") return "No payout (refunded)";
  if (t.status === "failed" && t.statusReason === "rejected_on_chain")
    return "No payout (rejected on RougeChain)";
  if (t.status === "paid") return "Payout hash not recorded by the node";
  if (t.status === "unknown") return "Payout not recorded by the node";
  return "Not paid out yet";
}

// ─── Fallback: rebuild from on-chain bridge transactions ─────────────────────

/** txId → pending payout status, or null when the lists could not be read. */
export type PendingIndex = ReadonlyMap<string, PendingPayout["status"]> | null;

export function pendingIndex(lists: PendingPayoutList[] | null): PendingIndex {
  if (!lists || lists.some((l) => l.degraded)) return null;
  const map = new Map<string, PendingPayout["status"]>();
  for (const l of lists) for (const w of l.items) map.set(w.txId, w.status);
  return map;
}

function fallbackChain(
  family: "base" | "bitcoin" | null,
  ctx: LinkContext,
): BridgeChain {
  if (family === "base")
    return ctx.baseChainId === 84532 ||
      (!ctx.baseChainId && ctx.network === "testnet")
      ? "base-sepolia"
      : "base";
  if (family === "bitcoin")
    return ctx.btcNetwork === "testnet" ||
      ctx.btcNetwork === "signet" ||
      (!ctx.btcNetwork && ctx.network === "testnet")
      ? "bitcoin-testnet"
      : "bitcoin";
  return "unknown";
}

/**
 * A bridge transfer from an on-chain transaction, for nodes without /bridge/activity. Only what
 * the transaction and the pending-payout lists say: never a payout hash, never a source hash.
 */
export function bridgeTransferFromTx(
  tx: TxView,
  pending: PendingIndex,
  ctx: LinkContext,
): BridgeTransfer | null {
  const kind: BridgeKind | null =
    tx.type === "bridge_withdraw"
      ? "withdrawal"
      : tx.type === "bridge_mint"
        ? "deposit"
        : null;
  if (!kind || tx.amount === null || !Number.isSafeInteger(tx.amount) || tx.amount <= 0)
    return null;
  if (!TOKEN_SYMBOL.test(tx.symbol)) return null;
  const asset = bridgeAsset(tx.symbol);
  const external = fallbackChain(asset?.family ?? null, ctx);
  const party = kind === "withdrawal" ? tx.from : tx.to;
  let rougechainAddress: string | null = null;
  try {
    rougechainAddress = party ? toRougeAddress(party) : null;
  } catch {
    rougechainAddress = null;
  }
  const dest =
    kind === "withdrawal" && typeof tx.payload.evm_address === "string"
      ? tx.payload.evm_address.trim()
      : null;
  const destOk =
    dest !== null &&
    (asset?.family === "bitcoin" ? BTC_ADDRESS.test(dest) : EVM_ADDRESS.test(dest));
  let status: BridgeStatus;
  let statusReason: BridgeStatusReason;
  if (kind === "deposit") {
    status = "completed";
    statusReason = "in_block";
  } else if (pending === null) {
    status = "unknown";
    statusReason = "payout_lists_unavailable";
  } else {
    const p = pending.get(tx.id);
    if (p === "failed") {
      status = "failed";
      statusReason = "payout_retrying";
    } else if (p === "pending") {
      status = "pending";
      statusReason = "awaiting_payout";
    } else {
      status = "completed";
      statusReason = "not_in_payout_queue";
    }
  }
  return {
    kind,
    asset: tx.symbol,
    externalAsset: asset?.externalAsset ?? null,
    amountUnits: tx.amount,
    decimals: asset?.decimals ?? null,
    fromChain: kind === "withdrawal" ? "rougechain" : external,
    toChain: kind === "withdrawal" ? external : "rougechain",
    rougechainTxId: tx.id,
    rougechainAddress,
    blockHeight: tx.blockHeight,
    externalChainId: null,
    externalNetwork: null,
    externalAddress: destOk ? dest : null,
    externalTxHash: null,
    status,
    statusReason,
    timestamp: tx.blockTime,
    statusUpdatedAt: null,
    cursor: null,
    source: "chain",
  };
}

// ─── Reading (node first, fallback on 404) ───────────────────────────────────

/** The subset of the read client this module uses (keeps the import one-directional). */
export interface BridgeReads {
  network: NetworkId;
  bridgeConfig: () => Promise<BridgeConfig>;
  bridgeActivity: (limit: number, before?: string) => Promise<BridgeActivityNodePage>;
  bridgeActivityItem: (txId: string) => Promise<BridgeTransfer>;
  bridgeWithdrawals: () => Promise<PendingPayoutList>;
  bridgeBtcWithdrawals: () => Promise<PendingPayoutList>;
  bridgeXrgeWithdrawals: () => Promise<PendingPayoutList>;
  txs: (limit: number, offset?: number) => Promise<{ txs: TxView[]; total: number }>;
  tx: (hash: string) => Promise<TxView>;
}

export interface BridgeActivityView {
  source: "node" | "chain";
  items: BridgeTransfer[];
  /** Node mode: cursor for the next (older) page. */
  nextCursor: string | null;
  config: BridgeConfig | null;
  /** Fallback: how many recent transactions were scanned. */
  scanned?: number;
  /** Fallback: whether the pending-payout lists could be read. */
  pendingListsRead?: boolean;
}

export const FALLBACK_PAGE_SIZE = 200;
export const FALLBACK_MAX_PAGES = 5;

async function optionalConfig(c: BridgeReads): Promise<BridgeConfig | null> {
  try {
    return await c.bridgeConfig();
  } catch {
    return null;
  }
}

export function linkContext(
  network: NetworkId,
  config: BridgeConfig | null,
): LinkContext {
  return {
    network,
    baseChainId: config?.chainId ?? null,
    btcNetwork: config?.btcNetwork ?? null,
  };
}

async function readPending(c: BridgeReads): Promise<PendingIndex> {
  try {
    const lists = await Promise.all([
      c.bridgeWithdrawals(),
      c.bridgeBtcWithdrawals(),
      c.bridgeXrgeWithdrawals(),
    ]);
    return pendingIndex(lists);
  } catch {
    return null;
  }
}

/** Recent transactions (the node's latest-500-block index), newest first, a bounded number of pages. */
async function recentTxs(c: BridgeReads): Promise<TxView[]> {
  const out: TxView[] = [];
  for (let page = 0; page < FALLBACK_MAX_PAGES; page++) {
    const r = await c.txs(FALLBACK_PAGE_SIZE, page * FALLBACK_PAGE_SIZE);
    out.push(...r.txs);
    if (r.txs.length < FALLBACK_PAGE_SIZE || out.length >= r.total) break;
  }
  return out;
}

export async function readBridgeActivity(
  c: BridgeReads,
  { limit, before }: { limit: number; before?: string },
): Promise<BridgeActivityView> {
  const configRead = optionalConfig(c);
  try {
    const page = await c.bridgeActivity(limit, before);
    return { source: "node", ...page, config: await configRead };
  } catch (e) {
    if (!(e instanceof NotFoundError)) throw e;
  }
  const [txs, pending, config] = await Promise.all([
    recentTxs(c),
    readPending(c),
    configRead,
  ]);
  const ctx = linkContext(c.network, config);
  const seen = new Set<string>();
  const items: BridgeTransfer[] = [];
  for (const tx of txs) {
    if (seen.has(tx.id)) continue;
    seen.add(tx.id);
    const t = bridgeTransferFromTx(tx, pending, ctx);
    if (t) items.push(t);
  }
  items.sort(
    (a, b) =>
      (b.blockHeight ?? 0) - (a.blockHeight ?? 0) ||
      (b.timestamp ?? 0) - (a.timestamp ?? 0),
  );
  return {
    source: "chain",
    items,
    nextCursor: null,
    config,
    scanned: txs.length,
    pendingListsRead: pending !== null,
  };
}

export interface BridgeTransferView {
  transfer: BridgeTransfer;
  config: BridgeConfig | null;
}

/**
 * One transfer by RougeChain tx id. Node first; on 404 the tx itself is read and, if it is a
 * bridge transaction, rebuilt from chain data. A non-bridge tx is NotFound.
 */
export async function readBridgeTransfer(
  c: BridgeReads,
  txId: string,
): Promise<BridgeTransferView> {
  const configRead = optionalConfig(c);
  try {
    return { transfer: await c.bridgeActivityItem(txId), config: await configRead };
  } catch (e) {
    if (!(e instanceof NotFoundError)) throw e;
  }
  const tx = await c.tx(txId);
  if (tx.type !== "bridge_withdraw" && tx.type !== "bridge_mint")
    throw new NotFoundError("Not a bridge transaction");
  const [pending, config] = await Promise.all([
    tx.type === "bridge_withdraw" ? readPending(c) : Promise.resolve(new Map()),
    configRead,
  ]);
  const transfer = bridgeTransferFromTx(tx, pending, linkContext(c.network, config));
  if (!transfer) throw new NotFoundError("Not a bridge transaction");
  return { transfer, config };
}

