/**
 * WASM smart contracts client for the site (player-signed, GAME_READY).
 *
 * - Read-only calls go to `POST /api/contract/:addr/query` (free, nothing signed).
 * - State-changing calls are `contract_call` payloads signed by the connected wallet
 *   (local key, or the RougeChain extension / Qwalla browser) and sent to
 *   `POST /api/v2/contract/execute`. Same envelope as `@rougechain/sdk` 1.9.0
 *   `createSignedContractCall`, including `payload_bytes_hex`.
 *
 * The node-signed `/v2/contract/call` and `/v2/contract/deploy` endpoints are retired.
 */
import { getCoreApiBaseUrl, getCoreApiHeaders } from "@/lib/network";
import { loadUnifiedWallet } from "@/lib/unified-wallet";
import {
  generateNonce,
  serializePayload,
  signTransaction,
  type SignedTransaction,
  type TransactionPayload,
} from "@/lib/pqc-signer";
import { signViaExtension } from "@/lib/extension-bridge";

/** Max gas per call (the node's `DEFAULT_FUEL_LIMIT`). */
export const CONTRACT_MAX_GAS = 10_000_000;
/** XRGE charged per unit of signed gas limit. */
export const CONTRACT_GAS_PRICE_XRGE = 0.000001;

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

/** Free read-only call. `caller` is what the contract sees as `host_get_caller`. */
export async function queryContract(
  addr: string,
  method: string,
  args: unknown = {},
  caller?: string
): Promise<ContractQueryResult> {
  const body: Record<string, unknown> = { method, args };
  if (caller) body.caller = caller;
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
  gasLimit: number
): TransactionPayload {
  if (!Number.isInteger(gasLimit) || gasLimit < 1 || gasLimit > CONTRACT_MAX_GAS) {
    throw new Error(`Gas limit must be an integer between 1 and ${CONTRACT_MAX_GAS.toLocaleString()}`);
  }
  return {
    type: "contract_call",
    from,
    contractAddr: normAddr(addr),
    method,
    args: args === undefined ? {} : args,
    gasLimit,
    timestamp: Date.now(),
    nonce: generateNonce(),
  };
}

async function signWithWallet(payload: Omit<TransactionPayload, "from">): Promise<SignedTransaction> {
  const w = loadUnifiedWallet();
  if (!w?.signingPublicKey) throw new Error("Connect or unlock a wallet to sign this call.");
  const full = { ...payload, from: w.signingPublicKey } as TransactionPayload;
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
 * it first and refuses it (nothing charged) if it would fail.
 */
export async function executeContract(
  addr: string,
  method: string,
  args: unknown,
  gasLimit: number
): Promise<ContractExecuteResult> {
  const w = loadUnifiedWallet();
  if (!w?.signingPublicKey) throw new Error("Connect or unlock a wallet to sign this call.");
  const payload = buildContractCallPayload(w.signingPublicKey, addr, method, args, gasLimit);
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
