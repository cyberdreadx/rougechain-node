/**
 * DEX data + writes for site-next, against the ACTIVE network's node (core `network`).
 *
 * Reads are the same GETs / quote POST apps/web's Swap, Pools and PoolDetail pages make.
 * Writes go ONLY through @rougechain/core's secure-api (`secureSwap`, `secureCreatePool`,
 * `secureAddLiquidity`, `secureRemoveLiquidity`): signed in the browser with the local ML-DSA-65
 * key, or by the RougeChain extension / Qwalla when the wallet has no local private key, then
 * POSTed to the node's /v2/... endpoints. No payload is built here.
 */
import { getCoreApiBaseUrl, getCoreApiHeaders } from "@rougechain/core/network";
import { secureAddLiquidity, secureCreatePool, secureRemoveLiquidity, secureSwap } from "@rougechain/core/secure-api";
import { canCollect, computeLpEarnings, type LpEarnings, type LpPoolEvent } from "@rougechain/core/lp-earnings";
import type { PoolReserves } from "./amm";
import i18n from "../i18n";

export interface Pool extends PoolReserves {
  fee_rate: number;
  created_at?: number;
  creator_pub_key?: string;
}

export interface SwapQuote {
  success: boolean;
  amount_out: number;
  price_impact: number;
  path: string[];
  pools: string[];
}

export interface PriceSnapshot {
  pool_id: string;
  timestamp: number;
  block_height: number;
  reserve_a: number;
  reserve_b: number;
  price_a_in_b: number;
  price_b_in_a: number;
}

export interface PoolEvent extends LpPoolEvent {
  pool_id: string;
  tx_hash: string;
  token_in?: string;
  token_out?: string;
  amount_in?: number;
  amount_out?: number;
  amount_a?: number;
  amount_b?: number;
}

export interface PoolStats {
  pool_id: string;
  total_swaps: number;
  total_volume_a: number;
  total_volume_b: number;
  swap_count_24h: number;
  volume_24h_a: number;
  volume_24h_b: number;
}

/** Raw balances of one account: XRGE, tokens and LP positions (GET /balance/:pubkey). */
export interface DexBalances {
  xrge: number;
  tokens: Record<string, number>;
  lp: Record<string, number>;
}

export type { LpEarnings };
export { canCollect };

/** Keys that can sign: a local key, or "" to sign through the extension (core decides). */
export interface SigningWallet {
  signingPublicKey: string;
  signingPrivateKey: string;
}

const base = () => getCoreApiBaseUrl();
const headers = () => getCoreApiHeaders();

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${base()}${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`${i18n.t("swap:errors.node")} (${res.status})`);
  return (await res.json()) as T;
}

export async function fetchPools(): Promise<Pool[]> {
  const data = await getJson<{ pools?: Pool[] }>("/pools");
  return Array.isArray(data?.pools) ? data.pools : [];
}

/** One pool, or null when the node doesn't know it (404 / empty). */
export async function fetchPool(poolId: string): Promise<Pool | null> {
  const res = await fetch(`${base()}/pool/${encodeURIComponent(poolId)}`, { headers: headers() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${i18n.t("swap:errors.node")} (${res.status})`);
  const data = (await res.json()) as { pool?: Pool | null };
  return data?.pool ?? null;
}

export async function fetchPoolPrices(poolId: string): Promise<PriceSnapshot[]> {
  const data = await getJson<{ prices?: PriceSnapshot[] }>(`/pool/${encodeURIComponent(poolId)}/prices`);
  return Array.isArray(data?.prices) ? data.prices : [];
}

export async function fetchPoolEvents(poolId: string, limit?: number): Promise<PoolEvent[]> {
  const q = limit ? `?limit=${limit}` : "";
  const data = await getJson<{ events?: PoolEvent[] }>(`/pool/${encodeURIComponent(poolId)}/events${q}`);
  return Array.isArray(data?.events) ? data.events : [];
}

export async function fetchPoolStats(poolId: string): Promise<PoolStats | null> {
  const data = await getJson<{ stats?: PoolStats | null }>(`/pool/${encodeURIComponent(poolId)}/stats`);
  return data?.stats ?? null;
}

export async function fetchBalances(publicKey: string): Promise<DexBalances> {
  const data = await getJson<{ balance?: number; token_balances?: Record<string, number>; lp_balances?: Record<string, number> }>(
    `/balance/${publicKey}`,
  );
  return { xrge: data?.balance || 0, tokens: data?.token_balances || {}, lp: data?.lp_balances || {} };
}

export type QuoteResult = { ok: true; quote: SwapQuote } | { ok: false; error: string };

/** POST /swap/quote with the raw amount — the node routes (multi-hop) and prices it. */
export async function fetchQuote(tokenIn: string, tokenOut: string, amountInRaw: number, signal?: AbortSignal): Promise<QuoteResult> {
  const res = await fetch(`${base()}/swap/quote`, {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ token_in: tokenIn, token_out: tokenOut, amount_in: amountInRaw }),
    signal,
  });
  let data: Partial<SwapQuote> & { error?: string } = {};
  try {
    data = await res.json();
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok || !data.success || typeof data.amount_out !== "number") {
    return { ok: false, error: data.error || i18n.t("swap:swap.noRoute") };
  }
  return {
    ok: true,
    quote: {
      success: true,
      amount_out: data.amount_out,
      price_impact: Number(data.price_impact) || 0,
      path: Array.isArray(data.path) ? data.path : [tokenIn, tokenOut],
      pools: Array.isArray(data.pools) ? data.pools : [],
    },
  };
}

/**
 * Uncollected swap fees of `owner` in `pool` — the node's fee ledger first
 * (GET /pool/:id/earnings/:owner), then, for older nodes, a replay of the pool's events in the
 * browser (core `computeLpEarnings`). null = the position can't be explained (as apps/web).
 */
export async function fetchEarnings(pool: Pool, owner: string, userLp: number): Promise<LpEarnings | null> {
  const direct = await fetch(`${base()}/pool/${encodeURIComponent(pool.pool_id)}/earnings/${encodeURIComponent(owner)}`, {
    headers: headers(),
  });
  if (direct.ok) {
    const e = ((await direct.json()) as { earnings?: (LpEarnings & { tracked?: boolean }) | null })?.earnings;
    return e?.tracked ? { lpToCollect: e.lpToCollect, earnedA: e.earnedA, earnedB: e.earnedB, growth: e.growth } : null;
  }
  const events = await fetchPoolEvents(pool.pool_id, 5000);
  return computeLpEarnings(events, pool, [owner], userLp);
}

// ---------- writes (core secure-api only) ----------

type CoreResult = { success: boolean; error?: string; data?: unknown };

function unwrap<T = unknown>(r: CoreResult, fallback: string): T | undefined {
  if (!r.success) throw new Error(r.error || fallback);
  return r.data as T | undefined;
}

export async function submitSwap(w: SigningWallet, tokenIn: string, tokenOut: string, amountInRaw: number, minOutRaw: number) {
  const r = await secureSwap(w.signingPublicKey, w.signingPrivateKey, tokenIn, tokenOut, amountInRaw, minOutRaw);
  return unwrap(r, i18n.t("swap:toasts.swapFailed"));
}

export async function submitCreatePool(w: SigningWallet, tokenA: string, tokenB: string, amountARaw: number, amountBRaw: number) {
  const r = await secureCreatePool(w.signingPublicKey, w.signingPrivateKey, tokenA, tokenB, amountARaw, amountBRaw);
  return unwrap<{ pool_id?: string }>(r, i18n.t("swap:toasts.createFailed"));
}

export async function submitAddLiquidity(w: SigningWallet, poolId: string, amountARaw: number, amountBRaw: number) {
  const r = await secureAddLiquidity(w.signingPublicKey, w.signingPrivateKey, poolId, amountARaw, amountBRaw);
  return unwrap(r, i18n.t("swap:toasts.addFailed"));
}

export async function submitRemoveLiquidity(w: SigningWallet, poolId: string, lpAmount: number) {
  const r = await secureRemoveLiquidity(w.signingPublicKey, w.signingPrivateKey, poolId, lpAmount);
  return unwrap(r, i18n.t("swap:toasts.removeFailed"));
}

/** Collect fees = remove exactly the LP tokens fees have added (apps/web handleCollectFees). */
export async function submitCollectFees(w: SigningWallet, poolId: string, earned: LpEarnings) {
  if (!canCollect(earned)) throw new Error(i18n.t("swap:pools.nothingToCollect"));
  const r = await secureRemoveLiquidity(w.signingPublicKey, w.signingPrivateKey, poolId, earned.lpToCollect);
  return unwrap(r, i18n.t("swap:toasts.collectFailed"));
}
