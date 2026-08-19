// Persisted storage of claimed bridge transaction hashes to prevent replay after restart.
use std::path::Path;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Clone)]
pub struct BridgeClaimStore {
    path: std::path::PathBuf,
    claimed: Arc<RwLock<std::collections::HashSet<String>>>,
}

impl BridgeClaimStore {
    pub fn new(data_dir: impl AsRef<Path>) -> Result<Self, String> {
        let path = data_dir.as_ref().join("bridge_claimed.json");
        let claimed = if path.exists() {
            let data = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let list: Vec<String> = serde_json::from_str(&data).unwrap_or_default();
            list.into_iter().collect()
        } else {
            std::collections::HashSet::new()
        };
        Ok(Self {
            path: path.to_path_buf(),
            claimed: Arc::new(RwLock::new(claimed)),
        })
    }

    pub async fn contains(&self, tx_hash: &str) -> bool {
        let claimed = self.claimed.read().await;
        claimed.contains(tx_hash)
    }

    pub async fn insert(&self, tx_hash: String) -> Result<(), String> {
        {
            let mut claimed = self.claimed.write().await;
            claimed.insert(tx_hash.clone());
        }
        self.persist().await
    }

    /// Atomically reserve a claim key: returns `Ok(true)` if it was newly inserted, or
    /// `Ok(false)` if it was already present. The check-and-insert happens under a single
    /// write lock, so two concurrent claims for the same tx hash cannot both observe it as
    /// absent and both mint (the non-atomic `contains()`-then-`insert()` pattern could).
    /// Only persists when a new key was actually added.
    pub async fn insert_if_absent(&self, tx_hash: String) -> Result<bool, String> {
        let newly = {
            let mut claimed = self.claimed.write().await;
            claimed.insert(tx_hash) // HashSet::insert returns true if the value was not present
        };
        if newly {
            self.persist().await?;
        }
        Ok(newly)
    }

    /// Release a previously reserved key — used to roll back a refund reservation
    /// when the subsequent mint submission fails, so the refund can be retried.
    pub async fn remove(&self, tx_hash: &str) -> Result<(), String> {
        {
            let mut claimed = self.claimed.write().await;
            claimed.remove(tx_hash);
        }
        self.persist().await
    }

    /// Durable, crash-atomic write: serialize to a temp file, fsync it, then rename over
    /// the real file (rename is atomic on the same filesystem) and fsync the directory.
    /// A bare `fs::write` could leave a truncated/lost file after a crash mid-write, which
    /// for a replay-nullifier set means a claimed tx hash could reappear as unclaimed on
    /// restart (fail-open = double-mint). This persists BEFORE the caller mints, so the
    /// only crash outcome is fail-closed (a durably-reserved key with no mint), never a
    /// lost nullifier.
    async fn persist(&self) -> Result<(), String> {
        let claimed = self.claimed.read().await;
        let list: Vec<String> = claimed.iter().cloned().collect();
        drop(claimed);
        let data = serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?;
        let path = self.path.clone();
        tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            use std::io::Write;
            let tmp = path.with_extension("json.tmp");
            {
                let mut f = std::fs::File::create(&tmp)?;
                f.write_all(data.as_bytes())?;
                f.sync_all()?; // fsync the file contents
            }
            std::fs::rename(&tmp, &path)?; // atomic replace
            if let Some(dir) = path.parent() {
                if let Ok(d) = std::fs::File::open(dir) {
                    let _ = d.sync_all(); // fsync the dir so the rename is durable
                }
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
    }
}
