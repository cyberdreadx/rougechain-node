export { RougeChain } from "./client.js";
export type { RougeChainOptions } from "./client.js";

export { Wallet } from "./wallet.js";

export {
  signTransaction,
  verifyTransaction,
  serializePayload,
  createSignedBridgeWithdraw,
  createSignedTokenMetadataUpdate,
  createSignedTokenMetadataClaim,
  createSignedTokenApproval,
  createSignedTokenTransferFrom,
  createSignedShield,
  createSignedShieldedTransfer,
  createSignedUnshield,
  BURN_ADDRESS,
  isBurnAddress,
} from "./signer.js";

export { generateNonce, hexToBytes, bytesToHex } from "./utils.js";

export {
  pubkeyToAddress,
  isRougeAddress,
  formatAddress,
  addressToHash,
} from "./address.js";

export {
  computeCommitment,
  computeNullifier,
  generateRandomness,
  createShieldedNote,
} from "./shielded.js";
export type { ShieldedNote } from "./shielded.js";

export type {
  WalletKeys,
  ApiResponse,
  TransactionType,
  TransactionPayload,
  SignedTransaction,
  BlockHeader,
  Transaction,
  Block,
  NodeStats,
  TokenMetadata,
  TokenHolder,
  BalanceResponse,
  LiquidityPool,
  SwapQuote,
  PoolEvent,
  PoolStats,
  PriceSnapshot,
  NftCollection,
  NftToken,
  Validator,
  BridgeConfig,
  BridgeWithdrawal,
  XrgeBridgeConfig,
  TransferParams,
  CreateTokenParams,
  SwapParams,
  CreatePoolParams,
  AddLiquidityParams,
  RemoveLiquidityParams,
  StakeParams,
  CreateNftCollectionParams,
  MintNftParams,
  BatchMintNftParams,
  TransferNftParams,
  BurnNftParams,
  LockNftParams,
  FreezeCollectionParams,
  BridgeWithdrawParams,
  BridgeClaimParams,
  XrgeBridgeClaimParams,
  XrgeBridgeWithdrawParams,
  SwapQuoteParams,
  TokenMetadataUpdateParams,
  MailMessage,
  SendMailParams,
  MessengerWallet,
  MessengerConversation,
  MessengerMessage,
  ShieldParams,
  ShieldedTransferParams,
  UnshieldParams,
  ShieldedStats,
  RollupStatus,
  RollupBatchResult,
  RollupSubmitParams,
  RollupSubmitResult,
  ApproveParams,
  TransferFromParams,
} from "./types.js";
