/**
 * Client-side transaction signing using ML-DSA-65 (CRYSTALS-Dilithium)
 * 
 * This module provides secure client-side transaction signing, ensuring
 * private keys never leave the browser.
 */

import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";

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
  type: "transfer" | "create_token" | "swap" | "create_pool" | "add_liquidity" | "remove_liquidity" | "stake" | "unstake" | "faucet";
  from: string; // sender public key
  to?: string; // recipient public key (for transfers)
  amount?: number;
  fee?: number;
  token?: string; // token symbol
  timestamp: number;
  nonce: string; // random nonce for replay protection
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
