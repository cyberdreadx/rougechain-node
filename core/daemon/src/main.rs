mod amm;
mod bridge_verifier;
mod dashboard;
mod grpc;
mod nft_store;
mod pool_events;
mod node;
mod peer;
mod pool_store;
mod order_book;
mod rollup;
mod websocket;
mod jsonrpc;
mod indexer;

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration as StdDuration, Instant};
use std::sync::RwLock;

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
use tower_http::cors::{Any, AllowOrigin, CorsLayer};

use crate::websocket::WsBroadcaster;

use quantum_vault_storage::bridge_claim_store::BridgeClaimStore;
use quantum_vault_storage::bridge_withdraw_store::BridgeWithdrawStore;

use crate::grpc::GrpcNode;
use crate::node::{L1Node, NodeOptions};
use crate::pool_store::LiquidityPool;
use crate::pool_events::{PoolEvent, PoolStats, PriceSnapshot};
use quantum_vault_types::ChainConfig;

/// Genesis configuration loaded from JSON file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenesisConfig {
    pub chain_id: String,
    #[serde(default)]
    pub genesis_time: u64,
    #[serde(default = "default_block_time")]
    pub block_time_ms: u64,
    #[serde(default)]
    pub max_validators: u32,
    #[serde(default)]
    pub min_stake: u64,
    #[serde(default)]
    pub max_supply: u64,
    #[serde(default)]
    pub initial_allocations: Vec<GenesisAllocation>,
    #[serde(default)]
    pub initial_validators: Vec<GenesisValidator>,
    #[serde(default)]
    pub faucet_enabled: bool,
    #[serde(default)]
    pub dev_mode: bool,
    // Network economic params (informational — constants are in node.rs)
    #[serde(default)]
    pub unbonding_blocks: Option<u64>,
    #[serde(default)]
    pub slash_divisor: Option<u64>,
    #[serde(default)]
    pub missed_block_threshold: Option<u64>,
    #[serde(default)]
    pub jail_blocks: Option<u64>,
    #[serde(default)]
    pub treasury_fee_pct: Option<u32>,
    #[serde(default)]
    pub proposer_fee_pct: Option<u32>,
    #[serde(default)]
    pub validator_fee_pct: Option<u32>,
}

fn default_block_time() -> u64 { 400 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenesisAllocation {
    pub address: String,
    pub amount: u64,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenesisValidator {
    pub pub_key: String,
    pub stake: u64,
    #[serde(default)]
    pub name: Option<String>,
}
use quantum_vault_vm::{WasmRuntime, ContractStore, ContractCallResult};

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
    /// Enable legacy v1 endpoints that accept private keys (UNSAFE — for local dev only)
    #[arg(long)]
    dev: bool,
    /// Human-readable name for this node (shown on the network globe)
    #[arg(long, env = "QV_NODE_NAME")]
    node_name: Option<String>,
    /// Path to genesis JSON file (e.g. genesis.json for mainnet params)
    #[arg(long, env = "QV_GENESIS")]
    genesis: Option<String>,
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
    bridge_relayer_secret: Option<String>,
    xrge_bridge_vault: Option<String>,
    xrge_bridge_token: String,
    faucet_cooldowns: Arc<tokio::sync::Mutex<HashMap<String, i64>>>,
    dev_mode: bool,
    node_name: Option<String>,
    response_cache: Arc<RwLock<HashMap<String, (Instant, String)>>>,
    rollup_accumulator: Arc<tokio::sync::Mutex<rollup::RollupAccumulator>>,
    /// Address registry: SHA-256(pubkey) hex → pubkey hex
    address_registry: Arc<RwLock<HashMap<String, String>>>,
    /// WASM smart contract runtime
    wasm_runtime: Arc<WasmRuntime>,
    /// WASM contract persistent storage
    contract_store: Arc<ContractStore>,
    /// Off-chain event indexer
    indexer: Arc<indexer::Indexer>,
    /// On-chain limit order book
    order_book: Arc<order_book::OrderBook>,
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
    // Load genesis config if provided
    let genesis_config = if let Some(ref genesis_path) = args.genesis {
        let genesis_data = std::fs::read_to_string(genesis_path)
            .map_err(|e| format!("Failed to read genesis file '{}': {}", genesis_path, e))?;
        let gc: GenesisConfig = serde_json::from_str(&genesis_data)
            .map_err(|e| format!("Failed to parse genesis file: {}", e))?;
        eprintln!("[main] Loaded genesis config: chain_id={}, allocations={}, validators={}",
            gc.chain_id, gc.initial_allocations.len(), gc.initial_validators.len());
        Some(gc)
    } else {
        None
    };

    let chain = if let Some(ref gc) = genesis_config {
        ChainConfig {
            chain_id: gc.chain_id.clone(),
            genesis_time: if gc.genesis_time > 0 { gc.genesis_time } else { chrono::Utc::now().timestamp_millis() as u64 },
            block_time_ms: gc.block_time_ms,
        }
    } else {
        ChainConfig {
            chain_id: args.chain_id.clone(),
            genesis_time: chrono::Utc::now().timestamp_millis() as u64,
            block_time_ms: args.block_time_ms,
        }
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
    node.backfill_address_index();

    // Apply genesis allocations on first boot (chain height == 0)
    if let Some(ref gc) = genesis_config {
        let current_height = node.tip_height().unwrap_or(0);
        if current_height == 0 && !gc.initial_allocations.is_empty() {
            eprintln!("[main] Applying genesis allocations (chain is fresh)...");
            if let Err(e) = node.apply_genesis_allocations(&gc.initial_allocations, &gc.initial_validators) {
                eprintln!("[main] WARNING: Failed to apply genesis allocations: {}", e);
            } else {
                let total: u64 = gc.initial_allocations.iter().map(|a| a.amount).sum();
                eprintln!("[main] Genesis: credited {} XRGE across {} addresses, {} validators staked",
                    total, gc.initial_allocations.len(), gc.initial_validators.len());
            }
        }
    }

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
    let peer_manager = Arc::new(peer::PeerManager::new(initial_peers.clone(), args.public_url.clone(), args.node_name.clone()));
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
        bridge_relayer_secret: std::env::var("BRIDGE_RELAYER_SECRET").ok().filter(|s| !s.is_empty()),
        xrge_bridge_vault: std::env::var("XRGE_BRIDGE_VAULT").ok().filter(|s| !s.is_empty()),
        xrge_bridge_token: std::env::var("XRGE_BRIDGE_TOKEN")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "0xF9e744a43608AB7D64a106df84e52915e8Efa27E".to_string()),
        faucet_cooldowns: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        dev_mode: args.dev,
        node_name: args.node_name.clone(),
        response_cache: Arc::new(RwLock::new(HashMap::new())),
        rollup_accumulator: Arc::new(tokio::sync::Mutex::new(rollup::RollupAccumulator::new())),
        address_registry: Arc::new(RwLock::new(HashMap::new())),
        wasm_runtime: Arc::new(WasmRuntime::new().expect("Failed to create WASM runtime")),
        contract_store: Arc::new(ContractStore::new(&data_dir_clone).expect("Failed to create contract store")),
        indexer: Arc::new(indexer::Indexer::new(&data_dir_clone).expect("Failed to create indexer")),
        order_book: Arc::new(order_book::OrderBook::new(&data_dir_clone).expect("Failed to create order book")),
    };
    
    // Backfill indexer on startup
    {
        let idx = app_state.indexer.clone();
        let store = app_state.node.store_ref();
        match idx.backfill(store) {
            Ok(n) if n > 0 => eprintln!("[indexer] Backfilled {} events", n),
            _ => {}
        }
    }

    eprintln!("[core-daemon] WebSocket broadcaster initialized");

    // Start peer sync
    {
        let peer_node = node.clone();
        let pm = peer_manager.clone();
        tokio::spawn(async move {
            peer::start_peer_sync(pm, peer_node).await;
        });
    }

    // Background: clean up expired self-destruct messages every 30s
    {
        let cleanup_node = node.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(StdDuration::from_secs(30));
            loop {
                interval.tick().await;
                match cleanup_node.cleanup_expired_messages() {
                    Ok(n) if n > 0 => {
                        eprintln!("[messenger] cleaned up {} expired self-destruct message(s)", n);
                    }
                    Err(e) => {
                        eprintln!("[messenger] cleanup error: {}", e);
                    }
                    _ => {}
                }
            }
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
        let idx_bc = app_state.indexer.clone();
        let ob_bc = app_state.order_book.clone();
        tokio::spawn(async move {
            loop {
                if let Ok(Some(block)) = miner.mine_pending() {
                    eprintln!("[miner] Mined block {}", block.header.height);
                    
                    // Broadcast to WebSocket clients
                    ws_bc.broadcast_new_block(&block);

                    // Index the block
                    let _ = idx_bc.index_block(&block);

                    // Process limit orders from this block
                    let block_height = block.header.height;
                    for tx in &block.txs {
                        match tx.tx_type.as_str() {
                            "place_limit_order" => {
                                let token_in = tx.payload.token_a_symbol.as_deref().unwrap_or("");
                                let token_out = tx.payload.token_b_symbol.as_deref().unwrap_or("");
                                let amount_in = tx.payload.amount_a.unwrap_or(0);
                                let min_out = tx.payload.min_amount_out.unwrap_or(0);
                                let expires = tx.payload.limit_order_expires.unwrap_or(0);
                                if !token_in.is_empty() && !token_out.is_empty() && amount_in > 0 && min_out > 0 {
                                    let pool_id = crate::pool_store::LiquidityPool::make_pool_id(token_in, token_out);
                                    let order_id = tx.payload.limit_order_id.clone()
                                        .unwrap_or_else(|| format!("lo-{}-{}", block_height, tx.nonce));
                                    let order = crate::order_book::LimitOrder {
                                        order_id: order_id.clone(),
                                        owner_pub_key: tx.from_pub_key.clone(),
                                        pool_id,
                                        token_in: token_in.to_string(),
                                        token_out: token_out.to_string(),
                                        amount_in,
                                        min_amount_out: min_out,
                                        created_at_height: block_height,
                                        expires_at_height: expires,
                                        status: crate::order_book::OrderStatus::Open,
                                        filled_at_height: None,
                                        filled_amount_out: None,
                                    };
                                    if let Err(e) = ob_bc.place_order(&order) {
                                        eprintln!("[orders] Failed to place order {}: {}", order_id, e);
                                    } else {
                                        eprintln!("[orders] Placed limit order {} ({} {} → min {} {})",
                                            order_id, amount_in, token_in, min_out, token_out);
                                    }
                                }
                            }
                            "cancel_limit_order" => {
                                if let Some(order_id) = &tx.payload.limit_order_id {
                                    match ob_bc.cancel_order(order_id, &tx.from_pub_key) {
                                        Ok(_) => eprintln!("[orders] Cancelled order {}", order_id),
                                        Err(e) => eprintln!("[orders] Cancel failed for {}: {}", order_id, e),
                                    }
                                }
                            }
                            _ => {}
                        }
                    }

                    // Expire stale orders
                    let _ = ob_bc.expire_orders_at_height(block_height);

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
        .route("/", get(dashboard::node_dashboard))
        .route("/api/ws", get(ws_handler))
        .route("/rpc", post(rpc_handler))
        .route("/api/rpc", post(rpc_handler))
        .route("/api/indexer/address/:address", get(indexer_by_address))
        .route("/api/indexer/type/:tx_type", get(indexer_by_type))
        .route("/api/indexer/token/:symbol", get(indexer_by_token))
        .route("/api/indexer/block/:height", get(indexer_by_block))
        .route("/api/indexer/stats", get(indexer_stats))
        .route("/metrics", get(prometheus_metrics))
        .route("/api/orders", get(get_all_orders))
        .route("/api/orders/pool/:pool_id", get(get_pool_orders))
        .route("/api/orders/user/:pubkey", get(get_user_orders))
        .route("/api/orders/:order_id", get(get_order_by_id))
        .route("/api/stats", get(get_stats))
        .route("/api/fee", get(get_fee_info))
        .route("/api/finality/:height", get(get_finality_proof))
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
        .route("/api/tx/:hash/receipt", get(get_tx_receipt))
        .route("/api/account/:pubkey/nonce", get(get_account_nonce))
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
        .route("/api/messenger/messages/:id", delete(delete_messenger_message))
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
        .route("/api/v2/token/metadata/update", post(v2_update_token_metadata))
        .route("/api/v2/token/metadata/claim", post(v2_claim_token_metadata))
        // Token allowance endpoints (ERC-20 approve/transferFrom)
        .route("/api/v2/token/approve", post(v2_token_approve))
        .route("/api/v2/token/transfer-from", post(v2_token_transfer_from))
        .route("/api/v2/token/freeze", post(v2_token_freeze))
        .route("/api/v2/token/mint", post(v2_token_mint))
        .route("/api/token/allowance", get(get_token_allowance))
        .route("/api/token/allowances", get(get_token_allowances))
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
        // Shielded transaction endpoints
        .route("/api/v2/shielded/shield", post(v2_shield))
        .route("/api/v2/shielded/transfer", post(v2_shielded_transfer))
        .route("/api/v2/shielded/unshield", post(v2_unshield))
        .route("/api/shielded/stats", get(shielded_stats))
        .route("/api/shielded/nullifier/:hash", get(shielded_nullifier_check))
        .route("/api/bridge/config", get(bridge_config))
        .route("/api/bridge/claim", post(bridge_claim))
        .route("/api/bridge/withdraw", post(bridge_withdraw))
        .route("/api/bridge/withdrawals", get(bridge_withdrawals))
        .route("/api/bridge/withdrawals/:tx_id", delete(bridge_withdrawal_fulfill))
        // XRGE bridge endpoints
        .route("/api/bridge/xrge/config", get(xrge_bridge_config))
        .route("/api/bridge/xrge/claim", post(xrge_bridge_claim))
        .route("/api/bridge/xrge/withdraw", post(xrge_bridge_withdraw))
        .route("/api/bridge/xrge/withdrawals", get(xrge_bridge_withdrawals))
        .route("/api/bridge/xrge/withdrawals/:tx_id", delete(xrge_bridge_fulfill))
        // Rollup endpoints (Phase 3)
        .route("/api/v2/rollup/status", get(rollup_status))
        .route("/api/v2/rollup/batch/:id", get(rollup_get_batch))
        .route("/api/v2/rollup/submit", post(rollup_submit_transfer))
        // Address resolution
        .route("/api/resolve/:input", get(resolve_address))
        // Push notification registration
        .route("/api/push/register", post(push_register))
        .route("/api/push/unregister", post(push_unregister))
        // Token locking endpoints
        .route("/api/locks/:pubkey", get(get_locks))
        // Token staking endpoints
        .route("/api/staking/pools", get(get_staking_pools))
        .route("/api/staking/pool/:pool_id", get(get_staking_pool))
        .route("/api/staking/stakes/:pubkey", get(get_stakes_by_owner))
        .route("/api/staking/pool/:pool_id/stakes", get(get_stakes_by_pool))
        // Governance endpoints
        .route("/api/governance/proposals", get(get_proposals))
        .route("/api/governance/proposals/:token", get(get_proposals_by_token))
        .route("/api/governance/proposal/:id", get(get_proposal_detail))
        .route("/api/governance/proposal/:id/votes", get(get_proposal_votes))
        .route("/api/governance/delegations", get(get_all_delegations))
        .route("/api/governance/delegation/:pubkey", get(get_delegation))
        // Allowance endpoints
        .route("/api/allowances/:pubkey", get(get_allowances))
        // WASM contract endpoints
        .route("/api/v2/contract/deploy", post(contract_deploy))
        .route("/api/v2/contract/call", post(contract_call))
        .route("/api/contract/:addr", get(contract_get))
        .route("/api/contract/:addr/state", get(contract_state))
        .route("/api/contract/:addr/events", get(contract_events))
        .route("/api/contracts", get(contract_list))
        // EIP-1559 fee info
        .route("/api/fee-info", get(fee_info))
        // Multi-sig wallet endpoints
        .route("/api/multisig/wallets", get(multisig_list_wallets))
        .route("/api/multisig/wallet/:wallet_id", get(multisig_get_wallet))
        .route("/api/multisig/wallet/:wallet_id/proposals", get(multisig_get_proposals))
        .route("/api/multisig/wallets/:pubkey", get(multisig_wallets_by_signer))
        .layer(middleware::from_fn_with_state(state.clone(), auth_middleware))
        .layer({
            let cors_origins = std::env::var("QV_CORS_ORIGINS")
                .ok()
                .filter(|s| !s.is_empty());
            let cors = CorsLayer::new()
                .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE, Method::OPTIONS, Method::PATCH])
                .allow_headers(Any);
            match cors_origins {
                Some(origins) if origins != "*" => {
                    let allowed: Vec<axum::http::HeaderValue> = origins
                        .split(',')
                        .filter_map(|o| o.trim().parse().ok())
                        .collect();
                    cors.allow_origin(AllowOrigin::list(allowed))
                }
                _ if state.dev_mode => cors.allow_origin(Any),
                _ => cors.allow_origin(AllowOrigin::list([
                    "http://localhost:5173".parse().unwrap(),
                    "http://localhost:4173".parse().unwrap(),
                    "http://127.0.0.1:5173".parse().unwrap(),
                    "https://rougechain.io".parse().unwrap(),
                    "https://www.rougechain.io".parse().unwrap(),
                    "https://testnet.rougechain.io".parse().unwrap(),
                    "https://rougee.app".parse().unwrap(),
                    "https://www.rougee.app".parse().unwrap(),
                ])),
            }
        })
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
    if path == "/" || path == "/api/health" || path == "/api/stats" {
        return Ok(next.run(request).await);
    }
    // v1 endpoints that accept private keys — block unless --dev flag is set
    const V1_KEY_ENDPOINTS: &[&str] = &[
        "/api/tx/submit",
        "/api/stake/submit",
        "/api/unstake/submit",
        "/api/token/create",
        "/api/pool/create",
        "/api/pool/add-liquidity",
        "/api/pool/remove-liquidity",
        "/api/swap/execute",
        "/api/token/metadata/update",
        "/api/token/metadata/claim",
        "/api/wallet/create",
    ];
    if V1_KEY_ENDPOINTS.iter().any(|ep| path == *ep) {
        if !state.dev_mode {
            return Err(StatusCode::GONE);
        }
        return Ok(next.run(request).await);
    }
    // Auth bypass for endpoints that handle their own auth (v2 uses signatures, faucet/bridge are public)
    let skip_auth = path == "/api/faucet"
        || path.starts_with("/api/bridge/")
        || path.starts_with("/api/v2/")
        || path.starts_with("/api/messenger/")
        || path.starts_with("/api/mail/")
        || path.starts_with("/api/names/");

    if !skip_auth && state.auth.is_enabled() {
        let api_key = extract_api_key(request.headers());
        if !state.auth.is_valid(api_key.as_deref()) {
            return Err(StatusCode::UNAUTHORIZED);
        }
    }

    // Rate limiting applies to ALL endpoints
    let client_key = client_key(&request);

    let limit = determine_rate_limit_tier(&state, &request).await;

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
    // Tier 1: validator must prove key ownership by signing a recent timestamp
    // Headers: X-Validator-Key (pubkey), X-Validator-Sig (signature of timestamp), X-Validator-Ts (unix ms)
    if let (Some(validator_key), Some(validator_sig), Some(validator_ts)) = (
        request.headers().get("x-validator-key"),
        request.headers().get("x-validator-sig"),
        request.headers().get("x-validator-ts"),
    ) {
        if let (Ok(key_str), Ok(sig_str), Ok(ts_str)) = (
            validator_key.to_str(),
            validator_sig.to_str(),
            validator_ts.to_str(),
        ) {
            if let Ok(ts) = ts_str.parse::<i64>() {
                let now = chrono::Utc::now().timestamp_millis();
                let drift = (now - ts).abs();
                // Reject timestamps older than 30 seconds
                if drift < 30_000 {
                    if is_active_validator(&state.node, key_str) {
                        if let Ok(true) = quantum_vault_crypto::pqc_verify(
                            key_str,
                            ts_str.as_bytes(),
                            sig_str,
                        ) {
                            return state.validator_limit; // Tier 1 — proven
                        }
                    }
                }
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
    // Prefer actual socket address to prevent IP spoofing via headers (MED-03)
    if let Some(info) = request.extensions().get::<axum::extract::ConnectInfo<SocketAddr>>() {
        return info.0.ip().to_string();
    }
    // Fallback only when ConnectInfo is unavailable (e.g., behind trusted reverse proxy)
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
    "unknown".to_string()
}

// JSON-RPC 2.0 handler (supports single + batch requests)
async fn rpc_handler(
    State(state): State<AppState>,
    axum::Json(body): axum::Json<serde_json::Value>,
) -> impl IntoResponse {
    // Batch request (array)
    if let Some(arr) = body.as_array() {
        let mut responses = Vec::new();
        for item in arr {
            if let Ok(req) = serde_json::from_value::<jsonrpc::JsonRpcRequest>(item.clone()) {
                responses.push(jsonrpc::handle_rpc(&state, req).await);
            } else {
                responses.push(jsonrpc::JsonRpcResponse::error(
                    serde_json::Value::Null, -32600, "Invalid request",
                ));
            }
        }
        return axum::Json(serde_json::to_value(responses).unwrap_or_default());
    }
    // Single request
    match serde_json::from_value::<jsonrpc::JsonRpcRequest>(body) {
        Ok(req) => axum::Json(serde_json::to_value(jsonrpc::handle_rpc(&state, req).await).unwrap_or_default()),
        Err(_) => axum::Json(serde_json::to_value(jsonrpc::JsonRpcResponse::error(
            serde_json::Value::Null, -32700, "Parse error",
        )).unwrap_or_default()),
    }
}

// ── Indexer API Handlers ──────────────────────────────────────────

#[derive(Deserialize)]
struct IndexerQuery {
    #[serde(default = "default_limit")]
    limit: usize,
    #[serde(default)]
    offset: usize,
}
fn default_limit() -> usize { 50 }

async fn indexer_by_address(
    State(state): State<AppState>,
    Path(address): Path<String>,
    Query(q): Query<IndexerQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    match state.indexer.query_by_address(&address, q.limit.min(200), q.offset) {
        Ok(evts) => Ok(Json(serde_json::json!({"events": evts, "count": evts.len()}))),
        Err(e) => Ok(Json(serde_json::json!({"error": e}))),
    }
}

async fn indexer_by_type(
    State(state): State<AppState>,
    Path(tx_type): Path<String>,
    Query(q): Query<IndexerQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    match state.indexer.query_by_type(&tx_type, q.limit.min(200), q.offset) {
        Ok(evts) => Ok(Json(serde_json::json!({"events": evts, "count": evts.len()}))),
        Err(e) => Ok(Json(serde_json::json!({"error": e}))),
    }
}

async fn indexer_by_token(
    State(state): State<AppState>,
    Path(symbol): Path<String>,
    Query(q): Query<IndexerQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    match state.indexer.query_by_token(&symbol, q.limit.min(200), q.offset) {
        Ok(evts) => Ok(Json(serde_json::json!({"events": evts, "count": evts.len()}))),
        Err(e) => Ok(Json(serde_json::json!({"error": e}))),
    }
}

async fn indexer_by_block(
    State(state): State<AppState>,
    Path(height): Path<u64>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    match state.indexer.query_by_block(height) {
        Ok(evts) => Ok(Json(serde_json::json!({"events": evts, "count": evts.len()}))),
        Err(e) => Ok(Json(serde_json::json!({"error": e}))),
    }
}

async fn indexer_stats(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    Ok(Json(serde_json::json!({
        "totalEvents": state.indexer.event_count(),
        "highestIndexedBlock": state.indexer.highest_indexed_block(),
    })))
}

// ── Limit Order API ─────────────────────────────────────────────

async fn get_all_orders(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let status = params.get("status").cloned();
    let filter = match status.as_deref() {
        Some("open") => Some(order_book::OrderStatus::Open),
        Some("filled") => Some(order_book::OrderStatus::Filled),
        Some("cancelled") => Some(order_book::OrderStatus::Cancelled),
        Some("expired") => Some(order_book::OrderStatus::Expired),
        _ => None,
    };
    let orders = state.order_book.list_all_orders(filter)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({
        "orders": orders,
        "count": orders.len(),
    })))
}

async fn get_pool_orders(
    State(state): State<AppState>,
    Path(pool_id): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let orders = state.order_book.get_open_orders_for_pool(&pool_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({
        "pool_id": pool_id,
        "orders": orders,
        "count": orders.len(),
    })))
}

async fn get_user_orders(
    State(state): State<AppState>,
    Path(pubkey): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let orders = state.order_book.get_user_orders(&pubkey)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({
        "owner": pubkey,
        "orders": orders,
        "count": orders.len(),
    })))
}

async fn get_order_by_id(
    State(state): State<AppState>,
    Path(order_id): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    match state.order_book.get_order(&order_id) {
        Ok(Some(order)) => Ok(Json(serde_json::json!(order))),
        Ok(None) => Err(StatusCode::NOT_FOUND),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

// ── Prometheus Metrics ──────────────────────────────────────────

async fn prometheus_metrics(
    State(state): State<AppState>,
) -> ([(axum::http::header::HeaderName, &'static str); 1], String) {
    let node = &state.node;
    let tip = node.get_tip_height().unwrap_or(0);
    let (finalized, _, _, _) = node.get_finality_status().unwrap_or((0, 0, 0, 0));
    let validators = node.list_validators().unwrap_or_default();
    let val_count = validators.len();
    let total_staked: u128 = validators.iter().map(|(_, v)| v.stake).sum();
    let mempool = node.get_mempool_snapshot().len();
    let (total_fees, _last_fees) = node.get_fee_stats().unwrap_or((0.0, 0.0));
    let base_fee = node.get_base_fee();
    let total_burned = node.get_total_fees_burned();
    let indexed = state.indexer.event_count();
    let peers = state.peer_manager.peer_count().await;
    let ws_clients = state.ws_broadcaster.client_count().await;

    let body = format!(
        "# HELP rougechain_block_height Current block height\n\
         # TYPE rougechain_block_height gauge\n\
         rougechain_block_height {}\n\
         # HELP rougechain_finalized_height Last finalized block height\n\
         # TYPE rougechain_finalized_height gauge\n\
         rougechain_finalized_height {}\n\
         # HELP rougechain_validator_count Active validator count\n\
         # TYPE rougechain_validator_count gauge\n\
         rougechain_validator_count {}\n\
         # HELP rougechain_total_staked Total XRGE staked\n\
         # TYPE rougechain_total_staked gauge\n\
         rougechain_total_staked {}\n\
         # HELP rougechain_mempool_size Pending transactions in mempool\n\
         # TYPE rougechain_mempool_size gauge\n\
         rougechain_mempool_size {}\n\
         # HELP rougechain_total_fees_collected Total fees collected\n\
         # TYPE rougechain_total_fees_collected counter\n\
         rougechain_total_fees_collected {}\n\
         # HELP rougechain_total_fees_burned Total fees burned (base fee)\n\
         # TYPE rougechain_total_fees_burned counter\n\
         rougechain_total_fees_burned {}\n\
         # HELP rougechain_base_fee Current EIP-1559 base fee\n\
         # TYPE rougechain_base_fee gauge\n\
         rougechain_base_fee {}\n\
         # HELP rougechain_indexed_events Total indexed events\n\
         # TYPE rougechain_indexed_events gauge\n\
         rougechain_indexed_events {}\n\
         # HELP rougechain_peer_count Connected P2P peers\n\
         # TYPE rougechain_peer_count gauge\n\
         rougechain_peer_count {}\n\
         # HELP rougechain_ws_clients Active WebSocket clients\n\
         # TYPE rougechain_ws_clients gauge\n\
         rougechain_ws_clients {}\n",
        tip, finalized, val_count, total_staked, mempool,
        total_fees, total_burned, base_fee, indexed,
        peers, ws_clients,
    );

    ([(axum::http::header::CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")], body)
}

// WebSocket handler for real-time updates
async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws_connection(socket, state))
}

async fn handle_ws_connection(socket: WebSocket, state: AppState) {
    use std::collections::HashSet;
    let (mut sender, mut receiver) = socket.split();
    let broadcaster = state.ws_broadcaster.clone();
    
    // Track connection
    broadcaster.client_connected().await;
    
    // Per-client subscription topics (empty = receive everything for backward compat)
    let subscriptions: Arc<tokio::sync::RwLock<HashSet<String>>> = Arc::new(tokio::sync::RwLock::new(HashSet::new()));
    
    // Subscribe to broadcast channel
    let mut rx = broadcaster.subscribe();
    
    // Send initial stats
    let height = state.node.get_tip_height().unwrap_or(0);
    let peer_count = state.peer_manager.peer_count().await;
    let mempool_size = 0;
    broadcaster.broadcast_stats(height, peer_count, mempool_size);
    
    // Spawn task to forward broadcasts to this client (with topic filtering)
    let subs_clone = subscriptions.clone();
    let send_task = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            // Parse the event to check topics
            let should_send = {
                let subs = subs_clone.read().await;
                if subs.is_empty() {
                    true // No subscriptions = receive everything
                } else if let Ok(event) = serde_json::from_str::<serde_json::Value>(&msg) {
                    // Check if the event matches any subscription topic
                    if let Ok(ws_event) = serde_json::from_value::<crate::websocket::WsEvent>(event) {
                        let event_topics = ws_event.topics();
                        event_topics.iter().any(|t| subs.contains(t))
                    } else {
                        true // Can't parse = send anyway
                    }
                } else {
                    true
                }
            };
            if should_send {
                if sender.send(Message::Text(msg)).await.is_err() {
                    break;
                }
            }
        }
    });
    
    // Handle incoming messages (subscribe/unsubscribe + ping/close)
    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                // Try parsing as subscription command
                if let Ok(cmd) = serde_json::from_str::<serde_json::Value>(&text) {
                    if let Some(topics) = cmd.get("subscribe").and_then(|v| v.as_array()) {
                        let mut subs = subscriptions.write().await;
                        for topic in topics {
                            if let Some(t) = topic.as_str() {
                                subs.insert(t.to_string());
                            }
                        }
                        let current: Vec<String> = subs.iter().cloned().collect();
                        // Send subscription confirmation
                        let confirm = serde_json::json!({"type": "subscribed", "topics": current});
                        // Note: we don't have direct sender access here in the read loop
                        // Instead, broadcast via the channel (only this client will get it)
                        drop(subs);
                    }
                    if let Some(topics) = cmd.get("unsubscribe").and_then(|v| v.as_array()) {
                        let mut subs = subscriptions.write().await;
                        for topic in topics {
                            if let Some(t) = topic.as_str() {
                                subs.remove(t);
                            }
                        }
                    }
                }
            }
            Ok(Message::Ping(_)) => {}
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
    node_name: Option<String>,
    base_fee: f64,
    total_fees_burned: f64,
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
        node_name: state.node_name.clone(),
        base_fee: node.get_base_fee(),
        total_fees_burned: node.get_total_fees_burned(),
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

async fn get_finality_proof(
    State(state): State<AppState>,
    Path(height): Path<u64>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let node = &state.node;
    match node.generate_finality_proof(height) {
        Ok(Some(proof)) => Ok(Json(serde_json::json!({
            "success": true,
            "proof": proof
        }))),
        Ok(None) => Ok(Json(serde_json::json!({
            "success": false,
            "error": format!("No finality proof available for height {}", height)
        }))),
        Err(e) => Ok(Json(serde_json::json!({
            "success": false,
            "error": e
        }))),
    }
}

async fn get_fee_info(State(state): State<AppState>) -> Json<serde_json::Value> {
    let node = &state.node;
    let base_fee = node.get_base_fee();
    Json(serde_json::json!({
        "success": true,
        "base_fee": base_fee,
        "priority_fee_suggestion": base_fee * 0.1,
        "total_fee_suggestion": base_fee * 1.1,
        "total_fees_burned": node.get_total_fees_burned(),
        "target_txs_per_block": 10,
        "fee_floor": 0.001,
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
    frozen: bool,
    mintable: bool,
    max_supply: Option<u64>,
    total_minted: u64,
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
                    frozen: t.frozen,
                    mintable: t.mintable,
                    max_supply: t.max_supply,
                    total_minted: t.total_minted,
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
    // For native XRGE, use the known total supply (no create_token tx exists)
    let original_supply = if symbol.eq_ignore_ascii_case("XRGE") {
        36_000_000_000u64
    } else {
        node.get_token_original_supply(&symbol).unwrap_or(0)
    };
    
    // Get all wallet balances for this symbol
    // For native XRGE, use the main balances map; for custom tokens, use token_balances
    let wallet_balances = if symbol.eq_ignore_ascii_case("XRGE") {
        node.get_all_native_balances().unwrap_or_default()
    } else {
        node.get_all_token_balances_for_symbol(&symbol).unwrap_or_default()
    };
    
    // Get pool reserves for this token (tokens locked in liquidity)
    let pool_reserves = node.get_token_pool_reserves(&symbol).unwrap_or(0);
    
    // Get burned amount
    let burned = node.get_burned_amount(&symbol).unwrap_or(0.0);
    
    // Total supply is the original minted amount
    let total_supply = original_supply as f64;
    
    // Circulating supply = sum of all holder balances (most accurate)
    // Falls back to total - burned if no holders found
    let wallet_total: f64 = wallet_balances.values().sum();
    let circulating_supply = if wallet_total > 0.0 {
        wallet_total + pool_reserves as f64
    } else {
        total_supply - burned
    };
    
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
    /// Start from this block height (for P2P full-chain sync)
    from_height: Option<u64>,
}

#[derive(Serialize)]
struct BlocksResponse {
    blocks: Vec<quantum_vault_types::BlockV1>,
}

const MAX_BLOCK_PAGE_SIZE: usize = 100;
/// Higher limit for peer sync requests that need the full chain
const MAX_SYNC_PAGE_SIZE: usize = 1000;

async fn get_blocks(
    State(state): State<AppState>,
    Query(query): Query<BlocksQuery>,
) -> Result<Json<BlocksResponse>, StatusCode> {
    let node = &state.node;
    // If from_height is provided, return blocks starting from that height (for P2P sync)
    if let Some(from_height) = query.from_height {
        let limit = query.limit.unwrap_or(MAX_SYNC_PAGE_SIZE).min(MAX_SYNC_PAGE_SIZE);
        let all_from = node.get_blocks_from(from_height).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let blocks: Vec<_> = all_from.into_iter().take(limit).collect();
        return Ok(Json(BlocksResponse { blocks }));
    }
    let limit = query.limit.unwrap_or(MAX_BLOCK_PAGE_SIZE).min(MAX_BLOCK_PAGE_SIZE);
    let blocks = node.get_recent_blocks(limit).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
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
            // Index the block
            let _ = state.indexer.index_block(&block_clone);
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
                // Enrich with receipt data if available
                let receipt = node.get_receipt(&tx_id).ok().flatten();
                return Ok(Json(serde_json::json!({
                    "success": true,
                    "txId": tx_id,
                    "blockHeight": block.header.height,
                    "blockHash": block.hash,
                    "blockTime": block.header.time,
                    "tx": tx,
                    "receipt": receipt,
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
                let receipt = node.get_receipt(&tx_id).ok().flatten();
                return Ok(Json(serde_json::json!({
                    "success": true,
                    "txId": tx_id,
                    "blockHeight": block.header.height,
                    "blockHash": block.hash,
                    "blockTime": block.header.time,
                    "tx": tx,
                    "receipt": receipt,
                })));
            }
        }
    }

    Err(StatusCode::NOT_FOUND)
}

async fn get_tx_receipt(
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    match state.node.get_receipt(&hash) {
        Ok(Some(receipt)) => Ok(Json(serde_json::json!({
            "success": true,
            "receipt": receipt,
        }))),
        Ok(None) => Err(StatusCode::NOT_FOUND),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
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
    let limit_blocks = 500; // Scan recent blocks instead of entire chain
    let blocks = node.get_recent_blocks(limit_blocks).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
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
    let scan_limit = 500; // Scan recent blocks instead of entire chain
    let blocks = node.get_recent_blocks(scan_limit).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
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

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlocksSummaryResponse {
    success: bool,
    range: String,
    interval_ms: u64,
    start_time: u64,
    end_time: u64,
    points: Vec<BlocksSummaryPoint>,
}

#[derive(Serialize, Deserialize)]
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

    // Use cached summary if available and fresh (5 second TTL)
    {
        let cache = state.response_cache.read().unwrap();
        let cache_key = format!("blocks_summary_{}", range);
        if let Some((cached_at, cached_json)) = cache.get(&cache_key) {
            if cached_at.elapsed() < StdDuration::from_secs(5) {
                if let Ok(resp) = serde_json::from_str::<BlocksSummaryResponse>(cached_json) {
                    return Ok(Json(resp));
                }
            }
        }
    }

    // Scan enough blocks to cover the time range (estimate: 1 block per second max)
    let max_blocks_for_range = match range {
        "1h" => 3600usize,
        "7d" => 500,  // 7 days is too many, cap at 500 most recent
        _ => 500,     // 24h
    };
    let blocks = node.get_recent_blocks(max_blocks_for_range).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
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
    let response = BlocksSummaryResponse {
        success: true,
        range: range.to_string(),
        interval_ms,
        start_time,
        end_time: now,
        points,
    };

    // Cache the response
    if let Ok(json) = serde_json::to_string(&response) {
        let cache_key = format!("blocks_summary_{}", range);
        if let Ok(mut cache) = state.response_cache.write() {
            cache.insert(cache_key, (Instant::now(), json));
        }
    }

    Ok(Json(response))
}

// ── Address resolution ──────────────────────────────────────────

async fn resolve_address(
    State(state): State<AppState>,
    Path(input): Path<String>,
) -> Json<serde_json::Value> {
    use quantum_vault_crypto::{pub_key_to_address, is_rouge_address};

    if is_rouge_address(&input) {
        // rouge1… → pubkey: O(1) persistent lookup
        if let Some(pubkey) = state.node.resolve_rouge1(&input) {
            let balance = state.node.get_balance(&pubkey).unwrap_or(0.0);
            return Json(serde_json::json!({
                "success": true,
                "address": input,
                "publicKey": pubkey,
                "balance": balance,
            }));
        }
        Json(serde_json::json!({ "success": false, "error": "Address not found" }))
    } else {
        // pubkey → rouge1: derive + index for future lookups
        let balance = state.node.get_balance(&input).unwrap_or(0.0);
        match pub_key_to_address(&input) {
            Ok(addr) => {
                state.node.index_address(&input);
                Json(serde_json::json!({
                    "success": true,
                    "address": addr,
                    "publicKey": input,
                    "balance": balance,
                }))
            }
            Err(e) => Json(serde_json::json!({
                "success": false,
                "error": format!("Invalid public key: {}", e),
            })),
        }
    }
}

// ===== Push notification registration (PQC-signed) =====

async fn push_register(
    State(state): State<AppState>,
    Json(body): Json<SignedTransactionRequest>,
) -> Json<serde_json::Value> {
    // Verify PQC signature — proves the caller owns the private key
    if let Err(e) = verify_signed_tx(&body) {
        return Json(serde_json::json!({ "success": false, "error": format!("Signature verification failed: {}", e) }));
    }

    let push_token = match body.payload.get("pushToken").and_then(|v| v.as_str()) {
        Some(t) => t.to_string(),
        None => return Json(serde_json::json!({ "success": false, "error": "payload must include 'pushToken'" })),
    };
    let platform = body.payload.get("platform").and_then(|v| v.as_str()).unwrap_or("expo").to_string();

    match state.node.register_push_token(&body.public_key, &push_token, &platform) {
        Ok(()) => Json(serde_json::json!({ "success": true })),
        Err(e) => Json(serde_json::json!({ "success": false, "error": e })),
    }
}

async fn push_unregister(
    State(state): State<AppState>,
    Json(body): Json<SignedTransactionRequest>,
) -> Json<serde_json::Value> {
    // Verify PQC signature — only the wallet owner can unregister
    if let Err(e) = verify_signed_tx(&body) {
        return Json(serde_json::json!({ "success": false, "error": format!("Signature verification failed: {}", e) }));
    }

    match state.node.unregister_push_token(&body.public_key) {
        Ok(true) => Json(serde_json::json!({ "success": true })),
        Ok(false) => Json(serde_json::json!({ "success": false, "error": "Not registered" })),
        Err(e) => Json(serde_json::json!({ "success": false, "error": e })),
    }
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
        nonce: state.node.get_next_nonce(&body.from_public_key),
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
    
    let tx_clone = signed_tx.clone();
    node.add_tx_to_mempool(signed_tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    let peers = state.peer_manager.get_peers().await;
    if !peers.is_empty() { peer::broadcast_tx(&peers, &tx_clone); }
    
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
    
    let tx_clone = signed_tx.clone();
    node.add_tx_to_mempool(signed_tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    let peers = state.peer_manager.get_peers().await;
    if !peers.is_empty() { peer::broadcast_tx(&peers, &tx_clone); }
    
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
    
    let tx_clone = signed_tx.clone();
    node.add_tx_to_mempool(signed_tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    let peers = state.peer_manager.get_peers().await;
    if !peers.is_empty() { peer::broadcast_tx(&peers, &tx_clone); }
    
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
    
    let tx_clone = signed_tx.clone();
    node.add_tx_to_mempool(signed_tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    let peers = state.peer_manager.get_peers().await;
    if !peers.is_empty() { peer::broadcast_tx(&peers, &tx_clone); }
    
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
struct PeerInfo {
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    node_name: Option<String>,
}

#[derive(Serialize)]
struct PeersResponse {
    peers: Vec<String>,
    peer_details: Vec<PeerInfo>,
    count: usize,
}

async fn get_peers(State(state): State<AppState>) -> Result<Json<PeersResponse>, StatusCode> {
    let peers = state.peer_manager.get_peers().await;
    let peer_details = state.peer_manager.get_peer_details().await;
    let count = peers.len();
    Ok(Json(PeersResponse { peers, peer_details, count }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterPeerRequest {
    peer_url: String,
    #[serde(default)]
    node_name: Option<String>,
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
    let added = state.peer_manager.add_peer_with_name(body.peer_url.clone(), body.node_name.clone()).await;
    if added {
        let label = body.node_name.as_deref().unwrap_or("unnamed");
        eprintln!("[peer] New peer registered: {} ({})", body.peer_url, label);
        Ok(Json(RegisterPeerResponse {
            success: true,
            message: "Peer registered".to_string(),
        }))
    } else {
        // Still update the name if it changed
        if let Some(name) = body.node_name {
            state.peer_manager.set_peer_name(&body.peer_url, name).await;
        }
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

const FAUCET_COOLDOWN_SECS: i64 = 86400; // 24 hours
const FAUCET_MAX_AMOUNT: u64 = 100_000;

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

    let amount = body.amount.unwrap_or(10000).min(FAUCET_MAX_AMOUNT);

    let now = chrono::Utc::now().timestamp();
    {
        let mut cooldowns = state.faucet_cooldowns.lock().await;
        if let Some(&last_used) = cooldowns.get(&body.recipient_public_key) {
            let elapsed = now - last_used;
            if elapsed < FAUCET_COOLDOWN_SECS {
                let remaining = FAUCET_COOLDOWN_SECS - elapsed;
                let hours = remaining / 3600;
                let mins = (remaining % 3600) / 60;
                return Ok(Json(TxResponse {
                    success: false,
                    tx_id: None,
                    tx: None,
                    error: Some(format!(
                        "Faucet cooldown: please wait {}h {}m before requesting again.",
                        hours, mins
                    )),
                }));
            }
        }
        cooldowns.insert(body.recipient_public_key.clone(), now);
    }

    match node.submit_faucet_tx(&body.recipient_public_key, amount) {
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
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    stake: String,
    status: String,
    slash_count: u32,
    jailed_until: u64,
    entropy_contributions: u64,
    blocks_proposed: u64,
}

async fn get_validators(State(state): State<AppState>) -> Result<Json<ValidatorsResponse>, StatusCode> {
    let node = &state.node;
    let (validators, total) = node.get_validator_set().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let tip = node.get_tip_height().unwrap_or(0);
    let our_node_name = state.node_name.clone();
    // Get our node's public key to match against validators
    let our_pub_key = node.get_public_key();
    // Get peer names from peer manager for enrichment
    let peer_names = state.peer_manager.get_peer_names().await;
    let mapped = validators.into_iter().map(|(public_key, vstate)| {
        let status = if vstate.jailed_until > tip {
            "jailed"
        } else if vstate.stake > 0 {
            "active"
        } else {
            "inactive"
        };
        // Determine name: stored name > local node_name match > peer name > None
        let name = vstate.name.clone()
            .or_else(|| {
                if let Some(ref our_key) = our_pub_key {
                    if our_key == &public_key {
                        return our_node_name.clone();
                    }
                }
                None
            })
            .or_else(|| {
                peer_names.get(&public_key).cloned()
            });
        ValidatorInfo {
            public_key,
            name,
            stake: vstate.stake.to_string(),
            status: status.to_string(),
            slash_count: vstate.slash_count,
            jailed_until: vstate.jailed_until,
            entropy_contributions: vstate.entropy_contributions,
            blocks_proposed: vstate.blocks_proposed,
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
    let wallets = node.list_discoverable_wallets().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "success": true, "wallets": wallets })))
}

async fn register_messenger_wallet(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let node = &state.node;
    let id = body.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let display_name = body.get("displayName").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let signing_key = body.get("signingPublicKey").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let encryption_key = body.get("encryptionPublicKey").and_then(|v| v.as_str()).unwrap_or_default().to_string();

    // Enforce unique display names (case-insensitive)
    // Also collect old wallet IDs that will be replaced (for name registry update)
    let mut old_ids_to_update: Vec<String> = Vec::new();
    if let Ok(existing_wallets) = node.list_wallets() {
        let name_lower = display_name.to_lowercase();
        for w in &existing_wallets {
            if w.display_name.to_lowercase() == name_lower && w.id != id {
                // Same display name but different ID -- check if it's the same user (same keys)
                let same_keys = (!signing_key.is_empty() && w.signing_public_key == signing_key)
                    || (!encryption_key.is_empty() && w.encryption_public_key == encryption_key);
                if !same_keys {
                    return Ok(Json(serde_json::json!({
                        "success": false,
                        "error": format!("Display name '{}' is already taken", display_name)
                    })));
                }
            }
            // Detect wallet entries that will be replaced by register_wallet
            if w.id != id {
                let will_replace = (!signing_key.is_empty() && w.signing_public_key == signing_key)
                    || (!encryption_key.is_empty() && w.encryption_public_key == encryption_key);
                if will_replace {
                    old_ids_to_update.push(w.id.clone());
                }
            }
        }
    }

    let wallet = quantum_vault_storage::messenger_store::MessengerWallet {
        id: id.clone(),
        display_name,
        signing_public_key: signing_key,
        encryption_public_key: encryption_key,
        created_at: chrono::Utc::now().to_rfc3339(),
        discoverable: body.get("discoverable").and_then(|v| v.as_bool()).unwrap_or(true),
    };
    let wallet = node.register_wallet(wallet).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Update name registry and mail labels that reference old wallet IDs
    for old_id in &old_ids_to_update {
        let _ = node.update_name_wallet_id(old_id, &id);
        let _ = node.update_mail_labels_wallet_id(old_id, &id);
    }

    Ok(Json(serde_json::json!({ "success": true, "wallet": wallet })))
}

async fn get_messenger_conversations(
    State(state): State<AppState>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let node = &state.node;
    let wallet_id = query.get("walletId").cloned().unwrap_or_default();
    let signing_key = query.get("signingPublicKey").cloned().unwrap_or_default();
    let encryption_key = query.get("encryptionPublicKey").cloned().unwrap_or_default();
    let extra_keys: Vec<&str> = [signing_key.as_str(), encryption_key.as_str()]
        .into_iter()
        .filter(|k| !k.is_empty())
        .collect();
    let conversations = node.list_conversations_with_activity(&wallet_id, &extra_keys).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
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
        read_at: None,
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

async fn delete_messenger_message(
    State(state): State<AppState>,
    Path(message_id): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let node = &state.node;
    match node.delete_message(&message_id) {
        Ok(()) => Ok(Json(serde_json::json!({ "success": true }))),
        Err(e) => Ok(Json(serde_json::json!({ "success": false, "error": e }))),
    }
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
            // Try exact ID match first, then fall back to key-based matching
            let wallet = wallets.iter().find(|w| w.id == e.wallet_id)
                .or_else(|| wallets.iter().find(|w|
                    w.signing_public_key == e.wallet_id || w.encryption_public_key == e.wallet_id
                ));
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
        attachment_encrypted: body.get("attachmentEncrypted").and_then(|v| v.as_str()).map(|s| s.to_string()),
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

    // Freeze check: reject transfers of frozen tokens (XRGE cannot be frozen)
    if token != "XRGE" {
        if let Ok(true) = node.is_token_frozen(token) {
            return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
                "success": false,
                "error": format!("Token {} is frozen — transfers are paused by the creator", token)
            }))));
        }
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
        nonce: state.node.get_next_nonce(&body.public_key),
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
    
    let tx_clone = tx.clone();
    node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    let peers = state.peer_manager.get_peers().await;
    if !peers.is_empty() { peer::broadcast_tx(&peers, &tx_clone); }
    
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
    let token_image = payload.get("image").and_then(|v| v.as_str()).map(|s| s.to_string());
    let token_description = payload.get("description").and_then(|v| v.as_str()).map(|s| s.to_string());
    let mintable = payload.get("mintable").and_then(|v| v.as_bool()).unwrap_or(false);
    let max_supply = payload.get("max_supply").and_then(|v| v.as_u64());
    let fee = 100.0_f64; // Server-enforced token creation fee

    if token_name.is_empty() || token_symbol.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "token_name and token_symbol are required"}))));
    }

    // Symbol validation: 1-10 chars, no leading/trailing whitespace
    let sym_trimmed = token_symbol.trim();
    if sym_trimmed.is_empty() || sym_trimmed.chars().count() > 10 {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "token_symbol must be 1-10 characters"}))));
    }
    if sym_trimmed.contains(char::is_whitespace) {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "token_symbol cannot contain whitespace"}))));
    }

    // Name validation: 1-64 chars
    let name_trimmed = token_name.trim();
    if name_trimmed.is_empty() || name_trimmed.chars().count() > 64 {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "token_name must be 1-64 characters"}))));
    }

    // Duplicate symbol check
    let sym_upper = sym_trimmed.to_uppercase();
    if let Ok(Some(_)) = node.get_token_metadata(&sym_upper) {
        return Err((StatusCode::CONFLICT, Json(serde_json::json!({"success": false, "error": format!("Token symbol '{}' already exists", sym_upper)}))));
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
        nonce: state.node.get_next_nonce(&body.public_key),
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
    
    let tx_clone = tx.clone();
    node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    let peers = state.peer_manager.get_peers().await;
    if !peers.is_empty() { peer::broadcast_tx(&peers, &tx_clone); }

    let token_id = node.register_token_metadata_ext(
        &sym_upper,
        name_trimmed,
        &body.public_key,
        token_image,
        token_description,
        mintable,
        max_supply,
    ).unwrap_or_default();

    Ok(Json(serde_json::json!({
        "success": true,
        "token_symbol": sym_upper,
        "token_id": token_id,
        "message": "Token creation transaction submitted"
    })))
}

async fn v2_update_token_metadata(
    State(state): State<AppState>,
    Json(body): Json<SignedTransactionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let _ = verify_signed_tx(&body).map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;

    let node = &state.node;
    let payload = &body.payload;

    let token_symbol = payload.get("token_symbol").and_then(|v| v.as_str()).unwrap_or_default();
    if token_symbol.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "token_symbol is required"}))));
    }

    match node.is_token_creator(token_symbol, &body.public_key) {
        Ok(true) => {}
        Ok(false) => {
            return Err((StatusCode::FORBIDDEN, Json(serde_json::json!({"success": false, "error": "Only the token creator can update metadata"}))));
        }
        Err(e) => {
            return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"success": false, "error": e}))));
        }
    }

    let image = payload.get("image").and_then(|v| v.as_str()).map(|s| s.to_string());
    let description = payload.get("description").and_then(|v| v.as_str()).map(|s| s.to_string());
    let website = payload.get("website").and_then(|v| v.as_str()).map(|s| s.to_string());
    let twitter = payload.get("twitter").and_then(|v| v.as_str()).map(|s| s.to_string());
    let discord = payload.get("discord").and_then(|v| v.as_str()).map(|s| s.to_string());

    match node.update_token_metadata(token_symbol, &body.public_key, image, description, website, twitter, discord) {
        Ok(()) => Ok(Json(serde_json::json!({
            "success": true,
            "message": "Token metadata updated successfully"
        }))),
        Err(e) => Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e})))),
    }
}

async fn v2_claim_token_metadata(
    State(state): State<AppState>,
    Json(body): Json<SignedTransactionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let _ = verify_signed_tx(&body).map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;

    let node = &state.node;
    let payload = &body.payload;

    let token_symbol = payload.get("token_symbol").and_then(|v| v.as_str()).unwrap_or_default();
    if token_symbol.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "token_symbol is required"}))));
    }

    match node.claim_token_metadata(token_symbol, &body.public_key) {
        Ok(()) => Ok(Json(serde_json::json!({
            "success": true,
            "message": "Token metadata claimed successfully. You can now update it."
        }))),
        Err(e) => Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e})))),
    }
}
// ===== Token Allowance Handlers =====

async fn v2_token_approve(
    State(state): State<AppState>,
    Json(body): Json<SignedTransactionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    use quantum_vault_types::{TxPayload, TxV1};

    let signed_payload = verify_signed_tx(&body).map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    let node = &state.node;
    let payload = &body.payload;

    let spender = payload.get("spender").and_then(|v| v.as_str()).unwrap_or_default();
    let token_symbol = payload.get("token_symbol").and_then(|v| v.as_str()).unwrap_or_default();
    let amount = payload.get("amount").and_then(|v| v.as_u64()).unwrap_or(0);

    if spender.is_empty() || token_symbol.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "spender and token_symbol required"}))));
    }

    let fee = 1.0_f64;
    let bal = node.get_balance(&body.public_key).unwrap_or(0.0);
    if bal < fee {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": format!("insufficient XRGE for fee: {:.4} < {:.4}", bal, fee)}))));
    }

    let tx = TxV1 {
        version: 1,
        tx_type: "approve".to_string(),
        from_pub_key: body.public_key.clone(),
        nonce: chrono::Utc::now().timestamp_millis() as u64,
        payload: TxPayload {
            spender_pub_key: Some(spender.to_string()),
            token_symbol: Some(token_symbol.to_string()),
            allowance_amount: Some(amount),
            ..Default::default()
        },
        fee,
        sig: body.signature.clone(),
        signed_payload: Some(signed_payload),
    };

    let tx_clone = tx.clone();
    node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    let peers = state.peer_manager.get_peers().await;
    if !peers.is_empty() { peer::broadcast_tx(&peers, &tx_clone); }

    Ok(Json(serde_json::json!({
        "success": true,
        "message": format!("Approval of {} {} for spender submitted", amount, token_symbol),
        "spender": spender,
        "token_symbol": token_symbol,
        "amount": amount
    })))
}

async fn v2_token_transfer_from(
    State(state): State<AppState>,
    Json(body): Json<SignedTransactionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    use quantum_vault_types::{TxPayload, TxV1};

    let signed_payload = verify_signed_tx(&body).map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    let node = &state.node;
    let payload = &body.payload;

    let owner = payload.get("owner").and_then(|v| v.as_str()).unwrap_or_default();
    let to = payload.get("to").and_then(|v| v.as_str()).unwrap_or_default();
    let token_symbol = payload.get("token_symbol").and_then(|v| v.as_str()).unwrap_or_default();
    let amount = payload.get("amount").and_then(|v| v.as_u64()).unwrap_or(0);

    if owner.is_empty() || to.is_empty() || token_symbol.is_empty() || amount == 0 {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "owner, to, token_symbol, and amount (>0) required"}))));
    }

    // Check allowance
    let sym_upper = token_symbol.trim().to_uppercase();
    let current = node.get_allowance(owner, &body.public_key, &sym_upper)
        .unwrap_or(None)
        .map(|a| a.amount)
        .unwrap_or(0);
    if current < amount {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": format!("insufficient allowance: have {}, need {}", current, amount)}))));
    }

    let fee = 1.0_f64;
    let bal = node.get_balance(&body.public_key).unwrap_or(0.0);
    if bal < fee {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": format!("insufficient XRGE for fee: {:.4} < {:.4}", bal, fee)}))));
    }

    let tx = TxV1 {
        version: 1,
        tx_type: "transfer_from".to_string(),
        from_pub_key: body.public_key.clone(),
        nonce: chrono::Utc::now().timestamp_millis() as u64,
        payload: TxPayload {
            owner_pub_key: Some(owner.to_string()),
            to_pub_key_hex: Some(to.to_string()),
            token_symbol: Some(token_symbol.to_string()),
            amount: Some(amount),
            ..Default::default()
        },
        fee,
        sig: body.signature.clone(),
        signed_payload: Some(signed_payload),
    };

    let tx_clone = tx.clone();
    node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    let peers = state.peer_manager.get_peers().await;
    if !peers.is_empty() { peer::broadcast_tx(&peers, &tx_clone); }

    Ok(Json(serde_json::json!({
        "success": true,
        "message": format!("TransferFrom of {} {} submitted", amount, token_symbol),
        "from": owner,
        "to": to,
        "amount": amount
    })))
}

#[derive(Debug, serde::Deserialize)]
struct AllowanceQuery {
    owner: Option<String>,
    spender: Option<String>,
    token: Option<String>,
}

async fn get_token_allowance(
    State(state): State<AppState>,
    Query(params): Query<AllowanceQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let owner = params.owner.as_deref().unwrap_or_default();
    let spender = params.spender.as_deref().unwrap_or_default();
    let token = params.token.as_deref().unwrap_or_default();

    if owner.is_empty() || spender.is_empty() || token.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "owner, spender, and token query params required"}))));
    }

    let allowance = state.node.get_allowance(owner, spender, &token.to_uppercase())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))))?;

    Ok(Json(serde_json::json!({
        "owner": owner,
        "spender": spender,
        "token": token.to_uppercase(),
        "amount": allowance.map(|a| a.amount).unwrap_or(0)
    })))
}

async fn get_token_allowances(
    State(state): State<AppState>,
    Query(params): Query<AllowanceQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let owner = params.owner.as_deref().unwrap_or_default();
    let spender = params.spender.as_deref().unwrap_or_default();

    if owner.is_empty() && spender.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "owner or spender query param required"}))));
    }

    let allowances = if !owner.is_empty() {
        state.node.get_allowances_by_owner(owner)
    } else {
        state.node.get_allowances_for_spender(spender)
    }.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))))?;

    let items: Vec<serde_json::Value> = allowances.iter().map(|a| {
        serde_json::json!({
            "owner": a.owner,
            "spender": a.spender,
            "token_symbol": a.token_symbol,
            "amount": a.amount
        })
    }).collect();

    Ok(Json(serde_json::json!({
        "allowances": items,
        "count": items.len()
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
    
    let tx_clone = tx.clone();
    node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    let peers = state.peer_manager.get_peers().await;
    if !peers.is_empty() { peer::broadcast_tx(&peers, &tx_clone); }
    
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
    
    let tx_clone = tx.clone();
    node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    let peers = state.peer_manager.get_peers().await;
    if !peers.is_empty() { peer::broadcast_tx(&peers, &tx_clone); }
    
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
    
    let tx_clone = tx.clone();
    node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    let peers = state.peer_manager.get_peers().await;
    if !peers.is_empty() { peer::broadcast_tx(&peers, &tx_clone); }
    
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
    
    let tx_clone = tx.clone();
    node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    let peers = state.peer_manager.get_peers().await;
    if !peers.is_empty() { peer::broadcast_tx(&peers, &tx_clone); }
    
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
    
    let tx_clone = tx.clone();
    node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    let peers = state.peer_manager.get_peers().await;
    if !peers.is_empty() { peer::broadcast_tx(&peers, &tx_clone); }
    
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
    
    let tx_clone = tx.clone();
    node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    let peers = state.peer_manager.get_peers().await;
    if !peers.is_empty() { peer::broadcast_tx(&peers, &tx_clone); }
    
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

    let creator_short = if body.public_key.len() >= 16 { &body.public_key[..16] } else { &body.public_key };
    let collection_id = format!("col:{}:{}", creator_short, symbol.to_uppercase());

    let tx_clone = tx.clone();
    state.node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    let peers = state.peer_manager.get_peers().await;
    if !peers.is_empty() { peer::broadcast_tx(&peers, &tx_clone); }

    Ok(Json(serde_json::json!({
        "success": true,
        "collection_id": collection_id,
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

    let tx_clone = tx.clone();
    state.node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    let peers = state.peer_manager.get_peers().await;
    if !peers.is_empty() { peer::broadcast_tx(&peers, &tx_clone); }

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

    let tx_clone = tx.clone();
    state.node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    let peers = state.peer_manager.get_peers().await;
    if !peers.is_empty() { peer::broadcast_tx(&peers, &tx_clone); }

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

    let tx_clone = tx.clone();
    state.node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    let peers = state.peer_manager.get_peers().await;
    if !peers.is_empty() { peer::broadcast_tx(&peers, &tx_clone); }

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

    let tx_clone = tx.clone();
    state.node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    let peers = state.peer_manager.get_peers().await;
    if !peers.is_empty() { peer::broadcast_tx(&peers, &tx_clone); }

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

    let tx_clone = tx.clone();
    state.node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    let peers = state.peer_manager.get_peers().await;
    if !peers.is_empty() { peer::broadcast_tx(&peers, &tx_clone); }

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

    let tx_clone = tx.clone();
    state.node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    let peers = state.peer_manager.get_peers().await;
    if !peers.is_empty() { peer::broadcast_tx(&peers, &tx_clone); }

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
    supported_tokens: Vec<String>,
}

/// Parse ERC-20 Transfer event amount from a transaction receipt.
/// ERC-20 Transfer topic: 0xddf252ad...
/// Returns the amount in the token's smallest units.
async fn parse_erc20_transfer_amount(
    client: &reqwest::Client,
    rpc_url: &str,
    tx_hash: &str,
) -> Result<u64, String> {
    let resp = client
        .post(rpc_url)
        .json(&serde_json::json!({
            "jsonrpc": "2.0",
            "method": "eth_getTransactionReceipt",
            "params": [tx_hash],
            "id": 1,
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let result = json.get("result").ok_or("No receipt")?;
    let logs = result.get("logs").and_then(|v| v.as_array()).ok_or("No logs")?;

    let transfer_topic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    for log in logs {
        let topics = log.get("topics").and_then(|v| v.as_array());
        if let Some(topics) = topics {
            if topics.len() >= 3 {
                let topic0 = topics[0].as_str().unwrap_or("");
                if topic0 == transfer_topic {
                    let data = log.get("data").and_then(|v| v.as_str()).unwrap_or("0x0");
                    let amount = u128::from_str_radix(
                        data.trim_start_matches("0x"),
                        16,
                    ).unwrap_or(0);
                    // USDC has 6 decimals; we store qUSDC in the same 6-decimal units
                    return Ok(amount as u64);
                }
            }
        }
    }
    Err("No Transfer event found".to_string())
}

async fn bridge_config(State(state): State<AppState>) -> Json<BridgeConfigResponse> {
    let (enabled, custody_address) = match &state.bridge_custody_address {
        Some(addr) if !addr.is_empty() => (true, Some(addr.clone())),
        _ => (false, None),
    };
    Json(BridgeConfigResponse {
        enabled,
        custody_address,
        chain_id: 84532,
        supported_tokens: vec!["ETH".to_string(), "USDC".to_string()],
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeClaimRequest {
    evm_tx_hash: String,
    evm_address: String,
    evm_signature: String,
    recipient_rougechain_pubkey: String,
    token: Option<String>,
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
    let bridge_token = body.token.as_deref().unwrap_or("ETH").to_uppercase();

    let (amount_units, mint_symbol) = match bridge_token.as_str() {
        "USDC" => {
            // USDC has 6 decimals on EVM. We check the tx receipt for ERC-20 transfer logs.
            // For USDC, value_wei from the ETH tx will be 0 (it's an ERC-20 transfer).
            // We need to parse the transfer amount from the logs.
            let usdc_amount = parse_erc20_transfer_amount(
                &client, &rpc_url, &tx_hash_hex
            ).await.unwrap_or(0);
            if usdc_amount == 0 {
                return Ok(Json(BridgeClaimResponse {
                    success: false, tx_id: None,
                    error: Some("No USDC transfer found in transaction".to_string()),
                }));
            }
            (usdc_amount, "qUSDC")
        }
        _ => {
            let units = (value_wei / 1_000_000_000_000) as u64;
            if units == 0 {
                return Ok(Json(BridgeClaimResponse {
                    success: false, tx_id: None,
                    error: Some("Amount too small (min 0.000001 ETH)".to_string()),
                }));
            }
            (units, "qETH")
        }
    };

    if let Err(e) = state.bridge_claim_store.insert(tx_hash_hex.clone()).await {
        return Ok(Json(BridgeClaimResponse {
            success: false,
            tx_id: None,
            error: Some(format!("Failed to persist claim: {}", e)),
        }));
    }

    use quantum_vault_crypto::{bytes_to_hex, sha256};
    use quantum_vault_types::encode_tx_v1;
    match state.node.submit_bridge_mint_tx(&recipient, amount_units, mint_symbol) {
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
    #[serde(default)]
    from_private_key: Option<String>,
    from_public_key: String,
    amount_units: u64,
    evm_address: String,
    fee: Option<f64>,
    signature: Option<String>,
    payload: Option<serde_json::Value>,
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

    let token_symbol = body.payload.as_ref()
        .and_then(|p| p.get("tokenSymbol"))
        .and_then(|v| v.as_str())
        .unwrap_or("qETH")
        .to_string();

    // Prefer signed payload (client-side signing) over raw private key
    let tx_result = if let (Some(signature), Some(payload)) = (&body.signature, &body.payload) {
        let signed_req = SignedTransactionRequest {
            payload: payload.clone(),
            signature: signature.clone(),
            public_key: body.from_public_key.clone(),
        };
        if let Err(e) = verify_signed_tx(&signed_req) {
            return Ok(Json(BridgeWithdrawResponse {
                success: false,
                tx_id: None,
                error: Some(format!("Signature verification failed: {}", e)),
            }));
        }
        state.node.submit_bridge_withdraw_tx_signed(
            &body.from_public_key,
            body.amount_units,
            &body.evm_address,
            body.fee,
            &token_symbol,
        )
    } else if let Some(ref private_key) = body.from_private_key {
        state.node.submit_bridge_withdraw_tx(
            private_key,
            &body.from_public_key,
            body.amount_units,
            &body.evm_address,
            body.fee,
        )
    } else {
        return Ok(Json(BridgeWithdrawResponse {
            success: false,
            tx_id: None,
            error: Some("Either signature+payload or fromPrivateKey is required".to_string()),
        }));
    };

    match tx_result {
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
    headers: axum::http::HeaderMap,
    body: String,
) -> Json<BridgeFulfillResponse> {
    let relayer_auth = if let Some(ref secret) = state.bridge_relayer_secret {
        headers.get("x-bridge-relayer-secret")
            .and_then(|v| v.to_str().ok())
            .map(|v| v == secret.as_str())
            .unwrap_or(false)
    } else {
        false
    };

    if !relayer_auth {
        let parsed: Result<SignedTransactionRequest, _> = serde_json::from_str(&body);
        match parsed {
            Ok(signed_body) => {
                let node_pub_key = state.node.get_node_public_key();
                if signed_body.public_key != node_pub_key {
                    return Json(BridgeFulfillResponse {
                        success: false,
                        error: Some("unauthorized: only the node operator can fulfill withdrawals".to_string()),
                    });
                }
                if let Err(e) = verify_signed_tx(&signed_body) {
                    return Json(BridgeFulfillResponse {
                        success: false,
                        error: Some(format!("signature verification failed: {}", e)),
                    });
                }
            }
            Err(_) => {
                return Json(BridgeFulfillResponse {
                    success: false,
                    error: Some("unauthorized: provide x-bridge-relayer-secret header or signed body".to_string()),
                });
            }
        }
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

// ============================================
// XRGE Bridge endpoints (Base <-> RougeChain L1)
// ============================================

async fn xrge_bridge_config(State(state): State<AppState>) -> Json<serde_json::Value> {
    let enabled = state.xrge_bridge_vault.is_some();
    Json(serde_json::json!({
        "enabled": enabled,
        "vaultAddress": state.xrge_bridge_vault,
        "tokenAddress": state.xrge_bridge_token,
        "chainId": 84532,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct XrgeBridgeClaimRequest {
    evm_tx_hash: String,
    evm_address: String,
    evm_signature: Option<String>,
    amount: String,
    recipient_rougechain_pubkey: String,
}

async fn xrge_bridge_claim(
    State(state): State<AppState>,
    Json(body): Json<XrgeBridgeClaimRequest>,
) -> Json<serde_json::Value> {
    if state.xrge_bridge_vault.is_none() {
        return Json(serde_json::json!({ "success": false, "error": "XRGE bridge not enabled" }));
    }
    let tx_hash = body.evm_tx_hash.trim_start_matches("0x").to_lowercase();
    let tx_hash_hex = format!("0x{}", tx_hash);
    let prefixed_hash = format!("xrge:{}", tx_hash_hex);

    if state.bridge_claim_store.contains(&prefixed_hash).await {
        return Json(serde_json::json!({ "success": false, "error": "Transaction already claimed" }));
    }

    let amount_raw: f64 = body.amount.parse().unwrap_or(0.0);
    let amount_l1 = (amount_raw / 1e18).round() as u64;
    if amount_l1 == 0 {
        return Json(serde_json::json!({ "success": false, "error": "Amount too small" }));
    }

    let recipient = normalize_recipient(&body.recipient_rougechain_pubkey);

    let client = reqwest::Client::new();
    let rpc_url = &state.base_sepolia_rpc;
    let resp = client
        .post(rpc_url)
        .json(&serde_json::json!({
            "jsonrpc": "2.0",
            "method": "eth_getTransactionReceipt",
            "params": [tx_hash_hex],
            "id": 1,
        }))
        .send()
        .await;

    let receipt_ok = match resp {
        Ok(r) => match r.json::<serde_json::Value>().await {
            Ok(j) => {
                let result = j.get("result");
                match result {
                    Some(serde_json::Value::Null) | None => false,
                    Some(obj) => {
                        let status = obj.get("status").and_then(|v| v.as_str()).unwrap_or("0x0");
                        status == "0x1"
                    }
                }
            }
            Err(_) => false,
        },
        Err(_) => false,
    };

    if !receipt_ok {
        return Json(serde_json::json!({ "success": false, "error": "Transaction not confirmed or failed" }));
    }

    // Verify EVM signature if provided (optional for backward compat, will be required in future)
    let evm_sig = body.evm_signature.as_deref().unwrap_or("").trim().to_string();
    if !evm_sig.is_empty() {
        let claim_message = format!("RougeChain XRGE bridge claim\nTx: {}\nRecipient: {}", tx_hash_hex, recipient);
        let sig_bytes = hex::decode(evm_sig.trim_start_matches("0x")).unwrap_or_default();
        let evm_addr = body.evm_address.trim().to_lowercase();
        let sig_valid = eth_ecdsa_verifier::validate_ecdsa_signature(
            &evm_addr,
            claim_message.as_bytes(),
            &sig_bytes,
        );
        if !sig_valid.unwrap_or(false) {
            return Json(serde_json::json!({ "success": false, "error": "Invalid EVM signature — sign the claim message with the wallet that sent the XRGE" }));
        }
    } else {
        eprintln!("[bridge] Warning: XRGE claim without EVM signature for tx {} — will be required in future", tx_hash_hex);
    }

    if let Err(e) = state.bridge_claim_store.insert(prefixed_hash).await {
        return Json(serde_json::json!({ "success": false, "error": format!("Failed to persist claim: {}", e) }));
    }

    use quantum_vault_crypto::{bytes_to_hex, sha256};
    use quantum_vault_types::encode_tx_v1;
    match state.node.submit_bridge_mint_tx(&recipient, amount_l1, "XRGE") {
        Ok(tx) => {
            let id = bytes_to_hex(&sha256(&encode_tx_v1(&tx)));
            Json(serde_json::json!({ "success": true, "txId": id }))
        }
        Err(e) => Json(serde_json::json!({ "success": false, "error": e })),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct XrgeBridgeWithdrawRequest {
    from_public_key: String,
    amount: u64,
    evm_address: String,
    signature: Option<String>,
    payload: Option<serde_json::Value>,
    #[serde(default)]
    from_private_key: Option<String>,
}

async fn xrge_bridge_withdraw(
    State(state): State<AppState>,
    Json(body): Json<XrgeBridgeWithdrawRequest>,
) -> Json<serde_json::Value> {
    if state.xrge_bridge_vault.is_none() {
        return Json(serde_json::json!({ "success": false, "error": "XRGE bridge not enabled" }));
    }
    if body.amount == 0 {
        return Json(serde_json::json!({ "success": false, "error": "Amount must be greater than 0" }));
    }

    let tx_result = if let (Some(signature), Some(payload)) = (&body.signature, &body.payload) {
        let signed_req = SignedTransactionRequest {
            payload: payload.clone(),
            signature: signature.clone(),
            public_key: body.from_public_key.clone(),
        };
        if let Err(e) = verify_signed_tx(&signed_req) {
            return Json(serde_json::json!({ "success": false, "error": format!("Signature verification failed: {}", e) }));
        }
        state.node.submit_bridge_withdraw_tx_signed(
            &body.from_public_key,
            body.amount,
            &body.evm_address,
            Some(0.1),
            "XRGE",
        )
    } else if let Some(ref private_key) = body.from_private_key {
        state.node.submit_bridge_withdraw_tx(
            private_key,
            &body.from_public_key,
            body.amount,
            &body.evm_address,
            Some(0.1),
        )
    } else {
        return Json(serde_json::json!({ "success": false, "error": "Either signature+payload or fromPrivateKey is required" }));
    };

    match tx_result {
        Ok(tx) => {
            let id = quantum_vault_crypto::bytes_to_hex(
                &quantum_vault_crypto::sha256(&quantum_vault_types::encode_tx_v1(&tx)),
            );
            state.ws_broadcaster.broadcast_new_tx(
                &id, &tx.tx_type, &tx.from_pub_key,
                tx.payload.evm_address.as_deref(), tx.payload.amount,
            );
            let peers = state.peer_manager.get_peers().await;
            if !peers.is_empty() { peer::broadcast_tx(&peers, &tx); }
            Json(serde_json::json!({ "success": true, "txId": id }))
        }
        Err(e) => Json(serde_json::json!({ "success": false, "error": e })),
    }
}

async fn xrge_bridge_withdrawals(State(state): State<AppState>) -> Json<serde_json::Value> {
    let list = state.bridge_withdraw_store.list().unwrap_or_default();
    let xrge_withdrawals: Vec<_> = list.into_iter()
        .filter(|w| w.tx_id.starts_with("xrge:") || {
            // TODO: once we tag token_symbol in PendingWithdrawal, filter properly
            false
        })
        .map(|w| serde_json::json!({
            "tx_id": w.tx_id,
            "evm_address": w.evm_address,
            "amount": w.amount_units,
            "created_at": w.created_at,
        }))
        .collect();
    Json(serde_json::json!({ "withdrawals": xrge_withdrawals }))
}

async fn xrge_bridge_fulfill(
    State(state): State<AppState>,
    Path(tx_id): Path<String>,
    headers: axum::http::HeaderMap,
    body: String,
) -> Json<BridgeFulfillResponse> {
    let relayer_auth = if let Some(ref secret) = state.bridge_relayer_secret {
        headers.get("x-bridge-relayer-secret")
            .and_then(|v| v.to_str().ok())
            .map(|v| v == secret.as_str())
            .unwrap_or(false)
    } else {
        false
    };

    if !relayer_auth {
        let parsed: Result<SignedTransactionRequest, _> = serde_json::from_str(&body);
        match parsed {
            Ok(signed_body) => {
                let node_pub_key = state.node.get_node_public_key();
                if signed_body.public_key != node_pub_key {
                    return Json(BridgeFulfillResponse {
                        success: false,
                        error: Some("unauthorized".to_string()),
                    });
                }
                if let Err(e) = verify_signed_tx(&signed_body) {
                    return Json(BridgeFulfillResponse {
                        success: false,
                        error: Some(format!("signature verification failed: {}", e)),
                    });
                }
            }
            Err(_) => {
                return Json(BridgeFulfillResponse {
                    success: false,
                    error: Some("unauthorized: provide x-bridge-relayer-secret header or signed body".to_string()),
                });
            }
        }
    }

    match state.bridge_withdraw_store.remove(&tx_id) {
        Ok(true) => Json(BridgeFulfillResponse { success: true, error: None }),
        Ok(false) => Json(BridgeFulfillResponse { success: false, error: Some("Withdrawal not found".to_string()) }),
        Err(e) => Json(BridgeFulfillResponse { success: false, error: Some(e) }),
    }
}

fn default_data_dir(node_name: &str) -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".quantum-vault").join(node_name)
}

// ============================================
// Shielded Transaction Handlers (Phase 2)
// ============================================

/// Shield: Convert public XRGE balance into a shielded note commitment
async fn v2_shield(
    State(state): State<AppState>,
    Json(body): Json<SignedTransactionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    use quantum_vault_types::{TxPayload, TxV1};

    let signed_payload = verify_signed_tx(&body).map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;

    let node = &state.node;
    let payload = &body.payload;

    let amount = payload.get("amount").and_then(|v| v.as_u64()).unwrap_or(0);
    let commitment = payload.get("commitment").and_then(|v| v.as_str()).unwrap_or_default();
    let fee = 1.0_f64;

    if amount == 0 {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "amount must be greater than zero"}))));
    }
    if commitment.is_empty() || commitment.len() != 64 {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "commitment must be a 64-char hex string (32 bytes)"}))));
    }

    // Balance check
    let bal = node.get_balance(&body.public_key).unwrap_or(0.0);
    if bal < amount as f64 + fee {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
            "success": false,
            "error": format!("insufficient XRGE: have {:.4}, need {:.4}", bal, amount as f64 + fee)
        }))));
    }

    let tx = TxV1 {
        version: 1,
        tx_type: "shield".to_string(),
        from_pub_key: body.public_key.clone(),
        nonce: state.node.get_next_nonce(&body.public_key),
        payload: TxPayload {
            shielded_commitment: Some(commitment.to_string()),
            shielded_value: Some(amount),
            ..Default::default()
        },
        fee,
        sig: body.signature.clone(),
        signed_payload: Some(signed_payload),
    };

    let tx_clone = tx.clone();
    node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    let peers = state.peer_manager.get_peers().await;
    if !peers.is_empty() { peer::broadcast_tx(&peers, &tx_clone); }

    Ok(Json(serde_json::json!({
        "success": true,
        "message": "Shield transaction submitted",
        "commitment": commitment
    })))
}

/// Shielded Transfer: Private note-to-note transfer with STARK proof
async fn v2_shielded_transfer(
    State(state): State<AppState>,
    Json(body): Json<SignedTransactionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    use quantum_vault_types::{TxPayload, TxV1};

    let signed_payload = verify_signed_tx(&body).map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;

    let node = &state.node;
    let payload = &body.payload;

    let nullifiers: Vec<String> = payload.get("nullifiers")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let output_commitments: Vec<String> = payload.get("output_commitments")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let proof_hex = payload.get("proof").and_then(|v| v.as_str()).unwrap_or_default();
    let shielded_fee = payload.get("fee").and_then(|v| v.as_u64()).unwrap_or(0);
    let fee = 1.0_f64;

    // Validate inputs
    if nullifiers.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "at least one nullifier required"}))));
    }
    if output_commitments.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "at least one output commitment required"}))));
    }
    if proof_hex.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "STARK proof is required"}))));
    }

    // Check nullifiers aren't already spent
    for nullifier in &nullifiers {
        match node.is_nullifier_spent(nullifier) {
            Ok(true) => {
                return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
                    "success": false,
                    "error": format!("double-spend detected: nullifier {} already spent", &nullifier[..16.min(nullifier.len())])
                }))));
            }
            Err(e) => {
                return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"success": false, "error": e}))));
            }
            _ => {}
        }
    }

    // Fee balance check
    let bal = node.get_balance(&body.public_key).unwrap_or(0.0);
    if bal < fee {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
            "success": false,
            "error": format!("insufficient XRGE for fee: have {:.4}, need {:.4}", bal, fee)
        }))));
    }

    let tx = TxV1 {
        version: 1,
        tx_type: "shielded_transfer".to_string(),
        from_pub_key: body.public_key.clone(),
        nonce: state.node.get_next_nonce(&body.public_key),
        payload: TxPayload {
            shielded_nullifiers: Some(nullifiers),
            shielded_output_commitments: Some(output_commitments),
            shielded_proof: Some(proof_hex.to_string()),
            shielded_fee: Some(shielded_fee),
            ..Default::default()
        },
        fee,
        sig: body.signature.clone(),
        signed_payload: Some(signed_payload),
    };

    let tx_clone = tx.clone();
    node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    let peers = state.peer_manager.get_peers().await;
    if !peers.is_empty() { peer::broadcast_tx(&peers, &tx_clone); }

    Ok(Json(serde_json::json!({
        "success": true,
        "message": "Shielded transfer submitted"
    })))
}

/// Unshield: Convert a shielded note back to public XRGE balance
async fn v2_unshield(
    State(state): State<AppState>,
    Json(body): Json<SignedTransactionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    use quantum_vault_types::{TxPayload, TxV1};

    let signed_payload = verify_signed_tx(&body).map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;

    let node = &state.node;
    let payload = &body.payload;

    let nullifiers: Vec<String> = payload.get("nullifiers")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let amount = payload.get("amount").and_then(|v| v.as_u64()).unwrap_or(0);
    let proof_hex = payload.get("proof").and_then(|v| v.as_str()).unwrap_or_default();
    let fee = 1.0_f64;

    if nullifiers.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "nullifier required to unshield"}))));
    }
    if amount == 0 {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "amount must be greater than zero"}))));
    }
    if proof_hex.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "STARK proof is required"}))));
    }

    // Check nullifiers aren't already spent
    for nullifier in &nullifiers {
        match node.is_nullifier_spent(nullifier) {
            Ok(true) => {
                return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
                    "success": false,
                    "error": format!("nullifier {} already spent", &nullifier[..16.min(nullifier.len())])
                }))));
            }
            Err(e) => {
                return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"success": false, "error": e}))));
            }
            _ => {}
        }
    }

    // Fee balance check
    let bal = node.get_balance(&body.public_key).unwrap_or(0.0);
    if bal < fee {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
            "success": false,
            "error": format!("insufficient XRGE for fee: have {:.4}, need {:.4}", bal, fee)
        }))));
    }

    let tx = TxV1 {
        version: 1,
        tx_type: "unshield".to_string(),
        from_pub_key: body.public_key.clone(),
        nonce: state.node.get_next_nonce(&body.public_key),
        payload: TxPayload {
            shielded_nullifiers: Some(nullifiers),
            shielded_value: Some(amount),
            shielded_proof: Some(proof_hex.to_string()),
            ..Default::default()
        },
        fee,
        sig: body.signature.clone(),
        signed_payload: Some(signed_payload),
    };

    let tx_clone = tx.clone();
    node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    let peers = state.peer_manager.get_peers().await;
    if !peers.is_empty() { peer::broadcast_tx(&peers, &tx_clone); }

    Ok(Json(serde_json::json!({
        "success": true,
        "message": "Unshield transaction submitted",
        "amount": amount
    })))
}

/// Read-only: Get shielded pool statistics
async fn shielded_stats(
    State(state): State<AppState>,
) -> Json<serde_json::Value> {
    let node = &state.node;
    let commitment_count = node.get_commitment_count();
    let nullifier_count = node.get_nullifier_count();

    Json(serde_json::json!({
        "success": true,
        "commitment_count": commitment_count,
        "nullifier_count": nullifier_count,
        "active_notes": commitment_count.saturating_sub(nullifier_count)
    }))
}

/// Read-only: Check if a nullifier has been spent
async fn shielded_nullifier_check(
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> Json<serde_json::Value> {
    let node = &state.node;
    match node.is_nullifier_spent(&hash) {
        Ok(spent) => Json(serde_json::json!({
            "success": true,
            "nullifier": hash,
            "spent": spent
        })),
        Err(e) => Json(serde_json::json!({
            "success": false,
            "error": e
        })),
    }
}

// ============================================================================
// Rollup Handlers (Phase 3)
// ============================================================================

async fn rollup_status(
    State(state): State<AppState>,
) -> impl IntoResponse {
    let acc = state.rollup_accumulator.lock().await;
    let status = acc.status();
    Json(serde_json::json!({
        "success": true,
        "rollup": status
    }))
}

async fn rollup_get_batch(
    State(state): State<AppState>,
    Path(id): Path<u64>,
) -> impl IntoResponse {
    let acc = state.rollup_accumulator.lock().await;
    match acc.get_batch(id) {
        Some(batch) => Json(serde_json::json!({
            "success": true,
            "batch": batch
        })),
        None => Json(serde_json::json!({
            "success": false,
            "error": format!("Batch {} not found", id)
        })),
    }
}

#[derive(Deserialize)]
struct RollupSubmitRequest {
    sender: String,
    receiver: String,
    amount: u64,
    #[serde(default)]
    fee: u64,
}

async fn rollup_submit_transfer(
    State(state): State<AppState>,
    Json(body): Json<RollupSubmitRequest>,
) -> impl IntoResponse {
    let transfer = rollup::PendingTransfer {
        sender: body.sender,
        receiver: body.receiver,
        amount: body.amount,
        fee: body.fee,
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    };

    let mut acc = state.rollup_accumulator.lock().await;
    let batch_result = acc.add_transfer(transfer);

    match batch_result {
        Some(result) => Json(serde_json::json!({
            "success": true,
            "queued": false,
            "batch_completed": true,
            "batch": result
        })),
        None => {
            let status = acc.status();
            Json(serde_json::json!({
                "success": true,
                "queued": true,
                "batch_completed": false,
                "pending_transfers": status.pending_transfers,
                "max_batch_size": status.max_batch_size
            }))
        }
    }
}

// ============================================================================
// Web3 Feature Handlers (Token Locking, Staking, Governance, Allowances)
// ============================================================================

async fn get_locks(
    State(state): State<AppState>,
    Path(pubkey): Path<String>,
) -> Json<serde_json::Value> {
    match state.node.get_locks_by_owner(&pubkey) {
        Ok(locks) => Json(serde_json::json!({ "success": true, "locks": locks })),
        Err(e) => Json(serde_json::json!({ "success": false, "error": e })),
    }
}

async fn get_staking_pools(
    State(state): State<AppState>,
) -> Json<serde_json::Value> {
    match state.node.get_staking_pools() {
        Ok(pools) => Json(serde_json::json!({ "success": true, "pools": pools })),
        Err(e) => Json(serde_json::json!({ "success": false, "error": e })),
    }
}

async fn get_staking_pool(
    State(state): State<AppState>,
    Path(pool_id): Path<String>,
) -> Json<serde_json::Value> {
    match state.node.get_staking_pool(&pool_id) {
        Ok(Some(pool)) => Json(serde_json::json!({ "success": true, "pool": pool })),
        Ok(None) => Json(serde_json::json!({ "success": false, "error": "Pool not found" })),
        Err(e) => Json(serde_json::json!({ "success": false, "error": e })),
    }
}

async fn get_stakes_by_owner(
    State(state): State<AppState>,
    Path(pubkey): Path<String>,
) -> Json<serde_json::Value> {
    match state.node.get_stakes_by_owner(&pubkey) {
        Ok(stakes) => Json(serde_json::json!({ "success": true, "stakes": stakes })),
        Err(e) => Json(serde_json::json!({ "success": false, "error": e })),
    }
}

async fn get_stakes_by_pool(
    State(state): State<AppState>,
    Path(pool_id): Path<String>,
) -> Json<serde_json::Value> {
    match state.node.get_stakes_by_pool(&pool_id) {
        Ok(stakes) => Json(serde_json::json!({ "success": true, "stakes": stakes })),
        Err(e) => Json(serde_json::json!({ "success": false, "error": e })),
    }
}

async fn get_proposals(
    State(state): State<AppState>,
) -> Json<serde_json::Value> {
    match state.node.get_proposals() {
        Ok(proposals) => Json(serde_json::json!({ "success": true, "proposals": proposals })),
        Err(e) => Json(serde_json::json!({ "success": false, "error": e })),
    }
}

async fn get_proposals_by_token(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Json<serde_json::Value> {
    match state.node.get_proposals_by_token(&token) {
        Ok(proposals) => Json(serde_json::json!({ "success": true, "proposals": proposals })),
        Err(e) => Json(serde_json::json!({ "success": false, "error": e })),
    }
}

async fn get_proposal_detail(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Json<serde_json::Value> {
    match state.node.get_proposal(&id) {
        Ok(Some(p)) => Json(serde_json::json!({ "success": true, "proposal": p })),
        Ok(None) => Json(serde_json::json!({ "success": false, "error": "Proposal not found" })),
        Err(e) => Json(serde_json::json!({ "success": false, "error": e })),
    }
}

async fn get_proposal_votes(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Json<serde_json::Value> {
    match state.node.get_votes_for_proposal(&id) {
        Ok(votes) => Json(serde_json::json!({ "success": true, "votes": votes })),
        Err(e) => Json(serde_json::json!({ "success": false, "error": e })),
    }
}

async fn get_all_delegations(
    State(state): State<AppState>,
) -> Json<serde_json::Value> {
    match state.node.governance_store.get_all_delegations() {
        Ok(delegations) => {
            let mapped: Vec<serde_json::Value> = delegations.iter().map(|(from, to)| {
                serde_json::json!({ "delegator": from, "delegate": to })
            }).collect();
            Json(serde_json::json!({ "success": true, "delegations": mapped }))
        }
        Err(e) => Json(serde_json::json!({ "success": false, "error": e })),
    }
}

async fn get_delegation(
    State(state): State<AppState>,
    Path(pubkey): Path<String>,
) -> Json<serde_json::Value> {
    match state.node.governance_store.get_delegation(&pubkey) {
        Ok(Some(delegate)) => Json(serde_json::json!({
            "success": true,
            "delegator": pubkey,
            "delegate": delegate,
        })),
        Ok(None) => Json(serde_json::json!({
            "success": true,
            "delegator": pubkey,
            "delegate": null,
        })),
        Err(e) => Json(serde_json::json!({ "success": false, "error": e })),
    }
}

async fn get_allowances(
    State(state): State<AppState>,
    Path(pubkey): Path<String>,
) -> Json<serde_json::Value> {
    match state.node.get_allowances_by_owner(&pubkey) {
        Ok(allowances) => Json(serde_json::json!({ "success": true, "allowances": allowances })),
        Err(e) => Json(serde_json::json!({ "success": false, "error": e })),
    }
}

async fn get_account_nonce(
    State(state): State<AppState>,
    Path(pubkey): Path<String>,
) -> Json<serde_json::Value> {
    let current = state.node.get_account_nonce(&pubkey);
    Json(serde_json::json!({
        "success": true,
        "nonce": current,
        "next_nonce": current + 1
    }))
}

async fn v2_token_freeze(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let public_key = body.get("public_key").and_then(|v| v.as_str())
        .ok_or_else(|| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "missing public_key"}))))?;
    let payload_str = body.get("payload").and_then(|v| v.as_str())
        .ok_or_else(|| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "missing payload"}))))?;
    let _signature = body.get("signature").and_then(|v| v.as_str())
        .ok_or_else(|| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "missing signature"}))))?;

    let payload: serde_json::Value = serde_json::from_str(payload_str)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": format!("invalid payload: {}", e)}))))?;

    let symbol = payload.get("tokenSymbol").or_else(|| payload.get("token_symbol"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "missing tokenSymbol"}))))?;
    let frozen = payload.get("frozen").and_then(|v| v.as_bool()).unwrap_or(true);

    // Verify caller is the creator
    let node = &state.node;
    match node.is_token_creator(symbol, public_key) {
        Ok(true) => {}
        Ok(false) => return Err((StatusCode::FORBIDDEN, Json(serde_json::json!({
            "success": false, "error": "only the token creator can freeze/unfreeze"
        })))),
        Err(e) => return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
            "success": false, "error": e
        })))),
    }

    node.set_token_frozen(symbol, frozen)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"success": false, "error": e}))))?;

    Ok(Json(serde_json::json!({
        "success": true,
        "symbol": symbol,
        "frozen": frozen
    })))
}

async fn v2_token_mint(
    State(state): State<AppState>,
    Json(body): Json<SignedTransactionRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    use quantum_vault_types::{TxPayload, TxV1};

    let signed_payload = verify_signed_tx(&body).map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;

    let node = &state.node;
    let payload = &body.payload;

    let token_symbol = payload.get("token_symbol").and_then(|v| v.as_str()).unwrap_or_default();
    let amount = payload.get("amount").and_then(|v| v.as_u64()).unwrap_or(0);
    let fee = 1.0_f64;

    let sym_upper = token_symbol.trim().to_uppercase();
    if sym_upper.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "token_symbol is required"}))));
    }
    if amount == 0 {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": "amount must be greater than zero"}))));
    }

    // Verify creator authority
    match node.is_token_creator(&sym_upper, &body.public_key) {
        Ok(true) => {}
        Ok(false) => return Err((StatusCode::FORBIDDEN, Json(serde_json::json!({
            "success": false, "error": "only the token creator can mint"
        })))),
        Err(e) => return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
            "success": false, "error": e
        })))),
    }

    // Check mintable flag
    match node.is_token_mintable(&sym_upper) {
        Ok(true) => {}
        Ok(false) => return Err((StatusCode::FORBIDDEN, Json(serde_json::json!({
            "success": false, "error": format!("Token {} is not mintable", sym_upper)
        })))),
        Err(e) => return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
            "success": false, "error": e
        })))),
    }

    // Check max_supply cap
    if let Ok(Some(meta)) = node.get_token_metadata(&sym_upper) {
        if let Some(max) = meta.max_supply {
            if meta.total_minted + amount > max {
                return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
                    "success": false,
                    "error": format!("Would exceed max supply: {} + {} > {}", meta.total_minted, amount, max)
                }))));
            }
        }
    }

    // Check XRGE balance for fee
    let bal = node.get_balance(&body.public_key).unwrap_or(0.0);
    if bal < fee {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({
            "success": false,
            "error": format!("Insufficient XRGE for mint fee: have {:.4}, need {:.4}", bal, fee)
        }))));
    }

    let tx = TxV1 {
        version: 1,
        tx_type: "mint_tokens".to_string(),
        from_pub_key: body.public_key.clone(),
        nonce: state.node.get_next_nonce(&body.public_key),
        payload: TxPayload {
            token_symbol: Some(token_symbol.to_string()),
            token_total_supply: Some(amount),
            ..Default::default()
        },
        fee,
        sig: body.signature.clone(),
        signed_payload: Some(signed_payload),
    };

    let tx_clone = tx.clone();
    node.add_tx_to_mempool(tx)
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(serde_json::json!({"success": false, "error": e}))))?;
    let peers = state.peer_manager.get_peers().await;
    if !peers.is_empty() { peer::broadcast_tx(&peers, &tx_clone); }

    // Update metadata total_minted
    let _ = node.record_token_mint(&sym_upper, amount);

    Ok(Json(serde_json::json!({
        "success": true,
        "symbol": sym_upper,
        "amount_minted": amount
    })))
}

// ─── WASM Smart Contract Handlers ─────────────────────────────────────────────

/// Deploy a new WASM smart contract
async fn contract_deploy(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let wasm_base64 = body.get("wasm")
        .and_then(|v| v.as_str())
        .ok_or(StatusCode::BAD_REQUEST)?;

    let deployer = body.get("deployer")
        .and_then(|v| v.as_str())
        .ok_or(StatusCode::BAD_REQUEST)?;

    let nonce = body.get("nonce")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    use base64::Engine as _;
    let wasm_bytes = base64::engine::general_purpose::STANDARD
        .decode(wasm_base64)
        .map_err(|_| StatusCode::BAD_REQUEST)?;

    let block_height = state.node.get_tip_height().unwrap_or(0);

    match state.wasm_runtime.deploy_contract(
        &state.contract_store,
        deployer,
        nonce,
        &wasm_bytes,
        block_height,
    ) {
        Ok(address) => {
            // Submit on-chain transaction so it appears in the tx feed
            let wasm_size = wasm_bytes.len();
            if let Ok(tx) = state.node.submit_contract_deploy_tx(deployer, &address, wasm_size) {
                use quantum_vault_crypto::{bytes_to_hex, sha256};
                use quantum_vault_types::encode_tx_v1;
                let tx_id = bytes_to_hex(&sha256(&encode_tx_v1(&tx)));
                state.ws_broadcaster.broadcast_new_tx(
                    &tx_id,
                    &tx.tx_type,
                    &tx.from_pub_key,
                    tx.payload.contract_addr.as_deref(),
                    tx.payload.amount.map(|a| a as u64),
                );
            }
            Ok(Json(serde_json::json!({
                "success": true,
                "address": address,
                "wasmSize": wasm_size,
            })))
        },
        Err(e) => Ok(Json(serde_json::json!({
            "success": false,
            "error": e,
        }))),
    }
}

/// Call a WASM smart contract method (mutating)
async fn contract_call(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let contract_addr = body.get("contractAddr")
        .and_then(|v| v.as_str())
        .ok_or(StatusCode::BAD_REQUEST)?;

    let method = body.get("method")
        .and_then(|v| v.as_str())
        .ok_or(StatusCode::BAD_REQUEST)?;

    let caller = body.get("caller")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let args = body.get("args").cloned().unwrap_or(serde_json::Value::Null);

    let gas_limit = body.get("gasLimit")
        .and_then(|v| v.as_u64())
        .unwrap_or(quantum_vault_vm::DEFAULT_FUEL_LIMIT);

    let block_height = state.node.get_tip_height().unwrap_or(0);
    let block_time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let balances = std::collections::HashMap::new(); // TODO: load from node

    let tx_hash = format!("call-{}-{}", contract_addr, block_height);

    match state.wasm_runtime.execute_contract(
        &state.contract_store,
        contract_addr,
        method,
        &args,
        caller,
        block_height,
        block_time,
        balances,
        gas_limit,
        &tx_hash,
    ) {
        Ok(result) => {
            // Submit on-chain transaction so it appears in the tx feed
            if let Ok(tx) = state.node.submit_contract_call_tx(
                caller,
                contract_addr,
                method,
                result.gas_used,
                result.success,
            ) {
                use quantum_vault_crypto::{bytes_to_hex, sha256};
                use quantum_vault_types::encode_tx_v1;
                let tx_id = bytes_to_hex(&sha256(&encode_tx_v1(&tx)));
                state.ws_broadcaster.broadcast_new_tx(
                    &tx_id,
                    &tx.tx_type,
                    &tx.from_pub_key,
                    tx.payload.contract_addr.as_deref(),
                    tx.payload.contract_gas_limit.map(|g| g as u64),
                );
            }
            Ok(Json(serde_json::json!({
                "success": result.success,
                "returnData": result.return_data,
                "gasUsed": result.gas_used,
                "events": result.events,
                "error": result.error,
            })))
        },
        Err(e) => Ok(Json(serde_json::json!({
            "success": false,
            "error": e,
        }))),
    }
}

/// Get contract metadata
async fn contract_get(
    State(state): State<AppState>,
    Path(addr): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    match state.contract_store.get_contract(&addr) {
        Ok(Some(meta)) => Ok(Json(serde_json::json!({
            "success": true,
            "contract": meta,
        }))),
        Ok(None) => Ok(Json(serde_json::json!({
            "success": false,
            "error": "Contract not found",
        }))),
        Err(e) => Ok(Json(serde_json::json!({
            "success": false,
            "error": e,
        }))),
    }
}

/// Read contract storage — all state if no ?key param, single key otherwise
async fn contract_state(
    State(state): State<AppState>,
    Path(addr): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    // If a specific key is requested, return just that value
    if let Some(key) = params.get("key") {
        let key_bytes = hex::decode(key).unwrap_or_else(|_| key.as_bytes().to_vec());
        return match state.contract_store.storage_read(&addr, &key_bytes) {
            Ok(Some(val)) => Ok(Json(serde_json::json!({
                "success": true,
                "key": key,
                "value": hex::encode(&val),
                "valueUtf8": String::from_utf8_lossy(&val),
            }))),
            Ok(None) => Ok(Json(serde_json::json!({
                "success": true,
                "key": key,
                "value": null,
            }))),
            Err(e) => Ok(Json(serde_json::json!({
                "success": false,
                "error": e,
            }))),
        };
    }

    // No key specified — return full state dump
    match state.contract_store.load_all_state(&addr) {
        Ok(all_state) => {
            let mut state_map = serde_json::Map::new();
            for (key_bytes, val_bytes) in &all_state {
                let key_str = String::from_utf8(key_bytes.clone())
                    .unwrap_or_else(|_| hex::encode(key_bytes));
                let val_str = String::from_utf8(val_bytes.clone())
                    .unwrap_or_else(|_| hex::encode(val_bytes));
                state_map.insert(key_str, serde_json::Value::String(val_str));
            }
            Ok(Json(serde_json::json!({
                "success": true,
                "state": state_map,
                "count": all_state.len(),
            })))
        }
        Err(e) => Ok(Json(serde_json::json!({
            "success": false,
            "error": e,
        }))),
    }
}

/// Get events for a contract
async fn contract_events(
    State(state): State<AppState>,
    Path(addr): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let limit = params.get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(50);

    match state.contract_store.get_events(&addr, limit) {
        Ok(events) => Ok(Json(serde_json::json!({
            "success": true,
            "events": events,
            "count": events.len(),
        }))),
        Err(e) => Ok(Json(serde_json::json!({
            "success": false,
            "error": e,
        }))),
    }
}

/// List all deployed contracts
async fn contract_list(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    match state.contract_store.list_contracts() {
        Ok(contracts) => Ok(Json(serde_json::json!({
            "success": true,
            "contracts": contracts,
            "count": contracts.len(),
        }))),
        Err(e) => Ok(Json(serde_json::json!({
            "success": false,
            "error": e,
        }))),
    }
}

/// EIP-1559 fee info endpoint
async fn fee_info(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let base_fee = state.node.get_base_fee();
    let total_burned = state.node.get_total_fees_burned();
    let height = state.node.get_tip_height().unwrap_or(0);

    // Suggested priority fee: small tip on top of base fee
    let suggested_priority_fee = (base_fee * 0.1).max(0.0001);

    Ok(Json(serde_json::json!({
        "success": true,
        "baseFee": base_fee,
        "minFee": 0.001,
        "suggestedPriorityFee": suggested_priority_fee,
        "suggestedTotalFee": base_fee + suggested_priority_fee,
        "totalBurned": total_burned,
        "targetTxsPerBlock": 10,
        "maxChangePercent": 12.5,
        "blockHeight": height,
    })))
}

// ── Multi-sig wallet API handlers ──

/// List all multisig wallets
async fn multisig_list_wallets(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    match state.node.multisig_store.list_wallets() {
        Ok(wallets) => Ok(Json(serde_json::json!({
            "success": true,
            "wallets": wallets,
            "count": wallets.len(),
        }))),
        Err(e) => Ok(Json(serde_json::json!({
            "success": false,
            "error": e,
        }))),
    }
}

/// Get a specific multisig wallet
async fn multisig_get_wallet(
    State(state): State<AppState>,
    Path(wallet_id): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    match state.node.multisig_store.get_wallet(&wallet_id) {
        Ok(Some(wallet)) => Ok(Json(serde_json::json!({
            "success": true,
            "wallet": wallet,
        }))),
        Ok(None) => Ok(Json(serde_json::json!({
            "success": false,
            "error": "Wallet not found",
        }))),
        Err(e) => Ok(Json(serde_json::json!({
            "success": false,
            "error": e,
        }))),
    }
}

/// Get proposals for a multisig wallet
async fn multisig_get_proposals(
    State(state): State<AppState>,
    Path(wallet_id): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    match state.node.multisig_store.get_proposals_by_wallet(&wallet_id) {
        Ok(proposals) => Ok(Json(serde_json::json!({
            "success": true,
            "proposals": proposals,
            "count": proposals.len(),
        }))),
        Err(e) => Ok(Json(serde_json::json!({
            "success": false,
            "error": e,
        }))),
    }
}

/// Get wallets where a pubkey is a co-signer
async fn multisig_wallets_by_signer(
    State(state): State<AppState>,
    Path(pubkey): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    match state.node.multisig_store.get_wallets_by_signer(&pubkey) {
        Ok(wallets) => Ok(Json(serde_json::json!({
            "success": true,
            "wallets": wallets,
            "count": wallets.len(),
        }))),
        Err(e) => Ok(Json(serde_json::json!({
            "success": false,
            "error": e,
        }))),
    }
}
