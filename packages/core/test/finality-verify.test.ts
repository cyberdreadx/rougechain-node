/**
 * verifyTxFinalized / fetchAndVerifyBlock against REAL mainnet data (fixtures captured read-only
 * from a node), plus one tamper per check: each must fail the check it is about.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FINALITY_VOTE_DOMAIN_V2,
  JsonNumber,
  computeBlockHash,
  computeSingleTxHash,
  computeTxListHash,
  encodeHeaderV1,
  encodeTxV1,
  fetchAndVerifyBlock,
  finalityQuorum,
  formatF64,
  parseJsonLossless,
  stringifyLossless,
  verifyBlock,
  verifyFinalityCertificate,
  verifyTxFinalized,
  voteSigningMessage,
  type FetchLike,
  type FinalityCheck,
  type LosslessJson,
  type TrustedValidatorSet,
} from "../src/finality-verify";
import fixture from "./fixtures/finality-mainnet.json";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = (p: string) => readFileSync(path.resolve(here, "../../..", p), "utf8");

type Resp = Record<string, string>;
const CHAIN = fixture.chainId;
const TX249 = fixture.txs["249"];
const TX151 = fixture.txs["151"];
const TX252 = fixture.txs["252"];
const base: Resp = fixture.responses;
const A = "http://node-a.test/api", B = "http://node-b.test/api", C = "http://node-c.test/api";

/** A fetch over recorded responses. `null` = node unreachable. */
function fakeFetch(nodes: Record<string, Resp | null>): FetchLike {
  return async (url: string) => {
    for (const [nodeBase, resp] of Object.entries(nodes)) {
      if (!url.startsWith(nodeBase + "/")) continue;
      if (!resp) throw new Error("connect ECONNREFUSED");
      const p = url.slice(nodeBase.length);
      let body = resp[p];
      const m = p.match(/^\/blocks\?from_height=(\d+)&limit=1$/);
      if (body === undefined && m && resp[`/blocks?from_height=${m[1]}&limit=2`] !== undefined) {
        const d = parseJsonLossless(resp[`/blocks?from_height=${m[1]}&limit=2`]) as any;
        d.blocks = d.blocks.slice(0, 1);
        body = stringifyLossless(d);
      }
      if (body === undefined) return { ok: false, status: 404, text: async () => "" };
      return { ok: true, status: 200, text: async () => body };
    }
    throw new Error(`unknown host in ${url}`);
  };
}
/** Copy of `resp` with the body at `p` parsed losslessly, mutated, and re-serialized. */
function tamper(resp: Resp, p: string, fn: (d: any) => void): Resp {
  const d = parseJsonLossless(resp[p]) as any;
  fn(d);
  return { ...resp, [p]: stringifyLossless(d) };
}
const without = (resp: Resp, ...paths: string[]): Resp => { const r = { ...resp }; for (const p of paths) delete r[p]; return r; };
const B249 = "/blocks?from_height=249&limit=2";
const flipHex = (s: string, at = 10) => s.slice(0, at) + (s[at] === "0" ? "1" : "0") + s.slice(at + 1);
const failed = (checks: FinalityCheck[]) => checks.filter((c) => !c.ok && c.critical).map((c) => c.name);
const blocksOf = (p: string) => (parseJsonLossless(base[p]) as any).blocks;

const nodeSet = (): TrustedValidatorSet => {
  const v = (parseJsonLossless(base["/validators"]) as any).validators;
  return { validators: v.filter((x: any) => x.status === "active").map((x: any) => ({ publicKey: x.publicKey, stake: BigInt(x.stake.raw) })) };
};
const VOTER = (blocksOf(B249)[1].header.parent_commit.precommit_votes[0].voter_pub_key) as string;

describe("encoding: exact bytes the node hashes and signs", () => {
  it("formatF64 matches serde_json (zmij) output", () => {
    const table: [number, string][] = [
      [0, "0.0"], [1, "1.0"], [100, "100.0"], [0.1, "0.1"], [0.001, "0.001"], [1.5e-5, "0.000015"], [1e-6, "1e-6"],
      [1.25e-7, "1.25e-7"], [1e15, "1000000000000000.0"], [1e16, "1e+16"], [123456789012345680, "1.2345678901234568e+17"],
      [542.1159690000002, "542.1159690000002"], [-2.5, "-2.5"], [-0, "-0.0"], [1.7976931348623157e308, "1.7976931348623157e+308"],
    ];
    for (const [x, s] of table) expect(formatF64(x)).toBe(s);
  });

  it("the vote message is the domain-tagged, pipe-separated string", () => {
    expect(voteSigningMessage("rougechain-mainnet-1", "precommit", 249, 0, "ab".repeat(32)))
      .toBe(`${FINALITY_VOTE_DOMAIN_V2}|chain=rougechain-mainnet-1|type=precommit|height=249|round=0|block=${"ab".repeat(32)}`);
  });

  it("quorum is floor(2T/3)+1", () => {
    expect(finalityQuorum(BigInt(100109000))).toBe(BigInt(66739334));
    expect(finalityQuorum(BigInt(3))).toBe(BigInt(3));
    expect(finalityQuorum(BigInt(119000))).toBe(BigInt(79334));
  });

  it("recomputes the real tx hashes, header tx_hash and block hashes of mainnet blocks 151, 152, 249, 250, 252", () => {
    const expectHashes: Record<string, string> = {};
    for (const p of [B249, "/blocks?from_height=151&limit=2", "/blocks?from_height=252&limit=2"]) {
      for (const b of blocksOf(p)) {
        expect(computeTxListHash(b.txs)).toBe(b.header.tx_hash);
        expect(computeBlockHash(b.header, b.proposer_sig)).toBe(b.hash);
        expectHashes[b.header.height.raw] = b.hash;
      }
    }
    expect(Object.keys(expectHashes).sort()).toEqual(["151", "152", "249", "250", "252"]);
    expect(expectHashes["249"]).toBe("cef10c4f32fb585f078dbe92509db0fe1b255414dbf7f3b9c975ee4d15528659");
    expect(computeSingleTxHash(blocksOf(B249)[0].txs[0])).toBe(TX249);
    expect(computeSingleTxHash(blocksOf("/blocks?from_height=151&limit=2")[0].txs[0])).toBe(TX151);
  });

  it("header encoding keeps serde field order and omits absent optional fields", () => {
    const h = blocksOf(B249)[0].header;
    const enc = encodeHeaderV1(h);
    expect(enc.startsWith('{"version":1,"chain_id":"rougechain-mainnet-1","height":249,"time":')).toBe(true);
    expect(enc.indexOf('"state_root"')).toBeLessThan(enc.indexOf('"parent_commit"'));
    delete h.parent_commit; delete h.state_root;
    expect(encodeHeaderV1(h)).not.toContain("parent_commit");
    expect(encodeHeaderV1(h)).not.toContain("state_root");
  });

  it("transaction encoding refuses unknown fields and out-of-range integers (fail closed)", () => {
    const tx = blocksOf(B249)[0].txs[0];
    expect(() => encodeTxV1({ ...tx, extra: 1 } as LosslessJson)).toThrow(/unexpected field "extra"/);
    expect(() => encodeTxV1({ ...tx, payload: { ...tx.payload, novel_field: "x" } } as LosslessJson)).toThrow(/unexpected field "novel_field"/);
    expect(() => encodeTxV1({ ...tx, nonce: new JsonNumber("18446744073709551616") } as LosslessJson)).toThrow(/out of range/);
    expect(() => encodeTxV1({ ...tx, nonce: new JsonNumber("1.5") } as LosslessJson)).toThrow(/unsigned integer/);
  });

  it("the transaction list hash depends on order", () => {
    const a = blocksOf(B249)[0].txs[0], b = blocksOf(B249)[1].txs[0];
    expect(computeTxListHash([a, b])).not.toBe(computeTxListHash([b, a]));
  });

  it("lossless JSON keeps u64/u128 digits and rejects duplicate keys", () => {
    const v = parseJsonLossless('{"a":18446744073709551615,"b":340282366920938463463374607431768211455}') as any;
    expect(v.a.raw).toBe("18446744073709551615");
    expect(stringifyLossless(v)).toBe('{"a":18446744073709551615,"b":340282366920938463463374607431768211455}');
    expect(() => parseJsonLossless('{"a":1,"a":2}')).toThrow(/duplicate/);
  });
});

describe("honest verification on real mainnet data", () => {
  it("block 249 + its certificate (from block 250's parent_commit): finalized, node-reported set", async () => {
    const r = await verifyTxFinalized({ txHash: TX249, nodes: [A], chainId: CHAIN, fetch: fakeFetch({ [A]: base }) });
    expect(failed(r.checks)).toEqual([]);
    expect(r.status).toBe("finalized");
    expect(r.height).toBe(249);
    expect(r.blockHash).toBe("cef10c4f32fb585f078dbe92509db0fe1b255414dbf7f3b9c975ee4d15528659");
    expect(r.txIndex).toBe(0);
    expect(r.trust).toBe("node-reported validator set");
    expect(r.proof!.certificateSource).toBe("parent_commit of the next block");
    expect(r.proof!.certificate!.voters).toEqual([VOTER]);
    expect(r.proof!.certificate!.quorum).toBe("66739334");
    expect(r.outcome).toEqual({ source: "node receipt", verified: false, value: "Success" });
    for (const name of ["tx.lookup", "block.shape", "block.chain_id", "block.tx_hash", "block.hash", "block.proposer_signature", "tx.in_block", "validator_set", "finality.certificate", "cert.vote[0]", "cert.quorum", "nodes.majority"])
      expect(r.checks.find((c) => c.name === name)?.ok, name).toBe(true);
  });

  it("pinned validator set + three agreeing nodes", async () => {
    const r = await verifyTxFinalized({ txHash: TX249, nodes: [A, B, C], chainId: CHAIN, trustedValidatorSet: nodeSet(), fetch: fakeFetch({ [A]: base, [B]: base, [C]: base }) });
    expect(failed(r.checks)).toEqual([]);
    expect(r.status).toBe("finalized");
    expect(r.trust).toBe("pinned validator set");
    expect(r.proof!.nodesAgreeing).toEqual([A, B, C]);
  });

  it("a pinned set declared for the height makes the certificate's aggregate claims binding (and they match at 249)", async () => {
    const r = await verifyTxFinalized({ txHash: TX249, nodes: [A], chainId: CHAIN, trustedValidatorSet: { ...nodeSet(), height: 249 }, fetch: fakeFetch({ [A]: base }) });
    expect(r.status).toBe("finalized");
    expect(r.checks.filter((c) => c.name.startsWith("cert.claim.")).every((c) => c.ok && c.critical)).toBe(true);
  });

  it("block 151 (first parent_commit era, signed-payload tx) is finalized", async () => {
    const r = await verifyTxFinalized({ txHash: TX151, nodes: [A], chainId: CHAIN, fetch: fakeFetch({ [A]: base }) });
    expect(failed(r.checks)).toEqual([]);
    expect(r.status).toBe("finalized");
    expect(r.height).toBe(151);
  });

  it("at the tip (no next block) the certificate comes from /api/finality/:height", async () => {
    const r = await verifyTxFinalized({ txHash: TX252, nodes: [A], chainId: CHAIN, fetch: fakeFetch({ [A]: base }) });
    expect(r.status).toBe("finalized");
    expect(r.proof!.certificateSource).toBe("/api/finality/:height");
  });

  it("a not-yet-finalized tip returns included-not-finalized", async () => {
    const resp = { ...base, "/finality/252": base["/finality/253"] };
    const r = await verifyTxFinalized({ txHash: TX252, nodes: [A], chainId: CHAIN, fetch: fakeFetch({ [A]: resp }) });
    expect(r.status).toBe("included-not-finalized");
    expect(r.height).toBe(252);
    expect(r.checks.find((c) => c.name === "finality.certificate")!.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "tx.in_block")!.ok).toBe(true);
  });

  it("fetchAndVerifyBlock returns the verified block and the next block", async () => {
    const r = await fetchAndVerifyBlock(249, { node: "http://node-a.test", chainId: CHAIN, fetch: fakeFetch({ [A]: base }) });
    expect(r.ok).toBe(true);
    expect(r.block!.txHashes).toEqual([TX249]);
    expect(r.next!.header).toBeTruthy();
  });

  it("the execution outcome is never verified: a 'Failed' receipt still yields finalized, verified: false", async () => {
    const resp = tamper(base, `/tx/${TX249}`, (d) => { d.receipt.status = { Failed: "insufficient balance" }; });
    const r = await verifyTxFinalized({ txHash: TX249, nodes: [A], chainId: CHAIN, fetch: fakeFetch({ [A]: resp }) });
    expect(r.status).toBe("finalized");
    expect(r.outcome.verified).toBe(false);
    expect(r.outcome.value).toEqual({ Failed: "insufficient balance" });
  });
});

describe("each tamper fails the right check", () => {
  const run = async (resp: Resp, extra: Partial<Parameters<typeof verifyTxFinalized>[0]> = {}) =>
    verifyTxFinalized({ txHash: TX249, nodes: [A], chainId: CHAIN, fetch: fakeFetch({ [A]: resp }), ...extra });
  const block250tx = blocksOf(B249)[1].txs[0];

  it("transaction removed from the block list", async () => {
    const r = await run(tamper(base, B249, (d) => { d.blocks[0].txs = []; }));
    expect(r.status).toBe("invalid");
    expect(failed(r.checks)).toEqual(["block.tx_hash"]);
  });

  it("transaction added to the block list", async () => {
    const r = await run(tamper(base, B249, (d) => { d.blocks[0].txs.push(block250tx); }));
    expect(r.status).toBe("invalid");
    expect(failed(r.checks)).toEqual(["block.tx_hash"]);
  });

  it("transactions reordered", async () => {
    const r = await run(tamper(base, B249, (d) => { d.blocks[0].txs = [block250tx, d.blocks[0].txs[0]]; }));
    expect(r.status).toBe("invalid");
    expect(failed(r.checks)).toEqual(["block.tx_hash"]);
  });

  it("a transaction's content altered (amount)", async () => {
    const r = await run(tamper(base, B249, (d) => { d.blocks[0].txs[0].payload.amount = new JsonNumber("75000000"); }));
    expect(r.status).toBe("invalid");
    expect(failed(r.checks)).toEqual(["block.tx_hash"]);
  });

  it("header tx_hash altered to match a forged list: the block hash and proposer signature catch it", async () => {
    const r = await run(tamper(base, B249, (d) => { d.blocks[0].txs.push(block250tx); d.blocks[0].header.tx_hash = computeTxListHash(d.blocks[0].txs); }));
    expect(r.status).toBe("invalid");
    expect(failed(r.checks)).toEqual(["block.hash", "block.proposer_signature"]);
  });

  it("header tx_hash altered alone", async () => {
    const r = await run(tamper(base, B249, (d) => { d.blocks[0].header.tx_hash = flipHex(d.blocks[0].header.tx_hash); }));
    expect(failed(r.checks)).toEqual(["block.tx_hash", "block.hash", "block.proposer_signature"]);
  });

  it("header field altered (time), even with the node's hash field updated to match", async () => {
    const r = await run(tamper(base, B249, (d) => {
      const b = d.blocks[0];
      b.header.time = new JsonNumber(String(BigInt(b.header.time.raw) + BigInt(1)));
      b.hash = computeBlockHash(b.header, b.proposer_sig);
    }));
    expect(r.status).toBe("invalid");
    expect(failed(r.checks)).toEqual(["block.proposer_signature"]);
  });

  it("proposer signature altered", async () => {
    const r = await run(tamper(base, B249, (d) => { d.blocks[0].proposer_sig = flipHex(d.blocks[0].proposer_sig, 100); }));
    expect(r.status).toBe("invalid");
    expect(failed(r.checks)).toEqual(["block.hash", "block.proposer_signature"]);
  });

  it("one precommit signature altered", async () => {
    const r = await run(tamper(base, B249, (d) => { const v = d.blocks[1].header.parent_commit.precommit_votes[0]; v.signature = flipHex(v.signature, 200); }));
    expect(r.status).toBe("invalid");
    expect(failed(r.checks)).toEqual(["cert.vote[0]"]);
    expect(r.checks.find((c) => c.name === "cert.vote[0]")!.detail).toMatch(/signature does not verify/);
  });

  it("stake below quorum (pinned set where the signer holds too little)", async () => {
    const pinned: TrustedValidatorSet = { validators: [{ publicKey: VOTER, stake: 1 }, { publicKey: "aa".repeat(1952), stake: 10 }] };
    const r = await run(base, { trustedValidatorSet: pinned });
    expect(r.status).toBe("invalid");
    expect(failed(r.checks)).toEqual(["cert.quorum"]);
  });

  it("voter not in the pinned set", async () => {
    const pinned: TrustedValidatorSet = { validators: [{ publicKey: "aa".repeat(1952), stake: 10 }] };
    const r = await run(base, { trustedValidatorSet: pinned });
    expect(r.status).toBe("invalid");
    expect(failed(r.checks)).toEqual(["cert.vote[0]"]);
    expect(r.checks.find((c) => c.name === "cert.vote[0]")!.detail).toMatch(/not in the validator set/);
  });

  it("wrong chain id", async () => {
    const r = await run(base, { chainId: "rougechain-testnet-1" });
    expect(r.status).toBe("invalid");
    expect(failed(r.checks)).toEqual(["block.chain_id"]);
  });

  it("the vote message binds the chain id (a mainnet vote does not verify for another chain)", () => {
    const b = blocksOf(B249);
    const ctx = { height: 249, blockHash: b[0].hash, validatorSet: nodeSet() };
    expect(verifyFinalityCertificate(b[1].header.parent_commit, { ...ctx, chainId: CHAIN }).ok).toBe(true);
    expect(failed(verifyFinalityCertificate(b[1].header.parent_commit, { ...ctx, chainId: "rougechain-testnet-1" }).checks)).toEqual(["cert.vote[0]"]);
  });

  it("block hash mismatch across nodes", async () => {
    const forked = tamper(base, B249, (d) => { d.blocks[0].header.time = new JsonNumber("1"); });
    const r = await verifyTxFinalized({ txHash: TX249, nodes: [A, B, C], chainId: CHAIN, fetch: fakeFetch({ [A]: base, [B]: base, [C]: forked }) });
    expect(r.status).toBe("invalid");
    expect(failed(r.checks)).toEqual(["nodes.same_block"]);
    expect(r.checks.find((c) => !c.ok)!.node).toBe(C);
  });

  it("too few nodes answer: not finalized (no conflict, but no majority)", async () => {
    const r = await verifyTxFinalized({ txHash: TX249, nodes: [A, B, C], chainId: CHAIN, fetch: fakeFetch({ [A]: base, [B]: null, [C]: null }) });
    expect(r.status).toBe("included-not-finalized");
    expect(failed(r.checks)).toEqual(["nodes.majority"]);
  });

  it("certificate for a different block height", async () => {
    const other = (parseJsonLossless(base["/finality/151"]) as any).proof;
    const r = await run(tamper(base, B249, (d) => { d.blocks[1].header.parent_commit = other; }));
    expect(r.status).toBe("invalid");
    expect(failed(r.checks)).toEqual(["cert.height"]);
  });

  it("certificate for a different block hash at the same height", async () => {
    const r = await run(tamper(base, B249, (d) => { d.blocks[1].header.parent_commit.block_hash = "00".repeat(32); }));
    expect(r.status).toBe("invalid");
    expect(failed(r.checks)).toEqual(["cert.block_hash"]);
  });

  it("a vote for another block inside an otherwise matching certificate", async () => {
    const r = await run(tamper(base, B249, (d) => { d.blocks[1].header.parent_commit.precommit_votes[0].block_hash = "00".repeat(32); }));
    expect(failed(r.checks)).toEqual(["cert.vote[0]"]);
  });

  it("the certificate's aggregate claims: informational with an undated set, binding with a set for the height", async () => {
    const resp = tamper(base, B249, (d) => { d.blocks[1].header.parent_commit.total_stake = new JsonNumber("1"); });
    const loose = await run(resp);
    expect(loose.status).toBe("finalized");
    expect(loose.checks.find((c) => c.name === "cert.claim.total_stake")).toMatchObject({ ok: false, critical: false });
    const strict = await run(resp, { trustedValidatorSet: { ...nodeSet(), height: 249 } });
    expect(strict.status).toBe("invalid");
    expect(failed(strict.checks)).toEqual(["cert.claim.total_stake"]);
  });

  it("the node's height hint points at a block without the transaction: not-found", async () => {
    const resp = tamper(base, `/tx/${TX151}`, (d) => { d.blockHeight = new JsonNumber("249"); });
    const r = await verifyTxFinalized({ txHash: TX151, nodes: [A], chainId: CHAIN, fetch: fakeFetch({ [A]: resp }) });
    expect(r.status).toBe("not-found");
    expect(failed(r.checks)).toEqual(["tx.in_block"]);
  });

  it("unknown transaction: not-found", async () => {
    const r = await verifyTxFinalized({ txHash: "ab".repeat(32), nodes: [A], chainId: CHAIN, fetch: fakeFetch({ [A]: base }) });
    expect(r.status).toBe("not-found");
    expect(failed(r.checks)).toEqual(["tx.lookup"]);
  });

  it("malformed input: invalid", async () => {
    const r = await verifyTxFinalized({ txHash: "xyz", nodes: [A], chainId: CHAIN, fetch: fakeFetch({ [A]: base }) });
    expect(r.status).toBe("invalid");
    expect(failed(r.checks)).toEqual(["input"]);
  });

  it("no validator set obtainable (none pinned, /validators unavailable): not finalized", async () => {
    const r = await run(without(base, "/validators"));
    expect(r.status).toBe("included-not-finalized");
    expect(failed(r.checks)).toEqual(["validator_set"]);
  });

  it("minConfirmations (tip 252 at capture: block 249 has 4)", async () => {
    expect((await run(base, { minConfirmations: 4 })).status).toBe("finalized");
    const r = await run(base, { minConfirmations: 5 });
    expect(r.status).toBe("included-not-finalized");
    expect(failed(r.checks)).toEqual(["confirmations"]);
  });

  it("an unknown field in a served block fails closed", async () => {
    const r = await run(tamper(base, B249, (d) => { d.blocks[0].header.extra = 1; }));
    expect(r.status).toBe("invalid");
    expect(failed(r.checks)).toEqual(["block.shape"]);
  });

  it("verifyBlock on its own reports every block check", () => {
    const v = verifyBlock(blocksOf(B249)[0], { chainId: CHAIN });
    expect(v.ok).toBe(true);
    expect(v.checks.map((c) => c.name)).toEqual(["block.shape", "block.chain_id", "block.tx_hash", "block.hash", "block.proposer_signature"]);
  });
});

describe("core and SDK carry the same implementation", () => {
  it("packages/core/src/finality-verify.ts and sdk/src/finality-verify.ts are identical", () => {
    expect(repo("sdk/src/finality-verify.ts")).toBe(repo("packages/core/src/finality-verify.ts"));
  });
  it("the SDK and core fixture files are identical", () => {
    expect(repo("sdk/test/fixtures/finality-mainnet.json")).toBe(repo("packages/core/test/fixtures/finality-mainnet.json"));
  });
});
