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
    account_from_address, json_error, plan_merge_with, select_inputs_with, BuiltTx, ListingPage, ScanKey, ShieldRequest,
    ShieldedAddress, ShieldedKeys, SpendOptions, StateReport, Tally, TransferParams, TxContext, TxKind, UnshieldParams,
    WalletError, WalletState,
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
        WalletError::StateUnconfirmed => "state_unconfirmed",
        WalletError::StaleState => "stale_state",
        WalletError::StateInvariant => "state_invariant",
        WalletError::RestoredRecently { .. } => "restored_recently",
        WalletError::ViewOnly => "view_only",
        WalletError::MixedOwnAddress => "recipient_mixed_address",
        WalletError::NoteBelowMinimum { .. } => "note_below_minimum",
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

/// `{"state": <state>, "revision": n, "revision_id": "…", …rest}` with the state serialised
/// exactly once (I-7). `revision` is the counter of the returned state: what the caller passes
/// as `expected_revision` to the next call that changes the state. **`revision_id` is the
/// IDENTITY of the returned state** (REVIEW_WALLET_4 RW4-10): what the caller stores next to it
/// and compares-and-swaps on. The state text has been read back by the core before it is
/// returned (`state_invariant:` otherwise): it is never a state the next call refuses.
fn out_with_state(st: &WalletState, rest: Value) -> ApiResult {
    let state = st.to_json().map_err(err)?;
    let revision = st.revision();
    let id = hex::encode(st.revision_id());
    let rest = serde_json::to_string(&rest).map_err(|_| "internal: result encoding".to_string())?;
    match rest.strip_prefix('{') {
        Some("}") => Ok(format!("{{\"state\":{state},\"revision\":{revision},\"revision_id\":\"{id}\"}}")),
        Some(tail) => Ok(format!("{{\"state\":{state},\"revision\":{revision},\"revision_id\":\"{id}\",{tail}")),
        None => Err("internal: result encoding".to_string()),
    }
}

/// The state a call is about to CHANGE, checked against the revision the caller expects
/// (REVIEW_WALLET_2 I-3).
///
/// Every call here is stateless: it takes a state and returns a new one. Two writers — two tabs,
/// a page and a worker — that each load the stored state, change it and store the result drop
/// each other's change; a dropped pending entry is a dropped lock, and a dropped lock is a
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
/// **The counter orders revisions; it does not identify a state** (REVIEW_WALLET_4 RW4-10): two
/// tabs that start from revision `r` both hold an "r + 1", with different locks. The check that
/// protects a lock is the storage's compare-and-swap on `revision_id` — the identity every
/// result carries — against the identity the tab LOADED, and [`expect_revision_id`] for a state
/// in hand. A state that could not be written is discarded, never worked on.
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
        "min_configured_nodes": wallet::MIN_CONFIGURED_NODES,
        "max_configured_nodes": wallet::MAX_CONFIGURED_NODES,
        "default_min_note_value": wallet::DEFAULT_MIN_NOTE_VALUE.to_string(),
        "default_max_unspent_notes": wallet::DEFAULT_MAX_UNSPENT_NOTES,
        "max_unspent_notes_limit": wallet::MAX_UNSPENT_NOTES_LIMIT,
        "max_spent_retained": wallet::MAX_SPENT_RETAINED,
        "prune_retention_blocks": wallet::PRUNE_RETENTION_BLOCKS,
        "state_version": wallet::STATE_VERSION,
        "restore_embargo_blocks": wallet::RESTORE_EMBARGO_BLOCKS,
        "restore_lag_bound_blocks": wallet::RESTORE_LAG_BOUND_BLOCKS,
        "max_own_shields": wallet::MAX_OWN_SHIELDS,
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
/// (1 XRGE); `"1"` stores every non-zero note. `max_unspent_notes`: the cap on UNSPENT notes
/// received from others (`0`: the default, 65,536); notes beyond it are counted in
/// `over_capacity` and recovered by [`rescan_state`] with a higher cap. The wallet's own outputs
/// are stored whatever their size and whatever the count.
///
/// The state is configured with no node: call [`set_nodes`] before anything can be confirmed.
///
/// **A state made here is under the restore embargo** (REVIEW_WALLET_4 RW4-1): it has no lock
/// history, so `build_transfer` / `build_unshield` refuse it (`restored_recently:`) until its
/// confirmed height is 128 blocks above its embargo base ([`summary`]`.spend`). The only way
/// around it is the user's explicit statement, [`assert_sole_copy`]. **Never answer a `state:`
/// error with this call**: use [`recover_locks`], which keeps the locks.
pub fn new_state(address: &str, min_note_value_quanta: &str, max_unspent_notes: u32) -> ApiResult {
    let addr = ShieldedAddress::decode(address).map_err(err)?;
    let min = match min_note_value_quanta {
        "" => wallet::DEFAULT_MIN_NOTE_VALUE,
        s => amount(s, E_MIN_NOTE)?,
    };
    let cap = if max_unspent_notes == 0 { wallet::DEFAULT_MAX_UNSPENT_NOTES } else { max_unspent_notes as usize };
    WalletState::with_limits(addr.pk, min, cap).map_err(err)?.to_json().map_err(err)
}

/// Configures the nodes the wallet asks for the pool state. `nodes_json`: a JSON array of the
/// endpoints the user or the application configured, e.g.
/// `["https://node-a.example", "https://node-b.example:8443", "https://node-c.example"]`.
///
/// Each id is canonicalised to an http(s) origin (scheme and host lower-cased, default port,
/// path, query and trailing slash removed) and duplicates are collapsed; an id that is not an
/// http(s) origin fails the call (`request:`). `{ state, revision, nodes, quorum }` with the
/// canonical set and the quorum `confirm_state` will apply: a strict majority of THIS set, at
/// least 2. It is the only call that changes the threshold. It does not un-confirm anything.
/// With fewer than two nodes nothing can be confirmed: such a wallet shows every note as
/// unverified and cannot build a spend.
pub fn set_nodes(state_json: &str, nodes_json: &str, expected_revision: f64) -> ApiResult {
    let mut st = state_for_update(state_json, expected_revision)?;
    if nodes_json.len() > 64 << 10 {
        return Err(bad("nodes must be at most 64 KiB"));
    }
    let ids: Vec<String> = serde_json::from_str(nodes_json).map_err(|e| bad_json("nodes", &e))?;
    let nodes = st.set_nodes(&ids).map_err(err)?;
    out_with_state(&st, json!({ "nodes": nodes, "quorum": st.quorum() }))
}

fn balances(st: &WalletState) -> Value {
    let b = st.balances();
    json!({
        "confirmed_balance": b.confirmed.to_string(),
        "unverified_balance": b.unverified.to_string(),
        "locked_balance": b.locked.to_string(),
        "spendable_balance": b.spendable.to_string(),
        "expected_change": b.expected_change.to_string(),
        // RW4-3: a state scanned without the nullifier key cannot see spends
        "unverified_spends": b.unverified_spends,
        "received_spend_unknown": b.received_spend_unknown.to_string(),
        "view_only_since": st.view_only_since(),
    })
}

/// The user's explicit statement, recorded in the state: **"no other copy of this wallet (another
/// device, a lost device, an old backup) has a payment that is still in flight"**. It is the
/// only override of the restore embargo, and `i_am_sure_no_other_copy_has_a_pending_payment`
/// must be `true` — the parameter exists to be read by whoever writes the call. Accepted only
/// before the first confirmed state check of a state made by [`new_state`] (`request:`
/// afterwards). **Once recorded it stands**: the first confirmed state check establishes the
/// state without an embargo, whatever the nodes report in it (REVIEW_WALLET_5 RW5-5 — the
/// earlier rule, which disregarded the statement when a configured node reported a higher tip,
/// is removed). If the statement is false, the wallet can pay twice: **a client calls this
/// without asking only for a phrase that was generated on this device in this installation,
/// and for an imported or restored phrase only after the user's explicit confirmation — never
/// from a helper that initialises a state** (`core/shield-v2-wallet/UI_CONTRACT.md`,
/// obligation 1). `{ state, revision, revision_id, spend }`.
pub fn assert_sole_copy(state_json: &str, i_am_sure_no_other_copy_has_a_pending_payment: bool, expected_revision: f64) -> ApiResult {
    let mut st = state_for_update(state_json, expected_revision)?;
    if !i_am_sure_no_other_copy_has_a_pending_payment {
        return Err(bad("the statement must be made explicitly (true)"));
    }
    st.assert_no_other_copy_has_a_pending_payment().map_err(err)?;
    let spend = json!(st.spend_status(None));
    out_with_state(&st, json!({ "spend": spend }))
}

/// Can this state build a spend now — and if not, why (`reason`: `no_nodes`, `view_only`,
/// `no_quorum`, `embargo`, `root_unconfirmed`, `window_too_short`), with every bound in BLOCKS
/// (REVIEW_WALLET_4 RW4-8: the chain has no block time). `quorum_tip`: the `report.quorum_tip`
/// of the latest [`confirm_state`], or a negative number when there is none; with it the result
/// carries `confirmed_lag` (`quorum_tip − confirmed_height`) and `usable_window_blocks`.
pub fn can_spend_now(state_json: &str, quorum_tip: f64) -> ApiResult {
    let st = state(state_json)?;
    let tip = (quorum_tip.is_finite() && quorum_tip >= 0.0 && quorum_tip.fract() == 0.0 && quorum_tip <= wallet::store::MAX_REVISION as f64).then_some(quorum_tip as u64);
    out(json!(st.spend_status(tip)))
}

/// Checks that the state in hand IS the revision with this identity (`stale_state:` otherwise) —
/// the check a counter cannot make (REVIEW_WALLET_4 RW4-10). `{ revision, revision_id }`.
pub fn expect_revision_id(state_json: &str, revision_id_hex: &str) -> ApiResult {
    let st = state(state_json)?;
    st.expect_revision_id(&hex32(revision_id_hex, "revision_id must be 64 lowercase hexadecimal characters")?).map_err(err)?;
    out(json!({ "revision": st.revision(), "revision_id": hex::encode(st.revision_id()) }))
}

/// **The answer to a `state:` error on a STORED state** (REVIEW_WALLET_4 RW4-5): reads every
/// pending entry it can out of a state text that no other call accepts, into an empty state for
/// the same wallet — scan into it from height 0, as after [`rescan_state`]. Every lock that can
/// be read is kept. `{ state, revision, revision_id, entries_kept, entries_unreadable,
/// expiry_unknown, nodes_kept, embargo }`: with `entries_unreadable > 0` (or `embargo: true`)
/// the recovered state is under the restore embargo; with `nodes_kept: false` call [`set_nodes`].
pub fn recover_locks(state_json: &str) -> ApiResult {
    let r = WalletState::recover_locks(state_json).map_err(err)?;
    out_with_state(
        &r.state,
        json!({ "entries_kept": r.entries_kept, "entries_unreadable": r.entries_unreadable, "expiry_unknown": r.expiry_unknown, "nodes_kept": r.nodes_kept, "embargo": r.embargo }),
    )
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

/// [`scan`] for several pages of ONE node at once (`pages_json`: a JSON array of pages, in
/// order): the state is parsed and written once instead of once per page; `report` is an array
/// with one entry per page.
///
/// **The classes are those of [`scan`]** (REVIEW_WALLET_6B RW6B-1):
///
/// * the OUTER argument is the caller's: text that is not a JSON array, or more than 64 MiB of
///   it, is `request:` (the client builds the array; it never comes from a node as a whole);
/// * every ELEMENT is a node's answer and is judged as `scan` judges it: an element that is
///   `null`, not an object, lacks a member, has a member of the wrong type or out of range, or
///   that `scan` refuses is `listing: page <i>: …` — `<i>` the element's index, from 0. An
///   element that is not a listing page at all reads `listing: page <i>: note listing: not a
///   listing page: …` ("no answer": a strike, not a ban — `NOTES.md` §6);
/// * **all or nothing**: on any error no page of the call is applied — the caller keeps the
///   state it handed in — and the error names the page (`rescan_required: page <i>: …` too).
pub fn scan_pages(state_json: &str, pages_json: &str, scan_key_json: &str, expected_revision: f64) -> ApiResult {
    let mut st = state_for_update(state_json, expected_revision)?;
    if pages_json.len() > 64 << 20 {
        return Err(bad("pages must be at most 64 MiB"));
    }
    let pages: Vec<Value> = serde_json::from_str(pages_json).map_err(|e| bad_json("pages", &e))?;
    let key = scan_key(scan_key_json)?;
    // each element goes to the core as the text of one answer, like the argument of `scan`
    let texts: Vec<String> = pages.iter().map(Value::to_string).collect();
    let reports = st.scan_pages(&texts, &key).map_err(|e| format!("{}: page {}: {}", code(&e.error), e.index, e.error))?;
    scan_result(&st, json!(reports))
}

/// The balances, anchor, notes and pending transactions of a state. `confirmed_balance` is what
/// a strict majority of the configured nodes vouched for, as of `confirmed_height`; `unverified_balance` is what one
/// node's listing says and must be shown as unconfirmed; `locked_balance` is the part held by
/// pending transactions; `expected_change` is in none of them. `below_minimum` / `over_capacity`
/// count incoming notes that were not stored, `pruned` the spent notes dropped from the state.
pub fn summary(state_json: &str) -> ApiResult {
    let st = state(state_json)?;
    let mut v = balances(&st);
    v["revision"] = json!(st.revision());
    v["revision_id"] = json!(hex::encode(st.revision_id()));
    // can it spend, why not, and every bound in blocks (RW4-1, RW4-3, RW4-8)
    v["spend"] = json!(st.spend_status(None));
    v["spend_embargo"] = json!(st.spend_embargo());
    v["sole_copy_asserted"] = json!(st.sole_copy_asserted());
    v["own_shields"] = json!(st.own_shields().len());
    v["nullifier_acc"] = json!(hex::encode(st.nullifier_acc()));
    v["nullifier_count"] = json!(st.nullifier_count());
    v["ciphertext_acc"] = json!(hex::encode(st.ciphertext_acc()));
    v["nodes"] = json!(st.nodes());
    v["quorum"] = json!(st.quorum());
    v["max_unspent_notes"] = json!(st.max_unspent_notes());
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
///
/// The selection prefers a CLEAN change — zero, or at least the state's minimum note value: the
/// smallest single note with a clean change, else the smallest pair with one, else whatever
/// covers the payment. Only in that last case is `change_below_min_note_value` true (also as
/// `selection.change_below_minimum`): the change will be a note that costs more to spend alone
/// than it is worth. The wallet still stores it and can spend it as a second input.
pub fn plan_payment(state_json: &str, amount_quanta: &str, fee_quanta: &str, allow_unverified: bool) -> ApiResult {
    let st = state(state_json)?;
    match select_inputs_with(&st, amount(amount_quanta, E_AMOUNT)?, amount(fee_quanta, E_FEE)?, allow_unverified) {
        Ok(sel) => out(json!({ "status": "ok", "change_below_min_note_value": sel.change_below_minimum, "selection": sel })),
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

/// The context of a `shield_v2` (it spends no note of the wallet and locks nothing).
#[derive(Deserialize)]
struct CtxJson {
    chain_id: String,
    anchor: String,
    /// The height whose pool state has the anchor as its root: the node's tip.
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
    fn ctx(&self) -> Result<TxContext, String> {
        if self.chain_id.is_empty() {
            return Err(bad("chain_id is empty"));
        }
        let anchor_height = self.anchor_height.ok_or_else(|| bad("anchor_height is missing"))?;
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

/// What a transfer or an unshield takes besides its amounts. **No height**: the anchor is the
/// state's confirmed tree root and the expiry is measured from the state's confirmed height
/// (REVIEW_WALLET_3 RW3-7) — neither is the caller's to say, and neither is one node's.
#[derive(Deserialize)]
struct SpendJson {
    chain_id: String,
    /// Optional cross-check: if present it must be the state's own tree root
    /// (`anchor_mismatch:` otherwise).
    #[serde(default)]
    anchor: Option<String>,
    /// leaf positions of the notes to spend (from `plan_payment`)
    inputs: Vec<u64>,
    /// Default `false`: an input that is not confirmed, or a tree root above the confirmed
    /// height, is refused.
    #[serde(default)]
    allow_unverified: bool,
    /// Default: the confirmed height + 64. At most the confirmed height + 128.
    #[serde(default)]
    expiry_height: Option<u64>,
    /// Default: 10 x the minimum fee.
    #[serde(default)]
    max_fee: Option<String>,
}

impl SpendJson {
    fn options(&self, st: &WalletState) -> Result<SpendOptions<'_>, String> {
        if let Some(a) = &self.anchor {
            if hex32(a, "anchor must be 64 lowercase hexadecimal characters")? != st.anchor() {
                return Err(err(WalletError::AnchorMismatch));
            }
        }
        Ok(SpendOptions {
            chain_id: &self.chain_id,
            inputs: &self.inputs,
            expiry_height: self.expiry_height,
            allow_unverified: self.allow_unverified,
            max_fee: self.max_fee.as_deref().map(|s| amount(s, E_MAX_FEE)).transpose()?,
        })
    }
}

/// The JSON of a built transaction. `outputs[].r` and `.value` are the sender's record of its
/// notes and are SECRET (whoever holds them can open the commitment): store them encrypted, never
/// log them (I-3). `pending` is the entry the returned state already holds for a transfer or an
/// unshield (for display; nothing has to be done with it) — `null` for a shield.
fn built(tx: &BuiltTx) -> Result<Value, String> {
    let role = |r: wallet::OutputRole| match r {
        wallet::OutputRole::Payment => "payment",
        wallet::OutputRole::Change => "change",
        wallet::OutputRole::Dummy => "dummy",
    };
    let nf = tx.nullifiers();
    Ok(json!({
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
    /// Default `false`: a note (`v_in − fee`) below the minimum note value is refused
    /// (`note_below_minimum:`).
    #[serde(default)]
    allow_below_min_note_value: bool,
}

fn shield_key(p: &ShieldJson) -> Result<Vec<u8>, String> {
    if p.from_pub_key.len() != 3_904 || !lower_hex(&p.from_pub_key) {
        return Err(bad("from_pub_key must be 3,904 lowercase hexadecimal characters"));
    }
    hex::decode(&p.from_pub_key).map_err(|_| bad("from_pub_key must be 3,904 lowercase hexadecimal characters"))
}

/// Builds and proves a `shield_v2` to SOMEBODY ELSE's address. The account key is not involved:
/// sign `signing_bytes` with it and call [`attach_signature`]. A note below the default minimum
/// note value (1 XRGE) is refused (`note_below_minimum:`) unless `allow_below_min_note_value`:
/// the recipient's wallet would not store it. **For the wallet's own address use
/// [`build_own_shield`]**, which records the note in the state.
pub fn build_shield(params_json: &str) -> ApiResult {
    let p: ShieldJson = serde_json::from_str(params_json).map_err(|e| bad_json("shield parameters", &e))?;
    let key = shield_key(&p)?;
    let recipient = ShieldedAddress::decode(&p.recipient).map_err(err)?;
    let req = ShieldRequest {
        ctx: p.ctx.ctx()?,
        from_pub_key: &key,
        nonce: p.nonce,
        v_in: amount(&p.v_in, E_V_IN)?,
        fee: amount(&p.fee, E_FEE)?,
        max_fee: p.ctx.max_fee()?,
        recipient: &recipient,
    };
    let tx = wallet::build_shield_with(&req, wallet::DEFAULT_MIN_NOTE_VALUE, p.allow_below_min_note_value).map_err(err)?;
    out(built(&tx)?)
}

/// Builds and proves a `shield_v2` **to the wallet's own address and records its note in the
/// state** (REVIEW_WALLET_4 RW4-11): `{ state, revision, revision_id, …BuiltTx }`. Persist the
/// state; sign `signing_bytes` and submit. `own_address`: the wallet's own `rshield1…` address
/// ([`shielded_address`]); `recipient` in `params_json` must be exactly it — an address with
/// the wallet's `pk` and another encryption key is refused (`recipient_mixed_address:`). The
/// note is then stored from the record whatever its value. A note below the STATE's minimum
/// note value is refused (`note_below_minimum:`) unless `allow_below_min_note_value`.
pub fn build_own_shield(state_json: &str, own_address: &str, params_json: &str, expected_revision: f64) -> ApiResult {
    let p: ShieldJson = serde_json::from_str(params_json).map_err(|e| bad_json("shield parameters", &e))?;
    let st = state_for_update(state_json, expected_revision)?;
    let key = shield_key(&p)?;
    let own = ShieldedAddress::decode(own_address).map_err(err)?;
    let recipient = ShieldedAddress::decode(&p.recipient).map_err(err)?;
    let req = ShieldRequest {
        ctx: p.ctx.ctx()?,
        from_pub_key: &key,
        nonce: p.nonce,
        v_in: amount(&p.v_in, E_V_IN)?,
        fee: amount(&p.fee, E_FEE)?,
        max_fee: p.ctx.max_fee()?,
        recipient: &recipient,
    };
    let r = wallet::build_own_shield(&st, st.revision(), &own, &req, p.allow_below_min_note_value).map_err(err)?;
    out_with_state(&r.state, built(&r.tx)?)
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

#[derive(Deserialize)]
struct TransferJson {
    #[serde(flatten)]
    spend: SpendJson,
    recipient: String,
    amount: String,
    fee: String,
}

/// The transaction and the state it is locked in, as one result: `{ state, revision, …BuiltTx }`.
fn locked(l: wallet::LockedTx) -> ApiResult {
    out_with_state(&l.state, built(&l.tx)?)
}

/// Builds and proves a `shielded_transfer_v2` **and locks its inputs — one call**
/// (REVIEW_WALLET_3 RW3-5). `{ state, revision, envelope_json, … }`: the returned state already
/// holds the pending entry (nullifiers, outputs, change, expiry) and the lock on the inputs.
///
/// **Persist the returned state, then submit `envelope_json`.** If the state could not be
/// persisted (a crash, a failed write, another writer got in first), do NOT submit: load the
/// stored state and build again. There is no call that returns a submittable transfer or
/// unshield without the state it is locked in.
///
/// Refused before any work: a state under the restore embargo (`restored_recently:` — a state
/// made by [`new_state`] builds nothing until its confirmed height is 128 blocks above its
/// embargo base, see [`summary`]`.spend`); a state scanned without the nullifier key
/// (`view_only:`); a recipient with the wallet's own `pk` and another encryption key
/// (`recipient_mixed_address:`).
///
/// The state must be at `expected_revision` (`stale_state:`), must have a confirmed height and —
/// unless `allow_unverified` — its tree root must be the confirmed one (`state_unconfirmed:`:
/// call [`set_nodes`], scan to the tip, [`confirm_state`]). The expiry is measured from the
/// CONFIRMED height: default + 64, at most + 128. A locked input is refused (`note_locked:`), an
/// unconfirmed one too (`note_unverified:`) unless `allow_unverified`.
pub fn build_transfer(seed: &[u8], state_json: &str, params_json: &str, expected_revision: f64) -> ApiResult {
    let p: TransferJson = serde_json::from_str(params_json).map_err(|e| bad_json("transfer parameters", &e))?;
    let st = state_for_update(state_json, expected_revision)?;
    let k = keys(seed)?;
    let recipient = ShieldedAddress::decode(&p.recipient).map_err(err)?;
    let params = TransferParams { spend: p.spend.options(&st)?, recipient: &recipient, amount: amount(&p.amount, E_AMOUNT)?, fee: amount(&p.fee, E_FEE)? };
    locked(wallet::build_transfer(&st, st.revision(), &k, &params).map_err(err)?)
}

#[derive(Deserialize)]
struct UnshieldJson {
    #[serde(flatten)]
    spend: SpendJson,
    /// the `rouge1…` address that receives `v_out`
    to: String,
    v_out: String,
    fee: String,
}

/// Builds and proves an `unshield_v2` **and locks its inputs — one call**, exactly as
/// [`build_transfer`]: `{ state, revision, envelope_json, … }`; persist the returned state, then
/// submit.
pub fn build_unshield(seed: &[u8], state_json: &str, params_json: &str, expected_revision: f64) -> ApiResult {
    let p: UnshieldJson = serde_json::from_str(params_json).map_err(|e| bad_json("unshield parameters", &e))?;
    let st = state_for_update(state_json, expected_revision)?;
    let k = keys(seed)?;
    let params = UnshieldParams {
        spend: p.spend.options(&st)?,
        to_account: account_from_address(&p.to).map_err(err)?,
        v_out: amount(&p.v_out, E_V_OUT)?,
        fee: amount(&p.fee, E_FEE)?,
    };
    locked(wallet::build_unshield(&st, st.revision(), &k, &params).map_err(err)?)
}

// ---- pending transactions (REVIEW_WALLET_1 F-7, REVIEW_WALLET_2 RW2-1..3, REVIEW_WALLET_3 RW3-5) --

/// For a client that built a transaction and is CERTAIN it never handed it to any node (the user
/// cancelled before the submit). Sets `abandoned_hint` on the pending entry with this nullifier.
/// **It releases nothing**: the inputs stay locked until [`resolve_pending`] settles the entry as
/// expired at the confirmed height — at most 128 blocks above the confirmed height it was built
/// at. The core cannot check that nothing was submitted, and a wrong claim would be a double
/// payment; so even a wrong call here is safe. `{ state, revision, found }`.
pub fn abandon_unsubmitted(state_json: &str, nullifier_hex: &str, expected_revision: f64) -> ApiResult {
    let mut st = state_for_update(state_json, expected_revision)?;
    let found = st.abandon_unsubmitted(&hex32(nullifier_hex, "nullifier must be 64 lowercase hexadecimal characters")?);
    out_with_state(&st, json!({ "found": found }))
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
/// [`confirm_state`] matched a strict majority of the configured nodes): `{ state, revision, mined, superseded, expired,
/// still_pending }`.
///
/// * `mined` — a transaction at or below the confirmed height has both nullifiers and both output
///   commitments of the entry. Its inputs are spent, its change is a confirmed note (stored from
///   the wallet's own record, not from a ciphertext).
/// * `superseded` — a DIFFERENT transaction at or below the confirmed height spent one of its
///   inputs (the same phrase on another device, usually). It can never be mined: the payment did
///   not happen. The inputs whose own nullifier appeared are spent, the others are free.
/// * `expired` — the confirmed height is at or above its expiry height and none of its nullifiers
///   appeared. It can never be mined; the inputs are free and a retry is safe.
/// * everything else stays pending and LOCKED: seen in a listing nobody confirmed, a "rejected"
///   answer, a height one node claims.
///
/// Every entry built by this version settles in bounded time: its expiry is at most 128 blocks
/// above the confirmed height it was built at, so once the confirmed height has reached it the
/// entry is one of the three. There is no flag and no other call that releases a lock on one
/// node's word.
pub fn resolve_pending(state_json: &str, expected_revision: f64) -> ApiResult {
    let mut st = state_for_update(state_json, expected_revision)?;
    let r = st.resolve();
    out_with_state(&st, json!(r))
}

// ---- state confirmation (REVIEW_WALLET_1 F-1, REVIEW_WALLET_2 RW2-2/4, REVIEW_WALLET_3 RW3-1/2) ----

#[derive(Deserialize)]
struct StateReportJson {
    node_id: String,
    height: u64,
    tree_root: String,
    nullifier_acc: String,
    note_count: u64,
    nullifier_count: u64,
    ciphertext_acc: String,
}

/// Compares the wallet's own pool state — tree root, nullifier hash AND ciphertext hash, with
/// both counts — with what its CONFIGURED nodes report, and moves the confirmed height.
/// `reports_json`: `[{ "node_id", "height", "tree_root", "nullifier_acc", "note_count",
/// "nullifier_count", "ciphertext_acc" }, …]`, one entry per node: the `report` object of that
/// node's `/api/shield-v2/stats` plus **`node_id`, which the caller sets to the endpoint it
/// configured — never to anything the node returned**.
///
/// A height is confirmed iff a STRICT MAJORITY OF THE CONFIGURED SET ([`set_nodes`]) reports
/// exactly the wallet's values at that height. There is no quorum argument: the threshold is a
/// property of the state, and passing fewer reports can only make a confirmation harder.
///
/// * a report under an id that is not configured is not counted (`report.not_configured`);
/// * **an entry that is not a well-formed report is skipped and counted in `malformed`** — a node
///   that answers garbage costs its own vote and nothing else;
/// * **an entry that is a well-formed report EXCEPT that it has no `ciphertext_acc`** (absent or
///   `null`) is an OUTDATED NODE, not a dissenter and not garbage (REVIEW_WALLET_4 RW4-12): a
///   build before the node-local ciphertext hash, or a node that has not rebuilt it since. It
///   has no vote; its configured id is returned in `outdated_nodes` so that the user interface
///   can say "node X must be updated";
/// * a dissenting minority does NOT block: `report.dissenting` lists `{ node_id, height }` for
///   every configured node that contradicts the wallet ("node X disagrees");
/// * `report.listing_refuted`: more nodes contradict the wallet than a lying minority can be —
///   the wallet's own listing is wrong: [`rescan_state`]. `report.refuted` says where
///   (REVIEW_WALLET_6 RW6-1): an entry with `confirmed: false` puts the fault in the heights
///   `from_height ..= height`, above what was confirmed before — the node that served THOSE
///   heights lied (ban the listing node only if it is that node); an entry with
///   `confirmed: true` contradicts what an earlier quorum confirmed and implicates nobody.
/// * `report.listing_ahead`: the listing shows pool transactions in blocks above
///   `report.quorum_tip`, the height a quorum of the configured nodes has reached. Ask the nodes
///   again; if it stays so, the listing node invented those blocks: the same recovery.
///
/// `report.confirmed_lag` is `quorum_tip − confirmed_height` in blocks; `spend` says whether a
/// spend can be built now and why not ([`can_spend_now`]).
///
/// `{ state, revision, revision_id, report, malformed, outdated_nodes, spend }`.
pub fn confirm_state(state_json: &str, reports_json: &str, expected_revision: f64) -> ApiResult {
    let mut st = state_for_update(state_json, expected_revision)?;
    if reports_json.len() > 1 << 20 {
        return Err(bad("reports must be at most 1 MiB"));
    }
    let raw: Vec<Value> = serde_json::from_str(reports_json).map_err(|e| bad_json("state reports", &e))?;
    let mut reports = Vec::with_capacity(raw.len());
    let mut malformed = 0usize;
    let mut outdated = std::collections::BTreeSet::new();
    for entry in raw {
        // everything a report needs but the ciphertext hash: an outdated node
        let lacks_only_the_ciphertext_hash = entry.get("ciphertext_acc").is_none_or(Value::is_null) && {
            let mut filled = entry.clone();
            filled.as_object_mut().is_some_and(|o| {
                o.insert("ciphertext_acc".into(), json!("00".repeat(32)));
                true
            }) && serde_json::from_value::<StateReportJson>(filled).is_ok_and(|r| hex32(&r.tree_root, "").is_ok() && hex32(&r.nullifier_acc, "").is_ok())
        };
        if lacks_only_the_ciphertext_hash {
            let id = entry.get("node_id").and_then(Value::as_str).and_then(|id| wallet::canonical_node_id(id).ok()).filter(|id| st.nodes().contains(id));
            match id {
                Some(id) => {
                    outdated.insert(id);
                }
                None => malformed += 1,
            }
            continue;
        }
        let parsed = serde_json::from_value::<StateReportJson>(entry).ok().and_then(|r| {
            Some(StateReport {
                tree_root: hex32(&r.tree_root, "").ok()?,
                nullifier_acc: hex32(&r.nullifier_acc, "").ok()?,
                ciphertext_acc: hex32(&r.ciphertext_acc, "").ok()?,
                node_id: r.node_id,
                height: r.height,
                note_count: r.note_count,
                nullifier_count: r.nullifier_count,
            })
        });
        match parsed {
            Some(r) => reports.push(r),
            None => malformed += 1,
        }
    }
    let report = st.confirm_state(&reports).map_err(err)?;
    let spend = json!(st.spend_status(report.quorum_tip));
    out_with_state(&st, json!({ "report": report, "malformed": malformed, "outdated_nodes": outdated, "spend": spend }))
}

/// An empty state for the same wallet that keeps the pending transactions — every one of them as
/// pending and locked, whatever the old state had seen of it — and the configured nodes: what to
/// scan into from height 0 after a reorganisation, a `listing:` error or a state check with
/// `listing_refuted`. `min_note_value_quanta`: `""` keeps the state's value. `max_unspent_notes`:
/// `0` keeps the state's cap; **a higher cap recovers the notes counted in `over_capacity`**.
/// `{ state, revision }`.
pub fn rescan_state(state_json: &str, min_note_value_quanta: &str, max_unspent_notes: u32, expected_revision: f64) -> ApiResult {
    let st = state_for_update(state_json, expected_revision)?;
    let min = match min_note_value_quanta {
        "" => None,
        s => Some(amount(s, E_MIN_NOTE)?),
    };
    let cap = (max_unspent_notes != 0).then_some(max_unspent_notes as usize);
    let fresh = st.fresh_for_rescan_with(min, cap).map_err(err)?;
    out_with_state(&fresh, json!({}))
}
