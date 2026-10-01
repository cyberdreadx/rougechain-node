/**
 * Stored wallets keep their messaging key: unlock, legacy-blob migration, vault re-persist
 * (rename/add), session load/save never replace a valid key — even a random one from 1.6.x.
 * New / imported wallets are persisted with the seed-derived key.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { installChromeShim, resetChromeData } from "./chrome-shim";

installChromeShim();

const storage = await import("../src/lib/storage");
const uw = await import("../src/lib/unified-wallet");
const { keypairFromMnemonic } = await import("../src/lib/mnemonic");
const { deriveMessagingKeypair, prepareImportedWallet, walletFromMnemonic } = await import("../src/lib/messaging-keys");
type UnifiedWallet = import("../src/lib/unified-wallet").UnifiedWallet;

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const PHRASE_A =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon " +
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
const PHRASE_B =
    "rather supply certain amount amused sentence negative muscle grab clip swamp bonus scene melt " +
    "bonus mass drop brother vivid noodle salad stage damage final";
const PW = "correct horse battery";
const ENCRYPTED_KEY = "pqc-unified-wallet-encrypted";
const KEYS = ["pqc-unified-wallet", "pqc-unified-vault", "pqc-unified-wallet-metadata", ENCRYPTED_KEY, "pqc-unified-active-id"];

/** A wallet as an older (≤1.6) extension stored it: phrase-derived signing key, RANDOM messaging key. */
function legacyWallet(phrase: string, id: string): UnifiedWallet {
    const { publicKey, secretKey } = keypairFromMnemonic(phrase);
    const k = ml_kem768.keygen();
    return {
        id, displayName: id, createdAt: 1, version: 3, mnemonic: phrase,
        signingPublicKey: publicKey, signingPrivateKey: secretKey,
        encryptionPublicKey: hex(k.publicKey), encryptionPrivateKey: hex(k.secretKey),
    };
}

async function storedVault(): Promise<{ wallets: UnifiedWallet[] }> {
    return (await uw.decryptWallet(storage.getItem(ENCRYPTED_KEY)!, PW)) as unknown as { wallets: UnifiedWallet[] };
}

beforeAll(async () => { await storage.initStorage(); });
beforeEach(() => { resetChromeData(); for (const k of KEYS) storage.removeItem(k); });

describe("existing stored wallets keep their messaging key", () => {
    it("unlock of a stored vault does not re-derive a random (pre-1.7) key; rename re-persists it unchanged", async () => {
        const old = legacyWallet(PHRASE_A, "old");
        const derived = deriveMessagingKeypair(PHRASE_A, old.signingPrivateKey);
        expect(old.encryptionPrivateKey).not.toBe(derived.privateKey);

        const blob = await uw.encryptWallet({ vault: 1, wallets: [old], activeId: old.id } as unknown as UnifiedWallet, PW);
        storage.setItem(ENCRYPTED_KEY, blob);

        const active = await uw.unlockUnifiedWallet(PW);
        expect(active.encryptionPublicKey).toBe(old.encryptionPublicKey);
        expect(active.encryptionPrivateKey).toBe(old.encryptionPrivateKey);
        expect(uw.loadUnifiedWallet()!.encryptionPrivateKey).toBe(old.encryptionPrivateKey);

        await uw.renameWalletInVault(old.id, "renamed", PW);
        const [w] = (await storedVault()).wallets;
        expect(w.displayName).toBe("renamed");
        expect(w.encryptionPrivateKey).toBe(old.encryptionPrivateKey);
    }, 60_000);

    it("legacy single-wallet blob migration keeps the key", async () => {
        const old = legacyWallet(PHRASE_B, "legacy");
        storage.setItem(ENCRYPTED_KEY, await uw.encryptWallet(old, PW));
        const active = await uw.unlockUnifiedWallet(PW);
        expect(active.encryptionPrivateKey).toBe(old.encryptionPrivateKey);
        const [w] = (await storedVault()).wallets;
        expect(w.encryptionPrivateKey).toBe(old.encryptionPrivateKey);
    }, 60_000);

    it("adding a new wallet to the vault leaves the existing wallet's key alone", async () => {
        const old = legacyWallet(PHRASE_B, "old");
        storage.setItem(ENCRYPTED_KEY, await uw.encryptWallet({ vault: 1, wallets: [old], activeId: old.id } as unknown as UnifiedWallet, PW));
        await uw.unlockUnifiedWallet(PW);

        const fresh = walletFromMnemonic(PHRASE_A, "new");
        await uw.persistNewWallet(fresh, PW);
        const { wallets } = await storedVault();
        expect(wallets).toHaveLength(2);
        expect(wallets.find((w) => w.id === old.id)!.encryptionPrivateKey).toBe(old.encryptionPrivateKey);
        expect(wallets.find((w) => w.id === fresh.id)!.encryptionPrivateKey)
            .toBe(deriveMessagingKeypair(PHRASE_A, fresh.signingPrivateKey).privateKey);
    }, 60_000);

    it("session save/load keeps a valid key", () => {
        const old = legacyWallet(PHRASE_A, "s");
        uw.saveUnifiedWallet(old);
        expect(uw.loadUnifiedWallet()!.encryptionPrivateKey).toBe(old.encryptionPrivateKey);
    });

    it("a stored wallet MISSING its messaging key gets the seed-derived one (not random)", () => {
        const broken = { ...legacyWallet(PHRASE_A, "broken"), encryptionPublicKey: "", encryptionPrivateKey: "" };
        uw.saveUnifiedWallet(broken);
        const w = uw.loadUnifiedWallet()!;
        expect(w.encryptionPrivateKey).toBe(deriveMessagingKeypair(PHRASE_A, broken.signingPrivateKey).privateKey);
    });
});

describe("new / imported wallets are persisted with the derived key", () => {
    it("create / phrase import → first vault stores the phrase-derived key", async () => {
        const w = walletFromMnemonic(PHRASE_B, "first");
        await uw.persistNewWallet(w, PW);
        const [stored] = (await storedVault()).wallets;
        expect(stored.encryptionPrivateKey).toBe(deriveMessagingKeypair(PHRASE_B, w.signingPrivateKey).privateKey);
        expect(stored.mnemonic).toBe(PHRASE_B);
    }, 60_000);

    it(".pqcbackup with messaging keys round-trips and keeps them exactly", async () => {
        const old = legacyWallet(PHRASE_A, "bk");
        const backup = await uw.exportWalletBackup(old, PW);
        const imported = prepareImportedWallet(await uw.decryptWallet(backup, PW));
        expect(imported.encryptionPrivateKey).toBe(old.encryptionPrivateKey);
        await uw.persistNewWallet(imported, PW);
        const [stored] = (await storedVault()).wallets;
        expect(stored.encryptionPrivateKey).toBe(old.encryptionPrivateKey);
    }, 60_000);

    it(".pqcbackup without messaging keys → derived from its mnemonic / its private key", async () => {
        const noKeys = { ...legacyWallet(PHRASE_A, "nk"), encryptionPublicKey: "", encryptionPrivateKey: "" };
        const a = prepareImportedWallet(await uw.decryptWallet(await uw.exportWalletBackup(noKeys, PW), PW));
        expect(a.encryptionPrivateKey).toBe(deriveMessagingKeypair(PHRASE_A, noKeys.signingPrivateKey).privateKey);

        const keyOnly = { ...noKeys, mnemonic: undefined };
        const b = prepareImportedWallet(await uw.decryptWallet(await uw.exportWalletBackup(keyOnly, PW), PW));
        expect(b.encryptionPrivateKey).toBe(deriveMessagingKeypair(null, noKeys.signingPrivateKey).privateKey);
    }, 60_000);
});
