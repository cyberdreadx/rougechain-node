import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { WALLET_TRANSFER_FEE } from "../src/pqc-wallet";

// The fee every wallet shows for a send must be the fee the node actually charges. The node fixes
// it per signed tx type in core/daemon/src/v2_binding.rs; read it from there so the two can't drift.
const here = path.dirname(fileURLToPath(import.meta.url));
const binding = readFileSync(path.resolve(here, "../../../core/daemon/src/v2_binding.rs"), "utf8");

describe("wallet transfer fee matches the node", () => {
  it("equals the fee v2_binding.rs binds to a signed \"transfer\"", () => {
    const arm = binding.slice(binding.indexOf('"transfer" =>'), binding.indexOf('"create_token" =>'));
    const m = /\},\s*([0-9]+(?:\.[0-9]+)?)\)\s*\}?\s*$/.exec(arm.trim());
    expect(m, "could not find the transfer fee in v2_binding.rs").not.toBeNull();
    expect(WALLET_TRANSFER_FEE).toBe(Number(m![1]));
  });
  it("the node stores the amount as a whole number (so wallets refuse fractional XRGE)", () => {
    const arm = binding.slice(binding.indexOf('"transfer" =>'), binding.indexOf('"create_token" =>'));
    expect(arm).toContain("amount as u64");
  });
});
