//! Pool Store - Sled persistence for AMM liquidity pools

use serde::{Deserialize, Serialize};
use sled::Db;
use std::path::Path;
use std::sync::Arc;

/// Represents a liquidity pool with two tokens
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiquidityPool {
    /// Pool identifier: sorted "TOKENA-TOKENB" format
    pub pool_id: String,
    /// First token symbol (alphabetically first)
    pub token_a: String,
    /// Second token symbol (alphabetically second)
    pub token_b: String,
    /// Reserve of token A
    pub reserve_a: u64,
    /// Reserve of token B
    pub reserve_b: u64,
    /// Total LP token supply
    pub total_lp_supply: u64,
    /// Fee rate (0.003 = 0.3%)
    pub fee_rate: f64,
    /// Creation timestamp
    pub created_at: u64,
    /// Creator's public key
    pub creator_pub_key: String,
}

impl LiquidityPool {
    /// Create a new pool with initial liquidity
    pub fn new(
        token_a: String,
        token_b: String,
        reserve_a: u64,
        reserve_b: u64,
        creator_pub_key: String,
        created_at: u64,
    ) -> Self {
        // Sort tokens alphabetically to create consistent pool_id
        let (token_a, token_b, reserve_a, reserve_b) = if token_a < token_b {
            (token_a, token_b, reserve_a, reserve_b)
        } else {
            (token_b, token_a, reserve_b, reserve_a)
        };
        
        let pool_id = format!("{}-{}", token_a, token_b);
        
        // Initial LP tokens = sqrt(reserve_a * reserve_b) - MINIMUM_LIQUIDITY
        let initial_lp = ((reserve_a as f64 * reserve_b as f64).sqrt() as u64).saturating_sub(1000);
        
        Self {
            pool_id,
            token_a,
            token_b,
            reserve_a,
            reserve_b,
            total_lp_supply: initial_lp,
            fee_rate: 0.003, // 0.3%
            created_at,
            creator_pub_key,
        }
    }
    
    /// Generate pool ID from two token symbols (sorted)
    pub fn make_pool_id(token_a: &str, token_b: &str) -> String {
        if token_a < token_b {
            format!("{}-{}", token_a, token_b)
        } else {
            format!("{}-{}", token_b, token_a)
        }
    }
    
    /// Check if this pool contains a specific token
    pub fn contains_token(&self, symbol: &str) -> bool {
        self.token_a == symbol || self.token_b == symbol
    }
    
    /// Get the other token in the pair
    pub fn get_other_token(&self, symbol: &str) -> Option<&str> {
        if self.token_a == symbol {
            Some(&self.token_b)
        } else if self.token_b == symbol {
            Some(&self.token_a)
        } else {
            None
        }
    }
    
    /// Get reserves for a specific token direction
    pub fn get_reserves(&self, token_in: &str) -> Option<(u64, u64)> {
        if self.token_a == token_in {
            Some((self.reserve_a, self.reserve_b))
        } else if self.token_b == token_in {
            Some((self.reserve_b, self.reserve_a))
        } else {
            None
        }
    }
}

/// Persistent storage for liquidity pools using sled
#[derive(Clone)]
pub struct PoolStore {
    db: Arc<Db>,
}

impl PoolStore {
    /// Create a new pool store at the given path
    pub fn new(data_dir: &Path) -> Result<Self, String> {
        let db_path = data_dir.join("pools-db");
        let db = sled::open(db_path).map_err(|e| format!("Failed to open pool DB: {}", e))?;
        Ok(Self {
            db: Arc::new(db),
        })
    }
    
    /// Save a pool to the store
    pub fn save_pool(&self, pool: &LiquidityPool) -> Result<(), String> {
        let key = pool.pool_id.as_bytes();
        let value = serde_json::to_vec(pool).map_err(|e| format!("Failed to serialize pool: {}", e))?;
        self.db.insert(key, value).map_err(|e| format!("Failed to save pool: {}", e))?;
        self.db.flush().map_err(|e| format!("Failed to flush: {}", e))?;
        Ok(())
    }
    
    /// Get a pool by ID
    pub fn get_pool(&self, pool_id: &str) -> Result<Option<LiquidityPool>, String> {
        match self.db.get(pool_id.as_bytes()) {
            Ok(Some(value)) => {
                let pool: LiquidityPool = serde_json::from_slice(&value)
                    .map_err(|e| format!("Failed to deserialize pool: {}", e))?;
                Ok(Some(pool))
            }
            Ok(None) => Ok(None),
            Err(e) => Err(format!("Failed to get pool: {}", e)),
        }
    }
    
    /// Get a pool by token pair (in any order)
    pub fn get_pool_by_tokens(&self, token_a: &str, token_b: &str) -> Result<Option<LiquidityPool>, String> {
        let pool_id = LiquidityPool::make_pool_id(token_a, token_b);
        self.get_pool(&pool_id)
    }
    
    /// List all pools
    pub fn list_pools(&self) -> Result<Vec<LiquidityPool>, String> {
        let mut pools = Vec::new();
        for item in self.db.iter() {
            match item {
                Ok((_, value)) => {
                    if let Ok(pool) = serde_json::from_slice::<LiquidityPool>(&value) {
                        pools.push(pool);
                    }
                }
                Err(e) => return Err(format!("Failed to iterate pools: {}", e)),
            }
        }
        Ok(pools)
    }
    
    /// Delete a pool
    pub fn delete_pool(&self, pool_id: &str) -> Result<(), String> {
        self.db.remove(pool_id.as_bytes()).map_err(|e| format!("Failed to delete pool: {}", e))?;
        self.db.flush().map_err(|e| format!("Failed to flush: {}", e))?;
        Ok(())
    }
    
    /// Check if a pool exists
    pub fn pool_exists(&self, pool_id: &str) -> Result<bool, String> {
        match self.db.get(pool_id.as_bytes()) {
            Ok(Some(_)) => Ok(true),
            Ok(None) => Ok(false),
            Err(e) => Err(format!("Failed to check pool: {}", e)),
        }
    }
    
    /// Find pools containing a specific token
    pub fn find_pools_with_token(&self, token_symbol: &str) -> Result<Vec<LiquidityPool>, String> {
        let all_pools = self.list_pools()?;
        Ok(all_pools.into_iter().filter(|p| p.contains_token(token_symbol)).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_pool_creation() {
        let pool = LiquidityPool::new(
            "XRGE".to_string(),
            "QSHIB".to_string(),
            1000000,
            500000,
            "creator123".to_string(),
            1234567890,
        );
        
        assert_eq!(pool.pool_id, "QSHIB-XRGE"); // Sorted alphabetically
        assert_eq!(pool.token_a, "QSHIB");
        assert_eq!(pool.token_b, "XRGE");
    }
    
    #[test]
    fn test_pool_id_generation() {
        assert_eq!(LiquidityPool::make_pool_id("XRGE", "QSHIB"), "QSHIB-XRGE");
        assert_eq!(LiquidityPool::make_pool_id("QSHIB", "XRGE"), "QSHIB-XRGE");
        assert_eq!(LiquidityPool::make_pool_id("AAA", "ZZZ"), "AAA-ZZZ");
    }
}
