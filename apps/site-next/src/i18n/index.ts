/**
 * site-next i18n (i18next + react-i18next), compatible with apps/web's src/i18n:
 *  - same languages (en / es / zh / ja) and the SAME localStorage key, `rougechain-lang`, with the
 *    same detection order (localStorage, then the browser's navigator languages), so a language
 *    chosen on the previous site carries over;
 *  - locale data is split into namespaces (src/i18n/locales/<lng>/<ns>.json) and loaded lazily,
 *    one small chunk per language + namespace (nothing of it sits in the entry chunk).
 *
 * Components: `const { t } = useTranslation("wallet")`. Non-React code (validators, toasts):
 * `i18n.t("bridge:errors.amount")` at call time, never at module load.
 */
import i18n, { type BackendModule, type ReadCallback } from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

export const SUPPORTED_LANGUAGES = [
  { code: "en", label: "English", short: "EN" },
  { code: "es", label: "Español", short: "ES" },
  { code: "zh", label: "中文", short: "中文" },
  { code: "ja", label: "日本語", short: "日本語" },
] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]["code"];

/** apps/web's key (i18next-browser-languagedetector `lookupLocalStorage`). Do not change. */
export const LANGUAGE_STORAGE_KEY = "rougechain-lang";

export const NAMESPACES = ["common", "wallet", "explorer", "swap", "bridge", "messenger", "pages", "marketing"] as const;
export type Namespace = (typeof NAMESPACES)[number];

/** One lazy chunk per locale file. */
const loaders = import.meta.glob<{ default: Record<string, unknown> }>("./locales/*/*.json");

const lazyBackend: BackendModule = {
  type: "backend",
  init() {},
  read(language: string, namespace: string, callback: ReadCallback) {
    const load = loaders[`./locales/${language}/${namespace}.json`];
    if (!load) {
      callback(null, {});
      return;
    }
    load().then(
      (m) => callback(null, m.default),
      (err: unknown) => callback(err instanceof Error ? err : new Error(String(err)), false),
    );
  },
};

/** The base language code in use ("en" | "es" | "zh" | "ja"). */
export function currentLanguage(): LanguageCode {
  const code = (i18n.resolvedLanguage || i18n.language || "en").slice(0, 2);
  return (SUPPORTED_LANGUAGES.some((l) => l.code === code) ? code : "en") as LanguageCode;
}

/** BCP 47 tag for Intl formatting of the current language. */
export function currentLocale(): string {
  return { en: "en-US", es: "es-ES", zh: "zh-CN", ja: "ja-JP" }[currentLanguage()];
}

type HeadOptions = { explorer: boolean; testnet: boolean };
let headOptions: HeadOptions = { explorer: false, testnet: false };

/**
 * <html lang>, and the default <title> / meta description in the current language. Per-route
 * titles (useRouteSeo) set their own on top; the OG/Twitter tags stay as prerendered (English).
 */
export function applyDocumentLanguage() {
  if (typeof document === "undefined") return;
  document.documentElement.lang = currentLanguage();
  const { explorer, testnet } = headOptions;
  const base = i18n.t(explorer ? "common:meta.explorerTitle" : "common:meta.title");
  const description = i18n.t(explorer ? "common:meta.explorerDescription" : "common:meta.description");
  if (!base || base.startsWith("meta.")) return;
  document.title = testnet ? base.replace(/^RougeChain/, "RougeChain Testnet") : base;
  document.querySelector('meta[name="description"]')?.setAttribute("content", description);
}

export function baseOptions() {
  return {
    fallbackLng: "en",
    supportedLngs: SUPPORTED_LANGUAGES.map((l) => l.code),
    nonExplicitSupportedLngs: true, // es-MX, zh-CN, zh-TW, ja-JP … → base code (as apps/web)
    load: "languageOnly" as const, // only fetch locales/<base>/…, never locales/es-MX/…
    ns: ["common"],
    defaultNS: "common",
    fallbackNS: false as const,
    interpolation: { escapeValue: false }, // React already escapes
    returnNull: false,
    react: { useSuspense: true },
  };
}

let started: Promise<unknown> | null = null;

/**
 * Browser init: detect (localStorage `rougechain-lang`, then navigator), lazily load `preload`
 * namespaces for that language before first render, keep <html lang> and the title in sync.
 */
export function initI18n(preload: Namespace[], head: HeadOptions): Promise<unknown> {
  if (started) return started;
  headOptions = head;
  i18n.on("languageChanged", applyDocumentLanguage);
  i18n.on("loaded", applyDocumentLanguage);
  started = i18n
    .use(lazyBackend)
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      ...baseOptions(),
      ns: ["common", ...preload.filter((n) => n !== "common")],
      detection: {
        order: ["localStorage", "navigator"],
        lookupLocalStorage: LANGUAGE_STORAGE_KEY,
        caches: ["localStorage"],
      },
    })
    .then(applyDocumentLanguage);
  return started;
}

/** Switch language (persists to `rougechain-lang` through the detector cache, as apps/web). */
export function setLanguage(code: LanguageCode) {
  return i18n.changeLanguage(code);
}

export default i18n;
