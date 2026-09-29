// Shared manifest for per-route OG images + prerendered social meta.
// Consumed by scripts/gen-og.mjs (renders /dist/og/<slug>.png) and
// scripts/prerender-og.mjs (writes /dist/<slug>.html with route-specific meta).
// Add a route here → it gets its own OG image + shareable meta automatically.

export const ROUTES = [
  {
    slug: "home", path: "/", label: "Layer 1",
    title: "Post-quantum from genesis.",
    subtitle: "A Layer 1 blockchain built around post-quantum cryptography.",
    accent: "teal",
  },
  {
    slug: "regenerate", path: "/regenerate", label: "Regenerate",
    title: "Fund the future where you live.",
    subtitle: "A transparent regeneration treasury funding measurable local projects.",
    accent: "green",
  },
  {
    slug: "wallet", path: "/wallet", label: "Wallet",
    title: "Your quantum-safe wallet.",
    subtitle: "Hold XRGE, send encrypted chat and mail, and sign transactions.",
    accent: "teal",
  },
  {
    slug: "bridge", path: "/bridge", label: "Bridge",
    title: "Bridge to RougeChain.",
    subtitle: "Move assets between Base and the RougeChain L1.",
    accent: "purple",
  },
  {
    slug: "swap", path: "/swap", label: "Swap",
    title: "On-chain token swaps.",
    subtitle: "Instant swaps on a post-quantum Layer 1.",
    accent: "teal",
  },
  {
    slug: "validators", path: "/validators", label: "Validators",
    title: "Run a validator.",
    subtitle: "Stake XRGE and help secure a post-quantum network.",
    accent: "purple",
  },
  {
    slug: "blockchain", path: "/blockchain", label: "Explorer",
    title: "RougeChain Explorer.",
    subtitle: "Blocks, transactions and live network stats.",
    accent: "teal",
  },
  {
    slug: "messenger", path: "/messenger", label: "Messenger",
    title: "Encrypted messaging.",
    subtitle: "End-to-end encrypted, quantum-safe chat.",
    accent: "green",
  },
  {
    slug: "mail", path: "/mail", label: "Mail",
    title: "Encrypted mail.",
    subtitle: "On-chain, post-quantum encrypted mail.",
    accent: "purple",
  },
];
