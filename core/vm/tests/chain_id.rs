//! CONTRACT_CHAIN_ID host function: `host_get_chain_id(buf_ptr, buf_len) -> i32`.
//!
//! Writes the chain id when the node enables it; `-1` when the buffer is too small; and a module
//! importing it does not instantiate unless the node enables it (the pre-activation behaviour of
//! any unknown import).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use quantum_vault_vm::{ChainView, CollectionView, ContractStore, GameExt, WasmRuntime, CHAIN_ID_HOST_FUNCTIONS};

static COUNTER: AtomicU64 = AtomicU64::new(0);
struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        let mut p = std::env::temp_dir();
        let c = COUNTER.fetch_add(1, Ordering::SeqCst);
        p.push(format!("rvm-chainid-{}-{}", std::process::id(), c));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

struct NoView;
impl ChainView for NoView {
    fn canon(&self, addr: &str) -> String { addr.to_string() }
    fn token_balance(&self, _: &str, _: &str) -> u128 { 0 }
    fn nft_owner(&self, _: &str, _: u64) -> Option<(String, bool)> { None }
    fn nft_collection(&self, _: &str) -> Option<CollectionView> { None }
}

fn ext(chain_id: Option<&str>) -> GameExt {
    GameExt { view: Arc::new(NoView), seed: [7; 32], block_hashes: true, payable: true, nft_royalty: true,
        chain_id: chain_id.map(String::from), attached: None }
}

/// `probe` stores `n` (the return value, i32) and, when positive, `id` (the bytes written).
fn probe_wat(cap: u32) -> String {
    format!(r#"
    (module
      (import "env" "host_get_chain_id"  (func $cid (param i32 i32) (result i32)))
      (import "env" "host_storage_write" (func $sw (param i32 i32 i32 i32)))
      (memory (export "memory") 1)
      (data (i32.const 16) "id")
      (data (i32.const 20) "n")
      (func (export "probe") (local $n i32)
        (local.set $n (call $cid (i32.const 2000) (i32.const {cap})))
        (i32.store (i32.const 104) (local.get $n))
        (call $sw (i32.const 20) (i32.const 1) (i32.const 104) (i32.const 4))
        (if (i32.gt_s (local.get $n) (i32.const 0))
          (then (call $sw (i32.const 16) (i32.const 2) (i32.const 2000) (local.get $n))))))
    "#)
}

fn run(cap: u32, ext: Option<GameExt>) -> Result<(i32, Option<String>), String> {
    let dir = TempDir::new();
    let cs = ContractStore::new(&dir.0).unwrap();
    let rt = WasmRuntime::new().unwrap();
    let wasm = wat::parse_str(probe_wat(cap)).unwrap();
    rt.validate_contract_wasm(&wasm).expect("deploy validation does not look at imports");
    let addr = rt.deploy_contract(&cs, "deployer", 1, &wasm, 1).unwrap();
    let r = match ext {
        Some(e) => rt.execute_contract_ext(&cs, &addr, "probe", &serde_json::Value::Null, "PKCALLER", 10, 0, HashMap::new(), 1_000_000, "tx", Some(e))?,
        None => rt.execute_contract(&cs, &addr, "probe", &serde_json::Value::Null, "PKCALLER", 10, 0, HashMap::new(), 1_000_000, "tx")?,
    };
    assert!(r.success, "{:?}", r.error);
    let w = r.storage_writes.unwrap();
    let get = |k: &str| w.get(&hex::encode(k)).map(|v| hex::decode(v).unwrap());
    let n = i32::from_le_bytes(get("n").unwrap().try_into().unwrap());
    Ok((n, get("id").map(|b| String::from_utf8(b).unwrap())))
}

#[test]
fn writes_the_chain_id_when_enabled() {
    for id in ["rougechain-mainnet-1", "rougechain-devnet-1"] {
        let (n, got) = run(64, Some(ext(Some(id)))).unwrap();
        assert_eq!((n, got.as_deref()), (id.len() as i32, Some(id)));
    }
}

#[test]
fn buffer_too_small_is_minus_one_exact_fit_works() {
    let id = "rougechain-mainnet-1";
    assert_eq!(run(id.len() as u32 - 1, Some(ext(Some(id)))).unwrap(), (-1, None));
    assert_eq!(run(id.len() as u32, Some(ext(Some(id)))).unwrap().1.as_deref(), Some(id));
}

#[test]
fn not_linked_unless_enabled_fails_like_an_unknown_import() {
    assert_eq!(CHAIN_ID_HOST_FUNCTIONS, &["host_get_chain_id"]);
    let err = run(64, Some(ext(None))).err().expect("must not instantiate before activation");
    assert!(err.contains("Instantiation"), "{err}");
    let err2 = run(64, None).err().expect("no game ext at all");
    assert!(err2.contains("Instantiation"), "{err2}");
}
