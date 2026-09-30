/**
 * Write flows with a mocked node: each DEX write hits the same endpoint with the same signed
 * payload apps/web produces (apps/web's lib/secure-api, called with identical arguments), and the
 * ML-DSA-65 signature verifies. Nothing reaches a real node.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { verifyTransaction, type SignedTransaction } from "@rougechain/core/pqc-signer";
import * as web from "../../../web/src/lib/secure-api";
import { mockFetch, resetBrowserState, seedAppsWebWallet } from "../wallet/test-utils";
import { fetchEarnings, fetchQuote, submitAddLiquidity, submitCollectFees, submitCreatePool, submitRemoveLiquidity, submitSwap, type Pool } from "./api";

const ok = () => ({ success: true, pool_id: "MTK-XRGE" });
type Call = { url: string; init?: RequestInit };
const body = (c: Call) => JSON.parse(String(c.init?.body)) as SignedTransaction;

/** Compare two signed txs, ignoring what is unique per signature. */
function shape(tx: SignedTransaction) {
  const { timestamp, nonce, ...rest } = tx.payload as unknown as Record<string, unknown>;
  expect(typeof timestamp).toBe("number");
  expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  return { payload: rest, public_key: tx.public_key, keys: Object.keys(tx).sort() };
}

beforeEach(() => resetBrowserState());

describe("DEX writes go through core secure-api, exactly like apps/web", () => {
  const cases: [string, string, (w: { signingPublicKey: string; signingPrivateKey: string }) => Promise<unknown>, (pk: string, sk: string) => Promise<unknown>][] = [
    ["swap", "/v2/swap/execute", (w) => submitSwap(w, "XRGE", "qUSDC", 250, 457_000), (pk, sk) => web.secureSwap(pk, sk, "XRGE", "qUSDC", 250, 457_000)],
    ["create pool", "/v2/pool/create", (w) => submitCreatePool(w, "MTK", "XRGE", 1000, 250_000), (pk, sk) => web.secureCreatePool(pk, sk, "MTK", "XRGE", 1000, 250_000)],
    ["add liquidity", "/v2/pool/add-liquidity", (w) => submitAddLiquidity(w, "XRGE-qUSDC", 546, 1_000_000_000), (pk, sk) => web.secureAddLiquidity(pk, sk, "XRGE-qUSDC", 546, 1_000_000_000)],
    ["remove liquidity", "/v2/pool/remove-liquidity", (w) => submitRemoveLiquidity(w, "XRGE-qUSDC", 777), (pk, sk) => web.secureRemoveLiquidity(pk, sk, "XRGE-qUSDC", 777)],
  ];

  it.each(cases)("%s → POST %s with apps/web's signed payload", async (_name, endpoint, mine, theirs) => {
    const w = seedAppsWebWallet();
    const { calls } = mockFetch({ [endpoint]: ok });
    await mine(w);
    await theirs(w.signingPublicKey, w.signingPrivateKey);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.url).toBe(`http://localhost:5101/api${endpoint}`);
      expect(c.init?.method).toBe("POST");
      expect(verifyTransaction(body(c))).toBe(true);
    }
    expect(shape(body(calls[0]))).toEqual(shape(body(calls[1])));
  });

  it("collect fees removes exactly the fee LP (apps/web handleCollectFees)", async () => {
    const w = seedAppsWebWallet();
    const { calls } = mockFetch({ "/v2/pool/remove-liquidity": ok });
    await submitCollectFees(w, "XRGE-qUSDC", { lpToCollect: 321, earnedA: 5, earnedB: 9000, growth: 0.004 });
    expect(body(calls[0]).payload).toMatchObject({ type: "remove_liquidity", pool_id: "XRGE-qUSDC", lp_amount: 321, from: w.signingPublicKey });
    await expect(submitCollectFees(w, "XRGE-qUSDC", { lpToCollect: 3, earnedA: 0, earnedB: 1, growth: 0 })).rejects.toThrow("Nothing to collect");
    expect(calls).toHaveLength(1);
  });

  it("surfaces the node's error", async () => {
    const w = seedAppsWebWallet();
    mockFetch({ "/v2/swap/execute": () => ({ success: false, error: "Slippage exceeded" }) });
    await expect(submitSwap(w, "XRGE", "qUSDC", 1, 1)).rejects.toThrow("Slippage exceeded");
  });

  it("an extension wallet signs through window.rougechain (serialized bytes), never locally", async () => {
    const local = seedAppsWebWallet();
    const requests: { payload: unknown; serializedHex: string }[] = [];
    Object.assign(window, {
      rougechain: {
        isRougeChain: true,
        connect: async () => ({ publicKey: local.signingPublicKey }),
        signTransaction: async (p: { payload: unknown; serializedHex: string }) => {
          requests.push(p);
          return { signature: "ab".repeat(8) };
        },
      },
    });
    const { calls } = mockFetch({ "/v2/swap/execute": ok });
    await submitSwap({ signingPublicKey: local.signingPublicKey, signingPrivateKey: "" }, "XRGE", "qETH", 10, 9);
    expect(requests).toHaveLength(1);
    const sent = body(calls[0]);
    expect(sent.signature).toBe("ab".repeat(8));
    expect(sent.payload_bytes_hex).toBe(requests[0].serializedHex);
    expect(sent.payload).toMatchObject({ type: "swap", token_in: "XRGE", token_out: "qETH", amount_in: 10, min_amount_out: 9 });
  });
});

describe("reads", () => {
  const pool: Pool = { pool_id: "XRGE-qUSDC", token_a: "XRGE", token_b: "qUSDC", reserve_a: 1000, reserve_b: 2_000_000, total_lp_supply: 44_721, fee_rate: 0.003 };

  it("quotes with POST /swap/quote and the raw amount (apps/web body)", async () => {
    const { calls } = mockFetch({ "/swap/quote": () => ({ success: true, amount_out: 1994, price_impact: 0.4, path: ["XRGE", "qUSDC"], pools: ["XRGE-qUSDC"] }) });
    const r = await fetchQuote("XRGE", "qUSDC", 1);
    expect(r).toEqual({ ok: true, quote: { success: true, amount_out: 1994, price_impact: 0.4, path: ["XRGE", "qUSDC"], pools: ["XRGE-qUSDC"] } });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ token_in: "XRGE", token_out: "qUSDC", amount_in: 1 });
  });

  it("uses the node's LP fee ledger first", async () => {
    const { calls } = mockFetch({ "/earnings/": () => ({ success: true, earnings: { tracked: true, lpToCollect: 12, earnedA: 1, earnedB: 540, growth: 0.01 } }) });
    expect(await fetchEarnings(pool, "pk", 1000)).toEqual({ lpToCollect: 12, earnedA: 1, earnedB: 540, growth: 0.01 });
    expect(calls.map((c) => c.url)).toEqual(["http://localhost:5101/api/pool/XRGE-qUSDC/earnings/pk"]);
  });

  it("an untracked ledger position is 'unavailable' (null), as apps/web", async () => {
    mockFetch({ "/earnings/": () => ({ success: true, earnings: { tracked: false } }) });
    expect(await fetchEarnings(pool, "pk", 1000)).toBeNull();
  });
});
