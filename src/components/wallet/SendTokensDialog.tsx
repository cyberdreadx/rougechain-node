import { useState } from "react";
import { motion } from "framer-motion";
import { X, Send, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { sendTransaction, WalletBalance } from "@/lib/pqc-wallet";

interface SendTokensDialogProps {
  wallet: {
    publicKey: string;
    privateKey: string;
  };
  balances: WalletBalance[];
  onClose: () => void;
  onSuccess: () => void;
}

const SendTokensDialog = ({ wallet, balances, onClose, onSuccess }: SendTokensDialogProps) => {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const xrgeBalance = balances.find(b => b.symbol === "XRGE")?.balance || 0;

  const handleSend = async () => {
    setError("");
    
    if (!recipient.trim()) {
      setError("Recipient address required");
      return;
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setError("Invalid amount");
      return;
    }

    if (amountNum > xrgeBalance) {
      setError("Insufficient balance");
      return;
    }

    setSending(true);
    try {
      await sendTransaction(
        wallet.privateKey,
        wallet.publicKey,
        recipient.trim(),
        amountNum,
        "XRGE",
        memo || undefined
      );
      
      toast.success(`Sent ${amountNum} XRGE successfully!`);
      onSuccess();
    } catch (err) {
      console.error("Send error:", err);
      setError(err instanceof Error ? err.message : "Transaction failed");
    } finally {
      setSending(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-card rounded-2xl border border-border p-6 shadow-xl"
      >
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-foreground">Send XRGE</h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="w-5 h-5" />
          </Button>
        </div>

        <div className="space-y-4">
          <div>
            <Label htmlFor="recipient">Recipient Address</Label>
            <Input
              id="recipient"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="Enter public key..."
              className="mt-1.5 font-mono text-sm"
            />
          </div>

          <div>
            <Label htmlFor="amount">Amount</Label>
            <div className="relative mt-1.5">
              <Input
                id="amount"
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0"
                className="pr-16"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                XRGE
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Available: {xrgeBalance.toLocaleString()} XRGE
            </p>
          </div>

          <div>
            <Label htmlFor="memo">Memo (Optional)</Label>
            <Input
              id="memo"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="Add a note..."
              className="mt-1.5"
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}

          <Button
            onClick={handleSend}
            disabled={sending || !recipient || !amount}
            className="w-full"
          >
            {sending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Mining Transaction...
              </>
            ) : (
              <>
                <Send className="w-4 h-4 mr-2" />
                Send XRGE
              </>
            )}
          </Button>

          <p className="text-xs text-center text-muted-foreground">
            Transaction will be mined and signed with ML-DSA-65
          </p>
        </div>
      </motion.div>
    </motion.div>
  );
};

export default SendTokensDialog;
