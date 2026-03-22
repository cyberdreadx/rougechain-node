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

// ===== Transaction builders =====

function buildAndSign(
  wallet: WalletKeys,
  payload: Omit<TransactionPayload, "from" | "timestamp" | "nonce">
): SignedTransaction {
  const full: TransactionPayload = {
    ...payload,
    from: wallet.publicKey,
    timestamp: Date.now(),
    nonce: generateNonce(),
  } as TransactionPayload;
  return signTransaction(full, wallet.privateKey, wallet.publicKey);
}

export function createSignedTransfer(
  wallet: WalletKeys,
  to: string,
  amount: number,
  fee = 1,
  token = "XRGE"
): SignedTransaction {
  return buildAndSign(wallet, { type: "transfer", to, amount, fee, token });
}

export function createSignedTokenCreation(
  wallet: WalletKeys,
  tokenName: string,
  tokenSymbol: string,
  initialSupply: number,
  fee = 10,
  image?: string
): SignedTransaction {
  return buildAndSign(wallet, {
    type: "create_token",
    token_name: tokenName,
    token_symbol: tokenSymbol,
    initial_supply: initialSupply,
    fee,
    ...(image ? { image } : {}),
  });
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
    image?: string;
    description?: string;
  } = {}
): SignedTransaction {
  return buildAndSign(wallet, {
    type: "nft_create_collection",
    symbol,
    name,
    fee: 50,
    maxSupply: opts.maxSupply,
    royaltyBps: opts.royaltyBps,
    image: opts.image,
    description: opts.description,
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
  opts: { uris?: string[]; batchAttributes?: unknown[] } = {}
): SignedTransaction {
  return buildAndSign(wallet, {
    type: "nft_batch_mint",
    collectionId,
    names,
    fee: 5 * names.length,
    uris: opts.uris,
    batchAttributes: opts.batchAttributes,
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

