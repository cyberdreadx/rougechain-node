mod grpc;
mod node;
mod peer;

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration as StdDuration, Instant};

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, Method, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use clap::Parser;
use serde::{Deserialize, Serialize};
use tokio::time::{sleep, Duration};
use tower_http::cors::{Any, CorsLayer};

use crate::grpc::GrpcNode;
use crate::node::{L1Node, NodeOptions};
use quantum_vault_types::ChainConfig;

#[derive(Parser, Debug)]
#[command(author, version, about)]
struct Args {
    #[arg(long, default_value = "127.0.0.1")]
    host: String,
    #[arg(long, default_value_t = 4100)]
    port: u16,
    #[arg(long, default_value_t = 5100)]
    api_port: u16,
    #[arg(long, default_value = "rougechain-devnet-1")]
    chain_id: String,
    #[arg(long, default_value_t = 1000)]
    block_time_ms: u64,
    #[arg(long)]
    mine: bool,
    #[arg(long)]
    data_dir: Option<String>,
    #[arg(long, env = "QV_API_KEYS")]
    api_keys: Option<String>,
    #[arg(long, default_value_t = 120)]
    rate_limit_per_minute: u32,
    #[arg(long, default_value_t = 120)]
    rate_limit_read_per_minute: u32,
    #[arg(long, default_value_t = 30)]
    rate_limit_write_per_minute: u32,
    /// Rate limit for validators (Tier 1) - 0 = unlimited
    #[arg(long, default_value_t = 0)]
    rate_limit_validator: u32,
    /// Rate limit for registered peers (Tier 2)
    #[arg(long, default_value_t = 300)]
    rate_limit_peer: u32,
    #[arg(long, env = "QV_FAUCET_WHITELIST")]
    faucet_whitelist: Option<String>,
    /// Comma-separated list of peer URLs to connect to (e.g., "http://node1.example.com:5100,http://node2.example.com:5100")
    #[arg(long, env = "QV_PEERS")]
    peers: Option<String>,
    /// Public URL of this node for peer discovery (e.g., "https://mynode.example.com")
    #[arg(long, env = "QV_PUBLIC_URL")]
    public_url: Option<String>,
}

#[derive(Clone)]
struct AppState {
    node: Arc<L1Node>,
    auth: AuthConfig,
    limiter: Arc<tokio::sync::Mutex<RateLimiter>>,
    read_limit: u32,
    write_limit: u32,
    validator_limit: u32,  // Tier 1: validators (0 = unlimited)
    peer_limit: u32,       // Tier 2: registered peers
    faucet_whitelist: Vec<String>,
    peer_manager: Arc<peer::PeerManager>,
}

#[derive(Clone)]
struct AuthConfig {
    api_keys: Vec<String>,
}

impl AuthConfig {
    fn new(raw: Option<String>) -> Self {
        let keys = raw
            .unwrap_or_default()
            .split(',')
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty())
            .collect();
        Self { api_keys: keys }
    }

    fn is_enabled(&self) -> bool {
        !self.api_keys.is_empty()
    }

    fn is_valid(&self, candidate: Option<&str>) -> bool {
        match candidate {
            Some(value) => self.api_keys.iter().any(|k| k == value),
            None => false,
        }
    }
}

struct RateLimiter {
    window: StdDuration,
    buckets: HashMap<String, VecDeque<Instant>>,
}

impl RateLimiter {
    fn new(_max_requests: u32, window: StdDuration) -> Self {
        Self {
            window,
            buckets: HashMap::new(),
        }
    }

    fn allow(&mut self, key: &str, limit: u32) -> bool {
        if limit == 0 {
            return true;
        }
        let now = Instant::now();
        let bucket = self.buckets.entry(key.to_string()).or_insert_with(VecDeque::new);
        while let Some(front) = bucket.front() {
            if now.duration_since(*front) > self.window {
                bucket.pop_front();
            } else {
                break;
            }
        }
        if bucket.len() as u32 >= limit {
            return false;
        }
        bucket.push_back(now);
        true
    }
}

fn parse_whitelist(raw: Option<String>) -> Vec<String> {
    raw.unwrap_or_default()
        .split(',')
        .map(|entry| normalize_recipient(entry.trim()))
        .filter(|entry| !entry.is_empty())
        .collect()
}

fn normalize_recipient(value: &str) -> String {
    let trimmed = value.trim();
    let stripped = trimmed.strip_prefix("xrge:").unwrap_or(trimmed);
    stripped.to_lowercase()
}

#[tokio::main]
async fn main() -> Result<(), String> {
    let args = Args::parse();
    let data_dir = args
        .data_dir
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| default_data_dir("core-node"));
    let chain = ChainConfig {
        chain_id: args.chain_id.clone(),
        genesis_time: chrono::Utc::now().timestamp_millis() as u64,
        block_time_ms: args.block_time_ms,
    };
    let node = Arc::new(L1Node::new(NodeOptions {
        data_dir,
        chain,
        mine: args.mine,
    })?);
    node.init()?;

    let grpc_addr: SocketAddr = format!("{}:{}", args.host, args.port)
        .parse()
        .map_err(|e: std::net::AddrParseError| e.to_string())?;

    let api_addr: SocketAddr = format!("{}:{}", args.host, args.api_port)
        .parse()
        .map_err(|e: std::net::AddrParseError| e.to_string())?;

    eprintln!(
        "[core-daemon] binding grpc={} api={} data_dir={}",
        grpc_addr,
        api_addr,
        args.data_dir.clone().unwrap_or_else(|| "default".to_string())
    );

    eprintln!("[core-daemon] setting up gRPC...");
    let grpc_node = GrpcNode::new(node.clone());
    let reflection = tonic_reflection::server::Builder::configure()
        .register_encoded_file_descriptor_set(grpc::FILE_DESCRIPTOR_SET)
        .build()
        .map_err(|e| e.to_string())?;
    eprintln!("[core-daemon] gRPC reflection ready");

    let grpc_server = tonic::transport::Server::builder()
        .add_service(grpc_node.clone().chain_service())
        .add_service(grpc_node.clone().wallet_service())
        .add_service(grpc_node.clone().validator_service())
        .add_service(grpc_node.clone().messenger_service())
        .add_service(reflection)
        .serve(grpc_addr);
    eprintln!("[core-daemon] gRPC server created");

    let auth = AuthConfig::new(args.api_keys.clone());
    let limiter = Arc::new(tokio::sync::Mutex::new(RateLimiter::new(
        args.rate_limit_per_minute,
        StdDuration::from_secs(60),
    )));
    let initial_peers: Vec<String> = args.peers
        .as_ref()
        .map(|p| peer::parse_peers(p))
        .unwrap_or_default();
    let peer_manager = Arc::new(peer::PeerManager::new(initial_peers.clone(), args.public_url.clone()));
    
    let app_state = AppState {
        node: node.clone(),
        auth,
        limiter,
        read_limit: args.rate_limit_read_per_minute,
        write_limit: args.rate_limit_write_per_minute,
        validator_limit: args.rate_limit_validator,
        peer_limit: args.rate_limit_peer,
        faucet_whitelist: parse_whitelist(args.faucet_whitelist),
        peer_manager: peer_manager.clone(),
    };

    // Start peer sync
    {
        let peer_node = node.clone();
        let pm = peer_manager.clone();
        tokio::spawn(async move {
            peer::start_peer_sync(pm, peer_node).await;
        });
    }

    eprintln!("[core-daemon] building API router...");
    let api_router = build_http_router(app_state.clone());
    eprintln!("[core-daemon] binding API server...");
    let api_server = hyper::Server::bind(&api_addr)
        .serve(api_router.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        });
    eprintln!("[core-daemon] API server ready");

    if node.is_mining() {
        let miner = node.clone();
        let broadcast_pm = peer_manager.clone();
        tokio::spawn(async move {
            loop {
                if let Ok(Some(block)) = miner.mine_pending() {
                    eprintln!("[miner] Mined block {}", block.header.height);
                    // Broadcast to peers
                    let peers = broadcast_pm.get_peers().await;
                    if !peers.is_empty() {
                        peer::broadcast_block(&peers, &block).await;
                    }
                }
                sleep(Duration::from_millis(1000)).await;
            }
        });
    }

    eprintln!("[core-daemon] starting servers...");
    tokio::select! {
        result = grpc_server => {
            eprintln!("[core-daemon] gRPC server exited: {:?}", result);
        },
        result = api_server => {
            eprintln!("[core-daemon] API server exited: {:?}", result);
        },
        _ = tokio::signal::ctrl_c() => {
            eprintln!("[core-daemon] received Ctrl+C");
        },
    }
    eprintln!("[core-daemon] shutting down");

    Ok(())
}

fn build_http_router(state: AppState) -> Router {
    Router::new()
        .route("/api/stats", get(get_stats))
        .route("/api/health", get(get_health))
        .route("/api/blocks", get(get_blocks))
        .route("/api/blocks/import", post(import_block))
        .route("/api/txs", get(get_txs))
        .route("/api/blocks/summary", get(get_blocks_summary))
        .route("/api/balance/:public_key", get(get_balance))
        .route("/api/wallet/create", post(create_wallet))
        .route("/api/tx/submit", post(submit_tx))
        .route("/api/tx/broadcast", post(receive_broadcast_tx))
        .route("/api/token/create", post(create_token))
        .route("/api/stake/submit", post(submit_stake))
        .route("/api/unstake/submit", post(submit_unstake))
        .route("/api/faucet", post(faucet))
        .route("/api/validators", get(get_validators))
        .route("/api/selection", get(get_selection))
        .route("/api/finality", get(get_finality))
        .route("/api/votes", get(get_votes))
        .route("/api/validators/stats", get(get_vote_stats))
        .route("/api/votes/submit", post(submit_vote))
        .route("/api/entropy/submit", post(submit_entropy))
        .route("/api/messenger/wallets", get(get_messenger_wallets))
        .route("/api/messenger/wallets/register", post(register_messenger_wallet))
        .route("/api/messenger/conversations", get(get_messenger_conversations))
        .route("/api/messenger/conversations", post(create_messenger_conversation))
        .route("/api/messenger/messages", get(get_messenger_messages))
        .route("/api/messenger/messages", post(send_messenger_message))
        .route("/api/messenger/messages/read", post(mark_messenger_read))
        .route("/api/peers", get(get_peers))
        .route("/api/peers/register", post(register_peer))
        .layer(middleware::from_fn_with_state(state.clone(), auth_middleware))
        .layer(
            CorsLayer::new()
                .allow_methods(Any)
                .allow_origin(Any)
                .allow_headers(Any),
        )
        .with_state(state)
}

async fn auth_middleware<B>(
    State(state): State<AppState>,
    request: Request<B>,
    next: Next<B>,
) -> Result<Response, StatusCode> {
    if request.method() == Method::OPTIONS {
        return Ok(next.run(request).await);
    }
    let path = request.uri().path();
    if path == "/api/health" || path == "/api/stats" {
        return Ok(next.run(request).await);
    }
    if path == "/api/faucet" || path == "/api/tx/submit" || path == "/api/stake/submit" || path == "/api/unstake/submit" || path == "/api/token/create" {
        return Ok(next.run(request).await);
    }
    // Bypass rate limiting for messenger endpoints
    if path.starts_with("/api/messenger/") {
        return Ok(next.run(request).await);
    }

    if state.auth.is_enabled() {
        let api_key = extract_api_key(request.headers());
        if !state.auth.is_valid(api_key.as_deref()) {
            return Err(StatusCode::UNAUTHORIZED);
        }
    }

    let client_key = client_key(&request);
    
    // Determine rate limit tier
    let limit = determine_rate_limit_tier(&state, &request).await;
    
    // 0 = unlimited (skip rate limiting)
    if limit > 0 {
        let mut limiter = state.limiter.lock().await;
        if !limiter.allow(&client_key, limit) {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
    }

    Ok(next.run(request).await)
}

/// Determine rate limit based on caller tier:
/// - Tier 1 (validator_limit): Active staked validators (X-Validator-Key header)
/// - Tier 2 (peer_limit): Registered peers
/// - Tier 3 (read/write_limit): Unknown clients
async fn determine_rate_limit_tier<B>(state: &AppState, request: &Request<B>) -> u32 {
    // Check for validator header (Tier 1)
    if let Some(validator_key) = request.headers().get("x-validator-key") {
        if let Ok(key_str) = validator_key.to_str() {
            // Verify this is an active staked validator
            if is_active_validator(&state.node, key_str) {
                return state.validator_limit; // Tier 1
            }
        }
    }
    
    // Check if client IP is a registered peer (Tier 2)
    let client_ip = client_key(request);
    if state.peer_manager.is_known_peer_ip(&client_ip).await {
        return state.peer_limit; // Tier 2
    }
    
    // Default: Tier 3
    match request.method() {
        &Method::GET => state.read_limit,
        _ => state.write_limit,
    }
}

/// Check if a public key is an active staked validator
fn is_active_validator(node: &Arc<L1Node>, public_key: &str) -> bool {
    if let Ok(validators) = node.list_validators() {
        for (pk, validator_state) in validators {
            if pk == public_key && validator_state.stake > 0 {
                return true;
            }
        }
    }
    false
}

fn extract_api_key(headers: &HeaderMap) -> Option<String> {
    if let Some(value) = headers.get("x-api-key") {
        if let Ok(value) = value.to_str() {
            return Some(value.to_string());
        }
    }
    if let Some(value) = headers.get("authorization") {
        if let Ok(value) = value.to_str() {
            let trimmed = value.trim();
            if let Some(token) = trimmed.strip_prefix("Bearer ") {
                return Some(token.to_string());
            }
        }
    }
    None
}

fn client_key<B>(request: &Request<B>) -> String {
    if let Some(value) = request.headers().get("x-forwarded-for") {
        if let Ok(value) = value.to_str() {
            if let Some(first) = value.split(',').next() {
                let trimmed = first.trim();
                if !trimmed.is_empty() {
                    return trimmed.to_string();
                }
            }
        }
    }
    if let Some(value) = request.headers().get("x-real-ip") {
        if let Ok(value) = value.to_str() {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    if let Some(info) = request.extensions().get::<axum::extract::ConnectInfo<SocketAddr>>() {
        return info.0.ip().to_string();
    }
    "unknown".to_string()
}

#[derive(Serialize)]
struct StatsResponse {
    connected_peers: u32,
    network_height: u64,
    is_mining: bool,
    node_id: String,
    total_fees_collected: f64,
    fees_in_last_block: f64,
    chain_id: String,
    finalized_height: u64,
}

async fn get_stats(State(state): State<AppState>) -> Result<Json<StatsResponse>, StatusCode> {
    let node = &state.node;
    let height = node.get_tip_height().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let (total_fees, last_fees) = node.get_fee_stats().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let (finalized, _, _, _) = node.get_finality_status().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let peer_count = state.peer_manager.peer_count().await as u32;
    Ok(Json(StatsResponse {
        connected_peers: peer_count,
        network_height: height,
        is_mining: node.is_mining(),
        node_id: node.node_id(),
        total_fees_collected: total_fees,
        fees_in_last_block: last_fees,
        chain_id: node.chain_id(),
        finalized_height: finalized,
    }))
}


#[derive(Serialize)]
struct HealthResponse {
    status: String,
    chain_id: String,
    height: u64,
}

async fn get_health(State(state): State<AppState>) -> Result<Json<HealthResponse>, StatusCode> {
    let node = &state.node;
    let height = node.get_tip_height().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(HealthResponse {
        status: "ok".to_string(),
        chain_id: node.chain_id(),
        height,
    }))
}

#[derive(Deserialize)]
struct BlocksQuery {
    limit: Option<usize>,
}

#[derive(Serialize)]
struct BlocksResponse {
    blocks: Vec<quantum_vault_types::BlockV1>,
}

async fn get_blocks(
    State(state): State<AppState>,
    Query(query): Query<BlocksQuery>,
) -> Result<Json<BlocksResponse>, StatusCode> {
    let node = &state.node;
    let blocks = if let Some(limit) = query.limit {
        node.get_recent_blocks(limit).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    } else {
        node.get_all_blocks().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    };
    Ok(Json(BlocksResponse { blocks }))
}

#[derive(Serialize)]
struct ImportBlockResponse {
    success: bool,
    error: Option<String>,
}

async fn import_block(
    State(state): State<AppState>,
    Json(block): Json<quantum_vault_types::BlockV1>,
) -> Result<Json<ImportBlockResponse>, StatusCode> {
    let node = &state.node;
    match node.import_block(block) {
        Ok(()) => Ok(Json(ImportBlockResponse { success: true, error: None })),
        Err(e) => Ok(Json(ImportBlockResponse { success: false, error: Some(e) })),
    }
}

#[derive(Deserialize)]
struct TxsQuery {
    limit: Option<usize>,
    offset: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TxItem {
    tx_id: String,
    block_height: u64,
    block_hash: String,
    block_time: u64,
    tx: quantum_vault_types::TxV1,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TxsResponse {
    txs: Vec<TxItem>,
    total: usize,
}

async fn get_txs(
    State(state): State<AppState>,
    Query(query): Query<TxsQuery>,
) -> Result<Json<TxsResponse>, StatusCode> {
    let node = &state.node;
    let blocks = node.get_all_blocks().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut items = Vec::new();
    for block in blocks {
        for tx in block.txs.iter() {
            let tx_id = quantum_vault_crypto::bytes_to_hex(&quantum_vault_crypto::sha256(&quantum_vault_types::encode_tx_v1(tx)));
            items.push(TxItem {
                tx_id,
                block_height: block.header.height,
                block_hash: block.hash.clone(),
                block_time: block.header.time,
                tx: tx.clone(),
            });
        }
    }
    items.sort_by(|a, b| b.block_time.cmp(&a.block_time).then_with(|| b.block_height.cmp(&a.block_height)));
    let total = items.len();
    let limit = query.limit.unwrap_or(200).min(1000);
    let offset = query.offset.unwrap_or(0);
    let paged = items.into_iter().skip(offset).take(limit).collect();
    Ok(Json(TxsResponse { txs: paged, total }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BlocksSummaryResponse {
    success: bool,
    range: String,
    interval_ms: u64,
    start_time: u64,
    end_time: u64,
    points: Vec<BlocksSummaryPoint>,
}

#[derive(Serialize)]
struct BlocksSummaryPoint {
    timestamp: u64,
    blocks: u64,
    transactions: u64,
}

async fn get_blocks_summary(
    State(state): State<AppState>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<BlocksSummaryResponse>, StatusCode> {
    let node = &state.node;
    let range = query.get("range").map(|s| s.as_str()).unwrap_or("24h");
    let range = if range == "1h" || range == "7d" { range } else { "24h" };
    let (interval_ms, range_ms) = match range {
        "1h" => (5 * 60 * 1000, 60 * 60 * 1000),
        "7d" => (24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000),
        _ => (60 * 60 * 1000, 24 * 60 * 60 * 1000),
    };
    let now = chrono::Utc::now().timestamp_millis() as u64;
    let start_time = now.saturating_sub(range_ms);
    let blocks = node.get_all_blocks().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut buckets: std::collections::BTreeMap<u64, (u64, u64)> = std::collections::BTreeMap::new();
    let mut t = start_time;
    while t <= now {
        let bucket_key = (t / interval_ms) * interval_ms;
        buckets.entry(bucket_key).or_insert((0, 0));
        t += interval_ms;
    }
    for block in blocks {
        if block.header.time < start_time {
            continue;
        }
        let bucket_key = (block.header.time / interval_ms) * interval_ms;
        let entry = buckets.entry(bucket_key).or_insert((0, 0));
        entry.0 += 1;
        entry.1 += block.txs.len() as u64;
    }
    let points = buckets
        .into_iter()
        .map(|(timestamp, (blocks, transactions))| BlocksSummaryPoint { timestamp, blocks, transactions })
        .collect();
    Ok(Json(BlocksSummaryResponse {
        success: true,
        range: range.to_string(),
        interval_ms,
        start_time,
        end_time: now,
        points,
    }))
}

#[derive(Serialize)]
struct BalanceResponse {
    success: bool,
    balance: f64,
}

async fn get_balance(
    State(state): State<AppState>,
    Path(public_key): Path<String>,
) -> Result<Json<BalanceResponse>, StatusCode> {
    let node = &state.node;
    let balance = node.get_balance(&public_key).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(BalanceResponse { success: true, balance }))
}

#[derive(Serialize)]
struct WalletResponse {
    success: bool,
    public_key: String,
    private_key: String,
    algorithm: String,
}

async fn create_wallet(State(state): State<AppState>) -> Result<Json<WalletResponse>, StatusCode> {
    let node = &state.node;
    let wallet = node.create_wallet();
    Ok(Json(WalletResponse {
        success: true,
        public_key: wallet.public_key_hex,
        private_key: wallet.secret_key_hex,
        algorithm: wallet.algorithm,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubmitTxRequest {
    from_private_key: String,
    from_public_key: String,
    to_public_key: String,
    amount: f64,
    fee: Option<f64>,
    token_symbol: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TxResponse {
    success: bool,
    tx_id: Option<String>,
    tx: Option<quantum_vault_types::TxV1>,
    error: Option<String>,
}

async fn submit_tx(
    State(state): State<AppState>,
    Json(body): Json<SubmitTxRequest>,
) -> Result<Json<TxResponse>, StatusCode> {
    let node = &state.node;
    match node.submit_user_tx(
        &body.from_private_key,
        &body.from_public_key,
        &body.to_public_key,
        body.amount,
        body.fee,
        body.token_symbol.as_deref(),
    ) {
        Ok(tx) => {
            let id = quantum_vault_crypto::bytes_to_hex(&quantum_vault_crypto::sha256(&quantum_vault_types::encode_tx_v1(&tx)));
            // Broadcast tx to peers
            let peers = state.peer_manager.get_peers().await;
            if !peers.is_empty() {
                peer::broadcast_tx(&peers, &tx);
            }
            Ok(Json(TxResponse { success: true, tx_id: Some(id), tx: Some(tx), error: None }))
        }
        Err(err) => Ok(Json(TxResponse { success: false, tx_id: None, tx: None, error: Some(err) })),
    }
}

#[derive(Serialize)]
struct BroadcastTxResponse {
    success: bool,
    error: Option<String>,
}

/// Receive a transaction broadcast from a peer
async fn receive_broadcast_tx(
    State(state): State<AppState>,
    Json(tx): Json<quantum_vault_types::TxV1>,
) -> Result<Json<BroadcastTxResponse>, StatusCode> {
    let node = &state.node;
    match node.add_tx_to_mempool(tx) {
        Ok(()) => Ok(Json(BroadcastTxResponse { success: true, error: None })),
        Err(e) => Ok(Json(BroadcastTxResponse { success: false, error: Some(e) })),
    }
}

#[derive(Serialize)]
struct PeersResponse {
    peers: Vec<String>,
    count: usize,
}

async fn get_peers(State(state): State<AppState>) -> Result<Json<PeersResponse>, StatusCode> {
    let peers = state.peer_manager.get_peers().await;
    let count = peers.len();
    Ok(Json(PeersResponse { peers, count }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterPeerRequest {
    peer_url: String,
}

#[derive(Serialize)]
struct RegisterPeerResponse {
    success: bool,
    message: String,
}

async fn register_peer(
    State(state): State<AppState>,
    Json(body): Json<RegisterPeerRequest>,
) -> Result<Json<RegisterPeerResponse>, StatusCode> {
    let added = state.peer_manager.add_peer(body.peer_url.clone()).await;
    if added {
        eprintln!("[peer] New peer registered: {}", body.peer_url);
        Ok(Json(RegisterPeerResponse {
            success: true,
            message: "Peer registered".to_string(),
        }))
    } else {
        Ok(Json(RegisterPeerResponse {
            success: true,
            message: "Peer already known".to_string(),
        }))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTokenRequest {
    from_private_key: String,
    from_public_key: String,
    token_name: String,
    token_symbol: String,
    total_supply: u64,
    decimals: Option<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateTokenResponse {
    success: bool,
    tx_id: Option<String>,
    token_address: Option<String>,
    error: Option<String>,
}

async fn create_token(
    State(state): State<AppState>,
    Json(body): Json<CreateTokenRequest>,
) -> Result<Json<CreateTokenResponse>, StatusCode> {
    let node = &state.node;
    match node.submit_create_token_tx(
        &body.from_private_key,
        &body.from_public_key,
        &body.token_name,
        &body.token_symbol,
        body.total_supply,
        body.decimals.unwrap_or(18),
    ) {
        Ok((tx, token_address)) => {
            let id = quantum_vault_crypto::bytes_to_hex(&quantum_vault_crypto::sha256(&quantum_vault_types::encode_tx_v1(&tx)));
            Ok(Json(CreateTokenResponse { 
                success: true, 
                tx_id: Some(id), 
                token_address: Some(token_address),
                error: None 
            }))
        }
        Err(err) => Ok(Json(CreateTokenResponse { 
            success: false, 
            tx_id: None, 
            token_address: None,
            error: Some(err) 
        })),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StakeRequest {
    from_private_key: String,
    from_public_key: String,
    amount: f64,
    fee: Option<f64>,
}

async fn submit_stake(
    State(state): State<AppState>,
    Json(body): Json<StakeRequest>,
) -> Result<Json<TxResponse>, StatusCode> {
    let node = &state.node;
    match node.submit_stake_tx(&body.from_private_key, &body.from_public_key, body.amount, body.fee) {
        Ok(tx) => {
            let id = quantum_vault_crypto::bytes_to_hex(&quantum_vault_crypto::sha256(&quantum_vault_types::encode_tx_v1(&tx)));
            Ok(Json(TxResponse { success: true, tx_id: Some(id), tx: Some(tx), error: None }))
        }
        Err(err) => Ok(Json(TxResponse { success: false, tx_id: None, tx: None, error: Some(err) })),
    }
}

async fn submit_unstake(
    State(state): State<AppState>,
    Json(body): Json<StakeRequest>,
) -> Result<Json<TxResponse>, StatusCode> {
    let node = &state.node;
    match node.submit_unstake_tx(&body.from_private_key, &body.from_public_key, body.amount, body.fee) {
        Ok(tx) => {
            let id = quantum_vault_crypto::bytes_to_hex(&quantum_vault_crypto::sha256(&quantum_vault_types::encode_tx_v1(&tx)));
            Ok(Json(TxResponse { success: true, tx_id: Some(id), tx: Some(tx), error: None }))
        }
        Err(err) => Ok(Json(TxResponse { success: false, tx_id: None, tx: None, error: Some(err) })),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FaucetRequest {
    recipient_public_key: String,
    amount: Option<u64>,
}

async fn faucet(
    State(state): State<AppState>,
    Json(body): Json<FaucetRequest>,
) -> Result<Json<TxResponse>, StatusCode> {
    let node = &state.node;
    if !state.faucet_whitelist.is_empty() {
        let recipient = normalize_recipient(&body.recipient_public_key);
        if !state.faucet_whitelist.iter().any(|item| item == &recipient) {
            return Err(StatusCode::FORBIDDEN);
        }
    }
    match node.submit_faucet_tx(&body.recipient_public_key, body.amount.unwrap_or(10000)) {
        Ok(tx) => {
            let id = quantum_vault_crypto::bytes_to_hex(&quantum_vault_crypto::sha256(&quantum_vault_types::encode_tx_v1(&tx)));
            Ok(Json(TxResponse { success: true, tx_id: Some(id), tx: Some(tx), error: None }))
        }
        Err(err) => Ok(Json(TxResponse { success: false, tx_id: None, tx: None, error: Some(err) })),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ValidatorsResponse {
    success: bool,
    validators: Vec<ValidatorInfo>,
    total_stake: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ValidatorInfo {
    public_key: String,
    stake: String,
    status: String,
    slash_count: u32,
    jailed_until: u64,
    entropy_contributions: u64,
}

async fn get_validators(State(state): State<AppState>) -> Result<Json<ValidatorsResponse>, StatusCode> {
    let node = &state.node;
    let (validators, total) = node.get_validator_set().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let tip = node.get_tip_height().unwrap_or(0);
    let mapped = validators.into_iter().map(|(public_key, state)| {
        let status = if state.jailed_until > tip {
            "jailed"
        } else if state.stake > 0 {
            "active"
        } else {
            "inactive"
        };
        ValidatorInfo {
            public_key: public_key,
            stake: state.stake.to_string(),
            status: status.to_string(),
            slash_count: state.slash_count,
            jailed_until: state.jailed_until,
            entropy_contributions: state.entropy_contributions,
        }
    }).collect();
    Ok(Json(ValidatorsResponse {
        success: true,
        validators: mapped,
        total_stake: total.to_string(),
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectionResponse {
    success: bool,
    height: u64,
    proposer: Option<String>,
    total_stake: Option<String>,
    selection_weight: Option<String>,
    entropy_source: Option<String>,
    entropy_hex: Option<String>,
}

async fn get_selection(State(state): State<AppState>) -> Result<Json<SelectionResponse>, StatusCode> {
    let node = &state.node;
    let height = node.get_tip_height().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)? + 1;
    let selection = node.get_selection_info().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(SelectionResponse {
        success: true,
        height,
        proposer: selection.as_ref().map(|s| s.proposer_pub_key.clone()),
        total_stake: selection.as_ref().map(|s| s.total_stake.to_string()),
        selection_weight: selection.as_ref().map(|s| s.selection_weight.to_string()),
        entropy_source: selection.as_ref().map(|s| s.entropy_source.clone()),
        entropy_hex: selection.as_ref().map(|s| s.entropy_hex.clone()),
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FinalityResponse {
    success: bool,
    finalized_height: u64,
    tip_height: u64,
    total_stake: String,
    quorum_stake: String,
}

async fn get_finality(State(state): State<AppState>) -> Result<Json<FinalityResponse>, StatusCode> {
    let node = &state.node;
    let (finalized, tip, total, quorum) = node.get_finality_status().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(FinalityResponse {
        success: true,
        finalized_height: finalized,
        tip_height: tip,
        total_stake: total.to_string(),
        quorum_stake: quorum.to_string(),
    }))
}

#[derive(Deserialize)]
struct VotesQuery {
    height: Option<u64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct VoteBucket {
    block_hash: String,
    voters: u32,
    stake: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VotesResponse {
    success: bool,
    height: u64,
    total_stake: String,
    quorum_stake: String,
    prevote: Vec<VoteBucket>,
    precommit: Vec<VoteBucket>,
}

async fn get_votes(
    State(state): State<AppState>,
    Query(query): Query<VotesQuery>,
) -> Result<Json<VotesResponse>, StatusCode> {
    let node = &state.node;
    let height = query.height.unwrap_or(node.get_tip_height().unwrap_or(0));
    let (total, quorum, votes) = node.get_vote_summary(height).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut buckets: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    for vote in votes {
        *buckets.entry(vote.block_hash).or_insert(0) += 1;
    }
    let mapped: Vec<VoteBucket> = buckets.into_iter().map(|(hash, voters)| VoteBucket {
        block_hash: hash,
        voters,
        stake: voters.to_string(),
    }).collect();
    Ok(Json(VotesResponse {
        success: true,
        height,
        total_stake: total.to_string(),
        quorum_stake: quorum.to_string(),
        prevote: mapped.clone(),
        precommit: mapped,
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VoteStatsResponse {
    success: bool,
    total_heights: u32,
    validators: Vec<ValidatorVoteStat>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ValidatorVoteStat {
    public_key: String,
    prevote_participation: f64,
    precommit_participation: f64,
    last_seen_height: u64,
}

async fn get_vote_stats(State(state): State<AppState>) -> Result<Json<VoteStatsResponse>, StatusCode> {
    let node = &state.node;
    let stats = node.get_vote_stats().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(VoteStatsResponse {
        success: true,
        total_heights: stats.len() as u32,
        validators: stats.into_iter().map(|(public_key, prevote, precommit, last)| ValidatorVoteStat {
            public_key: public_key,
            prevote_participation: prevote,
            precommit_participation: precommit,
            last_seen_height: last,
        }).collect(),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubmitVoteRequest {
    r#type: String,
    height: u64,
    round: u32,
    block_hash: String,
    voter_pub_key: String,
    signature: String,
}

async fn submit_vote(
    State(state): State<AppState>,
    Json(body): Json<SubmitVoteRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let node = &state.node;
    node.submit_vote(quantum_vault_types::VoteMessage {
        vote_type: body.r#type,
        height: body.height,
        round: body.round,
        block_hash: body.block_hash,
        voter_pub_key: body.voter_pub_key,
        signature: body.signature,
    }).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntropyRequest {
    public_key: String,
}

async fn submit_entropy(
    State(state): State<AppState>,
    Json(body): Json<EntropyRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let node = &state.node;
    node.submit_entropy(&body.public_key).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

async fn get_messenger_wallets(State(state): State<AppState>) -> Result<Json<serde_json::Value>, StatusCode> {
    let node = &state.node;
    let wallets = node.list_wallets().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "success": true, "wallets": wallets })))
}

async fn register_messenger_wallet(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let node = &state.node;
    let wallet = quantum_vault_storage::messenger_store::MessengerWallet {
        id: body.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        display_name: body.get("displayName").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        signing_public_key: body.get("signingPublicKey").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        encryption_public_key: body.get("encryptionPublicKey").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    let wallet = node.register_wallet(wallet).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "success": true, "wallet": wallet })))
}

async fn get_messenger_conversations(
    State(state): State<AppState>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let node = &state.node;
    let wallet_id = query.get("walletId").cloned().unwrap_or_default();
    let conversations = node.list_conversations(&wallet_id).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "success": true, "conversations": conversations })))
}

async fn create_messenger_conversation(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let node = &state.node;
    let created_by = body.get("createdBy").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let participant_ids = body.get("participantIds")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    let name = body.get("name").and_then(|v| v.as_str()).map(|s| s.to_string());
    let is_group = body.get("isGroup").and_then(|v| v.as_bool()).unwrap_or(false);
    let conversation = node.create_conversation(&created_by, participant_ids, name, is_group)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "success": true, "conversation": conversation })))
}

async fn get_messenger_messages(
    State(state): State<AppState>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let node = &state.node;
    let conversation_id = query.get("conversationId").cloned().unwrap_or_default();
    let messages = node.list_messages(&conversation_id).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "success": true, "messages": messages })))
}

async fn send_messenger_message(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let node = &state.node;
    let message = quantum_vault_storage::messenger_store::MessengerMessage {
        id: uuid::Uuid::new_v4().to_string(),
        conversation_id: body.get("conversationId").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        sender_wallet_id: body.get("senderWalletId").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        encrypted_content: body.get("encryptedContent").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        signature: body.get("signature").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        self_destruct: body.get("selfDestruct").and_then(|v| v.as_bool()).unwrap_or(false),
        destruct_after_seconds: body.get("destructAfterSeconds").and_then(|v| v.as_u64()),
        created_at: chrono::Utc::now().to_rfc3339(),
        is_read: false,
    };
    let message = node.send_message(message).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "success": true, "message": message })))
}

async fn mark_messenger_read(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let node = &state.node;
    let message_id = body.get("messageId").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let message = node.mark_message_read(&message_id).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "success": true, "message": message })))
}

fn default_data_dir(node_name: &str) -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".quantum-vault").join(node_name)
}
