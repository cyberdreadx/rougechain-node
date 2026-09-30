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
import { useNetwork } from "./Network";
import { DOCS_URL, appById, appHref } from "./ecosystem/apps";

const slides = [
  { id: "qwalla", number: "01", label: "HOLD", short: "Qwalla" },
  { id: "swap", number: "02", label: "TRADE", short: "Swap" },
  { id: "bridge", number: "03", label: "MOVE", short: "Bridge" },
  { id: "talk", number: "04", label: "TALK", short: "Talk" },
  { id: "validate", number: "05", label: "VALIDATE", short: "Validate" },
  { id: "build", number: "06", label: "BUILD", short: "Build" },
] as const;

type SlideId = (typeof slides)[number]["id"];

function QwallaVisual() {
  return (
    <div className="possibility-visual possibility-qwalla">
      <div className="visual-caption mono">MOBILE WALLET · MAINNET</div>
      <div className="qwalla-phone">
        <div className="qwalla-phone-speaker" aria-hidden="true" />
        <img
          src="/qwalla-app.jpg"
          alt="Qwalla wallet application shown in a phone frame"
          width="1206"
          height="2459"
          loading="lazy"
        />
        <div className="qwalla-phone-home" aria-hidden="true" />
      </div>
      <div className="visual-meta visual-meta-left">
        <span>XRGE</span>
        <span>POST-QUANTUM WALLET</span>
      </div>
    </div>
  );
}

function SwapVisual() {
  return (
    <div
      className="possibility-visual possibility-swap"
      aria-label="Illustrative RougeChain swap interface"
    >
      <div className="visual-caption mono">
        ILLUSTRATIVE UI · ROUGECHAIN DEX
      </div>
      <div className="swap-showcase">
        <div className="swap-showcase-top">
          <span>SWAP</span>
          <span className="mono muted">MAINNET</span>
        </div>
        <div className="swap-showcase-field">
          <div>
            <span className="mono muted">PAY</span>
            <strong>1,250</strong>
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
            <span className="mono muted">RECEIVE</span>
            <strong>0.41</strong>
          </div>
          <div className="swap-token">
            <span className="token-orb">q</span>
            <span>qETH</span>
          </div>
        </div>
        <div className="swap-showcase-details">
          <span>Route</span>
          <strong>XRGE → qETH</strong>
          <span>Liquidity</span>
          <strong>Native AMM</strong>
        </div>
      </div>
      <div className="pool-strip">
        <span>XRGE / qETH</span>
        <span>XRGE / qUSDC</span>
        <span className="mono">POOLS</span>
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
  return (
    <div className="possibility-visual possibility-bridge">
      <div className="visual-caption mono">
        BASE MAINNET ↔ ROUGECHAIN L1 · SUPPORTED ROUTES
      </div>

      <div
        className="bridge-routing-panel"
        aria-label="Supported Base and RougeChain bridge routes"
      >
        <div className="bridge-routing-header">
          <div className="bridge-endpoint">
            <BaseSquareLogo />
            <div>
              <strong>BASE MAINNET</strong>
              <small>CHAIN 8453</small>
            </div>
          </div>

          <div className="bridge-routing-status mono">
            <span>BRIDGE</span>
            <span className="bridge-status-dot" aria-hidden="true" />
            <strong>ROUTES</strong>
          </div>

          <div className="bridge-endpoint bridge-endpoint-destination">
            <img src="/xrge-logo.webp" alt="" />
            <div>
              <strong>ROUGECHAIN L1</strong>
              <small>POST-QUANTUM NETWORK</small>
            </div>
          </div>
        </div>

        <div className="bridge-table-head mono" aria-hidden="true">
          <span>ASSET</span>
          <span>ROUTE</span>
          <span>RECEIVE</span>
        </div>

        <div className="bridge-route-table">
          <div className="bridge-route-item">
            <span className="bridge-asset">ETH</span>
            <span className="bridge-flow bridge-flow-forward">
              <span className="bridge-flow-line" />
              <span className="bridge-flow-label mono">BASE → ROUGE</span>
            </span>
            <span className="bridge-asset bridge-asset-receive">qETH</span>
          </div>

          <div className="bridge-route-item">
            <span className="bridge-asset">USDC</span>
            <span className="bridge-flow bridge-flow-forward">
              <span className="bridge-flow-line" />
              <span className="bridge-flow-label mono">BASE → ROUGE</span>
            </span>
            <span className="bridge-asset bridge-asset-receive">qUSDC</span>
          </div>

          <div className="bridge-route-item">
            <span className="bridge-asset">XRGE</span>
            <span className="bridge-flow bridge-flow-bidirectional">
              <span className="bridge-flow-line" />
              <span className="bridge-flow-label mono">TWO-WAY</span>
            </span>
            <span className="bridge-asset bridge-asset-receive">XRGE</span>
          </div>
        </div>

        <div className="bridge-routing-footer mono">
          <span>DEPOSIT · LOCK / MINT</span>
          <span>WITHDRAW · RELEASE / REFUND PROTECTION</span>
        </div>
      </div>
    </div>
  );
}

function TalkVisual() {
  return (
    <div className="possibility-visual possibility-talk">
      <div className="visual-caption mono">
        WALLET IDENTITY · PRIVATE COMMUNICATION
      </div>
      <div className="identity-line">
        <ShieldCheck size={15} />
        <span className="mono">rouge1c4…92da</span>
        <small>YOUR WALLET IDENTITY</small>
      </div>
      <div className="talk-windows">
        <div className="talk-window messenger-window">
          <div className="talk-window-title">
            <MessageCircle size={14} />
            <span>MESSENGER</span>
            <small>ENCRYPTED</small>
          </div>
          <div className="message-row">
            <span className="message-dot" />
            <div>
              <small>rouge1f8…63ab</small>
              <p>Are you joining the validator call?</p>
            </div>
          </div>
          <div className="message-row outgoing">
            <div>
              <small>YOU</small>
              <p>Yep — sending the notes now.</p>
            </div>
          </div>
        </div>
        <div className="talk-window mail-window">
          <div className="talk-window-title">
            <Mail size={14} />
            <span>MAIL</span>
            <small>ENCRYPTED</small>
          </div>
          <dl>
            <div>
              <dt>FROM</dt>
              <dd>rouge1d2…882e</dd>
            </div>
            <div>
              <dt>SUBJECT</dt>
              <dd>Validator proposal</dd>
            </div>
            <div>
              <dt>ENCRYPTED FOR</dt>
              <dd>rouge1c4…92da</dd>
            </div>
          </dl>
        </div>
      </div>
      <div className="crypto-ribbon mono">
        <span>ML-KEM-768</span>
        <span>KEY ENCAPSULATION</span>
        <span>AES-256-GCM</span>
        <span>AUTHENTICATED ENCRYPTION</span>
      </div>
    </div>
  );
}

function ValidateVisual() {
  const network = useNetwork();
  const data = network.data;
  const stateLabel =
    network.state === "live"
      ? "LIVE NETWORK DATA"
      : network.state === "stale"
        ? "STALE NETWORK READ"
        : "SAVED NETWORK SNAPSHOT";

  return (
    <div className="possibility-visual possibility-validate">
      <div className="visual-caption mono">
        VALIDATOR OPERATOR VIEW · {stateLabel}
      </div>

      <div
        className="validator-operator"
        aria-label="RougeChain validator operator dashboard and setup flow"
      >
        <div className="validator-operator-head">
          <div>
            <span className="mono">ROUGECHAIN VALIDATOR</span>
            <strong>Ready to participate.</strong>
          </div>
          <div className="validator-online">
            <span className="validator-online-dot" aria-hidden="true" />
            <span className="mono">OPERATOR FLOW</span>
          </div>
        </div>

        <div className="validator-overview-grid">
          <div className="validator-overview-primary">
            <span className="mono">TARGET STATUS</span>
            <strong>Producing blocks</strong>
            <small>
              The built-in <code>validator-status</code> check confirms each
              prerequisite before you go live.
            </small>
          </div>

          <div className="validator-stat">
            <span>MINIMUM STAKE</span>
            <strong>10,000</strong>
            <small>XRGE</small>
          </div>

          <div className="validator-stat">
            <span>NETWORK PEERS</span>
            <strong>{data?.peers ?? "—"}</strong>
            <small>{stateLabel}</small>
          </div>

          <div className="validator-stat">
            <span>LATEST BLOCK</span>
            <strong>{data?.height.toLocaleString() ?? "—"}</strong>
            <small>NETWORK HEIGHT</small>
          </div>
        </div>

        <div className="validator-setup">
          <div className="validator-setup-title mono">
            <span>SETUP</span>
            <span>ONE-COMMAND INSTALLER</span>
          </div>

          {[
            ["01", "Install node", "Dependencies, build, systemd service"],
            ["02", "Fund & stake", "Stake at least 10,000 XRGE"],
            ["03", "Verify status", "Funded · Staked · Active set"],
            ["04", "Produce blocks", "Start participating in consensus"],
          ].map(([step, title, detail]) => (
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
        <span>VALIDATORS {data?.validators ?? "—"}</span>
        <span>PUBLIC READ · {stateLabel}</span>
      </div>
    </div>
  );
}

function BuildVisual({ active }: { active: boolean }) {
  return (
    <div
      className={`possibility-visual possibility-build ${active ? "is-active" : ""}`}
    >
      <div className="visual-caption mono">
        REAL SDK + MCP INTEGRATION · MAINNET
      </div>
      <div
        className="build-code-terminal"
        aria-label="Terminal typing a RougeChain SDK and MCP integration"
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
      <div className="build-terminal-footer mono">
        SDK · WASM CONTRACTS · MCP · LOCAL ML-DSA-65 SIGNING
      </div>
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

const slideCopy: Record<
  SlideId,
  {
    headline: React.ReactNode;
    emphasis?: React.ReactNode;
    body: React.ReactNode;
    technical?: string;
    primary: { label: string; href: string };
    secondary?: { label: string; href: string };
    reverse?: boolean;
  }
> = {
  qwalla: {
    headline: (
      <>
        Your assets.
        <br />
        Ready for what’s next.
      </>
    ),
    body: "Qwalla brings the RougeChain ecosystem into your pocket. Hold XRGE, manage your wallet, and move through the network from one mobile experience.",
    primary: { label: "Discover Qwalla", href: appHref(appById("qwalla")!) },
  },
  swap: {
    headline: (
      <>
        Trade. Provide liquidity.
        <br />
        Stay onchain.
      </>
    ),
    body: "Swap assets, discover liquidity, and participate in RougeChain markets through a native DeFi experience built around the network.",
    primary: { label: "Explore Swap", href: "/swap" },
    secondary: { label: "View liquidity pools", href: "/swap/pools" },
    reverse: true,
  },
  bridge: {
    headline: (
      <>
        Move assets between chains.
        <br />
        Bring them into the post-quantum era.
      </>
    ),
    body: "Move supported assets between RougeChain and connected networks, bringing value from conventional chains into a network designed around post-quantum security.",
    technical: "Base mainnet · ETH ↔ qETH · USDC ↔ qUSDC · XRGE",
    primary: { label: "Explore Bridge", href: appHref(appById("bridge")!) },
  },
  talk: {
    headline: (
      <>
        Your wallet is also
        <br />a private identity.
      </>
    ),
    emphasis: (
      <>
        Message. Email. Encrypt.
        <br />
        Post-quantum communication, wallet to wallet.
      </>
    ),
    body: "Send post-quantum encrypted messages and email directly between wallet identities. RougeChain turns the wallet into more than a way to transact—it becomes a secure communication layer.",
    technical:
      "ML-KEM-768 key encapsulation · AES-256-GCM authenticated encryption",
    primary: { label: "Open Messenger", href: appHref(appById("messenger")!) },
    secondary: { label: "Explore Mail", href: appHref(appById("mail")!) },
    reverse: true,
  },
  validate: {
    headline: (
      <>
        Don’t just use the network.
        <br />
        Help secure it.
      </>
    ),
    body: "From a fresh Linux server to a syncing RougeChain node in one command. Stake at least 10,000 XRGE, verify your validator status, and start participating directly in network consensus.",
    technical:
      "One-command installer · systemd service · built-in validator status · modest VPS requirements",
    primary: {
      label: "Run a Validator",
      href: "https://docs.rougechain.io/staking/becoming-validator",
    },
    secondary: {
      label: "Explore Validators",
      href: appHref(appById("validators")!),
    },
  },
  build: {
    headline: (
      <>
        Built for developers.
        <br />
        Ready for agents.
      </>
    ),
    emphasis: (
      <>Build the application. Build the agent. Connect both to the chain.</>
    ),
    body: "RougeChain was designed for a world where developers build applications and autonomous agents side by side. Use WASM smart contracts and the RougeChain SDK to build onchain software, then give AI agents native MCP tools to understand the network, work across applications, coordinate workflows, and perform authorized onchain actions.",
    technical: "WASM smart contracts · RougeChain SDK · native MCP tooling",
    primary: { label: "Start Building", href: "#build" },
    secondary: { label: "Explore MCP for Agents", href: DOCS_URL },
    reverse: true,
  },
};

export default function EcosystemCarousel() {
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
          aria-label="RougeChain possibilities"
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
              {slide.short}
            </button>
          ))}
        </div>
        <div className="possibilities-arrows">
          <span className="mono">
            {String(active + 1).padStart(2, "0")} /{" "}
            {String(slides.length).padStart(2, "0")}
          </span>
          <button
            aria-label="Previous possibility"
            onClick={() => goTo(active - 1)}
          >
            <ArrowLeft size={16} />
          </button>
          <button
            aria-label="Next possibility"
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
        aria-label="Scrollable ecosystem use cases"
      >
        {slides.map((slide, index) => {
          const copy = slideCopy[slide.id];
          return (
            <article
              id={`possibility-${slide.id}`}
              key={slide.id}
              className={`possibility-slide ${copy.reverse ? "reverse" : ""}`}
              aria-roledescription="slide"
              aria-label={`${slide.number} of ${slides.length}: ${slide.short}`}
            >
              <SlideVisual id={slide.id} active={active === index} />
              <div className="possibility-copy">
                <span className="possibility-eyebrow mono">
                  {slide.number} / {slide.label}
                </span>
                <h3>{copy.headline}</h3>
                {copy.emphasis && (
                  <p className="possibility-emphasis">{copy.emphasis}</p>
                )}
                <p>{copy.body}</p>
                {copy.technical && (
                  <p className="possibility-technical mono">{copy.technical}</p>
                )}
                <div className="possibility-actions">
                  <a className="text-link" href={copy.primary.href}>
                    {copy.primary.label} <ArrowUpRight size={15} />
                  </a>
                  {copy.secondary && (
                    <a className="text-link muted" href={copy.secondary.href}>
                      {copy.secondary.label} <ArrowUpRight size={15} />
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
          DRAG / SWIPE OR USE ARROWS <span aria-hidden="true">→</span>
        </span>
        <span aria-hidden="true">
          {String(active + 1).padStart(2, "0")} /{" "}
          {String(slides.length).padStart(2, "0")}
        </span>
      </div>
    </div>
  );
}
