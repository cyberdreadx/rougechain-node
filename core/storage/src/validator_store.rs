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
}

#[derive(Clone)]
pub struct ValidatorStore {
    db: sled::Db,
    meta: sled::Tree,
}

impl ValidatorStore {
    pub fn new(data_dir: impl AsRef<Path>) -> Result<Self, String> {
        let path = data_dir.as_ref().join("validators-db");
        let db = sled::open(path).map_err(|e| e.to_string())?;
        let meta = db.open_tree("meta").map_err(|e| e.to_string())?;
        Ok(Self { db, meta })
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
}
