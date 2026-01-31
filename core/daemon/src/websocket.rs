use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use serde::Serialize;
use quantum_vault_types::BlockV1;

/// Maximum number of buffered messages in the broadcast channel
const BROADCAST_CAPACITY: usize = 100;

/// Events that can be broadcast to WebSocket clients
#[derive(Clone, Debug, Serialize)]
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
}

/// Manages WebSocket connections and broadcasts
#[derive(Clone)]
pub struct WsBroadcaster {
    sender: broadcast::Sender<String>,
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
    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.sender.subscribe()
    }

    /// Get current number of connected clients
    pub async fn client_count(&self) -> usize {
        *self.client_count.read().await
    }

    /// Increment client count (call when client connects)
    pub async fn client_connected(&self) {
        let mut count = self.client_count.write().await;
        *count += 1;
        eprintln!("[ws] Client connected. Total: {}", *count);
    }

    /// Decrement client count (call when client disconnects)
    pub async fn client_disconnected(&self) {
        let mut count = self.client_count.write().await;
        *count = count.saturating_sub(1);
        eprintln!("[ws] Client disconnected. Total: {}", *count);
    }

    /// Broadcast an event to all connected clients
    pub fn broadcast(&self, event: WsEvent) {
        if let Ok(json) = serde_json::to_string(&event) {
            // Ignore send errors (no receivers)
            let _ = self.sender.send(json);
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
