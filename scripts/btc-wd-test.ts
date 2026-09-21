#!/usr/bin/env npx tsx
/**
 * TESTNET-ONLY: scripted RougeChain side of a qBTC → BTC withdrawal test.
 * Reuses the frontend's exact ML-DSA signing (src/lib/pqc-signer, src/lib/address) so the
 * daemon accepts the signature identically to a real wallet.
 *
 * MODE=info      generate/print the throwaway test wallet (address + pubkey)
 * MODE=faucet    request testnet XRGE (needed for the withdrawal fee)
 * MODE=withdraw  sign + submit a qBTC bridge_withdraw   (needs PAYOUT_ADDR, AMOUNT_SATS)
 *
 * Env: CORE_API_URL (default http://localhost:5101), WD_WALLET_FILE, PAYOUT_ADDR, AMOUNT_SATS
 */
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "fs";
import { createSignedBridgeWithdraw, createSignedFaucetRequest } from "../src/lib/pqc-signer";
import { pubkeyToAddress } from "../src/lib/address";

const API = (process.env.CORE_API_URL || "http://localhost:5101").replace(/\/$/, "");
const KEY_FILE = process.env.WD_WALLET_FILE || ".btc-wd-wallet.testnet.json";
const MODE = process.env.MODE || "info";
const toHex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

let wallet: { publicKey: string; privateKey: string };
if (existsSync(KEY_FILE)) {
  wallet = JSON.parse(readFileSync(KEY_FILE, "utf8"));
} else {
  const kp = ml_dsa65.keygen();
  wallet = { publicKey: toHex(kp.publicKey), privateKey: toHex(kp.secretKey) };
  writeFileSync(KEY_FILE, JSON.stringify(wallet));
  try { chmodSync(KEY_FILE, 0o600); } catch {}
  console.error(`[wallet] generated new throwaway test wallet → ${KEY_FILE}`);
}

async function main() {
  const address = await pubkeyToAddress(wallet.publicKey);
  console.log("address:", address);
  console.log("pubkey :", wallet.publicKey.slice(0, 24) + `…(${wallet.publicKey.length} hex)`);

  if (MODE === "faucet") {
    const signed = createSignedFaucetRequest(wallet.publicKey, wallet.privateKey);
    const r = await fetch(`${API}/api/v2/faucet`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(signed),
    });
    console.log("faucet:", r.status, await r.text());
  } else if (MODE === "withdraw") {
    const payout = process.env.PAYOUT_ADDR;
    const sats = parseInt(process.env.AMOUNT_SATS || "500", 10);
    if (!payout) throw new Error("set PAYOUT_ADDR to a testnet BTC address");
    const signed = createSignedBridgeWithdraw(wallet.publicKey, wallet.privateKey, sats, payout, "qBTC", 0.1, false);
    const body = {
      fromPublicKey: wallet.publicKey,
      amountUnits: sats,
      evmAddress: payout,               // verbatim BTC address (qBTC path)
      fee: 0.1,
      signature: signed.signature,
      payload: { ...signed.payload, tokenSymbol: "qBTC" },
    };
    const r = await fetch(`${API}/api/bridge/withdraw`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    console.log(`withdraw ${sats} sats → ${payout}:`, r.status, await r.text());
  }
}
main().catch((e) => { console.error("ERROR:", e.message || e); process.exit(1); });
