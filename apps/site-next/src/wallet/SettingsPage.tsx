/**
 * Settings (parity with apps/web's Settings.tsx). Every value is read and written through
 * @rougechain/core (or apps/web's own keys where apps/web keeps them in a hook), so settings made
 * on apps/web carry over on the same origin.
 */
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { AtSign, Bell, Compass, Eye, Languages, Network, Puzzle, Shield, User } from "lucide-react";
import { Button } from "@rougechain/ui";
import { changeVaultPassword, MIN_VAULT_PASSWORD_LENGTH } from "@rougechain/core/unified-wallet";
import { siteUrlFor, type NetworkType } from "@rougechain/core/network";
import { loadNotificationSettings, requestNotificationPermission, saveNotificationSettings, type NotificationSettings } from "@rougechain/core/notifications";
import { getPrivacySettings, registerWalletOnNode, savePrivacySettings } from "@rougechain/core/pqc-messenger";
import { getMessagingIdentity } from "@rougechain/core/profile";
import { useChain } from "../explorer/chain";
import { PageHeading } from "../explorer/ui";
import { useWallet } from "./WalletProvider";
import { useExtensionProvider, useHideBalances } from "./hooks";
import { SettingRow, Toggle } from "./parts";
import { AvatarEditor, MailNameEditor, NameEditor } from "./profile";
import { BackupDialog } from "./BackupDialog";
import { openTour } from "./tour";
import { toast } from "./toast";
import { networkLabel } from "./hooks";
import { LanguageSelect } from "../i18n/LanguageSwitcher";

export const AUTO_LOCK_OPTIONS = [0, 5, 15, 30, 60];

function Section({ id, icon: Icon, title, children }: { id?: string; icon: typeof User; title: string; children: ReactNode }) {
  return (
    <section id={id} className="surface settings-section" aria-labelledby={`${id ?? title}-h`}>
      <h2 id={`${id ?? title}-h`}>
        <Icon size={16} aria-hidden="true" /> {title}
      </h2>
      {children}
    </section>
  );
}

export default function SettingsPage() {
  const { t } = useTranslation("wallet");
  const extensionProvider = useExtensionProvider();
  const w = useWallet();
  const chain = useChain();
  const { hidden, setHidden } = useHideBalances();
  const [notif, setNotif] = useState<NotificationSettings>(() => loadNotificationSettings());
  const [discoverable, setDiscoverable] = useState(() => getPrivacySettings().discoverable);
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [backup, setBackup] = useState(false);
  const wallet = w.wallet;

  const updateNotif = async (patch: Partial<NotificationSettings>) => {
    if (patch.desktopEnabled) {
      const granted = await requestNotificationPermission().catch(() => false);
      if (!granted) toast.info(t("settings.notificationsBlocked"));
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
        // Device-local messaging keys stay non-discoverable (as in apps/web).
        if (mw.signingPublicKey === wallet.signingPublicKey) await registerWalletOnNode(mw);
      } catch {
        /* applied on the next register */
      }
    }
  };

  const submitPassword = async () => {
    if (pwNew.length < MIN_VAULT_PASSWORD_LENGTH) return toast.error(t("backup.passwordMin", { count: MIN_VAULT_PASSWORD_LENGTH }));
    if (pwNew !== pwConfirm) return toast.error(t("backup.passwordMismatch"));
    setPwBusy(true);
    try {
      if (w.hasPassword) {
        await changeVaultPassword(pwCurrent, pwNew);
        toast.success(t("settings.passwordChanged"));
      } else {
        await w.setPassword(pwNew);
        toast.success(t("settings.passwordSet"));
      }
      setPwCurrent("");
      setPwNew("");
      setPwConfirm("");
    } catch (e) {
      toast.error(t("settings.passwordFailed"), { description: e instanceof Error ? e.message : undefined });
    } finally {
      setPwBusy(false);
      w.refresh();
    }
  };

  const switchTo = (n: NetworkType) => {
    if (n === chain.network) return;
    if (chain.locked) window.location.href = siteUrlFor(n) + window.location.pathname;
    else chain.setNetwork(n);
  };

  return (
    <main id="main" className="app-main wallet-main">
      <div className="container settings-container">
        <PageHeading eyebrow={t("settings.eyebrow")} title={t("settings.title")} aside={<span />}>
          {t("settings.lede")}
        </PageHeading>

        {!wallet && (
          <div className="notice">
            <span>{w.status === "locked" ? t("settings.lockedNotice") : t("settings.noWalletNotice")}</span>
            <Link className="button small" to="/wallet">
              {t("page.title")}
            </Link>
          </div>
        )}

        <Section id="profile" icon={User} title={t("settings.profile")}>
          <AvatarEditor />
          <NameEditor id="settings-name" />
        </Section>

        <Section id="mail" icon={AtSign} title={t("mailName.label")}>
          <p className="form-hint">{t("settings.mailHint")}</p>
          <MailNameEditor wallet={wallet} />
        </Section>

        <Section id="security" icon={Shield} title={t("settings.security")}>
          <SettingRow title={t("settings.autoLock")} hint={w.hasPassword ? t("settings.autoLockHint") : t("settings.setPasswordFirst")}>
            <span />
          </SettingRow>
          <div className="chip-row" role="group" aria-label={t("settings.autoLock")}>
            {AUTO_LOCK_OPTIONS.map((m) => (
              <button key={m} type="button" className={`chip ${w.autoLockMinutes === m ? "active" : ""}`} aria-pressed={w.autoLockMinutes === m} disabled={!w.hasPassword} onClick={() => w.setAutoLockMinutes(m)}>
                {m === 0 ? t("settings.never") : t("settings.minutes", { count: m })}
              </button>
            ))}
          </div>
          <form
            className="wallet-form divider"
            onSubmit={(e) => {
              e.preventDefault();
              void submitPassword();
            }}
          >
            <strong>{w.hasPassword ? t("settings.changePassword") : t("settings.setPassword")}</strong>
            {w.hasPassword && (
              <input className="input" type="password" aria-label={t("settings.currentPassword")} placeholder={t("settings.currentPassword")} autoComplete="current-password" value={pwCurrent} onChange={(e) => setPwCurrent(e.target.value)} disabled={!wallet} />
            )}
            <div className="two-fields">
              <input className="input" type="password" aria-label={t("settings.newPassword")} placeholder={t("settings.newPasswordPlaceholder")} autoComplete="new-password" value={pwNew} onChange={(e) => setPwNew(e.target.value)} disabled={!wallet} />
              <input className="input" type="password" aria-label={t("settings.confirmNewPassword")} placeholder={t("settings.confirmNewPassword")} autoComplete="new-password" value={pwConfirm} onChange={(e) => setPwConfirm(e.target.value)} disabled={!wallet} />
            </div>
            <Button type="submit" variant="outline small" disabled={!wallet || pwBusy || !pwNew || !pwConfirm || (w.hasPassword && !pwCurrent)}>
              {pwBusy ? t("profile.saving") : w.hasPassword ? t("settings.changePassword") : t("settings.setPassword")}
            </Button>
          </form>
          <div className="actions divider">
            <Button
              variant="outline small"
              disabled={!wallet || !w.hasPassword}
              title={!w.hasPassword ? t("settings.setPasswordFirst") : undefined}
              onClick={() => {
                w.lock();
                toast.success(t("lock.locked"));
              }}
            >
              {t("settings.lockNow")}
            </Button>
            <Button variant="outline small" disabled={!wallet} onClick={() => setBackup(true)}>
              {t("settings.backupButton")}
            </Button>
          </div>
          <p className="form-hint">{t("settings.backupHint")}</p>
        </Section>

        <Section id="privacy" icon={Eye} title={t("settings.privacy")}>
          <SettingRow title={t("dashboard.hideBalances")} hint={t("settings.hideBalancesHint")}>
            <Toggle label={t("dashboard.hideBalances")} checked={hidden} onChange={setHidden} />
          </SettingRow>
          <SettingRow title={t("settings.discoverable")} hint={t("settings.discoverableHint")}>
            <Toggle label={t("settings.discoverable")} checked={discoverable} onChange={toggleDiscoverable} />
          </SettingRow>
        </Section>

        <Section id="notifications" icon={Bell} title={t("settings.notifications")}>
          <SettingRow title={t("settings.notifications")} hint={t("settings.notificationsHint")}>
            <Toggle label={t("settings.notifications")} checked={notif.enabled} onChange={(v) => updateNotif({ enabled: v })} />
          </SettingRow>
          <SettingRow title={t("settings.sound")}>
            <Toggle label={t("settings.sound")} checked={notif.sound} disabled={!notif.enabled} onChange={(v) => updateNotif({ sound: v })} />
          </SettingRow>
          <SettingRow title={t("settings.desktop")} hint={t("settings.desktopHint")}>
            <Toggle label={t("settings.desktop")} checked={notif.desktopEnabled} disabled={!notif.enabled} onChange={(v) => updateNotif({ desktopEnabled: v })} />
          </SettingRow>
        </Section>

        <Section id="network" icon={Network} title={t("settings.network")}>
          <div className="mode-switch" role="group" aria-label={t("settings.network")}>
            {(["mainnet", "testnet"] as const).map((n) => (
              <Button key={n} variant={chain.network === n ? "secondary small" : "ghost small"} aria-pressed={chain.network === n} onClick={() => switchTo(n)}>
                {networkLabel(n)}
              </Button>
            ))}
          </div>
          <p className="form-hint">
            {chain.locked
              ? t("settings.networkPinned", { network: networkLabel(chain.network) })
              : t("settings.networkHint")}
          </p>
        </Section>

        <Section id="language" icon={Languages} title={t("settings.language")}>
          <SettingRow title={t("settings.languageLabel")} hint={t("settings.languageHint")}>
            <LanguageSelect />
          </SettingRow>
        </Section>

        <Section id="connected" icon={Puzzle} title={t("settings.connected")}>
          <SettingRow
            title={t("welcome.extensionTitle")}
            hint={w.isExtension ? t("settings.extensionConnected") : extensionProvider ? t("settings.extensionDetected") : t("settings.extensionMissing")}
          >
            <span className={`status ${w.isExtension || extensionProvider ? "live" : "loading"}`}>{w.isExtension || extensionProvider ? t("settings.detected") : t("settings.none")}</span>
          </SettingRow>
          <SettingRow title="Base" hint={t("settings.baseHint")}>
            <Link className="button ghost small" to="/wallet">
              {t("page.title")}
            </Link>
          </SettingRow>
        </Section>

        <Section id="help" icon={Compass} title={t("settings.help")}>
          <SettingRow title={t("tour.replay")} hint={t("settings.tourHint")}>
            <Button variant="outline small" onClick={openTour}>
              {t("tour.replay")}
            </Button>
          </SettingRow>
        </Section>
      </div>
      {backup && wallet && <BackupDialog open onClose={() => setBackup(false)} />}
    </main>
  );
}
