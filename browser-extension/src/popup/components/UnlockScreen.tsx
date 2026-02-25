import { useState } from "react";
import { Lock, Shield, Loader2, Eye, EyeOff } from "lucide-react";
import { unlockUnifiedWallet, getLockedWalletMetadata, type UnifiedWallet } from "../../lib/unified-wallet";

interface Props {
    onUnlocked: (wallet: UnifiedWallet) => void;
}

export default function UnlockScreen({ onUnlocked }: Props) {
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [isUnlocking, setIsUnlocking] = useState(false);
    const [error, setError] = useState("");

    const metadata = getLockedWalletMetadata();

    const handleUnlock = async () => {
        if (!password) return;
        setIsUnlocking(true);
        setError("");

        try {
            const wallet = await unlockUnifiedWallet(password);
            onUnlocked(wallet);
        } catch {
            setError("Wrong password");
        }
        setIsUnlocking(false);
    };

    return (
        <div className="flex flex-col items-center justify-center h-full p-6 bg-background">
            <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-4 glow-quantum">
                <Lock className="w-8 h-8 text-primary" />
            </div>

            <h1 className="text-lg font-bold text-gradient-quantum mb-1">Vault Locked</h1>
            {metadata?.displayName && (
                <p className="text-xs text-muted-foreground mb-4">{metadata.displayName}</p>
            )}

            <div className="w-full max-w-xs space-y-3">
                <div className="relative">
                    <input
                        type={showPassword ? "text" : "password"}
                        placeholder="Enter password"
                        value={password}
                        onChange={e => { setPassword(e.target.value); setError(""); }}
                        onKeyDown={e => e.key === "Enter" && handleUnlock()}
                        className="w-full px-4 py-2.5 rounded-xl bg-input border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 pr-10"
                    />
                    <button
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                </div>

                {error && <p className="text-xs text-destructive text-center">{error}</p>}

                <button
                    onClick={handleUnlock}
                    disabled={!password || isUnlocking}
                    className="w-full py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
                >
                    {isUnlocking ? (
                        <><Loader2 className="w-4 h-4 animate-spin" /> Unlocking...</>
                    ) : (
                        <><Shield className="w-4 h-4" /> Unlock</>
                    )}
                </button>
            </div>
        </div>
    );
}
