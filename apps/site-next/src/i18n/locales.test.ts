/**
 * Keeps the locales complete: every English key exists in es / zh / ja, every value is a
 * non-empty string, and interpolation placeholders ({{var}}) and <Trans> tags match English.
 * Plurals: i18next suffixes (_zero/_one/_two/_few/_many/_other) are grouped by base key; each
 * language needs `_other` plus the categories it actually uses for `_one` (es: _one; zh/ja: none).
 */
import { describe, expect, it } from "vitest";
import { NAMESPACES } from "./index";

const files = import.meta.glob<{ default: Record<string, unknown> }>("./locales/*/*.json", { eager: true });
const LANGS = ["en", "es", "zh", "ja"] as const;
const PLURAL = /_(zero|one|two|few|many|other)$/;

function flatten(obj: unknown, prefix = "", out: Record<string, unknown> = {}) {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else out[prefix] = obj;
  return out;
}

function load(lang: string, ns: string) {
  const mod = files[`./locales/${lang}/${ns}.json`];
  return mod ? flatten(mod.default) : null;
}

const placeholders = (s: string) => [...new Set(s.match(/\{\{\s*[\w.]+(?:\s*,[^}]*)?\s*\}\}/g)?.map((m) => m.replace(/\s|,.*(?=\}\})/g, "")) ?? [])].sort();
const tags = (s: string) => [...(s.match(/<\/?[\w]+\s*\/?>/g) ?? [])].sort();

describe("locales", () => {
  it("has a file for every namespace in every language, and nothing else", () => {
    for (const lang of LANGS) for (const ns of NAMESPACES) expect(load(lang, ns), `${lang}/${ns}.json`).not.toBeNull();
    for (const path of Object.keys(files)) {
      const [, lang, ns] = /\.\/locales\/([^/]+)\/([^/]+)\.json$/.exec(path)!;
      expect(LANGS as readonly string[], path).toContain(lang);
      expect(NAMESPACES as readonly string[], path).toContain(ns);
    }
  });

  for (const ns of NAMESPACES) {
    const en = load("en", ns) ?? {};
    const enBases = new Map<string, string[]>();
    for (const key of Object.keys(en)) {
      const base = key.replace(PLURAL, "");
      enBases.set(base, [...(enBases.get(base) ?? []), key]);
    }

    for (const lang of ["es", "zh", "ja"] as const) {
      it(`${lang}/${ns}: same keys as en, non-empty, matching placeholders`, () => {
        const tr = load(lang, ns) ?? {};
        const missing: string[] = [];
        const problems: string[] = [];
        for (const [base, enKeys] of enBases) {
          const plural = enKeys.some((k) => PLURAL.test(k));
          const required = plural ? [`${base}_other`, ...(lang === "es" ? [`${base}_one`] : [])] : [base];
          const enRef = String(en[plural ? `${base}_other` : base] ?? "");
          for (const key of required) {
            const v = tr[key];
            if (v === undefined) {
              missing.push(key);
              continue;
            }
            if (typeof v !== "string" || !v.trim()) {
              problems.push(`${key}: empty or not a string`);
              continue;
            }
            // _one forms may drop {{count}} ("un token"); every other form keeps the same variables.
            const pa = placeholders(v).filter((p) => !(key.endsWith("_one") && p === "{{count}}"));
            const pe = placeholders(enRef).filter((p) => !(key.endsWith("_one") && p === "{{count}}"));
            if (pa.join() !== pe.join()) problems.push(`${key}: placeholders ${pa.join(" ")} ≠ en ${pe.join(" ")}`);
            if (tags(v).join() !== tags(enRef).join()) problems.push(`${key}: tags ${tags(v).join(" ")} ≠ en ${tags(enRef).join(" ")}`);
          }
        }
        // No stray keys that English doesn't have (stale translations).
        const extra = Object.keys(tr).filter((k) => !enBases.has(k.replace(PLURAL, "")));
        expect(missing, `missing in ${lang}/${ns}`).toEqual([]);
        expect(problems, `problems in ${lang}/${ns}`).toEqual([]);
        expect(extra, `keys in ${lang}/${ns} that en doesn't have`).toEqual([]);
      });
    }

    it(`en/${ns}: values are non-empty strings`, () => {
      const bad = Object.entries(en).filter(([, v]) => typeof v !== "string" || !v.trim());
      expect(bad.map(([k]) => k)).toEqual([]);
    });
  }
});
