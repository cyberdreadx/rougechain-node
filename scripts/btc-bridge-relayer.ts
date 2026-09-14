#!/usr/bin/env npx tsx
/**
 * RougeChain BTC Bridge Relayer — qBTC → BTC payouts.
 *
 * This is the ONLY component that holds a hot Bitcoin key. The daemon never signs Bitcoin.
 * Flow:
 *   1. Poll GET /api/bridge/btc/withdrawals for pending qBTC burns (each item: txId,
 *      evmAddress = the destination BTC address, amountUnits = satoshis owed).
 *   2. Build + sign + broadcast a Bitcoin transaction paying the destination from custody.
 *   3. Once the payout has the required confirmations, call DELETE
 *      /api/bridge/btc/withdrawals/:txId with { btcTxid } and the relayer secret. The daemon
 *      independently re-verifies that payout on-chain before marking the withdrawal fulfilled —
 *      it never takes the relayer's word.
 *
 * SAFETY:
 *   • DRY-RUN BY DEFAULT. Nothing is broadcast unless BTC_RELAYER_LIVE=true. Testnet-verify
 *     the whole round-trip first (QV_BRIDGE_BTC_NETWORK=testnet), then flip to live.
 *   • Per-payout satoshi cap (BTC_MAX_WITHDRAW_SATS) bounds the blast radius of any single bug.
 *   • Idempotency: a persisted state file maps withdrawal txId → broadcast btcTxid, and before
 *     broadcasting we also scan custody's own transactions for an existing payment to the
 *     destination (adopt-if-present) so a crash-after-broadcast cannot double-pay.
 *   • Run as a SINGLETON. Two relayers against one custody wallet can double-spend UTXOs.
 *
 * Env:
 *   CORE_API_URL                  daemon base URL (default http://localhost:5101)
 *   BRIDGE_RELAYER_SECRET         shared secret for the fulfill call (required to fulfill)
 *   BRIDGE_BTC_CUSTODY_WIF        custody private key, WIF format (required) — HOT KEY
 *   QV_BRIDGE_BTC_NETWORK         mainnet | testnet (default mainnet)
 *   QV_BTC_ESPLORA_PRIMARY        Esplora base (default mempool.space, network-aware)
 *   QV_BRIDGE_BTC_MIN_CONFIRMATIONS  confirmations before fulfilling (default 2)
 *   BTC_MAX_WITHDRAW_SATS         per-payout cap in sats (0 = no cap, default 0)
 *   BTC_FEE_TARGET_BLOCKS         fee target for estimation (default 3)
 *   BTC_RELAYER_LIVE             "true" to actually broadcast (default false = dry-run)
 *   POLL_INTERVAL_MS              poll cadence (default 15000)
 *   MAX_RETRIES                   max broadcast attempts per withdrawal (default 3)
 *   BRIDGE_DATA_DIR               dir for the idempotency state file (default ".")
 *
 * Requires: npm i @scure/btc-signer   (pulls @scure/base, @noble/curves, @noble/hashes)
 */

import * as btc from "@scure/btc-signer";
import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { join } from "path";

// ── Config ──
const CORE_API_URL = (process.env.CORE_API_URL || "http://localhost:5101").replace(/\/$/, "");
const RELAYER_SECRET = process.env.BRIDGE_RELAYER_SECRET || "";
const CUSTODY_WIF = process.env.BRIDGE_BTC_CUSTODY_WIF || "";
const NETWORK_NAME = (process.env.QV_BRIDGE_BTC_NETWORK || "mainnet").toLowerCase();
const IS_TESTNET = NETWORK_NAME === "testnet";
const NETWORK = IS_TESTNET ? btc.TEST_NETWORK : btc.NETWORK;
const ESPLORA = (
  process.env.QV_BTC_ESPLORA_PRIMARY ||
  (IS_TESTNET ? "https://mempool.space/testnet/api" : "https://mempool.space/api")
).replace(/\/$/, "");
const MIN_CONFIRMATIONS = parseInt(process.env.QV_BRIDGE_BTC_MIN_CONFIRMATIONS || "2", 10);
const MAX_SATS = BigInt(process.env.BTC_MAX_WITHDRAW_SATS || "0"); // 0 = no cap
const FEE_TARGET_BLOCKS = process.env.BTC_FEE_TARGET_BLOCKS || "3";
const LIVE = (process.env.BTC_RELAYER_LIVE || "false").toLowerCase() === "true";
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS || "15000", 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || "3", 10);
const DATA_DIR = process.env.BRIDGE_DATA_DIR || ".";
const STATE_FILE = join(DATA_DIR, ".btc-relayer-state.json");
const DUST = 546n;

if (!CUSTODY_WIF) {
  console.error("FATAL: BRIDGE_BTC_CUSTODY_WIF is required (the custody private key in WIF format).");
  process.exit(1);
}
if (!RELAYER_SECRET) {
  console.error("FATAL: BRIDGE_RELAYER_SECRET is required to fulfill withdrawals.");
  process.exit(1);
}

// ── Custody key / address (native SegWit P2WPKH) ──
const PRIV = btc.WIF(NETWORK).decode(CUSTODY_WIF);
const CUSTODY_ADDRESS = btc.getAddress("wpkh", PRIV, NETWORK)!;
// scriptPubKey for the custody address, needed as each input's witnessUtxo when signing.
const CUSTODY_SCRIPT = btc.OutScript.encode(btc.Address(NETWORK).decode(CUSTODY_ADDRESS));

// ── Idempotency state ──
type StateEntry = { btcTxid?: string; broadcasting?: boolean; attempts: number; dest: string; sats: string };
type State = Record<string, StateEntry>;

function loadState(): State {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch (e) {
    console.error("[state] failed to read, starting empty:", (e as Error).message);
  }
  return {};
}
function saveState(s: State) {
  const tmp = STATE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, STATE_FILE); // atomic replace
}
let STATE: State = loadState();

// ── Esplora helpers ──
async function esploraJson<T>(path: string): Promise<T> {
  const r = await fetch(`${ESPLORA}${path}`, { headers: { "User-Agent": "RougeChain-btc-relayer/1.0" } });
  if (!r.ok) throw new Error(`esplora ${path} → HTTP ${r.status}`);
  return (await r.json()) as T;
}
async function esploraText(path: string): Promise<string> {
  const r = await fetch(`${ESPLORA}${path}`, { headers: { "User-Agent": "RougeChain-btc-relayer/1.0" } });
  if (!r.ok) throw new Error(`esplora ${path} → HTTP ${r.status}`);
  return (await r.text()).trim();
}

type Utxo = { txid: string; vout: number; value: number; status: { confirmed: boolean; block_height?: number } };
type EsTx = {
  txid: string;
  vout: { scriptpubkey_address?: string; value: number }[];
  status: { confirmed: boolean; block_height?: number };
};

async function tipHeight(): Promise<number> {
  return parseInt(await esploraText("/blocks/tip/height"), 10);
}
async function getUtxos(addr: string): Promise<Utxo[]> {
  return esploraJson<Utxo[]>(`/address/${addr}/utxo`);
}
async function getFeeRate(): Promise<number> {
  try {
    const est = await esploraJson<Record<string, number>>("/fee-estimates");
    const r = est[FEE_TARGET_BLOCKS] ?? est["3"] ?? est["6"] ?? 5;
    return Math.max(1, Math.ceil(r));
  } catch {
    return 5; // conservative fallback sat/vB
  }
}
async function txConfirmations(txid: string): Promise<number> {
  try {
    const tx = await esploraJson<EsTx>(`/tx/${txid}`);
    if (!tx.status?.confirmed || tx.status.block_height == null) return 0;
    const tip = await tipHeight();
    return tip - tx.status.block_height + 1;
  } catch {
    return 0;
  }
}
/** Scan custody's recent txs for one that already pays `dest` at least `sats`, and is not the
 *  funding of some OTHER known withdrawal. Used to adopt a payout after a crash-before-save. */
async function findExistingPayout(dest: string, sats: bigint, knownTxids: Set<string>): Promise<string | null> {
  try {
    const txs = await esploraJson<EsTx[]>(`/address/${CUSTODY_ADDRESS}/txs`);
    for (const tx of txs) {
      if (knownTxids.has(tx.txid)) continue;
      const paid = tx.vout
        .filter((v) => v.scriptpubkey_address === dest)
        .reduce((a, v) => a + BigInt(v.value), 0n);
      if (paid >= sats) return tx.txid;
    }
  } catch (e) {
    console.error("[adopt] scan failed:", (e as Error).message);
  }
  return null;
}

// ── Build + sign + broadcast a payout ──
function estFeeSats(nIn: number, nOut: number, feeRate: number): bigint {
  // P2WPKH: ~68 vbytes/input, ~31 vbytes/output, ~11 overhead.
  return BigInt(Math.ceil((nIn * 68 + nOut * 31 + 11) * feeRate));
}

async function buildAndBroadcast(dest: string, sats: bigint): Promise<string> {
  const utxos = (await getUtxos(CUSTODY_ADDRESS)).filter((u) => u.status.confirmed);
  if (utxos.length === 0) throw new Error("no confirmed custody UTXOs available");
  utxos.sort((a, b) => b.value - a.value);
  const feeRate = await getFeeRate();

  const selected: Utxo[] = [];
  let inSats = 0n;
  for (const u of utxos) {
    selected.push(u);
    inSats += BigInt(u.value);
    if (inSats >= sats + estFeeSats(selected.length, 2, feeRate)) break;
  }
  const fee = estFeeSats(selected.length, 2, feeRate);
  if (inSats < sats + fee) {
    throw new Error(`insufficient custody balance: have ${inSats} sats, need ${sats + fee} (incl. fee)`);
  }

  const tx = new btc.Transaction();
  for (const u of selected) {
    tx.addInput({
      txid: u.txid,
      index: u.vout,
      witnessUtxo: { script: CUSTODY_SCRIPT, amount: BigInt(u.value) },
    });
  }
  tx.addOutputAddress(dest, sats, NETWORK);
  const change = inSats - sats - fee;
  if (change > DUST) tx.addOutputAddress(CUSTODY_ADDRESS, change, NETWORK);
  tx.sign(PRIV);
  tx.finalize();
  const rawHex = tx.hex;
  const localTxid = tx.id;

  if (!LIVE) {
    console.log(`  [DRY-RUN] built payout ${localTxid} (${sats} sats → ${dest}, fee ${fee}). Not broadcasting.`);
    console.log(`  [DRY-RUN] set BTC_RELAYER_LIVE=true to broadcast. raw: ${rawHex.slice(0, 40)}…`);
    throw new Error("DRY_RUN"); // signal caller: do not record as broadcast
  }

  const r = await fetch(`${ESPLORA}/tx`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", "User-Agent": "RougeChain-btc-relayer/1.0" },
    body: rawHex,
  });
  const body = (await r.text()).trim();
  if (!r.ok || !/^[0-9a-f]{64}$/.test(body)) throw new Error(`broadcast rejected: ${body}`);
  return body;
}

// ── Daemon API ──
async function fetchPending(): Promise<{ txId: string; evmAddress: string; amountUnits: number }[]> {
  try {
    const r = await fetch(`${CORE_API_URL}/api/bridge/btc/withdrawals`);
    const d = (await r.json()) as { withdrawals?: any[] };
    return (d.withdrawals || []).map((w) => ({ txId: w.txId, evmAddress: w.evmAddress, amountUnits: w.amountUnits }));
  } catch (e) {
    console.error("[poll] failed:", (e as Error).message);
    return [];
  }
}
async function fulfill(txId: string, btcTxid: string): Promise<boolean> {
  const r = await fetch(`${CORE_API_URL}/api/bridge/btc/withdrawals/${encodeURIComponent(txId)}`, {
    method: "DELETE",
    headers: { "x-bridge-relayer-secret": RELAYER_SECRET, "Content-Type": "application/json" },
    body: JSON.stringify({ btcTxid }),
  });
  const d = (await r.json()) as { success?: boolean; error?: string };
  if (!d.success) console.error(`  [fulfill] daemon refused ${txId}: ${d.error}`);
  return !!d.success;
}

// ── Main loop ──
async function processOne(w: { txId: string; evmAddress: string; amountUnits: number }) {
  const dest = w.evmAddress;
  const sats = BigInt(w.amountUnits);
  const st = STATE[w.txId] || { attempts: 0, dest, sats: sats.toString() };
  STATE[w.txId] = st;

  if (MAX_SATS > 0n && sats > MAX_SATS) {
    console.error(`  [cap] ${w.txId}: ${sats} sats exceeds BTC_MAX_WITHDRAW_SATS ${MAX_SATS} — skipping.`);
    return;
  }

  // Already broadcast? Just wait for confirmations, then fulfill.
  if (st.btcTxid) {
    const confs = await txConfirmations(st.btcTxid);
    if (confs >= MIN_CONFIRMATIONS) {
      if (await fulfill(w.txId, st.btcTxid)) {
        console.log(`  ✓ fulfilled ${w.txId} via ${st.btcTxid} (${confs} confs)`);
      }
    } else {
      console.log(`  … ${w.txId} payout ${st.btcTxid} at ${confs}/${MIN_CONFIRMATIONS} confs`);
    }
    return;
  }

  // Crash-recovery: did a payout to this dest already go out?
  const known = new Set(Object.values(STATE).map((e) => e.btcTxid).filter(Boolean) as string[]);
  const existing = await findExistingPayout(dest, sats, known);
  if (existing) {
    console.warn(`  [adopt] found existing custody payout ${existing} to ${dest} — adopting instead of re-paying.`);
    st.btcTxid = existing;
    saveState(STATE);
    return;
  }

  if (st.attempts >= MAX_RETRIES) {
    console.error(`  [give-up] ${w.txId} exceeded ${MAX_RETRIES} attempts.`);
    return;
  }

  // Broadcast. Mark "broadcasting" BEFORE the network call so a crash is detectable.
  st.attempts += 1;
  st.broadcasting = true;
  saveState(STATE);
  try {
    const btcTxid = await buildAndBroadcast(dest, sats);
    st.btcTxid = btcTxid;
    st.broadcasting = false;
    saveState(STATE);
    console.log(`  → broadcast ${w.txId}: ${btcTxid} (${sats} sats → ${dest})`);
  } catch (e) {
    st.broadcasting = false;
    saveState(STATE);
    const msg = (e as Error).message;
    if (msg !== "DRY_RUN") console.error(`  [broadcast] ${w.txId} failed (attempt ${st.attempts}): ${msg}`);
  }
}

async function loop() {
  const pending = await fetchPending();
  if (pending.length > 0) console.log(`[cycle] ${pending.length} pending qBTC withdrawal(s)`);
  for (const w of pending) {
    try {
      await processOne(w);
    } catch (e) {
      console.error(`[cycle] ${w.txId} error:`, (e as Error).message);
    }
  }
}

async function main() {
  console.log("═".repeat(60));
  console.log("  RougeChain BTC Bridge Relayer");
  console.log(`  Network:   ${NETWORK_NAME}`);
  console.log(`  Custody:   ${CUSTODY_ADDRESS}`);
  console.log(`  Esplora:   ${ESPLORA}`);
  console.log(`  Daemon:    ${CORE_API_URL}`);
  console.log(`  Min confs: ${MIN_CONFIRMATIONS}   Cap: ${MAX_SATS === 0n ? "none" : MAX_SATS + " sats"}`);
  console.log(`  Mode:      ${LIVE ? "LIVE (broadcasting)" : "DRY-RUN (no broadcast)"}`);
  console.log("═".repeat(60));
  console.log(`\n⚠  Set QV_BRIDGE_BTC_CUSTODY=${CUSTODY_ADDRESS} on the daemon so it watches this exact address.\n`);
  if (!LIVE) console.log("ℹ  DRY-RUN: no Bitcoin will move. Verify on testnet, then set BTC_RELAYER_LIVE=true.\n");

  let running = true;
  const stop = () => {
    running = false;
    console.log("\n[shutdown] finishing…");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (running) {
    try {
      await loop();
    } catch (e) {
      console.error("[loop] error:", (e as Error).message);
    }
    for (let i = 0; i < POLL_MS / 250 && running; i++) await new Promise((r) => setTimeout(r, 250));
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
