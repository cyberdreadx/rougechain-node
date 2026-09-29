/**
 * Base (EVM) account for the site wallet — one recovery phrase, two chains.
 *
 * The Base / Ethereum-L2 account is derived EXACTLY like Qwalla does it
 * (Qwalla `packages/qwalla-core/wallet/evm-wallet.ts`, `deriveEvmAccount`):
 *
 *   phrase = mnemonic.trim().toLowerCase()
 *   seed   = BIP-39 mnemonicToSeedSync(phrase)            (@scure/bip39, no passphrase)
 *   node   = BIP-32 HDKey.fromMasterSeed(seed)
 *              .derive("m/44'/60'/0'/0/0")                (@scure/bip32, standard Ethereum path)
 *   key    = node.privateKey (secp256k1) → EIP-55 address
 *
 * The browser extension (`browser-extension/src/lib/evm-wallet.ts`) uses the same
 * path, so site, extension and Qwalla all show the same 0x… address.
 *
 * Security:
 *   - The private key is derived on demand, used, and dropped. It is never
 *     returned to UI code, persisted, logged, or sent anywhere — callers only get
 *     the address, or hand us an unsigned tx and receive the signed bytes.
 *   - Only the ADDRESS is memoised (keyed by a SHA-256 of the phrase, so the
 *     cache holds neither the phrase nor the key).
 *   - The mnemonic comes from the unlocked UnifiedWallet; a locked vault has no
 *     mnemonic in memory, so nothing can be derived or signed while locked.
 *   - Wallets without a mnemonic (raw-key imports, extension-connected) have no
 *     Base account: every function here returns null / throws a typed error.
 */
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { HDKey, privateKeyToAccount } from "viem/accounts";
import type { Hex, TransactionSerializableEIP1559 } from "viem";

/** Standard Ethereum BIP-44 path — identical to Qwalla and the browser extension. */
export const BASE_DERIVATION_PATH = "m/44'/60'/0'/0/0";

/** Normalisation Qwalla applies before deriving (trim + lowercase, nothing else). */
export function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().toLowerCase();
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Address cache: sha256(phrase) → address. Never holds a key or the phrase. */
const addressCache = new Map<string, `0x${string}`>();

function cacheKey(phrase: string): string {
  return toHex(sha256(new TextEncoder().encode(phrase)));
}

/**
 * Run `fn` with the derived private key, then wipe the HD node's key material.
 * Internal only — the key never escapes this module.
 */
function withPrivateKey<T>(mnemonic: string, fn: (pk: Hex) => T): T {
  const phrase = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(phrase, wordlist)) throw new NoBaseAccountError();
  const seed = mnemonicToSeedSync(phrase);
  const root = HDKey.fromMasterSeed(seed);
  const node = root.derive(BASE_DERIVATION_PATH);
  try {
    if (!node.privateKey) throw new Error("Failed to derive Base private key");
    return fn(`0x${toHex(node.privateKey)}` as Hex);
  } finally {
    seed.fill(0);
    try { node.wipePrivateData(); root.wipePrivateData(); } catch { /* best effort */ }
  }
}

export class NoBaseAccountError extends Error {
  constructor() {
    super("This wallet has no recovery phrase, so it has no Base account.");
    this.name = "NoBaseAccountError";
  }
}

/** True when the wallet's mnemonic can back a Base account. */
export function hasBaseAccount(mnemonic: string | null | undefined): mnemonic is string {
  return !!mnemonic && validateMnemonic(normalizeMnemonic(mnemonic), wordlist);
}

/**
 * The Base (EVM) address for a recovery phrase — EIP-55 checksummed — or null
 * for wallets without a (valid) mnemonic.
 */
export function deriveBaseAddress(mnemonic: string | null | undefined): `0x${string}` | null {
  if (!hasBaseAccount(mnemonic)) return null;
  const phrase = normalizeMnemonic(mnemonic);
  const key = cacheKey(phrase);
  const hit = addressCache.get(key);
  if (hit) return hit;
  const address = withPrivateKey(phrase, (pk) => privateKeyToAccount(pk).address);
  addressCache.set(key, address);
  return address;
}

/**
 * Sign an EIP-1559 (type-2) transaction with the phrase's Base key.
 * Returns the 0x raw transaction for eth_sendRawTransaction.
 */
export async function signBaseTransaction(
  mnemonic: string,
  tx: Omit<TransactionSerializableEIP1559, "type">,
): Promise<Hex> {
  return withPrivateKey(mnemonic, (pk) => privateKeyToAccount(pk).signTransaction({ ...tx, type: "eip1559" }));
}

/** EIP-191 personal_sign over raw bytes (as MetaMask does for a 0x-hex param). */
export async function signBaseMessage(mnemonic: string, message: Uint8Array): Promise<Hex> {
  return withPrivateKey(mnemonic, (pk) => privateKeyToAccount(pk).signMessage({ message: { raw: message } }));
}
