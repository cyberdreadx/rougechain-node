use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};
use std::path::Path;
use std::sync::Arc;

/// Token metadata stored on-chain
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenMetadata {
    pub symbol: String,
    pub name: String,
    pub creator: String,           // Public key of token creator (has update authority)
    #[serde(default)]
    pub token_id: String,          // Deterministic SHA-256 ID: hex(SHA-256(creator:symbol:created_at))[..32]
    pub image: Option<String>,     // Image URL (IPFS, HTTP, or data URI)
    pub description: Option<String>,
    pub website: Option<String>,
    pub twitter: Option<String>,
    pub discord: Option<String>,
    pub created_at: i64,           // Timestamp when token was created
    pub updated_at: i64,           // Timestamp of last metadata update
    #[serde(default)]
    pub frozen: bool,              // Creator can freeze all transfers
    #[serde(default)]
    pub mintable: bool,            // Creator can mint additional supply
    #[serde(default)]
    pub max_supply: Option<u64>,   // Optional cap on total mintable supply (None = unlimited)
    #[serde(default)]
    pub total_minted: u64,         // Running total of all minted supply
}

impl TokenMetadata {
    /// Generate a deterministic token ID from creator + symbol + created_at
    pub fn generate_token_id(creator: &str, symbol: &str, created_at: i64) -> String {
        let input = format!("{}:{}:{}", creator, symbol.to_uppercase(), created_at);
        let hash = Sha256::digest(input.as_bytes());
        hex::encode(&hash[..16]) // 32-char hex ID
    }
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

    /// Backfill token_id for existing tokens that don't have one
    pub fn migrate_token_ids(&self) -> Result<u32, String> {
        let mut migrated = 0u32;
        let all = self.get_all()?;
        for mut meta in all {
            if meta.token_id.is_empty() {
                meta.token_id = TokenMetadata::generate_token_id(&meta.creator, &meta.symbol, meta.created_at);
                self.set_metadata(&meta)?;
                migrated += 1;
                eprintln!("[migration] Assigned token_id {} to {}", meta.token_id, meta.symbol);
            }
        }
        Ok(migrated)
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

    /// Check if a token is frozen
    pub fn is_frozen(&self, symbol: &str) -> Result<bool, String> {
        match self.get_metadata(symbol)? {
            Some(m) => Ok(m.frozen),
            None => Ok(false),
        }
    }

    /// Set the frozen state for a token (only creator should call this)
    pub fn set_frozen(&self, symbol: &str, frozen: bool) -> Result<(), String> {
        match self.get_metadata(symbol)? {
            Some(mut meta) => {
                meta.frozen = frozen;
                meta.updated_at = chrono::Utc::now().timestamp();
                self.set_metadata(&meta)
            }
            None => Err(format!("Token {} not found", symbol)),
        }
    }

    /// Check if a token is mintable
    pub fn is_mintable(&self, symbol: &str) -> Result<bool, String> {
        match self.get_metadata(symbol)? {
            Some(m) => Ok(m.mintable),
            None => Ok(false),
        }
    }

    /// Record additional minted supply
    pub fn record_mint(&self, symbol: &str, amount: u64) -> Result<(), String> {
        match self.get_metadata(symbol)? {
            Some(mut meta) => {
                meta.total_minted += amount;
                meta.updated_at = chrono::Utc::now().timestamp();
                self.set_metadata(&meta)
            }
            None => Err(format!("Token {} not found", symbol)),
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

