/**
 * Player-signed contract envelopes for the MCP server.
 *
 * The server pins @rougechain/sdk ^1.3.2, which predates `rc.contracts` (SDK 1.9.0). These
 * builders mirror sdk/src/contracts.ts exactly (same payload fields, same signing via the SDK's
 * `signTransaction`, same `payload_bytes_hex`, same address derivation). Once the server depends
 * on SDK >= 1.9.0, replace them with `createSignedContractCall` / `createSignedContractPublish`.
 */
import { createHash } from "node:crypto";
import { signTransaction, serializePayload, bytesToHex, generateNonce } from "@rougechain/sdk";
import type { WalletKeys } from "@rougechain/sdk";

/** Max gas per call (the node's `DEFAULT_FUEL_LIMIT`). */
export const CONTRACT_MAX_GAS = 10_000_000;
/** XRGE charged per unit of signed gas limit. */
export const CONTRACT_GAS_PRICE_XRGE = 0.000001;
/** Flat XRGE fee for publishing a contract. */
export const CONTRACT_DEPLOY_FEE_XRGE = 10;

const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());

/** Strict base64 decode (whitespace ignored), matching the SDK's `base64ToBytes`. */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, "");
  if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    throw new Error("invalid base64");
  }
  return new Uint8Array(Buffer.from(clean, "base64"));
}

/**
 * `hex(sha256("rougechain/contract/v2" ‖ from ‖ 0x00 ‖ nonce ‖ 0x00 ‖ sha256(wasm))[..20])`
 */
export function predictContractAddress(from: string, nonce: string, wasm: Uint8Array): string {
  const buf = Buffer.concat([
    Buffer.from("rougechain/contract/v2", "utf8"),
    Buffer.from(from, "utf8"),
    Buffer.from([0]),
    Buffer.from(nonce, "utf8"),
    Buffer.from([0]),
    Buffer.from(sha256(wasm)),
  ]);
  return bytesToHex(sha256(new Uint8Array(buf)).slice(0, 20));
}

/** 1.5× the dry run plus headroom, capped at 10M (same rule as the SDK). */
export function suggestGasLimit(gasUsed: number): number {
  return Math.min(Math.ceil(gasUsed * 1.5) + 1000, CONTRACT_MAX_GAS);
}

export function contractCallFee(gasLimit: number): number {
  return gasLimit * CONTRACT_GAS_PRICE_XRGE;
}

export function normAddr(addr: string): string {
  return addr.trim().toLowerCase();
}

function signWithBytes(wallet: WalletKeys, payload: Record<string, unknown>) {
  // The SDK's TransactionPayload type is a closed union in 1.3.2; the signer itself is generic.
  const p = payload as unknown as Parameters<typeof signTransaction>[0];
  const tx = signTransaction(p, wallet.privateKey, wallet.publicKey);
  return { ...tx, payload_bytes_hex: bytesToHex(serializePayload(tx.payload)) };
}

/** Signed `contract_deploy` for `POST /api/v2/contract/publish`. `wasmB64` is base64 bytecode. */
export function createSignedContractPublish(wallet: WalletKeys, wasmB64: string, nonce?: string) {
  const wasm = wasmB64.replace(/\s+/g, "");
  const bytes = base64ToBytes(wasm);
  const n = nonce ?? generateNonce();
  if (n.length < 8) throw new Error("contract publish nonce must be at least 8 characters");
  const payload = {
    type: "contract_deploy",
    from: wallet.publicKey,
    wasm,
    timestamp: Date.now(),
    nonce: n,
  };
  return {
    signed: signWithBytes(wallet, payload),
    predictedAddress: predictContractAddress(wallet.publicKey, n, bytes),
    nonce: n,
  };
}

/** Signed `contract_call` for `POST /api/v2/contract/execute`. */
export function createSignedContractCall(
  wallet: WalletKeys,
  contractAddr: string,
  method: string,
  args: unknown,
  gasLimit: number,
  accountNonce?: number
) {
  if (!Number.isInteger(gasLimit) || gasLimit < 1 || gasLimit > CONTRACT_MAX_GAS) {
    throw new Error(`gasLimit must be an integer between 1 and ${CONTRACT_MAX_GAS}`);
  }
  const payload: Record<string, unknown> = {
    type: "contract_call",
    from: wallet.publicKey,
    contractAddr: normAddr(contractAddr),
    method,
    args: args === undefined ? {} : args,
    gasLimit,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };
  if (accountNonce !== undefined) payload.account_nonce = accountNonce;
  return signWithBytes(wallet, payload);
}
