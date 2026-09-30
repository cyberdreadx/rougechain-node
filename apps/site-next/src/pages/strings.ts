/**
 * English copy for the Validators & pages area (validators, genesis, node, agents, status,
 * regenerate). Kept in one module so i18n can be added later without touching components.
 * Copy that mirrors apps/web keeps apps/web's wording; the Privacy Policy is legal text copied
 * verbatim and lives in privacy-content.tsx.
 */

export const common = {
  loading: "Loading…",
  retry: "Try again",
  mainnet: "Mainnet",
  testnet: "Testnet",
  xrge: "XRGE",
  copy: "Copy",
  copied: "Copied",
  openWallet: "Open wallet",
  unlockToContinue: "Unlock your wallet to continue.",
  testnetNotice: (what: string) =>
    `You are viewing testnet. ${what} Testnet XRGE has no value.`,
  apiUnavailable: (network: string) =>
    `The ${network} node API could not be read. Nothing is shown rather than guessing.`,
};

export const seo = {
  validators: {
    title: "Validators — RougeChain",
    description: "Stake XRGE and help secure a post-quantum network. Live validator set, stake and finality.",
  },
  genesis: {
    title: "Genesis Validators — RougeChain",
    description: "Become a founding independent validator of the first post-quantum Layer 1.",
  },
  node: {
    title: "Run a node — RougeChain",
    description: "Run a RougeChain node: prerequisites, commands and live node status.",
  },
  agents: {
    title: "AI Agents (MCP) — RougeChain",
    description: "Model Context Protocol server for RougeChain: let AI agents read the chain and sign transactions.",
  },
  status: {
    title: "Network status — RougeChain",
    description: "Live RougeChain network figures, consensus rules and bridge status.",
  },
  regenerate: {
    title: "RougeChain Regenerate — Fund the future where you live",
    description:
      "RougeChain Regenerate is a regeneration program and treasury on RougeChain, funding transparent, measurable local projects — starting in Tulum, Mexico.",
  },
  privacy: {
    title: "Privacy Policy — RougeChain",
    description: "What the RougeChain wallet extension and rougechain.io collect, and what they don't.",
  },
};

// ---------------------------------------------------------------- validators

export const validators = {
  eyebrow: "Explore / Staking · Consensus",
  title: "Validators",
  lead: "The participants securing RougeChain, read live from the node. Stake XRGE to join them.",
  stats: {
    total: "Validators",
    active: (n: number) => `${n} active`,
    staked: "Total staked",
    entropy: "Quantum entropy",
    entropySub: "contributions",
    participation: "Vote participation",
    height: (h: number | string) => `Height ${h}`,
  },
  tiers: {
    title: "Tier distribution",
    standard: "Standard",
    operator: "Operator",
    genesis: "Genesis",
  },
  proposer: {
    title: "Current proposer",
    height: "Height",
    proposer: "Designated proposer",
    you: "You are the designated proposer",
    weight: "Selection weight",
    totalStake: "Total stake",
    entropy: "Entropy",
    unavailable: "Proposer selection is unavailable from this node.",
  },
  finality: {
    title: "Finality",
    finalized: "Finalized",
    tip: "Tip",
    lag: "Behind tip",
    quorum: "Quorum stake",
    unavailable: "Finality status is unavailable from this node.",
  },
  list: {
    title: "Validator leaderboard",
    total: (n: number) => `${n} total`,
    empty: "No validators yet",
    emptyBody: "Be the first to stake XRGE and become a validator.",
    loading: "Loading validators",
    rank: "#",
    validator: "Validator",
    tier: "Tier",
    status: "Status",
    stake: "Stake",
    power: "Voting power",
    votes: "Votes",
    seen: "Last seen",
    slashed: (n: number) => `Slashed ${n}×`,
    jailedUntil: (h: number) => `Jailed until #${h}`,
    you: "You",
  },
  status: {
    active: "Active",
    pending: "Pending",
    jailed: "Jailed",
    unbonding: "Unbonding",
    inactive: "Inactive",
  } as Record<string, string>,
  mine: {
    title: "Your stake",
    notConnected: "Connect a wallet to see your stake and to stake XRGE.",
    locked: "Your wallet is locked. Unlock it to stake or unstake.",
    available: "Available to stake",
    staked: "Staked",
    tier: "Tier",
    status: "Status",
    notValidator: "This wallet is not a validator yet.",
    youAre: (tier: string) => `You're a ${tier} validator`,
    needMore: (n: string) => `Need ${n} more XRGE to reach the 10,000 XRGE minimum.`,
    stake: "Stake XRGE",
    addStake: "Add stake",
    unstake: "Unstake",
    pending: "Stake submitted",
    pendingBody: "Waiting for a block to include your stake transaction.",
    extension: "Your RougeChain extension approves each signature.",
    slashInfo: (n: number, jailed?: number) =>
      `Slashed ${n}×${jailed ? ` · jailed until block #${jailed}` : ""}`,
    missed:
      "Missing blocks when you are the designated proposer freezes your turn; 50 missed blocks auto-slash. Keep the node online.",
  },
  how: {
    title: "How validating works",
    staked: {
      title: "The node's key is the validator",
      body: "The key that stakes is the key that validates. Your node signs blocks with its identity key in node-keys.json, so stake from that exact key (for example rougechain --node-keys <path> stake 10000), or import that key into your wallet before staking here. Staking from a different wallet does not make your node a validator.",
    },
    steps: [
      ["Stake XRGE", "Lock at least 10,000 XRGE from the validator key (10k standard · 100k operator · 1M genesis)."],
      ["Run the node with --mine", "Start a node whose node-keys.json is that staked key, with --mine, and keep it online with peers."],
      ["Propose and vote", "The designated proposer for each height is chosen from the stake-weighted set; blocks are signed with ML-DSA-65."],
      ["Stay reliable", "Missed turns freeze a proposer; slashing and jailing follow repeated misses or double-signing."],
    ] as [string, string][],
    guide: "Validator guide",
    guideUrl: "https://docs.rougechain.io/staking/becoming-validator.html",
  },
  tierBenefits: "Staking tiers",
  runNode: {
    title: "Run a node",
    body: "Strengthen the network by running your own node. Stake XRGE to take part in consensus and share in transaction fees.",
    command:
      "git clone https://github.com/cyberdreadx/rougechain-node && cd rougechain-node && docker compose up -d",
    guide: "Full guide",
    guideUrl: "https://docs.rougechain.io/running-a-node/",
    github: "GitHub",
    nodePage: "Node setup and status",
    genesis: "Join the Genesis Validators program",
  },
  security: {
    title: "Quantum-secure proof of stake",
    body: "Every validator signature uses ML-DSA-65 (CRYSTALS-Dilithium), NIST security level 3.",
  },
};

export const staking = {
  stakeTitle: "Stake XRGE",
  unstakeTitle: "Unstake XRGE",
  reviewTitle: "Review and sign",
  amount: "Amount",
  max: (n: string) => `Max ${n} XRGE`,
  tier: "Validator tier",
  minimum: (tier: string, n: string) => `Minimum stake for the ${tier} tier is ${n} XRGE.`,
  insufficient: "Insufficient XRGE balance.",
  insufficientFee: (fee: number) => `Keep ${fee} XRGE for the network fee.`,
  overStaked: (n: string) => `You have ${n} XRGE staked.`,
  wholeNumber: "Enter a whole number of XRGE.",
  enterAmount: "Enter an amount.",
  review: "Review",
  back: "Back",
  sign: "Sign and stake",
  signUnstake: "Sign and unstake",
  signing: "Signing…",
  cancel: "Cancel",
  rows: {
    action: "Action",
    stake: "Stake",
    unstake: "Unstake",
    amount: "Amount",
    from: "From",
    tier: "Resulting tier",
    remaining: "Remaining stake",
    fee: "Network fee",
    network: "Network",
    endpoint: "Endpoint",
  },
  localSign: "Signed in this browser with your ML-DSA-65 key. Your key never leaves this page.",
  extensionSign: "Your RougeChain extension will ask you to approve this transaction.",
  nodeKeyWarning:
    "Only a node whose node-keys.json holds THIS key will validate with this stake.",
  unstakeWarning:
    "Dropping below 10,000 XRGE removes this key from the validator set.",
  staked: (n: string) => `Staked ${n} XRGE`,
  unstaked: (n: string) => `Unstaked ${n} XRGE`,
  submitted: "Submitted — it takes effect when the next block includes it.",
  failed: "Transaction failed",
};

// ---------------------------------------------------------------- genesis

export const genesis = {
  eyebrow: "RougeChain · Validator program",
  titleA: "Become a ",
  titleEm: "Genesis Validator",
  titleB: " of the first post-quantum L1.",
  lead: "RougeChain is live, quantum-resistant, and permissionless — but a network is only as decentralized as the people securing it. We're recruiting the founding cohort of independent validators. A call for operators, not speculators.",
  facts: [
    ["Network", "mainnet-1 · live"],
    ["Cohort", "10 operators"],
    ["Stake to join", "10,000 XRGE"],
    ["Signatures", "ML-DSA-65"],
  ] as [string, string][],
  honestTitle: "Read this first — the honest part",
  honestBody:
    "Right now, validating RougeChain earns almost nothing: there's no token emission, the reward reserve is empty, and on a young chain fees are near zero. Don't join for yield. Join to be a founding operator of a chain built for the one thing every other chain is ignoring — the day quantum computers break today's cryptography. The economics come later, if the chain earns them. The role, recognition, and position are available now.",
  getsTitle: "What a Genesis Validator gets",
  getsLead:
    "No inflation was created to fund this — it runs on recognition, existing fee share, and treasury XRGE grants, not newly minted tokens.",
  perks: [
    {
      tag: "Recognition",
      title: "Founding status, on-chain",
      body: "A permanent Genesis Validator badge, your node named on the network map, and a listed spot on the public validator leaderboard.",
    },
    {
      tag: "Real weight",
      title: "A real stake, not a cameo",
      body: "Consensus weight comes from self-staked XRGE — so genesis validators receive a treasury XRGE grant to stake as their own, and the team steps its own stake down over time. Your vote and fee share actually count.",
    },
    {
      tag: "Bootstrap grant",
      title: "Cover your costs",
      body: "A monthly XRGE grant for the first 6 months to cover server + gas while fees are thin. A bridge to real fee volume, not a salary.",
    },
    {
      tag: "Support",
      title: "Direct onboarding help",
      body: "Hands-on setup, a private operator channel, and first look at upgrades. You won't be debugging alone.",
    },
    {
      tag: "Voice",
      title: "A say in what's next",
      body: "Genesis validators get first input on the decisions that matter — including whether RougeChain adopts a sustainable staking emission.",
    },
    {
      tag: "The mission",
      title: "Secure something that matters",
      body: "You'll run consensus on the first production L1 that's already post-quantum. That's the pitch. If it doesn't move you, this isn't for you — and that's fine.",
    },
  ],
  asksTitle: "What we ask of you",
  asks: [
    ["Stake", "Hold and stake at least 10,000 XRGE from your validator key — trivial to acquire; the barrier is commitment, not capital."],
    ["A real node", "A reachable node (1 vCPU / 1 GB / 5 GB is enough) with a public URL, kept online."],
    ["Uptime", "Target ≥ 95%. Missing 50 blocks auto-slashes, so treat it like infrastructure."],
    ["Key hygiene", "A dedicated validator key (never your treasury), backed up, and never run on two nodes at once — double-signing is slashable."],
    ["Independence", "You are not the founding team. The whole point is that you're someone else."],
    ["Commitment", "A 6-month run so the cohort is stable enough to mean something."],
  ] as [string, string][],
  joinTitle: "How to join",
  steps: [
    { t: "Apply", body: "Tell us who you are and where you'll run." },
    {
      t: "Spin up a node",
      body: "Follow the validator guide — it generates your identity key (node-keys.json) on first run.",
      link: { label: "validator guide", href: "https://docs.rougechain.io/staking/becoming-validator.html" },
    },
    {
      t: "Fund & stake it",
      body: "stakes the exact key your node signs blocks with.",
      code: "rougechain --node-keys <path> stake 10000",
    },
    {
      t: "Go live & verify",
      body: "Run with --mine, then validator-status until every check reads ✓. We fund your stake grant, badge you, and you're in.",
    },
  ] as { t: string; body: string; code?: string; link?: { label: string; href: string } }[],
  fyi: "FYI — the \"no yield yet\" reality is by design, not neglect. A sustainable staking emission is on the table as a deliberate, holder-visible decision — and genesis validators help make that call.",
  ctaTitle: "Secure the quantum-safe chain",
  ctaBody:
    "Ten operators. Real independence. The founding validator set of the first live post-quantum L1. If that's you, step up.",
  ctaGuide: "Start the validator guide",
  ctaValidators: "View validators",
};

// ---------------------------------------------------------------- node

export const node = {
  eyebrow: "Build / Run a node",
  title: "Run a node",
  lead: "Help power the network. Prerequisites, commands, and the live status of the nodes this page can reach.",
  dashboardTitle: "Live nodes",
  scanning: "Scanning for nodes…",
  scanningBody: "Checking the network API and local ports 5100–5104.",
  none: "No nodes detected",
  noneBody: "Start a node to see it here. Local nodes on ports 5100–5104 are detected automatically.",
  online: (n: number) => `Network online · ${n} validators`,
  summary: {
    validators: "Validators",
    peers: "Total peers",
    tip: "Tip height",
    finalized: "Finalized",
    mining: "Mining nodes",
  },
  card: {
    core: (i: number) => `Node ${i}`,
    mining: "Mining",
    peers: "Peers",
    tip: "Tip height",
    finalized: "Finalized",
    chain: "Chain",
    port: "Port",
    fees: "Fees",
    lastBlock: "Last block",
    yes: "Yes",
    no: "No",
  },
  chains: (ids: string) => `Detected chain IDs: ${ids}`,
  needTitle: "What you need",
  needs: ["A computer or VPS (1 vCPU / 1 GB / 5 GB)", "Docker, or Rust to build from source", "An internet connection"],
  stepsTitle: "Commands",
  steps: [
    {
      title: "Option A: Docker (fastest)",
      body: "No Rust needed — one command and you're running. Skip to step 3 once it's running.",
      code: ["docker run -d --name rougechain-node -p 5100:5100 -v qv-data:/data rougechain/node --mine --peers https://api.rougechain.io/api"],
    },
    {
      title: "Option B, step 1: Install Rust",
      body: "If you don't have Rust yet, run this in your terminal. It takes about 2 minutes.",
      code: ["curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"],
    },
    {
      title: "Step 2: Download and build",
      body: "Clone the code from GitHub and build it. This takes a few minutes the first time.",
      code: [
        "git clone https://github.com/cyberdreadx/rougechain-node.git",
        "cd rougechain-node/core && cargo build --release -p quantum-vault-daemon",
      ],
    },
    {
      title: "Step 3: Start your node",
      body: "Your node connects to the network, syncs the chain and starts running. --genesis and --chain-id are required to join mainnet — without them the node builds its own genesis and refuses to sync.",
      code: [
        './target/release/quantum-vault-daemon --genesis daemon/genesis-mainnet.json --chain-id rougechain-mainnet-1 --api-port 5100 --peers "https://api.rougechain.io/api"',
      ],
    },
    {
      title: "Optional: name your node",
      body: "Show up with a name on the network map with --node-name.",
      code: [
        './target/release/quantum-vault-daemon --genesis daemon/genesis-mainnet.json --chain-id rougechain-mainnet-1 --api-port 5100 --node-name "MyAwesomeNode" --peers "https://api.rougechain.io/api"',
      ],
    },
  ] as { title: string; body: string; code: string[] }[],
  optionsTitle: "More options",
  options: [
    ["Mine blocks", "--mine"],
    ["Custom data dir", "--data-dir ./my-data"],
    ["API key auth", '--api-keys "key1,key2"'],
    ["Public URL", '--public-url "https://yournode.com"'],
  ] as [string, string][],
  validatorTitle: "Become a validator",
  validatorLead:
    "Validators are nodes that propose blocks and vote. The node's identity key is the validator: it must hold at least 10,000 XRGE of stake.",
  validatorSteps: [
    ["Find your node key", "On first run the node writes its identity key to node-keys.json in its data dir. That key signs every block your node proposes."],
    ["Fund that key", "Send at least 10,000 XRGE (plus fees) to the node key's address. Bridge from Base or buy XRGE first if you need to."],
    ["Stake from that key", "Run rougechain --node-keys <path> stake 10000, or import that key into a wallet and stake on the Validators page. Staking from any other wallet does not make your node a validator."],
    ["Enable mining", "Restart the node with --mine and keep it online with peers. Check validator-status until every check passes."],
  ] as [string, string][],
  validatorCommand:
    './target/release/quantum-vault-daemon --genesis daemon/genesis-mainnet.json --chain-id rougechain-mainnet-1 --api-port 5100 --mine --node-name "MyValidator" --peers "https://api.rougechain.io/api"',
  validatorsLink: "Go to Validators",
  guideLink: "Validator guide",
  testnetHint:
    "These commands join mainnet. For testnet, use the testnet genesis and chain ID from the node README.",
};

// ---------------------------------------------------------------- agents

export const agents = {
  eyebrow: "Build / MCP native",
  title: "AI agents on RougeChain",
  lead: "RougeChain ships a Model Context Protocol server. AI agents can query chain state, use DeFi, deploy contracts and manage wallets — all through a standard protocol.",
  mcpUrl: "https://modelcontextprotocol.io/",
  howTitle: "How it works",
  flow: [
    ["AI agent", "Claude, GPT, custom"],
    ["MCP server", "{n} blockchain tools"],
    ["Node API", "REST + JSON-RPC"],
    ["RougeChain L1", "ML-DSA + ML-KEM"],
  ] as [string, string][],
  flowNote:
    "Agents communicate via stdio over the MCP protocol. All on-chain operations keep post-quantum guarantees (ML-DSA-65 / ML-KEM-768).",
  toolsTitle: "What agents can do",
  toolsLead: (total: number, cats: number, read: number, write: number) =>
    `${total} tools across ${cats} categories — ${read} read-only, plus ${write} that sign real transactions. Write tools activate when the server is configured with a wallet.`,
  signsTx: "signs tx",
  toolsCount: (n: number) => `${n} tool${n === 1 ? "" : "s"}`,
  quickTitle: "Quick start",
  install: "Install the MCP server",
  installCmd: "npm install -g @rougechain/mcp-server",
  installNote: "Or use npx @rougechain/mcp-server directly — no global install needed.",
  configTitle: "Add it to your agent config",
  readOnly: "Claude Desktop — read-only",
  recommended: "Recommended",
  readWrite: "Read + write",
  writeNote: (n: number) =>
    `Add ROUGECHAIN_MNEMONIC to unlock the ${n} signing tools. Every transaction is signed locally with ML-DSA-65 — your seed phrase never leaves the server. Use a dedicated low-balance agent wallet; generate one with the generate_wallet tool.`,
  talkTitle: "Start talking to the chain",
  prompts: [
    ["What's the current block height and how many validators are active?", false],
    ["Check the balance of rouge1q8f3x... and list their recent transactions", false],
    ["Get a swap quote for 1000 XRGE to QSHIB with 2% slippage", false],
    ["Show me the latest posts on the social timeline and the top artists", false],
    ["Create a token called AGENT, seed a XRGE/AGENT pool, and post about the launch", true],
    ["Deploy this WASM contract and call the init function", false],
    ["Resolve rougeboss@rouge.quant and show their token holdings", false],
  ] as [string, boolean][],
  needsWallet: "requires a wallet — signs real transactions",
  compatibleTitle: "Compatible agents",
  compatible: [
    ["Claude Desktop", "Drop-in config with native MCP support"],
    ["Cursor IDE", "MCP tools available in agent mode"],
    ["Custom agents", "Any MCP-compatible client via stdio"],
  ] as [string, string][],
  supported: "Supported",
  resourcesTitle: "Resources",
  resources: [
    ["MCP server source", "View on GitHub", "https://github.com/cyberdreadx/rougechain-node/tree/main/mcp-server"],
    ["Documentation", "Full setup and API guide", "https://docs.rougechain.io/advanced/mcp-server.html"],
    ["@rougechain/sdk", "TypeScript SDK on npm", "https://www.npmjs.com/package/@rougechain/sdk"],
    ["MCP specification", "Model Context Protocol docs", "https://modelcontextprotocol.io/"],
  ] as [string, string, string][],
};

export type AgentTool = { name: string; desc: string; write?: boolean };
export const agentToolCategories: { title: string; tools: AgentTool[] }[] = [
  {
    title: "Wallet keys",
    tools: [
      { name: "generate_wallet", desc: "Create a fresh ML-DSA-65 wallet + mnemonic" },
      { name: "wallet_info", desc: "Configured signer, address, balance, write status" },
    ],
  },
  {
    title: "Chain",
    tools: [
      { name: "get_chain_stats", desc: "Block height, validators, supply, fees" },
      { name: "get_block", desc: "Fetch any block by height" },
      { name: "get_latest_blocks", desc: "Stream recent blocks" },
    ],
  },
  {
    title: "Wallet",
    tools: [
      { name: "get_balance", desc: "Check XRGE and token balances" },
      { name: "get_transaction", desc: "Look up any transaction by hash" },
      { name: "send_transaction", desc: "Send XRGE or any token to an address", write: true },
      { name: "burn_tokens", desc: "Permanently burn XRGE or a token", write: true },
    ],
  },
  {
    title: "Tokens",
    tools: [
      { name: "list_tokens", desc: "All tokens on the network" },
      { name: "get_token", desc: "Token metadata, supply, and creator" },
      { name: "get_token_holders", desc: "Top holders and supply breakdown" },
      { name: "create_token", desc: "Issue a new custom token", write: true },
      { name: "mint_tokens", desc: "Mint more supply of a mintable token", write: true },
      { name: "update_token_metadata", desc: "Update logo, links, description", write: true },
      { name: "claim_token_metadata", desc: "Claim creator metadata authority", write: true },
    ],
  },
  {
    title: "DeFi",
    tools: [
      { name: "list_pools", desc: "All AMM liquidity pools" },
      { name: "get_swap_quote", desc: "Quote a token swap with slippage" },
      { name: "swap", desc: "Execute a swap on the AMM DEX", write: true },
      { name: "create_pool", desc: "Create a new liquidity pool", write: true },
      { name: "add_liquidity", desc: "Add liquidity and receive LP tokens", write: true },
      { name: "remove_liquidity", desc: "Burn LP tokens to withdraw", write: true },
    ],
  },
  {
    title: "NFTs",
    tools: [
      { name: "list_nft_collections", desc: "Browse NFT collections" },
      { name: "get_nft_collection", desc: "Collection metadata and tokens" },
      { name: "nft_create_collection", desc: "Launch a new NFT collection", write: true },
      { name: "nft_mint", desc: "Mint a single NFT", write: true },
      { name: "nft_batch_mint", desc: "Mint many NFTs in one tx", write: true },
      { name: "nft_transfer", desc: "Transfer an NFT (with optional sale price)", write: true },
      { name: "nft_burn", desc: "Permanently burn an NFT", write: true },
      { name: "nft_lock", desc: "Lock / unlock an NFT", write: true },
      { name: "nft_freeze_collection", desc: "Freeze / unfreeze a collection", write: true },
    ],
  },
  {
    title: "Staking & faucet",
    tools: [
      { name: "stake", desc: "Stake XRGE to secure the chain", write: true },
      { name: "unstake", desc: "Unstake XRGE back to your wallet", write: true },
      { name: "request_faucet", desc: "Claim testnet XRGE (testnet only)", write: true },
    ],
  },
  {
    title: "Validators",
    tools: [{ name: "list_validators", desc: "Active validators and stake" }],
  },
  {
    title: "Smart contracts",
    tools: [
      { name: "list_contracts", desc: "Deployed WASM contracts" },
      { name: "get_contract", desc: "Contract metadata and bytecode" },
      { name: "get_contract_state", desc: "Read contract storage" },
      { name: "get_contract_events", desc: "Contract event history" },
      { name: "deploy_contract", desc: "Deploy a new WASM contract" },
      { name: "call_contract", desc: "Execute a contract method" },
    ],
  },
  {
    title: "Social",
    tools: [
      { name: "get_global_timeline", desc: "Global feed — all posts, newest first" },
      { name: "get_post", desc: "Single post with engagement stats" },
      { name: "get_user_posts", desc: "Posts by a specific user" },
      { name: "get_post_replies", desc: "Threaded replies to a post" },
      { name: "get_track_stats", desc: "Music track plays, likes, comments" },
      { name: "get_artist_stats", desc: "Artist followers and follow state" },
      { name: "create_post", desc: "Publish a post on-chain", write: true },
      { name: "delete_post", desc: "Delete your own post", write: true },
      { name: "repost", desc: "Repost another user's post", write: true },
      { name: "follow", desc: "Follow / unfollow an account", write: true },
      { name: "like_track", desc: "Like / unlike a track or NFT", write: true },
      { name: "comment_on_track", desc: "Comment on a track or NFT", write: true },
    ],
  },
  {
    title: "Messaging",
    tools: [{ name: "list_messenger_wallets", desc: "Registered wallets with display names" }],
  },
  {
    title: "Names & identity",
    tools: [
      { name: "resolve_name", desc: "Resolve rouge.quant / qwalla.mail names" },
      { name: "reverse_lookup_name", desc: "Look up name for a wallet or public key" },
      { name: "register_name", desc: "Register a name to a wallet", write: true },
      { name: "release_name", desc: "Release a name you registered", write: true },
    ],
  },
  {
    title: "Bridge",
    tools: [{ name: "bridge_withdraw", desc: "Withdraw a bridged asset to an EVM address", write: true }],
  },
  {
    title: "Governance & fees",
    tools: [
      { name: "list_proposals", desc: "Governance proposals" },
      { name: "get_fee_info", desc: "Current EIP-1559 dynamic fee data" },
    ],
  },
];

// ---------------------------------------------------------------- status

export const status = {
  eyebrow: "Explore / Network status",
  title: "Network status",
  lead: (network: string) =>
    `Live ${network} figures read from the public node API, plus what is live and what is not.`,
  autoRefresh: "refreshes every 15 s",
  apiError: "Could not reach the API",
  height: "Height",
  finalized: "Finalized",
  validators: "Validators (active / total)",
  peers: "Peers",
  totalStake: "Total stake",
  baseFee: "Base fee",
  burned: "Fees burned",
  chainId: "Chain ID",
  consensusTitle: "Consensus",
  stateRoot: "State root",
  designatedProposer: "Designated proposer (next block)",
  rule: "Rule",
  activation: "Activation height",
  state: "State",
  validatorsTitle: "Validators & node release",
  active: "active",
  inactive: "inactive",
  noValidators: "No validators reported.",
  nodeRelease: "Current node release",
  mandatory: "mandatory upgrade",
  bridgeTitle: "Bridges",
  audits: "Audits",
  footer: "What is live versus built-but-not-activated is maintained at",
  updated: "Facts updated",
  factsMainnet: "Release, consensus and bridge facts describe mainnet.",
  factsUnavailable: "Release facts could not be loaded.",
};

// ---------------------------------------------------------------- regenerate

export const regen = {
  kicker: "RougeChain Regenerate",
  sub: "A regeneration program & treasury on RougeChain",
  titleEm: "Fund the future",
  titleRest: " where you live.",
  lead: "RougeChain Regenerate connects digital infrastructure with real-world regeneration — funding transparent, measurable projects that improve the communities and ecosystems around us.",
  viewProjects: "View projects",
  propose: "Propose a project",
  statementA: "Technology should improve the ",
  statementEm: "territory it touches.",
  statementBody:
    "Global problems are real, but change becomes tangible at the local level. RougeChain Regenerate begins with communities, ecosystems, and infrastructure we can actually see, measure, and improve.",
  solarpunk:
    "A solarpunk stance: technology, architecture, art and community building a future worth living in — not just one that survives.",
  territoryKicker: "First territory",
  territoryName: "TULUM",
  territoryCoords: "20.2114° N · 87.4654° W · Quintana Roo, MX",
  territoryBody:
    "Regeneration should begin somewhere real. RougeChain Regenerate will begin by exploring projects in Tulum, where technology, ecology, culture and rapid development intersect.",
  funded: "Funding live — see the projects below and their on-chain grants.",
  notFunded: "Exploring projects — nothing funded yet.",
  treasuryTitle: "Treasury & impact",
  treasuryLive: "Read live from RougeChain",
  treasuryPending: "Goes live when the treasury address is published",
  treasuryUnreachable: "Couldn't reach the node right now.",
  stat: {
    balance: "Treasury balance",
    funded: "Projects funded",
    deployed: "Total deployed",
    territories: "Active territories",
    notLive: "Not live yet",
  },
  wallet: "Treasury wallet",
  copyAddress: "Copy address",
  donate: "Anyone can donate XRGE to this address. Every donation and every grant is public on-chain.",
  donations: "Donations received",
  viewExplorer: "View in explorer",
  recent: "Recent activity",
  donation: "Donation",
  grant: "Grant",
  noTxs: "No transactions yet.",
  testnet:
    "You're on testnet. The Regenerate treasury is a mainnet wallet, so its figures are hidden here; votes shown come from the testnet node.",
  proofKicker: "Proof of impact",
  proofBody:
    "Every funded project carries a permanent, on-chain impact record — where funding went, what was promised, what was completed, and evidence of the result. Not charity branding: a protocol.",
  protocol: ["Project", "Location", "Funding", "Milestones", "Evidence", "Verification"],
  projectsTitle: "Projects",
  illustrative: "Illustrative candidate proposals — no projects funded yet. Cards populate from real proposals and on-chain records as the pipeline opens.",
  milestones: "Milestones",
  evidence: "Evidence",
  evidencePending: "Evidence: pending",
  fundingNone: "Funding: none yet",
  fundingTbd: "Funding: TBD",
  requested: (n: string) => `${n} XRGE requested`,
  fundedOnChain: (n: string) => `${n} XRGE funded on-chain`,
  proposeTitle: "Have a project for the territory?",
  proposeLead:
    "We're building the first territory in Tulum. If you're working on local ecology, infrastructure, open technology, or community, send it in. We review every proposal and reply.",
};

export const proposalForm = {
  name: "Your name or organisation",
  contact: "Email or Telegram",
  contactPh: "so we can reply",
  project: "Project name",
  location: "Location",
  locationPh: "e.g. Tulum, Quintana Roo",
  category: "Category",
  choose: "Choose one",
  amount: "Funding requested (XRGE)",
  amountPh: "leave blank if unsure",
  payout: "RougeChain address for payment (optional)",
  description: "What will you do, and what changes for the place?",
  milestones: "Milestones and how we'll see the result",
  milestonesPh: "One per line: what gets done, and the evidence (photos, data, receipts)",
  links: "Links (optional)",
  linksPh: "website, socials, prior work",
  submit: "Submit proposal",
  sending: "Sending…",
  discord: "Questions first? Ask on Discord",
  error: "Couldn't send that. Check your connection and try again, or post it on Discord.",
  sentTitle: "Proposal received",
  sentBody:
    "Thanks. We review every proposal and reply to the contact you gave. Accepted projects appear on this page, and their funding shows up on-chain from the treasury wallet.",
  another: "Send another",
};

export const votes = {
  title: "Community votes",
  lead: (capPct: number, turnoutPct: number) =>
    `XRGE holders decide which projects the treasury funds. Weight is your balance when a vote opens, capped at ${capPct}% of eligible supply; team, treasury and exchange wallets don't vote. A proposal passes with ${turnoutPct}% turnout and more yes than no.`,
  signed: "Every vote is signed by the voter's wallet and published with its signature, so anyone can recount.",
  open: "Open a proposal",
  empty: "No proposals yet. Accepted project submissions are opened for a community vote here.",
  unavailable: "Community votes are not available from this node right now.",
  loading: "Loading community votes…",
  status: {
    open: "Voting open",
    passed: "Passed · awaiting payout",
    paid: "Passed · paid",
    failed: "Did not pass",
    cancelled: "Cancelled",
  } as Record<string, string>,
  yes: "Yes",
  no: "No",
  abstain: "Abstain",
  turnout: (have: string, need: string) => `Turnout ${have} / ${need} needed`,
  requests: "Requests",
  to: "To",
  closed: (d: string) => `Closed ${d}`,
  voters: (n: number, h: number) => `${n} voter${n === 1 ? "" : "s"} · snapshot at block ${h}`,
  details: "Details",
  connect: "Connect a wallet to vote.",
  locked: "Unlock your wallet to vote.",
  excluded: "This wallet is a team, treasury or exchange wallet, so it can't vote.",
  noWeight: "This wallet held no XRGE when the vote opened, so it has no vote on this proposal.",
  weight: (w: string, vote: string | null) =>
    `Your weight ${w} XRGE${vote ? ` · you voted ${vote} (you can change it)` : ""}`,
  reviewTitle: "Review and sign your vote",
  reviewRows: { proposal: "Proposal", choice: "Your vote", weight: "Your weight", voter: "Signed by", network: "Network" },
  reviewNote: "Votes are signed messages, not transactions: no fee, no balance moves. You can change your vote while voting is open.",
  sign: "Sign vote",
  cancel: "Cancel",
  recorded: (c: string) => `Vote recorded: ${c}`,
  paidFrom: (n: string) => `Paid ${n} from the treasury`,
  payoutPh: "Treasury payment tx id",
  recordPayout: "Record payout",
  payoutRecorded: "Payout recorded",
  form: {
    intro: (days: number, min: string) =>
      `Opening a proposal snapshots every eligible balance now; voting runs ${days} days. Needs curator rights or ${min} XRGE.`,
    title: "Title",
    summary: "Summary",
    territory: "Territory",
    requested: "Requested XRGE",
    recipient: "Recipient (rouge1…)",
    link: "Details link (https://)",
    submit: "Open for voting",
    opened: "Proposal opened for voting",
  },
};
