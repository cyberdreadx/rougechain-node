import { useState } from "react";
import { Button, Dialog } from "@rougechain/ui";
import { formatStake, getTierFromStake, STAKE_REQUIREMENTS } from "@rougechain/core/pqc-validators";
import { getNetworkLabel } from "@rougechain/core/network";
import { formatIdentity } from "@rougechain/core/address";
import { toast } from "../wallet/toast";
import { useTranslation } from "react-i18next";
import { useNetworkLabel } from "./common";
import {
  checkStake,
  checkUnstake,
  maxStake,
  STAKE_FEE,
  submitStake,
  submitUnstake,
  TIERS,
  type StakeWallet,
} from "./validators-data";

type Step = "form" | "review" | "signing";
/** Amounts being reviewed / signed stay exact en-US (never localised). */
const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * Stake / unstake with an explicit review step before anything is signed. Signing happens in
 * core (local ML-DSA-65 key, or the RougeChain extension when the wallet has no local key).
 */
export function StakeDialog({
  mode,
  open,
  wallet,
  available,
  staked,
  onClose,
  onDone,
}: {
  mode: "stake" | "unstake";
  open: boolean;
  wallet: StakeWallet;
  available: number;
  staked: number;
  onClose: () => void;
  onDone: (amount: number) => void;
}) {
  const { t } = useTranslation("pages");
  const networkLabel = useNetworkLabel();
  const [input, setInput] = useState("");
  const [step, setStep] = useState<Step>("form");
  const [error, setError] = useState("");
  const isStake = mode === "stake";
  const check = input ? (isStake ? checkStake(input, available, staked) : checkUnstake(input, staked, available)) : null;
  const amount = check?.ok ? check.amount : 0;
  const resulting = isStake ? staked + amount : staked - amount;

  const close = () => {
    if (step === "signing") return;
    setStep("form");
    setError("");
    setInput("");
    onClose();
  };
  const sign = async () => {
    if (!check?.ok) return;
    setStep("signing");
    setError("");
    try {
      if (isStake) await submitStake(wallet, check.amount);
      else await submitUnstake(wallet, check.amount);
      toast.success(t(isStake ? "staking.staked" : "staking.unstaked", { amount: fmt(check.amount) }), {
        description: t("staking.submitted"),
      });
      setStep("form");
      setInput("");
      onDone(check.amount);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("staking.failed"));
      setStep("review");
    }
  };

  const title = step === "form" ? t(isStake ? "staking.stakeTitle" : "staking.unstakeTitle") : t("staking.reviewTitle");
  return (
    <Dialog open={open} onClose={close} title={title}>
      {step === "form" ? (
        <form
          className="wallet-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (check?.ok) setStep("review");
          }}
        >
          {isStake && (
            <div className="rc-tier-pick" role="group" aria-label={t("staking.tier")}>
              {TIERS.map((tier) => {
                const need = Math.max(0, STAKE_REQUIREMENTS[tier] - staked);
                const affordable = need > 0 && need + STAKE_FEE <= available;
                return (
                  <button
                    type="button"
                    key={tier}
                    className={getTierFromStake(resulting) === tier && amount > 0 ? "active" : ""}
                    disabled={!affordable}
                    onClick={() => setInput(String(need))}
                  >
                    <strong>{t(`validators.tiers.${tier}`)}</strong>
                    <small className="mono">{formatStake(STAKE_REQUIREMENTS[tier])} XRGE</small>
                  </button>
                );
              })}
            </div>
          )}
          <label className="field">
            <span className="field-row">
              {t("staking.amount")}
              <button
                type="button"
                className="inline-link"
                onClick={() => setInput(String(isStake ? maxStake(available) : staked))}
              >
                {t("staking.max", { amount: fmt(isStake ? maxStake(available) : staked) })}
              </button>
            </span>
            <input
              className="input mono"
              inputMode="numeric"
              value={input}
              onChange={(e) => setInput(e.target.value.trim())}
              placeholder={isStake ? fmt(STAKE_REQUIREMENTS.standard) : "0"}
              autoComplete="off"
              aria-invalid={check ? !check.ok : undefined}
            />
          </label>
          {check && !check.ok && <p className="form-hint error">{check.error}</p>}
          <p className="form-hint">
            {t("staking.balances", { available: fmt(available), staked: fmt(staked), network: networkLabel(getNetworkLabel()) })}
          </p>
          <div className="actions">
            <Button type="button" variant="outline" onClick={close}>
              {t("staking.cancel")}
            </Button>
            <Button type="submit" disabled={!check?.ok}>
              {t("staking.review")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="wallet-form">
          <dl className="review-list">
            <div>
              <dt>{t("staking.rows.action")}</dt>
              <dd>{t(isStake ? "staking.rows.stake" : "staking.rows.unstake")}</dd>
            </div>
            <div>
              <dt>{t("staking.rows.amount")}</dt>
              <dd className="mono">{fmt(amount)} XRGE</dd>
            </div>
            <div>
              <dt>{t("staking.rows.from")}</dt>
              <dd className="mono" title={wallet.signingPublicKey}>
                {formatIdentity(wallet.signingPublicKey)}
              </dd>
            </div>
            <div>
              <dt>{t(isStake ? "staking.rows.tier" : "staking.rows.remaining")}</dt>
              <dd className="mono">
                {isStake ? t(`validators.tiers.${getTierFromStake(resulting)}`) : `${fmt(resulting)} XRGE`}
              </dd>
            </div>
            <div>
              <dt>{t("staking.rows.fee")}</dt>
              <dd className="mono">{STAKE_FEE} XRGE</dd>
            </div>
            <div>
              <dt>{t("staking.rows.network")}</dt>
              <dd>{networkLabel(getNetworkLabel())}</dd>
            </div>
          </dl>
          <p className="form-hint">{isStake ? t("staking.nodeKeyWarning") : resulting < STAKE_REQUIREMENTS.standard ? t("staking.unstakeWarning") : ""}</p>
          <p className="form-hint">{wallet.signingPrivateKey ? t("staking.localSign") : t("staking.extensionSign")}</p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <Button variant="outline" onClick={() => setStep("form")} disabled={step === "signing"}>
              {t("staking.back")}
            </Button>
            <Button onClick={sign} disabled={step === "signing"}>
              {step === "signing" ? t("staking.signing") : isStake ? t("staking.sign") : t("staking.signUnstake")}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
