/**
 * Production wallet provider for site-next. All storage, crypto and signing go through
 * @rougechain/core — the same code apps/web runs — so an apps/web wallet (same origin) is read
 * back as-is: same keys, vault format, lock state and address.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  autoLockWallet,
  clearUnifiedWallet,
  decryptWallet,
  getVaultSettings,
  isWalletLocked,
  loadUnifiedWallet,
  lockUnifiedWallet,
  MIN_VAULT_PASSWORD_LENGTH,
  saveUnifiedWallet,
  saveVaultSettings,
  stageUnifiedWallet,
  unlockUnifiedWallet,
  type UnifiedWallet,
} from "@rougechain/core/unified-wallet";
import { generateMnemonic, keypairFromMnemonic, validateMnemonic } from "@rougechain/core/mnemonic";
import { registerWalletOnNode } from "@rougechain/core/pqc-messenger";
import { deriveMessagingKeypair, migrateToDerivedMessagingKeys, withDerivedMessagingKeys } from "@rougechain/core/messaging-keys";
import { getRougeChainProvider, signViaExtension } from "@rougechain/core/extension-bridge";
import { signTransaction, type SignedTransaction, type TransactionPayload } from "@rougechain/core/pqc-signer";
import { useChain } from "../explorer/chain";
import {
  SERVER_SNAPSHOT,
  getWalletSnapshot,
  notifyWalletChanged,
  subscribeWallet,
  type WalletSnapshot,
} from "./store";
import { setOnboardingActive } from "./tour";
import { networkLabel, useExtensionProvider, useRougeAddress } from "./hooks";
import i18n from "../i18n";
import { toast } from "./toast";

export type OnboardingMode = "create" | "import";
/** Post-create / post-import steps shown on /wallet (same order as apps/web). */
export type FlowStep = "seed" | "password" | "onboarding";
export interface WalletFlow {
  mode: OnboardingMode;
  step: FlowStep;
}

export interface WalletContextValue extends WalletSnapshot {
  flow: WalletFlow | null;
  autoLockMinutes: number;
  create(): Promise<void>;
  importMnemonic(phrase: string): Promise<void>;
  importBackup(data: string, password: string): Promise<void>;
  connectExtension(): Promise<void>;
  /**
   * First password (encrypts the vault) — same as apps/web: lock with it, then unlock. Required to
   * finish create / import and to keep using a legacy plaintext wallet; min 8 characters.
   */
  setPassword(password: string): Promise<void>;
  unlock(password: string): Promise<void>;
  lock(): void;
  disconnect(): void;
  setAutoLockMinutes(minutes: number): void;
  advanceFlow(step: FlowStep | null): void;
  refresh(): void;
}

const WalletContext = createContext<WalletContextValue | null>(null);

/** Activity that postpones auto-lock (same events as apps/web). */
const ACTIVITY_EVENTS = ["mousemove", "keydown", "touchstart"] as const;

export class WalletError extends Error {}

function readAutoLockMinutes(): number {
  try {
    return getVaultSettings().autoLockMinutes;
  } catch {
    return 0; // storage unavailable
  }
}

/** Parse + validate a recovery phrase exactly like apps/web's WalletBackup "Recover". */
export function normalizeRecoveryPhrase(phrase: string): string {
  const trimmed = phrase.trim().toLowerCase().split(/\s+/).join(" ");
  const words = trimmed ? trimmed.split(" ") : [];
  if (words.length !== 12 && words.length !== 24) throw new WalletError(i18n.t("wallet:import.errors.phraseLength"));
  if (!validateMnemonic(trimmed)) throw new WalletError(i18n.t("wallet:import.errors.phraseInvalid"));
  return trimmed;
}

function extensionWallet(result: { publicKey: string; displayName?: string; encryptionPublicKey?: string }): UnifiedWallet {
  // Same shape apps/web saves for an extension / Qwalla dApp-browser wallet (empty private keys).
  return {
    id: `ext-${Date.now()}`,
    displayName: result.displayName || "Extension Wallet",
    createdAt: Date.now(),
    signingPublicKey: result.publicKey,
    signingPrivateKey: "",
    encryptionPublicKey: result.encryptionPublicKey || "",
    encryptionPrivateKey: "",
    version: 2,
  };
}

/**
 * Once per page load, (re-)register an unlocked local wallet in the messenger directory (as
 * apps/web's `WalletAutoRegister`). It deliberately does NOT auto-connect the browser extension:
 * the extension's connect() opens an approval prompt on any site it hasn't approved yet, and a
 * site must never ask for a wallet connection before the user clicks Connect. An extension wallet
 * connected once is remembered by the site (saved like any wallet), so later visits need no prompt.
 */
export function useWalletAutoRegister(enabled: boolean): void {
  const done = useRef(false);
  useEffect(() => {
    if (!enabled || done.current || isWalletLocked()) return;
    done.current = true;
    let w = loadUnifiedWallet();
    // A wallet restored from this tab's session did not go through unlock: move it to the
    // phrase-derived messaging key here (old key kept as a decrypt-only fallback).
    if (w) {
      const migrated = migrateToDerivedMessagingKeys(w);
      if (migrated !== w) {
        saveUnifiedWallet(migrated);
        notifyWalletChanged();
        w = migrated;
      }
    }
    if (w?.signingPublicKey && w.encryptionPublicKey && w.signingPrivateKey) {
      registerWalletOnNode({
        id: w.id,
        displayName: w.displayName,
        signingPublicKey: w.signingPublicKey,
        signingPrivateKey: w.signingPrivateKey,
        encryptionPublicKey: w.encryptionPublicKey,
      }).catch(() => {});
    }
  }, [enabled]);
}

export function WalletProvider({ children, autoRegister = true }: { children: ReactNode; autoRegister?: boolean }) {
  const snapshot = useSyncExternalStore(subscribeWallet, getWalletSnapshot, () => SERVER_SNAPSHOT);
  const { network: chainNetwork } = useChain();
  const [flow, setFlow] = useState<WalletFlow | null>(null);
  const [autoLockMinutes, setAutoLockState] = useState(readAutoLockMinutes);

  // The explorer's network switch writes the shared `rougechain-network` key in this tab:
  // core scopes the wallet keys per network, so re-read.
  useEffect(() => {
    notifyWalletChanged();
  }, [chainNetwork]);
  useEffect(() => {
    setAutoLockState(readAutoLockMinutes());
  }, [snapshot.network]);

  useWalletAutoRegister(autoRegister);

  // A lock in another tab (storage event) also drops THIS tab's session copy of the keys.
  const prevStatus = useRef(snapshot.status);
  useEffect(() => {
    if (prevStatus.current === "unlocked" && snapshot.status === "locked" && isWalletLocked()) autoLockWallet();
    prevStatus.current = snapshot.status;
  }, [snapshot.status]);

  // Auto-lock after inactivity (vault settings are per network, set in Settings).
  const [lastActivity, setLastActivity] = useState(() => Date.now());
  useEffect(() => {
    if (snapshot.status !== "unlocked") return;
    const onActivity = () => setLastActivity(Date.now());
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, onActivity));
    return () => ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, onActivity));
  }, [snapshot.status]);
  useEffect(() => {
    // Not while a staged wallet still needs its password: locking would drop it from the session.
    if (snapshot.status !== "unlocked" || !snapshot.hasPassword || snapshot.needsPassword || autoLockMinutes <= 0) return;
    const id = window.setTimeout(() => {
      autoLockWallet();
      notifyWalletChanged();
      toast.info(i18n.t("wallet:lock.locked"), { description: i18n.t("wallet:lock.autoLocked") });
    }, autoLockMinutes * 60_000);
    return () => window.clearTimeout(id);
  }, [snapshot.status, snapshot.hasPassword, snapshot.needsPassword, autoLockMinutes, lastActivity]);

  // Keep the tour from auto-opening while a create / import flow runs or a password is required.
  useEffect(() => {
    setOnboardingActive(flow !== null || snapshot.needsPassword);
  }, [flow, snapshot.needsPassword]);

  // Follow the extension / Qwalla provider when the user switches accounts or disconnects there.
  // Only a wallet that came from the provider (no local keys) is touched; a local wallet never is.
  const provider = useExtensionProvider();
  useEffect(() => {
    if (!provider?.on) return;
    const onAccounts = (...args: unknown[]) => {
      const accounts = Array.isArray(args[0]) ? (args[0] as unknown[]) : [];
      const next = typeof accounts[0] === "string" ? accounts[0] : null;
      const current = loadUnifiedWallet();
      if (!current || current.signingPrivateKey) return;
      if (!next) {
        clearUnifiedWallet();
        setFlow(null);
        notifyWalletChanged();
        return;
      }
      if (next === current.signingPublicKey) return;
      // connect() on an already-approved site answers without a prompt and carries the new
      // account's display name / messaging key when the provider has them.
      provider
        .connect()
        .then((result) => {
          if (!result?.publicKey || result.publicKey !== next) return;
          saveUnifiedWallet(extensionWallet(result));
          notifyWalletChanged();
        })
        .catch(() => {});
    };
    const onDisconnect = () => onAccounts([]);
    provider.on("accountsChanged", onAccounts);
    provider.on("disconnect", onDisconnect);
    return () => {
      provider.removeListener?.("accountsChanged", onAccounts);
      provider.removeListener?.("disconnect", onDisconnect);
    };
  }, [provider]);

  const create = useCallback(async () => {
    const mnemonic = generateMnemonic();
    const { publicKey, secretKey } = keypairFromMnemonic(mnemonic);
    // Seed-derived (same as Qwalla): the recovery phrase alone restores the messaging key.
    const enc = deriveMessagingKeypair(mnemonic, secretKey);
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
    };
    // Session only until the password step encrypts it: never plaintext in localStorage.
    stageUnifiedWallet(wallet);
    notifyWalletChanged();
    registerWalletOnNode({
      id: wallet.id,
      displayName: wallet.displayName,
      signingPublicKey: wallet.signingPublicKey,
      encryptionPublicKey: wallet.encryptionPublicKey,
    }).catch(() => {});
    setFlow({ mode: "create", step: "seed" });
  }, []);

  const afterImport = useCallback((wallet: UnifiedWallet) => {
    // Session only until a password encrypts it. The password step is mandatory, also when a vault
    // already exists (it then replaces that vault with the imported wallet).
    stageUnifiedWallet(wallet);
    notifyWalletChanged();
    setFlow({ mode: "import", step: "password" });
  }, []);

  const importMnemonic = useCallback(
    async (phrase: string) => {
      const mnemonic = normalizeRecoveryPhrase(phrase);
      const { publicKey, secretKey } = keypairFromMnemonic(mnemonic);
      const enc = deriveMessagingKeypair(mnemonic, secretKey);
      afterImport({
        id: `wallet-${Date.now()}`,
        displayName: "Recovered Wallet",
        createdAt: Date.now(),
        signingPublicKey: publicKey,
        signingPrivateKey: secretKey,
        encryptionPublicKey: enc.publicKey,
        encryptionPrivateKey: enc.privateKey,
        version: 2,
        mnemonic,
      });
    },
    [afterImport],
  );

  const importBackup = useCallback(
    async (data: string, password: string) => {
      if (!data.trim()) throw new WalletError(i18n.t("wallet:import.errors.noData"));
      if (!password) throw new WalletError(i18n.t("wallet:import.errors.noPassword"));
      let wallet: UnifiedWallet;
      try {
        wallet = await decryptWallet(data.trim(), password);
      } catch {
        throw new WalletError(i18n.t("wallet:import.errors.badBackup"));
      }
      // A backup's own messaging keys are kept exactly; only one without them gets the seed-derived pair.
      afterImport(withDerivedMessagingKeys(wallet));
    },
    [afterImport],
  );

  const connectExtension = useCallback(async () => {
    const provider = getRougeChainProvider();
    if (!provider) throw new WalletError(i18n.t("wallet:extension.notFound"));
    const result = await provider.connect();
    if (!result?.publicKey) throw new WalletError(i18n.t("wallet:extension.noKey"));
    saveUnifiedWallet(extensionWallet(result));
    notifyWalletChanged();
  }, []);

  const setPassword = useCallback(async (password: string) => {
    if (password.length < MIN_VAULT_PASSWORD_LENGTH) {
      throw new WalletError(i18n.t("wallet:backup.passwordMin", { count: MIN_VAULT_PASSWORD_LENGTH }));
    }
    await lockUnifiedWallet(password); // encrypts + removes any plaintext copy
    await unlockUnifiedWallet(password);
    notifyWalletChanged();
  }, []);

  const unlock = useCallback(async (password: string) => {
    try {
      await unlockUnifiedWallet(password);
    } catch {
      throw new WalletError(i18n.t("wallet:unlock.wrongPassword"));
    } finally {
      notifyWalletChanged();
    }
  }, []);

  const lock = useCallback(() => {
    autoLockWallet(); // no-op without a password vault (as in apps/web)
    notifyWalletChanged();
  }, []);

  const disconnect = useCallback(() => {
    clearUnifiedWallet();
    setFlow(null);
    notifyWalletChanged();
  }, []);

  const setAutoLockMinutes = useCallback((minutes: number) => {
    saveVaultSettings({ ...getVaultSettings(), autoLockMinutes: minutes });
    setAutoLockState(minutes);
  }, []);

  const advanceFlow = useCallback((step: FlowStep | null) => {
    setFlow((f) => (f && step ? { ...f, step } : null));
  }, []);

  const value = useMemo<WalletContextValue>(
    () => ({
      ...snapshot,
      flow,
      autoLockMinutes,
      create,
      importMnemonic,
      importBackup,
      connectExtension,
      setPassword,
      unlock,
      lock,
      disconnect,
      setAutoLockMinutes,
      advanceFlow,
      refresh: notifyWalletChanged,
    }),
    [snapshot, flow, autoLockMinutes, create, importMnemonic, importBackup, connectExtension, setPassword, unlock, lock, disconnect, setAutoLockMinutes, advanceFlow],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("WalletProvider is required");
  return ctx;
}

/** The wallet context, or null where no WalletProvider is mounted (e.g. the standalone explorer site). */
export function useOptionalWallet(): WalletContextValue | null {
  return useContext(WalletContext);
}

export interface Signer {
  kind: "local" | "extension";
  publicKey: string;
  sign(payload: TransactionPayload): Promise<SignedTransaction>;
}

/**
 * Signing for the unlocked wallet, through core only: local ML-DSA-65 keys, or the extension /
 * Qwalla provider when the wallet has no local private key. null when nothing can sign.
 */
export function useSigner(): Signer | null {
  const { wallet } = useWallet();
  return useMemo(() => {
    if (!wallet) return null;
    const publicKey = wallet.signingPublicKey;
    if (wallet.signingPrivateKey) {
      const priv = wallet.signingPrivateKey;
      return { kind: "local", publicKey, sign: async (p) => signTransaction(p, priv, publicKey) };
    }
    return { kind: "extension", publicKey, sign: (p) => signViaExtension(p, publicKey) };
  }, [wallet]);
}

/** Display identity for shells / previews: connected (unlocked), locked, short rouge1 address. */
export function useWalletIdentity(): { connected: boolean; locked: boolean; short: string; address: string | null; networkLabel: string } {
  const { status, publicKey, network } = useWallet();
  const { full, display } = useRougeAddress(publicKey);
  return {
    connected: status === "unlocked",
    locked: status === "locked",
    short: display,
    address: full,
    networkLabel: networkLabel(network),
  };
}
