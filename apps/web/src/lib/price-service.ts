/**
 * Price Service - Fetches real XRGE price from backend (which proxies DexScreener)
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
  source: string;
  timestamp: number;
}

let priceCache: PriceCache | null = null;
const CACHE_TTL = 60_000; // 1 minute

// Primary source: GeckoTerminal (CoinGecko's on-chain DEX data) — no key, browser-friendly.
const GECKOTERMINAL_POOL_API =
  "https://api.geckoterminal.com/api/v2/networks/base/pools/0x059e10d26c64a63d04e1814f46305210eddc447d";
const XRGE_TOKEN_ADDRESS = "0x147120faec9277ec02d957584cfcd92b56a24317";

export interface XRGEPriceData {
  priceUsd: number;
  priceChange24h: number;
  volume24h: number;
  liquidity: number;
  lastUpdated: Date;
  source: string;
}

/** Primary source: GeckoTerminal (CoinGecko on-chain DEX data). No key, CORS-friendly. */
async function fetchFromGeckoTerminal(): Promise<XRGEPriceData | null> {
  const res = await fetch(GECKOTERMINAL_POOL_API, { headers: { accept: "application/json" } });
  if (!res.ok) return null;
  const json = await res.json();
  const attr = json?.data?.attributes;
  if (!attr) return null;

  // The pool is XRGE/USDC — pick the XRGE side by matching the token address.
  const baseId = String(json?.data?.relationships?.base_token?.data?.id ?? "").toLowerCase();
  const xrgeIsBase = baseId.includes(XRGE_TOKEN_ADDRESS);
  const priceUsd = parseFloat(xrgeIsBase ? attr.base_token_price_usd : attr.quote_token_price_usd) || 0;
  if (priceUsd <= 0) return null;

  // price_change_percentage.h24 tracks the base token; invert for the quote side.
  const baseChange = parseFloat(attr.price_change_percentage?.h24 ?? "0") || 0;
  return {
    priceUsd,
    priceChange24h: xrgeIsBase ? baseChange : -baseChange,
    volume24h: parseFloat(attr.volume_usd?.h24 ?? "0") || 0,
    liquidity: parseFloat(attr.reserve_in_usd ?? "0") || 0,
    lastUpdated: new Date(),
    source: "GeckoTerminal",
  };
}

/** Fallback source: the node backend proxy (DexScreener). */
async function fetchFromNode(): Promise<XRGEPriceData | null> {
  const baseUrl = getNodeApiBaseUrl();
  if (!baseUrl) return null;
  const response = await fetch(`${baseUrl}/price/xrge`, { headers: getCoreApiHeaders() });
  if (!response.ok) return null;
  const data = await response.json();
  if (!data?.success) return null;
  return {
    priceUsd: data.price_usd || 0,
    priceChange24h: data.price_change_24h || 0,
    volume24h: data.volume_24h || 0,
    liquidity: data.liquidity || 0,
    lastUpdated: new Date(),
    source: data.source || "DexScreener",
  };
}

/**
 * Fetch XRGE price: GeckoTerminal primary, node/DexScreener fallback, then stale cache.
 */
export async function fetchXRGEPrice(): Promise<XRGEPriceData | null> {
  if (priceCache && Date.now() - priceCache.timestamp < CACHE_TTL) {
    return {
      priceUsd: priceCache.price,
      priceChange24h: priceCache.priceChange24h,
      volume24h: priceCache.volume24h,
      liquidity: priceCache.liquidity,
      lastUpdated: new Date(priceCache.timestamp),
      source: `${priceCache.source} (cached)`,
    };
  }

  let result: XRGEPriceData | null = null;
  try { result = await fetchFromGeckoTerminal(); } catch (e) { console.warn("GeckoTerminal price failed:", e); }
  if (!result) {
    try { result = await fetchFromNode(); } catch (e) { console.warn("Node price fallback failed:", e); }
  }

  if (result && result.priceUsd > 0) {
    priceCache = {
      price: result.priceUsd,
      priceChange24h: result.priceChange24h,
      volume24h: result.volume24h,
      liquidity: result.liquidity,
      source: result.source,
      timestamp: Date.now(),
    };
    return result;
  }

  if (priceCache) {
    return {
      priceUsd: priceCache.price,
      priceChange24h: priceCache.priceChange24h,
      volume24h: priceCache.volume24h,
      liquidity: priceCache.liquidity,
      lastUpdated: new Date(priceCache.timestamp),
      source: `${priceCache.source} (stale)`,
    };
  }
  return null;
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
  if (value === 0) return "$0.00";
  if (value < 0.0001) return `$${value.toFixed(6)}`;
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

/**
 * Calculate token price from pool reserves (AMM constant product formula)
 * 
 * @param tokenReserve - Amount of the token in the pool
 * @param xrgeReserve - Amount of XRGE in the pool  
 * @param xrgeUsdPrice - Current XRGE price in USD
 * @returns Token price in USD
 */
export function calculateTokenPriceFromPool(
  tokenReserve: number,
  xrgeReserve: number,
  xrgeUsdPrice: number
): number {
  if (tokenReserve <= 0 || xrgeReserve <= 0) return 0;
  
  // Price in XRGE = xrgeReserve / tokenReserve
  const priceInXrge = xrgeReserve / tokenReserve;
  
  // Price in USD = priceInXrge * xrgeUsdPrice
  return priceInXrge * xrgeUsdPrice;
}

/**
 * Calculate token value in USD based on pool liquidity
 */
export function calculateTokenValueFromPool(
  amount: number,
  tokenReserve: number,
  xrgeReserve: number,
  xrgeUsdPrice: number
): number {
  const priceUsd = calculateTokenPriceFromPool(tokenReserve, xrgeReserve, xrgeUsdPrice);
  return amount * priceUsd;
}

/**
 * Format token price with appropriate precision
 */
export function formatTokenPrice(price: number): string {
  if (price === 0) return "$0.00";
  if (price < 0.00000001) return `$${price.toExponential(2)}`;
  if (price < 0.0001) return `$${price.toFixed(10)}`;
  if (price < 0.01) return `$${price.toFixed(8)}`;
  if (price < 1) return `$${price.toFixed(6)}`;
  if (price < 1000) return `$${price.toFixed(4)}`;
  return formatUsd(price);
}
