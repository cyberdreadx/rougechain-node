//! R1 — strict `bridge_withdraw` execution (reference model + derived-data gates).
//!
//! `apply_bridge_withdraw` is a **REFERENCE MODEL / test oracle only.** Production
//! consensus money arithmetic remains in `core/daemon/src/node.rs`; R1 *instruments*
//! that existing inline arithmetic (setting an execution result at its existing
//! return/complete points) **without replacing its expressions**. This crate is never
//! called for consensus arithmetic — it exists to pin the expected result semantics,
//! to serve as a replay oracle, and to host the derived-data helpers (`payout_route`,
//! `is_payout_eligible`, `bridge_receipt_status`, `persist_bridge_withdraw_results`)
//! that gate receipts and the relayer-facing withdrawal store.
//!
//! State-preservation contract (of the daemon instrumentation this models):
//!   * balance / token-balance / burned-token mutations are byte-identical to the
//!     current daemon (the burn map is still keyed by the RAW trimmed symbol);
//!   * a failure performs NO mutation (matches today's silent `return;`);
//!   * `canonical_token` in the effect is normalized to `"XRGE"` for the STORE
//!     record + routing only — it never changes the (state-root-relevant)
//!     `burned_tokens` key.
//!
//! Two DISTINCT concepts (do not conflate):
//!   * **execution succeeded** — the L1 burn happened. R1 never changes this, so an
//!     unsupported/custom token can still have a `Success` result.
//!   * **recognized bridge payout asset** — the token maps to a real relayer payout
//!     route (XRGE/qETH/qUSDC/qBTC). Only this gates the relayer-facing store record.
//!     An unsupported token MUST NEVER silently become an ETH payout.

use std::collections::HashMap;
use sha3::{Digest, Keccak256};

/// The R1 bridge fee policy: every bridge withdrawal (qETH/qUSDC/qBTC/XRGE) pays exactly
/// this XRGE fee. A future dynamic bridge-fee design is separate work.
pub const BRIDGE_FEE_XRGE: f64 = 0.1;

/// Lowercase hex of a byte slice (no `0x`).
pub fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes { s.push_str(&format!("{:02x}", b)); }
    s
}

/// Ethereum keccak256 (NOT NIST SHA3-256) of arbitrary bytes — used for event topic
/// selectors (`keccak256("BridgeReleaseETH(address,uint256,bytes32)")`) and the canonical id.
pub fn keccak256(bytes: &[u8]) -> [u8; 32] {
    let mut h = Keccak256::new();
    h.update(bytes);
    let out = h.finalize();
    let mut id = [0u8; 32];
    id.copy_from_slice(&out);
    id
}

/// Canonical RougeBridge withdrawal id: `keccak256(UTF8(stored_withdrawal_tx_id))`. This is
/// the SINGLE source of the `bytes32 l1TxId` used everywhere — relayer release
/// (`releaseETH`/`releaseERC20`), event verification, `processedL1Txs` queries,
/// reconciliation, and the refund guard. `stored_tx_id` is the store record's `tx_id`
/// EXACTLY as persisted (e.g. `"xrge:<hex>"` for XRGE, the bare hex for qETH/qUSDC/qBTC).
/// Matches the relayer's existing `keccak256(toBytes(w.tx_id))`.
pub fn rouge_bridge_id(stored_tx_id: &str) -> [u8; 32] {
    let mut h = Keccak256::new();
    h.update(stored_tx_id.as_bytes());
    let out = h.finalize();
    let mut id = [0u8; 32];
    id.copy_from_slice(&out);
    id
}

/// 1 XRGE = 1e9 quanta (copied verbatim from `core/daemon/src/units.rs`; the
/// conformance test pins the shared constants against known values).
pub const QUANTA_PER_XRGE: u128 = 1_000_000_000;

/// `f64` XRGE → quanta, rounded half-up; non-finite / non-positive → 0.
/// Byte-identical to `units::fee_to_quanta` / `units::xrge_f64_to_quanta`.
#[inline]
pub fn fee_to_quanta(fee_xrge: f64) -> u128 {
    if !fee_xrge.is_finite() || fee_xrge <= 0.0 {
        return 0;
    }
    (fee_xrge * QUANTA_PER_XRGE as f64 + 0.5) as u128
}
#[inline]
pub fn xrge_f64_to_quanta(x: f64) -> u128 {
    fee_to_quanta(x)
}

pub type TokenBalanceKey = (String, String);

#[derive(Clone, Debug, PartialEq)]
pub struct BridgeWithdrawEffect {
    /// `"XRGE"` (canonical) or the raw token symbol — for the STORE record + routing.
    pub canonical_token: String,
    pub amount: u64,
    /// Payout destination: an EVM address (XRGE/qETH/qUSDC) **or a Bitcoin address
    /// (qBTC)** — never format-validated here. `None` → burned but not store-eligible
    /// (no payout target).
    pub destination: Option<String>,
    pub rougechain_tx_id: [u8; 32],
}

#[derive(Clone, Debug, PartialEq)]
pub enum BridgeWithdrawFailure {
    MissingToken,
    MissingAmount,
    ZeroAmount,
    InsufficientFee,
    InsufficientXrge,
    InsufficientToken, // also covers an unsupported/unknown token (balance 0)
}

#[derive(Clone, Debug, PartialEq)]
pub enum BridgeWithdrawExecution {
    Success(BridgeWithdrawEffect),
    Failed(BridgeWithdrawFailure),
}
use BridgeWithdrawExecution::*;
use BridgeWithdrawFailure::*;

/// The relayer payout route for a stored (canonical) token symbol. There is **no
/// default/catch-all EVM route**: an unknown token maps to `Unsupported`, never to
/// `Eth`. This is the fix for the cross-asset routing drain (a generic relayer that
/// ignored `token_symbol` and always released native ETH). Comparisons are
/// case-insensitive, consistent with the daemon's `is_xrge_withdrawal` /
/// `is_btc_withdrawal`.
///   XRGE → Xrge · qETH → Eth · qUSDC → Usdc · qBTC → Btc · anything else → Unsupported
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayoutRoute { Xrge, Eth, Usdc, Btc, Unsupported }
pub fn payout_route(canonical_token: &str) -> PayoutRoute {
    let t = canonical_token.trim();
    if t.eq_ignore_ascii_case("XRGE") { PayoutRoute::Xrge }
    else if t.eq_ignore_ascii_case("qETH") { PayoutRoute::Eth }
    else if t.eq_ignore_ascii_case("qUSDC") { PayoutRoute::Usdc }
    else if t.eq_ignore_ascii_case("qBTC") { PayoutRoute::Btc }
    else { PayoutRoute::Unsupported }
}

/// EXECUTION-level predicate: the burn succeeded AND a payout destination is present.
/// This is NOT sufficient to create a relayer-facing payout record — an unsupported
/// token can satisfy this (its consensus burn is untouched by R1). Use
/// [`is_payout_eligible`] for the relayer-facing store gate.
pub fn burned_with_destination(exec: &BridgeWithdrawExecution) -> bool {
    matches!(exec, Success(e) if e.destination.is_some())
}

/// RELAYER-FACING payout eligibility (R1 store gate): a successful burn, WITH a
/// destination, AND a **recognized** bridge payout asset (`payout_route != Unsupported`).
/// An unsupported/custom token whose burn succeeded is deliberately excluded so it can
/// never reach a relayer payout list and be mispaid as ETH. R1 does NOT impose an
/// EVM-address format check (qBTC carries a Bitcoin address); token-specific payout
/// endpoints do their own destination / on-chain verification.
pub fn is_payout_eligible(exec: &BridgeWithdrawExecution) -> bool {
    matches!(exec, Success(e)
        if e.destination.is_some()
        && payout_route(&e.canonical_token) != PayoutRoute::Unsupported)
}

/// Back-compat alias for the daemon store gate — same as [`is_payout_eligible`].
/// (The store record is the relayer-facing artifact, so store eligibility == payout
/// eligibility: recognized asset only.)
pub fn is_store_eligible(exec: &BridgeWithdrawExecution) -> bool {
    is_payout_eligible(exec)
}

/// Fail-closed receipt status for a `bridge_withdraw`: an ABSENT result is NOT
/// success. (The daemon maps this onto `TxStatus`.)
#[derive(Clone, Debug, PartialEq)]
pub enum BridgeReceipt { Success, Failed(String) }
pub fn bridge_receipt_status(exec: Option<&BridgeWithdrawExecution>) -> BridgeReceipt {
    match exec {
        Some(Success(_)) => BridgeReceipt::Success,
        Some(Failed(f)) => BridgeReceipt::Failed(format!("{:?}", f)),
        None => BridgeReceipt::Failed("missing bridge execution result".to_string()),
    }
}

/// A derived store record. Reference model for `persist_bridge_withdraw_results`,
/// which the daemon calls ONLY AFTER a block is accepted/persisted (never during
/// speculative apply, which may be rolled back on state-root failure).
#[derive(Clone, Debug, PartialEq)]
pub struct StoreRecord { pub tx_id: String, pub destination: String, pub amount: u64, pub owner: String, pub token: String }

/// Build the store records for an ACCEPTED block. Requires `results` aligned 1:1
/// with the block's transactions (indexed by position). Only `Success` with a
/// destination produces a record; `Failed` and `None` never do.
pub fn persist_bridge_withdraw_results(
    txs_len: usize,
    results: &[Option<BridgeWithdrawExecution>],
    senders: &[String],
) -> Result<Vec<StoreRecord>, String> {
    if results.len() != txs_len || senders.len() != txs_len {
        return Err("results/senders not aligned to txs".to_string());
    }
    let mut out = Vec::new();
    for (i, r) in results.iter().enumerate() {
        if let Some(exec) = r {
            if !is_store_eligible(exec) { continue; }
            if let Success(e) = exec {
                let dest = e.destination.clone().expect("eligible ⇒ Some");
                // Legacy "xrge:" tx_id prefix kept for XRGE continuity; qBTC/qETH
                // route by canonical token symbol (no prefix), as today.
                let prefix = if e.canonical_token.eq_ignore_ascii_case("XRGE") { "xrge:" } else { "" };
                let mut hexid = String::with_capacity(64);
                for b in e.rougechain_tx_id { hexid.push_str(&format!("{:02x}", b)); }
                out.push(StoreRecord {
                    tx_id: format!("{}{}", prefix, hexid),
                    destination: dest, amount: e.amount, owner: senders[i].clone(), token: e.canonical_token.clone(),
                });
            }
        }
    }
    Ok(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// R1C — signed-intent binding.
//
// The ML-DSA signature covers the payload {type, amount, fee, tokenSymbol,
// evmAddress, from, timestamp, nonce}. The executed withdrawal MUST equal the
// signed one: after `verify_signed_tx()` the daemon authorizes the withdrawal
// SOLELY from the verified payload, and any redundant top-level request field is
// accepted only if it EQUALS its signed counterpart (else rejected). Unsigned
// top-level values are never authoritative. This module is the pure, tested core
// of that authorization; the daemon handlers call the equivalent logic (see
// R1C_SIGNED_INTENT_BINDING.md).
// ─────────────────────────────────────────────────────────────────────────────

/// The HTTP endpoint doing the authorization — they route different asset sets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Endpoint { Generic, Xrge }

/// Security-relevant values pulled FROM THE VERIFIED SIGNED PAYLOAD.
#[derive(Clone, Debug, Default)]
pub struct SignedWithdrawIntent {
    pub op_type: String,               // payload.type — MUST be "bridge_withdraw"
    pub amount: Option<u64>,           // payload.amount
    pub destination: Option<String>,   // payload.evmAddress (EVM or BTC address)
    pub fee: Option<f64>,              // payload.fee
    pub token_symbol: Option<String>,  // payload.tokenSymbol
}

/// Redundant top-level request fields (legacy client compatibility). If present,
/// each MUST equal its signed counterpart; a top-level copy never overrides the
/// signed payload.
#[derive(Clone, Debug, Default)]
pub struct TopLevelCompat {
    pub amount: Option<u64>,
    pub destination: Option<String>,
    pub fee: Option<f64>,
}

/// The authorized withdrawal, derived entirely from signed intent + protocol
/// canonicalization. These are the ONLY values the daemon feeds to
/// `submit_bridge_withdraw_tx_signed`.
#[derive(Clone, Debug, PartialEq)]
pub struct AuthorizedWithdraw {
    pub amount: u64,
    pub destination: String,
    pub fee: f64,
    pub canonical_token: String,
    pub route: PayoutRoute,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BridgeAuthError {
    WrongOperation,        // payload.type != "bridge_withdraw"
    MissingSignedField,    // a required signed field (amount/destination/fee/token) absent
    UnsupportedAsset,      // signed token maps to PayoutRoute::Unsupported
    XrgeOnGenericEndpoint, // XRGE must use /api/bridge/xrge/withdraw
    NonXrgeOnXrgeEndpoint, // non-XRGE must use the generic endpoint
    ZeroAmount,            // signed amount == 0
    EmptyDestination,      // signed destination present but empty/blank
    InvalidFee,            // signed fee missing/non-finite/negative/zero OR != protocol 0.1 XRGE
    AmountMismatch,        // top-level amount != signed amount
    DestinationMismatch,   // top-level destination != signed destination
    FeeMismatch,           // top-level fee != signed fee
}

/// Canonical protocol spelling for a route (for the constructed TxV1 / store token).
pub fn canonical_symbol(route: PayoutRoute) -> Option<&'static str> {
    match route {
        PayoutRoute::Xrge => Some("XRGE"),
        PayoutRoute::Eth => Some("qETH"),
        PayoutRoute::Usdc => Some("qUSDC"),
        PayoutRoute::Btc => Some("qBTC"),
        PayoutRoute::Unsupported => None,
    }
}

/// Authorize a bridge withdrawal from verified signed intent. `verify_signed_tx()`
/// and the `payload.from == public_key` / signed-nonce checks are the daemon's
/// responsibility and must have ALREADY passed; this binds the withdrawal VALUES,
/// the asset, and the endpoint, and enforces the R1 bridge fee policy (signed fee
/// must consume exactly 0.1 XRGE). A COMPLETE signed intent is required — a missing
/// amount/destination/fee/token fails closed; nothing is invented post-verification.
/// Case variants of a supported token canonicalize deterministically (e.g. `qeth` →
/// `qETH`); an unsupported token is rejected. Token-specific destination FORMAT
/// validation (EVM for qETH/qUSDC/XRGE, Bitcoin for qBTC) remains in the daemon's
/// existing submission path — this only requires the destination be present & non-empty.
pub fn authorize_bridge_withdraw(
    endpoint: Endpoint,
    signed: &SignedWithdrawIntent,
    compat: &TopLevelCompat,
) -> Result<AuthorizedWithdraw, BridgeAuthError> {
    // 1. Operation binding — a `transfer` signature must never authorize a withdrawal.
    if signed.op_type != "bridge_withdraw" {
        return Err(BridgeAuthError::WrongOperation);
    }
    // 2. Asset + endpoint routing (from the SIGNED token only).
    let token = signed.token_symbol.as_deref().ok_or(BridgeAuthError::MissingSignedField)?;
    let route = payout_route(token);
    match (endpoint, route) {
        (Endpoint::Generic, PayoutRoute::Xrge) => return Err(BridgeAuthError::XrgeOnGenericEndpoint),
        (Endpoint::Generic, PayoutRoute::Unsupported) => return Err(BridgeAuthError::UnsupportedAsset),
        (Endpoint::Generic, _) => {}
        (Endpoint::Xrge, PayoutRoute::Xrge) => {}
        (Endpoint::Xrge, _) => return Err(BridgeAuthError::NonXrgeOnXrgeEndpoint),
    }
    let canonical_token = canonical_symbol(route).ok_or(BridgeAuthError::UnsupportedAsset)?.to_string();
    // 3. Required signed values — a COMPLETE signed intent is mandatory; NOTHING
    //    security-relevant may be invented after signature verification.
    let amount = signed.amount.ok_or(BridgeAuthError::MissingSignedField)?;
    let destination = signed.destination.clone().ok_or(BridgeAuthError::MissingSignedField)?;
    let fee = signed.fee.ok_or(BridgeAuthError::MissingSignedField)?; // fee is required for EVERY asset
    // 4. Value validation (fail BEFORE submission).
    if amount == 0 { return Err(BridgeAuthError::ZeroAmount); }
    if destination.trim().is_empty() { return Err(BridgeAuthError::EmptyDestination); }
    // 5. Fee policy: the SIGNED fee must consume EXACTLY 0.1 XRGE. fee_to_quanta returns 0 for
    //    non-finite/negative/zero fees, so this one comparison also rejects those.
    if fee_to_quanta(fee) != fee_to_quanta(BRIDGE_FEE_XRGE) { return Err(BridgeAuthError::InvalidFee); }
    // 6. Compatibility fields: if present, MUST equal the signed value (never override).
    if let Some(a) = compat.amount { if a != amount { return Err(BridgeAuthError::AmountMismatch); } }
    if let Some(d) = &compat.destination { if d != &destination { return Err(BridgeAuthError::DestinationMismatch); } }
    // Fee compared in the consumed quanta domain to avoid f64 representation noise.
    if let Some(f) = compat.fee { if fee_to_quanta(f) != fee_to_quanta(fee) { return Err(BridgeAuthError::FeeMismatch); } }
    Ok(AuthorizedWithdraw { amount, destination, fee, canonical_token, route })
}

// ─────────────────────────────────────────────────────────────────────────────
// R1E — RougeBridge timelock lifecycle reconciliation.
//
// A large withdrawal makes releaseETH/releaseERC20 succeed by QUEUEing a timelock
// instead of paying. The queued event carries only `(requestId, executeAfter)` —
// NOT the l1TxId — so a queued withdrawal is identified by reading the public
// `timelockQueue(requestId)` getter and binding its full record to the expected
// withdrawal. `processedL1Txs[id] == true` means "RougeBridge accepted this id
// once", NEVER "paid". These pure helpers classify that on-chain truth and gate
// refunds fail-closed. (Contract: RougeBridge.sol — TimelockRequest{token,to,
// amount,l1TxId,executeAfter,executed,cancelled}; executeTimelock rejects
// executed||cancelled; cancelTimelock sets cancelled=true.)
// ─────────────────────────────────────────────────────────────────────────────

/// The on-chain `timelockQueue(requestId)` record (public array getter tuple).
#[derive(Clone, Debug, PartialEq)]
pub struct TimelockRecord {
    pub token: String,       // address(0) for ETH; the ERC20 token address otherwise (0x…, any case)
    pub to: String,          // recipient (0x…, any case)
    pub amount: u128,        // wei (ETH) or ERC20 base units
    pub l1_tx_id: [u8; 32],
    pub execute_after: u64,
    pub executed: bool,
    pub cancelled: bool,
}

/// What the queue record MUST contain for a specific withdrawal.
#[derive(Clone, Debug, PartialEq)]
pub struct ExpectedTimelock {
    pub token: String,       // address(0) for qETH; the configured Base USDC for qUSDC
    pub to: String,          // withdrawal recipient
    pub amount: u128,        // owed wei (qETH) or amount_units (qUSDC)
    pub l1_tx_id: [u8; 32],  // rouge_bridge_id(stored_tx_id)
    pub execute_after: u64,  // from the TimelockQueued event
}

/// True iff the on-chain queue record binds to the expected withdrawal (addresses
/// compared case-insensitively; everything else exact). Does NOT look at
/// executed/cancelled — those select the class, not the binding.
pub fn timelock_record_matches(rec: &TimelockRecord, exp: &ExpectedTimelock) -> bool {
    rec.token.eq_ignore_ascii_case(&exp.token)
        && rec.to.eq_ignore_ascii_case(&exp.to)
        && rec.amount == exp.amount
        && rec.l1_tx_id == exp.l1_tx_id
        && rec.execute_after == exp.execute_after
}

/// Classification of a canonical id for which `processedL1Txs == true`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProcessedClass { Paid, Queued, CancelledRefundCandidate, Ambiguous }

/// On-chain facts gathered for a processed canonical id.
pub struct OnChainFacts<'a> {
    /// A matching BridgeReleaseETH/BridgeReleaseERC20 has been VERIFIED (§6/§7).
    pub verified_release: bool,
    /// The `timelockQueue(requestId)` record for the requestId bound to this id, if any.
    pub queue: Option<&'a TimelockRecord>,
    pub expected: &'a ExpectedTimelock,
}

/// Reconcile a processed id into exactly one class. Fail-closed: anything that isn't a
/// verified release or a uniquely-bound active/cancelled queue entry is `Ambiguous`.
pub fn classify_processed(f: &OnChainFacts) -> ProcessedClass {
    if f.verified_release { return ProcessedClass::Paid; }
    match f.queue {
        Some(rec) if timelock_record_matches(rec, f.expected) => {
            if rec.executed {
                // executed but no verified release event ⇒ can't prove payout ⇒ fail closed
                ProcessedClass::Ambiguous
            } else if rec.cancelled {
                ProcessedClass::CancelledRefundCandidate
            } else {
                ProcessedClass::Queued
            }
        }
        _ => ProcessedClass::Ambiguous,
    }
}

/// The refund gate for qETH/qUSDC. `processed` is `RougeBridge.processedL1Txs(id)`; the
/// daemon must treat an RPC/query FAILURE as "cannot prove false" and NOT call this with
/// `processed=false` — on query failure it refuses outright (fail closed).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefundDecision {
    NormalAnalysis,                    // processed == false: no release accepted; may analyze
    Forbidden,                         // Paid / Queued / Ambiguous / unknown
    MayProceedAfterCancellationProof,  // CancelledRefundCandidate (still not automatic in R1)
}
pub fn refund_decision(processed: bool, class: Option<ProcessedClass>) -> RefundDecision {
    if !processed { return RefundDecision::NormalAnalysis; }
    match class {
        Some(ProcessedClass::CancelledRefundCandidate) => RefundDecision::MayProceedAfterCancellationProof,
        _ => RefundDecision::Forbidden, // Paid, Queued, Ambiguous, or unknown → forbidden
    }
}

/// REFERENCE MODEL / test oracle — **not** the production arithmetic path. Per R1
/// correction #4, the daemon keeps its existing inline `bridge_withdraw` arithmetic
/// and only *instruments* it to set a result; it does NOT call this function, so
/// consensus money arithmetic is never duplicated in a second maintained impl.
/// This mirrors the daemon arm byte-for-byte to pin expected result semantics and
/// to serve as a replay oracle. `from_addr` is the already-`canon_addr`'d sender;
/// failure mutates nothing.
pub fn apply_bridge_withdraw(
    balances: &mut HashMap<String, u128>,
    token_balances: &mut HashMap<TokenBalanceKey, u128>,
    burned_tokens: &mut HashMap<String, f64>,
    from_addr: &str,
    fee: f64,
    token_symbol: Option<&str>,
    amount: Option<u64>,
    evm_address: Option<&str>,
    rougechain_tx_id: [u8; 32],
) -> BridgeWithdrawExecution {
    let token_symbol = match token_symbol {
        Some(s) => s,
        None => return Failed(MissingToken),
    };
    let amount = match amount {
        Some(a) => a,
        None => return Failed(MissingAmount),
    };
    if amount == 0 {
        return Failed(ZeroAmount);
    }
    // token_balances is keyed by the EXACT symbol; XRGE is matched case-insensitively.
    let token_sym = token_symbol.trim().to_string();
    let xrge_bal = *balances.get(from_addr).unwrap_or(&0);
    if xrge_bal < xrge_f64_to_quanta(fee) {
        return Failed(InsufficientFee);
    }
    let destination = evm_address.map(|s| s.to_string());

    if token_sym.eq_ignore_ascii_case("XRGE") {
        if xrge_bal.saturating_sub(fee_to_quanta(fee)) < xrge_f64_to_quanta(amount as f64) {
            return Failed(InsufficientXrge);
        }
        *balances.entry(from_addr.to_string()).or_insert(0) -= xrge_f64_to_quanta(fee + amount as f64);
        *burned_tokens.entry(token_sym).or_insert(0.0) += amount as f64; // RAW key (state-preserving)
        Success(BridgeWithdrawEffect {
            canonical_token: "XRGE".to_string(), // canonical for store/routing only
            amount,
            destination,
            rougechain_tx_id,
        })
    } else {
        let sender_key = (from_addr.to_string(), token_sym.clone());
        let token_bal = *token_balances.get(&sender_key).unwrap_or(&0);
        if token_bal < amount as u128 {
            return Failed(InsufficientToken);
        }
        *balances.entry(from_addr.to_string()).or_insert(0) -= xrge_f64_to_quanta(fee);
        *token_balances.entry(sender_key).or_insert(0) -= amount as u128;
        *burned_tokens.entry(token_sym.clone()).or_insert(0.0) += amount as f64;
        Success(BridgeWithdrawEffect { canonical_token: token_sym, amount, destination, rougechain_tx_id })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const A11: &str = "0x0000000000000000000000000000000000000A11";
    fn addr() -> String { "rouge1sender".to_string() }
    fn maps(xrge: u128) -> (HashMap<String, u128>, HashMap<TokenBalanceKey, u128>, HashMap<String, f64>) {
        let mut b = HashMap::new(); b.insert(addr(), xrge);
        (b, HashMap::new(), HashMap::new())
    }
    fn tid(n: u8) -> [u8; 32] { let mut r = [0u8; 32]; r[0] = n; r }

    #[test]
    fn units_conformance() {
        assert_eq!(QUANTA_PER_XRGE, 1_000_000_000);
        assert_eq!(fee_to_quanta(0.001), 1_000_000);
        assert_eq!(xrge_f64_to_quanta(100.0), 100_000_000_000);
        assert_eq!(fee_to_quanta(0.0), 0);
        assert_eq!(fee_to_quanta(-1.0), 0);
        assert_eq!(fee_to_quanta(f64::NAN), 0);
    }

    #[test]
    fn ordinary_user_double_withdraw() {
        // balance = exactly one withdrawal of 100 XRGE + 0.001 fee
        let (mut b, mut t, mut burn) = maps(xrge_f64_to_quanta(100.001));
        let r1 = apply_bridge_withdraw(&mut b, &mut t, &mut burn, &addr(), 0.001, Some("XRGE"), Some(100), Some(A11), tid(1));
        let r2 = apply_bridge_withdraw(&mut b, &mut t, &mut burn, &addr(), 0.001, Some("XRGE"), Some(100), Some(A11), tid(2));
        assert!(matches!(r1, Success(_)), "first must succeed");
        assert_eq!(r2, Failed(InsufficientFee), "second must fail (balance drained)");
        assert_eq!(*burn.get("XRGE").unwrap(), 100.0, "exactly B burned");
        assert_eq!(*b.get(&addr()).unwrap(), 0, "balance fully debited once");
        // exactly one store record; Base-payable = exactly B
        let eligible = [&r1, &r2].iter().filter(|r| is_store_eligible(r)).count();
        assert_eq!(eligible, 1, "exactly one store-eligible withdrawal");
    }

    #[test]
    fn insolvent_single_withdrawal() {
        let (mut b, mut t, mut burn) = maps(xrge_f64_to_quanta(50.001));
        let r = apply_bridge_withdraw(&mut b, &mut t, &mut burn, &addr(), 0.001, Some("XRGE"), Some(100), Some(A11), tid(1));
        assert_eq!(r, Failed(InsufficientXrge));
        assert!(burn.is_empty(), "no burn");
        assert_eq!(*b.get(&addr()).unwrap(), xrge_f64_to_quanta(50.001), "no debit");
        assert!(!is_store_eligible(&r), "no store entry");
    }

    #[test]
    fn missing_and_malformed_fields() {
        let (mut b, mut t, mut burn) = maps(xrge_f64_to_quanta(1000.0));
        assert_eq!(apply_bridge_withdraw(&mut b, &mut t, &mut burn, &addr(), 0.001, None, Some(1), Some(A11), tid(1)), Failed(MissingToken));
        assert_eq!(apply_bridge_withdraw(&mut b, &mut t, &mut burn, &addr(), 0.001, Some("XRGE"), None, Some(A11), tid(2)), Failed(MissingAmount));
        assert_eq!(apply_bridge_withdraw(&mut b, &mut t, &mut burn, &addr(), 0.001, Some("XRGE"), Some(0), Some(A11), tid(3)), Failed(ZeroAmount));
        assert!(burn.is_empty(), "failed field-validation → no burn");
        // missing destination: burn happens (ledger preserved) but NOT store-eligible
        let rmd = apply_bridge_withdraw(&mut b, &mut t, &mut burn, &addr(), 0.001, Some("XRGE"), Some(10), None, tid(4));
        assert!(matches!(rmd, Success(_)));
        assert!(!is_store_eligible(&rmd), "missing dest → not payable");
        // R1 does NOT format-validate the destination (qBTC uses a BTC address here);
        // a present destination is eligible — the payout endpoint validates it.
        let rpresent = apply_bridge_withdraw(&mut b, &mut t, &mut burn, &addr(), 0.001, Some("XRGE"), Some(10), Some("0xanything"), tid(5));
        assert!(is_store_eligible(&rpresent), "present dest → eligible (endpoint validates)");
    }

    #[test]
    fn payout_route_mapping_no_default_eth() {
        // XRGE/qETH/qUSDC/qBTC are recognized; 3EYE and unknown are Unsupported —
        // NEVER a silent ETH route. Case-insensitive on the protocol assets.
        assert_eq!(payout_route("XRGE"), PayoutRoute::Xrge);
        assert_eq!(payout_route("xrge"), PayoutRoute::Xrge);
        assert_eq!(payout_route("qETH"), PayoutRoute::Eth);
        assert_eq!(payout_route("QeTh"), PayoutRoute::Eth);
        assert_eq!(payout_route("qUSDC"), PayoutRoute::Usdc);
        assert_eq!(payout_route("qusdc"), PayoutRoute::Usdc);
        assert_eq!(payout_route("qBTC"), PayoutRoute::Btc);
        assert_eq!(payout_route("3EYE"), PayoutRoute::Unsupported);
        assert_eq!(payout_route("qDAI"), PayoutRoute::Unsupported);
        assert_eq!(payout_route(""), PayoutRoute::Unsupported);
    }

    #[test]
    fn routing_preserved_xrge_qeth_qusdc_qbtc() {
        let (mut b, mut t, mut burn) = maps(xrge_f64_to_quanta(1000.0));
        t.insert((addr(), "qETH".to_string()), 100);
        t.insert((addr(), "qUSDC".to_string()), 100);
        t.insert((addr(), "qBTC".to_string()), 100);
        // XRGE → Xrge list
        let rx = apply_bridge_withdraw(&mut b, &mut t, &mut burn, &addr(), 0.001, Some("xrge"), Some(1), Some("0x00000000000000000000000000000000000000A1"), tid(1));
        assert!(is_payout_eligible(&rx));
        if let Success(e) = &rx { assert_eq!(e.canonical_token, "XRGE"); assert_eq!(payout_route(&e.canonical_token), PayoutRoute::Xrge); }
        // qETH → Eth list
        let re = apply_bridge_withdraw(&mut b, &mut t, &mut burn, &addr(), 0.001, Some("qETH"), Some(1), Some("0x00000000000000000000000000000000000000E7"), tid(2));
        assert!(is_payout_eligible(&re));
        if let Success(e) = &re { assert_eq!(payout_route(&e.canonical_token), PayoutRoute::Eth); }
        // qUSDC → Usdc list (must NOT be paid as ETH)
        let ru = apply_bridge_withdraw(&mut b, &mut t, &mut burn, &addr(), 0.001, Some("qUSDC"), Some(1), Some("0x00000000000000000000000000000000000000DC"), tid(3));
        assert!(is_payout_eligible(&ru));
        if let Success(e) = &ru { assert_eq!(payout_route(&e.canonical_token), PayoutRoute::Usdc); }
        // qBTC → BTC list, with a Bitcoin address in the destination (NOT EVM-format)
        let rbt = apply_bridge_withdraw(&mut b, &mut t, &mut burn, &addr(), 0.001, Some("qBTC"), Some(1), Some("bc1qexampledestaddr0000000000000000000000"), tid(4));
        assert!(is_payout_eligible(&rbt), "qBTC success with a BTC address is eligible");
        if let Success(e) = &rbt { assert_eq!(payout_route(&e.canonical_token), PayoutRoute::Btc); }
        // a failed burn is never eligible / never routed
        let rfail = apply_bridge_withdraw(&mut b, &mut t, &mut burn, &addr(), 0.001, Some("qBTC"), Some(9_999_999), Some("bc1qx"), tid(5));
        assert_eq!(rfail, Failed(InsufficientToken));
        assert!(!is_payout_eligible(&rfail));
    }

    #[test]
    fn unsupported_token_success_creates_no_relayer_record() {
        // A CUSTOM token (3EYE) burn can SUCCEED at the ledger (execution untouched),
        // but it must NEVER produce a relayer-facing payout record — otherwise it would
        // be mispaid as ETH on the generic list.
        let (mut b, mut t, mut burn) = maps(xrge_f64_to_quanta(1000.0));
        t.insert((addr(), "3EYE".to_string()), 500);
        let r = apply_bridge_withdraw(&mut b, &mut t, &mut burn, &addr(), 0.001, Some("3EYE"), Some(500), Some("0x00000000000000000000000000000000000003EE"), tid(1));
        // execution succeeded (burn happened) ...
        assert!(matches!(r, Success(_)), "custom-token burn still succeeds at the ledger");
        assert!(burned_with_destination(&r), "burned + has a destination");
        assert_eq!(*t.get(&(addr(), "3EYE".to_string())).unwrap(), 0, "3EYE debited");
        // ... but it is NOT a recognized payout asset ⇒ no relayer-facing record.
        assert!(!is_payout_eligible(&r), "unsupported token → not payout-eligible");
        let recs = persist_bridge_withdraw_results(1, &[Some(r)], &[addr()]).unwrap();
        assert!(recs.is_empty(), "unsupported successful burn → zero relayer records");
    }

    #[test]
    fn receipt_and_store_fail_closed_on_missing_result() {
        // absent result for a bridge_withdraw must NOT default to success
        assert_eq!(bridge_receipt_status(None), BridgeReceipt::Failed("missing bridge execution result".to_string()));
        assert_eq!(bridge_receipt_status(Some(&Failed(InsufficientFee))), BridgeReceipt::Failed("InsufficientFee".to_string()));
        let ok = Success(BridgeWithdrawEffect { canonical_token: "XRGE".into(), amount: 1, destination: Some("0x00000000000000000000000000000000000000A1".into()), rougechain_tx_id: [1u8;32] });
        assert_eq!(bridge_receipt_status(Some(&ok)), BridgeReceipt::Success);
    }

    #[test]
    fn persist_is_index_aligned_and_success_only() {
        // tx[0] = skipped/None (e.g., an earlier pre-apply `continue`); tx[1] = success
        let e = BridgeWithdrawEffect { canonical_token: "XRGE".into(), amount: 100, destination: Some("0x00000000000000000000000000000000000000A1".into()), rougechain_tx_id: [7u8;32] };
        let results = vec![None, Some(Success(e.clone())), Some(Failed(InsufficientFee))];
        let senders = vec!["s0".to_string(), "s1".to_string(), "s2".to_string()];
        let recs = persist_bridge_withdraw_results(3, &results, &senders).unwrap();
        assert_eq!(recs.len(), 1, "only the successful withdrawal is stored");
        assert_eq!(recs[0].owner, "s1", "record belongs to tx[1] (index-aligned)");
        assert_eq!(recs[0].token, "XRGE");
        assert!(recs[0].tx_id.starts_with("xrge:"));
        // misaligned results are rejected (fail-closed)
        assert!(persist_bridge_withdraw_results(3, &results[..2], &senders).is_err());
    }

    #[test]
    #[allow(non_snake_case)]
    fn casing_all_canonicalize_to_xrge() {
        for sym in ["XRGE", "xrge", "XrGe", " xrge "] {
            let (mut b, mut t, mut burn) = maps(xrge_f64_to_quanta(1000.0));
            let r = apply_bridge_withdraw(&mut b, &mut t, &mut burn, &addr(), 0.001, Some(sym), Some(5), Some(A11), tid(1));
            match r {
                Success(e) => {
                    assert_eq!(e.canonical_token, "XRGE", "sym {sym:?} → canonical XRGE store token");
                    assert!(is_store_eligible(&Success(e)));
                }
                _ => panic!("sym {sym:?} should succeed as native XRGE"),
            }
            // ledger: burns native XRGE (balance debited); raw-key burn preserved
            assert!(b.get(&addr()).copied().unwrap() < xrge_f64_to_quanta(1000.0), "native XRGE debited for {sym:?}");
        }
    }

    // ── R1C: signed-intent binding ──────────────────────────────────────────
    fn signed(op: &str, amount: Option<u64>, dest: Option<&str>, fee: Option<f64>, token: Option<&str>) -> SignedWithdrawIntent {
        SignedWithdrawIntent {
            op_type: op.to_string(), amount,
            destination: dest.map(|s| s.to_string()), fee,
            token_symbol: token.map(|s| s.to_string()),
        }
    }

    #[test]
    fn r1c_exact_binding_passes_and_tamper_rejected() {
        let s = signed("bridge_withdraw", Some(10), Some("0xAAA"), Some(0.1), Some("qETH"));
        // matching top-level fields → PASS
        let ok = authorize_bridge_withdraw(Endpoint::Generic, &s,
            &TopLevelCompat { amount: Some(10), destination: Some("0xAAA".into()), fee: Some(0.1) }).unwrap();
        assert_eq!(ok.amount, 10); assert_eq!(ok.destination, "0xAAA");
        assert_eq!(ok.fee, 0.1); assert_eq!(ok.canonical_token, "qETH"); assert_eq!(ok.route, PayoutRoute::Eth);
        // tamper each top-level field individually → REJECT
        assert_eq!(authorize_bridge_withdraw(Endpoint::Generic, &s,
            &TopLevelCompat { amount: Some(11), ..Default::default() }), Err(BridgeAuthError::AmountMismatch));
        assert_eq!(authorize_bridge_withdraw(Endpoint::Generic, &s,
            &TopLevelCompat { destination: Some("0xBBB".into()), ..Default::default() }), Err(BridgeAuthError::DestinationMismatch));
        assert_eq!(authorize_bridge_withdraw(Endpoint::Generic, &s,
            &TopLevelCompat { fee: Some(0.2), ..Default::default() }), Err(BridgeAuthError::FeeMismatch));
        // absent top-level fields are fine — signed values are authoritative
        assert!(authorize_bridge_withdraw(Endpoint::Generic, &s, &TopLevelCompat::default()).is_ok());
    }

    #[test]
    fn r1c_wrong_operation_signature_rejected() {
        // a valid signature over type=transfer must not authorize a withdrawal
        let s = signed("transfer", Some(10), Some("0xAAA"), Some(0.1), Some("qETH"));
        assert_eq!(authorize_bridge_withdraw(Endpoint::Generic, &s, &TopLevelCompat::default()),
            Err(BridgeAuthError::WrongOperation));
    }

    #[test]
    fn r1c_unsupported_and_cross_endpoint_rejected() {
        // unsupported token on generic
        let bad = signed("bridge_withdraw", Some(1), Some("0xAAA"), Some(0.1), Some("3EYE"));
        assert_eq!(authorize_bridge_withdraw(Endpoint::Generic, &bad, &TopLevelCompat::default()),
            Err(BridgeAuthError::UnsupportedAsset));
        // XRGE rejected by the generic endpoint
        let xrge = signed("bridge_withdraw", Some(1), Some("0xAAA"), Some(0.1), Some("XRGE"));
        assert_eq!(authorize_bridge_withdraw(Endpoint::Generic, &xrge, &TopLevelCompat::default()),
            Err(BridgeAuthError::XrgeOnGenericEndpoint));
        // qETH rejected by the XRGE endpoint
        let qeth = signed("bridge_withdraw", Some(1), Some("0xAAA"), Some(0.1), Some("qETH"));
        assert_eq!(authorize_bridge_withdraw(Endpoint::Xrge, &qeth, &TopLevelCompat::default()),
            Err(BridgeAuthError::NonXrgeOnXrgeEndpoint));
        // XRGE accepted by the XRGE endpoint
        assert!(authorize_bridge_withdraw(Endpoint::Xrge, &xrge, &TopLevelCompat::default()).is_ok());
    }

    #[test]
    fn r1c_case_variant_canonicalizes_deterministically() {
        // We support deterministic canonicalization (chosen behavior): qeth → qETH.
        for (sym, canon, route) in [("qeth","qETH",PayoutRoute::Eth), ("QUSDC","qUSDC",PayoutRoute::Usdc),
                                    ("qBtc","qBTC",PayoutRoute::Btc)] {
            let s = signed("bridge_withdraw", Some(5), Some("dest"), Some(0.1), Some(sym));
            let a = authorize_bridge_withdraw(Endpoint::Generic, &s, &TopLevelCompat::default()).unwrap();
            assert_eq!(a.canonical_token, canon, "sym {sym:?} canonicalizes to {canon}");
            assert_eq!(a.route, route);
        }
    }

    #[test]
    fn r1c_authorized_values_drive_constructed_tx() {
        // The AuthorizedWithdraw fed to submit_* must contain exactly the signed values
        // + canonical asset. Model the downstream TxV1 construction via apply_bridge_withdraw.
        let s = signed("bridge_withdraw", Some(100), Some("0xDEST"), Some(0.1), Some("qusdc"));
        let a = authorize_bridge_withdraw(Endpoint::Generic, &s,
            &TopLevelCompat { amount: Some(100), destination: Some("0xDEST".into()), fee: Some(0.1) }).unwrap();
        assert_eq!(a.amount, 100);
        assert_eq!(a.destination, "0xDEST");
        assert_eq!(a.fee, 0.1);
        assert_eq!(a.canonical_token, "qUSDC");
        // downstream construction uses ONLY authorized values
        let (mut b, mut t, mut burn) = maps(xrge_f64_to_quanta(10.0));
        t.insert((addr(), "qUSDC".to_string()), 100);
        let exec = apply_bridge_withdraw(&mut b, &mut t, &mut burn, &addr(),
            a.fee, Some(&a.canonical_token), Some(a.amount), Some(&a.destination), tid(1));
        match exec {
            Success(e) => {
                assert_eq!(e.canonical_token, "qUSDC");
                assert_eq!(e.amount, 100);
                assert_eq!(e.destination.as_deref(), Some("0xDEST"));
                assert_eq!(payout_route(&e.canonical_token), PayoutRoute::Usdc);
            }
            _ => panic!("authorized withdrawal should burn qUSDC"),
        }
    }

    #[test]
    fn r1d_fee_policy_and_value_validation() {
        // signed fee MUST consume exactly 0.1 XRGE for every asset.
        let mk = |amount, dest, fee, tok| SignedWithdrawIntent {
            op_type: "bridge_withdraw".into(), amount, destination: dest, fee, token_symbol: tok };
        // missing fee → reject
        assert_eq!(authorize_bridge_withdraw(Endpoint::Generic,
            &mk(Some(1), Some("0xA".into()), None, Some("qETH".into())), &TopLevelCompat::default()),
            Err(BridgeAuthError::MissingSignedField));
        // fee != 0.1 → InvalidFee
        for bad in [0.2f64, 0.05, 1.0] {
            assert_eq!(authorize_bridge_withdraw(Endpoint::Generic,
                &mk(Some(1), Some("0xA".into()), Some(bad), Some("qETH".into())), &TopLevelCompat::default()),
                Err(BridgeAuthError::InvalidFee), "fee {bad} must be rejected");
        }
        // negative / zero / non-finite fee → InvalidFee
        for bad in [-0.1f64, 0.0, f64::NAN, f64::INFINITY] {
            assert_eq!(authorize_bridge_withdraw(Endpoint::Generic,
                &mk(Some(1), Some("0xA".into()), Some(bad), Some("qETH".into())), &TopLevelCompat::default()),
                Err(BridgeAuthError::InvalidFee), "fee {bad} must be rejected");
        }
        // zero amount → ZeroAmount
        assert_eq!(authorize_bridge_withdraw(Endpoint::Generic,
            &mk(Some(0), Some("0xA".into()), Some(0.1), Some("qETH".into())), &TopLevelCompat::default()),
            Err(BridgeAuthError::ZeroAmount));
        // empty / blank destination → EmptyDestination
        for d in ["", "   "] {
            assert_eq!(authorize_bridge_withdraw(Endpoint::Generic,
                &mk(Some(1), Some(d.into()), Some(0.1), Some("qETH".into())), &TopLevelCompat::default()),
                Err(BridgeAuthError::EmptyDestination));
        }
        // exactly-0.1 fee passes for every supported asset
        for tok in ["qETH", "qUSDC", "qBTC"] {
            assert!(authorize_bridge_withdraw(Endpoint::Generic,
                &mk(Some(1), Some("dest".into()), Some(0.1), Some(tok.into())), &TopLevelCompat::default()).is_ok(),
                "{tok} with fee 0.1 must pass");
        }
        assert!(authorize_bridge_withdraw(Endpoint::Xrge,
            &mk(Some(1), Some("0xA".into()), Some(0.1), Some("XRGE".into())), &TopLevelCompat::default()).is_ok());
    }

    #[test]
    fn r1d_canonical_rouge_bridge_id_frozen_vector() {
        // keccak256(UTF8(stored_tx_id)). CROSS-LANGUAGE frozen vectors — the SAME values are
        // pinned in the relayer TypeScript test (see R1E_TIMELOCK_LIFECYCLE.md / the TS vector).
        // (1) empty input — the well-known Ethereum keccak256("") digest (proves this is
        //     Ethereum keccak, not NIST SHA3).
        assert_eq!(bytes_to_hex(&rouge_bridge_id("")),
            "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
        // (2) a representative NON-EMPTY stored withdrawal id (bare 64-hex string, UTF-8).
        //     viem `keccak256(toBytes("00..ff"))` / ethers `keccak256(toUtf8Bytes("00..ff"))`
        //     MUST reproduce this exact bytes32.
        let bare = "00000000000000000000000000000000000000000000000000000000000000ff";
        assert_eq!(bytes_to_hex(&rouge_bridge_id(bare)),
            "337ed4d89269c740d540763c75cbe3c32781be676d35104745fa5b46fa5f377f");
        // (3) prefixed-vs-unprefixed differentiation: an XRGE store id ("xrge:" + hex) hashes
        //     differently — the prefix is part of the signed/stored preimage.
        let xrge = format!("xrge:{}", bare);
        assert_ne!(rouge_bridge_id(bare), rouge_bridge_id(&xrge));
        assert_eq!(rouge_bridge_id(bare), rouge_bridge_id(bare)); // determinism
    }

    // ── R1E: timelock lifecycle reconciliation ──────────────────────────────
    fn qeth_exp() -> ExpectedTimelock {
        ExpectedTimelock { token: "0x0000000000000000000000000000000000000000".into(),
            to: "0xrecipient".into(), amount: 5_000_000_000_000u128, l1_tx_id: [9u8;32], execute_after: 1000 }
    }
    fn qeth_rec() -> TimelockRecord {
        TimelockRecord { token: "0x0000000000000000000000000000000000000000".into(),
            to: "0xRECIPIENT".into(), amount: 5_000_000_000_000u128, l1_tx_id: [9u8;32],
            execute_after: 1000, executed: false, cancelled: false }
    }

    #[test]
    fn r1e_queue_binding_matches_and_mismatches_fail_closed() {
        let exp = qeth_exp();
        assert!(timelock_record_matches(&qeth_rec(), &exp), "case-insensitive addr match");
        // wrong l1TxId / recipient / token / amount → not a match → Ambiguous downstream
        let mut r = qeth_rec(); r.l1_tx_id = [1u8;32];
        assert!(!timelock_record_matches(&r, &exp));
        let mut r = qeth_rec(); r.to = "0xother".into();
        assert!(!timelock_record_matches(&r, &exp));
        let mut r = qeth_rec(); r.token = "0x0000000000000000000000000000000000000dead".into();
        assert!(!timelock_record_matches(&r, &exp));
        let mut r = qeth_rec(); r.amount = 1;
        assert!(!timelock_record_matches(&r, &exp));
        let mut r = qeth_rec(); r.execute_after = 999;
        assert!(!timelock_record_matches(&r, &exp));
    }

    #[test]
    fn r1e_classify_processed_states() {
        let exp = qeth_exp();
        // Paid: a verified release event exists
        assert_eq!(classify_processed(&OnChainFacts { verified_release: true, queue: None, expected: &exp }),
            ProcessedClass::Paid);
        // Queued: matching queue, executed=false, cancelled=false
        let active = qeth_rec();
        assert_eq!(classify_processed(&OnChainFacts { verified_release: false, queue: Some(&active), expected: &exp }),
            ProcessedClass::Queued);
        // Cancelled: matching queue, executed=false, cancelled=true
        let mut cancelled = qeth_rec(); cancelled.cancelled = true;
        assert_eq!(classify_processed(&OnChainFacts { verified_release: false, queue: Some(&cancelled), expected: &exp }),
            ProcessedClass::CancelledRefundCandidate);
        // Ambiguous: processed but no verified release and no uniquely-bound queue
        assert_eq!(classify_processed(&OnChainFacts { verified_release: false, queue: None, expected: &exp }),
            ProcessedClass::Ambiguous);
        // Ambiguous: executed=true in queue but no verified release (fail closed)
        let mut executed = qeth_rec(); executed.executed = true;
        assert_eq!(classify_processed(&OnChainFacts { verified_release: false, queue: Some(&executed), expected: &exp }),
            ProcessedClass::Ambiguous);
        // Ambiguous: a queue that does NOT match the expected withdrawal (wrong l1TxId)
        let mut wrong = qeth_rec(); wrong.l1_tx_id = [1u8;32];
        assert_eq!(classify_processed(&OnChainFacts { verified_release: false, queue: Some(&wrong), expected: &exp }),
            ProcessedClass::Ambiguous);
    }

    #[test]
    fn r1e_refund_decision_fail_closed() {
        // processed==false → normal analysis may proceed
        assert_eq!(refund_decision(false, None), RefundDecision::NormalAnalysis);
        // processed==true, each class
        assert_eq!(refund_decision(true, Some(ProcessedClass::Paid)), RefundDecision::Forbidden);
        assert_eq!(refund_decision(true, Some(ProcessedClass::Queued)), RefundDecision::Forbidden);
        assert_eq!(refund_decision(true, Some(ProcessedClass::Ambiguous)), RefundDecision::Forbidden);
        assert_eq!(refund_decision(true, None), RefundDecision::Forbidden); // unknown class → forbidden
        assert_eq!(refund_decision(true, Some(ProcessedClass::CancelledRefundCandidate)),
            RefundDecision::MayProceedAfterCancellationProof);
    }

    #[test]
    fn successful_xrge_and_token() {
        let (mut b, mut t, mut burn) = maps(xrge_f64_to_quanta(1000.0));
        let r = apply_bridge_withdraw(&mut b, &mut t, &mut burn, &addr(), 0.001, Some("XRGE"), Some(100), Some(A11), tid(1));
        match r { Success(e) => { assert_eq!(e.canonical_token, "XRGE"); assert_eq!(e.amount, 100); } _ => panic!() }
        // token path
        t.insert((addr(), "3EYE".to_string()), 500u128);
        let rt = apply_bridge_withdraw(&mut b, &mut t, &mut burn, &addr(), 0.001, Some("3EYE"), Some(500), Some(A11), tid(2));
        match rt { Success(e) => { assert_eq!(e.canonical_token, "3EYE"); } _ => panic!() }
        assert_eq!(*t.get(&(addr(), "3EYE".to_string())).unwrap(), 0);
        let rt2 = apply_bridge_withdraw(&mut b, &mut t, &mut burn, &addr(), 0.001, Some("3EYE"), Some(1), Some(A11), tid(3));
        assert_eq!(rt2, Failed(InsufficientToken));
    }
}
