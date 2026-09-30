import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { useRouteSeo } from "./common";
import "./pages.css";

const GUIDE_URL = "https://docs.rougechain.io/staking/becoming-validator.html";
const FACTS = ["network", "cohort", "stake", "signatures"] as const;
const PERKS = ["recognition", "weight", "grant", "support", "voice", "mission"] as const;
const ASKS = ["stake", "node", "uptime", "keys", "independence", "commitment"] as const;
const STEPS: { key: string; code?: string; link?: boolean }[] = [
  { key: "apply" },
  { key: "spin", link: true },
  { key: "fund", code: "rougechain --node-keys <path> stake 10000" },
  { key: "live" },
];

/**
 * Genesis Validators — recruitment page for the founding independent validator cohort.
 * Honest by design (same copy as apps/web): no yield promises, no fabricated mechanics.
 */
export default function GenesisValidators() {
  const { t } = useTranslation("pages");
  useRouteSeo({ title: t("seo.genesis.title"), description: t("seo.genesis.description") });
  return (
    <main id="main" className="app-main rc-page rc-genesis">
      <div className="container rc-narrow">
        <header className="rc-hero">
          <div className="eyebrow">{t("genesis.eyebrow")}</div>
          <h1>
            <Trans t={t} i18nKey="genesis.title" components={{ em: <span className="gradient-text" /> }} />
          </h1>
          <p className="rc-lead">{t("genesis.lead")}</p>
          <dl className="rc-facts">
            {FACTS.map((k) => (
              <div key={k}>
                <dt>{t(`genesis.facts.${k}.k`)}</dt>
                <dd>{t(`genesis.facts.${k}.v`)}</dd>
              </div>
            ))}
          </dl>
        </header>

        <section className="notice warning rc-honest" aria-labelledby="honest">
          <div id="honest" className="eyebrow">
            {t("genesis.honestTitle")}
          </div>
          <p>{t("genesis.honestBody")}</p>
        </section>

        <section className="rc-block" aria-labelledby="gets">
          <h2 id="gets">{t("genesis.getsTitle")}</h2>
          <p className="muted">{t("genesis.getsLead")}</p>
          <div className="rc-cards">
            {PERKS.map((p) => (
              <article key={p} className="surface rc-card">
                <div className="eyebrow">{t(`genesis.perks.${p}.tag`)}</div>
                <h3>{t(`genesis.perks.${p}.title`)}</h3>
                <p>{t(`genesis.perks.${p}.body`)}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="rc-block" aria-labelledby="asks">
          <h2 id="asks">{t("genesis.asksTitle")}</h2>
          <dl className="surface rc-asks">
            {ASKS.map((k) => (
              <div key={k}>
                <dt>{t(`genesis.asks.${k}.k`)}</dt>
                <dd>{t(`genesis.asks.${k}.v`)}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="rc-block" aria-labelledby="join">
          <h2 id="join">{t("genesis.joinTitle")}</h2>
          <ol className="rc-steps numbered">
            {STEPS.map((s) => (
              <li key={s.key} className="surface">
                <strong>{t(`genesis.steps.${s.key}.t`)}</strong>
                <p>
                  {s.code && (
                    <>
                      <code className="mono">{s.code}</code>{" "}
                    </>
                  )}
                  {s.link ? (
                    <Trans
                      t={t}
                      i18nKey={`genesis.steps.${s.key}.body`}
                      components={{ link: <a className="text-link inline" href={GUIDE_URL} target="_blank" rel="noopener noreferrer" /> }}
                    />
                  ) : (
                    t(`genesis.steps.${s.key}.body`)
                  )}
                </p>
              </li>
            ))}
          </ol>
          <p className="notice">{t("genesis.fyi")}</p>
        </section>

        <section className="surface rc-cta" aria-labelledby="cta">
          <h2 id="cta">{t("genesis.ctaTitle")}</h2>
          <p>{t("genesis.ctaBody")}</p>
          <div className="actions">
            <a className="button" href={GUIDE_URL} target="_blank" rel="noopener noreferrer">
              {t("genesis.ctaGuide")} <ArrowRight size={16} />
            </a>
            <Link className="button outline" to="/validators">
              {t("genesis.ctaValidators")}
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
