//! CONTRACT_NFT_ROYALTY host functions: `host_nft_royalty_bps` / `host_nft_royalty_recipient`.
//!
//! Values for wallet-created, zero-royalty, contract-created (same call and multi-hop overlay) and
//! unknown collections; buffer too small; the >10000 clamp; and that a module importing them does
//! not instantiate unless the node enables them (the pre-activation behaviour of any unknown import).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use quantum_vault_vm::game::{collection_id, ChainEffect, OverlayView};
use quantum_vault_vm::{ChainView, CollectionView, ContractStore, GameExt, WasmRuntime, NFT_ROYALTY_HOST_FUNCTIONS};

static COUNTER: AtomicU64 = AtomicU64::new(0);
struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        let mut p = std::env::temp_dir();
        let c = COUNTER.fetch_add(1, Ordering::SeqCst);
        p.push(format!("rvm-royalty-{}-{}", std::process::id(), c));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

/// Wallet "public keys" in this mock start with `PK`; canon maps them to `rouge1…` like the node.
struct MockView { cols: HashMap<String, CollectionView> }
impl ChainView for MockView {
    fn canon(&self, addr: &str) -> String {
        match addr.strip_prefix("PK") { Some(rest) => format!("rouge1{}", rest.to_lowercase()), None => addr.to_string() }
    }
    fn token_balance(&self, _: &str, _: &str) -> u128 { 0 }
    fn nft_owner(&self, _: &str, _: u64) -> Option<(String, bool)> { None }
    fn nft_collection(&self, id: &str) -> Option<CollectionView> { self.cols.get(id).cloned() }
}

fn col(creator: &str, bps: u16, recipient: &str) -> CollectionView {
    CollectionView { creator: creator.into(), max_supply: None, minted: 0, frozen: false,
        royalty_bps: bps, royalty_recipient: recipient.into() }
}

fn view() -> Arc<dyn ChainView> {
    let mut cols = HashMap::new();
    cols.insert("col:ARTIST:ART".to_string(), col("PKARTIST", 250, "PKSTUDIO"));
    cols.insert("col:ARTIST:FREE".to_string(), col("PKARTIST", 0, "PKARTIST"));
    cols.insert("col:ARTIST:SPLIT".to_string(), col("PKARTIST", 1000, "0123456789abcdef0123456789abcdef01234567"));
    cols.insert("col:ARTIST:RB".to_string(), col("PKARTIST", 500, "rouge1already"));
    cols.insert("col:ARTIST:HUGE".to_string(), col("PKARTIST", 65_000, "PKARTIST"));
    Arc::new(MockView { cols })
}

fn ext(v: Arc<dyn ChainView>, royalty: bool) -> GameExt {
    GameExt { view: v, seed: [7; 32], block_hashes: true, payable: true, nft_royalty: royalty, attached: None }
}

/// `probe`: optionally creates its own collection `ART`, then stores `bps` (i32), `n` (i32) and
/// `rcp` (the recipient bytes, when n > 0) for the collection id at offset 1000.
fn probe_wat(col: &str, cap: u32, create: bool) -> String {
    let (col_len, create_code) = if create {
        ("(local.get $c)", "(local.set $c (call $cc (i32.const 0) (i32.const 3) (i32.const 0) (i32.const 3) (i64.const 0) (i32.const 1000) (i32.const 200)))")
    } else {
        ("", "")
    };
    let col_len = if create { col_len.to_string() } else { format!("(i32.const {})", col.len()) };
    format!(r#"
    (module
      (import "env" "host_nft_create_collection" (func $cc (param i32 i32 i32 i32 i64 i32 i32) (result i32)))
      (import "env" "host_nft_royalty_bps"       (func $bps (param i32 i32) (result i32)))
      (import "env" "host_nft_royalty_recipient" (func $rcp (param i32 i32 i32 i32) (result i32)))
      (import "env" "host_storage_write"         (func $sw (param i32 i32 i32 i32)))
      (memory (export "memory") 1)
      (data (i32.const 0) "ART")
      (data (i32.const 16) "bps")
      (data (i32.const 20) "n")
      (data (i32.const 24) "rcp")
      (data (i32.const 1000) "{col}")
      (func (export "probe") (local $c i32) (local $n i32)
        {create_code}
        (i32.store (i32.const 100) (call $bps (i32.const 1000) {col_len}))
        (call $sw (i32.const 16) (i32.const 3) (i32.const 100) (i32.const 4))
        (local.set $n (call $rcp (i32.const 1000) {col_len} (i32.const 2000) (i32.const {cap})))
        (i32.store (i32.const 104) (local.get $n))
        (call $sw (i32.const 20) (i32.const 1) (i32.const 104) (i32.const 4))
        (if (i32.gt_s (local.get $n) (i32.const 0))
          (then (call $sw (i32.const 24) (i32.const 3) (i32.const 2000) (local.get $n))))))
    "#)
}

struct Probe { bps: i32, n: i32, rcp: Option<String> }

fn run(wat_src: &str, royalty: bool) -> Result<(String, Probe), String> {
    let dir = TempDir::new();
    let cs = ContractStore::new(&dir.0).unwrap();
    let rt = WasmRuntime::new().unwrap();
    let wasm = wat::parse_str(wat_src).unwrap();
    rt.validate_contract_wasm(&wasm).expect("deploy validation does not look at imports");
    let addr = rt.deploy_contract(&cs, "deployer", 1, &wasm, 1).unwrap();
    let r = rt.execute_contract_ext(&cs, &addr, "probe", &serde_json::Value::Null, "PKCALLER", 10, 0,
        HashMap::new(), 1_000_000, "tx", Some(ext(view(), royalty)))?;
    assert!(r.success, "{:?}", r.error);
    let w = r.storage_writes.unwrap();
    let get = |k: &str| w.get(&hex::encode(k)).map(|v| hex::decode(v).unwrap());
    let i = |k: &str| i32::from_le_bytes(get(k).unwrap().try_into().unwrap());
    Ok((addr, Probe { bps: i("bps"), n: i("n"), rcp: get("rcp").map(|b| String::from_utf8(b).unwrap()) }))
}

fn probe(col: &str, cap: u32) -> Probe { run(&probe_wat(col, cap, false), true).unwrap().1 }

#[test]
fn wallet_collection_with_royalty_returns_bps_and_canonical_recipient() {
    let p = probe("col:ARTIST:ART", 256);
    assert_eq!(p.bps, 250);
    assert_eq!(p.rcp.as_deref(), Some("rouge1studio"), "a public key comes back as its rouge1 ledger key");
    assert_eq!(p.n, "rouge1studio".len() as i32);
    let p = probe("col:ARTIST:RB", 256);
    assert_eq!((p.bps, p.rcp.as_deref()), (500, Some("rouge1already")), "rouge1 stays as is");
    let p = probe("col:ARTIST:SPLIT", 256);
    assert_eq!((p.bps, p.rcp.as_deref()), (1000, Some("0123456789abcdef0123456789abcdef01234567")), "contract address unchanged");
}

#[test]
fn zero_royalty_collection_returns_zero_and_its_recipient() {
    let p = probe("col:ARTIST:FREE", 256);
    assert_eq!((p.bps, p.rcp.as_deref()), (0, Some("rouge1artist")));
}

#[test]
fn stored_bps_above_10000_is_reported_as_10000() {
    assert_eq!(probe("col:ARTIST:HUGE", 256).bps, 10_000);
}

#[test]
fn unknown_collection_is_minus_one_and_writes_nothing() {
    let p = probe("col:NOPE:NOPE", 256);
    assert_eq!((p.bps, p.n, p.rcp), (-1, -1, None));
}

#[test]
fn buffer_too_small_is_minus_two() {
    let exact = "rouge1studio".len() as u32;
    let p = probe("col:ARTIST:ART", exact - 1);
    assert_eq!((p.bps, p.n, p.rcp), (250, -2, None));
    assert_eq!(probe("col:ARTIST:ART", exact).rcp.as_deref(), Some("rouge1studio"), "exact fit works");
}

#[test]
fn collection_created_earlier_in_the_same_call_has_no_royalty_and_pays_its_creator() {
    let (addr, p) = run(&probe_wat("", 256, true), true).unwrap();
    assert_eq!(p.bps, 0);
    assert_eq!(p.rcp.as_deref(), Some(addr.as_str()), "recipient = the creating contract");
    let _ = collection_id(&addr, "ART");
}

#[test]
fn sub_call_overlay_sees_a_collection_created_by_its_caller() {
    let base = view();
    let created = ChainEffect::NftCreateCollection { collection_id: "col:c0ffee:NEW".into(), symbol: "NEW".into(),
        name: "New".into(), creator: "c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff".into(), max_supply: Some(5) };
    let o = OverlayView::new(base, &[created]);
    let c = o.nft_collection("col:c0ffee:NEW").unwrap();
    assert_eq!((c.royalty_bps, c.royalty_recipient.as_str()), (0, "c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff"));
    assert_eq!(o.nft_collection("col:ARTIST:ART").unwrap().royalty_bps, 250, "base collections pass through");
}

#[test]
fn not_linked_unless_enabled_fails_like_an_unknown_import() {
    assert_eq!(NFT_ROYALTY_HOST_FUNCTIONS, &["host_nft_royalty_bps", "host_nft_royalty_recipient"]);
    let err = run(&probe_wat("col:ARTIST:ART", 256, false), false).err().expect("must not instantiate");
    assert!(err.contains("Instantiation"), "{err}");
    // A module importing a function that never existed fails the same way.
    let unknown = probe_wat("col:ARTIST:ART", 256, false).replace("host_nft_royalty_bps", "host_does_not_exist");
    let err2 = run(&unknown, true).err().expect("unknown import");
    assert!(err2.contains("Instantiation"), "{err2}");
    // Without the GAME extension at all (before GAME_READY 2) too.
    let dir = TempDir::new();
    let cs = ContractStore::new(&dir.0).unwrap();
    let rt = WasmRuntime::new().unwrap();
    let addr = rt.deploy_contract(&cs, "d", 1, &wat::parse_str(probe_wat("col:ARTIST:ART", 256, false)).unwrap(), 1).unwrap();
    let err3 = rt.execute_contract(&cs, &addr, "probe", &serde_json::Value::Null, "PKCALLER", 10, 0, HashMap::new(), 1_000_000, "tx")
        .err().expect("no game ext");
    assert!(err3.contains("Instantiation"), "{err3}");
}
