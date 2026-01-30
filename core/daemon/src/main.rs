mod grpc;
mod node;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
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
}

#[tokio::main]
async fn main() -> Result<(), String> {
    let args = Args::parse();
    let data_dir = args
        .data_dir
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

    let grpc_node = GrpcNode::new(node.clone());
    let reflection = tonic_reflection::server::Builder::configure()
        .register_encoded_file_descriptor_set(grpc::FILE_DESCRIPTOR_SET)
        .build()
        .map_err(|e| e.to_string())?;

    let grpc_server = tonic::transport::Server::builder()
        .add_service(grpc_node.clone().chain_service())
        .add_service(grpc_node.clone().wallet_service())
        .add_service(grpc_node.clone().validator_service())
        .add_service(grpc_node.clone().messenger_service())
        .add_service(reflection)
        .serve(grpc_addr);

    let api_router = build_http_router(node.clone());
    let api_server = axum::Server::bind(&api_addr).serve(api_router.into_make_service());

    if node.is_mining() {
        let miner = node.clone();
        tokio::spawn(async move {
            loop {
                let _ = miner.mine_pending();
                sleep(Duration::from_millis(1000)).await;
            }
        });
    }

    tokio::select! {
        _ = grpc_server => {},
        _ = api_server => {},
        _ = tokio::signal::ctrl_c() => {},
    }

    Ok(())
}

fn build_http_router(node: Arc<L1Node>) -> Router {
    Router::new()
        .route("/api/stats", get(get_stats))
        .route("/api/health", get(get_health))
        .route("/api/blocks", get(get_blocks))
        .route("/api/blocks/summary", get(get_blocks_summary))
        .route("/api/balance/:public_key", get(get_balance))
        .route("/api/wallet/create", post(create_wallet))
        .route("/api/tx/submit", post(submit_tx))
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
        .layer(
            CorsLayer::new()
                .allow_methods(Any)
                .allow_origin(Any)
                .allow_headers(Any),
        )
        .with_state(node)
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

async fn get_stats(State(node): State<Arc<L1Node>>) -> Result<Json<StatsResponse>, StatusCode> {
    let height = node.get_tip_height().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let (total_fees, last_fees) = node.get_fee_stats().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let (finalized, _, _, _) = node.get_finality_status().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(StatsResponse {
        connected_peers: 0,
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

async fn get_health(State(node): State<Arc<L1Node>>) -> Result<Json<HealthResponse>, StatusCode> {
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
    State(node): State<Arc<L1Node>>,
    Query(query): Query<BlocksQuery>,
) -> Result<Json<BlocksResponse>, StatusCode> {
    let blocks = if let Some(limit) = query.limit {
        node.get_recent_blocks(limit).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    } else {
        node.get_all_blocks().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    };
    Ok(Json(BlocksResponse { blocks }))
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
    State(node): State<Arc<L1Node>>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<BlocksSummaryResponse>, StatusCode> {
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
    State(node): State<Arc<L1Node>>,
    Path(public_key): Path<String>,
) -> Result<Json<BalanceResponse>, StatusCode> {
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

async fn create_wallet(State(node): State<Arc<L1Node>>) -> Result<Json<WalletResponse>, StatusCode> {
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
    amount: u64,
    fee: Option<f64>,
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
    State(node): State<Arc<L1Node>>,
    Json(body): Json<SubmitTxRequest>,
) -> Result<Json<TxResponse>, StatusCode> {
    match node.submit_user_tx(
        &body.from_private_key,
        &body.from_public_key,
        &body.to_public_key,
        body.amount,
        body.fee,
    ) {
        Ok(tx) => {
            let id = quantum_vault_crypto::bytes_to_hex(&quantum_vault_crypto::sha256(&quantum_vault_types::encode_tx_v1(&tx)));
            Ok(Json(TxResponse { success: true, tx_id: Some(id), tx: Some(tx), error: None }))
        }
        Err(err) => Ok(Json(TxResponse { success: false, tx_id: None, tx: None, error: Some(err) })),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StakeRequest {
    from_private_key: String,
    from_public_key: String,
    amount: u64,
    fee: Option<f64>,
}

async fn submit_stake(
    State(node): State<Arc<L1Node>>,
    Json(body): Json<StakeRequest>,
) -> Result<Json<TxResponse>, StatusCode> {
    match node.submit_stake_tx(&body.from_private_key, &body.from_public_key, body.amount, body.fee) {
        Ok(tx) => {
            let id = quantum_vault_crypto::bytes_to_hex(&quantum_vault_crypto::sha256(&quantum_vault_types::encode_tx_v1(&tx)));
            Ok(Json(TxResponse { success: true, tx_id: Some(id), tx: Some(tx), error: None }))
        }
        Err(err) => Ok(Json(TxResponse { success: false, tx_id: None, tx: None, error: Some(err) })),
    }
}

async fn submit_unstake(
    State(node): State<Arc<L1Node>>,
    Json(body): Json<StakeRequest>,
) -> Result<Json<TxResponse>, StatusCode> {
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
    State(node): State<Arc<L1Node>>,
    Json(body): Json<FaucetRequest>,
) -> Result<Json<TxResponse>, StatusCode> {
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

async fn get_validators(State(node): State<Arc<L1Node>>) -> Result<Json<ValidatorsResponse>, StatusCode> {
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

async fn get_selection(State(node): State<Arc<L1Node>>) -> Result<Json<SelectionResponse>, StatusCode> {
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

async fn get_finality(State(node): State<Arc<L1Node>>) -> Result<Json<FinalityResponse>, StatusCode> {
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
    State(node): State<Arc<L1Node>>,
    Query(query): Query<VotesQuery>,
) -> Result<Json<VotesResponse>, StatusCode> {
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

async fn get_vote_stats(State(node): State<Arc<L1Node>>) -> Result<Json<VoteStatsResponse>, StatusCode> {
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
    State(node): State<Arc<L1Node>>,
    Json(body): Json<SubmitVoteRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
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
    State(node): State<Arc<L1Node>>,
    Json(body): Json<EntropyRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    node.submit_entropy(&body.public_key).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "success": true })))
}

async fn get_messenger_wallets(State(node): State<Arc<L1Node>>) -> Result<Json<serde_json::Value>, StatusCode> {
    let wallets = node.list_wallets().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "success": true, "wallets": wallets })))
}

async fn register_messenger_wallet(
    State(node): State<Arc<L1Node>>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, StatusCode> {
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
    State(node): State<Arc<L1Node>>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let wallet_id = query.get("walletId").cloned().unwrap_or_default();
    let conversations = node.list_conversations(&wallet_id).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "success": true, "conversations": conversations })))
}

async fn create_messenger_conversation(
    State(node): State<Arc<L1Node>>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, StatusCode> {
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
    State(node): State<Arc<L1Node>>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let conversation_id = query.get("conversationId").cloned().unwrap_or_default();
    let messages = node.list_messages(&conversation_id).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "success": true, "messages": messages })))
}

async fn send_messenger_message(
    State(node): State<Arc<L1Node>>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, StatusCode> {
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
    State(node): State<Arc<L1Node>>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, StatusCode> {
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
