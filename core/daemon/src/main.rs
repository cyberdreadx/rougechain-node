mod amm;
mod grpc;
mod nft_store;
mod pool_events;
mod node;
mod peer;
mod pool_store;
mod websocket;

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration as StdDuration, Instant};

use axum::extract::{Path, Query, State};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, Method, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use clap::Parser;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::time::{sleep, Duration};
use tower_http::cors::{Any, CorsLayer};

use crate::websocket::WsBroadcaster;

use quantum_vault_storage::bridge_claim_store::BridgeClaimStore;
use quantum_vault_storage::bridge_withdraw_store::BridgeWithdrawStore;

use crate::grpc::GrpcNode;
use crate::node::{L1Node, NodeOptions};
use crate::pool_store::LiquidityPool;
use crate::pool_events::{PoolEvent, PoolStats, PriceSnapshot};
use quantum_vault_types::ChainConfig;

#[derive(Parser, Debug)]
#[command(author, version, about)]
struct Args {
    #[arg(long, default_value = "127.0.0.1")]
    host: String,
    #[arg(long, default_value_t = 4101)]
    port: u16,
    #[arg(long, default_value_t = 5101)]
    api_port: u16,
    #[arg(long, default_value = "rougechain-devnet-1")]
    chain_id: String,
    #[arg(long, default_value_t = 400)]
    block_time_ms: u64,
    #[arg(long)]
    mine: bool,
    #[arg(long)]
    data_dir: Option<String>,
    #[arg(long, env = "QV_API_KEYS")]
    api_keys: Option<String>,
    /// Rate limit per minute (0 = unlimited, recommended for public testnets)
    #[arg(long, default_value_t = 0)]
    rate_limit_per_minute: u32,
    /// Rate limit for read operations (0 = unlimited)
    #[arg(long, default_value_t = 0)]
    rate_limit_read_per_minute: u32,
    /// Rate limit for write operations (0 = unlimited)
    #[arg(long, default_value_t = 0)]
    rate_limit_write_per_minute: u32,
    /// Rate limit for validators (Tier 1) - 0 = unlimited
    #[arg(long, default_value_t = 0)]
    rate_limit_validator: u32,
    /// Rate limit for registered peers (Tier 2) - 0 = unlimited
    #[arg(long, default_value_t = 0)]
    rate_limit_peer: u32,
    #[arg(long, env = "QV_FAUCET_WHITELIST")]
    faucet_whitelist: Option<String>,
    /// Comma-separated list of peer URLs to connect to (e.g., "http://node1.example.com:5100,http://node2.example.com:5100")
    #[arg(long, env = "QV_PEERS")]
    peers: Option<String>,
    /// Public URL of this node for peer discovery (e.g., "https://mynode.example.com")
    #[arg(long, env = "QV_PUBLIC_URL")]
    public_url: Option<String>,
    /// Bridge: custody address that receives Base Sepolia ETH (enables bridge when set)
    #[arg(long, env = "QV_BRIDGE_CUSTODY_ADDRESS")]
    bridge_custody_address: Option<String>,
    /// Bridge: Base Sepolia RPC URL (default: https://sepolia.base.org)
    #[arg(long, env = "QV_BASE_SEPOLIA_RPC", default_value = "https://sepolia.base.org")]
    base_sepolia_rpc: String,
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
    ws_broadcaster: Arc<WsBroadcaster>,
    bridge_custody_address: Option<String>,
    base_sepolia_rpc: String,
    bridge_claim_store: Arc<BridgeClaimStore>,
    bridge_withdraw_store: std::sync::Arc<BridgeWithdrawStore>,
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
    let data_dir_clone = data_dir.clone();
    let bridge_withdraw_store = std::sync::Arc::new(
        BridgeWithdrawStore::new(&data_dir_clone).map_err(|e| format!("bridge withdraw store: {}", e))?
    );
    let node = Arc::new(L1Node::new(NodeOptions {
        data_dir,
        chain,
        mine: args.mine,
        bridge_withdraw_store: Some(bridge_withdraw_store.clone()),
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
    let ws_broadcaster = Arc::new(WsBroadcaster::new());
    
    let bridge_claim_store = Arc::new(
        BridgeClaimStore::new(&data_dir_clone).map_err(|e| format!("bridge store: {}", e))?
    );
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
        ws_broadcaster: ws_broadcaster.clone(),
        bridge_custody_address: args.bridge_custody_address.clone(),
        base_sepolia_rpc: args.base_sepolia_rpc.clone(),
        bridge_claim_store,
        bridge_withdraw_store,
    };
    
    eprintln!("[core-daemon] WebSocket broadcaster initialized");

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
        let ws_bc = ws_broadcaster.clone();
        tokio::spawn(async move {
            loop {
                if let Ok(Some(block)) = miner.mine_pending() {
                    eprintln!("[miner] Mined block {}", block.header.height);
                    
                    // Broadcast to WebSocket clients
                    ws_bc.broadcast_new_block(&block);
                    
                    // Broadcast to P2P peers
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
        .route("/api/ws", get(ws_handler))
        .route("/api/stats", get(get_stats))
        .route("/api/burn-address", get(get_burn_address))
        .route("/api/burned", get(get_burned_tokens))
        .route("/api/price/xrge", get(get_xrge_price))
        // Token metadata endpoints
        .route("/api/tokens", get(get_all_tokens))
        .route("/api/token/:symbol/metadata", get(get_token_metadata))
        .route("/api/token/:symbol/holders", get(get_token_holders))
        .route("/api/token/:symbol/transactions", get(get_token_transactions))
        .route("/api/token/metadata/update", post(update_token_metadata))
        .route("/api/token/metadata/claim", post(claim_token_metadata))
        .route("/api/health", get(get_health))
        .route("/api/blocks", get(get_blocks))
        .route("/api/blocks/import", post(import_block))
        .route("/api/block/:height", get(get_block_by_height))
        .route("/api/txs", get(get_txs))
        .route("/api/tx/:hash", get(get_tx_by_hash))
        .route("/api/address/:public_key/transactions", get(get_address_transactions))
        .route("/api/blocks/summary", get(get_blocks_summary))
        .route("/api/balance/:public_key", get(get_balance))
        .route("/api/balance/:public_key/:token_symbol", get(get_token_balance))
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
        .route("/api/messenger/conversations/:id", delete(delete_messenger_conversation))
        .route("/api/messenger/messages", get(get_messenger_messages))
        .route("/api/messenger/messages", post(send_messenger_message))
        .route("/api/messenger/messages/read", post(mark_messenger_read))
        // Name registry
        .route("/api/names/register", post(register_name))
        .route("/api/names/resolve/:name", get(resolve_name))
        .route("/api/names/reverse/:walletId", get(reverse_lookup_name))
        .route("/api/names/release", delete(release_name))
        // Mail
        .route("/api/mail/send", post(send_mail))
        .route("/api/mail/inbox", get(get_mail_inbox))
        .route("/api/mail/sent", get(get_mail_sent))
        .route("/api/mail/trash", get(get_mail_trash))
        .route("/api/mail/message/:id", get(get_mail_message))
        .route("/api/mail/move", post(move_mail))
        .route("/api/mail/read", post(mark_mail_read))
        .route("/api/mail/:id", delete(delete_mail))
        .route("/api/peers", get(get_peers))
        .route("/api/peers/register", post(register_peer))
        // AMM/DEX endpoints
        .route("/api/pools", get(get_pools))
        .route("/api/pool/:pool_id", get(get_pool))
        .route("/api/pool/:pool_id/events", get(get_pool_events))
        .route("/api/pool/:pool_id/prices", get(get_pool_price_history))
        .route("/api/pool/:pool_id/stats", get(get_pool_stats))
        .route("/api/pool/create", post(create_pool))
        .route("/api/pool/add-liquidity", post(add_liquidity))
        .route("/api/pool/remove-liquidity", post(remove_liquidity))
        .route("/api/swap/quote", post(get_swap_quote))
        .route("/api/swap/execute", post(execute_swap))
        .route("/api/events", get(get_all_events))
        // Secure v2 endpoints (client-side signing)
        .route("/api/v2/transfer", post(v2_transfer))
        .route("/api/v2/token/create", post(v2_create_token))
        .route("/api/v2/pool/create", post(v2_create_pool))
        .route("/api/v2/pool/add-liquidity", post(v2_add_liquidity))
        .route("/api/v2/pool/remove-liquidity", post(v2_remove_liquidity))
        .route("/api/v2/swap/execute", post(v2_execute_swap))
        .route("/api/v2/stake", post(v2_stake))
        .route("/api/v2/unstake", post(v2_unstake))
        .route("/api/v2/faucet", post(v2_faucet))
        // NFT V2 write endpoints
        .route("/api/v2/nft/collection/create", post(v2_nft_create_collection))
        .route("/api/v2/nft/mint", post(v2_nft_mint))
        .route("/api/v2/nft/batch-mint", post(v2_nft_batch_mint))
        .route("/api/v2/nft/transfer", post(v2_nft_transfer))
        .route("/api/v2/nft/burn", post(v2_nft_burn))
        .route("/api/v2/nft/lock", post(v2_nft_lock))
        .route("/api/v2/nft/freeze-collection", post(v2_nft_freeze_collection))
        // NFT read-only endpoints
        .route("/api/nft/collections", get(nft_list_collections))
        .route("/api/nft/collection/:id", get(nft_get_collection))
        .route("/api/nft/collection/:id/tokens", get(nft_get_collection_tokens))
        .route("/api/nft/token/:collection_id/:token_id", get(nft_get_token))
        .route("/api/nft/owner/:pubkey", get(nft_get_owner_nfts))
        .route("/api/bridge/config", get(bridge_config))
        .route("/api/bridge/claim", post(bridge_claim))
        .route("/api/bridge/withdraw", post(bridge_withdraw))
        .route("/api/bridge/withdrawals", get(bridge_withdrawals))
        .route("/api/bridge/withdrawals/:tx_id", delete(bridge_withdrawal_fulfill))
        .layer(middleware::from_fn_with_state(state.clone(), auth_middleware))
        .layer(
            CorsLayer::new()
                .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE, Method::OPTIONS, Method::PATCH])
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
    if path == "/api/faucet" || path == "/api/tx/submit" || path == "/api/stake/submit" || path == "/api/unstake/submit" || path == "/api/token/create" || path == "/api/bridge/claim" || path == "/api/bridge/config" || path == "/api/bridge/withdraw" || path == "/api/bridge/withdrawals" || path.starts_with("/api/bridge/withdrawals/") {
        return Ok(next.run(request).await);
    }
    // Bypass rate limiting for secure v2 endpoints
    if path.starts_with("/api/v2/") {
        return Ok(next.run(request).await);
    }
    // Bypass rate limiting for messenger, mail, and name endpoints
    if path.starts_with("/api/messenger/") || path.starts_with("/api/mail/") || path.starts_with("/api/names/") {
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

// WebSocket handler for real-time updates
async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws_connection(socket, state))
}

async fn handle_ws_connection(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let broadcaster = state.ws_broadcaster.clone();
    
    // Track connection
    broadcaster.client_connected().await;
    
    // Subscribe to broadcast channel
    let mut rx = broadcaster.subscribe();
    
    // Send initial stats
    let height = state.node.get_tip_height().unwrap_or(0);
    let peer_count = state.peer_manager.peer_count().await;
    let mempool_size = 0; // TODO: expose mempool size
    broadcaster.broadcast_stats(height, peer_count, mempool_size);
    
    // Spawn task to forward broadcasts to this client
    let send_task = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            if sender.send(Message::Text(msg)).await.is_err() {
                break;
            }
        }
    });
    
    // Handle incoming messages (ping/pong, close)
    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(Message::Ping(_)) => {
                // Pong is handled automatically by axum
            }
            Ok(Message::Close(_)) => break,
            Err(_) => break,
            _ => {}
        }
    }
    
    // Client disconnected
    broadcaster.client_disconnected().await;
    send_task.abort();
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
    ws_clients: usize,
}

async fn get_stats(State(state): State<AppState>) -> Result<Json<StatsResponse>, StatusCode> {
    let node = &state.node;
    let height = node.get_tip_height().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let (total_fees, last_fees) = node.get_fee_stats().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let (finalized, _, _, _) = node.get_finality_status().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let peer_count = state.peer_manager.peer_count().await as u32;
    let ws_clients = state.ws_broadcaster.client_count().await;
    Ok(Json(StatsResponse {
        connected_peers: peer_count,
        network_height: height,
        is_mining: node.is_mining(),
        node_id: node.node_id(),
        total_fees_collected: total_fees,
        fees_in_last_block: last_fees,
        chain_id: node.chain_id(),
        finalized_height: finalized,
        ws_clients,
    }))
}

#[derive(Serialize)]
struct BurnAddressResponse {
    burn_address: String,
    description: String,
}

async fn get_burn_address() -> Json<BurnAddressResponse> {
    Json(BurnAddressResponse {
        burn_address: crate::node::L1Node::get_burn_address().to_string(),
        description: "Official burn address. Tokens sent here are permanently destroyed and tracked on-chain.".to_string(),
    })
}

#[derive(Serialize)]
struct BurnedTokensResponse {
    burned: std::collections::HashMap<String, f64>,
    total_xrge_burned: f64,
}

async fn get_burned_tokens(State(state): State<AppState>) -> Result<Json<BurnedTokensResponse>, StatusCode> {
    let node = &state.node;
    let burned = node.get_all_burned_tokens().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let total_xrge = node.get_burned_amount("XRGE").unwrap_or(0.0);
    Ok(Json(BurnedTokensResponse {
        burned,
        total_xrge_burned: total_xrge,
    }))
}

// ===== Token Metadata Endpoints =====

#[derive(Serialize)]
struct TokenMetadataResponse {
    success: bool,
    symbol: String,
    name: String,
    creator: String,
    image: Option<String>,
    description: Option<String>,
    website: Option<String>,
    twitter: Option<String>,
    discord: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Serialize)]
struct AllTokensResponse {
    success: bool,
    tokens: Vec<TokenMetadataResponse>,
}

async fn get_all_tokens(State(state): State<AppState>) -> Result<Json<AllTokensResponse>, StatusCode> {
    let node = &state.node;
    match node.get_all_token_metadata() {
        Ok(tokens) => {
            let token_list: Vec<TokenMetadataResponse> = tokens
                .into_iter()
                .map(|t| TokenMetadataResponse {
                    success: true,
                    symbol: t.symbol,
                    name: t.name,
                    creator: t.creator,
                    image: t.image,
                    description: t.description,
                    website: t.website,
                    twitter: t.twitter,
                    discord: t.discord,
                    created_at: t.created_at,
                    updated_at: t.updated_at,
                })
                .collect();
            Ok(Json(AllTokensResponse {
                success: true,
                tokens: token_list,
            }))
        }
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

async fn get_token_metadata(
    State(state): State<AppState>,
    Path(symbol): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let node = &state.node;
    match node.get_token_metadata(&symbol) {
        Ok(Some(meta)) => Ok(Json(serde_json::json!({
            "success": true,
            "symbol": meta.symbol,
            "name": meta.name,
            "creator": meta.creator,
            "image": meta.image,
            "description": meta.description,
            "website": meta.website,
            "twitter": meta.twitter,
            "discord": meta.discord,
            "created_at": meta.created_at,
            "updated_at": meta.updated_at,
        }))),
        Ok(None) => Ok(Json(serde_json::json!({
            "success": false,
            "error": format!("Token {} not found", symbol),
        }))),
        Err(e) => Ok(Json(serde_json::json!({
            "success": false,
            "error": e,
        }))),
    }
}

#[derive(Deserialize)]
struct UpdateTokenMetadataRequest {
    pub token_symbol: String,
    pub from_public_key: String,
    pub from_private_key: String,  // Used to verify ownership via signature
    pub image: Option<String>,
    pub description: Option<String>,
    pub website: Option<String>,
    pub twitter: Option<String>,
    pub discord: Option<String>,
}

async fn update_token_metadata(
    State(state): State<AppState>,
    Json(body): Json<UpdateTokenMetadataRequest>,
) -> Json<serde_json::Value> {
    let node = &state.node;
    
    // Verify the caller is the token creator
    match node.is_token_creator(&body.token_symbol, &body.from_public_key) {
        Ok(true) => {
            // Verify signature by checking the private key matches the public key
            // This is a simple check - in production, you'd want proper signature verification
            match quantum_vault_crypto::pqc_verify_keypair(&body.from_public_key, &body.from_private_key) {
                Ok(true) => {
                    // Update the metadata
                    match node.update_token_metadata(
                        &body.token_symbol,
                        &body.from_public_key,
                        body.image,
                        body.description,
                        body.website,
                        body.twitter,
                        body.discord,
                    ) {
                        Ok(()) => Json(serde_json::json!({
                            "success": true,
                            "message": "Token metadata updated successfully",
                        })),
                        Err(e) => Json(serde_json::json!({
                            "success": false,
                            "error": e,
                        })),
                    }
                }
                Ok(false) => Json(serde_json::json!({
                    "success": false,
                    "error": "Invalid private key - does not match public key",
                })),
                Err(e) => Json(serde_json::json!({
                    "success": false,
                    "error": format!("Key verification failed: {}", e),
                })),
            }
        }
        Ok(false) => Json(serde_json::json!({
            "success": false,
            "error": "Only the token creator can update metadata",
        })),
        Err(e) => Json(serde_json::json!({
            "success": false,
            "error": e,
        })),
    }
}

#[derive(Serialize)]
struct TokenHolder {
    address: String,
    balance: f64,
    percentage: f64,
}

#[derive(Serialize)]
struct TokenHoldersResponse {
    success: bool,
    holders: Vec<TokenHolder>,
    total_supply: f64,
    circulating_supply: f64,
}

#[derive(Deserialize)]
struct ClaimTokenMetadataRequest {
    pub token_symbol: String,
    pub from_public_key: String,
    pub from_private_key: String,
}

async fn claim_token_metadata(
    State(state): State<AppState>,
    Json(body): Json<ClaimTokenMetadataRequest>,
) -> Json<serde_json::Value> {
    let node = &state.node;
    
    // Verify the caller owns the private key
    match quantum_vault_crypto::pqc_verify_keypair(&body.from_public_key, &body.from_private_key) {
        Ok(true) => {
            // Try to claim the metadata
            match node.claim_token_metadata(&body.token_symbol, &body.from_public_key) {
                Ok(()) => Json(serde_json::json!({
                    "success": true,
                    "message": "Token metadata claimed successfully. You can now update it.",
                })),
                Err(e) => Json(serde_json::json!({
                    "success": false,
                    "error": e,
                })),
            }
        }
        Ok(false) => Json(serde_json::json!({
            "success": false,
            "error": "Invalid private key - does not match public key",
        })),
        Err(e) => Json(serde_json::json!({
            "success": false,
            "error": format!("Key verification failed: {}", e),
        })),
    }
}

async fn get_token_holders(
    State(state): State<AppState>,
    Path(symbol): Path<String>,
) -> Json<TokenHoldersResponse> {
    let node = &state.node;
    
    // Get the original total supply from the create_token transaction
    let original_supply = node.get_token_original_supply(&symbol).unwrap_or(0);
    
    // Get all wallet balances for this symbol
    let wallet_balances = node.get_all_token_balances_for_symbol(&symbol).unwrap_or_default();
    let _wallet_total: f64 = wallet_balances.values().sum();
    
    // Get pool reserves for this token (tokens locked in liquidity)
    let pool_reserves = node.get_token_pool_reserves(&symbol).unwrap_or(0);
    
    // Get burned amount
    let burned = node.get_burned_amount(&symbol).unwrap_or(0.0);
    
    // Total supply is the original minted amount
    let total_supply = original_supply as f64;
    
    // Circulating supply = total - burned
    let circulating_supply = total_supply - burned;
    
    // Build holders list from wallet balances
    let mut holders: Vec<TokenHolder> = wallet_balances
        .into_iter()
        .filter(|(_, balance)| *balance > 0.0)
        .map(|(address, balance)| {
            let percentage = if total_supply > 0.0 { (balance / total_supply) * 100.0 } else { 0.0 };
            TokenHolder { address, balance, percentage }
        })
        .collect();
    
    // Add liquidity pool as a special holder if there are pool reserves
    if pool_reserves > 0 {
        let percentage = if total_supply > 0.0 { (pool_reserves as f64 / total_supply) * 100.0 } else { 0.0 };
        holders.push(TokenHolder {
            address: format!("Liquidity Pool ({})", symbol),
            balance: pool_reserves as f64,
            percentage,
        });
    }
    
    // Sort by balance descending
    holders.sort_by(|a, b| b.balance.partial_cmp(&a.balance).unwrap_or(std::cmp::Ordering::Equal));
    
    Json(TokenHoldersResponse {
        success: true,
        holders,
        total_supply,
        circulating_supply,
    })
}

#[derive(Serialize)]
struct TokenTransaction {
    tx_hash: String,
    tx_type: String,
    from: String,
    to: Option<String>,
    amount: f64,
    timestamp: i64,
    block_height: u64,
}

#[derive(Serialize)]
struct TokenTransactionsResponse {
    success: bool,
    transactions: Vec<TokenTransaction>,
    total_count: usize,
}

async fn get_token_transactions(
    State(state): State<AppState>,
    Path(symbol): Path<String>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Json<TokenTransactionsResponse> {
    let node = &state.node;
    let limit: usize = params.get("limit").and_then(|s| s.parse().ok()).unwrap_or(50);
    let offset: usize = params.get("offset").and_then(|s| s.parse().ok()).unwrap_or(0);
    
    match node.get_token_transactions(&symbol, limit, offset) {
        Ok((transactions, total_count)) => {
            let txs: Vec<TokenTransaction> = transactions.into_iter().map(|(tx, height, timestamp)| {
                let amount = if tx.tx_type == "create_token" {
                    tx.payload.token_total_supply.unwrap_or(0) as f64
                } else {
                    tx.payload.amount.unwrap_or(0) as f64
                };
                
                // Use signature as unique tx identifier (truncated for display)
                let tx_hash = if tx.sig.len() > 32 {
                    format!("{}...", &tx.sig[..32])
                } else {
                    tx.sig.clone()
                };
                
                TokenTransaction {
                    tx_hash,
                    tx_type: tx.tx_type.clone(),
                    from: tx.from_pub_key.clone(),
                    to: tx.payload.to_pub_key_hex.clone(),
                    amount,
                    timestamp,
                    block_height: height,
                }
            }).collect();
            
            Json(TokenTransactionsResponse {
                success: true,
                transactions: txs,
                total_count,
            })
        }
        Err(_) => Json(TokenTransactionsResponse {
            success: false,
            transactions: vec![],
            total_count: 0,
        }),
    }
}

/// XRGE token address on Base chain
const XRGE_TOKEN_ADDRESS: &str = "0x147120faec9277ec02d957584cfcd92b56a24317";

#[derive(Serialize)]
struct XRGEPriceResponse {
    success: bool,
    price_usd: f64,
    price_change_24h: f64,
    volume_24h: f64,
    liquidity: f64,
    source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

async fn get_xrge_price() -> Json<XRGEPriceResponse> {
    // Use DexScreener API - more reliable and no auth needed
    let url = format!(
        "https://api.dexscreener.com/latest/dex/tokens/{}",
        XRGE_TOKEN_ADDRESS
    );
    
    let client = match reqwest::Client::builder()
        .timeout(StdDuration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return Json(XRGEPriceResponse {
                success: false,
                price_usd: 0.0,
                price_change_24h: 0.0,
                volume_24h: 0.0,
                liquidity: 0.0,
                source: "DexScreener".to_string(),
                error: Some(format!("Failed to create client: {}", e)),
            });
        }
    };
    
    let response = client.get(&url).send().await;
    
    match response {
        Ok(res) => {
            if !res.status().is_success() {
                return Json(XRGEPriceResponse {
                    success: false,
                    price_usd: 0.0,
                    price_change_24h: 0.0,
                    volume_24h: 0.0,
                    liquidity: 0.0,
                    source: "DexScreener".to_string(),
                    error: Some(format!("API returned status: {}", res.status())),
                });
            }
            
            match res.json::<serde_json::Value>().await {
                Ok(data) => {
                    // DexScreener returns: {"pairs":[{"priceUsd":"0.00001234","priceChange":{"h24":-5.2},"volume":{"h24":1234},"liquidity":{"usd":5678}}]}
                    let pairs = &data["pairs"];
                    
                    // Get the first pair (usually the most liquid)
                    if let Some(pair) = pairs.as_array().and_then(|arr| arr.first()) {
                        let price_usd = pair["priceUsd"]
                            .as_str()
                            .and_then(|s| s.parse::<f64>().ok())
                            .unwrap_or(0.0);
                        let price_change_24h = pair["priceChange"]["h24"]
                            .as_f64()
                            .unwrap_or(0.0);
                        let volume_24h = pair["volume"]["h24"]
                            .as_f64()
                            .unwrap_or(0.0);
                        let liquidity = pair["liquidity"]["usd"]
                            .as_f64()
                            .unwrap_or(0.0);
                        
                        Json(XRGEPriceResponse {
                            success: true,
                            price_usd,
                            price_change_24h,
                            volume_24h,
                            liquidity,
                            source: "DexScreener".to_string(),
                            error: None,
                        })
                    } else {
                        Json(XRGEPriceResponse {
                            success: false,
                            price_usd: 0.0,
                            price_change_24h: 0.0,
                            volume_24h: 0.0,
                            liquidity: 0.0,
                            source: "DexScreener".to_string(),
                            error: Some("No pairs found".to_string()),
                        })
                    }
                }
                Err(e) => Json(XRGEPriceResponse {
                    success: false,
                    price_usd: 0.0,
                    price_change_24h: 0.0,
                    volume_24h: 0.0,
                    liquidity: 0.0,
                    source: "DexScreener".to_string(),
                    error: Some(format!("Failed to parse response: {}", e)),
                }),
            }
        }
        Err(e) => Json(XRGEPriceResponse {
            success: false,
            price_usd: 0.0,
            price_change_24h: 0.0,
            volume_24h: 0.0,
            liquidity: 0.0,
            source: "DexScreener".to_string(),
            error: Some(format!("Request failed: {}", e)),
        }),
    }
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
    let block_clone = block.clone();
    match node.import_block(block) {
        Ok(()) => {
            // Broadcast to WebSocket clients
            state.ws_broadcaster.broadcast_new_block(&block_clone);
            Ok(Json(ImportBlockResponse { success: true, error: None }))
        }
        Err(e) => Ok(Json(ImportBlockResponse { success: false, error: Some(e) })),
    }
}

async fn get_block_by_height(
    State(state): State<AppState>,
    Path(height): Path<u64>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let node = &state.node;
    match node.get_block(height) {
        Ok(Some(block)) => {
            let tx_count = block.txs.len();
            let total_fees: f64 = block.txs.iter().map(|t| t.fee).sum();
            let txs: Vec<serde_json::Value> = block.txs.iter().map(|tx| {
                let tx_id = quantum_vault_crypto::bytes_to_hex(
                    &quantum_vault_crypto::sha256(&quantum_vault_types::encode_tx_v1(tx)),
                );
                serde_json::json!({
                    "txId": tx_id,
                    "tx": tx,
                })
            }).collect();
            Ok(Json(serde_json::json!({
                "success": true,
                "block": {
                    "height": block.header.height,
                    "hash": block.hash,
                    "prevHash": block.header.prev_hash,
                    "time": block.header.time,
                    "proposer": block.header.proposer_pub_key,
                    "txHash": block.header.tx_hash,
                    "txCount": tx_count,
                    "totalFees": total_fees,
                    "transactions": txs,
                }
            })))
        }
        Ok(None) => Err(StatusCode::NOT_FOUND),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

async fn get_tx_by_hash(
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let node = &state.node;
    let blocks = node.get_all_blocks().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // First pass: match by computed tx hash
    for block in &blocks {
        for tx in &block.txs {
            let tx_id = quantum_vault_crypto::bytes_to_hex(
                &quantum_vault_crypto::sha256(&quantum_vault_types::encode_tx_v1(tx)),
            );
            if tx_id == hash {
                return Ok(Json(serde_json::json!({
                    "success": true,
                    "txId": tx_id,
                    "blockHeight": block.header.height,
                    "blockHash": block.hash,
                    "blockTime": block.header.time,
                    "tx": tx,
                })));
            }
        }
    }

    // Second pass: match by block hash (frontend may pass block hash as tx identifier)
    for block in &blocks {
        if block.hash == hash {
            if let Some(tx) = block.txs.first() {
                let tx_id = quantum_vault_crypto::bytes_to_hex(
                    &quantum_vault_crypto::sha256(&quantum_vault_types::encode_tx_v1(tx)),
                );
                return Ok(Json(serde_json::json!({
                    "success": true,
                    "txId": tx_id,
                    "blockHeight": block.header.height,
                    "blockHash": block.hash,
                    "blockTime": block.header.time,
                    "tx": tx,
                })));
            }
        }
    }

    Err(StatusCode::NOT_FOUND)
}

#[derive(Deserialize)]
struct AddressTxsQuery {
    limit: Option<usize>,
    offset: Option<usize>,
}

async fn get_address_transactions(
    State(state): State<AppState>,
    Path(public_key): Path<String>,
    Query(query): Query<AddressTxsQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let node = &state.node;
    let blocks = node.get_all_blocks().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut items: Vec<serde_json::Value> = Vec::new();
    for block in &blocks {
        for tx in &block.txs {
            let is_sender = tx.from_pub_key == public_key;
            let is_recipient = tx.payload.to_pub_key_hex.as_deref() == Some(&public_key);
            if is_sender || is_recipient {
                let tx_id = quantum_vault_crypto::bytes_to_hex(
                    &quantum_vault_crypto::sha256(&quantum_vault_types::encode_tx_v1(tx)),
                );
                items.push(serde_json::json!({
                    "txId": tx_id,
                    "blockHeight": block.header.height,
                    "blockHash": block.hash,
                    "blockTime": block.header.time,
                    "direction": if is_sender { "out" } else { "in" },
                    "tx": tx,
                }));
            }
        }
    }
    items.sort_by(|a, b| {
        let bt_a = a["blockTime"].as_u64().unwrap_or(0);
        let bt_b = b["blockTime"].as_u64().unwrap_or(0);
        bt_b.cmp(&bt_a)
    });
    let total = items.len();
    let limit = query.limit.unwrap_or(50).min(500);
    let offset = query.offset.unwrap_or(0);
    let paged: Vec<serde_json::Value> = items.into_iter().skip(offset).take(limit).collect();
    Ok(Json(serde_json::json!({
        "success": true,
        "transactions": paged,
        "total": total,
    })))
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
    token_balances: std::collections::HashMap<String, f64>,
    lp_balances: std::collections::HashMap<String, f64>,
}

async fn get_balance(
    State(state): State<AppState>,
    Path(public_key): Path<String>,
) -> Result<Json<BalanceResponse>, StatusCode> {
    let node = &state.node;
    let balance = node.get_balance(&public_key).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let token_balances = node.get_all_token_balances(&public_key).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let lp_balances = node.get_all_lp_balances(&public_key).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(BalanceResponse { success: true, balance, token_balances, lp_balances }))
}

#[derive(Serialize)]
struct TokenBalanceResponse {
    success: bool,
    token_symbol: String,
    balance: f64,
}

async fn get_token_balance(
    State(state): State<AppState>,
    Path((public_key, token_symbol)): Path<(String, String)>,
) -> Result<Json<TokenBalanceResponse>, StatusCode> {
    let node = &state.node;
    let balance = node.get_token_balance(&public_key, &token_symbol).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(TokenBalanceResponse { success: true, token_symbol, balance }))
}

// ===== AMM/DEX Endpoints =====

#[derive(Serialize)]
struct PoolsResponse {
    success: bool,
    pools: Vec<LiquidityPool>,
}

async fn get_pools(
    State(state): State<AppState>,
) -> Result<Json<PoolsResponse>, StatusCode> {
    let node = &state.node;
    let pools = node.list_pools().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(PoolsResponse { success: true, pools }))
}

#[derive(Serialize)]
struct PoolResponse {
    success: bool,
    pool: Option<LiquidityPool>,
}

async fn get_pool(
    State(state): State<AppState>,
    Path(pool_id): Path<String>,
) -> Result<Json<PoolResponse>, StatusCode> {
    let node = &state.node;
    let pool = node.get_pool(&pool_id).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(PoolResponse { success: true, pool }))
}

#[derive(Deserialize)]
struct CreatePoolRequest {
    from_private_key: String,
    from_public_key: String,
    token_a: String,
    token_b: String,
    amount_a: u64,
    amount_b: u64,
}

#[derive(Serialize)]
struct CreatePoolResponse {
    success: bool,
    pool_id: String,
    message: String,
}

async fn create_pool(
    State(state): State<AppState>,
    Json(body): Json<CreatePoolRequest>,
) -> Result<Json<CreatePoolResponse>, (StatusCode, Json<serde_json::Value>)> {
    use quantum_vault_crypto::pqc_sign;
    use quantum_vault_types::{TxPayload, TxV1, encode_tx_for_signing};
    
    let node = &state.node;
    let pool_id = LiquidityPool::make_pool_id(&body.token_a, &body.token_b);
    
    // Check pool doesn't already exist
    if let Ok(Some(_)) = node.get_pool(&pool_id) {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
            "success": false,
            "error": format!("Pool {} already exists", pool_id)
        }))));
    }
    
    let tx = TxV1 {
        version: 1,
        tx_type: "create_pool".to_string(),
        from_pub_key: body.from_public_key.clone(),
        nonce: chrono::Utc::now().timestamp_millis() as u64,
        payload: TxPayload {
            pool_id: Some(pool_id.clone()),
            token_a_symbol: Some(body.token_a.clone()),
            token_b_symbol: Some(body.token_b.clone()),
            amount_a: Some(body.amount_a),
            amount_b: Some(body.amount_b),
            ..Default::default()
        },
        fee: 10.0, // Pool creation fee
        sig: String::new(),
        signed_payload: None,
    };
    
    let tx_bytes = encode_tx_for_signing(&tx);
    let sig = pqc_sign(&body.from_private_key, &tx_bytes)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    
    let signed_tx = TxV1 { sig, ..tx };
    
    node.add_tx_to_mempool(signed_tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    
    Ok(Json(CreatePoolResponse {
        success: true,
        pool_id,
        message: "Pool creation transaction submitted".to_string(),
    }))
}

#[derive(Deserialize)]
struct AddLiquidityRequest {
    from_private_key: String,
    from_public_key: String,
    pool_id: String,
    amount_a: u64,
    amount_b: u64,
}

async fn add_liquidity(
    State(state): State<AppState>,
    Json(body): Json<AddLiquidityRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    use quantum_vault_crypto::pqc_sign;
    use quantum_vault_types::{TxPayload, TxV1, encode_tx_for_signing};
    
    let node = &state.node;
    
    // Check pool exists
    if node.get_pool(&body.pool_id).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))))?.is_none() {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
            "success": false,
            "error": format!("Pool {} not found", body.pool_id)
        }))));
    }
    
    let tx = TxV1 {
        version: 1,
        tx_type: "add_liquidity".to_string(),
        from_pub_key: body.from_public_key.clone(),
        nonce: chrono::Utc::now().timestamp_millis() as u64,
        payload: TxPayload {
            pool_id: Some(body.pool_id.clone()),
            amount_a: Some(body.amount_a),
            amount_b: Some(body.amount_b),
            ..Default::default()
        },
        fee: 0.1,
        sig: String::new(),
        signed_payload: None,
    };
    
    let tx_bytes = encode_tx_for_signing(&tx);
    let sig = pqc_sign(&body.from_private_key, &tx_bytes)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    
    let signed_tx = TxV1 { sig, ..tx };
    
    node.add_tx_to_mempool(signed_tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    
    Ok(Json(serde_json::json!({
        "success": true,
        "message": "Add liquidity transaction submitted"
    })))
}

#[derive(Deserialize)]
struct RemoveLiquidityRequest {
    from_private_key: String,
    from_public_key: String,
    pool_id: String,
    lp_amount: u64,
}

async fn remove_liquidity(
    State(state): State<AppState>,
    Json(body): Json<RemoveLiquidityRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    use quantum_vault_crypto::pqc_sign;
    use quantum_vault_types::{TxPayload, TxV1, encode_tx_for_signing};
    
    let node = &state.node;
    
    let tx = TxV1 {
        version: 1,
        tx_type: "remove_liquidity".to_string(),
        from_pub_key: body.from_public_key.clone(),
        nonce: chrono::Utc::now().timestamp_millis() as u64,
        payload: TxPayload {
            pool_id: Some(body.pool_id.clone()),
            lp_amount: Some(body.lp_amount),
            ..Default::default()
        },
        fee: 0.1,
        sig: String::new(),
        signed_payload: None,
    };
    
    let tx_bytes = encode_tx_for_signing(&tx);
    let sig = pqc_sign(&body.from_private_key, &tx_bytes)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    
    let signed_tx = TxV1 { sig, ..tx };
    
    node.add_tx_to_mempool(signed_tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    
    Ok(Json(serde_json::json!({
        "success": true,
        "message": "Remove liquidity transaction submitted"
    })))
}

#[derive(Deserialize)]
struct SwapQuoteRequest {
    token_in: String,
    token_out: String,
    amount_in: u64,
}

#[derive(Serialize)]
struct SwapQuoteResponse {
    success: bool,
    amount_out: u64,
    price_impact: f64,
    path: Vec<String>,
    pools: Vec<String>,
}

async fn get_swap_quote(
    State(state): State<AppState>,
    Json(body): Json<SwapQuoteRequest>,
) -> Result<Json<SwapQuoteResponse>, (StatusCode, Json<serde_json::Value>)> {
    let node = &state.node;
    
    let route = node.get_swap_quote(&body.token_in, &body.token_out, body.amount_in)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))))?;
    
    match route {
        Some(r) => Ok(Json(SwapQuoteResponse {
            success: true,
            amount_out: r.total_amount_out,
            price_impact: r.price_impact,
            path: r.path,
            pools: r.pools,
        })),
        None => Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
            "success": false,
            "error": "No route found for swap"
        }))))
    }
}

#[derive(Deserialize)]
struct ExecuteSwapRequest {
    from_private_key: String,
    from_public_key: String,
    token_in: String,
    token_out: String,
    amount_in: u64,
    min_amount_out: u64,
    path: Option<Vec<String>>,
}

async fn execute_swap(
    State(state): State<AppState>,
    Json(body): Json<ExecuteSwapRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    use quantum_vault_crypto::pqc_sign;
    use quantum_vault_types::{TxPayload, TxV1, encode_tx_for_signing};
    
    let node = &state.node;
    let swap_fee = 0.1_f64;

    // Balance check
    if body.token_in == "XRGE" {
        let bal = node.get_balance(&body.from_public_key).unwrap_or(0.0);
        let needed = body.amount_in as f64 + swap_fee;
        if bal < needed {
            return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
                "success": false,
                "error": format!("insufficient XRGE balance: have {:.4}, need {:.4}", bal, needed)
            }))));
        }
    } else {
        let xrge_bal = node.get_balance(&body.from_public_key).unwrap_or(0.0);
        if xrge_bal < swap_fee {
            return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
                "success": false,
                "error": format!("insufficient XRGE balance for fee: have {:.4}, need {:.4}", xrge_bal, swap_fee)
            }))));
        }
        let token_bal = node.get_token_balance(&body.from_public_key, &body.token_in).unwrap_or(0.0);
        if token_bal < body.amount_in as f64 {
            return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
                "success": false,
                "error": format!("insufficient {} balance: have {:.4}, need {}", body.token_in, token_bal, body.amount_in)
            }))));
        }
    }

    let tx = TxV1 {
        version: 1,
        tx_type: "swap".to_string(),
        from_pub_key: body.from_public_key.clone(),
        nonce: chrono::Utc::now().timestamp_millis() as u64,
        payload: TxPayload {
            token_a_symbol: Some(body.token_in.clone()),
            token_b_symbol: Some(body.token_out.clone()),
            amount_a: Some(body.amount_in),
            min_amount_out: Some(body.min_amount_out),
            swap_path: body.path,
            ..Default::default()
        },
        fee: swap_fee,
        sig: String::new(),
        signed_payload: None,
    };
    
    let tx_bytes = encode_tx_for_signing(&tx);
    let sig = pqc_sign(&body.from_private_key, &tx_bytes)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    
    let signed_tx = TxV1 { sig, ..tx };
    
    node.add_tx_to_mempool(signed_tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    
    Ok(Json(serde_json::json!({
        "success": true,
        "message": "Swap transaction submitted"
    })))
}

// ===== Pool History Endpoints =====

#[derive(Serialize)]
struct PoolEventsResponse {
    success: bool,
    events: Vec<PoolEvent>,
}

async fn get_pool_events(
    State(state): State<AppState>,
    Path(pool_id): Path<String>,
) -> Result<Json<PoolEventsResponse>, StatusCode> {
    let node = &state.node;
    let events = node.get_pool_events(&pool_id, 100)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(PoolEventsResponse { success: true, events }))
}

#[derive(Serialize)]
struct PriceHistoryResponse {
    success: bool,
    prices: Vec<PriceSnapshot>,
}

async fn get_pool_price_history(
    State(state): State<AppState>,
    Path(pool_id): Path<String>,
) -> Result<Json<PriceHistoryResponse>, StatusCode> {
    let node = &state.node;
    let prices = node.get_pool_price_history(&pool_id, 500)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(PriceHistoryResponse { success: true, prices }))
}

#[derive(Serialize)]
struct PoolStatsResponse {
    success: bool,
    stats: PoolStats,
}

async fn get_pool_stats(
    State(state): State<AppState>,
    Path(pool_id): Path<String>,
) -> Result<Json<PoolStatsResponse>, StatusCode> {
    let node = &state.node;
    let stats = node.get_pool_stats(&pool_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(PoolStatsResponse { success: true, stats }))
}

#[derive(Serialize)]
struct AllEventsResponse {
    success: bool,
    events: Vec<PoolEvent>,
}

async fn get_all_events(
    State(state): State<AppState>,
) -> Result<Json<AllEventsResponse>, StatusCode> {
    let node = &state.node;
    let events = node.get_all_pool_events(100)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(AllEventsResponse { success: true, events }))
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
            
            // Broadcast to WebSocket clients
            state.ws_broadcaster.broadcast_new_tx(
                &id,
                &tx.tx_type,
                &tx.from_pub_key,
                tx.payload.to_pub_key_hex.as_deref(),
                tx.payload.amount.map(|a| a as u64),
            );
            
            // Broadcast tx to P2P peers
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
            
            // Register initial token metadata
            let _ = node.register_token_metadata(
                &body.token_symbol,
                &body.token_name,
                &body.from_public_key,
                None, // image
                None, // description
            );
            
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
            return Ok(Json(TxResponse {
                success: false,
                tx_id: None,
                tx: None,
                error: Some("Faucet restricted: your address is not whitelisted. Unset QV_FAUCET_WHITELIST for local dev.".to_string()),
            }));
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
    let id = body.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let display_name = body.get("displayName").and_then(|v| v.as_str()).unwrap_or_default().to_string();

    // Enforce unique display names (case-insensitive)
    if let Ok(existing_wallets) = node.list_wallets() {
        let name_lower = display_name.to_lowercase();
        for w in &existing_wallets {
            if w.display_name.to_lowercase() == name_lower && w.id != id {
                return Ok(Json(serde_json::json!({
                    "success": false,
                    "error": format!("Display name '{}' is already taken", display_name)
                })));
            }
        }
    }

    let wallet = quantum_vault_storage::messenger_store::MessengerWallet {
        id,
        display_name,
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

async fn delete_messenger_conversation(
    State(state): State<AppState>,
    Path(conversation_id): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let node = &state.node;
    node.delete_conversation(&conversation_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "success": true })))
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
        message_type: body.get("messageType").and_then(|v| v.as_str()).unwrap_or("text").to_string(),
        spoiler: body.get("spoiler").and_then(|v| v.as_bool()).unwrap_or(false),
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

// ============================================
// Name Registry endpoints
// ============================================

async fn register_name(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let name = body.get("name").and_then(|v| v.as_str()).unwrap_or_default();
    let wallet_id = body.get("walletId").and_then(|v| v.as_str()).unwrap_or_default();
    match state.node.register_name(name, wallet_id) {
        Ok(entry) => Ok(Json(serde_json::json!({ "success": true, "entry": entry }))),
        Err(e) => Ok(Json(serde_json::json!({ "success": false, "error": e }))),
    }
}

async fn resolve_name(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let entry = state.node.lookup_name(&name).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    match entry {
        Some(e) => {
            let wallets = state.node.list_wallets().unwrap_or_default();
            let wallet = wallets.iter().find(|w| w.id == e.wallet_id);
            Ok(Json(serde_json::json!({
                "success": true,
                "entry": e,
                "wallet": wallet,
            })))
        }
        None => Ok(Json(serde_json::json!({ "success": false, "error": "Name not found" }))),
    }
}

async fn reverse_lookup_name(
    State(state): State<AppState>,
    Path(wallet_id): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let name = state.node.reverse_lookup_name(&wallet_id).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "success": true, "name": name })))
}

async fn release_name(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let name = body.get("name").and_then(|v| v.as_str()).unwrap_or_default();
    let wallet_id = body.get("walletId").and_then(|v| v.as_str()).unwrap_or_default();
    match state.node.release_name(name, wallet_id) {
        Ok(()) => Ok(Json(serde_json::json!({ "success": true }))),
        Err(e) => Ok(Json(serde_json::json!({ "success": false, "error": e }))),
    }
}

// ============================================
// Mail endpoints
// ============================================

async fn send_mail(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let msg = quantum_vault_storage::mail_store::MailMessage {
        id: uuid::Uuid::new_v4().to_string(),
        from_wallet_id: body.get("fromWalletId").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        to_wallet_ids: body.get("toWalletIds")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default(),
        subject_encrypted: body.get("subjectEncrypted").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        body_encrypted: body.get("bodyEncrypted").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        signature: body.get("signature").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
        reply_to_id: body.get("replyToId").and_then(|v| v.as_str()).map(|s| s.to_string()),
        has_attachment: body.get("hasAttachment").and_then(|v| v.as_bool()).unwrap_or(false),
        attachment_hash: body.get("attachmentHash").and_then(|v| v.as_str()).map(|s| s.to_string()),
    };
    let msg = state.node.send_mail(msg).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "success": true, "message": msg })))
}

async fn get_mail_inbox(
    State(state): State<AppState>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let wallet_id = query.get("walletId").cloned().unwrap_or_default();
    let items = state.node.list_mail_folder(&wallet_id, "inbox").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let messages: Vec<serde_json::Value> = items.into_iter().map(|(msg, label)| {
        serde_json::json!({ "message": msg, "label": label })
    }).collect();
    Ok(Json(serde_json::json!({ "success": true, "messages": messages })))
}

async fn get_mail_sent(
    State(state): State<AppState>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let wallet_id = query.get("walletId").cloned().unwrap_or_default();
    let items = state.node.list_mail_folder(&wallet_id, "sent").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let messages: Vec<serde_json::Value> = items.into_iter().map(|(msg, label)| {
        serde_json::json!({ "message": msg, "label": label })
    }).collect();
    Ok(Json(serde_json::json!({ "success": true, "messages": messages })))
}

async fn get_mail_trash(
    State(state): State<AppState>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let wallet_id = query.get("walletId").cloned().unwrap_or_default();
    let items = state.node.list_mail_folder(&wallet_id, "trash").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let messages: Vec<serde_json::Value> = items.into_iter().map(|(msg, label)| {
        serde_json::json!({ "message": msg, "label": label })
    }).collect();
    Ok(Json(serde_json::json!({ "success": true, "messages": messages })))
}

async fn get_mail_message(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let wallet_id = query.get("walletId").cloned().unwrap_or_default();
    let msg = state.node.get_mail(&id).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if !wallet_id.is_empty() {
        let _ = state.node.mark_mail_read(&wallet_id, &id);
    }
    match msg {
        Some(m) => Ok(Json(serde_json::json!({ "success": true, "message": m }))),
        None => Ok(Json(serde_json::json!({ "success": false, "error": "Message not found" }))),
    }
}

async fn move_mail(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let wallet_id = body.get("walletId").and_then(|v| v.as_str()).unwrap_or_default();
    let message_id = body.get("messageId").and_then(|v| v.as_str()).unwrap_or_default();
    let folder = body.get("folder").and_then(|v| v.as_str()).unwrap_or_default();
    match state.node.move_mail(wallet_id, message_id, folder) {
        Ok(()) => Ok(Json(serde_json::json!({ "success": true }))),
        Err(e) => Ok(Json(serde_json::json!({ "success": false, "error": e }))),
    }
}

async fn mark_mail_read(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let wallet_id = body.get("walletId").and_then(|v| v.as_str()).unwrap_or_default();
    let message_id = body.get("messageId").and_then(|v| v.as_str()).unwrap_or_default();
    match state.node.mark_mail_read(wallet_id, message_id) {
        Ok(()) => Ok(Json(serde_json::json!({ "success": true }))),
        Err(e) => Ok(Json(serde_json::json!({ "success": false, "error": e }))),
    }
}

async fn delete_mail(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let wallet_id = query.get("walletId").cloned().unwrap_or_default();
    match state.node.delete_mail(&wallet_id, &id) {
        Ok(()) => Ok(Json(serde_json::json!({ "success": true }))),
        Err(e) => Ok(Json(serde_json::json!({ "success": false, "error": e }))),
    }
}

// ============================================
// Secure v2 API endpoints (client-side signing)
// ============================================

/// Signed transaction payload from frontend
#[derive(Deserialize)]
struct SignedTransactionRequest {
    payload: serde_json::Value,
    signature: String,
    public_key: String,
}

/// Verify a signed transaction from the frontend.
/// Returns the serialized payload JSON on success (the exact bytes that were signed).
fn verify_signed_tx(req: &SignedTransactionRequest) -> Result<String, String> {
    use quantum_vault_crypto::pqc_verify;
    
    // Serialize payload deterministically (sorted keys)
    let payload_json = serde_json::to_string(&req.payload)
        .map_err(|e| format!("Failed to serialize payload: {}", e))?;
    let payload_bytes = payload_json.as_bytes();
    
    // Verify signature
    let valid = pqc_verify(&req.public_key, payload_bytes, &req.signature)
        .map_err(|e| format!("Signature verification failed: {}", e))?;
    
    if !valid {
        return Err("Invalid signature".to_string());
    }
    
    // Require timestamp within acceptable range (5 minutes) to prevent replay
    let timestamp = req.payload.get("timestamp").and_then(|v| v.as_i64())
        .ok_or_else(|| "payload must include a 'timestamp' field".to_string())?;
    let now = chrono::Utc::now().timestamp_millis();
    let diff = (now - timestamp).abs();
    if diff > 5 * 60 * 1000 {
        return Err("Transaction expired (timestamp too old or too far in the future)".to_string());
    }
    
    // Require 'from' matches public key to prevent impersonation
    if let Some(from) = req.payload.get("from").and_then(|v| v.as_str()) {
        if from != req.public_key {
            return Err("Payload 'from' does not match signing public key".to_string());
        }
    }
    
    Ok(payload_json)
}

async fn v2_transfer(
    State(state): State<AppState>,
    Json(body): Json<SignedTransactionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    use quantum_vault_types::{TxPayload, TxV1};
    
    let signed_payload = verify_signed_tx(&body).map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    
    let node = &state.node;
    let payload = &body.payload;
    
    let to = payload.get("to").and_then(|v| v.as_str()).unwrap_or_default();
    let amount = payload.get("amount").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let token = payload.get("token").and_then(|v| v.as_str()).unwrap_or("XRGE");
    let fee = 1.0_f64; // Server-enforced minimum fee

    if to.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "recipient address is required"}))));
    }
    if to == body.public_key {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "cannot transfer to yourself"}))));
    }
    if amount <= 0.0 {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "amount must be greater than zero"}))));
    }

    // Balance check
    if token == "XRGE" {
        let bal = node.get_balance(&body.public_key).unwrap_or(0.0);
        if bal < amount + fee {
            return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
                "success": false,
                "error": format!("insufficient XRGE balance: have {:.4}, need {:.4}", bal, amount + fee)
            }))));
        }
    } else {
        let xrge_bal = node.get_balance(&body.public_key).unwrap_or(0.0);
        if xrge_bal < fee {
            return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
                "success": false,
                "error": format!("insufficient XRGE for fee: have {:.4}, need {:.4}", xrge_bal, fee)
            }))));
        }
        let token_bal = node.get_token_balance(&body.public_key, token).unwrap_or(0.0);
        if token_bal < amount {
            return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
                "success": false,
                "error": format!("insufficient {} balance: have {:.4}, need {:.4}", token, token_bal, amount)
            }))));
        }
    }
    
    let tx = TxV1 {
        version: 1,
        tx_type: "transfer".to_string(),
        from_pub_key: body.public_key.clone(),
        nonce: chrono::Utc::now().timestamp_millis() as u64,
        payload: TxPayload {
            to_pub_key_hex: Some(to.to_string()),
            amount: Some(amount as u64),
            token_name: Some(token.to_string()),
            ..Default::default()
        },
        fee,
        sig: body.signature.clone(),
        signed_payload: Some(signed_payload),
    };
    
    node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    
    Ok(Json(serde_json::json!({
        "success": true,
        "message": "Transfer transaction submitted"
    })))
}

async fn v2_create_token(
    State(state): State<AppState>,
    Json(body): Json<SignedTransactionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    use quantum_vault_types::{TxPayload, TxV1};
    
    let signed_payload = verify_signed_tx(&body).map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    
    let node = &state.node;
    let payload = &body.payload;
    
    let token_name = payload.get("token_name").and_then(|v| v.as_str()).unwrap_or_default();
    let token_symbol = payload.get("token_symbol").and_then(|v| v.as_str()).unwrap_or_default();
    let initial_supply = payload.get("initial_supply").and_then(|v| v.as_u64()).unwrap_or(0);
    let fee = 100.0_f64; // Server-enforced token creation fee

    if token_name.is_empty() || token_symbol.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "token_name and token_symbol are required"}))));
    }
    if initial_supply == 0 {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "initial_supply must be greater than zero"}))));
    }

    let bal = node.get_balance(&body.public_key).unwrap_or(0.0);
    if bal < fee {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
            "success": false,
            "error": format!("insufficient XRGE for token creation fee: have {:.4}, need {:.4}", bal, fee)
        }))));
    }
    
    let tx = TxV1 {
        version: 1,
        tx_type: "create_token".to_string(),
        from_pub_key: body.public_key.clone(),
        nonce: chrono::Utc::now().timestamp_millis() as u64,
        payload: TxPayload {
            token_name: Some(token_name.to_string()),
            token_symbol: Some(token_symbol.to_string()),
            token_decimals: Some(18),
            token_total_supply: Some(initial_supply),
            ..Default::default()
        },
        fee,
        sig: body.signature.clone(),
        signed_payload: Some(signed_payload),
    };
    
    node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    
    Ok(Json(serde_json::json!({
        "success": true,
        "token_symbol": token_symbol,
        "message": "Token creation transaction submitted"
    })))
}

async fn v2_create_pool(
    State(state): State<AppState>,
    Json(body): Json<SignedTransactionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    use quantum_vault_types::{TxPayload, TxV1};
    
    let signed_payload = verify_signed_tx(&body).map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    
    let node = &state.node;
    let payload = &body.payload;
    
    let token_a = payload.get("token_a").and_then(|v| v.as_str()).unwrap_or_default();
    let token_b = payload.get("token_b").and_then(|v| v.as_str()).unwrap_or_default();
    let amount_a = payload.get("amount_a").and_then(|v| v.as_u64()).unwrap_or(0);
    let amount_b = payload.get("amount_b").and_then(|v| v.as_u64()).unwrap_or(0);

    if token_a.is_empty() || token_b.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "both token symbols are required"}))));
    }
    if token_a == token_b {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "cannot create pool with the same token on both sides"}))));
    }
    if amount_a == 0 || amount_b == 0 {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "initial liquidity amounts must be greater than zero"}))));
    }
    
    let pool_id = LiquidityPool::make_pool_id(token_a, token_b);
    
    // Check pool doesn't already exist
    if let Ok(Some(_)) = node.get_pool(&pool_id) {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
            "success": false,
            "error": format!("Pool {} already exists", pool_id)
        }))));
    }

    let pool_fee = 10.0_f64;

    // Balance check for pool creation
    let mut xrge_needed = pool_fee;
    if token_a == "XRGE" { xrge_needed += amount_a as f64; }
    if token_b == "XRGE" { xrge_needed += amount_b as f64; }

    let xrge_bal = node.get_balance(&body.public_key).unwrap_or(0.0);
    if xrge_bal < xrge_needed {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
            "success": false,
            "error": format!("insufficient XRGE balance: have {:.4}, need {:.4}", xrge_bal, xrge_needed)
        }))));
    }

    if token_a != "XRGE" {
        let bal = node.get_token_balance(&body.public_key, token_a).unwrap_or(0.0);
        if bal < amount_a as f64 {
            return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
                "success": false,
                "error": format!("insufficient {} balance: have {:.4}, need {}", token_a, bal, amount_a)
            }))));
        }
    }
    if token_b != "XRGE" {
        let bal = node.get_token_balance(&body.public_key, token_b).unwrap_or(0.0);
        if bal < amount_b as f64 {
            return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
                "success": false,
                "error": format!("insufficient {} balance: have {:.4}, need {}", token_b, bal, amount_b)
            }))));
        }
    }
    
    let tx = TxV1 {
        version: 1,
        tx_type: "create_pool".to_string(),
        from_pub_key: body.public_key.clone(),
        nonce: chrono::Utc::now().timestamp_millis() as u64,
        payload: TxPayload {
            pool_id: Some(pool_id.clone()),
            token_a_symbol: Some(token_a.to_string()),
            token_b_symbol: Some(token_b.to_string()),
            amount_a: Some(amount_a),
            amount_b: Some(amount_b),
            ..Default::default()
        },
        fee: pool_fee,
        sig: body.signature.clone(),
        signed_payload: Some(signed_payload),
    };
    
    node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    
    Ok(Json(serde_json::json!({
        "success": true,
        "pool_id": pool_id,
        "message": "Pool creation transaction submitted"
    })))
}

async fn v2_add_liquidity(
    State(state): State<AppState>,
    Json(body): Json<SignedTransactionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    use quantum_vault_types::{TxPayload, TxV1};
    
    let signed_payload = verify_signed_tx(&body).map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    
    let node = &state.node;
    let payload = &body.payload;
    
    let pool_id = payload.get("pool_id").and_then(|v| v.as_str()).unwrap_or_default();
    let amount_a = payload.get("amount_a").and_then(|v| v.as_u64()).unwrap_or(0);
    let amount_b = payload.get("amount_b").and_then(|v| v.as_u64()).unwrap_or(0);

    let liq_fee = 1.0_f64;

    // Balance check for add_liquidity
    if let Ok(Some(pool)) = node.get_pool(pool_id) {
        let mut xrge_needed = liq_fee;
        if pool.token_a == "XRGE" { xrge_needed += amount_a as f64; }
        if pool.token_b == "XRGE" { xrge_needed += amount_b as f64; }

        let xrge_bal = node.get_balance(&body.public_key).unwrap_or(0.0);
        if xrge_bal < xrge_needed {
            return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
                "success": false,
                "error": format!("insufficient XRGE balance: have {:.4}, need {:.4}", xrge_bal, xrge_needed)
            }))));
        }

        if pool.token_a != "XRGE" {
            let bal = node.get_token_balance(&body.public_key, &pool.token_a).unwrap_or(0.0);
            if bal < amount_a as f64 {
                return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
                    "success": false,
                    "error": format!("insufficient {} balance: have {:.4}, need {}", pool.token_a, bal, amount_a)
                }))));
            }
        }
        if pool.token_b != "XRGE" {
            let bal = node.get_token_balance(&body.public_key, &pool.token_b).unwrap_or(0.0);
            if bal < amount_b as f64 {
                return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
                    "success": false,
                    "error": format!("insufficient {} balance: have {:.4}, need {}", pool.token_b, bal, amount_b)
                }))));
            }
        }
    } else {
        return Err((StatusCode::NOT_FOUND, Json(serde_json::json!({"success": false, "error": "pool not found"}))));
    }

    if amount_a == 0 || amount_b == 0 {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "liquidity amounts must be greater than zero"}))));
    }

    let tx = TxV1 {
        version: 1,
        tx_type: "add_liquidity".to_string(),
        from_pub_key: body.public_key.clone(),
        nonce: chrono::Utc::now().timestamp_millis() as u64,
        payload: TxPayload {
            pool_id: Some(pool_id.to_string()),
            amount_a: Some(amount_a),
            amount_b: Some(amount_b),
            ..Default::default()
        },
        fee: liq_fee,
        sig: body.signature.clone(),
        signed_payload: Some(signed_payload),
    };
    
    node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    
    Ok(Json(serde_json::json!({
        "success": true,
        "message": "Add liquidity transaction submitted"
    })))
}

async fn v2_remove_liquidity(
    State(state): State<AppState>,
    Json(body): Json<SignedTransactionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    use quantum_vault_types::{TxPayload, TxV1};
    
    let signed_payload = verify_signed_tx(&body).map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    
    let node = &state.node;
    let payload = &body.payload;
    
    let pool_id = payload.get("pool_id").and_then(|v| v.as_str()).unwrap_or_default();
    let lp_amount = payload.get("lp_amount").and_then(|v| v.as_u64()).unwrap_or(0);
    let remove_fee = 1.0_f64;

    if lp_amount == 0 {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "lp_amount must be greater than zero"}))));
    }

    // Verify pool exists
    match node.get_pool(pool_id) {
        Ok(Some(_)) => {}
        _ => {
            return Err((StatusCode::NOT_FOUND, Json(serde_json::json!({"success": false, "error": "pool not found"}))));
        }
    }

    // Verify LP token ownership
    let lp_bal = node.get_lp_balance(&body.public_key, pool_id).unwrap_or(0.0);
    if lp_bal < lp_amount as f64 {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
            "success": false,
            "error": format!("insufficient LP tokens: have {:.4}, want to remove {}", lp_bal, lp_amount)
        }))));
    }

    // Verify XRGE for fee
    let xrge_bal = node.get_balance(&body.public_key).unwrap_or(0.0);
    if xrge_bal < remove_fee {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
            "success": false,
            "error": format!("insufficient XRGE for fee: have {:.4}, need {:.4}", xrge_bal, remove_fee)
        }))));
    }
    
    let tx = TxV1 {
        version: 1,
        tx_type: "remove_liquidity".to_string(),
        from_pub_key: body.public_key.clone(),
        nonce: chrono::Utc::now().timestamp_millis() as u64,
        payload: TxPayload {
            pool_id: Some(pool_id.to_string()),
            lp_amount: Some(lp_amount),
            ..Default::default()
        },
        fee: remove_fee,
        sig: body.signature.clone(),
        signed_payload: Some(signed_payload),
    };
    
    node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    
    Ok(Json(serde_json::json!({
        "success": true,
        "message": "Remove liquidity transaction submitted"
    })))
}

async fn v2_execute_swap(
    State(state): State<AppState>,
    Json(body): Json<SignedTransactionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    use quantum_vault_types::{TxPayload, TxV1};
    
    let signed_payload = verify_signed_tx(&body).map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    
    let node = &state.node;
    let payload = &body.payload;
    
    let token_in = payload.get("token_in").and_then(|v| v.as_str()).unwrap_or_default();
    let token_out = payload.get("token_out").and_then(|v| v.as_str()).unwrap_or_default();
    let amount_in = payload.get("amount_in").and_then(|v| v.as_u64()).unwrap_or(0);
    let min_amount_out = payload.get("min_amount_out").and_then(|v| v.as_u64()).unwrap_or(0);
    
    let swap_fee = 1.0_f64;

    if token_in.is_empty() || token_out.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "token_in and token_out are required"}))));
    }
    if token_in == token_out {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "cannot swap a token for itself"}))));
    }
    if amount_in == 0 {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "amount_in must be greater than zero"}))));
    }

    // Balance check: ensure user can cover input amount + fee
    if token_in == "XRGE" {
        let bal = node.get_balance(&body.public_key).unwrap_or(0.0);
        let needed = amount_in as f64 + swap_fee;
        if bal < needed {
            return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
                "success": false,
                "error": format!("insufficient XRGE balance: have {:.4}, need {:.4} (amount {} + fee {})", bal, needed, amount_in, swap_fee)
            }))));
        }
    } else {
        let xrge_bal = node.get_balance(&body.public_key).unwrap_or(0.0);
        if xrge_bal < swap_fee {
            return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
                "success": false,
                "error": format!("insufficient XRGE balance for fee: have {:.4}, need {:.4}", xrge_bal, swap_fee)
            }))));
        }
        let token_bal = node.get_token_balance(&body.public_key, token_in).unwrap_or(0.0);
        if token_bal < amount_in as f64 {
            return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
                "success": false,
                "error": format!("insufficient {} balance: have {:.4}, need {}", token_in, token_bal, amount_in)
            }))));
        }
    }

    let pool_id = LiquidityPool::make_pool_id(token_in, token_out);
    
    let tx = TxV1 {
        version: 1,
        tx_type: "swap".to_string(),
        from_pub_key: body.public_key.clone(),
        nonce: chrono::Utc::now().timestamp_millis() as u64,
        payload: TxPayload {
            amount: Some(amount_in),
            pool_id: Some(pool_id),
            token_a_symbol: Some(token_in.to_string()),
            token_b_symbol: Some(token_out.to_string()),
            amount_a: Some(amount_in),
            min_amount_out: Some(min_amount_out),
            ..Default::default()
        },
        fee: swap_fee,
        sig: body.signature.clone(),
        signed_payload: Some(signed_payload),
    };
    
    node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    
    Ok(Json(serde_json::json!({
        "success": true,
        "message": "Swap transaction submitted"
    })))
}

async fn v2_stake(
    State(state): State<AppState>,
    Json(body): Json<SignedTransactionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    use quantum_vault_types::{TxPayload, TxV1};
    
    let signed_payload = verify_signed_tx(&body).map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    
    let node = &state.node;
    let payload = &body.payload;
    
    let amount = payload.get("amount").and_then(|v| v.as_u64()).unwrap_or(0);
    let fee = 1.0_f64; // Server-enforced fee

    if amount == 0 {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "stake amount must be greater than zero"}))));
    }

    let bal = node.get_balance(&body.public_key).unwrap_or(0.0);
    if bal < amount as f64 + fee {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
            "success": false,
            "error": format!("insufficient XRGE balance: have {:.4}, need {:.4}", bal, amount as f64 + fee)
        }))));
    }
    
    let tx = TxV1 {
        version: 1,
        tx_type: "stake".to_string(),
        from_pub_key: body.public_key.clone(),
        nonce: chrono::Utc::now().timestamp_millis() as u64,
        payload: TxPayload {
            amount: Some(amount),
            ..Default::default()
        },
        fee,
        sig: body.signature.clone(),
        signed_payload: Some(signed_payload),
    };
    
    node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    
    Ok(Json(serde_json::json!({
        "success": true,
        "message": "Stake transaction submitted"
    })))
}

async fn v2_unstake(
    State(state): State<AppState>,
    Json(body): Json<SignedTransactionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    use quantum_vault_types::{TxPayload, TxV1};
    
    let signed_payload = verify_signed_tx(&body).map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    
    let node = &state.node;
    let payload = &body.payload;
    
    let amount = payload.get("amount").and_then(|v| v.as_u64()).unwrap_or(0);
    let fee = 1.0_f64; // Server-enforced fee

    if amount == 0 {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "unstake amount must be greater than zero"}))));
    }

    // Verify user actually has this amount staked
    if let Ok(validators) = node.list_validators() {
        let staked = validators.iter()
            .find(|(pk, _)| pk == &body.public_key)
            .map(|(_, vs)| vs.stake)
            .unwrap_or(0);
        if (amount as u128) > staked {
            return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
                "success": false,
                "error": format!("insufficient staked balance: have {}, want to unstake {}", staked, amount)
            }))));
        }
    }

    // Check XRGE for fee (unstake returns XRGE, but fee must be payable)
    let bal = node.get_balance(&body.public_key).unwrap_or(0.0);
    if bal < fee {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
            "success": false,
            "error": format!("insufficient XRGE for unstake fee: have {:.4}, need {:.4}", bal, fee)
        }))));
    }
    
    let tx = TxV1 {
        version: 1,
        tx_type: "unstake".to_string(),
        from_pub_key: body.public_key.clone(),
        nonce: chrono::Utc::now().timestamp_millis() as u64,
        payload: TxPayload {
            amount: Some(amount),
            ..Default::default()
        },
        fee,
        sig: body.signature.clone(),
        signed_payload: Some(signed_payload),
    };
    
    node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    
    Ok(Json(serde_json::json!({
        "success": true,
        "message": "Unstake transaction submitted"
    })))
}

async fn v2_faucet(
    State(state): State<AppState>,
    Json(body): Json<SignedTransactionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let _ = verify_signed_tx(&body).map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    
    let node = &state.node;
    let faucet_amount = 10000_u64;

    // Rate limit: check if user already has a significant balance (anti-abuse)
    let bal = node.get_balance(&body.public_key).unwrap_or(0.0);
    if bal > 50000.0 {
        return Err((StatusCode::TOO_MANY_REQUESTS, Json(serde_json::json!({
            "success": false,
            "error": "faucet not available: your balance exceeds the faucet threshold"
        }))));
    }

    // Check mempool for existing faucet requests from this user
    {
        let mempool = node.get_mempool_snapshot();
        let pending_faucet = mempool.iter().any(|tx| {
            tx.payload.faucet == Some(true) && tx.payload.to_pub_key_hex.as_deref() == Some(&body.public_key)
        });
        if pending_faucet {
            return Err((StatusCode::TOO_MANY_REQUESTS, Json(serde_json::json!({
                "success": false,
                "error": "you already have a pending faucet request"
            }))));
        }
    }

    // Use the node's built-in faucet mechanism (creates a proper transfer tx from node key)
    node.submit_faucet_tx(&body.public_key, faucet_amount)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"success": false, "error": e}))))?;
    
    Ok(Json(serde_json::json!({
        "success": true,
        "message": format!("Faucet: {} XRGE sent", faucet_amount)
    })))
}

// ===== NFT V2 Write Handlers =====

async fn v2_nft_create_collection(
    State(state): State<AppState>,
    Json(body): Json<SignedTransactionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    use quantum_vault_types::{TxPayload, TxV1};

    let signed_payload = verify_signed_tx(&body).map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;

    let p = &body.payload;
    let symbol = p.get("symbol").and_then(|v| v.as_str()).unwrap_or_default();
    let name = p.get("name").and_then(|v| v.as_str()).unwrap_or_default();
    let description = p.get("description").and_then(|v| v.as_str()).map(String::from);
    let image = p.get("image").and_then(|v| v.as_str()).map(String::from);
    let max_supply = p.get("maxSupply").and_then(|v| v.as_u64());
    let royalty_bps = p.get("royaltyBps").and_then(|v| v.as_u64()).map(|v| v as u16);

    let nft_fee = 50.0_f64;
    let bal = state.node.get_balance(&body.public_key).unwrap_or(0.0);
    if bal < nft_fee {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": format!("insufficient XRGE balance for collection fee: have {:.4}, need {:.4}", bal, nft_fee)}))));
    }

    let tx = TxV1 {
        version: 1,
        tx_type: "nft_create_collection".to_string(),
        from_pub_key: body.public_key.clone(),
        nonce: chrono::Utc::now().timestamp_millis() as u64,
        payload: TxPayload {
            nft_collection_symbol: Some(symbol.to_string()),
            nft_collection_name: Some(name.to_string()),
            nft_description: description,
            nft_image: image,
            nft_max_supply: max_supply,
            nft_royalty_bps: royalty_bps,
            ..Default::default()
        },
        fee: nft_fee,
        sig: body.signature.clone(),
        signed_payload: Some(signed_payload),
    };

    state.node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;

    Ok(Json(serde_json::json!({
        "success": true,
        "message": "NFT collection creation submitted"
    })))
}

async fn v2_nft_mint(
    State(state): State<AppState>,
    Json(body): Json<SignedTransactionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    use quantum_vault_types::{TxPayload, TxV1};

    let signed_payload = verify_signed_tx(&body).map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;

    let p = &body.payload;
    let collection_id = p.get("collectionId").and_then(|v| v.as_str()).unwrap_or_default();
    let name = p.get("name").and_then(|v| v.as_str()).unwrap_or_default();
    let metadata_uri = p.get("metadataUri").and_then(|v| v.as_str()).map(String::from);
    let attributes = p.get("attributes").cloned();

    let mint_fee = 5.0_f64;
    let bal = state.node.get_balance(&body.public_key).unwrap_or(0.0);
    if bal < mint_fee {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": format!("insufficient XRGE balance for mint fee: have {:.4}, need {:.4}", bal, mint_fee)}))));
    }

    // Only the collection creator can mint
    if let Ok(Some(col)) = state.node.get_nft_collection(collection_id) {
        if col.creator != body.public_key {
            return Err((StatusCode::FORBIDDEN, Json(serde_json::json!({"success": false, "error": "only the collection creator can mint"}))));
        }
        if col.frozen {
            return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "collection is frozen"}))));
        }
        if let Some(max) = col.max_supply {
            if col.minted >= max {
                return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "collection has reached max supply"}))));
            }
        }
    } else {
        return Err((StatusCode::NOT_FOUND, Json(serde_json::json!({"success": false, "error": "collection not found"}))));
    }

    let tx = TxV1 {
        version: 1,
        tx_type: "nft_mint".to_string(),
        from_pub_key: body.public_key.clone(),
        nonce: chrono::Utc::now().timestamp_millis() as u64,
        payload: TxPayload {
            nft_collection_id: Some(collection_id.to_string()),
            nft_token_name: Some(name.to_string()),
            nft_metadata_uri: metadata_uri,
            nft_attributes: attributes,
            ..Default::default()
        },
        fee: mint_fee,
        sig: body.signature.clone(),
        signed_payload: Some(signed_payload),
    };

    state.node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;

    Ok(Json(serde_json::json!({
        "success": true,
        "message": "NFT mint submitted"
    })))
}

async fn v2_nft_batch_mint(
    State(state): State<AppState>,
    Json(body): Json<SignedTransactionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    use quantum_vault_types::{TxPayload, TxV1};

    let signed_payload = verify_signed_tx(&body).map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;

    let p = &body.payload;
    let collection_id = p.get("collectionId").and_then(|v| v.as_str()).unwrap_or_default();
    let names: Vec<String> = p.get("names")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    if names.is_empty() || names.len() > 50 {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "batch mint requires 1-50 names"}))));
    }

    let fee = 5.0 * names.len() as f64;
    let bal = state.node.get_balance(&body.public_key).unwrap_or(0.0);
    if bal < fee {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": format!("insufficient XRGE balance for batch mint fee: have {:.4}, need {:.4}", bal, fee)}))));
    }

    // Only the collection creator can mint
    if let Ok(Some(col)) = state.node.get_nft_collection(collection_id) {
        if col.creator != body.public_key {
            return Err((StatusCode::FORBIDDEN, Json(serde_json::json!({"success": false, "error": "only the collection creator can mint"}))));
        }
        if col.frozen {
            return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "collection is frozen"}))));
        }
        if let Some(max) = col.max_supply {
            if col.minted + names.len() as u64 > max {
                return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": format!("batch would exceed max supply ({} + {} > {})", col.minted, names.len(), max)}))));
            }
        }
    } else {
        return Err((StatusCode::NOT_FOUND, Json(serde_json::json!({"success": false, "error": "collection not found"}))));
    }

    let uris: Option<Vec<String>> = p.get("uris")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect());
    let attributes: Option<Vec<serde_json::Value>> = p.get("attributes")
        .and_then(|v| v.as_array())
        .map(|arr| arr.to_vec());

    let tx = TxV1 {
        version: 1,
        tx_type: "nft_batch_mint".to_string(),
        from_pub_key: body.public_key.clone(),
        nonce: chrono::Utc::now().timestamp_millis() as u64,
        payload: TxPayload {
            nft_collection_id: Some(collection_id.to_string()),
            nft_batch_names: Some(names),
            nft_batch_uris: uris,
            nft_batch_attributes: attributes,
            ..Default::default()
        },
        fee,
        sig: body.signature.clone(),
        signed_payload: Some(signed_payload),
    };

    state.node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;

    Ok(Json(serde_json::json!({
        "success": true,
        "message": "NFT batch mint submitted"
    })))
}

async fn v2_nft_transfer(
    State(state): State<AppState>,
    Json(body): Json<SignedTransactionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    use quantum_vault_types::{TxPayload, TxV1};

    let signed_payload = verify_signed_tx(&body).map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;

    let p = &body.payload;
    let collection_id = p.get("collectionId").and_then(|v| v.as_str()).unwrap_or_default();
    let token_id = p.get("tokenId").and_then(|v| v.as_u64()).unwrap_or(0);
    let to = p.get("to").and_then(|v| v.as_str()).unwrap_or_default();
    let sale_price = p.get("salePrice").and_then(|v| v.as_u64());

    let transfer_fee = 1.0_f64;

    // Calculate total XRGE needed (fee + royalty if sale)
    let mut xrge_needed = transfer_fee;
    if let Some(sp) = sale_price {
        if sp > 0 {
            if let Ok(Some(col)) = state.node.get_nft_collection(collection_id) {
                if col.royalty_bps > 0 {
                    xrge_needed += (sp as f64 * col.royalty_bps as f64) / 10000.0;
                }
            }
        }
    }

    let bal = state.node.get_balance(&body.public_key).unwrap_or(0.0);
    if bal < xrge_needed {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": format!("insufficient XRGE balance: have {:.4}, need {:.4} (fee + royalty)", bal, xrge_needed)}))));
    }

    // Ownership and lock check
    match state.node.get_nft_token(collection_id, token_id) {
        Ok(Some(token)) => {
            if token.owner != body.public_key {
                return Err((StatusCode::FORBIDDEN, Json(serde_json::json!({"success": false, "error": "you do not own this NFT"}))));
            }
            if token.locked {
                return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "NFT is locked"}))));
            }
        }
        _ => {
            return Err((StatusCode::NOT_FOUND, Json(serde_json::json!({"success": false, "error": "NFT not found"}))));
        }
    }

    let tx = TxV1 {
        version: 1,
        tx_type: "nft_transfer".to_string(),
        from_pub_key: body.public_key.clone(),
        nonce: chrono::Utc::now().timestamp_millis() as u64,
        payload: TxPayload {
            nft_collection_id: Some(collection_id.to_string()),
            nft_token_id: Some(token_id),
            to_pub_key_hex: Some(to.to_string()),
            amount: sale_price,
            ..Default::default()
        },
        fee: transfer_fee,
        sig: body.signature.clone(),
        signed_payload: Some(signed_payload),
    };

    state.node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;

    Ok(Json(serde_json::json!({
        "success": true,
        "message": "NFT transfer submitted"
    })))
}

async fn v2_nft_burn(
    State(state): State<AppState>,
    Json(body): Json<SignedTransactionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    use quantum_vault_types::{TxPayload, TxV1};

    let signed_payload = verify_signed_tx(&body).map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;

    let p = &body.payload;
    let collection_id = p.get("collectionId").and_then(|v| v.as_str()).unwrap_or_default();
    let token_id = p.get("tokenId").and_then(|v| v.as_u64()).unwrap_or(0);

    let burn_fee = 0.1_f64;
    let bal = state.node.get_balance(&body.public_key).unwrap_or(0.0);
    if bal < burn_fee {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": format!("insufficient XRGE balance for burn fee: have {:.4}, need {:.4}", bal, burn_fee)}))));
    }

    // Ownership check
    match state.node.get_nft_token(collection_id, token_id) {
        Ok(Some(token)) => {
            if token.owner != body.public_key {
                return Err((StatusCode::FORBIDDEN, Json(serde_json::json!({"success": false, "error": "you do not own this NFT"}))));
            }
        }
        _ => {
            return Err((StatusCode::NOT_FOUND, Json(serde_json::json!({"success": false, "error": "NFT not found"}))));
        }
    }

    let tx = TxV1 {
        version: 1,
        tx_type: "nft_burn".to_string(),
        from_pub_key: body.public_key.clone(),
        nonce: chrono::Utc::now().timestamp_millis() as u64,
        payload: TxPayload {
            nft_collection_id: Some(collection_id.to_string()),
            nft_token_id: Some(token_id),
            ..Default::default()
        },
        fee: 0.1,
        sig: body.signature.clone(),
        signed_payload: Some(signed_payload),
    };

    state.node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;

    Ok(Json(serde_json::json!({
        "success": true,
        "message": "NFT burn submitted"
    })))
}

async fn v2_nft_lock(
    State(state): State<AppState>,
    Json(body): Json<SignedTransactionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    use quantum_vault_types::{TxPayload, TxV1};

    let signed_payload = verify_signed_tx(&body).map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;

    let p = &body.payload;
    let collection_id = p.get("collectionId").and_then(|v| v.as_str()).unwrap_or_default();
    let token_id = p.get("tokenId").and_then(|v| v.as_u64()).unwrap_or(0);
    let locked = p.get("locked").and_then(|v| v.as_bool()).unwrap_or(true);

    let lock_fee = 0.1_f64;
    let bal = state.node.get_balance(&body.public_key).unwrap_or(0.0);
    if bal < lock_fee {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": format!("insufficient XRGE for lock fee: have {:.4}, need {:.4}", bal, lock_fee)}))));
    }

    // Ownership check
    match state.node.get_nft_token(collection_id, token_id) {
        Ok(Some(token)) => {
            if token.owner != body.public_key {
                return Err((StatusCode::FORBIDDEN, Json(serde_json::json!({"success": false, "error": "you do not own this NFT"}))));
            }
        }
        _ => {
            return Err((StatusCode::NOT_FOUND, Json(serde_json::json!({"success": false, "error": "NFT not found"}))));
        }
    }

    let tx = TxV1 {
        version: 1,
        tx_type: "nft_lock".to_string(),
        from_pub_key: body.public_key.clone(),
        nonce: chrono::Utc::now().timestamp_millis() as u64,
        payload: TxPayload {
            nft_collection_id: Some(collection_id.to_string()),
            nft_token_id: Some(token_id),
            nft_locked: Some(locked),
            ..Default::default()
        },
        fee: 0.1,
        sig: body.signature.clone(),
        signed_payload: Some(signed_payload),
    };

    state.node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;

    Ok(Json(serde_json::json!({
        "success": true,
        "message": "NFT lock toggled"
    })))
}

async fn v2_nft_freeze_collection(
    State(state): State<AppState>,
    Json(body): Json<SignedTransactionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    use quantum_vault_types::{TxPayload, TxV1};

    let signed_payload = verify_signed_tx(&body).map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;

    let p = &body.payload;
    let collection_id = p.get("collectionId").and_then(|v| v.as_str()).unwrap_or_default();
    let frozen = p.get("frozen").and_then(|v| v.as_bool()).unwrap_or(true);

    let freeze_fee = 0.1_f64;
    let bal = state.node.get_balance(&body.public_key).unwrap_or(0.0);
    if bal < freeze_fee {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": format!("insufficient XRGE for freeze fee: have {:.4}, need {:.4}", bal, freeze_fee)}))));
    }

    // Only the collection creator can freeze
    match state.node.get_nft_collection(collection_id) {
        Ok(Some(col)) => {
            if col.creator != body.public_key {
                return Err((StatusCode::FORBIDDEN, Json(serde_json::json!({"success": false, "error": "only the collection creator can freeze/unfreeze"}))));
            }
        }
        _ => {
            return Err((StatusCode::NOT_FOUND, Json(serde_json::json!({"success": false, "error": "collection not found"}))));
        }
    }

    let tx = TxV1 {
        version: 1,
        tx_type: "nft_freeze_collection".to_string(),
        from_pub_key: body.public_key.clone(),
        nonce: chrono::Utc::now().timestamp_millis() as u64,
        payload: TxPayload {
            nft_collection_id: Some(collection_id.to_string()),
            nft_frozen: Some(frozen),
            ..Default::default()
        },
        fee: 0.1,
        sig: body.signature.clone(),
        signed_payload: Some(signed_payload),
    };

    state.node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;

    Ok(Json(serde_json::json!({
        "success": true,
        "message": "Collection freeze toggled"
    })))
}

// ===== NFT Read-Only Query Handlers =====

async fn nft_list_collections(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let collections = state.node.list_nft_collections()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))))?;
    Ok(Json(serde_json::json!({ "collections": collections })))
}

async fn nft_get_collection(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let col = state.node.get_nft_collection(&id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))))?;
    match col {
        Some(c) => Ok(Json(serde_json::json!(c))),
        None => Err((StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Collection not found"})))),
    }
}

#[derive(Deserialize)]
struct NftTokensQuery {
    limit: Option<usize>,
    offset: Option<usize>,
}

async fn nft_get_collection_tokens(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<NftTokensQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let limit = q.limit.unwrap_or(50).min(200);
    let offset = q.offset.unwrap_or(0);
    let (tokens, total) = state.node.get_nft_tokens_by_collection(&id, limit, offset)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))))?;
    Ok(Json(serde_json::json!({ "tokens": tokens, "total": total, "limit": limit, "offset": offset })))
}

async fn nft_get_token(
    State(state): State<AppState>,
    Path((collection_id, token_id)): Path<(String, u64)>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let token = state.node.get_nft_token(&collection_id, token_id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))))?;
    match token {
        Some(t) => Ok(Json(serde_json::json!(t))),
        None => Err((StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "NFT not found"})))),
    }
}

async fn nft_get_owner_nfts(
    State(state): State<AppState>,
    Path(pubkey): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let nfts = state.node.get_nfts_by_owner(&pubkey)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))))?;
    Ok(Json(serde_json::json!({ "nfts": nfts })))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeConfigResponse {
    enabled: bool,
    custody_address: Option<String>,
    chain_id: u64,
}

async fn bridge_config(State(state): State<AppState>) -> Json<BridgeConfigResponse> {
    let (enabled, custody_address) = match &state.bridge_custody_address {
        Some(addr) if !addr.is_empty() => (true, Some(addr.clone())),
        _ => (false, None),
    };
    Json(BridgeConfigResponse {
        enabled,
        custody_address,
        chain_id: 84532, // Base Sepolia
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeClaimRequest {
    evm_tx_hash: String,
    evm_address: String,
    evm_signature: String, // personal_sign of claim message - proves sender owns the deposit
    recipient_rougechain_pubkey: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeClaimResponse {
    success: bool,
    tx_id: Option<String>,
    error: Option<String>,
}

async fn bridge_claim(
    State(state): State<AppState>,
    Json(body): Json<BridgeClaimRequest>,
) -> Result<Json<BridgeClaimResponse>, (StatusCode, Json<BridgeClaimResponse>)> {
    let custody = match &state.bridge_custody_address {
        Some(addr) if !addr.is_empty() => addr.clone(),
        _ => {
            return Ok(Json(BridgeClaimResponse {
                success: false,
                tx_id: None,
                error: Some("Bridge is not enabled (QV_BRIDGE_CUSTODY_ADDRESS not set)".to_string()),
            }));
        }
    };
    let tx_hash = body.evm_tx_hash.trim_start_matches("0x").to_lowercase();
    let tx_hash_hex = format!("0x{}", tx_hash);
    let evm_from = body.evm_address.trim().to_lowercase();
    let evm_from = if !evm_from.starts_with("0x") {
        format!("0x{}", evm_from)
    } else {
        evm_from
    };
    let recipient = normalize_recipient(&body.recipient_rougechain_pubkey);
    let custody_lower = custody.trim().to_lowercase();
    let custody = if !custody_lower.starts_with("0x") {
        format!("0x{}", custody_lower)
    } else {
        custody_lower
    };
    let evm_signature = body.evm_signature.trim();
    if evm_signature.is_empty() {
        return Ok(Json(BridgeClaimResponse {
            success: false,
            tx_id: None,
            error: Some("EVM signature required - sign the claim message with the wallet that sent the ETH".to_string()),
        }));
    }

    if state.bridge_claim_store.contains(&tx_hash_hex).await {
        return Ok(Json(BridgeClaimResponse {
            success: false,
            tx_id: None,
            error: Some("Transaction already claimed".to_string()),
        }));
    }

    let rpc_url = state.base_sepolia_rpc.clone();
    let client = reqwest::Client::new();
    const BASE_SEPOLIA_CHAIN_ID: u64 = 84532;
    const MIN_CONFIRMATIONS: u64 = 1;
    let chain_resp = client.post(&rpc_url).json(&serde_json::json!({"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1})).send().await;
    if let Ok(r) = chain_resp {
        if let Ok(json) = r.json::<serde_json::Value>().await {
            if let Some(hex) = json.get("result").and_then(|v| v.as_str()) {
                let id = u64::from_str_radix(hex.trim_start_matches("0x"), 16).unwrap_or(0);
                if id != BASE_SEPOLIA_CHAIN_ID {
                    return Ok(Json(BridgeClaimResponse {
                        success: false, tx_id: None,
                        error: Some(format!("Wrong chain: expected Base Sepolia ({}), got {}", BASE_SEPOLIA_CHAIN_ID, id)),
                    }));
                }
            }
        }
    }
    let resp = client
        .post(&rpc_url)
        .json(&serde_json::json!({"jsonrpc":"2.0","method":"eth_getTransactionByHash","params":[tx_hash_hex],"id":1}))
        .send()
        .await;
    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            return Ok(Json(BridgeClaimResponse {
                success: false,
                tx_id: None,
                error: Some(format!("Failed to fetch transaction: {}", e)),
            }));
        }
    };
    let json: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            return Ok(Json(BridgeClaimResponse {
                success: false,
                tx_id: None,
                error: Some(format!("Invalid RPC response: {}", e)),
            }));
        }
    };
    let result = json.get("result");
    let tx = match result {
        Some(serde_json::Value::Null) => {
            return Ok(Json(BridgeClaimResponse {
                success: false,
                tx_id: None,
                error: Some("Transaction not found or not yet mined".to_string()),
            }));
        }
        Some(obj) => obj,
        None => {
            return Ok(Json(BridgeClaimResponse {
                success: false,
                tx_id: None,
                error: Some(json.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()).unwrap_or("RPC error").to_string()),
            }));
        }
    };
    let tx_to = tx.get("to").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
    let tx_from = tx.get("from").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
    let tx_value = tx.get("value").and_then(|v| v.as_str()).unwrap_or("0x0");
    let value_wei = u128::from_str_radix(tx_value.trim_start_matches("0x"), 16).unwrap_or(0);
    if tx_to != custody {
        return Ok(Json(BridgeClaimResponse {
            success: false,
            tx_id: None,
            error: Some(format!("Transaction recipient mismatch: expected {}, got {}", custody, tx_to)),
        }));
    }
    if tx_from != evm_from {
        return Ok(Json(BridgeClaimResponse {
            success: false,
            tx_id: None,
            error: Some(format!("Transaction sender mismatch: expected {}, got {}", evm_from, tx_from)),
        }));
    }
    // Verify EVM signature: signer must be tx_from (deposit sender). Message format must match frontend.
    let claim_message = format!("RougeChain bridge claim\nTx: {}\nRecipient: {}", tx_hash_hex, recipient);
    let sig_bytes = hex::decode(evm_signature.trim_start_matches("0x")).unwrap_or_default();
    let sig_valid = eth_ecdsa_verifier::validate_ecdsa_signature(
        &evm_from,
        claim_message.as_bytes(),
        &sig_bytes,
    );
    if !sig_valid.unwrap_or(false) {
        return Ok(Json(BridgeClaimResponse {
            success: false,
            tx_id: None,
            error: Some("Invalid signature - sign the claim message with the wallet that sent the ETH".to_string()),
        }));
    }
    if value_wei == 0 {
        return Ok(Json(BridgeClaimResponse {
            success: false,
            tx_id: None,
            error: Some("Transaction has zero value".to_string()),
        }));
    }
    let block_hex = tx.get("blockNumber").and_then(|v| v.as_str()).unwrap_or("");
    if block_hex.is_empty() || block_hex == "null" {
        return Ok(Json(BridgeClaimResponse {
            success: false,
            tx_id: None,
            error: Some("Transaction not yet mined".to_string()),
        }));
    }
    let tx_block = u64::from_str_radix(block_hex.trim_start_matches("0x"), 16).unwrap_or(0);
    let latest_resp = client
        .post(&rpc_url)
        .json(&serde_json::json!({"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}))
        .send()
        .await;
    if let Ok(r) = latest_resp {
        if let Ok(j) = r.json::<serde_json::Value>().await {
            if let Some(hex) = j.get("result").and_then(|v| v.as_str()) {
                let latest = u64::from_str_radix(hex.trim_start_matches("0x"), 16).unwrap_or(0);
                if latest < tx_block + MIN_CONFIRMATIONS {
                    return Ok(Json(BridgeClaimResponse {
                        success: false, tx_id: None,
                        error: Some(format!("Need {} confirmations (tx block {}, latest {})", MIN_CONFIRMATIONS, tx_block, latest)),
                    }));
                }
            }
        }
    }
    let amount_units = (value_wei / 1_000_000_000_000) as u64;
    if amount_units == 0 {
        return Ok(Json(BridgeClaimResponse {
            success: false,
            tx_id: None,
            error: Some("Amount too small (min 0.000001 ETH)".to_string()),
        }));
    }

    if let Err(e) = state.bridge_claim_store.insert(tx_hash_hex.clone()).await {
        return Ok(Json(BridgeClaimResponse {
            success: false,
            tx_id: None,
            error: Some(format!("Failed to persist claim: {}", e)),
        }));
    }

    use quantum_vault_crypto::{bytes_to_hex, sha256};
    use quantum_vault_types::encode_tx_v1;
    match state.node.submit_bridge_mint_tx(&recipient, amount_units, "qETH") {
        Ok(tx) => {
            let id = bytes_to_hex(&sha256(&encode_tx_v1(&tx)));
            Ok(Json(BridgeClaimResponse {
                success: true,
                tx_id: Some(id),
                error: None,
            }))
        }
        Err(e) => Ok(Json(BridgeClaimResponse {
            success: false,
            tx_id: None,
            error: Some(e),
        })),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeWithdrawRequest {
    from_private_key: String,
    from_public_key: String,
    amount_units: u64,
    evm_address: String,
    fee: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeWithdrawResponse {
    success: bool,
    tx_id: Option<String>,
    error: Option<String>,
}

async fn bridge_withdraw(
    State(state): State<AppState>,
    Json(body): Json<BridgeWithdrawRequest>,
) -> Result<Json<BridgeWithdrawResponse>, (StatusCode, Json<BridgeWithdrawResponse>)> {
    if state.bridge_custody_address.is_none() || state.bridge_custody_address.as_ref().map(|s| s.is_empty()).unwrap_or(true) {
        return Ok(Json(BridgeWithdrawResponse {
            success: false,
            tx_id: None,
            error: Some("Bridge is not enabled (QV_BRIDGE_CUSTODY_ADDRESS not set)".to_string()),
        }));
    }
    if body.amount_units == 0 {
        return Ok(Json(BridgeWithdrawResponse {
            success: false,
            tx_id: None,
            error: Some("Amount must be greater than 0".to_string()),
        }));
    }
    match state.node.submit_bridge_withdraw_tx(
        &body.from_private_key,
        &body.from_public_key,
        body.amount_units,
        &body.evm_address,
        body.fee,
    ) {
        Ok(tx) => {
            let id = quantum_vault_crypto::bytes_to_hex(&quantum_vault_crypto::sha256(&quantum_vault_types::encode_tx_v1(&tx)));
            state.ws_broadcaster.broadcast_new_tx(
                &id,
                &tx.tx_type,
                &tx.from_pub_key,
                tx.payload.evm_address.as_deref(),
                tx.payload.amount,
            );
            let peers = state.peer_manager.get_peers().await;
            if !peers.is_empty() {
                peer::broadcast_tx(&peers, &tx);
            }
            Ok(Json(BridgeWithdrawResponse {
                success: true,
                tx_id: Some(id),
                error: None,
            }))
        }
        Err(e) => Ok(Json(BridgeWithdrawResponse {
            success: false,
            tx_id: None,
            error: Some(e),
        })),
    }
}

#[derive(Serialize)]
struct BridgeWithdrawalsResponse {
    withdrawals: Vec<BridgeWithdrawalItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeWithdrawalItem {
    tx_id: String,
    evm_address: String,
    amount_units: u64,
    created_at: i64,
}

async fn bridge_withdrawals(State(state): State<AppState>) -> Json<BridgeWithdrawalsResponse> {
    let list = state.bridge_withdraw_store.list().unwrap_or_default();
    Json(BridgeWithdrawalsResponse {
        withdrawals: list
            .into_iter()
            .map(|w| BridgeWithdrawalItem {
                tx_id: w.tx_id,
                evm_address: w.evm_address,
                amount_units: w.amount_units,
                created_at: w.created_at,
            })
            .collect(),
    })
}

#[derive(Serialize)]
struct BridgeFulfillResponse {
    success: bool,
    error: Option<String>,
}

async fn bridge_withdrawal_fulfill(
    State(state): State<AppState>,
    Path(tx_id): Path<String>,
    Json(body): Json<SignedTransactionRequest>,
) -> Json<BridgeFulfillResponse> {
    // Only the node operator can fulfill withdrawals
    let node_pub_key = state.node.get_node_public_key();
    if body.public_key != node_pub_key {
        return Json(BridgeFulfillResponse {
            success: false,
            error: Some("unauthorized: only the node operator can fulfill withdrawals".to_string()),
        });
    }
    if let Err(e) = verify_signed_tx(&body) {
        return Json(BridgeFulfillResponse {
            success: false,
            error: Some(format!("signature verification failed: {}", e)),
        });
    }

    match state.bridge_withdraw_store.remove(&tx_id) {
        Ok(true) => Json(BridgeFulfillResponse {
            success: true,
            error: None,
        }),
        Ok(false) => Json(BridgeFulfillResponse {
            success: false,
            error: Some("Withdrawal not found or already fulfilled".to_string()),
        }),
        Err(e) => Json(BridgeFulfillResponse {
            success: false,
            error: Some(e),
        }),
    }
}

fn default_data_dir(node_name: &str) -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".quantum-vault").join(node_name)
}
