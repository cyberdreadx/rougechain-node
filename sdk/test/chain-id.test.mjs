// Network binding: every payload the SDK signs carries the network's chain id inside the signed
// bytes. Run after `npm run build`: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RougeChain,
  Wallet,
  verifyTransaction,
  serializePayload,
  createSignedTransfer,
  signRequest,
  bindWalletToChain,
  ChainIdMismatchError,
  MAINNET_CHAIN_ID,
  TESTNET_CHAIN_ID,
} from "../dist/index.js";

const wallet = Wallet.generate();

function node(chainId) {
  const posts = [];
  let healthCalls = 0;
  const fn = async (url, init) => {
    if (url.endsWith("/health")) {
      healthCalls++;
      return new Response(JSON.stringify({ status: "ok", chain_id: chainId, height: 1 }), { status: 200 });
    }
    posts.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };
  return { posts, fn, health: () => healthCalls };
}

test("chain ids", () => {
  assert.equal(MAINNET_CHAIN_ID, "rougechain-mainnet-1");
  assert.equal(TESTNET_CHAIN_ID, "rougechain-devnet-1");
});

test("builders bind the wallet's chain id inside the signed bytes", () => {
  const bound = bindWalletToChain(wallet, MAINNET_CHAIN_ID);
  assert.equal(bound.publicKey, wallet.publicKey);
  const tx = createSignedTransfer(bound, "ab".repeat(16), 5);
  assert.equal(tx.payload.chainId, MAINNET_CHAIN_ID);
  assert.ok(new TextDecoder().decode(serializePayload(tx.payload)).includes(`"chainId":"${MAINNET_CHAIN_ID}"`));
  assert.ok(verifyTransaction(tx));
  // re-targeting the payload breaks the signature
  assert.equal(verifyTransaction({ ...tx, payload: { ...tx.payload, chainId: TESTNET_CHAIN_ID } }), false);
  const req = signRequest(bound, { folder: "inbox" });
  assert.equal(req.payload.chainId, MAINNET_CHAIN_ID);
  assert.ok(verifyTransaction(req));
  // an unbound wallet signs exactly as before (no chainId field)
  assert.equal("chainId" in createSignedTransfer(wallet, "ab".repeat(16), 5).payload, false);
  assert.throws(() => bindWalletToChain(bound, TESTNET_CHAIN_ID), ChainIdMismatchError);
  assert.throws(() => signRequest(bound, { chainId: TESTNET_CHAIN_ID }), /CHAIN_ID_MISMATCH/);
});

test("client: configured chain id matching the node is signed into every payload; checked once", async () => {
  const n = node(TESTNET_CHAIN_ID);
  const rc = new RougeChain("http://node/api", { fetch: n.fn, chainId: TESTNET_CHAIN_ID });
  await rc.transfer(wallet, { to: "ab".repeat(16), amount: 1 });
  await rc.mail.registerName(wallet, "alice", "w1");
  await rc.messenger.markRead(wallet, "m1", "c1");
  await rc.nft.burn(wallet, { collectionId: "col", tokenId: 1 });
  assert.equal(n.health(), 1, "one chain-id check per client");
  assert.ok(n.posts.length >= 3);
  for (const p of n.posts) {
    assert.equal(p.body.payload.chainId, TESTNET_CHAIN_ID, p.url);
    assert.ok(verifyTransaction(p.body), p.url);
  }
});

test("client: refuses to sign when the node reports another chain id", async () => {
  const n = node(MAINNET_CHAIN_ID);
  const rc = new RougeChain("http://node/api", { fetch: n.fn, chainId: TESTNET_CHAIN_ID });
  await assert.rejects(rc.transfer(wallet, { to: "ab".repeat(16), amount: 1 }), (e) => e instanceof ChainIdMismatchError && e.code === "CHAIN_ID_MISMATCH");
  await assert.rejects(rc.getChainId(), ChainIdMismatchError);
  assert.equal(n.posts.length, 0, "nothing was signed or sent");
  const r = await rc.contracts.execute(wallet, "bb".repeat(20), "m", {}, { gasLimit: 1000 });
  assert.equal(r.success, false);
  assert.match(r.error, /CHAIN_ID_MISMATCH/);
  assert.equal(n.posts.length, 0);
});

test("client: without a configured chain id the node's is adopted", async () => {
  const n = node(MAINNET_CHAIN_ID);
  const rc = new RougeChain("http://node/api", { fetch: n.fn });
  assert.equal(rc.knownChainId(), undefined);
  await rc.stake(wallet, { amount: 10000 });
  assert.equal(n.posts[0].body.payload.chainId, MAINNET_CHAIN_ID);
  assert.equal(rc.knownChainId(), MAINNET_CHAIN_ID);
  assert.equal(rc.messenger.realtimeAuth(wallet).auth.payload.chainId, MAINNET_CHAIN_ID);
});

test("client: contract publish/execute payloads carry the chain id in payload_bytes_hex", async () => {
  const n = node(MAINNET_CHAIN_ID);
  const rc = new RougeChain("http://node/api", { fetch: n.fn, chainId: MAINNET_CHAIN_ID });
  await rc.contracts.execute(wallet, "bb".repeat(20), "m", {}, { gasLimit: 1000 });
  const sent = n.posts[0].body;
  assert.equal(sent.payload.chainId, MAINNET_CHAIN_ID);
  assert.ok(Buffer.from(sent.payload_bytes_hex, "hex").toString().includes(`"chainId":"${MAINNET_CHAIN_ID}"`));
  assert.ok(verifyTransaction(sent));
});
