/**
 * WASM smart contracts client for the site (player-signed, GAME_READY).
 *
 * - Read-only calls go to `POST /api/contract/:addr/query` (free, nothing signed).
 * - State-changing calls are `contract_call` payloads signed by the connected wallet
 *   (local key, or the RougeChain extension / Qwalla browser) and sent to
 *   `POST /api/v2/contract/execute`. Same envelope as `@rougechain/sdk` 1.9.0
 *   `createSignedContractCall`, including `payload_bytes_hex`.
 *
 * - Payable calls: an optional signed `attach: {symbol, amount}` (integer quanta for XRGE,
 *   raw units for tokens) pays the contract if the call succeeds (SDK 1.10.0 `attach`).
 *
 * The node-signed `/v2/contract/call` and `/v2/contract/deploy` endpoints are retired.
 */
import { getCoreApiBaseUrl, getCoreApiHeaders } from "./network";
import { loadUnifiedWallet } from "./unified-wallet";
import {
  generateNonce,
  serializePayload,
  signTransaction,
  type SignedTransaction,
  type TransactionPayload,
} from "./pqc-signer";
import { signViaExtension } from "./extension-bridge";
import { verifyNodeChainId } from "./chain-id";

/** Max gas per call (the node's `DEFAULT_FUEL_LIMIT`). */
export const CONTRACT_MAX_GAS = 10_000_000;
/** XRGE charged per unit of signed gas limit. */
export const CONTRACT_GAS_PRICE_XRGE = 0.000001;

/** Quanta per XRGE (XRGE has 9 decimals). */
export const QUANTA_PER_XRGE = 1_000_000_000n;

/**
 * A payment attached to a contract call (payable calls). `amount` is an integer: quanta for XRGE,
 * raw units for tokens. It is signed inside the payload and moves to the contract only if the
 * call succeeds.
 */
export interface ContractAttach {
  symbol: string;
  amount: number;
}

/**
 * Exact XRGE → quanta for a decimal string typed by the user (no float math; ≤ 9 decimals).
 * Throws on anything else.
 */
export function xrgeToQuanta(xrge: string): bigint {
  const t = xrge.trim();
  const m = /^(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) throw new Error(`"${xrge}" is not an XRGE amount`);
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > 9) throw new Error("XRGE has at most 9 decimal places");
  return BigInt(m[1] || "0") * QUANTA_PER_XRGE + BigInt((frac || "0").padEnd(9, "0"));
}

/** Exact XRGE decimal string for integer quanta (no trailing zeros). */
export function quantaToXrge(quanta: bigint | number): string {
  const q = BigInt(quanta);
  const whole = q / QUANTA_PER_XRGE;
  const frac = (q % QUANTA_PER_XRGE).toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""}`;
}

/**
 * Turn the form's symbol + amount into a signed attachment. XRGE is entered in XRGE and converted
 * exactly to quanta; a token amount is entered in raw integer units.
 */
export function parseAttachInput(symbolText: string, amountText: string): ContractAttach {
  const symbol = symbolText.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{1,32}$/.test(symbol)) throw new Error("Payment symbol must be XRGE or a token symbol");
  let amount: bigint;
  if (symbol === "XRGE") {
    amount = xrgeToQuanta(amountText);
  } else {
    const t = amountText.trim();
    if (!/^\d+$/.test(t)) throw new Error(`${symbol} amount must be a whole number of raw token units`);
    amount = BigInt(t);
  }
  if (amount <= 0n) throw new Error("Payment amount must be greater than 0");
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Payment amount is too large");
  return { symbol, amount: Number(amount) };
}

/** "0.5 XRGE" / "25 GOLD (raw units)" for an attachment. */
export function formatAttach(a: ContractAttach): string {
  return a.symbol === "XRGE" ? `${quantaToXrge(a.amount)} XRGE` : `${a.amount.toLocaleString()} ${a.symbol}`;
}

/** Exact max XRGE cost of a call: gas fee (gasLimit × 1000 quanta) + an XRGE payment. */
export function maxTotalXrge(gasLimit: number, attach?: ContractAttach | null): string {
  const pay = attach && attach.symbol === "XRGE" ? BigInt(attach.amount) : 0n;
  return quantaToXrge(BigInt(gasLimit) * 1000n + pay);
}

export interface ContractEvent {
  contract_addr: string;
  topic: string;
  data: string;
  block_height: number;
  tx_hash: string;
}

export interface ContractQueryResult {
  success: boolean;
  returnData?: unknown;
  gasUsed: number;
  events: ContractEvent[];
  error?: string | null;
}

export interface ContractExecuteResult {
  success: boolean;
  error?: string;
  txId?: string;
  fee?: number;
  preview?: { returnData?: unknown; gasUsed?: number; events?: ContractEvent[] };
}

export type ReceiptStatus = "Success" | { Failed: string };

export interface TxReceipt {
  tx_hash: string;
  block_height: number;
  status: ReceiptStatus;
  fee_paid?: number;
  [k: string]: unknown;
}

/** Gas limit to sign for a call that used `gasUsed` in a dry run (same rule as the SDK). */
export function suggestGasLimit(gasUsed: number): number {
  return Math.min(Math.ceil(gasUsed * 1.5) + 1000, CONTRACT_MAX_GAS);
}

/** Max fee in XRGE for a signed gas limit. */
export function contractCallFee(gasLimit: number): number {
  return gasLimit * CONTRACT_GAS_PRICE_XRGE;
}

export function normAddr(addr: string): string {
  return addr.trim().toLowerCase();
}

/** "Success", or the revert reason when the call failed in its block. */
export function receiptError(status: ReceiptStatus | undefined): string | null {
  if (!status || status === "Success") return null;
  return typeof status === "object" && "Failed" in status ? status.Failed : String(status);
}

function apiBase(): string {
  const base = getCoreApiBaseUrl();
  if (!base) throw new Error("Node not configured.");
  return base;
}

async function readJson(res: Response, what: string): Promise<Record<string, unknown>> {
  const text = await res.text().catch(() => "");
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    if (!res.ok && d.success === undefined) d.success = false;
    if (!res.ok && !d.error) d.error = `${what} failed (${res.status})`;
    return d;
  }
  return { success: false, error: `${what} failed (${res.status})` };
}

async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: "POST",
    headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson(res, `POST ${path}`);
}

/** The connected wallet that would sign, or null if none is connected / it's locked. */
export function currentContractSigner(): { publicKey: string; viaExtension: boolean } | null {
  const w = loadUnifiedWallet();
  if (!w?.signingPublicKey) return null;
  return { publicKey: w.signingPublicKey, viaExtension: !w.signingPrivateKey };
}

/**
 * Free read-only call. `caller` is what the contract sees as `host_get_caller`. With `attach`
 * (needs a caller) it previews a paid call: the contract sees the payment.
 */
export async function queryContract(
  addr: string,
  method: string,
  args: unknown = {},
  caller?: string,
  attach?: ContractAttach | null
): Promise<ContractQueryResult> {
  const body: Record<string, unknown> = { method, args };
  if (caller) body.caller = caller;
  if (attach) {
    if (!caller) throw new Error("Previewing a payment needs a caller");
    body.attach = attach;
  }
  const r = await postJson(`/contract/${encodeURIComponent(normAddr(addr))}/query`, body);
  return {
    success: r.success === true,
    returnData: r.returnData,
    gasUsed: Number(r.gasUsed ?? 0),
    events: (r.events as ContractEvent[]) ?? [],
    error: (r.error as string | null | undefined) ?? null,
  };
}

/** Build the unsigned `contract_call` payload (exported for tests). */
export function buildContractCallPayload(
  from: string,
  addr: string,
  method: string,
  args: unknown,
  gasLimit: number,
  attach?: ContractAttach | null
): TransactionPayload {
  if (!Number.isInteger(gasLimit) || gasLimit < 1 || gasLimit > CONTRACT_MAX_GAS) {
    throw new Error(`Gas limit must be an integer between 1 and ${CONTRACT_MAX_GAS.toLocaleString()}`);
  }
  if (attach && (!Number.isSafeInteger(attach.amount) || attach.amount <= 0)) {
    throw new Error("Payment amount must be a positive integer (quanta for XRGE, raw units for tokens)");
  }
  const payload: TransactionPayload = {
    type: "contract_call",
    from,
    contractAddr: normAddr(addr),
    method,
    args: args === undefined ? {} : args,
    gasLimit,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };
  if (attach) payload.attach = { symbol: attach.symbol, amount: attach.amount };
  return payload;
}

async function signWithWallet(payload: Omit<TransactionPayload, "from">): Promise<SignedTransaction> {
  const w = loadUnifiedWallet();
  if (!w?.signingPublicKey) throw new Error("Connect or unlock a wallet to sign this call.");
  const full = { ...payload, from: w.signingPublicKey } as TransactionPayload;
  await verifyNodeChainId(); // once per session: the node must be on the selected network
  if (w.signingPrivateKey) {
    const tx = signTransaction(full, w.signingPrivateKey, w.signingPublicKey);
    const bytes = serializePayload(tx.payload);
    return {
      ...tx,
      payload_bytes_hex: Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""),
    };
  }
  return signViaExtension(full, w.signingPublicKey);
}

/**
 * Sign a state-changing call with the connected wallet and submit it. The node dry-runs
 * it first and refuses it (nothing charged) if it would fail. `attach` pays the contract;
 * the payment moves only if the call succeeds in its block.
 */
export async function executeContract(
  addr: string,
  method: string,
  args: unknown,
  gasLimit: number,
  attach?: ContractAttach | null
): Promise<ContractExecuteResult> {
  const w = loadUnifiedWallet();
  if (!w?.signingPublicKey) throw new Error("Connect or unlock a wallet to sign this call.");
  const payload = buildContractCallPayload(w.signingPublicKey, addr, method, args, gasLimit, attach);
  const signed = await signWithWallet(payload);
  const r = await postJson("/v2/contract/execute", signed);
  return {
    success: r.success === true,
    error: r.error as string | undefined,
    txId: r.txId as string | undefined,
    fee: r.fee as number | undefined,
    preview: r.preview as ContractExecuteResult["preview"],
  };
}

/** The receipt once the tx is in a block, or null while it is pending. */
export async function getTxReceipt(txId: string): Promise<TxReceipt | null> {
  const res = await fetch(`${apiBase()}/tx/${encodeURIComponent(txId)}/receipt`, {
    headers: getCoreApiHeaders(),
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Receipt lookup failed (${res.status})`);
  const d = (await res.json()) as { receipt?: TxReceipt };
  return d.receipt ?? null;
}

/** Poll until the tx is included (receipt) or `timeoutMs` passes (null). */
export async function waitForTxReceipt(
  txId: string,
  opts: { timeoutMs?: number; intervalMs?: number; signal?: { cancelled: boolean } } = {}
): Promise<TxReceipt | null> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (opts.signal?.cancelled) return null;
    try {
      const r = await getTxReceipt(txId);
      if (r) return r;
    } catch {
      /* transient; keep polling */
    }
    if (Date.now() + intervalMs > deadline) return null;
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}

/** Stored events, newest first. */
export async function fetchContractEvents(
  addr: string,
  q: { limit?: number; before?: number; tx?: string } = {}
): Promise<ContractEvent[]> {
  const params = new URLSearchParams();
  if (q.limit !== undefined) params.set("limit", String(q.limit));
  if (q.before !== undefined) params.set("before", String(q.before));
  if (q.tx) params.set("tx", q.tx);
  const qs = params.toString();
  const res = await fetch(`${apiBase()}/contract/${encodeURIComponent(normAddr(addr))}/events${qs ? `?${qs}` : ""}`, {
    headers: getCoreApiHeaders(),
    signal: AbortSignal.timeout(8000),
  });
  const d = await readJson(res, "GET events");
  if (d.success !== true) throw new Error(String(d.error || "events read failed"));
  return (d.events as ContractEvent[]) ?? [];
}
