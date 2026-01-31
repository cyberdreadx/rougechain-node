import { useState, useEffect, useCallback } from "react";
import { getNodeApiBaseUrl, getCoreApiHeaders } from "@/lib/network";
import { useXRGEPrice } from "./use-xrge-price";
import { calculateTokenPriceFromPool } from "@/lib/price-service";

interface Pool {
  pool_id: string;
  token_a: string;
  token_b: string;
  reserve_a: number;
  reserve_b: number;
}

export interface TokenPrice {
  symbol: string;
  priceUsd: number;
  priceInXrge: number;
  poolId: string;
  liquidity: number; // Total USD liquidity
}

/**
 * Hook to calculate all token prices from pool liquidity
 * Uses AMM constant product formula: price = reserve_quote / reserve_base
 */
export function useTokenPrices(pollInterval: number = 60_000) {
  const [tokenPrices, setTokenPrices] = useState<Record<string, TokenPrice>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Get XRGE USD price first
  const { priceUsd: xrgeUsdPrice } = useXRGEPrice(pollInterval);

  const fetchPools = useCallback(async () => {
    if (!xrgeUsdPrice) return;
    
    try {
      const baseUrl = getNodeApiBaseUrl();
      if (!baseUrl) return;

      const response = await fetch(`${baseUrl}/pools`, {
        headers: getCoreApiHeaders(),
      });

      if (!response.ok) {
        throw new Error("Failed to fetch pools");
      }

      const data = await response.json();
      const pools: Pool[] = data.pools || [];

      const prices: Record<string, TokenPrice> = {};

      // XRGE always has its market price
      prices["XRGE"] = {
        symbol: "XRGE",
        priceUsd: xrgeUsdPrice,
        priceInXrge: 1,
        poolId: "market",
        liquidity: 0,
      };

      // Calculate prices for all tokens in pools
      for (const pool of pools) {
        const { token_a, token_b, reserve_a, reserve_b, pool_id } = pool;

        // Skip empty pools
        if (reserve_a <= 0 || reserve_b <= 0) continue;

        // If one side is XRGE, we can calculate USD price for the other token
        if (token_a === "XRGE") {
          // token_b price in XRGE = reserve_a / reserve_b
          const priceInXrge = reserve_a / reserve_b;
          const priceUsd = priceInXrge * xrgeUsdPrice;
          const liquidity = reserve_a * xrgeUsdPrice * 2; // Both sides

          // Only update if this pool has more liquidity (more accurate price)
          if (!prices[token_b] || prices[token_b].liquidity < liquidity) {
            prices[token_b] = {
              symbol: token_b,
              priceUsd,
              priceInXrge,
              poolId: pool_id,
              liquidity,
            };
          }
        } else if (token_b === "XRGE") {
          // token_a price in XRGE = reserve_b / reserve_a
          const priceInXrge = reserve_b / reserve_a;
          const priceUsd = priceInXrge * xrgeUsdPrice;
          const liquidity = reserve_b * xrgeUsdPrice * 2;

          if (!prices[token_a] || prices[token_a].liquidity < liquidity) {
            prices[token_a] = {
              symbol: token_a,
              priceUsd,
              priceInXrge,
              poolId: pool_id,
              liquidity,
            };
          }
        }
        // TODO: For non-XRGE pairs, we could calculate through routing
      }

      setTokenPrices(prices);
      setError(null);
    } catch (e) {
      console.error("Failed to fetch token prices:", e);
      setError("Failed to calculate token prices");
    } finally {
      setLoading(false);
    }
  }, [xrgeUsdPrice]);

  useEffect(() => {
    fetchPools();
    const interval = setInterval(fetchPools, pollInterval);
    return () => clearInterval(interval);
  }, [fetchPools, pollInterval]);

  /**
   * Get price for a specific token
   */
  const getTokenPrice = useCallback(
    (symbol: string): TokenPrice | null => {
      return tokenPrices[symbol] || null;
    },
    [tokenPrices]
  );

  /**
   * Calculate USD value for a token amount
   */
  const getTokenValue = useCallback(
    (symbol: string, amount: number): number | null => {
      const price = tokenPrices[symbol];
      if (!price) return null;
      return amount * price.priceUsd;
    },
    [tokenPrices]
  );

  return {
    tokenPrices,
    getTokenPrice,
    getTokenValue,
    xrgeUsdPrice,
    loading,
    error,
    refresh: fetchPools,
  };
}
