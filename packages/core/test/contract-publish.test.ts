import { describe, expect, it } from "vitest";
import { buildContractPublishPayload, predictContractAddress } from "../src/contracts";

const WASM = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

describe("contract publish", () => {
  it("predicts the address the node assigns (contract_address_v2; same vector as @rougechain/sdk)", () => {
    expect(predictContractAddress("deadbeef".repeat(4), "0123456789abcdef", WASM)).toBe(
      "0c8c80d5cf1fd4404cbc2d40e55b34e6d5fafd59",
    );
  });

  it("builds a contract_deploy payload carrying the WASM as base64", () => {
    const p = buildContractPublishPayload("ab".repeat(8), WASM, "nonce-0001");
    expect(p).toMatchObject({ type: "contract_deploy", from: "ab".repeat(8), wasm: "AGFzbQEAAAA=", nonce: "nonce-0001" });
    expect(typeof p.timestamp).toBe("number");
  });

  it("refuses an empty module or a short nonce", () => {
    expect(() => buildContractPublishPayload("ab", new Uint8Array(), "nonce-0001")).toThrow(/empty/);
    expect(() => buildContractPublishPayload("ab", WASM, "short")).toThrow(/nonce/);
  });
});
