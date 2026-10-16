/**
 * Starter contracts for the IDE: each is a real contract from the repository's contracts/ folder,
 * with its source (editable, for building locally) and a prebuilt .wasm (deployable as is).
 */
import counterSrc from "../../../../contracts/counter/src/lib.rs?raw";
import counterCargo from "../../../../contracts/counter/Cargo.toml?raw";
import counterReadme from "../../../../contracts/counter/README.md?raw";
import counterWasm from "../../../../contracts/counter/counter.wasm?url";
import marketSrc from "../../../../contracts/nft_marketplace/src/lib.rs?raw";
import marketCargo from "../../../../contracts/nft_marketplace/Cargo.toml?raw";
import marketReadme from "../../../../contracts/nft_marketplace/README.md?raw";
import marketWasm from "../../../../contracts/nft_marketplace/nft_marketplace.wasm?url";
import stakingSrc from "../../../../contracts/xrge_staking/src/lib.rs?raw";
import stakingPool from "../../../../contracts/xrge_staking/src/pool.rs?raw";
import stakingCargo from "../../../../contracts/xrge_staking/Cargo.toml?raw";
import stakingReadme from "../../../../contracts/xrge_staking/README.md?raw";
import stakingWasm from "../../../../contracts/xrge_staking/xrge_staking.wasm?url";
import lootSrc from "../../../../contracts/loot_roll/src/lib.rs?raw";
import lootCargo from "../../../../contracts/loot_roll/Cargo.toml?raw";
import lootReadme from "../../../../contracts/loot_roll/README.md?raw";
import lootWasm from "../../../../contracts/loot_roll/loot_roll.wasm?url";
import splitterSrc from "../../../../contracts/royalty_splitter/src/lib.rs?raw";
import splitterCargo from "../../../../contracts/royalty_splitter/Cargo.toml?raw";
import splitterReadme from "../../../../contracts/royalty_splitter/README.md?raw";
import splitterWasm from "../../../../contracts/royalty_splitter/royalty_splitter.wasm?url";

/** Prefilled call for one method. `{{me}}` is the selected account's rouge1 address;
 *  `{{collection}}` / `{{token}}` come from the template's demo setup on the local chain. */
export interface MethodHint {
  args?: string;
  /** Read-only: run as a free query, nothing is committed. */
  read?: boolean;
  /** Payment to attach: symbol and amount in base units (quanta for XRGE). */
  attach?: { symbol: string; amount: string };
  note?: string;
}

export interface Template {
  id: string;
  name: string;
  summary: string;
  /** Repository folder, for the "build it yourself" instructions. */
  dir: string;
  /** Output file of `cargo build --release --target wasm32-unknown-unknown`. */
  artifact: string;
  files: { path: string; content: string }[];
  wasmUrl: string;
  methods: Record<string, MethodHint>;
  /** Local-chain setup the template needs before its methods make sense. */
  demo?: "nft";
}

const Q = 1_000_000_000n;
const xrge = (n: number) => (BigInt(Math.round(n * 1000)) * Q / 1000n).toString();

export const TEMPLATES: Template[] = [
  {
    id: "counter",
    name: "Counter",
    summary: "The smallest useful contract: storage, arguments, events and the caller.",
    dir: "contracts/counter",
    artifact: "rougechain_counter.wasm",
    files: [
      { path: "src/lib.rs", content: counterSrc },
      { path: "Cargo.toml", content: counterCargo },
      { path: "README.md", content: counterReadme },
    ],
    wasmUrl: counterWasm,
    methods: {
      increment: { args: '{"by": 1}' },
      get: { read: true, args: "{}" },
    },
  },
  {
    id: "nft_marketplace",
    name: "NFT marketplace",
    summary: "Escrow listings, buy with attached XRGE, royalties paid on chain.",
    dir: "contracts/nft_marketplace",
    artifact: "rougechain_nft_marketplace.wasm",
    files: [
      { path: "src/lib.rs", content: marketSrc },
      { path: "Cargo.toml", content: marketCargo },
      { path: "README.md", content: marketReadme },
    ],
    wasmUrl: marketWasm,
    demo: "nft",
    methods: {
      list: {
        args: `{"collection": "{{collection}}", "token_id": {{token}}, "price": ${xrge(2)}}`,
        note: "Then send the NFT to the contract (Local chain → Send NFT). Never send it without listing first.",
      },
      buy: { args: '{"listing": 1}', attach: { symbol: "XRGE", amount: xrge(2) }, note: "Switch to another account to buy." },
      cancel: { args: '{"listing": 1}' },
      listing: { read: true, args: '{"listing": 1}' },
      listing_count: { read: true, args: "{}" },
    },
  },
  {
    id: "xrge_staking",
    name: "XRGE staking",
    summary: "Stake XRGE and share a reward pot that streams over time.",
    dir: "contracts/xrge_staking",
    artifact: "rougechain_xrge_staking.wasm",
    files: [
      { path: "src/lib.rs", content: stakingSrc },
      { path: "src/pool.rs", content: stakingPool },
      { path: "Cargo.toml", content: stakingCargo },
      { path: "README.md", content: stakingReadme },
    ],
    wasmUrl: stakingWasm,
    methods: {
      stake: { args: "{}", attach: { symbol: "XRGE", amount: xrge(100) } },
      fund: { args: '{"duration": 86400}', attach: { symbol: "XRGE", amount: xrge(864) }, note: "Streams the pot over one day. Use Local chain → Advance time to earn." },
      claim: { args: "{}" },
      request_unstake: { args: `{"amount": ${xrge(40)}}`, note: "Withdrawable 3 days later." },
      cancel_unstake: { args: "{}" },
      withdraw: { args: "{}" },
      info: { read: true, args: "{}" },
      account: { read: true, args: '{"address": "{{me}}"}' },
    },
  },
  {
    id: "loot_roll",
    name: "Loot roll",
    summary: "A game: pay to commit, settle two blocks later from a block hash.",
    dir: "contracts/loot_roll",
    artifact: "rougechain_loot_roll.wasm",
    files: [
      { path: "src/lib.rs", content: lootSrc },
      { path: "Cargo.toml", content: lootCargo },
      { path: "README.md", content: lootReadme },
    ],
    wasmUrl: lootWasm,
    methods: {
      setup: { args: "{}", note: "Call once: creates the contract's LOOT collection." },
      roll: { args: "{}", attach: { symbol: "XRGE", amount: xrge(0.5) } },
      settle: { args: "{}", note: "Works from two blocks after the roll." },
    },
  },
  {
    id: "royalty_splitter",
    name: "Royalty splitter",
    summary: "Receives XRGE and pays it out to fixed recipients by share.",
    dir: "contracts/royalty_splitter",
    artifact: "rougechain_royalty_splitter.wasm",
    files: [
      { path: "src/lib.rs", content: splitterSrc },
      { path: "Cargo.toml", content: splitterCargo },
      { path: "README.md", content: splitterReadme },
    ],
    wasmUrl: splitterWasm,
    methods: {
      split: { args: "{}", note: "Send XRGE to the contract first (Local chain → Send XRGE)." },
    },
  },
];

export function templateById(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/** Fill `{{name}}` placeholders; unknown ones stay as they are. */
export function fillPlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (m, k: string) => values[k] ?? m);
}
