import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { bytesToHex, hexToBytes } from "./utils.js";
import { pubkeyToAddress } from "./address.js";
import { keypairFromMnemonic, generateMnemonic, validateMnemonic } from "./mnemonic.js";
import type { WalletKeys } from "./types.js";

export class Wallet implements WalletKeys {
  public readonly publicKey: string;
  public readonly privateKey: string;
  public readonly mnemonic?: string;

  private constructor(publicKey: string, privateKey: string, mnemonic?: string) {
    this.publicKey = publicKey;
    this.privateKey = privateKey;
    this.mnemonic = mnemonic;
  }

  /**
   * Generate a new ML-DSA-65 keypair with a BIP-39 mnemonic.
   * The mnemonic is stored on the wallet for backup/recovery.
   * @param strength 128 = 12 words (default), 256 = 24 words
   */
  static generate(strength: 128 | 256 = 128): Wallet {
    const mnemonic = generateMnemonic(strength);
    const { publicKey, secretKey } = keypairFromMnemonic(mnemonic);
    return new Wallet(publicKey, secretKey, mnemonic);
  }

  /**
   * Generate a wallet using pure random entropy (no mnemonic).
   * Keys cannot be recovered from a seed phrase.
   */
  static generateRandom(): Wallet {
    const keypair = ml_dsa65.keygen();
    return new Wallet(
      bytesToHex(keypair.publicKey),
      bytesToHex(keypair.secretKey)
    );
  }

  /**
   * Restore a wallet from a BIP-39 mnemonic seed phrase.
   * @param mnemonic 12 or 24 word BIP-39 mnemonic
   * @param passphrase Optional BIP-39 passphrase (25th word)
   */
  static fromMnemonic(mnemonic: string, passphrase?: string): Wallet {
    if (!validateMnemonic(mnemonic)) {
      throw new Error("Invalid mnemonic phrase");
    }
    const { publicKey, secretKey } = keypairFromMnemonic(mnemonic, passphrase);
    return new Wallet(publicKey, secretKey, mnemonic);
  }

  /**
   * Restore a wallet from existing hex-encoded keys.
   */
  static fromKeys(publicKey: string, privateKey: string): Wallet {
    return new Wallet(publicKey, privateKey);
  }

  /**
   * Export keys as a plain object (for serialization/storage).
   */
  toJSON(): WalletKeys {
    return {
      publicKey: this.publicKey,
      privateKey: this.privateKey,
      ...(this.mnemonic ? { mnemonic: this.mnemonic } : {}),
    };
  }

  /**
   * Derive the compact Bech32m address from the public key.
   * Returns a ~63-character `rouge1...` string.
   */
  async address(): Promise<string> {
    return pubkeyToAddress(this.publicKey);
  }

  /**
   * Verify that the keypair is valid by signing and verifying a test message.
   */
  verify(): boolean {
    try {
      const msg = new TextEncoder().encode("rougechain-verify");
      const sig = ml_dsa65.sign(msg, hexToBytes(this.privateKey));
      return ml_dsa65.verify(sig, msg, hexToBytes(this.publicKey));
    } catch {
      return false;
    }
  }
}

