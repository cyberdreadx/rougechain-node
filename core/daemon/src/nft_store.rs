use serde::{Deserialize, Serialize};
use sled::Db;
use std::path::Path;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NftCollection {
    pub collection_id: String,
    pub symbol: String,
    pub name: String,
    pub creator: String,
    pub description: Option<String>,
    pub image: Option<String>,
    pub max_supply: Option<u64>,
    pub minted: u64,
    pub royalty_bps: u16,
    pub royalty_recipient: String,
    pub frozen: bool,
    pub created_at: u64,
}

impl NftCollection {
    pub fn make_collection_id(creator: &str, symbol: &str) -> String {
        let short = if creator.len() >= 16 {
            &creator[..16]
        } else {
            creator
        };
        format!("col:{}:{}", short, symbol.to_uppercase())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NftToken {
    pub collection_id: String,
    pub token_id: u64,
    pub owner: String,
    pub creator: String,
    pub name: String,
    pub metadata_uri: Option<String>,
    pub attributes: Option<serde_json::Value>,
    pub locked: bool,
    pub minted_at: u64,
    pub transferred_at: u64,
}

impl NftToken {
    pub fn make_key(collection_id: &str, token_id: u64) -> String {
        format!("{}:{}", collection_id, token_id)
    }
}

#[derive(Clone)]
pub struct NftStore {
    collections_db: Arc<Db>,
    tokens_db: Arc<Db>,
}

impl NftStore {
    pub fn new(data_dir: &Path) -> Result<Self, String> {
        let col_path = data_dir.join("nft-collections-db");
        let tok_path = data_dir.join("nft-tokens-db");
        let collections_db =
            sled::open(col_path).map_err(|e| format!("Failed to open NFT collections DB: {}", e))?;
        let tokens_db =
            sled::open(tok_path).map_err(|e| format!("Failed to open NFT tokens DB: {}", e))?;
        Ok(Self {
            collections_db: Arc::new(collections_db),
            tokens_db: Arc::new(tokens_db),
        })
    }

    // ── Collections ──

    pub fn save_collection(&self, col: &NftCollection) -> Result<(), String> {
        let value =
            serde_json::to_vec(col).map_err(|e| format!("Failed to serialize collection: {}", e))?;
        self.collections_db
            .insert(col.collection_id.as_bytes(), value)
            .map_err(|e| format!("Failed to save collection: {}", e))?;
        self.collections_db
            .flush()
            .map_err(|e| format!("Failed to flush: {}", e))?;
        Ok(())
    }

    pub fn get_collection(&self, collection_id: &str) -> Result<Option<NftCollection>, String> {
        match self.collections_db.get(collection_id.as_bytes()) {
            Ok(Some(value)) => {
                let col: NftCollection = serde_json::from_slice(&value)
                    .map_err(|e| format!("Failed to deserialize collection: {}", e))?;
                Ok(Some(col))
            }
            Ok(None) => Ok(None),
            Err(e) => Err(format!("Failed to get collection: {}", e)),
        }
    }

    pub fn list_collections(&self) -> Result<Vec<NftCollection>, String> {
        let mut collections = Vec::new();
        for item in self.collections_db.iter() {
            match item {
                Ok((_, value)) => {
                    if let Ok(col) = serde_json::from_slice::<NftCollection>(&value) {
                        collections.push(col);
                    }
                }
                Err(e) => return Err(format!("Failed to iterate collections: {}", e)),
            }
        }
        Ok(collections)
    }

    pub fn clear_all_collections(&self) -> Result<(), String> {
        self.collections_db
            .clear()
            .map_err(|e| format!("Failed to clear collections: {}", e))?;
        self.collections_db
            .flush()
            .map_err(|e| format!("Failed to flush: {}", e))?;
        Ok(())
    }

    // ── Tokens ──

    pub fn save_token(&self, token: &NftToken) -> Result<(), String> {
        let key = NftToken::make_key(&token.collection_id, token.token_id);
        let value =
            serde_json::to_vec(token).map_err(|e| format!("Failed to serialize NFT: {}", e))?;
        self.tokens_db
            .insert(key.as_bytes(), value)
            .map_err(|e| format!("Failed to save NFT: {}", e))?;
        self.tokens_db
            .flush()
            .map_err(|e| format!("Failed to flush: {}", e))?;
        Ok(())
    }

    pub fn get_token(
        &self,
        collection_id: &str,
        token_id: u64,
    ) -> Result<Option<NftToken>, String> {
        let key = NftToken::make_key(collection_id, token_id);
        match self.tokens_db.get(key.as_bytes()) {
            Ok(Some(value)) => {
                let token: NftToken = serde_json::from_slice(&value)
                    .map_err(|e| format!("Failed to deserialize NFT: {}", e))?;
                Ok(Some(token))
            }
            Ok(None) => Ok(None),
            Err(e) => Err(format!("Failed to get NFT: {}", e)),
        }
    }

    pub fn delete_token(&self, collection_id: &str, token_id: u64) -> Result<(), String> {
        let key = NftToken::make_key(collection_id, token_id);
        self.tokens_db
            .remove(key.as_bytes())
            .map_err(|e| format!("Failed to delete NFT: {}", e))?;
        self.tokens_db
            .flush()
            .map_err(|e| format!("Failed to flush: {}", e))?;
        Ok(())
    }

    pub fn get_tokens_by_collection(
        &self,
        collection_id: &str,
        limit: usize,
        offset: usize,
    ) -> Result<(Vec<NftToken>, usize), String> {
        let prefix = format!("{}:", collection_id);
        let mut tokens = Vec::new();
        for item in self.tokens_db.scan_prefix(prefix.as_bytes()) {
            match item {
                Ok((_, value)) => {
                    if let Ok(token) = serde_json::from_slice::<NftToken>(&value) {
                        tokens.push(token);
                    }
                }
                Err(e) => return Err(format!("Failed to iterate NFTs: {}", e)),
            }
        }
        let total = tokens.len();
        let paginated: Vec<NftToken> = tokens.into_iter().skip(offset).take(limit).collect();
        Ok((paginated, total))
    }

    pub fn get_tokens_by_owner(&self, owner: &str) -> Result<Vec<NftToken>, String> {
        let mut tokens = Vec::new();
        for item in self.tokens_db.iter() {
            match item {
                Ok((_, value)) => {
                    if let Ok(token) = serde_json::from_slice::<NftToken>(&value) {
                        if token.owner == owner {
                            tokens.push(token);
                        }
                    }
                }
                Err(e) => return Err(format!("Failed to iterate NFTs: {}", e)),
            }
        }
        Ok(tokens)
    }

    pub fn clear_all_tokens(&self) -> Result<(), String> {
        self.tokens_db
            .clear()
            .map_err(|e| format!("Failed to clear tokens: {}", e))?;
        self.tokens_db
            .flush()
            .map_err(|e| format!("Failed to flush: {}", e))?;
        Ok(())
    }

    pub fn clear_all(&self) -> Result<(), String> {
        self.clear_all_collections()?;
        self.clear_all_tokens()?;
        Ok(())
    }
}
