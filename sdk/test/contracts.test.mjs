// Unit tests for the contracts namespace. Run after `npm run build`: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RougeChain,
  Wallet,
  predictContractAddress,
  suggestGasLimit,
  contractCallFee,
  createSignedContractCall,
  createSignedContractPublish,
  verifyTransaction,
  serializePayload,
  bytesToHex,
  bytesToBase64,
  base64ToBytes,
} from "../dist/index.js";

const WASM_HEADER = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const BYTES_0_255 = Uint8Array.from({ length: 256 }, (_, i) => i);

// Vectors produced by the node's own `v2_binding::contract_address_v2` (copied verbatim into a
// scratch Rust binary, sha2 0.10 + hex 0.4).
test("predictContractAddress matches the node's contract_address_v2", () => {
  assert.equal(
    predictContractAddress("a1".repeat(32), "0123456789abcdef", WASM_HEADER),
    "da4838b80c65667532b6236851a3a565289264d1"
  );
  assert.equal(
    predictContractAddress("deadbeef".repeat(8), "game-nonce-0001", BYTES_0_255),
    "d31d510289ad484b1c38449172db65c59fc71976"
  );
  // base64 input gives the same address
  assert.equal(
    predictContractAddress("a1".repeat(32), "0123456789abcdef", bytesToBase64(WASM_HEADER)),
    "da4838b80c65667532b6236851a3a565289264d1"
  );
  // ArrayBuffer input too
  assert.equal(
    predictContractAddress("deadbeef".repeat(8), "game-nonce-0001", BYTES_0_255.buffer),
    "d31d510289ad484b1c38449172db65c59fc71976"
  );
});

test("base64 helpers round-trip and match Buffer", () => {
  for (const len of [0, 1, 2, 3, 4, 5, 255, 256, 1000]) {
    const b = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 255);
    const enc = bytesToBase64(b);
    assert.equal(enc, Buffer.from(b).toString("base64"));
    assert.deepEqual(base64ToBytes(enc), b);
  }
  assert.throws(() => base64ToBytes("abc"), /invalid base64/);
});

test("gas helpers", () => {
  assert.equal(suggestGasLimit(0), 1000);
  assert.equal(suggestGasLimit(1001), 2502);
  assert.equal(suggestGasLimit(9_000_000), 10_000_000);
  assert.ok(Math.abs(contractCallFee(250_000) - 0.25) < 1e-12);
});

const wallet = Wallet.generateRandom();
const keys = { publicKey: wallet.publicKey, privateKey: wallet.privateKey };

test("createSignedContractCall signs a verifiable contract_call with the exact bytes", () => {
  const tx = createSignedContractCall(keys, "ABCDEF0123456789abcdef0123456789ABCDEF01", "move", { x: 1, y: [2, 3] }, 5000);
  assert.equal(tx.payload.type, "contract_call");
  assert.equal(tx.payload.from, keys.publicKey);
  assert.equal(tx.payload.contractAddr, "abcdef0123456789abcdef0123456789abcdef01");
  assert.equal(tx.payload.gasLimit, 5000);
  assert.ok(tx.payload.nonce.length >= 8);
  assert.equal(typeof tx.payload.timestamp, "number");
  assert.ok(verifyTransaction(tx));
  assert.equal(tx.payload_bytes_hex, bytesToHex(serializePayload(tx.payload)));
  // args default to {} (what the block executor uses when none are signed)
  const t2 = createSignedContractCall(keys, "aa".repeat(20), "tick", undefined, 1);
  assert.deepEqual(t2.payload.args, {});
  assert.throws(() => createSignedContractCall(keys, "aa".repeat(20), "m", {}, 0), /gasLimit/);
  assert.throws(() => createSignedContractCall(keys, "aa".repeat(20), "m", {}, 10_000_001), /gasLimit/);
  assert.throws(() => createSignedContractCall(keys, "aa".repeat(20), "m", {}, 1.5), /gasLimit/);
});

test("createSignedContractPublish binds the predicted address to the signed nonce", () => {
  const { signed, predictedAddress, nonce } = createSignedContractPublish(keys, WASM_HEADER, { nonce: "my-nonce-42" });
  assert.equal(nonce, "my-nonce-42");
  assert.equal(signed.payload.type, "contract_deploy");
  assert.equal(signed.payload.wasm, Buffer.from(WASM_HEADER).toString("base64"));
  assert.equal(predictedAddress, predictContractAddress(keys.publicKey, "my-nonce-42", WASM_HEADER));
  assert.ok(verifyTransaction(signed));
  assert.throws(() => createSignedContractPublish(keys, WASM_HEADER, { nonce: "short" }), /at least 8/);
  const r = createSignedContractPublish(keys, WASM_HEADER);
  assert.ok(r.nonce.length >= 8);
});

/** A fetch mock that records requests and replies from a route table. */
function mockFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const path = url.replace("http://node/api", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method || "GET", body });
    const h = routes[path];
    const [status, json] = typeof h === "function" ? h(body, calls) : h ?? [404, { error: "not found" }];
    return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
  };
  return { fn, calls };
}

test("execute without gasLimit queries first and signs ceil(gasUsed*1.5)+1000", async () => {
  const addr = "bb".repeat(20);
  const { fn, calls } = mockFetch({
    [`/contract/${addr}/query`]: [200, { success: true, returnData: 7, gasUsed: 2000, events: [] }],
    "/v2/contract/execute": (body) => [200, {
      success: true, txId: "t1", fee: body.payload.gasLimit * 0.000001,
      preview: { returnData: 7, gasUsed: 2000, events: [] },
    }],
  });
  const rc = new RougeChain("http://node/api", { fetch: fn });
  const r = await rc.contracts.execute(keys, addr, "play", { card: 3 });
  assert.equal(r.success, true);
  assert.equal(r.txId, "t1");
  assert.equal(r.gasLimit, 4000);
  assert.equal(calls[0].path, `/contract/${addr}/query`);
  assert.deepEqual(calls[0].body, { method: "play", args: { card: 3 }, caller: keys.publicKey });
  const sent = calls[1].body;
  assert.equal(sent.payload.gasLimit, 4000);
  assert.equal(sent.payload.method, "play");
  assert.deepEqual(sent.payload.args, { card: 3 });
  assert.equal(sent.public_key, keys.publicKey);
  assert.ok(verifyTransaction(sent));
});

test("execute with explicit gasLimit skips the query; node refusals come back as errors", async () => {
  const addr = "cc".repeat(20);
  const { fn, calls } = mockFetch({
    "/v2/contract/execute": [400, { success: false, error: "call would fail: out of cards" }],
  });
  const rc = new RougeChain("http://node/api", { fetch: fn });
  const r = await rc.contracts.execute(keys, addr, "draw", {}, { gasLimit: 12345 });
  assert.equal(calls.length, 1);
  assert.equal(r.success, false);
  assert.equal(r.error, "call would fail: out of cards");
  assert.equal(r.gasLimit, 12345);
});

test("execute stops before signing when the query says the call fails", async () => {
  const addr = "dd".repeat(20);
  const { fn, calls } = mockFetch({
    [`/contract/${addr}/query`]: [200, { success: false, gasUsed: 10, events: [], error: "not your turn" }],
  });
  const rc = new RougeChain("http://node/api", { fetch: fn });
  const r = await rc.contracts.execute(keys, addr, "move");
  assert.equal(r.success, false);
  assert.equal(r.error, "not your turn");
  assert.equal(calls.length, 1);
});

test("publish posts a signed deploy and reports the predicted address", async () => {
  let posted;
  const { fn } = mockFetch({
    "/v2/contract/publish": (body) => {
      posted = body;
      return [200, {
        success: true, txId: "t2", fee: 10,
        address: predictContractAddress(body.payload.from, body.payload.nonce, body.payload.wasm),
      }];
    },
  });
  const rc = new RougeChain("http://node/api", { fetch: fn });
  const r = await rc.contracts.publish(keys, BYTES_0_255);
  assert.equal(r.success, true);
  assert.equal(r.address, r.predictedAddress);
  assert.equal(r.fee, 10);
  assert.equal(posted.payload.nonce, r.nonce);
  assert.equal(rc.contracts.predictContractAddress(keys.publicKey, r.nonce, BYTES_0_255), r.address);
});

test("query/get/state/events/list hit the read endpoints", async () => {
  const addr = "ee".repeat(20);
  const { fn, calls } = mockFetch({
    [`/contract/${addr}/query`]: [200, { success: true, returnData: { score: 5 }, gasUsed: 99, events: [] }],
    [`/contract/${addr}`]: [200, { success: true, contract: { address: addr, deployer: "pk", code_hash: "h", created_at: 1, wasm_size: 8 } }],
    [`/contract/${addr}/state`]: [200, { success: true, state: { owner: "pk" }, count: 1 }],
    [`/contract/${addr}/state?key=6f776e6572`]: [200, { success: true, key: "6f776e6572", value: "706b", valueUtf8: "pk" }],
    [`/contract/${addr}/events?limit=10&before=500`]: [200, { success: true, events: [{ contract_addr: addr, topic: "win", data: "{}", block_height: 499, tx_hash: "x" }] }],
    "/contracts": [200, { success: true, contracts: [{ address: addr }], count: 1 }],
  });
  const rc = new RougeChain("http://node/api", { fetch: fn });
  const q = await rc.contracts.query(addr, "score");
  assert.deepEqual(q, { success: true, returnData: { score: 5 }, gasUsed: 99, events: [], error: undefined });
  assert.deepEqual(calls[0].body, { method: "score", args: {} });
  assert.equal((await rc.contracts.get(addr)).wasm_size, 8);
  assert.deepEqual(await rc.contracts.state(addr), { owner: "pk" });
  assert.deepEqual(await rc.contracts.state(addr, new TextEncoder().encode("owner")), { key: "6f776e6572", value: "706b", valueUtf8: "pk" });
  const ev = await rc.contracts.events(addr, { limit: 10, before: 500 });
  assert.equal(ev[0].topic, "win");
  assert.equal((await rc.contracts.list()).length, 1);
});

test("waitForReceipt polls through 404 until the receipt exists", async () => {
  let n = 0;
  const { fn } = mockFetch({
    "/tx/abc/receipt": () => (++n < 3 ? [404, {}] : [200, { success: true, receipt: { tx_hash: "abc", block_height: 7, status: "Success" } }]),
  });
  const rc = new RougeChain("http://node/api", { fetch: fn });
  const rcpt = await rc.contracts.waitForReceipt("abc", { intervalMs: 1, timeoutMs: 1000 });
  assert.equal(rcpt.block_height, 7);
  assert.equal(n, 3);
  await assert.rejects(
    new RougeChain("http://node/api", { fetch: mockFetch({}).fn }).contracts.waitForReceipt("zzz", { intervalMs: 1, timeoutMs: 5 }),
    /not included/
  );
});

/** Minimal fake WebSocket that records instances and sent frames. */
function fakeWs() {
  const sockets = [];
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      sockets.push(this);
    }
    send(d) { this.sent.push(JSON.parse(d)); }
    close() { this.readyState = 3; this.onclose?.({}); }
    _open() { this.readyState = 1; this.onopen?.({}); }
    _msg(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
    _drop() { this.readyState = 3; this.onclose?.({}); }
  }
  return { FakeWS, sockets };
}

test("subscribe shares one socket, filters by contract, resubscribes after reconnect", async () => {
  const { FakeWS, sockets } = fakeWs();
  const rc = new RougeChain("http://node/api", { fetch: mockFetch({}).fn, WebSocket: FakeWS });
  const A = "Aa".repeat(20), B = "bb".repeat(20);
  const gotA = [], gotB = [];
  const offA = rc.contracts.subscribe(A, (e) => gotA.push(e));
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, "ws://node/api/ws");
  sockets[0]._open();
  assert.deepEqual(sockets[0].sent[0], { subscribe: [`contract:${A.toLowerCase()}`] });
  const offB = rc.contracts.subscribe(B, (e) => gotB.push(e));
  assert.equal(sockets.length, 1, "second subscription reuses the socket");
  assert.deepEqual(sockets[0].sent[1], { subscribe: [`contract:${B}`] });

  const frame = { type: "contract_event", contract_addr: A.toLowerCase(), topic: "move", data: "{\"x\":1}", block_height: 9, tx_hash: "t" };
  sockets[0]._msg(frame);
  sockets[0]._msg({ type: "new_block", height: 9 });
  sockets[0]._msg({ ...frame, contract_addr: "ff".repeat(20) });
  assert.equal(gotA.length, 1);
  assert.equal(gotA[0].topic, "move");
  assert.equal(gotB.length, 0);

  // drop → reconnect after backoff (1 s) → both topics resubscribed
  sockets[0]._drop();
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(sockets.length, 2);
  sockets[1]._open();
  assert.deepEqual(new Set(sockets[1].sent[0].subscribe), new Set([`contract:${A.toLowerCase()}`, `contract:${B}`]));

  offA();
  assert.deepEqual(sockets[1].sent[1], { unsubscribe: [`contract:${A.toLowerCase()}`] });
  offB();
  assert.equal(sockets[1].readyState, 3, "socket closes when the last listener leaves");
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(sockets.length, 2, "no reconnect after the last unsubscribe");
});

test("game() helper: call needs a wallet, on() filters by topic, '*' gets all", async () => {
  const { FakeWS, sockets } = fakeWs();
  const addr = "12".repeat(20);
  const { fn, calls } = mockFetch({
    [`/contract/${addr}/query`]: [200, { success: true, returnData: 1, gasUsed: 1, events: [] }],
    "/v2/contract/execute": [200, { success: true, txId: "t3", fee: 0.001 }],
  });
  const rc = new RougeChain("http://node/api", { fetch: fn, WebSocket: FakeWS });
  await assert.rejects(rc.contracts.game(addr).call("x"), /pass a wallet/);
  const g = rc.contracts.game(addr, keys);
  const moves = [], all = [];
  const off1 = g.on("move", (e) => moves.push(e));
  const off2 = g.on("*", (e) => all.push(e));
  sockets[0]._open();
  sockets[0]._msg({ type: "contract_event", contract_addr: addr, topic: "move", data: "", block_height: 1, tx_hash: "a" });
  sockets[0]._msg({ type: "contract_event", contract_addr: addr, topic: "win", data: "", block_height: 1, tx_hash: "b" });
  assert.equal(moves.length, 1);
  assert.equal(all.length, 2);
  const r = await g.call("move", { x: 1 }, { gasLimit: 1000 });
  assert.equal(r.txId, "t3");
  await g.query("board");
  assert.equal(calls.at(-1).body.caller, keys.publicKey);
  off1(); off2();
});
