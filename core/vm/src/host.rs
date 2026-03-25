use std::collections::HashMap;
use wasmi::{Caller, Extern, Linker, Memory};

use crate::store::ContractEvent;

/// Maximum call depth for cross-contract calls
pub const MAX_CALL_DEPTH: u32 = 8;

/// A pending cross-contract call recorded by `host_call_contract`
#[derive(Debug, Clone)]
pub struct PendingCall {
    pub target_addr: String,
    pub method: String,
    pub args_json: String,
    pub gas_limit: u64,
}

/// Mutable sandbox environment shared between host functions and the runtime.
pub struct HostEnv {
    pub caller: String,
    pub contract_addr: String,
    pub block_height: u64,
    pub block_time: u64,
    pub balances: HashMap<String, u64>,
    pub balance_deltas: Vec<(String, i128)>,
    pub storage_writes: HashMap<Vec<u8>, Vec<u8>>,
    pub storage_deletes: Vec<Vec<u8>>,
    pub storage_cache: HashMap<Vec<u8>, Vec<u8>>,
    pub events: Vec<ContractEvent>,
    pub return_data: Option<Vec<u8>>,
    pub logs: Vec<String>,
    /// Pending cross-contract calls (processed by runtime after execution)
    pub pending_calls: Vec<PendingCall>,
    /// Results from completed cross-contract calls (indexed by call order)
    pub cross_call_results: Vec<(bool, Vec<u8>)>,
    /// Current call depth (0 = top-level)
    pub call_depth: u32,
}

impl HostEnv {
    pub fn new(
        caller: String,
        contract_addr: String,
        block_height: u64,
        block_time: u64,
        balances: HashMap<String, u64>,
        storage_cache: HashMap<Vec<u8>, Vec<u8>>,
    ) -> Self {
        Self {
            caller,
            contract_addr,
            block_height,
            block_time,
            balances,
            balance_deltas: Vec::new(),
            storage_writes: HashMap::new(),
            storage_deletes: Vec::new(),
            storage_cache,
            events: Vec::new(),
            return_data: None,
            logs: Vec::new(),
            pending_calls: Vec::new(),
            cross_call_results: Vec::new(),
            call_depth: 0,
        }
    }
}

fn get_memory(caller: &Caller<'_, HostEnv>) -> Memory {
    match caller.get_export("memory") {
        Some(Extern::Memory(mem)) => mem,
        _ => panic!("WASM module must export 'memory'"),
    }
}

fn read_bytes(caller: &Caller<'_, HostEnv>, memory: &Memory, ptr: u32, len: u32) -> Vec<u8> {
    let mut buf = vec![0u8; len as usize];
    if memory.read(caller, ptr as usize, &mut buf).is_err() {
        return Vec::new();
    }
    buf
}

fn read_string(caller: &Caller<'_, HostEnv>, memory: &Memory, ptr: u32, len: u32) -> String {
    String::from_utf8_lossy(&read_bytes(caller, memory, ptr, len)).to_string()
}

/// Register all host functions with the wasmi Linker.
pub fn register_host_functions(linker: &mut Linker<HostEnv>) -> Result<(), String> {
    // ── host_log(msg_ptr, msg_len) ──
    linker.func_wrap("env", "host_log",
        |mut caller: Caller<'_, HostEnv>, ptr: u32, len: u32| {
            let mem = get_memory(&caller);
            let msg = read_string(&caller, &mem, ptr, len);
            caller.data_mut().logs.push(msg);
        }
    ).map_err(|e| e.to_string())?;

    // ── host_get_caller(buf_ptr, buf_len) → i32 ──
    linker.func_wrap("env", "host_get_caller",
        |mut caller: Caller<'_, HostEnv>, buf_ptr: u32, buf_len: u32| -> i32 {
            let mem = get_memory(&caller);
            let addr_bytes = caller.data().caller.as_bytes().to_vec();
            if addr_bytes.len() > buf_len as usize { return -1; }
            mem.write(&mut caller, buf_ptr as usize, &addr_bytes).map_err(|_| ()).ok();
            addr_bytes.len() as i32
        }
    ).map_err(|e| e.to_string())?;

    // ── host_get_self_addr(buf_ptr, buf_len) → i32 ──
    linker.func_wrap("env", "host_get_self_addr",
        |mut caller: Caller<'_, HostEnv>, buf_ptr: u32, buf_len: u32| -> i32 {
            let mem = get_memory(&caller);
            let addr_bytes = caller.data().contract_addr.as_bytes().to_vec();
            if addr_bytes.len() > buf_len as usize { return -1; }
            mem.write(&mut caller, buf_ptr as usize, &addr_bytes).map_err(|_| ()).ok();
            addr_bytes.len() as i32
        }
    ).map_err(|e| e.to_string())?;

    // ── host_get_block_height() → i64 ──
    linker.func_wrap("env", "host_get_block_height",
        |caller: Caller<'_, HostEnv>| -> i64 {
            caller.data().block_height as i64
        }
    ).map_err(|e| e.to_string())?;

    // ── host_get_block_time() → i64 ──
    linker.func_wrap("env", "host_get_block_time",
        |caller: Caller<'_, HostEnv>| -> i64 {
            caller.data().block_time as i64
        }
    ).map_err(|e| e.to_string())?;

    // ── host_get_balance(addr_ptr, addr_len) → i64 ──
    linker.func_wrap("env", "host_get_balance",
        |caller: Caller<'_, HostEnv>, addr_ptr: u32, addr_len: u32| -> i64 {
            let mem = get_memory(&caller);
            let addr = read_string(&caller, &mem, addr_ptr, addr_len);
            *caller.data().balances.get(&addr).unwrap_or(&0) as i64
        }
    ).map_err(|e| e.to_string())?;

    // ── host_transfer(to_ptr, to_len, amount) → i32 ──
    // Returns 0 on success, 1 on insufficient balance
    linker.func_wrap("env", "host_transfer",
        |mut caller: Caller<'_, HostEnv>, to_ptr: u32, to_len: u32, amount: i64| -> i32 {
            let mem = get_memory(&caller);
            let to_addr = read_string(&caller, &mem, to_ptr, to_len);
            let amount_u = amount as u64;
            let contract_addr = caller.data().contract_addr.clone();
            let contract_bal = *caller.data().balances.get(&contract_addr).unwrap_or(&0);
            if contract_bal < amount_u {
                return 1;
            }
            let env = caller.data_mut();
            env.balance_deltas.push((contract_addr.clone(), -(amount_u as i128)));
            env.balance_deltas.push((to_addr.clone(), amount_u as i128));
            *env.balances.entry(contract_addr).or_insert(0) -= amount_u;
            *env.balances.entry(to_addr).or_insert(0) += amount_u;
            0
        }
    ).map_err(|e| e.to_string())?;

    // ── host_storage_read(key_ptr, key_len, val_buf_ptr, val_buf_len) → i32 ──
    // Returns bytes written, -1 if not found, -2 if buffer too small
    linker.func_wrap("env", "host_storage_read",
        |mut caller: Caller<'_, HostEnv>, key_ptr: u32, key_len: u32, val_ptr: u32, val_len: u32| -> i32 {
            let mem = get_memory(&caller);
            let key = read_bytes(&caller, &mem, key_ptr, key_len);
            let value = caller.data()
                .storage_writes.get(&key).cloned()
                .or_else(|| caller.data().storage_cache.get(&key).cloned());
            match value {
                Some(val) => {
                    if val.len() > val_len as usize { return -2; }
                    mem.write(&mut caller, val_ptr as usize, &val).map_err(|_| ()).ok();
                    val.len() as i32
                }
                None => -1,
            }
        }
    ).map_err(|e| e.to_string())?;

    // ── host_storage_write(key_ptr, key_len, val_ptr, val_len) ──
    linker.func_wrap("env", "host_storage_write",
        |mut caller: Caller<'_, HostEnv>, key_ptr: u32, key_len: u32, val_ptr: u32, val_len: u32| {
            let mem = get_memory(&caller);
            let key = read_bytes(&caller, &mem, key_ptr, key_len);
            let value = read_bytes(&caller, &mem, val_ptr, val_len);
            caller.data_mut().storage_writes.insert(key, value);
        }
    ).map_err(|e| e.to_string())?;

    // ── host_storage_delete(key_ptr, key_len) ──
    linker.func_wrap("env", "host_storage_delete",
        |mut caller: Caller<'_, HostEnv>, key_ptr: u32, key_len: u32| {
            let mem = get_memory(&caller);
            let key = read_bytes(&caller, &mem, key_ptr, key_len);
            caller.data_mut().storage_writes.remove(&key);
            caller.data_mut().storage_deletes.push(key);
        }
    ).map_err(|e| e.to_string())?;

    // ── host_emit_event(topic_ptr, topic_len, data_ptr, data_len) ──
    linker.func_wrap("env", "host_emit_event",
        |mut caller: Caller<'_, HostEnv>, topic_ptr: u32, topic_len: u32, data_ptr: u32, data_len: u32| {
            let mem = get_memory(&caller);
            let topic = read_string(&caller, &mem, topic_ptr, topic_len);
            let data = read_string(&caller, &mem, data_ptr, data_len);
            let contract_addr = caller.data().contract_addr.clone();
            caller.data_mut().events.push(ContractEvent {
                contract_addr,
                topic,
                data,
                block_height: 0, // Filled by runtime
                tx_hash: String::new(),
            });
        }
    ).map_err(|e| e.to_string())?;

    // ── host_sha256(data_ptr, data_len, out_ptr) → i32 ──
    linker.func_wrap("env", "host_sha256",
        |mut caller: Caller<'_, HostEnv>, data_ptr: u32, data_len: u32, out_ptr: u32| -> i32 {
            let mem = get_memory(&caller);
            let data = read_bytes(&caller, &mem, data_ptr, data_len);
            use sha2::{Sha256, Digest};
            let hash = Sha256::digest(&data);
            match mem.write(&mut caller, out_ptr as usize, &hash) {
                Ok(()) => 32,
                Err(_) => -1,
            }
        }
    ).map_err(|e| e.to_string())?;

    // ── host_set_return(data_ptr, data_len) ──
    linker.func_wrap("env", "host_set_return",
        |mut caller: Caller<'_, HostEnv>, data_ptr: u32, data_len: u32| {
            let mem = get_memory(&caller);
            let data = read_bytes(&caller, &mem, data_ptr, data_len);
            caller.data_mut().return_data = Some(data);
        }
    ).map_err(|e| e.to_string())?;

    // ── host_call_contract(addr_ptr, addr_len, method_ptr, method_len, args_ptr, args_len, gas_limit) → i32 ──
    // Records a pending cross-contract call. Returns call_id (0-indexed) or -1 on error.
    // The runtime processes these after the current execution finishes.
    linker.func_wrap("env", "host_call_contract",
        |mut caller: Caller<'_, HostEnv>,
         addr_ptr: u32, addr_len: u32,
         method_ptr: u32, method_len: u32,
         args_ptr: u32, args_len: u32,
         gas_limit: i64| -> i32 {
            let mem = get_memory(&caller);
            let target_addr = read_string(&caller, &mem, addr_ptr, addr_len);
            let method = read_string(&caller, &mem, method_ptr, method_len);
            let args_json = read_string(&caller, &mem, args_ptr, args_len);
            let depth = caller.data().call_depth;
            if depth >= MAX_CALL_DEPTH {
                caller.data_mut().logs.push(format!("Cross-call rejected: max depth {} reached", MAX_CALL_DEPTH));
                return -1;
            }
            let call_id = caller.data().pending_calls.len() as i32;
            caller.data_mut().pending_calls.push(PendingCall {
                target_addr,
                method,
                args_json,
                gas_limit: gas_limit.max(0) as u64,
            });
            call_id
        }
    ).map_err(|e| e.to_string())?;

    // ── host_get_call_result(call_id, buf_ptr, buf_len) → i32 ──
    // Returns bytes written on success, -1 if call_id invalid, -2 if call failed, -3 if buf too small
    linker.func_wrap("env", "host_get_call_result",
        |mut caller: Caller<'_, HostEnv>,
         call_id: i32, buf_ptr: u32, buf_len: u32| -> i32 {
            let results = &caller.data().cross_call_results;
            if call_id < 0 || (call_id as usize) >= results.len() {
                return -1;
            }
            let (success, data) = &results[call_id as usize];
            if !success {
                return -2;
            }
            if data.len() > buf_len as usize {
                return -3;
            }
            let data_clone = data.clone();
            let mem = get_memory(&caller);
            mem.write(&mut caller, buf_ptr as usize, &data_clone).map_err(|_| ()).ok();
            data_clone.len() as i32
        }
    ).map_err(|e| e.to_string())?;

    // ══════════════════════════════════════════════════════════════════════
    // PQC PRECOMPILES — Native post-quantum cryptographic operations
    // ══════════════════════════════════════════════════════════════════════

    // ── host_pqc_verify(pk_ptr, pk_len, msg_ptr, msg_len, sig_ptr, sig_len) → i32 ──
    // ML-DSA-65 signature verification. Returns 1 if valid, 0 if invalid, -1 on error.
    linker.func_wrap("env", "host_pqc_verify",
        |caller: Caller<'_, HostEnv>,
         pk_ptr: u32, pk_len: u32,
         msg_ptr: u32, msg_len: u32,
         sig_ptr: u32, sig_len: u32| -> i32 {
            let mem = get_memory(&caller);
            let pk_bytes = read_bytes(&caller, &mem, pk_ptr, pk_len);
            let msg_bytes = read_bytes(&caller, &mem, msg_ptr, msg_len);
            let sig_bytes = read_bytes(&caller, &mem, sig_ptr, sig_len);

            // ML-DSA-65 sizes: PK=1952, SIG=3309
            const PK_SIZE: usize = 1952;
            const SIG_SIZE: usize = 3309;

            if pk_bytes.len() != PK_SIZE || sig_bytes.len() != SIG_SIZE {
                return -1;
            }

            let pk_array: [u8; PK_SIZE] = match pk_bytes.as_slice().try_into() {
                Ok(a) => a,
                Err(_) => return -1,
            };
            let sig_array: [u8; SIG_SIZE] = match sig_bytes.as_slice().try_into() {
                Ok(a) => a,
                Err(_) => return -1,
            };

            use fips204::ml_dsa_65::PublicKey;
            use fips204::traits::{SerDes, Verifier};

            let pk = match PublicKey::try_from_bytes(pk_array) {
                Ok(k) => k,
                Err(_) => return -1,
            };

            if pk.verify(&msg_bytes, &sig_array, &[]) { 1 } else { 0 }
        }
    ).map_err(|e| e.to_string())?;

    // ── host_pqc_pubkey_to_address(pk_ptr, pk_len, out_ptr, out_len) → i32 ──
    // Derive a rouge1... bech32m address from a raw ML-DSA-65 public key.
    // Returns bytes written, or -1 on error, -2 if buffer too small.
    linker.func_wrap("env", "host_pqc_pubkey_to_address",
        |mut caller: Caller<'_, HostEnv>,
         pk_ptr: u32, pk_len: u32,
         out_ptr: u32, out_len: u32| -> i32 {
            let mem = get_memory(&caller);
            let pk_bytes = read_bytes(&caller, &mem, pk_ptr, pk_len);

            // SHA-256 the public key bytes
            use sha2::{Sha256, Digest};
            let hash = Sha256::digest(&pk_bytes);

            // Bech32m encode with "rouge" HRP
            let hrp = match bech32::Hrp::parse("rouge") {
                Ok(h) => h,
                Err(_) => return -1,
            };
            let address = match bech32::encode::<bech32::Bech32m>(hrp, &hash) {
                Ok(a) => a,
                Err(_) => return -1,
            };

            let addr_bytes = address.as_bytes();
            if addr_bytes.len() > out_len as usize {
                return -2;
            }
            mem.write(&mut caller, out_ptr as usize, addr_bytes).map_err(|_| ()).ok();
            addr_bytes.len() as i32
        }
    ).map_err(|e| e.to_string())?;

    // ── host_pqc_hash_pubkey(pk_ptr, pk_len, out_ptr) → i32 ──
    // SHA-256 hash of a public key (32 bytes output). Useful for compact identity checks.
    // Returns 32 on success, -1 on error.
    linker.func_wrap("env", "host_pqc_hash_pubkey",
        |mut caller: Caller<'_, HostEnv>,
         pk_ptr: u32, pk_len: u32, out_ptr: u32| -> i32 {
            let mem = get_memory(&caller);
            let pk_bytes = read_bytes(&caller, &mem, pk_ptr, pk_len);

            use sha2::{Sha256, Digest};
            let hash = Sha256::digest(&pk_bytes);

            match mem.write(&mut caller, out_ptr as usize, &hash) {
                Ok(()) => 32,
                Err(_) => -1,
            }
        }
    ).map_err(|e| e.to_string())?;

    Ok(())
}
