//! The surface in plain Rust: strings and bytes in, a JSON string or an error out. Everything
//! here is callable natively (the tests of this crate do), and nothing here panics on caller
//! data — on `wasm32-unknown-unknown` a panic is a trap, which is exactly what the JavaScript
//! side must never see.
//!
//! **No error text quotes an argument** (REVIEW_WALLET_1 F-6). An error is a code, a fixed
//! sentence and — for JSON that does not parse — the parser's error category with line and
//! column. The parser's own message is never forwarded: for a value of the wrong type it quotes
//! the value, and the value may be a scan key or a whole wallet state.

use quantum_vault_shield_v2_wallet as wallet;
use serde::Deserialize;
use serde_json::{json, Value};
use wallet::{
    account_from_address, json_error, plan_merge_with, select_inputs_with, BuiltTx, ListingPage, PendingTx, ScanKey,
    ShieldRequest, ShieldedAddress, ShieldedKeys, SpendInput, StateReport, Tally, TransferRequest, TxContext, TxKind,
    UnshieldRequest, WalletError, WalletState,
};
use zeroize::{Zeroize, Zeroizing};

/// An error for JavaScript: a stable machine-readable `code`, then the text.
pub type ApiResult = Result<String, String>;

fn code(e: &WalletError) -> &'static str {
    match e {
        WalletError::Entropy(_) => "entropy",
        WalletError::Key(_) => "key",
        WalletError::Address(_) => "address",
        WalletError::Request(_) => "request",
        WalletError::FeeBelowMinimum { .. } => "fee_below_minimum",
        WalletError::FeeAboveMaximum { .. } => "fee_above_maximum",
        WalletError::NoteLocked => "note_locked",
        WalletError::NoteUnverified => "note_unverified",
        WalletError::StaleState => "stale_state",
        WalletError::RescanRequired => "rescan_required",
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

/// `what` is always a constant of this file — never caller data.
fn bad(what: &'static str) -> String {
    format!("request: {what}")
}

/// A JSON argument that does not parse: the fixed name of the argument and the position.
fn bad_json(what: &'static str, e: &serde_json::Error) -> String {
    format!("request: {}", json_error(what, e))
}

fn out(v: Value) -> ApiResult {
    serde_json::to_string(&v).map_err(|_| "internal: result encoding".to_string())
}

/// `{"state": <state>, "revision": n, …rest}` with the state serialised exactly once (I-7).
/// `revision` is the revision of the returned state: what the caller stores next to it and
/// passes as `expected_revision` to the next call that changes the state.
fn out_with_state(st: &WalletState, rest: Value) -> ApiResult {
    let state = st.to_json().map_err(err)?;
    let revision = st.revision();
    let rest = serde_json::to_string(&rest).map_err(|_| "internal: result encoding".to_string())?;
    match rest.strip_prefix('{') {
        Some("}") => Ok(format!("{{\"state\":{state},\"revision\":{revision}}}")),
        Some(tail) => Ok(format!("{{\"state\":{state},\"revision\":{revision},{tail}")),
        None => Err("internal: result encoding".to_string()),
    }
}

/// The state a call is about to CHANGE, checked against the revision the caller expects
/// (REVIEW_WALLET_2 I-3).
///
/// Every call here is stateless: it takes a state and returns a new one. Two writers — two tabs,
/// a page and a worker — that each load the stored state, change it and store the result drop
/// each other's change; a dropped `mark_pending` is a dropped lock, and a dropped lock is a
/// double payment waiting for a retry. So the state carries a revision that goes up with every
/// change, every changing call returns the new one, and takes the one the caller expects:
///
/// * the caller keeps the revision next to the stored state (the same record, or a key written in
///   the same storage transaction);
/// * before a changing call it reads the STORED revision and passes it as `expected_revision`
///   with the state it has in hand. If that copy is older, the call fails with `stale_state:` and
///   the caller reloads;
/// * it stores the result only if the stored revision is still `expected_revision`
///   (compare-and-swap in its storage transaction — the part only the caller can do).
///
/// Two DEVICES on one recovery phrase have no shared storage and cannot share locks. That case is
/// not a lost update; it is the `superseded` outcome of `resolve_pending`, which loses nothing.
fn state_for_update(json: &str, expected_revision: f64) -> Result<WalletState, String> {
    if !(expected_revision.is_finite() && expected_revision >= 0.0 && expected_revision.fract() == 0.0 && expected_revision <= wallet::store::MAX_REVISION as f64) {
        return Err(bad("expected_revision must be a non-negative integer"));
    }
    let st = state(json)?;
    st.expect_revision(expected_revision as u64).map_err(err)?;
    Ok(st)
}

fn tally(t: Tally) -> Value {
    json!({ "count": t.count, "total": t.total.to_string() })
}

fn lower_hex(s: &str) -> bool {
    s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn hex32(s: &str, what: &'static str) -> Result<[u8; 32], String> {
    if s.len() != 64 || !lower_hex(s) {
        return Err(bad(what));
    }
    hex::decode(s).ok().and_then(|v| v.try_into().ok()).ok_or_else(|| bad(what))
}

fn amount(s: &str, what: &'static str) -> Result<u64, String> {
    if s.is_empty() || s.len() > 20 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad(what));
    }
    s.parse().map_err(|_| bad(what))
}

const E_AMOUNT: &str = "amount must be a decimal string of quanta that fits in 64 bits";
const E_FEE: &str = "fee must be a decimal string of quanta that fits in 64 bits";
const E_MAX_FEE: &str = "max_fee must be a decimal string of quanta that fits in 64 bits";
const E_V_IN: &str = "v_in must be a decimal string of quanta that fits in 64 bits";
const E_MIN_NOTE: &str = "min_note_value must be a decimal string of quanta that fits in 64 bits";
const E_V_OUT: &str = "v_out must be a decimal string of quanta that fits in 64 bits";

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
        "default_expiry_offset": wallet::DEFAULT_EXPIRY_OFFSET,
        "max_expiry_offset": wallet::MAX_EXPIRY_OFFSET,
        "default_max_fee_quanta": wallet::DEFAULT_MAX_FEE_QUANTA.to_string(),
        "default_confirm_quorum": wallet::DEFAULT_CONFIRM_QUORUM,
        "default_min_note_value": wallet::DEFAULT_MIN_NOTE_VALUE.to_string(),
        "max_stored_notes": wallet::MAX_STORED_NOTES,
        "prune_retention_blocks": wallet::PRUNE_RETENTION_BLOCKS,
        "state_version": wallet::STATE_VERSION,
        "address_version": wallet::keys::ADDRESS_VERSION,
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

impl Drop for ScanKeyJson {
    fn drop(&mut self) {
        self.dk.zeroize();
        if let Some(nk) = self.nk.as_mut() {
            nk.zeroize();
        }
    }
}

fn scan_key(json: &str) -> Result<ScanKey, String> {
    let k: ScanKeyJson = serde_json::from_str(json).map_err(|e| bad_json("scan key", &e))?;
    let nk = match &k.nk {
        Some(nk) => Some(hex32(nk, "nk must be 64 lowercase hexadecimal characters")?),
        None => None,
    };
    if k.dk.len() != 4_800 || !lower_hex(&k.dk) {
        return Err(bad("dk must be 4,800 lowercase hexadecimal characters"));
    }
    // the decoded viewing key is wiped when this function returns (I-2); `ScanKey` wipes its own copy
    let dk = Zeroizing::new(hex::decode(&k.dk).map_err(|_| bad("dk must be 4,800 lowercase hexadecimal characters"))?);
    ScanKey::from_parts(hex32(&k.pk, "pk must be 64 lowercase hexadecimal characters")?, nk, &dk).map_err(err)
}

/// An empty wallet state (revision 0) for this address. Scanning it from height 0 is the restore
/// of spec §5.4. `min_note_value_quanta`: incoming notes below it are counted and not stored
/// (dust: a note worth less than the fee to spend it); `""` is the default, the minimum fee
/// (1 XRGE); `"1"` stores every non-zero note.
pub fn new_state(address: &str, min_note_value_quanta: &str) -> ApiResult {
    let addr = ShieldedAddress::decode(address).map_err(err)?;
    let st = match min_note_value_quanta {
        "" => WalletState::new(addr.pk),
        s => WalletState::with_min_note_value(addr.pk, amount(s, E_MIN_NOTE)?).map_err(err)?,
    };
    st.to_json().map_err(err)
}

fn balances(st: &WalletState) -> Value {
    let b = st.balances();
    json!({
        "confirmed_balance": b.confirmed.to_string(),
        "unverified_balance": b.unverified.to_string(),
        "locked_balance": b.locked.to_string(),
        "spendable_balance": b.spendable.to_string(),
        "expected_change": b.expected_change.to_string(),
    })
}

fn scan_result(st: &WalletState, reports: Value) -> ApiResult {
    let mut v = balances(st);
    v["report"] = reports;
    v["anchor"] = json!(hex::encode(st.anchor()));
    v["scanned_height"] = json!(st.scanned_height());
    out_with_state(st, v)
}

/// Applies one page of `GET /api/shield-v2/notes` to the state. Returns the new state and what
/// was found; on any error the caller keeps its old state. Notes found are `unverified` until
/// [`confirm_state`] — `confirmed_balance` does not include them — and nothing the report says
/// of a pending transaction settles it ([`resolve_pending`]).
pub fn scan(state_json: &str, page_json: &str, scan_key_json: &str, expected_revision: f64) -> ApiResult {
    let mut st = state_for_update(state_json, expected_revision)?;
    let page = ListingPage::from_json(page_json).map_err(err)?;
    let report = st.scan(&page, &scan_key(scan_key_json)?).map_err(err)?;
    scan_result(&st, json!(report))
}

/// [`scan`] for several pages at once (`pages_json`: a JSON array of pages, in order): the state
/// is parsed and written once instead of once per page. All pages are applied or none; `report`
/// is an array with one entry per page.
pub fn scan_pages(state_json: &str, pages_json: &str, scan_key_json: &str, expected_revision: f64) -> ApiResult {
    let mut st = state_for_update(state_json, expected_revision)?;
    if pages_json.len() > 64 << 20 {
        return Err(bad("pages must be at most 64 MiB"));
    }
    let pages: Vec<ListingPage> = serde_json::from_str(pages_json).map_err(|e| bad_json("pages", &e))?;
    let key = scan_key(scan_key_json)?;
    let mut reports = Vec::with_capacity(pages.len());
    for page in &pages {
        reports.push(st.scan(page, &key).map_err(err)?);
    }
    scan_result(&st, json!(reports))
}

/// The balances, anchor, notes and pending transactions of a state. `confirmed_balance` is what
/// a quorum of nodes vouched for, as of `confirmed_height`; `unverified_balance` is what one
/// node's listing says and must be shown as unconfirmed; `locked_balance` is the part held by
/// pending transactions; `expected_change` is in none of them. `below_minimum` / `over_capacity`
/// count incoming notes that were not stored, `pruned` the spent notes dropped from the state.
pub fn summary(state_json: &str) -> ApiResult {
    let st = state(state_json)?;
    let mut v = balances(&st);
    v["revision"] = json!(st.revision());
    v["nullifier_acc"] = json!(hex::encode(st.nullifier_acc()));
    v["nullifier_count"] = json!(st.nullifier_count());
    v["min_note_value"] = json!(st.min_note_value().to_string());
    v["below_minimum"] = tally(st.below_minimum());
    v["over_capacity"] = tally(st.over_capacity());
    v["pruned"] = tally(st.pruned());
    v["anchor"] = json!(hex::encode(st.anchor()));
    v["next_height"] = json!(st.next_height());
    v["scanned_height"] = json!(st.scanned_height());
    v["confirmed_height"] = json!(st.confirmed_height());
    v["note_count"] = json!(st.tree().note_count());
    v["notes"] = json!(st.notes());
    v["pending"] = json!(st.pending());
    out(v)
}

/// Chooses the notes for a payment (a transfer's amount or an unshield's `v_out`).
/// `status`: `ok` (with `selection`), `needs_merge` (with `merges`) or `insufficient_funds`.
/// Notes locked by a pending transaction are never chosen; unverified notes only with
/// `allow_unverified = true`.
pub fn plan_payment(state_json: &str, amount_quanta: &str, fee_quanta: &str, allow_unverified: bool) -> ApiResult {
    let st = state(state_json)?;
    match select_inputs_with(&st, amount(amount_quanta, E_AMOUNT)?, amount(fee_quanta, E_FEE)?, allow_unverified) {
        // a change note below the state's minimum note value would be counted, not stored
        Ok(sel) => out(json!({ "status": "ok", "change_below_min_note_value": sel.change > 0 && sel.change < st.min_note_value(), "selection": sel })),
        Err(WalletError::NeedsMerge { merges }) => out(json!({ "status": "needs_merge", "merges": merges })),
        Err(WalletError::InsufficientFunds { have, need }) => {
            out(json!({ "status": "insufficient_funds", "have": have.to_string(), "need": need.to_string() }))
        }
        Err(e) => Err(err(e)),
    }
}

/// Plans one self-merge of the two largest notes (pass its `positions` and `amount` to
/// `build_transfer` with the wallet's own address as the recipient).
pub fn plan_self_merge(state_json: &str, fee_quanta: &str, allow_unverified: bool) -> ApiResult {
    let st = state(state_json)?;
    out(json!(plan_merge_with(&st, amount(fee_quanta, E_FEE)?, allow_unverified).map_err(err)?))
}

#[derive(Deserialize)]
struct CtxJson {
    chain_id: String,
    anchor: String,
    /// The height whose pool state has the anchor as its root. Required for a shield (the node's
    /// tip); for a transfer or unshield it is the state's scanned height and may be left out.
    #[serde(default)]
    anchor_height: Option<u64>,
    /// Default: `anchor_height + 64`.
    #[serde(default)]
    expiry_height: Option<u64>,
    /// Default: 10 x the minimum fee.
    #[serde(default)]
    max_fee: Option<String>,
}

impl CtxJson {
    fn ctx(&self, scanned: Option<u64>) -> Result<TxContext, String> {
        if self.chain_id.is_empty() {
            return Err(bad("chain_id is empty"));
        }
        let anchor_height = match (self.anchor_height, scanned) {
            (Some(h), Some(s)) if h != s => return Err(bad("anchor_height is not the state's scanned height")),
            (Some(h), _) => h,
            (None, Some(s)) => s,
            (None, None) => return Err(bad("anchor_height is missing")),
        };
        let mut ctx = TxContext::new(&self.chain_id, hex32(&self.anchor, "anchor must be 64 lowercase hexadecimal characters")?, anchor_height);
        if let Some(e) = self.expiry_height {
            ctx.expiry_height = e;
        }
        Ok(ctx)
    }
    fn max_fee(&self) -> Result<Option<u64>, String> {
        self.max_fee.as_deref().map(|s| amount(s, E_MAX_FEE)).transpose()
    }
}

/// The JSON of a built transaction. `outputs[].r` and `.value` are the sender's record of its
/// notes and are SECRET (whoever holds them can open the commitment): store them encrypted, never
/// log them (I-3). `pending` is what [`mark_pending`] takes — `null` for a shield.
fn built(tx: BuiltTx) -> ApiResult {
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
        "spent_positions": tx.input_positions,
        "expiry_height": tx.expiry_height,
        "pending": tx.pending(),
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
    let p: ShieldJson = serde_json::from_str(params_json).map_err(|e| bad_json("shield parameters", &e))?;
    if p.from_pub_key.len() != 3_904 || !lower_hex(&p.from_pub_key) {
        return Err(bad("from_pub_key must be 3,904 lowercase hexadecimal characters"));
    }
    let key = hex::decode(&p.from_pub_key).map_err(|_| bad("from_pub_key must be 3,904 lowercase hexadecimal characters"))?;
    let recipient = ShieldedAddress::decode(&p.recipient).map_err(err)?;
    let tx = wallet::build_shield(&ShieldRequest {
        ctx: p.ctx.ctx(None)?,
        from_pub_key: &key,
        nonce: p.nonce,
        v_in: amount(&p.v_in, E_V_IN)?,
        fee: amount(&p.fee, E_FEE)?,
        max_fee: p.ctx.max_fee()?,
        recipient: &recipient,
    })
    .map_err(err)?;
    built(tx)
}

/// A `shield_v2` envelope with the account signature filled in.
pub fn attach_signature(envelope_json: &str, sig_hex: &str) -> ApiResult {
    let mut v: Value = serde_json::from_str(envelope_json).map_err(|e| bad_json("envelope", &e))?;
    if v.get("tx_type").and_then(Value::as_str) != Some("shield_v2") {
        return Err(bad("only a shield_v2 carries an account signature"));
    }
    if sig_hex.is_empty() || sig_hex.len() % 2 != 0 || !lower_hex(sig_hex) {
        return Err(bad("the signature must be non-empty lowercase hexadecimal"));
    }
    // re-encoded by the chain's own structure (so `"fee":0.0` stays as the node writes it)
    let tx: wallet::TxV1 = serde_json::from_value(v.take()).map_err(|_| bad("envelope: not a transaction envelope"))?;
    let tx = wallet::TxV1 { sig: sig_hex.to_string(), ..tx };
    serde_json::to_string(&tx).map_err(|_| "internal: result encoding".to_string())
}

/// The notes for a builder. A locked note is always refused (`note_locked:`); a note that
/// `confirm_state` has not confirmed is refused (`note_unverified:`) unless the caller passes
/// `allow_unverified: true` — the same decision as in `plan_payment` (REVIEW_WALLET_2 I-4).
fn inputs(st: &WalletState, positions: &[u64], allow_unverified: bool) -> Result<Vec<SpendInput>, String> {
    if positions.is_empty() || positions.len() > 2 {
        return Err(bad("inputs must name one or two note positions"));
    }
    positions.iter().map(|&p| st.spend_input_with(p, allow_unverified).map_err(err)).collect()
}

#[derive(Deserialize)]
struct TransferJson {
    #[serde(flatten)]
    ctx: CtxJson,
    /// leaf positions of the notes to spend (from `plan_payment`)
    inputs: Vec<u64>,
    /// Default `false`: an input that is not confirmed is refused.
    #[serde(default)]
    allow_unverified: bool,
    recipient: String,
    amount: String,
    fee: String,
}

/// Builds and proves a `shielded_transfer_v2`. Ready to submit.
pub fn build_transfer(seed: &[u8], state_json: &str, params_json: &str) -> ApiResult {
    let p: TransferJson = serde_json::from_str(params_json).map_err(|e| bad_json("transfer parameters", &e))?;
    let st = state(state_json)?;
    let k = keys(seed)?;
    if st.pk() != k.address().pk {
        return Err(bad("this state belongs to another wallet"));
    }
    let notes = inputs(&st, &p.inputs, p.allow_unverified)?;
    let recipient = ShieldedAddress::decode(&p.recipient).map_err(err)?;
    let tx = wallet::build_transfer(&TransferRequest {
        ctx: p.ctx.ctx(Some(st.scanned_height().ok_or_else(|| bad("the state has not been scanned"))?))?,
        keys: &k,
        inputs: &notes,
        recipient: &recipient,
        amount: amount(&p.amount, E_AMOUNT)?,
        fee: amount(&p.fee, E_FEE)?,
        max_fee: p.ctx.max_fee()?,
    })
    .map_err(err)?;
    built(tx)
}

#[derive(Deserialize)]
struct UnshieldJson {
    #[serde(flatten)]
    ctx: CtxJson,
    inputs: Vec<u64>,
    /// Default `false`: an input that is not confirmed is refused.
    #[serde(default)]
    allow_unverified: bool,
    /// the `rouge1…` address that receives `v_out`
    to: String,
    v_out: String,
    fee: String,
}

/// Builds and proves an `unshield_v2`. Ready to submit.
pub fn build_unshield(seed: &[u8], state_json: &str, params_json: &str) -> ApiResult {
    let p: UnshieldJson = serde_json::from_str(params_json).map_err(|e| bad_json("unshield parameters", &e))?;
    let st = state(state_json)?;
    let k = keys(seed)?;
    if st.pk() != k.address().pk {
        return Err(bad("this state belongs to another wallet"));
    }
    let notes = inputs(&st, &p.inputs, p.allow_unverified)?;
    let tx = wallet::build_unshield(&UnshieldRequest {
        ctx: p.ctx.ctx(Some(st.scanned_height().ok_or_else(|| bad("the state has not been scanned"))?))?,
        keys: &k,
        inputs: &notes,
        to_account: account_from_address(&p.to).map_err(err)?,
        v_out: amount(&p.v_out, E_V_OUT)?,
        fee: amount(&p.fee, E_FEE)?,
        max_fee: p.ctx.max_fee()?,
    })
    .map_err(err)?;
    built(tx)
}

// ---- pending transactions (REVIEW_WALLET_1 F-7, REVIEW_WALLET_2 RW2-1..3) -------------------------

/// Records a built transfer or unshield as pending and locks its inputs. `pending_json` is the
/// `pending` object of the `build_*` result. Call it — and persist the returned state — BEFORE
/// the transaction is submitted to any node. From then on the inputs are not selected and not
/// accepted by `build_*` until [`resolve_pending`] settles the transaction on confirmed data.
/// `{ state, revision }`.
pub fn mark_pending(state_json: &str, pending_json: &str, expected_revision: f64) -> ApiResult {
    let mut st = state_for_update(state_json, expected_revision)?;
    let tx: PendingTx = serde_json::from_str(pending_json).map_err(|e| bad_json("pending transaction", &e))?;
    st.mark_pending(tx).map_err(err)?;
    out_with_state(&st, json!({}))
}

/// The pending transactions of a state (a JSON array).
pub fn pending(state_json: &str) -> ApiResult {
    out(json!(state(state_json)?.pending()))
}

/// Records that a node answered "rejected" for the pending transaction with this nullifier.
/// **A hint for the UI and nothing else**: the inputs stay locked, because the transaction is
/// still valid until its expiry height and the node may be lying. `{ state, revision, found }`.
pub fn note_rejection(state_json: &str, nullifier_hex: &str, expected_revision: f64) -> ApiResult {
    let mut st = state_for_update(state_json, expected_revision)?;
    let found = st.note_rejection_hint(&hex32(nullifier_hex, "nullifier must be 64 lowercase hexadecimal characters")?);
    out_with_state(&st, json!({ "found": found }))
}

/// Settles the pending list against the CONFIRMED height (the highest height at which
/// [`confirm_state`] matched a quorum): `{ state, revision, mined, superseded, expired,
/// still_pending }`.
///
/// * `mined` — a transaction at or below the confirmed height has both nullifiers and both output
///   commitments of the entry. Its inputs are spent, its change is a confirmed note.
/// * `superseded` — a DIFFERENT transaction at or below the confirmed height spent one of its
///   inputs (the same phrase on another device, usually). It can never be mined: the payment did
///   not happen. The inputs whose own nullifier appeared are spent, the others are free.
/// * `expired` — the confirmed height is at or above its expiry height and none of its nullifiers
///   appeared. It can never be mined; the inputs are free and a retry is safe.
/// * everything else stays pending and LOCKED: seen in a listing nobody confirmed, a "rejected"
///   answer, a height one node claims.
///
/// There is no flag and no other call that releases a lock on one node's word.
pub fn resolve_pending(state_json: &str, expected_revision: f64) -> ApiResult {
    let mut st = state_for_update(state_json, expected_revision)?;
    let r = st.resolve();
    out_with_state(&st, json!(r))
}

// ---- state confirmation (REVIEW_WALLET_1 F-1, REVIEW_WALLET_2 RW2-2, RW2-4) ------------------------

#[derive(Deserialize)]
struct StateReportJson {
    node_id: String,
    height: u64,
    tree_root: String,
    nullifier_acc: String,
    note_count: u64,
    nullifier_count: u64,
}

/// Compares the wallet's own pool state — tree root AND nullifier hash, with both counts — with
/// what several nodes report, and moves the confirmed height. `reports_json`:
/// `[{ "node_id", "height", "tree_root", "nullifier_acc", "note_count", "nullifier_count" }, …]`,
/// one entry per node: the `report` object of that node's `/api/shield-v2/stats` (one consistent
/// read of its pool state) plus **`node_id`, which the caller sets to the endpoint it configured
/// — never to anything the node returned**.
///
/// `quorum`: how many DISTINCT nodes must report exactly the wallet's state; `0` means the
/// default, 2. It is raised to a strict majority of the nodes in `reports_json`. With one node
/// and the default the notes stay unverified; a client that asks its own node passes 1.
///
/// If any report at a height the wallet can compare differs from the wallet's state, NOTHING is
/// confirmed and `report.diverged` is true with `report.conflicts`: the caller decides which
/// nodes to ask again and, if its own listing is what disagrees, rebuilds with [`rescan_state`]
/// against another node. `{ state, revision, report }`.
pub fn confirm_state(state_json: &str, reports_json: &str, quorum: u32, expected_revision: f64) -> ApiResult {
    let mut st = state_for_update(state_json, expected_revision)?;
    if reports_json.len() > 1 << 20 {
        return Err(bad("reports must be at most 1 MiB"));
    }
    let raw: Vec<StateReportJson> = serde_json::from_str(reports_json).map_err(|e| bad_json("state reports", &e))?;
    let mut reports = Vec::with_capacity(raw.len());
    for r in raw {
        reports.push(StateReport {
            tree_root: hex32(&r.tree_root, "a reported tree_root must be 64 lowercase hexadecimal characters")?,
            nullifier_acc: hex32(&r.nullifier_acc, "a reported nullifier_acc must be 64 lowercase hexadecimal characters")?,
            node_id: r.node_id,
            height: r.height,
            note_count: r.note_count,
            nullifier_count: r.nullifier_count,
        });
    }
    let report = st.confirm_state(&reports, (quorum != 0).then_some(quorum as usize)).map_err(err)?;
    out_with_state(&st, json!({ "report": report }))
}

/// The former name of [`confirm_state`]; the same call. A report without `nullifier_acc` and the
/// two counts is refused: a root alone does not commit the nullifiers (REVIEW_WALLET_2 RW2-2).
pub fn confirm_roots(state_json: &str, reports_json: &str, quorum: u32, expected_revision: f64) -> ApiResult {
    confirm_state(state_json, reports_json, quorum, expected_revision)
}

/// An empty state for the same wallet that keeps the pending transactions — every one of them as
/// pending and locked, whatever the old state had seen of it: what to scan into from height 0
/// after a reorganisation, a `listing:` error or a `diverged` state check. `min_note_value_quanta`:
/// `""` keeps the state's value. `{ state, revision }`.
pub fn rescan_state(state_json: &str, min_note_value_quanta: &str, expected_revision: f64) -> ApiResult {
    let st = state_for_update(state_json, expected_revision)?;
    let fresh = match min_note_value_quanta {
        "" => st.fresh_for_rescan(),
        s => st.fresh_for_rescan_with_min_note_value(amount(s, E_MIN_NOTE)?).map_err(err)?,
    };
    out_with_state(&fresh, json!({}))
}
