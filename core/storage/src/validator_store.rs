use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidatorState {
    pub stake: u128,
    pub slash_count: u32,
    pub jailed_until: u64,
    pub entropy_contributions: u64,
    #[serde(default)]
    pub blocks_proposed: u64,
    /// Blocks where this validator was expected to propose but didn't
    #[serde(default)]
    pub missed_blocks: u64,
    /// Total amount slashed (XRGE units × 10^18)
    #[serde(default)]
    pub total_slashed: u128,
}

/// Entry in the unbonding queue — represents a pending unstake
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnbondingEntry {
    pub validator_pub_key: String,
    pub amount: u128,
    /// Block height when unbonding was initiated
    pub initiated_at: u64,
    /// Block height when funds can be withdrawn
    pub completes_at: u64,
}

/// Unbonding period in blocks (~100 blocks ≈ 10 minutes at 6s/block)
pub const UNBONDING_PERIOD: u64 = 100;

#[derive(Clone)]
pub struct ValidatorStore {
    db: sled::Db,
    meta: sled::Tree,
    unbonding: sled::Tree,
}

impl ValidatorStore {
    pub fn new(data_dir: impl AsRef<Path>) -> Result<Self, String> {
        let path = data_dir.as_ref().join("validators-db");
        let db = sled::open(path).map_err(|e| e.to_string())?;
        let meta = db.open_tree("meta").map_err(|e| e.to_string())?;
        let unbonding = db.open_tree("unbonding").map_err(|e| e.to_string())?;
        Ok(Self { db, meta, unbonding })
    }

    pub fn get_validator(&self, public_key: &str) -> Result<Option<ValidatorState>, String> {
        let raw = self.db.get(public_key).map_err(|e| e.to_string())?;
        if let Some(value) = raw {
            let state = serde_json::from_slice::<ValidatorState>(&value).map_err(|e| e.to_string())?;
            return Ok(Some(state));
        }
        Ok(None)
    }

    pub fn set_validator(&self, public_key: &str, state: &ValidatorState) -> Result<(), String> {
        let raw = serde_json::to_vec(state).map_err(|e| e.to_string())?;
        self.db.insert(public_key, raw).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_validator(&self, public_key: &str) -> Result<(), String> {
        self.db.remove(public_key).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_validators(&self) -> Result<Vec<(String, ValidatorState)>, String> {
        let mut out = Vec::new();
        for entry in self.db.iter() {
            let (key, value) = entry.map_err(|e| e.to_string())?;
            if key.as_ref() == b"__meta" {
                continue;
            }
            let public_key = String::from_utf8(key.to_vec()).map_err(|e| e.to_string())?;
            let state = serde_json::from_slice::<ValidatorState>(&value).map_err(|e| e.to_string())?;
            out.push((public_key, state));
        }
        Ok(out)
    }

    pub fn set_meta_height(&self, height: i64) -> Result<(), String> {
        self.meta
            .insert("height", height.to_string().as_bytes())
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_meta_height(&self) -> Result<i64, String> {
        let raw = self.meta.get("height").map_err(|e| e.to_string())?;
        if let Some(value) = raw {
            let text = String::from_utf8(value.to_vec()).map_err(|e| e.to_string())?;
            return Ok(text.parse::<i64>().unwrap_or(-1));
        }
        Ok(-1)
    }

    pub fn reset(&self) -> Result<(), String> {
        self.db.clear().map_err(|e| e.to_string())
    }

    // ===== Unbonding Queue =====

    /// Queue an unbonding entry (validator wants to unstake)
    pub fn queue_unbonding(&self, entry: &UnbondingEntry) -> Result<(), String> {
        let key = format!("{}:{}", entry.validator_pub_key, entry.initiated_at);
        let val = serde_json::to_vec(entry).map_err(|e| e.to_string())?;
        self.unbonding.insert(key.as_bytes(), val).map_err(|e| e.to_string())?;
        self.unbonding.flush().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Get all unbonding entries for a validator
    pub fn get_unbonding_entries(&self, pub_key: &str) -> Result<Vec<UnbondingEntry>, String> {
        let prefix = format!("{}:", pub_key);
        let mut entries = Vec::new();
        for item in self.unbonding.scan_prefix(prefix.as_bytes()) {
            let (_, val) = item.map_err(|e| e.to_string())?;
            if let Ok(entry) = serde_json::from_slice::<UnbondingEntry>(&val) {
                entries.push(entry);
            }
        }
        Ok(entries)
    }

    /// Get ALL unbonding entries across all validators
    pub fn get_all_unbonding_entries(&self) -> Result<Vec<UnbondingEntry>, String> {
        let mut entries = Vec::new();
        for item in self.unbonding.iter() {
            let (_, val) = item.map_err(|e| e.to_string())?;
            if let Ok(entry) = serde_json::from_slice::<UnbondingEntry>(&val) {
                entries.push(entry);
            }
        }
        Ok(entries)
    }

    /// Complete matured unbonding entries (returns total released amount)
    pub fn complete_unbonding(&self, pub_key: &str, current_height: u64) -> Result<u128, String> {
        let prefix = format!("{}:", pub_key);
        let mut released = 0u128;
        let mut keys_to_remove = Vec::new();
        for item in self.unbonding.scan_prefix(prefix.as_bytes()) {
            let (key, val) = item.map_err(|e| e.to_string())?;
            if let Ok(entry) = serde_json::from_slice::<UnbondingEntry>(&val) {
                if current_height >= entry.completes_at {
                    released += entry.amount;
                    keys_to_remove.push(key);
                }
            }
        }
        for key in keys_to_remove {
            self.unbonding.remove(&key).map_err(|e| e.to_string())?;
        }
        if released > 0 {
            self.unbonding.flush().map_err(|e| e.to_string())?;
        }
        Ok(released)
    }

    /// Slash a validator — burns a fraction of their stake
    pub fn slash_validator(
        &self,
        pub_key: &str,
        slash_fraction_denom: u128,
        jail_until: u64,
    ) -> Result<u128, String> {
        let mut state = self.get_validator(pub_key)?
            .ok_or_else(|| format!("Validator {} not found", pub_key))?;
        
        let slash_amount = state.stake / slash_fraction_denom;
        state.stake = state.stake.saturating_sub(slash_amount);
        state.slash_count += 1;
        state.total_slashed += slash_amount;
        state.jailed_until = jail_until;
        
        self.set_validator(pub_key, &state)?;
        Ok(slash_amount)
    }
}
