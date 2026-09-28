import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, DollarSign, Loader2, CheckCircle2, ArrowUp, Coins } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { TokenIcon } from "@/components/ui/token-icon";
import { secureTransfer } from "@/lib/secure-api";
import { getNodeApiBaseUrl, getCoreApiHeaders } from "@/lib/network";
import { BASE_TRANSFER_FEE } from "@/lib/pqc-wallet";
import { formatTokenAmount, isQeth, humanToQeth, qethToHuman } from "@/hooks/use-eth-price";
import { useTokenMetadata } from "@/hooks/use-token-metadata";
import { useTranslation } from "react-i18next";
import { buildMsgEnvelope, type EnvelopeData } from "@/lib/messenger-envelope";

interface ChatPaymentProps {
  walletPublicKey: string;
  walletPrivateKey: string;
  recipientPublicKey: string;
  recipientName: string;
  onClose: () => void;
  onPaymentSent: (paymentData: PaymentMessageData) => void;
}

export interface PaymentMessageData {
  type: "payment";
  token: string;
  amount: number;
  txHash?: string;
  status: "sent" | "confirmed" | "failed";
  memo?: string;
}

/**
 * Check if a message is a payment message and parse it
 */
export function parsePaymentMessage(text: string): PaymentMessageData | null {
  if (!text.startsWith("PAYMENT:")) return null;
  try {
    return JSON.parse(text.slice(8));
  } catch {
    return null;
  }
}

/**
 * Encode payment data for sending: a Qwalla msg envelope whose body is a readable line
 * (what Qwalla and the extension show) plus a `pay` field the site renders as a card.
 * The legacy `PAYMENT:` form is only parsed (old history).
 */
export function encodePaymentMessage(data: PaymentMessageData): string {
  const { type: _type, ...pay } = data;
  const memo = data.memo ? ` — ${data.memo}` : "";
  return buildMsgEnvelope(`💸 Sent ${data.amount} ${data.token}${memo}`, { pay });
}

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const optStr = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);

/** Validate the `pay` field of a msg envelope into payment data, or null. */
export function paymentFromEnvelope(pay: EnvelopeData | undefined): PaymentMessageData | null {
  if (!pay || typeof pay.token !== "string" || !isNum(pay.amount)) return null;
  const status = pay.status === "confirmed" || pay.status === "failed" ? pay.status : "sent";
  return { type: "payment", token: pay.token, amount: pay.amount, txHash: optStr(pay.txHash), status, memo: optStr(pay.memo) };
}

/** Payment data of a message: envelope `pay` field (current) or legacy `PAYMENT:` text. */
export function getPaymentData(message: { plaintext?: string; pay?: EnvelopeData }): PaymentMessageData | null {
  return paymentFromEnvelope(message.pay) ?? (message.plaintext ? parsePaymentMessage(message.plaintext) : null);
}

// ─── Payment Compose Dialog ──────────────────────────────────
const ChatPayment = ({
  walletPublicKey,
  walletPrivateKey,
  recipientPublicKey,
  recipientName,
  onClose,
  onPaymentSent,
}: ChatPaymentProps) => {
  const { getTokenImage } = useTokenMetadata();
  const [amount, setAmount] = useState("");
  const [selectedToken, setSelectedToken] = useState("XRGE");
  const [memo, setMemo] = useState("");
  const [sending, setSending] = useState(false);
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [xrgeBalance, setXrgeBalance] = useState(0);
  const [loadingBalances, setLoadingBalances] = useState(true);

  // Fetch balances
  useEffect(() => {
    async function fetchBalances() {
      try {
        const baseUrl = getNodeApiBaseUrl();
        if (!baseUrl) return;
        const res = await fetch(`${baseUrl}/balance/${walletPublicKey}`, {
          headers: getCoreApiHeaders(),
        });
        if (res.ok) {
          const data = await res.json();
          setXrgeBalance(data.balance || 0);
          setBalances(data.token_balances || {});
        }
      } catch {
        console.error("Failed to fetch balances");
      } finally {
        setLoadingBalances(false);
      }
    }
    fetchBalances();
  }, [walletPublicKey]);

  const availableTokens = ["XRGE", ...Object.keys(balances).filter(k => balances[k] > 0)];
  const currentBalance = selectedToken === "XRGE" ? xrgeBalance : (balances[selectedToken] || 0);
  const displayBalance = isQeth(selectedToken) ? qethToHuman(currentBalance) : currentBalance;

  const handleSend = async () => {
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      toast.error("Enter a valid amount");
      return;
    }

    const rawAmount = isQeth(selectedToken) ? humanToQeth(amountNum) : amountNum;
    if (rawAmount > currentBalance) {
      toast.error("Insufficient balance");
      return;
    }

    if (selectedToken === "XRGE" && amountNum + BASE_TRANSFER_FEE > xrgeBalance) {
      toast.error(`Need ${BASE_TRANSFER_FEE} XRGE for fee`);
      return;
    }

    setSending(true);
    try {
      const result = await secureTransfer(
        walletPublicKey,
        walletPrivateKey,
        recipientPublicKey,
        rawAmount,
        BASE_TRANSFER_FEE,
        selectedToken
      );

      if (!result.success) throw new Error(result.error || "Transfer failed");

      const paymentData: PaymentMessageData = {
        type: "payment",
        token: selectedToken,
        amount: amountNum,
        txHash: (result as any).txHash || undefined,
        status: "sent",
        memo: memo.trim() || undefined,
      };

      toast.success(`Sent ${amountNum} ${selectedToken} to ${recipientName}`);
      onPaymentSent(paymentData);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Payment failed");
    } finally {
      setSending(false);
    }
  };

  // Quick amount buttons
  const quickAmounts = selectedToken === "XRGE"
    ? [10, 50, 100, 500]
    : [1, 5, 10, 50];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-end sm:items-center justify-center"
      onClick={onClose}
    >
      <motion.div
        initial={{ y: 100, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 100, opacity: 0 }}
        transition={{ type: "spring", damping: 25, stiffness: 200 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-sm bg-card rounded-t-2xl sm:rounded-2xl border border-border shadow-2xl overflow-hidden"
      >
        {/* Header — gradient like Apple Cash */}
        <div className="relative bg-gradient-to-br from-primary/20 via-primary/10 to-background p-6 text-center">
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="absolute top-3 right-3 h-8 w-8"
          >
            <X className="w-4 h-4" />
          </Button>

          <p className="text-sm text-muted-foreground mb-1">Send to</p>
          <p className="font-semibold text-lg">{recipientName}</p>

          {/* Big amount display */}
          <div className="mt-4 flex items-center justify-center gap-2">
            <TokenIcon symbol={selectedToken} size={28} imageUrl={getTokenImage(selectedToken)} />
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              className="bg-transparent text-4xl font-bold text-center focus:outline-none w-40 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              autoFocus
            />
            <span className="text-xl text-muted-foreground font-medium">{selectedToken}</span>
          </div>

          <p className="text-xs text-muted-foreground mt-2">
            Balance: {loadingBalances ? "..." : formatTokenAmount(currentBalance, selectedToken)} {selectedToken}
          </p>
        </div>

        {/* Body */}
        <div className="p-4 space-y-3">
          {/* Quick amounts */}
          <div className="flex gap-2 justify-center">
            {quickAmounts.map((q) => (
              <button
                key={q}
                onClick={() => setAmount(q.toString())}
                className={`px-3 py-1.5 text-sm rounded-full border transition-colors ${
                  amount === q.toString()
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-muted/50 border-border hover:bg-muted text-foreground"
                }`}
              >
                {q}
              </button>
            ))}
          </div>

          {/* Token selector (compact) */}
          {availableTokens.length > 1 && (
            <div className="flex items-center gap-2 overflow-x-auto py-1">
              <span className="text-xs text-muted-foreground flex-shrink-0">Token:</span>
              {availableTokens.map((t) => (
                <button
                  key={t}
                  onClick={() => setSelectedToken(t)}
                  className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs border transition-colors flex-shrink-0 ${
                    selectedToken === t
                      ? "bg-primary/20 border-primary/50 text-primary font-medium"
                      : "border-border hover:bg-muted/50"
                  }`}
                >
                  <TokenIcon symbol={t} size={14} imageUrl={getTokenImage(t)} />
                  {t}
                </button>
              ))}
            </div>
          )}

          {/* Memo */}
          <Input
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="Add a note..."
            className="text-sm"
          />

          {/* Send button */}
          <Button
            onClick={handleSend}
            disabled={sending || !amount || parseFloat(amount) <= 0}
            className="w-full h-12 text-base font-semibold"
          >
            {sending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <ArrowUp className="w-4 h-4 mr-2" />
                Send {amount ? `${amount} ${selectedToken}` : selectedToken}
              </>
            )}
          </Button>

          <p className="text-xs text-center text-muted-foreground">
            Fee: {BASE_TRANSFER_FEE} XRGE • Signed with ML-DSA-65
          </p>
        </div>
      </motion.div>
    </motion.div>
  );
};


// ─── Payment Bubble (renders inside chat) ─────────────────────
export const PaymentBubble = ({
  payment,
  isOwn,
}: {
  payment: PaymentMessageData;
  isOwn: boolean;
}) => {
  const { getTokenImage } = useTokenMetadata();

  return (
    <div
      className={`rounded-xl overflow-hidden border max-w-[260px] ${
        isOwn
          ? "bg-gradient-to-br from-primary/20 to-primary/5 border-primary/30"
          : "bg-gradient-to-br from-emerald-500/20 to-emerald-500/5 border-emerald-500/30"
      }`}
    >
      <div className="px-4 py-3 flex items-center gap-3">
        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
          isOwn ? "bg-primary/20" : "bg-emerald-500/20"
        }`}>
          <TokenIcon symbol={payment.token} size={24} imageUrl={getTokenImage(payment.token)} />
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{isOwn ? "You sent" : "Received"}</p>
          <p className="text-xl font-bold">
            {payment.amount} <span className="text-sm font-medium text-muted-foreground">{payment.token}</span>
          </p>
        </div>
      </div>
      {payment.memo && (
        <div className="px-4 pb-2">
          <p className="text-xs text-muted-foreground italic">"{payment.memo}"</p>
        </div>
      )}
      <div className={`px-4 py-1.5 text-xs flex items-center gap-1 ${
        isOwn ? "bg-primary/10 text-primary" : "bg-emerald-500/10 text-emerald-500"
      }`}>
        <CheckCircle2 className="w-3 h-3" />
        <span>{payment.status === "confirmed" ? "Confirmed" : "Sent"}</span>
        {payment.txHash && (
          <span className="font-mono ml-auto truncate max-w-[100px]">{payment.txHash.slice(0, 12)}...</span>
        )}
      </div>
    </div>
  );
};

// ─── Payment Requests ─────────────────────────────────────────

export interface RequestMessageData {
  type: "request";
  token: string;
  amount: number;
  memo?: string;
}

export function parseRequestMessage(text: string): RequestMessageData | null {
  if (!text.startsWith("REQUEST:")) return null;
  try {
    return JSON.parse(text.slice(8));
  } catch {
    return null;
  }
}

/**
 * Encode a payment request for sending: msg envelope with a readable body plus a `req` field.
 * The legacy `REQUEST:` form is only parsed (old history).
 */
export function encodeRequestMessage(data: RequestMessageData): string {
  const { type: _type, ...req } = data;
  const memo = data.memo ? ` — ${data.memo}` : "";
  return buildMsgEnvelope(`🧾 Requested ${data.amount} ${data.token}${memo}`, { req });
}

/** Validate the `req` field of a msg envelope into request data, or null. */
export function requestFromEnvelope(req: EnvelopeData | undefined): RequestMessageData | null {
  if (!req || typeof req.token !== "string" || !isNum(req.amount)) return null;
  return { type: "request", token: req.token, amount: req.amount, memo: optStr(req.memo) };
}

/** Request data of a message: envelope `req` field (current) or legacy `REQUEST:` text. */
export function getRequestData(message: { plaintext?: string; req?: EnvelopeData }): RequestMessageData | null {
  return requestFromEnvelope(message.req) ?? (message.plaintext ? parseRequestMessage(message.plaintext) : null);
}

export const PaymentRequestBubble = ({
  request,
  isOwn,
  onAccept,
}: {
  request: RequestMessageData;
  isOwn: boolean;
  onAccept?: () => void;
}) => {
  const { getTokenImage } = useTokenMetadata();

  return (
    <div className="rounded-xl overflow-hidden border max-w-[260px] bg-gradient-to-br from-amber-500/15 to-amber-500/5 border-amber-500/30">
      <div className="px-4 py-3 flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center">
          <TokenIcon symbol={request.token} size={24} imageUrl={getTokenImage(request.token)} />
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{isOwn ? "You requested" : "Requested"}</p>
          <p className="text-xl font-bold">
            {request.amount} <span className="text-sm font-medium text-muted-foreground">{request.token}</span>
          </p>
        </div>
      </div>
      {request.memo && (
        <div className="px-4 pb-2">
          <p className="text-xs text-muted-foreground italic">"{request.memo}"</p>
        </div>
      )}
      {!isOwn && onAccept && (
        <div className="px-4 pb-3">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAccept();
            }}
            className="w-full py-2 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-sm font-semibold transition-colors"
          >
            Pay {request.amount} {request.token}
          </button>
        </div>
      )}
      <div className="px-4 py-1.5 text-xs flex items-center gap-1 bg-amber-500/10 text-amber-600">
        <DollarSign className="w-3 h-3" />
        <span>Payment Request</span>
      </div>
    </div>
  );
};

// ─── Qwalla tips ([tip:AMOUNT:SYMBOL]) ────────────────────────

export const TipBubble = ({ amount, symbol, isOwn }: { amount: string; symbol: string; isOwn: boolean }) => {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="text-lg leading-none" aria-hidden>💸</span>
      <div className="min-w-0">
        <p className="text-sm font-semibold">
          {t("messenger.tip.label")}: {amount} {symbol}
        </p>
        <p className="text-xs opacity-70">{isOwn ? t("messenger.tip.sent") : t("messenger.tip.received")}</p>
      </div>
    </div>
  );
};

export default ChatPayment;

