import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { hexToBytes, bytesToHex, generateNonce } from "./utils.js";
import type {
  TransactionPayload,
  SignedTransaction,
  WalletKeys,
} from "./types.js";

export const BURN_ADDRESS =
  "XRGE_BURN_0x000000000000000000000000000000000000000000000000000000000000DEAD";

function sortKeysDeep(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  if (obj !== null && typeof obj === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysDeep((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}

export function serializePayload(payload: TransactionPayload): Uint8Array {
  const json = JSON.stringify(sortKeysDeep(payload));
  return new TextEncoder().encode(json);
}

export function signTransaction(
  payload: TransactionPayload,
  privateKey: string,
  publicKey: string
): SignedTransaction {
  const payloadBytes = serializePayload(payload);
  const signature = ml_dsa65.sign(payloadBytes, hexToBytes(privateKey));
  return {
    payload,
    signature: bytesToHex(signature),
    public_key: publicKey,
  };
}

export function verifyTransaction(signedTx: SignedTransaction): boolean {
  try {
    const payloadBytes = serializePayload(signedTx.payload);
    return ml_dsa65.verify(
      hexToBytes(signedTx.signature),
      payloadBytes,
      hexToBytes(signedTx.public_key)
    );
  } catch {
    return false;
  }
}

export function isBurnAddress(address: string): boolean {
  return address === BURN_ADDRESS;
}

// ===== Network binding =====

/** Chain id of RougeChain mainnet. */
export const MAINNET_CHAIN_ID = "rougechain-mainnet-1";
/** Chain id of RougeChain testnet. */
export const TESTNET_CHAIN_ID = "rougechain-devnet-1";

/**
 * Thrown when a signature would be made for a network other than the expected one: the node
 * reports another chain id than the client was configured with, or a payload / wallet already
 * names a different chain id. `code` is `"CHAIN_ID_MISMATCH"`.
 */
export class ChainIdMismatchError extends Error {
  readonly code = "CHAIN_ID_MISMATCH";
  constructor(readonly expected: string, readonly actual: string) {
    super(`CHAIN_ID_MISMATCH: expected chain id "${expected}", got "${actual}" — refusing to sign`);
    this.name = "ChainIdMismatchError";
  }
}

/**
 * Return `wallet` bound to `chainId`: every payload the SDK signers build with the result carries
 * `chainId`, so the signature commits to that network. Throws {@link ChainIdMismatchError} if the
 * wallet is already bound to another chain id.
 */
export function bindWalletToChain<W extends WalletKeys>(wallet: W, chainId: string): W & { chainId: string } {
  if (!chainId) throw new Error("chainId is required");
  if (wallet.chainId !== undefined && wallet.chainId !== chainId) {
    throw new ChainIdMismatchError(chainId, wallet.chainId);
  }
  return Object.assign(Object.create(Object.getPrototypeOf(wallet)), wallet, { chainId });
}

/** Add the wallet's chain id (if any) to a payload about to be signed. */
export function applyChainId<P extends Record<string, unknown>>(wallet: WalletKeys, payload: P): P {
  if (wallet.chainId === undefined) return payload;
  const existing = payload.chainId;
  if (existing !== undefined && existing !== wallet.chainId) {
    throw new ChainIdMismatchError(wallet.chainId, String(existing));
  }
  return { ...payload, chainId: wallet.chainId };
}

// ===== Transaction builders =====

function buildAndSign(
  wallet: WalletKeys,
  payload: Omit<TransactionPayload, "from" | "timestamp" | "nonce">,
  accountNonce?: number
): SignedTransaction {
  const full: TransactionPayload = {
    ...payload,
    from: wallet.publicKey,
    timestamp: Date.now(),
    nonce: generateNonce(),
    // Optional durable replay protection: the node enforces that this equals the account's next
    // nonce, so a captured signed tx cannot be re-executed once the account advances (independent
    // of the timestamp/replay window). Omit it and the node falls back to legacy behavior.
    ...(accountNonce !== undefined ? { account_nonce: accountNonce } : {}),
  } as TransactionPayload;
  // Network binding: the wallet's chain id (set by the RougeChain client) goes inside the signed
  // bytes, so the signature is valid for that network only.
  const bound = applyChainId(wallet, full as unknown as Record<string, unknown>) as unknown as TransactionPayload;
  return signTransaction(bound, wallet.privateKey, wallet.publicKey);
}

export function createSignedTransfer(
  wallet: WalletKeys,
  to: string,
  amount: number,
  fee = 1,
  token = "XRGE",
  accountNonce?: number
): SignedTransaction {
  return buildAndSign(wallet, { type: "transfer", to, amount, fee, token }, accountNonce);
}

/**
 * Largest integer the node accepts for a mint amount, a mintable token's initial supply and its
 * max supply (2^53 - 1, the largest integer JSON carries exactly). `TOKEN_MINT_MAX_AMOUNT` in
 * core/daemon/src/node.rs.
 */
export const TOKEN_MINT_MAX_AMOUNT = 9_007_199_254_740_991;

/** XRGE fee the node charges for a `mint_tokens` transaction (v2_binding). */
export const TOKEN_MINT_FEE_XRGE = 1;

/** XRGE fee the node charges for a `create_token` transaction (v2_binding). */
export const TOKEN_CREATE_FEE_XRGE = 100;

/** Extra options for {@link createSignedTokenCreation}. */
export interface TokenCreationOptions {
  /**
   * Create the token mintable: its creator can mint more later with `mint_tokens`
   * (node TOKEN_MINTING upgrade — the node refuses this before the upgrade is active).
   */
  mintable?: boolean;
  /** Optional cap on initial + minted supply. Only with `mintable: true`; integer ≥ initial supply. */
  maxSupply?: number;
  /** Token description (signed with the payload). */
  description?: string;
}

function isWholeAmount(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0;
}

/**
 * Validate the TOKEN_MINTING fields of a `create_token` and return the exact payload fields to sign:
 * `{}` for a fixed-supply token, `{ mintable: true }` or `{ mintable: true, max_supply }` for a
 * mintable one. Throws a clear error on invalid input (mirrors the node's checks).
 */
export function tokenMintFields(
  initialSupply: number,
  options: Pick<TokenCreationOptions, "mintable" | "maxSupply"> = {}
): { mintable?: true; max_supply?: number } {
  const { mintable, maxSupply } = options;
  if (mintable !== undefined && typeof mintable !== "boolean") {
    throw new Error("mintable must be a boolean");
  }
  if (!mintable) {
    if (maxSupply !== undefined && maxSupply !== null) {
      throw new Error("maxSupply requires mintable: true");
    }
    return {};
  }
  if (!isWholeAmount(initialSupply) || initialSupply > TOKEN_MINT_MAX_AMOUNT) {
    throw new Error(`a mintable token's initial supply must be a positive integer at most ${TOKEN_MINT_MAX_AMOUNT}`);
  }
  if (maxSupply === undefined || maxSupply === null) {
    return { mintable: true };
  }
  if (!isWholeAmount(maxSupply) || maxSupply > TOKEN_MINT_MAX_AMOUNT) {
    throw new Error(`maxSupply must be a positive integer at most ${TOKEN_MINT_MAX_AMOUNT}`);
  }
  if (maxSupply < initialSupply) {
    throw new Error(`maxSupply ${maxSupply} is below the initial supply ${initialSupply}`);
  }
  return { mintable: true, max_supply: maxSupply };
}

export function createSignedTokenCreation(
  wallet: WalletKeys,
  tokenName: string,
  tokenSymbol: string,
  initialSupply: number,
  fee = TOKEN_CREATE_FEE_XRGE, // the node charges a fixed 100 XRGE for create_token (v2_binding)
  image?: string,
  options: TokenCreationOptions = {}
): SignedTransaction {
  const mintFields = tokenMintFields(initialSupply, options);
  return buildAndSign(wallet, {
    type: "create_token",
    token_name: tokenName,
    token_symbol: tokenSymbol,
    initial_supply: initialSupply,
    fee,
    ...(image ? { image } : {}),
    ...(options.description ? { description: options.description } : {}),
    ...mintFields,
  });
}

/**
 * Sign a `mint_tokens` (node TOKEN_MINTING upgrade): mint `amount` more of a mintable token to
 * its creator. Only the token's creator can mint; the node enforces the max supply and charges
 * {@link TOKEN_MINT_FEE_XRGE}. Submit to `POST /api/v2/token/mint`.
 */
export function createSignedTokenMint(
  wallet: WalletKeys,
  tokenSymbol: string,
  amount: number,
  fee = TOKEN_MINT_FEE_XRGE,
  accountNonce?: number
): SignedTransaction {
  const symbol = String(tokenSymbol ?? "").trim().toUpperCase();
  if (!symbol) throw new Error("token symbol is required");
  if (!isWholeAmount(amount) || amount > TOKEN_MINT_MAX_AMOUNT) {
    throw new Error(`mint amount must be a positive integer at most ${TOKEN_MINT_MAX_AMOUNT}`);
  }
  return buildAndSign(
    wallet,
    { type: "mint_tokens", token_symbol: symbol, amount, fee },
    accountNonce
  );
}

export function createSignedTokenMetadataUpdate(
  wallet: WalletKeys,
  tokenSymbol: string,
  metadata: {
    image?: string;
    description?: string;
    website?: string;
    twitter?: string;
    discord?: string;
  }
): SignedTransaction {
  return buildAndSign(wallet, {
    type: "update_token_metadata",
    token_symbol: tokenSymbol,
    ...(metadata.image !== undefined ? { image: metadata.image } : {}),
    ...(metadata.description !== undefined ? { description: metadata.description } : {}),
    ...(metadata.website !== undefined ? { website: metadata.website } : {}),
    ...(metadata.twitter !== undefined ? { twitter: metadata.twitter } : {}),
    ...(metadata.discord !== undefined ? { discord: metadata.discord } : {}),
  });
}

export function createSignedTokenMetadataClaim(
  wallet: WalletKeys,
  tokenSymbol: string
): SignedTransaction {
  return buildAndSign(wallet, {
    type: "claim_token_metadata",
    token_symbol: tokenSymbol,
  });
}

export function createSignedTokenApproval(
  wallet: WalletKeys,
  spender: string,
  tokenSymbol: string,
  amount: number
): SignedTransaction {
  return buildAndSign(wallet, {
    type: "approve",
    spender,
    token_symbol: tokenSymbol,
    amount,
  });
}

export function createSignedTokenTransferFrom(
  wallet: WalletKeys,
  owner: string,
  to: string,
  tokenSymbol: string,
  amount: number
): SignedTransaction {
  return buildAndSign(wallet, {
    type: "transfer_from",
    owner,
    to,
    token_symbol: tokenSymbol,
    amount,
  });
}

export function createSignedSwap(
  wallet: WalletKeys,
  tokenIn: string,
  tokenOut: string,
  amountIn: number,
  minAmountOut: number
): SignedTransaction {
  return buildAndSign(wallet, {
    type: "swap",
    token_in: tokenIn,
    token_out: tokenOut,
    amount_in: amountIn,
    min_amount_out: minAmountOut,
  });
}

export function createSignedPoolCreation(
  wallet: WalletKeys,
  tokenA: string,
  tokenB: string,
  amountA: number,
  amountB: number
): SignedTransaction {
  return buildAndSign(wallet, {
    type: "create_pool",
    token_a: tokenA,
    token_b: tokenB,
    amount_a: amountA,
    amount_b: amountB,
  });
}

export function createSignedAddLiquidity(
  wallet: WalletKeys,
  poolId: string,
  amountA: number,
  amountB: number
): SignedTransaction {
  return buildAndSign(wallet, {
    type: "add_liquidity",
    pool_id: poolId,
    amount_a: amountA,
    amount_b: amountB,
  });
}

export function createSignedRemoveLiquidity(
  wallet: WalletKeys,
  poolId: string,
  lpAmount: number
): SignedTransaction {
  return buildAndSign(wallet, {
    type: "remove_liquidity",
    pool_id: poolId,
    lp_amount: lpAmount,
  });
}

export function createSignedStake(
  wallet: WalletKeys,
  amount: number,
  fee = 1
): SignedTransaction {
  return buildAndSign(wallet, { type: "stake", amount, fee });
}

export function createSignedUnstake(
  wallet: WalletKeys,
  amount: number,
  fee = 1
): SignedTransaction {
  return buildAndSign(wallet, { type: "unstake", amount, fee });
}

export function createSignedFaucetRequest(
  wallet: WalletKeys
): SignedTransaction {
  return buildAndSign(wallet, { type: "faucet" });
}

export function createSignedBurn(
  wallet: WalletKeys,
  amount: number,
  fee = 1,
  token = "XRGE"
): SignedTransaction {
  return buildAndSign(wallet, {
    type: "transfer",
    to: BURN_ADDRESS,
    amount,
    fee,
    token,
  });
}

// ===== Bridge builders =====

export function createSignedBridgeWithdraw(
  wallet: WalletKeys,
  amount: number,
  evmAddress: string,
  tokenSymbol = "qETH",
  fee = 0.1
): SignedTransaction {
  const evm = evmAddress.startsWith("0x") ? evmAddress : `0x${evmAddress}`;
  return buildAndSign(wallet, {
    type: "bridge_withdraw",
    amount,
    fee,
    tokenSymbol,
    evmAddress: evm,
  });
}

// ===== NFT builders =====

export function createSignedNftCreateCollection(
  wallet: WalletKeys,
  symbol: string,
  name: string,
  opts: {
    maxSupply?: number;
    royaltyBps?: number;
    royaltyRecipient?: string;
    image?: string;
    description?: string;
    publicMint?: boolean;
    mintPrice?: number;
    tokenGateSymbol?: string;
    tokenGateAmount?: number;
    discountPct?: number;
  } = {}
): SignedTransaction {
  return buildAndSign(wallet, {
    type: "nft_create_collection",
    symbol,
    name,
    fee: 50,
    maxSupply: opts.maxSupply,
    royaltyBps: opts.royaltyBps,
    royaltyRecipient: opts.royaltyRecipient,
    image: opts.image,
    description: opts.description,
    publicMint: opts.publicMint,
    mintPrice: opts.mintPrice,
    tokenGateSymbol: opts.tokenGateSymbol,
    tokenGateAmount: opts.tokenGateAmount,
    discountPct: opts.discountPct,
  });
}

export function createSignedNftMint(
  wallet: WalletKeys,
  collectionId: string,
  name: string,
  opts: { metadataUri?: string; attributes?: unknown } = {}
): SignedTransaction {
  return buildAndSign(wallet, {
    type: "nft_mint",
    collectionId,
    name,
    fee: 5,
    metadataUri: opts.metadataUri,
    attributes: opts.attributes,
  });
}

export function createSignedNftBatchMint(
  wallet: WalletKeys,
  collectionId: string,
  names: string[],
  opts: {
    uris?: string[];
    /** Per-NFT attributes, one entry per name (signed as the payload's `attributes` field). */
    attributes?: unknown[];
    /** @deprecated Alias of `attributes` (SDK ≤ 1.10.0 sent it under a field the node ignored, so attributes were dropped). */
    batchAttributes?: unknown[];
  } = {}
): SignedTransaction {
  return buildAndSign(wallet, {
    type: "nft_batch_mint",
    collectionId,
    names,
    fee: 5 * names.length,
    uris: opts.uris,
    // The node reads per-NFT batch attributes only from `attributes` (v2_binding nft_batch_mint).
    attributes: opts.attributes ?? opts.batchAttributes,
  });
}

export function createSignedNftTransfer(
  wallet: WalletKeys,
  collectionId: string,
  tokenId: number,
  to: string,
  salePrice?: number
): SignedTransaction {
  return buildAndSign(wallet, {
    type: "nft_transfer",
    collectionId,
    tokenId,
    to,
    fee: 1,
    salePrice,
  });
}

export function createSignedNftBurn(
  wallet: WalletKeys,
  collectionId: string,
  tokenId: number
): SignedTransaction {
  return buildAndSign(wallet, {
    type: "nft_burn",
    collectionId,
    tokenId,
    fee: 0.1,
  });
}

export function createSignedNftLock(
  wallet: WalletKeys,
  collectionId: string,
  tokenId: number,
  locked: boolean
): SignedTransaction {
  return buildAndSign(wallet, {
    type: "nft_lock",
    collectionId,
    tokenId,
    locked,
    fee: 0.1,
  });
}

export function createSignedNftFreezeCollection(
  wallet: WalletKeys,
  collectionId: string,
  frozen: boolean
): SignedTransaction {
  return buildAndSign(wallet, {
    type: "nft_freeze_collection",
    collectionId,
    frozen,
    fee: 0.1,
  });
}

// ===== Shielded transaction builders =====

export function createSignedShield(
  wallet: WalletKeys,
  amount: number,
  commitment: string
): SignedTransaction {
  return buildAndSign(wallet, {
    type: "shield",
    amount,
    commitment,
  } as any);
}

export function createSignedShieldedTransfer(
  wallet: WalletKeys,
  nullifiers: string[],
  outputCommitments: string[],
  proof: string,
  shieldedFee?: number
): SignedTransaction {
  return buildAndSign(wallet, {
    type: "shielded_transfer",
    nullifiers,
    output_commitments: outputCommitments,
    proof,
    fee: shieldedFee ?? 0,
  } as any);
}

export function createSignedUnshield(
  wallet: WalletKeys,
  nullifiers: string[],
  amount: number,
  proof: string
): SignedTransaction {
  return buildAndSign(wallet, {
    type: "unshield",
    nullifiers,
    amount,
    proof,
  } as any);
}

// ===== Push notification builders =====

export function createSignedPushRegister(
  wallet: WalletKeys,
  pushToken: string,
  platform = "expo"
): SignedTransaction {
  return buildAndSign(wallet, {
    type: "push_register",
    pushToken,
    platform,
  } as any);
}

export function createSignedPushUnregister(
  wallet: WalletKeys,
): SignedTransaction {
  return buildAndSign(wallet, {
    type: "push_unregister",
  } as any);
}

// ===== Generic signed request builder (for mail/messenger/names) =====

export function signRequest(
  wallet: WalletKeys,
  payload: Record<string, unknown>
): SignedTransaction {
  return buildAndSign(wallet, payload as any);
}
