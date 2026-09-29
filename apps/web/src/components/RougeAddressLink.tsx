import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { pubkeyToAddress, formatAddress } from "@/lib/address";

interface Props {
  pubkey: string;
  className?: string;
}

/**
 * Renders a pubkey as a compact rouge1... link to /address/:pubkey.
 * Falls back to truncated hex if address derivation fails.
 */
export function RougeAddressLink({ pubkey, className = "" }: Props) {
  const safePk = pubkey ?? "";
  const [display, setDisplay] = useState(() =>
    safePk.length > 16 ? `${safePk.slice(0, 8)}...${safePk.slice(-4)}` : safePk || "—"
  );

  useEffect(() => {
    if (!safePk) return;
    let cancelled = false;
    pubkeyToAddress(safePk)
      .then((addr) => {
        if (!cancelled) setDisplay(formatAddress(addr));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [safePk]);

  return (
    <Link
      to={`/address/${safePk}`}
      className={`font-mono text-primary hover:underline ${className}`}
    >
      {display}
    </Link>
  );
}
