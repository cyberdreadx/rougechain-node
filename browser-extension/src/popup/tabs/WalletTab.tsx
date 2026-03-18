import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Send, Download, Droplets, Copy, Check, TrendingUp, ArrowDownUp, Shield } from "lucide-react";
import type { UnifiedWallet } from "../../lib/unified-wallet";
import {
    getWalletBalance,
    getWalletTransactions,
    claimFaucet,
    truncateAddress,
    formatTimestamp,
    TOKEN_SYMBOL,
    getShieldedStats,
    createShieldedNote,
    type WalletBalance,
    type WalletTransaction,
    type ShieldedStats,
    type ShieldedNote,
} from "../../lib/pqc-wallet";

interface Props {
    wallet: UnifiedWallet;
    onUpdate: (w: UnifiedWallet) => void;
}

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

    const xrgeBalance = balances.find(b => b.symbol === TOKEN_SYMBOL)?.balance || 0;

    const copyAddress = () => {
        navigator.clipboard.writeText(wallet.signingPublicKey);
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
        } catch (err) {
            console.error("Send failed:", err);
        }
        setIsSending(false);
    };

    return (
        <div className="flex flex-col h-full overflow-hidden">
            {/* Balance card */}
            <div className="p-4 bg-gradient-to-br from-card to-secondary/30 border-b border-border">
                <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-muted-foreground">{wallet.displayName}</span>
                    <button onClick={() => refreshData()} className="text-muted-foreground hover:text-primary transition-colors">
                        <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
                    </button>
                </div>

                <div className="flex items-center gap-2.5 mb-2">
                    <img src="/xrge-logo.webp" alt="XRGE" className="w-9 h-9 rounded-full ring-2 ring-primary/30" />
                    <div className="flex items-baseline gap-2">
                        <span className="text-2xl font-bold text-foreground">
                            {xrgeBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                        </span>
                        <span className="text-sm text-primary font-medium">{TOKEN_SYMBOL}</span>
                    </div>
                </div>

                <button
                    onClick={copyAddress}
                    className="flex items-center gap-1 text-[10px] text-muted-foreground font-mono hover:text-foreground transition-colors"
                >
                    {truncateAddress(wallet.signingPublicKey)}
                    {copied ? <Check className="w-2.5 h-2.5 text-success" /> : <Copy className="w-2.5 h-2.5" />}
                </button>

                {/* Shielded note count */}
                {shieldedStats && shieldedStats.active_notes > 0 && (
                    <div className="flex items-center gap-1 mt-1">
                        <Shield className="w-2.5 h-2.5 text-primary" />
                        <span className="text-[10px] text-primary font-medium">
                            {shieldedStats.active_notes} shielded note{shieldedStats.active_notes !== 1 ? 's' : ''}
                        </span>
                    </div>
                )}

                {/* Action buttons */}
                <div className="flex gap-2 mt-3">
                    <button
                        onClick={() => setShowSend(!showSend)}
                        className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 active:scale-[0.97] transition-all"
                    >
                        <Send className="w-3.5 h-3.5" /> Send
                    </button>
                    <button
                        onClick={copyAddress}
                        className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl bg-secondary text-secondary-foreground text-xs font-semibold hover:bg-secondary/80 active:scale-[0.97] transition-all"
                    >
                        <Download className="w-3.5 h-3.5" /> Receive
                    </button>
                    <button
                        onClick={handleFaucet}
                        disabled={isClaiming}
                        className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl bg-accent/20 text-accent-foreground text-xs font-semibold hover:bg-accent/30 active:scale-[0.97] transition-all disabled:opacity-50"
                    >
                        <Droplets className={`w-3.5 h-3.5 ${isClaiming ? "animate-spin" : ""}`} /> Faucet
                    </button>
                    <button
                        onClick={() => { setShowShield(!showShield); setShieldedNote(null); }}
                        className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl bg-primary/10 text-primary text-xs font-semibold hover:bg-primary/20 active:scale-[0.97] transition-all"
                    >
                        <Shield className="w-3.5 h-3.5" /> Shield
                    </button>
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
                                            nonce: Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, "0")).join(""),
                                        };
                                        const sortKeysDeep = (obj: any): any => {
                                            if (Array.isArray(obj)) return obj.map(sortKeysDeep);
                                            if (obj && typeof obj === "object") {
                                                const sorted: any = {};
                                                for (const k of Object.keys(obj).sort()) sorted[k] = sortKeysDeep(obj[k]);
                                                return sorted;
                                            }
                                            return obj;
                                        };
                                        const payloadBytes = new TextEncoder().encode(JSON.stringify(sortKeysDeep(payload)));
                                        const privBytes = new Uint8Array(wallet.signingPrivateKey.length / 2);
                                        for (let i = 0; i < privBytes.length; i++) privBytes[i] = parseInt(wallet.signingPrivateKey.slice(i*2, i*2+2), 16);
                                        const sig = ml_dsa65.sign(payloadBytes, privBytes);
                                        const sigHex = Array.from(sig).map(b => b.toString(16).padStart(2, "0")).join("");

                                        const res = await fetch(`${baseUrl}/v2/shielded/shield`, {
                                            method: "POST",
                                            headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
                                            body: JSON.stringify({ payload, signature: sigHex, public_key: wallet.signingPublicKey }),
                                        });
                                        const data = await res.json();
                                        if (!data.success) throw new Error(data.error || "Shield failed");

                                        setShieldedNote(note);
                                        setShieldAmount("");
                                    } catch (err) {
                                        console.error("Shield failed:", err);
                                        alert(`Shield failed: ${err instanceof Error ? err.message : err}`);
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
                                                {truncateAddress(tx.address || "")}
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
