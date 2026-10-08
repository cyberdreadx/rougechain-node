// verifyTxFinalized in the published build, against real mainnet data captured read-only from a
// node. The full tamper matrix lives in packages/core/test/finality-verify.test.ts (the two source
// files are kept identical by that test). Run after `npm run build`: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  verifyTxFinalized,
  fetchAndVerifyBlock,
  computeBlockHash,
  parseJsonLossless,
  stringifyLossless,
  voteSigningMessage,
} from "../dist/index.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/finality-mainnet.json", import.meta.url), "utf8"));
const NODE = "http://node-a.test/api";
const fetchFrom = (resp) => async (url) => {
  const body = resp[url.slice(NODE.length)];
  return body === undefined ? { ok: false, status: 404, text: async () => "" } : { ok: true, status: 200, text: async () => body };
};
const tx249 = fx.txs["249"];
const B249 = "/blocks?from_height=249&limit=2";

test("a real mainnet transaction verifies as finalized; the outcome is reported unverified", async () => {
  const r = await verifyTxFinalized({ txHash: tx249, nodes: [NODE], chainId: fx.chainId, fetch: fetchFrom(fx.responses) });
  assert.equal(r.status, "finalized");
  assert.equal(r.height, 249);
  assert.equal(r.blockHash, "cef10c4f32fb585f078dbe92509db0fe1b255414dbf7f3b9c975ee4d15528659");
  assert.equal(r.trust, "node-reported validator set");
  assert.deepEqual(r.outcome, { source: "node receipt", verified: false, value: "Success" });
  assert.ok(r.checks.length > 10);
  assert.ok(r.checks.every((c) => c.ok || !c.critical));
});

test("a removed transaction fails the header tx_hash check", async () => {
  const d = parseJsonLossless(fx.responses[B249]);
  d.blocks[0].txs = [];
  const r = await verifyTxFinalized({ txHash: tx249, nodes: [NODE], chainId: fx.chainId, fetch: fetchFrom({ ...fx.responses, [B249]: stringifyLossless(d) }) });
  assert.equal(r.status, "invalid");
  assert.deepEqual(r.checks.filter((c) => !c.ok && c.critical).map((c) => c.name), ["block.tx_hash"]);
});

test("a not-yet-finalized tip is included-not-finalized", async () => {
  const resp = { ...fx.responses, "/finality/252": fx.responses["/finality/253"] };
  const r = await verifyTxFinalized({ txHash: fx.txs["252"], nodes: [NODE], chainId: fx.chainId, fetch: fetchFrom(resp) });
  assert.equal(r.status, "included-not-finalized");
});

test("fetchAndVerifyBlock + block hash + vote message", async () => {
  const r = await fetchAndVerifyBlock(249, { node: NODE, chainId: fx.chainId, fetch: fetchFrom(fx.responses) });
  assert.equal(r.ok, true);
  const b = parseJsonLossless(fx.responses[B249]).blocks[0];
  assert.equal(computeBlockHash(b.header, b.proposer_sig), b.hash);
  assert.equal(voteSigningMessage("c", "precommit", 1, 0, "h"), "ROUGECHAIN_FINALITY_VOTE_V2|chain=c|type=precommit|height=1|round=0|block=h");
});
