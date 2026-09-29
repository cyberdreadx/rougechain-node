/** Small shared wallet UI pieces, in the site-next design system's classes. */
import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@rougechain/ui";
import { SafeImage } from "../explorer/ui";
import { useWallet } from "./WalletProvider";
import { toast } from "./toast";

export function CopyText({ value, label, display }: { value: string; label: string; display?: ReactNode }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <div className="copy-text">
      <code className="mono" title={value}>
        {display ?? value}
      </code>
      <Button
        variant="ghost icon copy-button"
        aria-label={`Copy ${label}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setState("copied");
            window.setTimeout(() => setState("idle"), 1800);
          } catch {
            setState("failed");
          }
        }}
      >
        {state === "copied" ? <Check size={14} /> : <Copy size={14} />}
      </Button>
      <span className="sr-only" role="status">
        {state === "copied" ? `${label[0].toUpperCase()}${label.slice(1)} copied` : state === "failed" ? "Clipboard unavailable — select the text" : ""}
      </span>
    </div>
  );
}

/** Password unlock through core's unlockUnifiedWallet (via the provider). */
export function UnlockForm({ onUnlocked }: { onUnlocked?: () => void }) {
  const { unlock } = useWallet();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="wallet-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!password) return setError("Enter your password");
        setBusy(true);
        setError("");
        try {
          await unlock(password);
          setPassword("");
          toast.success("Wallet unlocked");
          onUnlocked?.();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Unlock failed");
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="field">
        Password
        <input
          className="input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? "Unlocking…" : "Unlock"}
      </Button>
    </form>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`toggle ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

export function SettingRow({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div>
        <strong>{title}</strong>
        {hint && <small>{hint}</small>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

export function TokenIcon({ symbol, image, large }: { symbol: string; image?: string | null; large?: boolean }) {
  const cls = `token-mark${large ? " large" : ""}`;
  // The native token's logo ships with the site; other logos come from token metadata (https / data: only).
  if (symbol === "XRGE") return <img className={cls} src="/xrge-logo.webp" alt="" />;
  return <SafeImage src={image} alt="" fallback={symbol} className={cls} />;
}
