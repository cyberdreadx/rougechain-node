//! Pool Events Store - Tracks AMM transaction history

use serde::{Deserialize, Serialize};
use sled::Db;
use std::path::Path;
use std::sync::Arc;

/// Types of pool events
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum PoolEventType {
    CreatePool,
    AddLiquidity,
    RemoveLiquidity,
    Swap,
}

/// A pool event with all relevant data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolEvent {
    pub id: String,
    pub pool_id: String,
    pub event_type: PoolEventType,
    pub user_pub_key: String,
    pub timestamp: u64,
    pub block_height: u64,
    pub tx_hash: String,
    
    // For swaps
    pub token_in: Option<String>,
    pub token_out: Option<String>,
    pub amount_in: Option<u64>,
    pub amount_out: Option<u64>,
    
    // For add/remove liquidity
    pub amount_a: Option<u64>,
    pub amount_b: Option<u64>,
    pub lp_amount: Option<u64>,
    
    // Reserve snapshot after the event
    pub reserve_a_after: u64,
    pub reserve_b_after: u64,
}

/// Price snapshot for charting
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriceSnapshot {
    pub pool_id: String,
    pub timestamp: u64,
    pub block_height: u64,
    pub reserve_a: u64,
    pub reserve_b: u64,
    pub price_a_in_b: f64,  // How many token B for 1 token A
    pub price_b_in_a: f64,  // How many token A for 1 token B
}

/// Persistent storage for pool events
#[derive(Clone)]
pub struct PoolEventStore {
    events_db: Arc<Db>,
    prices_db: Arc<Db>,
}

impl PoolEventStore {
    /// Create a new pool event store
    pub fn new(data_dir: &Path) -> Result<Self, String> {
        let events_path = data_dir.join("pool-events-db");
        let prices_path = data_dir.join("pool-prices-db");
        
        let events_db = sled::open(events_path)
            .map_err(|e| format!("Failed to open events DB: {}", e))?;
        let prices_db = sled::open(prices_path)
            .map_err(|e| format!("Failed to open prices DB: {}", e))?;
        
        Ok(Self {
            events_db: Arc::new(events_db),
            prices_db: Arc::new(prices_db),
        })
    }
    
    /// Save a pool event
    pub fn save_event(&self, event: &PoolEvent) -> Result<(), String> {
        // Key format: pool_id:timestamp:event_id for ordering
        let key = format!("{}:{}:{}", event.pool_id, event.timestamp, event.id);
        let value = serde_json::to_vec(event)
            .map_err(|e| format!("Failed to serialize event: {}", e))?;
        self.events_db.insert(key.as_bytes(), value)
            .map_err(|e| format!("Failed to save event: {}", e))?;
        self.events_db.flush()
            .map_err(|e| format!("Failed to flush: {}", e))?;
        Ok(())
    }
    
    /// Get events for a pool
    pub fn get_pool_events(&self, pool_id: &str, limit: usize) -> Result<Vec<PoolEvent>, String> {
        let prefix = format!("{}:", pool_id);
        let mut events = Vec::new();
        
        // Iterate in reverse to get most recent first
        for item in self.events_db.scan_prefix(prefix.as_bytes()).rev() {
            if events.len() >= limit {
                break;
            }
            match item {
                Ok((_, value)) => {
                    if let Ok(event) = serde_json::from_slice::<PoolEvent>(&value) {
                        events.push(event);
                    }
                }
                Err(e) => return Err(format!("Failed to iterate events: {}", e)),
            }
        }
        
        Ok(events)
    }
    
    /// Get all events (for all pools)
    pub fn get_all_events(&self, limit: usize) -> Result<Vec<PoolEvent>, String> {
        let mut events = Vec::new();
        
        for item in self.events_db.iter().rev() {
            if events.len() >= limit {
                break;
            }
            match item {
                Ok((_, value)) => {
                    if let Ok(event) = serde_json::from_slice::<PoolEvent>(&value) {
                        events.push(event);
                    }
                }
                Err(e) => return Err(format!("Failed to iterate events: {}", e)),
            }
        }
        
        Ok(events)
    }
    
    /// Save a price snapshot
    pub fn save_price_snapshot(&self, snapshot: &PriceSnapshot) -> Result<(), String> {
        // Key format: pool_id:timestamp for ordering
        let key = format!("{}:{:016}", snapshot.pool_id, snapshot.timestamp);
        let value = serde_json::to_vec(snapshot)
            .map_err(|e| format!("Failed to serialize snapshot: {}", e))?;
        self.prices_db.insert(key.as_bytes(), value)
            .map_err(|e| format!("Failed to save snapshot: {}", e))?;
        self.prices_db.flush()
            .map_err(|e| format!("Failed to flush: {}", e))?;
        Ok(())
    }
    
    /// Get price history for a pool
    pub fn get_price_history(&self, pool_id: &str, limit: usize) -> Result<Vec<PriceSnapshot>, String> {
        let prefix = format!("{}:", pool_id);
        let mut snapshots = Vec::new();
        
        for item in self.prices_db.scan_prefix(prefix.as_bytes()).rev() {
            if snapshots.len() >= limit {
                break;
            }
            match item {
                Ok((_, value)) => {
                    if let Ok(snapshot) = serde_json::from_slice::<PriceSnapshot>(&value) {
                        snapshots.push(snapshot);
                    }
                }
                Err(e) => return Err(format!("Failed to iterate snapshots: {}", e)),
            }
        }
        
        // Reverse to get chronological order for charts
        snapshots.reverse();
        Ok(snapshots)
    }
    
    /// Get pool statistics
    pub fn get_pool_stats(&self, pool_id: &str) -> Result<PoolStats, String> {
        let events = self.get_pool_events(pool_id, 1000)?;
        
        let mut total_swaps = 0u64;
        let mut total_volume_a = 0u64;
        let mut total_volume_b = 0u64;
        let mut swap_count_24h = 0u64;
        let mut volume_24h_a = 0u64;
        let mut volume_24h_b = 0u64;
        
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let day_ago = now.saturating_sub(86400);
        
        for event in events {
            if event.event_type == PoolEventType::Swap {
                total_swaps += 1;
                total_volume_a += event.amount_in.unwrap_or(0);
                total_volume_b += event.amount_out.unwrap_or(0);
                
                if event.timestamp >= day_ago {
                    swap_count_24h += 1;
                    volume_24h_a += event.amount_in.unwrap_or(0);
                    volume_24h_b += event.amount_out.unwrap_or(0);
                }
            }
        }
        
        Ok(PoolStats {
            pool_id: pool_id.to_string(),
            total_swaps,
            total_volume_a,
            total_volume_b,
            swap_count_24h,
            volume_24h_a,
            volume_24h_b,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolStats {
    pub pool_id: String,
    pub total_swaps: u64,
    pub total_volume_a: u64,
    pub total_volume_b: u64,
    pub swap_count_24h: u64,
    pub volume_24h_a: u64,
    pub volume_24h_b: u64,
}
