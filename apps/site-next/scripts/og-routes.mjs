// Per-route social previews for site-next (the equivalent of apps/web/scripts/og-routes.mjs).
// Consumed by gen-og.mjs (renders dist/og/<slug>.png) and prerender-og.mjs (writes a route shell
// with that route's title / description / canonical / OpenGraph / Twitter tags).
// Add a route here → it gets its own OG image and shareable meta.
//
// Not prerendered on purpose: /status — public/status/ is a directory (releases.json), and a
// status.html next to it would compete with it on Netlify's pretty-URL lookup (apps/web never
// prerendered /status either).

/** Main site (rougechain.io). */
export const ROUTES = [
  { slug: "home", path: "/", label: "Layer 1", title: "Post-quantum from genesis.", subtitle: "A Layer 1 blockchain built around post-quantum cryptography.", accent: "red" },
  { slug: "wallet", path: "/wallet", label: "Wallet", title: "Your quantum-safe wallet.", subtitle: "Hold XRGE, send encrypted chat and mail, and sign transactions.", accent: "magenta" },
  { slug: "swap", path: "/swap", label: "Swap", title: "On-chain token swaps.", subtitle: "Instant swaps on a post-quantum Layer 1.", accent: "violet" },
  { slug: "bridge", path: "/bridge", label: "Bridge", title: "Bridge to RougeChain.", subtitle: "Move assets between Base and the RougeChain L1.", accent: "violet" },
  { slug: "validators", path: "/validators", label: "Validators", title: "Run a validator.", subtitle: "Stake XRGE and help secure a post-quantum network.", accent: "magenta" },
  { slug: "genesis-validators", path: "/genesis-validators", label: "Genesis Validators", title: "Become a Genesis Validator.", subtitle: "The founding independent validator cohort of a post-quantum L1.", accent: "red" },
  { slug: "node", path: "/node", label: "Run a node", title: "Run a RougeChain node.", subtitle: "Prerequisites, commands and live node status.", accent: "violet" },
  { slug: "agents", path: "/agents", label: "AI agents", title: "AI agents on RougeChain.", subtitle: "An MCP server that lets agents read the chain and sign transactions.", accent: "live" },
  { slug: "regenerate", path: "/regenerate", label: "Regenerate", title: "Fund the future where you live.", subtitle: "A transparent regeneration treasury funding measurable local projects.", accent: "live" },
  { slug: "blockchain", path: "/blockchain", label: "Explorer", title: "RougeChain Explorer.", subtitle: "Blocks, transactions and live network stats.", accent: "violet" },
  { slug: "messenger", path: "/messenger", label: "Messenger", title: "Encrypted messaging.", subtitle: "End-to-end encrypted, quantum-safe chat.", accent: "magenta" },
  { slug: "mail", path: "/mail", label: "Mail", title: "Encrypted mail.", subtitle: "On-chain, post-quantum encrypted mail.", accent: "violet" },
  { slug: "privacy", path: "/privacy", label: "Privacy", title: "Privacy policy.", subtitle: "Keys stay on your device. Messages are end-to-end encrypted.", accent: "red" },
];

/** explorer.rougechain.io (VITE_APP_MODE=explorer): its own, smaller set. */
export const EXPLORER_ROUTES = [
  { slug: "home", path: "/", label: "Explorer", title: "RougeChain Explorer.", subtitle: "Blocks, transactions, addresses, tokens, NFTs and contracts.", accent: "violet" },
  { slug: "transactions", path: "/transactions", label: "Transactions", title: "Live transactions.", subtitle: "Every transaction on the post-quantum Layer 1.", accent: "magenta" },
  { slug: "tokens", path: "/tokens", label: "Tokens", title: "Tokens on RougeChain.", subtitle: "Supply, holders and pools.", accent: "red" },
  { slug: "nfts", path: "/nfts", label: "NFTs", title: "NFT collections.", subtitle: "Collections and tokens on RougeChain.", accent: "magenta" },
  { slug: "contracts", path: "/contracts", label: "Contracts", title: "WASM contracts.", subtitle: "Deployed contracts, state and events.", accent: "violet" },
];

export function routesFor(mode) {
  return mode === "explorer" ? EXPLORER_ROUTES : ROUTES;
}

/** dist-relative file for a route shell: "/" → index.html, "/a/b" → a/b.html. */
export function shellFile(routePath) {
  return routePath === "/" ? "index.html" : `${routePath.slice(1)}.html`;
}
