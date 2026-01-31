use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use quantum_vault_crypto::sha256;
use quantum_vault_types::{compute_block_hash, compute_tx_hash, BlockHeaderV1, BlockV1, ChainConfig};

#[derive(Clone)]
pub struct ChainStore {
    data_dir: PathBuf,
    chain_path: PathBuf,
    tip_path: PathBuf,
    chain: ChainConfig,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Tip {
    pub height: u64,
    pub hash: String,
}

impl ChainStore {
    pub fn new(data_dir: impl AsRef<Path>, chain: ChainConfig) -> Self {
        let data_dir = data_dir.as_ref().to_path_buf();
        Self {
            chain_path: data_dir.join("chain.jsonl"),
            tip_path: data_dir.join("tip.json"),
            data_dir,
            chain,
        }
    }

    pub fn init(&self) -> Result<(), String> {
        fs::create_dir_all(&self.data_dir).map_err(|e| e.to_string())?;
        if !self.chain_path.exists() {
            let genesis = self.create_genesis_block();
            self.append_block(&genesis)?;
        }
        if !self.tip_path.exists() {
            let tip = self.get_tip()?;
            self.write_tip(&tip)?;
        }
        Ok(())
    }

    pub fn append_block(&self, block: &BlockV1) -> Result<(), String> {
        let line = serde_json::to_string(block).map_err(|e| e.to_string())?;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.chain_path)
            .map_err(|e| e.to_string())?;
        writeln!(file, "{line}").map_err(|e| e.to_string())?;
        self.write_tip(&Tip { height: block.header.height, hash: block.hash.clone() })?;
        Ok(())
    }

    pub fn get_tip(&self) -> Result<Tip, String> {
        if self.tip_path.exists() {
            let raw = fs::read_to_string(&self.tip_path).map_err(|e| e.to_string())?;
            let tip = serde_json::from_str::<Tip>(&raw).map_err(|e| e.to_string())?;
            return Ok(tip);
        }
        let blocks = self.get_all_blocks()?;
        if let Some(block) = blocks.last() {
            return Ok(Tip { height: block.header.height, hash: block.hash.clone() });
        }
        Ok(Tip { height: 0, hash: "0".to_string() })
    }

    pub fn get_all_blocks(&self) -> Result<Vec<BlockV1>, String> {
        if !self.chain_path.exists() {
            return Ok(vec![]);
        }
        let raw = fs::read_to_string(&self.chain_path).map_err(|e| e.to_string())?;
        let mut blocks = Vec::new();
        for line in raw.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let block = serde_json::from_str::<BlockV1>(line).map_err(|e| e.to_string())?;
            blocks.push(block);
        }
        Ok(blocks)
    }

    pub fn get_block(&self, height: u64) -> Result<Option<BlockV1>, String> {
        let blocks = self.get_all_blocks()?;
        Ok(blocks.into_iter().find(|b| b.header.height == height))
    }

    pub fn scan_blocks<F>(&self, mut callback: F, start_height: u64) -> Result<(), String>
    where
        F: FnMut(BlockV1) -> Result<(), String>,
    {
        let blocks = self.get_all_blocks()?;
        for block in blocks {
            if block.header.height < start_height {
                continue;
            }
            callback(block)?;
        }
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

    fn write_tip(&self, tip: &Tip) -> Result<(), String> {
        let raw = serde_json::to_string(tip).map_err(|e| e.to_string())?;
        fs::write(&self.tip_path, raw).map_err(|e| e.to_string())
    }

    /// Reset the chain with a new set of blocks (used for P2P sync when genesis differs)
    pub fn reset_chain(&self, blocks: &[BlockV1]) -> Result<(), String> {
        if blocks.is_empty() {
            return Err("Cannot reset with empty blocks".to_string());
        }
        
        // Remove existing chain file
        if self.chain_path.exists() {
            fs::remove_file(&self.chain_path).map_err(|e| e.to_string())?;
        }
        
        // Write all blocks
        let mut file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .open(&self.chain_path)
            .map_err(|e| e.to_string())?;
        
        for block in blocks {
            let line = serde_json::to_string(block).map_err(|e| e.to_string())?;
            writeln!(file, "{line}").map_err(|e| e.to_string())?;
        }
        
        // Update tip
        if let Some(last) = blocks.last() {
            self.write_tip(&Tip { height: last.header.height, hash: last.hash.clone() })?;
        }
        
        Ok(())
    }
}
