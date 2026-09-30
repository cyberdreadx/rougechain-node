// BTC relayer core unit tests — pure logic, NO network. Esplora and the daemon are fakes.
//   npx vitest run --config scripts/vitest.config.ts

import { describe, it, expect } from "vitest";
import {
  processBtcWithdrawal,
  classifyBroadcastResponse,
  knownPayoutTxids,
  reservedInputs,
  p2wpkhVsize,
  feeForVsize,
  planPayout,
  payoutSettles,
  esploraTxFee,
  P2WPKH_SCRIPT_LEN,
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
      return { kind: "built", txid: calls.build === 1 ? TX_A : TX_B, rawHex: `raw-${calls.build}`, inputs: [`in${calls.build}:0`] };
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
        return { kind: "built", txid: TX_A, rawHex: "raw-1", inputs: ["free:0"] };
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

// ── Withdrawer-pays-fee policy ──

const CUSTODY = "bc1q4963wmznu5xjqq623v5d34ne0w78p0g0e83vvc";
const u = (value: number, i = 0) => ({ txid: String(i).repeat(64).slice(0, 64), vout: i, value });
const P2TR_SCRIPT_LEN = 34;

describe("fee math", () => {
  it("exact P2WPKH vsize for 1–3 inputs, with and without change", () => {
    const W = P2WPKH_SCRIPT_LEN;
    // weight = 4×(10 + 41n + 31·outs) + 2 + 108n  → vsize = ceil(weight / 4)
    expect(p2wpkhVsize(1, [W])).toBe(110); //  438 WU
    expect(p2wpkhVsize(1, [W, W])).toBe(141); //  562 WU — the first mainnet payout was 141 vB
    expect(p2wpkhVsize(2, [W])).toBe(178); //  710 WU
    expect(p2wpkhVsize(2, [W, W])).toBe(209); //  834 WU
    expect(p2wpkhVsize(3, [W])).toBe(246); //  982 WU
    expect(p2wpkhVsize(3, [W, W])).toBe(277); // 1106 WU
    // A Taproot destination output is 12 bytes bigger than a P2WPKH one.
    expect(p2wpkhVsize(1, [P2TR_SCRIPT_LEN, W])).toBe(153);
    expect(() => p2wpkhVsize(0, [W])).toThrow();
  });

  it("fee = ceil(vsize × rate)", () => {
    expect(feeForVsize(141, 1)).toBe(141n);
    expect(feeForVsize(141, 1.5)).toBe(212n); // 211.5 → 212
    expect(feeForVsize(141, 1.1)).toBe(156n); // 155.1 → 156 (no float phantom)
    expect(feeForVsize(110, 10)).toBe(1100n);
    expect(() => feeForVsize(141, 0)).toThrow();
  });
});

describe("planPayout", () => {
  const base = { feeRate: 1, destScriptLen: P2WPKH_SCRIPT_LEN, maxFee: 10_000n, dust: 546n };

  it("5 000 sats at 1 sat/vB: dest gets 4 859, fee 141, custody falls by exactly 5 000", () => {
    const plan = planPayout({ ...base, utxos: [u(100_000)], sats: 5_000n });
    expect(plan).toMatchObject({ kind: "ok", pay: 4_859n, fee: 141n, change: 95_000n, vsize: 141 });
    if (plan.kind !== "ok") throw new Error();
    const inputs = plan.inputs.reduce((a, x) => a + BigInt(x.value), 0n);
    expect(inputs - plan.change).toBe(5_000n); // custody's balance drop == burned amount
    expect(plan.pay + plan.fee).toBe(5_000n);
  });

  it("multiple inputs raise the fee the withdrawer pays", () => {
    const plan = planPayout({ ...base, feeRate: 2, utxos: [u(3_000, 1), u(3_000, 2), u(3_000, 3)], sats: 8_000n });
    // 3 inputs cover 9 000; change 1 000 > dust → 2 outputs, 277 vB × 2 = 554.
    expect(plan).toMatchObject({ kind: "ok", fee: 554n, pay: 7_446n, change: 1_000n });
  });

  it("exact-cover inputs produce no change output", () => {
    const plan = planPayout({ ...base, utxos: [u(5_000)], sats: 5_000n });
    expect(plan).toMatchObject({ kind: "ok", change: 0n, vsize: 110, fee: 110n, pay: 4_890n });
  });

  it("a sub-dust remainder goes to the withdrawer, not to miners", () => {
    const plan = planPayout({ ...base, utxos: [u(5_300)], sats: 5_000n });
    // change 300 ≤ dust and no more UTXOs: 1 output; dest gets 5 300 − 110.
    expect(plan).toMatchObject({ kind: "ok", change: 0n, fee: 110n, pay: 5_190n });
  });

  it("adds another input rather than leaving sub-dust change when it can", () => {
    // All UTXOs used and only 300 left → remainder to dest: 2 inputs, 1 output (178 vB).
    const plan = planPayout({ ...base, utxos: [u(5_300, 1), u(20_000, 2)], sats: 25_000n });
    expect(plan).toMatchObject({ kind: "ok", change: 0n, fee: 178n, pay: 25_122n });
    const p2 = planPayout({ ...base, utxos: [u(5_200, 1), u(1_000, 2)], sats: 5_000n });
    // 5 200 leaves 200 (≤ dust) → take the 1 000 too → change 1 200.
    expect(p2).toMatchObject({ kind: "ok", change: 1_200n, fee: 209n, pay: 4_791n });
  });

  it("fee above the cap → fee_too_high, nothing to sign", () => {
    const plan = planPayout({ ...base, feeRate: 100, maxFee: 10_000n, utxos: [u(1_000_000)], sats: 500_000n });
    expect(plan).toMatchObject({ kind: "fee_too_high", fee: 14_100n, maxFee: 10_000n });
    const atCap = planPayout({ ...base, feeRate: 100, maxFee: 14_100n, utxos: [u(1_000_000)], sats: 500_000n });
    expect(atCap.kind).toBe("ok");
  });

  it("amount minus fee at or below dust → below_minimum_after_fee", () => {
    // fee 141 at 1 sat/vB: 687 − 141 = 546 = dust → refused; 688 → 547 → ok.
    expect(planPayout({ ...base, utxos: [u(100_000)], sats: 687n })).toMatchObject({ kind: "below_minimum_after_fee", fee: 141n, pay: 546n });
    expect(planPayout({ ...base, utxos: [u(100_000)], sats: 688n })).toMatchObject({ kind: "ok", pay: 547n });
    // 2 000 sats at 20 sat/vB: fee 2 820 > amount.
    expect(planPayout({ ...base, feeRate: 20, utxos: [u(100_000)], sats: 2_000n }).kind).toBe("below_minimum_after_fee");
  });

  it("insufficient custody balance", () => {
    expect(planPayout({ ...base, utxos: [u(1_000)], sats: 5_000n })).toEqual({ kind: "insufficient", have: 1_000n, need: 5_000n });
  });
});

describe("payoutSettles (adopt rule, mirrors the daemon)", () => {
  const tx = (paid: number, change: number, input = 100_000, fromCustody = true, fee?: number) => ({
    txid: TX_A,
    fee: fee ?? input - paid - change,
    vin: [{ prevout: { scriptpubkey_address: fromCustody ? CUSTODY : "bc1qsomeoneelse", value: input } }],
    vout: [
      { scriptpubkey_address: DEST, value: paid },
      ...(change ? [{ scriptpubkey_address: CUSTODY, value: change }] : []),
    ],
  });

  it("accepts the legacy full-amount form (e.g. the first mainnet 5 000-sat payout)", () => {
    expect(payoutSettles(tx(5_000, 94_859), CUSTODY, DEST, 5_000n, 10_000n)).toBe(true);
  });
  it("accepts the new sats − fee form", () => {
    expect(payoutSettles(tx(4_859, 95_000), CUSTODY, DEST, 5_000n, 10_000n)).toBe(true);
  });
  it("rejects paid + fee < owed, fee over cap, zero paid, not custody-funded, fee mismatch", () => {
    expect(payoutSettles(tx(4_800, 95_059), CUSTODY, DEST, 5_000n, 10_000n)).toBe(false);
    expect(payoutSettles(tx(38_000, 50_000), CUSTODY, DEST, 50_000n, 10_000n)).toBe(false); // fee 12 000
    expect(payoutSettles(tx(0, 95_000), CUSTODY, DEST, 5_000n, 10_000n)).toBe(false);
    expect(payoutSettles(tx(5_000, 94_859, 100_000, false), CUSTODY, DEST, 5_000n, 10_000n)).toBe(false);
    expect(payoutSettles(tx(4_859, 95_000, 100_000, true, 500), CUSTODY, DEST, 5_000n, 10_000n)).toBe(false);
  });
  it("esploraTxFee needs every prevout value", () => {
    expect(esploraTxFee(tx(4_859, 95_000))).toBe(141n);
    expect(esploraTxFee({ txid: TX_A, vin: [{ prevout: { scriptpubkey_address: CUSTODY } }], vout: [] })).toBeNull();
  });
});

describe("processBtcWithdrawal — fee policy outcomes", () => {
  it("fee_too_high persists nothing and is retried next cycle", async () => {
    const state: BtcState = {};
    let refuse = true;
    const { deps, calls } = fakeDeps({
      build: async () => {
        calls.build += 1;
        return refuse ? { kind: "fee_too_high", fee: 12_000n, maxFee: 10_000n } : { kind: "built", txid: TX_A, rawHex: "raw", inputs: ["i:0"] };
      },
    });
    expect(await processBtcWithdrawal(W, state, deps)).toBe("fee_too_high");
    expect(state).toEqual({});
    expect(calls.saves).toBe(0);
    expect(calls.broadcast).toEqual([]);
    refuse = false;
    expect(await processBtcWithdrawal(W, state, deps)).toBe("broadcast");
  });

  it("below_minimum_after_fee flags for review (live) and never broadcasts", async () => {
    const state: BtcState = {};
    const { deps, calls } = fakeDeps({ build: async () => ({ kind: "below_minimum_after_fee", fee: 700n, pay: 300n }) });
    expect(await processBtcWithdrawal({ ...W, amountUnits: 1_000 }, state, deps)).toBe("below_minimum_after_fee");
    expect(state["wd-1"].needsReview).toMatch(/minus 700 sats network fee/);
    expect(calls.broadcast).toEqual([]);
    expect(await processBtcWithdrawal({ ...W, amountUnits: 1_000 }, state, deps)).toBe("needs_review");
  });

  it("below_minimum_after_fee in dry-run persists nothing", async () => {
    const state: BtcState = {};
    const { deps, calls } = fakeDeps({ live: false, build: async () => ({ kind: "below_minimum_after_fee", fee: 700n, pay: 300n }) });
    expect(await processBtcWithdrawal({ ...W, amountUnits: 1_000 }, state, deps)).toBe("below_minimum_after_fee");
    expect(state).toEqual({});
    expect(calls.saves).toBe(0);
  });

  it("the saved plan carries pay/fee and is re-sent byte-identical", async () => {
    const state: BtcState = {};
    const results: BroadcastResult[] = [{ kind: "unknown", reason: "timeout" }];
    const { deps, calls } = fakeDeps({
      build: async () => {
        calls.build += 1;
        return { kind: "built", txid: TX_A, rawHex: "raw-fee", inputs: ["i:0"], pay: "49859", fee: "141" };
      },
      broadcast: async (raw, txid) => {
        calls.broadcast.push(raw);
        return results.shift() ?? { kind: "accepted", txid };
      },
    });
    expect(await processBtcWithdrawal(W, state, deps)).toBe("broadcast_unknown");
    expect(state["wd-1"].planned).toMatchObject({ pay: "49859", fee: "141" });
    expect(state["wd-1"].planned).not.toHaveProperty("kind");
    expect(await processBtcWithdrawal(W, state, deps)).toBe("broadcast");
    expect(calls.build).toBe(1);
    expect(calls.broadcast).toEqual(["raw-fee", "raw-fee"]);
  });
});
