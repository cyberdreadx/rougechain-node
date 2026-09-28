import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AtSign, Check, KeyRound, Loader2, PartyPopper, Shield, Sparkles, User, Wallet as WalletIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AvatarEditor } from "@/components/profile/AvatarEditor";
import { MailNameEditor } from "@/components/profile/MailNameEditor";
import { WalletAvatar } from "@/components/WalletAvatar";
import { useMyProfile } from "@/hooks/use-my-profile";
import { mailAddresses } from "@/lib/mail-name";
import { setProfileDisplayName } from "@/lib/profile";
import { hasSeenTour, openTour, setOnboardingActive } from "@/lib/tour";
import { cn } from "@/lib/utils";

type StepId = "wallet" | "backup" | "secure" | "mail" | "profile" | "done";

const STEPS: Array<{ id: StepId; icon: typeof User }> = [
  { id: "wallet", icon: WalletIcon },
  { id: "backup", icon: KeyRound },
  { id: "secure", icon: Shield },
  { id: "mail", icon: AtSign },
  { id: "profile", icon: User },
  { id: "done", icon: Sparkles },
];

const GENERIC_NAMES = ["my wallet", "recovered wallet", "wallet", "extension wallet", "unnamed", ""];

interface OnboardingFlowProps {
  /** "create" came through the recovery-phrase reveal; "import" restored an existing wallet. */
  mode: "create" | "import";
  onFinish: () => void;
}

/**
 * Post-create / post-import walkthrough (Qwalla's welcome → mail-name → avatar
 * flow). The wallet / backup / password steps already happened in Wallet.tsx;
 * this picks up at the skippable mail-name and profile steps.
 */
export function OnboardingFlow({ mode, onFinish }: OnboardingFlowProps) {
  const { t } = useTranslation();
  const me = useMyProfile();
  const [step, setStep] = useState<StepId>("mail");
  const [mailName, setMailName] = useState<string | null>(null);
  const [name, setName] = useState(() => (GENERIC_NAMES.includes((me.displayName ?? "").trim().toLowerCase()) ? "" : me.displayName ?? ""));
  const [savingName, setSavingName] = useState(false);

  useEffect(() => {
    setOnboardingActive(true);
    return () => setOnboardingActive(false);
  }, []);

  const idx = STEPS.findIndex((s) => s.id === step);

  const saveProfileAndContinue = async () => {
    const clean = name.trim();
    if (clean && clean !== me.displayName) {
      setSavingName(true);
      try {
        await setProfileDisplayName(clean);
      } catch (e) {
        toast.error(t("profile.name.failed"), { description: e instanceof Error ? e.message : undefined });
        setSavingName(false);
        return;
      }
      setSavingName(false);
    }
    setStep("done");
  };

  const finish = () => {
    setOnboardingActive(false);
    onFinish();
    if (!hasSeenTour()) window.setTimeout(openTour, 350);
  };

  return (
    <div className="min-h-screen">
      <div className="max-w-md mx-auto px-4 py-8 sm:py-12">
        {/* Step indicator */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <span className="hud-label">{t("onboarding.stepOf", { current: idx + 1, total: STEPS.length })}</span>
            <span className="text-xs text-muted-foreground">{t(`onboarding.steps.${step}`)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {STEPS.map((s, i) => {
              const done = i < idx;
              const active = i === idx;
              const Icon = s.icon;
              const label = s.id === "wallet" ? t(mode === "import" ? "onboarding.steps.imported" : "onboarding.steps.wallet") : t(`onboarding.steps.${s.id}`);
              return (
                <div key={s.id} className="flex flex-1 items-center gap-1.5 last:flex-none" title={label}>
                  <motion.div
                    animate={{ scale: active ? 1.12 : 1 }}
                    className={cn(
                      "grid h-7 w-7 shrink-0 place-items-center rounded-full border text-[10px] transition-colors",
                      done && "border-primary/60 bg-primary/20 text-primary",
                      active && "border-primary bg-primary text-primary-foreground shadow-[0_0_14px_hsl(var(--primary)/0.6)]",
                      !done && !active && "border-border bg-card/60 text-muted-foreground",
                    )}
                  >
                    {done ? <Check className="w-3.5 h-3.5" /> : <Icon className="w-3.5 h-3.5" />}
                  </motion.div>
                  {i < STEPS.length - 1 && (
                    <div className="h-px flex-1 bg-border overflow-hidden">
                      <motion.div className="h-full bg-primary" initial={false} animate={{ width: done ? "100%" : "0%" }} transition={{ duration: 0.4 }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="relative rounded-2xl bg-card/60 backdrop-blur-xl border border-border/60 hud-corners p-6 sm:p-8 overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={step}
              initial={{ opacity: 0, x: 32 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -32 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
            >
              {step === "mail" && (
                <div className="space-y-5">
                  <div className="text-center space-y-2">
                    <div className="mx-auto action-chip !w-14 !h-14 bg-gradient-to-br from-primary to-accent">
                      <AtSign className="w-6 h-6" />
                    </div>
                    <h2 className="text-2xl font-bold">{t("onboarding.mail.title")}</h2>
                    <p className="text-sm text-muted-foreground leading-relaxed">{t("onboarding.mail.subtitle")}</p>
                  </div>
                  <MailNameEditor wallet={me.wallet} allowChange={false} onClaimed={setMailName} />
                  <div className="flex gap-2 pt-1">
                    <Button variant="ghost" className="flex-1" onClick={() => setStep("profile")}>
                      {mailName ? t("onboarding.continue") : t("onboarding.skip")}
                    </Button>
                    {mailName && (
                      <Button className="flex-1" onClick={() => setStep("profile")}>{t("onboarding.continue")}</Button>
                    )}
                  </div>
                </div>
              )}

              {step === "profile" && (
                <div className="space-y-5">
                  <div className="text-center space-y-2">
                    <h2 className="text-2xl font-bold">{t("onboarding.profile.title")}</h2>
                    <p className="text-sm text-muted-foreground leading-relaxed">{t("onboarding.profile.subtitle")}</p>
                  </div>
                  <AvatarEditor size={112} layout="stack" />
                  <div className="space-y-1.5">
                    <label className="hud-label" htmlFor="onb-name">{t("profile.name.label")}</label>
                    <Input
                      id="onb-name"
                      value={name}
                      maxLength={50}
                      onChange={(e) => setName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && saveProfileAndContinue()}
                      placeholder={t("profile.name.placeholder")}
                      className="cyber-input"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button variant="ghost" className="flex-1" onClick={() => setStep("mail")}>{t("common.back")}</Button>
                    <Button className="flex-1" onClick={saveProfileAndContinue} disabled={savingName}>
                      {savingName && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
                      {me.avatar || name.trim() ? t("onboarding.continue") : t("onboarding.skip")}
                    </Button>
                  </div>
                </div>
              )}

              {step === "done" && (
                <div className="space-y-5 text-center">
                  <motion.div initial={{ scale: 0.6, rotate: -8 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: "spring", stiffness: 220, damping: 14 }} className="flex justify-center">
                    <WalletAvatar id={me.signingPublicKey} uri={me.avatar} name={me.displayName} size={96} ring />
                  </motion.div>
                  <div className="space-y-2">
                    <h2 className="text-2xl font-bold text-shimmer inline-flex items-center gap-2">
                      <PartyPopper className="w-6 h-6 text-primary" /> {t("onboarding.done.title")}
                    </h2>
                    <p className="text-sm text-muted-foreground">{t("onboarding.done.subtitle")}</p>
                  </div>
                  <div className="space-y-1 text-sm">
                    <p className="font-medium">{me.displayName}</p>
                    {mailName && mailAddresses(mailName).map((a) => (
                      <p key={a} className="font-mono text-xs text-primary">{a}</p>
                    ))}
                  </div>
                  <Button className="w-full" onClick={finish}>{t("onboarding.done.cta")}</Button>
                  <p className="text-xs text-muted-foreground">{t("onboarding.done.settingsHint")}</p>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

export default OnboardingFlow;
