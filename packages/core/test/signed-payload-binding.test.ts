/**
 * Signed payloads must carry exactly the fields the node derives the tx from
 * (core/daemon/src/v2_binding.rs `derive_v2_fields`); read the binding so the two can't drift.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { createSignedNftBatchMint, createSignedTokenCreation, verifyTransaction } from "../src/pqc-signer";
import { secureBatchMintNft, secureCreateToken } from "../src/secure-api";
import { installStorage } from "./storage-shim";

const here = path.dirname(fileURLToPath(import.meta.url));
const binding = readFileSync(path.resolve(here, "../../../core/daemon/src/v2_binding.rs"), "utf8");
const arm = (from: string, to: string) => binding.slice(binding.indexOf(from), binding.indexOf(to));

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const kp = ml_dsa65.keygen(new Uint8Array(32).fill(3));
const pub = hex(kp.publicKey);
const priv = hex(kp.secretKey);
const ATTRS = [{ rarity: "rare" }, [{ trait_type: "color", value: "red" }]];

afterEach(() => vi.unstubAllGlobals());

describe("nft_batch_mint attributes", () => {
  it("the node reads per-NFT batch attributes from `attributes`", () => {
    expect(arm('"nft_batch_mint" =>', '"nft_transfer" =>')).toContain('p.get("attributes")');
  });

  it("createSignedNftBatchMint signs them as `attributes` (and maps the deprecated batchAttributes)", () => {
    for (const opts of [{ attributes: ATTRS }, { batchAttributes: ATTRS }]) {
      const tx = createSignedNftBatchMint(pub, priv, "col:abc:SYM", ["A", "B"], { uris: ["u1", "u2"], ...opts });
      expect(tx.payload.attributes).toEqual(ATTRS);
      expect("batchAttributes" in tx.payload).toBe(false);
      expect(verifyTransaction(tx)).toBe(true); // attributes are inside the signed bytes
    }
  });

  it("secureBatchMintNft posts the signed `attributes` field to /v2/nft/batch-mint", async () => {
    installStorage();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await secureBatchMintNft(pub, priv, "col:abc:SYM", ["A", "B"], { attributes: ATTRS });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/v2\/nft\/batch-mint$/);
    const body = JSON.parse(String(init.body));
    expect(body.payload.attributes).toEqual(ATTRS);
    expect(body.payload.batchAttributes).toBeUndefined();
    expect(verifyTransaction(body)).toBe(true);
  });
});

describe("create_token fee default", () => {
  const nodeFee = () => {
    // `=> (TxPayload {…}, 100.0),` or a block arm `=> { …; (TxPayload {…}, 100.0) }`.
    const m = /\},\s*([0-9]+(?:\.[0-9]+)?)\)\s*,?\s*\}?\s*$/.exec(arm('"create_token" =>', '"mint_tokens" =>').trim());
    expect(m, "could not find the create_token fee in v2_binding.rs").not.toBeNull();
    return Number(m![1]);
  };
  it("matches the fee the node charges", async () => {
    expect(nodeFee()).toBe(100);
    expect(createSignedTokenCreation(pub, priv, "Name", "SYM", 1000).payload.fee).toBe(nodeFee());
    installStorage();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await secureCreateToken(pub, priv, "Name", "SYM", 1000);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).payload.fee).toBe(nodeFee());
  });
});
