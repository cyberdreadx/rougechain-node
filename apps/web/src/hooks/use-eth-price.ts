import { useState, useEffect, useCallback } from "react";
import type { MajorPrices } from "@rougechain/core/token-decimals";

// Pure token-decimals / formatting helpers live in @rougechain/core; re-exported so existing imports keep working.
export * from "@rougechain/core/token-decimals";

const CACHE_TTL = 60_000; // 1 min

let cachedPrices: MajorPrices = { eth: null, btc: null };
let cacheTime = 0;
let inflight: Promise<MajorPrices> | null = null;

/**
 * Fetch ETH + BTC prices in USD from CoinGecko in one request (for qETH / qBTC display).
 * Best-effort: on failure the last cached values are returned (null when never fetched).
 */
async function fetchMajorPrices(): Promise<MajorPrices> {
  if (cacheTime > 0 && Date.now() - cacheTime < CACHE_TTL) return cachedPrices;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,bitcoin&vs_currencies=usd",
        { signal: AbortSignal.timeout(5000) }
      );
      if (!res.ok) return cachedPrices;
      const data = await res.json();
      const eth = data?.ethereum?.usd;
      const btc = data?.bitcoin?.usd;
      cachedPrices = {
        eth: typeof eth === "number" && eth > 0 ? eth : cachedPrices.eth,
        btc: typeof btc === "number" && btc > 0 ? btc : cachedPrices.btc,
      };
      cacheTime = Date.now();
    } catch {
      // Fallback: use cached or null
    }
    return cachedPrices;
  })().finally(() => { inflight = null; });
  return inflight;
}

/** Poll ETH + BTC USD prices (shared cache, one CoinGecko request). */
export function useMajorPrices(pollInterval: number = 60_000): MajorPrices & { refresh: () => Promise<void> } {
  const [prices, setPrices] = useState<MajorPrices>(cachedPrices);

  const refresh = useCallback(async () => {
    const p = await fetchMajorPrices();
    setPrices((prev) => (prev.eth === p.eth && prev.btc === p.btc ? prev : { ...p }));
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, pollInterval);
    return () => clearInterval(interval);
  }, [refresh, pollInterval]);

  return { ...prices, refresh };
}

export function useETHPrice(pollInterval: number = 60_000) {
  const { eth, refresh } = useMajorPrices(pollInterval);
  return { priceUsd: eth, refresh };
}
