import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";
import { SUPPORTED_LANGUAGES } from "@/i18n";
import { cn } from "@/lib/utils";

interface LanguageSwitcherProps {
  /** Compact: icon + short code only (sidebar collapsed / mobile header). */
  compact?: boolean;
  className?: string;
}

export function LanguageSwitcher({ compact = false, className }: LanguageSwitcherProps) {
  const { i18n, t } = useTranslation();
  const current = (i18n.resolvedLanguage || i18n.language || "en").slice(0, 2);
  const next = SUPPORTED_LANGUAGES.find((l) => l.code !== current) ?? SUPPORTED_LANGUAGES[0];

  return (
    <button
      type="button"
      onClick={() => void i18n.changeLanguage(next.code)}
      title={t("common.switchLanguage", { language: next.label })}
      aria-label={t("common.switchLanguage", { language: next.label })}
      className={cn(
        "flex items-center gap-2 rounded-lg text-[13px] font-medium transition-colors text-muted-foreground hover:text-foreground hover:bg-muted",
        compact ? "px-2 py-1" : "px-3 py-1",
        className
      )}
    >
      <Languages className="w-4 h-4 flex-shrink-0" />
      <span className="whitespace-nowrap">{compact ? next.short : next.label}</span>
    </button>
  );
}
