/**
 * Wallet states shared by Messenger and Mail: no wallet, locked (unlock via core through the
 * wallet provider), resolving the messaging identity (extension wallets get core's device-local
 * messenger key), error, then the app itself.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Loader2, Lock, MessageSquare } from "lucide-react";
import type { WalletWithPrivateKeys } from "@rougechain/core/pqc-messenger";
import type { UnifiedWallet } from "@rougechain/core/unified-wallet";
import { NetworkBadge, PageHeading } from "../explorer/ui";
import { useExtensionProvider } from "../wallet/hooks";
import { UnlockForm } from "../wallet/parts";
import { toast } from "../wallet/toast";
import { useWallet } from "../wallet/WalletProvider";
import { useMessagingIdentity } from "./hooks";
import { useTranslation } from "react-i18next";

export interface GateReady {
  wallet: UnifiedWallet;
  identity: WalletWithPrivateKeys;
  setIdentity(w: WalletWithPrivateKeys | null): void;
}

function GateShell({ product, children }: { product: "messenger" | "mail"; children: ReactNode }) {
  const { t } = useTranslation("messenger");
  return (
    <main id="main" className="app-main msg-gate">
      <div className="container">
        <PageHeading eyebrow={t("gate.eyebrow", { product: product === "mail" ? t("gate.mailTitle") : t("gate.title") })} title={product === "mail" ? t("gate.mailTitle") : t("gate.title")} aside={<NetworkBadge />} />
        {children}
      </div>
    </main>
  );
}

export function WalletGate({ product, children }: { product: "messenger" | "mail"; children: (ready: GateReady) => ReactNode }) {
  const { t } = useTranslation("messenger");
  const w = useWallet();
  const extension = useExtensionProvider();
  const id = useMessagingIdentity(w.status === "unlocked" ? w.wallet : null);

  if (w.status === "locked")
    return (
      <GateShell product={product}>
        <section className="surface unlock-card msg-gate-card">
          <Lock size={22} aria-hidden="true" />
          <h2>{w.displayName ? t("gate.locked", { name: w.displayName }) : t("gate.lockedGeneric")}</h2>
          <p>{t("gate.lockedHint")}</p>
          {w.publicKey && <p className="mono break">{`${w.publicKey.slice(0, 32)}…${w.publicKey.slice(-12)}`}</p>}
          <UnlockForm />
        </section>
      </GateShell>
    );

  if (w.status !== "unlocked" || !w.wallet)
    return (
      <GateShell product={product}>
        <section className="surface msg-gate-card">
          <MessageSquare size={22} aria-hidden="true" />
          <h2>{product === "mail" ? t("gate.noWalletMail") : t("gate.noWallet")}</h2>
          <div className="actions">
            <Link className="button" to="/wallet">
              {t("gate.openWallet")}
            </Link>
            {extension && (
              <button
                type="button"
                className="button outline"
                onClick={async () => {
                  try {
                    await w.connectExtension();
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : t("gate.extensionFailed"));
                  }
                }}
              >
                {t("gate.connectExtension")}
              </button>
            )}
          </div>
        </section>
      </GateShell>
    );

  if (id.status === "error")
    return (
      <GateShell product={product}>
        <section className="surface msg-gate-card">
          <h2>{t("gate.resolveFailed")}</h2>
          <p className="form-error">{id.error}</p>
          <button type="button" className="button outline" onClick={() => window.location.reload()}>
            {t("common.retry")}
          </button>
        </section>
      </GateShell>
    );

  if (id.status !== "ready")
    return (
      <main id="main" className="msg-loading" aria-busy="true">
        <Loader2 size={22} className="spin" aria-hidden="true" />
        <span>{t("gate.resolving")}</span>
      </main>
    );

  return <>{children({ wallet: w.wallet, identity: id.identity, setIdentity: id.setOverride })}</>;
}
