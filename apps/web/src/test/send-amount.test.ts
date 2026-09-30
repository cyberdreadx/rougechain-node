import { describe, it, expect } from "vitest";
import { parseSendAmount, rawToDisplay, formatBalance } from "@/lib/send-amount";

describe("Send dialog amounts (whole tokens in, raw units out)", () => {
  it("scales bridged tokens by their decimals — the old bug sent 1 raw unit", () => {
    expect(parseSendAmount("1", "qUSDC")).toEqual({ ok: true, raw: 1_000_000 });
    expect(parseSendAmount("1", "qBTC")).toEqual({ ok: true, raw: 100_000_000 });
    expect(parseSendAmount("0.00005", "qBTC")).toEqual({ ok: true, raw: 5_000 });
    expect(parseSendAmount("0.5", "qETH")).toEqual({ ok: true, raw: 500_000 });
    expect(parseSendAmount("12.345678", "qUSDC")).toEqual({ ok: true, raw: 12_345_678 });
  });
  it("is exact (no float drift) and accepts trailing zeros", () => {
    expect(parseSendAmount("0.1", "qUSDC")).toEqual({ ok: true, raw: 100_000 });
    expect(parseSendAmount("0.29", "qBTC")).toEqual({ ok: true, raw: 29_000_000 });
    expect(parseSendAmount("1.500000000", "qBTC")).toEqual({ ok: true, raw: 150_000_000 });
  });
  it("rejects more precision than the token has, and non-whole custom tokens", () => {
    expect(parseSendAmount("0.000000001", "qBTC")).toMatchObject({ ok: false, error: "qBTC supports at most 8 decimal places" });
    expect(parseSendAmount("1.5", "QTEK")).toMatchObject({ ok: false, error: "QTEK can only be sent in whole units" });
    expect(parseSendAmount("250", "QTEK")).toEqual({ ok: true, raw: 250 });
  });
  it("rejects garbage, zero and negatives", () => {
    for (const bad of ["", "abc", "-1", "0", "0.0", "1e3", "1,000", " . "])
      expect(parseSendAmount(bad, "qUSDC").ok).toBe(false);
  });
  it("leaves XRGE as XRGE amounts (fractions allowed), as before", () => {
    expect(parseSendAmount("2.5", "XRGE")).toEqual({ ok: true, raw: 2.5 });
    expect(parseSendAmount("0", "XRGE").ok).toBe(false);
  });
  it("shows raw balances as tokens, exactly, for Available / Max", () => {
    expect(rawToDisplay(128_660, "qUSDC")).toBe("0.12866");
    expect(rawToDisplay(1_647, "qBTC")).toBe("0.00001647");
    expect(rawToDisplay(100_000_000, "qBTC")).toBe("1");
    expect(rawToDisplay(911_624, "QTEK")).toBe("911624");
    expect(formatBalance(1_234_567_890_000, "qUSDC")).toBe("1,234,567.89");
    expect(formatBalance(911_624, "QTEK")).toBe("911,624");
    // Max round-trips exactly.
    expect(parseSendAmount(rawToDisplay(1_647, "qBTC"), "qBTC")).toEqual({ ok: true, raw: 1_647 });
  });
});
