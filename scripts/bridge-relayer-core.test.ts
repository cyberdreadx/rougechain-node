// Relayer core unit tests — pure logic, NO network. Every on-chain/daemon interaction is a
// fake injected through EvmPayoutDeps / PreflightClient.
//   npx vitest run --config scripts/vitest.config.ts

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { encodeEventTopics, encodeAbiParameters, keccak256, stringToBytes, getAddress, type Hex } from "viem";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  rougeBridgeId,
  payoutRoute,
  normalizeEthWithdrawal,
  unitsToWei,
  owedAmount,
  ROUGE_BRIDGE_ABI,
  ERC20_EVENTS_ABI,
  ZERO_ADDRESS,
  decodeBridgeEvents,
  verifyReleaseLogs,
  timelockRecordMatches,
  classifyProcessed,
  refundDecision,
  classifyReleaseReceipt,
  expectedTimelockFor,
  expectedReleaseFor,
  parseTimelockQueueTuple,
  loadQueuedState,
  saveQueuedState,
  queuedKey,
  autoRefundEnabled,
  preflight,
  PreflightError,
  processEvmWithdrawal,
  pollQueuedWithdrawals,
  guardedRefund,
  reconcileProcessedId,
  type EvmPayoutDeps,
  type EvmChainDeps,
  type RawLog,
  type ReceiptLike,
  type TimelockRecord,
  type ExpectedRelease,
  type NormalizedEvmWithdrawal,
  type QueuedState,
} from "./bridge-relayer-core";

// ── Fixtures ────────────────────────────────────────────────────────────────

const BRIDGE = "0x1111111111111111111111111111111111111111";
const OTHER_CONTRACT = "0x2222222222222222222222222222222222222222";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const OTHER_TOKEN = "0x3333333333333333333333333333333333333333";
// EIP-55 checksummed (the core normalizes recipients with getAddress before any call).
const RECIPIENT = getAddress("0x" + "aa".repeat(20));
const OTHER_RECIPIENT = getAddress("0x" + "bb".repeat(20));
const SIGNER = getAddress("0x" + "cc".repeat(20));
const TX1 = "0x" + "a1".repeat(32) as Hex;
const TX2 = "0x" + "a2".repeat(32) as Hex;
const TX_EXEC = "0x" + "e1".repeat(32) as Hex;
const STORED_TX_ID = "00000000000000000000000000000000000000000000000000000000000000ff";
const CANON = rougeBridgeId(STORED_TX_ID);
const WRONG_ID = rougeBridgeId("wrong");

/** Encode an event log the way a node would (indexed → topics, rest → data). */
function makeLog(abi: readonly any[], eventName: string, args: Record<string, unknown>, address: string, txHash: Hex = TX1): RawLog {
  const item = (abi as any[]).find((a) => a.type === "event" && a.name === eventName);
  const topics = encodeEventTopics({ abi: abi as any, eventName: eventName as any, args: args as any }) as Hex[];
  const nonIndexed = item.inputs.filter((i: any) => !i.indexed);
  const data = nonIndexed.length ? encodeAbiParameters(nonIndexed, nonIndexed.map((i: any) => args[i.name])) : ("0x" as Hex);
  return { address, topics, data, transactionHash: txHash, blockNumber: 100n };
}
const releaseEthLog = (o: Partial<{ recipient: string; amount: bigint; l1TxId: Hex; address: string; tx: Hex }> = {}) =>
  makeLog(ROUGE_BRIDGE_ABI, "BridgeReleaseETH", { recipient: o.recipient ?? RECIPIENT, amount: o.amount ?? 5n * 10n ** 12n, l1TxId: o.l1TxId ?? CANON }, o.address ?? BRIDGE, o.tx);
const releaseErc20Log = (o: Partial<{ recipient: string; token: string; amount: bigint; l1TxId: Hex; address: string; tx: Hex }> = {}) =>
  makeLog(ROUGE_BRIDGE_ABI, "BridgeReleaseERC20", { recipient: o.recipient ?? RECIPIENT, token: o.token ?? USDC, amount: o.amount ?? 5n, l1TxId: o.l1TxId ?? CANON }, o.address ?? BRIDGE, o.tx);
const transferLog = (o: Partial<{ from: string; to: string; value: bigint; address: string; tx: Hex }> = {}) =>
  makeLog(ERC20_EVENTS_ABI, "Transfer", { from: o.from ?? BRIDGE, to: o.to ?? RECIPIENT, value: o.value ?? 5n }, o.address ?? USDC, o.tx);
const queuedLog = (requestId: bigint, executeAfter: bigint, address = BRIDGE, tx: Hex = TX1) =>
  makeLog(ROUGE_BRIDGE_ABI, "TimelockQueued", { requestId, executeAfter }, address, tx);
const executedLog = (requestId: bigint, tx: Hex = TX_EXEC) => makeLog(ROUGE_BRIDGE_ABI, "TimelockExecuted", { requestId }, BRIDGE, tx);

const ethWithdrawal = (units = 5): NormalizedEvmWithdrawal => ({ tx_id: STORED_TX_ID, evm_address: RECIPIENT, amount_units: units, token_symbol: "qETH" });
const usdcWithdrawal = (units = 5): NormalizedEvmWithdrawal => ({ tx_id: STORED_TX_ID, evm_address: RECIPIENT, amount_units: units, token_symbol: "qUSDC" });

const ethRecord = (o: Partial<TimelockRecord> = {}): TimelockRecord => ({
  token: ZERO_ADDRESS, to: RECIPIENT, amount: 5n * 10n ** 12n, l1TxId: CANON, executeAfter: 1000n, executed: false, cancelled: false, ...o,
});
const usdcRecord = (o: Partial<TimelockRecord> = {}): TimelockRecord => ({
  token: USDC, to: RECIPIENT, amount: 5n, l1TxId: CANON, executeAfter: 1000n, executed: false, cancelled: false, ...o,
});

// ── Fake harness ────────────────────────────────────────────────────────────

interface Calls {
  releaseETH: any[]; releaseERC20: any[]; fulfill: any[]; reportFailure: any[]; refund: any[]; alerts: string[]; logs: string[];
}
interface FakeOpts {
  bridge?: string | null;
  processed?: boolean | (() => Promise<boolean>);
  receiptLogs?: RawLog[];
  receiptStatus?: "success" | "reverted";
  releaseThrows?: string;
  timelock?: Record<string, TimelockRecord> | ((id: bigint) => Promise<TimelockRecord>);
  releaseTxHashes?: Hex[];
  receipts?: Record<string, ReceiptLike>;
  queuedRequestIds?: bigint[];
  queuedEvents?: Record<string, bigint>;
  executedTxHashes?: Hex[];
  cancelledEvent?: boolean;
  shouldRefund?: boolean;
  attempts?: number;
  refundOk?: boolean;
  fulfillOk?: boolean;
  autoRefund?: boolean;
  queued?: QueuedState;
  maxRetries?: number;
}
function fake(o: FakeOpts = {}) {
  const calls: Calls = { releaseETH: [], releaseERC20: [], fulfill: [], reportFailure: [], refund: [], alerts: [], logs: [] };
  const processedSet = new Set<string>();
  const queued: QueuedState = o.queued ?? new Map();
  let saves = 0;
  const readTimelock = async (id: bigint): Promise<TimelockRecord> => {
    if (typeof o.timelock === "function") return o.timelock(id);
    const r = o.timelock?.[id.toString()];
    if (!r) throw new Error(`no timelock record ${id}`);
    return r;
  };
  const chain: EvmChainDeps = {
    releaseETH: async (to, wei, id, nonce) => { calls.releaseETH.push({ to, wei, id, nonce }); if (o.releaseThrows) throw new Error(o.releaseThrows); return TX1; },
    releaseERC20: async (token, to, amount, id, nonce) => { calls.releaseERC20.push({ token, to, amount, id, nonce }); if (o.releaseThrows) throw new Error(o.releaseThrows); return TX1; },
    waitForReceipt: async (hash) => ({ status: o.receiptStatus ?? "success", logs: o.receiptLogs ?? [], transactionHash: hash }),
    getReceipt: async (hash) => o.receipts?.[hash] ?? null,
    processedL1Txs: async () => (typeof o.processed === "function" ? o.processed() : !!o.processed),
    timelockQueue: readTimelock,
    findReleaseTxHashes: async () => o.releaseTxHashes ?? [],
    findQueuedRequestIds: async () => o.queuedRequestIds ?? [],
    findTimelockQueuedEvent: async (id) => (o.queuedEvents && o.queuedEvents[id.toString()] !== undefined ? { executeAfter: o.queuedEvents[id.toString()], txHash: TX1 } : null),
    findTimelockExecutedTxHashes: async () => o.executedTxHashes ?? [],
    findTimelockCancelled: async () => !!o.cancelledEvent,
    getNonce: async () => 7,
    resetNonce: () => {},
  };
  const deps: EvmPayoutDeps = {
    bridgeAddress: o.bridge === undefined ? BRIDGE : o.bridge,
    usdcAddress: USDC,
    autoRefund: o.autoRefund ?? false,
    maxRetries: o.maxRetries ?? 1,
    processedTxIds: processedSet,
    markProcessed: (id) => processedSet.add(id),
    queued,
    saveQueued: () => { saves++; },
    chain,
    daemon: {
      fulfill: async (txId, hash) => { calls.fulfill.push({ txId, hash }); return o.fulfillOk ?? true; },
      reportFailure: async (txId, error) => { calls.reportFailure.push({ txId, error }); return { shouldRefund: o.shouldRefund ?? false, attempts: o.attempts ?? 1 }; },
      refund: async (txId) => { calls.refund.push(txId); return o.refundOk ?? true; },
    },
    alert: (key, msg) => { calls.alerts.push(`${key}: ${msg}`); },
    log: (m) => calls.logs.push(m),
    warn: (m) => calls.logs.push(m),
    sleep: async () => {},
  };
  return { deps, calls, processedSet, queued, saves: () => saves };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("payoutRoute (R1B) — no default ETH route", () => {
  it("maps the four protocol assets case-insensitively", () => {
    expect(payoutRoute("XRGE")).toBe("Xrge");
    expect(payoutRoute("xrge")).toBe("Xrge");
    expect(payoutRoute(" XrGe ")).toBe("Xrge");
    expect(payoutRoute("qETH")).toBe("Eth");
    expect(payoutRoute("QeTh")).toBe("Eth");
    expect(payoutRoute("qUSDC")).toBe("Usdc");
    expect(payoutRoute("qusdc")).toBe("Usdc");
    expect(payoutRoute("qBTC")).toBe("Btc");
    expect(payoutRoute("QBTC")).toBe("Btc");
  });
  it("maps anything else to Unsupported (never Eth)", () => {
    for (const s of ["3EYE", "qDAI", "ETH", "USDC", "", "  ", undefined, null, "qETHX", "q ETH"]) {
      expect(payoutRoute(s as any)).toBe("Unsupported");
    }
  });
  it("normalizeEthWithdrawal carries token_symbol from either casing", () => {
    expect(normalizeEthWithdrawal({ tx_id: "a", evm_address: RECIPIENT, amount_units: 1, token_symbol: " qUSDC " }).token_symbol).toBe("qUSDC");
    expect(normalizeEthWithdrawal({ txId: "a", evmAddress: RECIPIENT, amountUnits: 1, tokenSymbol: "qETH" }).token_symbol).toBe("qETH");
    expect(normalizeEthWithdrawal({ txId: "a", evmAddress: RECIPIENT, amountUnits: 1 }).token_symbol).toBe("");
  });
  it("owedAmount: qETH ×10^12, qUSDC 1:1", () => {
    expect(unitsToWei(5)).toBe(5_000_000_000_000n);
    expect(owedAmount("Eth", 5)).toBe(5_000_000_000_000n);
    expect(owedAmount("Usdc", 5)).toBe(5n);
  });
});

describe("rougeBridgeId (canonical id) — frozen cross-language vectors", () => {
  it("keccak256('') and the pinned non-empty vector", () => {
    expect(rougeBridgeId("")).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(rougeBridgeId(STORED_TX_ID)).toBe("0x337ed4d89269c740d540763c75cbe3c32781be676d35104745fa5b46fa5f377f");
  });
  it("is keccak256 over the UTF-8 preimage and the prefix changes the id", () => {
    expect(rougeBridgeId(STORED_TX_ID)).toBe(keccak256(stringToBytes(STORED_TX_ID)));
    expect(rougeBridgeId(`xrge:${STORED_TX_ID}`)).not.toBe(rougeBridgeId(STORED_TX_ID));
    // a 0x-prefixed id is hashed as TEXT, never hex-decoded
    expect(rougeBridgeId("0xff")).toBe(keccak256(new TextEncoder().encode("0xff")));
    expect(rougeBridgeId("0xff")).not.toBe(keccak256(new Uint8Array([0xff])));
  });
});

describe("verifyReleaseLogs (R1D §6/§7)", () => {
  const ethExp: ExpectedRelease = { asset: "Eth", recipient: RECIPIENT, amount: 5n * 10n ** 12n, canonicalId: CANON, bridgeAddress: BRIDGE, usdcAddress: USDC };
  const usdcExp: ExpectedRelease = { asset: "Usdc", recipient: RECIPIENT, amount: 5n, canonicalId: CANON, bridgeAddress: BRIDGE, usdcAddress: USDC };

  it("qETH: matching BridgeReleaseETH from the bridge → ok (amount >= owed, case-insensitive recipient)", () => {
    expect(verifyReleaseLogs([releaseEthLog()], ethExp).ok).toBe(true);
    expect(verifyReleaseLogs([releaseEthLog({ amount: 6n * 10n ** 12n, recipient: RECIPIENT.toLowerCase() })], ethExp).ok).toBe(true);
  });
  it("qETH: wrong recipient / amount / l1TxId / emitting contract → rejected", () => {
    expect(verifyReleaseLogs([releaseEthLog({ recipient: OTHER_RECIPIENT })], ethExp).ok).toBe(false);
    expect(verifyReleaseLogs([releaseEthLog({ amount: 5n * 10n ** 12n - 1n })], ethExp).ok).toBe(false);
    expect(verifyReleaseLogs([releaseEthLog({ l1TxId: WRONG_ID })], ethExp).ok).toBe(false);
    expect(verifyReleaseLogs([releaseEthLog({ address: OTHER_CONTRACT })], ethExp).ok).toBe(false);
    expect(verifyReleaseLogs([], ethExp).ok).toBe(false);
  });
  it("qETH: an ERC20 release does not satisfy a qETH expectation", () => {
    expect(verifyReleaseLogs([releaseErc20Log(), transferLog()], ethExp).ok).toBe(false);
  });
  it("qUSDC: BridgeReleaseERC20 + USDC Transfer(from=RougeBridge) → ok", () => {
    expect(verifyReleaseLogs([releaseErc20Log(), transferLog()], usdcExp).ok).toBe(true);
  });
  it("qUSDC: wrong recipient / amount / l1TxId / token / emitting contract → rejected", () => {
    expect(verifyReleaseLogs([releaseErc20Log({ recipient: OTHER_RECIPIENT }), transferLog({ to: OTHER_RECIPIENT })], usdcExp).ok).toBe(false);
    expect(verifyReleaseLogs([releaseErc20Log({ amount: 4n }), transferLog({ value: 4n })], usdcExp).ok).toBe(false);
    expect(verifyReleaseLogs([releaseErc20Log({ l1TxId: WRONG_ID }), transferLog()], usdcExp).ok).toBe(false);
    expect(verifyReleaseLogs([releaseErc20Log({ token: OTHER_TOKEN }), transferLog()], usdcExp).ok).toBe(false);
    expect(verifyReleaseLogs([releaseErc20Log({ address: OTHER_CONTRACT }), transferLog()], usdcExp).ok).toBe(false);
  });
  it("qUSDC: the USDC Transfer must come from the RougeBridge, be emitted by the USDC contract, and cover the amount", () => {
    expect(verifyReleaseLogs([releaseErc20Log()], usdcExp).ok).toBe(false); // no Transfer at all
    expect(verifyReleaseLogs([releaseErc20Log(), transferLog({ from: SIGNER })], usdcExp).ok).toBe(false);
    expect(verifyReleaseLogs([releaseErc20Log(), transferLog({ address: OTHER_TOKEN })], usdcExp).ok).toBe(false);
    expect(verifyReleaseLogs([releaseErc20Log(), transferLog({ to: OTHER_RECIPIENT })], usdcExp).ok).toBe(false);
    expect(verifyReleaseLogs([releaseErc20Log(), transferLog({ value: 4n })], usdcExp).ok).toBe(false);
  });
  it("qUSDC: an ETH release does not satisfy a qUSDC expectation", () => {
    expect(verifyReleaseLogs([releaseEthLog({ amount: 5n })], usdcExp).ok).toBe(false);
  });
  it("decodeBridgeEvents ignores logs from other contracts and unknown events", () => {
    const evs = decodeBridgeEvents([releaseEthLog({ address: OTHER_CONTRACT }), transferLog(), queuedLog(1n, 2n)], BRIDGE);
    expect(evs.map((e) => e.name)).toEqual(["TimelockQueued"]);
  });
});

describe("timelock binding + classifyProcessed + refundDecision (R1E — Rust parity)", () => {
  const exp = expectedTimelockFor({ asset: "Eth", recipient: RECIPIENT, amount: 5n * 10n ** 12n, canonicalId: CANON, bridgeAddress: BRIDGE, usdcAddress: USDC }, 1000n);

  it("timelockRecordMatches: case-insensitive addresses, exact everything else", () => {
    expect(timelockRecordMatches(ethRecord({ to: RECIPIENT.toLowerCase() }), exp)).toBe(true);
    expect(timelockRecordMatches(ethRecord({ l1TxId: WRONG_ID }), exp)).toBe(false);
    expect(timelockRecordMatches(ethRecord({ to: OTHER_RECIPIENT }), exp)).toBe(false);
    expect(timelockRecordMatches(ethRecord({ token: USDC }), exp)).toBe(false);
    expect(timelockRecordMatches(ethRecord({ amount: 1n }), exp)).toBe(false);
    expect(timelockRecordMatches(ethRecord({ executeAfter: 999n }), exp)).toBe(false);
    // executed/cancelled do not affect binding
    expect(timelockRecordMatches(ethRecord({ executed: true, cancelled: true }), exp)).toBe(true);
  });
  it("classifyProcessed: exact Rust semantics", () => {
    expect(classifyProcessed({ verifiedRelease: true, queueRecord: null, expected: exp })).toBe("Paid");
    expect(classifyProcessed({ verifiedRelease: true, queueRecord: ethRecord({ cancelled: true }), expected: exp })).toBe("Paid");
    expect(classifyProcessed({ verifiedRelease: false, queueRecord: ethRecord(), expected: exp })).toBe("Queued");
    expect(classifyProcessed({ verifiedRelease: false, queueRecord: ethRecord({ cancelled: true }), expected: exp })).toBe("CancelledRefundCandidate");
    expect(classifyProcessed({ verifiedRelease: false, queueRecord: ethRecord({ executed: true }), expected: exp })).toBe("Ambiguous");
    expect(classifyProcessed({ verifiedRelease: false, queueRecord: ethRecord({ executed: true, cancelled: true }), expected: exp })).toBe("Ambiguous");
    expect(classifyProcessed({ verifiedRelease: false, queueRecord: null, expected: exp })).toBe("Ambiguous");
    expect(classifyProcessed({ verifiedRelease: false, queueRecord: undefined, expected: exp })).toBe("Ambiguous");
    expect(classifyProcessed({ verifiedRelease: false, queueRecord: ethRecord({ l1TxId: WRONG_ID }), expected: exp })).toBe("Ambiguous");
    expect(classifyProcessed({ verifiedRelease: false, queueRecord: ethRecord({ l1TxId: WRONG_ID, cancelled: true }), expected: exp })).toBe("Ambiguous");
  });
  it("refundDecision table", () => {
    expect(refundDecision(false)).toBe("NormalAnalysis");
    expect(refundDecision(false, "Paid")).toBe("NormalAnalysis");
    expect(refundDecision(true, "Paid")).toBe("Forbidden");
    expect(refundDecision(true, "Queued")).toBe("Forbidden");
    expect(refundDecision(true, "Ambiguous")).toBe("Forbidden");
    expect(refundDecision(true)).toBe("Forbidden");
    expect(refundDecision(true, null)).toBe("Forbidden");
    expect(refundDecision(true, "CancelledRefundCandidate")).toBe("MayProceedAfterCancellationProof");
  });
  it("parseTimelockQueueTuple maps the public getter tuple", () => {
    const rec = parseTimelockQueueTuple([ZERO_ADDRESS, RECIPIENT, 5n, CANON, 1000n, false, true]);
    expect(rec).toEqual(ethRecord({ amount: 5n, cancelled: true }));
    expect(() => parseTimelockQueueTuple([ZERO_ADDRESS])).toThrow();
  });
});

describe("classifyReleaseReceipt (R1D §8)", () => {
  const ethExp: ExpectedRelease = { asset: "Eth", recipient: RECIPIENT, amount: 5n * 10n ** 12n, canonicalId: CANON, bridgeAddress: BRIDGE, usdcAddress: USDC };
  const usdcExp: ExpectedRelease = { asset: "Usdc", recipient: RECIPIENT, amount: 5n, canonicalId: CANON, bridgeAddress: BRIDGE, usdcAddress: USDC };
  const getter = (rec: TimelockRecord) => async (id: bigint) => { if (id !== 42n) throw new Error("bad id"); return rec; };

  it("Verified when the release event matches", async () => {
    expect((await classifyReleaseReceipt([releaseEthLog()], ethExp, getter(ethRecord()))).kind).toBe("Verified");
  });
  it("Queued when TimelockQueued + getter binds (qETH and qUSDC)", async () => {
    const r = await classifyReleaseReceipt([queuedLog(42n, 1000n)], ethExp, getter(ethRecord()));
    expect(r.kind).toBe("Queued");
    if (r.kind === "Queued") { expect(r.requestId).toBe(42n); expect(r.executeAfter).toBe(1000n); }
    const u = await classifyReleaseReceipt([queuedLog(42n, 1000n)], usdcExp, getter(usdcRecord()));
    expect(u.kind).toBe("Queued");
  });
  it("Ambiguous on getter mismatch: l1TxId / recipient / asset(token) / amount / executeAfter", async () => {
    for (const rec of [
      ethRecord({ l1TxId: WRONG_ID }),
      ethRecord({ to: OTHER_RECIPIENT }),
      ethRecord({ token: USDC }),
      ethRecord({ amount: 1n }),
      ethRecord({ executeAfter: 999n }),
    ]) {
      expect((await classifyReleaseReceipt([queuedLog(42n, 1000n)], ethExp, getter(rec))).kind).toBe("Ambiguous");
    }
    // qUSDC queued with the ETH token (address(0)) → Ambiguous
    expect((await classifyReleaseReceipt([queuedLog(42n, 1000n)], usdcExp, getter(usdcRecord({ token: ZERO_ADDRESS })))).kind).toBe("Ambiguous");
  });
  it("Ambiguous when the queue is already executed/cancelled, the getter fails, no event, or a foreign TimelockQueued", async () => {
    expect((await classifyReleaseReceipt([queuedLog(42n, 1000n)], ethExp, getter(ethRecord({ executed: true })))).kind).toBe("Ambiguous");
    expect((await classifyReleaseReceipt([queuedLog(42n, 1000n)], ethExp, getter(ethRecord({ cancelled: true })))).kind).toBe("Ambiguous");
    expect((await classifyReleaseReceipt([queuedLog(42n, 1000n)], ethExp, async () => { throw new Error("rpc"); })).kind).toBe("Ambiguous");
    expect((await classifyReleaseReceipt([], ethExp, getter(ethRecord()))).kind).toBe("Ambiguous");
    expect((await classifyReleaseReceipt([queuedLog(42n, 1000n, OTHER_CONTRACT)], ethExp, getter(ethRecord()))).kind).toBe("Ambiguous");
  });
});

describe("processEvmWithdrawal — routing + fail-closed payout (R1B §5 / R1D §4)", () => {
  it("qETH immediate release → releaseETH(recipient, units×10^12, canonical) → verified → fulfilled exactly once", async () => {
    const f = fake({ receiptLogs: [releaseEthLog()] });
    expect(await processEvmWithdrawal(ethWithdrawal(), f.deps)).toBe("fulfilled");
    expect(f.calls.releaseETH).toEqual([{ to: RECIPIENT, wei: 5_000_000_000_000n, id: CANON, nonce: 7 }]);
    expect(f.calls.releaseERC20).toHaveLength(0);
    expect(f.calls.fulfill).toEqual([{ txId: STORED_TX_ID, hash: TX1 }]);
    expect(f.processedSet.has(STORED_TX_ID)).toBe(true);
    // second pass: already processed locally → never released again (relayer skips before calling; also on-chain guard)
    const g = fake({ processed: true, receiptLogs: [releaseEthLog()] });
    await processEvmWithdrawal(ethWithdrawal(), g.deps);
    expect(g.calls.releaseETH).toHaveLength(0);
  });
  it("qUSDC immediate release → releaseERC20(USDC, recipient, units (no ×10^12), canonical) → verified → fulfilled", async () => {
    const f = fake({ receiptLogs: [releaseErc20Log(), transferLog()] });
    expect(await processEvmWithdrawal(usdcWithdrawal(), f.deps)).toBe("fulfilled");
    expect(f.calls.releaseERC20).toEqual([{ token: USDC, to: RECIPIENT, amount: 5n, id: CANON, nonce: 7 }]);
    expect(f.calls.releaseETH).toHaveLength(0);
    expect(f.calls.fulfill).toHaveLength(1);
  });
  it("release succeeded but the receipt does not verify (wrong recipient) → Ambiguous: no fulfill, no failure report, no refund", async () => {
    const f = fake({ receiptLogs: [releaseEthLog({ recipient: OTHER_RECIPIENT })], autoRefund: true, shouldRefund: true });
    expect(await processEvmWithdrawal(ethWithdrawal(), f.deps)).toBe("ambiguous");
    expect(f.calls.fulfill).toHaveLength(0);
    expect(f.calls.reportFailure).toHaveLength(0);
    expect(f.calls.refund).toHaveLength(0);
    expect(f.calls.alerts.some((a) => a.includes("AMBIGUOUS"))).toBe(true);
    expect(f.queued.get(queuedKey(CANON))?.status).toBe("ambiguous");
  });
  it("unsupported token on the EVM feed → alert, no ETH/USDC transfer, no fulfill, no refund", async () => {
    for (const sym of ["3EYE", "qBTC", "XRGE", "", "ETH"]) {
      const f = fake({ receiptLogs: [releaseEthLog()], autoRefund: true, shouldRefund: true });
      const w = { ...ethWithdrawal(), token_symbol: sym };
      expect(await processEvmWithdrawal(w, f.deps)).toBe("skipped_unsupported");
      expect(f.calls.releaseETH).toHaveLength(0);
      expect(f.calls.releaseERC20).toHaveLength(0);
      expect(f.calls.fulfill).toHaveLength(0);
      expect(f.calls.refund).toHaveLength(0);
      expect(f.calls.reportFailure).toHaveLength(0);
      expect(f.calls.alerts).toHaveLength(1);
    }
  });
  it("RougeBridge absent → no payout at all: no ETH/USDC tx, no fulfill, no failure report, no refund, one alert", async () => {
    // qETH — even with auto-refund armed and the daemon willing to refund, nothing happens but the alert.
    const f = fake({ bridge: null, receiptLogs: [releaseEthLog()], autoRefund: true, shouldRefund: true });
    expect(await processEvmWithdrawal(ethWithdrawal(), f.deps)).toBe("skipped_no_bridge");
    expect(f.calls.releaseETH).toHaveLength(0);
    expect(f.calls.releaseERC20).toHaveLength(0);
    expect(f.calls.fulfill).toHaveLength(0);
    expect(f.calls.reportFailure).toHaveLength(0);
    expect(f.calls.refund).toHaveLength(0);
    expect(f.calls.alerts).toHaveLength(1);
    expect(f.calls.alerts[0]).toMatch(/ROUGE_BRIDGE_ADDRESS missing\/invalid/);
    expect(f.processedSet.size).toBe(0);
    expect(f.queued.size).toBe(0);
    // qUSDC — identical fail-closed outcome.
    const g = fake({ bridge: null, receiptLogs: [releaseErc20Log(), transferLog()], autoRefund: true, shouldRefund: true });
    expect(await processEvmWithdrawal(usdcWithdrawal(), g.deps)).toBe("skipped_no_bridge");
    expect(g.calls.releaseETH).toHaveLength(0);
    expect(g.calls.releaseERC20).toHaveLength(0);
    expect(g.calls.fulfill).toHaveLength(0);
    expect(g.calls.reportFailure).toHaveLength(0);
    expect(g.calls.refund).toHaveLength(0);
    expect(g.calls.alerts).toHaveLength(1);
    expect(g.processedSet.size).toBe(0);
  });
  it("EvmChainDeps exposes only RougeBridge release entrypoints — no direct wallet send exists to be wired", () => {
    const f = fake();
    const chainKeys = Object.keys(f.deps.chain).sort();
    expect(chainKeys).toEqual([
      "findQueuedRequestIds", "findReleaseTxHashes", "findTimelockCancelled", "findTimelockExecutedTxHashes",
      "findTimelockQueuedEvent", "getNonce", "getReceipt", "processedL1Txs", "releaseERC20", "releaseETH",
      "resetNonce", "timelockQueue", "waitForReceipt",
    ]);
    expect(Object.keys(f.deps).some((k) => /direct/i.test(k))).toBe(false);
  });
  it("AUTO_REFUND env toggle: default off; only the literal \"true\" enables it", () => {
    expect(autoRefundEnabled({})).toBe(false);
    expect(autoRefundEnabled({ AUTO_REFUND: "false" })).toBe(false);
    expect(autoRefundEnabled({ AUTO_REFUND: "1" })).toBe(false);
    expect(autoRefundEnabled({ AUTO_REFUND: "true" })).toBe(true);
  });
  it("invalid records (non-integer amount, bad address) are skipped without any send", async () => {
    const f = fake();
    expect(await processEvmWithdrawal({ ...ethWithdrawal(), amount_units: 1.5 }, f.deps)).toBe("skipped_invalid");
    expect(await processEvmWithdrawal({ ...ethWithdrawal(), amount_units: 0 }, f.deps)).toBe("skipped_invalid");
    expect(await processEvmWithdrawal({ ...ethWithdrawal(), evm_address: "not-an-address" }, f.deps)).toBe("skipped_invalid");
    expect(f.calls.releaseETH).toHaveLength(0);
  });
  it("processedL1Txs read failure before release → no release this poll (fail closed)", async () => {
    const f = fake({ processed: async () => { throw new Error("rpc down"); } });
    expect(await processEvmWithdrawal(ethWithdrawal(), f.deps)).toBe("skipped_rpc");
    expect(f.calls.releaseETH).toHaveLength(0);
    expect(f.calls.reportFailure).toHaveLength(0);
  });
});

describe("timelock lifecycle (R1E)", () => {
  it("TimelockQueued + getter match → Queued: persisted, no fulfill, no failure, no refund", async () => {
    const f = fake({ receiptLogs: [queuedLog(42n, 1000n)], timelock: { "42": ethRecord() }, autoRefund: true, shouldRefund: true });
    expect(await processEvmWithdrawal(ethWithdrawal(), f.deps)).toBe("queued");
    const rec = f.queued.get(queuedKey(CANON))!;
    expect(rec).toMatchObject({
      stored_tx_id: STORED_TX_ID, canonical_l1_tx_id: CANON, request_id: "42", asset: "Eth", recipient: RECIPIENT,
      amount: "5000000000000", execute_after: "1000", release_submission_tx_hash: TX1, status: "queued",
    });
    expect(f.saves()).toBeGreaterThan(0);
    expect(f.calls.fulfill).toHaveLength(0);
    expect(f.calls.reportFailure).toHaveLength(0);
    expect(f.calls.refund).toHaveLength(0);
    expect(f.processedSet.has(STORED_TX_ID)).toBe(false);
  });
  it("a queued withdrawal reappearing on the feed is NEVER released again", async () => {
    const f = fake({ receiptLogs: [queuedLog(42n, 1000n)], timelock: { "42": ethRecord() } });
    await processEvmWithdrawal(ethWithdrawal(), f.deps);
    expect(f.calls.releaseETH).toHaveLength(1);
    expect(await processEvmWithdrawal(ethWithdrawal(), f.deps)).toBe("skipped_queued");
    expect(await processEvmWithdrawal(ethWithdrawal(), f.deps)).toBe("skipped_queued");
    expect(f.calls.releaseETH).toHaveLength(1);
  });
  it("TimelockQueued but getter mismatches (wrong l1TxId) → Ambiguous, no retry, no refund", async () => {
    const f = fake({ receiptLogs: [queuedLog(42n, 1000n)], timelock: { "42": ethRecord({ l1TxId: WRONG_ID }) }, autoRefund: true, shouldRefund: true });
    expect(await processEvmWithdrawal(ethWithdrawal(), f.deps)).toBe("ambiguous");
    expect(f.calls.refund).toHaveLength(0);
    expect(f.calls.reportFailure).toHaveLength(0);
    expect(f.queued.get(queuedKey(CANON))?.status).toBe("ambiguous");
    // and it is blocked from re-release afterwards
    expect(await processEvmWithdrawal(ethWithdrawal(), f.deps)).toBe("skipped_queued");
    expect(f.calls.releaseETH).toHaveLength(1);
  });
  it("poll: active queue → keep waiting, nothing happens", async () => {
    const f = fake({ receiptLogs: [queuedLog(42n, 1000n)], timelock: { "42": ethRecord() }, autoRefund: true });
    await processEvmWithdrawal(ethWithdrawal(), f.deps);
    await pollQueuedWithdrawals(f.deps);
    expect(f.queued.get(queuedKey(CANON))?.status).toBe("queued");
    expect(f.calls.fulfill).toHaveLength(0);
    expect(f.calls.refund).toHaveLength(0);
    expect(f.calls.alerts).toHaveLength(0);
  });
  it("poll: executed + verified BridgeRelease in the execution tx → Paid, fulfilled ONCE with the execution tx hash", async () => {
    const f = fake({
      receiptLogs: [queuedLog(42n, 1000n)],
      timelock: { "42": ethRecord() },
      executedTxHashes: [TX_EXEC],
      receipts: { [TX_EXEC]: { status: "success", logs: [releaseEthLog({ tx: TX_EXEC }), executedLog(42n)] } },
    });
    await processEvmWithdrawal(ethWithdrawal(), f.deps);
    f.deps.chain.timelockQueue = async () => ethRecord({ executed: true });
    await pollQueuedWithdrawals(f.deps);
    expect(f.calls.fulfill).toEqual([{ txId: STORED_TX_ID, hash: TX_EXEC }]);
    expect(f.queued.has(queuedKey(CANON))).toBe(false);
    expect(f.processedSet.has(STORED_TX_ID)).toBe(true);
    await pollQueuedWithdrawals(f.deps);
    expect(f.calls.fulfill).toHaveLength(1);
    expect(f.calls.releaseETH).toHaveLength(1);
  });
  it("poll: executed but the execution tx has no verifiable release → Ambiguous, not fulfilled", async () => {
    const f = fake({
      receiptLogs: [queuedLog(42n, 1000n)],
      timelock: { "42": ethRecord() },
      executedTxHashes: [TX_EXEC],
      receipts: { [TX_EXEC]: { status: "success", logs: [releaseEthLog({ recipient: OTHER_RECIPIENT, tx: TX_EXEC }), executedLog(42n)] } },
    });
    await processEvmWithdrawal(ethWithdrawal(), f.deps);
    f.deps.chain.timelockQueue = async () => ethRecord({ executed: true });
    await pollQueuedWithdrawals(f.deps);
    expect(f.calls.fulfill).toHaveLength(0);
    expect(f.queued.get(queuedKey(CANON))?.status).toBe("ambiguous");
    expect(f.calls.alerts.some((a) => a.includes("AMBIGUOUS"))).toBe(true);
  });
  it("poll: cancelled && !executed with matching fields → CancelledRefundCandidate (alert, NO auto refund even with AUTO_REFUND=true)", async () => {
    const f = fake({ receiptLogs: [queuedLog(42n, 1000n)], timelock: { "42": ethRecord() }, autoRefund: true, shouldRefund: true });
    await processEvmWithdrawal(ethWithdrawal(), f.deps);
    f.deps.chain.timelockQueue = async () => ethRecord({ cancelled: true });
    await pollQueuedWithdrawals(f.deps);
    expect(f.queued.get(queuedKey(CANON))?.status).toBe("cancelled_refund_candidate");
    expect(f.calls.refund).toHaveLength(0);
    expect(f.calls.fulfill).toHaveLength(0);
    expect(f.calls.alerts.some((a) => a.includes("CancelledRefundCandidate"))).toBe(true);
    // it stays blocked from re-release
    expect(await processEvmWithdrawal(ethWithdrawal(), f.deps)).toBe("skipped_queued");
  });
  it("poll: TimelockCancelled event observed → confirmed getter re-read required; not yet cancelled at confirmed head → wait", async () => {
    const f = fake({ receiptLogs: [queuedLog(42n, 1000n)], timelock: { "42": ethRecord() }, cancelledEvent: true });
    await processEvmWithdrawal(ethWithdrawal(), f.deps);
    let confirmedReads = 0;
    f.deps.chain.timelockQueue = async (_id, opts) => { if (opts?.confirmed) confirmedReads++; return ethRecord(); };
    await pollQueuedWithdrawals(f.deps);
    expect(confirmedReads).toBeGreaterThanOrEqual(2);
    expect(f.queued.get(queuedKey(CANON))?.status).toBe("queued");
    // once the confirmed read shows cancelled && !executed with the same binding → candidate
    f.deps.chain.timelockQueue = async () => ethRecord({ cancelled: true });
    await pollQueuedWithdrawals(f.deps);
    expect(f.queued.get(queuedKey(CANON))?.status).toBe("cancelled_refund_candidate");
  });
  it("poll: TimelockCancelled but getter record no longer binds → Ambiguous", async () => {
    const f = fake({ receiptLogs: [queuedLog(42n, 1000n)], timelock: { "42": ethRecord() } });
    await processEvmWithdrawal(ethWithdrawal(), f.deps);
    f.deps.chain.timelockQueue = async () => ethRecord({ cancelled: true, amount: 1n });
    await pollQueuedWithdrawals(f.deps);
    expect(f.queued.get(queuedKey(CANON))?.status).toBe("ambiguous");
    expect(f.calls.refund).toHaveLength(0);
  });
});

describe("processedL1Txs reconciliation before failure (R1D §9 / R1E §4)", () => {
  it("revert with processed=true + verified on-chain release → Paid: fulfilled, no failure, no refund, no re-release", async () => {
    const f = fake({
      receiptStatus: "reverted",
      processed: true,
      releaseTxHashes: [TX2],
      receipts: { [TX2]: { status: "success", logs: [releaseEthLog({ tx: TX2 })] } },
      autoRefund: true, shouldRefund: true,
    });
    // pre-release check sees processed=true → reconcile without sending
    expect(await processEvmWithdrawal(ethWithdrawal(), f.deps)).toBe("reconciled_paid");
    expect(f.calls.releaseETH).toHaveLength(0);
    expect(f.calls.fulfill).toEqual([{ txId: STORED_TX_ID, hash: TX2 }]);
    expect(f.calls.reportFailure).toHaveLength(0);
    expect(f.calls.refund).toHaveLength(0);
  });
  it("release throws, then processed=true with an active bound queue (found via event scan) → Queued, no failure, no refund", async () => {
    let calls = 0;
    const f = fake({
      releaseThrows: "nonce too low",
      processed: async () => ++calls > 1, // false on the pre-check, true afterwards (the tx landed)
      queuedRequestIds: [42n],
      queuedEvents: { "42": 1000n },
      timelock: { "42": ethRecord() },
      autoRefund: true, shouldRefund: true,
    });
    expect(await processEvmWithdrawal(ethWithdrawal(), f.deps)).toBe("reconciled_queued");
    expect(f.calls.reportFailure).toHaveLength(0);
    expect(f.calls.refund).toHaveLength(0);
    expect(f.queued.get(queuedKey(CANON))).toMatchObject({ request_id: "42", execute_after: "1000", status: "queued" });
  });
  it("processed=true with no explainable state → Ambiguous, no refund", async () => {
    const f = fake({ processed: true, autoRefund: true, shouldRefund: true });
    expect(await processEvmWithdrawal(ethWithdrawal(), f.deps)).toBe("ambiguous");
    expect(f.calls.releaseETH).toHaveLength(0);
    expect(f.calls.refund).toHaveLength(0);
    expect(f.calls.reportFailure).toHaveLength(0);
  });
  it("processed=true with a queue record whose executeAfter cannot be bound to an event → Ambiguous", async () => {
    const f = fake({ processed: true, queuedRequestIds: [42n], timelock: { "42": ethRecord() } }); // no queuedEvents
    const r = await reconcileProcessedId(expectedReleaseFor(ethWithdrawal(), "Eth", BRIDGE, USDC), f.deps);
    expect(r.cls).toBe("Ambiguous");
  });
  it("processed=false after a revert → normal failure reporting; refund only when daemon says so AND AUTO_REFUND", async () => {
    const f = fake({ receiptStatus: "reverted", processed: false, shouldRefund: true, attempts: 3, autoRefund: false });
    expect(await processEvmWithdrawal(ethWithdrawal(), f.deps)).toBe("failed");
    expect(f.calls.reportFailure).toHaveLength(1);
    expect(f.calls.refund).toHaveLength(0);
    const g = fake({ receiptStatus: "reverted", processed: false, shouldRefund: true, attempts: 3, autoRefund: true });
    expect(await processEvmWithdrawal(ethWithdrawal(), g.deps)).toBe("refunded");
    expect(g.calls.refund).toEqual([STORED_TX_ID]);
  });
  it("retry loop re-checks processedL1Txs before every re-send and never double-sends", async () => {
    let sends = 0;
    const f = fake({ maxRetries: 3, releaseThrows: "timeout", processed: async () => sends > 0 });
    f.deps.chain.releaseETH = async () => { sends++; throw new Error("timeout"); };
    f.deps.chain.findReleaseTxHashes = async () => [TX1];
    f.deps.chain.getReceipt = async () => ({ status: "success", logs: [releaseEthLog()] });
    expect(await processEvmWithdrawal(ethWithdrawal(), f.deps)).toBe("reconciled_paid");
    expect(sends).toBe(1);
  });
});

describe("refund safety (R1E §6)", () => {
  it("guardedRefund: processed=false → refund proceeds (NormalAnalysis)", async () => {
    const f = fake({ processed: false });
    expect(await guardedRefund(ethWithdrawal(), "Eth", f.deps, 3)).toBe(true);
    expect(f.calls.refund).toEqual([STORED_TX_ID]);
  });
  it("guardedRefund: RPC failure → Forbidden, no mint", async () => {
    const f = fake({ processed: async () => { throw new Error("rpc outage"); } });
    expect(await guardedRefund(ethWithdrawal(), "Eth", f.deps, 3)).toBe(false);
    expect(f.calls.refund).toHaveLength(0);
    expect(f.calls.alerts.some((a) => a.includes("FORBIDDEN"))).toBe(true);
  });
  it("guardedRefund: processed=true → Paid/Queued/Ambiguous all Forbidden; CancelledRefundCandidate surfaced, not refunded", async () => {
    // Paid
    const paid = fake({ processed: true, releaseTxHashes: [TX1], receipts: { [TX1]: { status: "success", logs: [releaseEthLog()] } } });
    expect(await guardedRefund(ethWithdrawal(), "Eth", paid.deps, 3)).toBe(false);
    // Queued (active)
    const queued = fake({ processed: true, queuedRequestIds: [42n], queuedEvents: { "42": 1000n }, timelock: { "42": ethRecord() } });
    expect(await guardedRefund(ethWithdrawal(), "Eth", queued.deps, 3)).toBe(false);
    // Ambiguous
    const amb = fake({ processed: true });
    expect(await guardedRefund(ethWithdrawal(), "Eth", amb.deps, 3)).toBe(false);
    // Cancelled → MayProceedAfterCancellationProof → still NOT automatic
    const canc = fake({ processed: true, queuedRequestIds: [42n], queuedEvents: { "42": 1000n }, timelock: { "42": ethRecord({ cancelled: true }) } });
    expect(await guardedRefund(ethWithdrawal(), "Eth", canc.deps, 3)).toBe(false);
    expect(canc.calls.alerts.some((a) => a.includes("CancelledRefundCandidate"))).toBe(true);
    for (const f of [paid, queued, amb, canc]) expect(f.calls.refund).toHaveLength(0);
  });
  it("guardedRefund: qBTC / Unsupported / XRGE routes never auto-refund here; no bridge → refused", async () => {
    for (const route of ["Btc", "Unsupported", "Xrge"] as const) {
      const f = fake({ processed: false });
      expect(await guardedRefund(ethWithdrawal(), route, f.deps, 3)).toBe(false);
      expect(f.calls.refund).toHaveLength(0);
    }
    const nb = fake({ bridge: null, processed: false });
    expect(await guardedRefund(ethWithdrawal(), "Eth", nb.deps, 3)).toBe(false);
    expect(nb.calls.refund).toHaveLength(0);
  });
});

describe("queued-state persistence (R1E §3)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "relayer-queued-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("round-trips through .bridge-queued-txs.json and a reloaded queued id is NOT re-released", async () => {
    const file = join(dir, ".bridge-queued-txs.json");
    const f = fake({ receiptLogs: [queuedLog(42n, 1000n)], timelock: { "42": ethRecord() } });
    f.deps.saveQueued = () => saveQueuedState(file, f.queued);
    await processEvmWithdrawal(ethWithdrawal(), f.deps);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    expect(raw.entries).toHaveLength(1);
    expect(raw.entries[0]).toMatchObject({ stored_tx_id: STORED_TX_ID, canonical_l1_tx_id: CANON, request_id: "42", asset: "Eth", status: "queued" });

    // "restart": fresh deps loading the persisted state
    const reloaded = loadQueuedState(file);
    expect(reloaded.size).toBe(1);
    expect(reloaded.get(queuedKey(CANON))?.request_id).toBe("42");
    const g = fake({ queued: reloaded, receiptLogs: [releaseEthLog()] });
    expect(await processEvmWithdrawal(ethWithdrawal(), g.deps)).toBe("skipped_queued");
    expect(g.calls.releaseETH).toHaveLength(0);
    expect(g.calls.releaseERC20).toHaveLength(0);
  });
  it("missing / corrupt file loads as empty without throwing", () => {
    expect(loadQueuedState(join(dir, "nope.json"), () => {}).size).toBe(0);
    const bad = join(dir, "bad.json");
    saveQueuedState(bad, new Map());
    writeFileSync(bad, "{not json", "utf-8");
    const warns: string[] = [];
    expect(loadQueuedState(bad, (m) => warns.push(m)).size).toBe(0);
    expect(warns).toHaveLength(1);
  });
});

describe("preflight (R1D §11)", () => {
  const VAULT = "0x4444444444444444444444444444444444444444";
  function client(o: Partial<{ chainId: number; code: Record<string, Hex>; owner: string; paused: boolean; usdcSupported: boolean; throwOn: string }> = {}) {
    const code = o.code ?? { [BRIDGE.toLowerCase()]: "0x6001", [VAULT.toLowerCase()]: "0x6002" };
    return {
      getChainId: async () => o.chainId ?? 8453,
      getCode: async ({ address }: { address: Hex }) => code[address.toLowerCase()],
      readContract: async ({ functionName, args }: any) => {
        if (o.throwOn === functionName) throw new Error("rpc");
        switch (functionName) {
          case "owner": return o.owner ?? SIGNER;
          case "paused": return o.paused ?? false;
          case "supportedTokens": return (o.usdcSupported ?? true) && String(args[0]).toLowerCase() === USDC.toLowerCase();
          default: throw new Error(`unexpected ${functionName}`);
        }
      },
    };
  }
  const cfg = { expectedChainId: 8453, bridgeAddress: BRIDGE, configuredUsdc: undefined, chainUsdc: USDC, vaultAddress: VAULT, expectedOwner: SIGNER };
  const quiet = () => {};

  it("passes with a healthy environment and reports paused state", async () => {
    const r = await preflight(client({ paused: true }), cfg, quiet);
    expect(r).toEqual({ paused: true, owner: SIGNER, chainId: 8453 });
    expect((await preflight(client(), { ...cfg, configuredUsdc: USDC.toLowerCase(), vaultAddress: undefined }, quiet)).paused).toBe(false);
    expect((await preflight(client({ owner: SIGNER.toLowerCase() }), cfg, quiet)).owner).toBe(SIGNER.toLowerCase());
  });
  it("fails closed on every check", async () => {
    await expect(preflight(client({ chainId: 84532 }), cfg, quiet)).rejects.toThrow(PreflightError);
    await expect(preflight(client(), { ...cfg, bridgeAddress: undefined }, quiet)).rejects.toThrow(/ROUGE_BRIDGE_ADDRESS/);
    await expect(preflight(client(), { ...cfg, bridgeAddress: "0x123" }, quiet)).rejects.toThrow(/ROUGE_BRIDGE_ADDRESS/);
    await expect(preflight(client({ code: {} }), cfg, quiet)).rejects.toThrow(/no contract code at ROUGE_BRIDGE_ADDRESS/);
    await expect(preflight(client({ code: { [BRIDGE.toLowerCase()]: "0x" } }), cfg, quiet)).rejects.toThrow(/no contract code/);
    await expect(preflight(client({ owner: OTHER_RECIPIENT }), cfg, quiet)).rejects.toThrow(/owner/);
    await expect(preflight(client(), { ...cfg, configuredUsdc: OTHER_TOKEN }, quiet)).rejects.toThrow(/configured USDC/);
    await expect(preflight(client({ usdcSupported: false }), cfg, quiet)).rejects.toThrow(/supportedTokens/);
    await expect(preflight(client({ code: { [BRIDGE.toLowerCase()]: "0x6001" } }), cfg, quiet)).rejects.toThrow(/XRGE_BRIDGE_VAULT/);
    await expect(preflight(client(), { ...cfg, vaultAddress: "bogus" }, quiet)).rejects.toThrow(/XRGE_BRIDGE_VAULT/);
    await expect(preflight(client({ throwOn: "paused" }), cfg, quiet)).rejects.toThrow(/rpc/);
  });
  it("missing ROUGE_BRIDGE_ADDRESS fails preflight regardless of any env var (no carve-out, no bypass)", async () => {
    const saved = { ...process.env };
    try {
      // Every imaginable bypass knob is set (legacy no-bridge send, skip-preflight, test mode);
      // preflight reads none of them and must still refuse.
      for (const [k, v] of Object.entries({
        QV_BRIDGE_ALLOW_LEGACY_SEND: "true",
        QV_BRIDGE_ALLOW_NO_BRIDGE: "TRUE",
        QV_BRIDGE_SKIP_PREFLIGHT: "true",
        SKIP_PREFLIGHT: "1",
        PREFLIGHT: "off",
        NODE_ENV: "test",
      })) process.env[k] = v;
      for (const bridgeAddress of [undefined, "", "0x", "0x123", "not-an-address"]) {
        await expect(preflight(client(), { ...cfg, bridgeAddress }, quiet)).rejects.toThrow(PreflightError);
        await expect(preflight(client(), { ...cfg, bridgeAddress }, quiet)).rejects.toThrow(/ROUGE_BRIDGE_ADDRESS/);
      }
      // A chain-id-only client (what a carve-out would have needed) is not enough either: the bridge
      // checks run before anything else after the chain id, so getCode/readContract must be consulted.
      let bridgeReadsAttempted = 0;
      const probe = {
        getChainId: async () => 8453,
        getCode: async () => { bridgeReadsAttempted++; return undefined; },
        readContract: async () => { bridgeReadsAttempted++; throw new Error("unreachable"); },
      };
      await expect(preflight(probe, { ...cfg, bridgeAddress: undefined }, quiet)).rejects.toThrow(/ROUGE_BRIDGE_ADDRESS/);
      expect(bridgeReadsAttempted).toBe(0); // refused before touching the chain
      await expect(preflight(probe, cfg, quiet)).rejects.toThrow(/no contract code at ROUGE_BRIDGE_ADDRESS/);
      expect(bridgeReadsAttempted).toBe(1);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});
