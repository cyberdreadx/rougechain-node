/**
 * Extension/dApp browser bridge for RougeChain wallet provider
 *
 * When a wallet is connected via browser extension or Qwalla's dApp browser,
 * the private key stays in the extension/app. This module routes signing
 * requests through window.rougechain instead of local signing.
 */

import {
  type TransactionPayload,
  type SignedTransaction,
  serializePayload,
} from "./pqc-signer";

interface RougeChainProvider {
  isRougeChain: boolean;
  connect(): Promise<{
    publicKey: string;
    displayName?: string;
    encryptionPublicKey?: string;
  }>;
  getBalance(): Promise<unknown>;
  signTransaction(params: unknown): Promise<{
    signature: string;
    signedPayload?: string;
  }>;
  sendTransaction(params: unknown): Promise<unknown>;
  on?(event: string, callback: (...args: unknown[]) => void): void;
  removeListener?(event: string, callback: (...args: unknown[]) => void): void;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function getRougeChainProvider(): RougeChainProvider | null {
  const provider = (window as any).rougechain;
  return provider?.isRougeChain ? (provider as RougeChainProvider) : null;
}

/**
 * Sign a transaction payload via the extension/dApp browser provider.
 * Sends pre-serialized bytes so the signature matches the node's expected format.
 */
export async function signViaExtension(
  payload: TransactionPayload,
  publicKey: string
): Promise<SignedTransaction> {
  const provider = getRougeChainProvider();
  if (!provider) {
    throw new Error("RougeChain wallet extension not available");
  }

  const serialized = serializePayload(payload);
  const serializedHex = bytesToHex(serialized);

  const result = await provider.signTransaction({ payload, serializedHex });

  if (!result?.signature) {
    throw new Error("Extension did not return a signature");
  }

  return {
    payload,
    signature: result.signature,
    public_key: publicKey,
    payload_bytes_hex: serializedHex,
  };
}
