/**
 * Seed-derived ML-KEM-768 messaging keypair — byte-for-byte the same derivation as the Qwalla
 * wallet (packages/qwalla-core/pq/rougee-kem.ts `deriveRougeeKem`), so restoring from the 24-word
 * recovery phrase restores the messaging / mail key in both apps:
 *
 *   material = mnemonic || signingPrivateKeyHex
 *   seed     = SHA-512(utf8(`${material}|rougee-gram|kem-v1`))   (64 bytes)
 *   keypair  = ml_kem768.keygen(seed)
 *
 * Only creation / import paths use this. A wallet that is already stored keeps whatever messaging
 * key it has (older website wallets have a random one) — never re-derive those.
 */
import { sha512 } from "@noble/hashes/sha2.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";

/** ML-KEM-768 secret key size (FIPS 203), in bytes. */
const ML_KEM768_SECRET_KEY_BYTES = 2400;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Derive the messaging keypair from the wallet's recovery phrase (preferred) or, for a wallet
 * without one, its ML-DSA-65 signing private key (hex). Pass the phrase exactly as stored for the
 * wallet (normalized: trimmed, lower-case, single spaces).
 */
export function deriveMessagingKeypair(
  mnemonic: string | null | undefined,
  signingPrivateKeyHex: string,
): { publicKey: string; privateKey: string } {
  const material = mnemonic || signingPrivateKeyHex;
  if (!material) throw new Error("deriveMessagingKeypair: a mnemonic or signing private key is required");
  const seed = sha512(new TextEncoder().encode(`${material}|rougee-gram|kem-v1`));
  const kp = ml_kem768.keygen(seed);
  return { publicKey: bytesToHex(kp.publicKey), privateKey: bytesToHex(kp.secretKey) };
}

interface MessagingKeyFields {
  signingPrivateKey: string;
  encryptionPublicKey: string;
  encryptionPrivateKey: string;
  mnemonic?: string;
}

/** The wallet carries a usable ML-KEM-768 keypair (same check the vault's key validation uses). */
export function hasMessagingKeys(wallet: Pick<MessagingKeyFields, "encryptionPublicKey" | "encryptionPrivateKey">): boolean {
  return (
    !!wallet.encryptionPublicKey &&
    !!wallet.encryptionPrivateKey &&
    wallet.encryptionPrivateKey.length / 2 === ML_KEM768_SECRET_KEY_BYTES
  );
}

/**
 * For an imported backup: keep its messaging keys exactly when it has them; only when it lacks
 * them (and has a signing private key) fill them in with the seed-derived keypair.
 */
export function withDerivedMessagingKeys<T extends MessagingKeyFields>(wallet: T): T {
  if (hasMessagingKeys(wallet) || !wallet.signingPrivateKey) return wallet;
  const enc = deriveMessagingKeypair(wallet.mnemonic ?? null, wallet.signingPrivateKey);
  return { ...wallet, encryptionPublicKey: enc.publicKey, encryptionPrivateKey: enc.privateKey };
}
