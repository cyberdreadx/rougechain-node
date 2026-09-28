import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AtSign, Bell, Check, Compass, Eye, FileKey2, Globe, KeyRound, Languages, Loader2, Lock, Network, Puzzle, Save, Shield, User,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import WalletBackup from "@/components/wallet/WalletBackup";
import { AvatarEditor } from "@/components/profile/AvatarEditor";
import { MailNameEditor } from "@/components/profile/MailNameEditor";
import { useMyProfile } from "@/hooks/use-my-profile";
import { useHideBalances } from "@/hooks/use-hide-balances";
import { SUPPORTED_LANGUAGES } from "@/i18n";
import { getActiveNetwork, getNetworkLock, switchNetwork, type NetworkType } from "@/lib/network";
import { loadNotificationSettings, requestNotificationPermission, saveNotificationSettings, type NotificationSettings } from "@/lib/notifications";
import { getPrivacySettings, registerWalletOnNode, savePrivacySettings } from "@/lib/pqc-messenger";
import { getMessagingIdentity, setProfileDisplayName } from "@/lib/profile";
import { openTour } from "@/lib/tour";
import {
  autoLockWallet, changeVaultPassword, getVaultSettings, hasEncryptedWallet, lockUnifiedWallet, saveUnifiedWallet,
  saveVaultSettings, unlockUnifiedWallet, type UnifiedWallet,
} from "@/lib/unified-wallet";
import { cn } from "@/lib/utils";

const AUTO_LOCK_OPTIONS = [0, 5, 15, 30, 60];

function Section({ icon: Icon, title, children, delay = 0 }: { icon: typeof User; title: string; children: React.ReactNode; delay?: number }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.3 }}
      className="rounded-2xl bg-card/60 backdrop-blur border border-border/60 p-4 sm:p-5 space-y-4"
    >
      <h2 className="hud-label flex items-center gap-2">
        <Icon className="w-3.5 h-3.5" /> {title}
      </h2>
      {children}
    </motion.section>
  );
}

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** One place for profile, mail name, network, notifications, privacy, security, language and help. */
const Settings = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const me = useMyProfile();
  const wallet = me.wallet;
  const { hidden: balancesHidden, toggle: toggleBalancesHidden } = useHideBalances();

  const [name, setName] = useState(me.displayName ?? "");
  const [savingName, setSavingName] = useState(false);
  useEffect(() => { setName(me.displayName ?? ""); }, [me.displayName]);

  const [notif, setNotif] = useState<NotificationSettings>(() => loadNotificationSettings());
  const [discoverable, setDiscoverable] = useState(() => getPrivacySettings().discoverable);
  const [autoLock, setAutoLock] = useState(() => getVaultSettings().autoLockMinutes);
  const [encrypted, setEncrypted] = useState(() => hasEncryptedWallet());
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [showBackup, setShowBackup] = useState(false);

  const network = getActiveNetwork();
  const networkLock = getNetworkLock();
  const langCode = (i18n.resolvedLanguage || i18n.language || "en").slice(0, 2);
  const isExtensionWallet = !!wallet && !wallet.signingPrivateKey;
  const extensionDetected = typeof window !== "undefined" && !!(window as unknown as { rougechain?: { isRougeChain?: boolean } }).rougechain?.isRougeChain;

  const saveName = async () => {
    const clean = name.trim();
    if (!clean || clean === me.displayName) return;
    setSavingName(true);
    try {
      await setProfileDisplayName(clean);
      toast.success(t("profile.name.saved"));
    } catch (e) {
      toast.error(t("profile.name.failed"), { description: e instanceof Error ? e.message : undefined });
    } finally {
      setSavingName(false);
    }
  };

  const updateNotif = async (patch: Partial<NotificationSettings>) => {
    if (patch.desktopEnabled) {
      const granted = await requestNotificationPermission().catch(() => false);
      if (!granted) toast.info(t("settings.notifications.permissionDenied"));
    }
    const next = { ...notif, ...patch };
    setNotif(next);
    saveNotificationSettings(next);
  };

  const toggleDiscoverable = async (enabled: boolean) => {
    setDiscoverable(enabled);
    savePrivacySettings({ ...getPrivacySettings(), discoverable: enabled });
    if (wallet) {
      try {
        const mw = await getMessagingIdentity(wallet);
        // Device-local messaging keys stay non-discoverable (see resolveMessagingWallet).
        if (mw.signingPublicKey === wallet.signingPublicKey) await registerWalletOnNode(mw);
      } catch { /* applied on the next register */ }
    }
  };

  const updateAutoLock = (minutes: number) => {
    setAutoLock(minutes);
    saveVaultSettings({ ...getVaultSettings(), autoLockMinutes: minutes });
  };

  const submitPassword = async () => {
    if (pwNew.length < 8) { toast.error(t("settings.security.tooShort")); return; }
    if (pwNew !== pwConfirm) { toast.error(t("settings.security.mismatch")); return; }
    setPwBusy(true);
    try {
      if (encrypted) {
        await changeVaultPassword(pwCurrent, pwNew);
        toast.success(t("settings.security.passwordChanged"));
      } else {
        // Same as the wallet page's first-time password setup.
        await lockUnifiedWallet(pwNew);
        await unlockUnifiedWallet(pwNew);
        setEncrypted(true);
        toast.success(t("settings.security.passwordSet"));
      }
      setPwCurrent(""); setPwNew(""); setPwConfirm("");
      me.refresh();
    } catch (e) {
      toast.error(t("settings.security.passwordFailed"), { description: e instanceof Error ? e.message : undefined });
    } finally {
      setPwBusy(false);
    }
  };

  const lockNow = () => {
    autoLockWallet();
    toast.success(t("wallet.toasts.locked"));
    navigate("/wallet");
  };

  return (
    <div className="min-h-screen">
      <main className="max-w-2xl mx-auto px-4 py-6 sm:py-10 space-y-4">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-2">
          <p className="hud-label mb-1.5">{t("visual.eyebrow.settings")}</p>
          <h1 className="text-3xl font-bold text-shimmer">{t("settings.title")}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t("settings.subtitle")}</p>
        </motion.div>

        {!wallet && (
          <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4 text-sm flex items-center justify-between gap-3">
            <span className="text-muted-foreground">{me.signingPublicKey ? t("settings.lockedHint") : t("settings.noWalletHint")}</span>
            <Button size="sm" asChild><Link to="/wallet">{t("nav.wallet")}</Link></Button>
          </div>
        )}

        {/* Profile */}
        <Section icon={User} title={t("settings.sections.profile")}>
          <AvatarEditor />
          <div className="space-y-1.5">
            <label htmlFor="settings-name" className="text-xs text-muted-foreground">{t("profile.name.label")}</label>
            <div className="flex gap-2">
              <Input
                id="settings-name"
                value={name}
                maxLength={50}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveName()}
                placeholder={t("profile.name.placeholder")}
                className="cyber-input"
                disabled={!wallet}
              />
              <Button onClick={saveName} disabled={!wallet || savingName || !name.trim() || name.trim() === me.displayName}>
                {savingName ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                <span className="ml-1.5 hidden sm:inline">{t("profile.name.save")}</span>
              </Button>
            </div>
          </div>
        </Section>

        {/* Mail name */}
        <Section icon={AtSign} title={t("settings.sections.mail")} delay={0.04}>
          <p className="text-xs text-muted-foreground">{t("settings.mail.hint")}</p>
          <MailNameEditor wallet={wallet} />
        </Section>

        {/* Security */}
        <Section icon={Shield} title={t("settings.sections.security")} delay={0.08}>
          <Row title={t("settings.security.autoLock")} hint={encrypted ? t("settings.security.autoLockHint") : t("settings.security.needsPassword")}>
            <span />
          </Row>
          <div className="flex flex-wrap gap-2">
            {AUTO_LOCK_OPTIONS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => updateAutoLock(m)}
                disabled={!encrypted}
                className={cn(
                  "px-3 py-1.5 rounded-full text-xs border transition-colors disabled:opacity-40",
                  autoLock === m ? "border-primary bg-primary/15 text-primary" : "border-border/60 text-muted-foreground hover:text-foreground",
                )}
              >
                {m === 0 ? t("settings.security.never") : t("settings.security.minutes", { count: m })}
              </button>
            ))}
          </div>

          <div className="space-y-2 pt-2 border-t border-border/50">
            <p className="text-sm font-medium">{encrypted ? t("settings.security.changePassword") : t("settings.security.setPassword")}</p>
            {encrypted && (
              <Input type="password" autoComplete="current-password" placeholder={t("settings.security.current")} value={pwCurrent} onChange={(e) => setPwCurrent(e.target.value)} className="cyber-input" disabled={!wallet} />
            )}
            <div className="grid gap-2 sm:grid-cols-2">
              <Input type="password" autoComplete="new-password" placeholder={t("settings.security.new")} value={pwNew} onChange={(e) => setPwNew(e.target.value)} className="cyber-input" disabled={!wallet} />
              <Input type="password" autoComplete="new-password" placeholder={t("settings.security.confirm")} value={pwConfirm} onChange={(e) => setPwConfirm(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitPassword()} className="cyber-input" disabled={!wallet} />
            </div>
            <Button size="sm" onClick={submitPassword} disabled={!wallet || pwBusy || !pwNew || !pwConfirm || (encrypted && !pwCurrent)}>
              {pwBusy ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <KeyRound className="w-4 h-4 mr-1.5" />}
              {encrypted ? t("settings.security.changePassword") : t("settings.security.setPassword")}
            </Button>
          </div>

          <div className="flex flex-wrap gap-2 pt-2 border-t border-border/50">
            <Button size="sm" variant="outline" onClick={lockNow} disabled={!wallet || !encrypted} title={!encrypted ? t("settings.security.needsPassword") : undefined}>
              <Lock className="w-4 h-4 mr-1.5" /> {t("settings.security.lockNow")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowBackup(true)} disabled={!wallet}>
              <FileKey2 className="w-4 h-4 mr-1.5" /> {t("settings.security.backup")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("settings.security.backupHint")}</p>
        </Section>

        {/* Privacy */}
        <Section icon={Eye} title={t("settings.sections.privacy")} delay={0.12}>
          <Row title={t("settings.privacy.hideBalances")} hint={t("settings.privacy.hideBalancesHint")}>
            <Switch checked={balancesHidden} onCheckedChange={toggleBalancesHidden} />
          </Row>
          <Row title={t("settings.privacy.discoverable")} hint={t("settings.privacy.discoverableHint")}>
            <Switch checked={discoverable} onCheckedChange={toggleDiscoverable} />
          </Row>
        </Section>

        {/* Notifications */}
        <Section icon={Bell} title={t("settings.sections.notifications")} delay={0.16}>
          <Row title={t("settings.notifications.enabled")} hint={t("settings.notifications.enabledHint")}>
            <Switch checked={notif.enabled} onCheckedChange={(v) => updateNotif({ enabled: v })} />
          </Row>
          <Row title={t("settings.notifications.sound")}>
            <Switch checked={notif.sound} disabled={!notif.enabled} onCheckedChange={(v) => updateNotif({ sound: v })} />
          </Row>
          <Row title={t("settings.notifications.desktop")} hint={t("settings.notifications.desktopHint")}>
            <Switch checked={notif.desktopEnabled} disabled={!notif.enabled} onCheckedChange={(v) => updateNotif({ desktopEnabled: v })} />
          </Row>
        </Section>

        {/* Network */}
        <Section icon={Network} title={t("settings.sections.network")} delay={0.2}>
          <div className="grid grid-cols-2 gap-2">
            {(["mainnet", "testnet"] as NetworkType[]).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => n !== network && switchNetwork(n)}
                className={cn(
                  "rounded-xl border px-3 py-3 text-sm font-medium transition-colors flex items-center justify-center gap-2",
                  n === network ? "border-primary bg-primary/10 text-primary" : "border-border/60 text-muted-foreground hover:text-foreground hover:border-border",
                )}
              >
                {n === network && <Check className="w-4 h-4" />}
                {t(`common.${n}`)}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {networkLock ? t("settings.network.lockedHint", { network: t(`common.${networkLock}`) }) : t("settings.network.hint")}
          </p>
        </Section>

        {/* Language */}
        <Section icon={Languages} title={t("settings.sections.language")} delay={0.24}>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {SUPPORTED_LANGUAGES.map((l) => (
              <button
                key={l.code}
                type="button"
                lang={l.code}
                onClick={() => void i18n.changeLanguage(l.code)}
                className={cn(
                  "rounded-xl border px-3 py-2.5 text-sm transition-colors",
                  l.code === langCode ? "border-primary bg-primary/10 text-primary" : "border-border/60 text-muted-foreground hover:text-foreground",
                )}
              >
                {l.label}
              </button>
            ))}
          </div>
        </Section>

        {/* Connected */}
        <Section icon={Puzzle} title={t("settings.sections.connected")} delay={0.28}>
          <Row
            title={t("settings.connected.extension")}
            hint={isExtensionWallet ? t("settings.connected.viaExtension") : extensionDetected ? t("settings.connected.detected") : t("settings.connected.notDetected")}
          >
            <span className={cn("inline-block h-2.5 w-2.5 rounded-full", extensionDetected || isExtensionWallet ? "bg-success shadow-[0_0_8px_hsl(var(--success))]" : "bg-muted-foreground/40")} />
          </Row>
          <Row title={t("settings.connected.base")} hint={t("settings.connected.baseHint")}>
            <Button size="sm" variant="ghost" asChild><Link to="/bridge"><Globe className="w-4 h-4 mr-1.5" />{t("nav.bridge")}</Link></Button>
          </Row>
        </Section>

        {/* Help */}
        <Section icon={Compass} title={t("settings.sections.help")} delay={0.32}>
          <Row title={t("tour.replay")} hint={t("settings.help.tourHint")}>
            <Button size="sm" variant="outline" onClick={openTour}>{t("tour.replay")}</Button>
          </Row>
        </Section>
      </main>

      <AnimatePresence>
        {showBackup && wallet && (
          <WalletBackup
            wallet={wallet}
            onClose={() => setShowBackup(false)}
            onImport={(w: UnifiedWallet) => {
              saveUnifiedWallet(w);
              me.refresh();
              toast.success(t("settings.security.imported"));
            }}
            onLocked={() => navigate("/wallet")}
            vaultSettings={{ autoLockMinutes: autoLock }}
            onUpdateVaultSettings={(s) => updateAutoLock(s.autoLockMinutes)}
          />
        )}
      </AnimatePresence>
    </div>
  );
};

export default Settings;
