// Signed payloads must match what the node derives (core/daemon/src/v2_binding.rs). Run after
// `npm run build`: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RougeChain, Wallet, verifyTransaction } from "../dist/index.js";

const binding = readFileSync(new URL("../../core/daemon/src/v2_binding.rs", import.meta.url), "utf8");
const arm = (from, to) => binding.slice(binding.indexOf(from), binding.indexOf(to));

function capture() {
  const posts = [];
  const fn = async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { posts, rc: new RougeChain("http://node/api", { fetch: fn }) };
}

const wallet = Wallet.generate();
const ATTRS = [{ rarity: "rare" }, [{ trait_type: "color", value: "red" }]];

test("nft.batchMint signs per-NFT attributes as `attributes` (the field the node reads)", async () => {
  assert.match(arm('"nft_batch_mint" =>', '"nft_transfer" =>'), /p\.get\("attributes"\)/);
  for (const params of [{ attributes: ATTRS }, { batchAttributes: ATTRS }]) {
    const { posts, rc } = capture();
    await rc.nft.batchMint(wallet, { collectionId: "col:abc:SYM", names: ["A", "B"], uris: ["u1", "u2"], ...params });
    assert.equal(posts.length, 1);
    assert.match(posts[0].url, /\/v2\/nft\/batch-mint$/);
    const tx = posts[0].body;
    assert.deepEqual(tx.payload.attributes, ATTRS);
    assert.equal("batchAttributes" in tx.payload, false);
    assert.equal(tx.payload.fee, 10);
    assert.equal(verifyTransaction(tx), true);
  }
});

test("createToken's default fee is the fee the node charges for create_token", async () => {
  // The arm is either `=> (TxPayload {…}, 100.0),` or a block `=> { …; (TxPayload {…}, 100.0) }`.
  const m = /\},\s*([0-9]+(?:\.[0-9]+)?)\)\s*,?\s*\}?\s*$/.exec(arm('"create_token" =>', '"mint_tokens" =>').trim());
  assert.ok(m, "create_token fee not found in v2_binding.rs");
  const { posts, rc } = capture();
  await rc.createToken(wallet, { name: "Name", symbol: "SYM", totalSupply: 1000 });
  assert.equal(posts[0].body.payload.fee, Number(m[1]));
  assert.equal(posts[0].body.payload.fee, 100);
});
