#!/usr/bin/env npx tsx
/**
 * RougeChain Bridge Relayer v2 — Production-Hardened
 *
 * Features:
 *   ✓ Multi-chain support (Base Mainnet + Sepolia)
 *   ✓ Nonce management (manual tracking, no stuck txs)
 *   ✓ Retry with exponential backoff (3 attempts)
 *   ✓ Gas estimation (no hardcoded gas limits)
 *   ✓ Double-spend protection (processed tx set)
 *   ✓ Graceful shutdown (SIGTERM/SIGINT)
 *   ✓ Health logging with uptime and stats
 *   ✓ Configurable confirmation count
 *
 * Env:
 *   CORE_API_URL               - RougeChain API (e.g. https://testnet.rougechain.io)
 *   BRIDGE_CUSTODY_PRIVATE_KEY - Private key (0x-prefixed hex)
 *   BASE_RPC_URL               - RPC URL (auto-set if BASE_CHAIN is specified)
 *   BASE_CHAIN                 - "mainnet" or "sepolia" (default: sepolia)
 *   XRGE_BRIDGE_VAULT          - BridgeVault contract address
 *   BRIDGE_RELAYER_SECRET      - Secret for fulfillment auth
 *   POLL_INTERVAL_MS           - Poll interval (default: 5000)
 *   CONFIRMATIONS              - Blocks to wait for tx confirmation (default: 2)
 *   MAX_RETRIES                - Max retries per withdrawal (default: 3)
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  parseAbiItem,
  getContract,
  keccak256,
  toBytes,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

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
// Optional webhook (e.g. Slack/Discord incoming webhook) for failure alerts.
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || "";
// Auto-refund a withdrawal once the daemon reports it has crossed the failure threshold.
const AUTO_REFUND = (process.env.AUTO_REFUND || "true").toLowerCase() !== "false";
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
  try {
    writeFileSync(PROCESSED_FILE, JSON.stringify([...ids]), "utf-8");
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

const ROUGE_BRIDGE_ABI = parseAbi([
  "function releaseETH(address to, uint256 amount, bytes32 l1TxId) external",
  "function releaseERC20(address token, address to, uint256 amount, bytes32 l1TxId) external",
]);

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

function unitsToWei(amountUnits: number): bigint {
  return BigInt(amountUnits) * 10n ** 12n;
}

function xrgeToWei(amount: number): bigint {
  return BigInt(amount) * 10n ** 18n;
}

/** Scan recent vault BridgeRelease events for the tx that released a given L1 tx id. */
async function findReleaseTxForL1(
  publicClient: any,
  vaultAddress: `0x${string}`,
  l1TxId: string,
): Promise<`0x${string}` | null> {
  try {
    const latest = await publicClient.getBlockNumber();
    const WINDOW = 5000n;
    for (let i = 0n; i < 12n; i++) {
      const toBlock = latest - i * WINDOW;
      if (toBlock < 0n) break;
      const fromBlock = toBlock > WINDOW ? toBlock - WINDOW + 1n : 0n;
      const logs = await publicClient.getLogs({
        address: vaultAddress,
        event: BRIDGE_RELEASE_EVENT,
        fromBlock,
        toBlock,
      });
      for (const lg of logs) {
        if ((lg as any).args?.l1TxId === l1TxId) return lg.transactionHash as `0x${string}`;
      }
      if (fromBlock === 0n) break;
    }
  } catch (e: any) {
    console.warn(`[XRGE] release-log scan failed for ${l1TxId}: ${e.message}`);
  }
  return null;
}

/**
 * On-chain truth check + reconciliation for XRGE releases. The vault's release() is
 * idempotent (reverts AlreadyProcessed on a duplicate), so a release that mined but whose
 * receipt we lost looks like a "failure" to the naive path — which previously cascaded into
 * an auto-refund and paid the user on BOTH chains. Before EVER treating an XRGE release as
 * failed, ask the vault whether this l1TxId is already processed; if so, fulfill it against
 * the real BridgeRelease tx and return true so the caller skips failure/refund entirely.
 * Returns false when the release genuinely did not happen (safe to fail/refund) or when the
 * check itself failed (the daemon refund guard is the authoritative backstop either way).
 */
async function reconcileXrgeIfReleased(
  publicClient: any,
  vaultAddress: `0x${string}`,
  w: { tx_id: string; evm_address: string; amount: number },
): Promise<boolean> {
  let processed = false;
  try {
    processed = (await publicClient.readContract({
      address: vaultAddress,
      abi: BRIDGE_VAULT_ABI,
      functionName: "processedL1Txs",
      args: [w.tx_id],
    })) as boolean;
  } catch (e: any) {
    console.warn(`[XRGE] reconcile read failed for ${w.tx_id}: ${e.message}`);
    return false; // cannot confirm — let normal handling proceed; daemon guard still protects
  }
  if (!processed) return false;

  const relTx = await findReleaseTxForL1(publicClient, vaultAddress, w.tx_id);
  if (relTx) {
    const ok = await fulfillXrgeWithdrawal(w.tx_id, relTx);
    if (ok) {
      console.log(`[XRGE] ✓ Reconciled ${w.tx_id}: already released, fulfilled via ${relTx}`);
      processedTxIds.add(w.tx_id);
      saveProcessedTxIds(processedTxIds);
      stats.xrgeFulfilled++;
    } else {
      console.warn(`[XRGE] ✗ Reconcile: fulfill API rejected ${w.tx_id} (${relTx})`);
    }
  } else {
    await alert(
      `reconcile:${w.tx_id}`,
      `XRGE ${w.tx_id.slice(0, 16)}… is processed on-chain but no BridgeRelease found in scan — MANUAL REVIEW, NOT refunding`,
    );
  }
  return true; // handled — caller must NOT report failure or refund
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

interface EthWithdrawal {
  txId?: string;
  tx_id?: string;
  evmAddress?: string;
  evm_address?: string;
  amountUnits?: number;
  amount_units?: number;
}

interface XrgeWithdrawal {
  txId?: string;
  tx_id?: string;
  evmAddress?: string;
  evm_address?: string;
  amount: number;
}

/** Normalize a withdrawal from either camelCase or snake_case API response */
function normalizeEthWithdrawal(w: EthWithdrawal): { tx_id: string; evm_address: string; amount_units: number } {
  return {
    tx_id: w.txId || w.tx_id || "",
    evm_address: w.evmAddress || w.evm_address || "",
    amount_units: w.amountUnits || w.amount_units || 0,
  };
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
  const data = await res.json();
  return data.withdrawals || [];
}

async function fulfillEthWithdrawal(txId: string, evmTxHash: string): Promise<boolean> {
  const res = await fetch(`${CORE_API_URL}/api/bridge/withdrawals/${encodeURIComponent(txId)}`, {
    method: "DELETE",
    headers: {
      "x-bridge-relayer-secret": RELAYER_SECRET,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ evmTxHash }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  return data.success === true;
}

async function fetchXrgeWithdrawals(): Promise<XrgeWithdrawal[]> {
  try {
    const res = await fetch(`${CORE_API_URL}/api/bridge/xrge/withdrawals`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.withdrawals || [];
  } catch {
    return [];
  }
}

async function fulfillXrgeWithdrawal(txId: string, evmTxHash: string): Promise<boolean> {
  try {
    const res = await fetch(`${CORE_API_URL}/api/bridge/xrge/withdrawals/${encodeURIComponent(txId)}`, {
      method: "DELETE",
      headers: {
        "x-bridge-relayer-secret": RELAYER_SECRET,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ evmTxHash }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => ({}));
    return data.success === true;
  } catch {
    return false;
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
    const data = await res.json().catch(() => ({}));
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
    const data = await res.json().catch(() => ({}));
    if (data.success === true) return { ok: true };
    return { ok: false, error: data.error || "unknown" };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/** Ask the daemon to refund a withdrawal (re-mint burned tokens to the owner). */
async function refundWithdrawal(txId: string): Promise<boolean> {
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
    const data = await res.json().catch(() => ({}));
    if (data.success === true) return true;
    console.warn(`[relayer] Refund API declined for ${txId}: ${data.error || "unknown"}`);
    return false;
  } catch (e: any) {
    console.warn(`[relayer] Refund request failed for ${txId}: ${e.message}`);
    return false;
  }
}

/**
 * Common failure handling: report the failure to the daemon, alert on repeated
 * failure, and auto-refund once the daemon says the threshold is crossed.
 */
async function handleWithdrawalFailure(kind: "ETH" | "XRGE", txId: string, error: string): Promise<void> {
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
      if (kind === "ETH") stats.ethRefunded++;
      else stats.xrgeRefunded++;
    }
  }
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
  const walletClient = createWalletClient({ account, chain: chainCfg.chain, transport });

  // Dedicated XRGE-release signer (BridgeVaultV2 role split). Falls back to the custody
  // key when XRGE_RELAYER_PRIVATE_KEY is unset, so V1 / single-key setups are unchanged.
  const xrgeAccount = XRGE_RELAYER_KEY?.trim()
    ? privateKeyToAccount((XRGE_RELAYER_KEY.startsWith("0x") ? XRGE_RELAYER_KEY : `0x${XRGE_RELAYER_KEY}`) as `0x${string}`)
    : account;
  const xrgeWalletClient = xrgeAccount === account
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
      client: { public: publicClient, wallet: xrgeWalletClient },
    });
    console.log(`[relayer] XRGE BridgeVault: ${VAULT_ADDRESS} (release signer: ${xrgeAccount.address}${xrgeAccount === account ? " = custody key" : " = dedicated XRGE key"})`);
  } else {
    console.log("[relayer] No XRGE_BRIDGE_VAULT — XRGE bridge disabled");
  }

  // RougeBridge contract
  let bridgeContract: ReturnType<typeof getContract> | null = null;
  if (ROUGE_BRIDGE_ADDRESS) {
    bridgeContract = getContract({
      address: ROUGE_BRIDGE_ADDRESS as `0x${string}`,
      abi: ROUGE_BRIDGE_ABI,
      client: { public: publicClient, wallet: walletClient },
    });
    console.log(`[relayer] RougeBridge: ${ROUGE_BRIDGE_ADDRESS}`);
  }

  if (DEPOSIT_WATCHER && (ROUGE_BRIDGE_ADDRESS || VAULT_ADDRESS)) {
    const resume = depositWatcher.lastBlock !== null ? `resuming from block ${depositWatcher.lastBlock}` : "anchoring at chain head";
    console.log(`[relayer] Deposit watcher: ENABLED (${resume}, ${depositWatcher.pending.size} pending)`);
  } else {
    console.log("[relayer] Deposit watcher: disabled");
  }

  // ── ETH withdrawals ─────────────────────────────────────────

  const processEthWithdrawals = async () => {
    try {
      const withdrawals = await fetchEthWithdrawals();
      if (withdrawals.length === 0) return;

      const balance = await publicClient.getBalance({ address: account.address });
      console.log(`[ETH] Pending: ${withdrawals.length}, Balance: ${(Number(balance) / 1e18).toFixed(6)} ETH`);

      for (const raw of withdrawals) {
        const w = normalizeEthWithdrawal(raw);
        if (isShuttingDown) break;
        if (processedTxIds.has(w.tx_id) || inFlightTxIds.has(w.tx_id)) continue;
        inFlightTxIds.add(w.tx_id);

        try {
          const wei = unitsToWei(w.amount_units);
          const nonce = await getNextNonce(publicClient, account.address);

          const hash = await withRetry(`ETH-${w.tx_id.slice(0, 8)}`, async () => {
            if (bridgeContract) {
              const l1TxIdBytes = keccak256(toBytes(w.tx_id));
              return await (bridgeContract as any).write.releaseETH([
                w.evm_address as `0x${string}`,
                wei,
                l1TxIdBytes,
              ], { nonce });
            } else {
              // Estimate gas instead of hardcoding
              const gas = await publicClient.estimateGas({
                account: account.address,
                to: w.evm_address as `0x${string}`,
                value: wei,
              });
              return await walletClient.sendTransaction({
                to: w.evm_address as `0x${string}`,
                value: wei,
                gas: gas + (gas / 10n), // 10% buffer
                nonce,
              });
            }
          });

          console.log(`[ETH] Sent ${Number(wei) / 1e18} ETH → ${w.evm_address.slice(0, 10)}... tx: ${hash}`);

          const receipt = await publicClient.waitForTransactionReceipt({
            hash,
            confirmations: CONFIRMATIONS,
            timeout: 120_000,
          });

          if (receipt.status !== "success") {
            console.error(`[ETH] Tx REVERTED for ${w.tx_id}: ${hash}`);
            stats.ethFailed++;
            resetNonce(account.address);
            await handleWithdrawalFailure("ETH", w.tx_id, `release tx reverted: ${hash}`);
            inFlightTxIds.delete(w.tx_id);
            continue;
          }

          const ok = await fulfillEthWithdrawal(w.tx_id, hash);
          if (ok) {
            console.log(`[ETH] ✓ Fulfilled ${w.tx_id} (${hash})`);
            processedTxIds.add(w.tx_id);
            saveProcessedTxIds(processedTxIds);
            stats.ethFulfilled++;
          } else {
            console.warn(`[ETH] ✗ Fulfill API failed: ${w.tx_id}`);
          }
        } catch (e: any) {
          console.error(`[ETH] Failed ${w.tx_id}: ${e.message}`);
          stats.ethFailed++;
          resetNonce(account.address);
          await handleWithdrawalFailure("ETH", w.tx_id, e.message || "release failed");
        } finally {
          inFlightTxIds.delete(w.tx_id);
        }
      }
    } catch (e: any) {
      console.error("[ETH] Poll error:", e.message);
    }
  };

  // ── XRGE withdrawals ────────────────────────────────────────

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
        inFlightTxIds.add(w.tx_id);

        try {
          const weiAmount = xrgeToWei(w.amount);
          const nonce = await getNextNonce(publicClient, xrgeAccount.address);

          const hash = await withRetry(`XRGE-${w.tx_id.slice(0, 8)}`, async () => {
            return await (vaultContract as any).write.release([
              w.evm_address as `0x${string}`,
              weiAmount,
              w.tx_id,
            ], { nonce });
          });

          console.log(`[XRGE] Released ${w.amount} XRGE → ${w.evm_address.slice(0, 10)}... tx: ${hash}`);

          const receipt = await publicClient.waitForTransactionReceipt({
            hash,
            confirmations: CONFIRMATIONS,
            timeout: 120_000,
          });

          if (receipt.status !== "success") {
            console.error(`[XRGE] Tx REVERTED for ${w.tx_id}: ${hash}`);
            resetNonce(xrgeAccount.address);
            // A revert may just mean a PRIOR release already settled this l1TxId
            // (AlreadyProcessed). Reconcile against on-chain truth before ever
            // reporting failure — never refund an already-paid withdrawal.
            if (await reconcileXrgeIfReleased(publicClient, VAULT_ADDRESS as `0x${string}`, w)) {
              continue;
            }
            stats.xrgeFailed++;
            await handleWithdrawalFailure("XRGE", w.tx_id, `release tx reverted: ${hash}`);
            continue;
          }

          const ok = await fulfillXrgeWithdrawal(w.tx_id, hash);
          if (ok) {
            console.log(`[XRGE] ✓ Fulfilled ${w.tx_id} (${hash})`);
            processedTxIds.add(w.tx_id);
            saveProcessedTxIds(processedTxIds);
            stats.xrgeFulfilled++;
          } else {
            console.warn(`[XRGE] ✗ Fulfill API failed: ${w.tx_id}`);
          }
        } catch (e: any) {
          console.error(`[XRGE] Failed ${w.tx_id}: ${e.message}`);
          resetNonce(xrgeAccount.address);
          // The most common cause here is a release that mined but whose receipt we lost:
          // the retry reverts AlreadyProcessed and throws. Treat an already-processed
          // l1TxId as SUCCESS (fulfill it), never as a failure that could trigger a refund.
          if (await reconcileXrgeIfReleased(publicClient, VAULT_ADDRESS as `0x${string}`, w)) {
            continue;
          }
          stats.xrgeFailed++;
          await handleWithdrawalFailure("XRGE", w.tx_id, e.message || "release failed");
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
      const head = await publicClient.getBlockNumber();
      const safeHead = head - BigInt(CONFIRMATIONS);
      if (safeHead <= 0n) return;

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
    await Promise.all([processEthWithdrawals(), processXrgeWithdrawals(), processDeposits()]);

    // Health log every 60 polls
    if (stats.totalPolls % 60 === 0) {
      console.log(
        `[health] uptime=${uptimeStr()} polls=${stats.totalPolls} ` +
        `eth_ok=${stats.ethFulfilled} eth_fail=${stats.ethFailed} ` +
        `xrge_ok=${stats.xrgeFulfilled} xrge_fail=${stats.xrgeFailed} ` +
        `refunded=${stats.ethRefunded + stats.xrgeRefunded} alerts=${stats.alertsSent} ` +
        `deposits_ok=${stats.depositsClaimed} deposits_pending=${depositWatcher.pending.size} ` +
        `processed=${processedTxIds.size} inflight=${inFlightTxIds.size}`
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
