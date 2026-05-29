// Persisted storage of bridge withdrawals (qETH/XRGE → L1 release) for the operator to fulfill.
// Uses sync primitives so the node can call it from apply_balance_block.
use std::path::Path;
use std::sync::RwLock;

/// Lifecycle of a withdrawal as tracked by the relayer.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WithdrawalStatus {
    /// Awaiting (or being retried by) the relayer.
    Pending,
    /// Released on L1 and removed from the pending set (terminal — rarely persisted).
    Fulfilled,
    /// Relayer attempts have been failing; eligible for alerting / refund.
    Failed,
    /// Tokens were minted back to the owner after the release could not be completed.
    Refunded,
}

impl Default for WithdrawalStatus {
    fn default() -> Self {
        WithdrawalStatus::Pending
    }
}

fn default_token_symbol() -> String {
    "qETH".to_string()
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct PendingWithdrawal {
    pub tx_id: String,
    pub evm_address: String,
    pub amount_units: u64,
    pub created_at: i64,
    /// RougeChain L1 public key of the withdrawer — the refund recipient.
    /// Defaulted empty for records written before this field existed.
    #[serde(default)]
    pub owner_pubkey: String,
    /// Token being withdrawn ("XRGE", "qETH", "qUSDC", ...). Replaces the legacy
    /// "xrge:" tx_id prefix as the authoritative way to distinguish withdrawal types.
    #[serde(default = "default_token_symbol")]
    pub token_symbol: String,
    #[serde(default)]
    pub status: WithdrawalStatus,
    /// Number of release attempts the relayer has reported as failed.
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub updated_at: i64,
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

    pub fn add(
        &self,
        tx_id: String,
        evm_address: String,
        amount_units: u64,
        owner_pubkey: String,
        token_symbol: String,
    ) -> Result<(), String> {
        {
            let mut pending = self.pending.write().map_err(|_| "lock")?;
            // Idempotent: a re-applied block must not duplicate a withdrawal.
            if pending.iter().any(|w| w.tx_id == tx_id) {
                return Ok(());
            }
            let now = chrono::Utc::now().timestamp_millis();
            pending.push(PendingWithdrawal {
                tx_id,
                evm_address,
                amount_units,
                created_at: now,
                owner_pubkey,
                token_symbol,
                status: WithdrawalStatus::Pending,
                attempts: 0,
                last_error: None,
                updated_at: now,
            });
        }
        self.persist()
    }

    pub fn list(&self) -> Result<Vec<PendingWithdrawal>, String> {
        let pending = self.pending.read().map_err(|_| "lock")?;
        Ok(pending.clone())
    }

    pub fn get(&self, tx_id: &str) -> Result<Option<PendingWithdrawal>, String> {
        let pending = self.pending.read().map_err(|_| "lock")?;
        Ok(pending.iter().find(|w| w.tx_id == tx_id).cloned())
    }

    /// Record a failed release attempt: bumps the attempt counter, stores the error,
    /// and flags the withdrawal as Failed. Returns the new attempt count.
    pub fn record_attempt(&self, tx_id: &str, error: Option<String>) -> Result<u32, String> {
        let attempts = {
            let mut pending = self.pending.write().map_err(|_| "lock")?;
            let w = pending
                .iter_mut()
                .find(|w| w.tx_id == tx_id)
                .ok_or_else(|| "withdrawal not found".to_string())?;
            w.attempts = w.attempts.saturating_add(1);
            w.last_error = error;
            w.status = WithdrawalStatus::Failed;
            w.updated_at = chrono::Utc::now().timestamp_millis();
            w.attempts
        };
        self.persist()?;
        Ok(attempts)
    }

    pub fn set_status(&self, tx_id: &str, status: WithdrawalStatus) -> Result<bool, String> {
        let changed = {
            let mut pending = self.pending.write().map_err(|_| "lock")?;
            match pending.iter_mut().find(|w| w.tx_id == tx_id) {
                Some(w) => {
                    w.status = status;
                    w.updated_at = chrono::Utc::now().timestamp_millis();
                    true
                }
                None => false,
            }
        };
        if changed {
            self.persist()?;
        }
        Ok(changed)
    }

    /// Remove a fulfilled/refunded withdrawal (called by relayer after sending L1, or after refund).
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
