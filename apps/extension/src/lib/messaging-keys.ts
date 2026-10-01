/**
 * Seed-derived ML-KEM-768 messaging key for NEW / IMPORTED wallets — the exact derivation the
 * website (packages/core/src/messaging-keys.ts) and Qwalla use, imported from @rougechain/core so
 * the three apps cannot drift:
 *
 *   seed    = SHA-512(utf8(`${mnemonic || signingPrivateKeyHex}|rougee-gram|kem-v1`))
 *   keypair = ml_kem768.keygen(seed)
 *
 * One recovery phrase therefore restores the same messaging / mail key in every app.
 *
 * Only creation / import paths use this. A wallet already stored in the vault keeps whatever
 * messaging key it has (older extension wallets have a random one) — never re-derive those.
 */
import { deriveMessagingKeypair, hasMessagingKeys, withDerivedMessagingKeys } from "@rougechain/core/messaging-keys";
import { keypairFromMnemonic, validateMnemonic } from "./mnemonic";
import type { UnifiedWallet } from "./unified-wallet";

export { deriveMessagingKeypair, hasMessagingKeys, withDerivedMessagingKeys };

/** Canonical phrase form used for derivation and storage: trimmed, lower-case, single spaces. */
export function normalizeRecoveryPhrase(phrase: string): string {
    return phrase.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Build a new wallet from a recovery phrase (fresh or imported): ML-DSA-65 signing key from the
 * phrase, messaging key derived from the (normalized) phrase. Throws on an invalid phrase.
 */
export function walletFromMnemonic(phrase: string, displayName: string): UnifiedWallet {
    const mnemonic = normalizeRecoveryPhrase(phrase);
    if (!validateMnemonic(mnemonic)) throw new Error("Invalid mnemonic phrase");
    const { publicKey: signingPublicKey, secretKey: signingPrivateKey } = keypairFromMnemonic(mnemonic);
    const enc = deriveMessagingKeypair(mnemonic, signingPrivateKey);
    return {
        id: crypto.randomUUID(),
        displayName,
        createdAt: Date.now(),
        signingPublicKey,
        signingPrivateKey,
        encryptionPublicKey: enc.publicKey,
        encryptionPrivateKey: enc.privateKey,
        version: 3,
        mnemonic,
    };
}

/**
 * An imported backup (.pqcbackup or plaintext JSON): keep its messaging keys exactly when it has
 * them; only when it lacks them, derive them (from its mnemonic, else its signing private key).
 */
export function prepareImportedWallet(wallet: UnifiedWallet): UnifiedWallet {
    return withDerivedMessagingKeys(wallet);
}
