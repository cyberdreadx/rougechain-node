/** qBTC withdrawal fee / minimum: site-next's copy must behave exactly like apps/web's. */
import { describe, expect, it, vi } from "vitest";
import * as web from "../../../web/src/lib/btc-withdraw-fee";
import * as next from "./btc-fee";

describe("parity with apps/web/src/lib/btc-withdraw-fee.ts", () => {
  it("same constants", () => {
    expect(next.DEFAULT_BTC_MIN_WITHDRAW_SATS).toBe(web.DEFAULT_BTC_MIN_WITHDRAW_SATS);
    expect(next.DEFAULT_BTC_MAX_NETWORK_FEE_SATS).toBe(web.DEFAULT_BTC_MAX_NETWORK_FEE_SATS);
    expect(next.BTC_PAYOUT_EST_VBYTES).toBe(141);
    expect(next.DEFAULT_BTC_MIN_WITHDRAW_SATS).toBe(2000);
  });
  it("limits from /bridge/config (and defaults for missing / bad values)", () => {
    const configs = [undefined, null, {}, { btcMinWithdrawSats: 5000, btcMaxNetworkFeeSats: 3000 }, { btcMinWithdrawSats: -1, btcMaxNetworkFeeSats: 1.5 }, { btcMinWithdrawSats: "9" }];
    for (const c of configs) expect(next.btcWithdrawLimits(c)).toEqual(web.btcWithdrawLimits(c));
    expect(next.btcWithdrawLimits({ btcMinWithdrawSats: 5000, btcMaxNetworkFeeSats: 3000 })).toEqual({ minSats: 5000, maxNetworkFeeSats: 3000 });
  });
  it("fee estimate = ceil(halfHourFee × 141 vB), capped; receive ≈ amount − fee; minimum gate", () => {
    for (const rate of [null, undefined, 0, -2, NaN, 1, 2.5, 12, 70, 500])
      for (const cap of [10_000, 3_000]) expect(next.estimateBtcNetworkFeeSats(rate, cap)).toBe(web.estimateBtcNetworkFeeSats(rate, cap));
    expect(next.estimateBtcNetworkFeeSats(12, 10_000)).toBe(1692);
    expect(next.estimateBtcNetworkFeeSats(500, 10_000)).toBe(10_000);
    for (const [a, f] of [[2000, 1692], [1000, 5000], [123456, 0]]) expect(next.btcReceiveEstimateSats(a, f)).toBe(web.btcReceiveEstimateSats(a, f));
    const limits = next.btcWithdrawLimits({});
    for (const s of [0, 1, 1999, 2000, 2001]) expect(next.isBtcWithdrawAllowed(s, limits)).toBe(web.isBtcWithdrawAllowed(s, limits));
    expect(next.isBtcWithdrawAllowed(1999, limits)).toBe(false);
    expect(next.isBtcWithdrawAllowed(2000, limits)).toBe(true);
    for (const v of ["0.00002", "1", "abc", "", "0.123456789", 0.5]) expect(next.btcToSats(v)).toBe(web.btcToSats(v));
  });
  it("mempool.space recommended fee (halfHourFee; testnet path)", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        urls.push(u);
        return new Response(JSON.stringify({ fastestFee: 30, halfHourFee: 12 }), { status: 200 });
      }),
    );
    expect(await next.fetchRecommendedBtcFeeRate("mainnet")).toBe(12);
    expect(await next.fetchRecommendedBtcFeeRate("testnet")).toBe(12);
    expect(urls).toEqual(["https://mempool.space/api/v1/fees/recommended", "https://mempool.space/testnet/api/v1/fees/recommended"]);
  });
});
