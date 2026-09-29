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
import Explore from "./explore/Explore";
import MarketingSections from "./MarketingSections";
export default function Home() {
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
              <Status state="demo">Mainnet</Status>
              <span className="kicker-sep" />
              <span className="mono muted">A NEW CRYPTOGRAPHIC FOUNDATION</span>
            </div>
            <h1>
              Post-quantum
              <br />
              <span className="gradient-text">from genesis.</span>
            </h1>
            <p>
              A programmable Layer 1 built around
              <br className="desktop" /> NIST-standardized post-quantum
              cryptography.
              <br className="desktop" /> The next era starts at the foundation.
            </p>
            <div className="actions">
              <a className="button" href="#explore">
                Explore RougeChain <ArrowRight size={16} />
              </a>
              <a className="button outline" href="#build">
                Start building
              </a>
            </div>
            <div className="hero-links">
              <TextLink href={WHITEPAPER_URL}>Whitepaper</TextLink>
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
            <span className="art-caption mono">
              01 / CRYPTOGRAPHY, RECONSIDERED
            </span>
            <span className="art-coordinate mono">ML-DSA-65 · ML-KEM-768</span>
          </div>
        </div>
        <div className="container hero-foot">
          <span className="mono">DESIGNED FOR A DIFFERENT FUTURE</span>
          <a href="#technology" className="mono muted">
            DISCOVER THE FOUNDATION ↓
          </a>
        </div>
      </section>
      <section className="proof">
        <div className="container proof-grid">
          <div>
            <span className="proof-label">SIGNATURES</span>
            <strong>ML-DSA-65</strong>
            <span>FIPS 204</span>
          </div>
          <div>
            <span className="proof-label">KEY ENCAPSULATION</span>
            <strong>ML-KEM-768</strong>
            <span>FIPS 203</span>
          </div>
          <div>
            <span className="proof-label">SMART CONTRACTS</span>
            <strong>WASM</strong>
            <span>Programmable by design</span>
          </div>
          <a href="/explorer">
            <span className="proof-label">SEE THE NETWORK</span>
            <strong>
              Explore mainnet <ArrowUpRight size={21} />
            </strong>
            <span>Read-only network explorer</span>
          </a>
        </div>
      </section>
      <div className="container network-proof">
        <DataNote />
        <NetworkMetrics />
      </div>
      <Section id="technology" eyebrow="01 / A different starting point">
        <div className="section-heading">
          <h2>
            The future shouldn’t
            <br />
            be a retrofit.
          </h2>
          <p>
            Post-quantum cryptography belongs at the core.
            <br />
            RougeChain starts there, then opens the
            <br />
            possibilities of a programmable network.
          </p>
        </div>
        <div className="pillars">
          {[
            [
              "01",
              "Post-quantum\nfrom genesis.",
              "Digital signatures built around ML-DSA-65. A cryptographic foundation designed for the post-quantum era.",
            ],
            [
              "02",
              "Programmable\nby design.",
              "WASM smart contracts make room for applications, tokens, and entirely new onchain experiences.",
            ],
            [
              "03",
              "An ecosystem,\nconnected.",
              "From explorers and swaps to encrypted communication. One network, a growing set of possibilities.",
            ],
          ].map(([n, title, copy]) => (
            <article key={n}>
              <span className="mono muted">{n}</span>
              <h3>{title}</h3>
              <p>{copy}</p>
            </article>
          ))}
        </div>
      </Section>
      <Explore />
      <MarketingSections />
    </main>
  );
}
