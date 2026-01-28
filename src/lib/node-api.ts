// Node API client for RougeChain L1
// This connects to the public node daemon API
import { getNodeApiBaseUrl } from "./network";

export interface NodeWallet {
  publicKey: string;
  privateKey: string;
  algorithm: string;
}

export interface NodeTxResponse {
  success: boolean;
  txId?: string;
  tx?: unknown;
  error?: string;
}

export interface NodeBalance {
  success: boolean;
  balance: number;
}

/**
 * Create a new wallet using the node API
 * Note: In production, generate keys client-side instead!
 */
export async function createWalletViaNode(): Promise<NodeWallet> {
  const apiBase = getNodeApiBaseUrl();
  if (!apiBase) {
    throw new Error("Mainnet API is not configured");
  }
  const res = await fetch(`${apiBase}/wallet/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    throw new Error(`Failed to create wallet: ${res.status} ${res.statusText}`);
  }

  let data: { success?: boolean; publicKey?: string; privateKey?: string; algorithm?: string; error?: string } | null = null;
  try {
    data = await res.json();
  } catch (jsonError) {
    const text = await res.text();
    throw new Error(`Invalid JSON response from wallet API: ${text.slice(0, 120)}`);
  }

  if (!data?.success) {
    throw new Error(data?.error || "Failed to create wallet");
  }

  if (!data.publicKey || !data.privateKey) {
    throw new Error("Wallet API response missing keys");
  }

  return {
    publicKey: data.publicKey,
    privateKey: data.privateKey,
    algorithm: data.algorithm,
  };
}

/**
 * Submit a transaction via the node API
 */
export async function submitTransactionViaNode(
  fromPrivateKey: string,
  fromPublicKey: string,
  toPublicKey: string,
  amount: number,
  fee?: number
): Promise<NodeTxResponse> {
  const apiBase = getNodeApiBaseUrl();
  if (!apiBase) {
    throw new Error("Mainnet API is not configured");
  }
  const res = await fetch(`${apiBase}/tx/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fromPrivateKey,
      fromPublicKey,
      toPublicKey,
      amount,
      fee: fee ?? 0.1,
    }),
  });

  const data = await res.json() as NodeTxResponse;
  return data;
}

/**
 * Get balance for a public key
 */
export async function getBalanceViaNode(publicKey: string): Promise<number> {
  const apiBase = getNodeApiBaseUrl();
  if (!apiBase) {
    return 0;
  }
  const res = await fetch(`${apiBase}/balance/${publicKey}`);
  
  if (!res.ok) {
    return 0; // Return 0 if error (account doesn't exist yet)
  }

  const data = await res.json() as NodeBalance;
  return data.balance ?? 0;
}

/**
 * Get node stats
 */
export async function getNodeStats() {
  const apiBase = getNodeApiBaseUrl();
  if (!apiBase) {
    throw new Error("Mainnet API is not configured");
  }
  const res = await fetch(`${apiBase}/stats`);
  if (!res.ok) {
    throw new Error("Failed to fetch node stats");
  }
  return res.json();
}
