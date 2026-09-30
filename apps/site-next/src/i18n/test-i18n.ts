import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { NAMESPACES, baseOptions, type LanguageCode } from "./index";

/**
 * Tests: every locale bundled synchronously (import.meta.glob eager), English by default, no
 * detection, no Suspense waits.
 */
export function initTestI18n(lng: LanguageCode = "en") {
  const files = import.meta.glob<{ default: Record<string, unknown> }>("./locales/*/*.json", { eager: true });
  const resources: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const [path, mod] of Object.entries(files)) {
    const [, lang, ns] = /\.\/locales\/([^/]+)\/([^/]+)\.json$/.exec(path)!;
    (resources[lang] ??= {})[ns] = mod.default;
  }
  if (i18n.isInitialized) return i18n.changeLanguage(lng);
  return i18n.use(initReactI18next).init({
    ...baseOptions(),
    ns: [...NAMESPACES],
    lng,
    resources,
    initAsync: false,
  });
}

export default i18n;
