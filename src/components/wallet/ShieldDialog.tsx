import { useState } from "react";
import { motion } from "framer-motion";
import { X, Shield, Loader2, AlertCircle, CheckCircle2, Copy, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { secureShield } from "@/lib/secure-api";
import { createShieldedNote, type ShieldedNote } from "@/lib/shielded-crypto";
import { saveNote } from "@/lib/note-store";

interface ShieldDialogProps {
  wallet: {
    signingPublicKey: string;
    signingPrivateKey: string;
  };
  xrgeBalance: number;
  onClose: () => void;
  onSuccess: () => void;
}

const SHIELD_FEE = 1;

const ShieldDialog = ({ wallet, xrgeBalance, onClose, onSuccess }: ShieldDialogProps) => {
  const [amount, setAmount] = useState("");
  const [shielding, setShielding] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [resultNote, setResultNote] = useState<ShieldedNote | null>(null);
  const [noteCopied, setNoteCopied] = useState(false);

  const handleShield = async () => {
    setError("");

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0 || !Number.isInteger(amountNum)) {
      setError("Amount must be a positive whole number");
      return;
    }

    if (amountNum + SHIELD_FEE > xrgeBalance) {
      setError(`Insufficient balance. Need ${amountNum + SHIELD_FEE} XRGE (${amountNum} + ${SHIELD_FEE} fee), have ${xrgeBalance}`);
      return;
    }

    setShielding(true);
    try {
      // Generate commitment client-side
      const note = await createShieldedNote(amountNum, wallet.signingPublicKey);

      // Submit shield transaction
      const result = await secureShield(
        wallet.signingPublicKey,
        wallet.signingPrivateKey,
        amountNum,
        note.commitment
      );

      if (!result.success) {
        throw new Error(result.error || "Shield transaction failed");
      }

      setShielding(false);
      setConfirming(true);

      // Wait for confirmation
      await new Promise(r => setTimeout(r, 3000));
      setConfirming(false);
      setResultNote(note);

      // Auto-save note to local storage
      saveNote(note);

      toast.success(`Shielded ${amountNum} XRGE!`, {
        description: "Note auto-saved. You can also copy it for backup."
      });
    } catch (err) {
      console.error("Shield error:", err);
      setError(err instanceof Error ? err.message : "Shield failed");
      setShielding(false);
      setConfirming(false);
    }
  };

  const copyNote = () => {
    if (!resultNote) return;
    navigator.clipboard.writeText(JSON.stringify(resultNote, null, 2));
    setNoteCopied(true);
    setTimeout(() => setNoteCopied(false), 2000);
    toast.success("Note data copied to clipboard");
  };

  const handleDone = () => {
    onSuccess();
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={shielding || confirming ? undefined : (resultNote ? undefined : onClose)}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-card rounded-2xl border border-border p-6 shadow-xl"
      >
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
              <Shield className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-foreground">Shield XRGE</h2>
              <p className="text-xs text-muted-foreground">Convert to private balance</p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={resultNote ? handleDone : onClose}
            disabled={shielding || confirming}
          >
            <X className="w-5 h-5" />
          </Button>
        </div>

        {resultNote ? (
          /* Success state — show note data */
          <div className="space-y-4">
            <div className="flex items-center gap-2 p-3 rounded-lg bg-success/10 text-success text-sm">
              <CheckCircle2 className="w-5 h-5 flex-shrink-0" />
              <span className="font-medium">Successfully shielded {resultNote.value} XRGE</span>
            </div>

            <div className="flex items-center gap-2 p-3 rounded-lg bg-primary/10 text-primary text-sm">
              <CheckCircle2 className="w-5 h-5 flex-shrink-0" />
              <span>Note auto-saved to your wallet. You can also copy it as backup.</span>
            </div>

            <div className="bg-muted/50 rounded-lg p-3 border border-border">
              <div className="space-y-2">
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Commitment</p>
                  <p className="text-xs font-mono text-foreground break-all">{resultNote.commitment}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Nullifier</p>
                  <p className="text-xs font-mono text-foreground break-all">{resultNote.nullifier}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Randomness</p>
                  <p className="text-xs font-mono text-foreground break-all">{resultNote.randomness}</p>
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Value</p>
                    <p className="text-sm font-bold text-primary">{resultNote.value} XRGE</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex gap-2">
              <Button onClick={copyNote} variant="outline" className="flex-1 gap-2">
                <Copy className="w-4 h-4" />
                {noteCopied ? "Copied!" : "Copy Note Data"}
              </Button>
              <Button onClick={handleDone} className="flex-1">
                Done
              </Button>
            </div>
          </div>
        ) : (
          /* Input state */
          <div className="space-y-4">
            <div className="p-3 rounded-lg bg-primary/5 border border-primary/20">
              <p className="text-xs text-muted-foreground">
                Shielding converts public XRGE into a private note. The note data is generated 
                client-side and never sent to the server — only you have the key to unshield it.
              </p>
            </div>

            <div>
              <div className="flex items-center justify-between">
                <Label htmlFor="shield-amount">Amount (whole XRGE)</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-primary"
                  onClick={() => setAmount(Math.max(0, Math.floor(xrgeBalance - SHIELD_FEE)).toString())}
                >
                  Max
                </Button>
              </div>
              <div className="relative mt-1.5">
                <Input
                  id="shield-amount"
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0"
                  min="1"
                  step="1"
                  className="pr-16"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground font-medium">
                  XRGE
                </span>
              </div>
              <div className="flex justify-between text-xs text-muted-foreground mt-1">
                <span>Available: {xrgeBalance.toLocaleString()} XRGE</span>
                <span>Fee: {SHIELD_FEE} XRGE</span>
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                {error}
              </div>
            )}

            <Button
              onClick={handleShield}
              disabled={shielding || confirming || !amount}
              className="w-full"
            >
              {shielding ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Signing & Submitting...
                </>
              ) : confirming ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Waiting for confirmation...
                </>
              ) : (
                <>
                  <Shield className="w-4 h-4 mr-2" />
                  Shield XRGE
                </>
              )}
            </Button>

            <p className="text-xs text-center text-muted-foreground">
              Signed locally with ML-DSA-65 • Commitment generated client-side
            </p>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
};

export default ShieldDialog;
