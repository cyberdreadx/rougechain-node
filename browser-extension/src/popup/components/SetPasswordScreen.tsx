import { useState } from "react";
import { Lock, Loader2, Eye, EyeOff, ShieldCheck, AlertTriangle } from "lucide-react";

interface Props {
    /** Heading, e.g. "Secure your wallet". */
    title: string;
    /** Short explanation shown under the heading. */
    subtitle: string;
    /** Button label, e.g. "Create Password". */
    submitLabel: string;
    onSubmit: (password: string) => Promise<void> | void;
    onBack?: () => void;
}

const MIN_LEN = 8;

/**
 * Collects and confirms a wallet password. Used at wallet creation/import (mandatory
 * encryption) and when migrating a legacy plaintext wallet to encrypted-at-rest.
 * The password never leaves the device; it derives the AES-256-GCM key (PBKDF2-600k)
 * that encrypts the vault. There is NO recovery — losing it means restoring from the
 * 24-word phrase — so the copy makes that explicit.
 */
export default function SetPasswordScreen({ title, subtitle, submitLabel, onSubmit, onBack }: Props) {
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [show, setShow] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const tooShort = password.length > 0 && password.length < MIN_LEN;
    const mismatch = confirm.length > 0 && confirm !== password;
    const canSubmit = password.length >= MIN_LEN && confirm === password && !busy;

    const handleSubmit = async () => {
        if (!canSubmit) return;
        setBusy(true);
        setError("");
        try {
            await onSubmit(password);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Failed to set password");
            setBusy(false);
        }
    };

    return (
        <div className="flex flex-col items-center justify-center h-full p-6 bg-background">
            <div className="logo-ring w-14 h-14 mb-3">
                <img src="/xrge-logo.webp" alt="XRGE" />
            </div>

            <h1 className="text-lg font-bold text-gradient-quantum mb-1">{title}</h1>
            <p className="text-xs text-muted-foreground text-center mb-4 max-w-xs">{subtitle}</p>

            <div className="w-full max-w-xs space-y-3">
                <div className="relative">
                    <input
                        type={show ? "text" : "password"}
                        placeholder={`Password (min ${MIN_LEN} characters)`}
                        value={password}
                        onChange={e => { setPassword(e.target.value); setError(""); }}
                        className="w-full px-4 py-2.5 rounded-xl bg-input border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 pr-10"
                    />
                    <button
                        onClick={() => setShow(!show)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                </div>

                <input
                    type={show ? "text" : "password"}
                    placeholder="Confirm password"
                    value={confirm}
                    onChange={e => { setConfirm(e.target.value); setError(""); }}
                    onKeyDown={e => e.key === "Enter" && handleSubmit()}
                    className="w-full px-4 py-2.5 rounded-xl bg-input border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                />

                {tooShort && <p className="text-[11px] text-destructive">Use at least {MIN_LEN} characters.</p>}
                {mismatch && <p className="text-[11px] text-destructive">Passwords don't match.</p>}
                {error && <p className="text-[11px] text-destructive">{error}</p>}

                <div className="p-2.5 rounded-lg bg-destructive/10 border border-destructive/30">
                    <div className="flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                        <p className="text-[11px] text-muted-foreground leading-relaxed">
                            There is <span className="text-destructive font-medium">no password recovery</span>. If you
                            forget it, restore your wallet from the 24-word recovery phrase.
                        </p>
                    </div>
                </div>

                <button
                    onClick={handleSubmit}
                    disabled={!canSubmit}
                    className="w-full py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
                >
                    {busy ? (
                        <><Loader2 className="w-4 h-4 animate-spin" /> Securing...</>
                    ) : (
                        <><ShieldCheck className="w-4 h-4" /> {submitLabel}</>
                    )}
                </button>

                {onBack && (
                    <button
                        onClick={onBack}
                        disabled={busy}
                        className="w-full py-2 rounded-xl text-muted-foreground text-xs hover:text-foreground transition-colors flex items-center justify-center gap-1.5"
                    >
                        <Lock className="w-3.5 h-3.5" /> Back
                    </button>
                )}
            </div>
        </div>
    );
}
