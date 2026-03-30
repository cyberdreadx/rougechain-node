#!/usr/bin/env node
/**
 * RougeChain Stress Test
 * 
 * Hammers the chain with parallel transactions to measure:
 *   - Transactions per second (TPS)
 *   - Block capacity
 *   - Error rate under load
 *   - Latency distribution
 *
 * Usage:
 *   node sdk/stress-test.mjs                          # defaults: 50 txs, 10 concurrency
 *   node sdk/stress-test.mjs --txs 200 --concurrency 20
 *   node sdk/stress-test.mjs --target https://testnet.rougechain.io/api
 */

function getArg(name, fallback) {
  const args = process.argv.slice(2);
  const eqForm = args.find(a => a.startsWith(`--${name}=`));
  if (eqForm) return eqForm.split("=")[1];
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return fallback;
}

const BASE = getArg("target", "https://testnet.rougechain.io/api");
const TOTAL_TXS = parseInt(getArg("txs", "50"));
const CONCURRENCY = parseInt(getArg("concurrency", "10"));
const BATCH_SIZE = parseInt(getArg("batch", "0"));  // 0 = no batching

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get(path, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${BASE}${path}`);
      const text = await res.text();
      return JSON.parse(text);
    } catch {
      if (i < retries - 1) await new Promise(r => setTimeout(r, 2000));
    }
  }
  return {};
}

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─── Wallet keygen via @noble/post-quantum ─────────────────────────────────────

import { createRequire } from "module";
let ml_dsa65;
try {
  const mod = await import("@noble/post-quantum/ml-dsa.js");
  ml_dsa65 = mod.ml_dsa65;
} catch {
  try {
    const require = createRequire(import.meta.url);
    const mod = require("@noble/post-quantum/ml-dsa.js");
    ml_dsa65 = mod.ml_dsa65;
  } catch {
    console.error("❌ Cannot import @noble/post-quantum. Run: npm install @noble/post-quantum");
    process.exit(1);
  }
}

function bytesToHex(uint8) {
  return [...uint8].map(b => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function generateWallet() {
  const keypair = ml_dsa65.keygen();
  return {
    publicKey: bytesToHex(keypair.publicKey),
    privateKey: bytesToHex(keypair.secretKey),
  };
}

// ─── SDK-compatible signing (must match sortKeysDeep from sdk/src/signer.ts) ──

function sortKeysDeep(obj) {
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  if (obj !== null && typeof obj === "object") {
    const sorted = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysDeep(obj[key]);
    }
    return sorted;
  }
  return obj;
}

function serializePayload(payload) {
  return new TextEncoder().encode(JSON.stringify(sortKeysDeep(payload)));
}

function signTransaction(payload, privateKey, publicKey) {
  // Server does: serde_json::to_string(&req.payload) to get verification bytes
  // serde_json preserves key order from original JSON parse.
  // So we sort keys, stringify, sign those bytes, and send payload as object (not string).
  const sorted = sortKeysDeep(payload);
  const payloadJson = JSON.stringify(sorted);
  const payloadBytes = new TextEncoder().encode(payloadJson);
  const sig = ml_dsa65.sign(payloadBytes, hexToBytes(privateKey));
  return {
    payload: sorted,           // sent as JSON object, not string
    signature: bytesToHex(sig),
    public_key: publicKey,
  };
}

let _nonceCounter = Date.now() * 1000;
function generateNonce() {
  return ++_nonceCounter;
}

function createSignedTransfer(wallet, to, amount, fee, token) {
  const payload = {
    type: "transfer",
    from: wallet.publicKey,
    to: to,
    amount: amount,
    fee: fee || 0.1,
    token: token || "XRGE",
    nonce: generateNonce(),
    timestamp: Date.now(),
  };
  return signTransaction(payload, wallet.privateKey, wallet.publicKey);
}

function createSignedFaucet(wallet) {
  const payload = {
    type: "faucet",
    from: wallet.publicKey,
    nonce: generateNonce(),
    timestamp: Date.now(),
  };
  return signTransaction(payload, wallet.privateKey, wallet.publicKey);
}

// ─── Stress Test ───────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║     RougeChain Stress Test               ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`  Target:      ${BASE}`);
  console.log(`  Total TXs:   ${TOTAL_TXS}`);
  console.log(`  Concurrency: ${CONCURRENCY}`);
  if (BATCH_SIZE > 0) console.log(`  Batch size:  ${BATCH_SIZE}`);
  console.log();

  // 1. Check chain health
  console.log("📡 Checking chain health...");
  const stats = await get("/stats");
  console.log(`   Height: ${stats.network_height} | Mining: ${stats.is_mining} | Peers: ${stats.connected_peers}`);
  if (!stats.is_mining) {
    console.error("❌ Chain is not mining! Stress test requires active mining.");
    process.exit(1);
  }
  console.log();

  // 2. Generate sender + receiver wallets
  console.log("🔑 Generating wallets...");
  const sender = generateWallet();
  const receiver = generateWallet();
  console.log(`   Sender:   ${sender.publicKey.slice(0, 20)}...`);
  console.log(`   Receiver: ${receiver.publicKey.slice(0, 20)}...`);
  console.log();

  // 3. Fund sender from faucet
  console.log("💧 Requesting faucet...");
  const faucetTx = createSignedFaucet(sender);
  const faucetResult = await post("/v2/faucet", faucetTx);
  if (faucetResult.success) {
    console.log("   ✅ Faucet funded sender");
  } else {
    console.log(`   ⚠️  Faucet: ${faucetResult.error || JSON.stringify(faucetResult)}`);
    console.log("   Continuing anyway (sender may already have balance)...");
  }

  // Wait for faucet tx to be mined
  console.log("   ⏳ Waiting for faucet to be mined (3s)...");
  await new Promise(r => setTimeout(r, 3000));

  // Check balance
  const balRes = await get(`/balance/${sender.publicKey}`);
  const senderBalance = balRes.balance ?? 0;
  console.log(`   Sender balance: ${senderBalance} XRGE`);
  if (senderBalance < TOTAL_TXS * 1.1) {
    console.log("   ⚠️  Balance may be too low for all txs. Some will fail intentionally.");
  }
  console.log();

  // 4. Flood transactions
  const mode = BATCH_SIZE > 0 ? `batch(${BATCH_SIZE})` : `individual`;
  console.log(`🚀 Sending ${TOTAL_TXS} transfers (${CONCURRENCY} concurrent, ${mode})...`);
  console.log("   ─".repeat(25));

  const results = { success: 0, failed: 0, errors: {} };
  const latencies = [];
  const startTime = performance.now();

  let active = 0;
  let completed = 0;

  function logProgress() {
    if (completed % 10 === 0 || completed === TOTAL_TXS) {
      const elapsed = (performance.now() - startTime) / 1000;
      const tps = completed / elapsed;
      process.stdout.write(
        `\r   Progress: ${completed}/${TOTAL_TXS} | TPS: ${tps.toFixed(1)} | ✅ ${results.success} ❌ ${results.failed}`
      );
    }
  }

  // Pre-sign all transactions upfront so signing time doesn't count
  const allSigned = [];
  for (let i = 0; i < TOTAL_TXS; i++) {
    allSigned.push(createSignedTransfer(sender, receiver.publicKey, 0.01, 0.1, "XRGE"));
  }

  if (BATCH_SIZE > 0) {
    // Batch mode: send groups of TXs in single requests
    const batches = [];
    for (let i = 0; i < allSigned.length; i += BATCH_SIZE) {
      batches.push(allSigned.slice(i, i + BATCH_SIZE));
    }

    const promises = [];
    for (const batch of batches) {
      while (active >= CONCURRENCY) {
        await new Promise(r => setTimeout(r, 5));
      }
      active++;
      const batchStart = performance.now();
      const p = post("/v2/batch-submit", batch)
        .then(res => {
          const latency = performance.now() - batchStart;
          if (res.results) {
            for (const r of res.results) {
              latencies.push(latency);
              completed++;
              if (r?.success) { results.success++; }
              else {
                results.failed++;
                const errKey = r?.error?.slice(0, 50) || "unknown";
                results.errors[errKey] = (results.errors[errKey] || 0) + 1;
              }
            }
          } else {
            for (let j = 0; j < batch.length; j++) {
              completed++;
              results.failed++;
              latencies.push(latency);
            }
            const errKey = res.error?.slice(0, 50) || "batch_error";
            results.errors[errKey] = (results.errors[errKey] || 0) + batch.length;
          }
          logProgress();
        })
        .catch(e => {
          const latency = performance.now() - batchStart;
          for (let j = 0; j < batch.length; j++) {
            completed++;
            results.failed++;
            latencies.push(latency);
          }
          const errKey = e.message?.slice(0, 50) || "network_error";
          results.errors[errKey] = (results.errors[errKey] || 0) + batch.length;
          logProgress();
        })
        .finally(() => active--);
      promises.push(p);
    }
    await Promise.all(promises);
  } else {
    // Individual mode (original behavior)
    async function sendOne(index) {
      const txStart = performance.now();
      try {
        const res = await post("/v2/transfer", allSigned[index]);
        const latency = performance.now() - txStart;
        latencies.push(latency);
        if (res.success) { results.success++; }
        else {
          results.failed++;
          const errKey = res.error?.slice(0, 50) || "unknown";
          results.errors[errKey] = (results.errors[errKey] || 0) + 1;
        }
      } catch (e) {
        results.failed++;
        const errKey = e.message?.slice(0, 50) || "network_error";
        results.errors[errKey] = (results.errors[errKey] || 0) + 1;
        latencies.push(performance.now() - txStart);
      }
      completed++;
      logProgress();
    }

    const promises = [];
    for (let i = 0; i < TOTAL_TXS; i++) {
      while (active >= CONCURRENCY) {
        await new Promise(r => setTimeout(r, 5));
      }
      active++;
      const p = sendOne(i).finally(() => active--);
      promises.push(p);
    }
    await Promise.all(promises);
  }

  const totalElapsed = (performance.now() - startTime) / 1000;
  console.log("\n");

  // 5. Wait for blocks to be mined, then check final state
  console.log("⏳ Waiting for blocks to settle (5s)...");
  await new Promise(r => setTimeout(r, 5000));
  const finalStats = await get("/stats");
  const blocksProduced = finalStats.network_height - stats.network_height;

  // 6. Calculate results
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
  const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length || 0;

  console.log("╔══════════════════════════════════════════╗");
  console.log("║           STRESS TEST RESULTS            ║");
  console.log("╠══════════════════════════════════════════╣");
  console.log(`║  Total transactions:  ${TOTAL_TXS.toString().padStart(18)} ║`);
  console.log(`║  Successful:          ${results.success.toString().padStart(18)} ║`);
  console.log(`║  Failed:              ${results.failed.toString().padStart(18)} ║`);
  console.log(`║  Success rate:        ${((results.success / TOTAL_TXS) * 100).toFixed(1).padStart(17)}% ║`);
  console.log(`║  ──────────────────────────────────────── ║`);
  console.log(`║  Elapsed time:        ${totalElapsed.toFixed(2).padStart(17)}s ║`);
  console.log(`║  Effective TPS:       ${(results.success / totalElapsed).toFixed(1).padStart(18)} ║`);
  console.log(`║  Submit TPS:          ${(TOTAL_TXS / totalElapsed).toFixed(1).padStart(18)} ║`);
  console.log(`║  ──────────────────────────────────────── ║`);
  console.log(`║  Blocks produced:     ${blocksProduced.toString().padStart(18)} ║`);
  console.log(`║  Avg TXs/block:       ${blocksProduced > 0 ? (results.success / blocksProduced).toFixed(1).padStart(18) : "N/A".padStart(18)} ║`);
  console.log(`║  ──────────────────────────────────────── ║`);
  console.log(`║  Latency p50:         ${p50.toFixed(0).padStart(16)}ms ║`);
  console.log(`║  Latency p95:         ${p95.toFixed(0).padStart(16)}ms ║`);
  console.log(`║  Latency p99:         ${p99.toFixed(0).padStart(16)}ms ║`);
  console.log(`║  Latency avg:         ${avgLatency.toFixed(0).padStart(16)}ms ║`);
  console.log("╚══════════════════════════════════════════╝");

  if (Object.keys(results.errors).length > 0) {
    console.log("\n📋 Error breakdown:");
    for (const [err, count] of Object.entries(results.errors).sort((a, b) => b[1] - a[1])) {
      console.log(`   ${count}× ${err}`);
    }
  }

  // Check receiver balance
  const recvBal = await get(`/balance/${receiver.publicKey}`);
  console.log(`\n📊 Receiver balance: ${recvBal.balance ?? 0} XRGE (expected ~${(results.success * 0.01).toFixed(2)})`);
  console.log(`📊 Final chain height: ${finalStats.network_height}`);
}

main().catch(e => {
  console.error("\n❌ Stress test crashed:", e.message);
  process.exit(1);
});
