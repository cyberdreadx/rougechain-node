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

const BASE = process.argv.find(a => a.startsWith("--target="))?.split("=")[1]
  ?? "https://testnet.rougechain.io/api";
const TOTAL_TXS = parseInt(process.argv.find(a => a.startsWith("--txs="))?.split("=")[1] ?? "50");
const CONCURRENCY = parseInt(process.argv.find(a => a.startsWith("--concurrency="))?.split("=")[1] ?? "10");

// ─── Helpers ───────────────────────────────────────────────────────────────────

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  return res.json();
}

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─── Wallet keygen via @noble/post-quantum ─────────────────────────────────────

let ml_dsa65;
try {
  const mod = await import("@noble/post-quantum/ml-dsa");
  ml_dsa65 = mod.ml_dsa65;
} catch {
  try {
    const mod = await import("../node_modules/@noble/post-quantum/esm/ml-dsa.js");
    ml_dsa65 = mod.ml_dsa65;
  } catch (e) {
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

function signPayload(privateKey, payload) {
  const msgBytes = new TextEncoder().encode(payload);
  const sig = ml_dsa65.sign(msgBytes, hexToBytes(privateKey));
  return bytesToHex(sig);
}

function createSignedTransfer(from, privateKey, to, amount, fee, token) {
  const nonce = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const payload = JSON.stringify({
    type: "transfer",
    from: from,
    to: to,
    amount: amount,
    fee: fee,
    token: token || "XRGE",
    nonce: nonce,
    timestamp: Date.now(),
  });
  const signature = signPayload(privateKey, payload);
  return {
    tx_type: "transfer",
    from_pub_key: from,
    payload: {
      to_pub_key: to,
      amount: amount,
      fee: fee,
      token_symbol: token || "XRGE",
      nonce: nonce,
    },
    sig: signature,
    signed_payload: payload,
    timestamp: Date.now(),
    chain_id: "rougechain-devnet-1",
  };
}

// ─── Stress Test ───────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║     RougeChain Stress Test               ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`  Target:      ${BASE}`);
  console.log(`  Total TXs:   ${TOTAL_TXS}`);
  console.log(`  Concurrency: ${CONCURRENCY}`);
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
  const faucetPayload = JSON.stringify({
    type: "faucet",
    from: sender.publicKey,
    nonce: Date.now(),
    timestamp: Date.now(),
  });
  const faucetSig = signPayload(sender.privateKey, faucetPayload);
  const faucetResult = await post("/v2/faucet", {
    payload: faucetPayload,
    signature: faucetSig,
    public_key: sender.publicKey,
  });
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
  console.log(`🚀 Sending ${TOTAL_TXS} transfers (${CONCURRENCY} concurrent)...`);
  console.log("   ─".repeat(25));

  const results = { success: 0, failed: 0, errors: {} };
  const latencies = [];
  const startTime = performance.now();

  // Create a semaphore for concurrency control
  let active = 0;
  let completed = 0;
  const queue = [];

  async function sendOne(index) {
    const txStart = performance.now();
    try {
      const tx = createSignedTransfer(
        sender.publicKey,
        sender.privateKey,
        receiver.publicKey,
        0.01,     // tiny amount 
        0.1,      // fee
        "XRGE"
      );
      
      const res = await post("/v2/transfer", {
        payload: tx.signed_payload,
        signature: tx.sig,
        public_key: sender.publicKey,
      });

      const latency = performance.now() - txStart;
      latencies.push(latency);

      if (res.success) {
        results.success++;
      } else {
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
    if (completed % 10 === 0 || completed === TOTAL_TXS) {
      const elapsed = (performance.now() - startTime) / 1000;
      const tps = completed / elapsed;
      process.stdout.write(
        `\r   Progress: ${completed}/${TOTAL_TXS} | TPS: ${tps.toFixed(1)} | ✅ ${results.success} ❌ ${results.failed}`
      );
    }
  }

  // Run with concurrency limit
  const promises = [];
  for (let i = 0; i < TOTAL_TXS; i++) {
    while (active >= CONCURRENCY) {
      await new Promise(r => setTimeout(r, 10));
    }
    active++;
    const p = sendOne(i).finally(() => active--);
    promises.push(p);
  }
  await Promise.all(promises);

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
