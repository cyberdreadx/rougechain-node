use std::collections::HashMap;
use wasmi::{Caller, Extern, Linker, Memory};

use crate::store::ContractEvent;

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

    Ok(())
}
