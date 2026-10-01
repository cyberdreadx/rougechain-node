/**
 * Test helpers: seed wallets EXACTLY the way apps/web does (core functions only), dump storage,
 * and a fetch mock that never reaches a real node.
 */
import { vi } from "vitest";
import { generateMnemonic, keypairFromMnemonic } from "@rougechain/core/mnemonic";
import { generateEncryptionKeypair } from "@rougechain/core/pqc-messenger";
import { lockUnifiedWallet, saveUnifiedWallet, type UnifiedWallet } from "@rougechain/core/unified-wallet";
import { resetWalletStoreForTests } from "./store";
import { clearToasts } from "./toast";

/** apps/web Wallet.tsx `createNewWallet` (mnemonic → ML-DSA-65, ML-KEM-768, saveUnifiedWallet). */
export function seedAppsWebWallet(overrides: Partial<UnifiedWallet> = {}): UnifiedWallet {
  const mnemonic = generateMnemonic();
  const { publicKey, secretKey } = keypairFromMnemonic(mnemonic);
  const enc = generateEncryptionKeypair();
  const wallet: UnifiedWallet = {
    id: `wallet-${Date.now()}`,
    displayName: "My Wallet",
    createdAt: Date.now(),
    signingPublicKey: publicKey,
    signingPrivateKey: secretKey,
    encryptionPublicKey: enc.publicKey,
    encryptionPrivateKey: enc.privateKey,
    version: 2,
    mnemonic,
    ...overrides,
  };
  saveUnifiedWallet(wallet);
  return wallet;
}

/** apps/web "password setup" + "lock": lockUnifiedWallet(password) (vault blob, locked flag, metadata). */
export async function seedAppsWebLockedWallet(password = "correct horse"): Promise<UnifiedWallet> {
  const w = seedAppsWebWallet();
  await lockUnifiedWallet(password);
  return w;
}

export function dumpStorage(storage: Storage): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i)!;
    out[k] = storage.getItem(k)!;
  }
  return out;
}

export function resetBrowserState(): void {
  localStorage.clear();
  sessionStorage.clear();
  resetWalletStoreForTests();
  clearToasts();
  Reflect.deleteProperty(window, "rougechain");
}

export type Handler = (url: string, init?: RequestInit) => unknown;

/**
 * fetch mock: routes by URL substring; unmatched GETs fail like an offline node. Every call is
 * recorded so tests can assert which API base and endpoints were used.
 */
export function mockFetch(routes: Record<string, Handler> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    for (const [part, handler] of Object.entries(routes)) {
      if (url.includes(part)) {
        const body = handler(url, init);
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }
    }
    throw new TypeError(`offline: ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}
