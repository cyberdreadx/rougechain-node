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
pub use host::MAX_CALL_DEPTH;
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
        self.execute_contract_inner(
            contract_store, contract_addr, method, args_json,
            caller, block_height, block_time, balances, gas_limit, tx_hash, 0,
        )
    }

    /// Inner execute with call depth tracking for cross-contract calls
    fn execute_contract_inner(
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
        call_depth: u32,
    ) -> Result<ContractCallResult, String> {
        if call_depth >= MAX_CALL_DEPTH {
            return Ok(ContractCallResult {
                success: false,
                return_data: None,
                gas_used: 0,
                events: Vec::new(),
                error: Some(format!("Max call depth {} exceeded", MAX_CALL_DEPTH)),
                storage_writes: None,
                storage_deletes: None,
                balance_deltas: None,
                pending_calls: None,
                cross_call_results: None,
            });
        }

        let wasm_bytes = contract_store
            .get_wasm(contract_addr)?
            .ok_or_else(|| format!("Contract not found: {}", contract_addr))?;

        // Pre-load existing contract state from sled into cache
        let storage_cache = contract_store.load_all_state(contract_addr)?;

        let mut env = HostEnv::new(
            caller.to_string(),
            contract_addr.to_string(),
            block_height,
            block_time,
            balances.clone(),
            storage_cache,
        );
        env.call_depth = call_depth;

        let mut result = self.run_wasm(&wasm_bytes, method, args_json, env, gas_limit)?;

        // Process pending cross-contract calls
        if result.success {
            if let Some(pending_calls) = result.pending_calls.take() {
                let mut all_sub_events: Vec<ContractEvent> = Vec::new();
                let mut all_sub_storage: Vec<(String, Vec<(String, String)>)> = Vec::new();
                let mut all_sub_deletes: Vec<(String, Vec<String>)> = Vec::new();
                let mut cross_results: Vec<(bool, Vec<u8>)> = Vec::new();
                let mut total_sub_gas: u64 = 0;
                let mut current_balances = balances;

                // Apply balance deltas from the caller contract first
                if let Some(ref deltas) = result.balance_deltas {
                    for (addr, delta) in deltas {
                        let entry = current_balances.entry(addr.clone()).or_insert(0);
                        *entry = (*entry as i128 + delta).max(0) as u64;
                    }
                }

                for pending in pending_calls {
                    let sub_args: serde_json::Value = serde_json::from_str(&pending.args_json)
                        .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
                    let sub_gas = if pending.gas_limit > 0 { pending.gas_limit } else { gas_limit / 2 };

                    match self.execute_contract_inner(
                        contract_store,
                        &pending.target_addr,
                        &pending.method,
                        &sub_args,
                        contract_addr,  // caller is the calling contract
                        block_height,
                        block_time,
                        current_balances.clone(),
                        sub_gas,
                        tx_hash,
                        call_depth + 1,
                    ) {
                        Ok(sub_result) => {
                            total_sub_gas += sub_result.gas_used;
                            let ret_data = sub_result.return_data
                                .as_ref()
                                .map(|v| serde_json::to_vec(v).unwrap_or_default())
                                .unwrap_or_default();
                            cross_results.push((sub_result.success, ret_data));

                            if sub_result.success {
                                all_sub_events.extend(sub_result.events);
                                if let Some(writes) = sub_result.storage_writes {
                                    let writes_vec: Vec<(String, String)> = writes.into_iter().collect();
                                    all_sub_storage.push((pending.target_addr.clone(), writes_vec));
                                }
                                if let Some(deletes) = sub_result.storage_deletes {
                                    all_sub_deletes.push((pending.target_addr.clone(), deletes));
                                }
                                if let Some(ref deltas) = sub_result.balance_deltas {
                                    for (addr, delta) in deltas {
                                        let entry = current_balances.entry(addr.clone()).or_insert(0);
                                        *entry = (*entry as i128 + delta).max(0) as u64;
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            cross_results.push((false, e.into_bytes()));
                        }
                    }
                }

                result.gas_used += total_sub_gas;
                result.events.extend(all_sub_events);
                result.cross_call_results = Some(cross_results);

                // Commit sub-call storage writes
                for (addr, writes) in &all_sub_storage {
                    for (hex_key, hex_val) in writes {
                        if let (Ok(key), Ok(val)) = (hex::decode(hex_key), hex::decode(hex_val)) {
                            contract_store.storage_write(addr, &key, &val)?;
                        }
                    }
                }
                for (addr, deletes) in &all_sub_deletes {
                    for hex_key in deletes {
                        if let Ok(key) = hex::decode(hex_key) {
                            contract_store.storage_delete(addr, &key)?;
                        }
                    }
                }
            }
        }

        // Commit state changes on success
        if result.success {
            // Commit storage writes
            if let Some(ref writes) = result.storage_writes {
                for (hex_key, hex_val) in writes {
                    if let (Ok(key), Ok(val)) = (hex::decode(hex_key), hex::decode(hex_val)) {
                        contract_store.storage_write(contract_addr, &key, &val)?;
                    }
                }
            }
            // Commit storage deletes
            if let Some(ref deletes) = result.storage_deletes {
                for hex_key in deletes {
                    if let Ok(key) = hex::decode(hex_key) {
                        contract_store.storage_delete(contract_addr, &key)?;
                    }
                }
            }
            contract_store.flush_state()?;
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

        // Pre-load existing state for reads
        let storage_cache = contract_store.load_all_state(contract_addr)?;

        let env = HostEnv::new(
            String::new(),
            contract_addr.to_string(),
            block_height,
            block_time,
            balances,
            storage_cache,
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

        // Call the method — inspect function signature for correct results buffer
        let call_result: Result<(), String> = if let Some(func) = instance.get_func(&store, method) {
            let func_type = func.ty(&store);
            let mut results_buf: Vec<wasmi::Value> = func_type.results()
                .iter()
                .map(|ty| match ty {
                    wasmi::core::ValueType::I32 => wasmi::Value::I32(0),
                    wasmi::core::ValueType::I64 => wasmi::Value::I64(0),
                    wasmi::core::ValueType::F32 => wasmi::Value::F32(0.0.into()),
                    wasmi::core::ValueType::F64 => wasmi::Value::F64(0.0.into()),
                    _ => wasmi::Value::I32(0),
                })
                .collect();
            func.call(&mut store, &[], &mut results_buf)
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

                // Extract storage writes, events, and pending calls for committing
                let events = env.events.clone();
                let storage_writes = env.storage_writes.clone();
                let storage_deletes = env.storage_deletes.clone();
                let logs = env.logs.clone();
                let pending_calls = env.pending_calls.clone();

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
                    pending_calls: if pending_calls.is_empty() { None } else { Some(pending_calls) },
                    cross_call_results: None,
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
                    pending_calls: None,
                    cross_call_results: None,
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
