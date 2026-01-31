import { useState, useEffect, useCallback } from "react";
import { fetchXRGEPrice, XRGEPriceData } from "@/lib/price-service";

/**
 * React hook to fetch and poll XRGE price from DexScreener
 * 
 * @param pollInterval - Interval in ms to refresh price (default: 60s)
 * @returns Price data, loading state, and refresh function
 */
export function useXRGEPrice(pollInterval: number = 60_000) {
  const [priceData, setPriceData] = useState<XRGEPriceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchXRGEPrice();
      if (data) {
        setPriceData(data);
        setError(null);
      }
    } catch (e) {
      setError("Failed to fetch price");
      console.error("Price fetch error:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial fetch
    refresh();

    // Set up polling
    const interval = setInterval(refresh, pollInterval);

    return () => clearInterval(interval);
  }, [refresh, pollInterval]);

  return {
    priceData,
    priceUsd: priceData?.priceUsd ?? null,
    priceChange24h: priceData?.priceChange24h ?? null,
    volume24h: priceData?.volume24h ?? null,
    liquidity: priceData?.liquidity ?? null,
    loading,
    error,
    refresh,
    lastUpdated: priceData?.lastUpdated ?? null,
    source: priceData?.source ?? null,
  };
}

/**
 * Calculate USD value for an XRGE amount
 */
export function useXRGEToUsd(xrgeAmount: number, priceUsd: number | null): number | null {
  if (priceUsd === null || xrgeAmount === 0) return null;
  return xrgeAmount * priceUsd;
}
