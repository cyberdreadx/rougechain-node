/**
 * Profile (display name + avatar) for the site wallet. Updates the local wallet
 * and re-registers the MESSAGING identity with the node so peers see it in the
 * directory. For an extension wallet (no local signing key) the messaging
 * identity is the device-local messenger key (see resolveMessagingWallet).
 */
import {
  PROFILE_CHANGED_EVENT,
  fitsAvatarLimit,
  getStoredAvatar,
  isSafeAvatarUrl,
  setStoredAvatar,
  setStoredDisplayName,
} from "./avatar";
import {
  loadLocalWallet,
  registerWalletOnNode,
  resolveMessagingWallet,
  saveWalletLocally,
  type WalletWithPrivateKeys,
} from "./pqc-messenger";
import { loadUnifiedWallet, saveUnifiedWallet, toMessengerWallet, type UnifiedWallet } from "./unified-wallet";
import { invalidateWalletDirectory, setLocalDirectoryAvatar } from "./wallet-directory";

/** The identity that signs messenger / mail requests for this wallet. */
export async function getMessagingIdentity(wallet: UnifiedWallet): Promise<WalletWithPrivateKeys> {
  return resolveMessagingWallet(toMessengerWallet(wallet) as WalletWithPrivateKeys);
}

/** My avatar as this device knows it (the per-key store wins over the wallet copy). */
export function getProfileAvatar(wallet: UnifiedWallet | null | undefined): string | undefined {
  if (!wallet) return undefined;
  const stored = getStoredAvatar(wallet.signingPublicKey);
  if (stored === null) return undefined;
  if (isSafeAvatarUrl(stored)) return stored;
  return isSafeAvatarUrl(wallet.avatarUrl) ? wallet.avatarUrl : undefined;
}

function notify(): void {
  try {
    window.dispatchEvent(new CustomEvent(PROFILE_CHANGED_EVENT));
  } catch {
    /* non-browser */
  }
}

/** Set (data URI / https URL) or remove (null) my profile photo and publish it to the directory. */
export async function setProfileAvatar(url: string | null): Promise<void> {
  const wallet = loadUnifiedWallet();
  if (!wallet) throw new Error("No wallet loaded");
  if (url !== null && (!isSafeAvatarUrl(url) || !fitsAvatarLimit(url))) {
    throw new Error("Avatar must be an image under 256 KB");
  }

  const updated: UnifiedWallet = { ...wallet };
  if (url) updated.avatarUrl = url;
  else delete updated.avatarUrl;
  saveUnifiedWallet(updated);
  setStoredAvatar(wallet.signingPublicKey, url);

  // Extension wallets message through a device-local key: record the avatar for it
  // BEFORE resolving (resolving fires a background re-register that reads the store).
  const isLocalIdentity = !wallet.signingPrivateKey;
  const local = isLocalIdentity ? loadLocalWallet() : null;
  if (local?.signingPublicKey) setStoredAvatar(local.signingPublicKey, url);

  const mw = await getMessagingIdentity(updated);
  if (mw.signingPublicKey !== wallet.signingPublicKey) setStoredAvatar(mw.signingPublicKey, url);

  setLocalDirectoryAvatar(
    [wallet.id, wallet.signingPublicKey, wallet.encryptionPublicKey, mw.id, mw.signingPublicKey, mw.encryptionPublicKey],
    url,
  );
  notify();

  // Explicit avatarUrl: "" means "none" for registerWalletOnNode.
  await registerWalletOnNode({ ...mw, avatarUrl: url ?? "" }, isLocalIdentity ? false : undefined);
  invalidateWalletDirectory();
}

/** Rename me. Registers first so a "name already taken" error leaves the local name unchanged. */
export async function setProfileDisplayName(name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) throw new Error("Name can't be empty");
  if (clean.length > 50) throw new Error("Name is too long (max 50 characters)");
  const wallet = loadUnifiedWallet();
  if (!wallet) throw new Error("No wallet loaded");

  const updated: UnifiedWallet = { ...wallet, displayName: clean };
  const isLocalIdentity = !wallet.signingPrivateKey;
  let mw = await getMessagingIdentity(updated);
  if (isLocalIdentity) {
    mw = { ...mw, displayName: clean };
    await registerWalletOnNode(mw, false);
    saveWalletLocally(mw);
  } else {
    await registerWalletOnNode(mw);
  }
  saveUnifiedWallet(updated);
  setStoredDisplayName(wallet.signingPublicKey, clean);
  invalidateWalletDirectory();
  notify();
}
