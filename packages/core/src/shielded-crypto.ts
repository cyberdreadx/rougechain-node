/**
 * Client-side shielded transaction crypto using Web Crypto API.
 * 
 * Mirrors the Rust commitment.rs:
 *   commitment = SHA-256("ROUGECHAIN_COMMITMENT_V1" || value_u64_be || pubkey || randomness)
 *   nullifier  = SHA-256("ROUGECHAIN_NULLIFIER_V1"  || randomness || commitment)
 */

const COMMITMENT_DOMAIN = new TextEncoder().encode("ROUGECHAIN_COMMITMENT_V1");
const NULLIFIER_DOMAIN = new TextEncoder().encode("ROUGECHAIN_NULLIFIER_V1");

function hexToU8(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function u8ToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function u64ToBytes(value: number): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, BigInt(value), false);
  return buf;
}

export function generateRandomness(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return u8ToHex(buf);
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest("SHA-256", data.buffer as ArrayBuffer);
  return new Uint8Array(hash);
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

export async function computeCommitment(
  value: number,
  ownerPubKey: string,
  randomness: string
): Promise<string> {
  const input = concat(COMMITMENT_DOMAIN, u64ToBytes(value), hexToU8(ownerPubKey), hexToU8(randomness));
  const hash = await sha256(input);
  return u8ToHex(hash);
}

export async function computeNullifier(
  randomness: string,
  commitment: string
): Promise<string> {
  const input = concat(NULLIFIER_DOMAIN, hexToU8(randomness), hexToU8(commitment));
  const hash = await sha256(input);
  return u8ToHex(hash);
}

export interface ShieldedNote {
  commitment: string;
  nullifier: string;
  value: number;
  randomness: string;
  ownerPubKey: string;
}

export async function createShieldedNote(
  value: number,
  ownerPubKey: string
): Promise<ShieldedNote> {
  const randomness = generateRandomness();
  const commitment = await computeCommitment(value, ownerPubKey, randomness);
  const nullifier = await computeNullifier(randomness, commitment);
  return { commitment, nullifier, value, randomness, ownerPubKey };
}
