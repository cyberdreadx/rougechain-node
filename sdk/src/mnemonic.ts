/**
 * BIP-39 Mnemonic Seed Phrase Support for RougeChain
 *
 * Derivation path:
 *   Mnemonic (12/24 words)
 *     → PBKDF2 (standard BIP-39) → 512-bit seed
 *     → HKDF-SHA256(seed, info="rougechain-ml-dsa-65-v1") → 32-byte ML-DSA seed
 *     → ml_dsa65.keygen(seed) → deterministic keypair
 *
 * The domain separator ensures the same mnemonic produces different keys
 * than Ethereum/Solana wallets, preventing cross-chain key reuse.
 */

import { generateMnemonic as _genMnemonic, mnemonicToSeedSync, validateMnemonic as _validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { bytesToHex } from "./utils.js";

/** Domain separator to prevent cross-chain key reuse */
const DOMAIN_INFO = new TextEncoder().encode("rougechain-ml-dsa-65-v1");

/**
 * Generate a new BIP-39 mnemonic phrase.
 * @param strength 128 = 12 words (default), 256 = 24 words
 */
export function generateMnemonic(strength: 128 | 256 = 256): string {
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
 *
 * mnemonic → PBKDF2 → 512-bit BIP-39 seed → HKDF-SHA256 → 32-byte ML-DSA seed
 *
 * @param mnemonic  BIP-39 mnemonic (12 or 24 words)
 * @param passphrase  Optional BIP-39 passphrase (25th word)
 * @returns 32-byte seed suitable for ml_dsa65.keygen()
 */
export function mnemonicToMLDSASeed(mnemonic: string, passphrase?: string): Uint8Array {
  // Standard BIP-39: mnemonic → 512-bit seed via PBKDF2
  const bip39Seed = mnemonicToSeedSync(mnemonic, passphrase);

  // HKDF-SHA256: 512-bit seed → 32-byte ML-DSA seed with domain separation
  return hkdf(sha256, bip39Seed, undefined, DOMAIN_INFO, 32);
}

/**
 * Generate an ML-DSA-65 keypair from a BIP-39 mnemonic.
 *
 * Same mnemonic + passphrase always yields the same keypair.
 *
 * @param mnemonic  BIP-39 mnemonic (12 or 24 words)
 * @param passphrase  Optional BIP-39 passphrase (25th word)
 * @returns { publicKey, secretKey } as hex strings
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
