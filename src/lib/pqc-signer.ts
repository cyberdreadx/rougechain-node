/**
 * Client-side transaction signing using ML-DSA-65 (CRYSTALS-Dilithium)
 * 
 * This module provides secure client-side transaction signing, ensuring
 * private keys never leave the browser.
 */

import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";

/**
 * The official burn address - tokens sent here are permanently destroyed
 * This address has no private key and cannot be spent from
 */
export const BURN_ADDRESS = "XRGE_BURN_0x000000000000000000000000000000000000000000000000000000000000DEAD";

// Utility functions
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Transaction payload structure for signing
 */
export interface TransactionPayload {
  type: "transfer" | "create_token" | "swap" | "create_pool" | "add_liquidity" | "remove_liquidity" | "stake" | "unstake" | "faucet"
  | "nft_create_collection" | "nft_mint" | "nft_batch_mint" | "nft_transfer" | "nft_burn" | "nft_lock" | "nft_freeze_collection"
  | "bridge_withdraw";
  from: string;
  to?: string;
  amount?: number;
  fee?: number;
  token?: string;
  tokenSymbol?: string;
  evmAddress?: string;
  timestamp: number;
  nonce: string;
  // Token creation
  token_name?: string;
  token_symbol?: string;
  initial_supply?: number;
  // Swap
  token_in?: string;
  token_out?: string;
  amount_in?: number;
  min_amount_out?: number;
  // Pool operations
  pool_id?: string;
  token_a?: string;
  token_b?: string;
  amount_a?: number;
  amount_b?: number;
  lp_amount?: number;
  // NFT fields
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
}

/**
 * Signed transaction structure
 */
export interface SignedTransaction {
  payload: TransactionPayload;
  signature: string;
  public_key: string;
}

/**
 * Generate a random nonce for transaction uniqueness
 */
export function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return bytesToHex(bytes);
}

/**
 * Serialize a transaction payload to bytes for signing
 */
export function serializePayload(payload: TransactionPayload): Uint8Array {
  const json = JSON.stringify(payload, Object.keys(payload).sort());
  return new TextEncoder().encode(json);
}

/**
 * Sign a transaction payload with the private key
 * 
 * @param payload - The transaction payload to sign
 * @param privateKey - The ML-DSA-65 private key (hex string)
 * @param publicKey - The ML-DSA-65 public key (hex string)
 * @returns The signed transaction
 */
export function signTransaction(
  payload: TransactionPayload,
  privateKey: string,
  publicKey: string
): SignedTransaction {
  const payloadBytes = serializePayload(payload);
  const privateKeyBytes = hexToBytes(privateKey);

  const signature = ml_dsa65.sign(payloadBytes, privateKeyBytes);

  return {
    payload,
    signature: bytesToHex(signature),
    public_key: publicKey,
  };
}

/**
 * Verify a signed transaction
 * 
 * @param signedTx - The signed transaction to verify
 * @returns true if the signature is valid
 */
export function verifyTransaction(signedTx: SignedTransaction): boolean {
  try {
    const payloadBytes = serializePayload(signedTx.payload);
    const signatureBytes = hexToBytes(signedTx.signature);
    const publicKeyBytes = hexToBytes(signedTx.public_key);

    return ml_dsa65.verify(signatureBytes, payloadBytes, publicKeyBytes);
  } catch {
    return false;
  }
}

// ============================================
// Helper functions to create signed transactions
// ============================================

/**
 * Create a signed transfer transaction
 */
export function createSignedTransfer(
  fromPublicKey: string,
  fromPrivateKey: string,
  toPublicKey: string,
  amount: number,
  fee: number = 1,
  token: string = "XRGE"
): SignedTransaction {
  const payload: TransactionPayload = {
    type: "transfer",
    from: fromPublicKey,
    to: toPublicKey,
    amount,
    fee,
    token,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };

  return signTransaction(payload, fromPrivateKey, fromPublicKey);
}

/**
 * Create a signed token creation transaction
 */
export function createSignedTokenCreation(
  creatorPublicKey: string,
  creatorPrivateKey: string,
  tokenName: string,
  tokenSymbol: string,
  initialSupply: number,
  fee: number = 10
): SignedTransaction {
  const payload: TransactionPayload = {
    type: "create_token",
    from: creatorPublicKey,
    token_name: tokenName,
    token_symbol: tokenSymbol,
    initial_supply: initialSupply,
    fee,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };

  return signTransaction(payload, creatorPrivateKey, creatorPublicKey);
}

/**
 * Create a signed swap transaction
 */
export function createSignedSwap(
  fromPublicKey: string,
  fromPrivateKey: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: number,
  minAmountOut: number
): SignedTransaction {
  const payload: TransactionPayload = {
    type: "swap",
    from: fromPublicKey,
    token_in: tokenIn,
    token_out: tokenOut,
    amount_in: amountIn,
    min_amount_out: minAmountOut,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };

  return signTransaction(payload, fromPrivateKey, fromPublicKey);
}

/**
 * Create a signed pool creation transaction
 */
export function createSignedPoolCreation(
  creatorPublicKey: string,
  creatorPrivateKey: string,
  tokenA: string,
  tokenB: string,
  amountA: number,
  amountB: number
): SignedTransaction {
  const payload: TransactionPayload = {
    type: "create_pool",
    from: creatorPublicKey,
    token_a: tokenA,
    token_b: tokenB,
    amount_a: amountA,
    amount_b: amountB,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };

  return signTransaction(payload, creatorPrivateKey, creatorPublicKey);
}

/**
 * Create a signed add liquidity transaction
 */
export function createSignedAddLiquidity(
  fromPublicKey: string,
  fromPrivateKey: string,
  poolId: string,
  amountA: number,
  amountB: number
): SignedTransaction {
  const payload: TransactionPayload = {
    type: "add_liquidity",
    from: fromPublicKey,
    pool_id: poolId,
    amount_a: amountA,
    amount_b: amountB,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };

  return signTransaction(payload, fromPrivateKey, fromPublicKey);
}

/**
 * Create a signed remove liquidity transaction
 */
export function createSignedRemoveLiquidity(
  fromPublicKey: string,
  fromPrivateKey: string,
  poolId: string,
  lpAmount: number
): SignedTransaction {
  const payload: TransactionPayload = {
    type: "remove_liquidity",
    from: fromPublicKey,
    pool_id: poolId,
    lp_amount: lpAmount,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };

  return signTransaction(payload, fromPrivateKey, fromPublicKey);
}

/**
 * Create a signed stake transaction
 */
export function createSignedStake(
  fromPublicKey: string,
  fromPrivateKey: string,
  amount: number,
  fee: number = 1
): SignedTransaction {
  const payload: TransactionPayload = {
    type: "stake",
    from: fromPublicKey,
    amount,
    fee,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };

  return signTransaction(payload, fromPrivateKey, fromPublicKey);
}

/**
 * Create a signed unstake transaction
 */
export function createSignedUnstake(
  fromPublicKey: string,
  fromPrivateKey: string,
  amount: number,
  fee: number = 1
): SignedTransaction {
  const payload: TransactionPayload = {
    type: "unstake",
    from: fromPublicKey,
    amount,
    fee,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };

  return signTransaction(payload, fromPrivateKey, fromPublicKey);
}

/**
 * Create a signed faucet request
 */
export function createSignedFaucetRequest(
  publicKey: string,
  privateKey: string
): SignedTransaction {
  const payload: TransactionPayload = {
    type: "faucet",
    from: publicKey,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };

  return signTransaction(payload, privateKey, publicKey);
}

/**
 * Create a signed burn transaction
 * Sends tokens to the official burn address where they are permanently destroyed
 */
export function createSignedBurn(
  fromPublicKey: string,
  fromPrivateKey: string,
  amount: number,
  fee: number = 1,
  token: string = "XRGE"
): SignedTransaction {
  const payload: TransactionPayload = {
    type: "transfer",
    from: fromPublicKey,
    to: BURN_ADDRESS,
    amount,
    fee,
    token,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };

  return signTransaction(payload, fromPrivateKey, fromPublicKey);
}

// ============================================
// NFT signing helpers
// ============================================

export function createSignedNftCreateCollection(
  publicKey: string,
  privateKey: string,
  symbol: string,
  name: string,
  opts: { maxSupply?: number; royaltyBps?: number; image?: string; description?: string } = {}
): SignedTransaction {
  const payload: TransactionPayload = {
    type: "nft_create_collection",
    from: publicKey,
    symbol,
    name,
    fee: 50,
    maxSupply: opts.maxSupply,
    royaltyBps: opts.royaltyBps,
    image: opts.image,
    description: opts.description,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };
  return signTransaction(payload, privateKey, publicKey);
}

export function createSignedNftMint(
  publicKey: string,
  privateKey: string,
  collectionId: string,
  name: string,
  opts: { metadataUri?: string; attributes?: unknown } = {}
): SignedTransaction {
  const payload: TransactionPayload = {
    type: "nft_mint",
    from: publicKey,
    collectionId,
    name,
    fee: 5,
    metadataUri: opts.metadataUri,
    attributes: opts.attributes,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };
  return signTransaction(payload, privateKey, publicKey);
}

export function createSignedNftBatchMint(
  publicKey: string,
  privateKey: string,
  collectionId: string,
  names: string[],
  opts: { uris?: string[]; batchAttributes?: unknown[] } = {}
): SignedTransaction {
  const payload: TransactionPayload = {
    type: "nft_batch_mint",
    from: publicKey,
    collectionId,
    names,
    fee: 5 * names.length,
    uris: opts.uris,
    batchAttributes: opts.batchAttributes,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };
  return signTransaction(payload, privateKey, publicKey);
}

export function createSignedNftTransfer(
  publicKey: string,
  privateKey: string,
  collectionId: string,
  tokenId: number,
  toPublicKey: string,
  salePrice?: number
): SignedTransaction {
  const payload: TransactionPayload = {
    type: "nft_transfer",
    from: publicKey,
    collectionId,
    tokenId,
    to: toPublicKey,
    fee: 1,
    salePrice,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };
  return signTransaction(payload, privateKey, publicKey);
}

export function createSignedNftBurn(
  publicKey: string,
  privateKey: string,
  collectionId: string,
  tokenId: number
): SignedTransaction {
  const payload: TransactionPayload = {
    type: "nft_burn",
    from: publicKey,
    collectionId,
    tokenId,
    fee: 0.1,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };
  return signTransaction(payload, privateKey, publicKey);
}

export function createSignedNftLock(
  publicKey: string,
  privateKey: string,
  collectionId: string,
  tokenId: number,
  locked: boolean
): SignedTransaction {
  const payload: TransactionPayload = {
    type: "nft_lock",
    from: publicKey,
    collectionId,
    tokenId,
    locked,
    fee: 0.1,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };
  return signTransaction(payload, privateKey, publicKey);
}

export function createSignedNftFreezeCollection(
  publicKey: string,
  privateKey: string,
  collectionId: string,
  frozen: boolean
): SignedTransaction {
  const payload: TransactionPayload = {
    type: "nft_freeze_collection",
    from: publicKey,
    collectionId,
    frozen,
    fee: 0.1,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };
  return signTransaction(payload, privateKey, publicKey);
}

// ============================================
// Bridge signing helpers
// ============================================

export function createSignedBridgeWithdraw(
  fromPublicKey: string,
  fromPrivateKey: string,
  amountUnits: number,
  evmAddress: string,
  tokenSymbol: string = "qETH",
  fee: number = 0.1
): SignedTransaction {
  const payload: TransactionPayload = {
    type: "bridge_withdraw",
    from: fromPublicKey,
    amount: amountUnits,
    fee,
    tokenSymbol,
    evmAddress: evmAddress.startsWith("0x") ? evmAddress : `0x${evmAddress}`,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };

  return signTransaction(payload, fromPrivateKey, fromPublicKey);
}

/**
 * Check if an address is the burn address
 */
export function isBurnAddress(address: string): boolean {
  return address === BURN_ADDRESS;
}
