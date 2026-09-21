#!/usr/bin/env npx tsx
/**
 * RougeChain Bridge Relayer v2 — Production-Hardened (R1B/R1D/R1E)
 *
 * Features:
 *   ✓ Multi-chain support (Base Mainnet + Sepolia)
 *   ✓ Nonce management (manual tracking, no stuck txs)
 *   ✓ Explicit asset routing: qETH → RougeBridge.releaseETH, qUSDC → RougeBridge.releaseERC20,
 *     anything else → NO payout (no default ETH route)
 *   ✓ RougeBridge REQUIRED: qETH/qUSDC payouts go ONLY through RougeBridge.releaseETH/releaseERC20.
 *     There is no direct wallet send path and no env toggle for one; a missing/invalid
 *     ROUGE_BRIDGE_ADDRESS fails preflight and the relayer refuses to start.
 *   ✓ Receipt verification against BridgeReleaseETH/ERC20 (+ USDC Transfer) events
 *   ✓ Timelock lifecycle: queued withdrawals persisted, never re-released, fulfilled from the
 *     executeTimelock tx; cancellations surfaced as CancelledRefundCandidate (no auto refund)
 *   ✓ processedL1Txs reconciliation before any failure/refund; refunds fail closed
 *   ✓ Production preflight (chain id, code, owner, paused, USDC support) — refuses to start
 *   ✓ Double-spend protection (processed tx set), graceful shutdown, health logging
 *
 * Env:
 *   CORE_API_URL                 - RougeChain API (e.g. https://testnet.rougechain.io)
 *   BRIDGE_CUSTODY_PRIVATE_KEY   - Private key (0x-prefixed hex) — RougeBridge owner / signer
 *   BASE_RPC_URL                 - RPC URL (auto-set if BASE_CHAIN is specified)
 *   BASE_CHAIN                   - "mainnet" or "sepolia" (default: sepolia)
 *   ROUGE_BRIDGE_ADDRESS         - RougeBridge contract (REQUIRED — startup refuses without a valid one)
 *   ROUGE_BRIDGE_OWNER           - Optional: expected RougeBridge owner if not the relayer key
 *   BRIDGE_USDC_ADDRESS          - Optional: must equal the built-in per-chain Base USDC address
 *   XRGE_BRIDGE_VAULT            - BridgeVault contract address
 *   BRIDGE_RELAYER_SECRET        - Secret for fulfillment auth
 *   POLL_INTERVAL_MS             - Poll interval (default: 5000)
 *   CONFIRMATIONS                - Blocks to wait for tx confirmation (default: 2)
 *   MAX_RETRIES                  - Max release submission attempts per poll (default: 3)
 *   AUTO_REFUND                  - Default FALSE. Even when true, refunds obey the fail-closed gate.
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  parseAbiItem,
  getContract,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
  bridgeHealthAllowsPayouts,
  observeOnlyEnabled,
  observeRefuse,
  observeGuardedDeps,
  observeXrgeWithdrawal,
  observeDeposit,
  processXrgeWithdrawal,
  findVaultReleases,
  scanLogPagesDescending,
  evmFulfillDepth,
  depositWatcherSafeHead,
  xrgeFulfillConfirmations,
  type XrgeFulfillResult,
  type VaultReleaseLog,
  ROUGE_BRIDGE_ABI,
  BRIDGE_RELEASE_ETH_EVENT,
  BRIDGE_RELEASE_ERC20_EVENT,
  TIMELOCK_QUEUED_EVENT,
  TIMELOCK_EXECUTED_EVENT,
  TIMELOCK_CANCELLED_EVENT,
  normalizeEthWithdrawal,
  parseTimelockQueueTuple,
  loadQueuedState,
  saveQueuedState,
  atomicWriteFile,
  autoRefundEnabled,
  preflight,
  processEvmWithdrawal,
  pollQueuedWithdrawals,
  sameHex,
  isEvmAddress,
  type EthWithdrawal,
  type EvmPayoutDeps,
  type ExpectedRelease,
  type RawLog,
  type ReceiptLike,
  type TimelockRecord,
} from "./bridge-relayer-core";

// ── Config ──────────────────────────────────────────────────────

const CORE_API_URL = process.env.CORE_API_URL || "http://localhost:5101";
const PRIVATE_KEY = process.env.BRIDGE_CUSTODY_PRIVATE_KEY;
// Optional dedicated hot key for XRGE vault release() (BridgeVaultV2's `relayer` role).
// When set, XRGE releases are signed by THIS key while the custody key above stays for
// ETH/RougeBridge — the on-chain role split. Falls back to the custody key when unset.
const XRGE_RELAYER_KEY = process.env.XRGE_RELAYER_PRIVATE_KEY;
const BASE_CHAIN = (process.env.BASE_CHAIN || "sepolia").toLowerCase();
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS || "5000", 10);
const VAULT_ADDRESS = process.env.XRGE_BRIDGE_VAULT;
const RELAYER_SECRET = process.env.BRIDGE_RELAYER_SECRET || "";
const CONFIRMATIONS = parseInt(process.env.CONFIRMATIONS || "2", 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || "3", 10);
// XRGE fulfill depth = max(CONFIRMATIONS, daemon QV_BRIDGE_MIN_CONFIRMATIONS [default 6]) — ONE value,
// never below what the daemon's fulfill endpoint demands.
const XRGE_FULFILL_CONFIRMATIONS = xrgeFulfillConfirmations(CONFIRMATIONS);
// How far back the XRGE BridgeRelease reconciliation scan looks (paged ≤ 2,000 blocks).
const XRGE_RELEASE_SCAN_BLOCKS = BigInt(process.env.XRGE_RELEASE_SCAN_BLOCKS || "100000");
// Lookback for RougeBridge release/timelock reconciliation scans (paged ≤ 2,000 blocks, paced, retried).
const BRIDGE_LOG_SCAN_BLOCKS = BigInt(process.env.BRIDGE_LOG_SCAN_BLOCKS || "60000");
const LOG_SCAN_PACING = { pauseMs: 200, retries: 5, backoffMs: 2000 };
// Optional webhook (e.g. Slack/Discord incoming webhook) for failure alerts.
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || "";
// Auto-refund a withdrawal once the daemon reports it has crossed the failure threshold.
// DEFAULT FALSE (R1D §10). Even when enabled, qETH/qUSDC refunds go through the fail-closed
// processedL1Txs gate (refundDecision) and XRGE through the BridgeVault processed guard.
const AUTO_REFUND = autoRefundEnabled();
// OBSERVATION MODE (default FALSE): read-only preflight/health/reconciliation/deposit scan + logging.
// Every write path below refuses BEFORE any side effect when this is true.
const OBSERVE_ONLY = observeOnlyEnabled();
// Optional expected RougeBridge owner (defaults to the relayer/custody account).
const ROUGE_BRIDGE_OWNER = process.env.ROUGE_BRIDGE_OWNER;
// Optional operator-supplied USDC address — must equal CHAIN_CONFIG.usdc (preflight).
const BRIDGE_USDC_ADDRESS = process.env.BRIDGE_USDC_ADDRESS;
// Watch Base for deposit events and auto-claim them on L1 (no browser claim needed).
const DEPOSIT_WATCHER = (process.env.DEPOSIT_WATCHER || "true").toLowerCase() !== "false";
// Optional starting block for the deposit scan (defaults to current block on first run).
const DEPOSIT_WATCH_FROM_BLOCK = process.env.DEPOSIT_WATCH_FROM_BLOCK
  ? BigInt(process.env.DEPOSIT_WATCH_FROM_BLOCK)
  : null;
// Cap the number of blocks scanned per poll so a cold start can't request a huge range.
const DEPOSIT_MAX_BLOCK_SPAN = BigInt(process.env.DEPOSIT_MAX_BLOCK_SPAN || "2000");

// Multi-chain resolution
const CHAIN_CONFIG: Record<string, { chain: Chain; rpc: string; usdc: string }> = {
  mainnet: {
    chain: base,
    rpc: process.env.BASE_RPC_URL || "https://mainnet.base.org",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  sepolia: {
    chain: baseSepolia,
    rpc: process.env.BASE_RPC_URL || "https://sepolia.base.org",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
};

const chainCfg = CHAIN_CONFIG[BASE_CHAIN] || CHAIN_CONFIG.sepolia;

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const PROCESSED_FILE = join(process.env.BRIDGE_DATA_DIR || ".", ".bridge-processed-txs.json");
const DEPOSIT_STATE_FILE = join(process.env.BRIDGE_DATA_DIR || ".", ".bridge-deposit-watcher.json");
// R1E §3: RougeBridge timelock-queued withdrawals, keyed by canonical l1TxId. Survives restart.
const QUEUED_FILE = join(process.env.BRIDGE_DATA_DIR || ".", ".bridge-queued-txs.json");

function loadProcessedTxIds(): Set<string> {
  try {
    if (existsSync(PROCESSED_FILE)) {
      const data = JSON.parse(readFileSync(PROCESSED_FILE, "utf-8"));
      if (Array.isArray(data)) return new Set(data);
    }
  } catch (e: any) {
    console.warn(`[relayer] Could not load processed tx IDs: ${e.message}`);
  }
  return new Set();
}

function saveProcessedTxIds(ids: Set<string>): void {
  if (OBSERVE_ONLY) { console.log(`[OBSERVE] WOULD_PERSIST processed-tx ids (${ids.size}) — skipped`); return; }
  try {
    atomicWriteFile(PROCESSED_FILE, JSON.stringify([...ids]));
  } catch (e: any) {
    console.warn(`[relayer] Could not persist processed tx IDs: ${e.message}`);
  }
}

type DepositToken = "ETH" | "XRGE" | "USDC";
interface DepositRecord { key: string; txHash: string; pubkey: string; token: DepositToken; }
interface DepositWatcherState {
  lastBlock: string | null;   // last fully-scanned block (decimal string)
  claimed: string[];          // dedup keys for deposits already auto-claimed
  pending: DepositRecord[];   // discovered deposits whose claim has not yet succeeded
}

interface DepositWatcher {
  lastBlock: bigint | null;
  claimed: Set<string>;
  pending: Map<string, DepositRecord>;
}

function loadDepositState(): DepositWatcher {
  try {
    if (existsSync(DEPOSIT_STATE_FILE)) {
      const data: DepositWatcherState = JSON.parse(readFileSync(DEPOSIT_STATE_FILE, "utf-8"));
      return {
        lastBlock: data.lastBlock ? BigInt(data.lastBlock) : null,
        claimed: new Set(data.claimed || []),
        pending: new Map((data.pending || []).map((r) => [r.key, r])),
      };
    }
  } catch (e: any) {
    console.warn(`[relayer] Could not load deposit watcher state: ${e.message}`);
  }
  return { lastBlock: null, claimed: new Set(), pending: new Map() };
}

function saveDepositState(w: DepositWatcher): void {
  if (OBSERVE_ONLY) { console.log(`[OBSERVE] WOULD_PERSIST deposit-watcher state — skipped`); return; }
  try {
    const data: DepositWatcherState = {
      lastBlock: w.lastBlock !== null ? w.lastBlock.toString() : null,
      claimed: [...w.claimed],
      pending: [...w.pending.values()],
    };
    writeFileSync(DEPOSIT_STATE_FILE, JSON.stringify(data), "utf-8");
  } catch (e: any) {
    console.warn(`[relayer] Could not persist deposit watcher state: ${e.message}`);
  }
}

// ── State ───────────────────────────────────────────────────────

const processedTxIds = loadProcessedTxIds();  // Persisted to disk across restarts
const queuedTxs = loadQueuedState(QUEUED_FILE); // RougeBridge timelock-queued withdrawals (R1E)
const inFlightTxIds = new Set<string>();   // Currently being processed
const depositWatcher = loadDepositState(); // Deposit scan cursor + claim dedup
const nonceState = new Map<string, number>(); // per-signer managed nonce (address→next)
let isShuttingDown = false;

// Stats
const stats = {
  startTime: Date.now(),
  ethFulfilled: 0,
  xrgeFulfilled: 0,
  ethFailed: 0,
  xrgeFailed: 0,
  ethRefunded: 0,
  xrgeRefunded: 0,
  ethQueued: 0,
  ethAmbiguous: 0,
  ethSkipped: 0,
  depositsClaimed: 0,
  depositsFailed: 0,
  alertsSent: 0,
  totalPolls: 0,
};

// De-dupe alerts so we don't spam the webhook every poll for the same withdrawal.
const alertedTxIds = new Set<string>();

// ── ABIs ────────────────────────────────────────────────────────

const BRIDGE_VAULT_ABI = parseAbi([
  "function release(address to, uint256 amount, string l1TxId) external",
  "function totalLocked() external view returns (uint256)",
  "function vaultBalance() external view returns (uint256)",
  "function processedL1Txs(string) external view returns (bool)",
]);

// Emitted by the vault on a successful release() — used to reconcile a release that mined
// but whose receipt we lost (see reconcileXrgeIfReleased).
const BRIDGE_RELEASE_EVENT = parseAbiItem(
  "event BridgeRelease(address indexed recipient, uint256 amount, string l1TxId)"
);

// RougeBridge ABI (release fns, getters, events) lives in bridge-relayer-core.ts.
const ROUGE_BRIDGE_ADDRESS = process.env.ROUGE_BRIDGE_ADDRESS;

// Deposit events watched on Base to auto-claim on L1.
const BRIDGE_DEPOSIT_ETH_EVENT = parseAbiItem(
  "event BridgeDepositETH(address indexed sender, uint256 amount, string rougechainPubkey)"
);
const BRIDGE_DEPOSIT_ERC20_EVENT = parseAbiItem(
  "event BridgeDepositERC20(address indexed sender, address indexed token, uint256 amount, string rougechainPubkey)"
);
const VAULT_DEPOSIT_EVENT = parseAbiItem(
  "event BridgeDeposit(address indexed sender, uint256 amount, string rougechainPubkey, uint256 nonce)"
);

// ── Helpers ─────────────────────────────────────────────────────

function xrgeToWei(amount: number): bigint {
  return BigInt(amount) * 10n ** 18n;
}

/** Every vault BridgeRelease for `l1TxId` within XRGE_RELEASE_SCAN_BLOCKS, paged ≤ 2,000 blocks (throws on RPC failure). */
async function findVaultReleasesForL1(publicClient: any, vaultAddress: `0x${string}`, l1TxId: string): Promise<VaultReleaseLog[]> {
  const head: bigint = await publicClient.getBlockNumber();
  return findVaultReleases(async ({ fromBlock, toBlock }) => {
    const logs = await publicClient.getLogs({ address: vaultAddress, event: BRIDGE_RELEASE_EVENT, fromBlock, toBlock });
    return logs.map((lg: any) => ({
      txHash: lg.transactionHash as string, blockNumber: lg.blockNumber as bigint,
      recipient: String(lg.args?.recipient ?? lg.args?.to ?? ""), amount: BigInt(lg.args?.amount ?? 0), l1TxId: String(lg.args?.l1TxId ?? ""),
    }));
  }, l1TxId, head, XRGE_RELEASE_SCAN_BLOCKS, undefined, LOG_SCAN_PACING); // paced + retried: public RPCs rate-limit bursts
}
/** Observation-mode helper: first release tx hash for an id, or null (scan errors → null + warn). */
async function findReleaseTxForL1(publicClient: any, vaultAddress: `0x${string}`, l1TxId: string): Promise<`0x${string}` | null> {
  try { const hits = await findVaultReleasesForL1(publicClient, vaultAddress, l1TxId); return hits.length ? (hits[0].txHash as `0x${string}`) : null; }
  catch (e: any) { console.warn(`[XRGE] release-log scan failed for ${l1TxId}: ${e.message}`); return null; }
}

function uptimeStr(): string {
  const secs = Math.floor((Date.now() - stats.startTime) / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h${m}m`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Retry a function with exponential backoff. */
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  retries = MAX_RETRIES,
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastError = e;
      if (attempt < retries) {
        const delay = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
        console.warn(`[relayer] ${label} attempt ${attempt}/${retries} failed, retrying in ${delay}ms: ${e.message}`);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

/** Get next nonce for a given signer, managed per-address to avoid stuck txs. */
async function getNextNonce(publicClient: PublicClient, address: `0x${string}`): Promise<number> {
  const key = address.toLowerCase();
  if (!nonceState.has(key)) {
    // Seed from on-chain
    const seeded = await publicClient.getTransactionCount({ address, blockTag: "pending" });
    nonceState.set(key, seeded);
    console.log(`[relayer] Seeded nonce for ${address.slice(0, 10)}…: ${seeded}`);
  }
  const nonce = nonceState.get(key)!;
  nonceState.set(key, nonce + 1);
  return nonce;
}

/** Reset a signer's nonce on failure (re-seed from chain next time). Omit to reset all. */
function resetNonce(address?: `0x${string}`) {
  if (address) nonceState.delete(address.toLowerCase());
  else nonceState.clear();
}

// ── API calls ───────────────────────────────────────────────────

// EthWithdrawal / normalizeEthWithdrawal (carrying token_symbol) live in bridge-relayer-core.ts.

interface XrgeWithdrawal {
  txId?: string;
  tx_id?: string;
  evmAddress?: string;
  evm_address?: string;
  amount: number;
}

function normalizeXrgeWithdrawal(w: XrgeWithdrawal): { tx_id: string; evm_address: string; amount: number } {
  return {
    tx_id: w.txId || w.tx_id || "",
    evm_address: w.evmAddress || w.evm_address || "",
    amount: w.amount || 0,
  };
}

async function fetchEthWithdrawals(): Promise<EthWithdrawal[]> {
  const res = await fetch(`${CORE_API_URL}/api/bridge/withdrawals`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const data: any = await res.json();
  return data.withdrawals || [];
}

async function fulfillEthWithdrawal(txId: string, evmTxHash: string): Promise<boolean> {
  if (OBSERVE_ONLY) observeRefuse("WOULD_FULFILL", `EVM ${txId} via ${evmTxHash}`);
  const res = await fetch(`${CORE_API_URL}/api/bridge/withdrawals/${encodeURIComponent(txId)}`, {
    method: "DELETE",
    headers: { "x-bridge-relayer-secret": RELAYER_SECRET, "Content-Type": "application/json" },
    body: JSON.stringify({ evmTxHash }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data: any = {}; try { data = JSON.parse(text); } catch { /* non-JSON body */ }
  if (data.success === true) return true;
  console.warn(`[EVM] daemon fulfill rejected ${txId} via ${evmTxHash}: HTTP ${res.status} ${String(data.error ?? text ?? "").slice(0, 300)}`);
  return false;
}

async function fetchXrgeWithdrawals(): Promise<XrgeWithdrawal[]> {
  try {
    const res = await fetch(`${CORE_API_URL}/api/bridge/xrge/withdrawals`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data: any = await res.json();
    return data.withdrawals || [];
  } catch {
    return [];
  }
}

async function fulfillXrgeWithdrawal(txId: string, evmTxHash: string): Promise<XrgeFulfillResult> {
  if (OBSERVE_ONLY) observeRefuse("WOULD_FULFILL", `XRGE ${txId} via ${evmTxHash}`);
  try {
    const res = await fetch(`${CORE_API_URL}/api/bridge/xrge/withdrawals/${encodeURIComponent(txId)}`, {
      method: "DELETE",
      headers: { "x-bridge-relayer-secret": RELAYER_SECRET, "Content-Type": "application/json" },
      body: JSON.stringify({ evmTxHash }),
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let data: any = {}; try { data = JSON.parse(text); } catch { /* non-JSON body */ }
    if (data.success === true) return { ok: true, status: res.status };
    const error = String(data.error ?? text ?? "").slice(0, 300);
    console.warn(`[XRGE] daemon fulfill rejected ${txId}: HTTP ${res.status} ${error}`);
    return { ok: false, status: res.status, error };
  } catch (e: any) {
    console.warn(`[XRGE] daemon fulfill request failed for ${txId}: ${e.message}`);
    return { ok: false, status: 0, error: `request failed: ${e.message}` };
  }
}

/** Send a prominent alert to the console and, if configured, a webhook. De-duped per tx. */
async function alert(key: string, message: string): Promise<void> {
  console.error(`\n🚨 [ALERT] ${message}\n`);
  if (alertedTxIds.has(key)) return;
  alertedTxIds.add(key);
  stats.alertsSent++;
  if (!ALERT_WEBHOOK_URL) return;
  try {
    await fetch(ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `🚨 RougeChain Bridge Relayer: ${message}` }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e: any) {
    console.warn(`[relayer] Alert webhook failed: ${e.message}`);
  }
}

/**
 * Report a failed release attempt to the daemon. The daemon bumps the attempt
 * counter and tells us whether the withdrawal has crossed the refund threshold.
 */
async function reportWithdrawalFailure(
  txId: string,
  error: string,
): Promise<{ shouldRefund: boolean; attempts: number }> {
  if (OBSERVE_ONLY) observeRefuse("WOULD_REPORT_FAILURE", `${txId}: ${error}`);
  try {
    const res = await fetch(
      `${CORE_API_URL}/api/bridge/withdrawals/${encodeURIComponent(txId)}/failure`,
      {
        method: "POST",
        headers: {
          "x-bridge-relayer-secret": RELAYER_SECRET,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ error }),
        signal: AbortSignal.timeout(10000),
      },
    );
    const data: any = await res.json().catch(() => ({}));
    return { shouldRefund: data.shouldRefund === true, attempts: data.attempts || 0 };
  } catch (e: any) {
    console.warn(`[relayer] Failed to report withdrawal failure for ${txId}: ${e.message}`);
    return { shouldRefund: false, attempts: 0 };
  }
}

/**
 * Auto-claim a deposit discovered on-chain: the daemon re-verifies the EVM tx,
 * dedupes against browser claims, and mints to the recipient. Idempotent.
 */
async function autoClaimDeposit(
  evmTxHash: string,
  recipientRougechainPubkey: string,
  token: "ETH" | "XRGE" | "USDC",
): Promise<{ ok: boolean; error?: string }> {
  if (OBSERVE_ONLY) observeRefuse("WOULD_CLAIM_DEPOSIT", `${token} ${evmTxHash} → ${recipientRougechainPubkey.slice(0, 16)}…`);
  try {
    const res = await fetch(`${CORE_API_URL}/api/bridge/deposit/auto-claim`, {
      method: "POST",
      headers: {
        "x-bridge-relayer-secret": RELAYER_SECRET,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ evmTxHash, recipientRougechainPubkey, token }),
      signal: AbortSignal.timeout(20000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (data.success === true) return { ok: true };
    return { ok: false, error: data.error || "unknown" };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/** Ask the daemon to refund a withdrawal (re-mint burned tokens to the owner). */
async function refundWithdrawal(txId: string): Promise<boolean> {
  if (OBSERVE_ONLY) observeRefuse("WOULD_REFUND", txId);
  try {
    const res = await fetch(
      `${CORE_API_URL}/api/bridge/withdrawals/${encodeURIComponent(txId)}/refund`,
      {
        method: "POST",
        headers: {
          "x-bridge-relayer-secret": RELAYER_SECRET,
          "Content-Type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(15000),
      },
    );
    const data: any = await res.json().catch(() => ({}));
    if (data.success === true) return true;
    console.warn(`[relayer] Refund API declined for ${txId}: ${data.error || "unknown"}`);
    return false;
  } catch (e: any) {
    console.warn(`[relayer] Refund request failed for ${txId}: ${e.message}`);
    return false;
  }
}

/**
 * XRGE failure handling: report the failure to the daemon, alert on repeated failure, and
 * auto-refund once the daemon says the threshold is crossed (only when AUTO_REFUND=true; the
 * XRGE BridgeVault processed guard in reconcileXrgeIfReleased runs BEFORE this is reached).
 * qETH/qUSDC failures never come here — they go through the core's fail-closed refund gate.
 */
async function handleWithdrawalFailure(kind: "XRGE", txId: string, error: string): Promise<void> {
  if (OBSERVE_ONLY) observeRefuse("WOULD_REPORT_FAILURE", `${kind} ${txId}: ${error}`);
  const { shouldRefund, attempts } = await reportWithdrawalFailure(txId, error);
  if (attempts >= 3) {
    await alert(txId, `${kind} withdrawal ${txId.slice(0, 16)}… has failed ${attempts}× (last: ${error})`);
  }
  if (shouldRefund && AUTO_REFUND) {
    console.warn(`[${kind}] Attempting refund for ${txId} after ${attempts} failures`);
    const refunded = await refundWithdrawal(txId);
    if (refunded) {
      await alert(`refund:${txId}`, `${kind} withdrawal ${txId.slice(0, 16)}… was REFUNDED on L1 after ${attempts} failures`);
      processedTxIds.add(txId);
      saveProcessedTxIds(processedTxIds);
      stats.xrgeRefunded++;
    }
  }
}

// ── RougeBridge on-chain adapters (network-facing side of the core's EvmChainDeps) ──

/**
 * Scan RougeBridge logs of `event` (optionally filtered by indexed args) over the configured
 * lookback: ≤ 2,000 blocks per request, contiguous/non-overlapping, paced, bounded retry. THROWS
 * if any page cannot be read — a partial scan must never be reported as "nothing found".
 */
async function scanBridgeLogs(
  publicClient: PublicClient,
  bridgeAddress: Hex,
  event: any,
  args?: Record<string, unknown>,
  opts: { lookbackBlocks?: bigint; toBlockOverride?: bigint } = {},
): Promise<any[]> {
  const latest = opts.toBlockOverride ?? (await publicClient.getBlockNumber());
  const lookback = opts.lookbackBlocks ?? BRIDGE_LOG_SCAN_BLOCKS;
  const from = latest > lookback ? latest - lookback : 0n;
  return scanLogPagesDescending(
    ({ fromBlock, toBlock }) => publicClient.getLogs({ address: bridgeAddress, event, args, fromBlock, toBlock } as any) as Promise<any[]>,
    from, latest, undefined, LOG_SCAN_PACING,
  );
}

function toReceiptLike(r: any): ReceiptLike {
  return {
    status: r.status === "success" ? "success" : "reverted",
    transactionHash: r.transactionHash,
    blockNumber: r.blockNumber,
    logs: (r.logs || []).map((l: any): RawLog => ({
      address: l.address,
      data: l.data,
      topics: l.topics,
      transactionHash: l.transactionHash,
      blockNumber: l.blockNumber,
    })),
  };
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  if (!PRIVATE_KEY?.trim()) {
    console.error("BRIDGE_CUSTODY_PRIVATE_KEY is required");
    process.exit(1);
  }
  const key = PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
  const account = privateKeyToAccount(key as `0x${string}`);

  const transport = http(chainCfg.rpc);
  const publicClient = createPublicClient({ chain: chainCfg.chain, transport });
  // Observation mode never constructs a signing client: there is nothing that COULD sign.
  const walletClient = OBSERVE_ONLY ? null : createWalletClient({ account, chain: chainCfg.chain, transport });

  // ── Production preflight (R1D §11): refuse to start on ANY failure. Not env-bypassable and
  //    no carve-outs: a missing/invalid ROUGE_BRIDGE_ADDRESS is itself a preflight failure.
  //    Unit tests exercise `preflight` with an injected fake client instead.
  try {
    await preflight(
      {
        getChainId: () => publicClient.getChainId(),
        getCode: (a) => publicClient.getCode(a),
        readContract: (a) => publicClient.readContract(a as any),
      },
      {
        expectedChainId: chainCfg.chain.id,
        bridgeAddress: ROUGE_BRIDGE_ADDRESS,
        configuredUsdc: BRIDGE_USDC_ADDRESS,
        chainUsdc: chainCfg.usdc,
        vaultAddress: VAULT_ADDRESS,
        expectedOwner: ROUGE_BRIDGE_OWNER || account.address,
      },
    );
  } catch (e: any) {
    console.error(`${e?.message || e}\n[relayer] PREFLIGHT FAILED — refusing to start.`);
    process.exit(1);
  }
  // preflight() threw unless ROUGE_BRIDGE_ADDRESS is a valid address with contract code.
  const bridgeConfigured = isEvmAddress(ROUGE_BRIDGE_ADDRESS);

  // Dedicated XRGE-release signer (BridgeVaultV2 role split). Falls back to the custody
  // key when XRGE_RELAYER_PRIVATE_KEY is unset, so V1 / single-key setups are unchanged.
  const xrgeAccount = XRGE_RELAYER_KEY?.trim()
    ? privateKeyToAccount((XRGE_RELAYER_KEY.startsWith("0x") ? XRGE_RELAYER_KEY : `0x${XRGE_RELAYER_KEY}`) as `0x${string}`)
    : account;
  const xrgeWalletClient = OBSERVE_ONLY ? null : xrgeAccount === account
    ? walletClient
    : createWalletClient({ account: xrgeAccount, chain: chainCfg.chain, transport });

  console.log(`╔══════════════════════════════════════════════════╗`);
  console.log(`║  RougeChain Bridge Relayer v2                    ║`);
  console.log(`╠══════════════════════════════════════════════════╣`);
  console.log(`║  Chain:    Base ${BASE_CHAIN.padEnd(40)}║`);
  console.log(`║  ChainId:  ${String(chainCfg.chain.id).padEnd(39)}║`);
  console.log(`║  RPC:      ${chainCfg.rpc.slice(0, 38).padEnd(39)}║`);
  console.log(`║  Relayer:  ${account.address.slice(0, 38).padEnd(39)}║`);
  console.log(`║  API:      ${CORE_API_URL.slice(0, 38).padEnd(39)}║`);
  console.log(`║  Poll:     ${String(POLL_MS + "ms").padEnd(39)}║`);
  console.log(`║  Confirms: ${String(CONFIRMATIONS).padEnd(39)}║`);
  console.log(`╚══════════════════════════════════════════════════╝`);

  // XRGE vault
  let vaultContract: ReturnType<typeof getContract> | null = null;
  if (VAULT_ADDRESS) {
    vaultContract = getContract({
      address: VAULT_ADDRESS as `0x${string}`,
      abi: BRIDGE_VAULT_ABI,
      client: OBSERVE_ONLY ? { public: publicClient } : { public: publicClient, wallet: xrgeWalletClient! },
    });
    console.log(`[relayer] XRGE BridgeVault: ${VAULT_ADDRESS} (release signer: ${xrgeAccount.address}${xrgeAccount === account ? " = custody key" : " = dedicated XRGE key"})`);
  } else {
    console.log("[relayer] No XRGE_BRIDGE_VAULT — XRGE bridge disabled");
  }

  // RougeBridge contract (REQUIRED for qETH/qUSDC payouts — R1D §4)
  const bridgeAddress: Hex | null = bridgeConfigured ? (ROUGE_BRIDGE_ADDRESS as Hex) : null;
  if (bridgeAddress) {
    console.log(`[relayer] RougeBridge: ${bridgeAddress} (USDC ${chainCfg.usdc}, queued=${queuedTxs.size})`);
  } else {
    // Unreachable after a passing preflight; kept as a defensive fail-closed message.
    console.warn("[relayer] No valid ROUGE_BRIDGE_ADDRESS — qETH/qUSDC payouts DISABLED (fail closed)");
  }
  console.log(`[relayer] AUTO_REFUND=${AUTO_REFUND}`);
  console.log(`[relayer] qETH/qUSDC fulfill confirmations: ${evmFulfillDepth({ fulfillConfirmations: CONFIRMATIONS })} (relayer ${CONFIRMATIONS}, never below daemon QV_BRIDGE_MIN_CONFIRMATIONS); RougeBridge log scans ≤ 2000 blocks/page, lookback ${BRIDGE_LOG_SCAN_BLOCKS}`);
  console.log(`[relayer] XRGE fulfill confirmations: ${XRGE_FULFILL_CONFIRMATIONS} (relayer ${CONFIRMATIONS}, daemon-required ≥ ${XRGE_FULFILL_CONFIRMATIONS}); release-log scan ≤ 2000 blocks/page, lookback ${XRGE_RELEASE_SCAN_BLOCKS}`);
  console.log(`[relayer] RougeBridge signer (custody key account): ${account.address}`);
  if (OBSERVE_ONLY) console.log("[relayer] *** BRIDGE_OBSERVE_ONLY=true — OBSERVATION MODE: read-only; NO releases, NO fulfill, NO failure reports, NO refunds, NO deposit claims, NO state writes ***");

  if (DEPOSIT_WATCHER && (ROUGE_BRIDGE_ADDRESS || VAULT_ADDRESS)) {
    const resume = depositWatcher.lastBlock !== null ? `resuming from block ${depositWatcher.lastBlock}` : "anchoring at chain head";
    console.log(`[relayer] Deposit watcher: ENABLED (${resume}, ${depositWatcher.pending.size} pending)`);
  } else {
    console.log("[relayer] Deposit watcher: disabled");
  }

  // ── qETH / qUSDC withdrawals via RougeBridge (R1B/R1D/R1E) ──

  /** Read `timelockQueue(requestId)`; `confirmed` reads at head - CONFIRMATIONS. */
  const readTimelockQueue = async (requestId: bigint, opts?: { confirmed?: boolean }): Promise<TimelockRecord> => {
    if (!bridgeAddress) throw new Error("RougeBridge not configured");
    let blockNumber: bigint | undefined;
    if (opts?.confirmed) {
      const head = await publicClient.getBlockNumber();
      blockNumber = head > BigInt(CONFIRMATIONS) ? head - BigInt(CONFIRMATIONS) : 0n;
    }
    const tuple = await publicClient.readContract({
      address: bridgeAddress,
      abi: ROUGE_BRIDGE_ABI,
      functionName: "timelockQueue",
      args: [requestId],
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    });
    return parseTimelockQueueTuple(tuple as readonly unknown[]);
  };

  const evmDepsRaw: EvmPayoutDeps = {
    bridgeAddress,
    usdcAddress: chainCfg.usdc,
    autoRefund: AUTO_REFUND,
    maxRetries: MAX_RETRIES,
    fulfillConfirmations: CONFIRMATIONS, // effective depth = max(this, daemon QV_BRIDGE_MIN_CONFIRMATIONS)
    processedTxIds,
    markProcessed: (txId) => {
      processedTxIds.add(txId);
      saveProcessedTxIds(processedTxIds);
    },
    queued: queuedTxs,
    saveQueued: () => { if (OBSERVE_ONLY) observeRefuse("WOULD_PERSIST", "queued-state file"); saveQueuedState(QUEUED_FILE, queuedTxs); },
    chain: {
      releaseETH: (to, wei, l1TxId, nonce) =>
        (OBSERVE_ONLY || !walletClient) ? observeRefuse("WOULD_RELEASE", `releaseETH ${wei} wei → ${to} l1TxId=${l1TxId}`) : walletClient.writeContract({
          address: bridgeAddress!,
          abi: ROUGE_BRIDGE_ABI,
          functionName: "releaseETH",
          args: [to as Hex, wei, l1TxId],
          nonce,
        }),
      releaseERC20: (token, to, amount, l1TxId, nonce) =>
        (OBSERVE_ONLY || !walletClient) ? observeRefuse("WOULD_RELEASE", `releaseERC20 ${amount} of ${token} → ${to} l1TxId=${l1TxId}`) : walletClient.writeContract({
          address: bridgeAddress!,
          abi: ROUGE_BRIDGE_ABI,
          functionName: "releaseERC20",
          args: [token as Hex, to as Hex, amount, l1TxId],
          nonce,
        }),
      waitForReceipt: async (hash) =>
        toReceiptLike(await publicClient.waitForTransactionReceipt({ hash, confirmations: Math.max(1, CONFIRMATIONS), timeout: 120_000 })),
      getReceipt: async (hash) => {
        try {
          return toReceiptLike(await publicClient.getTransactionReceipt({ hash }));
        } catch {
          return null;
        }
      },
      processedL1Txs: (l1TxId) =>
        publicClient.readContract({ address: bridgeAddress!, abi: ROUGE_BRIDGE_ABI, functionName: "processedL1Txs", args: [l1TxId] }) as Promise<boolean>,
      headBlock: () => publicClient.getBlockNumber(),
      timelockQueue: readTimelockQueue,
      findReleaseTxHashes: async (exp: ExpectedRelease) => {
        const event = exp.asset === "Eth" ? BRIDGE_RELEASE_ETH_EVENT : BRIDGE_RELEASE_ERC20_EVENT;
        const logs = await scanBridgeLogs(publicClient, bridgeAddress!, event, { recipient: exp.recipient as Hex });
        const hashes: Hex[] = [];
        for (const lg of logs) {
          if (sameHex(lg.args?.l1TxId, exp.canonicalId) && lg.transactionHash && !hashes.includes(lg.transactionHash)) {
            hashes.push(lg.transactionHash);
          }
        }
        return hashes;
      },
      findQueuedRequestIds: async () => {
        const logs = await scanBridgeLogs(publicClient, bridgeAddress!, TIMELOCK_QUEUED_EVENT);
        const ids = new Set<bigint>();
        for (const lg of logs) if (lg.args?.requestId !== undefined) ids.add(lg.args.requestId as bigint);
        return [...ids];
      },
      findTimelockQueuedEvent: async (requestId) => {
        const logs = await scanBridgeLogs(publicClient, bridgeAddress!, TIMELOCK_QUEUED_EVENT, { requestId });
        const lg = logs[0];
        return lg ? { executeAfter: lg.args.executeAfter as bigint, txHash: lg.transactionHash ?? null } : null;
      },
      findTimelockExecutedTxHashes: async (requestId) => {
        const logs = await scanBridgeLogs(publicClient, bridgeAddress!, TIMELOCK_EXECUTED_EVENT, { requestId });
        return [...new Set(logs.map((l) => l.transactionHash as Hex).filter(Boolean))];
      },
      findTimelockCancelled: async (requestId) => {
        const head = await publicClient.getBlockNumber();
        const safeHead = head > BigInt(CONFIRMATIONS) ? head - BigInt(CONFIRMATIONS) : 0n;
        const logs = await scanBridgeLogs(publicClient, bridgeAddress!, TIMELOCK_CANCELLED_EVENT, { requestId }, { toBlockOverride: safeHead });
        return logs.length > 0;
      },
      getNonce: () => getNextNonce(publicClient, account.address),
      resetNonce: () => resetNonce(account.address),
    },
    daemon: {
      fulfill: fulfillEthWithdrawal,
      reportFailure: reportWithdrawalFailure,
      refund: refundWithdrawal,
    },
    alert,
    log: (m) => console.log(m),
    warn: (m) => console.warn(m),
    sleep,
  };
  // Observation mode: every mutating member of the deps refuses before any side effect.
  const evmDeps: EvmPayoutDeps = OBSERVE_ONLY ? observeGuardedDeps(evmDepsRaw) : evmDepsRaw;

  const processEthWithdrawals = async () => {
    try {
      const withdrawals: EthWithdrawal[] = await fetchEthWithdrawals();
      if (withdrawals.length === 0) return;

      const balance = await publicClient.getBalance({ address: account.address });
      console.log(`[EVM] Pending: ${withdrawals.length}, Signer balance: ${(Number(balance) / 1e18).toFixed(6)} ETH`);

      for (const raw of withdrawals) {
        const w = normalizeEthWithdrawal(raw);
        if (isShuttingDown) break;
        if (!w.tx_id || processedTxIds.has(w.tx_id) || inFlightTxIds.has(w.tx_id)) continue;
        inFlightTxIds.add(w.tx_id);
        try {
          const outcome = await processEvmWithdrawal(w, evmDeps);
          switch (outcome) {
            case "fulfilled":
            case "reconciled_paid":
              stats.ethFulfilled++;
              break;
            case "queued":
            case "reconciled_queued":
              stats.ethQueued++;
              break;
            case "ambiguous":
            case "cancelled_refund_candidate":
              stats.ethAmbiguous++;
              break;
            case "refunded":
              stats.ethRefunded++;
              break;
            case "failed":
              stats.ethFailed++;
              break;
            case "skipped_queued":
            case "awaiting_confirmations": // paid, waiting for the daemon-required depth — retried next poll
              break;
            default:
              stats.ethSkipped++;
          }
        } catch (e: any) {
          // The core handles its own failure paths; anything escaping here is unexpected.
          console.error(`[EVM] Unexpected error for ${w.tx_id}: ${e.message}`);
          resetNonce(account.address);
        } finally {
          inFlightTxIds.delete(w.tx_id);
        }
      }
    } catch (e: any) {
      console.error("[EVM] Poll error:", e.message);
    }
  };

  const processQueued = async () => {
    if (!bridgeAddress || queuedTxs.size === 0) return;
    try {
      await pollQueuedWithdrawals(evmDeps);
    } catch (e: any) {
      console.error("[EVM] Queue poll error:", e.message);
    }
  };

  // ── XRGE withdrawals ────────────────────────────────────────

  // payouts mined but not yet fulfilled (awaiting daemon-required confirmations): tx_id → payout
  const xrgePendingFulfill = new Map<string, { txHash: string; blockNumber: bigint }>();
  const processXrgeWithdrawals = async () => {
    if (!vaultContract) return;

    try {
      const withdrawals = await fetchXrgeWithdrawals();
      if (withdrawals.length === 0) return;

      console.log(`[XRGE] Pending: ${withdrawals.length}`);

      for (const raw of withdrawals) {
        const w = normalizeXrgeWithdrawal(raw);
        if (isShuttingDown) break;
        if (processedTxIds.has(w.tx_id) || inFlightTxIds.has(w.tx_id)) continue;
        if (OBSERVE_ONLY) {
          await observeXrgeWithdrawal(w, {
            processedOnVault: (id) => publicClient.readContract({ address: VAULT_ADDRESS as `0x${string}`, abi: BRIDGE_VAULT_ABI, functionName: "processedL1Txs", args: [id] }) as Promise<boolean>,
            findReleaseTx: (id) => findReleaseTxForL1(publicClient, VAULT_ADDRESS as `0x${string}`, id),
            log: (m) => console.log(m),
          });
          continue;
        }
        inFlightTxIds.add(w.tx_id);
        try {
          const outcome = await processXrgeWithdrawal(w, {
            requiredConfirmations: XRGE_FULFILL_CONFIRMATIONS,
            processedOnVault: (id) => publicClient.readContract({ address: VAULT_ADDRESS as `0x${string}`, abi: BRIDGE_VAULT_ABI, functionName: "processedL1Txs", args: [id] }) as Promise<boolean>,
            release: async (to, wei, id) => {
              if (OBSERVE_ONLY) observeRefuse("WOULD_RELEASE", `XRGE vault.release ${wei} → ${to} l1TxId=${id}`);
              const nonce = await getNextNonce(publicClient, xrgeAccount.address);
              try { return await (vaultContract as any).write.release([to as `0x${string}`, wei, id], { nonce }); }
              catch (e) { resetNonce(xrgeAccount.address); throw e; }
            },
            waitForReceipt: async (hash) => {
              const r = await publicClient.waitForTransactionReceipt({ hash: hash as `0x${string}`, confirmations: 1, timeout: 120_000 });
              if (r.status !== "success") resetNonce(xrgeAccount.address);
              return { status: r.status, blockNumber: r.blockNumber };
            },
            headBlock: () => publicClient.getBlockNumber(),
            findReleases: (id) => findVaultReleasesForL1(publicClient, VAULT_ADDRESS as `0x${string}`, id),
            fulfill: fulfillXrgeWithdrawal,
            handleFailure: (id, err) => handleWithdrawalFailure("XRGE", id, err),
            markProcessed: (id) => { processedTxIds.add(id); saveProcessedTxIds(processedTxIds); },
            pendingFulfill: xrgePendingFulfill,
            alert,
            log: (m) => console.log(m),
            warn: (m) => console.warn(m),
          });
          if (outcome === "fulfilled" || outcome === "reconciled_fulfilled") stats.xrgeFulfilled++;
          else if (outcome === "failed") stats.xrgeFailed++;
        } catch (e: any) {
          // processXrgeWithdrawal handles its own failure paths; anything here is unexpected — never a refund trigger.
          console.error(`[XRGE] Unexpected error for ${w.tx_id}: ${e.message}`);
          resetNonce(xrgeAccount.address);
        } finally {
          inFlightTxIds.delete(w.tx_id);
        }
      }
    } catch (e: any) {
      console.error("[XRGE] Poll error:", e.message);
    }
  };

  // ── Deposit watcher (Base → L1 auto-claim) ──────────────────

  /** Attempt to claim one discovered deposit; route the result into claimed/pending. */
  const claimOne = async (d: DepositRecord): Promise<void> => {
    if (OBSERVE_ONLY) { observeDeposit(d, (m) => console.log(m)); depositWatcher.claimed.add(d.key); /* in-memory only: avoid re-logging; never persisted */ return; }
    const { ok, error } = await autoClaimDeposit(d.txHash, d.pubkey, d.token);
    // "already claimed" means a browser claim beat us to it — treat as done.
    if (ok || (error && error.toLowerCase().includes("already claimed"))) {
      depositWatcher.claimed.add(d.key);
      depositWatcher.pending.delete(d.key);
      if (ok) {
        stats.depositsClaimed++;
        console.log(`[deposit] ✓ Auto-claimed ${d.token} ${d.txHash.slice(0, 12)}… → ${d.pubkey.slice(0, 12)}…`);
      }
    } else {
      depositWatcher.pending.set(d.key, d);
      stats.depositsFailed++;
      console.warn(`[deposit] ✗ Auto-claim failed for ${d.token} ${d.txHash.slice(0, 12)}…: ${error}`);
      await alert(`deposit:${d.key}`, `Deposit auto-claim failing for ${d.token} ${d.txHash.slice(0, 16)}…: ${error}`);
    }
  };

  const processDeposits = async () => {
    if (!DEPOSIT_WATCHER) return;
    if (!ROUGE_BRIDGE_ADDRESS && !VAULT_ADDRESS) return;
    try {
      // 1) Retry any previously-discovered deposits whose claim hasn't landed yet.
      for (const d of [...depositWatcher.pending.values()]) {
        if (isShuttingDown) break;
        await claimOne(d);
      }

      // 2) Scan newly-confirmed blocks for fresh deposits.
      // Effective confirmed head = head − max(CONFIRMATIONS, daemon QV_BRIDGE_MIN_CONFIRMATIONS): never
      // hand the daemon a deposit it will refuse as too shallow. A head read failure throws → no claim.
      const head = await publicClient.getBlockNumber();
      const safeHead = depositWatcherSafeHead(head, CONFIRMATIONS);
      if (safeHead === null) return;

      let fromBlock: bigint;
      if (depositWatcher.lastBlock !== null) {
        fromBlock = depositWatcher.lastBlock + 1n;
      } else if (DEPOSIT_WATCH_FROM_BLOCK !== null) {
        fromBlock = DEPOSIT_WATCH_FROM_BLOCK;
      } else {
        // First run with no explicit start: anchor at the current head (don't backfill).
        depositWatcher.lastBlock = safeHead;
        saveDepositState(depositWatcher);
        console.log(`[deposit] Watcher anchored at block ${safeHead}`);
        return;
      }
      if (fromBlock > safeHead) return; // nothing new confirmed

      // Bound the span so a long downtime doesn't request an enormous range at once.
      let toBlock = safeHead;
      if (toBlock - fromBlock + 1n > DEPOSIT_MAX_BLOCK_SPAN) {
        toBlock = fromBlock + DEPOSIT_MAX_BLOCK_SPAN - 1n;
      }

      const found: DepositRecord[] = [];
      const pushLog = (log: any, token: DepositToken) => {
        const txHash = (log.transactionHash || "").toLowerCase();
        const pubkey = log.args?.rougechainPubkey as string | undefined;
        if (!txHash || !pubkey) return;
        found.push({ key: `${token}:${txHash}`, txHash, pubkey, token });
      };

      if (ROUGE_BRIDGE_ADDRESS) {
        const ethLogs = await publicClient.getLogs({
          address: ROUGE_BRIDGE_ADDRESS as `0x${string}`,
          event: BRIDGE_DEPOSIT_ETH_EVENT, fromBlock, toBlock,
        });
        for (const log of ethLogs) pushLog(log, "ETH");

        const erc20Logs = await publicClient.getLogs({
          address: ROUGE_BRIDGE_ADDRESS as `0x${string}`,
          event: BRIDGE_DEPOSIT_ERC20_EVENT, fromBlock, toBlock,
        });
        for (const log of erc20Logs) {
          const tokenAddr = ((log.args as any)?.token as string || "").toLowerCase();
          if (tokenAddr === chainCfg.usdc.toLowerCase()) pushLog(log, "USDC");
          else console.warn(`[deposit] Skipping unsupported ERC20 ${tokenAddr} (tx ${log.transactionHash})`);
        }
      }
      if (VAULT_ADDRESS) {
        const xrgeLogs = await publicClient.getLogs({
          address: VAULT_ADDRESS as `0x${string}`,
          event: VAULT_DEPOSIT_EVENT, fromBlock, toBlock,
        });
        for (const log of xrgeLogs) pushLog(log, "XRGE");
      }

      if (found.length > 0) {
        console.log(`[deposit] Blocks ${fromBlock}–${toBlock}: ${found.length} deposit event(s)`);
      }
      for (const d of found) {
        if (isShuttingDown) break;
        if (depositWatcher.claimed.has(d.key) || depositWatcher.pending.has(d.key)) continue;
        await claimOne(d);
      }

      // Advance the cursor regardless of individual claim outcomes — failed ones
      // live in `pending` and are retried each poll, so scanning always moves forward.
      depositWatcher.lastBlock = toBlock;
      saveDepositState(depositWatcher);
    } catch (e: any) {
      console.error("[deposit] Poll error:", e.message);
    }
  };

  // ── Polling loop ──────────────────────────────────────────────

  const run = async () => {
    stats.totalPolls++;
    // R1 derived-state health gate: if the daemon reports its payout store DEGRADED (or the
    // health endpoint is unreachable), refuse to operate on ANY withdrawal list this poll.
    let health: { status: number; body: unknown } | null = null;
    try {
      const res = await fetch(`${CORE_API_URL}/api/bridge/health`, { signal: AbortSignal.timeout(10000) });
      health = { status: res.status, body: await res.json().catch(() => ({})) };
    } catch (e) {
      health = null;
    }
    if (!bridgeHealthAllowsPayouts(health)) {
      const detail = health ? `HTTP ${health.status} ${JSON.stringify(health.body).slice(0, 200)}` : "health endpoint unreachable";
      console.error(`[health] bridge derived state NOT healthy — refusing to process withdrawals this poll (${detail})`);
      await alert(`bridge-degraded`, `Daemon bridge payout store degraded/unreachable — relayer paused payouts: ${detail}`).catch(() => {});
      return;
    }
    // The EVM feed and the timelock queue poll share the custody signer/nonce → run sequentially.
    await Promise.all([
      (async () => { await processEthWithdrawals(); await processQueued(); })(),
      processXrgeWithdrawals(),
      processDeposits(),
    ]);

    if (OBSERVE_ONLY) {
      console.log(`[OBSERVE] poll ${stats.totalPolls} complete — bridge health OK; writes performed: 0`);
    }
    // Health log every 60 polls
    if (stats.totalPolls % 60 === 0) {
      console.log(
        `[health] uptime=${uptimeStr()} polls=${stats.totalPolls} ` +
        `evm_ok=${stats.ethFulfilled} evm_fail=${stats.ethFailed} evm_queued=${stats.ethQueued} ` +
        `evm_ambiguous=${stats.ethAmbiguous} evm_skipped=${stats.ethSkipped} ` +
        `xrge_ok=${stats.xrgeFulfilled} xrge_fail=${stats.xrgeFailed} ` +
        `refunded=${stats.ethRefunded + stats.xrgeRefunded} alerts=${stats.alertsSent} ` +
        `deposits_ok=${stats.depositsClaimed} deposits_pending=${depositWatcher.pending.size} ` +
        `processed=${processedTxIds.size} queued=${queuedTxs.size} inflight=${inFlightTxIds.size}`
      );
    }
  };

  // Graceful shutdown
  const shutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log("\n[relayer] Shutting down gracefully...");
    console.log(
      `[relayer] Final stats: ETH=${stats.ethFulfilled}/${stats.ethFailed} ` +
      `XRGE=${stats.xrgeFulfilled}/${stats.xrgeFailed} polls=${stats.totalPolls}`
    );
    // Persist state before exit
    saveProcessedTxIds(processedTxIds);
    if (!OBSERVE_ONLY) saveQueuedState(QUEUED_FILE, queuedTxs);
    saveDepositState(depositWatcher);
    // Wait for in-flight txs
    if (inFlightTxIds.size > 0) {
      console.log(`[relayer] Waiting for ${inFlightTxIds.size} in-flight tx(s)...`);
      setTimeout(() => process.exit(0), 15000);
    } else {
      process.exit(0);
    }
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await run();
  const interval = setInterval(async () => {
    if (isShuttingDown) {
      clearInterval(interval);
      return;
    }
    await run();
  }, POLL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
