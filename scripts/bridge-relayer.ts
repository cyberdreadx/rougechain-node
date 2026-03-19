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
  getContract,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// ── Config ──────────────────────────────────────────────────────

const CORE_API_URL = process.env.CORE_API_URL || "http://localhost:5101";
const PRIVATE_KEY = process.env.BRIDGE_CUSTODY_PRIVATE_KEY;
const BASE_CHAIN = (process.env.BASE_CHAIN || "sepolia").toLowerCase();
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS || "5000", 10);
const VAULT_ADDRESS = process.env.XRGE_BRIDGE_VAULT;
const RELAYER_SECRET = process.env.BRIDGE_RELAYER_SECRET || "";
const CONFIRMATIONS = parseInt(process.env.CONFIRMATIONS || "2", 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || "3", 10);

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

// ── State ───────────────────────────────────────────────────────

const processedTxIds = new Set<string>();  // Already fulfilled (persists across polls)
const inFlightTxIds = new Set<string>();   // Currently being processed
let currentNonce: number | null = null;    // Managed nonce
let isShuttingDown = false;

// Stats
const stats = {
  startTime: Date.now(),
  ethFulfilled: 0,
  xrgeFulfilled: 0,
  ethFailed: 0,
  xrgeFailed: 0,
  totalPolls: 0,
};

// ── ABIs ────────────────────────────────────────────────────────

const BRIDGE_VAULT_ABI = parseAbi([
  "function release(address to, uint256 amount, string l1TxId) external",
  "function totalLocked() external view returns (uint256)",
  "function vaultBalance() external view returns (uint256)",
]);

const ROUGE_BRIDGE_ABI = parseAbi([
  "function releaseETH(address to, uint256 amount, bytes32 l1TxId) external",
  "function releaseERC20(address token, address to, uint256 amount, bytes32 l1TxId) external",
]);

const ROUGE_BRIDGE_ADDRESS = process.env.ROUGE_BRIDGE_ADDRESS;

// ── Helpers ─────────────────────────────────────────────────────

function unitsToWei(amountUnits: number): bigint {
  return BigInt(amountUnits) * 10n ** 12n;
}

function xrgeToWei(amount: number): bigint {
  return BigInt(amount) * 10n ** 18n;
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

/** Get next nonce, managing it manually to avoid stuck txs. */
async function getNextNonce(publicClient: PublicClient, address: `0x${string}`): Promise<number> {
  if (currentNonce === null) {
    // Seed from on-chain
    currentNonce = await publicClient.getTransactionCount({ address, blockTag: "pending" });
    console.log(`[relayer] Seeded nonce from chain: ${currentNonce}`);
  }
  const nonce = currentNonce;
  currentNonce++;
  return nonce;
}

/** Reset nonce on failure (re-seed from chain next time). */
function resetNonce() {
  currentNonce = null;
}

// ── API calls ───────────────────────────────────────────────────

interface EthWithdrawal {
  tx_id: string;
  evm_address: string;
  amount_units: number;
}

interface XrgeWithdrawal {
  tx_id: string;
  evm_address: string;
  amount: number;
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
      client: { public: publicClient, wallet: walletClient },
    });
    console.log(`[relayer] XRGE BridgeVault: ${VAULT_ADDRESS}`);
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

  // ── ETH withdrawals ─────────────────────────────────────────

  const processEthWithdrawals = async () => {
    try {
      const withdrawals = await fetchEthWithdrawals();
      if (withdrawals.length === 0) return;

      const balance = await publicClient.getBalance({ address: account.address });
      console.log(`[ETH] Pending: ${withdrawals.length}, Balance: ${(Number(balance) / 1e18).toFixed(6)} ETH`);

      for (const w of withdrawals) {
        if (isShuttingDown) break;
        if (processedTxIds.has(w.tx_id) || inFlightTxIds.has(w.tx_id)) continue;
        inFlightTxIds.add(w.tx_id);

        try {
          const wei = unitsToWei(w.amount_units);
          const nonce = await getNextNonce(publicClient, account.address);

          const hash = await withRetry(`ETH-${w.tx_id.slice(0, 8)}`, async () => {
            if (bridgeContract) {
              const l1TxIdBytes = `0x${w.tx_id.padEnd(64, "0").slice(0, 64)}` as `0x${string}`;
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
            resetNonce();
            inFlightTxIds.delete(w.tx_id);
            continue;
          }

          const ok = await fulfillEthWithdrawal(w.tx_id, hash);
          if (ok) {
            console.log(`[ETH] ✓ Fulfilled ${w.tx_id} (${hash})`);
            processedTxIds.add(w.tx_id);
            stats.ethFulfilled++;
          } else {
            console.warn(`[ETH] ✗ Fulfill API failed: ${w.tx_id}`);
          }
        } catch (e: any) {
          console.error(`[ETH] Failed ${w.tx_id}: ${e.message}`);
          stats.ethFailed++;
          resetNonce();
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

      for (const w of withdrawals) {
        if (isShuttingDown) break;
        if (processedTxIds.has(w.tx_id) || inFlightTxIds.has(w.tx_id)) continue;
        inFlightTxIds.add(w.tx_id);

        try {
          const weiAmount = xrgeToWei(w.amount);
          const nonce = await getNextNonce(publicClient, account.address);

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
            stats.xrgeFailed++;
            resetNonce();
            inFlightTxIds.delete(w.tx_id);
            continue;
          }

          const ok = await fulfillXrgeWithdrawal(w.tx_id, hash);
          if (ok) {
            console.log(`[XRGE] ✓ Fulfilled ${w.tx_id} (${hash})`);
            processedTxIds.add(w.tx_id);
            stats.xrgeFulfilled++;
          } else {
            console.warn(`[XRGE] ✗ Fulfill API failed: ${w.tx_id}`);
          }
        } catch (e: any) {
          console.error(`[XRGE] Failed ${w.tx_id}: ${e.message}`);
          stats.xrgeFailed++;
          resetNonce();
        } finally {
          inFlightTxIds.delete(w.tx_id);
        }
      }
    } catch (e: any) {
      console.error("[XRGE] Poll error:", e.message);
    }
  };

  // ── Polling loop ──────────────────────────────────────────────

  const run = async () => {
    stats.totalPolls++;
    await Promise.all([processEthWithdrawals(), processXrgeWithdrawals()]);

    // Health log every 60 polls
    if (stats.totalPolls % 60 === 0) {
      console.log(
        `[health] uptime=${uptimeStr()} polls=${stats.totalPolls} ` +
        `eth_ok=${stats.ethFulfilled} eth_fail=${stats.ethFailed} ` +
        `xrge_ok=${stats.xrgeFulfilled} xrge_fail=${stats.xrgeFailed} ` +
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
