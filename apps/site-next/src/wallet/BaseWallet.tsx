/**
 * The wallet's Base (Ethereum L2) account: same recovery phrase, standard Ethereum path — the
 * address Qwalla shows. Derivation, fee quotes and signing are core's evm-wallet / base-wallet.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Dialog, Button } from "@rougechain/ui";
import { formatUnits, type Hex } from "viem";
import { deriveBaseAddress, hasBaseAccount } from "@rougechain/core/evm-wallet";
import {
  baseAddressUrl,
  basePriceUsd,
  baseTxUrl,
  buildSendCall,
  checkBaseAddress,
  fetchBaseBalances,
  formatBaseUnits,
  getBaseChain,
  maxSendableEth,
  quoteBaseFee,
  signAndSendBase,
  toBaseUnits,
  type BaseAssetSymbol,
  type BaseBalance,
  type BaseChainInfo,
  type BaseFeeQuote,
} from "@rougechain/core/base-wallet";
import { formatUsd } from "@rougechain/core/price-service";
import type { NetworkType } from "@rougechain/core/network";
import { MASKED_AMOUNT } from "./hooks";
import { CopyText, TokenIcon } from "./parts";
import { useQr } from "./ReceiveDialog";

/** Base address for a phrase; derivation (BIP-39 PBKDF2) runs after the first paint. */
export function useBaseAddress(mnemonic: string | null | undefined): { address: `0x${string}` | null; ready: boolean; hasAccount: boolean } {
  const hasAccount = useMemo(() => hasBaseAccount(mnemonic), [mnemonic]);
  const [derived, setDerived] = useState<{ m: string; address: `0x${string}` | null } | null>(null);
  useEffect(() => {
    if (!hasAccount || !mnemonic) return;
    const id = window.setTimeout(() => {
      let address: `0x${string}` | null = null;
      try {
        address = deriveBaseAddress(mnemonic);
      } catch {
        address = null;
      }
      setDerived({ m: mnemonic, address });
    }, 0);
    return () => window.clearTimeout(id);
  }, [mnemonic, hasAccount]);
  const current = derived && derived.m === mnemonic ? derived : null;
  return { address: current?.address ?? null, ready: !hasAccount || !!current, hasAccount };
}

export function BaseWalletCard({
  mnemonic,
  network,
  ethPriceUsd,
  xrgePriceUsd,
  hidden,
}: {
  mnemonic?: string | null;
  network: NetworkType;
  ethPriceUsd: number | null;
  xrgePriceUsd: number | null;
  hidden: boolean;
}) {
  const { t } = useTranslation("wallet");
  const chain = useMemo(() => getBaseChain(network), [network]);
  const { address, ready, hasAccount } = useBaseAddress(mnemonic);
  const q = useQuery({
    queryKey: ["wallet", "base-balances", chain.chainId, address],
    enabled: !!address,
    queryFn: () => fetchBaseBalances(chain, address!),
    refetchInterval: 30_000,
    retry: false,
  });
  const [dialog, setDialog] = useState<"send" | "receive" | null>(null);
  const balances = q.data ?? null;
  const rows = (balances ?? []).map((b) => {
    const price = basePriceUsd(chain, b.asset.symbol, ethPriceUsd, xrgePriceUsd);
    const human = b.raw == null ? null : Number(formatUnits(b.raw, b.asset.decimals));
    return { ...b, amount: b.raw == null ? "—" : formatBaseUnits(b.raw, b.asset.decimals, b.asset.decimals === 6 ? 2 : 6), usd: human != null && price != null ? human * price : null };
  });
  const total = chain.isMainnet && rows.length ? rows.reduce((s, r) => s + (r.usd ?? 0), 0) : null;

  return (
    <section className="surface wallet-panel" aria-labelledby="base-wallet-title">
      <div className="panel-head">
        <h2 id="base-wallet-title">{t("base.title")}</h2>
        <span className={`pill ${chain.isMainnet ? "" : "warning"}`}>{chain.isMainnet ? chain.name : t("base.testnetPill", { chain: chain.name })}</span>
        {total != null && !hidden && <span className="mono muted panel-total">{formatUsd(total)}</span>}
      </div>
      {!hasAccount ? (
        <div className="empty-state compact">
          <h3>{t("base.noAccountTitle")}</h3>
          <p>{t("base.noAccountBody")}</p>
        </div>
      ) : !ready || !address ? (
        <p className="muted">{t("base.deriving")}</p>
      ) : (
        <>
          <CopyText value={address} label={t("copy.baseAddress")} />
          <p className="form-hint">
            {t("base.sameAsQwalla")}{" "}
            <a className="inline-link" href={baseAddressUrl(chain, address)} target="_blank" rel="noreferrer">
              {t("base.viewOnBaseScan")}
            </a>
          </p>
          {q.isError && <p className="form-hint error">{t("base.unreachable", { chain: chain.name })}</p>}
          <ul className="asset-rows">
            {rows.map((r) => (
              <li key={r.asset.symbol}>
                <TokenIcon symbol={r.asset.symbol} />
                <div className="asset-name">
                  <strong>{r.asset.name}</strong>
                  <small>{r.asset.symbol}</small>
                </div>
                <div className="asset-amount">
                  <strong className="mono">{hidden ? MASKED_AMOUNT : r.amount}</strong>
                  {r.usd != null && <small className="mono">{hidden ? `$${MASKED_AMOUNT}` : formatUsd(r.usd)}</small>}
                </div>
              </li>
            ))}
          </ul>
          <div className="actions">
            <Button variant="outline small" onClick={() => setDialog("send")} disabled={!balances}>
              {t("dashboard.send")}
            </Button>
            <Button variant="outline small" onClick={() => setDialog("receive")}>
              {t("dashboard.receive")}
            </Button>
          </div>
          <BaseReceiveDialog open={dialog === "receive"} onClose={() => setDialog(null)} chain={chain} address={address} />
          {balances && mnemonic && (
            <BaseSendDialog
              open={dialog === "send"}
              onClose={() => setDialog(null)}
              chain={chain}
              address={address}
              mnemonic={mnemonic}
              balances={balances}
              ethPriceUsd={ethPriceUsd}
              xrgePriceUsd={xrgePriceUsd}
              onSent={() => void q.refetch()}
            />
          )}
        </>
      )}
    </section>
  );
}

function BaseReceiveDialog({ open, onClose, chain, address }: { open: boolean; onClose: () => void; chain: BaseChainInfo; address: string }) {
  const { t } = useTranslation("wallet");
  const qr = useQr(open ? address : null);
  return (
    <Dialog open={open} onClose={onClose} title={t("base.receiveTitle", { chain: chain.name })}>
      <div className="receive-body">
        <div className="qr-frame">{qr ? <img src={qr} alt={t("base.qrAlt")} width={220} height={220} /> : <span className="muted">{t("receive.generating")}</span>}</div>
        <CopyText value={address} label={t("copy.baseAddress")} />
        <p className="notice warning">
          {chain.isMainnet
            ? t("base.receiveMainnet", { chain: chain.name })
            : t("base.receiveTestnet", { chain: chain.name })}
        </p>
      </div>
    </Dialog>
  );
}

type Step = "form" | "review" | "sending" | "done";

/** Base send: form → fee quote review → local sign (core) → broadcast. */
export function BaseSendDialog({
  open,
  onClose,
  chain,
  address,
  mnemonic,
  balances,
  ethPriceUsd,
  xrgePriceUsd,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  chain: BaseChainInfo;
  address: `0x${string}`;
  /** Read only at signing time; never stored or logged. */
  mnemonic: string;
  balances: BaseBalance[];
  ethPriceUsd: number | null;
  xrgePriceUsd: number | null;
  onSent?: (hash: string) => void;
}) {
  const { t } = useTranslation("wallet");
  const [symbol, setSymbol] = useState<BaseAssetSymbol>("ETH");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<Step>("form");
  const [fee, setFee] = useState<BaseFeeQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hash, setHash] = useState<Hex | null>(null);

  const current = balances.find((b) => b.asset.symbol === symbol) ?? balances[0];
  const asset = current.asset;
  const balanceRaw = current.raw ?? 0n;
  const ethRaw = balances.find((b) => b.asset.symbol === "ETH")?.raw ?? 0n;
  const price = basePriceUsd(chain, symbol, ethPriceUsd, xrgePriceUsd);
  const addrCheck = checkBaseAddress(recipient);
  const units = useMemo(() => {
    try {
      return amount.trim() ? toBaseUnits(amount, asset.decimals) : null;
    } catch {
      return null;
    }
  }, [amount, asset.decimals]);
  const amountError =
    amount.trim() && (units == null || units <= 0n) ? t("base.errors.amountPositive") : units != null && units > balanceRaw ? t("base.errors.notEnough", { symbol }) : null;
  const recipientError =
    addrCheck === "invalid"
      ? t("base.errors.invalidAddress")
      : addrCheck === "bad-checksum"
        ? t("base.errors.checksum")
        : null;
  const canReview = addrCheck === "ok" && units != null && units > 0n && !amountError && !busy;
  const ethNeeded = (symbol === "ETH" ? (units ?? 0n) : 0n) + (fee?.totalFeeWei ?? 0n);
  const gasShort = fee != null && ethNeeded > ethRaw;

  const close = () => {
    if (step === "sending") return;
    setStep("form");
    setFee(null);
    setError(null);
    setHash(null);
    setAmount("");
    setRecipient("");
    onClose();
  };

  const pickMax = async () => {
    setError(null);
    if (asset.token) return setAmount(formatUnits(balanceRaw, asset.decimals));
    setBusy(true);
    try {
      const q = await quoteBaseFee(chain, address, buildSendCall(asset, addrCheck === "ok" ? recipient : address, 0n));
      const max = maxSendableEth(balanceRaw, q);
      setAmount(max > 0n ? formatUnits(max, 18) : "0");
      if (max === 0n) setError(t("base.errors.feeShortBy", { fee: formatBaseUnits(q.totalFeeWei, 18, 8) }));
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
      setFee(await quoteBaseFee(chain, address, buildSendCall(asset, recipient, units)));
    } catch (e) {
      setError(t("base.errors.estimate") + (e instanceof Error ? ` (${e.message})` : ""));
    } finally {
      setBusy(false);
      setStep("review");
    }
  };

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

  const warning = (
    <p className="notice warning">
      {chain.isMainnet
        ? t("base.warnMainnet")
        : t("base.warnTestnet")}
    </p>
  );

  return (
    <Dialog open={open} onClose={close} title={step === "done" ? t("base.sentTitle") : step === "form" ? t("base.sendTitle", { chain: chain.name }) : t("base.confirmTitle")}>
      {step === "form" && (
        <form
          className="wallet-form"
          onSubmit={(e) => {
            e.preventDefault();
            void review();
          }}
        >
          {warning}
          <div className="mode-switch" role="group" aria-label={t("base.asset")}>
            {balances.map((b) => (
              <Button
                type="button"
                key={b.asset.symbol}
                variant={b.asset.symbol === symbol ? "secondary small" : "ghost small"}
                aria-pressed={b.asset.symbol === symbol}
                onClick={() => {
                  setSymbol(b.asset.symbol);
                  setAmount("");
                  setError(null);
                }}
              >
                {b.asset.symbol} · {b.raw == null ? "—" : formatBaseUnits(b.raw, b.asset.decimals, 4)}
              </Button>
            ))}
          </div>
          <label className="field">
            {t("base.recipient")}
            <input className="input mono" value={recipient} onChange={(e) => setRecipient(e.target.value.trim())} placeholder="0x…" autoComplete="off" spellCheck={false} />
          </label>
          {recipientError && <p className="form-hint error">{recipientError}</p>}
          {addrCheck === "ok" && recipient.toLowerCase() === address.toLowerCase() && <p className="form-hint">{t("base.ownAddress")}</p>}
          <label className="field">
            <span className="field-row">
              {t("send.amount")}
              <button type="button" className="inline-link" onClick={pickMax} disabled={busy}>
                {t("base.max")}
              </button>
            </span>
            <input className="input mono" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(",", "."))} placeholder="0.0" />
          </label>
          {amountError && <p className="form-hint error">{amountError}</p>}
          {asset.token && <p className="form-hint">{t("base.feesInEth")}</p>}
          {error && <p className="form-error">{error}</p>}
          <Button type="submit" disabled={!canReview}>
            {busy ? t("base.estimating") : t("send.review")}
          </Button>
        </form>
      )}
      {(step === "review" || step === "sending") && units != null && (
        <div className="wallet-form">
          {warning}
          <dl className="review-list">
            <div>
              <dt>{t("send.reviewSend")}</dt>
              <dd className="mono">
                {formatBaseUnits(units, asset.decimals, 8)} {symbol}
                {price != null && ` · ${formatUsd(Number(formatUnits(units, asset.decimals)) * price)}`}
              </dd>
            </div>
            <div>
              <dt>{t("base.from")}</dt>
              <dd className="mono">{address}</dd>
            </div>
            <div>
              <dt>{t("send.reviewTo")}</dt>
              <dd className="mono">{recipient}</dd>
            </div>
            <div>
              <dt>{t("send.reviewNetwork")}</dt>
              <dd>{chain.name}</dd>
            </div>
            <div>
              <dt>{t("base.maxFee")}</dt>
              <dd className="mono">{fee ? `${formatBaseUnits(fee.totalFeeWei, 18, 8)} ETH` : "—"}</dd>
            </div>
          </dl>
          {gasShort && <p className="form-error">{t("base.errors.feeShort")}</p>}
          {error && <p className="form-error">{error}</p>}
          <p className="form-hint">{t("base.signedLocally")}</p>
          <div className="actions">
            <Button variant="outline" onClick={() => setStep("form")} disabled={step === "sending"}>
              {t("send.back")}
            </Button>
            <Button onClick={send} disabled={!fee || gasShort || step === "sending"}>
              {step === "sending" ? t("base.sending") : t("base.signAndSend")}
            </Button>
          </div>
        </div>
      )}
      {step === "done" && hash && (
        <div className="wallet-form">
          <p>{t("base.confirmSoon", { chain: chain.name })}</p>
          <a className="inline-link mono" href={baseTxUrl(chain, hash)} target="_blank" rel="noreferrer">
            {hash.slice(0, 18)}… ↗
          </a>
          <Button onClick={close}>{t("base.done")}</Button>
        </div>
      )}
    </Dialog>
  );
}
