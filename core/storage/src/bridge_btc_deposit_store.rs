//! Persistent store for BTC HD deposit addresses.
//!
//! The relayer derives a pool of receive addresses from its HD seed and registers them here; the
//! daemon assigns one to each user and binds it to their RougeChain recipient. The daemon is
//! **watch-only** — it never derives or holds any Bitcoin key. Assignments are stable: a recipient
//! always gets the same deposit address, which keeps the watch set bounded.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PoolEntry {
    pub index: u32,
    pub address: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Assignment {
    pub address: String,
    pub recipient: String,
    pub index: u32,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct State {
    /// Unassigned addresses the relayer has pre-derived + registered, handed out FIFO.
    pool: VecDeque<PoolEntry>,
    assignments: Vec<Assignment>,
    #[serde(default)]
    by_recipient: HashMap<String, String>, // recipient -> address
    #[serde(default)]
    by_address: HashMap<String, String>, // address -> recipient
}

pub struct BtcDepositStore {
    path: PathBuf,
    state: Mutex<State>,
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

impl BtcDepositStore {
    pub fn new(data_dir: impl AsRef<Path>) -> Result<Self, String> {
        let path = data_dir.as_ref().join("btc_deposit_addresses.json");
        let state = if path.exists() {
            let data = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            serde_json::from_str(&data).unwrap_or_default()
        } else {
            State::default()
        };
        Ok(Self { path, state: Mutex::new(state) })
    }

    /// Relayer registers freshly-derived pool addresses (idempotent — skips any address already
    /// pooled or assigned). Returns how many were newly added.
    pub fn add_to_pool(&self, entries: Vec<PoolEntry>) -> Result<usize, String> {
        let mut st = self.state.lock().map_err(|_| "btc deposit lock".to_string())?;
        let mut added = 0;
        for e in entries {
            if e.address.is_empty() {
                continue;
            }
            let known =
                st.by_address.contains_key(&e.address) || st.pool.iter().any(|p| p.address == e.address);
            if !known {
                st.pool.push_back(e);
                added += 1;
            }
        }
        if added > 0 {
            Self::persist(&self.path, &st)?;
        }
        Ok(added)
    }

    /// Assign a deposit address to a recipient. Stable — a recipient always gets the same address.
    /// Returns Ok(None) when the pool is empty (the relayer must top it up).
    pub fn assign(&self, recipient: &str) -> Result<Option<String>, String> {
        let mut st = self.state.lock().map_err(|_| "btc deposit lock".to_string())?;
        if let Some(addr) = st.by_recipient.get(recipient) {
            return Ok(Some(addr.clone()));
        }
        let entry = match st.pool.pop_front() {
            Some(e) => e,
            None => return Ok(None),
        };
        st.by_recipient.insert(recipient.to_string(), entry.address.clone());
        st.by_address.insert(entry.address.clone(), recipient.to_string());
        st.assignments.push(Assignment {
            address: entry.address.clone(),
            recipient: recipient.to_string(),
            index: entry.index,
            created_at: now(),
        });
        Self::persist(&self.path, &st)?;
        Ok(Some(entry.address))
    }

    /// Every assigned (address, recipient) — for the watcher and the relayer's sweep.
    pub fn list_assignments(&self) -> Result<Vec<Assignment>, String> {
        let st = self.state.lock().map_err(|_| "btc deposit lock".to_string())?;
        Ok(st.assignments.clone())
    }

    /// The recipient bound to an address, if any.
    pub fn recipient_for(&self, address: &str) -> Result<Option<String>, String> {
        let st = self.state.lock().map_err(|_| "btc deposit lock".to_string())?;
        Ok(st.by_address.get(address).cloned())
    }

    pub fn pool_remaining(&self) -> usize {
        self.state.lock().map(|st| st.pool.len()).unwrap_or(0)
    }

    /// Highest derivation index known (across pool + assignments), so the relayer can derive the
    /// next pool addresses without tracking its own counter. None when nothing is registered yet.
    pub fn max_index(&self) -> Option<u32> {
        let st = self.state.lock().ok()?;
        st.pool
            .iter()
            .map(|p| p.index)
            .chain(st.assignments.iter().map(|a| a.index))
            .max()
    }

    /// Durable, crash-atomic write: temp file → fsync → rename → fsync dir.
    fn persist(path: &Path, st: &State) -> Result<(), String> {
        let data = serde_json::to_string_pretty(st).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        {
            use std::io::Write;
            let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
            f.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
            f.sync_all().map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        if let Some(dir) = path.parent() {
            if let Ok(d) = std::fs::File::open(dir) {
                let _ = d.sync_all();
            }
        }
        Ok(())
    }
}
