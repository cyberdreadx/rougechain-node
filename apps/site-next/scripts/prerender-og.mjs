// Build-time route shells with per-route social meta (the equivalent of apps/web's
// prerender-og.mjs). For each route in og-routes.mjs, writes dist/<path>.html = the built SPA
// shell with that route's <title>, description, canonical, OpenGraph and Twitter tags (pointing at
// dist/og/<slug>.png). Netlify serves the file at its pretty URL before the non-forced SPA rewrite,
// so crawlers (which don't run JS) read the right meta; users get the same JS bundle and the SPA
// routes normally. The site host comes from the built index.html's canonical, so explorer and
// testnet builds (vite.config.ts siteMeta) prerender for their own host.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { routesFor, shellFile } from "./og-routes.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(dir, "..", "dist");
const mode = process.env.VITE_APP_MODE === "explorer" ? "explorer" : "main";
const base = fs.readFileSync(path.join(dist, "index.html"), "utf8");
const site = (base.match(/<link\s+rel="canonical"\s+href="(https:\/\/[^"/]+)\/?"/) || [])[1];
if (!site) throw new Error("[og] dist/index.html has no canonical link");
const testnet = /testnet/.test(site);
const baseTitle = (base.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "RougeChain";
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Replace the value attribute of the first tag whose `keyAttr` is `keyVal` (either attribute order). */
export function setTag(html, tag, keyAttr, keyVal, valAttr, value) {
  const a = new RegExp(`(<${tag}\\s+[^>]*${keyAttr}="${keyVal}"[^>]*${valAttr}=")[^"]*(")`, "i");
  if (a.test(html)) return html.replace(a, `$1${value}$2`);
  const b = new RegExp(`(<${tag}\\s+[^>]*${valAttr}=")[^"]*("[^>]*${keyAttr}="${keyVal}")`, "i");
  if (b.test(html)) return html.replace(b, `$1${value}$2`);
  throw new Error(`[og] no <${tag} ${keyAttr}="${keyVal}"> in the built shell`);
}

function render(route) {
  const url = site + route.path;
  const img = `${site}/og/${route.slug}.png`;
  const brand = mode === "explorer" ? "RougeChain Explorer" : testnet ? "RougeChain Testnet" : "RougeChain";
  // The home shell keeps the build's own title (vite.config.ts siteMeta); other routes get "<route> — <brand>".
  const title = route.path === "/" ? baseTitle : `${route.title.replace(/\.$/, "")} — ${brand}`;
  let h = base.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(unesc(title))}</title>`);
  h = setTag(h, "meta", "name", "description", "content", esc(route.subtitle));
  h = setTag(h, "link", "rel", "canonical", "href", url);
  h = setTag(h, "meta", "property", "og:title", "content", esc(unesc(title)));
  h = setTag(h, "meta", "property", "og:description", "content", esc(route.subtitle));
  h = setTag(h, "meta", "property", "og:url", "content", url);
  h = setTag(h, "meta", "property", "og:image", "content", img);
  h = setTag(h, "meta", "property", "og:image:alt", "content", esc(unesc(title)));
  h = setTag(h, "meta", "name", "twitter:title", "content", esc(unesc(title)));
  h = setTag(h, "meta", "name", "twitter:description", "content", esc(route.subtitle));
  h = setTag(h, "meta", "name", "twitter:url", "content", url);
  h = setTag(h, "meta", "name", "twitter:image", "content", img);
  h = setTag(h, "meta", "name", "twitter:image:alt", "content", esc(unesc(title)));
  return h;
}

let n = 0;
for (const route of routesFor(mode)) {
  const file = path.join(dist, shellFile(route.path));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, render(route));
  n++;
}
console.log(`[og] prerendered ${n} ${mode} route shells for ${site}`);
