import { useState, useEffect, useCallback } from "react";

const CACHE_TTL = 60_000; // 1 min
let cachedPrice: number | null = null;
let cacheTime = 0;

/**
 * Fetch ETH price in USD from CoinGecko (for qETH display)
 */
async function fetchETHPrice(): Promise<number | null> {
  if (cachedPrice !== null && Date.now() - cacheTime < CACHE_TTL) {
    return cachedPrice;
  }
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const price = data?.ethereum?.usd;
    if (typeof price === "number") {
      cachedPrice = price;
      cacheTime = Date.now();
      return price;
    }
  } catch {
    // Fallback: use cached or null
  }
  return cachedPrice;
}

/**
 * qETH uses 6 decimals: 1 ETH = 1_000_000 units
 */
export const QETH_DECIMALS = 6;
export const QETH_UNITS_PER_ETH = 1_000_000;

export function qethToHuman(units: number): number {
  return units / QETH_UNITS_PER_ETH;
}

export function humanToQeth(ethAmount: number): number {
  return Math.round(ethAmount * QETH_UNITS_PER_ETH);
}

/** Format qETH raw units for display (e.g. 0.0005) */
export function formatQethForDisplay(units: number): string {
  const human = qethToHuman(units);
  return human >= 1
    ? human.toLocaleString(undefined, { maximumFractionDigits: 6 })
    : parseFloat(human.toFixed(6)).toString();
}

/**
 * Format any token amount for display — auto-converts qETH from raw units.
 * For non-qETH tokens, applies standard number formatting.
 */
/** Tokens that use 6 decimal places (1 human unit = 1,000,000 raw units) */
const SIX_DECIMAL_TOKENS = new Set(["qETH", "qUSDC"]);

export function formatTokenAmount(amount: number, symbol?: string): string {
  if (symbol === "qETH") return formatQethForDisplay(amount);
  if (symbol === "qUSDC") {
    const human = amount / 1_000_000;
    return human >= 1
      ? human.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : human > 0
      ? parseFloat(human.toFixed(6)).toString()
      : "0.00";
  }
  if (amount >= 1) return amount.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 0 });
  if (amount > 0) return parseFloat(amount.toFixed(6)).toString();
  return "0";
}

/** Check whether a raw amount needs human conversion (6-decimal tokens) */
export function isQeth(symbol?: string): boolean {
  return symbol === "qETH";
}

export function isSixDecimalToken(symbol?: string): boolean {
  return SIX_DECIMAL_TOKENS.has(symbol || "");
}

export function rawToHuman(amount: number, symbol?: string): number {
  if (isSixDecimalToken(symbol)) return amount / 1_000_000;
  return amount;
}

export function humanToRaw(amount: number, symbol?: string): number {
  if (isSixDecimalToken(symbol)) return Math.round(amount * 1_000_000);
  return amount;
}

export function useETHPrice(pollInterval: number = 60_000) {
  const [priceUsd, setPriceUsd] = useState<number | null>(cachedPrice);

  const refresh = useCallback(async () => {
    const p = await fetchETHPrice();
    if (p !== null) setPriceUsd(p);
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, pollInterval);
    return () => clearInterval(interval);
  }, [refresh, pollInterval]);

  return { priceUsd, refresh };
}
