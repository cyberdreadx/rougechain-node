export { RougeChain } from "./client.js";
export type { RougeChainOptions } from "./client.js";

export { Wallet } from "./wallet.js";

export {
  signTransaction,
  verifyTransaction,
  serializePayload,
  BURN_ADDRESS,
  isBurnAddress,
} from "./signer.js";

export { generateNonce, hexToBytes, bytesToHex } from "./utils.js";

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
  NftCollection,
  NftToken,
  Validator,
  BridgeConfig,
  BridgeWithdrawal,
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
  SwapQuoteParams,
  TokenMetadataUpdateParams,
} from "./types.js";
