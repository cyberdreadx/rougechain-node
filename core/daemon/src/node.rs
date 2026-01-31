use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use chrono::Utc;

use quantum_vault_consensus::{compute_selection_seed, fetch_entropy, select_proposer, ProposerSelectionResult};
use quantum_vault_crypto::{bytes_to_hex, pqc_keygen, pqc_sign, pqc_verify, sha256};
use quantum_vault_storage::chain_store::ChainStore;
use quantum_vault_storage::messenger_store::{Conversation, MessengerMessage, MessengerStore, MessengerWallet};
use quantum_vault_storage::validator_store::{ValidatorState, ValidatorStore};
use quantum_vault_types::{
    compute_block_hash, compute_tx_hash, encode_header_v1, encode_tx_v1, BlockHeaderV1, BlockV1,
    ChainConfig, PQKeypair, SlashPayload, TxPayload, TxV1, VoteMessage,
};

use crate::amm;
use crate::pool_store::{LiquidityPool, PoolStore};
use crate::pool_events::{PoolEvent, PoolEventStore, PoolEventType, PriceSnapshot};

const BASE_TRANSFER_FEE: f64 = 0.1;
const TOKEN_CREATION_FEE: f64 = 100.0;
const POOL_CREATION_FEE: f64 = 10.0;
const SWAP_FEE: f64 = 0.1;
const JAIL_BLOCKS: u64 = 20;
const SLASH_DIVISOR: u128 = 10;
const MAX_MEMPOOL: usize = 2000;

#[derive(Clone)]
pub struct NodeOptions {
    pub data_dir: PathBuf,
    pub chain: ChainConfig,
    pub mine: bool,
}

/// Key for token balances: (public_key, token_symbol)
type TokenBalanceKey = (String, String);

#[derive(Clone)]
pub struct L1Node {
    node_id: String,
    opts: NodeOptions,
    store: ChainStore,
    validator_store: ValidatorStore,
    messenger_store: MessengerStore,
    pool_store: PoolStore,
    pool_event_store: PoolEventStore,
    keys: Arc<Mutex<PQKeypair>>,
    mempool: Arc<Mutex<HashMap<String, TxV1>>>,
    balances: Arc<Mutex<HashMap<String, f64>>>,
    token_balances: Arc<Mutex<HashMap<TokenBalanceKey, f64>>>,
    lp_balances: Arc<Mutex<HashMap<TokenBalanceKey, f64>>>,  // LP token balances
    votes: Arc<Mutex<Vec<VoteMessage>>>,
    finalized_height: Arc<Mutex<u64>>,
}

impl L1Node {
    pub fn new(opts: NodeOptions) -> Result<Self, String> {
        let store = ChainStore::new(&opts.data_dir, opts.chain.clone());
        let validator_store = ValidatorStore::new(&opts.data_dir)?;
        let messenger_store = MessengerStore::new(&opts.data_dir);
        let pool_store = PoolStore::new(&opts.data_dir)?;
        let pool_event_store = PoolEventStore::new(&opts.data_dir)?;
        let keys = pqc_keygen();
        Ok(Self {
            node_id: uuid::Uuid::new_v4().to_string(),
            opts,
            store,
            validator_store,
            messenger_store,
            pool_store,
            pool_event_store,
            keys: Arc::new(Mutex::new(keys)),
            mempool: Arc::new(Mutex::new(HashMap::new())),
            balances: Arc::new(Mutex::new(HashMap::new())),
            token_balances: Arc::new(Mutex::new(HashMap::new())),
            lp_balances: Arc::new(Mutex::new(HashMap::new())),
            votes: Arc::new(Mutex::new(Vec::new())),
            finalized_height: Arc::new(Mutex::new(0)),
        })
    }

    pub fn init(&self) -> Result<(), String> {
        self.store.init()?;
        self.messenger_store.init()?;
        self.rebuild_balances()?;
        self.rebuild_token_balances()?;
        let tip = self.store.get_tip()?;
        *self.finalized_height.lock().map_err(|_| "finality lock")? = tip.height;
        Ok(())
    }

    pub fn node_id(&self) -> String {
        self.node_id.clone()
    }

    pub fn is_mining(&self) -> bool {
        self.opts.mine
    }

    pub fn chain_id(&self) -> String {
        self.opts.chain.chain_id.clone()
    }

    pub fn get_tip_height(&self) -> Result<u64, String> {
        Ok(self.store.get_tip()?.height)
    }

    pub fn get_all_blocks(&self) -> Result<Vec<BlockV1>, String> {
        self.store.get_all_blocks()
    }

    pub fn get_block(&self, height: u64) -> Result<Option<BlockV1>, String> {
        self.store.get_block(height)
    }

    /// Reset the chain with blocks from a peer (used for initial sync when genesis differs)
    pub fn reset_chain(&self, blocks: &[BlockV1]) -> Result<(), String> {
        if blocks.is_empty() {
            return Err("Cannot reset with empty chain".to_string());
        }
        
        // Clear and replace the chain file
        self.store.reset_chain(blocks)?;
        
        // Reset balances
        let mut balances = self.balances.lock().map_err(|_| "balance lock")?;
        let mut token_balances = self.token_balances.lock().map_err(|_| "token balance lock")?;
        let mut lp_balances = self.lp_balances.lock().map_err(|_| "lp balance lock")?;
        balances.clear();
        token_balances.clear();
        lp_balances.clear();
        
        // Replay all transactions to rebuild balances with fee distribution
        for block in blocks {
            // Apply transaction effects
            for tx in &block.txs {
                Self::apply_balance_tx_inner(&mut balances, &mut token_balances, tx);
                Self::apply_amm_balance_effects(
                    &mut balances,
                    &mut token_balances,
                    &mut lp_balances,
                    tx,
                    &self.pool_store,
                );
            }
            
            // Distribute fees for this block
            let total_fees: f64 = block.txs.iter().map(|tx| tx.fee).sum();
            if total_fees > 0.0 {
                let stakes = self.get_validator_stakes_at_height(block.header.height)?;
                Self::distribute_fees(
                    &mut balances,
                    total_fees,
                    &block.header.proposer_pub_key,
                    &stakes,
                );
            }
        }
        
        eprintln!("[node] Chain reset complete - now at height {}", blocks.last().map(|b| b.header.height).unwrap_or(0));
        Ok(())
    }

    pub fn get_recent_blocks(&self, limit: usize) -> Result<Vec<BlockV1>, String> {
        let blocks = self.store.get_all_blocks()?;
        if limit == 0 || blocks.len() <= limit {
            return Ok(blocks);
        }
        Ok(blocks[blocks.len() - limit..].to_vec())
    }

    /// Import a block from a peer (for P2P sync)
    pub fn import_block(&self, block: BlockV1) -> Result<(), String> {
        let tip = self.store.get_tip()?;
        
        // Only accept blocks that extend our chain
        if block.header.height != tip.height + 1 {
            return Err(format!(
                "Block height {} doesn't extend tip height {}",
                block.header.height, tip.height
            ));
        }
        
        // Verify previous hash matches our tip
        if block.header.prev_hash != tip.hash {
            return Err("Block prev_hash doesn't match our tip".to_string());
        }
        
        // TODO: Verify proposer signature
        // TODO: Verify all transaction signatures
        
        // Store the block
        self.store.append_block(&block)?;
        
        // Apply transactions and distribute fees
        self.apply_balance_block(&block)?;
        
        // Apply validator state changes
        self.apply_validator_block(&block)?;
        
        eprintln!("[node] Imported block {} from peer", block.header.height);
        Ok(())
    }

    pub fn get_balance(&self, public_key: &str) -> Result<f64, String> {
        let balances = self.balances.lock().map_err(|_| "balance lock")?;
        Ok(*balances.get(public_key).unwrap_or(&0.0))
    }

    pub fn get_token_balance(&self, public_key: &str, token_symbol: &str) -> Result<f64, String> {
        let token_balances = self.token_balances.lock().map_err(|_| "token balance lock")?;
        let key = (public_key.to_string(), token_symbol.to_string());
        Ok(*token_balances.get(&key).unwrap_or(&0.0))
    }

    pub fn get_all_token_balances(&self, public_key: &str) -> Result<HashMap<String, f64>, String> {
        let token_balances = self.token_balances.lock().map_err(|_| "token balance lock")?;
        let mut result = HashMap::new();
        for ((pubkey, symbol), balance) in token_balances.iter() {
            if pubkey == public_key && *balance > 0.0 {
                result.insert(symbol.clone(), *balance);
            }
        }
        Ok(result)
    }

    // ===== AMM/DEX Methods =====
    
    pub fn get_lp_balance(&self, public_key: &str, pool_id: &str) -> Result<f64, String> {
        let lp_balances = self.lp_balances.lock().map_err(|_| "lp balance lock")?;
        let key = (public_key.to_string(), pool_id.to_string());
        Ok(*lp_balances.get(&key).unwrap_or(&0.0))
    }

    pub fn get_all_lp_balances(&self, public_key: &str) -> Result<HashMap<String, f64>, String> {
        let lp_balances = self.lp_balances.lock().map_err(|_| "lp balance lock")?;
        let mut result = HashMap::new();
        for ((pubkey, pool_id), balance) in lp_balances.iter() {
            if pubkey == public_key && *balance > 0.0 {
                result.insert(pool_id.clone(), *balance);
            }
        }
        Ok(result)
    }

    pub fn get_pool(&self, pool_id: &str) -> Result<Option<LiquidityPool>, String> {
        self.pool_store.get_pool(pool_id)
    }

    pub fn get_pool_by_tokens(&self, token_a: &str, token_b: &str) -> Result<Option<LiquidityPool>, String> {
        self.pool_store.get_pool_by_tokens(token_a, token_b)
    }

    pub fn list_pools(&self) -> Result<Vec<LiquidityPool>, String> {
        self.pool_store.list_pools()
    }

    pub fn get_pool_events(&self, pool_id: &str, limit: usize) -> Result<Vec<PoolEvent>, String> {
        self.pool_event_store.get_pool_events(pool_id, limit)
    }

    pub fn get_all_pool_events(&self, limit: usize) -> Result<Vec<PoolEvent>, String> {
        self.pool_event_store.get_all_events(limit)
    }

    pub fn get_pool_price_history(&self, pool_id: &str, limit: usize) -> Result<Vec<PriceSnapshot>, String> {
        self.pool_event_store.get_price_history(pool_id, limit)
    }

    pub fn get_pool_stats(&self, pool_id: &str) -> Result<crate::pool_events::PoolStats, String> {
        self.pool_event_store.get_pool_stats(pool_id)
    }

    pub fn get_swap_quote(
        &self,
        token_in: &str,
        token_out: &str,
        amount_in: u64,
    ) -> Result<Option<amm::SwapRoute>, String> {
        let pools = self.pool_store.list_pools()?;
        Ok(amm::find_best_route(token_in, token_out, amount_in, &pools, 3))
    }

    pub fn create_wallet(&self) -> PQKeypair {
        pqc_keygen()
    }

    /// Add a transaction to mempool (used for P2P broadcast)
    pub fn add_tx_to_mempool(&self, tx: TxV1) -> Result<(), String> {
        use quantum_vault_crypto::{sha256, bytes_to_hex};
        use quantum_vault_types::encode_tx_v1;
        
        let tx_hash = bytes_to_hex(&sha256(&encode_tx_v1(&tx)));
        
        let mut mempool = self.mempool.lock().map_err(|_| "mempool lock")?;
        
        // Skip if already in mempool
        if mempool.contains_key(&tx_hash) {
            return Ok(());
        }
        
        // TODO: Verify signature before adding
        
        mempool.insert(tx_hash, tx);
        Ok(())
    }

    pub fn submit_user_tx(
        &self,
        from_private_key: &str,
        from_public_key: &str,
        to_public_key: &str,
        amount: f64,
        fee: Option<f64>,
        token_symbol: Option<&str>,
    ) -> Result<TxV1, String> {
        let tx_fee = fee.unwrap_or(BASE_TRANSFER_FEE);
        
        // For XRGE transfers, check XRGE balance for amount + fee
        // For token transfers, check XRGE balance for fee only (token balance check is done separately)
        let is_token_transfer = token_symbol.is_some();
        let xrge_required = if is_token_transfer { tx_fee } else { amount + tx_fee };
        
        // Check sender has sufficient XRGE balance for fee
        let sender_balance = self.get_balance(from_public_key)?;
        if sender_balance < xrge_required {
            return Err(format!(
                "insufficient XRGE balance: have {:.4} XRGE, need {:.4} XRGE for {}",
                sender_balance, xrge_required, if is_token_transfer { "fee" } else { "transfer + fee" }
            ));
        }
        
        // TODO: For token transfers, verify sender has sufficient token balance
        // This requires tracking token balances separately
        
        // Convert f64 to u64 (round to nearest integer for on-chain storage)
        let amount_u64 = amount.round() as u64;
        
        let mut tx = TxV1 {
            version: 1,
            tx_type: "transfer".to_string(),
            from_pub_key: from_public_key.to_string(),
            nonce: Utc::now().timestamp_millis() as u64,
            payload: TxPayload {
                to_pub_key_hex: Some(to_public_key.to_string()),
                amount: Some(amount_u64),
                faucet: None,
                target_pub_key: None,
                reason: None,
                token_name: None,
                token_symbol: token_symbol.map(|s| s.to_string()),
                token_decimals: None,
                token_total_supply: None,
                pool_id: None,
                token_a_symbol: None,
                token_b_symbol: None,
                amount_a: None,
                amount_b: None,
                min_amount_out: None,
                swap_path: None,
                lp_amount: None,
            },
            fee: tx_fee,
            sig: String::new(),
        };
        let bytes = encode_tx_v1(&tx);
        tx.sig = pqc_sign(from_private_key, &bytes)?;
        let ok = pqc_verify(from_public_key, &bytes, &tx.sig)?;
        if !ok {
            return Err("invalid signature".to_string());
        }
        self.accept_tx(tx.clone())?;
        Ok(tx)
    }

    pub fn submit_create_token_tx(
        &self,
        from_private_key: &str,
        from_public_key: &str,
        token_name: &str,
        token_symbol: &str,
        total_supply: u64,
        decimals: u8,
    ) -> Result<(TxV1, String), String> {
        let tx_fee = TOKEN_CREATION_FEE;
        
        // Check sender has sufficient balance for fee
        let sender_balance = self.get_balance(from_public_key)?;
        if sender_balance < tx_fee {
            return Err(format!(
                "insufficient balance for token creation fee: have {:.4} XRGE, need {:.4} XRGE",
                sender_balance, tx_fee
            ));
        }
        
        // Generate token address from creator's public key and symbol
        let token_address = format!("token:{}:{}", &from_public_key[..16], token_symbol.to_lowercase());
        
        let mut tx = TxV1 {
            version: 1,
            tx_type: "create_token".to_string(),
            from_pub_key: from_public_key.to_string(),
            nonce: Utc::now().timestamp_millis() as u64,
            payload: TxPayload {
                to_pub_key_hex: None,
                amount: Some(total_supply),
                faucet: None,
                target_pub_key: None,
                reason: None,
                token_name: Some(token_name.to_string()),
                token_symbol: Some(token_symbol.to_string()),
                token_decimals: Some(decimals),
                token_total_supply: Some(total_supply),
                pool_id: None,
                token_a_symbol: None,
                token_b_symbol: None,
                amount_a: None,
                amount_b: None,
                min_amount_out: None,
                swap_path: None,
                lp_amount: None,
            },
            fee: tx_fee,
            sig: String::new(),
        };
        let bytes = encode_tx_v1(&tx);
        tx.sig = pqc_sign(from_private_key, &bytes)?;
        let ok = pqc_verify(from_public_key, &bytes, &tx.sig)?;
        if !ok {
            return Err("invalid signature".to_string());
        }
        self.accept_tx(tx.clone())?;
        Ok((tx, token_address))
    }

    pub fn submit_faucet_tx(
        &self,
        recipient_public_key: &str,
        amount: u64,
    ) -> Result<TxV1, String> {
        let keys = self.keys.lock().map_err(|_| "keys lock")?.clone();
        let mut tx = TxV1 {
            version: 1,
            tx_type: "transfer".to_string(),
            from_pub_key: keys.public_key_hex.clone(),
            nonce: Utc::now().timestamp_millis() as u64,
            payload: TxPayload {
                to_pub_key_hex: Some(recipient_public_key.to_string()),
                amount: Some(amount),
                faucet: Some(true),
                target_pub_key: None,
                reason: None,
                token_name: None,
                token_symbol: None,
                token_decimals: None,
                token_total_supply: None,
                pool_id: None,
                token_a_symbol: None,
                token_b_symbol: None,
                amount_a: None,
                amount_b: None,
                min_amount_out: None,
                swap_path: None,
                lp_amount: None,
            },
            fee: 0.0,
            sig: String::new(),
        };
        let bytes = encode_tx_v1(&tx);
        tx.sig = pqc_sign(&keys.secret_key_hex, &bytes)?;
        self.accept_tx(tx.clone())?;
        Ok(tx)
    }

    pub fn submit_stake_tx(
        &self,
        from_private_key: &str,
        from_public_key: &str,
        amount: f64,
        fee: Option<f64>,
    ) -> Result<TxV1, String> {
        let tx_fee = fee.unwrap_or(BASE_TRANSFER_FEE);
        let total_required = amount + tx_fee;
        
        // Check sender has sufficient balance
        let sender_balance = self.get_balance(from_public_key)?;
        if sender_balance < total_required {
            return Err(format!(
                "insufficient balance: have {:.4} XRGE, need {:.4} XRGE ({:.4} + {:.4} fee)",
                sender_balance, total_required, amount, tx_fee
            ));
        }
        
        // Convert f64 to u64 (round to nearest integer for on-chain storage)
        let amount_u64 = amount.round() as u64;
        
        let mut tx = TxV1 {
            version: 1,
            tx_type: "stake".to_string(),
            from_pub_key: from_public_key.to_string(),
            nonce: Utc::now().timestamp_millis() as u64,
            payload: TxPayload {
                to_pub_key_hex: None,
                amount: Some(amount_u64),
                faucet: None,
                target_pub_key: None,
                reason: None,
                token_name: None,
                token_symbol: None,
                token_decimals: None,
                token_total_supply: None,
                pool_id: None,
                token_a_symbol: None,
                token_b_symbol: None,
                amount_a: None,
                amount_b: None,
                min_amount_out: None,
                swap_path: None,
                lp_amount: None,
            },
            fee: tx_fee,
            sig: String::new(),
        };
        let bytes = encode_tx_v1(&tx);
        tx.sig = pqc_sign(from_private_key, &bytes)?;
        let ok = pqc_verify(from_public_key, &bytes, &tx.sig)?;
        if !ok {
            return Err("invalid signature".to_string());
        }
        self.accept_tx(tx.clone())?;
        Ok(tx)
    }

    pub fn submit_unstake_tx(
        &self,
        from_private_key: &str,
        from_public_key: &str,
        amount: f64,
        fee: Option<f64>,
    ) -> Result<TxV1, String> {
        // Convert f64 to u64 (round to nearest integer for on-chain storage)
        let amount_u64 = amount.round() as u64;
        
        let mut tx = TxV1 {
            version: 1,
            tx_type: "unstake".to_string(),
            from_pub_key: from_public_key.to_string(),
            nonce: Utc::now().timestamp_millis() as u64,
            payload: TxPayload {
                to_pub_key_hex: None,
                amount: Some(amount_u64),
                faucet: None,
                target_pub_key: None,
                reason: None,
                token_name: None,
                token_symbol: None,
                token_decimals: None,
                token_total_supply: None,
                pool_id: None,
                token_a_symbol: None,
                token_b_symbol: None,
                amount_a: None,
                amount_b: None,
                min_amount_out: None,
                swap_path: None,
                lp_amount: None,
            },
            fee: fee.unwrap_or(BASE_TRANSFER_FEE),
            sig: String::new(),
        };
        let bytes = encode_tx_v1(&tx);
        tx.sig = pqc_sign(from_private_key, &bytes)?;
        let ok = pqc_verify(from_public_key, &bytes, &tx.sig)?;
        if !ok {
            return Err("invalid signature".to_string());
        }
        self.accept_tx(tx.clone())?;
        Ok(tx)
    }

    pub fn submit_vote(&self, vote: VoteMessage) -> Result<(), String> {
        self.votes.lock().map_err(|_| "votes lock")?.push(vote);
        Ok(())
    }

    pub fn submit_entropy(&self, public_key: &str) -> Result<(), String> {
        let mut state = self.validator_store.get_validator(public_key)?.unwrap_or(ValidatorState {
            stake: 0,
            slash_count: 0,
            jailed_until: 0,
            entropy_contributions: 0,
        });
        state.entropy_contributions += 1;
        self.validator_store.set_validator(public_key, &state)?;
        Ok(())
    }

    pub fn get_validator_set(&self) -> Result<(Vec<(String, ValidatorState)>, u128), String> {
        let tip = self.store.get_tip()?.height;
        let entries = self.validator_store.list_validators()?;
        let mut total = 0u128;
        let mut validators = Vec::new();
        for (public_key, state) in entries {
            if state.stake == 0 && state.slash_count == 0 {
                continue;
            }
            if state.jailed_until > tip {
                validators.push((public_key, ValidatorState { stake: state.stake, slash_count: state.slash_count, jailed_until: state.jailed_until, entropy_contributions: state.entropy_contributions }));
            } else {
                validators.push((public_key, state.clone()));
            }
            total += state.stake;
        }
        Ok((validators, total))
    }

    /// List all validators (for rate limiting tier checks)
    pub fn list_validators(&self) -> Result<Vec<(String, ValidatorState)>, String> {
        self.validator_store.list_validators()
    }

    pub fn get_selection_info(&self) -> Result<Option<ProposerSelectionResult>, String> {
        let tip = self.store.get_tip()?;
        let stakes = self.get_validator_stakes()?;
        let (entropy_hex, source) = fetch_entropy();
        let seed = compute_selection_seed(&entropy_hex, &tip.hash, tip.height + 1);
        Ok(select_proposer(&stakes, &seed, &entropy_hex, &source))
    }

    pub fn get_finality_status(&self) -> Result<(u64, u64, u128, u128), String> {
        let tip = self.store.get_tip()?.height;
        let total = self.get_validator_stakes()?.values().sum::<u128>();
        let quorum = if total == 0 { 0 } else { (total * 2 / 3) + 1 };
        let finalized = *self.finalized_height.lock().map_err(|_| "finality lock")?;
        Ok((finalized, tip, total, quorum))
    }

    pub fn get_vote_summary(&self, height: u64) -> Result<(u128, u128, Vec<VoteMessage>), String> {
        let total = self.get_validator_stakes()?.values().sum::<u128>();
        let quorum = if total == 0 { 0 } else { (total * 2 / 3) + 1 };
        let votes = self.votes.lock().map_err(|_| "votes lock")?
            .iter()
            .filter(|v| v.height == height)
            .cloned()
            .collect();
        Ok((total, quorum, votes))
    }

    pub fn get_vote_stats(&self) -> Result<Vec<(String, f64, f64, u64)>, String> {
        let votes = self.votes.lock().map_err(|_| "votes lock")?;
        let mut stats: HashMap<String, (u64, u64, u64)> = HashMap::new();
        let mut heights: Vec<u64> = votes.iter().map(|v| v.height).collect();
        heights.sort();
        heights.dedup();
        for vote in votes.iter() {
            let entry = stats.entry(vote.voter_pub_key.clone()).or_insert((0, 0, 0));
            if vote.vote_type == "prevote" {
                entry.0 += 1;
            } else {
                entry.1 += 1;
            }
            entry.2 = vote.height;
        }
        let total_heights = heights.len().max(1) as f64;
        Ok(stats
            .into_iter()
            .map(|(key, (prev, precommit, last))| {
                (
                    key,
                    (prev as f64 / total_heights) * 100.0,
                    (precommit as f64 / total_heights) * 100.0,
                    last,
                )
            })
            .collect())
    }

    pub fn get_fee_stats(&self) -> Result<(f64, f64), String> {
        let blocks = self.store.get_all_blocks()?;
        let total_fees = blocks.iter().map(|b| b.txs.iter().map(|tx| tx.fee).sum::<f64>()).sum();
        let last_fees = blocks
            .last()
            .map(|b| b.txs.iter().map(|tx| tx.fee).sum::<f64>())
            .unwrap_or(0.0);
        Ok((total_fees, last_fees))
    }

    pub fn mine_pending(&self) -> Result<Option<BlockV1>, String> {
        let mut mempool = self.mempool.lock().map_err(|_| "mempool lock")?;
        if mempool.is_empty() {
            return Ok(None);
        }
        let txs: Vec<TxV1> = mempool.values().cloned().collect();
        mempool.clear();
        let tip = self.store.get_tip()?;
        let header = BlockHeaderV1 {
            version: 1,
            chain_id: self.opts.chain.chain_id.clone(),
            height: tip.height + 1,
            time: Utc::now().timestamp_millis() as u64,
            prev_hash: tip.hash.clone(),
            tx_hash: compute_tx_hash(&txs),
            proposer_pub_key: self.keys.lock().map_err(|_| "keys lock")?.public_key_hex.clone(),
        };
        let header_bytes = encode_header_v1(&header);
        let proposer_sig = pqc_sign(&self.keys.lock().map_err(|_| "keys lock")?.secret_key_hex, &header_bytes)?;
        let hash = compute_block_hash(&header_bytes, &proposer_sig);
        let block = BlockV1 {
            version: 1,
            header,
            txs,
            proposer_sig,
            hash,
        };
        self.store.append_block(&block)?;
        self.apply_balance_block(&block)?;
        self.apply_validator_block(&block)?;
        *self.finalized_height.lock().map_err(|_| "finality lock")? = block.header.height;
        Ok(Some(block))
    }

    fn accept_tx(&self, tx: TxV1) -> Result<(), String> {
        let id = bytes_to_hex(&sha256(&encode_tx_v1(&tx)));
        let mut mempool = self.mempool.lock().map_err(|_| "mempool lock")?;
        if mempool.len() >= MAX_MEMPOOL {
            if let Some(oldest) = mempool.keys().next().cloned() {
                mempool.remove(&oldest);
            }
        }
        mempool.insert(id, tx);
        Ok(())
    }

    // Fee distribution constants
    const PROPOSER_FEE_SHARE: f64 = 0.25; // 25% to block proposer
    const VALIDATOR_FEE_SHARE: f64 = 0.75; // 75% split among all validators by stake

    fn apply_balance_block(&self, block: &BlockV1) -> Result<(), String> {
        let mut balances = self.balances.lock().map_err(|_| "balance lock")?;
        let mut token_balances = self.token_balances.lock().map_err(|_| "token balance lock")?;
        let mut lp_balances = self.lp_balances.lock().map_err(|_| "lp balance lock")?;
        
        // Apply transaction effects (transfers, stakes, etc.) - fees deducted from senders
        for tx in &block.txs {
            Self::apply_balance_tx_inner(&mut balances, &mut token_balances, tx);
            
            // Handle AMM transactions
            self.apply_amm_tx_inner(
                &mut balances,
                &mut token_balances,
                &mut lp_balances,
                tx,
                block.header.time,
                block.header.height,
            )?;
        }
        
        // Distribute fees: 25% to proposer, 75% split by stake
        let total_fees: f64 = block.txs.iter().map(|tx| tx.fee).sum();
        if total_fees > 0.0 {
            Self::distribute_fees(
                &mut balances,
                total_fees,
                &block.header.proposer_pub_key,
                &self.get_validator_stakes_snapshot()?,
            );
        }
        
        Ok(())
    }
    
    /// Apply AMM-specific transaction effects
    fn apply_amm_tx_inner(
        &self,
        balances: &mut HashMap<String, f64>,
        token_balances: &mut HashMap<TokenBalanceKey, f64>,
        lp_balances: &mut HashMap<TokenBalanceKey, f64>,
        tx: &TxV1,
        block_time: u64,
        block_height: u64,
    ) -> Result<(), String> {
        let tx_hash = bytes_to_hex(&sha256(&encode_tx_v1(tx)));
        
        match tx.tx_type.as_str() {
            "create_pool" => {
                let token_a = tx.payload.token_a_symbol.as_ref().ok_or("missing token_a")?;
                let token_b = tx.payload.token_b_symbol.as_ref().ok_or("missing token_b")?;
                let amount_a = tx.payload.amount_a.ok_or("missing amount_a")?;
                let amount_b = tx.payload.amount_b.ok_or("missing amount_b")?;
                
                // Deduct XRGE fee
                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
                
                // Deduct tokens from creator
                if token_a == "XRGE" {
                    *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= amount_a as f64;
                } else {
                    let key = (tx.from_pub_key.clone(), token_a.clone());
                    *token_balances.entry(key).or_insert(0.0) -= amount_a as f64;
                }
                
                if token_b == "XRGE" {
                    *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= amount_b as f64;
                } else {
                    let key = (tx.from_pub_key.clone(), token_b.clone());
                    *token_balances.entry(key).or_insert(0.0) -= amount_b as f64;
                }
                
                // Create pool
                let pool = LiquidityPool::new(
                    token_a.clone(),
                    token_b.clone(),
                    amount_a,
                    amount_b,
                    tx.from_pub_key.clone(),
                    block_time,
                );
                
                // Mint LP tokens to creator
                let lp_key = (tx.from_pub_key.clone(), pool.pool_id.clone());
                *lp_balances.entry(lp_key).or_insert(0.0) += pool.total_lp_supply as f64;
                
                self.pool_store.save_pool(&pool)?;
                
                // Save event
                let event = PoolEvent {
                    id: format!("{}-create", tx_hash),
                    pool_id: pool.pool_id.clone(),
                    event_type: PoolEventType::CreatePool,
                    user_pub_key: tx.from_pub_key.clone(),
                    timestamp: block_time,
                    block_height,
                    tx_hash: tx_hash.clone(),
                    token_in: None,
                    token_out: None,
                    amount_in: None,
                    amount_out: None,
                    amount_a: Some(amount_a),
                    amount_b: Some(amount_b),
                    lp_amount: Some(pool.total_lp_supply),
                    reserve_a_after: pool.reserve_a,
                    reserve_b_after: pool.reserve_b,
                };
                let _ = self.pool_event_store.save_event(&event);
                
                // Save price snapshot
                let price_a_in_b = if pool.reserve_a > 0 { pool.reserve_b as f64 / pool.reserve_a as f64 } else { 0.0 };
                let price_b_in_a = if pool.reserve_b > 0 { pool.reserve_a as f64 / pool.reserve_b as f64 } else { 0.0 };
                let snapshot = PriceSnapshot {
                    pool_id: pool.pool_id.clone(),
                    timestamp: block_time,
                    block_height,
                    reserve_a: pool.reserve_a,
                    reserve_b: pool.reserve_b,
                    price_a_in_b,
                    price_b_in_a,
                };
                let _ = self.pool_event_store.save_price_snapshot(&snapshot);
            }
            "add_liquidity" => {
                let pool_id = tx.payload.pool_id.as_ref().ok_or("missing pool_id")?;
                let amount_a = tx.payload.amount_a.ok_or("missing amount_a")?;
                let amount_b = tx.payload.amount_b.ok_or("missing amount_b")?;
                
                let mut pool = self.pool_store.get_pool(pool_id)?
                    .ok_or_else(|| format!("Pool not found: {}", pool_id))?;
                
                // Deduct fee
                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
                
                // Deduct tokens
                if pool.token_a == "XRGE" {
                    *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= amount_a as f64;
                } else {
                    let key = (tx.from_pub_key.clone(), pool.token_a.clone());
                    *token_balances.entry(key).or_insert(0.0) -= amount_a as f64;
                }
                
                if pool.token_b == "XRGE" {
                    *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= amount_b as f64;
                } else {
                    let key = (tx.from_pub_key.clone(), pool.token_b.clone());
                    *token_balances.entry(key).or_insert(0.0) -= amount_b as f64;
                }
                
                // Calculate LP tokens to mint
                let lp_amount = amm::calculate_lp_mint(
                    amount_a,
                    amount_b,
                    pool.reserve_a,
                    pool.reserve_b,
                    pool.total_lp_supply,
                ).ok_or("Failed to calculate LP mint")?;
                
                // Update pool
                pool.reserve_a += amount_a;
                pool.reserve_b += amount_b;
                pool.total_lp_supply += lp_amount;
                self.pool_store.save_pool(&pool)?;
                
                // Mint LP tokens
                let lp_key = (tx.from_pub_key.clone(), pool_id.clone());
                *lp_balances.entry(lp_key).or_insert(0.0) += lp_amount as f64;
                
                // Save event
                let event = PoolEvent {
                    id: format!("{}-add", tx_hash),
                    pool_id: pool_id.clone(),
                    event_type: PoolEventType::AddLiquidity,
                    user_pub_key: tx.from_pub_key.clone(),
                    timestamp: block_time,
                    block_height,
                    tx_hash: tx_hash.clone(),
                    token_in: None,
                    token_out: None,
                    amount_in: None,
                    amount_out: None,
                    amount_a: Some(amount_a),
                    amount_b: Some(amount_b),
                    lp_amount: Some(lp_amount),
                    reserve_a_after: pool.reserve_a,
                    reserve_b_after: pool.reserve_b,
                };
                let _ = self.pool_event_store.save_event(&event);
                
                // Save price snapshot
                let price_a_in_b = if pool.reserve_a > 0 { pool.reserve_b as f64 / pool.reserve_a as f64 } else { 0.0 };
                let price_b_in_a = if pool.reserve_b > 0 { pool.reserve_a as f64 / pool.reserve_b as f64 } else { 0.0 };
                let snapshot = PriceSnapshot {
                    pool_id: pool_id.clone(),
                    timestamp: block_time,
                    block_height,
                    reserve_a: pool.reserve_a,
                    reserve_b: pool.reserve_b,
                    price_a_in_b,
                    price_b_in_a,
                };
                let _ = self.pool_event_store.save_price_snapshot(&snapshot);
            }
            "remove_liquidity" => {
                let pool_id = tx.payload.pool_id.as_ref().ok_or("missing pool_id")?;
                let lp_amount = tx.payload.lp_amount.ok_or("missing lp_amount")?;
                
                let mut pool = self.pool_store.get_pool(pool_id)?
                    .ok_or_else(|| format!("Pool not found: {}", pool_id))?;
                
                // Deduct fee
                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
                
                // Calculate tokens to return
                let (amount_a, amount_b) = amm::calculate_remove_liquidity(
                    lp_amount,
                    pool.reserve_a,
                    pool.reserve_b,
                    pool.total_lp_supply,
                ).ok_or("Failed to calculate remove liquidity")?;
                
                // Burn LP tokens
                let lp_key = (tx.from_pub_key.clone(), pool_id.clone());
                *lp_balances.entry(lp_key).or_insert(0.0) -= lp_amount as f64;
                
                // Return tokens
                if pool.token_a == "XRGE" {
                    *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) += amount_a as f64;
                } else {
                    let key = (tx.from_pub_key.clone(), pool.token_a.clone());
                    *token_balances.entry(key).or_insert(0.0) += amount_a as f64;
                }
                
                if pool.token_b == "XRGE" {
                    *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) += amount_b as f64;
                } else {
                    let key = (tx.from_pub_key.clone(), pool.token_b.clone());
                    *token_balances.entry(key).or_insert(0.0) += amount_b as f64;
                }
                
                // Update pool
                pool.reserve_a -= amount_a;
                pool.reserve_b -= amount_b;
                pool.total_lp_supply -= lp_amount;
                self.pool_store.save_pool(&pool)?;
                
                // Save event
                let event = PoolEvent {
                    id: format!("{}-remove", tx_hash),
                    pool_id: pool_id.clone(),
                    event_type: PoolEventType::RemoveLiquidity,
                    user_pub_key: tx.from_pub_key.clone(),
                    timestamp: block_time,
                    block_height,
                    tx_hash: tx_hash.clone(),
                    token_in: None,
                    token_out: None,
                    amount_in: None,
                    amount_out: None,
                    amount_a: Some(amount_a),
                    amount_b: Some(amount_b),
                    lp_amount: Some(lp_amount),
                    reserve_a_after: pool.reserve_a,
                    reserve_b_after: pool.reserve_b,
                };
                let _ = self.pool_event_store.save_event(&event);
                
                // Save price snapshot
                let price_a_in_b = if pool.reserve_a > 0 { pool.reserve_b as f64 / pool.reserve_a as f64 } else { 0.0 };
                let price_b_in_a = if pool.reserve_b > 0 { pool.reserve_a as f64 / pool.reserve_b as f64 } else { 0.0 };
                let snapshot = PriceSnapshot {
                    pool_id: pool_id.clone(),
                    timestamp: block_time,
                    block_height,
                    reserve_a: pool.reserve_a,
                    reserve_b: pool.reserve_b,
                    price_a_in_b,
                    price_b_in_a,
                };
                let _ = self.pool_event_store.save_price_snapshot(&snapshot);
            }
            "swap" => {
                let token_in = tx.payload.token_a_symbol.as_ref().ok_or("missing token_a_symbol (token_in)")?;
                let token_out = tx.payload.token_b_symbol.as_ref().ok_or("missing token_b_symbol (token_out)")?;
                let amount_in = tx.payload.amount_a.ok_or("missing amount_a (amount_in)")?;
                let min_amount_out = tx.payload.min_amount_out.unwrap_or(0);
                
                // Deduct fee
                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
                
                // Get swap path (direct or multi-hop)
                let path = tx.payload.swap_path.clone().unwrap_or_else(|| vec![token_in.clone(), token_out.clone()]);
                
                // Execute swap through the path
                let mut current_amount = amount_in;
                for i in 0..(path.len() - 1) {
                    let t_in = &path[i];
                    let t_out = &path[i + 1];
                    
                    let pool_id = LiquidityPool::make_pool_id(t_in, t_out);
                    let mut pool = self.pool_store.get_pool(&pool_id)?
                        .ok_or_else(|| format!("Pool not found: {}", pool_id))?;
                    
                    let (reserve_in, reserve_out) = pool.get_reserves(t_in)
                        .ok_or("Invalid token for pool")?;
                    
                    let amount_out = amm::get_amount_out(current_amount, reserve_in, reserve_out)
                        .ok_or("Insufficient liquidity")?;
                    
                    // Deduct input token (only on first hop)
                    if i == 0 {
                        if t_in == "XRGE" {
                            *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= current_amount as f64;
                        } else {
                            let key = (tx.from_pub_key.clone(), t_in.clone());
                            *token_balances.entry(key).or_insert(0.0) -= current_amount as f64;
                        }
                    }
                    
                    // Update pool reserves
                    if pool.token_a == *t_in {
                        pool.reserve_a += current_amount;
                        pool.reserve_b -= amount_out;
                    } else {
                        pool.reserve_b += current_amount;
                        pool.reserve_a -= amount_out;
                    }
                    self.pool_store.save_pool(&pool)?;
                    
                    current_amount = amount_out;
                }
                
                // Check slippage
                if current_amount < min_amount_out {
                    return Err(format!("Slippage exceeded: got {} but minimum was {}", current_amount, min_amount_out));
                }
                
                // Credit output token
                let final_token = path.last().unwrap();
                if final_token == "XRGE" {
                    *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) += current_amount as f64;
                } else {
                    let key = (tx.from_pub_key.clone(), final_token.clone());
                    *token_balances.entry(key).or_insert(0.0) += current_amount as f64;
                }
                
                // Save swap event for the primary pool (direct swap) or first hop
                let primary_pool_id = LiquidityPool::make_pool_id(token_in, token_out);
                if let Ok(Some(pool)) = self.pool_store.get_pool(&primary_pool_id) {
                    let event = PoolEvent {
                        id: format!("{}-swap", tx_hash),
                        pool_id: primary_pool_id.clone(),
                        event_type: PoolEventType::Swap,
                        user_pub_key: tx.from_pub_key.clone(),
                        timestamp: block_time,
                        block_height,
                        tx_hash: tx_hash.clone(),
                        token_in: Some(token_in.clone()),
                        token_out: Some(token_out.clone()),
                        amount_in: Some(amount_in),
                        amount_out: Some(current_amount),
                        amount_a: None,
                        amount_b: None,
                        lp_amount: None,
                        reserve_a_after: pool.reserve_a,
                        reserve_b_after: pool.reserve_b,
                    };
                    let _ = self.pool_event_store.save_event(&event);
                    
                    // Save price snapshot
                    let price_a_in_b = if pool.reserve_a > 0 { pool.reserve_b as f64 / pool.reserve_a as f64 } else { 0.0 };
                    let price_b_in_a = if pool.reserve_b > 0 { pool.reserve_a as f64 / pool.reserve_b as f64 } else { 0.0 };
                    let snapshot = PriceSnapshot {
                        pool_id: primary_pool_id,
                        timestamp: block_time,
                        block_height,
                        reserve_a: pool.reserve_a,
                        reserve_b: pool.reserve_b,
                        price_a_in_b,
                        price_b_in_a,
                    };
                    let _ = self.pool_event_store.save_price_snapshot(&snapshot);
                }
            }
            _ => {} // Non-AMM transactions handled elsewhere
        }
        Ok(())
    }

    #[allow(dead_code)]
    fn apply_balance_tx(&self, tx: &TxV1) -> Result<(), String> {
        let mut balances = self.balances.lock().map_err(|_| "balance lock")?;
        let mut token_balances = self.token_balances.lock().map_err(|_| "token balance lock")?;
        Self::apply_balance_tx_inner(&mut balances, &mut token_balances, tx);
        Ok(())
    }

    fn rebuild_balances(&self) -> Result<(), String> {
        // Collect all blocks first, then process them
        let blocks = self.store.get_all_blocks()?;
        let mut balances = self.balances.lock().map_err(|_| "balance lock")?;
        let mut token_balances = self.token_balances.lock().map_err(|_| "token balance lock")?;
        let mut lp_balances = self.lp_balances.lock().map_err(|_| "lp balance lock")?;
        balances.clear();
        token_balances.clear();
        lp_balances.clear();
        
        for block in &blocks {
            // Apply transaction effects
            for tx in &block.txs {
                Self::apply_balance_tx_inner(&mut balances, &mut token_balances, tx);
                
                // Apply AMM transaction balance effects (but don't update pool_store - already persisted)
                Self::apply_amm_balance_effects(
                    &mut balances,
                    &mut token_balances,
                    &mut lp_balances,
                    tx,
                    &self.pool_store,
                );
            }
            
            // Distribute fees for this block
            let total_fees: f64 = block.txs.iter().map(|tx| tx.fee).sum();
            if total_fees > 0.0 {
                // Get validator stakes at this block height for accurate distribution
                let stakes = self.get_validator_stakes_at_height(block.header.height)?;
                Self::distribute_fees(
                    &mut balances,
                    total_fees,
                    &block.header.proposer_pub_key,
                    &stakes,
                );
            }
        }
        Ok(())
    }
    
    /// Apply AMM balance effects during rebuild (doesn't modify pool_store)
    fn apply_amm_balance_effects(
        balances: &mut HashMap<String, f64>,
        token_balances: &mut HashMap<TokenBalanceKey, f64>,
        lp_balances: &mut HashMap<TokenBalanceKey, f64>,
        tx: &TxV1,
        pool_store: &PoolStore,
    ) {
        match tx.tx_type.as_str() {
            "create_pool" => {
                if let (Some(token_a), Some(token_b), Some(amount_a), Some(amount_b)) = (
                    tx.payload.token_a_symbol.as_ref(),
                    tx.payload.token_b_symbol.as_ref(),
                    tx.payload.amount_a,
                    tx.payload.amount_b,
                ) {
                    // Deduct fee
                    *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
                    
                    // Deduct tokens
                    if token_a == "XRGE" {
                        *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= amount_a as f64;
                    } else {
                        let key = (tx.from_pub_key.clone(), token_a.clone());
                        *token_balances.entry(key).or_insert(0.0) -= amount_a as f64;
                    }
                    if token_b == "XRGE" {
                        *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= amount_b as f64;
                    } else {
                        let key = (tx.from_pub_key.clone(), token_b.clone());
                        *token_balances.entry(key).or_insert(0.0) -= amount_b as f64;
                    }
                    
                    // Get pool to find LP amount
                    let pool_id = LiquidityPool::make_pool_id(token_a, token_b);
                    if let Ok(Some(_pool)) = pool_store.get_pool(&pool_id) {
                        // Initial LP (approximate - pool already has current state)
                        let initial_lp = ((amount_a as f64 * amount_b as f64).sqrt() as u64).saturating_sub(1000);
                        let lp_key = (tx.from_pub_key.clone(), pool_id);
                        *lp_balances.entry(lp_key).or_insert(0.0) += initial_lp as f64;
                    }
                }
            }
            "add_liquidity" => {
                if let (Some(pool_id), Some(amount_a), Some(amount_b)) = (
                    tx.payload.pool_id.as_ref(),
                    tx.payload.amount_a,
                    tx.payload.amount_b,
                ) {
                    *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
                    
                    if let Ok(Some(pool)) = pool_store.get_pool(pool_id) {
                        if pool.token_a == "XRGE" {
                            *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= amount_a as f64;
                        } else {
                            let key = (tx.from_pub_key.clone(), pool.token_a.clone());
                            *token_balances.entry(key).or_insert(0.0) -= amount_a as f64;
                        }
                        if pool.token_b == "XRGE" {
                            *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= amount_b as f64;
                        } else {
                            let key = (tx.from_pub_key.clone(), pool.token_b.clone());
                            *token_balances.entry(key).or_insert(0.0) -= amount_b as f64;
                        }
                        
                        // LP calculation would need historical reserve data - simplified here
                        if let Some(lp_amount) = amm::calculate_lp_mint(amount_a, amount_b, pool.reserve_a, pool.reserve_b, pool.total_lp_supply) {
                            let lp_key = (tx.from_pub_key.clone(), pool_id.clone());
                            *lp_balances.entry(lp_key).or_insert(0.0) += lp_amount as f64;
                        }
                    }
                }
            }
            "remove_liquidity" => {
                if let (Some(pool_id), Some(lp_amount)) = (
                    tx.payload.pool_id.as_ref(),
                    tx.payload.lp_amount,
                ) {
                    *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
                    
                    if let Ok(Some(pool)) = pool_store.get_pool(pool_id) {
                        // Burn LP
                        let lp_key = (tx.from_pub_key.clone(), pool_id.clone());
                        *lp_balances.entry(lp_key).or_insert(0.0) -= lp_amount as f64;
                        
                        // Return tokens (simplified - uses current reserves)
                        if let Some((amount_a, amount_b)) = amm::calculate_remove_liquidity(lp_amount, pool.reserve_a, pool.reserve_b, pool.total_lp_supply) {
                            if pool.token_a == "XRGE" {
                                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) += amount_a as f64;
                            } else {
                                let key = (tx.from_pub_key.clone(), pool.token_a.clone());
                                *token_balances.entry(key).or_insert(0.0) += amount_a as f64;
                            }
                            if pool.token_b == "XRGE" {
                                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) += amount_b as f64;
                            } else {
                                let key = (tx.from_pub_key.clone(), pool.token_b.clone());
                                *token_balances.entry(key).or_insert(0.0) += amount_b as f64;
                            }
                        }
                    }
                }
            }
            "swap" => {
                if let (Some(token_in), Some(token_out), Some(amount_in)) = (
                    tx.payload.token_a_symbol.as_ref(),
                    tx.payload.token_b_symbol.as_ref(),
                    tx.payload.amount_a,
                ) {
                    *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
                    
                    let path = tx.payload.swap_path.clone().unwrap_or_else(|| vec![token_in.clone(), token_out.clone()]);
                    
                    // Deduct input
                    if token_in == "XRGE" {
                        *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= amount_in as f64;
                    } else {
                        let key = (tx.from_pub_key.clone(), token_in.clone());
                        *token_balances.entry(key).or_insert(0.0) -= amount_in as f64;
                    }
                    
                    // Calculate output through path
                    let mut current_amount = amount_in;
                    for i in 0..(path.len() - 1) {
                        let t_in = &path[i];
                        let t_out = &path[i + 1];
                        let pool_id = LiquidityPool::make_pool_id(t_in, t_out);
                        
                        if let Ok(Some(pool)) = pool_store.get_pool(&pool_id) {
                            if let Some((reserve_in, reserve_out)) = pool.get_reserves(t_in) {
                                if let Some(out) = amm::get_amount_out(current_amount, reserve_in, reserve_out) {
                                    current_amount = out;
                                }
                            }
                        }
                    }
                    
                    // Credit output
                    let final_token = path.last().unwrap_or(token_out);
                    if final_token == "XRGE" {
                        *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) += current_amount as f64;
                    } else {
                        let key = (tx.from_pub_key.clone(), final_token.clone());
                        *token_balances.entry(key).or_insert(0.0) += current_amount as f64;
                    }
                }
            }
            _ => {}
        }
    }
    
    fn rebuild_token_balances(&self) -> Result<(), String> {
        // Token balances are rebuilt as part of rebuild_balances
        // This is a separate call for clarity but the work is done in rebuild_balances
        Ok(())
    }
    
    /// Distribute block fees: 25% to proposer, 75% split among validators by stake
    fn distribute_fees(
        balances: &mut HashMap<String, f64>,
        total_fees: f64,
        proposer_pub_key: &str,
        validator_stakes: &BTreeMap<String, u128>,
    ) {
        // Proposer gets 25%
        let proposer_share = total_fees * Self::PROPOSER_FEE_SHARE;
        *balances.entry(proposer_pub_key.to_string()).or_insert(0.0) += proposer_share;
        
        // Remaining 75% split among all validators by stake weight
        let validator_pool = total_fees * Self::VALIDATOR_FEE_SHARE;
        let total_stake: u128 = validator_stakes.values().sum();
        
        if total_stake > 0 {
            for (validator_pub_key, stake) in validator_stakes {
                let stake_ratio = *stake as f64 / total_stake as f64;
                let validator_share = validator_pool * stake_ratio;
                *balances.entry(validator_pub_key.clone()).or_insert(0.0) += validator_share;
            }
        } else {
            // No validators staked - proposer gets everything
            *balances.entry(proposer_pub_key.to_string()).or_insert(0.0) += validator_pool;
        }
    }
    
    fn apply_balance_tx_inner(
        balances: &mut HashMap<String, f64>,
        token_balances: &mut HashMap<TokenBalanceKey, f64>,
        tx: &TxV1,
    ) {
        match tx.tx_type.as_str() {
            "transfer" => {
                if let Some(to_pub_key) = tx.payload.to_pub_key_hex.as_ref() {
                    let amount = tx.payload.amount.unwrap_or(0) as f64;
                    
                    // Check if this is a token transfer (has token_symbol)
                    if let Some(token_symbol) = tx.payload.token_symbol.as_ref() {
                        // Token transfer: deduct XRGE fee from sender
                        *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
                        
                        // Track token balance changes
                        let sender_key = (tx.from_pub_key.clone(), token_symbol.clone());
                        let recipient_key = (to_pub_key.clone(), token_symbol.clone());
                        *token_balances.entry(sender_key).or_insert(0.0) -= amount;
                        *token_balances.entry(recipient_key).or_insert(0.0) += amount;
                    } else {
                        // XRGE transfer: add to recipient, deduct amount + fee from sender
                        *balances.entry(to_pub_key.clone()).or_insert(0.0) += amount;
                        *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= amount + tx.fee;
                    }
                    // Fees are distributed separately via distribute_fees()
                }
            }
            "stake" => {
                let amount = tx.payload.amount.unwrap_or(0) as f64;
                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= amount + tx.fee;
            }
            "unstake" => {
                let amount = tx.payload.amount.unwrap_or(0) as f64;
                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) += amount - tx.fee;
            }
            "create_token" => {
                // Token creation fee is deducted from sender (XRGE)
                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
                
                // Mint token supply to creator
                if let Some(token_symbol) = tx.payload.token_symbol.as_ref() {
                    let total_supply = tx.payload.token_total_supply.unwrap_or(0) as f64;
                    let creator_key = (tx.from_pub_key.clone(), token_symbol.clone());
                    *token_balances.entry(creator_key).or_insert(0.0) += total_supply;
                }
            }
            "slash" => {}
            _ => {}
        }
    }

    fn get_validator_stakes(&self) -> Result<BTreeMap<String, u128>, String> {
        let tip = self.store.get_tip()?.height;
        let entries = self.validator_store.list_validators()?;
        let mut stakes = BTreeMap::new();
        for (public_key, state) in entries {
            if state.jailed_until > tip {
                continue;
            }
            if state.stake > 0 {
                stakes.insert(public_key, state.stake);
            }
        }
        Ok(stakes)
    }

    /// Get current validator stakes snapshot (for fee distribution)
    fn get_validator_stakes_snapshot(&self) -> Result<BTreeMap<String, u128>, String> {
        self.get_validator_stakes()
    }

    /// Get validator stakes at a specific block height (for rebuild_balances)
    fn get_validator_stakes_at_height(&self, _height: u64) -> Result<BTreeMap<String, u128>, String> {
        // For now, use current stakes. A more accurate implementation would
        // replay validator state from genesis to the given height.
        // This is acceptable for testnet; mainnet might need historical stake tracking.
        self.get_validator_stakes()
    }

    fn apply_validator_block(&self, block: &BlockV1) -> Result<(), String> {
        for tx in &block.txs {
            self.apply_validator_tx(tx, block.header.height)?;
        }
        Ok(())
    }

    fn apply_validator_tx(&self, tx: &TxV1, height: u64) -> Result<(), String> {
        let ensure = |state: Option<ValidatorState>| {
            state.unwrap_or(ValidatorState {
                stake: 0,
                slash_count: 0,
                jailed_until: 0,
                entropy_contributions: 0,
            })
        };
        match tx.tx_type.as_str() {
            "stake" | "unstake" => {
                let amount = tx.payload.amount.unwrap_or(0) as u128;
                let current = ensure(self.validator_store.get_validator(&tx.from_pub_key)?);
                let mut state = current;
                if tx.tx_type == "stake" {
                    state.stake += amount;
                } else {
                    state.stake = state.stake.saturating_sub(amount);
                }
                self.persist_validator_state(&tx.from_pub_key, &state, height)?;
            }
            "slash" => {
                let payload = SlashPayload {
                    target_pub_key: tx.payload.target_pub_key.clone().unwrap_or_default(),
                    amount: tx.payload.amount.unwrap_or(0),
                    reason: tx.payload.reason.clone(),
                };
                let current = ensure(self.validator_store.get_validator(&payload.target_pub_key)?);
                let mut state = current;
                let slash_amount = (state.stake / SLASH_DIVISOR).max(1);
                state.stake = state.stake.saturating_sub(slash_amount);
                state.slash_count += 1;
                state.jailed_until = std::cmp::max(state.jailed_until, height + JAIL_BLOCKS);
                self.persist_validator_state(&payload.target_pub_key, &state, height)?;
            }
            _ => {}
        }
        Ok(())
    }

    fn persist_validator_state(&self, public_key: &str, state: &ValidatorState, height: u64) -> Result<(), String> {
        let should_keep = state.stake > 0 || state.slash_count > 0 || state.jailed_until > height;
        if !should_keep {
            return self.validator_store.delete_validator(public_key);
        }
        self.validator_store.set_validator(public_key, state)
    }

    pub fn list_wallets(&self) -> Result<Vec<MessengerWallet>, String> {
        self.messenger_store.list_wallets()
    }

    pub fn register_wallet(&self, wallet: MessengerWallet) -> Result<MessengerWallet, String> {
        self.messenger_store.register_wallet(wallet)
    }

    pub fn list_conversations(&self, wallet_id: &str) -> Result<Vec<Conversation>, String> {
        self.messenger_store.list_conversations(wallet_id)
    }

    pub fn create_conversation(
        &self,
        created_by: &str,
        participant_ids: Vec<String>,
        name: Option<String>,
        is_group: bool,
    ) -> Result<Conversation, String> {
        self.messenger_store.create_conversation(created_by, participant_ids, name, is_group)
    }

    pub fn list_messages(&self, conversation_id: &str) -> Result<Vec<MessengerMessage>, String> {
        self.messenger_store.list_messages(conversation_id)
    }

    pub fn send_message(&self, message: MessengerMessage) -> Result<MessengerMessage, String> {
        self.messenger_store.add_message(message)
    }

    pub fn mark_message_read(&self, message_id: &str) -> Result<MessengerMessage, String> {
        self.messenger_store.mark_message_read(message_id)
    }

}
