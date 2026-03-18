/**
 * PQC Wallet — Balance queries, transactions, token operations
 * Adapted from quantum-vault/src/lib/pqc-wallet.ts
 */
import { getCoreApiBaseUrl, getCoreApiHeaders } from "./network";
import { cachedFetch, invalidate } from "./api-cache";
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

async function fetchBalance(publicKey: string): Promise<WalletBalance[]> {
    const baseUrl = getCoreApiBaseUrl();
    if (!baseUrl) return [{ symbol: TOKEN_SYMBOL, balance: 0, name: TOKEN_NAME, icon: "🔴" }];

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
}

export async function getWalletBalance(publicKey: string): Promise<WalletBalance[]> {
    try {
        return await cachedFetch("balance", publicKey, () => fetchBalance(publicKey));
    } catch (err) {
        console.error("Failed to fetch balance:", err);
        return [{ symbol: TOKEN_SYMBOL, balance: 0, name: TOKEN_NAME, icon: "🔴" }];
    }
}

export async function getWalletTransactions(publicKey: string): Promise<WalletTransaction[]> {
    try {
        return await cachedFetch("blocks", publicKey, () => fetchTransactions(publicKey));
    } catch (err) {
        console.error("Failed to fetch transactions:", err);
        return [];
    }
}

async function fetchTransactions(publicKey: string): Promise<WalletTransaction[]> {
    const baseUrl = getCoreApiBaseUrl();
    if (!baseUrl) return [];

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
}

export interface TokenMeta {
    symbol: string;
    name: string;
    creator: string;
    image?: string;
    description?: string;
}

export async function getTokens(): Promise<TokenMeta[]> {
    const baseUrl = getCoreApiBaseUrl();
    if (!baseUrl) return [];
    try {
        return await cachedFetch("tokens", "all", async () => {
            const res = await fetch(`${baseUrl}/tokens`, { headers: getCoreApiHeaders() });
            if (!res.ok) return [];
            const data = await res.json();
            return data.tokens || [];
        });
    } catch { return []; }
}

export interface NftCollection {
    collection_id: string;
    symbol: string;
    name: string;
    creator: string;
    description?: string;
    image?: string;
    max_supply?: number;
    minted: number;
    royalty_bps: number;
    frozen: boolean;
}

export interface NftToken {
    collection_id: string;
    token_id: number;
    owner: string;
    creator: string;
    name: string;
    metadata_uri?: string;
    attributes?: unknown;
    locked: boolean;
    minted_at: number;
}

export async function getNftOwned(publicKey: string): Promise<NftToken[]> {
    const baseUrl = getCoreApiBaseUrl();
    if (!baseUrl) return [];
    try {
        return await cachedFetch("nftOwner", publicKey, async () => {
            const res = await fetch(`${baseUrl}/nft/owner/${encodeURIComponent(publicKey)}`, { headers: getCoreApiHeaders() });
            if (!res.ok) return [];
            const data = await res.json();
            return data.nfts || [];
        });
    } catch { return []; }
}

export async function getNftCollections(): Promise<NftCollection[]> {
    const baseUrl = getCoreApiBaseUrl();
    if (!baseUrl) return [];
    try {
        return await cachedFetch("nftCollections", "all", async () => {
            const res = await fetch(`${baseUrl}/nft/collections`, { headers: getCoreApiHeaders() });
            if (!res.ok) return [];
            const data = await res.json();
            return data.collections || [];
        });
    } catch { return []; }
}

export function invalidateNfts(): void {
    invalidate("nftOwner");
    invalidate("nftCollections");
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
        invalidate("balance");
        invalidate("blocks");
        invalidate("tokens");
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
    invalidate("balance");
    invalidate("blocks");
    return res.json();
}

// ===== Shielded Transactions =====

export interface ShieldedStats {
    commitment_count: number;
    nullifier_count: number;
    active_notes: number;
}

export async function getShieldedStats(): Promise<ShieldedStats> {
    const baseUrl = getCoreApiBaseUrl();
    if (!baseUrl) return { commitment_count: 0, nullifier_count: 0, active_notes: 0 };
    try {
        const res = await fetch(`${baseUrl}/shielded/stats`, { headers: getCoreApiHeaders() });
        if (!res.ok) throw new Error();
        const data = await res.json();
        return data;
    } catch {
        return { commitment_count: 0, nullifier_count: 0, active_notes: 0 };
    }
}

// Client-side commitment crypto (mirrors Rust commitment.rs)
const COMMITMENT_DOMAIN = new TextEncoder().encode("ROUGECHAIN_COMMITMENT_V1");
const NULLIFIER_DOMAIN = new TextEncoder().encode("ROUGECHAIN_NULLIFIER_V1");

function hexToU8(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return bytes;
}
function u8ToHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}
function u64ToBytes(v: number): Uint8Array {
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigUint64(0, BigInt(v), false);
    return buf;
}
function concat(...a: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(a.reduce((s, x) => s + x.length, 0));
    let o = 0; for (const x of a) { out.set(x, o); o += x.length; }
    return out;
}
async function sha256(data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", data.buffer as ArrayBuffer));
}

export interface ShieldedNote {
    commitment: string;
    nullifier: string;
    value: number;
    randomness: string;
    ownerPubKey: string;
}

export async function createShieldedNote(value: number, ownerPubKey: string): Promise<ShieldedNote> {
    const randBytes = new Uint8Array(32); crypto.getRandomValues(randBytes);
    const randomness = u8ToHex(randBytes);
    const commitment = u8ToHex(await sha256(concat(COMMITMENT_DOMAIN, u64ToBytes(value), hexToU8(ownerPubKey), randBytes)));
    const nullifier = u8ToHex(await sha256(concat(NULLIFIER_DOMAIN, randBytes, hexToU8(commitment))));
    return { commitment, nullifier, value, randomness, ownerPubKey };
}

// ===== Note Persistence (localStorage) =====

export interface StoredNote extends ShieldedNote {
    createdAt: number;
    spent: boolean;
    spentAt?: number;
}

const NOTE_STORE_KEY = "pqc-shielded-notes";

function noteStoreKey(): string {
    // Browser extension doesn't use getActiveNetwork, so just use a static key
    return NOTE_STORE_KEY;
}

function loadAllNotes(): StoredNote[] {
    try {
        const raw = localStorage.getItem(noteStoreKey());
        return raw ? JSON.parse(raw) : [];
    } catch { return []; }
}

function persistNotes(notes: StoredNote[]): void {
    localStorage.setItem(noteStoreKey(), JSON.stringify(notes));
}

export function saveNote(note: ShieldedNote): void {
    const notes = loadAllNotes();
    if (notes.some(n => n.commitment === note.commitment)) return;
    notes.push({ ...note, createdAt: Date.now(), spent: false });
    persistNotes(notes);
}

export function getActiveNotes(ownerPubKey: string): StoredNote[] {
    return loadAllNotes().filter(n => n.ownerPubKey === ownerPubKey && !n.spent);
}

export function getShieldedBalance(ownerPubKey: string): number {
    return getActiveNotes(ownerPubKey).reduce((sum, n) => sum + n.value, 0);
}

export function markNoteSpent(nullifier: string): void {
    const notes = loadAllNotes();
    const note = notes.find(n => n.nullifier === nullifier);
    if (note) { note.spent = true; note.spentAt = Date.now(); persistNotes(notes); }
}


