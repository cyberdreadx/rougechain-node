import { Link } from "react-router-dom";
import { Section } from "@rougechain/ui";
import { useTranslation } from "react-i18next";
import { WalletControl } from "./WalletControl";

/** Design-system specimen of the wallet control (the live control, plus static state specimens). */
export function WalletSpecimens() {
  const { t } = useTranslation("wallet");
  return (
    <Section id="wallet-controls" eyebrow={t("specimens.eyebrow")} title={t("specimens.title")}>
      <p>{t("specimens.body")}</p>
      <div className="specimen-grid">
        <article className="surface">
          <h3>{t("specimens.statesTitle")}</h3>
          <div className="wallet-state-specimens">
            <span className="button outline small">{t("control.connectWallet")}</span>
            <span className="button outline small">{t("control.locked")}</span>
            <span className="button outline small">rouge1q8f3x7k2…k9m2</span>
          </div>
          <p className="pane-note">{t("specimens.statesNote")}</p>
        </article>
        <article className="surface">
          <h3>{t("specimens.liveTitle")}</h3>
          <WalletControl />
          <p className="pane-note">{t("specimens.liveNote")}</p>
          <Link className="button ghost small" to="/wallet">
            {t("specimens.open")}
          </Link>
        </article>
      </div>
    </Section>
  );
}
