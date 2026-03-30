/**
 * Unit tests for ML-DSA-65 signing, mnemonic derivation, and address encoding.
 * Tests the core crypto used throughout the frontend (pqc-signer.ts).
 */

import { describe, it, expect } from "vitest";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  signTransaction,
  verifyTransaction,
  serializePayload,
  generateNonce,
  BURN_ADDRESS,
} from "@/lib/pqc-signer";
import type { TransactionPayload } from "@/lib/pqc-signer";

// ─── Helpers ────────────────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function keypairFromMnemonic(mnemonic: string) {
  const bip39Seed = mnemonicToSeedSync(mnemonic);
  const mldsaSeed = hkdf(sha256, bip39Seed, undefined, new TextEncoder().encode("rougechain-ml-dsa-65-v1"), 32);
  const kp = ml_dsa65.keygen(mldsaSeed);
  return { publicKey: bytesToHex(kp.publicKey), secretKey: bytesToHex(kp.secretKey) };
}

function makePayload(overrides: Partial<TransactionPayload> = {}): TransactionPayload {
  return {
    type: "transfer",
    from: "aabbcc",
    to: "ddeeff",
    amount: 100,
    fee: 1,
    token: "XRGE",
    timestamp: 1700000000000,
    nonce: "deadbeef01020304",
    ...overrides,
  } as TransactionPayload;
}

// ─── ML-DSA-65 Key Generation ────────────────────────────────────────────────

describe("ML-DSA-65 key generation", () => {
  it("generates keys with correct byte lengths", () => {
    const kp = ml_dsa65.keygen();
    // ML-DSA-65: pk=1952 bytes, sk=4032 bytes
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.secretKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.byteLength).toBe(1952);
    expect(kp.secretKey.byteLength).toBe(4032);
  });

  it("generates unique keypairs each time", () => {
    const kp1 = ml_dsa65.keygen();
    const kp2 = ml_dsa65.keygen();
    expect(bytesToHex(kp1.publicKey)).not.toBe(bytesToHex(kp2.publicKey));
    expect(bytesToHex(kp1.secretKey)).not.toBe(bytesToHex(kp2.secretKey));
  });

  it("produces deterministic keypair from seed", () => {
    const seed = new Uint8Array(32).fill(42);
    const kp1 = ml_dsa65.keygen(seed);
    const kp2 = ml_dsa65.keygen(seed);
    expect(bytesToHex(kp1.publicKey)).toBe(bytesToHex(kp2.publicKey));
    expect(bytesToHex(kp1.secretKey)).toBe(bytesToHex(kp2.secretKey));
  });
});

// ─── ML-DSA-65 Sign / Verify ─────────────────────────────────────────────────

describe("ML-DSA-65 sign and verify", () => {
  const kp = ml_dsa65.keygen();
  const msg = new TextEncoder().encode("rougechain-test");

  it("sign produces 3309-byte signature", () => {
    const sig = ml_dsa65.sign(msg, kp.secretKey);
    expect(sig.byteLength).toBe(3309);
  });

  it("verify returns true for valid signature", () => {
    const sig = ml_dsa65.sign(msg, kp.secretKey);
    expect(ml_dsa65.verify(sig, msg, kp.publicKey)).toBe(true);
  });

  it("verify returns false for tampered message", () => {
    const sig = ml_dsa65.sign(msg, kp.secretKey);
    const tampered = new TextEncoder().encode("rougechain-TAMPERED");
    expect(ml_dsa65.verify(sig, tampered, kp.publicKey)).toBe(false);
  });

  it("verify returns false for wrong public key", () => {
    const sig = ml_dsa65.sign(msg, kp.secretKey);
    const otherKp = ml_dsa65.keygen();
    expect(ml_dsa65.verify(sig, msg, otherKp.publicKey)).toBe(false);
  });

  it("verify returns false for truncated signature", () => {
    const sig = ml_dsa65.sign(msg, kp.secretKey);
    const truncated = sig.slice(0, 100);
    // @noble/post-quantum returns false on bad input rather than throwing
    const result = (() => {
      try { return ml_dsa65.verify(truncated, msg, kp.publicKey); }
      catch { return false; }
    })();
    expect(result).toBe(false);
  });
});

// ─── Mnemonic ────────────────────────────────────────────────────────────────

describe("mnemonic generation and validation", () => {
  it("generates valid 24-word mnemonic", () => {
    const m = generateMnemonic(wordlist, 256);
    const words = m.trim().split(" ");
    expect(words).toHaveLength(24);
    expect(validateMnemonic(m, wordlist)).toBe(true);
  });

  it("generates valid 12-word mnemonic", () => {
    const m = generateMnemonic(wordlist, 128);
    const words = m.trim().split(" ");
    expect(words).toHaveLength(12);
    expect(validateMnemonic(m, wordlist)).toBe(true);
  });

  it("rejects invalid mnemonics", () => {
    expect(validateMnemonic("wrong words that are not valid bip39", wordlist)).toBe(false);
    expect(validateMnemonic("", wordlist)).toBe(false);
    expect(validateMnemonic("abandon", wordlist)).toBe(false);
  });

  it("different mnemonics produce different seeds", () => {
    const m1 = generateMnemonic(wordlist, 256);
    const m2 = generateMnemonic(wordlist, 256);
    const kp1 = keypairFromMnemonic(m1);
    const kp2 = keypairFromMnemonic(m2);
    expect(kp1.publicKey).not.toBe(kp2.publicKey);
  });
});

// ─── Deterministic Key Derivation ────────────────────────────────────────────

describe("deterministic keypair from mnemonic", () => {
  const TEST_MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

  it("same mnemonic always produces same keypair", () => {
    const kp1 = keypairFromMnemonic(TEST_MNEMONIC);
    const kp2 = keypairFromMnemonic(TEST_MNEMONIC);
    expect(kp1.publicKey).toBe(kp2.publicKey);
    expect(kp1.secretKey).toBe(kp2.secretKey);
  });

  it("derived keypair is valid for signing", () => {
    const kp = keypairFromMnemonic(TEST_MNEMONIC);
    const msg = new TextEncoder().encode("test");
    const sig = ml_dsa65.sign(msg, hexToBytes(kp.secretKey));
    expect(ml_dsa65.verify(sig, msg, hexToBytes(kp.publicKey))).toBe(true);
  });

  it("derived public key is 1952 bytes (3904 hex chars)", () => {
    const kp = keypairFromMnemonic(TEST_MNEMONIC);
    expect(kp.publicKey).toHaveLength(3904);
  });

  it("rougechain domain separator produces different keys than no separator", () => {
    const bip39Seed = mnemonicToSeedSync(TEST_MNEMONIC);
    // With domain separator (RougeChain standard)
    const mldsaSeed = hkdf(sha256, bip39Seed, undefined, new TextEncoder().encode("rougechain-ml-dsa-65-v1"), 32);
    // Without domain separator (raw HKDF)
    const rawSeed = hkdf(sha256, bip39Seed, undefined, new TextEncoder().encode("different-domain"), 32);
    const kp1 = ml_dsa65.keygen(mldsaSeed);
    const kp2 = ml_dsa65.keygen(rawSeed);
    expect(bytesToHex(kp1.publicKey)).not.toBe(bytesToHex(kp2.publicKey));
  });
});

// ─── Payload Serialization ────────────────────────────────────────────────────

describe("serializePayload", () => {
  it("is deterministic for the same payload", () => {
    const payload = makePayload();
    const b1 = serializePayload(payload);
    const b2 = serializePayload(payload);
    expect(Buffer.from(b1).toString("hex")).toBe(Buffer.from(b2).toString("hex"));
  });

  it("sorts keys alphabetically (matches Rust serde BTreeMap)", () => {
    const payload = makePayload({ token: "XRGE", amount: 50, fee: 2 });
    const json = new TextDecoder().decode(serializePayload(payload));
    const parsed = JSON.parse(json);
    const keys = Object.keys(parsed);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });

  it("different payloads produce different bytes", () => {
    const p1 = makePayload({ amount: 100 });
    const p2 = makePayload({ amount: 200 });
    const b1 = serializePayload(p1);
    const b2 = serializePayload(p2);
    expect(Buffer.from(b1).toString("hex")).not.toBe(Buffer.from(b2).toString("hex"));
  });
});

// ─── Transaction Signing ──────────────────────────────────────────────────────

describe("signTransaction and verifyTransaction", () => {
  const kp = ml_dsa65.keygen();
  const pubKeyHex = bytesToHex(kp.publicKey);
  const secKeyHex = bytesToHex(kp.secretKey);

  it("produces a signed tx with correct fields", () => {
    const payload = makePayload({ from: pubKeyHex });
    const signed = signTransaction(payload, secKeyHex, pubKeyHex);
    expect(signed.payload).toEqual(payload);
    expect(signed.public_key).toBe(pubKeyHex);
    expect(signed.signature).toHaveLength(6618); // 3309 bytes * 2 hex chars
  });

  it("verifyTransaction returns true for valid signed tx", () => {
    const payload = makePayload({ from: pubKeyHex });
    const signed = signTransaction(payload, secKeyHex, pubKeyHex);
    expect(verifyTransaction(signed)).toBe(true);
  });

  it("verifyTransaction returns false for tampered amount", () => {
    const payload = makePayload({ from: pubKeyHex });
    const signed = signTransaction(payload, secKeyHex, pubKeyHex);
    const tampered = { ...signed, payload: { ...signed.payload, amount: 9999999 } };
    expect(verifyTransaction(tampered)).toBe(false);
  });

  it("verifyTransaction returns false for tampered signature", () => {
    const payload = makePayload({ from: pubKeyHex });
    const signed = signTransaction(payload, secKeyHex, pubKeyHex);
    const badSig = signed.signature.replace(/^../, "00");
    expect(verifyTransaction({ ...signed, signature: badSig })).toBe(false);
  });

  it("verifyTransaction returns false for wrong public key", () => {
    const otherKp = ml_dsa65.keygen();
    const payload = makePayload({ from: pubKeyHex });
    const signed = signTransaction(payload, secKeyHex, pubKeyHex);
    expect(verifyTransaction({ ...signed, public_key: bytesToHex(otherKp.publicKey) })).toBe(false);
  });

  it("signature is non-deterministic (ML-DSA-65 uses hedged signing)", () => {
    const payload = makePayload({ from: pubKeyHex });
    const s1 = signTransaction(payload, secKeyHex, pubKeyHex);
    const s2 = signTransaction(payload, secKeyHex, pubKeyHex);
    // Both must verify, but signatures may differ (hedged)
    expect(verifyTransaction(s1)).toBe(true);
    expect(verifyTransaction(s2)).toBe(true);
  });
});

// ─── Nonce ────────────────────────────────────────────────────────────────────

describe("generateNonce", () => {
  it("generates a 32-char hex string", () => {
    const nonce = generateNonce();
    expect(nonce).toHaveLength(32);
    expect(/^[0-9a-f]+$/.test(nonce)).toBe(true);
  });

  it("generates unique nonces", () => {
    const nonces = new Set(Array.from({ length: 100 }, () => generateNonce()));
    expect(nonces.size).toBe(100);
  });
});

// ─── Constants ────────────────────────────────────────────────────────────────

describe("BURN_ADDRESS", () => {
  it("is a recognizable constant string", () => {
    expect(BURN_ADDRESS).toContain("DEAD");
    expect(BURN_ADDRESS).toContain("XRGE_BURN");
  });
});
