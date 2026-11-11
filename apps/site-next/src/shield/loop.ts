/**
 * The client loop of `core/shield-v2-wallet/NOTES.md` §6 — a port of the reference implementation
 * `core/shield-v2-wallet/tests/common/client_loop.rs` (`Session`), decision for decision. Method
 * names, constants and the order of every test are the reference's; where this file differs it
 * says so in a comment starting with "DIFFERS".
 *
 * Pure: no network, no storage, no WebAssembly. It is handed views of the wallet state (what
 * `summary` reports) and the answers the client collected, and it says what to do. The driver
 * that performs the calls is `client.ts` (`ShieldClient.round`, the reference's
 * `LoopClient::round_with`).
 *
 * The session is plain data (`SessionData`) so that the page can hand it from one worker to the
 * next: the worker is terminated after every payment (its WebAssembly memory is never returned),
 * and a new worker continues the SAME session — `bad`, strikes and the rest are not reset by it.
 * A new session is only what NOTES §6 calls one: the application started again, or the user's
 * explicit "try again".
 */

/** `B`: blocks asked for per page (`GET L/api/shield-v2/notes?since=…&blocks=64`). */
export const PAGE_BLOCKS = 64;
/** `P`: pages per round (the client's choice; the reference `LoopClient` uses 4). */
export const PAGES_PER_ROUND = 4;
/** `K`: consecutive rounds a listing node may fail to deliver before it is left. */
export const STRIKES = 3;
/** `W`: rounds the first state check of a state without an embargo base waits for every node. */
export const FIRST_CHECK_ROUNDS = 5;
/** `R_c`: blameless rescans in a row on one listing node at which it is left. */
export const BLAMELESS_IN_A_ROW = 2;
/** `R_t`: blameless rescans in one tenure of a listing node at which it is left (= K). */
export const BLAMELESS_PER_TENURE = 3;
/** The reports of this many rounds are handed to `confirm_state`, at most `MAX_REPORTS`. */
export const REPORT_ROUNDS = 3;
export const MAX_REPORTS = 1_024;

/** What the loop needs to know of a wallet state (fields of `summary`). */
export interface StateView {
  scanned_height: number | null;
  confirmed_height: number | null;
  /** `summary.spend_embargo.kind === "awaiting_base"` */
  awaiting_base: boolean;
  sole_copy_asserted: boolean;
  /** `summary.nodes`: the canonical configured set, in the core's order. */
  nodes: string[];
}

export type Stop =
  | { kind: "no_honest_listing_node" }
  | { kind: "fault"; message: string }
  | { kind: "pool_inactive" };

export type Decision =
  | { kind: "go" }
  | { kind: "leave"; ban: boolean; why: LeaveWhy }
  | { kind: "rescan" }
  | { kind: "reload" }
  | { kind: "wait" }
  | { kind: "stop"; stop: Stop };

export type LeaveWhy =
  | "rescans that blamed nobody"
  | "leaf_mismatch"
  | "a short page"
  | "a listing: error"
  | "not active, against its own state report"
  | "the pool is not active on this node"
  | "no answer"
  | "listing_refuted"
  | "listing_ahead"
  | "behind the quorum's tip"
  | "scanned stays above confirmed";

export interface LeavePlan {
  /** `L` after the change (`null`: every node is in `bad` — the loop stops). */
  next: number | null;
  rescan: boolean;
  ban: boolean;
  empty: boolean;
}

export interface Served {
  node: number;
  from: number;
  to: number;
}

/** A page as the loop sees it (the members of the body the core accepted). */
export interface PageView {
  active: boolean;
  from_height: number;
  next_height: number;
}

/** What `scan` reported (`ScanReport`). */
export interface ScanReportView {
  at_tip: boolean;
  leaf_mismatch: boolean;
  pool_active: boolean;
}

/** A state report, as far as the loop reads it (the core reads the whole thing). */
export interface ReportView {
  node_id: string;
  height: number;
  note_count: number;
  nullifier_count: number;
}

/** What `confirm_state` reported (`ConfirmReport`), as far as the loop reads it. */
export interface ConfirmView {
  listing_refuted: boolean;
  refuted: { from_height: number; height: number; confirmed: boolean }[];
  quorum_tip: number | null;
  matched_height: number | null;
  listing_ahead: boolean;
  embargo_base_set: boolean;
}

/** One entry of `R`: the round it was collected in and what is handed to `confirm_state`. */
export interface HeldReport<T> {
  round: number;
  item: T;
}

/** The session, as plain data (sets as sorted arrays). */
export interface SessionData {
  listing: number;
  nodes: number;
  bad: number[];
  strikes: number;
  /** `prev`: undefined = none; null = "scanned height was none". */
  prev: number | null | undefined;
  waited: number;
  unanswered: boolean;
  round: number;
  stopped: Stop | null;
  served: Served[];
  from_empty: boolean;
  origin: number | null;
  inactive: number[];
  pool_seen: number[];
  said_inactive: boolean;
  confirmed_seen: number | null;
  unrecorded_tail: boolean;
  blameless_in_a_row: number;
  blameless_on_l: number;
  leave_rescans: boolean;
}

// Option<u64> ordering of the reference: None < Some(x).
const optLt = (a: number | null, b: number | null): boolean => (a === null ? b !== null : b !== null && a < b);
const optGe = (a: number | null, b: number | null): boolean => !optLt(a, b);
const optMax = (a: number | null, b: number | null): number | null => (optLt(a, b) ? b : a);

/** The canonical form of a configured node id, as far as the client compares them (the core's
 * own canonicalisation decides what is configured; `summary.nodes` is already canonical). */
export function canonicalOrigin(id: string): string | null {
  try {
    const u = new URL(id);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

export class Session {
  d: SessionData;
  /** `R` (memory only, not part of the hand-over: it is at most three rounds old). */
  reports: HeldReport<unknown>[] = [];

  constructor(d: SessionData) {
    this.d = d;
  }

  /** The start of a session: `bad` empty, the listing node the one the state was stored with. */
  static create(nodes: number, listedFrom: number): Session {
    return new Session({
      listing: listedFrom,
      nodes,
      bad: [],
      strikes: 0,
      prev: undefined,
      waited: 0,
      unanswered: false,
      round: 0,
      stopped: null,
      served: [],
      from_empty: false,
      origin: listedFrom,
      inactive: [],
      pool_seen: [],
      said_inactive: false,
      confirmed_seen: null,
      unrecorded_tail: true,
      blameless_in_a_row: 0,
      blameless_on_l: 0,
      leave_rescans: false,
    });
  }

  /** The start of a session whose stored `listed_from` is unknown (after STOP(fault)). */
  static createUnattributed(nodes: number, start: number): Session {
    const s = Session.create(nodes, start);
    s.d.origin = null;
    return s;
  }

  get listing(): number {
    return this.d.listing;
  }

  quorum(): number {
    return Math.max(Math.floor(this.d.nodes / 2) + 1, 2);
  }

  private has(set: number[], i: number): boolean {
    return set.includes(i);
  }
  private add(set: number[], i: number): void {
    if (!set.includes(i)) {
      set.push(i);
      set.sort((a, b) => a - b);
    }
  }
  private remove(set: number[], i: number): void {
    const k = set.indexOf(i);
    if (k >= 0) set.splice(k, 1);
  }

  /** The first node after `L`, in the order of the configured set, cyclically, not in `bad`. */
  nextNode(): number | null {
    for (let k = 1; k < this.d.nodes; k++) {
      const i = (this.d.listing + k) % this.d.nodes;
      if (!this.has(this.d.bad, i)) return i;
    }
    return null;
  }

  /** A page of `L` was applied: its heights are `L`'s. */
  private serve(page: PageView): void {
    if (page.next_height <= page.from_height) return;
    const last = this.d.served[this.d.served.length - 1];
    if (last && page.from_height <= last.to) this.emptied();
    const from = this.d.served.length === 0 && this.d.from_empty ? 0 : page.from_height;
    const to = page.next_height - 1;
    const tail = this.d.served[this.d.served.length - 1];
    if (tail && tail.node === this.d.listing && tail.to + 1 === from) tail.to = to;
    else this.d.served.push({ node: this.d.listing, from, to });
  }

  /** `true`: every height of `from ..= to` that the state holds was listed by `L`. */
  listedByListingNode(from: number, to: number): boolean {
    const l = this.d.listing;
    const storedIsLs = !this.d.from_empty && this.d.origin === l;
    let cursor = from;
    for (const s of this.d.served) {
      if (s.to < cursor) continue;
      if (s.from > to) break;
      if ((s.from > cursor && !storedIsLs) || s.node !== l) return false;
      if (s.to >= to) return true;
      cursor = s.to + 1;
    }
    return storedIsLs;
  }

  private emptied(): void {
    this.d.served = [];
    this.d.from_empty = true;
    this.d.unrecorded_tail = false;
    this.d.confirmed_seen = null;
  }

  private see(state: StateView): void {
    this.d.confirmed_seen = optMax(this.d.confirmed_seen, state.confirmed_height);
    if (Session.nothingUnconfirmed(state)) this.d.unrecorded_tail = false;
  }

  unconfirmedTailIsListingNodes(): boolean {
    const l = this.d.listing;
    const c = this.d.confirmed_seen;
    return (
      (!this.d.unrecorded_tail || this.d.origin === l) &&
      this.d.served.every((s) => s.node === l || (c !== null && s.to <= c))
    );
  }

  private blamelessRescan(): Decision {
    this.d.blameless_in_a_row += 1;
    this.d.blameless_on_l += 1;
    if (this.d.blameless_in_a_row >= BLAMELESS_IN_A_ROW || this.d.blameless_on_l >= BLAMELESS_PER_TENURE) {
      this.d.leave_rescans = true;
      return { kind: "leave", ban: false, why: "rescans that blamed nobody" };
    }
    return { kind: "rescan" };
  }

  /** Step 0. `false`: the loop has stopped — nothing is asked, nothing written. */
  beginRound(): boolean {
    if (this.d.stopped) return false;
    this.d.round += 1;
    this.d.unanswered = false;
    this.d.said_inactive = false;
    return true;
  }

  static nothingUnconfirmed(state: StateView): boolean {
    return state.scanned_height === state.confirmed_height;
  }

  /** Step 1, the answer to one `scan` that succeeded. */
  afterScan(page: PageView, r: ScanReportView): Decision {
    if (!page.active || !r.pool_active) {
      this.d.said_inactive = true;
      return { kind: "go" };
    }
    this.remove(this.d.inactive, this.d.listing);
    const ownTail = this.unconfirmedTailIsListingNodes();
    this.serve(page);
    if (r.leaf_mismatch && !ownTail) return this.blamelessRescan();
    if (r.leaf_mismatch) return { kind: "leave", ban: true, why: "leaf_mismatch" };
    if (!r.at_tip && Math.max(0, page.next_height - page.from_height) < PAGE_BLOCKS) {
      return { kind: "leave", ban: true, why: "a short page" };
    }
    return { kind: "go" };
  }

  /**
   * Step 1, `scan` refused. `code` is the error's code prefix (`listing`, `rescan_required`,
   * `stale_state`, …); `notAPage` is the core's "not a listing page" mark.
   * DIFFERS: the reference matches on `WalletError`; on the WebAssembly surface the class is the
   * message's code prefix. The client normally never hands a body that is not a page to `scan`
   * (UI_CONTRACT 9); if the core says so anyway the rule is the same (no answer).
   */
  afterScanError(code: string, notAPage: boolean, message: string): Decision {
    if (notAPage) return this.afterNoAnswer();
    if (code === "listing" && !this.unconfirmedTailIsListingNodes()) return this.blamelessRescan();
    if (code === "listing") return { kind: "leave", ban: true, why: "a listing: error" };
    if (code === "rescan_required") return { kind: "rescan" };
    if (code === "stale_state") return { kind: "reload" };
    const next = this.nextNode();
    if (next !== null) this.d.listing = next;
    this.d.origin = null;
    return { kind: "stop", stop: { kind: "fault", message } };
  }

  private afterInactivePage(): Decision {
    const l = this.d.listing;
    if (this.has(this.d.pool_seen, l)) return { kind: "leave", ban: true, why: "not active, against its own state report" };
    this.add(this.d.inactive, l);
    if (this.d.inactive.length >= this.quorum()) return { kind: "stop", stop: { kind: "pool_inactive" } };
    return { kind: "leave", ban: false, why: "the pool is not active on this node" };
  }

  /** Step 2: the `active` field of each node's stats answer, as `[node, active]`. */
  afterStats(answers: [number, boolean][]): Decision {
    for (const [node, active] of answers) {
      if (node >= this.d.nodes) continue;
      if (active) this.remove(this.d.inactive, node);
      else this.add(this.d.inactive, node);
    }
    if (this.d.inactive.length >= this.quorum()) return { kind: "stop", stop: { kind: "pool_inactive" } };
    return { kind: "go" };
  }

  /** The idle loop asks again after a long interval. `bad` is kept. */
  recheckPool(): void {
    if (this.d.stopped?.kind === "pool_inactive") {
      this.d.stopped = null;
      this.d.inactive = [];
    }
  }

  /** Step 1, no answer: a strike, which no state check of this round takes back. */
  afterNoAnswer(): Decision {
    this.d.unanswered = true;
    this.d.strikes += 1;
    if (this.d.strikes >= STRIKES) return { kind: "leave", ban: false, why: "no answer" };
    return { kind: "go" };
  }

  /** Step 2: this round's answers join `R`; what is handed to `confirm_state`. */
  addReports<T>(fresh: T[]): T[] {
    const now = this.d.round;
    this.reports = this.reports.filter((r) => r.round + REPORT_ROUNDS > now);
    for (const item of fresh) this.reports.push({ round: now, item });
    const excess = Math.max(0, this.reports.length - MAX_REPORTS);
    this.reports.splice(0, excess);
    return this.reports.map((r) => r.item as T);
  }

  /** Step 2: a configured node whose report shows a pool that holds something. */
  noteReports(state: StateView, fresh: ReportView[]): void {
    this.see(state);
    for (const r of fresh) {
      if (!(r.note_count > 0 || r.nullifier_count > 0)) continue;
      const id = canonicalOrigin(r.node_id);
      const i = id === null ? -1 : state.nodes.indexOf(id);
      if (i >= 0) this.add(this.d.pool_seen, i);
    }
  }

  /** Step 2a: the first state check waits for a report from every node for one height, or W rounds. */
  firstCheckMayRun(state: StateView, fresh: ReportView[]): Decision {
    this.noteReports(state, fresh);
    if (this.d.said_inactive) return this.afterInactivePage();
    if (!state.awaiting_base || state.sole_copy_asserted) return { kind: "go" };
    const heights = [...new Set(fresh.map((r) => r.height))];
    const complete = heights.some((h) =>
      state.nodes.every((id) => fresh.some((r) => r.height === h && canonicalOrigin(r.node_id) === id)),
    );
    if (complete || this.d.waited >= FIRST_CHECK_ROUNDS) return { kind: "go" };
    this.d.waited += 1;
    return { kind: "wait" };
  }

  /** Step 3, the answer to `confirm_state`. `state`: the state that call returned. */
  afterConfirm(c: ConfirmView, atTip: boolean, state: StateView): Decision {
    if (c.embargo_base_set || !state.awaiting_base) this.d.waited = 0;
    this.see(state);
    if (c.listing_refuted) {
      const ls = c.refuted.some((r) => !r.confirmed && this.listedByListingNode(r.from_height, r.height));
      return ls ? { kind: "leave", ban: true, why: "listing_refuted" } : this.blamelessRescan();
    }
    if (c.quorum_tip !== null && optGe(state.confirmed_height, c.quorum_tip) && Session.nothingUnconfirmed(state)) {
      this.d.blameless_in_a_row = 0;
    }
    const tip = c.quorum_tip;
    if (tip === null) return { kind: "go" };
    const scanned = state.scanned_height;
    const confirmed = state.confirmed_height;
    if (!atTip && optLt(scanned, tip)) {
      this.d.prev = scanned;
      return { kind: "go" };
    }
    const ahead = c.listing_ahead;
    const short = atTip && optLt(scanned, tip);
    const prev = this.d.prev;
    const unconfirmed = prev !== undefined && optLt(confirmed, prev);
    this.d.prev = scanned;
    if (ahead || short || unconfirmed) {
      this.d.strikes += 1;
      if (this.d.strikes >= STRIKES) {
        return { kind: "leave", ban: false, why: ahead ? "listing_ahead" : short ? "behind the quorum's tip" : "scanned stays above confirmed" };
      }
    } else if (!this.d.unanswered) {
      this.d.strikes = 0;
    }
    return { kind: "go" };
  }

  /** Step 3, `confirm_state` refused: the client's own (`request:`), a bug, or `stale_state:`. */
  afterConfirmError(code: string, message: string): Decision {
    if (code === "stale_state") return { kind: "reload" };
    return { kind: "stop", stop: { kind: "fault", message } };
  }

  /** Step 5: is a payment offered in this round? */
  static mayOfferPayment(c: ConfirmView, atTip: boolean, state: StateView, canSpendNow: boolean): boolean {
    return atTip && c.matched_height !== null && state.confirmed_height === state.scanned_height && canSpendNow;
  }

  /** `LEAVE`, planned. Nothing is changed. */
  planLeave(ban: boolean, state: StateView): LeavePlan {
    const next = this.nextNode();
    const empty = state.scanned_height === null;
    if (next === null && !ban && this.d.leave_rescans) return { next: this.d.listing, rescan: true, ban, empty };
    if (next !== null) return { next, rescan: ban || this.d.leave_rescans || !Session.nothingUnconfirmed(state), ban, empty };
    if (ban) return { next: null, rescan: true, ban, empty };
    return { next: this.d.listing, rescan: false, ban, empty };
  }

  /** `LEAVE`, done: the rescanned state (if any) and the new `listed_from` are stored. */
  commitLeave(plan: LeavePlan): void {
    if (plan.ban) this.add(this.d.bad, this.d.listing);
    this.d.strikes = 0;
    this.d.prev = undefined;
    this.d.blameless_in_a_row = 0;
    this.d.blameless_on_l = 0;
    this.d.leave_rescans = false;
    if (plan.rescan || plan.empty) this.emptied();
    else this.d.unrecorded_tail = false;
    if (plan.next !== null) this.d.listing = plan.next;
    else this.d.stopped = { kind: "no_honest_listing_node" };
  }

  /** `rescan_state` without a change of node. */
  afterRescan(): void {
    this.d.prev = undefined;
    this.emptied();
  }
}
