use std::path::Path;
use std::sync::Arc;

use quantum_vault_types::TxReceipt;

/// Persistent store for transaction receipts, keyed by tx hash.
#[derive(Clone)]
pub struct ReceiptStore {
    tree: Arc<sled::Tree>,
}

impl ReceiptStore {
    pub fn new(db: &sled::Db) -> Result<Self, String> {
        let tree = db
            .open_tree("tx_receipts")
            .map_err(|e| format!("open tx_receipts tree: {}", e))?;
        Ok(Self {
            tree: Arc::new(tree),
        })
    }

    /// Store a receipt keyed by its tx hash.
    pub fn store(&self, receipt: &TxReceipt) -> Result<(), String> {
        let key = receipt.tx_hash.as_bytes();
        let value =
            serde_json::to_vec(receipt).map_err(|e| format!("serialize receipt: {}", e))?;
        self.tree
            .insert(key, value)
            .map_err(|e| format!("sled insert receipt: {}", e))?;
        Ok(())
    }

    /// Store a batch of receipts (e.g. all receipts from a block).
    pub fn store_batch(&self, receipts: &[TxReceipt]) -> Result<(), String> {
        for receipt in receipts {
            self.store(receipt)?;
        }
        self.tree
            .flush()
            .map_err(|e| format!("sled flush receipts: {}", e))?;
        Ok(())
    }

    /// Get a receipt by tx hash.
    pub fn get(&self, tx_hash: &str) -> Result<Option<TxReceipt>, String> {
        match self
            .tree
            .get(tx_hash.as_bytes())
            .map_err(|e| format!("sled get receipt: {}", e))?
        {
            Some(value) => {
                let receipt: TxReceipt = serde_json::from_slice(&value)
                    .map_err(|e| format!("deserialize receipt: {}", e))?;
                Ok(Some(receipt))
            }
            None => Ok(None),
        }
    }

    /// Get receipts for all txs in a block (by height prefix scan is not possible,
    /// so we accept a list of tx hashes).
    pub fn get_block_receipts(&self, tx_hashes: &[String]) -> Result<Vec<TxReceipt>, String> {
        let mut receipts = Vec::new();
        for hash in tx_hashes {
            if let Some(r) = self.get(hash)? {
                receipts.push(r);
            }
        }
        Ok(receipts)
    }

    /// Total number of stored receipts.
    pub fn len(&self) -> usize {
        self.tree.len()
    }
}
