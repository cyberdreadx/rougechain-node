/** Shared Swap / Pools UI pieces in Anders' design language (site-next tokens + classes). */
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronDown, Search, Star } from "lucide-react";
import { Button, Dialog } from "@rougechain/ui";
import { TokenIcon, UnlockForm } from "../wallet/parts";
import type { SignState } from "./hooks";
import { fmtAmount } from "./amounts";
import { fmtNum } from "../i18n/format";
import { SLIPPAGE_MAX, SLIPPAGE_MIN, SLIPPAGE_PRESETS } from "./amm";

export { TokenIcon };

/** Two overlapping token marks for a pair. */
export function PairIcons({ a, b, image }: { a: string; b: string; image: (s: string) => string | null }) {
  return (
    <span className="dex-pair-icons" aria-hidden="true">
      <TokenIcon symbol={a} image={image(a)} />
      <TokenIcon symbol={b} image={image(b)} />
    </span>
  );
}

/**
 * What to show instead of a "sign" action when the wallet can't sign yet: connect (none),
 * unlock (locked), or explain (an extension wallet without the extension present).
 */
export function SignGate({ sign, compact }: { sign: SignState; compact?: boolean }) {
  const { t } = useTranslation("swap");
  if (sign.state === "ready") return null;
  if (sign.state === "none")
    return (
      <div className={`dex-gate${compact ? " compact" : ""}`}>
        <strong>{t("gate.noneTitle")}</strong>
        <p>{t("gate.noneBody")}</p>
        <Link className="button review-button" to="/wallet">
          {t("gate.openWallet")}
        </Link>
      </div>
    );
  if (sign.state === "locked")
    return (
      <div className={`dex-gate${compact ? " compact" : ""}`}>
        <strong>{t("gate.lockedTitle")}</strong>
        <p>{t("gate.lockedBody")}</p>
        <UnlockForm />
      </div>
    );
  return (
    <p className="quote-alert" role="alert">
      {t("gate.noSigner")}
    </p>
  );
}

export function SignNote({ kind }: { kind: "local" | "extension" }) {
  const { t } = useTranslation("swap");
  return <p className="form-hint">{kind === "extension" ? t("common.signedByExtension") : t("common.signedLocally")}</p>;
}

/** Tokens always offered without searching (apps/web MAJOR_TOKENS). */
export const MAJOR_TOKENS = ["XRGE", "qETH"] as const;

/** apps/web TokenPicker list order: no query → majors + held (+ selected), XRGE first then by balance. */
export function pickerList(opts: {
  query: string;
  selected: string;
  balances: Record<string, number>;
  poolTokens: string[];
}): string[] {
  const { selected, balances, poolTokens } = opts;
  const q = opts.query.trim().toUpperCase();
  const bal = (s: string) => balances[s] ?? 0;
  if (!q) {
    const visible = new Set<string>(MAJOR_TOKENS);
    for (const [s, b] of Object.entries(balances)) if (b > 0) visible.add(s);
    if (selected) visible.add(selected);
    return [...visible].sort((a, b) => (a === "XRGE" ? -1 : b === "XRGE" ? 1 : bal(b) - bal(a)));
  }
  const all = new Set([...poolTokens, ...Object.keys(balances)]);
  return [...all]
    .filter((s) => s.toUpperCase().includes(q))
    .sort((a, b) => {
      const A = a.toUpperCase();
      const B = b.toUpperCase();
      if (A === q) return -1;
      if (B === q) return 1;
      const sa = A.startsWith(q);
      const sb = B.startsWith(q);
      if (sa !== sb) return sa ? -1 : 1;
      return bal(b) - bal(a);
    });
}

export function TokenPicker({
  label,
  selected,
  balances,
  poolTokens,
  image,
  onSelect,
}: {
  label: string;
  selected: string;
  balances: Record<string, number>;
  poolTokens: string[];
  image: (s: string) => string | null;
  onSelect: (symbol: string) => void;
}) {
  const { t } = useTranslation("swap");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const list = useMemo(() => pickerList({ query, selected, balances, poolTokens }), [query, selected, balances, poolTokens]);
  const close = () => {
    setOpen(false);
    setQuery("");
  };
  return (
    <>
      <button
        type="button"
        className="token-selector dex-token-button"
        aria-label={selected ? `${label}: ${selected}` : label}
        onClick={() => {
          setOpen(true);
          window.setTimeout(() => input.current?.focus(), 50);
        }}
      >
        {selected ? <TokenIcon symbol={selected} image={image(selected)} /> : null}
        <span>{selected || t("swap.selectToken")}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open && (
      <Dialog open onClose={close} title={t("picker.title")}>
        <label className="field dex-picker-search">
          <span className="sr-only">{t("picker.search")}</span>
          <span className="dex-search">
            <Search size={15} aria-hidden="true" />
            <input
              ref={input}
              className="input"
              value={query}
              placeholder={t("picker.search")}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </span>
        </label>
        {!query && (
          <div className="chip-row dex-majors">
            {MAJOR_TOKENS.map((s) => (
              <button
                type="button"
                key={s}
                className={`chip${selected === s ? " active" : ""}`}
                onClick={() => {
                  onSelect(s);
                  close();
                }}
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <ul className="dex-token-list" aria-label={t("picker.title")}>
          {list.length === 0 ? (
            <li className="muted">{query ? t("picker.noMatch", { query }) : t("picker.none")}</li>
          ) : (
            list.map((s) => (
              <li key={s}>
                <button
                  type="button"
                  aria-current={selected === s ? "true" : undefined}
                  onClick={() => {
                    onSelect(s);
                    close();
                  }}
                >
                  <TokenIcon symbol={s} image={image(s)} />
                  <span className="dex-token-name">
                    <strong>
                      {s} {(MAJOR_TOKENS as readonly string[]).includes(s) && <Star size={11} aria-hidden="true" />}
                    </strong>
                    {(balances[s] ?? 0) > 0 && <small>{t("swap.balance", { balance: fmtAmount(balances[s], s) })}</small>}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      </Dialog>
      )}
    </>
  );
}

export function SlippageControl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const { t } = useTranslation("swap");
  const [custom, setCustom] = useState("");
  return (
    <div className="quote-settings">
      <div className="field">
        {t("swap.slippage")}
        <div className="chip-row" role="group" aria-label={t("swap.slippage")}>
          {SLIPPAGE_PRESETS.map((v) => (
            <button
              type="button"
              key={v}
              className={`chip${value === v ? " active" : ""}`}
              aria-pressed={value === v}
              onClick={() => {
                setCustom("");
                onChange(v);
              }}
            >
              {fmtNum(v)}%
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        {t("swap.slippageCustom")}
        <input
          className="input mono"
          inputMode="decimal"
          value={custom}
          placeholder={String(value)}
          onChange={(e) => {
            const text = e.target.value.replace(",", ".");
            setCustom(text);
            const n = Number(text);
            if (text && Number.isFinite(n)) onChange(Math.min(SLIPPAGE_MAX, Math.max(SLIPPAGE_MIN, n)));
          }}
        />
      </label>
    </div>
  );
}

export function DetailRows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="quote-details">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ErrorLine({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p className="form-error" role="alert">
      {children}
    </p>
  );
}

export { Button };
