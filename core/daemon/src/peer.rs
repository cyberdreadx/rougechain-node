use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tokio::time::sleep;

use crate::node::L1Node;
use quantum_vault_types::BlockV1;

/// Manages dynamic peer list
#[derive(Clone)]
pub struct PeerManager {
    peers: Arc<RwLock<HashSet<String>>>,
    self_url: Option<String>,
}

impl PeerManager {
    pub fn new(initial_peers: Vec<String>, self_url: Option<String>) -> Self {
        let peers: HashSet<String> = initial_peers.into_iter().collect();
        Self {
            peers: Arc::new(RwLock::new(peers)),
            self_url,
        }
    }

    pub async fn get_peers(&self) -> Vec<String> {
        self.peers.read().await.iter().cloned().collect()
    }

    pub async fn add_peer(&self, peer_url: String) -> bool {
        // Don't add ourselves
        if let Some(ref self_url) = self.self_url {
            if peer_url == *self_url {
                return false;
            }
        }
        
        let normalized = normalize_peer_url(&peer_url);
        let mut peers = self.peers.write().await;
        peers.insert(normalized)
    }

    pub async fn peer_count(&self) -> usize {
        self.peers.read().await.len()
    }
}

fn normalize_peer_url(url: &str) -> String {
    let url = url.trim().to_string();
    if url.ends_with("/api") {
        url
    } else if url.ends_with('/') {
        format!("{}api", url)
    } else {
        format!("{}/api", url)
    }
}

/// Parse comma-separated peer URLs
pub fn parse_peers(peers_str: &str) -> Vec<String> {
    peers_str
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|s| {
            // Ensure URL ends with /api if not already
            if s.ends_with("/api") {
                s
            } else if s.ends_with('/') {
                format!("{}api", s)
            } else {
                format!("{}/api", s)
            }
        })
        .collect()
}

/// Sync blocks from a peer (with genesis reset if needed)
async fn sync_from_peer(peer_url: &str, node: &L1Node, allow_genesis_reset: bool) -> Result<u64, String> {
    // Fetch peer's blocks
    let url = format!("{}/blocks?limit=1000", peer_url);
    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("Failed to fetch from {}: {}", peer_url, e))?;
    
    if !response.status().is_success() {
        return Err(format!("Peer {} returned status {}", peer_url, response.status()));
    }
    
    let data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response from {}: {}", peer_url, e))?;
    
    let blocks = data.get("blocks")
        .and_then(|b| b.as_array())
        .ok_or_else(|| "Invalid response format".to_string())?;
    
    if blocks.is_empty() {
        return Ok(0);
    }
    
    // Parse all blocks
    let mut peer_blocks: Vec<BlockV1> = Vec::new();
    for block_json in blocks {
        let block: BlockV1 = serde_json::from_value(block_json.clone())
            .map_err(|e| format!("Failed to parse block: {}", e))?;
        peer_blocks.push(block);
    }
    
    // Sort by height
    peer_blocks.sort_by_key(|b| b.header.height);
    
    let local_height = node.get_tip_height()?;
    let peer_height = peer_blocks.last().map(|b| b.header.height).unwrap_or(0);
    
    // Check if we need to reset from genesis (peer has longer chain and our genesis differs)
    if allow_genesis_reset && peer_height > local_height {
        if let Some(peer_genesis) = peer_blocks.first() {
            if peer_genesis.header.height == 0 {
                let our_genesis = node.get_block(0)?;
                if let Some(our_gen) = our_genesis {
                    if our_gen.hash != peer_genesis.hash {
                        eprintln!("[peer] Genesis mismatch - resetting chain from peer");
                        // Replace our chain with peer's chain
                        node.reset_chain(&peer_blocks)?;
                        return Ok(peer_blocks.len() as u64);
                    }
                }
            }
        }
    }
    
    // Normal incremental sync
    let mut synced_count = 0u64;
    for block in peer_blocks {
        // Skip blocks we already have
        if block.header.height <= local_height {
            continue;
        }
        
        // Import the block
        if let Err(e) = node.import_block(block.clone()) {
            eprintln!("[peer] Failed to import block {}: {}", block.header.height, e);
            break; // Stop on first error - chain is invalid
        }
        
        synced_count += 1;
    }
    
    Ok(synced_count)
}

/// Discover peers from a known peer
async fn discover_peers(peer_url: &str) -> Result<Vec<String>, String> {
    let url = format!("{}/peers", peer_url);
    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("Failed to fetch peers from {}: {}", peer_url, e))?;
    
    if !response.status().is_success() {
        return Err(format!("Peer {} returned status {}", peer_url, response.status()));
    }
    
    let data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse peers from {}: {}", peer_url, e))?;
    
    let peers = data.get("peers")
        .and_then(|p| p.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    
    Ok(peers)
}

/// Register ourselves with a peer
async fn register_with_peer(peer_url: &str, our_url: &str) -> Result<(), String> {
    let url = format!("{}/peers/register", peer_url);
    let client = reqwest::Client::new();
    
    let body = serde_json::json!({ "peerUrl": our_url });
    
    let response = client
        .post(&url)
        .json(&body)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| format!("Failed to register with {}: {}", peer_url, e))?;
    
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!("Registration failed with status {}", response.status()))
    }
}

/// Start the peer sync background task with discovery
pub async fn start_peer_sync(peer_manager: Arc<PeerManager>, node: Arc<L1Node>) {
    let initial_peers = peer_manager.get_peers().await;
    
    if initial_peers.is_empty() {
        eprintln!("[peer] No peers configured, waiting for incoming connections");
    } else {
        eprintln!("[peer] Starting peer sync with {} peers", initial_peers.len());
    }
    
    // Initial sync - try each peer until one succeeds (allow genesis reset on first sync)
    for peer in &initial_peers {
        eprintln!("[peer] Attempting initial sync from {}", peer);
        match sync_from_peer(peer, &node, true).await {
            Ok(count) => {
                eprintln!("[peer] Synced {} blocks from {}", count, peer);
                break;
            }
            Err(e) => {
                eprintln!("[peer] Failed to sync from {}: {}", peer, e);
            }
        }
    }
    
    // Register ourselves with known peers
    if let Some(ref self_url) = peer_manager.self_url {
        for peer in &initial_peers {
            match register_with_peer(peer, self_url).await {
                Ok(()) => eprintln!("[peer] Registered with {}", peer),
                Err(e) => eprintln!("[peer] Failed to register with {}: {}", peer, e),
            }
        }
    }
    
    let mut discovery_counter = 0u32;
    
    // Continuous sync loop
    loop {
        sleep(Duration::from_secs(5)).await;
        
        let peers = peer_manager.get_peers().await;
        
        for peer in &peers {
            // Sync blocks
            match sync_from_peer(peer, &node, false).await {
                Ok(count) if count > 0 => {
                    eprintln!("[peer] Synced {} new blocks from {}", count, peer);
                }
                Ok(_) => {} // No new blocks
                Err(e) => {
                    eprintln!("[peer] Sync error from {}: {}", peer, e);
                }
            }
        }
        
        // Peer discovery every 30 seconds (6 iterations)
        discovery_counter += 1;
        if discovery_counter >= 6 {
            discovery_counter = 0;
            
            for peer in &peers {
                match discover_peers(peer).await {
                    Ok(new_peers) => {
                        for new_peer in new_peers {
                            if peer_manager.add_peer(new_peer.clone()).await {
                                eprintln!("[peer] Discovered new peer: {}", new_peer);
                            }
                        }
                    }
                    Err(_) => {} // Ignore discovery errors
                }
            }
        }
    }
}

/// Broadcast a new block to all peers
pub async fn broadcast_block(peers: &[String], block: &BlockV1) {
    for peer in peers {
        let url = format!("{}/blocks/import", peer);
        let block_clone = block.clone();
        
        tokio::spawn(async move {
            let client = reqwest::Client::new();
            match client
                .post(&url)
                .json(&block_clone)
                .timeout(Duration::from_secs(5))
                .send()
                .await
            {
                Ok(res) if res.status().is_success() => {
                    eprintln!("[peer] Broadcast block {} to {}", block_clone.header.height, url);
                }
                Ok(res) => {
                    eprintln!("[peer] Failed to broadcast to {}: {}", url, res.status());
                }
                Err(e) => {
                    eprintln!("[peer] Failed to broadcast to {}: {}", url, e);
                }
            }
        });
    }
}

use quantum_vault_types::TxV1;

/// Broadcast a transaction to all peers
pub fn broadcast_tx(peers: &[String], tx: &TxV1) {
    for peer in peers {
        let url = format!("{}/tx/broadcast", peer);
        let tx_clone = tx.clone();
        let tx_type = tx.tx_type.clone();
        
        tokio::spawn(async move {
            let client = reqwest::Client::new();
            match client
                .post(&url)
                .json(&tx_clone)
                .timeout(Duration::from_secs(5))
                .send()
                .await
            {
                Ok(res) if res.status().is_success() => {
                    eprintln!("[peer] Broadcast tx ({}) to {}", tx_type, url);
                }
                Ok(_) => {} // Peer may already have it
                Err(_) => {} // Peer offline
            }
        });
    }
}
