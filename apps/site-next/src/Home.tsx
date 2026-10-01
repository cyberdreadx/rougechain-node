import { WHITEPAPER_URL } from "./ecosystem/apps";
import { useRef } from "react";
import {
  motion,
  useReducedMotion,
  useScroll,
  useTransform,
} from "framer-motion";
import { useScrollReveals } from "./useScrollReveals";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { Section, Status, TextLink } from "@rougechain/ui";
import { GITHUB } from "./Shell";
import { NetworkMetrics, DataNote } from "./Network";
import MarketingSections from "./MarketingSections";
import { Trans, useTranslation } from "react-i18next";
export default function Home() {
  const { t } = useTranslation("marketing");
  const reduced = useReducedMotion();
  const page = useRef<HTMLElement>(null);
  // Page scroll starts at the first pixel, including the header above the hero.
  const { scrollY } = useScroll();
  const rotate = useTransform(scrollY, [0, 600], [0, 100]);
  const scale = useTransform(scrollY, [0, 600], [1, 1.08]);
  useScrollReveals(page, Boolean(reduced));
  return (
    <main id="main" ref={page}>
      <section className="hero">
        <div className="container hero-inner">
          <motion.div
            className="hero-copy"
            initial={reduced ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <div className="hero-kicker">
              <Status state="demo">{t("hero.status")}</Status>
              <span className="kicker-sep" />
              <span className="mono muted">{t("hero.kicker")}</span>
            </div>
            <h1>
              <Trans
                t={t}
                i18nKey="hero.title"
                components={{ br: <br />, grad: <span className="gradient-text" /> }}
              />
            </h1>
            <p>
              <Trans
                t={t}
                i18nKey="hero.lead"
                components={{ dbr: <br className="desktop" /> }}
              />
            </p>
            <div className="actions">
              <a className="button" href="#explore">
                {t("hero.explore")} <ArrowRight size={16} />
              </a>
              <a className="button outline" href="#build">
                {t("hero.build")}
              </a>
            </div>
            <div className="hero-links">
              <TextLink href={WHITEPAPER_URL}>{t("hero.whitepaper")}</TextLink>
              <TextLink href={GITHUB}>GitHub</TextLink>
            </div>
          </motion.div>
          <div className="hero-art" aria-hidden="true">
            <motion.svg
              className="lattice"
              viewBox="0 0 600 600"
              style={reduced ? { rotate: 0, scale: 1 } : { rotate, scale }}
            >
              <defs>
                <linearGradient id="orbit" x1="0" y1="0" x2="1" y2="1">
                  <stop stopColor="#f34459" />
                  <stop offset=".5" stopColor="#d843a6" />
                  <stop offset="1" stopColor="#8465c8" />
                </linearGradient>
              </defs>
              {Array.from({ length: 13 }, (_, i) => (
                <ellipse
                  key={i}
                  cx="300"
                  cy="300"
                  rx={110 + i * 10}
                  ry="245"
                  fill="none"
                  stroke="url(#orbit)"
                  strokeWidth=".7"
                  opacity={0.16 + i * 0.025}
                  transform={`rotate(${i * 15} 300 300)`}
                />
              ))}
              <circle
                cx="300"
                cy="300"
                r="91"
                fill="#07060c"
                stroke="#503044"
                strokeWidth="1"
              />
            </motion.svg>
            <img className="hero-mark" src="/xrge-logo.webp" alt="" />
            <span className="art-coordinate mono">ML-DSA-65 · ML-KEM-768</span>
          </div>
        </div>
        <div className="container hero-foot">
          <span className="mono">{t("hero.designedFor")}</span>
          <a href="#technology" className="mono muted">
            {t("hero.discover")}
          </a>
        </div>
      </section>
      <section className="proof">
        <div className="container proof-grid">
          <div>
            <span className="proof-label">{t("proof.signatures")}</span>
            <strong>ML-DSA-65</strong>
            <span>FIPS 204</span>
          </div>
          <div>
            <span className="proof-label">{t("proof.kem")}</span>
            <strong>ML-KEM-768</strong>
            <span>FIPS 203</span>
          </div>
          <div>
            <span className="proof-label">{t("proof.contracts")}</span>
            <strong>WASM</strong>
            <span>{t("proof.programmable")}</span>
          </div>
          <a href="/explorer">
            <span className="proof-label">{t("proof.seeNetwork")}</span>
            <strong>
              {t("proof.exploreMainnet")} <ArrowUpRight size={21} />
            </strong>
            <span>{t("proof.readOnly")}</span>
          </a>
        </div>
      </section>
      <div className="container network-proof">
        <DataNote />
        <NetworkMetrics />
      </div>
      <Section id="technology" eyebrow={t("technology.eyebrow")}>
        <div className="section-heading">
          <h2>
            <Trans t={t} i18nKey="technology.title" components={{ br: <br /> }} />
          </h2>
          <p>
            <Trans t={t} i18nKey="technology.lead" components={{ br: <br /> }} />
          </p>
        </div>
        <div className="pillars">
          {(["pq", "programmable", "ecosystem"] as const).map((id, i) => [
            `0${i + 1}`,
            t(`technology.pillars.${id}.title`),
            t(`technology.pillars.${id}.body`),
          ]).map(([n, title, copy]) => (
            <article key={n}>
              <span className="mono muted">{n}</span>
              <h3>{title}</h3>
              <p>{copy}</p>
            </article>
          ))}
        </div>
      </Section>
      <MarketingSections />
    </main>
  );
}
