/**
 * Client-side shielded transaction crypto primitives.
 *
 * Mirrors the Rust commitment.rs exactly:
 *   commitment = SHA-256("ROUGECHAIN_COMMITMENT_V1" || value || pubkey || randomness)
 *   nullifier  = SHA-256("ROUGECHAIN_NULLIFIER_V1"  || randomness || commitment)
 */

import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "./utils.js";

const COMMITMENT_DOMAIN = new TextEncoder().encode("ROUGECHAIN_COMMITMENT_V1");
const NULLIFIER_DOMAIN = new TextEncoder().encode("ROUGECHAIN_NULLIFIER_V1");

/** Generate 32 bytes of cryptographically secure randomness (hex-encoded). */
export function generateRandomness(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

/** Encode a u64 value as 8 big-endian bytes. */
function u64ToBytes(value: number): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  // JS numbers are safe up to 2^53, sufficient for XRGE amounts
  view.setBigUint64(0, BigInt(value), false); // big-endian
  return buf;
}

/** Decode a hex string to Uint8Array. */
function hexToU8(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Compute a shielded note commitment.
 *
 * @param value       - Note value in XRGE (integer)
 * @param ownerPubKey - Owner's ML-DSA-65 public key (hex)
 * @param randomness  - 32-byte blinding factor (hex)
 * @returns 32-byte commitment hash (hex)
 */
export function computeCommitment(
  value: number,
  ownerPubKey: string,
  randomness: string
): string {
  const valueBytes = u64ToBytes(value);
  const pubkeyBytes = hexToU8(ownerPubKey);
  const randBytes = hexToU8(randomness);

  // Concatenate: domain || value || pubkey || randomness
  const input = new Uint8Array(
    COMMITMENT_DOMAIN.length + valueBytes.length + pubkeyBytes.length + randBytes.length
  );
  let offset = 0;
  input.set(COMMITMENT_DOMAIN, offset); offset += COMMITMENT_DOMAIN.length;
  input.set(valueBytes, offset);        offset += valueBytes.length;
  input.set(pubkeyBytes, offset);       offset += pubkeyBytes.length;
  input.set(randBytes, offset);

  return bytesToHex(sha256(input));
}

/**
 * Compute a nullifier for a shielded note.
 *
 * @param randomness - The note's blinding factor (hex)
 * @param commitment - The note's commitment hash (hex)
 * @returns 32-byte nullifier hash (hex)
 */
export function computeNullifier(
  randomness: string,
  commitment: string
): string {
  const randBytes = hexToU8(randomness);
  const commitBytes = hexToU8(commitment);

  const input = new Uint8Array(
    NULLIFIER_DOMAIN.length + randBytes.length + commitBytes.length
  );
  let offset = 0;
  input.set(NULLIFIER_DOMAIN, offset); offset += NULLIFIER_DOMAIN.length;
  input.set(randBytes, offset);        offset += randBytes.length;
  input.set(commitBytes, offset);

  return bytesToHex(sha256(input));
}

/** A shielded note — kept locally by the owner (never sent to chain). */
export interface ShieldedNote {
  commitment: string;
  nullifier: string;
  value: number;
  randomness: string;
  ownerPubKey: string;
}

/**
 * Create a new shielded note for a given value.
 *
 * @param value       - XRGE amount (integer)
 * @param ownerPubKey - Owner's public key (hex)
 * @returns A ShieldedNote with all derived fields
 */
export function createShieldedNote(
  value: number,
  ownerPubKey: string
): ShieldedNote {
  const randomness = generateRandomness();
  const commitment = computeCommitment(value, ownerPubKey, randomness);
  const nullifier = computeNullifier(randomness, commitment);
  return { commitment, nullifier, value, randomness, ownerPubKey };
}
