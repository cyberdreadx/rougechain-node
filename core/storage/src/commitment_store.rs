// ============================================================================
// commitment_store — Append-only set of shielded note commitments
//
// Each shielded note is represented by a 32-byte commitment hash.
// This store tracks all commitments ever created on-chain.
// commitments are never removed (only their nullifiers are published
// when they are consumed).
// ============================================================================

use sled::Db;

#[derive(Clone)]
pub struct CommitmentStore {
    db: Db,
}

impl CommitmentStore {
    pub fn new(data_dir: impl AsRef<std::path::Path>) -> Result<Self, String> {
        let path = data_dir.as_ref().join("shielded-commitments-db");
        let db = sled::open(&path).map_err(|e| format!("Failed to open commitment store: {}", e))?;
        Ok(Self { db })
    }

    /// Insert a new commitment (hex-encoded 32-byte hash).
    pub fn insert(&self, commitment_hex: &str) -> Result<(), String> {
        self.db
            .insert(commitment_hex.as_bytes(), &[1u8])
            .map_err(|e| format!("Failed to insert commitment: {}", e))?;
        self.db.flush().map_err(|e| format!("Failed to flush: {}", e))?;
        Ok(())
    }

    /// Check if a commitment exists.
    pub fn contains(&self, commitment_hex: &str) -> Result<bool, String> {
        self.db
            .contains_key(commitment_hex.as_bytes())
            .map_err(|e| format!("Failed to check commitment: {}", e))
    }

    /// Count total commitments.
    pub fn count(&self) -> usize {
        self.db.len()
    }
}
