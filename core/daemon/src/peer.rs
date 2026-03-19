use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use tokio::time::sleep;

use crate::node::L1Node;
use quantum_vault_types::BlockV1;

struct PeerHealth {
    consecutive_failures: u32,
    next_retry: Instant,
}

/// Manages dynamic peer list
#[derive(Clone)]
pub struct PeerManager {
    peers: Arc<RwLock<HashSet<String>>>,
    health: Arc<RwLock<HashMap<String, PeerHealth>>>,
    self_url: Option<String>,
}

impl PeerManager {
    pub fn new(initial_peers: Vec<String>, self_url: Option<String>) -> Self {
        let peers: HashSet<String> = initial_peers.into_iter().collect();
        Self {
            peers: Arc::new(RwLock::new(peers)),
            health: Arc::new(RwLock::new(HashMap::new())),
            self_url,
        }
    }

    pub async fn get_peers(&self) -> Vec<String> {
        self.peers.read().await.iter().cloned().collect()
    }

    /// Get only peers that aren't in cooldown
    pub async fn get_active_peers(&self) -> Vec<String> {
        let peers = self.peers.read().await;
        let health = self.health.read().await;
        let now = Instant::now();
        peers
            .iter()
            .filter(|p| {
                health
                    .get(*p)
                    .map(|h| now >= h.next_retry)
                    .unwrap_or(true)
            })
            .cloned()
            .collect()
    }

    /// Record a successful sync for a peer (resets backoff)
    pub async fn record_success(&self, peer_url: &str) {
        let mut health = self.health.write().await;
        health.remove(peer_url);
    }

    /// Record a failed sync for a peer (increases backoff).
    /// Returns true if this is the first failure (should log), false if suppressed.
    pub async fn record_failure(&self, peer_url: &str) -> bool {
        let mut health = self.health.write().await;
        let entry = health.entry(peer_url.to_string()).or_insert(PeerHealth {
            consecutive_failures: 0,
            next_retry: Instant::now(),
        });
        entry.consecutive_failures += 1;
        let backoff = std::cmp::min(
            5 * 2u64.pow(entry.consecutive_failures.min(5)),
            120, // max 2 minutes (was 10 minutes)
        );
        entry.next_retry = Instant::now() + Duration::from_secs(backoff);
        entry.consecutive_failures == 1
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
    
    /// Check if an IP address belongs to a known peer
    pub async fn is_known_peer_ip(&self, client_ip: &str) -> bool {
        let peers = self.peers.read().await;
        for peer_url in peers.iter() {
            if let Some(host) = extract_host_from_url(peer_url) {
                if host == client_ip {
                    return true;
                }
            }
        }
        false
    }
}

/// Extract hostname or IP from a URL (e.g., "https://example.com:5100" -> "example.com")
fn extract_host_from_url(url: &str) -> Option<String> {
    // Remove protocol
    let without_protocol = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    
    // Remove path
    let without_path = without_protocol.split('/').next()?;
    
    // Remove port
    let host = without_path.split(':').next()?;
    
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
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
    
    // Check if we need to reset from genesis (peer has longer chain and our genesis differs or we have no genesis)
    if allow_genesis_reset && peer_height > local_height {
        if let Some(peer_genesis) = peer_blocks.first() {
            if peer_genesis.header.height == 0 {
                let our_genesis = node.get_block(0)?;
                let should_reset = match our_genesis {
                    None => true, // Fresh node with no genesis - accept peer chain
                    Some(our_gen) => our_gen.hash != peer_genesis.hash,
                };
                if should_reset {
                    eprintln!("[peer] Syncing chain from peer genesis");
                    node.reset_chain(&peer_blocks)?;
                    return Ok(peer_blocks.len() as u64);
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
    let mut backoff_secs = 3u64;
    const MIN_SYNC_INTERVAL: u64 = 3;
    const MAX_SYNC_INTERVAL: u64 = 15;
    
    // Continuous sync loop
    loop {
        sleep(Duration::from_secs(backoff_secs)).await;
        
        let peers = peer_manager.get_active_peers().await;
        let mut had_rate_limit = false;
        
        // Allow genesis reset if we're still at height 0 (fresh node that hasn't synced yet)
        let local_height = node.get_tip_height().unwrap_or(0);
        let needs_genesis_reset = local_height == 0;

        for peer in &peers {
            match sync_from_peer(peer, &node, needs_genesis_reset).await {
                Ok(count) if count > 0 => {
                    eprintln!("[peer] Synced {} new blocks from {}", count, peer);
                    peer_manager.record_success(peer).await;
                    backoff_secs = MIN_SYNC_INTERVAL;
                }
                Ok(_) => {
                    peer_manager.record_success(peer).await;
                    backoff_secs = std::cmp::min(backoff_secs + 2, MAX_SYNC_INTERVAL);
                }
                Err(e) => {
                    if e.contains("429") || e.contains("Too Many Requests") {
                        had_rate_limit = true;
                    } else {
                        let should_log = peer_manager.record_failure(peer).await;
                        if should_log {
                            eprintln!("[peer] Sync error from {} (suppressing repeats): {}", peer, e);
                        }
                    }
                }
            }
        }
        
        if had_rate_limit {
            backoff_secs = std::cmp::min(backoff_secs * 2, MAX_SYNC_INTERVAL);
            eprintln!("[peer] Rate limited, backing off to {}s", backoff_secs);
        }
        
        // Peer discovery every ~60 seconds (use all peers, not just active)
        discovery_counter += 1;
        let discovery_threshold = (60 / backoff_secs).max(1) as u32;
        if discovery_counter >= discovery_threshold {
            discovery_counter = 0;
            
            let all_peers = peer_manager.get_peers().await;
            for peer in &all_peers {
                match discover_peers(peer).await {
                    Ok(new_peers) => {
                        for new_peer in new_peers {
                            if peer_manager.add_peer(new_peer.clone()).await {
                                eprintln!("[peer] Discovered new peer: {}", new_peer);
                            }
                        }
                    }
                    Err(_) => {}
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
