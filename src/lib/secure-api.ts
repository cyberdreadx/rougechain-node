/**
 * Secure API client that uses client-side signing
 * 
 * All transactions are signed locally before being sent to the server.
 * Private keys NEVER leave the browser.
 */

import { getNodeApiBaseUrl, getCoreApiHeaders } from "./network";
import {
  SignedTransaction,
  createSignedTransfer,
  createSignedTokenCreation,
  createSignedSwap,
  createSignedPoolCreation,
  createSignedAddLiquidity,
  createSignedRemoveLiquidity,
  createSignedStake,
  createSignedUnstake,
  createSignedFaucetRequest,
} from "./pqc-signer";

/**
 * API response type
 */
interface ApiResponse<T = unknown> {
  success: boolean;
  error?: string;
  data?: T;
}

/**
 * Submit a signed transaction to the server
 */
async function submitSignedTx(
  endpoint: string,
  signedTx: SignedTransaction
): Promise<ApiResponse> {
  const baseUrl = getNodeApiBaseUrl();
  if (!baseUrl) {
    return { success: false, error: "API not configured" };
  }

  try {
    const res = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        ...getCoreApiHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(signedTx),
    });

    const data = await res.json();
    return data;
  } catch (e) {
    return { success: false, error: `Request failed: ${e}` };
  }
}

/**
 * Transfer tokens securely (client-side signing)
 */
export async function secureTransfer(
  fromPublicKey: string,
  fromPrivateKey: string,
  toPublicKey: string,
  amount: number,
  fee: number = 1,
  token: string = "XRGE"
): Promise<ApiResponse> {
  const signedTx = createSignedTransfer(
    fromPublicKey,
    fromPrivateKey,
    toPublicKey,
    amount,
    fee,
    token
  );
  return submitSignedTx("/v2/transfer", signedTx);
}

/**
 * Create a token securely (client-side signing)
 */
export async function secureCreateToken(
  creatorPublicKey: string,
  creatorPrivateKey: string,
  tokenName: string,
  tokenSymbol: string,
  initialSupply: number,
  fee: number = 10
): Promise<ApiResponse<{ token_symbol: string }>> {
  const signedTx = createSignedTokenCreation(
    creatorPublicKey,
    creatorPrivateKey,
    tokenName,
    tokenSymbol,
    initialSupply,
    fee
  );
  return submitSignedTx("/v2/token/create", signedTx);
}

/**
 * Execute a swap securely (client-side signing)
 */
export async function secureSwap(
  fromPublicKey: string,
  fromPrivateKey: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: number,
  minAmountOut: number
): Promise<ApiResponse> {
  const signedTx = createSignedSwap(
    fromPublicKey,
    fromPrivateKey,
    tokenIn,
    tokenOut,
    amountIn,
    minAmountOut
  );
  return submitSignedTx("/v2/swap/execute", signedTx);
}

/**
 * Create a liquidity pool securely (client-side signing)
 */
export async function secureCreatePool(
  creatorPublicKey: string,
  creatorPrivateKey: string,
  tokenA: string,
  tokenB: string,
  amountA: number,
  amountB: number
): Promise<ApiResponse<{ pool_id: string }>> {
  const signedTx = createSignedPoolCreation(
    creatorPublicKey,
    creatorPrivateKey,
    tokenA,
    tokenB,
    amountA,
    amountB
  );
  return submitSignedTx("/v2/pool/create", signedTx);
}

/**
 * Add liquidity securely (client-side signing)
 */
export async function secureAddLiquidity(
  fromPublicKey: string,
  fromPrivateKey: string,
  poolId: string,
  amountA: number,
  amountB: number
): Promise<ApiResponse> {
  const signedTx = createSignedAddLiquidity(
    fromPublicKey,
    fromPrivateKey,
    poolId,
    amountA,
    amountB
  );
  return submitSignedTx("/v2/pool/add-liquidity", signedTx);
}

/**
 * Remove liquidity securely (client-side signing)
 */
export async function secureRemoveLiquidity(
  fromPublicKey: string,
  fromPrivateKey: string,
  poolId: string,
  lpAmount: number
): Promise<ApiResponse> {
  const signedTx = createSignedRemoveLiquidity(
    fromPublicKey,
    fromPrivateKey,
    poolId,
    lpAmount
  );
  return submitSignedTx("/v2/pool/remove-liquidity", signedTx);
}

/**
 * Stake tokens securely (client-side signing)
 */
export async function secureStake(
  fromPublicKey: string,
  fromPrivateKey: string,
  amount: number,
  fee: number = 1
): Promise<ApiResponse> {
  const signedTx = createSignedStake(
    fromPublicKey,
    fromPrivateKey,
    amount,
    fee
  );
  return submitSignedTx("/v2/stake", signedTx);
}

/**
 * Unstake tokens securely (client-side signing)
 */
export async function secureUnstake(
  fromPublicKey: string,
  fromPrivateKey: string,
  amount: number,
  fee: number = 1
): Promise<ApiResponse> {
  const signedTx = createSignedUnstake(
    fromPublicKey,
    fromPrivateKey,
    amount,
    fee
  );
  return submitSignedTx("/v2/unstake", signedTx);
}

/**
 * Request faucet tokens securely (client-side signing)
 */
export async function secureFaucet(
  publicKey: string,
  privateKey: string
): Promise<ApiResponse> {
  const signedTx = createSignedFaucetRequest(publicKey, privateKey);
  return submitSignedTx("/v2/faucet", signedTx);
}
