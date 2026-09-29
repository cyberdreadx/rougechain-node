/**
 * Settings (parity with apps/web's Settings.tsx). Every value is read and written through
 * @rougechain/core (or apps/web's own keys where apps/web keeps them in a hook), so settings made
 * on apps/web carry over on the same origin.
 */
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { AtSign, Bell, Compass, Eye, Languages, Network, Puzzle, Shield, User } from "lucide-react";
import { Button } from "@rougechain/ui";
import { changeVaultPassword } from "@rougechain/core/unified-wallet";
import { siteUrlFor, type NetworkType } from "@rougechain/core/network";
import { loadNotificationSettings, requestNotificationPermission, saveNotificationSettings, type NotificationSettings } from "@rougechain/core/notifications";
import { getPrivacySettings, registerWalletOnNode, savePrivacySettings } from "@rougechain/core/pqc-messenger";
import { getMessagingIdentity } from "@rougechain/core/profile";
import { getRougeChainProvider } from "@rougechain/core/extension-bridge";
import { useChain } from "../explorer/chain";
import { PageHeading } from "../explorer/ui";
import { useWallet } from "./WalletProvider";
import { useHideBalances } from "./hooks";
import { SettingRow, Toggle } from "./parts";
import { AvatarEditor, MailNameEditor, NameEditor } from "./profile";
import { BackupDialog } from "./BackupDialog";
import { openTour } from "./tour";
import { toast } from "./toast";

export const AUTO_LOCK_OPTIONS = [0, 5, 15, 30, 60];
/** apps/web's i18n language key (i18next localStorage detector). Read-only here until site-next has i18n. */
export const LANGUAGE_STORAGE_KEY = "rougechain-lang";
const LANGUAGES: Record<string, string> = { en: "English", es: "Español", zh: "中文", ja: "日本語" };

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

function savedLanguage(): string {
  try {
    return (localStorage.getItem(LANGUAGE_STORAGE_KEY) || navigator.language || "en").slice(0, 2);
  } catch {
    return "en";
  }
}

export default function SettingsPage() {
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
  const lang = savedLanguage();

  const updateNotif = async (patch: Partial<NotificationSettings>) => {
    if (patch.desktopEnabled) {
      const granted = await requestNotificationPermission().catch(() => false);
      if (!granted) toast.info("Your browser blocked notifications for this site.");
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
    if (pwNew.length < 8) return toast.error("Password must be at least 8 characters");
    if (pwNew !== pwConfirm) return toast.error("Passwords don't match");
    setPwBusy(true);
    try {
      if (w.hasPassword) {
        await changeVaultPassword(pwCurrent, pwNew);
        toast.success("Password changed");
      } else {
        await w.setPassword(pwNew);
        toast.success("Password set — your wallet is encrypted");
      }
      setPwCurrent("");
      setPwNew("");
      setPwConfirm("");
    } catch (e) {
      toast.error("Couldn't update the password", { description: e instanceof Error ? e.message : undefined });
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
        <PageHeading eyebrow="Hold / Settings" title="Settings" aside={<span />}>
          Profile, mail name, security and preferences in one place.
        </PageHeading>

        {!wallet && (
          <div className="notice">
            <span>{w.status === "locked" ? "Your wallet is locked. Unlock it to edit your profile and security." : "Create or import a wallet to set up your profile."}</span>
            <Link className="button small" to="/wallet">
              Wallet
            </Link>
          </div>
        )}

        <Section id="profile" icon={User} title="Profile">
          <AvatarEditor />
          <NameEditor id="settings-name" />
        </Section>

        <Section id="mail" icon={AtSign} title="Mail name">
          <p className="form-hint">One name gives you two addresses for encrypted mail.</p>
          <MailNameEditor wallet={wallet} />
        </Section>

        <Section id="security" icon={Shield} title="Security & backup">
          <SettingRow title="Auto-lock" hint={w.hasPassword ? "Lock the wallet after this much inactivity." : "Set a password first."}>
            <span />
          </SettingRow>
          <div className="chip-row" role="group" aria-label="Auto-lock">
            {AUTO_LOCK_OPTIONS.map((m) => (
              <button key={m} type="button" className={`chip ${w.autoLockMinutes === m ? "active" : ""}`} aria-pressed={w.autoLockMinutes === m} disabled={!w.hasPassword} onClick={() => w.setAutoLockMinutes(m)}>
                {m === 0 ? "Never" : `${m} min`}
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
            <strong>{w.hasPassword ? "Change password" : "Set a password"}</strong>
            {w.hasPassword && (
              <input className="input" type="password" aria-label="Current password" placeholder="Current password" autoComplete="current-password" value={pwCurrent} onChange={(e) => setPwCurrent(e.target.value)} disabled={!wallet} />
            )}
            <div className="two-fields">
              <input className="input" type="password" aria-label="New password" placeholder="New password (8+ characters)" autoComplete="new-password" value={pwNew} onChange={(e) => setPwNew(e.target.value)} disabled={!wallet} />
              <input className="input" type="password" aria-label="Confirm new password" placeholder="Confirm new password" autoComplete="new-password" value={pwConfirm} onChange={(e) => setPwConfirm(e.target.value)} disabled={!wallet} />
            </div>
            <Button type="submit" variant="outline small" disabled={!wallet || pwBusy || !pwNew || !pwConfirm || (w.hasPassword && !pwCurrent)}>
              {pwBusy ? "Saving…" : w.hasPassword ? "Change password" : "Set a password"}
            </Button>
          </form>
          <div className="actions divider">
            <Button
              variant="outline small"
              disabled={!wallet || !w.hasPassword}
              title={!w.hasPassword ? "Set a password first." : undefined}
              onClick={() => {
                w.lock();
                toast.success("Wallet locked");
              }}
            >
              Lock now
            </Button>
            <Button variant="outline small" disabled={!wallet} onClick={() => setBackup(true)}>
              Backup & recovery phrase
            </Button>
          </div>
          <p className="form-hint">Export an encrypted .pqcbackup file, reveal your recovery phrase, or restore a wallet.</p>
        </Section>

        <Section id="privacy" icon={Eye} title="Privacy">
          <SettingRow title="Hide balances" hint="Mask amounts on the wallet page.">
            <Toggle label="Hide balances" checked={hidden} onChange={setHidden} />
          </SettingRow>
          <SettingRow title="Discoverable" hint="Let people find you by name in New Chat.">
            <Toggle label="Discoverable" checked={discoverable} onChange={toggleDiscoverable} />
          </SettingRow>
        </Section>

        <Section id="notifications" icon={Bell} title="Notifications">
          <SettingRow title="Notifications" hint="Incoming transfers, new messages and mail.">
            <Toggle label="Notifications" checked={notif.enabled} onChange={(v) => updateNotif({ enabled: v })} />
          </SettingRow>
          <SettingRow title="Sound">
            <Toggle label="Sound" checked={notif.sound} disabled={!notif.enabled} onChange={(v) => updateNotif({ sound: v })} />
          </SettingRow>
          <SettingRow title="Desktop alerts" hint="Uses your browser's notifications.">
            <Toggle label="Desktop alerts" checked={notif.desktopEnabled} disabled={!notif.enabled} onChange={(v) => updateNotif({ desktopEnabled: v })} />
          </SettingRow>
        </Section>

        <Section id="network" icon={Network} title="Network">
          <div className="mode-switch" role="group" aria-label="Network">
            {(["mainnet", "testnet"] as const).map((n) => (
              <Button key={n} variant={chain.network === n ? "secondary small" : "ghost small"} aria-pressed={chain.network === n} onClick={() => switchTo(n)}>
                {n === "mainnet" ? "Mainnet" : "Testnet"}
              </Button>
            ))}
          </div>
          <p className="form-hint">
            {chain.locked
              ? `This site is pinned to ${chain.config.label}; the other network opens on its own site.`
              : "Each network keeps its own wallet, lock state and balances."}
          </p>
        </Section>

        <Section id="language" icon={Languages} title="Language">
          <SettingRow title={LANGUAGES[lang] ?? lang} hint="More languages are coming to this site. Your choice on the current site is kept.">
            <span className="pill">{lang.toUpperCase()}</span>
          </SettingRow>
        </Section>

        <Section id="connected" icon={Puzzle} title="Connected">
          <SettingRow
            title="RougeChain extension"
            hint={w.isExtension ? "This wallet is connected through the extension." : getRougeChainProvider() ? "Extension detected in this browser." : "Not detected in this browser."}
          >
            <span className={`status ${w.isExtension || getRougeChainProvider() ? "live" : "loading"}`}>{w.isExtension || getRougeChainProvider() ? "Detected" : "None"}</span>
          </SettingRow>
          <SettingRow title="Base" hint="Your Base address comes from the same recovery phrase. Send and receive on the Wallet page.">
            <Link className="button ghost small" to="/wallet">
              Wallet
            </Link>
          </SettingRow>
        </Section>

        <Section id="help" icon={Compass} title="Help">
          <SettingRow title="Replay the tour" hint="Walk through what each part of RougeChain does.">
            <Button variant="outline small" onClick={openTour}>
              Replay the tour
            </Button>
          </SettingRow>
        </Section>
      </div>
      {backup && wallet && <BackupDialog open onClose={() => setBackup(false)} />}
    </main>
  );
}
