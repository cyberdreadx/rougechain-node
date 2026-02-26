#!/usr/bin/env npx tsx
/**
 * Bridge Relayer: Polls pending withdrawals and sends ETH from custody to users.
 *
 * Env:
 *   CORE_API_URL            - RougeChain API (e.g. http://localhost:5101)
 *   BRIDGE_CUSTODY_PRIVATE_KEY - Private key of wallet holding ETH (0x-prefixed hex)
 *   BASE_SEPOLIA_RPC        - RPC URL (default: https://sepolia.base.org)
 *   POLL_INTERVAL_MS        - Poll interval (default: 15000)
 */

import { createWalletClient, createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const CORE_API_URL = process.env.CORE_API_URL || "http://localhost:5101";
const PRIVATE_KEY = process.env.BRIDGE_CUSTODY_PRIVATE_KEY;
const RPC_URL = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS || "5000", 10);

// qETH: 1 unit = 10^-6 ETH => wei = amount_units * 10^12
function unitsToWei(amountUnits: number): bigint {
  return BigInt(amountUnits) * 10n ** 12n;
}

async function fetchWithdrawals(): Promise<
  { tx_id: string; evm_address: string; amount_units: number }[]
> {
  const res = await fetch(`${CORE_API_URL}/api/bridge/withdrawals`);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const data = await res.json();
  return data.withdrawals || [];
}

async function fulfillWithdrawal(txId: string): Promise<boolean> {
  const res = await fetch(`${CORE_API_URL}/api/bridge/withdrawals/${encodeURIComponent(txId)}`, {
    method: "DELETE",
  });
  const data = await res.json().catch(() => ({}));
  return data.success === true;
}

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

  if (!walletClient) {
    console.error("Failed to create wallet client");
    process.exit(1);
  }

  console.log(`[relayer] Started. Polling ${CORE_API_URL} every ${POLL_MS}ms`);
  console.log(`[relayer] Custody: ${account.address}`);

  const run = async () => {
    try {
      const withdrawals = await fetchWithdrawals();
      if (withdrawals.length === 0) return;

      const balance = await publicClient.getBalance({ address: account.address });
      const nonce = await publicClient.getTransactionCount({
        address: account.address,
        blockTag: "pending",
      });
      console.log(`[relayer] Pending: ${withdrawals.length}, Balance: ${(Number(balance) / 1e18).toFixed(6)} ETH`);

      // Filter to what we can afford (reserve ~0.0001 ETH for gas)
      const gasReserve = 100n * 21000n * 2n; // ~21000 gas * 2 gwei * 100 txs
      let remaining = balance - gasReserve;
      const affordable: { w: typeof withdrawals[0]; wei: bigint; i: number }[] = [];
      for (let i = 0; i < withdrawals.length && remaining > 0n; i++) {
        const w = withdrawals[i];
        const wei = unitsToWei(w.amount_units);
        if (wei <= remaining) {
          affordable.push({ w, wei, i });
          remaining -= wei;
        } else {
          console.warn(`[relayer] Skipping ${w.tx_id} (need ${Number(wei) / 1e18} ETH, have ${Number(remaining) / 1e18})`);
        }
      }

      // Send affordable withdrawals in parallel with explicit nonces
      const results = await Promise.allSettled(
        affordable.map(async ({ w, wei }, idx) => {
          const hash = await walletClient.sendTransaction({
            to: w.evm_address as `0x${string}`,
            value: wei,
            gas: 21000n,
            nonce: nonce + BigInt(idx),
          });
          console.log(`[relayer] Sent ${Number(wei) / 1e18} ETH to ${w.evm_address.slice(0, 10)}... tx: ${hash}`);
          const ok = await fulfillWithdrawal(w.tx_id);
          if (ok) {
            console.log(`[relayer] Fulfilled ${w.tx_id}`);
          } else {
            console.warn(`[relayer] Failed to mark fulfilled: ${w.tx_id}`);
          }
        })
      );
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          console.error(`[relayer] Tx failed for ${affordable[i]?.w.tx_id}:`, r.reason);
        }
      });
    } catch (e) {
      console.error("[relayer] Poll error:", e);
    }
  };

  await run();
  setInterval(run, POLL_MS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
