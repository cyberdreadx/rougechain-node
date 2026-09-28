// R1E — cross-language canonical RougeBridge withdrawal-id vectors.
//
// rougeBridgeId = keccak256(UTF8(stored_withdrawal_tx_id)) — the single bytes32 l1TxId used
// for releaseETH/releaseERC20, event verification, processedL1Txs, reconciliation, and the
// refund guard. This MUST match the Rust `rouge_bridge_id` (core/bridge-exec) byte-for-byte.
// The pinned values are also asserted in the Rust test `r1d_canonical_rouge_bridge_id_frozen_vector`.
//
// The relayer derives the id ONLY through `rougeBridgeId` in bridge-relayer-core.ts
// (`keccak256(toBytes(storedTxId))`); viem `toBytes(str)` encodes a non-0x string as UTF-8.
//
//   npx vitest run --config scripts/vitest.config.ts

import { keccak256, toBytes, stringToBytes } from "viem";
import { describe, it, expect } from "vitest";
import { rougeBridgeId } from "./bridge-relayer-core";

// Frozen vectors — identical to the Rust crate's pinned values.
const VECTORS: Record<string, `0x${string}`> = {
  // keccak256("") — the well-known Ethereum keccak256 of empty input.
  "": "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  // representative non-empty stored withdrawal id (bare 64-hex string).
  "00000000000000000000000000000000000000000000000000000000000000ff":
    "0x337ed4d89269c740d540763c75cbe3c32781be676d35104745fa5b46fa5f377f",
};

describe("canonical RougeBridge withdrawal id (cross-language parity with Rust)", () => {
  for (const [input, expected] of Object.entries(VECTORS)) {
    it(`keccak256(UTF8(${JSON.stringify(input)})) == ${expected}`, () => {
      expect(rougeBridgeId(input)).toBe(expected);
    });
  }

  it("the relayer's rougeBridgeId equals viem keccak256(toBytes(id)) for every real stored-id shape", () => {
    // Real stored ids are bare 64-hex or "xrge:"-prefixed — never 0x-prefixed — so the legacy
    // relayer expression keccak256(toBytes(id)) and the UTF-8 form agree exactly.
    for (const input of [...Object.keys(VECTORS), `xrge:${Object.keys(VECTORS)[1]}`, "any stored id"]) {
      expect(rougeBridgeId(input)).toBe(keccak256(toBytes(input)));
      expect(rougeBridgeId(input)).toBe(keccak256(stringToBytes(input)));
    }
    // a 0x-prefixed string is still hashed as UTF-8 TEXT (Rust `as_bytes()`), never hex-decoded
    expect(rougeBridgeId("0xff")).toBe(keccak256(new TextEncoder().encode("0xff")));
  });

  it("prefixed vs unprefixed stored ids differ (the 'xrge:' prefix is part of the preimage)", () => {
    const bare = "00000000000000000000000000000000000000000000000000000000000000ff";
    expect(rougeBridgeId(bare)).not.toBe(rougeBridgeId(`xrge:${bare}`));
    expect(rougeBridgeId(bare)).toBe(rougeBridgeId(bare)); // determinism
  });
});
