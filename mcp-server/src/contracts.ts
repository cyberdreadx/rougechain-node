/**
 * Player-signed contract envelopes for the MCP server.
 *
 * The server pins @rougechain/sdk ^1.3.2, which predates `rc.contracts` (SDK 1.9.0). These
 * builders mirror sdk/src/contracts.ts exactly (same payload fields, same signing via the SDK's
 * `signTransaction`, same `payload_bytes_hex`, same address derivation). Once the server depends
 * on SDK >= 1.9.0, replace them with `createSignedContractCall` / `createSignedContractPublish`.
 */
import { createHash } from "node:crypto";
import { signTransaction, serializePayload, bytesToHex, generateNonce } from "@rougechain/sdk";
import type { WalletKeys } from "@rougechain/sdk";

/** Max gas per call (the node's `DEFAULT_FUEL_LIMIT`). */
export const CONTRACT_MAX_GAS = 10_000_000;
/** XRGE charged per unit of signed gas limit. */
export const CONTRACT_GAS_PRICE_XRGE = 0.000001;
/** Flat XRGE fee for publishing a contract. */
export const CONTRACT_DEPLOY_FEE_XRGE = 10;

const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());

/** Strict base64 decode (whitespace ignored), matching the SDK's `base64ToBytes`. */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, "");
  if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    throw new Error("invalid base64");
  }
  return new Uint8Array(Buffer.from(clean, "base64"));
}

/**
 * `hex(sha256("rougechain/contract/v2" ‖ from ‖ 0x00 ‖ nonce ‖ 0x00 ‖ sha256(wasm))[..20])`
 */
export function predictContractAddress(from: string, nonce: string, wasm: Uint8Array): string {
  const buf = Buffer.concat([
    Buffer.from("rougechain/contract/v2", "utf8"),
    Buffer.from(from, "utf8"),
    Buffer.from([0]),
    Buffer.from(nonce, "utf8"),
    Buffer.from([0]),
    Buffer.from(sha256(wasm)),
  ]);
  return bytesToHex(sha256(new Uint8Array(buf)).slice(0, 20));
}

/** 1.5× the dry run plus headroom, capped at 10M (same rule as the SDK). */
export function suggestGasLimit(gasUsed: number): number {
  return Math.min(Math.ceil(gasUsed * 1.5) + 1000, CONTRACT_MAX_GAS);
}

export function contractCallFee(gasLimit: number): number {
  return gasLimit * CONTRACT_GAS_PRICE_XRGE;
}

// ─── payable calls ──────────────────────────────────────────────────────────

/** Quanta per XRGE (XRGE has 9 decimals). */
export const QUANTA_PER_XRGE = 1_000_000_000n;

/** Exact XRGE decimal string → integer quanta (no float math; at most 9 decimals). */
export function xrgeToQuanta(xrge: string): bigint {
  const t = xrge.trim();
  const m = /^(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) {
    throw new Error(`amount_xrge must be a non-negative decimal XRGE string like "0.5", got "${xrge}"`);
  }
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > 9) throw new Error("amount_xrge has more than 9 decimal places (1 quanta = 0.000000001 XRGE)");
  return BigInt(m[1] || "0") * QUANTA_PER_XRGE + BigInt((frac || "0").padEnd(9, "0"));
}

/** Integer quanta → exact XRGE decimal string. */
export function quantaToXrge(quanta: bigint | number): string {
  const q = BigInt(quanta);
  const frac = (q % QUANTA_PER_XRGE).toString().padStart(9, "0").replace(/0+$/, "");
  return `${q / QUANTA_PER_XRGE}${frac ? `.${frac}` : ""}`;
}

/** The attach the tool accepts: XRGE by `amount_xrge` (decimal), tokens by `amount` (raw integer units). */
export interface AttachInput {
  symbol: string;
  amount_xrge?: string;
  amount?: number | string;
}

/** The attach as signed: upper-cased symbol + positive integer (quanta for XRGE, raw token units). */
export interface ContractAttach {
  symbol: string;
  amount: number;
}

/**
 * Convert the tool input to the signed attach, exactly. XRGE must use `amount_xrge` (decimal
 * XRGE, converted to quanta); a token must use `amount` (integer raw units). The result must be a
 * positive integer ≤ Number.MAX_SAFE_INTEGER (the node reads it as an exact JSON u64).
 */
export function normalizeAttach(a: AttachInput): ContractAttach {
  const symbol = (a.symbol ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{1,32}$/.test(symbol)) {
    throw new Error('attach.symbol must be "XRGE" or a token symbol (1-32 letters, digits, _ or -)');
  }
  let amount: bigint;
  if (symbol === "XRGE") {
    if (a.amount !== undefined) {
      throw new Error('for XRGE use attach.amount_xrge (decimal XRGE, e.g. "0.5"), not attach.amount');
    }
    if (a.amount_xrge === undefined) throw new Error("attach.amount_xrge is required for XRGE");
    amount = xrgeToQuanta(String(a.amount_xrge));
  } else {
    if (a.amount_xrge !== undefined) throw new Error("attach.amount_xrge is only for XRGE; use attach.amount (raw token units)");
    const raw = a.amount;
    if (typeof raw === "number" && Number.isSafeInteger(raw)) amount = BigInt(raw);
    else if (typeof raw === "string" && /^\d+$/.test(raw.trim())) amount = BigInt(raw.trim());
    else throw new Error(`attach.amount must be a positive integer number of raw ${symbol} units`);
  }
  if (amount <= 0n) throw new Error("attach amount must be greater than 0");
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`attach amount ${amount} exceeds ${Number.MAX_SAFE_INTEGER} (the node needs an exact JSON integer)`);
  }
  return { symbol, amount: Number(amount) };
}

/** "0.5 XRGE" / "25 GOLD (raw units)". */
export function describeAttach(a: ContractAttach): string {
  return a.symbol === "XRGE" ? `${quantaToXrge(a.amount)} XRGE` : `${a.amount} ${a.symbol} (raw units)`;
}

/** Exact max XRGE cost: gas fee (1000 quanta per gas) + an XRGE payment. */
export function maxTotalXrge(gasLimit: number, attach?: ContractAttach): string {
  const pay = attach?.symbol === "XRGE" ? BigInt(attach.amount) : 0n;
  return quantaToXrge(BigInt(gasLimit) * 1000n + pay);
}

export function normAddr(addr: string): string {
  return addr.trim().toLowerCase();
}

function signWithBytes(wallet: WalletKeys, payload: Record<string, unknown>) {
  // The SDK's TransactionPayload type is a closed union in 1.3.2; the signer itself is generic.
  const p = payload as unknown as Parameters<typeof signTransaction>[0];
  const tx = signTransaction(p, wallet.privateKey, wallet.publicKey);
  return { ...tx, payload_bytes_hex: bytesToHex(serializePayload(tx.payload)) };
}

/** Signed `contract_deploy` for `POST /api/v2/contract/publish`. `wasmB64` is base64 bytecode. */
export function createSignedContractPublish(wallet: WalletKeys, wasmB64: string, nonce?: string) {
  const wasm = wasmB64.replace(/\s+/g, "");
  const bytes = base64ToBytes(wasm);
  const n = nonce ?? generateNonce();
  if (n.length < 8) throw new Error("contract publish nonce must be at least 8 characters");
  const payload = {
    type: "contract_deploy",
    from: wallet.publicKey,
    wasm,
    timestamp: Date.now(),
    nonce: n,
  };
  return {
    signed: signWithBytes(wallet, payload),
    predictedAddress: predictContractAddress(wallet.publicKey, n, bytes),
    nonce: n,
  };
}

/** Signed `contract_call` for `POST /api/v2/contract/execute`; `attach` is signed inside the payload. */
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
  if (attach) {
    if (!Number.isSafeInteger(attach.amount) || attach.amount <= 0) throw new Error("attach.amount must be a positive safe integer");
    payload.attach = { symbol: attach.symbol, amount: attach.amount };
  }
  return signWithBytes(wallet, payload);
}
