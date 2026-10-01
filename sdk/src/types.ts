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
  royaltyRecipient?: string;
  tokenId?: number;
  metadataUri?: string;
  attributes?: unknown;
  locked?: boolean;
  frozen?: boolean;
  salePrice?: number;
  names?: string[];
  uris?: string[];
  /** @deprecated Ignored by the node; batch mints sign per-NFT attributes as `attributes`. */
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
  /**
   * Optional hex of the exact bytes that were signed. When present the node verifies the
   * signature over these bytes (and checks they parse to `payload`) instead of re-serializing.
   */
  payload_bytes_hex?: string;
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

/** One-shot validator health for a key (see RougeChain.getValidatorStatus). */
export interface ValidatorStatus {
  publicKey: string;
  /** Liquid XRGE balance held by the key. */
  balance: number;
  /** XRGE currently staked by this key. */
  staked: number;
  /** Tier derived from stake: none (<10k) · standard (10k) · operator (100k) · genesis (1M). */
  tier: "none" | "standard" | "operator" | "genesis";
  /** Validator-set status: "active" | "jailed" | "inactive" | "not registered". */
  status: string;
  inActiveSet: boolean;
  blocksProposed: number;
  /** True once staked >= the 10,000 XRGE minimum. */
  meetsMinimum: boolean;
}

// ===== Bridge =====

export interface BridgeConfig {
  enabled: boolean;
  custodyAddress?: string;
  chainId: number;
  supportedTokens?: string[];
}

/** Relayer release lifecycle of a bridge withdrawal. */
export type WithdrawalStatus = "pending" | "fulfilled" | "failed" | "refunded";

export interface BridgeWithdrawal {
  txId: string;
  evmAddress: string;
  /** ETH/qETH are micro-units (1e-6); XRGE is whole tokens. */
  amountUnits: number;
  createdAt: number;
  /** RougeChain L1 public key of the withdrawer (refund recipient). */
  ownerPubkey: string;
  /** "XRGE", "qETH", "qUSDC", … — authoritative token discriminator. */
  tokenSymbol: string;
  status: WithdrawalStatus;
  /** Failed relayer release attempts so far. */
  attempts: number;
  lastError?: string;
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
  /** Directory-shared avatar (base64 data URI), when the wallet set one. Snake_case on the wire. */
  avatarUrl?: string;
  avatar_url?: string;
}

/** Messenger conversation list folder. */
export type MessengerFolder = "inbox" | "trash" | "all";

/** Private real-time event, delivered only to an authenticated participant's socket. */
export interface MessengerNewMessageEvent {
  type: "new_message";
  conversation_id: string;
  message_id: string;
  created_at: string;
  /** Sender's signing public key. */
  sender_wallet_id: string;
  /** Participants' signing public keys. */
  participant_ids: string[];
}

export interface MessengerConversation {
  id: string;
  /** Participant ids exactly as the node returns them (signing keys or wallet UUIDs). */
  participant_ids: string[];
  /**
   * Same list as `participant_ids`. The node never sends this field; the SDK fills it in
   * so code written against earlier SDK types keeps working.
   */
  participants: string[];
  created_by?: string;
  name?: string | null;
  is_group?: boolean;
  /** RFC 3339 timestamp. */
  created_at: string;
  /** Canonical wallet id -> time, for each participant who moved the thread to trash. */
  deleted_by?: Record<string, string>;
  last_message_at?: string;
  last_sender_id?: string;
  last_message_preview?: string | null;
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
  /** Wallet or contract address that receives secondary-sale royalties. Defaults to the creator when omitted. */
  royaltyRecipient?: string;
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
  /** Per-NFT attributes, one entry per name. */
  attributes?: unknown[];
  /** @deprecated Alias of `attributes` (SDK ≤ 1.10.0 sent these under a field the node ignored). */
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

/** Contract metadata as returned by `GET /api/contract/:addr` and `GET /api/contracts`. */
export interface ContractMetadata {
  /** 40-hex-char contract address. */
  address: string;
  /** Deployer's signing public key. */
  deployer: string;
  /** sha256 of the WASM bytecode (hex). */
  code_hash: string;
  /** Block height (or time, on legacy deployments) recorded at install. */
  created_at: number;
  wasm_size: number;
  [extra: string]: unknown;
}

/** An event a contract emitted with `host_emit_event` (node wire format). */
export interface ContractEvent {
  contract_addr: string;
  topic: string;
  data: string;
  block_height: number;
  tx_hash: string;
}

/** WebSocket frame pushed to `contract:<addr>` subscribers once the block is accepted. */
export interface ContractEventFrame extends ContractEvent {
  type: "contract_event";
}

/** Result of a read-only query (`POST /api/contract/:addr/query`) or an execute preview. */
export interface ContractCallResult {
  success: boolean;
  returnData?: unknown;
  gasUsed: number;
  events: ContractEvent[];
  error?: string;
}

export type ContractQueryResult = ContractCallResult;

export interface PublishContractOptions {
  /** Signed nonce that seeds the address (≥ 8 chars). Random if omitted. */
  nonce?: string;
}

export interface PublishContractResult {
  success: boolean;
  error?: string;
  txId?: string;
  /** Address reported by the node. */
  address?: string;
  /** Address computed locally from (from, nonce, wasm) — equal to `address` on success. */
  predictedAddress: string;
  /** The nonce that was signed (needed to re-derive the address). */
  nonce: string;
  /** Fee charged in XRGE (10 XRGE flat). */
  fee?: number;
}

/**
 * A payment attached to a contract call (payable calls, from the payable-calls upgrade).
 * `amount` is an INTEGER: quanta for XRGE (1 XRGE = 1_000_000_000 quanta — use
 * `xrgeToQuanta("0.5")`), raw units for tokens. It is signed as a JSON integer, so it must be
 * a positive safe integer (≤ `Number.MAX_SAFE_INTEGER`).
 *
 * The payment moves to the contract only if the call succeeds; a failing or trapping call leaves
 * it with the caller (the gas fee is still charged).
 */
export interface ContractAttach {
  /** `"XRGE"` or a token symbol (sent upper-cased). */
  symbol: string;
  /** Positive integer: quanta for XRGE, raw units for tokens. */
  amount: bigint | number | string;
}

/** An attachment as it is signed and sent to the node. */
export interface NormalizedContractAttach {
  symbol: string;
  amount: number;
}

export interface ExecuteContractOptions {
  /**
   * Gas limit (1..10,000,000). The fee is `gasLimit × 0.000001` XRGE, charged up front.
   * If omitted, the SDK queries first (with the attachment) and uses
   * `ceil(gasUsed × 1.5) + 1000`, capped at 10M.
   */
  gasLimit?: number;
  /** Optional durable replay protection: must equal the account's next nonce. */
  accountNonce?: number;
  /** Pay the contract: XRGE (in quanta) or token units, moved only if the call succeeds. */
  attach?: ContractAttach;
}

export interface QueryContractOptions {
  /** Preview a paid call. Requires `caller`. */
  attach?: ContractAttach;
}

export interface ExecuteContractResult {
  success: boolean;
  error?: string;
  txId?: string;
  /** Fee charged in XRGE (`gasLimit × 0.000001`). */
  fee?: number;
  /** The gas limit that was signed. */
  gasLimit?: number;
  /** The attachment that was signed, if any. */
  attach?: NormalizedContractAttach;
  /** The node's dry run of the call (return data, gas used, events). */
  preview?: { returnData?: unknown; gasUsed: number; events: ContractEvent[] };
}

export interface ContractStateValue {
  key: string;
  /** Hex of the stored bytes, or null if unset. */
  value: string | null;
  /** Lossy UTF-8 view of the stored bytes. */
  valueUtf8?: string;
}

export interface ContractEventsQuery {
  limit?: number;
  /** Only events from blocks strictly below this height (paging). */
  before?: number;
  /** Only events emitted by this transaction (tx hash). */
  tx?: string;
}

export type TxReceiptStatus = "Success" | { Failed: string };

export interface TxReceipt {
  tx_hash: string;
  block_height: number;
  block_hash: string;
  index: number;
  tx_type: string;
  from: string;
  status: TxReceiptStatus;
  fee_paid: number;
  logs: { event_type: string; data: unknown }[];
  timestamp: number;
}

/** @deprecated Node-signed `/v2/contract/deploy` is disabled since GAME_READY; use `rc.contracts.publish`. */
export interface DeployContractParams {
  /** Base64-encoded WASM bytecode */
  wasm: string;
  /** Deployer's public key */
  deployer: string;
  /** Nonce for deterministic address */
  nonce?: number;
}

/** @deprecated `/v2/contract/call` is preview-only since GAME_READY; use `rc.contracts.execute` / `query`. */
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
