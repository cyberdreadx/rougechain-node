import { useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  RefreshCw,
  Search,
} from "lucide-react";
import { Button, EmptyState, Status } from "@rougechain/ui";
import {
  formatTokenAmount,
  formatXrge,
  isRougeAddress,
  safeImageUrl,
  shorten,
  toRougeAddress,
  txTypeLabel,
  type ReadState,
} from "@rougechain/chain-readonly";
import { useChain } from "./chain";
import type { Read } from "./read";
import { useRead, useTokenDecimals } from "./read";
import { resolveSearch } from "./search";
import i18n from "../i18n";
import { fmtDateTime, fmtInt, fmtTime } from "../i18n/format";

/** Compact "x ago" in the current language (translated at call time). */
export function age(timestamp: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  const ago = (unit: string, n: number) =>
    i18n.t(`explorer:age.${unit}`, { n: fmtInt(n) });
  if (seconds < 60) return ago("seconds", seconds);
  if (seconds < 3600) return ago("minutes", Math.floor(seconds / 60));
  if (seconds < 86400) return ago("hours", Math.floor(seconds / 3600));
  return ago("days", Math.floor(seconds / 86400));
}

/** The network's display name ("Mainnet" / "Testnet", メインネット in Japanese). */
export function useNetworkLabel(): string {
  const { t } = useTranslation("explorer");
  const { network } = useChain();
  return t(`network.${network}`);
}

/** Lower-case a noun for use mid-sentence, leaving acronyms such as "NFTs" alone. */
function midSentence(what: string) {
  return /[A-Z]{2}/.test(what) ? what : what.toLowerCase();
}

/** Shortened identifier with a copy button; exposes the full value if the clipboard is denied. */
export function CopyHash({
  hash,
  label: labelProp,
  display,
}: {
  hash: string;
  label?: string;
  display?: ReactNode;
}) {
  const { t } = useTranslation("explorer");
  const label = labelProp ?? t("copy.hash");
  const [copied, setCopied] = useState(false),
    [failed, setFailed] = useState(false);
  return (
    <div className="hash-cell">
      {display ?? (
        <span className="mono" title={hash}>
          {hash.slice(0, 10)}…{hash.slice(-6)}
        </span>
      )}
      <Button
        variant="ghost icon copy-button"
        aria-label={t("copy.aria", { label, hash })}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(hash);
            setCopied(true);
            setFailed(false);
            setTimeout(() => setCopied(false), 1800);
          } catch {
            setCopied(false);
            setFailed(true);
          }
        }}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </Button>
      <span className="sr-only" role="status">
        {copied
          ? t("copy.copied", {
              label: `${label[0].toUpperCase()}${label.slice(1)}`,
            })
          : failed
            ? t("copy.failed", { label })
            : ""}
      </span>
      {failed && <code className="copy-fallback">{hash}</code>}
    </div>
  );
}

const STATE_KEY: Record<ReadState, string> = {
  live: "state.live",
  stale: "state.stale",
  loading: "state.loading",
  unavailable: "state.unavailable",
  "not-found": "state.notFound",
};

export function ReadStatus({ read }: { read: Pick<Read<unknown>, "state"> }) {
  const { t } = useTranslation("explorer");
  const state = read.state === "not-found" ? "unavailable" : read.state;
  return <Status state={state}>{t(STATE_KEY[read.state])}</Status>;
}

/** Provenance line: where the data came from and how fresh it is. */
export function SourceNote({
  read,
  what,
}: {
  read: Read<unknown>;
  what: string;
}) {
  const { t } = useTranslation("explorer");
  const network = useNetworkLabel();
  const time = read.updatedAt
    ? fmtTime(read.updatedAt, {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;
  const whatLower = midSentence(what);
  return (
    <div className="data-note explorer-source" role="status">
      <ReadStatus read={read} />
      <span>
        {read.state === "live" && t("source.live", { what, network, time })}
        {read.state === "stale" &&
          t(read.error ? "source.staleFailed" : "source.staleOverdue", {
            time,
          })}
        {read.state === "loading" &&
          t("source.loading", { what: whatLower, network })}
        {read.state === "unavailable" &&
          t("source.unavailable", { what, network })}
        {read.state === "not-found" && t("source.notFound", { network })}
      </span>
      {read.state !== "loading" && read.state !== "not-found" && (
        <Button
          variant="ghost icon copy-button"
          aria-label={t("source.refresh", { what: whatLower })}
          disabled={read.isFetching}
          onClick={read.refetch}
        >
          <RefreshCw size={13} />
        </Button>
      )}
    </div>
  );
}

/** Loading / unavailable / not-found states for a read; renders children once data exists. */
export function ReadGate<T>({
  read,
  what,
  notFound,
  children,
}: {
  read: Read<T>;
  what: string;
  notFound?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  const { t } = useTranslation("explorer");
  if (read.data !== undefined) return <>{children(read.data)}</>;
  if (read.state === "not-found")
    return (
      <>
        {notFound ?? (
          <EmptyState title={t("gate.notFoundTitle", { what })}>
            {t("gate.notFoundBody")}
          </EmptyState>
        )}
      </>
    );
  if (read.state === "unavailable")
    return (
      <EmptyState title={t("gate.unavailableTitle", { what })}>
        {t("gate.unavailableBody")}{" "}
        <button className="inline-link" onClick={read.refetch}>
          {t("gate.tryAgain")}
        </button>
      </EmptyState>
    );
  return (
    <EmptyState title={t("gate.loadingTitle", { what: midSentence(what) })}>
      {t("gate.loadingBody")}
    </EmptyState>
  );
}

export function PageHeading({
  eyebrow,
  title,
  children,
  aside,
}: {
  eyebrow: string;
  title: ReactNode;
  children?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="app-page-heading">
      <div className="heading-copy">
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        {children && <p>{children}</p>}
      </div>
      {aside ?? <NetworkBadge />}
    </div>
  );
}

/** Network indicator, with an in-page switch only when the deploy is not pinned. */
export function NetworkBadge() {
  const { t } = useTranslation("explorer");
  const { network, locked, setNetwork } = useChain();
  if (locked) return <span className="pill">{t(`network.${network}`)}</span>;
  return (
    <div className="mode-switch" role="group" aria-label={t("network.label")}>
      {(["mainnet", "testnet"] as const).map((id) => (
        <Button
          key={id}
          variant={network === id ? "secondary small" : "ghost small"}
          aria-pressed={network === id}
          onClick={() => setNetwork(id)}
        >
          {t(`network.${id}`)}
        </Button>
      ))}
    </div>
  );
}

export function ExplorerSearch({ autoFocus = false }: { autoFocus?: boolean }) {
  const { t } = useTranslation("explorer");
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [miss, setMiss] = useState(false);
  const tokens = useRead(["tokens"], (c) => c.tokens(), { refetchMs: 300_000 });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const target = resolveSearch(
      value,
      tokens.data?.map((tok) => tok.symbol),
    );
    setMiss(!target);
    if (target) navigate(target.path);
  };
  return (
    <form role="search" onSubmit={submit} className="explorer-search-form">
      <div className="explorer-search">
        <Search size={18} />
        <label className="sr-only" htmlFor="explorer-search">
          {t("search.label")}
        </label>
        <input
          id="explorer-search"
          autoFocus={autoFocus}
          placeholder={t("search.placeholder")}
          value={value}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setValue(e.target.value);
            setMiss(false);
          }}
        />
        <Button variant="secondary small" type="submit">
          {t("search.submit")}
        </Button>
      </div>
      {miss && (
        <p className="search-hint" role="alert">
          {t("search.miss")}
        </p>
      )}
    </form>
  );
}

const FULL_TIME: Intl.DateTimeFormatOptions = {
  dateStyle: "medium",
  timeStyle: "medium",
};

export function Age({ ts }: { ts: number }) {
  useTranslation("explorer"); // re-render on a language change
  const date = new Date(ts);
  return (
    <time dateTime={date.toISOString()} title={fmtDateTime(date, FULL_TIME)}>
      {age(ts)}
    </time>
  );
}

export function Timestamp({ ts }: { ts: number }) {
  useTranslation("explorer"); // re-render on a language change
  const date = new Date(ts);
  return (
    <span>
      <time dateTime={date.toISOString()}>{fmtDateTime(date, FULL_TIME)}</time>{" "}
      <span className="muted">({age(ts)})</span>
    </span>
  );
}

/**
 * An identity as the node reports it (public key hex or rouge1), shown as a short rouge1 address
 * and linked to its address page. Anything else (e.g. "Liquidity Pool (QTEK)") is shown as text.
 */
export function AddressLink({
  identity,
  full = false,
}: {
  identity: string;
  full?: boolean;
}) {
  const { t } = useTranslation("explorer");
  if (!identity) return <span className="muted">—</span>;
  if (identity === "genesis")
    return <span className="muted">{t("genesis")}</span>;
  let address: string | null = null;
  try {
    address = toRougeAddress(identity);
  } catch {
    address = null;
  }
  if (!address) return <span className="mono">{identity}</span>;
  const pubkey = isRougeAddress(identity) ? undefined : identity;
  return (
    <Link
      className="mono address-link"
      to={`/address/${address}`}
      state={pubkey ? { pubkey } : undefined}
      title={address}
    >
      {full ? address : shorten(address, 12, 6)}
    </Link>
  );
}

export function HashLink({ hash, to }: { hash: string; to: string }) {
  return (
    <Link className="mono address-link" to={to} title={hash}>
      {shorten(hash, 10, 6)}
    </Link>
  );
}

export function BlockLink({ height }: { height: number }) {
  useTranslation("explorer"); // re-render on a language change
  return (
    <Link className="address-link" to={`/block/${height}`}>
      #{fmtInt(height)}
    </Link>
  );
}

export function TypePill({ type }: { type: string }) {
  const { t } = useTranslation("explorer");
  return (
    <span className={`pill type-${type.replace(/[^a-z_]/g, "")}`}>
      {t(`txType.${type}`, { defaultValue: txTypeLabel(type) })}
    </span>
  );
}

/** A raw on-chain token amount shown in whole units with the token's decimals. */
export function Amount({
  raw,
  symbol,
  link = true,
}: {
  raw: number | null;
  symbol: string;
  link?: boolean;
}) {
  const decimals = useTokenDecimals();
  if (raw === null) return <span className="muted">—</span>;
  return (
    <span className="amount">
      {formatTokenAmount(raw, symbol, decimals)}{" "}
      {link ? (
        <Link
          className="address-link"
          to={`/token/${encodeURIComponent(symbol)}`}
        >
          {symbol}
        </Link>
      ) : (
        symbol
      )}
    </span>
  );
}

export function Xrge({ amount }: { amount: number }) {
  return <span className="amount">{formatXrge(amount)} XRGE</span>;
}

export function DetailList({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="detail-list">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Section({
  id,
  title,
  meta,
  aside,
  children,
}: {
  id: string;
  title: string;
  meta?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="data-section" aria-labelledby={id}>
      <div className="table-heading">
        <div>
          <h2 id={id}>{title}</h2>
          {meta && <span className="muted">{meta}</span>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** 1-based page number kept in the URL (?page=), so pages can be linked and reloaded. */
export function usePageParam(name = "page"): [number, (page: number) => void] {
  const [params, setParams] = useSearchParams();
  const raw = Number(params.get(name));
  const page = Number.isSafeInteger(raw) && raw >= 1 ? raw : 1;
  return [
    page,
    (next) =>
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (next <= 1) p.delete(name);
          else p.set(name, String(next));
          return p;
        },
        { replace: false },
      ),
  ];
}

export function Pager({
  page,
  totalPages,
  onChange,
  label,
}: {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
  label: string;
}) {
  const { t } = useTranslation("explorer");
  if (totalPages <= 1) return null;
  return (
    <nav className="pager" aria-label={t("pager.aria", { label })}>
      <Button
        variant="outline small"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        <ArrowLeft size={14} /> {t("pager.newer")}
      </Button>
      <span className="mono muted">
        {t("pager.page", { page: fmtInt(page), total: fmtInt(totalPages) })}
      </span>
      <Button
        variant="outline small"
        disabled={page >= totalPages}
        onClick={() => onChange(page + 1)}
      >
        {t("pager.older")} <ArrowRight size={14} />
      </Button>
    </nav>
  );
}

/**
 * Media safety: only https or inline raster images are ever loaded, without a referrer and
 * lazily. Anything else (HTML, SVG documents, audio/video, frames) is never fetched; a
 * monogram is shown instead.
 */
export function SafeImage({
  src,
  alt,
  fallback,
  className = "",
}: {
  src: unknown;
  alt: string;
  fallback: string;
  className?: string;
}) {
  const safe = safeImageUrl(src);
  const [failed, setFailed] = useState(false);
  if (!safe || failed)
    return (
      <span
        className={`media-fallback ${className}`}
        aria-hidden={alt ? undefined : true}
        role={alt ? "img" : undefined}
        aria-label={alt || undefined}
      >
        {fallback.slice(0, 4).toUpperCase()}
      </span>
    );
  return (
    <img
      className={className}
      src={safe}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * Logos that ship with the site, by upper-case symbol: the native token and the bridged majors,
 * which carry no on-chain metadata image (also used for their Base-side ETH / USDC / XRGE).
 */
const BUILTIN_TOKEN_LOGOS: Record<string, string> = {
  XRGE: "/xrge-logo.webp",
  QETH: "/tokens/qeth.webp",
  ETH: "/tokens/qeth.webp",
  QUSDC: "/tokens/qusdc.webp",
  USDC: "/tokens/qusdc.webp",
};

/** Token avatar: a built-in logo, a ₿ mark for qBTC, else the metadata image (or monogram). */
export function TokenLogo({ symbol, image, className = "" }: { symbol: string; image?: unknown; className?: string }) {
  const upper = (symbol ?? "").toUpperCase();
  const builtin = BUILTIN_TOKEN_LOGOS[upper];
  if (builtin) return <img className={className} src={builtin} alt="" decoding="async" />;
  if (upper === "QBTC" || upper === "BTC")
    return (
      <svg className={className} viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="50" fill="#F7931A" />
        <text x="50" y="71" fontSize="62" fontWeight="700" fill="#fff" textAnchor="middle" fontFamily="system-ui, sans-serif">
          ₿
        </text>
      </svg>
    );
  return <SafeImage src={image} alt="" fallback={symbol} className={className} />;
}

export function NotFoundState({
  title,
  children,
  back,
}: {
  title: string;
  children: ReactNode;
  back: { to: string; label: string };
}) {
  return (
    <div className="empty-state not-found">
      <h3>{title}</h3>
      <p>{children}</p>
      <Link className="button outline small" to={back.to}>
        {back.label}
      </Link>
    </div>
  );
}

export function ExplorerMain({ children }: { children: ReactNode }) {
  return (
    <main id="main" className="app-main explorer-main">
      <div className="container">{children}</div>
    </main>
  );
}
