import { useState } from "react";
import { motion } from "framer-motion";
import { Shield, Key, Lock, Fingerprint, ArrowRight, Loader2, Upload, FileKey2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { WalletWithPrivateKeys } from "@/lib/pqc-messenger";
import { createWallet } from "@/lib/pqc-messenger";
import type { UnifiedWallet } from "@/lib/unified-wallet";
import { decryptWallet } from "@/lib/unified-wallet";

interface WalletSetupProps {
  onWalletCreated: (wallet: WalletWithPrivateKeys) => void;
  onWalletImported?: (wallet: UnifiedWallet) => void;
}

const WalletSetup = ({ onWalletCreated, onWalletImported }: WalletSetupProps) => {
  const [displayName, setDisplayName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [stage, setStage] = useState<"input" | "generating">("input");
  const [showImport, setShowImport] = useState(false);
  const [importData, setImportData] = useState("");
  const [importPassword, setImportPassword] = useState("");
  const [isImporting, setIsImporting] = useState(false);

  const handleCreate = async () => {
    if (!displayName.trim()) return;

    setIsCreating(true);
    setStage("generating");

    try {
      const wallet = await createWallet(displayName.trim());
      onWalletCreated(wallet);
    } catch (error) {
      console.error("Failed to create wallet:", error);
      setStage("input");
    } finally {
      setIsCreating(false);
    }
  };

  const handleImport = async () => {
    if (!importData.trim() || !importPassword) return;
    setIsImporting(true);
    try {
      const wallet = await decryptWallet(importData.trim(), importPassword);
      onWalletImported?.(wallet);
    } catch (error) {
      console.error("Failed to import wallet:", error);
    } finally {
      setIsImporting(false);
    }
  };

  const handleImportFile = async (file: File) => {
    try {
      const text = await file.text();
      setImportData(text);
    } catch (error) {
      console.error("Failed to read file:", error);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      {/* Background effects */}
      <div className="fixed inset-0 circuit-bg opacity-20 pointer-events-none" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl pointer-events-none" />

      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-md relative z-10"
      >
        <Card className="bg-card/80 backdrop-blur border-primary/20">
          <CardHeader className="text-center">
            <motion.div
              animate={stage === "generating" ? { rotate: 360 } : {}}
              transition={{ duration: 2, repeat: stage === "generating" ? Infinity : 0, ease: "linear" }}
              className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center"
            >
              {stage === "generating" ? (
                <Key className="w-8 h-8 text-primary-foreground" />
              ) : (
                <Shield className="w-8 h-8 text-primary-foreground" />
              )}
            </motion.div>
            <CardTitle className="text-2xl">
              {stage === "generating" ? "Generating Keypairs..." : "Create Your Wallet"}
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-2">
              {stage === "generating"
                ? "Creating quantum-safe cryptographic keys"
                : "Your wallet contains post-quantum keypairs for secure messaging"
              }
            </p>
          </CardHeader>

          <CardContent className="space-y-6">
            {stage === "input" ? (
              <>
                {/* Features */}
                <div className="space-y-3">
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                    <Lock className="w-5 h-5 text-primary" />
                    <div>
                      <p className="text-sm font-medium">ML-KEM-768 Encryption</p>
                      <p className="text-xs text-muted-foreground">Quantum-safe key encapsulation</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                    <Fingerprint className="w-5 h-5 text-primary" />
                    <div>
                      <p className="text-sm font-medium">ML-DSA-65 Signatures</p>
                      <p className="text-xs text-muted-foreground">Verify message authenticity</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                    <Key className="w-5 h-5 text-primary" />
                    <div>
                      <p className="text-sm font-medium">Local Private Keys</p>
                      <p className="text-xs text-muted-foreground">Keys never leave your device</p>
                    </div>
                  </div>
                </div>

                {/* Name input */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">Display Name</label>
                  <Input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Enter your name..."
                    className="h-12"
                    onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                  />
                </div>

                {/* Create button */}
                <Button
                  onClick={handleCreate}
                  disabled={!displayName.trim() || isCreating}
                  className="w-full h-12"
                >
                  Create Wallet
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Button>

                {/* Import toggle */}
                <Button
                  variant="outline"
                  className="w-full h-12"
                  onClick={() => setShowImport((prev) => !prev)}
                >
                  <Upload className="w-4 h-4 mr-2" />
                  {showImport ? "Hide Import" : "Import Existing Wallet"}
                </Button>

                {showImport && (
                  <div className="space-y-3 p-3 rounded-lg border border-border bg-muted/30">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <FileKey2 className="w-4 h-4 text-primary" />
                      Import Wallet Backup
                    </div>
                    <Input
                      type="file"
                      accept=".pqcbackup,.txt"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void handleImportFile(file);
                      }}
                    />
                    <Textarea
                      value={importData}
                      onChange={(e) => setImportData(e.target.value)}
                      placeholder="Paste your backup data here..."
                      className="min-h-[120px] font-mono text-xs"
                    />
                    <Input
                      type="password"
                      value={importPassword}
                      onChange={(e) => setImportPassword(e.target.value)}
                      placeholder="Backup password"
                    />
                    <Button
                      onClick={handleImport}
                      disabled={!importData.trim() || !importPassword || isImporting}
                      className="w-full"
                    >
                      {isImporting ? "Importing..." : "Import Wallet"}
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <div className="py-8 space-y-6">
                {/* Generation stages */}
                <div className="space-y-3">
                  <motion.div
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="flex items-center gap-3"
                  >
                    <Loader2 className="w-4 h-4 animate-spin text-primary" />
                    <span className="text-sm">Generating ML-DSA-65 signing keypair...</span>
                  </motion.div>
                  <motion.div
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.3 }}
                    className="flex items-center gap-3"
                  >
                    <Loader2 className="w-4 h-4 animate-spin text-primary" />
                    <span className="text-sm">Generating ML-KEM-768 encryption keypair...</span>
                  </motion.div>
                  <motion.div
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.6 }}
                    className="flex items-center gap-3"
                  >
                    <Loader2 className="w-4 h-4 animate-spin text-primary" />
                    <span className="text-sm">Registering public keys...</span>
                  </motion.div>
                </div>

                <p className="text-xs text-center text-muted-foreground">
                  This may take a few seconds...
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
};

export default WalletSetup;
