/* tslint:disable */
/* eslint-disable */

/** Decimal string of quanta (1 XRGE = 10^9 quanta). */
export type Quanta = string;
/** Lowercase hexadecimal. */
export type Hex = string;

export interface ShieldConstants { min_fee_quanta: Quanta; pool_cap_quanta: Quanta; anchor_window: number; max_proof_bytes: number; body_bytes: number; quanta_per_xrge: Quanta; default_expiry_offset: number; max_expiry_offset: number; default_max_fee_quanta: Quanta; min_configured_nodes: number; max_configured_nodes: number; default_min_note_value: Quanta; default_max_unspent_notes: number; max_unspent_notes_limit: number; max_spent_retained: number; prune_retention_blocks: number; state_version: number; address_version: number; }
export interface AddressInfo { address: string; pk: Hex; fingerprint: Hex; }
/** `nk: null` is the viewing key alone: finds notes, cannot see spends. Neither can spend. SECRET. */
export interface ScanKey { pk: Hex; nk: Hex | null; dk: Hex; }
/** `confirmed: false` = known from one node's listing only (show as unconfirmed). SECRET (`value`, `r`). */
export interface OwnedNote { value: Quanta; r: Hex; rho: Hex; position: number; cm: Hex; nullifier: Hex | null; spent: boolean; spent_height: number | null; height: number; tx_hash: Hex | ""; output_index: 0 | 1; confirmed: boolean; }
/** Opaque to the client: persist it (encrypted) and pass it back. */
export type WalletState = object;
/** `expected_change` is for display only and is in none of the other figures. */
export interface Balances { confirmed_balance: Quanta; unverified_balance: Quanta; locked_balance: Quanta; spendable_balance: Quanta; expected_change: Quanta; /** true: scanned without the nullifier key; spends are not seen, spendable is 0 */ unverified_spends: boolean; /** received for certain, spent or not unknown; in no balance */ received_spend_unknown: Quanta; view_only_since: number | null; }
/** Every figure is a number of BLOCKS (the chain has no block time). `reason`: no_nodes | view_only | no_quorum | embargo | root_unconfirmed | window_too_short. */
export interface SpendStatus { can_spend_now: boolean; reason: string | null; confirmed_height: number | null; confirmed_lag: number | null; usable_window_blocks: number | null; embargo_until: number | null; embargo_blocks_left: number | null; view_only_since: number | null; default_expiry_blocks: number; max_expiry_blocks: number; restore_embargo_blocks: number; restore_lag_bound_blocks: number; }
/** `embargo: true` (or `entries_unreadable > 0`): the recovered state is under the restore embargo. */
export interface Recovery { state: WalletState; revision: number; revision_id: Hex; entries_kept: number; entries_unreadable: number; expiry_unknown: boolean; nodes_kept: boolean; embargo: boolean; }
/** The revision of the returned state: store it with the state, pass the STORED one as `expected_revision`. */
export interface Revised { state: WalletState; revision: number; /** the IDENTITY of the returned state: store it with the state and compare-and-swap on it */ revision_id: Hex; }
/** The canonical configured set (http(s) origins) and the quorum `confirm_state` applies: a strict majority of it, at least 2. */
export interface NodesResult extends Revised { nodes: string[]; quorum: number; }
/** What ONE node's listing says. `pending_seen_*` settle nothing: only `resolve_pending` does. */
export interface ScanReport { txs: number; received: number[]; spent: number[]; pending_seen_mined: number; pending_seen_superseded: number; not_stored: number; own_outputs_from_record: number; spent_dropped: number; next_height: number; at_tip: boolean; /** true: the page is numbered below the wallet's own tree: rescan_state, then another node */ leaf_mismatch: boolean; /** false: the node answered `"active": false` — the shielded pool is not active on that node. Nothing was read, the state is unchanged. Not an empty pool, not an error, not evidence against the node (NOTES.md §6) */ pool_active: boolean; }
export interface ScanResult extends Balances, Revised { report: ScanReport; anchor: Hex; scanned_height: number | null; }
export interface ScanPagesResult extends Balances, Revised { report: ScanReport[]; anchor: Hex; scanned_height: number | null; }
/** A note the transaction creates for this wallet. SECRET (`value`, `r`). `r` is null only in an entry migrated from an older state. */
export interface OwnOutput { cm: Hex; value: Quanta; r: Hex | null; }
/** `status` is what the scan has SEEN (one node's listing); the inputs are locked in every status. `outputs`: cm_out1, cm_out2. `rejected_hint` / `abandoned_hint` are hints for display and release nothing. */
/** `inputs` is DERIVED (where the state holds the notes); an entry is held by `input_cms` and `nullifiers`. */
export interface PendingTx { tx_type: "shielded_transfer_v2" | "unshield_v2" | ""; nullifiers: Hex[]; outputs: Hex[]; inputs: number[]; input_cms: Hex[]; input_total: Quanta; change: OwnOutput | null; own_payment: OwnOutput | null; expiry_height: number; status: "pending" | "seen_mined" | "seen_superseded"; seen_height: number | null; rejected_hint: boolean; abandoned_hint: boolean; legacy: boolean; }
export interface Tally { count: number; total: Quanta; }
export interface StateSummary extends Balances { revision: number; revision_id: Hex; spend: SpendStatus; spend_embargo: object; sole_copy_asserted: boolean; own_shields: number; anchor: Hex; nullifier_acc: Hex; nullifier_count: number; ciphertext_acc: Hex; nodes: string[]; quorum: number; max_unspent_notes: number; next_height: number; scanned_height: number | null; confirmed_height: number | null; note_count: number; min_note_value: Quanta; below_minimum: Tally; over_capacity: Tally; pruned: Tally; notes: OwnedNote[]; pending: PendingTx[]; }
export interface Selection { positions: number[]; total: Quanta; change: Quanta; change_below_minimum: boolean; }
export type PaymentPlan =
| { status: "ok"; selection: Selection; change_below_min_note_value: boolean }
| { status: "needs_merge"; merges: number }
| { status: "insufficient_funds"; have: Quanta; need: Quanta };
export interface MergePlan { positions: number[]; amount: Quanta; fee: Quanta; }
/** A shield: from `GET /api/shield-v2/stats` the chain id, `pool.latest_anchor` and the node's tip as `anchor_height`.
 *  `expiry_height`: default `anchor_height + 64`; must be above `anchor_height` and at most 128 above it.
 *  `max_fee`: default 10 x the minimum fee; a fee above it is refused. */
export interface ShieldParams { chain_id: string; anchor: Hex; anchor_height: number; expiry_height?: number; max_fee?: Quanta; from_pub_key: Hex; nonce: number; v_in: Quanta; fee: Quanta; recipient: string; allow_below_min_note_value?: boolean; }
/** A transfer or unshield takes NO height: the anchor is the state's confirmed tree root and the expiry is measured from the state's confirmed height.
 *  `anchor` (optional): a cross-check, must be the state's own root.
 *  `expiry_height`: default confirmed height + 64; at most confirmed height + 128.
 *  `allow_unverified` (default false): without it an unconfirmed input (`note_unverified:`) or an unconfirmed tree root (`state_unconfirmed:`) is refused. */
export interface SpendParams { chain_id: string; anchor?: Hex; inputs: number[]; allow_unverified?: boolean; expiry_height?: number; max_fee?: Quanta; }
export interface TransferParams extends SpendParams { recipient: string; amount: Quanta; fee: Quanta; }
export interface UnshieldParams extends SpendParams { to: string; v_out: Quanta; fee: Quanta; }
/** SECRET: `value` and `r` open the note's commitment. */
export interface BuiltOutput { slot: 0 | 1; role: "payment" | "change" | "dummy"; value: Quanta; r: Hex; cm: Hex; }
export interface BuiltTx {
    tx_type: "shield_v2" | "shielded_transfer_v2" | "unshield_v2";
    body: Hex; binding: Hex; public_inputs: Hex; proof: Hex;
    /** The transaction to submit, as JSON text. For a shield its `sig` is still empty. */
    envelope_json: string;
    /** shield_v2 only: the bytes the account's ML-DSA-65 key signs. */
    signing_bytes: Hex | null;
    needs_account_signature: boolean;
    nullifiers: [Hex, Hex];
    spent_positions: number[];
    expiry_height: number;
    /** The pending entry (for display). `null` for a shield. */
    pending: PendingTx | null;
    outputs: [BuiltOutput, BuiltOutput];
}
/** A transfer or unshield AND the state in which its inputs are already locked. PERSIST `state`, THEN submit `envelope_json`. If the state was not persisted, do not submit: build again. */
export interface LockedTx extends BuiltTx, Revised {}
/** Settled at the confirmed height. `mined`: paid. `superseded`: another transaction spent one of its inputs, it was NOT paid and never will be. `expired`: never mined, inputs free, a retry is safe. */
export interface Resolution extends Revised { mined: PendingTx[]; superseded: PendingTx[]; expired: PendingTx[]; still_pending: number; }
/** The `report` object of a node's `GET /api/shield-v2/stats`, plus `node_id`: the endpoint the CALLER configured, never a string the node returned. */
export interface StateReport { node_id: string; height: number; tree_root: Hex; nullifier_acc: Hex; note_count: number; nullifier_count: number; ciphertext_acc: Hex; }
/** `quorum`: a strict majority of the `configured` nodes (at least 2) — never of the reports passed. `dissenting`: configured nodes that contradict the wallet (they do not block). `diverged`: nothing matched and somebody contradicts. `listing_refuted`: the wallet's own listing is wrong — `rescan_state`; WHO is to blame is in `refuted`: a height above the confirmed height (`listing_refuted_above_confirmed`) implicates the node that served those heights — ban it only if that is the node listed from; a height at or below it (`confirmed_refuted`) implicates nobody. `quorum_tip`: the height a quorum of the configured nodes has reached. `listing_ahead`: the listing shows transactions in blocks above it — ask again; if it stays, `rescan_state` and scan from another node. */
export interface ConfirmReport { configured: number; quorum: number; nodes: number; matched_height: number | null; confirmed_height: number | null; newly_confirmed: number[]; agreeing: number; not_comparable: number; not_configured: number; dissenting: { node_id: string; height: number }[]; conflicts: number[]; diverged: boolean; listing_refuted: boolean; listing_refuted_above_confirmed: boolean; confirmed_refuted: boolean; /** per refuted height: the heights of the listing in doubt (`from_height` to `height`) and whether the height is at or below what was confirmed before the call (`confirmed`) */ refuted: { from_height: number; height: number; confirmed: boolean; dissenting: number; agreeing: number }[]; quorum_tip: number | null; listing_ahead: boolean; pruned: number; /** one node's word; used for the embargo base only */ highest_reported: number | null; all_reported: boolean; /** quorum_tip - confirmed_height, in blocks */ confirmed_lag: number | null; embargo_base_set: boolean; }
/** `malformed`: entries of `reports_json` that were not a well-formed report (skipped). */
export interface ConfirmResult extends Revised { report: ConfirmReport; malformed: number; /** configured nodes whose report has no ciphertext_acc: an outdated build, no vote */ outdated_nodes: string[]; spend: SpendStatus; }



/**
 * The client never submitted this transaction: a hint for the UI. Releases nothing — the inputs
 * stay locked until the confirmed height reaches the expiry. JSON `Revised & { found }`.
 */
export function abandon_unsubmitted(state_json: string, nullifier_hex: string, expected_revision: number): string;

/**
 * The user's explicit statement "no other copy of this wallet has a payment in flight": the
 * only override of the restore embargo of a state made by `new_state`. The second argument must
 * be `true`. Accepted only before the first confirmed state check. JSON `Revised & { spend }`.
 */
export function assert_sole_copy(state_json: string, i_am_sure_no_other_copy_has_a_pending_payment: boolean, expected_revision: number): string;

/**
 * The `shield_v2` envelope with the account signature (hex) filled in; JSON text to submit.
 */
export function attach_signature(envelope_json: string, sig_hex: string): string;

/**
 * A `shield_v2` to the wallet's OWN address, recorded in the state (its note is stored whatever
 * its value). JSON `Revised & BuiltTx`. Proves: seconds; run in a worker.
 */
export function build_own_shield(state_json: string, own_address: string, params_json: string, expected_revision: number): string;

/**
 * `params_json`: `ShieldParams`. JSON `BuiltTx`. Proves: seconds; run in a worker.
 */
export function build_shield(params_json: string): string;

/**
 * `params_json`: `TransferParams`. JSON `LockedTx`: the transaction AND the state with its
 * inputs locked. Persist the state, then submit. Proves: seconds; run in a worker.
 */
export function build_transfer(seed: Uint8Array, state_json: string, params_json: string, expected_revision: number): string;

/**
 * `params_json`: `UnshieldParams`. JSON `LockedTx`, as `build_transfer`.
 */
export function build_unshield(seed: Uint8Array, state_json: string, params_json: string, expected_revision: number): string;

/**
 * Can this state build a spend now, and why not; every bound in blocks. `quorum_tip`: from the
 * latest `confirm_state` (negative: none). JSON `SpendStatus`.
 */
export function can_spend_now(state_json: string, quorum_tip: number): string;

/**
 * `reports_json`: `StateReport[]`. A height is confirmed iff a strict majority of the CONFIGURED
 * nodes (`set_nodes`) reports exactly the wallet's values there. JSON `ConfirmResult`.
 */
export function confirm_state(state_json: string, reports_json: string, expected_revision: number): string;

/**
 * JSON `ShieldConstants`.
 */
export function constants(): string;

/**
 * `stale_state:` unless the state in hand is the revision with this identity (`revision_id`).
 */
export function expect_revision_id(state_json: string, revision_id_hex: string): string;

/**
 * JSON `ScanKey`. `with_nk = false`: the viewing key alone.
 */
export function export_scan_key(seed: Uint8Array, with_nk: boolean): string;

/**
 * JSON `WalletState`: empty (revision 0), for this address. `min_note_value_quanta`: `""` is the
 * default (the minimum fee); incoming notes below it are counted, not stored.
 * `max_unspent_notes`: `0` is the default cap (65,536) on unspent notes received from others.
 */
export function new_state(address: string, min_note_value_quanta: string, max_unspent_notes: number): string;

/**
 * A node answered "rejected": a hint for the UI, the inputs stay locked. JSON `Revised & { found }`.
 */
export function note_rejection(state_json: string, nullifier_hex: string, expected_revision: number): string;

/**
 * Validates an `rshield1…` address; JSON `AddressInfo`.
 */
export function parse_address(address: string): string;

/**
 * JSON `PendingTx[]`.
 */
export function pending(state_json: string): string;

/**
 * JSON `PaymentPlan`. Unverified notes are used only with `allow_unverified = true`.
 */
export function plan_payment(state_json: string, amount_quanta: string, fee_quanta: string, allow_unverified: boolean): string;

/**
 * JSON `MergePlan`.
 */
export function plan_self_merge(state_json: string, fee_quanta: string, allow_unverified: boolean): string;

/**
 * The answer to a `state:` error on a stored state: an empty state for the same wallet with
 * every lock that can be read out of the text. NEVER `new_state` instead. JSON `Recovery`.
 */
export function recover_locks(state_json: string): string;

/**
 * An empty state for the same wallet that keeps the pending transactions (all pending and
 * locked) and the configured nodes; `min_note_value_quanta = ""` and `max_unspent_notes = 0`
 * keep the state's values. JSON `Revised`.
 */
export function rescan_state(state_json: string, min_note_value_quanta: string, max_unspent_notes: number, expected_revision: number): string;

/**
 * Settles pending transactions at the confirmed height; JSON `Resolution`. Nothing else
 * releases a lock.
 */
export function resolve_pending(state_json: string, expected_revision: number): string;

/**
 * Applies one page of `GET /api/shield-v2/notes`; JSON `ScanResult`.
 */
export function scan(state_json: string, page_json: string, scan_key_json: string, expected_revision: number): string;

/**
 * Applies several pages (a JSON array) in one call; JSON `ScanPagesResult`.
 */
export function scan_pages(state_json: string, pages_json: string, scan_key_json: string, expected_revision: number): string;

/**
 * Configures the wallet's nodes (`nodes_json`: a JSON array of origins: https, one per host;
 * http for loopback development sets only). The quorum is a strict majority of this set. JSON
 * `NodesResult`.
 */
export function set_nodes(state_json: string, nodes_json: string, expected_revision: number): string;

/**
 * JSON `AddressInfo` of the wallet with this 64-byte BIP-39 seed.
 */
export function shielded_address(seed: Uint8Array): string;

/**
 * JSON `StateSummary`.
 */
export function summary(state_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly abandon_unsubmitted: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly assert_sole_copy: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly attach_signature: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly build_own_shield: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly build_shield: (a: number, b: number) => [number, number, number, number];
    readonly build_transfer: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly build_unshield: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly can_spend_now: (a: number, b: number, c: number) => [number, number, number, number];
    readonly confirm_state: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly constants: () => [number, number, number, number];
    readonly expect_revision_id: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly export_scan_key: (a: number, b: number, c: number) => [number, number, number, number];
    readonly new_state: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly note_rejection: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly parse_address: (a: number, b: number) => [number, number, number, number];
    readonly pending: (a: number, b: number) => [number, number, number, number];
    readonly plan_payment: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly plan_self_merge: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly recover_locks: (a: number, b: number) => [number, number, number, number];
    readonly rescan_state: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly resolve_pending: (a: number, b: number, c: number) => [number, number, number, number];
    readonly scan: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly scan_pages: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly set_nodes: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly shielded_address: (a: number, b: number) => [number, number, number, number];
    readonly summary: (a: number, b: number) => [number, number, number, number];
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
