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
}

export interface BridgeClaimResult {
  success: boolean;
  txId?: string;
  error?: string;
}

export interface BridgeWithdrawParams {
  fromPrivateKey: string;
  fromPublicKey: string;
  amountUnits: number;
  evmAddress: string;
  fee?: number;
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
  const res = await fetch(`${baseUrl}/bridge/withdraw`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
    body: JSON.stringify({
      fromPrivateKey: params.fromPrivateKey,
      fromPublicKey: params.fromPublicKey,
      amountUnits: params.amountUnits,
      evmAddress: params.evmAddress.startsWith("0x") ? params.evmAddress : `0x${params.evmAddress}`,
      fee: params.fee,
    }),
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
    }),
  });
  const data = await res.json().catch(() => ({}));
  return {
    success: data.success === true,
    txId: data.txId,
    error: data.error,
  };
}
