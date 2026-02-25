/**
 * PQC Wallet — Balance queries, transactions, token operations
 * Adapted from quantum-vault/src/lib/pqc-wallet.ts
 */
import { getCoreApiBaseUrl, getCoreApiHeaders } from "./network";
import type { Block } from "./pqc-blockchain";

export const TOTAL_SUPPLY = 36_000_000_000;
export const TOKEN_SYMBOL = "XRGE";
export const TOKEN_NAME = "RougeCoin";
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
    if (address === "FAUCET" || address === "GENESIS") return address;
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

// Fetch balance from node API
export async function getWalletBalance(publicKey: string): Promise<WalletBalance[]> {
    const baseUrl = getCoreApiBaseUrl();
    if (!baseUrl) return [{ symbol: TOKEN_SYMBOL, balance: 0, name: TOKEN_NAME, icon: "🔴" }];

    try {
        const res = await fetch(`${baseUrl}/balance/${publicKey}`, {
            headers: getCoreApiHeaders(),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as {
            success: boolean;
            balance: number;
            token_balances?: Record<string, number>;
        };

        const balances: WalletBalance[] = [];

        if (data.success) {
            balances.push({
                symbol: TOKEN_SYMBOL,
                balance: data.balance,
                name: TOKEN_NAME,
                icon: "🔴",
            });

            // Add custom token balances
            if (data.token_balances) {
                for (const [symbol, balance] of Object.entries(data.token_balances)) {
                    if (balance > 0) {
                        balances.push({
                            symbol,
                            balance,
                            name: symbol,
                            icon: symbol.charAt(0)?.toUpperCase() || "🪙",
                            tokenAddress: `token:${symbol.toLowerCase()}`,
                        });
                    }
                }
            }
        }

        if (balances.length > 0) return balances;
        return [{ symbol: TOKEN_SYMBOL, balance: 0, name: TOKEN_NAME, icon: "🔴" }];
    } catch (err) {
        console.error("Failed to fetch balance:", err);
        return [{ symbol: TOKEN_SYMBOL, balance: 0, name: TOKEN_NAME, icon: "🔴" }];
    }
}

// Fetch transactions by parsing blocks from the node API
export async function getWalletTransactions(publicKey: string): Promise<WalletTransaction[]> {
    const baseUrl = getCoreApiBaseUrl();
    if (!baseUrl) return [];

    try {
        const res = await fetch(`${baseUrl}/blocks`, {
            headers: getCoreApiHeaders(),
        });
        if (!res.ok) return [];
        const data = await res.json() as {
            blocks: Array<{
                version: number;
                header: {
                    height: number;
                    time: number;
                    prevHash?: string;
                    prev_hash?: string;
                    proposerPubKey?: string;
                    proposer_pub_key?: string;
                };
                txs: Array<{
                    version: number;
                    type?: string;
                    tx_type?: string;
                    fromPubKey?: string;
                    from_pub_key?: string;
                    nonce: number;
                    payload: {
                        toPubKeyHex?: string;
                        to_pub_key_hex?: string;
                        amount?: number;
                        faucet?: boolean;
                        token_symbol?: string;
                        tokenSymbol?: string;
                        token_name?: string;
                        tokenName?: string;
                    };
                    fee: number;
                    sig: string;
                }>;
                hash: string;
            }>;
        };

        const walletTxs: WalletTransaction[] = [];

        for (const block of data.blocks) {
            const header = block.header;
            const proposerPubKey = header.proposerPubKey ?? header.proposer_pub_key ?? "";

            for (const tx of block.txs) {
                const txType = tx.type ?? tx.tx_type;
                const from = tx.fromPubKey ?? tx.from_pub_key ?? "";
                const to = tx.payload?.toPubKeyHex ?? tx.payload?.to_pub_key_hex ?? "";
                const amount = tx.payload?.amount ?? 0;
                const isFaucet = tx.payload?.faucet === true;
                const tokenSymbol = tx.payload?.token_symbol || tx.payload?.tokenSymbol;

                const isSender = from === publicKey;
                const isReceiver = to === publicKey;
                const isFeeRecipient = proposerPubKey === publicKey && tx.fee > 0;

                if (!isSender && !isReceiver && !isFeeRecipient) continue;

                let type: WalletTransaction["type"] = isSender ? "send" : "receive";
                if (txType === "create_token") type = "create_token";
                if (isFaucet && isReceiver) type = "receive";

                const counterparty = isSender ? to : (isFaucet ? "FAUCET" : from);

                walletTxs.push({
                    id: block.hash.slice(0, 16),
                    type,
                    amount: String(amount),
                    symbol: tokenSymbol || TOKEN_SYMBOL,
                    address: counterparty,
                    timeLabel: formatTimestamp(header.time),
                    timestamp: header.time,
                    status: "completed",
                    blockIndex: header.height,
                    txHash: block.hash,
                    fee: tx.fee,
                    from: isFaucet ? "FAUCET" : from,
                    to,
                    memo: isFaucet ? "Faucet" : (txType === "create_token" ? `Created ${tx.payload?.token_name || tx.payload?.tokenName || "token"}` : undefined),
                });
            }
        }

        return walletTxs.sort((a, b) => b.blockIndex - a.blockIndex);
    } catch (err) {
        console.error("Failed to fetch transactions:", err);
        return [];
    }
}

// Send transaction via node API (server-side signing via tx/submit)
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

    const res = await fetch(`${baseUrl}/tx/submit`, {
        method: "POST",
        headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
            fromPrivateKey,
            fromPublicKey,
            toPublicKey,
            amount,
            fee: BASE_TRANSFER_FEE,
            ...(symbol !== "XRGE" ? { tokenSymbol: symbol } : {}),
        }),
    });

    const text = await res.text();
    if (!text) throw new Error(`Server returned empty response (status ${res.status})`);

    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`Invalid response: ${text.substring(0, 100)}`); }

    if (res.ok && data.success) {
        return {
            index: 0,
            timestamp: Date.now(),
            data: JSON.stringify({ type: "transfer", from: fromPublicKey, to: toPublicKey, amount }),
            previousHash: "",
            hash: data.txId || "",
            nonce: 0,
            signature: "",
            signerPublicKey: fromPublicKey,
        };
    }

    if (data.error) throw new Error(data.error);
    throw new Error(`Transaction failed: ${res.status} ${res.statusText}`);
}

// Claim faucet tokens
export async function claimFaucet(publicKey: string): Promise<any> {
    const baseUrl = getCoreApiBaseUrl();
    if (!baseUrl) throw new Error("Node not configured");

    const res = await fetch(`${baseUrl}/faucet`, {
        method: "POST",
        headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ recipientPublicKey: publicKey }),
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Faucet claim failed: ${errText}`);
    }
    return res.json();
}
