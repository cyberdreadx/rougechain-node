// TOKEN_MINTING client side: mintable create_token fields and the signed mint_tokens payload must
// match what the node reads (core/daemon/src/v2_binding.rs, main.rs v2_token_mint). Run after
// `npm run build`: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  RougeChain,
  Wallet,
  verifyTransaction,
  createSignedTokenCreation,
  createSignedTokenMint,
  tokenMintFields,
  tokenMintingActive,
  TOKEN_MINT_MAX_AMOUNT,
  TOKEN_MINT_FEE_XRGE,
} from "../dist/index.js";

const binding = readFileSync(new URL("../../core/daemon/src/v2_binding.rs", import.meta.url), "utf8");
const nodeRs = readFileSync(new URL("../../core/daemon/src/node.rs", import.meta.url), "utf8");

function capture(stats) {
  const posts = [];
  const gets = [];
  const fn = async (url, init) => {
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(init.body) });
    } else {
      gets.push(url);
    }
    const body = init?.method === "POST" ? { success: true } : stats ?? {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { posts, gets, rc: new RougeChain("http://node/api", { fetch: fn }) };
}

const wallet = Wallet.generate();

test("constants match the node", () => {
  const max = /pub const TOKEN_MINT_MAX_AMOUNT: u64 = ([0-9_]+);/.exec(nodeRs);
  assert.ok(max, "TOKEN_MINT_MAX_AMOUNT not found in node.rs");
  assert.equal(TOKEN_MINT_MAX_AMOUNT, Number(max[1].replace(/_/g, "")));
  assert.equal(TOKEN_MINT_MAX_AMOUNT, Number.MAX_SAFE_INTEGER);
  const fee = /"mint_tokens" => \(TxPayload \{[^\n]*\}, ([0-9.]+)\)/.exec(binding);
  assert.ok(fee, "mint_tokens fee not found in v2_binding.rs");
  assert.equal(TOKEN_MINT_FEE_XRGE, Number(fee[1]));
  // The node reads exactly these signed field names.
  assert.match(binding, /p\.get\("mintable"\)/);
  assert.match(binding, /p\.get\("max_supply"\)/);
  assert.match(binding, /"mint_tokens" => \(TxPayload \{ token_symbol: Some\(s\(p, "token_symbol"\)\), token_total_supply: Some\(u\(p, "amount"\)\)/);
});

test("fixed-supply createToken sends no mint fields (unchanged pre-fork payload)", async () => {
  for (const extra of [{}, { mintable: false }]) {
    const { posts, rc } = capture();
    const r = await rc.createToken(wallet, { name: "Fixed", symbol: "FIX", totalSupply: 1000, ...extra });
    assert.equal(r.success, true);
    const p = posts[0].body.payload;
    assert.match(posts[0].url, /\/v2\/token\/create$/);
    assert.equal(p.type, "create_token");
    assert.equal("mintable" in p, false);
    assert.equal("max_supply" in p, false);
    assert.equal(verifyTransaction(posts[0].body), true);
  }
});

test("mintable createToken signs mintable: true and an optional integer max_supply", async () => {
  {
    const { posts, rc } = capture();
    await rc.createToken(wallet, { name: "Mint", symbol: "MNT", totalSupply: 1000, mintable: true });
    const p = posts[0].body.payload;
    assert.equal(p.mintable, true);
    assert.equal("max_supply" in p, false);
    assert.equal(p.initial_supply, 1000);
    assert.equal(verifyTransaction(posts[0].body), true);
  }
  {
    const { posts, rc } = capture();
    await rc.createToken(wallet, { name: "Capped", symbol: "CAP", totalSupply: 1000, mintable: true, maxSupply: 5000, description: "d" });
    const p = posts[0].body.payload;
    assert.equal(p.mintable, true);
    assert.equal(p.max_supply, 5000);
    assert.equal(p.description, "d");
    assert.equal(p.fee, 100);
    assert.equal(verifyTransaction(posts[0].body), true);
  }
  // max_supply == initial supply is allowed (node: max >= initial).
  assert.deepEqual(tokenMintFields(10, { mintable: true, maxSupply: 10 }), { mintable: true, max_supply: 10 });
});

test("invalid mint options are refused client-side and never posted", async () => {
  const bad = [
    { totalSupply: 1000, maxSupply: 5000 }, // cap without mintable
    { totalSupply: 1000, mintable: true, maxSupply: 999 }, // below initial
    { totalSupply: 1000, mintable: true, maxSupply: 1500.5 }, // not an integer
    { totalSupply: 1000, mintable: true, maxSupply: TOKEN_MINT_MAX_AMOUNT + 1 }, // too big
    { totalSupply: 1.5, mintable: true }, // mintable initial supply must be an integer
    { totalSupply: 1000, mintable: "yes" },
  ];
  for (const b of bad) {
    const { posts, rc } = capture();
    const r = await rc.createToken(wallet, { name: "Bad", symbol: "BAD", ...b });
    assert.equal(r.success, false, JSON.stringify(b));
    assert.ok(r.error);
    assert.equal(posts.length, 0);
  }
  assert.throws(() => createSignedTokenCreation(wallet, "N", "S", 10, 100, undefined, { mintable: true, maxSupply: 9 }), /below the initial supply/);
  assert.throws(() => createSignedTokenCreation(wallet, "N", "S", 10, 100, undefined, { maxSupply: 20 }), /requires mintable/);
});

test("mintTokens posts a signed mint_tokens (not the old unsigned body)", async () => {
  const { posts, rc } = capture();
  const r = await rc.mintTokens(wallet, { symbol: "mnt", amount: 250 });
  assert.equal(r.success, true);
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/v2\/token\/mint$/);
  const body = posts[0].body;
  assert.equal(body.public_key, wallet.publicKey);
  assert.ok(body.signature.length > 100);
  assert.deepEqual(Object.keys(body.payload).sort(), ["amount", "fee", "from", "nonce", "timestamp", "token_symbol", "type"]);
  assert.equal(body.payload.type, "mint_tokens");
  assert.equal(body.payload.token_symbol, "MNT");
  assert.equal(body.payload.amount, 250);
  assert.equal(body.payload.fee, 1);
  assert.equal(body.payload.from, wallet.publicKey);
  assert.equal("symbol" in body, false);
  assert.equal(verifyTransaction(body), true);
});

test("mintTokens refuses invalid amounts client-side", async () => {
  for (const amount of [0, -5, 1.5, TOKEN_MINT_MAX_AMOUNT + 1, Number.NaN, "10"]) {
    const { posts, rc } = capture();
    const r = await rc.mintTokens(wallet, { symbol: "MNT", amount });
    assert.equal(r.success, false, String(amount));
    assert.equal(posts.length, 0);
  }
  assert.throws(() => createSignedTokenMint(wallet, "  ", 5), /symbol is required/);
  const tx = createSignedTokenMint(wallet, "abc", TOKEN_MINT_MAX_AMOUNT, 1, 7);
  assert.equal(tx.payload.amount, TOKEN_MINT_MAX_AMOUNT);
  assert.equal(tx.payload.account_nonce, 7);
});

test("tokenMintingActive / isTokenMintingActive read upgrade_schedule.token_minting", async () => {
  assert.equal(tokenMintingActive(undefined), false);
  assert.equal(tokenMintingActive({ network_height: 500 }), false);
  assert.equal(tokenMintingActive({ network_height: 500, upgrade_schedule: { token_minting: null } }), false);
  assert.equal(tokenMintingActive({ network_height: 498, upgrade_schedule: { token_minting: 500 } }), false);
  assert.equal(tokenMintingActive({ network_height: 499, upgrade_schedule: { token_minting: 500 } }), true);
  assert.equal(tokenMintingActive({ network_height: 900, upgrade_schedule: { token_minting: 500 } }), true);
  const off = capture({ network_height: 10, upgrade_schedule: { network: "mainnet", token_minting: null } });
  assert.equal(await off.rc.isTokenMintingActive(), false);
  assert.match(off.gets[0], /\/stats$/);
  const on = capture({ network_height: 10, upgrade_schedule: { network: "testnet", token_minting: 5 } });
  assert.equal(await on.rc.isTokenMintingActive(), true);
});
