import { useEffect, useState } from "react";
import { PROFILE_CHANGED_EVENT } from "@/lib/avatar";
import { getProfileAvatar } from "@/lib/profile";
import { getLockedWalletMetadata, isWalletLocked, loadUnifiedWallet, type UnifiedWallet } from "@/lib/unified-wallet";

export interface MyProfile {
  wallet: UnifiedWallet | null;
  /** Public key even while locked (from the public metadata). */
  signingPublicKey?: string;
  displayName?: string;
  avatar?: string;
}

function read(): MyProfile {
  if (isWalletLocked()) {
    const meta = getLockedWalletMetadata();
    return { wallet: null, signingPublicKey: meta?.signingPublicKey, displayName: meta?.displayName };
  }
  const wallet = loadUnifiedWallet();
  return {
    wallet,
    signingPublicKey: wallet?.signingPublicKey,
    displayName: wallet?.displayName,
    avatar: getProfileAvatar(wallet),
  };
}

/** The current wallet's name + avatar, refreshed when the profile changes or the tab regains focus. */
export function useMyProfile(): MyProfile & { refresh: () => void } {
  const [profile, setProfile] = useState<MyProfile>(read);
  useEffect(() => {
    const update = () => setProfile(read());
    window.addEventListener(PROFILE_CHANGED_EVENT, update);
    window.addEventListener("focus", update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(PROFILE_CHANGED_EVENT, update);
      window.removeEventListener("focus", update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return { ...profile, refresh: () => setProfile(read()) };
}
