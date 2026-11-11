//! Local test chain for the browser IDE: the node's contract VM (`quantum-vault-vm`, the same wasmi
//! engine and host functions mainnet runs) over an in-memory ledger.
//!
//! What it mirrors from the node's block executor (`core/daemon/src/node.rs`, `contract_call`):
//! the caller is the signer's public key; an attached payment is shown to the contract as already
//! credited and moves for real only if the call succeeds; on success the XRGE balance deltas and
//! the token/NFT effects are applied with the node's checks (no overdraft, NFT still owned and
//! unlocked, mint ids in sequence). All feature switches are on (GAME_READY 1–3, payable calls,
//! NFT royalty reads, chain id), as on mainnet today.
//!
//! What it does not do: fees, signatures, blocks from other people, consensus. Every call is its
//! own block. Addresses of deployed contracts differ from the ones a real network assigns.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use quantum_vault_vm::{game, ChainEffect, ChainView, CollectionView, ContractStore, GameExt, WasmRuntime};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;

/// ML-DSA-65 public key length in bytes (the node's `PK_LEN`).
const PK_LEN: usize = 1952;
/// 1 XRGE in quanta.
const QUANTA_PER_XRGE: u128 = 1_000_000_000;

/// The node's `canon_addr`: a `rouge1…` address stays as is, an ML-DSA-65 public key (hex) becomes
/// its address, anything else (a contract address, a sentinel) is unchanged.
fn canon(addr: &str) -> String {
    if addr.starts_with("rouge1") && addr.len() > 10 && bech32::decode(addr).is_ok() {
        return addr.to_string();
    }
    match hex::decode(addr) {
        Ok(pk) if pk.len() == PK_LEN => address_of(&pk),
        _ => addr.to_string(),
    }
}

fn address_of(pk: &[u8]) -> String {
    let hrp = bech32::Hrp::parse("rouge").expect("valid hrp");
    bech32::encode::<bech32::Bech32m>(hrp, &Sha256::digest(pk)).expect("32-byte payload encodes")
}

fn parse_amount(s: &str) -> Result<u128, JsError> {
    s.trim().parse::<u128>().map_err(|_| JsError::new(&format!("not a whole number of base units: {s:?}")))
}

#[derive(Clone, Serialize)]
struct Collection {
    id: String,
    symbol: String,
    name: String,
    creator: String,
    max_supply: Option<u64>,
    minted: u64,
    royalty_bps: u16,
    royalty_recipient: String,
    frozen: bool,
}

#[derive(Clone, Serialize)]
struct Nft {
    collection: String,
    token_id: u64,
    owner: String,
    name: String,
    locked: bool,
    metadata: Option<Value>,
}

/// Snapshot handed to the VM for one call (the node's `NodeChainView`).
struct View {
    tokens: HashMap<(String, String), u128>,
    collections: BTreeMap<String, Collection>,
    nfts: BTreeMap<(String, u64), Nft>,
    block_hashes: HashMap<u64, String>,
}

impl ChainView for View {
    fn canon(&self, addr: &str) -> String {
        canon(addr)
    }
    fn token_balance(&self, owner: &str, symbol: &str) -> u128 {
        *self.tokens.get(&(owner.to_string(), symbol.to_string())).unwrap_or(&0)
    }
    fn nft_owner(&self, collection_id: &str, token_id: u64) -> Option<(String, bool)> {
        self.nfts.get(&(collection_id.to_string(), token_id)).map(|n| (n.owner.clone(), n.locked))
    }
    fn nft_collection(&self, collection_id: &str) -> Option<CollectionView> {
        self.collections.get(collection_id).map(|c| CollectionView {
            creator: c.creator.clone(),
            max_supply: c.max_supply,
            minted: c.minted,
            frozen: c.frozen,
            royalty_bps: c.royalty_bps,
            royalty_recipient: c.royalty_recipient.clone(),
        })
    }
    fn block_hash(&self, height: u64) -> Option<String> {
        self.block_hashes.get(&height).cloned()
    }
}

#[wasm_bindgen]
pub struct LocalChain {
    rt: WasmRuntime,
    store: ContractStore,
    chain_id: String,
    /// XRGE in quanta, keyed by canonical address.
    balances: HashMap<String, u128>,
    /// Token balances in raw units, keyed by (canonical owner, SYMBOL).
    tokens: HashMap<(String, String), u128>,
    collections: BTreeMap<String, Collection>,
    nfts: BTreeMap<(String, u64), Nft>,
    deploy_nonce: HashMap<String, u64>,
    height: u64,
    time: u64,
    block_hashes: HashMap<u64, String>,
    tx_counter: u64,
}

#[wasm_bindgen]
impl LocalChain {
    /// A fresh local chain. `start_time` is a Unix time in seconds (the page passes the clock).
    #[wasm_bindgen(constructor)]
    pub fn new(chain_id: String, start_time: u64) -> Result<LocalChain, JsError> {
        let rt = WasmRuntime::new().map_err(|e| JsError::new(&e))?;
        let mut chain = LocalChain {
            rt,
            store: ContractStore::in_memory(),
            chain_id,
            balances: HashMap::new(),
            tokens: HashMap::new(),
            collections: BTreeMap::new(),
            nfts: BTreeMap::new(),
            deploy_nonce: HashMap::new(),
            height: 0,
            time: start_time,
            block_hashes: HashMap::new(),
            tx_counter: 0,
        };
        chain.next_block(0);
        Ok(chain)
    }

    /// A new test account: a fresh ML-DSA-65 public key (the private key is discarded — local calls
    /// are not signed) funded with `xrge_quanta`. Returns `{ publicKey, address }`.
    #[wasm_bindgen(js_name = createAccount)]
    pub fn create_account(&mut self, xrge_quanta: &str) -> Result<JsValue, JsError> {
        use fips204::traits::SerDes;
        let (pk, _sk) = fips204::ml_dsa_65::try_keygen().map_err(|e| JsError::new(e))?;
        let pk_bytes = pk.into_bytes();
        let address = address_of(&pk_bytes);
        *self.balances.entry(address.clone()).or_insert(0) += parse_amount(xrge_quanta)?;
        to_js(&json!({ "publicKey": hex::encode(pk_bytes), "address": address }))
    }

    /// Add XRGE (quanta) to any address or public key — the local faucet.
    pub fn fund(&mut self, who: &str, xrge_quanta: &str) -> Result<(), JsError> {
        *self.balances.entry(canon(who)).or_insert(0) += parse_amount(xrge_quanta)?;
        Ok(())
    }

    /// Move XRGE (quanta) between accounts, like a wallet transfer (no fee locally).
    #[wasm_bindgen(js_name = transferXrge)]
    pub fn transfer_xrge(&mut self, from: &str, to: &str, quanta: &str) -> Result<(), JsError> {
        let amount = parse_amount(quanta)?;
        let from = canon(from);
        let have = *self.balances.get(&from).unwrap_or(&0);
        if have < amount {
            return Err(JsError::new(&format!("{from} has {have} quanta, sending {amount}")));
        }
        self.balances.insert(from, have - amount);
        *self.balances.entry(canon(to)).or_insert(0) += amount;
        self.next_block(1);
        Ok(())
    }

    /// Create a token with its whole supply on the creator (raw units).
    #[wasm_bindgen(js_name = createToken)]
    pub fn create_token(&mut self, creator: &str, symbol: &str, supply: &str) -> Result<(), JsError> {
        let symbol = symbol.trim().to_uppercase();
        if symbol.is_empty() || symbol == "XRGE" || self.tokens.keys().any(|(_, s)| *s == symbol) {
            return Err(JsError::new(&format!("token symbol {symbol:?} is taken or invalid")));
        }
        *self.tokens.entry((canon(creator), symbol)).or_insert(0) += parse_amount(supply)?;
        self.next_block(1);
        Ok(())
    }

    #[wasm_bindgen(js_name = transferToken)]
    pub fn transfer_token(&mut self, from: &str, to: &str, symbol: &str, amount: &str) -> Result<(), JsError> {
        let amount = parse_amount(amount)?;
        let key = (canon(from), symbol.to_uppercase());
        let have = *self.tokens.get(&key).unwrap_or(&0);
        if have < amount {
            return Err(JsError::new(&format!("{} has {have} {}, sending {amount}", key.0, key.1)));
        }
        self.tokens.insert(key, have - amount);
        *self.tokens.entry((canon(to), symbol.to_uppercase())).or_insert(0) += amount;
        self.next_block(1);
        Ok(())
    }

    /// Create an NFT collection as a wallet would (`nft_create_collection`). Returns its id.
    #[wasm_bindgen(js_name = createCollection)]
    pub fn create_collection(
        &mut self,
        creator: &str,
        symbol: &str,
        name: &str,
        max_supply: Option<u64>,
        royalty_bps: u16,
        royalty_recipient: Option<String>,
    ) -> Result<String, JsError> {
        if royalty_bps > game::ROYALTY_BPS_MAX {
            return Err(JsError::new("royalty above 100 % (10000 bps) is refused"));
        }
        let id = game::collection_id(creator, symbol);
        if self.collections.contains_key(&id) {
            return Err(JsError::new(&format!("collection {id} already exists")));
        }
        self.collections.insert(id.clone(), Collection {
            id: id.clone(),
            symbol: symbol.to_uppercase(),
            name: name.to_string(),
            creator: creator.to_string(),
            max_supply,
            minted: 0,
            royalty_bps,
            royalty_recipient: royalty_recipient.map(|r| canon(&r)).unwrap_or_else(|| canon(creator)),
            frozen: false,
        });
        self.next_block(1);
        Ok(id)
    }

    /// Mint the next NFT of a collection (creator only). Returns the token id.
    #[wasm_bindgen(js_name = mintNft)]
    pub fn mint_nft(&mut self, minter: &str, collection: &str, to: &str, name: &str) -> Result<u64, JsError> {
        let col = self.collections.get_mut(collection).ok_or_else(|| JsError::new("collection not found"))?;
        if canon(&col.creator) != canon(minter) {
            return Err(JsError::new("only the collection's creator can mint"));
        }
        if col.max_supply.map_or(false, |m| col.minted >= m) {
            return Err(JsError::new("collection is at its max supply"));
        }
        col.minted += 1;
        let token_id = col.minted;
        self.nfts.insert((collection.to_string(), token_id), Nft {
            collection: collection.to_string(),
            token_id,
            owner: to.to_string(),
            name: name.to_string(),
            locked: false,
            metadata: None,
        });
        self.next_block(1);
        Ok(token_id)
    }

    /// Wallet `nft_transfer` (no sale price): the owner sends an NFT to an account or a contract.
    #[wasm_bindgen(js_name = transferNft)]
    pub fn transfer_nft(&mut self, from: &str, collection: &str, token_id: u64, to: &str) -> Result<(), JsError> {
        let nft = self
            .nfts
            .get_mut(&(collection.to_string(), token_id))
            .ok_or_else(|| JsError::new("NFT not found"))?;
        if canon(&nft.owner) != canon(from) {
            return Err(JsError::new("only the NFT's owner can send it"));
        }
        if nft.locked {
            return Err(JsError::new("NFT is locked"));
        }
        nft.owner = to.to_string();
        self.next_block(1);
        Ok(())
    }

    /// Deploy a contract. Same checks as the node (size, compiles, exports `memory`).
    /// Returns `{ address, codeHash, size }`.
    pub fn deploy(&mut self, deployer: &str, bytecode: &[u8]) -> Result<JsValue, JsError> {
        self.rt.validate_contract_wasm(bytecode).map_err(|e| JsError::new(&e))?;
        let nonce = self.deploy_nonce.entry(deployer.to_string()).or_insert(0);
        let address = self
            .rt
            .deploy_contract(&self.store, deployer, *nonce, bytecode, self.height)
            .map_err(|e| JsError::new(&e))?;
        *nonce += 1;
        self.next_block(1);
        to_js(&json!({
            "address": address,
            "codeHash": hex::encode(Sha256::digest(bytecode)),
            "size": bytecode.len(),
        }))
    }

    /// A mutating contract call signed by `caller` (a public key, as on chain), optionally paying
    /// `attach_amount` of `attach_symbol` (XRGE in quanta, tokens in raw units). Returns the VM
    /// result plus `applied` (whether its moves reached the ledger) and the block it ran in.
    pub fn call(
        &mut self,
        caller: &str,
        contract: &str,
        method: &str,
        args_json: &str,
        attach_symbol: Option<String>,
        attach_amount: Option<String>,
        gas_limit: Option<u64>,
    ) -> Result<JsValue, JsError> {
        let args: Value = serde_json::from_str(if args_json.trim().is_empty() { "{}" } else { args_json })
            .map_err(|e| JsError::new(&format!("arguments are not JSON: {e}")))?;
        if self.store.get_contract(contract).map_err(|e| JsError::new(&e))?.is_none() {
            return Err(JsError::new(&format!("no contract at {contract}")));
        }
        let payer = canon(caller);
        let attach = match (attach_symbol, attach_amount) {
            (Some(s), Some(a)) if !s.trim().is_empty() && !a.trim().is_empty() => {
                Some((s.trim().to_uppercase(), parse_amount(&a)?))
            }
            _ => None,
        };

        self.tx_counter += 1;
        let tx_hash = hex::encode(Sha256::digest(format!("local-tx-{}", self.tx_counter)));
        self.next_block(1);

        let mut call_balances = self.balances.clone();
        let mut view_tokens = self.tokens.clone();
        if let Some((sym, amt)) = &attach {
            let have = if sym == "XRGE" {
                *self.balances.get(&payer).unwrap_or(&0)
            } else {
                *self.tokens.get(&(payer.clone(), sym.clone())).unwrap_or(&0)
            };
            if have < *amt {
                return to_js(&json!({
                    "success": false, "applied": false, "block": self.height, "txHash": tx_hash,
                    "error": format!("insufficient {sym} for the attached payment — not executed"),
                }));
            }
            if sym == "XRGE" {
                *call_balances.entry(payer.clone()).or_insert(0) -= amt;
                *call_balances.entry(contract.to_string()).or_insert(0) += amt;
            } else {
                *view_tokens.entry((payer.clone(), sym.clone())).or_insert(0) -= amt;
                *view_tokens.entry((contract.to_string(), sym.clone())).or_insert(0) += amt;
            }
        }
        let prev_hash = self.block_hashes.get(&(self.height - 1)).cloned().unwrap_or_default();
        let ext = self.game_ext(view_tokens, game::random_seed(&prev_hash, &tx_hash), attach.clone());
        let result = self
            .rt
            .execute_contract_ext(
                &self.store,
                contract,
                method,
                &args,
                caller,
                self.height,
                self.time,
                call_balances,
                gas_limit.unwrap_or(quantum_vault_vm::DEFAULT_FUEL_LIMIT),
                &tx_hash,
                Some(ext),
            )
            .map_err(|e| JsError::new(&e))?;

        let mut applied = false;
        let mut apply_error = None;
        if result.success {
            match self.apply(&payer, contract, &attach, &result.balance_deltas, &result.effects) {
                Ok(()) => applied = true,
                Err(e) => apply_error = Some(e),
            }
        }
        let mut out = serde_json::to_value(&result).map_err(|e| JsError::new(&e.to_string()))?;
        if let Value::Object(ref mut m) = out {
            m.insert("applied".into(), json!(applied));
            m.insert("block".into(), json!(self.height));
            m.insert("txHash".into(), json!(tx_hash));
            if let Some(e) = apply_error {
                // The node would reject the whole block here; locally the call is undone.
                m.insert("success".into(), json!(false));
                m.insert("error".into(), json!(format!("rejected by the ledger checks: {e}")));
            }
        }
        to_js(&out)
    }

    /// A read-only call (the node's `/api/contract/:addr/query`): nothing is committed.
    pub fn query(&self, caller: &str, contract: &str, method: &str, args_json: &str) -> Result<JsValue, JsError> {
        let args: Value = serde_json::from_str(if args_json.trim().is_empty() { "{}" } else { args_json })
            .map_err(|e| JsError::new(&format!("arguments are not JSON: {e}")))?;
        let ext = self.game_ext(self.tokens.clone(), [0u8; 32], None);
        let result = self
            .rt
            .query_contract_ext(&self.store, contract, method, &args, caller, self.balances.clone(), self.height, self.time, Some(ext))
            .map_err(|e| JsError::new(&e))?;
        to_js(&result)
    }

    /// A contract's storage: `[{ key, value }]` as hex.
    pub fn storage(&self, contract: &str) -> Result<JsValue, JsError> {
        let state = self.store.load_all_state(contract).map_err(|e| JsError::new(&e))?;
        let mut rows: Vec<Value> = state
            .into_iter()
            .map(|(k, v)| json!({ "key": hex::encode(k), "value": hex::encode(v) }))
            .collect();
        rows.sort_by(|a, b| a["key"].as_str().cmp(&b["key"].as_str()));
        to_js(&rows)
    }

    /// A contract's events, most recent first.
    pub fn events(&self, contract: &str, limit: usize) -> Result<JsValue, JsError> {
        let events = self.store.get_events(contract, limit).map_err(|e| JsError::new(&e))?;
        to_js(&events)
    }

    /// Everything the IDE shows: height, XRGE (quanta, as strings), tokens, collections, NFTs, contracts.
    pub fn snapshot(&self) -> Result<JsValue, JsError> {
        let mut xrge: Vec<(&String, &u128)> = self.balances.iter().filter(|(_, v)| **v > 0).collect();
        xrge.sort();
        let mut tokens: Vec<Value> = self
            .tokens
            .iter()
            .filter(|(_, v)| **v > 0)
            .map(|((o, s), v)| json!({ "owner": o, "symbol": s, "amount": v.to_string() }))
            .collect();
        tokens.sort_by(|a, b| (a["symbol"].as_str(), a["owner"].as_str()).cmp(&(b["symbol"].as_str(), b["owner"].as_str())));
        let contracts = self.store.list_contracts().map_err(|e| JsError::new(&e))?;
        to_js(&json!({
            "chainId": self.chain_id,
            "height": self.height,
            "time": self.time,
            "xrge": xrge.into_iter().map(|(a, v)| json!({ "address": a, "quanta": v.to_string() })).collect::<Vec<_>>(),
            "tokens": tokens,
            "collections": self.collections.values().collect::<Vec<_>>(),
            "nfts": self.nfts.values().map(|n| {
                let mut v = serde_json::to_value(n).unwrap_or(Value::Null);
                v["ownerAddress"] = json!(canon(&n.owner));
                v
            }).collect::<Vec<_>>(),
            "contracts": contracts,
        }))
    }

    /// Canonical address of a public key or address (what the ledger keys balances by).
    #[wasm_bindgen(js_name = addressOf)]
    pub fn address_of_js(&self, who: &str) -> String {
        canon(who)
    }

    /// Advance the clock (seconds) — e.g. to pass a contract's unstake delay.
    #[wasm_bindgen(js_name = advanceTime)]
    pub fn advance_time(&mut self, seconds: u64) {
        self.time += seconds;
        self.next_block(0);
    }

    #[wasm_bindgen(js_name = quantaPerXrge)]
    pub fn quanta_per_xrge() -> String {
        QUANTA_PER_XRGE.to_string()
    }
}

impl LocalChain {
    /// Close the current block: record its hash (for `host_block_hash`) and move on.
    fn next_block(&mut self, seconds: u64) {
        let parent = self.block_hashes.get(&self.height).cloned().unwrap_or_default();
        self.height += 1;
        self.time += seconds;
        let hash = hex::encode(Sha256::digest(format!("local-block|{}|{}|{}", self.chain_id, self.height, parent)));
        self.block_hashes.insert(self.height, hash);
    }

    fn game_ext(&self, tokens: HashMap<(String, String), u128>, seed: [u8; 32], attached: Option<(String, u128)>) -> GameExt {
        // Only blocks before the current one are "accepted" (the node serves past hashes).
        let past = self.block_hashes.iter().filter(|(h, _)| **h < self.height).map(|(h, v)| (*h, v.clone())).collect();
        GameExt {
            view: Arc::new(View { tokens, collections: self.collections.clone(), nfts: self.nfts.clone(), block_hashes: past }),
            seed,
            block_hashes: true,
            payable: true,
            nft_royalty: true,
            chain_id: Some(self.chain_id.clone()),
            attached,
        }
    }

    /// Apply a successful call to the ledger with the node's checks; all or nothing.
    fn apply(
        &mut self,
        payer: &str,
        contract: &str,
        attach: &Option<(String, u128)>,
        deltas: &Option<Vec<(String, i128)>>,
        effects: &Option<Vec<ChainEffect>>,
    ) -> Result<(), String> {
        let mut balances = self.balances.clone();
        let mut tokens = self.tokens.clone();
        let mut collections = self.collections.clone();
        let mut nfts = self.nfts.clone();

        if let Some((sym, amt)) = attach {
            if sym == "XRGE" {
                let bal = balances.entry(payer.to_string()).or_insert(0);
                *bal = bal.checked_sub(*amt).ok_or("attached XRGE exceeds the caller's balance")?;
                *balances.entry(contract.to_string()).or_insert(0) += amt;
            } else {
                let bal = tokens.entry((payer.to_string(), sym.clone())).or_insert(0);
                *bal = bal.checked_sub(*amt).ok_or("attached tokens exceed the caller's balance")?;
                *tokens.entry((contract.to_string(), sym.clone())).or_insert(0) += amt;
            }
        }
        if let Some(deltas) = deltas {
            // The node's `apply_balance_deltas`: the moves must net to zero and overdraw no one.
            let sum: i128 = deltas.iter().map(|(_, d)| *d).sum();
            if sum != 0 {
                return Err(format!("XRGE moves do not net to zero ({sum})"));
            }
            let mut net: HashMap<&str, i128> = HashMap::new();
            for (addr, d) in deltas {
                *net.entry(addr.as_str()).or_insert(0) += d;
            }
            for (addr, d) in net {
                let bal = balances.entry(addr.to_string()).or_insert(0);
                let next = *bal as i128 + d;
                if next < 0 {
                    return Err(format!("{addr} would be overdrawn"));
                }
                *bal = next as u128;
            }
        }
        for e in effects.iter().flatten() {
            match e {
                ChainEffect::TokenTransfer { symbol, from, to, amount } => {
                    let key = (canon(from), symbol.clone());
                    let have = *tokens.get(&key).unwrap_or(&0);
                    if have < *amount {
                        return Err(format!("token overdraft: {from} has {have} {symbol}, moving {amount}"));
                    }
                    tokens.insert(key, have - amount);
                    *tokens.entry((canon(to), symbol.clone())).or_insert(0) += amount;
                }
                ChainEffect::NftCreateCollection { collection_id, symbol, name, creator, max_supply } => {
                    if collections.contains_key(collection_id) {
                        return Err(format!("collection {collection_id} already exists"));
                    }
                    collections.insert(collection_id.clone(), Collection {
                        id: collection_id.clone(),
                        symbol: symbol.clone(),
                        name: name.clone(),
                        creator: creator.clone(),
                        max_supply: *max_supply,
                        minted: 0,
                        royalty_bps: 0,
                        royalty_recipient: creator.clone(),
                        frozen: false,
                    });
                }
                ChainEffect::NftMint { collection_id, token_id, to, name, metadata } => {
                    let col = collections.get_mut(collection_id).ok_or_else(|| format!("collection {collection_id} not found"))?;
                    if col.minted + 1 != *token_id {
                        return Err(format!("mint id {token_id} out of sequence for {collection_id}"));
                    }
                    col.minted = *token_id;
                    nfts.insert((collection_id.clone(), *token_id), Nft {
                        collection: collection_id.clone(),
                        token_id: *token_id,
                        owner: to.clone(),
                        name: name.clone(),
                        locked: false,
                        metadata: metadata.clone(),
                    });
                }
                ChainEffect::NftTransfer { collection_id, token_id, from, to } => {
                    let t = nfts
                        .get_mut(&(collection_id.clone(), *token_id))
                        .ok_or_else(|| format!("NFT {collection_id}:{token_id} not found"))?;
                    if t.owner != *from || t.locked {
                        return Err(format!("NFT {collection_id}:{token_id} moved or locked since the call was checked"));
                    }
                    t.owner = to.clone();
                }
            }
        }
        self.balances = balances;
        self.tokens = tokens;
        self.collections = collections;
        self.nfts = nfts;
        Ok(())
    }
}

fn to_js<T: Serialize + ?Sized>(v: &T) -> Result<JsValue, JsError> {
    // JSON text → JS object (keeps u128 amounts as strings where we produced them).
    let text = serde_json::to_string(v).map_err(|e| JsError::new(&e.to_string()))?;
    js_sys_parse(&text)
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = JSON, js_name = parse, catch)]
    fn json_parse(text: &str) -> Result<JsValue, JsValue>;
}

fn js_sys_parse(text: &str) -> Result<JsValue, JsError> {
    json_parse(text).map_err(|_| JsError::new("internal: result is not JSON"))
}
