import { useState } from "react";
import { Loader2, Plus, Upload } from "lucide-react";
import { generateKeypair } from "../../lib/pqc-blockchain";
import { generateEncryptionKeypair, registerWalletOnNode } from "../../lib/pqc-messenger";
import { saveUnifiedWallet, type UnifiedWallet } from "../../lib/unified-wallet";

interface Props {
    onCreated: (wallet: UnifiedWallet) => void;
}

export default function CreateWalletScreen({ onCreated }: Props) {
    const [name, setName] = useState("");
    const [isCreating, setIsCreating] = useState(false);
    const [showImport, setShowImport] = useState(false);

    const handleCreate = async () => {
        if (!name.trim() || isCreating) return;
        setIsCreating(true);

        try {
            const { keypair } = await generateKeypair();
            const encKeypair = generateEncryptionKeypair();
            const id = crypto.randomUUID();

            const wallet: UnifiedWallet = {
                id,
                displayName: name.trim(),
                createdAt: Date.now(),
                signingPublicKey: keypair.publicKey,
                signingPrivateKey: keypair.privateKey,
                encryptionPublicKey: encKeypair.publicKey,
                encryptionPrivateKey: encKeypair.privateKey,
                version: 2,
            };

            saveUnifiedWallet(wallet);

            // Register on node
            try {
                await registerWalletOnNode({
                    id: wallet.id,
                    displayName: wallet.displayName,
                    signingPublicKey: wallet.signingPublicKey,
                    encryptionPublicKey: wallet.encryptionPublicKey,
                });
            } catch { /* Node may be unavailable — that's okay */ }

            onCreated(wallet);
        } catch (err) {
            console.error("Wallet creation failed:", err);
        }
        setIsCreating(false);
    };

    const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
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

                <label className="w-full py-2.5 rounded-xl bg-secondary text-secondary-foreground text-sm font-medium hover:bg-secondary/80 transition-colors flex items-center justify-center gap-2 cursor-pointer">
                    <Upload className="w-4 h-4" /> Import Wallet
                    <input type="file" accept=".json" onChange={handleImport} className="hidden" />
                </label>
            </div>

            <p className="text-[10px] text-muted-foreground text-center mt-6 max-w-xs">
                Your private keys never leave this device.
                NIST-approved post-quantum cryptography (FIPS 203 & 204).
            </p>
        </div>
    );
}
