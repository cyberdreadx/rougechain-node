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

/// A liquidity provider's position, for fee accounting (off-consensus, derived from events).
///
/// `basis` is the deposit measured in share-value units, where a share's value is
/// √(reserve_a · reserve_b) / total_lp_supply. Swap fees raise that value; adding or removing
/// liquidity doesn't. So `lp × value_now − basis` is the fee income still in the pool.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
pub struct LpPosition {
    pub lp: u64,
    pub basis: f64,
}

impl LpPosition {
    /// Apply a mint or burn of `lp` tokens at share value `value`. Withdrawals come out of
    /// earnings first, then the deposit, so collecting fees leaves the deposit's basis intact.
    pub fn apply(&mut self, minted: bool, lp: u64, value: f64) {
        if minted {
            self.lp = self.lp.saturating_add(lp);
            self.basis += lp as f64 * value;
        } else {
            let earned = (self.lp as f64 * value - self.basis).max(0.0);
            self.basis = (self.basis - (lp as f64 * value - earned).max(0.0)).max(0.0);
            self.lp = self.lp.saturating_sub(lp);
        }
        if self.lp == 0 || !self.basis.is_finite() {
            self.basis = 0.0;
        }
    }
}

/// √(reserve_a · reserve_b) per LP token; None for an empty pool.
pub fn lp_share_value(reserve_a: u64, reserve_b: u64, total_lp_supply: u64) -> Option<f64> {
    if total_lp_supply == 0 {
        return None;
    }
    Some(((reserve_a as f64) * (reserve_b as f64)).sqrt() / total_lp_supply as f64)
}

const LP_POSITIONS_MARKER: &[u8] = b"__lp_positions_v1__";

/// Persistent storage for pool events
#[derive(Clone)]
pub struct PoolEventStore {
    events_db: Arc<Db>,
    prices_db: Arc<Db>,
    positions: sled::Tree,
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
        
        let positions = events_db.open_tree("lp-positions")
            .map_err(|e| format!("Failed to open LP positions: {}", e))?;

        Ok(Self {
            events_db: Arc::new(events_db),
            prices_db: Arc::new(prices_db),
            positions,
        })
    }

    /// Every sled tree this store writes to (rollback snapshot/restore).
    pub fn trees(&self) -> Vec<&sled::Tree> {
        vec![&**self.events_db, &**self.prices_db, &self.positions]
    }

    #[cfg(test)]
    pub fn clear_lp_positions_for_test(&self) {
        self.positions.clear().unwrap();
    }

    fn position_key(pool_id: &str, owner: &str) -> Vec<u8> {
        format!("{}\0{}", pool_id, owner).into_bytes()
    }

    pub fn get_lp_position(&self, pool_id: &str, owner: &str) -> Result<Option<LpPosition>, String> {
        match self.positions.get(Self::position_key(pool_id, owner)).map_err(|e| e.to_string())? {
            Some(v) => serde_json::from_slice(&v).map(Some).map_err(|e| e.to_string()),
            None => Ok(None),
        }
    }

    /// Record an LP mint/burn for `owner` (canonical address). `value` is the share value from
    /// `lp_share_value`, taken after the change (or before it, if the change emptied the pool).
    pub fn record_lp_change(&self, pool_id: &str, owner: &str, minted: bool, lp: u64, value: f64) -> Result<(), String> {
        let key = Self::position_key(pool_id, owner);
        let mut pos: LpPosition = match self.positions.get(&key).map_err(|e| e.to_string())? {
            Some(v) => serde_json::from_slice(&v).unwrap_or_default(),
            None => LpPosition::default(),
        };
        pos.apply(minted, lp, value);
        let bytes = serde_json::to_vec(&pos).map_err(|e| e.to_string())?;
        self.positions.insert(key, bytes).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Build LP positions from the full event history once (nodes that ran before the ledger
    /// existed). LP supply isn't in old events, so it's re-derived: only create/add/remove
    /// change it, and each of those is recorded as an event.
    pub fn rebuild_lp_positions_if_needed(&self, canon: impl Fn(&str) -> String) -> Result<usize, String> {
        if self.positions.contains_key(LP_POSITIONS_MARKER).map_err(|e| e.to_string())? {
            return Ok(0);
        }
        self.positions.clear().map_err(|e| e.to_string())?;
        let mut events: Vec<PoolEvent> = self.events_db.iter()
            .filter_map(|r| r.ok())
            .filter_map(|(_, v)| serde_json::from_slice::<PoolEvent>(&v).ok())
            .filter(|e| e.event_type != PoolEventType::Swap)
            .collect();
        events.sort_by(|x, y| x.pool_id.cmp(&y.pool_id)
            .then(x.block_height.cmp(&y.block_height))
            .then(x.timestamp.cmp(&y.timestamp))
            .then(x.id.cmp(&y.id)));
        let mut supply: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        let mut n = 0;
        for e in &events {
            let lp = e.lp_amount.unwrap_or(0);
            if lp == 0 { continue; }
            let s = supply.entry(e.pool_id.clone()).or_insert(0);
            let before = *s;
            let minted = e.event_type != PoolEventType::RemoveLiquidity;
            *s = match e.event_type {
                PoolEventType::CreatePool => lp,
                PoolEventType::AddLiquidity => before.saturating_add(lp),
                _ => before.saturating_sub(lp),
            };
            let value = lp_share_value(e.reserve_a_after, e.reserve_b_after, *s)
                .or_else(|| {
                    // Pool emptied: value just before the burn.
                    let a = e.reserve_a_after + e.amount_a.unwrap_or(0);
                    let b = e.reserve_b_after + e.amount_b.unwrap_or(0);
                    lp_share_value(a, b, before)
                })
                .unwrap_or(0.0);
            self.record_lp_change(&e.pool_id, &canon(&e.user_pub_key), minted, lp, value)?;
            n += 1;
        }
        self.positions.insert(LP_POSITIONS_MARKER, b"1".to_vec()).map_err(|e| e.to_string())?;
        self.positions.flush().map_err(|e| e.to_string())?;
        Ok(n)
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
