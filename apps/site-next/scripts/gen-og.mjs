// Build-time OG images for site-next (the equivalent of apps/web/scripts/gen-og.mjs): one
// branded 1200×630 PNG per route in og-routes.mjs → dist/og/<slug>.png. satori + resvg, pure
// Node, no browser. Fonts are the brand fonts from @fontsource (Space Grotesk, IBM Plex Mono).
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { routesFor } from "./og-routes.mjs";

const require = createRequire(import.meta.url);
const dir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(dir, "..", "dist", "og");
const mode = process.env.VITE_APP_MODE === "explorer" ? "explorer" : "main";
const testnet = process.env.VITE_NETWORK_LOCK === "testnet";
const font = (p) => fs.readFileSync(require.resolve(p));

// packages/brand/tokens.css
const BG = "#07060c";
const INK = "#f5f1fa";
const MUTED = "#a69eaf";
const BORDER = "#2c2636";
const ACCENTS = { red: "#f34459", magenta: "#d843a6", violet: "#a481f8", live: "#69d9bf" };

const div = (style, children) => ({ type: "div", props: { style, children } });

function card({ label, title, subtitle, accent }) {
  const acc = ACCENTS[accent] || ACCENTS.red;
  return div({ display: "flex", flexDirection: "column", width: "1200px", height: "630px", background: BG, fontFamily: "Space Grotesk", color: INK }, [
    div({ display: "flex", width: "1200px", height: "10px", backgroundImage: "linear-gradient(110deg, #f34459, #d843a6 55%, #a481f8)" }, []),
    div({ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center", padding: "64px 84px" }, [
      div({ display: "flex", alignItems: "center", fontFamily: "IBM Plex Mono", fontSize: "26px", letterSpacing: "5px", color: MUTED }, [
        div({ display: "flex", width: "34px", height: "2px", background: acc, marginRight: "18px" }, []),
        div({ display: "flex" }, `ROUGECHAIN${testnet ? " TESTNET" : ""} · ${label.toUpperCase()}`),
      ]),
      div({ display: "flex", fontSize: "86px", fontWeight: 500, letterSpacing: "-3px", marginTop: "30px", lineHeight: 1.04, maxWidth: "1030px" }, title),
      div({ display: "flex", fontSize: "34px", color: MUTED, marginTop: "26px", maxWidth: "980px", lineHeight: 1.3 }, subtitle),
    ]),
    div({ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "26px 84px 50px", borderTop: `1px solid ${BORDER}`, margin: "0 0 0 0" }, [
      div({ display: "flex", fontSize: "30px", fontWeight: 500 }, mode === "explorer" ? "explorer.rougechain.io" : testnet ? "testnet.rougechain.io" : "rougechain.io"),
      div({ display: "flex", fontFamily: "IBM Plex Mono", fontSize: "22px", color: acc, letterSpacing: "3px" }, "POST-QUANTUM L1"),
    ]),
  ]);
}

const fonts = [
  { name: "Space Grotesk", data: font("@fontsource/space-grotesk/files/space-grotesk-latin-400-normal.woff"), weight: 400, style: "normal" },
  { name: "Space Grotesk", data: font("@fontsource/space-grotesk/files/space-grotesk-latin-500-normal.woff"), weight: 500, style: "normal" },
  { name: "IBM Plex Mono", data: font("@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff"), weight: 400, style: "normal" },
];

fs.mkdirSync(outDir, { recursive: true });
let n = 0;
for (const r of routesFor(mode)) {
  const svg = await satori(card(r), { width: 1200, height: 630, fonts });
  const png = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } }).render().asPng();
  fs.writeFileSync(path.join(outDir, `${r.slug}.png`), png);
  n++;
}
console.log(`[og] generated ${n} ${mode} OG images → dist/og/`);
