import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Send, Download, Droplets, Copy, Check, TrendingUp, ArrowDownUp, Shield, ShieldOff, AlertCircle, X } from "lucide-react";
import type { UnifiedWallet } from "../../lib/unified-wallet";
import { pubkeyToAddress, formatAddress, formatIdentity } from "../../lib/address";
import {
    getWalletBalance,
    getWalletTransactions,
    claimFaucet,
    truncateAddress,
    formatTimestamp,
    TOKEN_SYMBOL,
    getShieldedStats,
    createShieldedNote,
    saveNote,
    getActiveNotes,
    markNoteSpent,
    getShieldedBalance,
    type WalletBalance,
    type WalletTransaction,
    type ShieldedStats,
    type ShieldedNote,
    type StoredNote,
} from "../../lib/pqc-wallet";

interface Props {
    wallet: UnifiedWallet;
    onUpdate: (w: UnifiedWallet) => void;
}

// --- Shared utilities ---
const sortKeysDeep = (obj: any): any => {
    if (Array.isArray(obj)) return obj.map(sortKeysDeep);
    if (obj && typeof obj === "object") {
        const sorted: any = {};
        for (const k of Object.keys(obj).sort()) sorted[k] = sortKeysDeep(obj[k]);
        return sorted;
    }
    return obj;
};

const hexToBytes = (hex: string): Uint8Array => {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return bytes;
};

const bytesToHex = (bytes: Uint8Array): string =>
    Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");

export default function WalletTab({ wallet }: Props) {
    const [balances, setBalances] = useState<WalletBalance[]>([]);
    const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isClaiming, setIsClaiming] = useState(false);
    const [copied, setCopied] = useState(false);
    const [showSend, setShowSend] = useState(false);
    const [sendTo, setSendTo] = useState("");
    const [sendAmount, setSendAmount] = useState("");
    const [sendMemo, setSendMemo] = useState("");
    const [isSending, setIsSending] = useState(false);
    const [showShield, setShowShield] = useState(false);
    const [shieldAmount, setShieldAmount] = useState("");
    const [isShielding, setIsShielding] = useState(false);
    const [shieldedNote, setShieldedNote] = useState<ShieldedNote | null>(null);
    const [shieldedStats, setShieldedStats] = useState<ShieldedStats | null>(null);
    const [noteCopied, setNoteCopied] = useState(false);
    const [showUnshield, setShowUnshield] = useState(false);
    const [savedNotes, setSavedNotes] = useState<StoredNote[]>([]);
    const [unshieldingNote, setUnshieldingNote] = useState<string | null>(null);
    const [toast, setToast] = useState<{ message: string; type: "error" | "success" } | null>(null);
    const [rougeAddress, setRougeAddress] = useState<string>("");

    const showToast = (message: string, type: "error" | "success" = "error") => {
        setToast({ message, type });
        setTimeout(() => setToast(null), 4000);
    };

    const refreshData = useCallback(async (showSpinner = true) => {
        if (showSpinner) setIsLoading(true);
        try {
            const [bal, txs] = await Promise.all([
                getWalletBalance(wallet.signingPublicKey),
                getWalletTransactions(wallet.signingPublicKey),
            ]);
            setBalances(bal);
            setTransactions(txs.slice(0, 20));
        } catch (err) {
            console.error("Failed to load wallet data:", err);
        }
        // Also fetch shielded stats
        try {
            const stats = await getShieldedStats();
            setShieldedStats(stats);
        } catch { /* ignore */ }
        setIsLoading(false);
    }, [wallet.signingPublicKey]);

    useEffect(() => {
        refreshData();
        // Auto-refresh every 10 seconds
        const interval = setInterval(() => refreshData(false), 10_000);
        return () => clearInterval(interval);
    }, [refreshData]);

    // Compute rouge1 address from signing key
    useEffect(() => {
        pubkeyToAddress(wallet.signingPublicKey).then(setRougeAddress).catch(() => {});
    }, [wallet.signingPublicKey]);

    const xrgeBalance = balances.find(b => b.symbol === TOKEN_SYMBOL)?.balance || 0;

    const copyAddress = () => {
        navigator.clipboard.writeText(rougeAddress || wallet.signingPublicKey);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const handleFaucet = async () => {
        setIsClaiming(true);
        try {
            await claimFaucet(wallet.signingPublicKey);
            // Wait 2s for the node to process the faucet tx
            await new Promise(r => setTimeout(r, 2000));
            await refreshData();
        } catch (err) {
            console.error("Faucet failed:", err);
        }
        setIsClaiming(false);
    };

    const handleSend = async () => {
        if (!sendTo || !sendAmount || isSending) return;
        setIsSending(true);
        try {
            const { sendTransaction } = await import("../../lib/pqc-wallet");
            await sendTransaction(
                wallet.signingPrivateKey,
                wallet.signingPublicKey,
                sendTo,
                parseFloat(sendAmount),
                TOKEN_SYMBOL,
                sendMemo || undefined
            );
            setShowSend(false);
            setSendTo("");
            setSendAmount("");
            setSendMemo("");
            await refreshData();
        } catch (err: any) {
            console.error("Send failed:", err);
            showToast(err.message || "Send failed");
        }
        setIsSending(false);
    };

    return (
        <div className="flex flex-col h-full overflow-hidden">
            {/* Inline toast */}
            {toast && (
                <div className={`flex items-center gap-2 px-3 py-2 text-xs font-medium animate-in slide-in-from-top ${
                    toast.type === "error"
                        ? "bg-destructive/10 text-destructive border-b border-destructive/20"
                        : "bg-success/10 text-success border-b border-success/20"
                }`}>
                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="flex-1 truncate">{toast.message}</span>
                    <button onClick={() => setToast(null)} className="flex-shrink-0 opacity-60 hover:opacity-100">
                        <X className="w-3 h-3" />
                    </button>
                </div>
            )}

            {/* Balance card */}
            <div className="p-4 bg-gradient-to-br from-card via-card to-primary/5 border-b border-border">
                <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-muted-foreground">{wallet.displayName}</span>
                    <button onClick={() => refreshData()} className="text-muted-foreground hover:text-primary transition-colors active:scale-90">
                        <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
                    </button>
                </div>

                <div className="flex items-center gap-3 mb-2">
                    <div className="relative">
                        <img src="/xrge-logo.webp" alt="XRGE" className="w-10 h-10 rounded-full ring-2 ring-primary/40 shadow-lg shadow-primary/10" />
                        <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-success border-2 border-card" />
                    </div>
                    <div>
                        <div className="flex items-baseline gap-1.5">
                            <span className="text-2xl font-bold text-foreground tracking-tight">
                                {xrgeBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                            </span>
                            <span className="text-sm text-primary font-semibold">{TOKEN_SYMBOL}</span>
                        </div>
                        <button
                            onClick={copyAddress}
                            className="flex items-center gap-1 text-[10px] text-muted-foreground font-mono hover:text-foreground transition-colors mt-0.5"
                        >
                            {rougeAddress ? formatAddress(rougeAddress) : truncateAddress(wallet.signingPublicKey)}
                            {copied ? <Check className="w-2.5 h-2.5 text-success" /> : <Copy className="w-2.5 h-2.5" />}
                        </button>
                    </div>
                </div>

                {/* Shielded balance badge */}
                {shieldedStats && shieldedStats.active_notes > 0 && (
                    <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-primary/10 border border-primary/20 mb-3">
                        <Shield className="w-3 h-3 text-primary" />
                        <span className="text-[10px] text-primary font-semibold">
                            {getShieldedBalance(wallet.signingPublicKey) > 0 
                              ? `${getShieldedBalance(wallet.signingPublicKey).toLocaleString()} XRGE shielded`
                              : `${shieldedStats.active_notes} shielded note${shieldedStats.active_notes !== 1 ? 's' : ''}`
                            }
                        </span>
                    </div>
                )}

                {/* Action buttons — 3 + 2 grid */}
                <div className="space-y-2 mt-3">
                    <div className="grid grid-cols-3 gap-2">
                        <button
                            onClick={() => setShowSend(!showSend)}
                            className="flex flex-col items-center gap-1 py-2.5 rounded-xl bg-primary text-primary-foreground font-semibold hover:bg-primary/90 active:scale-[0.96] transition-all shadow-md shadow-primary/20"
                        >
                            <Send className="w-4 h-4" />
                            <span className="text-[10px]">Send</span>
                        </button>
                        <button
                            onClick={copyAddress}
                            className="flex flex-col items-center gap-1 py-2.5 rounded-xl bg-secondary text-secondary-foreground font-semibold hover:bg-secondary/80 active:scale-[0.96] transition-all"
                        >
                            <Download className="w-4 h-4" />
                            <span className="text-[10px]">Receive</span>
                        </button>
                        <button
                            onClick={handleFaucet}
                            disabled={isClaiming}
                            className="flex flex-col items-center gap-1 py-2.5 rounded-xl bg-accent/15 text-accent-foreground font-semibold hover:bg-accent/25 active:scale-[0.96] transition-all disabled:opacity-50"
                        >
                            <Droplets className={`w-4 h-4 ${isClaiming ? "animate-spin" : ""}`} />
                            <span className="text-[10px]">{isClaiming ? "..." : "Faucet"}</span>
                        </button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <button
                            onClick={() => { setShowShield(!showShield); setShieldedNote(null); }}
                            className="flex items-center justify-center gap-1.5 py-2 rounded-xl bg-primary/10 text-primary font-semibold hover:bg-primary/20 active:scale-[0.96] transition-all border border-primary/20"
                        >
                            <Shield className="w-3.5 h-3.5" />
                            <span className="text-[10px]">Shield</span>
                        </button>
                        <button
                            onClick={() => { setShowUnshield(!showUnshield); setSavedNotes(getActiveNotes(wallet.signingPublicKey)); }}
                            className="flex items-center justify-center gap-1.5 py-2 rounded-xl bg-accent/10 text-accent-foreground font-semibold hover:bg-accent/20 active:scale-[0.96] transition-all border border-accent/20"
                        >
                            <ShieldOff className="w-3.5 h-3.5" />
                            <span className="text-[10px]">Unshield</span>
                        </button>
                    </div>
                </div>
            </div>

            {/* Send form */}
            {showSend && (
                <div className="p-3 border-b border-border bg-card/80 space-y-2">
                    <input
                        type="text"
                        placeholder="Recipient address"
                        value={sendTo}
                        onChange={e => setSendTo(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg bg-input border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    <div className="flex gap-2">
                        <input
                            type="number"
                            placeholder="Amount"
                            value={sendAmount}
                            onChange={e => setSendAmount(e.target.value)}
                            className="flex-1 px-3 py-2 rounded-lg bg-input border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                        <input
                            type="text"
                            placeholder="Memo"
                            value={sendMemo}
                            onChange={e => setSendMemo(e.target.value)}
                            className="flex-1 px-3 py-2 rounded-lg bg-input border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                    </div>
                    <button
                        onClick={handleSend}
                        disabled={!sendTo || !sendAmount || isSending}
                        className="w-full py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
                    >
                        {isSending ? "Signing & Sending..." : `Send ${TOKEN_SYMBOL}`}
                    </button>
                </div>
            )}

            {/* Shield form */}
            {showShield && (
                <div className="p-3 border-b border-border bg-card/80 space-y-2">
                    {shieldedNote ? (
                        /* Success — show note */
                        <div className="space-y-2">
                            <div className="flex items-center gap-1.5 text-xs text-success">
                                <Check className="w-3.5 h-3.5" />
                                <span className="font-semibold">Shielded {shieldedNote.value} XRGE</span>
                            </div>
                            <p className="text-[10px] text-warning">⚠️ Save this note data — it's the ONLY way to unshield!</p>
                            <div className="bg-muted/50 rounded-lg p-2 border border-border text-[9px] font-mono text-foreground break-all space-y-1">
                                <div><span className="text-muted-foreground">commitment:</span> {shieldedNote.commitment}</div>
                                <div><span className="text-muted-foreground">nullifier:</span> {shieldedNote.nullifier}</div>
                                <div><span className="text-muted-foreground">randomness:</span> {shieldedNote.randomness}</div>
                                <div><span className="text-muted-foreground">value:</span> {shieldedNote.value} XRGE</div>
                            </div>
                            <div className="flex gap-2">
                                <button
                                    onClick={() => {
                                        navigator.clipboard.writeText(JSON.stringify(shieldedNote, null, 2));
                                        setNoteCopied(true);
                                        setTimeout(() => setNoteCopied(false), 2000);
                                    }}
                                    className="flex-1 py-2 rounded-lg bg-secondary text-secondary-foreground text-xs font-medium hover:bg-secondary/80 transition-colors"
                                >
                                    {noteCopied ? "Copied!" : "Copy Note"}
                                </button>
                                <button
                                    onClick={() => { setShowShield(false); setShieldedNote(null); refreshData(); }}
                                    className="flex-1 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
                                >
                                    Done
                                </button>
                            </div>
                        </div>
                    ) : (
                        /* Input form */
                        <>
                            <p className="text-[10px] text-muted-foreground">Convert public XRGE to a private shielded note</p>
                            <div className="flex gap-2">
                                <input
                                    type="number"
                                    placeholder="Amount (whole XRGE)"
                                    value={shieldAmount}
                                    onChange={e => setShieldAmount(e.target.value)}
                                    min="1"
                                    step="1"
                                    className="flex-1 px-3 py-2 rounded-lg bg-input border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                                />
                                <button
                                    onClick={() => setShieldAmount(Math.max(0, Math.floor(xrgeBalance - 1)).toString())}
                                    className="px-2 py-2 rounded-lg bg-secondary text-xs text-foreground hover:bg-secondary/80 transition-colors"
                                >
                                    Max
                                </button>
                            </div>
                            <div className="text-[10px] text-muted-foreground flex justify-between">
                                <span>Available: {xrgeBalance.toLocaleString()} {TOKEN_SYMBOL}</span>
                                <span>Fee: 1 XRGE</span>
                            </div>
                            <button
                                onClick={async () => {
                                    const amt = parseInt(shieldAmount);
                                    if (!amt || amt <= 0) return;
                                    if (amt + 1 > xrgeBalance) return;
                                    setIsShielding(true);
                                    try {
                                        const note = await createShieldedNote(amt, wallet.signingPublicKey);
                                        // Submit shield tx
                                        const { sendTransaction: sendTx } = await import("../../lib/pqc-wallet");
                                        const { getCoreApiBaseUrl, getCoreApiHeaders } = await import("../../lib/network");
                                        const baseUrl = getCoreApiBaseUrl();
                                        const { ml_dsa65 } = await import("@noble/post-quantum/ml-dsa.js");

                                        // Build, sign, submit
                                        const payload = {
                                            type: "shield",
                                            from: wallet.signingPublicKey,
                                            amount: amt,
                                            commitment: note.commitment,
                                            timestamp: Date.now(),
                                            nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
                                        };
                                        const payloadBytes = new TextEncoder().encode(JSON.stringify(sortKeysDeep(payload)));
                                        const sig = ml_dsa65.sign(payloadBytes, hexToBytes(wallet.signingPrivateKey));
                                        const sigHex = bytesToHex(sig);

                                        const sorted = sortKeysDeep(payload);
                                        const res = await fetch(`${baseUrl}/v2/shielded/shield`, {
                                            method: "POST",
                                            headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
                                            body: JSON.stringify({ payload: sorted, signature: sigHex, public_key: wallet.signingPublicKey }),
                                        });
                                        const data = await res.json();
                                        if (!data.success) throw new Error(data.error || "Shield failed");

                                        // Auto-save note
                                        saveNote(note);
                                        setShieldedNote(note);
                                        setShieldAmount("");
                                        setSavedNotes(getActiveNotes(wallet.signingPublicKey));
                                    } catch (err) {
                                        console.error("Shield failed:", err);
                                        showToast(err instanceof Error ? err.message : String(err));
                                    }
                                    setIsShielding(false);
                                }}
                                disabled={isShielding || !shieldAmount || parseInt(shieldAmount) <= 0}
                                className="w-full py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
                            >
                                {isShielding ? "Shielding..." : `Shield ${TOKEN_SYMBOL}`}
                            </button>
                        </>
                    )}
                </div>
            )}

            {/* Unshield form */}
            {showUnshield && (
                <div className="p-3 border-b border-border bg-card/80 space-y-2">
                    <p className="text-[10px] text-muted-foreground">Unshield notes back to public XRGE balance</p>
                    {savedNotes.length === 0 ? (
                        <p className="text-xs text-muted-foreground py-4 text-center">No shielded notes found</p>
                    ) : (
                        <div className="space-y-2 max-h-40 overflow-y-auto">
                            {savedNotes.map(note => (
                                <div key={note.nullifier} className="p-2 rounded-lg bg-muted/50 border border-border">
                                    <div className="flex items-center justify-between">
                                        <span className="text-sm font-bold text-primary">{note.value} XRGE</span>
                                        <button
                                            onClick={async () => {
                                                setUnshieldingNote(note.nullifier);
                                                try {
                                                    const { getCoreApiBaseUrl, getCoreApiHeaders } = await import("../../lib/network");
                                                    const baseUrl = getCoreApiBaseUrl();
                                                    const { ml_dsa65 } = await import("@noble/post-quantum/ml-dsa.js");
                                                    const payload = {
                                                        type: "unshield",
                                                        from: wallet.signingPublicKey,
                                                        nullifiers: [note.nullifier],
                                                        amount: note.value,
                                                        proof: note.randomness,
                                                        timestamp: Date.now(),
                                                        nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
                                                    };
                                                    const payloadBytes = new TextEncoder().encode(JSON.stringify(sortKeysDeep(payload)));
                                                    const sig = ml_dsa65.sign(payloadBytes, hexToBytes(wallet.signingPrivateKey));
                                                    const sigHex = bytesToHex(sig);
                                                    const sorted = sortKeysDeep(payload);
                                                    const res = await fetch(`${baseUrl}/v2/shielded/unshield`, {
                                                        method: "POST",
                                                        headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
                                                        body: JSON.stringify({ payload: sorted, signature: sigHex, public_key: wallet.signingPublicKey }),
                                                    });
                                                    const data = await res.json();
                                                    if (!data.success) throw new Error(data.error || "Unshield failed");
                                                    markNoteSpent(note.nullifier);
                                                    setSavedNotes(getActiveNotes(wallet.signingPublicKey));
                                                    refreshData();
                                                } catch (err) {
                                                    showToast(err instanceof Error ? err.message : String(err));
                                                }
                                                setUnshieldingNote(null);
                                            }}
                                            disabled={!!unshieldingNote}
                                            className="px-3 py-1 rounded-lg bg-accent text-accent-foreground text-[10px] font-medium hover:bg-accent/90 disabled:opacity-50 transition-colors"
                                        >
                                            {unshieldingNote === note.nullifier ? "..." : "Unshield"}
                                        </button>
                                    </div>
                                    <p className="text-[9px] text-muted-foreground font-mono mt-1 truncate">C: {note.commitment.slice(0,16)}…</p>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Token balances */}
            {balances.length > 1 && (
                <div className="px-3 py-2 border-b border-border">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Tokens</p>
                    {balances.filter(b => b.symbol !== TOKEN_SYMBOL).map(b => (
                        <div key={b.symbol} className="flex items-center justify-between py-1">
                            <span className="text-xs text-foreground">{b.icon} {b.symbol}</span>
                            <span className="text-xs text-foreground font-mono">{b.balance.toLocaleString()}</span>
                        </div>
                    ))}
                </div>
            )}

            {/* Transactions */}
            <div className="flex-1 overflow-y-auto">
                <div className="px-3 py-2">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Recent Activity</p>
                    {transactions.length === 0 ? (
                        <div className="text-center py-8 text-muted-foreground">
                            <ArrowDownUp className="w-8 h-8 mx-auto mb-2 opacity-30" />
                            <p className="text-xs">No transactions yet</p>
                        </div>
                    ) : (
                        <div className="space-y-1">
                            {transactions.map(tx => (
                                <div
                                    key={tx.id}
                                    className="flex items-center justify-between py-2 px-2 rounded-lg hover:bg-secondary/30 card-hover transition-all cursor-default"
                                >
                                    <div className="flex items-center gap-2 min-w-0">
                                        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] ${tx.type === "receive"
                                            ? "bg-success/20 text-success"
                                            : "bg-destructive/20 text-destructive"
                                            }`}>
                                            {tx.type === "receive" ? <TrendingUp className="w-3 h-3" /> : <Send className="w-3 h-3" />}
                                        </div>
                                        <div className="min-w-0">
                                            <p className="text-xs text-foreground capitalize">{tx.type}</p>
                                            <p className="text-[10px] text-muted-foreground font-mono truncate">
                                                {formatIdentity(tx.address || "")}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="text-right flex-shrink-0">
                                        <p className={`text-xs font-mono ${tx.type === "receive" ? "text-success" : "text-foreground"
                                            }`}>
                                            {tx.type === "receive" ? "+" : "-"}{tx.amount} {tx.symbol}
                                        </p>
                                        <p className="text-[10px] text-muted-foreground">{tx.timeLabel}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
