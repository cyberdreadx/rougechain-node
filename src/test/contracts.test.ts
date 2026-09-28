import { describe, expect, it } from "vitest";
import {
  buildContractCallPayload,
  contractCallFee,
  receiptError,
  suggestGasLimit,
  CONTRACT_MAX_GAS,
} from "@/lib/contracts";

describe("site contracts client", () => {
  it("builds the same contract_call payload fields as SDK createSignedContractCall", () => {
    const p = buildContractCallPayload("PUB", " ABCdef ", "move", undefined, 5000);
    expect(Object.keys(p).sort()).toEqual(
      ["args", "contractAddr", "from", "gasLimit", "method", "nonce", "timestamp", "type"].sort()
    );
    expect(p.type).toBe("contract_call");
    expect(p.contractAddr).toBe("abcdef");
    expect(p.args).toEqual({});
    expect(p.nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it("rejects out-of-range gas limits", () => {
    expect(() => buildContractCallPayload("P", "a", "m", {}, 0)).toThrow();
    expect(() => buildContractCallPayload("P", "a", "m", {}, 1.5)).toThrow();
    expect(() => buildContractCallPayload("P", "a", "m", {}, CONTRACT_MAX_GAS + 1)).toThrow();
  });

  it("sizes gas and fees like the SDK", () => {
    expect(suggestGasLimit(1000)).toBe(2500);
    expect(suggestGasLimit(9_000_000)).toBe(CONTRACT_MAX_GAS);
    expect(contractCallFee(50_000)).toBeCloseTo(0.05);
  });

  it("reads receipt status", () => {
    expect(receiptError("Success")).toBeNull();
    expect(receiptError({ Failed: "not your turn" })).toBe("not your turn");
  });
});
