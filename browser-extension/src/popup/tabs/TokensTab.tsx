import { useState, useEffect, useCallback } from "react";
import { Coins, Plus, RefreshCw, Check, Loader2 } from "lucide-react";
import type { UnifiedWallet } from "../../lib/unified-wallet";
import { getCoreApiBaseUrl, getCoreApiHeaders } from "../../lib/network";
import {
    getWalletBalance,
    getTokens,
    TOKEN_SYMBOL,
    type WalletBalance,
    type TokenMeta,
} from "../../lib/pqc-wallet";
import { invalidate } from "../../lib/api-cache";

interface Props {
    wallet: UnifiedWallet;
}

export default function TokensTab({ wallet }: Props) {
    const [balances, setBalances] = useState<WalletBalance[]>([]);
    const [allTokens, setAllTokens] = useState<TokenMeta[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [showCreate, setShowCreate] = useState(false);
    const [tokenName, setTokenName] = useState("");
    const [tokenSymbol, setTokenSymbol] = useState("");
    const [tokenSupply, setTokenSupply] = useState("");
    const [isCreating, setIsCreating] = useState(false);
    const [createResult, setCreateResult] = useState<string | null>(null);

    const refresh = useCallback(async (showSpinner = true) => {
        if (showSpinner) setIsLoading(true);
        try {
            const [bal, tokens] = await Promise.all([
                getWalletBalance(wallet.signingPublicKey),
                getTokens(),
            ]);
            setBalances(bal);
            setAllTokens(tokens);
        } catch (err) {
            console.error("TokensTab refresh:", err);
        }
        setIsLoading(false);
    }, [wallet.signingPublicKey]);

    useEffect(() => {
        refresh();
        const interval = setInterval(() => refresh(false), 15_000);
        return () => clearInterval(interval);
    }, [refresh]);

    const handleCreate = async () => {
        if (!tokenName || !tokenSymbol || !tokenSupply || isCreating) return;
        setIsCreating(true);
        setCreateResult(null);
        try {
            const baseUrl = getCoreApiBaseUrl();
            if (!baseUrl) throw new Error("No node configured");
            const res = await fetch(`${baseUrl}/token/create`, {
                method: "POST",
                headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
                body: JSON.stringify({
                    fromPrivateKey: wallet.signingPrivateKey,
                    fromPublicKey: wallet.signingPublicKey,
                    tokenName,
                    tokenSymbol: tokenSymbol.toUpperCase(),
                    initialSupply: parseInt(tokenSupply),
                }),
            });
            const data = await res.json();
            if (data.success) {
                invalidate("tokens");
                invalidate("balance");
                setCreateResult(`Created ${tokenSymbol.toUpperCase()}`);
                setTokenName("");
                setTokenSymbol("");
                setTokenSupply("");
                setShowCreate(false);
                setTimeout(() => { setCreateResult(null); refresh(); }, 2000);
            } else {
                setCreateResult(`Error: ${data.error || "Failed"}`);
            }
        } catch (err: any) {
            setCreateResult(`Error: ${err.message}`);
        }
        setIsCreating(false);
    };

    const myTokens = balances.filter(b => b.balance > 0);

    return (
        <div className="flex flex-col h-full overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                <span className="text-sm font-semibold text-foreground">Tokens</span>
                <div className="flex items-center gap-2">
                    <button onClick={() => setShowCreate(!showCreate)} className="text-primary hover:text-primary/80">
                        <Plus className="w-4 h-4" />
                    </button>
                    <button onClick={() => refresh()} className="text-muted-foreground hover:text-primary">
                        <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
                    </button>
                </div>
            </div>

            {createResult && (
                <div className={`px-4 py-2 text-xs ${createResult.startsWith("Error") ? "bg-destructive/10 text-destructive" : "bg-success/10 text-success"}`}>
                    {createResult}
                </div>
            )}

            {showCreate && (
                <div className="p-3 border-b border-border bg-card/80 space-y-2">
                    <p className="text-xs font-medium text-foreground">Create Token</p>
                    <input
                        placeholder="Token name (e.g. My Token)"
                        value={tokenName}
                        onChange={e => setTokenName(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg bg-input border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    <input
                        placeholder="Symbol (e.g. MTK)"
                        value={tokenSymbol}
                        onChange={e => setTokenSymbol(e.target.value.toUpperCase())}
                        maxLength={10}
                        className="w-full px-3 py-2 rounded-lg bg-input border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    <input
                        type="number"
                        placeholder="Total supply"
                        value={tokenSupply}
                        onChange={e => setTokenSupply(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg bg-input border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    <p className="text-[10px] text-muted-foreground">Fee: 10 XRGE</p>
                    <button
                        onClick={handleCreate}
                        disabled={!tokenName || !tokenSymbol || !tokenSupply || isCreating}
                        className="w-full py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
                    >
                        {isCreating ? <Loader2 className="w-3.5 h-3.5 animate-spin mx-auto" /> : "Create Token"}
                    </button>
                </div>
            )}

            <div className="flex-1 overflow-y-auto">
                <div className="px-3 py-2">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">Your Balances</p>
                    {myTokens.length === 0 ? (
                        <div className="text-center py-8 text-muted-foreground">
                            <Coins className="w-8 h-8 mx-auto mb-2 opacity-30" />
                            <p className="text-xs">No tokens yet</p>
                            <p className="text-[10px] mt-1">Use the faucet or create a token</p>
                        </div>
                    ) : (
                        <div className="space-y-1">
                            {myTokens.map(b => (
                                <div key={b.symbol} className="flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-secondary/30 transition-colors">
                                    <div className="flex items-center gap-2.5">
                                        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-sm">
                                            {b.icon}
                                        </div>
                                        <div>
                                            <p className="text-xs font-medium text-foreground">{b.symbol}</p>
                                            <p className="text-[10px] text-muted-foreground">{b.name}</p>
                                        </div>
                                    </div>
                                    <span className="text-xs font-mono text-foreground">
                                        {b.balance.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {allTokens.length > 0 && (
                    <div className="px-3 py-2 border-t border-border">
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">All Tokens on Chain</p>
                        <div className="space-y-1">
                            {allTokens.map(t => (
                                <div key={t.symbol} className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-secondary/30 transition-colors">
                                    <div>
                                        <p className="text-xs font-medium text-foreground">{t.symbol}</p>
                                        <p className="text-[10px] text-muted-foreground">{t.name}</p>
                                    </div>
                                    <p className="text-[10px] text-muted-foreground font-mono">
                                        {t.creator ? `${t.creator.slice(0, 6)}...` : ""}
                                    </p>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
