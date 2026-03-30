// ===== Core =====

export interface WalletKeys {
  publicKey: string;
  privateKey: string;
  mnemonic?: string;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  error?: string;
  data?: T;
}

// ===== Transaction Payload =====

export type TransactionType =
  | "transfer"
  | "create_token"
  | "swap"
  | "create_pool"
  | "add_liquidity"
  | "remove_liquidity"
  | "stake"
  | "unstake"
  | "faucet"
  | "nft_create_collection"
  | "nft_mint"
  | "nft_batch_mint"
  | "nft_transfer"
  | "nft_burn"
  | "nft_lock"
  | "nft_freeze_collection"
  | "bridge_withdraw"
  | "update_token_metadata"
  | "claim_token_metadata"
  | "approve"
  | "transfer_from"
  | "shield"
  | "shielded_transfer"
  | "unshield"
  | "contract_deploy"
  | "contract_call";

export interface TransactionPayload {
  type: TransactionType;
  from: string;
  to?: string;
  amount?: number;
  fee?: number;
  token?: string;
  tokenSymbol?: string;
  evmAddress?: string;
  timestamp: number;
  nonce: string;
  token_name?: string;
  token_symbol?: string;
  initial_supply?: number;
  token_in?: string;
  token_out?: string;
  amount_in?: number;
  min_amount_out?: number;
  pool_id?: string;
  token_a?: string;
  token_b?: string;
  amount_a?: number;
  amount_b?: number;
  lp_amount?: number;
  symbol?: string;
  name?: string;
  collectionId?: string;
  description?: string;
  image?: string;
  maxSupply?: number;
  royaltyBps?: number;
  tokenId?: number;
  metadataUri?: string;
  attributes?: unknown;
  locked?: boolean;
  frozen?: boolean;
  salePrice?: number;
  names?: string[];
  uris?: string[];
  batchAttributes?: unknown[];
  website?: string;
  twitter?: string;
  discord?: string;
  // NFT public mint / token-gating fields
  publicMint?: boolean;
  mintPrice?: number;
  tokenGateSymbol?: string;
  tokenGateAmount?: number;
  discountPct?: number;
  // Allowance fields
  spender?: string;
  owner?: string;
}

export interface SignedTransaction {
  payload: TransactionPayload;
  signature: string;
  public_key: string;
}

// ===== Blockchain Data =====

export interface BlockHeader {
  version: number;
  chain_id: string;
  height: number;
  time: number;
  prev_hash: string;
  tx_hash: string;
  proposer_pub_key: string;
}

export interface Transaction {
  version: number;
  tx_type: string;
  from_pub_key: string;
  target_pub_key?: string | null;
  amount: number;
  fee: number;
  sig: string;
  token_name?: string | null;
  token_symbol?: string | null;
  token_decimals?: number | null;
  token_total_supply?: number | null;
  pool_id?: string | null;
  token_a_symbol?: string | null;
  token_b_symbol?: string | null;
  amount_a?: number | null;
  amount_b?: number | null;
  min_amount_out?: number | null;
  swap_path?: string[] | null;
  lp_amount?: number | null;
  faucet?: boolean;
  signed_payload?: string | null;
}

export interface Block {
  version: number;
  header: BlockHeader;
  txs: Transaction[];
  proposer_sig: string;
  hash: string;
}

// ===== Node Stats =====

export interface NodeStats {
  height: number;
  peers: number;
  network_height: number;
  mining: boolean;
  total_fees: number;
  last_block_fees: number;
  finalized_height: number;
  ws_clients: number;
  /** Current EIP-1559 base fee (XRGE) */
  base_fee: number;
  /** Total fees burned via EIP-1559 mechanism */
  total_fees_burned: number;
}

// ===== Tokens =====

export interface TokenMetadata {
  symbol: string;
  name: string;
  creator: string;
  image?: string;
  description?: string;
  website?: string;
  twitter?: string;
  discord?: string;
  created_at: number;
  updated_at: number;
}

export interface TokenHolder {
  address: string;
  balance: number;
}

// ===== Balance =====

export interface BalanceResponse {
  balance: number;
  token_balances: Record<string, number>;
  lp_balances: Record<string, number>;
}

// ===== Pools / DEX =====

export interface LiquidityPool {
  pool_id: string;
  token_a_symbol: string;
  token_b_symbol: string;
  reserve_a: number;
  reserve_b: number;
  total_lp: number;
  fee_rate: number;
  created_at: number;
}

export interface SwapQuote {
  amount_out: number;
  price_impact: number;
  path: string[];
}

export interface PoolEvent {
  event_type: string;
  pool_id: string;
  actor: string;
  token_a_amount?: number;
  token_b_amount?: number;
  lp_amount?: number;
  timestamp: number;
}

export interface PoolStats {
  pool_id: string;
  volume_24h: number;
  trades_24h: number;
  tvl: number;
}

export interface PriceSnapshot {
  pool_id: string;
  timestamp: number;
  block_height: number;
  reserve_a: number;
  reserve_b: number;
  price_a_in_b: number;
  price_b_in_a: number;
}

// ===== NFTs =====

export interface NftCollection {
  collection_id: string;
  symbol: string;
  name: string;
  creator: string;
  description?: string;
  image?: string;
  max_supply?: number;
  minted: number;
  royalty_bps: number;
  royalty_recipient: string;
  frozen: boolean;
  created_at: number;
  public_mint?: boolean;
  mint_price?: number;
  token_gate_symbol?: string;
  token_gate_amount?: number;
  discount_pct?: number;
}

export interface NftToken {
  collection_id: string;
  token_id: number;
  owner: string;
  creator: string;
  name: string;
  metadata_uri?: string;
  attributes?: unknown;
  locked: boolean;
  minted_at: number;
  transferred_at: number;
}

// ===== Validators =====

export interface Validator {
  public_key: string;
  stake: number;
  status: string;
  jailed_until: number;
  uptime: number;
}

// ===== Bridge =====

export interface BridgeConfig {
  enabled: boolean;
  custodyAddress?: string;
  chainId: number;
  supportedTokens?: string[];
}

export interface BridgeWithdrawal {
  tx_id: string;
  from_pub_key: string;
  evm_address: string;
  amount_units: number;
  status: string;
  created_at: number;
}

export interface XrgeBridgeConfig {
  enabled: boolean;
  vaultAddress?: string;
  tokenAddress?: string;
  chainId: number;
}

// ===== Name Registry =====

export interface NameEntry {
  name: string;
  wallet_id: string;
  registered_at: string;
}

export interface ResolvedName {
  entry?: NameEntry;
  wallet?: {
    id: string;
    display_name: string;
    signing_public_key: string;
    encryption_public_key: string;
  };
}

// ===== Mail =====

export interface MailMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  encrypted_subject?: string;
  encrypted_body?: string;
  attachment_encrypted?: string;
  attachmentEncrypted?: string;
  has_attachment?: boolean;
  hasAttachment?: boolean;
  reply_to_id?: string;
  replyToId?: string;
  signature?: string;
  contentSignature?: string;
  read: boolean;
  folder: "inbox" | "sent" | "trash";
  created_at: number;
  createdAt?: string;
  fromWalletId?: string;
  from_wallet_id?: string;
  toWalletIds?: string[];
  to_wallet_ids?: string[];
  subjectEncrypted?: string;
  subject_encrypted?: string;
  bodyEncrypted?: string;
  body_encrypted?: string;
}

export interface SendMailParams {
  from: string;
  to: string;
  subject?: string;
  body?: string;
  encrypted_subject: string;
  encrypted_body: string;
  encrypted_attachment?: string;
  content_signature?: string;
  reply_to_id?: string;
}

// ===== Messenger =====

export interface MessengerWallet {
  id: string;
  displayName: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
  created_at: number;
}

export interface MessengerConversation {
  id: string;
  participants: string[];
  created_at: number;
  last_message_at?: string;
  last_sender_id?: string;
  last_message_preview?: string;
  unread_count?: number;
}

export interface MessengerMessage {
  id: string;
  conversation_id: string;
  sender_wallet_id: string;
  /** @deprecated Use sender_wallet_id */
  sender?: string;
  encrypted_content: string;
  signature: string;
  self_destruct: boolean;
  destruct_after_seconds?: number;
  created_at: number | string;
  is_read: boolean;
  read_at?: string;
  message_type: string; // "text" | "image" | "video"
  spoiler: boolean;
  /** Legacy — some old messages may have these */
  media_type?: string;
  media_data?: string;
}

// ===== Method Params =====

export interface TransferParams {
  to: string;
  amount: number;
  fee?: number;
  token?: string;
}

export interface CreateTokenParams {
  name: string;
  symbol: string;
  totalSupply: number;
  fee?: number;
  /** Token logo — URL or data URI (base64). Stored on-chain in token metadata. */
  image?: string;
  /** Whether this token supports ongoing minting by the creator */
  mintable?: boolean;
  /** Maximum supply cap (only applies if mintable is true) */
  maxSupply?: number;
}

export interface MintTokenParams {
  symbol: string;
  amount: number;
  fee?: number;
}

// ===== EIP-1559 Fee Info =====

export interface FeeInfo {
  success: boolean;
  base_fee: number;
  priority_fee_suggestion: number;
  total_fee_suggestion: number;
  total_fees_burned: number;
  target_txs_per_block: number;
  fee_floor: number;
}

// ===== BFT Finality =====

export interface VoteMessage {
  vote_type: string;
  height: number;
  round: number;
  block_hash: string;
  voter_pub_key: string;
  signature: string;
}

export interface FinalityProof {
  height: number;
  block_hash: string;
  total_stake: number;
  voting_stake: number;
  quorum_threshold: number;
  precommit_votes: VoteMessage[];
  created_at: number;
}

// ===== WebSocket Subscriptions =====

export interface WsSubscribeMessage {
  subscribe?: string[];
  unsubscribe?: string[];
}

export interface SwapParams {
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  minAmountOut: number;
}

export interface CreatePoolParams {
  tokenA: string;
  tokenB: string;
  amountA: number;
  amountB: number;
}

export interface AddLiquidityParams {
  poolId: string;
  amountA: number;
  amountB: number;
}

export interface RemoveLiquidityParams {
  poolId: string;
  lpAmount: number;
}

export interface StakeParams {
  amount: number;
  fee?: number;
}

export interface CreateNftCollectionParams {
  symbol: string;
  name: string;
  maxSupply?: number;
  royaltyBps?: number;
  image?: string;
  description?: string;
  publicMint?: boolean;
  mintPrice?: number;
  tokenGateSymbol?: string;
  tokenGateAmount?: number;
  discountPct?: number;
}

export interface MintNftParams {
  collectionId: string;
  name: string;
  metadataUri?: string;
  attributes?: unknown;
}

export interface BatchMintNftParams {
  collectionId: string;
  names: string[];
  uris?: string[];
  batchAttributes?: unknown[];
}

export interface TransferNftParams {
  collectionId: string;
  tokenId: number;
  to: string;
  salePrice?: number;
}

export interface BurnNftParams {
  collectionId: string;
  tokenId: number;
}

export interface LockNftParams {
  collectionId: string;
  tokenId: number;
  locked: boolean;
}

export interface FreezeCollectionParams {
  collectionId: string;
  frozen: boolean;
}

export interface BridgeWithdrawParams {
  amount: number;
  evmAddress: string;
  fee?: number;
  tokenSymbol?: string;
}

export interface BridgeClaimParams {
  evmTxHash: string;
  evmAddress: string;
  evmSignature: string;
  recipientPubkey: string;
  token?: "ETH" | "USDC";
}

export interface XrgeBridgeClaimParams {
  evmTxHash: string;
  evmAddress: string;
  amount: string;
  recipientPubkey: string;
}

export interface XrgeBridgeWithdrawParams {
  amount: number;
  evmAddress: string;
}

export interface SwapQuoteParams {
  poolId: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
}

export interface TokenMetadataUpdateParams {
  symbol: string;
  image?: string;
  description?: string;
  website?: string;
  twitter?: string;
  discord?: string;
}

export interface ApproveParams {
  spender: string;
  tokenSymbol: string;
  amount: number;
}

export interface TransferFromParams {
  owner: string;
  to: string;
  tokenSymbol: string;
  amount: number;
}

// ===== Shielded Transactions =====

export interface ShieldParams {
  /** Amount to shield (integer XRGE) */
  amount: number;
}

export interface ShieldedTransferParams {
  /** Nullifiers of consumed input notes (hex) */
  nullifiers: string[];
  /** Commitments for output notes (hex) */
  outputCommitments: string[];
  /** STARK proof bytes (hex) */
  proof: string;
  /** Fee paid from the shielded pool */
  shieldedFee?: number;
}

export interface UnshieldParams {
  /** Nullifiers of consumed notes (hex) */
  nullifiers: string[];
  /** Amount to unshield (integer XRGE) */
  amount: number;
  /** STARK proof bytes (hex) */
  proof: string;
}

export interface ShieldedStats {
  success: boolean;
  commitment_count: number;
  nullifier_count: number;
  active_notes: number;
}

// ===== Rollup =====

export interface RollupStatus {
  pending_transfers: number;
  completed_batches: number;
  next_batch_id: number;
  max_batch_size: number;
  batch_timeout_secs: number;
  current_state_root: string;
  accounts_tracked: number;
}

export interface RollupBatchResult {
  batch_id: number;
  transfer_count: number;
  total_fees: number;
  pre_state_root: string;
  post_state_root: string;
  proof_size_bytes: number;
  proof_time_ms: number;
  verified: boolean;
}

export interface RollupSubmitParams {
  sender: string;
  receiver: string;
  amount: number;
  fee?: number;
}

export interface RollupSubmitResult {
  success: boolean;
  queued: boolean;
  batch_completed: boolean;
  batch?: RollupBatchResult;
  pending_transfers?: number;
  max_batch_size?: number;
}

// ===== WASM Smart Contracts =====

export interface ContractMetadata {
  address: string;
  deployer: string;
  codeHash: string;
  createdAt: number;
  wasmSize: number;
}

export interface ContractEvent {
  contractAddr: string;
  topic: string;
  data: string;
  blockHeight: number;
  txHash: string;
}

export interface ContractCallResult {
  success: boolean;
  returnData?: unknown;
  gasUsed: number;
  events: ContractEvent[];
  error?: string;
}

export interface DeployContractParams {
  /** Base64-encoded WASM bytecode */
  wasm: string;
  /** Deployer's public key */
  deployer: string;
  /** Nonce for deterministic address */
  nonce?: number;
}

export interface CallContractParams {
  /** Contract address (hex) */
  contractAddr: string;
  /** Method name to call */
  method: string;
  /** Caller's public key */
  caller?: string;
  /** JSON arguments */
  args?: unknown;
  /** Gas limit (default 10M) */
  gasLimit?: number;
}
