import { useMemo, useState } from "react";
import { Dialog, Button } from "@rougechain/ui";
import { formatIdentity } from "@rougechain/core/address";
import type { WalletBalance } from "@rougechain/core/pqc-wallet";
import { getNetworkLabel } from "@rougechain/core/network";
import { useWallet } from "./WalletProvider";
import { BASE_TRANSFER_FEE, displayAmount, maxFractionDigits, parseAmount, parseRecipient, resolveRecipient, submitTransfer } from "./send";
import { toast } from "./toast";

type Step = "form" | "review" | "sending";

export function SendDialog({
  open,
  balances,
  initialSymbol,
  onClose,
  onSent,
}: {
  open: boolean;
  balances: WalletBalance[];
  initialSymbol?: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const { wallet } = useWallet();
  const [symbol, setSymbol] = useState(initialSymbol ?? "XRGE");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<Step>("form");
  const [error, setError] = useState("");
  const [resolved, setResolved] = useState<{ publicKey: string; raw: number; human: number } | null>(null);

  const recipientCheck = recipient ? parseRecipient(recipient) : null;
  const amountCheck = useMemo(() => (amount ? parseAmount(amount, symbol, balances) : null), [amount, symbol, balances]);
  const balance = balances.find((b) => b.symbol === symbol)?.balance ?? 0;

  const reset = () => {
    setStep("form");
    setError("");
    setResolved(null);
  };
  const close = () => {
    if (step === "sending") return;
    reset();
    setRecipient("");
    setAmount("");
    onClose();
  };

  const review = async () => {
    setError("");
    const r = parseRecipient(recipient);
    if (!r.valid) return setError(r.error);
    const a = parseAmount(amount, symbol, balances);
    if (!a.valid) return setError(a.error);
    if (!wallet) return setError("Unlock your wallet first");
    try {
      const publicKey = r.isRouge ? await resolveRecipient(r.address) : r.address;
      if (publicKey === wallet.signingPublicKey) return setError("Cannot send to your own address");
      setResolved({ publicKey, raw: a.raw, human: a.human });
      setStep("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't resolve the recipient");
    }
  };

  const send = async () => {
    if (!wallet || !resolved) return;
    setStep("sending");
    setError("");
    try {
      await submitTransfer({ wallet, recipientPublicKey: resolved.publicKey, raw: resolved.raw, symbol });
      toast.success(`Sent ${displayAmount(resolved.raw, symbol)} ${symbol}`, { description: "Submitted — it confirms in the next block." });
      reset();
      setRecipient("");
      setAmount("");
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transaction failed");
      setStep("review");
    }
  };

  const title = step === "form" ? "Send" : "Review and sign";
  return (
    <Dialog open={open} onClose={close} title={title}>
      {step === "form" ? (
        <form
          className="wallet-form"
          onSubmit={(e) => {
            e.preventDefault();
            void review();
          }}
        >
          {balances.length > 1 && (
            <label className="field">
              Token
              <select
                value={symbol}
                onChange={(e) => {
                  setSymbol(e.target.value);
                  setError("");
                }}
              >
                {balances.map((b) => (
                  <option key={b.symbol} value={b.symbol}>
                    {b.symbol} · {displayAmount(b.balance, b.symbol)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            Recipient
            <input
              className="input mono"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="rouge1… or public key"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          {recipientCheck && !recipientCheck.valid && <p className="form-hint error">{recipientCheck.error}</p>}
          <label className="field">
            <span className="field-row">
              Amount
              <button type="button" className="inline-link" onClick={() => setAmount(maxSendable(balance, symbol))}>
                Max {displayAmount(balance, symbol)} {symbol}
              </button>
            </span>
            <input
              className="input mono"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(",", "."))}
              placeholder={maxFractionDigits(symbol) > 0 ? "0.0" : "0"}
              autoComplete="off"
            />
          </label>
          {amountCheck && !amountCheck.valid && <p className="form-hint error">{amountCheck.error}</p>}
          <p className="form-hint">
            Network fee {BASE_TRANSFER_FEE} XRGE · {getNetworkLabel()}
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" disabled={!recipientCheck?.valid || !amountCheck?.valid}>
            Review
          </Button>
        </form>
      ) : (
        resolved && (
          <div className="wallet-form">
            <dl className="review-list">
              <div>
                <dt>Send</dt>
                <dd className="mono">
                  {displayAmount(resolved.raw, symbol)} {symbol}
                </dd>
              </div>
              <div>
                <dt>To</dt>
                <dd className="mono" title={resolved.publicKey}>
                  {recipient.trim().toLowerCase().startsWith("rouge1") ? recipient.trim() : formatIdentity(resolved.publicKey)}
                </dd>
              </div>
              <div>
                <dt>Fee</dt>
                <dd className="mono">{BASE_TRANSFER_FEE} XRGE</dd>
              </div>
              <div>
                <dt>Network</dt>
                <dd>{getNetworkLabel()}</dd>
              </div>
            </dl>
            <p className="form-hint">
              {wallet && !wallet.signingPrivateKey
                ? "Your RougeChain extension will ask you to approve this transfer."
                : "Signed in this browser with your ML-DSA-65 key. Your key never leaves this page."}
            </p>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="actions">
              <Button variant="outline" onClick={reset} disabled={step === "sending"}>
                Back
              </Button>
              <Button onClick={send} disabled={step === "sending"}>
                {step === "sending" ? "Signing…" : "Sign and send"}
              </Button>
            </div>
          </div>
        )
      )}
    </Dialog>
  );
}

/** Max amount the form offers: the whole balance, minus the fee for XRGE. */
function maxSendable(raw: number, symbol: string): string {
  if (symbol === "XRGE") return String(Math.max(0, Math.floor((raw - BASE_TRANSFER_FEE) * 1e8) / 1e8));
  const d = maxFractionDigits(symbol);
  return d > 0 ? String(raw / 10 ** d) : String(raw);
}
