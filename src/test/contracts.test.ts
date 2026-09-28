import { describe, expect, it } from "vitest";
import {
  buildContractCallPayload,
  contractCallFee,
  receiptError,
  suggestGasLimit,
  CONTRACT_MAX_GAS,
  formatAttach,
  maxTotalXrge,
  parseAttachInput,
  quantaToXrge,
  xrgeToQuanta,
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

describe("payable calls (attach)", () => {
  it("converts XRGE to quanta exactly and back", () => {
    expect(xrgeToQuanta("0.5")).toBe(500_000_000n);
    expect(xrgeToQuanta("1")).toBe(1_000_000_000n);
    expect(xrgeToQuanta("0.000000001")).toBe(1n);
    expect(xrgeToQuanta(".1")).toBe(100_000_000n);
    expect(xrgeToQuanta("2.500000000000")).toBe(2_500_000_000n);
    expect(() => xrgeToQuanta("0.0000000001")).toThrow(/9 decimal/);
    expect(() => xrgeToQuanta("-1")).toThrow();
    expect(() => xrgeToQuanta("1e3")).toThrow();
    expect(quantaToXrge(500_000_000n)).toBe("0.5");
    expect(quantaToXrge(1_000_000_001n)).toBe("1.000000001");
  });

  it("parses the form into a signed attach", () => {
    expect(parseAttachInput("xrge", "0.3")).toEqual({ symbol: "XRGE", amount: 300_000_000 });
    expect(parseAttachInput("gold", "25")).toEqual({ symbol: "GOLD", amount: 25 });
    expect(() => parseAttachInput("GOLD", "2.5")).toThrow(/whole number/);
    expect(() => parseAttachInput("XRGE", "0")).toThrow(/greater than 0/);
    expect(() => parseAttachInput("XRGE", "9999999999")).toThrow(/too large/);
    expect(() => parseAttachInput("bad sym", "1")).toThrow(/symbol/);
  });

  it("puts the attach in the contract_call payload and totals fee + XRGE payment", () => {
    const p = buildContractCallPayload("PUB", "ab", "roll", {}, 5500, { symbol: "XRGE", amount: 500_000_000 });
    expect(p.attach).toEqual({ symbol: "XRGE", amount: 500_000_000 });
    expect(buildContractCallPayload("PUB", "ab", "roll", {}, 5500).attach).toBeUndefined();
    expect(() => buildContractCallPayload("P", "a", "m", {}, 1, { symbol: "XRGE", amount: 0.5 })).toThrow();
    expect(maxTotalXrge(5500, { symbol: "XRGE", amount: 500_000_000 })).toBe("0.5055");
    expect(maxTotalXrge(5500, { symbol: "GOLD", amount: 5 })).toBe("0.0055");
    expect(formatAttach({ symbol: "XRGE", amount: 1_500_000_000 })).toBe("1.5 XRGE");
  });
});
