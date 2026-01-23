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
  return new Uint8Array(Buffer.from(hex, "hex"));
}

