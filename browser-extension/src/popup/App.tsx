import { useState, useEffect } from "react";
import { Wallet, MessageCircle, Settings, Lock } from "lucide-react";
import { initStorage } from "../lib/storage";
import {
    loadUnifiedWallet,
    isWalletLocked,
    hasWallet,
    unlockUnifiedWallet,
    type UnifiedWallet,
} from "../lib/unified-wallet";
import WalletTab from "./tabs/WalletTab";
import MessengerTab from "./tabs/MessengerTab";
import SettingsTab from "./tabs/SettingsTab";
import UnlockScreen from "./components/UnlockScreen";
import CreateWalletScreen from "./components/CreateWalletScreen";

type Tab = "wallet" | "messenger" | "settings";

export default function App() {
    const [ready, setReady] = useState(false);
    const [activeTab, setActiveTab] = useState<Tab>("wallet");
    const [wallet, setWallet] = useState<UnifiedWallet | null>(null);
    const [locked, setLocked] = useState(false);

    useEffect(() => {
        (async () => {
            await initStorage();
            const w = loadUnifiedWallet();
            const isLocked = isWalletLocked();
            setWallet(w);
            setLocked(isLocked);
            setReady(true);
        })();
    }, []);

    if (!ready) {
        return (
            <div className="flex items-center justify-center h-full bg-background">
                <div className="text-center">
                    <img src="/xrge-logo.webp" alt="XRGE" className="w-12 h-12 mx-auto animate-pulse rounded-full" />
                    <p className="text-xs text-muted-foreground mt-3">Loading...</p>
                </div>
            </div>
        );
    }

    // No wallet exists — show create screen
    if (!wallet && !locked && !hasWallet()) {
        return (
            <CreateWalletScreen
                onCreated={(w) => {
                    setWallet(w);
                    setLocked(false);
                }}
            />
        );
    }

    // Wallet locked — show unlock screen
    if (locked || (!wallet && hasWallet())) {
        return (
            <UnlockScreen
                onUnlocked={(w) => {
                    setWallet(w);
                    setLocked(false);
                }}
            />
        );
    }

    const tabs: { id: Tab; label: string; icon: typeof Wallet }[] = [
        { id: "wallet", label: "Wallet", icon: Wallet },
        { id: "messenger", label: "Chat", icon: MessageCircle },
        { id: "settings", label: "Settings", icon: Settings },
    ];

    return (
        <div className="flex flex-col h-full bg-background">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-card/60 backdrop-blur-sm">
                <div className="flex items-center gap-2.5">
                    <img src="/xrge-logo.webp" alt="XRGE" className="w-7 h-7 rounded-full ring-1 ring-primary/30" />
                    <span className="text-sm font-bold text-gradient-quantum tracking-tight">RougeChain</span>
                </div>
                <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-success/10 border border-success/20">
                    <div className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
                    <span className="text-[10px] text-success font-medium">Devnet</span>
                </div>
            </div>

            {/* Tab content */}
            <div className="flex-1 overflow-hidden">
                {activeTab === "wallet" && wallet && <WalletTab wallet={wallet} onUpdate={setWallet} />}
                {activeTab === "messenger" && wallet && <MessengerTab wallet={wallet} />}
                {activeTab === "settings" && wallet && (
                    <SettingsTab
                        wallet={wallet}
                        onLock={() => { setLocked(true); setWallet(null); }}
                        onDisconnect={() => { setWallet(null); setLocked(false); }}
                    />
                )}
            </div>

            {/* Bottom tab bar */}
            <div className="flex items-center border-t border-border bg-card/80 backdrop-blur-sm">
                {tabs.map(({ id, label, icon: Icon }) => (
                    <button
                        key={id}
                        onClick={() => setActiveTab(id)}
                        className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 transition-all relative ${activeTab === id
                                ? "text-primary"
                                : "text-muted-foreground hover:text-foreground"
                            }`}
                    >
                        {activeTab === id && (
                            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 rounded-full bg-primary" />
                        )}
                        <Icon className="w-4 h-4" />
                        <span className="text-[10px] font-medium">{label}</span>
                    </button>
                ))}
            </div>
        </div>
    );
}
