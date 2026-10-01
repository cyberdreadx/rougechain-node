export type AppGroup =
  "Hold" | "Trade" | "Play" | "Talk" | "Explore" | "Build" | "Community";
export type EcosystemItemKind =
  "app" | "developer-resource" | "community" | "utility";
/**
 * Display text is translated at render: common:apps.<id>.name / .description, common:appGroups.<group>
 * and common:appNav.<key>. `name` / `description` here are the English reference (ids stay stable).
 */
export interface EcosystemApp {
  kind: EcosystemItemKind;
  id: string;
  name: string;
  group: AppGroup;
  description: string;
  proposedHost: string;
  icon: string;
  status: "live" | "demo" | "preview" | "future" | "external";
  pocRoute?: string;
  externalUrl?: string;
  workspaceView?: string;
  /** `key` → common:appNav.<key> (the display label); `label` is the English reference. */
  localNavigation?: {
    key: string;
    label: string;
    path: string;
    match?: string[];
  }[];
}
export const DOCS_URL = "https://docs.rougechain.io/";
export const WHITEPAPER_URL = "https://rougechain.io/RougeChain-Whitepaper.pdf";
export const SOURCE_URL = "https://github.com/cyberdreadx/rougechain-node";
export const apps: EcosystemApp[] = [
  {
    id: "qwalla",
    kind: "app",
    name: "Qwalla Mobile Wallet",
    group: "Hold",
    description: "Explore the Qwalla ecosystem.",
    proposedHost: "qwalla.io",
    icon: "globe",
    status: "external",
    externalUrl: "https://qwalla.io",
  },
  {
    id: "wallet",
    kind: "app",
    name: "Web Wallet",
    group: "Hold",
    description: "Your assets, secured for tomorrow.",
    proposedHost: "wallet.rougechain.io",
    icon: "wallet",
    status: "live",
    pocRoute: "/wallet",
    workspaceView: "Wallet",
    localNavigation: [
      { key: "wallet", label: "Wallet", path: "/wallet" },
      { key: "settings", label: "Settings", path: "/settings" },
    ],
  },
  {
    id: "wallet-extension",
    kind: "app",
    name: "Wallet Extension",
    group: "Hold",
    description: "RougeChain Wallet browser extension.",
    proposedHost: "chromewebstore.google.com",
    icon: "wallet",
    status: "external",
    externalUrl:
      "https://chromewebstore.google.com/detail/rougechain-wallet/ilkbgjgphhaolfdjkfefdfiifipmhakj",
  },
  ...[
    { id: "rougee", name: "Rougee", host: "www.rougee.app" },
    { id: "qwave", name: "qWave", host: "music.rougee.app" },
  ].map(({ id, name, host }): EcosystemApp => ({
    id,
    name,
    kind: "app",
    group: "Play",
    description: `Discover ${name}.`,
    proposedHost: host,
    icon: "globe",
    status: "external",
    externalUrl: `https://${host}`,
  })),
  {
    id: "arcade",
    kind: "app",
    name: "Arcade",
    group: "Play",
    description: "Games coming soon.",
    proposedHost: "To be determined",
    icon: "globe",
    status: "future",
  },
  {
    id: "messenger",
    kind: "app",
    name: "Messenger",
    group: "Talk",
    description: "Post-quantum encrypted chats, groups and payments.",
    proposedHost: "messenger.rougechain.io",
    icon: "message",
    status: "live",
    pocRoute: "/messenger",
    workspaceView: "Messenger",
  },
  {
    id: "mail",
    kind: "app",
    name: "Mail",
    group: "Talk",
    description: "Encrypted mail at @rouge.quant and @qwalla.mail.",
    proposedHost: "mail.rougechain.io",
    icon: "mail",
    status: "live",
    pocRoute: "/mail",
    workspaceView: "Mail",
  },
  {
    id: "swap",
    kind: "app",
    name: "Swap",
    group: "Trade",
    description: "Exchange assets. Explore possibilities.",
    proposedHost: "swap.rougechain.io",
    icon: "arrows",
    status: "live",
    pocRoute: "/swap",
    workspaceView: "Swap",
    // apps/web paths (/pools, /pool/:id, /buy) plus the /swap/* views; `match` lights the section.
    localNavigation: [
      { key: "swap", label: "Swap", path: "/swap", match: ["/swap", "/buy"] },
      { key: "pools", label: "Pools", path: "/pools", match: ["/pools", "/pool", "/swap/pools"] },
      { key: "positions", label: "Positions", path: "/swap/positions", match: ["/swap/positions"] },
    ],
  },
  {
    id: "bridge",
    kind: "app",
    name: "Bridge",
    group: "Trade",
    description: "A connection between networks.",
    proposedHost: "bridge.rougechain.io",
    icon: "bridge",
    status: "live",
    pocRoute: "/bridge",
    workspaceView: "Bridge",
  },
  {
    id: "liquidity",
    kind: "utility",
    name: "Liquidity",
    group: "Trade",
    description: "Provide liquidity and earn swap fees.",
    proposedHost: "swap.rougechain.io/pools",
    icon: "layers",
    status: "live",
    pocRoute: "/pools",
    workspaceView: "Swap",
  },
  {
    id: "explorer",
    kind: "app",
    name: "Explorer",
    group: "Explore",
    description: "The network, in detail.",
    proposedHost: "explorer.rougechain.io",
    icon: "box",
    status: "live",
    pocRoute: "/explorer",
    workspaceView: "Explorer",
    // Legacy rougechain.io paths; `match` marks the section active on its detail pages too.
    localNavigation: [
      {
        key: "overview",
        label: "Overview",
        path: "/explorer",
        match: ["/explorer", "/blockchain"],
      },
      {
        key: "blocks",
        label: "Blocks",
        path: "/explorer/blocks",
        match: ["/explorer/blocks", "/block"],
      },
      {
        key: "transactions",
        label: "Transactions",
        path: "/transactions",
        match: ["/transactions", "/tx"],
      },
      { key: "tokens", label: "Tokens", path: "/tokens", match: ["/tokens", "/token"] },
      { key: "nfts", label: "NFTs", path: "/nfts", match: ["/nfts"] },
      {
        key: "contracts",
        label: "Contracts",
        path: "/contracts",
        match: ["/contracts", "/contract"],
      },
      {
        key: "bridgeActivity",
        label: "Bridge",
        path: "/explorer/bridge",
        // "/bridge" only lights this up on explorer.rougechain.io; on the main site /bridge is
        // the Bridge app, which never renders the Explorer header.
        match: ["/explorer/bridge", "/bridge-activity", "/bridge"],
      },
    ],
  },
  {
    id: "validators",
    kind: "app",
    name: "Validators",
    group: "Explore",
    description: "The participants securing the network.",
    proposedHost: "validators.rougechain.io",
    icon: "network",
    status: "live",
    pocRoute: "/validators",
    workspaceView: "Validators",
    localNavigation: [
      { key: "validators", label: "Validators", path: "/validators" },
      { key: "genesis", label: "Genesis program", path: "/genesis-validators" },
    ],
  },
  {
    id: "network",
    kind: "utility",
    name: "Network Status",
    group: "Explore",
    description: "Read-only public API telemetry.",
    proposedHost: "status.rougechain.io",
    icon: "activity",
    status: "live",
    pocRoute: "/status",
    workspaceView: "Network",
    localNavigation: [{ key: "status", label: "Status", path: "/status" }],
  },
  {
    id: "build",
    kind: "developer-resource",
    name: "Developer Portal",
    group: "Build",
    description: "Tools to build on RougeChain.",
    proposedHost: "build.rougechain.io",
    icon: "code",
    status: "preview",
    workspaceView: "Build",
  },
  {
    id: "docs",
    kind: "developer-resource",
    name: "Documentation",
    group: "Build",
    description: "Read the current documentation.",
    proposedHost: "docs.rougechain.io",
    icon: "book",
    status: "external",
    externalUrl: DOCS_URL,
  },
  {
    id: "sdk",
    kind: "developer-resource",
    name: "SDK",
    group: "Build",
    description: "Developer tooling preview.",
    proposedHost: "build.rougechain.io",
    icon: "code",
    status: "preview",
    workspaceView: "Build",
  },
  ...[
    { id: "mcp", name: "MCP / Agents", route: "/agents", description: "Let AI agents read and use the chain." },
    { id: "node", name: "Run a Node", route: "/node", description: "Commands, prerequisites and live nodes." },
  ].map(({ id, name, route, description }): EcosystemApp => ({
    id,
    kind: "developer-resource",
    name,
    group: "Build",
    description,
    proposedHost: `rougechain.io${route}`,
    icon: "code",
    status: "live",
    pocRoute: route,
    workspaceView: "Build",
  })),
  {
    id: "regenerate",
    kind: "community",
    name: "Regenerate",
    group: "Community",
    description: "Discover the community mission.",
    proposedHost: "rougechain.io",
    icon: "leaf",
    status: "live",
    pocRoute: "/regenerate",
  },
  {
    id: "community",
    kind: "community",
    name: "RougeChain Community",
    group: "Community",
    description: "Connect with the community.",
    proposedHost: "rougechain.io",
    icon: "people",
    status: "external",
    externalUrl: "https://x.com/rougecoin",
  },
];
export const appGroups: AppGroup[] = [
  "Hold",
  "Trade",
  "Play",
  "Talk",
  "Explore",
  "Build",
  "Community",
];
export function appHref(app: EcosystemApp) {
  return app.pocRoute ?? app.externalUrl ?? `/workspace?open=${app.id}`;
}
export function appById(id: string) {
  return apps.find((app) => app.id === id);
}

export const globalApps = apps.filter((item) => item.kind === "app");
export const globalAppGroups = appGroups.filter((group) =>
  globalApps.some((app) => app.group === group),
);
