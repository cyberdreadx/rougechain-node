import { describe, expect, it } from "vitest";
import {
  btcWithdrawLimits,
  estimateBtcNetworkFeeSats,
  btcReceiveEstimateSats,
  btcToSats,
  isBtcWithdrawAllowed,
  DEFAULT_BTC_MIN_WITHDRAW_SATS,
  DEFAULT_BTC_MAX_NETWORK_FEE_SATS,
} from "@/lib/btc-withdraw-fee";

describe("btc withdraw fee display math", () => {
  it("limits come from /bridge/config, else node defaults", () => {
    expect(btcWithdrawLimits(null)).toEqual({ minSats: 2_000, maxNetworkFeeSats: 10_000 });
    expect(btcWithdrawLimits({})).toEqual({ minSats: DEFAULT_BTC_MIN_WITHDRAW_SATS, maxNetworkFeeSats: DEFAULT_BTC_MAX_NETWORK_FEE_SATS });
    expect(btcWithdrawLimits({ btcMinWithdrawSats: 5_000, btcMaxNetworkFeeSats: 3_000 })).toEqual({ minSats: 5_000, maxNetworkFeeSats: 3_000 });
    expect(btcWithdrawLimits({ btcMinWithdrawSats: "5000", btcMaxNetworkFeeSats: -1 })).toEqual({ minSats: 2_000, maxNetworkFeeSats: 10_000 });
  });

  it("fee estimate = ceil(rate × 141 vB), capped", () => {
    expect(estimateBtcNetworkFeeSats(1, 10_000)).toBe(141);
    expect(estimateBtcNetworkFeeSats(2.5, 10_000)).toBe(353); // 352.5 → 353
    expect(estimateBtcNetworkFeeSats(500, 10_000)).toBe(10_000);
    expect(estimateBtcNetworkFeeSats(null, 10_000)).toBeNull();
    expect(estimateBtcNetworkFeeSats(0, 10_000)).toBeNull();
  });

  it("you receive ≈ amount − fee, never negative", () => {
    expect(btcReceiveEstimateSats(5_000, 141)).toBe(4_859);
    expect(btcReceiveEstimateSats(100, 141)).toBe(0);
  });

  it("amount conversion and minimum gate", () => {
    expect(btcToSats("0.00005")).toBe(5_000);
    expect(btcToSats("abc")).toBe(0);
    const limits = btcWithdrawLimits(null);
    expect(isBtcWithdrawAllowed(btcToSats("0.00001999"), limits)).toBe(false);
    expect(isBtcWithdrawAllowed(btcToSats("0.00002"), limits)).toBe(true);
    expect(isBtcWithdrawAllowed(0, limits)).toBe(false);
  });
});
