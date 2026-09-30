import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@rougechain/ui";
import { useChain } from "../explorer/chain";
import { PageHeading } from "../explorer/ui";
import { common } from "./strings";
import "./pages.css";

/** Per-route title/description (SPA-safe: restored on unmount), as apps/web's useRouteSeo. */
export function useRouteSeo({ title, description }: { title: string; description: string }) {
  useEffect(() => {
    const prevTitle = document.title;
    const meta = document.querySelector('meta[name="description"]');
    const prevDesc = meta?.getAttribute("content") ?? null;
    document.title = title;
    meta?.setAttribute("content", description);
    return () => {
      document.title = prevTitle;
      if (meta && prevDesc !== null) meta.setAttribute("content", prevDesc);
    };
  }, [title, description]);
}

/** App-style page frame: heading (with the network badge) + container. */
export function PageFrame({
  eyebrow,
  title,
  lead,
  aside,
  className = "",
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  lead?: ReactNode;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <main id="main" className={`app-main rc-page ${className}`}>
      <div className="container">
        <PageHeading eyebrow={eyebrow} title={title} aside={aside}>
          {lead}
        </PageHeading>
        {children}
      </div>
    </main>
  );
}

/** Testnet banner (nothing on mainnet). */
export function TestnetNotice({ children }: { children: ReactNode }) {
  const { network } = useChain();
  if (network !== "testnet") return null;
  return (
    <p className="notice warning rc-testnet" role="note">
      {children}
    </p>
  );
}

/** A command / config block with a copy button; the text stays selectable if the clipboard fails. */
export function CopyCode({ text, label = "command" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rc-code">
      <pre>
        <code>{text}</code>
      </pre>
      <Button
        variant="ghost icon small"
        aria-label={`${common.copy} ${label}`}
        onClick={() => {
          navigator.clipboard
            ?.writeText(text)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            })
            .catch(() => {});
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </Button>
    </div>
  );
}

export function StatTile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rc-stat">
      <div className="metric-label">{label}</div>
      <div className="rc-stat-value">{value}</div>
      {sub != null && <div className="rc-stat-sub">{sub}</div>}
    </div>
  );
}

/** 0–100 bar. */
export function Bar({ value, label }: { value: number; label: string }) {
  const v = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <div className="rc-bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v)}>
      <span style={{ width: `${v}%` }} />
    </div>
  );
}

export function short(s: string | null | undefined, head = 12, tail = 0): string {
  if (!s) return "—";
  if (s.length <= head + tail + 1) return s;
  return tail ? `${s.slice(0, head)}…${s.slice(-tail)}` : `${s.slice(0, head)}…`;
}
