use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use serde::{Deserialize, Serialize};
use quantum_vault_types::BlockV1;

/// Buffered frames per receiver. A client that falls further behind skips the
/// oldest frames (Lagged) instead of being disconnected.
const BROADCAST_CAPACITY: usize = 1024;

/// Default concurrent WebSocket connection cap; override with QV_WS_MAX_CLIENTS.
const DEFAULT_MAX_WS_CLIENTS: usize = 5000;

/// Max messenger identities one connection may authenticate (multi-wallet apps).
pub const MAX_INBOXES_PER_CONNECTION: usize = 8;

fn max_ws_clients() -> usize {
    static CAP: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *CAP.get_or_init(|| {
        std::env::var("QV_WS_MAX_CLIENTS").ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(DEFAULT_MAX_WS_CLIENTS)
    })
}

/// Private per-wallet topic. Hashed so topic strings stay short (signing keys are
/// ~3.9 KB of hex) and so a topic name never exposes a key.
pub fn inbox_topic(signing_public_key: &str) -> String {
    use sha2::{Digest, Sha256};
    let h = Sha256::digest(signing_public_key.trim().to_ascii_lowercase().as_bytes());
    format!("inbox:{}", hex::encode(h))
}

/// A serialized event plus its routing, computed ONCE per event (not per connection).
#[derive(Debug)]
pub struct WsFrame {
    pub json: String,
    pub topics: Vec<String>,
    /// Private frames go only to connections that authenticated one of `topics`;
    /// they are never delivered to unsubscribed "firehose" clients.
    pub private: bool,
}

/// Events that can be broadcast to WebSocket clients
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsEvent {
    /// A new block was mined/imported
    NewBlock {
        height: u64,
        hash: String,
        tx_count: usize,
        timestamp: u64,
    },
    /// A new transaction was received in mempool
    NewTransaction {
        tx_hash: String,
        tx_type: String,
        from: String,
        to: Option<String>,
        amount: Option<u64>,
    },
    /// Network stats update
    Stats {
        block_height: u64,
        peer_count: usize,
        mempool_size: usize,
    },
    /// Balance change notification (for account subscriptions)
    BalanceUpdate {
        account: String,
        token: String,
        new_balance: f64,
    },
    /// A new encrypted messenger message was stored. PRIVATE: delivered only to
    /// connections authenticated as one of the participants. Carries routing
    /// metadata (never content) so apps can refresh, badge and toast instantly.
    NewMessage {
        conversation_id: String,
        message_id: String,
        created_at: String,
        /// Sender's signing public key.
        sender_wallet_id: String,
        /// Participants' signing public keys.
        participant_ids: Vec<String>,
    },
    /// Subscription confirmation
    Subscribed {
        topics: Vec<String>,
    },
}

impl WsEvent {
    /// Return the topics this event matches for subscription filtering.
    /// Clients subscribe to topics like "blocks", "transactions", "account:<pubkey>", "token:<symbol>"
    pub fn topics(&self) -> Vec<String> {
        match self {
            WsEvent::NewBlock { .. } => vec!["blocks".to_string()],
            WsEvent::NewTransaction { from, to, .. } => {
                let mut t = vec!["transactions".to_string()];
                t.push(format!("account:{}", from));
                if let Some(dest) = to {
                    t.push(format!("account:{}", dest));
                }
                t
            }
            WsEvent::Stats { .. } => vec!["stats".to_string()],
            WsEvent::BalanceUpdate { account, token, .. } => {
                vec![
                    format!("account:{}", account),
                    format!("token:{}", token),
                ]
            }
            WsEvent::NewMessage { participant_ids, .. } => {
                participant_ids.iter().map(|pk| inbox_topic(pk)).collect()
            }
            WsEvent::Subscribed { .. } => vec![], // Always sent to the requesting client
        }
    }
}

impl WsEvent {
    pub fn is_private(&self) -> bool {
        matches!(self, WsEvent::NewMessage { .. })
    }
}

/// Manages WebSocket connections and broadcasts
#[derive(Clone)]
pub struct WsBroadcaster {
    sender: broadcast::Sender<Arc<WsFrame>>,
    /// Track connected client count
    client_count: Arc<RwLock<usize>>,
}

impl WsBroadcaster {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(BROADCAST_CAPACITY);
        Self {
            sender,
            client_count: Arc::new(RwLock::new(0)),
        }
    }

    /// Subscribe to receive broadcast messages
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<WsFrame>> {
        self.sender.subscribe()
    }

    /// Get current number of connected clients
    pub async fn client_count(&self) -> usize {
        *self.client_count.read().await
    }

    /// Check if we can accept a new connection
    pub async fn try_connect(&self) -> bool {
        let mut count = self.client_count.write().await;
        if *count >= max_ws_clients() {
            eprintln!("[ws] Connection rejected — at limit ({}/{})", *count, max_ws_clients());
            return false;
        }
        *count += 1;
        if *count % 50 == 0 {
            eprintln!("[ws] Connections: {}/{}", *count, max_ws_clients());
        }
        true
    }

    /// Decrement client count (call when client disconnects)
    pub async fn client_disconnected(&self) {
        let mut count = self.client_count.write().await;
        *count = count.saturating_sub(1);
    }

    /// Serialize + route an event once; each connection only does a set lookup.
    pub fn frame(event: &WsEvent) -> Option<Arc<WsFrame>> {
        let json = serde_json::to_string(event).ok()?;
        Some(Arc::new(WsFrame { json, topics: event.topics(), private: event.is_private() }))
    }

    /// Broadcast an event to all connected clients (subject to per-connection routing)
    pub fn broadcast(&self, event: WsEvent) {
        if let Some(frame) = Self::frame(&event) {
            // Ignore send errors (no receivers)
            let _ = self.sender.send(frame);
        }
    }

    /// Broadcast a new block event
    pub fn broadcast_new_block(&self, block: &BlockV1) {
        self.broadcast(WsEvent::NewBlock {
            height: block.header.height,
            hash: block.hash.clone(),
            tx_count: block.txs.len(),
            timestamp: block.header.time,
        });
    }

    /// Broadcast a new transaction event
    pub fn broadcast_new_tx(&self, tx_hash: &str, tx_type: &str, from: &str, to: Option<&str>, amount: Option<u64>) {
        self.broadcast(WsEvent::NewTransaction {
            tx_hash: tx_hash.to_string(),
            tx_type: tx_type.to_string(),
            from: from.to_string(),
            to: to.map(|s| s.to_string()),
            amount,
        });
    }

    /// Notify the participants of a conversation (private, per-wallet) of a new message.
    pub fn broadcast_new_message(
        &self,
        conversation_id: &str,
        message_id: &str,
        created_at: &str,
        sender_signing_key: &str,
        participant_signing_keys: Vec<String>,
    ) {
        if participant_signing_keys.is_empty() {
            return;
        }
        self.broadcast(WsEvent::NewMessage {
            conversation_id: conversation_id.to_string(),
            message_id: message_id.to_string(),
            created_at: created_at.to_string(),
            sender_wallet_id: sender_signing_key.to_string(),
            participant_ids: participant_signing_keys,
        });
    }

    /// Broadcast stats update
    pub fn broadcast_stats(&self, block_height: u64, peer_count: usize, mempool_size: usize) {
        self.broadcast(WsEvent::Stats {
            block_height,
            peer_count,
            mempool_size,
        });
    }
}

impl Default for WsBroadcaster {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(parts: &[&str]) -> WsEvent {
        WsEvent::NewMessage {
            conversation_id: "dm_x".into(),
            message_id: "m1".into(),
            created_at: "t".into(),
            sender_wallet_id: parts[0].into(),
            participant_ids: parts.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn new_message_is_private_and_routed_to_participant_inboxes_only() {
        let f = WsBroadcaster::frame(&msg(&["AAAA", "bbbb"])).unwrap();
        assert!(f.private);
        assert_eq!(f.topics, vec![inbox_topic("aaaa"), inbox_topic("BBBB")]);
        assert!(!f.topics.contains(&inbox_topic("cccc")));
        assert!(f.topics.iter().all(|t| t.starts_with("inbox:") && t.len() == 6 + 64));
    }

    #[test]
    fn new_message_wire_shape_matches_clients() {
        let f = WsBroadcaster::frame(&msg(&["aa", "bb"])).unwrap();
        let v: serde_json::Value = serde_json::from_str(&f.json).unwrap();
        assert_eq!(v["type"], "new_message");
        assert_eq!(v["conversation_id"], "dm_x");
        assert_eq!(v["message_id"], "m1");
        assert_eq!(v["sender_wallet_id"], "aa");
        assert_eq!(v["participant_ids"], serde_json::json!(["aa", "bb"]));
        assert!(v.get("encrypted_content").is_none());
    }

    #[test]
    fn public_events_are_not_private() {
        let f = WsBroadcaster::frame(&WsEvent::Stats { block_height: 1, peer_count: 0, mempool_size: 0 }).unwrap();
        assert!(!f.private);
    }
}
