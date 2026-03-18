// ============================================================================
// nullifier_store — Set of spent nullifiers for double-spend prevention
//
// When a shielded note is consumed (spent), its nullifier is published
// on-chain and recorded here. If a nullifier already exists, the note
// has already been spent and the transaction is rejected.
//
// This is the core mechanism preventing double-spending in shielded txs.
// ============================================================================

use sled::Db;

#[derive(Clone)]
pub struct NullifierStore {
    db: Db,
}

impl NullifierStore {
    pub fn new(data_dir: impl AsRef<std::path::Path>) -> Result<Self, String> {
        let path = data_dir.as_ref().join("shielded-nullifiers-db");
        let db = sled::open(&path).map_err(|e| format!("Failed to open nullifier store: {}", e))?;
        Ok(Self { db })
    }

    /// Check if a nullifier has been spent.
    pub fn is_spent(&self, nullifier_hex: &str) -> Result<bool, String> {
        self.db
            .contains_key(nullifier_hex.as_bytes())
            .map_err(|e| format!("Failed to check nullifier: {}", e))
    }

    /// Mark a nullifier as spent. Returns error if already spent (double-spend).
    pub fn mark_spent(&self, nullifier_hex: &str) -> Result<(), String> {
        // Check first to provide clear double-spend error
        if self.is_spent(nullifier_hex)? {
            return Err(format!(
                "Double-spend detected: nullifier {} already spent",
                &nullifier_hex[..16.min(nullifier_hex.len())]
            ));
        }
        self.db
            .insert(nullifier_hex.as_bytes(), &[1u8])
            .map_err(|e| format!("Failed to insert nullifier: {}", e))?;
        self.db.flush().map_err(|e| format!("Failed to flush: {}", e))?;
        Ok(())
    }

    /// Count total spent nullifiers.
    pub fn count(&self) -> usize {
        self.db.len()
    }
}
