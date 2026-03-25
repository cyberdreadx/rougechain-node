use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A single indexed event extracted from a transaction
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IndexedEvent {
    pub block_height: u64,
    pub tx_hash: String,
    pub tx_type: String,
    pub from: String,
    pub to: Option<String>,
    pub amount: Option<f64>,
    pub token: Option<String>,
    pub timestamp: u64,
    pub fee: f64,
    /// Extra fields (pool_id, collection_id, proposal_id, etc.)
    #[serde(default)]
    pub metadata: HashMap<String, String>,
}

/// Persistent index stored in sled with multiple secondary indexes
pub struct Indexer {
    /// Primary event store: key = {height}:{tx_index} -> event JSON
    events: sled::Tree,
    /// Address index: key = addr:{pubkey}:{height}:{tx_idx} -> empty
    by_address: sled::Tree,
    /// Type index: key = type:{tx_type}:{height}:{tx_idx} -> empty
    by_type: sled::Tree,
    /// Token index: key = token:{symbol}:{height}:{tx_idx} -> empty
    by_token: sled::Tree,
    /// Block index: key = block:{height} -> tx count
    by_block: sled::Tree,
}

impl Indexer {
    pub fn new(data_dir: &std::path::Path) -> Result<Self, String> {
        let db = sled::open(data_dir.join("indexer-db"))
            .map_err(|e| format!("indexer-db: {}", e))?;
        Ok(Self {
            events: db.open_tree("events").map_err(|e| format!("events tree: {}", e))?,
            by_address: db.open_tree("by_address").map_err(|e| format!("addr tree: {}", e))?,
            by_type: db.open_tree("by_type").map_err(|e| format!("type tree: {}", e))?,
            by_token: db.open_tree("by_token").map_err(|e| format!("token tree: {}", e))?,
            by_block: db.open_tree("by_block").map_err(|e| format!("block tree: {}", e))?,
        })
    }

    /// Index a block's transactions
    pub fn index_block(&self, block: &quantum_vault_types::BlockV1) -> Result<usize, String> {
        let height = block.header.height;
        let timestamp = block.header.time;
        let mut count = 0;

        for (idx, tx) in block.txs.iter().enumerate() {
            let tx_hash = quantum_vault_types::compute_single_tx_hash(tx);
            let event = IndexedEvent {
                block_height: height,
                tx_hash: tx_hash.clone(),
                tx_type: tx.tx_type.clone(),
                from: tx.from_pub_key.clone(),
                to: tx.payload.to_pub_key_hex.clone(),
                amount: tx.payload.amount.map(|a| a as f64),
                token: tx.payload.token_symbol.clone(),
                timestamp,
                fee: tx.fee,
                metadata: self.extract_metadata(tx),
            };

            let primary_key = format!("{}:{:04}", height, idx);
            let json = serde_json::to_vec(&event).map_err(|e| e.to_string())?;
            self.events.insert(primary_key.as_bytes(), json).map_err(|e| e.to_string())?;

            // Address index (from)
            let addr_key = format!("addr:{}:{}:{:04}", &event.from, height, idx);
            self.by_address.insert(addr_key.as_bytes(), b"").map_err(|e| e.to_string())?;

            // Address index (to, if present)
            if let Some(ref to) = event.to {
                let to_key = format!("addr:{}:{}:{:04}", to, height, idx);
                self.by_address.insert(to_key.as_bytes(), b"").map_err(|e| e.to_string())?;
            }

            // Type index
            let type_key = format!("type:{}:{}:{:04}", &event.tx_type, height, idx);
            self.by_type.insert(type_key.as_bytes(), b"").map_err(|e| e.to_string())?;

            // Token index (if applicable)
            if let Some(ref token) = event.token {
                let token_key = format!("token:{}:{}:{:04}", token, height, idx);
                self.by_token.insert(token_key.as_bytes(), b"").map_err(|e| e.to_string())?;
            }

            count += 1;
        }

        // Block index
        let block_key = format!("block:{}", height);
        self.by_block.insert(block_key.as_bytes(), &(count as u32).to_be_bytes()).map_err(|e| e.to_string())?;
        let _ = self.events.flush();

        Ok(count)
    }

    /// Query events by address (paginated)
    pub fn query_by_address(&self, address: &str, limit: usize, offset: usize) -> Result<Vec<IndexedEvent>, String> {
        let prefix = format!("addr:{}:", address);
        self.scan_index(&self.by_address, &prefix, limit, offset)
    }

    /// Query events by transaction type (paginated)
    pub fn query_by_type(&self, tx_type: &str, limit: usize, offset: usize) -> Result<Vec<IndexedEvent>, String> {
        let prefix = format!("type:{}:", tx_type);
        self.scan_index(&self.by_type, &prefix, limit, offset)
    }

    /// Query events by token symbol (paginated)
    pub fn query_by_token(&self, token: &str, limit: usize, offset: usize) -> Result<Vec<IndexedEvent>, String> {
        let prefix = format!("token:{}:", token);
        self.scan_index(&self.by_token, &prefix, limit, offset)
    }

    /// Query events by block height
    pub fn query_by_block(&self, height: u64) -> Result<Vec<IndexedEvent>, String> {
        let prefix = format!("{}:", height);
        let mut events = Vec::new();
        for item in self.events.scan_prefix(prefix.as_bytes()) {
            let (_, value) = item.map_err(|e| e.to_string())?;
            if let Ok(event) = serde_json::from_slice::<IndexedEvent>(&value) {
                events.push(event);
            }
        }
        Ok(events)
    }

    /// Query events by block height range
    pub fn query_by_range(&self, from_height: u64, to_height: u64, limit: usize) -> Result<Vec<IndexedEvent>, String> {
        let mut events = Vec::new();
        for height in from_height..=to_height {
            if events.len() >= limit { break; }
            let prefix = format!("{}:", height);
            for item in self.events.scan_prefix(prefix.as_bytes()) {
                if events.len() >= limit { break; }
                let (_, value) = item.map_err(|e| e.to_string())?;
                if let Ok(event) = serde_json::from_slice::<IndexedEvent>(&value) {
                    events.push(event);
                }
            }
        }
        Ok(events)
    }

    /// Get total indexed event count
    pub fn event_count(&self) -> usize {
        self.events.len()
    }

    /// Get highest indexed block
    pub fn highest_indexed_block(&self) -> Option<u64> {
        self.by_block.iter().rev().next()
            .and_then(|item| item.ok())
            .and_then(|(k, _)| {
                let key_str = String::from_utf8(k.to_vec()).ok()?;
                key_str.strip_prefix("block:")?.parse::<u64>().ok()
            })
    }

    /// Backfill index from chain store (used on startup to catch up)
    pub fn backfill(&self, store: &quantum_vault_storage::chain_store::ChainStore) -> Result<usize, String> {
        let highest = self.highest_indexed_block().unwrap_or(0);
        let tip = store.get_tip()?.height;
        let mut total = 0;
        if highest >= tip {
            return Ok(0); // Already caught up
        }
        let start = if highest == 0 { 1 } else { highest + 1 };
        for height in start..=tip {
            if let Ok(Some(block)) = store.get_block(height) {
                total += self.index_block(&block)?;
            }
        }
        eprintln!("[indexer] Backfilled {} events from blocks {}-{}", total, start, tip);
        Ok(total)
    }

    // ── Helpers ──────────────────────────────────────────────────

    fn scan_index(&self, tree: &sled::Tree, prefix: &str, limit: usize, offset: usize) -> Result<Vec<IndexedEvent>, String> {
        let mut events = Vec::new();
        let mut skipped = 0;
        for item in tree.scan_prefix(prefix.as_bytes()) {
            let (key, _) = item.map_err(|e| e.to_string())?;
            let key_str = String::from_utf8(key.to_vec()).map_err(|e| e.to_string())?;
            // Extract height:idx from the end of the key
            let parts: Vec<&str> = key_str.splitn(3, ':').collect();
            if parts.len() < 3 { continue; }
            // The remaining part after the prefix is height:idx
            let remainder = &key_str[prefix.len()..];
            if skipped < offset {
                skipped += 1;
                continue;
            }
            if events.len() >= limit { break; }
            // Look up the primary event
            if let Ok(Some(value)) = self.events.get(remainder.as_bytes()) {
                if let Ok(event) = serde_json::from_slice::<IndexedEvent>(&value) {
                    events.push(event);
                }
            }
        }
        Ok(events)
    }

    fn extract_metadata(&self, tx: &quantum_vault_types::TxV1) -> HashMap<String, String> {
        let mut meta = HashMap::new();
        if let Some(ref pid) = tx.payload.pool_id {
            meta.insert("pool_id".to_string(), pid.clone());
        }
        if let Some(ref cid) = tx.payload.nft_collection_id {
            meta.insert("collection_id".to_string(), cid.clone());
        }
        if let Some(ref name) = tx.payload.proposal_title {
            meta.insert("name".to_string(), name.clone());
        }
        if let Some(ref desc) = tx.payload.nft_description {
            meta.insert("description".to_string(), desc.clone());
        }
        if let Some(ref proposal_id) = tx.payload.proposal_id {
            meta.insert("proposal_id".to_string(), proposal_id.clone());
        }
        meta
    }
}
