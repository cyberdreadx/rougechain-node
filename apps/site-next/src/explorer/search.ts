import {
  CONTRACT_ADDR,
  COLLECTION_ID,
  HASH64,
  HEIGHT,
  TOKEN_SYMBOL,
  isPubkeyHex,
  isRougeAddress,
} from "@rougechain/chain-readonly";

export type SearchTarget =
  | { kind: "block"; path: string }
  | { kind: "hash"; path: string }
  | { kind: "address"; path: string }
  | { kind: "contract"; path: string }
  | { kind: "collection"; path: string }
  | { kind: "token"; path: string };

/**
 * Route a search to the page that can answer it:
 * height → block, 64-hex → transaction (a block hash is redirected there), rouge1 or public key
 * → address, 40-hex → contract, col:… → NFT collection, symbol → token. Known token symbols are
 * matched case-insensitively so "qbtc" finds qBTC. Returns null when nothing fits.
 */
export function resolveSearch(
  raw: string,
  knownSymbols: readonly string[] = [],
): SearchTarget | null {
  const input = raw.trim();
  if (!input) return null;
  const lower = input.toLowerCase();
  const plain = input.replace(/^#/, "").replace(/,/g, "");
  if (HEIGHT.test(plain)) return { kind: "block", path: `/block/${plain}` };
  const hex = lower.replace(/^0x/, "");
  if (HASH64.test(hex)) return { kind: "hash", path: `/tx/${hex}` };
  if (isRougeAddress(lower))
    return { kind: "address", path: `/address/${lower}` };
  if (CONTRACT_ADDR.test(hex))
    return { kind: "contract", path: `/contract/${hex}` };
  if (hex.length > 64 && isPubkeyHex(hex))
    return { kind: "address", path: `/address/${hex}` };
  if (COLLECTION_ID.test(input))
    return { kind: "collection", path: `/nfts/${encodeURIComponent(input)}` };
  const symbol = input.replace(/^\$/, "");
  if (
    TOKEN_SYMBOL.test(symbol) &&
    /[A-Za-z]/.test(symbol) &&
    symbol.length <= 16
  ) {
    const known = knownSymbols.find(
      (s) => s.toLowerCase() === symbol.toLowerCase(),
    );
    return {
      kind: "token",
      path: `/token/${encodeURIComponent(known ?? symbol)}`,
    };
  }
  return null;
}
