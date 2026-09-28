/**
 * Contract helpers for the MCP tools. Signing, address prediction, fees and quanta conversion come
 * from @rougechain/sdk (1.10+), so the MCP server signs exactly what the SDK signs. What stays here
 * is MCP-specific: the tool-input shape for payments (`amount_xrge` for XRGE, `amount` for tokens)
 * and a few formatting helpers.
 */
import {
  CONTRACT_DEPLOY_FEE_XRGE,
  CONTRACT_GAS_PRICE_XRGE,
  CONTRACT_MAX_GAS,
  QUANTA_PER_XRGE,
  base64ToBytes,
  contractCallFee,
  createSignedContractCall,
  createSignedContractPublish as sdkCreateSignedContractPublish,
  normalizeContractAttach,
  predictContractAddress,
  quantaToXrge,
  suggestGasLimit,
  xrgeToQuanta,
} from "@rougechain/sdk";
import type { NormalizedContractAttach, WalletKeys } from "@rougechain/sdk";

export {
  CONTRACT_DEPLOY_FEE_XRGE,
  CONTRACT_GAS_PRICE_XRGE,
  CONTRACT_MAX_GAS,
  QUANTA_PER_XRGE,
  base64ToBytes,
  contractCallFee,
  createSignedContractCall,
  predictContractAddress,
  quantaToXrge,
  suggestGasLimit,
  xrgeToQuanta,
};

/** The attach the tool accepts: XRGE by `amount_xrge` (decimal), tokens by `amount` (raw integer units). */
export interface AttachInput {
  symbol: string;
  amount_xrge?: string;
  amount?: number | string;
}

/** The attach as signed: upper-cased symbol + positive integer (quanta for XRGE, raw token units). */
export type ContractAttach = NormalizedContractAttach;

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
  return normalizeContractAttach({ symbol, amount });
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

/** Signed `contract_deploy` for `POST /api/v2/contract/publish`. `wasmB64` is base64 bytecode. */
export function createSignedContractPublish(wallet: WalletKeys, wasmB64: string, nonce?: string) {
  return sdkCreateSignedContractPublish(wallet, wasmB64, nonce === undefined ? {} : { nonce });
}
