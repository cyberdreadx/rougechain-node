import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Wallet } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Dialog, Button } from "@rougechain/ui";
import { formatPubkey } from "@rougechain/core/address";
import { useWallet } from "./WalletProvider";
import { networkLabel, useExtensionProvider, useRougeAddress } from "./hooks";
import { CopyText, UnlockForm } from "./parts";
import { toast } from "./toast";

/** Header wallet control: connect / create / import / unlock / lock, address + copy, network. */
export function WalletControl() {
  const { t } = useTranslation("wallet");
  const extensionProvider = useExtensionProvider();
  const w = useWallet();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const { full, display } = useRougeAddress(w.publicKey);
  const close = () => {
    setOpen(false);
    window.requestAnimationFrame(() => trigger.current?.focus());
  };
  const go = (path: string) => {
    close();
    navigate(path);
  };

  const label =
    w.status === "unlocked" ? display || t("control.wallet") : w.status === "locked" ? t("control.locked") : t("control.connectWallet");
  const compact = w.status === "unlocked" ? t("control.wallet") : w.status === "locked" ? t("control.locked") : t("control.connect");
  const ariaLabel =
    w.status === "unlocked"
      ? t("control.walletAria", { address: full ?? display })
      : w.status === "locked"
        ? t("control.lockedAria")
        : t("control.connectWallet");

  const connectExtension = async () => {
    setBusy(true);
    try {
      await w.connectExtension();
      toast.success(t("control.extensionConnected"));
      close();
    } catch (e) {
      toast.error(t("welcome.connectFailed"), { description: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setBusy(true);
    try {
      await w.create();
      go("/wallet");
    } catch (e) {
      toast.error(t("welcome.createFailed"), { description: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wallet-control">
      <button
        ref={trigger}
        className={`button outline small wallet-trigger ${w.status}`}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Wallet size={15} aria-hidden="true" />
        <span className="wallet-trigger-label">{label}</span>
        <span className="wallet-trigger-compact" aria-hidden="true">
          {compact}
        </span>
      </button>

      {w.status === "none" && (
        <Dialog open={open} onClose={close} title={t("control.connectTitle")}>
          <p className="muted">{t("control.connectBody")}</p>
          <div className="provider-options">
            <button className="provider-option" onClick={create} disabled={busy}>
              <span>
                <strong>{t("control.createTitle")}</strong>
                <small>{t("control.createBody")}</small>
              </span>
              <span>{t("control.createCta")}</span>
            </button>
            <button className="provider-option" onClick={() => go("/wallet?import=1")} disabled={busy}>
              <span>
                <strong>{t("welcome.importTitle")}</strong>
                <small>{t("control.importBody")}</small>
              </span>
              <span>{t("control.importCta")}</span>
            </button>
            <button className="provider-option" onClick={connectExtension} disabled={busy}>
              <span>
                <strong>{t("control.extensionTitle")}</strong>
                <small>{extensionProvider ? t("control.extensionDetected") : t("control.extensionMissing")}</small>
              </span>
              <span>{t("control.connectCta")}</span>
            </button>
          </div>
          <p className="wallet-disclaimer">{t("control.disclaimer")}</p>
        </Dialog>
      )}

      {w.status === "locked" && (
        <Dialog open={open} onClose={close} title={t("control.unlockTitle")}>
          <div className="account-identity">
            <strong>{w.displayName || t("control.yourWallet")}</strong>
            <span>{t("control.networkLocked", { network: networkLabel(w.network) })}</span>
            {w.publicKey && <small className="mono">{formatPubkey(w.publicKey, 12, 6)}</small>}
          </div>
          <UnlockForm onUnlocked={close} />
        </Dialog>
      )}

      {w.status === "unlocked" && (
        <Dialog open={open} onClose={close} title={t("control.yourWallet")}>
          <div className="account-identity">
            <strong>{w.displayName || t("myWallet")}</strong>
            <span>
              {networkLabel(w.network)} · {w.isExtension ? t("welcome.extensionTitle") : t("control.thisBrowser")}
            </span>
          </div>
          {full ? <CopyText value={full} label={t("copy.address")} /> : <small className="muted">{t("dashboard.deriving")}</small>}
          <div className="account-actions">
            <Link className="button" to="/wallet" onClick={close}>
              {t("control.openWallet")}
            </Link>
            <Link className="button outline" to="/settings" onClick={close}>
              {t("page.settings")}
            </Link>
            {full && (
              <Link className="button ghost" to={`/address/${full}`} onClick={close}>
                {t("control.viewInExplorer")}
              </Link>
            )}
          </div>
          <div className="account-disconnect">
            {w.isExtension ? (
              // A provider wallet holds no keys here, so disconnecting only forgets the connection.
              <Button
                variant="outline"
                onClick={() => {
                  w.disconnect();
                  toast.info(t("control.disconnected"));
                  close();
                }}
              >
                {t("control.disconnect")}
              </Button>
            ) : w.hasPassword ? (
              <Button
                variant="outline"
                onClick={() => {
                  w.lock();
                  toast.info(t("lock.locked"));
                  close();
                }}
              >
                {t("control.lock")}
              </Button>
            ) : (
              <Link className="text-link" to="/settings#security" onClick={close}>
                {t("control.setPassword")}
              </Link>
            )}
          </div>
        </Dialog>
      )}
    </div>
  );
}
