//! Phase 0 determinism harness for the RougeChain WASM VM.
//!
//! These tests pin down the properties that the contract-XRGE-custody upgrade
//! (see the RFC) depends on: given identical inputs, a contract call must produce
//! byte-identical results on every node — the same `balance_deltas` (in the same
//! order), the same storage writes, the same events, and the same `gas_used` —
//! and value must be conserved across transfers. If any of these ever drift,
//! applying deltas to the ledger would fork the chain; these tests are the guard.
//!
//! They are also simply the FIRST tests this crate has ever had.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use quantum_vault_vm::{ContractStore, WasmRuntime};

// ── Test fixtures (WAT → wasm at test time via the `wat` crate) ────────

/// Writes storage key "k"=>"v", emits event (topic "T", data "D"), returns "OK".
const WAT_STORAGE: &str = r#"
(module
  (import "env" "host_storage_write" (func $sw (param i32 i32 i32 i32)))
  (import "env" "host_emit_event"    (func $ee (param i32 i32 i32 i32)))
  (import "env" "host_set_return"    (func $sr (param i32 i32)))
  (memory (export "memory") 1)
  (data (i32.const 0)  "k")
  (data (i32.const 8)  "v")
  (data (i32.const 16) "T")
  (data (i32.const 24) "D")
  (data (i32.const 32) "OK")
  (func (export "run")
    (call $sw (i32.const 0) (i32.const 1) (i32.const 8) (i32.const 1))
    (call $ee (i32.const 16) (i32.const 1) (i32.const 24) (i32.const 1))
    (call $sr (i32.const 32) (i32.const 2))))
"#;

/// Transfers 100 base units from the contract to address "bob".
const WAT_TRANSFER: &str = r#"
(module
  (import "env" "host_transfer" (func $tr (param i32 i32 i64) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 0) "bob")
  (func (export "pay") (result i32)
    (call $tr (i32.const 0) (i32.const 3) (i64.const 100))))
"#;

/// Infinite loop — used to exercise fuel exhaustion.
const WAT_SPIN: &str = r#"
(module
  (memory (export "memory") 1)
  (func (export "spin") (loop (br 0))))
"#;

// ── Temp sled dir with cleanup ────────────────────────────────────────
static COUNTER: AtomicU64 = AtomicU64::new(0);

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        let mut p = std::env::temp_dir();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let c = COUNTER.fetch_add(1, Ordering::SeqCst);
        p.push(format!("rvm-test-{}-{}-{}", std::process::id(), nanos, c));
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// ── Helpers ───────────────────────────────────────────────────────────

fn assemble(wat_src: &str) -> Vec<u8> {
    wat::parse_str(wat_src).expect("valid WAT fixture")
}

fn deploy(rt: &WasmRuntime, cs: &ContractStore, wat_src: &str, deployer: &str, nonce: u64) -> String {
    let wasm = assemble(wat_src);
    rt.deploy_contract(cs, deployer, nonce, &wasm, 1).expect("deploy")
}

#[allow(clippy::too_many_arguments)]
fn run(
    rt: &WasmRuntime,
    cs: &ContractStore,
    addr: &str,
    method: &str,
    caller: &str,
    balances: HashMap<String, u128>,
    gas_limit: u64,
) -> quantum_vault_vm::ContractCallResult {
    rt.execute_contract(
        cs,
        addr,
        method,
        &serde_json::json!({}),
        caller,
        /* block_height */ 42,
        /* block_time */ 1_000,
        balances,
        gas_limit,
        /* tx_hash */ "deadbeef",
    )
    .expect("execute")
}

fn sorted_writes(r: &quantum_vault_vm::ContractCallResult) -> BTreeMap<String, String> {
    r.storage_writes.clone().unwrap_or_default().into_iter().collect()
}

// ── Tests ─────────────────────────────────────────────────────────────

#[test]
fn storage_event_and_return_are_captured_and_committed() {
    let dir = TempDir::new();
    let cs = ContractStore::new(dir.path()).unwrap();
    let rt = WasmRuntime::new().unwrap();
    let addr = deploy(&rt, &cs, WAT_STORAGE, "alice", 0);

    let res = run(&rt, &cs, &addr, "run", "alice", HashMap::new(), 10_000_000);

    assert!(res.success, "run should succeed: {:?}", res.error);
    // "k" (0x6b) => "v" (0x76), hex-encoded in the result map.
    assert_eq!(sorted_writes(&res), BTreeMap::from([("6b".to_string(), "76".to_string())]));
    assert_eq!(res.events.len(), 1);
    assert_eq!(res.events[0].topic, "T");
    assert_eq!(res.events[0].data, "D");
    assert_eq!(res.return_data, Some(serde_json::Value::String("OK".to_string())));

    // Committed to the store on success.
    assert_eq!(cs.storage_read(&addr, &[0x6b]).unwrap(), Some(vec![0x76]));
}

#[test]
fn execution_is_deterministic_across_runs() {
    // Same code + inputs on two independent stores must yield identical results —
    // this is the core cross-node consensus property.
    let mut outputs = Vec::new();
    for _ in 0..3 {
        let dir = TempDir::new();
        let cs = ContractStore::new(dir.path()).unwrap();
        let rt = WasmRuntime::new().unwrap();
        let addr = deploy(&rt, &cs, WAT_STORAGE, "alice", 0);
        let res = run(&rt, &cs, &addr, "run", "alice", HashMap::new(), 10_000_000);
        outputs.push((
            res.success,
            res.gas_used,
            sorted_writes(&res),
            res.storage_deletes.clone().unwrap_or_default(),
            res.events.iter().map(|e| (e.topic.clone(), e.data.clone())).collect::<Vec<_>>(),
            res.return_data.clone(),
            res.balance_deltas.clone(),
        ));
    }
    assert_eq!(outputs[0], outputs[1], "run 0 vs 1 diverged");
    assert_eq!(outputs[1], outputs[2], "run 1 vs 2 diverged");
    // gas must be deterministic, not merely stable-shaped.
    assert!(outputs[0].1 > 0, "gas_used should be non-zero");
}

#[test]
fn transfer_emits_conserved_ordered_deltas() {
    let dir = TempDir::new();
    let cs = ContractStore::new(dir.path()).unwrap();
    let rt = WasmRuntime::new().unwrap();
    let addr = deploy(&rt, &cs, WAT_TRANSFER, "alice", 0);

    let mut balances = HashMap::new();
    balances.insert(addr.clone(), 500u128); // the contract custodies 500

    let res = run(&rt, &cs, &addr, "pay", "alice", balances, 10_000_000);

    assert!(res.success, "pay should succeed: {:?}", res.error);
    let deltas = res.balance_deltas.clone().expect("deltas present on success");
    // Order is defined by host_transfer: (from, -amt) then (to, +amt).
    assert_eq!(deltas, vec![(addr.clone(), -100i128), ("bob".to_string(), 100i128)]);
    // Conservation: pure transfer nets to zero.
    let net: i128 = deltas.iter().map(|(_, d)| *d).sum();
    assert_eq!(net, 0, "transfer must conserve value");

    // Determinism: a second independent run yields identical deltas.
    let dir2 = TempDir::new();
    let cs2 = ContractStore::new(dir2.path()).unwrap();
    let rt2 = WasmRuntime::new().unwrap();
    let addr2 = deploy(&rt2, &cs2, WAT_TRANSFER, "alice", 0);
    assert_eq!(addr2, addr, "address derivation must be deterministic");
    let mut b2 = HashMap::new();
    b2.insert(addr2.clone(), 500u128);
    let res2 = run(&rt2, &cs2, &addr2, "pay", "alice", b2, 10_000_000);
    assert_eq!(res2.balance_deltas, res.balance_deltas);
}

#[test]
fn transfer_with_insufficient_balance_produces_no_deltas() {
    let dir = TempDir::new();
    let cs = ContractStore::new(dir.path()).unwrap();
    let rt = WasmRuntime::new().unwrap();
    let addr = deploy(&rt, &cs, WAT_TRANSFER, "alice", 0);

    let mut balances = HashMap::new();
    balances.insert(addr.clone(), 50u128); // less than the 100 it tries to send

    let res = run(&rt, &cs, &addr, "pay", "alice", balances, 10_000_000);

    // host_transfer returns 1 (insufficient); the contract still completes.
    assert!(res.success);
    assert_eq!(
        res.balance_deltas.clone().unwrap_or_default(),
        Vec::<(String, i128)>::new(),
        "no deltas should be recorded when the transfer is rejected"
    );
}

#[test]
fn out_of_gas_fails_closed_with_no_state_changes() {
    let dir = TempDir::new();
    let cs = ContractStore::new(dir.path()).unwrap();
    let rt = WasmRuntime::new().unwrap();
    let addr = deploy(&rt, &cs, WAT_SPIN, "alice", 0);

    let res = run(&rt, &cs, &addr, "spin", "alice", HashMap::new(), 50_000);

    assert!(!res.success, "infinite loop must not succeed");
    let err = res.error.unwrap_or_default().to_lowercase();
    assert!(err.contains("gas"), "expected an out-of-gas error, got: {err}");
    // Failure path exposes no deltas / writes to apply.
    assert!(res.balance_deltas.is_none());
    assert!(res.storage_writes.is_none());
}

#[test]
fn deploy_address_matches_sha256_scheme_and_rejects_collision() {
    use sha2::{Digest, Sha256};

    let dir = TempDir::new();
    let cs = ContractStore::new(dir.path()).unwrap();
    let rt = WasmRuntime::new().unwrap();

    let deployer = "alice";
    let nonce = 7u64;
    let addr = deploy(&rt, &cs, WAT_STORAGE, deployer, nonce);

    // address = hex(SHA256(deployer_bytes ‖ nonce_be)[..20])
    let mut h = Sha256::new();
    h.update(deployer.as_bytes());
    h.update(nonce.to_be_bytes());
    let expected = hex::encode(&h.finalize()[..20]);
    assert_eq!(addr, expected, "address derivation scheme changed (consensus-breaking!)");

    // Re-deploying to the same (deployer, nonce) must be rejected.
    let wasm = assemble(WAT_STORAGE);
    let dup = rt.deploy_contract(&cs, deployer, nonce, &wasm, 1);
    assert!(dup.is_err(), "duplicate address must be rejected");
}

#[test]
fn missing_method_fails_gracefully() {
    let dir = TempDir::new();
    let cs = ContractStore::new(dir.path()).unwrap();
    let rt = WasmRuntime::new().unwrap();
    let addr = deploy(&rt, &cs, WAT_STORAGE, "alice", 0);

    let res = run(&rt, &cs, &addr, "does_not_exist", "alice", HashMap::new(), 10_000_000);
    assert!(!res.success);
    assert!(res.error.unwrap_or_default().to_lowercase().contains("not found"));
}

#[test]
fn install_contract_stores_bytecode_at_explicit_address() {
    // P3-3: block import installs bytecode at the address carried in the tx,
    // not a re-derived one, so every node can re-execute the contract.
    let dir = TempDir::new();
    let cs = ContractStore::new(dir.path()).unwrap();
    let rt = WasmRuntime::new().unwrap();
    let wasm = assemble(WAT_TRANSFER);
    let addr = "c0ffee00000000000000000000000000000000ab";

    rt.install_contract(&cs, addr, "alice", &wasm, 7).unwrap();
    assert!(cs.get_contract(addr).unwrap().is_some(), "installed at the given address");
    assert_eq!(cs.get_wasm(addr).unwrap().unwrap(), wasm, "exact bytecode stored");

    // Idempotent: installing again is a no-op success.
    rt.install_contract(&cs, addr, "alice", &wasm, 7).unwrap();

    // Invalid WASM is rejected (won't compile).
    assert!(rt.install_contract(&cs, "dead00", "alice", &[0, 1, 2, 3], 7).is_err());
}

#[test]
fn royalty_splitter_distributes_by_weight() {
    // Runs the REAL compiled royalty-splitter contract (contracts/royalty_splitter)
    // through the VM: fund the contract, call `split`, verify the proportional
    // 50/30/20 payout in quanta and exact conservation. Soft-skips if the wasm
    // hasn't been built (cargo build --release --target wasm32-unknown-unknown
    // in contracts/royalty_splitter).
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../contracts/royalty_splitter/target/wasm32-unknown-unknown/release/rougechain_royalty_splitter.wasm"
    );
    let wasm = match std::fs::read(path) {
        Ok(w) => w,
        Err(_) => { eprintln!("skip: splitter wasm not built"); return; }
    };

    let dir = TempDir::new();
    let cs = ContractStore::new(dir.path()).unwrap();
    let rt = WasmRuntime::new().unwrap();
    let addr = rt.deploy_contract(&cs, "qrougee-deployer", 0, &wasm, 1).unwrap();

    // Fund the contract with 100 XRGE (in quanta).
    const Q: u128 = 1_000_000_000;
    let mut balances = std::collections::HashMap::new();
    balances.insert(addr.clone(), 100 * Q);

    let res = rt
        .execute_contract(&cs, &addr, "split", &serde_json::json!({}), "anyone", 1, 1, balances, 10_000_000, "tx")
        .expect("execute split");
    assert!(res.success, "split failed: {:?}", res.error);

    let deltas = res.balance_deltas.expect("deltas on success");
    let credited = |a: &str| -> i128 { deltas.iter().filter(|(x, _)| x == a).map(|(_, d)| *d).sum() };
    assert_eq!(credited("1111111111111111111111111111111111111111"), (50 * Q) as i128, "50%");
    assert_eq!(credited("2222222222222222222222222222222222222222"), (30 * Q) as i128, "30%");
    assert_eq!(credited("3333333333333333333333333333333333333333"), (20 * Q) as i128, "20%");
    // The contract was debited the full 100 XRGE; nothing minted or burned.
    assert_eq!(credited(&addr), -((100 * Q) as i128), "contract debited in full");
    let net: i128 = deltas.iter().map(|(_, d)| *d).sum();
    assert_eq!(net, 0, "conserved to the quantum");
}
