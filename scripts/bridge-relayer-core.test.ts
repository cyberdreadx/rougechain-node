// Relayer core unit tests — pure logic, NO network. Every on-chain/daemon interaction is a
// fake injected through EvmPayoutDeps / PreflightClient.
//   npx vitest run --config scripts/vitest.config.ts

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { encodeEventTopics, encodeAbiParameters, keccak256, stringToBytes, getAddress, type Hex } from "viem";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  bridgeHealthAllowsPayouts,
  observeOnlyEnabled,
  observeGuardedDeps,
  observeXrgeWithdrawal,
  observeDeposit,
  guardWrite,
  ObserveOnlyViolation,
  scanLogPagesDescending,
  evmFulfillDepth,
  depositWatcherSafeHead,
  processXrgeWithdrawal,
  findVaultReleases,
  blockRangesDescending,
  xrgeFulfillConfirmations,
  daemonMinConfirmations,
  isAwaitingConfirmationsError,
  MAX_LOG_SCAN_SPAN,
  type XrgePayoutDeps,
  type VaultReleaseLog,
  type XrgeFulfillResult,
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
  /** chain head for the confirmation-depth gate (default: far ahead ⇒ every payout is deep) */
  head?: bigint | (() => Promise<bigint>);
  /** block the freshly submitted release is mined in (default 1) */
  receiptBlock?: bigint;
  fulfillConfirmations?: number;
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
    waitForReceipt: async (hash) => ({ status: o.receiptStatus ?? "success", logs: o.receiptLogs ?? [], transactionHash: hash, blockNumber: o.receiptBlock ?? 1n }),
    getReceipt: async (hash) => { const r = o.receipts?.[hash]; return r ? { blockNumber: 1n, ...r } : null; },
    headBlock: async () => (typeof o.head === "function" ? o.head() : o.head ?? 1_000_000n),
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
    fulfillConfirmations: o.fulfillConfirmations ?? 2,
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
      "findTimelockQueuedEvent", "getNonce", "getReceipt", "headBlock", "processedL1Txs", "releaseERC20", "releaseETH",
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
    f.deps.chain.getReceipt = async () => ({ status: "success", logs: [releaseEthLog()], blockNumber: 1n });
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

describe("daemon bridge health gate (derived payout-store hardening)", () => {
  it("permits payouts only on an explicit healthy 200 { degraded:false }", () => {
    expect(bridgeHealthAllowsPayouts({ status: 200, body: { degraded: false, failed_tx_ids: [], pending: 0 } })).toBe(true);
  });
  it("fails closed on degraded (503), on 200 without an explicit degraded:false, and when unreachable", () => {
    expect(bridgeHealthAllowsPayouts({ status: 503, body: { degraded: true, failed_tx_ids: ["xrge:abc"] } })).toBe(false);
    expect(bridgeHealthAllowsPayouts({ status: 200, body: { degraded: true } })).toBe(false);
    expect(bridgeHealthAllowsPayouts({ status: 200, body: {} })).toBe(false);
    expect(bridgeHealthAllowsPayouts({ status: 500, body: null })).toBe(false);
    expect(bridgeHealthAllowsPayouts(null)).toBe(false);
    expect(bridgeHealthAllowsPayouts(undefined)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OBSERVATION MODE (BRIDGE_OBSERVE_ONLY=true): ZERO write calls. Every test wires spies behind
// the same guards production uses and requires every write counter to stay at 0.
// ─────────────────────────────────────────────────────────────────────────────
describe("observation mode — zero writes", () => {
  const writesOf = (c: Calls) => c.releaseETH.length + c.releaseERC20.length + c.fulfill.length + c.reportFailure.length + c.refund.length;
  const observed = (o: FakeOpts = {}) => { const f = fake(o); return { ...f, deps: observeGuardedDeps(f.deps) }; };

  it("flag parsing: default FALSE; only the literal true enables it", () => {
    expect(observeOnlyEnabled({})).toBe(false);
    expect(observeOnlyEnabled({ BRIDGE_OBSERVE_ONLY: "" })).toBe(false);
    expect(observeOnlyEnabled({ BRIDGE_OBSERVE_ONLY: "false" })).toBe(false);
    expect(observeOnlyEnabled({ BRIDGE_OBSERVE_ONLY: "1" })).toBe(false);
    expect(observeOnlyEnabled({ BRIDGE_OBSERVE_ONLY: "true" })).toBe(true);
    expect(observeOnlyEnabled({ BRIDGE_OBSERVE_ONLY: " TRUE " })).toBe(true);
  });

  it("qETH pending → logs WOULD_RELEASE, never calls releaseETH / fulfill / failure / refund, no local state", async () => {
    const f = observed({ receiptLogs: [releaseEthLog()], autoRefund: true, shouldRefund: true });
    expect(await processEvmWithdrawal(ethWithdrawal(), f.deps)).toBe("observed");
    expect(writesOf(f.calls)).toBe(0);
    expect(f.processedSet.size).toBe(0); expect(f.saves()).toBe(0); expect(f.queued.size).toBe(0);
    expect(f.calls.logs.some((l) => l.startsWith("[OBSERVE] WOULD_RELEASE qETH") && l.includes(CANON))).toBe(true);
  });

  it("qUSDC pending → logs WOULD_RELEASE, never calls releaseERC20", async () => {
    const f = observed({ receiptLogs: [releaseErc20Log(), transferLog()] });
    expect(await processEvmWithdrawal(usdcWithdrawal(), f.deps)).toBe("observed");
    expect(writesOf(f.calls)).toBe(0);
    expect(f.calls.logs.some((l) => l.startsWith("[OBSERVE] WOULD_RELEASE qUSDC"))).toBe(true);
  });

  it("already paid on RougeBridge → read-only reconciliation logs WOULD_FULFILL, fulfills nothing", async () => {
    const f = observed({ processed: true, releaseTxHashes: [TX1], receipts: { [TX1]: { status: "success", logs: [releaseEthLog()] } } });
    expect(await processEvmWithdrawal(ethWithdrawal(), f.deps)).toBe("observed");
    expect(writesOf(f.calls)).toBe(0); expect(f.processedSet.size).toBe(0);
    expect(f.calls.logs.some((l) => l.includes("[OBSERVE] WOULD_FULFILL") && l.includes(TX1))).toBe(true);
  });

  it("queued withdrawal → read-only timelock inspection only (no fulfill, no status change, no save)", async () => {
    const live = fake({ receiptLogs: [queuedLog(42n, 1000n)], timelock: { "42": ethRecord() } });
    await processEvmWithdrawal(ethWithdrawal(), live.deps); // create the queued record with writes enabled
    const before = JSON.stringify([...live.queued.entries()]); const savesBefore = live.saves();
    const calls0 = writesOf(live.calls);
    // now observe the same state with the timelock EXECUTED on-chain
    const exec = fake({ queued: live.queued, timelock: { "42": ethRecord({ executed: true }) }, executedTxHashes: [TX2], receipts: { [TX2]: { status: "success", logs: [releaseEthLog()] } } });
    const od = observeGuardedDeps(exec.deps);
    await pollQueuedWithdrawals(od);
    expect(await processEvmWithdrawal(ethWithdrawal(), od)).toBe("skipped_queued");
    expect(writesOf(exec.calls)).toBe(0); expect(exec.saves()).toBe(0); expect(exec.processedSet.size).toBe(0);
    expect(JSON.stringify([...live.queued.entries()])).toBe(before);
    expect(live.saves()).toBe(savesBefore); expect(writesOf(live.calls)).toBe(calls0);
    expect(exec.calls.logs.some((l) => l.includes("[OBSERVE] queued qETH") && l.includes("EXECUTED"))).toBe(true);
  });

  it("refund-eligible failure shape → no failure report, no refund (even with AUTO_REFUND=true)", async () => {
    const f = observed({ releaseThrows: "rpc down", shouldRefund: true, attempts: 9, autoRefund: true, refundOk: true });
    expect(await processEvmWithdrawal(ethWithdrawal(), f.deps)).toBe("observed");
    expect(writesOf(f.calls)).toBe(0);
    // the mutation helpers themselves refuse if ever reached
    await expect(guardedRefund(ethWithdrawal(), "Eth", f.deps, 9)).rejects.toThrow(ObserveOnlyViolation);
    expect(f.calls.refund).toHaveLength(0);
  });

  it("lowest-layer guards: every guarded writer throws BEFORE the underlying function runs", async () => {
    const f = observed();
    expect(() => f.deps.chain.releaseETH(RECIPIENT, 1n, CANON, 1)).toThrow(ObserveOnlyViolation);
    expect(() => f.deps.chain.releaseERC20(USDC, RECIPIENT, 1n, CANON, 1)).toThrow(ObserveOnlyViolation);
    expect(() => f.deps.daemon.fulfill(STORED_TX_ID, TX1)).toThrow(ObserveOnlyViolation);
    expect(() => f.deps.daemon.reportFailure(STORED_TX_ID, "x")).toThrow(ObserveOnlyViolation);
    expect(() => f.deps.daemon.refund(STORED_TX_ID)).toThrow(ObserveOnlyViolation);
    expect(() => f.deps.markProcessed(STORED_TX_ID)).toThrow(ObserveOnlyViolation);
    expect(() => f.deps.saveQueued()).toThrow(ObserveOnlyViolation);
    expect(writesOf(f.calls)).toBe(0); expect(f.processedSet.size).toBe(0); expect(f.saves()).toBe(0);
    expect(f.calls.logs.filter((l) => l.startsWith("[OBSERVE] WOULD_")).length).toBe(7);
  });

  it("XRGE pending → inspect/reconcile only: no vault.release, no fulfill, no failure, no refund", async () => {
    const spies = { vaultRelease: 0, fulfill: 0, failure: 0, refund: 0 }; const logs: string[] = [];
    const W = {
      vaultRelease: guardWrite(true, "WOULD_RELEASE", () => "vault.release", () => { spies.vaultRelease++; }, (m) => logs.push(m)),
      fulfill: guardWrite(true, "WOULD_FULFILL", () => "xrge fulfill", () => { spies.fulfill++; }, (m) => logs.push(m)),
      failure: guardWrite(true, "WOULD_REPORT_FAILURE", () => "xrge failure", () => { spies.failure++; }, (m) => logs.push(m)),
      refund: guardWrite(true, "WOULD_REFUND", () => "xrge refund", () => { spies.refund++; }, (m) => logs.push(m)),
    };
    const w = { tx_id: STORED_TX_ID, evm_address: RECIPIENT, amount: 250 };
    expect(await observeXrgeWithdrawal(w, { processedOnVault: async () => false, findReleaseTx: async () => null, log: (m) => logs.push(m) })).toBe("would_release");
    expect(await observeXrgeWithdrawal(w, { processedOnVault: async () => true, findReleaseTx: async () => TX1, log: (m) => logs.push(m) })).toBe("would_fulfill");
    expect(await observeXrgeWithdrawal(w, { processedOnVault: async () => true, findReleaseTx: async () => null, log: (m) => logs.push(m) })).toBe("processed_no_release_found");
    expect(await observeXrgeWithdrawal(w, { processedOnVault: async () => { throw new Error("rpc"); }, findReleaseTx: async () => null, log: (m) => logs.push(m) })).toBe("read_failed");
    for (const fn of Object.values(W)) expect(() => (fn as any)()).toThrow(ObserveOnlyViolation);
    expect(spies).toEqual({ vaultRelease: 0, fulfill: 0, failure: 0, refund: 0 });
    expect(logs.some((l) => l.startsWith("[OBSERVE] WOULD_RELEASE XRGE 250"))).toBe(true);
    expect(logs.some((l) => l.startsWith("[OBSERVE] WOULD_FULFILL XRGE"))).toBe(true);
  });

  it("deposit → logs WOULD_CLAIM_DEPOSIT, never claims/mints", () => {
    let claims = 0; const logs: string[] = [];
    const autoClaim = guardWrite(true, "WOULD_CLAIM_DEPOSIT", (h: string) => h, (_h: string) => { claims++; return true; }, (m) => logs.push(m));
    observeDeposit({ token: "XRGE", txHash: TX1, pubkey: "ab".repeat(40) }, (m) => logs.push(m));
    expect(() => autoClaim(TX1)).toThrow(ObserveOnlyViolation);
    expect(claims).toBe(0);
    expect(logs[0].startsWith("[OBSERVE] WOULD_CLAIM_DEPOSIT XRGE")).toBe(true);
  });

  it("guardWrite is transparent when observation mode is OFF", () => {
    let n = 0; const fn = guardWrite(false, "WOULD_RELEASE", () => "x", () => { n++; return 5; });
    expect(fn()).toBe(5); expect(n).toBe(1);
  });

  it("preflight and the bridge-health gate still execute normally in observation mode", async () => {
    const client = {
      getChainId: async () => 8453, getCode: async () => "0x6001" as Hex,
      readContract: async ({ functionName }: any) => functionName === "owner" ? SIGNER : functionName === "paused" ? false : true,
    };
    const r = await preflight(client as any, { expectedChainId: 8453, bridgeAddress: BRIDGE, configuredUsdc: undefined, chainUsdc: USDC, vaultAddress: undefined, expectedOwner: SIGNER }, () => {});
    expect(r).toEqual({ paused: false, owner: SIGNER, chainId: 8453 });
    await expect(preflight(client as any, { expectedChainId: 8453, bridgeAddress: BRIDGE, configuredUsdc: undefined, chainUsdc: USDC, vaultAddress: undefined, expectedOwner: RECIPIENT }, () => {})).rejects.toThrow(PreflightError);
    expect(bridgeHealthAllowsPayouts({ status: 200, body: { degraded: false } })).toBe(true);
    expect(bridgeHealthAllowsPayouts({ status: 503, body: { degraded: true } })).toBe(false);
    expect(bridgeHealthAllowsPayouts(null)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// XRGE payout lifecycle (block-53 controlled-test regressions)
// ─────────────────────────────────────────────────────────────────────────────
describe("XRGE payout lifecycle — processed-first, confirmation depth, RPC-safe scans", () => {
  const TXID = "60e06d7dcc6b213529e2042f7d1c707f3e7cdd1a2895ba108ef43a2e603a0133";
  const PAYOUT = "0x1aa4c09d90d4c70bafa6972761816b70820bedcad2139233d272e41eead5f55c";
  const W = { tx_id: TXID, evm_address: RECIPIENT, amount: 1 };
  const ONE = 10n ** 18n;
  interface X { processed?: boolean | (() => Promise<boolean>); head?: bigint; releases?: VaultReleaseLog[] | (() => Promise<VaultReleaseLog[]>); fulfill?: (n: number) => XrgeFulfillResult; releaseThrows?: string; receiptStatus?: "success" | "reverted"; receiptBlock?: bigint; required?: number; pending?: Map<string, { txHash: string; blockNumber: bigint }> }
  function xfake(o: X = {}) {
    const c = { release: [] as any[], fulfill: [] as any[], failure: [] as any[], alerts: [] as string[], logs: [] as string[], processed: [] as string[] };
    let head = o.head ?? 1000n;
    const deps: XrgePayoutDeps = {
      requiredConfirmations: o.required ?? 6,
      processedOnVault: async () => (typeof o.processed === "function" ? o.processed() : !!o.processed),
      release: async (to, wei, id) => { c.release.push({ to, wei, id }); if (o.releaseThrows) throw new Error(o.releaseThrows); return PAYOUT; },
      waitForReceipt: async () => ({ status: o.receiptStatus ?? "success", blockNumber: o.receiptBlock ?? 1000n }),
      headBlock: async () => head,
      findReleases: async () => (typeof o.releases === "function" ? o.releases() : o.releases ?? []),
      fulfill: async (txId, h) => { c.fulfill.push({ txId, h }); return o.fulfill ? o.fulfill(c.fulfill.length) : { ok: true, status: 200 }; },
      handleFailure: async (txId, e) => { c.failure.push({ txId, e }); },
      markProcessed: (id) => c.processed.push(id),
      pendingFulfill: o.pending ?? new Map(),
      alert: (k, m) => { c.alerts.push(`${k}: ${m}`); },
      log: (m) => c.logs.push(m), warn: (m) => c.logs.push(m),
    };
    return { deps, c, setHead: (h: bigint) => { head = h; } };
  }
  const rel = (o: Partial<VaultReleaseLog> = {}): VaultReleaseLog => ({ txHash: PAYOUT, blockNumber: 900n, recipient: RECIPIENT, amount: ONE, l1TxId: TXID, ...o });

  it("ONE confirmation value: never below the daemon requirement (default 6)", () => {
    expect(daemonMinConfirmations({})).toBe(6);
    expect(daemonMinConfirmations({ QV_BRIDGE_MIN_CONFIRMATIONS: "12" })).toBe(12);
    expect(xrgeFulfillConfirmations(2, {})).toBe(6);
    expect(xrgeFulfillConfirmations(10, {})).toBe(10);
    expect(xrgeFulfillConfirmations(2, { QV_BRIDGE_MIN_CONFIRMATIONS: "3" })).toBe(3);
  });

  it("already-processed XRGE NEVER calls release(): reconciles the existing payout and fulfills with THAT tx hash", async () => {
    const f = xfake({ processed: true, releases: [rel()], head: 1000n });
    expect(await processXrgeWithdrawal(W, f.deps)).toBe("reconciled_fulfilled");
    expect(f.c.release).toHaveLength(0);
    expect(f.c.fulfill).toEqual([{ txId: TXID, h: PAYOUT }]);
    expect(f.c.processed).toEqual([TXID]);
    expect(f.c.failure).toHaveLength(0);
  });

  it("restart with paid-but-pending daemon state (empty in-memory map) reconciles from chain logs", async () => {
    const f = xfake({ processed: true, releases: [rel({ blockNumber: 500n })], head: 51_000n, pending: new Map() });
    expect(await processXrgeWithdrawal(W, f.deps)).toBe("reconciled_fulfilled");
    expect(f.c.release).toHaveLength(0); expect(f.c.fulfill[0].h).toBe(PAYOUT); expect(f.c.failure).toHaveLength(0);
  });

  it("insufficient confirmations: no fulfill call, no release, no failure; fulfills once deep enough", async () => {
    const f = xfake({ processed: true, releases: [rel({ blockNumber: 998n })], head: 1000n }); // depth 3 < 6
    expect(await processXrgeWithdrawal(W, f.deps)).toBe("awaiting_confirmations");
    expect(f.c.fulfill).toHaveLength(0); expect(f.c.release).toHaveLength(0); expect(f.c.failure).toHaveLength(0);
    f.setHead(1003n); // depth 6
    expect(await processXrgeWithdrawal(W, f.deps)).toBe("reconciled_fulfilled");
    expect(f.c.fulfill).toEqual([{ txId: TXID, h: PAYOUT }]); expect(f.c.release).toHaveLength(0);
  });

  it("daemon answers 'needs N confirmations' → retry-later bookkeeping: never another release, never failure/refund", async () => {
    const f = xfake({ processed: false, receiptBlock: 1000n, head: 1005n, required: 6,
      fulfill: (n) => n === 1 ? { ok: false, status: 200, error: "payout needs 6 confirmations (block 1000, latest 1004)" } : { ok: true, status: 200 } });
    expect(await processXrgeWithdrawal(W, f.deps)).toBe("awaiting_confirmations");
    expect(f.c.release).toHaveLength(1); expect(f.c.failure).toHaveLength(0);
    expect(isAwaitingConfirmationsError({ ok: false, status: 200, error: "payout needs 6 confirmations" })).toBe(true);
    // next poll: the vault now reports processed — the remembered payout is fulfilled; release is NOT called again
    const g = xfake({ processed: true, head: 1010n, pending: f.deps.pendingFulfill });
    expect(await processXrgeWithdrawal(W, g.deps)).toBe("reconciled_fulfilled");
    expect(g.c.release).toHaveLength(0); expect(g.c.fulfill).toEqual([{ txId: TXID, h: PAYOUT }]); expect(g.c.failure).toHaveLength(0);
  });

  it("fresh release waits for depth before fulfilling (the block-53 shape: mined at depth 1)", async () => {
    const f = xfake({ processed: false, receiptBlock: 1000n, head: 1000n });
    expect(await processXrgeWithdrawal(W, f.deps)).toBe("awaiting_confirmations");
    expect(f.c.release).toHaveLength(1); expect(f.c.fulfill).toHaveLength(0); expect(f.c.failure).toHaveLength(0);
    expect(f.deps.pendingFulfill.get(TXID)).toEqual({ txHash: PAYOUT, blockNumber: 1000n });
  });

  it("RPC failure checking processedL1Txs fails closed: no release, no fulfill, no failure", async () => {
    const f = xfake({ processed: async () => { throw new Error("rpc down"); } });
    expect(await processXrgeWithdrawal(W, f.deps)).toBe("skipped_rpc");
    expect(f.c.release).toHaveLength(0); expect(f.c.fulfill).toHaveLength(0); expect(f.c.failure).toHaveLength(0);
  });

  it("already-paid withdrawal never enters the failure/refund path — even when the log scan fails or the daemon rejects", async () => {
    const scanFail = xfake({ processed: true, releases: async () => { throw new Error("RPC Request failed."); } });
    expect(await processXrgeWithdrawal(W, scanFail.deps)).toBe("skipped_rpc");
    const none = xfake({ processed: true, releases: [] });
    expect(await processXrgeWithdrawal(W, none.deps)).toBe("processed_no_release_found");
    const rejected = xfake({ processed: true, releases: [rel()], fulfill: () => ({ ok: false, status: 200, error: "payout sender 0xabc is not the XRGE vault" }) });
    expect(await processXrgeWithdrawal(W, rejected.deps)).toBe("fulfill_rejected");
    expect(rejected.c.logs.some((l) => l.includes("HTTP 200") && l.includes("not the XRGE vault"))).toBe(true);
    for (const f of [scanFail, none, rejected]) { expect(f.c.release).toHaveLength(0); expect(f.c.failure).toHaveLength(0); }
  });

  it("two BridgeRelease events or a recipient/amount mismatch → ambiguous: no fulfill, no release, no refund", async () => {
    const dup = xfake({ processed: true, releases: [rel(), rel({ txHash: TX2 })] });
    expect(await processXrgeWithdrawal(W, dup.deps)).toBe("ambiguous");
    const wrong = xfake({ processed: true, releases: [rel({ amount: 2n * ONE })] });
    expect(await processXrgeWithdrawal(W, wrong.deps)).toBe("ambiguous");
    for (const f of [dup, wrong]) { expect(f.c.fulfill).toHaveLength(0); expect(f.c.release).toHaveLength(0); expect(f.c.failure).toHaveLength(0); }
  });

  it("a genuine release failure (id NOT processed afterwards) is the ONLY path that reports failure", async () => {
    const f = xfake({ processed: false, releaseThrows: "insufficient funds" });
    expect(await processXrgeWithdrawal(W, f.deps)).toBe("failed");
    expect(f.c.failure).toEqual([{ txId: TXID, e: "insufficient funds" }]);
    let n = 0; const landed = xfake({ processed: async () => ++n > 1, releaseThrows: "timeout" }); // errored, but the send landed
    expect(await processXrgeWithdrawal(W, landed.deps)).toBe("awaiting_confirmations");
    expect(landed.c.failure).toHaveLength(0);
  });

  it("log scanning never requests > 2,000 blocks; pages are contiguous with no gaps or overlaps", async () => {
    const asked: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
    const hits = await findVaultReleases(async (r) => { asked.push(r); return r.fromBlock <= 51_523_968n && 51_523_968n <= r.toBlock ? [rel({ blockNumber: 51_523_968n })] : []; }, TXID, 51_530_000n, 400_000n);
    expect(hits).toHaveLength(1);
    expect(asked.length).toBe(201);
    for (const r of asked) expect(r.toBlock - r.fromBlock + 1n <= MAX_LOG_SCAN_SPAN).toBe(true);
    expect(asked[0].toBlock).toBe(51_530_000n); expect(asked[asked.length - 1].fromBlock).toBe(51_130_000n);
    for (let i = 1; i < asked.length; i++) expect(asked[i].toBlock).toBe(asked[i - 1].fromBlock - 1n); // contiguous, no overlap
    expect(blockRangesDescending(0n, 10n)).toEqual([{ fromBlock: 0n, toBlock: 10n }]);
    expect(blockRangesDescending(5n, 4n)).toEqual([]);
    expect(() => blockRangesDescending(0n, 10n, 2001n)).toThrow();
    await expect(findVaultReleases(async () => { throw new Error("rpc"); }, TXID, 100n, 50n)).rejects.toThrow("rpc"); // unknown ≠ not released
    // rate-limited pages are RETRIED in place (never skipped) and paced; exhaustion still throws
    let calls = 0; const seen: string[] = []; const slept: number[] = [];
    const got = await findVaultReleases(async (r) => { calls++; if (calls % 2 === 1) throw new Error("429"); seen.push(`${r.fromBlock}-${r.toBlock}`); return []; }, TXID, 5999n, 5999n, 2000n, { retries: 3, backoffMs: 10, pauseMs: 5, sleep: async (ms) => { slept.push(ms); } });
    expect(got).toEqual([]); expect(seen).toEqual(["4000-5999", "2000-3999", "0-1999"]); expect(slept.filter((m) => m === 5)).toHaveLength(3);
    await expect(findVaultReleases(async () => { throw new Error("429"); }, TXID, 100n, 50n, 2000n, { retries: 2, backoffMs: 1, sleep: async () => {} })).rejects.toThrow("429");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// qETH / qUSDC lifecycle hardening: daemon-required fulfill depth + RPC-safe scans
// ─────────────────────────────────────────────────────────────────────────────
describe("qETH/qUSDC — fulfill depth never below the daemon requirement; scans ≤ 2,000 blocks and fail closed", () => {
  const writes = (c: Calls) => c.releaseETH.length + c.releaseERC20.length;
  const cases = [
    { name: "qETH", w: () => ethWithdrawal(), logs: () => [releaseEthLog()], rel: (c: Calls) => c.releaseETH },
    { name: "qUSDC", w: () => usdcWithdrawal(), logs: () => [releaseErc20Log(), transferLog()], rel: (c: Calls) => c.releaseERC20 },
  ];

  it("effective depth = max(relayer CONFIRMATIONS, daemon QV_BRIDGE_MIN_CONFIRMATIONS [default 6])", () => {
    expect(evmFulfillDepth({ fulfillConfirmations: 2 }, {})).toBe(6);
    expect(evmFulfillDepth({ fulfillConfirmations: 9 }, {})).toBe(9);
    expect(evmFulfillDepth({}, { QV_BRIDGE_MIN_CONFIRMATIONS: "12" })).toBe(12);
  });

  for (const k of cases) {
    it(`${k.name}: payout at 2 confirmations does NOT call daemon fulfill (requirement 6); fulfillable at depth 6; never a second release`, async () => {
      let head = 101n; // mined at 100 ⇒ depth 2
      let processed = false;
      const f = fake({ receiptLogs: k.logs(), receiptBlock: 100n, head: async () => head, processed: async () => processed,
        releaseTxHashes: [TX1], receipts: { [TX1]: { status: "success", logs: k.logs(), blockNumber: 100n } }, autoRefund: true, shouldRefund: true });
      expect(await processEvmWithdrawal(k.w(), f.deps)).toBe("awaiting_confirmations");
      expect(k.rel(f.calls)).toHaveLength(1);
      expect(f.calls.fulfill).toHaveLength(0); expect(f.calls.reportFailure).toHaveLength(0); expect(f.calls.refund).toHaveLength(0);
      expect(f.processedSet.size).toBe(0); expect(f.queued.size).toBe(0);
      // next poll: RougeBridge reports the id processed; still only depth 4 ⇒ wait, no second release
      processed = true; head = 103n;
      expect(await processEvmWithdrawal(k.w(), f.deps)).toBe("awaiting_confirmations");
      expect(writes(f.calls)).toBe(1); expect(f.calls.fulfill).toHaveLength(0);
      // depth 6 ⇒ reconciles and fulfills with the ORIGINAL payout tx; still exactly one release
      head = 105n;
      expect(await processEvmWithdrawal(k.w(), f.deps)).toBe("reconciled_paid");
      expect(f.calls.fulfill).toEqual([{ txId: STORED_TX_ID, hash: TX1 }]);
      expect(writes(f.calls)).toBe(1); expect(f.calls.reportFailure).toHaveLength(0); expect(f.calls.refund).toHaveLength(0);
    });

    it(`${k.name}: immediate release already at the required depth fulfills in the same poll`, async () => {
      const f = fake({ receiptLogs: k.logs(), receiptBlock: 100n, head: 105n });
      expect(await processEvmWithdrawal(k.w(), f.deps)).toBe("fulfilled");
      expect(f.calls.fulfill).toEqual([{ txId: STORED_TX_ID, hash: TX1 }]);
    });

    it(`${k.name}: already-processed payout waits for confirmations, then reconciles — never released`, async () => {
      let head = 100n;
      const f = fake({ processed: true, head: async () => head, releaseTxHashes: [TX1], receipts: { [TX1]: { status: "success", logs: k.logs(), blockNumber: 100n } }, autoRefund: true, shouldRefund: true });
      expect(await processEvmWithdrawal(k.w(), f.deps)).toBe("awaiting_confirmations");
      head = 105n;
      expect(await processEvmWithdrawal(k.w(), f.deps)).toBe("reconciled_paid");
      expect(writes(f.calls)).toBe(0); expect(f.calls.fulfill).toHaveLength(1); expect(f.calls.reportFailure).toHaveLength(0); expect(f.calls.refund).toHaveLength(0);
    });
  }

  it("unknown payout block or unreadable head ⇒ fulfill deferred (retry later), never failure/refund", async () => {
    const noBlock = fake({ processed: true, releaseTxHashes: [TX1], receipts: { [TX1]: { status: "success", logs: [releaseEthLog()], blockNumber: undefined } as any } });
    (noBlock.deps.chain as any).getReceipt = async () => ({ status: "success", logs: [releaseEthLog()] });
    expect(await processEvmWithdrawal(ethWithdrawal(), noBlock.deps)).toBe("awaiting_confirmations");
    const headDown = fake({ receiptLogs: [releaseEthLog()], receiptBlock: 100n, head: async () => { throw new Error("rpc"); } });
    expect(await processEvmWithdrawal(ethWithdrawal(), headDown.deps)).toBe("awaiting_confirmations");
    for (const f of [noBlock, headDown]) { expect(f.calls.fulfill).toHaveLength(0); expect(f.calls.reportFailure).toHaveLength(0); expect(f.calls.refund).toHaveLength(0); }
  });

  it("executed timelock payout obeys the same depth", async () => {
    const live = fake({ receiptLogs: [queuedLog(42n, 1000n)], timelock: { "42": ethRecord() } });
    expect(await processEvmWithdrawal(ethWithdrawal(), live.deps)).toBe("queued");
    let head = 501n; // execution mined at 500 ⇒ depth 2
    const exec = fake({ queued: live.queued, head: async () => head, timelock: { "42": ethRecord({ executed: true }) }, executedTxHashes: [TX2],
      receipts: { [TX2]: { status: "success", logs: [releaseEthLog()], blockNumber: 500n } }, autoRefund: true, shouldRefund: true });
    await pollQueuedWithdrawals(exec.deps);
    expect(exec.calls.fulfill).toHaveLength(0); expect(exec.queued.get(queuedKey(CANON))?.status).toBe("queued"); // untouched while waiting
    head = 505n;
    await pollQueuedWithdrawals(exec.deps);
    expect(exec.calls.fulfill).toEqual([{ txId: STORED_TX_ID, hash: TX2 }]);
    expect(exec.queued.has(queuedKey(CANON))).toBe(false);
    expect(writes(exec.calls)).toBe(0); expect(exec.calls.reportFailure).toHaveLength(0); expect(exec.calls.refund).toHaveLength(0);
  });

  it("a failed/rate-limited reconciliation scan is UNKNOWN: nothing persisted, no ambiguous record, no release/failure/refund", async () => {
    const f = fake({ processed: true, autoRefund: true, shouldRefund: true });
    (f.deps.chain as any).findReleaseTxHashes = async () => { throw new Error("429 Too Many Requests"); };
    expect(await processEvmWithdrawal(ethWithdrawal(), f.deps)).toBe("skipped_rpc");
    expect(f.queued.size).toBe(0); expect(f.saves()).toBe(0);
    expect(f.calls.alerts.filter((a) => a.startsWith("ambiguous"))).toHaveLength(0);
    expect(writes(f.calls)).toBe(0); expect(f.calls.fulfill).toHaveLength(0); expect(f.calls.reportFailure).toHaveLength(0); expect(f.calls.refund).toHaveLength(0);
    // a positively verified payout is still Paid even if a LATER scan page would have failed
    const r = await reconcileProcessedId(expectedReleaseFor(ethWithdrawal(), "Eth", BRIDGE, USDC), fake({ processed: true, releaseTxHashes: [TX1], receipts: { [TX1]: { status: "success", logs: [releaseEthLog()] } } }).deps);
    expect(r.cls).toBe("Paid"); expect(r.scanFailed).toBe(false);
  });

  it("generic paginator: no query > 2,000 blocks, contiguous/non-overlapping, retried in place, exhaustion throws", async () => {
    const asked: Array<[bigint, bigint]> = [];
    const out = await scanLogPagesDescending(async (r) => { asked.push([r.fromBlock, r.toBlock]); return [Number(r.toBlock)]; }, 51_440_000n, 51_500_000n);
    expect(asked).toHaveLength(31); expect(out).toHaveLength(31);
    for (const [a, b] of asked) expect(b - a + 1n <= 2000n).toBe(true);
    expect(asked[0][1]).toBe(51_500_000n); expect(asked[asked.length - 1][0]).toBe(51_440_000n);
    for (let i = 1; i < asked.length; i++) expect(asked[i][1]).toBe(asked[i - 1][0] - 1n);
    let n = 0; const pages: string[] = [];
    await scanLogPagesDescending(async (r) => { if (++n % 2 === 1) throw new Error("429"); pages.push(`${r.fromBlock}-${r.toBlock}`); return []; }, 0n, 3999n, 2000n, { retries: 2, backoffMs: 1, sleep: async () => {} });
    expect(pages).toEqual(["2000-3999", "0-1999"]); // each page retried in place, none skipped
    await expect(scanLogPagesDescending(async () => { throw new Error("rate limited"); }, 0n, 10n, 2000n, { retries: 3, backoffMs: 1, sleep: async () => {} })).rejects.toThrow("rate limited");
    expect(() => scanLogPagesDescending(async () => [], 0n, 10n, 5000n)).rejects.toThrow();
  });
});

describe("deposit watcher — never scans newer than the daemon-required confirmation depth", () => {
  it("safe head = head − max(CONFIRMATIONS, QV_BRIDGE_MIN_CONFIRMATIONS [default 6])", () => {
    expect(depositWatcherSafeHead(1000n, 2, {})).toBe(994n);          // relayer 2 < daemon 6 ⇒ 6
    expect(depositWatcherSafeHead(1000n, 10, {})).toBe(990n);         // relayer stricter ⇒ 10
    expect(depositWatcherSafeHead(1000n, 2, { QV_BRIDGE_MIN_CONFIRMATIONS: "12" })).toBe(988n);
    expect(depositWatcherSafeHead(1000n, NaN, {})).toBe(994n);
    // a deposit at block 995 (depth 6 from head 1000 is block 994) is NOT yet visible to the watcher
    expect(995n > depositWatcherSafeHead(1000n, 2, {})!).toBe(true);
    expect(depositWatcherSafeHead(5n, 2, {})).toBeNull();             // chain too young ⇒ nothing to scan
    expect(depositWatcherSafeHead(6n, 2, {})).toBeNull();
  });
});
