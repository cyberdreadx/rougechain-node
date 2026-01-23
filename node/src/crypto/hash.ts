import { createHash } from "node:crypto";

export function sha256(data: Uint8Array): Uint8Array {
  const h = createHash("sha256");
  h.update(data);
  return new Uint8Array(h.digest());
}

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function hexToBytes(hex: string): Uint8Array {
  const buffer = Buffer.from(hex, "hex");
  // Create a completely isolated Uint8Array with its own ArrayBuffer
  // This ensures no shared buffer issues that could cause the ML-DSA library
  // to read beyond the intended data
  const isolated = new Uint8Array(buffer.length);
  isolated.set(buffer);
  return isolated;
}

