/**
 * Extension messaging key ↔ website ↔ Qwalla. The expected hashes are the cross-app vectors from
 * packages/core/test/messaging-keys.test.ts (produced by running Qwalla's own code). Here they are
 * checked against the EXTENSION's own signing-key derivation (src/lib/mnemonic.ts) and its
 * create / import builders, so one recovery phrase restores the same rouge1 address and the same
 * messaging key in all three apps.
 */
import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { keypairFromMnemonic } from "../src/lib/mnemonic";
import { pubkeyToAddress } from "../src/lib/address";
import {
    deriveMessagingKeypair,
    normalizeRecoveryPhrase,
    prepareImportedWallet,
    walletFromMnemonic,
} from "../src/lib/messaging-keys";
import type { UnifiedWallet } from "../src/lib/unified-wallet";

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const sha = (s: string) => hex(sha256(new TextEncoder().encode(s)));

const PHRASE_A =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon " +
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
const PHRASE_B =
    "rather supply certain amount amused sentence negative muscle grab clip swamp bonus scene melt " +
    "bonus mass drop brother vivid noodle salad stage damage final";

// Same values as packages/core/test/messaging-keys.test.ts (computed by Qwalla).
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

describe("cross-app vectors (extension signing derivation + core messaging derivation)", () => {
    for (const [name, phrase] of [["A", PHRASE_A], ["B", PHRASE_B]] as const) {
        it(`phrase ${name}: same signing key, rouge1 address and messaging key as Qwalla / website`, async () => {
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
        const enc = deriveMessagingKeypair(null, secretKey);
        expect(sha(enc.publicKey)).toBe(QWALLA.C.kemPubSha);
        expect(sha(enc.privateKey)).toBe(QWALLA.C.kemSecSha);
    });

    it("the derived pair is a working ML-KEM-768 keypair", () => {
        const { secretKey } = keypairFromMnemonic(PHRASE_A);
        const a = deriveMessagingKeypair(PHRASE_A, secretKey);
        expect(a.publicKey).toHaveLength(1184 * 2);
        expect(a.privateKey).toHaveLength(2400 * 2);
        const { cipherText, sharedSecret } = ml_kem768.encapsulate(Uint8Array.from(Buffer.from(a.publicKey, "hex")));
        expect(hex(ml_kem768.decapsulate(cipherText, Uint8Array.from(Buffer.from(a.privateKey, "hex"))))).toBe(hex(sharedSecret));
    });
});

describe("new wallet / recovery-phrase import (walletFromMnemonic)", () => {
    it("create: a fresh phrase yields the phrase-derived messaging key", () => {
        const w = walletFromMnemonic(PHRASE_B, "fresh");
        expect(w.mnemonic).toBe(PHRASE_B);
        expect(sha(w.signingPublicKey)).toBe(QWALLA.B.pubKeySha);
        expect(sha(w.encryptionPublicKey)).toBe(QWALLA.B.kemPubSha);
        expect(sha(w.encryptionPrivateKey)).toBe(QWALLA.B.kemSecSha);
        expect(w.displayName).toBe("fresh");
    });

    it("import: phrase is normalized (trim, lower-case, single spaces) before deriving", () => {
        const messy = `  ${PHRASE_A.toUpperCase().replace(/ /g, "  \n ")}\t `;
        expect(normalizeRecoveryPhrase(messy)).toBe(PHRASE_A);
        const w = walletFromMnemonic(messy, "restored");
        expect(w.mnemonic).toBe(PHRASE_A);
        expect(sha(w.signingPublicKey)).toBe(QWALLA.A.pubKeySha);
        expect(sha(w.encryptionPublicKey)).toBe(QWALLA.A.kemPubSha);
        expect(sha(w.encryptionPrivateKey)).toBe(QWALLA.A.kemSecSha);
    });

    it("restoring the same phrase twice gives the same messaging key (fresh id each time)", () => {
        const a = walletFromMnemonic(PHRASE_A, "a");
        const b = walletFromMnemonic(PHRASE_A, "b");
        expect(b.encryptionPrivateKey).toBe(a.encryptionPrivateKey);
        expect(b.id).not.toBe(a.id);
    });

    it("rejects an invalid phrase", () => {
        expect(() => walletFromMnemonic("not a real phrase", "x")).toThrow();
    });
});

describe("backup import (prepareImportedWallet)", () => {
    const { publicKey, secretKey } = keypairFromMnemonic(PHRASE_A);
    const base: UnifiedWallet = {
        id: "w1", displayName: "backup", createdAt: 1, version: 3,
        signingPublicKey: publicKey, signingPrivateKey: secretKey,
        encryptionPublicKey: "", encryptionPrivateKey: "", mnemonic: PHRASE_A,
    };

    it("a backup WITH messaging keys keeps them exactly (even a random, non-derived key)", () => {
        const k = ml_kem768.keygen();
        const w = { ...base, encryptionPublicKey: hex(k.publicKey), encryptionPrivateKey: hex(k.secretKey) };
        const out = prepareImportedWallet(w);
        expect(out).toBe(w);
        expect(out.encryptionPrivateKey).toBe(hex(k.secretKey));
    });

    it("a backup WITHOUT messaging keys derives them from its mnemonic", () => {
        const out = prepareImportedWallet(base);
        expect(sha(out.encryptionPublicKey)).toBe(QWALLA.A.kemPubSha);
        expect(sha(out.encryptionPrivateKey)).toBe(QWALLA.A.kemSecSha);
    });

    it("a private-key-only backup (no mnemonic, no messaging keys) derives from the signing key", () => {
        const out = prepareImportedWallet({ ...base, mnemonic: undefined });
        expect(sha(out.encryptionPublicKey)).toBe(QWALLA.C.kemPubSha);
        expect(sha(out.encryptionPrivateKey)).toBe(QWALLA.C.kemSecSha);
    });
});
