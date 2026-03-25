/**
 * BIP-39 Mnemonic Seed Phrase Support for RougeChain
 *
 * Derivation path:
 *   Mnemonic (12/24 words)
 *     → PBKDF2 (standard BIP-39) → 512-bit seed
 *     → HKDF-SHA256(seed, info="rougechain-ml-dsa-65-v1") → 32-byte ML-DSA seed
 *     → ml_dsa65.keygen(seed) → deterministic keypair
 */

import { generateMnemonic as _genMnemonic, mnemonicToSeedSync, validateMnemonic as _validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";

const DOMAIN_INFO = new TextEncoder().encode("rougechain-ml-dsa-65-v1");

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a new BIP-39 mnemonic phrase.
 * @param strength 128 = 12 words (default), 256 = 24 words
 */
export function generateMnemonic(strength: 128 | 256 = 128): string {
  return _genMnemonic(wordlist, strength);
}

/**
 * Validate a BIP-39 mnemonic phrase.
 */
export function validateMnemonic(mnemonic: string): boolean {
  return _validateMnemonic(mnemonic, wordlist);
}

/**
 * Derive a 32-byte ML-DSA-65 seed from a BIP-39 mnemonic.
 */
export function mnemonicToMLDSASeed(mnemonic: string, passphrase?: string): Uint8Array {
  const bip39Seed = mnemonicToSeedSync(mnemonic, passphrase);
  return hkdf(sha256, bip39Seed, undefined, DOMAIN_INFO, 32);
}

/**
 * Generate an ML-DSA-65 keypair from a BIP-39 mnemonic.
 * Same mnemonic + passphrase always yields the same keypair.
 */
export function keypairFromMnemonic(
  mnemonic: string,
  passphrase?: string
): { publicKey: string; secretKey: string } {
  if (!validateMnemonic(mnemonic)) {
    throw new Error("Invalid mnemonic phrase");
  }
  const seed = mnemonicToMLDSASeed(mnemonic, passphrase);
  const keypair = ml_dsa65.keygen(seed);
  return {
    publicKey: bytesToHex(keypair.publicKey),
    secretKey: bytesToHex(keypair.secretKey),
  };
}
