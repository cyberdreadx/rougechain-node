/**
 * Bridge: Base Sepolia testnet ETH → RougeChain qETH
 * User sends ETH to custody address, then claims qETH on RougeChain.
 */

import { getCoreApiBaseUrl, getCoreApiHeaders } from "./network";

export const BASE_SEPOLIA_CHAIN_ID = 84532;

/** Base Sepolia config for wallet connection */
export const baseSepolia = {
  chainId: BASE_SEPOLIA_CHAIN_ID,
  name: "Base Sepolia",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://sepolia.base.org"] },
  },
  blockExplorers: {
    default: { name: "Basescan", url: "https://sepolia.basescan.org" },
  },
};

export interface BridgeConfig {
  enabled: boolean;
  custodyAddress?: string;
  chainId: number;
}

/**
 * Fetch bridge configuration (custody address, enabled status).
 */
export async function getBridgeConfig(): Promise<BridgeConfig> {
  const baseUrl = getCoreApiBaseUrl();
  if (!baseUrl) {
    return { enabled: false, chainId: BASE_SEPOLIA_CHAIN_ID };
  }
  const res = await fetch(`${baseUrl}/bridge/config`, {
    headers: getCoreApiHeaders(),
  });
  if (!res.ok) return { enabled: false, chainId: BASE_SEPOLIA_CHAIN_ID };
  const data = await res.json().catch(() => ({}));
  return {
    enabled: data.enabled === true,
    custodyAddress: data.custodyAddress,
    chainId: data.chainId ?? BASE_SEPOLIA_CHAIN_ID,
  };
}

export interface BridgeClaimParams {
  evmTxHash: string;
  evmAddress: string;
  evmSignature: string;
  recipientRougechainPubkey: string;
  token?: "ETH" | "USDC";
}

export interface BridgeClaimResult {
  success: boolean;
  txId?: string;
  error?: string;
}

export interface BridgeWithdrawParams {
  fromPublicKey: string;
  amountUnits: number;
  evmAddress: string;
  fee?: number;
  tokenSymbol?: string;
  signature?: string;
  payload?: Record<string, unknown>;
  /** @deprecated Use signature+payload instead */
  fromPrivateKey?: string;
}

export interface BridgeWithdrawResult {
  success: boolean;
  txId?: string;
  error?: string;
}

/**
 * Bridge out: burn qETH on RougeChain and request ETH release to Base Sepolia.
 * Creates a pending withdrawal for the operator to fulfill.
 */
export async function bridgeWithdraw(params: BridgeWithdrawParams): Promise<BridgeWithdrawResult> {
  const baseUrl = getCoreApiBaseUrl();
  if (!baseUrl) {
    return { success: false, error: "No API configured" };
  }
  const evmAddr = params.evmAddress.startsWith("0x") ? params.evmAddress : `0x${params.evmAddress}`;

  const body: Record<string, unknown> = {
    fromPublicKey: params.fromPublicKey,
    amountUnits: params.amountUnits,
    evmAddress: evmAddr,
    fee: params.fee,
  };

  if (params.signature && params.payload) {
    body.signature = params.signature;
    body.payload = params.payload;
  } else if (params.fromPrivateKey) {
    body.fromPrivateKey = params.fromPrivateKey;
  }

  if (params.tokenSymbol) {
    body.payload = { ...(body.payload as Record<string, unknown> || {}), tokenSymbol: params.tokenSymbol };
  }

  const res = await fetch(`${baseUrl}/bridge/withdraw`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return {
    success: data.success === true,
    txId: data.txId,
    error: data.error,
  };
}

/**
 * Claim qETH on RougeChain after depositing ETH on Base Sepolia.
 * Verifies the EVM tx and mints qETH to the recipient.
 */
export async function claimBridgeDeposit(params: BridgeClaimParams): Promise<BridgeClaimResult> {
  const baseUrl = getCoreApiBaseUrl();
  if (!baseUrl) {
    return { success: false, error: "No API configured" };
  }
  const res = await fetch(`${baseUrl}/bridge/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
    body: JSON.stringify({
      evmTxHash: params.evmTxHash.startsWith("0x") ? params.evmTxHash : `0x${params.evmTxHash}`,
      evmAddress: params.evmAddress.startsWith("0x") ? params.evmAddress : `0x${params.evmAddress}`,
      evmSignature: params.evmSignature,
      recipientRougechainPubkey: params.recipientRougechainPubkey,
      token: params.token || "ETH",
    }),
  });
  const data = await res.json().catch(() => ({}));
  return {
    success: data.success === true,
    txId: data.txId,
    error: data.error,
  };
}

/** USDC on Base Sepolia (Circle's testnet USDC) */
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

// ============================================================
// XRGE Bridge (Base ↔ RougeChain L1 via BridgeVault)
// ============================================================

/** Real XRGE on Base mainnet */
export const XRGE_TOKEN_ADDRESS = "0x147120faEC9277ec02d957584CFCD92B56A24317";

/** Minimal ERC-20 ABI for approve + balanceOf */
export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
] as const;

/** BridgeVault ABI (only the functions we call) */
export const BRIDGE_VAULT_ABI = [
  "function deposit(uint256 amount, string rougechainPubkey) external",
  "function release(address to, uint256 amount, string l1TxId) external",
  "function totalLocked() external view returns (uint256)",
  "function vaultBalance() external view returns (uint256)",
  "function xrgeToken() external view returns (address)",
  "event BridgeDeposit(address indexed sender, uint256 amount, string rougechainPubkey, uint256 nonce)",
  "event BridgeRelease(address indexed recipient, uint256 amount, string l1TxId)",
] as const;

export interface XrgeBridgeConfig {
  enabled: boolean;
  vaultAddress?: string;
  tokenAddress?: string;
  chainId: number;
}

/**
 * Fetch XRGE bridge configuration from the L1 node.
 */
export async function getXrgeBridgeConfig(): Promise<XrgeBridgeConfig> {
  const baseUrl = getCoreApiBaseUrl();
  if (!baseUrl) {
    return { enabled: false, chainId: BASE_SEPOLIA_CHAIN_ID };
  }
  try {
    const res = await fetch(`${baseUrl}/bridge/xrge/config`, {
      headers: getCoreApiHeaders(),
    });
    if (!res.ok) return { enabled: false, chainId: BASE_SEPOLIA_CHAIN_ID };
    const data = await res.json().catch(() => ({}));
    return {
      enabled: data.enabled === true,
      vaultAddress: data.vaultAddress,
      tokenAddress: data.tokenAddress || XRGE_TOKEN_ADDRESS,
      chainId: data.chainId ?? BASE_SEPOLIA_CHAIN_ID,
    };
  } catch {
    return { enabled: false, chainId: BASE_SEPOLIA_CHAIN_ID };
  }
}

export interface XrgeBridgeDepositParams {
  /** EVM tx hash of the vault deposit */
  evmTxHash: string;
  /** User's EVM address */
  evmAddress: string;
  /** Amount deposited (raw 18-decimal units as string) */
  amount: string;
  /** Recipient's RougeChain L1 public key */
  recipientRougechainPubkey: string;
}

/**
 * After depositing XRGE into the vault on Base, call this to notify
 * the L1 node which will credit XRGE to the recipient's L1 wallet.
 */
export async function claimXrgeBridgeDeposit(
  params: XrgeBridgeDepositParams
): Promise<BridgeClaimResult> {
  const baseUrl = getCoreApiBaseUrl();
  if (!baseUrl) {
    return { success: false, error: "No API configured" };
  }
  const res = await fetch(`${baseUrl}/bridge/xrge/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
    body: JSON.stringify({
      evmTxHash: params.evmTxHash.startsWith("0x") ? params.evmTxHash : `0x${params.evmTxHash}`,
      evmAddress: params.evmAddress.startsWith("0x") ? params.evmAddress : `0x${params.evmAddress}`,
      amount: params.amount,
      recipientRougechainPubkey: params.recipientRougechainPubkey,
    }),
  });
  const data = await res.json().catch(() => ({}));
  return {
    success: data.success === true,
    txId: data.txId,
    error: data.error,
  };
}

export interface XrgeBridgeWithdrawParams {
  /** Signer public key on L1 */
  fromPublicKey: string;
  /** Amount to bridge out (in L1 XRGE units) */
  amount: number;
  /** Destination EVM address on Base */
  evmAddress: string;
  signature?: string;
  payload?: Record<string, unknown>;
  /** @deprecated Use signature+payload instead */
  fromPrivateKey?: string;
}

/**
 * Burn XRGE on L1 and request the relayer to release from the vault on Base.
 */
export async function bridgeWithdrawXrge(
  params: XrgeBridgeWithdrawParams
): Promise<BridgeWithdrawResult> {
  const baseUrl = getCoreApiBaseUrl();
  if (!baseUrl) {
    return { success: false, error: "No API configured" };
  }
  const body: Record<string, unknown> = {
    fromPublicKey: params.fromPublicKey,
    amount: params.amount,
    evmAddress: params.evmAddress.startsWith("0x") ? params.evmAddress : `0x${params.evmAddress}`,
  };
  if (params.signature && params.payload) {
    body.signature = params.signature;
    body.payload = params.payload;
  } else if (params.fromPrivateKey) {
    body.fromPrivateKey = params.fromPrivateKey;
  }
  const res = await fetch(`${baseUrl}/bridge/xrge/withdraw`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return {
    success: data.success === true,
    txId: data.txId,
    error: data.error,
  };
}

