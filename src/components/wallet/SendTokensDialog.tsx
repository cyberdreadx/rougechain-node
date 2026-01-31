import { useState } from "react";
import { motion } from "framer-motion";
import { X, Send, Loader2, AlertCircle, CheckCircle2, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { sendTransaction, WalletBalance, BASE_TRANSFER_FEE } from "@/lib/pqc-wallet";

interface SendTokensDialogProps {
  wallet: {
    signingPublicKey: string;
    signingPrivateKey: string;
  };
  balances: WalletBalance[];
  onClose: () => void;
  onSuccess: () => void;
}

// Validate and parse xrge: prefixed address
const parseXrgeAddress = (input: string): { valid: boolean; address: string; error?: string } => {
  const trimmed = input.trim();
  
  if (!trimmed) {
    return { valid: false, address: "", error: "Recipient address required" };
  }

  // Check for xrge: prefix (case-insensitive)
  const prefixMatch = trimmed.match(/^xrge:/i);
  const rawAddress = prefixMatch ? trimmed.slice(5) : trimmed;

  // Validate the address (ML-DSA-65 public keys are base64 encoded, ~2600+ chars)
  if (rawAddress.length < 100) {
    return { valid: false, address: rawAddress, error: "Address too short - invalid public key" };
  }

  // Check for valid base64 characters
  const base64Regex = /^[A-Za-z0-9+/=]+$/;
  if (!base64Regex.test(rawAddress)) {
    return { valid: false, address: rawAddress, error: "Invalid address format" };
  }

  return { valid: true, address: rawAddress };
};

const SendTokensDialog = ({ wallet, balances, onClose, onSuccess }: SendTokensDialogProps) => {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [selectedToken, setSelectedToken] = useState("XRGE");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const xrgeBalance = balances.find(b => b.symbol === "XRGE")?.balance || 0;
  const selectedTokenBalance = balances.find(b => b.symbol === selectedToken)?.balance || 0;
  const selectedTokenInfo = balances.find(b => b.symbol === selectedToken);

  // Live address validation
  const addressValidation = recipient ? parseXrgeAddress(recipient) : null;
  const isAddressValid = addressValidation?.valid ?? false;

  const handleSend = async () => {
    setError("");
    
    const parsed = parseXrgeAddress(recipient);
    if (!parsed.valid) {
      setError(parsed.error || "Invalid address");
      return;
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setError("Invalid amount");
      return;
    }

    // Check token balance
    if (amountNum > selectedTokenBalance) {
      setError(`Insufficient ${selectedToken} balance. You have ${selectedTokenBalance.toLocaleString()} ${selectedToken}`);
      return;
    }

    // Check XRGE balance for fee (fee is always in XRGE)
    const feeRequired = BASE_TRANSFER_FEE;
    const xrgeNeeded = selectedToken === "XRGE" ? amountNum + feeRequired : feeRequired;
    if (xrgeNeeded > xrgeBalance) {
      setError(`Insufficient XRGE for fee. Need ${feeRequired} XRGE for transaction fee`);
      return;
    }

    // Prevent sending to self
    if (parsed.address === wallet.signingPublicKey) {
      setError("Cannot send to your own address");
      return;
    }

    setSending(true);
    try {
      await sendTransaction(
        wallet.signingPrivateKey,
        wallet.signingPublicKey,
        parsed.address, // Use parsed address without prefix
        amountNum,
        selectedToken,
        memo || undefined
      );
      
      toast.success(`Sent ${amountNum} ${selectedToken} successfully!`);
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
          <h2 className="text-xl font-bold text-foreground">Send Tokens</h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="w-5 h-5" />
          </Button>
        </div>

        <div className="space-y-4">
          {/* Token Selection */}
          {balances.length > 1 && (
            <div>
              <Label>Select Token</Label>
              <Select value={selectedToken} onValueChange={setSelectedToken}>
                <SelectTrigger className="mt-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {balances.map((token) => (
                    <SelectItem key={token.symbol} value={token.symbol}>
                      <div className="flex items-center gap-2">
                        <span className="w-6 h-6 rounded-full bg-secondary flex items-center justify-center text-xs font-bold">
                          {token.icon || token.symbol.charAt(0)}
                        </span>
                        <span>{token.symbol}</span>
                        <span className="text-muted-foreground text-xs">
                          ({token.balance.toLocaleString()})
                        </span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div>
            <Label htmlFor="recipient">Recipient Address</Label>
            <div className="relative mt-1.5">
              <Input
                id="recipient"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="xrge:... or public key"
                className={`font-mono text-sm pr-10 ${
                  recipient && !isAddressValid ? "border-destructive" : ""
                } ${recipient && isAddressValid ? "border-success" : ""}`}
              />
              {recipient && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  {isAddressValid ? (
                    <CheckCircle2 className="w-4 h-4 text-success" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-destructive" />
                  )}
                </div>
              )}
            </div>
            {recipient && !isAddressValid && addressValidation?.error && (
              <p className="text-xs text-destructive mt-1">{addressValidation.error}</p>
            )}
            {recipient && isAddressValid && (
              <p className="text-xs text-success mt-1">✓ Valid XRGE address</p>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between">
              <Label htmlFor="amount">Amount</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs text-primary"
                onClick={() => {
                  // For XRGE, leave room for fee. For other tokens, use full balance
                  const maxAmount = selectedToken === "XRGE" 
                    ? Math.max(0, selectedTokenBalance - BASE_TRANSFER_FEE)
                    : selectedTokenBalance;
                  setAmount(maxAmount.toString());
                }}
              >
                Max
              </Button>
            </div>
            <div className="relative mt-1.5">
              <Input
                id="amount"
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0"
                className="pr-20"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground font-medium">
                {selectedToken}
              </span>
            </div>
            <div className="flex justify-between text-xs text-muted-foreground mt-1">
              <span>Available: {selectedTokenBalance.toLocaleString()} {selectedToken}</span>
              <span>Fee: {BASE_TRANSFER_FEE} XRGE</span>
            </div>
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
                Send {selectedToken}
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
