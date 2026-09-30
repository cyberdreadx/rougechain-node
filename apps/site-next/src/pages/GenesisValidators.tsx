import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { useRouteSeo } from "./common";
import { genesis as t, seo } from "./strings";
import "./pages.css";

/**
 * Genesis Validators — recruitment page for the founding independent validator cohort.
 * Honest by design (same copy as apps/web): no yield promises, no fabricated mechanics.
 */
export default function GenesisValidators() {
  useRouteSeo(seo.genesis);
  return (
    <main id="main" className="app-main rc-page rc-genesis">
      <div className="container rc-narrow">
        <header className="rc-hero">
          <div className="eyebrow">{t.eyebrow}</div>
          <h1>
            {t.titleA}
            <span className="gradient-text">{t.titleEm}</span>
            {t.titleB}
          </h1>
          <p className="rc-lead">{t.lead}</p>
          <dl className="rc-facts">
            {t.facts.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </header>

        <section className="notice warning rc-honest" aria-labelledby="honest">
          <div id="honest" className="eyebrow">
            {t.honestTitle}
          </div>
          <p>{t.honestBody}</p>
        </section>

        <section className="rc-block" aria-labelledby="gets">
          <h2 id="gets">{t.getsTitle}</h2>
          <p className="muted">{t.getsLead}</p>
          <div className="rc-cards">
            {t.perks.map((p) => (
              <article key={p.title} className="surface rc-card">
                <div className="eyebrow">{p.tag}</div>
                <h3>{p.title}</h3>
                <p>{p.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="rc-block" aria-labelledby="asks">
          <h2 id="asks">{t.asksTitle}</h2>
          <dl className="surface rc-asks">
            {t.asks.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="rc-block" aria-labelledby="join">
          <h2 id="join">{t.joinTitle}</h2>
          <ol className="rc-steps numbered">
            {t.steps.map((s) => (
              <li key={s.t} className="surface">
                <strong>{s.t}</strong>
                <p>
                  {s.code && (
                    <>
                      <code className="mono">{s.code}</code>{" "}
                    </>
                  )}
                  {s.link ? (
                    <>
                      {s.body.split(s.link.label)[0]}
                      <a className="text-link inline" href={s.link.href} target="_blank" rel="noopener noreferrer">
                        {s.link.label}
                      </a>
                      {s.body.split(s.link.label)[1]}
                    </>
                  ) : (
                    s.body
                  )}
                </p>
              </li>
            ))}
          </ol>
          <p className="notice">{t.fyi}</p>
        </section>

        <section className="surface rc-cta" aria-labelledby="cta">
          <h2 id="cta">{t.ctaTitle}</h2>
          <p>{t.ctaBody}</p>
          <div className="actions">
            <a className="button" href="https://docs.rougechain.io/staking/becoming-validator.html" target="_blank" rel="noopener noreferrer">
              {t.ctaGuide} <ArrowRight size={16} />
            </a>
            <Link className="button outline" to="/validators">
              {t.ctaValidators}
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
