/**
 * Strict normalizers: every node response is checked field by field and converted to a small
 * typed view. Unexpected shapes throw ShapeError; nothing is defaulted into existence. Shapes
 * were taken from core/daemon/src/main.rs and verified against live mainnet/testnet responses
 * (fixtures in ./fixtures).
 */
import { swapSides, txAmountSymbol } from "./format";

export class ShapeError extends Error {
  constructor(what: string) {
    super(`Unexpected API response: ${what}`);
    this.name = "ShapeError";
  }
}
export class ChainMismatchError extends Error {
  constructor(expected: string, got: unknown) {
    super(`Wrong chain: expected ${expected}, node reported ${String(got)}`);
    this.name = "ChainMismatchError";
  }
}
export class NotFoundError extends Error {
  constructor(what = "Not found") {
    super(what);
    this.name = "NotFoundError";
  }
}

type Obj = Record<string, unknown>;

export function obj(value: unknown, what = "object"): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ShapeError(what);
  return value as Obj;
}
function arr(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new ShapeError(what);
  return value;
}
export function uint(value: unknown, what = "integer"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ShapeError(what);
  return value;
}
function num(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ShapeError(what);
  return value;
}
function nonNegative(value: unknown, what: string): number {
  const n = num(value, what);
  if (n < 0) throw new ShapeError(what);
  return n;
}
export function text(value: unknown, what = "string"): string {
  if (typeof value !== "string" || !value) throw new ShapeError(what);
  return value;
}
function textOrEmpty(value: unknown, what: string): string {
  if (typeof value !== "string") throw new ShapeError(what);
  return value;
}
function optText(value: unknown, what: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return textOrEmpty(value, what);
}
function optNum(value: unknown, what: string): number | null {
  if (value === null || value === undefined) return null;
  return num(value, what);
}
function hex(value: unknown, what: string, length?: number): string {
  const s = text(value, what);
  if (!/^[0-9a-f]+$/.test(s) || (length !== undefined && s.length !== length)) throw new ShapeError(what);
  return s;
}
function optHex(value: unknown, what: string, length?: number): string | null {
  return value === null || value === undefined ? null : hex(value, what, length);
}
function bool(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw new ShapeError(what);
  return value;
}
function optBool(value: unknown, what: string): boolean {
  return value === null || value === undefined ? false : bool(value, what);
}
function successFlag(o: Obj, what: string) {
  if (o.success !== true) throw new ShapeError(`${what}.success`);
}

// ─── Stats ───────────────────────────────────────────────────────────────────

export interface ChainStats {
  chainId: string;
  height: number;
  finalizedHeight: number | null;
  peers: number;
  baseFee: number | null;
  totalFeesCollected: number | null;
  totalFeesBurned: number | null;
  nodeName: string | null;
}

export function normalizeStats(raw: unknown, expectedChainId: string): ChainStats {
  const s = obj(raw, "stats");
  if (s.chain_id !== expectedChainId) throw new ChainMismatchError(expectedChainId, s.chain_id);
  return {
    chainId: expectedChainId,
    height: uint(s.network_height, "stats.network_height"),
    finalizedHeight: s.finalized_height === undefined ? null : uint(s.finalized_height, "stats.finalized_height"),
    peers: uint(s.connected_peers, "stats.connected_peers"),
    baseFee: optNum(s.base_fee, "stats.base_fee"),
    totalFeesCollected: optNum(s.total_fees_collected, "stats.total_fees_collected"),
    totalFeesBurned: optNum(s.total_fees_burned, "stats.total_fees_burned"),
    nodeName: optText(s.node_name, "stats.node_name"),
  };
}

export function normalizeValidatorCount(raw: unknown): number {
  const v = obj(raw, "validators");
  successFlag(v, "validators");
  return arr(v.validators, "validators.validators").length;
}

// ─── Transactions ────────────────────────────────────────────────────────────

export interface TxView {
  id: string;
  blockHeight: number;
  blockHash: string;
  blockTime: number;
  type: string;
  from: string;
  /** Recipient (pubkey hex or rouge1) when the transaction names one. */
  to: string | null;
  amount: number | null;
  symbol: string;
  fee: number;
  nonce: number | null;
  faucet: boolean;
  payload: Obj;
  direction?: "in" | "out";
}

interface RawTx {
  type: string;
  from: string;
  fee: number;
  nonce: number | null;
  payload: Obj;
}

/** TxV1 as serialised by the node (snake_case, payload object with nullable fields). */
function normalizeTxBody(raw: unknown, what: string): RawTx {
  const t = obj(raw, what);
  const type = text(t.tx_type, `${what}.tx_type`);
  if (!/^[a-z0-9_]{1,40}$/.test(type)) throw new ShapeError(`${what}.tx_type`);
  const payload = t.payload === null || t.payload === undefined ? {} : obj(t.payload, `${what}.payload`);
  return {
    type,
    from: textOrEmpty(t.from_pub_key, `${what}.from_pub_key`),
    fee: nonNegative(t.fee, `${what}.fee`),
    nonce: t.nonce === undefined ? null : uint(t.nonce, `${what}.nonce`),
    payload,
  };
}

function txView(
  id: string,
  body: RawTx,
  block: { height: number; hash: string; time: number },
): TxView {
  const p = body.payload;
  const faucet = p.faucet === true;
  const type = faucet ? "faucet" : body.type;
  const to = typeof p.to_pub_key_hex === "string" && p.to_pub_key_hex
    ? p.to_pub_key_hex
    : typeof p.target_pub_key === "string" && p.target_pub_key
      ? p.target_pub_key
      : null;
  const swap = type === "swap" ? swapSides(p) : null;
  const amount = swap?.amountIn ?? (typeof p.amount === "number" && Number.isFinite(p.amount) ? p.amount : null);
  return {
    id,
    blockHeight: block.height,
    blockHash: block.hash,
    blockTime: block.time,
    type,
    from: body.from,
    to,
    amount,
    symbol: txAmountSymbol(type, p),
    fee: body.fee,
    nonce: body.nonce,
    faucet,
    payload: p,
  };
}

/** One item of /txs or /address/:a/transactions ({ txId, blockHeight, blockHash, blockTime, tx }). */
export function normalizeTxItem(raw: unknown, what = "tx"): TxView {
  const item = obj(raw, what);
  const view = txView(hex(item.txId, `${what}.txId`, 64), normalizeTxBody(item.tx, `${what}.tx`), {
    height: uint(item.blockHeight, `${what}.blockHeight`),
    hash: hex(item.blockHash, `${what}.blockHash`, 64),
    time: uint(item.blockTime, `${what}.blockTime`),
  });
  if (item.direction !== undefined) {
    if (item.direction !== "in" && item.direction !== "out") throw new ShapeError(`${what}.direction`);
    view.direction = item.direction;
  }
  return view;
}

export interface TxPage {
  txs: TxView[];
  total: number;
}

export function normalizeTxs(raw: unknown): TxPage {
  const r = obj(raw, "txs");
  return {
    txs: arr(r.txs, "txs.txs").map((t, i) => normalizeTxItem(t, `txs[${i}]`)),
    total: uint(r.total, "txs.total"),
  };
}

export function normalizeAddressTxs(raw: unknown): TxPage {
  const r = obj(raw, "address transactions");
  successFlag(r, "address transactions");
  return {
    txs: arr(r.transactions, "transactions").map((t, i) => normalizeTxItem(t, `transactions[${i}]`)),
    total: uint(r.total, "transactions.total"),
  };
}

export interface ReceiptLog {
  event: string;
  topics: string[];
  data: unknown;
}
export interface Receipt {
  status: "success" | "failed";
  failReason: string | null;
  feePaid: number | null;
  gasUsed: number | null;
  logs: ReceiptLog[];
}

export function normalizeReceipt(raw: unknown): Receipt {
  const r = obj(raw, "receipt");
  let status: Receipt["status"];
  let failReason: string | null = null;
  if (r.status === "Success") status = "success";
  else if (r.status && typeof r.status === "object" && "Success" in (r.status as Obj)) status = "success";
  else if (r.status && typeof r.status === "object" && "Failed" in (r.status as Obj)) {
    status = "failed";
    failReason = optText((r.status as Obj).Failed, "receipt.status.Failed");
  } else throw new ShapeError("receipt.status");
  const logs = r.logs === undefined || r.logs === null ? [] : arr(r.logs, "receipt.logs");
  return {
    status,
    failReason,
    feePaid: optNum(r.fee_paid, "receipt.fee_paid"),
    gasUsed: r.gas_used === undefined || r.gas_used === null ? null : uint(r.gas_used, "receipt.gas_used"),
    logs: logs.map((l, i) => {
      const log = obj(l, `receipt.logs[${i}]`);
      const topics = log.topics === undefined || log.topics === null ? [] : arr(log.topics, "topics");
      return {
        event: optText(log.event ?? log.event_type, `receipt.logs[${i}].event`) ?? "—",
        topics: topics.map((t) => textOrEmpty(t, "topic")),
        data: log.data ?? null,
      };
    }),
  };
}

export interface TxDetail extends TxView {
  receipt: Receipt | null;
  signatureBytes: number | null;
}

export function normalizeTxDetail(raw: unknown): TxDetail {
  const r = obj(raw, "tx detail");
  successFlag(r, "tx detail");
  const view = normalizeTxItem(r, "tx detail");
  const tx = obj(r.tx, "tx detail.tx");
  return {
    ...view,
    receipt: r.receipt === null || r.receipt === undefined ? null : normalizeReceipt(r.receipt),
    signatureBytes: typeof tx.sig === "string" ? Math.floor(tx.sig.length / 2) : null,
  };
}

// ─── Blocks ──────────────────────────────────────────────────────────────────

export interface BlockSummary {
  height: number;
  hash: string;
  prevHash: string;
  time: number;
  txCount: number;
  proposer: string;
  txHash: string | null;
  stateRoot: string | null;
}

/** BlockV1 as returned by /blocks (header + txs + proposer_sig + hash). */
export function normalizeBlockV1(raw: unknown, expectedChainId: string, what = "block"): BlockSummary {
  const b = obj(raw, what);
  const h = obj(b.header, `${what}.header`);
  if (h.chain_id !== expectedChainId) throw new ChainMismatchError(expectedChainId, h.chain_id);
  return {
    height: uint(h.height, `${what}.height`),
    hash: hex(b.hash, `${what}.hash`, 64),
    prevHash: hex(h.prev_hash, `${what}.prev_hash`),
    time: uint(h.time, `${what}.time`),
    txCount: arr(b.txs, `${what}.txs`).length,
    proposer: textOrEmpty(h.proposer_pub_key, `${what}.proposer_pub_key`),
    txHash: optHex(h.tx_hash, `${what}.tx_hash`),
    stateRoot: optHex(h.state_root, `${what}.state_root`),
  };
}

export interface BlocksPage {
  blocks: BlockSummary[];
  totalHeight: number;
  page: number;
  totalPages: number;
}

export function normalizeBlocksPage(raw: unknown, expectedChainId: string): BlocksPage {
  const r = obj(raw, "blocks");
  return {
    blocks: arr(r.blocks, "blocks.blocks").map((b, i) => normalizeBlockV1(b, expectedChainId, `blocks[${i}]`)),
    totalHeight: uint(r.total_height, "blocks.total_height"),
    page: uint(r.page, "blocks.page"),
    totalPages: uint(r.total_pages, "blocks.total_pages"),
  };
}

export interface BlockDetail extends BlockSummary {
  totalFees: number;
  transactions: TxView[];
}

/** /block/:height → { success, block: { height, hash, prevHash, time, proposer, txHash, stateRoot, txCount, totalFees, transactions } } */
export function normalizeBlockDetail(raw: unknown): BlockDetail {
  const r = obj(raw, "block detail");
  successFlag(r, "block detail");
  const b = obj(r.block, "block detail.block");
  const height = uint(b.height, "block.height");
  const hash = hex(b.hash, "block.hash", 64);
  const time = uint(b.time, "block.time");
  const transactions = arr(b.transactions, "block.transactions").map((t, i) => {
    const item = obj(t, `block.transactions[${i}]`);
    return txView(hex(item.txId, "block.transactions.txId", 64), normalizeTxBody(item.tx, `block.transactions[${i}].tx`), {
      height,
      hash,
      time,
    });
  });
  const txCount = uint(b.txCount, "block.txCount");
  if (txCount !== transactions.length) throw new ShapeError("block.txCount");
  return {
    height,
    hash,
    prevHash: hex(b.prevHash, "block.prevHash"),
    time,
    txCount,
    proposer: textOrEmpty(b.proposer, "block.proposer"),
    txHash: optHex(b.txHash, "block.txHash"),
    stateRoot: optHex(b.stateRoot, "block.stateRoot"),
    totalFees: nonNegative(b.totalFees, "block.totalFees"),
    transactions,
  };
}

// ─── Addresses ───────────────────────────────────────────────────────────────

export interface ResolvedAddress {
  address: string;
  publicKey: string;
}

export function normalizeResolve(raw: unknown): ResolvedAddress {
  const r = obj(raw, "resolve");
  if (r.success === false) throw new NotFoundError("Address not found");
  successFlag(r, "resolve");
  return { address: text(r.address, "resolve.address"), publicKey: hex(r.publicKey, "resolve.publicKey") };
}

export interface Balances {
  xrge: number;
  tokens: [string, number][];
  lp: [string, number][];
}

function amountMap(value: unknown, what: string): [string, number][] {
  return Object.entries(obj(value, what))
    .map(([k, v]) => [k, nonNegative(v, `${what}.${k}`)] as [string, number])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

export function normalizeBalance(raw: unknown): Balances {
  const r = obj(raw, "balance");
  successFlag(r, "balance");
  return {
    xrge: nonNegative(r.balance, "balance.balance"),
    tokens: amountMap(r.token_balances, "balance.token_balances"),
    lp: amountMap(r.lp_balances, "balance.lp_balances"),
  };
}

// ─── Tokens ──────────────────────────────────────────────────────────────────

export interface TokenInfo {
  symbol: string;
  name: string;
  creator: string;
  image: string | null;
  description: string | null;
  website: string | null;
  twitter: string | null;
  discord: string | null;
  createdAt: number;
  decimals: number;
  frozen: boolean;
  mintable: boolean;
  maxSupply: number | null;
}

export function normalizeToken(raw: unknown, what = "token"): TokenInfo {
  const t = obj(raw, what);
  const decimals = uint(t.decimals, `${what}.decimals`);
  if (decimals > 30) throw new ShapeError(`${what}.decimals`);
  return {
    symbol: text(t.symbol, `${what}.symbol`),
    name: textOrEmpty(t.name, `${what}.name`),
    creator: textOrEmpty(t.creator, `${what}.creator`),
    image: optText(t.image, `${what}.image`),
    description: optText(t.description, `${what}.description`),
    website: optText(t.website, `${what}.website`),
    twitter: optText(t.twitter, `${what}.twitter`),
    discord: optText(t.discord, `${what}.discord`),
    createdAt: uint(t.created_at, `${what}.created_at`),
    decimals,
    frozen: optBool(t.frozen, `${what}.frozen`),
    mintable: optBool(t.mintable, `${what}.mintable`),
    maxSupply: optNum(t.max_supply, `${what}.max_supply`),
  };
}

export function normalizeTokens(raw: unknown): TokenInfo[] {
  const r = obj(raw, "tokens");
  successFlag(r, "tokens");
  return arr(r.tokens, "tokens.tokens").map((t, i) => normalizeToken(t, `tokens[${i}]`));
}

export function normalizeTokenMetadata(raw: unknown): TokenInfo {
  const r = obj(raw, "token metadata");
  if (r.success === false) throw new NotFoundError("Token not found");
  successFlag(r, "token metadata");
  return normalizeToken(r, "token metadata");
}

export interface TokenHolders {
  holders: { address: string; balance: number; percentage: number }[];
  totalSupply: number;
  circulatingSupply: number;
  shieldedSupply: number;
  burnedSupply: number;
}

export function normalizeTokenHolders(raw: unknown): TokenHolders {
  const r = obj(raw, "token holders");
  successFlag(r, "token holders");
  return {
    holders: arr(r.holders, "holders").map((h, i) => {
      const o = obj(h, `holders[${i}]`);
      return {
        address: text(o.address, "holder.address"),
        balance: nonNegative(o.balance, "holder.balance"),
        percentage: nonNegative(o.percentage, "holder.percentage"),
      };
    }),
    totalSupply: nonNegative(r.total_supply, "total_supply"),
    circulatingSupply: nonNegative(r.circulating_supply ?? r.total_supply, "circulating_supply"),
    shieldedSupply: nonNegative(r.shielded_supply ?? 0, "shielded_supply"),
    burnedSupply: nonNegative(r.burned_supply ?? 0, "burned_supply"),
  };
}

export interface TokenActivity {
  /** The node truncates this hash ("bae28795…"), so it can't be linked; link the block instead. */
  hashPrefix: string;
  type: string;
  from: string;
  to: string | null;
  amount: number;
  timestamp: number;
  blockHeight: number;
}

export function normalizeTokenTxs(raw: unknown): { transactions: TokenActivity[]; total: number } {
  const r = obj(raw, "token transactions");
  successFlag(r, "token transactions");
  return {
    transactions: arr(r.transactions, "transactions").map((t, i) => {
      const o = obj(t, `transactions[${i}]`);
      const hash = text(o.tx_hash, "tx_hash");
      return {
        hashPrefix: hash.replace(/\.+$/, ""),
        type: text(o.tx_type, "tx_type"),
        from: textOrEmpty(o.from, "from"),
        to: optText(o.to, "to"),
        amount: num(o.amount, "amount"),
        timestamp: uint(o.timestamp, "timestamp"),
        blockHeight: uint(o.block_height, "block_height"),
      };
    }),
    total: uint(r.total_count, "total_count"),
  };
}

export interface Pool {
  poolId: string;
  tokenA: string;
  tokenB: string;
  reserveA: number;
  reserveB: number;
  totalLpSupply: number;
}

export function normalizePools(raw: unknown): Pool[] {
  const r = obj(raw, "pools");
  successFlag(r, "pools");
  return arr(r.pools, "pools.pools").map((p, i) => {
    const o = obj(p, `pools[${i}]`);
    return {
      poolId: text(o.pool_id, "pool_id"),
      tokenA: text(o.token_a, "token_a"),
      tokenB: text(o.token_b, "token_b"),
      reserveA: nonNegative(o.reserve_a, "reserve_a"),
      reserveB: nonNegative(o.reserve_b, "reserve_b"),
      totalLpSupply: nonNegative(o.total_lp_supply, "total_lp_supply"),
    };
  });
}

export interface PricePoint {
  timestamp: number;
  blockHeight: number;
  priceAInB: number;
  priceBInA: number;
}

export function normalizePoolPrices(raw: unknown): PricePoint[] {
  const r = obj(raw, "pool prices");
  successFlag(r, "pool prices");
  return arr(r.prices, "prices").map((p, i) => {
    const o = obj(p, `prices[${i}]`);
    return {
      timestamp: uint(o.timestamp, "timestamp"),
      blockHeight: uint(o.block_height, "block_height"),
      priceAInB: nonNegative(o.price_a_in_b, "price_a_in_b"),
      priceBInA: nonNegative(o.price_b_in_a, "price_b_in_a"),
    };
  });
}

// ─── NFTs ────────────────────────────────────────────────────────────────────

export interface NftCollection {
  id: string;
  name: string;
  symbol: string;
  creator: string;
  description: string | null;
  image: string | null;
  maxSupply: number | null;
  minted: number;
  frozen: boolean;
  publicMint: boolean;
  royaltyBps: number;
  mintPrice: number | null;
  createdAt: number;
}

export function normalizeCollection(raw: unknown, what = "collection"): NftCollection {
  const c = obj(raw, what);
  if (c.success === false) throw new NotFoundError("Collection not found");
  return {
    id: text(c.collection_id, `${what}.collection_id`),
    name: textOrEmpty(c.name, `${what}.name`),
    symbol: text(c.symbol, `${what}.symbol`),
    creator: textOrEmpty(c.creator, `${what}.creator`),
    description: optText(c.description, `${what}.description`),
    image: optText(c.image, `${what}.image`),
    maxSupply: c.max_supply === null || c.max_supply === undefined ? null : uint(c.max_supply, `${what}.max_supply`),
    minted: uint(c.minted, `${what}.minted`),
    frozen: optBool(c.frozen, `${what}.frozen`),
    publicMint: optBool(c.public_mint, `${what}.public_mint`),
    royaltyBps: c.royalty_bps === null || c.royalty_bps === undefined ? 0 : uint(c.royalty_bps, `${what}.royalty_bps`),
    mintPrice: optNum(c.mint_price, `${what}.mint_price`),
    createdAt: uint(c.created_at, `${what}.created_at`),
  };
}

export function normalizeCollections(raw: unknown): NftCollection[] {
  const r = obj(raw, "collections");
  return arr(r.collections, "collections.collections").map((c, i) => normalizeCollection(c, `collections[${i}]`));
}

export interface NftToken {
  collectionId: string;
  tokenId: number;
  name: string;
  owner: string;
  creator: string;
  /** Image candidate from on-chain attributes; still passed through safeImageUrl before display. */
  image: string | null;
  metadataUri: string | null;
  mintedAt: number | null;
  locked: boolean;
}

export function normalizeNftToken(raw: unknown, what = "nft"): NftToken {
  const t = obj(raw, what);
  const attrs = t.attributes && typeof t.attributes === "object" && !Array.isArray(t.attributes) ? (t.attributes as Obj) : {};
  const image = typeof attrs.image === "string" ? attrs.image : typeof attrs.coverUrl === "string" ? attrs.coverUrl : null;
  return {
    collectionId: text(t.collection_id, `${what}.collection_id`),
    tokenId: uint(t.token_id, `${what}.token_id`),
    name: textOrEmpty(t.name, `${what}.name`),
    owner: textOrEmpty(t.owner, `${what}.owner`),
    creator: textOrEmpty(t.creator ?? "", `${what}.creator`),
    image,
    metadataUri: optText(t.metadata_uri, `${what}.metadata_uri`),
    mintedAt: t.minted_at === undefined || t.minted_at === null ? null : uint(t.minted_at, `${what}.minted_at`),
    locked: optBool(t.locked, `${what}.locked`),
  };
}

export function normalizeCollectionTokens(raw: unknown): { tokens: NftToken[]; total: number } {
  const r = obj(raw, "collection tokens");
  return {
    tokens: arr(r.tokens, "tokens").map((t, i) => normalizeNftToken(t, `tokens[${i}]`)),
    total: uint(r.total, "tokens.total"),
  };
}

export function normalizeOwnerNfts(raw: unknown): NftToken[] {
  const r = obj(raw, "owner nfts");
  return arr(r.nfts, "nfts").map((t, i) => normalizeNftToken(t, `nfts[${i}]`));
}

// ─── Contracts ───────────────────────────────────────────────────────────────

export interface ContractInfo {
  address: string;
  codeHash: string;
  /** Block height of deployment. */
  createdAt: number;
  deployer: string;
  wasmSize: number;
}

export function normalizeContractInfo(raw: unknown, what = "contract"): ContractInfo {
  const c = obj(raw, what);
  return {
    address: hex(c.address, `${what}.address`, 40),
    codeHash: hex(c.code_hash, `${what}.code_hash`, 64),
    createdAt: uint(c.created_at, `${what}.created_at`),
    deployer: textOrEmpty(c.deployer, `${what}.deployer`),
    wasmSize: uint(c.wasm_size, `${what}.wasm_size`),
  };
}

export function normalizeContracts(raw: unknown): ContractInfo[] {
  const r = obj(raw, "contracts");
  return arr(r.contracts, "contracts.contracts").map((c, i) => normalizeContractInfo(c, `contracts[${i}]`));
}

export function normalizeContract(raw: unknown): ContractInfo {
  const r = obj(raw, "contract");
  if (r.success === false) throw new NotFoundError("Contract not found");
  successFlag(r, "contract");
  return normalizeContractInfo(r.contract);
}

export function normalizeContractState(raw: unknown): { entries: [string, string][]; count: number } {
  const r = obj(raw, "contract state");
  if (r.success === false) throw new NotFoundError("Contract state unavailable");
  successFlag(r, "contract state");
  const entries = Object.entries(obj(r.state, "contract state.state")).map(
    ([k, v]) => [k, textOrEmpty(v, `state.${k}`)] as [string, string],
  );
  return { entries: entries.sort((a, b) => a[0].localeCompare(b[0])), count: uint(r.count, "contract state.count") };
}

export interface ContractEvent {
  blockHeight: number;
  topic: string;
  data: string;
  txHash: string | null;
}

export function normalizeContractEvents(raw: unknown): ContractEvent[] {
  const r = obj(raw, "contract events");
  successFlag(r, "contract events");
  return arr(r.events, "events").map((e, i) => {
    const o = obj(e, `events[${i}]`);
    return {
      blockHeight: uint(o.block_height, "event.block_height"),
      topic: textOrEmpty(o.topic, "event.topic"),
      data: typeof o.data === "string" ? o.data : JSON.stringify(o.data ?? null),
      txHash: optHex(o.tx_hash, "event.tx_hash", 64),
    };
  });
}
