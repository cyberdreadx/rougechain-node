// Build-time prerender for social meta. For each route (scripts/og-routes.mjs)
// writes dist/<slug>.html = the SPA shell with route-specific <title>, description,
// canonical, OpenGraph and Twitter tags (pointing at that route's OG image).
//
// Netlify serves these static files at their pretty URL (e.g. /regenerate →
// regenerate.html) BEFORE the SPA catch-all rewrite, so social crawlers — which
// don't run JS — read the correct per-page meta. Real users still get the same JS
// bundle, so the SPA boots and routes normally. Runs after `vite build`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROUTES } from "./og-routes.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(dir, "..", "dist");
const SITE = "https://rougechain.io";

const base = fs.readFileSync(path.join(dist, "index.html"), "utf8");

// Replace the `attr` value of the first tag matching key=`keyVal` (single-line tags).
function setTag(html, tag, keyAttr, keyVal, valAttr, value) {
  const re = new RegExp(`(<${tag}\\s+[^>]*${keyAttr}="${keyVal}"[^>]*${valAttr}=")[^"]*(")`, "i");
  if (re.test(html)) return html.replace(re, `$1${value}$2`);
  // Fallback: attr order reversed (valAttr before keyAttr)
  const re2 = new RegExp(`(<${tag}\\s+[^>]*${valAttr}=")[^"]*("[^>]*${keyAttr}="${keyVal}")`, "i");
  return html.replace(re2, `$1${value}$2`);
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function render(route) {
  const url = SITE + (route.path === "/" ? "/" : route.path);
  const img = `${SITE}/og/${route.slug}.png`;
  const title = `${route.title} — RougeChain`;
  const desc = route.subtitle;
  let h = base;
  h = h.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(title)}</title>`);
  h = setTag(h, "meta", "name", "description", "content", esc(desc));
  h = setTag(h, "link", "rel", "canonical", "href", url);
  h = setTag(h, "meta", "property", "og:title", "content", esc(route.title));
  h = setTag(h, "meta", "property", "og:description", "content", esc(desc));
  h = setTag(h, "meta", "property", "og:url", "content", url);
  h = setTag(h, "meta", "property", "og:image", "content", img);
  h = setTag(h, "meta", "name", "twitter:title", "content", esc(route.title));
  h = setTag(h, "meta", "name", "twitter:description", "content", esc(desc));
  h = setTag(h, "meta", "name", "twitter:url", "content", url);
  h = setTag(h, "meta", "name", "twitter:image", "content", img);
  return h;
}

let n = 0;
for (const route of ROUTES) {
  const html = render(route);
  const file = route.path === "/" ? "index.html" : `${route.slug}.html`;
  fs.writeFileSync(path.join(dist, file), html);
  n++;
}
console.log(`[og] prerendered ${n} route shells with per-page social meta`);
