/**
 * Wallet state for site-next, read ONLY through @rougechain/core so a visitor moving from
 * apps/web to site-next on the same origin keeps the same wallet, lock state and settings.
 *
 * This module never writes browser storage itself: every write goes through core functions
 * (saveUnifiedWallet, lockUnifiedWallet, ...), which own the key names and formats.
 */
import {
  getLockedWalletMetadata,
  hasEncryptedWallet,
  isWalletLocked,
  isWalletPending,
  loadUnifiedWallet,
  type UnifiedWallet,
} from "@rougechain/core/unified-wallet";
import { getActiveNetwork, NETWORK_STORAGE_KEY, type NetworkType } from "@rougechain/core/network";
import { PROFILE_CHANGED_EVENT } from "@rougechain/core/avatar";

export type WalletStatus = "none" | "locked" | "unlocked";

export interface WalletSnapshot {
  status: WalletStatus;
  network: NetworkType;
  /** The unlocked wallet (private keys included, in memory only). null unless unlocked. */
  wallet: UnifiedWallet | null;
  /** Signing public key: from the wallet, or the public metadata while locked. */
  publicKey: string | null;
  displayName: string | null;
  /** Connected through the browser extension / Qwalla dApp browser (no local private key). */
  isExtension: boolean;
  /** A password vault exists (so lock / auto-lock are possible). */
  hasPassword: boolean;
  /**
   * The unlocked wallet holds private keys that are NOT protected by the vault: a wallet staged by
   * create / import whose password is not set yet, or a legacy wallet an older build stored in
   * plaintext. The user must set a password before using it (SecureWalletGate).
   */
  needsPassword: boolean;
  /** needsPassword because of an unfinished create / import in this tab (vs. a legacy wallet). */
  pending: boolean;
}

/**
 * Storage keys whose change (in ANOTHER tab: `storage` events) can change wallet state.
 * Core scopes the wallet keys per network (`pqc-unified-wallet:mainnet`, ...), so these are prefixes.
 */
export const WATCHED_KEY_PREFIXES = [
  "pqc-unified-wallet", // unified / encrypted / locked / metadata / vault-settings (all scoped)
  "pqc_messenger_wallet",
  "pqc-blockchain-wallet",
  "rougechain-profile-", // per-key display names / avatars (core avatar.ts)
  NETWORK_STORAGE_KEY,
] as const;

export function isWatchedKey(key: string | null): boolean {
  // key === null: storage.clear() in another tab.
  return key === null || WATCHED_KEY_PREFIXES.some((p) => key.startsWith(p));
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Same precedence as apps/web's Wallet page: the locked flag wins, then a loaded wallet. */
export function readWalletSnapshot(): WalletSnapshot {
  const network = safe(getActiveNetwork, "mainnet" as NetworkType);
  const hasPassword = safe(hasEncryptedWallet, false);
  const lockedFlag = safe(isWalletLocked, false);
  const wallet = lockedFlag ? null : safe(loadUnifiedWallet, null);

  if (wallet) {
    const hasKeys = !!(wallet.signingPrivateKey || wallet.encryptionPrivateKey);
    const pending = hasKeys && safe(isWalletPending, false);
    return {
      status: "unlocked",
      network,
      wallet,
      publicKey: wallet.signingPublicKey,
      displayName: wallet.displayName,
      isExtension: !wallet.signingPrivateKey,
      hasPassword,
      needsPassword: hasKeys && (!hasPassword || pending),
      pending,
    };
  }
  // Locked flag set, or a password vault exists but this tab has no session copy of the keys
  // (sessionStorage is per tab): the vault must be unlocked here.
  if (lockedFlag || hasPassword) {
    const meta = safe(getLockedWalletMetadata, null);
    return {
      status: "locked",
      network,
      wallet: null,
      publicKey: meta?.signingPublicKey ?? null,
      displayName: meta?.displayName ?? null,
      isExtension: false,
      hasPassword,
      needsPassword: false,
      pending: false,
    };
  }
  return { status: "none", network, wallet: null, publicKey: null, displayName: null, isExtension: false, hasPassword, needsPassword: false, pending: false };
}

function sameSnapshot(a: WalletSnapshot, b: WalletSnapshot): boolean {
  return (
    a.status === b.status &&
    a.network === b.network &&
    a.publicKey === b.publicKey &&
    a.displayName === b.displayName &&
    a.isExtension === b.isExtension &&
    a.hasPassword === b.hasPassword &&
    a.needsPassword === b.needsPassword &&
    a.pending === b.pending &&
    a.wallet?.signingPrivateKey === b.wallet?.signingPrivateKey &&
    a.wallet?.encryptionPublicKey === b.wallet?.encryptionPublicKey &&
    a.wallet?.mnemonic === b.wallet?.mnemonic &&
    a.wallet?.avatarUrl === b.wallet?.avatarUrl &&
    a.wallet?.id === b.wallet?.id
  );
}

// ---- external store (useSyncExternalStore) ----

const listeners = new Set<() => void>();
let cached: WalletSnapshot | null = null;
let dirty = true;

/** Re-read wallet state (call after any core write in this tab) and notify subscribers. */
export function notifyWalletChanged(): void {
  dirty = true;
  for (const l of [...listeners]) l();
}

export function getWalletSnapshot(): WalletSnapshot {
  if (!dirty && cached) return cached;
  const next = readWalletSnapshot();
  dirty = false;
  if (!cached || !sameSnapshot(cached, next)) cached = next;
  return cached;
}

export const SERVER_SNAPSHOT: WalletSnapshot = {
  status: "none",
  network: "mainnet",
  wallet: null,
  publicKey: null,
  displayName: null,
  isExtension: false,
  hasPassword: false,
  needsPassword: false,
  pending: false,
};

/**
 * Subscribe to wallet changes: same-tab notifications, other tabs' `storage` events on the
 * wallet / network keys, core's `rougechain:profile-changed`, and tab focus / visibility.
 */
export function subscribeWallet(onChange: () => void): () => void {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (isWatchedKey(e.key)) notifyWalletChanged();
  };
  const onProfile = () => notifyWalletChanged();
  const onVisible = () => {
    if (document.visibilityState === "visible") notifyWalletChanged();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(PROFILE_CHANGED_EVENT, onProfile);
  window.addEventListener("focus", onProfile);
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(PROFILE_CHANGED_EVENT, onProfile);
    window.removeEventListener("focus", onProfile);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

/** Test helper: forget the cached snapshot (storage was reset between tests). */
export function resetWalletStoreForTests(): void {
  cached = null;
  dirty = true;
}
