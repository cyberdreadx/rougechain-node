#!/usr/bin/env npx tsx
/**
 * Generate a custody Bitcoin keypair for the BTC bridge relayer.
 *
 * ⚠  RUN THIS IN A DIRECT SSH TERMINAL — it prints a PRIVATE KEY (the WIF). Do not run it
 *    anywhere the output is logged, shared, or captured into a transcript.
 *
 * Usage:
 *    QV_BRIDGE_BTC_NETWORK=testnet npm run btc:genkey     # testnet first
 *    QV_BRIDGE_BTC_NETWORK=mainnet npm run btc:genkey     # real custody
 *
 * Then:
 *   • Put the WIF in btc-bridge-relayer.env as BRIDGE_BTC_CUSTODY_WIF (and BACK IT UP OFFLINE).
 *   • Set the daemon's QV_BRIDGE_BTC_CUSTODY to the printed address.
 *   • Fund that address with BTC (this is where the bridge's Bitcoin lives).
 *
 * The key never leaves this machine. Losing the WIF = losing custody of the BTC. Anyone who
 * gets the WIF can spend the custody funds. Treat it like the crown jewels.
 */
import * as btc from "@scure/btc-signer";

const net = (process.env.QV_BRIDGE_BTC_NETWORK || "mainnet").toLowerCase();
if (net !== "mainnet" && net !== "testnet") {
  console.error(`Invalid QV_BRIDGE_BTC_NETWORK="${net}" (use mainnet or testnet)`);
  process.exit(1);
}
const NETWORK = net === "testnet" ? btc.TEST_NETWORK : btc.NETWORK;

const priv = btc.utils.randomPrivateKeyBytes(); // cryptographically-secure RNG
const wif = btc.WIF(NETWORK).encode(priv);
const address = btc.getAddress("wpkh", priv, NETWORK)!; // native SegWit (bc1…/tb1…)

console.log("");
console.log("  RougeChain BTC bridge — custody key");
console.log("  ───────────────────────────────────");
console.log(`  network : ${net}`);
console.log(`  address : ${address}`);
console.log("            → set daemon env  QV_BRIDGE_BTC_CUSTODY  to this, and FUND it");
console.log("");
console.log(`  WIF     : ${wif}`);
console.log("            → set relayer env BRIDGE_BTC_CUSTODY_WIF to this — KEEP SECRET, BACK UP OFFLINE");
console.log("");
console.log("  ⚠  Whoever holds the WIF controls the custody funds. Never paste it into chat,");
console.log("     tickets, screenshots, or cloud notes. Back it up on paper / a password manager.");
console.log("");
