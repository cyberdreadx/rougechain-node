/**
 * PQC Wallet — Balance queries, transactions, token operations
 * Adapted from quantum-vault/src/lib/pqc-wallet.ts
 */
import { getCoreApiBaseUrl, getCoreApiHeaders } from "./network";
import type { Block } from "./pqc-blockchain";

export const TOTAL_SUPPLY = 36_000_000_000;
export const TOKEN_SYMBOL = "XRGE";
export const TOKEN_NAME = "RougeChain";
export const CHAIN_ID = "rougechain-devnet-1";

export const BASE_TRANSFER_FEE = 0.1;

export interface WalletBalance {
    symbol: string;
    balance: number;
    name: string;
    icon: string;
    tokenAddress?: string;
}

export interface WalletTransaction {
    id: string;
    type: "send" | "receive" | "swap" | "create_token" | "fee";
    amount: string;
    symbol: string;
    address: string;
    timeLabel: string;
    timestamp: number;
    status: "completed" | "pending";
    blockIndex: number;
    txHash: string;
    fee?: number;
    from?: string;
    to?: string;
    memo?: string;
}

export function truncateAddress(address: string): string {
    if (!address) return "";
    if (address.length <= 16) return address;
    return `${address.slice(0, 8)}...${address.slice(-8)}`;
}

export function formatTimestamp(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString();
}

export async function getWalletBalance(publicKey: string): Promise<WalletBalance[]> {
    const baseUrl = getCoreApiBaseUrl();
    if (!baseUrl) return [{ symbol: TOKEN_SYMBOL, balance: 0, name: TOKEN_NAME, icon: "💎" }];

    try {
        const res = await fetch(`${baseUrl}/balance/${publicKey}`, {
            headers: getCoreApiHeaders(),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const xrgeBalance = data.balance ?? data.xrge ?? 0;
        const balances: WalletBalance[] = [
            { symbol: TOKEN_SYMBOL, balance: xrgeBalance, name: TOKEN_NAME, icon: "💎" },
        ];
        // Add custom token balances
        if (data.tokens && typeof data.tokens === "object") {
            for (const [symbol, amount] of Object.entries(data.tokens)) {
                balances.push({
                    symbol,
                    balance: amount as number,
                    name: symbol,
                    icon: "🪙",
                });
            }
        }
        return balances;
    } catch (err) {
        console.error("Failed to fetch balance:", err);
        return [{ symbol: TOKEN_SYMBOL, balance: 0, name: TOKEN_NAME, icon: "💎" }];
    }
}

export async function getWalletTransactions(publicKey: string): Promise<WalletTransaction[]> {
    const baseUrl = getCoreApiBaseUrl();
    if (!baseUrl) return [];

    try {
        const res = await fetch(`${baseUrl}/transactions/${publicKey}`, {
            headers: getCoreApiHeaders(),
        });
        if (!res.ok) return [];
        const data = await res.json();
        const txs = data.transactions || data || [];
        return txs.map((tx: any, idx: number) => ({
            id: tx.hash || tx.id || `tx-${idx}`,
            type: tx.from === publicKey ? "send" : "receive",
            amount: String(tx.amount || 0),
            symbol: tx.symbol || TOKEN_SYMBOL,
            address: tx.from === publicKey ? tx.to : tx.from,
            timeLabel: formatTimestamp(tx.timestamp || Date.now()),
            timestamp: tx.timestamp || Date.now(),
            status: "completed" as const,
            blockIndex: tx.block_index || tx.blockIndex || 0,
            txHash: tx.hash || "",
            fee: tx.fee,
            from: tx.from,
            to: tx.to,
            memo: tx.memo,
        }));
    } catch {
        return [];
    }
}

export async function sendTransaction(
    fromPrivateKey: string,
    fromPublicKey: string,
    toPublicKey: string,
    amount: number,
    symbol: string = "XRGE",
    memo?: string
): Promise<Block> {
    const baseUrl = getCoreApiBaseUrl();
    if (!baseUrl) throw new Error("Node not configured");

    const { ml_dsa65 } = await import("@noble/post-quantum/ml-dsa");
    const { hexToBytes, bytesToHex } = await import("./pqc-blockchain");

    const txData = JSON.stringify({
        type: "transfer",
        from: fromPublicKey,
        to: toPublicKey,
        amount,
        symbol,
        timestamp: Date.now(),
        fee: BASE_TRANSFER_FEE,
        ...(memo ? { memo } : {}),
    });

    const messageBytes = new TextEncoder().encode(txData);
    const signature = ml_dsa65.sign(messageBytes, hexToBytes(fromPrivateKey));

    const res = await fetch(`${baseUrl}/transaction`, {
        method: "POST",
        headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
            data: txData,
            signature: bytesToHex(signature),
            public_key: fromPublicKey,
        }),
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Transaction failed: ${errText}`);
    }
    return res.json();
}

export async function claimFaucet(publicKey: string): Promise<any> {
    const baseUrl = getCoreApiBaseUrl();
    if (!baseUrl) throw new Error("Node not configured");

    const res = await fetch(`${baseUrl}/faucet`, {
        method: "POST",
        headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ address: publicKey }),
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Faucet claim failed: ${errText}`);
    }
    return res.json();
}
