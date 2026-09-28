import { useEffect, useMemo, useState } from "react";
import { MESSENGER_PREFS_EVENT, getAcceptedChats, getBlockedList, getMutedConversations } from "@/lib/messenger-prefs";

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
