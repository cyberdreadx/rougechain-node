import { useCallback, useEffect, useMemo, useState } from "react";
import { deriveBaseAddress, hasBaseAccount } from "@/lib/evm-wallet";
import { fetchBaseBalances, getBaseChain, type BaseBalance, type BaseChainInfo } from "@/lib/base-wallet";

/**
 * The Base address for a recovery phrase. Derivation (BIP-39 PBKDF2) is deferred
 * off the first render; returns null for wallets without a mnemonic.
 */
export function useBaseAddress(mnemonic: string | null | undefined): { address: `0x${string}` | null; ready: boolean; hasAccount: boolean } {
  const hasAccount = useMemo(() => hasBaseAccount(mnemonic), [mnemonic]);
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    setAddress(null);
    if (!hasAccount) { setReady(true); return; }
    const id = setTimeout(() => {
      try { setAddress(deriveBaseAddress(mnemonic)); } catch { setAddress(null); }
      setReady(true);
    }, 0);
    return () => clearTimeout(id);
  }, [mnemonic, hasAccount]);
  return { address, ready, hasAccount };
}

/** Poll Base balances (interval + window focus). Keeps the last good values on RPC errors. */
export function useBaseBalances(address: string | null, pollMs = 30_000) {
  const chain: BaseChainInfo = useMemo(() => getBaseChain(), []);
  const [balances, setBalances] = useState<BaseBalance[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    try {
      setBalances(await fetchBaseBalances(chain, address));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "RPC error");
    } finally {
      setLoading(false);
    }
  }, [address, chain]);

  useEffect(() => {
    setBalances(null);
    if (!address) return;
    refresh();
    const id = setInterval(refresh, pollMs);
    const onFocus = () => refresh();
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [address, pollMs, refresh]);

  return { chain, balances, loading, error, refresh };
}
