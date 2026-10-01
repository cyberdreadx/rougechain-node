/**
 * Wallet data hooks (React 19). Reads go through @rougechain/core against the ACTIVE network's
 * API base (core `network`); price lookups use the same public sources as apps/web.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRougeChainProvider } from "@rougechain/core/extension-bridge";
import { pubkeyToAddress, formatAddress } from "@rougechain/core/address";
import { getCoreApiBaseUrl, getCoreApiHeaders, type NetworkType } from "@rougechain/core/network";
import { fetchXRGEPrice } from "@rougechain/core/price-service";
import { fetchTokenMintingActive, getAllTokenMetadata, type TokenMetadata } from "@rougechain/core/secure-api";
import { setTokenDecimalsCache, type MajorPrices } from "@rougechain/core/token-decimals";
import { getWalletBalance, getWalletTransactions, type WalletBalance, type WalletTransaction } from "@rougechain/core/pqc-wallet";
import i18n from "../i18n";

/** "Mainnet" / "Testnet" in the current language (ja: メインネット / テストネット). Call at render. */
export function networkLabel(network: NetworkType): string {
  return i18n.t(network === "mainnet" ? "wallet:network.mainnet" : "wallet:network.testnet");
}

// ---------- hide balances (same key + format as apps/web's use-hide-balances) ----------

export const HIDE_BALANCES_KEY = "rougechain-hide-balances";
export const MASKED_AMOUNT = "••••••";
const hideListeners = new Set<() => void>();

function readHidden(): boolean {
  try {
    return localStorage.getItem(HIDE_BALANCES_KEY) === "1";
  } catch {
    return false;
  }
}

let memoryHidden: boolean | null = null; // used when storage is unavailable

export function setBalancesHidden(next: boolean): void {
  try {
    if (next) localStorage.setItem(HIDE_BALANCES_KEY, "1");
    else localStorage.removeItem(HIDE_BALANCES_KEY);
    memoryHidden = null;
  } catch {
    memoryHidden = next; // the toggle still works for this visit
  }
  hideListeners.forEach((l) => l());
}

/** "Hide balances" toggle, shared by the wallet page and Settings (and other tabs). */
export function useHideBalances(): { hidden: boolean; toggle: () => void; setHidden: (v: boolean) => void } {
  const hidden = useSyncExternalStore(
    (l) => {
      hideListeners.add(l);
      const onStorage = (e: StorageEvent) => {
        if (e.key === HIDE_BALANCES_KEY || e.key === null) l();
      };
      window.addEventListener("storage", onStorage);
      return () => {
        hideListeners.delete(l);
        window.removeEventListener("storage", onStorage);
      };
    },
    () => memoryHidden ?? readHidden(),
    () => false,
  );
  const toggle = useCallback(() => setBalancesHidden(!(memoryHidden ?? readHidden())), []);
  return { hidden, toggle, setHidden: setBalancesHidden };
}

// ---------- address ----------

/** rouge1… address of a signing public key (core bech32m derivation). */
export function useRougeAddress(pubkey: string | null | undefined): { full: string | null; display: string } {
  const [full, setFull] = useState<{ key: string; addr: string } | null>(null);
  useEffect(() => {
    if (!pubkey) return;
    let cancelled = false;
    pubkeyToAddress(pubkey)
      .then((addr) => {
        if (!cancelled) setFull({ key: pubkey, addr });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pubkey]);
  const addr = pubkey && full?.key === pubkey ? full.addr : null;
  const display = addr ? formatAddress(addr) : pubkey ? `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}` : "";
  return { full: addr, display };
}

// ---------- prices ----------

/** XRGE market price (core price-service: GeckoTerminal, node fallback). */
export function useXrgePrice() {
  const q = useQuery({
    queryKey: ["wallet", "xrge-price"],
    queryFn: fetchXRGEPrice,
    refetchInterval: 60_000,
    staleTime: 55_000,
    retry: false,
  });
  return { priceUsd: q.data?.priceUsd ?? null, change24h: q.data?.priceChange24h || null };
}

/** ETH + BTC spot (CoinGecko), same single request as apps/web's use-eth-price. */
export function useMajorPrices(): MajorPrices {
  const q = useQuery({
    queryKey: ["wallet", "major-prices"],
    queryFn: async (): Promise<MajorPrices> => {
      const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin&vs_currencies=usd", {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error("price unavailable");
      const data = await res.json();
      const eth = data?.ethereum?.usd;
      const btc = data?.bitcoin?.usd;
      return { eth: typeof eth === "number" && eth > 0 ? eth : null, btc: typeof btc === "number" && btc > 0 ? btc : null };
    },
    refetchInterval: 60_000,
    staleTime: 55_000,
    retry: false,
  });
  return q.data ?? { eth: null, btc: null };
}

interface Pool {
  pool_id: string;
  token_a: string;
  token_b: string;
  reserve_a: number;
  reserve_b: number;
}

/** USD per RAW unit of each token with an XRGE pool (deepest pool wins) — apps/web's useTokenPrices. */
export function poolPricesUsd(pools: Pool[], xrgeUsd: number): Record<string, number> {
  const out: Record<string, { price: number; liquidity: number }> = { XRGE: { price: xrgeUsd, liquidity: Infinity } };
  for (const p of pools) {
    if (!(p.reserve_a > 0 && p.reserve_b > 0)) continue;
    const [token, priceInXrge, xrgeReserve] =
      p.token_a === "XRGE" ? [p.token_b, p.reserve_a / p.reserve_b, p.reserve_a] : p.token_b === "XRGE" ? [p.token_a, p.reserve_b / p.reserve_a, p.reserve_b] : [null, 0, 0];
    if (!token) continue;
    const liquidity = xrgeReserve * xrgeUsd * 2;
    if (!out[token] || out[token].liquidity < liquidity) out[token] = { price: priceInXrge * xrgeUsd, liquidity };
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.price]));
}

export function useTokenPrices(xrgeUsd: number | null, network: string): Record<string, number> {
  const q = useQuery({
    queryKey: ["wallet", "pools", network],
    queryFn: async (): Promise<Pool[]> => {
      const res = await fetch(`${getCoreApiBaseUrl()}/pools`, { headers: getCoreApiHeaders() });
      if (!res.ok) throw new Error("pools unavailable");
      const data = await res.json();
      return Array.isArray(data?.pools) ? data.pools : [];
    },
    refetchInterval: 60_000,
    retry: false,
  });
  return useMemo(() => (xrgeUsd ? poolPricesUsd(q.data ?? [], xrgeUsd) : {}), [q.data, xrgeUsd]);
}

/** Token metadata (images, creators) + the daemon's authoritative decimals into core's cache. */
export function useTokenMetadata(network: string): Record<string, TokenMetadata> {
  const q = useQuery({
    queryKey: ["wallet", "token-metadata", network],
    queryFn: async () => {
      const r = await getAllTokenMetadata();
      if (!r.success || !r.data) throw new Error(r.error || "metadata unavailable");
      const map: Record<string, TokenMetadata> = {};
      const decimals: Record<string, number | undefined> = {};
      for (const t of r.data) {
        map[t.symbol] = t;
        decimals[t.symbol] = (t as { decimals?: number }).decimals;
      }
      setTokenDecimalsCache(decimals);
      return map;
    },
    refetchInterval: 60_000,
    retry: false,
  });
  return q.data ?? {};
}

/**
 * Whether the node's TOKEN_MINTING upgrade is active on the wallet's network (`/stats`
 * `upgrade_schedule.token_minting`). False until known, so minting UI stays hidden by default.
 */
export function useTokenMintingActive(network: string, enabled = true): boolean {
  const q = useQuery({
    queryKey: ["wallet", "token-minting-active", network],
    queryFn: fetchTokenMintingActive,
    enabled,
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
  });
  return q.data === true;
}

// ---------- balances + history ----------

export function useWalletData(publicKey: string | null, rougeAddress: string | null, network: string) {
  const q = useQuery({
    queryKey: ["wallet", "data", network, publicKey, rougeAddress],
    enabled: !!publicKey,
    queryFn: async (): Promise<{ balances: WalletBalance[]; transactions: WalletTransaction[] }> => {
      const [balances, transactions] = await Promise.all([
        getWalletBalance(publicKey!),
        getWalletTransactions(publicKey!, rougeAddress ? [rougeAddress] : []),
      ]);
      return { balances, transactions };
    },
    refetchInterval: 15_000,
    retry: false,
  });
  return {
    balances: q.data?.balances ?? [],
    transactions: q.data?.transactions ?? [],
    loaded: q.data !== undefined,
    error: q.isError ? (q.error instanceof Error ? q.error.message : i18n.t("wallet:dashboard.loadFailed")) : null,
    refreshing: q.isFetching,
    updatedAt: q.dataUpdatedAt || null,
    refresh: () => void q.refetch(),
  };
}

// ---------- new blocks (websocket, /stats polling fallback) ----------

/**
 * Calls `onNewBlock(height)` for each new chain height on the active network: the node's
 * `/api/ws` "blocks" topic, falling back to polling `/stats` every 15 s (as apps/web does).
 */
export function useNewBlocks(network: string, onNewBlock: (height: number) => void, enabled = true): void {
  const cb = useRef(onNewBlock);
  useEffect(() => {
    cb.current = onNewBlock;
  });
  useEffect(() => {
    if (!enabled) return;
    // `network` keys the effect: core resolves the API base for the active network.
    const base = getCoreApiBaseUrl();
    let last = 0;
    let closed = false;
    let ws: WebSocket | null = null;
    let poll: number | null = null;
    const seen = (h: number) => {
      if (Number.isFinite(h) && h > last) {
        last = h;
        cb.current(h);
      }
    };
    const startPolling = () => {
      if (poll !== null || closed) return;
      const tick = async () => {
        try {
          const res = await fetch(`${base}/stats`, { headers: getCoreApiHeaders(), signal: AbortSignal.timeout(8000) });
          if (!res.ok) return;
          const d = await res.json();
          seen(Number(d.network_height ?? d.networkHeight ?? 0));
        } catch {
          /* offline: try again next tick */
        }
      };
      void tick();
      poll = window.setInterval(tick, 15_000);
    };
    try {
      if (typeof WebSocket === "undefined") throw new Error("no websocket");
      ws = new WebSocket(base.replace(/^https:/, "wss:").replace(/^http:/, "ws:").replace(/\/api$/, "/api/ws"));
      ws.onopen = () => ws?.send(JSON.stringify({ subscribe: ["blocks"] }));
      ws.onmessage = (e) => {
        try {
          const d = JSON.parse(String(e.data));
          if (d?.type === "new_block") seen(Number(d.height));
          else if (d?.type === "stats") seen(Number(d.block_height));
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onerror = () => startPolling();
      ws.onclose = () => startPolling();
    } catch {
      startPolling();
    }
    return () => {
      closed = true;
      if (poll !== null) window.clearInterval(poll);
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
      }
    };
  }, [enabled, network]);
}

/**
 * The RougeChain browser extension injects `window.rougechain` a moment AFTER the page starts
 * (its provider script loads asynchronously) and then fires `rougechain#initialized`. Reading
 * `window.rougechain` once at render therefore misses it on a fast page. This hook re-renders
 * when the extension announces itself.
 */
export const EXTENSION_READY_EVENT = "rougechain#initialized";
function subscribeExtension(onChange: () => void): () => void {
  window.addEventListener(EXTENSION_READY_EVENT, onChange);
  return () => window.removeEventListener(EXTENSION_READY_EVENT, onChange);
}
export function useExtensionProvider(): ReturnType<typeof getRougeChainProvider> {
  return useSyncExternalStore(subscribeExtension, getRougeChainProvider, () => null);
}
