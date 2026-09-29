/**
 * A tiny EIP-1193 provider backed by the site wallet's own Base key (derived
 * from the recovery phrase — see evm-wallet.ts). Lets existing code written
 * against `window.ethereum` (the Bridge page) use "my RougeChain Base wallet"
 * without MetaMask, reusing its contract-call code unchanged.
 *
 * Safety model:
 *   - Pinned to ONE chain (the one matching the site's RougeChain network);
 *     wallet_switchEthereumChain to anything else is refused.
 *   - Every eth_sendTransaction / personal_sign goes through `confirm`, which the
 *     page renders as an explicit approval dialog. Rejection → EIP-1193 4001.
 *   - `from` must be this wallet's address.
 *   - The mnemonic is fetched per request via `getMnemonic` (null when the vault
 *     is locked) — the provider never holds a key.
 *   - Only an allowlist of read-only RPC methods is proxied.
 */
import type { Hex } from "viem";
import { deriveBaseAddress, signBaseMessage } from "./evm-wallet";
import { baseRpc, quoteBaseFee, signAndSendBase, type BaseChainInfo, type BaseFeeQuote } from "./base-wallet";

export interface ProviderRpcError extends Error { code: number }

function rpcError(code: number, message: string): ProviderRpcError {
  const e = new Error(message) as ProviderRpcError;
  e.code = code;
  return e;
}

export type LocalBaseRequest =
  | { kind: "tx"; to: string; value: bigint; data: Hex; fee: BaseFeeQuote }
  | { kind: "sign"; message: string };

const READ_ONLY = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
]);

const big = (v: unknown): bigint => {
  if (v === undefined || v === null || v === "") return 0n;
  try { return BigInt(v as string); } catch { return 0n; }
};

function hexToBytes(h: string): Uint8Array {
  const clean = h.startsWith("0x") ? h.slice(2) : h;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function previewMessage(param: string): string {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(param)) return param;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(hexToBytes(param));
  } catch {
    return param;
  }
}

export interface LocalBaseProvider {
  readonly isRougeChainLocal: true;
  readonly address: `0x${string}`;
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
}

export function createLocalBaseProvider(opts: {
  chain: BaseChainInfo;
  getMnemonic: () => string | null | undefined;
  confirm: (req: LocalBaseRequest) => Promise<boolean>;
}): LocalBaseProvider | null {
  const { chain, getMnemonic, confirm } = opts;
  const address = deriveBaseAddress(getMnemonic());
  if (!address) return null;
  const chainIdHex = `0x${chain.chainId.toString(16)}`;

  const mnemonicOrThrow = (): string => {
    const m = getMnemonic();
    if (!m || deriveBaseAddress(m) !== address) throw rpcError(4100, "Wallet is locked or changed — unlock it and try again.");
    return m;
  };

  return {
    isRougeChainLocal: true,
    address,
    async request({ method, params }) {
      const p = (Array.isArray(params) ? params : []) as unknown[];
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [address];
        case "eth_chainId":
          return chainIdHex;
        case "net_version":
          return String(chain.chainId);
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain": {
          const want = String((p[0] as { chainId?: string } | undefined)?.chainId ?? "").toLowerCase();
          if (want === chainIdHex) return null;
          throw rpcError(4902, `This wallet only operates on ${chain.name}.`);
        }
        case "personal_sign": {
          const [msg, who] = p as [string, string];
          if (typeof msg !== "string" || String(who).toLowerCase() !== address.toLowerCase()) {
            throw rpcError(4100, "personal_sign: unknown account");
          }
          const mnemonic = mnemonicOrThrow();
          if (!(await confirm({ kind: "sign", message: previewMessage(msg) }))) throw rpcError(4001, "User rejected the request.");
          const bytes = /^0x([0-9a-fA-F]{2})*$/.test(msg) ? hexToBytes(msg) : new TextEncoder().encode(msg);
          return signBaseMessage(mnemonic, bytes);
        }
        case "eth_sendTransaction": {
          const tx = (p[0] ?? {}) as { from?: string; to?: string; value?: string; data?: string; gas?: string };
          if (tx.from && tx.from.toLowerCase() !== address.toLowerCase()) throw rpcError(4100, "eth_sendTransaction: unknown from address");
          if (!tx.to || !/^0x[0-9a-fA-F]{40}$/.test(tx.to)) throw rpcError(-32602, "eth_sendTransaction: contract creation is not supported");
          const mnemonic = mnemonicOrThrow();
          const call = { to: tx.to as `0x${string}`, value: big(tx.value), data: (tx.data && tx.data !== "0x" ? tx.data : "0x") as Hex };
          const quoted = await quoteBaseFee(chain, address, call);
          // Respect a caller-provided gas limit (e.g. the bridge's fixed 500k) if higher.
          const gasLimit = big(tx.gas) > quoted.gasLimit ? big(tx.gas) : quoted.gasLimit;
          const l2FeeWei = gasLimit * quoted.maxFeePerGas;
          const fee: BaseFeeQuote = { ...quoted, gasLimit, l2FeeWei, totalFeeWei: l2FeeWei + quoted.l1FeeWei };
          if (!(await confirm({ kind: "tx", to: call.to, value: call.value, data: call.data, fee }))) {
            throw rpcError(4001, "User rejected the request.");
          }
          return signAndSendBase({ chain, mnemonic, from: address, call, fee });
        }
        default:
          if (READ_ONLY.has(method)) return baseRpc(chain, method, p);
          throw rpcError(4200, `Unsupported method: ${method}`);
      }
    },
  };
}
