//! Public, read-only bridge activity feed (`GET /api/bridge/activity`, `GET /api/bridge/activity/:tx_id`).
//!
//! NON-CONSENSUS and READ-ONLY. Every item is derived from data that is already public or already
//! stored; nothing is written, migrated or guessed:
//!
//! * **Chain data** — every `bridge_withdraw` / `bridge_mint` transaction in an accepted block (or
//!   still in the mempool): tx id, block height/time, token, raw amount, the RougeChain party
//!   (sender of a withdrawal, recipient of a mint) and, for withdrawals, the external destination
//!   the user signed (`evm_address`, which is also the BTC address for qBTC).
//! * **The payout store** (`bridge_withdrawals.json`) — ONLY its lifecycle status, the verified
//!   payout tx hash and the status timestamp. `last_error`, `attempts` and the owner key are never
//!   read into this module's output (see [`WithdrawRecordView`]): relayer internals stay private.
//! * **The claim store** — only the presence of `refund:{store_tx_id}` (the daemon's refund
//!   nullifier), because the refund path deletes the payout record after minting the refund.
//!
//! What is NOT recorded anywhere, and is therefore always `null`: the external SOURCE tx hash of a
//! deposit (the claim store keeps source hashes as a replay set with no link to the mint tx id) and
//! the external sender address of a deposit.
//!
//! Fail closed: while the derived payout store is degraded the endpoints answer 503, exactly like
//! `/api/bridge/health`, so a known-incomplete store never produces a misleading status.

use axum::http::StatusCode;
use axum::Json;
use quantum_vault_bridge_exec::{payout_route, PayoutRoute};
use quantum_vault_storage::bridge_withdraw_store::{PendingWithdrawal, WithdrawalStatus};
use quantum_vault_types::{compute_single_tx_hash, BlockV1, TxV1};
use serde::Serialize;

pub const DEFAULT_LIMIT: usize = 25;
pub const MAX_LIMIT: usize = 100;
/// Mempool items are only ever shown on the first page, and at most this many.
const MAX_MEMPOOL_ITEMS: usize = 50;

// ─── Output model ────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivityKind {
    Deposit,
    Withdrawal,
}

/// Public status of one bridge transfer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivityStatus {
    /// Submitted to RougeChain but not in a block yet (mempool).
    Pending,
    /// Withdrawal accepted on-chain and waiting in the relayer's payout queue.
    Queued,
    /// Withdrawal: payout verified on the external chain. Deposit: minted on RougeChain.
    Paid,
    /// Rejected on RougeChain, or payout attempts are failing (the relayer keeps retrying).
    Failed,
    /// The payout could not be completed and the tokens were minted back on RougeChain.
    Refunded,
    /// The node holds no payout record for this withdrawal (e.g. before the payout store existed).
    Unknown,
}

/// A coarse, fixed explanation of the status. Never a raw error string.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StatusReason {
    InMempool,
    RejectedOnChain,
    AwaitingPayout,
    PayoutRetrying,
    PayoutVerified,
    RefundedOnRougechain,
    NoPayoutRecord,
    Minted,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityItem {
    pub kind: ActivityKind,
    /// Token symbol on RougeChain (`qETH`, `qUSDC`, `qBTC`, `XRGE`, or the on-chain symbol).
    pub asset: String,
    /// The asset on the external chain (`ETH`, `USDC`, `BTC`, `XRGE`); null for unsupported tokens.
    pub external_asset: Option<&'static str>,
    /// Raw on-chain units (qBTC: sats; qETH/qUSDC: 6 decimals; XRGE: whole XRGE).
    pub amount_units: u64,
    /// Decimals of `amountUnits`; null when the asset is not a bridge asset.
    pub decimals: Option<u8>,
    /// `base` | `base-sepolia` | `bitcoin` | `bitcoin-testnet` | `rougechain` | `unknown`.
    pub from_chain: String,
    pub to_chain: String,
    /// The RougeChain transaction (withdrawal burn or deposit mint).
    pub rougechain_tx_id: String,
    /// rouge1 address of the RougeChain party: withdrawal sender / deposit recipient.
    pub rougechain_address: Option<String>,
    /// Null while the transaction is still in the mempool.
    pub block_height: Option<u64>,
    /// `"8453"` (Base), `"84532"` (Base Sepolia), `"bitcoin"`, or null if not configured.
    pub external_chain_id: Option<String>,
    /// `base` | `base-sepolia` | `mainnet` | `testnet` (Bitcoin), or null.
    pub external_network: Option<String>,
    /// Withdrawal: the destination the user signed. Deposit: null (not recorded).
    pub external_address: Option<String>,
    /// Withdrawal: the verified payout tx hash once paid. Deposit: null (not recorded).
    pub external_tx_hash: Option<String>,
    pub status: ActivityStatus,
    pub status_reason: StatusReason,
    /// Block time in ms (null in the mempool).
    pub timestamp: Option<u64>,
    /// When the payout store last changed this withdrawal's status (ms), if known.
    pub status_updated_at: Option<i64>,
    /// Pagination position (`{height}-{index}`); null for mempool items.
    pub cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPage {
    pub items: Vec<ActivityItem>,
    /// Pass as `before` to read the next (older) page; null when there is nothing older.
    pub next_cursor: Option<String>,
    pub limit: usize,
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

/// One bridge transaction as it appears on RougeChain. Only public on-chain values.
#[derive(Clone, Debug, PartialEq)]
pub struct ChainBridgeTx {
    pub tx_id: String,
    pub kind: ActivityKind,
    pub block_height: Option<u64>,
    pub tx_index: u32,
    pub block_time: Option<u64>,
    pub token_symbol: String,
    pub amount: u64,
    /// Withdrawal: sender pubkey. Deposit: recipient pubkey.
    pub rougechain_pubkey: String,
    /// Withdrawal destination as signed on-chain.
    pub external_address: Option<String>,
}

/// The ONLY payout-store fields this feed may read. `last_error`, `attempts`, `owner_pubkey`
/// are deliberately absent, so they cannot leak through any code path here.
#[derive(Clone, Debug, PartialEq)]
pub struct WithdrawRecordView {
    pub status: WithdrawalStatus,
    pub payout_tx_hash: Option<String>,
    pub updated_at: i64,
}

impl From<&PendingWithdrawal> for WithdrawRecordView {
    fn from(w: &PendingWithdrawal) -> Self {
        WithdrawRecordView { status: w.status, payout_tx_hash: w.payout_tx_hash.clone(), updated_at: w.updated_at }
    }
}

/// External-chain configuration (public: the same values `/api/bridge/config` reports).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ExternalConfig {
    /// 8453 or 84532 when the Base bridge is configured.
    pub base_chain_id: Option<u64>,
    /// "mainnet" | "testnet".
    pub btc_network: String,
}

/// Everything the feed reads. The daemon implements it over the node + stores; tests use a fake.
pub trait ActivitySource {
    fn degraded(&self) -> bool;
    fn tip_height(&self) -> Result<u64, String>;
    fn block(&self, height: u64) -> Result<Option<BlockV1>, String>;
    /// Height of the block containing `tx_id`, if indexed.
    fn tx_height(&self, tx_id: &str) -> Result<Option<u64>, String>;
    /// `Some(true)` success, `Some(false)` failed, `None` no receipt.
    fn receipt_ok(&self, tx_id: &str) -> Option<bool>;
    fn mempool(&self) -> Vec<TxV1>;
    fn withdraw_record(&self, store_tx_id: &str) -> Option<WithdrawRecordView>;
    /// True when the daemon's refund nullifier `refund:{store_tx_id}` exists.
    fn refunded(&self, store_tx_id: &str) -> bool;
    fn external(&self) -> ExternalConfig;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq)]
pub enum ActivityError {
    Degraded,
    BadRequest(&'static str),
    NotFound,
    /// Internal read failure. The detail is logged, never returned.
    Unavailable,
}

impl ActivityError {
    pub fn status_code(&self) -> StatusCode {
        match self {
            ActivityError::Degraded | ActivityError::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
            ActivityError::BadRequest(_) => StatusCode::BAD_REQUEST,
            ActivityError::NotFound => StatusCode::NOT_FOUND,
        }
    }

    pub fn into_response(self) -> (StatusCode, Json<serde_json::Value>) {
        let code = self.status_code();
        let body = match self {
            ActivityError::Degraded => serde_json::json!({ "error": "bridge state degraded", "degraded": true }),
            ActivityError::BadRequest(m) => serde_json::json!({ "error": m }),
            ActivityError::NotFound => serde_json::json!({ "error": "not a bridge transaction" }),
            ActivityError::Unavailable => serde_json::json!({ "error": "bridge activity unavailable" }),
        };
        (code, Json(body))
    }
}

fn internal(e: String) -> ActivityError {
    eprintln!("[bridge-activity] read failed: {}", e);
    ActivityError::Unavailable
}

// ─── Validation helpers (the output never carries an unvalidated free-form string) ───

fn is_hex(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn valid_symbol(s: &str) -> bool {
    (1..=32).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn valid_evm_address(s: &str) -> bool {
    s.len() == 42 && s.starts_with("0x") && is_hex(&s[2..])
}

fn valid_btc_address(s: &str) -> bool {
    (14..=90).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn valid_evm_hash(s: &str) -> bool {
    s.len() == 66 && s.starts_with("0x") && is_hex(&s[2..])
}

fn valid_btc_txid(s: &str) -> bool {
    s.len() == 64 && is_hex(s)
}

pub fn is_tx_id(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

// ─── Chain extraction ────────────────────────────────────────────────────────

/// A bridge transaction from its on-chain body, or None for any other tx (or a malformed one).
pub fn classify_tx(
    tx: &TxV1,
    tx_id: String,
    block_height: Option<u64>,
    tx_index: u32,
    block_time: Option<u64>,
) -> Option<ChainBridgeTx> {
    let kind = match tx.tx_type.as_str() {
        "bridge_withdraw" => ActivityKind::Withdrawal,
        "bridge_mint" => ActivityKind::Deposit,
        _ => return None,
    };
    let token = tx.payload.token_symbol.as_deref()?.trim().to_string();
    let amount = tx.payload.amount?;
    if !valid_symbol(&token) || amount == 0 {
        return None;
    }
    let (party, external) = match kind {
        ActivityKind::Withdrawal => (tx.from_pub_key.clone(), tx.payload.evm_address.clone()),
        ActivityKind::Deposit => (tx.payload.to_pub_key_hex.clone().unwrap_or_default(), None),
    };
    Some(ChainBridgeTx {
        tx_id,
        kind,
        block_height,
        tx_index,
        block_time,
        token_symbol: token,
        amount,
        rougechain_pubkey: party,
        external_address: external,
    })
}

/// Bridge txs of one block, in block order.
pub fn block_bridge_txs(block: &BlockV1) -> Vec<ChainBridgeTx> {
    block
        .txs
        .iter()
        .enumerate()
        .filter_map(|(i, tx)| {
            classify_tx(tx, compute_single_tx_hash(tx), Some(block.header.height), i as u32, Some(block.header.time))
        })
        .collect()
}

/// The payout-store key of a withdrawal: XRGE keeps the legacy `xrge:` prefix.
pub fn store_tx_id(token_symbol: &str, tx_id: &str) -> String {
    if payout_route(token_symbol) == PayoutRoute::Xrge {
        format!("xrge:{}", tx_id)
    } else {
        tx_id.to_string()
    }
}

// ─── Incremental chain scan (cached across requests) ─────────────────────────

/// Bridge txs of every accepted block, oldest first. Refreshed incrementally; a replaced tip
/// (reorg) triggers a full rescan.
#[derive(Default)]
pub struct ChainScan {
    scanned_to: u64,
    tip_hash: Option<String>,
    txs: Vec<ChainBridgeTx>,
}

impl ChainScan {
    pub fn refresh(&mut self, src: &dyn ActivitySource) -> Result<(), String> {
        let tip = src.tip_height()?;
        if self.scanned_to > 0 {
            let still_canonical = match (src.block(self.scanned_to)?, &self.tip_hash) {
                (Some(b), Some(h)) => &b.hash == h,
                _ => false,
            };
            if !still_canonical || tip < self.scanned_to {
                *self = ChainScan::default();
            }
        }
        let mut h = self.scanned_to + 1;
        while h <= tip {
            if let Some(block) = src.block(h)? {
                self.txs.extend(block_bridge_txs(&block));
                self.tip_hash = Some(block.hash.clone());
                self.scanned_to = h;
            } else {
                break; // not persisted yet — pick up on the next request
            }
            h += 1;
        }
        Ok(())
    }

    pub fn txs(&self) -> &[ChainBridgeTx] {
        &self.txs
    }
}

// ─── Status mapping ──────────────────────────────────────────────────────────

pub fn withdrawal_status(
    in_block: bool,
    receipt_ok: Option<bool>,
    record: Option<&WithdrawRecordView>,
    refunded: bool,
) -> (ActivityStatus, StatusReason) {
    if !in_block {
        return (ActivityStatus::Pending, StatusReason::InMempool);
    }
    if receipt_ok == Some(false) {
        return (ActivityStatus::Failed, StatusReason::RejectedOnChain);
    }
    if let Some(r) = record {
        if r.status == WithdrawalStatus::Fulfilled {
            return (ActivityStatus::Paid, StatusReason::PayoutVerified);
        }
    }
    // The refund path mints the refund, then deletes the payout record (and a restart may rebuild
    // it as Pending) — the refund nullifier is the durable proof of a refund.
    if refunded {
        return (ActivityStatus::Refunded, StatusReason::RefundedOnRougechain);
    }
    match record.map(|r| r.status) {
        Some(WithdrawalStatus::Pending) => (ActivityStatus::Queued, StatusReason::AwaitingPayout),
        Some(WithdrawalStatus::Failed) => (ActivityStatus::Failed, StatusReason::PayoutRetrying),
        Some(WithdrawalStatus::Refunded) => (ActivityStatus::Refunded, StatusReason::RefundedOnRougechain),
        Some(WithdrawalStatus::Fulfilled) => unreachable!("handled above"),
        None => (ActivityStatus::Unknown, StatusReason::NoPayoutRecord),
    }
}

pub fn deposit_status(in_block: bool, receipt_ok: Option<bool>) -> (ActivityStatus, StatusReason) {
    if !in_block {
        return (ActivityStatus::Pending, StatusReason::InMempool);
    }
    if receipt_ok == Some(false) {
        return (ActivityStatus::Failed, StatusReason::RejectedOnChain);
    }
    (ActivityStatus::Paid, StatusReason::Minted)
}

// ─── Item building ───────────────────────────────────────────────────────────

struct External {
    asset: Option<&'static str>,
    decimals: Option<u8>,
    chain_id: Option<String>,
    network: Option<String>,
    chain_label: String,
    is_btc: bool,
}

fn external_for(token: &str, cfg: &ExternalConfig) -> External {
    let base = |asset: &'static str, decimals: u8| {
        let (chain_id, network, label) = match cfg.base_chain_id {
            Some(8453) => (Some("8453".to_string()), Some("base".to_string()), "base"),
            Some(84532) => (Some("84532".to_string()), Some("base-sepolia".to_string()), "base-sepolia"),
            _ => (None, None, "base"),
        };
        External { asset: Some(asset), decimals: Some(decimals), chain_id, network, chain_label: label.to_string(), is_btc: false }
    };
    match payout_route(token) {
        PayoutRoute::Eth => base("ETH", 6),
        PayoutRoute::Usdc => base("USDC", 6),
        PayoutRoute::Xrge => base("XRGE", 0),
        PayoutRoute::Btc => {
            let testnet = cfg.btc_network == "testnet";
            External {
                asset: Some("BTC"),
                decimals: Some(8),
                chain_id: Some("bitcoin".to_string()),
                network: Some(if testnet { "testnet" } else { "mainnet" }.to_string()),
                chain_label: if testnet { "bitcoin-testnet" } else { "bitcoin" }.to_string(),
                is_btc: true,
            }
        }
        PayoutRoute::Unsupported => External {
            asset: None,
            decimals: None,
            chain_id: None,
            network: None,
            chain_label: "unknown".to_string(),
            is_btc: false,
        },
    }
}

/// rouge1 form of the RougeChain party: a pubkey (hex) is derived; a mint may already name its
/// recipient as a rouge1 address, which is passed through only if it is well-formed bech32m.
fn rouge_address(identity: &str) -> Option<String> {
    let identity = identity.trim();
    if identity.starts_with("rouge1") {
        let data = &identity[6..];
        let charset_ok = data.bytes().all(|b| b"qpzry9x8gf2tvdw0s3jn54khce6mua7l".contains(&b));
        return (charset_ok && (6..=90).contains(&data.len())).then(|| identity.to_string());
    }
    if identity.is_empty() || !is_hex(identity) {
        return None;
    }
    quantum_vault_crypto::pub_key_to_address(identity).ok()
}

pub fn cursor_of(tx: &ChainBridgeTx) -> Option<String> {
    tx.block_height.map(|h| format!("{}-{}", h, tx.tx_index))
}

/// Build one public item. Pure: every input is passed in.
pub fn build_item(
    tx: &ChainBridgeTx,
    receipt_ok: Option<bool>,
    record: Option<&WithdrawRecordView>,
    refunded: bool,
    cfg: &ExternalConfig,
) -> ActivityItem {
    let ext = external_for(&tx.token_symbol, cfg);
    let in_block = tx.block_height.is_some();
    let (status, reason, external_address, external_tx_hash, updated) = match tx.kind {
        ActivityKind::Withdrawal => {
            let (s, r) = withdrawal_status(in_block, receipt_ok, record, refunded);
            let addr = tx.external_address.as_deref().map(str::trim).filter(|a| {
                if ext.is_btc { valid_btc_address(a) } else { valid_evm_address(a) }
            });
            // Only a PAID item carries a payout hash, and only in the external chain's format.
            let hash = if s == ActivityStatus::Paid {
                record.and_then(|r| r.payout_tx_hash.as_deref()).map(str::trim).filter(|h| {
                    if ext.is_btc { valid_btc_txid(h) } else { valid_evm_hash(h) }
                })
            } else {
                None
            };
            (s, r, addr.map(str::to_string), hash.map(str::to_string), record.map(|r| r.updated_at).filter(|t| *t > 0))
        }
        ActivityKind::Deposit => {
            let (s, r) = deposit_status(in_block, receipt_ok);
            (s, r, None, None, None)
        }
    };
    let (from_chain, to_chain) = match tx.kind {
        ActivityKind::Withdrawal => ("rougechain".to_string(), ext.chain_label.clone()),
        ActivityKind::Deposit => (ext.chain_label.clone(), "rougechain".to_string()),
    };
    ActivityItem {
        kind: tx.kind,
        asset: tx.token_symbol.clone(),
        external_asset: ext.asset,
        amount_units: tx.amount,
        decimals: ext.decimals,
        from_chain,
        to_chain,
        rougechain_tx_id: tx.tx_id.clone(),
        rougechain_address: rouge_address(&tx.rougechain_pubkey),
        block_height: tx.block_height,
        external_chain_id: ext.chain_id,
        external_network: ext.network,
        external_address,
        external_tx_hash,
        status,
        status_reason: reason,
        timestamp: tx.block_time,
        status_updated_at: updated,
        cursor: cursor_of(tx),
    }
}

fn item_from_source(src: &dyn ActivitySource, tx: &ChainBridgeTx, cfg: &ExternalConfig) -> ActivityItem {
    let receipt = if tx.block_height.is_some() { src.receipt_ok(&tx.tx_id) } else { None };
    let (record, refunded) = if tx.kind == ActivityKind::Withdrawal {
        let key = store_tx_id(&tx.token_symbol, &tx.tx_id);
        (src.withdraw_record(&key), src.refunded(&key))
    } else {
        (None, false)
    };
    build_item(tx, receipt, record.as_ref(), refunded, cfg)
}

// ─── Queries ─────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cursor {
    pub height: u64,
    /// None = before the start of `height` (i.e. every item below `height`).
    pub index: Option<u32>,
}

fn parse_u64(s: &str) -> Option<u64> {
    if s.is_empty() || s.len() > 16 || !s.bytes().all(|b| b.is_ascii_digit()) || (s.len() > 1 && s.starts_with('0')) {
        return None;
    }
    s.parse().ok()
}

/// `before` is `{height}` or `{height}-{index}` (as returned in `cursor` / `nextCursor`).
pub fn parse_cursor(s: &str) -> Result<Cursor, ActivityError> {
    let bad = ActivityError::BadRequest("before must be <height> or <height>-<index>");
    match s.split_once('-') {
        None => Ok(Cursor { height: parse_u64(s).ok_or(bad)?, index: None }),
        Some((h, i)) => {
            let height = parse_u64(h).ok_or(ActivityError::BadRequest("before must be <height> or <height>-<index>"))?;
            let index = parse_u64(i).filter(|i| *i <= u32::MAX as u64).ok_or(bad)? as u32;
            Ok(Cursor { height, index: Some(index) })
        }
    }
}

pub fn parse_limit(s: Option<&str>) -> Result<usize, ActivityError> {
    match s {
        None => Ok(DEFAULT_LIMIT),
        Some(v) => match parse_u64(v) {
            Some(n) if n >= 1 && n as usize <= MAX_LIMIT => Ok(n as usize),
            _ => Err(ActivityError::BadRequest("limit must be 1-100")),
        },
    }
}

fn is_before(tx: &ChainBridgeTx, c: &Cursor) -> bool {
    match tx.block_height {
        None => false,
        Some(h) => match c.index {
            None => h < c.height,
            Some(i) => h < c.height || (h == c.height && tx.tx_index < i),
        },
    }
}

/// Newest-first page. `chain` must be oldest-first (as the scan keeps it). Mempool items lead
/// the first page only.
pub fn select_page<'a>(
    chain: &'a [ChainBridgeTx],
    mempool: &'a [ChainBridgeTx],
    before: Option<Cursor>,
    limit: usize,
) -> (Vec<&'a ChainBridgeTx>, Option<String>) {
    let mut out: Vec<&ChainBridgeTx> = Vec::with_capacity(limit);
    if before.is_none() {
        out.extend(mempool.iter().take(MAX_MEMPOOL_ITEMS.min(limit)));
    }
    let mut older = chain.iter().rev().filter(|t| before.as_ref().map_or(true, |c| is_before(t, c)));
    let mut more = false;
    for t in older.by_ref() {
        if out.len() >= limit {
            more = true;
            break;
        }
        out.push(t);
    }
    let next = if more { out.iter().rev().find_map(|t| cursor_of(t)) } else { None };
    (out, next)
}

fn mempool_bridge_txs(src: &dyn ActivitySource) -> Vec<ChainBridgeTx> {
    let mut v: Vec<ChainBridgeTx> = src
        .mempool()
        .iter()
        .filter_map(|tx| classify_tx(tx, compute_single_tx_hash(tx), None, 0, None))
        .collect();
    v.sort_by(|a, b| a.tx_id.cmp(&b.tx_id)); // deterministic order
    v
}

/// `GET /api/bridge/activity?limit=&before=`
pub fn activity_page(
    src: &dyn ActivitySource,
    scan: &mut ChainScan,
    limit: Option<&str>,
    before: Option<&str>,
) -> Result<ActivityPage, ActivityError> {
    if src.degraded() {
        return Err(ActivityError::Degraded);
    }
    let limit = parse_limit(limit)?;
    let before = before.map(parse_cursor).transpose()?;
    scan.refresh(src).map_err(internal)?;
    let mempool = if before.is_none() { mempool_bridge_txs(src) } else { Vec::new() };
    let cfg = src.external();
    let (txs, next_cursor) = select_page(scan.txs(), &mempool, before, limit);
    Ok(ActivityPage { items: txs.into_iter().map(|t| item_from_source(src, t, &cfg)).collect(), next_cursor, limit })
}

/// `GET /api/bridge/activity/:tx_id` — one item by RougeChain tx id.
pub fn activity_item(src: &dyn ActivitySource, tx_id: &str) -> Result<ActivityItem, ActivityError> {
    if src.degraded() {
        return Err(ActivityError::Degraded);
    }
    let tx_id = tx_id.strip_prefix("xrge:").unwrap_or(tx_id);
    if !is_tx_id(tx_id) {
        return Err(ActivityError::BadRequest("tx id must be 64 lowercase hex characters"));
    }
    let cfg = src.external();
    if let Some(height) = src.tx_height(tx_id).map_err(internal)? {
        if let Some(block) = src.block(height).map_err(internal)? {
            if let Some(t) = block_bridge_txs(&block).into_iter().find(|t| t.tx_id == tx_id) {
                return Ok(item_from_source(src, &t, &cfg));
            }
        }
        return Err(ActivityError::NotFound);
    }
    if let Some(t) = mempool_bridge_txs(src).into_iter().find(|t| t.tx_id == tx_id) {
        return Ok(item_from_source(src, &t, &cfg));
    }
    Err(ActivityError::NotFound)
}

#[cfg(test)]
mod tests {
    use super::*;
    use quantum_vault_types::{BlockHeaderV1, TxPayload};
    use std::collections::{HashMap, HashSet};

    // ML-DSA-65 public keys are 1952 bytes; rouge1 derivation checks the length.
    fn owner() -> String { "df".repeat(1952) }
    fn recipient() -> String { "aa".repeat(1952) }
    const BTC_DEST: &str = "bc1qvt4r5dazmystwspgp62vh9ve5tutw5av4atjcz";
    const BTC_PAYOUT: &str = "91d306fcedfc15ce8cb8f1c547c5c2d403a20d138a74cc66fbb4a5e104259b84";
    const EVM_DEST: &str = "0x0c09C764AdC024497729cd452ECfeE8869d35d83";
    const EVM_PAYOUT: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";

    fn withdraw_tx(token: &str, amount: u64, dest: &str, nonce: u64) -> TxV1 {
        TxV1 {
            version: 1,
            tx_type: "bridge_withdraw".into(),
            from_pub_key: owner(),
            nonce,
            payload: TxPayload {
                token_symbol: Some(token.into()),
                amount: Some(amount),
                evm_address: Some(dest.into()),
                ..Default::default()
            },
            fee: 0.1,
            sig: "secret-looking-signature".into(),
            signed_payload: None,
        }
    }

    fn mint_tx(token: &str, amount: u64, nonce: u64) -> TxV1 {
        TxV1 {
            version: 1,
            tx_type: "bridge_mint".into(),
            from_pub_key: "bridge-authority".into(),
            nonce,
            payload: TxPayload {
                to_pub_key_hex: Some(recipient()),
                amount: Some(amount),
                token_symbol: Some(token.into()),
                ..Default::default()
            },
            fee: 0.0,
            sig: String::new(),
            signed_payload: None,
        }
    }

    fn transfer_tx(nonce: u64) -> TxV1 {
        TxV1 {
            version: 1,
            tx_type: "transfer".into(),
            from_pub_key: owner(),
            nonce,
            payload: TxPayload { to_pub_key_hex: Some(recipient()), amount: Some(5), ..Default::default() },
            fee: 0.1,
            sig: String::new(),
            signed_payload: None,
        }
    }

    fn block(height: u64, txs: Vec<TxV1>) -> BlockV1 {
        BlockV1 {
            version: 1,
            header: BlockHeaderV1 {
                version: 1,
                chain_id: "rougechain-mainnet-1".into(),
                height,
                time: 1_790_716_000_000 + height * 1000,
                prev_hash: String::new(),
                tx_hash: String::new(),
                proposer_pub_key: String::new(),
                state_root: None,
                parent_commit: None,
            },
            txs,
            proposer_sig: String::new(),
            hash: format!("{:064x}", height),
        }
    }

    #[derive(Default)]
    struct Fake {
        degraded: bool,
        blocks: Vec<BlockV1>,
        mempool: Vec<TxV1>,
        receipts: HashMap<String, bool>,
        records: HashMap<String, PendingWithdrawal>,
        refunds: HashSet<String>,
        cfg: ExternalConfig,
    }

    impl ActivitySource for Fake {
        fn degraded(&self) -> bool { self.degraded }
        fn tip_height(&self) -> Result<u64, String> { Ok(self.blocks.last().map(|b| b.header.height).unwrap_or(0)) }
        fn block(&self, h: u64) -> Result<Option<BlockV1>, String> {
            Ok(self.blocks.iter().find(|b| b.header.height == h).cloned())
        }
        fn tx_height(&self, tx_id: &str) -> Result<Option<u64>, String> {
            Ok(self.blocks.iter().find(|b| b.txs.iter().any(|t| compute_single_tx_hash(t) == tx_id)).map(|b| b.header.height))
        }
        fn receipt_ok(&self, tx_id: &str) -> Option<bool> { self.receipts.get(tx_id).copied() }
        fn mempool(&self) -> Vec<TxV1> { self.mempool.clone() }
        fn withdraw_record(&self, k: &str) -> Option<WithdrawRecordView> { self.records.get(k).map(WithdrawRecordView::from) }
        fn refunded(&self, k: &str) -> bool { self.refunds.contains(k) }
        fn external(&self) -> ExternalConfig { self.cfg.clone() }
    }

    fn mainnet_cfg() -> ExternalConfig {
        ExternalConfig { base_chain_id: Some(8453), btc_network: "mainnet".into() }
    }

    fn record(tx_id: &str, token: &str, status: WithdrawalStatus, hash: Option<&str>) -> PendingWithdrawal {
        PendingWithdrawal {
            tx_id: tx_id.into(),
            evm_address: BTC_DEST.into(),
            amount_units: 5000,
            created_at: 1_790_716_492_551,
            owner_pubkey: owner(),
            token_symbol: token.into(),
            status,
            attempts: 3,
            last_error: Some("relayer key 0xdeadbeef RPC https://secret-rpc.example/KEY failed".into()),
            updated_at: 1_790_716_600_000,
            payout_tx_hash: hash.map(str::to_string),
        }
    }

    fn view(status: WithdrawalStatus, hash: Option<&str>) -> WithdrawRecordView {
        WithdrawRecordView { status, payout_tx_hash: hash.map(str::to_string), updated_at: 5 }
    }

    // ── every status mapping ──

    #[test]
    fn withdrawal_status_mapping_is_exhaustive() {
        use ActivityStatus::*;
        use StatusReason::*;
        let s = |in_block, receipt, rec: Option<WithdrawRecordView>, refunded| withdrawal_status(in_block, receipt, rec.as_ref(), refunded);
        assert_eq!(s(false, None, None, false), (Pending, InMempool));
        assert_eq!(s(true, Some(false), Some(view(WithdrawalStatus::Pending, None)), false), (Failed, RejectedOnChain));
        assert_eq!(s(true, Some(true), Some(view(WithdrawalStatus::Pending, None)), false), (Queued, AwaitingPayout));
        assert_eq!(s(true, None, Some(view(WithdrawalStatus::Pending, None)), false), (Queued, AwaitingPayout));
        assert_eq!(s(true, Some(true), Some(view(WithdrawalStatus::Failed, None)), false), (Failed, PayoutRetrying));
        assert_eq!(s(true, Some(true), Some(view(WithdrawalStatus::Fulfilled, Some(BTC_PAYOUT))), false), (Paid, PayoutVerified));
        assert_eq!(s(true, Some(true), Some(view(WithdrawalStatus::Refunded, None)), false), (Refunded, RefundedOnRougechain));
        // record deleted by the refund path — the nullifier still proves the refund
        assert_eq!(s(true, Some(true), None, true), (Refunded, RefundedOnRougechain));
        // rebuilt as Pending after a restart, but refunded: the refund wins over "queued"
        assert_eq!(s(true, Some(true), Some(view(WithdrawalStatus::Pending, None)), true), (Refunded, RefundedOnRougechain));
        // a verified payout always wins
        assert_eq!(s(true, Some(true), Some(view(WithdrawalStatus::Fulfilled, None)), true), (Paid, PayoutVerified));
        assert_eq!(s(true, Some(true), None, false), (Unknown, NoPayoutRecord));
        assert_eq!(s(true, None, None, false), (Unknown, NoPayoutRecord));
    }

    #[test]
    fn deposit_status_mapping() {
        assert_eq!(deposit_status(false, None), (ActivityStatus::Pending, StatusReason::InMempool));
        assert_eq!(deposit_status(true, None), (ActivityStatus::Paid, StatusReason::Minted));
        assert_eq!(deposit_status(true, Some(true)), (ActivityStatus::Paid, StatusReason::Minted));
        assert_eq!(deposit_status(true, Some(false)), (ActivityStatus::Failed, StatusReason::RejectedOnChain));
    }

    #[test]
    fn status_serializes_to_the_documented_strings() {
        let all = [
            (ActivityStatus::Pending, "pending"),
            (ActivityStatus::Queued, "queued"),
            (ActivityStatus::Paid, "paid"),
            (ActivityStatus::Failed, "failed"),
            (ActivityStatus::Refunded, "refunded"),
            (ActivityStatus::Unknown, "unknown"),
        ];
        for (s, want) in all {
            assert_eq!(serde_json::to_value(s).unwrap(), serde_json::json!(want));
        }
        assert_eq!(serde_json::to_value(StatusReason::RefundedOnRougechain).unwrap(), serde_json::json!("refunded_on_rougechain"));
    }

    // ── the real mainnet example ──

    fn qbtc_example() -> (Fake, String) {
        let tx = withdraw_tx("qBTC", 5000, BTC_DEST, 1_790_716_352_890);
        let id = compute_single_tx_hash(&tx);
        let mut f = Fake { cfg: mainnet_cfg(), ..Default::default() };
        // blocks 1..=200 carry no bridge txs; 201 a transfer; 202 the qBTC withdrawal
        f.blocks = (1..=200).map(|h| block(h, vec![])).collect();
        f.blocks.push(block(201, vec![transfer_tx(1)]));
        f.blocks.push(block(202, vec![tx]));
        f.receipts.insert(id.clone(), true);
        (f, id)
    }

    #[test]
    fn qbtc_withdrawal_paid_carries_the_bitcoin_payout_and_nothing_private() {
        let (mut f, id) = qbtc_example();
        f.records.insert(id.clone(), record(&id, "qBTC", WithdrawalStatus::Fulfilled, Some(BTC_PAYOUT)));
        let item = activity_item(&f, &id).unwrap();
        assert_eq!(item.kind, ActivityKind::Withdrawal);
        assert_eq!(item.asset, "qBTC");
        assert_eq!(item.external_asset, Some("BTC"));
        assert_eq!((item.amount_units, item.decimals), (5000, Some(8)));
        assert_eq!((item.from_chain.as_str(), item.to_chain.as_str()), ("rougechain", "bitcoin"));
        assert_eq!(item.block_height, Some(202));
        assert_eq!(item.external_chain_id.as_deref(), Some("bitcoin"));
        assert_eq!(item.external_network.as_deref(), Some("mainnet"));
        assert_eq!(item.external_address.as_deref(), Some(BTC_DEST));
        assert_eq!(item.external_tx_hash.as_deref(), Some(BTC_PAYOUT));
        assert_eq!(item.status, ActivityStatus::Paid);
        assert_eq!(item.status_updated_at, Some(1_790_716_600_000));
        assert_eq!(item.cursor.as_deref(), Some("202-0"));
        assert!(item.rougechain_address.as_deref().unwrap().starts_with("rouge1"));

        let json = serde_json::to_string(&item).unwrap();
        let owner = owner();
        for private in ["deadbeef", "secret-rpc", "KEY", "attempts", "lastError", "last_error", "ownerPubkey", owner.as_str(), "secret-looking-signature"] {
            assert!(!json.contains(private), "leaked {private}");
        }
    }

    #[test]
    fn qbtc_withdrawal_still_queued_has_no_payout_hash() {
        let (mut f, id) = qbtc_example();
        f.records.insert(id.clone(), record(&id, "qBTC", WithdrawalStatus::Pending, None));
        let item = activity_item(&f, &id).unwrap();
        assert_eq!(item.status, ActivityStatus::Queued);
        assert_eq!(item.external_tx_hash, None);
    }

    // ── null when unknown ──

    #[test]
    fn unknowns_are_null_never_guessed() {
        let (f, id) = qbtc_example(); // no payout record at all
        let item = activity_item(&f, &id).unwrap();
        assert_eq!(item.status, ActivityStatus::Unknown);
        assert_eq!(item.external_tx_hash, None);
        assert_eq!(item.status_updated_at, None);

        // a deposit never carries a source hash or external address: the node does not record them
        let mint = mint_tx("qETH", 1_250_000, 7);
        let mint_id = compute_single_tx_hash(&mint);
        let mut f = Fake { cfg: mainnet_cfg(), blocks: vec![block(1, vec![mint])], ..Default::default() };
        f.receipts.insert(mint_id.clone(), true);
        let d = activity_item(&f, &mint_id).unwrap();
        assert_eq!(d.kind, ActivityKind::Deposit);
        assert_eq!((d.from_chain.as_str(), d.to_chain.as_str()), ("base", "rougechain"));
        assert_eq!(d.external_asset, Some("ETH"));
        assert_eq!(d.decimals, Some(6));
        assert_eq!(d.external_chain_id.as_deref(), Some("8453"));
        assert_eq!(d.external_tx_hash, None);
        assert_eq!(d.external_address, None);
        assert_eq!(d.status, ActivityStatus::Paid);

        // no Base chain configured → no external chain id
        f.cfg = ExternalConfig { base_chain_id: None, btc_network: "mainnet".into() };
        let d = activity_item(&f, &mint_id).unwrap();
        assert_eq!((d.external_chain_id, d.external_network), (None, None));
    }

    #[test]
    fn malformed_store_or_payload_values_become_null() {
        let tx = ChainBridgeTx {
            tx_id: "ab".repeat(32),
            kind: ActivityKind::Withdrawal,
            block_height: Some(9),
            tx_index: 0,
            block_time: Some(1),
            token_symbol: "qETH".into(),
            amount: 1,
            rougechain_pubkey: "<script>".into(),
            external_address: Some("<img src=x onerror=alert(1)>".into()),
        };
        let item = build_item(&tx, Some(true), Some(&view(WithdrawalStatus::Fulfilled, Some("not a hash: RPC key xyz"))), false, &mainnet_cfg());
        assert_eq!(item.status, ActivityStatus::Paid);
        assert_eq!(item.external_tx_hash, None);
        assert_eq!(item.external_address, None);
        assert_eq!(item.rougechain_address, None);
        // a BTC txid is not accepted for an EVM asset and vice versa
        let item = build_item(&tx, Some(true), Some(&view(WithdrawalStatus::Fulfilled, Some(BTC_PAYOUT))), false, &mainnet_cfg());
        assert_eq!(item.external_tx_hash, None);
        let good = ChainBridgeTx { external_address: Some(EVM_DEST.into()), ..tx };
        let item = build_item(&good, Some(true), Some(&view(WithdrawalStatus::Fulfilled, Some(EVM_PAYOUT))), false, &mainnet_cfg());
        assert_eq!(item.external_tx_hash.as_deref(), Some(EVM_PAYOUT));
        assert_eq!(item.external_address.as_deref(), Some(EVM_DEST));
        assert_eq!(item.external_network.as_deref(), Some("base"));
    }

    #[test]
    fn xrge_withdrawals_use_the_prefixed_store_key_and_testnet_chains() {
        let tx = withdraw_tx("XRGE", 250, EVM_DEST, 3);
        let id = compute_single_tx_hash(&tx);
        let mut f = Fake {
            cfg: ExternalConfig { base_chain_id: Some(84532), btc_network: "testnet".into() },
            blocks: vec![block(5, vec![tx])],
            ..Default::default()
        };
        let key = format!("xrge:{}", id);
        f.records.insert(key.clone(), record(&key, "XRGE", WithdrawalStatus::Failed, None));
        let item = activity_item(&f, &id).unwrap();
        assert_eq!(item.status, ActivityStatus::Failed);
        assert_eq!(item.status_reason, StatusReason::PayoutRetrying);
        assert_eq!((item.external_asset, item.decimals), (Some("XRGE"), Some(0)));
        assert_eq!(item.external_chain_id.as_deref(), Some("84532"));
        assert_eq!(item.to_chain, "base-sepolia");
        // the prefixed form is accepted on the single-item route too
        assert_eq!(activity_item(&f, &key).unwrap().rougechain_tx_id, id);

        f.refunds.insert(key.clone());
        f.records.clear();
        assert_eq!(activity_item(&f, &id).unwrap().status, ActivityStatus::Refunded);

        let btc = withdraw_tx("qBTC", 10, "tb1qvt4r5dazmystwspgp62vh9ve5tutw5av4atjcz", 4);
        let item = build_item(&block_bridge_txs(&block(6, vec![btc]))[0], None, None, false, &f.cfg);
        assert_eq!(item.to_chain, "bitcoin-testnet");
        assert_eq!(item.external_network.as_deref(), Some("testnet"));
    }

    #[test]
    fn rouge1_recipients_pass_through_and_junk_is_dropped() {
        assert_eq!(rouge_address("rouge1aw424sfk3w9h2grllyqqqqqq").as_deref(), Some("rouge1aw424sfk3w9h2grllyqqqqqq"));
        assert_eq!(rouge_address("rouge1<script>"), None);
        assert_eq!(rouge_address("rouge1bbbbbbbbbb"), None); // "b" is not in the bech32 charset
        assert!(rouge_address(&owner()).unwrap().starts_with("rouge1"));
        assert_eq!(rouge_address("abcd"), None); // wrong key length
    }

    #[test]
    fn unsupported_or_malformed_bridge_txs() {
        let t = withdraw_tx("QTEK", 10, EVM_DEST, 1);
        let item = build_item(&block_bridge_txs(&block(1, vec![t]))[0], Some(true), None, false, &mainnet_cfg());
        assert_eq!((item.external_asset, item.decimals, item.external_chain_id.clone()), (None, None, None));
        assert_eq!(item.to_chain, "unknown");
        assert_eq!(item.status, ActivityStatus::Unknown);
        // junk symbol / zero amount / missing fields are not bridge activity
        assert!(block_bridge_txs(&block(1, vec![withdraw_tx("<b>", 1, EVM_DEST, 1)])).is_empty());
        assert!(block_bridge_txs(&block(1, vec![withdraw_tx("qETH", 0, EVM_DEST, 1)])).is_empty());
        assert!(block_bridge_txs(&block(1, vec![transfer_tx(1)])).is_empty());
    }

    // ── pagination ──

    fn busy_chain() -> Fake {
        let mut f = Fake { cfg: mainnet_cfg(), ..Default::default() };
        for h in 1..=6u64 {
            // two bridge txs per block plus a non-bridge tx in between
            f.blocks.push(block(h, vec![mint_tx("qUSDC", h * 10, h * 3), transfer_tx(h * 3 + 1), withdraw_tx("qETH", h, EVM_DEST, h * 3 + 2)]));
        }
        f
    }

    #[test]
    fn pagination_is_newest_first_with_stable_cursors() {
        let f = busy_chain();
        let mut scan = ChainScan::default();
        let p1 = activity_page(&f, &mut scan, Some("5"), None).unwrap();
        let cur: Vec<_> = p1.items.iter().map(|i| i.cursor.clone().unwrap()).collect();
        assert_eq!(cur, ["6-2", "6-0", "5-2", "5-0", "4-2"]);
        assert_eq!(p1.next_cursor.as_deref(), Some("4-2"));
        let p2 = activity_page(&f, &mut scan, Some("5"), p1.next_cursor.as_deref()).unwrap();
        let cur: Vec<_> = p2.items.iter().map(|i| i.cursor.clone().unwrap()).collect();
        assert_eq!(cur, ["4-0", "3-2", "3-0", "2-2", "2-0"]);
        let p3 = activity_page(&f, &mut scan, Some("5"), p2.next_cursor.as_deref()).unwrap();
        assert_eq!(p3.items.len(), 2);
        assert_eq!(p3.next_cursor, None);
        // a bare height means "everything below this block"
        let p = activity_page(&f, &mut scan, Some("100"), Some("3")).unwrap();
        assert_eq!(p.items.len(), 4);
        assert!(p.items.iter().all(|i| i.block_height.unwrap() < 3));
        // exact fit: no phantom next page
        let all = activity_page(&f, &mut scan, Some("12"), None).unwrap();
        assert_eq!((all.items.len(), all.next_cursor), (12, None));
        // default limit
        assert_eq!(activity_page(&f, &mut scan, None, None).unwrap().limit, DEFAULT_LIMIT);
    }

    #[test]
    fn mempool_items_lead_the_first_page_only() {
        let mut f = busy_chain();
        f.mempool = vec![withdraw_tx("qBTC", 99, BTC_DEST, 999), transfer_tx(1000)];
        let mut scan = ChainScan::default();
        let p1 = activity_page(&f, &mut scan, Some("3"), None).unwrap();
        assert_eq!(p1.items[0].status, ActivityStatus::Pending);
        assert_eq!((p1.items[0].block_height, p1.items[0].cursor.clone(), p1.items[0].timestamp), (None, None, None));
        assert_eq!(p1.items.len(), 3);
        assert_eq!(p1.next_cursor.as_deref(), Some("6-0"));
        let p2 = activity_page(&f, &mut scan, Some("3"), p1.next_cursor.as_deref()).unwrap();
        assert!(p2.items.iter().all(|i| i.block_height.is_some()));
        assert_eq!(p2.items[0].cursor.as_deref(), Some("5-2"));
        // single-item lookup finds a mempool tx too
        let id = compute_single_tx_hash(&f.mempool[0]);
        assert_eq!(activity_item(&f, &id).unwrap().status, ActivityStatus::Pending);
    }

    #[test]
    fn scan_is_incremental_and_rescans_after_a_reorg() {
        let mut f = busy_chain();
        let mut scan = ChainScan::default();
        scan.refresh(&f).unwrap();
        assert_eq!(scan.txs().len(), 12);
        f.blocks.push(block(7, vec![mint_tx("qBTC", 1, 70)]));
        scan.refresh(&f).unwrap();
        assert_eq!(scan.txs().len(), 13);
        // tip 7 replaced by a different block 7
        let mut replaced = block(7, vec![]);
        replaced.hash = "f".repeat(64);
        f.blocks.pop();
        f.blocks.push(replaced);
        scan.refresh(&f).unwrap();
        assert_eq!(scan.txs().len(), 12);
    }

    #[test]
    fn query_validation() {
        assert_eq!(parse_limit(None).unwrap(), DEFAULT_LIMIT);
        assert_eq!(parse_limit(Some("100")).unwrap(), 100);
        for bad in ["0", "101", "-1", "abc", "01", "", "1e3"] {
            assert_eq!(parse_limit(Some(bad)).unwrap_err().status_code(), StatusCode::BAD_REQUEST, "{bad}");
        }
        assert_eq!(parse_cursor("202").unwrap(), Cursor { height: 202, index: None });
        assert_eq!(parse_cursor("202-3").unwrap(), Cursor { height: 202, index: Some(3) });
        for bad in ["", "-", "202-", "-3", "a-1", "1-2-3", "0202", " 1", "99999999999999999"] {
            assert!(parse_cursor(bad).is_err(), "{bad}");
        }
        let f = busy_chain();
        assert_eq!(activity_item(&f, "XYZ").unwrap_err(), ActivityError::BadRequest("tx id must be 64 lowercase hex characters"));
        assert_eq!(activity_item(&f, &"A".repeat(64)).unwrap_err().status_code(), StatusCode::BAD_REQUEST);
        // a real tx that is not a bridge tx, and an unknown id, are both 404
        let transfer_id = compute_single_tx_hash(&f.blocks[0].txs[1]);
        assert_eq!(activity_item(&f, &transfer_id).unwrap_err(), ActivityError::NotFound);
        assert_eq!(activity_item(&f, &"0".repeat(64)).unwrap_err().status_code(), StatusCode::NOT_FOUND);
    }

    // ── fail closed ──

    #[test]
    fn degraded_bridge_state_is_503_on_both_routes() {
        let (mut f, id) = qbtc_example();
        f.degraded = true;
        let mut scan = ChainScan::default();
        let e = activity_page(&f, &mut scan, None, None).unwrap_err();
        assert_eq!(e, ActivityError::Degraded);
        let (code, body) = e.into_response();
        assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body.0["degraded"], serde_json::json!(true));
        let (code, _) = activity_item(&f, &id).unwrap_err().into_response();
        assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE);
        // degraded wins even over a bad query (no validation detail leaks either)
        assert_eq!(activity_page(&f, &mut scan, Some("0"), None).unwrap_err(), ActivityError::Degraded);
    }

    #[test]
    fn internal_errors_are_generic() {
        let (code, body) = ActivityError::Unavailable.into_response();
        assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body.0, serde_json::json!({ "error": "bridge activity unavailable" }));
    }

    #[test]
    fn serialized_shape_matches_the_client_fixture() {
        let (mut f, id) = qbtc_example();
        f.records.insert(id.clone(), record(&id, "qBTC", WithdrawalStatus::Fulfilled, Some(BTC_PAYOUT)));
        let mut scan = ChainScan::default();
        let page = activity_page(&f, &mut scan, Some("1"), None).unwrap();
        let v = serde_json::to_value(&page).unwrap();
        let item = &v["items"][0];
        let mut keys: Vec<&str> = item.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "amountUnits", "asset", "blockHeight", "cursor", "decimals", "externalAddress", "externalAsset",
                "externalChainId", "externalNetwork", "externalTxHash", "fromChain", "kind", "rougechainAddress",
                "rougechainTxId", "status", "statusReason", "statusUpdatedAt", "timestamp", "toChain",
            ]
        );
        // The Explorer's fixture for this endpoint (packages/chain-readonly) must have exactly
        // this serializer's shape and, for the mainnet qBTC example, the same values.
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../packages/chain-readonly/fixtures/node-bridge-activity-item.json")).unwrap();
        let mut fixture_keys: Vec<&str> = fixture.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        fixture_keys.sort();
        assert_eq!(keys, fixture_keys);
        for k in [
            "kind", "asset", "externalAsset", "amountUnits", "decimals", "fromChain", "toChain", "blockHeight",
            "externalChainId", "externalNetwork", "externalAddress", "externalTxHash", "status", "statusReason", "cursor",
        ] {
            assert_eq!(item[k], fixture[k], "field {k}");
        }
        assert_eq!(item["kind"], "withdrawal");
        assert_eq!(item["status"], "paid");
        assert_eq!(item["statusReason"], "payout_verified");
        assert_eq!(item["externalChainId"], "bitcoin");
        assert_eq!(v["limit"], 1);
        assert!(v.get("nextCursor").is_some());
    }
}
