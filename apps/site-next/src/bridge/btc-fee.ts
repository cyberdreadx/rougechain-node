// Copied verbatim from apps/web/src/lib/btc-withdraw-fee.ts (not yet in @rougechain/core); btc-fee.test.ts
// asserts both implementations agree, so a fee-policy change in one fails the other.
/**
 * qBTC → BTC withdrawal fee display. The Bitcoin network fee of a payout is paid by the
 * withdrawer: the relayer sends `amount − fee` where `fee` is the payout transaction's real fee
 * (capped by the node's btcMaxNetworkFeeSats). The site can only ESTIMATE that fee — a typical
 * payout (1 P2WPKH input → destination + custody change) is ~141 vB.
 */

/** Node defaults (QV_BRIDGE_BTC_MIN_WITHDRAW_SATS / QV_BRIDGE_BTC_MAX_NETWORK_FEE_SATS). */
export const DEFAULT_BTC_MIN_WITHDRAW_SATS = 2_000;
export const DEFAULT_BTC_MAX_NETWORK_FEE_SATS = 10_000;
/** Typical payout size: 1 P2WPKH input, P2WPKH destination + P2WPKH change. */
export const BTC_PAYOUT_EST_VBYTES = 141;

export interface BtcWithdrawLimits {
  minSats: number;
  maxNetworkFeeSats: number;
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

/** Limits from GET /bridge/config when present, node defaults otherwise. */
export function btcWithdrawLimits(config?: { btcMinWithdrawSats?: unknown; btcMaxNetworkFeeSats?: unknown } | null): BtcWithdrawLimits {
  return {
    minSats: positiveInt(config?.btcMinWithdrawSats) ?? DEFAULT_BTC_MIN_WITHDRAW_SATS,
    maxNetworkFeeSats: positiveInt(config?.btcMaxNetworkFeeSats) ?? DEFAULT_BTC_MAX_NETWORK_FEE_SATS,
  };
}

/** Estimated payout fee in sats: ceil(rate × ~141 vB), never above the node's cap. null if no rate. */
export function estimateBtcNetworkFeeSats(feeRateSatPerVb: number | null | undefined, maxNetworkFeeSats: number): number | null {
  if (typeof feeRateSatPerVb !== "number" || !Number.isFinite(feeRateSatPerVb) || feeRateSatPerVb <= 0) return null;
  return Math.min(Math.ceil(feeRateSatPerVb * BTC_PAYOUT_EST_VBYTES), maxNetworkFeeSats);
}

/** What the withdrawer receives (≈): amount − fee, floored at 0. */
export function btcReceiveEstimateSats(amountSats: number, feeSats: number): number {
  return Math.max(0, amountSats - feeSats);
}

/** Convert a user-entered BTC amount to whole sats (1 qBTC unit = 1 sat). NaN-safe → 0. */
export function btcToSats(amount: string | number): number {
  const n = typeof amount === "number" ? amount : parseFloat(amount);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1e8) : 0;
}

/** Whether an amount (sats) may be submitted: at or above the minimum. */
export function isBtcWithdrawAllowed(amountSats: number, limits: BtcWithdrawLimits): boolean {
  return amountSats > 0 && amountSats >= limits.minSats;
}

/** mempool.space recommended fee rate (sat/vB, ~3-block "halfHourFee"); null on any failure. */
export async function fetchRecommendedBtcFeeRate(network?: "mainnet" | "testnet"): Promise<number | null> {
  const url = network === "testnet"
    ? "https://mempool.space/testnet/api/v1/fees/recommended"
    : "https://mempool.space/api/v1/fees/recommended";
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const d = (await res.json()) as { halfHourFee?: unknown; fastestFee?: unknown };
    const r = typeof d.halfHourFee === "number" ? d.halfHourFee : typeof d.fastestFee === "number" ? d.fastestFee : null;
    return r !== null && Number.isFinite(r) && r > 0 ? r : null;
  } catch {
    return null;
  }
}
