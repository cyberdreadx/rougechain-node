use std::sync::Arc;
use std::time::Duration;
use tokio::time::sleep;

use crate::node::L1Node;
use quantum_vault_types::BlockV1;

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

/// Sync blocks from a peer
async fn sync_from_peer(peer_url: &str, node: &L1Node) -> Result<u64, String> {
    let local_height = node.get_tip_height()?;
    
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
    
    let mut synced_count = 0u64;
    
    for block_json in blocks {
        let block: BlockV1 = serde_json::from_value(block_json.clone())
            .map_err(|e| format!("Failed to parse block: {}", e))?;
        
        // Skip blocks we already have
        if block.header.height <= local_height {
            continue;
        }
        
        // Import the block
        if let Err(e) = node.import_block(block.clone()) {
            eprintln!("[peer] Failed to import block {}: {}", block.header.height, e);
            continue;
        }
        
        synced_count += 1;
    }
    
    Ok(synced_count)
}

/// Start the peer sync background task
pub async fn start_peer_sync(peers: Vec<String>, node: Arc<L1Node>) {
    if peers.is_empty() {
        eprintln!("[peer] No peers configured, skipping sync");
        return;
    }
    
    eprintln!("[peer] Starting peer sync with {} peers", peers.len());
    
    // Initial sync - try each peer until one succeeds
    for peer in &peers {
        eprintln!("[peer] Attempting initial sync from {}", peer);
        match sync_from_peer(peer, &node).await {
            Ok(count) => {
                eprintln!("[peer] Synced {} blocks from {}", count, peer);
                break;
            }
            Err(e) => {
                eprintln!("[peer] Failed to sync from {}: {}", peer, e);
            }
        }
    }
    
    // Continuous sync loop - check peers every 5 seconds
    loop {
        sleep(Duration::from_secs(5)).await;
        
        for peer in &peers {
            match sync_from_peer(peer, &node).await {
                Ok(count) if count > 0 => {
                    eprintln!("[peer] Synced {} new blocks from {}", count, peer);
                }
                Ok(_) => {} // No new blocks
                Err(e) => {
                    eprintln!("[peer] Sync error from {}: {}", peer, e);
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
