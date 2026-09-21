#!/usr/bin/env npx tsx
/**
 * Generate an HD wallet (BIP39 mnemonic) for the BTC bridge's per-user DEPOSIT addresses.
 *
 * ⚠  RUN IN A DIRECT SSH TERMINAL — it prints a SEED PHRASE. Anyone with it controls every
 *    deposit address's funds (until swept to custody). Back it up offline like the custody WIF.
 *
 * The relayer takes this mnemonic (BRIDGE_BTC_HD_MNEMONIC) and derives BIP84 native-SegWit
 * receive addresses m/84'/<coin>'/0'/0/i, registering them with the daemon's deposit pool.
 * Users send BTC to their assigned address from ANY wallet — no OP_RETURN.
 *
 * Usage: QV_BRIDGE_BTC_NETWORK=mainnet npm run btc:genhd   (or testnet)
 */
import { generateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";
import * as btc from "@scure/btc-signer";

const net = (process.env.QV_BRIDGE_BTC_NETWORK || "mainnet").toLowerCase();
if (net !== "mainnet" && net !== "testnet") {
  console.error(`Invalid QV_BRIDGE_BTC_NETWORK="${net}" (use mainnet or testnet)`);
  process.exit(1);
}
const NETWORK = net === "testnet" ? btc.TEST_NETWORK : btc.NETWORK;
const COIN = net === "testnet" ? 1 : 0;

const mnemonic = generateMnemonic(wordlist, 128); // 12 words
const account = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive(`m/84'/${COIN}'/0'`);
const first = (i: number) => btc.p2wpkh(account.derive(`m/0/${i}`).publicKey!, NETWORK).address;

console.log("");
console.log("  RougeChain BTC bridge — HD deposit wallet");
console.log("  ─────────────────────────────────────────");
console.log(`  network       : ${net}`);
console.log(`  derivation    : m/84'/${COIN}'/0'/0/i  (BIP84 native SegWit)`);
console.log("");
console.log(`  SEED PHRASE   : ${mnemonic}`);
console.log("                  → set relayer env  BRIDGE_BTC_HD_MNEMONIC  to this. BACK UP OFFLINE.");
console.log("");
console.log(`  first deposit addresses (sanity): ${first(0)}, ${first(1)}, …`);
console.log("");
console.log("  ⚠  This seed derives every user's deposit address. Whoever holds it can spend");
console.log("     deposited funds before they're swept to custody. Never paste it into chat.");
console.log("");
