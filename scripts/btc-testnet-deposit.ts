#!/usr/bin/env npx tsx
/**
 * TESTNET-ONLY helper: build + broadcast a BTC→qBTC deposit WITH an OP_RETURN recipient,
 * for testing the bridge when your wallet (e.g. Sparrow) can't attach an OP_RETURN.
 *
 * Flow:
 *   1. First run generates a throwaway testnet sender key (persisted to a gitignored file)
 *      and prints its address. Fund that address from your wallet (a normal send).
 *   2. Run again once it's funded: it builds a tx paying the custody address + an OP_RETURN
 *      carrying your RougeChain recipient, signs, and broadcasts. Prints the txid.
 *
 * Env / args:
 *   CUSTODY=<tb1…>            custody address to deposit to (required)
 *   RECIPIENT=<rouge1…>       RougeChain recipient for the OP_RETURN (required)
 *   AMOUNT_SATS=1000          how many sats to send to custody (default 1000)
 *   QV_BRIDGE_BTC_NETWORK=testnet   (this helper refuses anything but testnet)
 *   QV_BTC_ESPLORA_PRIMARY   Esplora base (default mempool.space testnet)
 *   DEPOSIT_KEY_FILE         where the sender WIF is stored (default .btc-deposit-key.testnet)
 */
import * as btc from "@scure/btc-signer";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "fs";

const NET_NAME = (process.env.QV_BRIDGE_BTC_NETWORK || "testnet").toLowerCase();
const IS_MAINNET = NET_NAME === "mainnet";
if (IS_MAINNET && process.env.ALLOW_MAINNET !== "true") {
  console.error("Refusing to run on mainnet without ALLOW_MAINNET=true — this moves REAL BTC.");
  process.exit(1);
}
const NETWORK = IS_MAINNET ? btc.NETWORK : btc.TEST_NETWORK;
const ESPLORA = (process.env.QV_BTC_ESPLORA_PRIMARY
  || (IS_MAINNET ? "https://mempool.space/api" : "https://mempool.space/testnet/api")).replace(/\/$/, "");
const CUSTODY = process.env.CUSTODY || "";
const RECIPIENT = process.env.RECIPIENT || "";
const AMOUNT_SATS = BigInt(process.env.AMOUNT_SATS || "1000");
const KEY_FILE = process.env.DEPOSIT_KEY_FILE || (IS_MAINNET ? ".btc-deposit-key.mainnet" : ".btc-deposit-key.testnet");
const DUST = 546n;

// Load or create the throwaway sender key.
let wif: string;
if (existsSync(KEY_FILE)) {
  wif = readFileSync(KEY_FILE, "utf8").trim();
} else {
  wif = btc.WIF(NETWORK).encode(btc.utils.randomPrivateKeyBytes());
  writeFileSync(KEY_FILE, wif + "\n");
  try { chmodSync(KEY_FILE, 0o600); } catch {}
  console.log(`[key] generated a new testnet sender key → ${KEY_FILE}`);
}
const PRIV = btc.WIF(NETWORK).decode(wif);
const SENDER = btc.getAddress("wpkh", PRIV, NETWORK)!;
const SENDER_SCRIPT = btc.OutScript.encode(btc.Address(NETWORK).decode(SENDER));

const esploraJson = async (p: string) => {
  const r = await fetch(`${ESPLORA}${p}`, { headers: { "User-Agent": "rc-testnet-deposit/1.0" } });
  if (!r.ok) throw new Error(`esplora ${p} → HTTP ${r.status}`);
  return r.json();
};
const esploraText = async (p: string) => {
  const r = await fetch(`${ESPLORA}${p}`, { headers: { "User-Agent": "rc-testnet-deposit/1.0" } });
  if (!r.ok) throw new Error(`esplora ${p} → HTTP ${r.status}`);
  return (await r.text()).trim();
};

function opReturnScript(text: string): Uint8Array {
  const data = new TextEncoder().encode(text);
  if (data.length > 75) throw new Error(`OP_RETURN data ${data.length} bytes > 75 (single-push limit)`);
  return new Uint8Array([0x6a, data.length, ...data]); // OP_RETURN <push len> <data>
}

async function main() {
  console.log(`Sender address: ${SENDER}`);
  const utxos: any[] = await esploraJson(`/address/${SENDER}/utxo`);
  const confirmed = utxos.filter((u) => u.status?.confirmed);
  const balance = confirmed.reduce((a, u) => a + BigInt(u.value), 0n);
  console.log(`Confirmed balance: ${balance} sats (${confirmed.length} utxo)`);

  if (!CUSTODY || !RECIPIENT) {
    console.log("\nSet CUSTODY=<tb1…> and RECIPIENT=<rouge1…> to build the deposit.");
    return;
  }
  if (balance === 0n) {
    console.log(`\n⏳ Not funded yet. Send some testnet BTC to:\n\n    ${SENDER}\n\nthen re-run this script.`);
    return;
  }

  const feeRate = await (async () => {
    try { const e: any = await esploraJson("/fee-estimates"); return Math.max(1, Math.ceil(e["3"] ?? e["6"] ?? 2)); }
    catch { return 2; }
  })();

  // Select UTXOs to cover amount + fee (2 non-OP_RETURN outputs: custody + change).
  const estFee = (nIn: number) => BigInt(Math.ceil((nIn * 68 + 2 * 31 + 12 + 20) * feeRate)); // +OP_RETURN overhead
  confirmed.sort((a, b) => b.value - a.value);
  const sel: any[] = [];
  let inSats = 0n;
  for (const u of confirmed) { sel.push(u); inSats += BigInt(u.value); if (inSats >= AMOUNT_SATS + estFee(sel.length)) break; }
  const fee = estFee(sel.length);
  if (inSats < AMOUNT_SATS + fee) throw new Error(`insufficient funds: have ${inSats}, need ${AMOUNT_SATS + fee}`);

  // allowUnknownOutputs: OP_RETURN is a non-payment output, which btc-signer guards against by default.
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  for (const u of sel) tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: SENDER_SCRIPT, amount: BigInt(u.value) } });
  // Output order doesn't matter to the bridge (it scans all vouts).
  tx.addOutput({ script: opReturnScript(RECIPIENT), amount: 0n });
  tx.addOutputAddress(CUSTODY, AMOUNT_SATS, NETWORK);
  const change = inSats - AMOUNT_SATS - fee;
  if (change > DUST) tx.addOutputAddress(SENDER, change, NETWORK);
  tx.sign(PRIV);
  tx.finalize();

  const rawHex = tx.hex;
  console.log(`\nBuilt deposit: ${AMOUNT_SATS} sats → ${CUSTODY}`);
  console.log(`  OP_RETURN → ${RECIPIENT}`);
  console.log(`  fee ${fee} sats, change ${change > DUST ? change : 0} sats, local txid ${tx.id}`);

  const r = await fetch(`${ESPLORA}/tx`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: rawHex });
  const body = (await r.text()).trim();
  if (!r.ok || !/^[0-9a-f]{64}$/.test(body)) throw new Error(`broadcast rejected: ${body}`);
  console.log(`\n✅ Broadcast! txid: ${body}`);
  console.log(`   ${IS_MAINNET ? "https://mempool.space" : "https://mempool.space/testnet"}/tx/${body}`);
  console.log(`\nOnce it has 1 confirmation, claim with:`);
  console.log(`   curl -s -X POST http://localhost:${IS_MAINNET ? "5100" : "5101"}/api/bridge/btc/claim -H 'content-type: application/json' -d '{"btcTxid":"${body}"}'`);
}

main().catch((e) => { console.error("ERROR:", e.message || e); process.exit(1); });
