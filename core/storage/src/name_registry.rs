use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NameEntry {
    pub name: String,
    pub wallet_id: String,
    pub registered_at: String,
}

#[derive(Clone)]
pub struct NameRegistry {
    db: Arc<sled::Db>,
}

fn validate_name(name: &str) -> Result<String, String> {
    let lower = name.to_lowercase();
    if lower.len() < 3 || lower.len() > 20 {
        return Err("Name must be 3-20 characters".into());
    }
    if !lower.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("Name may only contain letters, numbers, and underscores".into());
    }
    if lower.starts_with('_') || lower.ends_with('_') {
        return Err("Name cannot start or end with underscore".into());
    }
    Ok(lower)
}

impl NameRegistry {
    pub fn new(data_dir: impl AsRef<Path>) -> Result<Self, String> {
        let db_path = data_dir.as_ref().join("name-registry-db");
        let db = sled::open(&db_path)
            .map_err(|e| format!("Failed to open name registry DB: {}", e))?;
        Ok(Self { db: Arc::new(db) })
    }

    fn name_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("name_to_wallet").map_err(|e| e.to_string())
    }

    fn wallet_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("wallet_to_name").map_err(|e| e.to_string())
    }

    pub fn register_name(&self, name: &str, wallet_id: &str) -> Result<NameEntry, String> {
        let canonical = validate_name(name)?;
        let name_tree = self.name_tree()?;
        let wallet_tree = self.wallet_tree()?;

        if name_tree.contains_key(canonical.as_bytes()).map_err(|e| e.to_string())? {
            return Err(format!("Name '{}' is already taken", canonical));
        }

        if wallet_tree.contains_key(wallet_id.as_bytes()).map_err(|e| e.to_string())? {
            return Err("This wallet already has a registered name".into());
        }

        let entry = NameEntry {
            name: canonical.clone(),
            wallet_id: wallet_id.to_string(),
            registered_at: chrono::Utc::now().to_rfc3339(),
        };
        let bytes = serde_json::to_vec(&entry).map_err(|e| e.to_string())?;

        name_tree.insert(canonical.as_bytes(), bytes.as_slice()).map_err(|e| e.to_string())?;
        wallet_tree.insert(wallet_id.as_bytes(), canonical.as_bytes()).map_err(|e| e.to_string())?;
        self.db.flush().map_err(|e| e.to_string())?;

        Ok(entry)
    }

    pub fn lookup_name(&self, name: &str) -> Result<Option<NameEntry>, String> {
        let canonical = name.to_lowercase();
        let name_tree = self.name_tree()?;
        match name_tree.get(canonical.as_bytes()).map_err(|e| e.to_string())? {
            Some(bytes) => {
                let entry: NameEntry = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                Ok(Some(entry))
            }
            None => Ok(None),
        }
    }

    pub fn reverse_lookup(&self, wallet_id: &str) -> Result<Option<String>, String> {
        let wallet_tree = self.wallet_tree()?;
        match wallet_tree.get(wallet_id.as_bytes()).map_err(|e| e.to_string())? {
            Some(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).to_string())),
            None => Ok(None),
        }
    }

    pub fn update_wallet_id(&self, old_id: &str, new_id: &str) -> Result<(), String> {
        let wallet_tree = self.wallet_tree()?;
        let name_tree = self.name_tree()?;
        if let Some(name_bytes) = wallet_tree.get(old_id.as_bytes()).map_err(|e| e.to_string())? {
            let canonical = String::from_utf8_lossy(&name_bytes).to_string();
            if let Some(entry_bytes) = name_tree.get(canonical.as_bytes()).map_err(|e| e.to_string())? {
                let mut entry: NameEntry = serde_json::from_slice(&entry_bytes).map_err(|e| e.to_string())?;
                entry.wallet_id = new_id.to_string();
                let new_bytes = serde_json::to_vec(&entry).map_err(|e| e.to_string())?;
                name_tree.insert(canonical.as_bytes(), new_bytes.as_slice()).map_err(|e| e.to_string())?;
                wallet_tree.remove(old_id.as_bytes()).map_err(|e| e.to_string())?;
                wallet_tree.insert(new_id.as_bytes(), canonical.as_bytes()).map_err(|e| e.to_string())?;
                self.db.flush().map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    pub fn release_name(&self, name: &str, wallet_id: &str) -> Result<(), String> {
        let canonical = name.to_lowercase();
        let name_tree = self.name_tree()?;
        let wallet_tree = self.wallet_tree()?;

        match name_tree.get(canonical.as_bytes()).map_err(|e| e.to_string())? {
            Some(bytes) => {
                let entry: NameEntry = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                if entry.wallet_id != wallet_id {
                    return Err("You do not own this name".into());
                }
            }
            None => return Err("Name not found".into()),
        }

        name_tree.remove(canonical.as_bytes()).map_err(|e| e.to_string())?;
        wallet_tree.remove(wallet_id.as_bytes()).map_err(|e| e.to_string())?;
        self.db.flush().map_err(|e| e.to_string())?;
        Ok(())
    }
}
