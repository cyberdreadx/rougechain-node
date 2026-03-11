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
  createSignedNftCreateCollection,
  createSignedNftMint,
  createSignedNftBatchMint,
  createSignedNftTransfer,
  createSignedNftBurn,
  createSignedNftLock,
  createSignedNftFreezeCollection,
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

    const raw = await res.json();
    // Normalize: server returns fields at top level, but ApiResponse expects them in `data`
    const { success, error, ...rest } = raw;
    return { success, error, data: Object.keys(rest).length > 0 ? rest : undefined };
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
  fee: number = 10,
  image?: string
): Promise<ApiResponse<{ token_symbol: string }>> {
  const signedTx = createSignedTokenCreation(
    creatorPublicKey,
    creatorPrivateKey,
    tokenName,
    tokenSymbol,
    initialSupply,
    fee,
    image
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

// ===== NFT API =====

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

export async function secureCreateNftCollection(
  publicKey: string,
  privateKey: string,
  symbol: string,
  name: string,
  opts: { maxSupply?: number; royaltyBps?: number; image?: string; description?: string } = {}
): Promise<ApiResponse> {
  const signedTx = createSignedNftCreateCollection(publicKey, privateKey, symbol, name, opts);
  return submitSignedTx("/v2/nft/collection/create", signedTx);
}

export async function secureMintNft(
  publicKey: string,
  privateKey: string,
  collectionId: string,
  name: string,
  opts: { metadataUri?: string; attributes?: unknown } = {}
): Promise<ApiResponse> {
  const signedTx = createSignedNftMint(publicKey, privateKey, collectionId, name, opts);
  return submitSignedTx("/v2/nft/mint", signedTx);
}

export async function secureBatchMintNft(
  publicKey: string,
  privateKey: string,
  collectionId: string,
  names: string[],
  opts: { uris?: string[]; batchAttributes?: unknown[] } = {}
): Promise<ApiResponse> {
  const signedTx = createSignedNftBatchMint(publicKey, privateKey, collectionId, names, opts);
  return submitSignedTx("/v2/nft/batch-mint", signedTx);
}

export async function secureTransferNft(
  publicKey: string,
  privateKey: string,
  collectionId: string,
  tokenId: number,
  toPublicKey: string,
  salePrice?: number
): Promise<ApiResponse> {
  const signedTx = createSignedNftTransfer(publicKey, privateKey, collectionId, tokenId, toPublicKey, salePrice);
  return submitSignedTx("/v2/nft/transfer", signedTx);
}

export async function secureBurnNft(
  publicKey: string,
  privateKey: string,
  collectionId: string,
  tokenId: number
): Promise<ApiResponse> {
  const signedTx = createSignedNftBurn(publicKey, privateKey, collectionId, tokenId);
  return submitSignedTx("/v2/nft/burn", signedTx);
}

export async function secureLockNft(
  publicKey: string,
  privateKey: string,
  collectionId: string,
  tokenId: number,
  locked: boolean
): Promise<ApiResponse> {
  const signedTx = createSignedNftLock(publicKey, privateKey, collectionId, tokenId, locked);
  return submitSignedTx("/v2/nft/lock", signedTx);
}

export async function secureFreezeNftCollection(
  publicKey: string,
  privateKey: string,
  collectionId: string,
  frozen: boolean
): Promise<ApiResponse> {
  const signedTx = createSignedNftFreezeCollection(publicKey, privateKey, collectionId, frozen);
  return submitSignedTx("/v2/nft/freeze-collection", signedTx);
}

// ===== NFT Query Functions (no signing needed) =====

export async function getNftCollections(): Promise<ApiResponse<NftCollection[]>> {
  const baseUrl = getNodeApiBaseUrl();
  if (!baseUrl) return { success: false, error: "API not configured" };

  try {
    const res = await fetch(`${baseUrl}/nft/collections`, { headers: getCoreApiHeaders() });
    const data = await res.json();
    return { success: true, data: data.collections };
  } catch (e) {
    return { success: false, error: `Request failed: ${e}` };
  }
}

export async function getNftCollection(collectionId: string): Promise<ApiResponse<NftCollection>> {
  const baseUrl = getNodeApiBaseUrl();
  if (!baseUrl) return { success: false, error: "API not configured" };

  try {
    const res = await fetch(`${baseUrl}/nft/collection/${encodeURIComponent(collectionId)}`, { headers: getCoreApiHeaders() });
    if (!res.ok) return { success: false, error: "Collection not found" };
    const data = await res.json();
    return { success: true, data };
  } catch (e) {
    return { success: false, error: `Request failed: ${e}` };
  }
}

export async function getNftTokens(
  collectionId: string,
  limit?: number,
  offset?: number
): Promise<ApiResponse<{ tokens: NftToken[]; total: number }>> {
  const baseUrl = getNodeApiBaseUrl();
  if (!baseUrl) return { success: false, error: "API not configured" };

  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (offset !== undefined) params.set("offset", String(offset));

  try {
    const res = await fetch(
      `${baseUrl}/nft/collection/${encodeURIComponent(collectionId)}/tokens?${params}`,
      { headers: getCoreApiHeaders() }
    );
    const data = await res.json();
    return { success: true, data };
  } catch (e) {
    return { success: false, error: `Request failed: ${e}` };
  }
}

export async function getNftToken(
  collectionId: string,
  tokenId: number
): Promise<ApiResponse<NftToken>> {
  const baseUrl = getNodeApiBaseUrl();
  if (!baseUrl) return { success: false, error: "API not configured" };

  try {
    const res = await fetch(
      `${baseUrl}/nft/token/${encodeURIComponent(collectionId)}/${tokenId}`,
      { headers: getCoreApiHeaders() }
    );
    if (!res.ok) return { success: false, error: "NFT not found" };
    const data = await res.json();
    return { success: true, data };
  } catch (e) {
    return { success: false, error: `Request failed: ${e}` };
  }
}

export async function getNftsByOwner(pubkey: string): Promise<ApiResponse<NftToken[]>> {
  const baseUrl = getNodeApiBaseUrl();
  if (!baseUrl) return { success: false, error: "API not configured" };

  try {
    const res = await fetch(
      `${baseUrl}/nft/owner/${encodeURIComponent(pubkey)}`,
      { headers: getCoreApiHeaders() }
    );
    const data = await res.json();
    return { success: true, data: data.nfts };
  } catch (e) {
    return { success: false, error: `Request failed: ${e}` };
  }
}
