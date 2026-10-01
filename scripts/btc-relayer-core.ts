/**
 * BTC relayer core — the payout decision for ONE pending qBTC withdrawal, as pure logic over
 * injected dependencies (Esplora, the daemon, the state file) so every path is unit-tested
 * without a network. Used by scripts/btc-bridge-relayer.ts.
 *
 * The rule that prevents double payment: a payout transaction is signed ONCE, its txid and raw
 * bytes are saved BEFORE it is broadcast, and from then on the relayer only ever re-broadcasts
 * those same bytes (a no-op if the network already has them). It builds a different transaction
 * for the same withdrawal only after the network has explicitly REJECTED the saved one for a
 * reason that proves it was never accepted. Anything ambiguous stops that withdrawal for
 * manual review instead of paying again.
 *
 * Fee policy: the WITHDRAWER pays the Bitcoin network fee. A payout of `sats` owed sends
 * `sats − fee` to the destination, where `fee` = ceil(vsize × feeRate) of that very payout, and
 * custody change = inputs − sats. Custody therefore falls by exactly `sats` (what was burned).
 * The fee is capped (BTC_MAX_NETWORK_FEE_SATS); above the cap nothing is built and the withdrawal
 * is retried next cycle. If `sats − fee` would be dust, it is flagged for manual review instead.
 */

// ── Fee / amount math (pure) ──

/** Default cap on the network fee deducted from a payout (sats). */
export const DEFAULT_MAX_NETWORK_FEE_SATS = 10_000n;
/** scriptPubKey length of a P2WPKH output (custody change is always P2WPKH). */
export const P2WPKH_SCRIPT_LEN = 22;

function varIntLen(n: number): number {
  return n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9;
}

/**
 * Virtual size of a transaction spending `nInputs` P2WPKH inputs to outputs with the given
 * scriptPubKey lengths. Uses the worst-case low-S DER signature (71 bytes + sighash = 72), so
 * the result is an upper bound on the signed tx's real vsize (never an under-payment of fee).
 *   non-witness: version 4 + locktime 4 + varint(nIn) + varint(nOut)
 *                + 41 per input (outpoint 36, empty scriptSig 1, sequence 4)
 *                + per output 8 + varint(len) + len
 *   witness:     marker+flag 2 + per input (1 item-count + 1+72 sig + 1+33 pubkey = 108)
 *   vsize = ceil((4 × non-witness + witness) / 4)
 */
export function p2wpkhVsize(nInputs: number, outputScriptLens: number[]): number {
  if (!Number.isInteger(nInputs) || nInputs < 1) throw new Error("need at least one input");
  const outBytes = outputScriptLens.reduce((a, l) => a + 8 + varIntLen(l) + l, 0);
  const base = 4 + 4 + varIntLen(nInputs) + varIntLen(outputScriptLens.length) + 41 * nInputs + outBytes;
  const witness = 2 + 108 * nInputs;
  return Math.ceil((base * 4 + witness) / 4);
}

/** Network fee for `vsize` at `feeRate` sat/vB, rounded UP to a whole sat. */
export function feeForVsize(vsize: number, feeRate: number): bigint {
  if (!(feeRate > 0) || !Number.isFinite(feeRate)) throw new Error(`invalid fee rate ${feeRate}`);
  // Round the product to 1e-9 first so float noise (e.g. 141 × 1.1) never adds a phantom sat.
  return BigInt(Math.ceil(Math.round(vsize * feeRate * 1e9) / 1e9));
}

export interface PlanUtxo {
  txid: string;
  vout: number;
  value: number;
}

export type PayoutPlan =
  | { kind: "ok"; inputs: PlanUtxo[]; pay: bigint; change: bigint; fee: bigint; vsize: number }
  | { kind: "fee_too_high"; fee: bigint; maxFee: bigint }
  | { kind: "below_minimum_after_fee"; fee: bigint; pay: bigint }
  | { kind: "insufficient"; have: bigint; need: bigint };

export interface PlanParams {
  /** Candidate custody UTXOs (already filtered: confirmed, not reserved). */
  utxos: PlanUtxo[];
  /** Sats owed (= qBTC burned). */
  sats: bigint;
  /** sat/vB. */
  feeRate: number;
  /** scriptPubKey length of the destination output. */
  destScriptLen: number;
  maxFee: bigint;
  dust: bigint;
}

/**
 * Plan a payout where the withdrawer pays the fee: select inputs (largest first) until they
 * cover `sats`; change = inputs − sats (kept only if > dust — if a sub-dust remainder is left
 * after using every UTXO it goes to the destination rather than to miners); fee = ceil(vsize ×
 * rate) of the resulting shape; destination receives (sats or sats+remainder) − fee.
 */
export function planPayout(p: PlanParams): PayoutPlan {
  const sorted = [...p.utxos].sort((a, b) => b.value - a.value);
  const selected: PlanUtxo[] = [];
  let inSats = 0n;
  for (const u of sorted) {
    selected.push(u);
    inSats += BigInt(u.value);
    // Stop once covered with either no change or a change output above dust.
    if (inSats === p.sats || inSats > p.sats + p.dust) break;
  }
  if (inSats < p.sats) return { kind: "insufficient", have: inSats, need: p.sats };

  let change = inSats - p.sats;
  let extraToDest = 0n;
  if (change > 0n && change <= p.dust) {
    // Every UTXO used and still a sub-dust remainder: hand it to the withdrawer.
    extraToDest = change;
    change = 0n;
  }
  const outs = change > 0n ? [p.destScriptLen, P2WPKH_SCRIPT_LEN] : [p.destScriptLen];
  const vsize = p2wpkhVsize(selected.length, outs);
  const fee = feeForVsize(vsize, p.feeRate);
  if (fee > p.maxFee) return { kind: "fee_too_high", fee, maxFee: p.maxFee };
  const pay = p.sats + extraToDest - fee;
  if (pay <= p.dust) return { kind: "below_minimum_after_fee", fee, pay };
  return { kind: "ok", inputs: selected, pay, change, fee, vsize };
}

/** Esplora tx shape used by the adopt scan. */
export interface EsploraTxLike {
  txid: string;
  fee?: number;
  vin?: { prevout?: { scriptpubkey_address?: string; value?: number } | null }[];
  vout: { scriptpubkey_address?: string; value: number }[];
}

/** A tx's network fee from Esplora data: Σprevout − Σout, cross-checked with `fee` when present. null = unknown. */
export function esploraTxFee(tx: EsploraTxLike): bigint | null {
  const vin = tx.vin || [];
  if (vin.length === 0) return null;
  let tin = 0n;
  for (const v of vin) {
    if (typeof v.prevout?.value !== "number") return null;
    tin += BigInt(v.prevout.value);
  }
  const tout = tx.vout.reduce((a, v) => a + BigInt(v.value), 0n);
  if (tin < tout) return null;
  const computed = tin - tout;
  if (typeof tx.fee === "number" && BigInt(tx.fee) !== computed) return null;
  return computed;
}

/**
 * Whether `tx` is a custody payout that settles `sats` owed to `dest` — the same rule the daemon
 * verifies: it SPENDS custody, pays dest > 0, and either pays ≥ sats (legacy full-amount form)
 * or paid + its own fee ≥ sats with fee ≤ maxFee (withdrawer-pays-fee form).
 */
export function payoutSettles(tx: EsploraTxLike, custody: string, dest: string, sats: bigint, maxFee: bigint): boolean {
  // Only a real payout SPENDS custody. A deposit has custody as an OUTPUT and its change can land
  // on any address — never adopt those.
  if (!(tx.vin || []).some((v) => v.prevout?.scriptpubkey_address === custody)) return false;
  const paid = tx.vout.filter((v) => v.scriptpubkey_address === dest).reduce((a, v) => a + BigInt(v.value), 0n);
  if (paid <= 0n) return false;
  if (paid >= sats) return true;
  const fee = esploraTxFee(tx);
  if (fee === null || fee > maxFee) return false;
  return paid + fee >= sats;
}

export interface BtcStateEntry {
  /** Destination and amount the entry was created for (must keep matching the daemon record). */
  dest: string;
  sats: string;
  /** Broadcast attempts (live only; dry-run never counts). */
  attempts: number;
  /** The payout transaction, once the network has it (accepted, seen, or adopted). */
  btcTxid?: string;
  /** Signed payout saved before broadcast; outcome not yet known to be accepted. */
  planned?: BuiltPayout;
  /** Fail-closed stop: an operator must look at this withdrawal (reason). */
  needsReview?: string;
  /** Legacy (pre-hardening) crash marker: a broadcast was in flight when the relayer stopped. */
  broadcasting?: boolean;
}
export type BtcState = Record<string, BtcStateEntry>;

export interface PendingBtcWithdrawal {
  txId: string;
  /** Destination Bitcoin address (the daemon's field is called evmAddress for all assets). */
  evmAddress: string;
  /** Satoshis owed (qBTC: 1 unit = 1 sat). */
  amountUnits: number;
}

export type BroadcastResult =
  | { kind: "accepted"; txid: string }
  | { kind: "rejected"; reason: string; inputsSpent: boolean }
  | { kind: "unknown"; reason: string };

/** A signed (not yet broadcast) payout. `pay`/`fee` (sats, decimal strings) are informational. */
export interface BuiltPayout {
  txid: string;
  rawHex: string;
  inputs: string[];
  pay?: string;
  fee?: string;
}

/** What `build` produced: a signed payout, or a fee-policy refusal (nothing signed). */
export type BuildResult =
  | ({ kind: "built" } & BuiltPayout)
  | { kind: "fee_too_high"; fee: bigint; maxFee: bigint }
  | { kind: "below_minimum_after_fee"; fee: bigint; pay: bigint };

export interface BtcPayoutDeps {
  live: boolean;
  minConfirmations: number;
  /** Per-payout cap in sats; 0n = no cap. */
  maxSats: bigint;
  maxRetries: number;
  dust: bigint;
  /** Daemon bridge health (GET /api/bridge/health): true only for an explicit healthy answer. */
  healthOk(): Promise<boolean>;
  isValidDest(addr: string): boolean;
  /** Confirmations of a txid: 0 = in mempool / not yet mined; null = could not read. */
  confirmations(txid: string): Promise<number | null>;
  /** Whether the network knows the txid (mempool or chain); null = could not read. */
  txKnown(txid: string): Promise<boolean | null>;
  /** A custody tx not in `known` that settles `sats` to `dest` (see payoutSettles); THROWS if history could not be read. */
  findExistingPayout(dest: string, sats: bigint, known: Set<string>): Promise<string | null>;
  /** Build + sign (NOT broadcast) a payout of `sats − fee` to dest, never spending `excludeInputs`
   *  ("txid:vout"). Returns a refusal instead when the fee policy forbids paying now. THROWS on
   *  other failures (e.g. insufficient custody balance). */
  build(dest: string, sats: bigint, excludeInputs: Set<string>): Promise<BuildResult>;
  broadcast(rawHex: string, expectedTxid: string): Promise<BroadcastResult>;
  fulfill(txId: string, btcTxid: string): Promise<boolean>;
  save(): void;
  log(message: string): void;
}

export type BtcOutcome =
  | "skipped_invalid"
  | "skipped_cap"
  | "needs_review"
  | "read_failed"
  | "awaiting_confirmations"
  | "fulfilled"
  | "fulfill_refused"
  | "adopted"
  | "health_blocked"
  | "gave_up"
  | "would_pay"
  | "build_failed"
  | "broadcast"
  | "broadcast_unknown"
  | "broadcast_rejected"
  | "fee_too_high"
  | "below_minimum_after_fee";

/** Every txid the relayer already attributes to some withdrawal (never adopt one of these). */
export function knownPayoutTxids(state: BtcState): Set<string> {
  const s = new Set<string>();
  for (const e of Object.values(state)) {
    if (e.btcTxid) s.add(e.btcTxid);
    if (e.planned) s.add(e.planned.txid);
  }
  return s;
}

/** Inputs held by signed-but-unsettled payouts; a new payout must not spend them. */
export function reservedInputs(state: BtcState, exceptTxId?: string): Set<string> {
  const s = new Set<string>();
  for (const [id, e] of Object.entries(state)) {
    if (id === exceptTxId || !e.planned) continue;
    for (const i of e.planned.inputs) s.add(i);
  }
  return s;
}

/**
 * Classify an Esplora POST /tx response. Esplora returns the txid on success; "already in
 * mempool / already known" means the network has these exact bytes — also a success. Any other
 * 4xx is a definite rejection (the node did not accept the tx); network errors and 5xx are
 * UNKNOWN (it may or may not have been accepted).
 */
export function classifyBroadcastResponse(status: number | null, body: string, expectedTxid: string): BroadcastResult {
  const text = (body || "").trim();
  if (status === null) return { kind: "unknown", reason: text || "no response" };
  if (status >= 200 && status < 300) {
    if (/^[0-9a-f]{64}$/i.test(text)) return { kind: "accepted", txid: text.toLowerCase() };
    return { kind: "unknown", reason: `unexpected success body: ${text.slice(0, 120)}` };
  }
  if (/already[ -](in[ -]mempool|known|have)|txn-already-(in-mempool|known)|transaction already in block chain/i.test(text)) {
    return { kind: "accepted", txid: expectedTxid };
  }
  if (status >= 400 && status < 500) {
    const inputsSpent = /missingorspent|missing[- ]inputs|txn-mempool-conflict|conflict|bad-txns-inputs/i.test(text);
    return { kind: "rejected", reason: text.slice(0, 200) || `HTTP ${status}`, inputsSpent };
  }
  return { kind: "unknown", reason: `HTTP ${status}: ${text.slice(0, 120)}` };
}

/** Decide and act on one pending qBTC withdrawal. Mutates `state` and calls deps.save() whenever it does. */
export async function processBtcWithdrawal(w: PendingBtcWithdrawal, state: BtcState, deps: BtcPayoutDeps): Promise<BtcOutcome> {
  const dest = (w.evmAddress || "").trim();
  let sats: bigint;
  try {
    sats = BigInt(w.amountUnits);
  } catch {
    deps.log(`  [invalid] ${w.txId}: amount ${String(w.amountUnits)} is not an integer number of sats`);
    return "skipped_invalid";
  }
  if (sats <= deps.dust) {
    deps.log(`  [invalid] ${w.txId}: ${sats} sats is at or below dust (${deps.dust}) — cannot pay on Bitcoin`);
    return "skipped_invalid";
  }
  if (!deps.isValidDest(dest)) {
    deps.log(`  [invalid] ${w.txId}: destination ${dest} is not a valid address on this network`);
    return "skipped_invalid";
  }
  if (deps.maxSats > 0n && sats > deps.maxSats) {
    deps.log(`  [cap] ${w.txId}: ${sats} sats exceeds BTC_MAX_WITHDRAW_SATS ${deps.maxSats} — left for manual payout`);
    return "skipped_cap";
  }

  const existingEntry = state[w.txId];
  if (existingEntry && (existingEntry.dest !== dest || existingEntry.sats !== sats.toString())) {
    existingEntry.needsReview = `daemon record changed: state has ${existingEntry.sats} → ${existingEntry.dest}, daemon now ${sats} → ${dest}`;
    deps.save();
  }
  const entry: BtcStateEntry = existingEntry ?? { dest, sats: sats.toString(), attempts: 0 };

  if (entry.needsReview) {
    deps.log(`  [review] ${w.txId}: ${entry.needsReview} — not touching it until an operator clears the state entry`);
    return "needs_review";
  }

  // 1. A payout the network has: wait for depth, then ask the daemon (which re-verifies on-chain).
  if (entry.btcTxid) {
    const confs = await deps.confirmations(entry.btcTxid);
    if (confs === null) {
      deps.log(`  [read] ${w.txId}: could not read confirmations of ${entry.btcTxid} — retry next cycle`);
      return "read_failed";
    }
    if (confs < deps.minConfirmations) {
      deps.log(`  … ${w.txId} payout ${entry.btcTxid} at ${confs}/${deps.minConfirmations} confs`);
      return "awaiting_confirmations";
    }
    if (await deps.fulfill(w.txId, entry.btcTxid)) {
      deps.log(`  ✓ fulfilled ${w.txId} via ${entry.btcTxid} (${confs} confs)`);
      return "fulfilled";
    }
    return "fulfill_refused";
  }

  // 2. A signed payout whose broadcast outcome is not settled: only ever re-send the SAME bytes.
  if (entry.planned) {
    const known = await deps.txKnown(entry.planned.txid);
    if (known === null) {
      deps.log(`  [read] ${w.txId}: could not check planned payout ${entry.planned.txid} — retry next cycle`);
      return "read_failed";
    }
    if (known) {
      entry.btcTxid = entry.planned.txid;
      delete entry.planned;
      deps.save();
      deps.log(`  [recover] ${w.txId}: planned payout ${entry.btcTxid} is on the network`);
      return "broadcast";
    }
    if (!deps.live) {
      deps.log(`  [DRY-RUN] ${w.txId}: planned payout ${entry.planned.txid} not on the network — would re-broadcast the same bytes`);
      return "would_pay";
    }
    return settleBroadcast(w.txId, entry, await deps.broadcast(entry.planned.rawHex, entry.planned.txid), deps);
  }

  // 3. Legacy crash marker from the old relayer: a broadcast may be out there without a record.
  if (entry.broadcasting) {
    let found: string | null;
    try {
      found = await deps.findExistingPayout(dest, sats, knownPayoutTxids(state));
    } catch (e) {
      deps.log(`  [read] ${w.txId}: ${(e as Error).message} — retry next cycle`);
      return "read_failed";
    }
    if (found) {
      entry.btcTxid = found;
      entry.broadcasting = false;
      deps.save();
      deps.log(`  [adopt] ${w.txId}: legacy in-flight broadcast found on-chain: ${found}`);
      return "adopted";
    }
    entry.needsReview = "legacy relayer stopped mid-broadcast and no matching payout was found — check custody history before paying";
    state[w.txId] = entry;
    deps.save();
    deps.log(`  [review] ${w.txId}: ${entry.needsReview}`);
    return "needs_review";
  }

  // 4. New payout. Gate on daemon health first: no new Bitcoin leaves while bridge state is degraded.
  if (!(await deps.healthOk())) {
    deps.log(`  [health] ${w.txId}: daemon bridge health not OK — no new payouts this cycle`);
    return "health_blocked";
  }

  // Crash-before-save recovery (old relayer or lost state file): adopt instead of paying twice.
  let existing: string | null;
  try {
    existing = await deps.findExistingPayout(dest, sats, knownPayoutTxids(state));
  } catch (e) {
    deps.log(`  [read] ${w.txId}: ${(e as Error).message} — no payout this cycle`);
    return "read_failed";
  }
  if (existing) {
    entry.btcTxid = existing;
    state[w.txId] = entry;
    deps.save();
    deps.log(`  [adopt] ${w.txId}: found existing custody payout ${existing} to ${dest} — adopting instead of re-paying`);
    return "adopted";
  }

  if (entry.attempts >= deps.maxRetries) {
    deps.log(`  [give-up] ${w.txId}: ${entry.attempts} broadcast attempts — manual review`);
    return "gave_up";
  }

  let res: BuildResult;
  try {
    res = await deps.build(dest, sats, reservedInputs(state, w.txId));
  } catch (e) {
    deps.log(`  [build] ${w.txId}: ${(e as Error).message}`);
    return "build_failed";
  }
  if (res.kind === "fee_too_high") {
    // Nothing signed, nothing persisted: fees may be lower next cycle.
    deps.log(`  [fee] ${w.txId}: network fee ${res.fee} sats exceeds BTC_MAX_NETWORK_FEE_SATS ${res.maxFee} — retry next cycle`);
    return "fee_too_high";
  }
  if (res.kind === "below_minimum_after_fee") {
    const reason = `${sats} sats owed minus ${res.fee} sats network fee leaves ${res.pay} sats (at or below dust ${deps.dust}) — not paid; needs manual handling`;
    if (deps.live) {
      entry.needsReview = reason;
      state[w.txId] = entry;
      deps.save();
    }
    deps.log(`  [review] ${w.txId}: ${reason}`);
    return "below_minimum_after_fee";
  }
  const { kind: _kind, ...built } = res;

  if (!deps.live) {
    // Dry-run: show what would be paid; persist NOTHING (no attempts, no plan).
    deps.log(`  [DRY-RUN] would pay ${w.txId}: ${sats} sats owed → ${built.pay ?? "?"} sats to ${dest} after ${built.fee ?? "?"} sats network fee (tx ${built.txid}, ${built.inputs.length} input(s)). Not broadcasting.`);
    return "would_pay";
  }

  // Save the signed bytes BEFORE they leave this machine.
  entry.planned = built;
  entry.attempts += 1;
  state[w.txId] = entry;
  deps.save();
  return settleBroadcast(w.txId, entry, await deps.broadcast(built.rawHex, built.txid), deps);
}

function settleBroadcast(txId: string, entry: BtcStateEntry, res: BroadcastResult, deps: BtcPayoutDeps): BtcOutcome {
  const planned = entry.planned!;
  if (res.kind === "accepted") {
    if (res.txid !== planned.txid) {
      entry.needsReview = `broadcast returned txid ${res.txid}, expected ${planned.txid}`;
      deps.save();
      deps.log(`  [review] ${txId}: ${entry.needsReview}`);
      return "needs_review";
    }
    entry.btcTxid = planned.txid;
    delete entry.planned;
    deps.save();
    const detail = planned.pay ? `${planned.pay} sats to ${entry.dest} + ${planned.fee} sats fee = ${entry.sats} owed` : `${entry.sats} sats → ${entry.dest}`;
    deps.log(`  → broadcast ${txId}: ${entry.btcTxid} (${detail})`);
    return "broadcast";
  }
  if (res.kind === "unknown") {
    // Keep the plan: next cycle checks whether the network has it and re-sends the same bytes.
    deps.save();
    deps.log(`  [broadcast?] ${txId}: outcome unknown (${res.reason}) — will re-check ${planned.txid}, never re-sign`);
    return "broadcast_unknown";
  }
  if (res.inputsSpent) {
    // Its coins were spent by something else — possibly an earlier payout. Never guess.
    entry.needsReview = `broadcast rejected, inputs already spent (${res.reason}) — check custody history for a payout to ${entry.dest}`;
    deps.save();
    deps.log(`  [review] ${txId}: ${entry.needsReview}`);
    return "needs_review";
  }
  // Definite rejection of a tx the network never had (e.g. fee too low): safe to drop and rebuild later.
  delete entry.planned;
  deps.save();
  deps.log(`  [broadcast] ${txId} rejected (attempt ${entry.attempts}): ${res.reason}`);
  return "broadcast_rejected";
}
