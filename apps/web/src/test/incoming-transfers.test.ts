import { describe, expect, it } from "vitest";
import { findNewIncoming, idSet, isIncomingFrame, txKey } from "@/lib/incoming-transfers";
import type { WalletTransaction } from "@/lib/pqc-wallet";

const PK = "abcdef0123";
const ADDR = "rouge1qxyz";
const mine = idSet([PK, ADDR]);

function tx(p: Partial<WalletTransaction>): WalletTransaction {
  return {
    id: "b", type: "receive", amount: "5", symbol: "XRGE", address: "", timeLabel: "", timestamp: 1_000,
    status: "completed", blockIndex: 1, txHash: "blockhash", from: "other", to: PK, ...p,
  };
}

describe("incoming transfer detection", () => {
  it("reports new transfers to my pubkey or my rouge1 address once", () => {
    const seen = new Set<string>();
    const a = tx({ to: PK });
    const b = tx({ to: ADDR.toUpperCase(), amount: "0.5", symbol: "qBTC" });
    expect(findNewIncoming([a, b], seen, mine, 0)).toEqual([a, b]);
    expect(findNewIncoming([a, b], seen, mine, 0)).toEqual([]);
  });

  it("ignores my own sends, self-transfers, fee credits, other types and old entries", () => {
    const seen = new Set<string>();
    const list = [
      tx({ type: "send", from: PK, to: "other" }),
      tx({ from: PK, to: ADDR }), // to myself
      tx({ to: "validator-fee-only" }), // fee-recipient entry typed "receive"
      tx({ type: "swap" }),
      tx({ timestamp: 10 }),
    ];
    expect(findNewIncoming(list, seen, mine, 500)).toEqual([]);
    expect(seen.size).toBe(list.length);
  });

  it("keys entries in the same block apart", () => {
    expect(txKey(tx({ amount: "1" }))).not.toBe(txKey(tx({ amount: "2" })));
  });

  it("matches websocket frames addressed to me by someone else", () => {
    expect(isIncomingFrame({ from: "other", to: ADDR }, mine)).toBe(true);
    expect(isIncomingFrame({ from: "other", to: PK.toUpperCase() }, mine)).toBe(true);
    expect(isIncomingFrame({ from: PK, to: "other" }, mine)).toBe(false);
    expect(isIncomingFrame({ from: PK, to: ADDR }, mine)).toBe(false);
    expect(isIncomingFrame({ from: "other", to: null }, mine)).toBe(false);
  });
});
