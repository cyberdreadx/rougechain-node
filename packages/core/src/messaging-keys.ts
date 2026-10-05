/**
 * Seed-derived ML-KEM-768 messaging keypair — byte-for-byte the same derivation as the Qwalla
 * wallet (packages/qwalla-core/pq/rougee-kem.ts `deriveRougeeKem`), so restoring from the 24-word
 * recovery phrase restores the messaging / mail key in both apps:
 *
 *   material = mnemonic || signingPrivateKeyHex
 *   seed     = SHA-512(utf8(`${material}|rougee-gram|kem-v1`))   (64 bytes)
 *   keypair  = ml_kem768.keygen(seed)
 *
 * Creation / import paths use this. A stored wallet that has a recovery phrase but an older
 * random messaging key is moved to the derived key at unlock / page load by
 * `migrateToDerivedMessagingKeys`, which keeps the old keypair as a decrypt-only fallback. A
 * wallet without a phrase keeps the key it has.
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
  /** A previous messaging keypair, kept ONLY to open content encrypted to it. Never re-derived, never dropped. */
  legacyEncryptionPublicKey?: string;
  legacyEncryptionPrivateKey?: string;
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

/**
 * A stored wallet that has a recovery phrase but still uses a random messaging key (created
 * before keys were derived from the phrase) moves to the phrase-derived key, the one every client
 * of the wallet can compute. The old keypair is kept as `legacyEncryption*` so everything already
 * encrypted to it still opens. Pure and idempotent: a wallet already on the derived key, already
 * migrated, without a phrase, or without usable keys is returned unchanged (same object).
 */
export function migrateToDerivedMessagingKeys<T extends MessagingKeyFields>(wallet: T): T {
  if (!wallet.mnemonic || !wallet.signingPrivateKey || !hasMessagingKeys(wallet)) return wallet;
  if (wallet.legacyEncryptionPrivateKey) return wallet;
  const derived = deriveMessagingKeypair(wallet.mnemonic, wallet.signingPrivateKey);
  if (derived.publicKey === wallet.encryptionPublicKey) return wallet;
  return {
    ...wallet,
    encryptionPublicKey: derived.publicKey,
    encryptionPrivateKey: derived.privateKey,
    legacyEncryptionPublicKey: wallet.encryptionPublicKey,
    legacyEncryptionPrivateKey: wallet.encryptionPrivateKey,
  };
}
