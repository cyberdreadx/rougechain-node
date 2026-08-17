/**
 * Minimal Base JSON-RPC client + transaction filler.
 *
 * Scoped deliberately to Base mainnet + Base Sepolia (that's all the bridge needs).
 * Read-only calls are plain fetch() POSTs; state-changing calls go through
 * fillSignAndSend, which fills nonce/gas/EIP-1559 fees, signs locally with the
 * derived key (see evm-wallet.ts) and broadcasts via eth_sendRawTransaction.
 */
import { signEip1559, type EvmAccount } from "./evm-wallet";

export const BASE_MAINNET_CHAIN_ID = 8453;
export const BASE_SEPOLIA_CHAIN_ID = 84532;

export interface ChainConfig {
    chainId: number;
    chainIdHex: string;
    name: string;
    rpcUrl: string;
    explorer: string;
    nativeCurrency: { name: string; symbol: string; decimals: number };
}

export const CHAINS: Record<number, ChainConfig> = {
    [BASE_MAINNET_CHAIN_ID]: {
        chainId: BASE_MAINNET_CHAIN_ID,
        chainIdHex: "0x2105",
        name: "Base",
        rpcUrl: "https://mainnet.base.org",
        explorer: "https://basescan.org",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    },
    [BASE_SEPOLIA_CHAIN_ID]: {
        chainId: BASE_SEPOLIA_CHAIN_ID,
        chainIdHex: "0x14a34",
        name: "Base Sepolia",
        rpcUrl: "https://sepolia.base.org",
        explorer: "https://sepolia.basescan.org",
        nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    },
};

export function isSupportedChain(chainId: number): boolean {
    return chainId in CHAINS;
}

export function getChain(chainId: number): ChainConfig {
    const c = CHAINS[chainId];
    if (!c) throw new Error(`Unsupported chain: ${chainId}`);
    return c;
}

let rpcId = 0;

/** Raw JSON-RPC call to a Base node. Throws on RPC-level errors. */
export async function rpc<T = unknown>(chainId: number, method: string, params: unknown[] = []): Promise<T> {
    const { rpcUrl } = getChain(chainId);
    const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    if (!res.ok) throw new Error(`Base RPC HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || `RPC error (${method})`);
    return json.result as T;
}

const toBigInt = (hex: string | null | undefined): bigint => (hex ? BigInt(hex) : 0n);
const toHex = (n: bigint): string => "0x" + n.toString(16);

export interface TxRequest {
    from: string;
    to: string;
    value?: string; // 0x-hex wei
    data?: string;  // 0x-hex calldata
    gas?: string;   // 0x-hex gas limit (from the dApp, optional)
}

/**
 * Fill nonce/gas/fees for an EIP-1559 tx, sign it locally, and broadcast.
 * Returns the transaction hash.
 */
export async function fillSignAndSend(
    chainId: number,
    account: EvmAccount,
    tx: TxRequest,
): Promise<string> {
    const value = toBigInt(tx.value);
    const data = tx.data && tx.data !== "0x" ? tx.data : "0x";

    // nonce (pending, so queued txs chain correctly)
    const nonce = toBigInt(await rpc<string>(chainId, "eth_getTransactionCount", [account.address, "pending"]));

    // gas limit: honor the dApp's hint, else estimate + 20% headroom
    let gasLimit: bigint;
    if (tx.gas) {
        gasLimit = toBigInt(tx.gas);
    } else {
        const est = toBigInt(await rpc<string>(chainId, "eth_estimateGas", [{
            from: account.address, to: tx.to, value: tx.value ?? "0x0", data,
        }]));
        gasLimit = (est * 120n) / 100n;
    }

    // EIP-1559 fees: priority = eth_maxPriorityFeePerGas (fallback 1 gwei),
    // maxFee = baseFee*2 + priority
    let priority: bigint;
    try {
        priority = toBigInt(await rpc<string>(chainId, "eth_maxPriorityFeePerGas", []));
        if (priority === 0n) priority = 1_000_000_000n;
    } catch {
        priority = 1_000_000_000n; // 1 gwei
    }
    const block = await rpc<{ baseFeePerGas?: string }>(chainId, "eth_getBlockByNumber", ["pending", false]);
    const baseFee = toBigInt(block?.baseFeePerGas);
    const maxFeePerGas = baseFee * 2n + priority;

    const raw = signEip1559(account.privateKey, {
        chainId,
        nonce,
        to: tx.to,
        value,
        data,
        gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas: priority,
    });

    return rpc<string>(chainId, "eth_sendRawTransaction", [raw]);
}

/** Read the native (ETH) balance in wei as a 0x-hex string. */
export function getBalance(chainId: number, address: string): Promise<string> {
    return rpc<string>(chainId, "eth_getBalance", [address, "latest"]);
}

export { toHex };
