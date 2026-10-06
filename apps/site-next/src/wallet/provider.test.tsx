import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pubkeyToAddress } from "@rougechain/core/address";
import { generateMnemonic, keypairFromMnemonic } from "@rougechain/core/mnemonic";
import { PROFILE_CHANGED_EVENT } from "@rougechain/core/avatar";
import { deriveMessagingKeypair } from "@rougechain/core/messaging-keys";
import { sha256 } from "@noble/hashes/sha2.js";
import { verifyTransaction, generateNonce } from "@rougechain/core/pqc-signer";
import {
  hasEncryptedWallet,
  isWalletLocked,
  loadUnifiedWallet,
  lockUnifiedWallet,
  saveUnifiedWallet,
  saveVaultSettings,
  unlockUnifiedWallet,
} from "@rougechain/core/unified-wallet";
import { WalletProvider, useSigner, useWallet, useWalletIdentity, normalizeRecoveryPhrase, type WalletContextValue, type Signer } from "./WalletProvider";
import { readWalletSnapshot, resetWalletStoreForTests } from "./store";
import { dumpStorage, mockFetch, resetBrowserState, seedAppsWebLockedWallet, seedAppsWebWallet } from "./test-utils";

/** localStorage keys whose value contains any of the wallet's secrets (must stay empty). */
function localSecrets(w: { signingPrivateKey: string; encryptionPrivateKey: string; mnemonic?: string }): string[] {
  const secrets = [w.signingPrivateKey, w.encryptionPrivateKey, w.mnemonic].filter((x): x is string => !!x);
  return Object.entries(dumpStorage(localStorage))
    .filter(([, v]) => secrets.some((sec) => v.includes(sec)))
    .map(([k]) => k);
}

let ctx: WalletContextValue;
let signer: Signer | null;
function Probe() {
  ctx = useWallet();
  signer = useSigner();
  const id = useWalletIdentity();
  return (
    <div>
      <span data-testid="status">{ctx.status}</span>
      <span data-testid="pubkey">{ctx.publicKey ?? ""}</span>
      <span data-testid="name">{ctx.displayName ?? ""}</span>
      <span data-testid="address">{id.address ?? ""}</span>
    </div>
  );
}
const status = () => screen.getByTestId("status").textContent;

function mount(autoRegister = false) {
  return render(
    <WalletProvider autoRegister={autoRegister}>
      <Probe />
    </WalletProvider>,
  );
}

beforeEach(() => {
  resetBrowserState();
  mockFetch({ "/messenger/wallets": () => ({ success: true, wallets: [] }) });
});

describe("same-origin continuity with apps/web", () => {
  it("reads an apps/web wallet (saveUnifiedWallet) as unlocked with the same address; only its random messaging key moves to the phrase-derived one", async () => {
    const w = seedAppsWebWallet();
    const beforeLocal = dumpStorage(localStorage);
    const beforeSession = dumpStorage(sessionStorage);

    mount(true); // with apps/web's auto-register behaviour on
    expect(status()).toBe("unlocked");
    expect(screen.getByTestId("pubkey").textContent).toBe(w.signingPublicKey);
    const expected = await pubkeyToAddress(w.signingPublicKey);
    await waitFor(() => expect(screen.getByTestId("address").textContent).toBe(expected));
    expect(ctx.wallet?.signingPrivateKey).toBe(w.signingPrivateKey);
    expect(ctx.wallet?.mnemonic).toBe(w.mnemonic);

    // The wallet is otherwise untouched: same storage keys, no secret in localStorage, and the
    // session copy differs only by the derived messaging key plus the old key kept beside it.
    const afterLocal = dumpStorage(localStorage);
    const afterSession = dumpStorage(sessionStorage);
    expect(Object.keys(afterLocal).sort()).toEqual(Object.keys(beforeLocal).sort());
    expect(Object.keys(afterSession).sort()).toEqual(Object.keys(beforeSession).sort());
    expect(JSON.stringify(afterLocal)).not.toContain(w.signingPrivateKey);
    expect(JSON.stringify(afterLocal)).not.toContain(w.encryptionPrivateKey);
    const d = deriveMessagingKeypair(w.mnemonic, w.signingPrivateKey);
    expect(JSON.parse(afterSession["pqc-unified-wallet:mainnet"])).toEqual({
      ...w,
      encryptionPublicKey: d.publicKey,
      encryptionPrivateKey: d.privateKey,
      legacyEncryptionPublicKey: w.encryptionPublicKey,
      legacyEncryptionPrivateKey: w.encryptionPrivateKey,
    });
  });

  it("reads an apps/web locked vault (lockUnifiedWallet) as locked, then unlocks it to the same wallet", async () => {
    const w = await seedAppsWebLockedWallet("hunter2-hunter2");
    const beforeLocal = dumpStorage(localStorage);
    const beforeSession = dumpStorage(sessionStorage);
    expect(Object.keys(beforeSession)).toHaveLength(0); // private keys are gone

    mount(true);
    expect(status()).toBe("locked");
    expect(screen.getByTestId("pubkey").textContent).toBe(w.signingPublicKey);
    expect(screen.getByTestId("name").textContent).toBe("My Wallet");
    expect(ctx.wallet).toBeNull();
    expect(dumpStorage(localStorage)).toEqual(beforeLocal);
    expect(dumpStorage(sessionStorage)).toEqual(beforeSession);

    await expect(act(() => ctx.unlock("wrong password"))).rejects.toThrow("Wrong password");
    expect(status()).toBe("locked");

    // Reference: what apps/web's own unlock (core unlockUnifiedWallet) leaves in storage.
    await unlockUnifiedWallet("hunter2-hunter2");
    const referenceLocal = Object.keys(dumpStorage(localStorage)).sort();
    const referenceSession = Object.keys(dumpStorage(sessionStorage)).sort();
    localStorage.clear();
    sessionStorage.clear();
    for (const [k, v] of Object.entries(beforeLocal)) localStorage.setItem(k, v);

    await act(() => ctx.unlock("hunter2-hunter2"));
    expect(status()).toBe("unlocked");
    expect(ctx.wallet?.signingPublicKey).toBe(w.signingPublicKey);
    expect(ctx.wallet?.signingPrivateKey).toBe(w.signingPrivateKey);
    // site-next's unlock is core's unlock: exactly the same keys, nothing of its own.
    expect(Object.keys(dumpStorage(localStorage)).sort()).toEqual(referenceLocal);
    expect(Object.keys(dumpStorage(sessionStorage)).sort()).toEqual(referenceSession);
    expect(localStorage.getItem("pqc-unified-wallet-locked:mainnet")).toBe("false");
  });

  it("uses apps/web's network-scoped keys (a testnet wallet is not the mainnet wallet)", () => {
    localStorage.setItem("rougechain-network", "testnet");
    const w = seedAppsWebWallet();
    expect(Object.keys(dumpStorage(sessionStorage))).toContain("pqc-unified-wallet:testnet");
    expect(Object.keys(dumpStorage(localStorage))).toContain("pqc-unified-wallet-metadata:testnet");
    mount();
    expect(status()).toBe("unlocked");
    expect(ctx.network).toBe("testnet");
    act(() => {
      localStorage.setItem("rougechain-network", "mainnet");
      window.dispatchEvent(new StorageEvent("storage", { key: "rougechain-network" }));
    });
    expect(status()).toBe("none");
    act(() => {
      localStorage.setItem("rougechain-network", "testnet");
      window.dispatchEvent(new StorageEvent("storage", { key: "rougechain-network" }));
    });
    expect(screen.getByTestId("pubkey").textContent).toBe(w.signingPublicKey);
  });

  it("treats a vault with no session keys in this tab (unlocked in another tab) as locked", async () => {
    await seedAppsWebLockedWallet("pw-123456");
    await unlockUnifiedWallet("pw-123456"); // tab A
    sessionStorage.clear(); // a new tab has no session copy
    expect(isWalletLocked()).toBe(false);
    mount();
    expect(status()).toBe("locked");
  });
});

describe("provider state machine", () => {
  it("none → create → password → lock → unlock → disconnect", async () => {
    mount();
    expect(status()).toBe("none");
    await act(() => ctx.create());
    expect(status()).toBe("unlocked");
    expect(ctx.flow).toEqual({ mode: "create", step: "seed" });
    expect(ctx.wallet?.mnemonic?.split(" ")).toHaveLength(24);
    expect(ctx.hasPassword).toBe(false);
    expect(ctx.needsPassword).toBe(true);
    expect(ctx.pending).toBe(true);
    // Held in this tab's sessionStorage only until the password is set — never plaintext in localStorage.
    expect(JSON.parse(sessionStorage.getItem("pqc-unified-wallet:mainnet")!).signingPublicKey).toBe(ctx.publicKey);
    expect(localStorage.getItem("pqc-unified-wallet:mainnet")).toBeNull();
    expect(localSecrets(ctx.wallet!)).toEqual([]);

    const pub = ctx.publicKey;
    await expect(ctx.setPassword("short12")).rejects.toThrow("at least 8 characters");
    expect(hasEncryptedWallet()).toBe(false);
    await act(() => ctx.setPassword("s3cret-pass"));
    expect(ctx.hasPassword).toBe(true);
    expect(ctx.needsPassword).toBe(false);
    expect(hasEncryptedWallet()).toBe(true);
    expect(localStorage.getItem("pqc-unified-wallet:mainnet")).toBeNull();
    expect(localSecrets(ctx.wallet!)).toEqual([]);
    expect(status()).toBe("unlocked");

    act(() => ctx.lock());
    expect(status()).toBe("locked");
    expect(ctx.publicKey).toBe(pub);

    await act(() => ctx.unlock("s3cret-pass"));
    expect(status()).toBe("unlocked");
    expect(ctx.publicKey).toBe(pub);

    act(() => ctx.disconnect());
    expect(status()).toBe("none");
    expect(Object.keys(dumpStorage(localStorage)).filter((k) => k.startsWith("pqc-unified-wallet:") || k.startsWith("pqc-unified-wallet-encrypted"))).toEqual([]);
  });

  it("imports a recovery phrase deterministically and asks for a password", async () => {
    const w = seedAppsWebWallet();
    resetBrowserState();
    mockFetch();
    mount();
    await act(() => ctx.importMnemonic(`  ${w.mnemonic!.toUpperCase()}  `));
    expect(ctx.publicKey).toBe(w.signingPublicKey);
    expect(ctx.displayName).toBe("Recovered Wallet");
    expect(ctx.flow).toEqual({ mode: "import", step: "password" });
    expect(ctx.needsPassword).toBe(true);
    expect(localSecrets(ctx.wallet!)).toEqual([]);
    await expect(ctx.importMnemonic("abandon abandon")).rejects.toThrow("12 or 24 words");
    expect(() => normalizeRecoveryPhrase(Array(12).fill("zzzz").join(" "))).toThrow("Invalid seed phrase");
  });

  it("abandoning create / import before the password leaves no key material in localStorage", async () => {
    mount();
    await act(() => ctx.create());
    const created = ctx.wallet!;
    expect(localSecrets(created)).toEqual([]);
    // The user leaves (tab closed: sessionStorage gone) during the recovery-phrase step.
    sessionStorage.clear();
    act(() => ctx.refresh());
    expect(status()).toBe("none");
    expect(localSecrets(created)).toEqual([]);

    await act(() => ctx.importMnemonic(created.mnemonic!));
    expect(ctx.flow).toEqual({ mode: "import", step: "password" });
    sessionStorage.clear();
    act(() => ctx.refresh());
    expect(status()).toBe("none");
    expect(localSecrets(created)).toEqual([]);
  });

  it("requires the password step for an import even when a vault already exists (and then replaces it)", async () => {
    const other = seedAppsWebWallet();
    await lockUnifiedWallet("old-vault-pass");
    await unlockUnifiedWallet("old-vault-pass");
    mount();
    expect(ctx.publicKey).toBe(other.signingPublicKey);
    const phrase = generateMnemonic();
    const fresh = { signingPublicKey: keypairFromMnemonic(phrase).publicKey };
    await act(() => ctx.importMnemonic(phrase));
    expect(ctx.publicKey).toBe(fresh.signingPublicKey);
    expect(ctx.flow).toEqual({ mode: "import", step: "password" });
    expect(ctx.hasPassword).toBe(true);
    expect(ctx.needsPassword).toBe(true); // the vault still holds the OTHER wallet
    expect(localSecrets(ctx.wallet!)).toEqual([]);
    await act(() => ctx.setPassword("new-vault-pass"));
    expect(ctx.needsPassword).toBe(false);
    sessionStorage.clear();
    expect((await unlockUnifiedWallet("new-vault-pass")).signingPublicKey).toBe(fresh.signingPublicKey);
  }, 60_000);

  it("migrates a legacy plaintext wallet: password required, then only the encrypted vault remains", async () => {
    const w = seedAppsWebWallet();
    sessionStorage.clear();
    localStorage.setItem("pqc-unified-wallet:mainnet", JSON.stringify(w)); // written by an older build
    mount();
    expect(status()).toBe("unlocked");
    expect(ctx.publicKey).toBe(w.signingPublicKey);
    expect(ctx.needsPassword).toBe(true);
    expect(ctx.pending).toBe(false);
    await act(() => ctx.setPassword("migrate-pass"));
    expect(ctx.needsPassword).toBe(false);
    expect(localStorage.getItem("pqc-unified-wallet:mainnet")).toBeNull();
    expect(localSecrets(w)).toEqual([]);
    sessionStorage.clear();
    expect(await unlockUnifiedWallet("migrate-pass")).toMatchObject({ signingPublicKey: w.signingPublicKey, signingPrivateKey: w.signingPrivateKey, mnemonic: w.mnemonic });
  }, 60_000);

  it("imports an encrypted .pqcbackup made by core's encryptWallet (apps/web export)", async () => {
    const { encryptWallet } = await import("@rougechain/core/unified-wallet");
    const w = seedAppsWebWallet({ displayName: "Backed up" });
    const blob = await encryptWallet(w, "backup-pass");
    resetBrowserState();
    mockFetch();
    mount();
    await expect(ctx.importBackup(blob, "nope")).rejects.toThrow("wrong password");
    await act(() => ctx.importBackup(blob, "backup-pass"));
    expect(ctx.publicKey).toBe(w.signingPublicKey);
    expect(ctx.displayName).toBe("Backed up");
  });

  it("connects an injected extension like apps/web (empty private key) and signs through it", async () => {
    const w = seedAppsWebWallet();
    resetBrowserState();
    mockFetch();
    const signTransaction = vi.fn(async () => ({ signature: "ab".repeat(8) }));
    Object.defineProperty(window, "rougechain", {
      configurable: true,
      value: { isRougeChain: true, connect: async () => ({ publicKey: w.signingPublicKey, displayName: "Ext" }), signTransaction },
    });
    mount();
    await act(() => ctx.connectExtension());
    expect(status()).toBe("unlocked");
    expect(ctx.isExtension).toBe(true);
    expect(ctx.wallet?.signingPrivateKey).toBe("");
    expect(signer?.kind).toBe("extension");
    const signed = await signer!.sign({ type: "transfer", from: w.signingPublicKey, timestamp: 1, nonce: "n" });
    expect(signTransaction).toHaveBeenCalledWith(expect.objectContaining({ serializedHex: expect.any(String) }));
    expect(signed.public_key).toBe(w.signingPublicKey);
  });

  it("never calls the extension's connect() on load (no approval prompt before the user clicks)", async () => {
    let connected = 0;
    Object.defineProperty(window, "rougechain", {
      configurable: true,
      value: { isRougeChain: true, connect: async () => { connected += 1; return { publicKey: "ab".repeat(1952) }; } },
    });
    mount(true);
    window.dispatchEvent(new Event("rougechain#initialized"));
    await new Promise((r) => setTimeout(r, 50));
    expect(connected).toBe(0);
    expect(status()).toBe("none");
  });

  /** A provider stub with the `on` / `removeListener` event API Qwalla and the extension expose. */
  function eventedProvider(accounts: () => string) {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const provider = {
      isRougeChain: true,
      connect: vi.fn(async () => ({ publicKey: accounts(), displayName: `Acct ${accounts().slice(0, 4)}` })),
      on: (ev: string, cb: (...args: unknown[]) => void) => {
        if (!listeners.has(ev)) listeners.set(ev, new Set());
        listeners.get(ev)!.add(cb);
      },
      removeListener: (ev: string, cb: (...args: unknown[]) => void) => listeners.get(ev)?.delete(cb),
      emit: (ev: string, ...args: unknown[]) => listeners.get(ev)?.forEach((cb) => cb(...args)),
    };
    Object.defineProperty(window, "rougechain", { configurable: true, value: provider });
    return provider;
  }

  it("follows the provider when the user switches accounts in Qwalla / the extension", async () => {
    const a = "aa".repeat(1952);
    const b = "bb".repeat(1952);
    let active = a;
    const provider = eventedProvider(() => active);
    mount();
    await act(() => ctx.connectExtension());
    expect(ctx.publicKey).toBe(a);
    expect(provider.connect).toHaveBeenCalledTimes(1);

    active = b;
    await act(async () => {
      provider.emit("accountsChanged", [b]);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(ctx.publicKey).toBe(b);
    expect(ctx.displayName).toBe("Acct bbbb");
    expect(ctx.isExtension).toBe(true);
    // re-read uses connect() (no prompt on an approved site); same account again is a no-op
    expect(provider.connect).toHaveBeenCalledTimes(2);
    await act(async () => {
      provider.emit("accountsChanged", [b]);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(provider.connect).toHaveBeenCalledTimes(2);
  });

  it("drops the provider wallet when the provider disconnects or reports no account", async () => {
    const provider = eventedProvider(() => "cc".repeat(1952));
    mount();
    await act(() => ctx.connectExtension());
    expect(status()).toBe("unlocked");
    await act(async () => {
      provider.emit("accountsChanged", []);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(status()).toBe("none");
    expect(loadUnifiedWallet()).toBeNull();
  });

  it("never lets a provider event touch a local wallet", async () => {
    seedAppsWebWallet();
    const provider = eventedProvider(() => "dd".repeat(1952));
    mount();
    await waitFor(() => expect(status()).toBe("unlocked"));
    const before = ctx.publicKey;
    await act(async () => {
      provider.emit("accountsChanged", ["dd".repeat(1952)]);
      provider.emit("disconnect");
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(ctx.publicKey).toBe(before);
    expect(status()).toBe("unlocked");
    expect(provider.connect).not.toHaveBeenCalled();
  });

  it("re-registers an unlocked local wallet in the messenger directory on load", async () => {
    seedAppsWebWallet();
    const { calls } = mockFetch({ "/messenger/wallets": () => ({ success: true, wallets: [] }) });
    mount(true);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/v2/messenger/wallets/register") && c.init?.method === "POST")).toBe(true));
  });

  it("signs locally through core with a verifiable ML-DSA-65 signature", () => {
    const w = seedAppsWebWallet();
    mount();
    expect(signer?.kind).toBe("local");
    return signer!.sign({ type: "transfer", from: w.signingPublicKey, to: "x", amount: 1, fee: 0.1, token: "XRGE", timestamp: 1, nonce: generateNonce() }).then((tx) => {
      expect(verifyTransaction(tx)).toBe(true);
    });
  });

  it("auto-locks after the configured inactivity", async () => {
    seedAppsWebWallet();
    await lockUnifiedWallet("pw-autolock");
    await unlockUnifiedWallet("pw-autolock");
    saveVaultSettings({ autoLockMinutes: 1 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      mount();
      expect(status()).toBe("unlocked");
      expect(ctx.autoLockMinutes).toBe(1);
      act(() => {
        vi.advanceTimersByTime(61_000);
      });
      expect(status()).toBe("locked");
      expect(isWalletLocked()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("seed-derived messaging key (same as Qwalla)", () => {
  const PHRASE_A =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon " +
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
  // sha256(ML-KEM-768 public key hex) that Qwalla's deriveRougeeKem produces for PHRASE_A.
  const QWALLA_KEM_PUB_SHA_A = "247ad31332921ff43fada11b8d3a0f7373b13add2c6e122e81ed89917d79b72a";
  const sha = (s: string) => Array.from(sha256(new TextEncoder().encode(s))).map((b) => b.toString(16).padStart(2, "0")).join("");
  const derived = (w: { mnemonic?: string; signingPrivateKey: string }) => deriveMessagingKeypair(w.mnemonic ?? null, w.signingPrivateKey);

  it("create derives the messaging key from the new wallet's recovery phrase", async () => {
    mount();
    await act(() => ctx.create());
    const w = ctx.wallet!;
    expect(w.encryptionPublicKey).toBe(derived(w).publicKey);
    expect(w.encryptionPrivateKey).toBe(derived(w).privateKey);
    await act(() => ctx.setPassword("s3cret-pass"));
    act(() => ctx.lock());
    await act(() => ctx.unlock("s3cret-pass"));
    expect(ctx.wallet?.encryptionPublicKey).toBe(derived(w).publicKey);
  });

  it("phrase import restores Qwalla's messaging key (normalized phrase), replacing nothing stored", async () => {
    mount();
    await act(() => ctx.importMnemonic(`  ${PHRASE_A.toUpperCase()}  `));
    expect(ctx.wallet?.mnemonic).toBe(PHRASE_A);
    expect(sha(ctx.wallet!.encryptionPublicKey)).toBe(QWALLA_KEM_PUB_SHA_A);
    expect(ctx.wallet?.encryptionPrivateKey).toBe(deriveMessagingKeypair(PHRASE_A, ctx.wallet!.signingPrivateKey).privateKey);
  });

  it("phrase import of an older website wallet (random key) gets the derived key", async () => {
    const old = seedAppsWebWallet();
    resetBrowserState();
    mockFetch();
    mount();
    await act(() => ctx.importMnemonic(old.mnemonic!));
    expect(ctx.publicKey).toBe(old.signingPublicKey);
    expect(ctx.wallet?.encryptionPublicKey).toBe(derived(old).publicKey);
    expect(ctx.wallet?.encryptionPublicKey).not.toBe(old.encryptionPublicKey);
  });

  it("a .pqcbackup WITH messaging keys keeps them exactly", async () => {
    const { encryptWallet } = await import("@rougechain/core/unified-wallet");
    const w = seedAppsWebWallet(); // random (pre-change) messaging key
    const blob = await encryptWallet(w, "backup-pass");
    resetBrowserState();
    mockFetch();
    mount();
    await act(() => ctx.importBackup(blob, "backup-pass"));
    expect(ctx.wallet?.encryptionPublicKey).toBe(w.encryptionPublicKey);
    expect(ctx.wallet?.encryptionPrivateKey).toBe(w.encryptionPrivateKey);
  });

  it("a .pqcbackup WITHOUT messaging keys gets the seed-derived pair (mnemonic, else signing key)", async () => {
    const { encryptWallet } = await import("@rougechain/core/unified-wallet");
    const w = seedAppsWebWallet();
    const noKeys = { ...w, encryptionPublicKey: "", encryptionPrivateKey: "" };
    const blob = await encryptWallet(noKeys, "backup-pass");
    const blobNoPhrase = await encryptWallet({ ...noKeys, mnemonic: undefined }, "backup-pass");
    resetBrowserState();
    mockFetch();
    mount();
    await act(() => ctx.importBackup(blob, "backup-pass"));
    expect(ctx.wallet?.encryptionPublicKey).toBe(derived(w).publicKey);
    await act(() => ctx.importBackup(blobNoPhrase, "backup-pass"));
    expect(ctx.wallet?.encryptionPublicKey).toBe(deriveMessagingKeypair(null, w.signingPrivateKey).publicKey);
  }, 60_000);

  it("moves a stored phrase wallet with a random key to the derived key and keeps the old key (session, legacy plaintext, vault)", async () => {
    const w = seedAppsWebWallet(); // session copy, random messaging key
    expect(w.encryptionPublicKey).not.toBe(derived(w).publicKey);
    const view = mount(true);
    expect(ctx.wallet?.encryptionPublicKey).toBe(derived(w).publicKey);
    expect(ctx.wallet?.encryptionPrivateKey).toBe(derived(w).privateKey);
    expect(ctx.wallet?.legacyEncryptionPublicKey).toBe(w.encryptionPublicKey);
    expect(ctx.wallet?.legacyEncryptionPrivateKey).toBe(w.encryptionPrivateKey);
    view.unmount();

    sessionStorage.clear();
    localStorage.setItem("pqc-unified-wallet:mainnet", JSON.stringify(w)); // legacy plaintext
    resetWalletStoreForTests();
    mount();
    expect(ctx.wallet?.encryptionPublicKey).toBe(w.encryptionPublicKey); // untouched until unlock / page load
    await act(() => ctx.setPassword("vault-pass-1"));
    act(() => ctx.lock());
    await act(() => ctx.unlock("vault-pass-1"));
    expect(ctx.wallet?.encryptionPublicKey).toBe(derived(w).publicKey);
    expect(ctx.wallet?.legacyEncryptionPublicKey).toBe(w.encryptionPublicKey);
    expect(ctx.wallet?.legacyEncryptionPrivateKey).toBe(w.encryptionPrivateKey);
    // a second lock / unlock re-encrypts the migrated wallet: the old key must survive it
    act(() => ctx.lock());
    await act(() => ctx.unlock("vault-pass-1"));
    expect(ctx.wallet?.encryptionPublicKey).toBe(derived(w).publicKey);
    expect(ctx.wallet?.legacyEncryptionPrivateKey).toBe(w.encryptionPrivateKey);
  }, 60_000);
});

describe("cross-tab sync", () => {
  it("picks up a wallet created in another tab (storage event on a wallet key)", () => {
    mount();
    expect(status()).toBe("none");
    const w = seedAppsWebWallet(); // another tab wrote localStorage
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "pqc-unified-wallet:mainnet" }));
    });
    expect(status()).toBe("unlocked");
    expect(screen.getByTestId("pubkey").textContent).toBe(w.signingPublicKey);
  });

  it("locks when another tab locks, and drops this tab's session copy of the keys", async () => {
    seedAppsWebWallet();
    await lockUnifiedWallet("pw-crosstab");
    await unlockUnifiedWallet("pw-crosstab");
    mount();
    expect(status()).toBe("unlocked");
    act(() => {
      localStorage.setItem("pqc-unified-wallet-locked:mainnet", "true"); // other tab's autoLockWallet
      window.dispatchEvent(new StorageEvent("storage", { key: "pqc-unified-wallet-locked:mainnet" }));
    });
    expect(status()).toBe("locked");
    expect(sessionStorage.getItem("pqc-unified-wallet:mainnet")).toBeNull();
  });

  it("ignores unrelated storage keys and follows rougechain:profile-changed", () => {
    const w = seedAppsWebWallet();
    mount();
    const before = ctx;
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "something-else" }));
    });
    expect(ctx.wallet).toBe(before.wallet);
    saveUnifiedWallet({ ...w, displayName: "Renamed" });
    act(() => {
      window.dispatchEvent(new CustomEvent(PROFILE_CHANGED_EVENT));
    });
    expect(screen.getByTestId("name").textContent).toBe("Renamed");
  });
});

it("snapshot precedence matches apps/web: the locked flag wins over a session wallet", () => {
  seedAppsWebWallet();
  localStorage.setItem("pqc-unified-wallet-locked:mainnet", "true");
  expect(readWalletSnapshot().status).toBe("locked");
});
