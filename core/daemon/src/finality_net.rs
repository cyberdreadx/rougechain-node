//! Track A Step 2.4 — FINALITY_V2 vote propagation + proof serving (inert while the gate is unscheduled).
//!
//! TRUST MODEL. The peer layer has no authenticated node identity (peers are URLs that
//! self-register), so NOTHING about a sender is trusted: not its claimed validator identity, not
//! stake, not finality height. Every received vote goes through the complete local
//! `submit_vote_v2` (stored block hash, provenance-verified validator set, ML-DSA-65 signature).
//! A peer can therefore only ever (a) deliver a vote that is valid on its own, or (b) waste
//! bounded CPU. It can never make this node SIGN anything: signing happens only in
//! `auto_vote_v2` / `resign_recent_votes`, driven by locally accepted blocks and the durable journal.
//! Propagation failure costs liveness only.
//!
//! DoS bounds: request body ≤ 1 MiB, ≤ 64 votes per request, cheap field/window/duplicate checks
//! before any signature work, a global token bucket on signature verifications, bounded tracked
//! deliveries, bounded retries with exponential backoff.
use crate::node::{L1Node, VoteIntake};
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use quantum_vault_types::VoteMessage;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const MAX_VOTES_PER_REQUEST: usize = 64;
pub const MAX_VOTE_REQUEST_BYTES: usize = 1024 * 1024;
/// Global budget of vote signature verifications (tokens/second, burst = 2×).
pub const VERIFY_BUDGET_PER_SEC: f64 = 200.0;
pub const MAX_DELIVERY_ATTEMPTS: u32 = 6;
pub const MAX_TRACKED_DELIVERIES: usize = 4096;
/// Own unfinalized votes are re-derived (journal-idempotent) and re-offered every N ticks.
pub const REBROADCAST_EVERY_TICKS: u64 = 15;

struct Bucket { tokens: f64, last: Instant }
#[derive(Clone)]
pub struct FinalityNetState { node: Arc<L1Node>, bucket: Arc<Mutex<Bucket>> }

fn take_tokens(b: &Mutex<Bucket>, n: usize) -> bool {
    let Ok(mut b) = b.lock() else { return false };
    let now = Instant::now();
    b.tokens = (b.tokens + now.duration_since(b.last).as_secs_f64() * VERIFY_BUDGET_PER_SEC).min(VERIFY_BUDGET_PER_SEC * 2.0);
    b.last = now;
    if b.tokens >= n as f64 { b.tokens -= n as f64; true } else { false }
}

/// Routes (no `AppState`): `POST /api/finality/votes`, `GET /api/finality/:height`.
pub fn finality_router(node: Arc<L1Node>) -> Router {
    let st = FinalityNetState { node, bucket: Arc::new(Mutex::new(Bucket { tokens: VERIFY_BUDGET_PER_SEC * 2.0, last: Instant::now() })) };
    Router::new()
        .route("/api/finality/votes", post(receive_votes))
        .route("/api/finality/:height", get(get_finality_proof))
        .layer(DefaultBodyLimit::max(MAX_VOTE_REQUEST_BYTES))
        .with_state(st)
}

/// Untrusted vote intake. Per-vote status: accepted | duplicate | not_ready | rejected.
async fn receive_votes(State(st): State<FinalityNetState>, Json(votes): Json<Vec<VoteMessage>>) -> (axum::http::StatusCode, Json<serde_json::Value>) {
    use axum::http::StatusCode;
    if votes.is_empty() || votes.len() > MAX_VOTES_PER_REQUEST { return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "success": false, "error": "1..=64 votes per request" }))); }
    if !take_tokens(&st.bucket, votes.len()) { return (StatusCode::TOO_MANY_REQUESTS, Json(serde_json::json!({ "success": false, "error": "vote verification budget exhausted" }))); }
    let node = st.node.clone();
    let statuses = tokio::task::spawn_blocking(move || votes.into_iter().map(|v| match node.receive_gossiped_vote(v) {
        VoteIntake::Accepted => "accepted", VoteIntake::Duplicate => "duplicate", VoteIntake::NotReady => "not_ready", VoteIntake::Rejected => "rejected" }).collect::<Vec<_>>()).await.unwrap_or_default();
    (StatusCode::OK, Json(serde_json::json!({ "success": true, "results": statuses })))
}

async fn get_finality_proof(State(st): State<FinalityNetState>, Path(height): Path<u64>) -> Json<serde_json::Value> {
    let node = &st.node;
    // FINALITY_V2 heights: serve ONLY a persisted, locally verified proof (peers re-verify it anyway).
    let res = if node.v2_active(height) { node.get_persisted_finality_proof(height) } else { node.generate_finality_proof(height) };
    Json(match res {
        Ok(Some(proof)) => serde_json::json!({ "success": true, "proof": proof }),
        Ok(None) => serde_json::json!({ "success": false, "error": format!("No finality proof available for height {}", height) }),
        Err(e) => serde_json::json!({ "success": false, "error": e }),
    })
}

// ── outbound ────────────────────────────────────────────────────────────────────────────────
struct PeerDelivery { attempts: u32, next_at: Instant, done: bool }
struct Tracked { vote: VoteMessage, peers: HashMap<String, PeerDelivery> }
fn vote_key(v: &VoteMessage) -> (u64, String, String) { (v.height, v.vote_type.clone(), v.voter_pub_key.clone()) }

/// Delivery state machine. `step` is one tick: take new votes from the node's outbox, offer every
/// undelivered vote to every peer that is due, then pull finality proofs for unfinalized heights.
pub struct VoteGossip { node: Arc<L1Node>, client: reqwest::Client, tracked: HashMap<(u64, String, String), Tracked>, ticks: u64, base_backoff: Duration }

impl VoteGossip {
    pub fn new(node: Arc<L1Node>) -> Self { Self::with_backoff(node, Duration::from_secs(1)) }
    pub fn with_backoff(node: Arc<L1Node>, base_backoff: Duration) -> Self {
        Self { node, client: reqwest::Client::builder().timeout(Duration::from_secs(5)).build().unwrap_or_default(), tracked: HashMap::new(), ticks: 0, base_backoff }
    }
    pub fn tracked(&self) -> usize { self.tracked.len() }

    pub async fn step(&mut self, peers: &[String]) {
        let tip = self.node.get_tip_height().unwrap_or(0);
        if !self.node.v2_active(tip) { return; }
        // own votes that may have been lost (restart, peer outage): journal-idempotent re-sign
        if self.ticks % REBROADCAST_EVERY_TICKS == 0 {
            let node = self.node.clone();
            if let Ok(votes) = tokio::task::spawn_blocking(move || node.resign_recent_votes()).await {
                for v in votes { self.tracked.remove(&vote_key(&v)); self.track(v); } // fresh delivery epoch
            }
        }
        self.ticks += 1;
        for v in self.node.drain_vote_outbox() { self.track(v); }
        // forget what no longer matters: finalized heights, heights outside the window
        let node = self.node.clone();
        self.tracked.retain(|(h, _, _), _| *h <= tip && tip - *h <= crate::node::FINALITY_V2_VOTE_WINDOW && !node.is_height_verified_final(*h));
        let now = Instant::now();
        for peer in peers {
            let due: Vec<(u64, String, String)> = self.tracked.iter().filter(|(_, t)| t.peers.get(peer).map(|d| !d.done && d.attempts < MAX_DELIVERY_ATTEMPTS && d.next_at <= now).unwrap_or(true))
                .map(|(k, _)| k.clone()).take(MAX_VOTES_PER_REQUEST).collect();
            if due.is_empty() { continue; }
            let batch: Vec<VoteMessage> = due.iter().map(|k| self.tracked[k].vote.clone()).collect();
            let results = self.post(peer, &batch).await;
            for (i, k) in due.iter().enumerate() {
                let status = results.as_ref().and_then(|r| r.get(i)).map(|s| s.as_str());
                let t = self.tracked.get_mut(k).unwrap();
                let d = t.peers.entry(peer.clone()).or_insert(PeerDelivery { attempts: 0, next_at: now, done: false });
                match status {
                    Some("accepted") | Some("duplicate") | Some("rejected") => d.done = true, // delivered; a rejection is final for that peer
                    _ => { d.attempts += 1; d.next_at = now + self.base_backoff * 2u32.saturating_pow(d.attempts.min(5)); } // not_ready / transport error / 429
                }
            }
        }
        // proofs: pull, verify locally, persist (never trust a peer's finalized height)
        if !self.node.is_height_verified_final(tip) { for peer in peers { crate::peer::pull_finality_from_peer(peer, &self.node).await; } }
    }

    fn track(&mut self, v: VoteMessage) {
        if self.tracked.len() >= MAX_TRACKED_DELIVERIES { if let Some(k) = self.tracked.keys().min().cloned() { self.tracked.remove(&k); } }
        self.tracked.entry(vote_key(&v)).or_insert(Tracked { vote: v, peers: HashMap::new() });
    }

    async fn post(&self, peer: &str, votes: &[VoteMessage]) -> Option<Vec<String>> {
        let resp = self.client.post(format!("{}/finality/votes", peer)).json(votes).send().await.ok()?;
        if !resp.status().is_success() { return None; }
        let bytes = resp.bytes().await.ok()?;
        if bytes.len() > 64 * 1024 { return None; }
        let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
        Some(v.get("results")?.as_array()?.iter().filter_map(|s| s.as_str().map(|s| s.to_string())).collect())
    }
}

/// Production background task.
pub async fn run_vote_gossip(peer_manager: Arc<crate::peer::PeerManager>, node: Arc<L1Node>) {
    let mut gossip = VoteGossip::new(node);
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let peers = peer_manager.get_active_peers().await;
        gossip.step(&peers).await;
    }
}
