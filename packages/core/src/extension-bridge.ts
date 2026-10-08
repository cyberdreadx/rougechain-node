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
import { pubkeyToAddress } from "./address";
import { verifyNodeChainId, withChainId } from "./chain-id";
import { verifyMessage } from "./message-signing";

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
  /** Extension 1.8.0+ and Qwalla after its next update. Feature-detect before calling. */
  signMessage?(params: { message: string }): Promise<{
    signature: string;
    publicKey: string;
    address: string;
  }>;
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
 * The extension (v1.4.0+) signs exactly these bytes after checking they encode `payload`,
 * and shows a contract-specific approval for `contract_call` / `contract_deploy`.
 */
export async function signViaExtension(
  payload: TransactionPayload,
  publicKey: string
): Promise<SignedTransaction> {
  const provider = getRougeChainProvider();
  if (!provider) {
    throw new Error("RougeChain wallet extension not available");
  }

  // Signatures commit to the network: the payload the wallet signs carries `chainId`, checked
  // once per session against the node, and the wallet refuses a chain id other than its own.
  const chainId = await verifyNodeChainId();
  const bound = withChainId(payload, chainId);
  const serialized = serializePayload(bound);
  const serializedHex = bytesToHex(serialized);

  const result = await provider.signTransaction({ payload: bound, serializedHex });

  if (!result?.signature) {
    throw new Error("Extension did not return a signature");
  }

  return {
    payload: bound,
    signature: result.signature,
    public_key: publicKey,
    payload_bytes_hex: serializedHex,
  };
}

/** A message signed by a wallet: what `verifyMessage` / `verifySignIn` take. */
export interface SignedMessage {
  message: string;
  signature: string;
  publicKey: string;
  address: string;
}

/** True when the connected provider can sign messages (extension 1.8.0+, Qwalla after its next update). */
export function providerSupportsSignMessage(): boolean {
  return typeof getRougeChainProvider()?.signMessage === "function";
}

/**
 * Sign a text message via the extension / dApp browser provider (the wallet asks the user every
 * time). The result is checked before it is returned: it must come from `publicKey` — the wallet
 * this page is connected as — and verify for exactly `message`.
 */
export async function signMessageViaExtension(message: string, publicKey: string): Promise<SignedMessage> {
  const provider = getRougeChainProvider();
  if (!provider) {
    throw new Error("RougeChain wallet extension not available");
  }
  if (typeof provider.signMessage !== "function") {
    throw new Error("This wallet does not support message signing yet. Update the RougeChain wallet extension or Qwalla.");
  }

  const result = await provider.signMessage({ message });
  if (!result?.signature) {
    throw new Error("Extension did not return a signature");
  }
  if (typeof result.publicKey === "string" && result.publicKey.toLowerCase() !== publicKey.toLowerCase()) {
    throw new Error("The wallet signed with a different account than the connected one");
  }
  if (!verifyMessage(publicKey, message, result.signature)) {
    throw new Error("The wallet returned a signature that does not verify for this message");
  }

  return { message, signature: result.signature, publicKey, address: await pubkeyToAddress(publicKey) };
}
