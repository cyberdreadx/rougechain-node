import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Send, Loader2, AlertCircle, CheckCircle2, ChevronDown, QrCode } from "lucide-react";
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
import { sendTransaction, getWalletBalance, WalletBalance, BASE_TRANSFER_FEE } from "@/lib/pqc-wallet";
import { qethToHuman, humanToQeth, formatQethForDisplay } from "@/hooks/use-eth-price";
import PqcQrScanner from "./PqcQrScanner";

interface SendTokensDialogProps {
  wallet: {
    signingPublicKey: string;
    signingPrivateKey: string;
  };
  balances: WalletBalance[];
  onClose: () => void;
  onSuccess: () => void;
}

// ML-DSA-65 public key = 1952 bytes = 3904 hex characters
const ML_DSA65_PUBKEY_HEX_LEN = 3904;
// Allow a small tolerance for minor encoding differences
const MIN_ADDRESS_LEN = ML_DSA65_PUBKEY_HEX_LEN - 100;

// Validate and parse xrge: prefixed address
const parseXrgeAddress = (input: string): { valid: boolean; address: string; error?: string } => {
  const trimmed = input.trim();

  if (!trimmed) {
    return { valid: false, address: "", error: "Recipient address required" };
  }

  // Check for xrge: prefix (case-insensitive)
  const prefixMatch = trimmed.match(/^xrge:/i);
  const rawAddress = prefixMatch ? trimmed.slice(5) : trimmed;

  // Check for valid hex characters
  const hexRegex = /^[A-Fa-f0-9]+$/;
  if (!hexRegex.test(rawAddress)) {
    return { valid: false, address: rawAddress, error: "Invalid address format — expected hex-encoded public key" };
  }

  // Validate the address length (ML-DSA-65 public keys are 3904 hex chars)
  if (rawAddress.length < MIN_ADDRESS_LEN) {
    return {
      valid: false,
      address: rawAddress,
      error: `Address too short (${rawAddress.length} chars) — expected ${ML_DSA65_PUBKEY_HEX_LEN} hex characters for a full ML-DSA-65 public key`,
    };
  }

  return { valid: true, address: rawAddress };
};

const SendTokensDialog = ({ wallet, balances, onClose, onSuccess }: SendTokensDialogProps) => {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [selectedToken, setSelectedToken] = useState("XRGE");
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [showScanner, setShowScanner] = useState(false);

  const xrgeBalance = balances.find(b => b.symbol === "XRGE")?.balance || 0;
  const rawSelectedBalance = balances.find(b => b.symbol === selectedToken)?.balance || 0;
  const isQeth = selectedToken === "qETH";
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
    const amountToSend = isQeth ? humanToQeth(amountNum) : amountNum;

    // Check token balance (raw units)
    if (amountToSend > rawSelectedBalance) {
      const displayBal = isQeth ? qethToHuman(rawSelectedBalance) : rawSelectedBalance;
      setError(`Insufficient ${selectedToken} balance. You have ${isQeth ? displayBal.toString() : rawSelectedBalance.toLocaleString()} ${selectedToken}`);
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
        amountToSend,
        selectedToken,
        memo || undefined
      );

      // Transaction submitted - now wait for it to be mined
      setSending(false);
      setConfirming(true);

      // Poll for balance change (up to 30 seconds)
      const startBalance = rawSelectedBalance;
      const maxAttempts = 15;
      let confirmed = false;

      for (let i = 0; i < maxAttempts; i++) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds

        try {
          const newBalances = await getWalletBalance(wallet.signingPublicKey);
          const newBalance = newBalances.find(b => b.symbol === selectedToken)?.balance || 0;

          // Check if balance changed (decreased by approximately the sent amount)
          if (newBalance < rawSelectedBalance - (amountToSend * 0.9)) {
            confirmed = true;
            break;
          }
        } catch {
          // Ignore polling errors
        }
      }

      setConfirming(false);

      if (confirmed) {
        toast.success(`Sent ${amountNum} ${selectedToken} successfully!`, {
          description: "Transaction confirmed on-chain"
        });
      } else {
        toast.success(`Sent ${amountNum} ${selectedToken}`, {
          description: "Transaction submitted - may take a moment to confirm"
        });
      }

      onSuccess();
    } catch (err) {
      console.error("Send error:", err);
      setError(err instanceof Error ? err.message : "Transaction failed");
      setSending(false);
      setConfirming(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={sending || confirming ? undefined : onClose}
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
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            disabled={sending || confirming}
          >
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
                  {balances.map((token) => {
                    const balStr = token.symbol === "qETH"
                      ? formatQethForDisplay(token.balance)
                      : token.balance.toLocaleString();
                    return (
                      <SelectItem key={token.symbol} value={token.symbol}>
                        <div className="flex items-center gap-2">
                          <span className="w-6 h-6 rounded-full bg-secondary flex items-center justify-center text-xs font-bold">
                            {token.icon || token.symbol.charAt(0)}
                          </span>
                          <span>{token.symbol}</span>
                          <span className="text-muted-foreground text-xs">
                            ({balStr})
                          </span>
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between">
              <Label htmlFor="recipient">Recipient Address</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowScanner(true)}
                className="h-7 px-2 text-xs gap-1"
              >
                <QrCode className="w-3 h-3" />
                Scan QR
              </Button>
            </div>
            <div className="relative mt-1.5">
              <Input
                id="recipient"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="xrge:... or public key"
                className={`font-mono text-sm pr-10 ${recipient && !isAddressValid ? "border-destructive" : ""
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
                  let maxAmount: number;
                  if (selectedToken === "XRGE") {
                    maxAmount = Math.max(0, rawSelectedBalance - BASE_TRANSFER_FEE);
                  } else if (isQeth) {
                    maxAmount = qethToHuman(rawSelectedBalance);
                  } else {
                    maxAmount = rawSelectedBalance;
                  }
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
              <span>Available: {isQeth ? formatQethForDisplay(rawSelectedBalance) : rawSelectedBalance.toLocaleString()} {selectedToken}</span>
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
            disabled={sending || confirming || !recipient || !amount}
            className="w-full"
          >
            {sending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Submitting...
              </>
            ) : confirming ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Waiting for confirmation...
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

      {/* QR Scanner */}
      <AnimatePresence>
        {showScanner && (
          <PqcQrScanner
            onScan={(publicKey) => {
              setRecipient(publicKey);
              setShowScanner(false);
              toast.success("Address scanned successfully!");
            }}
            onClose={() => setShowScanner(false)}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export default SendTokensDialog;
