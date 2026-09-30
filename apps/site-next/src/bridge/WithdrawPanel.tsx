/** Withdrawals out of RougeChain: XRGE / qETH / qUSDC → Base, qBTC → Bitcoin (signed intent, 0.1 XRGE fee). */
import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@rougechain/ui";
import type { BridgeConfig } from "@rougechain/core/bridge";
import { toast } from "../wallet/toast";
import { shortAddr } from "./BaseConnect";
import {
  BTC_PAYOUT_EST_VBYTES,
  btcReceiveEstimateSats,
  btcWithdrawLimits,
  estimateBtcNetworkFeeSats,
  fetchRecommendedBtcFeeRate,
  isBtcWithdrawAllowed,
} from "./btc-fee";
import { errorMessage, withdrawFromRougeChain, type WithdrawWallet } from "./flows";
import { assetDef, BRIDGE_FEE_XRGE, formatUnits, parseBtcAddress, parseEvmAddress, parseWithdrawAmount, type BridgeAsset, type BtcNetwork } from "./validate";
import { S, fmt } from "./strings";

/**
 * qBTC → BTC payouts need the BTC relayer. Same gate as apps/web: off unless the build sets
 * VITE_BTC_WITHDRAW_ENABLED=true, and the paused notice shows while it's off.
 */
export function btcWithdrawEnabled(): boolean {
  return import.meta.env.VITE_BTC_WITHDRAW_ENABLED === "true";
}

const sats = (n: number) => formatUnits(n, 8);
const btcFixed = (n: number) => (n / 1e8).toFixed(8);

export interface L1Balances {
  /** XRGE in whole-XRGE float (node format); tokens in raw units. null until loaded. */
  XRGE: number | null;
  qETH: number | null;
  qUSDC: number | null;
  qBTC: number | null;
}

export function WithdrawPanel({
  asset,
  config,
  btcNetwork,
  chainLabel,
  chainId,
  networkLabel,
  wallet,
  balances,
  myBaseAddress,
  available,
  onDone,
}: {
  asset: BridgeAsset;
  config: BridgeConfig;
  btcNetwork: BtcNetwork;
  chainLabel: string;
  chainId: number;
  networkLabel: string;
  wallet: WithdrawWallet;
  balances: L1Balances;
  myBaseAddress: string | null;
  /** The node has this asset's bridge configured (XRGE: /bridge/xrge/config; others: /bridge/config). */
  available: boolean;
  onDone: () => void;
}) {
  const def = assetDef(asset);
  const isBtc = asset === "BTC";
  const [amount, setAmount] = useState("");
  const [dest, setDest] = useState("");
  const [stage, setStage] = useState<"form" | "review" | "running">("form");
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  const [reviewed, setReviewed] = useState<{ units: number; destination: string } | null>(null);

  const [prevAsset, setPrevAsset] = useState(asset);
  if (prevAsset !== asset) {
    setPrevAsset(asset);
    setAmount("");
    setDest(asset === "BTC" || prevAsset === "BTC" ? "" : dest);
    setStage("form");
    setError("");
  }

  const enabled = !isBtc || btcWithdrawEnabled();
  const limits = btcWithdrawLimits(config);
  const feeRate = useQuery({
    queryKey: ["bridge", "btc-fee-rate", btcNetwork],
    queryFn: () => fetchRecommendedBtcFeeRate(btcNetwork),
    enabled: isBtc,
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
  });
  const feeEst = isBtc ? estimateBtcNetworkFeeSats(feeRate.data ?? null, limits.maxNetworkFeeSats) : null;

  const parsed = amount ? parseWithdrawAmount(asset, amount) : null;
  const units = parsed?.ok ? parsed.value : 0;
  const belowMin = isBtc && units > 0 && !isBtcWithdrawAllowed(units, limits);
  const l1Key = def.l1Label as keyof L1Balances;
  const balance = balances[l1Key];
  const xrge = balances.XRGE;

  const balanceError = (): string | null => {
    if (!parsed?.ok) return null;
    if (asset === "XRGE") {
      if (xrge !== null && units + BRIDGE_FEE_XRGE > xrge + 1e-9) return units > xrge ? fmt(S.errors.insufficientBalance, { symbol: "XRGE" }) : S.errors.insufficientFee;
      return null;
    }
    if (balance !== null && units > balance) return fmt(S.errors.insufficientBalance, { symbol: def.l1Label });
    if (xrge !== null && xrge + 1e-9 < BRIDGE_FEE_XRGE) return S.errors.insufficientFee;
    return null;
  };
  const balErr = balanceError();
  const destCheck = dest.trim() ? (isBtc ? parseBtcAddress(dest, btcNetwork) : parseEvmAddress(dest)) : null;

  const review = () => {
    setError("");
    if (!enabled) return setError(S.btcWithdraw.paused);
    const a = parseWithdrawAmount(asset, amount);
    if (!a.ok) return setError(a.error);
    if (isBtc && !isBtcWithdrawAllowed(a.value, limits)) return setError(fmt(S.errors.btcBelowMinimum, { min: btcFixed(limits.minSats) }));
    if (balErr) return setError(balErr);
    const d = isBtc ? parseBtcAddress(dest, btcNetwork) : parseEvmAddress(dest);
    if (!d.ok) return setError(d.error);
    setReviewed({ units: a.value, destination: d.value });
    setStage("review");
  };

  const confirm = async () => {
    if (!reviewed) return;
    setStage("running");
    setError("");
    try {
      const outcome = await withdrawFromRougeChain({ asset, amountUnits: reviewed.units, destination: reviewed.destination, wallet }, { onStep: setStep });
      toast.success(outcome.message);
      setAmount("");
      setStage("form");
      onDone();
    } catch (e) {
      setError(errorMessage(e, S.errors.withdrawFailed));
      setStage("review");
    } finally {
      setStep("");
    }
  };

  const maxValue = (): string | null => {
    if (asset === "XRGE") return xrge !== null ? String(Math.max(0, Math.floor(xrge - BRIDGE_FEE_XRGE))) : null;
    return balance !== null ? formatUnits(balance, def.decimals) : null;
  };
  const balanceLabel = balance !== null ? `${asset === "XRGE" ? String(balance) : formatUnits(balance, def.decimals)} ${def.l1Label}` : "—";
  const toChain = isBtc ? "Bitcoin" : chainLabel;

  if (stage !== "form" && reviewed) {
    const receive = isBtc
      ? feeEst !== null
        ? `≈ ${btcFixed(btcReceiveEstimateSats(reviewed.units, feeEst))} BTC`
        : `${sats(reviewed.units)} BTC − ${S.btcWithdraw.networkFee.toLowerCase()}`
      : `${formatUnits(reviewed.units, def.decimals)} ${def.label}`;
    return (
      <div className="wallet-form" aria-live="polite">
        <h3 className="bridge-step-title">{S.review.title}</h3>
        <dl className="review-list">
          <div>
            <dt>{S.review.youSend}</dt>
            <dd className="mono">
              {formatUnits(reviewed.units, def.decimals)} {def.l1Label} · RougeChain
            </dd>
          </div>
          <div>
            <dt>{S.review.youReceive}</dt>
            <dd className="mono">
              {receive} · {toChain}
            </dd>
          </div>
          {isBtc && (
            <div>
              <dt>{S.review.networkFeeDeducted}</dt>
              <dd className="mono">{feeEst !== null ? `≈ ${btcFixed(feeEst)} BTC (max ${btcFixed(limits.maxNetworkFeeSats)})` : S.btcWithdraw.feeUnavailable}</dd>
            </div>
          )}
          <div>
            <dt>{S.review.to}</dt>
            <dd className="mono">{reviewed.destination}</dd>
          </div>
          <div>
            <dt>{S.review.fee}</dt>
            <dd className="mono">{S.form.feeValue}</dd>
          </div>
          <div>
            <dt>{S.review.network}</dt>
            <dd>
              {networkLabel} → {isBtc ? `Bitcoin ${btcNetwork}` : `${chainLabel} (${chainId})`}
            </dd>
          </div>
        </dl>
        <p className="form-hint">{wallet.privateKey ? S.review.withdrawLocal : S.review.withdrawExtension}</p>
        <p className="bridge-callout warning">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>{S.review.irreversible}</span>
        </p>
        {stage === "running" && (
          <p className="bridge-progress" role="status">
            <span className="spin-dot" aria-hidden="true" /> {step || S.processing}
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <Button variant="outline" type="button" disabled={stage === "running"} onClick={() => setStage("form")}>
            {S.form.back}
          </Button>
          <Button type="button" disabled={stage === "running"} onClick={() => void confirm()}>
            {stage === "running" ? S.processing : S.review.confirmWithdraw}
          </Button>
        </div>
      </div>
    );
  }

  if (!available) return <p className="bridge-callout">{asset === "XRGE" ? S.errors.xrgeNotConfigured : S.errors.notConfigured}</p>;

  const max = maxValue();
  return (
    <form
      className="wallet-form"
      onSubmit={(e) => {
        e.preventDefault();
        review();
      }}
    >
      <label className="field">
        <span className="field-row">
          {fmt(S.form.from, { chain: "RougeChain" })}
          <span className="bridge-sub">{fmt(S.form.balance, { balance: balanceLabel })}</span>
        </span>
        <span className="bridge-amount">
          <input
            className="input mono"
            inputMode="decimal"
            aria-label={`${S.form.amount} (${def.l1Label})`}
            placeholder={def.decimals ? "0.0" : "0"}
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value.replace(",", "."));
              setError("");
            }}
            autoComplete="off"
          />
          <span className="bridge-unit">{def.l1Label}</span>
        </span>
      </label>
      {max && (
        <button type="button" className="inline-link bridge-max" onClick={() => setAmount(max)}>
          {S.form.max} {max} {def.l1Label}
        </button>
      )}
      {parsed && !parsed.ok && <p className="form-hint error">{parsed.error}</p>}
      {balErr && <p className="form-hint error">{balErr}</p>}

      <label className="field">
        {isBtc ? S.form.receiveAtBitcoin : S.form.receiveAtBase}
        <input
          className="input mono"
          value={dest}
          onChange={(e) => setDest(e.target.value)}
          placeholder={isBtc ? (btcNetwork === "testnet" ? S.form.btcTestnetAddressPlaceholder : S.form.btcAddressPlaceholder) : "0x…"}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      {destCheck && !destCheck.ok && <p className="form-hint error">{destCheck.error}</p>}
      {!isBtc && myBaseAddress && (
        <button type="button" className="inline-link bridge-max" onClick={() => setDest(myBaseAddress)}>
          {S.form.useMyBaseAddress} ({shortAddr(myBaseAddress)})
        </button>
      )}

      {isBtc && (
        <dl className="review-list bridge-btc-fee" aria-label="Bitcoin withdrawal fee">
          <div>
            <dt>{S.btcWithdraw.minimum}</dt>
            <dd className={`mono ${belowMin ? "error-text" : ""}`}>{btcFixed(limits.minSats)} BTC</dd>
          </div>
          <div>
            <dt>{S.btcWithdraw.networkFee}</dt>
            <dd className="mono">{feeEst === null ? S.btcWithdraw.feeUnavailable : `≈ ${btcFixed(feeEst)} BTC`}</dd>
          </div>
          {units > 0 && feeEst !== null && (
            <div>
              <dt>{S.btcWithdraw.youReceive}</dt>
              <dd className="mono">≈ {btcFixed(btcReceiveEstimateSats(units, feeEst))} BTC</dd>
            </div>
          )}
        </dl>
      )}
      {isBtc && <p className="form-hint">{fmt(S.btcWithdraw.feeNote, { vbytes: BTC_PAYOUT_EST_VBYTES, max: btcFixed(limits.maxNetworkFeeSats) })}</p>}
      {belowMin && (
        <p className="form-hint error" role="alert">
          {fmt(S.errors.btcBelowMinimum, { min: btcFixed(limits.minSats) })}
        </p>
      )}
      {!enabled && (
        <p className="bridge-callout warning" role="status">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>{S.btcWithdraw.paused}</span>
        </p>
      )}

      <p className="form-hint">
        {S.form.fee}: {S.form.feeValue}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" disabled={!enabled || !parsed?.ok || belowMin || !!balErr || !destCheck?.ok}>
        {S.form.review}
      </Button>
      <p className="form-hint">{isBtc ? S.info.withdrawBtc : S.info.withdrawEvm}</p>
    </form>
  );
}
