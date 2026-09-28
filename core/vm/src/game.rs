//! GAME_READY 2 host functions: contracts hold and move custom tokens and NFTs, create their own
//! NFT collections and mint to players, and draw per-transaction randomness.
//!
//! The VM never touches the token ledger or the NFT store directly. It reads them through a
//! [`ChainView`] snapshot supplied by the node, keeps its own overlay so several operations in one
//! call see each other, and returns the accepted operations as [`ChainEffect`]s. The node applies
//! those effects (in order) only when the call succeeds, exactly like XRGE `balance_deltas`.
//!
//! These functions are linked only when the node passes a [`GameExt`] (from the GAME_READY_2
//! activation height), so before activation a module importing them fails to instantiate exactly
//! as it does on nodes that don't have this code.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use wasmi::{Caller, Linker};

use crate::host::HostEnv;

/// Read-only view of chain state that token/NFT host functions consult.
pub trait ChainView: Send + Sync {
    /// Canonical ledger key for an address or public key (rouge1… for public keys; other strings,
    /// such as 40-hex contract addresses, unchanged).
    fn canon(&self, addr: &str) -> String;
    /// Token balance in the token's raw units. `owner` is canonical, `symbol` upper-case.
    fn token_balance(&self, owner: &str, symbol: &str) -> u128;
    /// Current owner (as stored) and locked flag of an NFT.
    fn nft_owner(&self, collection_id: &str, token_id: u64) -> Option<(String, bool)>;
    fn nft_collection(&self, collection_id: &str) -> Option<CollectionView>;
}

#[derive(Debug, Clone, PartialEq)]
pub struct CollectionView {
    pub creator: String,
    pub max_supply: Option<u64>,
    pub minted: u64,
    pub frozen: bool,
}

/// Per-call extension context supplied by the node.
#[derive(Clone)]
pub struct GameExt {
    pub view: Arc<dyn ChainView>,
    /// sha256("rougechain/rand/v1" ‖ parent block hash ‖ tx hash): fixed before the tx executes.
    pub seed: [u8; 32],
}

/// A token or NFT operation a successful call performed, for the node to apply.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChainEffect {
    TokenTransfer { symbol: String, from: String, to: String, amount: u128 },
    NftCreateCollection { collection_id: String, symbol: String, name: String, creator: String, max_supply: Option<u64> },
    NftMint { collection_id: String, token_id: u64, to: String, name: String, metadata: Option<serde_json::Value> },
    NftTransfer { collection_id: String, token_id: u64, from: String, to: String },
}

/// Collection id used by the NFT store (`NftCollection::make_collection_id`).
pub fn collection_id(creator: &str, symbol: &str) -> String {
    let short = if creator.len() >= 16 { &creator[..16] } else { creator };
    format!("col:{}:{}", short, symbol.to_uppercase())
}

pub fn random_seed(parent_hash: &str, tx_hash: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"rougechain/rand/v1");
    h.update(parent_hash.as_bytes());
    h.update([0u8]);
    h.update(tx_hash.as_bytes());
    h.finalize().into()
}

/// Names of the host functions this module adds (deployments importing them are refused before
/// activation).
pub const GAME_HOST_FUNCTIONS: &[&str] = &[
    "host_token_balance",
    "host_token_transfer",
    "host_nft_owner",
    "host_nft_transfer",
    "host_nft_create_collection",
    "host_nft_mint",
    "host_random",
];

/// Mutable per-call state: the view plus this call's overlay.
pub struct GameState {
    pub ext: GameExt,
    rand_counter: u64,
    token_delta: HashMap<(String, String), i128>,
    nft_owner: HashMap<(String, u64), String>,
    collections: HashMap<String, CollectionView>,
    pub effects: Vec<ChainEffect>,
}

impl GameState {
    pub fn new(ext: GameExt) -> Self {
        Self {
            ext,
            rand_counter: 0,
            token_delta: HashMap::new(),
            nft_owner: HashMap::new(),
            collections: HashMap::new(),
            effects: Vec::new(),
        }
    }

    pub fn canon(&self, addr: &str) -> String {
        self.ext.view.canon(addr)
    }

    fn token_balance(&self, owner: &str, symbol: &str) -> u128 {
        let base = self.ext.view.token_balance(owner, symbol) as i128;
        let d = self.token_delta.get(&(owner.to_string(), symbol.to_string())).copied().unwrap_or(0);
        (base + d).max(0) as u128
    }

    fn nft_owner(&self, col: &str, id: u64) -> Option<(String, bool)> {
        if let Some(o) = self.nft_owner.get(&(col.to_string(), id)) {
            return Some((o.clone(), false));
        }
        self.ext.view.nft_owner(col, id)
    }

    fn collection(&self, col: &str) -> Option<CollectionView> {
        self.collections.get(col).cloned().or_else(|| self.ext.view.nft_collection(col))
    }
}

fn symbol_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 32 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn mem(caller: &Caller<'_, HostEnv>) -> Option<wasmi::Memory> {
    match caller.get_export("memory") {
        Some(wasmi::Extern::Memory(m)) => Some(m),
        _ => None,
    }
}

fn read(caller: &Caller<'_, HostEnv>, ptr: u32, len: u32) -> Option<String> {
    if len > 64 * 1024 {
        return None;
    }
    let m = mem(caller)?;
    let mut buf = vec![0u8; len as usize];
    m.read(caller, ptr as usize, &mut buf).ok()?;
    String::from_utf8(buf).ok()
}

fn write(caller: &mut Caller<'_, HostEnv>, ptr: u32, cap: u32, bytes: &[u8]) -> i32 {
    if bytes.len() > cap as usize {
        return -2;
    }
    let Some(m) = mem(caller) else { return -4 };
    if m.write(caller, ptr as usize, bytes).is_err() {
        return -4;
    }
    bytes.len() as i32
}

/// Link the GAME_READY 2 host functions. Each returns a negative/invalid code (never traps the
/// node) on bad input; `-99` means the node didn't enable them for this call.
pub fn register_game_functions(linker: &mut Linker<HostEnv>) -> Result<(), String> {
    // host_token_balance(sym_ptr, sym_len, addr_ptr, addr_len) -> i64 raw units (-1 invalid)
    linker.func_wrap("env", "host_token_balance",
        |caller: Caller<'_, HostEnv>, sp: u32, sl: u32, ap: u32, al: u32| -> i64 {
            let (Some(sym), Some(addr)) = (read(&caller, sp, sl), read(&caller, ap, al)) else { return -1 };
            let Some(g) = caller.data().game.as_ref() else { return -99 };
            let sym = sym.trim().to_uppercase();
            if !symbol_ok(&sym) || sym == "XRGE" { return -1; }
            let owner = g.canon(&addr);
            g.token_balance(&owner, &sym).min(i64::MAX as u128) as i64
        }
    ).map_err(|e| e.to_string())?;

    // host_token_transfer(sym_ptr, sym_len, to_ptr, to_len, amount) -> 0 ok | 1 insufficient | 2 invalid
    // Moves the CONTRACT's own tokens.
    linker.func_wrap("env", "host_token_transfer",
        |mut caller: Caller<'_, HostEnv>, sp: u32, sl: u32, tp: u32, tl: u32, amount: i64| -> i32 {
            let (Some(sym), Some(to)) = (read(&caller, sp, sl), read(&caller, tp, tl)) else { return 2 };
            let from = caller.data().contract_addr.clone();
            let Some(g) = caller.data_mut().game.as_mut() else { return -99 };
            let sym = sym.trim().to_uppercase();
            if !symbol_ok(&sym) || sym == "XRGE" || amount <= 0 || to.is_empty() { return 2; }
            let to = g.canon(&to);
            let amount = amount as u128;
            if g.token_balance(&from, &sym) < amount { return 1; }
            *g.token_delta.entry((from.clone(), sym.clone())).or_insert(0) -= amount as i128;
            *g.token_delta.entry((to.clone(), sym.clone())).or_insert(0) += amount as i128;
            g.effects.push(ChainEffect::TokenTransfer { symbol: sym, from, to, amount });
            0
        }
    ).map_err(|e| e.to_string())?;

    // host_nft_owner(col_ptr, col_len, token_id, out_ptr, out_cap) -> bytes written | -1 not found | -2 buffer too small
    linker.func_wrap("env", "host_nft_owner",
        |mut caller: Caller<'_, HostEnv>, cp: u32, cl: u32, id: i64, op: u32, oc: u32| -> i32 {
            let Some(col) = read(&caller, cp, cl) else { return -1 };
            let Some(g) = caller.data().game.as_ref() else { return -99 };
            if id < 0 { return -1; }
            match g.nft_owner(&col, id as u64) {
                Some((owner, _)) => write(&mut caller, op, oc, owner.as_bytes()),
                None => -1,
            }
        }
    ).map_err(|e| e.to_string())?;

    // host_nft_transfer(col_ptr, col_len, token_id, to_ptr, to_len) -> 0 ok | 1 not the contract's | 2 not found/locked/invalid
    linker.func_wrap("env", "host_nft_transfer",
        |mut caller: Caller<'_, HostEnv>, cp: u32, cl: u32, id: i64, tp: u32, tl: u32| -> i32 {
            let (Some(col), Some(to)) = (read(&caller, cp, cl), read(&caller, tp, tl)) else { return 2 };
            let me = caller.data().contract_addr.clone();
            let Some(g) = caller.data_mut().game.as_mut() else { return -99 };
            if id < 0 || to.is_empty() { return 2; }
            let id = id as u64;
            let Some((owner, locked)) = g.nft_owner(&col, id) else { return 2 };
            if locked { return 2; }
            if g.canon(&owner) != me { return 1; }
            g.nft_owner.insert((col.clone(), id), to.clone());
            g.effects.push(ChainEffect::NftTransfer { collection_id: col, token_id: id, from: owner, to });
            0
        }
    ).map_err(|e| e.to_string())?;

    // host_nft_create_collection(sym_ptr, sym_len, name_ptr, name_len, max_supply (0 = unlimited), out_ptr, out_cap)
    //   -> bytes of the collection id written | -1 exists | -2 buffer too small | -3 invalid
    linker.func_wrap("env", "host_nft_create_collection",
        |mut caller: Caller<'_, HostEnv>, sp: u32, sl: u32, np: u32, nl: u32, max_supply: i64, op: u32, oc: u32| -> i32 {
            let (Some(sym), Some(name)) = (read(&caller, sp, sl), read(&caller, np, nl)) else { return -3 };
            let me = caller.data().contract_addr.clone();
            let sym = sym.trim().to_uppercase();
            if !symbol_ok(&sym) || name.trim().is_empty() || name.len() > 128 || max_supply < 0 { return -3; }
            let col = collection_id(&me, &sym);
            {
                let Some(g) = caller.data_mut().game.as_mut() else { return -99 };
                if g.collection(&col).is_some() { return -1; }
                let max = if max_supply == 0 { None } else { Some(max_supply as u64) };
                g.collections.insert(col.clone(), CollectionView { creator: me.clone(), max_supply: max, minted: 0, frozen: false });
                g.effects.push(ChainEffect::NftCreateCollection {
                    collection_id: col.clone(), symbol: sym, name: name.trim().to_string(), creator: me, max_supply: max,
                });
            }
            write(&mut caller, op, oc, col.as_bytes())
        }
    ).map_err(|e| e.to_string())?;

    // host_nft_mint(col_ptr, col_len, to_ptr, to_len, name_ptr, name_len, meta_ptr, meta_len) -> token id
    //   | -1 contract isn't the collection's creator | -2 max supply reached | -3 not found/frozen | -4 invalid
    // `meta` is optional JSON (attributes); pass len 0 for none.
    linker.func_wrap("env", "host_nft_mint",
        |mut caller: Caller<'_, HostEnv>, cp: u32, cl: u32, tp: u32, tl: u32, np: u32, nl: u32, mp: u32, ml: u32| -> i64 {
            let (Some(col), Some(to), Some(name)) = (read(&caller, cp, cl), read(&caller, tp, tl), read(&caller, np, nl)) else { return -4 };
            let meta = if ml == 0 { None } else {
                match read(&caller, mp, ml).and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()) {
                    Some(v) => Some(v),
                    None => return -4,
                }
            };
            let me = caller.data().contract_addr.clone();
            let Some(g) = caller.data_mut().game.as_mut() else { return -99 };
            if to.is_empty() || name.trim().is_empty() || name.len() > 128 { return -4; }
            let Some(mut c) = g.collection(&col) else { return -3 };
            if c.frozen { return -3; }
            if g.canon(&c.creator) != me { return -1; }
            if c.max_supply.map_or(false, |m| c.minted >= m) { return -2; }
            c.minted += 1;
            let id = c.minted;
            g.collections.insert(col.clone(), c);
            g.nft_owner.insert((col.clone(), id), to.clone());
            g.effects.push(ChainEffect::NftMint { collection_id: col, token_id: id, to, name: name.trim().to_string(), metadata: meta });
            id as i64
        }
    ).map_err(|e| e.to_string())?;

    // host_random(out_ptr) -> 32: writes 32 pseudo-random bytes. Each call in a transaction gives
    // new bytes; they're fixed by the parent block hash and the transaction hash, so the player
    // can't re-roll without a new transaction. Not suitable when a block producer has a stake in
    // the outcome — use commit-reveal for that (see docs).
    linker.func_wrap("env", "host_random",
        |mut caller: Caller<'_, HostEnv>, op: u32| -> i32 {
            let bytes: [u8; 32] = {
                let Some(g) = caller.data_mut().game.as_mut() else { return -99 };
                let mut h = Sha256::new();
                h.update(g.ext.seed);
                h.update(g.rand_counter.to_be_bytes());
                g.rand_counter += 1;
                h.finalize().into()
            };
            write(&mut caller, op, 32, &bytes)
        }
    ).map_err(|e| e.to_string())?;

    Ok(())
}
