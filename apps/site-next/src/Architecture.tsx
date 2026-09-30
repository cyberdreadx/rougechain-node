import { Section, Status } from "@rougechain/ui";
import { Trans, useTranslation } from "react-i18next";
import { apps, globalApps, globalAppGroups, appHref } from "./ecosystem/apps";
export default function Architecture() {
  const { t } = useTranslation("marketing");
  // App names, groups and statuses are shared reference data (common namespace).
  const { t: tc } = useTranslation("common");
  const appName = (a: { id: string; name: string }) =>
    tc(`apps.${a.id}.name`, { defaultValue: a.name });
  return (
    <main id="main">
      <div className="container page-intro">
        <div className="eyebrow">{t("architecture.eyebrow")}</div>
        <h1>
          <Trans
            t={t}
            i18nKey="architecture.title"
            components={{ br: <br />, muted: <span className="muted" /> }}
          />
        </h1>
        <p>{t("architecture.lead")}</p>
        <Status state="demo">{t("architecture.status")}</Status>
        <p>
          <a className="text-link" href="#wallet-architecture">
            {t("architecture.seeWallet")}
          </a>
        </p>
      </div>
      <Section
        eyebrow={t("architecture.destinations.eyebrow")}
        title={t("architecture.destinations.title")}
      >
        <div className="topology-root">
          rougechain.io <span>{t("architecture.destinations.root")}</span>
        </div>
        <div className="topology-groups">
          {globalAppGroups.map((group) => (
            <section key={group}>
              <h3>{tc(`appGroups.${group}`)}</h3>
              {globalApps
                .filter((a) => a.group === group)
                .map((a) => (
                  <article key={a.id}>
                    {a.status === "future" ? (
                      <span>{t("architecture.comingSoon", { name: appName(a) })}</span>
                    ) : (
                      <a href={appHref(a)}>{appName(a)} ↗</a>
                    )}
                    <code>{a.proposedHost}</code>
                    <small>
                      {t("architecture.destinations.proposed", {
                        status: tc(`appStatus.${a.status}`),
                      })}
                    </small>
                  </article>
                ))}
            </section>
          ))}
        </div>
      </Section>
      <Section
        eyebrow={t("architecture.beyond.eyebrow")}
        title={t("architecture.beyond.title")}
      >
        <div className="specimen-grid">
          {(["developer-resource", "community", "utility"] as const).map(
            (kind) => (
              <article className="surface" key={kind}>
                <h3>
                  {kind === "developer-resource"
                    ? t("architecture.beyond.build")
                    : kind === "community"
                      ? t("architecture.beyond.community")
                      : t("architecture.beyond.utilities")}
                </h3>
                <p className="pane-note">
                  {kind === "developer-resource"
                    ? t("architecture.beyond.buildQuestion")
                    : kind === "community"
                      ? t("architecture.beyond.communityQuestion")
                      : t("architecture.beyond.utilitiesQuestion")}
                </p>
                {apps
                  .filter((a) => a.kind === kind)
                  .map((a) => (
                    <p key={a.id}>
                      {a.status === "future" ? (
                        <span>{t("architecture.comingSoon", { name: appName(a) })}</span>
                      ) : (
                        <a href={appHref(a)}>{appName(a)} ↗</a>
                      )}
                    </p>
                  ))}
              </article>
            ),
          )}
        </div>
        <p>{t("architecture.beyond.note")}</p>
      </Section>
      <Section
        id="wallet-architecture"
        eyebrow={t("architecture.wallet.eyebrow")}
        title={t("architecture.wallet.title")}
      >
        <p>{t("architecture.wallet.lead")}</p>
        <figure
          className="wallet-flow"
          aria-label={t("architecture.wallet.figureLabel")}
        >
          <div className="wallet-flow-providers">
            <div>
              {t("architecture.wallet.extension")}
              <small>{t("architecture.wallet.extensionNote")}</small>
            </div>
            <div>
              Qwalla<small>{t("architecture.wallet.qwallaNote")}</small>
            </div>
          </div>
          <div className="wallet-flow-connector" aria-hidden="true">
            ↓
          </div>
          <div className="wallet-flow-contract">
            <code>@rougechain/wallet-provider</code>
            <small>{t("architecture.wallet.contractNote")}</small>
          </div>
          <div className="wallet-flow-connector" aria-hidden="true">
            ↓
          </div>
          <div className="wallet-flow-apps">
            {globalApps
              .filter((a) => a.workspaceView)
              .map((a) => (
                <span key={a.id}>{appName(a)}</span>
              ))}
          </div>
          <figcaption>{t("architecture.wallet.caption")}</figcaption>
        </figure>
        <div className="specimen-grid">
          <article className="surface">
            <h3>{t("architecture.wallet.demonstratesTitle")}</h3>
            <p>{t("architecture.wallet.demonstrates1")}</p>
            <p>{t("architecture.wallet.demonstrates2")}</p>
          </article>
          <article className="surface">
            <h3>{t("architecture.wallet.evaluateTitle")}</h3>
            <p>{t("architecture.wallet.evaluate1")}</p>
            <p>{t("architecture.wallet.evaluate2")}</p>
          </article>
        </div>
        <div className="architecture-note">
          <strong>{t("architecture.wallet.noteTitle")}</strong>
          <p>{t("architecture.wallet.note")}</p>
        </div>
      </Section>
      <Section
        eyebrow={t("architecture.boundaries.eyebrow")}
        title={t("architecture.boundaries.title")}
      >
        <div className="specimen-grid">
          <article className="surface">
            <h3>{t("architecture.boundaries.implementedTitle")}</h3>
            <p>{t("architecture.boundaries.brand")}</p>
            <p>{t("architecture.boundaries.ui")}</p>
            <p>{t("architecture.boundaries.chainReadonly")}</p>
            <p>{t("architecture.boundaries.showcase")}</p>
          </article>
          <article className="surface">
            <h3>{t("architecture.boundaries.proposedTitle")}</h3>
            <p>app-shell · chain-client · network-config · i18n</p>
            <p>{t("architecture.boundaries.walletProvider")}</p>
            <p>{t("architecture.boundaries.independent")}</p>
          </article>
        </div>
      </Section>
      <Section
        eyebrow={t("architecture.transition.eyebrow")}
        title={t("architecture.transition.title")}
      >
        <ol className="migration-steps">
          {[1, 2, 3, 4, 5].map((n) => (
            <li key={n}>{t(`architecture.transition.steps.${n}`)}</li>
          ))}
        </ol>
        <p>{t("architecture.transition.note")}</p>
        <div className="architecture-note">
          <strong>{t("architecture.transition.originTitle")}</strong>
          <p>{t("architecture.transition.origin")}</p>
        </div>
      </Section>
    </main>
  );
}
