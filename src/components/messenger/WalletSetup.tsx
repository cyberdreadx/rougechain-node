import { useState } from "react";
import { motion } from "framer-motion";
import { Shield, Key, Lock, Fingerprint, ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { WalletWithPrivateKeys } from "@/lib/pqc-messenger";
import { createWallet } from "@/lib/pqc-messenger";

interface WalletSetupProps {
  onWalletCreated: (wallet: WalletWithPrivateKeys) => void;
}

const WalletSetup = ({ onWalletCreated }: WalletSetupProps) => {
  const [displayName, setDisplayName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [stage, setStage] = useState<"input" | "generating">("input");

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

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      {/* Background effects */}
      <div className="fixed inset-0 circuit-bg opacity-20 pointer-events-none" />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl pointer-events-none" />

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
