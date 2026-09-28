/**
 * Base (Ethereum L2) wallet plumbing for the site: chain selection, a minimal
 * JSON-RPC client, balances, EIP-1559 fee quotes and native ETH / ERC-20 sends.
 *
 * Mirrors Qwalla (`lib/evm-rpc.ts`, `lib/base-assets.ts`, `lib/base-send.ts`) and
 * the browser extension (`BaseBalances.tsx`):
 *   - RPC: https://mainnet.base.org (8453) / https://sepolia.base.org (84532)
 *   - RougeChain mainnet → Base mainnet; testnet → Base Sepolia (never crossed)
 *   - gasLimit = eth_estimateGas × 1.2, maxFee = 2 × baseFee + priority,
 *     priority = eth_maxPriorityFeePerGas (1 gwei if the node can't say)
 *
 * On top of Qwalla we also quote the OP-stack L1 data fee (GasPriceOracle
 * precompile) so "Max" for ETH leaves enough for the whole fee, and the exact
 * fee values shown on the confirm step are the ones that get signed.
 */
import { getAddress, isAddress, serializeTransaction, formatUnits, type Hex } from "viem";
import { getActiveNetwork, type NetworkType } from "./network";
import {
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  expectedBaseChainId,
  getBaseChainConfig,
  getExplorerUrl,
  getUsdcAddress,
  getXrgeAddress,
} from "./bridge";
import { signBaseTransaction } from "./evm-wallet";

export { BASE_MAINNET_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID };

export type BaseAssetSymbol = "ETH" | "XRGE" | "USDC";

export interface BaseAssetDef {
  symbol: BaseAssetSymbol;
  name: string;
  decimals: number;
  /** ERC-20 contract; undefined for native ETH. */
  token?: `0x${string}`;
}

export interface BaseChainInfo {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorer: string;
  isMainnet: boolean;
}

/** The Base chain that pairs with the site's active RougeChain network. */
export function getBaseChain(network: NetworkType = getActiveNetwork()): BaseChainInfo {
  const chainId = expectedBaseChainId(network);
  const cfg = getBaseChainConfig(chainId);
  return {
    chainId,
    name: cfg.name,
    rpcUrl: cfg.rpcUrls.default.http[0],
    explorer: getExplorerUrl(chainId),
    isMainnet: chainId === BASE_MAINNET_CHAIN_ID,
  };
}

/** ETH / XRGE / USDC on the given Base chain (fixed decimals: 18 / 18 / 6). */
export function getBaseAssets(chainId: number): BaseAssetDef[] {
  return [
    { symbol: "ETH", name: "Ether", decimals: 18 },
    { symbol: "XRGE", name: "RougeCoin", decimals: 18, token: getAddress(getXrgeAddress(chainId)) },
    { symbol: "USDC", name: "USD Coin", decimals: 6, token: getAddress(getUsdcAddress(chainId)) },
  ];
}

// ── JSON-RPC ────────────────────────────────────────────────────────────────

let rpcId = 0;

export class BaseRpcError extends Error {
  code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "BaseRpcError";
    this.code = code;
  }
}

export async function baseRpc<T = unknown>(chain: BaseChainInfo, method: string, params: unknown[] = []): Promise<T> {
  let res: Response;
  try {
    res = await fetch(chain.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      signal: typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(15_000) : undefined,
    });
  } catch {
    throw new BaseRpcError(`Couldn't reach ${chain.name}`);
  }
  if (!res.ok) throw new BaseRpcError(`${chain.name} RPC HTTP ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message?: string; code?: number } };
  if (json.error) throw new BaseRpcError(json.error.message || `RPC error (${method})`, json.error.code);
  return json.result as T;
}

const big = (v: unknown): bigint => {
  if (v === undefined || v === null || v === "" || v === "0x") return 0n;
  try { return BigInt(v as string); } catch { return 0n; }
};
const hex = (n: bigint): Hex => `0x${n.toString(16)}`;

// ── Amounts & addresses ─────────────────────────────────────────────────────

/** Decimal string → base units, exact (no float). Throws on bad input / too many decimals. */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const s = amount.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") throw new Error("Invalid amount");
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`Too many decimals — max ${decimals}`);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** Base units → plain decimal string with at most `maxFrac` fractional digits (truncated). */
export function formatBaseUnits(value: bigint, decimals: number, maxFrac = 6): string {
  const full = formatUnits(value, decimals);
  const [w, f = ""] = full.split(".");
  const frac = f.slice(0, maxFrac).replace(/0+$/, "");
  return frac ? `${w}.${frac}` : w;
}

export type AddressCheck = "empty" | "invalid" | "bad-checksum" | "ok";

/** Validate a recipient: 0x + 40 hex; mixed case must be a valid EIP-55 checksum. */
export function checkBaseAddress(input: string): AddressCheck {
  const s = input.trim();
  if (!s) return "empty";
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return "invalid";
  return isAddress(s, { strict: true }) ? "ok" : "bad-checksum";
}

/** ABI-encode ERC-20 transfer(address,uint256). */
export function erc20TransferData(to: string, amount: bigint): Hex {
  return `0xa9059cbb${to.toLowerCase().replace(/^0x/, "").padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;
}

const balanceOfData = (owner: string): Hex =>
  `0x70a08231${owner.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;

// ── Balances ────────────────────────────────────────────────────────────────

export interface BaseBalance {
  asset: BaseAssetDef;
  /** Raw units, or null when that token's call failed. */
  raw: bigint | null;
}

/** ETH + ERC-20 balances. Throws if the chain is unreachable (ETH call fails). */
export async function fetchBaseBalances(chain: BaseChainInfo, owner: string): Promise<BaseBalance[]> {
  const assets = getBaseAssets(chain.chainId);
  return Promise.all(
    assets.map(async (asset): Promise<BaseBalance> => {
      if (!asset.token) {
        return { asset, raw: big(await baseRpc<string>(chain, "eth_getBalance", [owner, "latest"])) };
      }
      try {
        const r = await baseRpc<string>(chain, "eth_call", [{ to: asset.token, data: balanceOfData(owner) }, "latest"]);
        return { asset, raw: big(r) };
      } catch {
        return { asset, raw: null };
      }
    }),
  );
}

// ── Fees ────────────────────────────────────────────────────────────────────

/** OP-stack GasPriceOracle predeploy (Base + Base Sepolia). */
export const GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F";
const GET_L1_FEE = "0x49948e0e"; // getL1Fee(bytes)

export interface BaseCall { to: `0x${string}`; value: bigint; data: Hex }

export interface BaseFeeQuote {
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** gasLimit × maxFeePerGas — the L2 execution ceiling. */
  l2FeeWei: bigint;
  /** OP-stack L1 data fee estimate (with headroom); 0 if the oracle was unavailable. */
  l1FeeWei: bigint;
  /** Worst-case total the sender must hold on top of the value. */
  totalFeeWei: bigint;
}

/** The on-chain call for sending `units` of `asset` to `recipient`. */
export function buildSendCall(asset: BaseAssetDef, recipient: string, units: bigint): BaseCall {
  const to = getAddress(recipient.trim());
  if (asset.token) return { to: asset.token, value: 0n, data: erc20TransferData(to, units) };
  return { to, value: units, data: "0x" };
}

function abiEncodeBytes(data: Hex): Hex {
  const body = data.slice(2);
  const len = body.length / 2;
  const padded = body.padEnd(Math.ceil(body.length / 64) * 64, "0");
  return `0x${(32).toString(16).padStart(64, "0")}${len.toString(16).padStart(64, "0")}${padded}`;
}

/** EIP-1559 fee quote for `call` from `from` (read-only; nothing is signed). */
export async function quoteBaseFee(chain: BaseChainInfo, from: string, call: BaseCall): Promise<BaseFeeQuote> {
  const est = await baseRpc<string>(chain, "eth_estimateGas", [
    { from, to: call.to, value: hex(call.value), data: call.data },
  ]);
  const gasLimit = (big(est) * 12n) / 10n; // +20% headroom (Qwalla)

  const block = await baseRpc<{ baseFeePerGas?: string } | null>(chain, "eth_getBlockByNumber", ["latest", false]);
  const baseFee = big(block?.baseFeePerGas);
  let priority: bigint;
  try {
    priority = big(await baseRpc<string>(chain, "eth_maxPriorityFeePerGas", []));
  } catch {
    priority = 1_000_000_000n; // 1 gwei fallback (Qwalla)
  }
  if (priority === 0n) priority = 1_000_000n; // 0.001 gwei floor so the tx isn't priced at zero tip
  const maxFeePerGas = baseFee * 2n + priority;
  const l2FeeWei = gasLimit * maxFeePerGas;

  let l1FeeWei = 0n;
  try {
    const unsigned = serializeTransaction({
      type: "eip1559",
      chainId: chain.chainId,
      nonce: 0,
      to: call.to,
      value: call.value,
      data: call.data,
      gas: gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas: priority,
    });
    const r = await baseRpc<string>(chain, "eth_call", [
      { to: GAS_PRICE_ORACLE, data: `${GET_L1_FEE}${abiEncodeBytes(unsigned).slice(2)}` },
      "latest",
    ]);
    l1FeeWei = (big(r) * 3n) / 2n; // +50% headroom: L1 blob/base fee moves between quote and inclusion
  } catch {
    l1FeeWei = 0n;
  }

  return {
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas: priority,
    l2FeeWei,
    l1FeeWei,
    totalFeeWei: l2FeeWei + l1FeeWei,
  };
}

/**
 * Largest ETH amount sendable after reserving the fee for a plain transfer.
 * Reserves 1.5× the quoted fee so a small base-fee rise between "Max" and
 * "Confirm" doesn't make the send fail.
 */
export function maxSendableEth(balanceWei: bigint, fee: BaseFeeQuote): bigint {
  const reserve = (fee.totalFeeWei * 3n) / 2n;
  return balanceWei > reserve ? balanceWei - reserve : 0n;
}

// ── Sign + broadcast ────────────────────────────────────────────────────────

/**
 * Sign `call` locally with the phrase's Base key using the EXACT fee values of
 * `fee` (what the user confirmed), then broadcast. Returns the tx hash.
 * `gasLimit` may be overridden by a caller that supplied its own (e.g. dApp gas).
 */
export async function signAndSendBase(opts: {
  chain: BaseChainInfo;
  mnemonic: string;
  from: string;
  call: BaseCall;
  fee: Pick<BaseFeeQuote, "gasLimit" | "maxFeePerGas" | "maxPriorityFeePerGas">;
}): Promise<Hex> {
  const { chain, mnemonic, from, call, fee } = opts;
  const nonce = big(await baseRpc<string>(chain, "eth_getTransactionCount", [from, "pending"]));
  const raw = await signBaseTransaction(mnemonic, {
    chainId: chain.chainId,
    nonce: Number(nonce),
    to: call.to,
    value: call.value,
    data: call.data === "0x" ? undefined : call.data,
    gas: fee.gasLimit,
    maxFeePerGas: fee.maxFeePerGas,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
  });
  return baseRpc<Hex>(chain, "eth_sendRawTransaction", [raw]);
}

export function baseTxUrl(chain: BaseChainInfo, hash: string): string {
  return `${chain.explorer}/tx/${hash}`;
}
export function baseAddressUrl(chain: BaseChainInfo, address: string): string {
  return `${chain.explorer}/address/${address}`;
}
