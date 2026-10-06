//! WebAssembly surface (wasm-bindgen) over `quantum-vault-shield-v2-wallet`: derive the shielded
//! address, scan, plan and build the three shielded pool V2 transactions
//! (`docs/SHIELDED_POOL_V2_SPEC.md`). No network, no storage, no user interface.
//!
//! Conventions:
//!
//! * every export returns `Result<string, Error>` to JavaScript — a JSON string on success, an
//!   `Error` whose message starts with a stable code (`fee_below_minimum: …`, `needs_merge: …`,
//!   `entropy: …`, `note_locked: …`) on failure. Nothing returns a bare value that could be
//!   mistaken for success. **No error message quotes an argument**: a message is a code, a fixed
//!   sentence and at most a line and column — safe to log;
//! * a note found by `scan` is `confirmed: false` until `confirm_state` has matched the wallet's
//!   tree root AND nullifier hash against a quorum of nodes; `confirmed_balance` and
//!   `unverified_balance` are separate and an incoming payment MUST be shown as unconfirmed until
//!   then (spec §5.4);
//! * a built transfer or unshield is recorded with `mark_pending` BEFORE it is submitted; its
//!   inputs stay locked until `resolve_pending` settles it at the height `confirm_state`
//!   confirmed: `mined`, `superseded` or `expired` (spec §5.5). What `scan` reports of it, a
//!   node's "rejected" (`note_rejection`) and a height one node claims are hints, never a release;
//! * every call that changes a state takes `expected_revision` and returns `revision`: store the
//!   revision with the state, pass the STORED one, and store the result only if it is still the
//!   stored one (`stale_state:` otherwise) — two tabs must not drop each other's `mark_pending`;
//! * amounts are decimal strings of quanta (a JavaScript number cannot hold a u64);
//! * 32-byte values, bodies, proofs and keys are lowercase hexadecimal;
//! * the BIP-39 seed (64 bytes) is passed as a `Uint8Array` to the calls that spend; this module
//!   keeps nothing between calls and wipes its copy of the seed before returning;
//! * randomness comes from Web Crypto (`crypto.getRandomValues`) through `getrandom`; if it is
//!   missing or fails, the call fails (`entropy: …`). There is no seed parameter anywhere.
//!
//! `build_*` proves and therefore runs for seconds: call it from a Web Worker.
//!
//! The JSON shapes are declared for TypeScript in the custom section below.

pub mod api;

use wasm_bindgen::prelude::*;
use zeroize::Zeroize;

#[wasm_bindgen(typescript_custom_section)]
const TS_TYPES: &'static str = r#"
/** Decimal string of quanta (1 XRGE = 10^9 quanta). */
export type Quanta = string;
/** Lowercase hexadecimal. */
export type Hex = string;

export interface ShieldConstants { min_fee_quanta: Quanta; pool_cap_quanta: Quanta; anchor_window: number; max_proof_bytes: number; body_bytes: number; quanta_per_xrge: Quanta; default_expiry_offset: number; max_expiry_offset: number; default_max_fee_quanta: Quanta; default_confirm_quorum: number; default_min_note_value: Quanta; max_stored_notes: number; prune_retention_blocks: number; state_version: number; address_version: number; }
export interface AddressInfo { address: string; pk: Hex; fingerprint: Hex; }
/** `nk: null` is the viewing key alone: finds notes, cannot see spends. Neither can spend. SECRET. */
export interface ScanKey { pk: Hex; nk: Hex | null; dk: Hex; }
/** `confirmed: false` = known from one node's listing only (show as unconfirmed). SECRET (`value`, `r`). */
export interface OwnedNote { value: Quanta; r: Hex; rho: Hex; position: number; cm: Hex; nullifier: Hex | null; spent: boolean; spent_height: number | null; height: number; tx_hash: Hex | ""; output_index: 0 | 1; confirmed: boolean; }
/** Opaque to the client: persist it (encrypted) and pass it back. */
export type WalletState = object;
/** `expected_change` is for display only and is in none of the other figures. */
export interface Balances { confirmed_balance: Quanta; unverified_balance: Quanta; locked_balance: Quanta; spendable_balance: Quanta; expected_change: Quanta; }
/** The revision of the returned state: store it with the state, pass the STORED one as `expected_revision`. */
export interface Revised { state: WalletState; revision: number; }
/** What ONE node's listing says. `pending_seen_*` settle nothing: only `resolve_pending` does. */
export interface ScanReport { txs: number; received: number[]; spent: number[]; pending_seen_mined: number; pending_seen_superseded: number; not_stored: number; next_height: number; at_tip: boolean; }
export interface ScanResult extends Balances, Revised { report: ScanReport; anchor: Hex; scanned_height: number | null; }
export interface ScanPagesResult extends Balances, Revised { report: ScanReport[]; anchor: Hex; scanned_height: number | null; }
/** `status` is what the scan has SEEN (one node's listing); the inputs are locked in every status. `outputs`: cm_out1, cm_out2. */
export interface PendingTx { tx_type: "shielded_transfer_v2" | "unshield_v2" | ""; nullifiers: Hex[]; outputs: Hex[]; inputs: number[]; input_cms: Hex[]; input_total: Quanta; change: { cm: Hex; value: Quanta } | null; expiry_height: number; status: "pending" | "seen_mined" | "seen_superseded"; seen_height: number | null; rejected_hint: boolean; legacy: boolean; }
export interface Tally { count: number; total: Quanta; }
export interface StateSummary extends Balances { revision: number; anchor: Hex; nullifier_acc: Hex; nullifier_count: number; next_height: number; scanned_height: number | null; confirmed_height: number | null; note_count: number; min_note_value: Quanta; below_minimum: Tally; over_capacity: Tally; pruned: Tally; notes: OwnedNote[]; pending: PendingTx[]; }
export interface Selection { positions: number[]; total: Quanta; change: Quanta; }
export type PaymentPlan =
  | { status: "ok"; selection: Selection; change_below_min_note_value: boolean }
  | { status: "needs_merge"; merges: number }
  | { status: "insufficient_funds"; have: Quanta; need: Quanta };
export interface MergePlan { positions: number[]; amount: Quanta; fee: Quanta; }
/** From `GET /api/shield-v2/stats`: the chain id, `pool.latest_anchor` and the height it belongs to.
 *  `anchor_height`: required for a shield (the node's tip); for a transfer or unshield it is the state's scanned height and may be omitted.
 *  `expiry_height`: default `anchor_height + 64`; must be above `anchor_height` and at most 128 above it.
 *  `max_fee`: default 10 x the minimum fee; a fee above it is refused. */
export interface TxContext { chain_id: string; anchor: Hex; anchor_height?: number; expiry_height?: number; max_fee?: Quanta; }
export interface ShieldParams extends TxContext { anchor_height: number; from_pub_key: Hex; nonce: number; v_in: Quanta; fee: Quanta; recipient: string; }
/** `allow_unverified` (default false): without it an input that is not confirmed is refused (`note_unverified:`). */
export interface TransferParams extends TxContext { inputs: number[]; allow_unverified?: boolean; recipient: string; amount: Quanta; fee: Quanta; }
export interface UnshieldParams extends TxContext { inputs: number[]; allow_unverified?: boolean; to: string; v_out: Quanta; fee: Quanta; }
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
  /** Pass to `mark_pending` BEFORE submitting. `null` for a shield. */
  pending: PendingTx | null;
  outputs: [BuiltOutput, BuiltOutput];
}
/** Settled at the confirmed height. `mined`: paid. `superseded`: another transaction spent one of its inputs, it was NOT paid and never will be. `expired`: never mined, inputs free, a retry is safe. */
export interface Resolution extends Revised { mined: PendingTx[]; superseded: PendingTx[]; expired: PendingTx[]; still_pending: number; }
/** The `report` object of a node's `GET /api/shield-v2/stats`, plus `node_id`: the endpoint the CALLER configured, never a string the node returned. */
export interface StateReport { node_id: string; height: number; tree_root: Hex; nullifier_acc: Hex; note_count: number; nullifier_count: number; }
/** `diverged`: a report conflicted at one of `conflicts`; nothing was confirmed by the call. `quorum`: the one applied (at least a strict majority of `nodes`). */
export interface ConfirmReport { quorum: number; nodes: number; matched_height: number | null; confirmed_height: number | null; newly_confirmed: number[]; agreeing: number; not_comparable: number; diverged: boolean; conflicts: number[]; pruned: number; }
export interface ConfirmResult extends Revised { report: ConfirmReport; }
"#;

fn js(r: api::ApiResult) -> Result<String, JsError> {
    r.map_err(|e| JsError::new(&e))
}

/// JSON `ShieldConstants`.
#[wasm_bindgen]
pub fn constants() -> Result<String, JsError> {
    js(api::constants())
}

/// JSON `AddressInfo` of the wallet with this 64-byte BIP-39 seed.
#[wasm_bindgen]
pub fn shielded_address(mut seed: Vec<u8>) -> Result<String, JsError> {
    let r = api::shielded_address(&seed);
    seed.zeroize();
    js(r)
}

/// Validates an `rshield1…` address; JSON `AddressInfo`.
#[wasm_bindgen]
pub fn parse_address(address: &str) -> Result<String, JsError> {
    js(api::parse_address(address))
}

/// JSON `ScanKey`. `with_nk = false`: the viewing key alone.
#[wasm_bindgen]
pub fn export_scan_key(mut seed: Vec<u8>, with_nk: bool) -> Result<String, JsError> {
    let r = api::export_scan_key(&seed, with_nk);
    seed.zeroize();
    js(r)
}

/// JSON `WalletState`: empty (revision 0), for this address. `min_note_value_quanta`: `""` is the
/// default (the minimum fee); incoming notes below it are counted, not stored.
#[wasm_bindgen]
pub fn new_state(address: &str, min_note_value_quanta: &str) -> Result<String, JsError> {
    js(api::new_state(address, min_note_value_quanta))
}

/// Applies one page of `GET /api/shield-v2/notes`; JSON `ScanResult`.
#[wasm_bindgen]
pub fn scan(state_json: &str, page_json: &str, scan_key_json: &str, expected_revision: f64) -> Result<String, JsError> {
    js(api::scan(state_json, page_json, scan_key_json, expected_revision))
}

/// JSON `StateSummary`.
#[wasm_bindgen]
pub fn summary(state_json: &str) -> Result<String, JsError> {
    js(api::summary(state_json))
}

/// Applies several pages (a JSON array) in one call; JSON `ScanPagesResult`.
#[wasm_bindgen]
pub fn scan_pages(state_json: &str, pages_json: &str, scan_key_json: &str, expected_revision: f64) -> Result<String, JsError> {
    js(api::scan_pages(state_json, pages_json, scan_key_json, expected_revision))
}

/// JSON `PaymentPlan`. Unverified notes are used only with `allow_unverified = true`.
#[wasm_bindgen]
pub fn plan_payment(state_json: &str, amount_quanta: &str, fee_quanta: &str, allow_unverified: bool) -> Result<String, JsError> {
    js(api::plan_payment(state_json, amount_quanta, fee_quanta, allow_unverified))
}

/// JSON `MergePlan`.
#[wasm_bindgen]
pub fn plan_self_merge(state_json: &str, fee_quanta: &str, allow_unverified: bool) -> Result<String, JsError> {
    js(api::plan_self_merge(state_json, fee_quanta, allow_unverified))
}

/// `params_json`: `ShieldParams`. JSON `BuiltTx`. Proves: seconds; run in a worker.
#[wasm_bindgen]
pub fn build_shield(params_json: &str) -> Result<String, JsError> {
    js(api::build_shield(params_json))
}

/// The `shield_v2` envelope with the account signature (hex) filled in; JSON text to submit.
#[wasm_bindgen]
pub fn attach_signature(envelope_json: &str, sig_hex: &str) -> Result<String, JsError> {
    js(api::attach_signature(envelope_json, sig_hex))
}

/// `params_json`: `TransferParams`. JSON `BuiltTx`. Proves: seconds; run in a worker.
#[wasm_bindgen]
pub fn build_transfer(mut seed: Vec<u8>, state_json: &str, params_json: &str) -> Result<String, JsError> {
    let r = api::build_transfer(&seed, state_json, params_json);
    seed.zeroize();
    js(r)
}

/// `params_json`: `UnshieldParams`. JSON `BuiltTx`. Proves: seconds; run in a worker.
#[wasm_bindgen]
pub fn build_unshield(mut seed: Vec<u8>, state_json: &str, params_json: &str) -> Result<String, JsError> {
    let r = api::build_unshield(&seed, state_json, params_json);
    seed.zeroize();
    js(r)
}

/// Records a built transfer or unshield (`BuiltTx.pending`) and locks its inputs. Call it, and
/// persist the result, BEFORE submitting. JSON `Revised`.
#[wasm_bindgen]
pub fn mark_pending(state_json: &str, pending_json: &str, expected_revision: f64) -> Result<String, JsError> {
    js(api::mark_pending(state_json, pending_json, expected_revision))
}

/// JSON `PendingTx[]`.
#[wasm_bindgen]
pub fn pending(state_json: &str) -> Result<String, JsError> {
    js(api::pending(state_json))
}

/// A node answered "rejected": a hint for the UI, the inputs stay locked. JSON `Revised & { found }`.
#[wasm_bindgen]
pub fn note_rejection(state_json: &str, nullifier_hex: &str, expected_revision: f64) -> Result<String, JsError> {
    js(api::note_rejection(state_json, nullifier_hex, expected_revision))
}

/// Settles pending transactions at the confirmed height; JSON `Resolution`. Nothing else
/// releases a lock.
#[wasm_bindgen]
pub fn resolve_pending(state_json: &str, expected_revision: f64) -> Result<String, JsError> {
    js(api::resolve_pending(state_json, expected_revision))
}

/// `reports_json`: `StateReport[]`; `quorum = 0` means the default (2), raised to a strict
/// majority of the nodes reported. JSON `ConfirmResult`.
#[wasm_bindgen]
pub fn confirm_state(state_json: &str, reports_json: &str, quorum: u32, expected_revision: f64) -> Result<String, JsError> {
    js(api::confirm_state(state_json, reports_json, quorum, expected_revision))
}

/// The former name of `confirm_state`; the same call with the same `StateReport[]`.
#[wasm_bindgen]
pub fn confirm_roots(state_json: &str, reports_json: &str, quorum: u32, expected_revision: f64) -> Result<String, JsError> {
    js(api::confirm_roots(state_json, reports_json, quorum, expected_revision))
}

/// An empty state for the same wallet that keeps the pending transactions, all pending and
/// locked; `min_note_value_quanta = ""` keeps the state's value. JSON `Revised`.
#[wasm_bindgen]
pub fn rescan_state(state_json: &str, min_note_value_quanta: &str, expected_revision: f64) -> Result<String, JsError> {
    js(api::rescan_state(state_json, min_note_value_quanta, expected_revision))
}
