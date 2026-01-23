import type { BlockHeaderV1, BlockV1, TxV1 } from "./types";
import { sha256, bytesToHex, hexToBytes } from "./crypto/hash";

// Canonical encoding: stable JSON (key-sorted) -> UTF-8 bytes.
// This is NOT what you'd ship long-term (you'd use a binary codec),
// but it is deterministic across nodes for a devnet bootstrap.

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function encodeTxV1(tx: Omit<TxV1, "sig"> & { sig?: string }): Uint8Array {
  // Signature excluded from signed bytes.
  const { sig: _sig, ...unsigned } = tx;
  return utf8(stableStringify(unsigned));
}

export function txId(tx: TxV1): string {
  return bytesToHex(sha256(encodeTxV1(tx)));
}

export function encodeHeaderV1(header: BlockHeaderV1): Uint8Array {
  return utf8(stableStringify(header));
}

export function computeTxHash(txs: TxV1[]): string {
  const bytes = utf8(stableStringify(txs.map((t) => ({ ...t, sig: t.sig })))); // tx bytes include sig for tx list hashing
  return bytesToHex(sha256(bytes));
}

export function computeBlockHash(headerBytes: Uint8Array, proposerSigHex: string): string {
  const sigBytes = hexToBytes(proposerSigHex);
  const combined = new Uint8Array(headerBytes.length + sigBytes.length);
  combined.set(headerBytes, 0);
  combined.set(sigBytes, headerBytes.length);
  return bytesToHex(sha256(combined));
}

export function encodeNetMessage(obj: unknown): string {
  return JSON.stringify(obj);
}

export function decodeNetMessage(line: string): unknown {
  return JSON.parse(line);
}

