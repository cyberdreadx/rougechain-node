//! The surface in plain Rust: strings and bytes in, a JSON string or an error out. Everything
//! here is callable natively (the tests of this crate do), and nothing here panics on caller
//! data — on `wasm32-unknown-unknown` a panic is a trap, which is exactly what the JavaScript
//! side must never see.

use quantum_vault_shield_v2_wallet as wallet;
use serde::Deserialize;
use serde_json::{json, Value};
use wallet::{
    account_from_address, plan_merge, select_inputs, BuiltTx, ListingPage, ScanKey, ShieldRequest, ShieldedAddress,
    ShieldedKeys, SpendInput, TransferRequest, TxContext, TxKind, UnshieldRequest, WalletError, WalletState,
};

/// An error for JavaScript: a stable machine-readable `code`, then the text.
pub type ApiResult = Result<String, String>;

fn code(e: &WalletError) -> &'static str {
    match e {
        WalletError::Entropy(_) => "entropy",
        WalletError::Key(_) => "key",
        WalletError::Address(_) => "address",
        WalletError::Request(_) => "request",
        WalletError::FeeBelowMinimum { .. } => "fee_below_minimum",
        WalletError::InsufficientFunds { .. } => "insufficient_funds",
        WalletError::NeedsMerge { .. } => "needs_merge",
        WalletError::AnchorMismatch => "anchor_mismatch",
        WalletError::NonCanonical(_) => "non_canonical",
        WalletError::Listing(_) => "listing",
        WalletError::State(_) => "state",
        WalletError::Prove(_) => "prove",
        WalletError::Internal(_) => "internal",
    }
}

fn err(e: WalletError) -> String {
    format!("{}: {e}", code(&e))
}

fn bad(what: &str) -> String {
    format!("request: {what}")
}

fn out(v: Value) -> ApiResult {
    serde_json::to_string(&v).map_err(|e| format!("internal: {e}"))
}

fn lower_hex(s: &str) -> bool {
    s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn hex32(s: &str, what: &str) -> Result<[u8; 32], String> {
    if s.len() != 64 || !lower_hex(s) {
        return Err(bad(&format!("{what} must be 64 lowercase hexadecimal characters")));
    }
    hex::decode(s).ok().and_then(|v| v.try_into().ok()).ok_or_else(|| bad(what))
}

fn amount(s: &str, what: &str) -> Result<u64, String> {
    if s.is_empty() || s.len() > 20 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad(&format!("{what} must be a decimal string of quanta")));
    }
    s.parse().map_err(|_| bad(&format!("{what} does not fit in 64 bits")))
}

fn keys(seed: &[u8]) -> Result<ShieldedKeys, String> {
    ShieldedKeys::from_seed(seed).map_err(err)
}

fn state(json: &str) -> Result<WalletState, String> {
    WalletState::from_json(json).map_err(err)
}

/// Amounts and limits a client needs, as decimal strings.
pub fn constants() -> ApiResult {
    out(json!({
        "min_fee_quanta": wallet::SHIELD_V2_MIN_FEE_QUANTA.to_string(),
        "pool_cap_quanta": wallet::SHIELD_V2_POOL_CAP_QUANTA.to_string(),
        "anchor_window": wallet::SHIELD_V2_ANCHOR_WINDOW,
        "max_proof_bytes": wallet::MAX_PROOF_BYTES,
        "body_bytes": wallet::BODY_BYTES,
        "quanta_per_xrge": "1000000000",
    }))
}

/// The wallet's shielded address from its 64-byte BIP-39 seed.
pub fn shielded_address(seed: &[u8]) -> ApiResult {
    let addr = keys(seed)?.address();
    out(json!({ "address": addr.encode(), "pk": hex::encode(addr.pk), "fingerprint": addr.fingerprint() }))
}

/// Validates an `rshield1…` string someone gave the user.
pub fn parse_address(address: &str) -> ApiResult {
    let addr = ShieldedAddress::decode(address).map_err(err)?;
    out(json!({ "address": addr.encode(), "pk": hex::encode(addr.pk), "fingerprint": addr.fingerprint() }))
}

/// The key material scanning needs, for a client that scans without holding the seed (a
/// background worker, an auditor). `with_nk = false` gives the viewing key alone.
pub fn export_scan_key(seed: &[u8], with_nk: bool) -> ApiResult {
    let k = keys(seed)?;
    let sk = if with_nk { k.scan_key() } else { k.incoming_viewing_key() };
    out(json!({ "pk": hex::encode(sk.pk), "nk": sk.nk.map(hex::encode), "dk": hex::encode(sk.dk_bytes()) }))
}

#[derive(Deserialize)]
struct ScanKeyJson {
    pk: String,
    #[serde(default)]
    nk: Option<String>,
    dk: String,
}

fn scan_key(json: &str) -> Result<ScanKey, String> {
    let k: ScanKeyJson = serde_json::from_str(json).map_err(|e| bad(&format!("scan key: {e}")))?;
    let nk = match &k.nk {
        Some(nk) => Some(hex32(nk, "nk")?),
        None => None,
    };
    if k.dk.len() != 4_800 || !lower_hex(&k.dk) {
        return Err(bad("dk must be 4,800 lowercase hexadecimal characters"));
    }
    let dk = hex::decode(&k.dk).map_err(|_| bad("dk"))?;
    ScanKey::from_parts(hex32(&k.pk, "pk")?, nk, &dk).map_err(err)
}

/// An empty wallet state for this address. Scanning it from height 0 is the restore of spec §5.4.
pub fn new_state(address: &str) -> ApiResult {
    let addr = ShieldedAddress::decode(address).map_err(err)?;
    WalletState::new(addr.pk).to_json().map_err(err)
}

/// Applies one page of `GET /api/shield-v2/notes` to the state. Returns the new state and what
/// was found; on any error the caller keeps its old state.
pub fn scan(state_json: &str, page_json: &str, scan_key_json: &str) -> ApiResult {
    let mut st = state(state_json)?;
    let page = ListingPage::from_json(page_json).map_err(err)?;
    let report = st.scan(&page, &scan_key(scan_key_json)?).map_err(err)?;
    let st_v: Value = serde_json::from_str(&st.to_json().map_err(err)?).map_err(|e| format!("internal: {e}"))?;
    out(json!({ "state": st_v, "report": report, "anchor": hex::encode(st.anchor()), "balance": st.balance().to_string() }))
}

/// Balance, anchor and the notes of a state.
pub fn summary(state_json: &str) -> ApiResult {
    let st = state(state_json)?;
    out(json!({
        "balance": st.balance().to_string(),
        "anchor": hex::encode(st.anchor()),
        "next_height": st.next_height(),
        "note_count": st.tree().note_count(),
        "notes": st.notes(),
    }))
}

/// Chooses the notes for a payment (a transfer's amount or an unshield's `v_out`).
/// `status`: `ok` (with `selection`), `needs_merge` (with `merges`) or `insufficient_funds`.
pub fn plan_payment(state_json: &str, amount_quanta: &str, fee_quanta: &str) -> ApiResult {
    let st = state(state_json)?;
    match select_inputs(&st, amount(amount_quanta, "amount")?, amount(fee_quanta, "fee")?) {
        Ok(sel) => out(json!({ "status": "ok", "selection": sel })),
        Err(WalletError::NeedsMerge { merges }) => out(json!({ "status": "needs_merge", "merges": merges })),
        Err(WalletError::InsufficientFunds { have, need }) => {
            out(json!({ "status": "insufficient_funds", "have": have.to_string(), "need": need.to_string() }))
        }
        Err(e) => Err(err(e)),
    }
}

/// Plans one self-merge of the two largest notes (pass its `positions` and `amount` to
/// `build_transfer` with the wallet's own address as the recipient).
pub fn plan_self_merge(state_json: &str, fee_quanta: &str) -> ApiResult {
    let st = state(state_json)?;
    out(json!(plan_merge(&st, amount(fee_quanta, "fee")?).map_err(err)?))
}

#[derive(Deserialize)]
struct CtxJson {
    chain_id: String,
    anchor: String,
    expiry_height: u64,
}

impl CtxJson {
    fn ctx(&self) -> Result<TxContext, String> {
        if self.chain_id.is_empty() {
            return Err(bad("chain_id is empty"));
        }
        Ok(TxContext { chain_id: self.chain_id.clone(), anchor: hex32(&self.anchor, "anchor")?, expiry_height: self.expiry_height })
    }
}

fn built(tx: BuiltTx, spent: &[u64]) -> ApiResult {
    let role = |r: wallet::OutputRole| match r {
        wallet::OutputRole::Payment => "payment",
        wallet::OutputRole::Change => "change",
        wallet::OutputRole::Dummy => "dummy",
    };
    let nf = tx.nullifiers();
    out(json!({
        "tx_type": tx.kind.tx_type(),
        "body": hex::encode(&tx.body),
        "binding": hex::encode(tx.binding),
        "public_inputs": hex::encode(&tx.public_inputs),
        "proof": hex::encode(&tx.proof),
        "envelope_json": tx.envelope_json().map_err(err)?,
        "signing_bytes": tx.signing_bytes.as_ref().map(hex::encode),
        "needs_account_signature": tx.kind == TxKind::Shield,
        "nullifiers": [hex::encode(nf[0]), hex::encode(nf[1])],
        "spent_positions": spent,
        "outputs": tx.outputs.iter().map(|o| json!({
            "slot": o.slot, "role": role(o.role), "value": o.value.to_string(), "r": hex::encode(o.r), "cm": hex::encode(o.cm),
        })).collect::<Vec<_>>(),
    }))
}

#[derive(Deserialize)]
struct ShieldJson {
    #[serde(flatten)]
    ctx: CtxJson,
    /// the funding account's ML-DSA-65 public key, hexadecimal
    from_pub_key: String,
    nonce: u64,
    v_in: String,
    fee: String,
    /// `rshield1…`
    recipient: String,
}

/// Builds and proves a `shield_v2`. The account key is not involved: sign `signing_bytes` with
/// it and call [`attach_signature`].
pub fn build_shield(params_json: &str) -> ApiResult {
    let p: ShieldJson = serde_json::from_str(params_json).map_err(|e| bad(&format!("shield parameters: {e}")))?;
    if p.from_pub_key.len() != 3_904 || !lower_hex(&p.from_pub_key) {
        return Err(bad("from_pub_key must be 3,904 lowercase hexadecimal characters"));
    }
    let key = hex::decode(&p.from_pub_key).map_err(|_| bad("from_pub_key"))?;
    let recipient = ShieldedAddress::decode(&p.recipient).map_err(err)?;
    let tx = wallet::build_shield(&ShieldRequest {
        ctx: p.ctx.ctx()?,
        from_pub_key: &key,
        nonce: p.nonce,
        v_in: amount(&p.v_in, "v_in")?,
        fee: amount(&p.fee, "fee")?,
        recipient: &recipient,
    })
    .map_err(err)?;
    built(tx, &[])
}

/// A `shield_v2` envelope with the account signature filled in.
pub fn attach_signature(envelope_json: &str, sig_hex: &str) -> ApiResult {
    let mut v: Value = serde_json::from_str(envelope_json).map_err(|e| bad(&format!("envelope: {e}")))?;
    if v.get("tx_type").and_then(Value::as_str) != Some("shield_v2") {
        return Err(bad("only a shield_v2 carries an account signature"));
    }
    if sig_hex.is_empty() || sig_hex.len() % 2 != 0 || !lower_hex(sig_hex) {
        return Err(bad("the signature must be non-empty lowercase hexadecimal"));
    }
    // re-encoded by the chain's own structure (so `"fee":0.0` stays as the node writes it)
    let tx: wallet::TxV1 = serde_json::from_value(v.take()).map_err(|e| bad(&format!("envelope: {e}")))?;
    let tx = wallet::TxV1 { sig: sig_hex.to_string(), ..tx };
    serde_json::to_string(&tx).map_err(|e| format!("internal: {e}"))
}

fn inputs(st: &WalletState, positions: &[u64]) -> Result<Vec<SpendInput>, String> {
    if positions.is_empty() || positions.len() > 2 {
        return Err(bad("inputs must name one or two note positions"));
    }
    positions.iter().map(|&p| st.spend_input(p).map_err(err)).collect()
}

#[derive(Deserialize)]
struct TransferJson {
    #[serde(flatten)]
    ctx: CtxJson,
    /// leaf positions of the notes to spend (from `plan_payment`)
    inputs: Vec<u64>,
    recipient: String,
    amount: String,
    fee: String,
}

/// Builds and proves a `shielded_transfer_v2`. Ready to submit.
pub fn build_transfer(seed: &[u8], state_json: &str, params_json: &str) -> ApiResult {
    let p: TransferJson = serde_json::from_str(params_json).map_err(|e| bad(&format!("transfer parameters: {e}")))?;
    let st = state(state_json)?;
    let k = keys(seed)?;
    if st.pk() != k.address().pk {
        return Err(bad("this state belongs to another wallet"));
    }
    let notes = inputs(&st, &p.inputs)?;
    let recipient = ShieldedAddress::decode(&p.recipient).map_err(err)?;
    let tx = wallet::build_transfer(&TransferRequest {
        ctx: p.ctx.ctx()?,
        keys: &k,
        inputs: &notes,
        recipient: &recipient,
        amount: amount(&p.amount, "amount")?,
        fee: amount(&p.fee, "fee")?,
    })
    .map_err(err)?;
    built(tx, &p.inputs)
}

#[derive(Deserialize)]
struct UnshieldJson {
    #[serde(flatten)]
    ctx: CtxJson,
    inputs: Vec<u64>,
    /// the `rouge1…` address that receives `v_out`
    to: String,
    v_out: String,
    fee: String,
}

/// Builds and proves an `unshield_v2`. Ready to submit.
pub fn build_unshield(seed: &[u8], state_json: &str, params_json: &str) -> ApiResult {
    let p: UnshieldJson = serde_json::from_str(params_json).map_err(|e| bad(&format!("unshield parameters: {e}")))?;
    let st = state(state_json)?;
    let k = keys(seed)?;
    if st.pk() != k.address().pk {
        return Err(bad("this state belongs to another wallet"));
    }
    let notes = inputs(&st, &p.inputs)?;
    let tx = wallet::build_unshield(&UnshieldRequest {
        ctx: p.ctx.ctx()?,
        keys: &k,
        inputs: &notes,
        to_account: account_from_address(&p.to).map_err(err)?,
        v_out: amount(&p.v_out, "v_out")?,
        fee: amount(&p.fee, "fee")?,
    })
    .map_err(err)?;
    built(tx, &p.inputs)
}

/// Marks notes spent locally after submitting a transaction (`spent = true`) or releases them
/// again if it was dropped (`spent = false`). Returns the new state.
pub fn mark_pending(state_json: &str, positions_json: &str, spent: bool) -> ApiResult {
    let mut st = state(state_json)?;
    let positions: Vec<u64> = serde_json::from_str(positions_json).map_err(|e| bad(&format!("positions: {e}")))?;
    for p in positions {
        let ok = if spent { st.mark_pending_spent(p) } else { st.unmark_pending(p) };
        if !ok {
            return Err(bad(&format!("no note at position {p} in the expected state")));
        }
    }
    st.to_json().map_err(err)
}
