import { useMemo, useState } from "react";
import { Dialog, Button } from "@rougechain/ui";
import { formatIdentity } from "@rougechain/core/address";
import type { WalletBalance } from "@rougechain/core/pqc-wallet";
import { useTranslation } from "react-i18next";
import { useWallet } from "./WalletProvider";
import { networkLabel } from "./hooks";
import { WALLET_TRANSFER_FEE, displayAmount, maxFractionDigits, parseAmount, parseRecipient, resolveRecipient, submitTransfer } from "./send";
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
  const { t } = useTranslation("wallet");
  const { wallet, network } = useWallet();
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
    if (!wallet) return setError(t("send.errors.unlockFirst"));
    try {
      const publicKey = r.isRouge ? await resolveRecipient(r.address) : r.address;
      if (publicKey === wallet.signingPublicKey) return setError(t("send.errors.ownAddress"));
      setResolved({ publicKey, raw: a.raw, human: a.human });
      setStep("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("send.errors.resolveRecipient"));
    }
  };

  const send = async () => {
    if (!wallet || !resolved) return;
    setStep("sending");
    setError("");
    try {
      await submitTransfer({ wallet, recipientPublicKey: resolved.publicKey, raw: resolved.raw, symbol });
      toast.success(t("send.sentToast", { amount: displayAmount(resolved.raw, symbol), symbol }), { description: t("send.sentToastBody") });
      reset();
      setRecipient("");
      setAmount("");
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("send.errors.txFailed"));
      setStep("review");
    }
  };

  const title = step === "form" ? t("send.title") : t("send.reviewTitle");
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
              {t("send.token")}
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
            {t("send.recipient")}
            <input
              className="input mono"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder={t("send.recipientPlaceholder")}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          {recipientCheck && !recipientCheck.valid && <p className="form-hint error">{recipientCheck.error}</p>}
          <label className="field">
            <span className="field-row">
              {t("send.amount")}
              <button type="button" className="inline-link" onClick={() => setAmount(maxSendable(balance, symbol))}>
                {t("send.max", { amount: displayAmount(balance, symbol), symbol })}
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
            {t("send.networkFee", { fee: WALLET_TRANSFER_FEE, network: networkLabel(network) })}
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" disabled={!recipientCheck?.valid || !amountCheck?.valid}>
            {t("send.review")}
          </Button>
        </form>
      ) : (
        resolved && (
          <div className="wallet-form">
            <dl className="review-list">
              <div>
                <dt>{t("send.reviewSend")}</dt>
                <dd className="mono">
                  {displayAmount(resolved.raw, symbol)} {symbol}
                </dd>
              </div>
              <div>
                <dt>{t("send.reviewTo")}</dt>
                <dd className="mono" title={resolved.publicKey}>
                  {recipient.trim().toLowerCase().startsWith("rouge1") ? recipient.trim() : formatIdentity(resolved.publicKey)}
                </dd>
              </div>
              <div>
                <dt>{t("send.reviewFee")}</dt>
                <dd className="mono">{WALLET_TRANSFER_FEE} XRGE</dd>
              </div>
              <div>
                <dt>{t("send.reviewNetwork")}</dt>
                <dd>{networkLabel(network)}</dd>
              </div>
            </dl>
            <p className="form-hint">
              {wallet && !wallet.signingPrivateKey
                ? t("send.extensionApprove")
                : t("send.signedLocally")}
            </p>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="actions">
              <Button variant="outline" onClick={reset} disabled={step === "sending"}>
                {t("send.back")}
              </Button>
              <Button onClick={send} disabled={step === "sending"}>
                {step === "sending" ? t("send.signing") : t("send.signAndSend")}
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
  if (symbol === "XRGE") return String(Math.max(0, Math.floor(raw - WALLET_TRANSFER_FEE))); // whole XRGE, after the fee
  const d = maxFractionDigits(symbol);
  return d > 0 ? String(raw / 10 ** d) : String(raw);
}
