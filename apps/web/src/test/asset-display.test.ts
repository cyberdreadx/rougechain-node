import { describe, expect, it } from "vitest";
import { describeAsset, majorSpotUsd } from "@/lib/asset-display";
import { formatTokenAmount } from "@/hooks/use-eth-price";

const majors = { eth: 3000, btc: 60000 };

describe("wallet asset display", () => {
  it("shows qBTC in whole BTC (8 decimals) with a BTC USD value", () => {
    const d = describeAsset("qBTC", 1_250_000, { majors }); // 0.0125 BTC in sats
    expect(d.balance).toBe("0.0125");
    expect(d.value).toBe("0.0125 qBTC");
    expect(d.human).toBeCloseTo(0.0125);
    expect(d.usd).toBeCloseTo(750);
    expect(d.usdValue).toBe("$750.00");
    expect(d.pricePerToken).toBe("$60,000.00");
  });

  it("keeps qETH / qUSDC behaviour (6 decimals, ETH spot, $1 peg)", () => {
    const eth = describeAsset("qETH", 500_000, { majors });
    expect(eth.balance).toBe("0.5");
    expect(eth.usdValue).toBe("$1,500.00");
    const usdc = describeAsset("qUSDC", 12_345_000, { majors });
    expect(usdc.balance).toBe("12.35");
    expect(usdc.usdValue).toBe("$12.35");
    expect(usdc.pricePerToken).toBe("$1.00");
  });

  it("has no USD value for a major whose price is unknown", () => {
    const d = describeAsset("qBTC", 100_000_000, { majors: { eth: null, btc: null } });
    expect(d.balance).toBe("1");
    expect(d.usd).toBeNull();
    expect(d.usdValue).toBeNull();
  });

  it("uses the per-raw-unit pool price for other tokens", () => {
    const xrge = describeAsset("XRGE", 1000, { majors, poolPriceUsdPerRaw: 0.5 });
    expect(xrge.balance).toBe("1,000");
    expect(xrge.usd).toBe(500);
    expect(xrge.pricePerToken).toBe("$0.500000");
    const none = describeAsset("MEME", 42, { majors });
    expect(none.value).toBe("42 MEME");
    expect(none.usdValue).toBeNull();
  });

  it("maps majors case-insensitively and ignores other symbols", () => {
    expect(majorSpotUsd("QBTC", majors)).toBe(60000);
    expect(majorSpotUsd("XRGE", majors)).toBeNull();
  });

  it("formats qBTC sats without the 6-decimal divisor", () => {
    expect(formatTokenAmount(1, "qBTC")).toBe("0.00000001");
    expect(formatTokenAmount(0, "qBTC")).toBe("0");
  });
});

describe("formatTokenAmount small values", () => {
  it("never uses exponent notation", () => {
    expect(formatTokenAmount(10, "qBTC")).toBe("0.0000001");
    expect(formatTokenAmount(150_000_000, "qBTC")).toBe("1.5");
    expect(formatTokenAmount(1, "qETH")).toBe("0.000001");
  });
});
