import { useState, useEffect } from "react";
import { pubkeyToAddress, formatAddress } from "@/lib/address";

/**
 * Hook to derive a rouge1... address from a raw public key.
 * Returns the formatted (truncated) address for display, plus the full address.
 * Falls back to truncated hex if derivation fails.
 */
export function useRougeAddress(pubkey: string | null | undefined) {
  const [full, setFull] = useState<string | null>(null);

  useEffect(() => {
    if (!pubkey) { setFull(null); return; }
    let cancelled = false;
    pubkeyToAddress(pubkey)
      .then((addr) => { if (!cancelled) setFull(addr); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [pubkey]);

  const display = full
    ? formatAddress(full)
    : pubkey
      ? `${pubkey.slice(0, 8)}...${pubkey.slice(-4)}`
      : "";

  return { display, full, isResolved: !!full };
}
