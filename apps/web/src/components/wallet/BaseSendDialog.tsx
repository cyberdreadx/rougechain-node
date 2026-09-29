import { useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, ExternalLink, Loader2, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatUnits, getAddress, type Hex } from "viem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TokenIcon } from "@/components/ui/token-icon";
import { formatUsd } from "@/lib/price-service";
import {
  basePriceUsd,
  baseTxUrl,
  buildSendCall,
  checkBaseAddress,
  formatBaseUnits,
  maxSendableEth,
  quoteBaseFee,
  signAndSendBase,
  toBaseUnits,
  type BaseAssetSymbol,
  type BaseBalance,
  type BaseChainInfo,
  type BaseFeeQuote,
} from "@/lib/base-wallet";
import { BaseModal } from "./BaseReceiveDialog";

interface BaseSendDialogProps {
  chain: BaseChainInfo;
  address: `0x${string}`;
  /** Only read at signing time; never stored or logged. */
  mnemonic: string;
  balances: BaseBalance[];
  ethPriceUsd: number | null;
  xrgePriceUsd: number | null;
  onClose: () => void;
  onSent?: (hash: string) => void;
}

type Step = "form" | "review" | "sending" | "done";

const BaseSendDialog = ({ chain, address, mnemonic, balances, ethPriceUsd, xrgePriceUsd, onClose, onSent }: BaseSendDialogProps) => {
  const { t } = useTranslation();
  const [symbol, setSymbol] = useState<BaseAssetSymbol>("ETH");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<Step>("form");
  const [fee, setFee] = useState<BaseFeeQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hash, setHash] = useState<Hex | null>(null);

  const current = balances.find((b) => b.asset.symbol === symbol)!;
  const asset = current.asset;
  const balanceRaw = current.raw ?? 0n;
  const ethRaw = balances.find((b) => b.asset.symbol === "ETH")?.raw ?? 0n;
  const price = basePriceUsd(chain, symbol, ethPriceUsd, xrgePriceUsd);
  const ethPrice = basePriceUsd(chain, "ETH", ethPriceUsd, xrgePriceUsd);

  const addrCheck = checkBaseAddress(recipient);
  const units = useMemo(() => {
    try { return amount.trim() ? toBaseUnits(amount, asset.decimals) : null; } catch { return null; }
  }, [amount, asset.decimals]);
  const amountError = amount.trim() && (units == null || units <= 0n)
    ? t("base.sendDialog.invalidAmount")
    : units != null && units > balanceRaw
      ? t("base.sendDialog.insufficient", { symbol })
      : null;
  const recipientError = addrCheck === "invalid"
    ? t("base.sendDialog.invalidAddress")
    : addrCheck === "bad-checksum"
      ? t("base.sendDialog.badChecksum")
      : null;
  const selfSend = addrCheck === "ok" && recipient.trim().toLowerCase() === address.toLowerCase();
  const canReview = addrCheck === "ok" && units != null && units > 0n && !amountError && !busy;

  const human = (raw: bigint, decimals: number, frac = 6) => formatBaseUnits(raw, decimals, frac);
  const usd = (raw: bigint, decimals: number, p: number | null) => (p == null ? null : Number(formatUnits(raw, decimals)) * p);

  const pickMax = async () => {
    setError(null);
    if (asset.token) { setAmount(formatUnits(balanceRaw, asset.decimals)); return; }
    // Native ETH: leave room for the network fee of a plain transfer.
    setBusy(true);
    try {
      const to = addrCheck === "ok" ? recipient : address;
      const q = await quoteBaseFee(chain, address, buildSendCall(asset, to, 0n));
      const max = maxSendableEth(balanceRaw, q);
      setAmount(max > 0n ? formatUnits(max, 18) : "0");
      if (max === 0n) setError(t("base.sendDialog.gasShort", { fee: human(q.totalFeeWei, 18, 8) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const review = async () => {
    if (!canReview || units == null) return;
    setBusy(true);
    setError(null);
    setFee(null);
    try {
      const q = await quoteBaseFee(chain, address, buildSendCall(asset, recipient, units));
      setFee(q);
    } catch (e) {
      // Estimation fails when the transfer would revert — show it on the review step.
      setError(t("base.sendDialog.feeUnavailable") + (e instanceof Error ? ` (${e.message})` : ""));
    } finally {
      setBusy(false);
      setStep("review");
    }
  };

  const ethNeeded = (symbol === "ETH" ? units ?? 0n : 0n) + (fee?.totalFeeWei ?? 0n);
  const gasShort = fee != null && ethNeeded > ethRaw;

  const send = async () => {
    if (!fee || units == null || gasShort) return;
    setStep("sending");
    setError(null);
    try {
      const h = await signAndSendBase({ chain, mnemonic, from: address, call: buildSendCall(asset, recipient, units), fee });
      setHash(h);
      setStep("done");
      onSent?.(h);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("review");
    }
  };

  const networkWarning = (
    <div className="flex gap-2 p-3 rounded-xl border border-amber-500/40 bg-amber-500/10 text-xs text-amber-600 dark:text-amber-400">
      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
      <span>{chain.isMainnet ? t("base.sendDialog.mainnetWarning") : t("base.sendDialog.testnetWarning")}</span>
    </div>
  );

  const title = step === "done" ? t("base.sendDialog.sentTitle") : step === "form" ? t("base.sendDialog.title", { chain: chain.name }) : t("base.sendDialog.confirmTitle");

  return (
    <BaseModal title={title} onClose={onClose} dismissable={step !== "sending"}>
      {step === "form" && (
        <div className="space-y-4">
          {networkWarning}

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("base.sendDialog.asset")}</Label>
            <div className="grid grid-cols-3 gap-2">
              {balances.map((b) => {
                const active = b.asset.symbol === symbol;
                return (
                  <button
                    key={b.asset.symbol}
                    type="button"
                    onClick={() => { setSymbol(b.asset.symbol); setAmount(""); setError(null); }}
                    className={`flex flex-col items-center gap-1 rounded-xl border px-2 py-2.5 transition-colors ${active ? "border-primary bg-primary/10" : "border-border bg-card/40 hover:border-primary/40"}`}
                    aria-pressed={active}
                  >
                    <TokenIcon symbol={b.asset.symbol} size={24} />
                    <span className="text-xs font-semibold text-foreground">{b.asset.symbol}</span>
                    <span className="text-[10px] font-mono text-muted-foreground truncate max-w-full">
                      {b.raw == null ? "—" : human(b.raw, b.asset.decimals, 4)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="base-recipient" className="text-xs text-muted-foreground">{t("base.sendDialog.recipient")}</Label>
            <Input
              id="base-recipient"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value.trim())}
              placeholder="0x…"
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-sm"
            />
            {recipientError && <p className="text-xs text-destructive">{recipientError}</p>}
            {selfSend && <p className="text-xs text-amber-500">{t("base.sendDialog.selfSend")}</p>}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="base-amount" className="text-xs text-muted-foreground">{t("base.sendDialog.amount")}</Label>
              <span className="text-xs text-muted-foreground font-mono">
                {t("base.sendDialog.balance", { amount: human(balanceRaw, asset.decimals), symbol })}
              </span>
            </div>
            <div className="flex gap-2">
              <Input
                id="base-amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(",", "."))}
                placeholder="0.0"
                inputMode="decimal"
                autoComplete="off"
                className="font-mono"
              />
              <Button type="button" variant="outline" onClick={pickMax} disabled={busy || balanceRaw === 0n}>
                {t("base.sendDialog.max")}
              </Button>
            </div>
            {amountError && <p className="text-xs text-destructive">{amountError}</p>}
            {units != null && units > 0n && price != null && !amountError && (
              <p className="text-xs text-muted-foreground">≈ {formatUsd(usd(units, asset.decimals, price))}</p>
            )}
            {asset.token && <p className="text-[11px] text-muted-foreground">{t("base.sendDialog.tokenGasNote")}</p>}
          </div>

          {error && <p className="text-xs text-destructive break-words">{error}</p>}

          <Button className="w-full h-11" onClick={review} disabled={!canReview}>
            {busy ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />{t("base.sendDialog.estimating")}</> : t("base.sendDialog.review")}
          </Button>
        </div>
      )}

      {(step === "review" || step === "sending") && units != null && (
        <div className="space-y-4">
          <div className="text-center py-2">
            <div className="flex items-center justify-center gap-2">
              <TokenIcon symbol={symbol} size={28} />
              <span className="text-2xl font-bold font-mono text-foreground break-all">{human(units, asset.decimals, asset.decimals)}</span>
              <span className="text-lg text-muted-foreground">{symbol}</span>
            </div>
            {price != null && <p className="text-sm text-muted-foreground mt-1">≈ {formatUsd(usd(units, asset.decimals, price))}</p>}
          </div>

          <dl className="rounded-xl border border-border divide-y divide-border/60 text-xs">
            <div className="flex justify-between gap-3 p-3">
              <dt className="text-muted-foreground shrink-0">{t("base.sendDialog.from")}</dt>
              <dd className="font-mono text-foreground break-all text-right">{address}</dd>
            </div>
            <div className="flex justify-between gap-3 p-3">
              <dt className="text-muted-foreground shrink-0">{t("base.sendDialog.to")}</dt>
              <dd className="font-mono text-foreground break-all text-right">{getAddress(recipient)}</dd>
            </div>
            <div className="flex justify-between gap-3 p-3">
              <dt className="text-muted-foreground shrink-0">{t("base.sendDialog.network")}</dt>
              <dd className="text-foreground text-right">{chain.name} ({chain.chainId})</dd>
            </div>
            <div className="flex justify-between gap-3 p-3">
              <dt className="text-muted-foreground shrink-0">{t("base.sendDialog.networkFee")}</dt>
              <dd className="font-mono text-foreground text-right">
                {fee ? (
                  <>
                    ~{human(fee.totalFeeWei, 18, 8)} ETH
                    {ethPrice != null && <span className="block text-muted-foreground">≈ {formatUsd(usd(fee.totalFeeWei, 18, ethPrice))}</span>}
                  </>
                ) : "—"}
              </dd>
            </div>
          </dl>

          {gasShort && fee && (
            <p className="text-xs text-destructive">{t("base.sendDialog.gasShort", { fee: human(fee.totalFeeWei, 18, 8) })}</p>
          )}
          {error && <p className="text-xs text-destructive break-words">{error}</p>}

          {networkWarning}
          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-0.5 text-primary" />
            {t("base.sendDialog.localSign")}
          </p>

          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={() => { setStep("form"); setError(null); }} disabled={step === "sending"} className="gap-1">
              <ArrowLeft className="w-4 h-4" /> {t("base.sendDialog.back")}
            </Button>
            <Button onClick={send} disabled={step === "sending" || !fee || gasShort}>
              {step === "sending" ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />{t("base.sendDialog.sending")}</> : t("base.sendDialog.confirm")}
            </Button>
          </div>
        </div>
      )}

      {step === "done" && hash && (
        <div className="space-y-4 text-center">
          <CheckCircle2 className="w-12 h-12 text-success mx-auto" />
          <p className="text-sm text-muted-foreground">{t("base.sendDialog.sentHint", { chain: chain.name })}</p>
          <p className="font-mono text-xs text-foreground break-all p-3 rounded-xl bg-secondary/50 border border-border select-all">{hash}</p>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" className="gap-2" asChild>
              <a href={baseTxUrl(chain, hash)} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="w-4 h-4" /> BaseScan
              </a>
            </Button>
            <Button onClick={onClose}>{t("base.sendDialog.done")}</Button>
          </div>
        </div>
      )}
    </BaseModal>
  );
};

export default BaseSendDialog;
