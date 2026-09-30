/**
 * Parity with apps/web (the live rougechain.io): the DEX math and amount parsing site-next uses are
 * run against apps/web's OWN code on identical inputs. apps/web keeps some of it inline in its
 * page components, so those functions are extracted from its source and evaluated as-is.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { rawToHuman, setTokenDecimalsCache } from "@rougechain/core/token-decimals";
// apps/web's real modules (no path aliases).
import { parseSendAmount, rawToDisplay } from "../../../web/src/lib/send-amount";
import { humanToRaw as webHumanToRaw } from "../../../web/src/hooks/use-eth-price";
import { canCollect as webCanCollect, computeLpEarnings as webComputeLpEarnings } from "../../../web/src/lib/lp-earnings";
import { fmtPrice, humanizePrice, minReceived, pairedAmount, removeEstimate, sortPools, makePoolId, lpForDeposit } from "./amm";
import { parseLpAmount, parseTokenAmount, rawToInput } from "./amounts";
import { canCollect } from "./api";
import { XRGE_BASE, AERODROME_URL } from "../pages/Buy";

const WEB = path.resolve(__dirname, "../../../web/src");
const src = (rel: string) => readFileSync(path.join(WEB, rel), "utf8");

/** `const name = (a: T, b: U) => …;` from apps/web source → a real function (types stripped). */
function webFunction(file: string, name: string, extra: string[] = []): (...args: unknown[]) => unknown {
  const s = src(file);
  const start = s.indexOf(`const ${name} = (`);
  if (start < 0) throw new Error(`${name} not found in ${file}`);
  const open = s.indexOf("(", start);
  const arrow = s.indexOf("=>", open);
  const params = s
    .slice(open + 1, s.lastIndexOf(")", arrow))
    .split(",")
    .map((p) => p.split(":")[0].trim())
    .filter(Boolean);
  let i = arrow + 2;
  while (/\s/.test(s[i])) i++;
  let body: string;
  if (s[i] === "{") {
    let depth = 0;
    let j = i;
    for (; j < s.length; j++) {
      if (s[j] === "{") depth++;
      else if (s[j] === "}" && --depth === 0) break;
    }
    body = s.slice(i + 1, j);
  } else {
    body = `return ${s.slice(i, s.indexOf(";", i))};`;
  }
  return new Function(...params, ...extra, body) as (...args: unknown[]) => unknown;
}

const POOLS = [
  { pool_id: "XRGE-qUSDC", token_a: "XRGE", token_b: "qUSDC", reserve_a: 5_460_000, reserve_b: 10_000_000_000, total_lp_supply: 233_666_000 },
  { pool_id: "MTK-XRGE", token_a: "MTK", token_b: "XRGE", reserve_a: 1_000, reserve_b: 250_000, total_lp_supply: 14_811 },
  { pool_id: "XRGE-qBTC", token_a: "XRGE", token_b: "qBTC", reserve_a: 90_000_000, reserve_b: 150_000_000, total_lp_supply: 116_189_500 },
  { pool_id: "XRGE-qETH", token_a: "XRGE", token_b: "qETH", reserve_a: 0, reserve_b: 0, total_lp_supply: 0 },
];

beforeEach(() => setTokenDecimalsCache({ qUSDC: 6, qETH: 6, qBTC: 8, MTK: 0 }));

describe("swap math = apps/web", () => {
  it("min received (the signed min_amount_out) matches apps/web Swap.tsx", () => {
    expect(src("pages/Swap.tsx")).toContain("const minOut = Math.floor(quote.amount_out * (1 - slippage / 100));");
    const web = (amountOut: number, slippage: number) => Math.floor(amountOut * (1 - slippage / 100));
    for (const out of [0, 1, 7, 999, 123_456_789, 9_007_199_254_740])
      for (const slip of [0.1, 0.5, 1, 2, 3, 4.7, 5]) expect(minReceived(out, slip)).toBe(web(out, slip));
  });

  it("swap amount_in equals apps/web's raw conversion for every valid input", () => {
    // apps/web: Math.floor(humanToRaw(parseFloat(amountIn), tokenIn))
    const web = (s: string, t: string) => Math.floor(webHumanToRaw(parseFloat(s), t));
    for (const [s, t] of [["1", "XRGE"], ["250", "XRGE"], ["1.5", "qUSDC"], ["0.000001", "qUSDC"], ["0.00000001", "qBTC"], ["2.25", "qETH"], ["42", "MTK"]]) {
      const p = parseTokenAmount(s, t);
      expect(p.ok && p.raw).toBe(web(s, t));
    }
  });

  it("paired liquidity amount runs apps/web Pools.tsx calculateQuote", () => {
    const calculateQuote = webFunction("pages/Pools.tsx", "calculateQuote", ["rawToHuman"]);
    for (const pool of POOLS)
      for (const human of [0, 1, 2.5, 1000, 0.000123])
        for (const isA of [true, false]) expect(pairedAmount(pool, human, isA)).toBe(calculateQuote(pool, human, isA, rawToHuman));
  });

  it("remove-liquidity estimate = apps/web's estimate, rounded like the chain", () => {
    const webEstimate = (lp: number, pool: (typeof POOLS)[number]) => [
      (lp / pool.total_lp_supply) * pool.reserve_a,
      (lp / pool.total_lp_supply) * pool.reserve_b,
    ];
    expect(src("pages/Pools.tsx")).toContain("(parseFloat(removeAmount) / selectedPool.total_lp_supply) * selectedPool.reserve_a");
    for (const pool of POOLS.filter((p) => p.total_lp_supply))
      for (const lp of [1, 10, 777, Math.floor(pool.total_lp_supply / 3), pool.total_lp_supply]) {
        const [a, b] = webEstimate(lp, pool);
        const mine = removeEstimate(lp, pool);
        // The daemon floors (amm.rs calculate_remove_liquidity); apps/web shows the unrounded value.
        expect(Math.abs(mine.a - Math.floor(a))).toBeLessThanOrEqual(1);
        expect(Math.abs(mine.b - Math.floor(b))).toBeLessThanOrEqual(1);
      }
  });

  it("pool price humanization and formatting run apps/web PoolDetail.tsx", () => {
    const webHumanize = webFunction("pages/PoolDetail.tsx", "humanizePrice", ["decA", "decB"]);
    const webFmt = webFunction("pages/PoolDetail.tsx", "fmtPrice");
    const dec = { XRGE: 0, qUSDC: 6, qBTC: 8, MTK: 0, qETH: 6 } as Record<string, number>;
    for (const pool of POOLS)
      for (const raw of [0.000001, 0.5, 1, 1831.5, 546_000])
        for (const isA of [true, false])
          expect(humanizePrice(raw, pool.token_a, pool.token_b, isA)).toBe(webHumanize(raw, isA, dec[pool.token_a], dec[pool.token_b]));
    for (const v of [0, NaN, 546_000.123456, 1, 0.5, 0.0012345, 0.0000018, -3.2]) expect(fmtPrice(v)).toBe(webFmt(v));
  });

  it("pools sort like apps/web (reserve_a + reserve_b, descending)", () => {
    expect(src("pages/Pools.tsx")).toContain("(b.reserve_a + b.reserve_b) - (a.reserve_a + a.reserve_b)");
    expect(sortPools(POOLS).map((p) => p.pool_id)).toEqual(["XRGE-qUSDC", "XRGE-qBTC", "MTK-XRGE", "XRGE-qETH"]);
    expect(sortPools(POOLS, "btc").map((p) => p.pool_id)).toEqual(["XRGE-qBTC"]);
  });

  it("fee collection uses core lp-earnings, the same module apps/web re-exports", () => {
    expect(canCollect).toBe(webCanCollect);
    expect(webComputeLpEarnings).toBeTypeOf("function");
  });

  it("pool ids and LP minting follow the daemon", () => {
    expect(makePoolId("XRGE", "MTK")).toBe("MTK-XRGE");
    expect(makePoolId("XRGE", "qUSDC")).toBe("XRGE-qUSDC"); // byte order: 'X' < 'q'
    expect(lpForDeposit(1_000_000, 1_000_000)).toBe(999_000); // isqrt − MINIMUM_LIQUIDITY
    expect(lpForDeposit(546, 1_000_000_000, POOLS[0])).toBe(23_366); // min(546·S/rA, 1e9·S/rB) = min(23366, 23366600)
  });
});

describe("amount parsing = apps/web send-amount semantics", () => {
  const inputs = ["1", "0", "01", "1.5", "1.50", "0.000001", "0.0000001", "1e3", "-1", "", " 2 ", "1.", ".5", "12345678.123456", "9007199254740993"];
  it.each(["qUSDC", "qETH", "qBTC", "MTK"])("matches parseSendAmount for %s", (symbol) => {
    for (const s of inputs) {
      const web = parseSendAmount(s, symbol);
      const mine = parseTokenAmount(s, symbol);
      expect({ s, ok: mine.ok, raw: mine.ok ? mine.raw : undefined }).toEqual({ s, ok: web.ok, raw: web.ok ? web.raw : undefined });
    }
  });
  it("XRGE: whole units as apps/web, fractions refused (the DEX takes u64, apps/web floors silently)", () => {
    for (const s of ["1", "250", "007"]) expect(parseTokenAmount(s, "XRGE")).toEqual(parseSendAmount(s, "XRGE"));
    expect(parseTokenAmount("1.5", "XRGE")).toEqual({ ok: false, error: "XRGE amounts must be whole numbers" });
  });
  it("Max fills the exact balance (apps/web rawToDisplay)", () => {
    for (const [raw, t] of [[1_500_000, "qUSDC"], [1, "qBTC"], [123_456_789, "qETH"], [42, "MTK"]] as const) expect(rawToInput(raw, t)).toBe(rawToDisplay(raw, t));
    expect(rawToInput(1234.5, "XRGE")).toBe("1234");
  });
  it("LP amounts are whole raw units", () => {
    expect(parseLpAmount("100")).toEqual({ ok: true, raw: 100 });
    expect(parseLpAmount("1.5").ok).toBe(false);
    expect(parseLpAmount("0").ok).toBe(false);
  });
});

describe("buy page constants = apps/web", () => {
  it("uses apps/web's XRGE contract and Aerodrome link", () => {
    const buy = src("pages/Buy.tsx");
    expect(buy).toContain(`export const XRGE_BASE = "${XRGE_BASE}";`);
    expect(buy).toContain("https://aerodrome.finance/swap?from=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913&to=${XRGE_BASE}&chain0=8453&chain1=8453");
    expect(AERODROME_URL).toBe(`https://aerodrome.finance/swap?from=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913&to=${XRGE_BASE}&chain0=8453&chain1=8453`);
  });
});
