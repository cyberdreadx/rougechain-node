import { useWalletIdentity } from "../wallet/WalletProvider";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button, Status, CodeBlock } from "@rougechain/ui";
import { useNetwork } from "../Network";
import { DOCS_URL } from "../ecosystem/apps";
import { quote } from "../Swap";
import { useTranslation } from "react-i18next";
import { fmtInt } from "../i18n/format";
// Swap / Bridge / Messenger / Validators previews simulate UI state (no services behind them).
// The wallet preview reflects the real wallet and links to /wallet.
export function WalletPreview() {
  const wallet = useWalletIdentity();
  const { t } = useTranslation("common");
  return (
    <div className="explore-content">
      <Status state={wallet.connected ? "live" : "loading"}>
        {wallet.connected
          ? t("previews.wallet.connected")
          : wallet.locked
            ? t("previews.wallet.locked")
            : t("previews.wallet.none")}
      </Status>
      <h3>{t("previews.wallet.title")}</h3>
      {wallet.connected ? (
        <p>
          <strong>{wallet.short}</strong>
          <br />
          <span className="muted">{wallet.networkLabel}</span>
        </p>
      ) : (
        <p>
          {wallet.locked
            ? t("previews.wallet.unlock")
            : t("previews.noWallet")}
        </p>
      )}
      <div className="preview-actions">
        <Link className="button" to="/wallet">
          {t("previews.wallet.open")}
        </Link>
      </div>
      <p className="pane-note">{t("previews.wallet.note")}</p>
    </div>
  );
}
export function SwapPreview() {
  const wallet = useWalletIdentity();
  const [amount, setAmount] = useState("100");
  const { t } = useTranslation("common");
  return (
    <div className="explore-content">
      <Status state="demo">{t("previews.swap.status")}</Status>
      <h3>{t("previews.swap.title")}</h3>
      <p className="pane-note">
        {wallet.connected
          ? t("previews.account", { address: wallet.short })
          : t("previews.swap.connect")}
      </p>
      <label className="preview-label">
        {t("previews.swap.pay")} · XRGE
        <input
          type="number"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <div className="preview-row">
        <span>{t("previews.swap.receive")} · qETH</span>
        <strong>{quote(amount, "XRGE", "qETH")?.toFixed(6) ?? "—"}</strong>
      </div>
      <Button disabled>{t("previews.swap.unavailable")}</Button>
      <p className="pane-note">
        {t("previews.swap.note")}
      </p>
      <a className="text-link" href="/swap">
        {t("previews.swap.open")} ↗
      </a>
    </div>
  );
}
export function BridgePreview() {
  const wallet = useWalletIdentity();
  const [reverse, setReverse] = useState(false);
  const { t } = useTranslation("common");
  return (
    <div className="explore-content">
      <Status state="demo">{t("previews.bridge.status")}</Status>
      <p className="pane-note">
        {wallet.connected
          ? t("previews.account", { address: wallet.short })
          : t("previews.noWallet")}
      </p>
      <h3>{reverse ? "RougeChain → Base" : "Base → RougeChain"}</h3>
      <Button variant="ghost small" onClick={() => setReverse(!reverse)}>
        {t("previews.bridge.reverse")}
      </Button>
      <p>{t("previews.bridge.assets")} · XRGE / qETH / qUSDC</p>
      <div className="preview-row">
        {t("previews.bridge.activity")} <span>—</span>
      </div>
      <Button disabled>{t("previews.bridge.unavailable")}</Button>
      <p className="pane-note">{t("previews.bridge.note")}</p>
    </div>
  );
}
export function MessengerPreview() {
  const wallet = useWalletIdentity();
  const [tab, setTab] = useState<"conversations" | "contacts">(
    "conversations",
  );
  const { t } = useTranslation("common");
  return (
    <div className="explore-content">
      <Status state="demo">{t("previews.messenger.status")}</Status>
      <div className="preview-actions">
        {(["conversations", "contacts"] as const).map((id) => (
          <Button
            key={id}
            variant="ghost small"
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
          >
            {t(`previews.messenger.${id}`)}
          </Button>
        ))}
      </div>
      <h3>
        {tab === "contacts"
          ? t("previews.messenger.noContacts")
          : t("previews.messenger.yours")}
      </h3>
      <p>
        {wallet.connected
          ? t("previews.messenger.connected")
          : t("previews.messenger.disconnected")}
      </p>
      <Button disabled>{t("previews.compose")}</Button>
      <p className="pane-note">{t("previews.messenger.note")}</p>
    </div>
  );
}
export function MailPreview() {
  const [tab, setTab] = useState<"inbox" | "sent">("inbox");
  const { t } = useTranslation("common");
  return (
    <div className="explore-content">
      <Status state="demo">{t("previews.mail.status")}</Status>
      <div className="preview-actions">
        {(["inbox", "sent"] as const).map((id) => (
          <Button
            key={id}
            variant="ghost small"
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
          >
            {t(`previews.mail.${id}`)}
          </Button>
        ))}
      </div>
      <h3>
        {t("previews.mail.empty", { folder: t(`previews.mail.${tab}`) })}
      </h3>
      <p>{t("previews.mail.noAccount")}</p>
      <Button disabled>{t("previews.compose")}</Button>
      <p className="pane-note">{t("previews.mail.note")}</p>
    </div>
  );
}
export function ValidatorsPreview() {
  const wallet = useWalletIdentity();
  const n = useNetwork();
  const { t } = useTranslation("common");
  return (
    <div className="explore-content">
      <Status state={n.state}>{t(`network.state.${n.state}`)}</Status>
      <h3>{t("previews.validators.title")}</h3>
      {wallet.connected && (
        <p className="pane-note">
          {t("previews.validators.connected")}
        </p>
      )}
      <div className="network-height">
        {n.data ? fmtInt(n.data.validators) : "—"}
      </div>
      <p>{t("previews.validators.reported")}</p>
      <a className="text-link" href={DOCS_URL}>
        {t("previews.validators.nodeDocs")} ↗
      </a>
      <p>
        <a href="/architecture">{t("previews.validators.staking")} ↗</a>
      </p>
      <Button disabled>{t("previews.validators.unavailable")}</Button>
    </div>
  );
}
export function DeveloperExtras() {
  const { t } = useTranslation("common");
  return (
    <>
      <CodeBlock>npm install @rougechain/sdk</CodeBlock>
      <p className="pane-note">{t("previews.developer")}</p>
    </>
  );
}
