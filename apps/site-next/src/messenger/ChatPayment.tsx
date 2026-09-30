/**
 * In-chat payments (apps/web components/messenger/ChatPayment): send XRGE / tokens to the peer
 * through core's secureTransfer (POST /v2/transfer, signed locally or by the extension), then post
 * a Qwalla msg envelope with a `pay` card. Also payment requests (`req`) and Qwalla tips.
 *
 * The transfer is signed by the unlocked on-chain wallet (useWallet), not the messaging identity:
 * for an extension wallet the messaging key is device-local and holds no funds, so the extension
 * signs instead (core resolveSignedTx). For seed wallets both are the same key.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUp, CheckCircle2, DollarSign, Loader2 } from "lucide-react";
import { WALLET_TRANSFER_FEE, getWalletBalance, type WalletBalance } from "@rougechain/core/pqc-wallet";
import { secureTransfer } from "@rougechain/core/secure-api";
import { useWallet } from "../wallet/WalletProvider";
import { displayAmount, parseAmount } from "../wallet/send";
import { toast } from "../wallet/toast";
import type { PaymentMessageData, RequestMessageData } from "./codec";
import { S, fmt } from "./strings";
import { Sheet } from "./ui";

export function ChatPayment({
  recipientPublicKey,
  recipientName,
  initial,
  onClose,
  onPaymentSent,
  onRequest,
}: {
  recipientPublicKey: string;
  recipientName: string;
  /** Prefill from a payment request being paid. */
  initial?: { token: string; amount: number; memo?: string };
  onClose: () => void;
  onPaymentSent: (data: PaymentMessageData) => void;
  /** Offer the "Request" mode (posts a request card instead of paying). */
  onRequest?: (data: RequestMessageData) => void;
}) {
  const { wallet, network, isExtension } = useWallet();
  const [mode, setMode] = useState<"send" | "request">("send");
  const [token, setToken] = useState(initial?.token ?? "XRGE");
  const [amount, setAmount] = useState(initial ? String(initial.amount) : "");
  const [memo, setMemo] = useState(initial?.memo ?? "");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const pub = wallet?.signingPublicKey ?? null;
  const q = useQuery({
    queryKey: ["messenger", "pay-balances", network, pub],
    enabled: !!pub,
    queryFn: () => getWalletBalance(pub!),
    retry: false,
  });
  const balances: WalletBalance[] = useMemo(() => q.data ?? [], [q.data]);
  const tokens = useMemo(() => {
    const list = ["XRGE", ...balances.filter((b) => b.symbol !== "XRGE" && b.balance > 0).map((b) => b.symbol)];
    if (!list.includes(token)) list.push(token);
    return list;
  }, [balances, token]);
  const balanceRaw = balances.find((b) => b.symbol === token)?.balance ?? 0;
  const quick = token === "XRGE" ? [10, 50, 100, 500] : [1, 5, 10, 50];

  const send = async () => {
    setError("");
    if (!wallet) return setError(S.pay.noSigner);
    const human = Number(amount);
    if (mode === "request") {
      if (!Number.isFinite(human) || human <= 0) return setError("Enter a valid amount");
      onRequest?.({ type: "request", token, amount: human, memo: memo.trim() || undefined });
      onClose();
      return;
    }
    const check = parseAmount(amount, token, balances);
    if (!check.valid) return setError(check.error);
    setSending(true);
    try {
      const result = await secureTransfer(
        wallet.signingPublicKey,
        wallet.signingPrivateKey,
        recipientPublicKey,
        check.raw,
        WALLET_TRANSFER_FEE,
        token,
      );
      if (!result.success) throw new Error(result.error || "Transfer failed");
      const data = (result.data ?? {}) as { txHash?: string; tx_hash?: string };
      toast.success(fmt(S.pay.sent, { amount: check.human, symbol: token, name: recipientName }));
      onPaymentSent({
        type: "payment",
        token,
        amount: check.human,
        txHash: data.txHash || data.tx_hash || undefined,
        status: "sent",
        memo: memo.trim() || undefined,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : S.pay.failed);
      toast.error(S.pay.failed, { description: e instanceof Error ? e.message : undefined });
    } finally {
      setSending(false);
    }
  };

  return (
    <Sheet title={`${mode === "send" ? S.pay.sendTo : S.pay.requestFrom} ${recipientName}`} icon={<DollarSign size={16} className="accent" />} onClose={onClose}>
      <form
        className="msg-pay"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {onRequest && !initial && (
          <div className="msg-tabs" role="tablist">
            {(["send", "request"] as const).map((m) => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? "active" : ""} onClick={() => setMode(m)}>
                {m === "send" ? S.pay.modeSend : S.pay.modeRequest}
              </button>
            ))}
          </div>
        )}
        <label className="msg-pay-amount">
          <span className="sr-only">{S.pay.amount}</span>
          <input
            className="input"
            inputMode="decimal"
            value={amount}
            placeholder="0"
            autoFocus
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
          />
          <span className="mono">{token}</span>
        </label>
        {mode === "send" && (
          <p className="msg-hint center">{q.isLoading ? S.common.loading : fmt(S.pay.balance, { amount: displayAmount(balanceRaw, token), symbol: token })}</p>
        )}
        <div className="msg-chips">
          {quick.map((v) => (
            <button key={v} type="button" className={`msg-chip ${amount === String(v) ? "active" : ""}`} onClick={() => setAmount(String(v))}>
              {v}
            </button>
          ))}
        </div>
        {tokens.length > 1 && (
          <div className="msg-chips" aria-label={S.pay.token}>
            {tokens.map((t) => (
              <button key={t} type="button" className={`msg-chip ${token === t ? "active" : ""}`} onClick={() => setToken(t)}>
                {t}
              </button>
            ))}
          </div>
        )}
        <input className="input" value={memo} maxLength={140} placeholder={S.pay.memo} aria-label={S.pay.memo} onChange={(e) => setMemo(e.target.value)} />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="button" disabled={sending || !amount || Number(amount) <= 0}>
          {sending ? <Loader2 size={16} className="spin" /> : <ArrowUp size={16} />}
          {sending
            ? S.pay.sending
            : fmt(mode === "send" ? S.pay.send : S.pay.request, { amount: amount || "", symbol: token }).replace(/\s+/g, " ")}
        </button>
        {mode === "send" && <p className="msg-hint center">{fmt(isExtension ? S.pay.feeExtension : S.pay.fee, { fee: WALLET_TRANSFER_FEE })}</p>}
      </form>
    </Sheet>
  );
}

export function PaymentBubble({ payment, isOwn }: { payment: PaymentMessageData; isOwn: boolean }) {
  return (
    <div className={`msg-card pay ${isOwn ? "own" : ""}`}>
      <span className="msg-card-label">{isOwn ? S.pay.youSent : S.pay.received}</span>
      <strong className="msg-card-amount">
        {payment.amount} <span>{payment.token}</span>
      </strong>
      {payment.memo && <em>“{payment.memo}”</em>}
      <span className="msg-card-foot">
        <CheckCircle2 size={12} /> {payment.status === "confirmed" ? S.pay.confirmed : S.pay.sentLabel}
        {payment.txHash && <code className="mono">{payment.txHash.slice(0, 12)}…</code>}
      </span>
    </div>
  );
}

export function PaymentRequestBubble({ request, isOwn, onAccept }: { request: RequestMessageData; isOwn: boolean; onAccept?: () => void }) {
  return (
    <div className="msg-card req">
      <span className="msg-card-label">{isOwn ? S.pay.youRequested : S.pay.requested}</span>
      <strong className="msg-card-amount">
        {request.amount} <span>{request.token}</span>
      </strong>
      {request.memo && <em>“{request.memo}”</em>}
      {!isOwn && onAccept && (
        <button
          type="button"
          className="button small"
          onClick={(e) => {
            e.stopPropagation();
            onAccept();
          }}
        >
          {fmt(S.pay.payNow, { amount: request.amount, symbol: request.token })}
        </button>
      )}
      <span className="msg-card-foot">
        <DollarSign size={12} /> {S.pay.requestLabel}
      </span>
    </div>
  );
}

export function TipBubble({ amount, symbol, isOwn }: { amount: string; symbol: string; isOwn: boolean }) {
  return (
    <div className="msg-tip">
      <span aria-hidden="true">💸</span>
      <span>
        <strong>
          {S.tip.label}: {amount} {symbol}
        </strong>
        <small>{isOwn ? S.tip.sent : S.tip.received}</small>
      </span>
    </div>
  );
}
