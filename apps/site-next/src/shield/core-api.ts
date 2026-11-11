/**
 * The WebAssembly package's surface as the client uses it, and the two things every call result
 * needs: the error's code, and the state TEXT the core returned.
 *
 * UI_CONTRACT obligation 4: "the state is opaque. It is stored as the text the core returned,
 * never edited, never re-serialised, never assembled from parts." A result that carries a state
 * is `{"state":<the state's JSON>,"revision":n,"revision_id":"…",…}` (`out_with_state` in
 * `core/shield-v2-wasm/src/api.rs`): `splitStateResult` cuts the state's text out of it with a
 * string-aware scanner — it is never parsed and written back.
 */
import type * as Pkg from "./vendor/quantum_vault_shield_v2_wasm";

/** The exports the client calls (a subset of the 26). The worker passes the module itself. */
export type CoreApi = Pick<
  typeof Pkg,
  | "constants"
  | "shielded_address"
  | "parse_address"
  | "export_scan_key"
  | "new_state"
  | "assert_sole_copy"
  | "can_spend_now"
  | "recover_locks"
  | "set_nodes"
  | "scan"
  | "summary"
  | "plan_payment"
  | "build_own_shield"
  | "build_shield"
  | "attach_signature"
  | "build_transfer"
  | "build_unshield"
  | "note_rejection"
  | "resolve_pending"
  | "confirm_state"
  | "rescan_state"
>;

/** An error of the core: `code` is the stable prefix (`listing`, `stale_state`, …). */
export class CoreError extends Error {
  readonly code: string;
  constructor(message: string) {
    super(message);
    const m = /^([a-z_]+):/.exec(message);
    this.code = m ? m[1] : "unknown";
  }
  /** The core's mark for a body that is not a listing page at all ("no answer"). */
  get notAPage(): boolean {
    return this.code === "listing" && /^listing: (page \d+: )?note listing: not a listing page/.test(this.message);
  }
}

/** Runs a core call; a thrown error becomes a `CoreError` (a trap stays what it is). */
export function core<T extends string>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (typeof WebAssembly !== "undefined" && e instanceof WebAssembly.RuntimeError) throw e;
    throw new CoreError(e instanceof Error ? e.message : String(e));
  }
}

/**
 * The end index (exclusive) of the JSON value that starts at `start`: knows strings (a backslash
 * skips a character) and counts brackets; reads nothing else.
 */
export function jsonValueEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') {
        inString = false;
        if (depth === 0) return i + 1;
      }
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i + 1;
    } else if (depth === 0 && (c === "," || c === "}")) return i;
  }
  throw new Error("result encoding: unterminated value");
}

const PREFIX = '{"state":';

/** A result with a state: the state's TEXT, and the other members parsed. */
export function splitStateResult<R extends object = Record<string, unknown>>(text: string): { state: string; rest: R & { revision: number; revision_id: string } } {
  if (!text.startsWith(PREFIX)) throw new Error("result encoding: no state");
  const end = jsonValueEnd(text, PREFIX.length);
  const state = text.slice(PREFIX.length, end);
  const tail = text.slice(end);
  if (!tail.startsWith(",")) throw new Error("result encoding: no revision");
  const rest = JSON.parse("{" + tail.slice(1)) as R & { revision: number; revision_id: string };
  return { state, rest };
}

/** The `summary` fields the client reads (never forwarded to the page as a whole: notes hold secrets). */
export interface Summary {
  revision: number;
  revision_id: string;
  confirmed_balance: string;
  unverified_balance: string;
  locked_balance: string;
  spendable_balance: string;
  expected_change: string;
  unverified_spends: boolean;
  received_spend_unknown: string;
  view_only_since: number | null;
  spend: SpendStatus;
  spend_embargo: { kind: string; until?: number; base?: number; first_confirmed?: number; waived?: boolean };
  sole_copy_asserted: boolean;
  own_shields: number;
  nodes: string[];
  quorum: number;
  next_height: number;
  scanned_height: number | null;
  confirmed_height: number | null;
  below_minimum: { count: number; total: string };
  over_capacity: { count: number; total: string };
  pending: PendingTx[];
  notes: { value: string; spent: boolean; confirmed: boolean; position: number; height: number; cm: string }[];
}

export interface SpendStatus {
  can_spend_now: boolean;
  reason: string | null;
  confirmed_height: number | null;
  confirmed_lag: number | null;
  usable_window_blocks: number | null;
  embargo_until: number | null;
  embargo_blocks_left: number | null;
  view_only_since: number | null;
  default_expiry_blocks: number;
  max_expiry_blocks: number;
  restore_embargo_blocks: number;
  restore_lag_bound_blocks: number;
}

export interface PendingTx {
  tx_type: string;
  nullifiers: string[];
  outputs: string[];
  input_total: string;
  change: { cm: string; value: string; r: string | null } | null;
  own_payment: { cm: string; value: string; r: string | null } | null;
  expiry_height: number;
  status: "pending" | "seen_mined" | "seen_superseded";
  seen_height: number | null;
  rejected_hint: boolean;
  abandoned_hint: boolean;
}

export interface ConfirmResultRest {
  report: {
    matched_height: number | null;
    confirmed_height: number | null;
    dissenting: { node_id: string; height: number }[];
    diverged: boolean;
    listing_refuted: boolean;
    refuted: { from_height: number; height: number; confirmed: boolean }[];
    quorum_tip: number | null;
    listing_ahead: boolean;
    confirmed_lag: number | null;
    embargo_base_set: boolean;
    all_reported: boolean;
  };
  malformed: number;
  outdated_nodes: string[];
  spend: SpendStatus;
}

export interface ScanResultRest {
  report: { at_tip: boolean; leaf_mismatch: boolean; pool_active: boolean; next_height: number; received: number[] };
  scanned_height: number | null;
}

export interface ResolveRest {
  mined: PendingTx[];
  superseded: PendingTx[];
  expired: PendingTx[];
  still_pending: number;
}
