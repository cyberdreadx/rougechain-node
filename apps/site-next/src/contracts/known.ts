/**
 * Contracts the explorer can recognise, keyed by code hash (the node's `code_hash` is the
 * sha256 of the deployed WASM). A match means the deployed bytes are exactly the template
 * shipped in this repo, so its method list and argument shapes apply. Like a verified
 * contract on Etherscan, but by exact bytes instead of a source upload.
 *
 * `known.test.ts` checks every hash against the committed `.wasm` file, so a rebuilt
 * template that isn't updated here fails the tests instead of silently going unrecognised.
 */

export interface KnownMethod {
  /** Read-only: runs as a free query, nothing is signed or committed. */
  read?: boolean;
  /** Example arguments (JSON). `{{me}}` becomes the connected wallet's rouge1 address. */
  args: string;
  /** Payment the call expects: XRGE as a decimal string, tokens in raw units. */
  attach?: { symbol: string; amount: string };
  /** What the method does, in one or two sentences. */
  about: string;
  /** Something that can go wrong for the caller. Shown as a warning. */
  warning?: string;
}

export interface KnownContract {
  id: string;
  name: string;
  summary: string;
  /** Repository folder holding the source. */
  dir: string;
  codeHash: string;
  methods: Record<string, KnownMethod>;
}

export const KNOWN_CONTRACTS: KnownContract[] = [
  {
    id: "nft_marketplace",
    name: "NFT marketplace",
    summary: "Escrow listings, buy with attached XRGE, royalties paid on chain.",
    dir: "contracts/nft_marketplace",
    codeHash: "ef3df6a35279b237d02a36a537be4878a1ede9e2c9f5f885f9771ad6c96b83a6",
    methods: {
      listing_count: { read: true, args: "{}", about: "The highest listing id issued so far (0 = none). Ids run from 1." },
      listing: {
        read: true,
        args: '{"listing": 1}',
        about: "One listing: seller, collection, token, price in quanta, and whether it is active and escrowed. Buyable when exists and escrowed are both true.",
      },
      list: {
        args: '{"collection": "col:…", "token_id": 1, "price": 2000000000}',
        about: "List an NFT you own. Price is in quanta (1 XRGE = 1,000,000,000).",
        warning: "After listing, send the NFT to this contract address to escrow it. Never send an NFT here without listing it first: nothing can return it.",
      },
      buy: {
        args: '{"listing": 1}',
        attach: { symbol: "XRGE", amount: "2" },
        about: "Buy a listing. Attach exactly the listing price; the royalty goes to the collection's recipient and the rest to the seller.",
      },
      cancel: { args: '{"listing": 1}', about: "Seller only. Deletes the listing and returns the NFT if it is escrowed for it." },
    },
  },
  {
    id: "xrge_staking",
    name: "XRGE staking",
    summary: "Stake XRGE and share a reward pot that streams over time.",
    dir: "contracts/xrge_staking",
    codeHash: "9bb7c201daa60f68a1239c0a8740f711f7d1c9de11f5aa04dbe4ea049c408771",
    methods: {
      info: { read: true, args: "{}", about: "Pool totals: staked, pending unstakes, reward pot, reward rate (quanta per second) and when streaming ends." },
      account: { read: true, args: '{"address": "{{me}}"}', about: "One staker: staked, earned, pending unstake, unlock time and what is withdrawable." },
      stake: { args: "{}", attach: { symbol: "XRGE", amount: "100" }, about: "Stake the attached XRGE." },
      claim: { args: "{}", about: "Pay out the rewards earned so far." },
      request_unstake: {
        args: '{"amount": 40000000000}',
        about: "Start unstaking an amount in quanta (1 XRGE = 1,000,000,000). It becomes withdrawable 3 days later.",
      },
      cancel_unstake: { args: "{}", about: "Put a pending unstake back into the stake." },
      withdraw: { args: "{}", about: "Withdraw unstaked XRGE once the 3-day delay has passed." },
      fund: {
        args: '{"duration": 86400}',
        attach: { symbol: "XRGE", amount: "864" },
        about: "Add the attached XRGE to the reward pot, streamed over `duration` seconds.",
      },
    },
  },
  {
    id: "loot_roll",
    name: "Loot roll",
    summary: "A game: pay to commit, settle two blocks later from a block hash.",
    dir: "contracts/loot_roll",
    codeHash: "1da7c0bf5873c5da79d03ab57a8bd02fec3c2bff8af04747d7af833071feaedc",
    methods: {
      roll: { args: "{}", attach: { symbol: "XRGE", amount: "0.5" }, about: "Pay 0.5 XRGE or more to commit a roll. One open roll per player." },
      settle: { args: "{}", about: "Settle your open roll and receive the prize. Works from two blocks after the roll; expires after 250 blocks." },
      setup: { args: "{}", about: "Creates the contract's LOOT collection. Only needed once, after deployment." },
    },
  },
  {
    id: "royalty_splitter",
    name: "Royalty splitter",
    summary: "Receives XRGE and pays it out to fixed recipients by share.",
    dir: "contracts/royalty_splitter",
    codeHash: "d065ee48e4627f3d69366e05ede0ec7a51df4cc2362fa97c563d7b052d3c0be2",
    methods: {
      split: { args: "{}", about: "Pay the contract's XRGE balance out to its recipients by share." },
    },
  },
  {
    id: "counter",
    name: "Counter",
    summary: "The smallest useful contract: storage, arguments, events and the caller.",
    dir: "contracts/counter",
    codeHash: "0b2a61b035ed3a771e1e0ffd670b7d71667c5ea6445003337d7b677162b0582b",
    methods: {
      get: { read: true, args: "{}", about: "The current count." },
      increment: { args: '{"by": 1}', about: "Add to the count and emit an event." },
    },
  },
];

export function identifyContract(codeHash: string | null | undefined): KnownContract | null {
  const h = (codeHash ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) return null;
  return KNOWN_CONTRACTS.find((c) => c.codeHash === h) ?? null;
}

/** Example arguments with `{{me}}` filled in when a wallet address is known. */
export function exampleArgs(m: KnownMethod, me: string | null): string {
  return me ? m.args.replace(/\{\{me\}\}/g, me) : m.args.replace(/\{\{me\}\}/g, "rouge1…");
}
