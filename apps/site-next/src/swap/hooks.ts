/** React Query hooks for the DEX, keyed by the active network (mainnet / testnet). */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSigner, useWallet } from "../wallet/WalletProvider";
import { poolPricesUsd, useExtensionProvider, useTokenMetadata, useXrgePrice } from "../wallet/hooks";
import {
  fetchBalances,
  fetchEarnings,
  fetchPool,
  fetchPoolEvents,
  fetchPoolPrices,
  fetchPoolStats,
  fetchPools,
  fetchQuote,
  type LpEarnings,
  type Pool,
  type SigningWallet,
} from "./api";

export const SWAP_QUERY_ROOT = "swap";

export function usePools() {
  const { network } = useWallet();
  return useQuery({
    queryKey: [SWAP_QUERY_ROOT, "pools", network],
    queryFn: fetchPools,
    refetchInterval: 30_000,
    retry: false,
  });
}

/** Balances of the wallet's signing key (also while locked: the public key is known). */
export function useDexBalances() {
  const { network, publicKey } = useWallet();
  return useQuery({
    queryKey: [SWAP_QUERY_ROOT, "balances", network, publicKey],
    queryFn: () => fetchBalances(publicKey!),
    enabled: !!publicKey,
    refetchInterval: 15_000,
    retry: false,
  });
}

/** Raw balance of `symbol` from DexBalances (0 when unknown). */
export function balanceOf(b: { xrge: number; tokens: Record<string, number> } | undefined, symbol: string): number {
  if (!b || !symbol) return 0;
  return symbol === "XRGE" ? b.xrge : b.tokens[symbol] || 0;
}

/** Token images + the daemon's decimals (fed into core's cache so amounts parse correctly). */
export function useTokenImages(): (symbol: string) => string | null {
  const { network } = useWallet();
  const meta = useTokenMetadata(network);
  return useCallback((symbol: string) => meta[symbol]?.image || null, [meta]);
}

/** USD per RAW unit for tokens with an XRGE pool (the wallet's pricing), plus XRGE's price. */
export function useUsdPrices(pools: Pool[] | undefined): Record<string, number> {
  const { priceUsd } = useXrgePrice();
  return useMemo(() => (priceUsd ? poolPricesUsd(pools ?? [], priceUsd) : {}), [pools, priceUsd]);
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** Node quote for a raw amount, debounced 300 ms (as apps/web) and refreshed every 15 s. */
export function useSwapQuote(tokenIn: string, tokenOut: string, amountInRaw: number | null) {
  const { network } = useWallet();
  const key = useDebounced(`${tokenIn}|${tokenOut}|${amountInRaw ?? ""}`, 300);
  const [dIn, dOut, dRaw] = key.split("|");
  const raw = dRaw ? Number(dRaw) : null;
  const enabled = !!dIn && !!dOut && dIn !== dOut && raw !== null && raw > 0;
  const q = useQuery({
    queryKey: [SWAP_QUERY_ROOT, "quote", network, dIn, dOut, raw],
    queryFn: ({ signal }) => fetchQuote(dIn, dOut, raw!, signal),
    enabled,
    refetchInterval: 15_000,
    retry: false,
  });
  const current = key === `${tokenIn}|${tokenOut}|${amountInRaw ?? ""}`;
  const wanted = !!tokenIn && !!tokenOut && tokenIn !== tokenOut && amountInRaw !== null && amountInRaw > 0;
  return {
    result: current && enabled ? q.data : undefined,
    loading: wanted && (!current || (q.isFetching && !q.data)),
    error: current && enabled && q.isError ? q.error : null,
    refetch: () => void q.refetch(),
  };
}

/** Uncollected fees for every pool the wallet holds LP in (node ledger, replay fallback). */
export function useEarnings(pools: Pool[] | undefined, lp: Record<string, number> | undefined) {
  const { network, publicKey } = useWallet();
  const held = useMemo(() => (pools ?? []).filter((p) => (lp?.[p.pool_id] || 0) > 0), [pools, lp]);
  const sig = held.map((p) => `${p.pool_id}:${lp?.[p.pool_id]}:${p.reserve_a}:${p.reserve_b}`).join(",");
  return useQuery({
    queryKey: [SWAP_QUERY_ROOT, "earnings", network, publicKey, sig],
    enabled: !!publicKey && held.length > 0,
    retry: false,
    queryFn: async (): Promise<Record<string, LpEarnings | null>> => {
      const entries = await Promise.all(
        held.map(async (p) => {
          try {
            return [p.pool_id, await fetchEarnings(p, publicKey!, lp?.[p.pool_id] || 0)] as const;
          } catch {
            return [p.pool_id, null] as const;
          }
        }),
      );
      return Object.fromEntries(entries);
    },
  });
}

export function usePoolDetail(poolId: string) {
  const { network } = useWallet();
  const k = [SWAP_QUERY_ROOT, "pool", network, poolId];
  const opts = { refetchInterval: 30_000, retry: false } as const;
  const pool = useQuery({ queryKey: [...k, "info"], queryFn: () => fetchPool(poolId), ...opts });
  const prices = useQuery({ queryKey: [...k, "prices"], queryFn: () => fetchPoolPrices(poolId), ...opts });
  const events = useQuery({ queryKey: [...k, "events"], queryFn: () => fetchPoolEvents(poolId), ...opts });
  const stats = useQuery({ queryKey: [...k, "stats"], queryFn: () => fetchPoolStats(poolId), ...opts });
  return { pool, prices, events, stats };
}

/** Refresh everything the DEX and the wallet show after a write. */
export function useRefreshAfterWrite() {
  const qc = useQueryClient();
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: [SWAP_QUERY_ROOT] });
    void qc.invalidateQueries({ queryKey: ["wallet"] });
  }, [qc]);
}

export type SignState =
  | { state: "none" }
  | { state: "locked" }
  | { state: "nosigner" }
  | { state: "ready"; wallet: SigningWallet; kind: "local" | "extension" };

/**
 * Who signs: an unlocked local wallet (ML-DSA-65 in the browser) or the extension / Qwalla
 * (`useSigner` kind "extension": core routes the signature to window.rougechain).
 */
export function useSignState(): SignState {
  const { status, wallet } = useWallet();
  const signer = useSigner();
  const extension = useExtensionProvider();
  if (status === "none") return { state: "none" };
  if (status === "locked" || !wallet) return { state: "locked" };
  if (!signer) return { state: "nosigner" };
  if (signer.kind === "extension" && !extension) return { state: "nosigner" };
  return {
    state: "ready",
    kind: signer.kind,
    wallet: { signingPublicKey: wallet.signingPublicKey, signingPrivateKey: signer.kind === "local" ? wallet.signingPrivateKey : "" },
  };
}
