import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TEMPLATES } from "../ide/templates";
import { exampleArgs, identifyContract, KNOWN_CONTRACTS } from "./known";

const repo = resolve(__dirname, "../../../..");

function wasmPath(dir: string) {
  const name = dir.split("/").pop();
  return resolve(repo, dir, `${name}.wasm`);
}

describe("known contracts", () => {
  it.each(KNOWN_CONTRACTS.map((c) => [c.id, c] as const))("%s: code hash is sha256 of the committed wasm", (_, c) => {
    const hash = createHash("sha256").update(readFileSync(wasmPath(c.dir))).digest("hex");
    expect(c.codeHash).toBe(hash);
  });

  it.each(KNOWN_CONTRACTS.map((c) => [c.id, c] as const))("%s: methods match the IDE template", (_, c) => {
    const tpl = TEMPLATES.find((t) => t.id === c.id);
    expect(tpl).toBeDefined();
    expect(Object.keys(c.methods).sort()).toEqual(Object.keys(tpl!.methods).sort());
    for (const [name, m] of Object.entries(c.methods)) {
      expect(!!m.read, `${c.id}.${name} read`).toBe(!!tpl!.methods[name].read);
      expect(!!m.attach, `${c.id}.${name} attach`).toBe(!!tpl!.methods[name].attach);
    }
  });

  it("every example argument is valid JSON", () => {
    for (const c of KNOWN_CONTRACTS)
      for (const [name, m] of Object.entries(c.methods)) {
        expect(() => JSON.parse(exampleArgs(m, "rouge1example")), `${c.id}.${name}`).not.toThrow();
      }
  });

  it("identifies by exact hash only", () => {
    const market = KNOWN_CONTRACTS.find((c) => c.id === "nft_marketplace")!;
    expect(identifyContract(market.codeHash)?.id).toBe("nft_marketplace");
    expect(identifyContract(market.codeHash.toUpperCase())?.id).toBe("nft_marketplace");
    expect(identifyContract(market.codeHash.slice(0, 63) + "0")).toBeNull();
    expect(identifyContract("")).toBeNull();
    expect(identifyContract(undefined)).toBeNull();
  });

  it("fills the caller's address", () => {
    const staking = KNOWN_CONTRACTS.find((c) => c.id === "xrge_staking")!;
    expect(exampleArgs(staking.methods.account, "rouge1abc")).toBe('{"address": "rouge1abc"}');
  });
});
