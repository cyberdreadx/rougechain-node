//! HTTP API for RougeChain Regenerate community votes (interim, node-hosted governance).
//! Storage + voting math live in `quantum_vault_storage::regen_vote_store`; this module
//! only authenticates requests, applies the configured rules and reads chain state.
//! Nothing here touches consensus or block production.
//!
//! Configuration (environment, read once at first use):
//! * `QV_REGEN_TREASURY`   — rouge1 address of the Regenerate treasury (always excluded
//!                           from voting; payouts must come from it).
//! * `QV_REGEN_CURATORS`   — comma-separated rouge1 addresses / pubkeys allowed to open
//!                           proposals without the balance minimum, record payouts and
//!                           cancel proposals.
//! * `QV_REGEN_EXCLUDED`   — comma-separated rouge1 addresses / pubkeys left out of every
//!                           snapshot (team, exchange and other custodial wallets).
//! * `QV_REGEN_CAP_BPS` (500 = 5%), `QV_REGEN_TURNOUT_BPS` (1000 = 10%),
//!   `QV_REGEN_DEFAULT_DAYS` (7), `QV_REGEN_MIN_CREATOR_XRGE` (10000).

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use quantum_vault_storage::regen_vote_store::{
    build_snapshot, status, tally, Choice, RegenProposal, RegenVote, RegenVoteStore, Status, QUANTA_PER_XRGE,
};
use std::collections::HashSet;
use std::sync::OnceLock;

use crate::{signed_bad, signed_err, signed_internal, verify_signed_request, AppState, SignedTransactionRequest};

type ApiResult = Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)>;

pub struct RegenConfig {
    pub treasury: Option<String>,
    pub curators: HashSet<String>,
    pub excluded: HashSet<String>,
    pub cap_bps: u32,
    pub turnout_bps: u32,
    pub default_days: u32,
    pub min_creator_xrge: u128,
}

fn canon(key: &str) -> String {
    let key = key.trim();
    if quantum_vault_crypto::is_rouge_address(key) {
        return key.to_string();
    }
    quantum_vault_crypto::pub_key_to_address(key).unwrap_or_else(|_| key.to_string())
}

fn env_list(name: &str) -> HashSet<String> {
    std::env::var(name)
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(canon)
        .collect()
}

fn env_num<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name).ok().and_then(|v| v.trim().parse().ok()).unwrap_or(default)
}

pub fn config() -> &'static RegenConfig {
    static CFG: OnceLock<RegenConfig> = OnceLock::new();
    CFG.get_or_init(|| {
        let treasury = std::env::var("QV_REGEN_TREASURY").ok().map(|s| canon(&s)).filter(|s| !s.is_empty());
        let mut excluded = env_list("QV_REGEN_EXCLUDED");
        if let Some(t) = &treasury {
            excluded.insert(t.clone());
        }
        RegenConfig {
            treasury,
            curators: env_list("QV_REGEN_CURATORS"),
            excluded,
            cap_bps: env_num("QV_REGEN_CAP_BPS", 500u32).clamp(1, 10_000),
            turnout_bps: env_num("QV_REGEN_TURNOUT_BPS", 1000u32).min(10_000),
            default_days: env_num("QV_REGEN_DEFAULT_DAYS", 7u32).clamp(1, 30),
            min_creator_xrge: env_num("QV_REGEN_MIN_CREATOR_XRGE", 10_000u128),
        }
    })
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn xrge(q: u128) -> f64 {
    q as f64 / QUANTA_PER_XRGE as f64
}

fn view(p: &RegenProposal, votes: &[RegenVote], with_votes: bool) -> serde_json::Value {
    let t = tally(votes);
    let st = status(p, &t, now_ms());
    let mut v = serde_json::json!({
        "proposal": p,
        "tally": t,
        "status": st,
        "summaryXrge": {
            "eligibleTotal": xrge(p.eligible_total_quanta),
            "cap": xrge(p.cap_quanta),
            "turnoutNeeded": xrge(p.turnout_quanta),
            "yes": xrge(t.yes), "no": xrge(t.no), "abstain": xrge(t.abstain), "turnout": xrge(t.turnout),
        },
    });
    if with_votes {
        v["votes"] = serde_json::to_value(votes).unwrap_or_default();
    }
    v
}

fn store(state: &AppState) -> &RegenVoteStore {
    &state.regen_votes
}

// ------------------------------------------------------------------ reads

pub async fn get_config(State(_s): State<AppState>) -> Json<serde_json::Value> {
    let c = config();
    let mut excluded: Vec<&String> = c.excluded.iter().collect();
    excluded.sort();
    let mut curators: Vec<&String> = c.curators.iter().collect();
    curators.sort();
    Json(serde_json::json!({
        "success": true,
        "treasury": c.treasury,
        "capBps": c.cap_bps,
        "turnoutBps": c.turnout_bps,
        "defaultDays": c.default_days,
        "minCreatorXrge": c.min_creator_xrge,
        "excluded": excluded,
        "curators": curators,
    }))
}

pub async fn list_proposals(State(state): State<AppState>) -> ApiResult {
    let s = store(&state);
    let mut out = Vec::new();
    for p in s.list().map_err(|e| signed_internal(&e))? {
        let votes = s.votes(&p.id).map_err(|e| signed_internal(&e))?;
        out.push(view(&p, &votes, false));
    }
    Ok(Json(serde_json::json!({ "success": true, "proposals": out })))
}

pub async fn get_proposal(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult {
    let s = store(&state);
    let p = s.get(&id).map_err(|e| signed_internal(&e))?.ok_or_else(|| signed_bad("proposal not found"))?;
    let votes = s.votes(&id).map_err(|e| signed_internal(&e))?;
    let mut v = view(&p, &votes, true);
    v["success"] = serde_json::json!(true);
    Ok(Json(v))
}

pub async fn get_weight(State(state): State<AppState>, Path((id, who)): Path<(String, String)>) -> ApiResult {
    let s = store(&state);
    s.get(&id).map_err(|e| signed_internal(&e))?.ok_or_else(|| signed_bad("proposal not found"))?;
    let addr = canon(&who);
    let w = s.weight_of(&id, &addr).map_err(|e| signed_internal(&e))?;
    let voted = s.votes(&id).map_err(|e| signed_internal(&e))?.into_iter().find(|v| v.voter == addr);
    Ok(Json(serde_json::json!({
        "success": true,
        "address": addr,
        "eligible": w > 0,
        "excluded": config().excluded.contains(&addr),
        "weightQuanta": w.to_string(),
        "weightXrge": xrge(w),
        "vote": voted.map(|v| v.choice),
    })))
}

// ------------------------------------------------------------------ writes

fn opt_str(p: &serde_json::Value, k: &str, max: usize) -> Result<Option<String>, String> {
    match p.get(k).and_then(|v| v.as_str()).map(str::trim) {
        None | Some("") => Ok(None),
        Some(s) if s.chars().count() > max => Err(format!("{} is too long (max {} characters)", k, max)),
        Some(s) => Ok(Some(s.to_string())),
    }
}

/// POST /api/v2/regen/proposals — open a proposal and snapshot voting weights.
pub async fn create_proposal(State(state): State<AppState>, Json(body): Json<SignedTransactionRequest>) -> ApiResult {
    let authed = verify_signed_request(&body, &state.replay_nonces).await.map_err(|e| signed_err(&e))?;
    let p = &body.payload;
    let c = config();
    let creator = canon(&authed);
    let s = store(&state);

    let is_curator = c.curators.contains(&creator);
    if !is_curator {
        let bal = state.node.get_balance(&creator).map_err(|e| signed_internal(&e))?;
        if (bal as u128) < c.min_creator_xrge {
            return Err(signed_err(&format!(
                "opening a proposal needs at least {} XRGE (or curator rights)", c.min_creator_xrge
            )));
        }
        let open_mine = s
            .list()
            .map_err(|e| signed_internal(&e))?
            .into_iter()
            .filter(|x| x.creator == creator && !x.cancelled && x.ends_at_ms > now_ms())
            .count();
        if open_mine > 0 {
            return Err(signed_bad("you already have an open proposal"));
        }
    }

    let title = opt_str(p, "title", 120).map_err(|e| signed_bad(&e))?.ok_or_else(|| signed_bad("title is required"))?;
    let summary = opt_str(p, "summary", 4000).map_err(|e| signed_bad(&e))?.ok_or_else(|| signed_bad("summary is required"))?;
    let link = opt_str(p, "link", 500).map_err(|e| signed_bad(&e))?;
    if let Some(l) = &link {
        if !l.starts_with("https://") {
            return Err(signed_bad("link must start with https://"));
        }
    }
    let territory = opt_str(p, "territory", 80).map_err(|e| signed_bad(&e))?;
    let recipient = opt_str(p, "recipient", 120).map_err(|e| signed_bad(&e))?.map(|r| canon(&r));
    if let Some(r) = &recipient {
        if !quantum_vault_crypto::is_rouge_address(r) {
            return Err(signed_bad("recipient must be a rouge1 address"));
        }
    }
    let requested_xrge = match p.get("requestedXrge") {
        None | Some(serde_json::Value::Null) => None,
        Some(v) => match v.as_f64() {
            Some(x) if x > 0.0 && x.is_finite() => Some(x),
            _ => return Err(signed_bad("requestedXrge must be a positive number")),
        },
    };
    let days = p.get("durationDays").and_then(|v| v.as_u64()).map(|d| d as u32).unwrap_or(c.default_days);
    if !(1..=30).contains(&days) {
        return Err(signed_bad("durationDays must be between 1 and 30"));
    }

    let balances = state.node.xrge_balances_snapshot().map_err(|e| signed_internal(&e))?;
    let snap = build_snapshot(balances.iter(), &c.excluded, c.cap_bps, c.turnout_bps, quantum_vault_crypto::is_rouge_address);
    if snap.eligible_total == 0 {
        return Err(signed_bad("no eligible voting balance"));
    }
    let now = now_ms();
    let mut excluded: Vec<String> = c.excluded.iter().cloned().collect();
    excluded.sort();
    let draft = RegenProposal {
        id: String::new(),
        title,
        summary,
        link,
        territory,
        recipient,
        requested_xrge,
        creator,
        created_at_ms: now,
        starts_at_ms: now,
        // QV_REGEN_TEST_DURATION_MS: test-only override so end-to-end tests can close a vote in
        // seconds. Unset in production.
        ends_at_ms: now + std::env::var("QV_REGEN_TEST_DURATION_MS").ok().and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(i64::from(days) * 86_400_000),
        snapshot_height: state.node.get_tip_height().unwrap_or(0),
        eligible_total_quanta: 0,
        cap_quanta: 0,
        turnout_quanta: 0,
        cap_bps: c.cap_bps,
        turnout_bps: c.turnout_bps,
        excluded,
        eligible_voters: 0,
        payout_tx_id: None,
        payout_xrge: None,
        cancelled: false,
        cancel_reason: None,
    };
    let created = s.create(draft, &snap).map_err(|e| signed_internal(&e))?;
    Ok(Json(serde_json::json!({ "success": true, "proposal": created })))
}

/// POST /api/v2/regen/votes — cast or change a vote while the proposal is open.
pub async fn cast_vote(State(state): State<AppState>, Json(body): Json<SignedTransactionRequest>) -> ApiResult {
    let authed = verify_signed_request(&body, &state.replay_nonces).await.map_err(|e| signed_err(&e))?;
    let p = &body.payload;
    let s = store(&state);
    let id = p.get("proposalId").and_then(|v| v.as_str()).unwrap_or_default();
    let choice = p
        .get("choice")
        .and_then(|v| v.as_str())
        .and_then(Choice::parse)
        .ok_or_else(|| signed_bad("choice must be yes, no or abstain"))?;
    let proposal = s.get(id).map_err(|e| signed_internal(&e))?.ok_or_else(|| signed_bad("proposal not found"))?;
    let now = now_ms();
    if proposal.cancelled {
        return Err(signed_bad("proposal was cancelled"));
    }
    if now >= proposal.ends_at_ms {
        return Err(signed_bad("voting has closed"));
    }
    let voter = canon(&authed);
    let weight = s.weight_of(id, &voter).map_err(|e| signed_internal(&e))?;
    if weight == 0 {
        return Err(signed_err("this wallet had no eligible XRGE when the vote opened"));
    }
    let vote = RegenVote {
        proposal_id: id.to_string(),
        voter,
        public_key: authed,
        choice,
        weight_quanta: weight,
        cast_at_ms: now,
        signed_payload: serde_json::to_string(&body.payload).unwrap_or_default(),
        signature: body.signature.clone(),
    };
    s.cast(&vote).map_err(|e| signed_internal(&e))?;
    let votes = s.votes(id).map_err(|e| signed_internal(&e))?;
    let mut v = view(&proposal, &votes, false);
    v["success"] = serde_json::json!(true);
    v["vote"] = serde_json::to_value(&vote).unwrap_or_default();
    Ok(Json(v))
}

/// Find an on-chain XRGE transfer by id: (canonical from, canonical to, amount).
fn find_transfer(state: &AppState, tx_id: &str) -> Option<(String, String, f64)> {
    let store = state.node.store_ref();
    let height = store.lookup_tx_height(tx_id).ok().flatten()?;
    let block = store.get_block(height).ok().flatten()?;
    for tx in &block.txs {
        let id = quantum_vault_crypto::bytes_to_hex(&quantum_vault_crypto::sha256(&quantum_vault_types::encode_tx_v1(tx)));
        if id != tx_id {
            continue;
        }
        if tx.tx_type != "transfer" {
            return None;
        }
        let v = serde_json::to_value(&tx.payload).ok()?;
        let token = v.get("token_name").and_then(|x| x.as_str()).unwrap_or("XRGE");
        if token != "XRGE" {
            return None;
        }
        let to = v.get("to_pub_key_hex").and_then(|x| x.as_str())?;
        let amount = v.get("amount").and_then(|x| x.as_f64())?;
        return Some((canon(&tx.from_pub_key), canon(to), amount));
    }
    None
}

/// POST /api/v2/regen/proposals/payout — curator records the grant tx of a passed proposal.
/// Accepted only if the tx is an XRGE transfer from the treasury (to the recipient, if set).
pub async fn record_payout(State(state): State<AppState>, Json(body): Json<SignedTransactionRequest>) -> ApiResult {
    let authed = verify_signed_request(&body, &state.replay_nonces).await.map_err(|e| signed_err(&e))?;
    let c = config();
    if !c.curators.contains(&canon(&authed)) {
        return Err(signed_err("only a curator can record payouts"));
    }
    let p = &body.payload;
    let s = store(&state);
    let id = p.get("proposalId").and_then(|v| v.as_str()).unwrap_or_default();
    let tx_id = p.get("txId").and_then(|v| v.as_str()).unwrap_or_default().trim().to_ascii_lowercase();
    let proposal = s.get(id).map_err(|e| signed_internal(&e))?.ok_or_else(|| signed_bad("proposal not found"))?;
    let votes = s.votes(id).map_err(|e| signed_internal(&e))?;
    if status(&proposal, &tally(&votes), now_ms()) != Status::Passed {
        return Err(signed_bad("only a passed, unpaid proposal can be paid"));
    }
    let treasury = c.treasury.as_deref().ok_or_else(|| signed_bad("QV_REGEN_TREASURY is not configured"))?;
    let (from, to, amount) = find_transfer(&state, &tx_id).ok_or_else(|| signed_bad("no XRGE transfer with that id on-chain"))?;
    if from != treasury {
        return Err(signed_bad("that transfer did not come from the Regenerate treasury"));
    }
    if let Some(r) = &proposal.recipient {
        if &to != r {
            return Err(signed_bad("that transfer did not go to the proposal's recipient"));
        }
    }
    let updated = s.set_payout(id, &tx_id, amount).map_err(|e| signed_internal(&e))?;
    Ok(Json(serde_json::json!({ "success": true, "proposal": updated })))
}

/// POST /api/v2/regen/proposals/cancel — a curator, or the creator before anyone votes.
pub async fn cancel_proposal(State(state): State<AppState>, Json(body): Json<SignedTransactionRequest>) -> ApiResult {
    let authed = verify_signed_request(&body, &state.replay_nonces).await.map_err(|e| signed_err(&e))?;
    let p = &body.payload;
    let s = store(&state);
    let id = p.get("proposalId").and_then(|v| v.as_str()).unwrap_or_default();
    let reason = opt_str(p, "reason", 300).map_err(|e| signed_bad(&e))?.unwrap_or_else(|| "cancelled".into());
    let proposal = s.get(id).map_err(|e| signed_internal(&e))?.ok_or_else(|| signed_bad("proposal not found"))?;
    let who = canon(&authed);
    let is_curator = config().curators.contains(&who);
    let no_votes = s.votes(id).map_err(|e| signed_internal(&e))?.is_empty();
    if !(is_curator || (who == proposal.creator && no_votes)) {
        return Err(signed_err("only a curator, or the creator before any votes, can cancel"));
    }
    if proposal.cancelled || now_ms() >= proposal.ends_at_ms {
        return Err(signed_bad("proposal is not open"));
    }
    let updated = s.cancel(id, &reason).map_err(|e| signed_internal(&e))?;
    Ok(Json(serde_json::json!({ "success": true, "proposal": updated })))
}
