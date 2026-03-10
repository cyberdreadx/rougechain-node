#!/usr/bin/env npx tsx
/**
 * Bridge Relayer: Handles both ETH and XRGE bridge operations.
 *
 * ETH Bridge:  Polls pending withdrawals and sends ETH from custody.
 * XRGE Bridge: Polls pending XRGE withdrawals and calls vault.release().
 *
 * Env:
 *   CORE_API_URL               - RougeChain API (e.g. http://localhost:5101)
 *   BRIDGE_CUSTODY_PRIVATE_KEY - Private key of bridge wallet (0x-prefixed hex)
 *   BASE_SEPOLIA_RPC           - RPC URL (default: https://sepolia.base.org)
 *   XRGE_BRIDGE_VAULT          - BridgeVault contract address
 *   XRGE_CONTRACT_ADDRESS      - XRGE ERC-20 address (default: mainnet)
 *   POLL_INTERVAL_MS           - Poll interval (default: 5000)
 */

import { createWalletClient, createPublicClient, http, parseAbi, getContract } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const CORE_API_URL = process.env.CORE_API_URL || "http://localhost:5101";
const PRIVATE_KEY = process.env.BRIDGE_CUSTODY_PRIVATE_KEY;
const RPC_URL = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS || "5000", 10);
const VAULT_ADDRESS = process.env.XRGE_BRIDGE_VAULT;
const RELAYER_SECRET = process.env.BRIDGE_RELAYER_SECRET || "";

// In-memory set of tx_ids currently being processed to prevent double-sends on crash/restart races
const inFlightTxIds = new Set<string>();

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
const USDC_ADDRESS = process.env.USDC_ADDRESS || "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

// ── Helpers ─────────────────────────────────────────────────────

// qETH: 1 unit = 10^-6 ETH => wei = amount_units * 10^12
function unitsToWei(amountUnits: number): bigint {
  return BigInt(amountUnits) * 10n ** 12n;
}

// XRGE on L1 uses whole units; on EVM it's 18 decimals
function xrgeToWei(amount: number): bigint {
  return BigInt(amount) * 10n ** 18n;
}

// ── ETH withdraw types ──────────────────────────────────────────

interface EthWithdrawal {
  tx_id: string;
  evm_address: string;
  amount_units: number;
}

async function fetchEthWithdrawals(): Promise<EthWithdrawal[]> {
  const res = await fetch(`${CORE_API_URL}/api/bridge/withdrawals`);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const data = await res.json();
  return data.withdrawals || [];
}

async function fulfillEthWithdrawal(txId: string): Promise<boolean> {
  const res = await fetch(`${CORE_API_URL}/api/bridge/withdrawals/${encodeURIComponent(txId)}`, {
    method: "DELETE",
    headers: {
      "x-bridge-relayer-secret": RELAYER_SECRET,
      "Content-Type": "application/json",
    },
  });
  const data = await res.json().catch(() => ({}));
  return data.success === true;
}

// ── XRGE withdraw types ─────────────────────────────────────────

interface XrgeWithdrawal {
  tx_id: string;
  evm_address: string;
  amount: number;
}

async function fetchXrgeWithdrawals(): Promise<XrgeWithdrawal[]> {
  try {
    const res = await fetch(`${CORE_API_URL}/api/bridge/xrge/withdrawals`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.withdrawals || [];
  } catch {
    return [];
  }
}

async function fulfillXrgeWithdrawal(txId: string): Promise<boolean> {
  try {
    const res = await fetch(`${CORE_API_URL}/api/bridge/xrge/withdrawals/${encodeURIComponent(txId)}`, {
      method: "DELETE",
      headers: {
        "x-bridge-relayer-secret": RELAYER_SECRET,
        "Content-Type": "application/json",
      },
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

  const transport = http(RPC_URL);
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport,
  });
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport,
  });

  console.log(`[relayer] Started. Polling ${CORE_API_URL} every ${POLL_MS}ms`);
  console.log(`[relayer] Custody/Relayer: ${account.address}`);

  // Set up XRGE vault contract if configured
  let vaultContract: ReturnType<typeof getContract> | null = null;
  if (VAULT_ADDRESS) {
    vaultContract = getContract({
      address: VAULT_ADDRESS as `0x${string}`,
      abi: BRIDGE_VAULT_ABI,
      client: { public: publicClient, wallet: walletClient },
    });
    console.log(`[relayer] XRGE BridgeVault: ${VAULT_ADDRESS}`);
  } else {
    console.log("[relayer] No XRGE_BRIDGE_VAULT set — XRGE bridge disabled");
  }

  // Set up RougeBridge contract if configured
  let bridgeContract: ReturnType<typeof getContract> | null = null;
  if (ROUGE_BRIDGE_ADDRESS) {
    bridgeContract = getContract({
      address: ROUGE_BRIDGE_ADDRESS as `0x${string}`,
      abi: ROUGE_BRIDGE_ABI,
      client: { public: publicClient, wallet: walletClient },
    });
    console.log(`[relayer] RougeBridge contract: ${ROUGE_BRIDGE_ADDRESS}`);
  }

  // ── ETH bridge loop ───────────────────────────────────────────
  const processEthWithdrawals = async () => {
    try {
      const withdrawals = await fetchEthWithdrawals();
      if (withdrawals.length === 0) return;

      const balance = await publicClient.getBalance({ address: account.address });
      console.log(`[relayer/ETH] Pending: ${withdrawals.length}, Balance: ${(Number(balance) / 1e18).toFixed(6)} ETH`);

      for (const w of withdrawals) {
        if (inFlightTxIds.has(w.tx_id)) {
          console.log(`[relayer/ETH] Skipping ${w.tx_id} — already in flight`);
          continue;
        }
        inFlightTxIds.add(w.tx_id);

        try {
          const wei = unitsToWei(w.amount_units);
          let hash: `0x${string}`;

          if (bridgeContract) {
            const l1TxIdBytes = `0x${w.tx_id.padEnd(64, "0").slice(0, 64)}` as `0x${string}`;
            hash = await (bridgeContract as any).write.releaseETH([
              w.evm_address as `0x${string}`,
              wei,
              l1TxIdBytes,
            ]);
            console.log(`[relayer/ETH] Released via contract ${Number(wei) / 1e18} ETH to ${w.evm_address.slice(0, 10)}... tx: ${hash}`);
          } else {
            hash = await walletClient.sendTransaction({
              to: w.evm_address as `0x${string}`,
              value: wei,
              gas: 21000n,
            });
            console.log(`[relayer/ETH] Sent ${Number(wei) / 1e18} ETH to ${w.evm_address.slice(0, 10)}... tx: ${hash}`);
          }

          // Wait for on-chain confirmation before marking fulfilled
          const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
          if (receipt.status !== "success") {
            console.error(`[relayer/ETH] Tx reverted on-chain for ${w.tx_id}: ${hash}`);
            inFlightTxIds.delete(w.tx_id);
            continue;
          }

          const ok = await fulfillEthWithdrawal(w.tx_id);
          if (ok) console.log(`[relayer/ETH] Fulfilled ${w.tx_id}`);
          else console.warn(`[relayer/ETH] Failed to mark fulfilled: ${w.tx_id}`);
        } catch (e) {
          console.error(`[relayer/ETH] Tx failed for ${w.tx_id}:`, e);
          inFlightTxIds.delete(w.tx_id);
        }
      }
    } catch (e) {
      console.error("[relayer/ETH] Poll error:", e);
    }
  };

  // ── XRGE bridge loop ──────────────────────────────────────────
  const processXrgeWithdrawals = async () => {
    if (!vaultContract) return;

    try {
      const withdrawals = await fetchXrgeWithdrawals();
      if (withdrawals.length === 0) return;

      console.log(`[relayer/XRGE] Pending: ${withdrawals.length}`);

      for (const w of withdrawals) {
        if (inFlightTxIds.has(w.tx_id)) {
          console.log(`[relayer/XRGE] Skipping ${w.tx_id} — already in flight`);
          continue;
        }
        inFlightTxIds.add(w.tx_id);

        try {
          const weiAmount = xrgeToWei(w.amount);
          const hash = await (vaultContract as any).write.release([
            w.evm_address as `0x${string}`,
            weiAmount,
            w.tx_id,
          ]);
          console.log(`[relayer/XRGE] Released ${w.amount} XRGE to ${w.evm_address.slice(0, 10)}... tx: ${hash}`);

          const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
          if (receipt.status !== "success") {
            console.error(`[relayer/XRGE] Tx reverted on-chain for ${w.tx_id}: ${hash}`);
            inFlightTxIds.delete(w.tx_id);
            continue;
          }

          const ok = await fulfillXrgeWithdrawal(w.tx_id);
          if (ok) console.log(`[relayer/XRGE] Fulfilled ${w.tx_id}`);
          else console.warn(`[relayer/XRGE] Failed to mark fulfilled: ${w.tx_id}`);
        } catch (e) {
          console.error(`[relayer/XRGE] Release failed for ${w.tx_id}:`, e);
          inFlightTxIds.delete(w.tx_id);
        }
      }
    } catch (e) {
      console.error("[relayer/XRGE] Poll error:", e);
    }
  };

  // ── Combined polling ──────────────────────────────────────────
  const run = async () => {
    await Promise.all([processEthWithdrawals(), processXrgeWithdrawals()]);
  };

  await run();
  setInterval(run, POLL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
