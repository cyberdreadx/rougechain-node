/**
 * Launch prep: public assets, service-worker retirement, SEO head, sitemap. These guard the
 * rougechain.io switch from apps/web to site-next (see apps/site-next/LAUNCH_CHECKLIST.md).
 */
import { describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import type { ReactElement } from "react";
import { applySiteHead, siteHead } from "./site-head";
import { featureRoutes } from "../features";
import { explorerRoutes } from "../explorer/routes";
// @ts-expect-error plain .mjs build script (no types)
import { EXPLORER_ROUTES, ROUTES, shellFile } from "../../scripts/og-routes.mjs";

const here = __dirname;
const siteNext = path.resolve(here, "../..");
const web = path.resolve(siteNext, "../web");

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full, base) : [path.relative(base, full)];
  });
}

/** apps/web/public files site-next deliberately does NOT ship byte-identical, with the reason. */
const REPLACED: Record<string, string> = {
  "sw.js": "replaced by a kill-switch worker that retires apps/web's cache (tested below)",
  "sitemap.xml": "regenerated for site-next routes (tested below)",
  "manifest.json": "same file, brand theme/background colours",
  "_redirects": "same SPA rule, with comments",
};

describe("public/ parity with apps/web", () => {
  const webFiles = walk(path.join(web, "public"));
  it("serves every apps/web public file (or allow-lists it with a reason)", () => {
    expect(webFiles.length).toBeGreaterThan(20);
    const missing = webFiles.filter((f) => !existsSync(path.join(siteNext, "public", f)));
    expect(missing).toEqual([]);
  });
  it("copies byte-identical except the allow-listed replacements", () => {
    const differ = webFiles.filter(
      (f) => !readFileSync(path.join(web, "public", f)).equals(readFileSync(path.join(siteNext, "public", f))),
    );
    expect(differ.sort()).toEqual(Object.keys(REPLACED).sort());
  });
  it("keeps the manifest's names and icons", () => {
    const a = JSON.parse(readFileSync(path.join(web, "public/manifest.json"), "utf8"));
    const b = JSON.parse(readFileSync(path.join(siteNext, "public/manifest.json"), "utf8"));
    expect(b.name).toBe(a.name);
    expect(b.short_name).toBe(a.short_name);
    expect(b.icons).toEqual(a.icons);
    for (const i of b.icons) expect(existsSync(path.join(siteNext, "public", i.src))).toBe(true);
  });
  it("keeps the SPA rewrite non-forced so prerendered route shells win", () => {
    const rules = readFileSync(path.join(siteNext, "public/_redirects"), "utf8")
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("#"));
    expect(rules.map((l) => l.trim().split(/\s+/))).toEqual([["/*", "/index.html", "200"]]);
  });
});

type Listener = (event: { waitUntil(p: Promise<unknown>): void }) => void;

/** Runs a service-worker script in a fake ServiceWorkerGlobalScope. */
function loadWorker(file: string, cacheNames: string[]) {
  const listeners: Record<string, Listener[]> = {};
  const store = new Set(cacheNames);
  const self = {
    addEventListener: (type: string, fn: Listener) => (listeners[type] ??= []).push(fn),
    skipWaiting: vi.fn(async () => {}),
    registration: { unregister: vi.fn(async () => true) },
    clients: { claim: vi.fn(async () => {}), matchAll: vi.fn(async () => []) },
    location: { hostname: "rougechain.io" },
  };
  const caches = {
    keys: vi.fn(async () => [...store]),
    delete: vi.fn(async (n: string) => store.delete(n)),
    open: vi.fn(async () => ({ addAll: vi.fn(), put: vi.fn() })),
    match: vi.fn(async () => undefined),
  };
  const fetchFn = vi.fn();
  vm.runInNewContext(readFileSync(file, "utf8"), { self, caches, fetch: fetchFn, URL, Promise, console });
  const fire = async (type: string) => {
    const waits: Promise<unknown>[] = [];
    for (const fn of listeners[type] ?? []) fn({ waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  };
  return { self, caches, store, listeners, fire, fetchFn };
}

describe("service worker (/sw.js) retires apps/web's worker", () => {
  const file = path.join(siteNext, "public/sw.js");

  it("the old apps/web worker is the one we are replacing (cache rougechain-v3, fetch handler)", () => {
    const old = loadWorker(path.join(web, "public/sw.js"), []);
    expect(readFileSync(path.join(web, "public/sw.js"), "utf8")).toContain('"rougechain-v3"');
    expect(old.listeners.fetch?.length).toBe(1);
  });

  it("install: takes over immediately", async () => {
    const w = loadWorker(file, []);
    await w.fire("install");
    expect(w.self.skipWaiting).toHaveBeenCalled();
  });

  it("activate: deletes every cache (incl. rougechain-v3), then unregisters itself", async () => {
    const w = loadWorker(file, ["rougechain-v3", "rougechain-v2", "workbox-precache"]);
    await w.fire("activate");
    expect(w.store.size).toBe(0);
    expect(w.caches.delete).toHaveBeenCalledWith("rougechain-v3");
    expect(w.self.registration.unregister).toHaveBeenCalledTimes(1);
  });

  it("still unregisters if Cache Storage fails", async () => {
    const w = loadWorker(file, ["rougechain-v3"]);
    w.caches.keys.mockRejectedValueOnce(new Error("quota"));
    await expect(w.fire("activate")).rejects.toThrow("quota");
    expect(w.self.registration.unregister).toHaveBeenCalledTimes(1);
  });

  it("has no fetch handler (every request goes to the network) and never force-reloads tabs", () => {
    const w = loadWorker(file, []);
    expect(w.listeners.fetch).toBeUndefined();
    expect(readFileSync(file, "utf8")).not.toMatch(/\.navigate\(|location\.reload/);
  });

  it("site-next never registers a service worker", () => {
    const html = readFileSync(path.join(siteNext, "index.html"), "utf8");
    expect(html).not.toMatch(/serviceWorker/);
    const src = walk(path.join(siteNext, "src")).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts"));
    for (const f of src) expect(readFileSync(path.join(siteNext, "src", f), "utf8")).not.toMatch(/serviceWorker\.register/);
  });
});

describe("index.html head parity (SEO / OG / Twitter / structured data)", () => {
  const next = readFileSync(path.join(siteNext, "index.html"), "utf8");
  const old = readFileSync(path.join(web, "index.html"), "utf8");
  const tags = (html: string, re: RegExp) => [...html.matchAll(re)].map((m) => m[1]).sort();

  it("has every meta name/property and link rel apps/web has", () => {
    expect(tags(next, /<meta\s+name="([^"]+)"/g)).toEqual(expect.arrayContaining(tags(old, /<meta\s+name="([^"]+)"/g)));
    expect(tags(next, /<meta\s+property="([^"]+)"/g)).toEqual(expect.arrayContaining(tags(old, /<meta\s+property="([^"]+)"/g)));
    expect(tags(next, /<link\s+rel="([^"]+)"/g)).toEqual(expect.arrayContaining(tags(old, /<link\s+rel="([^"]+)"/g)));
    expect(next).toContain('<link rel="canonical" href="https://rougechain.io/" />');
    expect(next).toContain('<link rel="manifest" href="/manifest.json" />');
  });

  it("carries the same JSON-LD graph", () => {
    const ld = (html: string) => JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]);
    expect(ld(next)).toEqual(ld(old));
  });

  it("keeps the Netlify form detection shells (email signup, Regenerate proposals)", () => {
    for (const form of ["email-signup", "regenerate-proposal"]) expect(next).toContain(`<form name="${form}" data-netlify="true"`);
    const fields = (html: string) => tags(html.split('name="regenerate-proposal"')[1].split("</form>")[0], /name="([^"]+)"/g);
    expect(fields(next)).toEqual(fields(old));
  });
});

describe("sitemap.xml", () => {
  const xml = readFileSync(path.join(siteNext, "public/sitemap.xml"), "utf8");
  const locs = [...xml.matchAll(/<loc>https:\/\/rougechain\.io([^<]*)<\/loc>/g)].map((m) => m[1]);
  it("lists site-next routes on rougechain.io and nothing apps/web had that doesn't exist", () => {
    expect(locs).toContain("/");
    expect(locs).toContain("/validators");
    expect(locs).toContain("/regenerate");
    expect(locs).not.toContain("/staking"); // apps/web's sitemap listed a route that never existed
    const robots = readFileSync(path.join(siteNext, "public/robots.txt"), "utf8");
    expect(robots).toContain("Sitemap: https://rougechain.io/sitemap.xml");
  });
  it("every URL is a site-next route (or one a parallel area is building)", () => {
    const known = new Set([...routePaths(), ...APP_PATHS, ...IN_PROGRESS]);
    expect(locs.filter((l) => !known.has(l))).toEqual([]);
  });
});

/** Routes App.tsx defines itself; and apps/web routes other areas are porting in parallel. */
const APP_PATHS = ["/", "/wallet", "/settings", "/workspace", "/architecture", "/design-system"];
const IN_PROGRESS: string[] = []; // every area has landed (swap, bridge, messenger/mail, pages)
function routePaths(): string[] {
  return [...featureRoutes, ...explorerRoutes].map((r) => (r as ReactElement<{ path: string }>).props.path);
}

describe("per-route social previews (scripts/og-routes.mjs)", () => {
  it("cover the main routes, each a real route, with unique slugs", () => {
    const known = new Set([...routePaths(), ...APP_PATHS, ...IN_PROGRESS]);
    for (const set of [ROUTES, EXPLORER_ROUTES] as { slug: string; path: string }[][]) {
      expect(new Set(set.map((r) => r.slug)).size).toBe(set.length);
      for (const r of set) expect(known.has(r.path)).toBe(true);
    }
    const paths = (ROUTES as { path: string }[]).map((r) => r.path);
    for (const p of ["/", "/wallet", "/swap", "/bridge", "/validators", "/regenerate", "/agents", "/node"]) expect(paths).toContain(p);
    // public/status/ is a directory: a status.html shell would collide with it on Netlify.
    expect(paths).not.toContain("/status");
    expect(shellFile("/")).toBe("index.html");
    expect(shellFile("/validators")).toBe("validators.html");
  });
});

describe("build-time head (vite.config.ts siteMeta → site-head.ts)", () => {
  const html = readFileSync(path.join(siteNext, "index.html"), "utf8");
  const get = (h: string, re: RegExp) => h.match(re)?.[1];
  it("main site keeps rougechain.io and sets matching OG / Twitter values", () => {
    const h = applySiteHead(html, siteHead({ explorer: false, testnet: false }));
    expect(get(h, /<title>([^<]*)<\/title>/)).toBe("RougeChain — Post-quantum from genesis.");
    expect(get(h, /rel="canonical" href="([^"]+)"/)).toBe("https://rougechain.io/");
    expect(get(h, /property="og:title" content="([^"]+)"/)).toBe("RougeChain — Post-quantum from genesis.");
    expect(get(h, /property="og:image" content="([^"]+)"/)).toBe("https://rougechain.io/og-image.png");
  });
  it("explorer build points canonical / og:url at explorer.rougechain.io", () => {
    const h = applySiteHead(html, siteHead({ explorer: true, testnet: false }));
    expect(get(h, /rel="canonical" href="([^"]+)"/)).toBe("https://explorer.rougechain.io/");
    expect(get(h, /property="og:url" content="([^"]+)"/)).toBe("https://explorer.rougechain.io/");
    expect(get(h, /name="twitter:url" content="([^"]+)"/)).toBe("https://explorer.rougechain.io/");
    expect(get(h, /<title>([^<]*)<\/title>/)).toMatch(/^RougeChain Explorer/);
  });
  it("testnet-pinned build is labelled and canonical on testnet.rougechain.io", () => {
    const h = applySiteHead(html, siteHead({ explorer: false, testnet: true }));
    expect(get(h, /<title>([^<]*)<\/title>/)).toBe("RougeChain Testnet — Post-quantum from genesis.");
    expect(get(h, /rel="canonical" href="([^"]+)"/)).toBe("https://testnet.rougechain.io/");
  });
});
