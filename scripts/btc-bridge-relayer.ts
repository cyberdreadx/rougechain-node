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
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
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

// ── HD deposit wallet (per-user "send from any wallet" addresses) ──
// When BRIDGE_BTC_HD_MNEMONIC is set, the relayer derives BIP84 receive addresses, keeps the
// daemon's deposit pool topped up, and sweeps deposits into custody. The DAEMON never sees the
// seed — it only gets the derived addresses.
const HD_MNEMONIC = (process.env.BRIDGE_BTC_HD_MNEMONIC || "").trim();
const HD_ENABLED = HD_MNEMONIC.split(/\s+/).filter(Boolean).length >= 12;
const HD_COIN = IS_TESTNET ? 1 : 0;
const POOL_TARGET = parseInt(process.env.DEPOSIT_POOL_TARGET || "20", 10);
const SWEEP_MIN_SATS = BigInt(process.env.SWEEP_MIN_SATS || "2000");
const HD_ACCOUNT: HDKey | null = HD_ENABLED
  ? HDKey.fromMasterSeed(mnemonicToSeedSync(HD_MNEMONIC)).derive(`m/84'/${HD_COIN}'/0'`)
  : null;

/** Derive the receive address + spending key + script for deposit index i. */
function hdAddress(index: number): { address: string; priv: Uint8Array; script: Uint8Array } {
  const child = HD_ACCOUNT!.derive(`m/0/${index}`);
  const address = btc.getAddress("wpkh", child.privateKey!, NETWORK)!;
  const script = btc.OutScript.encode(btc.Address(NETWORK).decode(address));
  return { address, priv: child.privateKey!, script };
}

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
  vin?: { prevout?: { scriptpubkey_address?: string } }[];
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
      // Only a real payout SPENDS custody (custody appears as an input). A deposit has custody
      // as an OUTPUT and its change can land on any address — never adopt those, or a deposit
      // whose change happens to pay `dest` would be mistaken for the payout.
      const custodySpent = (tx.vin || []).some(
        (v) => v.prevout?.scriptpubkey_address === CUSTODY_ADDRESS
      );
      if (!custodySpent) continue;
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

// ── HD deposit pool + sweep ──
type DepositAddr = { address: string; index: number; recipient: string };

async function fetchDepositAddresses(): Promise<{ addresses: DepositAddr[]; poolRemaining: number; maxIndex: number }> {
  const r = await fetch(`${CORE_API_URL}/api/bridge/btc/deposit-addresses`, {
    headers: { "x-bridge-relayer-secret": RELAYER_SECRET },
  });
  const d = (await r.json()) as any;
  if (!d.success) throw new Error(d.error || "deposit-addresses fetch failed");
  return { addresses: d.addresses || [], poolRemaining: d.poolRemaining ?? 0, maxIndex: d.maxIndex ?? -1 };
}

/** Keep the daemon's deposit-address pool topped up. Registers derived addresses only — no BTC
 *  moves — so this runs even in dry-run. */
async function topUpPool() {
  if (!HD_ENABLED) return;
  try {
    const { poolRemaining, maxIndex } = await fetchDepositAddresses();
    const need = POOL_TARGET - poolRemaining;
    if (need <= 0) return;
    const start = (maxIndex ?? -1) + 1;
    const addresses = Array.from({ length: need }, (_, k) => {
      const index = start + k;
      return { index, address: hdAddress(index).address };
    });
    const res = await fetch(`${CORE_API_URL}/api/bridge/btc/deposit-pool`, {
      method: "POST",
      headers: { "x-bridge-relayer-secret": RELAYER_SECRET, "Content-Type": "application/json" },
      body: JSON.stringify({ addresses }),
    });
    const rd = (await res.json()) as any;
    if (rd.success) console.log(`[pool] +${rd.added} deposit address(es) (pool now ${rd.poolRemaining})`);
    else console.error(`[pool] top-up refused: ${rd.error}`);
  } catch (e) {
    console.error("[pool] top-up error:", (e as Error).message);
  }
}

/** Sweep confirmed deposits from each assigned address into the custody pool. Broadcasts real
 *  txs, so only runs when LIVE. The daemon mints from the deposit's tx history independently, so
 *  sweeping before or after the mint is safe. */
async function sweepDeposits() {
  if (!HD_ENABLED || !LIVE) return;
  let addrs: DepositAddr[];
  try {
    addrs = (await fetchDepositAddresses()).addresses;
  } catch {
    return;
  }
  for (const a of addrs) {
    try {
      const utxos = (await getUtxos(a.address)).filter((u) => u.status.confirmed);
      const bal = utxos.reduce((s, u) => s + BigInt(u.value), 0n);
      if (bal < SWEEP_MIN_SATS) continue;
      const feeRate = await getFeeRate();
      const fee = BigInt(Math.ceil((utxos.length * 68 + 31 + 11) * feeRate));
      if (bal <= fee + DUST) continue;
      const { priv, script } = hdAddress(a.index);
      const tx = new btc.Transaction();
      for (const u of utxos) {
        tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script, amount: BigInt(u.value) } });
      }
      tx.addOutputAddress(CUSTODY_ADDRESS, bal - fee, NETWORK);
      tx.sign(priv);
      tx.finalize();
      const b = await fetch(`${ESPLORA}/tx`, {
        method: "POST",
        headers: { "Content-Type": "text/plain", "User-Agent": "RougeChain-btc-relayer/1.0" },
        body: tx.hex,
      });
      const txid = (await b.text()).trim();
      if (/^[0-9a-f]{64}$/.test(txid)) console.log(`[sweep] ${a.address} → custody: ${bal - fee} sats (${txid})`);
      else console.error(`[sweep] ${a.address} broadcast rejected: ${txid}`);
    } catch (e) {
      console.error(`[sweep] ${a.address} error:`, (e as Error).message);
    }
  }
}

let lastHdRun = 0;

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
  // HD pool top-up + sweep on a slower (~2 min) cadence to stay gentle on Esplora.
  if (HD_ENABLED && Date.now() - lastHdRun > 120_000) {
    lastHdRun = Date.now();
    await topUpPool();
    await sweepDeposits();
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
  console.log(`  HD deposits: ${HD_ENABLED ? `on (pool target ${POOL_TARGET})` : "off (set BRIDGE_BTC_HD_MNEMONIC)"}`);
  console.log(`  Mode:      ${LIVE ? "LIVE (broadcasting)" : "DRY-RUN (no broadcast)"}`);
  console.log("═".repeat(60));
  console.log(`\n⚠  Set QV_BRIDGE_BTC_CUSTODY=${CUSTODY_ADDRESS} on the daemon so it watches this exact address.\n`);
  if (!LIVE) console.log("ℹ  DRY-RUN: no Bitcoin will move. Verify on testnet, then set BTC_RELAYER_LIVE=true.\n");

  // Prime the deposit pool immediately so the daemon can hand out addresses right away.
  if (HD_ENABLED) {
    await topUpPool();
    lastHdRun = Date.now();
  }

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
