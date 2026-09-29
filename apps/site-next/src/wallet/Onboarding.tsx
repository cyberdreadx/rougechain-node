/**
 * Create / import flow (same order as apps/web): recovery phrase → password → mail name →
 * profile → done → tour. The tour flag is shared with apps/web (see tour.ts).
 */
import { useState } from "react";
import { Button } from "@rougechain/ui";
import { mailAddresses } from "@rougechain/core/mail-name";
import { getProfileAvatar, setProfileDisplayName } from "@rougechain/core/profile";
import { useWallet, type OnboardingMode } from "./WalletProvider";
import { PhraseGrid } from "./BackupDialog";
import { CopyText } from "./parts";
import { Avatar, AvatarEditor, MailNameEditor } from "./profile";
import { notifyWalletChanged } from "./store";
import { hasSeenTour, openTour } from "./tour";
import { toast } from "./toast";

const STEPS = ["Create", "Back up", "Secure", "Mail name", "Profile", "Done"] as const;
const GENERIC_NAMES = ["my wallet", "recovered wallet", "wallet", "extension wallet", "unnamed", ""];

function StepIndicator({ index, mode }: { index: number; mode: OnboardingMode }) {
  return (
    <div className="onboarding-steps" aria-label={`Step ${index + 1} of ${STEPS.length}`}>
      <span className="mono muted">
        Step {index + 1} of {STEPS.length} · {index === 0 && mode === "import" ? "Import" : STEPS[index]}
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
  const { wallet, advanceFlow } = useWallet();
  const [saved, setSaved] = useState(false);
  const phrase = wallet?.mnemonic ?? "";
  return (
    <div className="onboarding-card surface">
      <StepIndicator index={1} mode="create" />
      <h2>Save your recovery phrase</h2>
      <p>These {phrase.split(" ").length} words are the only way to restore this wallet. Write them down in order and keep them offline.</p>
      <p className="notice warning">Anyone with these words controls your funds. RougeChain will never ask for them.</p>
      <PhraseGrid phrase={phrase} />
      <CopyText value={phrase} label="recovery phrase" display="Copy phrase" />
      <label className="check-row">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>I've saved my recovery phrase somewhere safe</span>
      </label>
      <Button disabled={!saved} onClick={() => advanceFlow("password")}>
        Continue
      </Button>
      <p className="form-hint">You can view it again later in Settings → Backup.</p>
    </div>
  );
}

/** First password: apps/web's setup (min 6 chars) → core lockUnifiedWallet + unlockUnifiedWallet. */
export function PasswordSetup({ mode }: { mode: OnboardingMode }) {
  const { setPassword, advanceFlow } = useWallet();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (pw.length < 6) return setError("Password must be at least 6 characters");
    if (pw !== pw2) return setError("Passwords don't match");
    setError("");
    setBusy(true);
    try {
      await setPassword(pw);
      toast.success("Wallet secured", { description: "Your keys are encrypted with your password." });
      advanceFlow("onboarding");
    } catch {
      setError("Couldn't encrypt the wallet — try again");
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
      <StepIndicator index={2} mode={mode} />
      <h2>Secure your wallet</h2>
      <p>Set a password to encrypt your keys in this browser (AES-256-GCM). You'll use it to unlock the wallet.</p>
      <label className="field">
        Password
        <input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </label>
      <label className="field">
        Confirm password
        <input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy || !pw || !pw2}>
        {busy ? "Encrypting…" : "Encrypt and continue"}
      </Button>
      <p className="form-hint">Your password never leaves this device.</p>
    </form>
  );
}

/** Skippable mail-name → profile → done steps (apps/web's OnboardingFlow). */
export function OnboardingSteps({ mode }: { mode: OnboardingMode }) {
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
        toast.error("Couldn't update your name", { description: e instanceof Error ? e.message : undefined });
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
        <h2>Claim your mail name</h2>
        <p>Get a memorable address for encrypted mail so people can reach you by name instead of a long key. You can always do this later in Settings.</p>
        <MailNameEditor wallet={wallet} allowChange={false} onClaimed={setMailName} />
        <Button variant={mailName ? "" : "ghost"} onClick={() => setStep("profile")}>
          {mailName ? "Continue" : "Skip for now"}
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
        <h2>Add a profile photo</h2>
        <p>Help people recognize you across chats and mail. You can change it anytime in Settings.</p>
        <AvatarEditor size={112} />
        <label className="field">
          Display name
          <input className="input" value={name} maxLength={50} placeholder="Your name" onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="actions">
          <Button type="button" variant="ghost" onClick={() => setStep("mail")}>
            Back
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : avatar || name.trim() ? "Continue" : "Skip for now"}
          </Button>
        </div>
      </form>
    );
  return (
    <div className="onboarding-card surface center">
      <StepIndicator index={5} mode={mode} />
      <Avatar uri={avatar} name={displayName} size={96} />
      <h2>You're all set</h2>
      <p>Your quantum-safe wallet is ready.</p>
      <strong>{displayName}</strong>
      {mailName &&
        mailAddresses(mailName).map((a) => (
          <span key={a} className="mono">
            {a}
          </span>
        ))}
      <Button onClick={finish}>Take the tour</Button>
      <p className="form-hint">Profile, mail name and security live in Settings.</p>
    </div>
  );
}
