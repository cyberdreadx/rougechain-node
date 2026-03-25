use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::AppState;

/// JSON-RPC 2.0 Request
#[derive(Debug, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
    pub id: Value,
}

/// JSON-RPC 2.0 Response
#[derive(Debug, Serialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
    pub id: Value,
}

/// JSON-RPC 2.0 Error
#[derive(Debug, Serialize)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl JsonRpcResponse {
    pub fn success(id: Value, result: Value) -> Self {
        Self { jsonrpc: "2.0".to_string(), result: Some(result), error: None, id }
    }
    pub fn error(id: Value, code: i64, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(), result: None,
            error: Some(JsonRpcError { code, message: message.into(), data: None }), id,
        }
    }
    pub fn method_not_found(id: Value) -> Self { Self::error(id, -32601, "Method not found") }
    pub fn invalid_params(id: Value, msg: impl Into<String>) -> Self { Self::error(id, -32602, msg) }
}

fn param_str(params: &Value, idx: usize) -> Option<&str> {
    params.as_array().and_then(|p| p.get(idx)).and_then(|v| v.as_str())
}

/// Route a JSON-RPC 2.0 request to the appropriate handler
pub async fn handle_rpc(state: &AppState, req: JsonRpcRequest) -> JsonRpcResponse {
    let id = req.id.clone();
    match req.method.as_str() {
        // ── Chain info ──────────────────────────────────────────────
        "eth_chainId" | "rouge_chainId" =>
            JsonRpcResponse::success(id, Value::String(state.node.chain_id())),

        "eth_blockNumber" | "rouge_blockNumber" => match state.node.get_tip_height() {
            Ok(h) => JsonRpcResponse::success(id, Value::String(format!("0x{:x}", h))),
            Err(e) => JsonRpcResponse::error(id, -32000, e),
        },

        "net_version" => JsonRpcResponse::success(id, Value::String("1".to_string())),
        "net_listening" => JsonRpcResponse::success(id, Value::Bool(true)),
        "net_peerCount" => {
            let c = state.peer_manager.peer_count().await;
            JsonRpcResponse::success(id, Value::String(format!("0x{:x}", c)))
        }
        "web3_clientVersion" =>
            JsonRpcResponse::success(id, Value::String(format!("RougeChain/{}", env!("CARGO_PKG_VERSION")))),

        // ── Balances ────────────────────────────────────────────────
        "eth_getBalance" | "rouge_getBalance" => match param_str(&req.params, 0) {
            Some(addr) => match state.node.get_balance(addr) {
                Ok(b) => JsonRpcResponse::success(id, Value::String(format!("0x{:x}", b as u64))),
                Err(e) => JsonRpcResponse::error(id, -32000, e),
            },
            None => JsonRpcResponse::invalid_params(id, "Missing address"),
        },

        "rouge_getTokenBalance" => match (param_str(&req.params, 0), param_str(&req.params, 1)) {
            (Some(addr), Some(sym)) => match state.node.get_token_balance(addr, sym) {
                Ok(b) => JsonRpcResponse::success(id, serde_json::json!(b)),
                Err(e) => JsonRpcResponse::error(id, -32000, e),
            },
            _ => JsonRpcResponse::invalid_params(id, "Missing address or symbol"),
        },

        "rouge_getAllTokenBalances" => match param_str(&req.params, 0) {
            Some(addr) => match state.node.get_all_token_balances(addr) {
                Ok(b) => JsonRpcResponse::success(id, serde_json::json!(b)),
                Err(e) => JsonRpcResponse::error(id, -32000, e),
            },
            None => JsonRpcResponse::invalid_params(id, "Missing address"),
        },

        // ── Blocks ──────────────────────────────────────────────────
        "eth_getBlockByNumber" | "rouge_getBlockByNumber" => {
            let height = req.params.as_array().and_then(|p| p.first()).and_then(|v| {
                if let Some(s) = v.as_str() {
                    if s == "latest" { state.node.get_tip_height().ok() }
                    else if let Some(hex) = s.strip_prefix("0x") { u64::from_str_radix(hex, 16).ok() }
                    else { s.parse::<u64>().ok() }
                } else { v.as_u64() }
            });
            match height {
                Some(h) => match state.node.get_block(h) {
                    Ok(Some(block)) => {
                        let block_json = serde_json::json!({
                            "number": format!("0x{:x}", block.header.height),
                            "hash": block.hash,
                            "parentHash": block.header.prev_hash,
                            "timestamp": format!("0x{:x}", block.header.time / 1000),
                            "chainId": block.header.chain_id,
                            "proposer": block.header.proposer_pub_key,
                            "transactions": block.txs.iter().map(|tx| {
                                serde_json::json!({
                                    "type": tx.tx_type,
                                    "from": tx.from_pub_key,
                                    "to": tx.payload.to_pub_key_hex,
                                    "value": tx.payload.amount,
                                    "fee": tx.fee,
                                    "nonce": format!("0x{:x}", tx.nonce),
                                    "hash": quantum_vault_types::compute_single_tx_hash(tx),
                                })
                            }).collect::<Vec<Value>>(),
                            "transactionCount": format!("0x{:x}", block.txs.len()),
                        });
                        JsonRpcResponse::success(id, block_json)
                    }
                    Ok(None) => JsonRpcResponse::success(id, Value::Null),
                    Err(e) => JsonRpcResponse::error(id, -32000, e),
                },
                None => JsonRpcResponse::invalid_params(id, "Invalid block number"),
            }
        }

        // ── Transaction receipt ─────────────────────────────────────
        "eth_getTransactionReceipt" | "rouge_getTransactionReceipt" =>
            match param_str(&req.params, 0) {
                Some(hash) => match state.node.get_receipt(hash) {
                    Ok(Some(r)) => {
                        let r_json = serde_json::json!({
                            "transactionHash": r.tx_hash,
                            "blockHeight": r.block_height,
                            "blockHash": r.block_hash,
                            "transactionIndex": format!("0x{:x}", r.index),
                            "type": r.tx_type,
                            "from": r.from,
                            "status": if matches!(r.status, quantum_vault_types::TxStatus::Success) { "0x1" } else { "0x0" },
                            "feePaid": r.fee_paid,
                            "logs": r.logs.iter().map(|l| serde_json::json!({
                                "eventType": l.event_type,
                                "data": l.data,
                            })).collect::<Vec<Value>>(),
                            "timestamp": r.timestamp,
                        });
                        JsonRpcResponse::success(id, r_json)
                    }
                    Ok(None) => JsonRpcResponse::success(id, Value::Null),
                    Err(e) => JsonRpcResponse::error(id, -32000, e),
                },
                None => JsonRpcResponse::invalid_params(id, "Missing tx hash"),
            },

        // ── Transaction count (nonce) ───────────────────────────────
        "eth_getTransactionCount" | "rouge_getTransactionCount" =>
            match param_str(&req.params, 0) {
                Some(addr) => {
                    let nonce = state.node.get_account_nonce(addr);
                    JsonRpcResponse::success(id, Value::String(format!("0x{:x}", nonce)))
                }
                None => JsonRpcResponse::invalid_params(id, "Missing address"),
            },

        // ── Validators ──────────────────────────────────────────────
        "rouge_getValidators" => match state.node.list_validators() {
            Ok(vals) => {
                let v: Vec<Value> = vals.iter().map(|(pk, vs)| serde_json::json!({
                    "pubKey": pk, "stake": vs.stake, "name": vs.name,
                    "slashCount": vs.slash_count, "jailedUntil": vs.jailed_until,
                    "missedBlocks": vs.missed_blocks, "totalSlashed": vs.total_slashed,
                    "blocksProposed": vs.blocks_proposed,
                })).collect();
                JsonRpcResponse::success(id, Value::Array(v))
            }
            Err(e) => JsonRpcResponse::error(id, -32000, e),
        },

        // ── Stats ───────────────────────────────────────────────────
        "rouge_getStats" => {
            let height = state.node.get_tip_height().unwrap_or(0);
            let peers = state.peer_manager.peer_count().await;
            JsonRpcResponse::success(id, serde_json::json!({
                "blockHeight": height, "peerCount": peers,
                "chainId": state.node.chain_id(),
                "clientVersion": format!("RougeChain/{}", env!("CARGO_PKG_VERSION")),
            }))
        }

        // ── Gas (EVM compatibility — flat fee model) ────────────────
        "eth_gasPrice" => {
            let fee = (state.node.get_base_fee() * 1_000_000.0) as u64;
            JsonRpcResponse::success(id, Value::String(format!("0x{:x}", fee)))
        }
        "eth_estimateGas" => JsonRpcResponse::success(id, Value::String("0x186a0".to_string())),

        // ── Governance ──────────────────────────────────────────────
        "rouge_getProposals" => match state.node.governance_store.list_proposals() {
            Ok(props) => {
                let p: Vec<Value> = props.iter().map(|p| serde_json::to_value(p).unwrap_or(Value::Null)).collect();
                JsonRpcResponse::success(id, Value::Array(p))
            }
            Err(e) => JsonRpcResponse::error(id, -32000, e),
        },

        "rouge_getDelegation" => match param_str(&req.params, 0) {
            Some(addr) => match state.node.governance_store.get_delegation(addr) {
                Ok(d) => JsonRpcResponse::success(id, serde_json::json!({"delegator": addr, "delegate": d.unwrap_or_default()})),
                Err(e) => JsonRpcResponse::error(id, -32000, e),
            },
            None => JsonRpcResponse::invalid_params(id, "Missing address"),
        },

        // ── Tokens ──────────────────────────────────────────────────
        "rouge_getTokens" => match state.node.get_all_token_metadata() {
            Ok(tokens) => {
                let t: Vec<Value> = tokens.iter().map(|t| serde_json::to_value(t).unwrap_or(Value::Null)).collect();
                JsonRpcResponse::success(id, Value::Array(t))
            }
            Err(e) => JsonRpcResponse::error(id, -32000, e),
        },

        // ── Pools ───────────────────────────────────────────────────
        "rouge_getPools" => match state.node.list_pools() {
            Ok(pools) => {
                let p: Vec<Value> = pools.iter().map(|p| serde_json::to_value(p).unwrap_or(Value::Null)).collect();
                JsonRpcResponse::success(id, Value::Array(p))
            }
            Err(e) => JsonRpcResponse::error(id, -32000, e),
        },

        // ── Unbonding Queue ─────────────────────────────────────────
        "rouge_getUnbondingQueue" => {
            if let Ok(queue) = state.node.unbonding_queue.lock() {
                let q: Vec<Value> = queue.iter().map(|e| serde_json::json!({
                    "delegator": e.delegator, "amount": e.amount,
                    "releaseHeight": e.release_height,
                })).collect();
                JsonRpcResponse::success(id, Value::Array(q))
            } else {
                JsonRpcResponse::error(id, -32000, "Failed to lock unbonding queue")
            }
        }

        _ => JsonRpcResponse::method_not_found(id),
    }
}
