//! WebAssembly surface (wasm-bindgen) over `quantum-vault-shield-v2-wallet`: derive the shielded
//! address, scan, plan and build the three shielded pool V2 transactions
//! (`docs/SHIELDED_POOL_V2_SPEC.md`). No network, no storage, no user interface.
//!
//! Conventions:
//!
//! * every export returns `Result<string, Error>` to JavaScript — a JSON string on success, an
//!   `Error` whose message starts with a stable code (`fee_below_minimum: …`, `needs_merge: …`,
//!   `entropy: …`) on failure. Nothing returns a bare value that could be mistaken for success;
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

export interface ShieldConstants { min_fee_quanta: Quanta; pool_cap_quanta: Quanta; anchor_window: number; max_proof_bytes: number; body_bytes: number; quanta_per_xrge: Quanta; }
export interface AddressInfo { address: string; pk: Hex; fingerprint: Hex; }
/** `nk: null` is the viewing key alone: finds notes, cannot see spends. Neither can spend. */
export interface ScanKey { pk: Hex; nk: Hex | null; dk: Hex; }
export interface OwnedNote { value: Quanta; r: Hex; rho: Hex; position: number; cm: Hex; nullifier: Hex | null; spent: boolean; spent_height: number | null; height: number; tx_hash: string; output_index: 0 | 1; }
/** Opaque to the client: persist it (encrypted) and pass it back. */
export type WalletState = object;
export interface ScanReport { txs: number; received: number[]; spent: number[]; next_height: number; at_tip: boolean; }
export interface ScanResult { state: WalletState; report: ScanReport; anchor: Hex; balance: Quanta; }
export interface StateSummary { balance: Quanta; anchor: Hex; next_height: number; note_count: number; notes: OwnedNote[]; }
export interface Selection { positions: number[]; total: Quanta; change: Quanta; }
export type PaymentPlan =
  | { status: "ok"; selection: Selection }
  | { status: "needs_merge"; merges: number }
  | { status: "insufficient_funds"; have: Quanta; need: Quanta };
export interface MergePlan { positions: number[]; amount: Quanta; fee: Quanta; }
/** From `GET /api/shield-v2/stats`: the chain id, `pool.latest_anchor`, and a height you choose. */
export interface TxContext { chain_id: string; anchor: Hex; expiry_height: number; }
export interface ShieldParams extends TxContext { from_pub_key: Hex; nonce: number; v_in: Quanta; fee: Quanta; recipient: string; }
export interface TransferParams extends TxContext { inputs: number[]; recipient: string; amount: Quanta; fee: Quanta; }
export interface UnshieldParams extends TxContext { inputs: number[]; to: string; v_out: Quanta; fee: Quanta; }
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
  outputs: [BuiltOutput, BuiltOutput];
}
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

/// JSON `WalletState`: empty, for this address.
#[wasm_bindgen]
pub fn new_state(address: &str) -> Result<String, JsError> {
    js(api::new_state(address))
}

/// Applies one page of `GET /api/shield-v2/notes`; JSON `ScanResult`.
#[wasm_bindgen]
pub fn scan(state_json: &str, page_json: &str, scan_key_json: &str) -> Result<String, JsError> {
    js(api::scan(state_json, page_json, scan_key_json))
}

/// JSON `StateSummary`.
#[wasm_bindgen]
pub fn summary(state_json: &str) -> Result<String, JsError> {
    js(api::summary(state_json))
}

/// JSON `PaymentPlan`.
#[wasm_bindgen]
pub fn plan_payment(state_json: &str, amount_quanta: &str, fee_quanta: &str) -> Result<String, JsError> {
    js(api::plan_payment(state_json, amount_quanta, fee_quanta))
}

/// JSON `MergePlan`.
#[wasm_bindgen]
pub fn plan_self_merge(state_json: &str, fee_quanta: &str) -> Result<String, JsError> {
    js(api::plan_self_merge(state_json, fee_quanta))
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

/// Marks (`spent = true`) or releases (`false`) notes of a pending transaction; JSON `WalletState`.
#[wasm_bindgen]
pub fn mark_pending(state_json: &str, positions_json: &str, spent: bool) -> Result<String, JsError> {
    js(api::mark_pending(state_json, positions_json, spent))
}
