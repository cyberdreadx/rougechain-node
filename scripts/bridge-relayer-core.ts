/**
 * Bridge relayer — pure, network-free core (R1B / R1D / R1E).
 *
 * Everything here is deterministic and testable without an RPC: routing, the canonical
 * RougeBridge withdrawal id, receipt/event verification, timelock binding, processed-id
 * classification, the refund gate, queued-state persistence, the production preflight and
 * the per-withdrawal orchestration (with every side effect injected through `EvmPayoutDeps`).
 *
 * Semantics mirror `core/bridge-exec/src/lib.rs` EXACTLY:
 *   payout_route · rouge_bridge_id · timelock_record_matches · classify_processed · refund_decision
 */

import {
  keccak256,
  stringToBytes,
  parseAbi,
  parseAbiItem,
  decodeEventLog,
  isAddress,
  getAddress,
  type Hex,
} from "viem";
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from "fs";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ── Canonical id ────────────────────────────────────────────────────────────

/**
 * Canonical RougeBridge withdrawal id: keccak256(UTF8(stored_tx_id)). The SINGLE bytes32
 * `l1TxId` used for release calls, event matching, processedL1Txs queries, reconciliation
 * and the refund guard. `storedTxId` is the store record's `tx_id` EXACTLY as persisted.
 * Mirrors Rust `rouge_bridge_id` (`Keccak256(stored_tx_id.as_bytes())`).
 *
 * `stringToBytes` is used (not `toBytes`) so the preimage is ALWAYS the UTF-8 text — viem's
 * `toBytes` would hex-decode a `0x`-prefixed string. For every real stored id (bare hex or
 * `xrge:`-prefixed) the two are identical; this just removes the footgun.
 */
export function rougeBridgeId(storedTxId: string): Hex {
  return keccak256(stringToBytes(storedTxId));
}

/** Lenient address validity (any casing); on-chain calls normalize with `getAddress`. */
export function isEvmAddress(a: string | null | undefined): boolean {
  return !!a && isAddress(a, { strict: false });
}

// ── Routing (R1B) ───────────────────────────────────────────────────────────

export type PayoutRoute = "Xrge" | "Eth" | "Usdc" | "Btc" | "Unsupported";

/**
 * XRGE → Xrge · qETH → Eth · qUSDC → Usdc · qBTC → Btc · anything else → Unsupported.
 * Case-insensitive on the protocol assets. There is NO default/catch-all EVM route.
 * Mirrors Rust `payout_route`.
 */
export function payoutRoute(tokenSymbol: string | null | undefined): PayoutRoute {
  const t = (tokenSymbol ?? "").trim().toLowerCase();
  if (t === "xrge") return "Xrge";
  if (t === "qeth") return "Eth";
  if (t === "qusdc") return "Usdc";
  if (t === "qbtc") return "Btc";
  return "Unsupported";
}

export type EvmAsset = "Eth" | "Usdc";

// ── Withdrawal records ──────────────────────────────────────────────────────

export interface EthWithdrawal {
  txId?: string;
  tx_id?: string;
  evmAddress?: string;
  evm_address?: string;
  amountUnits?: number;
  amount_units?: number;
  tokenSymbol?: string;
  token_symbol?: string;
}

export interface NormalizedEvmWithdrawal {
  tx_id: string;
  evm_address: string;
  amount_units: number;
  token_symbol: string;
}

/** Normalize a withdrawal from either camelCase or snake_case API response (carries the asset). */
export function normalizeEthWithdrawal(w: EthWithdrawal): NormalizedEvmWithdrawal {
  return {
    tx_id: w.txId || w.tx_id || "",
    evm_address: w.evmAddress || w.evm_address || "",
    amount_units: w.amountUnits || w.amount_units || 0,
    token_symbol: (w.tokenSymbol || w.token_symbol || "").trim(),
  };
}

/** qETH: 1 unit = 1e-6 ETH = 1e12 wei. NEVER applied to qUSDC. */
export function unitsToWei(amountUnits: number | bigint): bigint {
  return BigInt(amountUnits) * 10n ** 12n;
}

/** Owed on-chain amount for a routed EVM asset: qETH → wei (×10^12); qUSDC → base units (1:1). */
export function owedAmount(asset: EvmAsset, amountUnits: number | bigint): bigint {
  return asset === "Eth" ? unitsToWei(amountUnits) : BigInt(amountUnits);
}

// ── ABIs ────────────────────────────────────────────────────────────────────

export const ROUGE_BRIDGE_ABI = parseAbi([
  "function releaseETH(address to, uint256 amount, bytes32 l1TxId) external",
  "function releaseERC20(address token, address to, uint256 amount, bytes32 l1TxId) external",
  "function processedL1Txs(bytes32) external view returns (bool)",
  "function timelockQueue(uint256) external view returns (address token, address to, uint256 amount, bytes32 l1TxId, uint256 executeAfter, bool executed, bool cancelled)",
  "function getTimelockQueueLength() external view returns (uint256)",
  "function owner() external view returns (address)",
  "function paused() external view returns (bool)",
  "function guardian() external view returns (address)",
  "function supportedTokens(address) external view returns (bool)",
  "event BridgeReleaseETH(address indexed recipient, uint256 amount, bytes32 l1TxId)",
  "event BridgeReleaseERC20(address indexed recipient, address indexed token, uint256 amount, bytes32 l1TxId)",
  "event TimelockQueued(uint256 indexed requestId, uint256 executeAfter)",
  "event TimelockExecuted(uint256 indexed requestId)",
  "event TimelockCancelled(uint256 indexed requestId)",
]);

export const BRIDGE_RELEASE_ETH_EVENT = parseAbiItem(
  "event BridgeReleaseETH(address indexed recipient, uint256 amount, bytes32 l1TxId)",
);
export const BRIDGE_RELEASE_ERC20_EVENT = parseAbiItem(
  "event BridgeReleaseERC20(address indexed recipient, address indexed token, uint256 amount, bytes32 l1TxId)",
);
export const TIMELOCK_QUEUED_EVENT = parseAbiItem(
  "event TimelockQueued(uint256 indexed requestId, uint256 executeAfter)",
);
export const TIMELOCK_EXECUTED_EVENT = parseAbiItem("event TimelockExecuted(uint256 indexed requestId)");
export const TIMELOCK_CANCELLED_EVENT = parseAbiItem("event TimelockCancelled(uint256 indexed requestId)");
export const ERC20_TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);
export const ERC20_EVENTS_ABI = [ERC20_TRANSFER_EVENT] as const;

// ── Log decoding ────────────────────────────────────────────────────────────

/** The subset of a receipt/getLogs log entry the core needs. */
export interface RawLog {
  address: string;
  data: Hex;
  topics: readonly Hex[];
  transactionHash?: Hex | null;
  blockNumber?: bigint | null;
}

export type BridgeEvent =
  | { name: "BridgeReleaseETH"; recipient: string; amount: bigint; l1TxId: Hex }
  | { name: "BridgeReleaseERC20"; recipient: string; token: string; amount: bigint; l1TxId: Hex }
  | { name: "TimelockQueued"; requestId: bigint; executeAfter: bigint }
  | { name: "TimelockExecuted"; requestId: bigint }
  | { name: "TimelockCancelled"; requestId: bigint };

export type DecodedBridgeEvent = BridgeEvent & { txHash?: Hex | null; blockNumber?: bigint | null };

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export function sameHex(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** Decode RougeBridge events from logs, keeping ONLY those emitted by `bridgeAddress`. */
export function decodeBridgeEvents(logs: readonly RawLog[], bridgeAddress: string): DecodedBridgeEvent[] {
  const out: DecodedBridgeEvent[] = [];
  for (const lg of logs) {
    if (!sameAddress(lg.address, bridgeAddress)) continue;
    let decoded: { eventName: string; args: any };
    try {
      decoded = decodeEventLog({
        abi: ROUGE_BRIDGE_ABI,
        data: lg.data,
        topics: lg.topics as [Hex, ...Hex[]],
      }) as any;
    } catch {
      continue; // not a RougeBridge event we know (e.g. Ownable/Pausable events)
    }
    const a = decoded.args;
    const meta = { txHash: lg.transactionHash, blockNumber: lg.blockNumber };
    switch (decoded.eventName) {
      case "BridgeReleaseETH":
        out.push({ name: "BridgeReleaseETH", recipient: a.recipient, amount: a.amount, l1TxId: a.l1TxId, ...meta });
        break;
      case "BridgeReleaseERC20":
        out.push({ name: "BridgeReleaseERC20", recipient: a.recipient, token: a.token, amount: a.amount, l1TxId: a.l1TxId, ...meta });
        break;
      case "TimelockQueued":
        out.push({ name: "TimelockQueued", requestId: a.requestId, executeAfter: a.executeAfter, ...meta });
        break;
      case "TimelockExecuted":
        out.push({ name: "TimelockExecuted", requestId: a.requestId, ...meta });
        break;
      case "TimelockCancelled":
        out.push({ name: "TimelockCancelled", requestId: a.requestId, ...meta });
        break;
    }
  }
  return out;
}

export interface Erc20Transfer { from: string; to: string; value: bigint; txHash?: Hex | null }

/** Decode ERC20 Transfer events emitted by `tokenAddress` ONLY. */
export function decodeErc20Transfers(logs: readonly RawLog[], tokenAddress: string): Erc20Transfer[] {
  const out: Erc20Transfer[] = [];
  for (const lg of logs) {
    if (!sameAddress(lg.address, tokenAddress)) continue;
    try {
      const d = decodeEventLog({ abi: ERC20_EVENTS_ABI, data: lg.data, topics: lg.topics as [Hex, ...Hex[]] }) as any;
      if (d.eventName === "Transfer") {
        out.push({ from: d.args.from, to: d.args.to, value: d.args.value, txHash: lg.transactionHash });
      }
    } catch {
      /* not a Transfer */
    }
  }
  return out;
}

// ── Release verification (R1D §6/§7) ────────────────────────────────────────

export interface ExpectedRelease {
  asset: EvmAsset;
  recipient: string;
  /** owed: wei (qETH) or USDC base units (qUSDC) */
  amount: bigint;
  canonicalId: Hex;
  bridgeAddress: string;
  usdcAddress: string;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * qETH: a BridgeReleaseETH emitted BY the configured RougeBridge with recipient == expected,
 *       amount >= owed, l1TxId == canonical.
 * qUSDC: a BridgeReleaseERC20 emitted BY the RougeBridge (recipient, token == USDC, amount >= owed,
 *       l1TxId == canonical) AND a USDC Transfer emitted BY the USDC contract with
 *       from == RougeBridge (NOT the signer), to == recipient, value >= owed.
 * Any log from another emitting contract is ignored (→ rejected).
 */
export function verifyReleaseLogs(logs: readonly RawLog[], exp: ExpectedRelease): VerifyResult {
  const events = decodeBridgeEvents(logs, exp.bridgeAddress);
  if (exp.asset === "Eth") {
    const hit = events.find(
      (e) =>
        e.name === "BridgeReleaseETH" &&
        sameAddress(e.recipient, exp.recipient) &&
        e.amount >= exp.amount &&
        sameHex(e.l1TxId, exp.canonicalId),
    );
    return hit ? { ok: true } : { ok: false, reason: "no matching BridgeReleaseETH from RougeBridge" };
  }
  const rel = events.find(
    (e) =>
      e.name === "BridgeReleaseERC20" &&
      sameAddress(e.recipient, exp.recipient) &&
      sameAddress(e.token, exp.usdcAddress) &&
      e.amount >= exp.amount &&
      sameHex(e.l1TxId, exp.canonicalId),
  );
  if (!rel) return { ok: false, reason: "no matching BridgeReleaseERC20(USDC) from RougeBridge" };
  const xfer = decodeErc20Transfers(logs, exp.usdcAddress).find(
    (t) => sameAddress(t.from, exp.bridgeAddress) && sameAddress(t.to, exp.recipient) && t.value >= exp.amount,
  );
  if (!xfer) return { ok: false, reason: "no matching USDC Transfer(from=RougeBridge,to=recipient) from USDC contract" };
  return { ok: true };
}

// ── Timelock binding (R1E §2) ───────────────────────────────────────────────

export interface TimelockRecord {
  token: string;
  to: string;
  amount: bigint;
  l1TxId: Hex;
  executeAfter: bigint;
  executed: boolean;
  cancelled: boolean;
}

export interface ExpectedTimelock {
  token: string;
  to: string;
  amount: bigint;
  l1TxId: Hex;
  executeAfter: bigint;
}

/** Parse the `timelockQueue(uint256)` public getter tuple. */
export function parseTimelockQueueTuple(t: readonly unknown[]): TimelockRecord {
  if (!Array.isArray(t) || t.length < 7) throw new Error("timelockQueue getter returned an unexpected tuple");
  return {
    token: String(t[0]),
    to: String(t[1]),
    amount: BigInt(t[2] as any),
    l1TxId: String(t[3]) as Hex,
    executeAfter: BigInt(t[4] as any),
    executed: Boolean(t[5]),
    cancelled: Boolean(t[6]),
  };
}

/**
 * True iff the on-chain queue record binds to the expected withdrawal (addresses compared
 * case-insensitively; everything else exact). Does NOT look at executed/cancelled.
 * Mirrors Rust `timelock_record_matches`.
 */
export function timelockRecordMatches(rec: TimelockRecord, exp: ExpectedTimelock): boolean {
  return (
    sameAddress(rec.token, exp.token) &&
    sameAddress(rec.to, exp.to) &&
    rec.amount === exp.amount &&
    sameHex(rec.l1TxId, exp.l1TxId) &&
    rec.executeAfter === exp.executeAfter
  );
}

export function expectedTimelockFor(exp: ExpectedRelease, executeAfter: bigint): ExpectedTimelock {
  return {
    token: exp.asset === "Eth" ? ZERO_ADDRESS : exp.usdcAddress,
    to: exp.recipient,
    amount: exp.amount,
    l1TxId: exp.canonicalId,
    executeAfter,
  };
}

// ── Processed-id classification + refund gate (R1E §4/§6) ───────────────────

export type ProcessedClass = "Paid" | "Queued" | "CancelledRefundCandidate" | "Ambiguous";

export interface OnChainFacts {
  verifiedRelease: boolean;
  queueRecord: TimelockRecord | null | undefined;
  expected: ExpectedTimelock;
}

/** Mirrors Rust `classify_processed` exactly. */
export function classifyProcessed(f: OnChainFacts): ProcessedClass {
  if (f.verifiedRelease) return "Paid";
  const rec = f.queueRecord;
  if (rec && timelockRecordMatches(rec, f.expected)) {
    if (rec.executed) return "Ambiguous"; // executed but no verified release ⇒ can't prove payout
    if (rec.cancelled) return "CancelledRefundCandidate";
    return "Queued";
  }
  return "Ambiguous";
}

export type RefundDecision = "NormalAnalysis" | "Forbidden" | "MayProceedAfterCancellationProof";

/** Mirrors Rust `refund_decision` exactly. An RPC/query FAILURE must never reach this as processed=false. */
export function refundDecision(processed: boolean, cls?: ProcessedClass | null): RefundDecision {
  if (!processed) return "NormalAnalysis";
  if (cls === "CancelledRefundCandidate") return "MayProceedAfterCancellationProof";
  return "Forbidden";
}

// ── Receipt classification after a release tx (R1D §8) ──────────────────────

export type ReleaseReceiptClass =
  | { kind: "Verified" }
  | { kind: "Queued"; requestId: bigint; executeAfter: bigint; record: TimelockRecord }
  | { kind: "Ambiguous"; reason: string; requestId?: bigint };

export async function classifyReleaseReceipt(
  logs: readonly RawLog[],
  exp: ExpectedRelease,
  readTimelockQueue: (requestId: bigint) => Promise<TimelockRecord>,
): Promise<ReleaseReceiptClass> {
  if (verifyReleaseLogs(logs, exp).ok) return { kind: "Verified" };
  const queued = decodeBridgeEvents(logs, exp.bridgeAddress).filter((e) => e.name === "TimelockQueued") as Array<
    Extract<DecodedBridgeEvent, { name: "TimelockQueued" }>
  >;
  if (queued.length === 0) return { kind: "Ambiguous", reason: "receipt has neither a matching BridgeRelease nor TimelockQueued from RougeBridge" };
  if (queued.length > 1) return { kind: "Ambiguous", reason: "receipt has multiple TimelockQueued events" };
  const { requestId, executeAfter } = queued[0];
  let rec: TimelockRecord;
  try {
    rec = await readTimelockQueue(requestId);
  } catch (e: any) {
    return { kind: "Ambiguous", reason: `timelockQueue(${requestId}) read failed: ${e?.message || e}`, requestId };
  }
  const expected = expectedTimelockFor(exp, executeAfter);
  if (!timelockRecordMatches(rec, expected)) {
    return { kind: "Ambiguous", reason: `timelockQueue(${requestId}) does not bind to this withdrawal`, requestId };
  }
  if (rec.executed || rec.cancelled) {
    return { kind: "Ambiguous", reason: `timelockQueue(${requestId}) already executed/cancelled right after queueing`, requestId };
  }
  return { kind: "Queued", requestId, executeAfter, record: rec };
}

// ── Persisted queued state (R1E §3) ─────────────────────────────────────────

export type QueuedStatus = "queued" | "cancelled_refund_candidate" | "ambiguous";

export interface QueuedRecord {
  stored_tx_id: string;
  canonical_l1_tx_id: Hex;
  /** decimal string; "" when unknown (ambiguous entries persisted only to block re-release) */
  request_id: string;
  asset: EvmAsset;
  recipient: string;
  /** decimal string: wei (qETH) or USDC base units (qUSDC) */
  amount: string;
  /** decimal string (unix seconds); "" when unknown */
  execute_after: string;
  release_submission_tx_hash: string;
  status: QueuedStatus;
  note?: string;
  updated_at?: string;
}

/** Keyed by lowercase canonical l1TxId. */
export type QueuedState = Map<string, QueuedRecord>;

export function queuedKey(canonicalId: string): string {
  return canonicalId.toLowerCase();
}

/** Write-to-temp + rename so a crash mid-write never truncates the state file. */
export function atomicWriteFile(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, file);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

export function loadQueuedState(file: string, warn: (m: string) => void = console.warn): QueuedState {
  const state: QueuedState = new Map();
  try {
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf-8"));
      const entries: QueuedRecord[] = Array.isArray(data) ? data : Array.isArray(data?.entries) ? data.entries : [];
      for (const r of entries) {
        if (r && typeof r.canonical_l1_tx_id === "string" && typeof r.stored_tx_id === "string") {
          state.set(queuedKey(r.canonical_l1_tx_id), r);
        }
      }
    }
  } catch (e: any) {
    warn(`[relayer] Could not load queued tx state: ${e.message}`);
  }
  return state;
}

export function saveQueuedState(file: string, state: QueuedState, warn: (m: string) => void = console.warn): void {
  try {
    atomicWriteFile(file, JSON.stringify({ version: 1, entries: [...state.values()] }, null, 2));
  } catch (e: any) {
    warn(`[relayer] Could not persist queued tx state: ${e.message}`);
  }
}

// ── Env toggles ─────────────────────────────────────────────────────────────

/** AUTO_REFUND defaults to false; only the literal "true" enables it. */
export function autoRefundEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.AUTO_REFUND || "").trim().toLowerCase() === "true";
}

// ── Production preflight (R1D §11) ──────────────────────────────────────────

export interface PreflightClient {
  getChainId(): Promise<number>;
  getCode(args: { address: Hex }): Promise<Hex | undefined>;
  readContract(args: { address: Hex; abi: any; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
}

export interface PreflightConfig {
  expectedChainId: number;
  bridgeAddress: string | undefined;
  /** BRIDGE_USDC_ADDRESS if the operator set one (must equal chainUsdc) */
  configuredUsdc: string | undefined;
  /** CHAIN_CONFIG usdc for the selected chain */
  chainUsdc: string;
  vaultAddress: string | undefined;
  /** the relayer account, or ROUGE_BRIDGE_OWNER when a separate owner is configured */
  expectedOwner: string;
}

export class PreflightError extends Error {
  constructor(message: string) {
    super(`[preflight] ${message}`);
    this.name = "PreflightError";
  }
}

function hasCode(code: Hex | undefined | null): boolean {
  return !!code && code !== "0x" && code.length > 2;
}

/**
 * Verifies the on-chain environment before the relayer is allowed to start. ANY failure throws
 * `PreflightError` (caller must refuse to start). There is no env bypass: the only way to skip
 * real RPC checks is to inject a different client (unit tests).
 */
export async function preflight(
  client: PreflightClient,
  cfg: PreflightConfig,
  log: (m: string) => void = console.log,
): Promise<{ paused: boolean; owner: string; chainId: number }> {
  const chainId = await client.getChainId();
  if (chainId !== cfg.expectedChainId) {
    throw new PreflightError(`chain id mismatch: RPC reports ${chainId}, expected ${cfg.expectedChainId}`);
  }
  log(`[preflight] chain id ${chainId} OK`);

  if (!cfg.bridgeAddress || !isEvmAddress(cfg.bridgeAddress)) {
    throw new PreflightError(`ROUGE_BRIDGE_ADDRESS missing or invalid (${cfg.bridgeAddress ?? "unset"})`);
  }
  const bridge = cfg.bridgeAddress as Hex;
  if (!hasCode(await client.getCode({ address: bridge }))) {
    throw new PreflightError(`no contract code at ROUGE_BRIDGE_ADDRESS ${bridge}`);
  }
  log(`[preflight] RougeBridge code present at ${bridge}`);

  const owner = String(await client.readContract({ address: bridge, abi: ROUGE_BRIDGE_ABI, functionName: "owner" }));
  if (!sameAddress(owner, cfg.expectedOwner)) {
    throw new PreflightError(`RougeBridge owner ${owner} != operational signer/owner ${cfg.expectedOwner}`);
  }
  log(`[preflight] RougeBridge owner ${owner} matches operational config`);

  const paused = Boolean(await client.readContract({ address: bridge, abi: ROUGE_BRIDGE_ABI, functionName: "paused" }));
  log(`[preflight] RougeBridge paused=${paused}${paused ? " — releases will revert until unpaused" : ""}`);

  if (!isEvmAddress(cfg.chainUsdc)) throw new PreflightError(`CHAIN_CONFIG usdc is not an address: ${cfg.chainUsdc}`);
  if (cfg.configuredUsdc !== undefined && cfg.configuredUsdc !== "" && !sameAddress(cfg.configuredUsdc, cfg.chainUsdc)) {
    throw new PreflightError(`configured USDC ${cfg.configuredUsdc} != CHAIN_CONFIG usdc ${cfg.chainUsdc}`);
  }
  const usdcSupported = Boolean(
    await client.readContract({ address: bridge, abi: ROUGE_BRIDGE_ABI, functionName: "supportedTokens", args: [cfg.chainUsdc as Hex] }),
  );
  if (!usdcSupported) throw new PreflightError(`RougeBridge.supportedTokens(${cfg.chainUsdc}) == false — qUSDC payouts would revert`);
  log(`[preflight] USDC ${cfg.chainUsdc} supported by RougeBridge`);

  if (cfg.vaultAddress) {
    if (!isEvmAddress(cfg.vaultAddress)) throw new PreflightError(`XRGE_BRIDGE_VAULT is not an address: ${cfg.vaultAddress}`);
    if (!hasCode(await client.getCode({ address: cfg.vaultAddress as Hex }))) {
      throw new PreflightError(`no contract code at XRGE_BRIDGE_VAULT ${cfg.vaultAddress}`);
    }
    log(`[preflight] XRGE vault code present at ${cfg.vaultAddress}`);
  }

  return { paused, owner, chainId };
}

// ── Orchestration (all side effects injected) ───────────────────────────────

export interface ReceiptLike {
  status: "success" | "reverted";
  logs: RawLog[];
  transactionHash?: Hex;
  /** block the tx was mined in — required to prove confirmation depth before daemon fulfill */
  blockNumber?: bigint;
}

export interface EvmChainDeps {
  releaseETH(to: string, wei: bigint, l1TxId: Hex, nonce: number): Promise<Hex>;
  releaseERC20(token: string, to: string, amount: bigint, l1TxId: Hex, nonce: number): Promise<Hex>;
  waitForReceipt(hash: Hex): Promise<ReceiptLike>;
  getReceipt(hash: Hex): Promise<ReceiptLike | null>;
  processedL1Txs(l1TxId: Hex): Promise<boolean>;
  /** current chain head (confirmation-depth gate before daemon fulfill) */
  headBlock(): Promise<bigint>;
  /** `confirmed` → read at (head - confirmations) so a reorg can't fool the cancel/execute path. */
  timelockQueue(requestId: bigint, opts?: { confirmed?: boolean }): Promise<TimelockRecord>;
  /** tx hashes of BridgeReleaseETH/ERC20 logs emitted by the bridge carrying this canonical id. */
  findReleaseTxHashes(exp: ExpectedRelease): Promise<Hex[]>;
  /** recent TimelockQueued requestIds (for reconciliation without a local queue record). */
  findQueuedRequestIds(): Promise<bigint[]>;
  /** the TimelockQueued event for a requestId (executeAfter as emitted), or null. */
  findTimelockQueuedEvent(requestId: bigint): Promise<{ executeAfter: bigint; txHash: Hex | null } | null>;
  /** tx hashes of TimelockExecuted(requestId) logs. */
  findTimelockExecutedTxHashes(requestId: bigint): Promise<Hex[]>;
  /** true iff a TimelockCancelled(requestId) log exists at or below the confirmed head. */
  findTimelockCancelled(requestId: bigint): Promise<boolean>;
  getNonce(): Promise<number>;
  resetNonce(): void;
}

export interface DaemonDeps {
  fulfill(txId: string, evmTxHash: Hex): Promise<boolean>;
  reportFailure(txId: string, error: string): Promise<{ shouldRefund: boolean; attempts: number }>;
  refund(txId: string): Promise<boolean>;
}

export interface EvmPayoutDeps {
  bridgeAddress: string | null;
  usdcAddress: string;
  autoRefund: boolean;
  maxRetries: number;
  processedTxIds: Set<string>;
  markProcessed(txId: string): void;
  queued: QueuedState;
  saveQueued(): void;
  chain: EvmChainDeps;
  daemon: DaemonDeps;
  alert(key: string, message: string): Promise<void> | void;
  log(message: string): void;
  warn(message: string): void;
  sleep(ms: number): Promise<void>;
  /** relayer CONFIRMATIONS; the effective fulfill depth is max(this, daemon QV_BRIDGE_MIN_CONFIRMATIONS). */
  fulfillConfirmations?: number;
  /** BRIDGE_OBSERVE_ONLY: read-only reconciliation + logging; every mutation refuses. */
  observeOnly?: boolean;
}

export type PayoutOutcome =
  | "awaiting_confirmations"
  | "observed"
  | "fulfilled"
  | "queued"
  | "reconciled_paid"
  | "reconciled_queued"
  | "cancelled_refund_candidate"
  | "ambiguous"
  | "skipped_unsupported"
  | "skipped_invalid"
  | "skipped_no_bridge"
  | "skipped_queued"
  | "skipped_rpc"
  | "fulfill_api_failed"
  | "failed"
  | "refunded";

export function expectedReleaseFor(w: NormalizedEvmWithdrawal, asset: EvmAsset, bridgeAddress: string, usdcAddress: string): ExpectedRelease {
  return {
    asset,
    // EIP-55-normalized: viem's ABI encoder rejects a mixed-case address with a bad checksum.
    recipient: getAddress(w.evm_address),
    amount: owedAmount(asset, w.amount_units),
    canonicalId: rougeBridgeId(w.tx_id),
    bridgeAddress,
    usdcAddress,
  };
}

function short(s: string): string {
  return s.length > 18 ? `${s.slice(0, 16)}…` : s;
}

// ─────────────────────────────────────────────────────────────────────────────
// OBSERVATION MODE (BRIDGE_OBSERVE_ONLY=true) — ZERO money-moving or state-mutating side
// effects. Guards live at the LOWEST layer: every write function refuses BEFORE any side
// effect (log `[OBSERVE] WOULD_…` then throw), and the processing paths take a read-only
// branch first so a guard firing is itself a bug signal, never the normal path.
// ─────────────────────────────────────────────────────────────────────────────
export function observeOnlyEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return String(env.BRIDGE_OBSERVE_ONLY ?? "").trim().toLowerCase() === "true";
}
export type ObserveTag =
  | "WOULD_RELEASE" | "WOULD_FULFILL" | "WOULD_REFUND" | "WOULD_CLAIM_DEPOSIT"
  | "WOULD_REPORT_FAILURE" | "WOULD_PERSIST" | "WOULD_SWEEP" | "WOULD_WRITE";
export class ObserveOnlyViolation extends Error {
  constructor(public tag: ObserveTag, detail: string) {
    super(`[OBSERVE] refused ${tag}: ${detail}`);
    this.name = "ObserveOnlyViolation";
  }
}
/** Log the intended action and refuse. Never returns. */
export function observeRefuse(tag: ObserveTag, detail: string, log: (m: string) => void = console.log): never {
  log(`[OBSERVE] ${tag} ${detail}`);
  throw new ObserveOnlyViolation(tag, detail);
}
/**
 * Wrap a write function: in observation mode it logs `[OBSERVE] <tag> …` and throws BEFORE the
 * underlying function is invoked (so an injected spy counts zero calls); otherwise it is `fn`.
 */
export function guardWrite<A extends unknown[], R>(
  observe: boolean, tag: ObserveTag, describe: (...a: A) => string, fn: (...a: A) => R,
  log: (m: string) => void = console.log,
): (...a: A) => R {
  if (!observe) return fn;
  return (...a: A): R => observeRefuse(tag, describe(...a), log);
}
/** Observation-mode view of the payout deps: every mutating member refuses; reads are untouched. */
export function observeGuardedDeps(deps: EvmPayoutDeps): EvmPayoutDeps {
  const log = (m: string) => deps.log(m);
  return {
    ...deps,
    observeOnly: true,
    markProcessed: guardWrite(true, "WOULD_PERSIST", (id: string) => `markProcessed ${id}`, deps.markProcessed, log),
    saveQueued: guardWrite(true, "WOULD_PERSIST", () => `queued-state file`, deps.saveQueued, log),
    chain: {
      ...deps.chain,
      releaseETH: guardWrite(true, "WOULD_RELEASE", (to: string, wei: bigint, id: Hex, _nonce: number) => `releaseETH ${wei} wei → ${to} l1TxId=${id}`, deps.chain.releaseETH, log),
      releaseERC20: guardWrite(true, "WOULD_RELEASE", (token: string, to: string, amt: bigint, id: Hex, _nonce: number) => `releaseERC20 ${amt} of ${token} → ${to} l1TxId=${id}`, deps.chain.releaseERC20, log),
    },
    daemon: {
      fulfill: guardWrite(true, "WOULD_FULFILL", (txId: string, h: Hex) => `${txId} via ${h}`, deps.daemon.fulfill, log),
      reportFailure: guardWrite(true, "WOULD_REPORT_FAILURE", (txId: string, e: string) => `${txId}: ${e}`, deps.daemon.reportFailure, log),
      refund: guardWrite(true, "WOULD_REFUND", (txId: string) => `${txId}`, deps.daemon.refund, log),
    },
  };
}

function persistQueued(
  deps: EvmPayoutDeps,
  w: NormalizedEvmWithdrawal,
  exp: ExpectedRelease,
  fields: { request_id: string; execute_after: string; release_submission_tx_hash: string; status: QueuedStatus; note?: string },
): void {
  if (deps.observeOnly) observeRefuse("WOULD_PERSIST", `persistQueued reached in observation mode`, (m) => deps.log(m));
  deps.queued.set(queuedKey(exp.canonicalId), {
    stored_tx_id: w.tx_id,
    canonical_l1_tx_id: exp.canonicalId,
    asset: exp.asset,
    recipient: exp.recipient,
    amount: exp.amount.toString(),
    updated_at: new Date().toISOString(),
    ...fields,
  });
  deps.saveQueued();
}

export interface ReconcileResult {
  cls: ProcessedClass;
  paidTxHash?: Hex;
  requestId?: bigint;
  record?: TimelockRecord | null;
  executeAfter?: bigint;
  reason?: string;
  /** a log/timelock scan page could not be read — the classification is UNKNOWN (retry later) */
  scanFailed?: boolean;
}

/**
 * On-chain reconciliation for a canonical id with `processedL1Txs == true` (R1D §9 / R1E §4):
 * find + verify a BridgeRelease for the id; locate the bound queue record (local state first,
 * else by scanning TimelockQueued requestIds and reading each getter); classify.
 */
export async function reconcileProcessedId(exp: ExpectedRelease, deps: EvmPayoutDeps): Promise<ReconcileResult> {
  // 1) A verified release event (Paid)?
  let verifiedRelease = false;
  let paidTxHash: Hex | undefined;
  let scanFailed = false;
  try {
    for (const h of await deps.chain.findReleaseTxHashes(exp)) {
      const rcpt = await deps.chain.getReceipt(h);
      if (rcpt && rcpt.status === "success" && verifyReleaseLogs(rcpt.logs, exp).ok) {
        verifiedRelease = true;
        paidTxHash = h;
        break;
      }
    }
  } catch (e: any) {
    scanFailed = true;
    deps.warn(`[EVM] release-log scan failed for ${short(exp.canonicalId)}: ${e?.message || e}`);
  }

  // 2) The bound queue record, if any.
  let requestId: bigint | undefined;
  let executeAfter: bigint | undefined;
  const local = deps.queued.get(queuedKey(exp.canonicalId));
  if (local && local.request_id !== "" && local.execute_after !== "") {
    requestId = BigInt(local.request_id);
    executeAfter = BigInt(local.execute_after);
  } else if (!verifiedRelease) {
    try {
      for (const rid of await deps.chain.findQueuedRequestIds()) {
        const rec = await deps.chain.timelockQueue(rid);
        if (sameHex(rec.l1TxId, exp.canonicalId)) {
          requestId = rid;
          const ev = await deps.chain.findTimelockQueuedEvent(rid);
          executeAfter = ev ? ev.executeAfter : undefined;
          break;
        }
      }
    } catch (e: any) {
      scanFailed = true;
      deps.warn(`[EVM] timelock scan failed for ${short(exp.canonicalId)}: ${e?.message || e}`);
    }
  }

  let record: TimelockRecord | null = null;
  if (requestId !== undefined) {
    try {
      record = await deps.chain.timelockQueue(requestId);
    } catch (e: any) {
      deps.warn(`[EVM] timelockQueue(${requestId}) read failed: ${e?.message || e}`);
      record = null;
    }
  }

  // Without an event-bound executeAfter the binding cannot be proven → the expected value can
  // never equal the record → Ambiguous (fail closed). Use -1n as an impossible sentinel.
  const expected = expectedTimelockFor(exp, executeAfter ?? -1n);
  const cls = classifyProcessed({ verifiedRelease, queueRecord: record, expected });
  // A partial scan must never become "no payout found": unless the payout was positively verified,
  // an unreadable page makes the result UNKNOWN (callers retry later; nothing is persisted).
  return { cls, paidTxHash, requestId, record, executeAfter, scanFailed: scanFailed && cls !== "Paid" };
}

/** ONE effective fulfill depth for qETH/qUSDC: never below the daemon's QV_BRIDGE_MIN_CONFIRMATIONS. */
export function evmFulfillDepth(deps: Pick<EvmPayoutDeps, "fulfillConfirmations">, env: Record<string, string | undefined> = process.env): number {
  return Math.max(deps.fulfillConfirmations ?? 0, daemonMinConfirmations(env));
}
/**
 * Confirmation gate before ANY daemon fulfill (immediate release, reconciled payout, executed
 * timelock). Returns true only when the payout tx is provably at the required depth. Unknown
 * block / unreadable head ⇒ false (retry later) — never a failure, refund or re-release.
 */
async function payoutDeepEnough(w: NormalizedEvmWithdrawal, label: string, hash: Hex, knownBlock: bigint | undefined, deps: EvmPayoutDeps): Promise<boolean> {
  const need = evmFulfillDepth(deps);
  let block = knownBlock;
  try {
    if (block === undefined) block = (await deps.chain.getReceipt(hash))?.blockNumber;
    if (block === undefined) { deps.log(`[${label}] ${w.tx_id}: payout ${hash} block unknown — fulfill deferred (retry later)`); return false; }
    const head = await deps.chain.headBlock();
    const depth = head >= block ? Number(head - block) + 1 : 0;
    if (depth < need) { deps.log(`[${label}] ${w.tx_id}: payout ${hash} has ${depth}/${need} confirmations — fulfill deferred (no release, no failure, no refund)`); return false; }
    return true;
  } catch (e: any) {
    deps.warn(`[${label}] ${w.tx_id}: confirmation-depth read failed for ${hash} (${e?.message || e}) — fulfill deferred`);
    return false;
  }
}

/** Apply a reconciliation result: fulfill / persist queue / alert. Never refunds, never reports failure. */
async function applyReconciliation(
  w: NormalizedEvmWithdrawal,
  exp: ExpectedRelease,
  r: ReconcileResult,
  deps: EvmPayoutDeps,
  ctx: string,
): Promise<PayoutOutcome> {
  if (deps.observeOnly) observeRefuse("WOULD_FULFILL", `applyReconciliation reached in observation mode`, (m) => deps.log(m));
  const label = exp.asset === "Eth" ? "qETH" : "qUSDC";
  if (r.scanFailed) {
    deps.log(`[${label}] ${w.tx_id} (${ctx}): reconciliation scan incomplete — state UNKNOWN, retry next poll (nothing persisted, no release, no failure, no refund)`);
    return "skipped_rpc";
  }
  switch (r.cls) {
    case "Paid": {
      if (!(await payoutDeepEnough(w, label, r.paidTxHash!, undefined, deps))) return "awaiting_confirmations";
      const ok = await deps.daemon.fulfill(w.tx_id, r.paidTxHash!);
      if (ok) {
        deps.log(`[${label}] ✓ Reconciled ${w.tx_id} (${ctx}): already released, fulfilled via ${r.paidTxHash}`);
        deps.markProcessed(w.tx_id);
        deps.queued.delete(queuedKey(exp.canonicalId));
        deps.saveQueued();
        return "reconciled_paid";
      }
      deps.warn(`[${label}] ✗ Reconcile: fulfill API rejected ${w.tx_id} (${r.paidTxHash})`);
      return "fulfill_api_failed";
    }
    case "Queued":
      persistQueued(deps, w, exp, {
        request_id: r.requestId!.toString(),
        execute_after: r.executeAfter!.toString(),
        release_submission_tx_hash: deps.queued.get(queuedKey(exp.canonicalId))?.release_submission_tx_hash || "",
        status: "queued",
      });
      deps.log(`[${label}] ${w.tx_id} is QUEUED in RougeBridge timelock (requestId=${r.requestId}) — waiting, no retry/refund`);
      return "reconciled_queued";
    case "CancelledRefundCandidate":
      persistQueued(deps, w, exp, {
        request_id: r.requestId!.toString(),
        execute_after: r.executeAfter!.toString(),
        release_submission_tx_hash: deps.queued.get(queuedKey(exp.canonicalId))?.release_submission_tx_hash || "",
        status: "cancelled_refund_candidate",
      });
      await deps.alert(
        `cancelled:${w.tx_id}`,
        `${label} ${short(w.tx_id)} timelock requestId=${r.requestId} was CANCELLED on-chain (never executable) — CancelledRefundCandidate, MANUAL disposition required (no auto refund)`,
      );
      return "cancelled_refund_candidate";
    default:
      persistQueued(deps, w, exp, {
        request_id: r.requestId !== undefined ? r.requestId.toString() : "",
        execute_after: r.executeAfter !== undefined ? r.executeAfter.toString() : "",
        release_submission_tx_hash: deps.queued.get(queuedKey(exp.canonicalId))?.release_submission_tx_hash || "",
        status: "ambiguous",
        note: r.reason || ctx,
      });
      await deps.alert(
        `ambiguous:${w.tx_id}`,
        `${label} ${short(w.tx_id)} is processed on RougeBridge but its state is AMBIGUOUS (${r.reason || ctx}) — MANUAL REVIEW, no retry, no refund`,
      );
      return "ambiguous";
  }
}

/**
 * Refund gate (R1E §6): only a POSITIVELY proven `processedL1Txs == false` may proceed to the
 * daemon refund. RPC failure → Forbidden. CancelledRefundCandidate → surfaced, never automatic.
 */
export async function guardedRefund(
  w: NormalizedEvmWithdrawal,
  route: PayoutRoute,
  deps: EvmPayoutDeps,
  attempts: number,
): Promise<boolean> {
  if (deps.observeOnly) observeRefuse("WOULD_REFUND", `guardedRefund reached in observation mode`, (m) => deps.log(m));
  if (route !== "Eth" && route !== "Usdc") {
    deps.warn(`[EVM] refund refused for ${w.tx_id}: route ${route} has no automated refund`);
    return false;
  }
  if (!deps.bridgeAddress) {
    deps.warn(`[EVM] refund refused for ${w.tx_id}: RougeBridge not configured (cannot prove non-payment)`);
    return false;
  }
  const exp = expectedReleaseFor(w, route, deps.bridgeAddress, deps.usdcAddress);
  let processed: boolean;
  try {
    processed = await deps.chain.processedL1Txs(exp.canonicalId);
  } catch (e: any) {
    await deps.alert(`refund-rpc:${w.tx_id}`, `refund check for ${short(w.tx_id)} could not query processedL1Txs (${e?.message || e}) — REFUND FORBIDDEN (fail closed)`);
    return false;
  }
  let cls: ProcessedClass | undefined;
  if (processed) cls = (await reconcileProcessedId(exp, deps)).cls;
  const decision = refundDecision(processed, cls);
  if (decision === "NormalAnalysis") {
    const label = route === "Eth" ? "qETH" : "qUSDC";
    deps.warn(`[${label}] Attempting refund for ${w.tx_id} after ${attempts} failures (processedL1Txs=false)`);
    const refunded = await deps.daemon.refund(w.tx_id);
    if (refunded) {
      await deps.alert(`refund:${w.tx_id}`, `${label} withdrawal ${short(w.tx_id)} was REFUNDED on L1 after ${attempts} failures`);
      deps.markProcessed(w.tx_id);
    }
    return refunded;
  }
  if (decision === "MayProceedAfterCancellationProof") {
    await deps.alert(`refund-candidate:${w.tx_id}`, `withdrawal ${short(w.tx_id)} is a CancelledRefundCandidate — operator disposition required, NOT auto-refunding`);
    return false;
  }
  deps.warn(`[EVM] refund FORBIDDEN for ${w.tx_id}: processedL1Txs=true, class=${cls}`);
  return false;
}

/** Failure path: reconcile first; only a proven-unprocessed id is reported as a failure. */
async function handleEvmFailure(
  w: NormalizedEvmWithdrawal,
  exp: ExpectedRelease,
  error: string,
  deps: EvmPayoutDeps,
): Promise<PayoutOutcome> {
  if (deps.observeOnly) observeRefuse("WOULD_REPORT_FAILURE", `handleEvmFailure reached in observation mode`, (m) => deps.log(m));
  const label = exp.asset === "Eth" ? "qETH" : "qUSDC";
  let processed: boolean;
  try {
    processed = await deps.chain.processedL1Txs(exp.canonicalId);
  } catch (e: any) {
    await deps.alert(
      `rpc:${w.tx_id}`,
      `${label} ${short(w.tx_id)} failed (${error}) and processedL1Txs could not be read (${e?.message || e}) — NOT counting failure, NOT refunding (fail closed)`,
    );
    return "skipped_rpc";
  }
  if (processed) {
    const r = await reconcileProcessedId(exp, deps);
    return applyReconciliation(w, exp, r, deps, `after error: ${error}`);
  }
  const { shouldRefund, attempts } = await deps.daemon.reportFailure(w.tx_id, error);
  if (attempts >= 3) {
    await deps.alert(w.tx_id, `${label} withdrawal ${short(w.tx_id)} has failed ${attempts}× (last: ${error})`);
  }
  if (shouldRefund && deps.autoRefund) {
    const route: PayoutRoute = exp.asset;
    if (await guardedRefund(w, route, deps, attempts)) return "refunded";
  }
  return "failed";
}

/**
 * Process ONE withdrawal from the generic (qETH/qUSDC) feed. Fail-closed at every branch:
 * unsupported asset → skip; no RougeBridge → skip unconditionally (there is no other payout path);
 * already queued/processed on-chain → never release again; receipt → Verified/Queued/Ambiguous.
 */
export async function processEvmWithdrawal(w: NormalizedEvmWithdrawal, deps: EvmPayoutDeps): Promise<PayoutOutcome> {
  const route = payoutRoute(w.token_symbol);
  if (route !== "Eth" && route !== "Usdc") {
    await deps.alert(
      `unsupported:${w.tx_id}`,
      `unsupported bridge asset on the EVM feed: "${w.token_symbol}" (${short(w.tx_id)}) — NOT paying, NOT fulfilling, NOT refunding (left pending)`,
    );
    return "skipped_unsupported";
  }
  if (!Number.isSafeInteger(w.amount_units) || w.amount_units <= 0 || !isEvmAddress(w.evm_address)) {
    await deps.alert(`invalid:${w.tx_id}`, `invalid withdrawal record ${short(w.tx_id)} (amount_units=${w.amount_units}, to=${w.evm_address}) — skipped`);
    return "skipped_invalid";
  }
  const label = route === "Eth" ? "qETH" : "qUSDC";
  const canonicalId = rougeBridgeId(w.tx_id);

  // Never send a queued/ambiguous id through release* again.
  if (deps.queued.has(queuedKey(canonicalId))) return "skipped_queued";

  if (!deps.bridgeAddress) {
    await deps.alert(`no-bridge:${w.tx_id}`, `ROUGE_BRIDGE_ADDRESS missing/invalid — refusing ${label} payout for ${short(w.tx_id)} (fail closed)`);
    return "skipped_no_bridge";
  }

  const exp = expectedReleaseFor(w, route, deps.bridgeAddress, deps.usdcAddress);

  // Pre-release truth check: an id RougeBridge already accepted must never be released again.
  let processedBefore: boolean;
  try {
    processedBefore = await deps.chain.processedL1Txs(canonicalId);
  } catch (e: any) {
    deps.warn(`[${label}] processedL1Txs read failed for ${w.tx_id} (${e?.message || e}) — not releasing this poll`);
    return "skipped_rpc";
  }
  if (deps.observeOnly) {
    // READ-ONLY: classify against on-chain truth and log the intended action. No release, no
    // fulfill, no failure report, no refund, no local state write.
    const human = route === "Eth" ? `${Number(exp.amount) / 1e18} ETH` : `${Number(exp.amount) / 1e6} USDC`;
    if (!processedBefore) {
      deps.log(`[OBSERVE] WOULD_RELEASE ${label} ${human} → ${exp.recipient} l1TxId=${canonicalId} (burn ${w.tx_id})`);
    } else {
      const r = await reconcileProcessedId(exp, deps);
      const intent = r.scanFailed ? `UNKNOWN ${w.tx_id}: reconciliation scan incomplete (would retry next poll)`
        : r.cls === "Paid" ? `WOULD_FULFILL ${w.tx_id} via ${r.paidTxHash}`
        : r.cls === "Queued" ? `WOULD_TRACK_QUEUED ${w.tx_id} requestId=${r.requestId}`
        : r.cls === "CancelledRefundCandidate" ? `WOULD_FLAG_REFUND_CANDIDATE ${w.tx_id} requestId=${r.requestId} (no auto refund)`
        : `WOULD_FLAG_AMBIGUOUS ${w.tx_id}: ${r.reason ?? "unclassifiable"}`;
      deps.log(`[OBSERVE] ${intent} [${label} already processed on RougeBridge: ${r.cls}]`);
    }
    return "observed";
  }
  if (processedBefore) {
    const r = await reconcileProcessedId(exp, deps);
    return applyReconciliation(w, exp, r, deps, "pre-release check");
  }

  // Submit the release (bounded retries; re-check processedL1Txs before every re-send).
  let hash: Hex | undefined;
  let lastErr = "";
  for (let attempt = 1; attempt <= Math.max(1, deps.maxRetries); attempt++) {
    if (attempt > 1) {
      try {
        if (await deps.chain.processedL1Txs(canonicalId)) break; // the earlier attempt landed
      } catch (e: any) {
        lastErr = `processedL1Txs re-check failed: ${e?.message || e}`;
        break; // cannot prove; do not re-send
      }
    }
    try {
      const nonce = await deps.chain.getNonce();
      hash =
        route === "Eth"
          ? await deps.chain.releaseETH(exp.recipient, exp.amount, canonicalId, nonce)
          : await deps.chain.releaseERC20(deps.usdcAddress, exp.recipient, exp.amount, canonicalId, nonce);
      break;
    } catch (e: any) {
      lastErr = e?.message || String(e);
      deps.chain.resetNonce();
      deps.warn(`[${label}] release attempt ${attempt}/${deps.maxRetries} failed for ${w.tx_id}: ${lastErr}`);
      if (attempt < deps.maxRetries) await deps.sleep(1000 * Math.pow(2, attempt - 1));
    }
  }
  if (!hash) return handleEvmFailure(w, exp, lastErr || "release submission failed", deps);

  deps.log(
    `[${label}] Submitted ${route === "Eth" ? `${Number(exp.amount) / 1e18} ETH` : `${Number(exp.amount) / 1e6} USDC`} → ${w.evm_address.slice(0, 10)}… tx: ${hash}`,
  );

  let receipt: ReceiptLike;
  try {
    receipt = await deps.chain.waitForReceipt(hash);
  } catch (e: any) {
    deps.chain.resetNonce();
    return handleEvmFailure(w, exp, `receipt wait failed for ${hash}: ${e?.message || e}`, deps);
  }
  if (receipt.status !== "success") {
    deps.chain.resetNonce();
    return handleEvmFailure(w, exp, `release tx reverted: ${hash}`, deps);
  }

  const cls = await classifyReleaseReceipt(receipt.logs, exp, (rid) => deps.chain.timelockQueue(rid));
  if (cls.kind === "Verified") {
    // Paid and verified. Fulfill only at the daemon-required depth; otherwise the next poll's
    // processedL1Txs pre-check reconciles it (never released again).
    if (!(await payoutDeepEnough(w, label, hash, receipt.blockNumber, deps))) return "awaiting_confirmations";
    const ok = await deps.daemon.fulfill(w.tx_id, hash);
    if (ok) {
      deps.log(`[${label}] ✓ Fulfilled ${w.tx_id} (${hash})`);
      deps.markProcessed(w.tx_id);
      return "fulfilled";
    }
    deps.warn(`[${label}] ✗ Fulfill API failed: ${w.tx_id} (${hash})`);
    return "fulfill_api_failed";
  }
  if (cls.kind === "Queued") {
    persistQueued(deps, w, exp, {
      request_id: cls.requestId.toString(),
      execute_after: cls.executeAfter.toString(),
      release_submission_tx_hash: hash,
      status: "queued",
    });
    deps.log(`[${label}] ${w.tx_id} QUEUED in RougeBridge timelock (requestId=${cls.requestId}, executeAfter=${cls.executeAfter}) via ${hash} — waiting`);
    return "queued";
  }
  persistQueued(deps, w, exp, {
    request_id: cls.requestId !== undefined ? cls.requestId.toString() : "",
    execute_after: "",
    release_submission_tx_hash: hash,
    status: "ambiguous",
    note: cls.reason,
  });
  await deps.alert(`ambiguous:${w.tx_id}`, `${label} ${short(w.tx_id)} release ${hash} succeeded but is AMBIGUOUS: ${cls.reason} — MANUAL REVIEW, no retry, no refund`);
  return "ambiguous";
}

/**
 * Poll every persisted queued entry (R1E §3/§5): re-read `timelockQueue(requestId)` at the
 * confirmed head; executed → verify the execution tx's BridgeRelease and fulfill with THAT hash;
 * cancelled → CancelledRefundCandidate (alert, no auto refund); else keep waiting. Also observes
 * TimelockCancelled(requestId) events and applies the same getter re-validation.
 */
export async function pollQueuedWithdrawals(deps: EvmPayoutDeps): Promise<void> {
  if (!deps.bridgeAddress) return;
  for (const rec of [...deps.queued.values()]) {
    if (rec.status !== "queued") continue;
    if (rec.request_id === "" || rec.execute_after === "") continue;
    const w: NormalizedEvmWithdrawal = { tx_id: rec.stored_tx_id, evm_address: rec.recipient, amount_units: 0, token_symbol: rec.asset === "Eth" ? "qETH" : "qUSDC" };
    const exp: ExpectedRelease = {
      asset: rec.asset,
      recipient: rec.recipient,
      amount: BigInt(rec.amount),
      canonicalId: rec.canonical_l1_tx_id,
      bridgeAddress: deps.bridgeAddress,
      usdcAddress: deps.usdcAddress,
    };
    const label = rec.asset === "Eth" ? "qETH" : "qUSDC";
    const requestId = BigInt(rec.request_id);
    const expected = expectedTimelockFor(exp, BigInt(rec.execute_after));

    let onchain: TimelockRecord;
    try {
      onchain = await deps.chain.timelockQueue(requestId, { confirmed: true });
    } catch (e: any) {
      deps.warn(`[${label}] queued ${rec.stored_tx_id}: timelockQueue(${requestId}) read failed: ${e?.message || e}`);
      continue;
    }
    if (deps.observeOnly) {
      const state = !timelockRecordMatches(onchain, expected) ? "BINDING_MISMATCH (would flag ambiguous)"
        : onchain.executed ? "EXECUTED (WOULD_FULFILL after verifying the execution release)"
        : onchain.cancelled ? "CANCELLED (would flag refund candidate; no auto refund)"
        : "ACTIVE (waiting)";
      deps.log(`[OBSERVE] queued ${label} ${rec.stored_tx_id} requestId=${requestId}: ${state}`);
      continue;
    }
    if (!timelockRecordMatches(onchain, expected)) {
      rec.status = "ambiguous";
      rec.note = `timelockQueue(${requestId}) no longer binds to this withdrawal`;
      rec.updated_at = new Date().toISOString();
      deps.saveQueued();
      await deps.alert(`ambiguous:${rec.stored_tx_id}`, `${label} ${short(rec.stored_tx_id)} queued requestId=${requestId} no longer matches its stored binding — AMBIGUOUS, manual review`);
      continue;
    }

    if (onchain.executed) {
      let paid: Hex | undefined;
      try {
        for (const h of await deps.chain.findTimelockExecutedTxHashes(requestId)) {
          const rcpt = await deps.chain.getReceipt(h);
          if (rcpt && rcpt.status === "success" && verifyReleaseLogs(rcpt.logs, exp).ok) { paid = h; break; }
        }
        if (!paid) {
          for (const h of await deps.chain.findReleaseTxHashes(exp)) {
            const rcpt = await deps.chain.getReceipt(h);
            if (rcpt && rcpt.status === "success" && verifyReleaseLogs(rcpt.logs, exp).ok) { paid = h; break; }
          }
        }
      } catch (e: any) {
        deps.warn(`[${label}] queued ${rec.stored_tx_id}: execution scan failed: ${e?.message || e}`);
        continue;
      }
      const r: ReconcileResult = paid
        ? { cls: "Paid", paidTxHash: paid, requestId, record: onchain, executeAfter: expected.executeAfter }
        : { cls: "Ambiguous", requestId, record: onchain, executeAfter: expected.executeAfter, reason: "timelock executed but no verifiable BridgeRelease found" };
      await applyReconciliation(w, exp, r, deps, "timelock executed");
      continue;
    }

    let cancelledEvent = false;
    try {
      cancelledEvent = await deps.chain.findTimelockCancelled(requestId);
    } catch (e: any) {
      deps.warn(`[${label}] queued ${rec.stored_tx_id}: TimelockCancelled scan failed: ${e?.message || e}`);
    }
    if (onchain.cancelled || cancelledEvent) {
      // R1E §5: (re-)read at the confirmed head and require cancelled && !executed + full binding.
      let confirmed: TimelockRecord;
      try {
        confirmed = await deps.chain.timelockQueue(requestId, { confirmed: true });
      } catch (e: any) {
        deps.warn(`[${label}] queued ${rec.stored_tx_id}: confirmation re-read failed: ${e?.message || e}`);
        continue;
      }
      if (confirmed.cancelled && !confirmed.executed && timelockRecordMatches(confirmed, expected)) {
        await applyReconciliation(w, exp, { cls: "CancelledRefundCandidate", requestId, record: confirmed, executeAfter: expected.executeAfter }, deps, "TimelockCancelled");
      } else if (cancelledEvent && !confirmed.cancelled) {
        deps.log(`[${label}] queued ${rec.stored_tx_id}: TimelockCancelled observed but not yet confirmed — waiting`);
      } else {
        await applyReconciliation(w, exp, { cls: "Ambiguous", requestId, record: confirmed, executeAfter: expected.executeAfter, reason: "cancellation state inconsistent" }, deps, "TimelockCancelled");
      }
      continue;
    }
    // active queue: wait — no retry, no failure counter, no refund
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Daemon derived-state health gate (R1 bridge-store hardening).
// GET /api/bridge/health → { degraded, failed_tx_ids, pending }. The daemon answers 503 while
// any payout record for an ACCEPTED block is missing. The relayer must not act on ANY list
// (EVM / XRGE / BTC) while degraded — a partial list could mis-order or miss payouts.
// ─────────────────────────────────────────────────────────────────────────────
export interface BridgeHealthResponse { status: number; body: unknown }
export function bridgeHealthAllowsPayouts(h: BridgeHealthResponse | null | undefined): boolean {
  if (!h) return false;                       // unreachable/unknown health → fail closed
  if (h.status !== 200) return false;         // 503 (degraded) or anything unexpected → fail closed
  const b = (h.body ?? {}) as { degraded?: unknown };
  return b.degraded === false;                // only an explicit healthy answer permits payouts
}

// ── Observation-mode helpers for the XRGE vault and the deposit watcher (read-only) ──
export interface XrgeObserveDeps {
  processedOnVault(txId: string): Promise<boolean>;
  findReleaseTx(txId: string): Promise<string | null>;
  log(m: string): void;
}
export type XrgeObserveOutcome = "would_release" | "would_fulfill" | "processed_no_release_found" | "read_failed";
/** READ-ONLY inspection of one pending XRGE withdrawal. Never releases, fulfills, fails or refunds. */
export async function observeXrgeWithdrawal(
  w: { tx_id: string; evm_address: string; amount: number }, deps: XrgeObserveDeps,
): Promise<XrgeObserveOutcome> {
  let processed: boolean;
  try { processed = await deps.processedOnVault(w.tx_id); }
  catch (e: any) { deps.log(`[OBSERVE] XRGE ${w.tx_id}: processedL1Txs read failed (${e?.message || e}) — no action`); return "read_failed"; }
  if (!processed) { deps.log(`[OBSERVE] WOULD_RELEASE XRGE ${w.amount} → ${w.evm_address} l1TxId=${w.tx_id}`); return "would_release"; }
  const rel = await deps.findReleaseTx(w.tx_id);
  if (rel) { deps.log(`[OBSERVE] WOULD_FULFILL XRGE ${w.tx_id} via ${rel} (already released on-chain)`); return "would_fulfill"; }
  deps.log(`[OBSERVE] XRGE ${w.tx_id} processed on-chain but no BridgeRelease found in scan — would alert for MANUAL REVIEW`);
  return "processed_no_release_found";
}
/** READ-ONLY handling of a discovered deposit: log the intended claim, mint nothing. */
export function observeDeposit(d: { token: string; txHash: string; pubkey: string }, log: (m: string) => void): void {
  log(`[OBSERVE] WOULD_CLAIM_DEPOSIT ${d.token} ${d.txHash} → ${d.pubkey.slice(0, 16)}…`);
}

// ─────────────────────────────────────────────────────────────────────────────
// XRGE (BridgeVaultV2) payout lifecycle — fix for the block-53 controlled test.
//   1. processedL1Txs(tx_id) is read BEFORE any release(); a read failure fails closed.
//   2. processed == true ⇒ NEVER release: locate + verify the existing BridgeRelease and fulfill
//      the daemon record with THAT payout tx hash.
//   3. fulfill is only called once the payout has the daemon-required confirmation depth; a
//      daemon "needs N confirmations" answer is retry-later bookkeeping — never a payout failure,
//      never a failure report, never a refund, never another release.
//   4. BridgeRelease log scans are paginated in contiguous, non-overlapping ranges ≤ 2,000 blocks.
// ─────────────────────────────────────────────────────────────────────────────
export const MAX_LOG_SCAN_SPAN = 2000n;

/** Daemon-required confirmation depth (same env name the daemon reads; daemon default 6). */
export function daemonMinConfirmations(env: Record<string, string | undefined> = process.env): number {
  const n = parseInt(String(env.QV_BRIDGE_MIN_CONFIRMATIONS ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 6;
}
/** ONE effective depth for XRGE fulfill: never below the daemon requirement. */
export function xrgeFulfillConfirmations(relayerConfirmations: number, env: Record<string, string | undefined> = process.env): number {
  return Math.max(Number.isFinite(relayerConfirmations) ? relayerConfirmations : 0, daemonMinConfirmations(env));
}

/** Contiguous, non-overlapping block ranges covering [from, to], newest first, each ≤ maxSpan. */
export function blockRangesDescending(from: bigint, to: bigint, maxSpan: bigint = MAX_LOG_SCAN_SPAN): Array<{ fromBlock: bigint; toBlock: bigint }> {
  if (maxSpan <= 0n || maxSpan > MAX_LOG_SCAN_SPAN) throw new Error(`maxSpan must be 1..${MAX_LOG_SCAN_SPAN}`);
  const out: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  if (to < from) return out;
  let hi = to;
  while (hi >= from) {
    const lo = hi - maxSpan + 1n > from ? hi - maxSpan + 1n : from;
    out.push({ fromBlock: lo, toBlock: hi });
    if (lo === 0n || lo === from) break;
    hi = lo - 1n;
  }
  return out;
}

export interface VaultReleaseLog { txHash: string; blockNumber: bigint; recipient: string; amount: bigint; l1TxId: string }
export type VaultLogFetcher = (range: { fromBlock: bigint; toBlock: bigint }) => Promise<VaultReleaseLog[]>;

/**
 * Find EVERY BridgeRelease carrying `l1TxId` in [head - lookback, head], paging ≤ 2,000 blocks.
 * Scans the whole window (no early exit) so a duplicate release can never hide behind the first hit.
 * Throws if any page fails — the caller must treat that as "unknown", never as "not released".
 */
export interface ScanPacing { pauseMs?: number; retries?: number; backoffMs?: number; sleep?: (ms: number) => Promise<void> }
/**
 * Generic RPC-safe log pagination used by EVERY reconciliation scan (XRGE vault, RougeBridge
 * releases, timelock queued/executed/cancelled): contiguous, non-overlapping pages ≤ 2,000 blocks,
 * newest first, paced, with bounded in-place retry. A page is never skipped; if one still cannot
 * be read the whole scan THROWS — callers must treat that as UNKNOWN, never as "nothing found".
 */
export async function scanLogPagesDescending<T>(
  fetchPage: (range: { fromBlock: bigint; toBlock: bigint }) => Promise<T[]>,
  from: bigint, to: bigint, maxSpan: bigint = MAX_LOG_SCAN_SPAN, pacing: ScanPacing = {},
): Promise<T[]> {
  const sleep = pacing.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = pacing.retries ?? 0, backoff = pacing.backoffMs ?? 1500, pause = pacing.pauseMs ?? 0;
  const out: T[] = [];
  for (const r of blockRangesDescending(from, to, maxSpan)) {
    let page: T[] | undefined;
    for (let attempt = 0; ; attempt++) {
      try { page = await fetchPage(r); break; }
      catch (e) { if (attempt >= retries) throw e; await sleep(backoff * (attempt + 1)); }
    }
    out.push(...page!);
    if (pause > 0) await sleep(pause);
  }
  return out;
}
export async function findVaultReleases(fetchLogs: VaultLogFetcher, l1TxId: string, head: bigint, lookbackBlocks: bigint, maxSpan: bigint = MAX_LOG_SCAN_SPAN, pacing: ScanPacing = {}): Promise<VaultReleaseLog[]> {
  const from = head > lookbackBlocks ? head - lookbackBlocks : 0n;
  return (await scanLogPagesDescending(fetchLogs, from, head, maxSpan, pacing)).filter((lg) => lg.l1TxId === l1TxId);
}

export interface XrgeFulfillResult { ok: boolean; status: number; error?: string }
/** A daemon rejection that only means "not deep enough yet" (retry later). */
export function isAwaitingConfirmationsError(r: XrgeFulfillResult): boolean {
  return !r.ok && /confirmation/i.test(r.error ?? "");
}

export interface XrgeWithdrawal { tx_id: string; evm_address: string; amount: number }
export interface XrgePayoutDeps {
  requiredConfirmations: number;
  processedOnVault(txId: string): Promise<boolean>;
  release(to: string, wei: bigint, txId: string): Promise<string>;
  /** resolves once the tx is mined (any depth ≥ 1); depth is enforced separately below */
  waitForReceipt(hash: string): Promise<{ status: "success" | "reverted"; blockNumber: bigint }>;
  headBlock(): Promise<bigint>;
  /** every BridgeRelease for this l1TxId within the configured lookback (≤2,000-block pages) */
  findReleases(txId: string): Promise<VaultReleaseLog[]>;
  fulfill(txId: string, payoutTxHash: string): Promise<XrgeFulfillResult>;
  /** real payout failure only (release never happened) */
  handleFailure(txId: string, error: string): Promise<void>;
  markProcessed(txId: string): void;
  /** payouts known to be mined but not yet fulfilled (tx_id → payout) — in-memory retry state */
  pendingFulfill: Map<string, { txHash: string; blockNumber: bigint }>;
  alert(key: string, message: string): Promise<void> | void;
  log(m: string): void;
  warn(m: string): void;
}
export type XrgeOutcome =
  | "fulfilled" | "reconciled_fulfilled" | "awaiting_confirmations" | "fulfill_rejected"
  | "skipped_rpc" | "processed_no_release_found" | "ambiguous" | "failed";

export function xrgeToWeiExact(amount: number): bigint { return BigInt(amount) * 10n ** 18n; }

/** Fulfill a payout that is known to exist on-chain, honouring the confirmation depth. */
async function fulfillKnownXrgePayout(w: XrgeWithdrawal, payout: { txHash: string; blockNumber: bigint }, deps: XrgePayoutDeps, reconciled: boolean): Promise<XrgeOutcome> {
  let head: bigint;
  try { head = await deps.headBlock(); }
  catch (e: any) { deps.pendingFulfill.set(w.tx_id, payout); deps.warn(`[XRGE] ${w.tx_id}: head read failed (${e?.message || e}) — fulfill deferred`); return "awaiting_confirmations"; }
  const depth = head >= payout.blockNumber ? Number(head - payout.blockNumber) + 1 : 0;
  if (depth < deps.requiredConfirmations) {
    deps.pendingFulfill.set(w.tx_id, payout);
    deps.log(`[XRGE] ${w.tx_id}: payout ${payout.txHash} has ${depth}/${deps.requiredConfirmations} confirmations — fulfill deferred (no release, no failure)`);
    return "awaiting_confirmations";
  }
  const r = await deps.fulfill(w.tx_id, payout.txHash);
  if (r.ok) {
    deps.pendingFulfill.delete(w.tx_id);
    deps.markProcessed(w.tx_id);
    deps.log(`[XRGE] ✓ ${reconciled ? "Reconciled + fulfilled" : "Fulfilled"} ${w.tx_id} (${payout.txHash})`);
    return reconciled ? "reconciled_fulfilled" : "fulfilled";
  }
  deps.pendingFulfill.set(w.tx_id, payout);
  if (isAwaitingConfirmationsError(r)) {
    deps.log(`[XRGE] ${w.tx_id}: daemon wants more confirmations (HTTP ${r.status}: ${r.error}) — retry later (no release, no failure)`);
    return "awaiting_confirmations";
  }
  deps.warn(`[XRGE] ✗ daemon REJECTED fulfill for ${w.tx_id} via ${payout.txHash}: HTTP ${r.status} ${r.error ?? "(no error body)"} — payout exists on-chain; NOT releasing, NOT failing, NOT refunding`);
  await deps.alert(`xrge-fulfill:${w.tx_id}`, `XRGE ${w.tx_id.slice(0, 20)}… is PAID on Base (${payout.txHash}) but the daemon rejected fulfill: HTTP ${r.status} ${r.error ?? ""} — manual review`);
  return "fulfill_rejected";
}

export async function processXrgeWithdrawal(w: XrgeWithdrawal, deps: XrgePayoutDeps): Promise<XrgeOutcome> {
  // 1. on-chain truth FIRST — a read failure fails closed (no release).
  let processed: boolean;
  try { processed = await deps.processedOnVault(w.tx_id); }
  catch (e: any) { deps.warn(`[XRGE] processedL1Txs read failed for ${w.tx_id} (${e?.message || e}) — NOT releasing this poll`); return "skipped_rpc"; }

  if (processed) {
    // 2. already paid ⇒ never release; reconcile against the real payout.
    let payout = deps.pendingFulfill.get(w.tx_id);
    if (!payout) {
      let hits: VaultReleaseLog[];
      try { hits = await deps.findReleases(w.tx_id); }
      catch (e: any) { deps.warn(`[XRGE] ${w.tx_id} is processed on-chain; release-log scan failed (${e?.message || e}) — retry next poll (no release, no failure)`); return "skipped_rpc"; }
      if (hits.length === 0) {
        await deps.alert(`reconcile:${w.tx_id}`, `XRGE ${w.tx_id.slice(0, 20)}… is processed on-chain but no BridgeRelease was found in the scan window — MANUAL REVIEW, NOT releasing, NOT refunding`);
        return "processed_no_release_found";
      }
      const want = xrgeToWeiExact(w.amount);
      const good = hits.filter((h) => sameAddress(h.recipient, w.evm_address) && h.amount === want);
      if (hits.length !== 1 || good.length !== 1) {
        await deps.alert(`ambiguous:${w.tx_id}`, `XRGE ${w.tx_id.slice(0, 20)}… has ${hits.length} BridgeRelease event(s), ${good.length} matching recipient+amount — AMBIGUOUS, manual review (no fulfill, no release, no refund)`);
        return "ambiguous";
      }
      payout = { txHash: good[0].txHash, blockNumber: good[0].blockNumber };
      deps.log(`[XRGE] ${w.tx_id} already released on-chain via ${payout.txHash} (block ${payout.blockNumber}) — reconciling, NOT releasing`);
    }
    return fulfillKnownXrgePayout(w, payout, deps, true);
  }

  // 3. normal release path (processed == false).
  let hash: string;
  try { hash = await deps.release(w.evm_address, xrgeToWeiExact(w.amount), w.tx_id); }
  catch (e: any) {
    // The send may still have landed: consult the chain before calling it a failure.
    let landed: boolean;
    try { landed = await deps.processedOnVault(w.tx_id); }
    catch { deps.warn(`[XRGE] release errored for ${w.tx_id} and the processed re-check failed — no failure report this poll`); return "skipped_rpc"; }
    if (landed) { deps.log(`[XRGE] release call errored for ${w.tx_id} but the id is processed on-chain — reconciling next poll`); return "awaiting_confirmations"; }
    await deps.handleFailure(w.tx_id, e?.message || "release failed");
    return "failed";
  }
  deps.log(`[XRGE] Released ${w.amount} XRGE → ${w.evm_address.slice(0, 10)}... tx: ${hash}`);
  let rc: { status: "success" | "reverted"; blockNumber: bigint };
  try { rc = await deps.waitForReceipt(hash); }
  catch (e: any) { deps.warn(`[XRGE] receipt wait failed for ${w.tx_id} (${hash}): ${e?.message || e} — will reconcile from chain state next poll`); return "awaiting_confirmations"; }
  if (rc.status !== "success") {
    let landed = false;
    try { landed = await deps.processedOnVault(w.tx_id); } catch { return "skipped_rpc"; }
    if (landed) return "awaiting_confirmations"; // an earlier send settled it; reconcile next poll
    await deps.handleFailure(w.tx_id, `release tx reverted: ${hash}`);
    return "failed";
  }
  return fulfillKnownXrgePayout(w, { txHash: hash, blockNumber: rc.blockNumber }, deps, false);
}

// ── Deposit watcher confirmation alignment ──
/**
 * Newest block the deposit watcher may scan / auto-claim: head − max(CONFIRMATIONS, daemon
 * QV_BRIDGE_MIN_CONFIRMATIONS [default 6]). The daemon refuses to credit a shallower deposit, so
 * the watcher must not intentionally hand it one. Returns null when nothing is deep enough yet.
 * (An unreadable head never reaches here — the caller's RPC error aborts the poll: fail closed.)
 */
export function depositWatcherSafeHead(head: bigint, relayerConfirmations: number, env: Record<string, string | undefined> = process.env): bigint | null {
  const depth = BigInt(Math.max(Number.isFinite(relayerConfirmations) ? relayerConfirmations : 0, daemonMinConfirmations(env)));
  const safe = head - depth;
  return safe > 0n ? safe : null;
}
