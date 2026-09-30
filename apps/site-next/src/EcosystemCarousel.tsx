import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  Mail,
  MessageCircle,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useNetwork } from "./Network";
import { DOCS_URL, appById, appHref } from "./ecosystem/apps";
import { fmtInt, fmtNum } from "./i18n/format";

// Copy lives in the `marketing` namespace under carousel.slides.<id> (short, label, headline, …).
const slides = [
  { id: "qwalla", number: "01" },
  { id: "swap", number: "02" },
  { id: "bridge", number: "03" },
  { id: "talk", number: "04" },
  { id: "validate", number: "05" },
  { id: "build", number: "06" },
] as const;

const MIN_VALIDATOR_STAKE = 10_000;
const BR = { br: <br /> };

type SlideId = (typeof slides)[number]["id"];

function QwallaVisual() {
  const { t } = useTranslation("marketing");
  return (
    <div className="possibility-visual possibility-qwalla">
      <div className="visual-caption mono">{t("carousel.qwalla.caption")}</div>
      <div className="qwalla-phone">
        <div className="qwalla-phone-speaker" aria-hidden="true" />
        <img
          src="/qwalla-app.jpg"
          alt={t("carousel.qwalla.imageAlt")}
          width="1206"
          height="2459"
          loading="lazy"
        />
        <div className="qwalla-phone-home" aria-hidden="true" />
      </div>
      <div className="visual-meta visual-meta-left">
        <span>XRGE</span>
        <span>{t("carousel.qwalla.meta")}</span>
      </div>
    </div>
  );
}

function SwapVisual() {
  const { t } = useTranslation("marketing");
  return (
    <div
      className="possibility-visual possibility-swap"
      aria-label={t("carousel.swap.label")}
    >
      <div className="visual-caption mono">{t("carousel.swap.caption")}</div>
      <div className="swap-showcase">
        <div className="swap-showcase-top">
          <span>{t("carousel.swap.title")}</span>
          <span className="mono muted">{t("carousel.swap.network")}</span>
        </div>
        <div className="swap-showcase-field">
          <div>
            <span className="mono muted">{t("carousel.swap.pay")}</span>
            <strong>{fmtInt(1250)}</strong>
          </div>
          <div className="swap-token">
            <img src="/xrge-logo.webp" alt="" />
            <span>XRGE</span>
          </div>
        </div>
        <div className="swap-showcase-switch" aria-hidden="true">
          ↓
        </div>
        <div className="swap-showcase-field">
          <div>
            <span className="mono muted">{t("carousel.swap.receive")}</span>
            <strong>{fmtNum(0.41)}</strong>
          </div>
          <div className="swap-token">
            <span className="token-orb">q</span>
            <span>qETH</span>
          </div>
        </div>
        <div className="swap-showcase-details">
          <span>{t("carousel.swap.route")}</span>
          <strong>XRGE → qETH</strong>
          <span>{t("carousel.swap.liquidity")}</span>
          <strong>{t("carousel.swap.amm")}</strong>
        </div>
      </div>
      <div className="pool-strip">
        <span>XRGE / qETH</span>
        <span>XRGE / qUSDC</span>
        <span className="mono">{t("carousel.swap.pools")}</span>
      </div>
    </div>
  );
}

function BaseSquareLogo() {
  return (
    <span
      className="base-square-logo"
      role="img"
      aria-label="Base"
      title="Base"
    />
  );
}

function BridgeVisual() {
  const { t } = useTranslation("marketing");
  return (
    <div className="possibility-visual possibility-bridge">
      <div className="visual-caption mono">{t("carousel.bridge.caption")}</div>

      <div
        className="bridge-routing-panel"
        aria-label={t("carousel.bridge.label")}
      >
        <div className="bridge-routing-header">
          <div className="bridge-endpoint">
            <BaseSquareLogo />
            <div>
              <strong>{t("carousel.bridge.baseMainnet")}</strong>
              <small>{t("carousel.bridge.chain", { id: 8453 })}</small>
            </div>
          </div>

          <div className="bridge-routing-status mono">
            <span>{t("carousel.bridge.bridge")}</span>
            <span className="bridge-status-dot" aria-hidden="true" />
            <strong>{t("carousel.bridge.routes")}</strong>
          </div>

          <div className="bridge-endpoint bridge-endpoint-destination">
            <img src="/xrge-logo.webp" alt="" />
            <div>
              <strong>{t("carousel.bridge.rougechainL1")}</strong>
              <small>{t("carousel.bridge.pqNetwork")}</small>
            </div>
          </div>
        </div>

        <div className="bridge-table-head mono" aria-hidden="true">
          <span>{t("carousel.bridge.asset")}</span>
          <span>{t("carousel.bridge.route")}</span>
          <span>{t("carousel.bridge.receive")}</span>
        </div>

        <div className="bridge-route-table">
          <div className="bridge-route-item">
            <span className="bridge-asset">ETH</span>
            <span className="bridge-flow bridge-flow-forward">
              <span className="bridge-flow-line" />
              <span className="bridge-flow-label mono">{t("carousel.bridge.forward")}</span>
            </span>
            <span className="bridge-asset bridge-asset-receive">qETH</span>
          </div>

          <div className="bridge-route-item">
            <span className="bridge-asset">USDC</span>
            <span className="bridge-flow bridge-flow-forward">
              <span className="bridge-flow-line" />
              <span className="bridge-flow-label mono">{t("carousel.bridge.forward")}</span>
            </span>
            <span className="bridge-asset bridge-asset-receive">qUSDC</span>
          </div>

          <div className="bridge-route-item">
            <span className="bridge-asset">XRGE</span>
            <span className="bridge-flow bridge-flow-bidirectional">
              <span className="bridge-flow-line" />
              <span className="bridge-flow-label mono">{t("carousel.bridge.twoWay")}</span>
            </span>
            <span className="bridge-asset bridge-asset-receive">XRGE</span>
          </div>
        </div>

        <div className="bridge-routing-footer mono">
          <span>{t("carousel.bridge.deposit")}</span>
          <span>{t("carousel.bridge.withdraw")}</span>
        </div>
      </div>
    </div>
  );
}

function TalkVisual() {
  const { t } = useTranslation("marketing");
  return (
    <div className="possibility-visual possibility-talk">
      <div className="visual-caption mono">{t("carousel.talk.caption")}</div>
      <div className="identity-line">
        <ShieldCheck size={15} />
        <span className="mono">rouge1c4…92da</span>
        <small>{t("carousel.talk.yourIdentity")}</small>
      </div>
      <div className="talk-windows">
        <div className="talk-window messenger-window">
          <div className="talk-window-title">
            <MessageCircle size={14} />
            <span>{t("carousel.talk.messenger")}</span>
            <small>{t("carousel.talk.encrypted")}</small>
          </div>
          <div className="message-row">
            <span className="message-dot" />
            <div>
              <small>rouge1f8…63ab</small>
              <p>{t("carousel.talk.incoming")}</p>
            </div>
          </div>
          <div className="message-row outgoing">
            <div>
              <small>{t("carousel.talk.you")}</small>
              <p>{t("carousel.talk.outgoing")}</p>
            </div>
          </div>
        </div>
        <div className="talk-window mail-window">
          <div className="talk-window-title">
            <Mail size={14} />
            <span>{t("carousel.talk.mail")}</span>
            <small>{t("carousel.talk.encrypted")}</small>
          </div>
          <dl>
            <div>
              <dt>{t("carousel.talk.from")}</dt>
              <dd>rouge1d2…882e</dd>
            </div>
            <div>
              <dt>{t("carousel.talk.subject")}</dt>
              <dd>{t("carousel.talk.subjectValue")}</dd>
            </div>
            <div>
              <dt>{t("carousel.talk.encryptedFor")}</dt>
              <dd>rouge1c4…92da</dd>
            </div>
          </dl>
        </div>
      </div>
      <div className="crypto-ribbon mono">
        <span>ML-KEM-768</span>
        <span>{t("carousel.talk.kem")}</span>
        <span>AES-256-GCM</span>
        <span>{t("carousel.talk.aead")}</span>
      </div>
    </div>
  );
}

function ValidateVisual() {
  const { t } = useTranslation("marketing");
  const network = useNetwork();
  const data = network.data;
  const stateLabel =
    network.state === "live"
      ? t("carousel.validate.live")
      : network.state === "stale"
        ? t("carousel.validate.stale")
        : t("carousel.validate.snapshot");

  return (
    <div className="possibility-visual possibility-validate">
      <div className="visual-caption mono">
        {t("carousel.validate.caption", { state: stateLabel })}
      </div>

      <div
        className="validator-operator"
        aria-label={t("carousel.validate.label")}
      >
        <div className="validator-operator-head">
          <div>
            <span className="mono">{t("carousel.validate.validator")}</span>
            <strong>{t("carousel.validate.ready")}</strong>
          </div>
          <div className="validator-online">
            <span className="validator-online-dot" aria-hidden="true" />
            <span className="mono">{t("carousel.validate.operatorFlow")}</span>
          </div>
        </div>

        <div className="validator-overview-grid">
          <div className="validator-overview-primary">
            <span className="mono">{t("carousel.validate.targetStatus")}</span>
            <strong>{t("carousel.validate.producing")}</strong>
            <small>
              <Trans
                t={t}
                i18nKey="carousel.validate.check"
                components={{ code: <code /> }}
              />
            </small>
          </div>

          <div className="validator-stat">
            <span>{t("carousel.validate.minStake")}</span>
            <strong>{fmtInt(MIN_VALIDATOR_STAKE)}</strong>
            <small>XRGE</small>
          </div>

          <div className="validator-stat">
            <span>{t("carousel.validate.peers")}</span>
            <strong>{data ? fmtInt(data.peers) : "—"}</strong>
            <small>{stateLabel}</small>
          </div>

          <div className="validator-stat">
            <span>{t("carousel.validate.latestBlock")}</span>
            <strong>{data ? fmtInt(data.height) : "—"}</strong>
            <small>{t("carousel.validate.networkHeight")}</small>
          </div>
        </div>

        <div className="validator-setup">
          <div className="validator-setup-title mono">
            <span>{t("carousel.validate.setup")}</span>
            <span>{t("carousel.validate.installer")}</span>
          </div>

          {(["install", "stake", "verify", "produce"] as const).map((id, i) => [
            `0${i + 1}`,
            t(`carousel.validate.steps.${id}.title`),
            t(`carousel.validate.steps.${id}.detail`, {
              amount: fmtInt(MIN_VALIDATOR_STAKE),
            }),
          ]).map(([step, title, detail]) => (
            <div className="validator-step" key={step}>
              <span className="validator-step-number mono">{step}</span>
              <div>
                <strong>{title}</strong>
                <small>{detail}</small>
              </div>
              <Check size={13} aria-hidden="true" />
            </div>
          ))}
        </div>

        <div className="validator-command-strip mono">
          <span className="terminal-prompt">$</span>
          <code>
            PUBLIC_URL=https://node.example.com bash &lt;(curl -sSL
            .../install-validator.sh)
          </code>
        </div>
      </div>

      <div className="validator-network-footer mono">
        <span>
          {t("carousel.validate.validators", {
            n: data ? fmtInt(data.validators) : "—",
          })}
        </span>
        <span>{t("carousel.validate.publicRead", { state: stateLabel })}</span>
      </div>
    </div>
  );
}

function BuildVisual({ active }: { active: boolean }) {
  const { t } = useTranslation("marketing");
  return (
    <div
      className={`possibility-visual possibility-build ${active ? "is-active" : ""}`}
    >
      <div className="visual-caption mono">{t("carousel.build.caption")}</div>
      <div
        className="build-code-terminal"
        aria-label={t("carousel.build.label")}
      >
        <div className="build-terminal-title">
          <div className="terminal-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <span className="mono">agent.ts — zsh</span>
          <Terminal size={13} />
        </div>

        <div className="build-terminal-body" aria-hidden="true">
          <div className="type-line type-line-1">
            <span className="terminal-prompt">$</span>{" "}
            <span className="term-command">npm install</span>{" "}
            <span className="term-package">@rougechain/sdk</span>
          </div>
          <div className="type-line type-line-2 term-output">
            added @rougechain/sdk
          </div>
          <div className="type-line type-line-3">
            <span className="term-keyword">import</span>{" "}
            <span className="term-punctuation">{"{"}</span>{" "}
            <span className="term-class">RougeChain</span>{" "}
            <span className="term-punctuation">{"}"}</span>{" "}
            <span className="term-keyword">from</span>{" "}
            <span className="term-string">"@rougechain/sdk"</span>;
          </div>
          <div className="type-line type-line-4">
            <span className="term-keyword">const</span> rc ={" "}
            <span className="term-keyword">new</span>{" "}
            <span className="term-class">RougeChain</span>(
          </div>
          <div className="type-line type-line-5 term-indent">
            <span className="term-string">"https://api.rougechain.io/api"</span>
          </div>
          <div className="type-line type-line-6">);</div>
          <div className="type-line type-line-7">
            <span className="term-keyword">const</span> pools ={" "}
            <span className="term-keyword">await</span> rc.dex.getPools();
          </div>
          <div className="type-line type-line-8 term-comment">
            // Give an AI agent native RougeChain tools
          </div>
          <div className="type-line type-line-9">
            <span className="terminal-prompt">$</span>{" "}
            <span className="term-env">ROUGECHAIN_URL</span>=
            <span className="term-string">https://api.rougechain.io</span>{" "}
            <span className="term-command">npx</span>{" "}
            <span className="term-package">@rougechain/mcp-server</span>
          </div>
          <div className="type-line type-line-10 term-success">
            rougechain MCP ready <span className="terminal-cursor">▋</span>
          </div>
        </div>
      </div>
      <div className="build-terminal-footer mono">{t("carousel.build.footer")}</div>
    </div>
  );
}

function SlideVisual({ id, active }: { id: SlideId; active: boolean }) {
  if (id === "qwalla") return <QwallaVisual />;
  if (id === "swap") return <SwapVisual />;
  if (id === "bridge") return <BridgeVisual />;
  if (id === "talk") return <TalkVisual />;
  if (id === "validate") return <ValidateVisual />;
  return <BuildVisual active={active} />;
}

/** Links and layout per slide; the copy is carousel.slides.<id>.* in the marketing namespace. */
const slideLinks: Record<
  SlideId,
  {
    emphasis?: boolean;
    technical?: boolean;
    primary: string;
    secondary?: string;
    reverse?: boolean;
  }
> = {
  qwalla: { primary: appHref(appById("qwalla")!) },
  swap: { primary: "/swap", secondary: "/swap/pools", reverse: true },
  bridge: { technical: true, primary: appHref(appById("bridge")!) },
  talk: {
    emphasis: true,
    technical: true,
    primary: appHref(appById("messenger")!),
    secondary: appHref(appById("mail")!),
    reverse: true,
  },
  validate: {
    technical: true,
    primary: "https://docs.rougechain.io/staking/becoming-validator",
    secondary: appHref(appById("validators")!),
  },
  build: {
    emphasis: true,
    technical: true,
    primary: "#build",
    secondary: DOCS_URL,
    reverse: true,
  },
};

export default function EcosystemCarousel() {
  const { t } = useTranslation("marketing");
  const [active, setActive] = useState(0);
  const [entered, setEntered] = useState(false);
  const carouselRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const frame = useRef<number | null>(null);

  const reducedMotion = () =>
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const goTo = (index: number) => {
    const bounded = (index + slides.length) % slides.length;
    setActive(bounded);
    const track = trackRef.current;
    const target = track?.children[bounded] as HTMLElement | undefined;
    if (!track || !target) return;
    track.scrollTo?.({
      left: target.offsetLeft - track.offsetLeft,
      behavior: reducedMotion() ? "auto" : "smooth",
    });
  };

  useEffect(() => {
    const carousel = carouselRef.current;
    if (!carousel) return;

    if (!("IntersectionObserver" in window) || reducedMotion()) {
      setEntered(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setEntered(true);
          observer.disconnect();
        }
      },
      { threshold: 0.28 },
    );

    observer.observe(carousel);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    const onScroll = () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        const children = Array.from(track.children) as HTMLElement[];
        const closest = children.reduce(
          (best, child, index) => {
            const distance = Math.abs(
              child.offsetLeft - track.offsetLeft - track.scrollLeft,
            );
            return distance < best.distance ? { index, distance } : best;
          },
          { index: 0, distance: Number.POSITIVE_INFINITY },
        );
        setActive(closest.index);
      });
    };

    track.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      track.removeEventListener("scroll", onScroll);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      goTo(active + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      goTo(active - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      goTo(0);
    } else if (event.key === "End") {
      event.preventDefault();
      goTo(slides.length - 1);
    }
  };

  return (
    <div
      ref={carouselRef}
      className={`possibilities-carousel ${entered ? "has-entered" : ""}`}
    >
      <div className="possibilities-controls">
        <div
          className="possibilities-tabs"
          role="tablist"
          aria-label={t("carousel.tabsLabel")}
        >
          {slides.map((slide, index) => (
            <button
              key={slide.id}
              role="tab"
              aria-selected={active === index}
              aria-controls={`possibility-${slide.id}`}
              onClick={() => goTo(index)}
            >
              <span>{slide.number}</span>
              {t(`carousel.slides.${slide.id}.short`)}
            </button>
          ))}
        </div>
        <div className="possibilities-arrows">
          <span className="mono">
            {String(active + 1).padStart(2, "0")} /{" "}
            {String(slides.length).padStart(2, "0")}
          </span>
          <button
            aria-label={t("carousel.previous")}
            onClick={() => goTo(active - 1)}
          >
            <ArrowLeft size={16} />
          </button>
          <button
            aria-label={t("carousel.next")}
            onClick={() => goTo(active + 1)}
          >
            <ArrowRight size={16} />
          </button>
        </div>
      </div>

      <div
        className="possibilities-track"
        ref={trackRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        aria-label={t("carousel.trackLabel")}
      >
        {slides.map((slide, index) => {
          const copy = slideLinks[slide.id];
          const key = `carousel.slides.${slide.id}`;
          return (
            <article
              id={`possibility-${slide.id}`}
              key={slide.id}
              className={`possibility-slide ${copy.reverse ? "reverse" : ""}`}
              aria-roledescription="slide"
              aria-label={t("carousel.slideLabel", {
                n: slide.number,
                total: slides.length,
                name: t(`${key}.short`),
              })}
            >
              <SlideVisual id={slide.id} active={active === index} />
              <div className="possibility-copy">
                <span className="possibility-eyebrow mono">
                  {slide.number} / {t(`${key}.label`)}
                </span>
                <h3>
                  <Trans t={t} i18nKey={`${key}.headline`} components={BR} />
                </h3>
                {copy.emphasis && (
                  <p className="possibility-emphasis">
                    <Trans t={t} i18nKey={`${key}.emphasis`} components={BR} />
                  </p>
                )}
                <p>
                  {t(`${key}.body`, { amount: fmtInt(MIN_VALIDATOR_STAKE) })}
                </p>
                {copy.technical && (
                  <p className="possibility-technical mono">
                    {t(`${key}.technical`)}
                  </p>
                )}
                <div className="possibility-actions">
                  <a className="text-link" href={copy.primary}>
                    {t(`${key}.primary`)} <ArrowUpRight size={15} />
                  </a>
                  {copy.secondary && (
                    <a className="text-link muted" href={copy.secondary}>
                      {t(`${key}.secondary`)} <ArrowUpRight size={15} />
                    </a>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>

      <div className="possibilities-hint mono">
        <span>
          {t("carousel.hint")} <span aria-hidden="true">→</span>
        </span>
        <span aria-hidden="true">
          {String(active + 1).padStart(2, "0")} /{" "}
          {String(slides.length).padStart(2, "0")}
        </span>
      </div>
    </div>
  );
}
