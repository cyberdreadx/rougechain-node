use serde::{Deserialize, Serialize};

/// A registered push notification token for a wallet
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushRegistration {
    pub public_key: String,
    pub push_token: String,
    pub platform: String, // "ios", "android", "expo"
    pub registered_at: i64,
}

/// Sled-backed store for push notification tokens
/// Key: public_key → serialized PushRegistration
#[derive(Clone)]
pub struct PushTokenStore {
    tree: sled::Tree,
}

impl PushTokenStore {
    pub fn new(data_dir: &std::path::Path) -> Result<Self, String> {
        let db = sled::open(data_dir.join("push-token-db"))
            .map_err(|e| format!("open push-token DB: {}", e))?;
        let tree = db
            .open_tree("push_tokens")
            .map_err(|e| format!("open push_tokens tree: {}", e))?;
        Ok(Self { tree })
    }

    /// Register or update a push token for a public key
    pub fn register(&self, reg: &PushRegistration) -> Result<(), String> {
        let val = serde_json::to_vec(reg).map_err(|e| format!("serialize: {}", e))?;
        self.tree
            .insert(reg.public_key.as_bytes(), val)
            .map_err(|e| format!("insert: {}", e))?;
        Ok(())
    }

    /// Remove a push token registration
    pub fn unregister(&self, public_key: &str) -> Result<bool, String> {
        let removed = self.tree
            .remove(public_key.as_bytes())
            .map_err(|e| format!("remove: {}", e))?;
        Ok(removed.is_some())
    }

    /// Get push registration for a public key
    pub fn get(&self, public_key: &str) -> Result<Option<PushRegistration>, String> {
        match self.tree.get(public_key.as_bytes()) {
            Ok(Some(val)) => {
                let reg: PushRegistration =
                    serde_json::from_slice(&val).map_err(|e| format!("deserialize: {}", e))?;
                Ok(Some(reg))
            }
            Ok(None) => Ok(None),
            Err(e) => Err(format!("get: {}", e)),
        }
    }

    /// Get all push registrations (for batch notification dispatch)
    pub fn list_all(&self) -> Result<Vec<PushRegistration>, String> {
        let mut result = Vec::new();
        for item in self.tree.iter() {
            let (_, val) = item.map_err(|e| format!("iter: {}", e))?;
            if let Ok(reg) = serde_json::from_slice::<PushRegistration>(&val) {
                result.push(reg);
            }
        }
        Ok(result)
    }

    /// Get push tokens for a list of public keys (for targeted notifications)
    pub fn get_tokens_for_keys(&self, keys: &[&str]) -> Vec<PushRegistration> {
        keys.iter()
            .filter_map(|k| self.get(k).ok().flatten())
            .collect()
    }
}
