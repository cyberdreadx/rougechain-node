// Types of mock-chain.mjs (tests and the Playwright run only).
export declare const KEM_OFF: number[];
export declare const NOTE_OFF: number[];
export declare function hex(u8: Uint8Array): string;
export declare function unhex(s: string): Uint8Array;
export declare function sha256hex(u8: Uint8Array): Promise<string>;
export interface ListingTx {
  height: number;
  index: number;
  tx_hash: string;
  tx_type: string;
  nf1: string;
  nf2: string;
  outputs: { cm_out: string; leaf: number; kem_ct: string; note_ct: string }[];
}
export declare function listingTx(bodyHex: string, height: number, index: number, firstLeaf: number): Promise<ListingTx>;
export declare function bodyFields(bodyHex: string): { kind: number; expiry_height: number; nf1: string; nf2: string; v_in: bigint; v_out: bigint; fee: bigint };
export interface Report { height: number; tree_root: string; nullifier_acc: string; note_count: number; nullifier_count: number; ciphertext_acc: string }
export interface Listing { active: boolean; tip_height: number; from_height: number; next_height: number; txs: ListingTx[]; success: boolean }
export declare class MockChain {
  constructor(o: { api: unknown; observerAddress: string; observerKey: string; activation: number; chainId?: string });
  activation: number;
  chainId: string;
  tip: number;
  blocks: Map<number, string[]>;
  txs: Map<number, ListingTx[]>;
  reports: Map<number, Report>;
  nonces: Map<string, number>;
  addBlock(bodies?: string[]): Promise<number>;
  advanceTo(h: number): Promise<void>;
  listing(since: number, blocks?: number, tip?: number): Listing;
  stats(tip?: number): Record<string, unknown> & { report: Report | null };
}
export declare function inactiveListing(since: number, tip: number): Listing;
export declare function inactiveStats(tip: number): Record<string, unknown>;
export declare function nodeAnswer(chain: MockChain, url: string, init?: RequestInit, opts?: { tip?: number }): { status: number; text: string; submitted?: unknown };
