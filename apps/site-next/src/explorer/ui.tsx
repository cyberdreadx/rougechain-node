import { useState, type FormEvent, type ReactNode } from "react";
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

export function age(timestamp: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** Shortened identifier with a copy button; exposes the full value if the clipboard is denied. */
export function CopyHash({
  hash,
  label = "hash",
  display,
}: {
  hash: string;
  label?: string;
  display?: ReactNode;
}) {
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
        aria-label={`Copy ${label} ${hash}`}
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
          ? `${label[0].toUpperCase()}${label.slice(1)} copied`
          : failed
            ? `Clipboard unavailable. Select the full ${label} below.`
            : ""}
      </span>
      {failed && <code className="copy-fallback">{hash}</code>}
    </div>
  );
}

const STATE_LABEL: Record<ReadState, string> = {
  live: "Live",
  stale: "Stale",
  loading: "Loading",
  unavailable: "Unavailable",
  "not-found": "Not found",
};

export function ReadStatus({ read }: { read: Pick<Read<unknown>, "state"> }) {
  const state = read.state === "not-found" ? "unavailable" : read.state;
  return <Status state={state}>{STATE_LABEL[read.state]}</Status>;
}

/** Provenance line: where the data came from and how fresh it is. */
export function SourceNote({
  read,
  what,
}: {
  read: Read<unknown>;
  what: string;
}) {
  const { config } = useChain();
  const when = read.updatedAt
    ? new Date(read.updatedAt).toLocaleTimeString()
    : null;
  return (
    <div className="data-note explorer-source" role="status">
      <ReadStatus read={read} />
      <span>
        {read.state === "live" &&
          `${what} read from the ${config.label} API at ${when}.`}
        {read.state === "stale" &&
          `Stale: showing the last successful read (${when}). The latest refresh ${read.error ? "failed" : "is overdue"}.`}
        {read.state === "loading" &&
          `Reading ${what.toLowerCase()} from the ${config.label} API…`}
        {read.state === "unavailable" &&
          `${what} unavailable: the ${config.label} API could not be read.`}
        {read.state === "not-found" &&
          `The ${config.label} node has no record of this.`}
      </span>
      {read.state !== "loading" && read.state !== "not-found" && (
        <Button
          variant="ghost icon copy-button"
          aria-label={`Refresh ${what.toLowerCase()}`}
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
  if (read.data !== undefined) return <>{children(read.data)}</>;
  if (read.state === "not-found")
    return (
      <>
        {notFound ?? (
          <EmptyState title={`${what} not found`}>
            The node has no record of this.
          </EmptyState>
        )}
      </>
    );
  if (read.state === "unavailable")
    return (
      <EmptyState title={`${what} unavailable`}>
        The public API could not be read. Nothing is shown rather than guessing.{" "}
        <button className="inline-link" onClick={read.refetch}>
          Try again
        </button>
      </EmptyState>
    );
  return (
    <EmptyState title={`Loading ${what.toLowerCase()}`}>
      Reading the public API…
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
  const { network, config, locked, setNetwork } = useChain();
  if (locked) return <span className="pill">{config.label}</span>;
  return (
    <div className="mode-switch" role="group" aria-label="Network">
      {(["mainnet", "testnet"] as const).map((id) => (
        <Button
          key={id}
          variant={network === id ? "secondary small" : "ghost small"}
          aria-pressed={network === id}
          onClick={() => setNetwork(id)}
        >
          {id === "mainnet" ? "Mainnet" : "Testnet"}
        </Button>
      ))}
    </div>
  );
}

export function ExplorerSearch({ autoFocus = false }: { autoFocus?: boolean }) {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [miss, setMiss] = useState(false);
  const tokens = useRead(["tokens"], (c) => c.tokens(), { refetchMs: 300_000 });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const target = resolveSearch(
      value,
      tokens.data?.map((t) => t.symbol),
    );
    setMiss(!target);
    if (target) navigate(target.path);
  };
  return (
    <form role="search" onSubmit={submit} className="explorer-search-form">
      <div className="explorer-search">
        <Search size={18} />
        <label className="sr-only" htmlFor="explorer-search">
          Search by block height, transaction or block hash, address, contract
          or token
        </label>
        <input
          id="explorer-search"
          autoFocus={autoFocus}
          placeholder="Block height, tx / block hash, rouge1 address, public key, contract, token"
          value={value}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setValue(e.target.value);
            setMiss(false);
          }}
        />
        <Button variant="secondary small" type="submit">
          Search
        </Button>
      </div>
      {miss && (
        <p className="search-hint" role="alert">
          Nothing matches that. Try a block height, a 64-character hash, a
          rouge1 address, a 40-character contract address or a token symbol.
        </p>
      )}
    </form>
  );
}

export function Age({ ts }: { ts: number }) {
  const date = new Date(ts);
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()}>
      {age(ts)}
    </time>
  );
}

export function Timestamp({ ts }: { ts: number }) {
  const date = new Date(ts);
  return (
    <span>
      <time dateTime={date.toISOString()}>{date.toLocaleString()}</time>{" "}
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
  if (!identity) return <span className="muted">—</span>;
  if (identity === "genesis") return <span className="muted">Genesis</span>;
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
  return (
    <Link className="address-link" to={`/block/${height}`}>
      #{height.toLocaleString()}
    </Link>
  );
}

export function TypePill({ type }: { type: string }) {
  return (
    <span className={`pill type-${type.replace(/[^a-z_]/g, "")}`}>
      {txTypeLabel(type)}
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
  if (totalPages <= 1) return null;
  return (
    <nav className="pager" aria-label={`${label} pages`}>
      <Button
        variant="outline small"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        <ArrowLeft size={14} /> Newer
      </Button>
      <span className="mono muted">
        Page {page.toLocaleString()} of {totalPages.toLocaleString()}
      </span>
      <Button
        variant="outline small"
        disabled={page >= totalPages}
        onClick={() => onChange(page + 1)}
      >
        Older <ArrowRight size={14} />
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
