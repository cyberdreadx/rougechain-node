/**
 * Tests only: the wallet vector chain (core/shield-v2/vectors/wallet/) served by mocked nodes in
 * the node's real response shapes, and a client wired to them. No real node is ever called.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { MockChain, nodeAnswer, type Listing } from "./mock-chain.mjs";
import { loadCore } from "./wasm-node";
import { ShieldClient, stateForNewlyGeneratedPhrase } from "../client";
import { MemoryStore, deriveStateKey, type Store } from "../store";
import type { Net, NetAnswer } from "../node-io";

/** The repository root, found from the working directory (import.meta.url is not a file URL under jsdom). */
export function repoRoot(): string {
  let dir = process.cwd();
  while (!existsSync(path.join(dir, "core/shield-v2/vectors/wallet"))) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error("repository root not found");
    dir = up;
  }
  return dir;
}
const VECTORS = () => path.join(repoRoot(), "core/shield-v2/vectors/wallet");
const json = (f: string) => JSON.parse(readFileSync(path.join(VECTORS(), f), "utf8"));

export interface VectorWallet {
  name: string;
  recovery_phrase: string;
  bip39_seed: string;
  address: string;
  address_fingerprint: string;
  pk: string;
}
export const vectors = {
  keys: json("keys.json") as { wallets: VectorWallet[] },
  txs: json("transactions.json") as { activation_height: number; chain_id: string; transactions: { height: number; body: string; tx_type: string; recipient_address?: string }[] },
  roots: json("state_root.json") as { states: { state: { tree_root: string; nullifier_acc: string; note_count: number; nullifier_count: number } }[] },
};

export const ORIGINS = ["https://node-a.example", "https://node-b.example", "https://node-c.example"];
export const Q = 1_000_000_000n;

export const unhexSeed = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
export const wallet = (name: "wallet-1" | "wallet-2") => vectors.keys.wallets.find((w) => w.name === name)!;

/** An observer that is neither vector wallet. */
function observer() {
  const api = loadCore();
  const seed = new Uint8Array(64).fill(7);
  const info = JSON.parse(api.shielded_address(seed));
  return { address: info.address as string, key: api.export_scan_key(seed, true) };
}

/** A chain. `blocks`: height → which vector transactions (by index) it holds; default the truth (3, 4, 5). */
export async function vectorChain(tip = 20, blocks: Record<number, number[]> | null = null): Promise<MockChain> {
  const api = loadCore();
  const o = observer();
  const chain = new MockChain({ api, observerAddress: o.address, observerKey: o.key, activation: vectors.txs.activation_height, chainId: vectors.txs.chain_id });
  const plan = blocks ?? Object.fromEntries(vectors.txs.transactions.map((t, i) => [t.height, [i]]));
  while (chain.tip < tip) {
    const h = chain.tip + 1;
    await chain.addBlock((plan[h] ?? []).map((i) => vectors.txs.transactions[i].body));
  }
  return chain;
}

export type Behaviour = (url: string, init?: RequestInit) => NetAnswer | null | undefined;

/**
 * The network of a test: each origin answers from its chain (honest), or as its behaviour says
 * (`undefined` from a behaviour: answer honestly). Records every request.
 */
export class TestNet implements Net {
  calls: { url: string; init?: RequestInit }[] = [];
  submitted: { origin: string; body: string }[] = [];
  nodes = new Map<string, { chain: MockChain; tip?: number; behave?: Behaviour; silent?: boolean }>();
  constructor(chain: MockChain, origins = ORIGINS) {
    for (const o of origins) this.nodes.set(o, { chain });
  }
  set(origin: string, n: Partial<{ chain: MockChain; tip: number | undefined; behave: Behaviour | undefined; silent: boolean }>) {
    this.nodes.set(origin, { ...this.nodes.get(origin)!, ...n });
  }
  async request(url: string, init?: RequestInit): Promise<NetAnswer | null> {
    this.calls.push({ url, init });
    const origin = new URL(url).origin;
    const n = this.nodes.get(origin);
    if (!n || n.silent) return null;
    const custom = n.behave?.(url, init);
    if (custom !== undefined) return custom;
    const a = nodeAnswer(n.chain, url, init, { tip: n.tip });
    if (a.submitted !== undefined) this.submitted.push({ origin, body: String(a.submitted) });
    return { status: a.status, text: a.text };
  }
  listingCalls(origin?: string) {
    return this.calls.filter((c) => c.url.includes("/api/shield-v2/notes") && (!origin || c.url.startsWith(origin)));
  }
}

export const page = (l: Listing) => ({ status: 200, text: JSON.stringify(l) });

/** A client for a vector wallet. `soleCopy`: the state was made for a phrase generated here (the
 * only silent `assert_sole_copy`, by name — as the reference's `configure_as_sole_copy`). */
export async function makeClient(o: { wallet: "wallet-1" | "wallet-2"; net: Net; store?: Store; origins?: string[]; soleCopy?: boolean; open?: boolean }) {
  const api = loadCore();
  const w = wallet(o.wallet);
  const seed = unhexSeed(w.bip39_seed);
  const key = await deriveStateKey(seed);
  const store = o.store ?? new MemoryStore();
  const id = `testnet:${w.pk}`;
  if (o.soleCopy) await stateForNewlyGeneratedPhrase(api, store, key, id, w.address);
  const client = new ShieldClient({ api, store, net: o.net, key, id, address: w.address, scanKey: api.export_scan_key(seed, true), origins: o.origins ?? ORIGINS });
  if (o.open !== false) await client.open();
  return { client, store, seed, api, key, id, w };
}

export async function rounds(client: ShieldClient, n: number) {
  let v = client.viewModel();
  for (let i = 0; i < n; i++) v = await client.round();
  return v;
}
