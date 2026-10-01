/** Messenger / mail React hooks over core (identity resolution, device-local prefs, nicknames). */
import { useCallback, useEffect, useMemo, useState } from "react";
import { MESSENGER_PREFS_EVENT, getAcceptedChats, getBlockedList, getMutedConversations } from "@rougechain/core/messenger-prefs";
import { resolveMessagingWallet, type WalletWithPrivateKeys } from "@rougechain/core/pqc-messenger";
import { toMessengerWallet, type UnifiedWallet } from "@rougechain/core/unified-wallet";
import { getAllNicknames, setNickname as coreSetNickname } from "@rougechain/core/contact-nicknames";

/** Live mute / accepted / blocked sets (re-read whenever any messenger pref changes, in any tab). */
export function useMessengerPrefs() {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(MESSENGER_PREFS_EVENT, bump);
    window.addEventListener("storage", bump);
    return () => {
      window.removeEventListener(MESSENGER_PREFS_EVENT, bump);
      window.removeEventListener("storage", bump);
    };
  }, []);
  return useMemo(
    () => ({
      version,
      muted: new Set(getMutedConversations()),
      accepted: new Set(getAcceptedChats()),
      blocked: new Set(getBlockedList()),
    }),
    [version],
  );
}

export type IdentityState =
  | { status: "idle"; identity: null; error: null }
  | { status: "resolving"; identity: null; error: null }
  | { status: "ready"; identity: WalletWithPrivateKeys; error: null }
  | { status: "error"; identity: null; error: string };

/**
 * The identity that signs messenger / mail requests (apps/web Messenger.tsx + Mail.tsx):
 * a seed / imported wallet signs as itself; an extension wallet (no local key) falls back to the
 * device-local messenger key from core's resolveMessagingWallet. `override` switches to an
 * imported messaging identity for this session (apps/web "Import messaging ID").
 */
export function useMessagingIdentity(wallet: UnifiedWallet | null): IdentityState & { setOverride(w: WalletWithPrivateKeys | null): void } {
  const [state, setState] = useState<IdentityState>({ status: "idle", identity: null, error: null });
  const [override, setOverride] = useState<WalletWithPrivateKeys | null>(null);
  const key = wallet ? `${wallet.signingPublicKey}|${wallet.encryptionPublicKey}|${wallet.displayName}|${!!wallet.signingPrivateKey}` : "";

  useEffect(() => {
    if (!wallet) {
      setState({ status: "idle", identity: null, error: null });
      return;
    }
    const base = toMessengerWallet(wallet) as WalletWithPrivateKeys;
    if (base.signingPrivateKey) {
      setState({ status: "ready", identity: base, error: null });
      return;
    }
    let cancelled = false;
    setState({ status: "resolving", identity: null, error: null });
    resolveMessagingWallet(base)
      .then((w) => {
        if (!cancelled) setState({ status: "ready", identity: w, error: null });
      })
      .catch((e) => {
        if (!cancelled) setState({ status: "error", identity: null, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
    // `key` captures every wallet field the identity depends on.
  }, [key]);

  const merged: IdentityState = override && state.status === "ready" ? { status: "ready", identity: override, error: null } : state;
  return { ...merged, setOverride };
}

const NICKNAMES_EVENT = "rougechain:contact-nicknames";

/** Device-local contact nicknames (core contact-nicknames, key `pqc_contact_nicknames`). */
export function useNicknames() {
  const [all, setAll] = useState<Record<string, string>>(() => safeNicknames());
  useEffect(() => {
    const reload = () => setAll(safeNicknames());
    window.addEventListener(NICKNAMES_EVENT, reload);
    window.addEventListener("storage", reload);
    return () => {
      window.removeEventListener(NICKNAMES_EVENT, reload);
      window.removeEventListener("storage", reload);
    };
  }, []);
  /** Nickname for the first of `ids` that has one. */
  const nicknameFor = useCallback(
    (...ids: Array<string | undefined | null>) => {
      for (const id of ids) if (id && all[id]) return all[id];
      return null;
    },
    [all],
  );
  const setNickname = useCallback((id: string, name: string) => {
    try {
      coreSetNickname(id, name);
    } catch {
      /* storage unavailable */
    }
    window.dispatchEvent(new Event(NICKNAMES_EVENT));
  }, []);
  return { nicknameFor, setNickname };
}

function safeNicknames(): Record<string, string> {
  try {
    return getAllNicknames();
  } catch {
    return {};
  }
}

/** Track `(max-width: 640px)` so the list / chat split can collapse to one pane on phones. */
export function useIsPhone(): boolean {
  const q = "(max-width: 720px)";
  const [phone, setPhone] = useState(() => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(q).matches : false));
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(q);
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return phone;
}

/**
 * Height for a full-height app below the site header: viewport minus this element's top.
 * Recomputed on resize so the header's wrap / subnav doesn't push the composer off-screen.
 */
export function useFillHeight<T extends HTMLElement>(): [(el: T | null) => void, number | null] {
  const [el, setEl] = useState<T | null>(null);
  const [h, setH] = useState<number | null>(null);
  useEffect(() => {
    if (!el) return;
    const measure = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      const vh = window.visualViewport?.height ?? window.innerHeight;
      setH(Math.max(420, Math.round(vh - top)));
    };
    measure();
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [el]);
  return [setEl, h];
}
