import { describe, expect, it } from "vitest";
import { swapSides, txAmountSymbol } from "@/lib/tx-display";

// Mainnet block 153: 1,000 QTEK swapped for XRGE.
const swap = { amount: 1000, pool_id: "QTEK-XRGE", token_a_symbol: "QTEK", token_b_symbol: "XRGE", amount_a: 1000, min_amount_out: 6 };

describe("tx display", () => {
  it("labels a swap amount with its input token", () => {
    expect(txAmountSymbol("swap", swap)).toBe("QTEK");
    expect(txAmountSymbol("SWAP", swap)).toBe("QTEK");
  });
  it("keeps transfers as before", () => {
    expect(txAmountSymbol("transfer", { amount: 5 })).toBe("XRGE");
    expect(txAmountSymbol("transfer", { amount: 5, token_symbol: "GOLD" })).toBe("GOLD");
  });
  it("reads both swap sides", () => {
    expect(swapSides(swap)).toEqual({ tokenIn: "QTEK", amountIn: 1000, tokenOut: "XRGE", minOut: 6, poolId: "QTEK-XRGE" });
  });
});
