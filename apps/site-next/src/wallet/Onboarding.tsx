/**
 * Create / import flow (same order as apps/web): recovery phrase → password → mail name →
 * profile → done → tour. The tour flag is shared with apps/web (see tour.ts).
 */
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@rougechain/ui";
import { mailAddresses } from "@rougechain/core/mail-name";
import { MIN_VAULT_PASSWORD_LENGTH } from "@rougechain/core/unified-wallet";
import { getProfileAvatar, setProfileDisplayName } from "@rougechain/core/profile";
import { useWallet, type OnboardingMode } from "./WalletProvider";
import { PhraseGrid } from "./BackupDialog";
import { CopyText } from "./parts";
import { Avatar, AvatarEditor, MailNameEditor } from "./profile";
import { notifyWalletChanged } from "./store";
import { hasSeenTour, openTour } from "./tour";
import { toast } from "./toast";

const STEPS = ["create", "backup", "secure", "mailName", "profile", "done"] as const;
const GENERIC_NAMES = ["my wallet", "recovered wallet", "wallet", "extension wallet", "unnamed", ""];

function StepIndicator({ index, mode }: { index: number; mode: OnboardingMode }) {
  const { t } = useTranslation("wallet");
  const step = t("onboarding.step", { current: index + 1, total: STEPS.length });
  return (
    <div className="onboarding-steps" aria-label={step}>
      <span className="mono muted">
        {step} · {index === 0 && mode === "import" ? t("onboarding.steps.import") : t(`onboarding.steps.${STEPS[index]}`)}
      </span>
      <ol>
        {STEPS.map((s, i) => (
          <li key={s} className={i < index ? "done" : i === index ? "active" : ""} />
        ))}
      </ol>
    </div>
  );
}

export function SeedReveal() {
  const { t } = useTranslation("wallet");
  const { wallet, advanceFlow } = useWallet();
  const [saved, setSaved] = useState(false);
  const phrase = wallet?.mnemonic ?? "";
  return (
    <div className="onboarding-card surface">
      <StepIndicator index={1} mode="create" />
      <h2>{t("onboarding.seed.title")}</h2>
      <p>{t("onboarding.seed.body", { words: phrase.split(" ").length })}</p>
      <p className="notice warning">{t("onboarding.seed.warning")}</p>
      <PhraseGrid phrase={phrase} />
      <CopyText value={phrase} label={t("copy.recoveryPhrase")} display={t("backup.copyPhrase")} />
      <label className="check-row">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>{t("onboarding.seed.confirm")}</span>
      </label>
      <Button disabled={!saved} onClick={() => advanceFlow("password")}>
        {t("onboarding.continue")}
      </Button>
      <p className="form-hint">{t("onboarding.seed.later")}</p>
    </div>
  );
}

/**
 * New vault password (+ confirmation), min MIN_VAULT_PASSWORD_LENGTH (8) → WalletProvider.setPassword
 * (core lockUnifiedWallet + unlockUnifiedWallet: encrypted blob only, plaintext copies removed).
 * Shared by the onboarding password step and the SecureWalletGate.
 */
export function NewPasswordForm({
  header,
  submitLabel,
  onSecured,
}: {
  header: ReactNode;
  submitLabel: string;
  onSecured: () => void;
}) {
  const { t } = useTranslation("wallet");
  const { setPassword } = useWallet();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (pw.length < MIN_VAULT_PASSWORD_LENGTH) return setError(t("backup.passwordMin", { count: MIN_VAULT_PASSWORD_LENGTH }));
    if (pw !== pw2) return setError(t("backup.passwordMismatch"));
    setError("");
    setBusy(true);
    try {
      await setPassword(pw);
      onSecured();
    } catch {
      setError(t("onboarding.password.failed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="onboarding-card surface"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {header}
      <label className="field">
        {t("unlock.password")}
        <input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </label>
      <label className="field">
        {t("backup.confirmPassword")}
        <input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy || !pw || !pw2}>
        {busy ? t("backup.encrypting") : submitLabel}
      </Button>
      <p className="form-hint">{t("onboarding.password.hint")}</p>
    </form>
  );
}

/** Mandatory first password of a created / imported wallet (it is saved only once encrypted). */
export function PasswordSetup({ mode }: { mode: OnboardingMode }) {
  const { t } = useTranslation("wallet");
  const { advanceFlow } = useWallet();
  return (
    <NewPasswordForm
      header={
        <>
          <StepIndicator index={2} mode={mode} />
          <h2>{t("onboarding.password.title")}</h2>
          <p>{t("onboarding.password.body")}</p>
          <p className="notice">{t("onboarding.password.required")}</p>
        </>
      }
      submitLabel={t("onboarding.password.submit")}
      onSecured={() => {
        toast.success(t("onboarding.password.secured"), { description: t("onboarding.password.securedBody") });
        advanceFlow("onboarding");
      }}
    />
  );
}

/** Skippable mail-name → profile → done steps (apps/web's OnboardingFlow). */
export function OnboardingSteps({ mode }: { mode: OnboardingMode }) {
  const { t } = useTranslation("wallet");
  const { wallet, displayName, advanceFlow } = useWallet();
  const [step, setStep] = useState<"mail" | "profile" | "done">("mail");
  const [mailName, setMailName] = useState<string | null>(null);
  const [name, setName] = useState(() => (GENERIC_NAMES.includes((displayName ?? "").trim().toLowerCase()) ? "" : (displayName ?? "")));
  const [saving, setSaving] = useState(false);
  const avatar = getProfileAvatar(wallet);

  const saveProfile = async () => {
    const clean = name.trim();
    if (clean && clean !== displayName) {
      setSaving(true);
      try {
        await setProfileDisplayName(clean);
        notifyWalletChanged();
      } catch (e) {
        toast.error(t("profile.nameFailed"), { description: e instanceof Error ? e.message : undefined });
        setSaving(false);
        return;
      }
      setSaving(false);
    }
    setStep("done");
  };

  const finish = () => {
    advanceFlow(null);
    if (!hasSeenTour()) window.setTimeout(openTour, 350);
  };

  if (step === "mail")
    return (
      <div className="onboarding-card surface">
        <StepIndicator index={3} mode={mode} />
        <h2>{t("onboarding.mail.title")}</h2>
        <p>{t("onboarding.mail.body")}</p>
        <MailNameEditor wallet={wallet} allowChange={false} onClaimed={setMailName} />
        <Button variant={mailName ? "" : "ghost"} onClick={() => setStep("profile")}>
          {mailName ? t("onboarding.continue") : t("onboarding.skip")}
        </Button>
      </div>
    );
  if (step === "profile")
    return (
      <form
        className="onboarding-card surface"
        onSubmit={(e) => {
          e.preventDefault();
          void saveProfile();
        }}
      >
        <StepIndicator index={4} mode={mode} />
        <h2>{t("onboarding.profile.title")}</h2>
        <p>{t("onboarding.profile.body")}</p>
        <AvatarEditor size={112} />
        <label className="field">
          {t("profile.displayName")}
          <input className="input" value={name} maxLength={50} placeholder={t("profile.namePlaceholder")} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="actions">
          <Button type="button" variant="ghost" onClick={() => setStep("mail")}>
            {t("send.back")}
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? t("profile.saving") : avatar || name.trim() ? t("onboarding.continue") : t("onboarding.skip")}
          </Button>
        </div>
      </form>
    );
  return (
    <div className="onboarding-card surface center">
      <StepIndicator index={5} mode={mode} />
      <Avatar uri={avatar} name={displayName} size={96} />
      <h2>{t("onboarding.done.title")}</h2>
      <p>{t("onboarding.done.body")}</p>
      <strong>{displayName}</strong>
      {mailName &&
        mailAddresses(mailName).map((a) => (
          <span key={a} className="mono">
            {a}
          </span>
        ))}
      <Button onClick={finish}>{t("onboarding.done.tour")}</Button>
      <p className="form-hint">{t("onboarding.done.hint")}</p>
    </div>
  );
}
