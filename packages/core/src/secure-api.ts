/**
 * Secure API client that uses client-side signing
 * 
 * All transactions are signed locally before being sent to the server.
 * Private keys NEVER leave the browser.
 *
 * When connected via browser extension or Qwalla dApp browser (no local
 * private key), signing requests are routed through window.rougechain.
 */

import { getNodeApiBaseUrl, getCoreApiHeaders } from "./network";
import {
  type TransactionPayload,
  type SignedTransaction,
  signTransaction,
  generateNonce,
  BURN_ADDRESS,
} from "./pqc-signer";
import { signViaExtension, getRougeChainProvider } from "./extension-bridge";

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
 * Sign a transaction locally or via extension depending on private key availability
 */
async function resolveSignedTx(
  payload: TransactionPayload,
  publicKey: string,
  privateKey: string
): Promise<SignedTransaction> {
  if (!privateKey) {
    if (!getRougeChainProvider()) {
      throw new Error("No private key and no wallet extension available — cannot sign transaction");
    }
    return signViaExtension(payload, publicKey);
  }
  return signTransaction(payload, privateKey, publicKey);
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

// ============================================
// Token operations
// ============================================

export async function secureTransfer(
  fromPublicKey: string,
  fromPrivateKey: string,
  toPublicKey: string,
  amount: number,
  fee: number = 1,
  token: string = "XRGE"
): Promise<ApiResponse> {
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
  const signedTx = await resolveSignedTx(payload, fromPublicKey, fromPrivateKey);
  return submitSignedTx("/v2/transfer", signedTx);
}

export async function secureCreateToken(
  creatorPublicKey: string,
  creatorPrivateKey: string,
  tokenName: string,
  tokenSymbol: string,
  initialSupply: number,
  fee: number = 10,
  image?: string,
  description?: string
): Promise<ApiResponse<{ token_symbol: string }>> {
  const payload: TransactionPayload = {
    type: "create_token",
    from: creatorPublicKey,
    token_name: tokenName,
    token_symbol: tokenSymbol,
    initial_supply: initialSupply,
    fee,
    timestamp: Date.now(),
    nonce: generateNonce(),
    ...(image ? { image } : {}),
    ...(description ? { description } : {}),
  };
  const signedTx = await resolveSignedTx(payload, creatorPublicKey, creatorPrivateKey);
  return submitSignedTx("/v2/token/create", signedTx) as Promise<ApiResponse<{ token_symbol: string }>>;
}

export async function secureApproveToken(
  ownerPublicKey: string,
  ownerPrivateKey: string,
  spenderPublicKey: string,
  tokenSymbol: string,
  amount: number
): Promise<ApiResponse<{ spender: string; token_symbol: string; amount: number }>> {
  const payload: TransactionPayload = {
    type: "approve",
    from: ownerPublicKey,
    spender: spenderPublicKey,
    token_symbol: tokenSymbol,
    amount,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };
  const signedTx = await resolveSignedTx(payload, ownerPublicKey, ownerPrivateKey);
  return submitSignedTx("/v2/token/approve", signedTx) as Promise<ApiResponse<{ spender: string; token_symbol: string; amount: number }>>;
}

export async function secureTransferFrom(
  spenderPublicKey: string,
  spenderPrivateKey: string,
  ownerPublicKey: string,
  recipientPublicKey: string,
  tokenSymbol: string,
  amount: number
): Promise<ApiResponse<{ from: string; to: string; amount: number }>> {
  const payload: TransactionPayload = {
    type: "transfer_from",
    from: spenderPublicKey,
    owner: ownerPublicKey,
    to: recipientPublicKey,
    token_symbol: tokenSymbol,
    amount,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };
  const signedTx = await resolveSignedTx(payload, spenderPublicKey, spenderPrivateKey);
  return submitSignedTx("/v2/token/transfer-from", signedTx) as Promise<ApiResponse<{ from: string; to: string; amount: number }>>;
}

// ============================================
// DEX operations
// ============================================

export async function secureSwap(
  fromPublicKey: string,
  fromPrivateKey: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: number,
  minAmountOut: number
): Promise<ApiResponse> {
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
  const signedTx = await resolveSignedTx(payload, fromPublicKey, fromPrivateKey);
  return submitSignedTx("/v2/swap/execute", signedTx);
}

export async function secureCreatePool(
  creatorPublicKey: string,
  creatorPrivateKey: string,
  tokenA: string,
  tokenB: string,
  amountA: number,
  amountB: number
): Promise<ApiResponse<{ pool_id: string }>> {
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
  const signedTx = await resolveSignedTx(payload, creatorPublicKey, creatorPrivateKey);
  return submitSignedTx("/v2/pool/create", signedTx) as Promise<ApiResponse<{ pool_id: string }>>;
}

export async function secureAddLiquidity(
  fromPublicKey: string,
  fromPrivateKey: string,
  poolId: string,
  amountA: number,
  amountB: number
): Promise<ApiResponse> {
  const payload: TransactionPayload = {
    type: "add_liquidity",
    from: fromPublicKey,
    pool_id: poolId,
    amount_a: amountA,
    amount_b: amountB,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };
  const signedTx = await resolveSignedTx(payload, fromPublicKey, fromPrivateKey);
  return submitSignedTx("/v2/pool/add-liquidity", signedTx);
}

export async function secureRemoveLiquidity(
  fromPublicKey: string,
  fromPrivateKey: string,
  poolId: string,
  lpAmount: number
): Promise<ApiResponse> {
  const payload: TransactionPayload = {
    type: "remove_liquidity",
    from: fromPublicKey,
    pool_id: poolId,
    lp_amount: lpAmount,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };
  const signedTx = await resolveSignedTx(payload, fromPublicKey, fromPrivateKey);
  return submitSignedTx("/v2/pool/remove-liquidity", signedTx);
}

// ============================================
// Staking operations
// ============================================

export async function secureStake(
  fromPublicKey: string,
  fromPrivateKey: string,
  amount: number,
  fee: number = 1
): Promise<ApiResponse> {
  const payload: TransactionPayload = {
    type: "stake",
    from: fromPublicKey,
    amount,
    fee,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };
  const signedTx = await resolveSignedTx(payload, fromPublicKey, fromPrivateKey);
  return submitSignedTx("/v2/stake", signedTx);
}

export async function secureUnstake(
  fromPublicKey: string,
  fromPrivateKey: string,
  amount: number,
  fee: number = 1
): Promise<ApiResponse> {
  const payload: TransactionPayload = {
    type: "unstake",
    from: fromPublicKey,
    amount,
    fee,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };
  const signedTx = await resolveSignedTx(payload, fromPublicKey, fromPrivateKey);
  return submitSignedTx("/v2/unstake", signedTx);
}

// ============================================
// Faucet / Burn
// ============================================

export async function secureFaucet(
  publicKey: string,
  privateKey: string
): Promise<ApiResponse> {
  const payload: TransactionPayload = {
    type: "faucet",
    from: publicKey,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };
  const signedTx = await resolveSignedTx(payload, publicKey, privateKey);
  return submitSignedTx("/v2/faucet", signedTx);
}

export async function secureBurn(
  fromPublicKey: string,
  fromPrivateKey: string,
  amount: number,
  fee: number = 1,
  token: string = "XRGE"
): Promise<ApiResponse> {
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
  const signedTx = await resolveSignedTx(payload, fromPublicKey, fromPrivateKey);
  return submitSignedTx("/v2/transfer", signedTx);
}

// ============================================
// Burned token stats (no signing needed)
// ============================================

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

// ============================================
// Token Metadata API
// ============================================

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

export async function claimTokenMetadata(
  publicKey: string,
  privateKey: string,
  tokenSymbol: string
): Promise<ApiResponse> {
  const payload: TransactionPayload = {
    type: "claim_token_metadata",
    from: publicKey,
    token_symbol: tokenSymbol,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };
  const signedTx = await resolveSignedTx(payload, publicKey, privateKey);
  return submitSignedTx("/v2/token/metadata/claim", signedTx);
}

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
  const payload: TransactionPayload = {
    type: "update_token_metadata",
    from: publicKey,
    token_symbol: tokenSymbol,
    timestamp: Date.now(),
    nonce: generateNonce(),
    ...(metadata.image !== undefined ? { image: metadata.image } : {}),
    ...(metadata.description !== undefined ? { description: metadata.description } : {}),
    ...(metadata.website !== undefined ? { website: metadata.website } : {}),
    ...(metadata.twitter !== undefined ? { twitter: metadata.twitter } : {}),
    ...(metadata.discord !== undefined ? { discord: metadata.discord } : {}),
  };
  const signedTx = await resolveSignedTx(payload, publicKey, privateKey);
  return submitSignedTx("/v2/token/metadata/update", signedTx);
}

// ============================================
// NFT API
// ============================================

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
  const signedTx = await resolveSignedTx(payload, publicKey, privateKey);
  return submitSignedTx("/v2/nft/collection/create", signedTx);
}

export async function secureMintNft(
  publicKey: string,
  privateKey: string,
  collectionId: string,
  name: string,
  opts: { metadataUri?: string; attributes?: unknown } = {}
): Promise<ApiResponse> {
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
  const signedTx = await resolveSignedTx(payload, publicKey, privateKey);
  return submitSignedTx("/v2/nft/mint", signedTx);
}

export async function secureBatchMintNft(
  publicKey: string,
  privateKey: string,
  collectionId: string,
  names: string[],
  opts: { uris?: string[]; batchAttributes?: unknown[] } = {}
): Promise<ApiResponse> {
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
  const signedTx = await resolveSignedTx(payload, publicKey, privateKey);
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
  const signedTx = await resolveSignedTx(payload, publicKey, privateKey);
  return submitSignedTx("/v2/nft/transfer", signedTx);
}

export async function secureBurnNft(
  publicKey: string,
  privateKey: string,
  collectionId: string,
  tokenId: number
): Promise<ApiResponse> {
  const payload: TransactionPayload = {
    type: "nft_burn",
    from: publicKey,
    collectionId,
    tokenId,
    fee: 0.1,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };
  const signedTx = await resolveSignedTx(payload, publicKey, privateKey);
  return submitSignedTx("/v2/nft/burn", signedTx);
}

export async function secureLockNft(
  publicKey: string,
  privateKey: string,
  collectionId: string,
  tokenId: number,
  locked: boolean
): Promise<ApiResponse> {
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
  const signedTx = await resolveSignedTx(payload, publicKey, privateKey);
  return submitSignedTx("/v2/nft/lock", signedTx);
}

export async function secureFreezeNftCollection(
  publicKey: string,
  privateKey: string,
  collectionId: string,
  frozen: boolean
): Promise<ApiResponse> {
  const payload: TransactionPayload = {
    type: "nft_freeze_collection",
    from: publicKey,
    collectionId,
    frozen,
    fee: 0.1,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };
  const signedTx = await resolveSignedTx(payload, publicKey, privateKey);
  return submitSignedTx("/v2/nft/freeze-collection", signedTx);
}

// ============================================
// NFT Query Functions (no signing needed)
// ============================================

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

// ============================================
// Shielded Transaction API
// ============================================

export interface ShieldedStats {
  success: boolean;
  commitment_count: number;
  nullifier_count: number;
  active_notes: number;
}

export async function getShieldedStats(): Promise<ApiResponse<ShieldedStats>> {
  const baseUrl = getNodeApiBaseUrl();
  if (!baseUrl) return { success: false, error: "API not configured" };

  try {
    const res = await fetch(`${baseUrl}/shielded/stats`, { headers: getCoreApiHeaders() });
    const data = await res.json();
    return { success: true, data };
  } catch (e) {
    return { success: false, error: `Request failed: ${e}` };
  }
}

export async function secureShield(
  publicKey: string,
  privateKey: string,
  amount: number,
  commitment: string
): Promise<ApiResponse> {
  const payload: TransactionPayload = {
    type: "shield",
    from: publicKey,
    amount,
    commitment,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };
  const signedTx = await resolveSignedTx(payload, publicKey, privateKey);
  return submitSignedTx("/v2/shielded/shield", signedTx);
}

export async function secureUnshield(
  publicKey: string,
  privateKey: string,
  nullifiers: string[],
  amount: number,
  proof: string
): Promise<ApiResponse> {
  const payload: TransactionPayload = {
    type: "unshield",
    from: publicKey,
    nullifiers,
    amount,
    proof,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };
  const signedTx = await resolveSignedTx(payload, publicKey, privateKey);
  return submitSignedTx("/v2/shielded/unshield", signedTx);
}
