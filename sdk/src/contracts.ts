import { sha256 } from "@noble/hashes/sha2.js";
import { signTransaction, serializePayload } from "./signer.js";
import { bytesToHex, generateNonce } from "./utils.js";
import type { RougeChain } from "./client.js";
import type {
  WalletKeys,
  TransactionPayload,
  ContractMetadata,
  ContractEvent,
  ContractEventFrame,
  ContractQueryResult,
  ContractStateValue,
  ContractEventsQuery,
  PublishContractOptions,
  PublishContractResult,
  ExecuteContractOptions,
  ExecuteContractResult,
  ContractAttach,
  NormalizedContractAttach,
  QueryContractOptions,
  TxReceipt,
} from "./types.js";

/** Max gas per call (the node's `DEFAULT_FUEL_LIMIT`). */
export const CONTRACT_MAX_GAS = 10_000_000;
/** XRGE charged per unit of signed gas limit. */
export const CONTRACT_GAS_PRICE_XRGE = 0.000001;
/** Flat XRGE fee for publishing a contract. */
export const CONTRACT_DEPLOY_FEE_XRGE = 10;

const ADDRESS_DOMAIN = new TextEncoder().encode("rougechain/contract/v2");

// ─── base64 (browser + Node, no Buffer dependency) ─────────────────────────

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard (padded) base64 of `bytes`. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + "==";
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + "=";
  }
  return out;
}

/** Decode standard base64 (whitespace ignored). Throws on invalid input. */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, "");
  if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    throw new Error("invalid base64");
  }
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((clean.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (B64.indexOf(clean[i]) << 18) |
      (B64.indexOf(clean[i + 1]) << 12) |
      ((clean[i + 2] === "=" ? 0 : B64.indexOf(clean[i + 2])) << 6) |
      (clean[i + 3] === "=" ? 0 : B64.indexOf(clean[i + 3]));
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

function wasmBytes(wasm: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof wasm === "string") return base64ToBytes(wasm);
  return wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm);
}

/**
 * The address a signed deployment will get:
 * `hex(sha256("rougechain/contract/v2" ‖ from ‖ 0x00 ‖ nonce ‖ 0x00 ‖ sha256(wasm))[..20])`.
 * Every input is inside the deployer's signature, so nobody else can claim the address.
 *
 * @param from  deployer's signing public key (hex, exactly as signed)
 * @param nonce the signed payload nonce
 * @param wasm  bytecode (bytes or base64)
 */
export function predictContractAddress(
  from: string,
  nonce: string,
  wasm: Uint8Array | ArrayBuffer | string
): string {
  const enc = new TextEncoder();
  const fromB = enc.encode(from);
  const nonceB = enc.encode(nonce);
  const codeHash = sha256(wasmBytes(wasm));
  const buf = new Uint8Array(ADDRESS_DOMAIN.length + fromB.length + 1 + nonceB.length + 1 + codeHash.length);
  let o = 0;
  buf.set(ADDRESS_DOMAIN, o); o += ADDRESS_DOMAIN.length;
  buf.set(fromB, o); o += fromB.length;
  buf[o++] = 0;
  buf.set(nonceB, o); o += nonceB.length;
  buf[o++] = 0;
  buf.set(codeHash, o);
  return bytesToHex(sha256(buf).slice(0, 20));
}

/** Gas limit the SDK signs when none is given: 1.5× the dry run plus headroom, capped at 10M. */
export function suggestGasLimit(gasUsed: number): number {
  return Math.min(Math.ceil(gasUsed * 1.5) + 1000, CONTRACT_MAX_GAS);
}

/** Max fee in XRGE for a gas limit. */
export function contractCallFee(gasLimit: number): number {
  return gasLimit * CONTRACT_GAS_PRICE_XRGE;
}

// ─── payable calls: exact XRGE ⇄ quanta, attach validation ────────────────

/** Quanta per XRGE (XRGE has 9 decimals). */
export const QUANTA_PER_XRGE = 1_000_000_000n;
const XRGE_DECIMALS = 9;

/**
 * Convert an XRGE amount to integer quanta exactly (decimal string arithmetic, no float math).
 * Accepts `"1.5"`, `"0.000000001"`, `2`, `0.1`, `"1e-3"`. At most 9 decimal places; negative,
 * non-finite and malformed input throws.
 *
 * @example xrgeToQuanta("0.5") === 500_000_000n
 */
export function xrgeToQuanta(xrge: number | string): bigint {
  let str: string;
  if (typeof xrge === "number") {
    if (!Number.isFinite(xrge)) throw new Error(`invalid XRGE amount: ${xrge}`);
    str = String(xrge); // shortest round-trip form — the decimal the caller wrote
  } else if (typeof xrge === "string") {
    str = xrge.trim().replace(/_/g, "");
  } else {
    throw new Error("XRGE amount must be a number or a decimal string");
  }
  const m = /^(\+)?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(str);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) {
    throw new Error(`invalid XRGE amount: "${str}"${str.startsWith("-") ? " (must not be negative)" : ""}`);
  }
  let digits = m[2] + (m[3] ?? "");
  let scale = (m[3] ?? "").length - (m[4] ? parseInt(m[4], 10) : 0); // value = digits × 10^-scale
  // strip trailing zeros that only add precision
  while (scale > 0 && digits.length > 0 && digits.endsWith("0")) { digits = digits.slice(0, -1); scale--; }
  if (scale > XRGE_DECIMALS) throw new Error(`XRGE amount "${str}" has more than ${XRGE_DECIMALS} decimal places`);
  if (scale < -1000) throw new Error(`XRGE amount "${str}" is too large`);
  const n = BigInt(digits === "" ? "0" : digits);
  return n * 10n ** BigInt(XRGE_DECIMALS - scale);
}

/**
 * Format integer quanta as an exact XRGE decimal string (no trailing zeros), e.g.
 * `quantaToXrge(1_500_000_000n) === "1.5"`.
 */
export function quantaToXrge(quanta: bigint | number | string): string {
  const q = toBigIntStrict(quanta, "quanta");
  const neg = q < 0n;
  const a = neg ? -q : q;
  const whole = a / QUANTA_PER_XRGE;
  const frac = (a % QUANTA_PER_XRGE).toString().padStart(XRGE_DECIMALS, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

function toBigIntStrict(v: bigint | number | string, what: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error(`${what} must be an integer, got ${v}`);
    if (!Number.isSafeInteger(v)) throw new Error(`${what} ${v} is not a safe integer; pass a bigint or string`);
    return BigInt(v);
  }
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  throw new Error(`${what} must be an integer, got ${JSON.stringify(v)}`);
}

const MAX_ATTACH = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Validate an attachment and normalize it to what is signed: an upper-cased symbol and a
 * positive integer amount that fits a JSON number exactly (≤ `Number.MAX_SAFE_INTEGER`).
 * Throws a descriptive error otherwise.
 */
export function normalizeContractAttach(attach: ContractAttach): NormalizedContractAttach {
  if (!attach || typeof attach !== "object") throw new Error("attach must be { symbol, amount }");
  const symbol = typeof attach.symbol === "string" ? attach.symbol.trim().toUpperCase() : "";
  if (!/^[A-Z0-9_-]{1,32}$/.test(symbol)) {
    throw new Error("attach.symbol must be \"XRGE\" or a token symbol (1-32 letters, digits, _ or -)");
  }
  const raw = attach.amount;
  let amount: bigint;
  if (typeof raw === "bigint") {
    amount = raw;
  } else if (typeof raw === "number") {
    if (!Number.isInteger(raw)) {
      throw new Error(`attach.amount must be an integer (${symbol === "XRGE" ? "quanta — use xrgeToQuanta()" : "raw token units"}), got ${raw}`);
    }
    if (!Number.isSafeInteger(raw)) throw new Error(`attach.amount ${raw} exceeds Number.MAX_SAFE_INTEGER`);
    amount = BigInt(raw);
  } else if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    amount = BigInt(raw.trim());
  } else {
    throw new Error(`attach.amount must be a positive integer (${symbol === "XRGE" ? "quanta — use xrgeToQuanta()" : "raw token units"}), got ${JSON.stringify(raw)}`);
  }
  if (amount <= 0n) throw new Error("attach.amount must be greater than 0");
  if (amount > MAX_ATTACH) {
    throw new Error(`attach.amount ${amount} exceeds Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}); the node needs it as an exact JSON integer`);
  }
  return { symbol, amount: Number(amount) };
}

function normAddr(addr: string): string {
  return addr.trim().toLowerCase();
}

/** Sign a payload and attach the exact signed bytes so the node verifies those bytes. */
function signWithBytes(wallet: WalletKeys, payload: Record<string, unknown>) {
  const tx = signTransaction(payload as unknown as TransactionPayload, wallet.privateKey, wallet.publicKey);
  return { ...tx, payload_bytes_hex: bytesToHex(serializePayload(tx.payload)) };
}

/**
 * Build a signed `contract_deploy` request (`POST /api/v2/contract/publish`).
 * Exposed for apps that submit on their own.
 */
export function createSignedContractPublish(
  wallet: WalletKeys,
  wasm: Uint8Array | ArrayBuffer | string,
  opts: PublishContractOptions = {}
) {
  const bytes = wasmBytes(wasm);
  const nonce = opts.nonce ?? generateNonce();
  if (nonce.length < 8) throw new Error("contract publish nonce must be at least 8 characters");
  const payload = {
    type: "contract_deploy",
    from: wallet.publicKey,
    wasm: typeof wasm === "string" ? wasm.replace(/\s+/g, "") : bytesToBase64(bytes),
    timestamp: Date.now(),
    nonce,
  };
  return {
    signed: signWithBytes(wallet, payload),
    predictedAddress: predictContractAddress(wallet.publicKey, nonce, bytes),
    nonce,
  };
}

/**
 * Build a signed `contract_call` request (`POST /api/v2/contract/execute`).
 * `args` defaults to `{}` (what the block executor uses when none are signed).
 * `attach` (payable calls) is validated with {@link normalizeContractAttach} and signed as
 * `{"symbol": "XRGE", "amount": <integer>}`; this throws on an invalid attachment.
 */
export function createSignedContractCall(
  wallet: WalletKeys,
  contractAddr: string,
  method: string,
  args: unknown,
  gasLimit: number,
  accountNonce?: number,
  attach?: ContractAttach
) {
  if (!Number.isInteger(gasLimit) || gasLimit < 1 || gasLimit > CONTRACT_MAX_GAS) {
    throw new Error(`gasLimit must be an integer between 1 and ${CONTRACT_MAX_GAS}`);
  }
  const att = attach === undefined ? undefined : normalizeContractAttach(attach);
  const payload: Record<string, unknown> = {
    type: "contract_call",
    from: wallet.publicKey,
    contractAddr: normAddr(contractAddr),
    method,
    args: args === undefined ? {} : args,
    gasLimit,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };
  if (accountNonce !== undefined) payload.account_nonce = accountNonce;
  if (att) payload.attach = att;
  return signWithBytes(wallet, payload);
}

type EventCallback = (event: ContractEvent) => void;

interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

/**
 * One shared WebSocket for all contract subscriptions of a client. Reconnects with backoff and
 * re-sends every active `contract:<addr>` subscription on reconnect; closes when the last
 * listener unsubscribes.
 */
class ContractEventStream {
  private ws: WsLike | null = null;
  private listeners = new Map<string, Set<EventCallback>>();
  private statusListeners = new Set<(live: boolean) => void>();
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly rc: RougeChain) {}

  add(addr: string, cb: EventCallback, onStatus?: (live: boolean) => void): () => void {
    const key = normAddr(addr);
    let set = this.listeners.get(key);
    const isNew = !set;
    if (!set) { set = new Set(); this.listeners.set(key, set); }
    set.add(cb);
    if (onStatus) this.statusListeners.add(onStatus);
    if (!this.ws && !this.timer) this.open();
    else if (isNew && this.ws?.readyState === 1) this.ws.send(JSON.stringify({ subscribe: [`contract:${key}`] }));
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (onStatus) this.statusListeners.delete(onStatus);
      const s = this.listeners.get(key);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) {
        this.listeners.delete(key);
        if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ unsubscribe: [`contract:${key}`] }));
      }
      if (this.listeners.size === 0) this.shutdown();
    };
  }

  private open() {
    this.timer = null;
    if (this.listeners.size === 0) return;
    const Ctor = this.rc.wsCtor;
    if (!Ctor) throw new Error("No WebSocket implementation: pass { WebSocket } in RougeChainOptions");
    const ws = new Ctor(this.rc.baseUrl.replace(/^http/, "ws") + "/ws") as unknown as WsLike;
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      const topics = [...this.listeners.keys()].map((a) => `contract:${a}`);
      if (topics.length) ws.send(JSON.stringify({ subscribe: topics }));
      this.statusListeners.forEach((f) => f(true));
    };
    ws.onmessage = (e) => {
      let d: Partial<ContractEventFrame>;
      try { d = JSON.parse(String(e.data)); } catch { return; }
      if (d.type !== "contract_event" || typeof d.contract_addr !== "string") return;
      const set = this.listeners.get(normAddr(d.contract_addr));
      if (!set) return;
      const ev: ContractEvent = {
        contract_addr: d.contract_addr,
        topic: String(d.topic ?? ""),
        data: String(d.data ?? ""),
        block_height: Number(d.block_height ?? 0),
        tx_hash: String(d.tx_hash ?? ""),
      };
      set.forEach((cb) => { try { cb(ev); } catch { /* listener errors are the app's */ } });
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.statusListeners.forEach((f) => f(false));
      if (this.listeners.size === 0) return;
      this.timer = setTimeout(() => this.open(), Math.min(1000 * 2 ** this.attempt++, 30000));
    };
  }

  private shutdown() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const ws = this.ws;
    this.ws = null;
    this.attempt = 0;
    ws?.close();
  }
}

/** A game-dev-friendly handle on one contract. See {@link ContractsClient.game}. */
export interface GameContract {
  readonly address: string;
  /** Signed, fee-paying call (requires the wallet given to `game()`). Pay with `{ attach }`. */
  call(method: string, args?: unknown, opts?: ExecuteContractOptions): Promise<ExecuteContractResult>;
  /** Free read-only call. The caller is the game wallet's key when one was given. */
  query(method: string, args?: unknown, opts?: QueryContractOptions): Promise<ContractQueryResult>;
  /** Whole storage (no key) or one key. */
  state(): Promise<Record<string, string>>;
  state(key: string | Uint8Array): Promise<ContractStateValue>;
  /** Live events for one topic, or `'*'` for all. Returns an unsubscribe function. */
  on(topic: string, cb: (event: ContractEvent) => void): () => void;
}

/** WASM smart contracts: signed publish/execute, free queries, state, events. */
export class ContractsClient {
  private stream: ContractEventStream;

  constructor(private readonly rc: RougeChain) {
    this.stream = new ContractEventStream(rc);
  }

  /** @see predictContractAddress */
  predictContractAddress(from: string, nonce: string, wasm: Uint8Array | ArrayBuffer | string): string {
    return predictContractAddress(from, nonce, wasm);
  }

  /**
   * Publish (deploy) WASM bytecode signed by `wallet`. Costs 10 XRGE. The contract is installed
   * when the tx is mined; its address is known now (`predictedAddress`).
   */
  async publish(
    wallet: WalletKeys,
    wasm: Uint8Array | ArrayBuffer | string,
    opts: PublishContractOptions = {}
  ): Promise<PublishContractResult> {
    const { signed, predictedAddress, nonce } = createSignedContractPublish(wallet, wasm, opts);
    const r = await this.send("/v2/contract/publish", signed);
    return {
      success: r.success === true,
      error: r.error as string | undefined,
      txId: r.txId as string | undefined,
      address: r.address as string | undefined,
      fee: r.fee as number | undefined,
      predictedAddress,
      nonce,
    };
  }

  /**
   * Call a contract method as `wallet` (the contract sees it via `host_get_caller`). The node
   * dry-runs the call and refuses it if it would fail, so a failing call costs nothing.
   * Without `opts.gasLimit`, the SDK queries first and signs `ceil(gasUsed × 1.5) + 1000`.
   *
   * `opts.attach` pays the contract (payable calls): `{ symbol: "XRGE", amount: xrgeToQuanta("0.5") }`
   * or `{ symbol: "TOKEN", amount: <raw units> }`. The payment moves only if the call succeeds; a
   * failing call keeps it with the caller (the gas fee is still charged). The node refuses the call
   * up front if `wallet` can't cover the gas fee plus an XRGE payment (or the token amount).
   */
  async execute(
    wallet: WalletKeys,
    contractAddr: string,
    method: string,
    args: unknown = {},
    opts: ExecuteContractOptions = {}
  ): Promise<ExecuteContractResult> {
    let attach: NormalizedContractAttach | undefined;
    try {
      attach = opts.attach === undefined ? undefined : normalizeContractAttach(opts.attach);
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
    let gasLimit = opts.gasLimit;
    if (gasLimit === undefined) {
      const q = await this.query(contractAddr, method, args, wallet.publicKey, { attach });
      if (!q.success) {
        return {
          success: false,
          error: q.error || "call would fail",
          preview: { returnData: q.returnData, gasUsed: q.gasUsed, events: q.events },
        };
      }
      gasLimit = suggestGasLimit(q.gasUsed);
    }
    let signed;
    try {
      signed = createSignedContractCall(wallet, contractAddr, method, args, gasLimit, opts.accountNonce, attach);
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e), gasLimit, attach };
    }
    const r = await this.send("/v2/contract/execute", signed);
    return {
      success: r.success === true,
      error: r.error as string | undefined,
      txId: r.txId as string | undefined,
      fee: r.fee as number | undefined,
      gasLimit,
      attach,
      preview: r.preview as ExecuteContractResult["preview"],
    };
  }

  /**
   * Read-only call: no signature, no fee, nothing is committed. With `opts.attach` (and a
   * `caller`) it previews a paid call: the contract sees the payment as it would in a block.
   */
  async query(
    contractAddr: string,
    method: string,
    args: unknown = {},
    caller?: string,
    opts: QueryContractOptions = {}
  ): Promise<ContractQueryResult> {
    const body: Record<string, unknown> = { method, args };
    if (caller) body.caller = caller;
    if (opts.attach !== undefined) {
      try {
        if (!caller) throw new Error("previewing an attached payment needs the caller");
        body.attach = normalizeContractAttach(opts.attach);
      } catch (e) {
        return { success: false, gasUsed: 0, events: [], error: e instanceof Error ? e.message : String(e) };
      }
    }
    const r = await this.send(`/contract/${encodeURIComponent(normAddr(contractAddr))}/query`, body);
    return {
      success: r.success === true,
      returnData: r.returnData,
      gasUsed: Number(r.gasUsed ?? 0),
      events: (r.events as ContractEvent[]) ?? [],
      error: r.error as string | undefined,
    };
  }

  /** Contract metadata, or null if no contract lives at `addr`. */
  async get(contractAddr: string): Promise<ContractMetadata | null> {
    const r = await this.rc.get<{ success: boolean; contract?: ContractMetadata }>(
      `/contract/${encodeURIComponent(normAddr(contractAddr))}`
    );
    return r.success && r.contract ? r.contract : null;
  }

  /**
   * Contract storage. With no key: every entry (keys and values as UTF-8 when valid, else hex).
   * With a key: that entry. A string key is sent as-is and the node reads it as hex when it
   * parses as hex, else as UTF-8; pass a `Uint8Array` to be unambiguous.
   */
  state(contractAddr: string): Promise<Record<string, string>>;
  state(contractAddr: string, key: string | Uint8Array): Promise<ContractStateValue>;
  async state(contractAddr: string, key?: string | Uint8Array): Promise<Record<string, string> | ContractStateValue> {
    const base = `/contract/${encodeURIComponent(normAddr(contractAddr))}/state`;
    if (key === undefined) {
      const r = await this.rc.get<{ success: boolean; state?: Record<string, string>; error?: string }>(base);
      if (!r.success) throw new Error(r.error || "state read failed");
      return r.state ?? {};
    }
    const k = typeof key === "string" ? key : bytesToHex(key);
    const r = await this.rc.get<{ success: boolean; error?: string } & ContractStateValue>(
      `${base}?key=${encodeURIComponent(k)}`
    );
    if (!r.success) throw new Error(r.error || "state read failed");
    return { key: r.key, value: r.value ?? null, valueUtf8: r.valueUtf8 };
  }

  /** Stored events, newest first as the node returns them. Page with `before` (block height). */
  async events(contractAddr: string, q: ContractEventsQuery = {}): Promise<ContractEvent[]> {
    const params = new URLSearchParams();
    if (q.limit !== undefined) params.set("limit", String(q.limit));
    if (q.before !== undefined) params.set("before", String(q.before));
    if (q.tx !== undefined) params.set("tx", q.tx);
    const qs = params.toString();
    const r = await this.rc.get<{ success: boolean; events?: ContractEvent[]; error?: string }>(
      `/contract/${encodeURIComponent(normAddr(contractAddr))}/events${qs ? `?${qs}` : ""}`
    );
    if (!r.success) throw new Error(r.error || "events read failed");
    return r.events ?? [];
  }

  /** Every deployed contract. */
  async list(): Promise<ContractMetadata[]> {
    const r = await this.rc.get<{ success: boolean; contracts?: ContractMetadata[] }>("/contracts");
    return r.contracts ?? [];
  }

  /**
   * Live events from `contractAddr`, delivered after their block is accepted. All subscriptions
   * of this client share one WebSocket that reconnects and resubscribes on its own.
   * Returns a function that stops this subscription.
   */
  subscribe(
    contractAddr: string,
    onEvent: (event: ContractEvent) => void,
    opts: { onStatus?: (live: boolean) => void } = {}
  ): () => void {
    return this.stream.add(contractAddr, onEvent, opts.onStatus);
  }

  /**
   * Wait until `txId` is in a block and return its receipt. A `contract_call` whose contract
   * reverted in the block is still included (the fee is charged) and its receipt reports
   * `status: { Failed: "<error>" }`; a call that ran to completion reports `"Success"`.
   */
  async waitForReceipt(
    txId: string,
    opts: { timeoutMs?: number; intervalMs?: number } = {}
  ): Promise<TxReceipt> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const intervalMs = opts.intervalMs ?? 1_500;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await this.rc.fetchFn(`${this.rc.baseUrl}/tx/${encodeURIComponent(txId)}/receipt`, {
        headers: this.rc.headers,
      });
      if (res.ok) {
        const d = (await res.json()) as { success?: boolean; receipt?: TxReceipt };
        if (d.receipt) return d.receipt;
      } else if (res.status !== 404) {
        throw new Error(`GET /tx/${txId}/receipt failed: ${res.status}`);
      }
      if (Date.now() + intervalMs > deadline) {
        throw new Error(`transaction ${txId} was not included within ${timeoutMs} ms`);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /**
   * A small handle for game code: `call` (signed), `query` (free), `state`, and `on(topic)`.
   *
   * @example
   * const g = rc.contracts.game(addr, wallet);
   * const off = g.on("move", (e) => render(JSON.parse(e.data)));
   * await g.call("move", { x: 1, y: 2 });
   * await g.call("roll", {}, { attach: { symbol: "XRGE", amount: xrgeToQuanta("0.5") } }); // paid
   */
  game(contractAddr: string, wallet?: WalletKeys): GameContract {
    const address = normAddr(contractAddr);
    const self = this;
    return {
      address,
      call(method, args = {}, opts) {
        if (!wallet) return Promise.reject(new Error("game(): pass a wallet to make signed calls"));
        return self.execute(wallet, address, method, args, opts);
      },
      query(method, args = {}, opts) {
        return self.query(address, method, args, wallet?.publicKey, opts);
      },
      state(key?: string | Uint8Array) {
        return key === undefined ? self.state(address) : self.state(address, key);
      },
      on(topic, cb) {
        return self.subscribe(address, (e) => {
          if (topic === "*" || e.topic === topic) cb(e);
        });
      },
    } as GameContract;
  }

  /** POST that returns the node's JSON body on 4xx too (the node explains refusals there). */
  private async send(path: string, body: unknown): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.rc.fetchFn(`${this.rc.baseUrl}${path}`, {
        method: "POST",
        headers: this.rc.headers,
        body: JSON.stringify(body),
      });
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
    const text = await res.text().catch(() => "");
    let data: Record<string, unknown> | null = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (data && typeof data === "object") {
      if (!res.ok && data.success === undefined) data.success = false;
      if (!res.ok && !data.error) data.error = `POST ${path} failed: ${res.status}`;
      return data;
    }
    return {
      success: false,
      error: `POST ${path} failed: ${res.status} ${res.statusText} ${text}`.trim(),
    };
  }
}
