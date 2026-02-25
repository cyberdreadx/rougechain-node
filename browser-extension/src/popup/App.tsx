import { useState, useEffect } from "react";
import { Wallet, MessageCircle, Settings, Shield, Lock } from "lucide-react";
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
                    <Shield className="w-10 h-10 text-primary mx-auto animate-pulse" />
                    <p className="text-xs text-muted-foreground mt-2">Loading...</p>
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
            <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card/50">
                <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center">
                        <Shield className="w-3.5 h-3.5 text-primary" />
                    </div>
                    <span className="text-sm font-semibold text-gradient-quantum">RougeChain</span>
                </div>
                <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
                    <span className="text-[10px] text-muted-foreground">Devnet</span>
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
            <div className="flex items-center border-t border-border bg-card/80">
                {tabs.map(({ id, label, icon: Icon }) => (
                    <button
                        key={id}
                        onClick={() => setActiveTab(id)}
                        className={`flex-1 flex flex-col items-center gap-0.5 py-2 transition-colors ${activeTab === id
                                ? "text-primary"
                                : "text-muted-foreground hover:text-foreground"
                            }`}
                    >
                        <Icon className="w-4 h-4" />
                        <span className="text-[10px] font-medium">{label}</span>
                    </button>
                ))}
            </div>
        </div>
    );
}
