import { formatTokenAmount, l1TokenDecimals, rawToHuman, type MajorPrices } from "@/hooks/use-eth-price";
import { formatUsd, formatTokenPrice } from "@/lib/price-service";

/**
 * Spot USD price of ONE whole token for the bridged majors, which track their underlying
 * asset 1:1 (qUSDC is pegged to $1). null when the symbol isn't a major or its price is unknown.
 */
export function majorSpotUsd(symbol: string, majors: MajorPrices): number | null {
  switch (symbol.toUpperCase()) {
    case "QUSDC":
      return 1;
    case "QETH":
      return majors.eth;
    case "QBTC":
      return majors.btc;
    default:
      return null;
  }
}

export interface AssetDisplay {
  /** Human amount (raw / 10^decimals). */
  human: number;
  /** Formatted human amount, e.g. "0.0125" for 1,250,000 qBTC sats. */
  balance: string;
  /** "<balance> <SYMBOL>". */
  value: string;
  /** USD value of the whole holding, or null when there's no price. */
  usd: number | null;
  usdValue: string | null;
  /** Formatted USD price of one whole token, or null. */
  pricePerToken: string | null;
}

/**
 * Display figures for one wallet asset from its RAW on-chain balance. Decimals come from the
 * shared token-decimals helpers (daemon value, else qBTC=8 / qETH,qUSDC=6 / XRGE=0), so any
 * token with decimals is shown in whole units — not just the ones special-cased before.
 *
 * Prices: the bridged majors use spot (CoinGecko ETH/BTC, qUSDC=$1). Everything else uses the
 * AMM pool price, which is per RAW unit (derived from raw reserves).
 */
export function describeAsset(
  symbol: string,
  rawBalance: number,
  opts: { poolPriceUsdPerRaw?: number | null; majors: MajorPrices },
): AssetDisplay {
  const decimals = l1TokenDecimals(symbol);
  const human = rawToHuman(rawBalance, symbol);
  const balance = decimals > 0 ? formatTokenAmount(rawBalance, symbol) : rawBalance.toLocaleString();

  const spot = majorSpotUsd(symbol, opts.majors);
  let usd: number | null = null;
  let usdValue: string | null = null;
  let pricePerToken: string | null = null;
  if (spot !== null) {
    usd = human * spot;
    usdValue = formatUsd(usd);
    pricePerToken = formatUsd(spot);
  } else if (opts.poolPriceUsdPerRaw) {
    const perRaw = opts.poolPriceUsdPerRaw;
    usd = rawBalance * perRaw;
    usdValue = perRaw < 0.01 ? formatTokenPrice(usd) : formatUsd(usd);
    pricePerToken = formatTokenPrice(perRaw * 10 ** decimals);
  }

  return { human, balance, value: `${balance} ${symbol}`, usd, usdValue, pricePerToken };
}
