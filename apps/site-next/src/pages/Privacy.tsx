import { useTranslation } from "react-i18next";
import { useRouteSeo } from "./common";
import { fmtDate } from "../i18n/format";
import { currentLanguage } from "../i18n";
import { PrivacyBody, PrivacyIntro } from "./privacy-content";
import "./pages.css";

/** Date of PRIVACY_LAST_UPDATED ("March 9, 2026"), formatted per language. */
const LAST_UPDATED = new Date(2026, 2, 9);

/**
 * The policy body stays in English on purpose: it is the authoritative legal text (a translated
 * policy would be a separately reviewed document). Heading, SEO and a short notice are translated.
 */
export default function Privacy() {
  const { t } = useTranslation("pages");
  useRouteSeo({ title: t("seo.privacy.title"), description: t("seo.privacy.description") });
  const english = currentLanguage() === "en";
  return (
    <main id="main" className="app-main rc-page rc-legal">
      <div className="container rc-narrow">
        <header className="rc-legal-head">
          <div className="eyebrow">{t("privacy.eyebrow")}</div>
          <h1>{t("privacy.title")}</h1>
          <p className="mono muted">{t("privacy.lastUpdated", { date: fmtDate(LAST_UPDATED, { dateStyle: "long" }) })}</p>
          {!english && (
            <p className="notice" role="note">
              {t("privacy.englishOnly")}
            </p>
          )}
          <div lang="en">
            <PrivacyIntro />
          </div>
        </header>
        <div lang="en">
          <PrivacyBody />
        </div>
      </div>
    </main>
  );
}
