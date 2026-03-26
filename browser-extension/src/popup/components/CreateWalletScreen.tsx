import { useState } from "react";
import { Loader2, Plus, Upload, KeyRound, Copy, Check, AlertTriangle, ArrowLeft } from "lucide-react";
import { generateEncryptionKeypair, registerWalletOnNode } from "../../lib/pqc-messenger";
import { saveUnifiedWallet, type UnifiedWallet } from "../../lib/unified-wallet";
import { generateMnemonic, keypairFromMnemonic, validateMnemonic } from "../../lib/mnemonic";

interface Props {
    onCreated: (wallet: UnifiedWallet) => void;
}

type Screen = "home" | "show-seed" | "import-seed";

export default function CreateWalletScreen({ onCreated }: Props) {
    const [name, setName] = useState("");
    const [isCreating, setIsCreating] = useState(false);
    const [screen, setScreen] = useState<Screen>("home");
    const [mnemonic, setMnemonic] = useState("");
    const [pendingWallet, setPendingWallet] = useState<UnifiedWallet | null>(null);
    const [seedCopied, setSeedCopied] = useState(false);
    const [seedConfirmed, setSeedConfirmed] = useState(false);

    // Seed phrase import state
    const [importPhrase, setImportPhrase] = useState("");
    const [importName, setImportName] = useState("");
    const [importError, setImportError] = useState("");
    const [isRecovering, setIsRecovering] = useState(false);

    const handleCreate = async () => {
        if (!name.trim() || isCreating) return;
        setIsCreating(true);

        try {
            const phrase = generateMnemonic();
            const { publicKey: signingPublicKey, secretKey: signingPrivateKey } = keypairFromMnemonic(phrase);
            const encKeypair = generateEncryptionKeypair();
            const id = crypto.randomUUID();

            const wallet: UnifiedWallet = {
                id,
                displayName: name.trim(),
                createdAt: Date.now(),
                signingPublicKey,
                signingPrivateKey,
                encryptionPublicKey: encKeypair.publicKey,
                encryptionPrivateKey: encKeypair.privateKey,
                version: 3,
                mnemonic: phrase,
            };

            setMnemonic(phrase);
            setPendingWallet(wallet);
            setScreen("show-seed");
        } catch (err) {
            console.error("Wallet creation failed:", err);
        }
        setIsCreating(false);
    };

    const handleConfirmSeed = async () => {
        if (!pendingWallet) return;

        saveUnifiedWallet(pendingWallet);

        try {
            await registerWalletOnNode({
                id: pendingWallet.id,
                displayName: pendingWallet.displayName,
                signingPublicKey: pendingWallet.signingPublicKey,
                encryptionPublicKey: pendingWallet.encryptionPublicKey,
            });
        } catch { /* Node may be unavailable */ }

        onCreated(pendingWallet);
    };

    const handleCopySeed = async () => {
        await navigator.clipboard.writeText(mnemonic);
        setSeedCopied(true);
        setTimeout(() => setSeedCopied(false), 2000);
    };

    const handleImportSeed = async () => {
        const trimmed = importPhrase.trim().toLowerCase().replace(/\s+/g, " ");
        if (!importName.trim()) {
            setImportError("Enter a wallet name");
            return;
        }
        if (!validateMnemonic(trimmed)) {
            setImportError("Invalid seed phrase — check for typos");
            return;
        }

        setIsRecovering(true);
        setImportError("");

        try {
            const { publicKey: signingPublicKey, secretKey: signingPrivateKey } = keypairFromMnemonic(trimmed);
            const encKeypair = generateEncryptionKeypair();

            const wallet: UnifiedWallet = {
                id: crypto.randomUUID(),
                displayName: importName.trim(),
                createdAt: Date.now(),
                signingPublicKey,
                signingPrivateKey,
                encryptionPublicKey: encKeypair.publicKey,
                encryptionPrivateKey: encKeypair.privateKey,
                version: 3,
                mnemonic: trimmed,
            };

            saveUnifiedWallet(wallet);

            try {
                await registerWalletOnNode({
                    id: wallet.id,
                    displayName: wallet.displayName,
                    signingPublicKey: wallet.signingPublicKey,
                    encryptionPublicKey: wallet.encryptionPublicKey,
                });
            } catch { /* Node may be unavailable */ }

            onCreated(wallet);
        } catch (err) {
            console.error("Recovery failed:", err);
            setImportError("Recovery failed — try again");
        }
        setIsRecovering(false);
    };

    const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            const text = await file.text();
            const wallet = JSON.parse(text) as UnifiedWallet;
            if (!wallet.signingPublicKey || !wallet.signingPrivateKey) {
                alert("Invalid wallet file");
                return;
            }
            saveUnifiedWallet(wallet);
            onCreated(wallet);
        } catch {
            alert("Failed to import wallet");
        }
    };

    // Show seed phrase screen
    if (screen === "show-seed" && pendingWallet) {
        const words = mnemonic.split(" ");
        return (
            <div className="flex flex-col h-full p-4 bg-background overflow-y-auto">
                <div className="flex items-center gap-2 mb-4">
                    <button onClick={() => setScreen("home")} className="p-1 rounded hover:bg-muted">
                        <ArrowLeft className="w-4 h-4" />
                    </button>
                    <h2 className="text-sm font-bold">Recovery Phrase</h2>
                </div>

                <div className="p-2.5 rounded-lg bg-destructive/10 border border-destructive/30 mb-3">
                    <div className="flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                        <p className="text-[11px] text-muted-foreground leading-relaxed">
                            Write these words down and store them safely. <span className="text-destructive font-medium">Never share them.</span> Anyone with this phrase can access your wallet.
                        </p>
                    </div>
                </div>

                <div className="grid grid-cols-3 gap-1.5 mb-3">
                    {words.map((word, i) => (
                        <div key={i} className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-muted/50 border border-border">
                            <span className="text-[9px] text-muted-foreground w-4 text-right">{i + 1}.</span>
                            <span className="text-[11px] font-mono text-foreground">{word}</span>
                        </div>
                    ))}
                </div>

                <button
                    onClick={handleCopySeed}
                    className="w-full py-2 rounded-lg bg-secondary text-secondary-foreground text-xs font-medium hover:bg-secondary/80 transition-colors flex items-center justify-center gap-1.5 mb-3"
                >
                    {seedCopied ? <><Check className="w-3.5 h-3.5" /> Copied!</> : <><Copy className="w-3.5 h-3.5" /> Copy to Clipboard</>}
                </button>

                <label className="flex items-center gap-2 mb-3 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={seedConfirmed}
                        onChange={e => setSeedConfirmed(e.target.checked)}
                        className="rounded border-border"
                    />
                    <span className="text-[11px] text-muted-foreground">I've saved my recovery phrase</span>
                </label>

                <button
                    onClick={handleConfirmSeed}
                    disabled={!seedConfirmed}
                    className="w-full py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
                >
                    Continue
                </button>

                <p className="text-[10px] text-muted-foreground text-center mt-3">
                    BIP-39 → HKDF-SHA256 → ML-DSA-65 derivation
                </p>
            </div>
        );
    }

    // Seed phrase import screen
    if (screen === "import-seed") {
        return (
            <div className="flex flex-col h-full p-4 bg-background overflow-y-auto">
                <div className="flex items-center gap-2 mb-4">
                    <button onClick={() => { setScreen("home"); setImportError(""); }} className="p-1 rounded hover:bg-muted">
                        <ArrowLeft className="w-4 h-4" />
                    </button>
                    <h2 className="text-sm font-bold">Import from Seed Phrase</h2>
                </div>

                <input
                    type="text"
                    placeholder="Wallet name"
                    value={importName}
                    onChange={e => setImportName(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-input border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 mb-2"
                />

                <textarea
                    placeholder="Enter your 24-word recovery phrase..."
                    value={importPhrase}
                    onChange={e => { setImportPhrase(e.target.value); setImportError(""); }}
                    rows={4}
                    className="w-full px-3 py-2 rounded-lg bg-input border border-border text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 mb-2 resize-none"
                />

                {importError && (
                    <p className="text-xs text-destructive mb-2">{importError}</p>
                )}

                <button
                    onClick={handleImportSeed}
                    disabled={!importPhrase.trim() || !importName.trim() || isRecovering}
                    className="w-full py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
                >
                    {isRecovering ? (
                        <><Loader2 className="w-4 h-4 animate-spin" /> Recovering...</>
                    ) : (
                        <><KeyRound className="w-4 h-4" /> Recover Wallet</>
                    )}
                </button>

                <p className="text-[10px] text-muted-foreground text-center mt-3">
                    Same seed phrase always derives the same ML-DSA-65 keypair
                </p>
            </div>
        );
    }

    // Home screen
    return (
        <div className="flex flex-col items-center justify-center h-full p-6 bg-background">
            <div className="logo-ring w-16 h-16 mb-4">
                <img src="/xrge-logo.webp" alt="XRGE" />
            </div>

            <h1 className="text-lg font-bold text-gradient-quantum mb-1">RougeChain Wallet</h1>
            <p className="text-xs text-muted-foreground text-center mb-6">
                Quantum-safe cryptocurrency wallet<br />
                powered by ML-DSA-65 & ML-KEM-768
            </p>

            <div className="w-full max-w-xs space-y-3">
                <input
                    type="text"
                    placeholder="Wallet name (e.g. My Wallet)"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && handleCreate()}
                    className="w-full px-4 py-2.5 rounded-xl bg-input border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                />

                <button
                    onClick={handleCreate}
                    disabled={!name.trim() || isCreating}
                    className="w-full py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
                >
                    {isCreating ? (
                        <><Loader2 className="w-4 h-4 animate-spin" /> Generating keys...</>
                    ) : (
                        <><Plus className="w-4 h-4" /> Create Wallet</>
                    )}
                </button>

                <div className="relative flex items-center gap-2 py-2">
                    <div className="flex-1 h-px bg-border" />
                    <span className="text-[10px] text-muted-foreground">or</span>
                    <div className="flex-1 h-px bg-border" />
                </div>

                <button
                    onClick={() => setScreen("import-seed")}
                    className="w-full py-2.5 rounded-xl bg-secondary text-secondary-foreground text-sm font-medium hover:bg-secondary/80 transition-colors flex items-center justify-center gap-2"
                >
                    <KeyRound className="w-4 h-4" /> Import from Seed Phrase
                </button>

                <label className="w-full py-2.5 rounded-xl bg-muted text-muted-foreground text-sm font-medium hover:bg-muted/80 transition-colors flex items-center justify-center gap-2 cursor-pointer">
                    <Upload className="w-4 h-4" /> Import Backup File
                    <input type="file" accept=".json,.pqcbackup" onChange={handleImportFile} className="hidden" />
                </label>
            </div>

            <p className="text-[10px] text-muted-foreground text-center mt-6 max-w-xs">
                Your private keys never leave this device.
                NIST-approved post-quantum cryptography (FIPS 203 & 204).
            </p>
        </div>
    );
}
