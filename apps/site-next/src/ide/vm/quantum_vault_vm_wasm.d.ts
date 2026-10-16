/* tslint:disable */
/* eslint-disable */

export class LocalChain {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Canonical address of a public key or address (what the ledger keys balances by).
     */
    addressOf(who: string): string;
    /**
     * Advance the clock (seconds) — e.g. to pass a contract's unstake delay.
     */
    advanceTime(seconds: bigint): void;
    /**
     * A mutating contract call signed by `caller` (a public key, as on chain), optionally paying
     * `attach_amount` of `attach_symbol` (XRGE in quanta, tokens in raw units). Returns the VM
     * result plus `applied` (whether its moves reached the ledger) and the block it ran in.
     */
    call(caller: string, contract: string, method: string, args_json: string, attach_symbol?: string | null, attach_amount?: string | null, gas_limit?: bigint | null): any;
    /**
     * A new test account: a fresh ML-DSA-65 public key (the private key is discarded — local calls
     * are not signed) funded with `xrge_quanta`. Returns `{ publicKey, address }`.
     */
    createAccount(xrge_quanta: string): any;
    /**
     * Create an NFT collection as a wallet would (`nft_create_collection`). Returns its id.
     */
    createCollection(creator: string, symbol: string, name: string, max_supply: bigint | null | undefined, royalty_bps: number, royalty_recipient?: string | null): string;
    /**
     * Create a token with its whole supply on the creator (raw units).
     */
    createToken(creator: string, symbol: string, supply: string): void;
    /**
     * Deploy a contract. Same checks as the node (size, compiles, exports `memory`).
     * Returns `{ address, codeHash, size }`.
     */
    deploy(deployer: string, bytecode: Uint8Array): any;
    /**
     * A contract's events, most recent first.
     */
    events(contract: string, limit: number): any;
    /**
     * Add XRGE (quanta) to any address or public key — the local faucet.
     */
    fund(who: string, xrge_quanta: string): void;
    /**
     * Mint the next NFT of a collection (creator only). Returns the token id.
     */
    mintNft(minter: string, collection: string, to: string, name: string): bigint;
    /**
     * A fresh local chain. `start_time` is a Unix time in seconds (the page passes the clock).
     */
    constructor(chain_id: string, start_time: bigint);
    static quantaPerXrge(): string;
    /**
     * A read-only call (the node's `/api/contract/:addr/query`): nothing is committed.
     */
    query(caller: string, contract: string, method: string, args_json: string): any;
    /**
     * Everything the IDE shows: height, XRGE (quanta, as strings), tokens, collections, NFTs, contracts.
     */
    snapshot(): any;
    /**
     * A contract's storage: `[{ key, value }]` as hex.
     */
    storage(contract: string): any;
    /**
     * Wallet `nft_transfer` (no sale price): the owner sends an NFT to an account or a contract.
     */
    transferNft(from: string, collection: string, token_id: bigint, to: string): void;
    transferToken(from: string, to: string, symbol: string, amount: string): void;
    /**
     * Move XRGE (quanta) between accounts, like a wallet transfer (no fee locally).
     */
    transferXrge(from: string, to: string, quanta: string): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_localchain_free: (a: number, b: number) => void;
    readonly localchain_addressOf: (a: number, b: number, c: number) => [number, number];
    readonly localchain_advanceTime: (a: number, b: bigint) => void;
    readonly localchain_call: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: bigint) => [number, number, number];
    readonly localchain_createAccount: (a: number, b: number, c: number) => [number, number, number];
    readonly localchain_createCollection: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: bigint, j: number, k: number, l: number) => [number, number, number, number];
    readonly localchain_createToken: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly localchain_deploy: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly localchain_events: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly localchain_fund: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly localchain_mintNft: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [bigint, number, number];
    readonly localchain_new: (a: number, b: number, c: bigint) => [number, number, number];
    readonly localchain_quantaPerXrge: () => [number, number];
    readonly localchain_query: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly localchain_snapshot: (a: number) => [number, number, number];
    readonly localchain_storage: (a: number, b: number, c: number) => [number, number, number];
    readonly localchain_transferNft: (a: number, b: number, c: number, d: number, e: number, f: bigint, g: number, h: number) => [number, number];
    readonly localchain_transferToken: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number];
    readonly localchain_transferXrge: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
