use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use quantum_vault_crypto::sha256;
use quantum_vault_types::{compute_block_hash, compute_tx_hash, BlockHeaderV1, BlockV1, ChainConfig};

#[derive(Clone)]
pub struct ChainStore {
    db: Arc<sled::Db>,
    data_dir: PathBuf,
    chain: ChainConfig,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Tip {
    pub height: u64,
    pub hash: String,
}

fn height_key(height: u64) -> [u8; 8] {
    height.to_be_bytes()
}

fn deserialize_block(bytes: &[u8]) -> Result<BlockV1, String> {
    serde_json::from_slice(bytes).map_err(|e| format!("deserialize block: {}", e))
}

fn serialize_block(block: &BlockV1) -> Result<Vec<u8>, String> {
    serde_json::to_vec(block).map_err(|e| format!("serialize block: {}", e))
}

impl ChainStore {
    pub fn new(data_dir: impl AsRef<Path>, chain: ChainConfig) -> Result<Self, String> {
        let data_dir = data_dir.as_ref().to_path_buf();
        fs::create_dir_all(&data_dir).map_err(|e| format!("create data dir: {}", e))?;
        let db_path = data_dir.join("chain-db");
        let db = sled::open(&db_path)
            .map_err(|e| format!("Failed to open chain DB: {}", e))?;
        Ok(Self {
            db: Arc::new(db),
            data_dir,
            chain,
        })
    }

    pub fn init(&self) -> Result<(), String> {
        let legacy_path = self.data_dir.join("chain.jsonl");
        if legacy_path.exists() && self.db.is_empty() {
            self.migrate_from_jsonl(&legacy_path)?;
        }

        if self.db.is_empty() {
            let genesis = self.create_genesis_block();
            self.append_block(&genesis)?;
        }
        Ok(())
    }

    pub fn append_block(&self, block: &BlockV1) -> Result<(), String> {
        let key = height_key(block.header.height);
        let value = serialize_block(block)?;
        self.db
            .insert(key, value)
            .map_err(|e| format!("sled insert: {}", e))?;
        self.db.flush().map_err(|e| format!("sled flush: {}", e))?;
        Ok(())
    }

    pub fn get_tip(&self) -> Result<Tip, String> {
        if let Some(result) = self.db.last().map_err(|e| format!("sled last: {}", e))? {
            let (_, value) = result;
            let block = deserialize_block(&value)?;
            return Ok(Tip {
                height: block.header.height,
                hash: block.hash.clone(),
            });
        }
        Ok(Tip {
            height: 0,
            hash: "0".to_string(),
        })
    }

    pub fn get_all_blocks(&self) -> Result<Vec<BlockV1>, String> {
        let mut blocks = Vec::new();
        for item in self.db.iter() {
            let (_, value) = item.map_err(|e| format!("sled iter: {}", e))?;
            blocks.push(deserialize_block(&value)?);
        }
        Ok(blocks)
    }

    /// O(1) block lookup by height (previously O(n) scanning entire file)
    pub fn get_block(&self, height: u64) -> Result<Option<BlockV1>, String> {
        let key = height_key(height);
        match self.db.get(key).map_err(|e| format!("sled get: {}", e))? {
            Some(value) => Ok(Some(deserialize_block(&value)?)),
            None => Ok(None),
        }
    }

    pub fn scan_blocks<F>(&self, mut callback: F, start_height: u64) -> Result<(), String>
    where
        F: FnMut(BlockV1) -> Result<(), String>,
    {
        let start_key = height_key(start_height);
        for item in self.db.range(start_key..) {
            let (_, value) = item.map_err(|e| format!("sled range: {}", e))?;
            callback(deserialize_block(&value)?)?;
        }
        Ok(())
    }

    /// Get blocks from a given height onward (efficient range query for P2P sync)
    pub fn get_blocks_from(&self, start_height: u64) -> Result<Vec<BlockV1>, String> {
        let start_key = height_key(start_height);
        let mut blocks = Vec::new();
        for item in self.db.range(start_key..) {
            let (_, value) = item.map_err(|e| format!("sled range: {}", e))?;
            blocks.push(deserialize_block(&value)?);
        }
        Ok(blocks)
    }

    /// Get the last N blocks in ascending height order (uses reverse iterator)
    pub fn get_recent_blocks(&self, limit: usize) -> Result<Vec<BlockV1>, String> {
        let mut blocks = Vec::with_capacity(limit);
        for item in self.db.iter().rev().take(limit) {
            let (_, value) = item.map_err(|e| format!("sled rev iter: {}", e))?;
            blocks.push(deserialize_block(&value)?);
        }
        blocks.reverse();
        Ok(blocks)
    }

    /// O(1) block count from sled metadata — no deserialization needed
    pub fn count_blocks(&self) -> u64 {
        self.db.len() as u64
    }

    /// Stream through all blocks and sum tx fees without allocating a Vec of all blocks.
    /// Uses sled's iterator so only one block is in memory at a time.
    pub fn sum_all_fees(&self) -> Result<f64, String> {
        let mut total: f64 = 0.0;
        for item in self.db.iter() {
            let (_, value) = item.map_err(|e| format!("sled iter: {}", e))?;
            let block = deserialize_block(&value)?;
            for tx in &block.txs {
                total += tx.fee;
            }
        }
        Ok(total)
    }

    /// Expose a raw sled iterator for callers that need to stream blocks
    /// with custom early-exit logic (e.g. tx hash lookup).
    pub fn db_iter(&self) -> sled::Iter {
        self.db.iter()
    }

    /// Public wrapper around the module-private deserialize_block function
    pub fn deserialize_block_pub(&self, bytes: &[u8]) -> Result<BlockV1, String> {
        deserialize_block(bytes)
    }

    /// Reset the chain with a new set of blocks (used for P2P sync when genesis differs)
    pub fn reset_chain(&self, blocks: &[BlockV1]) -> Result<(), String> {
        if blocks.is_empty() {
            return Err("Cannot reset with empty blocks".to_string());
        }

        self.db
            .clear()
            .map_err(|e| format!("sled clear: {}", e))?;

        for block in blocks {
            let key = height_key(block.header.height);
            let value = serialize_block(block)?;
            self.db
                .insert(key, value)
                .map_err(|e| format!("sled insert: {}", e))?;
        }
        self.db.flush().map_err(|e| format!("sled flush: {}", e))?;
        Ok(())
    }

    fn create_genesis_block(&self) -> BlockV1 {
        let header = BlockHeaderV1 {
            version: 1,
            chain_id: self.chain.chain_id.clone(),
            height: 0,
            time: self.chain.genesis_time,
            prev_hash: "0".to_string(),
            tx_hash: compute_tx_hash(&[]),
            proposer_pub_key: "genesis".to_string(),
        };
        let header_bytes = serde_json::to_vec(&header).unwrap_or_default();
        let proposer_sig = hex::encode(sha256(&header_bytes));
        let hash = compute_block_hash(&header_bytes, &proposer_sig);
        BlockV1 {
            version: 1,
            header,
            txs: vec![],
            proposer_sig,
            hash,
        }
    }

    /// Migrate from legacy JSONL file format to sled
    fn migrate_from_jsonl(&self, legacy_path: &Path) -> Result<(), String> {
        eprintln!("[chain] Migrating from JSONL to sled DB...");
        let raw = fs::read_to_string(legacy_path)
            .map_err(|e| format!("read legacy JSONL: {}", e))?;

        let mut count = 0u64;
        for line in raw.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let block: BlockV1 =
                serde_json::from_str(line).map_err(|e| format!("parse legacy block: {}", e))?;
            let key = height_key(block.header.height);
            let value = serialize_block(&block)?;
            self.db
                .insert(key, value)
                .map_err(|e| format!("sled insert: {}", e))?;
            count += 1;
        }
        self.db.flush().map_err(|e| format!("sled flush: {}", e))?;

        let backup_path = legacy_path.with_extension("jsonl.bak");
        fs::rename(legacy_path, &backup_path)
            .map_err(|e| format!("rename legacy file: {}", e))?;

        let tip_path = legacy_path.with_file_name("tip.json");
        if tip_path.exists() {
            let _ = fs::remove_file(&tip_path);
        }

        eprintln!("[chain] Migrated {} blocks from JSONL to sled", count);
        Ok(())
    }
}
