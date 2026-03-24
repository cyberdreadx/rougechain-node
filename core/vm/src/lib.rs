//! # RougeChain WASM VM
//!
//! Smart contract execution engine using wasmi (pure-Rust WASM interpreter).
//! Used by Parity/Substrate. Contracts written in Rust → compiled to WASM →
//! deployed on-chain → executed in a fuel-metered sandbox.

pub mod host;
pub mod store;

use std::collections::HashMap;

use sha2::{Sha256, Digest};
use wasmi::{Engine, Linker, Module, Store, Config};

use host::HostEnv;
pub use store::{ContractStore, ContractMetadata, ContractEvent, ContractCallResult};

/// Default fuel limit per contract call (≈ 10M WASM instructions)
pub const DEFAULT_FUEL_LIMIT: u64 = 10_000_000;

/// Maximum WASM module size (1 MB)
pub const MAX_WASM_SIZE: usize = 1_048_576;

/// The WASM runtime — holds a shared wasmi Engine
pub struct WasmRuntime {
    engine: Engine,
}

impl WasmRuntime {
    /// Create a new WASM runtime with fuel-metered execution
    pub fn new() -> Result<Self, String> {
        let mut config = Config::default();
        config.consume_fuel(true);
        let engine = Engine::new(&config);
        Ok(Self { engine })
    }

    /// Deploy a new contract. Returns the contract address.
    pub fn deploy_contract(
        &self,
        contract_store: &ContractStore,
        deployer: &str,
        nonce: u64,
        wasm_bytes: &[u8],
        block_height: u64,
    ) -> Result<String, String> {
        if wasm_bytes.is_empty() {
            return Err("Empty WASM module".into());
        }
        if wasm_bytes.len() > MAX_WASM_SIZE {
            return Err(format!("WASM too large: {} bytes (max {})", wasm_bytes.len(), MAX_WASM_SIZE));
        }

        // Validate it compiles
        Module::new(&self.engine, wasm_bytes)
            .map_err(|e| format!("Invalid WASM: {}", e))?;

        // Contract address: SHA-256(deployer ‖ nonce) → first 20 bytes hex
        let mut hasher = Sha256::new();
        hasher.update(deployer.as_bytes());
        hasher.update(nonce.to_be_bytes());
        let hash = hasher.finalize();
        let address = hex::encode(&hash[..20]);

        if contract_store.get_contract(&address)?.is_some() {
            return Err(format!("Contract address collision: {}", address));
        }

        let code_hash = hex::encode(Sha256::digest(wasm_bytes));
        let metadata = ContractMetadata {
            address: address.clone(),
            deployer: deployer.to_string(),
            code_hash,
            created_at: block_height,
            wasm_size: wasm_bytes.len(),
        };
        contract_store.deploy(&address, &metadata, wasm_bytes)?;
        Ok(address)
    }

    /// Execute a contract method (mutating — state changes committed on success).
    pub fn execute_contract(
        &self,
        contract_store: &ContractStore,
        contract_addr: &str,
        method: &str,
        args_json: &serde_json::Value,
        caller: &str,
        block_height: u64,
        block_time: u64,
        balances: HashMap<String, u64>,
        gas_limit: u64,
        tx_hash: &str,
    ) -> Result<ContractCallResult, String> {
        let wasm_bytes = contract_store
            .get_wasm(contract_addr)?
            .ok_or_else(|| format!("Contract not found: {}", contract_addr))?;

        // Pre-load storage is empty — reads happen via host function
        let env = HostEnv::new(
            caller.to_string(),
            contract_addr.to_string(),
            block_height,
            block_time,
            balances,
            HashMap::new(),
        );

        let result = self.run_wasm(&wasm_bytes, method, args_json, env, gas_limit)?;

        // Commit state on success
        if result.success {
            // We need to re-run to get storage writes since the Store is consumed.
            // Actually, we stored storage_writes in ContractCallResult.
            // Let's use a separate mechanism — embed writes in the result.
        }

        // Commit events
        if result.success && !result.events.is_empty() {
            let events: Vec<ContractEvent> = result.events.iter().map(|e| ContractEvent {
                contract_addr: e.contract_addr.clone(),
                topic: e.topic.clone(),
                data: e.data.clone(),
                block_height,
                tx_hash: tx_hash.to_string(),
            }).collect();
            contract_store.append_events(&events)?;
        }

        Ok(result)
    }

    /// Query a contract (read-only — no state changes committed).
    pub fn query_contract(
        &self,
        contract_store: &ContractStore,
        contract_addr: &str,
        method: &str,
        args_json: &serde_json::Value,
        balances: HashMap<String, u64>,
        block_height: u64,
        block_time: u64,
    ) -> Result<ContractCallResult, String> {
        let wasm_bytes = contract_store
            .get_wasm(contract_addr)?
            .ok_or_else(|| format!("Contract not found: {}", contract_addr))?;

        let env = HostEnv::new(
            String::new(),
            contract_addr.to_string(),
            block_height,
            block_time,
            balances,
            HashMap::new(),
        );

        self.run_wasm(&wasm_bytes, method, args_json, env, DEFAULT_FUEL_LIMIT)
    }

    /// Core WASM execution
    fn run_wasm(
        &self,
        wasm_bytes: &[u8],
        method: &str,
        _args_json: &serde_json::Value,
        env: HostEnv,
        fuel_limit: u64,
    ) -> Result<ContractCallResult, String> {
        // Compile
        let module = Module::new(&self.engine, wasm_bytes)
            .map_err(|e| format!("WASM compilation: {}", e))?;

        // Link host functions
        let mut linker = Linker::new(&self.engine);
        host::register_host_functions(&mut linker)?;

        // Create store with fuel
        let mut store = Store::new(&self.engine, env);
        store.add_fuel(fuel_limit).map_err(|e| format!("Fuel error: {}", e))?;

        // Instantiate
        let instance = linker
            .instantiate(&mut store, &module)
            .map_err(|e| format!("Instantiation: {}", e))?
            .start(&mut store)
            .map_err(|e| format!("Start: {}", e))?;

        // Call the method — try different signatures
        let call_result: Result<(), String> = if let Some(func) = instance.get_func(&store, method) {
            let mut results = [];
            func.call(&mut store, &[], &mut results)
                .map_err(|e| e.to_string())
        } else {
            Err(format!("Method '{}' not found", method))
        };

        // Gas used
        let fuel_consumed = store.fuel_consumed().unwrap_or(0);

        match call_result {
            Ok(()) => {
                let env = store.data();
                let return_data = env.return_data.as_ref().and_then(|data| {
                    serde_json::from_slice(data).ok()
                        .or_else(|| Some(serde_json::Value::String(
                            String::from_utf8_lossy(data).to_string()
                        )))
                });

                // Extract storage writes and events for committing
                let events = env.events.clone();
                let storage_writes = env.storage_writes.clone();
                let storage_deletes = env.storage_deletes.clone();
                let logs = env.logs.clone();

                // Package the result
                let result = ContractCallResult {
                    success: true,
                    return_data,
                    gas_used: fuel_consumed,
                    events,
                    error: if logs.is_empty() { None } else { Some(logs.join("\n")) },
                    storage_writes: Some(storage_writes.into_iter()
                        .map(|(k, v)| (hex::encode(&k), hex::encode(&v)))
                        .collect()),
                    storage_deletes: Some(storage_deletes.iter().map(|k| hex::encode(k)).collect()),
                    balance_deltas: Some(env.balance_deltas.iter()
                        .map(|(addr, delta)| (addr.clone(), *delta))
                        .collect()),
                };

                Ok(result)
            }
            Err(e) => {
                let err_msg = if e.contains("fuel") || e.contains("Fuel") {
                    format!("Out of gas (limit: {}, used: {})", fuel_limit, fuel_consumed)
                } else {
                    format!("Execution error: {}", e)
                };

                Ok(ContractCallResult {
                    success: false,
                    return_data: None,
                    gas_used: fuel_consumed,
                    events: Vec::new(),
                    error: Some(err_msg),
                    storage_writes: None,
                    storage_deletes: None,
                    balance_deltas: None,
                })
            }
        }
    }
}

impl Default for WasmRuntime {
    fn default() -> Self {
        Self::new().expect("Failed to create WASM runtime")
    }
}
