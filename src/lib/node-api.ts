// Node API client for RougeChain L1
// This connects to the public node daemon API

const NODE_API_URL = import.meta.env.VITE_NODE_API_URL || "http://localhost:5100/api";

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
  const res = await fetch(`${NODE_API_URL}/wallet/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    throw new Error(`Failed to create wallet: ${res.statusText}`);
  }

  const data = await res.json() as { success: boolean; publicKey: string; privateKey: string; algorithm: string };
  if (!data.success) {
    throw new Error("Failed to create wallet");
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
  const res = await fetch(`${NODE_API_URL}/tx/submit`, {
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
  const res = await fetch(`${NODE_API_URL}/balance/${publicKey}`);
  
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
  const res = await fetch(`${NODE_API_URL}/stats`);
  if (!res.ok) {
    throw new Error("Failed to fetch node stats");
  }
  return res.json();
}
