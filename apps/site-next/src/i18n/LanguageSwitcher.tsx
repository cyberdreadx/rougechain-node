import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Languages } from "lucide-react";
import { SUPPORTED_LANGUAGES, currentLanguage, setLanguage } from "./index";
import "./i18n.css";

/** Compact language menu (footer), as apps/web's LanguageSwitcher: icon + short code, opens upward. */
export function LanguageSwitcher({ direction = "up" }: { direction?: "up" | "down" }) {
  const { t } = useTranslation("common");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const code = currentLanguage();
  const current = SUPPORTED_LANGUAGES.find((l) => l.code === code) ?? SUPPORTED_LANGUAGES[0];

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
    <div ref={ref} className="lang-switch">
      <button
        type="button"
        className="lang-switch-button"
        onClick={() => setOpen((o) => !o)}
        aria-label={t("language.label")}
        title={t("language.label")}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Languages size={14} aria-hidden="true" />
        <span lang={current.code}>{current.short}</span>
      </button>
      {open && (
        <ul role="listbox" aria-label={t("language.label")} className={`lang-switch-menu ${direction}`}>
          {SUPPORTED_LANGUAGES.map((l) => (
            <li key={l.code}>
              <button
                type="button"
                role="option"
                aria-selected={l.code === current.code}
                lang={l.code}
                onClick={() => {
                  void setLanguage(l.code);
                  setOpen(false);
                }}
              >
                {l.label}
                {l.code === current.code && <Check size={13} aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Segmented EN / ES / 中文 / 日本語 selector (Settings). */
export function LanguageSelect() {
  const { t } = useTranslation("common");
  const code = currentLanguage();
  return (
    <div className="lang-select" role="radiogroup" aria-label={t("language.label")}>
      {SUPPORTED_LANGUAGES.map((l) => (
        <button
          key={l.code}
          type="button"
          role="radio"
          lang={l.code}
          aria-checked={l.code === code}
          title={l.label}
          className={`button small ${l.code === code ? "secondary" : "ghost"}`}
          onClick={() => void setLanguage(l.code)}
        >
          {l.short}
        </button>
      ))}
    </div>
  );
}
