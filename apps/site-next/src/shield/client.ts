/**
 * The shielded wallet client: the loop of NOTES §6 driven against the configured nodes, the
 * durable storage of UI_CONTRACT obligation 4, and the payments. It runs in the page's Web Worker
 * (`worker.ts`); tests run it in Node against the same WebAssembly package and a mocked node.
 *
 * `round()` is the reference's `LoopClient::round_with` (`tests/common/client_loop.rs`) with the
 * side effects made real:
 *
 * * every state the core returns is PERSISTED (compare-and-swap on the loaded record) before
 *   anything else happens; a write that fails is "another writer": the result is discarded,
 *   the record reloaded and the round ends (as `stale_state:`);
 * * LEAVE rescans and stores the state and the new `listed_from` together, and only then moves
 *   the session ("a client that cannot store the rescanned state has not left");
 * * STOP(fault) stores "`listed_from` unknown, start at the next node" with the state untouched;
 * * step 4 settles pending payments and step 5 resubmits the SAME stored envelope of a payment
 *   whose submit failed or was not answered — never a rebuild, never a timer.
 *
 * DIFFERS from the reference where the reference is not a network client:
 *   - pages are fetched (`since = summary.next_height`, `blocks = B`), classified first
 *     (obligation 9) and the core is handed the raw body; a body that is not a page is "no
 *     answer" without being handed to `scan` (the reference's `page(..) == None`);
 *   - reports are the stats answers of THIS round, labelled with the configured origin, raw;
 *     the loop reads its own copy of the fields it needs (`node-io.ts`);
 *   - the reference keeps `S` in memory; here every round starts from the stored record (another
 *     tab may have written), and a failed compare-and-swap ends the round like `stale_state:`;
 *   - the reference's step 5 is the caller's; here `offer` records whether this round offers a
 *     payment, and `buildTransfer` / `buildUnshield` refuse unless the stored revision is the one
 *     the offering round ended with.
 */
import { CoreError, core, splitStateResult, type ConfirmResultRest, type CoreApi, type ResolveRest, type ScanResultRest, type SpendStatus, type Summary } from "./core-api";
import {
  FIRST_CHECK_ROUNDS,
  PAGE_BLOCKS,
  PAGES_PER_ROUND,
  Session,
  canonicalOrigin,
  type ConfirmView,
  type Decision,
  type LeaveWhy,
  type SessionData,
  type StateView,
  type Stop,
} from "./loop";
import {
  chainIdOf,
  classifyListing,
  listingUrl,
  nextNonceOf,
  prepareStats,
  quorumValue,
  statsUrl,
  submitEnvelope,
  type Net,
  type StatsAnswer,
} from "./node-io";
import { open as openRecord, seal, type HistoryEntry, type Loaded, type Payload, type Store, type StoredEnvelope } from "./store";

export const POOL_CAP_QUANTA = 1_000_000n * 1_000_000_000n;
const RATE_SAMPLE_MS = 10 * 60_000;
const RATE_KEEP_MS = 7 * 24 * 3600_000;

export interface ClientOptions {
  api: CoreApi;
  store: Store;
  net: Net;
  /** The at-rest key (`deriveStateKey(seed)`). */
  key: CryptoKey;
  /** The record id: `<network>:<pk>`. */
  id: string;
  /** The wallet's own `rshield1…` address. */
  address: string;
  /** `export_scan_key(seed, true)` — the full scan key (secret). */
  scanKey: string;
  /** The configured, usable origins (placeholders excluded). */
  origins: string[];
  now?: () => number;
  /** Test hooks: called right after a payment's durable write, before its submit. */
  hooks?: { afterPaymentWrite?: () => void | Promise<void> };
}

export interface NodeView {
  origin: string;
  listing: boolean;
  banned: boolean;
  inactive: boolean;
  outdated: boolean;
  dissents: boolean;
  answeredStats: boolean;
}

export interface ShieldViewModel {
  address: string;
  origin: Payload["origin"];
  nodes: NodeView[];
  quorum: number;
  balances: { confirmed: string; unverified: string; locked: string; spendable: string; expected_change: string; below_minimum: { count: number; total: string }; over_capacity: { count: number; total: string }; received_spend_unknown: string; unverified_spends: boolean };
  scanned_height: number | null;
  confirmed_height: number | null;
  quorum_tip: number | null;
  spend: SpendStatus;
  awaiting_base: boolean;
  sole_copy_asserted: boolean;
  stop: Stop | null;
  /** Step 2a: waiting for every node (`waited` of W), and who did not answer this round. */
  waiting: { waited: number; of: number; missing: string[] } | null;
  /** A rescan that blamed nobody happened in the last round ("checking the wallet again"). */
  rechecking: boolean;
  pending: { id: string; kind: string; status: string; expiry_height: number; blocks_left: number | null; rejected_hint: boolean; submit: StoredEnvelope["submit"] | null; amount: string | null; to: string | null }[];
  history: HistoryEntry[];
  offer: boolean;
  shield: { available: boolean; reason: string | null; pool_total: string | null; pool_cap: string };
  rate: { blocks_per_day: number; days: number } | null;
  events: string[];
  /** How many nodes this client has left or banned since it started (the round cadence slows after one). */
  leaves: number;
}

export type PaymentResult =
  | { status: "submitted"; submit: StoredEnvelope["submit"]; id: string }
  | { status: "not_offered" }
  | { status: "not_written" }
  | { status: "needs_merge"; merges: number }
  | { status: "insufficient_funds"; have: string; need: string }
  | { status: "refused"; code: string; message: string };

const ser = (v: unknown) => JSON.stringify(v);

export class ShieldClient {
  readonly o: ClientOptions;
  loaded: Loaded | null = null;
  session: Session | null = null;
  /** The configured set as the core keeps it (canonical, in its order). */
  nodes: string[] = [];
  private lastStats: StatsAnswer[] = [];
  private lastConfirm: ConfirmResultRest | null = null;
  private offer: { ok: boolean; revision_id: string } = { ok: false, revision_id: "" };
  private rechecking = false;
  private events: string[] = [];
  private pendingShield: { unsigned: string; cm: string; expiry: number; amount: string; fee: string } | null = null;

  constructor(o: ClientOptions) {
    this.o = o;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private leaves = 0;

  private log(e: string): void {
    if (e.startsWith("left") || e.startsWith("banned")) this.leaves += 1;
    this.events = [e, ...this.events].slice(0, 30);
  }

  // ---- storage ----------------------------------------------------------------------------------

  /** Loads the stored record; null when there is none. */
  async load(): Promise<Loaded | null> {
    const record = await this.o.store.get(this.o.id);
    if (!record) return (this.loaded = null);
    const payload = await openRecord(this.o.key, record);
    return (this.loaded = { record, payload });
  }

  /** Compare-and-swap on the LOADED record; on success the loaded record is the new one. */
  private async write(next: Payload, revisionId: string): Promise<boolean> {
    const cur = this.loaded;
    // nothing changed (an inactive page, a state check that confirmed nothing new): no write —
    // the stored record stays byte for byte what it was (obligation 8)
    if (cur && cur.record.revision_id === revisionId && ser(cur.payload) === ser(next)) return true;
    const seq = cur ? cur.record.seq + 1 : 1;
    const record = await seal(this.o.key, this.o.id, seq, revisionId, next);
    const ok = await this.o.store.cas(this.o.id, cur ? { revision_id: cur.record.revision_id, seq: cur.record.seq } : null, record);
    if (ok) this.loaded = { record, payload: next };
    return ok;
  }

  private get payload(): Payload {
    if (!this.loaded) throw new Error("no state loaded");
    return this.loaded.payload;
  }

  summary(state = this.payload.state): Summary {
    return JSON.parse(core(() => this.o.api.summary(state))) as Summary;
  }

  private view(s: Summary): StateView {
    return { scanned_height: s.scanned_height, confirmed_height: s.confirmed_height, awaiting_base: s.spend_embargo?.kind === "awaiting_base", sole_copy_asserted: s.sole_copy_asserted, nodes: s.nodes };
  }

  private freshPayload(state: string, origin: Payload["origin"]): Payload {
    return { state, listed_from: null, start_node: null, origin, envelopes: [], history: [], rate: [] };
  }

  /**
   * A state for a phrase that was IMPORTED, restored, or whose origin this installation does not
   * know: under the restore embargo. Never asserts anything (UI_CONTRACT obligation 1).
   */
  private async createUnderEmbargo(): Promise<boolean> {
    const state = core(() => this.o.api.new_state(this.o.address, "", 0));
    const s = this.summary(state);
    return this.write(this.freshPayload(state, "imported"), s.revision_id);
  }

  // ---- the start of a session -------------------------------------------------------------------

  /**
   * START OF A SESSION (NOTES §6). `continued`: the session of the previous worker of this page
   * (the same session, handed over), or null for a new one.
   */
  async open(continued: SessionData | null = null): Promise<void> {
    if (!(await this.load())) {
      if (!(await this.createUnderEmbargo())) await this.load();
    }
    if (!this.loaded) throw new Error("no state");
    // A `state:` error on the STORED state: recover_locks — NEVER new_state (it has no locks).
    let s: Summary;
    try {
      s = this.summary();
    } catch (e) {
      if (!(e instanceof CoreError) || e.code !== "state") throw e;
      const r = splitStateResult<{ nodes_kept: boolean; embargo: boolean }>(core(() => this.o.api.recover_locks(this.payload.state)));
      if (!(await this.write({ ...this.payload, state: r.state, listed_from: null, start_node: null }, r.rest.revision_id))) throw new Error("stale");
      this.log(r.rest.embargo ? "recovered: under embargo" : "recovered");
      s = this.summary();
    }
    // The configured set (the user's settings). A change is LEAVE(no ban) for the session.
    const want = [...new Set(this.o.origins.map((o) => canonicalOrigin(o)).filter((o): o is string => o !== null))].sort();
    const have = [...s.nodes].sort();
    if (want.length < 3) {
      // read-only until three nodes are configured: no loop, nothing confirmed, nothing offered
      this.nodes = want;
      this.session = null;
      return;
    }
    if (ser(want) !== ser(have)) {
      const r = splitStateResult<{ nodes: string[] }>(core(() => this.o.api.set_nodes(this.payload.state, ser(want), s.revision)));
      if (r.rest.nodes.length < 3 || r.rest.nodes.length !== want.length) {
        // the core counts fewer distinct nodes than the site does (two spellings of one host):
        // read-only, the stored set untouched
        this.nodes = want;
        this.session = null;
        this.log("configured nodes: the wallet core counts fewer distinct nodes than listed");
        return;
      }
      const keep = this.payload.listed_from && r.rest.nodes.includes(this.payload.listed_from) ? this.payload.listed_from : null;
      if (!(await this.write({ ...this.payload, state: r.state, listed_from: keep, start_node: keep ? null : this.payload.start_node }, r.rest.revision_id))) throw new Error("stale");
      s = this.summary();
    }
    this.nodes = s.nodes;
    const n = s.nodes.length;
    if (continued && continued.nodes === n) {
      this.session = new Session(continued);
      return;
    }
    const lf = this.payload.listed_from ? s.nodes.indexOf(this.payload.listed_from) : -1;
    const st = this.payload.start_node ? s.nodes.indexOf(this.payload.start_node) : -1;
    if (lf >= 0) {
      this.session = Session.create(n, lf);
    } else if (this.payload.listed_from === null && st >= 0) {
      // the last session stopped on a fault: start there, the state as it is, its tail nobody's
      this.session = Session.createUnattributed(n, st);
    } else {
      // neither is known: any node, and the unconfirmed tail is thrown away
      let state = this.payload.state;
      let rid = this.loaded.record.revision_id;
      if (s.scanned_height !== s.confirmed_height) {
        const r = splitStateResult(core(() => this.o.api.rescan_state(state, "", 0, s.revision)));
        state = r.state;
        rid = r.rest.revision_id;
      }
      if (!(await this.write({ ...this.payload, state, listed_from: s.nodes[0], start_node: null }, rid))) throw new Error("stale");
      this.session = Session.create(n, 0);
    }
  }

  /** The user's explicit "try again" (or the application started again): a NEW session, `bad` empty. */
  async newSession(): Promise<void> {
    this.session = null;
    await this.open(null);
  }

  snapshot(): SessionData | null {
    return this.session ? structuredClone(this.session.d) : null;
  }

  // ---- one round --------------------------------------------------------------------------------

  /** One round of the loop. Returns the view after it. */
  async round(): Promise<ShieldViewModel> {
    const session = this.session;
    if (!session) return this.viewModel();
    if (!session.beginRound()) return this.viewModel();
    this.rechecking = false;
    this.offer = { ok: false, revision_id: "" };
    // the stored state may have been written by another tab since this one last looked
    await this.load();
    await this.roundSteps(session);
    return this.viewModel();
  }

  private async roundSteps(session: Session): Promise<void> {
    const api = this.o.api;
    const key = this.o.scanKey;
    // 1. pages from L until its tip or the page budget
    let atTip = false;
    for (let i = 0; i < PAGES_PER_ROUND; i++) {
      const s = this.summary();
      const origin = this.nodes[session.listing];
      const answer = classifyListing(await this.o.net.request(listingUrl(origin, s.next_height, PAGE_BLOCKS)));
      if (answer.kind === "none") {
        if (!(await this.apply(session.afterNoAnswer()))) return;
        break; // "otherwise go to step 2"
      }
      let d: Decision;
      let report: ScanResultRest["report"] | null = null;
      try {
        const r = splitStateResult<ScanResultRest>(core(() => api.scan(this.payload.state, answer.text, key, s.revision)));
        // persist, then decide (a state that could not be written is discarded)
        if (!(await this.write({ ...this.payload, state: r.state }, r.rest.revision_id))) return void (await this.reload());
        report = r.rest.report;
        d = session.afterScan(answer.view, report);
      } catch (e) {
        if (!(e instanceof CoreError)) throw e;
        d = session.afterScanError(e.code, e.notAPage, e.message);
      }
      if (!(await this.apply(d))) return;
      if (session.d.said_inactive) break; // nothing more to ask this node for
      if (report?.at_tip) {
        atTip = true;
        break;
      }
    }
    // 2. every node is asked at the same time; the reports of the last rounds
    const answers = await Promise.all(this.nodes.map(async (origin, node) => prepareStats(node, origin, await this.o.net.request(statsUrl(origin)))));
    this.lastStats = answers;
    const fresh = answers.flatMap((a) => (a.report ? [a.report] : []));
    let s = this.summary();
    session.noteReports(this.view(s), fresh);
    const active = answers.flatMap((a): [number, boolean][] => (a.active === null ? [] : [[a.node, a.active]]));
    if (!(await this.apply(session.afterStats(active)))) return;
    const wait = session.firstCheckMayRun(this.view(s), fresh);
    const handedIn = session.addReports(answers.flatMap((a) => (a.element === null ? [] : [a.element])));
    if (!(await this.apply(wait))) return;
    // 3. confirm_state and its rules
    let c: ConfirmResultRest;
    try {
      const r = splitStateResult<ConfirmResultRest>(core(() => api.confirm_state(this.payload.state, ser(handedIn), s.revision)));
      if (!(await this.write({ ...this.payload, state: r.state }, r.rest.revision_id))) return void (await this.reload());
      c = r.rest;
    } catch (e) {
      if (!(e instanceof CoreError)) throw e;
      await this.apply(session.afterConfirmError(e.code, e.message));
      return;
    }
    this.lastConfirm = c;
    s = this.summary();
    const cv: ConfirmView = c.report;
    if (!(await this.apply(session.afterConfirm(cv, atTip, this.view(s))))) return;
    // 4. resolve_pending → persist → tell the user
    await this.resolve();
    // 5. resubmit what failed or was not answered; is a payment offered?
    await this.resubmit();
    s = this.summary();
    const ok = Session.mayOfferPayment(cv, atTip, this.view(s), c.spend.can_spend_now);
    this.offer = { ok, revision_id: this.loaded!.record.revision_id };
  }

  private async reload(): Promise<void> {
    await this.load();
    this.log("another writer changed the state: reloaded");
  }

  /** `false`: the decision ended the round. */
  private async apply(d: Decision): Promise<boolean> {
    const session = this.session!;
    switch (d.kind) {
      case "go":
        return true;
      case "leave":
        await this.leave(d.ban, d.why);
        return false;
      case "rescan": {
        const s = this.summary();
        const r = splitStateResult(core(() => this.o.api.rescan_state(this.payload.state, "", 0, s.revision)));
        if (!(await this.write({ ...this.payload, state: r.state }, r.rest.revision_id))) {
          await this.reload();
          return false;
        }
        session.afterRescan();
        this.rechecking = true;
        this.log("checking the wallet again (rescan)");
        return false;
      }
      case "reload":
        await this.reload();
        return false;
      case "wait":
        return false;
      case "stop":
        session.d.stopped = d.stop;
        if (d.stop.kind === "fault") {
          // the fault does not pin L: listed_from unknown, start at the next node; S untouched
          await this.write({ ...this.payload, listed_from: null, start_node: this.nodes[session.listing] }, this.loaded!.record.revision_id);
          this.log(`stopped: ${d.stop.message}`);
        }
        return false;
    }
  }

  private async leave(ban: boolean, why: LeaveWhy): Promise<void> {
    const session = this.session!;
    const s = this.summary();
    const plan = session.planLeave(ban, this.view(s));
    let state = this.payload.state;
    let rid = this.loaded!.record.revision_id;
    if (plan.rescan) {
      const r = splitStateResult(core(() => this.o.api.rescan_state(state, "", 0, s.revision)));
      state = r.state;
      rid = r.rest.revision_id;
    }
    const listed = plan.next === null ? null : this.nodes[plan.next];
    if (!(await this.write({ ...this.payload, state, listed_from: listed, start_node: null }, rid))) {
      await this.reload(); // not left
      return;
    }
    const from = this.nodes[session.listing];
    session.commitLeave(plan);
    if (plan.rescan && !ban) this.rechecking = true;
    this.log(`${ban ? "banned" : "left"} ${from}: ${why}${plan.next === null ? "; no honest listing node reachable" : `; listing from ${this.nodes[plan.next]}`}`);
  }

  // ---- step 4 and 5 -----------------------------------------------------------------------------

  private async resolve(): Promise<void> {
    const s = this.summary();
    const r = splitStateResult<ResolveRest>(core(() => this.o.api.resolve_pending(this.payload.state, s.revision)));
    const settled = new Map<string, HistoryEntry["outcome"]>();
    for (const [list, outcome] of [[r.rest.mined, "mined"], [r.rest.superseded, "superseded"], [r.rest.expired, "expired"]] as const) {
      for (const p of list) if (p.nullifiers[0]) settled.set(p.nullifiers[0], outcome);
    }
    // own shields: mined when the note is confirmed in the state, expired at their expiry
    const after = this.summary(r.state);
    const confirmedCms = new Set(after.notes.filter((n) => n.confirmed).map((n) => n.cm));
    for (const e of this.payload.envelopes) {
      if (e.kind !== "shield") continue;
      if (e.cm && confirmedCms.has(e.cm)) settled.set(e.id, "mined");
      else if (after.confirmed_height !== null && after.confirmed_height >= e.expiry_height) settled.set(e.id, "expired");
    }
    const tip = this.lastConfirm?.report.quorum_tip ?? null;
    const rate = this.sampleRate(tip);
    const envelopes = this.payload.envelopes.filter((e) => !settled.has(e.id));
    const history = this.payload.history.map((h) => (settled.has(h.id) ? { ...h, outcome: settled.get(h.id)! } : h));
    const changed = r.rest.revision_id !== this.loaded!.record.revision_id || settled.size > 0 || rate !== this.payload.rate;
    if (!changed) return;
    if (!(await this.write({ ...this.payload, state: r.state, envelopes, history, rate }, r.rest.revision_id))) return void (await this.reload());
    for (const [id, outcome] of settled) this.log(`payment ${id.slice(0, 8)}…: ${outcome}`);
  }

  private sampleRate(tip: number | null): Payload["rate"] {
    const rate = this.payload.rate ?? [];
    if (tip === null) return rate;
    const now = this.now();
    const last = rate[rate.length - 1];
    if (last && now - last[0] < RATE_SAMPLE_MS) return rate;
    return [...rate.filter(([t]) => now - t <= RATE_KEEP_MS), [now, tip]];
  }

  /** Step 5: the SAME stored envelope, again, for every payment whose submit failed or was not answered. */
  private async resubmit(): Promise<void> {
    const pendingIds = new Set(this.summary().pending.map((p) => p.nullifiers[0]));
    for (const e of this.payload.envelopes) {
      if (e.submit === "accepted") continue;
      if (e.kind !== "shield" && !pendingIds.has(e.id)) continue;
      await this.submit(e);
    }
  }

  /** Submits a stored envelope (the listing node first, then the others) and records the answer. */
  private async submit(e: StoredEnvelope): Promise<StoredEnvelope["submit"]> {
    const order = this.session ? [...this.nodes.slice(this.session.listing), ...this.nodes.slice(0, this.session.listing)] : this.nodes;
    let result: StoredEnvelope["submit"] = "unanswered";
    for (const origin of order) {
      const r = await submitEnvelope(this.o.net, origin, e.envelope);
      if (r === "accepted") {
        result = "accepted";
        break;
      }
      if (r === "failed") result = "failed";
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const p = this.payload;
      const envelopes = p.envelopes.map((x) => (x.id === e.id ? { ...x, submit: result, attempts: x.attempts + 1 } : x));
      let state = p.state;
      let rid = this.loaded!.record.revision_id;
      if (result === "failed" && e.kind !== "shield") {
        // a hint for the UI: "the node refused it; it is still pending until block N" — releases nothing
        try {
          const r = splitStateResult(core(() => this.o.api.note_rejection(state, e.id, this.summary(state).revision)));
          state = r.state;
          rid = r.rest.revision_id;
        } catch {
          /* the entry is gone (settled meanwhile): nothing to mark */
        }
      }
      if (await this.write({ ...p, state, envelopes }, rid)) break;
      await this.load();
    }
    return result;
  }

  // ---- payments ---------------------------------------------------------------------------------

  /** Whether this round offered a payment AND nothing was written since (NOTES §6 step 5). */
  private offered(): boolean {
    return this.offer.ok && !!this.loaded && this.offer.revision_id === this.loaded.record.revision_id;
  }

  /** The chain id a quorum of the configured nodes agrees on (`/api/health`). */
  async chainId(): Promise<string | null> {
    const ids = await Promise.all(this.nodes.map(async (o) => chainIdOf(await this.o.net.request(`${o}/api/health`))));
    return quorumValue(ids, this.nodes.length);
  }

  private async stored(next: Payload, revisionId: string): Promise<boolean> {
    return this.write(next, revisionId);
  }

  private async lockedPayment(kind: "transfer" | "unshield", seed: Uint8Array, params: Record<string, unknown>, amount: string, fee: string, to: string): Promise<PaymentResult> {
    await this.load();
    if (!this.offered()) return { status: "not_offered" };
    const chainId = await this.chainId();
    if (!chainId) return { status: "refused", code: "chain_id", message: "no quorum on the chain id" };
    const s = this.summary();
    const plan = JSON.parse(core(() => this.o.api.plan_payment(this.payload.state, amount, fee, false))) as
      | { status: "ok"; selection: { positions: number[] } }
      | { status: "needs_merge"; merges: number }
      | { status: "insufficient_funds"; have: string; need: string };
    if (plan.status === "needs_merge") return plan;
    if (plan.status === "insufficient_funds") return plan;
    const full = { chain_id: chainId, inputs: plan.selection.positions, fee, ...params };
    let text: string;
    try {
      text = core(() =>
        kind === "transfer"
          ? this.o.api.build_transfer(seed, this.payload.state, ser(full), s.revision)
          : this.o.api.build_unshield(seed, this.payload.state, ser(full), s.revision),
      );
    } catch (e) {
      if (!(e instanceof CoreError)) throw e;
      return { status: "refused", code: e.code, message: e.message };
    }
    const r = splitStateResult<{ envelope_json: string; nullifiers: [string, string]; expiry_height: number }>(text);
    const id = r.rest.nullifiers[0];
    const env: StoredEnvelope = { id, kind, envelope: r.rest.envelope_json, expiry_height: r.rest.expiry_height, submit: "unsent", attempts: 0 };
    const hist: HistoryEntry = { id, kind, amount, fee, to, expiry_height: r.rest.expiry_height, outcome: "pending", at: this.now() };
    // PERSIST { state, envelope } in ONE storage transaction, then submit. Not written ⇒ discard.
    const p = this.payload;
    if (!(await this.stored({ ...p, state: r.state, envelopes: [...p.envelopes, env], history: [...p.history, hist] }, r.rest.revision_id))) {
      await this.reload();
      return { status: "not_written" };
    }
    this.offer = { ok: false, revision_id: "" };
    await this.o.hooks?.afterPaymentWrite?.();
    const submit = await this.submit(env);
    this.log(`${kind} built and submitted: ${submit}`);
    return { status: "submitted", submit, id };
  }

  /** A private transfer to a shielded address. `seed` is wiped by the caller. */
  buildTransfer(seed: Uint8Array, recipient: string, amount: string, fee: string, recipientFingerprint: string): Promise<PaymentResult> {
    return this.lockedPayment("transfer", seed, { recipient, amount }, amount, fee, recipientFingerprint);
  }

  /** An unshield to a `rouge1…` address: `v_out` leaves the pool, `fee` on top. */
  buildUnshield(seed: Uint8Array, to: string, vOut: string, fee: string): Promise<PaymentResult> {
    return this.lockedPayment("unshield", seed, { to, v_out: vOut }, vOut, fee, to);
  }

  /** The shield context from the last round's answers: a quorum on the latest root and tip. */
  shieldContext(): { anchor: string; anchor_height: number; pool_total: string | null } | null {
    const v = quorumValue(
      this.lastStats.map((a) => (a.pool?.latest_anchor && a.pool.tip_height !== null ? { anchor: a.pool.latest_anchor, anchor_height: a.pool.tip_height } : null)),
      this.nodes.length,
    );
    if (!v) return null;
    const total = quorumValue(this.lastStats.map((a) => a.pool?.pool_total_quanta ?? null), this.nodes.length);
    return { ...v, pool_total: total };
  }

  /**
   * Step one of a shield to the wallet's own address: builds (proves) it, records its note in the
   * state, PERSISTS the state, and returns the bytes the account key signs. Not gated by the
   * embargo (UI_CONTRACT: "an embargoed wallet can still shield from its public account").
   */
  async prepareShield(fromPubKey: string, vIn: string, fee: string): Promise<{ status: "sign"; signing_bytes: string } | PaymentResult> {
    await this.load();
    if (!this.session) return { status: "not_offered" };
    const ctx = this.shieldContext();
    if (!ctx) return { status: "refused", code: "anchor", message: "the nodes do not agree on the pool's latest root yet" };
    const noteValue = BigInt(vIn) - BigInt(fee);
    if (ctx.pool_total !== null && BigInt(ctx.pool_total) + noteValue > POOL_CAP_QUANTA) return { status: "refused", code: "pool_cap", message: "above the pool cap" };
    const chainId = await this.chainId();
    if (!chainId) return { status: "refused", code: "chain_id", message: "no quorum on the chain id" };
    const nonces = await Promise.all(this.nodes.map(async (o) => nextNonceOf(await this.o.net.request(`${o}/api/account/${fromPubKey}/nonce`))));
    const nonce = quorumValue(nonces, this.nodes.length);
    if (nonce === null) return { status: "refused", code: "nonce", message: "no quorum on the account nonce" };
    const params = { chain_id: chainId, anchor: ctx.anchor, anchor_height: ctx.anchor_height, from_pub_key: fromPubKey, nonce, v_in: vIn, fee, recipient: this.o.address };
    const s = this.summary();
    let text: string;
    try {
      text = core(() => this.o.api.build_own_shield(this.payload.state, this.o.address, ser(params), s.revision));
    } catch (e) {
      if (!(e instanceof CoreError)) throw e;
      return { status: "refused", code: e.code, message: e.message };
    }
    const r = splitStateResult<{ envelope_json: string; signing_bytes: string; expiry_height: number; outputs: { role: string; cm: string }[] }>(text);
    const cm = r.rest.outputs.find((o) => o.role === "payment")?.cm ?? r.rest.outputs[0].cm;
    if (!(await this.write({ ...this.payload, state: r.state }, r.rest.revision_id))) {
      await this.reload();
      return { status: "not_written" };
    }
    this.pendingShield = { unsigned: r.rest.envelope_json, cm, expiry: r.rest.expiry_height, amount: noteValue.toString(), fee };
    return { status: "sign", signing_bytes: r.rest.signing_bytes };
  }

  /** Step two: the account signature attached, the envelope STORED, then submitted. */
  async completeShield(sigHex: string): Promise<PaymentResult> {
    const ps = this.pendingShield;
    if (!ps) return { status: "not_offered" };
    this.pendingShield = null;
    let envelope: string;
    try {
      envelope = core(() => this.o.api.attach_signature(ps.unsigned, sigHex));
    } catch (e) {
      if (!(e instanceof CoreError)) throw e;
      return { status: "refused", code: e.code, message: e.message };
    }
    await this.load();
    const id = `shield:${ps.cm}`;
    const env: StoredEnvelope = { id, kind: "shield", envelope, expiry_height: ps.expiry, cm: ps.cm, submit: "unsent", attempts: 0 };
    const hist: HistoryEntry = { id, kind: "shield", amount: ps.amount, fee: ps.fee, to: "self", expiry_height: ps.expiry, outcome: "pending", at: this.now() };
    const p = this.payload;
    if (!(await this.write({ ...p, envelopes: [...p.envelopes, env], history: [...p.history, hist] }, this.loaded!.record.revision_id))) {
      await this.reload();
      return { status: "not_written" };
    }
    await this.o.hooks?.afterPaymentWrite?.();
    const submit = await this.submit(env);
    this.log(`shield signed and submitted: ${submit}`);
    return { status: "submitted", submit, id };
  }

  /** The user pressed "submit again" for a stored envelope: the SAME envelope. */
  async resubmitOne(id: string): Promise<StoredEnvelope["submit"] | null> {
    await this.load();
    const e = this.payload.envelopes.find((x) => x.id === id);
    return e ? this.submit(e) : null;
  }

  /**
   * UI_CONTRACT obligation 1 (b): the user was shown, and explicitly confirmed, the sentence
   * "No other device, old backup or lost device holds this wallet with a payment that has not
   * been confirmed or expired. If that is wrong, a payment can be made twice." The ONLY call site
   * of `assert_sole_copy` for an existing state; reached from the confirmation dialog alone.
   */
  async confirmSoleCopyAfterExplicitStatement(userConfirmedTheStatement: true): Promise<boolean> {
    if (userConfirmedTheStatement !== true) return false;
    await this.load();
    const s = this.summary();
    try {
      const r = splitStateResult(core(() => this.o.api.assert_sole_copy(this.payload.state, true, s.revision)));
      return this.write({ ...this.payload, state: r.state }, r.rest.revision_id);
    } catch (e) {
      if (e instanceof CoreError) return false; // after the first confirmed check the core refuses it
      throw e;
    }
  }

  // ---- what the page shows ----------------------------------------------------------------------

  viewModel(): ShieldViewModel {
    const p = this.loaded?.payload;
    const s = p ? this.summary() : null;
    const session = this.session;
    const c = this.lastConfirm;
    const outdated = new Set(c?.outdated_nodes ?? []);
    const dissent = new Set((c?.report.dissenting ?? []).map((d) => d.node_id));
    const answered = new Set(this.lastStats.filter((a) => a.report).map((a) => a.origin));
    const nodes: NodeView[] = this.nodes.map((origin, i) => ({
      origin,
      listing: session?.listing === i,
      banned: !!session?.d.bad.includes(i),
      inactive: !!session?.d.inactive.includes(i),
      outdated: outdated.has(origin),
      dissents: dissent.has(origin),
      answeredStats: answered.has(origin),
    }));
    const waiting =
      session && s && s.spend_embargo?.kind === "awaiting_base" && !s.sole_copy_asserted && session.d.waited > 0
        ? { waited: session.d.waited, of: FIRST_CHECK_ROUNDS, missing: this.nodes.filter((o) => !answered.has(o)) }
        : null;
    const hist = new Map((p?.history ?? []).map((h) => [h.id, h]));
    const env = new Map((p?.envelopes ?? []).map((e) => [e.id, e]));
    const confirmed = s?.confirmed_height ?? null;
    const pending: ShieldViewModel["pending"] = (s?.pending ?? []).map((x) => {
      const id = x.nullifiers[0];
      return {
        id,
        kind: x.tx_type === "unshield_v2" ? "unshield" : "transfer",
        status: x.status,
        expiry_height: x.expiry_height,
        blocks_left: confirmed === null ? null : Math.max(0, x.expiry_height - confirmed),
        rejected_hint: x.rejected_hint,
        submit: env.get(id)?.submit ?? null,
        amount: hist.get(id)?.amount ?? null,
        to: hist.get(id)?.to ?? null,
      };
    });
    for (const e of p?.envelopes ?? []) {
      if (e.kind !== "shield") continue;
      pending.push({ id: e.id, kind: "shield", status: "pending", expiry_height: e.expiry_height, blocks_left: confirmed === null ? null : Math.max(0, e.expiry_height - confirmed), rejected_hint: false, submit: e.submit, amount: hist.get(e.id)?.amount ?? null, to: "self" });
    }
    const ctx = this.session ? this.shieldContext() : null;
    const empty = { count: 0, total: "0" };
    return {
      address: this.o.address,
      origin: p?.origin ?? "imported",
      nodes,
      quorum: s?.quorum ?? 0,
      balances: {
        confirmed: s?.confirmed_balance ?? "0",
        unverified: s?.unverified_balance ?? "0",
        locked: s?.locked_balance ?? "0",
        spendable: s?.spendable_balance ?? "0",
        expected_change: s?.expected_change ?? "0",
        below_minimum: s?.below_minimum ?? empty,
        over_capacity: s?.over_capacity ?? empty,
        received_spend_unknown: s?.received_spend_unknown ?? "0",
        unverified_spends: s?.unverified_spends ?? false,
      },
      scanned_height: s?.scanned_height ?? null,
      confirmed_height: confirmed,
      quorum_tip: c?.report.quorum_tip ?? null,
      spend: c?.spend ?? s?.spend ?? ({ can_spend_now: false, reason: "no_nodes" } as SpendStatus),
      awaiting_base: s?.spend_embargo?.kind === "awaiting_base",
      sole_copy_asserted: s?.sole_copy_asserted ?? false,
      stop: session?.d.stopped ?? null,
      waiting,
      rechecking: this.rechecking,
      pending,
      history: [...(p?.history ?? [])].reverse(),
      offer: this.offered(),
      shield: { available: !!ctx, reason: !this.session ? "nodes" : ctx ? null : "anchor", pool_total: ctx?.pool_total ?? null, pool_cap: POOL_CAP_QUANTA.toString() },
      rate: rateOf(p?.rate ?? []),
      events: this.events,
      leaves: this.leaves,
    };
  }
}

/** Blocks per day over the observed samples (at least an hour of them), and the period in days. */
export function rateOf(rate: [number, number][]): { blocks_per_day: number; days: number } | null {
  if (rate.length < 2) return null;
  const [t0, h0] = rate[0];
  const [t1, h1] = rate[rate.length - 1];
  const ms = t1 - t0;
  if (ms < 3600_000 || h1 < h0) return null;
  const days = ms / 86_400_000;
  return { blocks_per_day: (h1 - h0) / days, days };
}

/**
 * A state for a phrase GENERATED on this device in this installation, made in the same user
 * action that generated it (UI_CONTRACT obligation 1 (a)): the only place where
 * `assert_sole_copy` is called without asking. Called from the wallet's "create new phrase" and
 * nowhere else. Writes only if no state exists for this wallet yet.
 */
export async function stateForNewlyGeneratedPhrase(api: CoreApi, store: Store, key: CryptoKey, id: string, address: string): Promise<boolean> {
  const fresh = core(() => api.new_state(address, "", 0));
  const r = splitStateResult(core(() => api.assert_sole_copy(fresh, true, 0)));
  const payload: Payload = { state: r.state, listed_from: null, start_node: null, origin: "generated", envelopes: [], history: [], rate: [] };
  const record = await seal(key, id, 1, r.rest.revision_id, payload);
  return store.cas(id, null, record);
}

/**
 * A phrase was IMPORTED (or restored from a backup) on this installation. A state left here by an
 * earlier "create new phrase" carries the statement that no other copy exists; the phrase may
 * since have been used elsewhere (the wallet removed, the phrase restored on another device). If
 * that state never had a confirmed check and holds no payment of its own, it is replaced with a
 * fresh state under the restore embargo (UI_CONTRACT obligation 1: a restored phrase never inherits
 * the statement). A state with a confirmed check or a stored payment is kept: it is this device's
 * own record, and the embargo no longer applies to it in any case.
 */
export async function dropUnconfirmedGeneratedState(api: CoreApi, store: Store, key: CryptoKey, id: string, address: string): Promise<boolean> {
  const rec = await store.get(id);
  if (!rec) return false;
  const p = await openRecord(key, rec);
  if (p.origin !== "generated" || p.envelopes.length > 0 || p.history.length > 0) return false;
  const s = JSON.parse(core(() => api.summary(p.state))) as Summary;
  if (s.confirmed_height !== null) return false;
  const fresh = core(() => api.new_state(address, "", 0));
  const fs = JSON.parse(core(() => api.summary(fresh))) as Summary;
  const payload: Payload = { state: fresh, listed_from: null, start_node: null, origin: "imported", envelopes: [], history: [], rate: [] };
  const next = await seal(key, id, rec.seq + 1, fs.revision_id, payload);
  return store.cas(id, { revision_id: rec.revision_id, seq: rec.seq }, next);
}

