/**
 * Pins the browser-storage and crypto contract of @rougechain/core.
 *
 * apps/web (live rougechain.io) and apps/site-next will share ONE origin, so a user's wallet only
 * carries over if both read/write exactly these keys, formats and vault parameters. If a test here
 * fails, existing users' stored wallets would stop loading — do not "fix" the expectation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { installStorage } from "./storage-shim";
import {
  BLOCKCHAIN_WALLET_KEY,
  ENCRYPTED_WALLET_KEY,
  MESSENGER_WALLET_KEY,
  UNIFIED_WALLET_KEY,
  VAULT_SETTINGS_KEY,
  WALLET_LOCKED_KEY,
  WALLET_METADATA_KEY,
  MIN_VAULT_PASSWORD_LENGTH,
  autoLockWallet,
  decryptWallet,
  hasPlaintextStoredWallet,
  isWalletPending,
  stageUnifiedWallet,
  encryptWallet,
  isWalletLocked,
  loadUnifiedWallet,
  lockUnifiedWallet,
  saveUnifiedWallet,
  saveVaultSettings,
  unlockUnifiedWallet,
  type UnifiedWallet,
} from "../src/unified-wallet";
import { NETWORK_STORAGE_KEY, getActiveNetwork } from "../src/network";
import { ACCEPTED_KEY, BLOCKED_KEY, MESSENGER_PREFS_EVENT, MUTED_KEY, REQUESTS_MIGRATED_KEY } from "../src/messenger-prefs";
import { PROFILE_CHANGED_EVENT } from "../src/avatar";
import { saveNotificationSettings, markMessageSeen } from "../src/notifications";
import { setNickname } from "../src/contact-nicknames";
import { createSignedTransfer, serializePayload, verifyTransaction, type TransactionPayload } from "../src/pqc-signer";
import { keypairFromMnemonic } from "../src/mnemonic";
import { pubkeyToAddress } from "../src/address";

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

function fixtureWallet(): UnifiedWallet {
  const sig = ml_dsa65.keygen(new Uint8Array(32).fill(7));
  const enc = ml_kem768.keygen(new Uint8Array(64).fill(9));
  return {
    id: "wallet-fixture",
    displayName: "Fixture",
    createdAt: 1_700_000_000_000,
    signingPublicKey: hex(sig.publicKey),
    signingPrivateKey: hex(sig.secretKey),
    encryptionPublicKey: hex(enc.publicKey),
    encryptionPrivateKey: hex(enc.secretKey),
    version: 4,
  };
}

// Independent reference implementation of the vault format:
// base64( salt[16] || iv[12] || AES-256-GCM(JSON(wallet)) ), key = PBKDF2-SHA256(password, salt, N).
async function refKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
async function refEncrypt(data: unknown, password: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await refKey(password, salt, iterations), new TextEncoder().encode(JSON.stringify(data))),
  );
  return btoa(String.fromCharCode(...salt, ...iv, ...ct));
}
async function refDecrypt(blob: string, password: string, iterations: number): Promise<unknown> {
  const all = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: all.slice(16, 28) },
    await refKey(password, all.slice(0, 16), iterations),
    all.slice(28),
  );
  return JSON.parse(new TextDecoder().decode(pt));
}

describe("storage key names (shared with apps/web on rougechain.io)", () => {
  it("pins the exported key constants", () => {
    expect({
      UNIFIED_WALLET_KEY,
      MESSENGER_WALLET_KEY,
      BLOCKCHAIN_WALLET_KEY,
      ENCRYPTED_WALLET_KEY,
      WALLET_LOCKED_KEY,
      WALLET_METADATA_KEY,
      VAULT_SETTINGS_KEY,
      NETWORK_STORAGE_KEY,
      MUTED_KEY,
      ACCEPTED_KEY,
      REQUESTS_MIGRATED_KEY,
      BLOCKED_KEY,
    }).toEqual({
      UNIFIED_WALLET_KEY: "pqc-unified-wallet",
      MESSENGER_WALLET_KEY: "pqc_messenger_wallet",
      BLOCKCHAIN_WALLET_KEY: "pqc-blockchain-wallet",
      ENCRYPTED_WALLET_KEY: "pqc-unified-wallet-encrypted",
      WALLET_LOCKED_KEY: "pqc-unified-wallet-locked",
      WALLET_METADATA_KEY: "pqc-unified-wallet-metadata",
      VAULT_SETTINGS_KEY: "pqc-unified-wallet-vault-settings",
      NETWORK_STORAGE_KEY: "rougechain-network",
      MUTED_KEY: "pqc_muted_conversations",
      ACCEPTED_KEY: "pqc_accepted_chats",
      REQUESTS_MIGRATED_KEY: "pqc_requests_migrated",
      BLOCKED_KEY: "pqc_blocked_wallets",
    });
    expect(PROFILE_CHANGED_EVENT).toBe("rougechain:profile-changed");
    expect(MESSENGER_PREFS_EVENT).toBe("rougechain:messenger-prefs");
  });

  it("pins module-private keys by what they write", () => {
    const { local } = installStorage();
    saveNotificationSettings({ enabled: true, sound: false, desktopEnabled: true });
    markMessageSeen("m1");
    setNickname("w1", "Bob");
    expect(local.keys()).toEqual(["pqc_contact_nicknames", "pqc_notification_settings", "pqc_seen_messages"]);
  });
});

describe("unified wallet storage layout", () => {
  let store: ReturnType<typeof installStorage>;
  beforeEach(() => {
    store = installStorage();
  });

  it("defaults to mainnet and scopes wallet keys as <key>:<network>", () => {
    expect(getActiveNetwork()).toBe("mainnet");
    const w = fixtureWallet();
    saveUnifiedWallet(w);
    expect(store.session.keys()).toEqual(["pqc-unified-wallet:mainnet"]);
    expect(store.local.keys()).toEqual([
      "pqc-blockchain-wallet:mainnet",
      "pqc-unified-wallet-metadata:mainnet",
      "pqc_messenger_wallet:mainnet",
    ]);
    // Full wallet (with private keys) in sessionStorage ONLY — never plaintext in localStorage,
    // even while no vault password is set (security fix 2026-10; older builds wrote it there).
    expect(JSON.parse(store.session.getItem("pqc-unified-wallet:mainnet")!)).toEqual(w);
    expect(store.local.getItem("pqc-unified-wallet:mainnet")).toBeNull();
    // Public-only mirrors.
    expect(JSON.parse(store.local.getItem("pqc-unified-wallet-metadata:mainnet")!)).toEqual({
      id: w.id,
      displayName: w.displayName,
      signingPublicKey: w.signingPublicKey,
      encryptionPublicKey: w.encryptionPublicKey,
      createdAt: w.createdAt,
    });
    expect(JSON.parse(store.local.getItem("pqc_messenger_wallet:mainnet")!)).toEqual({
      id: w.id,
      displayName: w.displayName,
      signingPublicKey: w.signingPublicKey,
      signingPrivateKey: "",
      encryptionPublicKey: w.encryptionPublicKey,
      encryptionPrivateKey: "",
      createdAt: new Date(w.createdAt).toISOString(),
    });
    expect(JSON.parse(store.local.getItem("pqc-blockchain-wallet:mainnet")!)).toEqual({
      publicKey: w.signingPublicKey,
      privateKey: "",
      createdAt: w.createdAt,
      linkedToMessenger: true,
    });
    expect(loadUnifiedWallet()).toEqual(w);
  });

  it("uses the testnet scope when rougechain-network=testnet", () => {
    store.local.setItem("rougechain-network", "testnet");
    saveUnifiedWallet(fixtureWallet());
    saveVaultSettings({ autoLockMinutes: 5 });
    expect(store.session.keys()).toEqual(["pqc-unified-wallet:testnet"]);
    expect(store.local.keys()).toEqual([
      "pqc-blockchain-wallet:testnet",
      "pqc-unified-wallet-metadata:testnet",
      "pqc-unified-wallet-vault-settings:testnet",
      "pqc_messenger_wallet:testnet",
      "rougechain-network",
    ]);
  });

  it("lock stores only the encrypted blob + public metadata; unlock restores the wallet", async () => {
    const w = fixtureWallet();
    saveUnifiedWallet(w);
    await lockUnifiedWallet("hunter2");
    expect(store.session.keys()).toEqual([]);
    expect(store.local.keys()).toEqual([
      "pqc-unified-wallet-encrypted:mainnet",
      "pqc-unified-wallet-locked:mainnet",
      "pqc-unified-wallet-metadata:mainnet",
    ]);
    expect(store.local.getItem("pqc-unified-wallet-locked:mainnet")).toBe("true");
    expect(JSON.parse(store.local.getItem("pqc-unified-wallet-metadata:mainnet")!)).toEqual({
      displayName: w.displayName,
      signingPublicKey: w.signingPublicKey,
    });
    expect(isWalletLocked()).toBe(true);
    // The stored blob is readable by the reference implementation (600k PBKDF2 iterations).
    expect(await refDecrypt(store.local.getItem("pqc-unified-wallet-encrypted:mainnet")!, "hunter2", 600_000)).toEqual(w);

    await expect(unlockUnifiedWallet("wrong")).rejects.toThrow();
    const unlocked = await unlockUnifiedWallet("hunter2");
    expect(unlocked).toEqual(w);
    expect(store.local.getItem("pqc-unified-wallet-locked:mainnet")).toBe("false");
    expect(JSON.parse(store.session.getItem("pqc-unified-wallet:mainnet")!)).toEqual(w);
    // Vault exists → private keys are NOT persisted to localStorage again.
    expect(store.local.getItem("pqc-unified-wallet:mainnet")).toBeNull();
  }, 60_000);
});

describe("no plaintext private keys in localStorage", () => {
  let store: ReturnType<typeof installStorage>;
  beforeEach(() => {
    store = installStorage();
  });
  const localHasSecret = (w: UnifiedWallet) =>
    store.local.keys().some((k) => {
      const v = store.local.getItem(k) ?? "";
      return v.includes(w.signingPrivateKey) || v.includes(w.encryptionPrivateKey);
    });

  it("stageUnifiedWallet writes only sessionStorage (wallet + pending flag)", () => {
    const w = { ...fixtureWallet(), mnemonic: "abandon ".repeat(11) + "about" };
    stageUnifiedWallet(w);
    expect(store.local.keys()).toEqual([]);
    expect(store.session.keys()).toEqual(["pqc-unified-wallet-pending:mainnet", "pqc-unified-wallet:mainnet"]);
    expect(isWalletPending()).toBe(true);
    expect(loadUnifiedWallet()).toEqual(w);
    // Abandoning (tab closed = sessionStorage gone) leaves nothing behind.
    store.session.clear();
    expect(loadUnifiedWallet()).toBeNull();
    expect(localHasSecret(w)).toBe(false);
  });

  it("saveUnifiedWallet never persists private keys without a vault; extension wallets are remembered", () => {
    const w = fixtureWallet();
    saveUnifiedWallet(w);
    expect(localHasSecret(w)).toBe(false);
    const ext = { ...w, id: "ext-1", signingPrivateKey: "", encryptionPrivateKey: "" };
    saveUnifiedWallet(ext);
    expect(JSON.parse(store.local.getItem("pqc-unified-wallet:mainnet")!)).toEqual(ext);
    store.session.clear();
    expect(loadUnifiedWallet()).toEqual(ext);
  });

  it("a legacy plaintext wallet is still read, and setting a password encrypts it and deletes the plaintext", async () => {
    const w = fixtureWallet();
    store.local.setItem("pqc-unified-wallet:mainnet", JSON.stringify(w)); // written by an older build
    expect(hasPlaintextStoredWallet()).toBe(true);
    expect(loadUnifiedWallet()).toEqual(w);
    await lockUnifiedWallet("correct horse");
    expect(hasPlaintextStoredWallet()).toBe(false);
    expect(localHasSecret(w)).toBe(false);
    expect(await unlockUnifiedWallet("correct horse")).toEqual(w);
    expect(localHasSecret(w)).toBe(false);
    expect(isWalletPending()).toBe(false);
  }, 60_000);

  it("locking a staged wallet replaces the vault and clears the pending flag", async () => {
    const w = fixtureWallet();
    stageUnifiedWallet(w);
    await lockUnifiedWallet("correct horse");
    expect(isWalletPending()).toBe(false);
    expect(localHasSecret(w)).toBe(false);
    expect(await refDecrypt(store.local.getItem("pqc-unified-wallet-encrypted:mainnet")!, "correct horse", 600_000)).toEqual(w);
    expect(MIN_VAULT_PASSWORD_LENGTH).toBe(8);
  }, 60_000);
});

describe("legacy plaintext is deleted only once ITS vault is written", () => {
  let store: ReturnType<typeof installStorage>;
  beforeEach(() => {
    store = installStorage();
  });
  const localWith = (secret: string) => store.local.keys().filter((k) => (store.local.getItem(k) ?? "").includes(secret));
  // A slice of the ML-DSA secret key that is not part of the public key.
  const secretOf = (w: UnifiedWallet) => w.signingPrivateKey.slice(-200);
  const tabClose = () => store.session.clear();

  async function encryptsAndScrubs(w: UnifiedWallet) {
    await lockUnifiedWallet("correct horse");
    expect(localWith(secretOf(w))).toEqual([]);
    for (const k of ["pqc_messenger_wallet:mainnet", "pqc-blockchain-wallet:mainnet", "pqc-unified-wallet:mainnet", "pqc-unified-wallet", "pqc_messenger_wallet", "pqc-blockchain-wallet"]) {
      const v = store.local.getItem(k);
      if (v) {
        const p = JSON.parse(v);
        expect(p.signingPrivateKey || p.privateKey || p.encryptionPrivateKey || "").toBe("");
      }
    }
    tabClose();
    expect((await unlockUnifiedWallet("correct horse")).signingPrivateKey).toBe(w.signingPrivateKey);
    expect(localWith(secretOf(w))).toEqual([]);
  }

  it("unscoped pqc-unified-wallet: moved to the scoped key, survives tab close, then encrypted", async () => {
    const w = { ...fixtureWallet(), mnemonic: "legacy words" };
    store.local.setItem("pqc-unified-wallet", JSON.stringify(w));
    expect(loadUnifiedWallet()?.signingPrivateKey).toBe(w.signingPrivateKey);
    tabClose();
    expect(store.local.getItem("pqc-unified-wallet")).toBeNull();
    expect(localWith(secretOf(w))).toEqual(["pqc-unified-wallet:mainnet"]);
    expect(hasPlaintextStoredWallet(w.signingPublicKey)).toBe(true);
    expect(loadUnifiedWallet()?.signingPrivateKey).toBe(w.signingPrivateKey);
    await encryptsAndScrubs(w);
  }, 60_000);

  it("v1 split keys (scoped pqc_messenger_wallet / pqc-blockchain-wallet, unscoped messenger) survive tab close", async () => {
    const w = fixtureWallet();
    const messenger = JSON.stringify({ id: w.id, displayName: "Old", signingPublicKey: w.signingPublicKey, signingPrivateKey: w.signingPrivateKey, encryptionPublicKey: w.encryptionPublicKey, encryptionPrivateKey: w.encryptionPrivateKey });
    const blockchain = JSON.stringify({ publicKey: w.signingPublicKey, privateKey: w.signingPrivateKey, createdAt: 1 });
    for (const [key, value] of [["pqc_messenger_wallet:mainnet", messenger], ["pqc-blockchain-wallet:mainnet", blockchain], ["pqc_messenger_wallet", messenger]] as const) {
      store = installStorage();
      store.local.setItem(key, value);
      expect(loadUnifiedWallet()?.signingPrivateKey, key).toBe(w.signingPrivateKey);
      tabClose();
      expect(localWith(secretOf(w)), key).toContain("pqc-unified-wallet:mainnet");
      expect(loadUnifiedWallet()?.signingPrivateKey, key).toBe(w.signingPrivateKey);
      tabClose();
      expect(loadUnifiedWallet()?.signingPrivateKey, key).toBe(w.signingPrivateKey);
      await encryptsAndScrubs({ ...w });
    }
  }, 120_000);

  it("keeps the plaintext when encryption fails", async () => {
    const w = fixtureWallet();
    store.local.setItem("pqc-unified-wallet:mainnet", JSON.stringify(w));
    const spy = vi.spyOn(crypto.subtle, "encrypt").mockRejectedValueOnce(new Error("boom"));
    await expect(lockUnifiedWallet("correct horse")).rejects.toThrow("boom");
    spy.mockRestore();
    expect(JSON.parse(store.local.getItem("pqc-unified-wallet:mainnet")!)).toEqual(w);
    expect(store.local.getItem("pqc-unified-wallet-encrypted:mainnet")).toBeNull();
  });

  it("never deletes another wallet's plaintext: vaulting a different wallet or auto-lock keeps it", async () => {
    const legacy = fixtureWallet();
    store.local.setItem("pqc-unified-wallet:mainnet", JSON.stringify(legacy));
    const other = { ...fixtureWallet(), signingPublicKey: "ab".repeat(1952), signingPrivateKey: "cd".repeat(4032), id: "other" };
    stageUnifiedWallet(other);
    await lockUnifiedWallet("correct horse"); // vault for OTHER
    expect(JSON.parse(store.local.getItem("pqc-unified-wallet:mainnet")!)).toEqual(legacy);
    expect(hasPlaintextStoredWallet(legacy.signingPublicKey)).toBe(true);
    autoLockWallet();
    expect(JSON.parse(store.local.getItem("pqc-unified-wallet:mainnet")!)).toEqual(legacy);
  }, 60_000);
});

describe("vault encryption format", () => {
  it("encryptWallet → decryptWallet round trip; blob = base64(salt16 || iv12 || AES-GCM ct)", async () => {
    const w = fixtureWallet();
    const blob = await encryptWallet(w, "correct horse");
    const bytes = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0));
    expect(bytes.length).toBe(16 + 12 + new TextEncoder().encode(JSON.stringify(w)).length + 16);
    expect(await decryptWallet(blob, "correct horse")).toEqual(w);
    expect(await refDecrypt(blob, "correct horse", 600_000)).toEqual(w);
    await expect(decryptWallet(blob, "wrong")).rejects.toThrow();
    // Fresh salt + IV every time.
    expect(await encryptWallet(w, "correct horse")).not.toBe(blob);
  }, 60_000);

  it("decrypts a reference 600k-iteration blob and a legacy 100k-iteration blob", async () => {
    const w = fixtureWallet();
    expect(await decryptWallet(await refEncrypt(w, "pw", 600_000), "pw")).toEqual(w);
    expect(await decryptWallet(await refEncrypt(w, "pw", 100_000), "pw")).toEqual(w);
  }, 60_000);

  it("migrates a v1 (messenger-only) payload", async () => {
    const v1 = {
      id: "old",
      displayName: "Old",
      createdAt: "2024-01-02T03:04:05.000Z",
      signingPublicKey: "aa",
      signingPrivateKey: "bb",
      encryptionPublicKey: "cc",
      encryptionPrivateKey: "dd",
    };
    expect(await decryptWallet(await refEncrypt(v1, "pw", 600_000), "pw")).toEqual({
      ...v1,
      createdAt: Date.parse("2024-01-02T03:04:05.000Z"),
      version: 2,
    });
  }, 60_000);
});

describe("signing payload layout + key derivation", () => {
  it("serializes payloads as recursively key-sorted JSON (serde BTreeMap order)", () => {
    const payload = {
      type: "transfer",
      from: "aa",
      to: "bb",
      amount: 5,
      fee: 0.1,
      token: "XRGE",
      nonce: "00",
      timestamp: 1_700_000_000_000,
      chain_id: "rougechain-mainnet-1",
      nested: { z: 1, a: [{ y: 2, b: 3 }] },
    } as unknown as TransactionPayload;
    expect(new TextDecoder().decode(serializePayload(payload))).toBe(
      '{"amount":5,"chain_id":"rougechain-mainnet-1","fee":0.1,"from":"aa","nested":{"a":[{"b":3,"y":2}],"z":1},' +
        '"nonce":"00","timestamp":1700000000000,"to":"bb","token":"XRGE","type":"transfer"}',
    );
  });

  it("signs transfers with ML-DSA-65 over the serialized payload", () => {
    const w = fixtureWallet();
    const tx = createSignedTransfer(w.signingPublicKey, w.signingPrivateKey, "bb", 10);
    expect(Object.keys(tx).sort()).toEqual(["payload", "public_key", "signature"]);
    expect(Object.keys(tx.payload).sort()).toEqual(["amount", "fee", "from", "nonce", "timestamp", "to", "token", "type"]);
    expect(tx.payload).toMatchObject({ type: "transfer", from: w.signingPublicKey, to: "bb", amount: 10, fee: 1, token: "XRGE" });
    expect(tx.payload.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(verifyTransaction(tx)).toBe(true);
    const sig = Uint8Array.from(tx.signature.match(/../g)!.map((b) => parseInt(b, 16)));
    const pk = Uint8Array.from(w.signingPublicKey.match(/../g)!.map((b) => parseInt(b, 16)));
    expect(ml_dsa65.verify(sig, serializePayload(tx.payload), pk)).toBe(true);
    expect(verifyTransaction({ ...tx, payload: { ...tx.payload, amount: 11 } })).toBe(false);
  });

  it("derives the same keypair + rouge1 address from a mnemonic", async () => {
    const mnemonic = `${"abandon ".repeat(23)}art`;
    const kp = keypairFromMnemonic(mnemonic);
    expect(kp.publicKey.length).toBe(1952 * 2);
    expect(kp.secretKey.length).toBe(4032 * 2);
    expect(await pubkeyToAddress(kp.publicKey)).toBe("rouge12vdn0rt2zgl8fh4p0f8rkg3k02xlvtgga27sck0y530jmpz54atstu9ss3");
  });
});
