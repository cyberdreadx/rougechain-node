import { useState } from "react";
import { Lock, LogOut, Globe, Clock, Download, Shield, ExternalLink, KeyRound, Copy, Check, Eye, EyeOff } from "lucide-react";
import type { UnifiedWallet } from "../../lib/unified-wallet";
import {
    lockUnifiedWallet,
    clearUnifiedWallet,
    getVaultSettings,
    saveVaultSettings,
} from "../../lib/unified-wallet";
import {
    getCustomNodeUrl,
    setCustomNodeUrl,
    getActiveNetwork,
    setActiveNetwork,
    type NetworkType,
} from "../../lib/network";

interface Props {
    wallet: UnifiedWallet;
    onLock: () => void;
    onDisconnect: () => void;
}

export default function SettingsTab({ wallet, onLock, onDisconnect }: Props) {
    const [lockPassword, setLockPassword] = useState("");
    const [nodeUrl, setNodeUrl] = useState(getCustomNodeUrl());
    const [network, setNetwork] = useState<NetworkType>(getActiveNetwork());
    const [autoLock, setAutoLock] = useState(getVaultSettings().autoLockMinutes);
    const [showExport, setShowExport] = useState(false);
    const [showSeedPhrase, setShowSeedPhrase] = useState(false);
    const [seedCopied, setSeedCopied] = useState(false);

    const handleLock = async () => {
        if (!lockPassword) return;
        try {
            await lockUnifiedWallet(lockPassword);
            setLockPassword("");
            onLock();
        } catch (err) {
            console.error("Lock failed:", err);
        }
    };

    const handleDisconnect = () => {
        if (confirm("This will permanently delete your wallet from this extension. Make sure you have a backup!")) {
            clearUnifiedWallet();
            onDisconnect();
        }
    };

    const handleSaveNode = () => {
        setCustomNodeUrl(nodeUrl);
        setActiveNetwork(network);
    };

    const handleAutoLock = (minutes: number) => {
        setAutoLock(minutes);
        saveVaultSettings({ autoLockMinutes: minutes });
    };

    const exportWallet = () => {
        const data = JSON.stringify(wallet, null, 2);
        const blob = new Blob([data], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `rougechain-wallet-${wallet.displayName}.json`;
        a.click();
        URL.revokeObjectURL(url);
    };

    return (
        <div className="flex flex-col h-full overflow-y-auto">
            {/* Wallet info */}
            <div className="p-3 border-b border-border">
                <div className="flex items-center gap-2 mb-2">
                    <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
                        <Shield className="w-4 h-4 text-primary" />
                    </div>
                    <div className="min-w-0">
                        <p className="text-xs font-medium text-foreground">{wallet.displayName}</p>
                        <p className="text-[10px] text-muted-foreground font-mono truncate">
                            {wallet.signingPublicKey.substring(0, 20)}...
                        </p>
                    </div>
                </div>
            </div>

            {/* Lock wallet */}
            <div className="p-3 border-b border-border">
                <div className="flex items-center gap-2 mb-2">
                    <Lock className="w-3.5 h-3.5 text-primary" />
                    <span className="text-xs font-medium text-foreground">Lock Wallet</span>
                </div>
                <div className="flex gap-2">
                    <input
                        type="password"
                        placeholder="Set password"
                        value={lockPassword}
                        onChange={e => setLockPassword(e.target.value)}
                        className="flex-1 px-3 py-1.5 rounded-lg bg-input border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    <button
                        onClick={handleLock}
                        disabled={!lockPassword}
                        className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
                    >
                        Lock
                    </button>
                </div>
            </div>

            {/* Auto-lock timer */}
            <div className="p-3 border-b border-border">
                <div className="flex items-center gap-2 mb-2">
                    <Clock className="w-3.5 h-3.5 text-primary" />
                    <span className="text-xs font-medium text-foreground">Auto-Lock</span>
                </div>
                <div className="flex gap-1">
                    {[1, 5, 15, 30].map(mins => (
                        <button
                            key={mins}
                            onClick={() => handleAutoLock(mins)}
                            className={`flex-1 py-1.5 rounded-lg text-[10px] font-medium transition-colors ${autoLock === mins
                                    ? "bg-primary text-primary-foreground"
                                    : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
                                }`}
                        >
                            {mins}m
                        </button>
                    ))}
                </div>
            </div>

            {/* Node configuration */}
            <div className="p-3 border-b border-border">
                <div className="flex items-center gap-2 mb-2">
                    <Globe className="w-3.5 h-3.5 text-primary" />
                    <span className="text-xs font-medium text-foreground">Node</span>
                </div>
                <input
                    type="text"
                    placeholder="Custom node URL (optional)"
                    value={nodeUrl}
                    onChange={e => setNodeUrl(e.target.value)}
                    className="w-full px-3 py-1.5 rounded-lg bg-input border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary mb-2"
                />
                <div className="flex gap-2">
                    <button
                        onClick={() => { setNetwork("testnet"); handleSaveNode(); }}
                        className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${network === "testnet"
                                ? "bg-warning/20 text-warning"
                                : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
                            }`}
                    >
                        Testnet
                    </button>
                    <button
                        onClick={() => { setNetwork("mainnet"); handleSaveNode(); }}
                        className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${network === "mainnet"
                                ? "bg-success/20 text-success"
                                : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
                            }`}
                    >
                        Mainnet
                    </button>
                </div>
            </div>

            {/* Backup */}
            <div className="p-3 border-b border-border space-y-2">
                <div className="flex items-center gap-2">
                    <Download className="w-3.5 h-3.5 text-primary" />
                    <span className="text-xs font-medium text-foreground">Backup</span>
                </div>

                {wallet.mnemonic ? (
                    <div className="space-y-2">
                        <button
                            onClick={() => setShowSeedPhrase(!showSeedPhrase)}
                            className="w-full py-1.5 rounded-lg bg-secondary text-secondary-foreground text-xs font-medium hover:bg-secondary/80 transition-colors flex items-center justify-center gap-1.5"
                        >
                            {showSeedPhrase ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                            {showSeedPhrase ? "Hide Seed Phrase" : "View Seed Phrase"}
                        </button>

                        {showSeedPhrase && (
                            <div className="space-y-2">
                                <div className="grid grid-cols-3 gap-1">
                                    {wallet.mnemonic.split(" ").map((word, i) => (
                                        <div key={i} className="flex items-center gap-1 px-1.5 py-1 rounded bg-muted/50 border border-border">
                                            <span className="text-[8px] text-muted-foreground w-3 text-right">{i + 1}.</span>
                                            <span className="text-[10px] font-mono text-foreground">{word}</span>
                                        </div>
                                    ))}
                                </div>
                                <button
                                    onClick={async () => {
                                        if (wallet.mnemonic) {
                                            await navigator.clipboard.writeText(wallet.mnemonic);
                                            setSeedCopied(true);
                                            setTimeout(() => setSeedCopied(false), 2000);
                                        }
                                    }}
                                    className="w-full py-1.5 rounded-lg bg-muted text-muted-foreground text-[10px] font-medium hover:bg-muted/80 transition-colors flex items-center justify-center gap-1"
                                >
                                    {seedCopied ? <><Check className="w-3 h-3" /> Copied!</> : <><Copy className="w-3 h-3" /> Copy Phrase</>}
                                </button>
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="p-2 rounded-lg bg-muted/30 border border-border">
                        <p className="text-[10px] text-muted-foreground">
                            <KeyRound className="w-3 h-3 inline mr-1" />
                            No seed phrase — this wallet was created before mnemonic support. Use the encrypted backup below.
                        </p>
                    </div>
                )}

                <button
                    onClick={exportWallet}
                    className="w-full py-1.5 rounded-lg bg-secondary text-secondary-foreground text-xs font-medium hover:bg-secondary/80 transition-colors flex items-center justify-center gap-1.5"
                >
                    <Download className="w-3 h-3" /> Export Wallet JSON
                </button>
            </div>

            {/* Open Web App */}
            <div className="p-3 border-b border-border">
                <a
                    href="https://rougechain.io"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-full py-1.5 rounded-lg bg-secondary text-secondary-foreground text-xs font-medium hover:bg-secondary/80 transition-colors flex items-center justify-center gap-1.5"
                >
                    <ExternalLink className="w-3 h-3" /> Open Full Web App
                </a>
            </div>

            {/* Disconnect */}
            <div className="p-3">
                <button
                    onClick={handleDisconnect}
                    className="w-full py-2 rounded-lg bg-destructive/20 text-destructive text-xs font-medium hover:bg-destructive/30 transition-colors flex items-center justify-center gap-1.5"
                >
                    <LogOut className="w-3.5 h-3.5" /> Disconnect Wallet
                </button>
            </div>
        </div>
    );
}
