/**
 * Seed-derived messaging key — cross-app vector. The expected hashes below were produced by running
 * Qwalla's OWN code (origin/master packages/qwalla-core/pq/rougee-kem.ts `deriveRougeeKem` +
 * `Wallet.fromMnemonic` from @rougechain/sdk 1.6.0, with Qwalla's installed node_modules), not by
 * this implementation. If any of these drift, the website and Qwalla no longer agree on the
 * messaging key (or address) a recovery phrase restores.
 */
import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { deriveMessagingKeypair, hasMessagingKeys, withDerivedMessagingKeys } from "../src/messaging-keys";
import { keypairFromMnemonic } from "../src/mnemonic";
import { pubkeyToAddress } from "../src/address";

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const sha = (s: string) => hex(sha256(new TextEncoder().encode(s)));

const PHRASE_A =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon " +
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
const PHRASE_B =
  "rather supply certain amount amused sentence negative muscle grab clip swamp bonus scene melt " +
  "bonus mass drop brother vivid noodle salad stage damage final";

// Computed by Qwalla (see header). sha256 of the lower-case hex strings.
const QWALLA = {
  A: {
    address: "rouge12vdn0rt2zgl8fh4p0f8rkg3k02xlvtgga27sck0y530jmpz54atstu9ss3",
    pubKeySha: "1dd9d7f0a84b0eb92db3c4a2ce7437b55d7f3dc88e05d79b4347b97dc1d5e48d",
    privKeySha: "36dcce4811d8c55c711a627df13f97c53836f87acc7691cb2af9300aaf695896",
    kemPubSha: "247ad31332921ff43fada11b8d3a0f7373b13add2c6e122e81ed89917d79b72a",
    kemSecSha: "aa87c6a3d1b8da10211b8b303ebfc5e299f5724f00f9e7f6708f36b098be9497",
  },
  B: {
    address: "rouge12xj58n0nqfsd63a86p2n0xffk8dfst2klm86g4gjutlxzdew0huq6y9s62",
    pubKeySha: "7e85787c52cb2d8db4877919cd2ea3b9a7a133211606fabb530c03d709e48e55",
    privKeySha: "9827de471563e28b8573c99aaff5f008825e1bc7d750341fa5f2b154b066d3c9",
    kemPubSha: "ce8c44679ff0624d56a1114dcb8639935c8998fe2019f437f5d65369526b19b1",
    kemSecSha: "ecd1372bc518dc7a9dad78130537f97d4982b928d6796da8cccec76bd5ad9d61",
  },
  /** Private-key-only material: deriveRougeeKem(null, <signing private key of PHRASE_A>). */
  C: {
    kemPubSha: "b3a259174a1d5ab2f10d28b9ad4b50b91129705b90b6270045208e16020b2e28",
    kemSecSha: "83aa3a112dea219c184e705e14b23bea57f31ecf9e9d3f2f32b2cc19cd686754",
  },
};

describe("deriveMessagingKeypair — Qwalla cross-app vector", () => {
  for (const [name, phrase] of [["A", PHRASE_A], ["B", PHRASE_B]] as const) {
    it(`phrase ${name}: same signing key, rouge1 address and messaging key as Qwalla`, async () => {
      const { publicKey, secretKey } = keypairFromMnemonic(phrase);
      expect(sha(publicKey)).toBe(QWALLA[name].pubKeySha);
      expect(sha(secretKey)).toBe(QWALLA[name].privKeySha);
      expect(await pubkeyToAddress(publicKey)).toBe(QWALLA[name].address);
      const enc = deriveMessagingKeypair(phrase, secretKey);
      expect(sha(enc.publicKey)).toBe(QWALLA[name].kemPubSha);
      expect(sha(enc.privateKey)).toBe(QWALLA[name].kemSecSha);
    });
  }

  it("private-key-only material matches Qwalla", () => {
    const { secretKey } = keypairFromMnemonic(PHRASE_A);
    for (const m of [null, undefined, ""]) {
      const enc = deriveMessagingKeypair(m, secretKey);
      expect(sha(enc.publicKey)).toBe(QWALLA.C.kemPubSha);
      expect(sha(enc.privateKey)).toBe(QWALLA.C.kemSecSha);
    }
  });
});

describe("deriveMessagingKeypair", () => {
  const { secretKey } = keypairFromMnemonic(PHRASE_A);

  it("is deterministic, prefers the mnemonic, and yields a working ML-KEM-768 pair", () => {
    const a = deriveMessagingKeypair(PHRASE_A, secretKey);
    expect(deriveMessagingKeypair(PHRASE_A, "ignored-when-mnemonic-present")).toEqual(a);
    expect(deriveMessagingKeypair(PHRASE_B, secretKey)).not.toEqual(a);
    expect(a.publicKey).toHaveLength(1184 * 2);
    expect(a.privateKey).toHaveLength(2400 * 2);
    const { cipherText, sharedSecret } = ml_kem768.encapsulate(Uint8Array.from(Buffer.from(a.publicKey, "hex")));
    expect(hex(ml_kem768.decapsulate(cipherText, Uint8Array.from(Buffer.from(a.privateKey, "hex"))))).toBe(hex(sharedSecret));
  });

  it("throws without any material", () => {
    expect(() => deriveMessagingKeypair(null, "")).toThrow();
  });
});

describe("withDerivedMessagingKeys (backup import)", () => {
  const { publicKey, secretKey } = keypairFromMnemonic(PHRASE_A);
  const base = { signingPublicKey: publicKey, signingPrivateKey: secretKey, mnemonic: PHRASE_A };

  it("keeps a backup's existing messaging keys exactly", () => {
    const k = ml_kem768.keygen();
    const w = { ...base, encryptionPublicKey: hex(k.publicKey), encryptionPrivateKey: hex(k.secretKey) };
    expect(hasMessagingKeys(w)).toBe(true);
    expect(withDerivedMessagingKeys(w)).toBe(w);
  });

  it("derives from the mnemonic when the backup lacks messaging keys", () => {
    const w = withDerivedMessagingKeys({ ...base, encryptionPublicKey: "", encryptionPrivateKey: "" });
    expect(sha(w.encryptionPublicKey)).toBe(QWALLA.A.kemPubSha);
  });

  it("derives from the signing key when the backup has no mnemonic either", () => {
    const w = withDerivedMessagingKeys({ ...base, mnemonic: undefined, encryptionPublicKey: "", encryptionPrivateKey: "" });
    expect(sha(w.encryptionPublicKey)).toBe(QWALLA.C.kemPubSha);
  });

  it("leaves a public-key-only (extension) wallet untouched", () => {
    const w = { signingPublicKey: publicKey, signingPrivateKey: "", encryptionPublicKey: "", encryptionPrivateKey: "" };
    expect(withDerivedMessagingKeys(w)).toBe(w);
  });
});
