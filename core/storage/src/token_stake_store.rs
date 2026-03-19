// ============================================================================
// token_stake_store — Custom token staking pools
//
// Token creators can create staking pools for their tokens.
// Users stake tokens and earn rewards proportional to their stake.
// ============================================================================

use serde::{Deserialize, Serialize};
use sled::Db;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StakingPool {
    pub pool_id: String,              // "{token_symbol}:{creator_pub_key_short}"
    pub token_symbol: String,
    pub creator: String,              // Token creator pub key
    pub reward_rate_bps: u64,         // Annual reward rate in basis points (100 = 1%)
    pub total_staked: u64,
    pub created_at_height: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenStake {
    pub staker: String,               // Staker pub key
    pub pool_id: String,
    pub amount: u64,
    pub staked_at_height: u64,
    pub last_claim_height: u64,       // Last height rewards were claimed
}

#[derive(Clone)]
pub struct TokenStakeStore {
    pools_db: Db,
    stakes_db: Db,
}

impl TokenStakeStore {
    pub fn new(data_dir: impl AsRef<std::path::Path>) -> Result<Self, String> {
        let pools_path = data_dir.as_ref().join("token-staking-pools-db");
        let stakes_path = data_dir.as_ref().join("token-stakes-db");
        let pools_db = sled::open(&pools_path).map_err(|e| format!("Open staking pools: {}", e))?;
        let stakes_db = sled::open(&stakes_path).map_err(|e| format!("Open stakes: {}", e))?;
        Ok(Self { pools_db, stakes_db })
    }

    // Pool methods
    pub fn create_pool(&self, pool: &StakingPool) -> Result<(), String> {
        let value = serde_json::to_vec(pool).map_err(|e| format!("Serialize pool: {}", e))?;
        self.pools_db.insert(pool.pool_id.as_bytes(), value)
            .map_err(|e| format!("Insert pool: {}", e))?;
        self.pools_db.flush().map_err(|e| format!("Flush: {}", e))?;
        Ok(())
    }

    pub fn get_pool(&self, pool_id: &str) -> Result<Option<StakingPool>, String> {
        match self.pools_db.get(pool_id.as_bytes()).map_err(|e| format!("Get pool: {}", e))? {
            Some(bytes) => Ok(Some(serde_json::from_slice(&bytes).map_err(|e| format!("Deser pool: {}", e))?)),
            None => Ok(None),
        }
    }

    pub fn save_pool(&self, pool: &StakingPool) -> Result<(), String> {
        self.create_pool(pool)
    }

    pub fn list_pools(&self) -> Result<Vec<StakingPool>, String> {
        let mut pools = Vec::new();
        for entry in self.pools_db.iter() {
            let (_, val) = entry.map_err(|e| format!("Iter pool: {}", e))?;
            if let Ok(pool) = serde_json::from_slice::<StakingPool>(&val) {
                pools.push(pool);
            }
        }
        Ok(pools)
    }

    // Stake methods
    fn stake_key(staker: &str, pool_id: &str) -> String {
        format!("{}:{}", staker, pool_id)
    }

    pub fn create_stake(&self, stake: &TokenStake) -> Result<(), String> {
        let key = Self::stake_key(&stake.staker, &stake.pool_id);
        let value = serde_json::to_vec(stake).map_err(|e| format!("Serialize stake: {}", e))?;
        self.stakes_db.insert(key.as_bytes(), value)
            .map_err(|e| format!("Insert stake: {}", e))?;
        self.stakes_db.flush().map_err(|e| format!("Flush: {}", e))?;
        Ok(())
    }

    pub fn get_stake(&self, staker: &str, pool_id: &str) -> Result<Option<TokenStake>, String> {
        let key = Self::stake_key(staker, pool_id);
        match self.stakes_db.get(key.as_bytes()).map_err(|e| format!("Get stake: {}", e))? {
            Some(bytes) => Ok(Some(serde_json::from_slice(&bytes).map_err(|e| format!("Deser stake: {}", e))?)),
            None => Ok(None),
        }
    }

    pub fn delete_stake(&self, staker: &str, pool_id: &str) -> Result<(), String> {
        let key = Self::stake_key(staker, pool_id);
        self.stakes_db.remove(key.as_bytes())
            .map_err(|e| format!("Delete stake: {}", e))?;
        self.stakes_db.flush().map_err(|e| format!("Flush: {}", e))?;
        Ok(())
    }

    pub fn get_stakes_by_owner(&self, staker: &str) -> Result<Vec<TokenStake>, String> {
        let prefix = format!("{}:", staker);
        let mut stakes = Vec::new();
        for entry in self.stakes_db.scan_prefix(prefix.as_bytes()) {
            let (_, val) = entry.map_err(|e| format!("Scan stake: {}", e))?;
            if let Ok(stake) = serde_json::from_slice::<TokenStake>(&val) {
                stakes.push(stake);
            }
        }
        Ok(stakes)
    }

    pub fn get_stakes_by_pool(&self, pool_id: &str) -> Result<Vec<TokenStake>, String> {
        let mut stakes = Vec::new();
        for entry in self.stakes_db.iter() {
            let (_, val) = entry.map_err(|e| format!("Iter stake: {}", e))?;
            if let Ok(stake) = serde_json::from_slice::<TokenStake>(&val) {
                if stake.pool_id == pool_id {
                    stakes.push(stake);
                }
            }
        }
        Ok(stakes)
    }
}
