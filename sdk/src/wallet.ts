import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { bytesToHex, hexToBytes } from "./utils.js";
import type { WalletKeys } from "./types.js";

export class Wallet implements WalletKeys {
  public readonly publicKey: string;
  public readonly privateKey: string;

  private constructor(publicKey: string, privateKey: string) {
    this.publicKey = publicKey;
    this.privateKey = privateKey;
  }

  /**
   * Generate a new ML-DSA-65 keypair.
   * Uses crypto.getRandomValues for secure randomness.
   */
  static generate(): Wallet {
    const keypair = ml_dsa65.keygen();
    return new Wallet(
      bytesToHex(keypair.publicKey),
      bytesToHex(keypair.secretKey)
    );
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
    return { publicKey: this.publicKey, privateKey: this.privateKey };
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
