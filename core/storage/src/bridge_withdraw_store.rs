// Persisted storage of bridge withdrawals (qETH → ETH) for the operator to fulfill.
// Uses sync primitives so the node can call it from apply_balance_block.
use std::path::Path;
use std::sync::RwLock;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct PendingWithdrawal {
    pub tx_id: String,
    pub evm_address: String,
    pub amount_units: u64,
    pub created_at: i64,
}

pub struct BridgeWithdrawStore {
    path: std::path::PathBuf,
    pending: RwLock<Vec<PendingWithdrawal>>,
}

impl BridgeWithdrawStore {
    pub fn new(data_dir: impl AsRef<Path>) -> Result<Self, String> {
        let path = data_dir.as_ref().join("bridge_withdrawals.json");
        let pending = if path.exists() {
            let data = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            serde_json::from_str(&data).unwrap_or_default()
        } else {
            Vec::new()
        };
        Ok(Self {
            path: path.to_path_buf(),
            pending: RwLock::new(pending),
        })
    }

    pub fn add(&self, tx_id: String, evm_address: String, amount_units: u64) -> Result<(), String> {
        {
            let mut pending = self.pending.write().map_err(|_| "lock")?;
            pending.push(PendingWithdrawal {
                tx_id: tx_id.clone(),
                evm_address,
                amount_units,
                created_at: chrono::Utc::now().timestamp_millis(),
            });
        }
        self.persist()
    }

    pub fn list(&self) -> Result<Vec<PendingWithdrawal>, String> {
        let pending = self.pending.read().map_err(|_| "lock")?;
        Ok(pending.clone())
    }

    /// Remove a fulfilled withdrawal (called by relayer after sending ETH)
    pub fn remove(&self, tx_id: &str) -> Result<bool, String> {
        let mut pending = self.pending.write().map_err(|_| "lock")?;
        let len_before = pending.len();
        pending.retain(|w| w.tx_id != tx_id);
        let removed = pending.len() < len_before;
        drop(pending);
        if removed {
            self.persist()?;
        }
        Ok(removed)
    }

    fn persist(&self) -> Result<(), String> {
        let pending = self.pending.read().map_err(|_| "lock")?;
        let data = serde_json::to_string_pretty(pending.as_slice()).map_err(|e| e.to_string())?;
        drop(pending);
        std::fs::write(&self.path, data).map_err(|e| e.to_string())
    }
}
