/**
 * Price Service - Fetches real XRGE price from backend (which proxies GeckoTerminal)
 * 
 * Uses the XRGE/WETH pool on Base network to get live pricing
 */

import { getNodeApiBaseUrl, getCoreApiHeaders } from "./network";

// Cache for price data (1 minute TTL)
interface PriceCache {
  price: number;
  priceChange24h: number;
  volume24h: number;
  liquidity: number;
  timestamp: number;
}

let priceCache: PriceCache | null = null;
const CACHE_TTL = 60_000; // 1 minute

export interface XRGEPriceData {
  priceUsd: number;
  priceChange24h: number;
  volume24h: number;
  liquidity: number;
  lastUpdated: Date;
  source: string;
}

/**
 * Fetch XRGE price from backend (which fetches from GeckoTerminal)
 */
export async function fetchXRGEPrice(): Promise<XRGEPriceData | null> {
  // Check cache
  if (priceCache && Date.now() - priceCache.timestamp < CACHE_TTL) {
    return {
      priceUsd: priceCache.price,
      priceChange24h: priceCache.priceChange24h,
      volume24h: priceCache.volume24h,
      liquidity: priceCache.liquidity,
      lastUpdated: new Date(priceCache.timestamp),
      source: "GeckoTerminal (cached)",
    };
  }

  try {
    const baseUrl = getNodeApiBaseUrl();
    if (!baseUrl) {
      console.error("No API base URL configured");
      return null;
    }

    const response = await fetch(`${baseUrl}/price/xrge`, {
      headers: getCoreApiHeaders(),
    });

    if (!response.ok) {
      console.error("Price API error:", response.status);
      return null;
    }

    const data = await response.json();

    if (!data.success) {
      console.error("Price API returned error:", data.error);
      return null;
    }

    // Extract price data from backend response
    const priceUsd = data.price_usd || 0;
    const priceChange24h = data.price_change_24h || 0;
    const volume24h = data.volume_24h || 0;
    const liquidity = data.liquidity || 0;

    // Update cache
    priceCache = {
      price: priceUsd,
      priceChange24h,
      volume24h,
      liquidity,
      timestamp: Date.now(),
    };

    return {
      priceUsd,
      priceChange24h,
      volume24h,
      liquidity,
      lastUpdated: new Date(),
      source: data.source || "GeckoTerminal",
    };
  } catch (error) {
    console.error("Failed to fetch XRGE price:", error);
    
    // Return cached data if available, even if stale
    if (priceCache) {
      return {
        priceUsd: priceCache.price,
        priceChange24h: priceCache.priceChange24h,
        volume24h: priceCache.volume24h,
        liquidity: priceCache.liquidity,
        lastUpdated: new Date(priceCache.timestamp),
        source: "GeckoTerminal (stale cache)",
      };
    }
    
    return null;
  }
}

/**
 * Convert XRGE amount to USD
 */
export async function xrgeToUsd(amount: number): Promise<number | null> {
  const priceData = await fetchXRGEPrice();
  if (!priceData) return null;
  return amount * priceData.priceUsd;
}

/**
 * Convert USD to XRGE amount
 */
export async function usdToXrge(usdAmount: number): Promise<number | null> {
  const priceData = await fetchXRGEPrice();
  if (!priceData || priceData.priceUsd === 0) return null;
  return usdAmount / priceData.priceUsd;
}

/**
 * Format USD value
 */
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "--";
  if (value < 0.01) return "<$0.01";
  if (value < 1) return `$${value.toFixed(4)}`;
  if (value < 1000) return `$${value.toFixed(2)}`;
  if (value < 1_000_000) return `$${(value / 1000).toFixed(2)}K`;
  if (value < 1_000_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  return `$${(value / 1_000_000_000).toFixed(2)}B`;
}

/**
 * Format price change percentage
 */
export function formatPriceChange(change: number): string {
  const sign = change >= 0 ? "+" : "";
  return `${sign}${change.toFixed(2)}%`;
}

/**
 * React hook for XRGE price (use with useEffect)
 */
export function usePricePolling(intervalMs: number = 60_000) {
  // This is a helper for components to set up polling
  // The actual hook implementation should be in the component
  return {
    fetch: fetchXRGEPrice,
    interval: intervalMs,
  };
}
