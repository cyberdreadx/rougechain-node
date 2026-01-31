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

const BASE_TRANSFER_FEE: f64 = 0.1;
const TOKEN_CREATION_FEE: f64 = 100.0;
const JAIL_BLOCKS: u64 = 20;
const SLASH_DIVISOR: u128 = 10;
const MAX_MEMPOOL: usize = 2000;

#[derive(Clone)]
pub struct NodeOptions {
    pub data_dir: PathBuf,
    pub chain: ChainConfig,
    pub mine: bool,
}

#[derive(Clone)]
pub struct L1Node {
    node_id: String,
    opts: NodeOptions,
    store: ChainStore,
    validator_store: ValidatorStore,
    messenger_store: MessengerStore,
    keys: Arc<Mutex<PQKeypair>>,
    mempool: Arc<Mutex<HashMap<String, TxV1>>>,
    balances: Arc<Mutex<HashMap<String, f64>>>,
    votes: Arc<Mutex<Vec<VoteMessage>>>,
    finalized_height: Arc<Mutex<u64>>,
}

impl L1Node {
    pub fn new(opts: NodeOptions) -> Result<Self, String> {
        let store = ChainStore::new(&opts.data_dir, opts.chain.clone());
        let validator_store = ValidatorStore::new(&opts.data_dir)?;
        let messenger_store = MessengerStore::new(&opts.data_dir);
        let keys = pqc_keygen();
        Ok(Self {
            node_id: uuid::Uuid::new_v4().to_string(),
            opts,
            store,
            validator_store,
            messenger_store,
            keys: Arc::new(Mutex::new(keys)),
            mempool: Arc::new(Mutex::new(HashMap::new())),
            balances: Arc::new(Mutex::new(HashMap::new())),
            votes: Arc::new(Mutex::new(Vec::new())),
            finalized_height: Arc::new(Mutex::new(0)),
        })
    }

    pub fn init(&self) -> Result<(), String> {
        self.store.init()?;
        self.messenger_store.init()?;
        self.rebuild_balances()?;
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
        
        // Apply transactions to balances
        for tx in &block.txs {
            self.apply_balance_tx(tx, &block.header.proposer_pub_key)?;
        }
        
        // Apply validator state changes
        self.apply_validator_block(&block)?;
        
        eprintln!("[node] Imported block {} from peer", block.header.height);
        Ok(())
    }

    pub fn get_balance(&self, public_key: &str) -> Result<f64, String> {
        let balances = self.balances.lock().map_err(|_| "balance lock")?;
        Ok(*balances.get(public_key).unwrap_or(&0.0))
    }

    pub fn create_wallet(&self) -> PQKeypair {
        pqc_keygen()
    }

    pub fn submit_user_tx(
        &self,
        from_private_key: &str,
        from_public_key: &str,
        to_public_key: &str,
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
                token_symbol: None,
                token_decimals: None,
                token_total_supply: None,
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

    fn apply_balance_block(&self, block: &BlockV1) -> Result<(), String> {
        for tx in &block.txs {
            self.apply_balance_tx(tx, &block.header.proposer_pub_key)?;
        }
        Ok(())
    }

    fn apply_balance_tx(&self, tx: &TxV1, fee_recipient: &str) -> Result<(), String> {
        let mut balances = self.balances.lock().map_err(|_| "balance lock")?;
        Self::apply_balance_tx_inner(&mut balances, tx, fee_recipient);
        Ok(())
    }

    fn rebuild_balances(&self) -> Result<(), String> {
        // Collect all blocks first, then process them
        // This avoids deadlock from holding the balance lock while scanning
        let blocks = self.store.get_all_blocks()?;
        let mut balances = self.balances.lock().map_err(|_| "balance lock")?;
        balances.clear();
        for block in &blocks {
            for tx in &block.txs {
                Self::apply_balance_tx_inner(&mut balances, tx, &block.header.proposer_pub_key);
            }
        }
        Ok(())
    }
    
    fn apply_balance_tx_inner(balances: &mut HashMap<String, f64>, tx: &TxV1, fee_recipient: &str) {
        match tx.tx_type.as_str() {
            "transfer" => {
                if let Some(to_pub_key) = tx.payload.to_pub_key_hex.as_ref() {
                    let amount = tx.payload.amount.unwrap_or(0) as f64;
                    *balances.entry(to_pub_key.clone()).or_insert(0.0) += amount;
                    *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= amount + tx.fee;
                    if tx.fee > 0.0 {
                        *balances.entry(fee_recipient.to_string()).or_insert(0.0) += tx.fee;
                    }
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
