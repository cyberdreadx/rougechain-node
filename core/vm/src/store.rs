use serde::{Deserialize, Serialize};
use std::path::Path;

/// Metadata for a deployed contract
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContractMetadata {
    pub address: String,
    pub deployer: String,
    pub code_hash: String,
    pub created_at: u64,
    pub wasm_size: usize,
}

/// An event emitted by a contract during execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContractEvent {
    pub contract_addr: String,
    pub topic: String,
    pub data: String,
    pub block_height: u64,
    pub tx_hash: String,
}

/// Result of a contract call execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContractCallResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub return_data: Option<serde_json::Value>,
    pub gas_used: u64,
    pub events: Vec<ContractEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Storage writes to commit (hex key → hex value)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_writes: Option<std::collections::HashMap<String, String>>,
    /// Storage keys to delete (hex encoded)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_deletes: Option<Vec<String>>,
    /// Balance deltas to apply (address, delta)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balance_deltas: Option<Vec<(String, i128)>>,
}

/// Persistent storage for contracts, their state, and events
#[derive(Clone)]
pub struct ContractStore {
    /// Contract metadata: address → ContractMetadata JSON
    contracts: sled::Tree,
    /// Contract WASM bytecode: address → raw bytes
    code: sled::Tree,
    /// Contract key-value storage: "addr:key" → raw bytes
    state: sled::Tree,
    /// Contract events: sequential ID → ContractEvent JSON
    events: sled::Tree,
    /// Event counter for sequential IDs
    event_counter: sled::Tree,
}

impl ContractStore {
    pub fn new(data_dir: impl AsRef<Path>) -> Result<Self, String> {
        let path = data_dir.as_ref().join("contracts-db");
        let db = sled::open(path).map_err(|e| e.to_string())?;
        let contracts = db.open_tree("contracts").map_err(|e| e.to_string())?;
        let code = db.open_tree("contract-code").map_err(|e| e.to_string())?;
        let state = db.open_tree("contract-state").map_err(|e| e.to_string())?;
        let events = db.open_tree("contract-events").map_err(|e| e.to_string())?;
        let event_counter = db.open_tree("contract-event-counter").map_err(|e| e.to_string())?;
        Ok(Self { contracts, code, state, events, event_counter })
    }

    /// Deploy a new contract
    pub fn deploy(
        &self,
        addr: &str,
        metadata: &ContractMetadata,
        wasm_bytes: &[u8],
    ) -> Result<(), String> {
        let meta_json = serde_json::to_vec(metadata).map_err(|e| e.to_string())?;
        self.contracts.insert(addr, meta_json).map_err(|e| e.to_string())?;
        self.code.insert(addr, wasm_bytes).map_err(|e| e.to_string())?;
        self.contracts.flush().map_err(|e| e.to_string())?;
        self.code.flush().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Get contract metadata
    pub fn get_contract(&self, addr: &str) -> Result<Option<ContractMetadata>, String> {
        match self.contracts.get(addr).map_err(|e| e.to_string())? {
            Some(bytes) => {
                let meta: ContractMetadata =
                    serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                Ok(Some(meta))
            }
            None => Ok(None),
        }
    }

    /// Get contract WASM bytecode
    pub fn get_wasm(&self, addr: &str) -> Result<Option<Vec<u8>>, String> {
        Ok(self.code.get(addr).map_err(|e| e.to_string())?.map(|v| v.to_vec()))
    }

    /// Read a value from contract storage
    pub fn storage_read(&self, addr: &str, key: &[u8]) -> Result<Option<Vec<u8>>, String> {
        let full_key = format!("{}:{}", addr, hex::encode(key));
        Ok(self
            .state
            .get(full_key.as_bytes())
            .map_err(|e| e.to_string())?
            .map(|v| v.to_vec()))
    }

    /// Write a value to contract storage
    pub fn storage_write(&self, addr: &str, key: &[u8], value: &[u8]) -> Result<(), String> {
        let full_key = format!("{}:{}", addr, hex::encode(key));
        self.state
            .insert(full_key.as_bytes(), value)
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Delete a value from contract storage
    pub fn storage_delete(&self, addr: &str, key: &[u8]) -> Result<(), String> {
        let full_key = format!("{}:{}", addr, hex::encode(key));
        self.state
            .remove(full_key.as_bytes())
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Flush all pending state writes
    pub fn flush_state(&self) -> Result<(), String> {
        self.state.flush().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Append events to the event log
    pub fn append_events(&self, events: &[ContractEvent]) -> Result<(), String> {
        for event in events {
            let id = self
                .event_counter
                .update_and_fetch("counter", |old| {
                    let n = old
                        .map(|b| {
                            let mut arr = [0u8; 8];
                            arr.copy_from_slice(&b[..8.min(b.len())]);
                            u64::from_be_bytes(arr)
                        })
                        .unwrap_or(0)
                        + 1;
                    Some(n.to_be_bytes().to_vec())
                })
                .map_err(|e| e.to_string())?
                .map(|b| {
                    let mut arr = [0u8; 8];
                    arr.copy_from_slice(&b[..8.min(b.len())]);
                    u64::from_be_bytes(arr)
                })
                .unwrap_or(1);
            let key = format!("{}:{:016x}", event.contract_addr, id);
            let val = serde_json::to_vec(event).map_err(|e| e.to_string())?;
            self.events.insert(key.as_bytes(), val).map_err(|e| e.to_string())?;
        }
        self.events.flush().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Get events for a contract (most recent first)
    pub fn get_events(&self, addr: &str, limit: usize) -> Result<Vec<ContractEvent>, String> {
        let prefix = format!("{}:", addr);
        let mut out = Vec::new();
        for item in self.events.scan_prefix(prefix.as_bytes()).rev() {
            let (_, val) = item.map_err(|e| e.to_string())?;
            if let Ok(ev) = serde_json::from_slice::<ContractEvent>(&val) {
                out.push(ev);
                if out.len() >= limit {
                    break;
                }
            }
        }
        Ok(out)
    }

    /// List all deployed contracts
    pub fn list_contracts(&self) -> Result<Vec<ContractMetadata>, String> {
        let mut out = Vec::new();
        for item in self.contracts.iter() {
            let (_, val) = item.map_err(|e| e.to_string())?;
            if let Ok(meta) = serde_json::from_slice::<ContractMetadata>(&val) {
                out.push(meta);
            }
        }
        Ok(out)
    }
}
