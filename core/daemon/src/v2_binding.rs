//! V2 ("signed payload") transaction binding — the ONE canonical mapping from a client-signed
//! JSON payload to the `TxV1` fields the chain executes.
//!
//! A V2 transaction carries the exact bytes the client signed in `signed_payload`; the node
//! verifies the ML-DSA-65 signature over those bytes. Every executable field of the transaction
//! (`payload`, `fee`, `tx_type`, `version`) MUST be a deterministic function of that signed JSON,
//! so that nobody who lacks the signer's key can change what the transaction does. This module
//! is that function. It is used by
//!   * API construction (`build_v2_tx`) — every `/api/v2/*` handler that mints a `TxV1`,
//!   * mempool admission (`verify_v2_binding`, node-local, always on), and
//!   * block import (`verify_v2_binding`, consensus rule from `TX_UNIQUENESS_ACTIVATION_HEIGHT`).
//!
//! Two signed-payload formats exist on mainnet and both are bound:
//!   (A) the `/api/v2/*` client format — a flat JSON object (`to`, `amount`, `token`, …). The
//!       handler derives the fields; `fee` is the handler's constant; `nonce` is server-assigned
//!       (account nonce or wall clock) and therefore NOT bound — it is also excluded from the tx
//!       identity (`quantum_vault_types::tx_identity`), so changing it cannot create a "new" tx.
//!   (B) the `rougechain` CLI envelope — `{"tx_type","from","nonce","fee","payload":{…TxPayload…}}`
//!       posted as a complete `TxV1` to `/api/tx/broadcast`. Here tx_type, nonce, fee AND the
//!       payload are all inside the signed bytes and all bound. Detected by the presence of a
//!       top-level `payload` object together with a `tx_type` string.
//! `from_pub_key` is bound by the signature itself (and by `from` inside the JSON when present).
//!
//! The derivations below reproduce, expression for expression, what the handlers did inline
//! before this module existed (see the 2026-09-23 inventory in the review record). Do not
//! "clean them up": a changed truncation or default is a consensus change.
use quantum_vault_types::{TxPayload, TxV1};
use serde_json::Value;

fn s(p: &Value, k: &str) -> String { p.get(k).and_then(|v| v.as_str()).unwrap_or_default().to_string() }
fn opt_s(p: &Value, k: &str) -> Option<String> { p.get(k).and_then(|v| v.as_str()).map(String::from) }
fn u(p: &Value, k: &str) -> u64 { p.get(k).and_then(|v| v.as_u64()).unwrap_or(0) }
fn opt_u(p: &Value, k: &str) -> Option<u64> { p.get(k).and_then(|v| v.as_u64()) }
fn opt_f(p: &Value, k: &str) -> Option<f64> { p.get(k).and_then(|v| v.as_f64()) }
fn opt_b(p: &Value, k: &str) -> Option<bool> { p.get(k).and_then(|v| v.as_bool()) }
fn str_vec(p: &Value, k: &str) -> Vec<String> { p.get(k).and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default() }
fn str_arr(p: &Value, k: &str) -> Option<Vec<String>> {
    p.get(k).and_then(|v| v.as_array()).map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
}

/// Sorted pool id, identical to `LiquidityPool::make_pool_id`.
pub fn make_pool_id(token_a: &str, token_b: &str) -> String {
    if token_a < token_b { format!("{}-{}", token_a, token_b) } else { format!("{}-{}", token_b, token_a) }
}

/// Derive `(payload, fee)` for `tx_type` from the signed JSON. Errors only for a type that the
/// API never builds from a signed payload.
pub fn derive_v2_fields(tx_type: &str, p: &Value) -> Result<(TxPayload, f64), String> {
    let d = TxPayload::default();
    Ok(match tx_type {
        "transfer" => {
            let to = s(p, "to");
            let amount = p.get("amount").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let token = p.get("token").and_then(|v| v.as_str()).unwrap_or("XRGE").to_string();
            (TxPayload {
                to_pub_key_hex: Some(to),
                amount: Some(amount as u64), // f64 -> u64 truncation, as the handler did
                token_name: Some(token.clone()),
                token_symbol: if token != "XRGE" { Some(token) } else { None },
                ..d
            }, 1.0)
        }
        "create_token" => (TxPayload {
            token_name: Some(s(p, "token_name")),
            token_symbol: Some(s(p, "token_symbol")),
            token_decimals: Some(18),
            token_total_supply: Some(u(p, "initial_supply")),
            metadata_image: opt_s(p, "image"),
            metadata_description: opt_s(p, "description"),
            ..d
        }, 100.0),
        "mint_tokens" => (TxPayload { token_symbol: Some(s(p, "token_symbol")), token_total_supply: Some(u(p, "amount")), ..d }, 1.0),
        "approve" => (TxPayload { spender_pub_key: Some(s(p, "spender")), token_symbol: Some(s(p, "token_symbol")), allowance_amount: Some(u(p, "amount")), ..d }, 1.0),
        "transfer_from" => (TxPayload {
            owner_pub_key: Some(s(p, "owner")), to_pub_key_hex: Some(s(p, "to")),
            token_symbol: Some(s(p, "token_symbol")), amount: Some(u(p, "amount")), ..d
        }, 1.0),
        "create_pool" => {
            let (a, b) = (s(p, "token_a"), s(p, "token_b"));
            (TxPayload { pool_id: Some(make_pool_id(&a, &b)), token_a_symbol: Some(a), token_b_symbol: Some(b),
                amount_a: Some(u(p, "amount_a")), amount_b: Some(u(p, "amount_b")), ..d }, 10.0)
        }
        "add_liquidity" => (TxPayload { pool_id: Some(s(p, "pool_id")), amount_a: Some(u(p, "amount_a")), amount_b: Some(u(p, "amount_b")), ..d }, 1.0),
        "remove_liquidity" => (TxPayload { pool_id: Some(s(p, "pool_id")), lp_amount: Some(u(p, "lp_amount")), ..d }, 1.0),
        "swap" => {
            let (i, o) = (s(p, "token_in"), s(p, "token_out"));
            let amount_in = u(p, "amount_in");
            (TxPayload { amount: Some(amount_in), pool_id: Some(make_pool_id(&i, &o)), token_a_symbol: Some(i), token_b_symbol: Some(o),
                amount_a: Some(amount_in), min_amount_out: Some(u(p, "min_amount_out")), ..d }, 1.0)
        }
        "stake" | "unstake" => (TxPayload { amount: Some(u(p, "amount")), ..d }, 1.0),
        "nft_create_collection" => (TxPayload {
            nft_collection_symbol: Some(s(p, "symbol")), nft_collection_name: Some(s(p, "name")),
            nft_description: opt_s(p, "description"), nft_image: opt_s(p, "image"),
            nft_max_supply: opt_u(p, "maxSupply"),
            nft_royalty_bps: opt_u(p, "royaltyBps").map(|v| v as u16),
            nft_royalty_recipient: p.get("royaltyRecipient").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(String::from),
            nft_public_mint: opt_b(p, "publicMint"), nft_mint_price: opt_f(p, "mintPrice"),
            nft_token_gate_symbol: opt_s(p, "tokenGateSymbol"), nft_token_gate_amount: opt_f(p, "tokenGateAmount"),
            nft_discount_pct: opt_u(p, "discountPct").map(|v| v as u32),
            ..d
        }, 50.0),
        "nft_mint" => (TxPayload {
            nft_collection_id: Some(s(p, "collectionId")), nft_token_name: Some(s(p, "name")),
            nft_metadata_uri: opt_s(p, "metadataUri"), nft_attributes: p.get("attributes").cloned(), ..d
        }, 5.0),
        "nft_batch_mint" => {
            let names: Vec<String> = str_arr(p, "names").unwrap_or_default();
            let fee = 5.0 * names.len() as f64;
            (TxPayload {
                nft_collection_id: Some(s(p, "collectionId")), nft_batch_names: Some(names),
                nft_batch_uris: str_arr(p, "uris"),
                nft_batch_attributes: p.get("attributes").and_then(|v| v.as_array()).map(|arr| arr.to_vec()),
                ..d
            }, fee)
        }
        "nft_transfer" => (TxPayload {
            nft_collection_id: Some(s(p, "collectionId")), nft_token_id: Some(u(p, "tokenId")),
            to_pub_key_hex: Some(s(p, "to")), amount: opt_u(p, "salePrice"), ..d
        }, 1.0),
        "nft_burn" => (TxPayload { nft_collection_id: Some(s(p, "collectionId")), nft_token_id: Some(u(p, "tokenId")), ..d }, 0.1),
        "nft_lock" => (TxPayload { nft_collection_id: Some(s(p, "collectionId")), nft_token_id: Some(u(p, "tokenId")),
            nft_locked: Some(p.get("locked").and_then(|v| v.as_bool()).unwrap_or(true)), ..d }, 0.1),
        "nft_freeze_collection" => (TxPayload { nft_collection_id: Some(s(p, "collectionId")),
            nft_frozen: Some(p.get("frozen").and_then(|v| v.as_bool()).unwrap_or(true)), ..d }, 0.1),
        "shield" => (TxPayload { shielded_commitment: Some(s(p, "commitment")), shielded_value: Some(u(p, "amount")), ..d }, 1.0),
        "shielded_transfer" => (TxPayload {
            shielded_nullifiers: Some(str_vec(p, "nullifiers")), shielded_output_commitments: Some(str_vec(p, "output_commitments")),
            shielded_proof: Some(s(p, "proof")), shielded_fee: Some(u(p, "fee")), ..d
        }, 1.0),
        "unshield" => (TxPayload {
            shielded_nullifiers: Some(str_vec(p, "nullifiers")), shielded_value: Some(u(p, "amount")), shielded_proof: Some(s(p, "proof")), ..d
        }, 1.0),
        other => return Err(format!("'{}' is not a signed-payload transaction type", other)),
    })
}

/// API construction: the only way a handler may turn a verified signed payload into a `TxV1`.
pub fn build_v2_tx(tx_type: &str, from_pub_key: String, nonce: u64, payload: &Value, sig: String, signed_payload: String) -> Result<TxV1, String> {
    let (payload, fee) = derive_v2_fields(tx_type, payload)?;
    Ok(TxV1 { version: 1, tx_type: tx_type.to_string(), from_pub_key, nonce, payload, fee, sig, signed_payload: Some(signed_payload) })
}

/// Binding check for any tx that carries a `signed_payload`: the executable fields must equal
/// the canonical derivation from the signed JSON. (Signature validity over the JSON is checked
/// separately, where it always was.) Pure function; no node state.
pub fn is_cli_envelope(p: &Value) -> bool {
    p.get("payload").map(|v| v.is_object()).unwrap_or(false) && p.get("tx_type").map(|v| v.is_string()).unwrap_or(false)
}

pub fn verify_v2_binding(tx: &TxV1) -> Result<(), String> {
    let Some(sp) = tx.signed_payload.as_deref() else { return Ok(()) };
    let p: Value = serde_json::from_str(sp).map_err(|e| format!("signed_payload is not valid JSON: {}", e))?;
    if !p.is_object() { return Err("signed_payload is not a JSON object".into()); }
    if tx.version != 1 { return Err(format!("signed-payload tx must be version 1, got {}", tx.version)); }
    if let Some(from) = p.get("from").and_then(|v| v.as_str()) {
        if from != tx.from_pub_key { return Err("signed_payload 'from' does not match from_pub_key".into()); }
    }
    if is_cli_envelope(&p) {
        // (B) everything is inside the signed bytes
        if p["tx_type"].as_str() != Some(tx.tx_type.as_str()) { return Err("signed envelope tx_type does not match".into()); }
        if p.get("nonce").and_then(|v| v.as_u64()) != Some(tx.nonce) { return Err("signed envelope nonce does not match".into()); }
        if p.get("fee").and_then(|v| v.as_f64()) != Some(tx.fee) { return Err("signed envelope fee does not match".into()); }
        let payload: TxPayload = serde_json::from_value(p["payload"].clone()).map_err(|e| format!("signed envelope payload: {}", e))?;
        if tx.payload != payload { return Err(format!("{} payload does not match its signed envelope", tx.tx_type)); }
        return Ok(());
    }
    let (payload, fee) = derive_v2_fields(&tx.tx_type, &p)?;
    if tx.payload != payload { return Err(format!("{} payload does not match its signed_payload", tx.tx_type)); }
    if tx.fee != fee { return Err(format!("{} fee {} does not match the fee bound to its signed_payload ({})", tx.tx_type, tx.fee, fee)); }
    Ok(())
}
