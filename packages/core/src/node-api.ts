// Node API client for RougeChain L1
// This connects to the Rust core node API
import { getCoreApiBaseUrl, getCoreApiHeaders } from "./network";

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
  const apiBase = getCoreApiBaseUrl();
  if (!apiBase) {
    throw new Error("Mainnet API is not configured");
  }
  const res = await fetch(`${apiBase}/wallet/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
  });

  if (!res.ok) {
    throw new Error(`Failed to create wallet: ${res.status} ${res.statusText}`);
  }

  let data: { success?: boolean; publicKey?: string; privateKey?: string; algorithm?: string; error?: string } | null = null;
  const rawText = await res.text();
  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch (jsonError) {
    throw new Error(`Invalid JSON response from wallet API: ${rawText.slice(0, 120)}`);
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
  const apiBase = getCoreApiBaseUrl();
  if (!apiBase) {
    throw new Error("Mainnet API is not configured");
  }
  const res = await fetch(`${apiBase}/tx/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getCoreApiHeaders() },
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
  const apiBase = getCoreApiBaseUrl();
  if (!apiBase) {
    return 0;
  }
  const res = await fetch(`${apiBase}/balance/${publicKey}`, {
    headers: getCoreApiHeaders(),
  });
  
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
  const apiBase = getCoreApiBaseUrl();
  if (!apiBase) {
    throw new Error("Mainnet API is not configured");
  }
  const res = await fetch(`${apiBase}/stats`, {
    headers: getCoreApiHeaders(),
  });
  if (!res.ok) {
    throw new Error("Failed to fetch node stats");
  }
  return res.json();
}
