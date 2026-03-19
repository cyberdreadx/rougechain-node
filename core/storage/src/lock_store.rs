// ============================================================================
// lock_store — Token lock entries (time-locked balances)
//
// Each lock tracks tokens locked until a specific block height.
// Locks are created via `token_lock` tx and removed via `token_unlock` tx.
// ============================================================================

use serde::{Deserialize, Serialize};
use sled::Db;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenLock {
    pub lock_id: String,
    pub owner: String,
    pub token_symbol: String,       // "XRGE" or custom token symbol
    pub amount: u64,
    pub lock_until_height: u64,     // Block height when unlock becomes possible
    pub created_at_height: u64,
}

#[derive(Clone)]
pub struct LockStore {
    db: Db,
}

impl LockStore {
    pub fn new(data_dir: impl AsRef<std::path::Path>) -> Result<Self, String> {
        let path = data_dir.as_ref().join("token-locks-db");
        let db = sled::open(&path).map_err(|e| format!("Failed to open lock store: {}", e))?;
        Ok(Self { db })
    }

    pub fn create_lock(&self, lock: &TokenLock) -> Result<(), String> {
        let value = serde_json::to_vec(lock).map_err(|e| format!("Serialize lock: {}", e))?;
        self.db.insert(lock.lock_id.as_bytes(), value)
            .map_err(|e| format!("Insert lock: {}", e))?;
        self.db.flush().map_err(|e| format!("Flush: {}", e))?;
        Ok(())
    }

    pub fn get_lock(&self, lock_id: &str) -> Result<Option<TokenLock>, String> {
        match self.db.get(lock_id.as_bytes()).map_err(|e| format!("Get lock: {}", e))? {
            Some(bytes) => {
                let lock: TokenLock = serde_json::from_slice(&bytes)
                    .map_err(|e| format!("Deserialize lock: {}", e))?;
                Ok(Some(lock))
            }
            None => Ok(None),
        }
    }

    pub fn get_locks_by_owner(&self, owner: &str) -> Result<Vec<TokenLock>, String> {
        let mut locks = Vec::new();
        for entry in self.db.iter() {
            let (_, val) = entry.map_err(|e| format!("Iter lock: {}", e))?;
            if let Ok(lock) = serde_json::from_slice::<TokenLock>(&val) {
                if lock.owner == owner {
                    locks.push(lock);
                }
            }
        }
        Ok(locks)
    }

    pub fn delete_lock(&self, lock_id: &str) -> Result<(), String> {
        self.db.remove(lock_id.as_bytes())
            .map_err(|e| format!("Delete lock: {}", e))?;
        self.db.flush().map_err(|e| format!("Flush: {}", e))?;
        Ok(())
    }
}
