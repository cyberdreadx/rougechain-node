//! RougeChain ERC-20 Token Standard Contract
//!
//! This is a reference implementation of a fungible token contract for RougeChain's
//! WASM VM. It implements the standard ERC-20 interface:
//!
//! - `init(name, symbol, decimals, total_supply)` — Initialize the token
//! - `name()` / `symbol()` / `decimals()` / `total_supply()` — Token metadata
//! - `balance_of(account)` — Query balance
//! - `transfer(to, amount)` — Transfer tokens
//! - `approve(spender, amount)` — Approve allowance
//! - `allowance(owner, spender)` — Query allowance
//! - `transfer_from(from, to, amount)` — Transfer using allowance
//!
//! # Storage Layout
//! - `meta:name` → token name string
//! - `meta:symbol` → token symbol string
//! - `meta:decimals` → decimals as string
//! - `meta:total_supply` → total supply as string
//! - `bal:{account}` → balance as string
//! - `allow:{owner}:{spender}` → allowance as string

use serde::{Deserialize, Serialize};

// Host functions provided by the RougeChain VM
extern "C" {
    fn storage_read(key_ptr: *const u8, key_len: u32, buf_ptr: *mut u8, buf_len: u32) -> i32;
    fn storage_write(key_ptr: *const u8, key_len: u32, val_ptr: *const u8, val_len: u32);
    fn storage_delete(key_ptr: *const u8, key_len: u32);
}

// ─── Storage helpers ───────────────────────────────────────────────

fn read_storage(key: &str) -> Option<String> {
    let key_bytes = key.as_bytes();
    let mut buf = vec![0u8; 4096];
    let len = unsafe { storage_read(key_bytes.as_ptr(), key_bytes.len() as u32, buf.as_mut_ptr(), buf.len() as u32) };
    if len < 0 { return None; }
    buf.truncate(len as usize);
    String::from_utf8(buf).ok()
}

fn write_storage(key: &str, value: &str) {
    let key_bytes = key.as_bytes();
    let val_bytes = value.as_bytes();
    unsafe { storage_write(key_bytes.as_ptr(), key_bytes.len() as u32, val_bytes.as_ptr(), val_bytes.len() as u32) };
}

fn _delete_storage(key: &str) {
    let key_bytes = key.as_bytes();
    unsafe { storage_delete(key_bytes.as_ptr(), key_bytes.len() as u32) };
}

fn read_u128(key: &str) -> u128 {
    read_storage(key).and_then(|s| s.parse().ok()).unwrap_or(0)
}

fn write_u128(key: &str, val: u128) {
    write_storage(key, &val.to_string());
}

// ─── JSON args/result helpers ──────────────────────────────────────

#[derive(Deserialize)]
struct InitArgs {
    name: String,
    symbol: String,
    decimals: u8,
    total_supply: u128,
    owner: String,
}

#[derive(Deserialize)]
struct TransferArgs {
    to: String,
    amount: u128,
}

#[derive(Deserialize)]
struct ApproveArgs {
    spender: String,
    amount: u128,
}

#[derive(Deserialize)]
struct TransferFromArgs {
    from: String,
    to: String,
    amount: u128,
}

#[derive(Deserialize)]
struct BalanceOfArgs {
    account: String,
}

#[derive(Deserialize)]
struct AllowanceArgs {
    owner: String,
    spender: String,
}

#[derive(Serialize)]
struct TokenResult {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl TokenResult {
    fn ok(data: serde_json::Value) -> Vec<u8> {
        serde_json::to_vec(&TokenResult { success: true, data: Some(data), error: None }).unwrap()
    }
    fn err(msg: &str) -> Vec<u8> {
        serde_json::to_vec(&TokenResult { success: false, data: None, error: Some(msg.to_string()) }).unwrap()
    }
}

// ─── Contract entry point ──────────────────────────────────────────

/// Main entry point called by the RougeChain VM.
/// `args_ptr`/`args_len` point to a JSON string: `{"method":"...","args":{...},"caller":"..."}`
#[no_mangle]
pub extern "C" fn call(args_ptr: *const u8, args_len: u32, result_ptr: *mut u8, result_len: u32) -> u32 {
    let args_slice = unsafe { core::slice::from_raw_parts(args_ptr, args_len as usize) };
    let output = match serde_json::from_slice::<serde_json::Value>(args_slice) {
        Ok(val) => dispatch(&val),
        Err(e) => TokenResult::err(&format!("Invalid JSON: {}", e)),
    };

    let write_len = output.len().min(result_len as usize);
    unsafe {
        core::ptr::copy_nonoverlapping(output.as_ptr(), result_ptr, write_len);
    }
    write_len as u32
}

fn dispatch(input: &serde_json::Value) -> Vec<u8> {
    let method = input.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let args = input.get("args").cloned().unwrap_or(serde_json::Value::Object(Default::default()));
    let caller = input.get("caller").and_then(|v| v.as_str()).unwrap_or("anonymous");

    match method {
        // ─── Write operations ──────────────────
        "init" => handle_init(args, caller),
        "transfer" => handle_transfer(args, caller),
        "approve" => handle_approve(args, caller),
        "transfer_from" => handle_transfer_from(args, caller),

        // ─── Read operations ───────────────────
        "name" => TokenResult::ok(serde_json::json!(read_storage("meta:name").unwrap_or_default())),
        "symbol" => TokenResult::ok(serde_json::json!(read_storage("meta:symbol").unwrap_or_default())),
        "decimals" => TokenResult::ok(serde_json::json!(read_u128("meta:decimals"))),
        "total_supply" => TokenResult::ok(serde_json::json!(read_u128("meta:total_supply"))),
        "balance_of" => handle_balance_of(args),
        "allowance" => handle_allowance(args),

        _ => TokenResult::err(&format!("Unknown method: {}", method)),
    }
}

// ─── Handlers ──────────────────────────────────────────────────────

fn handle_init(args: serde_json::Value, _caller: &str) -> Vec<u8> {
    // Don't allow re-initialization
    if read_storage("meta:name").is_some() {
        return TokenResult::err("Token already initialized");
    }

    let init: InitArgs = match serde_json::from_value(args) {
        Ok(v) => v,
        Err(e) => return TokenResult::err(&format!("Invalid init args: {}", e)),
    };

    write_storage("meta:name", &init.name);
    write_storage("meta:symbol", &init.symbol);
    write_u128("meta:decimals", init.decimals as u128);
    write_u128("meta:total_supply", init.total_supply);

    // Mint total supply to owner
    write_u128(&format!("bal:{}", init.owner), init.total_supply);

    TokenResult::ok(serde_json::json!({
        "name": init.name,
        "symbol": init.symbol,
        "decimals": init.decimals,
        "total_supply": init.total_supply,
        "owner": init.owner,
    }))
}

fn handle_transfer(args: serde_json::Value, caller: &str) -> Vec<u8> {
    let t: TransferArgs = match serde_json::from_value(args) {
        Ok(v) => v,
        Err(e) => return TokenResult::err(&format!("Invalid args: {}", e)),
    };

    if t.amount == 0 {
        return TokenResult::err("Amount must be > 0");
    }
    if caller == t.to {
        return TokenResult::err("Cannot transfer to self");
    }

    let from_key = format!("bal:{}", caller);
    let to_key = format!("bal:{}", t.to);

    let from_bal = read_u128(&from_key);
    if from_bal < t.amount {
        return TokenResult::err(&format!("Insufficient balance: {} < {}", from_bal, t.amount));
    }

    write_u128(&from_key, from_bal - t.amount);
    write_u128(&to_key, read_u128(&to_key) + t.amount);

    TokenResult::ok(serde_json::json!({
        "from": caller,
        "to": t.to,
        "amount": t.amount,
    }))
}

fn handle_approve(args: serde_json::Value, caller: &str) -> Vec<u8> {
    let a: ApproveArgs = match serde_json::from_value(args) {
        Ok(v) => v,
        Err(e) => return TokenResult::err(&format!("Invalid args: {}", e)),
    };

    let allow_key = format!("allow:{}:{}", caller, a.spender);
    write_u128(&allow_key, a.amount);

    TokenResult::ok(serde_json::json!({
        "owner": caller,
        "spender": a.spender,
        "amount": a.amount,
    }))
}

fn handle_transfer_from(args: serde_json::Value, caller: &str) -> Vec<u8> {
    let t: TransferFromArgs = match serde_json::from_value(args) {
        Ok(v) => v,
        Err(e) => return TokenResult::err(&format!("Invalid args: {}", e)),
    };

    if t.amount == 0 {
        return TokenResult::err("Amount must be > 0");
    }

    let allow_key = format!("allow:{}:{}", t.from, caller);
    let allowance = read_u128(&allow_key);
    if allowance < t.amount {
        return TokenResult::err(&format!("Insufficient allowance: {} < {}", allowance, t.amount));
    }

    let from_key = format!("bal:{}", t.from);
    let to_key = format!("bal:{}", t.to);

    let from_bal = read_u128(&from_key);
    if from_bal < t.amount {
        return TokenResult::err(&format!("Insufficient balance: {} < {}", from_bal, t.amount));
    }

    write_u128(&allow_key, allowance - t.amount);
    write_u128(&from_key, from_bal - t.amount);
    write_u128(&to_key, read_u128(&to_key) + t.amount);

    TokenResult::ok(serde_json::json!({
        "from": t.from,
        "to": t.to,
        "amount": t.amount,
        "spender": caller,
    }))
}

fn handle_balance_of(args: serde_json::Value) -> Vec<u8> {
    let b: BalanceOfArgs = match serde_json::from_value(args) {
        Ok(v) => v,
        Err(e) => return TokenResult::err(&format!("Invalid args: {}", e)),
    };
    let balance = read_u128(&format!("bal:{}", b.account));
    TokenResult::ok(serde_json::json!(balance))
}

fn handle_allowance(args: serde_json::Value) -> Vec<u8> {
    let a: AllowanceArgs = match serde_json::from_value(args) {
        Ok(v) => v,
        Err(e) => return TokenResult::err(&format!("Invalid args: {}", e)),
    };
    let allowance = read_u128(&format!("allow:{}:{}", a.owner, a.spender));
    TokenResult::ok(serde_json::json!(allowance))
}
