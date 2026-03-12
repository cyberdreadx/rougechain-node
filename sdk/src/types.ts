// ===== Core =====

export interface WalletKeys {
  publicKey: string;
  privateKey: string;
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
  | "claim_token_metadata";

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

// ===== Mail =====

export interface MailMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  encrypted_subject?: string;
  encrypted_body?: string;
  reply_to_id?: string;
  read: boolean;
  folder: "inbox" | "sent" | "trash";
  created_at: number;
}

export interface SendMailParams {
  from: string;
  to: string;
  subject: string;
  body: string;
  encrypted_subject: string;
  encrypted_body: string;
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
  sender: string;
  encrypted_content: string;
  media_type?: string;
  media_data?: string;
  self_destruct?: boolean;
  destruct_after_seconds?: number;
  read?: boolean;
  created_at: number;
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
