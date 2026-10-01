/**
 * Build-time <head> values (used by vite.config.ts's siteMeta plugin): <title>, description,
 * canonical and the OpenGraph / Twitter title, description and URLs. index.html carries the full
 * apps/web tag set; this only swaps values, per build mode. No DOM / React here: node-safe.
 */
export function siteHead(opts: { explorer: boolean; testnet: boolean }) {
  const { explorer, testnet } = opts;
  // A testnet-pinned build (either mode) is canonical on testnet.rougechain.io (core siteUrlFor default).
  const host = testnet ? "https://testnet.rougechain.io" : explorer ? "https://explorer.rougechain.io" : "https://rougechain.io";
  const base = explorer
    ? "RougeChain Explorer — blocks, transactions, addresses and tokens"
    : "RougeChain — Post-quantum from genesis.";
  const title = testnet ? base.replace(/^RougeChain/, "RougeChain Testnet") : base;
  const description = explorer
    ? "Explore RougeChain, the post-quantum Layer 1: blocks, transactions, addresses, tokens, NFTs and contracts."
    : "RougeChain — a post-quantum Layer 1 blockchain built on NIST-standardized lattice cryptography.";
  return { host, title, description };
}

export function applySiteHead(html: string, head: ReturnType<typeof siteHead>): string {
  const { host, title, description } = head;
  const attr = (h: string, sel: string, value: string) =>
    h.replace(new RegExp(`(<${sel}[^>]*?\\s(?:content|href)=")[^"]*(")`), `$1${value}$2`);
  let h = html
    .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
    .replace(/(<meta\s+name="description"\s+content=")[^"]*(")/, `$1${description}$2`);
  h = attr(h, 'link rel="canonical"', `${host}/`);
  h = attr(h, 'meta property="og:url"', `${host}/`);
  h = attr(h, 'meta name="twitter:url"', `${host}/`);
  for (const key of ['meta property="og:title"', 'meta name="twitter:title"', 'meta property="og:image:alt"', 'meta name="twitter:image:alt"'])
    h = attr(h, key, title);
  for (const key of ['meta property="og:description"', 'meta name="twitter:description"']) h = attr(h, key, description);
  return h;
}

