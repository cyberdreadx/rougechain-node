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
    /// Base payout tx hash, recorded once the withdrawal was verified as paid on L1.
    /// `None` while pending; set by `mark_fulfilled` after on-chain verification.
    #[serde(default)]
    pub payout_tx_hash: Option<String>,
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
        let tx_id_for_rollback = tx_id.clone();
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
                payout_tx_hash: None,
            });
        }
        // ATOMIC: if the durable write fails, the in-memory list must not claim a record the
        // disk does not have (otherwise a later idempotent rebuild would dedup against memory
        // and never re-persist). Roll the push back and surface the error.
        if let Err(e) = self.persist() {
            if let Ok(mut pending) = self.pending.write() {
                if pending.last().map(|w| w.tx_id == tx_id_for_rollback).unwrap_or(false) { pending.pop(); }
            }
            return Err(e);
        }
        Ok(())
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

    /// Non-terminal withdrawals the relayer still needs to act on (Pending or Failed-retry).
    /// Fulfilled/Refunded records are kept for audit but hidden from the relayer poll so they
    /// are never re-processed.
    pub fn list_pending(&self) -> Result<Vec<PendingWithdrawal>, String> {
        let pending = self.pending.read().map_err(|_| "lock")?;
        Ok(pending
            .iter()
            .filter(|w| !matches!(w.status, WithdrawalStatus::Fulfilled | WithdrawalStatus::Refunded))
            .cloned()
            .collect())
    }

    /// Mark a withdrawal Fulfilled and record the verified Base payout tx hash. The record is
    /// KEPT (not deleted) so the payout is auditable and cannot be silently re-created.
    /// Returns Ok(false) if the tx_id is unknown or was already terminal.
    pub fn mark_fulfilled(&self, tx_id: &str, payout_tx_hash: &str) -> Result<bool, String> {
        let changed = {
            let mut pending = self.pending.write().map_err(|_| "lock")?;
            match pending.iter_mut().find(|w| w.tx_id == tx_id) {
                Some(w) if !matches!(w.status, WithdrawalStatus::Fulfilled | WithdrawalStatus::Refunded) => {
                    w.status = WithdrawalStatus::Fulfilled;
                    w.payout_tx_hash = Some(payout_tx_hash.to_string());
                    w.updated_at = chrono::Utc::now().timestamp_millis();
                    true
                }
                _ => false,
            }
        };
        if changed {
            self.persist()?;
        }
        Ok(changed)
    }

    /// Like `mark_fulfilled`, but refuses a payout tx hash that already settled a DIFFERENT
    /// withdrawal — checked under the same write lock, so two concurrent fulfils cannot both pass.
    /// For payout rails whose on-chain payment carries no withdrawal id (Bitcoin), this is what
    /// stops one payment from settling two withdrawals (e.g. two equal withdrawals to one address).
    pub fn mark_fulfilled_unique_payout(&self, tx_id: &str, payout_tx_hash: &str) -> Result<bool, String> {
        let payout = payout_tx_hash.trim().to_ascii_lowercase();
        if payout.is_empty() {
            return Err("empty payout tx hash".to_string());
        }
        let changed = {
            let mut pending = self.pending.write().map_err(|_| "lock")?;
            if let Some(other) = pending.iter().find(|w| {
                w.tx_id != tx_id
                    && w.payout_tx_hash.as_deref().map(|h| h.trim().eq_ignore_ascii_case(&payout)).unwrap_or(false)
            }) {
                return Err(format!("payout {} already settled withdrawal {}", payout, other.tx_id));
            }
            match pending.iter_mut().find(|w| w.tx_id == tx_id) {
                Some(w) if !matches!(w.status, WithdrawalStatus::Fulfilled | WithdrawalStatus::Refunded) => {
                    w.status = WithdrawalStatus::Fulfilled;
                    w.payout_tx_hash = Some(payout.clone());
                    w.updated_at = chrono::Utc::now().timestamp_millis();
                    true
                }
                _ => false,
            }
        };
        if changed {
            self.persist()?;
        }
        Ok(changed)
    }

    /// Remove a non-terminal withdrawal (refund rollback of a pending/failed row).
    /// A Fulfilled row is NEVER deleted — it holds the audited payout tx hash, so erasing it
    /// would destroy the proof a withdrawal was paid. Callers that hit a fulfilled tx_id get
    /// `Ok(false)` (nothing removed).
    pub fn remove(&self, tx_id: &str) -> Result<bool, String> {
        let mut pending = self.pending.write().map_err(|_| "lock")?;
        let len_before = pending.len();
        pending.retain(|w| w.tx_id != tx_id || matches!(w.status, WithdrawalStatus::Fulfilled));
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

#[cfg(test)]
mod unique_payout_tests {
    use super::*;

    fn store() -> (std::path::PathBuf, BridgeWithdrawStore) {
        let dir = std::env::temp_dir().join(format!(
            "qv-unique-payout-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let s = BridgeWithdrawStore::new(&dir).unwrap();
        (dir, s)
    }
    const DEST: &str = "bc1qvt4r5dazmystwspgp62vh9ve5tutw5av4atjcz";
    const P: &str = "91d306fcedfc15ce8cb8f1c547c5c2d403a20d138a74cc66fbb4a5e104259b84";

    #[test]
    fn one_bitcoin_payment_cannot_settle_two_withdrawals() {
        let (dir, s) = store();
        s.add("wd-a".into(), DEST.into(), 5000, "owner".into(), "qBTC".into()).unwrap();
        s.add("wd-b".into(), DEST.into(), 5000, "owner".into(), "qBTC".into()).unwrap();
        assert_eq!(s.mark_fulfilled_unique_payout("wd-a", P).unwrap(), true);
        // Same payout (any case / whitespace) for the other, identical withdrawal: refused.
        let err = s.mark_fulfilled_unique_payout("wd-b", &format!(" {} ", P.to_uppercase())).unwrap_err();
        assert!(err.contains("already settled withdrawal wd-a"), "{err}");
        assert!(s.list_pending().unwrap().iter().any(|w| w.tx_id == "wd-b"), "wd-b stays pending");
        // Its own payout settles it.
        let q = "a".repeat(64);
        assert_eq!(s.mark_fulfilled_unique_payout("wd-b", &q).unwrap(), true);
        assert!(s.list_pending().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn repeating_the_same_fulfil_is_idempotent_not_an_error() {
        let (dir, s) = store();
        s.add("wd-a".into(), DEST.into(), 5000, "owner".into(), "qBTC".into()).unwrap();
        assert_eq!(s.mark_fulfilled_unique_payout("wd-a", P).unwrap(), true);
        assert_eq!(s.mark_fulfilled_unique_payout("wd-a", P).unwrap(), false, "already fulfilled");
        assert!(s.mark_fulfilled_unique_payout("wd-a", "   ").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
