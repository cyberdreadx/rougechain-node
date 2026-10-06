/** In-flight deposit store: persistence, storage-unavailable safety, cap, expiry, and one-to-one credit matching. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeHistoryEntry } from "@rougechain/core/bridge";
import {
  addInflight,
  dismissInflight,
  INFLIGHT_KEEP_MS,
  INFLIGHT_MAX,
  listInflight,
  markCredited,
  matchCredits,
  removeInflight,
  subscribeInflight,
  updateInflight,
  type InflightDeposit,
} from "./inflight";

const NET = "testnet";
const T0 = 1_760_000_000_000;

function rec(n: number, over: Partial<InflightDeposit> = {}): InflightDeposit {
  return { baseTxHash: `0x${String(n).padStart(64, "0")}`, asset: "USDC", l1Symbol: "qUSDC", amountLabel: "2.5", expectedL1Units: "2500000", recipientPubkey: "pub", startedAt: T0 + n, state: "sent", ...over };
}
function credit(id: string, amount: string, symbol: string, timestamp: number, over: Partial<BridgeHistoryEntry> = {}): BridgeHistoryEntry {
  return { id, type: "bridge_mint", direction: "deposit", amount, symbol, timestamp, timeLabel: "", status: "completed", txHash: id, ...over };
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("in-flight deposit store", () => {
  it("add / list / update / dismiss / remove, per network, persisted in localStorage", () => {
    const seen = vi.fn();
    const off = subscribeInflight(seen);
    addInflight(NET, rec(2));
    addInflight(NET, rec(1));
    addInflight("mainnet", rec(3));
    expect(listInflight(NET).map((r) => r.baseTxHash)).toEqual([rec(1).baseTxHash, rec(2).baseTxHash]); // oldest first
    expect(listInflight("mainnet")).toEqual([rec(3)]);
    expect(JSON.parse(localStorage.getItem("rougechain.bridge.inflight.v1.testnet")!)).toHaveLength(2);

    addInflight(NET, rec(1, { amountLabel: "9" })); // same Base transaction: replaced, not duplicated
    expect(listInflight(NET)).toHaveLength(2);

    markCredited(NET, rec(1).baseTxHash, "l1tx");
    expect(listInflight(NET)[0]).toMatchObject({ state: "credited", creditTxId: "l1tx", finishedAt: expect.any(Number) });
    updateInflight(NET, "0xunknown", { state: "credited" }); // unknown hash: no-op
    dismissInflight(NET, rec(1).baseTxHash);
    expect(listInflight(NET)[0]).toMatchObject({ dismissed: true, creditTxId: "l1tx" }); // kept so its credit stays taken
    removeInflight(NET, rec(2).baseTxHash);
    expect(listInflight(NET).map((r) => r.baseTxHash)).toEqual([rec(1).baseTxHash]);
    expect(seen).toHaveBeenCalledTimes(7);
    off();
  });

  it("ignores corrupt or foreign data in storage", () => {
    localStorage.setItem("rougechain.bridge.inflight.v1.testnet", "{not json");
    expect(listInflight(NET)).toEqual([]);
    localStorage.setItem("rougechain.bridge.inflight.v1.testnet", JSON.stringify([{ nope: 1 }, null, rec(1)]));
    expect(listInflight(NET)).toEqual([rec(1)]);
    localStorage.setItem("rougechain.bridge.inflight.v1.testnet", JSON.stringify({ a: 1 }));
    expect(listInflight(NET)).toEqual([]);
  });

  it("works when storage is unavailable (kept in memory for the session, never throws)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(listInflight(NET)).toEqual([]);
    addInflight(NET, rec(1));
    markCredited(NET, rec(1).baseTxHash);
    expect(listInflight(NET)).toEqual([expect.objectContaining({ baseTxHash: rec(1).baseTxHash, state: "credited" })]);
    dismissInflight(NET, rec(1).baseTxHash);
    // storage back: the next write lands in it and the memory copy is dropped
    vi.restoreAllMocks();
    removeInflight(NET, rec(1).baseTxHash);
    expect(localStorage.getItem("rougechain.bridge.inflight.v1.testnet")).toBe("[]");
    expect(listInflight(NET)).toEqual([]);
  });

  it(`caps the list at ${INFLIGHT_MAX}: finished records are dropped first, then the oldest`, () => {
    for (let i = 1; i <= INFLIGHT_MAX; i++) addInflight(NET, rec(i));
    markCredited(NET, rec(7).baseTxHash);
    addInflight(NET, rec(21));
    let hashes = listInflight(NET).map((r) => r.baseTxHash);
    expect(hashes).toHaveLength(INFLIGHT_MAX);
    expect(hashes).not.toContain(rec(7).baseTxHash);
    expect(hashes).toContain(rec(1).baseTxHash);
    addInflight(NET, rec(22));
    hashes = listInflight(NET).map((r) => r.baseTxHash);
    expect(hashes).toHaveLength(INFLIGHT_MAX);
    expect(hashes).not.toContain(rec(1).baseTxHash);
    expect(hashes).toContain(rec(22).baseTxHash);
  });

  it("finished records expire after a day; a waiting deposit never expires on its own", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T0);
      addInflight(NET, rec(1));
      addInflight(NET, rec(2));
      addInflight(NET, rec(3));
      markCredited(NET, rec(1).baseTxHash);
      dismissInflight(NET, rec(2).baseTxHash);
      vi.setSystemTime(T0 + INFLIGHT_KEEP_MS - 1);
      expect(listInflight(NET)).toHaveLength(3);
      vi.setSystemTime(T0 + INFLIGHT_KEEP_MS + 1);
      expect(listInflight(NET).map((r) => r.baseTxHash)).toEqual([rec(3).baseTxHash]);
      addInflight(NET, rec(4)); // the next write prunes storage too
      expect(JSON.parse(localStorage.getItem("rougechain.bridge.inflight.v1.testnet")!)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("credit matching", () => {
  it("needs the same symbol, the same amount and a block time at or after the send (2 min skew allowed)", () => {
    const r = rec(1); // 2.5 qUSDC sent at T0+1
    expect(matchCredits([r], [credit("a", "2.50", "qUSDC", T0 + 60_000)])).toEqual([{ baseTxHash: r.baseTxHash, creditTxId: "a" }]);
    expect(matchCredits([r], [credit("a", "2.50", "qUSDC", T0 - 119_000)])).toHaveLength(1);
    expect(matchCredits([r], [credit("a", "2.50", "qUSDC", T0 - 121_000)])).toEqual([]); // an older credit of the same amount
    expect(matchCredits([r], [credit("a", "2.50", "qUSDC", 0)])).toEqual([]); // no block time
    expect(matchCredits([r], [credit("a", "2.50", "qETH", T0 + 1)])).toEqual([]);
    expect(matchCredits([r], [credit("a", "2.51", "qUSDC", T0 + 1)])).toEqual([]);
    expect(matchCredits([r], [credit("a", "2.50", "qUSDC", T0 + 1, { direction: "withdraw", type: "bridge_withdraw" })])).toEqual([]);
  });

  it("formats the expected amount the way the history does (qETH, sub-unit qUSDC, whole XRGE)", () => {
    const eth = rec(1, { asset: "ETH", l1Symbol: "qETH", amountLabel: "0.25", expectedL1Units: "250000" });
    const usdc = rec(2, { amountLabel: "0.5", expectedL1Units: "500000" });
    const xrge = rec(3, { asset: "XRGE", l1Symbol: "XRGE", amountLabel: "5", expectedL1Units: "5" });
    const hits = matchCredits([eth, usdc, xrge], [credit("x", "5", "XRGE", T0 + 9), credit("u", "0.5", "qUSDC", T0 + 9), credit("e", "0.25", "qETH", T0 + 9)]);
    expect(hits).toEqual([
      { baseTxHash: eth.baseTxHash, creditTxId: "e" },
      { baseTxHash: usdc.baseTxHash, creditTxId: "u" },
      { baseTxHash: xrge.baseTxHash, creditTxId: "x" },
    ]);
  });

  it("limit: amounts are compared at the history's display precision (qUSDC of 1 or more: 2 decimals)", () => {
    const r = rec(1, { amountLabel: "12.345678", expectedL1Units: "12345678" });
    expect(matchCredits([r], [credit("a", "12.35", "qUSDC", T0 + 5)])).toHaveLength(1);
    expect(matchCredits([r], [credit("a", "12.36", "qUSDC", T0 + 5)])).toEqual([]);
  });

  it("two identical deposits are paid one-to-one, oldest first — never both by one credit", () => {
    const a = rec(1);
    const b = rec(2);
    const first = credit("c1", "2.50", "qUSDC", T0 + 30_000);
    expect(matchCredits([b, a], [first])).toEqual([{ baseTxHash: a.baseTxHash, creditTxId: "c1" }]);
    // once `a` holds c1, the same history can't credit `b`
    const aDone: InflightDeposit = { ...a, state: "credited", creditTxId: "c1" };
    expect(matchCredits([aDone, b], [first])).toEqual([]);
    expect(matchCredits([{ ...aDone, dismissed: true }, b], [first])).toEqual([]);
    const second = credit("c2", "2.50", "qUSDC", T0 + 90_000);
    expect(matchCredits([aDone, b], [second, first])).toEqual([{ baseTxHash: b.baseTxHash, creditTxId: "c2" }]);
    expect(matchCredits([a, b], [second, first])).toEqual([
      { baseTxHash: a.baseTxHash, creditTxId: "c1" },
      { baseTxHash: b.baseTxHash, creditTxId: "c2" },
    ]);
  });

  it("dismissed and already credited records are left alone", () => {
    expect(matchCredits([rec(1, { dismissed: true }), rec(2, { state: "credited" })], [credit("a", "2.50", "qUSDC", T0 + 5)])).toEqual([]);
  });
});
