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

/// Start the peer sync background task
pub async fn start_peer_sync(peers: Vec<String>, node: Arc<L1Node>) {
    if peers.is_empty() {
        eprintln!("[peer] No peers configured, skipping sync");
        return;
    }
    
    eprintln!("[peer] Starting peer sync with {} peers", peers.len());
    
    // Initial sync - try each peer until one succeeds (allow genesis reset on first sync)
    for peer in &peers {
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
    
    // Continuous sync loop - check peers every 5 seconds (no genesis reset after initial sync)
    loop {
        sleep(Duration::from_secs(5)).await;
        
        for peer in &peers {
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
