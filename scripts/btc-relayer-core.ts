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
 */

export interface BtcStateEntry {
  /** Destination and amount the entry was created for (must keep matching the daemon record). */
  dest: string;
  sats: string;
  /** Broadcast attempts (live only; dry-run never counts). */
  attempts: number;
  /** The payout transaction, once the network has it (accepted, seen, or adopted). */
  btcTxid?: string;
  /** Signed payout saved before broadcast; outcome not yet known to be accepted. */
  planned?: { txid: string; rawHex: string; inputs: string[] };
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
  /** A custody tx already paying `dest` ≥ `sats` not in `known`; THROWS if history could not be read. */
  findExistingPayout(dest: string, sats: bigint, known: Set<string>): Promise<string | null>;
  /** Build + sign (NOT broadcast) a payout, never spending `excludeInputs` ("txid:vout"). */
  build(dest: string, sats: bigint, excludeInputs: Set<string>): Promise<{ txid: string; rawHex: string; inputs: string[] }>;
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
  | "broadcast_rejected";

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

  let built: { txid: string; rawHex: string; inputs: string[] };
  try {
    built = await deps.build(dest, sats, reservedInputs(state, w.txId));
  } catch (e) {
    deps.log(`  [build] ${w.txId}: ${(e as Error).message}`);
    return "build_failed";
  }

  if (!deps.live) {
    // Dry-run: show what would be paid; persist NOTHING (no attempts, no plan).
    deps.log(`  [DRY-RUN] would pay ${w.txId}: ${sats} sats → ${dest} (tx ${built.txid}, ${built.inputs.length} input(s)). Not broadcasting.`);
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
    deps.log(`  → broadcast ${txId}: ${entry.btcTxid} (${entry.sats} sats → ${entry.dest})`);
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
