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
  const [display, setDisplay] = useState(() =>
    pubkey.length > 16 ? `${pubkey.slice(0, 8)}...${pubkey.slice(-4)}` : pubkey
  );

  useEffect(() => {
    let cancelled = false;
    pubkeyToAddress(pubkey)
      .then((addr) => {
        if (!cancelled) setDisplay(formatAddress(addr));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [pubkey]);

  return (
    <Link
      to={`/address/${pubkey}`}
      className={`font-mono text-primary hover:underline ${className}`}
    >
      {display}
    </Link>
  );
}
