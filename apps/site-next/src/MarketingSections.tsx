import { WHITEPAPER_URL } from "./ecosystem/apps";
import { ArrowUpRight, ArrowRight, Terminal, ShieldCheck } from "lucide-react";
import { Section, TextLink, CodeBlock } from "@rougechain/ui";
import { DOCS, GITHUB } from "./Shell";
import { team } from "./team";
import EcosystemCarousel from "./EcosystemCarousel";
import Explore from "./explore/Explore";
import { Trans, useTranslation } from "react-i18next";

const BR = { br: <br /> };
const MUTED = { br: <br />, muted: <span className="muted" /> };
export default function MarketingSections() {
  const { t } = useTranslation("marketing");
  return (
    <>
      <Section id="build" eyebrow={t("build.eyebrow")}>
        <div className="build-layout">
          <div>
            <h2>
              <Trans t={t} i18nKey="build.title" components={BR} />
            </h2>
            <p>
              <Trans t={t} i18nKey="build.lead" components={BR} />
            </p>
            <div className="terminal">
              <div className="terminal-heading">
                <Terminal size={14} />
                <span>{t("build.sdkHeading")}</span>
              </div>
              <CodeBlock>
                <span className="muted">$ </span>npm install @rougechain/sdk
              </CodeBlock>
              <div className="terminal-divider" />
              <CodeBlock>
                {
                  '// Public network data. Read only.\nconst response = await fetch(\n  "https://api.rougechain.io/api/stats"\n);\nconst network = await response.json();'
                }
              </CodeBlock>
            </div>
          </div>
          <div className="resource-list">
            {(["sdk", "wasm", "node", "mcp"] as const).map((id, i) => [
              `0${i + 1}`,
              t(`build.resources.${id}.title`),
              t(`build.resources.${id}.body`),
            ]).map(([n, title, copy]) => (
              <a href={DOCS} key={n}>
                <span className="mono muted">{n}</span>
                <div>
                  <h3>{title}</h3>
                  <p>{copy}</p>
                </div>
                <ArrowUpRight size={20} />
              </a>
            ))}
            <div className="actions resource-footer">
              <TextLink href={GITHUB}>{t("build.viewSource")}</TextLink>
              <TextLink href={DOCS}>{t("build.allDocs")}</TextLink>
            </div>
          </div>
        </div>
      </Section>
      <Section id="security" eyebrow={t("security.eyebrow")}>
        <div className="security-layout">
          <div>
            <ShieldCheck size={28} className="security-icon" />
            <h2>
              <Trans t={t} i18nKey="security.title" components={MUTED} />
            </h2>
            <p>
              <Trans t={t} i18nKey="security.lead" components={BR} />
            </p>
            <div className="actions">
              <TextLink href={GITHUB}>{t("security.inspect")}</TextLink>
              <TextLink href={WHITEPAPER_URL}>{t("security.whitepaper")}</TextLink>
            </div>
          </div>
          <div className="crypto-list">
            {[
              ["ML-DSA-65", t("security.primitives.signatures"), "FIPS 204"],
              ["ML-KEM-768", t("security.primitives.kem"), "FIPS 203"],
              [
                "AES-256-GCM",
                t("security.primitives.aead"),
                "FIPS 197 / SP 800-38D",
              ],
              [
                "SHA-256 + BLAKE3",
                t("security.primitives.hashing"),
                "FIPS 180-4 / BLAKE3",
              ],
            ].map(([name, desc, fips]) => (
              <div key={name}>
                <div>
                  <h3>{name}</h3>
                  <p>{desc}</p>
                </div>
                <span className="mono muted">{fips}</span>
              </div>
            ))}
            <p className="small-note">{t("security.note")}</p>
          </div>
        </div>
      </Section>
      <Section id="ecosystem" eyebrow={t("ecosystem.eyebrow")}>
        <div className="section-heading ecosystem-heading">
          <div>
            <h2>
              <Trans t={t} i18nKey="ecosystem.title" components={BR} />
            </h2>
            <p>
              <Trans t={t} i18nKey="ecosystem.lead" components={BR} />
            </p>
          </div>
        </div>
        <EcosystemCarousel />
      </Section>
      <Section id="xrge" eyebrow={t("xrge.eyebrow")}>
        <div className="token-section">
          <div className="token-identity">
            <img src="/xrge-logo.webp" alt={t("xrge.logoAlt")} loading="lazy" />
            <span>XRGE</span>
          </div>
          <div>
            <h2>
              <Trans t={t} i18nKey="xrge.title" components={BR} />
            </h2>
            <p>{t("xrge.lead")}</p>
            <div className="actions">
              <TextLink href={DOCS}>{t("xrge.understand")}</TextLink>
              <a className="text-link" href="/swap">
                {t("xrge.swapDemo")} <ArrowUpRight size={15} />
              </a>
            </div>
          </div>
        </div>
      </Section>
      <Section id="team" eyebrow={t("team.eyebrow")}>
        <div className="section-heading">
          <h2>{t("team.title")}</h2>
          <p>{t("team.lead")}</p>
        </div>
        <div className="team-grid">
          {team.map((p) => {
            const bio = t(`team.members.${p.id}.bio`, { defaultValue: "" });
            return (
            <article key={p.name}>
              <div className="portrait">
                <img src={p.image} alt={p.name} loading="lazy" />
              </div>
              <h3>{p.name}</h3>
              <p className="team-role">{t(`team.members.${p.id}.role`)}</p>
              {bio && (
                <details>
                  <summary>
                    {t("team.about", { name: p.name.split(" ")[0] })}
                  </summary>
                  <p>{bio}</p>
                </details>
              )}
              {p.linkedin && <TextLink href={p.linkedin}>LinkedIn</TextLink>}
            </article>
            );
          })}
        </div>
      </Section>
      <Section id="regenerate" eyebrow={t("regenerate.eyebrow")}>
        <div className="community-layout">
          <h2>
            <Trans t={t} i18nKey="regenerate.title" components={MUTED} />
          </h2>
          <div>
            <p>{t("regenerate.body")}</p>
            <div className="actions">
              <TextLink href="https://rougechain.io/regenerate">
                {t("regenerate.explore")}
              </TextLink>
              <TextLink href="https://rougechain.io/regenerate#propose">
                {t("regenerate.propose")}
              </TextLink>
            </div>
          </div>
        </div>
      </Section>
      <Explore />
      <Section className="final-cta" eyebrow={t("finalCta.eyebrow")}>
        <h2>
          <Trans t={t} i18nKey="finalCta.title" components={BR} />
        </h2>
        <div className="actions">
          <a className="button" href="/explorer">
            {t("finalCta.explore")} <ArrowRight size={16} />
          </a>
          <a className="button outline" href={DOCS}>
            {t("finalCta.docs")} <ArrowUpRight size={16} />
          </a>
        </div>
      </Section>
    </>
  );
}
