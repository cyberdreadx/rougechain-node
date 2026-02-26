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

    async fn persist(&self) -> Result<(), String> {
        let claimed = self.claimed.read().await;
        let list: Vec<&String> = claimed.iter().collect();
        let list: Vec<String> = list.into_iter().cloned().collect();
        drop(claimed);
        let data = serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?;
        tokio::task::spawn_blocking({
            let path = self.path.clone();
            move || std::fs::write(path, data)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
    }
}
