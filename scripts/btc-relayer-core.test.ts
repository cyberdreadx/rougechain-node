// BTC relayer core unit tests — pure logic, NO network. Esplora and the daemon are fakes.
//   npx vitest run --config scripts/vitest.config.ts

import { describe, it, expect } from "vitest";
import {
  processBtcWithdrawal,
  classifyBroadcastResponse,
  knownPayoutTxids,
  reservedInputs,
  type BtcState,
  type BtcPayoutDeps,
  type BroadcastResult,
} from "./btc-relayer-core";

const DEST = "bc1qdestinationaddressxxxxxxxxxxxxxxxxxxxx";
const W = { txId: "wd-1", evmAddress: DEST, amountUnits: 50_000 };
const TX_A = "a".repeat(64);
const TX_B = "b".repeat(64);

function fakeDeps(over: Partial<BtcPayoutDeps> = {}) {
  const calls = { build: 0, broadcast: [] as string[], fulfill: [] as string[], saves: 0, logs: [] as string[] };
  const deps: BtcPayoutDeps = {
    live: true,
    minConfirmations: 2,
    maxSats: 0n,
    maxRetries: 3,
    dust: 546n,
    healthOk: async () => true,
    isValidDest: (a) => a === DEST,
    confirmations: async () => 0,
    txKnown: async () => false,
    findExistingPayout: async () => null,
    build: async () => {
      calls.build += 1;
      return { txid: calls.build === 1 ? TX_A : TX_B, rawHex: `raw-${calls.build}`, inputs: [`in${calls.build}:0`] };
    },
    broadcast: async (raw, txid): Promise<BroadcastResult> => {
      calls.broadcast.push(raw);
      return { kind: "accepted", txid };
    },
    fulfill: async (id, tx) => {
      calls.fulfill.push(`${id}:${tx}`);
      return true;
    },
    save: () => {
      calls.saves += 1;
    },
    log: (m) => calls.logs.push(m),
    ...over,
  };
  return { deps, calls };
}

describe("processBtcWithdrawal — new payouts", () => {
  it("signs once, saves the plan BEFORE broadcasting, then records the txid", async () => {
    const state: BtcState = {};
    let savedBeforeBroadcast = false;
    const { deps, calls } = fakeDeps({
      broadcast: async (raw, txid) => {
        savedBeforeBroadcast = state["wd-1"]?.planned?.txid === TX_A && calls.saves > 0;
        calls.broadcast.push(raw);
        return { kind: "accepted", txid };
      },
    });
    expect(await processBtcWithdrawal(W, state, deps)).toBe("broadcast");
    expect(savedBeforeBroadcast).toBe(true);
    expect(state["wd-1"]).toMatchObject({ btcTxid: TX_A, attempts: 1 });
    expect(state["wd-1"].planned).toBeUndefined();
    expect(calls.build).toBe(1);
  });

  it("a lost broadcast response NEVER leads to a second, different payment", async () => {
    const state: BtcState = {};
    const results: BroadcastResult[] = [{ kind: "unknown", reason: "timeout" }, { kind: "unknown", reason: "timeout" }];
    const { deps, calls } = fakeDeps({
      broadcast: async (raw, txid) => {
        calls.broadcast.push(raw);
        return results.shift() ?? { kind: "accepted", txid };
      },
    });
    expect(await processBtcWithdrawal(W, state, deps)).toBe("broadcast_unknown");
    expect(await processBtcWithdrawal(W, state, deps)).toBe("broadcast_unknown");
    expect(await processBtcWithdrawal(W, state, deps)).toBe("broadcast");
    expect(calls.build).toBe(1); // signed exactly once
    expect(calls.broadcast).toEqual(["raw-1", "raw-1", "raw-1"]); // only ever the same bytes
    expect(state["wd-1"].btcTxid).toBe(TX_A);
  });

  it("a planned payout the network already has is recorded without re-sending", async () => {
    const state: BtcState = {
      "wd-1": { dest: DEST, sats: "50000", attempts: 1, planned: { txid: TX_A, rawHex: "raw-1", inputs: ["in1:0"] } },
    };
    const { deps, calls } = fakeDeps({ txKnown: async () => true });
    expect(await processBtcWithdrawal(W, state, deps)).toBe("broadcast");
    expect(calls.broadcast).toEqual([]);
    expect(calls.build).toBe(0);
    expect(state["wd-1"].btcTxid).toBe(TX_A);
  });

  it("cannot tell whether a planned payout is out there → does nothing this cycle", async () => {
    const state: BtcState = {
      "wd-1": { dest: DEST, sats: "50000", attempts: 1, planned: { txid: TX_A, rawHex: "raw-1", inputs: ["in1:0"] } },
    };
    const { deps, calls } = fakeDeps({ txKnown: async () => null });
    expect(await processBtcWithdrawal(W, state, deps)).toBe("read_failed");
    expect(calls.broadcast).toEqual([]);
    expect(calls.build).toBe(0);
  });

  it("rejected because its coins are already spent → manual review, never re-pays", async () => {
    const state: BtcState = {};
    const { deps, calls } = fakeDeps({
      broadcast: async () => ({ kind: "rejected", reason: "bad-txns-inputs-missingorspent", inputsSpent: true }),
    });
    expect(await processBtcWithdrawal(W, state, deps)).toBe("needs_review");
    expect(state["wd-1"].needsReview).toMatch(/inputs already spent/);
    expect(await processBtcWithdrawal(W, state, deps)).toBe("needs_review");
    expect(calls.build).toBe(1);
  });

  it("a definite rejection (e.g. fee too low) drops the plan so a later cycle can rebuild", async () => {
    const state: BtcState = {};
    const results: BroadcastResult[] = [{ kind: "rejected", reason: "min relay fee not met", inputsSpent: false }];
    const { deps, calls } = fakeDeps({
      broadcast: async (raw, txid) => {
        calls.broadcast.push(raw);
        return results.shift() ?? { kind: "accepted", txid };
      },
    });
    expect(await processBtcWithdrawal(W, state, deps)).toBe("broadcast_rejected");
    expect(state["wd-1"].planned).toBeUndefined();
    expect(await processBtcWithdrawal(W, state, deps)).toBe("broadcast");
    expect(calls.build).toBe(2);
    expect(state["wd-1"]).toMatchObject({ btcTxid: TX_B, attempts: 2 });
  });

  it("gives up after maxRetries definite rejections", async () => {
    const state: BtcState = {};
    const { deps } = fakeDeps({ broadcast: async () => ({ kind: "rejected", reason: "fee", inputsSpent: false }) });
    for (let i = 0; i < 3; i++) expect(await processBtcWithdrawal(W, state, deps)).toBe("broadcast_rejected");
    expect(await processBtcWithdrawal(W, state, deps)).toBe("gave_up");
  });

  it("adopts an existing custody payout instead of paying again", async () => {
    const state: BtcState = {};
    const { deps, calls } = fakeDeps({ findExistingPayout: async () => TX_B });
    expect(await processBtcWithdrawal(W, state, deps)).toBe("adopted");
    expect(state["wd-1"].btcTxid).toBe(TX_B);
    expect(calls.build).toBe(0);
  });

  it("a failed custody-history scan never results in a payment", async () => {
    const state: BtcState = {};
    const { deps, calls } = fakeDeps({
      findExistingPayout: async () => {
        throw new Error("esplora 503");
      },
    });
    expect(await processBtcWithdrawal(W, state, deps)).toBe("read_failed");
    expect(calls.build).toBe(0);
    expect(state["wd-1"]).toBeUndefined();
  });

  it("no new payout while daemon bridge health is not OK", async () => {
    const state: BtcState = {};
    const { deps, calls } = fakeDeps({ healthOk: async () => false });
    expect(await processBtcWithdrawal(W, state, deps)).toBe("health_blocked");
    expect(calls.build).toBe(0);
  });

  it("a new payout never spends coins reserved by another unsettled payout", async () => {
    const state: BtcState = {
      "wd-0": { dest: DEST, sats: "1000", attempts: 1, planned: { txid: TX_B, rawHex: "raw-0", inputs: ["busy:1"] } },
    };
    let excluded: Set<string> | undefined;
    const { deps } = fakeDeps({
      build: async (_d, _s, ex) => {
        excluded = ex;
        return { txid: TX_A, rawHex: "raw-1", inputs: ["free:0"] };
      },
    });
    await processBtcWithdrawal(W, state, deps);
    expect([...(excluded ?? [])]).toEqual(["busy:1"]);
  });
});

describe("processBtcWithdrawal — dry-run, validation, fulfil", () => {
  it("dry-run builds but persists nothing, so it can never block a later live payout", async () => {
    const state: BtcState = {};
    const { deps, calls } = fakeDeps({ live: false });
    for (let i = 0; i < 5; i++) expect(await processBtcWithdrawal(W, state, deps)).toBe("would_pay");
    expect(state).toEqual({});
    expect(calls.saves).toBe(0);
    expect(calls.broadcast).toEqual([]);
    const live = fakeDeps();
    expect(await processBtcWithdrawal(W, state, live.deps)).toBe("broadcast");
  });

  it("rejects dust, invalid destinations and over-cap amounts without touching state", async () => {
    const state: BtcState = {};
    const { deps, calls } = fakeDeps({ maxSats: 100_000n });
    expect(await processBtcWithdrawal({ ...W, amountUnits: 546 }, state, deps)).toBe("skipped_invalid");
    expect(await processBtcWithdrawal({ ...W, evmAddress: "0xnotbitcoin" }, state, deps)).toBe("skipped_invalid");
    expect(await processBtcWithdrawal({ ...W, amountUnits: 100_001 }, state, deps)).toBe("skipped_cap");
    expect(state).toEqual({});
    expect(calls.build).toBe(0);
  });

  it("waits for confirmations, then asks the daemon to fulfil", async () => {
    const state: BtcState = { "wd-1": { dest: DEST, sats: "50000", attempts: 1, btcTxid: TX_A } };
    let confs = 1;
    const { deps, calls } = fakeDeps({ confirmations: async () => confs });
    expect(await processBtcWithdrawal(W, state, deps)).toBe("awaiting_confirmations");
    confs = 2;
    expect(await processBtcWithdrawal(W, state, deps)).toBe("fulfilled");
    expect(calls.fulfill).toEqual([`wd-1:${TX_A}`]);
  });

  it("unreadable confirmations are not treated as zero or as enough", async () => {
    const state: BtcState = { "wd-1": { dest: DEST, sats: "50000", attempts: 1, btcTxid: TX_A } };
    const { deps, calls } = fakeDeps({ confirmations: async () => null });
    expect(await processBtcWithdrawal(W, state, deps)).toBe("read_failed");
    expect(calls.fulfill).toEqual([]);
  });

  it("a daemon record that no longer matches the saved entry stops for review", async () => {
    const state: BtcState = { "wd-1": { dest: DEST, sats: "40000", attempts: 1, btcTxid: TX_A } };
    const { deps, calls } = fakeDeps();
    expect(await processBtcWithdrawal(W, state, deps)).toBe("needs_review");
    expect(calls.fulfill).toEqual([]);
  });

  it("legacy crash marker: adopts a found payout, otherwise stops for review", async () => {
    const found: BtcState = { "wd-1": { dest: DEST, sats: "50000", attempts: 1, broadcasting: true } };
    const a = fakeDeps({ findExistingPayout: async () => TX_B });
    expect(await processBtcWithdrawal(W, found, a.deps)).toBe("adopted");
    expect(found["wd-1"].btcTxid).toBe(TX_B);

    const missing: BtcState = { "wd-1": { dest: DEST, sats: "50000", attempts: 1, broadcasting: true } };
    const b = fakeDeps();
    expect(await processBtcWithdrawal(W, missing, b.deps)).toBe("needs_review");
    expect(b.calls.build).toBe(0);
  });
});

describe("helpers", () => {
  it("classifyBroadcastResponse", () => {
    expect(classifyBroadcastResponse(200, TX_A, TX_A)).toEqual({ kind: "accepted", txid: TX_A });
    expect(classifyBroadcastResponse(400, "sendrawtransaction RPC error: txn-already-in-mempool", TX_A)).toEqual({ kind: "accepted", txid: TX_A });
    expect(classifyBroadcastResponse(400, "Transaction already in block chain", TX_A)).toEqual({ kind: "accepted", txid: TX_A });
    expect(classifyBroadcastResponse(400, "bad-txns-inputs-missingorspent", TX_A)).toMatchObject({ kind: "rejected", inputsSpent: true });
    expect(classifyBroadcastResponse(400, "min relay fee not met", TX_A)).toMatchObject({ kind: "rejected", inputsSpent: false });
    expect(classifyBroadcastResponse(502, "bad gateway", TX_A).kind).toBe("unknown");
    expect(classifyBroadcastResponse(null, "ETIMEDOUT", TX_A).kind).toBe("unknown");
    expect(classifyBroadcastResponse(200, "<html>", TX_A).kind).toBe("unknown");
  });

  it("knownPayoutTxids and reservedInputs", () => {
    const state: BtcState = {
      a: { dest: DEST, sats: "1", attempts: 1, btcTxid: TX_A },
      b: { dest: DEST, sats: "1", attempts: 1, planned: { txid: TX_B, rawHex: "r", inputs: ["x:0", "y:1"] } },
    };
    expect([...knownPayoutTxids(state)].sort()).toEqual([TX_A, TX_B]);
    expect([...reservedInputs(state)].sort()).toEqual(["x:0", "y:1"]);
    expect([...reservedInputs(state, "b")]).toEqual([]);
  });
});
