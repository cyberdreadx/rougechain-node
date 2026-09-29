import { describe, it, expect } from "vitest";
import {
  hashString,
  monogramLetters,
  monogramFor,
  tokenAccent,
  tiltFromPointer,
  MONOGRAM_PALETTE,
} from "@/lib/token-visual";

describe("hashString", () => {
  it("is deterministic and unsigned", () => {
    expect(hashString("XRGE")).toBe(hashString("XRGE"));
    expect(hashString("XRGE")).toBeGreaterThanOrEqual(0);
    expect(hashString("")).toBe(0x811c9dc5);
  });
  it("differs for different inputs", () => {
    expect(hashString("ABC")).not.toBe(hashString("ABD"));
  });
});

describe("monogramLetters", () => {
  it("uses up to two letters", () => {
    expect(monogramLetters("KOALA")).toBe("KO");
    expect(monogramLetters("X")).toBe("X");
  });
  it("strips the bridge q prefix", () => {
    expect(monogramLetters("qSOL")).toBe("SO");
    expect(monogramLetters("qETH")).toBe("ET");
  });
  it("keeps a plain lowercase-q symbol that isn't a bridge prefix", () => {
    expect(monogramLetters("qq")).toBe("QQ");
    expect(monogramLetters("quux")).toBe("QU");
  });
  it("uses $ for USD stablecoins", () => {
    expect(monogramLetters("qUSDC")).toBe("$");
    expect(monogramLetters("USDT")).toBe("$");
  });
  it("handles blanks and punctuation", () => {
    expect(monogramLetters("")).toBe("?");
    expect(monogramLetters("   ")).toBe("?");
    expect(monogramLetters("$-")).toBe("$");
    expect(monogramLetters("a.b.c")).toBe("AB");
  });
});

describe("monogramFor", () => {
  it("is deterministic per symbol and case-insensitive", () => {
    expect(monogramFor("KOALA")).toEqual(monogramFor("KOALA"));
    expect(monogramFor("koala").from).toBe(monogramFor("KOALA").from);
    expect(monogramFor("koala").angle).toBe(monogramFor("KOALA").angle);
  });
  it("picks colours from the brand palette", () => {
    const flat = MONOGRAM_PALETTE.flat().map((c) => `hsl(${c})`);
    for (const s of ["A", "BB", "MOON", "PEPE", "ROUGE", "XYZ123"]) {
      const m = monogramFor(s);
      expect(flat).toContain(m.from);
      expect(flat).toContain(m.to);
      expect(m.angle).toBeGreaterThanOrEqual(120);
      expect(m.angle).toBeLessThanOrEqual(220);
    }
  });
  it("spreads different symbols across the palette", () => {
    const froms = new Set(
      ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH", "III", "JJJ"].map((s) => monogramFor(s).from),
    );
    expect(froms.size).toBeGreaterThan(2);
  });
});

describe("tokenAccent", () => {
  it("returns known brand colours", () => {
    expect(tokenAccent("qBTC")).toBe("#F7931A");
    expect(tokenAccent("QBTC")).toBe("#F7931A");
    expect(tokenAccent("qETH")).toBe("#627EEA");
  });
  it("falls back to the monogram colour", () => {
    expect(tokenAccent("KOALA")).toBe(monogramFor("KOALA").from);
  });
});

describe("tiltFromPointer", () => {
  it("is flat at the centre", () => {
    expect(tiltFromPointer(50, 50, 100, 100)).toEqual({ rotateX: 0, rotateY: 0 });
  });
  it("reaches ±max at the edges", () => {
    expect(tiltFromPointer(100, 0, 100, 100, 6)).toEqual({ rotateX: 6, rotateY: 6 });
    expect(tiltFromPointer(0, 100, 100, 100, 6)).toEqual({ rotateX: -6, rotateY: -6 });
  });
  it("clamps outside the box and handles degenerate sizes", () => {
    expect(tiltFromPointer(500, -40, 100, 100, 4)).toEqual({ rotateX: 4, rotateY: 4 });
    expect(tiltFromPointer(10, 10, 0, 100)).toEqual({ rotateX: 0, rotateY: 0 });
    expect(tiltFromPointer(10, 10, NaN, 100)).toEqual({ rotateX: 0, rotateY: 0 });
  });
});
