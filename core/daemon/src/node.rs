use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::fs;

use chrono::Utc;

use quantum_vault_consensus::{compute_selection_seed, fetch_entropy, select_proposer, ProposerSelectionResult};
use quantum_vault_crypto::{bytes_to_hex, pqc_keygen, pqc_sign, pqc_verify, sha256};
use quantum_vault_storage::allowance_store::{Allowance, AllowanceStore};
use quantum_vault_storage::bridge_withdraw_store::BridgeWithdrawStore;
use quantum_vault_storage::chain_store::ChainStore;
use quantum_vault_storage::commitment_store::CommitmentStore;
use quantum_vault_storage::governance_store::{GovernanceStore, Proposal, Vote};
use quantum_vault_storage::lock_store::{LockStore, TokenLock};
use quantum_vault_storage::multisig_store::{MultisigStore, MultisigWallet, MultisigProposal};
use quantum_vault_storage::mail_store::{MailLabel, MailMessage, MailStore};
use quantum_vault_storage::messenger_store::{Conversation, MessengerMessage, MessengerStore, MessengerWallet};
use quantum_vault_storage::name_registry::{NameEntry, NameRegistry};
use quantum_vault_storage::nullifier_store::NullifierStore;
use quantum_vault_storage::receipt_store::ReceiptStore;
use quantum_vault_storage::token_metadata_store::{TokenMetadata, TokenMetadataStore};
use quantum_vault_storage::push_token_store::PushTokenStore;
use quantum_vault_storage::token_stake_store::{TokenStakeStore, StakingPool, TokenStake};
use quantum_vault_storage::validator_store::{ValidatorState, ValidatorStore};
use quantum_vault_types::{
    compute_block_hash, compute_single_tx_hash, compute_tx_hash, encode_header_v1, encode_tx_v1,
    encode_tx_for_signing, BlockHeaderV1, BlockV1, ChainConfig, PQKeypair, SlashPayload,
    TxLog, TxPayload, TxReceipt, TxStatus, TxV1, VoteMessage,
};

use crate::amm;
use crate::nft_store::{NftCollection, NftStore, NftToken};
use crate::pool_store::{LiquidityPool, PoolStore};
use crate::pool_events::{PoolEvent, PoolEventStore, PoolEventType, PriceSnapshot};

const BASE_TRANSFER_FEE: f64 = 0.1;
const TOKEN_CREATION_FEE: f64 = 100.0;
const JAIL_BLOCKS: u64 = 20;
const SLASH_DIVISOR: u128 = 10;
const UNBONDING_BLOCKS: u64 = 500;             // ~8 hours at 1 block/min
const MISSED_BLOCK_SLASH_THRESHOLD: u64 = 50;  // Auto-slash after 50 missed blocks
const MAX_MEMPOOL: usize = 2000;

// EIP-1559 dynamic fee constants
const BASE_FEE_INITIAL: f64 = 0.1;           // Initial base fee (XRGE)
const BASE_FEE_MAX_CHANGE_DENOM: f64 = 8.0;  // Max 12.5% change per block
const TARGET_TXS_PER_BLOCK: usize = 10;      // Target block fullness
const BASE_FEE_FLOOR: f64 = 0.001;           // Minimum base fee

/// The official burn address - tokens sent here are permanently destroyed
/// This is a deterministic address derived from "QUANTUM_VAULT_BURN_ADDRESS_V1"
/// No private key can ever be derived for this address
pub const BURN_ADDRESS: &str = "XRGE_BURN_0x000000000000000000000000000000000000000000000000000000000000DEAD";

#[derive(Clone)]
pub struct NodeOptions {
    pub data_dir: PathBuf,
    pub chain: ChainConfig,
    pub mine: bool,
    /// Optional store for pending bridge withdrawals (qETH → ETH)
    pub bridge_withdraw_store: Option<std::sync::Arc<BridgeWithdrawStore>>,
}

/// Key for token balances: (public_key, token_symbol)
type TokenBalanceKey = (String, String);

/// Queued unbonding entry — funds release after UNBONDING_BLOCKS
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct UnbondingEntry {
    pub delegator: String,
    pub amount: f64,
    pub release_height: u64,
}

#[derive(Clone)]
pub struct L1Node {
    node_id: String,
    opts: NodeOptions,
    store: ChainStore,
    validator_store: ValidatorStore,
    messenger_store: MessengerStore,
    pool_store: PoolStore,
    pool_event_store: PoolEventStore,
    token_metadata_store: TokenMetadataStore,
    nft_store: NftStore,
    name_registry: NameRegistry,
    mail_store: MailStore,
    commitment_store: CommitmentStore,
    lock_store: LockStore,
    pub multisig_store: MultisigStore,
    token_stake_store: TokenStakeStore,
    pub governance_store: GovernanceStore,
    allowance_store: AllowanceStore,
    nullifier_store: NullifierStore,
    receipt_store: ReceiptStore,
    keys: Arc<Mutex<PQKeypair>>,
    mempool: Arc<Mutex<HashMap<String, TxV1>>>,
    verified_tx_ids: Arc<Mutex<HashSet<String>>>,
    balances: Arc<Mutex<HashMap<String, f64>>>,
    token_balances: Arc<Mutex<HashMap<TokenBalanceKey, f64>>>,
    lp_balances: Arc<Mutex<HashMap<TokenBalanceKey, f64>>>,  // LP token balances
    burned_tokens: Arc<Mutex<HashMap<String, f64>>>,  // Total burned per token symbol
    votes: Arc<Mutex<Vec<VoteMessage>>>,
    finalized_height: Arc<Mutex<u64>>,
    /// Per-account sequential nonce (persisted in sled)
    nonce_db: sled::Tree,
    /// rouge1… address → public key index (persisted in sled)
    address_db: sled::Tree,
    push_token_store: PushTokenStore,
    /// Current EIP-1559 base fee (persisted in sled)
    fee_db: sled::Tree,
    /// Running total of burned fees (XRGE)
    total_fees_burned: Arc<Mutex<f64>>,
    /// Queued unbonding entries (unstake with delay)
    pub unbonding_queue: Arc<Mutex<Vec<UnbondingEntry>>>,
    /// Persisted finality proofs (height -> proof JSON)
    finality_db: sled::Tree,
    /// Notify handle: wake the miner immediately when a tx enters mempool
    mine_notify: Arc<tokio::sync::Notify>,
    /// Running total of XRGE currently in the shielded privacy pool
    shielded_supply: Arc<Mutex<f64>>,
}

impl L1Node {
    pub fn new(opts: NodeOptions) -> Result<Self, String> {
        let data_dir_str = opts.data_dir.to_string_lossy().to_string();
        let store = ChainStore::new(&opts.data_dir, opts.chain.clone())?;
        let validator_store = ValidatorStore::new(&data_dir_str)?;
        let messenger_store = MessengerStore::new(&data_dir_str);
        let pool_store = PoolStore::new(&opts.data_dir)?;
        let pool_event_store = PoolEventStore::new(&opts.data_dir)?;
        let token_metadata_store = TokenMetadataStore::new(&data_dir_str)?;
        // Backfill token_id for existing tokens (migration)
        match token_metadata_store.migrate_token_ids() {
            Ok(0) => {},
            Ok(n) => eprintln!("[startup] Migrated {} token(s) with new token_id", n),
            Err(e) => eprintln!("[startup] Token ID migration failed: {}", e),
        }
        let nft_store = NftStore::new(&opts.data_dir)?;
        let name_registry = NameRegistry::new(&opts.data_dir)?;
        let mail_store = MailStore::new(&opts.data_dir)?;
        let commitment_store = CommitmentStore::new(&opts.data_dir)?;
        let nullifier_store = NullifierStore::new(&opts.data_dir)?;
        let lock_store = LockStore::new(&opts.data_dir)?;
        let multisig_store = MultisigStore::new(&opts.data_dir)?;
        let token_stake_store = TokenStakeStore::new(&data_dir_str)?;
        let governance_store = GovernanceStore::new(&data_dir_str)?;
        let allowance_store = AllowanceStore::new(&data_dir_str)?;
        // Open receipt store on the same sled DB as chain store
        let receipt_db = sled::open(opts.data_dir.join("receipt-db"))
            .map_err(|e| format!("open receipt DB: {}", e))?;
        let receipt_store = ReceiptStore::new(&receipt_db)?;
        let keys = Self::load_or_create_keys(&opts.data_dir)?;
            let nonce_db = sled::open(opts.data_dir.join("nonce-db"))
                .map_err(|e| format!("open nonce DB: {}", e))?
                .open_tree("account_nonces")
                .map_err(|e| format!("open nonce tree: {}", e))?;
            let address_db = sled::open(opts.data_dir.join("address-db"))
                .map_err(|e| format!("open address DB: {}", e))?
                .open_tree("rouge1_index")
                .map_err(|e| format!("open address tree: {}", e))?;
            let push_token_store = PushTokenStore::new(&opts.data_dir)?;
            let fee_sled = sled::open(opts.data_dir.join("fee-db"))
                .map_err(|e| format!("open fee DB: {}", e))?;
            let fee_db = fee_sled.open_tree("eip1559")
                .map_err(|e| format!("open fee tree: {}", e))?;
            let finality_db_tree = {
                sled::open(opts.data_dir.join("finality-db"))
                    .map_err(|e| format!("finality-db: {}", e))?
                    .open_tree("finality")
                    .map_err(|e| format!("finality tree: {}", e))?
            };
            Ok(Self {
            node_id: uuid::Uuid::new_v4().to_string(),
            opts,
            store,
            validator_store,
            messenger_store,
            pool_store,
            pool_event_store,
            token_metadata_store,
            nft_store,
            name_registry,
            mail_store,
            commitment_store,
            nullifier_store,
            receipt_store,
            lock_store,
            multisig_store,
            token_stake_store,
            governance_store,
            allowance_store,
            keys: Arc::new(Mutex::new(keys)),
            mempool: Arc::new(Mutex::new(HashMap::new())),
            verified_tx_ids: Arc::new(Mutex::new(HashSet::new())),
            balances: Arc::new(Mutex::new(HashMap::new())),
            token_balances: Arc::new(Mutex::new(HashMap::new())),
            lp_balances: Arc::new(Mutex::new(HashMap::new())),
            burned_tokens: Arc::new(Mutex::new(HashMap::new())),
            votes: Arc::new(Mutex::new(Vec::new())),
            finalized_height: Arc::new(Mutex::new(0)),
            nonce_db,
            address_db,
            push_token_store,
            fee_db: fee_db.clone(),
            total_fees_burned: {
                let saved = fee_db.get(b"total_burned").ok().flatten()
                    .and_then(|v| String::from_utf8(v.to_vec()).ok())
                    .and_then(|s| s.parse::<f64>().ok())
                    .unwrap_or(0.0);
                Arc::new(Mutex::new(saved))
            },
            unbonding_queue: Arc::new(Mutex::new(Vec::new())),
            finality_db: finality_db_tree,
            mine_notify: Arc::new(tokio::sync::Notify::new()),
            shielded_supply: Arc::new(Mutex::new(0.0)),
        })
    }

    fn load_or_create_keys(data_dir: &PathBuf) -> Result<PQKeypair, String> {
        let key_file = data_dir.join("node-keys.json");
        if key_file.exists() {
            let data = fs::read_to_string(&key_file)
                .map_err(|e| format!("Failed to read node keys: {}", e))?;
            let keys: PQKeypair = serde_json::from_str(&data)
                .map_err(|e| format!("Failed to parse node keys: {}", e))?;
            eprintln!("[node] Loaded persisted node keys (pub: {}...)", &keys.public_key_hex[..16.min(keys.public_key_hex.len())]);
            Ok(keys)
        } else {
            let keys = pqc_keygen();
            let data = serde_json::to_string_pretty(&keys)
                .map_err(|e| format!("Failed to serialize node keys: {}", e))?;
            fs::create_dir_all(data_dir)
                .map_err(|e| format!("Failed to create data dir: {}", e))?;
            fs::write(&key_file, &data)
                .map_err(|e| format!("Failed to write node keys: {}", e))?;
            eprintln!("[node] Generated and saved new node keys (pub: {}...)", &keys.public_key_hex[..16.min(keys.public_key_hex.len())]);
            Ok(keys)
        }
    }

    pub fn init(&self) -> Result<(), String> {
        self.store.init()?;
        self.messenger_store.init()?;
        self.rebuild_pool_state()?;
        self.rebuild_nft_state()?;
        self.migrate_nonce_db();
        self.rebuild_balances()?;
        self.rebuild_token_balances()?;
        self.rebuild_proposer_counts()?;
        let tip = self.store.get_tip()?;
        // Load finalized_height from persisted finality_db (highest proven height)
        let persisted_finalized = self.finality_db.iter().rev().next()
            .and_then(|item| item.ok())
            .and_then(|(k, _)| {
                let arr: [u8; 8] = k.as_ref().try_into().ok()?;
                Some(u64::from_be_bytes(arr))
            })
            .unwrap_or(0);
        // Use minimum of tip and persisted (in case of chain reset)
        let finalized = persisted_finalized.min(tip.height);
        *self.finalized_height.lock().map_err(|_| "finality lock")? = finalized;
        eprintln!("[bft] Finalized height: {} (tip: {})", finalized, tip.height);
        Ok(())
    }

    /// Get a reference to the chain store (for indexer backfill)
    pub fn store_ref(&self) -> &quantum_vault_storage::chain_store::ChainStore {
        &self.store
    }

    /// Scan all historical blocks and rebuild blocks_proposed counts for each validator.
    /// Block headers use node ephemeral keys as proposer, not validator staking keys,
    /// so we assign unmatched blocks to the highest-staked validator.
    fn rebuild_proposer_counts(&self) -> Result<(), String> {
        let blocks = self.store.get_all_blocks()?;
        if blocks.is_empty() {
            return Ok(());
        }

        // Reset all validators' blocks_proposed to 0 first
        if let Ok(all_validators) = self.validator_store.list_validators() {
            for (pub_key, mut vstate) in all_validators {
                vstate.blocks_proposed = 0;
                let _ = self.validator_store.set_validator(&pub_key, &vstate);
            }
        }

        // Count blocks per unique proposer key
        let mut counts: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        for block in &blocks {
            *counts.entry(block.header.proposer_pub_key.clone()).or_insert(0) += 1;
        }

        let mut matched = 0u64;
        let mut unmatched = 0u64;

        for (pub_key, count) in &counts {
            if let Ok(Some(mut vstate)) = self.validator_store.get_validator(pub_key) {
                vstate.blocks_proposed += *count;
                let _ = self.validator_store.set_validator(pub_key, &vstate);
                matched += count;
            } else {
                unmatched += count;
            }
        }

        // Assign unmatched blocks to the highest-staked validator (the node key != validator key case)
        if unmatched > 0 {
            if let Ok(validators) = self.validator_store.list_validators() {
                if let Some((top_key, _)) = validators.iter().max_by_key(|(_, v)| v.stake) {
                    if let Ok(Some(mut vstate)) = self.validator_store.get_validator(top_key) {
                        vstate.blocks_proposed += unmatched;
                        let _ = self.validator_store.set_validator(top_key, &vstate);
                        eprintln!("[node] Assigned {} unmatched blocks to top validator {}...", unmatched, &top_key[..16.min(top_key.len())]);
                    }
                }
            }
        }

        eprintln!("[node] Rebuilt proposer counts from {} blocks ({} matched, {} assigned to top validator)", blocks.len(), matched, unmatched);
        Ok(())
    }

    pub fn node_id(&self) -> String {
        self.node_id.clone()
    }

    /// Get the mine-notify handle (for the mining loop to listen on)
    pub fn mine_notify(&self) -> Arc<tokio::sync::Notify> {
        self.mine_notify.clone()
    }

    /// Prune zero-balance entries from in-memory balance maps to reduce memory usage.
    /// Returns total number of pruned entries.
    pub fn prune_zero_balances(&self) -> usize {
        let mut total = 0;
        if let Ok(mut m) = self.balances.lock() {
            let before = m.len();
            m.retain(|_, v| *v > 0.0);
            total += before - m.len();
        }
        if let Ok(mut m) = self.token_balances.lock() {
            let before = m.len();
            m.retain(|_, v| *v > 0.0);
            total += before - m.len();
        }
        if let Ok(mut m) = self.lp_balances.lock() {
            let before = m.len();
            m.retain(|_, v| *v > 0.0);
            total += before - m.len();
        }
        total
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

    /// Convenience alias for get_tip_height
    pub fn tip_height(&self) -> Result<u64, String> {
        self.get_tip_height()
    }

    /// Apply genesis allocations — credit initial balances and stake initial validators.
    /// Only called on first boot when chain height == 0.
    pub fn apply_genesis_allocations(
        &self,
        allocations: &[crate::GenesisAllocation],
        validators: &[crate::GenesisValidator],
    ) -> Result<(), String> {
        let mut balances = self.balances.lock().map_err(|_| "balance lock")?;

        // Credit initial allocations
        for alloc in allocations {
            *balances.entry(alloc.address.clone()).or_insert(0.0) += alloc.amount as f64;
            eprintln!("[genesis] Allocated {} XRGE → {} {}",
                alloc.amount, &alloc.address[..16.min(alloc.address.len())],
                alloc.label.as_deref().unwrap_or(""));
        }

        // Stake initial validators
        drop(balances); // Release lock before validator operations
        for val in validators {
            let state = quantum_vault_storage::validator_store::ValidatorState {
                stake: val.stake as u128,
                slash_count: 0,
                jailed_until: 0,
                entropy_contributions: 0,
                blocks_proposed: 0,
                name: val.name.clone(),
                missed_blocks: 0,
                total_slashed: 0,
            };
            self.validator_store.set_validator(&val.pub_key, &state)?;
            eprintln!("[genesis] Validator staked: {} ({} XRGE)",
                val.name.as_deref().unwrap_or(&val.pub_key[..8.min(val.pub_key.len())]),
                val.stake);
        }

        Ok(())
    }

    /// Get this node's own public key hex string
    pub fn get_public_key(&self) -> Option<String> {
        self.keys.lock().ok().map(|k| k.public_key_hex.clone())
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
        
        // Rebuild pool and NFT state from the new chain
        self.rebuild_pool_state()?;
        self.rebuild_nft_state()?;
        
        // Reset balances
        let mut balances = self.balances.lock().map_err(|_| "balance lock")?;
        let mut token_balances = self.token_balances.lock().map_err(|_| "token balance lock")?;
        let mut lp_balances = self.lp_balances.lock().map_err(|_| "lp balance lock")?;
        let mut burned_tokens = self.burned_tokens.lock().map_err(|_| "burned tokens lock")?;
        balances.clear();
        token_balances.clear();
        lp_balances.clear();
        burned_tokens.clear();
        
        // Replay all transactions to rebuild balances with fee distribution
        for block in blocks {
            // Apply transaction effects
            for tx in &block.txs {
                Self::apply_balance_tx_inner(&mut balances, &mut token_balances, &mut burned_tokens, tx, Some(&self.validator_store), "_rebuild_", &self.unbonding_queue, block.header.height, &self.shielded_supply);
                self.apply_web3_state_effects(tx, block.header.height);
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
                let base_fee = self.get_base_fee();
                Self::distribute_fees(
                    &mut balances,
                    total_fees,
                    &block.header.proposer_pub_key,
                    &stakes,
                    base_fee,
                    block.txs.len(),
                    &self.total_fees_burned,
                );
            }
            // Update base fee for next block
            let next_base_fee = self.calculate_next_base_fee(block.txs.len());
            self.set_base_fee(next_base_fee);
        }
        
        eprintln!("[node] Chain reset complete - now at height {}", blocks.last().map(|b| b.header.height).unwrap_or(0));
        Ok(())
    }

    pub fn get_recent_blocks(&self, limit: usize) -> Result<Vec<BlockV1>, String> {
        if limit == 0 {
            // Cap at 10000 to prevent loading the entire chain into memory
            return self.store.get_recent_blocks(10_000);
        }
        self.store.get_recent_blocks(limit)
    }

    /// Get blocks from a given height onward (for P2P full-chain sync)
    pub fn get_blocks_from(&self, start_height: u64) -> Result<Vec<BlockV1>, String> {
        self.store.get_blocks_from(start_height)
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
        
        // Verify proposer signature and block hash integrity
        {
            let header_bytes = encode_header_v1(&block.header);
            match pqc_verify(&block.header.proposer_pub_key, &header_bytes, &block.proposer_sig) {
                Ok(true) => {}
                Ok(false) => return Err("Invalid proposer signature on imported block".to_string()),
                Err(e) => return Err(format!("Proposer sig verification error: {}", e)),
            }
            let expected_hash = compute_block_hash(&header_bytes, &block.proposer_sig);
            if block.hash != expected_hash {
                return Err("Block hash mismatch".to_string());
            }
            // Check proposer is a known validator (skip for early blocks during initial sync
            // when the syncing node hasn't replayed stake transactions yet)
            let validators = self.list_validators().unwrap_or_default();
            if !validators.is_empty() {
                let is_valid_proposer = validators.iter().any(|(pk, vs)| {
                    pk == &block.header.proposer_pub_key && vs.stake > 0
                });
                if !is_valid_proposer {
                    eprintln!(
                        "[peer] Warning: block {} proposer {} not in validator set, accepting (sig valid)",
                        block.header.height,
                        &block.header.proposer_pub_key[..16.min(block.header.proposer_pub_key.len())]
                    );
                }
            }
        }

        // Verify all transaction signatures in parallel
        {
            use rayon::prelude::*;
            let invalid_count = block
                .txs
                .par_iter()
                .filter(|tx| {
                    // V2 transactions carry the original signed payload
                    if let Some(ref sp) = tx.signed_payload {
                        let bytes = sp.as_bytes();
                        if pqc_verify(&tx.from_pub_key, bytes, &tx.sig).ok() == Some(true) {
                            return false; // valid
                        }
                    }
                    // V1 new format: encode without sig field
                    let bytes_new = encode_tx_for_signing(tx);
                    if pqc_verify(&tx.from_pub_key, &bytes_new, &tx.sig).ok() == Some(true) {
                        return false; // valid
                    }
                    // V1 legacy format: encode full tx with sig cleared
                    let mut legacy = (*tx).clone();
                    legacy.sig = String::new();
                    legacy.signed_payload = None;
                    let bytes_legacy = encode_tx_v1(&legacy);
                    if pqc_verify(&tx.from_pub_key, &bytes_legacy, &tx.sig).ok() == Some(true) {
                        return false; // valid
                    }
                    eprintln!("[peer] Rejecting tx: all signature verification methods failed for {}", &tx.from_pub_key[..16.min(tx.from_pub_key.len())]);
                    true
                })
                .count();
            if invalid_count > 0 {
                return Err(format!("Block has {} invalid tx signatures", invalid_count));
            }
        }
        
        // Apply state BEFORE storing to disk (atomic: don't store blocks we can't apply)
        self.apply_balance_block(&block)?;
        self.apply_validator_block(&block)?;
        
        // Only persist after state was applied successfully
        self.store.append_block(&block)?;
        
        // Generate and store transaction receipts
        let receipts = self.generate_receipts(&block);
        let _ = self.receipt_store.store_batch(&receipts);
        
        // Track proposer stats for imported blocks — node key may differ from validator key
        let proposer_key = block.header.proposer_pub_key.clone();
        if let Ok(Some(mut vstate)) = self.validator_store.get_validator(&proposer_key) {
            vstate.blocks_proposed += 1;
            let _ = self.validator_store.set_validator(&proposer_key, &vstate);
        } else {
            if let Ok(validators) = self.validator_store.list_validators() {
                if let Some((top_key, _)) = validators.iter().max_by_key(|(_, v)| v.stake) {
                    if let Ok(Some(mut vstate)) = self.validator_store.get_validator(top_key) {
                        vstate.blocks_proposed += 1;
                        let _ = self.validator_store.set_validator(top_key, &vstate);
                    }
                }
            }
        }
        
        // Auto-vote for imported block
        self.auto_vote_for_block(&block);
        
        eprintln!("[node] Imported block {} from peer", block.header.height);
        Ok(())
    }

    pub fn get_balance(&self, public_key: &str) -> Result<f64, String> {
        let balances = self.balances.lock().map_err(|_| "balance lock")?;
        Ok(*balances.get(public_key).unwrap_or(&0.0))
    }

    /// Get a transaction receipt by hash.
    pub fn get_receipt(&self, tx_hash: &str) -> Result<Option<TxReceipt>, String> {
        self.receipt_store.get(tx_hash)
    }

    /// Generate receipts for all transactions in a block.
    /// Called after successful block application — all txs are assumed successful
    /// since invalid ones were rejected during signature verification.
    fn generate_receipts(&self, block: &BlockV1) -> Vec<TxReceipt> {
        let mut receipts = Vec::with_capacity(block.txs.len());
        for (index, tx) in block.txs.iter().enumerate() {
            let tx_hash = compute_single_tx_hash(tx);

            // Build event log based on tx type
            let log = match tx.tx_type.as_str() {
                "transfer" => TxLog {
                    event_type: "transfer".to_string(),
                    data: serde_json::json!({
                        "to": tx.payload.to_pub_key_hex,
                        "amount": tx.payload.amount,
                    }),
                },
                "create_token" => TxLog {
                    event_type: "token_create".to_string(),
                    data: serde_json::json!({
                        "name": tx.payload.token_name,
                        "symbol": tx.payload.token_symbol,
                        "total_supply": tx.payload.token_total_supply,
                    }),
                },
                "nft_create_collection" => TxLog {
                    event_type: "nft_collection_create".to_string(),
                    data: serde_json::json!({
                        "symbol": tx.payload.nft_collection_symbol,
                        "name": tx.payload.nft_collection_name,
                    }),
                },
                "nft_mint" => TxLog {
                    event_type: "nft_mint".to_string(),
                    data: serde_json::json!({
                        "collection": tx.payload.nft_collection_id,
                        "token_id": tx.payload.nft_token_id,
                    }),
                },
                "nft_transfer" => TxLog {
                    event_type: "nft_transfer".to_string(),
                    data: serde_json::json!({
                        "collection": tx.payload.nft_collection_id,
                        "token_id": tx.payload.nft_token_id,
                        "to": tx.payload.to_pub_key_hex,
                    }),
                },
                "create_pool" | "add_liquidity" | "remove_liquidity" | "swap"
                | "place_limit_order" | "cancel_limit_order" => TxLog {
                    event_type: tx.tx_type.clone(),
                    data: serde_json::json!({
                        "pool_id": tx.payload.pool_id,
                        "token_a": tx.payload.token_a_symbol,
                        "token_b": tx.payload.token_b_symbol,
                        "order_id": tx.payload.limit_order_id,
                    }),
                },
                "stake" | "unstake" => TxLog {
                    event_type: tx.tx_type.clone(),
                    data: serde_json::json!({
                        "amount": tx.payload.amount,
                    }),
                },
                "burn" => TxLog {
                    event_type: "burn".to_string(),
                    data: serde_json::json!({
                        "amount": tx.payload.amount,
                        "token": tx.payload.token_symbol,
                    }),
                },
                "mint_tokens" => TxLog {
                    event_type: "token_mint".to_string(),
                    data: serde_json::json!({
                        "token": tx.payload.token_symbol,
                        "amount": tx.payload.amount,
                        "to": tx.payload.to_pub_key_hex,
                    }),
                },
                // ── Governance ──
                "create_proposal" => TxLog {
                    event_type: "governance_proposal_create".to_string(),
                    data: serde_json::json!({
                        "proposal_id": tx.payload.proposal_id,
                        "title": tx.payload.proposal_title,
                        "token": tx.payload.token_symbol,
                        "type": tx.payload.proposal_type,
                        "end_height": tx.payload.proposal_end_height,
                        "quorum": tx.payload.proposal_quorum,
                        "timelock_blocks": tx.payload.proposal_timelock_blocks,
                    }),
                },
                "cast_vote" => TxLog {
                    event_type: "governance_vote".to_string(),
                    data: serde_json::json!({
                        "proposal_id": tx.payload.proposal_id,
                        "vote": tx.payload.vote_option,
                    }),
                },
                "execute_proposal" => TxLog {
                    event_type: "governance_proposal_execute".to_string(),
                    data: serde_json::json!({
                        "proposal_id": tx.payload.proposal_id,
                    }),
                },
                // ── Multi-sig ──
                "multisig_create" => TxLog {
                    event_type: "multisig_wallet_create".to_string(),
                    data: serde_json::json!({
                        "wallet_id": tx.payload.multisig_wallet_id,
                        "signers": tx.payload.multisig_signers,
                        "threshold": tx.payload.multisig_threshold,
                        "label": tx.payload.multisig_label,
                    }),
                },
                "multisig_submit" => TxLog {
                    event_type: "multisig_proposal_submit".to_string(),
                    data: serde_json::json!({
                        "wallet_id": tx.payload.multisig_wallet_id,
                        "proposal_id": tx.payload.multisig_proposal_id,
                        "inner_tx_type": tx.payload.multisig_proposal_tx_type,
                        "inner_fee": tx.payload.multisig_proposal_fee,
                    }),
                },
                "multisig_approve" => TxLog {
                    event_type: "multisig_proposal_approve".to_string(),
                    data: serde_json::json!({
                        "proposal_id": tx.payload.multisig_proposal_id,
                    }),
                },
                // ── Allowances ──
                "token_approve" => TxLog {
                    event_type: "token_approve".to_string(),
                    data: serde_json::json!({
                        "spender": tx.payload.spender_pub_key,
                        "token": tx.payload.token_symbol,
                        "amount": tx.payload.allowance_amount,
                    }),
                },
                "token_transfer_from" => TxLog {
                    event_type: "token_transfer_from".to_string(),
                    data: serde_json::json!({
                        "owner": tx.payload.owner_pub_key,
                        "to": tx.payload.to_pub_key_hex,
                        "token": tx.payload.token_symbol,
                        "amount": tx.payload.amount,
                    }),
                },
                "token_freeze" => TxLog {
                    event_type: "token_freeze".to_string(),
                    data: serde_json::json!({
                        "token": tx.payload.token_symbol,
                    }),
                },
                // ── Token lock ──
                "token_lock" => TxLog {
                    event_type: "token_lock".to_string(),
                    data: serde_json::json!({
                        "lock_id": tx.payload.lock_id,
                        "token": tx.payload.token_symbol,
                        "amount": tx.payload.amount,
                        "lock_until": tx.payload.lock_until_height,
                    }),
                },
                "token_unlock" => TxLog {
                    event_type: "token_unlock".to_string(),
                    data: serde_json::json!({
                        "lock_id": tx.payload.lock_id,
                    }),
                },
                // ── Contract ops ──
                "contract_deploy" => TxLog {
                    event_type: "contract_deploy".to_string(),
                    data: serde_json::json!({
                        "contract_addr": tx.payload.contract_addr,
                    }),
                },
                "contract_call" => TxLog {
                    event_type: "contract_call".to_string(),
                    data: serde_json::json!({
                        "contract_addr": tx.payload.contract_addr,
                        "method": tx.payload.contract_method,
                    }),
                },
                // ── Delegation ──
                "delegate" => TxLog {
                    event_type: "vote_delegate".to_string(),
                    data: serde_json::json!({
                        "delegate_to": tx.payload.delegate_to,
                    }),
                },
                "undelegate" => TxLog {
                    event_type: "vote_undelegate".to_string(),
                    data: serde_json::json!({}),
                },
                // ── Bridge ──
                "bridge_withdraw" | "bridge_claim" => TxLog {
                    event_type: tx.tx_type.clone(),
                    data: serde_json::json!({
                        "amount": tx.payload.amount,
                        "token": tx.payload.token_symbol,
                    }),
                },
                _ => TxLog {
                    event_type: tx.tx_type.clone(),
                    data: serde_json::json!({}),
                },
            };

            receipts.push(TxReceipt {
                tx_hash,
                block_height: block.header.height,
                block_hash: block.hash.clone(),
                index: index as u32,
                tx_type: tx.tx_type.clone(),
                from: tx.from_pub_key.clone(),
                status: TxStatus::Success,
                fee_paid: tx.fee,
                logs: vec![log],
                timestamp: block.header.time,
            });
        }
        receipts
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

    /// Get all holders and their balances for a specific token symbol
    pub fn get_all_token_balances_for_symbol(&self, token_symbol: &str) -> Result<HashMap<String, f64>, String> {
        let token_balances = self.token_balances.lock().map_err(|_| "token balance lock")?;
        let mut result = HashMap::new();
        for ((pubkey, symbol), balance) in token_balances.iter() {
            if symbol == token_symbol && *balance > 0.0 {
                result.insert(pubkey.clone(), *balance);
            }
        }
        Ok(result)
    }

    /// Get all native XRGE balances (from the main balances map, not token_balances)
    pub fn get_all_native_balances(&self) -> Result<HashMap<String, f64>, String> {
        let balances = self.balances.lock().map_err(|_| "balance lock")?;
        Ok(balances.iter()
            .filter(|(_, b)| **b > 0.0)
            .map(|(k, v)| (k.clone(), *v))
            .collect())
    }

    // Shielded transaction public API
    pub fn is_nullifier_spent(&self, nullifier_hex: &str) -> Result<bool, String> {
        self.nullifier_store.is_spent(nullifier_hex)
    }

    pub fn get_commitment_count(&self) -> usize {
        self.commitment_store.count()
    }

    pub fn get_nullifier_count(&self) -> usize {
        self.nullifier_store.count()
    }

    /// Total XRGE currently in the shielded privacy pool
    pub fn get_shielded_supply(&self) -> f64 {
        self.shielded_supply.lock().map(|v| *v).unwrap_or(0.0)
    }

    /// Find the original creator of a token by scanning blockchain history
    pub fn find_token_creator(&self, token_symbol: &str) -> Result<Option<String>, String> {
        let tip = self.store.get_tip()?;
        
        // Scan all blocks for the create_token transaction
        for height in 1..=tip.height {
            if let Ok(Some(block)) = self.store.get_block(height) {
                for tx in &block.txs {
                    if tx.tx_type == "create_token" {
                        if let Some(ref symbol) = tx.payload.token_symbol {
                            if symbol.to_uppercase() == token_symbol.to_uppercase() {
                                return Ok(Some(tx.from_pub_key.clone()));
                            }
                        }
                    }
                }
            }
        }
        Ok(None)
    }
    
    /// Get the original total supply of a token from its create_token transaction
    pub fn get_token_original_supply(&self, token_symbol: &str) -> Result<u64, String> {
        let tip = self.store.get_tip()?;
        
        for height in 1..=tip.height {
            if let Ok(Some(block)) = self.store.get_block(height) {
                for tx in &block.txs {
                    if tx.tx_type == "create_token" {
                        if let Some(ref symbol) = tx.payload.token_symbol {
                            if symbol.to_uppercase() == token_symbol.to_uppercase() {
                                return Ok(tx.payload.token_total_supply.unwrap_or(0));
                            }
                        }
                    }
                }
            }
        }
        Ok(0)
    }
    
    /// Get the total reserves of a token locked in liquidity pools
    pub fn get_token_pool_reserves(&self, token_symbol: &str) -> Result<u64, String> {
        let pools = self.pool_store.list_pools()?;
        let mut total_reserves: u64 = 0;
        
        for pool in pools {
            if pool.token_a.to_uppercase() == token_symbol.to_uppercase() {
                total_reserves += pool.reserve_a;
            } else if pool.token_b.to_uppercase() == token_symbol.to_uppercase() {
                total_reserves += pool.reserve_b;
            }
        }
        
        Ok(total_reserves)
    }
    
    /// Get all transactions involving a specific token
    pub fn get_token_transactions(&self, token_symbol: &str, limit: usize, offset: usize) -> Result<(Vec<(TxV1, u64, i64)>, usize), String> {
        let mut transactions: Vec<(TxV1, u64, i64)> = Vec::new();
        
        let symbol_upper = token_symbol.to_uppercase();
        
        // Stream blocks one at a time instead of loading all into memory
        self.store.scan_blocks(|block| {
            for tx in &block.txs {
                let matches = match tx.tx_type.as_str() {
                    "create_token" => {
                        tx.payload.token_symbol.as_ref()
                            .map(|s| s.to_uppercase() == symbol_upper)
                            .unwrap_or(false)
                    }
                    "transfer" => {
                        tx.payload.token_symbol.as_ref()
                            .map(|s| s.to_uppercase() == symbol_upper)
                            .unwrap_or(false)
                    }
                    "create_pool" | "add_liquidity" | "remove_liquidity" => {
                        let token_a_match = tx.payload.token_a_symbol.as_ref()
                            .map(|s| s.to_uppercase() == symbol_upper)
                            .unwrap_or(false);
                        let token_b_match = tx.payload.token_b_symbol.as_ref()
                            .map(|s| s.to_uppercase() == symbol_upper)
                            .unwrap_or(false);
                        token_a_match || token_b_match
                    }
                    "swap" => {
                        let token_in_match = tx.payload.token_a_symbol.as_ref()
                            .map(|s| s.to_uppercase() == symbol_upper)
                            .unwrap_or(false);
                        let token_out_match = tx.payload.token_b_symbol.as_ref()
                            .map(|s| s.to_uppercase() == symbol_upper)
                            .unwrap_or(false);
                        token_in_match || token_out_match
                    }
                    "bridge_mint" | "bridge_withdraw" => {
                        tx.payload.token_symbol.as_ref()
                            .map(|s| s.to_uppercase() == symbol_upper)
                            .unwrap_or(false)
                    }
                    _ => false,
                };
                
                if matches {
                    transactions.push((tx.clone(), block.header.height, block.header.time as i64));
                }
            }
            Ok(())
        }, 0)?;
        
        // Sort by timestamp descending (most recent first)
        transactions.sort_by(|a, b| b.2.cmp(&a.2));
        
        let total_count = transactions.len();
        
        // Apply pagination
        let paginated: Vec<(TxV1, u64, i64)> = transactions
            .into_iter()
            .skip(offset)
            .take(limit)
            .collect();
        
        Ok((paginated, total_count))
    }
    
    /// Claim token metadata (for tokens created before metadata system)
    pub fn claim_token_metadata(
        &self,
        symbol: &str,
        claimer_public_key: &str,
    ) -> Result<(), String> {
        // First check if metadata already exists
        if let Ok(Some(_)) = self.token_metadata_store.get_metadata(symbol) {
            return Err("Metadata already exists for this token. Use update instead.".to_string());
        }
        
        // Find the original creator from blockchain
        let creator = self.find_token_creator(symbol)?
            .ok_or_else(|| format!("Token {} not found on blockchain", symbol))?;
        
        // Verify claimer is the original creator
        if creator != claimer_public_key {
            return Err("Only the original token creator can claim metadata".to_string());
        }
        
        // Register the metadata
        self.register_token_metadata(symbol, symbol, &creator, None, None).map(|_| ())
    }

    // ===== Burn Methods =====
    
    /// Get the official burn address
    pub fn get_burn_address() -> &'static str {
        BURN_ADDRESS
    }
    
    /// Get total burned amount for a specific token
    pub fn get_burned_amount(&self, token_symbol: &str) -> Result<f64, String> {
        let burned = self.burned_tokens.lock().map_err(|_| "burned tokens lock")?;
        Ok(*burned.get(token_symbol).unwrap_or(&0.0))
    }
    
    /// Get all burned token amounts
    pub fn get_all_burned_tokens(&self) -> Result<HashMap<String, f64>, String> {
        let burned = self.burned_tokens.lock().map_err(|_| "burned tokens lock")?;
        Ok(burned.clone())
    }

    // ===== Token Metadata Methods =====
    
    /// Get metadata for a token
    pub fn get_token_metadata(&self, symbol: &str) -> Result<Option<TokenMetadata>, String> {
        self.token_metadata_store.get_metadata(symbol)
    }
    
    /// Get all token metadata
    pub fn get_all_token_metadata(&self) -> Result<Vec<TokenMetadata>, String> {
        self.token_metadata_store.get_all()
    }
    
    /// Check if a public key is the creator of a token
    pub fn is_token_creator(&self, symbol: &str, public_key: &str) -> Result<bool, String> {
        self.token_metadata_store.is_creator(symbol, public_key)
    }
    
    /// Register token metadata (called when token is created)
    pub fn register_token_metadata(
        &self,
        symbol: &str,
        name: &str,
        creator: &str,
        image: Option<String>,
        description: Option<String>,
    ) -> Result<String, String> {
        self.register_token_metadata_ext(symbol, name, creator, image, description, false, None)
    }

    pub fn register_token_metadata_ext(
        &self,
        symbol: &str,
        name: &str,
        creator: &str,
        image: Option<String>,
        description: Option<String>,
        mintable: bool,
        max_supply: Option<u64>,
    ) -> Result<String, String> {
        let now = Utc::now().timestamp_millis();
        let token_id = TokenMetadata::generate_token_id(creator, symbol, now);
        let metadata = TokenMetadata {
            symbol: symbol.to_uppercase(),
            name: name.to_string(),
            creator: creator.to_string(),
            token_id: token_id.clone(),
            image,
            description,
            website: None,
            twitter: None,
            discord: None,
            created_at: now,
            updated_at: now,
            frozen: false,
            mintable,
            max_supply,
            total_minted: 0,
        };
        self.token_metadata_store.set_metadata(&metadata)?;
        Ok(token_id)
    }
    
    /// Update token metadata (only creator can update)
    pub fn update_token_metadata(
        &self,
        symbol: &str,
        updater_public_key: &str,
        image: Option<String>,
        description: Option<String>,
        website: Option<String>,
        twitter: Option<String>,
        discord: Option<String>,
    ) -> Result<(), String> {
        // Check if updater is the creator
        let existing = self.token_metadata_store.get_metadata(symbol)?
            .ok_or_else(|| format!("Token {} not found", symbol))?;
        
        if existing.creator != updater_public_key {
            return Err("Only the token creator can update metadata".to_string());
        }
        
        let now = Utc::now().timestamp_millis();
        let updated = TokenMetadata {
            symbol: existing.symbol,
            name: existing.name,
            creator: existing.creator,
            token_id: existing.token_id,
            image: image.or(existing.image),
            description: description.or(existing.description),
            website: website.or(existing.website),
            twitter: twitter.or(existing.twitter),
            discord: discord.or(existing.discord),
            created_at: existing.created_at,
            updated_at: now,
            frozen: existing.frozen,
            mintable: existing.mintable,
            max_supply: existing.max_supply,
            total_minted: existing.total_minted,
        };
        self.token_metadata_store.set_metadata(&updated)
    }

    // ===== Allowance Methods =====

    /// Get allowance for a specific owner/spender/token combination
    pub fn get_allowance(&self, owner: &str, spender: &str, token: &str) -> Result<Option<quantum_vault_storage::allowance_store::Allowance>, String> {
        self.allowance_store.get_allowance(owner, spender, token)
    }

    /// Get all allowances granted by an owner
    pub fn get_allowances_by_owner(&self, owner: &str) -> Result<Vec<quantum_vault_storage::allowance_store::Allowance>, String> {
        self.allowance_store.get_allowances_by_owner(owner)
    }

    /// Get all allowances granted to a spender
    pub fn get_allowances_for_spender(&self, spender: &str) -> Result<Vec<quantum_vault_storage::allowance_store::Allowance>, String> {
        self.allowance_store.get_allowances_for_spender(spender)
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
        
        self.check_nonce_valid(&tx.from_pub_key, tx.nonce)?;

        let tx_hash = bytes_to_hex(&sha256(&encode_tx_v1(&tx)));
        
        let mut mempool = self.mempool.lock().map_err(|_| "mempool lock")?;
        
        if mempool.contains_key(&tx_hash) {
            return Ok(());
        }
        
        // Mark as pre-verified (caller already checked the client-side signature)
        self.verified_tx_ids.lock().map_err(|_| "verified lock")?.insert(tx_hash.clone());
        
        mempool.insert(tx_hash, tx);
        drop(mempool);
        self.mine_notify.notify_one();
        Ok(())
    }

    pub fn get_node_public_key(&self) -> String {
        self.keys.lock().map(|k| k.public_key_hex.clone()).unwrap_or_default()
    }

    pub fn get_mempool_snapshot(&self) -> Vec<TxV1> {
        self.mempool.lock().map(|m| m.values().cloned().collect()).unwrap_or_default()
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
            nonce: self.get_next_nonce(from_public_key),
            payload: TxPayload {
                to_pub_key_hex: Some(to_public_key.to_string()),
                amount: Some(amount_u64),
                token_symbol: token_symbol.map(|s| s.to_string()),
                ..Default::default()
            },
            fee: tx_fee,
            sig: String::new(),
            signed_payload: None,
        };
        let bytes = encode_tx_for_signing(&tx);
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
        const RESERVED_SYMBOLS: &[&str] = &["XRGE", "QETH", "QUSDC", "ETH", "USDC"];
        let symbol_upper = token_symbol.to_uppercase();
        if RESERVED_SYMBOLS.contains(&symbol_upper.as_str()) {
            return Err(format!("'{}' is a reserved token symbol", token_symbol));
        }

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
                amount: Some(total_supply),
                token_name: Some(token_name.to_string()),
                token_symbol: Some(token_symbol.to_string()),
                token_decimals: Some(decimals),
                token_total_supply: Some(total_supply),
                ..Default::default()
            },
            fee: tx_fee,
            sig: String::new(),
            signed_payload: None,
        };
        let bytes = encode_tx_for_signing(&tx);
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
            nonce: self.get_next_nonce(&keys.public_key_hex),
            payload: TxPayload {
                to_pub_key_hex: Some(recipient_public_key.to_string()),
                amount: Some(amount),
                faucet: Some(true),
                ..Default::default()
            },
            fee: 0.0,
            sig: String::new(),
            signed_payload: None,
        };
        let bytes = encode_tx_for_signing(&tx);
        tx.sig = pqc_sign(&keys.secret_key_hex, &bytes)?;
        self.accept_tx(tx.clone())?;
        Ok(tx)
    }

    /// Submit a bridge_withdraw tx (user-signed): burn qETH and record withdrawal for operator to release ETH.
    pub fn submit_bridge_withdraw_tx(
        &self,
        from_private_key: &str,
        from_public_key: &str,
        amount_units: u64,
        evm_address: &str,
        fee: Option<f64>,
    ) -> Result<TxV1, String> {
        let tx_fee = fee.unwrap_or(BASE_TRANSFER_FEE);
        // Check XRGE for fee
        let xrge_balance = self.get_balance(from_public_key)?;
        if xrge_balance < tx_fee {
            return Err(format!("Insufficient XRGE for fee: need {} XRGE", tx_fee));
        }
        // Check qETH balance
        let qeth_balance = self.get_token_balance(from_public_key, "qETH")?;
        if qeth_balance < amount_units as f64 {
            return Err(format!(
                "Insufficient qETH: have {}, need {}",
                qeth_balance, amount_units
            ));
        }
        // Validate EVM address (0x + 40 hex chars)
        let evm = evm_address.trim().to_lowercase();
        let evm = if evm.starts_with("0x") { evm } else { format!("0x{}", evm) };
        if evm.len() != 42 || !evm[2..].chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("Invalid EVM address".to_string());
        }
        let mut tx = TxV1 {
            version: 1,
            tx_type: "bridge_withdraw".to_string(),
            from_pub_key: from_public_key.to_string(),
            nonce: self.get_next_nonce(from_public_key),
            payload: TxPayload {
                amount: Some(amount_units),
                token_symbol: Some("qETH".to_string()),
                evm_address: Some(evm),
                ..Default::default()
            },
            fee: tx_fee,
            sig: String::new(),
            signed_payload: None,
        };
        let bytes = encode_tx_for_signing(&tx);
        tx.sig = pqc_sign(from_private_key, &bytes)?;
        let ok = pqc_verify(from_public_key, &bytes, &tx.sig)?;
        if !ok {
            return Err("invalid signature".to_string());
        }
        self.accept_tx(tx.clone())?;
        Ok(tx)
    }

    /// Submit a bridge_withdraw tx without requiring a private key (pre-verified signature).
    pub fn submit_bridge_withdraw_tx_signed(
        &self,
        from_public_key: &str,
        amount_units: u64,
        evm_address: &str,
        fee: Option<f64>,
        token_symbol: &str,
    ) -> Result<TxV1, String> {
        let tx_fee = fee.unwrap_or(BASE_TRANSFER_FEE);
        let xrge_balance = self.get_balance(from_public_key)?;
        if xrge_balance < tx_fee {
            return Err(format!("Insufficient XRGE for fee: need {} XRGE", tx_fee));
        }
        let token_upper = token_symbol.to_uppercase();
        if token_upper == "XRGE" {
            if xrge_balance - tx_fee < amount_units as f64 {
                return Err(format!(
                    "Insufficient XRGE: have {}, need {}",
                    xrge_balance - tx_fee, amount_units
                ));
            }
        } else {
            let token_balance = self.get_token_balance(from_public_key, &token_upper)?;
            if token_balance < amount_units as f64 {
                return Err(format!(
                    "Insufficient {}: have {}, need {}",
                    token_upper, token_balance, amount_units
                ));
            }
        }
        let evm = evm_address.trim().to_lowercase();
        let evm = if evm.starts_with("0x") { evm } else { format!("0x{}", evm) };
        if evm.len() != 42 || !evm[2..].chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("Invalid EVM address".to_string());
        }
        let keys = self.keys.lock().map_err(|_| "keys lock")?.clone();
        let mut tx = TxV1 {
            version: 1,
            tx_type: "bridge_withdraw".to_string(),
            from_pub_key: from_public_key.to_string(),
            nonce: self.get_next_nonce(from_public_key),
            payload: TxPayload {
                amount: Some(amount_units),
                token_symbol: Some(token_upper),
                evm_address: Some(evm),
                ..Default::default()
            },
            fee: tx_fee,
            sig: String::new(),
            signed_payload: None,
        };
        let bytes = encode_tx_for_signing(&tx);
        tx.sig = pqc_sign(&keys.secret_key_hex, &bytes)?;
        // Mark as pre-verified so mine_pending skips signature re-check.
        // The sig is node-signed (not user-signed), so pqc_verify(user_pubkey, sig) would fail.
        let tx_hash = bytes_to_hex(&sha256(&encode_tx_v1(&tx)));
        self.verified_tx_ids.lock().map_err(|_| "verified lock")?.insert(tx_hash);
        self.accept_tx(tx.clone())?;
        Ok(tx)
    }

    /// Submit a bridge_mint tx (authority only): mint bridged token to recipient.
    /// Used when verifying a deposit from Base Sepolia (or other EVM chain).
    pub fn submit_bridge_mint_tx(
        &self,
        recipient_public_key: &str,
        amount: u64,
        token_symbol: &str,
    ) -> Result<TxV1, String> {
        let keys = self.keys.lock().map_err(|_| "keys lock")?.clone();
        let mut tx = TxV1 {
            version: 1,
            tx_type: "bridge_mint".to_string(),
            from_pub_key: keys.public_key_hex.clone(),
            nonce: self.get_next_nonce(&keys.public_key_hex),
            payload: TxPayload {
                to_pub_key_hex: Some(recipient_public_key.to_string()),
                amount: Some(amount),
                token_symbol: Some(token_symbol.to_string()),
                ..Default::default()
            },
            fee: 0.0,
            sig: String::new(),
            signed_payload: None,
        };
        let bytes = encode_tx_for_signing(&tx);
        tx.sig = pqc_sign(&keys.secret_key_hex, &bytes)?;
        self.accept_tx(tx.clone())?;
        Ok(tx)
    }

    /// Submit a contract_deploy tx: records a WASM contract deployment on-chain.
    pub fn submit_contract_deploy_tx(
        &self,
        deployer: &str,
        contract_addr: &str,
        wasm_size: usize,
    ) -> Result<TxV1, String> {
        let keys = self.keys.lock().map_err(|_| "keys lock")?.clone();
        let mut tx = TxV1 {
            version: 1,
            tx_type: "contract_deploy".to_string(),
            from_pub_key: keys.public_key_hex.clone(),
            nonce: self.get_next_nonce(&keys.public_key_hex),
            payload: TxPayload {
                contract_addr: Some(contract_addr.to_string()),
                amount: Some(wasm_size as u64),
                to_pub_key_hex: Some(deployer.to_string()),
                ..Default::default()
            },
            fee: (wasm_size as f64) * 0.000001, // Gas fee: 0.000001 XRGE per byte
            sig: String::new(),
            signed_payload: None,
        };
        let bytes = encode_tx_for_signing(&tx);
        tx.sig = pqc_sign(&keys.secret_key_hex, &bytes)?;
        let tx_hash = bytes_to_hex(&sha256(&encode_tx_v1(&tx)));
        self.verified_tx_ids.lock().map_err(|_| "verified lock")?.insert(tx_hash);
        self.accept_tx(tx.clone())?;
        Ok(tx)
    }

    /// Submit a contract_call tx: records a WASM contract method call on-chain.
    pub fn submit_contract_call_tx(
        &self,
        caller: &str,
        contract_addr: &str,
        method: &str,
        gas_used: u64,
        success: bool,
    ) -> Result<TxV1, String> {
        let keys = self.keys.lock().map_err(|_| "keys lock")?.clone();
        let mut tx = TxV1 {
            version: 1,
            tx_type: "contract_call".to_string(),
            from_pub_key: keys.public_key_hex.clone(),
            nonce: self.get_next_nonce(&keys.public_key_hex),
            payload: TxPayload {
                contract_addr: Some(contract_addr.to_string()),
                contract_method: Some(method.to_string()),
                contract_gas_limit: Some(gas_used),
                to_pub_key_hex: if caller.is_empty() { None } else { Some(caller.to_string()) },
                reason: if success { None } else { Some("failed".to_string()) },
                ..Default::default()
            },
            fee: (gas_used as f64) * 0.000001, // Gas fee: 0.000001 XRGE per gas unit
            sig: String::new(),
            signed_payload: None,
        };
        let bytes = encode_tx_for_signing(&tx);
        tx.sig = pqc_sign(&keys.secret_key_hex, &bytes)?;
        let tx_hash = bytes_to_hex(&sha256(&encode_tx_v1(&tx)));
        self.verified_tx_ids.lock().map_err(|_| "verified lock")?.insert(tx_hash);
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
            nonce: self.get_next_nonce(from_public_key),
            payload: TxPayload {
                amount: Some(amount_u64),
                ..Default::default()
            },
            fee: tx_fee,
            sig: String::new(),
            signed_payload: None,
        };
        let bytes = encode_tx_for_signing(&tx);
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
            nonce: self.get_next_nonce(from_public_key),
            payload: TxPayload {
                amount: Some(amount_u64),
                ..Default::default()
            },
            fee: fee.unwrap_or(BASE_TRANSFER_FEE),
            sig: String::new(),
            signed_payload: None,
        };
        let bytes = encode_tx_for_signing(&tx);
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

    /// Automatically submit prevote + precommit for a finalized block.
    /// Uses the highest-staked validator key as the voter (node key != validator key).
    pub fn auto_vote_for_block(&self, block: &BlockV1) {
        let voter_key = if let Ok(validators) = self.validator_store.list_validators() {
            validators.iter().max_by_key(|(_, v)| v.stake).map(|(k, _)| k.clone())
        } else {
            None
        };
        let voter = match voter_key {
            Some(k) => k,
            None => return,
        };
        // Sign the vote with the node's ML-DSA-65 key
        let vote_data = format!("ROUGECHAIN_VOTE:{}:{}:{}", block.header.height, 0, block.hash);
        let sig = match self.keys.lock() {
            Ok(keys) => pqc_sign(&keys.secret_key_hex, vote_data.as_bytes()).unwrap_or_else(|_| "sig_error".to_string()),
            Err(_) => "sig_error".to_string(),
        };

        // Prevote
        let _ = self.submit_vote(VoteMessage {
            vote_type: "prevote".to_string(),
            height: block.header.height,
            round: 0,
            block_hash: block.hash.clone(),
            voter_pub_key: voter.clone(),
            signature: sig.clone(),
        });

        // Precommit
        let _ = self.submit_vote(VoteMessage {
            vote_type: "precommit".to_string(),
            height: block.header.height,
            round: 0,
            block_hash: block.hash.clone(),
            voter_pub_key: voter,
            signature: sig,
        });

        // Attempt finalization (2/3+ stake quorum)
        self.try_finalize_block(block.header.height);
    }

    /// Attempt to finalize a block if 2/3+ stake has precommitted.
    /// Only advances finalized_height if quorum is met.
    fn try_finalize_block(&self, height: u64) {
        match self.generate_finality_proof(height) {
            Ok(Some(proof)) => {
                // Persist the finality proof
                let key = height.to_be_bytes();
                if let Ok(json) = serde_json::to_vec(&proof) {
                    let _ = self.finality_db.insert(key, json);
                    let _ = self.finality_db.flush();
                }
                // Advance finalized_height
                if let Ok(mut fh) = self.finalized_height.lock() {
                    if height > *fh {
                        *fh = height;
                        eprintln!("[bft] Block {} finalized (voting_stake={}/{}, quorum={})",
                            height, proof.voting_stake, proof.total_stake, proof.quorum_threshold);
                    }
                }
            }
            Ok(None) => {
                // Not enough votes yet — this is normal for multi-validator networks
            }
            Err(e) => {
                eprintln!("[bft] Error generating finality proof for height {}: {}", height, e);
            }
        }
    }

    pub fn submit_entropy(&self, public_key: &str) -> Result<(), String> {
        let mut state = self.validator_store.get_validator(public_key)?.unwrap_or(ValidatorState {
            stake: 0,
            slash_count: 0,
            jailed_until: 0,
            entropy_contributions: 0,
            blocks_proposed: 0,
            name: None,
            missed_blocks: 0,
            total_slashed: 0,
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
                validators.push((public_key, ValidatorState { stake: state.stake, slash_count: state.slash_count, jailed_until: state.jailed_until, entropy_contributions: state.entropy_contributions, blocks_proposed: state.blocks_proposed, name: state.name.clone(), missed_blocks: state.missed_blocks, total_slashed: state.total_slashed }));
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

    /// Generate a BFT finality proof for a given block height.
    /// Returns None if there aren't enough precommit votes to meet quorum.
    pub fn generate_finality_proof(&self, height: u64) -> Result<Option<quantum_vault_types::FinalityProof>, String> {
        let stakes = self.get_validator_stakes()?;
        let total_stake: u128 = stakes.values().sum();
        let quorum = if total_stake == 0 { return Ok(None); } else { (total_stake * 2 / 3) + 1 };

        let votes = self.votes.lock().map_err(|_| "votes lock")?;
        let precommits: Vec<VoteMessage> = votes.iter()
            .filter(|v| v.height == height && v.vote_type == "precommit")
            .cloned()
            .collect();

        // Calculate voting stake (sum of stake for each unique precommit voter)
        let mut voting_stake: u128 = 0;
        let mut seen_voters = std::collections::HashSet::new();
        for vote in &precommits {
            if seen_voters.insert(vote.voter_pub_key.clone()) {
                voting_stake += stakes.get(&vote.voter_pub_key).copied().unwrap_or(0);
            }
        }

        if voting_stake < quorum {
            return Ok(None); // Insufficient votes
        }

        // Get block hash from the votes (they all voted on the same hash)
        let block_hash = precommits.first()
            .map(|v| v.block_hash.clone())
            .unwrap_or_default();

        Ok(Some(quantum_vault_types::FinalityProof {
            height,
            block_hash,
            total_stake,
            voting_stake,
            quorum_threshold: quorum,
            precommit_votes: precommits,
            created_at: chrono::Utc::now().timestamp_millis() as u64,
        }))
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
        let tip = self.store.get_tip()?;
        let last_fees = if let Some(last_block) = self.store.get_block(tip.height)? {
            last_block.txs.iter().map(|tx| tx.fee).sum::<f64>()
        } else {
            0.0
        };
        // Stream through blocks one at a time instead of loading all into memory
        let total_fees = self.store.sum_all_fees()?;
        Ok((total_fees, last_fees))
    }

    pub fn mine_pending(&self) -> Result<Option<BlockV1>, String> {
        let mut mempool = self.mempool.lock().map_err(|_| "mempool lock")?;
        if mempool.is_empty() {
            return Ok(None);
        }
        let tx_entries: Vec<(String, TxV1)> = mempool.drain().collect();
        drop(mempool);
        let mut verified_set = self.verified_tx_ids.lock().map_err(|_| "verified lock")?;
        // Verify signatures in parallel; skip re-verification for pre-verified (v2 API) txs
        let txs: Vec<TxV1> = {
            use rayon::prelude::*;
            tx_entries.into_par_iter()
                .filter(|(id, tx)| {
                    if verified_set.contains(id) {
                        return true;
                    }
                    let bytes = encode_tx_for_signing(tx);
                    pqc_verify(&tx.from_pub_key, &bytes, &tx.sig).ok() == Some(true)
                })
                .map(|(_, tx)| tx)
                .collect()
        };
        verified_set.clear();
        drop(verified_set);
        if txs.is_empty() {
            return Ok(None);
        }
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
        // Note: finalized_height set here as proposer (single-validator mode).
        // In multi-validator mode, try_finalize_block (called by auto_vote_for_block)
        // handles finalization via vote quorum verification.
        
        // Generate and store transaction receipts
        let receipts = self.generate_receipts(&block);
        let _ = self.receipt_store.store_batch(&receipts);
        
        // Track proposer stats — node key may differ from validator staking key
        let proposer_key = block.header.proposer_pub_key.clone();
        if let Ok(Some(mut vstate)) = self.validator_store.get_validator(&proposer_key) {
            vstate.blocks_proposed += 1;
            let _ = self.validator_store.set_validator(&proposer_key, &vstate);
        } else {
            // Fallback: assign to highest-staked validator
            if let Ok(validators) = self.validator_store.list_validators() {
                if let Some((top_key, _)) = validators.iter().max_by_key(|(_, v)| v.stake) {
                    if let Ok(Some(mut vstate)) = self.validator_store.get_validator(top_key) {
                        vstate.blocks_proposed += 1;
                        let _ = self.validator_store.set_validator(top_key, &vstate);
                    }
                }
            }
        }
        
        // Auto-vote for the block we just mined
        self.auto_vote_for_block(&block);
        
        // Track quantum entropy contributions
        let (_, entropy_source) = fetch_entropy();
        if entropy_source == "quantum" {
            // Credit the proposing validator (or highest-staked fallback)
            let credit_key = if self.validator_store.get_validator(&proposer_key).ok().flatten().is_some() {
                proposer_key.clone()
            } else if let Ok(validators) = self.validator_store.list_validators() {
                validators.iter().max_by_key(|(_, v)| v.stake).map(|(k, _)| k.clone()).unwrap_or_default()
            } else {
                String::new()
            };
            if !credit_key.is_empty() {
                let _ = self.submit_entropy(&credit_key);
            }
        }
        
        Ok(Some(block))
    }

    /// Get the current nonce for an account (0 if never used)
    pub fn get_account_nonce(&self, pubkey: &str) -> u64 {
        match self.nonce_db.get(pubkey.as_bytes()) {
            Ok(Some(bytes)) => {
                let arr: [u8; 8] = bytes.as_ref().try_into().unwrap_or([0u8; 8]);
                u64::from_be_bytes(arr)
            }
            _ => 0,
        }
    }

    /// Get the next nonce to use for a new tx from this account
    pub fn get_next_nonce(&self, pubkey: &str) -> u64 {
        self.get_account_nonce(pubkey) + 1
    }

    /// Auto-migrate: detect and clear stale timestamp-based nonces.
    /// Any nonce > 1_000_000_000 is clearly a millisecond timestamp, not a sequential nonce.
    /// Clears the entire nonce_db so rebuild_balances() can repopulate from chain history.
    fn migrate_nonce_db(&self) {
        let mut stale_count = 0usize;
        for item in self.nonce_db.iter() {
            if let Ok((_key, val)) = item {
                if val.len() == 8 {
                    let arr: [u8; 8] = val.as_ref().try_into().unwrap_or([0u8; 8]);
                    let nonce = u64::from_be_bytes(arr);
                    if nonce > 1_000_000_000 {
                        stale_count += 1;
                    }
                }
            }
        }
        if stale_count > 0 {
            eprintln!("[startup] Detected {} stale timestamp nonces — clearing nonce_db for rebuild", stale_count);
            let _ = self.nonce_db.clear();
        }
    }

    /// Validate that tx nonce is strictly greater than the current stored nonce,
    /// then update the stored nonce. Gap-tolerant: allows nonce > current+1 for
    /// backward compatibility with timestamp-based nonces during migration.
    fn validate_and_increment_nonce(&self, from_pub_key: &str, nonce: u64) -> Result<(), String> {
        let current = self.get_account_nonce(from_pub_key);
        if nonce <= current {
            return Err(format!(
                "Invalid nonce: must be > {}, got {} (account: {}...)",
                current,
                nonce,
                &from_pub_key[..16.min(from_pub_key.len())]
            ));
        }
        self.nonce_db
            .insert(from_pub_key.as_bytes(), &nonce.to_be_bytes())
            .map_err(|e| format!("nonce store: {}", e))?;
        Ok(())
    }

    /// Validate nonce without incrementing (for mempool acceptance)
    fn check_nonce_valid(&self, from_pub_key: &str, nonce: u64) -> Result<(), String> {
        let current = self.get_account_nonce(from_pub_key);
        if nonce <= current {
            return Err(format!(
                "Invalid nonce: must be > {}, got {}",
                current,
                nonce,
            ));
        }
        Ok(())
    }

    fn accept_tx(&self, tx: TxV1) -> Result<(), String> {
        self.check_nonce_valid(&tx.from_pub_key, tx.nonce)?;
        let id = bytes_to_hex(&sha256(&encode_tx_v1(&tx)));
        let mut mempool = self.mempool.lock().map_err(|_| "mempool lock")?;
        if mempool.len() >= MAX_MEMPOOL {
            if let Some(oldest) = mempool.keys().next().cloned() {
                mempool.remove(&oldest);
            }
        }
        mempool.insert(id, tx);
        drop(mempool);
        self.mine_notify.notify_one();
        Ok(())
    }

    // Fee distribution constants
    const PROPOSER_FEE_SHARE: f64 = 0.20;  // 20% to block proposer
    const VALIDATOR_FEE_SHARE: f64 = 0.70;  // 70% split among validators by stake
    const TREASURY_FEE_SHARE: f64 = 0.10;  // 10% to community treasury

    /// Get the current base fee
    pub fn get_base_fee(&self) -> f64 {
        self.fee_db.get(b"base_fee").ok().flatten()
            .and_then(|v| String::from_utf8(v.to_vec()).ok())
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(BASE_FEE_INITIAL)
    }

    /// Persist base fee
    fn set_base_fee(&self, fee: f64) {
        let _ = self.fee_db.insert(b"base_fee", fee.to_string().as_bytes());
        let _ = self.fee_db.flush();
    }

    /// Get total fees burned
    pub fn get_total_fees_burned(&self) -> f64 {
        *self.total_fees_burned.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Persist total fees burned to sled
    fn persist_fees_burned(&self) {
        let burned = self.get_total_fees_burned();
        let _ = self.fee_db.insert(b"total_burned", burned.to_string().as_bytes());
        let _ = self.fee_db.flush();
    }

    /// Calculate next base fee based on block fullness (EIP-1559)
    fn calculate_next_base_fee(&self, tx_count: usize) -> f64 {
        let current = self.get_base_fee();
        if tx_count == TARGET_TXS_PER_BLOCK {
            return current; // At target, no change
        }
        let delta = if tx_count > TARGET_TXS_PER_BLOCK {
            // Above target → increase
            let excess = tx_count - TARGET_TXS_PER_BLOCK;
            current * (excess as f64) / (TARGET_TXS_PER_BLOCK as f64) / BASE_FEE_MAX_CHANGE_DENOM
        } else {
            // Below target → decrease
            let deficit = TARGET_TXS_PER_BLOCK - tx_count;
            -(current * (deficit as f64) / (TARGET_TXS_PER_BLOCK as f64) / BASE_FEE_MAX_CHANGE_DENOM)
        };
        (current + delta).max(BASE_FEE_FLOOR)
    }

    fn apply_balance_block(&self, block: &BlockV1) -> Result<(), String> {
        let mut balances = self.balances.lock().map_err(|_| "balance lock")?;
        let mut token_balances = self.token_balances.lock().map_err(|_| "token balance lock")?;
        let mut lp_balances = self.lp_balances.lock().map_err(|_| "lp balance lock")?;
        let mut burned_tokens = self.burned_tokens.lock().map_err(|_| "burned tokens lock")?;
        
        // Track actual fees collected (not all tx fees -- rejected txs don't pay)
        let mut actual_fees_collected = 0.0_f64;

        let node_pub_key = self.keys.lock().map(|k| k.public_key_hex.clone()).unwrap_or_default();
        // Apply transaction effects (transfers, stakes, etc.) - fees deducted from senders
        for tx in &block.txs {
            let before = balances.values().sum::<f64>();
            Self::apply_balance_tx_inner(&mut balances, &mut token_balances, &mut burned_tokens, tx, Some(&self.validator_store), &node_pub_key, &self.unbonding_queue, block.header.height, &self.shielded_supply);
            // Commit sequential nonce for this sender
            let _ = self.nonce_db.insert(tx.from_pub_key.as_bytes(), &tx.nonce.to_be_bytes());
            // Index sender and recipient addresses for rouge1 resolution
            self.index_address(&tx.from_pub_key);
            if let Some(ref to_pk) = tx.payload.to_pub_key_hex {
                self.index_address(to_pk);
            }
            let after = balances.values().sum::<f64>();
            let deducted = before - after;
            if deducted > 0.0 { actual_fees_collected += tx.fee.min(deducted); }
            
            // Handle AMM transactions
            let before_amm = balances.values().sum::<f64>();
            self.apply_amm_tx_inner(
                &mut balances,
                &mut token_balances,
                &mut lp_balances,
                tx,
                block.header.time,
                block.header.height,
            )?;
            let after_amm = balances.values().sum::<f64>();
            let deducted_amm = before_amm - after_amm;
            if deducted_amm > 0.0 { actual_fees_collected += tx.fee.min(deducted_amm); }

            // Handle NFT transactions
            let before_nft = balances.values().sum::<f64>();
            self.apply_nft_tx_inner(
                &mut balances,
                tx,
                block.header.time,
            )?;
            let after_nft = balances.values().sum::<f64>();
            let deducted_nft = before_nft - after_nft;
            if deducted_nft > 0.0 { actual_fees_collected += tx.fee.min(deducted_nft); }

            // Handle allowance transactions (approve / transfer_from)
            match tx.tx_type.as_str() {
                "approve" => {
                    let spender = match tx.payload.spender_pub_key.as_ref() {
                        Some(s) if !s.is_empty() => s,
                        _ => { eprintln!("[node] Rejecting approve: missing spender"); continue; }
                    };
                    let symbol = match tx.payload.token_symbol.as_ref() {
                        Some(s) if !s.is_empty() => s.trim().to_uppercase(),
                        _ => { eprintln!("[node] Rejecting approve: missing token_symbol"); continue; }
                    };
                    let amount = tx.payload.allowance_amount.unwrap_or(0);

                    // Fee guard
                    let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                    if xrge_bal < tx.fee {
                        eprintln!("[node] Rejecting approve: insufficient XRGE for fee ({:.4} < {:.4})", xrge_bal, tx.fee);
                        continue;
                    }
                    *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
                    actual_fees_collected += tx.fee;

                    let allowance = quantum_vault_storage::allowance_store::Allowance {
                        owner: tx.from_pub_key.clone(),
                        spender: spender.clone(),
                        token_symbol: symbol.clone(),
                        amount,
                    };
                    if let Err(e) = self.allowance_store.set_allowance(&allowance) {
                        eprintln!("[node] Failed to set allowance: {}", e);
                    }
                }
                "transfer_from" => {
                    let owner = match tx.payload.owner_pub_key.as_ref() {
                        Some(o) if !o.is_empty() => o,
                        _ => { eprintln!("[node] Rejecting transfer_from: missing owner"); continue; }
                    };
                    let to = match tx.payload.to_pub_key_hex.as_ref() {
                        Some(t) if !t.is_empty() => t,
                        _ => { eprintln!("[node] Rejecting transfer_from: missing recipient"); continue; }
                    };
                    let symbol = match tx.payload.token_symbol.as_ref() {
                        Some(s) if !s.is_empty() => s.trim().to_uppercase(),
                        _ => { eprintln!("[node] Rejecting transfer_from: missing token_symbol"); continue; }
                    };
                    let amount = tx.payload.amount.unwrap_or(0);
                    if amount == 0 {
                        eprintln!("[node] Rejecting transfer_from: zero amount");
                        continue;
                    }

                    // Fee guard (spender pays gas)
                    let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                    if xrge_bal < tx.fee {
                        eprintln!("[node] Rejecting transfer_from: insufficient XRGE for fee ({:.4} < {:.4})", xrge_bal, tx.fee);
                        continue;
                    }

                    // Check allowance
                    let current_allowance = self.allowance_store
                        .get_allowance(owner, &tx.from_pub_key, &symbol)
                        .unwrap_or(None)
                        .map(|a| a.amount)
                        .unwrap_or(0);
                    if current_allowance < amount {
                        eprintln!("[node] Rejecting transfer_from: allowance {} < amount {}", current_allowance, amount);
                        continue;
                    }

                    // Check owner's token balance
                    let owner_key = (owner.clone(), symbol.clone());
                    let owner_bal = *token_balances.get(&owner_key).unwrap_or(&0.0);
                    if owner_bal < amount as f64 {
                        eprintln!("[node] Rejecting transfer_from: owner {} balance {:.4} < {}", symbol, owner_bal, amount);
                        continue;
                    }

                    // Execute: deduct fee from spender, move tokens owner→recipient, decrement allowance
                    *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
                    actual_fees_collected += tx.fee;

                    *token_balances.entry(owner_key).or_insert(0.0) -= amount as f64;
                    let recipient_key = (to.clone(), symbol.clone());
                    *token_balances.entry(recipient_key).or_insert(0.0) += amount as f64;

                    // Decrement allowance
                    let new_allowance = quantum_vault_storage::allowance_store::Allowance {
                        owner: owner.clone(),
                        spender: tx.from_pub_key.clone(),
                        token_symbol: symbol.clone(),
                        amount: current_allowance - amount,
                    };
                    if let Err(e) = self.allowance_store.set_allowance(&new_allowance) {
                        eprintln!("[node] Failed to update allowance: {}", e);
                    }
                }
                _ => {}
            }

            // ── Multi-sig wallet transactions ──
            match tx.tx_type.as_str() {
                "multisig_create" => {
                    let signers = tx.payload.multisig_signers.clone().unwrap_or_default();
                    let threshold = tx.payload.multisig_threshold.unwrap_or(2) as u32;
                    if signers.len() < 2 || threshold < 1 || threshold > signers.len() as u32 {
                        eprintln!("[node] Rejecting multisig_create: invalid signers/threshold");
                    } else {
                        let wallet_id = tx.payload.multisig_wallet_id.clone()
                            .unwrap_or_else(|| format!("ms-{}", &quantum_vault_types::compute_single_tx_hash(tx)[..16]));
                        let wallet = MultisigWallet {
                            wallet_id: wallet_id.clone(),
                            creator: tx.from_pub_key.clone(),
                            signers,
                            threshold,
                            created_at_height: block.header.height,
                            label: tx.payload.multisig_label.clone(),
                        };
                        if let Err(e) = self.multisig_store.create_wallet(&wallet) {
                            eprintln!("[node] Failed to create multisig wallet: {}", e);
                        } else {
                            eprintln!("[node] Created multisig wallet {} ({}-of-{})", wallet_id, threshold, wallet.signers.len());
                        }
                    }
                }
                "multisig_submit" => {
                    let wallet_id = match tx.payload.multisig_wallet_id.as_ref() {
                        Some(id) => id.clone(),
                        None => { eprintln!("[node] Rejecting multisig_submit: missing wallet_id"); continue; }
                    };
                    if let Ok(Some(wallet)) = self.multisig_store.get_wallet(&wallet_id) {
                        if !wallet.signers.contains(&tx.from_pub_key) {
                            eprintln!("[node] Rejecting multisig_submit: not a signer");
                        } else {
                            let proposal_id = tx.payload.multisig_proposal_id.clone()
                                .unwrap_or_else(|| format!("mp-{}", &quantum_vault_types::compute_single_tx_hash(tx)[..16]));
                            let proposal = MultisigProposal {
                                proposal_id: proposal_id.clone(),
                                wallet_id,
                                tx_type: tx.payload.multisig_proposal_tx_type.clone().unwrap_or_else(|| "transfer".into()),
                                proposer: tx.from_pub_key.clone(),
                                payload: tx.payload.multisig_proposal_payload.clone().unwrap_or(serde_json::json!({})),
                                fee: tx.payload.multisig_proposal_fee.unwrap_or(0.1),
                                approvals: vec![tx.from_pub_key.clone()],
                                signatures: vec![tx.sig.clone()],
                                executed: false,
                                created_at_height: block.header.height,
                                executed_at_height: None,
                            };
                            if let Err(e) = self.multisig_store.create_proposal(&proposal) {
                                eprintln!("[node] Failed to create multisig proposal: {}", e);
                            } else {
                                eprintln!("[node] Created multisig proposal {}", proposal_id);
                            }
                        }
                    }
                }
                "multisig_approve" => {
                    let proposal_id = match tx.payload.multisig_proposal_id.as_ref() {
                        Some(id) => id.clone(),
                        None => { eprintln!("[node] Rejecting multisig_approve: missing proposal_id"); continue; }
                    };
                    if let Ok(Some(mut proposal)) = self.multisig_store.get_proposal(&proposal_id) {
                        if proposal.executed {
                            eprintln!("[node] Rejecting multisig_approve: already executed");
                        } else if let Ok(Some(wallet)) = self.multisig_store.get_wallet(&proposal.wallet_id) {
                            if !wallet.signers.contains(&tx.from_pub_key) {
                                eprintln!("[node] Rejecting multisig_approve: not a signer");
                            } else if proposal.approvals.contains(&tx.from_pub_key) {
                                eprintln!("[node] Rejecting multisig_approve: already approved");
                            } else {
                                proposal.approvals.push(tx.from_pub_key.clone());
                                proposal.signatures.push(tx.payload.multisig_approval_sig.clone().unwrap_or(tx.sig.clone()));

                                // Check if threshold is now met
                                if proposal.approvals.len() >= wallet.threshold as usize {
                                    proposal.executed = true;
                                    proposal.executed_at_height = Some(block.header.height);
                                    eprintln!("[node] Multisig proposal {} executed ({}/{} approvals)",
                                        proposal_id, proposal.approvals.len(), wallet.threshold);

                                    // Execute the inner transfer
                                    if proposal.tx_type == "transfer" {
                                        if let (Some(to), Some(amount)) = (
                                            proposal.payload.get("to_pub_key_hex").and_then(|v| v.as_str()),
                                            proposal.payload.get("amount").and_then(|v| v.as_u64()),
                                        ) {
                                            let b = balances.entry(wallet.creator.clone()).or_insert(0.0);
                                            if *b >= amount as f64 {
                                                *b -= amount as f64;
                                                *balances.entry(to.to_string()).or_insert(0.0) += amount as f64;
                                                eprintln!("[node] Multisig transfer: {} XRGE from {} to {}", amount, wallet.creator, &to[..16]);
                                            }
                                        }
                                    }
                                }

                                if let Err(e) = self.multisig_store.update_proposal(&proposal) {
                                    eprintln!("[node] Failed to update proposal: {}", e);
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        
        // Persist bridge_withdraw txs for operator to fulfill releases
        if let Some(ref store) = self.opts.bridge_withdraw_store {
            for tx in &block.txs {
                if tx.tx_type == "bridge_withdraw"
                    && tx.payload.amount.unwrap_or(0) > 0
                {
                    if let Some(evm_addr) = tx.payload.evm_address.as_ref() {
                        let token = tx.payload.token_symbol.as_deref().unwrap_or("qETH");
                        let prefix = if token == "XRGE" { "xrge:" } else { "" };
                        let raw_id = bytes_to_hex(&sha256(&encode_tx_v1(tx)));
                        let tx_id = format!("{}{}", prefix, raw_id);
                        let amount = tx.payload.amount.unwrap_or(0);
                        let _ = store.add(tx_id.clone(), evm_addr.clone(), amount);
                    }
                }
            }
        }
        
        // Distribute only actually collected fees
        if actual_fees_collected > 0.0 {
            let base_fee = self.get_base_fee();
            Self::distribute_fees(
                &mut balances,
                actual_fees_collected,
                &block.header.proposer_pub_key,
                &self.get_validator_stakes_snapshot()?,
                base_fee,
                block.txs.len(),
                &self.total_fees_burned,
            );
        }

        // EIP-1559: recalculate base fee for next block
        let next_base_fee = self.calculate_next_base_fee(block.txs.len());
        self.set_base_fee(next_base_fee);
        self.persist_fees_burned();
        
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

                // Balance guard
                let mut xrge_needed = tx.fee;
                if token_a == "XRGE" { xrge_needed += amount_a as f64; }
                if token_b == "XRGE" { xrge_needed += amount_b as f64; }
                let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                if xrge_bal < xrge_needed {
                    eprintln!("[node] Rejecting create_pool: insufficient XRGE ({:.4} < {:.4})", xrge_bal, xrge_needed);
                    return Ok(());
                }
                if token_a != "XRGE" {
                    let key = (tx.from_pub_key.clone(), token_a.clone());
                    let bal = *token_balances.get(&key).unwrap_or(&0.0);
                    if bal < amount_a as f64 {
                        eprintln!("[node] Rejecting create_pool: insufficient {} ({:.4} < {})", token_a, bal, amount_a);
                        return Ok(());
                    }
                }
                if token_b != "XRGE" {
                    let key = (tx.from_pub_key.clone(), token_b.clone());
                    let bal = *token_balances.get(&key).unwrap_or(&0.0);
                    if bal < amount_b as f64 {
                        eprintln!("[node] Rejecting create_pool: insufficient {} ({:.4} < {})", token_b, bal, amount_b);
                        return Ok(());
                    }
                }
                
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
                
                let mut pool = match self.pool_store.get_pool(pool_id)? {
                    Some(p) => p,
                    None => {
                        eprintln!("[node] Warning: Pool {} not found, skipping add_liquidity", pool_id);
                        return Ok(());
                    }
                };

                // Balance guard
                let mut xrge_needed = tx.fee;
                if pool.token_a == "XRGE" { xrge_needed += amount_a as f64; }
                if pool.token_b == "XRGE" { xrge_needed += amount_b as f64; }
                let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                if xrge_bal < xrge_needed {
                    eprintln!("[node] Rejecting add_liquidity: insufficient XRGE ({:.4} < {:.4})", xrge_bal, xrge_needed);
                    return Ok(());
                }
                if pool.token_a != "XRGE" {
                    let key = (tx.from_pub_key.clone(), pool.token_a.clone());
                    let bal = *token_balances.get(&key).unwrap_or(&0.0);
                    if bal < amount_a as f64 {
                        eprintln!("[node] Rejecting add_liquidity: insufficient {} ({:.4} < {})", pool.token_a, bal, amount_a);
                        return Ok(());
                    }
                }
                if pool.token_b != "XRGE" {
                    let key = (tx.from_pub_key.clone(), pool.token_b.clone());
                    let bal = *token_balances.get(&key).unwrap_or(&0.0);
                    if bal < amount_b as f64 {
                        eprintln!("[node] Rejecting add_liquidity: insufficient {} ({:.4} < {})", pool.token_b, bal, amount_b);
                        return Ok(());
                    }
                }
                
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
                
                let mut pool = match self.pool_store.get_pool(pool_id)? {
                    Some(p) => p,
                    None => {
                        eprintln!("[node] Warning: Pool {} not found, skipping remove_liquidity", pool_id);
                        return Ok(());
                    }
                };

                // Balance guard: check XRGE for fee and LP token balance
                let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                if xrge_bal < tx.fee {
                    eprintln!("[node] Rejecting remove_liquidity: insufficient XRGE for fee ({:.4} < {:.4})", xrge_bal, tx.fee);
                    return Ok(());
                }
                let lp_key = (tx.from_pub_key.clone(), pool_id.clone());
                let lp_bal = *lp_balances.get(&lp_key).unwrap_or(&0.0);
                if lp_bal < lp_amount as f64 {
                    eprintln!("[node] Rejecting remove_liquidity: insufficient LP tokens ({:.4} < {})", lp_bal, lp_amount);
                    return Ok(());
                }
                
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

                // Balance guard: reject swap if user cannot afford it
                let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                if token_in == "XRGE" {
                    if xrge_bal < amount_in as f64 + tx.fee {
                        eprintln!("[node] Rejecting swap: insufficient XRGE balance ({:.4} < {:.4})", xrge_bal, amount_in as f64 + tx.fee);
                        return Ok(());
                    }
                } else {
                    if xrge_bal < tx.fee {
                        eprintln!("[node] Rejecting swap: insufficient XRGE for fee ({:.4} < {:.4})", xrge_bal, tx.fee);
                        return Ok(());
                    }
                    let token_key = (tx.from_pub_key.clone(), token_in.clone());
                    let token_bal = *token_balances.get(&token_key).unwrap_or(&0.0);
                    if token_bal < amount_in as f64 {
                        eprintln!("[node] Rejecting swap: insufficient {} balance ({:.4} < {})", token_in, token_bal, amount_in);
                        return Ok(());
                    }
                }
                
                // Deduct fee
                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
                
                // Get swap path (direct or multi-hop)
                let path = tx.payload.swap_path.clone().unwrap_or_else(|| vec![token_in.clone(), token_out.clone()]);
                
                // Execute swap through the path
                let mut current_amount = amount_in;
                let mut swap_ok = true;
                for i in 0..(path.len() - 1) {
                    let t_in = &path[i];
                    let t_out = &path[i + 1];
                    
                    let pool_id = LiquidityPool::make_pool_id(t_in, t_out);
                    let mut pool = match self.pool_store.get_pool(&pool_id)? {
                        Some(p) => p,
                        None => {
                            eprintln!("[node] Warning: Pool {} not found, skipping swap", pool_id);
                            swap_ok = false;
                            break;
                        }
                    };
                    
                    let (reserve_in, reserve_out) = match pool.get_reserves(t_in) {
                        Some(r) => r,
                        None => {
                            eprintln!("[node] Warning: Invalid token for pool {}, skipping swap", pool_id);
                            swap_ok = false;
                            break;
                        }
                    };
                    
                    let amount_out = match amm::get_amount_out(current_amount, reserve_in, reserve_out) {
                        Some(a) => a,
                        None => {
                            eprintln!("[node] Warning: Insufficient liquidity in {}, skipping swap", pool_id);
                            swap_ok = false;
                            break;
                        }
                    };
                    
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
                
                if !swap_ok {
                    return Ok(());
                }
                
                // Enforce slippage protection
                if current_amount < min_amount_out {
                    eprintln!("[node] Rejecting swap: slippage exceeded (got {} < min {})", current_amount, min_amount_out);
                    return Ok(());
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
        // Pre-validate create_token at consensus level (has access to metadata store)
        if tx.tx_type == "create_token" {
            if let Some(ref sym) = tx.payload.token_symbol {
                let sym_upper = sym.trim().to_uppercase();
                if let Ok(Some(_)) = self.token_metadata_store.get_metadata(&sym_upper) {
                    eprintln!("[node] Rejecting create_token: symbol '{}' already exists", sym_upper);
                    return Ok(()); // silently drop duplicate (already mined)
                }
            }
        }
        let mut balances = self.balances.lock().map_err(|_| "balance lock")?;
        let mut token_balances = self.token_balances.lock().map_err(|_| "token balance lock")?;
        let mut burned_tokens = self.burned_tokens.lock().map_err(|_| "burned tokens lock")?;
        let node_pub_key = self.keys.lock().map(|k| k.public_key_hex.clone()).unwrap_or_default();
        let block_height = self.store.get_tip().map(|t| t.height).unwrap_or(0);
        Self::apply_balance_tx_inner(&mut balances, &mut token_balances, &mut burned_tokens, tx, Some(&self.validator_store), &node_pub_key, &self.unbonding_queue, block_height, &self.shielded_supply);
        Ok(())
    }

    fn rebuild_balances(&self) -> Result<(), String> {
        let blocks = self.store.get_all_blocks()?;
        let mut balances = self.balances.lock().map_err(|_| "balance lock")?;
        let mut token_balances = self.token_balances.lock().map_err(|_| "token balance lock")?;
        let mut lp_balances = self.lp_balances.lock().map_err(|_| "lp balance lock")?;
        let mut burned_tokens = self.burned_tokens.lock().map_err(|_| "burned tokens lock")?;
        balances.clear();
        token_balances.clear();
        lp_balances.clear();
        burned_tokens.clear();
        // Reset shielded supply — it will be rebuilt from chain history
        if let Ok(mut sp) = self.shielded_supply.lock() {
            *sp = 0.0;
        }
        
        let mut skipped_txs = 0u64;

        for block in &blocks {
            let mut actual_fees_collected: f64 = 0.0;

            for tx in &block.txs {
                let sum_before: f64 = balances.values().sum();

                Self::apply_balance_tx_inner(&mut balances, &mut token_balances, &mut burned_tokens, tx, Some(&self.validator_store), "_rebuild_", &self.unbonding_queue, block.header.height, &self.shielded_supply);
                
                Self::apply_amm_balance_effects(
                    &mut balances,
                    &mut token_balances,
                    &mut lp_balances,
                    tx,
                    &self.pool_store,
                );

                Self::apply_nft_balance_effects(&mut balances, tx);

                // Apply shielded state effects (commitment/nullifier stores)
                self.apply_shielded_state_effects(tx);
                self.apply_web3_state_effects(tx, block.header.height);

                let sum_after: f64 = balances.values().sum();
                let fee_delta = sum_before - sum_after;
                if fee_delta > 0.0 {
                    actual_fees_collected += fee_delta;
                } else if fee_delta == 0.0 && tx.fee > 0.0 {
                    skipped_txs += 1;
                }
            }
            
            if actual_fees_collected > 0.0 {
                let stakes = self.get_validator_stakes_at_height(block.header.height)?;
                let base_fee = self.get_base_fee();
                Self::distribute_fees(
                    &mut balances,
                    actual_fees_collected,
                    &block.header.proposer_pub_key,
                    &stakes,
                    base_fee,
                    block.txs.len(),
                    &self.total_fees_burned,
                );
            }
        }

        if skipped_txs > 0 {
            eprintln!("[rebuild] Skipped {} invalid transactions during balance rebuild", skipped_txs);
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
                    // Balance guard
                    let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                    let mut xrge_needed = tx.fee;
                    if token_a == "XRGE" { xrge_needed += amount_a as f64; }
                    if token_b == "XRGE" { xrge_needed += amount_b as f64; }
                    if xrge_bal < xrge_needed {
                        eprintln!("[rebuild] Skipping create_pool: insufficient XRGE ({:.4} < {:.4})", xrge_bal, xrge_needed);
                        return;
                    }
                    if token_a != "XRGE" {
                        let key = (tx.from_pub_key.clone(), token_a.clone());
                        let bal = *token_balances.get(&key).unwrap_or(&0.0);
                        if bal < amount_a as f64 { return; }
                    }
                    if token_b != "XRGE" {
                        let key = (tx.from_pub_key.clone(), token_b.clone());
                        let bal = *token_balances.get(&key).unwrap_or(&0.0);
                        if bal < amount_b as f64 { return; }
                    }

                    *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
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
                    
                    let pool_id = LiquidityPool::make_pool_id(token_a, token_b);
                    if let Ok(Some(_pool)) = pool_store.get_pool(&pool_id) {
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
                    if let Ok(Some(pool)) = pool_store.get_pool(pool_id) {
                        // Balance guard
                        let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                        let mut xrge_needed = tx.fee;
                        if pool.token_a == "XRGE" { xrge_needed += amount_a as f64; }
                        if pool.token_b == "XRGE" { xrge_needed += amount_b as f64; }
                        if xrge_bal < xrge_needed { return; }
                        if pool.token_a != "XRGE" {
                            let key = (tx.from_pub_key.clone(), pool.token_a.clone());
                            if *token_balances.get(&key).unwrap_or(&0.0) < amount_a as f64 { return; }
                        }
                        if pool.token_b != "XRGE" {
                            let key = (tx.from_pub_key.clone(), pool.token_b.clone());
                            if *token_balances.get(&key).unwrap_or(&0.0) < amount_b as f64 { return; }
                        }

                        *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
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
                    // Balance guard: check fee + LP tokens
                    let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                    if xrge_bal < tx.fee { return; }
                    let lp_key = (tx.from_pub_key.clone(), pool_id.clone());
                    let lp_bal = *lp_balances.get(&lp_key).unwrap_or(&0.0);
                    if lp_bal < lp_amount as f64 { return; }

                    *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
                    
                    if let Ok(Some(pool)) = pool_store.get_pool(pool_id) {
                        *lp_balances.entry(lp_key).or_insert(0.0) -= lp_amount as f64;
                        
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
                    // Balance guard
                    let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                    if token_in == "XRGE" {
                        if xrge_bal < amount_in as f64 + tx.fee {
                            eprintln!("[rebuild] Skipping swap: insufficient XRGE ({:.4} < {:.4})", xrge_bal, amount_in as f64 + tx.fee);
                            return;
                        }
                    } else {
                        if xrge_bal < tx.fee { return; }
                        let key = (tx.from_pub_key.clone(), token_in.clone());
                        let tok_bal = *token_balances.get(&key).unwrap_or(&0.0);
                        if tok_bal < amount_in as f64 {
                            eprintln!("[rebuild] Skipping swap: insufficient {} ({:.4} < {})", token_in, tok_bal, amount_in);
                            return;
                        }
                    }

                    *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
                    
                    let path = tx.payload.swap_path.clone().unwrap_or_else(|| vec![token_in.clone(), token_out.clone()]);
                    
                    if token_in == "XRGE" {
                        *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= amount_in as f64;
                    } else {
                        let key = (tx.from_pub_key.clone(), token_in.clone());
                        *token_balances.entry(key).or_insert(0.0) -= amount_in as f64;
                    }
                    
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
    
    /// Deduct NFT fees during balance rebuild (NFT state is rebuilt separately in rebuild_nft_state)
    fn apply_nft_balance_effects(
        balances: &mut HashMap<String, f64>,
        tx: &TxV1,
    ) {
        match tx.tx_type.as_str() {
            "nft_create_collection" | "nft_mint" | "nft_batch_mint"
            | "nft_burn" | "nft_lock" | "nft_freeze_collection" => {
                let bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                if bal < tx.fee { return; }
                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
            }
            "nft_transfer" => {
                let bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                if bal < tx.fee { return; }
                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
            }
            _ => {}
        }
    }

    /// Apply shielded transaction state effects (commitment/nullifier stores).
    /// Called during block processing and balance rebuild.
    fn apply_shielded_state_effects(&self, tx: &TxV1) {
        match tx.tx_type.as_str() {
            "shield" => {
                // Insert the new commitment into the commitment store
                if let Some(commitment) = tx.payload.shielded_commitment.as_ref() {
                    if let Err(e) = self.commitment_store.insert(commitment) {
                        eprintln!("[node] Failed to insert shield commitment: {}", e);
                    }
                }
            }
            "shielded_transfer" => {
                // 1. Mark nullifiers as spent (double-spend prevention)
                if let Some(nullifiers) = tx.payload.shielded_nullifiers.as_ref() {
                    for nullifier in nullifiers {
                        if let Err(e) = self.nullifier_store.mark_spent(nullifier) {
                            eprintln!("[node] Shielded transfer nullifier error: {}", e);
                            return;
                        }
                    }
                }
                // 2. Insert new output commitments
                if let Some(commitments) = tx.payload.shielded_output_commitments.as_ref() {
                    for commitment in commitments {
                        if let Err(e) = self.commitment_store.insert(commitment) {
                            eprintln!("[node] Failed to insert output commitment: {}", e);
                        }
                    }
                }
            }
            "unshield" => {
                // Mark the spent note's nullifier
                if let Some(nullifiers) = tx.payload.shielded_nullifiers.as_ref() {
                    for nullifier in nullifiers {
                        if let Err(e) = self.nullifier_store.mark_spent(nullifier) {
                            eprintln!("[node] Unshield nullifier error: {}", e);
                            return;
                        }
                    }
                }
            }
            _ => {}
        }
    }

    /// Apply Web3 feature state effects (lock store, staking, governance, allowances).
    /// Called during block processing alongside balance and shielded effects.
    fn apply_web3_state_effects(&self, tx: &TxV1, block_height: u64) {
        match tx.tx_type.as_str() {
            "token_lock" => {
                if let (Some(lock_until), Some(lock_id)) = (
                    tx.payload.lock_until_height,
                    tx.payload.lock_id.as_ref(),
                ) {
                    let amount = tx.payload.amount.unwrap_or(0);
                    let token_symbol = tx.payload.token_symbol.clone().unwrap_or_else(|| "XRGE".to_string());
                    let lock = TokenLock {
                        lock_id: lock_id.clone(),
                        owner: tx.from_pub_key.clone(),
                        token_symbol,
                        amount,
                        lock_until_height: lock_until,
                        created_at_height: block_height,
                    };
                    if let Err(e) = self.lock_store.create_lock(&lock) {
                        eprintln!("[node] Failed to create lock: {}", e);
                    }
                }
            }
            "token_unlock" => {
                if let Some(lock_id) = tx.payload.lock_id.as_ref() {
                    // Verify lock ownership and height before deleting
                    match self.lock_store.get_lock(lock_id) {
                        Ok(Some(lock)) => {
                            if lock.owner != tx.from_pub_key {
                                eprintln!("[node] Rejecting unlock: not lock owner");
                                return;
                            }
                            if block_height < lock.lock_until_height {
                                eprintln!("[node] Rejecting unlock: lock not expired (current {} < {})", block_height, lock.lock_until_height);
                                return;
                            }
                            if let Err(e) = self.lock_store.delete_lock(lock_id) {
                                eprintln!("[node] Failed to delete lock: {}", e);
                            }
                        }
                        Ok(None) => {
                            eprintln!("[node] Lock {} not found", lock_id);
                        }
                        Err(e) => {
                            eprintln!("[node] Failed to get lock: {}", e);
                        }
                    }
                }
            }
            "create_staking_pool" => {
                if let Some(token_symbol) = tx.payload.token_symbol.as_ref() {
                    let pool_id = tx.payload.staking_pool_id.clone()
                        .unwrap_or_else(|| format!("{}:{}", token_symbol, &tx.from_pub_key[..16]));
                    let reward_rate = tx.payload.staking_reward_rate.unwrap_or(500); // default 5%
                    let pool = StakingPool {
                        pool_id,
                        token_symbol: token_symbol.clone(),
                        creator: tx.from_pub_key.clone(),
                        reward_rate_bps: reward_rate,
                        total_staked: 0,
                        created_at_height: block_height,
                    };
                    if let Err(e) = self.token_stake_store.create_pool(&pool) {
                        eprintln!("[node] Failed to create staking pool: {}", e);
                    }
                }
            }
            "token_stake" => {
                if let Some(pool_id) = tx.payload.staking_pool_id.as_ref() {
                    let amount = tx.payload.amount.unwrap_or(0);
                    // Update or create stake
                    let existing = self.token_stake_store.get_stake(&tx.from_pub_key, pool_id)
                        .unwrap_or(None);
                    let stake = TokenStake {
                        staker: tx.from_pub_key.clone(),
                        pool_id: pool_id.clone(),
                        amount: existing.as_ref().map(|s| s.amount).unwrap_or(0) + amount,
                        staked_at_height: existing.as_ref().map(|s| s.staked_at_height).unwrap_or(block_height),
                        last_claim_height: existing.as_ref().map(|s| s.last_claim_height).unwrap_or(block_height),
                    };
                    if let Err(e) = self.token_stake_store.create_stake(&stake) {
                        eprintln!("[node] Failed to create stake: {}", e);
                    }
                    // Update pool total
                    if let Ok(Some(mut pool)) = self.token_stake_store.get_pool(pool_id) {
                        pool.total_staked += amount;
                        let _ = self.token_stake_store.save_pool(&pool);
                    }
                }
            }
            "token_unstake" => {
                if let Some(pool_id) = tx.payload.staking_pool_id.as_ref() {
                    let amount = tx.payload.amount.unwrap_or(0);
                    if let Ok(Some(stake)) = self.token_stake_store.get_stake(&tx.from_pub_key, pool_id) {
                        if amount >= stake.amount {
                            let _ = self.token_stake_store.delete_stake(&tx.from_pub_key, pool_id);
                        } else {
                            let updated = TokenStake {
                                amount: stake.amount - amount,
                                ..stake
                            };
                            let _ = self.token_stake_store.create_stake(&updated);
                        }
                        // Update pool total
                        if let Ok(Some(mut pool)) = self.token_stake_store.get_pool(pool_id) {
                            pool.total_staked = pool.total_staked.saturating_sub(amount);
                            let _ = self.token_stake_store.save_pool(&pool);
                        }
                    }
                }
            }
            "create_proposal" => {
                if let (Some(token_symbol), Some(title), Some(description)) = (
                    tx.payload.token_symbol.as_ref(),
                    tx.payload.proposal_title.as_ref(),
                    tx.payload.proposal_description.as_ref(),
                ) {
                    let proposal_id = tx.payload.proposal_id.clone()
                        .unwrap_or_else(|| format!("prop-{}-{}", block_height, &tx.from_pub_key[..8]));
                    let end_height = tx.payload.proposal_end_height.unwrap_or(block_height + 1000);
                    let proposal_type = tx.payload.proposal_type.clone().unwrap_or_else(|| "text".into());
                    let quorum = tx.payload.proposal_quorum.unwrap_or(1000);
                    let timelock_blocks = tx.payload.proposal_timelock_blocks.unwrap_or(100);
                    let proposal = Proposal {
                        proposal_id,
                        token_symbol: token_symbol.clone(),
                        creator: tx.from_pub_key.clone(),
                        title: title.clone(),
                        description: description.clone(),
                        end_height,
                        created_at_height: block_height,
                        yes_votes: 0,
                        no_votes: 0,
                        abstain_votes: 0,
                        executed: false,
                        proposal_type,
                        action_payload: tx.payload.proposal_action_payload.clone(),
                        quorum,
                        pass_threshold_pct: 50,
                        timelock_blocks,
                        executable_after: end_height + timelock_blocks,
                    };
                    if let Err(e) = self.governance_store.save_proposal(&proposal) {
                        eprintln!("[node] Failed to create proposal: {}", e);
                    } else {
                        eprintln!("[node] Created governance proposal {} (type={}, quorum={}, timelock={})",
                            proposal.proposal_id, proposal.proposal_type, quorum, timelock_blocks);
                    }
                }
            }
            "cast_vote" => {
                if let (Some(proposal_id), Some(vote_option)) = (
                    tx.payload.proposal_id.as_ref(),
                    tx.payload.vote_option.as_ref(),
                ) {
                    // Check proposal exists and is still active
                    if let Ok(Some(proposal)) = self.governance_store.get_proposal(proposal_id) {
                        if block_height >= proposal.end_height {
                            eprintln!("[node] Rejecting vote: voting period ended for {}", proposal_id);
                            return;
                        }
                    }
                    // Check voter hasn't already voted
                    if let Ok(Some(_)) = self.governance_store.get_vote(&tx.from_pub_key, proposal_id) {
                        eprintln!("[node] Rejecting vote: already voted on {}", proposal_id);
                        return;
                    }
                    // Voting weight = own balance + delegated balances
                    let own_weight = if let Ok(Some(ref proposal)) = self.governance_store.get_proposal(proposal_id) {
                        if proposal.token_symbol.to_uppercase() == "XRGE" {
                            if let Ok(bals) = self.balances.lock() {
                                *bals.get(&tx.from_pub_key).unwrap_or(&0.0) as u64
                            } else { 0 }
                        } else {
                            let key = (tx.from_pub_key.clone(), proposal.token_symbol.to_uppercase());
                            if let Ok(tbals) = self.token_balances.lock() {
                                *tbals.get(&key).unwrap_or(&0.0) as u64
                            } else { 0 }
                        }
                    } else {
                        0
                    };
                    // Add delegated weight from all delegators
                    let delegated_weight = if let Ok(delegators) = self.governance_store.get_delegators_for(&tx.from_pub_key) {
                        let mut dw: u64 = 0;
                        if let Ok(Some(ref proposal)) = self.governance_store.get_proposal(proposal_id) {
                            for delegator in &delegators {
                                // Skip if delegator already voted directly
                                if let Ok(Some(_)) = self.governance_store.get_vote(delegator, proposal_id) {
                                    continue;
                                }
                                if proposal.token_symbol.to_uppercase() == "XRGE" {
                                    if let Ok(bals) = self.balances.lock() {
                                        dw += *bals.get(delegator).unwrap_or(&0.0) as u64;
                                    }
                                } else {
                                    let key = (delegator.clone(), proposal.token_symbol.to_uppercase());
                                    if let Ok(tbals) = self.token_balances.lock() {
                                        dw += *tbals.get(&key).unwrap_or(&0.0) as u64;
                                    }
                                }
                            }
                        }
                        dw
                    } else { 0 };
                    let weight = own_weight + delegated_weight;
                    if weight == 0 {
                        eprintln!("[node] Rejecting vote: zero balance (no voting power)");
                        return;
                    }
                    let vote = Vote {
                        voter: tx.from_pub_key.clone(),
                        proposal_id: proposal_id.clone(),
                        option: vote_option.clone(),
                        weight,
                    };
                    if let Err(e) = self.governance_store.save_vote(&vote) {
                        eprintln!("[node] Failed to save vote: {}", e);
                    }
                    // Update proposal tallies
                    if let Ok(Some(mut proposal)) = self.governance_store.get_proposal(proposal_id) {
                        match vote_option.as_str() {
                            "yes" => proposal.yes_votes += weight,
                            "no" => proposal.no_votes += weight,
                            "abstain" => proposal.abstain_votes += weight,
                            _ => {}
                        }
                        let _ = self.governance_store.save_proposal(&proposal);
                    }
                }
            }
            "execute_proposal" => {
                if let Some(proposal_id) = tx.payload.proposal_id.as_ref() {
                    if let Ok(Some(mut proposal)) = self.governance_store.get_proposal(proposal_id) {
                        if proposal.executed {
                            eprintln!("[node] Rejecting execute: already executed");
                            return;
                        }
                        // Check voting has ended
                        if block_height < proposal.end_height {
                            eprintln!("[node] Rejecting execute: voting not ended");
                            return;
                        }
                        // Check status (quorum + threshold + timelock)
                        let status = proposal.status(block_height);
                        match status {
                            "failed" => {
                                eprintln!("[node] Rejecting execute: proposal failed (quorum or threshold not met)");
                                return;
                            }
                            "queued" => {
                                eprintln!("[node] Rejecting execute: in timelock period (executable at height {})",
                                    proposal.executable_after);
                                return;
                            }
                            "passed" => {
                                // Execute the proposal action
                                match proposal.proposal_type.as_str() {
                                    "treasury_spend" => {
                                        // Transfer from treasury to recipient
                                        if let Some(ref payload) = proposal.action_payload {
                                            if let (Some(to), Some(amount)) = (
                                                payload.get("recipient").and_then(|v| v.as_str()),
                                                payload.get("amount").and_then(|v| v.as_u64()),
                                            ) {
                                                if let Ok(mut bals) = self.balances.lock() {
                                                    let treasury_key = "__treasury__".to_string();
                                                    let treasury_bal = *bals.get(&treasury_key).unwrap_or(&0.0);
                                                    if treasury_bal >= amount as f64 {
                                                        *bals.entry(treasury_key).or_insert(0.0) -= amount as f64;
                                                        *bals.entry(to.to_string()).or_insert(0.0) += amount as f64;
                                                        eprintln!("[node] Treasury spend: {} XRGE to {}", amount, &to[..16.min(to.len())]);
                                                    } else {
                                                        eprintln!("[node] Treasury spend failed: insufficient funds");
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    "param_change" => {
                                        eprintln!("[node] Param change proposal executed: {}", proposal_id);
                                        // Future: apply parameter changes from action_payload
                                    }
                                    _ => {
                                        // "text" proposals — no on-chain action needed
                                        eprintln!("[node] Text proposal executed: {}", proposal_id);
                                    }
                                }
                                proposal.executed = true;
                                let _ = self.governance_store.save_proposal(&proposal);
                                eprintln!("[node] Proposal {} executed successfully", proposal_id);
                            }
                            _ => {
                                eprintln!("[node] Rejecting execute: unexpected status {}", status);
                                return;
                            }
                        }
                    }
                }
            }
            "delegate" => {
                if let Some(delegate_to) = tx.payload.delegate_to.as_ref() {
                    // Can't delegate to yourself
                    if delegate_to == &tx.from_pub_key {
                        eprintln!("[node] Rejecting delegation: can't delegate to self");
                        return;
                    }
                    if let Err(e) = self.governance_store.set_delegation(&tx.from_pub_key, delegate_to) {
                        eprintln!("[node] Failed to set delegation: {}", e);
                    } else {
                        eprintln!("[node] {} delegated voting power to {}", &tx.from_pub_key[..8], &delegate_to[..8.min(delegate_to.len())]);
                    }
                }
            }
            "undelegate" => {
                if let Err(e) = self.governance_store.remove_delegation(&tx.from_pub_key) {
                    eprintln!("[node] Failed to remove delegation: {}", e);
                } else {
                    eprintln!("[node] {} removed voting delegation", &tx.from_pub_key[..8]);
                }
            }
            "token_approve" => {
                if let (Some(spender), Some(token_symbol)) = (
                    tx.payload.spender_pub_key.as_ref(),
                    tx.payload.token_symbol.as_ref(),
                ) {
                    let amount = tx.payload.allowance_amount.unwrap_or(0);
                    let allowance = Allowance {
                        owner: tx.from_pub_key.clone(),
                        spender: spender.clone(),
                        token_symbol: token_symbol.clone(),
                        amount,
                    };
                    if let Err(e) = self.allowance_store.set_allowance(&allowance) {
                        eprintln!("[node] Failed to set allowance: {}", e);
                    }
                }
            }
            "token_transfer_from" => {
                // Deduct from allowance
                if let (Some(owner), Some(token_symbol)) = (
                    tx.payload.owner_pub_key.as_ref(),
                    tx.payload.token_symbol.as_ref(),
                ) {
                    let amount = tx.payload.amount.unwrap_or(0);
                    if let Ok(Some(mut allowance)) = self.allowance_store.get_allowance(owner, &tx.from_pub_key, token_symbol) {
                        if allowance.amount < amount {
                            eprintln!("[node] Rejecting transfer_from: insufficient allowance");
                            return;
                        }
                        allowance.amount -= amount;
                        let _ = self.allowance_store.set_allowance(&allowance);
                    } else {
                        eprintln!("[node] Rejecting transfer_from: no allowance set");
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

    /// Rebuild pool state from chain history.
    /// Clears pool_store and replays all pool-related transactions from genesis
    /// to reconstruct correct pool reserves, LP supply, and pool existence.
    fn rebuild_pool_state(&self) -> Result<(), String> {
        let blocks = self.store.get_all_blocks()?;
        if blocks.is_empty() {
            return Ok(());
        }

        self.pool_store.clear_all()?;

        let mut pool_count = 0u32;
        for block in &blocks {
            for tx in &block.txs {
                match tx.tx_type.as_str() {
                    "create_pool" => {
                        if let (Some(token_a), Some(token_b), Some(amount_a), Some(amount_b)) = (
                            tx.payload.token_a_symbol.as_ref(),
                            tx.payload.token_b_symbol.as_ref(),
                            tx.payload.amount_a,
                            tx.payload.amount_b,
                        ) {
                            let pool = LiquidityPool::new(
                                token_a.clone(),
                                token_b.clone(),
                                amount_a,
                                amount_b,
                                tx.from_pub_key.clone(),
                                block.header.time,
                            );
                            self.pool_store.save_pool(&pool)?;
                            pool_count += 1;
                        }
                    }
                    "add_liquidity" => {
                        if let (Some(pool_id), Some(amount_a), Some(amount_b)) = (
                            tx.payload.pool_id.as_ref(),
                            tx.payload.amount_a,
                            tx.payload.amount_b,
                        ) {
                            if let Some(mut pool) = self.pool_store.get_pool(pool_id)? {
                                let lp_amount = amm::calculate_lp_mint(
                                    amount_a, amount_b,
                                    pool.reserve_a, pool.reserve_b,
                                    pool.total_lp_supply,
                                ).unwrap_or(0);
                                pool.reserve_a += amount_a;
                                pool.reserve_b += amount_b;
                                pool.total_lp_supply += lp_amount;
                                self.pool_store.save_pool(&pool)?;
                            }
                        }
                    }
                    "remove_liquidity" => {
                        if let (Some(pool_id), Some(lp_amount)) = (
                            tx.payload.pool_id.as_ref(),
                            tx.payload.lp_amount,
                        ) {
                            if let Some(mut pool) = self.pool_store.get_pool(pool_id)? {
                                if let Some((amount_a, amount_b)) = amm::calculate_remove_liquidity(
                                    lp_amount, pool.reserve_a, pool.reserve_b, pool.total_lp_supply,
                                ) {
                                    pool.reserve_a = pool.reserve_a.saturating_sub(amount_a);
                                    pool.reserve_b = pool.reserve_b.saturating_sub(amount_b);
                                    pool.total_lp_supply = pool.total_lp_supply.saturating_sub(lp_amount);
                                    self.pool_store.save_pool(&pool)?;
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
                            let path = tx.payload.swap_path.clone()
                                .unwrap_or_else(|| vec![token_in.clone(), token_out.clone()]);

                            let mut current_amount = amount_in;
                            for i in 0..(path.len() - 1) {
                                let t_in = &path[i];
                                let t_out = &path[i + 1];
                                let pool_id = LiquidityPool::make_pool_id(t_in, t_out);

                                if let Some(mut pool) = self.pool_store.get_pool(&pool_id)? {
                                    if let Some((reserve_in, reserve_out)) = pool.get_reserves(t_in) {
                                        if let Some(amount_out) = amm::get_amount_out(current_amount, reserve_in, reserve_out) {
                                            if pool.token_a == *t_in {
                                                pool.reserve_a += current_amount;
                                                pool.reserve_b = pool.reserve_b.saturating_sub(amount_out);
                                            } else {
                                                pool.reserve_b += current_amount;
                                                pool.reserve_a = pool.reserve_a.saturating_sub(amount_out);
                                            }
                                            self.pool_store.save_pool(&pool)?;
                                            current_amount = amount_out;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        if pool_count > 0 {
            eprintln!("[node] Rebuilt {} pools from chain history", pool_count);
        }
        Ok(())
    }
    
    /// Distribute block fees: 25% to proposer, 75% split among validators by stake
    fn distribute_fees(
        balances: &mut HashMap<String, f64>,
        total_fees: f64,
        proposer_pub_key: &str,
        validator_stakes: &BTreeMap<String, u128>,
        base_fee_per_tx: f64,
        tx_count: usize,
        total_fees_burned: &Arc<Mutex<f64>>,
    ) {
        // EIP-1559: burn base_fee portion, distribute only the tip
        let total_base_fees = base_fee_per_tx * tx_count as f64;
        let burned = total_base_fees.min(total_fees); // Can't burn more than collected
        let tip_pool = total_fees - burned;

        // Track burned fees
        if burned > 0.0 {
            if let Ok(mut b) = total_fees_burned.lock() {
                *b += burned;
            }
        }

        if tip_pool <= 0.0 {
            return; // All fees burned, nothing to distribute
        }

        // Proposer gets 25% of tip
        let proposer_share = tip_pool * Self::PROPOSER_FEE_SHARE;
        *balances.entry(proposer_pub_key.to_string()).or_insert(0.0) += proposer_share;
        
        // Remaining 75% split among all validators by stake weight
        let validator_pool = tip_pool * Self::VALIDATOR_FEE_SHARE;
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

        // Treasury gets 10% of tip
        let treasury_share = tip_pool * Self::TREASURY_FEE_SHARE;
        *balances.entry("__treasury__".to_string()).or_insert(0.0) += treasury_share;
    }
    
    fn apply_balance_tx_inner(
        balances: &mut HashMap<String, f64>,
        token_balances: &mut HashMap<TokenBalanceKey, f64>,
        burned_tokens: &mut HashMap<String, f64>,
        tx: &TxV1,
        validator_store: Option<&quantum_vault_storage::validator_store::ValidatorStore>,
        node_pub_key: &str,
        unbonding_queue: &Arc<Mutex<Vec<UnbondingEntry>>>,
        block_height: u64,
        shielded_supply: &Arc<Mutex<f64>>,
    ) {
        match tx.tx_type.as_str() {
            "transfer" => {
                if let Some(to_pub_key) = tx.payload.to_pub_key_hex.as_ref() {
                    let amount = tx.payload.amount.unwrap_or(0) as f64;
                    let is_burn = to_pub_key == BURN_ADDRESS;
                    let is_faucet = tx.payload.faucet == Some(true)
                        && (!node_pub_key.is_empty() && tx.from_pub_key == node_pub_key
                            || node_pub_key == "_rebuild_");

                    if is_faucet {
                        // Faucet mint: credit recipient without debiting sender
                        *balances.entry(to_pub_key.clone()).or_insert(0.0) += amount;
                        return;
                    }

                    if let Some(token_symbol) = tx.payload.token_symbol.as_ref() {
                        let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                        if xrge_bal < tx.fee {
                            eprintln!("[node] Rejecting transfer: insufficient XRGE for fee ({:.4} < {:.4})", xrge_bal, tx.fee);
                            return;
                        }
                        let sender_key = (tx.from_pub_key.clone(), token_symbol.clone());
                        let token_bal = *token_balances.get(&sender_key).unwrap_or(&0.0);
                        if token_bal < amount {
                            eprintln!("[node] Rejecting transfer: insufficient {} ({:.4} < {:.4})", token_symbol, token_bal, amount);
                            return;
                        }

                        *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
                        *token_balances.entry(sender_key).or_insert(0.0) -= amount;
                        
                        if is_burn {
                            *burned_tokens.entry(token_symbol.clone()).or_insert(0.0) += amount;
                        } else {
                            let recipient_key = (to_pub_key.clone(), token_symbol.clone());
                            *token_balances.entry(recipient_key).or_insert(0.0) += amount;
                        }
                    } else {
                        let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                        if xrge_bal < amount + tx.fee {
                            eprintln!("[node] Rejecting transfer: insufficient XRGE ({:.4} < {:.4})", xrge_bal, amount + tx.fee);
                            return;
                        }

                        *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= amount + tx.fee;
                        
                        if is_burn {
                            *burned_tokens.entry("XRGE".to_string()).or_insert(0.0) += amount;
                        } else {
                            *balances.entry(to_pub_key.clone()).or_insert(0.0) += amount;
                        }
                    }
                }
            }
            "stake" => {
                let amount = tx.payload.amount.unwrap_or(0) as f64;
                let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                if xrge_bal < amount + tx.fee {
                    eprintln!("[node] Rejecting stake: insufficient XRGE ({:.4} < {:.4})", xrge_bal, amount + tx.fee);
                    return;
                }
                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= amount + tx.fee;
            }
            "unstake" => {
                let amount = tx.payload.amount.unwrap_or(0) as f64;
                // Verify staked balance before queueing
                if let Some(vs) = validator_store {
                    let staked = vs.get_validator(&tx.from_pub_key)
                        .unwrap_or(None)
                        .map(|v| v.stake)
                        .unwrap_or(0);
                    if (amount as u128) > staked {
                        eprintln!("[node] Rejecting unstake: staked {} but requested {}", staked, amount);
                        return;
                    }
                }
                let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                if xrge_bal < tx.fee {
                    eprintln!("[node] Rejecting unstake: insufficient XRGE for fee ({:.4} < {:.4})", xrge_bal, tx.fee);
                    return;
                }
                // Deduct fee now, queue the unbonding (funds released after UNBONDING_BLOCKS)
                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
                if let Ok(mut queue) = unbonding_queue.lock() {
                    let release_at = block_height + UNBONDING_BLOCKS;
                    queue.push(UnbondingEntry {
                        delegator: tx.from_pub_key.clone(),
                        amount,
                        release_height: release_at,
                    });
                    eprintln!("[node] Unstake queued: {:.4} XRGE, releases at block {}",
                        amount, release_at);
                }
            }
            "create_token" => {
                const RESERVED: &[&str] = &["XRGE", "QETH", "QUSDC", "ETH", "USDC"];
                if let Some(ref sym) = tx.payload.token_symbol {
                    let sym_trimmed = sym.trim();
                    let sym_upper = sym_trimmed.to_uppercase();

                    // Reserved symbol check
                    if RESERVED.contains(&sym_upper.as_str()) {
                        eprintln!("[node] Rejecting create_token: reserved symbol '{}'", sym);
                        return;
                    }

                    // Symbol length: 1-10 chars
                    let char_count = sym_trimmed.chars().count();
                    if char_count == 0 || char_count > 10 {
                        eprintln!("[node] Rejecting create_token: symbol must be 1-10 chars (got {})", char_count);
                        return;
                    }

                    // No whitespace in symbol
                    if sym_trimmed.contains(char::is_whitespace) {
                        eprintln!("[node] Rejecting create_token: symbol contains whitespace");
                        return;
                    }

                    // Name length: 1-64 chars
                    if let Some(ref name) = tx.payload.token_name {
                        let name_len = name.trim().chars().count();
                        if name_len == 0 || name_len > 64 {
                            eprintln!("[node] Rejecting create_token: name must be 1-64 chars (got {})", name_len);
                            return;
                        }
                    }
                } else {
                    eprintln!("[node] Rejecting create_token: missing symbol");
                    return;
                }
                let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                if xrge_bal < tx.fee {
                    eprintln!("[node] Rejecting create_token: insufficient XRGE ({:.4} < {:.4})", xrge_bal, tx.fee);
                    return;
                }
                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
                
                if let Some(token_symbol) = tx.payload.token_symbol.as_ref() {
                    let total_supply = tx.payload.token_total_supply.unwrap_or(0) as f64;
                    let creator_key = (tx.from_pub_key.clone(), token_symbol.trim().to_uppercase());
                    *token_balances.entry(creator_key).or_insert(0.0) += total_supply;
                }
            }
            "mint_tokens" => {
                // Creator mints additional supply for a mintable token
                // Note: creator authority + mintable flag are validated at API layer
                let sym = match tx.payload.token_symbol.as_ref() {
                    Some(s) => s.trim().to_uppercase(),
                    None => { eprintln!("[node] Rejecting mint_tokens: missing symbol"); return; }
                };
                let amount = tx.payload.token_total_supply.unwrap_or(0) as f64;
                if amount <= 0.0 {
                    eprintln!("[node] Rejecting mint_tokens: amount must be > 0");
                    return;
                }
                // Fee
                let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                if xrge_bal < tx.fee {
                    eprintln!("[node] Rejecting mint_tokens: insufficient XRGE for fee");
                    return;
                }
                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
                // Credit minted tokens to creator
                let creator_key = (tx.from_pub_key.clone(), sym);
                *token_balances.entry(creator_key).or_insert(0.0) += amount;
            }
            "bridge_mint" => {
                // Only the node operator key can issue bridge mints (skip check during rebuild)
                if node_pub_key != "_rebuild_" && !node_pub_key.is_empty() && tx.from_pub_key != node_pub_key {
                    eprintln!("[node] Rejecting bridge_mint: unauthorized sender (not node operator)");
                    return;
                }
                if let (Some(to_pub_key), Some(token_symbol)) = (
                    tx.payload.to_pub_key_hex.as_ref(),
                    tx.payload.token_symbol.as_ref(),
                ) {
                    let amount = tx.payload.amount.unwrap_or(0) as f64;
                    if amount > 0.0 {
                        if token_symbol.to_uppercase() == "XRGE" {
                            *balances.entry(to_pub_key.clone()).or_insert(0.0) += amount;
                        } else {
                            let recipient_key = (to_pub_key.clone(), token_symbol.clone());
                            *token_balances.entry(recipient_key).or_insert(0.0) += amount;
                        }
                    }
                }
            }
            "bridge_withdraw" => {
                if let (Some(token_symbol), Some(amount)) = (
                    tx.payload.token_symbol.as_ref(),
                    tx.payload.amount,
                ) {
                    if amount > 0 {
                        let token_upper = token_symbol.to_uppercase();
                        let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                        if xrge_bal < tx.fee {
                            eprintln!("[node] Rejecting bridge_withdraw: insufficient XRGE for fee ({:.4} < {:.4})", xrge_bal, tx.fee);
                            return;
                        }
                        if token_upper == "XRGE" {
                            if xrge_bal - tx.fee < amount as f64 {
                                eprintln!("[node] Rejecting bridge_withdraw: insufficient XRGE ({:.4} < {})", xrge_bal - tx.fee, amount);
                                return;
                            }
                            *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee + amount as f64;
                        } else {
                            let sender_key = (tx.from_pub_key.clone(), token_upper.clone());
                            let token_bal = *token_balances.get(&sender_key).unwrap_or(&0.0);
                            if token_bal < amount as f64 {
                                eprintln!("[node] Rejecting bridge_withdraw: insufficient {} ({:.4} < {})", token_upper, token_bal, amount);
                                return;
                            }
                            *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
                            *token_balances.entry(sender_key).or_insert(0.0) -= amount as f64;
                        }
                        *burned_tokens.entry(token_upper).or_insert(0.0) += amount as f64;
                    }
                }
            }
            "slash" => {}
            // Shielded transactions: fee deduction only (state is handled separately)
            "shield" => {
                let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                let shield_amount = tx.payload.shielded_value.unwrap_or(0) as f64;
                if xrge_bal < shield_amount + tx.fee {
                    eprintln!("[node] Rejecting shield: insufficient XRGE ({:.4} < {:.4})", xrge_bal, shield_amount + tx.fee);
                    return;
                }
                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= shield_amount + tx.fee;
                // Track shielded supply
                if let Ok(mut sp) = shielded_supply.lock() {
                    *sp += shield_amount;
                }
            }
            "unshield" => {
                let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                if xrge_bal < tx.fee {
                    eprintln!("[node] Rejecting unshield: insufficient XRGE for fee");
                    return;
                }
                let unshield_amount = tx.payload.shielded_value.unwrap_or(0) as f64;
                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) += unshield_amount;
                // Track shielded supply
                if let Ok(mut sp) = shielded_supply.lock() {
                    *sp = (*sp - unshield_amount).max(0.0);
                }
            }
            "shielded_transfer" => {
                // Fee is deducted from public balance (fee is always public)
                let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                if xrge_bal < tx.fee {
                    eprintln!("[node] Rejecting shielded_transfer: insufficient XRGE for fee");
                    return;
                }
                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
            }
            // ─── Token Locking ───────────────────────────────────────
            "token_lock" => {
                let amount = tx.payload.amount.unwrap_or(0) as f64;
                if let Some(token_symbol) = tx.payload.token_symbol.as_ref() {
                    // Lock custom token
                    let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                    if xrge_bal < tx.fee {
                        eprintln!("[node] Rejecting token_lock: insufficient XRGE for fee");
                        return;
                    }
                    let key = (tx.from_pub_key.clone(), token_symbol.clone());
                    let tok_bal = *token_balances.get(&key).unwrap_or(&0.0);
                    if tok_bal < amount {
                        eprintln!("[node] Rejecting token_lock: insufficient {} ({:.4} < {:.4})", token_symbol, tok_bal, amount);
                        return;
                    }
                    *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
                    *token_balances.entry(key).or_insert(0.0) -= amount;
                } else {
                    // Lock XRGE
                    let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                    if xrge_bal < amount + tx.fee {
                        eprintln!("[node] Rejecting token_lock: insufficient XRGE ({:.4} < {:.4})", xrge_bal, amount + tx.fee);
                        return;
                    }
                    *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= amount + tx.fee;
                }
            }
            "token_unlock" => {
                // Balance credit happens in apply_web3_state_effects after lock validation
                let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                if xrge_bal < tx.fee {
                    eprintln!("[node] Rejecting token_unlock: insufficient XRGE for fee");
                    return;
                }
                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
                // The actual balance credit is handled in apply_web3_state_effects
                // after verifying lock ownership and height
                if let Some(_lock_id) = tx.payload.lock_id.as_ref() {
                    // We need to credit the amount back here since static method
                    // won't have access to lock_store. The node will validate
                    // in apply_web3_state_effects and the lock_id is verified there.
                    let amount = tx.payload.amount.unwrap_or(0) as f64;
                    if let Some(token_symbol) = tx.payload.token_symbol.as_ref() {
                        let key = (tx.from_pub_key.clone(), token_symbol.clone());
                        *token_balances.entry(key).or_insert(0.0) += amount;
                    } else {
                        *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) += amount;
                    }
                }
            }
            // ─── Token Staking (custom token pools) ──────────────────
            "create_staking_pool" => {
                let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                if xrge_bal < tx.fee {
                    eprintln!("[node] Rejecting create_staking_pool: insufficient XRGE for fee");
                    return;
                }
                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
            }
            "token_stake" => {
                let amount = tx.payload.amount.unwrap_or(0) as f64;
                if let Some(token_symbol) = tx.payload.token_symbol.as_ref() {
                    let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                    if xrge_bal < tx.fee {
                        eprintln!("[node] Rejecting token_stake: insufficient XRGE for fee");
                        return;
                    }
                    let key = (tx.from_pub_key.clone(), token_symbol.clone());
                    let tok_bal = *token_balances.get(&key).unwrap_or(&0.0);
                    if tok_bal < amount {
                        eprintln!("[node] Rejecting token_stake: insufficient {} ({:.4} < {:.4})", token_symbol, tok_bal, amount);
                        return;
                    }
                    *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
                    *token_balances.entry(key).or_insert(0.0) -= amount;
                }
            }
            "token_unstake" => {
                let amount = tx.payload.amount.unwrap_or(0) as f64;
                let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                if xrge_bal < tx.fee {
                    eprintln!("[node] Rejecting token_unstake: insufficient XRGE for fee");
                    return;
                }
                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
                // Credit tokens back
                if let Some(token_symbol) = tx.payload.token_symbol.as_ref() {
                    let key = (tx.from_pub_key.clone(), token_symbol.clone());
                    *token_balances.entry(key).or_insert(0.0) += amount;
                }
            }
            // ─── Governance ──────────────────────────────────────────
            "create_proposal" | "cast_vote" | "execute_proposal" => {
                let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                if xrge_bal < tx.fee {
                    eprintln!("[node] Rejecting {}: insufficient XRGE for fee", tx.tx_type);
                    return;
                }
                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
            }
            // ─── Allowances ──────────────────────────────────────────
            "token_approve" => {
                let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                if xrge_bal < tx.fee {
                    eprintln!("[node] Rejecting token_approve: insufficient XRGE for fee");
                    return;
                }
                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
            }
            "token_transfer_from" => {
                // Spender pays the fee, owner's tokens are transferred
                let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                if xrge_bal < tx.fee {
                    eprintln!("[node] Rejecting token_transfer_from: insufficient XRGE for fee");
                    return;
                }
                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
                // Actual token transfer deducted from owner, credited to recipient
                if let (Some(owner), Some(to), Some(token_symbol)) = (
                    tx.payload.owner_pub_key.as_ref(),
                    tx.payload.to_pub_key_hex.as_ref(),
                    tx.payload.token_symbol.as_ref(),
                ) {
                    let amount = tx.payload.amount.unwrap_or(0) as f64;
                    let owner_key = (owner.clone(), token_symbol.clone());
                    let owner_bal = *token_balances.get(&owner_key).unwrap_or(&0.0);
                    if owner_bal < amount {
                        eprintln!("[node] Rejecting token_transfer_from: insufficient {} balance", token_symbol);
                        return;
                    }
                    *token_balances.entry(owner_key).or_insert(0.0) -= amount;
                    let recipient_key = (to.clone(), token_symbol.clone());
                    *token_balances.entry(recipient_key).or_insert(0.0) += amount;
                }
            }
            // ─── Airdrops ────────────────────────────────────────────
            "token_airdrop" => {
                let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                if xrge_bal < tx.fee {
                    eprintln!("[node] Rejecting token_airdrop: insufficient XRGE for fee");
                    return;
                }
                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
                if let (Some(recipients), Some(amounts), Some(token_symbol)) = (
                    tx.payload.airdrop_recipients.as_ref(),
                    tx.payload.airdrop_amounts.as_ref(),
                    tx.payload.token_symbol.as_ref(),
                ) {
                    let total: u64 = amounts.iter().sum();
                    let sender_key = (tx.from_pub_key.clone(), token_symbol.clone());
                    let tok_bal = *token_balances.get(&sender_key).unwrap_or(&0.0);
                    if tok_bal < total as f64 {
                        eprintln!("[node] Rejecting token_airdrop: insufficient {} ({:.4} < {})", token_symbol, tok_bal, total);
                        return;
                    }
                    *token_balances.entry(sender_key).or_insert(0.0) -= total as f64;
                    for (i, recipient) in recipients.iter().enumerate() {
                        if let Some(&amt) = amounts.get(i) {
                            let key = (recipient.clone(), token_symbol.clone());
                            *token_balances.entry(key).or_insert(0.0) += amt as f64;
                        }
                    }
                }
            }
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
        // Process unbonding queue — release matured entries
        self.process_unbonding_queue(block.header.height);
        // Check missed blocks and auto-slash
        self.check_missed_blocks(block);
        Ok(())
    }

    /// Release matured unbonding entries — transfer funds back to delegator balance
    fn process_unbonding_queue(&self, current_height: u64) {
        if let Ok(mut queue) = self.unbonding_queue.lock() {
            let mut released = Vec::new();
            let mut remaining = Vec::new();
            for entry in queue.drain(..) {
                if current_height >= entry.release_height {
                    released.push(entry);
                } else {
                    remaining.push(entry);
                }
            }
            *queue = remaining;

            // Credit released unbonds to balances
            if !released.is_empty() {
                if let Ok(mut balances) = self.balances.lock() {
                    for entry in &released {
                        *balances.entry(entry.delegator.clone()).or_insert(0.0) += entry.amount;
                        eprintln!("[node] Unbonding released: {:.4} XRGE to {}",
                            entry.amount, &entry.delegator[..8.min(entry.delegator.len())]);
                    }
                }
            }
        }
    }

    /// Track missed blocks and auto-slash validators over threshold
    fn check_missed_blocks(&self, block: &BlockV1) {
        // Get the block proposer
        let proposer = &block.header.proposer_pub_key;
        // Get all active validators
        if let Ok(validators) = self.validator_store.list_validators() {
            for (pubkey, mut state) in validators {
                if state.stake == 0 { continue; }
                if &pubkey == proposer {
                    // Proposer produced a block — increment blocks_proposed, reset missed
                    state.blocks_proposed += 1;
                    state.missed_blocks = 0;
                    let _ = self.validator_store.set_validator(&pubkey, &state);
                } else if state.jailed_until <= block.header.height {
                    // Active (non-jailed) validator that didn't propose — increment missed
                    state.missed_blocks += 1;
                    if state.missed_blocks >= MISSED_BLOCK_SLASH_THRESHOLD {
                        // Auto-slash
                        let slash_amount = (state.stake / SLASH_DIVISOR).max(1);
                        state.total_slashed += slash_amount;
                        state.stake = state.stake.saturating_sub(slash_amount);
                        state.slash_count += 1;
                        state.jailed_until = block.header.height + JAIL_BLOCKS;
                        state.missed_blocks = 0; // Reset counter
                        eprintln!("[node] AUTO-SLASH: {} slashed {} (missed {} blocks, jailed until {})",
                            &pubkey[..8.min(pubkey.len())], slash_amount,
                            MISSED_BLOCK_SLASH_THRESHOLD, state.jailed_until);
                    }
                    let _ = self.validator_store.set_validator(&pubkey, &state);
                }
            }
        }
    }

    fn apply_validator_tx(&self, tx: &TxV1, height: u64) -> Result<(), String> {
        let ensure = |state: Option<ValidatorState>| {
            state.unwrap_or(ValidatorState {
                stake: 0,
                slash_count: 0,
                jailed_until: 0,
                entropy_contributions: 0,
                blocks_proposed: 0,
                name: None,
                missed_blocks: 0,
                total_slashed: 0,
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

    // ===== NFT Methods =====

    pub fn get_nft_collection(&self, collection_id: &str) -> Result<Option<NftCollection>, String> {
        self.nft_store.get_collection(collection_id)
    }

    pub fn list_nft_collections(&self) -> Result<Vec<NftCollection>, String> {
        self.nft_store.list_collections()
    }

    pub fn get_nft_token(&self, collection_id: &str, token_id: u64) -> Result<Option<NftToken>, String> {
        self.nft_store.get_token(collection_id, token_id)
    }

    pub fn get_nft_tokens_by_collection(&self, collection_id: &str, limit: usize, offset: usize) -> Result<(Vec<NftToken>, usize), String> {
        self.nft_store.get_tokens_by_collection(collection_id, limit, offset)
    }

    pub fn get_nfts_by_owner(&self, owner: &str) -> Result<Vec<NftToken>, String> {
        self.nft_store.get_tokens_by_owner(owner)
    }

    // ===== Token Lock Methods =====

    pub fn get_locks_by_owner(&self, owner: &str) -> Result<Vec<TokenLock>, String> {
        self.lock_store.get_locks_by_owner(owner)
    }

    // ===== Token Staking Methods =====

    pub fn get_staking_pools(&self) -> Result<Vec<StakingPool>, String> {
        self.token_stake_store.list_pools()
    }

    pub fn get_staking_pool(&self, pool_id: &str) -> Result<Option<StakingPool>, String> {
        self.token_stake_store.get_pool(pool_id)
    }

    pub fn get_stakes_by_owner(&self, owner: &str) -> Result<Vec<TokenStake>, String> {
        self.token_stake_store.get_stakes_by_owner(owner)
    }

    pub fn get_stakes_by_pool(&self, pool_id: &str) -> Result<Vec<TokenStake>, String> {
        self.token_stake_store.get_stakes_by_pool(pool_id)
    }

    // ===== Governance Methods =====

    pub fn get_proposals(&self) -> Result<Vec<Proposal>, String> {
        self.governance_store.list_proposals()
    }

    pub fn get_proposals_by_token(&self, token_symbol: &str) -> Result<Vec<Proposal>, String> {
        self.governance_store.list_proposals_by_token(token_symbol)
    }

    pub fn get_proposal(&self, proposal_id: &str) -> Result<Option<Proposal>, String> {
        self.governance_store.get_proposal(proposal_id)
    }

    pub fn get_votes_for_proposal(&self, proposal_id: &str) -> Result<Vec<Vote>, String> {
        self.governance_store.get_votes_for_proposal(proposal_id)
    }

    /// Apply NFT transaction effects during block processing
    fn apply_nft_tx_inner(
        &self,
        balances: &mut HashMap<String, f64>,
        tx: &TxV1,
        block_time: u64,
    ) -> Result<(), String> {
        match tx.tx_type.as_str() {
            "nft_create_collection" => {
                let symbol = tx.payload.nft_collection_symbol.as_ref().ok_or("missing nft_collection_symbol")?;
                let name = tx.payload.nft_collection_name.as_ref().ok_or("missing nft_collection_name")?;
                let collection_id = NftCollection::make_collection_id(&tx.from_pub_key, symbol);

                let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                if xrge_bal < tx.fee {
                    eprintln!("[node] Rejecting nft_create_collection: insufficient XRGE ({:.4} < {:.4})", xrge_bal, tx.fee);
                    return Ok(());
                }

                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;

                let col = NftCollection {
                    collection_id,
                    symbol: symbol.to_uppercase(),
                    name: name.clone(),
                    creator: tx.from_pub_key.clone(),
                    description: tx.payload.nft_description.clone(),
                    image: tx.payload.nft_image.clone(),
                    max_supply: tx.payload.nft_max_supply,
                    minted: 0,
                    royalty_bps: tx.payload.nft_royalty_bps.unwrap_or(0),
                    royalty_recipient: tx.from_pub_key.clone(),
                    frozen: false,
                    created_at: block_time,
                };
                self.nft_store.save_collection(&col)?;
            }
            "nft_mint" => {
                let col_id = tx.payload.nft_collection_id.as_ref().ok_or("missing nft_collection_id")?;
                let token_name = tx.payload.nft_token_name.as_ref().ok_or("missing nft_token_name")?;

                let mut col = match self.nft_store.get_collection(col_id)? {
                    Some(c) => c,
                    None => {
                        eprintln!("[node] Warning: Collection {} not found, skipping nft_mint", col_id);
                        return Ok(());
                    }
                };

                if col.creator != tx.from_pub_key {
                    eprintln!("[node] Rejecting nft_mint: {} is not the creator of collection {}", &tx.from_pub_key[..16], col_id);
                    return Ok(());
                }
                if col.frozen {
                    eprintln!("[node] Warning: Collection {} is frozen, skipping nft_mint", col_id);
                    return Ok(());
                }
                if let Some(max) = col.max_supply {
                    if col.minted >= max {
                        eprintln!("[node] Warning: Collection {} reached max supply, skipping nft_mint", col_id);
                        return Ok(());
                    }
                }

                let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                if xrge_bal < tx.fee {
                    eprintln!("[node] Rejecting nft_mint: insufficient XRGE ({:.4} < {:.4})", xrge_bal, tx.fee);
                    return Ok(());
                }

                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;

                let token_id = col.minted + 1;
                col.minted = token_id;
                self.nft_store.save_collection(&col)?;

                let token = NftToken {
                    collection_id: col_id.clone(),
                    token_id,
                    owner: tx.from_pub_key.clone(),
                    creator: tx.from_pub_key.clone(),
                    name: token_name.clone(),
                    metadata_uri: tx.payload.nft_metadata_uri.clone(),
                    attributes: tx.payload.nft_attributes.clone(),
                    locked: false,
                    minted_at: block_time,
                    transferred_at: block_time,
                };
                self.nft_store.save_token(&token)?;
            }
            "nft_batch_mint" => {
                let col_id = tx.payload.nft_collection_id.as_ref().ok_or("missing nft_collection_id")?;
                let names = tx.payload.nft_batch_names.as_ref().ok_or("missing nft_batch_names")?;

                let mut col = match self.nft_store.get_collection(col_id)? {
                    Some(c) => c,
                    None => {
                        eprintln!("[node] Warning: Collection {} not found, skipping nft_batch_mint", col_id);
                        return Ok(());
                    }
                };

                if col.creator != tx.from_pub_key {
                    eprintln!("[node] Rejecting nft_batch_mint: {} is not the creator of collection {}", &tx.from_pub_key[..16], col_id);
                    return Ok(());
                }
                if col.frozen {
                    eprintln!("[node] Warning: Collection {} is frozen, skipping nft_batch_mint", col_id);
                    return Ok(());
                }
                if let Some(max) = col.max_supply {
                    if col.minted + names.len() as u64 > max {
                        eprintln!("[node] Warning: Collection {} would exceed max supply, skipping nft_batch_mint", col_id);
                        return Ok(());
                    }
                }

                let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                if xrge_bal < tx.fee {
                    eprintln!("[node] Rejecting nft_batch_mint: insufficient XRGE ({:.4} < {:.4})", xrge_bal, tx.fee);
                    return Ok(());
                }

                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;

                let uris = tx.payload.nft_batch_uris.as_ref();
                let attrs = tx.payload.nft_batch_attributes.as_ref();

                for (i, name) in names.iter().enumerate() {
                    let token_id = col.minted + 1;
                    col.minted = token_id;

                    let token = NftToken {
                        collection_id: col_id.clone(),
                        token_id,
                        owner: tx.from_pub_key.clone(),
                        creator: tx.from_pub_key.clone(),
                        name: name.clone(),
                        metadata_uri: uris.and_then(|u| u.get(i).cloned()),
                        attributes: attrs.and_then(|a| a.get(i).cloned()),
                        locked: false,
                        minted_at: block_time,
                        transferred_at: block_time,
                    };
                    self.nft_store.save_token(&token)?;
                }
                self.nft_store.save_collection(&col)?;
            }
            "nft_transfer" => {
                let col_id = tx.payload.nft_collection_id.as_ref().ok_or("missing nft_collection_id")?;
                let token_id = tx.payload.nft_token_id.ok_or("missing nft_token_id")?;
                let to = tx.payload.to_pub_key_hex.as_ref().ok_or("missing to_pub_key_hex")?;

                let mut token = match self.nft_store.get_token(col_id, token_id)? {
                    Some(t) => t,
                    None => {
                        eprintln!("[node] Warning: NFT {}:{} not found, skipping transfer", col_id, token_id);
                        return Ok(());
                    }
                };

                if token.owner != tx.from_pub_key {
                    eprintln!("[node] Warning: NFT {}:{} not owned by sender, skipping transfer", col_id, token_id);
                    return Ok(());
                }
                if token.locked {
                    eprintln!("[node] Warning: NFT {}:{} is locked, skipping transfer", col_id, token_id);
                    return Ok(());
                }

                // Calculate total cost (fee + royalty)
                let sale_price = tx.payload.amount.unwrap_or(0) as f64;
                let mut total_cost = tx.fee;
                let mut royalty_amount = 0.0;
                if sale_price > 0.0 {
                    if let Some(col) = self.nft_store.get_collection(col_id)? {
                        if col.royalty_bps > 0 {
                            royalty_amount = (sale_price * col.royalty_bps as f64) / 10000.0;
                            total_cost += royalty_amount;
                        }
                    }
                }

                let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                if xrge_bal < total_cost {
                    eprintln!("[node] Rejecting nft_transfer: insufficient XRGE ({:.4} < {:.4})", xrge_bal, total_cost);
                    return Ok(());
                }

                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;

                if royalty_amount > 0.0 {
                    if let Some(col) = self.nft_store.get_collection(col_id)? {
                        *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= royalty_amount;
                        *balances.entry(col.royalty_recipient.clone()).or_insert(0.0) += royalty_amount;
                    }
                }

                token.owner = to.clone();
                token.transferred_at = block_time;
                self.nft_store.save_token(&token)?;
            }
            "nft_burn" => {
                let col_id = tx.payload.nft_collection_id.as_ref().ok_or("missing nft_collection_id")?;
                let token_id = tx.payload.nft_token_id.ok_or("missing nft_token_id")?;

                if let Some(token) = self.nft_store.get_token(col_id, token_id)? {
                    if token.owner != tx.from_pub_key {
                        eprintln!("[node] Warning: NFT {}:{} not owned by sender, skipping burn", col_id, token_id);
                        return Ok(());
                    }
                } else {
                    eprintln!("[node] Warning: NFT {}:{} not found, skipping burn", col_id, token_id);
                    return Ok(());
                }

                let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                if xrge_bal < tx.fee {
                    eprintln!("[node] Rejecting nft_burn: insufficient XRGE ({:.4} < {:.4})", xrge_bal, tx.fee);
                    return Ok(());
                }

                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;
                self.nft_store.delete_token(col_id, token_id)?;
            }
            "nft_lock" => {
                let col_id = tx.payload.nft_collection_id.as_ref().ok_or("missing nft_collection_id")?;
                let token_id = tx.payload.nft_token_id.ok_or("missing nft_token_id")?;
                let locked = tx.payload.nft_locked.unwrap_or(true);

                let mut token = match self.nft_store.get_token(col_id, token_id)? {
                    Some(t) => t,
                    None => return Ok(()),
                };

                if token.owner != tx.from_pub_key {
                    eprintln!("[node] Warning: NFT {}:{} not owned by sender, skipping lock", col_id, token_id);
                    return Ok(());
                }

                let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                if xrge_bal < tx.fee {
                    eprintln!("[node] Rejecting nft_lock: insufficient XRGE ({:.4} < {:.4})", xrge_bal, tx.fee);
                    return Ok(());
                }

                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;

                token.locked = locked;
                self.nft_store.save_token(&token)?;
            }
            "nft_freeze_collection" => {
                let col_id = tx.payload.nft_collection_id.as_ref().ok_or("missing nft_collection_id")?;
                let frozen = tx.payload.nft_frozen.unwrap_or(true);

                let mut col = match self.nft_store.get_collection(col_id)? {
                    Some(c) => c,
                    None => return Ok(()),
                };

                if col.creator != tx.from_pub_key {
                    eprintln!("[node] Warning: Only creator can freeze collection {}, skipping", col_id);
                    return Ok(());
                }

                let xrge_bal = *balances.get(&tx.from_pub_key).unwrap_or(&0.0);
                if xrge_bal < tx.fee {
                    eprintln!("[node] Rejecting nft_freeze_collection: insufficient XRGE ({:.4} < {:.4})", xrge_bal, tx.fee);
                    return Ok(());
                }

                *balances.entry(tx.from_pub_key.clone()).or_insert(0.0) -= tx.fee;

                col.frozen = frozen;
                self.nft_store.save_collection(&col)?;
            }
            _ => {}
        }
        Ok(())
    }

    /// Rebuild NFT state (collections + tokens) from chain history
    fn rebuild_nft_state(&self) -> Result<(), String> {
        let blocks = self.store.get_all_blocks()?;
        if blocks.is_empty() {
            return Ok(());
        }

        self.nft_store.clear_all()?;

        let mut col_count = 0u32;
        let mut token_count = 0u32;
        let mut dummy_balances: HashMap<String, f64> = HashMap::new();

        for block in &blocks {
            for tx in &block.txs {
                match tx.tx_type.as_str() {
                    "nft_create_collection" | "nft_mint" | "nft_batch_mint"
                    | "nft_transfer" | "nft_burn" | "nft_lock" | "nft_freeze_collection" => {
                        if tx.tx_type == "nft_create_collection" {
                            col_count += 1;
                        }
                        if tx.tx_type == "nft_mint" {
                            token_count += 1;
                        }
                        if tx.tx_type == "nft_batch_mint" {
                            token_count += tx.payload.nft_batch_names.as_ref().map(|n| n.len() as u32).unwrap_or(0);
                        }
                        let _ = self.apply_nft_tx_inner(&mut dummy_balances, tx, block.header.time);
                    }
                    _ => {}
                }
            }
        }

        if col_count > 0 || token_count > 0 {
            eprintln!("[node] Rebuilt {} NFT collections, {} NFTs from chain history", col_count, token_count);
        }
        Ok(())
    }

    pub fn list_wallets(&self) -> Result<Vec<MessengerWallet>, String> {
        self.messenger_store.list_wallets()
    }

    pub fn list_discoverable_wallets(&self) -> Result<Vec<MessengerWallet>, String> {
        self.messenger_store.list_discoverable_wallets()
    }

    pub fn register_wallet(&self, wallet: MessengerWallet) -> Result<MessengerWallet, String> {
        self.messenger_store.register_wallet(wallet)
    }

    pub fn list_conversations(&self, wallet_id: &str) -> Result<Vec<Conversation>, String> {
        self.messenger_store.list_conversations(wallet_id)
    }

    pub fn list_conversations_with_activity(&self, wallet_id: &str, extra_keys: &[&str]) -> Result<Vec<serde_json::Value>, String> {
        self.messenger_store.list_conversations_with_activity(wallet_id, extra_keys)
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

    pub fn delete_conversation(&self, conversation_id: &str) -> Result<(), String> {
        self.messenger_store.delete_conversation(conversation_id)
    }

    pub fn delete_message(&self, message_id: &str) -> Result<(), String> {
        self.messenger_store.delete_message(message_id)
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

    pub fn cleanup_expired_messages(&self) -> Result<usize, String> {
        self.messenger_store.cleanup_expired_messages()
    }

    // --- Name Registry ---

    pub fn register_name(&self, name: &str, wallet_id: &str) -> Result<NameEntry, String> {
        self.name_registry.register_name(name, wallet_id)
    }

    pub fn lookup_name(&self, name: &str) -> Result<Option<NameEntry>, String> {
        self.name_registry.lookup_name(name)
    }

    pub fn reverse_lookup_name(&self, wallet_id: &str) -> Result<Option<String>, String> {
        self.name_registry.reverse_lookup(wallet_id)
    }

    pub fn update_name_wallet_id(&self, old_id: &str, new_id: &str) -> Result<(), String> {
        self.name_registry.update_wallet_id(old_id, new_id)
    }

    pub fn release_name(&self, name: &str, wallet_id: &str) -> Result<(), String> {
        self.name_registry.release_name(name, wallet_id)
    }

    // --- Mail ---

    pub fn send_mail(&self, msg: MailMessage) -> Result<MailMessage, String> {
        self.mail_store.store_message(msg)
    }

    pub fn get_mail(&self, message_id: &str) -> Result<Option<MailMessage>, String> {
        self.mail_store.get_message(message_id)
    }

    pub fn list_mail_folder(&self, wallet_id: &str, folder: &str) -> Result<Vec<(MailMessage, MailLabel)>, String> {
        self.mail_store.list_folder(wallet_id, folder)
    }

    pub fn move_mail(&self, wallet_id: &str, message_id: &str, folder: &str) -> Result<(), String> {
        self.mail_store.move_to_folder(wallet_id, message_id, folder)
    }

    pub fn mark_mail_read(&self, wallet_id: &str, message_id: &str) -> Result<(), String> {
        self.mail_store.mark_read(wallet_id, message_id)
    }

    pub fn delete_mail(&self, wallet_id: &str, message_id: &str) -> Result<(), String> {
        self.mail_store.delete_message(wallet_id, message_id)
    }

    pub fn update_mail_labels_wallet_id(&self, old_id: &str, new_id: &str) -> Result<usize, String> {
        self.mail_store.update_labels_wallet_id(old_id, new_id)
    }

    // ===== Token freeze/pause =====

    pub fn is_token_frozen(&self, symbol: &str) -> Result<bool, String> {
        self.token_metadata_store.is_frozen(symbol)
    }

    pub fn set_token_frozen(&self, symbol: &str, frozen: bool) -> Result<(), String> {
        self.token_metadata_store.set_frozen(symbol, frozen)
    }

    // ===== Token mint authority =====

    pub fn is_token_mintable(&self, symbol: &str) -> Result<bool, String> {
        self.token_metadata_store.is_mintable(symbol)
    }

    pub fn record_token_mint(&self, symbol: &str, amount: u64) -> Result<(), String> {
        self.token_metadata_store.record_mint(symbol, amount)
    }

    // ===== Rouge1 address index =====

    /// Index a public key → rouge1 address mapping (idempotent, O(1) write)
    pub fn index_address(&self, pubkey: &str) {
        use quantum_vault_crypto::{pub_key_to_address, address_to_hash, bytes_to_hex};
        if let Ok(addr) = pub_key_to_address(pubkey) {
            if let Ok(hash) = address_to_hash(&addr) {
                let hash_hex = bytes_to_hex(&hash);
                // Store hash → pubkey (for rouge1→pubkey resolution)
                let _ = self.address_db.insert(hash_hex.as_bytes(), pubkey.as_bytes());
                // Also store pubkey → rouge1 (for reverse lookup)
                let _ = self.address_db.insert(pubkey.as_bytes(), addr.as_bytes());
            }
        }
    }

    /// Resolve a rouge1 address to its public key — O(1) persistent lookup
    pub fn resolve_rouge1(&self, rouge1_address: &str) -> Option<String> {
        use quantum_vault_crypto::{address_to_hash, bytes_to_hex};
        if let Ok(hash) = address_to_hash(rouge1_address) {
            let hash_hex = bytes_to_hex(&hash);
            if let Ok(Some(val)) = self.address_db.get(hash_hex.as_bytes()) {
                return String::from_utf8(val.to_vec()).ok();
            }
        }
        None
    }

    /// Resolve a public key to its rouge1 address — O(1) persistent lookup
    pub fn resolve_pubkey_to_address(&self, pubkey: &str) -> Option<String> {
        if let Ok(Some(val)) = self.address_db.get(pubkey.as_bytes()) {
            return String::from_utf8(val.to_vec()).ok();
        }
        None
    }

    /// Backfill the address index from all known balances (startup migration)
    pub fn backfill_address_index(&self) {
        if self.address_db.len() > 10 {
            return; // Already populated
        }
        if let Ok(balances) = self.get_all_native_balances() {
            let mut count = 0usize;
            for pubkey in balances.keys() {
                self.index_address(pubkey);
                count += 1;
            }
            if count > 0 {
                eprintln!("[startup] Backfilled address index: {} entries", count);
            }
        }
    }

    // ===== Push notifications =====

    pub fn register_push_token(&self, public_key: &str, push_token: &str, platform: &str) -> Result<(), String> {
        use quantum_vault_storage::push_token_store::PushRegistration;
        self.push_token_store.register(&PushRegistration {
            public_key: public_key.to_string(),
            push_token: push_token.to_string(),
            platform: platform.to_string(),
            registered_at: chrono::Utc::now().timestamp(),
        })
    }

    pub fn unregister_push_token(&self, public_key: &str) -> Result<bool, String> {
        self.push_token_store.unregister(public_key)
    }

    pub fn get_push_token(&self, public_key: &str) -> Option<String> {
        self.push_token_store.get(public_key).ok().flatten().map(|r| r.push_token)
    }

    pub fn get_push_tokens_for_keys(&self, keys: &[&str]) -> Vec<(String, String)> {
        self.push_token_store.get_tokens_for_keys(keys)
            .into_iter()
            .map(|r| (r.public_key, r.push_token))
            .collect()
    }

}
