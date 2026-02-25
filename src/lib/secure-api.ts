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
  createSignedBurn,
  BURN_ADDRESS,
} from "./pqc-signer";

// Re-export burn address for convenience
export { BURN_ADDRESS };

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
  return submitSignedTx("/v2/token/create", signedTx) as Promise<ApiResponse<{ token_symbol: string }>>;
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
  return submitSignedTx("/v2/pool/create", signedTx) as Promise<ApiResponse<{ pool_id: string }>>;
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

/**
 * Burn tokens securely (client-side signing)
 * Tokens are sent to the official burn address and permanently destroyed
 */
export async function secureBurn(
  fromPublicKey: string,
  fromPrivateKey: string,
  amount: number,
  fee: number = 1,
  token: string = "XRGE"
): Promise<ApiResponse> {
  const signedTx = createSignedBurn(
    fromPublicKey,
    fromPrivateKey,
    amount,
    fee,
    token
  );
  return submitSignedTx("/v2/transfer", signedTx);
}

/**
 * Get burned tokens stats from the chain
 */
export async function getBurnedTokens(): Promise<ApiResponse<{
  burned: Record<string, number>;
  total_xrge_burned: number;
}>> {
  const baseUrl = getNodeApiBaseUrl();
  if (!baseUrl) {
    return { success: false, error: "API not configured" };
  }

  try {
    const res = await fetch(`${baseUrl}/burned`, {
      headers: getCoreApiHeaders(),
    });
    const data = await res.json();
    return { success: true, data };
  } catch (e) {
    return { success: false, error: `Request failed: ${e}` };
  }
}

// ===== Token Metadata API =====

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

/**
 * Get all token metadata
 */
export async function getAllTokenMetadata(): Promise<ApiResponse<TokenMetadata[]>> {
  const baseUrl = getNodeApiBaseUrl();
  if (!baseUrl) {
    return { success: false, error: "API not configured" };
  }

  try {
    const res = await fetch(`${baseUrl}/tokens`, {
      headers: getCoreApiHeaders(),
    });
    const data = await res.json();
    if (data.success) {
      return { success: true, data: data.tokens };
    }
    return { success: false, error: data.error || "Failed to fetch tokens" };
  } catch (e) {
    return { success: false, error: `Request failed: ${e}` };
  }
}

/**
 * Get metadata for a specific token
 */
export async function getTokenMetadata(symbol: string): Promise<ApiResponse<TokenMetadata>> {
  const baseUrl = getNodeApiBaseUrl();
  if (!baseUrl) {
    return { success: false, error: "API not configured" };
  }

  try {
    const res = await fetch(`${baseUrl}/token/${symbol}/metadata`, {
      headers: getCoreApiHeaders(),
    });
    const data = await res.json();
    if (data.success) {
      return { success: true, data };
    }
    return { success: false, error: data.error || "Token not found" };
  } catch (e) {
    return { success: false, error: `Request failed: ${e}` };
  }
}

/**
 * Claim token metadata (for tokens created before metadata system)
 * Only the original creator (verified on-chain) can claim
 */
export async function claimTokenMetadata(
  publicKey: string,
  privateKey: string,
  tokenSymbol: string
): Promise<ApiResponse> {
  const baseUrl = getNodeApiBaseUrl();
  if (!baseUrl) {
    return { success: false, error: "API not configured" };
  }

  try {
    const res = await fetch(`${baseUrl}/token/metadata/claim`, {
      method: "POST",
      headers: {
        ...getCoreApiHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        token_symbol: tokenSymbol,
        from_public_key: publicKey,
        from_private_key: privateKey,
      }),
    });
    
    // Handle non-OK responses
    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: `Server error (${res.status}): ${text || 'No response'}` };
    }
    
    const text = await res.text();
    if (!text) {
      return { success: false, error: "Empty response from server" };
    }
    
    try {
      const data = JSON.parse(text);
      return data;
    } catch {
      return { success: false, error: `Invalid JSON response: ${text.substring(0, 100)}` };
    }
  } catch (e) {
    return { success: false, error: `Request failed: ${e}` };
  }
}

/**
 * Update token metadata (only token creator can do this)
 * Note: This requires the private key to prove ownership
 */
export async function updateTokenMetadata(
  publicKey: string,
  privateKey: string,
  tokenSymbol: string,
  metadata: {
    image?: string;
    description?: string;
    website?: string;
    twitter?: string;
    discord?: string;
  }
): Promise<ApiResponse> {
  const baseUrl = getNodeApiBaseUrl();
  if (!baseUrl) {
    return { success: false, error: "API not configured" };
  }

  try {
    const res = await fetch(`${baseUrl}/token/metadata/update`, {
      method: "POST",
      headers: {
        ...getCoreApiHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        token_symbol: tokenSymbol,
        from_public_key: publicKey,
        from_private_key: privateKey,
        image: metadata.image,
        description: metadata.description,
        website: metadata.website,
        twitter: metadata.twitter,
        discord: metadata.discord,
      }),
    });
    
    const data = await res.json();
    return data;
  } catch (e) {
    return { success: false, error: `Request failed: ${e}` };
  }
}
