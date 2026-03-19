// ============================================================================
// allowance_store — ERC-20 style token allowances (approve/transferFrom)
//
// Allows token holders to approve a spender to transfer tokens on their behalf.
// ============================================================================

use serde::{Deserialize, Serialize};
use sled::Db;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Allowance {
    pub owner: String,                // Token owner pub key
    pub spender: String,              // Approved spender pub key
    pub token_symbol: String,
    pub amount: u64,                  // Remaining approved amount
}

#[derive(Clone)]
pub struct AllowanceStore {
    db: Db,
}

impl AllowanceStore {
    pub fn new(data_dir: impl AsRef<std::path::Path>) -> Result<Self, String> {
        let path = data_dir.as_ref().join("token-allowances-db");
        let db = sled::open(&path).map_err(|e| format!("Open allowance store: {}", e))?;
        Ok(Self { db })
    }

    fn key(owner: &str, spender: &str, token: &str) -> String {
        format!("{}:{}:{}", owner, spender, token)
    }

    pub fn set_allowance(&self, allowance: &Allowance) -> Result<(), String> {
        let key = Self::key(&allowance.owner, &allowance.spender, &allowance.token_symbol);
        if allowance.amount == 0 {
            self.db.remove(key.as_bytes()).map_err(|e| format!("Remove allowance: {}", e))?;
        } else {
            let value = serde_json::to_vec(allowance).map_err(|e| format!("Serialize: {}", e))?;
            self.db.insert(key.as_bytes(), value).map_err(|e| format!("Insert: {}", e))?;
        }
        self.db.flush().map_err(|e| format!("Flush: {}", e))?;
        Ok(())
    }

    pub fn get_allowance(&self, owner: &str, spender: &str, token: &str) -> Result<Option<Allowance>, String> {
        let key = Self::key(owner, spender, token);
        match self.db.get(key.as_bytes()).map_err(|e| format!("Get: {}", e))? {
            Some(bytes) => Ok(Some(serde_json::from_slice(&bytes).map_err(|e| format!("Deser: {}", e))?)),
            None => Ok(None),
        }
    }

    pub fn get_allowances_by_owner(&self, owner: &str) -> Result<Vec<Allowance>, String> {
        let prefix = format!("{}:", owner);
        let mut allowances = Vec::new();
        for entry in self.db.scan_prefix(prefix.as_bytes()) {
            let (_, val) = entry.map_err(|e| format!("Scan: {}", e))?;
            if let Ok(a) = serde_json::from_slice::<Allowance>(&val) {
                allowances.push(a);
            }
        }
        Ok(allowances)
    }

    pub fn get_allowances_for_spender(&self, spender: &str) -> Result<Vec<Allowance>, String> {
        let mut allowances = Vec::new();
        for entry in self.db.iter() {
            let (_, val) = entry.map_err(|e| format!("Iter: {}", e))?;
            if let Ok(a) = serde_json::from_slice::<Allowance>(&val) {
                if a.spender == spender {
                    allowances.push(a);
                }
            }
        }
        Ok(allowances)
    }
}
