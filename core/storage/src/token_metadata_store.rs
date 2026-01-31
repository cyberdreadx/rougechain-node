use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;

/// Token metadata stored on-chain
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenMetadata {
    pub symbol: String,
    pub name: String,
    pub creator: String,           // Public key of token creator (has update authority)
    pub image: Option<String>,     // Image URL (IPFS, HTTP, or data URI)
    pub description: Option<String>,
    pub website: Option<String>,
    pub twitter: Option<String>,
    pub discord: Option<String>,
    pub created_at: i64,           // Timestamp when token was created
    pub updated_at: i64,           // Timestamp of last metadata update
}

/// Persistent store for token metadata
#[derive(Clone)]
pub struct TokenMetadataStore {
    db: Arc<sled::Db>,
}

impl TokenMetadataStore {
    pub fn new(data_dir: &str) -> Result<Self, String> {
        let path = Path::new(data_dir).join("token-metadata-db");
        let db = sled::open(&path).map_err(|e| format!("Failed to open token metadata db: {}", e))?;
        Ok(Self { db: Arc::new(db) })
    }

    /// Create or update token metadata (only creator can update)
    pub fn set_metadata(&self, metadata: &TokenMetadata) -> Result<(), String> {
        let key = metadata.symbol.to_uppercase();
        let value = serde_json::to_vec(metadata)
            .map_err(|e| format!("Failed to serialize metadata: {}", e))?;
        self.db.insert(key.as_bytes(), value)
            .map_err(|e| format!("Failed to store metadata: {}", e))?;
        self.db.flush().map_err(|e| format!("Failed to flush: {}", e))?;
        Ok(())
    }

    /// Get metadata for a token
    pub fn get_metadata(&self, symbol: &str) -> Result<Option<TokenMetadata>, String> {
        let key = symbol.to_uppercase();
        match self.db.get(key.as_bytes()) {
            Ok(Some(data)) => {
                let metadata: TokenMetadata = serde_json::from_slice(&data)
                    .map_err(|e| format!("Failed to deserialize metadata: {}", e))?;
                Ok(Some(metadata))
            }
            Ok(None) => Ok(None),
            Err(e) => Err(format!("Failed to get metadata: {}", e)),
        }
    }

    /// Get the creator (update authority) for a token
    pub fn get_creator(&self, symbol: &str) -> Result<Option<String>, String> {
        self.get_metadata(symbol).map(|opt| opt.map(|m| m.creator))
    }

    /// Get all token metadata
    pub fn get_all(&self) -> Result<Vec<TokenMetadata>, String> {
        let mut result = Vec::new();
        for item in self.db.iter() {
            let (_, value) = item.map_err(|e| format!("Iterator error: {}", e))?;
            let metadata: TokenMetadata = serde_json::from_slice(&value)
                .map_err(|e| format!("Failed to deserialize: {}", e))?;
            result.push(metadata);
        }
        Ok(result)
    }

    /// Check if a public key is the creator of a token
    pub fn is_creator(&self, symbol: &str, public_key: &str) -> Result<bool, String> {
        match self.get_metadata(symbol)? {
            Some(metadata) => Ok(metadata.creator == public_key),
            None => Ok(false),
        }
    }

    /// Delete metadata (only for testing/reset)
    pub fn delete_metadata(&self, symbol: &str) -> Result<(), String> {
        let key = symbol.to_uppercase();
        self.db.remove(key.as_bytes())
            .map_err(|e| format!("Failed to delete: {}", e))?;
        self.db.flush().map_err(|e| format!("Failed to flush: {}", e))?;
        Ok(())
    }

    /// Clear all metadata (for chain reset)
    pub fn clear(&self) -> Result<(), String> {
        self.db.clear().map_err(|e| format!("Failed to clear: {}", e))?;
        self.db.flush().map_err(|e| format!("Failed to flush: {}", e))?;
        Ok(())
    }
}
