import { describe, expect, it } from "vitest";
import { humanToQeth } from "@rougechain/core/token-decimals";
import { formatUnits, parseBtcAddress, parseDepositAmount, parseEvmAddress, parseWithdrawAmount, normalizeBtcTxid, isBaseTxHash, WEI_PER_QETH_UNIT } from "./validate";

const ok = <T,>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const err = (r: { ok: boolean; error?: string }) => (r.ok ? null : r.error);

describe("deposit amounts", () => {
  it("ETH: wei, always a multiple of 1e12 (whole qETH units)", () => {
    expect(ok(parseDepositAmount("ETH", "0.25"))).toEqual({ baseUnits: 250_000_000_000_000_000n, l1Units: 250_000n });
    expect(ok(parseDepositAmount("ETH", "1.000001"))).toEqual({ baseUnits: 1_000_001_000_000_000_000n, l1Units: 1_000_001n });
    for (const s of ["0.000001", "3", "12.5", "0.123456"]) {
      const v = ok(parseDepositAmount("ETH", s));
      expect(v.baseUnits % WEI_PER_QETH_UNIT).toBe(0n);
      expect(Number(v.l1Units)).toBe(humanToQeth(Number(s)));
    }
    // apps/web's float would send 1000000999999999872 wei here (not a multiple of 1e12 → dust lost)
    expect(BigInt(Math.round(1.000001 * 1e18)) % WEI_PER_QETH_UNIT).not.toBe(0n);
    expect(err(parseDepositAmount("ETH", "0.0000001"))).toMatch(/at most 6 decimal/);
  });
  it("USDC: 6 decimals", () => {
    expect(ok(parseDepositAmount("USDC", "12.345678"))).toEqual({ baseUnits: 12_345_678n, l1Units: 12_345_678n });
    expect(err(parseDepositAmount("USDC", "1.0000001"))).toMatch(/at most 6 decimal/);
    expect(ok(parseDepositAmount("USDC", "1.50000000"))).toEqual({ baseUnits: 1_500_000n, l1Units: 1_500_000n });
  });
  it("XRGE: whole units only (apps/web would silently floor)", () => {
    expect(ok(parseDepositAmount("XRGE", "5"))).toEqual({ baseUnits: 5n * 10n ** 18n, l1Units: 5n });
    expect(ok(parseDepositAmount("XRGE", "2.0"))).toEqual({ baseUnits: 2n * 10n ** 18n, l1Units: 2n });
    expect(err(parseDepositAmount("XRGE", "1.5"))).toMatch(/whole/);
  });
  it("rejects empty / zero / negative / garbage", () => {
    for (const s of ["", "0", "0.0", "-1", "abc", "1e5", ".", "1..2"]) expect(parseDepositAmount("ETH", s).ok).toBe(false);
    expect(parseDepositAmount("BTC", "1").ok).toBe(false);
  });
  it("accepts a decimal comma", () => {
    expect(ok(parseDepositAmount("USDC", "1,5")).baseUnits).toBe(1_500_000n);
  });
});

describe("withdraw amounts (units signed into the payload)", () => {
  it("qETH / qUSDC 6 dp, XRGE whole, qBTC 8 dp (sats)", () => {
    expect(ok(parseWithdrawAmount("ETH", "0.5"))).toBe(500_000);
    expect(ok(parseWithdrawAmount("USDC", "2.5"))).toBe(2_500_000);
    expect(ok(parseWithdrawAmount("XRGE", "42"))).toBe(42);
    expect(ok(parseWithdrawAmount("BTC", "0.00002"))).toBe(2_000);
    expect(ok(parseWithdrawAmount("BTC", "1.23456789"))).toBe(123_456_789);
    expect(err(parseWithdrawAmount("BTC", "0.000000001"))).toMatch(/at most 8 decimal/);
    expect(err(parseWithdrawAmount("XRGE", "1.1"))).toMatch(/whole/);
    expect(err(parseWithdrawAmount("ETH", "0.0000001"))).toMatch(/at most 6/);
  });
  it("matches apps/web's conversions where apps/web is exact", () => {
    for (const s of ["0.1", "1", "3.14", "0.000001"]) expect(ok(parseWithdrawAmount("ETH", s))).toBe(humanToQeth(Number(s)));
    for (const s of ["0.00002", "0.5", "0.12345678"]) expect(ok(parseWithdrawAmount("BTC", s))).toBe(Math.round(Number(s) * 1e8));
  });
  it("formats raw units back", () => {
    expect(formatUnits(123_456_789, 8)).toBe("1.23456789");
    expect(formatUnits(2_000, 8)).toBe("0.00002");
    expect(formatUnits(500_000n, 6)).toBe("0.5");
    expect(formatUnits(42, 0)).toBe("42");
  });
});

describe("addresses", () => {
  it("Base: 0x + 40 hex (0x optional, like apps/web); bad checksum refused", () => {
    expect(ok(parseEvmAddress("0x3333333333333333333333333333333333333333"))).toBe("0x3333333333333333333333333333333333333333");
    expect(ok(parseEvmAddress("3333333333333333333333333333333333333333"))).toBe("0x3333333333333333333333333333333333333333");
    expect(ok(parseEvmAddress(" 0x036CbD53842c5426634e7929541eC2318f3dCF7e "))).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(err(parseEvmAddress("0x036cbD53842c5426634e7929541eC2318f3dCF7e"))).toMatch(/checksum/);
    expect(err(parseEvmAddress("0x33"))).toMatch(/valid Base address/);
    expect(err(parseEvmAddress("0xzz33333333333333333333333333333333333333"))).toMatch(/valid Base address/);
  });
  it("Bitcoin mainnet: bech32 / bech32m checksums, base58 legacy, network prefix", () => {
    for (const a of [
      "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
      "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4",
      "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
      "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
      "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy",
    ])
      expect(parseBtcAddress(a, "mainnet").ok, a).toBe(true);
    for (const a of [
      "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5", // checksum typo
      "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj1",
      "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", // testnet on mainnet
      "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn",
      "0x3333333333333333333333333333333333333333",
      "short",
    ])
      expect(parseBtcAddress(a, "mainnet").ok, a).toBe(false);
  });
  it("Bitcoin testnet/signet: tb1 / m / n / 2", () => {
    for (const a of ["tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7", "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn", "2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc"])
      expect(parseBtcAddress(a, "testnet").ok, a).toBe(true);
    expect(parseBtcAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "testnet").ok).toBe(false);
  });
  it("tx hashes", () => {
    expect(isBaseTxHash(`0x${"a".repeat(64)}`)).toBe(true);
    expect(isBaseTxHash("a".repeat(64))).toBe(false);
    expect(normalizeBtcTxid(`0x${"B".repeat(64)}`)).toBe("B".repeat(64));
    expect(normalizeBtcTxid("zz")).toBeNull();
  });
});
