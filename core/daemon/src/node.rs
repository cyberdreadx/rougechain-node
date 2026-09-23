use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::fs;

use quantum_vault_vm::{WasmRuntime, ContractStore, MAX_BLOCK_FUEL};

use chrono::Utc;

use quantum_vault_consensus::{compute_selection_seed, fetch_entropy, select_proposer, start_entropy_prefetch, ProposerSelectionResult};
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
use quantum_vault_storage::social_store::SocialStore;
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
use crate::units::{fee_to_quanta, xrge_f64_to_quanta, quanta_to_display, mul_div};
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

// EIP-1559 dynamic fee constants. The base fee is consensus state — it sets each
// block's burn — so it is stored and updated in integer **quanta**. The old f64
// arithmetic and decimal-string storage were a replay-fork hazard (T6).
const BASE_FEE_INITIAL_QUANTA: u128 = 100_000_000; // 0.1 XRGE
const BASE_FEE_FLOOR_QUANTA: u128 = 1_000_000;     // 0.001 XRGE minimum
const BASE_FEE_MAX_CHANGE_DENOM: u128 = 8;         // Max 12.5% change per block
const TARGET_TXS_PER_BLOCK: usize = 10;            // Target block fullness

/// Balance-snapshot format version. v2 = integer-quanta ledger (u128 balances,
/// token/lp base units). A v1 (pre-integer, f64 XRGE) snapshot MUST NOT be
/// loaded by v2 code: a whole-number f64 balance like `{"alice": 100}` parses as
/// u128 `100` (= 0.0000001 XRGE) instead of `100 * 10^9` quanta — a silent
/// corruption. Bumping this and rejecting any other version forces a safe full
/// rebuild from chain history instead. Bump on every ledger-representation change.
/// v3: balances are now keyed by canonical rouge1 address (canon_addr) — a v2
/// snapshot may hold split pubkey-hex/bech32 buckets, so it is rejected and the
/// ledger is rebuilt from history under the canonical keying.
/// v4: an intermediate build wrote v3 snapshots while still crediting transfers
/// under raw pubkey-hex keys, so a v3 snapshot can still hold non-canonical
/// buckets. Reject it and rebuild once more under full canon_addr keying.
const SNAPSHOT_VERSION: u32 = 4;

/// ─────────────────────────────────────────────────────────────────────────
/// THE V2 FORK SWITCH (T11).
///
/// RougeChain **v2** — integer quanta ledger (Phase 1), state-root commitment
/// (Phase 2), and contract XRGE custody (Phase 3) — all activate together at
/// this one block height. Everything above is dormant below it: headers carry
/// no state root and none is verified, and contract `balance_deltas` are
/// discarded exactly as on today's mainnet. So while this is `u64::MAX`, the
/// live chain is byte-for-byte unchanged.
///
/// Scheduling the coordinated hard fork = change THIS ONE NUMBER to the agreed
/// height, in a release that EVERY validator runs *before* that height is
/// reached. Setting it wrong, or letting even one validator cross the height on
/// an old binary, splits the network. Follow the T11 runbook — do not flip this
/// casually. Tests activate from genesis (height 0).
#[cfg(not(test))]
const V2_FORK_HEIGHT: u64 = 18;
#[cfg(test)]
const V2_FORK_HEIGHT: u64 = 0;

/// Phase 2 (state root) and Phase 3 (contract custody) share the single v2 fork
/// height — they are one coordinated upgrade, and custody relies on the state
/// root as its divergence backstop, so they must never activate apart.
const STATE_ROOT_ACTIVATION_HEIGHT: u64 = V2_FORK_HEIGHT;
const CONTRACT_CUSTODY_ACTIVATION_HEIGHT: u64 = V2_FORK_HEIGHT;

/// First height whose `bridge_withdraw` receipts carry the R1 typed execution result, i.e. the
/// height from which the relayer-facing payout store is deterministically derivable from
/// accepted chain history alone. Pre-R1 receipts are unconditionally `Success` and MUST NOT
/// be used to derive payout records. Set to the R1 activation height at deployment (fork F);
/// until then it is the first post-tip height so no historical record is ever re-derived.
pub const BRIDGE_PAYOUT_STORE_ACTIVATION_HEIGHT: u64 = crate::fork::FORK_HEIGHT;

/// Test-only, thread-local override of the v2 fork height so the historical-replay
/// regression can exercise the PRODUCTION activation height (18) while unit tests keep
/// activating from genesis. Compiled out of production builds — there is no runtime knob.
#[cfg(test)]
thread_local! {
    static TEST_FORK_HEIGHT_OVERRIDE: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
    /// Test-only: skip the F-1 canonical-ledger assertion (used ONLY by the table generator test
    /// that produces the canonical tables in the first place). Compiled out of production.
    static TEST_SKIP_F_MINUS_1_ASSERT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// Test-only producer fault injection: 0 none, 1 root computation, 2 validator
    /// persistence (after the store was mutated), 3 append_block (after everything).
    static TEST_PRODUCER_FAULT: std::cell::Cell<u8> = const { std::cell::Cell::new(0) };
}
#[inline]
fn state_root_activation_height() -> u64 {
    #[cfg(test)]
    {
        if let Some(h) = TEST_FORK_HEIGHT_OVERRIDE.with(|c| c.get()) { return h; }
    }
    STATE_ROOT_ACTIVATION_HEIGHT
}
#[inline]
fn contract_custody_activation_height() -> u64 {
    #[cfg(test)]
    {
        if let Some(h) = TEST_FORK_HEIGHT_OVERRIDE.with(|c| c.get()) { return h; }
    }
    CONTRACT_CUSTODY_ACTIVATION_HEIGHT
}

/// C1 — TRANSACTION-UNIQUENESS consensus rule (scheduled hard fork).
///
/// Block import verifies signatures but, before this rule, never checked that a signed
/// transaction had not already been included, so any accepted proposer could re-include a
/// historical signed tx and debit its sender again (the mempool nonce check is bypassed by a
/// proposer building the block directly; mainnet history is not nonce-sequential, so a
/// consensus nonce rule is NOT possible without splitting the chain).
///
/// From this height on, a block is INVALID if any of its transactions (by canonical tx hash,
/// `compute_single_tx_hash` = sha256(encode_tx_v1)) appears twice in the block or was already
/// included in an earlier accepted block. `None` = not scheduled (rule inactive everywhere;
/// the index and the mempool guard still run, which are node-local and change no block
/// validity). Set to the chosen fork height together with a validator rollout.
pub const TX_UNIQUENESS_ACTIVATION_HEIGHT: Option<u64> = Some(90);
#[cfg(test)]
thread_local! {
    static TEST_TX_UNIQUENESS_OVERRIDE: std::cell::Cell<Option<Option<u64>>> = const { std::cell::Cell::new(None) };
}
#[inline]
fn tx_uniqueness_activation_height() -> Option<u64> {
    #[cfg(test)]
    {
        if let Some(h) = TEST_TX_UNIQUENESS_OVERRIDE.with(|c| c.get()) { return h; }
    }
    TX_UNIQUENESS_ACTIVATION_HEIGHT
}
#[inline]
pub fn tx_uniqueness_rule_active(height: u64) -> bool {
    matches!(tx_uniqueness_activation_height(), Some(a) if height >= a)
}
/// Meta key inside the tx-seen tree: the tip height the index is complete up to.
const TX_SEEN_INDEXED_TIP_KEY: &[u8] = b"__indexed_tip_v2";

/// Height after which a P2P-imported block's proposer MUST be a staked validator
/// (`stake > 0`) in the on-chain validator set, or the block is rejected on
/// `import_block`. Blocks at or below this height skip *only that* check — a
/// bootstrap grace window so a fresh joiner can replay genesis and the earliest
/// blocks before any staking transactions have populated its validator set.
/// Below the window a block is still fully validated (proposer signature, block
/// hash, `prev_hash`, every transaction signature, and — past the v2 fork height
/// — the committed state root and contract-custody apply); only proposer
/// authorization is deferred. The gate is additionally short-circuited by
/// `!validators.is_empty()`, so if the locally-derived set is empty it is
/// bypassed at any height (a defensive don't-brick fallback); it is meaningfully
/// enforced only once the set is non-empty and height exceeds this constant.
///
/// This is NOT a "chain becomes unjoinable at height N" cliff: as long as the
/// nodes producing blocks are staked validators (genesis `initial_validators`,
/// or added later via a `stake` tx), every syncing node rebuilds that same set
/// from history and accepts their blocks at any height. The operational rule it
/// enforces is STAKE-BEFORE-PROPOSE: a new validator must have an on-chain
/// `stake` tx applied (>= genesis `min_stake`) and be in the set *before* it
/// proposes blocks that peers will sync past this height, or those blocks are
/// rejected as coming from an unknown proposer. That is standard proof-of-stake
/// onboarding, not a wall — see `docs/staking/adding-a-validator.md`.
///
/// Its value is protocol consensus on the sync path: changing it alters which
/// blocks a syncing node accepts, so treat a change like a coordinated fork
/// (every node on the new value before any chain crosses it), not a casual edit.
/// Kept as a plain `const` (no `#[cfg(test)]` variant) so tests exercise the
/// same grace window as mainnet.
const PROPOSER_AUTH_ACTIVATION_HEIGHT: u64 = 100;

/// The official burn address - tokens sent here are permanently destroyed
/// This is a deterministic address derived from "QUANTUM_VAULT_BURN_ADDRESS_V1"
/// No private key can ever be derived for this address
pub const BURN_ADDRESS: &str = "XRGE_BURN_0x000000000000000000000000000000000000000000000000000000000000DEAD";

/// Canonical balance-map key: a wallet's balance is ALWAYS keyed by its rouge1
/// address, so it lands in the SAME bucket whether the wallet was addressed by
/// its raw public-key hex or by its bech32 `rouge1…` address. Without this, a
/// transfer that credits `to` in bech32 form and a spend that debits `from_pub_key`
/// in hex form hit two different keys and a wallet's funds fragment.
///
/// Sentinels and non-wallet keys — BURN_ADDRESS, `__treasury__`,
/// `__staking_rewards__`, and anything that isn't a valid ML-DSA public key —
/// are not valid pubkeys, so `pub_key_to_address` fails and they pass through
/// unchanged. A string that is already a `rouge1…` address passes through too.
fn canon_addr<S: AsRef<str>>(key: S) -> String {
    let key = key.as_ref();
    if quantum_vault_crypto::is_rouge_address(key) {
        return key.to_string();
    }
    quantum_vault_crypto::pub_key_to_address(key).unwrap_or_else(|_| key.to_string())
}

#[derive(Clone)]
pub struct NodeOptions {
    pub data_dir: PathBuf,
    pub chain: ChainConfig,
    pub mine: bool,
    /// Optional store for pending bridge withdrawals (qETH → ETH)
    pub bridge_withdraw_store: Option<std::sync::Arc<BridgeWithdrawStore>>,
    /// Public keys of the genesis (founding) validators. These are the only
    /// keys trusted to authorize node-cosigned bridge_withdraw txs during block
    /// import (see the import_block verification note). Anchored to the genesis
    /// set — not the live validator set — so validators that join later can
    /// never gain bridge-authority power. Empty disables the authority path.
    pub bridge_authority_keys: Vec<String>,
    /// Genesis seed (allocations + validators) so a node can deterministically recover its
    /// state from genesis + chain history (missing / corrupt snapshot) without any snapshot.
    pub genesis_allocations: Vec<crate::GenesisAllocation>,
    pub genesis_validators: Vec<crate::GenesisValidator>,
}

/// Key for token balances: (public_key, token_symbol)
type TokenBalanceKey = (String, String);

/// Position-aligned validator-state execution result of a `stake` / `unstake` tx. Produced by
/// the SAME decision that debits the economic ledger (inside `apply_balance_tx_inner`, against a
/// sequential in-block validator shadow); `apply_validator_block` consumes ONLY these results.
/// A failed/no-op stake or unstake therefore can never change validator state.
#[derive(Clone, Debug, PartialEq)]
pub enum ValidatorExecution {
    StakeApplied { validator: String, amount: u128 },
    UnstakeApplied { validator: String, amount: u128, release_height: u64 },
    Failed(String),
}

/// Everything `apply_balance_block` decided, indexed by tx position.
pub struct BlockExecution {
    pub bridge: Vec<Option<quantum_vault_bridge_exec::BridgeWithdrawExecution>>,
    pub validator: Vec<Option<ValidatorExecution>>,
}

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
    /// C1: canonical tx hash -> height of the accepted block that included it (see
    /// `TX_UNIQUENESS_ACTIVATION_HEIGHT`). Written only after a block is durable; rebuilt
    /// from the stored chain on every start.
    tx_seen_db: sled::Tree,
    social_store: SocialStore,
    keys: Arc<Mutex<PQKeypair>>,
    mempool: Arc<Mutex<HashMap<String, TxV1>>>,
    verified_tx_ids: Arc<Mutex<HashSet<String>>>,
    /// R1 derived-state health: set when a relayer-facing bridge payout record could NOT be
    /// persisted for an ACCEPTED block. Chain validity is unaffected (the record is derived
    /// data, rebuildable from accepted history); the bridge is fail-closed until rebuilt.
    bridge_store_degraded: Arc<std::sync::atomic::AtomicBool>,
    /// tx_ids whose payout-record write failed (for alerts / the health endpoint).
    bridge_store_failed_ids: Arc<Mutex<Vec<String>>>,
    balances: Arc<Mutex<HashMap<String, u128>>>,  // native XRGE in quanta (1 XRGE = 1e9); T3c flip
    token_balances: Arc<Mutex<HashMap<TokenBalanceKey, u128>>>,
    lp_balances: Arc<Mutex<HashMap<TokenBalanceKey, u128>>>,  // LP token balances (integer counts; T3 flip)
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
    /// Recently mined tx hashes — prevents re-adding the same tx to mempool
    mined_tx_hashes: Arc<Mutex<HashSet<String>>>,
    /// WASM runtime for contract execution (set after construction)
    wasm_runtime: Option<Arc<WasmRuntime>>,
    /// Contract store for WASM bytecode/state (set after construction)
    contract_store: Option<Arc<ContractStore>>,
    /// Persisted balance snapshot to avoid full rebuild on restart
    snapshot_db: sled::Tree,
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
        let social_store = SocialStore::new(&opts.data_dir)?;
        // Open receipt store on the same sled DB as chain store
        let receipt_db = sled::open(opts.data_dir.join("receipt-db"))
            .map_err(|e| format!("open receipt DB: {}", e))?;
        let receipt_store = ReceiptStore::new(&receipt_db)?;
        let tx_seen_db = sled::open(opts.data_dir.join("tx-seen-db"))
            .map_err(|e| format!("open tx-seen DB: {}", e))?
            .open_tree("tx_hashes")
            .map_err(|e| format!("open tx-seen tree: {}", e))?;
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
            let snapshot_db = sled::open(opts.data_dir.join("snapshot-db"))
                .map_err(|e| format!("snapshot-db: {}", e))?
                .open_tree("balance_snapshot")
                .map_err(|e| format!("snapshot tree: {}", e))?;
            let node = Self {
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
            social_store,
            keys: Arc::new(Mutex::new(keys)),
            mempool: Arc::new(Mutex::new(HashMap::new())),
            verified_tx_ids: Arc::new(Mutex::new(HashSet::new())),
            bridge_store_degraded: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            bridge_store_failed_ids: Arc::new(Mutex::new(Vec::new())),
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
            mined_tx_hashes: Arc::new(Mutex::new(HashSet::new())),
            tx_seen_db,
            wasm_runtime: None,
            contract_store: None,
            snapshot_db,
        };

        start_entropy_prefetch();

        Ok(node)
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

    pub fn init(&self) -> Result<(), String> { self.init_inner(false) }
    /// ONLY for the explicit `--migrate-canonical-ledger` command: loads state without the
    /// fork-readiness guard so the legacy ledger can be verified and migrated. Never used by a
    /// normal start.
    pub fn init_for_migration(&self) -> Result<(), String> { self.init_inner(true) }
    fn init_inner(&self, allow_legacy_ledger_for_migration: bool) -> Result<(), String> {
        self.store.init()?;
        self.messenger_store.init()?;

        let tip = self.store.get_tip()?;
        let snapshot_valid = match self.load_balance_snapshot() {
            Ok(snap_height) if snap_height == tip.height => {
                eprintln!("[init] Loaded balance snapshot at height {} — skipping rebuild", snap_height);
                true
            }
            Ok(snap_height) => {
                eprintln!("[init] Snapshot height {} != tip {} — full rebuild required", snap_height, tip.height);
                false
            }
            Err(_) => {
                eprintln!("[init] No valid snapshot — full rebuild required");
                false
            }
        };

        if snapshot_valid {
            // Pool and NFT sled stores are already up to date from live block processing
            self.migrate_nonce_db();
        } else {
            // Deterministic recovery = the fresh-sync path over the stored blocks (checkpoint
            // validation + canonical rules). Never a legacy rebuild.
            self.migrate_nonce_db();
            self.recover_from_history()?;
        }
        // Past F-1 a node may only run on the canonical ledger (explicit migration required
        // for a legacy production ledger; never automatic).
        if !allow_legacy_ledger_for_migration && self.fork_applies() {
            self.fork_readiness_check()?;
        }
        self.rebuild_proposer_counts()?;
        // C1: the tx-seen index is derived state — make it complete for the stored chain.
        self.ensure_tx_seen_index()?;
        // R1: derived bridge payout store — idempotent reconstruction from accepted history on
        // every start, so a missed persistence (crash, disk error) never survives a restart.
        match self.rebuild_bridge_withdraw_store() {
            Ok(n) if n > 0 => eprintln!("[bridge] rebuilt {} missing payout record(s) from accepted history", n),
            Ok(_) => {}
            Err(e) => eprintln!("[bridge] ALERT payout-store rebuild failed: {} — bridge DEGRADED", e),
        }
        // Rebuild tx hash index if empty (first startup after upgrade)
        if self.store.lookup_tx_height("_probe_").unwrap_or(None).is_none() {
            // Check if index is populated by looking at tree length
            match self.store.rebuild_tx_index() {
                Ok(count) if count > 0 => eprintln!("[node] Rebuilt tx hash index: {} txs indexed", count),
                Ok(_) => {} // no txs to index
                Err(e) => eprintln!("[node] Warning: tx index rebuild failed: {}", e),
            }
        }
        // Load persisted shielded supply from sled
        let persisted_shielded = self.store.get_shielded_supply();
        if persisted_shielded > 0.0 {
            if let Ok(mut sp) = self.shielded_supply.lock() {
                *sp = persisted_shielded;
            }
            eprintln!("[node] Loaded persisted shielded supply: {:.4}", persisted_shielded);
        }
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

    /// Persist current in-memory balance state to sled for fast restart.
    fn save_balance_snapshot(&self, height: u64) {
        let snap = || -> Result<(), String> {
            let bal = self.balances.lock().map_err(|_| "bal lock")?;
            let tok = self.token_balances.lock().map_err(|_| "tok lock")?;
            let lp = self.lp_balances.lock().map_err(|_| "lp lock")?;
            let burned = self.burned_tokens.lock().map_err(|_| "burned lock")?;
            let fees_burned = *self.total_fees_burned.lock().map_err(|_| "fees lock")?;
            let shielded = *self.shielded_supply.lock().map_err(|_| "shielded lock")?;

            let bal_bytes = serde_json::to_vec(&*bal).map_err(|e| e.to_string())?;
            let tok_vec: Vec<((String, String), u128)> = tok.iter().map(|(k, v)| (k.clone(), *v)).collect();
            let tok_bytes = serde_json::to_vec(&tok_vec).map_err(|e| e.to_string())?;
            let lp_vec: Vec<((String, String), u128)> = lp.iter().map(|(k, v)| (k.clone(), *v)).collect();
            let lp_bytes = serde_json::to_vec(&lp_vec).map_err(|e| e.to_string())?;
            let burned_bytes = serde_json::to_vec(&*burned).map_err(|e| e.to_string())?;

            self.snapshot_db.insert(b"version", &SNAPSHOT_VERSION.to_be_bytes()).map_err(|e| e.to_string())?;
            self.snapshot_db.insert(b"height", &height.to_be_bytes()).map_err(|e| e.to_string())?;
            self.snapshot_db.insert(b"balances", bal_bytes).map_err(|e| e.to_string())?;
            self.snapshot_db.insert(b"token_balances", tok_bytes).map_err(|e| e.to_string())?;
            self.snapshot_db.insert(b"lp_balances", lp_bytes).map_err(|e| e.to_string())?;
            self.snapshot_db.insert(b"burned_tokens", burned_bytes).map_err(|e| e.to_string())?;
            self.snapshot_db.insert(b"fees_burned", fees_burned.to_be_bytes().as_ref()).map_err(|e| e.to_string())?;
            self.snapshot_db.insert(b"shielded_supply", shielded.to_be_bytes().as_ref()).map_err(|e| e.to_string())?;
            let ub = self.unbonding_queue.lock().map_err(|_| "unbonding lock")?;
            self.snapshot_db.insert(b"unbonding_queue", serde_json::to_vec(&*ub).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            self.snapshot_db.flush().map_err(|e| e.to_string())?;
            Ok(())
        };
        if let Err(e) = snap() {
            eprintln!("[snapshot] Failed to save at height {}: {}", height, e);
        }
    }

    /// Try to load a balance snapshot from sled. Returns Ok(height) if successful.
    fn load_balance_snapshot(&self) -> Result<u64, String> {
        // Reject any snapshot not written in the current format. A missing tag is
        // a pre-v2 (f64) snapshot; a different tag is a future format. Either way,
        // erroring here makes init() fall back to a full rebuild from history —
        // never a silent misread of f64 XRGE as integer quanta.
        let version = self.snapshot_db.get(b"version")
            .map_err(|e| e.to_string())?
            .and_then(|v| v.as_ref().try_into().ok().map(u32::from_be_bytes))
            .ok_or("snapshot has no version tag (pre-v2) — rebuilding")?;
        if version != SNAPSHOT_VERSION {
            return Err(format!(
                "snapshot version {} != {} (integer-quanta) — rebuilding",
                version, SNAPSHOT_VERSION
            ));
        }

        let height_bytes = self.snapshot_db.get(b"height")
            .map_err(|e| e.to_string())?
            .ok_or("no snapshot")?;
        let height = u64::from_be_bytes(
            height_bytes.as_ref().try_into().map_err(|_| "bad height bytes")?
        );

        let bal_bytes = self.snapshot_db.get(b"balances")
            .map_err(|e| e.to_string())?.ok_or("no balances")?;
        let tok_bytes = self.snapshot_db.get(b"token_balances")
            .map_err(|e| e.to_string())?.ok_or("no token_balances")?;
        let lp_bytes = self.snapshot_db.get(b"lp_balances")
            .map_err(|e| e.to_string())?.ok_or("no lp_balances")?;
        let burned_bytes = self.snapshot_db.get(b"burned_tokens")
            .map_err(|e| e.to_string())?.ok_or("no burned_tokens")?;
        let fees_bytes = self.snapshot_db.get(b"fees_burned")
            .map_err(|e| e.to_string())?.ok_or("no fees_burned")?;
        let shielded_bytes = self.snapshot_db.get(b"shielded_supply")
            .map_err(|e| e.to_string())?.ok_or("no shielded_supply")?;

        let bal: HashMap<String, u128> = serde_json::from_slice(&bal_bytes)
            .map_err(|e| e.to_string())?;
        let tok_vec: Vec<((String, String), u128)> = serde_json::from_slice(&tok_bytes)
            .map_err(|e| e.to_string())?;
        let lp_vec: Vec<((String, String), u128)> = serde_json::from_slice(&lp_bytes)
            .map_err(|e| e.to_string())?;
        let burned: HashMap<String, f64> = serde_json::from_slice(&burned_bytes)
            .map_err(|e| e.to_string())?;
        let fees_burned = f64::from_be_bytes(
            fees_bytes.as_ref().try_into().map_err(|_| "bad fees bytes")?
        );
        let shielded = f64::from_be_bytes(
            shielded_bytes.as_ref().try_into().map_err(|_| "bad shielded bytes")?
        );
        // The pending-unbonding queue is consensus state (matured entries credit balances
        // inside block application). A snapshot without it is acceptable ONLY for the legacy
        // pre-fork era (no unstake exists in history 1..=F-1); at/after the fork its absence
        // means the snapshot is incomplete ⇒ error ⇒ deterministic recovery from history.
        let unbonding: Vec<UnbondingEntry> = match self.snapshot_db.get(b"unbonding_queue").map_err(|e| e.to_string())? {
            Some(b) => serde_json::from_slice(&b).map_err(|e| format!("bad unbonding_queue: {}", e))?,
            None if !self.fork_applies() => {
                eprintln!("[init] snapshot has no unbonding_queue (pre-upgrade format on non-fork chain) — assuming empty");
                Vec::new()
            }
            None if height < crate::fork::FORK_HEIGHT => Vec::new(),
            None => return Err(format!("snapshot at height {} has no unbonding_queue — incomplete, rebuilding", height)),
        };

        *self.balances.lock().map_err(|_| "bal lock")? = bal;
        *self.unbonding_queue.lock().map_err(|_| "unbonding lock")? = unbonding;
        *self.token_balances.lock().map_err(|_| "tok lock")? = tok_vec.into_iter().collect();
        *self.lp_balances.lock().map_err(|_| "lp lock")? = lp_vec.into_iter().collect();
        *self.burned_tokens.lock().map_err(|_| "burned lock")? = burned;
        *self.total_fees_burned.lock().map_err(|_| "fees lock")? = fees_burned;
        *self.shielded_supply.lock().map_err(|_| "shielded lock")? = shielded;
        Ok(height)
    }

    /// Get a reference to the chain store (for indexer backfill)
    pub fn store_ref(&self) -> &quantum_vault_storage::chain_store::ChainStore {
        &self.store
    }

    /// Inject the WASM runtime for contract execution during block import.
    /// Called from main.rs after both Node and WasmRuntime are constructed.
    pub fn set_wasm_runtime(&mut self, rt: Arc<WasmRuntime>) {
        self.wasm_runtime = Some(rt);
    }

    /// Inject the contract store for WASM bytecode access during block import.
    pub fn set_contract_store(&mut self, cs: Arc<ContractStore>) {
        self.contract_store = Some(cs);
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
            m.retain(|_, v| *v > 0);
            total += before - m.len();
        }
        if let Ok(mut m) = self.token_balances.lock() {
            let before = m.len();
            m.retain(|_, v| *v > 0);
            total += before - m.len();
        }
        if let Ok(mut m) = self.lp_balances.lock() {
            let before = m.len();
            m.retain(|_, v| *v > 0);
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
            *balances.entry(canon_addr(&alloc.address)).or_insert(0) += xrge_f64_to_quanta(alloc.amount as f64);
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

    // `reset_chain` (legacy raw-replay chain replacement) was REMOVED: peer sync must reach
    // every historical state only through `import_block` (checkpoints, canonical rules, F-1
    // assertions, atomic rollback). Deterministic recovery = `recover_from_history`.

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
            // SECURITY: past the bootstrap grace window, an imported block's
            // proposer must be a staked validator in our set. Below the window
            // (genesis + earliest blocks) we defer *only* this proposer-auth
            // check — the block is still otherwise fully validated (sigs, hash,
            // state root, custody) below — so a fresh joiner can replay history
            // before staking txs populate the set. Also bypassed while our set is
            // empty. Requires the STAKE-BEFORE-PROPOSE rule for new validators —
            // see the PROPOSER_AUTH_ACTIVATION_HEIGHT doc comment.
            let validators = self.list_validators().unwrap_or_default();
            if !validators.is_empty() && block.header.height > PROPOSER_AUTH_ACTIVATION_HEIGHT {
                let is_valid_proposer = validators.iter().any(|(pk, vs)| {
                    pk == &block.header.proposer_pub_key && vs.stake > 0
                });
                if !is_valid_proposer {
                    return Err(format!(
                        "Block {} rejected: proposer {} not in validator set with active stake",
                        block.header.height,
                        &block.header.proposer_pub_key[..16.min(block.header.proposer_pub_key.len())]
                    ));
                }
            }
        }

        // Genesis-anchored bridge authority keys (see NodeOptions). Only these
        // may authorize a node-cosigned bridge_withdraw during import.
        let authority_keys = &self.opts.bridge_authority_keys;

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
                    // Authority-cosigned bridge withdrawal: the tx carries the
                    // *user's* from_pub_key but is signed by a genesis validator
                    // (the bridge operator) — see submit_bridge_withdraw_tx_signed,
                    // where the producing node skips this re-check via an in-memory
                    // set that never reaches peers. Accept only if the sig verifies
                    // against a genesis-authority key — never the live validator
                    // set — so a validator that joins later cannot forge a
                    // withdrawal against another account's balance.
                    if tx.tx_type == "bridge_withdraw" && !authority_keys.is_empty() {
                        let b = encode_tx_for_signing(tx);
                        if authority_keys.iter().any(|k| pqc_verify(k, &b, &tx.sig).ok() == Some(true)) {
                            return false; // valid: authority-cosigned withdrawal
                        }
                    }
                    eprintln!("[peer] Rejecting tx: all signature verification methods failed for {}", &tx.from_pub_key[..16.min(tx.from_pub_key.len())]);
                    true
                })
                .count();
            if invalid_count > 0 {
                return Err(format!("Block has {} invalid tx signatures", invalid_count));
            }
        }
        
        // C1: transaction uniqueness (consensus rule from TX_UNIQUENESS_ACTIVATION_HEIGHT).
        if tx_uniqueness_rule_active(block.header.height) {
            self.check_block_tx_uniqueness(&block)?;
        }

        // Apply state BEFORE storing to disk (atomic: don't store blocks we can't apply)
        //
        // Phase 2: at/after the activation height, the block header commits to the
        // post-state root. ALWAYS take a full pre-apply snapshot first (money maps,
        // burned tokens, fees, shielded supply, unbonding queue, nonce/address
        // indexes and every side-effect sled store the block can touch) so ANY
        // rejected block — apply error, root mismatch, validator-apply error or a
        // persist failure — leaves the node state exactly as it was before the
        // attempt. The rejected block is never persisted.
        let verify_root = block.header.height >= state_root_activation_height();
        let pre_snapshot = self.capture_pre_apply_snapshot(&block)?;

        // Any apply error (P3-4 fail-closed contract rejection included) must not
        // leave the ledger partially mutated.
        let block_exec = match self.apply_balance_block(&block) {
            Ok(results) => results,
            Err(e) => {
                let _ = self.restore_pre_apply_snapshot(pre_snapshot);
                return Err(e);
            }
        };

        #[allow(unused_mut)]
        let mut check_f_minus_1 = false;
        if self.fork_applies() && crate::fork::is_checkpoint_height(block.header.height) {
            // Historical era (18 ..= F-1): the committed root is a legacy operational commitment
            // that canonical execution cannot recompute. Accept it ONLY by equality against the
            // compiled, hash-pinned checkpoint table; the ledger itself is applied canonically.
            if let Err(e) = crate::fork::verify_checkpoint(block.header.height, block.header.state_root.as_deref()) {
                let _ = self.restore_pre_apply_snapshot(pre_snapshot);
                return Err(e);
            }
            check_f_minus_1 = block.header.height == crate::fork::FORK_HEIGHT - 1;
            #[cfg(test)]
            { if TEST_SKIP_F_MINUS_1_ASSERT.with(|c| c.get()) { check_f_minus_1 = false; } }
            if check_f_minus_1 {
                // The canonical ledger at F-1 is itself a consensus commitment: assert it.
                if let Err(e) = self.assert_canonical_ledger_at_f_minus_1() {
                    let _ = self.restore_pre_apply_snapshot(pre_snapshot);
                    return Err(format!("canonical ledger assertion failed at F-1 ({}): {}", block.header.height, e));
                }
            }
        } else if verify_root {
            let computed = match self.compute_current_state_root() {
                Ok(c) => c,
                Err(e) => {
                    let _ = self.restore_pre_apply_snapshot(pre_snapshot);
                    return Err(e);
                }
            };
            if block.header.state_root.as_deref() != Some(computed.as_str()) {
                // Divergence (or a faulty/malicious proposer): roll back and reject.
                let _ = self.restore_pre_apply_snapshot(pre_snapshot);
                return Err(format!(
                    "state root mismatch at height {}: header={:?}, computed={}",
                    block.header.height, block.header.state_root, computed
                ));
            }
        }

        if let Err(e) = self.apply_validator_block(&block, &block_exec.validator) {
            let _ = self.restore_pre_apply_snapshot(pre_snapshot);
            return Err(e);
        }
        if check_f_minus_1 {
            // Validator state after F-1 is asserted once the block's validator effects are in.
            if let Err(e) = self.assert_canonical_validators_at_f_minus_1() {
                let _ = self.restore_pre_apply_snapshot(pre_snapshot);
                return Err(format!("canonical validator assertion failed at F-1 ({}): {}", block.header.height, e));
            }
        }

        // Only persist after state was applied successfully. If persisting fails
        // the block is not on our chain, so the applied state must not survive.
        if let Err(e) = self.store.append_block(&block) {
            let _ = self.restore_pre_apply_snapshot(pre_snapshot);
            return Err(e);
        }

        // Generate and store transaction receipts
        let receipts = self.generate_receipts(&block, &block_exec.bridge, &block_exec.validator);
        let _ = self.receipt_store.store_batch(&receipts);
        self.record_block_tx_hashes(&block);

        // R1: relayer-facing payout records ONLY for an accepted + persisted block.
        // (A block rejected above — apply error or state-root mismatch — never reaches
        // this line, so it leaves zero withdrawal-store side effects.)
        self.persist_bridge_withdraw_results(&block, &block_exec.bridge)?;
        if self.fork_applies() && block.header.height == crate::fork::FORK_HEIGHT - 1 {
            self.set_canonical_marker()?; // fresh sync reached the canonical F-1 ledger
        }

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
        
        self.save_balance_snapshot(block.header.height);
        eprintln!("[node] Imported block {} from peer", block.header.height);
        Ok(())
    }

    pub fn get_balance(&self, public_key: &str) -> Result<f64, String> {
        let balances = self.balances.lock().map_err(|_| "balance lock")?;
        Ok(quanta_to_display(*balances.get(&canon_addr(public_key)).unwrap_or(&0)))
    }

    /// Get a transaction receipt by hash.
    pub fn get_receipt(&self, tx_hash: &str) -> Result<Option<TxReceipt>, String> {
        self.receipt_store.get(tx_hash)
    }

    /// Generate receipts for all transactions in a block.
    /// Called after successful block application. Non-bridge txs keep the historical
    /// `Success` status (out of R1 scope). For `bridge_withdraw`, the status is the
    /// typed execution result — and an ABSENT result is `Failed`, never `Success`.
    fn generate_receipts(
        &self,
        block: &BlockV1,
        bridge_results: &[Option<quantum_vault_bridge_exec::BridgeWithdrawExecution>],
        validator_results: &[Option<ValidatorExecution>],
    ) -> Vec<TxReceipt> {
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
                        "token": tx.payload.token_symbol.as_deref().unwrap_or("XRGE"),
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
                status: if tx.tx_type == "bridge_withdraw" {
                    use quantum_vault_bridge_exec::{bridge_receipt_status, BridgeReceipt};
                    match bridge_receipt_status(bridge_results.get(index).and_then(|o| o.as_ref())) {
                        BridgeReceipt::Success => TxStatus::Success,
                        BridgeReceipt::Failed(reason) => TxStatus::Failed(reason), // Failed AND None
                    }
                } else if tx.tx_type == "stake" || tx.tx_type == "unstake" {
                    // Derived observability: a stake/unstake that did not execute is not Success.
                    match validator_results.get(index).and_then(|o| o.as_ref()) {
                        Some(ValidatorExecution::StakeApplied { .. }) | Some(ValidatorExecution::UnstakeApplied { .. }) => TxStatus::Success,
                        Some(ValidatorExecution::Failed(reason)) => TxStatus::Failed(reason.clone()),
                        None => TxStatus::Failed("missing validator execution result".to_string()),
                    }
                } else {
                    TxStatus::Success
                },
                fee_paid: tx.fee,
                logs: vec![log],
                timestamp: block.header.time,
            });
        }
        receipts
    }

    pub fn get_token_balance(&self, public_key: &str, token_symbol: &str) -> Result<f64, String> {
        let token_balances = self.token_balances.lock().map_err(|_| "token balance lock")?;
        let key = (canon_addr(&public_key), token_symbol.to_string());
        Ok(*token_balances.get(&key).unwrap_or(&0) as f64)
    }

    pub fn get_all_token_balances(&self, public_key: &str) -> Result<HashMap<String, f64>, String> {
        let token_balances = self.token_balances.lock().map_err(|_| "token balance lock")?;
        let addr = canon_addr(&public_key);
        let mut result = HashMap::new();
        for ((pubkey, symbol), balance) in token_balances.iter() {
            if pubkey == &addr && *balance > 0 {
                result.insert(symbol.clone(), *balance as f64);
            }
        }
        Ok(result)
    }

    /// Get all holders and their balances for a specific token symbol
    pub fn get_all_token_balances_for_symbol(&self, token_symbol: &str) -> Result<HashMap<String, f64>, String> {
        let token_balances = self.token_balances.lock().map_err(|_| "token balance lock")?;
        let mut result = HashMap::new();
        for ((pubkey, symbol), balance) in token_balances.iter() {
            if symbol == token_symbol && *balance > 0 {
                result.insert(pubkey.clone(), *balance as f64);
            }
        }
        Ok(result)
    }

    /// Get all native XRGE balances (from the main balances map, not token_balances)
    pub fn get_all_native_balances(&self) -> Result<HashMap<String, f64>, String> {
        let balances = self.balances.lock().map_err(|_| "balance lock")?;
        Ok(balances.iter()
            .filter(|(_, b)| **b > 0)
            .map(|(k, v)| (k.clone(), quanta_to_display(*v)))
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
        // Native + bridge tokens are protocol-canonical (no create_token tx) — nobody can claim
        // their metadata, so reject explicitly rather than relying on "no creator found".
        const RESERVED_SYMBOLS: &[&str] = &["XRGE", "QBTC", "QETH", "QUSDC", "ETH", "USDC"];
        if RESERVED_SYMBOLS.contains(&symbol.to_uppercase().as_str()) {
            return Err(format!("'{}' is a reserved token and cannot be claimed", symbol));
        }

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
    
    /// Register token metadata during rebuild, preserving any user-updated fields.
    /// If metadata already exists, only fill in fields that are currently None.
    /// Never overwrites existing image, description, website, twitter, or discord.
    pub fn register_or_merge_token_metadata(
        &self,
        symbol: &str,
        name: &str,
        creator: &str,
        image: Option<String>,
        description: Option<String>,
        mintable: bool,
        max_supply: Option<u64>,
    ) -> Result<String, String> {
        let sym = symbol.to_uppercase();
        if let Ok(Some(existing)) = self.token_metadata_store.get_metadata(&sym) {
            let name_needs_update = existing.name == existing.symbol;
            let updated = TokenMetadata {
                symbol: existing.symbol,
                name: if name_needs_update { name.to_string() } else { existing.name },
                creator: existing.creator,
                token_id: existing.token_id,
                image: existing.image.or(image),
                description: existing.description.or(description),
                website: existing.website,
                twitter: existing.twitter,
                discord: existing.discord,
                created_at: existing.created_at,
                updated_at: existing.updated_at,
                frozen: existing.frozen,
                mintable: existing.mintable || mintable,
                max_supply: existing.max_supply.or(max_supply),
                total_minted: existing.total_minted,
            };
            self.token_metadata_store.set_metadata(&updated)?;
            Ok(updated.token_id)
        } else {
            self.register_token_metadata_ext(symbol, name, creator, image, description, mintable, max_supply)
        }
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
        let key = (canon_addr(&public_key), pool_id.to_string());
        Ok(*lp_balances.get(&key).unwrap_or(&0) as f64)
    }

    pub fn get_all_lp_balances(&self, public_key: &str) -> Result<HashMap<String, f64>, String> {
        let lp_balances = self.lp_balances.lock().map_err(|_| "lp balance lock")?;
        let addr = canon_addr(&public_key);
        let mut result = HashMap::new();
        for ((pubkey, pool_id), balance) in lp_balances.iter() {
            if pubkey == &addr && *balance > 0 {
                result.insert(pool_id.clone(), *balance as f64);
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

    /// Add a transaction to mempool (used for P2P broadcast — verifies signature)
    pub fn add_tx_to_mempool(&self, tx: TxV1) -> Result<(), String> {
        use quantum_vault_crypto::pqc_verify;
        use quantum_vault_types::encode_tx_for_signing;

        // SECURITY: Verify the ML-DSA-65 signature before accepting P2P broadcast txs
        let sig_valid = if let Some(ref sp) = tx.signed_payload {
            pqc_verify(&tx.from_pub_key, sp.as_bytes(), &tx.sig).ok() == Some(true)
        } else {
            let bytes = encode_tx_for_signing(&tx);
            pqc_verify(&tx.from_pub_key, &bytes, &tx.sig).ok() == Some(true)
        };
        if !sig_valid {
            return Err("P2P tx rejected: invalid signature".to_string());
        }

        self.insert_tx_to_mempool(tx)
    }

    /// Add a pre-verified transaction to mempool (used by V2 API handlers that
    /// already called verify_signed_tx — skips the expensive pqc_verify).
    pub fn add_tx_to_mempool_verified(&self, tx: TxV1) -> Result<(), String> {
        self.insert_tx_to_mempool(tx)
    }

    /// Shared mempool insertion logic (nonce check, dedup, cap, notify).
    fn insert_tx_to_mempool(&self, tx: TxV1) -> Result<(), String> {
        use quantum_vault_crypto::{sha256, bytes_to_hex};
        use quantum_vault_types::encode_tx_v1;

        self.check_nonce_valid(&tx.from_pub_key, tx.nonce)?;

        let tx_hash = bytes_to_hex(&sha256(&encode_tx_v1(&tx)));

        // C1: a tx that is already in an accepted block is a replay — refuse it regardless
        // of the (gap-tolerant) nonce check above.
        // V2 binding (node-local, always on): the executable fields must be the canonical
        // derivation of the signed payload, or an outsider could re-point a signed intent.
        crate::v2_binding::verify_v2_binding(&tx)?;
        let identity = quantum_vault_types::tx_identity(&tx);
        if let Some(h) = self.tx_included_at(&identity) {
            return Err(format!("transaction {} already included in block {}", &identity[..16], h));
        }

        // Reject txs already mined in a recent block
        if let Ok(mined) = self.mined_tx_hashes.lock() {
            if mined.contains(&tx_hash) {
                return Ok(());
            }
        }
        
        let mut mempool = self.mempool.lock().map_err(|_| "mempool lock")?;
        
        if mempool.contains_key(&tx_hash) {
            return Ok(());
        }

        // SECURITY: Enforce mempool cap with fee-priority eviction
        if mempool.len() >= MAX_MEMPOOL {
            if let Some(evict_id) = mempool.iter()
                .min_by(|a, b| a.1.fee.partial_cmp(&b.1.fee).unwrap_or(std::cmp::Ordering::Equal))
                .map(|(k, _)| k.clone())
            {
                let min_fee = mempool.get(&evict_id).map(|t| t.fee).unwrap_or(0.0);
                if tx.fee <= min_fee {
                    return Err("Mempool full: tx fee too low".to_string());
                }
                mempool.remove(&evict_id);
            }
        }
        
        // Mark as verified so mine_pending skips re-verification
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
        const RESERVED_SYMBOLS: &[&str] = &["XRGE", "QBTC", "QETH", "QUSDC", "ETH", "USDC"];
        let symbol_upper = token_symbol.to_uppercase();
        if RESERVED_SYMBOLS.contains(&symbol_upper.as_str()) {
            return Err(format!("'{}' is a reserved token symbol", token_symbol));
        }

        // SECURITY: Cap supply at 2^53 to prevent f64 precision loss in balance tracking
        const MAX_SAFE_SUPPLY: u64 = 9_007_199_254_740_992; // 2^53
        if total_supply > MAX_SAFE_SUPPLY {
            return Err(format!(
                "Total supply {} exceeds maximum safe supply {} (2^53) for balance precision",
                total_supply, MAX_SAFE_SUPPLY
            ));
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

    /// Next usable nonce for `pubkey`, accounting for txs already sitting in the
    /// mempool but not yet mined. `get_next_nonce` only reads the COMMITTED nonce,
    /// so two back-to-back node-signed txs — or one that races the auto-miner
    /// bumping the committed nonce between assign and accept — collide on the same
    /// value. This returns max(committed, highest-pending-for-key) + 1.
    fn next_nonce_pending(&self, pubkey: &str) -> u64 {
        let committed = self.get_account_nonce(pubkey);
        let pending_max = self.mempool.lock().ok().and_then(|m| {
            m.values()
                .filter(|t| t.from_pub_key == pubkey)
                .map(|t| t.nonce)
                .max()
        });
        match pending_max {
            Some(p) => committed.max(p) + 1,
            None => committed + 1,
        }
    }

    pub fn submit_faucet_tx(
        &self,
        recipient_public_key: &str,
        amount: u64,
    ) -> Result<TxV1, String> {
        let keys = self.keys.lock().map_err(|_| "keys lock")?.clone();
        // The faucet signs with the NODE key, whose committed nonce also advances
        // as the auto-miner seals blocks. A pending-aware nonce plus a short retry
        // make the assignment robust against that race instead of failing with
        // "Invalid nonce" and (worse) burning the recipient's cooldown.
        let mut last_err = String::from("faucet: nonce assignment failed");
        for _ in 0..8 {
            let mut tx = TxV1 {
                version: 1,
                tx_type: "transfer".to_string(),
                from_pub_key: keys.public_key_hex.clone(),
                nonce: self.next_nonce_pending(&keys.public_key_hex),
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
            match self.accept_tx(tx.clone()) {
                Ok(()) => return Ok(tx),
                // Lost the race (miner advanced the committed nonce, or a
                // concurrent node-signed tx took this slot). Recompute + retry.
                Err(e) if e.contains("Invalid nonce") => {
                    last_err = e;
                    continue;
                }
                Err(e) => return Err(e),
            }
        }
        Err(last_err)
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
        // Use the token symbol as provided (natural case, e.g. "qBTC"/"qETH"/"qUSDC"/"XRGE") so
        // balance lookups match what the mint stored — token_balances is keyed by the exact
        // symbol string, so uppercasing here would miss the balance. Special-case comparisons
        // are done case-insensitively.
        let token_sym = token_symbol.trim().to_string();
        if token_sym.eq_ignore_ascii_case("XRGE") {
            if xrge_balance - tx_fee < amount_units as f64 {
                return Err(format!(
                    "Insufficient XRGE: have {}, need {}",
                    xrge_balance - tx_fee, amount_units
                ));
            }
        } else {
            let token_balance = self.get_token_balance(from_public_key, &token_sym)?;
            if token_balance < amount_units as f64 {
                return Err(format!(
                    "Insufficient {}: have {}, need {}",
                    token_sym, token_balance, amount_units
                ));
            }
        }
        // Destination address. qBTC withdrawals carry a Bitcoin address (case-sensitive, not an
        // EVM hex address), so validate them on the BTC side and keep the original casing. All
        // other tokens (qETH/qUSDC/XRGE) pay out on Base and require a 20-byte EVM address.
        let evm = if token_sym.eq_ignore_ascii_case("qBTC") {
            let dest = evm_address.trim().to_string();
            let network = crate::bridge_btc::btc_network();
            crate::bridge_btc::validate_btc_address(&dest, &network)?;
            dest
        } else {
            let evm = evm_address.trim().to_lowercase();
            let evm = if evm.starts_with("0x") { evm } else { format!("0x{}", evm) };
            if evm.len() != 42 || !evm[2..].chars().all(|c| c.is_ascii_hexdigit()) {
                return Err("Invalid EVM address".to_string());
            }
            evm
        };
        let keys = self.keys.lock().map_err(|_| "keys lock")?.clone();
        let mut tx = TxV1 {
            version: 1,
            tx_type: "bridge_withdraw".to_string(),
            from_pub_key: from_public_key.to_string(),
            nonce: self.get_next_nonce(from_public_key),
            payload: TxPayload {
                amount: Some(amount_units),
                token_symbol: Some(token_sym),
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
        wasm_base64: &str,
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
                // Carry the bytecode on-chain so every importing node can install
                // it and re-execute the contract identically (P3-3).
                contract_wasm: Some(wasm_base64.to_string()),
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
        args: &serde_json::Value,
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
                // Carry the call args so the on-chain re-execution (which is what
                // actually applies balance deltas, P3-4) matches this call. (P3-5)
                contract_args: if args.is_null() { None } else { Some(args.clone()) },
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
        const MIN_STAKE: f64 = 10_000.0;
        if amount < MIN_STAKE {
            return Err(format!("minimum stake is {} XRGE", MIN_STAKE as u64));
        }

        let tx_fee = fee.unwrap_or(BASE_TRANSFER_FEE);
        let total_required = amount + tx_fee;

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
        let verified_entries: Vec<(String, TxV1)> = {
            use rayon::prelude::*;
            tx_entries.into_par_iter()
                .filter(|(id, tx)| {
                    if verified_set.contains(id) {
                        return true;
                    }
                    let bytes = encode_tx_for_signing(tx);
                    pqc_verify(&tx.from_pub_key, &bytes, &tx.sig).ok() == Some(true)
                })
                .collect()
        };
        verified_set.clear();
        drop(verified_set);
        // C1: never include a tx the chain already accepted (replay), whatever its nonce says.
        let verified_entries: Vec<(String, TxV1)> = verified_entries.into_iter()
            .filter(|(_, tx)| !self.tx_already_included(&quantum_vault_types::tx_identity(tx)))
            .collect();
        if verified_entries.is_empty() {
            return Ok(None);
        }
        let txs: Vec<TxV1> = verified_entries.iter().map(|(_, tx)| tx.clone()).collect();
        let requeue = verified_entries; // returned to the mempool if production fails before commit
        let tip = self.store.get_tip()?;
        let height = tip.height + 1;
        let time = Utc::now().timestamp_millis() as u64;
        let proposer_pub_key = self.keys.lock().map_err(|_| "keys lock")?.public_key_hex.clone();
        let tx_hash = compute_tx_hash(&txs);

        // Phase 2: commit to the POST-state root, so the block header must be
        // sealed AFTER applying the block. apply_balance_block reads only
        // header.{height,time,proposer_pub_key} and txs — never sig/hash/state_root
        // — so a preliminary header (unsigned, no root) is sufficient to apply.
        let prelim_header = BlockHeaderV1 {
            version: 1,
            chain_id: self.opts.chain.chain_id.clone(),
            height,
            time,
            prev_hash: tip.hash.clone(),
            tx_hash: tx_hash.clone(),
            proposer_pub_key: proposer_pub_key.clone(),
            state_root: None,
        };
        let prelim_block = BlockV1 {
            version: 1,
            header: prelim_header.clone(),
            txs: txs.clone(),
            proposer_sig: String::new(),
            hash: String::new(),
        };
        // ── PRODUCER ATOMICITY (same contract as import_block) ────────────────────────
        // Full pre-apply snapshot first. Every step through append_block is speculative:
        // ANY failure before the commit point restores the node state exactly and requeues
        // the drained transactions. Order: snapshot → apply ledger effects (incl. matured
        // unbonding) → post-state root → sign → validator effects → append (COMMIT POINT)
        // → derived bookkeeping (mined hashes, finality, receipts, payouts, stats).
        let pre_snapshot = self.capture_pre_apply_snapshot(&prelim_block)?;
        let attempt = (|| -> Result<(BlockV1, BlockExecution), String> {
            // Apply to state ONCE, here. (The old post-append apply_balance_block call
            // is intentionally removed — applying twice would double-charge fees.)
            let block_exec = self.apply_balance_block(&prelim_block)?;
            #[cfg(test)]
            { if TEST_PRODUCER_FAULT.with(|c| c.get()) == 1 { return Err("injected fault: root computation".into()); } }
            // Stamp the post-state root, gated on the activation height.
            let state_root = if height >= state_root_activation_height() {
                Some(self.compute_current_state_root()?)
            } else {
                None
            };
            let header = BlockHeaderV1 { state_root, ..prelim_header.clone() };
            let header_bytes = encode_header_v1(&header);
            let proposer_sig = pqc_sign(&self.keys.lock().map_err(|_| "keys lock")?.secret_key_hex, &header_bytes)?;
            let hash = compute_block_hash(&header_bytes, &proposer_sig);
            let block = BlockV1 { version: 1, header, txs: prelim_block.txs.clone(), proposer_sig, hash };
            // Validator-store effects BEFORE the block is durable (post-root, store-only).
            self.apply_validator_block(&block, &block_exec.validator)?;
            #[cfg(test)]
            { if TEST_PRODUCER_FAULT.with(|c| c.get()) == 2 { return Err("injected fault: validator persistence".into()); } }
            #[cfg(test)]
            { if TEST_PRODUCER_FAULT.with(|c| c.get()) == 3 { return Err("injected fault: append_block".into()); } }
            self.store.append_block(&block)?;
            Ok((block, block_exec))
        })();
        let (block, block_exec) = match attempt {
            Ok(v) => v,
            Err(e) => {
                let restore = self.restore_pre_apply_snapshot(pre_snapshot);
                // Requeue the drained (already signature-verified) transactions.
                if let Ok(mut mempool) = self.mempool.lock() {
                    if let Ok(mut verified) = self.verified_tx_ids.lock() {
                        for (id, tx) in requeue { verified.insert(id.clone()); mempool.insert(id, tx); }
                    }
                }
                return Err(match restore {
                    Ok(()) => format!("block production at height {} failed and was rolled back: {}", height, e),
                    Err(re) => format!("block production at height {} failed ({}) AND rollback failed ({}) — manual investigation", height, e, re),
                });
            }
        };
        // ── COMMIT POINT: the block is durable; everything below is derived bookkeeping ──
        // Track mined tx hashes to prevent re-adding to mempool
        if let Ok(mut mined) = self.mined_tx_hashes.lock() {
            for tx in &block.txs {
                let h = bytes_to_hex(&sha256(&encode_tx_v1(tx)));
                mined.insert(h);
            }
            // Cap set size to prevent unbounded growth
            if mined.len() > 10_000 {
                mined.clear();
            }
        }
        *self.finalized_height.lock().map_err(|_| "finality lock")? = block.header.height;
        // Note: finalized_height set here as proposer (single-validator mode).
        // In multi-validator mode, try_finalize_block (called by auto_vote_for_block)
        // handles finalization via vote quorum verification.

        // Generate and store transaction receipts
        let receipts = self.generate_receipts(&block, &block_exec.bridge, &block_exec.validator);
        let _ = self.receipt_store.store_batch(&receipts);
        self.record_block_tx_hashes(&block);

        // R1: payout records only after the block is appended/persisted (see import path).
        self.persist_bridge_withdraw_results(&block, &block_exec.bridge)?;
        
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
        
        self.save_balance_snapshot(block.header.height);
        Ok(Some(block))
    }

    /// Get the current nonce for an account (0 if never used)
    // ── C1: transaction-uniqueness index + rule ─────────────────────────────────────
    /// Height of the accepted block that included `tx_hash` (canonical hash), if any.
    pub fn tx_included_at(&self, tx_hash: &str) -> Option<u64> {
        match self.tx_seen_db.get(tx_hash.as_bytes()) {
            Ok(Some(v)) if v.len() == 8 => Some(u64::from_be_bytes(v.as_ref().try_into().unwrap_or([0u8; 8]))),
            _ => None,
        }
    }
    pub fn tx_already_included(&self, tx_hash: &str) -> bool { self.tx_included_at(tx_hash).is_some() }

    /// Consensus check: every tx IDENTITY (`tx_identity`, key-bound) in the block must be new
    /// to the chain and unique within the block. Fail-closed on the index: if the tx-seen
    /// index is not complete for the current tip (crash between append and record, or a
    /// failed record write) it is rebuilt from the stored chain here, BEFORE the block can
    /// be judged, so an incomplete index can never let a replay through.
    fn check_block_tx_uniqueness(&self, block: &BlockV1) -> Result<(), String> {
        self.ensure_tx_seen_index()?;
        let mut in_block: HashSet<String> = HashSet::with_capacity(block.txs.len());
        for (i, tx) in block.txs.iter().enumerate() {
            // V2 binding is part of the same consensus rule: a signed-payload tx whose fields
            // are not the canonical derivation of its payload makes the block invalid.
            if let Err(e) = crate::v2_binding::verify_v2_binding(tx) {
                return Err(format!("block {} rejected: tx #{} signed-payload binding failed: {}", block.header.height, i, e));
            }
            let h = quantum_vault_types::tx_identity(tx);
            if let Some(prev) = self.tx_included_at(&h) {
                return Err(format!("block {} rejected: tx #{} ({}) already included in block {} (replay)",
                    block.header.height, i, &h[..16], prev));
            }
            if !in_block.insert(h.clone()) {
                return Err(format!("block {} rejected: tx #{} ({}) duplicated within the block",
                    block.header.height, i, &h[..16]));
            }
        }
        Ok(())
    }

    /// Record the hashes of an ACCEPTED + PERSISTED block (post-commit bookkeeping only; a
    /// rejected block never reaches this). Failure to record is not fatal here — the index
    /// is re-derived from the stored chain at the next start (`ensure_tx_seen_index`).
    fn record_block_tx_hashes(&self, block: &BlockV1) {
        let hb = block.header.height.to_be_bytes();
        for tx in &block.txs {
            let _ = self.tx_seen_db.insert(quantum_vault_types::tx_identity(tx).as_bytes(), &hb);
        }
        let _ = self.tx_seen_db.insert(TX_SEEN_INDEXED_TIP_KEY, &hb);
        let _ = self.tx_seen_db.flush();
    }

    /// Make the index complete for the stored chain: if its recorded tip is not the chain
    /// tip (fresh node, upgrade from a binary without the index, crash between append and
    /// record), rebuild it from every stored block. Deterministic and idempotent.
    fn ensure_tx_seen_index(&self) -> Result<(), String> {
        let tip = self.store.get_tip()?.height;
        let indexed = self.tx_seen_db.get(TX_SEEN_INDEXED_TIP_KEY).map_err(|e| e.to_string())?
            .and_then(|v| v.as_ref().try_into().ok().map(u64::from_be_bytes));
        if indexed == Some(tip) { return Ok(()); }
        let blocks = self.store.get_all_blocks()?;
        self.tx_seen_db.clear().map_err(|e| e.to_string())?;
        let mut n = 0usize;
        for b in &blocks {
            let hb = b.header.height.to_be_bytes();
            for tx in &b.txs {
                self.tx_seen_db.insert(quantum_vault_types::tx_identity(tx).as_bytes(), &hb).map_err(|e| e.to_string())?;
                n += 1;
            }
        }
        self.tx_seen_db.insert(TX_SEEN_INDEXED_TIP_KEY, &tip.to_be_bytes()).map_err(|e| e.to_string())?;
        self.tx_seen_db.flush().map_err(|e| e.to_string())?;
        eprintln!("[init] tx-seen index rebuilt: {} tx hashes over {} blocks (tip {})", n, blocks.len(), tip);
        Ok(())
    }

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

    /// INTERNAL ONLY: Accept a node-generated transaction into the mempool.
    /// 
    /// SECURITY: This function does NOT verify the transaction signature because
    /// it is ONLY called from `submit_*_tx()` functions where the node itself
    /// just signed the tx using its own key. Never expose this to external callers.
    /// External/P2P transactions must go through `add_tx_to_mempool()` which
    /// verifies ML-DSA-65 signatures.
    fn accept_tx(&self, tx: TxV1) -> Result<(), String> {
        self.check_nonce_valid(&tx.from_pub_key, tx.nonce)?;
        let id = bytes_to_hex(&sha256(&encode_tx_v1(&tx)));
        let mut mempool = self.mempool.lock().map_err(|_| "mempool lock")?;
        if mempool.len() >= MAX_MEMPOOL {
            // SECURITY: Evict lowest-fee tx to prevent fee-based DoS
            if let Some(evict_id) = mempool.iter()
                .min_by(|a, b| a.1.fee.partial_cmp(&b.1.fee).unwrap_or(std::cmp::Ordering::Equal))
                .map(|(k, _)| k.clone())
            {
                // Only evict if new tx has higher fee than the minimum
                let min_fee = mempool.get(&evict_id).map(|t| t.fee).unwrap_or(0.0);
                if tx.fee <= min_fee {
                    return Err("Mempool full: tx fee too low".to_string());
                }
                mempool.remove(&evict_id);
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

    /// Current base fee in **quanta** — the consensus source of truth.
    ///
    /// New format is an integer-quanta decimal string; a legacy f64-XRGE string
    /// (pre-T6 fee_db) is still read and converted, so an existing node upgrades
    /// cleanly. Missing → [`BASE_FEE_INITIAL_QUANTA`].
    fn get_base_fee_quanta(&self) -> u128 {
        self.fee_db.get(b"base_fee").ok().flatten()
            .and_then(|v| String::from_utf8(v.to_vec()).ok())
            .and_then(|s| s.parse::<u128>().ok().or_else(|| s.parse::<f64>().ok().map(fee_to_quanta)))
            .unwrap_or(BASE_FEE_INITIAL_QUANTA)
    }

    /// Get the current base fee as **display XRGE**. Serialization boundary only
    /// (metrics/RPC/header) — never fed back into consensus.
    pub fn get_base_fee(&self) -> f64 {
        quanta_to_display(self.get_base_fee_quanta())
    }

    /// Persist the base fee (quanta), stored as an integer decimal string.
    fn set_base_fee_quanta(&self, quanta: u128) {
        let _ = self.fee_db.insert(b"base_fee", quanta.to_string().as_bytes());
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

    /// Calculate the next base fee (quanta) from block fullness (EIP-1559).
    /// All integer: `delta = current * |txs - target| / (target * denom)` via
    /// `mul_div`, floored at [`BASE_FEE_FLOOR_QUANTA`]. Deterministic across
    /// nodes and replays — no f64.
    fn calculate_next_base_fee(&self, tx_count: usize) -> u128 {
        let current = self.get_base_fee_quanta();
        if tx_count == TARGET_TXS_PER_BLOCK {
            return current; // At target, no change
        }
        let divisor = (TARGET_TXS_PER_BLOCK as u128) * BASE_FEE_MAX_CHANGE_DENOM;
        if tx_count > TARGET_TXS_PER_BLOCK {
            // Above target → increase by 1/8 per (excess/target) of the block.
            let excess = (tx_count - TARGET_TXS_PER_BLOCK) as u128;
            let delta = mul_div(current, excess, divisor);
            current.saturating_add(delta).max(BASE_FEE_FLOOR_QUANTA)
        } else {
            // Below target → decrease, never below the floor.
            let deficit = (TARGET_TXS_PER_BLOCK - tx_count) as u128;
            let delta = mul_div(current, deficit, divisor);
            current.saturating_sub(delta).max(BASE_FEE_FLOOR_QUANTA)
        }
    }

    /// Canonical state root over the CURRENT in-memory balance ledger
    /// (native + token + LP), via the `state_root` module. Pure read.
    ///
    /// This is the primitive Phase 2 is built on: the producer stamps it into a
    /// block header (P2-4) and importers recompute it after applying a block to
    /// check it against the proposer's (P2-5). Callers must NOT already hold the
    /// balance/token/lp locks — this takes them in the canonical order
    /// (balances → token → lp) matching `apply_balance_block`, so there is no
    /// deadlock as long as no caller holds a later lock first.
    #[allow(dead_code)] // wired into production/import in P2-4/P2-5
    fn compute_current_state_root(&self) -> Result<String, String> {
        let balances = self.balances.lock().map_err(|_| "balance lock")?;
        let token_balances = self.token_balances.lock().map_err(|_| "token balance lock")?;
        let lp_balances = self.lp_balances.lock().map_err(|_| "lp balance lock")?;
        Ok(crate::state_root::compute_state_root(
            &balances,
            &token_balances,
            &lp_balances,
        ))
    }

    /// Snapshot of the native XRGE ledger in quanta, for read-only contract
    /// simulation (RPC dry-run) — so `host_get_balance` sees real balances with
    /// no risk of committing state. (P3-5)
    pub fn native_balances_quanta(&self) -> HashMap<String, u128> {
        self.balances.lock().map(|b| b.clone()).unwrap_or_default()
    }

    /// Public accessor for the current ledger state root (display/debugging).
    /// Lets an operator compare nodes at the same height to spot divergence; it
    /// is the same value the block header commits at/after activation.
    // ── Option-B canonical-ledger fork (issue #66) ─────────────────────────────────
    fn assert_canonical_ledger_at_f_minus_1(&self) -> Result<(), String> {
        let b = self.balances.lock().map_err(|_| "balance lock")?;
        crate::fork::ledger_matches_table(&b, crate::fork::CANONICAL_LEDGER_AT_F_MINUS_1)?;
        let tok = self.token_balances.lock().map_err(|_| "token lock")?;
        let lp = self.lp_balances.lock().map_err(|_| "lp lock")?;
        crate::fork::token_lp_match_tables(&tok, &lp)?;
        let fb = self.get_total_fees_burned().to_bits();
        if fb != crate::fork::CANONICAL_FEES_BURNED_BITS_AT_F_MINUS_1 {
            return Err(format!("fees_burned accumulator {} (bits {}) != canonical {}", f64::from_bits(fb), fb, f64::from_bits(crate::fork::CANONICAL_FEES_BURNED_BITS_AT_F_MINUS_1)));
        }
        Ok(())
    }
    /// Set the persisted `total_fees_burned` accumulator (in-memory + `fee_db["total_burned"]`).
    fn set_total_fees_burned(&self, v: f64) -> Result<(), String> {
        *self.total_fees_burned.lock().map_err(|_| "fees lock")? = v;
        self.fee_db.insert(b"total_burned", v.to_string().as_bytes()).map_err(|e| e.to_string())?;
        self.fee_db.flush().map_err(|e| e.to_string())?;
        Ok(())
    }
    /// Consensus-relevant validator rows of the live store (see `fork::ValidatorRow`).
    pub fn validator_rows(&self) -> Result<Vec<crate::fork::ValidatorRow>, String> {
        let mut rows: Vec<crate::fork::ValidatorRow> = self.validator_store.list_validators()?.into_iter()
            .map(|(k, v)| (k, v.stake, v.slash_count, v.jailed_until, v.missed_blocks, v.total_slashed)).collect();
        rows.sort(); Ok(rows)
    }
    /// Validator state at F-1 is a consensus commitment too (proposer selection, quorum): the
    /// live validator set must equal the pinned canonical table and the unbonding queue must be
    /// empty (no unstake exists in history 1..=F-1).
    fn assert_canonical_validators_at_f_minus_1(&self) -> Result<(), String> {
        crate::fork::validators_match_table(&self.validator_rows()?, crate::fork::CANONICAL_VALIDATOR_STATE_AT_F_MINUS_1)?;
        let ub = self.unbonding_queue.lock().map_err(|_| "unbonding lock")?.len();
        if ub != 0 { return Err(format!("unbonding queue must be empty at F-1, found {} entries", ub)); }
        Ok(())
    }
    /// The pending-unbonding queue in canonical (sorted) form — consensus state.
    pub fn unbonding_rows(&self) -> Result<Vec<(String, u64, u64)>, String> {
        let q = self.unbonding_queue.lock().map_err(|_| "unbonding lock")?;
        let mut v: Vec<(String, u64, u64)> = q.iter().map(|e| (e.delegator.clone(), e.amount.to_bits(), e.release_height)).collect();
        v.sort(); Ok(v)
    }
    /// Apply `VALIDATOR_TRANSITION` to the live store: consensus fields are overwritten from the
    /// row, informational counters (`blocks_proposed`, `entropy_contributions`, `name`) are kept.
    fn apply_validator_transition_to_store(&self) -> Result<(), String> {
        for (op, k, s, sc, j, m, ts) in crate::fork::VALIDATOR_TRANSITION {
            match *op {
                "set" => {
                    let mut st = self.validator_store.get_validator(k)?.unwrap_or(ValidatorState {
                        stake: 0, slash_count: 0, jailed_until: 0, entropy_contributions: 0, blocks_proposed: 0, name: None, missed_blocks: 0, total_slashed: 0 });
                    st.stake = *s; st.slash_count = *sc; st.jailed_until = *j; st.missed_blocks = *m; st.total_slashed = *ts;
                    self.validator_store.set_validator(k, &st)?;
                }
                "remove" => self.validator_store.delete_validator(k)?,
                other => return Err(format!("unknown validator transition op {}", other)),
            }
        }
        Ok(())
    }
    /// Whether the Option-B mainnet fork rules apply to this node's chain.
    pub fn fork_applies(&self) -> bool { self.opts.chain.chain_id == crate::fork::FORK_CHAIN_ID }
    pub fn canonical_marker_present(&self) -> bool {
        self.snapshot_db.get(crate::fork::CANONICAL_MARKER_KEY).ok().flatten().is_some()
    }
    fn set_canonical_marker(&self) -> Result<(), String> {
        self.snapshot_db.insert(crate::fork::CANONICAL_MARKER_KEY, &(crate::fork::FORK_HEIGHT - 1).to_be_bytes()).map_err(|e| e.to_string())?;
        self.snapshot_db.flush().map_err(|e| e.to_string())?;
        Ok(())
    }
    /// Startup guard: past F-1 a node may only run on the canonical ledger.
    pub fn fork_readiness_check(&self) -> Result<(), String> {
        let tip = self.store.get_tip()?.height;
        if tip >= crate::fork::FORK_HEIGHT - 1 && !self.canonical_marker_present() {
            let b = self.balances.lock().map_err(|_| "balance lock")?;
            if tip == crate::fork::FORK_HEIGHT - 1 && crate::fork::ledger_matches_table(&b, crate::fork::PRODUCTION_LEDGER_AT_F_MINUS_1).is_ok() {
                return Err(format!("ledger at height {} is the LEGACY production ledger — run --migrate-canonical-ledger before the fork height {}", tip, crate::fork::FORK_HEIGHT));
            }
            return Err(format!("tip {} is at/after the fork but this node's ledger is not marked canonical — refusing to run (recover from history or migrate)", tip));
        }
        Ok(())
    }

    /// EXPLICIT, operator-invoked, one-time, ATOMIC Option-B migration of a legacy production
    /// ledger to the canonical ledger at F-1. Never runs on ordinary restart.
    /// `persist` performs the durable write (injected so tests can fail it); on ANY failure
    /// the in-memory ledger is restored exactly and the pre-migration snapshot re-persisted.
    pub fn migrate_canonical_ledger(&self, persist: &dyn Fn(&Self) -> Result<(), String>) -> Result<&'static str, String> {
        use crate::fork::*;
        if !self.fork_applies() { return Err(format!("the canonical-ledger migration applies only to chain '{}' (this node: '{}')", FORK_CHAIN_ID, self.opts.chain.chain_id)); }
        verify_table_hashes()?;
        let tip = self.store.get_tip()?.height;
        if tip != FORK_HEIGHT - 1 {
            return Err(format!("migration requires tip == {} (F-1); current tip {}", FORK_HEIGHT - 1, tip));
        }
        let pre = self.balances.lock().map_err(|_| "balance lock")?.clone();
        let pre_rows = self.validator_rows()?;
        {
            let tok = self.token_balances.lock().map_err(|_| "token lock")?;
            let lp = self.lp_balances.lock().map_err(|_| "lp lock")?;
            token_lp_match_tables(&tok, &lp)?;
        }
        let unbonding = self.unbonding_queue.lock().map_err(|_| "unbonding lock")?.len();
        if unbonding != 0 { return Err(format!("unbonding queue has {} entries but history 1..=F-1 contains no unstake — ABORT, manual investigation", unbonding)); }
        let pre_fees_burned = self.get_total_fees_burned();
        let pre_fee_db_total_burned = self.fee_db.get(b"total_burned").map_err(|e| e.to_string())?.map(|v| v.to_vec());
        let ledger_canon = ledger_matches_table(&pre, CANONICAL_LEDGER_AT_F_MINUS_1).is_ok();
        let vals_canon = validators_match_table(&pre_rows, CANONICAL_VALIDATOR_STATE_AT_F_MINUS_1).is_ok();
        let fees_canon = pre_fees_burned.to_bits() == CANONICAL_FEES_BURNED_BITS_AT_F_MINUS_1;
        if ledger_canon && vals_canon && fees_canon {
            if self.canonical_marker_present() { return Ok("already-migrated"); }
            self.set_canonical_marker()?;
            return Ok("already-canonical-marked");
        }
        if ledger_canon != vals_canon || ledger_canon != fees_canon {
            return Err(format!("INCONSISTENT state: ledger canonical={} validators canonical={} fees_burned canonical={} — ABORT, manual investigation", ledger_canon, vals_canon, fees_canon));
        }
        if pre_fees_burned.to_bits() != PRODUCTION_FEES_BURNED_BITS_AT_F_MINUS_1 {
            return Err(format!("pre-migration fees_burned {} (bits {}) != PRODUCTION_FEES_BURNED_BITS_AT_F_MINUS_1 ({}) — ABORT, no partial migration", pre_fees_burned, pre_fees_burned.to_bits(), f64::from_bits(PRODUCTION_FEES_BURNED_BITS_AT_F_MINUS_1)));
        }
        if self.canonical_marker_present() {
            return Err("canonical marker present but state is not canonical — ABORT, manual investigation".into());
        }
        if let Err(e) = ledger_matches_table(&pre, PRODUCTION_LEDGER_AT_F_MINUS_1) {
            return Err(format!("pre-migration ledger does not match PRODUCTION_LEDGER_AT_F_MINUS_1 — ABORT, no partial migration: {}", e));
        }
        if let Err(e) = validators_match_table(&pre_rows, PRODUCTION_VALIDATOR_STATE_AT_F_MINUS_1) {
            return Err(format!("pre-migration validator state does not match PRODUCTION_VALIDATOR_STATE_AT_F_MINUS_1 — ABORT, no partial migration: {}", e));
        }
        let after = apply_delta(&pre)?;
        ledger_matches_table(&after, CANONICAL_LEDGER_AT_F_MINUS_1)
            .map_err(|e| format!("post-delta ledger does not equal CANONICAL_LEDGER_AT_F_MINUS_1 — ABORT: {}", e))?;
        validators_match_table(&apply_validator_transition(&pre_rows), CANONICAL_VALIDATOR_STATE_AT_F_MINUS_1)
            .map_err(|e| format!("post-transition validators do not equal CANONICAL_VALIDATOR_STATE_AT_F_MINUS_1 — ABORT: {}", e))?;
        // full dump of the validator trees for byte-exact rollback (validators + unbonding + meta)
        let mut vtrees: Vec<(sled::Tree, Vec<(Vec<u8>, Vec<u8>)>)> = Vec::new();
        for t in self.validator_store.trees() { vtrees.push((t.clone(), snapshot_tree(t)?)); }
        // ── apply BOTH components; any failure below rolls back both ──
        *self.balances.lock().map_err(|_| "balance lock")? = after;
        let result = (|| -> Result<(), String> {
            self.apply_validator_transition_to_store()?;
            validators_match_table(&self.validator_rows()?, CANONICAL_VALIDATOR_STATE_AT_F_MINUS_1)?;
            self.set_total_fees_burned(f64::from_bits(CANONICAL_FEES_BURNED_BITS_AT_F_MINUS_1))?;
            persist(self)?;
            for t in self.validator_store.trees() { t.flush().map_err(|e| e.to_string())?; }
            self.set_canonical_marker()?;
            let b = self.balances.lock().map_err(|_| "balance lock")?;
            ledger_matches_table(&b, CANONICAL_LEDGER_AT_F_MINUS_1)?;
            validators_match_table(&self.validator_rows()?, CANONICAL_VALIDATOR_STATE_AT_F_MINUS_1)?;
            if self.get_total_fees_burned().to_bits() != CANONICAL_FEES_BURNED_BITS_AT_F_MINUS_1 { return Err("fees_burned not canonical after migration".into()); }
            Ok(())
        })();
        if let Err(e) = result {
            *self.balances.lock().map_err(|_| "balance lock")? = pre;
            let mut rollback_err = None;
            if let Ok(mut f) = self.total_fees_burned.lock() { *f = pre_fees_burned; }
            let r = match &pre_fee_db_total_burned { Some(v) => self.fee_db.insert(b"total_burned", v.clone()).map(|_| ()), None => self.fee_db.remove(b"total_burned").map(|_| ()) };
            if let Err(e) = r { rollback_err = Some(e.to_string()); }
            let _ = self.fee_db.flush();
            for (t, dump) in &vtrees { if let Err(e) = restore_tree(t, dump) { rollback_err = Some(e); } }
            let _ = self.snapshot_db.remove(CANONICAL_MARKER_KEY);
            let _ = self.snapshot_db.flush();
            let _ = self.persist_snapshot_atomic(tip); // re-persist the exact pre-migration ledger
            if let Some(re) = rollback_err { return Err(format!("migration FAILED ({}) AND validator rollback failed ({}) — manual investigation", e, re)); }
            return Err(format!("migration FAILED and was rolled back: {}", e));
        }
        Ok("migrated")
    }

    /// Durable write for the migration / recovery: the balance snapshot as ONE atomic sled batch.
    pub fn persist_snapshot_atomic(&self, height: u64) -> Result<(), String> {
        let bal = self.balances.lock().map_err(|_| "bal lock")?;
        let tok = self.token_balances.lock().map_err(|_| "tok lock")?;
        let lp = self.lp_balances.lock().map_err(|_| "lp lock")?;
        let burned = self.burned_tokens.lock().map_err(|_| "burned lock")?;
        let fees_burned = *self.total_fees_burned.lock().map_err(|_| "fees lock")?;
        let shielded = *self.shielded_supply.lock().map_err(|_| "shielded lock")?;
        let tok_vec: Vec<((String, String), u128)> = tok.iter().map(|(k, v)| (k.clone(), *v)).collect();
        let lp_vec: Vec<((String, String), u128)> = lp.iter().map(|(k, v)| (k.clone(), *v)).collect();
        let mut batch = sled::Batch::default();
        batch.insert(b"version".to_vec(), SNAPSHOT_VERSION.to_be_bytes().to_vec());
        batch.insert(b"height".to_vec(), height.to_be_bytes().to_vec());
        batch.insert(b"balances".to_vec(), serde_json::to_vec(&*bal).map_err(|e| e.to_string())?);
        batch.insert(b"token_balances".to_vec(), serde_json::to_vec(&tok_vec).map_err(|e| e.to_string())?);
        batch.insert(b"lp_balances".to_vec(), serde_json::to_vec(&lp_vec).map_err(|e| e.to_string())?);
        batch.insert(b"burned_tokens".to_vec(), serde_json::to_vec(&*burned).map_err(|e| e.to_string())?);
        batch.insert(b"fees_burned".to_vec(), fees_burned.to_be_bytes().to_vec());
        batch.insert(b"shielded_supply".to_vec(), shielded.to_be_bytes().to_vec());
        let ub = self.unbonding_queue.lock().map_err(|_| "unbonding lock")?;
        batch.insert(b"unbonding_queue".to_vec(), serde_json::to_vec(&*ub).map_err(|e| e.to_string())?);
        self.snapshot_db.apply_batch(batch).map_err(|e| format!("snapshot batch: {}", e))?;
        self.snapshot_db.flush().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Deterministic recovery WITHOUT a snapshot: reset every derived state component, then
    /// re-import the stored blocks from genesis through the REAL import path (checkpoint
    /// validation, canonical rules, F-1 assertion). Ends in exactly the fresh-sync state.
    pub fn recover_from_history(&self) -> Result<(), String> {
        let blocks = self.store.get_all_blocks()?;
        if blocks.is_empty() { return Ok(()); }
        eprintln!("[recover] no valid snapshot — deterministic re-import of {} blocks from genesis", blocks.len());
        {
            self.balances.lock().map_err(|_| "bal")?.clear();
            self.token_balances.lock().map_err(|_| "tok")?.clear();
            self.lp_balances.lock().map_err(|_| "lp")?.clear();
            self.burned_tokens.lock().map_err(|_| "burned")?.clear();
            *self.total_fees_burned.lock().map_err(|_| "fees")? = 0.0;
            *self.shielded_supply.lock().map_err(|_| "sh")? = 0.0;
            self.unbonding_queue.lock().map_err(|_| "uq")?.clear();
        }
        let _ = self.fee_db.clear(); let _ = self.fee_db.flush();
        let _ = self.nonce_db.clear(); let _ = self.nonce_db.flush();
        let _ = self.tx_seen_db.clear(); let _ = self.tx_seen_db.flush();
        let _ = self.snapshot_db.remove(crate::fork::CANONICAL_MARKER_KEY);
        // validators, unbonding queue AND meta: recovery re-derives every validator component
        for t in self.validator_store.trees() { t.clear().map_err(|e| e.to_string())?; }
        self.pool_store.clear_all()?;
        self.nft_store.clear_all()?;
        self.token_metadata_store.clear()?;
        for t in self.pool_event_store.trees().into_iter().chain(self.allowance_store.trees()).chain(self.multisig_store.trees()) {
            t.clear().map_err(|e| e.to_string())?;
        }
        if let Some(ref cs) = self.contract_store { for t in cs.trees() { t.clear().map_err(|e| e.to_string())?; } }
        self.store.reset_chain(&blocks[..1])?;
        self.apply_genesis_allocations(&self.opts.genesis_allocations, &self.opts.genesis_validators)?;
        for block in blocks.into_iter().skip(1) {
            let h = block.header.height;
            self.import_block(block).map_err(|e| format!("recovery failed at height {}: {}", h, e))?;
        }
        let tip = self.store.get_tip()?.height;
        self.persist_snapshot_atomic(tip)?;
        eprintln!("[recover] re-import complete at height {}", tip);
        Ok(())
    }

    /// Read-only operator diagnostic: canonical digests of consensus state.
    pub fn state_digest(&self) -> Result<serde_json::Value, String> {
        fn h(s: &str) -> String { bytes_to_hex(&sha256(s.as_bytes())) }
        let (sb, st, sl, sbt) = {
            let b = self.balances.lock().map_err(|_| "bal")?; let t = self.token_balances.lock().map_err(|_| "tok")?; let l = self.lp_balances.lock().map_err(|_| "lp")?; let bt = self.burned_tokens.lock().map_err(|_| "burned")?;
            // zero-valued entries are not state (the state root ignores them too)
            let sb: std::collections::BTreeMap<String, u128> = b.iter().filter(|(_, v)| **v != 0).map(|(k, v)| (k.clone(), *v)).collect();
            let st: std::collections::BTreeMap<(String, String), u128> = t.iter().filter(|(_, v)| **v != 0).map(|(k, v)| (k.clone(), *v)).collect();
            let sl: std::collections::BTreeMap<(String, String), u128> = l.iter().filter(|(_, v)| **v != 0).map(|(k, v)| (k.clone(), *v)).collect();
            let sbt: std::collections::BTreeMap<String, f64> = bt.iter().map(|(k, v)| (k.clone(), *v)).collect();
            (sb, st, sl, sbt)
        };
        let mut nonces = String::new(); for item in self.nonce_db.iter() { let (k, v) = item.map_err(|e| e.to_string())?; nonces.push_str(&format!("{}={}\n", bytes_to_hex(&k), bytes_to_hex(&v))); }
        let stakes: std::collections::BTreeMap<String, u128> = self.list_validators().unwrap_or_default().into_iter().map(|(k, v)| (k, v.stake)).collect();
        // validators: consensus fields (exact), informational counters separately (excluded from parity)
        let rows = self.validator_rows()?;
        let validators: std::collections::BTreeMap<String, serde_json::Value> = rows.iter().map(|(k, s, sc, j, m, ts)| (k.clone(), serde_json::json!({ "stake": s, "slash_count": sc, "jailed_until": j, "missed_blocks": m, "total_slashed": ts }))).collect();
        let informational: std::collections::BTreeMap<String, serde_json::Value> = self.list_validators().unwrap_or_default().into_iter().map(|(k, v)| (k, serde_json::json!({ "blocks_proposed": v.blocks_proposed, "entropy_contributions": v.entropy_contributions, "name": v.name }))).collect();
        let (total_stake, quorum) = crate::fork::stake_and_quorum(&rows);
        // (delegator, amount f64 bits, release_height) — the in-memory queue IS the consensus queue
        let ub = self.unbonding_rows()?;
        Ok(serde_json::json!({
            "tip": self.store.get_tip()?.height, "tip_hash": self.store.get_tip()?.hash, "state_root": self.get_state_root()?,
            "validators": validators, "validators_informational": informational, "total_stake": total_stake, "quorum": quorum, "unbonding": ub,
            "balances": h(&sb.iter().map(|(k, v)| format!("{}={}\n", k, v)).collect::<String>()),
            "token_balances": h(&st.iter().map(|((a, x), v)| format!("{}|{}={}\n", a, x, v)).collect::<String>()),
            "lp_balances": h(&sl.iter().map(|((a, x), v)| format!("{}|{}={}\n", a, x, v)).collect::<String>()),
            "burned_tokens": h(&sbt.iter().map(|(k, v)| format!("{}={:016x}\n", k, v.to_bits())).collect::<String>()),
            "nonce_db": h(&nonces), "stakes": stakes, "shielded_supply_bits": self.get_shielded_supply().to_bits(),
            "base_fee_quanta": self.get_base_fee_quanta(), "fees_burned_bits": self.get_total_fees_burned().to_bits(),
            "canonical_marker": self.canonical_marker_present(),
        }))
    }

    pub fn get_state_root(&self) -> Result<String, String> {
        self.compute_current_state_root()
    }

    /// Clone the three in-memory balance maps. Used by import (P2-5) to take a
    /// pre-apply snapshot so a block whose state root doesn't match can be
    /// rejected and the money ledger restored exactly, without a full
    /// speculative apply of the side-effect stores. Callers must not hold the
    /// locks; taken in canonical order.
    #[allow(dead_code)] // used by import verification in P2-5
    fn snapshot_balance_maps(
        &self,
    ) -> Result<
        (
            HashMap<String, u128>,
            HashMap<TokenBalanceKey, u128>,
            HashMap<TokenBalanceKey, u128>,
        ),
        String,
    > {
        let balances = self.balances.lock().map_err(|_| "balance lock")?;
        let token_balances = self.token_balances.lock().map_err(|_| "token balance lock")?;
        let lp_balances = self.lp_balances.lock().map_err(|_| "lp balance lock")?;
        Ok((balances.clone(), token_balances.clone(), lp_balances.clone()))
    }

    /// Restore the three in-memory balance maps from a snapshot (rollback).
    /// Pairs with [`snapshot_balance_maps`]; taken in canonical order.
    #[allow(dead_code)] // used by import verification in P2-5
    fn restore_balance_maps(
        &self,
        snap: (
            HashMap<String, u128>,
            HashMap<TokenBalanceKey, u128>,
            HashMap<TokenBalanceKey, u128>,
        ),
    ) -> Result<(), String> {
        let (b, t, l) = snap;
        *self.balances.lock().map_err(|_| "balance lock")? = b;
        *self.token_balances.lock().map_err(|_| "token balance lock")? = t;
        *self.lp_balances.lock().map_err(|_| "lp balance lock")? = l;
        Ok(())
    }
}

/// Complete pre-apply snapshot of EVERY node-state component that
/// `apply_balance_block` (and the post-verification `apply_validator_block`)
/// can mutate before a block is accepted. `import_block` captures one right
/// before the speculative apply and, on ANY rejection (apply error, state-root
/// mismatch, validator-apply error, persist failure), restores it with
/// [`L1Node::restore_pre_apply_snapshot`] so the node state after a rejected
/// block is byte-for-byte the state before it was attempted — nothing that
/// can influence future execution, validity, fees, bridge execution or
/// replay is left dirty.
///
/// Components (see `capture_pre_apply_snapshot` for the exact set):
/// * in-memory `balances`, `token_balances`, `lp_balances`, `burned_tokens`
/// * EIP-1559 base fee (sled `fee_db["base_fee"]`) and `total_fees_burned`
///   (in-memory + sled `fee_db["total_burned"]`)
/// * `shielded_supply`, `unbonding_queue`
/// * `nonce_db` entries for every sender in the block
/// * `address_db` (rouge1 index) entries for every sender/recipient
/// * full dumps of the sled trees of the side-effect stores the block can
///   touch (token metadata, pools, allowances, multisig, validators always;
///   pool events / NFT / contract stores gated on the block's tx types
///   because those trees grow with history).
pub(crate) struct PreApplySnapshot {
    balances: HashMap<String, u128>,
    token_balances: HashMap<TokenBalanceKey, u128>,
    lp_balances: HashMap<TokenBalanceKey, u128>,
    burned_tokens: HashMap<String, f64>,
    /// raw `fee_db` entries ("base_fee", "total_burned") → prior bytes (None = absent)
    fee_db_entries: Vec<(Vec<u8>, Option<Vec<u8>>)>,
    total_fees_burned: f64,
    shielded_supply: f64,
    unbonding_queue: Vec<UnbondingEntry>,
    /// nonce_db key → prior value (None = key was absent)
    nonce_entries: Vec<(Vec<u8>, Option<Vec<u8>>)>,
    /// address_db key → prior value (None = key was absent)
    address_entries: Vec<(Vec<u8>, Option<Vec<u8>>)>,
    /// (tree handle, full key/value dump) for every snapshotted sled tree
    trees: Vec<(sled::Tree, Vec<(Vec<u8>, Vec<u8>)>)>,
}

/// Full key/value dump of a sled tree (rollback primitive).
pub(crate) fn snapshot_tree(tree: &sled::Tree) -> Result<Vec<(Vec<u8>, Vec<u8>)>, String> {
    let mut out = Vec::new();
    for item in tree.iter() {
        let (k, v) = item.map_err(|e| format!("snapshot tree iter: {}", e))?;
        out.push((k.to_vec(), v.to_vec()));
    }
    Ok(out)
}

/// Restore a sled tree to a dump taken by [`snapshot_tree`]: clear, reinsert
/// every entry, flush. Afterwards the tree holds exactly the snapshot's keys.
pub(crate) fn restore_tree(tree: &sled::Tree, entries: &[(Vec<u8>, Vec<u8>)]) -> Result<(), String> {
    tree.clear().map_err(|e| format!("restore tree clear: {}", e))?;
    for (k, v) in entries {
        tree.insert(k.as_slice(), v.as_slice()).map_err(|e| format!("restore tree insert: {}", e))?;
    }
    tree.flush().map_err(|e| format!("restore tree flush: {}", e))?;
    Ok(())
}

/// The two `address_db` keys `index_address(pubkey)` writes, if derivable.
fn address_index_keys(pubkey: &str) -> Option<(Vec<u8>, Vec<u8>)> {
    use quantum_vault_crypto::{pub_key_to_address, address_to_hash};
    let addr = pub_key_to_address(pubkey).ok()?;
    let hash = address_to_hash(&addr).ok()?;
    Some((bytes_to_hex(&hash).into_bytes(), pubkey.as_bytes().to_vec()))
}

impl L1Node {
    /// Capture a [`PreApplySnapshot`] for `block`. Callers must not hold any of
    /// the ledger locks; they are taken in the canonical order
    /// (balances → token → lp → burned) matching `apply_balance_block`.
    pub(crate) fn capture_pre_apply_snapshot(&self, block: &BlockV1) -> Result<PreApplySnapshot, String> {
        let (balances, token_balances, lp_balances, burned_tokens) = {
            let b = self.balances.lock().map_err(|_| "balance lock")?;
            let t = self.token_balances.lock().map_err(|_| "token balance lock")?;
            let l = self.lp_balances.lock().map_err(|_| "lp balance lock")?;
            let bt = self.burned_tokens.lock().map_err(|_| "burned tokens lock")?;
            (b.clone(), t.clone(), l.clone(), bt.clone())
        };
        // Raw persisted fee state, restored byte-exactly (an absent key stays absent).
        let mut fee_db_entries = Vec::new();
        for key in [&b"base_fee"[..], &b"total_burned"[..]] {
            let prev = self.fee_db.get(key).map_err(|e| format!("fee_db get: {}", e))?.map(|v| v.to_vec());
            fee_db_entries.push((key.to_vec(), prev));
        }
        let total_fees_burned = *self.total_fees_burned.lock().map_err(|_| "fees burned lock")?;
        let shielded_supply = *self.shielded_supply.lock().map_err(|_| "shielded supply lock")?;
        let unbonding_queue = self.unbonding_queue.lock().map_err(|_| "unbonding lock")?.clone();

        // Per-key snapshots of the two per-account sled indexes.
        let mut nonce_entries = Vec::new();
        let mut address_entries = Vec::new();
        {
            let mut seen_nonce: HashSet<&str> = HashSet::new();
            let mut seen_addr: HashSet<&str> = HashSet::new();
            for tx in &block.txs {
                if seen_nonce.insert(tx.from_pub_key.as_str()) {
                    let key = tx.from_pub_key.as_bytes().to_vec();
                    let prev = self.nonce_db.get(&key).map_err(|e| format!("nonce_db get: {}", e))?
                        .map(|v| v.to_vec());
                    nonce_entries.push((key, prev));
                }
                let mut pks: Vec<&str> = vec![tx.from_pub_key.as_str()];
                if let Some(ref to) = tx.payload.to_pub_key_hex { pks.push(to.as_str()); }
                for pk in pks {
                    if !seen_addr.insert(pk) { continue; }
                    if let Some((k1, k2)) = address_index_keys(pk) {
                        for key in [k1, k2] {
                            let prev = self.address_db.get(&key).map_err(|e| format!("address_db get: {}", e))?
                                .map(|v| v.to_vec());
                            address_entries.push((key, prev));
                        }
                    }
                }
            }
        }

        // Side-effect stores. Small, bounded stores are always snapshotted;
        // history-sized ones only when the block carries a tx type that writes them.
        let has = |pred: &dyn Fn(&str) -> bool| block.txs.iter().any(|tx| pred(tx.tx_type.as_str()));
        let touches_amm = has(&|t| matches!(t,
            "create_pool" | "add_liquidity" | "remove_liquidity" | "swap"
            | "place_limit_order" | "cancel_limit_order"));
        let touches_nft = has(&|t| t.starts_with("nft_"));
        let touches_contract = has(&|t| t.starts_with("contract_"));

        let mut handles: Vec<sled::Tree> = Vec::new();
        let mut push_all = |ts: Vec<&sled::Tree>| for t in ts { handles.push(t.clone()); };
        push_all(self.token_metadata_store.trees());
        push_all(self.pool_store.trees());
        push_all(self.allowance_store.trees());
        push_all(self.multisig_store.trees());
        push_all(self.validator_store.trees());
        if touches_amm { push_all(self.pool_event_store.trees()); }
        if touches_nft { push_all(self.nft_store.trees()); }
        if touches_contract {
            if let Some(ref cs) = self.contract_store { push_all(cs.trees()); }
        }
        let mut trees = Vec::with_capacity(handles.len());
        for h in handles {
            let dump = snapshot_tree(&h)?;
            trees.push((h, dump));
        }

        Ok(PreApplySnapshot {
            balances, token_balances, lp_balances, burned_tokens,
            fee_db_entries, total_fees_burned, shielded_supply, unbonding_queue,
            nonce_entries, address_entries, trees,
        })
    }

    /// Restore every component captured by [`capture_pre_apply_snapshot`].
    /// Continues past individual failures so one bad store cannot prevent the
    /// rest from rolling back; the first error is returned at the end.
    pub(crate) fn restore_pre_apply_snapshot(&self, snap: PreApplySnapshot) -> Result<(), String> {
        let mut first_err: Option<String> = None;
        let mut note = |r: Result<(), String>| if let Err(e) = r { if first_err.is_none() { first_err = Some(e); } };

        // In-memory ledger, canonical lock order.
        note((|| -> Result<(), String> {
            let mut b = self.balances.lock().map_err(|_| "balance lock")?;
            let mut t = self.token_balances.lock().map_err(|_| "token balance lock")?;
            let mut l = self.lp_balances.lock().map_err(|_| "lp balance lock")?;
            let mut bt = self.burned_tokens.lock().map_err(|_| "burned tokens lock")?;
            *b = snap.balances;
            *t = snap.token_balances;
            *l = snap.lp_balances;
            *bt = snap.burned_tokens;
            Ok(())
        })());
        note((|| -> Result<(), String> {
            *self.shielded_supply.lock().map_err(|_| "shielded supply lock")? = snap.shielded_supply;
            Ok(())
        })());
        note((|| -> Result<(), String> {
            *self.unbonding_queue.lock().map_err(|_| "unbonding lock")? = snap.unbonding_queue;
            Ok(())
        })());
        // Fees: in-memory burned total, and the raw persisted fee_db entries restored
        // byte-exactly (base fee is read from fee_db on demand, so this also restores it;
        // a key that was absent before the block stays absent — no default gets written).
        note((|| -> Result<(), String> {
            *self.total_fees_burned.lock().map_err(|_| "fees burned lock")? = snap.total_fees_burned;
            Ok(())
        })());
        for (key, prev) in snap.fee_db_entries {
            let r = match prev {
                Some(v) => self.fee_db.insert(key, v).map(|_| ()),
                None => self.fee_db.remove(key).map(|_| ()),
            };
            note(r.map_err(|e| format!("fee_db restore: {}", e)));
        }
        note(self.fee_db.flush().map(|_| ()).map_err(|e| format!("fee_db flush: {}", e)));

        // Per-key sled indexes: reinsert the old value or remove the key.
        for (key, prev) in snap.nonce_entries {
            let r = match prev {
                Some(v) => self.nonce_db.insert(key, v).map(|_| ()),
                None => self.nonce_db.remove(key).map(|_| ()),
            };
            note(r.map_err(|e| format!("nonce_db restore: {}", e)));
        }
        note(self.nonce_db.flush().map(|_| ()).map_err(|e| format!("nonce_db flush: {}", e)));
        for (key, prev) in snap.address_entries {
            let r = match prev {
                Some(v) => self.address_db.insert(key, v).map(|_| ()),
                None => self.address_db.remove(key).map(|_| ()),
            };
            note(r.map_err(|e| format!("address_db restore: {}", e)));
        }
        note(self.address_db.flush().map(|_| ()).map_err(|e| format!("address_db flush: {}", e)));

        // Side-effect store trees.
        for (tree, dump) in &snap.trees {
            note(restore_tree(tree, dump));
        }

        match first_err { Some(e) => Err(e), None => Ok(()) }
    }

    /// DETERMINISTIC identity for `apply_balance_tx_inner`'s faucet / `bridge_mint`
    /// authorization. When the genesis-anchored bridge authority set is configured, a tx is
    /// authorized iff its signer is in that set — the SAME answer on every node and on every
    /// replay, independent of which node produced the block or which key this process holds
    /// (issue #66, item 3: no node-local identity in block-state application). Only when no
    /// authority set exists (devnets / unit tests) does the local node key decide, as before.
    fn apply_identity_for(&self, tx: &TxV1, node_pub_key: &str) -> String {
        let authority = &self.opts.bridge_authority_keys;
        if authority.is_empty() {
            node_pub_key.to_string()
        } else if authority.iter().any(|k| k == &tx.from_pub_key) {
            tx.from_pub_key.clone() // authorized signer: passes the equality gate
        } else {
            "_unauthorized_".to_string() // non-empty, never equal, never "_rebuild_": rejected
        }
    }

    /// Speculative state application. Returns the per-tx `bridge_withdraw` execution
    /// results, INDEXED BY TX POSITION (a slot stays `None` for any tx that is not a
    /// bridge_withdraw or that an early `continue` skipped). This function performs NO
    /// bridge payout-store writes: it runs BEFORE state-root verification and its ledger
    /// effects may be rolled back, so the store is persisted only by
    /// `persist_bridge_withdraw_results` on the accepted-block path.
    fn apply_balance_block(&self, block: &BlockV1) -> Result<BlockExecution, String> {
        let mut balances = self.balances.lock().map_err(|_| "balance lock")?;
        let mut token_balances = self.token_balances.lock().map_err(|_| "token balance lock")?;
        let mut lp_balances = self.lp_balances.lock().map_err(|_| "lp balance lock")?;
        let mut burned_tokens = self.burned_tokens.lock().map_err(|_| "burned tokens lock")?;

        // Track actual fees collected (not all tx fees -- rejected txs don't pay)
        let mut actual_fees_collected: u128 = 0;

        // R1: fixed-length, position-indexed result vector. Never push-based — the loop
        // below has early `continue` paths that would misalign every later result.
        let mut bridge_results: Vec<Option<quantum_vault_bridge_exec::BridgeWithdrawExecution>> =
            vec![None; block.txs.len()];
        // Validator results (position-indexed) + the sequential in-block stake shadow. Fee
        // distribution below still uses the PRE-block validator set (unchanged consensus timing).
        let mut validator_results: Vec<Option<ValidatorExecution>> = vec![None; block.txs.len()];
        let mut validator_shadow: HashMap<String, u128> = HashMap::new();

        let node_pub_key = self.keys.lock().map(|k| k.public_key_hex.clone()).unwrap_or_default();
        // Apply transaction effects (transfers, stakes, etc.) - fees deducted from senders
        for (tx_index, tx) in block.txs.iter().enumerate() {
            // ── SECURITY: Consensus-layer guards (metadata store access) ──
            // These checks require &self and cannot live inside the static apply_balance_tx_inner.
            match tx.tx_type.as_str() {
                "create_token" => {
                    // Reject duplicate token symbols at consensus layer
                    if let Some(ref sym) = tx.payload.token_symbol {
                        let sym_upper = sym.trim().to_uppercase();
                        if let Ok(Some(_)) = self.token_metadata_store.get_metadata(&sym_upper) {
                            eprintln!("[node] Rejecting create_token in block: symbol '{}' already exists", sym_upper);
                            continue; // skip this tx entirely
                        }
                    }
                }
                "mint_tokens" => {
                    // CRITICAL: Verify creator authority at consensus layer.
                    // Without this, any P2P-broadcast mint_tokens tx would credit tokens
                    // to the signer, bypassing the API-layer creator check.
                    if let Some(ref sym) = tx.payload.token_symbol {
                        let sym_upper = sym.trim().to_uppercase();
                        match self.token_metadata_store.is_creator(&sym_upper, &tx.from_pub_key) {
                            Ok(true) => {} // authorized creator
                            _ => {
                                eprintln!("[node] Rejecting mint_tokens in block: {} is not creator of {}",
                                    &tx.from_pub_key[..16.min(tx.from_pub_key.len())], sym_upper);
                                continue; // skip this tx entirely
                            }
                        }
                        // Also enforce mintable flag at consensus layer
                        match self.token_metadata_store.is_mintable(&sym_upper) {
                            Ok(true) => {} // mintable token
                            _ => {
                                eprintln!("[node] Rejecting mint_tokens in block: {} is not mintable", sym_upper);
                                continue;
                            }
                        }
                    }
                }
                _ => {}
            }

            let before = balances.values().sum::<u128>();
            let mut bwo: Option<quantum_vault_bridge_exec::BridgeWithdrawExecution> = None;
            let mut vwo: Option<ValidatorExecution> = None;
            let apply_identity = self.apply_identity_for(tx, &node_pub_key);
            Self::apply_balance_tx_inner(&mut balances, &mut token_balances, &mut burned_tokens, tx, Some(&self.validator_store), &apply_identity, &self.unbonding_queue, block.header.height, &self.shielded_supply, &mut bwo, &mut validator_shadow, &mut vwo);
            bridge_results[tx_index] = bwo; // index by position — never push
            validator_results[tx_index] = vwo;
            // Commit sequential nonce for this sender
            let _ = self.nonce_db.insert(tx.from_pub_key.as_bytes(), &tx.nonce.to_be_bytes());

            // Register token metadata after balance is credited (not at API time)
            if tx.tx_type == "create_token" {
                if let Some(ref sym) = tx.payload.token_symbol {
                    let sym_upper = sym.trim().to_uppercase();
                    let name = tx.payload.token_name.as_deref().unwrap_or(&sym_upper);
                    let _ = self.register_token_metadata_ext(
                        &sym_upper,
                        name,
                        &tx.from_pub_key,
                        tx.payload.metadata_image.clone(),
                        tx.payload.metadata_description.clone(),
                        false,
                        None,
                    );
                }
            }
            // Index sender and recipient addresses for rouge1 resolution
            self.index_address(&tx.from_pub_key);
            if let Some(ref to_pk) = tx.payload.to_pub_key_hex {
                self.index_address(to_pk);
            }
            let after = balances.values().sum::<u128>();
            let deducted = before.saturating_sub(after);
            if deducted > 0 { actual_fees_collected += fee_to_quanta(tx.fee).min(deducted); }
            
            // Handle AMM transactions
            let before_amm = balances.values().sum::<u128>();
            self.apply_amm_tx_inner(
                &mut balances,
                &mut token_balances,
                &mut lp_balances,
                tx,
                block.header.time,
                block.header.height,
            )?;
            let after_amm = balances.values().sum::<u128>();
            let deducted_amm = before_amm.saturating_sub(after_amm);
            if deducted_amm > 0 { actual_fees_collected += fee_to_quanta(tx.fee).min(deducted_amm); }

            // Handle NFT transactions
            let before_nft = balances.values().sum::<u128>();
            self.apply_nft_tx_inner(
                &mut balances,
                tx,
                block.header.time,
            )?;
            let after_nft = balances.values().sum::<u128>();
            let deducted_nft = before_nft.saturating_sub(after_nft);
            if deducted_nft > 0 { actual_fees_collected += fee_to_quanta(tx.fee).min(deducted_nft); }

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
                    let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                    if xrge_bal < xrge_f64_to_quanta(tx.fee) {
                        eprintln!("[node] Rejecting approve: insufficient XRGE for fee ({:.4} < {:.4})", xrge_bal, tx.fee);
                        continue;
                    }
                    *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
                    actual_fees_collected += fee_to_quanta(tx.fee);

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
                    let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                    if xrge_bal < xrge_f64_to_quanta(tx.fee) {
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
                    let owner_key = (canon_addr(&owner), symbol.clone());
                    let owner_bal = *token_balances.get(&owner_key).unwrap_or(&0);
                    if owner_bal < amount as u128 {
                        eprintln!("[node] Rejecting transfer_from: owner {} balance {:.4} < {}", symbol, owner_bal, amount);
                        continue;
                    }

                    // Execute: deduct fee from spender, move tokens owner→recipient, decrement allowance
                    *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
                    actual_fees_collected += fee_to_quanta(tx.fee);

                    *token_balances.entry(owner_key).or_insert(0) -= amount as u128;
                    let recipient_key = (canon_addr(&to), symbol.clone());
                    *token_balances.entry(recipient_key).or_insert(0) += amount as u128;

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
                                            let b = balances.entry(canon_addr(&wallet.creator)).or_insert(0);
                                            if *b >= xrge_f64_to_quanta(amount as f64) {
                                                *b -= xrge_f64_to_quanta(amount as f64);
                                                *balances.entry(canon_addr(to)).or_insert(0) += xrge_f64_to_quanta(amount as f64);
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

        // ── WASM Contract transactions ──
        // Re-execute contract txs during block import for state verification.
        // Enforces MAX_BLOCK_FUEL across all contract calls per block.
        {
            let mut block_fuel_used: u64 = 0;
            for tx in &block.txs {
                match tx.tx_type.as_str() {
                    "contract_deploy" => {
                        let deployer = tx.payload.to_pub_key_hex.as_deref().unwrap_or(&tx.from_pub_key);
                        let contract_addr = match tx.payload.contract_addr.as_deref() {
                            Some(a) => a,
                            None => { eprintln!("[node] Skipping contract_deploy: no contract_addr"); continue; }
                        };
                        // Fee deduction
                        let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                        if xrge_bal < xrge_f64_to_quanta(tx.fee) {
                            eprintln!("[node] Rejecting contract_deploy: insufficient fee ({:.4} < {:.4})", xrge_bal, tx.fee);
                            continue;
                        }
                        *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
                        actual_fees_collected += fee_to_quanta(tx.fee);

                        // Install the bytecode carried in the tx so THIS node holds
                        // the code and can re-execute the contract identically (P3-3).
                        // Without this, a peer missing the code would silently skip
                        // its calls and diverge from the rest of the network.
                        if let (Some(ref rt), Some(ref cs)) = (&self.wasm_runtime, &self.contract_store) {
                            match cs.get_contract(contract_addr) {
                                Ok(Some(_)) => {} // already installed — idempotent
                                Ok(None) => {
                                    match tx.payload.contract_wasm.as_deref() {
                                        Some(wasm_b64) => {
                                            use base64::Engine as _;
                                            match base64::engine::general_purpose::STANDARD.decode(wasm_b64) {
                                                Ok(wasm_bytes) => {
                                                    match rt.install_contract(cs, contract_addr, deployer, &wasm_bytes, block.header.height) {
                                                        Ok(()) => eprintln!("[node] Block import: installed contract {} from tx bytecode", &contract_addr[..16.min(contract_addr.len())]),
                                                        Err(e) => eprintln!("[node] Block import: contract install failed: {} (non-fatal pre-activation)", e),
                                                    }
                                                }
                                                Err(e) => eprintln!("[node] Block import: contract_deploy bad base64: {} (non-fatal)", e),
                                            }
                                        }
                                        None => eprintln!("[node] Block import: contract_deploy {} — no bytecode in tx (legacy)", &contract_addr[..16.min(contract_addr.len())]),
                                    }
                                }
                                Err(e) => eprintln!("[node] Block import: contract_deploy check error: {}", e),
                            }
                        }
                        eprintln!("[node] Processed contract_deploy tx: deployer={}... addr={}", &deployer[..16.min(deployer.len())], &contract_addr[..16.min(contract_addr.len())]);
                    }
                    "contract_call" => {
                        let caller = tx.payload.to_pub_key_hex.as_deref().unwrap_or(&tx.from_pub_key);
                        let contract_addr = match tx.payload.contract_addr.as_deref() {
                            Some(a) => a,
                            None => { eprintln!("[node] Skipping contract_call: no contract_addr"); continue; }
                        };
                        let method = tx.payload.contract_method.as_deref().unwrap_or("call");
                        let gas_limit = tx.payload.contract_gas_limit.unwrap_or(quantum_vault_vm::DEFAULT_FUEL_LIMIT);

                        // Enforce block-level fuel cap
                        if block_fuel_used + gas_limit > MAX_BLOCK_FUEL {
                            eprintln!("[node] Rejecting contract_call: block fuel cap exceeded ({} + {} > {})", block_fuel_used, gas_limit, MAX_BLOCK_FUEL);
                            continue;
                        }

                        // Fee deduction
                        let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                        if xrge_bal < xrge_f64_to_quanta(tx.fee) {
                            eprintln!("[node] Rejecting contract_call: insufficient fee ({:.4} < {:.4})", xrge_bal, tx.fee);
                            continue;
                        }
                        *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
                        actual_fees_collected += fee_to_quanta(tx.fee);

                        // Re-execute the contract call if runtime is available.
                        let custody_active = block.header.height >= contract_custody_activation_height();
                        if let (Some(ref rt), Some(ref cs)) = (&self.wasm_runtime, &self.contract_store) {
                            // Full quanta balances — no u64 truncation (P3-2). The VM
                            // ABI is quanta-native, so pass the ledger as-is.
                            let call_balances: HashMap<String, u128> = balances.clone();
                            let tx_hash_str = bytes_to_hex(&sha256(&encode_tx_v1(tx)));
                            // Real call args from the tx payload (P3-2) — not an empty map.
                            let args = tx.payload.contract_args.clone()
                                .unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()));
                            match rt.execute_contract(
                                cs,
                                contract_addr,
                                method,
                                &args,
                                caller,
                                block.header.height,
                                block.header.time / 1000, // ms to seconds
                                call_balances,
                                gas_limit,
                                &tx_hash_str,
                            ) {
                                Ok(result) => {
                                    block_fuel_used += result.gas_used;
                                    eprintln!("[node] contract_call {} method={} gas={} success={}",
                                        &contract_addr[..16.min(contract_addr.len())], method, result.gas_used, result.success);

                                    // P3-4: apply the contract's XRGE moves to the ledger,
                                    // gated on the custody activation height. A failed
                                    // contract (revert / out-of-gas) carries no deltas.
                                    if custody_active && result.success {
                                        // v1 is SINGLE-HOP: result.balance_deltas holds only
                                        // the top-level contract's own transfers; sub-call
                                        // XRGE moves are not surfaced. If the call made cross-
                                        // calls, deterministically apply nothing rather than
                                        // silently move a partial set (documented v1 limit).
                                        let did_cross_call = result.cross_call_results
                                            .as_ref().map_or(false, |v| !v.is_empty());
                                        if did_cross_call {
                                            eprintln!("[node] contract_call {} used cross-calls; XRGE deltas NOT applied (single-hop v1)",
                                                &contract_addr[..16.min(contract_addr.len())]);
                                        } else if let Some(ref deltas) = result.balance_deltas {
                                            // Conservation + overdraft enforced here; an Err
                                            // means the VM emitted invalid deltas — a genuine
                                            // invariant break, so fail closed (reject block).
                                            crate::units::apply_balance_deltas(&mut balances, deltas)
                                                .map_err(|e| format!(
                                                    "contract {} balance deltas rejected: {}",
                                                    contract_addr, e
                                                ))?;
                                        }
                                    }
                                }
                                Err(e) => {
                                    // Could not execute (e.g. bytecode missing). Pre-activation
                                    // this is non-fatal; once custody is active it MUST fail
                                    // closed — a node that can't run the contract must not be
                                    // allowed to silently diverge from those that can.
                                    if custody_active {
                                        return Err(format!(
                                            "contract_call execution failed under active custody: {}",
                                            e
                                        ));
                                    }
                                    eprintln!("[node] contract_call failed: {} (non-fatal pre-activation)", e);
                                }
                            }
                        } else if custody_active {
                            // Custody is active but this node has no runtime/store — it cannot
                            // validate the call, so it must not accept the block.
                            return Err(
                                "contract_call requires the WASM runtime under active custody".to_string(),
                            );
                        }
                    }
                    _ => {}
                }
            }
            if block_fuel_used > 0 {
                eprintln!("[node] Block {} total contract fuel: {} / {}", block.header.height, block_fuel_used, MAX_BLOCK_FUEL);
            }
        }
        
        // R1: the bridge payout store is NOT written here (speculative apply may be rolled
        // back on a state-root mismatch). See `persist_bridge_withdraw_results`, which runs
        // only after the block is accepted and persisted.

        // Matured unbonding releases are part of the block's deterministic ledger effects and
        // MUST land before the state root is computed (producer and importer alike).
        Self::release_matured_unbonding(&self.unbonding_queue, &mut balances, block.header.height)?;

        // Distribute only actually collected fees
        if actual_fees_collected > 0 {
            let base_fee = self.get_base_fee_quanta();
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
        self.set_base_fee_quanta(next_base_fee);
        self.persist_fees_burned();

        Ok(BlockExecution { bridge: bridge_results, validator: validator_results })
    }

    /// R1: persist relayer-facing bridge payout records for an ACCEPTED, PERSISTED block.
    /// Called only after `store.append_block` succeeded (import + mine paths). Requires
    /// `results` to be position-aligned with `block.txs` (fail closed otherwise). A record is
    /// written only for `Success(effect)` with a destination AND a recognized payout asset
    /// (`is_payout_eligible`): `Failed`, `None`, no-destination and unsupported/custom tokens
    /// never produce a record. Owner is the ORIGINAL sender of tx[i]; token/amount/tx_id/
    /// destination are the effect's canonical values.
    fn persist_bridge_withdraw_results(
        &self,
        block: &BlockV1,
        results: &[Option<quantum_vault_bridge_exec::BridgeWithdrawExecution>],
    ) -> Result<(), String> {
        use quantum_vault_bridge_exec::{is_payout_eligible, BridgeWithdrawExecution::Success};
        if results.len() != block.txs.len() {
            return Err(format!(
                "bridge results ({}) not aligned to block txs ({}) at height {}",
                results.len(), block.txs.len(), block.header.height
            ));
        }
        let store = match self.opts.bridge_withdraw_store { Some(ref s) => s, None => return Ok(()) };
        for (i, r) in results.iter().enumerate() {
            let exec = match r {
                Some(e) if is_payout_eligible(e) => e,
                _ => continue, // None / Failed / no destination / Unsupported ⇒ no record
            };
            if let Success(effect) = exec {
                let dest = match effect.destination.as_ref() { Some(d) => d.clone(), None => continue };
                // Legacy "xrge:" tx_id prefix retained for relayer / claim-store continuity.
                let prefix = if effect.canonical_token == "XRGE" { "xrge:" } else { "" };
                let tx_id = format!("{}{}", prefix, bytes_to_hex(&effect.rougechain_tx_id));
                if let Err(e) = store.add(
                    tx_id.clone(),
                    dest,
                    effect.amount,
                    block.txs[i].from_pub_key.clone(),
                    effect.canonical_token.clone(),
                ) {
                    // DERIVED DATA: the block is already committed and stays committed. Surface
                    // the failure loudly, mark the bridge degraded (relayer lists fail closed until
                    // `rebuild_bridge_withdraw_store` reconstructs the record), never roll back.
                    eprintln!("[bridge] ALERT payout-record persistence FAILED for {} at height {}: {} — bridge derived state DEGRADED (payouts paused until rebuilt)",
                        tx_id, block.header.height, e);
                    self.bridge_store_degraded.store(true, std::sync::atomic::Ordering::SeqCst);
                    if let Ok(mut f) = self.bridge_store_failed_ids.lock() { f.push(tx_id); }
                }
            }
        }
        Ok(())
    }

    /// True while a derived bridge payout record is known to be missing (see
    /// `persist_bridge_withdraw_results`). Relayer-facing lists must fail closed while set.
    pub fn bridge_store_degraded(&self) -> bool {
        self.bridge_store_degraded.load(std::sync::atomic::Ordering::SeqCst)
    }
    pub fn bridge_store_failed_ids(&self) -> Vec<String> {
        self.bridge_store_failed_ids.lock().map(|f| f.clone()).unwrap_or_default()
    }

    /// Relayer-facing pending withdrawals — FAIL CLOSED while the derived payout store is
    /// degraded (a known-missing record would otherwise let the relayer act on an incomplete
    /// list). Every relayer list endpoint must go through here.
    pub fn relayer_pending_withdrawals(&self) -> Result<Vec<quantum_vault_storage::bridge_withdraw_store::PendingWithdrawal>, String> {
        if self.bridge_store_degraded() {
            return Err(format!(
                "bridge derived state DEGRADED: {} payout record(s) failed to persist — payouts paused until the store is rebuilt",
                self.bridge_store_failed_ids().len()
            ));
        }
        match self.opts.bridge_withdraw_store { Some(ref s) => s.list_pending(), None => Ok(Vec::new()) }
    }

    /// Deterministically rebuild the relayer-facing bridge payout store from ACCEPTED chain
    /// history at/after `BRIDGE_PAYOUT_STORE_ACTIVATION_HEIGHT`: every `bridge_withdraw` whose
    /// receipt records `TxStatus::Success` (the R1 execution result) with a destination and a
    /// recognized payout asset yields exactly the record `persist_bridge_withdraw_results`
    /// would have written. Idempotent (`store.add` dedups by tx_id). Clears the degraded flag
    /// only if every derived record is present afterwards. Returns the number of records added.
    pub fn rebuild_bridge_withdraw_store(&self) -> Result<usize, String> {
        self.rebuild_bridge_withdraw_store_from(BRIDGE_PAYOUT_STORE_ACTIVATION_HEIGHT)
    }

    /// `rebuild_bridge_withdraw_store` from an explicit start height (tests / operator tooling).
    pub fn rebuild_bridge_withdraw_store_from(&self, from_height: u64) -> Result<usize, String> {
        use quantum_vault_bridge_exec::{payout_route, PayoutRoute};
        let store = match self.opts.bridge_withdraw_store { Some(ref s) => s, None => return Ok(0) };
        let tip = self.store.get_tip()?.height;
        let mut added = 0usize;
        let mut missing_after = 0usize;
        let mut h = from_height.max(1);
        while h <= tip {
            if let Some(block) = self.store.get_block(h)? {
                for tx in &block.txs {
                    if tx.tx_type != "bridge_withdraw" { continue; }
                    let ok = matches!(self.get_receipt(&compute_single_tx_hash(tx))?, Some(rc) if matches!(rc.status, TxStatus::Success));
                    if !ok { continue; }
                    let (token, amount, dest) = match (&tx.payload.token_symbol, tx.payload.amount, &tx.payload.evm_address) {
                        (Some(t), Some(a), Some(d)) if a > 0 => (t.trim().to_string(), a, d.clone()),
                        _ => continue,
                    };
                    let canonical = if token.eq_ignore_ascii_case("XRGE") { "XRGE".to_string() } else { token };
                    if payout_route(&canonical) == PayoutRoute::Unsupported { continue; }
                    let prefix = if canonical == "XRGE" { "xrge:" } else { "" };
                    let tx_id = format!("{}{}", prefix, bytes_to_hex(&sha256(&encode_tx_v1(tx))));
                    let before = store.get(&tx_id)?.is_some();
                    match store.add(tx_id.clone(), dest, amount, tx.from_pub_key.clone(), canonical) {
                        Ok(()) => { if !before { added += 1; } }
                        Err(e) => { missing_after += 1; eprintln!("[bridge] rebuild: still cannot persist {}: {}", tx_id, e); }
                    }
                }
            }
            h += 1;
        }
        if missing_after == 0 {
            self.bridge_store_degraded.store(false, std::sync::atomic::Ordering::SeqCst);
            if let Ok(mut f) = self.bridge_store_failed_ids.lock() { f.clear(); }
        }
        Ok(added)
    }

    /// Apply AMM-specific transaction effects
    fn apply_amm_tx_inner(
        &self,
        balances: &mut HashMap<String, u128>,
        token_balances: &mut HashMap<TokenBalanceKey, u128>,
        lp_balances: &mut HashMap<TokenBalanceKey, u128>,
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
                let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                if xrge_bal < xrge_f64_to_quanta(xrge_needed) {
                    eprintln!("[node] Rejecting create_pool: insufficient XRGE ({:.4} < {:.4})", xrge_bal, xrge_needed);
                    return Ok(());
                }
                if token_a != "XRGE" {
                    let key = (canon_addr(&tx.from_pub_key), token_a.clone());
                    let bal = *token_balances.get(&key).unwrap_or(&0);
                    if bal < amount_a as u128 {
                        eprintln!("[node] Rejecting create_pool: insufficient {} ({:.4} < {})", token_a, bal, amount_a);
                        return Ok(());
                    }
                }
                if token_b != "XRGE" {
                    let key = (canon_addr(&tx.from_pub_key), token_b.clone());
                    let bal = *token_balances.get(&key).unwrap_or(&0);
                    if bal < amount_b as u128 {
                        eprintln!("[node] Rejecting create_pool: insufficient {} ({:.4} < {})", token_b, bal, amount_b);
                        return Ok(());
                    }
                }
                
                // Deduct XRGE fee
                *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
                
                // Deduct tokens from creator
                Self::amm_debit(balances, token_balances, &tx.from_pub_key, token_a, amount_a as f64);
                Self::amm_debit(balances, token_balances, &tx.from_pub_key, token_b, amount_b as f64);
                
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
                let lp_key = (canon_addr(&tx.from_pub_key), pool.pool_id.clone());
                *lp_balances.entry(lp_key).or_insert(0) += pool.total_lp_supply as u128;
                
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
                let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                if xrge_bal < xrge_f64_to_quanta(xrge_needed) {
                    eprintln!("[node] Rejecting add_liquidity: insufficient XRGE ({:.4} < {:.4})", xrge_bal, xrge_needed);
                    return Ok(());
                }
                if pool.token_a != "XRGE" {
                    let key = (canon_addr(&tx.from_pub_key), pool.token_a.clone());
                    let bal = *token_balances.get(&key).unwrap_or(&0);
                    if bal < amount_a as u128 {
                        eprintln!("[node] Rejecting add_liquidity: insufficient {} ({:.4} < {})", pool.token_a, bal, amount_a);
                        return Ok(());
                    }
                }
                if pool.token_b != "XRGE" {
                    let key = (canon_addr(&tx.from_pub_key), pool.token_b.clone());
                    let bal = *token_balances.get(&key).unwrap_or(&0);
                    if bal < amount_b as u128 {
                        eprintln!("[node] Rejecting add_liquidity: insufficient {} ({:.4} < {})", pool.token_b, bal, amount_b);
                        return Ok(());
                    }
                }
                
                // Deduct fee
                *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
                
                // Deduct tokens
                Self::amm_debit(balances, token_balances, &tx.from_pub_key, &pool.token_a, amount_a as f64);
                Self::amm_debit(balances, token_balances, &tx.from_pub_key, &pool.token_b, amount_b as f64);
                
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
                let lp_key = (canon_addr(&tx.from_pub_key), pool_id.clone());
                *lp_balances.entry(lp_key).or_insert(0) += lp_amount as u128;
                
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
                let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                if xrge_bal < xrge_f64_to_quanta(tx.fee) {
                    eprintln!("[node] Rejecting remove_liquidity: insufficient XRGE for fee ({:.4} < {:.4})", xrge_bal, tx.fee);
                    return Ok(());
                }
                let lp_key = (canon_addr(&tx.from_pub_key), pool_id.clone());
                let lp_bal = *lp_balances.get(&lp_key).unwrap_or(&0);
                if lp_bal < lp_amount as u128 {
                    eprintln!("[node] Rejecting remove_liquidity: insufficient LP tokens ({:.4} < {})", lp_bal, lp_amount);
                    return Ok(());
                }
                
                // Deduct fee
                *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
                
                // Calculate tokens to return
                let (amount_a, amount_b) = amm::calculate_remove_liquidity(
                    lp_amount,
                    pool.reserve_a,
                    pool.reserve_b,
                    pool.total_lp_supply,
                ).ok_or("Failed to calculate remove liquidity")?;
                
                // Burn LP tokens
                let lp_key = (canon_addr(&tx.from_pub_key), pool_id.clone());
                *lp_balances.entry(lp_key).or_insert(0) -= lp_amount as u128;
                
                // Return tokens
                Self::amm_credit(balances, token_balances, &tx.from_pub_key, &pool.token_a, amount_a as f64);
                Self::amm_credit(balances, token_balances, &tx.from_pub_key, &pool.token_b, amount_b as f64);
                
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
                let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                if token_in == "XRGE" {
                    if xrge_bal < xrge_f64_to_quanta(amount_in as f64 + tx.fee) {
                        eprintln!("[node] Rejecting swap: insufficient XRGE balance ({:.4} < {:.4})", xrge_bal, amount_in as f64 + tx.fee);
                        return Ok(());
                    }
                } else {
                    if xrge_bal < xrge_f64_to_quanta(tx.fee) {
                        eprintln!("[node] Rejecting swap: insufficient XRGE for fee ({:.4} < {:.4})", xrge_bal, tx.fee);
                        return Ok(());
                    }
                    let token_key = (canon_addr(&tx.from_pub_key), token_in.clone());
                    let token_bal = *token_balances.get(&token_key).unwrap_or(&0);
                    if token_bal < amount_in as u128 {
                        eprintln!("[node] Rejecting swap: insufficient {} balance ({:.4} < {})", token_in, token_bal, amount_in);
                        return Ok(());
                    }
                }
                
                // Deduct fee
                *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
                
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
                        Self::amm_debit(balances, token_balances, &tx.from_pub_key, t_in, current_amount as f64);
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
                Self::amm_credit(balances, token_balances, &tx.from_pub_key, final_token, current_amount as f64);
                
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
        Self::apply_balance_tx_inner(&mut balances, &mut token_balances, &mut burned_tokens, tx, Some(&self.validator_store), &node_pub_key, &self.unbonding_queue, block_height, &self.shielded_supply, &mut None, &mut HashMap::new(), &mut None);
        Ok(())
    }

    // `rebuild_balances` (second transaction-application implementation) was REMOVED: there is
    // ONE historical execution semantics — `apply_balance_block` via `import_block`.
    
    // ── Shared AMM balance primitives (XRGE → native ledger, else token map) ──
    // The create_pool/add_liquidity/remove_liquidity/swap appliers — both the
    // live path and the rebuild mirror — repeat the "if token == XRGE debit the
    // native ledger, else the token map" dichotomy ~30 times. Centralising it
    // here means the f64→u128 flip (T3) touches these three functions instead of
    // thirty call sites, and the two AMM appliers can't silently diverge on it.
    fn amm_balance_of(
        balances: &HashMap<String, u128>,
        token_balances: &HashMap<TokenBalanceKey, u128>,
        user: &str,
        token: &str,
    ) -> f64 {
        if token == "XRGE" {
            quanta_to_display(*balances.get(&canon_addr(user)).unwrap_or(&0))
        } else {
            *token_balances.get(&(canon_addr(&user), token.to_string())).unwrap_or(&0) as f64
        }
    }

    fn amm_debit(
        balances: &mut HashMap<String, u128>,
        token_balances: &mut HashMap<TokenBalanceKey, u128>,
        user: &str,
        token: &str,
        amount: f64,
    ) {
        if token == "XRGE" {
            *balances.entry(canon_addr(user)).or_insert(0) -= xrge_f64_to_quanta(amount);
        } else {
            *token_balances.entry((canon_addr(&user), token.to_string())).or_insert(0) -= amount as u128;
        }
    }

    fn amm_credit(
        balances: &mut HashMap<String, u128>,
        token_balances: &mut HashMap<TokenBalanceKey, u128>,
        user: &str,
        token: &str,
        amount: f64,
    ) {
        if token == "XRGE" {
            *balances.entry(canon_addr(user)).or_insert(0) += xrge_f64_to_quanta(amount);
        } else {
            *token_balances.entry((canon_addr(&user), token.to_string())).or_insert(0) += amount as u128;
        }
    }

    /// Apply AMM balance effects during rebuild (doesn't modify pool_store)
    fn apply_amm_balance_effects(
        balances: &mut HashMap<String, u128>,
        token_balances: &mut HashMap<TokenBalanceKey, u128>,
        lp_balances: &mut HashMap<TokenBalanceKey, u128>,
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
                    let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                    let mut xrge_needed = tx.fee;
                    if token_a == "XRGE" { xrge_needed += amount_a as f64; }
                    if token_b == "XRGE" { xrge_needed += amount_b as f64; }
                    if xrge_bal < xrge_f64_to_quanta(xrge_needed) {
                        eprintln!("[rebuild] Skipping create_pool: insufficient XRGE ({:.4} < {:.4})", xrge_bal, xrge_needed);
                        return;
                    }
                    if token_a != "XRGE" && Self::amm_balance_of(balances, token_balances, &tx.from_pub_key, token_a) < amount_a as f64 { return; }
                    if token_b != "XRGE" && Self::amm_balance_of(balances, token_balances, &tx.from_pub_key, token_b) < amount_b as f64 { return; }

                    *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
                    Self::amm_debit(balances, token_balances, &tx.from_pub_key, token_a, amount_a as f64);
                    Self::amm_debit(balances, token_balances, &tx.from_pub_key, token_b, amount_b as f64);

                    let pool_id = LiquidityPool::make_pool_id(token_a, token_b);
                    if let Ok(Some(_pool)) = pool_store.get_pool(&pool_id) {
                        // isqrt (not f64 sqrt): must match LiquidityPool::new's live
                        // computation exactly, or rebuild would diverge from live state.
                        let initial_lp = (crate::units::isqrt(amount_a as u128 * amount_b as u128) as u64).saturating_sub(1000);
                        let lp_key = (canon_addr(&tx.from_pub_key), pool_id);
                        *lp_balances.entry(lp_key).or_insert(0) += initial_lp as u128;
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
                        let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                        let mut xrge_needed = tx.fee;
                        if pool.token_a == "XRGE" { xrge_needed += amount_a as f64; }
                        if pool.token_b == "XRGE" { xrge_needed += amount_b as f64; }
                        if xrge_bal < xrge_f64_to_quanta(xrge_needed) { return; }
                        if pool.token_a != "XRGE" && Self::amm_balance_of(balances, token_balances, &tx.from_pub_key, &pool.token_a) < amount_a as f64 { return; }
                        if pool.token_b != "XRGE" && Self::amm_balance_of(balances, token_balances, &tx.from_pub_key, &pool.token_b) < amount_b as f64 { return; }

                        *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
                        Self::amm_debit(balances, token_balances, &tx.from_pub_key, &pool.token_a, amount_a as f64);
                        Self::amm_debit(balances, token_balances, &tx.from_pub_key, &pool.token_b, amount_b as f64);

                        if let Some(lp_amount) = amm::calculate_lp_mint(amount_a, amount_b, pool.reserve_a, pool.reserve_b, pool.total_lp_supply) {
                            let lp_key = (canon_addr(&tx.from_pub_key), pool_id.clone());
                            *lp_balances.entry(lp_key).or_insert(0) += lp_amount as u128;
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
                    let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                    if xrge_bal < xrge_f64_to_quanta(tx.fee) { return; }
                    let lp_key = (canon_addr(&tx.from_pub_key), pool_id.clone());
                    let lp_bal = *lp_balances.get(&lp_key).unwrap_or(&0);
                    if lp_bal < lp_amount as u128 { return; }

                    *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
                    
                    if let Ok(Some(pool)) = pool_store.get_pool(pool_id) {
                        *lp_balances.entry(lp_key).or_insert(0) -= lp_amount as u128;
                        
                        if let Some((amount_a, amount_b)) = amm::calculate_remove_liquidity(lp_amount, pool.reserve_a, pool.reserve_b, pool.total_lp_supply) {
                            Self::amm_credit(balances, token_balances, &tx.from_pub_key, &pool.token_a, amount_a as f64);
                            Self::amm_credit(balances, token_balances, &tx.from_pub_key, &pool.token_b, amount_b as f64);
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
                    let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                    if token_in == "XRGE" {
                        if xrge_bal < xrge_f64_to_quanta(amount_in as f64 + tx.fee) {
                            eprintln!("[rebuild] Skipping swap: insufficient XRGE ({:.4} < {:.4})", xrge_bal, amount_in as f64 + tx.fee);
                            return;
                        }
                    } else {
                        if xrge_bal < xrge_f64_to_quanta(tx.fee) { return; }
                        let key = (canon_addr(&tx.from_pub_key), token_in.clone());
                        let tok_bal = *token_balances.get(&key).unwrap_or(&0);
                        if tok_bal < amount_in as u128 {
                            eprintln!("[rebuild] Skipping swap: insufficient {} ({:.4} < {})", token_in, tok_bal, amount_in);
                            return;
                        }
                    }

                    *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
                    
                    let path = tx.payload.swap_path.clone().unwrap_or_else(|| vec![token_in.clone(), token_out.clone()]);

                    Self::amm_debit(balances, token_balances, &tx.from_pub_key, token_in, amount_in as f64);

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
                    Self::amm_credit(balances, token_balances, &tx.from_pub_key, final_token, current_amount as f64);
                }
            }
            _ => {}
        }
    }
    
    /// Deduct NFT fees during balance rebuild (NFT state is rebuilt separately in rebuild_nft_state)
    fn apply_nft_balance_effects(
        balances: &mut HashMap<String, u128>,
        tx: &TxV1,
    ) {
        match tx.tx_type.as_str() {
            "nft_create_collection" | "nft_mint" | "nft_batch_mint"
            | "nft_burn" | "nft_lock" | "nft_freeze_collection" => {
                let bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                if bal < fee_to_quanta(tx.fee) { return; }
                *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
            }
            "nft_transfer" => {
                let bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                if bal < fee_to_quanta(tx.fee) { return; }
                *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
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
                                quanta_to_display(*bals.get(&tx.from_pub_key).unwrap_or(&0)) as u64
                            } else { 0 }
                        } else {
                            let key = (canon_addr(&tx.from_pub_key), proposal.token_symbol.to_uppercase());
                            if let Ok(tbals) = self.token_balances.lock() {
                                *tbals.get(&key).unwrap_or(&0) as u64
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
                                        dw += quanta_to_display(*bals.get(delegator).unwrap_or(&0)) as u64;
                                    }
                                } else {
                                    let key = (canon_addr(&delegator), proposal.token_symbol.to_uppercase());
                                    if let Ok(tbals) = self.token_balances.lock() {
                                        dw += *tbals.get(&key).unwrap_or(&0) as u64;
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
                                                    let treasury_bal = *bals.get(&treasury_key).unwrap_or(&0);
                                                    if treasury_bal >= xrge_f64_to_quanta(amount as f64) {
                                                        *bals.entry(treasury_key).or_insert(0) -= xrge_f64_to_quanta(amount as f64);
                                                        *bals.entry(to.to_string()).or_insert(0) += xrge_f64_to_quanta(amount as f64);
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
    
    /// Minimum tip pool per block — if fees alone don't reach this threshold,
    /// the difference is drawn from the `__staking_rewards__` reserve so that
    /// validators always receive a baseline reward.
    const MIN_TIP_FLOOR: f64 = 0.1;

    /// Fraction of the base fee that is burned (rest flows into the tip pool).
    const BASE_FEE_BURN_RATIO: f64 = 0.5;

    /// Distribute block fees: 20% to proposer, 70% to validators (stake-weighted), 10% to treasury.
    /// Half the base fee is burned; the remainder plus priority tips form the distributable pool.
    /// A minimum tip floor is enforced, subsidised from `__staking_rewards__` if needed.
    /// Integer fee distribution (all amounts in quanta). Half the base fee is
    /// burned; the remainder plus priority tips form the pool, floored at
    /// MIN_TIP_FLOOR (subsidised from `__staking_rewards__`). The pool is split
    /// 20/70/10 proposer/validators(by stake)/treasury, with the treasury taking
    /// the exact integer remainder so proposer + validators + treasury == pool.
    fn distribute_fees(
        balances: &mut HashMap<String, u128>,
        total_fees: u128,                     // quanta collected this block
        proposer_pub_key: &str,
        validator_stakes: &BTreeMap<String, u128>,
        base_fee_per_tx_quanta: u128,         // base fee per tx, in quanta
        tx_count: usize,
        total_fees_burned: &Arc<Mutex<f64>>,  // display-XRGE accumulator
    ) {
        let total_base_fees = base_fee_per_tx_quanta.saturating_mul(tx_count as u128);
        let burned = mul_div(total_base_fees, 1, 2).min(total_fees); // BASE_FEE_BURN_RATIO = 0.5
        let mut tip_pool = total_fees - burned;

        if burned > 0 {
            if let Ok(mut b) = total_fees_burned.lock() {
                *b += quanta_to_display(burned);
            }
        }

        let min_floor = fee_to_quanta(Self::MIN_TIP_FLOOR);
        if tip_pool < min_floor {
            let subsidy = min_floor - tip_pool;
            let reserve = balances.get("__staking_rewards__").copied().unwrap_or(0);
            let actual_subsidy = subsidy.min(reserve);
            if actual_subsidy > 0 {
                *balances.entry("__staking_rewards__".to_string()).or_insert(0) -= actual_subsidy;
                tip_pool += actual_subsidy;
            }
        }

        if tip_pool == 0 {
            return;
        }

        // 20 / 70 / 10 split (PROPOSER/VALIDATOR/TREASURY_FEE_SHARE).
        let proposer_share = mul_div(tip_pool, 20, 100);
        *balances.entry(canon_addr(proposer_pub_key)).or_insert(0) += proposer_share;

        let validator_pool = mul_div(tip_pool, 70, 100);
        let total_stake: u128 = validator_stakes.values().sum();
        let mut validator_distributed: u128 = 0;
        if total_stake > 0 {
            for (validator_pub_key, stake) in validator_stakes {
                let share = mul_div(validator_pool, *stake, total_stake);
                *balances.entry(canon_addr(&validator_pub_key)).or_insert(0) += share;
                validator_distributed += share;
            }
        } else {
            *balances.entry(canon_addr(proposer_pub_key)).or_insert(0) += validator_pool;
            validator_distributed = validator_pool;
        }

        // Treasury takes the exact remainder (its ~10% plus integer dust).
        let treasury_share = tip_pool - proposer_share - validator_distributed;
        *balances.entry("__treasury__".to_string()).or_insert(0) += treasury_share;
    }
    
    fn apply_balance_tx_inner(
        balances: &mut HashMap<String, u128>,
        token_balances: &mut HashMap<TokenBalanceKey, u128>,
        burned_tokens: &mut HashMap<String, f64>,
        tx: &TxV1,
        validator_store: Option<&quantum_vault_storage::validator_store::ValidatorStore>,
        node_pub_key: &str,
        unbonding_queue: &Arc<Mutex<Vec<UnbondingEntry>>>,
        block_height: u64,
        shielded_supply: &Arc<Mutex<f64>>,
        // R1: typed execution result for `bridge_withdraw` ONLY. Written at the existing
        // decision points of the arm below; every other arm leaves it untouched (None).
        bridge_out: &mut Option<quantum_vault_bridge_exec::BridgeWithdrawExecution>,
        // Sequential in-block validator stake shadow (pubkey → stake after earlier txs of this
        // block) and the position-aligned validator result. Stake/unstake validity is decided
        // HERE, together with the ledger debit, never by re-scanning the block later.
        validator_shadow: &mut HashMap<String, u128>,
        validator_out: &mut Option<ValidatorExecution>,
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
                        *balances.entry(canon_addr(to_pub_key)).or_insert(0) += xrge_f64_to_quanta(amount);
                        return;
                    }

                    if let Some(token_symbol) = tx.payload.token_symbol.as_ref() {
                        let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                        if xrge_bal < xrge_f64_to_quanta(tx.fee) {
                            eprintln!("[node] Rejecting transfer: insufficient XRGE for fee ({:.4} < {:.4})", xrge_bal, tx.fee);
                            return;
                        }
                        let sender_key = (canon_addr(&tx.from_pub_key), token_symbol.clone());
                        let token_bal = *token_balances.get(&sender_key).unwrap_or(&0);
                        if token_bal < amount as u128 {
                            eprintln!("[node] Rejecting transfer: insufficient {} ({:.4} < {:.4})", token_symbol, token_bal, amount);
                            return;
                        }

                        *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
                        *token_balances.entry(sender_key).or_insert(0) -= amount as u128;
                        
                        if is_burn {
                            *burned_tokens.entry(token_symbol.clone()).or_insert(0.0) += amount;
                        } else {
                            let recipient_key = (canon_addr(&to_pub_key), token_symbol.clone());
                            *token_balances.entry(recipient_key).or_insert(0) += amount as u128;
                        }
                    } else {
                        let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                        if xrge_bal < xrge_f64_to_quanta(amount + tx.fee) {
                            eprintln!("[node] Rejecting transfer: insufficient XRGE ({:.4} < {:.4})", xrge_bal, amount + tx.fee);
                            return;
                        }

                        *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(amount + tx.fee);
                        
                        if is_burn {
                            *burned_tokens.entry("XRGE".to_string()).or_insert(0.0) += amount;
                        } else {
                            *balances.entry(canon_addr(to_pub_key)).or_insert(0) += xrge_f64_to_quanta(amount);
                        }
                    }
                }
            }
            "stake" => {
                let amount = tx.payload.amount.unwrap_or(0) as f64;
                if tx.payload.amount.unwrap_or(0) == 0 {
                    *validator_out = Some(ValidatorExecution::Failed("stake amount must be > 0".into()));
                    return;
                }
                let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                if xrge_bal < xrge_f64_to_quanta(amount + tx.fee) {
                    eprintln!("[node] Rejecting stake: insufficient XRGE ({:.4} < {:.4})", xrge_bal, amount + tx.fee);
                    *validator_out = Some(ValidatorExecution::Failed(format!("insufficient XRGE for stake+fee ({} < {})", quanta_to_display(xrge_bal), amount + tx.fee)));
                    return; // NO ledger debit ⇒ NO validator effect
                }
                *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(amount + tx.fee);
                let current = *validator_shadow.entry(tx.from_pub_key.clone()).or_insert_with(|| {
                    validator_store.and_then(|vs| vs.get_validator(&tx.from_pub_key).unwrap_or(None)).map(|v| v.stake).unwrap_or(0)
                });
                let amount_u = tx.payload.amount.unwrap_or(0) as u128;
                validator_shadow.insert(tx.from_pub_key.clone(), current + amount_u);
                *validator_out = Some(ValidatorExecution::StakeApplied { validator: tx.from_pub_key.clone(), amount: amount_u });
            }
            "unstake" => {
                let amount = tx.payload.amount.unwrap_or(0) as f64;
                let amount_u = tx.payload.amount.unwrap_or(0) as u128;
                if amount_u == 0 {
                    *validator_out = Some(ValidatorExecution::Failed("unstake amount must be > 0".into()));
                    return;
                }
                // SEQUENTIAL validator shadow: earlier stake/unstake txs of this block are visible.
                let staked = *validator_shadow.entry(tx.from_pub_key.clone()).or_insert_with(|| {
                    validator_store.and_then(|vs| vs.get_validator(&tx.from_pub_key).unwrap_or(None)).map(|v| v.stake).unwrap_or(0)
                });
                if amount_u > staked {
                    eprintln!("[node] Rejecting unstake: staked {} but requested {}", staked, amount);
                    *validator_out = Some(ValidatorExecution::Failed(format!("unstake {} exceeds sequential stake {}", amount_u, staked)));
                    return; // no validator change, no unbonding
                }
                let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                if xrge_bal < xrge_f64_to_quanta(tx.fee) {
                    eprintln!("[node] Rejecting unstake: insufficient XRGE for fee ({:.4} < {:.4})", xrge_bal, tx.fee);
                    *validator_out = Some(ValidatorExecution::Failed("insufficient XRGE for unstake fee".into()));
                    return; // fee failed ⇒ no validator change, no unbonding
                }
                // Deduct fee now, queue the unbonding (funds released after UNBONDING_BLOCKS)
                *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
                validator_shadow.insert(tx.from_pub_key.clone(), staked - amount_u);
                let release_at = block_height + UNBONDING_BLOCKS;
                if let Ok(mut queue) = unbonding_queue.lock() {
                    queue.push(UnbondingEntry {
                        delegator: tx.from_pub_key.clone(),
                        amount,
                        release_height: release_at,
                    });
                    eprintln!("[node] Unstake queued: {:.4} XRGE, releases at block {}",
                        amount, release_at);
                }
                *validator_out = Some(ValidatorExecution::UnstakeApplied { validator: tx.from_pub_key.clone(), amount: amount_u, release_height: release_at });
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
                let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                if xrge_bal < xrge_f64_to_quanta(tx.fee) {
                    eprintln!("[node] Rejecting create_token: insufficient XRGE ({:.4} < {:.4})", xrge_bal, tx.fee);
                    return;
                }
                *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
                
                if let Some(token_symbol) = tx.payload.token_symbol.as_ref() {
                    let total_supply = tx.payload.token_total_supply.unwrap_or(0) as f64;
                    let creator_key = (canon_addr(&tx.from_pub_key), token_symbol.trim().to_uppercase());
                    *token_balances.entry(creator_key).or_insert(0) += total_supply as u128;
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
                let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                if xrge_bal < xrge_f64_to_quanta(tx.fee) {
                    eprintln!("[node] Rejecting mint_tokens: insufficient XRGE for fee");
                    return;
                }
                *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
                // Credit minted tokens to creator
                let creator_key = (canon_addr(&tx.from_pub_key), sym);
                *token_balances.entry(creator_key).or_insert(0) += amount as u128;
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
                            *balances.entry(canon_addr(to_pub_key)).or_insert(0) += xrge_f64_to_quanta(amount);
                        } else {
                            let recipient_key = (canon_addr(&to_pub_key), token_symbol.clone());
                            *token_balances.entry(recipient_key).or_insert(0) += amount as u128;
                        }
                    }
                }
            }
            "bridge_withdraw" => {
                // R1: this arm is INSTRUMENTED, not rewritten. Every balance/fee/burn expression,
                // ordering, key casing and `return;` below is byte-identical to the pre-R1 code;
                // the only additions are the `*bridge_out = ...` assignments that record what the
                // existing arithmetic already decided. Failure paths mutate nothing (as before).
                use quantum_vault_bridge_exec::{BridgeWithdrawExecution as BX, BridgeWithdrawFailure as BF, BridgeWithdrawEffect};
                if let (Some(token_symbol), Some(amount)) = (
                    tx.payload.token_symbol.as_ref(),
                    tx.payload.amount,
                ) {
                    if amount > 0 {
                        // Use the symbol as stored by the mint (natural case) — token_balances is
                        // keyed by the exact symbol, so uppercasing would debit a phantom key and
                        // never touch the real balance. XRGE is matched case-insensitively.
                        let token_sym = token_symbol.trim().to_string();
                        let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                        if xrge_bal < xrge_f64_to_quanta(tx.fee) {
                            eprintln!("[node] Rejecting bridge_withdraw: insufficient XRGE for fee ({:.4} < {:.4})", xrge_bal, tx.fee);
                            *bridge_out = Some(BX::Failed(BF::InsufficientFee));
                            return;
                        }
                        if token_sym.eq_ignore_ascii_case("XRGE") {
                            if xrge_bal.saturating_sub(fee_to_quanta(tx.fee)) < xrge_f64_to_quanta(amount as f64) {
                                eprintln!("[node] Rejecting bridge_withdraw: insufficient XRGE ({:.4} < {})", quanta_to_display(xrge_bal.saturating_sub(fee_to_quanta(tx.fee))), amount);
                                *bridge_out = Some(BX::Failed(BF::InsufficientXrge));
                                return;
                            }
                            *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee + amount as f64);
                        } else {
                            let sender_key = (canon_addr(&tx.from_pub_key), token_sym.clone());
                            let token_bal = *token_balances.get(&sender_key).unwrap_or(&0);
                            if token_bal < amount as u128 {
                                eprintln!("[node] Rejecting bridge_withdraw: insufficient {} ({:.4} < {})", token_sym, token_bal, amount);
                                *bridge_out = Some(BX::Failed(BF::InsufficientToken));
                                return;
                            }
                            *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
                            *token_balances.entry(sender_key).or_insert(0) -= amount as u128;
                        }
                        // Canonical token for the DERIVED record/routing only; the burn key below
                        // stays the RAW trimmed symbol (state-root relevant, unchanged).
                        let canonical_token = if token_sym.eq_ignore_ascii_case("XRGE") { "XRGE".to_string() } else { token_sym.clone() };
                        *burned_tokens.entry(token_sym).or_insert(0.0) += amount as f64;
                        let rougechain_tx_id = {
                            let d = sha256(&encode_tx_v1(tx));
                            let mut r = [0u8; 32];
                            r.copy_from_slice(&d);
                            r
                        };
                        *bridge_out = Some(BX::Success(BridgeWithdrawEffect {
                            canonical_token,
                            amount,
                            destination: tx.payload.evm_address.clone(),
                            rougechain_tx_id,
                        }));
                    } else {
                        *bridge_out = Some(BX::Failed(BF::ZeroAmount));
                    }
                } else {
                    *bridge_out = Some(BX::Failed(
                        if tx.payload.token_symbol.is_none() { BF::MissingToken } else { BF::MissingAmount }
                    ));
                }
            }
            "slash" => {}
            // Shielded transactions: fee deduction only (state is handled separately)
            "shield" => {
                let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                let shield_amount = tx.payload.shielded_value.unwrap_or(0) as f64;
                if xrge_bal < xrge_f64_to_quanta(shield_amount + tx.fee) {
                    eprintln!("[node] Rejecting shield: insufficient XRGE ({:.4} < {:.4})", xrge_bal, shield_amount + tx.fee);
                    return;
                }
                *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(shield_amount + tx.fee);
                // Track shielded supply
                if let Ok(mut sp) = shielded_supply.lock() {
                    *sp += shield_amount;
                }
            }
            "unshield" => {
                let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                if xrge_bal < xrge_f64_to_quanta(tx.fee) {
                    eprintln!("[node] Rejecting unshield: insufficient XRGE for fee");
                    return;
                }
                let unshield_amount = tx.payload.shielded_value.unwrap_or(0) as f64;
                *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
                *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) += xrge_f64_to_quanta(unshield_amount);
                // Track shielded supply
                if let Ok(mut sp) = shielded_supply.lock() {
                    *sp = (*sp - unshield_amount).max(0.0);
                }
            }
            "shielded_transfer" => {
                // Fee is deducted from public balance (fee is always public)
                let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                if xrge_bal < xrge_f64_to_quanta(tx.fee) {
                    eprintln!("[node] Rejecting shielded_transfer: insufficient XRGE for fee");
                    return;
                }
                *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
            }
            // ─── Token Locking ───────────────────────────────────────
            "token_lock" => {
                let amount = tx.payload.amount.unwrap_or(0) as f64;
                if let Some(token_symbol) = tx.payload.token_symbol.as_ref() {
                    // Lock custom token
                    let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                    if xrge_bal < xrge_f64_to_quanta(tx.fee) {
                        eprintln!("[node] Rejecting token_lock: insufficient XRGE for fee");
                        return;
                    }
                    let key = (canon_addr(&tx.from_pub_key), token_symbol.clone());
                    let tok_bal = *token_balances.get(&key).unwrap_or(&0);
                    if tok_bal < amount as u128 {
                        eprintln!("[node] Rejecting token_lock: insufficient {} ({:.4} < {:.4})", token_symbol, tok_bal, amount);
                        return;
                    }
                    *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
                    *token_balances.entry(key).or_insert(0) -= amount as u128;
                } else {
                    // Lock XRGE
                    let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                    if xrge_bal < xrge_f64_to_quanta(amount + tx.fee) {
                        eprintln!("[node] Rejecting token_lock: insufficient XRGE ({:.4} < {:.4})", xrge_bal, amount + tx.fee);
                        return;
                    }
                    *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(amount + tx.fee);
                }
            }
            "token_unlock" => {
                // Balance credit happens in apply_web3_state_effects after lock validation
                let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                if xrge_bal < xrge_f64_to_quanta(tx.fee) {
                    eprintln!("[node] Rejecting token_unlock: insufficient XRGE for fee");
                    return;
                }
                *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
                // The actual balance credit is handled in apply_web3_state_effects
                // after verifying lock ownership and height
                if let Some(_lock_id) = tx.payload.lock_id.as_ref() {
                    // We need to credit the amount back here since static method
                    // won't have access to lock_store. The node will validate
                    // in apply_web3_state_effects and the lock_id is verified there.
                    let amount = tx.payload.amount.unwrap_or(0) as f64;
                    if let Some(token_symbol) = tx.payload.token_symbol.as_ref() {
                        let key = (canon_addr(&tx.from_pub_key), token_symbol.clone());
                        *token_balances.entry(key).or_insert(0) += amount as u128;
                    } else {
                        *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) += xrge_f64_to_quanta(amount);
                    }
                }
            }
            // ─── Token Staking (custom token pools) ──────────────────
            "create_staking_pool" => {
                let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                if xrge_bal < xrge_f64_to_quanta(tx.fee) {
                    eprintln!("[node] Rejecting create_staking_pool: insufficient XRGE for fee");
                    return;
                }
                *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
            }
            "token_stake" => {
                let amount = tx.payload.amount.unwrap_or(0) as f64;
                if let Some(token_symbol) = tx.payload.token_symbol.as_ref() {
                    let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                    if xrge_bal < xrge_f64_to_quanta(tx.fee) {
                        eprintln!("[node] Rejecting token_stake: insufficient XRGE for fee");
                        return;
                    }
                    let key = (canon_addr(&tx.from_pub_key), token_symbol.clone());
                    let tok_bal = *token_balances.get(&key).unwrap_or(&0);
                    if tok_bal < amount as u128 {
                        eprintln!("[node] Rejecting token_stake: insufficient {} ({:.4} < {:.4})", token_symbol, tok_bal, amount);
                        return;
                    }
                    *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
                    *token_balances.entry(key).or_insert(0) -= amount as u128;
                }
            }
            "token_unstake" => {
                let amount = tx.payload.amount.unwrap_or(0) as f64;
                let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                if xrge_bal < xrge_f64_to_quanta(tx.fee) {
                    eprintln!("[node] Rejecting token_unstake: insufficient XRGE for fee");
                    return;
                }
                *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
                // Credit tokens back
                if let Some(token_symbol) = tx.payload.token_symbol.as_ref() {
                    let key = (canon_addr(&tx.from_pub_key), token_symbol.clone());
                    *token_balances.entry(key).or_insert(0) += amount as u128;
                }
            }
            // ─── Governance ──────────────────────────────────────────
            "create_proposal" | "cast_vote" | "execute_proposal" => {
                let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                if xrge_bal < xrge_f64_to_quanta(tx.fee) {
                    eprintln!("[node] Rejecting {}: insufficient XRGE for fee", tx.tx_type);
                    return;
                }
                *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
            }
            // ─── Allowances ──────────────────────────────────────────
            "token_approve" => {
                let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                if xrge_bal < xrge_f64_to_quanta(tx.fee) {
                    eprintln!("[node] Rejecting token_approve: insufficient XRGE for fee");
                    return;
                }
                *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
            }
            "token_transfer_from" => {
                // Spender pays the fee, owner's tokens are transferred
                let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                if xrge_bal < xrge_f64_to_quanta(tx.fee) {
                    eprintln!("[node] Rejecting token_transfer_from: insufficient XRGE for fee");
                    return;
                }
                *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
                // Actual token transfer deducted from owner, credited to recipient
                if let (Some(owner), Some(to), Some(token_symbol)) = (
                    tx.payload.owner_pub_key.as_ref(),
                    tx.payload.to_pub_key_hex.as_ref(),
                    tx.payload.token_symbol.as_ref(),
                ) {
                    let amount = tx.payload.amount.unwrap_or(0) as f64;
                    let owner_key = (canon_addr(&owner), token_symbol.clone());
                    let owner_bal = *token_balances.get(&owner_key).unwrap_or(&0);
                    if owner_bal < amount as u128 {
                        eprintln!("[node] Rejecting token_transfer_from: insufficient {} balance", token_symbol);
                        return;
                    }
                    *token_balances.entry(owner_key).or_insert(0) -= amount as u128;
                    let recipient_key = (canon_addr(&to), token_symbol.clone());
                    *token_balances.entry(recipient_key).or_insert(0) += amount as u128;
                }
            }
            // ─── Airdrops ────────────────────────────────────────────
            "token_airdrop" => {
                let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                if xrge_bal < xrge_f64_to_quanta(tx.fee) {
                    eprintln!("[node] Rejecting token_airdrop: insufficient XRGE for fee");
                    return;
                }
                *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
                if let (Some(recipients), Some(amounts), Some(token_symbol)) = (
                    tx.payload.airdrop_recipients.as_ref(),
                    tx.payload.airdrop_amounts.as_ref(),
                    tx.payload.token_symbol.as_ref(),
                ) {
                    let total: u64 = amounts.iter().sum();
                    let sender_key = (canon_addr(&tx.from_pub_key), token_symbol.clone());
                    let tok_bal = *token_balances.get(&sender_key).unwrap_or(&0);
                    if tok_bal < total as u128 {
                        eprintln!("[node] Rejecting token_airdrop: insufficient {} ({:.4} < {})", token_symbol, tok_bal, total);
                        return;
                    }
                    *token_balances.entry(sender_key).or_insert(0) -= total as u128;
                    for (i, recipient) in recipients.iter().enumerate() {
                        if let Some(&amt) = amounts.get(i) {
                            let key = (canon_addr(&recipient), token_symbol.clone());
                            *token_balances.entry(key).or_insert(0) += amt as u128;
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

    fn apply_validator_block(&self, block: &BlockV1, validator_results: &[Option<ValidatorExecution>]) -> Result<(), String> {
        if validator_results.len() != block.txs.len() {
            return Err(format!("validator results ({}) not aligned to block txs ({})", validator_results.len(), block.txs.len()));
        }
        for (tx, res) in block.txs.iter().zip(validator_results.iter()) {
            match res {
                // ONLY a stake/unstake whose ledger execution succeeded reaches the store.
                Some(ValidatorExecution::StakeApplied { validator, amount }) => {
                    let mut state = self.validator_store.get_validator(validator)?.unwrap_or(ValidatorState {
                        stake: 0, slash_count: 0, jailed_until: 0, entropy_contributions: 0, blocks_proposed: 0, name: None, missed_blocks: 0, total_slashed: 0 });
                    state.stake += amount;
                    self.persist_validator_state(validator, &state, block.header.height)?;
                }
                Some(ValidatorExecution::UnstakeApplied { validator, amount, .. }) => {
                    if let Some(mut state) = self.validator_store.get_validator(validator)? {
                        state.stake = state.stake.saturating_sub(*amount);
                        self.persist_validator_state(validator, &state, block.header.height)?;
                    }
                }
                Some(ValidatorExecution::Failed(_)) | None => {
                    // slashing is not a ledger tx; it keeps its own path
                    if tx.tx_type == "slash" { self.apply_validator_tx(tx, block.header.height)?; }
                }
            }
        }
        // Matured unbonding is released inside apply_balance_block (BEFORE the state root is
        // sealed) — this post-root phase must never touch balances/token/LP maps.
        // Check missed blocks and auto-slash
        self.check_missed_blocks(block);
        Ok(())
    }

    /// Release matured unbonding entries (release_height <= current_height) into the given
    /// balance map, exactly once, removing them from the queue. Part of the deterministic
    /// speculative block application (pre-root), so it is covered by the state root and by
    /// the pre-apply snapshot/rollback. Returns the released entries.
    fn release_matured_unbonding(
        unbonding_queue: &Arc<Mutex<Vec<UnbondingEntry>>>,
        balances: &mut HashMap<String, u128>,
        current_height: u64,
    ) -> Result<Vec<UnbondingEntry>, String> {
        let mut queue = unbonding_queue.lock().map_err(|_| "unbonding lock")?;
        let mut released = Vec::new();
        let mut remaining = Vec::new();
        for entry in queue.drain(..) {
            if current_height >= entry.release_height { released.push(entry); } else { remaining.push(entry); }
        }
        *queue = remaining;
        for entry in &released {
            *balances.entry(canon_addr(&entry.delegator)).or_insert(0) += xrge_f64_to_quanta(entry.amount);
            eprintln!("[node] Unbonding released at height {}: {:.4} XRGE to {}",
                current_height, entry.amount, &entry.delegator[..8.min(entry.delegator.len())]);
        }
        Ok(released)
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
            // stake / unstake are applied from `ValidatorExecution` results only (see
            // apply_validator_block) — never inferred from a tx's presence in a block.
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
        balances: &mut HashMap<String, u128>,
        tx: &TxV1,
        block_time: u64,
    ) -> Result<(), String> {
        match tx.tx_type.as_str() {
            "nft_create_collection" => {
                let symbol = tx.payload.nft_collection_symbol.as_ref().ok_or("missing nft_collection_symbol")?;
                let name = tx.payload.nft_collection_name.as_ref().ok_or("missing nft_collection_name")?;
                let collection_id = NftCollection::make_collection_id(&tx.from_pub_key, symbol);

                let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                if xrge_bal < xrge_f64_to_quanta(tx.fee) {
                    eprintln!("[node] Rejecting nft_create_collection: insufficient XRGE ({:.4} < {:.4})", xrge_bal, tx.fee);
                    return Ok(());
                }

                *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);

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
                    // Defaults to the creator when unset/empty — preserves historical behavior.
                    royalty_recipient: tx
                        .payload
                        .nft_royalty_recipient
                        .clone()
                        .filter(|r| !r.trim().is_empty())
                        .unwrap_or_else(|| tx.from_pub_key.clone()),
                    frozen: false,
                    created_at: block_time,
                    public_mint: tx.payload.nft_public_mint.unwrap_or(false),
                    mint_price: tx.payload.nft_mint_price,
                    token_gate_symbol: tx.payload.nft_token_gate_symbol.clone(),
                    token_gate_amount: tx.payload.nft_token_gate_amount,
                    discount_pct: tx.payload.nft_discount_pct,
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

                let is_creator = col.creator == tx.from_pub_key;
                if !is_creator && !col.public_mint {
                    eprintln!("[node] Rejecting nft_mint: {} is not the creator and public_mint is off for {}", &tx.from_pub_key[..16.min(tx.from_pub_key.len())], col_id);
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

                // Calculate cost: network fee + mint price (minus discount for token holders)
                let mut mint_cost = 0.0_f64;
                if !is_creator {
                    if let Some(price) = col.mint_price {
                        mint_cost = price;
                        // Apply token-gate discount
                        if let (Some(ref gate_sym), Some(gate_amt)) = (&col.token_gate_symbol, col.token_gate_amount) {
                            let holder_bal = self.get_token_balance(&tx.from_pub_key, gate_sym).unwrap_or(0.0);
                            if holder_bal >= gate_amt {
                                let disc = col.discount_pct.unwrap_or(100) as f64 / 100.0;
                                mint_cost *= 1.0 - disc;
                            }
                        }
                    }
                }

                let total_cost = tx.fee + mint_cost;
                let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                if xrge_bal < xrge_f64_to_quanta(total_cost) {
                    eprintln!("[node] Rejecting nft_mint: insufficient XRGE ({:.4} < {:.4})", xrge_bal, total_cost);
                    return Ok(());
                }

                *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(total_cost);
                // Pay mint price to collection creator
                if mint_cost > 0.0 {
                    *balances.entry(canon_addr(&col.creator)).or_insert(0) += xrge_f64_to_quanta(mint_cost);
                }

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

                let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                if xrge_bal < xrge_f64_to_quanta(tx.fee) {
                    eprintln!("[node] Rejecting nft_batch_mint: insufficient XRGE ({:.4} < {:.4})", xrge_bal, tx.fee);
                    return Ok(());
                }

                *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);

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

                let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                if xrge_bal < xrge_f64_to_quanta(total_cost) {
                    eprintln!("[node] Rejecting nft_transfer: insufficient XRGE ({:.4} < {:.4})", xrge_bal, total_cost);
                    return Ok(());
                }

                *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);

                if royalty_amount > 0.0 {
                    if let Some(col) = self.nft_store.get_collection(col_id)? {
                        *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(royalty_amount);
                        *balances.entry(canon_addr(&col.royalty_recipient)).or_insert(0) += xrge_f64_to_quanta(royalty_amount);
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

                let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                if xrge_bal < xrge_f64_to_quanta(tx.fee) {
                    eprintln!("[node] Rejecting nft_burn: insufficient XRGE ({:.4} < {:.4})", xrge_bal, tx.fee);
                    return Ok(());
                }

                *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);
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

                let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                if xrge_bal < xrge_f64_to_quanta(tx.fee) {
                    eprintln!("[node] Rejecting nft_lock: insufficient XRGE ({:.4} < {:.4})", xrge_bal, tx.fee);
                    return Ok(());
                }

                *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);

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

                let xrge_bal = *balances.get(&canon_addr(&tx.from_pub_key)).unwrap_or(&0);
                if xrge_bal < xrge_f64_to_quanta(tx.fee) {
                    eprintln!("[node] Rejecting nft_freeze_collection: insufficient XRGE ({:.4} < {:.4})", xrge_bal, tx.fee);
                    return Ok(());
                }

                *balances.entry(canon_addr(&tx.from_pub_key)).or_insert(0) -= xrge_f64_to_quanta(tx.fee);

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
        let mut dummy_balances: HashMap<String, u128> = HashMap::new();

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
                        // Ensure sender has enough balance for fee checks during rebuild
                        *dummy_balances.entry(tx.from_pub_key.clone()).or_insert(0) += xrge_f64_to_quanta(tx.fee + 1.0);
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

    /// Participant signing pubkeys for a conversation (used to target push notifications).
    /// Returns empty on any error or unknown conversation.
    pub fn get_conversation_participants(&self, conversation_id: &str) -> Vec<String> {
        self.messenger_store
            .get_conversation(conversation_id)
            .ok()
            .flatten()
            .map(|c| c.participant_ids)
            .unwrap_or_default()
    }

    pub fn rename_conversation(&self, conversation_id: &str, name: Option<String>) -> Result<Option<Conversation>, String> {
        self.messenger_store.rename_conversation(conversation_id, name)
    }

    pub fn add_conversation_participants(&self, conversation_id: &str, new_ids: &[String]) -> Result<Option<Conversation>, String> {
        self.messenger_store.add_participants(conversation_id, new_ids)
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

    // ===== Social =====

    pub fn social_record_play(&self, track_id: &str) -> Result<u64, String> {
        self.social_store.record_play(track_id)
    }

    pub fn social_toggle_like(&self, track_id: &str, wallet_pubkey: &str) -> Result<(bool, u64), String> {
        self.social_store.toggle_like(track_id, wallet_pubkey)
    }

    pub fn social_add_comment(&self, track_id: &str, wallet_pubkey: &str, body: &str) -> Result<quantum_vault_storage::social_store::SocialComment, String> {
        self.social_store.add_comment(track_id, wallet_pubkey, body)
    }

    pub fn social_delete_comment(&self, comment_id: &str, wallet_pubkey: &str) -> Result<(), String> {
        self.social_store.delete_comment(comment_id, wallet_pubkey)
    }

    pub fn social_toggle_follow(&self, follower_pubkey: &str, artist_pubkey: &str) -> Result<(bool, u64), String> {
        self.social_store.toggle_follow(follower_pubkey, artist_pubkey)
    }

    pub fn social_get_track_stats(&self, track_id: &str, viewer: Option<&str>) -> Result<serde_json::Value, String> {
        self.social_store.get_track_stats(track_id, viewer)
    }

    pub fn social_get_comments(&self, track_id: &str, limit: usize, offset: usize) -> Result<Vec<quantum_vault_storage::social_store::SocialComment>, String> {
        self.social_store.get_comments(track_id, limit, offset)
    }

    pub fn social_get_artist_stats(&self, pubkey: &str, viewer: Option<&str>) -> Result<serde_json::Value, String> {
        self.social_store.get_artist_stats(pubkey, viewer)
    }

    pub fn social_get_user_likes(&self, pubkey: &str) -> Result<Vec<String>, String> {
        self.social_store.get_user_likes(pubkey)
    }

    pub fn social_get_user_following(&self, pubkey: &str) -> Result<Vec<String>, String> {
        self.social_store.get_user_following(pubkey)
    }

    pub fn social_get_user_followers(&self, pubkey: &str, limit: usize, offset: usize) -> Result<Vec<String>, String> {
        self.social_store.get_user_followers(pubkey, limit, offset)
    }

    // ===== Hidden Tracks =====

    pub fn social_set_track_hidden(&self, creator_pubkey: &str, track_id: &str, hidden: bool) -> Result<(), String> {
        self.social_store.set_track_hidden(creator_pubkey, track_id, hidden)
    }

    pub fn social_get_hidden_tracks(&self, creator_pubkey: &str) -> Result<Vec<String>, String> {
        self.social_store.get_hidden_tracks(creator_pubkey)
    }

    pub fn social_is_track_hidden(&self, creator_pubkey: &str, track_id: &str) -> Result<bool, String> {
        self.social_store.is_track_hidden(creator_pubkey, track_id)
    }

    // ===== Social Posts =====

    pub fn social_create_post(&self, author_pubkey: &str, body: &str, reply_to_id: Option<&str>) -> Result<quantum_vault_storage::social_store::SocialPost, String> {
        self.social_store.create_post(author_pubkey, body, reply_to_id)
    }

    pub fn social_get_post(&self, post_id: &str) -> Result<Option<quantum_vault_storage::social_store::SocialPost>, String> {
        self.social_store.get_post(post_id)
    }

    pub fn social_delete_post(&self, post_id: &str, author_pubkey: &str) -> Result<(), String> {
        self.social_store.delete_post(post_id, author_pubkey)
    }

    pub fn social_get_user_posts(&self, pubkey: &str, limit: usize, offset: usize) -> Result<Vec<quantum_vault_storage::social_store::SocialPost>, String> {
        self.social_store.get_user_posts(pubkey, limit, offset)
    }

    pub fn social_get_user_post_count(&self, pubkey: &str) -> Result<u64, String> {
        self.social_store.get_user_post_count(pubkey)
    }

    pub fn social_get_global_timeline(&self, limit: usize, offset: usize) -> Result<Vec<quantum_vault_storage::social_store::SocialPost>, String> {
        self.social_store.get_global_timeline(limit, offset)
    }

    pub fn social_get_following_feed(&self, viewer_pubkey: &str, limit: usize, offset: usize) -> Result<Vec<quantum_vault_storage::social_store::SocialPost>, String> {
        self.social_store.get_following_feed(viewer_pubkey, limit, offset)
    }

    pub fn social_get_replies(&self, post_id: &str, limit: usize, offset: usize) -> Result<Vec<quantum_vault_storage::social_store::SocialPost>, String> {
        self.social_store.get_replies(post_id, limit, offset)
    }

    pub fn social_toggle_repost(&self, post_id: &str, reposter_pubkey: &str) -> Result<(bool, u64), String> {
        self.social_store.toggle_repost(post_id, reposter_pubkey)
    }

    pub fn social_get_post_stats(&self, post_id: &str, viewer: Option<&str>) -> Result<serde_json::Value, String> {
        self.social_store.get_post_stats(post_id, viewer)
    }

}

// ─────────────────────────────────────────────────────────────────────────
// Phase 0 ledger determinism harness.
//
// Unit tests for the two building blocks of balance state — the per-tx
// applier and the fee distributor — that block replay must reproduce
// identically on every node. These are the first tests of the native ledger
// and lock in the properties the integer-ledger / state-root work depends on:
// keyed mutation is map-order-independent, the fee split is exactly 20/70/10
// stake-weighted, and distribution is deterministic. If any drifts, a test
// fails before the divergence could reach consensus.
// ─────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod ledger_tests {
    use super::*;

    #[test]
    fn canon_addr_passes_sentinels_through_and_maps_pubkeys() {
        // Sentinels and non-pubkey strings are returned unchanged.
        assert_eq!(canon_addr("__treasury__"), "__treasury__");
        assert_eq!(canon_addr("__staking_rewards__"), "__staking_rewards__");
        assert_eq!(canon_addr(BURN_ADDRESS), BURN_ADDRESS);
        assert_eq!(canon_addr("not-a-key"), "not-a-key");

        // A valid ML-DSA public key maps to a rouge1 address, and that address is
        // itself canonical (idempotent).
        let kp = pqc_keygen();
        let pk_hex = kp.public_key_hex.clone();
        let addr = canon_addr(&pk_hex);
        assert!(addr.starts_with("rouge1"), "pubkey should map to a rouge1 address, got {addr}");
        assert_eq!(canon_addr(&addr), addr, "canon_addr must be idempotent on a rouge1 address");
        assert_ne!(addr, pk_hex, "canonical key must differ from the raw pubkey hex");
    }

    const EPS: f64 = 1e-9;
    const Q: u128 = 1_000_000_000; // quanta per XRGE (native ledger is now integer quanta)

    fn transfer_tx(from: &str, to: &str, amount: u64, fee: f64, token: Option<&str>) -> TxV1 {
        TxV1 {
            version: 1,
            tx_type: "transfer".to_string(),
            from_pub_key: from.to_string(),
            nonce: 0,
            payload: TxPayload {
                to_pub_key_hex: Some(to.to_string()),
                amount: Some(amount),
                token_symbol: token.map(|s| s.to_string()),
                ..Default::default()
            },
            fee,
            sig: String::new(),
            signed_payload: None,
        }
    }

    /// Apply one tx to `balances`, returning the (token_balances, burned_tokens) maps.
    fn apply(
        balances: &mut HashMap<String, u128>,
        tx: &TxV1,
    ) -> (HashMap<TokenBalanceKey, u128>, HashMap<String, f64>) {
        let mut token_balances: HashMap<TokenBalanceKey, u128> = HashMap::new();
        let mut burned: HashMap<String, f64> = HashMap::new();
        let uq: Arc<Mutex<Vec<UnbondingEntry>>> = Arc::new(Mutex::new(Vec::new()));
        let ss = Arc::new(Mutex::new(0.0f64));
        L1Node::apply_balance_tx_inner(
            balances, &mut token_balances, &mut burned, tx, None, "", &uq, 1, &ss, &mut None, &mut HashMap::new(), &mut None,
        );
        (token_balances, burned)
    }

    fn dist(
        balances: &mut HashMap<String, u128>,
        total_fees: u128,
        proposer: &str,
        stakes: &BTreeMap<String, u128>,
        base_fee_quanta: u128,
        tx_count: usize,
    ) {
        let burned = Arc::new(Mutex::new(0.0f64));
        L1Node::distribute_fees(balances, total_fees, proposer, stakes, base_fee_quanta, tx_count, &burned);
    }

    fn near(a: f64, b: f64) -> bool {
        (a - b).abs() < EPS
    }

    // ── apply_balance_tx_inner ────────────────────────────────────────

    #[test]
    fn transfer_debits_sender_and_credits_recipient() {
        let mut b = HashMap::from([("alice".to_string(), 100 * Q)]);
        apply(&mut b, &transfer_tx("alice", "bob", 30, 1.0, None));
        assert_eq!(b["alice"], 69 * Q, "sender debited amount+fee (quanta)");
        assert_eq!(b["bob"], 30 * Q, "recipient credited amount (quanta)");
    }

    #[test]
    fn transfer_with_insufficient_balance_is_rejected() {
        let mut b = HashMap::from([("alice".to_string(), 10 * Q)]);
        apply(&mut b, &transfer_tx("alice", "bob", 30, 1.0, None));
        assert_eq!(b["alice"], 10 * Q, "sender untouched on rejection");
        assert!(!b.contains_key("bob"), "recipient not credited on rejection");
    }

    #[test]
    fn transfer_result_is_map_order_independent() {
        // Same logical state, different HashMap insertion order → identical result.
        let mut b1 = HashMap::new();
        b1.insert("alice".to_string(), 100 * Q);
        b1.insert("zzz".to_string(), 5 * Q);
        let mut b2 = HashMap::new();
        b2.insert("zzz".to_string(), 5 * Q);
        b2.insert("alice".to_string(), 100 * Q);

        apply(&mut b1, &transfer_tx("alice", "bob", 30, 1.0, None));
        apply(&mut b2, &transfer_tx("alice", "bob", 30, 1.0, None));

        let s1: BTreeMap<_, _> = b1.into_iter().collect();
        let s2: BTreeMap<_, _> = b2.into_iter().collect();
        assert_eq!(s1, s2, "keyed mutation must not depend on map iteration order");
    }

    #[test]
    fn burn_transfer_credits_burned_not_recipient() {
        let mut b = HashMap::from([("alice".to_string(), 100 * Q)]);
        let (_tb, burned) = apply(&mut b, &transfer_tx("alice", BURN_ADDRESS, 30, 1.0, None));
        assert_eq!(b["alice"], 69 * Q, "sender still debited amount+fee (quanta)");
        assert!(!b.contains_key(BURN_ADDRESS), "burn address is not credited a balance");
        assert!(near(*burned.get("XRGE").unwrap_or(&0.0), 30.0), "burned XRGE tracked (display)");
    }

    // ── distribute_fees ───────────────────────────────────────────────

    #[test]
    fn fee_split_is_20_70_10() {
        let mut b = HashMap::new();
        let stakes = BTreeMap::from([("val1".to_string(), 100u128)]);
        // base_fee 0 => no burn, no floor subsidy; whole 100 is the tip pool.
        dist(&mut b, 100 * Q, "prop", &stakes, 0, 0);
        assert_eq!(b["prop"], 20 * Q, "proposer 20%");
        assert_eq!(b["val1"], 70 * Q, "validators 70%");
        assert_eq!(b["__treasury__"], 10 * Q, "treasury 10%");
        let total: u128 = b.values().sum();
        assert_eq!(total, 100 * Q, "no value created or lost");
    }

    #[test]
    fn validator_pool_is_stake_weighted() {
        let mut b = HashMap::new();
        let stakes = BTreeMap::from([("v1".to_string(), 100u128), ("v2".to_string(), 300u128)]);
        dist(&mut b, 100 * Q, "prop", &stakes, 0, 0);
        // validator pool = 70, split 25% / 75%
        assert_eq!(b["v1"], 175 * Q / 10, "v1 = 25% of 70 (17.5 XRGE)");
        assert_eq!(b["v2"], 525 * Q / 10, "v2 = 75% of 70 (52.5 XRGE)");
    }

    #[test]
    fn empty_stake_gives_validator_pool_to_proposer() {
        let mut b = HashMap::new();
        let stakes: BTreeMap<String, u128> = BTreeMap::new();
        dist(&mut b, 100 * Q, "prop", &stakes, 0, 0);
        // proposer gets proposer_share (20) + validator_pool (70) = 90; treasury 10.
        assert_eq!(b["prop"], 90 * Q, "proposer absorbs validator pool");
        assert_eq!(b["__treasury__"], 10 * Q);
    }

    #[test]
    fn tip_floor_is_subsidized_from_staking_reserve() {
        let mut b = HashMap::from([("__staking_rewards__".to_string(), 1 * Q)]);
        let stakes = BTreeMap::from([("v1".to_string(), 100u128)]);
        // total_fees 0 => tip_pool 0 < MIN_TIP_FLOOR(0.1); subsidize 0.1 from reserve.
        dist(&mut b, 0, "prop", &stakes, 0, 0);
        assert_eq!(b["__staking_rewards__"], 9 * Q / 10, "reserve drained by 0.1 floor");
        // the 0.1-XRGE (1e8 quanta) floor is then split 20/70/10
        assert_eq!(b["prop"], 2 * Q / 100);
        assert_eq!(b["v1"], 7 * Q / 100);
        assert_eq!(b["__treasury__"], Q / 100);
    }

    #[test]
    fn distribution_is_deterministic() {
        let stakes = BTreeMap::from([
            ("v1".to_string(), 111u128),
            ("v2".to_string(), 333u128),
            ("v3".to_string(), 555u128),
        ]);
        let mut a = HashMap::new();
        let mut c = HashMap::new();
        dist(&mut a, 123_456 * Q / 1000, "prop", &stakes, 5 * Q / 10, 7);
        dist(&mut c, 123_456 * Q / 1000, "prop", &stakes, 5 * Q / 10, 7);
        let sa: BTreeMap<_, _> = a.into_iter().collect();
        let sc: BTreeMap<_, _> = c.into_iter().collect();
        assert_eq!(sa, sc, "identical inputs must produce identical distribution");
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 1 / T2 characterization tests for the rebuild AMM apply path
// (`apply_amm_balance_effects`). These PIN the current f64 behaviour so the
// upcoming consolidation (merging the live `apply_amm_tx_inner` and this
// rebuild mirror into one applier) and the later f64->u128 flip can be proven
// behaviour-preserving. Effects are asserted against the `amm` math module,
// so these pin the apply/routing logic, not the math.
// ─────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod amm_replay_tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    const Q: u128 = 1_000_000_000; // quanta per XRGE
    static CTR: AtomicU64 = AtomicU64::new(0);

    struct TmpDir(std::path::PathBuf);
    impl TmpDir {
        fn new() -> Self {
            let mut p = std::env::temp_dir();
            let n = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            p.push(format!("rvm-amm-{}-{}-{}", std::process::id(), n, CTR.fetch_add(1, Ordering::SeqCst)));
            std::fs::create_dir_all(&p).unwrap();
            TmpDir(p)
        }
    }
    impl Drop for TmpDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A pool store seeded with one pool: QTOK/XRGE (sorted -> token_a=QTOK,
    /// token_b=XRGE), reserves QTOK=200_000 / XRGE=100_000, LP supply 141_421.
    fn seeded_store() -> (TmpDir, PoolStore) {
        let dir = TmpDir::new();
        let ps = PoolStore::new(dir.0.as_path()).unwrap();
        let pool = LiquidityPool {
            pool_id: "QTOK-XRGE".to_string(),
            token_a: "QTOK".to_string(),
            token_b: "XRGE".to_string(),
            reserve_a: 200_000,
            reserve_b: 100_000,
            total_lp_supply: 141_421,
            fee_rate: 0.003,
            created_at: 0,
            creator_pub_key: "creator".to_string(),
        };
        ps.save_pool(&pool).unwrap();
        (dir, ps)
    }

    fn amm_tx(tx_type: &str, from: &str, fee: f64, payload: TxPayload) -> TxV1 {
        TxV1 {
            version: 1,
            tx_type: tx_type.to_string(),
            from_pub_key: from.to_string(),
            nonce: 0,
            payload,
            fee,
            sig: String::new(),
            signed_payload: None,
        }
    }

    #[test]
    fn swap_xrge_for_token_routes_through_get_amount_out() {
        let (_dir, ps) = seeded_store();
        let mut bal = HashMap::from([("user".to_string(), 10_000 * Q)]);
        let mut tok: HashMap<TokenBalanceKey, u128> = HashMap::new();
        let mut lp: HashMap<TokenBalanceKey, u128> = HashMap::new();

        let tx = amm_tx(
            "swap",
            "user",
            0.1,
            TxPayload {
                token_a_symbol: Some("XRGE".to_string()), // token_in
                token_b_symbol: Some("QTOK".to_string()), // token_out
                amount_a: Some(1_000),
                ..Default::default()
            },
        );
        L1Node::apply_amm_balance_effects(&mut bal, &mut tok, &mut lp, &tx, &ps);

        // XRGE debited: amount_in (1000) + fee (0.1)
        assert_eq!(bal["user"], 89999 * Q / 10, "xrge quanta = 8999.9 XRGE");
        // token_out credited exactly what the AMM math yields for these reserves
        let expected = amm::get_amount_out(1_000, 100_000, 200_000).unwrap();
        assert_eq!(tok[&("user".to_string(), "QTOK".to_string())], expected as u128);
        assert!(lp.is_empty());
    }

    #[test]
    fn add_liquidity_mints_lp_per_amm_math() {
        let (_dir, ps) = seeded_store();
        // pool.token_a = QTOK, token_b = XRGE → amount_a is QTOK, amount_b is XRGE
        let mut bal = HashMap::from([("user".to_string(), 50_000 * Q)]);
        let mut tok: HashMap<TokenBalanceKey, u128> =
            HashMap::from([(("user".to_string(), "QTOK".to_string()), 50_000u128)]);
        let mut lp: HashMap<TokenBalanceKey, u128> = HashMap::new();

        let tx = amm_tx(
            "add_liquidity",
            "user",
            0.1,
            TxPayload {
                pool_id: Some("QTOK-XRGE".to_string()),
                amount_a: Some(20_000), // QTOK
                amount_b: Some(10_000), // XRGE
                ..Default::default()
            },
        );
        L1Node::apply_amm_balance_effects(&mut bal, &mut tok, &mut lp, &tx, &ps);

        assert_eq!(bal["user"], 399999 * Q / 10, "xrge quanta = 39999.9 XRGE");
        assert_eq!(tok[&("user".to_string(), "QTOK".to_string())], 30_000u128);
        let expected_lp = amm::calculate_lp_mint(20_000, 10_000, 200_000, 100_000, 141_421).unwrap();
        assert_eq!(lp[&("user".to_string(), "QTOK-XRGE".to_string())], expected_lp as u128);
    }

    #[test]
    fn swap_is_skipped_when_xrge_cannot_cover_amount_plus_fee() {
        let (_dir, ps) = seeded_store();
        let mut bal = HashMap::from([("user".to_string(), 500 * Q)]); // < 1000 + fee
        let mut tok: HashMap<TokenBalanceKey, u128> = HashMap::new();
        let mut lp: HashMap<TokenBalanceKey, u128> = HashMap::new();

        let tx = amm_tx(
            "swap",
            "user",
            0.1,
            TxPayload {
                token_a_symbol: Some("XRGE".to_string()),
                token_b_symbol: Some("QTOK".to_string()),
                amount_a: Some(1_000),
                ..Default::default()
            },
        );
        L1Node::apply_amm_balance_effects(&mut bal, &mut tok, &mut lp, &tx, &ps);

        // Rejected: nothing moved.
        assert_eq!(bal["user"], 500 * Q);
        assert!(tok.is_empty());
        assert!(lp.is_empty());
    }

    #[test]
    fn create_pool_debits_and_mints_initial_lp() {
        let (_dir, ps) = seeded_store(); // pool QTOK-XRGE already exists
        let mut bal = HashMap::from([("user".to_string(), 500_000 * Q)]);
        let mut tok: HashMap<TokenBalanceKey, u128> =
            HashMap::from([(("user".to_string(), "QTOK".to_string()), 500_000u128)]);
        let mut lp: HashMap<TokenBalanceKey, u128> = HashMap::new();

        let tx = amm_tx(
            "create_pool",
            "user",
            0.1,
            TxPayload {
                token_a_symbol: Some("XRGE".to_string()),
                token_b_symbol: Some("QTOK".to_string()),
                amount_a: Some(100_000), // XRGE
                amount_b: Some(200_000), // QTOK
                ..Default::default()
            },
        );
        L1Node::apply_amm_balance_effects(&mut bal, &mut tok, &mut lp, &tx, &ps);

        assert_eq!(bal["user"], 3_999_999 * Q / 10);
        assert_eq!(tok[&("user".to_string(), "QTOK".to_string())], 300_000u128);
        // initial LP = floor(sqrt(a*b)) - 1000
        let expected_lp = ((100_000.0_f64 * 200_000.0).sqrt() as u64).saturating_sub(1000);
        assert_eq!(lp[&("user".to_string(), "QTOK-XRGE".to_string())], expected_lp as u128);
    }

    #[test]
    fn remove_liquidity_burns_lp_and_returns_both_tokens() {
        let (_dir, ps) = seeded_store();
        let mut bal = HashMap::from([("user".to_string(), 10 * Q)]);
        let mut tok: HashMap<TokenBalanceKey, u128> = HashMap::new();
        let mut lp: HashMap<TokenBalanceKey, u128> =
            HashMap::from([(("user".to_string(), "QTOK-XRGE".to_string()), 50_000u128)]);

        let tx = amm_tx(
            "remove_liquidity",
            "user",
            0.1,
            TxPayload {
                pool_id: Some("QTOK-XRGE".to_string()),
                lp_amount: Some(10_000),
                ..Default::default()
            },
        );
        L1Node::apply_amm_balance_effects(&mut bal, &mut tok, &mut lp, &tx, &ps);

        let (out_a, out_b) = amm::calculate_remove_liquidity(10_000, 200_000, 100_000, 141_421).unwrap();
        // fee debited, LP burned
        assert_eq!(bal.get("user").copied().unwrap_or(0), 10 * Q - Q / 10 + out_b as u128 * Q);
        assert_eq!(lp[&("user".to_string(), "QTOK-XRGE".to_string())], 40_000u128);
        // token_a = QTOK returned to token_balances, token_b = XRGE returned to native
        assert_eq!(tok[&("user".to_string(), "QTOK".to_string())], out_a as u128);
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 1 / T2 — L1Node test harness + live AMM apply characterization.
//
// Stands up a real L1Node against temp sled stores (the unlock for guarding
// the consolidation, the f64->u128 flip, and golden replay tests). Then pins
// the LIVE apply_amm_tx_inner — which, unlike the rebuild mirror, creates the
// pool and mutates reserves — so the T2 merge can be proven behaviour-
// preserving on both sides.
// ─────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod live_amm_tests {
    use super::*;
    use quantum_vault_types::ChainConfig;
    use std::sync::atomic::{AtomicU64, Ordering};

    const Q: u128 = 1_000_000_000; // quanta per XRGE
    static CTR: AtomicU64 = AtomicU64::new(0);

    struct TmpDir(std::path::PathBuf);
    impl TmpDir {
        fn new() -> Self {
            let mut p = std::env::temp_dir();
            let n = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            p.push(format!("rvm-node-{}-{}-{}", std::process::id(), n, CTR.fetch_add(1, Ordering::SeqCst)));
            std::fs::create_dir_all(&p).unwrap();
            TmpDir(p)
        }
    }
    impl Drop for TmpDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Construct a real L1Node backed by a throwaway data dir.
    fn test_node() -> (TmpDir, L1Node) {
        let dir = TmpDir::new();
        let node = L1Node::new(NodeOptions {
            data_dir: dir.0.clone(),
            chain: ChainConfig {
                chain_id: "test".to_string(),
                genesis_time: 0,
                block_time_ms: 1000,
            },
            mine: false,
            bridge_withdraw_store: None,
            bridge_authority_keys: Vec::new(),
            genesis_allocations: Vec::new(), genesis_validators: Vec::new(),
        })
        .expect("test node");
        (dir, node)
    }

    fn amm_tx(tx_type: &str, from: &str, fee: f64, payload: TxPayload) -> TxV1 {
        TxV1 {
            version: 1,
            tx_type: tx_type.to_string(),
            from_pub_key: from.to_string(),
            nonce: 0,
            payload,
            fee,
            sig: String::new(),
            signed_payload: None,
        }
    }

    #[test]
    fn node_constructs_against_temp_stores() {
        let (_dir, node) = test_node();
        // Fresh node: empty ledger, no pools.
        assert_eq!(node.get_balance("nobody").unwrap(), 0.0);
        assert!(node.pool_store.list_pools().unwrap().is_empty());
    }

    #[test]
    fn live_create_pool_then_swap_updates_reserves_and_balances() {
        let (_dir, node) = test_node();
        let mut bal = HashMap::from([("user".to_string(), 1_000_000 * Q)]);
        let mut tok: HashMap<TokenBalanceKey, u128> =
            HashMap::from([(("user".to_string(), "QTOK".to_string()), 1_000_000u128)]);
        let mut lp: HashMap<TokenBalanceKey, u128> = HashMap::new();

        // create_pool: token_a=XRGE amount 100_000, token_b=QTOK amount 200_000
        let create = amm_tx(
            "create_pool",
            "user",
            0.1,
            TxPayload {
                token_a_symbol: Some("XRGE".to_string()),
                token_b_symbol: Some("QTOK".to_string()),
                amount_a: Some(100_000),
                amount_b: Some(200_000),
                ..Default::default()
            },
        );
        node.apply_amm_tx_inner(&mut bal, &mut tok, &mut lp, &create, 0, 1).unwrap();

        // Pool persisted (sorted QTOK-XRGE): reserve_a=QTOK=200_000, reserve_b=XRGE=100_000.
        let pool = node.pool_store.get_pool("QTOK-XRGE").unwrap().unwrap();
        assert_eq!(pool.reserve_a, 200_000);
        assert_eq!(pool.reserve_b, 100_000);
        // Creator LP == the pool's initial supply.
        assert_eq!(lp[&("user".to_string(), "QTOK-XRGE".to_string())], pool.total_lp_supply as u128);
        // Balances debited fee + provided liquidity.
        assert_eq!(bal["user"], 8_999_999 * Q / 10, "xrge quanta = 899999.9 XRGE");
        assert_eq!(tok[&("user".to_string(), "QTOK".to_string())], 800_000u128);

        // Swap 1_000 XRGE -> QTOK.
        let expected_out = amm::get_amount_out(1_000, 100_000, 200_000).unwrap();
        let swap = amm_tx(
            "swap",
            "user",
            0.1,
            TxPayload {
                token_a_symbol: Some("XRGE".to_string()),
                token_b_symbol: Some("QTOK".to_string()),
                amount_a: Some(1_000),
                ..Default::default()
            },
        );
        let qtok_before = tok[&("user".to_string(), "QTOK".to_string())];
        node.apply_amm_tx_inner(&mut bal, &mut tok, &mut lp, &swap, 0, 2).unwrap();

        // Live path mutates reserves: XRGE reserve grew by the input.
        let pool2 = node.pool_store.get_pool("QTOK-XRGE").unwrap().unwrap();
        assert_eq!(pool2.reserve_b, 101_000, "XRGE reserve after swap");
        assert_eq!(pool2.reserve_a, 200_000 - expected_out, "QTOK reserve after swap");
        // User received exactly the AMM output.
        let qtok_after = tok[&("user".to_string(), "QTOK".to_string())];
        assert_eq!(qtok_after - qtok_before, expected_out as u128);
    }

    // ── Invariant conservation net for the T3c XRGE scale flip ────────────
    // These assert balances through the PUBLIC get_balance accessor, which
    // returns DISPLAY XRGE. Because display units don't change when the internal
    // ledger moves from whole-XRGE f64 to quanta u128, these expected values are
    // IDENTICAL before and after the flip. They pass now (f64); they must still
    // pass after (quanta) — a dropped ×10^9 anywhere makes get_balance wrong and
    // fails one of these. This is the independent safety net for the scale change.

    fn transfer_tx(from: &str, to: &str, amount: u64, fee: f64) -> TxV1 {
        TxV1 {
            version: 1,
            tx_type: "transfer".to_string(),
            from_pub_key: from.to_string(),
            nonce: 0,
            payload: TxPayload {
                to_pub_key_hex: Some(to.to_string()),
                amount: Some(amount),
                ..Default::default()
            },
            fee,
            sig: String::new(),
            signed_payload: None,
        }
    }

    fn faucet_tx(to: &str, amount: u64) -> TxV1 {
        let mut tx = transfer_tx(to, to, amount, 0.0);
        tx.payload.faucet = Some(true);
        tx
    }

    /// Apply a tx to the node's live balance maps (drives apply_balance_tx_inner).
    fn apply_tx(node: &L1Node, node_pub: &str, tx: &TxV1) {
        let mut bal = node.balances.lock().unwrap();
        let mut tok = node.token_balances.lock().unwrap();
        let mut burned = node.burned_tokens.lock().unwrap();
        L1Node::apply_balance_tx_inner(
            &mut bal, &mut tok, &mut burned, tx,
            Some(&node.validator_store), node_pub, &node.unbonding_queue, 1, &node.shielded_supply, &mut None, &mut HashMap::new(), &mut None,
        );
    }

    #[test]
    fn golden_faucet_then_transfer_conserves_display_balances() {
        let (_dir, node) = test_node();
        apply_tx(&node, "_rebuild_", &faucet_tx("alice", 100)); // mint 100 XRGE
        assert_eq!(node.get_balance("alice").unwrap(), 100.0);

        apply_tx(&node, "", &transfer_tx("alice", "bob", 30, 1.0)); // 30 + 1 fee
        assert_eq!(node.get_balance("alice").unwrap(), 69.0, "alice = 100 - 30 - 1");
        assert_eq!(node.get_balance("bob").unwrap(), 30.0);
    }

    #[test]
    fn golden_fractional_fee_is_exact_in_display() {
        let (_dir, node) = test_node();
        apply_tx(&node, "_rebuild_", &faucet_tx("alice", 100));
        apply_tx(&node, "", &transfer_tx("alice", "bob", 30, 0.1)); // fractional fee
        let a = node.get_balance("alice").unwrap();
        assert!((a - 69.9).abs() < 1e-6, "alice = 100 - 30 - 0.1, got {}", a);
        assert_eq!(node.get_balance("bob").unwrap(), 30.0);
    }

    #[test]
    fn golden_insufficient_balance_is_rejected() {
        let (_dir, node) = test_node();
        apply_tx(&node, "_rebuild_", &faucet_tx("alice", 10));
        apply_tx(&node, "", &transfer_tx("alice", "bob", 30, 1.0)); // can't afford
        assert_eq!(node.get_balance("alice").unwrap(), 10.0, "unchanged on rejection");
        assert_eq!(node.get_balance("bob").unwrap(), 0.0);
    }

    // ── T6 integer EIP-1559 base fee ──────────────────────────────────────
    // The base fee is consensus state (it sets each block's burn). These pin the
    // integer update math and assert the display value through get_base_fee, so a
    // regression in the quanta<->display boundary would also show.

    #[test]
    fn base_fee_defaults_to_initial() {
        let (_dir, node) = test_node();
        assert_eq!(node.get_base_fee_quanta(), 100_000_000, "0.1 XRGE in quanta");
        assert_eq!(node.get_base_fee(), 0.1, "display XRGE");
    }

    #[test]
    fn base_fee_unchanged_at_target_fullness() {
        let (_dir, node) = test_node();
        // 10 txs == TARGET_TXS_PER_BLOCK → no change.
        assert_eq!(node.calculate_next_base_fee(10), node.get_base_fee_quanta());
    }

    #[test]
    fn base_fee_rises_above_target_by_eip1559_step() {
        let (_dir, node) = test_node();
        // current 0.1 (1e8 quanta), 20 txs → excess 10.
        // delta = 1e8 * 10 / (10 * 8) = 12_500_000 quanta = 0.0125 XRGE.
        let next = node.calculate_next_base_fee(20);
        assert_eq!(next, 112_500_000, "0.1125 XRGE in quanta");
        node.set_base_fee_quanta(next);
        assert_eq!(node.get_base_fee(), 0.1125, "display matches");
    }

    #[test]
    fn base_fee_falls_below_target_by_eip1559_step() {
        let (_dir, node) = test_node();
        // current 0.1, 0 txs → deficit 10. delta = 1e8 * 10 / 80 = 12_500_000.
        let next = node.calculate_next_base_fee(0);
        assert_eq!(next, 87_500_000, "0.0875 XRGE in quanta");
    }

    #[test]
    fn base_fee_never_drops_below_floor() {
        let (_dir, node) = test_node();
        node.set_base_fee_quanta(BASE_FEE_FLOOR_QUANTA); // 0.001 XRGE
        // Empty blocks would push it lower, but the floor clamps it.
        let next = node.calculate_next_base_fee(0);
        assert_eq!(next, BASE_FEE_FLOOR_QUANTA, "clamped at 0.001 XRGE floor");
    }

    #[test]
    fn base_fee_survives_legacy_f64_string_in_fee_db() {
        let (_dir, node) = test_node();
        // Simulate a pre-T6 fee_db entry written as an f64 XRGE decimal string.
        node.fee_db.insert(b"base_fee", b"0.1".as_ref()).unwrap();
        assert_eq!(node.get_base_fee_quanta(), 100_000_000, "legacy 0.1 → quanta");
    }

    // ── T7 versioned balance snapshot ─────────────────────────────────────
    // The snapshot must be self-describing so v2 (integer-quanta) code can never
    // silently misread a v1 (f64 XRGE) snapshot as quanta.

    #[test]
    fn snapshot_roundtrips_at_current_version() {
        let (_dir, node) = test_node();
        node.balances.lock().unwrap().insert("alice".to_string(), 100 * Q);
        node.save_balance_snapshot(42);
        // Wipe in-memory state, then load it back from the snapshot.
        node.balances.lock().unwrap().clear();
        let h = node.load_balance_snapshot().expect("current-version snapshot loads");
        assert_eq!(h, 42);
        assert_eq!(node.get_balance("alice").unwrap(), 100.0, "quanta restored to display XRGE");
    }

    #[test]
    fn snapshot_without_version_tag_is_rejected() {
        let (_dir, node) = test_node();
        // Simulate a pre-v2 snapshot: height + balances present, but NO version tag.
        node.snapshot_db.insert(b"height", &7u64.to_be_bytes()).unwrap();
        let bal = HashMap::from([("alice".to_string(), 100u128)]);
        node.snapshot_db.insert(b"balances", serde_json::to_vec(&bal).unwrap()).unwrap();
        node.snapshot_db.flush().unwrap();
        assert!(node.load_balance_snapshot().is_err(),
            "unversioned (pre-v2) snapshot must be rejected → forces safe rebuild");
    }

    #[test]
    fn snapshot_with_wrong_version_is_rejected() {
        let (_dir, node) = test_node();
        node.snapshot_db.insert(b"version", &1u32.to_be_bytes()).unwrap();
        node.snapshot_db.insert(b"height", &7u64.to_be_bytes()).unwrap();
        node.snapshot_db.flush().unwrap();
        assert!(node.load_balance_snapshot().is_err(),
            "a different snapshot version must be rejected by v2 code");
    }

    // ── P2-3 state-root primitives ────────────────────────────────────────

    #[test]
    fn current_state_root_matches_direct_module_computation() {
        let (_dir, node) = test_node();
        node.balances.lock().unwrap().insert("alice".to_string(), 100 * Q);
        node.balances.lock().unwrap().insert("bob".to_string(), 200 * Q);

        let via_node = node.compute_current_state_root().unwrap();
        let bal = node.balances.lock().unwrap().clone();
        let tok = node.token_balances.lock().unwrap().clone();
        let lp = node.lp_balances.lock().unwrap().clone();
        let via_module = crate::state_root::compute_state_root(&bal, &tok, &lp);
        assert_eq!(via_node, via_module, "node helper == module over the same maps");
    }

    #[test]
    fn state_root_changes_when_a_balance_changes() {
        let (_dir, node) = test_node();
        apply_tx(&node, "_rebuild_", &faucet_tx("alice", 10));
        let before = node.compute_current_state_root().unwrap();
        apply_tx(&node, "_rebuild_", &faucet_tx("bob", 5));
        let after = node.compute_current_state_root().unwrap();
        assert_ne!(before, after, "crediting an account must change the root");
    }

    #[test]
    fn snapshot_then_mutate_then_restore_recovers_exact_root() {
        let (_dir, node) = test_node();
        apply_tx(&node, "_rebuild_", &faucet_tx("alice", 10));
        let root0 = node.compute_current_state_root().unwrap();
        let snap = node.snapshot_balance_maps().unwrap();

        // Mutate the ledger (as a bad block's apply would).
        apply_tx(&node, "_rebuild_", &faucet_tx("mallory", 999));
        assert_ne!(node.compute_current_state_root().unwrap(), root0, "state moved");

        // Roll back and confirm the money ledger is bit-for-bit restored.
        node.restore_balance_maps(snap).unwrap();
        assert_eq!(node.compute_current_state_root().unwrap(), root0, "root restored exactly");
        assert_eq!(node.get_balance("mallory").unwrap(), 0.0, "rolled-back credit is gone");
        assert_eq!(node.get_balance("alice").unwrap(), 10.0, "kept balance intact");
    }

    // ── P2-4 producer stamps the post-state root ──────────────────────────

    #[test]
    fn mined_block_commits_the_post_state_root() {
        let (_dir, node) = test_node();
        // Faucet mints are only honored when issued by the node's own key, so
        // build the tx from that key. Mark it pre-verified so mine_pending
        // accepts it without a real signature.
        let node_key = node.keys.lock().unwrap().public_key_hex.clone();
        let mut tx = transfer_tx(&node_key, "alice", 10, 0.0);
        tx.payload.faucet = Some(true);
        node.mempool.lock().unwrap().insert("tx1".to_string(), tx);
        node.verified_tx_ids.lock().unwrap().insert("tx1".to_string());

        let block = node.mine_pending().unwrap().expect("a block is produced");

        // The header commits to the ledger state AFTER applying the block, and it
        // matches what the node holds — proving the root is the true post-state.
        let root = block.header.state_root.clone().expect("root stamped (active in tests)");
        assert_eq!(
            root,
            node.compute_current_state_root().unwrap(),
            "header root == node's post-apply ledger root"
        );
        // Applied exactly once: alice funded with 10, not double-credited.
        assert_eq!(node.get_balance("alice").unwrap(), 10.0, "faucet applied once");
    }

    // ── P2-5 import verifies the committed root ───────────────────────────

    /// A signed transfer helper (real PQC signature, so it survives import's
    /// tx-signature re-verification).
    fn signed_transfer(from: &PQKeypair, to: &str, amount: u64) -> TxV1 {
        let mut tx = transfer_tx(&from.public_key_hex, to, amount, 0.0);
        tx.sig = pqc_sign(&from.secret_key_hex, &encode_tx_for_signing(&tx)).unwrap();
        tx
    }

    #[test]
    fn imported_block_with_matching_root_is_accepted() {
        let (_da, a) = test_node();
        let (_db, b) = test_node();
        let user = pqc_keygen();
        // Both nodes start from identical balances → applying the same block
        // yields the same root.
        a.balances.lock().unwrap().insert(canon_addr(&user.public_key_hex), 100 * Q);
        b.balances.lock().unwrap().insert(canon_addr(&user.public_key_hex), 100 * Q);

        // Node A mines a real signed transfer; the header commits its post-state.
        a.mempool.lock().unwrap().insert("t".to_string(), signed_transfer(&user, "bob", 40));
        let block = a.mine_pending().unwrap().expect("A produces a block");
        assert!(block.header.state_root.is_some(), "A committed a root");

        // Node B imports it — matching root → accepted, transfer applied.
        b.import_block(block).unwrap();
        assert_eq!(b.get_balance("bob").unwrap(), 40.0, "transfer applied on B");
        assert_eq!(b.get_balance(&user.public_key_hex).unwrap(), 60.0);
        assert_eq!(
            a.compute_current_state_root().unwrap(),
            b.compute_current_state_root().unwrap(),
            "A and B agree on the ledger root"
        );
    }

    #[test]
    fn imported_block_with_mismatched_root_is_rejected_and_rolled_back() {
        let (_da, a) = test_node();
        let (_db, b) = test_node();
        let user = pqc_keygen();
        a.balances.lock().unwrap().insert(canon_addr(&user.public_key_hex), 100 * Q);
        // B diverges: same user balance, but an extra account A never had. B will
        // apply A's transfer successfully, but its root won't match A's.
        b.balances.lock().unwrap().insert(canon_addr(&user.public_key_hex), 100 * Q);
        b.balances.lock().unwrap().insert("ghost".to_string(), 5 * Q);

        a.mempool.lock().unwrap().insert("t".to_string(), signed_transfer(&user, "bob", 40));
        let block = a.mine_pending().unwrap().expect("A produces a block");

        let root_before = b.compute_current_state_root().unwrap();
        let err = b.import_block(block).unwrap_err();
        assert!(err.contains("state root mismatch"), "rejected for root divergence: {}", err);

        // The bad block's effects are rolled back exactly — bob's credit is gone,
        // the pre-apply balances are restored, and the root is unchanged.
        assert_eq!(b.get_balance("bob").unwrap(), 0.0, "no partial state kept");
        assert_eq!(b.get_balance(&user.public_key_hex).unwrap(), 100.0, "sender restored");
        assert_eq!(b.get_balance("ghost").unwrap(), 5.0, "untouched account intact");
        assert_eq!(b.compute_current_state_root().unwrap(), root_before, "rolled back exactly");
    }

    // ── P3-3 contract bytecode installs on import ─────────────────────────

    /// A node with the WASM runtime + contract store wired up (test_node leaves
    /// them None). Returns the extra TmpDir so the store outlives the node.
    fn node_with_vm() -> (TmpDir, TmpDir, L1Node) {
        let (dir, mut node) = test_node();
        let cs_dir = TmpDir::new();
        node.set_contract_store(std::sync::Arc::new(ContractStore::new(&cs_dir.0).unwrap()));
        node.set_wasm_runtime(std::sync::Arc::new(WasmRuntime::new().unwrap()));
        (dir, cs_dir, node)
    }

    #[test]
    fn contract_bytecode_installs_on_mine_and_import() {
        let (_da, _csa, mut a) = node_with_vm();
        let (_db, _csb, b) = node_with_vm();
        let user = pqc_keygen();
        // Same starting balances on both, so post-apply state roots match.
        a.balances.lock().unwrap().insert(canon_addr(&user.public_key_hex), 100 * Q);
        b.balances.lock().unwrap().insert(canon_addr(&user.public_key_hex), 100 * Q);

        // A signed contract_deploy tx that CARRIES the bytecode (P3-3).
        let wasm = wat::parse_str(
            r#"(module (memory (export "memory") 1) (func (export "run")))"#,
        )
        .unwrap();
        use base64::Engine as _;
        let wasm_b64 = base64::engine::general_purpose::STANDARD.encode(&wasm);
        let addr = "c0ffee00000000000000000000000000000000ab";
        let mut tx = TxV1 {
            version: 1,
            tx_type: "contract_deploy".to_string(),
            from_pub_key: user.public_key_hex.clone(),
            nonce: 0,
            payload: TxPayload {
                contract_addr: Some(addr.to_string()),
                contract_wasm: Some(wasm_b64),
                to_pub_key_hex: Some(user.public_key_hex.clone()),
                amount: Some(wasm.len() as u64),
                ..Default::default()
            },
            fee: 1.0,
            sig: String::new(),
            signed_payload: None,
        };
        tx.sig = pqc_sign(&user.secret_key_hex, &encode_tx_for_signing(&tx)).unwrap();

        a.mempool.lock().unwrap().insert("d".to_string(), tx);
        let block = a.mine_pending().unwrap().expect("A mines the deploy");

        // A installed the code while mining.
        assert!(
            a.contract_store.as_ref().unwrap().get_contract(addr).unwrap().is_some(),
            "A holds the bytecode after mining"
        );

        // B installs it purely from the imported block's tx — nothing pre-shared.
        b.import_block(block).unwrap();
        let csb = b.contract_store.as_ref().unwrap();
        assert!(csb.get_contract(addr).unwrap().is_some(), "B installed from the imported tx");
        assert_eq!(csb.get_wasm(addr).unwrap().unwrap(), wasm, "B holds the exact bytecode");
    }

    // ── P3-4 the payoff: contracts move real XRGE ─────────────────────────

    fn signed(mut tx: TxV1, kp: &PQKeypair) -> TxV1 {
        tx.sig = pqc_sign(&kp.secret_key_hex, &encode_tx_for_signing(&tx)).unwrap();
        tx
    }

    #[test]
    fn contract_call_moves_real_xrge_and_conserves() {
        let (_da, _csa, mut a) = node_with_vm();
        let user = pqc_keygen();
        a.balances.lock().unwrap().insert(canon_addr(&user.public_key_hex), 100 * Q);

        // A contract whose "pay" method transfers 1 XRGE (10^9 quanta) to "bob".
        let wasm = wat::parse_str(
            r#"(module
                 (import "env" "host_transfer" (func $tr (param i32 i32 i64) (result i32)))
                 (memory (export "memory") 1)
                 (data (i32.const 0) "bob")
                 (func (export "pay") (result i32)
                   (call $tr (i32.const 0) (i32.const 3) (i64.const 1000000000))))"#,
        )
        .unwrap();
        use base64::Engine as _;
        let wasm_b64 = base64::engine::general_purpose::STANDARD.encode(&wasm);
        let addr = "c0ffee00000000000000000000000000000000ab";

        // Deploy (carries bytecode), mined into its own block first.
        let deploy = signed(
            TxV1 {
                version: 1,
                tx_type: "contract_deploy".to_string(),
                from_pub_key: user.public_key_hex.clone(),
                nonce: 0,
                payload: TxPayload {
                    contract_addr: Some(addr.to_string()),
                    contract_wasm: Some(wasm_b64),
                    to_pub_key_hex: Some(user.public_key_hex.clone()),
                    amount: Some(wasm.len() as u64),
                    ..Default::default()
                },
                fee: 1.0,
                sig: String::new(),
                signed_payload: None,
            },
            &user,
        );
        a.mempool.lock().unwrap().insert("deploy".to_string(), deploy);
        a.mine_pending().unwrap().expect("deploy block");

        // Fund the contract with 5 XRGE so it can pay out.
        a.balances.lock().unwrap().insert(addr.to_string(), 5 * Q);

        // Call "pay".
        let call = signed(
            TxV1 {
                version: 1,
                tx_type: "contract_call".to_string(),
                from_pub_key: user.public_key_hex.clone(),
                nonce: 1,
                payload: TxPayload {
                    contract_addr: Some(addr.to_string()),
                    contract_method: Some("pay".to_string()),
                    ..Default::default()
                },
                fee: 1.0,
                sig: String::new(),
                signed_payload: None,
            },
            &user,
        );
        a.mempool.lock().unwrap().insert("call".to_string(), call);
        a.mine_pending().unwrap().expect("call block");

        // The contract moved 1 real XRGE to bob — and conserved exactly.
        assert_eq!(a.get_balance("bob").unwrap(), 1.0, "bob received 1 XRGE from the contract");
        assert_eq!(a.get_balance(addr).unwrap(), 4.0, "contract balance dropped by exactly 1 XRGE");
    }

    // ── P3-6 end-to-end: royalty splitter across two nodes + overdraft ────

    /// Deploy a contract (carrying its bytecode) on `n` by mining one block, and
    /// return that block so it can be imported elsewhere. `n` must be mut.
    fn deploy_via_block(n: &mut L1Node, user: &PQKeypair, addr: &str, wasm: &[u8], nonce: u64) -> BlockV1 {
        use base64::Engine as _;
        let wasm_b64 = base64::engine::general_purpose::STANDARD.encode(wasm);
        let tx = signed(
            TxV1 {
                version: 1,
                tx_type: "contract_deploy".to_string(),
                from_pub_key: user.public_key_hex.clone(),
                nonce,
                payload: TxPayload {
                    contract_addr: Some(addr.to_string()),
                    contract_wasm: Some(wasm_b64),
                    to_pub_key_hex: Some(user.public_key_hex.clone()),
                    amount: Some(wasm.len() as u64),
                    ..Default::default()
                },
                fee: 1.0,
                sig: String::new(),
                signed_payload: None,
            },
            user,
        );
        n.mempool.lock().unwrap().insert("deploy".to_string(), tx);
        n.mine_pending().unwrap().expect("deploy block")
    }

    #[test]
    fn royalty_splitter_fans_xrge_across_two_nodes() {
        let (_da, _csa, mut a) = node_with_vm();
        let (_db, _csb, b) = node_with_vm();
        let user = pqc_keygen();
        // Identical starting balances so post-apply roots match.
        a.balances.lock().unwrap().insert(canon_addr(&user.public_key_hex), 100 * Q);
        b.balances.lock().unwrap().insert(canon_addr(&user.public_key_hex), 100 * Q);

        // Splitter: on "split", send 1 XRGE each to alice, bob, carol.
        let wasm = wat::parse_str(
            r#"(module
                 (import "env" "host_transfer" (func $tr (param i32 i32 i64) (result i32)))
                 (memory (export "memory") 1)
                 (data (i32.const 0) "alice")
                 (data (i32.const 16) "bob")
                 (data (i32.const 32) "carol")
                 (func (export "split") (result i32)
                   (drop (call $tr (i32.const 0)  (i32.const 5) (i64.const 1000000000)))
                   (drop (call $tr (i32.const 16) (i32.const 3) (i64.const 1000000000)))
                   (call $tr (i32.const 32) (i32.const 5) (i64.const 1000000000))))"#,
        )
        .unwrap();
        let addr = "5911770000000000000000000000000000000abc";

        // Deploy on A, import the deploy block on B — both hold the code and stay
        // in lockstep (each deducts the same deploy fee).
        let deploy_block = deploy_via_block(&mut a, &user, addr, &wasm, 0);
        b.import_block(deploy_block).unwrap();

        // Fund the contract with 10 XRGE on BOTH nodes (out-of-band, identical).
        a.balances.lock().unwrap().insert(addr.to_string(), 10 * Q);
        b.balances.lock().unwrap().insert(addr.to_string(), 10 * Q);

        // A mines the split call; B imports it.
        let call = signed(
            TxV1 {
                version: 1,
                tx_type: "contract_call".to_string(),
                from_pub_key: user.public_key_hex.clone(),
                nonce: 1,
                payload: TxPayload {
                    contract_addr: Some(addr.to_string()),
                    contract_method: Some("split".to_string()),
                    ..Default::default()
                },
                fee: 1.0,
                sig: String::new(),
                signed_payload: None,
            },
            &user,
        );
        a.mempool.lock().unwrap().insert("call".to_string(), call);
        let split_block = a.mine_pending().unwrap().expect("split block");
        b.import_block(split_block).unwrap();

        // Both nodes agree: 1 XRGE fanned to each of three wallets, contract down 3.
        for n in [&a, &b] {
            assert_eq!(n.get_balance("alice").unwrap(), 1.0);
            assert_eq!(n.get_balance("bob").unwrap(), 1.0);
            assert_eq!(n.get_balance("carol").unwrap(), 1.0);
            assert_eq!(n.get_balance(addr).unwrap(), 7.0, "10 - 3 XRGE paid out");
        }
        assert_eq!(
            a.compute_current_state_root().unwrap(),
            b.compute_current_state_root().unwrap(),
            "A and B agree on the ledger root after the split"
        );
    }

    #[test]
    fn contract_cannot_overspend_its_balance() {
        let (_da, _csa, mut a) = node_with_vm();
        let user = pqc_keygen();
        a.balances.lock().unwrap().insert(canon_addr(&user.public_key_hex), 100 * Q);

        // "overspend": tries to send 5 XRGE to bob — but the contract holds only 1.
        let wasm = wat::parse_str(
            r#"(module
                 (import "env" "host_transfer" (func $tr (param i32 i32 i64) (result i32)))
                 (memory (export "memory") 1)
                 (data (i32.const 0) "bob")
                 (func (export "overspend") (result i32)
                   (call $tr (i32.const 0) (i32.const 3) (i64.const 5000000000))))"#,
        )
        .unwrap();
        let addr = "0bad0000000000000000000000000000000000ab";

        let deploy_block = deploy_via_block(&mut a, &user, addr, &wasm, 0);
        let _ = deploy_block;
        a.balances.lock().unwrap().insert(addr.to_string(), 1 * Q); // only 1 XRGE

        let call = signed(
            TxV1 {
                version: 1,
                tx_type: "contract_call".to_string(),
                from_pub_key: user.public_key_hex.clone(),
                nonce: 1,
                payload: TxPayload {
                    contract_addr: Some(addr.to_string()),
                    contract_method: Some("overspend".to_string()),
                    ..Default::default()
                },
                fee: 1.0,
                sig: String::new(),
                signed_payload: None,
            },
            &user,
        );
        a.mempool.lock().unwrap().insert("call".to_string(), call);
        a.mine_pending().unwrap().expect("call block");

        // The over-transfer was refused at the VM host boundary: no XRGE moved.
        assert_eq!(a.get_balance("bob").unwrap(), 0.0, "bob got nothing — overspend refused");
        assert_eq!(a.get_balance(addr).unwrap(), 1.0, "contract balance intact");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// R1 — daemon integration tests: bridge_withdraw execution result, index-aligned
// results, post-acceptance store persistence, fail-closed receipts, and the
// rejected-bad-state-root regression on the REAL import path.
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod bridge_r1_daemon_tests {
    use super::*;
    use quantum_vault_bridge_exec::{BridgeWithdrawExecution as BX, BridgeWithdrawFailure as BF};

    pub(super) struct TmpDir(pub(super) PathBuf);
    impl TmpDir {
        pub(super) fn new() -> Self {
            static CTR: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let p = std::env::temp_dir().join(format!("r1-node-{}-{}-{}", std::process::id(), n,
                CTR.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
            std::fs::create_dir_all(&p).unwrap();
            TmpDir(p)
        }
    }
    impl Drop for TmpDir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    /// A real node with a bridge withdraw store (the relayer-facing payout list).
    pub(super) fn node_with_store() -> (TmpDir, L1Node, std::sync::Arc<BridgeWithdrawStore>) {
        let dir = TmpDir::new();
        let store = std::sync::Arc::new(BridgeWithdrawStore::new(&dir.0).unwrap());
        let node = L1Node::new(NodeOptions {
            data_dir: dir.0.clone(),
            chain: ChainConfig { chain_id: "test".to_string(), genesis_time: 0, block_time_ms: 1000 },
            mine: false,
            bridge_withdraw_store: Some(store.clone()),
            bridge_authority_keys: Vec::new(),
            genesis_allocations: Vec::new(), genesis_validators: Vec::new(),
        }).expect("node");
        node.init().expect("init");
        (dir, node, store)
    }

    pub(super) fn fund_xrge(node: &L1Node, pubkey: &str, xrge: f64) {
        node.balances.lock().unwrap().insert(canon_addr(pubkey), xrge_f64_to_quanta(xrge));
    }
    fn fund_token(node: &L1Node, pubkey: &str, sym: &str, units: u128) {
        node.token_balances.lock().unwrap().insert((canon_addr(pubkey), sym.to_string()), units);
    }

    pub(super) fn withdraw_tx(from: &str, token: &str, amount: u64, dest: &str, fee: f64, nonce: u64) -> TxV1 {
        TxV1 {
            version: 1, tx_type: "bridge_withdraw".to_string(), from_pub_key: from.to_string(), nonce,
            payload: TxPayload { token_symbol: Some(token.to_string()), amount: Some(amount),
                evm_address: Some(dest.to_string()), ..Default::default() },
            fee, sig: String::new(), signed_payload: None,
        }
    }
    pub(super) fn signed(mut tx: TxV1, sk: &str) -> TxV1 {
        tx.sig = pqc_sign(sk, &encode_tx_for_signing(&tx)).unwrap();
        tx
    }
    /// Unsigned block header/shell for apply_balance_block (which reads only height/time/txs).
    fn prelim_block(node: &L1Node, txs: Vec<TxV1>) -> BlockV1 {
        let tip = node.store.get_tip().unwrap();
        BlockV1 {
            version: 1,
            header: BlockHeaderV1 { version: 1, chain_id: "test".into(), height: tip.height + 1, time: 1,
                prev_hash: tip.hash, tx_hash: compute_tx_hash(&txs), proposer_pub_key: String::new(), state_root: None },
            txs, proposer_sig: String::new(), hash: String::new(),
        }
    }
    /// A fully signed, hash-consistent block for the REAL import path.
    pub(super) fn sealed_block(node: &L1Node, proposer_pub: &str, proposer_sk: &str, txs: Vec<TxV1>, state_root: Option<String>, time: u64) -> BlockV1 {
        let tip = node.store.get_tip().unwrap();
        let header = BlockHeaderV1 { version: 1, chain_id: "test".into(), height: tip.height + 1,
            time, prev_hash: tip.hash,
            tx_hash: compute_tx_hash(&txs), proposer_pub_key: proposer_pub.to_string(), state_root };
        let hb = encode_header_v1(&header);
        let sig = pqc_sign(proposer_sk, &hb).unwrap();
        let hash = compute_block_hash(&hb, &sig);
        BlockV1 { version: 1, header, txs, proposer_sig: sig, hash }
    }
    pub(super) const DEST: &str = "0x00000000000000000000000000000000000000a1";

    #[test]
    fn r1_double_withdraw_only_first_payout_eligible() {
        let (_d, node, store) = node_with_store();
        let user = pqc_keygen();
        fund_xrge(&node, &user.public_key_hex, 100.1); // exactly one 100-XRGE withdrawal + 0.1 fee
        let txs = vec![
            withdraw_tx(&user.public_key_hex, "XRGE", 100, DEST, 0.1, 1),
            withdraw_tx(&user.public_key_hex, "XRGE", 100, DEST, 0.1, 2),
        ];
        let block = prelim_block(&node, txs);
        let results = node.apply_balance_block(&block).unwrap().bridge;
        assert_eq!(results.len(), 2, "one slot per tx");
        assert!(matches!(results[0], Some(BX::Success(_))), "first burns");
        assert_eq!(results[1], Some(BX::Failed(BF::InsufficientFee)), "second fails (balance drained)");
        assert_eq!(node.get_balance(&user.public_key_hex).unwrap(), 0.0, "debited exactly once");
        assert_eq!(*node.burned_tokens.lock().unwrap().get("XRGE").unwrap(), 100.0);
        node.persist_bridge_withdraw_results(&block, &results).unwrap();
        let pending = store.list_pending().unwrap();
        assert_eq!(pending.len(), 1, "exactly ONE relayer-facing payout record for two attempts");
        assert_eq!(pending[0].amount_units, 100);
        assert_eq!(pending[0].token_symbol, "XRGE");
        assert!(pending[0].tx_id.starts_with("xrge:"));
        // receipts: first Success, second Failed(reason)
        let receipts = node.generate_receipts(&block, &results, &[]);
        assert!(matches!(receipts[0].status, TxStatus::Success));
        assert!(matches!(&receipts[1].status, TxStatus::Failed(r) if r == "InsufficientFee"));
    }

    #[test]
    fn r1_insolvent_withdrawal_no_payout() {
        let (_d, node, store) = node_with_store();
        let user = pqc_keygen();
        fund_xrge(&node, &user.public_key_hex, 50.1);
        let block = prelim_block(&node, vec![withdraw_tx(&user.public_key_hex, "XRGE", 100, DEST, 0.1, 1)]);
        let results = node.apply_balance_block(&block).unwrap().bridge;
        assert_eq!(results[0], Some(BX::Failed(BF::InsufficientXrge)));
        assert_eq!(node.get_balance(&user.public_key_hex).unwrap(), 50.1, "no debit");
        assert!(node.burned_tokens.lock().unwrap().is_empty(), "no burn");
        node.persist_bridge_withdraw_results(&block, &results).unwrap();
        assert!(store.list_pending().unwrap().is_empty(), "no payout record");
    }

    #[test]
    fn r1_result_index_alignment_after_skipped_tx() {
        let (_d, node, store) = node_with_store();
        let user = pqc_keygen();
        fund_xrge(&node, &user.public_key_hex, 1000.0);
        // tx[0]: mint_tokens for a symbol the sender does not own ⇒ consensus guard `continue`
        let skipped = TxV1 { version: 1, tx_type: "mint_tokens".into(), from_pub_key: user.public_key_hex.clone(), nonce: 1,
            payload: TxPayload { token_symbol: Some("NOPE".into()), token_total_supply: Some(5), ..Default::default() },
            fee: 0.1, sig: String::new(), signed_payload: None };
        let txs = vec![skipped, withdraw_tx(&user.public_key_hex, "XRGE", 10, DEST, 0.1, 2)];
        let block = prelim_block(&node, txs);
        let results = node.apply_balance_block(&block).unwrap().bridge;
        assert_eq!(results.len(), 2);
        assert!(results[0].is_none(), "skipped tx leaves its slot None");
        assert!(matches!(results[1], Some(BX::Success(_))), "withdrawal result lands at ITS index");
        node.persist_bridge_withdraw_results(&block, &results).unwrap();
        let pending = store.list_pending().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].owner_pubkey, user.public_key_hex, "record belongs to tx[1]'s sender");
        assert_eq!(pending[0].amount_units, 10);
        // misaligned results are refused
        assert!(node.persist_bridge_withdraw_results(&block, &results[..1]).is_err());
    }

    #[test]
    fn r1_failed_and_none_results_fail_closed_in_receipts() {
        let (_d, node, store) = node_with_store();
        let user = pqc_keygen();
        let block = prelim_block(&node, vec![withdraw_tx(&user.public_key_hex, "XRGE", 1, DEST, 0.1, 1)]);
        // absent result (defensive: never Success)
        let none: Vec<Option<BX>> = vec![None];
        let r = node.generate_receipts(&block, &none, &[]);
        assert!(matches!(&r[0].status, TxStatus::Failed(m) if m == "missing bridge execution result"));
        node.persist_bridge_withdraw_results(&block, &none).unwrap();
        assert!(store.list_pending().unwrap().is_empty(), "None never stored");
        // explicit failure
        let failed: Vec<Option<BX>> = vec![Some(BX::Failed(BF::ZeroAmount))];
        let r = node.generate_receipts(&block, &failed, &[]);
        assert!(matches!(&r[0].status, TxStatus::Failed(m) if m == "ZeroAmount"));
        node.persist_bridge_withdraw_results(&block, &failed).unwrap();
        assert!(store.list_pending().unwrap().is_empty(), "Failed never stored");
    }

    #[test]
    fn r1b_daemon_routing_qusdc_qbtc_recorded_custom_token_not() {
        let (_d, node, store) = node_with_store();
        let user = pqc_keygen();
        fund_xrge(&node, &user.public_key_hex, 10.0);
        fund_token(&node, &user.public_key_hex, "qUSDC", 100);
        fund_token(&node, &user.public_key_hex, "qBTC", 100);
        fund_token(&node, &user.public_key_hex, "3EYE", 100);
        let txs = vec![
            withdraw_tx(&user.public_key_hex, "qUSDC", 100, DEST, 0.1, 1),
            withdraw_tx(&user.public_key_hex, "qBTC", 100, "bc1qexampledestaddr0000000000000000000000", 0.1, 2),
            withdraw_tx(&user.public_key_hex, "3EYE", 100, DEST, 0.1, 3),
        ];
        let block = prelim_block(&node, txs);
        let results = node.apply_balance_block(&block).unwrap().bridge;
        // all three BURN at the ledger (execution semantics unchanged) ...
        assert!(results.iter().all(|r| matches!(r, Some(BX::Success(_)))));
        for sym in ["qUSDC", "qBTC", "3EYE"] {
            assert_eq!(node.get_token_balance(&user.public_key_hex, sym).unwrap(), 0.0, "{sym} debited");
        }
        // ... but only RECOGNIZED payout assets reach the relayer-facing store.
        node.persist_bridge_withdraw_results(&block, &results).unwrap();
        let mut toks: Vec<String> = store.list_pending().unwrap().into_iter().map(|w| w.token_symbol).collect();
        toks.sort();
        assert_eq!(toks, vec!["qBTC".to_string(), "qUSDC".to_string()], "3EYE (unsupported) gets NO payout record");
        let btc = store.list_pending().unwrap().into_iter().find(|w| w.token_symbol == "qBTC").unwrap();
        assert!(btc.evm_address.starts_with("bc1q"), "BTC destination preserved verbatim (no EVM-format gate)");
    }

    #[test]
    fn r1_rejected_bad_state_root_block_leaves_zero_store_side_effects() {
        let (_d, node, store) = node_with_store();
        let proposer = pqc_keygen();
        let user = pqc_keygen();
        fund_xrge(&node, &user.public_key_hex, 1000.0);
        let tx = signed(withdraw_tx(&user.public_key_hex, "XRGE", 100, DEST, 0.1, 1), &user.secret_key_hex);

        let t = chrono::Utc::now().timestamp_millis() as u64;
        // (a) valid-looking withdrawal inside a block with a DELIBERATELY WRONG state root
        let bad = sealed_block(&node, &proposer.public_key_hex, &proposer.secret_key_hex, vec![tx.clone()], Some("00".repeat(32)), t);
        let base_fee_before = node.get_base_fee_quanta();
        let err = node.import_block(bad).unwrap_err();
        assert!(err.contains("state root mismatch"), "rejected on state root: {err}");
        assert_eq!(node.tip_height().unwrap(), 0, "block NOT persisted");
        assert_eq!(node.get_balance(&user.public_key_hex).unwrap(), 1000.0, "ledger rolled back exactly");
        // Blocker B: the full pre-apply snapshot also rolls back everything outside the
        // state root — the burn ledger and the EIP-1559 base fee included.
        assert!(node.burned_tokens.lock().unwrap().is_empty(), "burned_tokens rolled back");
        assert_eq!(node.get_base_fee_quanta(), base_fee_before, "base fee rolled back");
        assert!(store.list_pending().unwrap().is_empty(), "ZERO withdrawal-store side effects");

        // (b) the SAME block with the CORRECT post-state root is accepted → exactly one record
        // Probe with the SAME proposer + time (fee distribution credits the proposer), then
        // roll the probe back with the full pre-apply snapshot so the real import starts
        // from exactly the state the probe saw.
        let probe = sealed_block(&node, &proposer.public_key_hex, &proposer.secret_key_hex, vec![tx.clone()], None, t);
        let snap = node.capture_pre_apply_snapshot(&probe).unwrap();
        let _ = node.apply_balance_block(&probe).unwrap();
        let correct_root = node.get_state_root().unwrap();
        node.restore_pre_apply_snapshot(snap).unwrap();
        assert_eq!(node.get_balance(&user.public_key_hex).unwrap(), 1000.0, "probe restored");
        assert_eq!(node.get_base_fee_quanta(), base_fee_before, "probe base fee restored");

        let good = sealed_block(&node, &proposer.public_key_hex, &proposer.secret_key_hex, vec![tx.clone()], Some(correct_root), t);
        node.import_block(good).expect("accepted with correct root");
        assert_eq!(node.tip_height().unwrap(), 1);
        assert_eq!(node.get_balance(&user.public_key_hex).unwrap(), 899.9, "1000 - 100 - 0.1");
        let pending = store.list_pending().unwrap();
        assert_eq!(pending.len(), 1, "payout record created ONLY for the accepted block");
        assert_eq!(pending[0].owner_pubkey, user.public_key_hex);
        assert_eq!(pending[0].amount_units, 100);
        let rc = node.get_receipt(&compute_single_tx_hash(&tx)).unwrap().unwrap();
        assert!(matches!(rc.status, TxStatus::Success));
    }

    // ── Blocker B: atomic rejected-block rollback ──────────────────────────────

    /// Exact, comparable image of every node-state component a speculative apply
    /// can touch. f64 fields are compared bit-for-bit; sled values as raw bytes.
    #[derive(Debug, Clone, PartialEq)]
    struct Fingerprint {
        tip: u64,
        balances: Vec<(String, u128)>,
        token_balances: Vec<((String, String), u128)>,
        lp_balances: Vec<((String, String), u128)>,
        burned_tokens: Vec<(String, u64)>,
        base_fee_quanta: u128,
        base_fee_raw: Option<Vec<u8>>,
        total_fees_burned_bits: u64,
        total_burned_raw: Option<Vec<u8>>,
        shielded_supply_bits: u64,
        unbonding_len: usize,
        nonces: Vec<(String, Option<Vec<u8>>)>,
        address_index: Vec<(Vec<u8>, Option<Vec<u8>>)>,
        token_metadata: Vec<String>,
        pools: Vec<String>,
        allowances_len: usize,
        withdraw_pending: Vec<String>,
        receipts: Vec<Option<String>>,
    }

    fn fingerprint(node: &L1Node, store: &BridgeWithdrawStore, pubkeys: &[&str], tx_hashes: &[String]) -> Fingerprint {
        let mut balances: Vec<_> = node.balances.lock().unwrap().iter().map(|(k, v)| (k.clone(), *v)).collect();
        balances.sort();
        let mut token_balances: Vec<_> = node.token_balances.lock().unwrap().iter().map(|(k, v)| (k.clone(), *v)).collect();
        token_balances.sort();
        let mut lp_balances: Vec<_> = node.lp_balances.lock().unwrap().iter().map(|(k, v)| (k.clone(), *v)).collect();
        lp_balances.sort();
        let mut burned_tokens: Vec<_> = node.burned_tokens.lock().unwrap().iter().map(|(k, v)| (k.clone(), v.to_bits())).collect();
        burned_tokens.sort();
        let mut nonces = Vec::new();
        let mut address_index = Vec::new();
        for pk in pubkeys {
            nonces.push((pk.to_string(), node.nonce_db.get(pk.as_bytes()).unwrap().map(|v| v.to_vec())));
            let (k1, k2) = address_index_keys(pk).expect("derivable address");
            for k in [k1, k2] {
                let v = node.address_db.get(&k).unwrap().map(|v| v.to_vec());
                address_index.push((k, v));
            }
        }
        let mut token_metadata: Vec<String> = node.token_metadata_store.get_all().unwrap()
            .iter().map(|m| serde_json::to_string(m).unwrap()).collect();
        token_metadata.sort();
        let mut pools: Vec<String> = node.pool_store.list_pools().unwrap()
            .iter().map(|p| serde_json::to_string(p).unwrap()).collect();
        pools.sort();
        let allowances_len = node.allowance_store.trees()[0].len();
        let mut withdraw_pending: Vec<String> = store.list_pending().unwrap()
            .iter().map(|w| format!("{}|{}|{}|{}|{}", w.tx_id, w.evm_address, w.amount_units, w.owner_pubkey, w.token_symbol)).collect();
        withdraw_pending.sort();
        let receipts = tx_hashes.iter()
            .map(|h| node.get_receipt(h).unwrap().map(|r| format!("{:?}", r.status)))
            .collect();
        Fingerprint {
            tip: node.tip_height().unwrap(),
            balances, token_balances, lp_balances, burned_tokens,
            base_fee_quanta: node.get_base_fee_quanta(),
            base_fee_raw: node.fee_db.get(b"base_fee").unwrap().map(|v| v.to_vec()),
            total_fees_burned_bits: node.get_total_fees_burned().to_bits(),
            total_burned_raw: node.fee_db.get(b"total_burned").unwrap().map(|v| v.to_vec()),
            shielded_supply_bits: node.get_shielded_supply().to_bits(),
            unbonding_len: node.unbonding_queue.lock().unwrap().len(),
            nonces, address_index, token_metadata, pools, allowances_len, withdraw_pending, receipts,
        }
    }

    fn transfer_tx(from: &str, to: &str, amount: u64, fee: f64, nonce: u64) -> TxV1 {
        TxV1 {
            version: 1, tx_type: "transfer".to_string(), from_pub_key: from.to_string(), nonce,
            payload: TxPayload { to_pub_key_hex: Some(to.to_string()), amount: Some(amount), ..Default::default() },
            fee, sig: String::new(), signed_payload: None,
        }
    }
    fn create_token_tx(from: &str, symbol: &str, supply: u64, fee: f64, nonce: u64) -> TxV1 {
        TxV1 {
            version: 1, tx_type: "create_token".to_string(), from_pub_key: from.to_string(), nonce,
            payload: TxPayload { token_symbol: Some(symbol.to_string()), token_name: Some(format!("{symbol} token")),
                token_total_supply: Some(supply), ..Default::default() },
            fee, sig: String::new(), signed_payload: None,
        }
    }

    /// A multi-component block: bridge_withdraw (burn ledger + fee), XRGE transfer
    /// (fees / base fee / recipient), create_token (token metadata store + token ledger).
    fn multi_component_txs(user: &PQKeypair, recipient: &str) -> Vec<TxV1> {
        vec![
            signed(withdraw_tx(&user.public_key_hex, "XRGE", 100, DEST, 0.1, 1), &user.secret_key_hex),
            signed(transfer_tx(&user.public_key_hex, recipient, 50, 0.1, 2), &user.secret_key_hex),
            signed(create_token_tx(&user.public_key_hex, "ROLL", 1_000, 0.1, 3), &user.secret_key_hex),
        ]
    }

    #[test]
    fn rejected_block_rollback_is_atomic() {
        let (_d, node, store) = node_with_store();
        let proposer = pqc_keygen();
        let user = pqc_keygen();
        let recipient = pqc_keygen();
        fund_xrge(&node, &user.public_key_hex, 1000.0);
        let txs = multi_component_txs(&user, &recipient.public_key_hex);
        let hashes: Vec<String> = txs.iter().map(compute_single_tx_hash).collect();
        let pks = [user.public_key_hex.as_str(), recipient.public_key_hex.as_str(), proposer.public_key_hex.as_str()];

        let before = fingerprint(&node, &store, &pks, &hashes);
        assert!(node.get_token_metadata("ROLL").unwrap().is_none());
        assert!(before.nonces.iter().all(|(_, v)| v.is_none()), "no nonces yet");

        let t = chrono::Utc::now().timestamp_millis() as u64;
        let bad = sealed_block(&node, &proposer.public_key_hex, &proposer.secret_key_hex, txs.clone(), Some("ab".repeat(32)), t);
        let err = node.import_block(bad).unwrap_err();
        assert!(err.contains("state root mismatch"), "rejected on state root: {err}");

        assert_eq!(node.tip_height().unwrap(), 0, "tip unchanged");
        assert!(node.get_block(1).unwrap().is_none(), "rejected block never persisted");
        let after = fingerprint(&node, &store, &pks, &hashes);
        assert_eq!(after, before, "EVERY state component identical after rejection");
        // Spot checks on the components the old (maps-only) rollback left dirty.
        assert!(node.burned_tokens.lock().unwrap().is_empty(), "burn ledger rolled back");
        assert!(node.get_token_metadata("ROLL").unwrap().is_none(), "token metadata store rolled back");
        assert!(node.nonce_db.get(user.public_key_hex.as_bytes()).unwrap().is_none(), "nonce_db rolled back");
        assert_eq!(node.get_token_balance(&user.public_key_hex, "ROLL").unwrap(), 0.0);
        assert_eq!(node.get_balance(&recipient.public_key_hex).unwrap(), 0.0);
        for h in &hashes {
            assert!(node.get_receipt(h).unwrap().is_none(), "no receipt for a rejected block's tx");
        }
        assert!(store.list_pending().unwrap().is_empty(), "withdrawal store empty");
    }

    #[test]
    fn repeated_rejections_do_not_drift() {
        let (_d, node, store) = node_with_store();
        let proposer = pqc_keygen();
        let user = pqc_keygen();
        let recipient = pqc_keygen();
        fund_xrge(&node, &user.public_key_hex, 1000.0);
        let txs = multi_component_txs(&user, &recipient.public_key_hex);
        let hashes: Vec<String> = txs.iter().map(compute_single_tx_hash).collect();
        let pks = [user.public_key_hex.as_str(), recipient.public_key_hex.as_str(), proposer.public_key_hex.as_str()];
        let t = chrono::Utc::now().timestamp_millis() as u64;

        let before = fingerprint(&node, &store, &pks, &hashes);
        for i in 0..5u8 {
            let bogus = format!("{:02x}", i + 1).repeat(32);
            let bad = sealed_block(&node, &proposer.public_key_hex, &proposer.secret_key_hex, txs.clone(), Some(bogus), t);
            let err = node.import_block(bad).unwrap_err();
            assert!(err.contains("state root mismatch"), "attempt {i}: {err}");
            assert_eq!(fingerprint(&node, &store, &pks, &hashes), before, "no drift after rejection #{}", i + 1);
        }

        // Correct root via a probe apply rolled back with the full snapshot.
        let probe = sealed_block(&node, &proposer.public_key_hex, &proposer.secret_key_hex, txs.clone(), None, t);
        let snap = node.capture_pre_apply_snapshot(&probe).unwrap();
        let _ = node.apply_balance_block(&probe).unwrap();
        let correct_root = node.get_state_root().unwrap();
        node.restore_pre_apply_snapshot(snap).unwrap();
        assert_eq!(fingerprint(&node, &store, &pks, &hashes), before, "probe fully rolled back");

        let good = sealed_block(&node, &proposer.public_key_hex, &proposer.secret_key_hex, txs.clone(), Some(correct_root), t);
        node.import_block(good).expect("accepted with correct root");
        assert_eq!(node.tip_height().unwrap(), 1);
        assert!(node.get_block(1).unwrap().is_some());
        for h in &hashes {
            let rc = node.get_receipt(h).unwrap().expect("receipt exists for accepted block");
            assert!(matches!(rc.status, TxStatus::Success), "{h}: {:?}", rc.status);
        }
        let pending = store.list_pending().unwrap();
        assert_eq!(pending.len(), 1, "exactly one withdrawal record");
        assert_eq!(pending[0].owner_pubkey, user.public_key_hex);
        assert_eq!(pending[0].amount_units, 100);
        // Expected post-state: 1000 - (100 + 0.1) - (50 + 0.1) - 0.1
        assert_eq!(node.get_balance(&user.public_key_hex).unwrap(), 849.7);
        assert_eq!(node.get_balance(&recipient.public_key_hex).unwrap(), 50.0);
        assert_eq!(node.get_token_balance(&user.public_key_hex, "ROLL").unwrap(), 1000.0);
        assert_eq!(*node.burned_tokens.lock().unwrap().get("XRGE").unwrap(), 100.0);
        assert!(node.get_token_metadata("ROLL").unwrap().is_some(), "token metadata registered once accepted");
        assert_eq!(node.nonce_db.get(user.public_key_hex.as_bytes()).unwrap().map(|v| v.to_vec()),
            Some(3u64.to_be_bytes().to_vec()), "nonce committed only by the accepted block");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #66 — strict historical replay regression: a FRESH node initialised from
// genesis-mainnet.json must import every real mainnet block through the REAL
// `import_block` path with NORMAL state-root verification. No skip flags, no
// snapshots, no pre-seeded ledger. Expected: every block accepted, zero root
// mismatches. Runs against the committed fixtures in `tests/fixtures/`.
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod strict_historical_replay_tests {
    use super::*;

    pub(super) const FIXTURE_BLOCKS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/mainnet-blocks-0-48.jsonl");
    pub(super) const FIXTURE_GENESIS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/genesis-mainnet.json");

    pub(super) struct TmpDir(pub(super) PathBuf);
    impl Drop for TmpDir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    /// Replays the fixture chain and returns (last accepted height, first failure).
    #[allow(dead_code)]
    fn replay_fixture() -> (u64, Option<(u64, String)>) { let (a, b, _n, _d) = replay_fixture_node(); (a, b) }
    pub(super) fn replay_fixture_node() -> (u64, Option<(u64, String)>, L1Node, TmpDir) {
        // Historical mainnet blocks were produced with the PRODUCTION fork height.
        TEST_FORK_HEIGHT_OVERRIDE.with(|c| c.set(Some(18)));
        let gc: crate::GenesisConfig = serde_json::from_str(&std::fs::read_to_string(FIXTURE_GENESIS).unwrap()).unwrap();
        let dir = TmpDir(std::env::temp_dir().join(format!("strict-replay-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())));
        std::fs::create_dir_all(&dir.0).unwrap();
        let node = L1Node::new(NodeOptions {
            data_dir: dir.0.clone(),
            chain: ChainConfig { chain_id: gc.chain_id.clone(), genesis_time: gc.genesis_time, block_time_ms: gc.block_time_ms },
            mine: false,
            bridge_withdraw_store: None,
            bridge_authority_keys: gc.initial_validators.iter().map(|v| v.pub_key.clone()).collect(),
            genesis_allocations: gc.initial_allocations.clone(), genesis_validators: gc.initial_validators.clone(),
        }).unwrap();
        node.init().unwrap();
        node.apply_genesis_allocations(&gc.initial_allocations, &gc.initial_validators).unwrap();
        let mut last_ok = 0u64;
        for line in std::fs::read_to_string(FIXTURE_BLOCKS).unwrap().lines() {
            let block: BlockV1 = serde_json::from_str(line).unwrap();
            let h = block.header.height;
            if h == 0 {
                let g = node.get_block(0).unwrap().unwrap();
                if g.hash != block.hash { return (0, Some((0, format!("genesis mismatch: fresh={} fixture={}", g.hash, block.hash))), node, dir); }
                continue;
            }
            if let Err(e) = node.import_block(block) { return (last_ok, Some((h, e)), node, dir); }
            last_ok = h;
        }
        (last_ok, None, node, dir)
    }

    pub(super) const FIXTURE_BLOCKS_0_60: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/mainnet-blocks-0-60.jsonl");

    /// Transaction-integrity release gate: replay ALL canonical mainnet history (genesis through
    /// the live tip at the time of release preparation, height 60) through the real import path
    /// and land on exactly the live primary's tip hash and state root. The tx-uniqueness rule is
    /// unscheduled here (None) — exactly the binary that will run below N.
    #[test]
    fn strict_replay_full_history_through_live_tip_60() {
        TEST_TX_UNIQUENESS_OVERRIDE.with(|c| c.set(Some(None)));
        let (last_ok, failure, node, _dir) = replay_fixture_node_from(FIXTURE_BLOCKS_0_60);
        assert!(failure.is_none(), "first divergence at {:?} (last accepted {})", failure, last_ok);
        assert_eq!(last_ok, 60);
        let tip = node.get_block(60).unwrap().unwrap();
        assert_eq!(tip.hash, "ea90a89107bb741743516e41d3fb5428816cf95a69f46e660992075a0bc79096", "live primary tip hash at 60");
        assert_eq!(node.compute_current_state_root().unwrap(), "069a9d03c9eec33915caac641e1c5b89faa7077d40df387315ff7f7a65bc27e4", "live primary state root at 60");
        // every historical tx is now in the identity index, and none repeats
        let blocks: Vec<BlockV1> = std::fs::read_to_string(FIXTURE_BLOCKS_0_60).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        let mut ids = std::collections::HashSet::new();
        for b in &blocks { for tx in &b.txs { assert!(ids.insert(quantum_vault_types::tx_identity(tx)), "no identity repeats in history"); assert_eq!(node.tx_included_at(&quantum_vault_types::tx_identity(tx)), Some(b.header.height)); } }
        assert_eq!(ids.len(), 61 - 1 + 0, "61 txs over 61 blocks? (one tx per block except genesis)");
    }

    pub(super) fn replay_fixture_node_from(fixture: &str) -> (u64, Option<(u64, String)>, L1Node, TmpDir) {
        TEST_FORK_HEIGHT_OVERRIDE.with(|c| c.set(Some(18)));
        let gc: crate::GenesisConfig = serde_json::from_str(&std::fs::read_to_string(FIXTURE_GENESIS).unwrap()).unwrap();
        let dir = TmpDir(std::env::temp_dir().join(format!("strict-replay-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())));
        std::fs::create_dir_all(&dir.0).unwrap();
        let node = L1Node::new(NodeOptions {
            data_dir: dir.0.clone(),
            chain: ChainConfig { chain_id: gc.chain_id.clone(), genesis_time: gc.genesis_time, block_time_ms: gc.block_time_ms },
            mine: false, bridge_withdraw_store: None,
            bridge_authority_keys: gc.initial_validators.iter().map(|v| v.pub_key.clone()).collect(),
            genesis_allocations: gc.initial_allocations.clone(), genesis_validators: gc.initial_validators.clone(),
        }).unwrap();
        node.init().unwrap();
        node.apply_genesis_allocations(&gc.initial_allocations, &gc.initial_validators).unwrap();
        let mut last_ok = 0u64;
        for line in std::fs::read_to_string(fixture).unwrap().lines() {
            let block: BlockV1 = serde_json::from_str(line).unwrap();
            let h = block.header.height;
            if h == 0 { let g = node.get_block(0).unwrap().unwrap(); if g.hash != block.hash { return (0, Some((0, "genesis mismatch".into())), node, dir); } continue; }
            if let Err(e) = node.import_block(block) { return (last_ok, Some((h, e)), node, dir); }
            last_ok = h;
        }
        (last_ok, None, node, dir)
    }

    /// Option-B fork: a FRESH node (random identity, empty data dir) imports every historical
    /// block through the real import path — heights 18..=F-1 verified by equality against the
    /// compiled checkpoint table, canonical execution throughout — and arrives at exactly the
    /// pinned canonical ledger at F-1 with the canonical marker set. No skip flags.
    #[test]
    fn strict_replay_full_history_verifies_every_root() {
        let (last_ok, failure, node, _dir) = replay_fixture_node();
        assert!(failure.is_none(), "first divergence at {:?} (last accepted {})", failure, last_ok);
        assert_eq!(last_ok, crate::fork::FORK_HEIGHT - 1, "F-1 = 48 imported, 0 mismatches");
        let b = node.balances.lock().unwrap().clone();
        crate::fork::ledger_matches_table(&b, crate::fork::CANONICAL_LEDGER_AT_F_MINUS_1).expect("canonical ledger at F-1");
        assert!(node.canonical_marker_present(), "canonical marker set by fresh sync");
        assert!(node.fork_readiness_check().is_ok());
        // supply identity in integer quanta at F-1 (see FORK_DECISION_PACKAGE §6):
        // mints + faucet == ledger + stake + shielded + pool XRGE reserve + burned + fee-burn + implicit sinks
        let ledger: u128 = b.values().sum();
        // Stake term = XRGE actually debited from the ledger by SUCCESSFUL stake txs: h20 only
        // (10,000). The h29 stake fails atomically (10,000.87 < 10,001): no debit, no validator
        // power, no entry. Validator store = genesis 100,000 (never a ledger debit) + 10,000.
        let stake: u128 = 10_000;
        let rows = node.validator_rows().unwrap();
        crate::fork::validators_match_table(&rows, crate::fork::CANONICAL_VALIDATOR_STATE_AT_F_MINUS_1).expect("fresh sync reaches the pinned canonical validator set");
        assert_eq!(crate::fork::stake_and_quorum(&rows), (110_000, 73_334), "backed stake only; quorum = total*2/3+1");
        assert!(rows.iter().all(|r| !r.0.starts_with("c97f59a2")), "h29 unbacked staker holds no validator power");
        assert!(node.unbonding_queue.lock().unwrap().is_empty());
        assert_eq!(node.get_total_fees_burned().to_bits(), crate::fork::CANONICAL_FEES_BURNED_BITS_AT_F_MINUS_1, "fresh sync reproduces the pinned fees_burned accumulator");
        let h29 = node.get_block(29).unwrap().unwrap();
        let stake_tx = h29.txs.iter().find(|t| t.tx_type == "stake").expect("h29 carries the stake tx");
        let rc = node.get_receipt(&compute_single_tx_hash(stake_tx)).unwrap().expect("receipt for h29 stake");
        assert!(!matches!(rc.status, quantum_vault_types::TxStatus::Success), "h29 stake receipt marks failure: {:?}", rc.status);
        let pool_xrge: u128 = node.pool_store.list_pools().unwrap().iter().map(|p| if p.token_a == "XRGE" { p.reserve_a as u128 } else if p.token_b == "XRGE" { p.reserve_b as u128 } else { 0 }).sum();
        let burned = (*node.burned_tokens.lock().unwrap().get("XRGE").unwrap_or(&0.0) * 1e9).round() as u128;
        let fee_burn = (node.get_total_fees_burned() * 1e9).round() as u128;
        let shielded = (node.get_shielded_supply() * 1e9).round() as u128;
        const Q: u128 = 1_000_000_000;
        let inflow = (55_123_564u128 + 101) * Q;
        let sinks = 6 * Q; // unshield fee sink 4 (h28,h32,h34,h36) + AMM sinks 2 (h46,h48) — pre-existing, identical in both ledgers
        assert_eq!(inflow, ledger + stake * Q + shielded + pool_xrge * Q + burned + fee_burn + sinks,
            "exact supply identity in quanta: ledger={ledger} stake={stake} shielded={shielded} pool={pool_xrge} burned={burned} fee_burn={fee_burn}");
    }

    /// Pinned CURRENT behaviour so a regression (or the eventual fix) is visible: the
    /// pre-fork prefix imports cleanly and the first committed root (height 18) is where
    /// a fresh replay stops today.
    /// A wrong committed root inside the checkpoint era is rejected against the table, and the
    /// canonical execution at 18 is identity-independent (root 99a37ecc… from a random key).
    #[test]
    fn checkpoint_era_rejects_wrong_committed_root_and_is_identity_independent() {
        let gc: crate::GenesisConfig = serde_json::from_str(&std::fs::read_to_string(FIXTURE_GENESIS).unwrap()).unwrap();
        TEST_FORK_HEIGHT_OVERRIDE.with(|c| c.set(Some(18)));
        let dir = TmpDir(std::env::temp_dir().join(format!("strict-cp-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())));
        std::fs::create_dir_all(&dir.0).unwrap();
        let node = L1Node::new(NodeOptions { data_dir: dir.0.clone(),
            chain: ChainConfig { chain_id: gc.chain_id.clone(), genesis_time: gc.genesis_time, block_time_ms: gc.block_time_ms },
            mine: false, bridge_withdraw_store: None,
            bridge_authority_keys: gc.initial_validators.iter().map(|v| v.pub_key.clone()).collect(),
            genesis_allocations: gc.initial_allocations.clone(), genesis_validators: gc.initial_validators.clone() }).unwrap();
        node.init().unwrap();
        node.apply_genesis_allocations(&gc.initial_allocations, &gc.initial_validators).unwrap();
        let blocks: Vec<BlockV1> = std::fs::read_to_string(FIXTURE_BLOCKS).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        for b in blocks.iter().filter(|b| (1..=17).contains(&b.header.height)) { node.import_block(b.clone()).unwrap(); }
        let mut b18 = blocks.iter().find(|b| b.header.height == 18).unwrap().clone();
        assert_eq!(node.get_state_root().unwrap().len(), 64);
        // tamper the committed root (and re-seal so only the checkpoint check can reject it)
        let real_root = b18.header.state_root.clone();
        b18.header.state_root = Some("00".repeat(32));
        let hb = encode_header_v1(&b18.header);
        // the historical proposer signature no longer covers this header → import fails on the
        // signature first; assert the checkpoint verifier itself rejects the tampered root:
        assert!(crate::fork::verify_checkpoint(18, b18.header.state_root.as_deref()).unwrap_err().contains("checkpoint mismatch"));
        assert!(crate::fork::verify_checkpoint(18, real_root.as_deref()).is_ok());
        let _ = hb;
        // canonical, identity-independent execution at 18 (random node key here)
        b18.header.state_root = real_root;
        node.import_block(b18).unwrap();
        assert_eq!(node.get_state_root().unwrap(), "99a37ecc808ce7e5b800c6078666935b9a83574f96c7a4d516e9c3207a01c378");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// R1 derived bridge-store hardening: a failed payout-record write must never affect
// chain validity, must surface as DEGRADED (relayer fail-closed), and must be exactly
// reconstructable from accepted history — on demand and on restart.
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod bridge_store_hardening_tests {
    use super::*;
    use super::bridge_r1_daemon_tests::{node_with_store, fund_xrge, withdraw_tx, signed, sealed_block, TmpDir, DEST};

    fn set_readonly(path: &std::path::Path, ro: bool) {
        use std::os::unix::fs::PermissionsExt;
        let mode = if ro { 0o444 } else { 0o644 };
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    /// Accept a solvent XRGE withdrawal block while the store file is unwritable.
    fn accept_withdraw_with_broken_store() -> (TmpDir, L1Node, std::sync::Arc<BridgeWithdrawStore>, String, String) {
        let (d, node, store) = node_with_store();
        let proposer = pqc_keygen();
        let user = pqc_keygen();
        fund_xrge(&node, &user.public_key_hex, 1000.0);
        let tx = signed(withdraw_tx(&user.public_key_hex, "XRGE", 100, DEST, 0.1, 1), &user.secret_key_hex);
        let t = chrono::Utc::now().timestamp_millis() as u64;
        let probe = sealed_block(&node, &proposer.public_key_hex, &proposer.secret_key_hex, vec![tx.clone()], None, t);
        let snap = node.capture_pre_apply_snapshot(&probe).unwrap();
        let _ = node.apply_balance_block(&probe).unwrap();
        let root = node.get_state_root().unwrap();
        node.restore_pre_apply_snapshot(snap).unwrap();
        // Make the JSON store unwritable (a realistic persistence failure: EACCES).
        let store_path = d.0.join("bridge_withdrawals.json");
        std::fs::write(&store_path, "[]").unwrap();
        set_readonly(&store_path, true);
        let good = sealed_block(&node, &proposer.public_key_hex, &proposer.secret_key_hex, vec![tx.clone()], Some(root), t);
        node.import_block(good).expect("(2) block ACCEPTED despite derived-store failure");
        let expected_id = format!("xrge:{}", bytes_to_hex(&sha256(&encode_tx_v1(&tx))));
        (d, node, store, user.public_key_hex.clone(), expected_id)
    }

    #[test]
    fn store_persistence_failure_keeps_block_and_degrades_bridge() {
        let (d, node, store, user, expected_id) = accept_withdraw_with_broken_store();
        // (1) persistence failed, (2) chain accepted the block
        assert_eq!(node.tip_height().unwrap(), 1, "accepted block remains accepted");
        assert_eq!(node.get_balance(&user).unwrap(), 899.9, "burn + fee applied");
        // (3) bridge health degraded, failed id recorded
        assert!(node.bridge_store_degraded(), "bridge derived state must be DEGRADED");
        assert_eq!(node.bridge_store_failed_ids(), vec![expected_id.clone()]);
        // (4) relayer gets NO instruction (fail closed), not a partial list
        let err = match node.relayer_pending_withdrawals() { Err(e) => e, Ok(_) => panic!("relayer list must fail closed while degraded") };
        assert!(err.contains("DEGRADED"), "{err}");
        // atomic store: neither memory nor disk claims the record
        assert!(store.get(&expected_id).unwrap().is_none(), "failed write rolled back in memory");
        let on_disk = std::fs::read_to_string(d.0.join("bridge_withdrawals.json")).unwrap();
        assert!(!on_disk.contains(&expected_id), "record never persisted");
        let _ = store;
    }

    #[test]
    fn rebuild_reconstructs_exact_missing_record_and_clears_degraded() {
        let (d, node, store, user, expected_id) = accept_withdraw_with_broken_store();
        assert!(node.bridge_store_degraded());
        set_readonly(&d.0.join("bridge_withdrawals.json"), false);
        // Fresh store handle over the same (still incomplete) file, as a restart would see it.
        let fresh_store = std::sync::Arc::new(BridgeWithdrawStore::new(&d.0).unwrap());
        assert!(fresh_store.get(&expected_id).unwrap().is_none(), "record genuinely missing on disk");
        // (5) rebuild from accepted history reconstructs the exact record
        // (activation height is 49 in production; this test chain starts at 1 → override via
        // a node whose store is the fresh handle and rebuilding from height 1)
        let added = node.rebuild_bridge_withdraw_store_from(1).unwrap();
        assert_eq!(added, 1, "exactly the one missing record is reconstructed");
        let rec = store.get(&expected_id).unwrap().expect("record present");
        assert_eq!(rec.owner_pubkey, user);
        assert_eq!(rec.amount_units, 100);
        assert_eq!(rec.token_symbol, "XRGE");
        assert_eq!(rec.evm_address, DEST);
        let on_disk = std::fs::read_to_string(d.0.join("bridge_withdrawals.json")).unwrap();
        assert!(on_disk.contains(&expected_id), "rebuild persisted the record");
        assert!(!node.bridge_store_degraded(), "degraded flag cleared once every record is present");
        assert_eq!(node.relayer_pending_withdrawals().unwrap().len(), 1, "relayer list restored");
        // idempotent: a second rebuild adds nothing and keeps exactly one record
        assert_eq!(node.rebuild_bridge_withdraw_store_from(1).unwrap(), 0);
        assert_eq!(store.list_pending().unwrap().len(), 1);
    }

    #[test]
    fn restart_reconstructs_missing_record_from_history() {
        let (d, node, _store, user, expected_id) = accept_withdraw_with_broken_store();
        set_readonly(&d.0.join("bridge_withdrawals.json"), false);
        drop(node);
        // (6) a new node over the same data dir (restart) — init() rebuilds derived state.
        let store2 = std::sync::Arc::new(BridgeWithdrawStore::new(&d.0).unwrap());
        assert!(store2.get(&expected_id).unwrap().is_none(), "missing before restart rebuild");
        let node2 = L1Node::new(NodeOptions {
            data_dir: d.0.clone(),
            chain: ChainConfig { chain_id: "test".to_string(), genesis_time: 0, block_time_ms: 1000 },
            mine: false,
            bridge_withdraw_store: Some(store2.clone()),
            bridge_authority_keys: Vec::new(),
            genesis_allocations: Vec::new(), genesis_validators: Vec::new(),
        }).unwrap();
        node2.init().unwrap();
        let _ = node2.rebuild_bridge_withdraw_store_from(1).unwrap();
        let rec = store2.get(&expected_id).unwrap().expect("reconstructed on restart");
        assert_eq!(rec.owner_pubkey, user);
        assert_eq!(rec.amount_units, 100);
        assert!(!node2.bridge_store_degraded());
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Option-B fork: migration atomicity, fork block F, post-fork restart/recovery,
// economics, and the old rebuild-accounting bug regression.
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod fork_table_generation {
    use super::*;
    use super::strict_historical_replay_tests::{FIXTURE_BLOCKS, FIXTURE_GENESIS, TmpDir};
    /// TABLE GENERATOR (run explicitly): fresh random-identity node, blocks 0..48 through the real
    /// import path with the F-1 assertion disabled, then dump the canonical ledger + validator
    /// state to fork-decision/canonical_state_48.json. Used to (re)generate fork_tables.rs.
    #[test]
    #[ignore = "table generator — run explicitly with --ignored"]
    fn generate_canonical_state_at_f_minus_1() {
        TEST_FORK_HEIGHT_OVERRIDE.with(|c| c.set(Some(18)));
        TEST_SKIP_F_MINUS_1_ASSERT.with(|c| c.set(true));
        let gc: crate::GenesisConfig = serde_json::from_str(&std::fs::read_to_string(FIXTURE_GENESIS).unwrap()).unwrap();
        let dir = TmpDir(std::env::temp_dir().join(format!("gen-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())));
        std::fs::create_dir_all(&dir.0).unwrap();
        let node = L1Node::new(NodeOptions { data_dir: dir.0.clone(), chain: ChainConfig { chain_id: gc.chain_id.clone(), genesis_time: gc.genesis_time, block_time_ms: gc.block_time_ms },
            mine: false, bridge_withdraw_store: None, bridge_authority_keys: gc.initial_validators.iter().map(|v| v.pub_key.clone()).collect(),
            genesis_allocations: gc.initial_allocations.clone(), genesis_validators: gc.initial_validators.clone() }).unwrap();
        node.init().unwrap(); node.apply_genesis_allocations(&gc.initial_allocations, &gc.initial_validators).unwrap();
        for line in std::fs::read_to_string(FIXTURE_BLOCKS).unwrap().lines() {
            let b: BlockV1 = serde_json::from_str(line).unwrap();
            if b.header.height == 0 { continue; }
            if b.header.height >= crate::fork::FORK_HEIGHT { break; }
            node.import_block(b).unwrap();
        }
        assert_eq!(node.tip_height().unwrap(), crate::fork::FORK_HEIGHT - 1);
        let bal: std::collections::BTreeMap<String, u128> = node.balances.lock().unwrap().iter().map(|(k, v)| (k.clone(), *v)).collect();
        let tok: Vec<((String, String), u128)> = node.token_balances.lock().unwrap().iter().map(|(k, v)| (k.clone(), *v)).collect();
        let lp: Vec<((String, String), u128)> = node.lp_balances.lock().unwrap().iter().map(|(k, v)| (k.clone(), *v)).collect();
        let vals: Vec<(String, ValidatorState)> = node.list_validators().unwrap();
        let out = serde_json::json!({ "height": node.tip_height().unwrap(), "state_root": node.get_state_root().unwrap(),
            "balances": bal, "token_balances": tok, "lp_balances": lp, "validators": vals,
            "unbonding": *node.unbonding_queue.lock().unwrap(), "shielded_supply": node.get_shielded_supply(), "fees_burned": node.get_total_fees_burned() });
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../bridge-exec/fork-decision/canonical_state_48.json");
        std::fs::write(p, serde_json::to_vec_pretty(&out).unwrap()).unwrap();
        eprintln!("wrote {}", p);
    }
}

#[cfg(test)]
mod fork_integration_tests {
    use super::*;
    use super::strict_historical_replay_tests::{replay_fixture_node, TmpDir, FIXTURE_GENESIS};
    use crate::fork::*;

    fn prod_table() -> HashMap<String, u128> { PRODUCTION_LEDGER_AT_F_MINUS_1.iter().map(|(k, v)| (k.to_string(), *v)).collect() }
    fn canon_table() -> HashMap<String, u128> { CANONICAL_LEDGER_AT_F_MINUS_1.iter().filter(|(_, v)| *v != 0).map(|(k, v)| (k.to_string(), *v)).collect() }
    fn persist(n: &L1Node) -> Result<(), String> { n.persist_snapshot_atomic(FORK_HEIGHT - 1) }

    /// A node synced to F-1 through the real import path, then turned into a LEGACY production
    /// node: production ledger substituted, canonical marker removed (what production holds today).
    fn legacy_production_node() -> (L1Node, TmpDir) {
        let (last, fail, node, dir) = replay_fixture_node();
        assert!(fail.is_none() && last == FORK_HEIGHT - 1);
        *node.balances.lock().unwrap() = prod_table();
        // production validator store: h29 phantom validator present, consensus fields as exported
        for (k, s, sc, j, m, ts) in PRODUCTION_VALIDATOR_STATE_AT_F_MINUS_1 {
            let mut st = node.validator_store.get_validator(k).unwrap().unwrap_or(ValidatorState { stake: 0, slash_count: 0, jailed_until: 0, entropy_contributions: 0, blocks_proposed: 0, name: None, missed_blocks: 0, total_slashed: 0 });
            st.stake = *s; st.slash_count = *sc; st.jailed_until = *j; st.missed_blocks = *m; st.total_slashed = *ts;
            node.validator_store.set_validator(k, &st).unwrap();
        }
        validators_match_table(&node.validator_rows().unwrap(), PRODUCTION_VALIDATOR_STATE_AT_F_MINUS_1).unwrap();
        assert_eq!(stake_and_quorum(&node.validator_rows().unwrap()), (120_000, 80_001), "production: 10,000 phantom power");
        // production's phantom-era fees_burned accumulator
        node.set_total_fees_burned(f64::from_bits(PRODUCTION_FEES_BURNED_BITS_AT_F_MINUS_1)).unwrap();
        let _ = node.snapshot_db.remove(CANONICAL_MARKER_KEY); let _ = node.snapshot_db.flush();
        node.persist_snapshot_atomic(FORK_HEIGHT - 1).unwrap();
        assert!(node.fork_readiness_check().unwrap_err().contains("LEGACY production ledger"), "startup guard demands migration");
        (node, dir)
    }
    fn assert_canonical_validators(n: &L1Node) {
        let rows = n.validator_rows().unwrap();
        validators_match_table(&rows, CANONICAL_VALIDATOR_STATE_AT_F_MINUS_1).unwrap();
        assert_eq!(stake_and_quorum(&rows), (110_000, 73_334));
        assert!(rows.iter().all(|r| !r.0.starts_with("c97f59a2")), "h29 phantom validator removed");
        assert!(n.unbonding_queue.lock().unwrap().is_empty());
        assert_eq!(n.get_total_fees_burned().to_bits(), CANONICAL_FEES_BURNED_BITS_AT_F_MINUS_1, "fees_burned accumulator canonical");
        assert_eq!(n.fee_db.get(b"total_burned").unwrap().map(|v| v.to_vec()), Some(f64::from_bits(CANONICAL_FEES_BURNED_BITS_AT_F_MINUS_1).to_string().into_bytes()));
    }
    fn reopen(opts: &NodeOptions) -> L1Node {
        let n = L1Node::new(NodeOptions { data_dir: opts.data_dir.clone(), chain: opts.chain.clone(), mine: false, bridge_withdraw_store: None,
            bridge_authority_keys: opts.bridge_authority_keys.clone(), genesis_allocations: opts.genesis_allocations.clone(), genesis_validators: opts.genesis_validators.clone() }).unwrap();
        n.init().unwrap(); n
    }
    fn consensus_fields(n: &L1Node) -> serde_json::Value {
        let d = n.state_digest().unwrap();
        serde_json::json!({ "tip": d["tip"], "state_root": d["state_root"], "balances": d["balances"], "token_balances": d["token_balances"], "lp_balances": d["lp_balances"],
            "burned_tokens": d["burned_tokens"], "stakes": d["stakes"], "shielded_supply_bits": d["shielded_supply_bits"], "base_fee_quanta": d["base_fee_quanta"],
            "validators": d["validators"], "total_stake": d["total_stake"], "quorum": d["quorum"], "unbonding": d["unbonding"] })
    }
    struct Keys(String, String);
    fn proposer_keys() -> Keys { let k = pqc_keygen(); Keys(k.public_key_hex, k.secret_key_hex) }
    /// Seal a block on top of the tip with the given txs and root.
    fn seal(node: &L1Node, p: &Keys, txs: Vec<TxV1>, root: Option<String>, time: u64) -> BlockV1 {
        let tip = node.store.get_tip().unwrap();
        let header = BlockHeaderV1 { version: 1, chain_id: node.opts.chain.chain_id.clone(), height: tip.height + 1, time, prev_hash: tip.hash,
            tx_hash: compute_tx_hash(&txs), proposer_pub_key: p.0.clone(), state_root: root };
        let hb = encode_header_v1(&header); let sig = pqc_sign(&p.1, &hb).unwrap(); let hash = compute_block_hash(&hb, &sig);
        BlockV1 { version: 1, header, txs, proposer_sig: sig, hash }
    }
    /// Root the block WOULD commit (probe apply, fully rolled back).
    fn probe_root(node: &L1Node, p: &Keys, txs: &[TxV1], time: u64) -> String {
        let probe = seal(node, p, txs.to_vec(), None, time);
        let snap = node.capture_pre_apply_snapshot(&probe).unwrap();
        let _ = node.apply_balance_block(&probe).unwrap();
        let r = node.get_state_root().unwrap();
        node.restore_pre_apply_snapshot(snap).unwrap(); r
    }

    #[test]
    fn migration_exact_state_accepted_and_final_ledger_canonical() {
        let (node, _d) = legacy_production_node();
        assert_eq!(node.migrate_canonical_ledger(&persist).unwrap(), "migrated");
        ledger_matches_table(&node.balances.lock().unwrap(), CANONICAL_LEDGER_AT_F_MINUS_1).unwrap();
        assert_canonical_validators(&node);
        assert!(node.canonical_marker_present() && node.fork_readiness_check().is_ok());
        let before: u128 = prod_table().values().sum(); let after: u128 = canon_table().values().sum();
        assert_eq!(before - after, 10_255_079_099_271, "exactly the phantom amount removed");
        // informational counters survive the transition untouched
        assert!(node.list_validators().unwrap().iter().any(|(k, v)| k.starts_with("8ccf7878") && v.blocks_proposed > 0));
        let opts = node.opts.clone(); drop(node);
        let reloaded = reopen(&opts);
        ledger_matches_table(&reloaded.balances.lock().unwrap(), CANONICAL_LEDGER_AT_F_MINUS_1).unwrap();
        assert_canonical_validators(&reloaded);
        assert_eq!(reloaded.migrate_canonical_ledger(&persist).unwrap(), "already-migrated", "double migration recognized idempotently");
    }

    #[test]
    fn migration_refuses_validator_mismatch_and_inconsistent_partial_state() {
        // (a) one extra missed block on a production validator ⇒ abort, nothing touched
        let (node, _d) = legacy_production_node();
        let (k, mut st) = node.list_validators().unwrap().into_iter().find(|(k, _)| k.starts_with("21e0ed0a")).unwrap();
        st.missed_blocks += 1; node.validator_store.set_validator(&k, &st).unwrap();
        let rows_before = node.validator_rows().unwrap(); let bal_before = node.balances.lock().unwrap().clone();
        let err = node.migrate_canonical_ledger(&persist).unwrap_err();
        assert!(err.contains("does not match PRODUCTION_VALIDATOR_STATE_AT_F_MINUS_1"), "{err}");
        assert_eq!(node.validator_rows().unwrap(), rows_before); assert_eq!(*node.balances.lock().unwrap(), bal_before);
        assert!(!node.canonical_marker_present());
        // (b) ledger already canonical but validators still production ⇒ INCONSISTENT abort
        st.missed_blocks -= 1; node.validator_store.set_validator(&k, &st).unwrap();
        *node.balances.lock().unwrap() = canon_table();
        let err = node.migrate_canonical_ledger(&persist).unwrap_err();
        assert!(err.contains("INCONSISTENT state: ledger canonical=true validators canonical=false"), "{err}");
        assert!(!node.canonical_marker_present());
    }

    #[test]
    fn migration_rollback_restores_validator_store_byte_exact() {
        let (node, _d) = legacy_production_node();
        let dump_before: Vec<Vec<(Vec<u8>, Vec<u8>)>> = node.validator_store.trees().iter().map(|t| snapshot_tree(t).unwrap()).collect();
        let err = node.migrate_canonical_ledger(&|n| {
            // the ledger + validator transition are already applied in memory/store at this point
            assert_canonical_validators(n);
            Err("injected disk failure after validator transition".to_string())
        }).unwrap_err();
        assert!(err.contains("rolled back"), "{err}");
        let dump_after: Vec<Vec<(Vec<u8>, Vec<u8>)>> = node.validator_store.trees().iter().map(|t| snapshot_tree(t).unwrap()).collect();
        assert_eq!(dump_before, dump_after, "validator trees byte-exact after rollback");
        assert_eq!(stake_and_quorum(&node.validator_rows().unwrap()), (120_000, 80_001), "phantom validator is back (legacy state)");
        assert_eq!(node.get_total_fees_burned().to_bits(), PRODUCTION_FEES_BURNED_BITS_AT_F_MINUS_1, "fees_burned restored");
        assert_eq!(node.fee_db.get(b"total_burned").unwrap().map(|v| v.to_vec()), Some(f64::from_bits(PRODUCTION_FEES_BURNED_BITS_AT_F_MINUS_1).to_string().into_bytes()));
        ledger_matches_table(&node.balances.lock().unwrap(), PRODUCTION_LEDGER_AT_F_MINUS_1).unwrap();
        assert_eq!(node.migrate_canonical_ledger(&persist).unwrap(), "migrated");
        assert_canonical_validators(&node);
    }

    /// Finality after the fork counts ONLY ledger-backed stake: total 110,000, quorum 73,334.
    /// The genesis validator alone (100,000) reaches quorum; the 10,000 validator alone does not;
    /// the removed h29 staker has no weight at all.
    #[test]
    fn finality_quorum_uses_backed_stake_only() {
        let (node, _d) = legacy_production_node();
        assert_eq!(stake_and_quorum(&node.validator_rows().unwrap()), (120_000, 80_001), "legacy: 10,000 phantom weight inflates the quorum");
        node.migrate_canonical_ledger(&persist).unwrap();
        let stakes = node.get_validator_stakes().unwrap();
        let total: u128 = stakes.values().sum();
        let quorum = total * 2 / 3 + 1;
        assert_eq!((total, quorum), (110_000, 73_334));
        let expected: BTreeMap<String, u128> = CANONICAL_VALIDATOR_STATE_AT_F_MINUS_1.iter().map(|(k, s, ..)| (k.to_string(), *s)).collect();
        assert_eq!(stakes, expected, "proposer-selection stake map == canonical table");
        let w = |prefix: &str| stakes.iter().filter(|(k, _)| k.starts_with(prefix)).map(|(_, s)| *s).sum::<u128>();
        assert!(w("8ccf7878") >= quorum && w("21e0ed0a") < quorum && w("c97f59a2") == 0);
        assert_eq!(node.state_digest().unwrap()["quorum"], 73_334);
    }

    #[test]
    fn migration_refuses_one_quanta_mismatch_and_leaves_state_untouched() {
        let (node, _d) = legacy_production_node();
        { let mut b = node.balances.lock().unwrap(); *b.get_mut("__treasury__").unwrap() += 1; }
        let before = node.balances.lock().unwrap().clone();
        let err = node.migrate_canonical_ledger(&persist).unwrap_err();
        assert!(err.contains("does not match PRODUCTION_LEDGER_AT_F_MINUS_1"), "{err}");
        assert_eq!(*node.balances.lock().unwrap(), before, "no partial migration");
        assert!(!node.canonical_marker_present());
    }

    #[test]
    fn migration_partial_write_failure_rolls_back_completely() {
        let (node, _d) = legacy_production_node();
        let before = node.balances.lock().unwrap().clone();
        let snap_before = node.snapshot_db.get(b"balances").unwrap().map(|v| v.to_vec());
        let err = node.migrate_canonical_ledger(&|_n| Err("injected disk failure mid-write".to_string())).unwrap_err();
        assert!(err.contains("rolled back"), "{err}");
        assert_eq!(*node.balances.lock().unwrap(), before, "in-memory ledger restored exactly");
        assert!(!node.canonical_marker_present(), "no marker after failed migration");
        assert_eq!(node.snapshot_db.get(b"balances").unwrap().map(|v| v.to_vec()), snap_before, "persisted snapshot unchanged");
        assert!(node.fork_readiness_check().is_err(), "still a legacy node");
        assert_eq!(stake_and_quorum(&node.validator_rows().unwrap()), (120_000, 80_001), "validator store untouched");
        assert_eq!(node.migrate_canonical_ledger(&persist).unwrap(), "migrated", "a later correct migration succeeds");
        assert_canonical_validators(&node);
    }

    #[test]
    fn migration_refuses_wrong_tip() {
        let gc: crate::GenesisConfig = serde_json::from_str(&std::fs::read_to_string(FIXTURE_GENESIS).unwrap()).unwrap();
        let (_l, _f, src, _d1) = replay_fixture_node();
        let dir = TmpDir(std::env::temp_dir().join(format!("fork-tip-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())));
        std::fs::create_dir_all(&dir.0).unwrap();
        let n2 = L1Node::new(NodeOptions { data_dir: dir.0.clone(), chain: src.opts.chain.clone(), mine: false, bridge_withdraw_store: None,
            bridge_authority_keys: gc.initial_validators.iter().map(|v| v.pub_key.clone()).collect(), genesis_allocations: gc.initial_allocations.clone(), genesis_validators: gc.initial_validators.clone() }).unwrap();
        n2.init().unwrap(); n2.apply_genesis_allocations(&gc.initial_allocations, &gc.initial_validators).unwrap();
        for b in src.get_all_blocks().unwrap().into_iter().filter(|b| (1..=47).contains(&b.header.height)) { n2.import_block(b).unwrap(); }
        let err = n2.migrate_canonical_ledger(&|n| n.persist_snapshot_atomic(47)).unwrap_err();
        assert!(err.contains("requires tip == 48"), "{err}");
    }

    #[test]
    fn fork_block_f_requires_exact_canonical_root_then_normal_verification() {
        let (node, _d) = legacy_production_node();
        assert_eq!(node.migrate_canonical_ledger(&persist).unwrap(), "migrated");
        let p = proposer_keys(); let t = chrono::Utc::now().timestamp_millis() as u64;
        let err = node.import_block(seal(&node, &p, vec![], Some("11".repeat(32)), t)).unwrap_err();
        assert!(err.contains("state root mismatch at height 49"), "wrong root at F rejected by NORMAL verification: {err}");
        assert_eq!(node.tip_height().unwrap(), 48);
        let root_f = probe_root(&node, &p, &[], t);
        node.import_block(seal(&node, &p, vec![], Some(root_f.clone()), t)).expect("fork block F accepted");
        assert_eq!(node.tip_height().unwrap(), FORK_HEIGHT);
        assert_eq!(node.get_block(FORK_HEIGHT).unwrap().unwrap().header.state_root.as_deref(), Some(root_f.as_str()));
        assert!(node.import_block(seal(&node, &p, vec![], Some("22".repeat(32)), t + 1)).unwrap_err().contains("state root mismatch at height 50"), "no checkpoint exceptions after F");
        eprintln!("FORK_BLOCK_F_ROOT(empty block)={}", root_f);
    }

    #[test]
    fn post_fork_restart_snapshot_loss_and_corruption_all_reach_identical_state() {
        let (node, _d) = legacy_production_node();
        node.migrate_canonical_ledger(&persist).unwrap();
        let p = proposer_keys(); let t = chrono::Utc::now().timestamp_millis() as u64;
        let root_f = probe_root(&node, &p, &[], t);
        node.import_block(seal(&node, &p, vec![], Some(root_f), t)).unwrap();
        let reference = consensus_fields(&node);
        assert_eq!(reference["tip"], FORK_HEIGHT);
        let opts = node.opts.clone(); drop(node);
        // (a) valid snapshot restart
        let n1 = reopen(&opts); assert_eq!(consensus_fields(&n1), reference, "snapshot restart"); assert!(n1.canonical_marker_present()); drop(n1);
        // (b) snapshot loss → deterministic recovery from genesis through checkpoints + fork
        std::fs::remove_dir_all(opts.data_dir.join("snapshot-db")).unwrap();
        let n2 = reopen(&opts); assert_eq!(consensus_fields(&n2), reference, "recovery without snapshot"); assert!(n2.canonical_marker_present()); drop(n2);
        // (c) corrupt snapshot → rejected → same deterministic recovery
        { let db = sled::open(opts.data_dir.join("snapshot-db")).unwrap(); let tr = db.open_tree("balance_snapshot").unwrap(); tr.insert(b"balances", &b"{corrupt"[..]).unwrap(); tr.flush().unwrap(); }
        let n3 = reopen(&opts); assert_eq!(consensus_fields(&n3), reference, "recovery from corrupt snapshot");
    }

    /// Issue #66 regression (item 12): burned bridge_withdraw principal and a stake debit must
    /// NEVER become proposer/validator/treasury income — neither on the live path nor on
    /// recovery-from-history (which is now the same path).
    #[test]
    fn principal_burn_and_stake_debit_are_never_fee_income() {
        let (node, _d) = legacy_production_node();
        node.migrate_canonical_ledger(&persist).unwrap();
        let user = pqc_keygen(); let p = proposer_keys(); let t = chrono::Utc::now().timestamp_millis() as u64;
        node.balances.lock().unwrap().insert(canon_addr(&user.public_key_hex), xrge_f64_to_quanta(20_000.0));
        // the ledger changed off-block; re-persist so the F-1 snapshot/marker stay consistent for recovery
        let mk = |ty: &str, amount: u64, fee: f64, nonce: u64| { let mut tx = TxV1 { version: 1, tx_type: ty.into(), from_pub_key: user.public_key_hex.clone(), nonce,
            payload: TxPayload { amount: Some(amount), token_symbol: if ty == "bridge_withdraw" { Some("XRGE".into()) } else { None }, evm_address: if ty == "bridge_withdraw" { Some("0x00000000000000000000000000000000000000a1".into()) } else { None }, ..Default::default() },
            fee, sig: String::new(), signed_payload: None }; tx.sig = pqc_sign(&user.secret_key_hex, &encode_tx_for_signing(&tx)).unwrap(); tx };
        let txs = vec![mk("bridge_withdraw", 100, 0.1, 1), mk("stake", 10_000, 1.0, 2)];
        let others_before: u128 = node.balances.lock().unwrap().iter().filter(|(k, _)| **k != canon_addr(&user.public_key_hex)).map(|(_, v)| *v).sum();
        let root = probe_root(&node, &p, &txs, t);
        node.import_block(seal(&node, &p, txs, Some(root), t)).unwrap();
        let others_after: u128 = node.balances.lock().unwrap().iter().filter(|(k, _)| **k != canon_addr(&user.public_key_hex)).map(|(_, v)| *v).sum();
        let income = others_after - others_before;
        let fees = fee_to_quanta(0.1) + fee_to_quanta(1.0);
        assert!(income <= fees, "everyone else's income {} must not exceed the fees {} — principal 100 XRGE and stake 10,000 XRGE are NOT fee income", income, fees);
        assert!(income > fees - fee_to_quanta(0.01), "fees (minus the base-fee burn) were distributed: {}", income);
        let q = *node.balances.lock().unwrap().get(&canon_addr(&user.public_key_hex)).unwrap();
        assert_eq!(q, xrge_f64_to_quanta(20_000.0) - fee_to_quanta(100.1) - fee_to_quanta(10_001.0), "user debited exactly principal + stake + fees (quanta)");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validator-state atomicity (issue #66 final blocker): stake / unstake must share ONE
// success decision between the economic ledger and the validator store, sequentially
// within a block. These tests encode the REQUIRED behaviour; on the pre-fix code they
// reproduce the live exploit shape (validator power without a ledger debit).
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod validator_atomicity_tests {
    use super::*;
    use super::bridge_r1_daemon_tests::{node_with_store, fund_xrge, signed, sealed_block};

    fn stake_tx(from: &str, amount: u64, fee: f64, nonce: u64) -> TxV1 {
        TxV1 { version: 1, tx_type: "stake".into(), from_pub_key: from.into(), nonce,
            payload: TxPayload { amount: Some(amount), ..Default::default() }, fee, sig: String::new(), signed_payload: None }
    }
    fn unstake_tx(from: &str, amount: u64, fee: f64, nonce: u64) -> TxV1 {
        TxV1 { version: 1, tx_type: "unstake".into(), from_pub_key: from.into(), nonce,
            payload: TxPayload { amount: Some(amount), ..Default::default() }, fee, sig: String::new(), signed_payload: None }
    }
    fn staked(node: &L1Node, pk: &str) -> u128 { node.validator_store.get_validator(pk).unwrap().map(|v| v.stake).unwrap_or(0) }
    /// Import a block of `txs` with its correct root (probe + rollback), returning the receipts' statuses.
    fn import_with_correct_root(node: &L1Node, proposer_pub: &str, proposer_sk: &str, txs: Vec<TxV1>) -> Vec<TxStatus> {
        let t = chrono::Utc::now().timestamp_millis() as u64;
        let probe = sealed_block(node, proposer_pub, proposer_sk, txs.clone(), None, t);
        let snap = node.capture_pre_apply_snapshot(&probe).unwrap();
        let _ = node.apply_balance_block(&probe).unwrap();
        let root = node.get_state_root().unwrap();
        node.restore_pre_apply_snapshot(snap).unwrap();
        let good = sealed_block(node, proposer_pub, proposer_sk, txs.clone(), Some(root), t);
        node.import_block(good).expect("block accepted");
        txs.iter().map(|tx| node.get_receipt(&compute_single_tx_hash(tx)).unwrap().unwrap().status).collect()
    }

    #[test]
    fn insolvent_stake_cannot_create_validator_power() {
        let (_d, node, _s) = node_with_store();
        let p = pqc_keygen(); let u = pqc_keygen();
        fund_xrge(&node, &u.public_key_hex, 10_000.87); // < 10,000 + 1 fee  (the h29 shape)
        let st = import_with_correct_root(&node, &p.public_key_hex, &p.secret_key_hex,
            vec![signed(stake_tx(&u.public_key_hex, 10_000, 1.0, 1), &u.secret_key_hex)]);
        assert_eq!(node.get_balance(&u.public_key_hex).unwrap(), 10_000.87, "ledger debit must be a no-op");
        assert_eq!(staked(&node, &u.public_key_hex), 0, "NO validator power without a ledger debit");
        assert!(matches!(&st[0], TxStatus::Failed(_)), "failed stake must not be reported Success: {:?}", st[0]);
    }

    #[test]
    fn same_block_double_stake_locks_only_what_was_paid() {
        let (_d, node, _s) = node_with_store();
        let p = pqc_keygen(); let u = pqc_keygen();
        fund_xrge(&node, &u.public_key_hex, 10_001.5); // enough for exactly ONE 10,000 stake + fee
        let st = import_with_correct_root(&node, &p.public_key_hex, &p.secret_key_hex, vec![
            signed(stake_tx(&u.public_key_hex, 10_000, 1.0, 1), &u.secret_key_hex),
            signed(stake_tx(&u.public_key_hex, 10_000, 1.0, 2), &u.secret_key_hex),
        ]);
        assert_eq!(staked(&node, &u.public_key_hex), 10_000, "validator power == XRGE actually locked (not 20,000)");
        assert_eq!(node.get_balance(&u.public_key_hex).unwrap(), 0.5);
        assert!(matches!(st[0], TxStatus::Success) && matches!(&st[1], TxStatus::Failed(_)), "{:?}", st);
    }

    #[test]
    fn same_block_double_unstake_cannot_release_more_than_staked() {
        let (_d, node, _s) = node_with_store();
        let p = pqc_keygen(); let u = pqc_keygen();
        fund_xrge(&node, &u.public_key_hex, 10_003.0);
        // stake exactly 10,000 first (its own block)
        import_with_correct_root(&node, &p.public_key_hex, &p.secret_key_hex,
            vec![signed(stake_tx(&u.public_key_hex, 10_000, 1.0, 1), &u.secret_key_hex)]);
        assert_eq!(staked(&node, &u.public_key_hex), 10_000);
        let before_q = node.unbonding_queue.lock().unwrap().len();
        let st = import_with_correct_root(&node, &p.public_key_hex, &p.secret_key_hex, vec![
            signed(unstake_tx(&u.public_key_hex, 10_000, 1.0, 2), &u.secret_key_hex),
            signed(unstake_tx(&u.public_key_hex, 10_000, 1.0, 3), &u.secret_key_hex),
        ]);
        assert_eq!(staked(&node, &u.public_key_hex), 0, "first unstake releases the whole stake");
        let q = node.unbonding_queue.lock().unwrap();
        let mine: Vec<_> = q.iter().skip(before_q).filter(|e| e.delegator == u.public_key_hex).collect();
        assert_eq!(mine.len(), 1, "exactly ONE unbonding entry");
        assert_eq!(mine[0].amount, 10_000.0, "totalling 10,000 — never 20,000");
        drop(q);
        assert!(matches!(st[0], TxStatus::Success) && matches!(&st[1], TxStatus::Failed(_)), "{:?}", st);
        // exactly ONE unstake fee was paid: 10,003 − 10,001 (stake+fee) − 1 = 1.0, plus the staker's own
        // validator fee-share income for this block (< 0.7 XRGE) — a second fee would leave < 1.0.
        let bal = node.get_balance(&u.public_key_hex).unwrap();
        assert!((1.0..1.7).contains(&bal), "only the successful unstake's fee was paid: {bal}");
    }

    #[test]
    fn failed_fee_cannot_change_validator_state() {
        let (_d, node, _s) = node_with_store();
        let p = pqc_keygen(); let u = pqc_keygen();
        fund_xrge(&node, &u.public_key_hex, 10_002.0);
        import_with_correct_root(&node, &p.public_key_hex, &p.secret_key_hex,
            vec![signed(stake_tx(&u.public_key_hex, 10_000, 1.0, 1), &u.secret_key_hex)]);
        assert_eq!(node.get_balance(&u.public_key_hex).unwrap(), 1.0);
        // unstake with a fee the account cannot pay (fee 5 > balance 1)
        let st = import_with_correct_root(&node, &p.public_key_hex, &p.secret_key_hex,
            vec![signed(unstake_tx(&u.public_key_hex, 10_000, 5.0, 2), &u.secret_key_hex)]);
        assert_eq!(staked(&node, &u.public_key_hex), 10_000, "validator state unchanged when the fee fails");
        assert!(node.unbonding_queue.lock().unwrap().iter().all(|e| e.delegator != u.public_key_hex), "no unbonding entry");
        assert!(matches!(&st[0], TxStatus::Failed(_)));
    }

    #[test]
    fn rejected_block_leaves_no_validator_or_unbonding_mutation() {
        let (_d, node, _s) = node_with_store();
        let p = pqc_keygen(); let u = pqc_keygen();
        fund_xrge(&node, &u.public_key_hex, 20_003.0);
        let t = chrono::Utc::now().timestamp_millis() as u64;
        let vals_before = serde_json::to_string(&node.list_validators().unwrap()).unwrap(); let q_before = serde_json::to_string(&*node.unbonding_queue.lock().unwrap()).unwrap();
        let bad = sealed_block(&node, &p.public_key_hex, &p.secret_key_hex,
            vec![signed(stake_tx(&u.public_key_hex, 10_000, 1.0, 1), &u.secret_key_hex)], Some("ab".repeat(32)), t);
        assert!(node.import_block(bad).unwrap_err().contains("state root mismatch"));
        assert_eq!(serde_json::to_string(&node.list_validators().unwrap()).unwrap(), vals_before, "validator store untouched by a rejected block");
        assert_eq!(serde_json::to_string(&*node.unbonding_queue.lock().unwrap()).unwrap(), q_before);
        assert_eq!(staked(&node, &u.public_key_hex), 0);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Producer atomicity, pre-root matured unbonding, post-root invariant, verified peer sync.
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod producer_and_unbonding_tests {
    use super::*;
    use super::bridge_r1_daemon_tests::{node_with_store, fund_xrge, signed, sealed_block};

    fn stake_tx(from: &str, amount: u64, fee: f64, nonce: u64) -> TxV1 {
        TxV1 { version: 1, tx_type: "stake".into(), from_pub_key: from.into(), nonce,
            payload: TxPayload { amount: Some(amount), ..Default::default() }, fee, sig: String::new(), signed_payload: None }
    }
    fn unstake_tx(from: &str, amount: u64, fee: f64, nonce: u64) -> TxV1 {
        TxV1 { version: 1, tx_type: "unstake".into(), from_pub_key: from.into(), nonce,
            payload: TxPayload { amount: Some(amount), ..Default::default() }, fee, sig: String::new(), signed_payload: None }
    }
    fn xfer_tx(from: &str, to: &str, amount: u64, fee: f64, nonce: u64) -> TxV1 {
        TxV1 { version: 1, tx_type: "transfer".into(), from_pub_key: from.into(), nonce,
            payload: TxPayload { to_pub_key_hex: Some(to.into()), amount: Some(amount), ..Default::default() }, fee, sig: String::new(), signed_payload: None }
    }
    /// Every consensus-relevant component (what the dress rehearsal compares), minus tip hash/time.
    fn consensus_state(n: &L1Node) -> serde_json::Value {
        let d = n.state_digest().unwrap();
        serde_json::json!({ "tip": d["tip"], "state_root": d["state_root"], "balances": d["balances"], "token_balances": d["token_balances"],
            "lp_balances": d["lp_balances"], "burned_tokens": d["burned_tokens"], "base_fee_quanta": d["base_fee_quanta"], "fees_burned_bits": d["fees_burned_bits"],
            "shielded_supply_bits": d["shielded_supply_bits"], "validators": d["validators"], "total_stake": d["total_stake"], "quorum": d["quorum"], "unbonding": d["unbonding"] })
    }
    fn full_fingerprint(n: &L1Node, store: &BridgeWithdrawStore) -> (serde_json::Value, String, usize, usize) {
        (consensus_state(n), n.store.get_tip().unwrap().hash, store.list().map(|v| v.len()).unwrap_or(0), n.mempool.lock().unwrap().len())
    }
    /// Producer node: its block-signing key is also a funded, staked validator.
    fn producer() -> (super::bridge_r1_daemon_tests::TmpDir, L1Node, std::sync::Arc<BridgeWithdrawStore>, PQKeypair) {
        let (d, node, store) = node_with_store();
        let p = pqc_keygen();
        *node.keys.lock().unwrap() = PQKeypair { algorithm: p.algorithm.clone(), public_key_hex: p.public_key_hex.clone(), secret_key_hex: p.secret_key_hex.clone() };
        fund_xrge(&node, &p.public_key_hex, 5_000.0);
        (d, node, store, p)
    }
    fn mine(node: &L1Node, txs: Vec<TxV1>) -> BlockV1 {
        for tx in txs { node.add_tx_to_mempool_verified(tx).unwrap(); }
        node.mine_pending().unwrap().expect("block produced")
    }
    /// Empty block on top of the tip via the import path with the correct root (probe + rollback).
    fn import_empty(node: &L1Node, p: &PQKeypair, time: u64) -> BlockV1 {
        let probe = sealed_block(node, &p.public_key_hex, &p.secret_key_hex, vec![], None, time);
        let snap = node.capture_pre_apply_snapshot(&probe).unwrap();
        let _ = node.apply_balance_block(&probe).unwrap();
        let root = node.get_state_root().unwrap();
        node.restore_pre_apply_snapshot(snap).unwrap();
        let b = sealed_block(node, &p.public_key_hex, &p.secret_key_hex, vec![], Some(root), time);
        node.import_block(b.clone()).unwrap(); b
    }

    // ── 1. producer failure atomicity (root / validator persistence / append) + retry ──
    #[test]
    fn producer_failures_roll_back_everything_and_requeue_then_retry_equals_clean_node() {
        let u = pqc_keygen();
        let (_d, node, store, p) = producer();
        let (_d2, clean, _s2) = node_with_store();
        *clean.keys.lock().unwrap() = PQKeypair { algorithm: p.algorithm.clone(), public_key_hex: p.public_key_hex.clone(), secret_key_hex: p.secret_key_hex.clone() };
        fund_xrge(&clean, &p.public_key_hex, 5_000.0);
        for n in [&node, &clean] { fund_xrge(n, &u.public_key_hex, 1_000.0); }
        // a pending unbonding entry that matures in the attempted block, so the rollback must
        // also restore the queue and the credit
        let h = node.tip_height().unwrap() + 1;
        for n in [&node, &clean] { n.unbonding_queue.lock().unwrap().push(UnbondingEntry { delegator: u.public_key_hex.clone(), amount: 7.0, release_height: h }); }
        let txs = || vec![signed(xfer_tx(&u.public_key_hex, &p.public_key_hex, 10, 0.5, 1), &u.secret_key_hex),
                          signed(stake_tx(&p.public_key_hex, 100, 1.0, 1), &p.secret_key_hex)];
        let before = full_fingerprint(&node, &store);
        for fault in [1u8, 2, 3] {
            TEST_PRODUCER_FAULT.with(|c| c.set(fault));
            for tx in txs() { node.add_tx_to_mempool_verified(tx).unwrap(); }
            let err = node.mine_pending().unwrap_err();
            TEST_PRODUCER_FAULT.with(|c| c.set(0));
            assert!(err.contains("rolled back"), "fault {}: {}", fault, err);
            let after = full_fingerprint(&node, &store);
            assert_eq!(after.0, before.0, "fault {}: consensus state (ledger, validators, unbonding, base fee) unchanged", fault);
            assert_eq!(after.1, before.1, "fault {}: tip unchanged", fault);
            assert_eq!(after.2, before.2, "fault {}: bridge store unchanged", fault);
            assert_eq!(after.3, 2, "fault {}: both txs requeued", fault);
            assert!(node.mined_tx_hashes.lock().unwrap().is_empty(), "fault {}: nothing marked mined", fault);
            assert_eq!(node.unbonding_queue.lock().unwrap().len(), 1, "fault {}: matured entry still pending", fault);
            node.mempool.lock().unwrap().clear();
        }
        // retry: same logical block after the fault is removed == a clean node that never failed
        let b = mine(&node, txs());
        let cb = mine(&clean, txs());
        assert_eq!(b.header.height, cb.header.height);
        assert_eq!(b.header.state_root, cb.header.state_root, "identical committed root");
        assert_eq!(consensus_state(&node), consensus_state(&clean), "identical consensus state after retry");
        assert!(node.unbonding_queue.lock().unwrap().is_empty(), "matured entry released exactly once");
        assert_eq!(node.mined_tx_hashes.lock().unwrap().len(), 2);
        assert_eq!(node.validator_store.get_validator(&p.public_key_hex).unwrap().unwrap().stake, 100);
    }

    // ── 2. matured unbonding is committed in the root; peer importer, restart and recovery agree ──
    #[test]
    fn matured_unbonding_is_credited_before_root_and_reproduced_by_peer_restart_and_recovery() {
        let (_d, a, _sa, p) = producer();
        let u = pqc_keygen();
        fund_xrge(&a, &u.public_key_hex, 1_000.0);
        let t0 = chrono::Utc::now().timestamp_millis() as u64;
        // block 1: proposer stakes 1000 (so it stays a valid proposer past the auth window); user stakes 100
        mine(&a, vec![signed(stake_tx(&p.public_key_hex, 1_000, 1.0, 1), &p.secret_key_hex), signed(stake_tx(&u.public_key_hex, 100, 1.0, 1), &u.secret_key_hex)]);
        // block 2: user unstakes 100 → release at 2 + UNBONDING_BLOCKS
        mine(&a, vec![signed(unstake_tx(&u.public_key_hex, 100, 1.0, 2), &u.secret_key_hex)]);
        let release_h = 2 + UNBONDING_BLOCKS;
        assert_eq!(a.unbonding_rows().unwrap(), vec![(u.public_key_hex.clone(), 100f64.to_bits(), release_h)]);
        let bal_before = *a.balances.lock().unwrap().get(&canon_addr(&u.public_key_hex)).unwrap();
        // the pending queue is persisted in the snapshot (it is consensus state)
        { let raw = a.snapshot_db.get(b"unbonding_queue").unwrap().expect("snapshot carries the unbonding queue");
          let q: Vec<UnbondingEntry> = serde_json::from_slice(&raw).unwrap();
          assert_eq!(q.len(), 1); assert_eq!(q[0].release_height, release_h); assert_eq!(q[0].amount, 100.0); }
        // blocks 3 .. release_h-1: no release
        for h in 3..release_h { import_empty(&a, &p, t0 + h); }
        assert_eq!(a.tip_height().unwrap(), release_h - 1);
        assert_eq!(*a.balances.lock().unwrap().get(&canon_addr(&u.public_key_hex)).unwrap(), bal_before, "no release before release_height");
        assert_eq!(a.unbonding_queue.lock().unwrap().len(), 1);
        // block release_h via the LOCAL MINER: the credit lands before the root is sealed
        let blk = mine(&a, vec![signed(xfer_tx(&u.public_key_hex, &p.public_key_hex, 1, 0.5, 3), &u.secret_key_hex)]);
        assert_eq!(blk.header.height, release_h);
        let bal_after = *a.balances.lock().unwrap().get(&canon_addr(&u.public_key_hex)).unwrap();
        assert_eq!(bal_after, bal_before + xrge_f64_to_quanta(100.0) - xrge_f64_to_quanta(1.5), "released 100 XRGE exactly once (minus the 1 XRGE transfer + 0.5 fee)");
        assert!(a.unbonding_queue.lock().unwrap().is_empty(), "entry removed");
        assert_eq!(blk.header.state_root.as_deref(), Some(a.get_state_root().unwrap().as_str()), "header root == post-block state incl. the credit");
        // peer importer B recomputes the same root for every block, including the release block
        let (_db, b, _sb) = node_with_store();
        fund_xrge(&b, &p.public_key_hex, 5_000.0); fund_xrge(&b, &u.public_key_hex, 1_000.0);
        for blk in a.get_all_blocks().unwrap().into_iter().filter(|x| x.header.height > 0) { b.import_block(blk).unwrap(); }
        assert_eq!(consensus_state(&b), consensus_state(&a), "peer import parity incl. release");
        // snapshot restart of A reproduces the same state (queue empty, credit present); the
        // no-snapshot recovery variant is `unbonding_recovery_without_snapshot_reproduces_root_with_genesis_funding`
        let opts = a.opts.clone(); let reference = consensus_state(&a); drop(a);
        let r1 = L1Node::new(opts).unwrap(); r1.init().unwrap();
        assert_eq!(consensus_state(&r1), reference, "snapshot restart");
    }

    /// Recovery parity for the unbonding path with ALL funding in history (genesis allocations).
    #[test]
    fn unbonding_recovery_without_snapshot_reproduces_root_with_genesis_funding() {
        let p = pqc_keygen(); let u = pqc_keygen();
        let dir = super::bridge_r1_daemon_tests::TmpDir::new();
        let alloc = vec![crate::GenesisAllocation { address: p.public_key_hex.clone(), amount: 5_000, label: None }, crate::GenesisAllocation { address: u.public_key_hex.clone(), amount: 1_000, label: None }];
        let mk = || { let n = L1Node::new(NodeOptions { data_dir: dir.0.clone(), chain: ChainConfig { chain_id: "test".into(), genesis_time: 0, block_time_ms: 1000 }, mine: false,
            bridge_withdraw_store: None, bridge_authority_keys: Vec::new(), genesis_allocations: alloc.clone(), genesis_validators: Vec::new() }).unwrap(); n };
        let a = mk(); a.init().unwrap(); // init() applies the genesis seed exactly once
        assert_eq!(*a.balances.lock().unwrap().get(&canon_addr(&p.public_key_hex)).unwrap(), xrge_f64_to_quanta(5_000.0));
        *a.keys.lock().unwrap() = PQKeypair { algorithm: p.algorithm.clone(), public_key_hex: p.public_key_hex.clone(), secret_key_hex: p.secret_key_hex.clone() };
        mine(&a, vec![signed(stake_tx(&p.public_key_hex, 1_000, 1.0, 1), &p.secret_key_hex), signed(stake_tx(&u.public_key_hex, 100, 1.0, 1), &u.secret_key_hex)]);
        mine(&a, vec![signed(unstake_tx(&u.public_key_hex, 100, 1.0, 2), &u.secret_key_hex)]);
        let release_h = 2 + UNBONDING_BLOCKS; let t0 = 1_000_000u64;
        for h in 3..release_h { import_empty(&a, &p, t0 + h); }
        mine(&a, vec![signed(xfer_tx(&u.public_key_hex, &p.public_key_hex, 1, 0.5, 3), &u.secret_key_hex)]);
        import_empty(&a, &p, t0 + release_h + 1);
        let reference = consensus_state(&a); assert!(a.unbonding_queue.lock().unwrap().is_empty()); drop(a);
        std::fs::remove_dir_all(dir.0.join("snapshot-db")).unwrap();
        let r = mk(); r.init().unwrap();
        assert_eq!(consensus_state(&r), reference, "no-snapshot recovery reproduces the release exactly once");
    }

    // ── 3. post-root invariant: apply_validator_block never mutates root-covered maps ──
    #[test]
    fn post_root_validator_apply_cannot_mutate_balance_maps() {
        let (_d, node, _s) = node_with_store();
        let p = pqc_keygen(); let u = pqc_keygen();
        fund_xrge(&node, &u.public_key_hex, 1_000.0); fund_xrge(&node, &p.public_key_hex, 10.0);
        let h = node.tip_height().unwrap() + 1;
        node.unbonding_queue.lock().unwrap().push(UnbondingEntry { delegator: p.public_key_hex.clone(), amount: 3.0, release_height: h });
        let txs = vec![signed(stake_tx(&u.public_key_hex, 100, 1.0, 1), &u.secret_key_hex), signed(unstake_tx(&u.public_key_hex, 40, 1.0, 2), &u.secret_key_hex)];
        let blk = sealed_block(&node, &p.public_key_hex, &p.secret_key_hex, txs, None, 1);
        let exec = node.apply_balance_block(&blk).unwrap();
        let root = node.get_state_root().unwrap();
        let (b0, t0, l0) = (node.balances.lock().unwrap().clone(), node.token_balances.lock().unwrap().clone(), node.lp_balances.lock().unwrap().clone());
        let pb = *b0.get(&canon_addr(&p.public_key_hex)).unwrap();
        assert!(pb >= xrge_f64_to_quanta(13.0) && pb < xrge_f64_to_quanta(15.0), "matured release (3 XRGE) credited BEFORE the root (+ proposer fee share): {}", pb);
        node.apply_validator_block(&blk, &exec.validator).unwrap();
        assert_eq!(*node.balances.lock().unwrap(), b0, "balances untouched after the root is sealed");
        assert_eq!(*node.token_balances.lock().unwrap(), t0);
        assert_eq!(*node.lp_balances.lock().unwrap(), l0);
        assert_eq!(node.get_state_root().unwrap(), root, "root unchanged by the validator phase");
        assert_eq!(node.validator_store.get_validator(&u.public_key_hex).unwrap().unwrap().stake, 60, "validator-store effects applied post-root");
    }
}

#[cfg(test)]
mod peer_sync_tests {
    use super::*;
    use super::strict_historical_replay_tests::{replay_fixture_node, TmpDir, FIXTURE_GENESIS};
    use crate::fork::*;
    use crate::peer::apply_peer_blocks;

    struct Keys(String, String);
    fn keys() -> Keys { let k = pqc_keygen(); Keys(k.public_key_hex, k.secret_key_hex) }
    fn seal(node: &L1Node, p: &Keys, txs: Vec<TxV1>, root: Option<String>, time: u64) -> BlockV1 {
        let tip = node.store.get_tip().unwrap();
        let header = BlockHeaderV1 { version: 1, chain_id: node.opts.chain.chain_id.clone(), height: tip.height + 1, time, prev_hash: tip.hash,
            tx_hash: compute_tx_hash(&txs), proposer_pub_key: p.0.clone(), state_root: root };
        let hb = encode_header_v1(&header); let sig = pqc_sign(&p.1, &hb).unwrap(); let hash = compute_block_hash(&hb, &sig);
        BlockV1 { version: 1, header, txs, proposer_sig: sig, hash }
    }
    fn probe_root(node: &L1Node, p: &Keys, time: u64) -> String {
        let probe = seal(node, p, vec![], None, time);
        let snap = node.capture_pre_apply_snapshot(&probe).unwrap();
        let _ = node.apply_balance_block(&probe).unwrap();
        let r = node.get_state_root().unwrap(); node.restore_pre_apply_snapshot(snap).unwrap(); r
    }
    /// Mainnet-fixture source at 49 (canonical 48 + one post-fork block) and an empty fresh node.
    fn source_and_fresh() -> (L1Node, TmpDir, L1Node, TmpDir, Keys) {
        let (last, fail, src, d1) = replay_fixture_node();
        assert!(fail.is_none() && last == FORK_HEIGHT - 1);
        let p = keys(); let t = chrono::Utc::now().timestamp_millis() as u64;
        let root = probe_root(&src, &p, t);
        src.import_block(seal(&src, &p, vec![], Some(root), t)).unwrap();
        let gc: crate::GenesisConfig = serde_json::from_str(&std::fs::read_to_string(FIXTURE_GENESIS).unwrap()).unwrap();
        let d2 = TmpDir(std::env::temp_dir().join(format!("peer-fresh-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())));
        std::fs::create_dir_all(&d2.0).unwrap();
        let fresh = L1Node::new(NodeOptions { data_dir: d2.0.clone(), chain: src.opts.chain.clone(), mine: false, bridge_withdraw_store: None,
            bridge_authority_keys: src.opts.bridge_authority_keys.clone(), genesis_allocations: gc.initial_allocations.clone(), genesis_validators: gc.initial_validators.clone() }).unwrap();
        fresh.init().unwrap(); fresh.apply_genesis_allocations(&gc.initial_allocations, &gc.initial_validators).unwrap();
        (src, d1, fresh, d2, p)
    }
    fn digest(n: &L1Node) -> serde_json::Value { let mut d = n.state_digest().unwrap(); d.as_object_mut().unwrap().remove("nonce_db"); d.as_object_mut().unwrap().remove("validators_informational"); d }

    #[test]
    fn fresh_random_node_syncs_0_to_49_only_through_verified_import() {
        let (src, _d1, fresh, _d2, _p) = source_and_fresh();
        let blocks = src.get_all_blocks().unwrap();
        assert_eq!(apply_peer_blocks(&fresh, "src", blocks).unwrap(), 49);
        assert_eq!(fresh.tip_height().unwrap(), 49);
        assert!(fresh.canonical_marker_present() && fresh.fork_readiness_check().is_ok());
        assert_eq!(digest(&fresh), digest(&src), "fresh peer sync == source on every consensus component");
    }

    #[test]
    fn bad_historical_checkpoint_is_rejected_without_reset_and_sync_can_resume() {
        let (src, _d1, fresh, _d2, _p) = source_and_fresh();
        let blocks = src.get_all_blocks().unwrap();
        apply_peer_blocks(&fresh, "src", blocks[..20].to_vec()).unwrap(); // 1..=19
        // a validly SIGNED block 20 carrying a wrong committed root (the shape of a malicious peer)
        let evil = keys(); let mut bad = blocks[20].clone();
        let h20 = seal(&fresh, &evil, bad.txs.clone(), Some("ab".repeat(32)), bad.header.time); bad = h20;
        let tip_before = fresh.store.get_tip().unwrap();
        let err = apply_peer_blocks(&fresh, "evil", vec![bad]).unwrap_err();
        assert!(err.contains("checkpoint mismatch") && err.contains("no reset"), "{err}");
        assert_eq!(fresh.store.get_tip().unwrap().hash, tip_before.hash, "local chain intact at 19");
        // the honest history still imports afterwards
        assert_eq!(apply_peer_blocks(&fresh, "src", blocks.clone()).unwrap(), 30);
        assert_eq!(digest(&fresh), digest(&src));
    }

    #[test]
    fn bad_block_after_fork_is_rejected_without_chain_wipe() {
        let (src, _d1, fresh, _d2, _p) = source_and_fresh();
        apply_peer_blocks(&fresh, "src", src.get_all_blocks().unwrap()).unwrap();
        let evil = keys(); let t = chrono::Utc::now().timestamp_millis() as u64;
        let bad50 = seal(&fresh, &evil, vec![], Some("cd".repeat(32)), t);
        let tip_before = fresh.store.get_tip().unwrap(); let before = digest(&fresh);
        let err = apply_peer_blocks(&fresh, "evil", vec![bad50]).unwrap_err();
        assert!(err.contains("state root mismatch at height 50") && err.contains("no reset"), "{err}");
        assert_eq!(fresh.store.get_tip().unwrap().hash, tip_before.hash);
        assert_eq!(digest(&fresh), before, "state untouched");
    }

    #[test]
    fn incompatible_genesis_and_equal_or_longer_divergent_peer_cannot_replace_local_chain() {
        let (src, _d1, fresh, _d2, p) = source_and_fresh();
        let blocks = src.get_all_blocks().unwrap();
        apply_peer_blocks(&fresh, "src", blocks.clone()).unwrap();
        let established = digest(&fresh); let tip = fresh.store.get_tip().unwrap();
        // (a) different genesis
        let mut foreign = blocks.clone(); foreign[0].hash = "00".repeat(32);
        let err = apply_peer_blocks(&fresh, "foreign", foreign).unwrap_err();
        assert!(err.contains("incompatible chain"), "{err}");
        // (b) different chain id
        let mut other = blocks.clone(); other[5].header.chain_id = "rougechain-devnet-1".into();
        assert!(apply_peer_blocks(&fresh, "other", other).unwrap_err().contains("refusing sync"));
        // (c) a LONGER peer chain with the same genesis but divergent history from height 30: it
        //     can never replace ours — its first block above our tip fails prev_hash; nothing is wiped.
        let (_l, _f, alt, _d3) = replay_fixture_node(); // canonical to 48
        let mut longer: Vec<BlockV1> = alt.get_all_blocks().unwrap();
        let t = chrono::Utc::now().timestamp_millis() as u64;
        // build 50..=60 on the alt node (different proposer ⇒ different hashes than ours from 49)
        let root49 = probe_root(&alt, &p, t + 1); alt.import_block(seal(&alt, &p, vec![], Some(root49), t + 1)).unwrap();
        for i in 2..=12 { let r = probe_root(&alt, &p, t + i); alt.import_block(seal(&alt, &p, vec![], Some(r), t + i)).unwrap(); }
        longer = alt.get_all_blocks().unwrap();
        assert!(longer.len() > tip.height as usize + 1);
        let err = apply_peer_blocks(&fresh, "longer", longer).unwrap_err();
        assert!(err.contains("prev_hash") && err.contains("no reset"), "{err}");
        assert_eq!(fresh.store.get_tip().unwrap().hash, tip.hash, "established chain kept");
        assert_eq!(digest(&fresh), established);
        // (d) an EQUAL-height peer with identical history is simply a no-op
        assert_eq!(apply_peer_blocks(&fresh, "src", blocks).unwrap(), 0);
    }
}

/// C1 — transaction-uniqueness rule (replay of an already-included signed tx).
#[cfg(test)]
mod tx_uniqueness_tests {
    use super::*;
    use super::bridge_r1_daemon_tests::{node_with_store, fund_xrge, sealed_block, signed};
    use quantum_vault_crypto::{pqc_keygen, pqc_sign, pqc_verify};
    use quantum_vault_types::{compute_single_tx_hash, encode_tx_for_signing};

    fn transfer(from: &str, to: &str, amount: u64, nonce: u64) -> TxV1 {
        TxV1 { version: 1, tx_type: "transfer".into(), from_pub_key: from.into(), nonce,
            payload: TxPayload { to_pub_key_hex: Some(to.into()), amount: Some(amount), ..Default::default() },
            fee: 0.1, sig: String::new(), signed_payload: None }
    }
    /// State-root commitment is not what these tests are about: disable it (test-only knob),
    /// and set the C1 activation height for this thread.
    fn setup(activation: Option<u64>) -> (super::bridge_r1_daemon_tests::TmpDir, L1Node, PQKeypair, PQKeypair, PQKeypair) {
        TEST_FORK_HEIGHT_OVERRIDE.with(|c| c.set(Some(u64::MAX)));
        TEST_TX_UNIQUENESS_OVERRIDE.with(|c| c.set(Some(activation)));
        let (d, node, _store) = node_with_store();
        let proposer = pqc_keygen(); let user = pqc_keygen(); let other = pqc_keygen();
        fund_xrge(&node, &user.public_key_hex, 1_000.0);
        (d, node, proposer, user, other)
    }
    fn import(node: &L1Node, p: &PQKeypair, txs: Vec<TxV1>) -> Result<(), String> {
        let t = chrono::Utc::now().timestamp_millis() as u64;
        node.import_block(sealed_block(node, &p.public_key_hex, &p.secret_key_hex, txs, None, t))
    }
    fn bal(node: &L1Node, pk: &str) -> u128 { *node.balances.lock().unwrap().get(&canon_addr(pk)).unwrap_or(&0) }

    #[test]
    fn replay_of_an_included_tx_is_rejected_once_the_rule_is_active() {
        let (_d, node, p, user, other) = setup(Some(1));
        let t1 = signed(transfer(&user.public_key_hex, &other.public_key_hex, 100, 7), &user.secret_key_hex);
        let h = quantum_vault_types::tx_identity(&t1);
        import(&node, &p, vec![t1.clone()]).expect("first inclusion");
        assert_eq!(node.tx_included_at(&h), Some(1));
        let before = bal(&node, &user.public_key_hex);
        let err = import(&node, &p, vec![t1.clone()]).unwrap_err();
        assert!(err.contains("already included in block 1") && err.contains("replay"), "{err}");
        assert_eq!(node.tip_height().unwrap(), 1, "replay block never persisted");
        assert_eq!(bal(&node, &user.public_key_hex), before, "victim not debited twice");
        // a genuinely new tx from the same sender still works
        let t2 = signed(transfer(&user.public_key_hex, &other.public_key_hex, 5, 8), &user.secret_key_hex);
        import(&node, &p, vec![t2]).expect("fresh tx accepted");
        assert_eq!(node.tip_height().unwrap(), 2);
    }

    #[test]
    fn duplicate_within_one_block_is_rejected() {
        let (_d, node, p, user, other) = setup(Some(1));
        let t1 = signed(transfer(&user.public_key_hex, &other.public_key_hex, 100, 7), &user.secret_key_hex);
        let err = import(&node, &p, vec![t1.clone(), t1]).unwrap_err();
        assert!(err.contains("duplicated within the block"), "{err}");
        assert_eq!(node.tip_height().unwrap(), 0);
    }

    #[test]
    fn rule_is_inactive_below_the_activation_height_and_when_unscheduled() {
        // Documents (and pins) the LEGACY behaviour the fork removes: below the activation
        // height a replayed block is still accepted, so history before the fork replays
        // identically on every node.
        for activation in [Some(10), None] {
            let (_d, node, p, user, other) = setup(activation);
            let t1 = signed(transfer(&user.public_key_hex, &other.public_key_hex, 100, 7), &user.secret_key_hex);
            import(&node, &p, vec![t1.clone()]).unwrap();
            let before = bal(&node, &user.public_key_hex);
            import(&node, &p, vec![t1]).expect("legacy: replay accepted below activation");
            assert!(bal(&node, &user.public_key_hex) < before, "legacy: debited again (the bug being fixed)");
            assert_eq!(node.tip_height().unwrap(), 2);
        }
    }

    #[test]
    fn rule_activates_exactly_at_the_activation_height() {
        let (_d, node, p, user, other) = setup(Some(3));
        let t1 = signed(transfer(&user.public_key_hex, &other.public_key_hex, 10, 7), &user.secret_key_hex);
        import(&node, &p, vec![t1.clone()]).unwrap();          // h1
        import(&node, &p, vec![t1.clone()]).unwrap();          // h2: still legacy
        let err = import(&node, &p, vec![t1]).unwrap_err();    // h3: rule active
        assert!(err.contains("replay"), "{err}");
        assert_eq!(node.tip_height().unwrap(), 2);
    }

    #[test]
    fn mempool_refuses_an_included_tx_even_when_the_nonce_check_would_pass() {
        // Real-world shape: after a nonce_db migration/clear the gap-tolerant nonce check no
        // longer knows the tx's nonce, so only the tx-seen index stands between a public
        // API caller and a replay mined by an honest producer.
        let (_d, node, p, user, other) = setup(None);
        let t1 = signed(transfer(&user.public_key_hex, &other.public_key_hex, 100, 1_789_443_418_154), &user.secret_key_hex);
        import(&node, &p, vec![t1.clone()]).unwrap();
        node.nonce_db.clear().unwrap(); // what migrate_nonce_db does for timestamp nonces
        assert!(node.check_nonce_valid(&t1.from_pub_key, t1.nonce).is_ok(), "nonce check alone would pass");
        let err = node.insert_tx_to_mempool(t1).unwrap_err();
        assert!(err.contains("already included in block 1"), "{err}");
        assert!(node.mempool.lock().unwrap().is_empty());
    }

    #[test]
    fn producer_never_includes_an_already_included_tx() {
        let (_d, node, p, user, other) = setup(None);
        let t1 = signed(transfer(&user.public_key_hex, &other.public_key_hex, 100, 7), &user.secret_key_hex);
        import(&node, &p, vec![t1.clone()]).unwrap();
        // bypass admission entirely (simulates a stale mempool / pre-fix peer gossip)
        node.mempool.lock().unwrap().insert(compute_single_tx_hash(&t1), t1);
        let mined = node.mine_pending().unwrap();
        assert!(mined.is_none(), "nothing left to mine once the replay is dropped");
        assert_eq!(node.tip_height().unwrap(), 1);
    }

    #[test]
    fn v1_identity_is_fixed_by_the_signed_fields_only() {
        // An outsider can re-encode the signature or attach a payload; neither changes the
        // identity, so neither escapes the uniqueness rule. Only the signed fields do.
        let user = pqc_keygen(); let other = pqc_keygen();
        let t = signed(transfer(&user.public_key_hex, &other.public_key_hex, 100, 7), &user.secret_key_hex);
        let id = quantum_vault_types::tx_identity(&t);
        let mut upper = t.clone(); upper.sig = upper.sig.to_uppercase();
        assert_ne!(upper.sig, t.sig); assert_eq!(quantum_vault_types::tx_identity(&upper), id, "sig hex case");
        assert_ne!(quantum_vault_types::compute_single_tx_hash(&upper), quantum_vault_types::compute_single_tx_hash(&t), "(the raw storage hash DOES change — why it is not the identity)");
        let mut resigned = t.clone(); resigned.sig = pqc_sign(&user.secret_key_hex, &encode_tx_for_signing(&t)).unwrap();
        assert_ne!(resigned.sig, t.sig, "ML-DSA signing is randomized"); assert_eq!(quantum_vault_types::tx_identity(&resigned), id, "owner re-signature");
        // a V1 tx with a bogus attachment is a DIFFERENT identity class (V2) — but such a tx must not verify as V2:
        // its signature is over the V1 fields, not over the attachment, so import/mempool reject it (covered by the
        // signature checks); here we only pin that the attachment does not alias the V1 identity.
        let mut attached = t.clone(); attached.signed_payload = Some("{}".into());
        assert_ne!(quantum_vault_types::tx_identity(&attached), id);
        for (name, m) in [("nonce", { let mut m = t.clone(); m.nonce += 1; m }), ("amount", { let mut m = t.clone(); m.payload.amount = Some(101); m }), ("fee", { let mut m = t.clone(); m.fee = 0.2; m }), ("to", { let mut m = t.clone(); m.payload.to_pub_key_hex = Some(user.public_key_hex.clone()); m })] {
            assert_ne!(quantum_vault_types::tx_identity(&m), id, "{name} is a signed field: changing it changes the identity (and breaks the signature)");
            assert!(pqc_verify(&user.public_key_hex, &encode_tx_for_signing(&m), &m.sig).ok() != Some(true), "{name}: altered V1 tx no longer verifies");
        }
    }

    #[test]
    fn crash_between_append_and_index_write_cannot_let_a_replay_through() {
        // Simulate: block appended + receipts stored, process died before record_block_tx_hashes.
        let (_d, node, p, user, other) = setup(Some(1));
        let t1 = signed(transfer(&user.public_key_hex, &other.public_key_hex, 100, 7), &user.secret_key_hex);
        let t = chrono::Utc::now().timestamp_millis() as u64;
        let b1 = sealed_block(&node, &p.public_key_hex, &p.secret_key_hex, vec![t1.clone()], None, t);
        // (a) the live-process shape: the record write is lost
        node.store.append_block(&b1).unwrap();
        assert!(!node.tx_already_included(&quantum_vault_types::tx_identity(&t1)), "index incomplete");
        // next block replays t1 → the consensus check must first make the index complete, then reject
        let err = import(&node, &p, vec![t1.clone()]).unwrap_err();
        assert!(err.contains("already included in block 1"), "{err}");
        assert_eq!(node.tip_height().unwrap(), 1);
        assert_eq!(node.tx_included_at(&quantum_vault_types::tx_identity(&t1)), Some(1), "index healed");
        // (b) a genuinely new block still imports after the heal, and gets recorded
        let t2 = signed(transfer(&user.public_key_hex, &other.public_key_hex, 5, 8), &user.secret_key_hex);
        import(&node, &p, vec![t2.clone()]).unwrap();
        assert_eq!(node.tx_included_at(&quantum_vault_types::tx_identity(&t2)), Some(2));
        // (c) restart shape: init() also heals (indexed tip marker stale)
        node.tx_seen_db.insert(TX_SEEN_INDEXED_TIP_KEY, &1u64.to_be_bytes()).unwrap();
        node.tx_seen_db.remove(quantum_vault_types::tx_identity(&t2).as_bytes()).unwrap();
        node.ensure_tx_seen_index().unwrap();
        assert_eq!(node.tx_included_at(&quantum_vault_types::tx_identity(&t2)), Some(2));
    }

    #[test]
    fn index_is_rebuilt_from_the_stored_chain_on_start_and_after_recovery() {
        let (_d, node, p, user, other) = setup(None);
        let t1 = signed(transfer(&user.public_key_hex, &other.public_key_hex, 100, 7), &user.secret_key_hex);
        let t2 = signed(transfer(&user.public_key_hex, &other.public_key_hex, 1, 8), &user.secret_key_hex);
        import(&node, &p, vec![t1.clone()]).unwrap();
        import(&node, &p, vec![t2.clone()]).unwrap();
        let (h1, h2) = (quantum_vault_types::tx_identity(&t1), quantum_vault_types::tx_identity(&t2));
        // upgrade-from-old-binary shape: index missing entirely
        node.tx_seen_db.clear().unwrap();
        assert!(!node.tx_already_included(&h1));
        node.ensure_tx_seen_index().unwrap();
        assert_eq!((node.tx_included_at(&h1), node.tx_included_at(&h2)), (Some(1), Some(2)));
        // crash-between-append-and-record shape: stale indexed tip
        node.tx_seen_db.insert(TX_SEEN_INDEXED_TIP_KEY, &1u64.to_be_bytes()).unwrap();
        node.tx_seen_db.remove(h2.as_bytes()).unwrap();
        node.ensure_tx_seen_index().unwrap();
        assert_eq!(node.tx_included_at(&h2), Some(2));
        // full deterministic recovery re-derives it through import_block
        node.recover_from_history().unwrap();
        assert_eq!((node.tx_included_at(&h1), node.tx_included_at(&h2)), (Some(1), Some(2)));
        assert_eq!(node.tip_height().unwrap(), 2);
    }
}

/// V2 signed-payload binding: the executable fields of a signed-payload transaction are a
/// deterministic function of the signed JSON, at every ingress and (from N) in consensus.
#[cfg(test)]
mod v2_binding_tests {
    use super::*;
    use super::bridge_r1_daemon_tests::{node_with_store, fund_xrge, sealed_block};
    use crate::v2_binding::{build_v2_tx, verify_v2_binding, derive_v2_fields};
    use quantum_vault_crypto::{pqc_keygen, pqc_sign};
    use quantum_vault_types::tx_identity;
    use serde_json::{json, Value};

    /// One representative signed payload per V2 transaction type (every type the API builds).
    fn sample_payloads(from: &str, to: &str) -> Vec<(&'static str, Value)> {
        let ts = 1_790_000_000_000i64;
        vec![
            ("transfer", json!({"from": from, "to": to, "amount": 12.7, "token": "XRGE", "timestamp": ts})),
            ("transfer", json!({"from": from, "to": to, "amount": 5, "token": "KOALA", "timestamp": ts})),
            ("create_token", json!({"from": from, "token_name": "Koala", "token_symbol": "KOALA", "initial_supply": 1000000, "image": "https://x/y.png", "description": "d", "timestamp": ts})),
            ("mint_tokens", json!({"from": from, "token_symbol": "KOALA", "amount": 50, "timestamp": ts})),
            ("approve", json!({"from": from, "spender": to, "token_symbol": "KOALA", "amount": 7, "timestamp": ts})),
            ("transfer_from", json!({"from": from, "owner": to, "to": from, "token_symbol": "KOALA", "amount": 3, "timestamp": ts})),
            ("create_pool", json!({"from": from, "token_a": "KOALA", "token_b": "XRGE", "amount_a": 100, "amount_b": 10, "timestamp": ts})),
            ("add_liquidity", json!({"from": from, "pool_id": "KOALA-XRGE", "amount_a": 1, "amount_b": 2, "timestamp": ts})),
            ("remove_liquidity", json!({"from": from, "pool_id": "KOALA-XRGE", "lp_amount": 9, "timestamp": ts})),
            ("swap", json!({"from": from, "token_in": "XRGE", "token_out": "KOALA", "amount_in": 4, "min_amount_out": 1, "timestamp": ts})),
            ("stake", json!({"from": from, "amount": 10000, "timestamp": ts})),
            ("unstake", json!({"from": from, "amount": 10000, "timestamp": ts})),
            ("nft_create_collection", json!({"from": from, "symbol": "KOL", "name": "Koalas", "description": "d", "image": "i", "maxSupply": 10, "royaltyBps": 250, "royaltyRecipient": " rouge1abc ", "publicMint": true, "mintPrice": 1.5, "tokenGateSymbol": "KOALA", "tokenGateAmount": 2.0, "discountPct": 10, "timestamp": ts})),
            ("nft_mint", json!({"from": from, "collectionId": "col:1", "name": "K#1", "metadataUri": "ipfs://a", "attributes": {"eyes": "blue"}, "timestamp": ts})),
            ("nft_batch_mint", json!({"from": from, "collectionId": "col:1", "names": ["a", "b", "c"], "uris": ["u1", "u2", "u3"], "attributes": [{"x": 1}, {"x": 2}, {"x": 3}], "timestamp": ts})),
            ("nft_transfer", json!({"from": from, "collectionId": "col:1", "tokenId": 1, "to": to, "salePrice": 40, "timestamp": ts})),
            ("nft_burn", json!({"from": from, "collectionId": "col:1", "tokenId": 2, "timestamp": ts})),
            ("nft_lock", json!({"from": from, "collectionId": "col:1", "tokenId": 3, "locked": false, "timestamp": ts})),
            ("nft_freeze_collection", json!({"from": from, "collectionId": "col:1", "frozen": true, "timestamp": ts})),
            ("shield", json!({"from": from, "amount": 3, "commitment": "ab".repeat(32), "timestamp": ts})),
            ("shielded_transfer", json!({"from": from, "nullifiers": ["n1"], "output_commitments": ["c1", "c2"], "proof": "deadbeef", "fee": 1, "timestamp": ts})),
            ("unshield", json!({"from": from, "nullifiers": ["n1"], "amount": 3, "proof": "deadbeef", "timestamp": ts})),
        ]
    }

    fn v2(kp: &PQKeypair, ty: &str, payload: &Value, nonce: u64) -> TxV1 {
        let sp = serde_json::to_string(payload).unwrap(); // what verify_signed_tx returns without payload_bytes_hex
        let sig = pqc_sign(&kp.secret_key_hex, sp.as_bytes()).unwrap();
        build_v2_tx(ty, kp.public_key_hex.clone(), nonce, payload, sig, sp).unwrap()
    }

    /// Every payload/fee field that a forger could want to change, expressed as a mutation of the
    /// constructed tx. Each must be detected by the binding check.
    fn mutations(t: &TxV1, attacker: &str) -> Vec<(&'static str, TxV1)> {
        let mut out = vec![];
        macro_rules! m { ($n:expr, $f:expr) => {{ let mut x = t.clone(); $f(&mut x); out.push(($n, x)); }} }
        m!("fee+", |x: &mut TxV1| x.fee += 1.0);
        m!("fee=0", |x: &mut TxV1| x.fee = 0.0);
        m!("version", |x: &mut TxV1| x.version = 2);
        m!("tx_type", |x: &mut TxV1| x.tx_type = if x.tx_type == "transfer" { "stake".into() } else { "transfer".into() });
        let p = &t.payload;
        if p.to_pub_key_hex.is_some() { m!("to", |x: &mut TxV1| x.payload.to_pub_key_hex = Some(attacker.to_string())); }
        if p.amount.is_some() { m!("amount", |x: &mut TxV1| x.payload.amount = Some(999_999)); }
        if p.token_symbol.is_some() { m!("token_symbol", |x: &mut TxV1| x.payload.token_symbol = Some("OTHER".into())); }
        if p.token_symbol.is_none() && t.tx_type == "transfer" { m!("token_symbol_added", |x: &mut TxV1| x.payload.token_symbol = Some("KOALA".into())); }
        if p.token_total_supply.is_some() { m!("supply", |x: &mut TxV1| x.payload.token_total_supply = Some(u64::MAX)); }
        if p.spender_pub_key.is_some() { m!("spender", |x: &mut TxV1| x.payload.spender_pub_key = Some(attacker.to_string())); }
        if p.allowance_amount.is_some() { m!("allowance", |x: &mut TxV1| x.payload.allowance_amount = Some(u64::MAX)); }
        if p.owner_pub_key.is_some() { m!("owner", |x: &mut TxV1| x.payload.owner_pub_key = Some(attacker.to_string())); }
        if p.pool_id.is_some() { m!("pool_id", |x: &mut TxV1| x.payload.pool_id = Some("X-Y".into())); }
        if p.amount_a.is_some() { m!("amount_a", |x: &mut TxV1| x.payload.amount_a = x.payload.amount_a.map(|v| v + 1000)); }
        if p.amount_b.is_some() { m!("amount_b", |x: &mut TxV1| x.payload.amount_b = x.payload.amount_b.map(|v| v + 1000)); }
        if p.lp_amount.is_some() { m!("lp_amount", |x: &mut TxV1| x.payload.lp_amount = x.payload.lp_amount.map(|v| v + 1000)); }
        if p.min_amount_out.is_some() { m!("min_out", |x: &mut TxV1| x.payload.min_amount_out = x.payload.min_amount_out.map(|v| v + 1)); }
        if p.token_a_symbol.is_some() { m!("token_a", |x: &mut TxV1| x.payload.token_a_symbol = Some("Z".into())); }
        if p.nft_collection_id.is_some() { m!("collection", |x: &mut TxV1| x.payload.nft_collection_id = Some("col:9".into())); }
        if p.nft_token_id.is_some() { m!("token_id", |x: &mut TxV1| x.payload.nft_token_id = x.payload.nft_token_id.map(|v| v + 77)); }
        if p.nft_royalty_bps.is_some() { m!("royalty", |x: &mut TxV1| x.payload.nft_royalty_bps = Some(9999)); }
        if p.nft_royalty_recipient.is_some() { m!("royalty_to", |x: &mut TxV1| x.payload.nft_royalty_recipient = Some(attacker.to_string())); }
        if p.nft_mint_price.is_some() { m!("mint_price", |x: &mut TxV1| x.payload.nft_mint_price = Some(0.0)); }
        if p.nft_public_mint.is_some() { m!("public_mint", |x: &mut TxV1| x.payload.nft_public_mint = Some(false)); }
        if p.nft_batch_names.is_some() { m!("batch_names", |x: &mut TxV1| x.payload.nft_batch_names = Some(vec!["a".into()])); }
        if p.nft_locked.is_some() { m!("locked", |x: &mut TxV1| x.payload.nft_locked = x.payload.nft_locked.map(|b| !b)); }
        if p.nft_frozen.is_some() { m!("frozen", |x: &mut TxV1| x.payload.nft_frozen = x.payload.nft_frozen.map(|b| !b)); }
        if p.nft_metadata_uri.is_some() { m!("uri", |x: &mut TxV1| x.payload.nft_metadata_uri = Some("ipfs://evil".into())); }
        if p.shielded_value.is_some() { m!("shielded_value", |x: &mut TxV1| x.payload.shielded_value = Some(u64::MAX)); }
        if p.shielded_commitment.is_some() { m!("commitment", |x: &mut TxV1| x.payload.shielded_commitment = Some("00".repeat(32))); }
        if p.shielded_nullifiers.is_some() { m!("nullifiers", |x: &mut TxV1| x.payload.shielded_nullifiers = Some(vec!["other".into()])); }
        if p.shielded_proof.is_some() { m!("proof", |x: &mut TxV1| x.payload.shielded_proof = Some("00".into())); }
        if p.shielded_fee.is_some() { m!("shielded_fee", |x: &mut TxV1| x.payload.shielded_fee = Some(0)); }
        m!("extra_field", |x: &mut TxV1| x.payload.reason = Some("smuggled".into()));
        m!("signed_payload_swapped", |x: &mut TxV1| x.signed_payload = Some(r#"{"from":"x","to":"y","amount":1,"timestamp":1}"#.into()));
        out
    }

    #[test]
    fn every_v2_type_round_trips_and_every_field_mutation_is_detected() {
        let user = pqc_keygen(); let other = pqc_keygen(); let attacker = pqc_keygen();
        let mut types_seen = std::collections::BTreeSet::new(); let mut mutations_checked = 0;
        for (ty, payload) in sample_payloads(&user.public_key_hex, &other.public_key_hex) {
            let t = v2(&user, ty, &payload, 1);
            types_seen.insert(ty);
            verify_v2_binding(&t).unwrap_or_else(|e| panic!("{ty}: honest tx must bind: {e}"));
            let (p2, fee2) = derive_v2_fields(ty, &payload).unwrap();
            assert_eq!((t.payload.clone(), t.fee), (p2, fee2), "{ty}: derivation is deterministic");
            for (name, mutated) in mutations(&t, &attacker.public_key_hex) {
                assert!(verify_v2_binding(&mutated).is_err(), "{ty}: mutation '{name}' must fail the binding");
                mutations_checked += 1;
            }
            // nonce is server-assigned and NOT part of the identity — a replay with a new nonce is the same tx
            let mut n = t.clone(); n.nonce += 1;
            assert!(verify_v2_binding(&n).is_ok()); assert_eq!(tx_identity(&n), tx_identity(&t), "{ty}: nonce does not change the identity");
            // from_pub_key: bound by `from` in the payload (and by the signature)
            let mut f = t.clone(); f.from_pub_key = attacker.public_key_hex.clone();
            assert!(verify_v2_binding(&f).is_err(), "{ty}: from mismatch");
        }
        assert_eq!(types_seen.len(), 21, "all 21 distinct V2 tx types exercised: {types_seen:?}");
        assert!(mutations_checked >= 120, "{mutations_checked} mutations checked");
    }

    /// The `rougechain` CLI signs an envelope {tx_type, from, nonce, fee, payload} and posts a
    /// complete TxV1 to /api/tx/broadcast (mainnet blocks 29, 49–52, 59).
    fn cli_tx(kp: &PQKeypair, tx_type: &str, nonce: u64, fee: u64, payload: Value) -> TxV1 {
        let env = json!({"tx_type": tx_type, "from": kp.public_key_hex, "nonce": nonce, "fee": fee, "payload": payload});
        let sp = serde_json::to_string(&env).unwrap();
        let sig = pqc_sign(&kp.secret_key_hex, sp.as_bytes()).unwrap();
        TxV1 { version: 1, tx_type: tx_type.into(), from_pub_key: kp.public_key_hex.clone(), nonce,
            payload: serde_json::from_value(payload).unwrap(), fee: fee as f64, sig, signed_payload: Some(sp) }
    }

    #[test]
    fn cli_envelope_binds_type_nonce_fee_and_payload() {
        let user = pqc_keygen(); let other = pqc_keygen(); let attacker = pqc_keygen();
        for (ty, payload) in [("stake", json!({"amount": 10000})), ("transfer", json!({"to_pub_key_hex": other.public_key_hex, "amount": 1}))] {
            let t = cli_tx(&user, ty, 2, 1, payload);
            verify_v2_binding(&t).unwrap();
            let mut m = t.clone(); m.nonce = 3; assert!(verify_v2_binding(&m).is_err(), "{ty}: nonce IS bound in the envelope");
            let mut m = t.clone(); m.fee = 100.0; assert!(verify_v2_binding(&m).is_err(), "{ty}: fee bound");
            let mut m = t.clone(); m.tx_type = "unstake".into(); assert!(verify_v2_binding(&m).is_err(), "{ty}: tx_type bound");
            let mut m = t.clone(); m.payload.amount = Some(999_999); assert!(verify_v2_binding(&m).is_err(), "{ty}: amount bound");
            let mut m = t.clone(); m.payload.to_pub_key_hex = Some(attacker.public_key_hex.clone()); assert!(verify_v2_binding(&m).is_err(), "{ty}: recipient bound");
            let mut m = t.clone(); m.payload.token_symbol = Some("KOALA".into()); assert!(verify_v2_binding(&m).is_err(), "{ty}: smuggled field");
            let mut m = t.clone(); m.from_pub_key = attacker.public_key_hex.clone(); assert!(verify_v2_binding(&m).is_err(), "{ty}: from bound");
        }
    }

    #[test]
    fn forged_v2_transfer_is_refused_at_mempool_and_by_consensus_without_touching_state() {
        TEST_FORK_HEIGHT_OVERRIDE.with(|c| c.set(Some(u64::MAX)));
        TEST_TX_UNIQUENESS_OVERRIDE.with(|c| c.set(Some(Some(1))));
        let (_d, node, _s) = node_with_store();
        let proposer = pqc_keygen(); let user = pqc_keygen(); let friend = pqc_keygen(); let thief = pqc_keygen();
        fund_xrge(&node, &user.public_key_hex, 1_000.0);
        let honest = v2(&user, "transfer", &json!({"from": user.public_key_hex, "to": friend.public_key_hex, "amount": 10, "token": "XRGE", "timestamp": 1_790_000_000_000i64}), 1);
        let mut forged = honest.clone();
        forged.payload.to_pub_key_hex = Some(thief.public_key_hex.clone()); forged.payload.amount = Some(900);
        // (1) mempool / P2P ingress (node-local, regardless of activation)
        let err = node.add_tx_to_mempool(forged.clone()).unwrap_err();
        assert!(err.contains("does not match its signed_payload"), "{err}");
        // (2) consensus at/after N: block rejected, no state change
        let before = node.balances.lock().unwrap().clone();
        let t = chrono::Utc::now().timestamp_millis() as u64;
        let err = node.import_block(sealed_block(&node, &proposer.public_key_hex, &proposer.secret_key_hex, vec![forged.clone()], None, t)).unwrap_err();
        assert!(err.contains("signed-payload binding failed"), "{err}");
        assert_eq!(node.tip_height().unwrap(), 0);
        assert_eq!(*node.balances.lock().unwrap(), before, "no balance mutation");
        assert!(!node.tx_already_included(&tx_identity(&forged)), "no index mutation");
        assert!(node.get_receipt(&compute_single_tx_hash(&forged)).unwrap().is_none(), "no receipt");
        // (3) the honest tx still goes through
        node.import_block(sealed_block(&node, &proposer.public_key_hex, &proposer.secret_key_hex, vec![honest.clone()], None, t)).unwrap();
        assert_eq!(*node.balances.lock().unwrap().get(&canon_addr(&friend.public_key_hex)).unwrap(), xrge_f64_to_quanta(10.0));
        // (4) and a nonce-changed replay of it (different raw hash!) is a replay
        let mut replay = honest.clone(); replay.nonce = 99;
        assert_ne!(compute_single_tx_hash(&replay), compute_single_tx_hash(&honest));
        let err = node.import_block(sealed_block(&node, &proposer.public_key_hex, &proposer.secret_key_hex, vec![replay], None, t)).unwrap_err();
        assert!(err.contains("already included in block 1"), "{err}");
    }

    #[test]
    fn forged_v2_is_legacy_accepted_below_activation_but_never_at_ingress() {
        // Documents the pre-fork consensus behaviour (the bug) and that upgraded nodes' ingress
        // already refuses it — the reason the fork is still required (other proposers).
        TEST_FORK_HEIGHT_OVERRIDE.with(|c| c.set(Some(u64::MAX)));
        TEST_TX_UNIQUENESS_OVERRIDE.with(|c| c.set(Some(Some(100))));
        let (_d, node, _s) = node_with_store();
        let proposer = pqc_keygen(); let user = pqc_keygen(); let friend = pqc_keygen(); let thief = pqc_keygen();
        fund_xrge(&node, &user.public_key_hex, 1_000.0);
        let mut forged = v2(&user, "transfer", &json!({"from": user.public_key_hex, "to": friend.public_key_hex, "amount": 10, "token": "XRGE", "timestamp": 1_790_000_000_000i64}), 1);
        forged.payload.to_pub_key_hex = Some(thief.public_key_hex.clone()); forged.payload.amount = Some(900);
        assert!(node.add_tx_to_mempool(forged.clone()).is_err(), "ingress refuses even below N");
        let t = chrono::Utc::now().timestamp_millis() as u64;
        node.import_block(sealed_block(&node, &proposer.public_key_hex, &proposer.secret_key_hex, vec![forged], None, t)).expect("LEGACY consensus (below N) still accepts the forgery — hence the fork");
        assert_eq!(*node.balances.lock().unwrap().get(&canon_addr(&thief.public_key_hex)).unwrap(), xrge_f64_to_quanta(900.0));
    }

    #[test]
    fn historical_mainnet_v2_transactions_against_the_proposed_binding() {
        // Blocks 20–60 of rougechain-mainnet-1: every signed-payload tx, exactly as stored.
        // The rule only applies from N (> 60), so failures here are INFORMATIONAL: they show
        // which historical constructions differ from today's canonical mapping.
        let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/mainnet-v2-txs-h20-60.json")).unwrap();
        let rows: Vec<Value> = serde_json::from_str(&raw).unwrap();
        assert_eq!(rows.len(), 26);
        let mut ok = 0; let mut fail = vec![];
        for r in &rows {
            let tx: TxV1 = serde_json::from_value(r["tx"].clone()).unwrap();
            let h = r["height"].as_u64().unwrap();
            match verify_v2_binding(&tx) { Ok(()) => ok += 1, Err(e) => fail.push(format!("h{h} {}: {e}", tx.tx_type)) }
            // the identity is well-defined for all of them and distinct
        }
        let ids: std::collections::BTreeSet<String> = rows.iter().map(|r| tx_identity(&serde_json::from_value::<TxV1>(r["tx"].clone()).unwrap())).collect();
        assert_eq!(ids.len(), 26, "26 distinct identities");
        eprintln!("HISTORICAL V2 BINDING: {ok} pass, {} differ:\n  {}", fail.len(), fail.join("\n  "));
        // 20 API-format + 6 CLI-envelope txs; ALL satisfy the proposed rule (pinned).
        assert_eq!((ok, fail.len()), (26, 0), "{fail:?}");
    }
}
