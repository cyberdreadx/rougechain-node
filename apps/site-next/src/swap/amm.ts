/**
 * Pure DEX math, lifted from apps/web's Swap / Pools / PoolDetail pages so both sites show the
 * same numbers. Swap quotes themselves come from the node (`POST /swap/quote`), exactly as
 * apps/web does — the daemon is the only source of truth for routing and output amounts.
 */
import { l1TokenDecimals, rawToHuman } from "@rougechain/core/token-decimals";

export interface PoolReserves {
  pool_id: string;
  token_a: string;
  token_b: string;
  reserve_a: number;
  reserve_b: number;
  total_lp_supply: number;
}

/** apps/web shows a destructive price-impact warning above this (percent). */
export const PRICE_IMPACT_WARN = 3;
/** Slippage presets and bounds (apps/web's settings dialog: slider 0.1–5, presets 0.5/1/2/3). */
export const SLIPPAGE_PRESETS = [0.5, 1, 2, 3] as const;
export const SLIPPAGE_MIN = 0.1;
export const SLIPPAGE_MAX = 5;
export const DEFAULT_SLIPPAGE = 0.5;

/** Minimum output signed into the swap (`min_amount_out`) — apps/web Swap.tsx executeSwap. */
export function minReceived(amountOutRaw: number, slippagePct: number): number {
  return Math.floor(amountOutRaw * (1 - slippagePct / 100));
}

/** 1 tokenIn ≈ ? tokenOut, in human units. */
export function executionRate(amountInRaw: number, tokenIn: string, amountOutRaw: number, tokenOut: string): number {
  const humanIn = rawToHuman(amountInRaw, tokenIn);
  return humanIn > 0 ? rawToHuman(amountOutRaw, tokenOut) / humanIn : 0;
}

/**
 * The paired HUMAN amount that keeps an existing pool's ratio (apps/web Pools.tsx `calculateQuote`).
 * Reserves are raw, so they are humanized first. 0 for an empty pool (first liquidity is free).
 */
export function pairedAmount(pool: PoolReserves, human: number, isTokenA: boolean): number {
  if (!pool.reserve_a || !pool.reserve_b) return 0;
  const ra = rawToHuman(pool.reserve_a, pool.token_a);
  const rb = rawToHuman(pool.reserve_b, pool.token_b);
  if (!ra || !rb) return 0;
  return isTokenA ? (human * rb) / ra : (human * ra) / rb;
}

/** Tokens paid out for removing `lp` LP tokens — the daemon's integer rounding (amm.rs). */
export function removeEstimate(lp: number, pool: PoolReserves): { a: number; b: number } {
  if (!(lp > 0) || !(pool.total_lp_supply > 0)) return { a: 0, b: 0 };
  const l = BigInt(Math.floor(lp));
  const t = BigInt(Math.floor(pool.total_lp_supply));
  return {
    a: Number((l * BigInt(Math.floor(pool.reserve_a))) / t),
    b: Number((l * BigInt(Math.floor(pool.reserve_b))) / t),
  };
}

/** Share of the pool, 0..1. */
export function poolShare(lp: number, pool: Pick<PoolReserves, "total_lp_supply">): number {
  return pool.total_lp_supply > 0 ? Math.min(1, Math.max(0, lp / pool.total_lp_supply)) : 0;
}

/** The node reports prices as RAW reserve ratios; humanize by the decimals gap (apps/web PoolDetail). */
export function humanizePrice(raw: number, tokenA: string, tokenB: string, isAinB: boolean): number {
  const decA = l1TokenDecimals(tokenA);
  const decB = l1TokenDecimals(tokenB);
  return raw * 10 ** (isAinB ? decA - decB : decB - decA);
}

/** Spot price of A in B (or B in A) from current reserves, humanized. */
export function spotPrice(pool: PoolReserves, isAinB: boolean): number {
  if (!pool.reserve_a || !pool.reserve_b) return 0;
  const raw = isAinB ? pool.reserve_b / pool.reserve_a : pool.reserve_a / pool.reserve_b;
  return humanizePrice(raw, pool.token_a, pool.token_b, isAinB);
}

/** Precision by magnitude, so tiny prices don't round to 0 (apps/web PoolDetail `fmtPrice`). */
export function fmtPrice(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1) return v.toLocaleString("en-US", { maximumFractionDigits: 4 });
  if (abs >= 0.001) return v.toFixed(6);
  return v.toPrecision(4);
}

/** Pools by depth (apps/web: reserve_a + reserve_b, descending), filtered by a search query. */
export function sortPools<T extends PoolReserves>(pools: T[], query = ""): T[] {
  const sorted = [...pools].sort((a, b) => b.reserve_a + b.reserve_b - (a.reserve_a + a.reserve_b));
  const q = query.trim().toUpperCase();
  if (!q) return sorted;
  return sorted.filter(
    (p) => p.token_a.toUpperCase().includes(q) || p.token_b.toUpperCase().includes(q) || p.pool_id.toUpperCase().includes(q),
  );
}

/** Minimum liquidity the daemon burns when a pool is created (amm.rs MINIMUM_LIQUIDITY). */
export const MINIMUM_LIQUIDITY = 1000;

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x;
}

/** LP tokens minted for a deposit of raw amounts — the daemon's `calculate_lp_mint`. */
export function lpForDeposit(amountA: number, amountB: number, pool?: PoolReserves | null): number {
  if (!(amountA > 0) || !(amountB > 0)) return 0;
  const a = BigInt(Math.floor(amountA));
  const b = BigInt(Math.floor(amountB));
  if (!pool || !(pool.total_lp_supply > 0)) {
    const lp = isqrt(a * b) - BigInt(MINIMUM_LIQUIDITY);
    return lp > 0n ? Number(lp) : 0;
  }
  if (!(pool.reserve_a > 0) || !(pool.reserve_b > 0)) return 0;
  const t = BigInt(Math.floor(pool.total_lp_supply));
  const lpA = (a * t) / BigInt(Math.floor(pool.reserve_a));
  const lpB = (b * t) / BigInt(Math.floor(pool.reserve_b));
  return Number(lpA < lpB ? lpA : lpB);
}

/** The node's pool id for a pair: symbols sorted (byte order), joined by "-" (pool_store.rs). */
export function makePoolId(tokenA: string, tokenB: string): string {
  return tokenA < tokenB ? `${tokenA}-${tokenB}` : `${tokenB}-${tokenA}`;
}
