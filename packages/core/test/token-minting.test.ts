/**
 * TOKEN_MINTING client side: mintable create_token fields and the signed mint_tokens payload must
 * match what the node reads (core/daemon/src/v2_binding.rs, node.rs); read the Rust so they can't drift.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { createSignedTokenCreation, createSignedTokenMint, verifyTransaction } from "../src/pqc-signer";
import { secureCreateToken, secureMintTokens } from "../src/secure-api";
import {
  TOKEN_MINT_FEE_XRGE,
  TOKEN_MINT_MAX_AMOUNT,
  canMintToken,
  issuedSupply,
  mintRoom,
  tokenMintFields,
  tokenMintingActive,
} from "../src/token-minting";
import { installStorage } from "./storage-shim";

const here = path.dirname(fileURLToPath(import.meta.url));
const binding = readFileSync(path.resolve(here, "../../../core/daemon/src/v2_binding.rs"), "utf8");
const nodeRs = readFileSync(path.resolve(here, "../../../core/daemon/src/node.rs"), "utf8");

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const kp = ml_dsa65.keygen(new Uint8Array(32).fill(5));
const pub = hex(kp.publicKey);
const priv = hex(kp.secretKey);

afterEach(() => vi.unstubAllGlobals());

function mockFetch() {
  installStorage();
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const call = (i = 0) => {
    const [url, init] = fetchMock.mock.calls[i] as unknown as [string, RequestInit];
    return { url, body: JSON.parse(String(init.body)) };
  };
  return { fetchMock, call };
}

describe("node contract", () => {
  it("constants and field names match the node", () => {
    const max = /pub const TOKEN_MINT_MAX_AMOUNT: u64 = ([0-9_]+);/.exec(nodeRs);
    expect(max).not.toBeNull();
    expect(TOKEN_MINT_MAX_AMOUNT).toBe(Number(max![1].replace(/_/g, "")));
    const fee = /"mint_tokens" => \(TxPayload \{[^\n]*\}, ([0-9.]+)\)/.exec(binding);
    expect(fee).not.toBeNull();
    expect(TOKEN_MINT_FEE_XRGE).toBe(Number(fee![1]));
    expect(binding).toContain('p.get("mintable")');
    expect(binding).toContain('p.get("max_supply")');
    expect(binding).toMatch(/"mint_tokens" => \(TxPayload \{ token_symbol: Some\(s\(p, "token_symbol"\)\), token_total_supply: Some\(u\(p, "amount"\)\)/);
  });
});

describe("tokenMintingActive", () => {
  it("reads upgrade_schedule.token_minting against the next height", () => {
    expect(tokenMintingActive(undefined)).toBe(false);
    expect(tokenMintingActive({ network_height: 100 })).toBe(false);
    expect(tokenMintingActive({ network_height: 100, upgrade_schedule: { token_minting: null } })).toBe(false);
    expect(tokenMintingActive({ network_height: 98, upgrade_schedule: { token_minting: 100 } })).toBe(false);
    expect(tokenMintingActive({ network_height: 99, upgrade_schedule: { token_minting: 100 } })).toBe(true);
    expect(tokenMintingActive({ network_height: 5000, upgrade_schedule: { token_minting: 100 } })).toBe(true);
  });
});

describe("create_token mint fields", () => {
  it("fixed supply leaves the payload unchanged", () => {
    for (const mint of [undefined, {}, { mintable: false }]) {
      const tx = createSignedTokenCreation(pub, priv, "N", "SYM", 1000, 100, undefined, undefined, mint);
      expect("mintable" in tx.payload).toBe(false);
      expect("max_supply" in tx.payload).toBe(false);
    }
  });

  it("mintable signs mintable: true and an optional max_supply", () => {
    const a = createSignedTokenCreation(pub, priv, "N", "SYM", 1000, 100, undefined, "desc", { mintable: true });
    expect(a.payload.mintable).toBe(true);
    expect("max_supply" in a.payload).toBe(false);
    expect(verifyTransaction(a)).toBe(true);
    const b = createSignedTokenCreation(pub, priv, "N", "SYM", 1000, 100, undefined, undefined, { mintable: true, maxSupply: 1000 });
    expect(b.payload.max_supply).toBe(1000);
    expect(verifyTransaction(b)).toBe(true);
  });

  it("rejects invalid options", () => {
    expect(() => tokenMintFields(1000, { maxSupply: 5000 })).toThrow(/requires mintable/);
    expect(() => tokenMintFields(1000, { mintable: true, maxSupply: 999 })).toThrow(/below the initial supply/);
    expect(() => tokenMintFields(1000, { mintable: true, maxSupply: 1000.5 })).toThrow(/positive integer/);
    expect(() => tokenMintFields(1000, { mintable: true, maxSupply: TOKEN_MINT_MAX_AMOUNT + 1 })).toThrow(/at most/);
    expect(() => tokenMintFields(1.5, { mintable: true })).toThrow(/initial supply/);
  });

  it("secureCreateToken posts the mint fields, and refuses invalid ones without posting", async () => {
    const { fetchMock, call } = mockFetch();
    await secureCreateToken(pub, priv, "N", "SYM", 1000, 100, undefined, undefined, { mintable: true, maxSupply: 2000 });
    const { url, body } = call();
    expect(url).toMatch(/\/v2\/token\/create$/);
    expect(body.payload.mintable).toBe(true);
    expect(body.payload.max_supply).toBe(2000);
    expect(verifyTransaction(body)).toBe(true);
    const r = await secureCreateToken(pub, priv, "N", "SYM", 1000, 100, undefined, undefined, { mintable: true, maxSupply: 10 });
    expect(r.success).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("mint_tokens", () => {
  it("createSignedTokenMint signs exactly the fields the node reads", () => {
    const tx = createSignedTokenMint(pub, priv, " mnt ", 250);
    expect(Object.keys(tx.payload).sort()).toEqual(["amount", "fee", "from", "nonce", "timestamp", "token_symbol", "type"]);
    expect(tx.payload).toMatchObject({ type: "mint_tokens", token_symbol: "MNT", amount: 250, fee: 1, from: pub });
    expect(tx.public_key).toBe(pub);
    expect(verifyTransaction(tx)).toBe(true);
  });

  it("refuses bad amounts", () => {
    for (const amt of [0, -1, 2.5, TOKEN_MINT_MAX_AMOUNT + 1, Number.NaN]) {
      expect(() => createSignedTokenMint(pub, priv, "MNT", amt)).toThrow(/mint amount/);
    }
    expect(() => createSignedTokenMint(pub, priv, "", 1)).toThrow(/symbol/);
  });

  it("secureMintTokens posts a signed mint_tokens to /v2/token/mint", async () => {
    const { fetchMock, call } = mockFetch();
    const r = await secureMintTokens(pub, priv, "mnt", 42);
    expect(r.success).toBe(true);
    const { url, body } = call();
    expect(url).toMatch(/\/v2\/token\/mint$/);
    expect(body.payload).toMatchObject({ type: "mint_tokens", token_symbol: "MNT", amount: 42 });
    expect(verifyTransaction(body)).toBe(true);
    const bad = await secureMintTokens(pub, priv, "MNT", 0);
    expect(bad.success).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("supply helpers", () => {
  it("issued supply, remaining room and creator check", () => {
    const capped = { creator: pub, mintable: true, max_supply: 5000, total_minted: 250, initial_supply: 1000 };
    expect(issuedSupply(capped)).toBe(1250);
    expect(mintRoom(capped)).toBe(3750);
    expect(mintRoom({ ...capped, max_supply: null })).toBe(Number.POSITIVE_INFINITY);
    expect(mintRoom({ ...capped, initial_supply: undefined })).toBeNull();
    expect(mintRoom({ ...capped, total_minted: 9000 })).toBe(0);
    expect(canMintToken(capped, pub)).toBe(true);
    expect(canMintToken(capped, "someone-else")).toBe(false);
    expect(canMintToken({ ...capped, mintable: false }, pub)).toBe(false);
    expect(canMintToken(null, pub)).toBe(false);
    expect(canMintToken(capped, null)).toBe(false);
  });
});

describe("fetchTokenMintingActive", () => {
  it("reads /stats on the active network", async () => {
    installStorage();
    const { fetchTokenMintingActive } = await import("../src/secure-api");
    for (const [stats, want] of [
      [{ network_height: 10, upgrade_schedule: { token_minting: null } }, false],
      [{ network_height: 10, upgrade_schedule: { token_minting: 11 } }, true],
      [{ network_height: 10 }, false],
    ] as const) {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify(stats), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      expect(await fetchTokenMintingActive()).toBe(want);
      expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toMatch(/\/stats$/);
    }
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    expect(await fetchTokenMintingActive()).toBe(false);
  });
});
