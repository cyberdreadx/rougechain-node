import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Languages } from "lucide-react";
import { SUPPORTED_LANGUAGES } from "@/i18n";
import { cn } from "@/lib/utils";

interface LanguageSwitcherProps {
  /** Compact: icon + short code only (sidebar collapsed / mobile header). */
  compact?: boolean;
  className?: string;
}

export function LanguageSwitcher({ compact = false, className }: LanguageSwitcherProps) {
  const { i18n, t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const currentCode = (i18n.resolvedLanguage || i18n.language || "en").slice(0, 2);
  const current = SUPPORTED_LANGUAGES.find((l) => l.code === currentCode) ?? SUPPORTED_LANGUAGES[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={t("common.language")}
        aria-label={t("common.language")}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg text-[13px] font-medium transition-colors text-muted-foreground hover:text-foreground hover:bg-muted",
          compact ? "px-2 py-1" : "px-3 py-1"
        )}
      >
        <Languages className="w-4 h-4 flex-shrink-0" />
        <span className="whitespace-nowrap">{compact ? current.short : current.label}</span>
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label={t("common.language")}
          className="absolute bottom-full left-0 z-50 mb-1 min-w-[9rem] rounded-lg border border-border bg-card p-1 shadow-lg"
        >
          {SUPPORTED_LANGUAGES.map((l) => (
            <li key={l.code}>
              <button
                type="button"
                role="option"
                aria-selected={l.code === current.code}
                lang={l.code}
                onClick={() => {
                  void i18n.changeLanguage(l.code);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-[13px] hover:bg-muted",
                  l.code === current.code ? "text-foreground" : "text-muted-foreground"
                )}
              >
                {l.label}
                {l.code === current.code && <Check className="w-3.5 h-3.5" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
